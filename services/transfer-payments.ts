import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type Stripe from "stripe";
import type { Commit } from "./audit";
const fail = (m: string, s = 409): never => {
  throw Object.assign(Error(m), { status: s });
};
export function transferPayments(
  db: DynamoDBDocumentClient,
  table: string,
  commit: Commit,
  stripe: () => Promise<{ client: Stripe }>,
) {
  const get = async (pk: string) =>
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk, sk: "HEAD" },
          ConsistentRead: true,
        }),
      )
    ).Item;
  async function checkout(id: string, user: { id: string; email: string }) {
    if (
      process.env.TRANSFER_PAYMENTS_ENABLED !== "true" ||
      process.env.CHECKOUT_ENABLED !== "true"
    )
      return fail("Transfer fee payments are not enabled yet.");
    const t = await get(`TRANSFER#${id}`),
      a = t && (await get(`AUCTION#${t.auctionId}`));
    if (
      !t ||
      !a ||
      t.recipientId !== user.id ||
      t.status !== "awaiting-review" ||
      !t.reviewed ||
      !t.quote ||
      t.feeStatus !== "unpaid" ||
      a?.pendingTransferId !== t.id ||
      a?.ownerId !== t.fromId ||
      a?.verificationHold
    )
      return fail("This transfer is not ready for fee payment.");
    if (t.quote.fee < 50)
      return fail(
        "The 0.5% fee is below the payment provider’s CHF 0.50 minimum. Contact Hewge to arrange payment; the fee has not been increased.",
      );
    const { client } = await stripe();
    let newAttempt = !t.feeStartedAt;
    if (t.feeSessionId) {
      const existing = await client.checkout.sessions.retrieve(t.feeSessionId);
      if (existing.payment_status === "paid") {
        await paid(existing);
        return fail("Payment recorded. Refresh to see the review status.");
      }
      if (existing.status === "open" && existing.url)
        return { url: existing.url };
      if (existing.status !== "expired")
        return fail(
          "The existing payment needs reconciliation before retrying.",
        );
      newAttempt = true;
    } else if (t.feeStartedAt && Date.now() - t.feeStartedAt > 23 * 3600000)
      return fail("An uncertain payment needs reconciliation before retrying.");
    let attempt = t.feeAttempt,
      revision = t.revision;
    if (newAttempt) {
      attempt = (attempt || 0) + 1;
      await commit(
        [
          {
            Update: {
              TableName: table,
              Key: { pk: t.pk, sk: "HEAD" },
              UpdateExpression:
                "SET feeAttempt=:attempt, feeStartedAt=:at REMOVE feeSessionId ADD revision :one",
              ConditionExpression:
                "revision=:v AND #s=:review AND feeStatus=:unpaid",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":attempt": attempt,
                ":at": Date.now(),
                ":one": 1,
                ":v": revision,
                ":review": "awaiting-review",
                ":unpaid": "unpaid",
              },
            },
          },
          {
            ConditionCheck: {
              TableName: table,
              Key: { pk: a.pk, sk: "HEAD" },
              ConditionExpression:
                "ownerId=:owner AND pendingTransferId=:id AND (attribute_not_exists(verificationHold) OR verificationHold=:no)",
              ExpressionAttributeValues: {
                ":owner": t.fromId,
                ":id": id,
                ":no": false,
              },
            },
          },
        ],
        {
          entity: `piece:${t.auctionId}`,
          actor: user.id,
          action: "transfer-fee-checkout-started",
          details: {
            transferId: t.id,
            attempt,
            fee: t.quote.fee,
            currency: "CHF",
          },
        },
      );
      revision++;
    }
    const session = await client.checkout.sessions.create(
      {
        mode: "payment",
        allowed_payment_method_types: ["card"],
        client_reference_id: user.id,
        customer_email: user.email,
        metadata: {
          purpose: "ownership-transfer-fee",
          transferId: t.id,
          attempt: String(attempt),
        },
        line_items: [
          {
            price_data: {
              currency: "chf",
              unit_amount: t.quote.fee,
              product_data: {
                name: "Hewge ownership verification & transfer",
                description: `0.5% of CHF ${(t.quote.value / 100).toFixed(2)}. Garment resale payment is separate.`,
              },
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.SITE_URL}/account?transfer=payment-received`,
        cancel_url: `${process.env.SITE_URL}/account`,
      },
      { idempotencyKey: `transfer-fee-${t.id}-${attempt}` },
    );
    await commit(
      [
        {
          Update: {
            TableName: table,
            Key: { pk: t.pk, sk: "HEAD" },
            UpdateExpression: "SET feeSessionId=:id",
            ConditionExpression:
              "revision=:v AND feeAttempt=:attempt AND feeStatus=:unpaid",
            ExpressionAttributeValues: {
              ":id": session.id,
              ":v": revision,
              ":attempt": attempt,
              ":unpaid": "unpaid",
            },
          },
        },
      ],
      {
        entity: `piece:${t.auctionId}`,
        actor: user.id,
        action: "transfer-fee-checkout-created",
        details: { transferId: t.id, attempt },
      },
    );
    return { url: session.url };
  }
  async function paid(session: Stripe.Checkout.Session) {
    if (session.payment_status !== "paid") return;
    const t = await get(`TRANSFER#${session.metadata?.transferId}`);
    if (
      !t ||
      session.currency !== "chf" ||
      session.amount_total !== t.quote?.fee ||
      session.client_reference_id !== t.recipientId ||
      Number(session.metadata?.attempt) !== t.feeAttempt
    )
      return fail("Invalid transfer payment.");
    if (t.feeStatus !== "unpaid" && t.feeSessionId === session.id) return;
    if (t.feeSessionId && t.feeSessionId !== session.id)
      return fail("Payment session mismatch; reconcile before continuing.");
    const valid = t.status === "awaiting-review" && t.reviewed;
    await commit(
      [
        {
          Update: {
            TableName: table,
            Key: { pk: t.pk, sk: "HEAD" },
            UpdateExpression:
              "SET feeStatus=:s, feeSessionId=:id, feePaidAt=:at ADD revision :one",
            ConditionExpression: "revision=:v AND feeStatus=:unpaid",
            ExpressionAttributeValues: {
              ":s": valid ? "paid" : "refund-review",
              ":id": session.id,
              ":at": Date.now(),
              ":one": 1,
              ":v": t.revision,
              ":unpaid": "unpaid",
            },
          },
        },
      ],
      {
        entity: `piece:${t.auctionId}`,
        actor: "stripe-webhook",
        action: valid ? "transfer-fee-paid" : "transfer-fee-refund-review",
        details: {
          transferId: t.id,
          amount: session.amount_total,
          currency: "CHF",
        },
      },
    );
  }
  async function refund(id: string, user: { id: string }, reason: string) {
    const t = await get(`TRANSFER#${id}`);
    if (
      !t ||
      t.status === "approved" ||
      !["paid", "refund-review", "refund-pending"].includes(t.feeStatus) ||
      !t.feeSessionId ||
      reason.trim().length < 12
    )
      return fail(
        "A recorded reason and an uncompleted paid transfer are required.",
      );
    const { client } = await stripe();
    const session = await client.checkout.sessions.retrieve(t.feeSessionId);
    if (
      session.payment_status !== "paid" ||
      session.amount_total !== t.quote.fee ||
      !session.payment_intent
    )
      return fail("Reconcile the payment before refunding.");
    if (t.feeStatus !== "refund-pending")
      await commit(
        [
          {
            Update: {
              TableName: table,
              Key: { pk: t.pk, sk: "HEAD" },
              UpdateExpression:
                "SET feeStatus=:pending, refundReason=:reason ADD revision :one",
              ConditionExpression: "revision=:v AND #s<>:approved",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":pending": "refund-pending",
                ":reason": reason.trim().slice(0, 1000),
                ":one": 1,
                ":v": t.revision,
                ":approved": "approved",
              },
            },
          },
        ],
        {
          entity: `piece:${t.auctionId}`,
          actor: user.id,
          action: "transfer-fee-refund-requested",
          details: { transferId: id },
        },
      );
    const refunded = t.feeRefundId
      ? await client.refunds.retrieve(t.feeRefundId)
      : await client.refunds.create(
          {
            payment_intent:
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : session.payment_intent.id,
            amount: t.quote.fee,
            metadata: { purpose: "ownership-transfer-fee", transferId: id },
          },
          { idempotencyKey: `transfer-fee-refund-${id}` },
        );
    await reconcileRefund(refunded);
    return { ok: true, status: refunded.status };
  }
  async function reconcileRefund(refund: Stripe.Refund) {
    const t = await get(`TRANSFER#${refund.metadata?.transferId}`);
    if (
      !t ||
      refund.metadata?.purpose !== "ownership-transfer-fee" ||
      refund.amount !== t.quote?.fee ||
      refund.currency !== "chf"
    )
      return fail("Refund reconciliation required.");
    if (t.feeStatus === "refunded" && t.feeRefundId === refund.id) return;
    if (
      t.feeStatus !== "refund-pending" ||
      (t.feeRefundId && t.feeRefundId !== refund.id)
    )
      return fail("Refund state changed.");
    await commit(
      [
        {
          Update: {
            TableName: table,
            Key: { pk: t.pk, sk: "HEAD" },
            UpdateExpression:
              "SET feeStatus=:s, feeRefundId=:id ADD revision :one",
            ConditionExpression: "revision=:v AND feeStatus=:pending",
            ExpressionAttributeValues: {
              ":s":
                refund.status === "succeeded"
                  ? "refunded"
                  : refund.status === "failed" || refund.status === "canceled"
                    ? "refund-review"
                    : "refund-pending",
              ":id": refund.id,
              ":one": 1,
              ":v": t.revision,
              ":pending": "refund-pending",
            },
          },
        },
      ],
      {
        entity: `piece:${t.auctionId}`,
        actor: "stripe-refund",
        action: "transfer-fee-refund-updated",
        details: {
          transferId: t.id,
          amount: refund.amount,
          status: refund.status,
        },
      },
    );
  }
  return { checkout, paid, refund, reconcileRefund };
}

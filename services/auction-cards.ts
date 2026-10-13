import { randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";
import { type Commit, digest } from "./audit";
import { auctionPhase } from "../shared/auction";
import {
  CARD_MANDATE_VERSION,
  TERMS_VERSION,
  PRIVACY_VERSION,
  cardMandate,
  termsText,
} from "../shared/legal";

function fail(message: string, status = 409): never {
  throw Object.assign(Error(message), { status });
}
const ref = (value: any): string =>
  typeof value === "string" ? value : value?.id;
const collision = (e: any) =>
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    e?.name,
  );
export const cardKey = (auctionId: string, userId: string) => ({
  pk: `CARD#${auctionId}#${userId}`,
  sk: "SETUP",
});
export function auctionCards(
  db: DynamoDBDocumentClient,
  table: string,
  commit: Commit,
  stripe: () => Promise<{ client: Stripe }>,
  paid: (intent: Stripe.PaymentIntent) => Promise<void>,
) {
  const get = async (Key: any) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  const auction = (id: string) => get({ pk: `AUCTION#${id}`, sk: "HEAD" });
  async function eligibility(id: string, user: any) {
    if (process.env.CHECKOUT_ENABLED !== "true")
      fail("Card checks and bidding are not open yet.");
    if (user.admin) fail("The seller cannot bid on their own auction.", 403);
    const a = await auction(id);
    const p = await get({ pk: `USER#${user.id}`, sk: "PROFILE" });
    if (
      !a ||
      !["open", "scheduled"].includes(auctionPhase(a as any)) ||
      a.termsVersion !== TERMS_VERSION
    )
      fail("This release is not available for card verification.");
    if (!p?.sizes?.includes(a!.size) || !a!.countries?.includes(p.country))
      fail(
        "Check your size preferences and eligible delivery country in your profile.",
      );
    return a!;
  }
  function currentCard(row: any, a: any) {
    return (
      row?.status === "verified" &&
      row.termsVersion === a.termsVersion &&
      row.mandateVersion === CARD_MANDATE_VERSION &&
      row.cardExpiresAt > a.closesAt &&
      a.countries.includes(row.shipping?.address?.country)
    );
  }
  async function finish(session: Stripe.Checkout.Session) {
    if (
      session.mode !== "setup" ||
      session.status !== "complete" ||
      session.metadata?.purpose !== "auction-card"
    )
      return;
    const { auctionId, userId, attempt } = session.metadata;
    if (!auctionId || !userId || !attempt)
      fail("Card setup reconciliation required.");
    const row = await get(cardKey(auctionId, userId));
    if (
      !row ||
      row.attempt !== attempt ||
      row.userId !== session.client_reference_id ||
      (row.sessionId && row.sessionId !== session.id)
    )
      fail("Card setup does not match this account and release.");
    if (row.status === "verified" && row.sessionId === session.id) return;
    const { client } = await stripe();
    const intent = await client.setupIntents.retrieve(
      ref(session.setup_intent),
    );
    if (
      intent.status !== "succeeded" ||
      intent.usage !== "off_session" ||
      ref(intent.customer) !== row.customerId ||
      ref(session.customer) !== row.customerId
    )
      fail("The bank has not confirmed this card setup.");
    const pm = await client.paymentMethods.retrieve(ref(intent.payment_method));
    const details = pm.billing_details;
    const a = await auction(auctionId);
    const expiry = Date.UTC(pm.card?.exp_year || 0, pm.card?.exp_month || 0, 1);
    if (
      pm.type !== "card" ||
      ref(pm.customer) !== row.customerId ||
      !details.name ||
      !details.address?.line1 ||
      !details.address.city ||
      !details.address.postal_code ||
      !a?.countries.includes(details.address.country) ||
      expiry <= a.closesAt
    )
      fail(
        "Use a valid card with a complete billing and delivery address in an eligible country.",
      );
    const next = {
      ...row,
      sessionId: session.id,
      status: "verified",
      paymentMethodId: pm.id,
      setupIntentId: intent.id,
      brand: pm.card!.brand,
      last4: pm.card!.last4,
      cardExpiresAt: expiry,
      verifiedAt: Date.now(),
      shipping: { name: details.name, address: details.address },
    };
    await commit(
      [
        {
          Put: {
            TableName: table,
            Item: next,
            ConditionExpression: "attempt=:attempt AND #s=:pending",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":attempt": attempt,
              ":pending": "pending",
            },
          },
        },
      ],
      {
        entity: `piece:${auctionId}`,
        actor: userId,
        action: "bidder-card-verified",
        details: {
          mandateVersion: row.mandateVersion,
          termsVersion: row.termsVersion,
          termsHash: digest(termsText),
          mandateHash: digest(cardMandate),
        },
      },
    );
  }
  async function status(id: string, user: any) {
    const a = await eligibility(id, user);
    let row = await get(cardKey(id, user.id));
    if (row?.status === "pending" && row.sessionId) {
      const { client } = await stripe();
      await finish(await client.checkout.sessions.retrieve(row.sessionId));
      row = await get(cardKey(id, user.id));
    }
    return currentCard(row, a)
      ? {
          verified: true,
          brand: row!.brand,
          last4: row!.last4,
          shipping: row!.shipping,
        }
      : { verified: false };
  }
  async function start(id: string, body: any, user: any) {
    const a = await eligibility(id, user);
    if (
      body.accepted !== true ||
      body.adult !== true ||
      body.termsVersion !== TERMS_VERSION ||
      body.mandateVersion !== CARD_MANDATE_VERSION
    )
      fail(
        "Accept the auction terms and the release-specific card authorisation, and confirm you are 18 or over.",
        400,
      );
    const Key = cardKey(id, user.id);
    let row = await get(Key);
    if (currentCard(row, a)) return { verified: true };
    // Never mutate a card mandate which already backs a binding bid.
    if (row?.hasBid)
      fail(
        "This card backs an accepted bid. Contact Hewge for a reviewed payment correction.",
      );
    const { client } = await stripe();
    if (row?.sessionId) {
      const existing = await client.checkout.sessions.retrieve(row.sessionId);
      if (existing.status === "open") return { url: existing.url };
      if (existing.status === "complete") {
        await finish(existing);
        return { verified: true };
      }
      if (existing.status !== "expired")
        fail("The previous card setup must be reconciled.");
    }
    if (!row || row.sessionId) {
      const next = {
        ...Key,
        userId: user.id,
        setupEmail: user.email,
        auctionId: id,
        attempt: randomUUID(),
        createdAt: Date.now(),
        status: "pending",
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        mandateVersion: CARD_MANDATE_VERSION,
        acceptedAt: Date.now(),
        termsHash: digest(termsText),
        mandateHash: digest(cardMandate),
      };
      await db.send(
        new PutCommand({
          TableName: table,
          Item: next,
          ConditionExpression: row
            ? "attempt=:old AND attribute_not_exists(hasBid)"
            : "attribute_not_exists(pk)",
          ...(row
            ? { ExpressionAttributeValues: { ":old": row.attempt } }
            : {}),
        }),
      );
      row = next;
    }
    if (Date.now() - row.createdAt > 23 * 3600000)
      fail("An uncertain card setup needs Hewge review before retrying.");
    // Persist the attempt before either external request. Reuse identical keys after network failures.
    if (!row.customerId) {
      const customer = await client.customers.create(
        {
          email: row.setupEmail,
          metadata: {
            account: user.id,
            purpose: "auction-card",
            attempt: row.attempt,
          },
        },
        { idempotencyKey: `card-customer-${row.attempt}` },
      );
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key,
          UpdateExpression: "SET customerId=:customer",
          ConditionExpression: "attempt=:attempt",
          ExpressionAttributeValues: {
            ":customer": customer.id,
            ":attempt": row.attempt,
          },
        }),
      );
      row.customerId = customer.id;
    }
    const session = await client.checkout.sessions.create(
      {
        mode: "setup",
        currency: "chf",
        allowed_payment_method_types: ["card"],
        customer: row.customerId,
        client_reference_id: user.id,
        billing_address_collection: "required",
        setup_intent_data: {
          metadata: {
            purpose: "auction-card",
            auctionId: id,
            userId: user.id,
            attempt: row.attempt,
          },
        },
        metadata: {
          purpose: "auction-card",
          auctionId: id,
          userId: user.id,
          attempt: row.attempt,
        },
        expires_at: Math.floor((row.createdAt + 23 * 3600000) / 1000),
        success_url: `${process.env.SITE_URL}/pieces/${a.slug}?card=checked`,
        cancel_url: `${process.env.SITE_URL}/pieces/${a.slug}?card=cancelled`,
        custom_text: {
          submit: {
            message:
              "Card verification only. Your billing address is also your delivery address. If you win this release, Hewge will charge your winning bid plus the disclosed shipping at closing.",
          },
        },
      },
      { idempotencyKey: `card-setup-${row.attempt}` },
    );
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key,
        UpdateExpression: "SET sessionId=:session",
        ConditionExpression: "attempt=:attempt",
        ExpressionAttributeValues: {
          ":session": session.id,
          ":attempt": row.attempt,
        },
      }),
    );
    return { url: session.url };
  }
  async function requireCard(a: any, user: any, profile: any) {
    const row = await get(cardKey(a.id, user.id));
    if (
      !currentCard(row, a) ||
      row?.shipping.address.country !== profile.country
    )
      fail(
        "Verify your card and matching eligible delivery address before bidding.",
      );
    return row!;
  }
  async function charge(id: string) {
    let a = await auction(id);
    if (
      !a ||
      process.env.CHECKOUT_ENABLED !== "true" ||
      a.status !== "awaiting-payment" ||
      a.offerRequiresAcceptance ||
      a.sessionId ||
      a.checkoutStartedAt
    )
      return;
    // No automatic charge for legacy releases or for a later voluntary offer.
    if (a.termsVersion !== TERMS_VERSION) return;
    const row = await get(cardKey(id, a.winnerId));
    if (!currentCard(row, a) || !row?.hasBid)
      fail("Winning card requires review.");
    const Key = { pk: a.pk, sk: a.sk };
    if (!a.cardChargeStartedAt) {
      try {
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key,
            UpdateExpression:
              "SET cardChargeStartedAt=:now, cardAttempt=:attempt, cardCustomer=:customer, cardMethod=:method, cardShipping=:shipping ADD revision :one",
            ConditionExpression:
              "offerId=:offer AND #s=:waiting AND attribute_not_exists(cardChargeStartedAt) AND attribute_not_exists(checkoutStartedAt)",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":offer": a.offerId,
              ":waiting": "awaiting-payment",
              ":now": Date.now(),
              ":attempt": randomUUID(),
              ":customer": row.customerId,
              ":method": row.paymentMethodId,
              ":shipping": row.shipping,
              ":one": 1,
            },
          }),
        );
      } catch (e) {
        if (!collision(e)) throw e;
      }
      a = await auction(id);
    }
    if (
      !a ||
      a.status !== "awaiting-payment" ||
      !a.cardAttempt ||
      a.checkoutStartedAt ||
      a.offerRequiresAcceptance
    )
      return;
    const { client } = await stripe();
    let intent: Stripe.PaymentIntent;
    if (a.cardPaymentIntentId)
      intent = await client.paymentIntents.retrieve(a.cardPaymentIntentId);
    else {
      if (Date.now() - a.cardChargeStartedAt > 23 * 3600000)
        fail(
          "An uncertain card charge requires reconciliation; it must not be recreated.",
        );
      try {
        intent = await client.paymentIntents.create(
          {
            amount: a.offerAmount + a.shippingFee,
            currency: "chf",
            customer: a.cardCustomer,
            payment_method: a.cardMethod,
            allowed_payment_method_types: ["card"],
            off_session: true,
            confirm: true,
            shipping: a.cardShipping,
            description: `HEWGE — ${a.name}`,
            metadata: {
              purpose: "auction-winner",
              auctionId: id,
              offerId: a.offerId,
              bidderId: a.winnerId,
              attempt: a.cardAttempt,
            },
          },
          { idempotencyKey: `auction-card-${a.cardAttempt}` },
        );
      } catch (e: any) {
        const failed = e.payment_intent || e.raw?.payment_intent;
        if (!failed?.id) throw e; // Ambiguous outcome stays locked; retry the same idempotency key.
        intent = await client.paymentIntents.retrieve(failed.id);
      }
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key,
          UpdateExpression: "SET cardPaymentIntentId=:intent",
          ConditionExpression: "offerId=:offer AND cardAttempt=:attempt",
          ExpressionAttributeValues: {
            ":intent": intent.id,
            ":offer": a.offerId,
            ":attempt": a.cardAttempt,
          },
        }),
      );
    }
    if (intent.status === "succeeded") await paid(intent);
  }
  async function prepareCheckout(a: any) {
    // Reconcile the automatic attempt before any alternate checkout can take money.
    if (
      a.termsVersion === TERMS_VERSION &&
      !a.offerRequiresAcceptance &&
      !a.checkoutStartedAt
    ) {
      await charge(a.id);
      a = await auction(a.id);
    }
    if (a.status === "sold") return a;
    if (!a.cardChargeStartedAt) return a;
    if (!a.cardPaymentIntentId)
      fail(
        "The initial card charge is being reconciled. Do not pay again yet.",
      );
    const { client } = await stripe();
    let intent = await client.paymentIntents.retrieve(a.cardPaymentIntentId);
    if (intent.status === "succeeded") {
      await paid(intent);
      return await auction(a.id);
    }
    if (
      !["requires_payment_method", "requires_action", "canceled"].includes(
        intent.status,
      )
    )
      fail("The card payment is still processing. Do not pay again yet.");
    if (intent.status !== "canceled")
      intent = await client.paymentIntents.cancel(
        intent.id,
        {},
        { idempotencyKey: `cancel-${a.cardAttempt}` },
      );
    if (intent.status !== "canceled")
      fail("The initial card payment could not be safely cancelled.");
    return a;
  }
  return { start, status, finish, requireCard, charge, prepareCheckout };
}

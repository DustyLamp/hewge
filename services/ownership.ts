import { TERMS_VERSION, PRIVACY_VERSION, termsText } from "../shared/legal";
import { createHash, randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import { transferQuote } from "../shared/transfer";
import { digest, type Commit } from "./audit";

type User = { id: string; email: string; admin: boolean };
const text = (v: unknown, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const emailKey = (email: string) =>
  createHash("sha256").update(email.toLowerCase()).digest("hex");
function fail(message: string, status = 409): never {
  throw Object.assign(Error(message), { status });
}
const active = (t: any) =>
  ["awaiting-recipient", "awaiting-review"].includes(t?.status);

export function ownershipRegistry(
  db: DynamoDBDocumentClient,
  TableName: string,
  audited?: Commit,
) {
  const commit: Commit =
    audited ||
    (async (items) => {
      await db.send(new TransactWriteCommand({ TransactItems: items }));
    });
  const get = async (pk: string, sk = "HEAD") =>
    (
      await db.send(
        new GetCommand({ TableName, Key: { pk, sk }, ConsistentRead: true }),
      )
    ).Item;
  async function query(pk: string) {
    const items: any[] = [];
    let cursor;
    do {
      const r: any = await db.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: "pk=:pk",
          ExpressionAttributeValues: { ":pk": pk },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      items.push(...(r.Items || []));
      cursor = r.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async function forUser(user: User) {
    const pointers = [
      ...(await query(`TRANSFERS_FROM#${user.id}`)),
      ...(await query(`TRANSFERS_TO#${emailKey(user.email)}`)),
    ];
    const rows = await Promise.all(
      [...new Set(pointers.map((p) => p.transferId))].map((id) =>
        get(`TRANSFER#${id}`),
      ),
    );
    return rows
      .filter(
        (t) =>
          t && (t.fromId === user.id || t.toEmail === user.email.toLowerCase()),
      )
      .map((t) => ({
        id: t!.id,
        auctionId: t!.auctionId,
        name: t!.name,
        status: t!.status,
        requestedAt: t!.requestedAt,
        deadlineAt: t!.deadlineAt,
        approvedAt: t!.approvedAt,
        serviceNotBefore: t!.serviceNotBefore,
        outgoing: t!.fromId === user.id,
        recipient: t!.fromId === user.id ? t!.toEmail : undefined,
        certificateId: t!.certificateId,
        quote: t!.quote,
        feeStatus: t!.feeStatus,
        reviewed: t!.reviewed === true,
        feePaymentsEnabled: process.env.TRANSFER_PAYMENTS_ENABLED === "true",
      }));
  }
  async function history(id: string) {
    return (await query(`PROVENANCE#${id}`)).map((e) => ({
      at: e.at,
      kind: "transfer",
    }));
  }
  async function handle(path: string, body: any, user: User) {
    const now = Date.now();
    if (path === "/transfer/request") {
      const a = await get(`AUCTION#${text(body.id, 80)}`);
      if (a?.status !== "sold" || a.ownerId !== user.id)
        fail("Only the registered owner can request a transfer.", 403);
      if (a.verificationHold)
        fail("Hewge must resolve the verification hold before a transfer.");
      if (a.pendingTransferId)
        fail("Finish or cancel the existing transfer first.");
      if (
        !a.fulfillment?.shippedAt ||
        !a.fulfillment?.hologramId ||
        !a.fulfillment?.certificateSigned
      )
        fail(
          "The original must have its signed certificate, recorded seal and dispatch record first.",
        );
      const toEmail = text(body.email, 254).toLowerCase();
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail) ||
        toEmail === user.email.toLowerCase()
      )
        fail("Enter the new owner's email address.", 400);
      if (body.confirmed !== true)
        fail("Confirm that you are entitled to transfer this original.", 400);
      const quote = transferQuote(
        body.kind,
        body.resaleAmount,
        a.lastVerifiedValue || a.offerAmount || a.highestBid,
      );
      const id = randomUUID();
      const transfer = {
        pk: `TRANSFER#${id}`,
        sk: "HEAD",
        gpk: "TRANSFERS",
        gsk: `${now}#${id}`,
        id,
        auctionId: a.id,
        name: a.name,
        certificateId: a.certificateId,
        fromId: user.id,
        fromEmail: user.email,
        toEmail,
        status: "awaiting-recipient",
        requestedAt: now,
        deadlineAt: now + 7 * 86400000,
        revision: 1,
        quote,
        kind: body.kind,
        feeStatus: "unpaid",
      };
      await commit(
        [
          {
            Update: {
              TableName,
              Key: { pk: a.pk, sk: "HEAD" },
              UpdateExpression: "SET pendingTransferId=:t",
              ConditionExpression:
                "ownerId=:owner AND #s=:sold AND attribute_not_exists(pendingTransferId) AND (attribute_not_exists(verificationHold) OR verificationHold=:no)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":owner": user.id,
                ":sold": "sold",
                ":t": id,
                ":no": false,
              },
            },
          },
          {
            Put: {
              TableName,
              Item: transfer,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          ...[
            `TRANSFERS_FROM#${user.id}`,
            `TRANSFERS_TO#${emailKey(toEmail)}`,
          ].map((pk) => ({
            Put: { TableName, Item: { pk, sk: id, transferId: id } },
          })),
          {
            Update: {
              TableName,
              Key: { pk: `USER#${user.id}`, sk: "ACTIVITY" },
              UpdateExpression: "SET lastTransferAt=:now",
              ExpressionAttributeValues: { ":now": now },
            },
          },
        ],
        {
          entity: `piece:${a.id}`,
          actor: user.id,
          action: "transfer-requested",
          details: { transferId: id },
        },
      );
      return { ok: true, id };
    }
    const t = await get(`TRANSFER#${text(body.transferId, 80)}`);
    if (!t) fail("Transfer not found.", 404);
    const a = await get(`AUCTION#${t.auctionId}`);
    if (
      !active(t) ||
      a?.ownerId !== t.fromId ||
      a?.pendingTransferId !== t.id ||
      a?.status !== "sold"
    )
      fail("This transfer is no longer active.");
    const headKey = { pk: a.pk, sk: "HEAD" };
    const transferKey = { pk: t.pk, sk: "HEAD" };
    const ownerCondition =
      "ownerId=:owner AND pendingTransferId=:t AND #s=:sold AND (attribute_not_exists(verificationHold) OR verificationHold=:no)";
    const ownerNames = { "#s": "status" };
    const ownerValues = {
      ":owner": t.fromId,
      ":t": t.id,
      ":sold": "sold",
      ":no": false,
    };
    if (path === "/transfer/accept") {
      if (t.toEmail !== user.email.toLowerCase() || t.fromId === user.id)
        fail("Sign in with the recipient's verified email.", 403);
      if (t.status !== "awaiting-recipient" || t.deadlineAt <= now)
        fail("The acceptance window has ended.");
      if (
        body.received !== true ||
        text(body.certificateId, 80) !== a.certificateId ||
        text(body.hologramId, 80) !== a.fulfillment?.hologramId
      )
        fail(
          "Confirm possession and check the certificate and garment seal.",
          400,
        );
      if (body.termsVersion !== TERMS_VERSION)
        fail("Accept the current transfer terms.", 400);
      if (body.feeConsent !== true)
        fail("Accept the 0.5% recipient transfer fee before continuing.", 400);
      const early =
        body.earlyPerformanceRequested === true &&
        body.completionWithdrawalAcknowledged === true;
      const serviceNotBefore = early ? now : now + 14 * 86400000;
      const anonymous = body.anonymous !== false;
      const name = anonymous ? null : text(body.name, 80);
      if (!anonymous && !name) fail("Choose a public name.", 400);
      await commit(
        [
          {
            ConditionCheck: {
              TableName,
              Key: headKey,
              ConditionExpression: ownerCondition,
              ExpressionAttributeNames: ownerNames,
              ExpressionAttributeValues: ownerValues,
            },
          },
          {
            Update: {
              TableName,
              Key: transferKey,
              UpdateExpression:
                "SET #s=:review, recipientId=:u, acceptedAt=:now, feeConsentAt=:now, publicOwner=:p, possessionConfirmed=:yes, termsVersion=:terms, privacyVersion=:privacy, termsHash=:termsHash, serviceNotBefore=:notBefore, earlyPerformanceRequested=:early, completionWithdrawalAcknowledged=:early ADD revision :one",
              ConditionExpression:
                "revision=:v AND #s=:pending AND deadlineAt>:now",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":review": "awaiting-review",
                ":u": user.id,
                ":now": now,
                ":p": { anonymous, name },
                ":yes": true,
                ":one": 1,
                ":v": t.revision,
                ":pending": "awaiting-recipient",
                ":terms": TERMS_VERSION,
                ":privacy": PRIVACY_VERSION,
                ":termsHash": digest(termsText),
                ":notBefore": serviceNotBefore,
                ":early": early,
              },
            },
          },
          {
            Update: {
              TableName,
              Key: { pk: `USER#${user.id}`, sk: "ACTIVITY" },
              UpdateExpression: "SET lastTransferAt=:now",
              ExpressionAttributeValues: { ":now": now },
            },
          },
        ],
        {
          entity: `piece:${a.id}`,
          actor: user.id,
          action: "transfer-accepted",
          details: {
            transferId: t.id,
            termsVersion: TERMS_VERSION,
            termsHash: digest(termsText),
            earlyPerformanceRequested: early,
            completionWithdrawalAcknowledged: early,
            serviceNotBefore,
          },
        },
      );
      return { ok: true };
    }
    if (
      path === "/transfer/cancel" ||
      (path === "/admin/transfer" && body.action === "reject")
    ) {
      if (
        !(path === "/admin/transfer" && user.admin) &&
        t.fromId !== user.id &&
        t.toEmail !== user.email.toLowerCase()
      )
        fail("Only the participants can cancel this transfer.", 403);
      if (["paid", "refund-pending", "refund-review"].includes(t.feeStatus))
        fail("A paid transfer requires a reviewed refund before cancellation.");
      const status = path === "/admin/transfer" ? "rejected" : "cancelled";
      await commit(
        [
          {
            Update: {
              TableName,
              Key: headKey,
              UpdateExpression: "REMOVE pendingTransferId",
              ConditionExpression: ownerCondition,
              ExpressionAttributeNames: ownerNames,
              ExpressionAttributeValues: ownerValues,
            },
          },
          {
            Update: {
              TableName,
              Key: transferKey,
              UpdateExpression:
                "SET #s=:s, endedAt=:now, endedBy=:u ADD revision :one",
              ConditionExpression: "revision=:v",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":s": status,
                ":now": now,
                ":u": user.id,
                ":one": 1,
                ":v": t.revision,
              },
            },
          },
        ],
        {
          entity: `piece:${a.id}`,
          actor: user.id,
          action: "transfer-ended",
          details: { transferId: t.id },
        },
      );
      return { ok: true };
    }
    if (path !== "/admin/transfer" || !user.admin)
      fail("Owner access required.", 403);
    if (
      !["approve", "review"].includes(body.action) ||
      t.status !== "awaiting-review" ||
      !t.recipientId
    )
      fail("The recipient must accept before approval.");
    if (
      t.termsVersion !== TERMS_VERSION ||
      !Number.isFinite(t.serviceNotBefore)
    )
      fail(
        "The recipient must accept the current service terms before review.",
      );
    if (t.serviceNotBefore > now)
      fail(
        "The registration service waits until the 14-day withdrawal period ends unless the recipient expressly requests early performance and acknowledges completion.",
      );
    const evidence = text(body.evidence, 1000);
    if (
      body.physicalChecked !== true ||
      body.titleChecked !== true ||
      evidence.length < 12 ||
      text(body.certificateId, 80) !== a.certificateId ||
      text(body.hologramId, 80) !== a.fulfillment?.hologramId
    )
      fail(
        "Record your physical inspection and entitlement evidence, and match the certificate and seal.",
        400,
      );
    if (body.action === "review") {
      await commit(
        [
          {
            Update: {
              TableName,
              Key: transferKey,
              UpdateExpression:
                "SET reviewed=:yes, reviewEvidence=:e, reviewedBy=:u ADD revision :one",
              ConditionExpression: "revision=:v AND #s=:review",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":yes": true,
                ":e": evidence,
                ":u": user.id,
                ":one": 1,
                ":v": t.revision,
                ":review": "awaiting-review",
              },
            },
          },
          {
            ConditionCheck: {
              TableName,
              Key: headKey,
              ConditionExpression: ownerCondition,
              ExpressionAttributeNames: ownerNames,
              ExpressionAttributeValues: ownerValues,
            },
          },
        ],
        {
          entity: `piece:${a.id}`,
          actor: user.id,
          action: "transfer-inspection-completed",
          details: { transferId: t.id, evidenceHash: digest(evidence) },
        },
      );
      return { ok: true };
    }
    if (!t.reviewed || t.feeStatus !== "paid" || !t.quote)
      fail(
        "Complete inspection and collect the recipient's transfer fee before approval.",
      );
    await commit(
      [
        {
          Update: {
            TableName,
            Key: headKey,
            UpdateExpression:
              "SET ownerId=:new, publicOwner=:public, ownershipUpdatedAt=:now, lastVerifiedValue=:value REMOVE pendingTransferId",
            ConditionExpression: `${ownerCondition} AND certificateId=:cert AND fulfillment.hologramId=:seal`,
            ExpressionAttributeNames: ownerNames,
            ExpressionAttributeValues: {
              ...ownerValues,
              ":new": t.recipientId,
              ":value": t.quote.value,
              ":public": t.publicOwner,
              ":now": now,
              ":cert": a.certificateId,
              ":seal": a.fulfillment.hologramId,
            },
          },
        },
        {
          Update: {
            TableName,
            Key: transferKey,
            UpdateExpression:
              "SET #s=:approved, approvedAt=:now, approvedBy=:u, evidence=:e ADD revision :one",
            ConditionExpression:
              "revision=:v AND #s=:review AND feeStatus=:paid",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":paid": "paid",
              ":approved": "approved",
              ":now": now,
              ":u": user.id,
              ":e": evidence,
              ":one": 1,
              ":v": t.revision,
              ":review": "awaiting-review",
            },
          },
        },
        {
          Put: {
            TableName,
            Item: {
              pk: `PROVENANCE#${a.id}`,
              sk: `${now}#${t.id}`,
              at: now,
              transferId: t.id,
              fromId: t.fromId,
              toId: t.recipientId,
              reviewedBy: user.id,
              certificateId: a.certificateId,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
      {
        entity: `piece:${a.id}`,
        actor: user.id,
        action: "ownership-transferred",
        details: {
          transferId: t.id,
          from: digest(t.fromId),
          to: digest(t.recipientId),
          certificateId: a.certificateId,
          certificateRevision: a.certificateRevision || 1,
          quote: t.quote,
          evidenceHash: digest(evidence),
        },
      },
    );
    return { ok: true };
  }
  return { handle, forUser, history };
}

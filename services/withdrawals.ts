import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { type Commit, digest } from "./audit";
import { TERMS_VERSION, PRIVACY_VERSION } from "../shared/legal";

function fail(message: string, status = 400): never {
  throw Object.assign(Error(message), { status });
}
const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
export function withdrawalService(
  db: DynamoDBDocumentClient,
  TableName: string,
  commit: Commit,
) {
  async function submit(body: any) {
    const id = text(body.requestId, 40),
      name = text(body.name, 120),
      email = text(body.email, 254).toLowerCase(),
      reference = text(body.reference, 120);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      ) ||
      !name ||
      !reference ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !["garment", "registration"].includes(body.kind) ||
      body.confirmed !== true
    )
      fail(
        "Enter your name, email and contract reference, then confirm withdrawal.",
      );
    const Key = { pk: `WITHDRAWAL#${id}`, sk: "HEAD" };
    const requestHash = digest({ name, email, reference, kind: body.kind });
    const previous = (
      await db.send(new GetCommand({ TableName, Key, ConsistentRead: true }))
    ).Item;
    if (previous) {
      if (previous.requestHash !== requestHash)
        fail("Use a fresh withdrawal form for a different notice.", 409);
      return {
        id,
        receivedAt: previous.receivedAt,
        receipt: previous.receipt,
        emailQueued: true,
      };
    }
    const hour = Math.floor(Date.now() / 3600000);
    try {
      await db.send(
        new UpdateCommand({
          TableName,
          Key: {
            pk: `WITHDRAWAL_RATE#${digest(`${hour}:${email}`)}`,
            sk: "RATE",
          },
          UpdateExpression: "SET expiresAt=:ttl ADD hits :one",
          ConditionExpression: "attribute_not_exists(hits) OR hits<:limit",
          ExpressionAttributeValues: {
            ":ttl": (hour + 2) * 3600,
            ":one": 1,
            ":limit": 4,
          },
        }),
      );
    } catch (e: any) {
      if (e.name === "ConditionalCheckFailedException")
        fail(
          "Too many notices for this address. You can also withdraw by emailing jez@hewge.design; no form is required.",
          429,
        );
      throw e;
    }
    const receivedAt = Date.now();
    const receipt = `HEWGE — withdrawal receipt\nReference: ${id}\nReceived: ${new Date(receivedAt).toISOString()}\nConsumer: ${name}\nEmail: ${email}\nContract: ${reference}\nType: ${body.kind}\nStatement: I withdraw from the identified contract.\n\nYour notice has been received. This timestamp records receipt; it is not conditional on review. We will verify the contract, applicable rights and return or refund arrangements. Receipt does not itself confirm entitlement to a refund or change registered ownership. Keep this confirmation. Contact: jez@hewge.design.\n`;
    await commit(
      [
        {
          Put: {
            TableName,
            Item: {
              ...Key,
              id,
              name,
              email,
              reference,
              kind: body.kind,
              requestHash,
              receipt,
              receivedAt,
              status: "submitted",
              revision: 1,
              termsVersion: TERMS_VERSION,
              privacyVersion: PRIVACY_VERSION,
              gpk: "WITHDRAWALS",
              gsk: `${receivedAt}#${id}`,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName,
            Item: {
              pk: `MAIL#withdrawal-${id}`,
              sk: "OUTBOX",
              gpk: "MAIL",
              gsk: `withdrawal-${id}`,
              kind: "withdrawal",
              email,
              subject: "Your withdrawal notice — HEWGE",
              text: receipt,
              status: "pending",
              attempts: 0,
              createdAt: receivedAt,
              expiresAt: Math.floor(receivedAt / 1000) + 30 * 86400,
            },
          },
        },
      ],
      {
        entity: `withdrawal:${id}`,
        actor: "withdrawal-form",
        action: "withdrawal-received",
        details: { receivedAt, requestHash },
      },
    );
    return { id, receivedAt, receipt, emailQueued: true };
  }
  async function review(body: any, user: any) {
    if (!user.admin) fail("Owner access required.", 403);
    const id = text(body.id, 40),
      note = text(body.note, 1500);
    if (!["reviewing", "resolved"].includes(body.status) || note.length < 12)
      fail(
        "Record the review outcome, communication and any refund reference.",
      );
    const Key = { pk: `WITHDRAWAL#${id}`, sk: "HEAD" };
    const row = (
      await db.send(new GetCommand({ TableName, Key, ConsistentRead: true }))
    ).Item;
    if (!row) fail("Notice not found.", 404);
    await commit(
      [
        {
          Update: {
            TableName,
            Key,
            UpdateExpression:
              "SET #s=:s, reviewNote=:note, reviewedAt=:now, reviewedBy=:user ADD revision :one",
            ConditionExpression: "revision=:revision",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":s": body.status,
              ":note": note,
              ":now": Date.now(),
              ":user": user.id,
              ":one": 1,
              ":revision": row!.revision,
            },
          },
        },
      ],
      {
        entity: `withdrawal:${id}`,
        actor: user.id,
        action: "withdrawal-reviewed",
        details: { status: body.status, noteHash: digest(note) },
      },
    );
    return { ok: true };
  }
  return { submit, review };
}

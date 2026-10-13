import { suppressionKey } from "./consent";
import { randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { digest, type Commit } from "./audit";
const fail = (m: string): never => {
  throw Object.assign(Error(m), { status: 400 });
};
export function campaignService(
  db: DynamoDBDocumentClient,
  table: string,
  members: string,
  commit: Commit,
  index: (kind: string) => Promise<any[]>,
) {
  const read = async (TableName: string, Key: any) =>
    (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true })))
      .Item;
  async function audience(segment: any = {}) {
    const candidates = new Map<string, any>();
    for (const p of await index("COLLECTORS"))
      candidates.set(p.email, { email: p.email, profileKey: p.pk });
    let cursor;
    do {
      const page: any = await db.send(
        new ScanCommand({
          TableName: members,
          FilterExpression: "begins_with(pk,:p)",
          ExpressionAttributeValues: { ":p": "EMAIL#" },
          ExclusiveStartKey: cursor,
        }),
      );
      for (const g of page.Items || [])
        candidates.set(g.email, {
          ...candidates.get(g.email),
          email: g.email,
          memberKey: g.pk,
        });
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    const result = [];
    for (const c of candidates.values()) {
      const p = c.profileKey
        ? await read(table, { pk: c.profileKey, sk: "PROFILE" })
        : null;
      const g = await read(members, {
        pk: c.memberKey || `EMAIL#${digest(c.email.toLowerCase())}`,
      });
      const valid =
        g?.emailVerified === true && g.expiresAt > Date.now() / 1000 ? g : null;
      const stamp = (x: any) =>
        typeof x?.consentAt === "string"
          ? Date.parse(x.consentAt)
          : x?.consentAt || 0;
      const latest = valid && stamp(valid) >= stamp(p) ? valid : p;
      if (!latest?.releaseConsent) continue;
      const suppression = await read(members, suppressionKey(c.email));
      if (suppression && suppression.consentAt >= stamp(latest)) continue;
      const updated = (x: any) =>
        typeof x?.updatedAt === "string"
          ? Date.parse(x.updatedAt)
          : x?.updatedAt || 0;
      const merged =
        updated(p) > updated(valid) ? { ...valid, ...p } : { ...p, ...valid };
      if (segment.size && !(merged.sizes || []).includes(segment.size))
        continue;
      if (segment.country && merged.country !== segment.country) continue;
      result.push({ ...c, memberKey: g?.pk, sizes: merged.sizes });
    }
    return result;
  }
  async function canSend(mail: any) {
    if (!["campaign", "release"].includes(mail.kind)) return true;
    if (mail.kind === "campaign") {
      const c = await read(table, {
        pk: `CAMPAIGN#${mail.campaignId}`,
        sk: "HEAD",
      });
      if (!c || !["scheduled", "queued"].includes(c.status)) return false;
    }
    const p = mail.profileKey
      ? await read(table, { pk: mail.profileKey, sk: "PROFILE" })
      : null;
    const g = await read(members, {
      pk: `EMAIL#${digest(mail.email.toLowerCase())}`,
    });
    const valid =
      g?.emailVerified === true && g.expiresAt > Date.now() / 1000 ? g : null;
    const stamp = (x: any) =>
      typeof x?.consentAt === "string"
        ? Date.parse(x.consentAt)
        : x?.consentAt || 0;
    const latest = valid && stamp(valid) >= stamp(p) ? valid : p;
    const suppression = await read(members, suppressionKey(mail.email));
    return (
      latest?.releaseConsent === true &&
      (!suppression || suppression.consentAt < stamp(latest))
    );
  }
  async function handle(body: any, user: { id: string }) {
    const segment = {
      size: String(body.size || ""),
      country: String(body.country || "").toUpperCase(),
    };
    if (
      (segment.size &&
        !["XS", "S", "M", "L", "XL", "XXL"].includes(segment.size)) ||
      (segment.country && !/^[A-Z]{2}$/.test(segment.country))
    )
      return fail("Choose a valid audience segment.");
    if (body.action === "preview")
      return {
        recipients: (await audience(segment)).length,
        enabled: process.env.EMAIL_ENABLED === "true",
      };
    const id = body.id || randomUUID();
    if (!/^[a-f\d-]{36}$/.test(id)) return fail("Invalid campaign ID.");
    const old = await read(table, { pk: `CAMPAIGN#${id}`, sk: "HEAD" });
    if (body.action === "cancel") {
      if (!old || !["draft", "scheduled", "queued"].includes(old.status))
        return fail("Campaign cannot be cancelled.");
      await commit(
        [
          {
            Update: {
              TableName: table,
              Key: { pk: old.pk, sk: "HEAD" },
              UpdateExpression: "SET #s=:cancelled ADD revision :one",
              ConditionExpression: "revision=:v",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":cancelled": "cancelled",
                ":one": 1,
                ":v": old.revision,
              },
            },
          },
        ],
        {
          entity: `campaign:${id}`,
          actor: user.id,
          action: "campaign-cancelled",
        },
      );
      return { ok: true, id };
    }
    if (old && old.status !== "draft")
      return fail("Create a new campaign to change a scheduled message.");
    const subject = String(body.subject || "").trim(),
      text = String(body.text || "").trim();
    if (
      !subject ||
      subject.length > 120 ||
      /[\r\n]/.test(subject) ||
      text.length < 10 ||
      text.length > 4000
    )
      return fail("Add a subject and message (10–4,000 characters).");
    const schedule = body.action === "schedule",
      sendAt = Number(body.sendAt);
    if (
      schedule &&
      (process.env.EMAIL_ENABLED !== "true" ||
        !Number.isSafeInteger(sendAt) ||
        sendAt <= Date.now())
    )
      return fail(
        "Email must be activated and the send time must be in the future.",
      );
    const item = {
      pk: `CAMPAIGN#${id}`,
      sk: "HEAD",
      gpk: "CAMPAIGNS",
      gsk: id,
      id,
      subject,
      text,
      segment,
      sendAt: schedule ? sendAt : null,
      status: schedule ? "scheduled" : "draft",
      revision: (old?.revision || 0) + 1,
      createdBy: user.id,
      updatedAt: Date.now(),
    };
    await commit(
      [
        {
          Put: {
            TableName: table,
            Item: item,
            ConditionExpression: old
              ? "revision=:v"
              : "attribute_not_exists(pk)",
            ...(old
              ? { ExpressionAttributeValues: { ":v": old.revision } }
              : {}),
          },
        },
      ],
      {
        entity: `campaign:${id}`,
        actor: user.id,
        action: schedule ? "campaign-scheduled" : "campaign-drafted",
        details: {
          contentHash: digest({ subject, text }),
          segment,
          sendAt: item.sendAt,
        },
      },
    );
    return { ok: true, id };
  }
  async function queue() {
    if (process.env.EMAIL_ENABLED !== "true") return;
    for (const c of await index("CAMPAIGNS")) {
      if (c.status !== "scheduled" || c.sendAt > Date.now()) continue;
      const recipients = await audience(c.segment);
      for (const p of recipients) {
        const id = `${c.id}-${digest(p.email.toLowerCase())}`;
        try {
          await db.send(
            new PutCommand({
              TableName: table,
              Item: {
                pk: `MAIL#campaign-${id}`,
                sk: "OUTBOX",
                gpk: "MAIL",
                gsk: `campaign-${id}`,
                id,
                kind: "campaign",
                campaignId: c.id,
                email: p.email,
                profileKey: p.profileKey,
                subject: c.subject,
                text: `${c.text}\n\nManage release emails: ${process.env.SITE_URL}/membership\nUnsubscribe: ${process.env.SITE_URL}/privacy`,
                status: "pending",
                attempts: 0,
                createdAt: Date.now(),
                expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            }),
          );
        } catch (e: any) {
          if (e.name !== "ConditionalCheckFailedException") throw e;
        }
      }
      await commit(
        [
          {
            Update: {
              TableName: table,
              Key: { pk: c.pk, sk: "HEAD" },
              UpdateExpression:
                "SET #s=:queued, recipientCount=:n ADD revision :one",
              ConditionExpression: "revision=:v AND #s=:scheduled",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":scheduled": "scheduled",
                ":n": recipients.length,
                ":one": 1,
                ":v": c.revision,
              },
            },
          },
        ],
        {
          entity: `campaign:${c.id}`,
          actor: "scheduler",
          action: "campaign-queued",
          details: { recipients: recipients.length },
        },
      );
    }
  }
  return { handle, queue, canSend, audience };
}

import { createHash, randomBytes } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  GetAccountCommand,
  SendEmailCommand,
  type SESv2Client,
} from "@aws-sdk/client-sesv2";
import { sizes } from "../shared/catalog";
import { seller, sellerContactText } from "../shared/seller";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
function fail(message: string, status = 400): never {
  throw Object.assign(Error(message), { status });
}
const conflicts = (e: any) =>
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    e?.name,
  );
const opaque = () => randomBytes(32).toString("base64url");
const tokenKey = (type: string, token: string) => ({
  pk: `${type}#${digest(token)}`,
  sk: "STATE",
});
const validToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
const publicProfile = (m: any) =>
  Object.fromEntries(
    [
      "email",
      "emailVerified",
      "verifiedAt",
      "displayName",
      "country",
      "city",
      "sizes",
      "instagram",
      "about",
      "readiness",
      "phone",
      "smsConsent",
      "smsConsentAt",
      "smsStatus",
      "releaseConsent",
      "timezone",
      "locale",
    ].map((k) => [k, m[k] ?? null]),
  );

export function membershipService(
  db: DynamoDBDocumentClient,
  ses: SESv2Client,
  table: string,
  membersTable: string,
  site: string,
) {
  let deliveryCache: { enabled: boolean; until: number } | undefined;
  async function deliveryEnabled() {
    if (deliveryCache && deliveryCache.until > Date.now())
      return deliveryCache.enabled;
    const account = await ses.send(new GetAccountCommand({}));
    const enabled =
      account.ProductionAccessEnabled === true &&
      account.SendingEnabled === true;
    deliveryCache = { enabled, until: Date.now() + 60000 };
    return enabled;
  }
  const read = async (TableName: string, Key: any) =>
    (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true })))
      .Item;

  async function sendMail(mail: any) {
    if (
      mail.kind !== "membership" ||
      mail.expiresAt <= Date.now() / 1000 ||
      mail.status !== "pending"
    )
      return false;
    try {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: mail.pk, sk: "OUTBOX" },
          UpdateExpression: "SET #s=:sending ADD attempts :one",
          ConditionExpression: "#s=:pending AND expiresAt>:now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":sending": "sending",
            ":pending": "pending",
            ":one": 1,
            ":now": Math.floor(Date.now() / 1000),
          },
        }),
      );
    } catch (e) {
      if (conflicts(e)) return false;
      throw e;
    }
    try {
      const sent = await ses.send(
        new SendEmailCommand({
          FromEmailAddress: "HEWGE <hello@hewge.design>",
          ReplyToAddresses: [seller.email],
          Destination: { ToAddresses: [mail.email] },
          ...(process.env.EMAIL_CONFIGURATION_SET
            ? { ConfigurationSetName: process.env.EMAIL_CONFIGURATION_SET }
            : {}),
          Content: {
            Simple: {
              Subject: { Data: mail.subject },
              Body: { Text: { Data: `${mail.text}\n\n${sellerContactText}` } },
            },
          },
        }),
      );
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: mail.pk, sk: "OUTBOX" },
          UpdateExpression: "SET #s=:sent, messageId=:id REMOVE #text",
          ExpressionAttributeNames: { "#s": "status", "#text": "text" },
          ExpressionAttributeValues: {
            ":sent": "sent",
            ":id": sent.MessageId || "accepted",
          },
        }),
      );
      return true;
    } catch {
      // A timeout may follow acceptance. Never retry automatically and duplicate a message.
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: mail.pk, sk: "OUTBOX" },
          UpdateExpression: "SET #s=:failed",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":failed": "failed" },
        }),
      );
      return false;
    }
  }
  async function sendQueued(mails: any[]) {
    const pending = mails
      .filter(
        (m) =>
          m.kind === "membership" &&
          m.status === "pending" &&
          m.expiresAt > Date.now() / 1000,
      )
      .slice(0, 10);
    if (!pending.length || !(await deliveryEnabled())) return;
    for (const mail of pending) await sendMail(mail);
  }
  async function session(value: unknown) {
    if (!validToken(value))
      fail("Open a fresh membership link from your email.", 401);
    const s = await read(table, tokenKey("MEMBER_SESSION", value));
    if (!s || s.expiresAt <= Date.now() / 1000)
      fail("Your membership link has expired. Request a new one.", 401);
    const m = await read(membersTable, { pk: s.memberKey });
    if (!m?.emailVerified || m.expiresAt <= Date.now() / 1000)
      fail("Verify your email first.", 401);
    return { s, m, key: tokenKey("MEMBER_SESSION", value) };
  }
  async function request(
    body: any,
    purpose: "join" | "leave",
    sourceIp: string,
  ) {
    if (body.website) return { ok: true, delivery: "accepted" };
    const email = clean(body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter a valid email.");
    if (purpose === "join" && body.consent !== true)
      fail("Please agree to release emails.");
    const hour = Math.floor(Date.now() / 3600000);
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            ["EMAIL", email, 4],
            ["IP", sourceIp, 12],
          ].map(([kind, value, limit]) => ({
            Update: {
              TableName: table,
              Key: {
                pk: `MEMBER_RATE#${kind}#${digest(`${hour}:${value}`)}`,
                sk: "RATE",
              },
              UpdateExpression: "SET expiresAt=:ttl ADD hits :one",
              ConditionExpression: "attribute_not_exists(hits) OR hits<:max",
              ExpressionAttributeValues: {
                ":ttl": (hour + 2) * 3600,
                ":one": 1,
                ":max": limit,
              },
            },
          })),
        }),
      );
    } catch (e) {
      if (conflicts(e))
        fail("Please wait before requesting another email.", 429);
      throw e;
    }
    const enabled = await deliveryEnabled();
    const memberKey = `EMAIL#${digest(email)}`;
    const existing = await read(membersTable, { pk: memberKey });
    // Re-entering an address never changes another person's profile or consent.
    if (!existing && purpose === "join") {
      let timezone = clean(body.timezone, 80);
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
      } catch {
        timezone = "";
      }
      let locale = clean(body.locale, 40);
      try {
        locale = Intl.getCanonicalLocales(locale)[0] || "";
      } catch {
        locale = "";
      }
      try {
        await db.send(
          new PutCommand({
            TableName: membersTable,
            Item: {
              pk: memberKey,
              email,
              emailVerified: false,
              status: "pending-verification",
              revision: 0,
              releaseConsent: false,
              sizes: [],
              timezone,
              locale,
              createdAt: Date.now(),
              expiresAt: Math.floor(Date.now() / 1000) + 2 * 86400,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      } catch (e) {
        if (!conflicts(e)) throw e;
      }
    }
    // Same response for unknown addresses on removal requests; no member enumeration.
    if (!existing && purpose === "leave")
      return { ok: true, delivery: enabled ? "sent" : "pending" };
    const token = opaque();
    const challenge = {
      ...tokenKey("MEMBER_VERIFY", token),
      memberKey,
      purpose,
      createdAt: Date.now(),
      expiresAt: Math.floor(Date.now() / 1000) + 2 * 86400,
      used: false,
    };
    const link = `${site}/membership#verify=${token}`;
    const mail = {
      pk: `MAIL#member-${digest(token)}`,
      sk: "OUTBOX",
      gpk: "MAIL",
      gsk: `member-${Date.now()}-${digest(token)}`,
      kind: "membership",
      email,
      subject:
        purpose === "join"
          ? "Your Hewge access"
          : "Your Hewge email preferences",
      text:
        purpose === "join"
          ? `Verify your email to join Hewge.\n\n${link}\n\nThen choose your sizes, location and contact preferences. Release dates are announced individually.\n\nThis link expires in 48 hours and can be used once. If you did not request it, ignore this email. Your address will not be subscribed without confirmation.`
          : `Confirm that you want to leave Hewge release emails:\n\n${link}\n\nThis link expires in 48 hours and can only remove your subscription. If you did not request it, ignore this email.`,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
      expiresAt: challenge.expiresAt,
    };
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: table, Item: challenge } },
          { Put: { TableName: table, Item: mail } },
        ],
      }),
    );
    const sent = enabled && (await sendMail(mail));
    return {
      ok: true,
      delivery: sent ? "sent" : enabled ? "failed" : "pending",
    };
  }
  async function handle(path: string, body: any, sourceIp: string) {
    if (path === "/waitlist" || path === "/waitlist/remove")
      return request(
        body,
        path.endsWith("/remove") ? "leave" : "join",
        sourceIp,
      );
    if (path === "/membership/link") {
      if (!validToken(body.token)) fail("This link is invalid or expired.");
      const c = await read(table, tokenKey("MEMBER_VERIFY", body.token));
      if (!c || c.used || c.expiresAt <= Date.now() / 1000)
        fail("This link is invalid or expired. Request a new one.");
      return { purpose: c.purpose };
    }
    if (path === "/membership/verify") {
      if (!validToken(body.token)) fail("This link is invalid or expired.");
      const challengeKey = tokenKey("MEMBER_VERIFY", body.token);
      const c = await read(table, challengeKey);
      if (!c || c.used || c.expiresAt <= Date.now() / 1000)
        fail("This link is invalid or expired. Request a new one.");
      const m = await read(membersTable, { pk: c.memberKey });
      if (!m) fail("Request a new membership link.");
      const now = Date.now();
      const memberSession = opaque();
      const newSession = {
        ...tokenKey("MEMBER_SESSION", memberSession),
        memberKey: c.memberKey,
        createdAt: now,
        expiresAt: Math.floor(now / 1000) + 3600,
      };
      const leave = c.purpose === "leave";
      const next = {
        ...m,
        emailVerified: true,
        verifiedAt: m.verifiedAt || now,
        status: leave ? "unsubscribed" : "member",
        releaseConsent: !leave,
        consentVersion: "membership-v1",
        consentAt: now,
        ...(leave ? { smsConsent: false, smsStatus: "off" } : {}),
        expiresAt: Math.floor(now / 1000) + 180 * 86400,
        updatedAt: now,
        revision: (m.revision || 0) + 1,
      };
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table,
                Key: challengeKey,
                UpdateExpression: "SET used=:yes",
                ConditionExpression: "used=:no AND expiresAt>:now",
                ExpressionAttributeValues: {
                  ":yes": true,
                  ":no": false,
                  ":now": Math.floor(now / 1000),
                },
              },
            },
            {
              Put: {
                TableName: membersTable,
                Item: next,
                ConditionExpression:
                  m.revision !== undefined
                    ? "#revision=:old"
                    : "attribute_not_exists(#revision)",
                ExpressionAttributeNames: { "#revision": "revision" },
                ...(m.revision !== undefined
                  ? { ExpressionAttributeValues: { ":old": m.revision } }
                  : {}),
              },
            },
            ...(!leave
              ? [{ Put: { TableName: table, Item: newSession } }]
              : []),
          ],
        }),
      );
      return leave
        ? { ok: true, unsubscribed: true }
        : {
            ok: true,
            session: memberSession,
            expiresAt: newSession.expiresAt,
            profile: publicProfile(next),
            smsEnabled: false,
          };
    }
    if (path === "/membership/session") {
      const { m } = await session(body.session);
      return { profile: publicProfile(m), smsEnabled: false };
    }
    if (path === "/membership/profile") {
      const { m, key } = await session(body.session);
      const country = clean(body.country, 2).toUpperCase();
      if (
        country &&
        (!/^[A-Z]{2}$/.test(country) ||
          new Intl.DisplayNames(["en"], { type: "region" }).of(country) ===
            country)
      )
        fail("Choose your country.");
      const phone = clean(body.phone, 30).replace(/[ ()-]/g, "");
      if (phone && !/^\+[1-9]\d{6,14}$/.test(phone))
        fail(
          "Use an international phone number, including + and the country code.",
        );
      if (body.smsConsent === true && !phone)
        fail("Add a phone number for SMS alerts.");
      const instagram = clean(body.instagram, 30).replace(/^@/, "");
      if (instagram && !/^[a-zA-Z0-9._]{1,30}$/.test(instagram))
        fail("Enter your Instagram handle, without a link.");
      const readiness = ["following", "considering", "ready"].includes(
        body.readiness,
      )
        ? body.readiness
        : "following";
      const now = Date.now();
      const next = {
        ...m,
        displayName: clean(body.displayName, 80),
        country,
        city: clean(body.city, 100),
        sizes: Array.isArray(body.sizes)
          ? [...new Set(body.sizes.filter((s: any) => sizes.includes(s)))]
          : [],
        instagram,
        about: clean(body.about, 600),
        readiness,
        phone,
        smsConsent: body.smsConsent === true,
        smsConsentAt:
          body.smsConsent === true
            ? m.smsConsent && m.phone === phone
              ? m.smsConsentAt
              : now
            : null,
        smsConsentVersion: body.smsConsent === true ? "sms-release-v1" : null,
        smsStatus: body.smsConsent === true ? "pending-activation" : "off",
        phoneVerified: false,
        releaseConsent: body.releaseConsent === true,
        consentAt:
          m.releaseConsent === (body.releaseConsent === true)
            ? m.consentAt
            : now,
        updatedAt: now,
        revision: (m.revision || 0) + 1,
      };
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: key,
                ConditionExpression: "expiresAt>:now",
                ExpressionAttributeValues: { ":now": Math.floor(now / 1000) },
              },
            },
            {
              Put: {
                TableName: membersTable,
                Item: next,
                ConditionExpression: "#revision=:old AND emailVerified=:yes",
                ExpressionAttributeNames: { "#revision": "revision" },
                ExpressionAttributeValues: {
                  ":old": m.revision,
                  ":yes": true,
                },
              },
            },
          ],
        }),
      );
      return { ok: true, profile: publicProfile(next), smsEnabled: false };
    }
    return null;
  }
  return { handle, sendQueued, deliveryEnabled };
}

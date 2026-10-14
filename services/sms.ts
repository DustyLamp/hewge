import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  DescribeAccountAttributesCommand,
  DescribeVerifiedDestinationNumbersCommand,
  SendTextMessageCommand,
  type PinpointSMSVoiceV2Client,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const validToken = (s: unknown): s is string =>
  typeof s === "string" && /^[\w-]{43}$/.test(s);
function fail(message: string, status = 400): never {
  throw Object.assign(Error(message), { status });
}
const conflict = (e: any) =>
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    e?.name,
  );
const normalPhone = (v: unknown) =>
  typeof v === "string" ? v.trim().replace(/[ ()-]/g, "") : "";
const profileKey = (email: string) => ({
  pk: `SMS_MEMBER#${hash(email.toLowerCase())}`,
});
const suppressionKey = (phone: string) => ({
  pk: `SMS_SUPPRESSION#${hash(phone)}`,
});
const challengeKey = (value: string) => ({
  pk: `SMS_VERIFY#${hash(value)}`,
  sk: "STATE",
});
const guardedPut = (table: string, next: any, old: any) => ({
  Put: {
    TableName: table,
    Item: next,
    ConditionExpression: old ? "revision=:old" : "attribute_not_exists(pk)",
    ...(old ? { ExpressionAttributeValues: { ":old": old.revision } } : {}),
  },
});

// SMS preferences are canonical across membership links and collector accounts.
// Contact-only phone fields never confer SMS consent or proof of possession.
export function smsService(
  db: DynamoDBDocumentClient,
  provider: PinpointSMSVoiceV2Client,
  table: string,
  members: string,
) {
  const read = async (TableName: string, Key: any) =>
    (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true })))
      .Item;
  let cache:
    { until: number; tier: string; destinations: Set<string> } | undefined;
  async function providerStatus() {
    if (process.env.SMS_VERIFICATION_ENABLED !== "true")
      return { tier: "OFF", destinations: new Set<string>() };
    if (cache && cache.until > Date.now()) return cache;
    const result = await provider.send(
      new DescribeAccountAttributesCommand({}),
    );
    const tier =
      result.AccountAttributes?.find((a) => a.Name === "ACCOUNT_TIER")?.Value ||
      "UNKNOWN";
    const destinations = new Set<string>();
    if (tier === "SANDBOX") {
      let NextToken: string | undefined;
      do {
        const page = await provider.send(
          new DescribeVerifiedDestinationNumbersCommand({ NextToken }),
        );
        for (const d of page.VerifiedDestinationNumbers || [])
          if (d.Status === "VERIFIED" && d.DestinationPhoneNumber)
            destinations.add(d.DestinationPhoneNumber);
        NextToken = page.NextToken;
      } while (NextToken);
    }
    cache = { until: Date.now() + 60000, tier, destinations };
    return cache;
  }
  async function allowed(phone: string) {
    if (!/^\+417[5-9]\d{7}$/.test(phone) || !process.env.SMS_SENDER_ARN)
      return false;
    const status = await providerStatus();
    return (
      status.tier === "PRODUCTION" ||
      (status.tier === "SANDBOX" && status.destinations.has(phone))
    );
  }
  async function campaignEnabled() {
    return (
      process.env.SMS_RELEASES_ENABLED === "true" &&
      (await providerStatus()).tier === "PRODUCTION"
    );
  }
  async function get(email: string) {
    const record = await read(members, profileKey(email));
    const legacy = !record
      ? await read(members, { pk: `EMAIL#${hash(email.toLowerCase())}` })
      : null;
    const p =
      record ||
      (legacy?.emailVerified && legacy.expiresAt > Date.now() / 1000
        ? {
            phone: legacy.phone || "",
            consent: legacy.smsConsent === true,
            consentAt: legacy.smsConsentAt || 0,
          }
        : {});
    const active = !record || record.expiresAt > Date.now() / 1000;
    const suppression = p.phone
      ? await read(members, suppressionKey(p.phone))
      : null;
    const consent =
      active &&
      p.consent === true &&
      (!suppression || p.consentAt > suppression.consentAt);
    const verified =
      active &&
      p.phoneVerified === true &&
      p.verifiedAt > Date.now() - 180 * 86400000;
    return {
      phone: p.phone || "",
      consent,
      verified,
      canVerify: consent && !verified && (await allowed(p.phone)),
      alertsEnabled: await campaignEnabled(),
    };
  }
  async function save(email: string, body: any) {
    const phone = normalPhone(body.phone),
      consent = body.consent === true;
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone))
      fail("Include + and the country code.");
    if (consent && !phone) fail("Add a phone number for text alerts.");
    const old = await read(members, profileKey(email));
    const suppression = phone
      ? await read(members, suppressionKey(phone))
      : null;
    const now = Date.now(),
      samePhone = old?.phone === phone;
    const next = {
      ...profileKey(email),
      email: email.toLowerCase(),
      phone,
      consent,
      consentAt: consent
        ? old?.consent &&
          samePhone &&
          old.expiresAt > now / 1000 &&
          (!suppression || old.consentAt > suppression.consentAt)
          ? old.consentAt
          : now
        : now,
      consentVersion: "sms-release-v1",
      phoneVerified: !!(
        samePhone &&
        old?.phoneVerified &&
        old.expiresAt > now / 1000 &&
        old.verifiedAt > now - 180 * 86400000
      ),
      verifiedAt: samePhone ? old?.verifiedAt || null : null,
      lastCodeAt: old?.lastCodeAt || null,
      revision: (old?.revision || 0) + 1,
      updatedAt: now,
      expiresAt: Math.floor(now / 1000) + 180 * 86400,
    };
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          guardedPut(members, next, old),
          ...[
            ...new Set(
              (!consent
                ? [old?.phone, phone]
                : !samePhone
                  ? [old?.phone]
                  : []
              ).filter(Boolean),
            ),
          ].map((previous) => ({
            Put: {
              TableName: members,
              Item: { ...suppressionKey(previous), consentAt: now },
              ConditionExpression:
                "attribute_not_exists(consentAt) OR consentAt<=:now",
              ExpressionAttributeValues: { ":now": now },
            },
          })),
        ],
      }),
    );
    return get(email);
  }
  // Used inside the email-unsubscribe transaction; it also invalidates any in-flight code.
  function stopWrite(email: string, now: number) {
    return {
      Update: {
        TableName: members,
        Key: profileKey(email),
        UpdateExpression:
          "SET consent=:no, consentAt=:now, updatedAt=:now, expiresAt=:ttl REMOVE pendingChallenge ADD revision :one",
        ExpressionAttributeValues: {
          ":no": false,
          ":now": now,
          ":ttl": Math.floor(now / 1000) + 180 * 86400,
          ":one": 1,
        },
      },
    };
  }
  async function removalWrites(email: string) {
    const old = await read(members, profileKey(email));
    const legacyKey = { pk: `EMAIL#${hash(email.toLowerCase())}` };
    const legacy = await read(members, legacyKey);
    const now = Date.now();
    return [
      {
        Delete: {
          TableName: members,
          Key: profileKey(email),
          ...(old
            ? {
                ConditionExpression: "revision=:old",
                ExpressionAttributeValues: { ":old": old.revision },
              }
            : { ConditionExpression: "attribute_not_exists(pk)" }),
        },
      },
      ...[...new Set([old?.phone, legacy?.phone].filter(Boolean))].map(
        (phone) => ({
          Put: {
            TableName: members,
            Item: { ...suppressionKey(phone), consentAt: now },
            ConditionExpression:
              "attribute_not_exists(consentAt) OR consentAt<=:now",
            ExpressionAttributeValues: { ":now": now },
          },
        }),
      ),
      ...(legacy
        ? [
            {
              Update: {
                TableName: members,
                Key: legacyKey,
                UpdateExpression:
                  "SET smsConsent=:no, smsStatus=:off ADD revision :one",
                ExpressionAttributeValues: {
                  ":no": false,
                  ":off": "off",
                  ":one": 1,
                },
              },
            },
          ]
        : []),
    ];
  }
  const rate = (
    kind: string,
    value: string,
    window: number,
    limit: number,
    seconds: number,
  ) => ({
    Update: {
      TableName: table,
      Key: { pk: `SMS_RATE#${kind}#${hash(`${window}:${value}`)}`, sk: "RATE" },
      UpdateExpression: "SET expiresAt=:ttl ADD hits :one",
      ConditionExpression: "attribute_not_exists(hits) OR hits<:max",
      ExpressionAttributeValues: {
        ":ttl": (window + 2) * seconds,
        ":one": 1,
        ":max": limit,
      },
    },
  });
  async function request(email: string, ip: string) {
    const old = await read(members, profileKey(email));
    const prefs = await get(email);
    if (!old?.consent || !prefs.consent)
      fail("Save your number and choose text alerts first.");
    if (prefs.verified) return { verified: true };
    if (!(await allowed(old.phone)))
      fail("Text verification is not available for this number yet.", 503);
    const now = Date.now(),
      seconds = Math.floor(now / 1000);
    if (old.lastCodeAt && now - old.lastCodeAt < 60000)
      fail("Wait a minute before requesting another code.", 429);
    const secret = token(),
      code = String(randomInt(100000, 1000000));
    const key = challengeKey(secret),
      hour = Math.floor(seconds / 3600),
      day = Math.floor(seconds / 86400);
    // Five sends per UTC calendar month at a maximum USD 0.15 each. Deliberately
    // conservative during commissioning; no automatic increase when AWS approves.
    const month = new Date(now).toISOString().slice(0, 7);
    const challenge = {
      ...key,
      owner: profileKey(email).pk,
      phone: old.phone,
      proof: hash(`${secret}:${code}`),
      attempts: 0,
      status: "sending",
      expiresAt: seconds + 600,
    };
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            guardedPut(
              members,
              {
                ...old,
                pendingChallenge: key.pk,
                lastCodeAt: now,
                revision: old.revision + 1,
              },
              old,
            ),
            {
              Put: {
                TableName: table,
                Item: challenge,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            rate("ACCOUNT", profileKey(email).pk, hour, 3, 3600),
            rate("PHONE", old.phone, day, 3, 86400),
            rate("IP", ip, day, 5, 86400),
            rate("GLOBAL", "all", day, 4, 86400),
            {
              Update: {
                TableName: table,
                Key: { pk: `SMS_BUDGET#${month}`, sk: "RATE" },
                UpdateExpression: "SET expiresAt=:ttl ADD hits :one",
                ConditionExpression: "attribute_not_exists(hits) OR hits<:max",
                ExpressionAttributeValues: {
                  ":ttl": seconds + 65 * 86400,
                  ":one": 1,
                  ":max": 5,
                },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (conflict(e)) fail("Text limit reached. Please try later.", 429);
      throw e;
    }
    try {
      const result = await provider.send(
        new SendTextMessageCommand({
          DestinationPhoneNumber: old.phone,
          OriginationIdentity: process.env.SMS_SENDER_ARN,
          MessageBody: `HEWGE code: ${code}. Valid for 10 minutes. Do not share it.`,
          MessageType: "TRANSACTIONAL",
          ...(process.env.SMS_CONFIGURATION_SET
            ? { ConfigurationSetName: process.env.SMS_CONFIGURATION_SET }
            : {}),
          MaxPrice: "0.15",
          TimeToLive: 600,
        }),
      );
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: "SET #s=:sent, messageId=:id",
          ConditionExpression: "#s=:sending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":sent": "sent",
            ":sending": "sending",
            ":id": result.MessageId || "accepted",
          },
        }),
      );
    } catch {
      // SDK retries are disabled. An ambiguous send consumes its budget and cannot
      // be silently repeated; never return an OTP or write it to a log/database.
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: "SET #s=:failed",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":failed": "review-required" },
        }),
      );
      fail("We couldn’t confirm the text was sent. Please try later.", 503);
    }
    return { challenge: secret, expiresAt: challenge.expiresAt };
  }
  async function verify(email: string, body: any) {
    if (!validToken(body.challenge) || !/^\d{6}$/.test(body.code))
      fail("Enter the six-digit code.");
    const key = challengeKey(body.challenge),
      c = await read(table, key),
      old = await read(members, profileKey(email));
    const seconds = Math.floor(Date.now() / 1000);
    if (
      !c ||
      c.owner !== profileKey(email).pk ||
      c.status !== "sent" ||
      c.expiresAt <= seconds ||
      c.attempts >= 5 ||
      !old?.consent ||
      old.phone !== c.phone ||
      old.pendingChallenge !== c.pk ||
      old.expiresAt <= seconds
    )
      fail("This code is invalid or expired. Request a new one.");
    // Reserve each attempt atomically. Concurrent submissions cannot share an attempt.
    try {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: "ADD attempts :one",
          ConditionExpression:
            "#s=:sent AND attempts=:old AND attempts<:max AND expiresAt>:now",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":one": 1,
            ":sent": "sent",
            ":old": c.attempts,
            ":max": 5,
            ":now": seconds,
          },
        }),
      );
    } catch (e) {
      if (conflict(e)) fail("Code already checked. Please try again.", 409);
      throw e;
    }
    const proof = hash(`${body.challenge}:${body.code}`);
    if (!timingSafeEqual(Buffer.from(proof), Buffer.from(c.proof)))
      fail("That code doesn’t match.");
    const now = Date.now();
    const { pendingChallenge: _, ...rest } = old;
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            guardedPut(
              members,
              {
                ...rest,
                phoneVerified: true,
                verifiedAt: now,
                updatedAt: now,
                revision: old.revision + 1,
              },
              old,
            ),
            {
              Update: {
                TableName: table,
                Key: key,
                UpdateExpression: "SET #s=:used REMOVE proof",
                ConditionExpression:
                  "#s=:sent AND expiresAt>:now AND attempts=:attempts",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":used": "used",
                  ":sent": "sent",
                  ":now": Math.floor(now / 1000),
                  ":attempts": c.attempts + 1,
                },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (conflict(e))
        fail("Your preferences changed. Request a new code.", 409);
      throw e;
    }
    return get(email);
  }
  async function handle(action: string, email: string, body: any, ip: string) {
    if (action === "preferences") return get(email);
    if (action === "save") return save(email, body);
    if (action === "request") return request(email, ip);
    if (action === "verify") return verify(email, body);
    fail("Not found.", 404);
  }
  async function enqueue(campaign: any, recipient: any) {
    const prefs = await get(recipient.email);
    if (
      !prefs.consent ||
      !prefs.verified ||
      !/^\+417[5-9]\d{7}$/.test(prefs.phone)
    )
      return;
    const leave = token(),
      id = `${campaign.id}-${hash(prefs.phone)}`;
    const outbox = { pk: `SMS#campaign-${id}`, sk: "OUTBOX" };
    const text = `HEWGE: ${campaign.text}\nLeave: ${process.env.SITE_URL}/sms#leave=${leave}`;
    // Single GSM-7 message. No extended alphabet characters that consume two units.
    if (text.length > 160 || !/^[A-Za-z0-9 .,!?':;()/+\-#=_\n]+$/.test(text))
      fail("Text exceeds the single-message allowance.");
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: {
                  ...outbox,
                  gpk: "SMS_OUTBOX",
                  gsk: id,
                  kind: "campaign",
                  channel: "sms",
                  campaignId: campaign.id,
                  email: recipient.email,
                  phone: prefs.phone,
                  text,
                  status: "pending",
                  createdAt: Date.now(),
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  pk: `SMS_LEAVE#${hash(leave)}`,
                  sk: "STATE",
                  owner: profileKey(recipient.email).pk,
                  phoneHash: hash(prefs.phone),
                  used: false,
                  expiresAt: Math.floor(Date.now() / 1000) + 180 * 86400,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (conflict(e) && (await read(table, outbox))) return;
      throw e;
    }
  }
  async function leave(action: string, value: unknown) {
    if (!validToken(value)) fail("This link is invalid or expired.");
    const key = { pk: `SMS_LEAVE#${hash(value)}`, sk: "STATE" },
      link = await read(table, key);
    if (!link || link.expiresAt <= Date.now() / 1000)
      fail(
        "This link is invalid or expired. Use your text preferences or contact Hewge.",
      );
    if (action === "link" || link.used)
      return { unsubscribed: link.used === true };
    if (action !== "leave") fail("Not found.", 404);
    const old = await read(members, { pk: link.owner }),
      now = Date.now();
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table,
              Key: key,
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
              TableName: members,
              Item: { pk: `SMS_SUPPRESSION#${link.phoneHash}`, consentAt: now },
              ConditionExpression:
                "attribute_not_exists(consentAt) OR consentAt<=:now",
              ExpressionAttributeValues: { ":now": now },
            },
          },
          ...(old?.phone && hash(old.phone) === link.phoneHash
            ? [
                guardedPut(
                  members,
                  {
                    ...old,
                    consent: false,
                    consentAt: now,
                    pendingChallenge: null,
                    revision: old.revision + 1,
                    updatedAt: now,
                  },
                  old,
                ),
              ]
            : []),
        ],
      }),
    );
    return { unsubscribed: true };
  }
  async function sendQueued(
    mails: any[],
    canSend: (m: any) => Promise<boolean>,
  ) {
    if (!(await campaignEnabled())) return;
    for (const m of mails
      .filter((m) => m.status === "pending" && m.expiresAt > Date.now() / 1000)
      .slice(0, 10)) {
      const prefs = await get(m.email),
        key = { pk: m.pk, sk: m.sk };
      if (
        !prefs.consent ||
        !prefs.verified ||
        prefs.phone !== m.phone ||
        !(await allowed(m.phone)) ||
        !(await canSend(m))
      ) {
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: "SET #s=:off REMOVE #text",
            ConditionExpression: "#s=:pending",
            ExpressionAttributeNames: { "#s": "status", "#text": "text" },
            ExpressionAttributeValues: {
              ":off": "suppressed",
              ":pending": "pending",
            },
          }),
        );
        continue;
      }
      const now = Date.now(),
        seconds = Math.floor(now / 1000),
        day = Math.floor(seconds / 86400),
        month = new Date(now).toISOString().slice(0, 7);
      try {
        await db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: table,
                  Key: key,
                  UpdateExpression: "SET #s=:sending",
                  ConditionExpression: "#s=:pending AND expiresAt>:now",
                  ExpressionAttributeNames: { "#s": "status" },
                  ExpressionAttributeValues: {
                    ":sending": "sending",
                    ":pending": "pending",
                    ":now": seconds,
                  },
                },
              },
              rate("GLOBAL", "all", day, 4, 86400),
              {
                Update: {
                  TableName: table,
                  Key: { pk: `SMS_BUDGET#${month}`, sk: "RATE" },
                  UpdateExpression: "SET expiresAt=:ttl ADD hits :one",
                  ConditionExpression:
                    "attribute_not_exists(hits) OR hits<:max",
                  ExpressionAttributeValues: {
                    ":ttl": seconds + 65 * 86400,
                    ":one": 1,
                    ":max": 5,
                  },
                },
              },
            ],
          }),
        );
      } catch (e) {
        if (conflict(e)) continue;
        throw e;
      }
      // Recheck consent after taking the queue claim, immediately before provider handoff.
      const latest = await get(m.email);
      if (
        !latest.consent ||
        !latest.verified ||
        latest.phone !== m.phone ||
        !(await canSend(m))
      ) {
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: "SET #s=:off REMOVE #text",
            ExpressionAttributeNames: { "#s": "status", "#text": "text" },
            ExpressionAttributeValues: { ":off": "suppressed" },
          }),
        );
        continue;
      }
      try {
        const result = await provider.send(
          new SendTextMessageCommand({
            DestinationPhoneNumber: m.phone,
            OriginationIdentity: process.env.SMS_SENDER_ARN,
            ConfigurationSetName: process.env.SMS_CONFIGURATION_SET,
            MessageBody: m.text,
            MessageType: "PROMOTIONAL",
            MaxPrice: "0.15",
            TimeToLive: Math.min(
              3600,
              Math.max(5, m.expiresAt - Math.floor(Date.now() / 1000)),
            ),
          }),
        );
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: "SET #s=:sent, messageId=:id REMOVE #text",
            ExpressionAttributeNames: { "#s": "status", "#text": "text" },
            ExpressionAttributeValues: {
              ":sent": "accepted",
              ":id": result.MessageId || "accepted",
            },
          }),
        );
      } catch {
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: "SET #s=:failed",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":failed": "review-required" },
          }),
        );
      }
    }
  }
  return {
    handle,
    get,
    stopWrite,
    removalWrites,
    campaignEnabled,
    enqueue,
    leave,
    sendQueued,
  };
}

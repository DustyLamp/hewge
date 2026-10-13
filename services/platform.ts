import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import Stripe from "stripe";
import {
  preview,
  publicRelease,
  auctionPhase,
  validateSchedule,
  validateBid,
  TERMS_VERSION,
} from "../shared/auction";
import { sizes, piece } from "../shared/catalog";
import { ownershipRegistry } from "./ownership";
import { membershipService } from "./membership";
import { seller, sellerContactText } from "../shared/seller";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TableName = process.env.AUCTION_TABLE!;
const registry = ownershipRegistry(db, TableName);
const membership = membershipService(
  db,
  new SESv2Client({}),
  TableName,
  process.env.TABLE_NAME!,
  process.env.SITE_URL!,
);
const verifier = process.env.USER_POOL_ID
  ? CognitoJwtVerifier.create({
      userPoolId: process.env.USER_POOL_ID,
      clientId: process.env.USER_POOL_CLIENT_ID!,
      tokenUse: "id",
    })
  : null;
const response = (statusCode: number, data: unknown) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(data),
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const clean = (v: unknown, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const conflict = (e: any) =>
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    e?.name,
  );
const key = (id: string) => ({ pk: `AUCTION#${id}`, sk: "HEAD" });
const get = async (pk: string, sk: string) =>
  (
    await db.send(
      new GetCommand({ TableName, Key: { pk, sk }, ConsistentRead: true }),
    )
  ).Item;
async function query(pk: string) {
  let cursor;
  const all: Record<string, any>[] = [];
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
    all.push(...(r.Items || []));
    cursor = r.LastEvaluatedKey;
  } while (cursor);
  return all;
}
async function index(kind: string) {
  let cursor;
  const all: Record<string, any>[] = [];
  do {
    const r: any = await db.send(
      new QueryCommand({
        TableName,
        IndexName: "directory",
        KeyConditionExpression: "gpk=:pk",
        ExpressionAttributeValues: { ":pk": kind },
        ExclusiveStartKey: cursor,
      }),
    );
    all.push(...(r.Items || []));
    cursor = r.LastEvaluatedKey;
  } while (cursor);
  return all;
}
async function auth(event: any, admin = false) {
  try {
    const token = (event.headers?.authorization || "").replace(/^Bearer /, "");
    const user = await verifier!.verify(token);
    const isAdmin =
      (user["cognito:groups"] || []).includes("admins") ||
      String(user.email).toLowerCase() === process.env.OWNER_EMAIL;
    if (user.email_verified !== true || (admin && !isAdmin)) throw Error();
    return { id: user.sub, email: String(user.email), admin: isAdmin };
  } catch {
    throw Object.assign(
      Error(
        admin
          ? "Owner access required."
          : "Sign in with a verified email first.",
      ),
      { status: admin ? 403 : 401 },
    );
  }
}
let secret: Promise<any> | undefined;
async function stripe() {
  if (!process.env.STRIPE_SECRET_ARN)
    throw Error("Payments are not connected.");
  secret ??= new SecretsManagerClient({})
    .send(
      new GetSecretValueCommand({ SecretId: process.env.STRIPE_SECRET_ARN }),
    )
    .then((r) => JSON.parse(r.SecretString!))
    .catch((e) => {
      secret = undefined;
      throw e;
    });
  const config = await secret;
  return {
    client: new Stripe(config.secretKey),
    webhookSecret: config.webhookSecret,
  };
}
function mailItem(id: string, email: string, subject: string, text: string) {
  return {
    pk: `MAIL#${id}`,
    sk: "OUTBOX",
    gpk: "MAIL",
    gsk: id,
    email,
    subject,
    text,
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
  };
}
function notice(a: any, email: string, kind: string) {
  return mailItem(
    `${a.id}-${a.offerId || "release"}-${kind}`,
    email,
    kind === "paid" ? `Yours. ${a.name} — HEWGE` : `You won ${a.name}.`,
    kind === "paid"
      ? `Congratulations. ${a.name} is yours. Your artist-signed certificate and ownership card will travel with your insured parcel. Manage your public ownership at ${process.env.SITE_URL}/account. We never publish your name without your choice.`
      : `Your bid of CHF ${(a.offerAmount / 100).toFixed(2)} won ${a.name}. Pay by ${new Date(a.paymentDueAt).toISOString()} at ${process.env.SITE_URL}/account. Shipping: CHF ${(a.shippingFee / 100).toFixed(2)}. Your shirt is held until that deadline. No payment has been taken.`,
  );
}
async function putMail(item: any) {
  await db
    .send(
      new PutCommand({
        TableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    )
    .catch((e) => {
      if (!conflict(e)) throw e;
    });
}
async function settle(a: any, now = Date.now()) {
  if (
    !a.closesAt ||
    a.closesAt > now ||
    !["scheduled", "open"].includes(a.status)
  )
    return;
  const offerId = randomUUID();
  const next = {
    ...a,
    status: a.highestBidder ? "awaiting-payment" : "closed",
    winnerId: a.highestBidder || null,
    winnerEmail: a.highestBidderEmail || null,
    offerAmount: a.highestBid || null,
    offerId,
    paymentDueAt: now + a.paymentHours * 3600000,
    revision: a.revision + 1,
  };
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: next,
              ConditionExpression: "revision=:v",
              ExpressionAttributeValues: { ":v": a.revision },
            },
          },
          ...(a.highestBidder
            ? [
                {
                  Put: {
                    TableName,
                    Item: notice(next, a.highestBidderEmail, "winner"),
                  },
                },
              ]
            : []),
        ],
      }),
    );
  } catch (e) {
    if (!conflict(e)) throw e;
  }
}
async function announce(a: any) {
  if (!a.opensAt || Date.now() < a.opensAt || a.releaseMailQueued) return;
  const profiles = await index("COLLECTORS");
  let cursor;
  const guests: any[] = [];
  do {
    const r: any = await db.send(
      new ScanCommand({
        TableName: process.env.TABLE_NAME!,
        FilterExpression: "begins_with(pk,:p)",
        ExpressionAttributeValues: { ":p": "EMAIL#" },
        ExclusiveStartKey: cursor,
      }),
    );
    guests.push(...(r.Items || []));
    cursor = r.LastEvaluatedKey;
  } while (cursor);
  const recipients = new Map<string, any>();
  for (const p of profiles) {
    if (p.releaseConsent) recipients.set(p.email, p);
  }
  const profilesByEmail = new Map(profiles.map((p) => [p.email, p]));
  for (const g of guests) {
    if (g.emailVerified !== true || g.expiresAt <= Date.now() / 1000) continue;
    const p = profilesByEmail.get(g.email);
    const profileConsentAt =
      typeof p?.consentAt === "string"
        ? Date.parse(p.consentAt)
        : p?.consentAt || 0;
    if (p && profileConsentAt > g.consentAt) continue;
    if (g.releaseConsent === true) recipients.set(g.email, { ...p, ...g });
    else recipients.delete(g.email);
  }
  for (const [email, p] of recipients) {
    if (p.sizes?.length && !p.sizes.includes(a.size)) continue;
    await putMail(
      mailItem(
        `${a.id}-release-${hash(email)}`,
        email,
        `The next original is here. HEWGE No. ${a.number}`,
        `${a.name} is revealed. One garment. Size ${a.size}. Opening bid CHF ${(a.openingBid / 100).toFixed(2)}. Bidding closes ${new Date(a.closesAt).toISOString()}. Explore the piece: ${process.env.SITE_URL}/pieces/${a.slug}

You asked to hear about Hewge releases. Unsubscribe at ${process.env.SITE_URL}/privacy or switch off release emails in your collector profile.`,
      ),
    );
  }
  await db.send(
    new UpdateCommand({
      TableName,
      Key: key(a.id),
      UpdateExpression: "SET releaseMailQueued=:yes",
      ExpressionAttributeValues: { ":yes": true },
    }),
  );
}
async function tick() {
  for (const a of await index("AUCTIONS")) {
    await settle(a);
    if (process.env.EMAIL_ENABLED === "true") await announce(a);
  }
  const queued = await index("MAIL");
  await membership.sendQueued(queued);
  if (process.env.EMAIL_ENABLED !== "true") return;
  const ses = new SESv2Client({});
  for (const mail of queued.filter(
    (m) =>
      m.kind !== "membership" &&
      m.expiresAt > Date.now() / 1000 &&
      m.status === "pending" &&
      m.attempts < 5,
  )) {
    // Claim before delivery. Ambiguous sends stay 'sending' for owner review, never blindly duplicate a winner email.
    try {
      await db.send(
        new UpdateCommand({
          TableName,
          Key: { pk: mail.pk, sk: mail.sk },
          UpdateExpression: "SET #s=:s, attempts=attempts+:one",
          ConditionExpression: "#s=:pending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "sending",
            ":pending": "pending",
            ":one": 1,
          },
        }),
      );
    } catch (e) {
      if (conflict(e)) continue;
      throw e;
    }
    try {
      const sent = await ses.send(
        new SendEmailCommand({
          FromEmailAddress: `HEWGE <hello@hewge.design>`,
          ReplyToAddresses: [seller.email],
          ...(process.env.EMAIL_CONFIGURATION_SET
            ? { ConfigurationSetName: process.env.EMAIL_CONFIGURATION_SET }
            : {}),
          Destination: { ToAddresses: [mail.email] },
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
          TableName,
          Key: { pk: mail.pk, sk: mail.sk },
          UpdateExpression: "SET #s=:sent, messageId=:id",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":sent": "sent", ":id": sent.MessageId },
        }),
      );
    } catch {
      await db.send(
        new UpdateCommand({
          TableName,
          Key: { pk: mail.pk, sk: mail.sk },
          UpdateExpression: "SET #s=:failed",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":failed": "review-required" },
        }),
      );
    }
  }
}
async function completePayment(session: Stripe.Checkout.Session) {
  const id = session.metadata?.auctionId;
  if (!id) return;
  const a = await get(`AUCTION#${id}`, "HEAD");
  if (!a) throw Error("Missing auction");
  if (a.status === "sold" && a.sessionId === session.id) return;
  if (session.payment_status !== "paid") return;
  if (
    session.currency !== "chf" ||
    session.amount_total !== a.offerAmount + a.shippingFee ||
    session.metadata?.offerId !== a.offerId ||
    session.client_reference_id !== a.winnerId
  )
    throw Error("Payment reconciliation required");
  const paid = {
    ...a,
    status: "sold",
    soldAt: Date.now(),
    sessionId: session.id,
    ownerId: a.winnerId,
    publicOwner: { name: null, anonymous: true },
    certificateId: `HEWGE-${a.number}-${randomUUID().slice(0, 8).toUpperCase()}`,
    revision: a.revision + 1,
  };
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName,
            Item: paid,
            ConditionExpression: "revision=:v AND #s=:s",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":v": a.revision,
              ":s": "awaiting-payment",
            },
          },
        },
        { Put: { TableName, Item: notice(paid, a.winnerEmail, "paid") } },
      ],
    }),
  );
}
async function checkout(a: any, user: any) {
  const now = Date.now();
  if (process.env.CHECKOUT_ENABLED !== "true")
    throw Object.assign(Error("Payments are not open yet."), { status: 409 });
  if (
    a.status !== "awaiting-payment" ||
    a.winnerId !== user.id ||
    a.paymentDueAt - now < 31 * 60000
  )
    throw Object.assign(
      Error(
        "No payable winning offer. Contact Hewge if your deadline is close.",
      ),
      { status: 409 },
    );
  const { client } = await stripe();
  if (a.sessionId) {
    const session = await client.checkout.sessions.retrieve(a.sessionId);
    if (session.payment_status === "paid") {
      await completePayment(session);
      return { paid: true };
    }
    if (session.status === "open") return { url: session.url };
    if (session.status !== "expired")
      throw Object.assign(Error("Payment is still processing."), {
        status: 409,
      });
    await db.send(
      new UpdateCommand({
        TableName,
        Key: key(a.id),
        UpdateExpression:
          "SET checkoutAttempt=:attempt, checkoutStartedAt=:now, checkoutExpiresAt=:expiry ADD revision :one REMOVE sessionId",
        ConditionExpression:
          "sessionId=:previous AND offerId=:offer AND #s=:waiting AND paymentDueAt>:minimum",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":attempt": (a.checkoutAttempt || 1) + 1,
          ":now": now,
          ":expiry": Math.floor(
            Math.min(a.paymentDueAt, now + 23 * 3600000) / 1000,
          ),
          ":one": 1,
          ":previous": a.sessionId,
          ":offer": a.offerId,
          ":waiting": "awaiting-payment",
          ":minimum": now + 31 * 60000,
        },
      }),
    );
  } else if (!a.checkoutStartedAt) {
    try {
      await db.send(
        new UpdateCommand({
          TableName,
          Key: key(a.id),
          UpdateExpression:
            "SET checkoutAttempt=:attempt, checkoutStartedAt=:now, checkoutExpiresAt=:expiry ADD revision :one",
          ConditionExpression:
            "attribute_not_exists(checkoutStartedAt) AND offerId=:offer AND #s=:waiting AND paymentDueAt>:minimum",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":attempt": 1,
            ":now": now,
            ":expiry": Math.floor(
              Math.min(a.paymentDueAt, now + 23 * 3600000) / 1000,
            ),
            ":one": 1,
            ":offer": a.offerId,
            ":waiting": "awaiting-payment",
            ":minimum": now + 31 * 60000,
          },
        }),
      );
    } catch (e) {
      if (!conflict(e)) throw e;
    }
  }
  a = await get(`AUCTION#${a.id}`, "HEAD");
  if (a.winnerId !== user.id || a.status !== "awaiting-payment")
    throw Error("Offer changed.");
  // Stable idempotency key means retries, concurrent clicks and Lambda failures cannot create two payment sessions.
  const session = await client.checkout.sessions.create(
    {
      mode: "payment",
      allowed_payment_method_types: ["card", "twint"],
      client_reference_id: user.id,
      customer_email: user.email,
      metadata: { auctionId: a.id, offerId: a.offerId },
      line_items: [
        {
          price_data: {
            currency: "chf",
            unit_amount: a.offerAmount,
            product_data: {
              name: `HEWGE — ${a.name}`,
              description: `One of one. Size ${a.size}. ${publicRelease(a).material || "Material under wraps"}.`,
            },
          },
          quantity: 1,
        },
      ],
      shipping_options: [
        {
          shipping_rate_data: {
            display_name: "Insured shipping",
            type: "fixed_amount",
            fixed_amount: { amount: a.shippingFee, currency: "chf" },
          },
        },
      ],
      shipping_address_collection: { allowed_countries: a.countries as any },
      billing_address_collection: "required",
      expires_at: a.checkoutExpiresAt,
      success_url: `${process.env.SITE_URL}/account?payment=received`,
      cancel_url: `${process.env.SITE_URL}/account`,
      consent_collection: { terms_of_service: "required" },
      custom_text: {
        terms_of_service_acceptance: {
          message: `I agree to the [auction terms](${process.env.SITE_URL}/terms).`,
        },
      },
    },
    { idempotencyKey: `auction-${a.id}-${a.offerId}-${a.checkoutAttempt}` },
  );
  await db.send(
    new UpdateCommand({
      TableName,
      Key: key(a.id),
      UpdateExpression: "SET sessionId=:s",
      ConditionExpression: "offerId=:o AND #s=:waiting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": session.id,
        ":o": a.offerId,
        ":waiting": "awaiting-payment",
      },
    }),
  );
  return { url: session.url };
}
async function nextBidder(a: any) {
  if (a.status !== "awaiting-payment" || Date.now() < a.paymentDueAt)
    throw Object.assign(Error("The payment window is still open."), {
      status: 409,
    });
  if (a.checkoutStartedAt && !a.sessionId)
    throw Object.assign(
      Error(
        "An uncertain checkout must be reconciled in Stripe before reassignment.",
      ),
      { status: 409 },
    );
  if (a.sessionId) {
    const { client } = await stripe();
    let session = await client.checkout.sessions.retrieve(a.sessionId);
    if (session.payment_status === "paid") {
      await completePayment(session);
      return { paid: true };
    }
    if (session.status === "open")
      session = await client.checkout.sessions.expire(session.id);
    if (session.status !== "expired")
      throw Error(
        "Payment still processing. Reconcile before making another offer.",
      );
  }
  const excluded = [...(a.excludedBidders || []), a.winnerId];
  const bids = (await query(`AUCTION#${a.id}`))
    .filter((b) => b.sk.startsWith("BID#") && !excluded.includes(b.bidderId))
    .sort((x, y) => y.amount - x.amount || x.createdAt - y.createdAt);
  const bid = bids[0];
  const offerId = randomUUID();
  const next = {
    ...a,
    status: bid ? "awaiting-payment" : "closed",
    excludedBidders: excluded,
    winnerId: bid?.bidderId || null,
    winnerEmail: bid?.email || null,
    offerAmount: bid?.amount || null,
    offerId,
    paymentDueAt: Date.now() + a.paymentHours * 3600000,
    sessionId: null,
    checkoutStartedAt: undefined,
    checkoutExpiresAt: undefined,
    checkoutAttempt: undefined,
    revision: a.revision + 1,
  };
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName,
            Item: next,
            ConditionExpression: "revision=:v",
            ExpressionAttributeValues: { ":v": a.revision },
          },
        },
        ...(bid
          ? [{ Put: { TableName, Item: notice(next, bid.email, "winner") } }]
          : []),
        {
          Put: {
            TableName,
            Item: {
              pk: `AUCTION#${a.id}`,
              sk: `AUDIT#${Date.now()}`,
              action: "unpaid-offer-released",
              previousWinner: a.winnerId,
              offerId: a.offerId,
              createdAt: Date.now(),
            },
          },
        },
      ],
    }),
  );
  return { ok: true };
}
export async function handler(event: any) {
  if (event.source === "aws.events") {
    await tick();
    return { ok: true };
  }
  const path = event.rawPath;
  const method = event.requestContext?.http?.method;
  try {
    if (path === "/stripe/webhook") {
      const { client, webhookSecret } = await stripe();
      let e: Stripe.Event;
      try {
        e = client.webhooks.constructEvent(
          event.isBase64Encoded
            ? Buffer.from(event.body || "", "base64")
            : event.body || "",
          event.headers["stripe-signature"] || "",
          webhookSecret,
        );
      } catch {
        return response(400, { message: "Invalid signature." });
      }
      if (
        [
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
        ].includes(e.type)
      )
        await completePayment(e.data.object as Stripe.Checkout.Session);
      return response(200, { received: true });
    }
    if (method === "GET" && path === "/releases") {
      const items = (await index("AUCTIONS")).filter(
        (a) => a.published !== false,
      );
      return response(200, {
        releases: items.length
          ? items
              .map((a) => publicRelease(a))
              .sort((a, b) => (b.opensAt || 0) - (a.opensAt || 0))
          : [{ ...preview, serverNow: Date.now() }],
        biddingEnabled: process.env.CHECKOUT_ENABLED === "true",
        emailEnabled: process.env.EMAIL_ENABLED === "true",
      });
    }
    if (method === "GET" && path === "/catalog")
      return response(200, { ...piece, status: "coming-soon" });
    if (method === "GET" && path.startsWith("/registry/")) {
      const id = path.slice("/registry/".length);
      if (!/^[a-z0-9-]{1,80}$/.test(id))
        return response(404, { message: "Record not found." });
      const a = await get(`AUCTION#${id}`, "HEAD");
      if (a?.status !== "sold" || !a.certificateId)
        return response(404, { message: "Record not found." });
      return response(200, {
        release: publicRelease(a),
        history: [
          { at: a.soldAt, kind: "registered" },
          ...(await registry.history(id)),
        ],
      });
    }
    if (
      !(process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .includes(event.headers.origin || "")
    )
      return response(403, { message: "This request is not allowed." });
    let body: any = {};
    if (method === "POST") {
      try {
        if (!event.body || event.body.length > 16000) throw Error();
        body = JSON.parse(event.body);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw Error();
      } catch {
        return response(400, { message: "Please check your details." });
      }
    }
    const hour = Math.floor(Date.now() / 3600000);
    try {
      await db.send(
        new UpdateCommand({
          TableName,
          Key: {
            pk: `RATE#${hash(hour + ":" + event.requestContext.http.sourceIp)}`,
            sk: "RATE",
          },
          UpdateExpression: "SET expiresAt=:ttl ADD hits :one",
          ConditionExpression: "attribute_not_exists(hits) OR hits<:max",
          ExpressionAttributeValues: {
            ":ttl": (hour + 2) * 3600,
            ":one": 1,
            ":max": path.startsWith("/admin") ? 200 : 80,
          },
        }),
      );
    } catch (e) {
      if (conflict(e))
        return response(429, {
          message: "Too many requests. Try again later.",
        });
      throw e;
    }
    if (
      path === "/waitlist" ||
      path === "/waitlist/remove" ||
      path.startsWith("/membership/")
    ) {
      if (method !== "POST") return response(405, { message: "Use POST." });
      const result = await membership.handle(
        path,
        body,
        event.requestContext.http.sourceIp,
      );
      return result
        ? response(200, result)
        : response(404, { message: "Not found." });
    }
    if (path === "/checkout")
      return response(409, {
        message: "This piece is available only to its winning bidder.",
      });
    const user = await auth(event, path.startsWith("/admin"));
    if (
      [
        "/transfer/request",
        "/transfer/accept",
        "/transfer/cancel",
        "/admin/transfer",
      ].includes(path)
    )
      return response(200, await registry.handle(path, body, user));
    if (path === "/me" && method === "GET") {
      const profile = await get(`USER#${user.id}`, "PROFILE");
      const member = (
        await db.send(
          new GetCommand({
            TableName: process.env.TABLE_NAME!,
            Key: { pk: `EMAIL#${hash(user.email.toLowerCase())}` },
            ConsistentRead: true,
          }),
        )
      ).Item;
      const preferences =
        member?.emailVerified && member.expiresAt > Date.now() / 1000
          ? member
          : {};
      const profileConsentAt =
        typeof profile?.consentAt === "string"
          ? Date.parse(profile.consentAt)
          : profile?.consentAt || 0;
      const auctions = (await index("AUCTIONS"))
        .filter(
          (a) =>
            (a.status === "awaiting-payment" && a.winnerId === user.id) ||
            a.ownerId === user.id,
        )
        .map((a) => ({
          ...publicRelease(a),
          paymentDueAt: a.paymentDueAt,
          offerAmount: a.offerAmount,
          canPay: a.status === "awaiting-payment",
          pendingTransferId: a.pendingTransferId,
          fulfillment: a.fulfillment || {},
        }));
      return response(200, {
        profile: {
          ...preferences,
          ...profile,
          email: user.email,
          sizes: profile?.sizes || preferences.sizes || [],
          ...(preferences.consentAt >= profileConsentAt
            ? { releaseConsent: preferences.releaseConsent }
            : {}),
        },
        admin: user.admin,
        auctions,
        transfers: await registry.forUser(user),
      });
    }
    if (path === "/me/profile") {
      const chosen = Array.isArray(body.sizes)
        ? [
            ...new Set(
              body.sizes.filter((s: string) => sizes.includes(s as any)),
            ),
          ]
        : [];
      const instagram = clean(body.instagram, 30).replace(/^@/, "");
      if (instagram && !/^[a-zA-Z0-9._]{1,30}$/.test(instagram))
        throw Object.assign(
          Error("Enter an Instagram handle, without a link."),
          { status: 400 },
        );
      const country = clean(body.country, 2).toUpperCase();
      if (!/^[A-Z]{2}$/.test(country))
        throw Object.assign(Error("Choose your country."), { status: 400 });
      const followers =
        body.followers === "" || body.followers == null
          ? null
          : Number(body.followers);
      if (
        followers !== null &&
        (!Number.isSafeInteger(followers) ||
          followers < 0 ||
          followers > 1000000000)
      )
        throw Object.assign(Error("Check the follower count."), {
          status: 400,
        });
      const old = await get(`USER#${user.id}`, "PROFILE");
      await db.send(
        new PutCommand({
          TableName,
          Item: {
            pk: `USER#${user.id}`,
            sk: "PROFILE",
            gpk: "COLLECTORS",
            gsk: old?.gsk || `${Date.now()}#${user.id}`,
            email: user.email,
            displayName: clean(body.displayName, 80),
            sizes: chosen,
            country,
            instagram,
            followers,
            phone: clean(body.phone, 40),
            about: clean(body.about, 600),
            releaseConsent: body.releaseConsent === true,
            consentAt:
              old?.releaseConsent === (body.releaseConsent === true) &&
              old?.consentAt
                ? old.consentAt
                : Date.now(),
            emailVerified: true,
            createdAt: old?.createdAt || Date.now(),
            updatedAt: Date.now(),
          },
        }),
      );
      return response(200, { ok: true });
    }
    if (path === "/me/delete") {
      const bids = await get(`USER#${user.id}`, "ACTIVITY");
      if (bids)
        return response(409, {
          message:
            "Your account has auction records. Contact the seller to request deletion; records needed for a sale or dispute must be retained.",
        });
      await db.send(
        new DeleteCommand({
          TableName,
          Key: { pk: `USER#${user.id}`, sk: "PROFILE" },
        }),
      );
      return response(200, { ok: true });
    }
    if (path === "/bid") {
      if (process.env.CHECKOUT_ENABLED !== "true")
        return response(409, {
          message: "Bidding opens after the release details are confirmed.",
        });
      if (user.admin)
        return response(403, {
          message: "The seller cannot bid on their own auction.",
        });
      const a = await get(`AUCTION#${clean(body.id, 80)}`, "HEAD");
      if (!a || auctionPhase(a as any) !== "open")
        return response(409, { message: "This auction is not open." });
      const amount = validateBid(body.amount, a as any);
      const profile = await get(`USER#${user.id}`, "PROFILE");
      if (
        !profile?.sizes?.includes(a.size) ||
        !a.countries.includes(profile.country)
      )
        return response(409, {
          message:
            "Check your size preferences and shipping country in your profile.",
        });
      if (
        body.termsVersion !== a.termsVersion ||
        body.accepted !== true ||
        body.adult !== true
      )
        return response(400, {
          message: "Confirm you are 18 or over and accept the auction terms.",
        });
      const now = Date.now();
      const bidId = randomUUID();
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName,
                Key: key(a.id),
                UpdateExpression:
                  "SET highestBid=:amount, highestBidder=:bidder, highestBidderEmail=:email ADD revision :one, bidCount :one",
                ConditionExpression:
                  "revision=:v AND opensAt<=:now AND closesAt>:now AND (#s=:scheduled OR #s=:open)",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":amount": amount,
                  ":bidder": user.id,
                  ":email": user.email,
                  ":one": 1,
                  ":v": a.revision,
                  ":now": now,
                  ":scheduled": "scheduled",
                  ":open": "open",
                },
              },
            },
            {
              Put: {
                TableName,
                Item: {
                  pk: `AUCTION#${a.id}`,
                  sk: `BID#${now}#${bidId}`,
                  bidderId: user.id,
                  email: user.email,
                  amount,
                  createdAt: now,
                  termsVersion: a.termsVersion,
                  accepted: true,
                  country: profile.country,
                  size: a.size,
                },
              },
            },
            {
              Put: {
                TableName,
                Item: { pk: `USER#${user.id}`, sk: "ACTIVITY", lastBidAt: now },
              },
            },
          ],
        }),
      );
      return response(200, { ok: true, amount });
    }
    if (path === "/winner/checkout") {
      const a = await get(`AUCTION#${clean(body.id, 80)}`, "HEAD");
      return response(200, await checkout(a || {}, user));
    }
    if (path === "/owner") {
      const a = await get(`AUCTION#${clean(body.id, 80)}`, "HEAD");
      if (a?.status !== "sold" || a.ownerId !== user.id)
        return response(403, {
          message: "Only the paid owner can change this.",
        });
      const anonymous = body.anonymous !== false;
      const name = anonymous ? null : clean(body.name, 80);
      if (!anonymous && !name)
        throw Object.assign(Error("Choose a public name."), { status: 400 });
      await db.send(
        new UpdateCommand({
          TableName,
          Key: key(a.id),
          UpdateExpression: "SET publicOwner=:owner",
          ConditionExpression: "ownerId=:u AND #s=:sold",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":owner": { anonymous, name },
            ":u": user.id,
            ":sold": "sold",
          },
        }),
      );
      return response(200, { ok: true });
    }
    if (path === "/admin" && method === "GET") {
      const [collectors, auctions, mail, settings, transfers] =
        await Promise.all([
          index("COLLECTORS"),
          index("AUCTIONS"),
          index("MAIL"),
          get("SETTINGS", "RELEASES"),
          index("TRANSFERS"),
        ]);
      let cursor;
      const guestlist: any[] = [];
      do {
        const r: any = await db.send(
          new ScanCommand({
            TableName: process.env.TABLE_NAME!,
            FilterExpression: "begins_with(pk,:p)",
            ExpressionAttributeValues: { ":p": "EMAIL#" },
            ExclusiveStartKey: cursor,
          }),
        );
        guestlist.push(...r.Items);
        cursor = r.LastEvaluatedKey;
      } while (cursor);
      return response(200, {
        collectors,
        auctions,
        transfers,
        guestlist: guestlist.filter((g) => g.expiresAt > Date.now() / 1000),
        mail: mail.map((m) => ({
          id: m.pk,
          email: m.email,
          subject: m.subject,
          status: m.status,
        })),
        settings: settings || { cadence: "individual" },
        paymentsEnabled: process.env.CHECKOUT_ENABLED === "true",
        emailEnabled: process.env.EMAIL_ENABLED === "true",
        verificationEmailEnabled: await membership.deliveryEnabled(),
        smsEnabled: false,
      });
    }
    if (path === "/admin/settings") {
      if (!["individual"].includes(body.cadence))
        throw Object.assign(Error("Choose a schedule mode."), { status: 400 });
      await db.send(
        new PutCommand({
          TableName,
          Item: {
            pk: "SETTINGS",
            sk: "RELEASES",
            cadence: body.cadence,
            updatedBy: user.id,
            updatedAt: Date.now(),
          },
        }),
      );
      return response(200, { ok: true });
    }
    if (path === "/admin/release") {
      const id = clean(body.id, 80);
      if (!/^[a-z0-9-]+$/.test(id))
        throw Object.assign(Error("Use a simple release ID."), { status: 400 });
      const old = await get(`AUCTION#${id}`, "HEAD");
      if (
        old &&
        (old.bidCount > 0 ||
          old.status === "sold" ||
          old.status === "awaiting-payment" ||
          (old.opensAt && old.opensAt <= Date.now()))
      )
        return response(409, {
          message: "A released auction cannot be rewritten.",
        });
      const publish = body.publish === true;
      const openingBid = Number(body.openingBid),
        minimumIncrement = Number(body.minimumIncrement),
        paymentHours = Number(body.paymentHours),
        shippingFee = Number(body.shippingFee);
      if (
        ![openingBid, minimumIncrement, shippingFee].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) ||
        openingBid < 100 ||
        minimumIncrement < 100 ||
        !Number.isInteger(paymentHours) ||
        paymentHours < 24 ||
        paymentHours > 168
      )
        throw Object.assign(
          Error("Check prices and payment window (24–168 hours)."),
          { status: 400 },
        );
      const item: any = {
        ...preview,
        ...key(id),
        id,
        slug: clean(body.slug, 80),
        name: clean(body.name, 100),
        number: clean(body.number, 20),
        image: clean(body.image, 300),
        story: clean(body.story, 4000),
        designRevealMode:
          body.designRevealMode === "at-opening" ? "at-opening" : "now",
        material: clean(body.material, 150),
        revealMode: ["now", "at-opening", "after-close", "manual"].includes(
          body.revealMode,
        )
          ? body.revealMode
          : "manual",
        identityRevealed: old?.identityRevealed || false,
        artistName: clean(body.artistName, 100),
        artistOrigin: clean(body.artistOrigin, 100),
        artistPractice: clean(body.artistPractice, 200),
        artistBiography: clean(body.artistBiography, 4000),
        artistWorks: clean(body.artistWorks, 2000),
        size: clean(body.size, 10),
        measurements: clean(body.measurements, 300),
        openingBid,
        minimumIncrement,
        paymentHours,
        shippingFee,
        countries: Array.isArray(body.countries)
          ? [
              ...new Set(
                body.countries.filter(
                  (c: any) => typeof c === "string" && /^[A-Z]{2}$/.test(c),
                ),
              ),
            ]
          : [],
        opensAt: publish ? Number(body.opensAt) : null,
        closesAt: publish ? Number(body.closesAt) : null,
        status: publish ? "scheduled" : "unannounced",
        published: publish,
        termsVersion: TERMS_VERSION,
        revision: (old?.revision || 0) + 1,
        gpk: "AUCTIONS",
        gsk: id,
        updatedBy: user.id,
      };
      if (
        !/^[a-z0-9-]+$/.test(item.slug) ||
        (item.slug === preview.slug && id !== preview.id) ||
        !item.image.startsWith("/images/") ||
        item.image.includes("..") ||
        !item.name
      )
        throw Object.assign(Error("Use a slug and an image from /images/."), {
          status: 400,
        });
      if (publish) {
        if (
          process.env.CHECKOUT_ENABLED !== "true" ||
          process.env.EMAIL_ENABLED !== "true"
        )
          return response(409, {
            message:
              "Connect payments, approve seller terms and enable transactional email before scheduling bidding.",
          });
        validateSchedule(item.opensAt, item.closesAt);
        if (
          !sizes.includes(item.size as any) ||
          !item.material ||
          !item.artistName ||
          !item.artistBiography ||
          !item.measurements ||
          !item.countries.length
        )
          throw Object.assign(
            Error(
              "Add the material, artist, biography, measurements, size and eligible countries.",
            ),
            { status: 400 },
          );
        const others = await index("AUCTIONS");
        if (
          others.some(
            (a) =>
              a.id !== id &&
              a.opensAt &&
              a.closesAt &&
              a.opensAt < item.closesAt &&
              a.closesAt > item.opensAt,
          )
        )
          throw Object.assign(
            Error("Only one auction can be in the spotlight at a time."),
            { status: 409 },
          );
      }
      // Global edit lock serializes schedule creation; overlap checks are repeated under a short lease below.
      const lease = randomUUID();
      await db.send(
        new PutCommand({
          TableName,
          Item: {
            pk: "SCHEDULE_LOCK",
            sk: "LOCK",
            lease,
            until: Date.now() + 30000,
          },
          ConditionExpression: "attribute_not_exists(pk) OR #until<:now",
          ExpressionAttributeNames: { "#until": "until" },
          ExpressionAttributeValues: { ":now": Date.now() },
        }),
      );
      try {
        const all = await query("RELEASE_WINDOWS");
        if (
          publish &&
          all.some(
            (a) =>
              a.id !== id &&
              a.opensAt < item.closesAt &&
              a.closesAt > item.opensAt,
          )
        )
          throw Object.assign(Error("Another release overlaps these dates."), {
            status: 409,
          });
        await db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName,
                  Item: { pk: `SLUG#${item.slug}`, sk: "SLUG", auctionId: id },
                  ConditionExpression:
                    "attribute_not_exists(pk) OR auctionId=:id",
                  ExpressionAttributeValues: { ":id": id },
                },
              },
              {
                Put: {
                  TableName,
                  Item: item,
                  ConditionExpression: old
                    ? "revision=:v"
                    : "attribute_not_exists(pk)",
                  ...(old
                    ? { ExpressionAttributeValues: { ":v": old.revision } }
                    : {}),
                },
              },
              {
                Put: {
                  TableName,
                  Item: {
                    pk: "RELEASE_WINDOWS",
                    sk: id,
                    id,
                    opensAt: item.opensAt || 0,
                    closesAt: item.closesAt || 0,
                  },
                },
              },
            ],
          }),
        );
      } finally {
        await db.send(
          new DeleteCommand({
            TableName,
            Key: { pk: "SCHEDULE_LOCK", sk: "LOCK" },
            ConditionExpression: "lease=:l",
            ExpressionAttributeValues: { ":l": lease },
          }),
        );
      }
      return response(200, { ok: true });
    }
    if (path === "/admin/reveal") {
      const a = await get(`AUCTION#${clean(body.id, 80)}`, "HEAD");
      if (!a?.artistName || !a?.material)
        return response(409, { message: "Add the artist and material first." });
      await db.send(
        new UpdateCommand({
          TableName,
          Key: key(a.id),
          UpdateExpression: "SET identityRevealed=:yes ADD revision :one",
          ExpressionAttributeValues: { ":yes": true, ":one": 1 },
        }),
      );
      return response(200, { ok: true });
    }
    if (path === "/admin/next-bidder") {
      if (body.confirmed !== true)
        throw Object.assign(
          Error(
            "Confirm the original offer has been cancelled under your terms.",
          ),
          { status: 400 },
        );
      const a = await get(`AUCTION#${clean(body.id, 80)}`, "HEAD");
      return response(200, await nextBidder(a || {}));
    }
    if (path === "/admin/fulfillment") {
      const a = await get(`AUCTION#${clean(body.id, 80)}`, "HEAD");
      if (a?.status !== "sold")
        return response(409, {
          message: "Fulfilment starts after confirmed payment.",
        });
      const fulfillment = {
        certificateSigned: body.certificateSigned === true,
        cardIncluded: body.cardIncluded === true,
        hologramId: clean(body.hologramId, 80),
        insured: body.insured === true,
        tracking: clean(body.tracking, 200),
        shippedAt: body.shipped === true ? Date.now() : null,
      };
      if (
        fulfillment.shippedAt &&
        (!fulfillment.certificateSigned ||
          !fulfillment.cardIncluded ||
          !fulfillment.hologramId ||
          !fulfillment.insured ||
          !fulfillment.tracking)
      )
        return response(400, {
          message:
            "Complete the signed certificate, ownership card, hologram, insurance and tracking before dispatch.",
        });
      await db.send(
        new UpdateCommand({
          TableName,
          Key: key(a.id),
          UpdateExpression: "SET fulfillment=:f",
          ExpressionAttributeValues: { ":f": fulfillment },
        }),
      );
      return response(200, { ok: true });
    }
    return response(404, { message: "Not found." });
  } catch (e: any) {
    if (conflict(e))
      return response(409, {
        message: "This changed a moment ago. Refresh and try again.",
      });
    if (e.status) return response(e.status, { message: e.message });
    if (
      e.message?.startsWith("Choose ") ||
      e.message?.startsWith("Closing ") ||
      e.message?.startsWith("The bid")
    )
      return response(400, { message: e.message });
    console.error(
      JSON.stringify({ event: "platform_error", path, error: e.name }),
    );
    return response(503, {
      message: "Temporarily unavailable. Please try again.",
    });
  }
}

import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESv2Client, GetAccountCommand } from "@aws-sdk/client-sesv2";
const region = "eu-north-1";
assert.equal(process.env.AWS_PROFILE, "hewge");
const result = await new CloudFormationClient({ region }).send(
  new DescribeStacksCommand({ StackName: "hewge-production" }),
);
assert.equal(result.Stacks[0].StackId.split(":")[4], "082229154968");
const o = Object.fromEntries(
  result.Stacks[0].Outputs.map((x) => [x.OutputKey, x.OutputValue]),
);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const hash = (s) => createHash("sha256").update(s).digest("hex");
const email = `hewge-smoke-${randomUUID()}@example.invalid`;
const pk = `EMAIL#${hash(email)}`;
const token = randomBytes(32).toString("base64url");
const challengeKey = { pk: `MEMBER_VERIFY#${hash(token)}`, sk: "STATE" };
const read = async () =>
  (
    await db.send(
      new GetCommand({
        TableName: o.DataTableName,
        Key: { pk },
        ConsistentRead: true,
      }),
    )
  ).Item;
async function post(path, body, origin = "https://hewge.design") {
  const r = await fetch(`${o.ApiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const account = await new SESv2Client({ region }).send(
  new GetAccountCommand({}),
);
try {
  const catalog = await fetch(`${o.ApiUrl}/catalog`).then((r) => r.json());
  assert.equal(catalog.price, 33900);
  assert.equal(catalog.currency, "chf");
  if (!account.ProductionAccessEnabled) {
    const requested = await post("/waitlist", {
      email,
      consent: true,
      sizes: ["XL"],
      timezone: "Europe/Zurich",
      locale: "en-CH",
    });
    assert.equal(requested.status, 200, JSON.stringify(requested));
    assert.equal(requested.body.delivery, "pending");
    const saved = await read();
    assert.equal(saved.emailVerified, false);
    assert.equal(saved.releaseConsent, false);
    assert.deepEqual(saved.sizes, []);
    console.log(
      "Email-only request stays pending in the SES sandbox; no message sent.",
    );
  } else {
    // Seed only our synthetic request. Never send test mail to a nonexistent address.
    await db.send(
      new PutCommand({
        TableName: o.DataTableName,
        Item: {
          pk,
          email,
          emailVerified: false,
          releaseConsent: false,
          sizes: [],
          revision: 0,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }
  await db.send(
    new PutCommand({
      TableName: o.AuctionTableName,
      Item: {
        ...challengeKey,
        memberKey: pk,
        purpose: "join",
        used: false,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
  assert.equal(
    (await post("/membership/profile", { session: token, country: "CH" }))
      .status,
    401,
  );
  assert.equal(
    (await post("/membership/link", { token })).body.purpose,
    "join",
  );
  assert.equal((await read()).emailVerified, false);
  const verified = await post("/membership/verify", { token });
  assert.equal(verified.status, 200, JSON.stringify(verified));
  assert.equal(verified.body.profile.emailVerified, true);
  assert.equal(verified.body.profile.releaseConsent, true);
  const { session } = verified.body;
  assert.equal((await post("/membership/verify", { token })).status, 400);
  assert.equal(
    (
      await post("/membership/profile", {
        session,
        sizes: ["M", "XL"],
        country: "CH",
        city: "QA",
        readiness: "ready",
        releaseConsent: false,
        smsConsent: false,
      })
    ).status,
    200,
  );
  const preferences = await post("/membership/session", { session });
  assert.deepEqual(preferences.body.profile.sizes, ["M", "XL"]);
  assert.equal(preferences.body.profile.releaseConsent, false);
  assert.equal(preferences.body.profile.smsConsent, false);
  assert.equal(preferences.body.profile.country, "CH");
  assert.equal(
    (
      await post(
        "/waitlist",
        { email, consent: true },
        "https://untrusted.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (await post("/checkout", { productId: catalog.id })).status,
    409,
  );
  console.log(
    "Single-use verification, limited preference access, consent and origin checks pass; checkout remains disabled.",
  );
} finally {
  // Delete only rows belonging to this synthetic identity; never print personal records or tokens.
  let cursor;
  do {
    const rows = await db.send(
      new ScanCommand({
        TableName: o.AuctionTableName,
        FilterExpression: "memberKey=:key OR email=:email",
        ExpressionAttributeValues: { ":key": pk, ":email": email },
        ProjectionExpression: "pk,sk",
        ExclusiveStartKey: cursor,
      }),
    );
    for (const Key of rows.Items || [])
      await db.send(new DeleteCommand({ TableName: o.AuctionTableName, Key }));
    cursor = rows.LastEvaluatedKey;
  } while (cursor);
  await db.send(new DeleteCommand({ TableName: o.DataTableName, Key: { pk } }));
  const hour = Math.floor(Date.now() / 3600000);
  for (const h of [hour - 1, hour])
    await db.send(
      new DeleteCommand({
        TableName: o.AuctionTableName,
        Key: { pk: `MEMBER_RATE#EMAIL#${hash(`${h}:${email}`)}`, sk: "RATE" },
      }),
    );
  assert.equal(await read(), undefined);
  console.log("Disposable membership records removed.");
}

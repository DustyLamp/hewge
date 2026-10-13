import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
const region = "eu-north-1";
assert.equal(process.env.AWS_PROFILE, "hewge");
const result = await new CloudFormationClient({ region }).send(
  new DescribeStacksCommand({ StackName: "hewge-production" }),
);
const o = Object.fromEntries(
  result.Stacks[0].Outputs.map((x) => [x.OutputKey, x.OutputValue]),
);
assert.equal(result.Stacks[0].StackId.split(":")[4], "082229154968");
const cognito = new CognitoIdentityProviderClient({ region });
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const username = `hewge-qa-${randomUUID()}@example.invalid`;
const password = `Qa9${randomBytes(24).toString("hex")}`;
const draftId = `qa-${randomUUID()}`;
let userId,
  created = false,
  token;
async function request(path, body) {
  const r = await fetch(`${o.ApiUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: "https://hewge.design",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
async function login() {
  const r = await cognito.send(
    new InitiateAuthCommand({
      ClientId: o.UserPoolClientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  token = r.AuthenticationResult.IdToken;
  userId = JSON.parse(Buffer.from(token.split(".")[1], "base64url")).sub;
}
try {
  assert.equal((await request("/admin")).status, 403);
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: o.UserPoolId,
      Username: username,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: username },
        { Name: "email_verified", Value: "true" },
      ],
    }),
  );
  created = true;
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: o.UserPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );
  await login();
  assert.equal((await request("/admin")).status, 403);
  console.log("Live collector token cannot access the owner dashboard.");
  assert.equal(
    (
      await request("/me/profile", {
        displayName: "Disposable QA",
        sizes: ["M", "XL"],
        country: "CH",
        instagram: "",
        followers: "",
        releaseConsent: false,
      })
    ).status,
    200,
  );
  const me = await request("/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.profile.sizes, ["M", "XL"]);
  assert.equal(me.data.admin, false);
  console.log("Verified-token profile preferences persist.");
  assert.equal(
    (await request("/bid", { id: "toucan-001", amount: 33900 })).status,
    409,
  );
  assert.equal(
    (
      await request("/owner", {
        id: "toucan-001",
        anonymous: false,
        name: "Unauthorized",
      })
    ).status,
    403,
  );
  console.log("Bidding gate and unpaid ownership restrictions hold.");
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: o.UserPoolId,
      Username: username,
      GroupName: "admins",
    }),
  );
  await login();
  const admin = await request("/admin");
  assert.equal(admin.status, 200);
  assert.equal(admin.data.paymentsEnabled, false);
  assert(admin.data.collectors.some((c) => c.email === username));
  console.log(
    "Authorised owner token reads dashboard; payments remain disabled.",
  );
  assert.equal(
    (await request("/admin/settings", { cadence: "individual" })).status,
    200,
  );
  const draft = {
    id: draftId,
    slug: draftId,
    name: "Private QA draft",
    number: "QA",
    image: "/images/foliage.webp",
    story: "Unpublished QA",
    artistName: "Private QA artist",
    material: "Private QA material",
    revealMode: "now",
    size: "M",
    openingBid: 33900,
    minimumIncrement: 1000,
    paymentHours: 48,
    shippingFee: 1500,
    countries: ["CH"],
    publish: false,
  };
  const saved = await request("/admin/release", draft);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(
    (
      await db.send(
        new GetCommand({
          TableName: o.AuctionTableName,
          Key: { pk: `AUCTION#${draftId}`, sk: "HEAD" },
          ConsistentRead: true,
        }),
      )
    ).Item.published,
    false,
  );
  const releases = await request("/releases");
  assert(!JSON.stringify(releases.data).includes(draftId));
  assert.equal(
    (await request("/admin/release", { ...draft, id: `${draftId}-duplicate` }))
      .status,
    409,
  );
  console.log(
    "Draft saves remain private; duplicate release URLs are rejected.",
  );
} finally {
  for (const Key of [
    { pk: `AUCTION#${draftId}`, sk: "HEAD" },
    { pk: "RELEASE_WINDOWS", sk: draftId },
    { pk: `SLUG#${draftId}`, sk: "SLUG" },
  ])
    await db.send(new DeleteCommand({ TableName: o.AuctionTableName, Key }));
  if (userId)
    await db.send(
      new DeleteCommand({
        TableName: o.AuctionTableName,
        Key: { pk: `USER#${userId}`, sk: "PROFILE" },
      }),
    );
  if (created)
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: o.UserPoolId,
        Username: username,
      }),
    );
  if (userId)
    assert.equal(
      (
        await db.send(
          new GetCommand({
            TableName: o.AuctionTableName,
            Key: { pk: `USER#${userId}`, sk: "PROFILE" },
            ConsistentRead: true,
          }),
        )
      ).Item,
      undefined,
    );
  console.log(
    "Disposable QA identity and profile removed. No verification email was sent.",
  );
}

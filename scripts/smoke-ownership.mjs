// Temporary, undiscoverable QA piece; no payment, real customer or email delivery.
import { enrollStudio } from "./qa-security.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
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
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
const region = "eu-north-1";
assert.equal(process.env.AWS_PROFILE, "hewge", "Use the hewge AWS profile.");
const result = await new CloudFormationClient({ region }).send(
  new DescribeStacksCommand({ StackName: "hewge-production" }),
);
assert.equal(result.Stacks[0].StackId.split(":")[4], "082229154968");
const o = Object.fromEntries(
  result.Stacks[0].Outputs.map((x) => [x.OutputKey, x.OutputValue]),
);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const cognito = new CognitoIdentityProviderClient({ region });
const id = `qa-${randomUUID()}`;
const users = [];
const transferIds = new Set();
const TableName = o.AuctionTableName;
const hash = (email) => createHash("sha256").update(email).digest("hex");
async function createUser(role) {
  const u = {
    email: `${id}-${role}@example.invalid`,
    password: `Qa9${randomBytes(24).toString("hex")}`,
  };
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: o.UserPoolId,
      Username: u.email,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: u.email },
        { Name: "email_verified", Value: "true" },
      ],
    }),
  );
  users.push(u);
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: o.UserPoolId,
      Username: u.email,
      Password: u.password,
      Permanent: true,
    }),
  );
  if (role === "admin")
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: o.UserPoolId,
        Username: u.email,
        GroupName: "admins",
      }),
    );
  const r = await cognito.send(
    new InitiateAuthCommand({
      ClientId: o.UserPoolClientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: u.email, PASSWORD: u.password },
    }),
  );
  u.token = r.AuthenticationResult.IdToken;
  u.id = JSON.parse(Buffer.from(u.token.split(".")[1], "base64url")).sub;
  if (role === "admin") {
    const authenticated = await enrollStudio(
      (p, b) => call(u, p, b),
      u.email,
      u.password,
    );
    u.token = authenticated.idToken;
    u.studio = authenticated.adminSession;
  }
  return u;
}
async function call(user, path, body) {
  const r = await fetch(`${o.ApiUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: "https://hewge.design",
      "Content-Type": "application/json",
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      ...(user?.studio ? { "X-Hewge-Studio": user.studio } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    serverTime: Date.parse(r.headers.get("date")),
  };
}
async function rows(pk) {
  return (
    (
      await db.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: "pk=:p",
          ExpressionAttributeValues: { ":p": pk },
          ConsistentRead: true,
        }),
      )
    ).Items || []
  );
}
const head = () =>
  db
    .send(
      new GetCommand({
        TableName,
        Key: { pk: `AUCTION#${id}`, sk: "HEAD" },
        ConsistentRead: true,
      }),
    )
    .then((r) => r.Item);
try {
  const owner = await createUser("owner");
  const recipient = await createUser("recipient");
  const admin = await createUser("admin");
  await db.send(
    new PutCommand({
      TableName,
      Item: {
        pk: `AUCTION#${id}`,
        sk: "HEAD",
        id,
        name: "Disposable ownership QA",
        number: "QA",
        slug: id,
        status: "sold",
        ownerId: owner.id,
        soldAt: Date.now(),
        certificateId: `CERT-${id}`,
        publicOwner: { anonymous: true, name: null },
        fulfillment: {
          certificateSigned: true,
          hologramId: `SEAL-${id}`,
          shippedAt: Date.now(),
        },
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
  const request = {
    id,
    email: recipient.email,
    confirmed: true,
    kind: "sale",
    resaleAmount: 100000,
  };
  assert.equal(
    (await call(recipient, "/transfer/request", request)).status,
    403,
  );
  const competing = await Promise.all([
    call(owner, "/transfer/request", request),
    call(owner, "/transfer/request", request),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  const transferId = competing.find((r) => r.status === 200).data.id;
  transferIds.add(transferId);
  assert.equal((await head()).ownerId, owner.id);
  const inbox = await call(recipient, "/me");
  assert.equal(inbox.status, 200);
  assert(inbox.data.transfers.some((t) => t.id === transferId));
  console.log(
    "Only the owner can request; concurrent requests leave one active transfer; the verified recipient sees it.",
  );
  const accept = {
    transferId,
    received: true,
    feeConsent: true,
    certificateId: `CERT-${id}`,
    hologramId: `SEAL-${id}`,
  };
  assert.equal((await call(owner, "/transfer/accept", accept)).status, 403);
  assert.equal(
    (
      await call(recipient, "/transfer/accept", {
        ...accept,
        hologramId: "wrong",
      })
    ).status,
    400,
  );
  const accepted = await call(recipient, "/transfer/accept", accept);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal((await head()).ownerId, owner.id);
  const approval = {
    ...accept,
    action: "approve",
    physicalChecked: true,
    titleChecked: true,
    evidence: "Disposable synthetic QA, no real garment or customer.",
  };
  assert.equal(
    (await call(recipient, "/admin/transfer", approval)).status,
    403,
  );
  assert.equal(
    (
      await call(admin, "/admin/transfer", {
        ...approval,
        physicalChecked: false,
      })
    ).status,
    400,
  );
  assert.equal((await call(admin, "/admin/transfer", approval)).status, 409);
  const review = await call(admin, "/admin/transfer", {
    ...approval,
    action: "review",
  });
  assert.equal(review.status, 200, JSON.stringify(review));
  assert.equal(
    (await call(recipient, "/transfer/checkout", { transferId })).status,
    409,
  );
  // Synthetic fixture ONLY: no Stripe charge. Never apply this to a real sale.
  assert(id.startsWith("qa-"));
  await db.send(
    new UpdateCommand({
      TableName,
      Key: { pk: `TRANSFER#${transferId}`, sk: "HEAD" },
      UpdateExpression: "SET feeStatus=:paid",
      ConditionExpression: "auctionId=:id AND reviewed=:yes",
      ExpressionAttributeValues: { ":paid": "paid", ":id": id, ":yes": true },
    }),
  );
  const approved = await call(admin, "/admin/transfer", approval);
  assert.equal(approved.status, 200, JSON.stringify(approved));
  const updated = await head();
  assert.equal(updated.ownerId, recipient.id);
  assert.equal(updated.pendingTransferId, undefined);
  assert.deepEqual(updated.publicOwner, { anonymous: true, name: null });
  assert.equal((await call(admin, "/admin/transfer", approval)).status, 409);
  assert.equal(
    (
      await call(owner, "/owner", {
        id,
        anonymous: false,
        name: "Former owner",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(recipient, "/owner", { id, anonymous: true })).status,
    200,
  );
  console.log(
    "Acceptance leaves ownership unchanged; reviewed approval transfers it once; former-owner access is revoked.",
  );
  const record = await call(null, `/registry/${id}`);
  assert.equal(record.status, 200);
  assert.equal(record.data.history.length, 2);
  const serialized = JSON.stringify(record.data);
  for (const u of users) {
    assert(!serialized.includes(u.email));
    assert(!serialized.includes(u.id));
  }
  assert(!serialized.includes("synthetic QA"));
  assert.equal(
    (await call(null, "/releases")).data.releases.some((a) => a.id === id),
    false,
  );
  console.log(
    "Public provenance excludes private identities/evidence; the QA piece never enters public listings.",
  );
  // Exercise recipient cancellation of a new, reverse transfer.
  const reverse = await call(recipient, "/transfer/request", {
    id,
    email: owner.email,
    confirmed: true,
    kind: "gift",
  });
  assert.equal(reverse.status, 200);
  transferIds.add(reverse.data.id);
  assert.equal(
    (await call(owner, "/transfer/cancel", { transferId: reverse.data.id }))
      .status,
    200,
  );
  assert.equal((await head()).ownerId, recipient.id);
  assert.equal((await head()).pendingTransferId, undefined);
  console.log(
    "Cancellation preserves the current owner and releases the pending request.",
  );
} finally {
  const partitions = [
    `AUCTION#${id}`,
    `PROVENANCE#${id}`,
    ...users
      .flatMap((u) => [
        u.id && `USER#${u.id}`,
        u.id && `TRANSFERS_FROM#${u.id}`,
        `TRANSFERS_TO#${hash(u.email)}`,
      ])
      .filter(Boolean),
  ];
  for (const pk of partitions) {
    for (const row of await rows(pk)) {
      if (row.transferId) transferIds.add(row.transferId);
      if (row.pendingTransferId) transferIds.add(row.pendingTransferId);
      await db.send(
        new DeleteCommand({ TableName, Key: { pk: row.pk, sk: row.sk } }),
      );
    }
  }
  for (const transferId of transferIds)
    await db.send(
      new DeleteCommand({
        TableName,
        Key: { pk: `TRANSFER#${transferId}`, sk: "HEAD" },
      }),
    );
  for (const u of users) {
    await db.send(
      new DeleteCommand({
        TableName,
        Key: { pk: `ADMIN_MFA#${u.id}`, sk: "SECURITY" },
      }),
    );
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: o.UserPoolId,
        Username: u.email,
      }),
    );
  }
  assert.equal(await head(), undefined);
  console.log(
    "Disposable QA operational records removed. Protected synthetic audit events remain permanently. Fee status was a test fixture; no messages or payments sent.",
  );
}

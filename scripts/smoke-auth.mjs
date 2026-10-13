import { readFile } from "node:fs/promises";
import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { enrollStudio } from "./qa-security.mjs";
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
  token,
  studio,
  mediaId;
async function request(path, body) {
  const r = await fetch(`${o.ApiUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: "https://hewge.design",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(studio ? { "X-Hewge-Studio": studio } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    data: await r.json(),
    serverTime: Date.parse(r.headers.get("date")),
  };
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
  assert.equal((await request("/admin")).status, 401);
  const authenticated = await enrollStudio(request, username, password);
  token = authenticated.idToken;
  studio = authenticated.adminSession;
  console.log(
    "Studio rejects password-only admin access; authenticator enrolment succeeds and challenge replay is rejected.",
  );
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
    productionCost: 5230,
    artistCost: 6000,
    otherCost: 1200,
    costNotes: "Synthetic cost record",
    plannedOpensAt: Date.now() + 86400000,
    plannedClosesAt: Date.now() + 2 * 86400000,
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
  const audit = await request("/admin/audit", {
    entity: `release:${draftId}`,
    verify: true,
  });
  assert.equal(audit.status, 200, JSON.stringify(audit));
  assert.equal(audit.data.verification.complete, true);
  assert.equal(audit.data.events[0].action, "release-drafted");
  assert(!JSON.stringify(audit.data).includes(username));
  console.log(
    "Protected receipts and hash chain verify live, with contact details excluded.",
  );
  const bytes = await readFile(
    new URL("../public/images/foliage.webp", import.meta.url),
  );
  const upload = await request("/admin/media/upload", {
    releaseId: draftId,
    kind: "artwork",
    name: "Synthetic QA image",
    contentType: "image/webp",
    size: bytes.length,
  });
  assert.equal(
    upload.status,
    200,
    JSON.stringify({ status: upload.status, message: upload.data.message }),
  );
  mediaId = upload.data.id;
  const put = await fetch(upload.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/webp", "If-None-Match": "*" },
    body: bytes,
  });
  assert.equal(put.status, 200, await put.text());
  const complete = await request("/admin/media/complete", { id: mediaId });
  assert.equal(complete.status, 200, JSON.stringify(complete));
  const hidden = await fetch(complete.data.image, { redirect: "manual" });
  assert.equal(hidden.status, 404);
  const privateView = await request("/admin/media/read", { id: mediaId });
  assert.equal(privateView.status, 200);
  const image = await fetch(privateView.data.url);
  assert.equal(image.status, 200);
  assert.equal((await image.arrayBuffer()).byteLength, bytes.length);
  const protectedObject = await new S3Client({ region }).send(
    new HeadObjectCommand({
      Bucket: o.AuditBucketName,
      Key: `events/${audit.data.events[0].id}/committed.json`,
    }),
  );
  assert.equal(protectedObject.ObjectLockMode, "COMPLIANCE");
  assert.equal(protectedObject.ObjectLockLegalHoldStatus, "ON");
  assert(protectedObject.ObjectLockRetainUntilDate.getUTCFullYear() > 2120);
  console.log(
    "Presigned image upload and private preview work; public access to unrevealed artwork is blocked; audit object has compliance retention and legal hold.",
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
  if (mediaId) {
    await db.send(
      new DeleteCommand({
        TableName: o.AuctionTableName,
        Key: { pk: `MEDIA#${mediaId}`, sk: "HEAD" },
      }),
    );
    const s3 = new S3Client({ region });
    for (const Key of [`staging/${mediaId}`, `media/${mediaId}`]) {
      const versions = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: o.MediaBucketName,
          Prefix: Key,
        }),
      );
      const Objects = [
        ...(versions.Versions || []),
        ...(versions.DeleteMarkers || []),
      ]
        .filter((v) => v.Key === Key)
        .map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
      if (Objects.length)
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: o.MediaBucketName,
            Delete: { Objects },
          }),
        );
    }
  }
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
  if (userId)
    await db.send(
      new DeleteCommand({
        TableName: o.AuctionTableName,
        Key: { pk: `ADMIN_MFA#${userId}`, sk: "SECURITY" },
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
    "Disposable QA identity and profile removed. Pseudonymous audit events remain protected permanently; no email was sent.",
  );
}

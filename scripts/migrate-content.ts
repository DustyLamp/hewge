import {
  afterHoursPresentation,
  homePresentation,
} from "./presentation-content";
// Explicit, idempotent migration of already-public content into the CMS.
// Existing live records are never overwritten. No customers or launch gates change.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { auditLedger, digest } from "../services/audit";
import { mediaLibrary } from "../services/media";
import { contentService } from "../services/content";
import { initialRelease } from "./initial-content";
assert.equal(process.env.AWS_PROFILE, "hewge");
const region = "eu-north-1";
const stack = (
  await new CloudFormationClient({ region }).send(
    new DescribeStacksCommand({ StackName: "hewge-production" }),
  )
).Stacks![0];
assert.equal(stack.StackId!.split(":")[4], "082229154968");
const out = Object.fromEntries(
  stack.Outputs!.map((o) => [o.OutputKey!, o.OutputValue!]),
);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region });
const ledger = auditLedger(db, s3, out.AuditTableName, out.AuditBucketName);
process.env.MEDIA_API_URL = out.ApiUrl;
const media = mediaLibrary(
  db,
  s3,
  out.AuctionTableName,
  out.MediaBucketName,
  ledger.commit,
);
const cms = contentService(
  db,
  s3,
  out.AuctionTableName,
  out.MediaBucketName,
  ledger.commit,
  media.validateImage,
);
const get = async (pk: string, sk: string) =>
  (
    await db.send(
      new GetCommand({
        TableName: out.AuctionTableName,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    )
  ).Item;
async function asset(file: string, releaseId: string, kind = "artwork") {
  const bytes = await readFile(`public/images/${file}.webp`);
  const hash = digest({ releaseId, file, bytes: bytes.toString("base64") });
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  if (!(await get(`MEDIA#${id}`, "HEAD"))) {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: out.MediaBucketName,
          Key: `media/${id}`,
          Body: bytes,
          ContentType: "image/webp",
          IfNoneMatch: "*",
        }),
      );
    } catch (e: any) {
      if (e.$metadata?.httpStatusCode !== 412) throw e;
      const existing = await s3.send(
        new GetObjectCommand({
          Bucket: out.MediaBucketName,
          Key: `media/${id}`,
        }),
      );
      assert.deepEqual(
        Buffer.from(await existing.Body!.transformToByteArray()),
        bytes,
      );
    }
    await ledger.commit(
      [
        {
          Put: {
            TableName: out.AuctionTableName,
            Item: {
              pk: `MEDIA#${id}`,
              sk: "HEAD",
              id,
              releaseId,
              kind,
              name: file,
              contentType: "image/webp",
              size: bytes.length,
              status: "ready",
              sha256: createHash("sha256").update(bytes).digest("hex"),
              createdAt: Date.now(),
              createdBy: "cms-migration",
              gpk: "MEDIA",
              gsk: id,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
      {
        entity: `release:${releaseId}`,
        actor: "cms-migration",
        action: "published-media-migrated",
        details: { id, source: file },
      },
    );
  }
  return `${out.ApiUrl}/media/${id}`;
}
if (!(await get(`AUCTION#${initialRelease.id}`, "HEAD"))) {
  const image = await asset("shirt-front", initialRelease.id);
  const gallery = [];
  for (const [file, label] of [
    ["approved-mockup", "Both sides"],
    ["front-left", "After dark"],
    ["front-right", "The invitation"],
    ["back", "The morning after"],
  ])
    gallery.push({ image: await asset(file, initialRelease.id), label });
  const item = {
    ...initialRelease,
    image,
    gallery,
    subtitle: "A very good night. A very bad morning.",
    ...afterHoursPresentation,
    pk: `AUCTION#${initialRelease.id}`,
    sk: "HEAD",
    published: true,
    revision: 1,
    gpk: "AUCTIONS",
    gsk: initialRelease.id,
    updatedAt: Date.now(),
    updatedBy: "cms-migration",
  };
  const snapshot = await cms.snapshotRelease(item);
  await ledger.commit(
    [
      {
        Put: {
          TableName: out.AuctionTableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: out.AuctionTableName,
          Item: { pk: `SLUG#${item.slug}`, sk: "SLUG", auctionId: item.id },
          ConditionExpression: "attribute_not_exists(pk) OR auctionId=:id",
          ExpressionAttributeValues: { ":id": item.id },
        },
      },
    ],
    {
      entity: `release:${item.id}`,
      actor: "cms-migration",
      action: "published-piece-migrated",
      details: { revision: 1, name: item.name, ...snapshot },
    },
  );
  console.log(
    "Migrated After Hours to DynamoDB with S3 artwork; bidding remains unscheduled.",
  );
}
if (!(await cms.get("home", "DRAFT"))) {
  const guestImage = await asset("night", "page-home", "page");
  await cms.save(
    {
      id: "home",
      revision: 0,
      action: "publish",
      data: {
        featuredReleaseId: initialRelease.id,
        ...homePresentation,
        guestImage,
        guestImageAlt: "A detail of the illustrated artwork",
      },
    },
    { id: "cms-migration" },
  );
  console.log("Published the migrated homepage through the CMS service.");
}
assert.ok(await cms.get("home"));
console.log(
  "CMS migration verified. Existing content is preserved on repeat runs.",
);

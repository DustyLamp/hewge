import assert from "node:assert/strict";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { auditLedger } from "../services/audit";
import { mediaLibrary } from "../services/media";
import { contentService } from "../services/content";
import {
  afterHoursPresentation,
  homePresentation,
} from "./presentation-content";
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
// Explicit editorial publication. Run without --apply to check the expected
// state. Preserve unrelated fields, and stop if a live auction or private draft
// would be overwritten. All changes use the existing immutable audit ledger.
const apply = process.argv.includes("--apply");
const id = "toucan-001";
const old = await get(`AUCTION#${id}`, "HEAD");
assert.ok(
  old?.published && old.slug === "after-hours",
  "Expected published design study",
);
assert.ok(
  old.status === "unannounced" && !old.opensAt && !old.bidCount,
  "Do not rewrite a released auction",
);
const home = await cms.get("home");
const draft = await cms.get("home", "DRAFT");
assert.ok(
  home && draft && home.data.featuredReleaseId === id,
  "Expected homepage",
);
assert.deepEqual(
  draft.data,
  home.data,
  "A private homepage draft exists; reconcile it first",
);
const pieceChanged = Object.entries(afterHoursPresentation).some(
  ([k, v]) => old[k] !== v,
);
const homeChanged = Object.entries(homePresentation).some(
  ([k, v]) => home.data[k] !== v,
);
console.log({
  apply,
  pieceChanged,
  homeChanged,
  pieceRevision: old.revision,
  homeRevision: draft.revision,
});
if (apply && pieceChanged) {
  const item = {
    ...old,
    ...afterHoursPresentation,
    revision: old.revision + 1,
    updatedAt: Date.now(),
    updatedBy: "editorial-presentation",
  };
  const snapshot = await cms.snapshotRelease(item);
  await ledger.commit(
    [
      {
        Put: {
          TableName: out.AuctionTableName,
          Item: item,
          ConditionExpression:
            "revision=:r AND #status=:status AND attribute_not_exists(highestBidder)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":r": old.revision,
            ":status": "unannounced",
          },
        },
      },
    ],
    {
      entity: `release:${id}`,
      actor: "editorial-presentation",
      action: "release-published",
      details: { revision: item.revision, ...snapshot },
    },
  );
}
if (apply && homeChanged) {
  await cms.save(
    {
      id: "home",
      revision: draft.revision,
      action: "publish",
      data: { ...home.data, ...homePresentation },
    },
    { id: "editorial-presentation" },
  );
}
if (apply) {
  const current = await get(`AUCTION#${id}`, "HEAD");
  const liveHome = await cms.get("home");
  for (const [k, v] of Object.entries(afterHoursPresentation))
    assert.deepEqual(current?.[k], v);
  for (const [k, v] of Object.entries(homePresentation))
    assert.deepEqual(liveHome?.data[k], v);
  console.log("Published presentation verified; auction remains unscheduled.");
}

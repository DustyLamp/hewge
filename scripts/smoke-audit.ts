// Writes one permanent operational health-check event; no customer data or deletion attempts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { auditLedger } from "../services/audit";
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
const s3 = new S3Client({ region }),
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const ledger = auditLedger(db, s3, out.AuditTableName, out.AuditBucketName);
await ledger.commit([], {
  entity: "system:archive-protection",
  actor: "deployment-check",
  action: "archive-protection-check",
  details: { purpose: "Operational health check; no business mutation" },
});
const history = await ledger.history(
  "system:archive-protection",
  undefined,
  true,
);
assert.equal(history.verification?.complete, true);
const event = history.events[0],
  Key = `events/${event.id}/committed.json`;
const object = await s3.send(
    new GetObjectCommand({ Bucket: out.AuditBucketName, Key }),
  ),
  Body = await object.Body!.transformToString();
const request = {
  Bucket: out.AuditBucketName,
  Key,
  Body,
  ContentType: "application/json",
  ObjectLockMode: "COMPLIANCE" as const,
  ObjectLockLegalHoldStatus: "ON" as const,
  ObjectLockRetainUntilDate: object.ObjectLockRetainUntilDate,
  ChecksumSHA256: createHash("sha256").update(Body).digest("base64"),
};
// Use identical bytes: even an unexpected permission defect cannot alter the event contents.
await assert.rejects(
  s3.send(new PutObjectCommand(request)),
  (e: any) => e.$metadata?.httpStatusCode === 403,
);
await assert.rejects(
  s3.send(new PutObjectCommand({ ...request, IfNoneMatch: "*" })),
  (e: any) => e.$metadata?.httpStatusCode === 412,
);
const unchanged = await s3.send(
  new GetObjectCommand({ Bucket: out.AuditBucketName, Key }),
);
assert.equal(await unchanged.Body!.transformToString(), Body);
assert.equal(unchanged.ObjectLockMode, "COMPLIANCE");
assert.equal(unchanged.ObjectLockLegalHoldStatus, "ON");
console.log(
  "PASS: protected audit commit and verification; unconditional replacement denied, conditional replacement rejected, original receipt unchanged.",
);

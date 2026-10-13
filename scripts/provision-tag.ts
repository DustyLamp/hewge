// Register already-programmed tag keys. This never programs hardware or activates a tag.
// Keys must be in an owner-readable JSON file outside the repository, never CLI arguments.
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { KMSClient, EncryptCommand } from "@aws-sdk/client-kms";
import { auditLedger, digest } from "../services/audit";
if (process.env.AWS_PROFILE !== "hewge") throw Error("Use AWS_PROFILE=hewge.");
const region = "eu-north-1",
  args = Object.fromEntries(
    Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
      process.argv[2 + i * 2],
      process.argv[3 + i * 2],
    ]),
  );
const pieceId = args["--piece"],
  uid = String(args["--uid"] || "").toLowerCase(),
  keysPath = args["--keys"],
  id = args["--tag"] || randomUUID();
if (
  !/^[a-z0-9-]{1,80}$/.test(pieceId || "") ||
  !/^04[a-f\d]{12}$/.test(uid) ||
  !keysPath ||
  !/^[a-f\d-]{36}$/.test(id)
)
  throw Error(
    "Required: --piece ID --uid UID --keys /private/keys.json --tag UUID (same UUID programmed in NDEF).",
  );
if ((await stat(keysPath)).mode & 0o077)
  throw Error("Keys file must be readable only by its owner (chmod 600).");
const keys = JSON.parse(await readFile(keysPath, "utf8"));
if (
  !["meta", "file"].every(
    (k) => /^[a-f\d]{32}$/i.test(keys[k]) && !/^0+$/.test(keys[k]),
  ) ||
  keys.meta.toLowerCase() === keys.file.toLowerCase()
)
  throw Error("Use distinct random non-default AES-128 meta and file keys.");
const stack = (
  await new CloudFormationClient({ region }).send(
    new DescribeStacksCommand({ StackName: "hewge-production" }),
  )
).Stacks![0];
if (stack.StackId!.split(":")[4] !== "082229154968")
  throw Error("Unexpected AWS account.");
const out = Object.fromEntries(
  stack.Outputs!.map((o) => [o.OutputKey!, o.OutputValue!]),
);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
  table = out.AuctionTableName;
const piece = (
  await db.send(
    new GetCommand({
      TableName: table,
      Key: { pk: `AUCTION#${pieceId}`, sk: "HEAD" },
      ConsistentRead: true,
    }),
  )
).Item;
if (!piece) throw Error("Create the piece in the studio first.");
const enc = await new KMSClient({ region }).send(
  new EncryptCommand({
    KeyId: out.NfcKeyArn,
    Plaintext: Buffer.from(
      JSON.stringify({ meta: keys.meta, file: keys.file }),
    ),
    EncryptionContext: { tagId: id, pieceId },
  }),
);
await auditLedger(
  db,
  new S3Client({ region }),
  out.AuditTableName,
  out.AuditBucketName,
).commit(
  [
    {
      Put: {
        TableName: table,
        Item: {
          pk: `TAG#${id}`,
          sk: "HEAD",
          id,
          uid,
          pieceId,
          status: "provisioned",
          keyCiphertext: Buffer.from(enc.CiphertextBlob!).toString("base64"),
          provisionedAt: Date.now(),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
    {
      Put: {
        TableName: table,
        Item: { pk: `TAG_UID#${digest(uid)}`, sk: "HEAD", tagId: id, pieceId },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
  ],
  {
    entity: `piece:${pieceId}`,
    actor: "authorised-tag-provisioner",
    action: "tag-keys-registered",
    details: { tagId: id, uidHash: digest(uid) },
  },
);
console.log(
  JSON.stringify({
    tagId: id,
    status: "provisioned",
    next: "Commission with a fresh tap and physical inspection in the studio, or use the reviewed recovery case.",
  }),
);

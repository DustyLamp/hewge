import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
const region = "eu-north-1";
const result = await new CloudFormationClient({ region }).send(
  new DescribeStacksCommand({ StackName: "hewge-production" }),
);
const outputs = Object.fromEntries(
  result.Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]),
);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const existing = process.argv[2];
const email = existing || `hewge-smoke-${randomUUID()}@example.invalid`;
assert(
  email.endsWith("@example.invalid"),
  "Only disposable test addresses are allowed.",
);
const pk = `EMAIL#${createHash("sha256").update(email).digest("hex")}`;
const read = () =>
  db.send(
    new GetCommand({
      TableName: outputs.DataTableName,
      Key: { pk },
      ConsistentRead: true,
    }),
  );
async function post(path, body, origin = "https://hewge.design") {
  const r = await fetch(`${outputs.ApiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const catalog = await fetch(`${outputs.ApiUrl}/catalog`).then((r) => r.json());
assert.equal(catalog.price, 33900);
assert.equal(catalog.currency, "chf");
console.log(`Catalog: CHF 339, ${catalog.status}`);
try {
  if (!existing)
    assert.equal(
      (await post("/waitlist", { email, consent: true, sizes: ["M", "XL"] }))
        .status,
      200,
    );
  const saved = (await read()).Item;
  assert.equal(saved.email, email);
  assert.equal(saved.consentVersion, "release-v2");
  assert(saved.expiresAt > Date.now() / 1000);
  console.log("Live signup persisted with consent and expiry.");
} finally {
  assert.equal((await post("/waitlist/remove", { email })).status, 200);
  assert.equal((await read()).Item, undefined);
  console.log("Test signup removed and deletion verified.");
}
assert.equal(
  (
    await post(
      "/waitlist",
      { email, consent: true, sizes: ["M", "XL"] },
      "https://untrusted.example",
    )
  ).status,
  403,
);
console.log("Unexpected origin rejected.");
if (catalog.status === "coming-soon") {
  assert.equal(
    (await post("/checkout", { productId: catalog.id })).status,
    409,
  );
  console.log("Payments remain disabled before launch.");
}

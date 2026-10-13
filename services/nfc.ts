import { createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { digest, type Commit } from "./audit";
// NIST SP 800-38B AES-CMAC, tested against RFC 4493 and NXP AN12196.
export function cmac(key: Buffer, message: Buffer) {
  const aes = (block: Buffer) => {
    const c = createCipheriv("aes-128-ecb", key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(block), c.final()]);
  };
  const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((n, i) => n ^ b[i]));
  const sub = (b: Buffer) => {
    const out = Buffer.alloc(16);
    let carry = 0;
    for (let i = 15; i >= 0; i--) {
      out[i] = ((b[i] << 1) & 255) | carry;
      carry = b[i] >>> 7;
    }
    if (carry) out[15] ^= 0x87;
    return out;
  };
  const k1 = sub(aes(Buffer.alloc(16))),
    k2 = sub(k1),
    blocks = Math.max(1, Math.ceil(message.length / 16));
  let x = Buffer.alloc(16);
  for (let i = 0; i < blocks - 1; i++)
    x = aes(xor(x, message.subarray(i * 16, i * 16 + 16)));
  let last = Buffer.alloc(16);
  message.subarray((blocks - 1) * 16).copy(last);
  if (message.length && message.length % 16 === 0) last = xor(last, k1);
  else {
    last[message.length % 16] = 0x80;
    last = xor(last, k2);
  }
  return aes(xor(x, last));
}
export function verifySun(
  encrypted: string,
  mac: string,
  metaKey: Buffer,
  fileKey: Buffer,
  expectedUid: string,
) {
  if (
    !/^[a-f\d]{32}$/i.test(encrypted) ||
    !/^[a-f\d]{16}$/i.test(mac) ||
    metaKey.length !== 16 ||
    fileKey.length !== 16
  )
    throw Error("Invalid NFC message");
  const d = createDecipheriv("aes-128-cbc", metaKey, Buffer.alloc(16));
  d.setAutoPadding(false);
  const plain = Buffer.concat([
    d.update(Buffer.from(encrypted, "hex")),
    d.final(),
  ]);
  if (
    plain[0] !== 0xc7 ||
    plain.subarray(1, 8).toString("hex") !== expectedUid.toLowerCase()
  )
    throw Error("Tag mismatch");
  const session = cmac(
    fileKey,
    Buffer.concat([Buffer.from("3cc300010080", "hex"), plain.subarray(1, 11)]),
  );
  const full = cmac(session, Buffer.alloc(0));
  const truncated = Buffer.from(
    [1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]),
  );
  if (!timingSafeEqual(truncated, Buffer.from(mac, "hex")))
    throw Error("Invalid tag proof");
  return { counter: plain.readUIntLE(8, 3) };
}
export function nfcVerifier(
  db: DynamoDBDocumentClient,
  kms: KMSClient,
  table: string,
  commit?: Commit,
) {
  const read = async (pk: string) =>
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk, sk: "HEAD" },
          ConsistentRead: true,
        }),
      )
    ).Item;
  async function proof(tag: any, body: any) {
    const decrypted = await kms.send(
      new DecryptCommand({
        KeyId: process.env.NFC_KEY_ID,
        CiphertextBlob: Buffer.from(tag.keyCiphertext, "base64"),
        EncryptionContext: { tagId: tag.id, pieceId: tag.pieceId },
      }),
    );
    try {
      const keys = JSON.parse(Buffer.from(decrypted.Plaintext!).toString());
      return verifySun(
        body.e,
        body.c,
        Buffer.from(keys.meta, "hex"),
        Buffer.from(keys.file, "hex"),
        tag.uid,
      );
    } catch {
      throw Object.assign(Error("The tag proof could not be verified."), {
        status: 400,
      });
    } finally {
      decrypted.Plaintext?.fill(0);
    }
  }
  async function activate(body: any, user: { id: string }) {
    const tag = await read(`TAG#${String(body.tagId || "")}`),
      piece = tag && (await read(`AUCTION#${tag.pieceId}`));
    if (
      !commit ||
      !tag ||
      tag.status !== "provisioned" ||
      !piece ||
      piece.status !== "sold" ||
      piece.fulfillment?.shippedAt ||
      piece.pendingTransferId ||
      piece.verificationHold ||
      (piece.tagIds || []).length >= 2
    )
      throw Object.assign(
        Error(
          "Initial tags must be commissioned before dispatch. Use a recovery case to replace a dispatched tag.",
        ),
        { status: 409 },
      );
    if (
      body.physicalChecked !== true ||
      body.artistSigned !== true ||
      String(body.evidence || "").trim().length < 20
    )
      throw Object.assign(
        Error(
          "Record physical inspection and the artist-signed certificate reference.",
        ),
        { status: 400 },
      );
    const result = await proof(tag, body);
    await commit(
      [
        {
          Update: {
            TableName: table,
            Key: { pk: tag.pk, sk: "HEAD" },
            UpdateExpression:
              "SET #s=:active, lastCounter=:counter, commissionedAt=:now",
            ConditionExpression: "#s=:provisioned",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":active": "active",
              ":provisioned": "provisioned",
              ":counter": result.counter,
              ":now": Date.now(),
            },
          },
        },
        {
          Update: {
            TableName: table,
            Key: { pk: piece.pk, sk: "HEAD" },
            UpdateExpression: "SET tagIds=:tags",
            ConditionExpression:
              "ownerId=:owner AND (attribute_not_exists(fulfillment.shippedAt) OR fulfillment.shippedAt=:nil) AND attribute_not_exists(recoveryId) AND attribute_not_exists(pendingTransferId) AND " +
              (piece.tagIds ? "tagIds=:old" : "attribute_not_exists(tagIds)"),
            ExpressionAttributeValues: {
              ":owner": piece.ownerId,
              ":nil": null,
              ":tags": [...(piece.tagIds || []), tag.id],
              ...(piece.tagIds ? { ":old": piece.tagIds } : {}),
            },
          },
        },
      ],
      {
        entity: `piece:${piece.id}`,
        actor: user.id,
        action: "secure-tag-commissioned",
        details: {
          tagId: tag.id,
          evidenceHash: digest(String(body.evidence).trim()),
        },
      },
    );
    return { ok: true };
  }
  async function verify(body: any) {
    if (process.env.NFC_ENABLED !== "true")
      throw Object.assign(
        Error(
          "Secure tag verification is awaiting physical-tag commissioning. Use the register or contact Hewge.",
        ),
        { status: 409 },
      );
    const id = String(body.tag || "");
    if (!/^[a-f\d-]{36}$/.test(id))
      throw Object.assign(Error("Tag not recognised."), { status: 400 });
    const tag = (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk: `TAG#${id}`, sk: "HEAD" },
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (!tag || tag.status !== "active")
      throw Object.assign(Error("This tag is not active. Contact Hewge."), {
        status: 409,
      });
    const piece = (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk: `AUCTION#${tag.pieceId}`, sk: "HEAD" },
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (!piece || piece.verificationHold || !(piece.tagIds || []).includes(id))
      throw Object.assign(Error("This piece requires a Hewge inspection."), {
        status: 409,
      });
    const result = await proof({ ...tag, id }, body);
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table,
                Key: { pk: tag.pk, sk: "HEAD" },
                UpdateExpression: "SET lastCounter=:c, lastVerifiedAt=:at",
                ConditionExpression:
                  "#s=:active AND (attribute_not_exists(lastCounter) OR lastCounter<:c)",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                  ":c": result.counter,
                  ":at": Date.now(),
                  ":active": "active",
                },
              },
            },
            {
              ConditionCheck: {
                TableName: table,
                Key: { pk: piece.pk, sk: "HEAD" },
                ConditionExpression:
                  "contains(tagIds,:tag) AND (attribute_not_exists(verificationHold) OR verificationHold=:no)",
                ExpressionAttributeValues: { ":tag": id, ":no": false },
              },
            },
          ],
        }),
      );
    } catch (e: any) {
      if (e.name === "TransactionCanceledException")
        throw Object.assign(
          Error(
            "This proof is no longer usable. Tap the garment again; contact Hewge if verification remains unavailable.",
          ),
          { status: 409 },
        );
      throw e;
    }
    return {
      tagVerified: true,
      pieceId: tag.pieceId,
      verifiedAt: Date.now(),
      message:
        "A fresh proof from the registered tag was verified. This verifies the chip, not legal ownership or the surrounding garment.",
    };
  }
  return { verify, activate, proof };
}

import { randomUUID, createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { publicRelease } from "../shared/auction";
import type { Commit } from "./audit";
const fail = (m: string, status = 400): never => {
  throw Object.assign(Error(m), { status });
};
export const imageType = (b: Uint8Array) => {
  const x = Buffer.from(b);
  if (
    x.length > 24 &&
    x.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return "image/png";
  if (x.length > 12 && x[0] === 0xff && x[1] === 0xd8 && x[2] === 0xff)
    return "image/jpeg";
  if (
    x.length > 20 &&
    x.toString("ascii", 0, 4) === "RIFF" &&
    x.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
};
export function mediaLibrary(
  db: DynamoDBDocumentClient,
  s3: S3Client,
  table: string,
  bucket: string,
  commit: Commit,
) {
  const get = async (pk: string, sk = "HEAD") =>
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk, sk },
          ConsistentRead: true,
        }),
      )
    ).Item;
  const url = (id: string) => `${process.env.MEDIA_API_URL}/media/${id}`;
  async function handle(path: string, body: any, user: { id: string }) {
    if (path === "/admin/media/upload") {
      if (
        !/^[a-z0-9-]{1,80}$/.test(body.releaseId || "") ||
        !["image/jpeg", "image/png", "image/webp"].includes(body.contentType) ||
        !Number.isSafeInteger(body.size) ||
        body.size < 32 ||
        body.size > 12 * 1024 * 1024 ||
        !["artwork", "evidence"].includes(body.kind)
      )
        return fail("Choose a JPEG, PNG or WebP under 12 MB and a release ID.");
      const id = randomUUID();
      await commit(
        [
          {
            Put: {
              TableName: table,
              Item: {
                pk: `MEDIA#${id}`,
                sk: "HEAD",
                id,
                releaseId: body.releaseId,
                kind: body.kind,
                name: String(body.name || "Image").slice(0, 120),
                contentType: body.contentType,
                size: body.size,
                status: "uploading",
                createdAt: Date.now(),
                createdBy: user.id,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
        {
          entity: `release:${body.releaseId}`,
          actor: user.id,
          action: "media-upload-authorised",
          details: { id, kind: body.kind },
        },
      );
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: bucket,
          Key: `staging/${id}`,
          ContentType: body.contentType,
          ContentLength: body.size,
          IfNoneMatch: "*",
        }),
        {
          expiresIn: 300,
          signableHeaders: new Set([
            "content-type",
            "content-length",
            "if-none-match",
          ]),
        },
      );
      return { id, uploadUrl };
    }
    const id = String(body.id || "");
    if (!/^[a-f0-9-]{36}$/.test(id)) return fail("Invalid media ID.");
    const record = await get(`MEDIA#${id}`);
    if (!record) return fail("Image not found.", 404);
    if (path === "/admin/media/read")
      return {
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: `media/${id}` }),
          { expiresIn: 300 },
        ),
      };
    if (path !== "/admin/media/complete") return fail("Unknown media action.");
    if (record.status === "ready") return { id, image: url(id) };
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: `staging/${id}` }),
    );
    if (
      head.ContentLength !== record.size ||
      head.ContentLength! > 12 * 1024 * 1024
    )
      return fail("Upload size does not match.");
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `staging/${id}`,
        IfMatch: head.ETag,
      }),
    );
    const bytes = await object.Body!.transformToByteArray();
    if (imageType(bytes) !== record.contentType)
      return fail("Image contents do not match the selected format.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `media/${id}`,
          Body: bytes,
          ContentType: record.contentType,
          IfNoneMatch: "*",
          ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
        }),
      );
    } catch (e: any) {
      if (e.$metadata?.httpStatusCode !== 412) throw e;
      const existing = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: `media/${id}` }),
      );
      if (
        createHash("sha256")
          .update(await existing.Body!.transformToByteArray())
          .digest("hex") !== sha256
      )
        throw Error("Media integrity mismatch");
    }
    await commit(
      [
        {
          Update: {
            TableName: table,
            Key: { pk: record.pk, sk: "HEAD" },
            UpdateExpression: "SET #s=:ready, sha256=:hash, gpk=:g, gsk=:id",
            ConditionExpression: "#s=:upload",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":ready": "ready",
              ":upload": "uploading",
              ":hash": sha256,
              ":g": "MEDIA",
              ":id": id,
            },
          },
        },
      ],
      {
        entity: `release:${record.releaseId}`,
        actor: user.id,
        action: "media-upload-completed",
        details: { id, sha256, kind: record.kind },
      },
    );
    return { id, image: url(id) };
  }
  async function publicImage(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return fail("Image not found.", 404);
    const record = await get(`MEDIA#${id}`);
    if (!record || record.kind !== "artwork" || record.status !== "ready")
      return fail("Image not found.", 404);
    const release = await get(`AUCTION#${record.releaseId}`);
    if (
      !release?.published ||
      publicRelease(release).designHidden ||
      release.image !== url(id)
    )
      return fail("Image not found.", 404);
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: `media/${id}` }),
      { expiresIn: 60 },
    );
  }
  async function validateImage(image: string, releaseId: string) {
    if (/^\/images\/[a-zA-Z0-9._-]+\.(webp|png|jpg|jpeg)$/.test(image)) return;
    const prefix = `${process.env.MEDIA_API_URL}/media/`;
    if (!image.startsWith(prefix))
      return fail("Select an image from the media library.");
    const record = await get(`MEDIA#${image.slice(prefix.length)}`);
    if (
      !record ||
      record.kind !== "artwork" ||
      record.status !== "ready" ||
      record.releaseId !== releaseId
    )
      return fail("Select artwork uploaded for this release.");
  }
  return { handle, publicImage, validateImage };
}

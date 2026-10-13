import { randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { cleanPage, type ContentPage } from "../shared/content";
import { canonical, digest, type Commit, type Changes } from "./audit";

export function contentService(
  db: DynamoDBDocumentClient,
  s3: S3Client,
  table: string,
  bucket: string,
  commit: Commit,
  validateImage: (image: string, releaseId: string) => Promise<void>,
) {
  async function get(id: string, state = "LIVE") {
    if (!/^[a-z0-9-]{1,80}$/.test(id)) return null;
    const r = await db.send(
      new GetCommand({
        TableName: table,
        Key: { pk: "CMS", sk: `${state}#${id}` },
        ConsistentRead: true,
      }),
    );
    if (!r.Item) return null;
    const { revision, data, updatedAt, publishedAt } = r.Item;
    return { id, revision, data, updatedAt, publishedAt } as ContentPage;
  }
  async function list() {
    let cursor;
    const pages: any[] = [];
    do {
      const r: any = await db.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk=:p",
          ExpressionAttributeValues: { ":p": "CMS" },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      pages.push(...(r.Items || []));
      cursor = r.LastEvaluatedKey;
    } while (cursor);
    return pages;
  }
  async function save(body: any, user: { id: string }) {
    const id = String(body.id || "");
    const data = cleanPage(id, body.data);
    if (
      !["draft", "publish", "unpublish"].includes(body.action) ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0
    )
      throw Object.assign(Error("Refresh this page before saving."), {
        status: 400,
      });
    if (id === "home" && body.action === "unpublish")
      throw Object.assign(Error("Publish a replacement homepage instead."), {
        status: 400,
      });
    const image = id === "home" ? data.guestImage : data.image;
    if (image) await validateImage(image, `page-${id}`);
    const old = await get(id, "DRAFT");
    if ((old?.revision || 0) !== body.revision)
      throw Object.assign(
        Error("Someone saved a newer version. Reload before editing."),
        { status: 409 },
      );
    const now = Date.now(),
      revision = body.revision + 1;
    const snapshot = { id, revision, data, updatedAt: now, updatedBy: user.id };
    const snapshotKey = `content/${id}/${revision}-${randomUUID()}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: snapshotKey,
        Body: canonical(snapshot),
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
    );
    const changes: Changes = [
      {
        Put: {
          TableName: table,
          Item: { pk: "CMS", sk: `DRAFT#${id}`, ...snapshot, snapshotKey },
          ConditionExpression: old ? "revision=:r" : "attribute_not_exists(pk)",
          ...(old
            ? { ExpressionAttributeValues: { ":r": body.revision } }
            : {}),
        },
      },
    ];
    if (body.action === "publish") {
      if (id === "home")
        changes.push({
          ConditionCheck: {
            TableName: table,
            Key: { pk: `AUCTION#${data.featuredReleaseId}`, sk: "HEAD" },
            ConditionExpression: "published=:yes",
            ExpressionAttributeValues: { ":yes": true },
          },
        });
      changes.push({
        Put: {
          TableName: table,
          Item: {
            pk: "CMS",
            sk: `LIVE#${id}`,
            ...snapshot,
            snapshotKey,
            publishedAt: now,
          },
        },
      });
    }
    if (body.action === "unpublish")
      changes.push({
        Delete: { TableName: table, Key: { pk: "CMS", sk: `LIVE#${id}` } },
      });
    await commit(changes, {
      entity: `page:${id}`,
      actor: user.id,
      action: `page-${body.action}`,
      details: { revision, snapshotKey, contentHash: digest(data) },
    });
    return { ok: true, revision };
  }
  async function snapshotRelease(item: Record<string, any>) {
    const snapshotKey = `content/releases/${item.id}/${item.revision}-${randomUUID()}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: snapshotKey,
        Body: canonical(item),
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
    );
    return { snapshotKey, contentHash: digest(item) };
  }
  return { get, list, save, snapshotRelease };
}

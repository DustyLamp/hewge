import { createHash, randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  DeleteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
export type Changes = NonNullable<TransactWriteCommandInput["TransactItems"]>;
export type AuditMeta = {
  entity: string;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
};
export type Commit = (
  changes: Changes,
  meta: AuditMeta,
  options?: { notAfter?: number },
) => Promise<void>;
export function canonical(value: any): string {
  if (Array.isArray(value))
    return `[${value.map((v) => canonical(v ?? null)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: any) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
export function auditLedger(
  db: DynamoDBDocumentClient,
  s3: S3Client,
  table: string,
  bucket: string,
) {
  const get = async (pk: string, sk: string) =>
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk, sk },
          ConsistentRead: true,
        }),
      )
    ).Item;
  async function locked(key: string, value: unknown) {
    const body = canonical(value);
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
          ObjectLockLegalHoldStatus: "ON",
          ObjectLockMode: "COMPLIANCE",
          ObjectLockRetainUntilDate: new Date(Date.now() + 36500 * 86400000),
          IfNoneMatch: "*",
          ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
        }),
      );
    } catch (e: any) {
      if (
        e.name !== "PreconditionFailed" &&
        e.$metadata?.httpStatusCode !== 412
      )
        throw e;
      const old = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (
        old.ObjectLockMode !== "COMPLIANCE" ||
        old.ObjectLockLegalHoldStatus !== "ON" ||
        !old.ObjectLockRetainUntilDate ||
        old.ObjectLockRetainUntilDate.getTime() <= Date.now()
      )
        throw Error("Audit archive protection failure");
      if ((await old.Body?.transformToString()) !== body)
        throw Error("Audit archive integrity failure");
    }
  }
  async function seal(event: any) {
    const { pk, sk, ...record } = event;
    await locked(`events/${record.id}/committed.json`, record);
    await db.send(
      new DeleteCommand({
        TableName: table,
        Key: { pk: "OUTBOX", sk: record.id },
      }),
    );
  }
  const commit: Commit = async (changes, meta, options) => {
    if (!table || !bucket) throw Error("Audit storage is not configured");
    const pk = `ENTITY#${meta.entity}`;
    const head = await get(pk, "HEAD");
    const id = randomUUID(),
      sequence = (head?.sequence || 0) + 1;
    const record = {
      id,
      entity: meta.entity,
      action: meta.action,
      actor: digest(meta.actor),
      details: meta.details || {},
      sequence,
      previousHash: head?.hash || null,
      at: Date.now(),
      changeHash: digest(changes),
    };
    const event = { ...record, hash: digest(record) };
    // A durable immutable intent exists before a business mutation is attempted.
    // Only committed.json or the transactional ledger proves that it committed.
    await locked(`events/${id}/intent.json`, event);
    // Recheck after potentially slow archive I/O, immediately before submitting
    // the conditional transaction. Wall time is a deadline check, not an order.
    if (options?.notAfter !== undefined && Date.now() >= options.notAfter)
      throw Object.assign(
        Error("This auction closed before the bid could be recorded."),
        { status: 409 },
      );
    await db.send(
      new TransactWriteCommand({
        ClientRequestToken: id,
        TransactItems: [
          ...changes,
          {
            Put: {
              TableName: table,
              Item: {
                pk,
                sk: "HEAD",
                sequence,
                hash: event.hash,
                at: event.at,
              },
              ConditionExpression: head
                ? "#seq=:previous"
                : "attribute_not_exists(pk)",
              ...(head
                ? {
                    ExpressionAttributeNames: { "#seq": "sequence" },
                    ExpressionAttributeValues: { ":previous": head.sequence },
                  }
                : {}),
            },
          },
          {
            Put: {
              TableName: table,
              Item: {
                pk,
                sk: `EVENT#${String(sequence).padStart(12, "0")}`,
                ...event,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: table,
              Item: {
                pk: "OUTBOX",
                sk: id,
                entityPk: pk,
                eventSk: `EVENT#${String(sequence).padStart(12, "0")}`,
                at: event.at,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
    // A failed archive confirmation is not a rollback. Durable outbox retries it;
    // the caller gets an explicit reconciliation response, never a false success.
    try {
      await seal({ pk, sk: "", ...event });
    } catch {
      throw Object.assign(
        Error(
          "The change was recorded; its protected audit receipt is awaiting confirmation. Refresh before retrying.",
        ),
        { status: 503 },
      );
    }
  };
  async function drain() {
    const pending = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk=:p",
        ExpressionAttributeValues: { ":p": "OUTBOX" },
        ConsistentRead: true,
        Limit: 40,
      }),
    );
    for (const item of pending.Items || []) {
      const record = await get(item.entityPk, item.eventSk);
      if (!record) throw Error("Audit outbox has no committed event");
      await seal(record);
    }
    console.log(
      JSON.stringify({
        event: "audit_archive",
        pending: pending.Items?.length || 0,
      }),
    );
  }
  async function history(entity: string, cursor?: string, verify = false) {
    const pk = `ENTITY#${entity}`;
    if (entity.length > 160 || (cursor && !/^EVENT#\d{12}$/.test(cursor)))
      throw Object.assign(Error("Invalid audit query"), { status: 400 });
    const rows = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk=:p AND begins_with(sk,:e)",
        ExpressionAttributeValues: { ":p": pk, ":e": "EVENT#" },
        ConsistentRead: true,
        Limit: 100,
        ScanIndexForward: false,
        ...(cursor ? { ExclusiveStartKey: { pk, sk: cursor } } : {}),
      }),
    );
    const pending = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk=:p",
        ExpressionAttributeValues: { ":p": "OUTBOX" },
        ConsistentRead: true,
        Select: "COUNT",
        Limit: 100,
      }),
    );
    let verification;
    if (verify) {
      const anchor = await get(pk, cursor || "HEAD");
      let expectedHash = cursor ? anchor?.previousHash : anchor?.hash;
      let expectedSequence = (anchor?.sequence || 0) - (cursor ? 1 : 0);
      const events = rows.Items || [];
      for (const event of events) {
        const { pk: _pk, sk: _sk, hash, ...record } = event;
        if (
          event.sequence !== expectedSequence ||
          hash !== expectedHash ||
          hash !== digest(record)
        )
          throw Object.assign(
            Error(
              "Audit chain mismatch. Preserve the records and investigate.",
            ),
            { status: 409 },
          );
        expectedHash = event.previousHash;
        expectedSequence--;
      }
      if (
        !rows.LastEvaluatedKey &&
        (expectedSequence !== 0 || expectedHash != null)
      )
        throw Object.assign(Error("Audit chain is incomplete."), {
          status: 409,
        });
      let receipts = 0;
      await Promise.all(
        events.map(async (event) => {
          const { pk: _pk, sk: _sk, ...record } = event;
          for (const kind of ["intent", "committed"]) {
            try {
              const archived = await s3.send(
                new GetObjectCommand({
                  Bucket: bucket,
                  Key: `events/${event.id}/${kind}.json`,
                }),
              );
              if (
                archived.ObjectLockMode !== "COMPLIANCE" ||
                archived.ObjectLockLegalHoldStatus !== "ON" ||
                !archived.ObjectLockRetainUntilDate ||
                archived.ObjectLockRetainUntilDate.getTime() <= Date.now()
              )
                throw Error("Archive protection missing");
              if (
                (await archived.Body?.transformToString()) !== canonical(record)
              )
                throw Error("Protected archive mismatch");
              if (kind === "committed") receipts++;
            } catch (e: any) {
              if (kind === "committed" && e.name === "NoSuchKey") continue;
              throw Object.assign(
                Error(
                  "Protected archive verification failed. Preserve the records and investigate.",
                ),
                { status: 409 },
              );
            }
          }
        }),
      );
      verification = {
        events: events.length,
        archivedReceipts: receipts,
        complete: receipts === events.length,
      };
    }
    return {
      events: rows.Items || [],
      cursor: rows.LastEvaluatedKey?.sk || null,
      verification,
      pendingReceipts: pending.Count || 0,
      retentionDays: Number(process.env.AUDIT_RETENTION_DAYS || 0),
    };
  }
  return { commit, drain, history };
}

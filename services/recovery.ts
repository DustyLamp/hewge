import { randomUUID } from "node:crypto";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { digest, type Changes, type Commit } from "./audit";
const clean = (v: unknown, max = 1000) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const fail = (m: string, s = 409): never => {
  throw Object.assign(Error(m), { status: s });
};
export function recoveryService(
  db: DynamoDBDocumentClient,
  table: string,
  commit: Commit,
  verifyTag?: (tag: any, body: any) => Promise<{ counter: number }>,
) {
  const get = async (pk: string) =>
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk, sk: "HEAD" },
          ConsistentRead: true,
        }),
      )
    ).Item;
  async function handle(
    path: string,
    body: any,
    user: { id: string; email: string; admin: boolean },
  ) {
    if (path === "/recovery/request") {
      const piece = await get(`AUCTION#${clean(body.id, 80)}`);
      if (piece?.status !== "sold" || piece.ownerId !== user.id)
        return fail("Only the registered owner can open a recovery case.", 403);
      if (piece.recoveryId || piece.pendingTransferId)
        return fail("Resolve the current recovery or transfer first.");
      if (
        ![
          "damaged-tag",
          "lost-certificate",
          "suspected-theft",
          "other",
        ].includes(body.reason) ||
        clean(body.evidence).length < 20
      )
        return fail(
          "Select a reason and describe your supporting evidence.",
          400,
        );
      const id = randomUUID();
      await commit(
        [
          {
            Update: {
              TableName: table,
              Key: { pk: piece.pk, sk: "HEAD" },
              UpdateExpression: "SET recoveryId=:r, verificationHold=:yes",
              ConditionExpression:
                "ownerId=:owner AND attribute_not_exists(recoveryId) AND attribute_not_exists(pendingTransferId)",
              ExpressionAttributeValues: {
                ":r": id,
                ":yes": true,
                ":owner": user.id,
              },
            },
          },
          {
            Put: {
              TableName: table,
              Item: {
                pk: `RECOVERY#${id}`,
                sk: "HEAD",
                id,
                pieceId: piece.id,
                name: piece.name,
                ownerId: user.id,
                reason: body.reason,
                evidence: clean(body.evidence),
                status: "awaiting-review",
                createdAt: Date.now(),
                revision: 1,
                gpk: "RECOVERIES",
                gsk: id,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
        {
          entity: `piece:${piece.id}`,
          actor: user.id,
          action: "recovery-requested",
          details: {
            caseId: id,
            reason: body.reason,
            evidenceHash: digest(clean(body.evidence)),
          },
        },
      );
      return { ok: true, id };
    }
    if (!user.admin || path !== "/admin/recovery")
      return fail("Owner access required.", 403);
    const r = await get(`RECOVERY#${clean(body.caseId, 80)}`),
      piece = r && (await get(`AUCTION#${r.pieceId}`));
    if (
      !r ||
      !piece ||
      r.status !== "awaiting-review" ||
      piece.recoveryId !== r.id ||
      piece.ownerId !== r.ownerId
    )
      return fail("Recovery case changed.");
    const evidence = clean(body.evidence);
    if (
      evidence.length < 20 ||
      body.physicalChecked !== true ||
      body.titleChecked !== true
    )
      return fail(
        "Record physical inspection and ownership evidence. A backup identifier alone is not sufficient.",
        400,
      );
    const resolve = body.action === "resolve";
    if (!resolve && body.action !== "reject")
      return fail("Choose resolve or reject.", 400);
    const updates: Changes = [];
    const oldTags: string[] = piece.tagIds || [];
    const newTag = clean(body.newTagId, 80);
    if (resolve && newTag) {
      const tag = await get(`TAG#${newTag}`);
      if (!tag || tag.pieceId !== piece.id || tag.status !== "provisioned")
        return fail(
          "The replacement tag must be securely provisioned for this piece first.",
        );
      if (!verifyTag) return fail("Tag verification is not configured.");
      const proof = await verifyTag(tag, body);
      updates.push({
        Update: {
          TableName: table,
          Key: { pk: tag.pk, sk: "HEAD" },
          UpdateExpression: "SET #s=:active, lastCounter=:counter",
          ConditionExpression: "#s=:provisioned",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":active": "active",
            ":provisioned": "provisioned",
            ":counter": proof.counter,
          },
        },
      });
      for (const id of oldTags)
        updates.push({
          Update: {
            TableName: table,
            Key: { pk: `TAG#${id}`, sk: "HEAD" },
            UpdateExpression: "SET #s=:revoked, revokedAt=:now",
            ConditionExpression: "pieceId=:id",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":revoked": "revoked",
              ":now": Date.now(),
              ":id": piece.id,
            },
          },
        });
    }
    if (resolve && r.reason === "damaged-tag" && oldTags.length && !newTag)
      return fail(
        "Provision a replacement tag before resolving a damaged tag.",
      );
    const newSeal = clean(body.newSeal, 80);
    if (resolve && !newSeal && !newTag && r.reason === "damaged-tag")
      return fail("Record the replacement identifier.");
    if (
      resolve &&
      body.reissueCertificate === true &&
      body.artistSigned !== true
    )
      return fail("The artist must sign the replacement certificate.");
    const certificateRevision =
      (piece.certificateRevision || 1) +
      (resolve && body.reissueCertificate === true ? 1 : 0);
    updates.push({
      Update: {
        TableName: table,
        Key: { pk: piece.pk, sk: "HEAD" },
        UpdateExpression: resolve
          ? "SET verificationHold=:hold, tagIds=:tags, fulfillment=:f, certificateRevision=:cv REMOVE recoveryId"
          : "SET verificationHold=:hold REMOVE recoveryId",
        ConditionExpression: "ownerId=:owner AND recoveryId=:r",
        ExpressionAttributeValues: {
          ":owner": r.ownerId,
          ":r": r.id,
          ":hold": !resolve,
          ...(resolve
            ? {
                ":tags": newTag ? [newTag] : oldTags,
                ":f": {
                  ...piece.fulfillment,
                  ...(newSeal ? { hologramId: newSeal } : {}),
                },
                ":cv": certificateRevision,
              }
            : {}),
        },
      },
    });
    updates.push({
      Update: {
        TableName: table,
        Key: { pk: r.pk, sk: "HEAD" },
        UpdateExpression:
          "SET #s=:s, reviewedAt=:at, reviewedBy=:by, reviewEvidence=:e, replacementTag=:tag, certificateRevision=:cv ADD revision :one",
        ConditionExpression: "revision=:v AND #s=:pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": resolve ? "resolved" : "rejected",
          ":at": Date.now(),
          ":by": user.id,
          ":e": evidence,
          ":tag": newTag || null,
          ":cv": certificateRevision,
          ":one": 1,
          ":v": r.revision,
          ":pending": "awaiting-review",
        },
      },
    });
    await commit(updates, {
      entity: `piece:${piece.id}`,
      actor: user.id,
      action: resolve
        ? "identifier-recovery-approved"
        : "identifier-recovery-rejected",
      details: {
        caseId: r.id,
        revokedTags: newTag ? oldTags : [],
        replacementTag: newTag || null,
        certificateRevision,
        evidenceHash: digest(evidence),
      },
    });
    return { ok: true };
  }
  return { handle };
}

import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { publicRelease } from "../shared/auction";
import { bidMutation } from "./bid-engine";
import type { Commit } from "./audit";

const fail = (message: string, status = 400): never => {
  throw Object.assign(Error(message), { status });
};
export function rehearsalService(
  db: DynamoDBDocumentClient,
  table: string,
  commit: Commit,
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
  async function owned(id: string, user: { id: string }) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return fail("Rehearsal not found.", 404);
    const a = await get(`REHEARSAL#${id}`, "HEAD");
    if (!a || a.createdBy !== user.id || a.simulation !== true)
      return fail("Rehearsal not found.", 404);
    return a;
  }
  async function snapshot(id: string, user: { id: string }) {
    const a = await owned(id, user);
    return {
      release: publicRelease(a),
      simulation: true,
      leader: a.highestBidder || null,
      revision: a.revision,
    };
  }
  async function list(user: { id: string }) {
    const r = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk=:pk",
        ExpressionAttributeValues: { ":pk": `REHEARSALS#${user.id}` },
        ScanIndexForward: false,
        Limit: 10,
        ConsistentRead: true,
      }),
    );
    return {
      rehearsals: (r.Items || []).map((a) => ({
        id: a.id,
        name: a.name,
        createdAt: a.createdAt,
      })),
    };
  }
  async function handle(body: any, user: { id: string }) {
    if (body.action === "create") {
      if (!/^[a-z0-9-]{1,80}$/.test(body.pieceId || ""))
        return fail("Choose a piece.");
      const source = await get(`AUCTION#${body.pieceId}`, "HEAD");
      if (!source) return fail("Piece not found.", 404);
      const id = randomUUID(),
        now = Date.now();
      // Copy presentation only. Never copy ownership, payment or directory keys.
      const a = {
        ...publicRelease(source),
        pk: `REHEARSAL#${id}`,
        sk: "HEAD",
        id,
        sourceId: source.id,
        createdBy: user.id,
        simulation: true,
        revision: 1,
        status: "open",
        opensAt: now - 1000,
        closesAt: now + 5 * 60000,
        highestBid: null,
        highestBidder: null,
        bidCount: 0,
        recentBids: [],
        publicOwner: null,
        certificateId: null,
        soldAt: null,
        published: false,
      };
      await commit(
        [
          {
            Put: {
              TableName: table,
              Item: a,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: table,
              Item: {
                pk: `REHEARSALS#${user.id}`,
                sk: `${now}#${id}`,
                id,
                name: source.name,
                createdAt: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
        {
          entity: `rehearsal:${id}`,
          actor: user.id,
          action: "rehearsal-created",
          details: { sourceId: source.id, simulation: true },
        },
      );
      return snapshot(id, user);
    }
    const a = await owned(body.id, user);
    if (body.action === "receipt") {
      if (!/^[a-f0-9-]{36}$/.test(body.requestId || ""))
        return fail("Invalid receipt reference.");
      const b = await get(a.pk, `BID#${body.requestId}`);
      return {
        receipt: b
          ? {
              bidId: b.bidId,
              amount: b.amount,
              sequence: b.sequence,
              receivedAt: b.createdAt,
            }
          : null,
      };
    }
    if (body.action === "close") {
      if (a.status === "closed") return snapshot(a.id, user);
      await commit(
        [
          {
            Update: {
              TableName: table,
              Key: { pk: a.pk, sk: "HEAD" },
              UpdateExpression: "SET #s=:s, closesAt=:now ADD revision :one",
              ConditionExpression: "revision=:v",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":s": "closed",
                ":now": Date.now(),
                ":one": 1,
                ":v": a.revision,
              },
            },
          },
        ],
        {
          entity: `rehearsal:${a.id}`,
          actor: user.id,
          action: "rehearsal-closed",
          details: { simulatedWinner: a.highestBidder || null },
        },
      );
      return snapshot(a.id, user);
    }
    if (
      body.action !== "bid" ||
      !["you", "collector-a", "collector-b"].includes(body.bidder)
    )
      return fail("Choose a simulated bidder.");
    if (!/^[a-f0-9-]{36}$/.test(body.requestId || ""))
      return fail("Invalid bid reference.");
    const existing = await get(a.pk, `BID#${body.requestId}`);
    if (existing) {
      if (existing.amount !== body.amount || existing.bidderId !== body.bidder)
        return fail("This bid reference belongs to a different request.", 409);
      return {
        ok: true,
        bidId: existing.bidId,
        amount: existing.amount,
        sequence: existing.sequence,
        receivedAt: existing.createdAt,
      };
    }
    const mutation = bidMutation(
      table,
      a,
      { id: body.bidder, email: "simulation@example.invalid" },
      body.amount,
      body.requestId,
      { simulation: true, studioActor: user.id },
    );
    await commit(
      mutation.changes,
      {
        entity: `rehearsal:${a.id}`,
        actor: user.id,
        action: "rehearsal-bid-accepted",
        details: { ...mutation.receipt, simulatedBidder: body.bidder },
      },
      { notAfter: a.closesAt },
    );
    return { ok: true, ...mutation.receipt };
  }
  return { owned, snapshot, list, handle };
}

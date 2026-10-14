import { auctionPhase, validateBid } from "../shared/auction";
import type { Changes } from "./audit";

// The real auction and private rehearsal share the same conditional writes.
export function bidMutation(
  table: string,
  head: any,
  bidder: { id: string; email: string },
  amount: unknown,
  requestId: string,
  extra: Record<string, unknown> = {},
) {
  if (!/^[a-f0-9-]{36}$/.test(requestId))
    throw Object.assign(Error("Invalid bid reference."), { status: 400 });
  const now = Date.now();
  if (
    auctionPhase(head, now) !== "open" ||
    !["scheduled", "open"].includes(head.status)
  )
    throw Object.assign(Error("This auction is not open."), { status: 409 });
  const value = validateBid(amount, head);
  const receipt = {
    bidId: requestId,
    amount: value,
    receivedAt: now,
    sequence: head.bidCount + 1,
  };
  const recentBids = [
    { amount: value, sequence: receipt.sequence, receivedAt: now },
    ...(head.recentBids || []),
  ].slice(0, 10);
  const changes: Changes = [
    {
      Update: {
        TableName: table,
        Key: { pk: head.pk, sk: "HEAD" },
        UpdateExpression:
          "SET highestBid=:amount, highestBidder=:bidder, highestBidderEmail=:email, recentBids=:recent ADD revision :one, bidCount :one",
        ConditionExpression:
          "revision=:v AND opensAt<=:now AND closesAt>:now AND (#s=:scheduled OR #s=:open)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":amount": value,
          ":bidder": bidder.id,
          ":email": bidder.email,
          ":recent": recentBids,
          ":one": 1,
          ":v": head.revision,
          ":now": now,
          ":scheduled": "scheduled",
          ":open": "open",
        },
      },
    },
    {
      Put: {
        TableName: table,
        Item: {
          ...extra,
          pk: head.pk,
          sk: `BID#${requestId}`,
          bidId: requestId,
          sequence: receipt.sequence,
          bidderId: bidder.id,
          email: bidder.email,
          amount: value,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
    {
      Put: {
        TableName: table,
        Item: {
          pk: head.pk,
          sk: `BIDDER#${bidder.id}`,
          amount: value,
          sequence: receipt.sequence,
        },
      },
    },
  ];
  return { receipt, changes };
}

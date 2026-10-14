import { randomBytes } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { digest } from "./audit";
export const liveChannel = (kind: "auction" | "rehearsal", id: string) =>
  `/${kind}/${digest(id).slice(0, 48)}`;
export function liveAccess(db: DynamoDBDocumentClient, table: string) {
  async function ticket(id: string, privateMode = false) {
    const channel = liveChannel(privateMode ? "rehearsal" : "auction", id);
    const token = privateMode
      ? `studio:${randomBytes(32).toString("hex")}`
      : `public:${id}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 240;
    if (privateMode)
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            pk: `LIVE#${digest(token)}`,
            sk: "TOKEN",
            channel,
            expiresAt,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    return {
      token,
      channel,
      expiresAt,
      http: process.env.LIVE_HTTP,
      realtime: process.env.LIVE_REALTIME,
    };
  }
  async function authorize(event: any) {
    const token = event.authorizationToken || "",
      op = event.requestContext?.operation;
    if (!["EVENT_CONNECT", "EVENT_SUBSCRIBE"].includes(op))
      return { isAuthorized: false, ttlOverride: 0 };
    let channel: string | undefined;
    if (/^public:[a-z0-9-]{1,80}$/.test(token)) {
      const id = token.slice(7);
      const a = (
        await db.send(
          new GetCommand({
            TableName: table,
            Key: { pk: `AUCTION#${id}`, sk: "HEAD" },
            ConsistentRead: true,
          }),
        )
      ).Item;
      if (a?.published === true) channel = liveChannel("auction", id);
    } else if (/^studio:[a-f0-9]{64}$/.test(token)) {
      const a = (
        await db.send(
          new GetCommand({
            TableName: table,
            Key: { pk: `LIVE#${digest(token)}`, sk: "TOKEN" },
            ConsistentRead: true,
          }),
        )
      ).Item;
      if (a && a.expiresAt > Date.now() / 1000) channel = a.channel;
    }
    return {
      isAuthorized:
        !!channel &&
        (op === "EVENT_CONNECT" || event.requestContext.channel === channel),
      ttlOverride: 0,
    };
  }
  return { ticket, authorize };
}

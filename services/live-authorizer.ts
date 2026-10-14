import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { liveAccess } from "./live-access";
const access = liveAccess(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  process.env.AUCTION_TABLE!,
);
export const handler = access.authorize;

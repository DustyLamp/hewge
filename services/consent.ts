import { createHash } from "node:crypto";
export const suppressionKey = (email: string) => ({
  pk: `SUPPRESSION#${createHash("sha256").update(email.toLowerCase()).digest("hex")}`,
});
// Keep only an address hash and opt-out timestamp after contact records expire.
// A subsequent explicit, verified opt-in must be strictly newer to supersede it.
export const suppressionWrite = (
  TableName: string,
  email: string,
  consentAt: number,
) => ({
  Put: {
    TableName,
    Item: { ...suppressionKey(email), consentAt },
    ConditionExpression: "attribute_not_exists(consentAt) OR consentAt<=:at",
    ExpressionAttributeValues: { ":at": consentAt },
  },
});

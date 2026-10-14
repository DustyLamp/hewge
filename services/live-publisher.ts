import { unmarshall } from "@aws-sdk/util-dynamodb";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { liveChannel } from "./live-access";

// Streams contain committed writes only. No price, identity or hidden artwork
// crosses this channel; clients obtain an authorised, strongly read snapshot.
export function notifications(records: any[]) {
  const latest = new Map<
    string,
    { channel: string; revision: number; sequenceNumber: string }
  >();
  for (const record of records) {
    if (!record.dynamodb?.NewImage || record.eventName === "REMOVE") continue;
    const a = unmarshall(record.dynamodb.NewImage);
    if (a.sk !== "HEAD" || !Number.isSafeInteger(a.revision)) continue;
    const kind = a.pk?.startsWith("AUCTION#")
      ? "auction"
      : a.pk?.startsWith("REHEARSAL#") && a.simulation === true
        ? "rehearsal"
        : null;
    if (!kind) continue;
    const channel = liveChannel(kind, a.id);
    const old = latest.get(channel);
    if (!old || old.revision < a.revision)
      latest.set(channel, {
        channel,
        revision: a.revision,
        sequenceNumber: record.dynamodb.SequenceNumber,
      });
  }
  return [...latest.values()];
}
const signer = new SignatureV4({
  service: "appsync",
  region: process.env.AWS_REGION!,
  credentials: fromNodeProviderChain(),
  sha256: Sha256,
});
export async function handler(event: any) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  await Promise.all(
    notifications(event.Records).map(
      async ({ channel, revision, sequenceNumber }) => {
        try {
          const hostname = process.env.LIVE_HTTP!;
          const body = JSON.stringify({
            channel,
            events: [JSON.stringify({ revision })],
          });
          const request = await signer.sign(
            new HttpRequest({
              method: "POST",
              protocol: "https:",
              hostname,
              path: "/event",
              headers: { host: hostname, "content-type": "application/json" },
              body,
            }),
          );
          const res = await fetch(`https://${hostname}/event`, {
            method: "POST",
            headers: request.headers,
            body,
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) throw Error(`Live publish failed: ${res.status}`);
          const result = (await res.json()) as any;
          if (result.failed?.length || result.errors?.length)
            throw Error("Live publish rejected.");
        } catch (e) {
          console.error("Live notification failed", (e as Error).message);
          batchItemFailures.push({ itemIdentifier: sequenceNumber });
        }
      },
    ),
  );
  return { batchItemFailures };
}

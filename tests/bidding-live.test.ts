import { describe, expect, it, vi } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
import { preview, publicRelease } from "../shared/auction";
import { rehearsalService } from "../services/rehearsal";
import { bidMutation } from "../services/bid-engine";
import { liveAccess, liveChannel } from "../services/live-access";
import { notifications } from "../services/live-publisher";

const uid = "11111111-1111-4111-8111-111111111111";
const owner = { id: "studio-owner" };
function fixture() {
  const records = new Map<string, any>();
  const key = (a: any) => `${a.pk}|${a.sk}`;
  records.set("AUCTION#first|HEAD", {
    ...preview,
    pk: "AUCTION#first",
    sk: "HEAD",
    id: "first",
    name: "After Hours",
    published: true,
    highestBidder: "real-winner",
    certificateId: "real-certificate",
    paymentIntentId: "real-payment",
    revision: 12,
  });
  const send = vi.fn(async (c: any) => {
    if (c.constructor.name === "GetCommand")
      return { Item: structuredClone(records.get(key(c.input.Key))) };
    if (c.constructor.name === "PutCommand")
      records.set(key(c.input.Item), structuredClone(c.input.Item));
    if (c.constructor.name === "QueryCommand")
      return {
        Items: [...records.values()].filter(
          (a) => a.pk === c.input.ExpressionAttributeValues[":pk"],
        ),
      };
    return {};
  });
  const journal: any[] = [];
  const commit = vi.fn(async (changes: any[], meta: any, options?: any) => {
    // Model revision CAS atomically, including no partial writes on a conflict.
    for (const c of changes)
      if (c.Update) {
        const u = c.Update,
          a = records.get(key(u.Key));
        if (a.revision !== u.ExpressionAttributeValues[":v"])
          throw Object.assign(Error("Competing bid"), {
            name: "TransactionCanceledException",
          });
      }
    if (options?.notAfter && Date.now() >= options.notAfter)
      throw Object.assign(Error("Closed"), { status: 409 });
    for (const c of changes) {
      if (c.Put) records.set(key(c.Put.Item), structuredClone(c.Put.Item));
      if (c.Update) {
        const u = c.Update,
          a = records.get(key(u.Key)),
          v = u.ExpressionAttributeValues;
        if (v[":amount"] !== undefined)
          Object.assign(a, {
            highestBid: v[":amount"],
            highestBidder: v[":bidder"],
            recentBids: v[":recent"],
            bidCount: a.bidCount + 1,
            revision: a.revision + 1,
          });
        else
          Object.assign(a, {
            status: v[":s"],
            closesAt: v[":now"],
            revision: a.revision + 1,
          });
      }
    }
    journal.push(meta);
  });
  return {
    records,
    send,
    commit,
    journal,
    service: rehearsalService({ send } as any, "table", commit),
    access: liveAccess({ send } as any, "table"),
  };
}

describe("private auction rehearsals", () => {
  it("copies presentation without payment, ownership, live directory or public publication", async () => {
    const f = fixture();
    const r: any = await f.service.handle(
      { action: "create", pieceId: "first" },
      owner,
    );
    const head = f.records.get(`REHEARSAL#${r.release.id}|HEAD`);
    expect(head).toMatchObject({
      simulation: true,
      published: false,
      bidCount: 0,
      highestBid: null,
      certificateId: null,
    });
    expect(head).not.toHaveProperty("gpk");
    expect(head).not.toHaveProperty("paymentIntentId");
    expect(head.closesAt - head.opensAt).toBe(301000);
    expect(f.records.get("AUCTION#first|HEAD").highestBidder).toBe(
      "real-winner",
    );
    expect((await f.service.list(owner)).rehearsals).toHaveLength(1);
    expect((await f.service.list({ id: "other" })).rehearsals).toHaveLength(0);
    await expect(
      f.service.snapshot(r.release.id, { id: "other" }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("accepts one competing bid, preserves its receipt after close and rejects late or changed retries", async () => {
    const f = fixture();
    const r: any = await f.service.handle(
      { action: "create", pieceId: "first" },
      owner,
    );
    const body = {
      action: "bid",
      id: r.release.id,
      bidder: "you",
      amount: 33900,
      requestId: uid,
    };
    const results = await Promise.allSettled([
      f.service.handle(body, owner),
      f.service.handle(
        {
          ...body,
          bidder: "collector-a",
          requestId: "22222222-2222-4222-8222-222222222222",
        },
        owner,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      f.journal.filter((r) => r.action === "rehearsal-bid-accepted"),
    ).toHaveLength(1);
    expect((await f.service.snapshot(body.id, owner)).release.bidCount).toBe(1);
    await f.service.handle({ action: "close", id: body.id }, owner);
    expect(await f.service.handle(body, owner)).toMatchObject({
      bidId: uid,
      sequence: 1,
      amount: 33900,
    });
    await expect(
      f.service.handle({ ...body, amount: 34900 }, owner),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.service.handle(
        {
          ...body,
          amount: 34900,
          requestId: "33333333-3333-4333-8333-333333333333",
        },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.records.get("AUCTION#first|HEAD").revision).toBe(12);
  });
  it("rejects non-owner mutations and preserves only allowlisted public receipt fields", async () => {
    const f = fixture();
    const r: any = await f.service.handle(
      { action: "create", pieceId: "first" },
      owner,
    );
    await expect(
      f.service.handle({ action: "close", id: r.release.id }, { id: "other" }),
    ).rejects.toMatchObject({ status: 404 });
    const release = publicRelease({
      ...preview,
      recentBids: [
        {
          amount: 100,
          sequence: 1,
          receivedAt: 1,
          email: "private@example.invalid",
        },
      ],
    });
    expect(release.recentBids).toEqual([
      { amount: 100, sequence: 1, receivedAt: 1 },
    ]);
  });
});

describe("shared bid authority", () => {
  const head = () => ({
    ...preview,
    pk: "AUCTION#first",
    status: "open",
    revision: 4,
    bidCount: 3,
    highestBid: 40000,
    opensAt: Date.now() - 1000,
    closesAt: Date.now() + 60000,
  });
  it("conditions every accepted bid on revision and the server deadline and bounds public history", () => {
    const a = {
      ...head(),
      recentBids: Array.from({ length: 12 }, (_, i) => ({
        sequence: i,
        amount: i,
        receivedAt: 1,
      })),
    };
    const r = bidMutation(
      "table",
      a,
      { id: "collector", email: "private@example.invalid" },
      41000,
      uid,
    );
    expect(r.receipt.sequence).toBe(4);
    const u = r.changes[0].Update!;
    expect(u.ConditionExpression).toContain(
      "revision=:v AND opensAt<=:now AND closesAt>:now",
    );
    expect(u.ExpressionAttributeValues![":recent"]).toHaveLength(10);
    expect(r.changes[1].Put!.ConditionExpression).toBe(
      "attribute_not_exists(pk)",
    );
    expect(r.changes[2].Put!.Item).toMatchObject({
      sk: "BIDDER#collector",
      sequence: 4,
    });
  });
  it("rejects below-minimum amounts, fractions, closed auctions and draft statuses", () => {
    const b = { id: "you", email: "test@example.invalid" };
    for (const amount of [40000, 41000.1, NaN, Infinity, "41000"])
      expect(() => bidMutation("table", head(), b, amount, uid)).toThrow();
    expect(() =>
      bidMutation("table", { ...head(), closesAt: Date.now() }, b, 41000, uid),
    ).toThrow("not open");
    expect(() =>
      bidMutation("table", { ...head(), status: "draft" }, b, 41000, uid),
    ).toThrow("not open");
  });
});

describe("live channel authorization and privacy", () => {
  it("allows exact published channels only, rejecting wildcards, other pieces and all client publishing", async () => {
    const f = fixture();
    const authorize = (
      operation: string,
      channel?: string,
      token = "public:first",
    ) =>
      f.access.authorize({
        authorizationToken: token,
        requestContext: { operation, channel },
      });
    expect(await authorize("EVENT_CONNECT")).toMatchObject({
      isAuthorized: true,
      ttlOverride: 0,
    });
    expect(
      await authorize("EVENT_SUBSCRIBE", liveChannel("auction", "first")),
    ).toMatchObject({ isAuthorized: true });
    for (const channel of [
      "/auction/*",
      liveChannel("auction", "another"),
      liveChannel("rehearsal", "first"),
    ])
      expect(await authorize("EVENT_SUBSCRIBE", channel)).toMatchObject({
        isAuthorized: false,
      });
    expect(
      await authorize("EVENT_PUBLISH", liveChannel("auction", "first")),
    ).toMatchObject({ isAuthorized: false });
    f.records.get("AUCTION#first|HEAD").published = false;
    expect(await authorize("EVENT_CONNECT")).toMatchObject({
      isAuthorized: false,
    });
    expect(
      f.send.mock.calls
        .filter(([c]) => c.constructor.name === "GetCommand")
        .every(([c]) => c.input.ConsistentRead),
    ).toBe(true);
  });
  it("requires an unexpired private ticket and forbids reusing it on another rehearsal", async () => {
    const f = fixture();
    const t = await f.access.ticket(uid, true);
    const event = {
      authorizationToken: t.token,
      requestContext: { operation: "EVENT_SUBSCRIBE", channel: t.channel },
    };
    expect(await f.access.authorize(event)).toMatchObject({
      isAuthorized: true,
    });
    expect(
      await f.access.authorize({
        ...event,
        requestContext: {
          operation: "EVENT_SUBSCRIBE",
          channel: "/rehearsal/*",
        },
      }),
    ).toMatchObject({ isAuthorized: false });
    for (const a of f.records.values()) if (a.sk === "TOKEN") a.expiresAt = 1;
    expect(await f.access.authorize(event)).toMatchObject({
      isAuthorized: false,
    });
  });
  it("coalesces committed revisions and never broadcasts bidder, price, artwork or audit records", () => {
    const record = (pk: string, revision: number, sk = "HEAD") => ({
      eventName: "MODIFY",
      dynamodb: {
        SequenceNumber: String(revision),
        NewImage: marshall({
          pk,
          sk,
          id: "first",
          revision,
          highestBid: 999,
          highestBidder: "private",
          image: "unreleased",
          simulation: true,
        }),
      },
    });
    const result = notifications([
      record("AUCTION#first", 5),
      record("AUCTION#first", 3),
      record("AUCTION#first", 6),
      record("REHEARSAL#first", 2),
      record("AUDIT#first", 1),
      record("AUCTION#first", 7, "BID#something"),
    ]);
    expect(result).toEqual([
      {
        channel: liveChannel("auction", "first"),
        revision: 6,
        sequenceNumber: "6",
      },
      {
        channel: liveChannel("rehearsal", "first"),
        revision: 2,
        sequenceNumber: "2",
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|999|unreleased/);
  });
});

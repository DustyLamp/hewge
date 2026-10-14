import { beforeEach, describe, expect, it, vi } from "vitest";
import { smsService } from "../services/sms";

const email = "member@example.invalid",
  phone = "+41790000000",
  ip = "192.0.2.1";
let rows: Map<string, any>,
  provider: ReturnType<typeof vi.fn>,
  db: ReturnType<typeof vi.fn>,
  service: ReturnType<typeof smsService>;
const key = (table: string, x: any) => `${table}/${x.pk}/${x.sk || ""}`;
const conflict = () =>
  Object.assign(Error("Concurrent write"), {
    name: "TransactionCanceledException",
  });
function condition(input: any, old: any) {
  const names = input.ExpressionAttributeNames || {},
    values = input.ExpressionAttributeValues || {};
  const expr = input.ConditionExpression;
  if (!expr) return true;
  return expr.split(" OR ").some((group: string) =>
    group.split(" AND ").every((part) => {
      const absent = part.match(/^attribute_not_exists\((.*?)\)$/);
      if (absent) return old?.[names[absent[1]] || absent[1]] === undefined;
      const m = part.match(/^([#\w]+)\s*(<=|>=|<|>|=)\s*(:\w+)$/);
      if (!m) throw Error(`Unsupported test condition: ${part}`);
      const a = old?.[names[m[1]] || m[1]],
        b = values[m[3]];
      return m[2] === "="
        ? a === b
        : m[2] === "<"
          ? a < b
          : m[2] === ">"
            ? a > b
            : m[2] === "<="
              ? a <= b
              : a >= b;
    }),
  );
}
function apply(input: any, put = false) {
  const k = key(input.TableName, input.Key || input.Item);
  if (put) {
    rows.set(k, structuredClone(input.Item));
    return;
  }
  const row = rows.get(k) || { ...input.Key },
    names = input.ExpressionAttributeNames || {},
    values = input.ExpressionAttributeValues || {};
  for (const m of input.UpdateExpression.matchAll(
    /\b(SET|ADD|REMOVE)\s+([\s\S]*?)(?=\s+(?:SET|ADD|REMOVE)\b|$)/g,
  )) {
    for (const bit of m[2].split(",")) {
      const [raw, value] = bit.trim().split(/\s*=\s*|\s+/),
        name = names[raw] || raw;
      if (m[1] === "REMOVE") delete row[name];
      else
        row[name] =
          m[1] === "ADD" ? (row[name] || 0) + values[value] : values[value];
    }
  }
  rows.set(k, row);
}
beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.stubEnv("SMS_VERIFICATION_ENABLED", "true");
  vi.stubEnv(
    "SMS_SENDER_ARN",
    "arn:aws:sms-voice:eu-north-1:082229154968:sender-id/HEWGE/CH",
  );
  rows = new Map();
  db = vi.fn(async (cmd: any) => {
    const x = cmd.input,
      name = cmd.constructor.name;
    if (name === "GetCommand")
      return { Item: structuredClone(rows.get(key(x.TableName, x.Key))) };
    if (name === "TransactWriteCommand") {
      for (const tx of x.TransactItems) {
        const p = tx.Put || tx.Update;
        if (!condition(p, rows.get(key(p.TableName, p.Key || p.Item))))
          throw conflict();
      }
      for (const tx of x.TransactItems) apply(tx.Put || tx.Update, !!tx.Put);
    } else if (name === "UpdateCommand") {
      if (!condition(x, rows.get(key(x.TableName, x.Key)))) throw conflict();
      apply(x);
    }
    return {};
  });
  provider = vi.fn(async (cmd: any) => {
    if (cmd.constructor.name === "DescribeAccountAttributesCommand")
      return {
        AccountAttributes: [{ Name: "ACCOUNT_TIER", Value: "SANDBOX" }],
      };
    if (cmd.constructor.name === "DescribeVerifiedDestinationNumbersCommand")
      return {
        VerifiedDestinationNumbers: [
          { DestinationPhoneNumber: phone, Status: "VERIFIED" },
        ],
      };
    return { MessageId: "synthetic-message" };
  });
  service = smsService(
    { send: db } as any,
    { send: provider } as any,
    "platform",
    "members",
  );
});
const call = (action: string, body: any = {}, who = email) =>
  service.handle(action, who, body, ip);
const sends = () =>
  provider.mock.calls.filter(
    ([cmd]) => cmd.constructor.name === "SendTextMessageCommand",
  );
const latestCode = () =>
  sends()
    .at(-1)![0]
    .input.MessageBody.match(/code: (\d{6})/)[1];
async function requested() {
  await call("save", { phone, consent: true });
  const r = await call("request");
  if (!("challenge" in r) || !r.challenge) throw Error("Expected a challenge");
  return { challenge: r.challenge, expiresAt: r.expiresAt! };
}

describe("SMS consent and verification", () => {
  it("requires a saved opt-in and does not treat a contact number as verified", async () => {
    await call("save", { phone, consent: false });
    await expect(call("request")).rejects.toThrow(/choose text alerts/);
    expect(await call("preferences")).toMatchObject({
      consent: false,
      verified: false,
    });
    expect(sends()).toHaveLength(0);
  });
  it("gates sending by configuration and sandbox destination, without exposing other numbers", async () => {
    vi.stubEnv("SMS_VERIFICATION_ENABLED", "false");
    await call("save", { phone, consent: true });
    await expect(call("request")).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("SMS_VERIFICATION_ENABLED", "true");
    await call("save", { phone: "+41790000001", consent: true });
    await expect(call("request")).rejects.toMatchObject({ status: 503 });
    expect(sends()).toHaveLength(0);
  });
  it("uses a short-lived secret challenge and never stores a recoverable code", async () => {
    const r = await requested(),
      code = latestCode();
    expect(r.challenge).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify([...rows.values()])).not.toContain(code);
    expect(JSON.stringify([...rows.values()])).not.toContain(r.challenge);
    expect(sends()[0][0].input).toMatchObject({
      MessageType: "TRANSACTIONAL",
      MaxPrice: "0.15",
      TimeToLive: 600,
    });
    expect(r.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 600);
    expect(
      await call("verify", { challenge: r.challenge, code }),
    ).toMatchObject({ verified: true, consent: true, alertsEnabled: false });
    await expect(
      call("verify", { challenge: r.challenge, code }),
    ).rejects.toThrow(/invalid or expired/);
  });
  it("rejects a challenge belonging to another verified email", async () => {
    const r = await requested();
    await expect(
      call(
        "verify",
        { challenge: r.challenge, code: latestCode() },
        "other@example.invalid",
      ),
    ).rejects.toThrow(/invalid or expired/);
    expect(await call("preferences")).toMatchObject({ verified: false });
  });
  it("expires codes independently of DynamoDB TTL deletion", async () => {
    const r = await requested(),
      code = latestCode();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 601000);
    await expect(
      call("verify", { challenge: r.challenge, code }),
    ).rejects.toThrow(/invalid or expired/);
  });
  it("locks after five incorrect guesses", async () => {
    const r = await requested(),
      code = latestCode(),
      wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++)
      await expect(
        call("verify", { challenge: r.challenge, code: wrong }),
      ).rejects.toThrow(/doesn’t match/);
    await expect(
      call("verify", { challenge: r.challenge, code }),
    ).rejects.toThrow(/invalid or expired/);
  });
  it("invalidates verification when a number changes", async () => {
    const r = await requested();
    await call("verify", { challenge: r.challenge, code: latestCode() });
    expect(
      await call("save", { phone: "+41790000001", consent: true }),
    ).toMatchObject({ verified: false });
  });
  it("does not let an in-flight code turn alerts back on after opt-out", async () => {
    const r = await requested(),
      code = latestCode();
    await call("save", { phone, consent: false });
    await expect(
      call("verify", { challenge: r.challenge, code }),
    ).rejects.toThrow(/invalid or expired/);
    expect(await call("preferences")).toMatchObject({ consent: false });
  });
  it("stops canonical SMS preferences when email unsubscribe commits", async () => {
    const r = await requested(),
      code = latestCode();
    const update = service.stopWrite(email, Date.now());
    apply(update.Update);
    await expect(
      call("verify", { challenge: r.challenge, code }),
    ).rejects.toThrow(/invalid or expired/);
    expect(await call("preferences")).toMatchObject({ consent: false });
  });
  it("uses durable phone suppression across accounts", async () => {
    await call("save", { phone, consent: true }, "other@example.invalid");
    await call("save", { phone, consent: false });
    expect(
      await call("preferences", {}, "other@example.invalid"),
    ).toMatchObject({ consent: false });
  });
  it("blocks rapid resends and does not duplicate ambiguous sends", async () => {
    const normal = provider.getMockImplementation()! as (
      ...args: any[]
    ) => Promise<any>;
    provider.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === "SendTextMessageCommand")
        throw Error("Timeout after acceptance");
      return normal(cmd);
    });
    await call("save", { phone, consent: true });
    await expect(call("request")).rejects.toMatchObject({ status: 503 });
    await expect(call("request")).rejects.toMatchObject({ status: 429 });
    expect(sends()).toHaveLength(1);
  });
  it("does not reset rate limits on a new account or number save", async () => {
    const r = await requested();
    await call("save", { phone, consent: true });
    // A profile save can reset UI state, never the shared phone/IP/budget counters.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61000);
    await call("request");
    vi.setSystemTime(Date.now() + 61000);
    await call("request");
    vi.setSystemTime(Date.now() + 61000);
    await expect(call("request")).rejects.toMatchObject({ status: 429 });
    expect(sends()).toHaveLength(3);
    await expect(
      call("verify", { challenge: r.challenge, code: "111111" }),
    ).rejects.toThrow(/invalid or expired/);
  });
  it("rejects concurrent verification after a preference change", async () => {
    const r = await requested(),
      code = latestCode();
    const normal = db.getMockImplementation()! as (
      ...args: any[]
    ) => Promise<any>;
    db.mockImplementation(async (cmd: any) => {
      if (
        cmd.constructor.name === "TransactWriteCommand" &&
        cmd.input.TransactItems.some((x: any) => x.Put?.Item.phoneVerified)
      ) {
        const row = [...rows.values()].find((x) =>
          x.pk.startsWith("SMS_MEMBER#"),
        );
        row.revision += 1;
        row.consent = false;
      }
      return normal(cmd);
    });
    await expect(
      call("verify", { challenge: r.challenge, code }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await call("preferences")).toMatchObject({
      consent: false,
      verified: false,
    });
  });
});

async function verifiedPhone() {
  const r = await requested();
  await call("verify", { challenge: r.challenge, code: latestCode() });
}
function enableCampaigns() {
  vi.stubEnv("SMS_RELEASES_ENABLED", "true");
  vi.stubEnv("SITE_URL", "https://hewge.design");
  const normal = provider.getMockImplementation()! as (
    ...args: any[]
  ) => Promise<any>;
  provider.mockImplementation(async (cmd: any) =>
    cmd.constructor.name === "DescribeAccountAttributesCommand"
      ? { AccountAttributes: [{ Name: "ACCOUNT_TIER", Value: "PRODUCTION" }] }
      : normal(cmd),
  );
  service = smsService(
    { send: db } as any,
    { send: provider } as any,
    "platform",
    "members",
  );
}
const outbox = () => [...rows.values()].filter((r) => r.gpk === "SMS_OUTBOX");
const queue = (id = "test-campaign") =>
  service.enqueue({ id, text: "The next original opens soon." }, { email });

describe("SMS release dispatch", () => {
  it("requires a separate release gate and AWS production access", async () => {
    await verifiedPhone();
    vi.stubEnv("SITE_URL", "https://hewge.design");
    await queue();
    vi.stubEnv("SMS_RELEASES_ENABLED", "true");
    await service.sendQueued(outbox(), async () => true);
    expect(sends()).toHaveLength(1); // verification only; sandbox never sends campaigns
  });
  it("queues only once, includes a one-use opt-out, and sends as promotional", async () => {
    await verifiedPhone();
    enableCampaigns();
    await queue();
    await queue();
    expect(outbox()).toHaveLength(1);
    const text = outbox()[0].text;
    expect(text.length).toBeLessThanOrEqual(160);
    const leave = text.match(/#leave=([\w-]+)/)[1];
    expect(
      JSON.stringify(
        [...rows.values()].filter((x) => x.pk.startsWith("SMS_LEAVE#")),
      ),
    ).not.toContain(leave);
    expect(await service.leave("link", leave)).toEqual({ unsubscribed: false });
    expect((await call("preferences")) as any).toMatchObject({ consent: true });
    await service.sendQueued(outbox(), async () => true);
    expect(sends()).toHaveLength(2);
    expect(sends()[1][0].input).toMatchObject({
      MessageType: "PROMOTIONAL",
      MaxPrice: "0.15",
    });
    expect(outbox()[0].status).toBe("accepted");
    expect(outbox()[0].text).toBeUndefined();
    await service.sendQueued(outbox(), async () => true);
    expect(sends()).toHaveLength(2);
    expect(await service.leave("leave", leave)).toEqual({ unsubscribed: true });
    expect((await call("preferences")) as any).toMatchObject({
      consent: false,
    });
    expect(await service.leave("leave", leave)).toEqual({ unsubscribed: true });
  });
  it("suppresses queued messages when the number changes or consent is withdrawn", async () => {
    await verifiedPhone();
    enableCampaigns();
    await queue();
    await call("save", { phone, consent: false });
    await service.sendQueued(outbox(), async () => true);
    expect(sends()).toHaveLength(1);
    expect(outbox()[0].status).toBe("suppressed");
  });
  it("respects a cancelled campaign immediately before handoff", async () => {
    await verifiedPhone();
    enableCampaigns();
    await queue();
    const canSend = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await service.sendQueued(outbox(), canSend);
    expect(sends()).toHaveLength(1);
    expect(outbox()[0].status).toBe("suppressed");
  });
  it("shares a hard application send-count ceiling with verification codes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    await verifiedPhone();
    enableCampaigns();
    for (let i = 0; i < 5; i++) await queue(`campaign-${i}`);
    await service.sendQueued(outbox(), async () => true);
    expect(sends()).toHaveLength(4); // one OTP plus three release messages, four/day
    expect(outbox().filter((x) => x.status === "pending")).toHaveLength(2);
    vi.setSystemTime(Date.now() + 86400000);
    await queue("next-day-one");
    await queue("next-day-two");
    await service.sendQueued(outbox(), async () => true);
    expect(sends()).toHaveLength(5);
  });
  it("does not retry a promotional send after an ambiguous timeout", async () => {
    await verifiedPhone();
    enableCampaigns();
    await queue();
    const normal = provider.getMockImplementation()! as (
      ...args: any[]
    ) => Promise<any>;
    provider.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === "SendTextMessageCommand")
        throw Error("Timeout");
      return normal(cmd);
    });
    await service.sendQueued(outbox(), async () => true);
    await service.sendQueued(outbox(), async () => true);
    expect(sends()).toHaveLength(2);
    expect(outbox()[0].status).toBe("review-required");
  });
  it("does not let an old unsubscribe link disable a different number", async () => {
    await verifiedPhone();
    enableCampaigns();
    await queue();
    const leave = outbox()[0].text.match(/#leave=([\w-]+)/)[1];
    await call("save", { phone: "+41790000001", consent: true });
    await service.leave("leave", leave);
    expect(await call("preferences")).toMatchObject({
      phone: "+41790000001",
      consent: true,
      verified: false,
    });
  });
});

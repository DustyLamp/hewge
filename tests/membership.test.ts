import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { membershipService } from "../services/membership";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const email = "collector@example.invalid";
const memberKey = `EMAIL#${hash(email)}`;
const conflict = () =>
  Object.assign(Error("Conflict"), { name: "TransactionCanceledException" });
let rows: Map<string, any>;
let send: ReturnType<typeof vi.fn>;
let mail: ReturnType<typeof vi.fn>;
let service: ReturnType<typeof membershipService>;
const id = (table: string, key: any) => `${table}/${key.pk}/${key.sk || ""}`;
const getMember = () => rows.get(id("members", { pk: memberKey }));
const clone = (value: any) => (value ? structuredClone(value) : value);

beforeEach(() => {
  rows = new Map();
  mail = vi.fn(async (cmd: any) =>
    cmd.constructor.name === "GetAccountCommand"
      ? { ProductionAccessEnabled: false, SendingEnabled: true }
      : { MessageId: "test-message" },
  );
  send = vi.fn(async (cmd: any) => {
    const input = cmd.input;
    if (cmd.constructor.name === "GetCommand")
      return { Item: clone(rows.get(id(input.TableName, input.Key))) };
    if (cmd.constructor.name === "PutCommand") {
      const key = id(input.TableName, input.Item);
      if (
        input.ConditionExpression === "attribute_not_exists(pk)" &&
        rows.has(key)
      )
        throw conflict();
      rows.set(key, clone(input.Item));
      return {};
    }
    if (cmd.constructor.name === "TransactWriteCommand") {
      // Validate the complete transaction before applying any part of it.
      for (const tx of input.TransactItems) {
        const x = tx.Put || tx.Update || tx.ConditionCheck;
        const old = rows.get(id(x.TableName, x.Key || x.Item));
        const condition = x.ConditionExpression || "";
        if (
          condition.includes("used=:no") &&
          (!old || old.used || old.expiresAt <= Date.now() / 1000)
        )
          throw conflict();
        if (
          condition.includes("#revision=:old") &&
          old?.revision !== x.ExpressionAttributeValues[":old"]
        )
          throw conflict();
        if (
          condition === "attribute_not_exists(#revision)" &&
          old?.revision !== undefined
        )
          throw conflict();
        if (tx.ConditionCheck && (!old || old.expiresAt <= Date.now() / 1000))
          throw conflict();
      }
      for (const tx of input.TransactItems) {
        if (tx.Put)
          rows.set(id(tx.Put.TableName, tx.Put.Item), clone(tx.Put.Item));
        if (tx.Update?.UpdateExpression === "SET used=:yes")
          rows.get(id(tx.Update.TableName, tx.Update.Key)).used = true;
      }
      return {};
    }
    if (cmd.constructor.name === "UpdateCommand") {
      const row = rows.get(id(input.TableName, input.Key));
      if (row && input.ExpressionAttributeValues[":sending"]) {
        if (row.status !== "pending") throw conflict();
        row.status = "sending";
      }
      if (row && input.ExpressionAttributeValues[":sent"]) row.status = "sent";
      if (row && input.ExpressionAttributeValues[":failed"])
        row.status = "failed";
      return {};
    }
    return {};
  });
  service = membershipService(
    { send } as any,
    { send: mail } as any,
    "platform",
    "members",
    "https://hewge.design",
  );
});

async function request(purpose: "join" | "leave" = "join") {
  return service.handle(
    purpose === "join" ? "/waitlist" : "/waitlist/remove",
    {
      email: email.toUpperCase(),
      consent: true,
      sizes: ["M"],
      timezone: "Europe/Zurich",
      locale: "en-CH",
    },
    "192.0.2.1",
  );
}
function challengeToken() {
  const outbox = [...rows.values()]
    .filter((r) => r.kind === "membership")
    .at(-1);
  return outbox.text.match(/#verify=([A-Za-z0-9_-]+)/)[1];
}
async function verify() {
  await request();
  return service.handle(
    "/membership/verify",
    { token: challengeToken() },
    "192.0.2.1",
  ) as Promise<any>;
}

describe("membership email verification", () => {
  it("stores only a pending request before mailbox ownership is proved", async () => {
    const r = await request();
    expect(r).toMatchObject({ delivery: "pending" });
    expect(getMember()).toMatchObject({
      email,
      emailVerified: false,
      releaseConsent: false,
      sizes: [],
      timezone: "Europe/Zurich",
    });
    expect(getMember().country).toBeUndefined();
    expect(
      mail.mock.calls.filter(
        ([c]) => c.constructor.name === "SendEmailCommand",
      ),
    ).toHaveLength(0);
  });
  it("does not overwrite a verified member when someone enters their address", async () => {
    rows.set(id("members", { pk: memberKey }), {
      pk: memberKey,
      email,
      emailVerified: true,
      sizes: ["XL"],
      country: "CH",
      releaseConsent: false,
    });
    await request();
    expect(getMember()).toMatchObject({
      emailVerified: true,
      sizes: ["XL"],
      country: "CH",
      releaseConsent: false,
    });
  });
  it("does not activate a member when a mail scanner inspects the link", async () => {
    await request();
    expect(
      await service.handle(
        "/membership/link",
        { token: challengeToken() },
        "192.0.2.1",
      ),
    ).toEqual({ purpose: "join" });
    expect(getMember().emailVerified).toBe(false);
  });
  it("exchanges a valid link once for a limited preferences session", async () => {
    const r = await verify();
    expect(r.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.profile).toMatchObject({
      emailVerified: true,
      releaseConsent: true,
    });
    expect(r.profile.pk).toBeUndefined();
    await expect(
      service.handle(
        "/membership/verify",
        { token: challengeToken() },
        "192.0.2.1",
      ),
    ).rejects.toThrow(/invalid or expired/);
    expect(r.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 3600);
  });
  it("rejects expired and forged links", async () => {
    await request();
    for (const row of rows.values())
      if (row.pk.startsWith("MEMBER_VERIFY#")) row.expiresAt = 1;
    await expect(
      service.handle(
        "/membership/verify",
        { token: challengeToken() },
        "192.0.2.1",
      ),
    ).rejects.toThrow(/expired/);
    await expect(
      service.handle(
        "/membership/verify",
        { token: "a".repeat(43) },
        "192.0.2.1",
      ),
    ).rejects.toThrow(/expired/);
  });
  it("requires proof before removing an address and grants no edit session for a removal link", async () => {
    await verify();
    await request("leave");
    expect(getMember().releaseConsent).toBe(true);
    const r: any = await service.handle(
      "/membership/verify",
      { token: challengeToken() },
      "192.0.2.1",
    );
    expect(r.unsubscribed).toBe(true);
    expect(r.session).toBeUndefined();
    expect(getMember()).toMatchObject({
      releaseConsent: false,
      smsConsent: false,
      status: "unsubscribed",
    });
  });
  it("requires opt-in and rate limits mail requests", async () => {
    await expect(
      service.handle("/waitlist", { email }, "192.0.2.1"),
    ).rejects.toThrow(/agree/);
    send.mockRejectedValueOnce(conflict());
    await expect(request()).rejects.toMatchObject({ status: 429 });
  });
  it("uses the verified sender and delivery configuration only after SES production access", async () => {
    vi.stubEnv("EMAIL_CONFIGURATION_SET", "hewge-delivery");
    mail.mockImplementation(async (c) =>
      c.constructor.name === "GetAccountCommand"
        ? { ProductionAccessEnabled: true, SendingEnabled: true }
        : { MessageId: "test" },
    );
    expect(await request()).toMatchObject({ delivery: "sent" });
    const sent = mail.mock.calls.find(
      ([c]) => c.constructor.name === "SendEmailCommand",
    )![0].input;
    expect(sent).toMatchObject({
      ConfigurationSetName: "hewge-delivery",
      Destination: { ToAddresses: [email] },
    });
    expect(sent.Content.Simple.Body.Text.Data).toContain("/membership#verify=");
    expect(getMember().emailVerified).toBe(false);
    vi.unstubAllEnvs();
  });
  it("does not claim a failed or ambiguous mail send succeeded", async () => {
    mail.mockImplementation(async (c) => {
      if (c.constructor.name === "GetAccountCommand")
        return { ProductionAccessEnabled: true, SendingEnabled: true };
      throw Error("Provider timeout");
    });
    expect(await request()).toMatchObject({ delivery: "failed" });
    const queue = [...rows.values()].filter((r) => r.kind === "membership");
    expect(queue[0].status).toBe("failed");
    await service.sendQueued(queue);
    expect(
      mail.mock.calls.filter(
        ([c]) => c.constructor.name === "SendEmailCommand",
      ),
    ).toHaveLength(1);
  });
});

describe("member preferences", () => {
  it("requires an unexpired membership session", async () => {
    await expect(
      service.handle("/membership/profile", { session: "fake" }, "192.0.2.1"),
    ).rejects.toMatchObject({ status: 401 });
    const r = await verify();
    for (const row of rows.values())
      if (row.pk.startsWith("MEMBER_SESSION#")) row.expiresAt = 1;
    await expect(
      service.handle(
        "/membership/session",
        { session: r.session },
        "192.0.2.1",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("saves progressive preferences and separate SMS consent without claiming phone verification", async () => {
    const r = await verify();
    await service.handle(
      "/membership/profile",
      {
        session: r.session,
        sizes: ["M", "M", "XL", "invalid"],
        country: "ch",
        city: "Zürich",
        readiness: "ready",
        phone: "+41 79 000 00 00",
        smsConsent: true,
        releaseConsent: true,
      },
      "192.0.2.1",
    );
    expect(getMember()).toMatchObject({
      sizes: ["M", "XL"],
      country: "CH",
      city: "Zürich",
      readiness: "ready",
      phone: "+41790000000",
      smsConsent: true,
      smsStatus: "pending-activation",
      phoneVerified: false,
    });
    expect(
      mail.mock.calls.filter(
        ([c]) => c.constructor.name === "SendEmailCommand",
      ),
    ).toHaveLength(0);
  });
  it("does not infer SMS consent merely from a number and validates international formatting", async () => {
    const r = await verify();
    await expect(
      service.handle(
        "/membership/profile",
        { session: r.session, phone: "0790000000", smsConsent: true },
        "192.0.2.1",
      ),
    ).rejects.toThrow(/international/);
    await service.handle(
      "/membership/profile",
      { session: r.session, phone: "+41790000000", releaseConsent: false },
      "192.0.2.1",
    );
    expect(getMember()).toMatchObject({
      smsConsent: false,
      releaseConsent: false,
      smsStatus: "off",
    });
  });
  it("cannot change another member by submitting their email or a forged verified flag", async () => {
    const r = await verify();
    await service.handle(
      "/membership/profile",
      {
        session: r.session,
        email: "someone-else@example.invalid",
        emailVerified: false,
        phoneVerified: true,
        displayName: "Collector",
      },
      "192.0.2.1",
    );
    expect(getMember()).toMatchObject({
      email,
      emailVerified: true,
      phoneVerified: false,
    });
  });
});

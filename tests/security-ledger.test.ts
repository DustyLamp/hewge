import { beforeEach, describe, it, expect, vi } from "vitest";
import { auditLedger, canonical, digest } from "../services/audit";
import { studioSecurity } from "../services/security";
import { cmac, verifySun, nfcVerifier } from "../services/nfc";
import { transferQuote } from "../shared/transfer";
import { mediaLibrary, imageType } from "../services/media";
import { publicRelease } from "../shared/auction";
import { recoveryService } from "../services/recovery";
const hex = (s: string) => Buffer.from(s, "hex");
const changed = [
  {
    Put: {
      TableName: "business",
      Item: { pk: "piece", ownerId: "next-owner" },
    },
  },
];
const meta = {
  entity: "piece:one",
  action: "ownership-transferred",
  actor: "account-id",
  details: { from: digest("old"), to: digest("next") },
};
describe("permanent provenance and failure boundaries", () => {
  let rows: Map<string, any>,
    objects: Map<string, string>,
    db: any,
    s3: any,
    ledger: ReturnType<typeof auditLedger>;
  beforeEach(() => {
    rows = new Map();
    objects = new Map();
    db = {
      send: vi.fn(async (c: any) => {
        const x = c.input;
        if (c.constructor.name === "GetCommand")
          return { Item: rows.get(x.Key.pk + x.Key.sk) };
        if (c.constructor.name === "TransactWriteCommand") {
          const head = x.TransactItems.find(
            (i: any) => i.Put?.Item.sk === "HEAD",
          ).Put;
          const existing = rows.get(head.Item.pk + "HEAD");
          if (
            (existing?.sequence || 0) !==
            (head.ExpressionAttributeValues?.[":previous"] || 0)
          )
            throw Object.assign(Error("competing transaction"), {
              name: "TransactionCanceledException",
            });
          for (const i of x.TransactItems)
            if (i.Put)
              rows.set(
                i.Put.Item.pk + (i.Put.Item.sk || ""),
                structuredClone(i.Put.Item),
              );
        }
        if (c.constructor.name === "DeleteCommand")
          rows.delete(x.Key.pk + x.Key.sk);
        if (c.constructor.name === "QueryCommand")
          return {
            Items: [...rows.values()]
              .filter(
                (i) =>
                  i.pk === x.ExpressionAttributeValues[":p"] &&
                  (!x.ExpressionAttributeValues[":e"] ||
                    i.sk.startsWith("EVENT#")),
              )
              .sort((a, b) => b.sequence - a.sequence),
          };
        return {};
      }),
    };
    s3 = {
      send: vi.fn(async (c: any) => {
        const x = c.input;
        if (c.constructor.name === "PutObjectCommand") {
          expect(x.ObjectLockLegalHoldStatus).toBe("ON");
          expect(x.ObjectLockMode).toBe("COMPLIANCE");
          expect(x.ObjectLockRetainUntilDate.getTime()).toBeGreaterThan(
            Date.now() + 36499 * 86400000,
          );
          objects.set(x.Key, x.Body);
          return {};
        }
        if (!objects.has(x.Key))
          throw Object.assign(Error(), { name: "NoSuchKey" });
        return {
          Body: { transformToString: async () => objects.get(x.Key) },
          ObjectLockMode: "COMPLIANCE",
          ObjectLockLegalHoldStatus: "ON",
          ObjectLockRetainUntilDate: new Date(Date.now() + 36500 * 86400000),
        };
      }),
    };
    ledger = auditLedger(db, s3, "audit", "locked-archive");
  });
  it("refuses to mutate ownership when the immutable intent cannot be stored", async () => {
    s3.send.mockRejectedValueOnce(Error("archive offline"));
    await expect(ledger.commit(changed, meta)).rejects.toThrow(
      "archive offline",
    );
    expect(rows.size).toBe(0);
  });
  it("rejects a bid whose deadline passes during archive preparation", async () => {
    const original = s3.send.getMockImplementation();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    s3.send.mockImplementation(async (c: any) => {
      const result = await original(c);
      clock.mockReturnValue(2000);
      return result;
    });
    try {
      await expect(
        ledger.commit(
          changed,
          { ...meta, action: "bid-accepted" },
          { notAfter: 2000 },
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(rows.size).toBe(0);
      expect(objects.size).toBe(1); // An intent is not an accepted bid.
    } finally {
      clock.mockRestore();
    }
  });
  it("keeps one coherent owner under concurrent commits and protects both intents", async () => {
    const r = await Promise.allSettled([
      ledger.commit(changed, meta),
      ledger.commit(changed, meta),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(rows.get("ENTITY#piece:oneHEAD").sequence).toBe(1);
    expect(objects.size).toBe(3); // Two attempted intents, one committed receipt.
    const event = [...rows.values()].find((x) => x.sk?.startsWith("EVENT#"));
    expect(event.actor).not.toBe("account-id");
    expect(event).not.toHaveProperty("expiresAt");
  });
  it("recovers a committed change after the receipt write fails, without duplicating ownership", async () => {
    const original = s3.send.getMockImplementation();
    let fail = true;
    s3.send.mockImplementation(async (c: any) => {
      if (c.input.Key.endsWith("committed.json") && fail) {
        fail = false;
        throw Error("outage");
      }
      return original(c);
    });
    await expect(ledger.commit(changed, meta)).rejects.toMatchObject({
      status: 503,
    });
    expect(rows.get("piece").ownerId).toBe("next-owner");
    expect([...rows.values()].some((x) => x.pk === "OUTBOX")).toBe(true);
    await ledger.drain();
    expect([...rows.values()].some((x) => x.pk === "OUTBOX")).toBe(false);
    expect(
      (await ledger.history(meta.entity, undefined, true)).verification
        ?.complete,
    ).toBe(true);
  });
  it("detects edited history even if its attacker rewrites the DDB hash and head", async () => {
    await ledger.commit(changed, meta);
    const e = [...rows.values()].find((x) => x.sk?.startsWith("EVENT#"));
    e.action = "forged";
    const { pk, sk, hash, ...record } = e;
    e.hash = digest(record);
    rows.get("ENTITY#piece:oneHEAD").hash = e.hash;
    await expect(ledger.history(meta.entity, undefined, true)).rejects.toThrow(
      "archive verification failed",
    );
  });
  it("hashes object ordering consistently", () =>
    expect(canonical({ z: 1, a: undefined, b: { v: 2, c: 3 } })).toBe(
      canonical({ b: { c: 3, v: 2 }, z: 1 }),
    ));
});
describe("NFC cryptographic and possession checks", () => {
  it.each([
    ["", "bb1d6929e95937287fa37d129b756746"],
    ["6bc1bee22e409f96e93d7e117393172a", "070a16b46b4d4144f79bdd9dd04a287c"],
    [
      "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411",
      "dfa66747de9ae63030ca32611497c827",
    ],
  ])("matches RFC 4493 CMAC vector %s", (m, out) =>
    expect(
      cmac(hex("2b7e151628aed2a6abf7158809cf4f3c"), hex(m)).toString("hex"),
    ).toBe(out),
  );
  it("decrypts the SUN proof, binds UID and checks all MAC bytes", () => {
    const args = [
      "EF963FF7828658A599F3041510671E88",
      "94EED9EE65337086",
      Buffer.alloc(16),
      Buffer.alloc(16),
      "04DE5F1EACC040",
    ] as const;
    expect(verifySun(...args)).toEqual({ counter: 61 });
    expect(() =>
      verifySun(args[0], "94EED9EE65337087", args[2], args[3], args[4]),
    ).toThrow("Invalid tag proof");
    expect(() =>
      verifySun(args[0], args[1], args[2], args[3], "04DE5F1EACC041"),
    ).toThrow("Tag mismatch");
  });
  it("fails closed for replayed proofs and simultaneously checks the piece hold", async () => {
    vi.stubEnv("NFC_ENABLED", "true");
    const id = "11111111-1111-1111-1111-111111111111";
    const db = {
      send: vi.fn(async (c: any) => {
        if (c.constructor.name === "TransactWriteCommand")
          throw Object.assign(Error(), {
            name: "TransactionCanceledException",
          });
        return {
          Item: c.input.Key.pk.startsWith("TAG#")
            ? {
                pk: `TAG#${id}`,
                id,
                pieceId: "one",
                uid: "04DE5F1EACC040",
                keyCiphertext: "AA==",
                status: "active",
              }
            : { pk: "AUCTION#one", tagIds: [id] },
        };
      }),
    };
    const kms = {
      send: vi.fn(async () => ({
        Plaintext: Buffer.from(
          JSON.stringify({ meta: "0".repeat(32), file: "0".repeat(32) }),
        ),
      })),
    };
    await expect(
      nfcVerifier(db as any, kms as any, "table").verify({
        tag: id,
        e: "EF963FF7828658A599F3041510671E88",
        c: "94EED9EE65337086",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const tx = db.send.mock.calls.find(
      ([c]) => c.constructor.name === "TransactWriteCommand",
    )![0].input.TransactItems;
    expect(tx).toHaveLength(2);
    expect(tx[1].ConditionCheck.ConditionExpression).toContain(
      "verificationHold",
    );
    vi.unstubAllEnvs();
  });
});
describe("studio authentication", () => {
  it("requires a fresh token-bound session, not just admin group membership", async () => {
    const session = {
      userId: "admin",
      tokenHash: digest("id-token"),
      expiresAt: Date.now() / 1000 + 30,
    };
    const db = { send: vi.fn(async () => ({ Item: session })) };
    const s = studioSecurity(db as any, {} as any, "table", vi.fn(), vi.fn());
    await expect(
      s.requireSession("admin", "id-token", "a".repeat(64)),
    ).resolves.toBeUndefined();
    await expect(
      s.requireSession("admin", "another-token", "a".repeat(64)),
    ).rejects.toMatchObject({ status: 401 });
    session.expiresAt = 1;
    await expect(
      s.requireSession("admin", "id-token", "a".repeat(64)),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("does not allow password-only MFA re-enrolment after MFA was disabled", async () => {
    const db = { send: vi.fn(async () => ({ Item: { enrolledAt: 1 } })) },
      pool = {
        send: vi.fn(async () => ({
          AuthenticationResult: { IdToken: "id", AccessToken: "access" },
        })),
      };
    const s = studioSecurity(
      db as any,
      pool as any,
      "table",
      async () => ({
        sub: "admin",
        email_verified: true,
        "cognito:groups": ["admins"],
      }),
      vi.fn(),
    );
    await expect(
      s.handle("/security/login", {
        email: "admin@example.invalid",
        password: "irrelevant",
      }),
    ).rejects.toThrow("password-only");
    expect(pool.send).toHaveBeenCalledTimes(1);
  });
  it("consumes an authenticator challenge once before granting a session", async () => {
    let ticket: any = {
      kind: "totp",
      session: "cognito-session",
      username: "admin",
      expiresAt: Date.now() / 1000 + 60,
    };
    const db = {
      send: vi.fn(async (c: any) => {
        if (c.constructor.name === "DeleteCommand") {
          ticket = null;
          return {};
        }
        return { Item: ticket };
      }),
    };
    const pool = {
        send: vi.fn(async () => ({ AuthenticationResult: { IdToken: "id" } })),
      },
      commit = vi.fn();
    const s = studioSecurity(
      db as any,
      pool as any,
      "table",
      async () => ({
        sub: "admin",
        email_verified: true,
        "cognito:groups": ["admins"],
      }),
      commit,
    );
    expect(
      await s.handle("/security/respond", {
        ticket: "a".repeat(64),
        code: "123456",
      }),
    ).toMatchObject({ adminSession: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(
      s.handle("/security/respond", { ticket: "a".repeat(64), code: "123456" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
describe("fees, private data and recovery boundaries", () => {
  it("charges 0.5% to the recipient using integer cents, including gifts", () => {
    expect(transferQuote("sale", 100000, 1)).toMatchObject({
      value: 100000,
      fee: 500,
      payer: "recipient",
    });
    expect(transferQuote("gift", 1, 33900)).toMatchObject({
      value: 33900,
      fee: 170,
      basis: "last-verified-sale",
    });
    expect(() => transferQuote("gift", 100, undefined as any)).toThrow();
    expect(() => transferQuote("sale", 100.5, 1)).toThrow();
  });
  it("does not leak internal costs or review data from a revealed piece", () => {
    const out = publicRelease({
      status: "sold",
      revealMode: "now",
      artistName: "Artist",
      productionCost: 32199,
      artistCost: 12888,
      otherCost: 11777,
      costNotes: "private margin",
      fulfillment: {},
      reviewEvidence: "private",
    });
    expect(JSON.stringify(out)).not.toMatch(/32199|12888|11777|private/);
    expect(out.artistName).toBe("Artist");
  });
  it("blocks direct image access before reveal and to private evidence", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    let record: any = { releaseId: "one", kind: "artwork", status: "ready" };
    const db = {
      send: vi.fn(async (c: any) => ({
        Item: c.input.Key.pk.startsWith("MEDIA#")
          ? record
          : {
              published: true,
              designRevealMode: "at-opening",
              opensAt: Date.now() + 999999,
              image: `api/media/${id}`,
            },
      })),
    };
    const m = mediaLibrary(db as any, {} as any, "table", "bucket", vi.fn());
    await expect(m.publicImage(id)).rejects.toMatchObject({ status: 404 });
    record.kind = "evidence";
    await expect(m.publicImage(id)).rejects.toMatchObject({ status: 404 });
    expect(imageType(Buffer.from("<svg onload=alert(1)>bad</svg>"))).toBeNull();
  });
  it("never serves draft-only page images or artwork selected from another page", async () => {
    vi.stubEnv("MEDIA_API_URL", "api");
    const id = "11111111-1111-4111-8111-111111111111";
    let live: any;
    const record = {
      id,
      kind: "page",
      status: "ready",
      releaseId: "page-studio",
    };
    const db = {
      send: vi.fn(async (c: any) => ({
        Item: c.input.Key.pk.startsWith("MEDIA#") ? record : live,
      })),
    };
    const media = mediaLibrary(
      db as any,
      {} as any,
      "table",
      "bucket",
      vi.fn(),
    );
    await expect(media.publicImage(id)).rejects.toMatchObject({ status: 404 });
    live = { data: { image: "api/media/a-different-image" } };
    await expect(media.publicImage(id)).rejects.toMatchObject({ status: 404 });
    await expect(
      media.validateImage(`api/media/${id}`, "page-home"),
    ).rejects.toMatchObject({ status: 400 });
    vi.unstubAllEnvs();
  });
  it("requires a matching owner and detailed recovery evidence", async () => {
    const piece = {
      pk: "AUCTION#one",
      id: "one",
      ownerId: "owner",
      status: "sold",
    };
    const commit = vi.fn();
    const r = recoveryService(
      { send: vi.fn(async () => ({ Item: piece })) } as any,
      "table",
      commit,
    );
    await expect(
      r.handle(
        "/recovery/request",
        {
          id: "one",
          reason: "damaged-tag",
          evidence: "Detailed inspection photos and receipt",
        },
        { id: "stranger", email: "other@example.invalid", admin: false },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      r.handle(
        "/recovery/request",
        { id: "one", reason: "damaged-tag", evidence: "short" },
        { id: "owner", email: "owner@example.invalid", admin: false },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(commit).not.toHaveBeenCalled();
  });
});

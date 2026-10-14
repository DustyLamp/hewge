import { describe, it, expect, vi } from "vitest";
import { campaignService } from "../services/campaigns";
import { suppressionKey, suppressionWrite } from "../services/consent";
describe("durable engagement suppression", () => {
  it("does not revive an older account opt-in after a subscription is deleted by TTL", async () => {
    const email = "member@example.invalid",
      profile = { pk: "USER#one", email, releaseConsent: true, consentAt: 10 };
    const db = {
      send: vi.fn(async (c: any) =>
        c.constructor.name === "ScanCommand"
          ? { Items: [] }
          : {
              Item:
                c.input.Key.pk === "USER#one"
                  ? profile
                  : c.input.Key.pk === suppressionKey(email).pk
                    ? { consentAt: 20 }
                    : undefined,
            },
      ),
    };
    const service = campaignService(
      db as any,
      "accounts",
      "members",
      vi.fn(),
      async () => [profile],
    );
    expect(await service.audience()).toEqual([]);
    expect(
      await service.canSend({ kind: "release", email, profileKey: profile.pk }),
    ).toBe(false);
    profile.consentAt = 30;
    expect(await service.audience()).toHaveLength(1);
    expect(
      await service.canSend({ kind: "release", email, profileKey: profile.pk }),
    ).toBe(true);
  });
  it("keeps the suppression independent of contact retention without retaining the address", () => {
    const item = suppressionWrite("members", "member@example.invalid", 123).Put
      .Item;
    expect(item).not.toHaveProperty("expiresAt");
    expect(JSON.stringify(item)).not.toContain("member@example.invalid");
  });
  it("suppresses queued campaigns immediately after cancellation", async () => {
    const service = campaignService(
      { send: vi.fn(async () => ({ Item: { status: "cancelled" } })) } as any,
      "accounts",
      "members",
      vi.fn(),
      vi.fn(),
    );
    expect(
      await service.canSend({
        kind: "campaign",
        campaignId: "cancelled",
        email: "member@example.invalid",
      }),
    ).toBe(false);
  });
});

describe("separate SMS campaign consent", () => {
  it("does not require email marketing consent and deduplicates a shared verified number", async () => {
    const profiles = [
      {
        pk: "USER#one",
        email: "one@example.invalid",
        sizes: ["M"],
        country: "CH",
        releaseConsent: false,
      },
      {
        pk: "USER#two",
        email: "two@example.invalid",
        sizes: ["M"],
        country: "CH",
        releaseConsent: false,
      },
    ];
    const service = campaignService(
      {
        send: vi.fn(async (c: any) =>
          c.constructor.name === "ScanCommand"
            ? { Items: [] }
            : { Item: profiles.find((p) => p.pk === c.input.Key.pk) },
        ),
      } as any,
      "accounts",
      "members",
      vi.fn(),
      async () => profiles,
      {
        get: vi.fn(async () => ({
          consent: true,
          verified: true,
          phone: "+41790000000",
        })),
        campaignEnabled: async () => false,
      } as any,
    );
    expect(await service.audience({ size: "M" }, "sms")).toHaveLength(1);
    expect(await service.audience({ size: "XL" }, "sms")).toHaveLength(0);
    expect(await service.audience({}, "email")).toHaveLength(0);
    expect(
      await service.handle(
        { action: "preview", channel: "sms" },
        { id: "owner" },
      ),
    ).toMatchObject({ recipients: 1, enabled: false });
    await expect(
      service.handle(
        {
          action: "schedule",
          channel: "sms",
          subject: "Next original",
          text: "The next original opens soon.",
          sendAt: Date.now() + 60000,
        },
        { id: "owner" },
      ),
    ).rejects.toThrow(/activated/);
  });
  it("refuses multipart or non-GSM SMS content before scheduling", async () => {
    const service = campaignService(
      { send: vi.fn(async () => ({})) } as any,
      "accounts",
      "members",
      vi.fn(),
      async () => [],
      { campaignEnabled: async () => false } as any,
    );
    await expect(
      service.handle(
        { channel: "sms", subject: "Release", text: "x".repeat(71) },
        { id: "owner" },
      ),
    ).rejects.toThrow(/70/);
    await expect(
      service.handle(
        { channel: "sms", subject: "Release", text: "A new original ✨" },
        { id: "owner" },
      ),
    ).rejects.toThrow(/70/);
  });
});

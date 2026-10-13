import { describe, it, expect } from "vitest";
import {
  auctionPhase,
  minimumBid,
  validateBid,
  validateSchedule,
  swissTimestamp,
  weekLabel,
  publicRelease,
  preview,
} from "../shared/auction";
describe("auction rules", () => {
  it("accepts any chosen release day and rejects past openings", () => {
    expect(() => validateSchedule(10000, 20000, 1000)).not.toThrow();
    expect(() => validateSchedule(1000, 20000, 1000)).toThrow();
  });
  it("requires a closing time after opening", () => {
    expect(() => validateSchedule(20000, 10000, 1000)).toThrow();
    expect(() =>
      validateSchedule(10000, 10000 + 32 * 86400000, 1000),
    ).toThrow();
  });
  it("closes at the exact deadline", () => {
    const a = { status: "scheduled", opensAt: 1000, closesAt: 2000 };
    expect(auctionPhase(a, 999)).toBe("scheduled");
    expect(auctionPhase(a, 1000)).toBe("open");
    expect(auctionPhase(a, 2000)).toBe("closed");
  });
  it("does not reopen paid or payment-pending pieces", () => {
    expect(
      auctionPhase({ status: "sold", opensAt: 1000, closesAt: 2000 }, 1500),
    ).toBe("sold");
  });
  it("enforces integer centimes, opening bid and minimum increment", () => {
    expect(minimumBid(33900, null, 1000)).toBe(33900);
    expect(() =>
      validateBid(33899, { openingBid: 33900, minimumIncrement: 1000 }),
    ).toThrow();
    expect(() =>
      validateBid(33900.1, { openingBid: 33900, minimumIncrement: 1000 }),
    ).toThrow();
    expect(() =>
      validateBid(34000, {
        openingBid: 33900,
        highestBid: 33900,
        minimumIncrement: 1000,
      }),
    ).toThrow();
    expect(
      validateBid(34900, {
        openingBid: 33900,
        highestBid: 33900,
        minimumIncrement: 1000,
      }),
    ).toBe(34900);
  });
  it("handles Swiss summer and winter time, with no invented DST hour", () => {
    expect(new Date(swissTimestamp("2026-07-14T12:00")).toISOString()).toBe(
      "2026-07-14T10:00:00.000Z",
    );
    expect(new Date(swissTimestamp("2026-12-15T12:00")).toISOString()).toBe(
      "2026-12-15T11:00:00.000Z",
    );
    expect(() => swissTimestamp("2026-03-29T02:30")).toThrow();
    expect(() => swissTimestamp("2026-10-25T02:30")).toThrow();
  });
  it("uses ISO week year at the new year boundary", () => {
    expect(weekLabel(Date.parse("2027-01-01T12:00Z"))).toBe("2026 / WEEK 53");
  });
});
describe("public privacy and mystery reveals", () => {
  const a = {
    ...preview,
    name: "After Hours",
    image: "/images/shirt-front.webp",
    status: "scheduled",
    opensAt: 1000,
    closesAt: 2000,
    artistName: "Real Artist",
    artistBiography: "Private biography",
    material: "Hemp",
    winnerEmail: "private@example.invalid",
    winnerId: "user-secret",
    sessionId: "cs_private",
    highestBidderEmail: "bidder@example.invalid",
    revealMode: "after-close",
  };
  it("never serializes private collector/payment fields", () => {
    const out = JSON.stringify(publicRelease(a, 1500));
    expect(out).not.toContain("private");
    expect(out).not.toContain("user-secret");
    expect(out).not.toContain("bidder@");
  });
  it("hides the artist, biography and material until bidding closes", () => {
    const out = publicRelease(a, 1999);
    expect(out.artistName).toBe("");
    expect(out.artistBiography).toBe("");
    expect(out.material).toBe("");
    expect(out.identityRevealed).toBe(false);
    expect(publicRelease(a, 2000).artistName).toBe("Real Artist");
  });
  it("manual reveal stays secret after the auction unless explicitly revealed", () => {
    expect(publicRelease({ ...a, revealMode: "manual" }, 9000).material).toBe(
      "",
    );
    expect(
      publicRelease(
        { ...a, revealMode: "manual", identityRevealed: true },
        9000,
      ).material,
    ).toBe("Hemp");
  });
  it("withholds the garment and story in teaser mode", () => {
    const out = publicRelease({ ...a, designRevealMode: "at-opening" }, 999);
    expect(out.name).toBe("No. 001");
    expect(out.story).toBe("");
    expect(out.image).not.toBe(a.image);
    expect(
      publicRelease({ ...a, designRevealMode: "at-opening" }, 1000).name,
    ).toBe("After Hours");
  });
});

import { beforeEach, describe, it, expect, vi } from "vitest";
import { transferPayments } from "../services/transfer-payments";
const user = { id: "recipient", email: "recipient@example.invalid" };
let transfer: any,
  piece: any,
  send: any,
  commit: any,
  stripe: any,
  fees: ReturnType<typeof transferPayments>;
beforeEach(() => {
  vi.stubEnv("TRANSFER_PAYMENTS_ENABLED", "true");
  vi.stubEnv("CHECKOUT_ENABLED", "true");
  vi.stubEnv("SITE_URL", "https://hewge.design");
  transfer = {
    pk: "TRANSFER#one",
    id: "one",
    auctionId: "piece",
    fromId: "owner",
    recipientId: "recipient",
    status: "awaiting-review",
    reviewed: true,
    revision: 1,
    quote: { fee: 500, value: 100000 },
    feeStatus: "unpaid",
  };
  piece = { pk: "AUCTION#piece", ownerId: "owner", pendingTransferId: "one" };
  send = vi.fn(async (c: any) => ({
    Item: c.input.Key.pk.startsWith("TRANSFER#") ? transfer : piece,
  }));
  commit = vi.fn(async (items: any[]) => {
    const v = items[0].Update.ExpressionAttributeValues;
    if (v[":attempt"])
      Object.assign(transfer, {
        feeAttempt: v[":attempt"],
        feeStartedAt: v[":at"],
        revision: transfer.revision + 1,
      });
    if (v[":pending"])
      Object.assign(transfer, {
        feeStatus: v[":s"] || "refund-pending",
        revision: transfer.revision + 1,
      });
  });
  stripe = {
    checkout: {
      sessions: {
        create: vi.fn(async () => ({
          id: "cs_fee",
          url: "https://checkout.stripe.com/fee",
        })),
        retrieve: vi.fn(),
      },
    },
    refunds: { create: vi.fn(), retrieve: vi.fn() },
  };
  fees = transferPayments({ send } as any, "table", commit, async () => ({
    client: stripe,
  }));
});
describe("recipient fee collection and refunds", () => {
  it("charges only the immutable server quote and records the attempt before contacting Stripe", async () => {
    await fees.checkout("one", user);
    expect(
      stripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data
        .unit_amount,
    ).toBe(500);
    expect(
      stripe.checkout.sessions.create.mock.calls[0][0].metadata,
    ).toMatchObject({ transferId: "one", attempt: "1" });
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      stripe.checkout.sessions.create.mock.invocationCallOrder[0],
    );
  });
  it("requires the recipient, inspection and a clear physical verification state", async () => {
    await expect(
      fees.checkout("one", { ...user, id: "owner" }),
    ).rejects.toThrow("not ready");
    transfer.reviewed = false;
    await expect(fees.checkout("one", user)).rejects.toThrow("not ready");
    transfer.reviewed = true;
    piece.verificationHold = true;
    await expect(fees.checkout("one", user)).rejects.toThrow("not ready");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("never silently raises the agreed percentage to meet Stripe’s minimum", async () => {
    transfer.quote.fee = 20;
    await expect(fees.checkout("one", user)).rejects.toThrow(
      "has not been increased",
    );
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("retries an ambiguous creation with the same attempt and idempotency key", async () => {
    stripe.checkout.sessions.create.mockRejectedValueOnce(
      Error("network lost"),
    );
    await expect(fees.checkout("one", user)).rejects.toThrow("network lost");
    await fees.checkout("one", user);
    expect(
      stripe.checkout.sessions.create.mock.calls.map(
        (x: any) => x[1].idempotencyKey,
      ),
    ).toEqual(["transfer-fee-one-1", "transfer-fee-one-1"]);
  });
  it("does not accept client redirect, amount mismatch or stale payment attempts", async () => {
    transfer.feeAttempt = 2;
    const s: any = {
      id: "cs_fee",
      metadata: { transferId: "one", attempt: "2" },
      payment_status: "paid",
      currency: "chf",
      amount_total: 500,
      client_reference_id: "recipient",
    };
    await fees.paid({ ...s, payment_status: "unpaid" });
    expect(commit).not.toHaveBeenCalled();
    await expect(fees.paid({ ...s, amount_total: 1 })).rejects.toThrow(
      "Invalid",
    );
    await expect(
      fees.paid({ ...s, metadata: { transferId: "one", attempt: "1" } }),
    ).rejects.toThrow("Invalid");
    await fees.paid(s);
    expect(
      commit.mock.calls[0][0][0].Update.ExpressionAttributeValues[":s"],
    ).toBe("paid");
  });
  it("routes late payments on cancelled requests to refund review", async () => {
    transfer.status = "cancelled";
    transfer.feeAttempt = 1;
    await fees.paid({
      id: "cs_fee",
      metadata: { transferId: "one", attempt: "1" },
      payment_status: "paid",
      currency: "chf",
      amount_total: 500,
      client_reference_id: "recipient",
    } as any);
    expect(
      commit.mock.calls[0][0][0].Update.ExpressionAttributeValues[":s"],
    ).toBe("refund-review");
  });
  it("blocks approval before requesting a full fee refund and never refunds approved ownership", async () => {
    transfer.feeStatus = "paid";
    transfer.feeSessionId = "cs_fee";
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      payment_status: "paid",
      amount_total: 500,
      payment_intent: "pi_fee",
    });
    stripe.refunds.create.mockImplementation(async () => {
      expect(transfer.feeStatus).toBe("refund-pending");
      return {
        id: "re_fee",
        status: "succeeded",
        amount: 500,
        currency: "chf",
        metadata: { purpose: "ownership-transfer-fee", transferId: "one" },
      };
    });
    await fees.refund(
      "one",
      { id: "admin" },
      "Recipient cancelled before final approval",
    );
    expect(stripe.refunds.create.mock.calls[0][0].amount).toBe(500);
    transfer.status = "approved";
    transfer.feeStatus = "paid";
    await expect(
      fees.refund("one", { id: "admin" }, "A reviewed refund reason"),
    ).rejects.toThrow("uncompleted");
  });
});

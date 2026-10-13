import { beforeEach, describe, expect, it, vi } from "vitest";
import { ownershipRegistry } from "../services/ownership";
const send = vi.fn();
const registry = ownershipRegistry({ send } as any, "registry");
const owner = { id: "owner", email: "owner@example.invalid", admin: false };
const recipient = {
  id: "recipient",
  email: "recipient@example.invalid",
  admin: false,
};
const admin = { id: "admin", email: "admin@example.invalid", admin: true };
let piece: any, transfer: any;
const accept = {
  transferId: "transfer",
  received: true,
  feeConsent: true,
  certificateId: "CERT-1",
  hologramId: "SEAL-1",
};
const approval = {
  ...accept,
  action: "approve",
  physicalChecked: true,
  titleChecked: true,
  evidence:
    "Inspected original and signed transfer agreement, reference TEST-01",
};
const transactions = () =>
  send.mock.calls
    .filter(([c]) => c.constructor.name === "TransactWriteCommand")
    .map(([c]) => c.input.TransactItems);
beforeEach(() => {
  vi.clearAllMocks();
  piece = {
    pk: "AUCTION#piece",
    id: "piece",
    name: "Original",
    status: "sold",
    ownerId: owner.id,
    pendingTransferId: "transfer",
    certificateId: "CERT-1",
    fulfillment: {
      shippedAt: 1,
      hologramId: "SEAL-1",
      certificateSigned: true,
    },
  };
  transfer = {
    pk: "TRANSFER#transfer",
    id: "transfer",
    auctionId: "piece",
    fromId: owner.id,
    toEmail: recipient.email,
    status: "awaiting-recipient",
    revision: 1,
    deadlineAt: Date.now() + 60000,
  };
  send.mockImplementation(async (c) => {
    if (c.constructor.name === "GetCommand")
      return {
        Item: c.input.Key.pk.startsWith("TRANSFER#") ? transfer : piece,
      };
    if (c.constructor.name === "QueryCommand") return { Items: [] };
    return {};
  });
});
describe("validated ownership transfers", () => {
  it("rejects nonowners and unpaid pieces", async () => {
    await expect(
      registry.handle("/transfer/request", { id: "piece" }, recipient),
    ).rejects.toMatchObject({ status: 403 });
    piece.status = "awaiting-payment";
    await expect(
      registry.handle("/transfer/request", { id: "piece" }, owner),
    ).rejects.toMatchObject({ status: 403 });
    expect(transactions()).toHaveLength(0);
  });
  it("requires a dispatched original, signed certificate and one pending request", async () => {
    await expect(
      registry.handle("/transfer/request", { id: "piece" }, owner),
    ).rejects.toThrow("existing transfer");
    delete piece.pendingTransferId;
    delete piece.fulfillment.hologramId;
    await expect(
      registry.handle("/transfer/request", { id: "piece" }, owner),
    ).rejects.toThrow("recorded seal");
  });
  it("atomically locks the piece to a request without changing its owner", async () => {
    delete piece.pendingTransferId;
    const r = await registry.handle(
      "/transfer/request",
      {
        id: "piece",
        email: recipient.email.toUpperCase(),
        confirmed: true,
        kind: "sale",
        resaleAmount: 100000,
      },
      owner,
    );
    expect(r.id).toBeTruthy();
    const tx = transactions()[0];
    expect(tx[0].Update.ConditionExpression).toContain(
      "attribute_not_exists(pendingTransferId)",
    );
    expect(tx[0].Update.UpdateExpression).not.toContain("ownerId=");
    expect(tx[1].Put.Item.toEmail).toBe(recipient.email);
    expect(tx[1].Put.Item).not.toHaveProperty("expiresAt"); // Preserve provenance; deadline is not a deletion TTL.
  });
  it("rejects acceptance by another verified account", async () => {
    await expect(
      registry.handle("/transfer/accept", accept, owner),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("requires possession confirmation and both matching physical identifiers", async () => {
    await expect(
      registry.handle(
        "/transfer/accept",
        { ...accept, received: false },
        recipient,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      registry.handle(
        "/transfer/accept",
        { ...accept, hologramId: "COPY" },
        recipient,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(transactions()).toHaveLength(0);
  });
  it("rejects expired acceptance without releasing ownership", async () => {
    transfer.deadlineAt = 1;
    await expect(
      registry.handle("/transfer/accept", accept, recipient),
    ).rejects.toThrow("window has ended");
  });
  it("records recipient acceptance anonymously, leaving ownership unchanged", async () => {
    await registry.handle("/transfer/accept", accept, recipient);
    const tx = transactions()[0];
    expect(tx[0].ConditionCheck).toBeTruthy();
    expect(tx[1].Update.ExpressionAttributeValues[":p"]).toEqual({
      anonymous: true,
      name: null,
    });
    expect(tx[1].Update.ExpressionAttributeValues[":u"]).toBe(recipient.id);
    expect(tx[1].Update.ConditionExpression).toContain("revision=:v");
  });
  it("prevents approving before acceptance and requires actual review evidence", async () => {
    await expect(
      registry.handle("/admin/transfer", approval, admin),
    ).rejects.toThrow("recipient must accept");
    transfer.status = "awaiting-review";
    transfer.recipientId = recipient.id;
    await expect(
      registry.handle("/admin/transfer", approval, recipient),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      registry.handle("/admin/transfer", { ...approval, evidence: "" }, admin),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      registry.handle(
        "/admin/transfer",
        { ...approval, physicalChecked: false },
        admin,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("atomically changes the owner and records provenance against the pending transfer", async () => {
    Object.assign(transfer, {
      status: "awaiting-review",
      recipientId: recipient.id,
      publicOwner: { anonymous: true, name: null },
      reviewed: true,
      feeStatus: "paid",
      quote: { value: 100000, fee: 500 },
    });
    await registry.handle("/admin/transfer", approval, admin);
    const tx = transactions()[0];
    expect(tx[0].Update.ConditionExpression).toContain("pendingTransferId=:t");
    expect(tx[0].Update.ConditionExpression).toContain(
      "fulfillment.hologramId=:seal",
    );
    expect(tx[0].Update.ExpressionAttributeValues[":new"]).toBe(recipient.id);
    expect(tx[1].Update.ConditionExpression).toContain("#s=:review");
    expect(tx[2].Put.Item).toMatchObject({
      fromId: owner.id,
      toId: recipient.id,
      reviewedBy: admin.id,
    });
    expect(tx[2].Put.ConditionExpression).toBe("attribute_not_exists(pk)");
  });
  it("rejects stale ownership and repeated approval", async () => {
    piece.ownerId = recipient.id;
    await expect(
      registry.handle("/admin/transfer", approval, admin),
    ).rejects.toThrow("no longer active");
    piece.ownerId = owner.id;
    transfer.status = "approved";
    await expect(
      registry.handle("/admin/transfer", approval, admin),
    ).rejects.toThrow("no longer active");
  });
  it("cancellation frees the request without editing ownership; strangers cannot cancel", async () => {
    await expect(
      registry.handle("/transfer/cancel", accept, admin),
    ).rejects.toMatchObject({ status: 403 });
    await registry.handle("/transfer/cancel", accept, recipient);
    expect(transactions()[0][0].Update.UpdateExpression).toBe(
      "REMOVE pendingTransferId",
    );
    expect(transactions()[0][1].Update.ExpressionAttributeValues[":s"]).toBe(
      "cancelled",
    );
  });
  it("redacts all account and review information from public provenance", async () => {
    send.mockResolvedValue({
      Items: [
        {
          at: 123,
          fromId: owner.id,
          toId: recipient.id,
          reviewedBy: admin.id,
          evidence: "private",
          transferId: "secret",
        },
      ],
    });
    expect(await registry.history("piece")).toEqual([
      { at: 123, kind: "transfer" },
    ]);
  });
});

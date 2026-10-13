import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { withdrawalService } from "../services/withdrawals";
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
  termsText,
  privacyText,
} from "../shared/legal";
const send = vi.fn();
const commit = vi.fn();
const service = withdrawalService({ send } as any, "auction", commit);
const notice = {
  requestId: "39a57c9b-2bb8-4b99-9770-6d3d3e784653",
  name: "Example Collector",
  email: "collector@example.invalid",
  reference: "HEWGE-001",
  kind: "garment",
  confirmed: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({});
  commit.mockResolvedValue(undefined);
});
describe("withdrawal notices", () => {
  it("records the original notice and a transactional receipt atomically, without requiring login or marketing consent", async () => {
    const r = await service.submit(notice);
    expect(r.id).toBe(notice.requestId);
    expect(r.receipt).toContain("I withdraw from the identified contract.");
    expect(r.receipt).toContain(new Date(r.receivedAt).toISOString());
    const [changes, meta] = commit.mock.calls[0];
    expect(changes).toHaveLength(2);
    expect(changes[0].Put.Item).toMatchObject({
      status: "submitted",
      name: notice.name,
      reference: notice.reference,
      receivedAt: r.receivedAt,
    });
    expect(changes[1].Put.Item).toMatchObject({
      kind: "withdrawal",
      email: notice.email,
      text: r.receipt,
      status: "pending",
    });
    expect(JSON.stringify(meta)).not.toContain(notice.email);
    expect(JSON.stringify(meta)).not.toContain(notice.name);
    expect(
      changes.some((c: any) => c.Update?.Key.pk.startsWith("AUCTION#")),
    ).toBe(false);
  });
  it("retries without creating a second notice or losing the first receipt time", async () => {
    const first = await service.submit(notice);
    const stored = commit.mock.calls[0][0][0].Put.Item;
    send.mockResolvedValue({ Item: stored });
    expect(await service.submit(notice)).toEqual(first);
    expect(commit).toHaveBeenCalledTimes(1);
    await expect(
      service.submit({ ...notice, email: "someoneelse@example.invalid" }),
    ).rejects.toThrow("fresh withdrawal form");
  });
  it("requires explicit final confirmation but never demands a reason or an unopened garment", async () => {
    await expect(
      service.submit({ ...notice, confirmed: false }),
    ).rejects.toThrow("confirm withdrawal");
    expect(commit).not.toHaveBeenCalled();
  });
  it("protects review from ordinary accounts and preserves private review details outside the permanent event", async () => {
    await expect(
      service.review({ id: notice.requestId }, { id: "user", admin: false }),
    ).rejects.toMatchObject({ status: 403 });
    send.mockResolvedValue({ Item: { revision: 1 } });
    await service.review(
      {
        id: notice.requestId,
        status: "resolved",
        note: "QA refund reconciled, reference example",
      },
      { id: "admin", admin: true },
    );
    expect(commit.mock.calls[0][0][0].Update.ConditionExpression).toBe(
      "revision=:revision",
    );
    expect(commit.mock.calls[0][1].details).toHaveProperty("noteHash");
    expect(commit.mock.calls[0][1].details).not.toHaveProperty("note");
  });
});
describe("accepted policy snapshots", () => {
  it("keeps the downloadable accepted terms and privacy notice identical to the published source", () => {
    expect(readFileSync(`public/legal/${TERMS_VERSION}.txt`, "utf8")).toBe(
      termsText,
    );
    expect(readFileSync(`public/legal/${PRIVACY_VERSION}.txt`, "utf8")).toBe(
      privacyText,
    );
  });
});

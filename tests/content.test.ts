import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentService } from "../services/content";
import { publicRelease, preview } from "../shared/auction";
import { cleanPage } from "../shared/content";
describe("CMS publishing", () => {
  let rows: Map<string, any>,
    db: any,
    s3: any,
    commit: any,
    cms: ReturnType<typeof contentService>;
  const data = {
    title: "Studio notes",
    intro: "Introduction",
    body: "First paragraph.\n\nSecond paragraph.",
    image: "",
    imageAlt: "",
  };
  const user = { id: "admin-1" };
  beforeEach(() => {
    rows = new Map();
    db = {
      send: vi.fn(async (c: any) => ({
        Item: rows.get(c.input.Key?.sk),
        Items: [...rows.values()],
      })),
    };
    s3 = { send: vi.fn(async () => ({})) };
    commit = vi.fn(async (changes: any[]) => {
      const draft = changes[0].Put,
        old = rows.get(draft.Item.sk);
      if (
        (old?.revision || 0) !== (draft.ExpressionAttributeValues?.[":r"] || 0)
      )
        throw Object.assign(Error("concurrent edit"), {
          name: "TransactionCanceledException",
        });
      for (const c of changes) {
        if (c.Put) rows.set(c.Put.Item.sk, structuredClone(c.Put.Item));
        if (c.Delete) rows.delete(c.Delete.Key.sk);
      }
    });
    cms = contentService(db, s3, "table", "media", commit, async () => {});
  });
  it("keeps private edits private until publication and preserves drafts on unpublish", async () => {
    await cms.save({ id: "studio", revision: 0, action: "draft", data }, user);
    expect(await cms.get("studio")).toBeNull();
    await cms.save(
      { id: "studio", revision: 1, action: "publish", data },
      user,
    );
    expect((await cms.get("studio"))?.data.title).toBe("Studio notes");
    await cms.save(
      {
        id: "studio",
        revision: 2,
        action: "draft",
        data: { ...data, title: "Private title" },
      },
      user,
    );
    expect((await cms.get("studio"))?.data.title).toBe("Studio notes");
    expect((await cms.get("studio", "DRAFT"))?.data.title).toBe(
      "Private title",
    );
    expect(await cms.get("studio")).not.toHaveProperty("updatedBy");
    await cms.save(
      { id: "studio", revision: 3, action: "unpublish", data },
      user,
    );
    expect(await cms.get("studio")).toBeNull();
    expect(await cms.get("studio", "DRAFT")).not.toBeNull();
  });
  it("rejects stale and concurrent edits instead of overwriting another editor", async () => {
    const saves = await Promise.allSettled([
      cms.save({ id: "studio", revision: 0, action: "publish", data }, user),
      cms.save(
        {
          id: "studio",
          revision: 0,
          action: "publish",
          data: { ...data, title: "Second editor" },
        },
        user,
      ),
    ]);
    expect(saves.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      cms.save({ id: "studio", revision: 0, action: "draft", data }, user),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("does not publish without a durable content snapshot", async () => {
    s3.send.mockRejectedValueOnce(Error("storage unavailable"));
    await expect(
      cms.save({ id: "studio", revision: 0, action: "publish", data }, user),
    ).rejects.toThrow("storage unavailable");
    expect(commit).not.toHaveBeenCalled();
    expect(await cms.get("studio")).toBeNull();
  });
  it("records who, when, revision and snapshot hash with publication", async () => {
    await cms.save(
      { id: "studio", revision: 0, action: "publish", data },
      user,
    );
    const [, meta] = commit.mock.calls[0];
    expect(meta).toMatchObject({
      actor: "admin-1",
      entity: "page:studio",
      action: "page-publish",
      details: {
        revision: 1,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        snapshotKey: expect.stringMatching(/^content\/studio\//),
      },
    });
    expect((await cms.get("studio"))?.updatedAt).toBeGreaterThan(0);
  });
  it("discards unrecognised fields and rejects oversized or invalid content", () => {
    expect(
      cleanPage("studio", { ...data, adminSecret: "hidden" }),
    ).not.toHaveProperty("adminSecret");
    expect(() => cleanPage("../admin", data)).toThrow();
    expect(() =>
      cleanPage("studio", { ...data, body: "x".repeat(8001) }),
    ).toThrow();
  });
  it("redacts all editorial additions and galleries before a design reveal", () => {
    const result = publicRelease(
      {
        ...preview,
        number: "001",
        designRevealMode: "at-opening",
        opensAt: 2000,
        subtitle: "secret",
        storyHeading: "secret",
        description: "secret",
        imageNote: "secret",
        gallery: [{ image: "secret", label: "secret" }],
      },
      1000,
    );
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.gallery).toEqual([]);
  });
});

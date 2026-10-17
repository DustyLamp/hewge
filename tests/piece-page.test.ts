import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { piecePageService, renderPiecePage } from "../services/piece-page";
import { preview } from "../shared/auction";

const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const piece = {
  ...preview,
  id: "one",
  slug: "after-hours",
  number: "001",
  name: "After Hours",
  published: true,
  image: "/images/shirt-front.webp",
  description: 'Six panels. "A night out."',
  story: "The invitation.\n\nThe morning after.",
  artistName: "Private artist",
  material: "Private material",
  presentation: "design-study",
};

describe("piece HTML and sharing", () => {
  it("replaces homepage metadata with escaped piece metadata and preserves the app", () => {
    const html = renderPiecePage(shell, piece, "https://hewge.design");
    expect(html).toContain("<title>After Hours — HEWGE</title>");
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html).toContain('href="https://hewge.design/pieces/after-hours"');
    expect(html).toContain(
      'content="Design study. Six panels. &quot;A night out.&quot;"',
    );
    expect(html).toContain('<script type="module" src="/src/main.tsx">');
    expect(html).toContain("<p>The morning after.</p>");
    expect(html).not.toContain('rel="preload" href="/images/');
    expect(html).not.toContain("Private artist");
    expect(html).not.toContain("Private material");
  });
  it("keeps a withheld design out of all metadata and initial content", () => {
    const html = renderPiecePage(
      shell,
      {
        ...piece,
        designRevealMode: "at-opening",
        opensAt: Date.now() + 100000,
      },
      "https://hewge.design",
    );
    for (const withheld of [
      "After Hours",
      "Six panels",
      "The invitation",
      "shirt-front",
      "Private artist",
      "Private material",
    ])
      expect(html).not.toContain(withheld);
    expect(html).toContain(
      'content="https://hewge.design/images/foliage.webp"',
    );
  });
  it("cannot inject markup from editorial content", () => {
    const html = renderPiecePage(
      shell,
      {
        ...piece,
        name: "</title><script>alert(1)</script>",
        story: '<img src=x onerror="alert(2)">',
      },
      "https://hewge.design",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
  it("re-reads publication on every request and fails closed on stale slugs", async () => {
    let current = { ...piece };
    const get = vi.fn(async (_pk: string, sk: string) =>
      sk === "SLUG" ? { auctionId: "one" } : current,
    );
    const page = piecePageService(
      get,
      "https://hewge.design",
      async () => shell,
    );
    expect((await page("after-hours")).statusCode).toBe(200);
    current.published = false;
    const withdrawn = await page("after-hours");
    expect(withdrawn.statusCode).toBe(404);
    expect(withdrawn.body).not.toContain("After Hours");
    current.published = true;
    current.slug = "new-slug";
    expect((await page("after-hours")).statusCode).toBe(404);
  });
  it("returns non-cacheable errors without leaking records", async () => {
    const get = vi.fn(async (_pk: string, sk: string) =>
      sk === "SLUG" ? { auctionId: "one" } : piece,
    );
    const page = piecePageService(get, "https://hewge.design", async () => {
      throw Error("network");
    });
    expect(await page("after-hours")).toMatchObject({
      statusCode: 503,
      headers: { "Cache-Control": "no-store" },
    });
    get.mockClear();
    expect((await page("../private")).statusCode).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
});

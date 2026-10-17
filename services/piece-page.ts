import { publicRelease } from "../shared/auction";

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

// Render from the same redacted, current record as the public API. Never store a
// generated piece page: a reveal or withdrawal must take effect without a build.
export function renderPiecePage(
  shell: string,
  item: Record<string, any>,
  site: string,
) {
  const release = publicRelease(item);
  const title = `${release.name} — HEWGE`;
  const description = release.designHidden
    ? `Piece No. ${release.number}. Details at reveal.`
    : [
        release.presentation === "design-study" ? "Design study." : "",
        release.description || release.subtitle || "An original by Hewge.",
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .slice(0, 300);
  const url = `${site}/pieces/${encodeURIComponent(release.slug)}`;
  const image = new URL(release.image, site).href;
  const metadata = `<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}"/>
<link rel="canonical" href="${escapeHtml(url)}"/>
<meta property="og:title" content="${escapeHtml(title)}"/>
<meta property="og:description" content="${escapeHtml(description)}"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="${escapeHtml(url)}"/>
<meta property="og:image" content="${escapeHtml(image)}"/>
<meta property="og:image:alt" content="${escapeHtml(release.name)}"/>
<meta name="twitter:card" content="summary_large_image"/>`;
  const fallback = `<main class="article-page"><a class="wordmark" href="/">HEWGE</a><p>Piece No. ${escapeHtml(release.number)}</p><h1>${escapeHtml(release.name)}</h1><p>${escapeHtml(description)}</p>${release.story
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("")}<a href="/#first-access">Join Hewge</a></main>`;
  return (
    shell
      .replace(/<title>[\s\S]*?<\/title>/gi, "")
      .replace(
        /<meta\b[^>]*(?:name="(?:description|twitter:[^"]*)"|property="og:[^"]*")[^>]*>/gi,
        "",
      )
      .replace(/<link\b[^>]*rel="canonical"[^>]*>/gi, "")
      // The home image preload would otherwise reveal the first piece on every page.
      .replace(/<link\b[^>]*as="image"[^>]*>/gi, "")
      .replace("</head>", `${metadata}</head>`)
      .replace('<div id="root"></div>', `<div id="root">${fallback}</div>`)
  );
}

export function piecePageService(
  get: (pk: string, sk: string) => Promise<Record<string, any> | undefined>,
  site: string,
  fetchShell: () => Promise<string>,
) {
  return async (slug: string) => {
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    const missing = {
      statusCode: 404,
      headers: { ...headers, "X-Robots-Tag": "noindex" },
      body: '<!doctype html><html lang="en"><title>Piece not found — HEWGE</title><h1>Piece not found.</h1><a href="/">Hewge</a></html>',
    };
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) return missing;
    const alias = await get(`SLUG#${slug}`, "SLUG");
    const item = alias
      ? await get(`AUCTION#${alias.auctionId}`, "HEAD")
      : undefined;
    if (item?.published !== true || item.slug !== slug) return missing;
    try {
      const shell = await fetchShell();
      if (
        !shell.includes('<div id="root"></div>') ||
        !shell.includes("</head>")
      )
        throw Error("Invalid application shell");
      return {
        statusCode: 200,
        headers,
        body: renderPiecePage(shell, item, site),
      };
    } catch {
      return {
        statusCode: 503,
        headers: { ...headers, "Retry-After": "30", "X-Robots-Tag": "noindex" },
        body: '<!doctype html><html lang="en"><title>HEWGE</title><p>The piece is temporarily unavailable. Please refresh.</p><a href="/">Hewge</a></html>',
      };
    }
  };
}

import { useEffect, useState } from "react";
import { api } from "./api";
import {
  contentFields,
  type PageContent,
  type ContentPage,
} from "../shared/content";
import { ImageUpload } from "./studio";
import { FullStops, PieceTitle } from "./typography";

export function ContentPanel({
  pages,
  auctions,
  refresh,
}: {
  pages: any[];
  auctions: any[];
  refresh: () => void;
}) {
  const [id, setId] = useState("home"),
    [newId, setNewId] = useState("");
  const [data, setData] = useState<PageContent>({}),
    [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    const page = pages.find((p) => p.sk === `DRAFT#${id}`);
    setData(
      Object.fromEntries(
        contentFields(id).map(([key]) => [key, page?.data[key] || ""]),
      ),
    );
    setRevision(page?.revision || 0);
  }, [id, pages]);
  return (
    <section className="studio-panel">
      <h2>Pages & homepage</h2>
      <p>
        Save privately, then publish when ready. Publishing updates the site
        without a deployment. Piece names, prices and stories come from
        Releases.
      </p>
      <div className="release-selector">
        {[...new Set(["home", ...pages.map((p) => p.id)])].map((page) => (
          <button
            key={page}
            aria-pressed={id === page}
            onClick={() => setId(page)}
          >
            {page}
          </button>
        ))}
      </div>
      <form
        className="two-fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (/^[a-z0-9-]{1,80}$/.test(newId)) {
            setId(newId);
            setMessage("");
          }
        }}
      >
        <label>
          New page slug
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            pattern="[a-z0-9-]{1,80}"
            required
            placeholder="the-studio"
          />
        </label>
        <button className="quiet-button">Create page</button>
      </form>
      <p>
        {id === "home" ? "Homepage /" : `/pages/${id}`} · Draft revision{" "}
        {revision} ·{" "}
        <a
          href={id === "home" ? "/" : `/pages/${id}`}
          target="_blank"
          rel="noopener"
        >
          View published page ↗
        </a>
      </p>
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
            "value",
          );
          try {
            await api("/admin/content", { id, data, revision, action });
            setMessage(
              action === "publish"
                ? "Published. The site now uses this version."
                : action === "unpublish"
                  ? "Page unpublished. The draft and history remain."
                  : "Draft saved. The published page is unchanged.",
            );
            refresh();
          } catch (e) {
            setMessage(e instanceof Error ? e.message : "Save failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {contentFields(id).map(([key, label]) => (
          <label key={key}>
            {label}
            {key === "featuredReleaseId" ? (
              <select
                aria-label={label}
                value={data[key] || ""}
                onChange={(e) => setData({ ...data, [key]: e.target.value })}
                required
              >
                <option value="">Choose a published piece</option>
                {auctions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.published ? "published" : "private"}
                  </option>
                ))}
              </select>
            ) : (
              <textarea
                aria-label={label}
                rows={key === "body" ? 10 : 2}
                maxLength={key === "body" ? 8000 : 1200}
                value={data[key] || ""}
                onChange={(e) => setData({ ...data, [key]: e.target.value })}
              />
            )}
          </label>
        ))}
        <div className="studio-actions">
          <button className="button button-dark" value="draft" disabled={busy}>
            Save private draft
          </button>
          <button
            className="button button-dark"
            value="publish"
            disabled={busy}
          >
            Publish page
          </button>
          {id !== "home" && (
            <button className="text-link" value="unpublish" disabled={busy}>
              Unpublish page
            </button>
          )}
        </div>
      </form>
      <ImageUpload
        releaseId={`page-${id}`}
        kind="page"
        onUploaded={(image) =>
          setData((d) => ({
            ...d,
            [id === "home" ? "guestImage" : "image"]: image,
          }))
        }
      />
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
      <p className="fine-print">
        Every save records the administrator, UTC time, revision and content
        hash, with a versioned S3 snapshot. Audit entity: page:{id}. Auction
        rules and accepted legal versions remain controlled releases.
      </p>
      <details>
        <summary>Draft preview</summary>
        {contentFields(id)
          .filter(
            ([key]) =>
              !key.toLowerCase().includes("image") &&
              key !== "featuredReleaseId",
          )
          .map(([key, label]) => (
            <div key={key}>
              <strong>{label}</strong>
              <p className="cms-lines">
                <FullStops>{data[key]}</FullStops>
              </p>
            </div>
          ))}
      </details>
    </section>
  );
}

export function EditorialPage() {
  const [page, setPage] = useState<ContentPage | null>(null),
    [message, setMessage] = useState("Loading…");
  useEffect(() => {
    api(`/content/${location.pathname.split("/")[2]}`)
      .then((r) => {
        setPage(r.page);
        document.title = `${r.page.data.title} — HEWGE`;
      })
      .catch((e) => setMessage(e.message));
  }, []);
  if (!page)
    return (
      <main className="page-shell">
        <p role="status">{message}</p>
      </main>
    );
  return (
    <main className="article-page">
      <section className="article-title">
        <span className="eyebrow">THE HEWGE JOURNAL</span>
        <h1 className="piece-title">
          <PieceTitle name={page.data.title} />
        </h1>
        <p>
          <FullStops>{page.data.intro}</FullStops>
        </p>
      </section>
      {page.data.image && (
        <figure className="wide-art">
          <img src={page.data.image} alt={page.data.imageAlt} />
        </figure>
      )}
      <section className="cms-body">
        {page.data.body.split(/\n\s*\n/).map((p, i) => (
          <p className="cms-lines" key={i}>
            <FullStops>{p}</FullStops>
          </p>
        ))}
      </section>
    </main>
  );
}

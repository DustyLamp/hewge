import { useState, useEffect, type FormEvent } from "react";
import { api } from "./api";
import { swissTimestamp } from "../shared/auction";
import { FullStops } from "./typography";
const error = (e: unknown) =>
  e instanceof Error ? e.message : "Please try again.";
const money = (n: number) => `CHF ${(n / 100).toFixed(2)}`;
export function StudioLogin({ onLogin }: { onLogin: () => void }) {
  const [step, setStep] = useState<any>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const f = new FormData(e.currentTarget);
    try {
      const r = await api(
        step ? "/security/respond" : "/security/login",
        step
          ? { ticket: step.ticket, code: f.get("code") }
          : { email: f.get("email"), password: f.get("password") },
      );
      if (r.challenge) setStep(r);
      else {
        sessionStorage.setItem("hewge-token", r.idToken);
        sessionStorage.setItem("hewge-studio", r.adminSession);
        onLogin();
      }
    } catch (e) {
      setMessage(error(e));
      setStep(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="studio-login page-shell">
      <span className="eyebrow">PRIVATE / HEWGE STUDIO</span>
      <h1>
        Studio<FullStops>.</FullStops>
      </h1>
      <p>Sign in with your verified owner account and authenticator.</p>
      <form className="stack-form" onSubmit={submit}>
        {!step ? (
          <>
            <label>
              Email
              <input
                type="email"
                name="email"
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
              />
            </label>
            <a href="/account">Create, verify or recover your account →</a>
          </>
        ) : (
          <>
            {step.challenge === "setup" && (
              <div className="security-setup">
                <p>
                  Add a time-based account called “Hewge studio” in your
                  authenticator using this setup key. Keep its recovery copy
                  somewhere secure.
                </p>
                <code>{step.secret}</code>
              </div>
            )}
            <label>
              Authenticator code
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
              />
            </label>
          </>
        )}
        <button className="button button-dark" disabled={busy}>
          {busy ? "Checking…" : step ? "Verify authenticator" : "Sign in"}
        </button>
      </form>
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
      <p className="fine-print">
        Studio sessions expire after 15 minutes. Lost authenticators require a
        reviewed account recovery.
      </p>
    </section>
  );
}
export function ImageUpload({
  releaseId,
  kind = "artwork",
  onUploaded,
}: {
  releaseId: string;
  kind?: "artwork" | "evidence" | "page";
  onUploaded?: (url: string) => void;
}) {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage("Uploading…");
    try {
      const r = await api("/admin/media/upload", {
        releaseId,
        kind,
        name: file.name,
        contentType: file.type,
        size: file.size,
      });
      const put = await fetch(r.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type, "If-None-Match": "*" },
        body: file,
      });
      if (!put.ok)
        throw Error("Image upload failed. Select the file to retry.");
      const done = await api("/admin/media/complete", { id: r.id });
      onUploaded?.(done.image);
      setMessage(
        kind === "evidence"
          ? `Private evidence saved: ${r.id}`
          : kind === "page"
            ? "Image ready. Publish the page to use it."
            : "Image ready. Save the release to use it.",
      );
    } catch (e) {
      setMessage(error(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="upload-control">
      <label>
        {kind === "evidence"
          ? "Private inspection photograph"
          : "Upload artwork"}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy || !releaseId}
          onChange={(e) => upload(e.target.files?.[0])}
        />
      </label>
      <small>
        JPEG, PNG or WebP · up to 12 MB ·{" "}
        {kind === "artwork"
          ? "private until the published design reveal"
          : kind === "page"
            ? "private until the page is published"
            : "never public"}
      </small>
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </div>
  );
}
export function MediaPanel({
  items,
  auctions,
}: {
  items: any[];
  auctions: any[];
}) {
  const [release, setRelease] = useState(auctions[0]?.id || ""),
    [kind, setKind] = useState<"artwork" | "evidence">("artwork"),
    [preview, setPreview] = useState(""),
    [message, setMessage] = useState("");
  return (
    <section className="studio-panel">
      <h2>Media library</h2>
      <label>
        Piece
        <select value={release} onChange={(e) => setRelease(e.target.value)}>
          <option value="">Choose a piece</option>
          {auctions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.number} / {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Purpose
        <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="artwork">Release artwork</option>
          <option value="evidence">Private inspection evidence</option>
        </select>
      </label>
      <ImageUpload releaseId={release} kind={kind} />
      <p>Refresh the studio after uploading to see new library entries.</p>
      <div className="media-list">
        {items
          .filter((m) => !release || m.releaseId === release)
          .map((m) => (
            <article key={m.id}>
              <strong>{m.name}</strong>
              <p>
                {m.kind} · {Math.ceil(m.size / 1024)} KB
              </p>
              <code>{m.id}</code>
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  api("/admin/media/read", { id: m.id })
                    .then((r) => setPreview(r.url))
                    .catch((e) => setMessage(error(e)))
                }
              >
                Preview privately
              </button>
            </article>
          ))}
      </div>
      {preview && (
        <img
          className="studio-preview"
          src={preview}
          alt="Private media preview"
        />
      )}
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </section>
  );
}
export function AuditPanel({ auctions }: { auctions: any[] }) {
  const [entity, setEntity] = useState(`piece:${auctions[0]?.id || ""}`),
    [events, setEvents] = useState<any[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const r = await api("/admin/audit", { entity, verify: true });
      setEvents(r.events);
      setMessage(
        `${r.verification.events} events checked; ${r.verification.archivedReceipts} protected receipts verified. ${r.pendingReceipts} receipts pending across the ledger. Records have no expiry.`,
      );
    } catch (e) {
      setMessage(error(e));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    try {
      let cursor = null;
      const all: any[] = [];
      do {
        const r: any = await api("/admin/audit", {
          entity,
          cursor,
          verify: true,
        });
        all.push(...r.events);
        cursor = r.cursor;
      } while (cursor);
      const blob = new Blob(
        [
          all
            .reverse()
            .map((e) => JSON.stringify(e))
            .join("\n") + "\n",
        ],
        { type: "application/x-ndjson" },
      );
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `hewge-audit-${entity.replace(/[^a-z0-9-]/gi, "-")}.ndjson`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMessage(error(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="studio-panel">
      <h2>Permanent audit trail</h2>
      <p>
        Every event has a sequence, a previous-event hash and an immutable
        archive. Corrections add events; they do not replace history.
      </p>
      <label>
        Record
        <input
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          placeholder="piece:piece-id or release:piece-id"
        />
      </label>
      <div className="two-fields">
        <button className="button button-dark" disabled={busy} onClick={load}>
          View history
        </button>
        <button
          className="button button-dark"
          disabled={busy}
          onClick={download}
        >
          Export complete history
        </button>
      </div>
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
      <ol className="audit-events">
        {events.map((e) => (
          <li key={e.id}>
            <strong>
              {e.sequence} · {e.action}
            </strong>
            <p>
              {new Date(e.at).toLocaleString("en-CH")} · Actor{" "}
              {e.actor.slice(0, 12)}
            </p>
            <code>{e.hash}</code>
            <small>Previous: {e.previousHash || "First event"}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}
export function RecoveryPanel({
  cases,
  call,
  busy,
}: {
  cases: any[];
  call: (path: string, body: any) => Promise<void>;
  busy: boolean;
}) {
  return (
    <section className="studio-panel">
      <h2>Identifier recovery</h2>
      <p>
        Ownership survives a damaged tag. Inspect the garment, artist record and
        supporting evidence before replacing an identifier. Replaced tags are
        revoked.
      </p>
      {!cases.length && <p>No recovery requests.</p>}
      {cases.map((r) => (
        <article className="transfer-card" key={r.id}>
          <h3>{r.name}</h3>
          <p>
            {r.reason} · {r.status}
          </p>
          <p>{r.evidence}</p>
          {r.status === "awaiting-review" && (
            <form
              className="stack-form"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                call("/admin/recovery", {
                  caseId: r.id,
                  action: (
                    e.nativeEvent as SubmitEvent
                  ).submitter?.getAttribute("value"),
                  newTagId: f.get("newTagId"),
                  e: f.get("encryptedProof"),
                  c: f.get("macProof"),
                  newSeal: f.get("newSeal"),
                  evidence: f.get("evidence"),
                  physicalChecked: f.has("physicalChecked"),
                  titleChecked: f.has("titleChecked"),
                  reissueCertificate: f.has("reissueCertificate"),
                  artistSigned: f.has("artistSigned"),
                });
              }}
            >
              <ImageUpload releaseId={r.pieceId} kind="evidence" />
              <label>
                Inspection and entitlement evidence reference
                <textarea name="evidence" minLength={20} required />
              </label>
              <label>
                Provisioned replacement tag ID
                <input name="newTagId" />
              </label>
              <label>
                Fresh replacement tag proof · e
                <input name="encryptedProof" autoComplete="off" />
              </label>
              <label>
                Fresh replacement tag proof · c
                <input name="macProof" autoComplete="off" />
              </label>
              <label>
                Replacement seal number
                <input name="newSeal" />
              </label>
              {[
                [
                  "physicalChecked",
                  "I inspected the physical original against the preserved photographs.",
                ],
                [
                  "titleChecked",
                  "I checked the owner and provenance; disputes are resolved.",
                ],
                [
                  "reissueCertificate",
                  "Issue a replacement certificate version.",
                ],
                [
                  "artistSigned",
                  "The artist signed the replacement certificate.",
                ],
              ].map(([name, label]) => (
                <label className="check-row" key={name}>
                  <input
                    type="checkbox"
                    name={name}
                    required={["physicalChecked", "titleChecked"].includes(
                      name,
                    )}
                  />
                  {label}
                </label>
              ))}
              <button
                className="button button-dark"
                value="resolve"
                disabled={busy}
              >
                Approve recovery
              </button>
              <button className="text-link" value="reject" disabled={busy}>
                Reject · keep verification hold
              </button>
            </form>
          )}
        </article>
      ))}
    </section>
  );
}
export function EngagementPanel({
  campaigns,
  call,
  busy,
  enabled,
}: {
  campaigns: any[];
  call: (path: string, body: any) => Promise<void>;
  busy: boolean;
  enabled: boolean;
}) {
  const [draft, setDraft] = useState<any>({}),
    [preview, setPreview] = useState("");
  return (
    <section className="studio-panel">
      <h2>Member communications</h2>
      <p>
        Only verified, opted-in members are eligible. Consent is checked again
        before delivery.
      </p>
      <p>
        {enabled
          ? "Scheduled email is enabled."
          : "Email delivery is awaiting activation. You can prepare drafts and preview audiences."}
      </p>
      <div className="release-selector">
        <button onClick={() => setDraft({})}>New message</button>
        {campaigns.map((c) => (
          <button key={c.id} onClick={() => setDraft(c)}>
            {c.subject} / {c.status}
          </button>
        ))}
      </div>
      <form
        key={draft.id || "new"}
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget),
            action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
              "value",
            );
          try {
            const body = {
              id: draft.id,
              action,
              subject: f.get("subject"),
              text: f.get("text"),
              size: f.get("size"),
              country: f.get("country"),
              sendAt:
                action === "schedule"
                  ? swissTimestamp(String(f.get("sendAt")))
                  : undefined,
            };
            if (action === "preview")
              api("/admin/campaign", body)
                .then((r) => setPreview(`${r.recipients} eligible recipients`))
                .catch((e) => setPreview(error(e)));
            else call("/admin/campaign", body);
          } catch (e) {
            setPreview(error(e));
          }
        }}
      >
        <label>
          Subject
          <input
            name="subject"
            maxLength={120}
            defaultValue={draft.subject}
            required
          />
        </label>
        <label>
          Message
          <textarea
            name="text"
            rows={7}
            minLength={10}
            maxLength={4000}
            defaultValue={draft.text}
            required
          />
        </label>
        <div className="two-fields">
          <label>
            Size interest
            <select name="size" defaultValue={draft.segment?.size || ""}>
              <option value="">All sizes</option>
              {["XS", "S", "M", "L", "XL", "XXL"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Country code
            <input
              name="country"
              maxLength={2}
              placeholder="All countries"
              defaultValue={draft.segment?.country}
            />
          </label>
          <label>
            Send at · Switzerland
            <input name="sendAt" type="datetime-local" />
          </label>
        </div>
        <p role="status">{preview}</p>
        <div className="studio-actions">
          <button
            type="submit"
            value="preview"
            className="text-link"
            disabled={busy}
          >
            Preview audience
          </button>
          <button value="draft" className="button button-dark" disabled={busy}>
            Save draft
          </button>
          <button
            value="schedule"
            className="button button-dark"
            disabled={busy || !enabled}
          >
            Schedule message
          </button>
        </div>
      </form>
      {draft.id && ["scheduled", "queued"].includes(draft.status) && (
        <button
          className="text-link"
          disabled={busy}
          onClick={() =>
            call("/admin/campaign", { id: draft.id, action: "cancel" })
          }
        >
          Cancel unsent messages
        </button>
      )}
    </section>
  );
}
export function SecurityPanel({ security }: { security: any }) {
  return (
    <section className="studio-panel">
      <h2>Security & continuity</h2>
      <dl className="security-details">
        <dt>Admin access</dt>
        <dd>Authenticator required · 15-minute sessions</dd>
        <dt>Ownership authority</dt>
        <dd>
          DynamoDB · Stockholm · strong reads and conditional transactions
        </dd>
        <dt>Provenance</dt>
        <dd>
          Non-expiring records · legal hold · renewable 100-year compliance
          retention
        </dd>
        <dt>Recovery</dt>
        <dd>
          Point-in-time recovery and daily protected backups. Regional outages
          pause transfers safely.
        </dd>
        <dt>Transfer fee</dt>
        <dd>
          0.5% · paid by recipient ·{" "}
          {security.transferPaymentsEnabled
            ? "payments enabled"
            : "payments awaiting activation"}
        </dd>
        <dt>Secure NFC</dt>
        <dd>
          {security.nfcEnabled
            ? "Enabled for commissioned tags"
            : "Awaiting physical tag commissioning"}
        </dd>
      </dl>
      <p>
        See the recovery runbook for restore checks, lost authenticators,
        permanent exports and account succession.
      </p>
    </section>
  );
}
export function NfcPage() {
  const [proof] = useState(() =>
      Object.fromEntries(new URLSearchParams(location.hash.slice(1))),
    ),
    [result, setResult] = useState<any>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    history.replaceState(null, "", location.pathname);
  }, []);
  return (
    <main className="page-shell">
      <span className="eyebrow">HEWGE / TAG VERIFICATION</span>
      <h1>
        Check the original<FullStops>.</FullStops>
      </h1>
      <p>
        <FullStops>
          A fresh tag proof verifies the registered chip. Hewge’s physical
          inspection and provenance establish the garment’s identity.
        </FullStops>
      </p>
      <button
        className="button button-dark"
        disabled={busy || !!result}
        onClick={async () => {
          setBusy(true);
          try {
            setResult(await api("/verify/nfc", proof));
          } catch (e) {
            setMessage(error(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Verify this tap
      </button>
      {result && (
        <>
          <p>
            <FullStops>{result.message}</FullStops>
          </p>
          <a href={`/registry/${result.pieceId}`}>View the register →</a>
        </>
      )}
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
      <p>
        <FullStops>
          Damaged identifier? Sign in to your collection and request a reviewed
          replacement.
        </FullStops>
      </p>
      <a href="/account">Your collection →</a>
    </main>
  );
}

export function AuthenticityPanel({
  auctions,
  call,
  busy,
}: {
  auctions: any[];
  call: (path: string, body: any) => Promise<void>;
  busy: boolean;
}) {
  const [message, setMessage] = useState("");
  return (
    <section className="studio-panel">
      <h2>Physical authenticity</h2>
      <p>
        Use a distinct secure chip for each garment. Keep the artist-signed
        certificate, recorded seal and inspection photographs with the permanent
        piece record. An optional second chip must have its own keys.
      </p>
      <p>
        Program and register tag keys with the provisioning tool, then
        commission the tag here before dispatch. Dispatched originals use the
        recovery process.
      </p>
      <form
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            const p = Object.fromEntries(
              new URLSearchParams(
                new URL(String(f.get("proofUrl"))).hash.slice(1),
              ),
            );
            if (!p.tag || !p.e || !p.c)
              throw Error(
                "Paste the complete fresh tag URL, including its fragment.",
              );
            call("/admin/tag", {
              tagId: p.tag,
              e: p.e,
              c: p.c,
              evidence: f.get("evidence"),
              physicalChecked: f.has("physicalChecked"),
              artistSigned: f.has("artistSigned"),
            });
          } catch (e) {
            setMessage(error(e));
          }
        }}
      >
        <label>
          Fresh tag URL
          <input name="proofUrl" type="url" autoComplete="off" required />
        </label>
        <label>
          Physical inspection and signed certificate reference
          <textarea name="evidence" minLength={20} required />
        </label>
        <label className="check-row">
          <input name="physicalChecked" type="checkbox" required />I inspected
          the tag attachment and original against the recorded photographs.
        </label>
        <label className="check-row">
          <input name="artistSigned" type="checkbox" required />I checked the
          artist-signed certificate.
        </label>
        <button className="button button-dark" disabled={busy}>
          Commission secure tag
        </button>
        <p role="status">
          <FullStops>{message}</FullStops>
        </p>
      </form>
      <div className="media-list">
        {auctions
          .filter((a) => a.tagIds?.length)
          .map((a) => (
            <article key={a.id}>
              <h3>{a.name}</h3>
              <p>
                {a.verificationHold
                  ? "Verification on hold"
                  : "Registered tags"}
              </p>
              {a.tagIds.map((id: string) => (
                <code key={id}>{id}</code>
              ))}
            </article>
          ))}
      </div>
    </section>
  );
}

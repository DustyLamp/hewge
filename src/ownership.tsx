import { FullStops } from "./typography";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : "Please try again.";
const date = (at: number) =>
  new Intl.DateTimeFormat("en-CH", {
    dateStyle: "long",
    timeZone: "Europe/Zurich",
  }).format(at);

export function TransferRequest({
  piece,
  reload,
}: {
  piece: any;
  reload: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await api("/transfer/request", {
        id: piece.id,
        email: f.get("email"),
        confirmed: f.has("confirmed"),
      });
      setMessage(
        "Requested. Ask the recipient to sign in at hewge.design/account with that email. No invitation email has been sent.",
      );
      reload();
    } catch (e) {
      setMessage(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="transfer-request">
      <summary>Pass on the original →</summary>
      <p>
        <FullStops>{"You request. They accept. Hewge verifies."}</FullStops>
      </p>
      {piece.pendingTransferId ? (
        <p>
          <FullStops>{"A transfer is in progress. Manage it below."}</FullStops>
        </p>
      ) : (
        <form className="stack-form" onSubmit={submit}>
          <label>
            New owner’s email
            <input
              name="email"
              type="email"
              autoComplete="off"
              required
              maxLength={254}
            />
          </label>
          <label className="check-row">
            <input name="confirmed" type="checkbox" required />
            <FullStops>
              {"I own this original and am entitled to transfer it."}
            </FullStops>
          </label>
          <p className="fine-print">
            <FullStops>
              {
                "The recipient must confirm possession of the garment and certificate. Your registration stays in place until Hewge approves the transfer. This does not process a resale payment."
              }
            </FullStops>
          </p>
          <button className="button button-dark" disabled={busy}>
            <FullStops>{busy ? "Requesting…" : "Request transfer"}</FullStops>
          </button>
        </form>
      )}
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </details>
  );
}

export function TransferList({
  transfers,
  reload,
}: {
  transfers: any[];
  reload: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function call(path: string, body: any) {
    setBusy(true);
    setMessage("");
    try {
      await api(path, body);
      reload();
      setMessage(
        path.endsWith("accept")
          ? "Accepted. Hewge will review the transfer before changing the register."
          : "Transfer cancelled.",
      );
    } catch (e) {
      setMessage(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  if (!transfers.length) return null;
  return (
    <section className="transfer-list">
      <h2>
        <FullStops>{"Ownership transfers."}</FullStops>
      </h2>
      {transfers.map((t) => {
        const active = ["awaiting-recipient", "awaiting-review"].includes(
          t.status,
        );
        const expired =
          t.status === "awaiting-recipient" && t.deadlineAt <= Date.now();
        return (
          <article className="transfer-card" key={t.id}>
            <span className="eyebrow">
              <FullStops>
                {t.outgoing ? "Passing it on" : "Your next original"}
              </FullStops>
            </span>
            <h3>
              <FullStops>{t.name}</FullStops>
            </h3>
            <p>
              <FullStops>
                {expired
                  ? "Acceptance window ended"
                  : t.status.replaceAll("-", " ")}
              </FullStops>
              <FullStops>{t.recipient ? ` · ${t.recipient}` : ""}</FullStops>
            </p>

            {t.outgoing && t.status === "awaiting-recipient" && !expired && (
              <p>
                Ask the recipient to sign in at{" "}
                <a href="/account">hewge.design/account</a> using the email
                above, by <FullStops>{date(t.deadlineAt)}</FullStops>
                <FullStops>{"."}</FullStops>
              </p>
            )}

            {!t.outgoing && t.status === "awaiting-recipient" && !expired && (
              <form
                className="stack-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  call("/transfer/accept", {
                    transferId: t.id,
                    certificateId: f.get("certificateId"),
                    hologramId: f.get("hologramId"),
                    received: f.has("received"),
                    anonymous: f.get("visibility") === "anonymous",
                    name: f.get("name"),
                  });
                }}
              >
                <label>
                  Certificate number
                  <input name="certificateId" required maxLength={80} />
                </label>
                <label>
                  Garment seal number
                  <input name="hologramId" required maxLength={80} />
                </label>
                <label>
                  In the public archive
                  <select name="visibility" defaultValue="anonymous">
                    <option value="anonymous">anonymous bidder</option>
                    <option value="public">Use my chosen name</option>
                  </select>
                </label>
                <label>
                  Public name (if chosen)
                  <input name="name" maxLength={80} />
                </label>
                <label className="check-row">
                  <input name="received" type="checkbox" required />I have
                  received this garment and its original certificate, and agree
                  to the <a href="/terms">transfer terms</a>
                  <FullStops>{"."}</FullStops>
                </label>
                <button className="button button-dark" disabled={busy}>
                  Accept for Hewge review
                </button>
              </form>
            )}
            {t.status === "awaiting-review" && (
              <p>
                <FullStops>
                  {"Accepted. Awaiting Hewge’s physical and provenance checks."}
                </FullStops>
              </p>
            )}
            {t.status === "approved" && (
              <a href={`/registry/${t.auctionId}`}>
                View the updated register →
              </a>
            )}
            {active && (
              <button
                className="text-link"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Cancel this transfer? The registered owner will stay the same.",
                    )
                  )
                    call("/transfer/cancel", { transferId: t.id });
                }}
              >
                <FullStops>
                  {t.outgoing ? "Cancel transfer" : "Decline transfer"}
                </FullStops>
              </button>
            )}
          </article>
        );
      })}
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </section>
  );
}

export function AdminTransfers({
  transfers,
  call,
  busy,
}: {
  transfers: any[];
  call: (path: string, body: any) => Promise<void>;
  busy: boolean;
}) {
  return (
    <section className="transfer-list">
      <h2>Ownership transfers</h2>
      <p>
        <FullStops>
          {
            "Approval changes the registered owner. Inspect the garment, certificate and entitlement evidence before approving. A matching printed number alone is insufficient."
          }
        </FullStops>
      </p>
      {!transfers.length && (
        <p>
          <FullStops>{"No ownership transfer requests yet."}</FullStops>
        </p>
      )}
      {transfers.map((t) => (
        <article className="transfer-card" key={t.id}>
          <h3>
            <FullStops>{t.name}</FullStops>
          </h3>
          <p>
            <FullStops>{t.fromEmail}</FullStops> →{" "}
            <FullStops>{t.toEmail}</FullStops>
          </p>
          <p>
            <FullStops>{t.status.replaceAll("-", " ")}</FullStops> ·{" "}
            <FullStops>{date(t.requestedAt)}</FullStops>
          </p>
          {t.status === "awaiting-review" && (
            <form
              className="stack-form"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                call("/admin/transfer", {
                  action: "approve",
                  transferId: t.id,
                  certificateId: f.get("certificateId"),
                  hologramId: f.get("hologramId"),
                  evidence: f.get("evidence"),
                  physicalChecked: f.has("physicalChecked"),
                  titleChecked: f.has("titleChecked"),
                });
              }}
            >
              <label>
                Certificate number inspected
                <input name="certificateId" required maxLength={80} />
              </label>
              <label>
                Garment seal number inspected
                <input name="hologramId" required maxLength={80} />
              </label>
              <label>
                Private inspection & entitlement evidence reference
                <textarea
                  name="evidence"
                  required
                  minLength={12}
                  maxLength={1000}
                  placeholder="Reference to inspection photographs or an in-person check, and the transfer agreement."
                />
              </label>
              <label className="check-row">
                <input name="physicalChecked" type="checkbox" required />
                <FullStops>
                  {
                    "I checked the physical original and artist-signed certificate against Hewge’s records."
                  }
                </FullStops>
              </label>
              <label className="check-row">
                <input name="titleChecked" type="checkbox" required />
                <FullStops>
                  {
                    "I reviewed the right to transfer, recipient acceptance and any dispute flags."
                  }
                </FullStops>
              </label>
              <button className="button button-dark" disabled={busy}>
                Approve ownership transfer
              </button>
            </form>
          )}
          {["awaiting-recipient", "awaiting-review"].includes(t.status) && (
            <button
              className="text-link"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Reject this request and leave the registered owner unchanged?",
                  )
                )
                  call("/admin/transfer", {
                    action: "reject",
                    transferId: t.id,
                  });
              }}
            >
              Reject request
            </button>
          )}
          {t.status === "approved" && (
            <p>
              Approved <FullStops>{date(t.approvedAt)}</FullStops>
              <FullStops>{". Evidence: "}</FullStops>
              <FullStops>{t.evidence}</FullStops>
            </p>
          )}
        </article>
      ))}
    </section>
  );
}

export function RegistryPage() {
  const [record, setRecord] = useState<any>(null);
  const [message, setMessage] = useState("Finding the original…");
  useEffect(() => {
    const id = location.pathname.split("/")[2];
    api(`/registry/${encodeURIComponent(id)}`)
      .then(setRecord)
      .catch((e) => setMessage(messageOf(e)));
  }, []);
  if (!record)
    return (
      <main className="page-shell">
        <h1>
          <FullStops>{"The Hewge register."}</FullStops>
        </h1>
        <p role="status">
          <FullStops>{message}</FullStops>
        </p>
      </main>
    );
  const a = record.release;
  return (
    <main className="registry-page">
      <span className="eyebrow">
        <FullStops>{"THE HEWGE REGISTER / No. "}</FullStops>
        <FullStops>{a.number}</FullStops>
      </span>
      <h1>
        <FullStops>{a.name}</FullStops>
        <FullStops>{"."}</FullStops>
      </h1>
      <img className="registry-image" src={a.image} alt={a.name} />
      <div className="registry-details">
        <span className="eyebrow">Registered original</span>
        <h2>
          <FullStops>{a.certificateId}</FullStops>
        </h2>
        <p>
          <FullStops>{a.artistName || "Artist undisclosed"}</FullStops> ·{" "}
          <FullStops>{a.material || "Material undisclosed"}</FullStops> · Size{" "}
          <FullStops>{a.size}</FullStops>
        </p>
        <p>
          Registered owner:{" "}
          <strong>
            <FullStops>
              {a.publicOwner?.anonymous
                ? "anonymous bidder"
                : a.publicOwner?.name || "anonymous bidder"}
            </FullStops>
          </strong>
        </p>
        <p>
          <FullStops>
            {
              "This page confirms a Hewge record. It cannot authenticate the physical garment on its own. Match the original and its artist-signed certificate with Hewge."
            }
          </FullStops>
        </p>
        <ol>
          {record.history.map((e: any, i: number) => (
            <li key={i}>
              <FullStops>{date(e.at)}</FullStops> ·{" "}
              <FullStops>
                {e.kind === "registered"
                  ? "First registration"
                  : "Ownership transfer approved by Hewge"}
              </FullStops>
            </li>
          ))}
        </ol>
        <a className="text-link" href={`/pieces/${a.slug}`}>
          View the piece →
        </a>
        <br />
        <a className="text-link" href="/account">
          Manage or transfer ownership →
        </a>
      </div>
    </main>
  );
}

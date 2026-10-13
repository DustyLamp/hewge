import { useState } from "react";
import { api } from "./api";
import { FullStops } from "./typography";
import { SellerDetails } from "./seller";

export function WithdrawalPage() {
  const [requestId] = useState(() => crypto.randomUUID());
  const [review, setReview] = useState<Record<string, string> | null>(null);
  const [receipt, setReceipt] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="legal-page">
      <span className="eyebrow">YOUR CONTRACT</span>
      <h1>
        <FullStops>{"Withdraw from contract here."}</FullStops>
      </h1>
      <p>
        <FullStops>
          {
            "Use this form to give notice where you have a withdrawal right. No reason or sign-in is required. You may also email jez@hewge.design or write to the address below. Defect and non-delivery rights remain separate."
          }
        </FullStops>{" "}
        <a href="/terms">Return and withdrawal terms</a>
      </p>
      <SellerDetails />
      {receipt ? (
        <section>
          <h2>Notice received</h2>
          <p>
            <FullStops>{`${new Date(receipt.receivedAt).toISOString()} · Reference ${receipt.id}. Keep this receipt. Email confirmation is queued; contact us if it does not arrive.`}</FullStops>
          </p>
          <pre className="withdrawal-receipt">
            <FullStops>{receipt.receipt}</FullStops>
          </pre>
          <button
            className="button button-dark"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([receipt.receipt], {
                  type: "text/plain;charset=utf-8",
                }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = `hewge-withdrawal-${receipt.id}.txt`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Save receipt
          </button>
        </section>
      ) : review ? (
        <section>
          <h2>Review your notice</h2>
          <p>
            <FullStops>{`${review.name} · ${review.email}`}</FullStops>
          </p>
          <p>
            <FullStops>{`I withdraw from my ${review.kind === "garment" ? "garment purchase" : "registration service"} contract: ${review.reference}.`}</FullStops>
          </p>
          <button
            className="button button-dark"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMessage("");
              try {
                setReceipt(
                  await api("/withdrawal", {
                    ...review,
                    requestId,
                    confirmed: true,
                  }),
                );
              } catch (e: any) {
                setMessage(
                  `${e.message} If you cannot submit, email jez@hewge.design with your notice.`,
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Submitting…" : "Confirm withdrawal"}
          </button>
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => setReview(null)}
          >
            Edit details
          </button>
        </section>
      ) : (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            setReview(
              Object.fromEntries(new FormData(e.currentTarget)) as Record<
                string,
                string
              >,
            );
          }}
        >
          <label>
            Your name
            <input name="name" autoComplete="name" required maxLength={120} />
          </label>
          <label>
            Email for confirmation
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
            />
          </label>
          <label>
            Order, piece or transfer reference
            <input name="reference" required maxLength={120} />
          </label>
          <label>
            Contract
            <select name="kind">
              <option value="garment">Garment purchase</option>
              <option value="registration">Registration service</option>
            </select>
          </label>
          <p className="fine-print">
            <FullStops>
              {
                "We use these details to record and handle your notice. They are not a marketing subscription."
              }
            </FullStops>{" "}
            <a href="/privacy">Privacy</a>
          </p>
          <button className="button button-dark">Review withdrawal</button>
        </form>
      )}
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </main>
  );
}

export function WithdrawalPanel({
  items,
  call,
  busy,
}: {
  items: any[];
  call: (path: string, body: any) => void;
  busy: boolean;
}) {
  return (
    <section className="studio-panel">
      <h2>Withdrawal notices</h2>
      <p>
        Receipt is effective when submitted. Verify identity and the contract;
        apply the relevant deadline and rights. Record return instructions,
        communications, payment reconciliation and any refund. Closing a case
        here does not issue a refund or change ownership.
      </p>
      {!items.length && <p>No notices received.</p>}
      {items.map((row) => (
        <article className="transfer-card" key={row.id}>
          <h3>{row.reference}</h3>
          <p>
            {row.name} · {row.email}
          </p>
          <p>
            {new Date(row.receivedAt).toISOString()} · {row.kind} · {row.status}
          </p>
          <pre className="withdrawal-receipt">{row.receipt}</pre>
          <form
            className="stack-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              call("/admin/withdrawal", {
                id: row.id,
                status: f.get("status"),
                note: f.get("note"),
              });
            }}
          >
            <label>
              Status
              <select
                name="status"
                defaultValue={
                  row.status === "resolved" ? "resolved" : "reviewing"
                }
              >
                <option value="reviewing">Under review</option>
                <option value="resolved">Resolved</option>
              </select>
            </label>
            <label>
              Private review and refund reference
              <textarea
                name="note"
                minLength={12}
                maxLength={1500}
                defaultValue={row.reviewNote || ""}
                required
              />
            </label>
            <button className="button button-dark" disabled={busy}>
              Save review
            </button>
          </form>
        </article>
      ))}
    </section>
  );
}

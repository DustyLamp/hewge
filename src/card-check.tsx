import { useEffect, useState } from "react";
import { api } from "./api";
import { FullStops } from "./typography";
import { CARD_MANDATE_VERSION, cardMandate } from "../shared/legal";
import type { Release } from "../shared/auction";

export function CardCheck({
  release,
  onVerified,
}: {
  release: Release;
  onVerified: (ready: boolean) => void;
}) {
  const [card, setCard] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api("/bid/card/status", { id: release.id })
      .then((r) => {
        if (alive) {
          setCard(r);
          onVerified(r.verified === true);
        }
      })
      .catch((e) => {
        if (alive) setMessage(e.message);
      });
    return () => {
      alive = false;
    };
  }, [release.id]);
  return (
    <div className="card-check">
      <h3>Before your first bid</h3>
      {card?.verified ? (
        <p>
          <FullStops>{`${card.brand} ending ${card.last4} verified. Delivery: ${card.shipping.name}, ${card.shipping.address.line1}, ${card.shipping.address.postal_code} ${card.shipping.address.city}, ${card.shipping.address.country}. Contact Hewge before bidding if this is incorrect.`}</FullStops>
        </p>
      ) : (
        <form
          className="stack-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setMessage("");
            try {
              const r = await api("/bid/card/setup", {
                id: release.id,
                termsVersion: release.termsVersion,
                mandateVersion: CARD_MANDATE_VERSION,
                accepted: true,
                adult: true,
              });
              if (r.verified) {
                const checked = await api("/bid/card/status", {
                  id: release.id,
                });
                setCard(checked);
                onVerified(checked.verified === true);
              } else {
                const url = new URL(r.url);
                if (
                  url.protocol !== "https:" ||
                  url.hostname !== "checkout.stripe.com"
                )
                  throw Error("Card verification unavailable.");
                location.assign(url.href);
              }
            } catch (e: any) {
              setMessage(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="fine-print">
            <FullStops>
              {
                "Verify a card with Stripe. No bidding fee. A temporary bank authorisation may appear; the winning amount is not reserved."
              }
            </FullStops>
          </p>
          <label className="check-label">
            <input type="checkbox" required />
            <span>
              <FullStops>{cardMandate}</FullStops>
            </span>
          </label>
          <label className="check-label">
            <input type="checkbox" required />
            <span>
              I am 18 or over and accept the{" "}
              <a
                href={`/legal/${release.termsVersion}.txt`}
                target="_blank"
                rel="noopener"
              >
                auction terms
              </a>
              <FullStops>{". "}</FullStops>Read the{" "}
              <a href="/privacy" target="_blank" rel="noopener">
                privacy notice
              </a>
              <FullStops>{"."}</FullStops>
            </span>
          </label>
          <button className="button button-dark" disabled={busy}>
            {busy ? "Opening Stripe…" : "Verify card securely"}
          </button>
        </form>
      )}
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </div>
  );
}

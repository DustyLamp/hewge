import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, ArrowRight, Check, Share2 } from "lucide-react";
import { api, cognito, getToken, getReleases, signIn, signOut } from "./api";
import {
  minimumBid,
  preview,
  swissTimestamp,
  weekLabel,
  type Release,
} from "../shared/auction";
import { sizes } from "../shared/catalog";
import {
  TransferRequest,
  TransferList,
  AdminTransfers,
  RegistryPage,
} from "./ownership";
import "./experience.css";
import { PieceTitle, FullStops } from "./typography";
import { MembershipSignup, MembershipPage } from "./membership";

const money = (n: number) =>
  `CHF ${new Intl.NumberFormat("de-CH", { maximumFractionDigits: 2 }).format(n / 100)}`;
const date = (n: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Zurich",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(n) + " Swiss time";
function errorText(e: unknown) {
  return e instanceof Error ? e.message : "Please try again.";
}
export function SiteHeader() {
  return (
    <header className="header">
      <a href="/" aria-label="Hewge home" className="wordmark">
        HEWGE
      </a>
      <nav aria-label="Main navigation">
        <a href="/latest">The latest</a>
        <a href="/archive">Archive</a>
      </nav>
      <a className="header-cta" href="/#first-access">
        Join Hewge <ArrowUpRight size={17} />
      </a>
    </header>
  );
}
function Subscribe() {
  return (
    <div className="subscribe-box">
      <h3>
        <FullStops>{"Join Hewge."}</FullStops>
      </h3>
      <p>
        <FullStops>{"Verify your email for release access."}</FullStops>
      </p>
      <MembershipSignup />
    </div>
  );
}
function Footer() {
  return (
    <footer>
      <div className="footer-top">
        <a className="wordmark" href="/">
          HEWGE
        </a>
        <a href="/account">
          Your collector profile <ArrowUpRight size={17} />
        </a>
      </div>
      <div className="footer-bottom">
        <span>
          <FullStops>{"Switzerland · One of one."}</FullStops>
        </span>
        <a
          href="https://www.instagram.com/hewge.design/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Instagram ↗
        </a>
        <a href="/terms">Auction terms</a>
        <a href="/privacy">Privacy</a>
        <a href="/dashboard">Studio</a>
      </div>
    </footer>
  );
}
function useReleases() {
  const [data, setData] = useState<{
    releases: Release[];
    biddingEnabled: boolean;
  }>({ releases: [], biddingEnabled: false });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      getReleases()
        .then((d) => {
          if (alive) {
            setData(d);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    refresh();
    const id = setInterval(refresh, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return {
    ...data,
    error,
    loading,
    refresh: () => getReleases().then(setData),
  };
}
function Countdown({ release }: { release: Release }) {
  const [now, setNow] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(release.serverNow - Date.now());
  }, [release.serverNow]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const target =
    release.status === "scheduled" ? release.opensAt : release.closesAt;
  if (!target)
    return (
      <div className="countdown">
        <span>Next release</span>
        <strong>
          <FullStops>{"To be announced."}</FullStops>
        </strong>
      </div>
    );
  const seconds = Math.max(0, Math.floor((target - now - offset) / 1000));
  return (
    <div className="countdown">
      <span>
        <FullStops>
          {release.status === "scheduled"
            ? "Reveals in"
            : seconds
              ? "Bidding closes in"
              : "Bidding closed"}
        </FullStops>
      </span>
      <strong>
        <FullStops>
          {Math.floor(seconds / 86400)
            .toString()
            .padStart(2, "0")}
        </FullStops>
        <i>d</i>{" "}
        <FullStops>
          {Math.floor((seconds % 86400) / 3600)
            .toString()
            .padStart(2, "0")}
        </FullStops>
        <i>h</i>{" "}
        <FullStops>
          {Math.floor((seconds % 3600) / 60)
            .toString()
            .padStart(2, "0")}
        </FullStops>
        <i>m</i> <FullStops>{String(seconds % 60).padStart(2, "0")}</FullStops>
        <i>s</i>
      </strong>
      <small>
        <FullStops>{date(target)}</FullStops>
      </small>
    </div>
  );
}
export function Share({ release }: { release: Release }) {
  const [message, setMessage] = useState("");
  async function share() {
    const url = `${location.origin}/pieces/${release.slug}`;
    try {
      if (navigator.share)
        await navigator.share({
          title: `${release.name} — HEWGE`,
          text: `One shirt. One of one. ${release.name} by ${release.artistName || "HEWGE"}.`,
          url,
        });
      else {
        await navigator.clipboard.writeText(url);
        setMessage("Link copied.");
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        setMessage("Copy the page address to share.");
    }
  }
  return (
    <div className="share-line">
      <button className="text-link" onClick={share}>
        Pass it on <Share2 size={16} />
      </button>
      <small role="status">
        <FullStops>{message}</FullStops>
      </small>
    </div>
  );
}
function BidBox({
  release,
  enabled,
  onBid,
}: {
  release: Release;
  enabled: boolean;
  onBid: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState(false);
  async function bid(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await api("/bid", {
        id: release.id,
        amount: Math.round(Number(amount) * 100),
        termsVersion: release.termsVersion,
        accepted: true,
        adult: true,
      });
      setMessage(`Bid accepted: ${money(Math.round(Number(amount) * 100))}.`);
      setConfirm(false);
      setAmount("");
      onBid();
    } catch (e) {
      setMessage(errorText(e));
      setConfirm(false);
      onBid();
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="bid-box">
      <span className="eyebrow">
        <FullStops>
          {release.status === "sold"
            ? "Collected"
            : release.status === "awaiting-payment"
              ? "Winner selected"
              : "A single original"}
        </FullStops>
      </span>
      {!["sold", "awaiting-payment", "closed"].includes(release.status) && (
        <Countdown release={release} />
      )}
      <div className="bid-price">
        <span>
          <FullStops>
            {release.highestBid ? "Highest bid" : "Opening bid"}
          </FullStops>
        </span>
        <strong>
          <FullStops>
            {money(release.highestBid || release.openingBid)}
          </FullStops>
        </strong>
      </div>
      <div className="bid-meta">
        <span>
          <FullStops>
            {release.size ? `Size ${release.size}` : "Size at reveal"}
          </FullStops>
        </span>
        <span>
          {release.bidCount}{" "}
          <FullStops>{release.bidCount === 1 ? "bid" : "bids"}</FullStops>
        </span>
        <span>1 / 1</span>
      </div>
      <p className="mystery-note">
        <FullStops>{release.material || "Material undisclosed."}</FullStops>
        <FullStops>{!release.artistName && " Artist undisclosed."} </FullStops>
        <FullStops>
          {!release.identityRevealed &&
            "You are bidding on the pictured garment; these details may be revealed after bidding."}
        </FullStops>
      </p>
      {release.status === "sold" ? (
        <div className="owner-celebration">
          <span>Now belongs to</span>
          <strong>
            <FullStops>
              {release.publicOwner?.anonymous
                ? "anonymous bidder"
                : release.publicOwner?.name || "anonymous bidder"}
            </FullStops>
          </strong>
          <small>
            <FullStops>{"Edition of one."}</FullStops>
          </small>
        </div>
      ) : enabled && release.status === "open" ? (
        getToken() ? (
          <form className="stack-form" onSubmit={bid}>
            <label>
              Your bid · CHF
              <input
                type="number"
                min={
                  minimumBid(
                    release.openingBid,
                    release.highestBid,
                    release.minimumIncrement,
                  ) / 100
                }
                step="0.01"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setConfirm(false);
                }}
                required
                placeholder={String(
                  minimumBid(
                    release.openingBid,
                    release.highestBid,
                    release.minimumIncrement,
                  ) / 100,
                )}
              />
            </label>
            <p className="fine-print">
              Insured shipping:{" "}
              <FullStops>{money(release.shippingFee)}</FullStops>
              <FullStops>
                {
                  ". Eligible destinations and measurements below. Import charges may apply."
                }
              </FullStops>
            </p>
            <label className="check-label">
              <input type="checkbox" required />
              <span>
                {" "}
                I am 18 or over and accept the{" "}
                <a href="/terms" target="_blank">
                  auction terms
                </a>
                <FullStops>{". A winning bid commits me to pay."}</FullStops>
              </span>
            </label>
            {confirm && (
              <p className="confirm-bid">
                Confirm{" "}
                <FullStops>{money(Math.round(Number(amount) * 100))}</FullStops>{" "}
                + <FullStops>{money(release.shippingFee)}</FullStops>
                <FullStops>{" shipping. Payment due within"}</FullStops>{" "}
                {release.paymentHours}
                <FullStops>{" hours if you win."}</FullStops>{" "}
                <FullStops>
                  {!release.identityRevealed &&
                    "Artist and material are undisclosed."}
                </FullStops>
              </p>
            )}
            <button className="button button-dark" disabled={busy}>
              <FullStops>
                {busy
                  ? "Submitting…"
                  : confirm
                    ? "Confirm binding bid"
                    : "Review bid"}
              </FullStops>
              <ArrowRight size={18} />
            </button>
            {confirm && (
              <button
                type="button"
                className="quiet-button"
                onClick={() => setConfirm(false)}
              >
                Edit bid
              </button>
            )}
          </form>
        ) : (
          <a className="button button-dark" href="/account">
            Sign in to bid <ArrowUpRight size={18} />
          </a>
        )
      ) : release.status === "awaiting-payment" ? (
        <a className="button button-dark" href="/account">
          Check your collector account <ArrowUpRight size={18} />
        </a>
      ) : (
        <Subscribe />
      )}
      <p role="status" className="form-message">
        <FullStops>{message}</FullStops>
      </p>
      <p className="fine-print">
        <FullStops>{"Bidding is free. Highest valid bid wins."}</FullStops>
      </p>
      <Share release={release} />
    </aside>
  );
}
function PiecePage() {
  const { releases, biddingEnabled, error, loading, refresh } = useReleases();
  const slug = location.pathname.split("/")[2];
  const release = releases.find((r) => r.slug === slug);
  if (!release)
    return (
      <main className="page-shell">
        <h1>
          <FullStops>
            {loading
              ? "Loading the piece…"
              : error
                ? "The piece is temporarily unavailable."
                : "Piece not found."}
          </FullStops>
        </h1>
        <a href="/archive">Explore the archive →</a>
      </main>
    );
  return (
    <main className="article-page">
      <div className="article-mast">
        <span>THE HEWGE JOURNAL</span>
        <span>
          <FullStops>
            {release.opensAt ? weekLabel(release.opensAt) : "THE FIRST EDITION"}
          </FullStops>
        </span>
        <span>
          <FullStops>{"No. "}</FullStops>
          <FullStops>{release.number}</FullStops>
        </span>
      </div>
      <section className="article-title">
        <span className="eyebrow">
          <FullStops>
            {!release.designHidden && release.id === "toucan-001"
              ? "A night out. An original."
              : "Edition of one."}
          </FullStops>
        </span>
        <h1 className="piece-title">
          <PieceTitle name={release.name} />
        </h1>
        <div className="article-deck">
          <p>
            <FullStops>
              {!release.designHidden && release.id === "toucan-001"
                ? "One very good night."
                : "One original."}
            </FullStops>
            <br />
            <FullStops>
              {!release.designHidden && release.id === "toucan-001"
                ? "One very bad morning."
                : "Artist signed."}
            </FullStops>
          </p>
          <span>
            <FullStops>
              {release.artistName
                ? `A work by ${release.artistName}`
                : "Artist to be announced."}
            </FullStops>
          </span>
        </div>
      </section>
      <div className="article-spread">
        <div className="article-hero">
          <img
            src={release.image}
            alt={`${release.name}, an original shirt`}
            fetchPriority="high"
          />
          <span>
            <FullStops>{"THE ONLY ONE."}</FullStops>
          </span>
        </div>
        <BidBox release={release} enabled={biddingEnabled} onBid={refresh} />
      </div>

      {error && (
        <p className="service-note" role="status">
          <FullStops>{"Live updates unavailable. "}</FullStops>
          <FullStops>{error}</FullStops>
        </p>
      )}

      {release.story && (
        <section className="story-section">
          <div>
            <span className="eyebrow">The work</span>
            <h2>
              {!release.designHidden && release.id === "toucan-001" ? (
                <>
                  Some nights
                  <br />
                  <FullStops>{"stay with you."}</FullStops>
                </>
              ) : (
                <>
                  <FullStops>{"About the piece."}</FullStops>
                </>
              )}
            </h2>
          </div>
          <div>
            <p className="story-lead">
              <FullStops>{release.story}</FullStops>
            </p>
            <p>
              <FullStops>
                {
                  "A single garment. Its own name. Its artist’s signature. No second edition, in any size."
                }
              </FullStops>
            </p>
            {!release.designHidden && release.id === "toucan-001" && (
              <p className="image-note">
                <FullStops>
                  {
                    "Shown here: the approved design mockup. Final garment photography and measurements accompany the release."
                  }
                </FullStops>
              </p>
            )}
          </div>
        </section>
      )}

      {!release.designHidden && release.id === "toucan-001" && (
        <figure className="wide-art">
          <img
            src="/images/approved-mockup.webp"
            alt="Approved After Hours shirt mockup, front and back"
            loading="lazy"
          />
          <figcaption>After Hours / Front & back / Design study</figcaption>
        </figure>
      )}
      <section className="artist-section" id="artist">
        <div className="artist-art">
          <img
            src={
              !release.designHidden && release.id === "toucan-001"
                ? "/images/front-right.webp"
                : release.image
            }
            alt={
              release.designHidden
                ? `Preview of piece No. ${release.number}`
                : `A detail from ${release.name}`
            }
            loading="lazy"
          />
          <span>
            BEHIND
            <br />
            <FullStops>{"THE WORK."}</FullStops>
          </span>
        </div>
        <div className="artist-copy">
          <span className="eyebrow">The artist</span>
          <h2>
            <FullStops>{release.artistName || "To be announced."}</FullStops>
          </h2>
          {release.artistName ? (
            <>
              <p className="artist-byline">
                <FullStops>
                  {[release.artistOrigin, release.artistPractice]
                    .filter(Boolean)
                    .join(" / ")}
                </FullStops>
              </p>
              <p>
                <FullStops>{release.artistBiography}</FullStops>
              </p>

              {release.artistWorks && (
                <>
                  <h3>Other works</h3>
                  <p>
                    <FullStops>{release.artistWorks}</FullStops>
                  </p>
                </>
              )}
            </>
          ) : (
            <p>
              <FullStops>
                {release.revealMode === "after-close"
                  ? "Artist and material announced after bidding closes."
                  : release.revealMode === "at-opening"
                    ? "Artist and material announced when bidding opens."
                    : "Artist and material details will appear here."}
              </FullStops>
            </p>
          )}
          <div className="garment-label">
            <span className="wordmark">HEWGE</span>
            <strong>
              <FullStops>{release.name.toUpperCase()}</FullStops>
            </strong>

            {release.artistName && (
              <span>
                <FullStops>{release.artistName}</FullStops>
              </span>
            )}

            <small>
              <FullStops>{"ONE OF ONE / No. "}</FullStops>
              <FullStops>{release.number}</FullStops>
            </small>
          </div>
        </div>
      </section>
      <section className="ownership-story">
        <span className="eyebrow">With the piece</span>
        <h2>
          <FullStops>{"Yours."}</FullStops>
        </h2>
        <div className="ownership-grid">
          <p>
            <FullStops>{"Artist-signed certificate."}</FullStops>
            <br />
            <FullStops>{"Numbered ownership card."}</FullStops>
            <br />
            <FullStops>{"Holographic seal."}</FullStops>
            <br />
            <FullStops>{"One original."}</FullStops>
          </p>
          <p>
            <FullStops>{"Choose to be named in the archive."}</FullStops>
            <br />
            <FullStops>{"Or stay an anonymous bidder."}</FullStops>
          </p>
        </div>

        {release.certificateId && (
          <p className="certificate-code">
            <a href={`/registry/${release.id}`}>
              Registered original:{" "}
              <FullStops>{release.certificateId}</FullStops> →
            </a>
          </p>
        )}
      </section>
      <section className="article-details">
        <details>
          <summary>
            The fit & the piece <span>+</span>
          </summary>
          <p>
            <FullStops>
              {release.measurements ||
                "The exact size and garment measurements will be published before bidding opens."}{" "}
            </FullStops>
            <FullStops>
              {release.material || "Material announced at reveal."}
            </FullStops>
            <FullStops>{" One garment only. Artist signed."}</FullStops>
          </p>
        </details>
        <details>
          <summary>
            Bidding & payment <span>+</span>
          </summary>
          <p>
            <FullStops>
              {
                "Free to bid. Highest valid bid wins. Equal bids cannot displace an earlier accepted bid. The countdown follows the published closing time, with no hidden extensions. The winning bidder has"
              }
            </FullStops>{" "}
            {release.paymentHours}
            <FullStops>
              {
                " hours to pay. If an offer expires unpaid, Hewge may offer the shirt to the next eligible bidder at that bidder’s own highest bid, after resolving the original offer. Ownership is confirmed only after payment."
              }
            </FullStops>{" "}
            <a href="/terms">
              <FullStops>{"Read the full terms."}</FullStops>
            </a>
          </p>
        </details>
        <details>
          <summary>
            Insured, from Switzerland <span>+</span>
          </summary>
          <p>
            <FullStops>
              {
                "Insured shipping. Allow up to two weeks after payment, subject to the destination and customs. Destinations subject to restrictions or unavailable insurance are excluded."
              }
            </FullStops>{" "}
            <FullStops>
              {release.countries?.length
                ? `This release ships to: ${release.countries.join(", ")}. Shipping ${money(release.shippingFee)}.`
                : "Eligible destinations and shipping cost will be confirmed before bidding."}{" "}
            </FullStops>
            <FullStops>
              {"Any import charges will be explained in the release terms."}
            </FullStops>
          </p>
        </details>
      </section>
    </main>
  );
}
function LatestPage() {
  const { releases, loading, error } = useReleases();
  const latest =
    releases.find((r) => r.status === "open") ||
    [...releases]
      .filter((r) => r.status === "scheduled")
      .sort((a, b) => (a.opensAt || 0) - (b.opensAt || 0))[0] ||
    [...releases].sort((a, b) => (b.opensAt || 0) - (a.opensAt || 0))[0];
  useEffect(() => {
    if (!loading && latest) location.replace(`/pieces/${latest.slug}`);
  }, [loading, latest?.slug]);
  return (
    <main className="page-shell">
      <h1>
        <FullStops>{"The next original."}</FullStops>
      </h1>
      <p role="status">
        <FullStops>{error || "Finding the latest release…"}</FullStops>
      </p>
      <a href="/archive">Explore the archive →</a>
    </main>
  );
}
function Archive() {
  const { releases, error } = useReleases();
  const archived = releases.filter(
    (r) =>
      r.opensAt && ["sold", "closed", "awaiting-payment"].includes(r.status),
  );
  return (
    <main className="archive-page">
      <div className="article-mast">
        <span>THE HEWGE JOURNAL</span>
        <span>THE PERMANENT RECORD</span>
      </div>
      <h1>
        The
        <br />
        <em>
          <FullStops>{"Archive."}</FullStops>
        </em>
      </h1>
      <p>
        <FullStops>{"Past releases, by date."}</FullStops>
      </p>
      {archived.length ? (
        archived.map((r) => (
          <a className="archive-row" href={`/pieces/${r.slug}`} key={r.id}>
            <span className="eyebrow">
              <FullStops>{weekLabel(r.opensAt!)}</FullStops>
              <small>
                <FullStops>{date(r.opensAt!)}</FullStops>
              </small>
            </span>
            <img src={r.image} alt={r.name} />
            <div>
              <h2>
                <FullStops>{r.name}</FullStops>
              </h2>
              <p>
                <FullStops>{r.artistName}</FullStops>
              </p>
              <small>
                <FullStops>
                  {r.status === "sold"
                    ? r.publicOwner?.anonymous
                      ? "anonymous bidder"
                      : r.publicOwner?.name || "anonymous bidder"
                    : r.status === "awaiting-payment"
                      ? "Payment pending"
                      : "Closed — not collected"}
                </FullStops>
              </small>
            </div>
            <ArrowUpRight />
          </a>
        ))
      ) : (
        <div className="archive-empty">
          <div>
            <h2>
              No releases
              <br />
              <FullStops>{"yet."}</FullStops>
            </h2>
            <a href="/pieces/after-hours" className="text-link">
              Meet After Hours <ArrowUpRight size={18} />
            </a>
          </div>
        </div>
      )}

      {error && (
        <p role="status">
          <FullStops>
            {"Archive updates are temporarily unavailable."}
          </FullStops>
        </p>
      )}
    </main>
  );
}
function Auth({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<
    "login" | "signup" | "verify" | "reset" | "new-password"
  >("login");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("");
    setBusy(true);
    const f = new FormData(e.currentTarget),
      password = String(f.get("password") || "");
    try {
      if (mode === "login") {
        await signIn(email, password);
        onLogin();
      } else if (mode === "signup") {
        await cognito("SignUp", {
          Username: email,
          Password: password,
          UserAttributes: [{ Name: "email", Value: email }],
        });
        setMode("verify");
        setMessage("Check your inbox for your verification code.");
      } else if (mode === "verify") {
        await cognito("ConfirmSignUp", {
          Username: email,
          ConfirmationCode: f.get("code"),
        });
        setMode("login");
        setMessage("Email verified. You can now sign in.");
      } else if (mode === "reset") {
        await cognito("ForgotPassword", { Username: email });
        setMode("new-password");
        setMessage("If the account exists, check your inbox for a reset code.");
      } else {
        await cognito("ConfirmForgotPassword", {
          Username: email,
          ConfirmationCode: f.get("code"),
          Password: password,
        });
        setMode("login");
        setMessage("Password updated. Sign in below.");
      }
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-layout">
      <div>
        <span className="eyebrow">The collector’s circle</span>
        <h1>
          Your
          <br />
          <em>
            <FullStops>{"collection."}</FullStops>
          </em>
        </h1>
        <p>
          <FullStops>{"Bid on releases and manage your pieces."}</FullStops>
        </p>
        <img
          src="/images/night.webp"
          alt="A detail of the After Hours artwork"
        />
      </div>
      <div className="auth-panel">
        <span className="eyebrow">HEWGE / COLLECTOR ACCESS</span>
        <h2>
          <FullStops>
            {mode === "login"
              ? "Welcome back."
              : mode === "signup"
                ? "Create an account."
                : mode === "verify"
                  ? "Verify your email."
                  : "Reset your password."}
          </FullStops>
        </h2>
        <form className="stack-form" onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {["verify", "new-password"].includes(mode) && (
            <label>
              Email code
              <input
                name="code"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </label>
          )}
          {["login", "signup", "new-password"].includes(mode) && (
            <label>
              Password
              <input
                name="password"
                type="password"
                minLength={mode === "login" ? 1 : 12}
                required
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
              />
              {mode !== "login" && (
                <small>
                  <FullStops>
                    {
                      "12+ characters, upper and lowercase letters, and a number."
                    }
                  </FullStops>
                </small>
              )}
            </label>
          )}
          {mode === "signup" && (
            <p className="fine-print">
              <FullStops>
                {"Your account is private. Release emails are optional."}
              </FullStops>{" "}
              <a href="/privacy">
                <FullStops>{"How we use your details."}</FullStops>
              </a>
            </p>
          )}
          <button className="button button-dark" disabled={busy}>
            <FullStops>
              {busy
                ? "One moment…"
                : mode === "login"
                  ? "Sign in"
                  : mode === "signup"
                    ? "Create your account"
                    : mode === "verify"
                      ? "Verify email"
                      : mode === "reset"
                        ? "Send reset code"
                        : "Save password"}
            </FullStops>
            <ArrowRight size={18} />
          </button>
        </form>
        <p className="form-message" role="status">
          <FullStops>{message}</FullStops>
        </p>
        <div className="auth-links">
          <button
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setMessage("");
            }}
          >
            <FullStops>
              {mode === "login"
                ? "New here? Create an account"
                : "Back to sign in"}
            </FullStops>
          </button>
          {mode === "login" && (
            <>
              <button onClick={() => setMode("reset")}>Forgot password?</button>
              <button onClick={() => setMode("verify")}>
                Verify an existing account
              </button>
            </>
          )}
          {mode === "verify" && (
            <button
              onClick={() =>
                cognito("ResendConfirmationCode", { Username: email })
                  .then(() => setMessage("A new code is on its way."))
                  .catch((e) => setMessage(errorText(e)))
              }
            >
              Resend code
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const countries = [
  "CH",
  "DE",
  "FR",
  "IT",
  "AT",
  "GB",
  "US",
  "CA",
  "AU",
  "NZ",
  "JP",
  "SG",
  "NL",
  "BE",
  "DK",
  "SE",
  "NO",
  "FI",
  "IE",
  "ES",
  "PT",
  "PL",
  "CZ",
  "LU",
  "LI",
  "AE",
  "HK",
  "KR",
  "BR",
  "MX",
  "ZA",
  "IN",
  "IL",
  "GR",
  "IS",
  "MT",
  "CY",
  "HU",
  "RO",
  "BG",
  "HR",
  "EE",
  "LV",
  "LT",
  "SI",
  "SK",
  "TH",
  "MY",
  "ID",
  "PH",
  "TW",
  "VN",
  "CL",
  "AR",
  "CO",
  "TR",
  "SA",
  "QA",
];
function Profile({ data, reload }: { data: any; reload: () => void }) {
  const [message, setMessage] = useState("");
  const p = data.profile;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("Saving…");
    const f = new FormData(e.currentTarget);
    try {
      await api("/me/profile", {
        ...Object.fromEntries(f),
        sizes: f.getAll("sizes"),
        releaseConsent: f.get("releaseConsent") === "on",
      });
      setMessage("Your profile is saved.");
      reload();
    } catch (e) {
      setMessage(errorText(e));
    }
  }
  return (
    <form className="stack-form profile-form" onSubmit={save}>
      <h2>
        <FullStops>{"Your collector profile."}</FullStops>
      </h2>
      <p>
        <FullStops>
          {
            "Your preferences help us choose the next piece. Your follower count does not change who wins."
          }
        </FullStops>
      </p>
      <label>
        Name or alias
        <input name="displayName" defaultValue={p.displayName} maxLength={80} />
      </label>
      <fieldset>
        <legend>Your sizes</legend>
        <div className="size-options">
          {sizes.map((s) => (
            <label key={s}>
              <input
                type="checkbox"
                name="sizes"
                value={s}
                defaultChecked={p.sizes?.includes(s)}
              />
              <span>
                <FullStops>{s}</FullStops>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Country
        <select name="country" defaultValue={p.country || "CH"}>
          {countries.map((c) => (
            <option value={c} key={c}>
              {countryNames.of(c)}
            </option>
          ))}
        </select>
        <small>
          <FullStops>
            {"Shipping eligibility is confirmed on each release."}
          </FullStops>
        </small>
      </label>
      <div className="two-fields">
        <label>
          Instagram · optional
          <input
            name="instagram"
            defaultValue={p.instagram}
            placeholder="@yourname"
            maxLength={31}
          />
        </label>
        <label>
          Followers · optional
          <input
            name="followers"
            type="number"
            min="0"
            max="1000000000"
            defaultValue={p.followers ?? ""}
          />
          <small>
            <FullStops>{"Self-reported, never a bidding advantage."}</FullStops>
          </small>
        </label>
      </div>
      <label>
        Phone · optional
        <input name="phone" type="tel" defaultValue={p.phone} maxLength={40} />
        <small>
          <FullStops>
            {"Only for contacting you about a winning bid or delivery."}
          </FullStops>
        </small>
      </label>
      <label>
        A little about your taste · optional
        <textarea
          name="about"
          defaultValue={p.about}
          maxLength={600}
          rows={3}
        />
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          name="releaseConsent"
          defaultChecked={p.releaseConsent}
        />
        <span>
          <FullStops>
            {"Email me about new releases. I can switch this off anytime."}
          </FullStops>
        </span>
      </label>
      <button className="button button-dark">
        Save preferences <Check size={18} />
      </button>
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </form>
  );
}
function WonPiece({ a, reload }: { a: any; reload: () => void }) {
  const [message, setMessage] = useState("");
  async function pay() {
    try {
      const r = await api("/winner/checkout", { id: a.id });
      if (r.paid) {
        reload();
        return;
      }
      const url = new URL(r.url);
      if (url.hostname !== "checkout.stripe.com" || url.protocol !== "https:")
        throw Error("Checkout unavailable.");
      location.assign(url.href);
    } catch (e) {
      setMessage(errorText(e));
    }
  }
  async function ownership(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api("/owner", {
        id: a.id,
        anonymous: f.get("visibility") === "anonymous",
        name: f.get("name"),
      });
      setMessage("Your ownership preference is saved.");
      reload();
    } catch (e) {
      setMessage(errorText(e));
    }
  }
  return (
    <div className="won-piece">
      <span className="eyebrow">
        <FullStops>
          {a.status === "sold" ? "It’s yours." : "Winning bid"}
        </FullStops>
      </span>
      <h2>
        <FullStops>{a.name}</FullStops>
      </h2>
      <img src={a.image} alt={a.name} />
      {a.canPay ? (
        <>
          <p>
            <FullStops>{money(a.offerAmount)}</FullStops> +{" "}
            <FullStops>{money(a.shippingFee)}</FullStops>
            <FullStops>{" insured shipping."}</FullStops>
          </p>
          <p>
            Payment due <FullStops>{date(a.paymentDueAt)}</FullStops>
            <FullStops>{"."}</FullStops>
          </p>
          <button className="button button-dark" onClick={pay}>
            Complete your purchase <ArrowUpRight size={18} />
          </button>
        </>
      ) : a.status === "sold" ? (
        <>
          <p>
            <FullStops>
              {"Congratulations. Your ownership is registered."}
            </FullStops>
          </p>
          <p className="certificate-code">
            <FullStops>{a.certificateId}</FullStops>
          </p>
          <form className="stack-form" onSubmit={ownership}>
            <label>
              In the public archive
              <select
                name="visibility"
                defaultValue={a.publicOwner?.anonymous ? "anonymous" : "public"}
              >
                <option value="anonymous">anonymous bidder</option>
                <option value="public">Use my chosen name</option>
              </select>
            </label>
            <label>
              Public name
              <input
                name="name"
                maxLength={80}
                defaultValue={a.publicOwner?.name || ""}
              />
            </label>
            <button className="button button-dark">
              Save ownership choice
            </button>
          </form>

          {a.fulfillment?.tracking && (
            <p>
              Insured shipment: <FullStops>{a.fulfillment.tracking}</FullStops>
            </p>
          )}

          <a href={`/registry/${a.id}`} className="text-link">
            View the register →
          </a>
          <TransferRequest piece={a} reload={reload} />
        </>
      ) : (
        <p>
          <FullStops>{"This payment offer has ended."}</FullStops>
        </p>
      )}
      <Share release={a} />
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </div>
  );
}
function Account() {
  const [signed, setSigned] = useState(!!getToken());
  const [data, setData] = useState<any>(null);
  const [message, setMessage] = useState("");
  function reload() {
    api("/me")
      .then(setData)
      .catch((e) => {
        setMessage(errorText(e));
        if (!getToken()) setSigned(false);
      });
  }
  useEffect(() => {
    if (signed) reload();
  }, [signed]);
  if (!signed) return <Auth onLogin={() => setSigned(true)} />;
  return (
    <main className="account-page">
      <div className="account-heading">
        <div>
          <span className="eyebrow">Collector account</span>
          <h1>
            Your
            <br />
            <em>
              <FullStops>{"collection."}</FullStops>
            </em>
          </h1>
        </div>
        <button
          className="text-link"
          onClick={() => {
            signOut();
            setSigned(false);
            setData(null);
          }}
        >
          Sign out
        </button>
      </div>

      {data?.admin && (
        <a className="studio-link" href="/dashboard">
          Open the Hewge studio dashboard <ArrowUpRight size={18} />
        </a>
      )}

      <p role="status">
        <FullStops>{message}</FullStops>
      </p>

      {data && (
        <div className="account-grid">
          <Profile data={data} reload={reload} />
          <div>
            {data.auctions.length ? (
              data.auctions.map((a: any) => (
                <WonPiece key={a.id} a={a} reload={reload} />
              ))
            ) : (
              <div className="empty-collection">
                <span>1 / 1</span>
                <h2>
                  No pieces
                  <br />
                  <FullStops>{"yet."}</FullStops>
                </h2>
                <a href="/latest" className="text-link">
                  Meet the latest piece <ArrowUpRight size={16} />
                </a>
                <p>
                  <FullStops>
                    {
                      "When you win a piece, your payment window and ownership details appear here."
                    }
                  </FullStops>
                </p>
              </div>
            )}

            <TransferList transfers={data.transfers || []} reload={reload} />
          </div>
        </div>
      )}
    </main>
  );
}
function PrintableCertificate({ a, onClose }: { a: any; onClose: () => void }) {
  return (
    <div className="certificate-overlay">
      <div className="print-controls">
        <button onClick={() => window.print()}>Print certificate</button>
        <button onClick={onClose}>Close</button>
      </div>
      <article className="certificate">
        <span className="wordmark">HEWGE</span>
        <p>CERTIFICATE OF AUTHENTICITY</p>
        <h1>
          <FullStops>{a.name}</FullStops>
        </h1>
        <p>An original garment by</p>
        <h2>
          <FullStops>{a.artistName}</FullStops>
        </h2>
        <div className="certificate-edition">ONE OF ONE</div>
        <p>
          Piece <FullStops>{a.number}</FullStops> · Size{" "}
          <FullStops>{a.size}</FullStops> · <FullStops>{a.material}</FullStops>
        </p>
        <p>
          <FullStops>{a.certificateId}</FullStops>
        </p>
        <p>
          <FullStops>
            {"This record identifies the single original garment."}
          </FullStops>
          <br />
          <FullStops>
            {"The artist’s handwritten signature authenticates the work."}
          </FullStops>
        </p>
        <div className="signature-line">
          <span>Artist signature</span>
          <span>Date</span>
        </div>
        <div className="hologram-space">
          Affix numbered holographic seal
          <br />
          <FullStops>
            {a.fulfillment?.hologramId || "Record the seal ID in the studio"}
          </FullStops>
        </div>
        <small>
          Verify the registered piece at
          <br />
          hewge.design/registry/<FullStops>{a.id}</FullStops>
        </small>
      </article>
      <article className="congratulations-card">
        <span className="wordmark">HEWGE</span>
        <h1>
          <FullStops>{"Yours."}</FullStops>
        </h1>
        <p>
          <FullStops>{a.name}</FullStops> by{" "}
          <FullStops>{a.artistName}</FullStops>
          <FullStops>{"."}</FullStops>
        </p>
        <p>
          <FullStops>{"Thank you."}</FullStops>
        </p>
        <small>
          <FullStops>{a.certificateId}</FullStops>
        </small>
      </article>
    </div>
  );
}
function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState("collectors");
  const [draft, setDraft] = useState<any>(preview);
  const [print, setPrint] = useState<any>(null);
  const [signed, setSigned] = useState(!!getToken());
  const [busy, setBusy] = useState(false);
  function load() {
    api("/admin")
      .then(setData)
      .catch((e) => {
        setError(errorText(e));
        if (!getToken()) setSigned(false);
      });
  }
  useEffect(() => {
    if (signed) load();
  }, [signed]);
  async function call(path: string, body: any) {
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      setError("Saved.");
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!signed) return <Auth onLogin={() => setSigned(true)} />;
  if (!data)
    return (
      <main className="page-shell">
        <h1>
          <FullStops>{"Hewge studio."}</FullStops>
        </h1>
        <p role="status">
          <FullStops>{error || "Checking owner access…"}</FullStops>
        </p>
        <p>
          <FullStops>
            {"This room is restricted to the account owner."}
          </FullStops>
        </p>
        <a href="/account">Your collector profile →</a>
      </main>
    );
  const unique = new Map<string, any>();
  data.guestlist.forEach((g: any) =>
    unique.set(g.email, { ...g, guest: true }),
  );
  data.collectors.forEach((c: any) => {
    const m = unique.get(c.email);
    const merged = m?.updatedAt > c.updatedAt ? { ...c, ...m } : { ...m, ...c };
    const accountConsentAt =
      typeof c.consentAt === "string"
        ? Date.parse(c.consentAt)
        : c.consentAt || 0;
    unique.set(c.email, {
      ...merged,
      guest: false,
      emailVerified: true,
      releaseConsent:
        m?.emailVerified && m.consentAt >= accountConsentAt
          ? m.releaseConsent
          : c.releaseConsent,
    });
  });
  const collectors = [...unique.values()];
  const shown = collectors.filter((c) =>
    `${c.email} ${c.displayName || ""} ${c.instagram || ""} ${(c.sizes || []).join(" ")} ${c.about || ""} ${c.country || ""} ${c.city || ""} ${c.readiness || ""}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const counts = sizes.map((size) => ({
    size,
    count: collectors.filter(
      (c) => c.emailVerified === true && c.sizes?.includes(size),
    ).length,
  }));
  const top = Math.max(1, ...counts.map((x) => x.count));
  async function saveRelease(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const publish =
      (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
      "publish";
    try {
      await call("/admin/release", {
        ...draft,
        ...Object.fromEntries(f),
        openingBid: Math.round(Number(f.get("openingBid")) * 100),
        minimumIncrement: Math.round(Number(f.get("minimumIncrement")) * 100),
        shippingFee: Math.round(Number(f.get("shippingFee")) * 100),
        paymentHours: Number(f.get("paymentHours")),
        countries: String(f.get("countries"))
          .toUpperCase()
          .split(/[\s,]+/)
          .filter(Boolean),
        publish,
        ...(publish
          ? {
              opensAt: swissTimestamp(String(f.get("opensAt"))),
              closesAt: swissTimestamp(String(f.get("closesAt"))),
            }
          : {}),
      });
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <main className="dashboard">
      <div className="dashboard-heading">
        <div>
          <span className="eyebrow">PRIVATE / HEWGE STUDIO</span>
          <h1>
            <FullStops>{"The next original."}</FullStops>
          </h1>
        </div>
        <a href="/account" className="text-link">
          Your account <ArrowUpRight size={17} />
        </a>
      </div>
      <div className="dashboard-stats">
        <div>
          <strong>{collectors.length}</strong>
          <span>Interested collectors</span>
        </div>
        <div>
          <strong>
            {collectors.filter((c) => c.emailVerified === true).length}
          </strong>
          <span>Verified members</span>
        </div>
        <div>
          <strong>
            <FullStops>
              {data.auctions.reduce(
                (n: number, a: any) => n + (a.bidCount || 0),
                0,
              )}
            </FullStops>
          </strong>
          <span>Accepted bids</span>
        </div>
        <div>
          <strong>
            <FullStops>
              {counts.find((x) => x.count === top)?.size || "—"}
            </FullStops>
          </strong>
          <span>Most requested size</span>
        </div>
      </div>
      <div className="studio-status">
        <span>
          Pending verification:{" "}
          {collectors.filter((c) => !c.emailVerified).length}
        </span>
        <span>
          Ready to bid:{" "}
          {
            collectors.filter((c) => c.emailVerified && c.readiness === "ready")
              .length
          }
        </span>
        <span>
          Verification email:{" "}
          <FullStops>
            {data.verificationEmailEnabled
              ? "enabled"
              : "awaiting AWS approval"}
          </FullStops>
        </span>
        <span>
          SMS:{" "}
          <FullStops>
            {data.smsEnabled ? "enabled" : "preferences only"}
          </FullStops>
        </span>
        <span>
          Payments:{" "}
          <FullStops>
            {data.paymentsEnabled ? "connected" : "not connected"}
          </FullStops>
        </span>
        <span>
          Release & winner email:{" "}
          <FullStops>
            {data.emailEnabled ? "enabled" : "awaiting SES approval"}
          </FullStops>
        </span>
      </div>
      <div className="studio-tabs">
        {["collectors", "releases", "transfers", "fulfilment"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            <FullStops>{t}</FullStops>
          </button>
        ))}
      </div>
      <p role="status" className="form-message">
        <FullStops>{error}</FullStops>
      </p>
      {tab === "transfers" ? (
        <AdminTransfers
          transfers={data.transfers || []}
          call={call}
          busy={busy}
        />
      ) : tab === "collectors" ? (
        <>
          <section className="demand-panel">
            <div>
              <h2>
                <FullStops>{"Make what they’ll wear."}</FullStops>
              </h2>
              <p>
                <FullStops>
                  {
                    "Unique people, by size interest. A collector can choose several sizes. Size demand counts verified emails only. Pending addresses remain separate. Instagram counts are self-reported."
                  }
                </FullStops>
              </p>
            </div>
            <div className="demand-bars">
              {counts.map((x) => (
                <div key={x.size}>
                  <span>
                    <FullStops>{x.size}</FullStops>
                  </span>
                  <i style={{ width: `${(x.count / top) * 80}%` }} />
                  <strong>{x.count}</strong>
                </div>
              ))}
            </div>
          </section>
          <label className="search-label">
            Find a collector
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Name, email, size, location, readiness, Instagram"
            />
          </label>
          <div className="collector-table">
            <table>
              <thead>
                <tr>
                  <th>Collector</th>
                  <th>Sizes</th>
                  <th>Location / readiness</th>
                  <th>Instagram</th>
                  <th>About / contact</th>
                  <th>Release email</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.email}>
                    <td>
                      <strong>
                        <FullStops>{c.displayName || "Collector"}</FullStops>
                      </strong>
                      <span>
                        <FullStops>{c.email}</FullStops>
                      </span>
                      <small>
                        <FullStops>
                          {c.emailVerified
                            ? "Verified email"
                            : "Pending verification"}
                        </FullStops>
                      </small>
                    </td>
                    <td>
                      <FullStops>{c.sizes?.join(", ") || "—"}</FullStops>
                      <small>
                        <FullStops>{c.country || ""}</FullStops>
                      </small>
                    </td>
                    <td>
                      <FullStops>
                        {[c.city, c.country].filter(Boolean).join(", ") || "—"}
                      </FullStops>
                      <small>
                        <FullStops>{c.readiness || "Not specified"}</FullStops>
                      </small>
                      <small>
                        <FullStops>{c.timezone || ""}</FullStops>
                      </small>
                    </td>
                    <td>
                      {c.instagram ? (
                        <a
                          href={`https://www.instagram.com/${c.instagram}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          @<FullStops>{c.instagram}</FullStops> ↗
                        </a>
                      ) : (
                        "—"
                      )}

                      <small>
                        <FullStops>
                          {c.followers == null
                            ? ""
                            : `${c.followers.toLocaleString()} · self-reported`}
                        </FullStops>
                      </small>
                    </td>
                    <td>
                      <FullStops>{c.about || "—"}</FullStops>
                      <small>
                        <FullStops>{c.phone}</FullStops>
                      </small>

                      {c.smsConsent && (
                        <small>SMS consent · pending activation</small>
                      )}
                    </td>
                    <td>
                      <FullStops>
                        {!c.emailVerified
                          ? "Pending"
                          : c.releaseConsent
                            ? "Opted in"
                            : "Off"}
                      </FullStops>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && (
              <p className="empty-table">
                <FullStops>
                  {"No collectors yet. Real interest will appear here."}
                </FullStops>
              </p>
            )}
          </div>
        </>
      ) : tab === "releases" ? (
        <>
          <section className="schedule-panel">
            <div>
              <h2>Release dates</h2>
              <p>
                <FullStops>
                  {
                    "Set each opening and closing individually. The countdown appears when the release is published. All times are Swiss, including daylight saving."
                  }
                </FullStops>
              </p>
            </div>
            <label>
              Release timing
              <select
                value={data.settings.cadence}
                onChange={(e) =>
                  call("/admin/settings", { cadence: e.target.value })
                }
              >
                <option value="individual">Individual dates</option>
              </select>
            </label>
          </section>
          <div className="release-selector">
            <button
              onClick={() =>
                setDraft({
                  ...preview,
                  id: `piece-${Date.now()}`,
                  slug: "",
                  name: "",
                  number: String(data.auctions.length + 1).padStart(3, "0"),
                })
              }
            >
              + New piece
            </button>

            {data.auctions.map((a: any) => (
              <button key={a.id} onClick={() => setDraft(a)}>
                <FullStops>{a.number}</FullStops> /{" "}
                <FullStops>{a.name}</FullStops> /{" "}
                <FullStops>{a.status}</FullStops>
              </button>
            ))}
          </div>

          {draft.revision && !draft.identityRevealed && (
            <button
              className="text-link"
              onClick={() => {
                if (
                  window.confirm("Reveal the artist and material publicly now?")
                )
                  call("/admin/reveal", { id: draft.id });
              }}
            >
              Reveal artist & material now
            </button>
          )}

          <form
            key={draft.id + ":" + draft.revision}
            className="stack-form release-form"
            onSubmit={saveRelease}
          >
            <h2>
              <FullStops>{draft.name || "A new original."}</FullStops>
            </h2>
            <div className="two-fields">
              {[
                ["id", "Release ID"],
                ["slug", "Page slug"],
                ["name", "Piece name"],
                ["number", "Piece number"],
                ["image", "Image path"],
                ["artistName", "Artist name"],
                ["artistOrigin", "Artist home / origin"],
                ["artistPractice", "Art practice"],
                ["material", "Exact material / composition"],
              ].map(([k, label]) => (
                <label key={k}>
                  <FullStops>{label}</FullStops>
                  <input
                    name={k}
                    defaultValue={draft[k]}
                    required={["id", "slug", "name", "image"].includes(k)}
                  />
                </label>
              ))}
            </div>
            {[
              ["story", "The piece’s story"],
              ["artistBiography", "Artist biography"],
              ["artistWorks", "Other works in their collection"],
            ].map(([k, label]) => (
              <label key={k}>
                <FullStops>{label}</FullStops>
                <textarea name={k} rows={4} defaultValue={draft[k]} />
              </label>
            ))}
            <label>
              Design reveal
              <select
                name="designRevealMode"
                defaultValue={draft.designRevealMode || "now"}
              >
                <option value="now">Show the garment now</option>
                <option value="at-opening">
                  Show a teaser until bidding opens
                </option>
              </select>
            </label>
            <label>
              Artist & material reveal
              <select
                name="revealMode"
                defaultValue={draft.revealMode || "manual"}
              >
                <option value="now">Reveal now</option>
                <option value="at-opening">When bidding opens</option>
                <option value="after-close">After bidding closes</option>
                <option value="manual">Manually, when I choose</option>
              </select>
            </label>
            <div className="two-fields">
              <label>
                Garment size
                <select name="size" defaultValue={draft.size || ""}>
                  <option value="">Not yet confirmed</option>
                  {sizes.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                Measurements
                <input
                  name="measurements"
                  defaultValue={draft.measurements}
                  placeholder="Chest, length, shoulder — cm"
                />
              </label>
              {[
                ["openingBid", "Opening bid · CHF"],
                ["minimumIncrement", "Minimum increase · CHF"],
                ["shippingFee", "Insured shipping · CHF"],
              ].map(([k, label]) => (
                <label key={k}>
                  <FullStops>{label}</FullStops>
                  <input
                    name={k}
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    defaultValue={draft[k] / 100}
                  />
                </label>
              ))}
              <label>
                Payment window · hours
                <input
                  name="paymentHours"
                  type="number"
                  min="24"
                  max="168"
                  required
                  defaultValue={draft.paymentHours}
                />
              </label>
              <label>
                Opens · Switzerland
                <input type="datetime-local" name="opensAt" />
              </label>
              <label>
                Closes · Switzerland
                <input type="datetime-local" name="closesAt" />
              </label>
            </div>
            <label>
              Eligible countries · ISO codes
              <input
                name="countries"
                defaultValue={draft.countries?.join(", ")}
                placeholder="CH, DE, FR…"
              />
              <small>
                <FullStops>
                  {
                    "Confirm insurance, carrier service, sanctions and consumer requirements for each destination before scheduling."
                  }
                </FullStops>
              </small>
            </label>
            <div className="two-fields">
              <button
                className="button button-dark"
                name="action"
                value="draft"
                disabled={busy}
              >
                Save preview
              </button>
              <button
                className="button button-dark"
                name="action"
                value="publish"
                disabled={busy || !data.paymentsEnabled || !data.emailEnabled}
              >
                Schedule bidding <ArrowUpRight size={18} />
              </button>
            </div>
            <p className="fine-print">
              <FullStops>
                {
                  "Scheduling locks after opening. One auction at a time. Artist details, measurements, payment setup, transactional email and approved seller terms are required before bidding."
                }
              </FullStops>
            </p>
          </form>
        </>
      ) : (
        <div className="fulfillment-list">
          {data.auctions
            .filter((a: any) => ["sold", "awaiting-payment"].includes(a.status))
            .map((a: any) => (
              <article key={a.id}>
                <span className="eyebrow">
                  <FullStops>{a.status}</FullStops>
                </span>
                <h2>
                  <FullStops>{a.name}</FullStops>
                </h2>
                <p>
                  <FullStops>{a.winnerEmail}</FullStops> ·{" "}
                  <FullStops>{money(a.offerAmount)}</FullStops>
                </p>
                {a.status === "awaiting-payment" ? (
                  <>
                    <p>
                      Due <FullStops>{date(a.paymentDueAt)}</FullStops>
                    </p>
                    <button
                      className="button button-dark"
                      disabled={busy || Date.now() < a.paymentDueAt}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Confirm the original offer is cancelled under your terms. This checks Stripe, releases that bidder, and offers the piece to the next highest eligible bidder at their own bid.",
                          )
                        )
                          call("/admin/next-bidder", {
                            id: a.id,
                            confirmed: true,
                          });
                      }}
                    >
                      Resolve unpaid offer → next bidder
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      <FullStops>{a.certificateId}</FullStops>
                    </p>
                    <button className="text-link" onClick={() => setPrint(a)}>
                      Print certificate & congratulations card{" "}
                      <ArrowUpRight size={18} />
                    </button>
                    <form
                      className="stack-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        call("/admin/fulfillment", {
                          id: a.id,
                          certificateSigned: f.has("certificateSigned"),
                          cardIncluded: f.has("cardIncluded"),
                          insured: f.has("insured"),
                          shipped: f.has("shipped"),
                          hologramId: f.get("hologramId"),
                          tracking: f.get("tracking"),
                        });
                      }}
                    >
                      {[
                        [
                          "certificateSigned",
                          "Artist has signed the certificate",
                        ],
                        ["cardIncluded", "Ownership card enclosed"],
                        ["insured", "Shipment insured"],
                        ["shipped", "Dispatched"],
                      ].map(([k, label]) => (
                        <label key={k} className="check-label">
                          <input
                            type="checkbox"
                            name={k}
                            defaultChecked={
                              k === "shipped"
                                ? !!a.fulfillment?.shippedAt
                                : a.fulfillment?.[k]
                            }
                          />
                          <span>
                            <FullStops>{label}</FullStops>
                          </span>
                        </label>
                      ))}
                      <label>
                        Hologram serial
                        <input
                          name="hologramId"
                          defaultValue={a.fulfillment?.hologramId}
                        />
                      </label>
                      <label>
                        Carrier & tracking
                        <input
                          name="tracking"
                          defaultValue={a.fulfillment?.tracking}
                        />
                      </label>
                      <button className="button button-dark">
                        Save fulfilment
                      </button>
                    </form>
                  </>
                )}
              </article>
            ))}

          {!data.auctions.some((a: any) =>
            ["sold", "awaiting-payment"].includes(a.status),
          ) && (
            <div className="archive-empty">
              <h2>
                <FullStops>{"First, a winner."}</FullStops>
              </h2>
              <p>
                <FullStops>
                  {
                    "Paid originals will appear here with certificate, hologram and insured dispatch controls."
                  }
                </FullStops>
              </p>
            </div>
          )}
          <h3>Transactional email queue</h3>

          {data.mail.map((m: any) => (
            <p key={m.id}>
              <FullStops>{m.subject}</FullStops> ·{" "}
              <FullStops>{m.email}</FullStops> ·{" "}
              <FullStops>{m.status}</FullStops>
            </p>
          ))}

          {!data.mail.length && (
            <p>
              <FullStops>{"No messages queued."}</FullStops>
            </p>
          )}
        </div>
      )}

      {print && (
        <PrintableCertificate a={print} onClose={() => setPrint(null)} />
      )}
    </main>
  );
}
function Terms() {
  return (
    <main className="legal-page">
      <span className="eyebrow">THE RELEASE RULES / DRAFT</span>
      <h1>
        <FullStops>{"One piece."}</FullStops>
        <br />
        <FullStops>{"Clear terms."}</FullStops>
      </h1>
      <p className="legal-notice">
        <FullStops>
          {
            "Bidding is not open. These draft rules describe the intended experience. Final seller details, destination rules and reviewed terms will be published before a binding bid can be placed."
          }
        </FullStops>
      </p>
      <h2>How a release works</h2>
      <p>
        <FullStops>
          {
            "One original garment. One auction at a time. Each page identifies the piece, exact size, measurements, opening bid, minimum increase, shipping charge, eligible destinations and opening and closing times. Some releases withhold the artist and material until a clearly stated reveal stage, which may be after bidding closes. This is disclosed before the bid is confirmed. Prices and bids are in Swiss francs. Joining and bidding are free. There is no draw and no buyer’s premium."
          }
        </FullStops>
      </p>
      <h2>Your bid</h2>
      <p>
        <FullStops>
          {
            "You must be 18 or over, use a verified email, and select a size and eligible destination. Review your amount before confirming. Bids are offers to buy, not expressions of interest. The highest valid bid received by the server before the deadline wins. An equal bid does not replace an accepted bid. There are no hidden time extensions. Instagram followers do not determine eligibility or the winner. Seller accounts cannot bid."
          }
        </FullStops>
      </p>
      <h2>Winning & payment</h2>
      <p>
        <FullStops>
          {
            "The release will state when a binding sale is formed and the payment deadline. The proposed payment window is 48 hours after the winning offer is issued; the actual window appears on each release. No money is taken merely for bidding. Payment goes through Stripe. A payment confirmation, not the browser return page, confirms ownership. The garment does not ship before cleared payment."
          }
        </FullStops>
      </p>
      <h2>If a winner does not pay</h2>
      <p>
        <FullStops>
          {
            "Hewge may cancel an unpaid offer after the published deadline and any legally required default process. An operator checks payment status before offering the garment to the next eligible bidder at that bidder’s own highest bid. The original offer cannot remain payable while the next offer is active. A replacement offer carries its own payment deadline. No automatic penalties are imposed by this website."
          }
        </FullStops>
      </p>
      <h2>Delivery & consumer rights</h2>
      <p>
        <FullStops>
          {
            "Insured delivery from Switzerland. Allow up to two weeks after payment, with destination and customs exceptions stated on the release. Only approved, serviceable destinations are offered. Shipping prices, taxes, import responsibilities, returns and defect remedies must be set out in the final terms before bidding. Mandatory consumer rights remain applicable; an online auction label does not waive them."
          }
        </FullStops>
      </p>
      <h2>Ownership & authenticity</h2>
      <p>
        <FullStops>
          {
            "The paid buyer may choose a public name or “anonymous bidder.” The public archive never includes the buyer’s contact information. The garment, certificate and numbered ownership card identify the same original. The artist signs the certificate by hand. A hologram is a physical matching seal, not a government certification or transfer of copyright."
          }
        </FullStops>
      </p>
      <h2>Passing on the original</h2>
      <p>
        <FullStops>
          {
            "Transfers require a request from the registered owner, acceptance by the recipient using a verified email, confirmation of possession, and Hewge’s review of the physical original, certificate and entitlement evidence. Acceptance is due within seven days. Either participant may cancel before approval. The register changes only on approval and defaults to anonymous ownership. Registration records provenance; it does not resolve disputed legal title, transfer copyright or process resale payments."
          }
        </FullStops>
      </p>
      <h2>Before the first auction</h2>
      <p>
        <FullStops>
          {
            "The legal seller name, address, customer-service contact, applicable tax treatment, final contract wording and approved destinations will be published here. Live bidding remains disabled until those launch requirements are completed."
          }
        </FullStops>
      </p>
      <button className="text-link" onClick={() => window.print()}>
        Print these draft rules
      </button>
    </main>
  );
}
function Privacy() {
  const [message, setMessage] = useState("");
  return (
    <main className="legal-page">
      <span className="eyebrow">YOUR DETAILS</span>
      <h1>
        <FullStops>{"Private by default."}</FullStops>
      </h1>
      <p>
        <FullStops>
          {
            "Hewge, Switzerland, collects the information you choose to give us to manage release interest, accounts, bids, payments and ownership. The legal seller’s full identity and contact details will be published before auctions open."
          }
        </FullStops>
      </p>
      <h2>What we collect</h2>
      <p>
        <FullStops>
          {
            "Membership: email, verification and release-email consent. After verification you can add sizes, country, city, bidding interest and optional profile details. Your browser’s language and time zone help us understand release interest; they do not establish your location. We do not request GPS location. Collector account: verified email, size preferences and country; a name, Instagram handle, self-reported follower count, phone number and interests are optional. Membership SMS consent is separate from email consent and from providing a phone number for delivery. SMS alerts are not active yet; numbers must be verified before sending release texts. We use size interest to plan future pieces. Social details help us understand our audience; we do not scrape profiles or use follower counts to decide auction winners."
          }
        </FullStops>
      </p>
      <h2>Who can see it</h2>
      <p>
        <FullStops>
          {
            "Contact details and collector profiles are accessible only to Hewge’s authorised owner accounts. The public archive shows a paid buyer’s chosen name only when they opt in; otherwise it says “anonymous bidder.” Account, auction and consent data are stored with AWS in Stockholm, Sweden. AWS also delivers the site globally. Stripe processes payments and shipping details when payments open; Hewge does not receive card numbers."
          }
        </FullStops>
      </p>
      <h2>Email & retention</h2>
      <p>
        <FullStops>
          {
            "Ownership transfer requests include the recipient’s email, account confirmations, certificate and seal checks, and private review evidence. Participants can see their own requests; Hewge can review the complete record. Public provenance shows registration and approved transfer dates without contact details."
          }
        </FullStops>
      </p>
      <p>
        <FullStops>
          {
            "Release emails are optional and separate from account, bid, payment and delivery communications. Unconfirmed membership requests and email links expire after 48 hours. Verified membership records expire after 180 days. A verification link is single-use and opens a one-hour preferences session stored in this browser tab. Account profiles remain while the account is active. Auction and sale records may need to be kept for contractual, dispute and accounting obligations; the final retention policy will accompany the seller’s terms. Technical request data helps operate and protect the site. There are no advertising trackers. A sign-in token stays in this tab’s session storage until sign-out or expiry."
          }
        </FullStops>
      </p>
      <h2>Your choices</h2>
      <p>
        Edit preferences and switch off release emails in your collector account
        or through a fresh link at <a href="/membership">membership</a>
        <FullStops>
          {
            ". To leave release emails, request a confirmation link below. For an account without auction records, profile deletion is also available below when signed in; account login deletion follows through the identity service. Accounts with bid or sale records need a reviewed deletion request so legally required records can be retained."
          }
        </FullStops>
      </p>
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/waitlist/remove", {
              email: new FormData(e.currentTarget).get("email"),
            });
            setMessage(
              "Check your email to confirm removal. If delivery is not yet available, your request stays pending.",
            );
          } catch (e) {
            setMessage(errorText(e));
          }
        }}
      >
        <label>
          Email address
          <input type="email" name="email" required />
        </label>
        <button className="button button-dark">Leave release alerts</button>
      </form>

      {getToken() && (
        <button
          className="quiet-button"
          onClick={async () => {
            if (
              !window.confirm(
                "Delete your collector profile? Auction records, if any, require an owner-reviewed request.",
              )
            )
              return;
            try {
              await api("/me/delete");
              setMessage(
                "Your collector profile has been deleted. Sign-in access remains; contact the seller for full account deletion.",
              );
            } catch (e) {
              setMessage(errorText(e));
            }
          }}
        >
          Delete my collector profile
        </button>
      )}

      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </main>
  );
}
export function Experience() {
  const route = location.pathname;
  useEffect(() => {
    document.title =
      route === "/membership"
        ? "Membership — HEWGE"
        : route === "/archive"
          ? "The Archive — HEWGE"
          : route === "/account"
            ? "Collector Access — HEWGE"
            : route === "/dashboard"
              ? "Studio — HEWGE"
              : route === "/terms"
                ? "Auction Terms — HEWGE"
                : route === "/privacy"
                  ? "Privacy — HEWGE"
                  : "After Hours — The Hewge Journal";
    const canonical = document.querySelector('link[rel="canonical"]');
    canonical?.setAttribute("href", `https://hewge.design${route}`);
  }, [route]);
  return (
    <>
      <SiteHeader />
      {route === "/membership" ? (
        <MembershipPage />
      ) : route === "/latest" ? (
        <LatestPage />
      ) : route.startsWith("/registry/") ? (
        <RegistryPage />
      ) : route.startsWith("/pieces/") ? (
        <PiecePage />
      ) : route === "/archive" ? (
        <Archive />
      ) : route === "/account" ? (
        <Account />
      ) : route === "/dashboard" ? (
        <Dashboard />
      ) : route === "/terms" ? (
        <Terms />
      ) : route === "/privacy" ? (
        <Privacy />
      ) : (
        <main className="page-shell">
          <h1>
            <FullStops>{"Nothing here yet."}</FullStops>
          </h1>
          <a href="/">Back to Hewge →</a>
        </main>
      )}
      <Footer />
    </>
  );
}

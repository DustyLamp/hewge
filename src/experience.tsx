import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, ArrowRight, Check, Share2 } from "lucide-react";
import {
  api,
  cognito,
  getToken,
  getReleases,
  joinList,
  signIn,
  signOut,
} from "./api";
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
        Get the next drop <ArrowUpRight size={17} />
      </a>
    </header>
  );
}
function Subscribe() {
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="subscribe-box">
      <h3>Get the next drop.</h3>
      <p>
        Release emails.
        <br />
        No account needed.
      </p>
      {done ? (
        <p role="status">You’re on the list. We’ll let you know.</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const f = new FormData(e.currentTarget);
              await joinList(String(f.get("email")), String(f.get("website")));
              setDone(true);
            } catch (e) {
              setMessage(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="email-line">
            <input
              name="email"
              type="email"
              aria-label="Email for release invitations"
              placeholder="Your email address"
              required
              maxLength={254}
            />
            <button aria-label="Subscribe to the next drop" disabled={busy}>
              <ArrowRight size={24} />
            </button>
          </div>
          <label className="honeypot" aria-hidden="true">
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
          <small>
            Subscribe to Hewge release emails. Leave anytime.{" "}
            <a href="/privacy">Privacy</a>
          </small>
          <p role="status">{message}</p>
        </form>
      )}
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
        <span>Switzerland · One of one.</span>
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
        <strong>To be announced.</strong>
      </div>
    );
  const seconds = Math.max(0, Math.floor((target - now - offset) / 1000));
  return (
    <div className="countdown">
      <span>
        {release.status === "scheduled"
          ? "Reveals in"
          : seconds
            ? "Bidding closes in"
            : "Bidding closed"}
      </span>
      <strong>
        {Math.floor(seconds / 86400)
          .toString()
          .padStart(2, "0")}
        <i>d</i>{" "}
        {Math.floor((seconds % 86400) / 3600)
          .toString()
          .padStart(2, "0")}
        <i>h</i>{" "}
        {Math.floor((seconds % 3600) / 60)
          .toString()
          .padStart(2, "0")}
        <i>m</i> {String(seconds % 60).padStart(2, "0")}
        <i>s</i>
      </strong>
      <small>{date(target)}</small>
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
      <small role="status">{message}</small>
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
        {release.status === "sold"
          ? "Collected"
          : release.status === "awaiting-payment"
            ? "Winner selected"
            : "A single original"}
      </span>
      {!["sold", "awaiting-payment", "closed"].includes(release.status) && (
        <Countdown release={release} />
      )}
      <div className="bid-price">
        <span>{release.highestBid ? "Highest bid" : "Opening bid"}</span>
        <strong>{money(release.highestBid || release.openingBid)}</strong>
      </div>
      <div className="bid-meta">
        <span>{release.size ? `Size ${release.size}` : "Size at reveal"}</span>
        <span>
          {release.bidCount} {release.bidCount === 1 ? "bid" : "bids"}
        </span>
        <span>1 / 1</span>
      </div>
      <p className="mystery-note">
        {release.material || "Material undisclosed."}
        {!release.artistName && " Artist undisclosed."}{" "}
        {!release.identityRevealed &&
          "You are bidding on the pictured garment; these details may be revealed after bidding."}
      </p>
      {release.status === "sold" ? (
        <div className="owner-celebration">
          <span>Now belongs to</span>
          <strong>
            {release.publicOwner?.anonymous
              ? "anonymous bidder"
              : release.publicOwner?.name || "anonymous bidder"}
          </strong>
          <small>Edition of one.</small>
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
              Insured shipping: {money(release.shippingFee)}. Eligible
              destinations and measurements below. Import charges may apply.
            </p>
            <label className="check-label">
              <input type="checkbox" required /> I am 18 or over and accept the{" "}
              <a href="/terms" target="_blank">
                auction terms
              </a>
              . A winning bid commits me to pay.
            </label>
            {confirm && (
              <p className="confirm-bid">
                Confirm {money(Math.round(Number(amount) * 100))} +{" "}
                {money(release.shippingFee)} shipping. Payment due within{" "}
                {release.paymentHours} hours if you win.{" "}
                {!release.identityRevealed &&
                  "Artist and material are undisclosed."}
              </p>
            )}
            <button className="button button-dark" disabled={busy}>
              {busy
                ? "Submitting…"
                : confirm
                  ? "Confirm binding bid"
                  : "Review bid"}
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
        {message}
      </p>
      <p className="fine-print">Bidding is free. Highest valid bid wins.</p>
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
          {loading
            ? "Loading the piece…"
            : error
              ? "The piece is temporarily unavailable."
              : "Piece not found."}
        </h1>
        <a href="/archive">Explore the archive →</a>
      </main>
    );
  return (
    <main className="article-page">
      <div className="article-mast">
        <span>THE HEWGE JOURNAL</span>
        <span>
          {release.opensAt ? weekLabel(release.opensAt) : "THE FIRST EDITION"}
        </span>
        <span>No. {release.number}</span>
      </div>
      <section className="article-title">
        <span className="eyebrow">
          {!release.designHidden && release.id === "toucan-001"
            ? "A night out. An original."
            : "Edition of one."}
        </span>
        <h1>
          {release.name}
          <span>.</span>
        </h1>
        <div className="article-deck">
          <p>
            {!release.designHidden && release.id === "toucan-001"
              ? "One very good night."
              : "One original."}
            <br />
            {!release.designHidden && release.id === "toucan-001"
              ? "One very bad morning."
              : "Artist signed."}
          </p>
          <span>
            {release.artistName
              ? `A work by ${release.artistName}`
              : "Artist to be announced."}
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
          <span>THE ONLY ONE.</span>
        </div>
        <BidBox release={release} enabled={biddingEnabled} onBid={refresh} />
      </div>
      {error && (
        <p className="service-note" role="status">
          Live updates unavailable. {error}
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
                  stay with you.
                </>
              ) : (
                <>About the piece.</>
              )}
            </h2>
          </div>
          <div>
            <p className="story-lead">{release.story}</p>
            <p>
              A single garment. Its own name. Its artist’s signature. No second
              edition, in any size.
            </p>
            {!release.designHidden && release.id === "toucan-001" && (
              <p className="image-note">
                Shown here: the approved design mockup. Final garment
                photography and measurements accompany the release.
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
            THE WORK.
          </span>
        </div>
        <div className="artist-copy">
          <span className="eyebrow">The artist</span>
          <h2>{release.artistName || "To be announced."}</h2>
          {release.artistName ? (
            <>
              <p className="artist-byline">
                {[release.artistOrigin, release.artistPractice]
                  .filter(Boolean)
                  .join(" / ")}
              </p>
              <p>{release.artistBiography}</p>
              {release.artistWorks && (
                <>
                  <h3>Other works</h3>
                  <p>{release.artistWorks}</p>
                </>
              )}
            </>
          ) : (
            <p>
              {release.revealMode === "after-close"
                ? "Artist and material announced after bidding closes."
                : release.revealMode === "at-opening"
                  ? "Artist and material announced when bidding opens."
                  : "Artist and material details will appear here."}
            </p>
          )}
          <div className="garment-label">
            <span className="wordmark">HEWGE</span>
            <strong>{release.name.toUpperCase()}</strong>
            {release.artistName && <span>{release.artistName}</span>}
            <small>ONE OF ONE / No. {release.number}</small>
          </div>
        </div>
      </section>
      <section className="ownership-story">
        <span className="eyebrow">With the piece</span>
        <h2>Yours.</h2>
        <div className="ownership-grid">
          <p>
            Artist-signed certificate.
            <br />
            Numbered ownership card.
            <br />
            Holographic seal.
            <br />
            One original.
          </p>
          <p>
            Choose to be named in the archive.
            <br />
            Or stay an anonymous bidder.
          </p>
        </div>
        {release.certificateId && (
          <p className="certificate-code">
            <a href={`/registry/${release.id}`}>
              Registered original: {release.certificateId} →
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
            {release.measurements ||
              "The exact size and garment measurements will be published before bidding opens."}{" "}
            {release.material || "Material announced at reveal."} One garment
            only. Artist signed.
          </p>
        </details>
        <details>
          <summary>
            Bidding & payment <span>+</span>
          </summary>
          <p>
            Free to bid. Highest valid bid wins. Equal bids cannot displace an
            earlier accepted bid. The countdown follows the published closing
            time, with no hidden extensions. The winning bidder has{" "}
            {release.paymentHours} hours to pay. If an offer expires unpaid,
            Hewge may offer the shirt to the next eligible bidder at that
            bidder’s own highest bid, after resolving the original offer.
            Ownership is confirmed only after payment.{" "}
            <a href="/terms">Read the full terms.</a>
          </p>
        </details>
        <details>
          <summary>
            Insured, from Switzerland <span>+</span>
          </summary>
          <p>
            Insured shipping. Allow up to two weeks after payment, subject to
            the destination and customs. Destinations subject to restrictions or
            unavailable insurance are excluded.{" "}
            {release.countries?.length
              ? `This release ships to: ${release.countries.join(", ")}. Shipping ${money(release.shippingFee)}.`
              : "Eligible destinations and shipping cost will be confirmed before bidding."}{" "}
            Any import charges will be explained in the release terms.
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
      <h1>The next original.</h1>
      <p role="status">{error || "Finding the latest release…"}</p>
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
        <em>Archive.</em>
      </h1>
      <p>Past releases, by date.</p>
      {archived.length ? (
        archived.map((r) => (
          <a className="archive-row" href={`/pieces/${r.slug}`} key={r.id}>
            <span className="eyebrow">
              {weekLabel(r.opensAt!)}
              <small>{date(r.opensAt!)}</small>
            </span>
            <img src={r.image} alt={r.name} />
            <div>
              <h2>{r.name}</h2>
              <p>{r.artistName}</p>
              <small>
                {r.status === "sold"
                  ? r.publicOwner?.anonymous
                    ? "anonymous bidder"
                    : r.publicOwner?.name || "anonymous bidder"
                  : r.status === "awaiting-payment"
                    ? "Payment pending"
                    : "Closed — not collected"}
              </small>
            </div>
            <ArrowUpRight />
          </a>
        ))
      ) : (
        <div className="archive-empty">
          <span>00</span>
          <div>
            <h2>
              No releases
              <br />
              yet.
            </h2>
            <a href="/pieces/after-hours" className="text-link">
              Meet After Hours <ArrowUpRight size={18} />
            </a>
          </div>
        </div>
      )}
      {error && (
        <p role="status">Archive updates are temporarily unavailable.</p>
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
          <em>collection.</em>
        </h1>
        <p>Bid on releases and manage your pieces.</p>
        <img
          src="/images/night.webp"
          alt="A detail of the After Hours artwork"
        />
      </div>
      <div className="auth-panel">
        <span className="eyebrow">HEWGE / COLLECTOR ACCESS</span>
        <h2>
          {mode === "login"
            ? "Welcome back."
            : mode === "signup"
              ? "Create an account."
              : mode === "verify"
                ? "Verify your email."
                : "Reset your password."}
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
                  12+ characters, upper and lowercase letters, and a number.
                </small>
              )}
            </label>
          )}
          {mode === "signup" && (
            <p className="fine-print">
              Your account is private. Release emails are optional.{" "}
              <a href="/privacy">How we use your details.</a>
            </p>
          )}
          <button className="button button-dark" disabled={busy}>
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
            <ArrowRight size={18} />
          </button>
        </form>
        <p className="form-message" role="status">
          {message}
        </p>
        <div className="auth-links">
          <button
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setMessage("");
            }}
          >
            {mode === "login"
              ? "New here? Create an account"
              : "Back to sign in"}
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
      <h2>Your collector profile.</h2>
      <p>
        Your preferences help us choose the next piece. Your follower count does
        not change who wins.
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
              <span>{s}</span>
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
        <small>Shipping eligibility is confirmed on each release.</small>
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
          <small>Self-reported, never a bidding advantage.</small>
        </label>
      </div>
      <label>
        Phone · optional
        <input name="phone" type="tel" defaultValue={p.phone} maxLength={40} />
        <small>Only for contacting you about a winning bid or delivery.</small>
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
        Email me about new releases. I can switch this off anytime.
      </label>
      <button className="button button-dark">
        Save preferences <Check size={18} />
      </button>
      <p role="status">{message}</p>
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
        {a.status === "sold" ? "It’s yours." : "Winning bid"}
      </span>
      <h2>{a.name}</h2>
      <img src={a.image} alt={a.name} />
      {a.canPay ? (
        <>
          <p>
            {money(a.offerAmount)} + {money(a.shippingFee)} insured shipping.
          </p>
          <p>Payment due {date(a.paymentDueAt)}.</p>
          <button className="button button-dark" onClick={pay}>
            Complete your purchase <ArrowUpRight size={18} />
          </button>
        </>
      ) : a.status === "sold" ? (
        <>
          <p>Congratulations. Your ownership is registered.</p>
          <p className="certificate-code">{a.certificateId}</p>
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
            <p>Insured shipment: {a.fulfillment.tracking}</p>
          )}
          <a href={`/registry/${a.id}`} className="text-link">
            View the register →
          </a>
          <TransferRequest piece={a} reload={reload} />
        </>
      ) : (
        <p>This payment offer has ended.</p>
      )}
      <Share release={a} />
      <p role="status">{message}</p>
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
            <em>collection.</em>
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
      <p role="status">{message}</p>
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
                  yet.
                </h2>
                <a href="/latest" className="text-link">
                  Meet the latest piece <ArrowUpRight size={16} />
                </a>
                <p>
                  When you win a piece, your payment window and ownership
                  details appear here.
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
        <h1>{a.name}</h1>
        <p>An original garment by</p>
        <h2>{a.artistName}</h2>
        <div className="certificate-edition">ONE OF ONE</div>
        <p>
          Piece {a.number} · Size {a.size} · {a.material}
        </p>
        <p>{a.certificateId}</p>
        <p>
          This record identifies the single original garment.
          <br />
          The artist’s handwritten signature authenticates the work.
        </p>
        <div className="signature-line">
          <span>Artist signature</span>
          <span>Date</span>
        </div>
        <div className="hologram-space">
          Affix numbered holographic seal
          <br />
          {a.fulfillment?.hologramId || "Record the seal ID in the studio"}
        </div>
        <small>
          Verify the registered piece at
          <br />
          hewge.design/registry/{a.id}
        </small>
      </article>
      <article className="congratulations-card">
        <span className="wordmark">HEWGE</span>
        <h1>Yours.</h1>
        <p>
          {a.name} by {a.artistName}.
        </p>
        <p>Thank you.</p>
        <small>{a.certificateId}</small>
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
        <h1>Hewge studio.</h1>
        <p role="status">{error || "Checking owner access…"}</p>
        <p>This room is restricted to the account owner.</p>
        <a href="/account">Your collector profile →</a>
      </main>
    );
  const unique = new Map<string, any>();
  data.guestlist.forEach((g: any) =>
    unique.set(g.email, { ...g, guest: true }),
  );
  data.collectors.forEach((c: any) => unique.set(c.email, c));
  const collectors = [...unique.values()];
  const shown = collectors.filter((c) =>
    `${c.email} ${c.displayName || ""} ${c.instagram || ""} ${(c.sizes || []).join(" ")} ${c.about || ""}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const counts = sizes.map((size) => ({
    size,
    count: collectors.filter((c) => c.sizes?.includes(size)).length,
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
          <h1>The next original.</h1>
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
          <strong>{data.collectors.length}</strong>
          <span>Verified accounts with profiles</span>
        </div>
        <div>
          <strong>
            {data.auctions.reduce(
              (n: number, a: any) => n + (a.bidCount || 0),
              0,
            )}
          </strong>
          <span>Accepted bids</span>
        </div>
        <div>
          <strong>{counts.find((x) => x.count === top)?.size || "—"}</strong>
          <span>Most requested size</span>
        </div>
      </div>
      <div className="studio-status">
        <span>
          Payments: {data.paymentsEnabled ? "connected" : "not connected"}
        </span>
        <span>
          Release & winner email:{" "}
          {data.emailEnabled ? "enabled" : "awaiting SES approval"}
        </span>
      </div>
      <div className="studio-tabs">
        {["collectors", "releases", "transfers", "fulfilment"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <p role="status" className="form-message">
        {error}
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
              <h2>Make what they’ll wear.</h2>
              <p>
                Unique people, by size interest. A collector can choose several
                sizes. Guest-list addresses are unverified; registered profiles
                take precedence. Instagram counts are self-reported.
              </p>
            </div>
            <div className="demand-bars">
              {counts.map((x) => (
                <div key={x.size}>
                  <span>{x.size}</span>
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
              placeholder="Name, email, size, Instagram, interests"
            />
          </label>
          <div className="collector-table">
            <table>
              <thead>
                <tr>
                  <th>Collector</th>
                  <th>Sizes</th>
                  <th>Instagram</th>
                  <th>About / contact</th>
                  <th>Release email</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.email}>
                    <td>
                      <strong>{c.displayName || "Collector"}</strong>
                      <span>{c.email}</span>
                      <small>
                        {c.guest
                          ? "Guest list · unverified email"
                          : "Verified email"}
                      </small>
                    </td>
                    <td>
                      {c.sizes?.join(", ") || "—"}
                      <small>{c.country || ""}</small>
                    </td>
                    <td>
                      {c.instagram ? (
                        <a
                          href={`https://www.instagram.com/${c.instagram}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          @{c.instagram} ↗
                        </a>
                      ) : (
                        "—"
                      )}
                      <small>
                        {c.followers == null
                          ? ""
                          : `${c.followers.toLocaleString()} · self-reported`}
                      </small>
                    </td>
                    <td>
                      {c.about || "—"}
                      <small>{c.phone}</small>
                    </td>
                    <td>{c.guest || c.releaseConsent ? "Opted in" : "Off"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && (
              <p className="empty-table">
                No collectors yet. Real interest will appear here.
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
                Set each opening and closing individually. The countdown appears
                when the release is published. All times are Swiss, including
                daylight saving.
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
                {a.number} / {a.name} / {a.status}
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
            <h2>{draft.name || "A new original."}</h2>
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
                  {label}
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
                {label}
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
                  {label}
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
                Confirm insurance, carrier service, sanctions and consumer
                requirements for each destination before scheduling.
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
              Scheduling locks after opening. One auction at a time. Artist
              details, measurements, payment setup, transactional email and
              approved seller terms are required before bidding.
            </p>
          </form>
        </>
      ) : (
        <div className="fulfillment-list">
          {data.auctions
            .filter((a: any) => ["sold", "awaiting-payment"].includes(a.status))
            .map((a: any) => (
              <article key={a.id}>
                <span className="eyebrow">{a.status}</span>
                <h2>{a.name}</h2>
                <p>
                  {a.winnerEmail} · {money(a.offerAmount)}
                </p>
                {a.status === "awaiting-payment" ? (
                  <>
                    <p>Due {date(a.paymentDueAt)}</p>
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
                    <p>{a.certificateId}</p>
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
                          {label}
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
              <h2>First, a winner.</h2>
              <p>
                Paid originals will appear here with certificate, hologram and
                insured dispatch controls.
              </p>
            </div>
          )}
          <h3>Transactional email queue</h3>
          {data.mail.map((m: any) => (
            <p key={m.id}>
              {m.subject} · {m.email} · {m.status}
            </p>
          ))}
          {!data.mail.length && <p>No messages queued.</p>}
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
        One piece.
        <br />
        Clear terms.
      </h1>
      <p className="legal-notice">
        Bidding is not open. These draft rules describe the intended experience.
        Final seller details, destination rules and reviewed terms will be
        published before a binding bid can be placed.
      </p>
      <h2>How a release works</h2>
      <p>
        One original garment. One auction at a time. Each page identifies the
        piece, exact size, measurements, opening bid, minimum increase, shipping
        charge, eligible destinations and opening and closing times. Some
        releases withhold the artist and material until a clearly stated reveal
        stage, which may be after bidding closes. This is disclosed before the
        bid is confirmed. Prices and bids are in Swiss francs. Joining and
        bidding are free. There is no draw and no buyer’s premium.
      </p>
      <h2>Your bid</h2>
      <p>
        You must be 18 or over, use a verified email, and select a size and
        eligible destination. Review your amount before confirming. Bids are
        offers to buy, not expressions of interest. The highest valid bid
        received by the server before the deadline wins. An equal bid does not
        replace an accepted bid. There are no hidden time extensions. Instagram
        followers do not determine eligibility or the winner. Seller accounts
        cannot bid.
      </p>
      <h2>Winning & payment</h2>
      <p>
        The release will state when a binding sale is formed and the payment
        deadline. The proposed payment window is 48 hours after the winning
        offer is issued; the actual window appears on each release. No money is
        taken merely for bidding. Payment goes through Stripe. A payment
        confirmation, not the browser return page, confirms ownership. The
        garment does not ship before cleared payment.
      </p>
      <h2>If a winner does not pay</h2>
      <p>
        Hewge may cancel an unpaid offer after the published deadline and any
        legally required default process. An operator checks payment status
        before offering the garment to the next eligible bidder at that bidder’s
        own highest bid. The original offer cannot remain payable while the next
        offer is active. A replacement offer carries its own payment deadline.
        No automatic penalties are imposed by this website.
      </p>
      <h2>Delivery & consumer rights</h2>
      <p>
        Insured delivery from Switzerland. Allow up to two weeks after payment,
        with destination and customs exceptions stated on the release. Only
        approved, serviceable destinations are offered. Shipping prices, taxes,
        import responsibilities, returns and defect remedies must be set out in
        the final terms before bidding. Mandatory consumer rights remain
        applicable; an online auction label does not waive them.
      </p>
      <h2>Ownership & authenticity</h2>
      <p>
        The paid buyer may choose a public name or “anonymous bidder.” The
        public archive never includes the buyer’s contact information. The
        garment, certificate and numbered ownership card identify the same
        original. The artist signs the certificate by hand. A hologram is a
        physical matching seal, not a government certification or transfer of
        copyright.
      </p>
      <h2>Passing on the original</h2>
      <p>
        Transfers require a request from the registered owner, acceptance by the
        recipient using a verified email, confirmation of possession, and
        Hewge’s review of the physical original, certificate and entitlement
        evidence. Acceptance is due within seven days. Either participant may
        cancel before approval. The register changes only on approval and
        defaults to anonymous ownership. Registration records provenance; it
        does not resolve disputed legal title, transfer copyright or process
        resale payments.
      </p>
      <h2>Before the first auction</h2>
      <p>
        The legal seller name, address, customer-service contact, applicable tax
        treatment, final contract wording and approved destinations will be
        published here. Live bidding remains disabled until those launch
        requirements are completed.
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
      <h1>Private by default.</h1>
      <p>
        Hewge, Switzerland, collects the information you choose to give us to
        manage release interest, accounts, bids, payments and ownership. The
        legal seller’s full identity and contact details will be published
        before auctions open.
      </p>
      <h2>What we collect</h2>
      <p>
        Guest list: email, chosen sizes and release-email consent. Collector
        account: verified email, size preferences and country; a name, Instagram
        handle, self-reported follower count, phone number and interests are
        optional. We use size interest to plan future pieces. Social details
        help us understand our audience; we do not scrape profiles or use
        follower counts to decide auction winners.
      </p>
      <h2>Who can see it</h2>
      <p>
        Contact details and collector profiles are accessible only to Hewge’s
        authorised owner accounts. The public archive shows a paid buyer’s
        chosen name only when they opt in; otherwise it says “anonymous bidder.”
        Account, auction and consent data are stored with AWS in Stockholm,
        Sweden. AWS also delivers the site globally. Stripe processes payments
        and shipping details when payments open; Hewge does not receive card
        numbers.
      </p>
      <h2>Email & retention</h2>
      <p>
        Ownership transfer requests include the recipient’s email, account
        confirmations, certificate and seal checks, and private review evidence.
        Participants can see their own requests; Hewge can review the complete
        record. Public provenance shows registration and approved transfer dates
        without contact details.
      </p>
      <p>
        Release emails are optional and separate from account, bid, payment and
        delivery communications. Guest-list records expire after 180 days.
        Account profiles remain while the account is active. Auction and sale
        records may need to be kept for contractual, dispute and accounting
        obligations; the final retention policy will accompany the seller’s
        terms. Technical request data helps operate and protect the site. There
        are no advertising trackers. A sign-in token stays in this tab’s session
        storage until sign-out or expiry.
      </p>
      <h2>Your choices</h2>
      <p>
        Edit preferences and switch off release emails in your collector
        account. You can remove a guest-list address below. For an account
        without auction records, profile deletion is also available below when
        signed in; account login deletion follows through the identity service.
        Accounts with bid or sale records need a reviewed deletion request so
        legally required records can be retained.
      </p>
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/waitlist/remove", {
              email: new FormData(e.currentTarget).get("email"),
            });
            setMessage("Removed from the guest list, if present.");
          } catch (e) {
            setMessage(errorText(e));
          }
        }}
      >
        <label>
          Guest-list email
          <input type="email" name="email" required />
        </label>
        <button className="button button-dark">Leave the guest list</button>
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
      <p role="status">{message}</p>
    </main>
  );
}
export function Experience() {
  const route = location.pathname;
  useEffect(() => {
    document.title =
      route === "/archive"
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
      {route === "/latest" ? (
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
          <h1>Nothing here yet.</h1>
          <a href="/">Back to Hewge →</a>
        </main>
      )}
      <Footer />
    </>
  );
}

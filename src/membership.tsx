import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { api, joinList } from "./api";
import { sizes } from "../shared/catalog";
import { FullStops } from "./typography";

export function MembershipSignup({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState("");
  const [message, setMessage] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      const r = await joinList(
        String(f.get("email")),
        String(f.get("website")),
      );
      setDelivery(r.delivery);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  if (delivery)
    return (
      <div className="membership-result" role="status">
        <h3>
          <FullStops>
            {delivery === "sent" || delivery === "accepted"
              ? "Check your inbox."
              : delivery === "pending"
                ? "Request saved."
                : "Email unavailable."}
          </FullStops>
        </h3>
        <p>
          <FullStops>
            {delivery === "sent" || delivery === "accepted"
              ? "Confirm your email to continue. Then choose your sizes and contact preferences."
              : delivery === "pending"
                ? "Verification emails are temporarily unavailable. Your email still needs confirmation. Please try again later."
                : "We couldn’t confirm delivery. Please try again later."}
          </FullStops>
        </p>
        <button
          className="text-link"
          type="button"
          onClick={() => {
            setDelivery("");
            setMessage("");
          }}
        >
          Use another email or resend →
        </button>
      </div>
    );
  return (
    <form className={`signup ${compact ? "compact" : ""}`} onSubmit={submit}>
      <div className="email-line">
        <input
          name="email"
          type="email"
          aria-label="Your email address"
          placeholder="Your email address"
          autoComplete="email"
          required
          maxLength={254}
        />
        <button disabled={busy} aria-label="Join Hewge">
          {busy ? <span className="spinner" /> : <ArrowRight size={26} />}
        </button>
      </div>
      <label className="honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <p className="form-note">
        <FullStops>
          {
            "Verify your email to join Hewge and receive release announcements. Leave anytime. "
          }
        </FullStops>
        <a href="/privacy">Privacy</a>
      </p>

      {message && (
        <p className="form-error" role="alert">
          <FullStops>{message}</FullStops>
        </p>
      )}
    </form>
  );
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryOptions = Array.from({ length: 676 }, (_, i) =>
  String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
)
  .filter(
    (code) =>
      !["EU", "EZ", "UN", "QO", "XA", "XB", "ZZ"].includes(code) &&
      new Intl.Locale(`und-${code}`).region === code &&
      regionNames.of(code) !== code,
  )
  .sort((a, b) => regionNames.of(a)!.localeCompare(regionNames.of(b)!));

export function MembershipPage() {
  const [token] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("verify") || "",
  );
  const [session, setSession] = useState(
    () => sessionStorage.getItem("hewge-membership") || "",
  );
  const [purpose, setPurpose] = useState("");
  const [profile, setProfile] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [loading, setLoading] = useState(Boolean(token || session));
  useEffect(() => {
    // Tokens stay out of request URLs, referrers and the address bar after arrival.
    if (token) {
      history.replaceState(null, "", location.pathname);
      api("/membership/link", { token })
        .then((r) => setPurpose(r.purpose))
        .catch((e) => setMessage(e.message))
        .finally(() => setLoading(false));
    } else if (session) {
      api("/membership/session", { session })
        .then((r) => setProfile(r.profile))
        .catch((e) => {
          sessionStorage.removeItem("hewge-membership");
          setSession("");
          setMessage(e.message);
        })
        .finally(() => setLoading(false));
    }
  }, []);
  async function verify() {
    setBusy(true);
    setMessage("");
    try {
      const r = await api("/membership/verify", { token });
      if (r.unsubscribed) {
        setRemoved(true);
        setPurpose("");
        return;
      }
      sessionStorage.setItem("hewge-membership", r.session);
      setSession(r.session);
      setProfile(r.profile);
      setMessage("Email verified.");
      setPurpose("");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      const r = await api("/membership/profile", {
        ...Object.fromEntries(f),
        session,
        sizes: f.getAll("sizes"),
        smsConsent: f.get("smsConsent") === "on",
        releaseConsent: f.get("releaseConsent") === "on",
      });
      setProfile(r.profile);
      setMessage("Preferences saved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="membership-page page-shell">
      <span className="eyebrow">HEWGE / MEMBERSHIP</span>
      <h1>
        <FullStops>
          {removed
            ? "You’ve left the list."
            : profile
              ? "You’re in."
              : "Join Hewge."}
        </FullStops>
      </h1>
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
      {loading ? (
        <p>Checking your link…</p>
      ) : removed ? (
        <p>
          <FullStops>
            {"Release emails and SMS preferences are switched off."}
          </FullStops>
        </p>
      ) : profile ? (
        <>
          <p className="membership-lead">
            <FullStops>
              {
                "Release dates are announced individually. Set your preferences below."
              }
            </FullStops>
          </p>
          <p className="membership-email">
            <FullStops>{profile.email}</FullStops> <span>Verified</span>
          </p>
          <form className="stack-form membership-form" onSubmit={save}>
            <fieldset>
              <legend>Your sizes</legend>
              <div className="size-options">
                {sizes.map((s) => (
                  <label key={s}>
                    <input
                      type="checkbox"
                      name="sizes"
                      value={s}
                      defaultChecked={profile.sizes?.includes(s)}
                    />
                    <span>
                      <FullStops>{s}</FullStops>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="two-fields">
              <label>
                Country
                <select name="country" defaultValue={profile.country || ""}>
                  <option value="">Choose your country</option>
                  {countryOptions.map((c) => (
                    <option value={c} key={c}>
                      {regionNames.of(c)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                City · optional
                <input
                  name="city"
                  autoComplete="address-level2"
                  maxLength={100}
                  defaultValue={profile.city || ""}
                />
              </label>
            </div>
            <label>
              For the next release
              <select
                name="readiness"
                defaultValue={profile.readiness || "following"}
              >
                <option value="following">Following the work</option>
                <option value="considering">Interested in bidding</option>
                <option value="ready">Ready to bid</option>
              </select>
            </label>
            <section className="membership-sms">
              <h2>
                <FullStops>{"By text."}</FullStops>
              </h2>
              <p>
                <FullStops>
                  {"SMS alerts are coming. Save your preference now."}
                </FullStops>
              </p>
              <label>
                Phone · optional
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+41 …"
                  maxLength={30}
                  defaultValue={profile.phone || ""}
                />
                <small>
                  <FullStops>{"Include the country code."}</FullStops>
                </small>
              </label>
              <label className="check-label">
                <input
                  name="smsConsent"
                  type="checkbox"
                  defaultChecked={profile.smsConsent === true}
                />
                <span>
                  <FullStops>
                    {
                      "Send me Hewge release alerts by SMS when available. I can switch this off anytime."
                    }
                  </FullStops>
                </span>
              </label>

              {profile.smsConsent && (
                <small>
                  <FullStops>
                    {"Saved. SMS delivery is not active yet."}
                  </FullStops>
                </small>
              )}
            </section>
            <details className="membership-more">
              <summary>A little more · optional</summary>
              <label>
                Name or alias
                <input
                  name="displayName"
                  autoComplete="nickname"
                  maxLength={80}
                  defaultValue={profile.displayName || ""}
                />
              </label>
              <label>
                Instagram
                <input
                  name="instagram"
                  placeholder="@yourname"
                  maxLength={31}
                  defaultValue={profile.instagram || ""}
                />
              </label>
              <label>
                Art you’re interested in
                <textarea
                  name="about"
                  maxLength={600}
                  rows={3}
                  defaultValue={profile.about || ""}
                />
              </label>
            </details>
            <label className="check-label">
              <input
                name="releaseConsent"
                type="checkbox"
                defaultChecked={profile.releaseConsent === true}
              />
              <span>
                <FullStops>{"Email me about Hewge releases."}</FullStops>
              </span>
            </label>
            <button className="button button-dark" disabled={busy}>
              <FullStops>{busy ? "Saving…" : "Save preferences"}</FullStops>
              <ArrowRight size={18} />
            </button>
            <p className="fine-print">
              <FullStops>
                {
                  "Membership does not enter an auction. To bid, use your collector account and meet the release’s size, destination and auction terms."
                }
              </FullStops>
            </p>
            <a className="text-link" href="/account">
              Collector account →
            </a>
          </form>
        </>
      ) : purpose ? (
        <div className="membership-confirm">
          <p>
            <FullStops>
              {purpose === "leave"
                ? "Confirm that you want to stop Hewge release emails and SMS alerts."
                : "Confirm your email, then choose your sizes and contact preferences."}
            </FullStops>
          </p>
          <button
            className="button button-dark"
            disabled={busy}
            onClick={verify}
          >
            <FullStops>
              {busy
                ? "Confirming…"
                : purpose === "leave"
                  ? "Leave release alerts"
                  : "Verify email"}
            </FullStops>
            <ArrowRight size={18} />
          </button>
        </div>
      ) : (
        <div className="subscribe-box">
          <p>
            <FullStops>
              {"Enter your email for a fresh membership link."}
            </FullStops>
          </p>
          <MembershipSignup />
        </div>
      )}
    </main>
  );
}

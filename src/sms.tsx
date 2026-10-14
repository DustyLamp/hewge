import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { FullStops } from "./typography";

export function SmsPreferences({ session }: { session?: string }) {
  const [prefs, setPrefs] = useState<any>(null),
    [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false),
    [challenge, setChallenge] = useState("");
  const [dirty, setDirty] = useState(false);
  const call = (action: string, body = {}) =>
    api(`${session ? "/membership" : "/me"}/sms/${action}`, {
      ...body,
      ...(session ? { session } : {}),
    });
  useEffect(() => {
    let mounted = true;
    call("preferences")
      .then((p) => {
        if (mounted) setPrefs(p);
      })
      .catch((e) => {
        if (mounted) setMessage(e.message);
      });
    return () => {
      mounted = false;
    };
  }, [session]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      const p = await call("save", {
        phone: f.get("phone"),
        consent: f.has("consent"),
      });
      setPrefs(p);
      setChallenge("");
      setDirty(false);
      setMessage(
        p.consent ? "Text preferences saved." : "Text alerts are switched off.",
      );
    });
  }
  return (
    <section className="membership-sms">
      <h2>
        <FullStops>{"By text."}</FullStops>
      </h2>
      <p>
        <FullStops>
          {prefs?.alertsEnabled
            ? "A text when a release opens."
            : "Text alerts are coming. Add your number below."}
        </FullStops>
      </p>
      {prefs && (
        <>
          <form
            className="stack-form"
            onSubmit={save}
            onChange={() => setDirty(true)}
            key={`${prefs.phone}:${prefs.consent}`}
          >
            <label>
              Phone · optional
              <input
                name="phone"
                type="tel"
                autoComplete="tel"
                placeholder="+41 …"
                maxLength={30}
                defaultValue={prefs.phone}
              />
              <small>
                <FullStops>{"Include the country code."}</FullStops>
              </small>
            </label>
            <label className="check-label">
              <input
                name="consent"
                type="checkbox"
                defaultChecked={prefs.consent}
              />
              <span>
                <FullStops>
                  {
                    "Send me Hewge release alerts by SMS when available. I can switch this off anytime."
                  }
                </FullStops>
              </span>
            </label>
            <button className="button button-dark" disabled={busy}>
              Save text preferences
            </button>
          </form>
          {prefs.verified && (
            <p>
              <FullStops>
                {prefs.alertsEnabled
                  ? prefs.consent
                    ? "Number verified. Text alerts are on."
                    : "Number verified. Text alerts are off."
                  : "Number verified. Release texts are not active yet."}
              </FullStops>
            </p>
          )}
          {prefs.canVerify && !dirty && (
            <button
              className="text-link"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await call("request");
                  if (r.verified) {
                    setPrefs(await call("preferences"));
                    return;
                  }
                  setChallenge(r.challenge);
                  setMessage(
                    "Check your phone. The code expires in 10 minutes.",
                  );
                })
              }
            >
              {challenge ? "Send a new code" : "Verify number"}
            </button>
          )}
          {prefs.consent && !prefs.verified && !prefs.canVerify && (
            <p>
              <FullStops>
                {"Saved. Number verification is not available yet."}
              </FullStops>
            </p>
          )}
          {challenge && !dirty && (
            <form
              className="stack-form"
              onSubmit={(e) => {
                e.preventDefault();
                const code = new FormData(e.currentTarget).get("code");
                void run(async () => {
                  setPrefs(await call("verify", { challenge, code }));
                  setChallenge("");
                  setMessage("Number verified.");
                });
              }}
            >
              <label>
                Verification code
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                />
              </label>
              <button className="button button-dark" disabled={busy}>
                Confirm number
              </button>
            </form>
          )}
        </>
      )}
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
    </section>
  );
}

export function SmsUnsubscribe() {
  const [token] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("leave") || "",
  );
  const [ready, setReady] = useState(false),
    [left, setLeft] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    history.replaceState(null, "", location.pathname);
    if (!token) {
      setMessage(
        "Open the link in your Hewge text, or change your text preferences in your account.",
      );
      return;
    }
    api("/sms/link", { token })
      .then((r) => {
        setLeft(r.unsubscribed);
        setReady(true);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  return (
    <main className="membership-page page-shell">
      <span className="eyebrow">HEWGE / TEXTS</span>
      <h1>
        <FullStops>
          {left ? "Texts switched off." : "Text preferences."}
        </FullStops>
      </h1>
      {left ? (
        <p>
          <FullStops>
            {
              "You won’t receive further release texts. A message already handed to your carrier may still arrive."
            }
          </FullStops>
        </p>
      ) : (
        ready && (
          <>
            <p>
              <FullStops>
                {"Stop Hewge release texts to this number."}
              </FullStops>
            </p>
            <button
              className="button button-dark"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/sms/leave", { token });
                  setLeft(true);
                } catch (e) {
                  setMessage(
                    e instanceof Error ? e.message : "Please try again.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Stop text alerts
            </button>
          </>
        )
      )}
      <p role="status">
        <FullStops>{message}</FullStops>
      </p>
      <a className="text-link" href="/account">
        Your account →
      </a>
    </main>
  );
}

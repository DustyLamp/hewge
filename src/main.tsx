import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowDown,
  ArrowRight,
  X,
  Plus,
  Minus,
  MoveUpRight,
  Pause,
  Play,
} from "lucide-react";
import { piece, type Catalog } from "../shared/catalog";
import { getCatalog, leaveList } from "./api";
import "./styles.css";
import { Experience } from "./experience";
import { MembershipSignup as Signup } from "./membership";
import { PieceTitle, FullStops } from "./typography";
import { SellerDetails } from "./seller";

function Wordmark({ className = "" }: { className?: string }) {
  return <span className={`wordmark ${className}`}>HEWGE</span>;
}
function App() {
  const [catalog, setCatalog] = useState<Catalog>({
    ...piece,
    status: "coming-soon",
  });
  const [modal, setModal] = useState<"signup" | "privacy" | "piece" | null>(
    null,
  );
  const [zoom, setZoom] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState("front");
  const [paused, setPaused] = useState(false);
  const [removeMessage, setRemoveMessage] = useState("");
  const shirt = useRef<HTMLDivElement>(null);
  const [purchase] = useState(
    new URLSearchParams(location.search).get("checkout"),
  );
  useEffect(() => {
    getCatalog()
      .then(setCatalog)
      .catch(() => {});
  }, []);
  useEffect(() => {
    const hash = () => {
      if (location.hash === "#privacy") setModal("privacy");
    };
    hash();
    window.addEventListener("hashchange", hash);
    return () => window.removeEventListener("hashchange", hash);
  }, []);
  useEffect(() => {
    if (modal || zoom) {
      dialog.current?.showModal();
      document.body.style.overflow = "hidden";
    } else {
      dialog.current?.close();
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [modal, zoom]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in-view");
            observer.unobserve(e.target);
          }
        }),
      { threshold: 0.12 },
    );
    document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  function close() {
    setModal(null);
    setZoom(null);
    if (location.hash === "#privacy")
      history.replaceState(null, "", location.pathname);
  }
  function move(e: React.PointerEvent<HTMLElement>) {
    if (
      paused ||
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      e.pointerType !== "mouse"
    )
      return;
    const r = e.currentTarget.getBoundingClientRect();
    shirt.current?.style.setProperty(
      "--tilt",
      `${((e.clientX - r.left) / r.width - 0.5) * 7}deg`,
    );
  }
  async function remove(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setRemoveMessage("Requesting confirmation…");
    try {
      await leaveList(String(new FormData(e.currentTarget).get("email")));
      setRemoveMessage(
        "Check your email to confirm removal. If delivery is not yet available, your request stays pending.",
      );
    } catch (e) {
      setRemoveMessage(e instanceof Error ? e.message : "Please try again.");
    }
  }
  const statusText = {
    "coming-soon": "Coming soon",
    available: "One available",
    reserved: "Currently reserved",
    sold: "Collected",
  }[catalog.status];
  return (
    <div className={paused ? "site paused" : "site"}>
      <a className="skip-link" href="#edition">
        Skip to the shirt
      </a>
      <header className="header">
        <a href="#" aria-label="Hewge home">
          <Wordmark />
        </a>
        <nav aria-label="Main navigation">
          <a href="/latest">The latest</a>
          <a href="/archive">Archive</a>
        </nav>
        <button className="header-cta" onClick={() => setModal("signup")}>
          Join Hewge <ArrowUpRight size={17} />
        </button>
      </header>
      <main>
        {purchase && (
          <div className="purchase-banner" role="status">
            <FullStops>
              {purchase === "success"
                ? "Thank you. Your payment confirmation and receipt come from Stripe."
                : "Checkout closed. Your piece may remain reserved briefly."}
            </FullStops>
          </div>
        )}

        <section
          className="hero"
          aria-label="Hewge. One-of-a-kind artist originals."
          onPointerMove={move}
          onPointerLeave={() =>
            shirt.current?.style.setProperty("--tilt", "0deg")
          }
        >
          <div className="hero-topline">
            <span>
              <FullStops>{"Artist originals."}</FullStops>
            </span>
            <span className="live-dot">First edition coming soon</span>
          </div>
          <div className="hero-word" aria-hidden="true">
            <Wordmark />
          </div>
          <div className="hero-orbit" aria-hidden="true" />
          <div className="hero-product" ref={shirt}>
            <img
              src="/images/shirt-front.webp"
              alt="Hewge shirt with intricate green foliage and toucans on a night out"
              width="1100"
              height="1194"
              fetchPriority="high"
            />
          </div>
          <div className="hero-left">
            <span className="eyebrow">
              <FullStops>{"Piece No. 001"}</FullStops>
            </span>
            <h1>
              After
              <br />
              <FullStops>{"Hours."}</FullStops>
            </h1>
            <a className="text-link" href="#edition">
              View the piece <ArrowUpRight size={19} />
            </a>
          </div>
          <div className="hero-right">
            <div className="edition-seal">
              <span>ONE</span>
              <span className="seal-line" />
              <span>OF ONE</span>
            </div>
            <span className="vertical-label">
              <FullStops>{"Signed. Singular. Unrepeatable."}</FullStops>
            </span>
          </div>
          <div className="hero-bottom">
            <span>
              <FullStops>{"Art you can wear."}</FullStops>
              <br />
              <em>
                <FullStops>{"Edition of one."}</FullStops>
              </em>
            </span>
            <a href="#edition" className="explore">
              Explore the first edition <ArrowDown size={19} />
            </a>
            <button
              className="motion-toggle"
              onClick={() => setPaused(!paused)}
              aria-label={paused ? "Play animation" : "Pause animation"}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}
            </button>
          </div>
        </section>
        <div className="ticker" aria-hidden="true">
          <div>
            {Array.from({ length: 4 }, (_, i) => (
              <span key={i}>
                ONE OF ONE <span className="asterisk">✳</span> NEVER REPEATED{" "}
                <span className="asterisk">✳</span> ARTIST SIGNED{" "}
                <span className="asterisk">✳</span>
              </span>
            ))}
          </div>
        </div>
        <section className="edition" id="edition">
          <div className="section-heading">
            <span className="eyebrow">The first edition</span>
            <span className="eyebrow">001 — The Toucan Edition</span>
          </div>
          <div className="edition-grid">
            <div
              className={`product-stage ${view === "front" ? "front-view" : ""}`}
            >
              <span className="stage-number">01 / 01</span>
              <button
                className="product-zoom"
                onClick={() =>
                  setZoom(
                    view === "front"
                      ? "/images/shirt-front.webp"
                      : view === "back"
                        ? "/images/approved-mockup.webp"
                        : "/images/front-left.webp",
                  )
                }
                aria-label="Enlarge shirt image"
              >
                <img
                  src={
                    view === "front"
                      ? "/images/shirt-front.webp"
                      : view === "back"
                        ? "/images/approved-mockup.webp"
                        : "/images/front-left.webp"
                  }
                  alt={
                    view === "front"
                      ? "After Hours — front view"
                      : view === "back"
                        ? "Approved shirt mockup — front and back"
                        : "Detail of the printed artwork"
                  }
                  loading="lazy"
                />
              </button>
              <div className="view-tabs" role="group" aria-label="Shirt views">
                {[
                  ["front", "Front"],
                  ["back", "Both sides"],
                  ["detail", "The detail"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    aria-pressed={view === value}
                    onClick={() => setView(value)}
                  >
                    <FullStops>{label}</FullStops>
                  </button>
                ))}
              </div>
              <span className="zoom-hint">
                <Plus size={14} /> Look closer
              </span>
            </div>
            <div className="product-info reveal">
              <span className="eyebrow status">
                <i />
                <FullStops>{statusText}</FullStops>
              </span>
              <h2 className="piece-title">
                <PieceTitle name="After Hours" />
              </h2>
              <p className="product-sub">The Toucan Edition</p>
              <p className="price">
                CHF 339 <span>Opening bid</span>
              </p>
              <div className="product-facts">
                <span>Material at reveal</span>
                <span>Artist signed</span>
                <span>Never repeated</span>
              </div>
              <p className="product-description">
                <FullStops>
                  {"A very good night. A very bad morning."}
                </FullStops>
              </p>
              <div className="size-line">
                <span>
                  <FullStops>
                    {catalog.size ? `Size ${catalog.size}` : "One unique piece"}
                  </FullStops>
                </span>
                <span>
                  <FullStops>
                    {catalog.size
                      ? "Only one in this size."
                      : "Size revealed at release."}
                  </FullStops>
                </span>
              </div>
              <a className="button button-dark" href="/pieces/after-hours">
                Explore the piece <ArrowUpRight size={22} />
              </a>
              <p className="under-button">
                <FullStops>{"One original. Highest bid wins."}</FullStops>
              </p>
              <details>
                <summary>
                  The piece <Plus size={17} />
                </summary>
                <p>
                  <FullStops>
                    {
                      "A men’s shirt, made as a single unique work and signed by its artist. No second run. No identical shirt in another size."
                    }
                  </FullStops>
                </p>
              </details>
              <details>
                <summary>
                  The details <Plus size={17} />
                </summary>
                <p>
                  <FullStops>
                    {
                      "A short-sleeved, open-collar silhouette. A whole night out unfolds across its illustrated panels. The images shown are the approved design mockup; final measurements and artist details will be published before release."
                    }
                  </FullStops>
                </p>
              </details>
            </div>
          </div>
        </section>
        <section className="artwork" id="artwork">
          <div className="artwork-heading reveal">
            <div>
              <span className="eyebrow">The artwork</span>
              <h2>
                LOOK
                <br />
                <span>
                  <FullStops>{"CLOSER."}</FullStops>
                </span>
              </h2>
            </div>
            <span className="small-copy">
              After Hours
              <br />
              <FullStops>{"Three details."}</FullStops>
            </span>
          </div>
          <div className="art-grid">
            {[
              { src: "front-right", label: "The invitation" },
              { src: "front-left", label: "After dark" },
              { src: "back", label: "The morning after" },
            ].map((art, i) => (
              <button
                className={`art-card art-card-${i} reveal`}
                key={art.src}
                onClick={() => setZoom(`/images/${art.src}.webp`)}
              >
                <div className="art-image">
                  <img
                    src={`/images/${art.src}.webp`}
                    alt={art.label + " — original toucan artwork"}
                    loading="lazy"
                  />
                  <span className="art-expand">
                    <MoveUpRight size={22} />
                  </span>
                </div>
                <span className="art-caption">
                  <FullStops>{art.label}</FullStops>
                  <Plus size={16} />
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className="manifesto" id="the-idea">
          <div className="manifesto-top">
            <span className="eyebrow">The Hewge way</span>
            <span className="eyebrow">Always 1 / 1</span>
          </div>
          <h2 className="reveal">
            <FullStops>{"NO COPIES."}</FullStops>
            <br />
            <FullStops>{"NO ENCORES."}</FullStops>
          </h2>
          <div className="manifesto-bottom">
            <span className="big-star" aria-hidden="true">
              ✳
            </span>
            <p>
              <FullStops>{"An original shirt."}</FullStops>
              <br />
              <FullStops>{"Signed by its artist."}</FullStops>
              <br />
              <FullStops>{"Made once."}</FullStops>
            </p>
            <span className="manifesto-signature">
              <Wordmark />
              <small>
                <FullStops>{"Art, out in the world."}</FullStops>
              </small>
            </span>
          </div>
        </section>
        <section className="guest-list" id="first-access">
          <div className="guest-art">
            <img
              src="/images/night.webp"
              alt="A toucan with champagne beside a toucan nursing a coffee"
              loading="lazy"
            />
            <span className="guest-sticker">
              You’re
              <br />
              <FullStops>{"invited."}</FullStops>
              <ArrowUpRight size={25} />
            </span>
          </div>
          <div className="guest-content reveal">
            <span className="eyebrow">Membership</span>
            <h2>
              NEXT
              <br />
              <FullStops>{"DROP."}</FullStops>
            </h2>
            <p>
              <FullStops>
                {"Verify your email for membership and release access."}
              </FullStops>
            </p>
            <Signup />
          </div>
        </section>
      </main>
      <footer>
        <div className="footer-top">
          <a href="#" aria-label="Back to top">
            <Wordmark />
          </a>
          <a href="#first-access">
            Join Hewge <ArrowUpRight size={17} />
          </a>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Hewge</span>
          <a
            href="https://www.instagram.com/hewge.design/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Instagram ↗
          </a>
          <span>Switzerland</span>
          <a href="/latest">The latest</a>
          <a href="/archive">Archive</a>
          <a href="/account">Collector access</a>
          <a href="/terms">Auction terms</a>
          <a href="/privacy">Privacy</a>
        </div>
      </footer>
      <dialog
        ref={dialog}
        aria-label={
          zoom
            ? "Artwork detail"
            : modal === "privacy"
              ? "Privacy and email preferences"
              : "Join Hewge"
        }
        className={zoom ? "modal image-modal" : "modal"}
        onCancel={close}
        onClick={(e) => {
          if (e.target === dialog.current) close();
        }}
      >
        <button
          className="modal-close"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={25} />
        </button>
        {zoom ? (
          <img
            className="enlarged-art"
            src={zoom}
            alt="Enlarged Hewge artwork"
          />
        ) : modal === "privacy" ? (
          <div className="privacy-content">
            <span className="eyebrow">Your details, kept simple</span>
            <h2>
              <FullStops>{"Privacy."}</FullStops>
            </h2>
            <SellerDetails />
            <p>
              <FullStops>
                {
                  "Hewge uses your email to verify membership and send release announcements after confirmation. Joining is optional. We don’t sell your details or use advertising trackers."
                }
              </FullStops>
            </p>
            <p>
              <FullStops>
                {
                  "Membership details are stored with AWS in Stockholm, Sweden. Unconfirmed requests expire after 48 hours; verified membership records expire after 180 days. The website processes technical request information to operate the site and prevent abuse."
                }
              </FullStops>
            </p>
            <p>
              <FullStops>
                {
                  "Request a confirmation link below to leave release alerts. You can also change your preferences through your membership link. Read the full privacy notice for account data and deletion."
                }
              </FullStops>
            </p>
            <h3>Leave release alerts</h3>
            <form onSubmit={remove} className="remove-form">
              <label htmlFor="remove-email">Email address</label>
              <input
                id="remove-email"
                name="email"
                type="email"
                required
                placeholder="you@example.com"
              />
              <button className="button button-dark">
                Leave release alerts <Minus size={17} />
              </button>
            </form>
            <p role="status">
              <FullStops>{removeMessage}</FullStops>
            </p>
          </div>
        ) : (
          <div className="signup-modal-content">
            <span className="eyebrow">Membership</span>
            <h2>
              YOU’RE
              <br />
              <FullStops>{"INVITED."}</FullStops>
            </h2>
            <p>
              <FullStops>{"Start with your email."}</FullStops>
            </p>
            <Signup compact />
          </div>
        )}
      </dialog>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname === "/" ? <App /> : <Experience />}
  </React.StrictMode>,
);

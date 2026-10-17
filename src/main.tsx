import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowDown,
  ArrowRight,
  X,
  Plus,
  Minus,
} from "lucide-react";
import { type Release } from "../shared/auction";
import { type PageContent } from "../shared/content";
import { api, leaveList } from "./api";
import "./styles.css";
import { Experience } from "./experience";
import { MembershipSignup as Signup } from "./membership";
import { PieceTitle, FullStops } from "./typography";
import { SellerDetails } from "./seller";

function Wordmark({ className = "" }: { className?: string }) {
  return <span className={`wordmark ${className}`}>HEWGE</span>;
}
function App() {
  const [catalog, setCatalog] = useState<Release | null>(null);
  const [page, setPage] = useState<PageContent | null>(null);
  const [loadError, setLoadError] = useState("");
  const [modal, setModal] = useState<"signup" | "privacy" | "piece" | null>(
    null,
  );
  const [zoom, setZoom] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState("0");
  const [removeMessage, setRemoveMessage] = useState("");
  const [purchase] = useState(
    new URLSearchParams(location.search).get("checkout"),
  );
  useEffect(() => {
    api("/content/home")
      .then((r) => {
        setCatalog(r.release);
        setPage(r.page.data);
        if (!r.release) setLoadError("The next piece will appear here soon.");
      })
      .catch(() =>
        setLoadError("The page is temporarily unavailable. Please refresh."),
      );
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
  }, [catalog]);
  function close() {
    setModal(null);
    setZoom(null);
    if (location.hash === "#privacy")
      history.replaceState(null, "", location.pathname);
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
  if (!catalog || !page)
    return (
      <main className="page-shell">
        <a href="/" className="wordmark">
          HEWGE
        </a>
        <p role="status">{loadError || "Loading the piece…"}</p>
        <a href="/archive">Explore the archive →</a>
      </main>
    );
  const gallery = catalog.gallery || [];
  const views = [
    { image: catalog.image, label: "Front" },
    ...gallery.slice(0, 2),
  ];
  const activeImage = views[Number(view)] || views[0];
  document.title = `${catalog.name} — HEWGE`;
  const statusText = (
    {
      unannounced: "Coming soon",
      scheduled: "Upcoming release",
      open: "Bidding open",
      closed: "Closed",
      "awaiting-payment": "Payment pending",
      sold: "Collected",
    } as Record<string, string>
  )[catalog.status];
  return (
    <div className="site">
      <a className="skip-link" href="#edition">
        Skip to the shirt
      </a>
      <header className="header">
        <a href="#" aria-label="Hewge home">
          <Wordmark />
        </a>
        <nav aria-label="Main navigation">
          <a href="/latest">The latest</a>
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
        >
          <div className="hero-topline">
            <span>
              <FullStops>{"Artist originals."}</FullStops>
            </span>
            <span>
              <FullStops>{page.heroLabel}</FullStops>
            </span>
          </div>
          <div className="hero-word" aria-hidden="true">
            <Wordmark />
          </div>
          <div className="hero-product">
            <img
              src={catalog.image}
              alt={`${catalog.name} — front view`}
              width="1100"
              height="1194"
              fetchPriority="high"
            />
          </div>
          <div className="hero-left">
            <span className="eyebrow">
              <FullStops>{`Piece No. ${catalog.number}`}</FullStops>
            </span>
            <h1>
              <PieceTitle name={catalog.name} />
            </h1>
            <a className="text-link" href="#edition">
              View the piece <ArrowUpRight size={19} />
            </a>
          </div>
          <div className="hero-bottom">
            <span>
              <FullStops>
                {catalog.presentation === "design-study"
                  ? "Design study · Not yet released."
                  : "Art, out in the world."}
              </FullStops>
            </span>
            <a href="#edition" className="explore">
              Explore the piece <ArrowDown size={19} />
            </a>
          </div>
        </section>
        <section className="edition" id="edition">
          <div className="section-heading">
            <span className="eyebrow">
              <FullStops>{page.editionLabel}</FullStops>
            </span>
            <span className="eyebrow">
              <FullStops>{`${catalog.number} — ${catalog.name}`}</FullStops>
            </span>
          </div>
          <div className="edition-grid">
            <div
              className={`product-stage ${view === "0" ? "front-view" : ""}`}
            >
              <span className="stage-number">No. {catalog.number}</span>
              <button
                className="product-zoom"
                onClick={() => setZoom(activeImage.image)}
                aria-label="Enlarge shirt image"
              >
                <img
                  src={activeImage.image}
                  alt={`${catalog.name} — ${activeImage.label}`}
                  loading="lazy"
                />
              </button>
              <div className="view-tabs" role="group" aria-label="Shirt views">
                {views.map((image, index) => {
                  const value = String(index),
                    label = image.label;
                  return (
                    <button
                      key={value}
                      aria-pressed={view === value}
                      onClick={() => setView(value)}
                    >
                      <FullStops>{label}</FullStops>
                    </button>
                  );
                })}
              </div>
              <span className="zoom-hint">
                <Plus size={14} /> Look closer
              </span>
            </div>
            <div className="product-info reveal">
              <span className="eyebrow status">
                <i />
                <FullStops>
                  {catalog.presentation === "design-study"
                    ? "Design study"
                    : statusText}
                </FullStops>
              </span>
              <h2 className="piece-title">
                <PieceTitle name={catalog.name} />
              </h2>
              <p className="price">
                CHF{" "}
                {new Intl.NumberFormat("de-CH").format(
                  catalog.openingBid / 100,
                )}{" "}
                <span>Opening bid</span>
              </p>
              <div className="product-facts">
                <span>
                  <FullStops>
                    {catalog.material || "Material at reveal"}
                  </FullStops>
                </span>
                {catalog.artistName && (
                  <span>
                    <FullStops>{catalog.artistName}</FullStops>
                  </span>
                )}
              </div>
              <p className="product-description">
                <FullStops>{catalog.subtitle || "Edition of one."}</FullStops>
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
              <a
                className="button button-dark"
                href={`/pieces/${catalog.slug}`}
              >
                Explore the piece <ArrowUpRight size={22} />
              </a>
              {catalog.imageNote && (
                <p className="under-button">
                  <FullStops>{catalog.imageNote}</FullStops>
                </p>
              )}
              <details>
                <summary>
                  The piece <Plus size={17} />
                </summary>
                <p>
                  <FullStops>
                    {catalog.description ||
                      "One unique garment. Artist signed."}
                  </FullStops>
                </p>
              </details>
              <details>
                <summary>
                  The details <Plus size={17} />
                </summary>
                <p>
                  <FullStops>
                    {catalog.imageNote ||
                      catalog.measurements ||
                      "Details at release."}
                  </FullStops>
                </p>
              </details>
            </div>
          </div>
        </section>
        {gallery.length > 0 && (
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
                <FullStops>{catalog.name}</FullStops>
                <br />
                <FullStops>{`${gallery.length} views.`}</FullStops>
              </span>
            </div>
            <div className="art-grid">
              {gallery.map((art, i) => (
                <button
                  className={`art-card art-card-${i} reveal`}
                  key={art.image}
                  onClick={() => setZoom(art.image)}
                >
                  <div className="art-image">
                    <img
                      src={art.image}
                      alt={`${catalog.name} — ${art.label}`}
                      loading="lazy"
                    />
                  </div>
                  <span className="art-caption">
                    <FullStops>{art.label}</FullStops>
                    <Plus size={16} />
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="hewge-note" id="the-idea">
          <span className="eyebrow">Hewge</span>
          <div>
            <h2>
              <FullStops>{page.manifestoTitle}</FullStops>
            </h2>
            <p>
              <FullStops>{page.manifestoText}</FullStops>
            </p>
            {page.manifestoSignature && (
              <p className="eyebrow">
                <FullStops>{page.manifestoSignature}</FullStops>
              </p>
            )}
            <a className="text-link" href="mailto:jez@hewge.design">
              Get in touch <ArrowUpRight size={17} />
            </a>
          </div>
        </section>
        <section className="guest-list" id="first-access">
          <div className="guest-art">
            <img
              src={page.guestImage}
              alt={page.guestImageAlt}
              loading="lazy"
            />
          </div>
          <div className="guest-content reveal">
            <span className="eyebrow">Membership</span>
            <h2>
              <span className="cms-lines">
                <FullStops>{page.guestTitle}</FullStops>
              </span>
            </h2>
            <p>
              <FullStops>{page.guestText}</FullStops>
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
          <a href="mailto:jez@hewge.design">Contact</a>
          <a href="/terms">Auction terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/withdraw">Withdraw from contract here</a>
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

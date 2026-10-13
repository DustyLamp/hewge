import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, ArrowDown, ArrowRight, X, Plus, Minus, MoveUpRight, Pause, Play, Check } from 'lucide-react';
import { piece, type Catalog } from '../shared/catalog';
import { getCatalog, joinList, leaveList, beginCheckout } from './api';
import './styles.css';

function Wordmark({ className = '' }: {className?:string}) { return <span className={`wordmark ${className}`}>HEWGE</span>; }
function Signup({ compact = false }: {compact?:boolean}) {
 const [state,setState] = useState<'idle'|'pending'|'success'|'error'>('idle'); const [message,setMessage] = useState('');
 async function submit(e:FormEvent<HTMLFormElement>) {
  e.preventDefault(); const form = new FormData(e.currentTarget); setState('pending');
  try { await joinList(String(form.get('email')),String(form.get('website'))); setState('success'); }
  catch(error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Please try again.'); }
 }
 return state === 'success' ? <div className="signup-success" role="status"><Check size={24}/><div>You’re on the list.<small>We’ll let you know when it’s time.</small></div></div> : <form onSubmit={submit} className={`signup ${compact?'compact':''}`}>
  <label className="sr-only" htmlFor={compact?'email-modal':'email-footer'}>Your email address</label>
  <div className="email-line"><input id={compact?'email-modal':'email-footer'} name="email" type="email" placeholder="Your email address" autoComplete="email" required maxLength={254}/><button disabled={state==='pending'} aria-label="Join the guest list">{state==='pending'?<span className="spinner"/>:<ArrowRight size={26}/>}</button></div>
  <label className="honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off"/></label>
  <p className="form-note">By joining, you agree to receive Hewge launch emails.<br/>Leave whenever you like. <a href="#privacy">Privacy</a></p>
  {state==='error'&&<p role="alert" className="form-error">{message}</p>}
 </form>;
}
function App() {
 const [catalog,setCatalog] = useState<Catalog>({...piece,status:'coming-soon'});
 const [modal,setModal] = useState<'signup'|'privacy'|'piece'|null>(null);
 const [zoom,setZoom] = useState<string|null>(null); const dialog = useRef<HTMLDialogElement>(null);
 const [view,setView] = useState('front'); const [paused,setPaused] = useState(false);
 const [checking,setChecking] = useState(false); const [checkoutError,setCheckoutError] = useState('');
 const [removeMessage,setRemoveMessage] = useState('');
 const shirt = useRef<HTMLDivElement>(null);
 const [purchase] = useState(new URLSearchParams(location.search).get('checkout'));
 useEffect(()=>{getCatalog().then(setCatalog).catch(()=>{});},[]);
 useEffect(()=>{
  const hash = () => {if(location.hash==='#privacy') setModal('privacy');}; hash(); window.addEventListener('hashchange',hash); return()=>window.removeEventListener('hashchange',hash);
 },[]);
 useEffect(()=>{
  if(modal||zoom) {dialog.current?.showModal(); document.body.style.overflow='hidden';} else {dialog.current?.close();document.body.style.overflow='';}
  return()=>{document.body.style.overflow='';};
 },[modal,zoom]);
 useEffect(()=>{
  const observer = new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in-view');observer.unobserve(e.target);}}),{threshold:0.12});
  document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));return()=>observer.disconnect();
 },[]);
 function close() {setModal(null);setZoom(null); if(location.hash==='#privacy') history.replaceState(null,'',location.pathname);}
 function move(e:React.PointerEvent<HTMLElement>) {
  if(paused||matchMedia('(prefers-reduced-motion: reduce)').matches||e.pointerType!=='mouse')return;
  const r=e.currentTarget.getBoundingClientRect(); shirt.current?.style.setProperty('--tilt',`${((e.clientX-r.left)/r.width-.5)*7}deg`);
 }
 async function checkout() {
  setChecking(true);setCheckoutError('');
  try { const {url} = await beginCheckout(); const parsed=new URL(url); if(parsed.protocol!=='https:'||parsed.hostname!=='checkout.stripe.com') throw Error('Checkout is unavailable. Please try again.'); location.assign(url); }
  catch(error) {setCheckoutError(error instanceof Error?error.message:'Please try again.');setChecking(false);getCatalog().then(setCatalog).catch(()=>{});}
 }
 async function remove(e:FormEvent<HTMLFormElement>) {e.preventDefault();setRemoveMessage('Removing…');try {await leaveList(String(new FormData(e.currentTarget).get('email')));setRemoveMessage('Your email has been removed, if it was on the list.');}catch(e){setRemoveMessage(e instanceof Error?e.message:'Please try again.');}}
 const statusText = {'coming-soon':'Coming soon',available:'One available',reserved:'Currently reserved',sold:'Collected'}[catalog.status];
 return <div className={paused?'site paused':'site'}>
  <a className="skip-link" href="#edition">Skip to the shirt</a>
  <header className="header"><a href="#" aria-label="Hewge home"><Wordmark/></a><nav aria-label="Main navigation"><a href="#edition">The edition <span>01</span></a><a href="#the-idea">The idea</a></nav><button className="header-cta" onClick={()=>setModal('signup')}>Get first access <ArrowUpRight size={17}/></button></header>
  <main>
   {purchase&&<div className="purchase-banner" role="status">{purchase==='success'?'Thank you. Your payment confirmation and receipt come from Stripe.':'Checkout closed. Your piece may remain reserved briefly.'}</div>}
   <section className="hero" aria-label="Hewge. One-of-a-kind silk shirts." onPointerMove={move} onPointerLeave={()=>shirt.current?.style.setProperty('--tilt','0deg')}>
    <div className="hero-topline"><span>Wearable art. Unrepeatable.</span><span className="live-dot">First edition coming soon</span></div>
    <div className="hero-word" aria-hidden="true"><Wordmark/></div>
    <div className="hero-orbit" aria-hidden="true"/>
    <div className="hero-product" ref={shirt}><img src="/images/shirt-front.webp" alt="Hewge silk shirt with intricate green foliage and toucans on a night out" width="1100" height="1194" fetchPriority="high"/></div>
    <div className="hero-left"><span className="eyebrow">Piece No. 001</span><h1>Life’s too short<br/>to blend in.</h1><a className="text-link" href="#edition">Meet your one of one <ArrowUpRight size={19}/></a></div>
    <div className="hero-right"><div className="edition-seal"><span>ONE</span><span className="seal-line"/><span>OF ONE</span></div><span className="vertical-label">Silk. Signed. Singular.</span></div>
    <div className="hero-bottom"><span>Art you can wear.<br/><em>Nobody else can.</em></span><a href="#edition" className="explore">Explore the first edition <ArrowDown size={19}/></a><button className="motion-toggle" onClick={()=>setPaused(!paused)} aria-label={paused?'Play animation':'Pause animation'}>{paused?<Play size={13}/>:<Pause size={13}/>}</button></div>
   </section>
   <div className="ticker" aria-hidden="true"><div>{Array.from({length:4},(_,i)=><span key={i}>ONE OF ONE <span className="asterisk">✳</span> NEVER REPEATED <span className="asterisk">✳</span> ARTIST SIGNED <span className="asterisk">✳</span></span>)}</div></div>
   <section className="edition" id="edition">
    <div className="section-heading"><span className="eyebrow">The first edition</span><span className="eyebrow">001 — The Toucan Edition</span></div>
    <div className="edition-grid">
     <div className={`product-stage ${view==='front'?'front-view':''}`}>
      <span className="stage-number">01 / 01</span><button className="product-zoom" onClick={()=>setZoom(view==='front'?'/images/shirt-front.webp':view==='back'?'/images/approved-mockup.webp':'/images/front-left.webp')} aria-label="Enlarge shirt image"><img src={view==='front'?'/images/shirt-front.webp':view==='back'?'/images/approved-mockup.webp':'/images/front-left.webp'} alt={view==='front'?'After Hours — front view':view==='back'?'Approved shirt mockup — front and back':'Detail of the printed silk artwork'} loading="lazy"/></button>
      <div className="view-tabs" role="group" aria-label="Shirt views">{[['front','Front'],['back','Both sides'],['detail','The detail']].map(([value,label])=><button key={value} aria-pressed={view===value} onClick={()=>setView(value)}>{label}</button>)}</div><span className="zoom-hint"><Plus size={14}/> Look closer</span>
     </div>
     <div className="product-info reveal"><span className="eyebrow status"><i/>{statusText}</span><h2>After<br/><span>Hours.</span></h2><p className="product-sub">The Toucan Edition</p><p className="price">CHF 339 <span>01 / 01</span></p><div className="product-facts"><span>Silk</span><span>Artist signed</span><span>Never repeated</span></div><p className="product-description">A very good night. A very bad morning.<br/>An entire world, on silk.</p><div className="size-line"><span>{catalog.size?`Size ${catalog.size}`:'One unique piece'}</span><span>{catalog.size?'Only one in this size.':'Size revealed at release.'}</span></div>
      <button className="button button-dark" disabled={checking||catalog.status==='sold'||catalog.status==='reserved'} onClick={catalog.status==='available'?checkout:()=>setModal('signup')}>{checking?'Opening checkout…':catalog.status==='available'?'Make it yours':catalog.status==='sold'?'One of one. Gone.':catalog.status==='reserved'?'Currently reserved':'Let me know'}<ArrowUpRight size={22}/></button>{checkoutError&&<p role="alert">{checkoutError}</p>}
      <p className="under-button">{catalog.status==='available'?'Secure checkout. Just one piece.':'First access. No noise.'}</p>
      <details><summary>The piece <Plus size={17}/></summary><p>A men’s silk shirt, made as a single unique work and signed by its artist. No second run. No identical shirt in another size.</p></details><details><summary>The details <Plus size={17}/></summary><p>A short-sleeved, open-collar silhouette. A whole night out unfolds across its illustrated panels. The images shown are the approved design mockup; final measurements and artist details will be published before release.</p></details>
     </div>
    </div>
   </section>
   <section className="artwork" id="artwork"><div className="artwork-heading reveal"><div><span className="eyebrow">There’s a whole world in here</span><h2>LOOK<br/><span>CLOSER.</span></h2></div><span className="small-copy">Every panel.<br/>A different story.</span></div><div className="art-grid">{[{src:'front-right',label:'01 — The invitation'},{src:'front-left',label:'02 — After dark'},{src:'back',label:'03 — The morning after'}].map((art,i)=><button className={`art-card art-card-${i} reveal`} key={art.src} onClick={()=>setZoom(`/images/${art.src}.webp`)}><div className="art-image"><img src={`/images/${art.src}.webp`} alt={art.label.slice(5)+' — original toucan artwork'} loading="lazy"/><span className="art-expand"><MoveUpRight size={22}/></span></div><span className="art-caption">{art.label}<Plus size={16}/></span></button>)}</div></section>
   <section className="manifesto" id="the-idea"><div className="manifesto-top"><span className="eyebrow">The Hewge way</span><span className="eyebrow">Always 1 / 1</span></div><h2 className="reveal">NO COPIES.<br/>NO ENCORES.</h2><div className="manifesto-bottom"><span className="big-star" aria-hidden="true">✳</span><p>One artist. Or a meeting of minds.<br/>One silk shirt. Signed.<br/>One person in the world wearing it.<br/><strong>You.</strong></p><span className="manifesto-signature"><Wordmark/><small>Art, out in the world.</small></span></div></section>
   <section className="guest-list" id="first-access"><div className="guest-art"><img src="/images/night.webp" alt="A toucan with champagne beside a toucan nursing a coffee" loading="lazy"/><span className="guest-sticker">You’re<br/>invited.<ArrowUpRight size={25}/></span></div><div className="guest-content reveal"><span className="eyebrow">Good things don’t come twice</span><h2>BE<br/>FIRST.</h2><p>New art. One-off pieces. Your invitation.</p><Signup/></div></section>
  </main>
  <footer><div className="footer-top"><a href="#" aria-label="Back to top"><Wordmark/></a><a href="#first-access">Join the guest list <ArrowUpRight size={17}/></a></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Hewge</span><span>Switzerland · Out of the ordinary.</span><button onClick={()=>setModal('privacy')}>Privacy & your email</button></div></footer>
  <dialog ref={dialog} aria-label={zoom?"Artwork detail":modal==='privacy'?"Privacy and email preferences":"Join the Hewge guest list"} className={zoom?'modal image-modal':'modal'} onCancel={close} onClick={e=>{if(e.target===dialog.current)close();}}><button className="modal-close" onClick={close} aria-label="Close dialog"><X size={25}/></button>
   {zoom?<img className="enlarged-art" src={zoom} alt="Enlarged Hewge artwork"/>:modal==='privacy'?<div className="privacy-content"><span className="eyebrow">Your details, kept simple</span><h2>Privacy.</h2><p>Hewge, Switzerland, uses the email you submit only for Hewge launch and new-piece announcements. Joining is optional. We don’t sell your details or use advertising trackers.</p><p>Your email and consent date are stored with AWS in Stockholm, Sweden. Unused signups expire after 180 days. The website and its API process technical request information to operate the site and prevent abuse.</p><p>You can remove your address below at any time. Once checkout opens, Stripe will process payments under its own privacy policy; card details never reach this website.</p><h3>Leave the guest list</h3><form onSubmit={remove} className="remove-form"><label htmlFor="remove-email">Email address</label><input id="remove-email" name="email" type="email" required placeholder="you@example.com"/><button className="button button-dark">Remove my email <Minus size={17}/></button></form><p role="status">{removeMessage}</p></div>:<div className="signup-modal-content"><span className="eyebrow">One of one. First in line.</span><h2>YOU’RE<br/>INVITED.</h2><p>Be there when the first piece drops.</p><Signup compact/></div>}
  </dialog>
 </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

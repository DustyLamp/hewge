import { sellerContactText } from "./seller";

export const TERMS_VERSION = "auction-2026-10-14";
export const PRIVACY_VERSION = "privacy-2026-10-14-sms";
export const CARD_MANDATE_VERSION = "winning-card-2026-10-14";
export const PAYMENT_RECOVERY_HOURS = 24;
export const cardMandate =
  "I authorise Hewge to save my card with Stripe and charge it once if I win this release, for my winning bid plus the shipping charge shown before my bid. Payment is due immediately at closing. I will complete any bank authentication promptly. This authorisation is for this release only; it is not a subscription. I am authorised to use this card. The billing address I enter at Stripe is also my delivery address.";

export type LegalSection = { title: string; paragraphs: string[] };
export const termsSections: LegalSection[] = [
  {
    title: "The seller and these terms",
    paragraphs: [
      "Lewis operates HEWGE from the address below. These terms govern bids and purchases directly from Hewge, and the separate registration service for later transfers. Contact us at jez@hewge.design for order, return, authenticity or privacy questions. Keep the version linked to your bid; later changes do not alter an existing bid or sale.",
      "Bidding is currently disabled. The rules below describe the auction service being prepared. A release can open only after its required product, destination, tax, delivery and payment details are complete. Only destinations expressly enabled for that release are accepted.",
    ],
  },
  {
    title: "The original and its description",
    paragraphs: [
      "Each lot is one identified garment in one stated size. There is no interchangeable size stock. Before bidding, check the photographs, condition, composition, measurements, artist and provenance disclosures, total price information and delivery terms on the release page. A one-of-one garment is not automatically a made-to-order or personalised product.",
      "Required product information must be available before a binding bid. A planned reveal cannot override that requirement. Images may differ slightly between screens, but this does not excuse a material discrepancy or misdescription. Buying the garment does not transfer the artist’s copyright or reproduction rights.",
    ],
  },
  {
    title: "Eligibility and the card check",
    paragraphs: [
      "You must be at least 18, legally able to contract, signed in with a verified email, and able to receive the lot at an eligible delivery address. Provide accurate information, check the measurements, and use a card you are authorised to use. The seller cannot bid. Shill bidding, collusion, account sharing to evade restrictions and interference with the auction are prohibited.",
      "Before your first bid on a release, complete Stripe’s card setup and any bank authentication. No bidding fee is charged. Your bank may show a temporary verification authorisation. The check does not reserve your bid amount, guarantee available funds, verify legal title or guarantee that a later payment will succeed. Hewge receives payment references and limited card details, not the full card number or security code.",
      cardMandate,
    ],
  },
  {
    title: "Submitting a binding bid",
    paragraphs: [
      "Bids are in CHF. The release shows the minimum bid, increment, shipping charge and eligible destinations. There is no buyer’s premium. Any tax Hewge must collect must be included or clearly itemised before bidding. Import charges payable to another party must be described for the destination before bidding; no undisclosed Hewge charge is added afterwards.",
      "Enter your amount, read the terms and card authorisation, then review the total. The final button explicitly places a bid with an obligation to pay if you win. A bid is accepted only when our server records it and confirms acceptance. A browser countdown, button click or interrupted request alone is not acceptance. If confirmation is uncertain, check with Hewge before submitting again.",
      "An accepted bid is binding until it is outbid or the auction is validly cancelled, subject to mandatory legal rights. The highest valid bid recorded before the published closing instant wins; an equal or late bid cannot displace it. Server time determines acceptance. There are no hidden closing extensions, random selections or advantages for social-media following.",
    ],
  },
  {
    title: "Closing, payment and failed payments",
    paragraphs: [
      "At the published closing time, the highest valid accepted bid forms the sale at that bid plus the disclosed shipping charge, subject to mandatory law. Payment is due immediately. Hewge initiates one card charge when the server settles the auction, normally within a minute of closing; outages or processor delays may delay the attempt. You authorise only your winning amount and disclosed shipping for that release.",
      "If the bank declines payment or requires further authentication, return to your collector account and complete card payment promptly. A failed check or charge does not by itself cancel a binding purchase. The account may show a technical recovery deadline; this is not credit or a right to postpone payment. We do not repeatedly debit your card or charge a penalty automatically. Contact us promptly if a bid or payment appears unauthorised.",
      "Before ending an unpaid sale, Hewge will reconcile any pending payment and give any notice and reasonable final opportunity required by law. Only after lawful termination and confirmation that no payment can still settle may the garment be offered again. A later offer to a previous bidder is optional, at that bidder’s own highest bid, and requires fresh express acceptance; losing bids are not automatically charged. We will not collect the full sale price from two buyers for the same garment. Any claim for non-payment is limited to legally recoverable, evidenced loss, with applicable mitigation and consumer protections.",
    ],
  },
  {
    title: "Delivery and ownership",
    paragraphs: [
      "The address entered during the card check is your delivery address. Ensure it is correct before bidding. Contact Hewge to request a correction; we must verify it and cannot redirect a parcel to an ineligible destination or add an undisclosed charge without agreement. The release states the shipping charge, dispatch and delivery estimates and any import arrangements. Delivery is insured and tracked. If a promised date cannot be met, we will contact you; statutory delay and cancellation remedies remain available.",
      "The collector account is linked privately to the purchase and subsequent registration. Registration is made only after confirmed payment. Dispatch follows the authenticity and fulfilment checks. As between Hewge and a consumer, transit risk remains with Hewge until physical delivery, except where applicable law expressly provides otherwise. Mandatory property rules and third-party rights take priority over the register.",
    ],
  },
  {
    title: "Returns and defects",
    paragraphs: [
      "We do not offer voluntary change-of-mind returns or size exchanges. For Swiss purchases without a mandatory withdrawal right, an accepted sale is final on that basis. This does not exclude rights for defects, misdescription, non-delivery, fraud or any other remedy that cannot lawfully be excluded.",
      "Where mandatory distance-selling withdrawal rights apply, including eligible EU/EEA or UK consumer purchases, those rights prevail. An online-only auction is not treated here as an in-person public auction exemption. One-of-one status alone is not an exception. No checkbox waives mandatory rights.",
      "Where a 14-day withdrawal right applies, use the “Withdraw from contract here” function at https://hewge.design/withdraw, email jez@hewge.design or notify the seller’s postal address with a clear statement within 14 days after you or your nominated recipient receives the garment. You may notify us before delivery. Include the order or piece reference and your contact details. The online function provides a timestamped receipt and queues email confirmation without undue delay. The optional withdrawal form below is available but not required. Send the garment back within 14 days of notification. Unless applicable law requires otherwise, you bear the direct return postage cost for a change-of-mind withdrawal; we bear reasonable return costs for a substantiated defect or our error.",
      "For a valid withdrawal, we refund the price and the least expensive standard outbound delivery charge within 14 days of notice, using the original payment method without a refund fee. Where lawful, we may wait until we receive the garment or evidence it was sent back, whichever occurs first. Please return its certificate, card and accessories and use suitable protective packaging. Inspecting the garment as you would in a shop is permitted. Only legally permitted diminished value from handling beyond necessary inspection may be deducted; a missing package or broken seal does not automatically remove withdrawal rights.",
      "Report defects or damage promptly with the piece reference and, if reasonably available, photographs. Do not send sensitive identity documents by ordinary email. We will investigate and provide the remedies required by the applicable law. A one-of-one piece may not have an identical replacement; that does not remove any right to repair, price reduction or refund. No short contractual reporting deadline overrides mandatory rights.",
    ],
  },
  {
    title: "Authenticity, the register and later transfers",
    paragraphs: [
      "An artist-signed certificate, garment details, physical security features and reviewed provenance support verification together. A printed code, NFC scan, certificate or account entry alone is not conclusive proof of authenticity or legal title. Public ownership is anonymous by default; you may choose a public name and later hide it.",
      "A registered transfer requires the current registered owner’s request, the named recipient’s verified acceptance and Hewge’s review of the garment, possession and entitlement evidence. The recipient pays 0.5% of the declared resale price, rounded to the nearest CHF cent; gifts use the last verified sale value. Any separate provider charge must be disclosed before agreement. Hewge may require evidence of value and will not silently raise the percentage to meet a processor minimum.",
      "The transfer fee is for reviewed registration, not a purchase of the garment or a guarantee of legal title. Payment does not guarantee approval. A paid transfer that cannot be approved is referred for a fee refund; no automatic forfeiture applies. Statutory rights for the registration service remain available. Where a service withdrawal right applies, Hewge waits until that period ends unless a separately valid request for early performance and the legally required acknowledgements have been obtained.",
      "Hewge does not currently hold resale proceeds or provide escrow. Any third-party resale, escrow or payment service requires separately disclosed terms. A disputed, stolen or compromised piece may have verification and transfer suspended while evidence is reviewed. A damaged tag or lost certificate does not itself extinguish ownership: contact Hewge for reviewed recovery, revocation of old identifiers and replacement documentation. Corrections and lawful reversals append history; they do not silently rewrite it.",
    ],
  },
  {
    title: "Errors, disputes and governing law",
    paragraphs: [
      "Contact Hewge promptly about an incorrect bid, material listing error, suspected fraud or service failure. We may pause an affected auction, investigate invalid bids or cancel where objectively justified and legally permitted, with notice and appropriate refunds. We do not reserve an unrestricted right to rewrite an accepted price, choose a different winner or exclude liability for our own unlawful conduct.",
      "Swiss law applies, without depriving a consumer of mandatory protections or courts available under the law that otherwise applies, including protections of their habitual residence where required. These terms do not exclude liability that cannot lawfully be excluded, including for fraud, intentional misconduct, gross negligence or personal injury. If a provision is unenforceable, applicable law governs that issue and the remaining terms continue where legally possible.",
    ],
  },
  {
    title: "Optional withdrawal form",
    paragraphs: [
      `To: ${sellerContactText.replace(/\n/g, ", ")}. I give notice that I withdraw from my contract for the following garment or registration service: ____. Ordered on / received on: ____. Order or piece reference: ____. Consumer name and address: ____. Date: ____. Signature only if sent on paper. Delete whichever does not apply.`,
    ],
  },
];

export const privacySections: LegalSection[] = [
  {
    title: "Who is responsible",
    paragraphs: [
      "Lewis, operating HEWGE at the address below, is the controller. Contact jez@hewge.design for privacy questions and rights requests. This notice covers the site, membership, collector accounts, auctions, payments, delivery, authenticity and registered transfers. Swiss data-protection law applies; we also apply GDPR requirements where our activities fall within its scope.",
    ],
  },
  {
    title: "Data and purposes",
    paragraphs: [
      "Membership uses your email, verification and communication choices. After verification you can optionally add size interests, country, city, bidding interests and other preferences. Accounts use a verified email and account identifier; bidding also requires age confirmation, eligible country and size preferences, accepted terms, and card verification. We record bids, timestamps, sale and payment references, delivery details, certificate references and registered ownership. Withdrawal notices include your name, confirmation email, contract reference, statement and receipt time, with records of the response and any refund. We link a purchase privately to the verified account so we can deliver it, establish the registered owner and review future transfers.",
      "Optional profile fields include a chosen name, Instagram handle, self-reported follower count, phone and interests. Browser language and time zone inform audience planning; they do not prove location. We do not request GPS, scrape social accounts or use follower counts to choose winners. SMS marketing requires separate consent and number verification and is not currently active.",
      "For a transfer, we receive the recipient email from the requesting owner and then verify it with the recipient’s account. The recipient can decline. Review may involve possession evidence, garment and certificate photographs, transaction evidence and, only where proportionate and necessary, additional identity evidence. We explain additional requests and use a private upload route. Do not include unrelated people or unneeded identity documents in uploads.",
    ],
  },
  {
    title: "Why we may process it",
    paragraphs: [
      "Where the GDPR applies, account, bidding, payment, delivery and requested ownership services rely on steps you request before a contract or its performance (Article 6(1)(b)). Required accounting and legal records rely on applicable legal obligations (6(1)(c)). Fraud prevention, service security, resolving claims and maintaining reliable provenance rely on legitimate interests (6(1)(f)), subject to necessity, proportionality and your rights. We assess those interests rather than assuming that owning an object permits unlimited personal-data retention.",
      "Optional release marketing and an optional public name rely on your consent (6(1)(a)). You may withdraw it at any time without affecting earlier lawful processing. Buying or registering a piece does not subscribe you to marketing. Essential account, payment, delivery and security notices are separate. Refusing necessary purchase or verification details may prevent the requested transaction, but optional profile and marketing fields are not purchase conditions.",
    ],
  },
  {
    title: "Cards and service providers",
    paragraphs: [
      "Stripe handles the full card number, security code and bank authentication. Hewge stores Stripe references, setup status, limited card details such as brand and last four digits, and delivery details. A successful card setup is not an identity check or proof of ownership. Stripe also processes data for its own regulated and fraud-prevention purposes under its privacy notice.",
      "Authorised Hewge staff have access according to their duties. AWS provides hosting, identity, encrypted storage, email and SMS delivery; telecommunications providers process numbers and messages to deliver texts. Stripe provides payments when activated. Delivery carriers receive information necessary to deliver and insure parcels. Professional advisers, insurers and competent authorities receive data where necessary and lawful. We do not sell personal data or disclose customer lists to artists for their own marketing.",
      "Core application storage is in AWS Stockholm, Sweden. Global site delivery and providers’ support, subprocessors or legal obligations may involve processing in other countries, including the United States. European storage alone does not exclude international transfers. Where required we use applicable adequacy decisions or contractual safeguards, including standard contractual clauses and Swiss adaptations, with supplementary measures as needed. Contact us for provider and safeguard information or a copy of relevant safeguards, subject to legitimate redactions.",
    ],
  },
  {
    title: "The public register and permanent history",
    paragraphs: [
      "The public register shows the piece, certificate and registration history and, only if chosen, the current owner’s public name. It does not publish contact or delivery details, card data or private review evidence. Choosing anonymity in public does not prevent Hewge from associating your verified account with your purchase or current registered ownership.",
      "The provenance and security ledger is designed to persist without automatic expiry. It records event dates, object references, cryptographic integrity proofs and pseudonymous participant references. Contact details and review documents are held separately. Its archive currently uses 100-year compliance retention and indefinite legal holds, so locked entries cannot be edited or routinely deleted; corrections are appended.",
      "Pseudonymous references and hashes may still be personal data when linkable to a person. We do not treat a hash as anonymous or claim a general exception from erasure. We review the necessity and lawful basis of retained links and evidence, restrict disputed records and delete separable personal information when no lawful need remains. An immutable design does not itself provide a lawful basis to retain personal data forever. The long-term retention assessment must be completed before real bidding and ownership transactions are enabled.",
    ],
  },
  {
    title: "Retention and browser storage",
    paragraphs: [
      "Unconfirmed membership requests and verification links expire after 48 hours; verified membership records expire after 180 days. Preference sessions expire after one hour. Account profiles remain while needed for an active account. Essential sign-in information is held in this tab’s session storage until sign-out or expiry; administrative sessions last 15 minutes. There are no advertising trackers. Service and security logs normally expire after seven days; protected audit events are handled separately as described above.",
      "SMS preferences are shared across your membership and collector account and expire after 180 days without renewal. Phone verification expires after 180 days. Text verification codes expire after ten minutes, with no more than five attempts; temporary verification records are then eligible for automatic deletion. We retain a phone-number hash and opt-out time to respect withdrawn SMS consent after contact records expire. Saving a delivery phone number does not subscribe it to release texts.",
      "Necessary accounting records are retained for the applicable statutory period, generally ten years from the end of the relevant financial year under Swiss accounting rules. Active ownership links are retained while required to provide and protect registration; historical identity links, unsuccessful bids, card setup references and private evidence are periodically reviewed for deletion or restriction when contractual, fraud-prevention or claims needs end. A specific dispute or legal hold may require longer retention. The permanent object history does not justify keeping every profile, photograph or address indefinitely.",
      "A minimal address hash and opt-out timestamp are kept to prevent an older subscription from reviving marketing after you leave; that hash is still treated as personal data. Ordinary recovery backups cycle over 35 days. Deleted data may remain in those restricted backups until expiry, and a restore must reapply recorded deletions and opt-outs. Copies deliberately retained in the locked audit archive are subject to the separate limits above.",
    ],
  },
  {
    title: "Your rights and human review",
    paragraphs: [
      "You can request access, a copy, correction, deletion, restriction and, where applicable, portability. You can object to processing based on legitimate interests and always object to direct marketing. We may need proportionate information to verify a request. Where an exception requires retention, we explain the reason and restrict other use rather than silently refusing the whole request. Under the GDPR we normally respond within one month; any permitted extension is explained within that month. Applicable Swiss response requirements also apply.",
      "Change preferences and marketing choices in your account or membership settings. You can request profile deletion below; identity-login deletion and requests involving transaction records require reviewed handling. Removing an account does not transfer a garment or automatically erase necessary accounting records. We can arrange an alternative way to maintain a justified ownership claim without retaining optional profile details.",
      "The auction automatically ranks valid bids by amount and recorded acceptance time under the disclosed rules. Payment providers may apply fraud checks. Hewge reviews transfers, disputed authenticity, recovery and adverse eligibility decisions. Contact us to challenge an error, explain your position or request human review; we do not use social popularity to determine ownership.",
      "You may complain to the Swiss Federal Data Protection and Information Commissioner (FDPIC), or, where the GDPR applies, the supervisory authority in your habitual residence, workplace or place of the alleged infringement. UK residents may contact the Information Commissioner’s Office. You do not have to contact us first. Material policy changes will be identified with a new version; consent will be requested separately when legally required.",
    ],
  },
];

export function legalText(version: string, sections: LegalSection[]) {
  return `HEWGE — ${version}\n${sellerContactText}\n\n${sections.map((s) => `${s.title}\n${s.paragraphs.join("\n\n")}`).join("\n\n")}\n`;
}
export const termsText = legalText(TERMS_VERSION, termsSections);
export const privacyText = legalText(PRIVACY_VERSION, privacySections);

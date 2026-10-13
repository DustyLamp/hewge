# HEWGE

Live: **https://hewge.design** · Source: **https://github.com/DustyLamp/hewge**

One original garment. One owner. Artist-led releases, each with a journal page, an auction, and a place in the archive. Brand colour `#00FEEF`; sparse copy and prominent artwork. Every size is a distinct one-of-one garment, never stock variants of an identical shirt.

The first public design study is **After Hours / The Toucan Edition**, with a proposed opening bid of **CHF 339**. The editorial name/story are draft creative copy. Final artist, material, size and garment photography are still required. There is **no fixed release schedule**: the owner chooses each reveal/opening and closing, with one auction open at a time. Free bidding; highest valid bid wins. No lottery, paid entries, follower weighting or buyer's premium.

## Run, verify and deploy

```sh
npm ci --registry=https://registry.npmjs.org
npm run dev
npm test
npm run build
AWS_PROFILE=hewge npm run synth
AWS_PROFILE=hewge npm run deploy:infra
AWS_PROFILE=hewge node scripts/smoke.mjs
AWS_PROFILE=hewge node scripts/smoke-auth.mjs
AWS_PROFILE=hewge node scripts/smoke-ownership.mjs
AWS_PROFILE=hewge npx tsx scripts/smoke-audit.ts
AWS_PROFILE=hewge npm run deploy
```

Use Node 22. Deployment is restricted to AWS account `082229154968`, region `eu-north-1`, profile `hewge`. Credentials stay in the normal AWS credential provider, never the repository. The GitHub workflow runs tests/builds and stores the bundle; it does not deploy. The organisation SCP prohibits creating GitHub OIDC providers and remains intact. Deploy using the existing profile.

`npm run deploy` builds locally and manually publishes to Amplify. The job ID is retained in ignored `output/latest-deployment.json`; if it times out, resume/check that job before creating another. ZIPs, build output, secrets, customer data and runtime records are ignored and must never be committed.

## What is live-ready

- Landing page, email-only **Join Hewge**, editorial piece pages, archive and social sharing. Full stops use `#00FEED`; story and front-page titles share bold/italic typography. Decorative section numbering is removed; actual piece and edition numbers remain.
- Double opt-in membership: single-use email link, explicit confirmation, then optional sizes, country/city, bidding interest, name, Instagram and interests. Browser language/time zone are hints, never treated as location. SMS preferences have separate consent; SMS delivery and phone verification are not active.
- Verified-email collector accounts; size/country preferences and optional Instagram, self-reported followers, phone and biography. Social details inform the studio, never the auction outcome.
- Private studio at `/dashboard`: audience/size demand, release drafts and individually planned Swiss dates, private production/artist/other costs, reveal settings, private image uploads, segmented communications drafts/schedules, fulfilment, transfer/refund review, identifier recovery, secure-tag commissioning and verified audit exports.
- Openings/closings chosen individually in Swiss time. The server enforces bid amounts, eligibility, consent, closing time and concurrent bids. The draft defaults are CHF 10 increments and a 48-hour payment window; review before launch.
- Artist and material reveal together now, at opening, after close, or manually. Design teasers can withhold name, story and main image before opening. Unpublished drafts are excluded from the public API.
- Paid owners default to `anonymous bidder` and may choose a public name. Artist-signed certificate and congratulations-card print templates are available for paid pieces.
- Ownership requests, recipient acceptance, manual Hewge evidence review, atomic approval and privacy-preserving public provenance at `/registry/<piece-id>`.

Register and verify the supplied owner email at `/account`, then visit `/dashboard` and enrol an authenticator. Studio access requires a server-verified authenticator challenge and a 15-minute token-bound session. Additional administrators must be granted the Cognito `admins` group by an authorised operator; users cannot grant it to themselves. No owner password or account is created in Git. Cognito currently uses its default verification-email service with a small daily quota; configure SES-backed Cognito email before a larger campaign.

The application accepts membership requests; unverified addresses are excluded from size-demand totals and release mailings. Verification mail waits for SES production access and sends only while its 48-hour link is valid. The form reports pending delivery honestly. **Payments, bidding and release/winner emails are disabled**. Do not present draft terms or mocked tests as legal approval or a completed payment launch.

## Architecture and running costs

Static React/Vite on Amplify; HTTP API Gateway; ARM Node 22 Lambda; DynamoDB on demand; Cognito identity; SES email. A minute-by-minute EventBridge worker settles auctions and drains the email outbox when enabled. No server, VPC, NAT gateway, Shopify subscription or advertising trackers. All three tables have 35-day point-in-time recovery, daily protected backups and deletion protection. Private media is encrypted and versioned; provenance is separately archived under compliance retention and indefinite legal hold. Logs retain seven days; customer emails and tokens are not deliberately logged.

Tables: `hewge-production` stores expiring subscriptions; `hewge-auctions` stores profiles, releases, bids, transfers, provenance and operational records. `hewge-audit` is a separate non-expiring transactional ledger. `services/platform.ts` is the API/worker entry; `services/membership.ts` handles email verification and limited preference sessions; `services/ownership.ts` handles the transfer lifecycle; `shared/auction.ts` owns public redaction and auction calculations. The old direct-purchase reservation service has been removed.

At published rates checked 13 October 2026, [Stripe Switzerland](https://stripe.com/en-ch/pricing) domestic cards cost **2.9% + CHF 0.30** (CHF 10.13 on CHF 339); [TWINT through Stripe](https://stripe.com/en-ch/pricing/local-payment-methods) costs **1.9% + CHF 0.30** (CHF 6.74), subject to activation. International cards, currency conversion and optional services can cost more. No Shopify fee is needed.

[Amplify hosting](https://aws.amazon.com/amplify/pricing/) lists USD 0.15/GB served and USD 0.023/GB-month stored outside applicable free allowances. Local builds avoid Amplify build minutes. At 1,000 visits loading 2 MB each, bandwidth is roughly USD 0.30; 10,000 such visits roughly USD 3. Other images, API/database use, backups, authentication, email, the alarm and Route 53 add charges. Expect low costs at launch, not guaranteed free hosting or a cost cap. Domain renewal is separate. No email budget alert has been configured.

## Launch gates

1. The owner confirmed **Lewis (Einzelfirma)**, Unterdorfstrasse 2, **8165 Schöfflisdorf, Switzerland**, with **jez@hewge.design** as the public customer-service contact on 13 October 2026. The seller name, address and email are shared by the terms/privacy disclosures and outbound email contact footer in `shared/seller.ts`; the legal-form descriptor is kept out of customer-facing copy. Still required: final tax, duties, shipping/returns/defects terms and the actual artist, rights/provenance, material composition, size, measurements and final garment photos.
2. Review the auction contract with Swiss counsel, including cross-border consumer obligations, formation of the sale, bid validity, unpaid winners, notices/grace periods, next-bidder offers and mandatory product disclosures. Mystery marketing cannot override required material/label disclosures. Publish final `/terms` and `/privacy` content and replace `TERMS_VERSION` in `shared/auction.ts`.
3. Onboard a Swiss Stripe account with cards/TWINT as appropriate. Store `{ "secretKey": "…", "webhookSecret": "…" }` only in AWS Secrets Manager in the authorised region. Register the stack's `WebhookUrl` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. No secrets belong in frontend configuration.
4. Complete real Stripe sandbox tests, including competing bids, winner checkout, asynchronous payment, session expiry, duplicate/stale webhooks, ambiguous creation and next-bidder handover. Mocked unit tests do not replace this. Establish refund/dispute and stolen-object handling; those are operator procedures, not automated by this version.
5. Obtain SES production access before verification mail can reach public addresses. Domain identity/DKIM are verified; the `hewge-delivery` configuration set suppresses hard bounces/complaints and publishes delivery, bounce, complaint and rejection metrics to CloudWatch. Monitor SES reputation and failed outbox records; production access is an external approval. A production-access request was submitted on 13 October 2026 and was declined by AWS; check `aws sesv2 get-account --region eu-north-1` for the current status. Review seller/controller disclosures before sending campaigns. Upgrade Cognito email for the expected signup volume.
6. Activate only after the preceding steps: `AWS_PROFILE=hewge npm run deploy:infra -- -c stripeSecretArn=<ARN> -c checkoutEnabled=true -c emailEnabled=true -c sellerTermsApproved=true -c termsUrl=https://hewge.design/terms`. Retain these non-secret deployment choices locally on later deploys; omitted flags default to disabled. Do not store credentials as CDK context.
7. Configure the release in the studio, explicitly review shipping charges and insurable country allowlist, then schedule actual opening/closing dates. Country codes are not an automatic sanctions check. Future releases can be spaced however the studio chooses.

See `docs/launch-readiness.txt` for legal sources and operational details, and `docs/messaging-activation.txt` for the prepared SES follow-up and remaining SMS activation steps. The UI's draft terms must be replaced before enabling bids; a deployment flag is an operator assertion, not a legal review.

## Payment and delivery integrity

Bids and updates to the auction head are written in one conditional DynamoDB transaction. At closing, the highest accepted bidder receives a time-limited offer. Only that bidder can pay its server-calculated CHF amount plus the stated shipping charge. A signed, validated Stripe paid event creates anonymous ownership and a certificate ID. Browser redirects do not prove payment. Dispatch requires a signed certificate, ownership card, seal ID, insurance and tracking.

If checkout creation is ambiguous, the offer stays locked. Reconcile its `offerId`, `checkoutAttempt`, `checkoutStartedAt` and Stripe idempotency key before retrying/reassigning. Never blindly clear a lock or mark a paid piece available. A new bidder is selected only after the deadline, operator confirmation under the final terms, and resolution/expiry of any prior Stripe session. They receive an offer at their own highest bid. Delayed payment success blocks reassignment until resolved.

The outbox claims each message before sending. Failed or ambiguous sends require inspection rather than automatic duplicate delivery. Release notifications respect consent and size interest; the latest verified membership or collector-account consent wins, including opt-outs. Legacy/unverified guest-list entries never receive release mailings. Non-expiring address-hash suppression records preserve opt-outs after contact expiry, and consent is rechecked immediately before delivery. Release email TTL is 30 days. Pending membership requests and verification links expire after 48 hours; confirmed membership records expire after 180 days and expired entries are excluded from the dashboard and campaigns. Preference access uses a separate one-hour opaque session, not bidding/admin credentials. `/membership` provides fresh access links; `/privacy` requests an unsubscribe-only confirmation link. Entering someone else’s email cannot overwrite their preferences or remove their subscription. Each address is limited to four verification requests/hour and each IP to twelve; only hashes of tokens and rate-limit identifiers are stored as lookup keys. Links use URL fragments, cleared on arrival, and are consumed only by explicit confirmation. Transactional outbox text is removed after delivery; all membership outbox records expire after 48 hours. Ownership/security provenance has no expiry under the owner’s permanent-history policy. Contact data is stored separately. See `docs/permanent-provenance.txt`.

## Ownership and physical authentication

A dispatched paid owner's request names the recipient's email. The recipient signs in with that verified email, accepts within seven days and confirms possession with matching garment seal and certificate numbers. No invitation email is sent in this flow; the owner shares the account link. Both participants can cancel before fee payment; a paid fee must first be refunded through review. The recipient pays 0.5% of the resale price (gifts use the last verified sale value), with payment-provider costs separate. The intended recipient accepts the quote before inspection and payment. Hewge must separately inspect the original/certificate and entitlement evidence, record its private review reference, collect the recipient’s confirmed fee payment, and approve. Fee-only Stripe checkout and refund reconciliation remain gated until Stripe onboarding, final terms and real sandbox testing are complete; no resale funds are held. The owner change, transfer result and provenance event commit together. Approval defaults to the recipient's chosen anonymous setting. Former owners lose editing access. Expired requests can be cancelled and recreated; records have no automatic deletion TTL.

The public register shows the current opted-in name or `anonymous bidder`, original registration and approved transfer dates. It excludes private emails, account identifiers and evidence. A registry entry is a Hewge record, not a government title registry, copyright transfer, escrow service or automatic proof of possession. Legal title disputes require review outside this workflow.

`docs/authentication.txt` describes the recommended secure NFC tag, numbered hologram and artist-signed certificate, with primary sources. **NFC verification is implemented but disabled pending real hardware commissioning**. The key-registration CLI stores per-tag keys encrypted with KMS; the studio commissions tags and handles reviewed replacements. Hardware programming, secure key custody, garment attachment and physical wash/read tests are still required. Printed QR/serial numbers are copyable. Do not sell a garment as NFC-authenticated until that integration is complete.

## Mystery, artwork and source assets

The API redacts unrevealed artist/material fields. Teaser pages omit the design spread. Nevertheless, `public/images`, client bundles and committed files are public publication surfaces: a reveal setting cannot retract artwork already published. Keep genuinely secret future designs out of the public bundle/repository; use the studio’s private media library for future artwork. Public image access checks the current published release and reveal time; inspection evidence stays private. The provided After Hours design has already been shown publicly. The homepage currently showcases that first design study.

Original supplied assets and image provenance live in `assets/`; optimised WebP presentation assets are in `public/images/`. The transparent shirt cutout was derived with imagegen; it is a presentation mockup, not final photography. Fonts are self-hosted Ultra (Apache 2.0) and Archivo Black (SIL OFL), with licenses in `public/fonts/`. These licenses do not cover the Hewge artwork. Instagram launch drafts are in `docs/instagram-launch.txt`; no social posts have been published by the implementation.

## Domain and verification

Both `hewge.design` and `www.hewge.design` use Amplify application `dc6vls283p578`, branch `main`, in stack `hewge-production`. Keep `customDomain=true` in `cdk.json`. The existing Route 53 zone is retained. CDK explicitly preserves the known apex CloudFront alias after an earlier rollback removed it; if replacing the Amplify app, update that target and verify both DNS/HTTPS routes.

Unit tests cover auction timing, Swiss DST, reveals, atomic bids/payment offers, access control, membership link/session expiry and replay, latest-consent selection and ownership transitions. Live smoke scripts use disposable `example.invalid` identities and remove their records; verification emails are suppressed. The transfer smoke test does not charge money or publish a sale. Production builds typecheck frontend, backend, tests and CDK. Browser QA covers the public desktop/mobile experience. Payment sandbox and physical NFC QA remain launch prerequisites.


## Permanent trail, recovery and activation

See [permanent-provenance.txt](docs/permanent-provenance.txt) for the precise audit guarantees, operational limits, backup/restore procedure, MFA recovery, fee/refund workflow and custody recommendation. Audit events have no TTL. Protected S3 versions have renewable 100-year compliance retention plus an indefinite legal hold; “forever” also requires ongoing custody, funding, retention renewal and independent exports. A hash chain or blockchain does not replace physical authentication. There is one Stockholm write authority with AWS Availability Zone resilience; regional outages pause ownership changes. A second regional deployment or automatic regional failover is not configured.

After physical commissioning, `-c nfcCommissioned=true` enables the public NFC verifier. After payment launch prerequisites and real fee/refund sandbox testing, `-c transferPaymentsApproved=true` enables fee checkout alongside `checkoutEnabled=true`. Neither is enabled by default. Also register Stripe `refund.created` and `refund.updated` webhooks. A processor minimum never silently changes the 0.5% fee. Admin refunds block ownership approval before contacting Stripe. Read the runbook before reconciling uncertain sessions or refunds.

Smoke tests use disposable identities and synthetic ownership/fee fixtures, never real charges. Operational QA records are removed; pseudonymous synthetic audit events remain permanently protected by design. Unit tests and live synthetic tests are not substitutes for a Stripe sandbox certification, an independent security audit, physical garment testing or legal approval.

# HEWGE

Live: **https://hewge.design** · Repository: **https://github.com/DustyLamp/hewge**

An art-led React storefront for one-of-a-kind, artist-signed silk shirts. Brand colour: `#00FEEF`. First piece: **After Hours / The Toucan Edition — CHF 339**. The editorial piece name is proposed copy; change it in `shared/catalog.ts` and the presentation in `src/main.tsx`.

## Run and ship

```sh
npm ci --registry=https://registry.npmjs.org
npm run dev
npm test
AWS_PROFILE=hewge node scripts/smoke.mjs
npm run build
AWS_PROFILE=hewge npm run synth
AWS_PROFILE=hewge npm run deploy:infra
AWS_PROFILE=hewge npm run deploy
```

Use Node 22 for CI and deployment (Node 20.19+ also builds locally). The AWS profile is in the normal shared AWS credentials/config files; never add keys to this repository. The GitHub remote uses HTTPS with the installed `gh` credential helper.

Hosting is **AWS Amplify**, account `082229154968`, region `eu-north-1`. CDK manages the static application, production branch, HTTPS API Gateway HTTP API, ARM Lambda, DynamoDB on-demand table, seven-day function logs, and an error alarm. No VPC, NAT gateway, always-on machine, paid storefront subscription, or tracking scripts. CloudFormation protects and retains the table on deletion. Only the app bundle goes to Amplify; original print artwork stays in Git.

`npm run deploy` builds locally, then uploads a fresh ZIP through Amplify's manual deployment API. It writes public API configuration into the bundle and records the job ID in ignored `output/latest-deployment.json`. If publishing times out, inspect that existing job before starting another. The GitHub workflow verifies tests and production builds but does **not** auto-deploy: the AWS organisation SCP explicitly denies creating OIDC providers. It was left intact. Deployment uses the existing, authorised `hewge` profile.

## First launch

The public site is deliberately in **coming-soon mode**, with real guest-list storage. No Stripe account existed at build time, so it cannot yet take payments. Prices and the single-piece story are visible. The original approved design mockup remains available in the product gallery; the transparent front cutout is a presentation asset derived with imagegen. Final product photography, size, measurements, and artist credit are still to be supplied.

The frontend uses semantic HTML, native modal dialogs, keyboard access, mobile layouts, reduced-motion support, and a motion pause button. Assets and fonts are self-hosted. Source files and image provenance are in `assets/`.

## Guest list and privacy

`POST /waitlist` saves a normalised email, consent version/date, and a 180-day expiry. Keys contain a SHA-256 digest, not a raw email. `POST /waitlist/remove` deletes the entry without disclosing whether it existed. Raw email data is only in DynamoDB; it is not logged. A honeypot, API throttling, allowed-origin checks, and a per-hour IP hash rate limit deter basic abuse. The public privacy dialog explains retention and removal. DynamoDB TTL deletion is asynchronous, so expired records may remain briefly until AWS purges them; any future export must filter `expiresAt > now`.

No mail is sent automatically. To notify people later, use a consent-respecting mail service and include an unsubscribe link. A business contact and full controller identity should be added before any mail campaign. The origin allowlist initially includes `https://hewge.design` and `https://www.hewge.design`; the default Amplify hostname is a visual fallback, not a signup origin.

## Enable sales when ready

1. Open/verify a Swiss Stripe account and add the payout bank account. This requires the owner’s business/identity details. Activate card payments, TWINT (subject to approval), and receipts in Stripe. No Shopify subscription is needed.
2. Supply the first shirt’s actual size/measurements and artist credit. Confirm seller name/address/contact, delivery destinations, shipping cost/time, tax treatment, and returns terms. Publish these details and a real `/terms` page before enabling checkout. The checkout implementation starts with Switzerland-only delivery and no additional shipping fee; review those defaults against the agreed offer.
3. Store one JSON secret in AWS Secrets Manager in `eu-north-1`, with `secretKey` and `webhookSecret`. Use the console or a secure local stdin workflow, never Git or browser configuration. The frontend does not use payment secrets.
4. Register the stack’s `WebhookUrl` in Stripe for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.expired`; put its signing secret in the same AWS secret. Test the exact deployed endpoint in Stripe test mode.
5. Seed exactly one table item: `pk: PIECE#toucan-001`, `status: available`, `size: <actual size>`. Do not use a database TTL on stock. Do not create additional size variants unless they are truly different one-of-one pieces.
6. Run test-mode end-to-end purchases, abandoned-session expiry, and competing checkout attempts. Unit tests cover those state transitions with mocked AWS/Stripe; they do not replace real Stripe sandbox tests.
7. Deploy infrastructure with `-c stripeSecretArn=<complete ARN> -c checkoutEnabled=true -c termsUrl=https://hewge.design/terms` after the previous steps, and switch to live Stripe credentials only after sandbox verification. Keep these context values in an untracked local context/config, not secrets in source. Leave checkout disabled if any launch data is missing.

The price is owned by the server (`shared/catalog.ts`, 33,900 CHF centimes). Checkout first atomically changes `available → reserved`; only the winner receives a Stripe session. One piece per checkout. A verified paid webhook changes `reserved → sold`. Signed expiry releases only the matching reservation. Duplicate and stale events cannot release a newer reservation or sell a sold piece. Inventory never unlocks just because a local timer has elapsed.

**Ambiguous Stripe failures:** the reservation remains locked to prevent overselling. Inspect the inventory row and Stripe logs for its `reservation` (also the Stripe idempotency key and client reference). Retrieve or replay the same session creation with the identical idempotency key/parameters within Stripe’s idempotency window; expire any unpaid session through Stripe and allow the signed expiry webhook to release it. If there is any chance payment completed, reconcile payment status first. Never blindly set an old reservation back to `available`. Stripe sessions expire after 31 minutes; keep webhook delivery working. Orders, delivery address, and receipts are managed in the Stripe dashboard.

## Costs (checked 13 October 2026)

No Shopify fee. [Stripe Switzerland](https://stripe.com/en-ch/pricing) lists domestic cards at **2.9% + CHF 0.30**, approximately **CHF 10.13** per CHF 339 sale; international cards and currency conversion can cost more. Checkout is included with standard Payments. [TWINT via Stripe](https://stripe.com/en-ch/pricing/local-payment-methods) is **1.9% + CHF 0.30**, approximately **CHF 6.74** on CHF 339, once approved/enabled. The integration permits cards and TWINT and filters out other methods. Optional Stripe services may add fees.

[Amplify published usage rates](https://aws.amazon.com/amplify/pricing/) include **USD 0.15/GB served** and **USD 0.023/GB-month stored** outside applicable free allowances. Builds run locally, so there are no Amplify build minutes for this deployment workflow. At 1,000 visits loading 2 MB each, bandwidth is about **USD 0.30**; at 10,000 such visits, about **USD 3**, before other usage/free allowances. Actual traffic and image exploration matter. Lambda, HTTP API, DynamoDB, the error alarm, and the existing Route 53 zone add small usage/fixed charges; domain registration and Stripe processing are separate. A low-traffic launch should be in the low single-digit USD/month range, not a guaranteed free service or a cost cap. No budget notification email is configured because no recipient was supplied.

## Custom domain

`hewge.design` uses existing Route 53 zone `Z08500773SUN2ORMGDEA4`. After the initial site is published, deploy with `-c customDomain=true` to add apex and `www` Amplify domain associations. Keep the flag enabled on future deploys. Amplify automatically created the certificate-validation and routing records in the existing Route 53 zone. CDK retains the domain association; Amplify owns its DNS records. Both apex and www are connected. Confirm DNS and HTTPS after future domain changes.

## Verification

`npm test` runs the commerce integration tests (mocked SDKs), including consent, removal, abuse limits, price tampering, reservation contention, ambiguous Stripe errors, signature checks, duplicate paid events, and stale expiry events. `npm run build` typechecks all application/backend/CDK/test code and builds the static app. The initial release is also checked visually in Chrome at desktop and mobile sizes, with live API and guest-list smoke tests after deployment.

Fonts: Ultra (Apache 2.0), Archivo Black (SIL OFL), license files in `public/fonts/`. Artwork: supplied for Hewge; font licenses do not license the shirt artwork. Do not reuse the artwork outside Hewge without the owner’s permission.

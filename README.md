# HEWGE

Live: **https://hewge.design** · Source: **https://github.com/DustyLamp/hewge**

Very few original works, made to be worn, with their creators, stories and continuing history. Start with the [concept and administrator playbook](docs/administrator-playbook.md) and the [eight participant journeys](docs/journey-playbook.md).

**Activation:** consult [launch readiness](docs/launch-readiness.txt) before offering a flow or enabling a service. It distinguishes implemented capabilities from intended experiences; [messaging activation](docs/messaging-activation.txt) owns the current provider and application status.

## Documentation map

Each topic has one owning document. Other guides link to its rules and procedures; journey stages retain the context and emotion needed by each participant. Update the owning guide when a decision changes, then check its references and role-specific instructions for consistency.

| Document | Responsibility |
| --- | --- |
| [Concept and administrators](docs/administrator-playbook.md) | Shared principles, social proof/Influence, release decisions and reveal record. |
| [Participant journeys](docs/journey-playbook.md) | Eight roles, 53 stages with context and emotion, introduction video and unresolved handovers. |
| [Creative commissioning](docs/creative-commissioning.txt) | Collaborator brief/curation, physical specification, development, interviews, rights and commission economics. |
| [Launch experience](docs/launch-playbook.txt) | Audience discovery, gifting/early wearers, packaging through first wear, editorial milestones and learning. |
| [Annual book](docs/annual-book.md) | Creative content and exclusions, print rights, production/purchase decisions and book participant handovers. |
| [Launch readiness](docs/launch-readiness.txt) | Capability inventory, unbuilt flows, owner setup and activation checklist/flags. |
| [Legal and card review](docs/legal-and-card-launch.txt) | Seller disclosures, auction contract, card/payment recovery, withdrawal, privacy and required real sandbox cases. |
| [Permanent provenance](docs/permanent-provenance.txt) | Transfers, fees/refunds, permanent ledger, custody, backups and account/incident recovery. |
| [Physical authentication](docs/authentication.txt) | Certificate/tag specification, suppliers, cryptographic provisioning, commissioning and replacement. |
| [CMS and architecture](docs/cms-and-auction-architecture.txt) | Stack/data ownership, publication, reveal/media boundaries, content initialisation and cost inputs. |
| [Live bidding](docs/live-bidding.txt) | Atomic bids/receipts, transport, timing, concurrency, failures and private rehearsal. |
| [Messaging](docs/messaging-activation.txt) | Membership/consent lifecycle, email/SMS limits, current status and delivery activation. |
| [Brand identity](docs/branding/concept-brief.txt) | Lettering, colours, voice, icons, generation and font licences. |
| [Instagram launch](docs/instagram-launch.txt) | Optional post copy, visuals and channel-specific publication guidance. |
| [Image provenance](assets/PROVENANCE.md) | Supplied images, generated presentation assets and their limits. |
| [Agent instructions](AGENTS.md) | Repository guardrails and working constraints. |

This README owns local setup, verification and deployment. Accepted legal versions in `public/legal`, font licences and source/image provenance are retained records with their own purpose; they are not interchangeable drafts of the working guides.

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

## Domain and verification

Both `hewge.design` and `www.hewge.design` use Amplify application `dc6vls283p578`, branch `main`, in stack `hewge-production`. Keep `customDomain=true` in `cdk.json`. Retain the Route 53 zone and the CDK-managed apex CloudFront alias. If replacing the Amplify app, update that target and verify both DNS/HTTPS routes.

Unit tests cover auction timing, Swiss DST, reveals, atomic bids/payment offers, access control, membership link/session expiry and replay, latest-consent selection and ownership transitions. Live smoke scripts use disposable `example.invalid` identities and remove their records; verification emails are suppressed. The transfer smoke test does not charge money or publish a sale. Production builds typecheck frontend, backend, tests and CDK. Browser QA covers the public desktop/mobile experience. Payment sandbox and physical NFC QA remain launch prerequisites.

Smoke fixtures never make real charges. Operational QA records are removed; pseudonymous synthetic audit events remain permanently protected. Unit tests and live synthetic tests do not substitute for real Stripe sandbox validation, independent security review, physical garment testing or legal approval.

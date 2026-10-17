# Hewge

Brand colour: `#00FEEF`. Keep customer-facing copy sparse and imagery prominent. Every saleable garment is one of one, including each size. Never introduce a quantity selector or generic size stock that implies duplicated pieces.

Use the Ultra HEWGE wordmark. Small brand icons use the H outlined from Ultra, matching the homepage's vertical proportion. See docs/branding/concept-brief.txt.

Sentence full stops use solid `#00FEED`, with no muted tint. Reuse the front page’s bold/italic title treatment on story pages. Membership starts with email verification and progressively asks for preferences; no discounts or retail promotion language.

Voice: understated and specific. Let the work, withheld details and real dates suggest what comes next. Never narrate the marketing strategy, announce suspense or hype, promise a story is worth waiting for, or tell the reader how to feel. Keep auction obligations and reveal timing explicit.

Strategy conversations are exploratory: the founder supplies context and illustrative possibilities, not a requirement for every example. Use creative judgment, distinguish agreed principles from proposals, and do not turn examples of location, age, gender, occupation or selection mechanisms into a fixed audience or implementation task. No launch demographic or geographic audience has been chosen. See docs/creative-commissioning.txt.

Documentation states the current concept and operating instructions directly. Correct affected passages together; remove superseded content, obsolete references and change-history commentary. Distinguish intended experience, available capabilities and unresolved decisions. The shared concept and administrator decisions are in docs/administrator-playbook.md.

Social proof means the standing Hewge earns in society and particularly its intended audience, including validation by influential and consequential people whose judgment matters there. It includes genuine wear, recommendations, gifts, loans and cultural recognition, not only paid owners or bids. Relationships never change the highest-valid-bid rules.

Administrators design the mystery and reveal sequence separately for every release, including possible later artist reveals. Document it before publication; current disclosure/checkout gates remain in force until the relevant reviewed terms and implementation support that plan.

An annual purchasable coffee-table book covers the year's pieces and how they came to be, with deeper material than the website and exceptional physical presentation. Its annual rhythm does not set garment release dates. Complimentary custodian copies, potentially signed by one or several artists, are future possibilities, not entitlements. Book editions do not inherit garment one-of-one or auction rules.

Book content is the cleared creative story of the pieces and their makers, not the internal journey maps. Exclude administrator/business operations, influence and mystery strategy, collaborator evaluation/negotiations, private customer and transaction journeys, and account/payment/transfer/authentication procedures. Keep book-approved material separate from private commission records.

Deploy only to AWS account `082229154968`, region `eu-north-1`, using the `hewge` profile. Keep AWS organisation controls intact. Never commit secrets, customer emails, generated build archives, or runtime data.

Checkout stays disabled until the owner’s Stripe account, real product sizing/artist data, seller details, and shipping/returns/tax terms are ready. See README for the launch steps and payment-offer rules.

# User printing preference

Never enable brims on prints unless Jez explicitly requests them. Use `brim_type: no_brim`, `brim_width: 0`, and zero prime-tower brim width where applicable.

Garment releases have individually chosen dates, never an assumed recurring weekday. Keep unrevealed artist/material fields out of public API responses. Paid ownership transfers require verified recipient acceptance and Hewge review; a printed code alone is not proof of authenticity.

Ownership/security provenance must not expire. Preserve the non-TTL ledger and protected archives; corrections append events. Ownership transfer fees are 0.5%, paid by the recipient, on resale value (gifts use the last verified sale value). Do not treat printed identifiers or blockchain tokens as sufficient physical or legal ownership proof.

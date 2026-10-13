# Hewge

Brand colour: `#00FEEF`. Keep customer-facing copy sparse and imagery prominent. Every saleable garment is one of one, including each size. Never introduce a quantity selector or generic size stock that implies duplicated pieces.

Deploy only to AWS account `082229154968`, region `eu-north-1`, using the `hewge` profile. Keep AWS organisation controls intact. Never commit secrets, customer emails, generated build archives, or runtime data.

Checkout stays disabled until the owner’s Stripe account, real product sizing/artist data, seller details, and shipping/returns/tax terms are ready. See README for the launch steps and payment-offer rules.

# User printing preference

Jez explicitly prohibits brims on prints (2026-09-26). Never enable or reintroduce brims unless Jez explicitly reverses that instruction. Use `brim_type: no_brim`, `brim_width: 0`, and zero prime-tower brim width where applicable.

Releases have individually chosen dates, never an assumed recurring weekday. Keep unrevealed artist/material fields out of public API responses. Paid ownership transfers require verified recipient acceptance and Hewge review; a printed code alone is not proof of authenticity.

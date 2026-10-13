export const TRANSFER_FEE_BPS = 50;
export const TRANSFER_FEE_POLICY = "recipient-0.5-percent-v1";
export function transferQuote(
  kind: unknown,
  resaleAmount: unknown,
  verifiedValue: number,
) {
  if (!["sale", "gift"].includes(String(kind)))
    throw Object.assign(Error("Choose sale or gift."), { status: 400 });
  const value = kind === "gift" ? verifiedValue : Number(resaleAmount);
  if (!Number.isSafeInteger(value) || value < 100 || value > 100000000)
    throw Object.assign(
      Error(
        "Enter a valid value in CHF. Gifts require an existing verified sale value.",
      ),
      { status: 400 },
    );
  return {
    currency: "CHF",
    basis: kind === "gift" ? "last-verified-sale" : "declared-resale",
    value,
    fee: Math.round((value * TRANSFER_FEE_BPS) / 10000),
    feeBps: TRANSFER_FEE_BPS,
    payer: "recipient",
    policy: TRANSFER_FEE_POLICY,
    paymentProcessingIncluded: false,
  };
}

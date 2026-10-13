// Public business details confirmed by the owner on 13 October 2026.
export const seller = {
  name: "Lewis",
  street: "Unterdorfstrasse 2",
  postalCode: "8165",
  locality: "Schöfflisdorf",
  country: "Switzerland",
  email: "jez@hewge.design",
} as const;

export const sellerContactText = [
  `${seller.name} · HEWGE`,
  seller.street,
  `${seller.postalCode} ${seller.locality}`,
  seller.country,
  seller.email,
].join("\n");

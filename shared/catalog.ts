export const piece = {
  id: "toucan-001",
  name: "After Hours",
  number: "001",
  collection: "The Toucan Edition",
  slug: "after-hours",
  artistId: "toucan-artist",
  price: 33900,
  currency: "chf",
  material: "Material at reveal",
  edition: "1 of 1",
  image: "/images/shirt-front.webp",
  size: null as string | null,
};
export const sizes = ["XS", "S", "M", "L", "XL", "XXL", "3XL"] as const;
export type Catalog = typeof piece & {
  status: "coming-soon";
  size: string | null;
};

import { TERMS_VERSION, PAYMENT_RECOVERY_HOURS } from "./legal";
export { TERMS_VERSION } from "./legal";
export type Release = {
  id: string;
  slug: string;
  name: string;
  number: string;
  image: string;
  story: string;
  artistName: string;
  artistOrigin: string;
  artistPractice: string;
  artistBiography: string;
  artistWorks: string;
  designRevealMode: "now" | "at-opening";
  designHidden?: boolean;
  material: string;
  revealMode: "now" | "at-opening" | "after-close" | "manual";
  identityRevealed: boolean;
  size: string;
  measurements: string;
  status: string;
  opensAt: number | null;
  closesAt: number | null;
  openingBid: number;
  highestBid: number | null;
  bidCount: number;
  minimumIncrement: number;
  paymentHours: number;
  shippingFee: number;
  taxDetails: string;
  deliveryDetails: string;
  countries: string[];
  publicOwner: { name: string | null; anonymous: boolean } | null;
  certificateId?: string;
  soldAt?: number;
  serverNow: number;
  termsVersion: string;
};
export function auctionPhase(
  auction: {
    status: string;
    opensAt?: number | null;
    closesAt?: number | null;
  },
  now = Date.now(),
) {
  if (["sold", "awaiting-payment", "closed"].includes(auction.status))
    return auction.status;
  if (!auction.opensAt || !auction.closesAt) return "unannounced";
  if (now < auction.opensAt) return "scheduled";
  if (now >= auction.closesAt) return "closed";
  return "open";
}
export function minimumBid(
  openingBid: number,
  highestBid: number | null | undefined,
  increment: number,
) {
  return highestBid == null ? openingBid : highestBid + increment;
}
export function validateSchedule(
  opensAt: number,
  closesAt: number,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(opensAt) ||
    !Number.isSafeInteger(closesAt) ||
    opensAt <= now
  )
    throw Error("Choose a future opening time.");
  if (closesAt <= opensAt || closesAt - opensAt > 31 * 86400000)
    throw Error("Closing must follow opening, within 31 days.");
}
export function validateBid(
  amount: unknown,
  auction: {
    openingBid: number;
    highestBid?: number | null;
    minimumIncrement: number;
  },
) {
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount > 100000000 ||
    amount <
      minimumBid(
        auction.openingBid,
        auction.highestBid,
        auction.minimumIncrement,
      )
  )
    throw Error(
      "The bid must meet the current minimum, in CHF to two decimal places.",
    );
  return amount;
}
export function weekLabel(time: number) {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(time);
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const week = Math.ceil(
    ((d.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7,
  );
  return `${year} / WEEK ${String(week).padStart(2, "0")}`;
}
// Convert a wall-clock time in Switzerland, including daylight-saving transitions.
export function swissTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw Error("Choose a Swiss date and time.");
  const guess = Date.parse(value + "Z");
  let result = guess;
  const format = (t: number) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Zurich",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(t)
      .replace(" ", "T");
  for (let i = 0; i < 3; i++)
    result += guess - Date.parse(format(result) + "Z");
  if (format(result) !== value)
    throw Error("That Swiss time does not exist because of daylight saving.");
  // Repeated autumn hour is ambiguous: ask for a different time instead of guessing.
  if (format(result - 3600000) === value || format(result + 3600000) === value)
    throw Error(
      "That Swiss time occurs twice. Choose a time outside the clock change.",
    );
  return result;
}
export function publicRelease(
  item: Record<string, any>,
  now = Date.now(),
): Release {
  const keys = [
    "designRevealMode",
    "material",
    "revealMode",
    "identityRevealed",
    "id",
    "slug",
    "name",
    "number",
    "image",
    "story",
    "artistName",
    "artistOrigin",
    "artistPractice",
    "artistBiography",
    "artistWorks",
    "size",
    "measurements",
    "opensAt",
    "closesAt",
    "openingBid",
    "highestBid",
    "bidCount",
    "minimumIncrement",
    "paymentHours",
    "shippingFee",
    "taxDetails",
    "deliveryDetails",
    "countries",
    "publicOwner",
    "certificateId",
    "soldAt",
    "termsVersion",
  ];
  const visible =
    item.revealMode === "now" ||
    item.identityRevealed === true ||
    (item.revealMode === "at-opening" &&
      !!item.opensAt &&
      now >= item.opensAt) ||
    (item.revealMode === "after-close" &&
      !!item.closesAt &&
      now >= item.closesAt);
  const output = {
    ...Object.fromEntries(keys.map((k) => [k, item[k] ?? null])),
    status: auctionPhase(item as { status: string }, now),
    serverNow: now,
  } as Release;
  if (!visible)
    for (const k of [
      "artistName",
      "artistOrigin",
      "artistPractice",
      "artistBiography",
      "artistWorks",
      "material",
    ] as const)
      output[k] = "";
  output.identityRevealed = Boolean(visible);
  if (
    item.designRevealMode === "at-opening" &&
    (!item.opensAt || now < item.opensAt)
  ) {
    output.designHidden = true;
    output.name = `No. ${item.number}`;
    output.image = "/images/foliage.webp";
    output.story = "";
  }
  return output;
}
export const preview: Release = {
  id: "toucan-001",
  slug: "after-hours",
  name: "After Hours",
  designRevealMode: "now",
  material: "",
  revealMode: "manual",
  identityRevealed: false,
  number: "001",
  image: "/images/shirt-front.webp",
  story:
    "An invitation. A dance floor. The morning after. A whole night unfolds across six illustrated panels: toucans dressed for trouble, hidden among tangled leaves. One story, told all the way around.",
  artistName: "",
  artistOrigin: "",
  artistPractice: "",
  artistBiography: "",
  artistWorks: "",
  size: "",
  measurements: "",
  status: "unannounced",
  opensAt: null,
  closesAt: null,
  openingBid: 33900,
  highestBid: null,
  bidCount: 0,
  minimumIncrement: 1000,
  paymentHours: PAYMENT_RECOVERY_HOURS,
  shippingFee: 0,
  taxDetails: "",
  deliveryDetails: "",
  countries: [],
  publicOwner: null,
  serverNow: Date.now(),
  termsVersion: TERMS_VERSION,
};

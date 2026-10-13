export const homeFields = [
  ["featuredReleaseId", "Featured release ID"],
  ["heroLabel", "Hero status line"],
  ["editionLabel", "Piece section label"],
  ["manifestoTitle", "Statement heading (line breaks allowed)"],
  ["manifestoText", "Statement text"],
  ["manifestoSignature", "Statement signature"],
  ["guestTitle", "Membership heading"],
  ["guestText", "Membership introduction"],
  ["guestImage", "Membership image"],
  ["guestImageAlt", "Membership image description"],
] as const;
export const storyFields = [
  ["title", "Page title"],
  ["intro", "Introduction"],
  ["body", "Page text (blank lines separate paragraphs)"],
  ["image", "Page image"],
  ["imageAlt", "Image description"],
] as const;
export type PageContent = Record<string, string>;
export type ContentPage = {
  id: string;
  revision: number;
  data: PageContent;
  updatedAt: number;
  publishedAt?: number;
};
export type GalleryImage = { image: string; label: string };
export function contentFields(id: string) {
  return id === "home" ? homeFields : storyFields;
}
export function cleanPage(id: string, value: unknown): PageContent {
  if (
    !/^[a-z0-9-]{1,80}$/.test(id) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw Object.assign(Error("Choose a page ID and its content."), {
      status: 400,
    });
  const data = Object.fromEntries(
    contentFields(id).map(([key]) => {
      const text = (value as any)[key];
      if (
        typeof text !== "string" ||
        text.length > (key === "body" ? 8000 : 1200)
      )
        throw Object.assign(Error(`Check ${key}.`), { status: 400 });
      return [key, text.trim()];
    }),
  );
  if (
    id === "home"
      ? !/^[a-z0-9-]{1,80}$/.test(data.featuredReleaseId)
      : !data.title
  )
    throw Object.assign(Error("Add the featured release or page title."), {
      status: 400,
    });
  return data;
}

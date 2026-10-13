import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
  termsText,
  privacyText,
} from "../shared/legal";

await mkdir("public/legal", { recursive: true });
for (const [version, text] of [
  [TERMS_VERSION, termsText],
  [PRIVACY_VERSION, privacyText],
]) {
  const path = `public/legal/${version}.txt`;
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  if (existing !== undefined && existing !== text)
    throw Error(
      `Published ${version} differs: create a new legal version instead of rewriting its snapshot.`,
    );
  if (existing === undefined) await writeFile(path, text, { flag: "wx" });
}

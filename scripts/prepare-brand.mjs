import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

// The path-based SVG is the source of truth. No system fonts are required.
const mark = await readFile(new URL("../public/favicon.svg", import.meta.url));
for (const [name, size] of [
  ["favicon.png", 96],
  ["apple-touch-icon.png", 180],
  ["hewge-icon.png", 512],
]) {
  await sharp(mark, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(new URL(`../public/${name}`, import.meta.url).pathname);
}

// ICO directory with embedded PNG images for browser /favicon.ico fallback.
const sizes = [16, 32, 48];
const images = await Promise.all(
  sizes.map((size) => sharp(mark, { density: 384 }).resize(size, size).png().toBuffer()),
);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [i, size] of sizes.entries()) {
  const entry = 6 + i * 16;
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
await writeFile(new URL("../public/favicon.ico", import.meta.url), Buffer.concat([header, ...images]));
console.log("Prepared Hewge SVG, PNG, ICO and Apple icons.");

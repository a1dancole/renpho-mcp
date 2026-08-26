#!/usr/bin/env node
/**
 * Embed an existing PNG (e.g. the official app icon) as the connector icon:
 * validates it, copies it to assets/icon.png and regenerates src/icon.ts.
 *
 *   npm run icon:embed -- path/to/official-icon.png
 *
 * Square PNGs of 256–1024 px work best. Use `npm run icon` to go back to the
 * generated default.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/embed-icon.mjs <icon.png>");
  process.exit(2);
}

const png = readFileSync(resolve(source));
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!png.subarray(0, 8).equals(SIGNATURE) || png.toString("ascii", 12, 16) !== "IHDR") {
  console.error(`${source} is not a PNG file`);
  process.exit(1);
}
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== height) console.warn(`warning: icon is ${width}x${height}, not square — clients may crop it`);
if (png.length > 400_000) console.warn(`warning: ${png.length} bytes is large for an embedded icon; consider resizing to 512px`);

mkdirSync(join(ROOT, "assets"), { recursive: true });
copyFileSync(resolve(source), join(ROOT, "assets", "icon.png"));

const lines = png.toString("base64").match(/.{1,120}/g).map((l) => `  "${l}"`).join(" +\n");
writeFileSync(
  join(ROOT, "src", "icon.ts"),
  `// Connector icon (PNG, ${width}x${height}) base64-embedded so the Worker can serve it at\n` +
    `// /icon.png. Embedded from ${source.replace(/\\/g, "/")} by scripts/embed-icon.mjs — do not edit by hand.\n` +
    `export const ICON_PNG_SIZE = ${width};\nexport const ICON_PNG_BASE64 =\n${lines};\n`,
);
console.log(`embedded ${source} (${width}x${height}, ${png.length} bytes) into src/icon.ts and assets/icon.png`);

#!/usr/bin/env node
/**
 * Renders the connector icon (a smart scale with a rising bar chart on its
 * display) to assets/icon.png and embeds it as base64 in src/icon.ts. Pure
 * Node — no image libraries — so the icon is reproducible from source.
 *
 *   npm run icon
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 512;
const SS = 3; // supersampling factor for anti-aliasing

// --- tiny vector helpers -----------------------------------------------------

function roundedRect(px, py, x, y, w, h, r) {
  const qx = Math.max(x + r, Math.min(px, x + w - r));
  const qy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - qx;
  const dy = py - qy;
  return dx * dx + dy * dy <= r * r;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Shapes are evaluated in a 0..1 unit square. Painter's order: later wins.
const shapes = [
  // Background: rounded square, vertical gradient (deep blue → sky).
  {
    hit: (x, y) => roundedRect(x, y, 0, 0, 1, 1, 0.22),
    color: (x, y) => [lerp(24, 56, y), lerp(96, 168, y), lerp(214, 248, y)],
  },
  // Scale body (white rounded square with soft shadow beneath).
  {
    hit: (x, y) => roundedRect(x, y + 0.02, 0.2, 0.2, 0.6, 0.6, 0.12),
    color: () => [16, 60, 140],
  },
  {
    hit: (x, y) => roundedRect(x, y, 0.2, 0.2, 0.6, 0.6, 0.12),
    color: () => [250, 251, 254],
  },
  // Display window (dark).
  {
    hit: (x, y) => roundedRect(x, y, 0.29, 0.27, 0.42, 0.2, 0.05),
    color: () => [15, 23, 42],
  },
  // Rising bar chart inside the display (teal → green).
  { hit: (x, y) => roundedRect(x, y, 0.33, 0.395, 0.07, 0.05, 0.012), color: () => [45, 212, 191] },
  { hit: (x, y) => roundedRect(x, y, 0.425, 0.365, 0.07, 0.08, 0.012), color: () => [52, 211, 153] },
  { hit: (x, y) => roundedRect(x, y, 0.52, 0.335, 0.07, 0.11, 0.012), color: () => [74, 222, 128] },
  { hit: (x, y) => roundedRect(x, y, 0.615, 0.30, 0.07, 0.145, 0.012), color: () => [134, 239, 172] },
  // Foot pads (two soft blue rounded rects) below the display.
  { hit: (x, y) => roundedRect(x, y, 0.29, 0.54, 0.18, 0.18, 0.06), color: () => [219, 234, 254] },
  { hit: (x, y) => roundedRect(x, y, 0.53, 0.54, 0.18, 0.18, 0.06), color: () => [219, 234, 254] },
];

// --- rasterise ---------------------------------------------------------------

const rgba = new Uint8Array(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / SIZE;
        const y = (py + (sy + 0.5) / SS) / SIZE;
        let col = null;
        for (const s of shapes) if (s.hit(x, y)) col = s.color(x, y);
        if (col) {
          r += col[0];
          g += col[1];
          b += col[2];
          a += 255;
        }
      }
    }
    const n = SS * SS;
    const i = (py * SIZE + px) * 4;
    const cov = a / n / 255;
    // Un-premultiply so edges keep their colour.
    rgba[i] = cov ? Math.round(r / n / cov) : 0;
    rgba[i + 1] = cov ? Math.round(g / n / cov) : 0;
    rgba[i + 2] = cov ? Math.round(b / n / cov) : 0;
    rgba[i + 3] = Math.round(a / n);
  }
}

// --- PNG encode --------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(rgba.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(join(ROOT, "assets"), { recursive: true });
writeFileSync(join(ROOT, "assets", "icon.png"), png);

const b64 = png.toString("base64");
const lines = b64.match(/.{1,120}/g).map((l) => `  "${l}"`).join(" +\n");
writeFileSync(
  join(ROOT, "src", "icon.ts"),
  `// Connector icon (PNG, ${SIZE}x${SIZE}) base64-embedded so the Worker can serve it at\n` +
    `// /icon.png. Generated by scripts/make-icon.mjs — do not edit by hand.\n` +
    `export const ICON_PNG_SIZE = ${SIZE};\nexport const ICON_PNG_BASE64 =\n${lines};\n`,
);

console.log(`wrote assets/icon.png (${png.length} bytes) and src/icon.ts`);

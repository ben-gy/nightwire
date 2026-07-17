/**
 * gen-icons.mjs — rasterise the Nightwire mark into the PNGs a home-screen
 * install needs. Run with `npm run icons`; the output is committed under public/.
 *
 *   node scripts/gen-icons.mjs
 *
 * Why this exists at all, rather than a one-liner with sharp: the game ships
 * zero runtime dependencies and sharp is a 30MB native binary we would be
 * installing to draw four small squares. So this carries its own rasteriser for
 * the handful of primitives public/favicon.svg actually uses — a rounded rect,
 * round-capped strokes, filled and stroked circles — and its own PNG encoder on
 * top of node's built-in zlib. Nothing here is a general SVG renderer; ART below
 * is the same mark as favicon.svg, expressed as the shapes it is made of, so the
 * icons and the favicon cannot drift apart into two different logos.
 *
 * The four outputs are NOT interchangeable:
 *  - icon-192 / icon-512: the manifest's own icons. Rounded, "any" purpose.
 *  - icon-maskable-512: Android crops adaptive icons to a device-chosen shape
 *    (circle, squircle, teardrop). A non-maskable icon fed to that crop loses its
 *    corners. So this one is full-bleed with the art shrunk into the safe zone —
 *    the centre 80% — and it must NOT be rounded: the platform does the rounding.
 *  - apple-touch-icon: iOS ignores the manifest entirely, and composites any
 *    transparency onto BLACK. Full-bleed, fully opaque, no rounding (iOS masks).
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The palette, straight from src/styles/main.css.
const INK = '#0b0e17';
const TEAL = '#3fd0c9';
const AMBER = '#ffb347';
const VIOLET = '#a882ff';
const TEXT = '#f2f4ff';

/**
 * The Nightwire mark, in the 64x64 space favicon.svg uses: a wire cut in two,
 * the spark at the break, and the ring of seats around it.
 */
const ART = [
  { t: 'line', x1: 6, y1: 32, x2: 26, y2: 32, w: 4, fill: TEAL },
  { t: 'line', x1: 38, y1: 32, x2: 58, y2: 32, w: 4, fill: VIOLET },
  { t: 'ring', cx: 32, cy: 32, r: 10, w: 2, fill: AMBER, alpha: 0.45 },
  { t: 'circle', cx: 32, cy: 32, r: 5, fill: AMBER },
  { t: 'circle', cx: 16, cy: 14, r: 3.5, fill: TEXT, alpha: 0.8 },
  { t: 'circle', cx: 48, cy: 14, r: 3.5, fill: TEXT, alpha: 0.8 },
  { t: 'circle', cx: 16, cy: 50, r: 3.5, fill: TEXT, alpha: 0.8 },
  { t: 'circle', cx: 48, cy: 50, r: 3.5, fill: VIOLET },
];

// ── colour ──────────────────────────────────────────────────────────────────

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── geometry: signed distance, so every edge antialiases the same way ────────

/** Distance from p to the segment ab — a round-capped stroke is just this. */
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Negative inside. A rounded rect is a shrunken rect dilated by its radius. */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdOf(shape, px, py) {
  switch (shape.t) {
    case 'rect':
      return sdRoundRect(px, py, shape.x, shape.y, shape.w, shape.h, shape.r ?? 0);
    case 'circle':
      return Math.hypot(px - shape.cx, py - shape.cy) - shape.r;
    case 'ring':
      return Math.abs(Math.hypot(px - shape.cx, py - shape.cy) - shape.r) - shape.w / 2;
    case 'line':
      return distSeg(px, py, shape.x1, shape.y1, shape.x2, shape.y2) - shape.w / 2;
    default:
      throw new Error(`unknown shape ${shape.t}`);
  }
}

// ── raster ──────────────────────────────────────────────────────────────────

const SS = 4; // 4x4 supersamples per pixel — enough that no edge stairsteps.

/**
 * Render `shapes` (in `space`x`space` user units) to a `size`x`size` RGBA buffer.
 * Shapes composite in order, painter's algorithm, straight (non-premultiplied)
 * alpha — which is what the PNG spec wants anyway.
 */
function render(shapes, size, space) {
  const px = new Uint8Array(size * size * 4);
  const prepared = shapes.map((s) => ({ ...s, rgb: rgb(s.fill), alpha: s.alpha ?? 1 }));
  const scale = space / size;
  const step = 1 / SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) * step) * scale;
          const uy = (y + (sy + 0.5) * step) * scale;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const s of prepared) {
            // Coverage across one device pixel's worth of distance: this is the
            // antialiasing, and it is why everything is an SDF above.
            const cov = Math.max(0, Math.min(1, 0.5 - sdOf(s, ux, uy) / scale));
            if (cov <= 0) continue;
            const sa = cov * s.alpha;
            const na = sa + ca * (1 - sa);
            if (na <= 0) continue;
            cr = (s.rgb[0] * sa + cr * ca * (1 - sa)) / na;
            cg = (s.rgb[1] * sa + cg * ca * (1 - sa)) / na;
            cb = (s.rgb[2] * sa + cb * ca * (1 - sa)) / na;
            ca = na;
          }
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // Un-premultiply the averaged samples back to straight alpha.
      const aa = a / n;
      px[i] = aa > 0 ? Math.round(r / a) : 0;
      px[i + 1] = aa > 0 ? Math.round(g / a) : 0;
      px[i + 2] = aa > 0 ? Math.round(b / a) : 0;
      px[i + 3] = Math.round(aa * 255);
    }
  }
  return px;
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  // 10..12: deflate / adaptive filtering / no interlace — all zero.

  // One filter byte (0 = None) per scanline. Filtering would only buy us bytes
  // on artwork this flat; zlib already gets it to a few KB.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the four icons ──────────────────────────────────────────────────────────

/** Place ART inside a `space`-unit square, scaled by `inset` about the centre. */
function art(space, inset) {
  const k = (space / 64) * inset;
  const off = (space - 64 * k) / 2;
  const m = (v) => v * k + off;
  return ART.map((s) => {
    switch (s.t) {
      case 'line':
        return { ...s, x1: m(s.x1), y1: m(s.y1), x2: m(s.x2), y2: m(s.y2), w: s.w * k };
      case 'ring':
        return { ...s, cx: m(s.cx), cy: m(s.cy), r: s.r * k, w: s.w * k };
      default:
        return { ...s, cx: m(s.cx), cy: m(s.cy), r: s.r * k };
    }
  });
}

/** The manifest's "any" icon: the favicon at size, corners and all. */
const rounded = (space) => [
  { t: 'rect', x: 0, y: 0, w: space, h: space, r: space * (14 / 64), fill: INK },
  ...art(space, 1),
];

/**
 * Full-bleed square. `inset` shrinks the art into a crop's safe zone.
 *
 * The background is overshot past every edge on purpose. Flush against the
 * canvas the outer pixels only get ~50% coverage from the antialiaser, so the
 * icon ends up with a one-pixel semi-transparent border — invisible in a
 * previewer, and a black hairline once iOS composites it.
 */
const bleed = (space, inset) => [
  { t: 'rect', x: -2, y: -2, w: space + 4, h: space + 4, r: 0, fill: INK },
  ...art(space, inset),
];

const ICONS = [
  { file: 'icon-192.png', size: 192, shapes: rounded(64) },
  { file: 'icon-512.png', size: 512, shapes: rounded(64) },
  // Android's crop can eat everything outside the centre 80%; 0.62 keeps the
  // whole mark inside the inscribed safe circle rather than merely the box.
  { file: 'icon-maskable-512.png', size: 512, shapes: bleed(64, 0.62) },
  // iOS applies its own mask and squircle, so a rounded source would double up.
  { file: 'apple-touch-icon.png', size: 180, shapes: bleed(64, 0.86) },
];

mkdirSync(OUT, { recursive: true });
for (const { file, size, shapes } of ICONS) {
  const px = render(shapes, size, 64);
  // apple-touch-icon must be fully opaque: iOS composites transparency on BLACK,
  // which would ring the icon in a colour that is nowhere in the game.
  if (file === 'apple-touch-icon.png') {
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) throw new Error('apple-touch-icon has transparent pixels');
    }
  }
  writeFileSync(join(OUT, file), encodePng(px, size));
  console.log(`wrote public/${file} (${size}x${size})`);
}

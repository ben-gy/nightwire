/**
 * manifest.test.ts — the home-screen install.
 *
 * An install failure is silent: iOS and Android just quietly use a screenshot of
 * the page, or nothing. There is no console error to notice, so nobody finds out
 * until someone looks at their home screen. Everything asserted here is a thing
 * that fails that way.
 *
 * The icons are generated (scripts/gen-icons.mjs) and committed, which is
 * exactly the arrangement where a file drifts out of date or gets truncated to
 * zero bytes and nothing notices. So this reads the real PNG headers off disk
 * rather than trusting the filenames.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const manifest: {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: Icon[];
} = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

/** Read a PNG's real dimensions out of its IHDR — the filename is not evidence. */
function pngHeader(file: string): { width: number; height: number; hasAlpha: boolean } {
  const b = readFileSync(join(PUBLIC, file));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(b.subarray(0, 8).equals(sig), `${file} is not a PNG`).toBe(true);
  // IHDR must be the first chunk, so its fields sit at fixed offsets.
  expect(b.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), hasAlpha: b[25] === 6 };
}

describe('manifest.webmanifest', () => {
  it('has the fields a browser needs before it will offer an install', () => {
    expect(manifest.name).toBe('Nightwire');
    expect(manifest.short_name).toBe('Nightwire');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBeTruthy();
    // Both colours must be the game's ink, or the splash screen flashes white.
    expect(manifest.background_color).toBe('#0b0e17');
    expect(manifest.theme_color).toBe('#0b0e17');
  });

  it('uses relative start_url/scope so it resolves under a subpath AND a domain', () => {
    // "/" would scope the app to the domain root. Served from a project subpath
    // that puts every install out of scope, and the app opens in a browser tab
    // instead of standalone.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    for (const icon of manifest.icons) expect(icon.src.startsWith('./')).toBe(true);
  });

  it('ships every icon it declares, at the size it declares', () => {
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const file = icon.src.replace(/^\.\//, '');
      const { width, height } = pngHeader(file);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect({ file, width, height }).toEqual({ file, width: w, height: h });
      expect(icon.type).toBe('image/png');
    }
  });

  it('carries the 192 and 512 "any" icons, plus a 512 maskable', () => {
    const any = manifest.icons.filter((i) => i.purpose === 'any');
    expect(any.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    // Without a maskable icon Android crops the "any" one to its adaptive shape
    // and takes the corners of the artwork with it.
    const maskable = manifest.icons.filter((i) => i.purpose === 'maskable');
    expect(maskable).toHaveLength(1);
    expect(maskable[0].sizes).toBe('512x512');
  });
});

describe('the iOS install (which ignores the manifest entirely)', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

  it('links the manifest and the apple-touch-icon relatively', () => {
    expect(html).toMatch(/<link rel="manifest" href="manifest\.webmanifest"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="apple-touch-icon\.png"/);
    // A leading slash resolves to the domain root, which is not where this game
    // lives in dev. Assert the trap directly rather than the happy path only.
    expect(html).not.toMatch(/href="\/(manifest|apple-touch-icon|favicon)/);
  });

  it('declares the iOS standalone meta set', () => {
    expect(html).toMatch(/<meta name="theme-color" content="#0b0e17"/);
    expect(html).toMatch(/<meta name="apple-mobile-web-app-capable" content="yes"/);
    expect(html).toMatch(/<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="Nightwire"/);
  });

  it('ships a 180x180 apple-touch-icon with NO transparent pixel', () => {
    const { width, height } = pngHeader('apple-touch-icon.png');
    expect({ width, height }).toEqual({ width: 180, height: 180 });

    // iOS composites any transparency onto BLACK, so a soft or rounded edge
    // comes back as a black halo around the icon on the home screen.
    const b = readFileSync(join(PUBLIC, 'apple-touch-icon.png'));
    const raw = decodeRgba(b, 180, 180);
    const transparent = [];
    for (let i = 3; i < raw.length; i += 4) if (raw[i] !== 255) transparent.push(i >> 2);
    expect(transparent.slice(0, 8)).toEqual([]);
  });

  it('does NOT register a service worker', () => {
    // The bundle is self-contained, so a SW buys nothing — and a stale cache
    // would serve players the previous build after every deploy.
    expect(html).not.toMatch(/serviceWorker|sw\.js/i);
  });
});

/** Minimal PNG reader: enough to un-filter our own non-interlaced RGBA output. */
function decodeRgba(png: Buffer, width: number, height: number): Buffer {
  const { inflateSync } = require('node:zlib') as typeof import('node:zlib');
  const idat: Buffer[] = [];
  let p = 8;
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.subarray(p + 4, p + 8).toString('ascii');
    if (type === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    // gen-icons.mjs writes filter 0 (None) on every scanline; if that ever
    // changes this decoder must too, so fail loudly rather than read garbage.
    expect(filter).toBe(0);
    raw.copy(out, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return out;
}

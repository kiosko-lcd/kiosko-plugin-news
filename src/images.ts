/**
 * Downloading photos, with a disk cache; handing them to the screens.
 *
 * The disk cache isn't an optimisation: it's what keeps a network outage from
 * blanking the screen, since the widget keeps rotating over what's stored. So
 * photos are kept by URL and only removed by age, never on start.
 *
 * A screen may paint in a thread of its own (Kiosko 0.2.14 and later), with
 * its own copy of this module: what `fetch` decodes here it never sees. So
 * the photo travels in the widget's data, as a small JPEG (`loadPhoto`), and
 * each thread decodes it at the size of the tile that shows it, keeping a
 * few (`photoFor`). The main thread keeps only those bytes.
 *
 * Decoding goes through the canvas API the runtime hands over
 * (`ctx.canvas.loadImageScaled`, or `loadImage` on an older Kiosko): an
 * image decoded by another copy of the canvas library couldn't be drawn on
 * the panel.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanvasApi, Image } from '@kiosko/sdk';
import { USER_AGENT } from './feeds.ts';

/** 12 MB: a front-page photo is nowhere near, and it bounds a poisoned link. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Smaller than this, a photo can't fill a frame. */
const MIN_PHOTO = { w: 240, h: 135 };
/**
 * What a photo is shrunk to when it's fetched: it fits in this (`contain`),
 * so it is never larger than the biggest tile can be (a tile is never larger
 * than its panel, at most 1920 on either side), whatever its shape. It used
 * to *cover* 1920×1080: a portrait photo stayed 1920×2821, 21 MB decoded.
 * Each screen then decodes it at the size of the tile that shows it.
 */
export const PHOTO_SIZE = { width: 1920, height: 1920, fit: 'contain' as const };

export function cacheName(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 24);
}

/**
 * Local path of the photo, downloading it if needed. Atomic write (temp file
 * and rename) so a process dying halfway doesn't leave a truncated JPEG that
 * would then fail to decode on every pass without ever being retried.
 */
export async function cacheImage(dir: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, cacheName(url));
  try {
    if (statSync(path).size > 0) return path;
  } catch {
    /* not cached yet: download it */
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty response');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image of ${buf.length} bytes, too big`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, path);
  return path;
}

/** `canvas.loadImageScaled`, in Kiosko 0.2.5 and later (its SDK types may be older than the Kiosko running the plugin). */
type Scaler = (src: string | Buffer | Uint8Array, size: { width: number; height: number; fit?: 'cover' | 'contain' }) => Promise<Image>;
const scalerOf = (canvas: CanvasApi) => (canvas as CanvasApi & { loadImageScaled?: Scaler }).loadImageScaled;
const asBuffer = (b: Uint8Array) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/* ---------- in `fetch` (main thread): the photo as a small JPEG ---------- */

/** Prepared photos by URL (null = it failed): encoded bytes, never decoded images. */
const prepared = new Map<string, Uint8Array | null>();
/** A few stories ahead and behind for each widget: re-fetching reuses them, so the data stays the same object. */
const MAX_PREPARED = 8;
/** A photo of the right size but heavier than this (a PNG) is encoded again as a JPEG. */
const MAX_PREPARED_PHOTO = 1024 * 1024;
/** And never more than this in all (a prepared photo is 100 to 600 kB). */
const MAX_PREPARED_BYTES = 6 * 1024 * 1024;

/** What the main thread keeps of the photos: how many and how many bytes (all encoded). */
export function preparedPhotos(): { count: number; bytes: number } {
  let bytes = 0;
  for (const b of prepared.values()) bytes += b?.byteLength ?? 0;
  return { count: prepared.size, bytes };
}

function keepPrepared(url: string, bytes: Uint8Array | null): void {
  prepared.delete(url);
  prepared.set(url, bytes);
  let total = 0;
  for (const b of prepared.values()) total += b?.byteLength ?? 0;
  while (prepared.size > MAX_PREPARED || (total > MAX_PREPARED_BYTES && prepared.size > 1)) {
    const [oldest, b] = prepared.entries().next().value!;
    prepared.delete(oldest);
    total -= b?.byteLength ?? 0;
  }
}

/**
 * The photo of `url` ready to travel with the widget's data: downloaded (or
 * from the disk cache), shrunk to `PHOTO_SIZE` and encoded as a JPEG. Null if
 * anything fails. Only bytes are kept: a screen painting in its own thread
 * can't see what this thread decoded (it has its own copy of this module), so
 * the photo has to go in the data, and decoded it would stay in memory here
 * for as long as the data does, for nobody.
 */
export async function loadPhoto(
  dir: string,
  url: string,
  o: { canvas: CanvasApi; timeoutMs: number; signal?: AbortSignal; log?: (msg: string) => void },
): Promise<Uint8Array | null> {
  if (prepared.has(url)) {
    const hit = prepared.get(url)!;
    keepPrepared(url, hit);
    return hit;
  }
  let out: Uint8Array | null = null;
  try {
    const path = await cacheImage(dir, url, o.timeoutMs, o.signal);
    const file = readFileSync(path);
    // Shrunk in another thread when this Kiosko can (0.2.5 and later); here otherwise.
    const scaled = scalerOf(o.canvas);
    const img = scaled ? await scaled(file, PHOTO_SIZE) : await o.canvas.loadImage(file);
    // A thumbnail or a pixel that slipped past the feed parser would paint as a blur or a flat colour.
    if (img.width < MIN_PHOTO.w || img.height < MIN_PHOTO.h) throw new Error(`${img.width}×${img.height}, too small for a background`);
    const to = fitSize(img.width, img.height);
    const src = img.src as unknown;
    if (to.width === img.width && to.height === img.height && src instanceof Uint8Array && src.byteLength && src.byteLength <= MAX_PREPARED_PHOTO) out = src;
    else {
      // An older Kiosko (no `loadImageScaled`), a heavy PNG, or a source the image doesn't keep: shrink and encode it here.
      const c = o.canvas.createCanvas(to.width, to.height);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, to.width, to.height);
      out = await c.encode('jpeg', 88);
    }
    // A view of its own: not a slice of some larger buffer the photo would keep alive.
    out = new Uint8Array(out);
  } catch (err) {
    out = null;
    o.log?.(`photo dropped (${err instanceof Error ? err.message : String(err)}): ${url.slice(0, 90)}`);
  }
  keepPrepared(url, out);
  return out;
}

/** `w`×`h` shrunk (never enlarged) to fit `PHOTO_SIZE`. */
export function fitSize(w: number, h: number): { width: number; height: number } {
  const s = Math.min(1, PHOTO_SIZE.width / w, PHOTO_SIZE.height / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/* ---------- in `render` (whichever thread paints): decoded at the tile's size ---------- */

/** Decoded photos of this thread, by `url|w×h` (null = it failed): the tiles painting now and the one before. */
const decoded = new Map<string, Image | null>();
const MAX_DECODED = 4;
const decoding = new Set<string>();

const keyOf = (url: string, w: number, h: number) => `${url}|${Math.round(w)}x${Math.round(h)}`;

/** What this thread keeps decoded, for tests and the log: how many and their pixels. */
export function decodedPhotos(): { count: number; pixels: number; largest: { width: number; height: number } | null } {
  let pixels = 0;
  let largest: { width: number; height: number } | null = null;
  for (const img of decoded.values()) {
    if (!img) continue;
    pixels += img.width * img.height;
    if (!largest || img.width * img.height > largest.width * largest.height) largest = { width: img.width, height: img.height };
  }
  return { count: decoded.size, pixels, largest };
}

/**
 * Whether the photo of `url` is still to be decoded in this thread, so the
 * widget repaints soon: being decoded, or not even started (it's asked before
 * the first paint that starts it).
 */
export function photoPending(url: string | null | undefined, bytes: Uint8Array | undefined): boolean {
  if (!url || !bytes?.byteLength) return false;
  const prefix = `${url}|`;
  for (const k of decoding) if (k.startsWith(prefix)) return true;
  for (const k of decoded.keys()) if (k.startsWith(prefix)) return false;
  return true;
}

/**
 * The photo to paint in a `w`×`h` box: an `Image` once decoded (covering the
 * box, no larger), null if there is none or it failed, undefined while it is
 * being decoded (it is started here, off the paint: `loadImage` decodes on
 * libuv's pool, `loadImageScaled` in a thread of its own).
 */
export function photoFor(
  url: string | null | undefined,
  bytes: Uint8Array | undefined,
  size: { w: number; h: number },
  o: { canvas: CanvasApi; log?: (msg: string) => void },
): Image | null | undefined {
  if (!url || !bytes?.byteLength) return null;
  const key = keyOf(url, size.w, size.h);
  if (decoded.has(key)) {
    const hit = decoded.get(key)!;
    decoded.delete(key);
    decoded.set(key, hit);
    return hit;
  }
  if (!decoding.has(key)) {
    decoding.add(key);
    const scaled = scalerOf(o.canvas);
    const src = asBuffer(bytes);
    const w = Math.max(1, Math.round(size.w));
    const h = Math.max(1, Math.round(size.h));
    void (scaled ? scaled(src, { width: w, height: h, fit: 'cover' }) : o.canvas.loadImage(src))
      .then(
        (img) => img as Image | null,
        (err: unknown) => {
          o.log?.(`photo could not be decoded (${err instanceof Error ? err.message : String(err)}): ${url.slice(0, 90)}`);
          return null;
        },
      )
      .then((img) => {
        decoding.delete(key);
        decoded.set(key, img);
        while (decoded.size > MAX_DECODED) decoded.delete(decoded.keys().next().value!);
      });
  }
  return undefined;
}

/** Forgets what this thread decoded (tests). */
export function forgetDecoded(): void {
  decoded.clear();
}

/** Removes photos untouched for more than `maxAgeHours`. */
export function pruneImageCache(dir: string, maxAgeHours: number, now = Date.now()): number {
  const cutoff = now - maxAgeHours * 3600_000;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p);
          removed += 1;
        }
      } catch {
        /* another process removed it between listing and stat */
      }
    }
  } catch {
    /* the cache doesn't exist yet */
  }
  return removed;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { cacheName, decodedPhotos, fitSize, forgetDecoded, loadPhoto, photoFor, photoPending, preparedPhotos, PHOTO_SIZE } from './images.ts';

const jpeg = (w: number, h: number) => {
  const c = createCanvas(w, h);
  c.getContext('2d').fillRect(0, 0, w, h);
  return c.toBuffer('image/jpeg', 80);
};
const sizeOf = async (b: Uint8Array) => {
  const img = await loadImage(Buffer.from(b));
  return [img.width, img.height];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('loadPhoto: shrunk in another thread when Kiosko can, here with an older one; bytes, not a decoded image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-photos-'));
  const asked: unknown[] = [];
  const url = (n: number) => `https://example.test/${n}.jpg`;
  for (const n of [1, 2]) writeFileSync(join(dir, cacheName(url(n))), jpeg(1600, 900));
  const scaled = await loadPhoto(dir, url(1), {
    canvas: { createCanvas, loadImage, loadImageScaled: async (src: string | Buffer, size: unknown) => (asked.push([Buffer.isBuffer(src), size]), loadImage(src)) } as never,
    timeoutMs: 1000,
  });
  assert.ok(scaled instanceof Uint8Array, 'encoded bytes, which any thread can take');
  assert.deepEqual(await sizeOf(scaled!), [1600, 900]);
  assert.deepEqual(asked, [[true, PHOTO_SIZE]]);
  const whole = await loadPhoto(dir, url(2), { canvas: { createCanvas, loadImage } as never, timeoutMs: 1000 });
  assert.deepEqual(await sizeOf(whole!), [1600, 900]);
  assert.equal(await loadPhoto(dir, url(1), { canvas: { createCanvas, loadImage } as never, timeoutMs: 1000 }), scaled, 'again: the same bytes (the same data, nothing sent again)');
});

test('loadPhoto: a big photo of any shape is shrunk to fit the largest tile (1920 a side), never a 1920×2821 cover', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-photos-'));
  const portrait = 'https://example.test/portrait.jpg';
  const wide = 'https://example.test/wide.jpg';
  writeFileSync(join(dir, cacheName(portrait)), jpeg(3000, 4408));
  writeFileSync(join(dir, cacheName(wide)), jpeg(4000, 2250));
  // An older Kiosko without loadImageScaled: shrunk here.
  const io = { canvas: { createCanvas, loadImage } as never, timeoutMs: 1000 };
  assert.deepEqual(await sizeOf((await loadPhoto(dir, portrait, io))!), [1307, 1920]);
  assert.deepEqual(await sizeOf((await loadPhoto(dir, wide, io))!), [1920, 1080]);
  assert.deepEqual(fitSize(1920, 2821), { width: 1307, height: 1920 });
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 }, 'never enlarged');
});

test('loadPhoto: the main thread keeps a bounded handful of encoded photos, nothing decoded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-photos-'));
  const io = { canvas: { createCanvas, loadImage } as never, timeoutMs: 1000 };
  for (let n = 0; n < 20; n++) {
    const url = `https://example.test/many-${n}.jpg`;
    writeFileSync(join(dir, cacheName(url)), jpeg(1920, 1080));
    await loadPhoto(dir, url, io);
  }
  const kept = preparedPhotos();
  assert.ok(kept.count <= 8, `${kept.count} photos kept`);
  assert.ok(kept.bytes <= 6 * 1024 * 1024, `${kept.bytes} bytes kept`);
  assert.equal(decodedPhotos().count, 0, 'fetching decodes nothing that stays');
});

test('photoFor: decoded off the paint at the size of the tile, a few kept per thread', async () => {
  forgetDecoded();
  const bytes = new Uint8Array(jpeg(1307, 1920));
  const url = 'https://example.test/tile.jpg';
  const canvas = { createCanvas, loadImage, loadImageScaled: async (src: Buffer, s: { width: number; height: number }) => {
    // Cover, like Kiosko's: the smallest size that fills the box.
    const img = await loadImage(src);
    const k = Math.max(s.width / img.width, s.height / img.height);
    const c = createCanvas(Math.round(img.width * k), Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return loadImage(await c.encode('jpeg', 85));
  } } as never;
  assert.equal(photoPending(url, bytes), true, 'not started yet: pending, so the widget repaints soon');
  assert.equal(photoFor(url, bytes, { w: 600, h: 462 }, { canvas }), undefined, 'not yet: being decoded');
  assert.equal(photoPending(url, bytes), true);
  for (let i = 0; i < 100 && photoPending(url, bytes); i++) await sleep(10);
  const img = photoFor(url, bytes, { w: 600, h: 462 }, { canvas })!;
  assert.deepEqual([img.width, img.height], [600, 881], 'covers the tile, no larger');
  assert.equal(photoPending(url, bytes), false);
  assert.equal(photoFor(null, undefined, { w: 600, h: 462 }, { canvas }), null, 'no photo');
  for (let n = 0; n < 10; n++) photoFor(`${url}?${n}`, bytes, { w: 300, h: 200 }, { canvas });
  for (let i = 0; i < 200 && [...Array(10).keys()].some((n) => photoPending(`${url}?${n}`, bytes)); i++) await sleep(10);
  const kept = decodedPhotos();
  assert.ok(kept.count <= 4, `${kept.count} kept`);
  assert.ok(kept.pixels <= 4 * 600 * 881, `${kept.pixels} pixels kept`);
  forgetDecoded();
});

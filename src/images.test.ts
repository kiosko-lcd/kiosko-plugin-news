import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { cacheName, loadPhoto, PHOTO_SIZE } from './images.ts';

const jpeg = (w: number, h: number) => {
  const c = createCanvas(w, h);
  c.getContext('2d').fillRect(0, 0, w, h);
  return c.toBuffer('image/jpeg', 80);
};

test('loadPhoto: shrunk in another thread when Kiosko can, whole with an older one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-photos-'));
  const asked: unknown[] = [];
  const url = (n: number) => `https://example.test/${n}.jpg`;
  for (const n of [1, 2]) writeFileSync(join(dir, cacheName(url(n))), jpeg(1600, 900));
  const scaled = await loadPhoto(dir, url(1), {
    canvas: { createCanvas, loadImage, loadImageScaled: async (src: string, size: unknown) => (asked.push([src, size]), loadImage(src)) } as never,
    timeoutMs: 1000,
  });
  assert.equal(scaled?.width, 1600);
  assert.deepEqual(asked, [[join(dir, cacheName(url(1))), PHOTO_SIZE]]);
  const whole = await loadPhoto(dir, url(2), { canvas: { createCanvas, loadImage } as never, timeoutMs: 1000 });
  assert.equal(whole?.width, 1600);
});

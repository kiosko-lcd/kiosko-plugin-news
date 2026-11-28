// A screen that paints in its own thread (as Kiosko does in production) gets
// the news photos: they travel in the widget's data, since that thread has its
// own copy of this plugin and sees nothing the main thread decoded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Never the real Kiosko's folders (config, plugin caches in $XDG_RUNTIME_DIR): set before Kiosko is loaded.
const sandbox = mkdtempSync(join(tmpdir(), 'news-threads-'));
process.env.KIOSKO_SANDBOX = sandbox;
process.env.KIOSKO_HOME = join(sandbox, 'kiosko');
process.env.XDG_RUNTIME_DIR = join(sandbox, 'run');
process.env.KIOSKO_QUIET = '1';
const { normalize, Registry, Runtime } = await import('@kiosko/core');
const { default: plugin } = await import('./index.ts');
const { decodedPhotos, preparedPhotos } = await import('./images.ts');

const MODULE = new URL('./index.ts', import.meta.url).href;
const RED = [224, 16, 16];
const W = 600, H = 462;

/** A feed of three fresh stories, each with a large portrait photo, all red. */
async function feedServer(): Promise<{ server: Server; url: string }> {
  const c = createCanvas(1600, 2400);
  const g = c.getContext('2d');
  g.fillStyle = `rgb(${RED.join(',')})`;
  g.fillRect(0, 0, c.width, c.height);
  const photo = c.toBuffer('image/jpeg', 90);
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/photo')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(photo);
      return;
    }
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const now = new Date().toUTCString();
    const items = ['El Congreso aprueba la reforma de la ley de vivienda', 'Una borrasca deja lluvias intensas en el norte peninsular', 'El telescopio descubre un planeta parecido a la Tierra']
      .map((title, i) => `<item><title>${title}</title><link>${base}/story/${i}</link><pubDate>${now}</pubDate><description>Resumen de la noticia número ${i} con algo de texto.</description><media:content url="${base}/photo/${i}.jpg" medium="image" type="image/jpeg" width="1600" height="2400"/></item>`)
      .join('');
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Local</title>${items}</channel></rss>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rss` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(50);
  }
  assert.fail(`${what}: timed out`);
}

/** Pixels across the photo band of the column (its top, under no text). */
async function band(f: { image: () => Buffer | Promise<Buffer> }): Promise<number[][]> {
  const img = await loadImage(await f.image());
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  const g = c.getContext('2d');
  return [0.2, 0.4, 0.6, 0.8].map((x) => [...g.getImageData(Math.round(img.width * x), Math.round(img.height * 0.15), 1, 1).data].slice(0, 3));
}
/** The red photo, under the column's veil (it dims it); without it the band is the dark blue-grey fallback. */
const isPhoto = (px: number[][]) => px.every(([r, g, b]) => r! > 80 && r! > 4 * g! && r! > 4 * b!);

/** Whether the column's data has its photo; until then, asks for a fetch now and then (the deck may come after the first one). */
let asked = 0;
function hasPhoto(rt: InstanceType<typeof Runtime>): boolean {
  if ((rt.dataOf('col') as { jpeg?: unknown } | undefined)?.jpeg) return true;
  if (Date.now() - asked > 1000) (asked = Date.now()), rt.refreshWidget('col');
  return false;
}

function runtime(threads: 'always' | 'never', feed: string) {
  const reg = new Registry();
  reg.add(plugin, 'test', MODULE);
  const screen = {
    id: 'a', name: 'a', width: W, height: H, maxFps: 20, pixelShift: { enabled: false }, device: { driver: 'virtual' },
    pages: [{ id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [{ id: 't', x: 0, y: 0, w: 1, h: 1, chrome: 'bare', widgets: [{ id: 'col', type: 'news/column', options: { showCorner: false, offset: 0 } }] }] }],
  };
  return new Runtime(reg, normalize({ threads, sources: { 'news/deck': { feeds: [{ name: 'Local', url: feed }] } }, screens: [screen] }));
}

test('threads: a news column painting in its own thread shows the photo; the main thread keeps only its bytes', async (t) => {
  const { server, url } = await feedServer();
  const rt = runtime('always', url);
  t.after(() => (rt.stop(), server.close()));
  rt.start();
  await until(() => rt.status().screens[0]?.thread.on === true, 15_000, 'the screen in a thread');
  await until(() => hasPhoto(rt), 30_000, 'the photo in the data');
  await until(async () => {
    const f = rt.lastFrame('a');
    return !!f && isPhoto(await band(f));
  }, 15_000, 'the photo painted in the thread');
  assert.equal(rt.status().screens[0]?.thread.on, true, 'still in its thread');

  const data = rt.dataOf('col') as { photo: string; jpeg: Uint8Array };
  assert.ok(data.jpeg instanceof Uint8Array, 'the photo travels as encoded bytes');
  const img = await loadImage(Buffer.from(data.jpeg));
  assert.ok(img.width <= 1920 && img.height <= 1920, `shrunk at fetch: ${img.width}×${img.height}`);
  assert.equal(decodedPhotos().count, 0, 'the main thread decoded nothing for the panel');
  const kept = preparedPhotos();
  assert.ok(kept.count <= 8 && kept.bytes <= 6 * 1024 * 1024, `main thread keeps ${kept.count} photos, ${kept.bytes} bytes`);
});

test('main thread (the editor\'s preview, or a screen without a thread): the photo is painted too, decoded at the tile\'s size', async (t) => {
  const { server, url } = await feedServer();
  const rt = runtime('never', url);
  t.after(() => (rt.stop(), server.close(), rmSync(sandbox, { recursive: true, force: true })));
  rt.start();
  await until(() => hasPhoto(rt), 30_000, 'the photo in the data');
  assert.equal(rt.status().screens[0]?.thread.on, false);
  await until(async () => {
    const f = rt.lastFrame('a');
    return !!f && isPhoto(await band(f));
  }, 15_000, 'the photo painted here');
  const kept = decodedPhotos();
  assert.ok(kept.count >= 1 && kept.count <= 4, `${kept.count} decoded`);
  assert.ok(kept.largest!.width <= W && kept.largest!.height <= Math.ceil(W * 1.5) + 1, `at the tile's size: ${JSON.stringify(kept.largest)}`);
});

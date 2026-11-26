/**
 * The deck's profiles (Kiosko 0.2.12 on): each reads its own feeds and groups
 * its own stories, keeps its own last deck, and a feed that two profiles
 * list is downloaded once.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createBaseContext, validate } from '@kiosko/sdk';
import { FEED_SHARE_MS, clearFeedCache, fetchShared } from './feeds.ts';
import { deck, deckFile, type NewsDeck } from './index.ts';

const NOW = Date.now();
const rss = (paper: string, titles: string[]) => `<rss><channel>${titles
  .map(
    (title, i) => `<item><title>${title}</title><link>https://${paper}.example/${i}</link>
      <description>Una explicación suficientemente larga sobre ${title.toLowerCase()} para valer como entradilla.</description>
      <pubDate>${new Date(NOW - (i + 1) * 3_600_000).toUTCString()}</pubDate>
      <enclosure type="image/jpeg" url="https://${paper}.example/${i}.jpg"/></item>`,
  )
  .join('')}</channel></rss>`;

const FEEDS: Record<string, string> = {
  '/general.xml': rss('general', ['Mueren dos mujeres en el Puerto de Algeciras al caer al mar un coche', 'Una ola de calor llega a la península este fin de semana']),
  '/general2.xml': rss('otro', ['Dos mujeres mueren al caer un coche al mar en el puerto de Algeciras', 'Nueva línea de metro en Valencia']),
  '/tech.xml': rss('tech', ['Un nuevo chip triplica la memoria de los portátiles', 'La IA llega a los hospitales de Madrid']),
};
const hits = new Map<string, number>();
let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
    const body = FEEDS[req.url!];
    if (req.url === '/slow.xml') return void setTimeout(() => res.end(FEEDS['/tech.xml']), 300);
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(body);
  });
  // Below 40 000: Windows reserves blocks of its dynamic range.
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      base = `http://127.0.0.1:${port}`;
      break;
    }
  }
});
after(() => server.close());

function ctx(dir: string, options: Record<string, unknown>, profile?: string) {
  return {
    ...createBaseContext({ now: NOW, locale: 'es', dataDir: dir, cacheDir: dir }),
    options: validate(deck.options!, options).value as never,
    signal: new AbortController().signal,
    intervalMs: 600_000,
    timeoutMs: 10_000,
    ...(profile ? { profile } : {}),
  };
}
const feed = (name: string, path: string) => ({ name, url: base + path });

test('deck: declares profiles, in a way an older SDK ignores', () => {
  assert.equal((deck as { profiles?: boolean }).profiles, true);
});

test('deck: two profiles read at once ask each shared feed once, and each groups only its own stories', async () => {
  clearFeedCache();
  hits.clear();
  const dir = mkdtempSync(join(tmpdir(), 'news-profiles-'));
  try {
    const general = { feeds: [feed('El País', '/general.xml'), feed('ABC', '/general2.xml')] };
    const tech = { feeds: [feed('El País', '/general.xml'), feed('Xataka', '/tech.xml')] };
    const [g, t] = (await Promise.all([deck.read!(ctx(dir, general)), deck.read!(ctx(dir, tech, 'tech'))])) as [NewsDeck, NewsDeck];
    assert.deepEqual(Object.fromEntries(hits), { '/general.xml': 1, '/general2.xml': 1, '/tech.xml': 1 }, 'the feed both list: downloaded once');
    // Each its own consensus: Algeciras is told by two outlets in General, by one in Technology.
    const algeciras = (d: NewsDeck) => d.stories.find((s) => /Algeciras/.test(s.lead.title))!;
    assert.equal(algeciras(g).consensus, 2);
    assert.equal(algeciras(t).consensus, 1);
    assert.ok(!g.stories.some((s) => /chip/.test(s.lead.title)), 'no tech story in General');
    assert.ok(t.stories.some((s) => /chip/.test(s.lead.title)));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.json')).sort(), ['deck-tech.json', 'deck.json'], 'each keeps its own last deck');

    // Read again a moment later (another profile's turn): still shared; after the window, asked again.
    await deck.read!(ctx(dir, general));
    assert.equal(hits.get('/general.xml'), 1);
    await fetchShared(base + '/general.xml', 5_000, undefined, Date.now() + FEED_SHARE_MS + 1);
    assert.equal(hits.get('/general.xml'), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deck: a shared download outlives the profile that gave up waiting, and failures are not kept', async () => {
  clearFeedCache();
  hits.clear();
  const ac = new AbortController();
  const first = fetchShared(base + '/slow.xml', 5_000, ac.signal);
  const second = fetchShared(base + '/slow.xml', 5_000);
  ac.abort(new Error('gave up'));
  await assert.rejects(first, /gave up/);
  assert.match(await second, /chip/, 'the other still gets it');
  assert.equal(hits.get('/slow.xml'), 1);

  await assert.rejects(fetchShared(base + '/missing.xml', 5_000), /HTTP 404/);
  await assert.rejects(fetchShared(base + '/missing.xml', 5_000), /HTTP 404/);
  assert.equal(hits.get('/missing.xml'), 2, 'a failure is tried again, not remembered');
});

test('deck: file names per profile', () => {
  assert.equal(deckFile(undefined), 'deck.json');
  assert.equal(deckFile('tech'), 'deck-tech.json');
  assert.equal(deckFile('../x'), 'deck-___x.json', 'never a path');
});

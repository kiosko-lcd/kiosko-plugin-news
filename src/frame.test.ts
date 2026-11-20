import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBaseContext, createFormatters, defaultsOf, plural, validate, DEFAULT_WORKDAY } from '@kiosko/sdk';
import { coverRect, outletsLabel, storyAge } from './frame.ts';
import { column, deck, headline, storiesFor } from './index.ts';
import { demoDeck } from './demo.ts';
import { contrastPair, publisherOf } from './cluster.ts';
import { AI_MAX_AGE_MS, DEFAULT_FEEDS_BY_LANGUAGE } from './defaults.ts';

test('frame: the age of a story, in the panel language, none without a date', () => {
  const now = Date.UTC(2026, 8, 2, 12);
  const es = (ms: number) => storyAge({ fmt: createFormatters({ locale: 'es', now }), now }, ms) ?? '';
  assert.strictEqual(es(0), '', 'no date, no age');
  assert.strictEqual(es(now - 30_000), 'ahora mismo');
  assert.strictEqual(es(now - 12 * 60_000), 'hace 12 min');
  assert.strictEqual(es(now - 3 * 3600_000), 'hace 3 h');
  assert.strictEqual(es(now - 3 * 86_400_000), 'hace 3 d');
  assert.strictEqual(es(now + 60_000), '', 'a feed clock in the future does not say "-5 min ago"');
  assert.strictEqual(storyAge({ fmt: createFormatters({ locale: 'en', now }), now }, now - 12 * 60_000), '12 min ago');
  const outlets = (locale: string, n: number) => outletsLabel({ plural: (k, forms) => plural(k, forms, locale) }, n);
  assert.strictEqual(outlets('en', 3), '3 outlets');
  assert.strictEqual(outlets('en', 1), '1 outlet');
  assert.strictEqual(outlets('es', 2), '2 cabeceras');
  assert.strictEqual(outlets('zh-TW', 3), '3 家媒體');
  assert.strictEqual(outlets('zh-CN', 3), '3 家媒体');
});

test('outlets: a widget shows the stories of its outlets, led by their version', () => {
  const d = demoDeck(Date.UTC(2026, 10, 5, 10), 'en');
  assert.strictEqual(storiesFor(d.stories, []).length, d.stories.length, 'empty: all');
  const port = d.stories.find((s) => s.consensus === 3)!;
  const coast = storiesFor(d.stories, ['Coast Daily']);
  assert.ok(coast.length > 0 && coast.every((s) => s.items.every((it) => it.source === 'Coast Daily')));
  const portCoast = coast.find((s) => s.items.some((it) => port.items.includes(it)))!;
  assert.strictEqual(portCoast.lead.source, 'Coast Daily', 'the version of the outlet asked for');
  assert.strictEqual(portCoast.consensus, 3, 'still carried by three');
  assert.ok(storiesFor(d.stories, ['!Coast Daily']).every((s) => s.lead.source !== 'Coast Daily'));
  assert.ok(storiesFor(d.stories, ['Tech Today']).some((s) => s.lead.source === 'Tech Today AI'), 'a topic feed is also its paper');
  assert.strictEqual(storiesFor(d.stories, ['Nobody']).length, 0);
});

test('options: durations in ms, no timeout of its own, the widgets\' switches', () => {
  const o = validate(deck.options!, {}).value;
  assert.strictEqual(o.maxAgeMs, 72 * 3_600_000);
  assert.strictEqual(o.maxStories, 60);
  assert.ok(!('timeoutMs' in o) && !('maxAgeHours' in o) && !('poolSize' in o));
  assert.deepStrictEqual(o.feeds, [], 'none chosen: the outlets of the user\'s language, at read time');
  assert.strictEqual(deck.timeoutMs, 25_000);
  const h = defaultsOf(headline.options!);
  assert.deepStrictEqual({ outlets: h.outlets, showStandfirst: h.showStandfirst, showContrast: h.showContrast, showCorner: h.showCorner }, { outlets: [], showStandfirst: true, showContrast: true, showCorner: true });
  const c = defaultsOf(column.options!);
  assert.deepStrictEqual({ outlets: c.outlets, showStandfirst: c.showStandfirst, showCorner: c.showCorner }, { outlets: [], showStandfirst: true, showCorner: true });
  const state = (outlets: string[]) => ({ options: { ...h, outlets }, data: undefined, sources: { 'news/deck': demoDeck(Date.UTC(2026, 10, 5, 10), 'en') }, now: 0, working: true, workday: DEFAULT_WORKDAY });
  assert.strictEqual(headline.visible!(state(['Nobody'])), false, 'no story of its outlets: out of the rotation');
  assert.strictEqual(headline.visible!(state(['The Chronicle'])), true);
});

test('frame: the crop covers the whole box, biased upwards', () => {
  const r = coverRect(1200, 675, 1920, 462);
  assert.ok(r.dw >= 1920 - 0.001 && r.dh >= 462 - 0.001);
  assert.strictEqual(Math.round(r.dx), 0);
  assert.ok(r.dy > coverRect(1200, 675, 1920, 462, 0.5).dy, 'shows more of the top than centring');
  const wide = coverRect(4000, 500, 1920, 462);
  assert.ok(wide.dw >= 1920 && wide.dh >= 462 && wide.dx < 0, 'a very wide photo is cropped at the sides');
});

test('frame: the demo deck shows each layout', () => {
  const d = demoDeck(Date.UTC(2026, 10, 5, 10));
  assert.strictEqual(d.stories[0]?.consensus, 3, 'a story carried by three outlets opens');
  assert.ok(d.stories.some((s) => contrastPair(s)), 'and one with two versions to contrast');
  assert.ok(d.stories.every((s) => s.lead.image?.startsWith('demo:')), 'no network in the demo');
});

test('frame: the demo deck clusters the same way in every language', () => {
  const now = Date.UTC(2026, 10, 5, 10);
  // Each story as the publication times of its items: the same sample in every language, so equal shapes mean equal groups.
  const shape = (locale: string) => demoDeck(now, locale).stories.map((s) => ({ consensus: s.consensus, items: s.items.map((it) => it.published).sort() }));
  const en = shape('en');
  assert.deepStrictEqual(en.map((s) => s.consensus), [3, 2, 1, 1], 'three outlets, two, and two single stories');
  for (const locale of ['es', 'de', 'zh-Hant', 'zh-Hans']) {
    assert.deepStrictEqual(shape(locale), en, `${locale}: same groups as English`);
    const d = demoDeck(now, locale);
    assert.ok(d.stories.some((s) => contrastPair(s)), `${locale}: one with two versions to contrast`);
    assert.notDeepStrictEqual(d.stories.map((s) => s.lead.title), demoDeck(now, 'en').stories.map((s) => s.lead.title), `${locale}: its own headlines`);
  }
});

test('default feeds: one list per language, topic feeds first, AI ones with their shorter age', () => {
  assert.deepStrictEqual(Object.keys(DEFAULT_FEEDS_BY_LANGUAGE).sort(), ['de', 'en', 'es', 'zh-Hans', 'zh-Hant']);
  for (const [lang, feeds] of Object.entries(DEFAULT_FEEDS_BY_LANGUAGE)) {
    const topic = feeds.map((f) => !!f.titleFilter);
    assert.ok(topic[0] && topic.indexOf(false) > 0 && !topic.slice(topic.indexOf(false)).includes(true), `${lang}: topic feeds first`);
    for (const f of feeds) {
      assert.ok(f.url.startsWith('https://'), `${lang}: ${f.url}`);
      assert.strictEqual(!!f.titleFilter, publisherOf(f.name) !== f.name, `${lang}: ${f.name} is named as a topic feed iff it is one`);
      if (f.titleFilter) assert.strictEqual(f.maxAgeMs, AI_MAX_AGE_MS, `${lang}: ${f.name}`);
    }
  }
});

/** The URLs `deck.read` asks for, with no network: every feed answers 404. */
async function feedsRead(locale: string, feeds: { name: string; url: string; titleFilter: string; maxAgeMs: number }[] = []): Promise<string[]> {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'news-'));
    const base = createBaseContext({ now: Date.UTC(2026, 10, 20, 10), locale, cacheDir: dir, dataDir: dir });
    const options = { ...validate(deck.options!, {}).value, feeds };
    await deck.read!({ ...base, options, timeoutMs: 5000, intervalMs: 600_000, signal: new AbortController().signal }).catch(() => {});
  } finally {
    globalThis.fetch = real;
  }
  return asked.sort();
}

test('default feeds: chosen by the user\'s language at read time; a list of their own is untouched', async () => {
  const urls = (lang: string) => DEFAULT_FEEDS_BY_LANGUAGE[lang]!.map((f) => f.url).sort();
  assert.deepStrictEqual(await feedsRead('zh-TW'), urls('zh-Hant'));
  assert.deepStrictEqual(await feedsRead('zh-HK'), urls('zh-Hant'));
  assert.deepStrictEqual(await feedsRead('zh-CN'), urls('zh-Hans'));
  assert.deepStrictEqual(await feedsRead('es-MX'), urls('es'));
  assert.deepStrictEqual(await feedsRead('en-GB'), urls('en'));
  assert.deepStrictEqual(await feedsRead('de-AT'), urls('de'));
  assert.deepStrictEqual(await feedsRead('fr'), urls('en'), 'a language without a list reads English');
  const mine = [{ name: 'Mine', url: 'https://example.org/rss', titleFilter: '', maxAgeMs: 0 }];
  assert.deepStrictEqual(await feedsRead('zh-TW', mine), ['https://example.org/rss']);
});

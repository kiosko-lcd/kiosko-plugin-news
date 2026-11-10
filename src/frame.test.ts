import { test } from 'node:test';
import assert from 'node:assert';
import { createFormatters, defaultsOf, localize, validate, DEFAULT_WORKDAY } from '@kiosko/sdk';
import { coverRect, outletsLabel, storyAge } from './frame.ts';
import { column, deck, headline, storiesFor } from './index.ts';
import { demoDeck } from './demo.ts';
import { contrastPair } from './cluster.ts';

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
  assert.strictEqual(localize(outletsLabel(3), 'en'), '3 outlets');
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
  assert.ok(o.feeds.some((f) => f.maxAgeMs === 36 * 3_600_000), 'AI feeds keep their shorter age');
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWidget } from '@kiosko/sdk/testing';
import type { Story } from './cluster.ts';
import type { NewsItem } from './feeds.ts';
import { headline } from './index.ts';
import { foldText, parseTopics, storiesAbout, storyMatches } from './topics.ts';

const item = (title: string, summary = '', source = 'El País'): NewsItem => ({ title, summary, image: 'https://x/y.jpg', source, link: `https://x/${encodeURIComponent(title)}`, published: 0 });
const story = (...items: NewsItem[]): Story => ({ lead: items[0]!, items, consensus: new Set(items.map((i) => i.source)).size });

const futbol = story(item('El Madrid gana la Liga', 'Un gol en el último minuto da el título al equipo blanco.'));
const futbolista = story(item('Un futbolista, operado de la rodilla'));
const ia = story(item('La IA llega a los hospitales', 'Los médicos ya usan modelos para leer radiografías.'));
const familia = story(item('Una familia de Teruel gana la lotería'));
const apple = story(item('Apple presenta su IA para el iPhone'));
const tw = story(item('臺灣颱風來襲', '氣象署發布警報'));
const deck = [futbol, futbolista, ia, familia, apple, tw];
const titles = (list: Story[]) => list.map((s) => s.lead.title);

test('topics: case and accents don\'t matter, Traditional is Simplified', () => {
  assert.equal(foldText('  Fútbol  ÁRBITRO '), 'futbol arbitro');
  assert.equal(foldText('臺灣颱風'), '台湾台风');
});

test('topics: empty is every story; a word keeps those that mention it, at the start of a word', () => {
  assert.deepEqual(storiesAbout(deck, []), deck);
  assert.deepEqual(storiesAbout(deck, '  , ! '), deck, 'nothing but separators');
  assert.deepEqual(titles(storiesAbout(deck, ['fútbol'])), ['Un futbolista, operado de la rodilla'], 'the accent written or not, and a longer word');
  assert.deepEqual(titles(storiesAbout(deck, ['FUTBOL', 'liga'])), ['El Madrid gana la Liga', 'Un futbolista, operado de la rodilla'], 'any of them');
  assert.deepEqual(titles(storiesAbout(deck, ['ia'])), ['La IA llega a los hospitales', 'Apple presenta su IA para el iPhone'], 'not «familia»');
  assert.deepEqual(titles(storiesAbout(deck, ['radiografías'])), ['La IA llega a los hospitales'], 'in the standfirst too');
  assert.deepEqual(titles(storiesAbout(deck, ['último minuto'])), ['El Madrid gana la Liga'], 'a phrase');
});

test('topics: ! leaves out, also alone; several comma-separated', () => {
  assert.deepEqual(titles(storiesAbout(deck, ['ia', '!apple'])), ['La IA llega a los hospitales']);
  assert.deepEqual(titles(storiesAbout(deck, 'ia, ! Apple')), ['La IA llega a los hospitales'], 'one text with commas, spaces after the !');
  assert.equal(storiesAbout(deck, ['!liga', '!lotería']).length, deck.length - 2, 'only exclusions: everything else');
});

test('topics: any version of a story counts, and an excluded word in any version leaves it out', () => {
  const s = story(item('El Gobierno aprueba el presupuesto'), item('Hacienda saca adelante las cuentas con apoyo de Junts', '', 'ABC'));
  assert.equal(storyMatches(s, parseTopics(['junts'])), true);
  assert.equal(storyMatches(s, parseTopics(['presupuesto', '!junts'])), false);
});

test('topics: Chinese words match anywhere, Traditional or Simplified', () => {
  assert.deepEqual(titles(storiesAbout(deck, ['台风'])), ['臺灣颱風來襲']);
  assert.deepEqual(titles(storiesAbout(deck, ['警報'])), ['臺灣颱風來襲'], 'in the standfirst, written in Traditional');
  assert.equal(storiesAbout(deck, ['!颱風']).length, deck.length - 1);
});

test('topics: the widget shows only the stories about its topics, and waits when there are none', () => {
  const sources = { 'news/deck': { stories: deck, updated: 0, failed: [] } };
  const shown = renderWidget(headline, { options: { topics: ['hospitales'], showCorner: false }, sources, data: undefined, size: { w: 960, h: 300 } });
  assert.equal(shown.error, undefined);
  assert.ok(shown.texts.some((x) => /hospitales/.test(x)), shown.texts.join(' | '));
  const none = renderWidget(headline, { options: { topics: ['críquet'], showCorner: false }, sources, data: undefined, size: { w: 960, h: 300 } });
  assert.ok(!none.texts.some((x) => /Madrid|IA|familia/.test(x)), none.texts.join(' | '));
  assert.equal(headline.visible!({ options: { topics: ['críquet'], outlets: [] } as never, sources, data: undefined, now: 0, working: true } as never), false, 'skipped in its tile\'s rotation');
});

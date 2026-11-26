/**
 * A tile's topics (`topics`): keywords looked for in the headline and the
 * standfirst of every version of a story, so the general feeds already give
 * a «football» or «AI» tile with nothing else to set up.
 *
 *   []                         every story
 *   ["fútbol", "liga"]         stories that mention either
 *   ["!fútbol"]                every story but those
 *   ["ia", "!apple"]           AI, but not Apple's
 *
 * Case and accents don't matter (`futbol` finds «Fútbol»), and a keyword
 * matches at the start of a word: `ia` finds «IA» but not «familia», `fútbol`
 * also finds «futbolista». A keyword with spaces is a phrase. Chinese has no
 * spaces between words, so a keyword in Chinese matches anywhere, Traditional
 * and Simplified alike.
 */
import type { Story } from './cluster.ts';
import { foldHan } from './hanzi.ts';

/** Lowercase, without accents, Traditional folded to Simplified, spaces collapsed. */
export function foldText(text: string): string {
  return foldHan(text.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase()).replace(/\s+/g, ' ').trim();
}

const HAN = /\p{Script=Han}/u;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One keyword as a test on folded text. */
function matcher(word: string): (text: string) => boolean {
  const w = foldText(word);
  if (!w) return () => false;
  if (HAN.test(w)) return (text) => text.includes(w);
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(w)}`, 'u');
  return (text) => re.test(text);
}

export interface Topics {
  include: ((text: string) => boolean)[];
  exclude: ((text: string) => boolean)[];
}

/** The keywords of a `topics` option (a list, or one text with commas), ready to test. */
export function parseTopics(topics: readonly string[] | string | undefined): Topics {
  const list = (typeof topics === 'string' ? topics.split(/[,\n]/) : (topics ?? [])).map((x) => x.trim()).filter((x) => x && x !== '!');
  return {
    include: list.filter((x) => !x.startsWith('!')).map(matcher),
    exclude: list.filter((x) => x.startsWith('!')).map((x) => matcher(x.slice(1).trim())),
  };
}

/** Whether a story passes: some keyword in some version (if there are any to include), and no excluded one in any. */
export function storyMatches(story: Story, t: Topics): boolean {
  if (!t.include.length && !t.exclude.length) return true;
  const text = foldText(story.items.map((it) => `${it.title} \n ${it.summary}`).join(' \n '));
  if (t.exclude.some((m) => m(text))) return false;
  return !t.include.length || t.include.some((m) => m(text));
}

/** The stories that pass a tile's topics, in the deck's order. */
export function storiesAbout(stories: readonly Story[], topics: readonly string[] | string | undefined): Story[] {
  const t = parseTopics(topics);
  return t.include.length || t.exclude.length ? stories.filter((s) => storyMatches(s, t)) : [...stories];
}

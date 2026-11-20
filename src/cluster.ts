/**
 * Groups the same story told by several outlets.
 *
 * Not to drop duplicates (`dedupe` does that, by link) but to **measure
 * consensus**: five of six outlets leading with the same thing is a relevance
 * signal that comes from plain set theory, no model and no API. And as a
 * bonus, the same fact with two headlines from different editorial lines.
 *
 * Bags of terms with overlap, not prefixes: the same story almost never starts
 * the same way in two papers (measured on 634 real items: prefixes grouped 2,
 * bags 21, all correct). Thresholds are measured too: with a minimum bag of 3
 * a false positive joined four different stories sharing three names; with 5
 * it goes away.
 */
import type { NewsItem } from './feeds.ts';
import { foldHan } from './hanzi.ts';

/** Minimum overlap for two headlines to be the same story. */
export const SAME_STORY = 0.6;
/** Minimum terms in the bag for a headline to group others: the guard against short headlines. */
export const MIN_BAG = 5;
/**
 * Upper bound to show two versions side by side. It does NOT measure
 * editorial divergence (a low overlap means different vocabulary, not a
 * different angle); it only drops literal repetition, where the second column
 * would add nothing.
 */
export const CONTRAST_MAX = 0.8;

/** Spanish stop words. Short on purpose: each one removed raises every pair's overlap. */
const STOPWORDS = new Set([
  'para', 'como', 'pero', 'este', 'esta', 'esto', 'entre', 'sobre', 'desde',
  'hasta', 'tras', 'sus', 'han', 'del', 'las', 'los', 'que', 'con', 'por',
  'una', 'uno', 'ser', 'son', 'fue', 'sin', 'ante', 'cada', 'todo', 'toda',
  'otro', 'otra', 'hace', 'tiene', 'puede', 'dice', 'muy',
  'with', 'from', 'that', 'this', 'their', 'have', 'after', 'over', 'into', 'says',
]);

/** Han characters, kana and hangul: languages written without spaces between words. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const CJK_RUNS = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]+/g;
/** Thousands separators, which some outlets write and others don't (2,700 / 2700). */
const THOUSANDS = /(\d),(?=\d{3}(?!\d))/g;
const CJK_ALL = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

/**
 * Chinese pairs of characters that say nothing about which story it is:
 * dates (今天, 明年), reporting verbs (宣布, 表示, 指出) and the press's own
 * words (快讯, 独家). Written Simplified: the headline is folded first (see
 * `foldHan`). Short on purpose, like `STOPWORDS`.
 */
const CJK_STOPWORDS = new Set([
  '今天', '明天', '昨天', '今日', '明日', '昨日', '今年', '明年', '去年', '今晚', '日前', '近日', '本周', '上周', '下周',
  '宣布', '表示', '指出', '认为', '强调', '回应', '透露', '发布', '发表', '公布', '提出', '进行', '可能', '已经', '目前',
  '正式', '将于', '是否', '如何', '什么', '为何', '我们', '他们', '一个', '这个', '没有', '不是',
  '最新', '快讯', '独家', '重磅', '记者', '报导', '报道', '新闻', '影音', '视频', '图集',
]);

/** Whether a headline is written in Chinese, Japanese or Korean (it gets `titleTerms`' bigrams). */
export function isCjk(title: string): boolean {
  return CJK.test(title);
}

/**
 * Content terms of a headline. Latin words: no accents, no punctuation, no
 * stop words, longer than three letters. Chinese (and Japanese, Korean) has
 * no spaces to split words at, so its runs give overlapping pairs of
 * characters (bigrams), the usual way to compare such text without a
 * dictionary: 貨櫃碼頭 → 货柜, 柜码, 码头. Traditional characters are folded
 * to Simplified first, so Taiwan's and the mainland's versions compare
 * equal; bigrams that say nothing (`CJK_STOPWORDS`) go; and Latin words and
 * numbers count from two characters (AI, Q3, 0.3), which in a Chinese
 * headline are names and figures rather than connectors.
 */
export function titleTerms(title: string): string[] {
  const lower = title.toLowerCase();
  if (!CJK.test(lower)) return latinTerms(lower, false);
  const folded = foldHan(withoutLabels(lower)).replace(THOUSANDS, '$1');
  const out: string[] = [];
  for (const run of folded.match(CJK_RUNS) ?? []) {
    const chars = [...run];
    if (chars.length === 1) out.push(run);
    for (let i = 0; i + 1 < chars.length; i++) {
      const pair = chars[i]! + chars[i + 1]!;
      if (!CJK_STOPWORDS.has(pair)) out.push(pair);
    }
  }
  out.push(...latinTerms(folded.replace(CJK_ALL, ' '), true));
  return out;
}

/** Latin words of a headline; `inCjk`: inside a Chinese one, where short words and decimals (0.3) count. */
function latinTerms(lower: string, inCjk: boolean): string[] {
  const out: string[] = [];
  let text = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (inCjk) text = text.replace(/(\d)\.(?=\d)/g, '$1_');
  for (const w of text.replace(inCjk ? /[^a-z0-9_\s]/g : /[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (w.length >= (inCjk ? 2 : 4) && !STOPWORDS.has(w)) out.push(w.replace(/_/g, '.'));
  }
  return out;
}

/** Bag of content terms (see `titleTerms`). */
export function titleBag(title: string): Set<string> {
  return new Set(titleTerms(title));
}

/**
 * The headline reduced to what it says, for spotting the same headline
 * twice: no section label, letters and digits only, Traditional folded to
 * Simplified.
 */
export function compactTitle(title: string): string {
  return foldHan(withoutLabels(title).toLowerCase().normalize('NFC')).replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Overlap relative to the smaller bag (Szymkiewicz-Simpson), not Jaccard: a
 * terse headline and a long one about the same event have a low Jaccard only
 * because one has more words. This asks "is the short one contained in the
 * long one?", which is the relation between two versions of a story.
 */
export function overlap(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  if (min === 0) return 0;
  return sharedTerms(a, b) / min;
}

function sharedTerms(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared;
}

/**
 * A section label leading a Chinese headline: [國際], 【直播】, （影）, 快訊》,
 * 台股收盤／. Each outlet puts its own, so they're not part of the story.
 */
const CJK_LABEL = /^\s*(?:[[【〔（(][^\]】〕）)]{1,6}[\]】〕）)]|[^\s》／/｜|]{1,4}[》／/｜|])\s*/u;

/** The headline without its leading section labels (`CJK_LABEL`), if anything is left. */
export function withoutLabels(title: string): string {
  let t = title;
  for (let k = 0; k < 2; k += 1) {
    const m = CJK_LABEL.exec(t);
    if (!m || m[0].length >= t.length) break;
    t = t.slice(m[0].length);
  }
  return t;
}

/**
 * Tokens for aligning two Chinese headlines: each Han character alone, each
 * Latin word or number whole (CPI, 0.3), Traditional folded to Simplified.
 */
function cjkTokens(title: string): string[] {
  return foldHan(withoutLabels(title).toLowerCase()).replace(THOUSANDS, '$1').match(/[a-z0-9]+(?:\.[0-9]+)*|(?![a-z])\p{L}/gu) ?? [];
}

/**
 * The gaps left by aligning two token lists on their longest common
 * subsequence: what one side has where the other has something else (or
 * nothing). A headline is some 40 characters, so the table is small.
 */
function alignmentGaps(x: string[], y: string[]): { common: number; gaps: { a: string[]; b: string[]; start: boolean }[] } {
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const gaps: { a: string[]; b: string[]; start: boolean }[] = [];
  let ga: string[] = [];
  let gb: string[] = [];
  let i = 0;
  let j = 0;
  const close = () => {
    if (ga.length || gb.length) gaps.push({ a: ga, b: gb, start: i === ga.length && j === gb.length });
    ga = [];
    gb = [];
  };
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      close();
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ga.push(x[i++]!);
    else gb.push(y[j++]!);
  }
  ga.push(...x.slice(i));
  gb.push(...y.slice(j));
  close();
  return { common: lcs[0]![0]!, gaps };
}

/** Longest swapped slot (tokens: a Han character or a Latin word each) still taken for a name or a word, not a rewrite. */
const SLOT_MAX = 6;

/** A gap where each side has its own word, sharing nothing: 台北 / 新北, 大雨 / 低溫, CPI / PPI. */
const isSwap = (g: { a: string[]; b: string[] }, max: number) =>
  g.a.length > 0 && g.b.length > 0 && g.a.length <= max && g.b.length <= max && !g.a.some((t) => g.b.includes(t));

/**
 * Two Chinese headlines that are one sentence with a word or two swapped,
 * which makes them different stories however many bigrams they share:
 *
 * - **Template**: every difference is a swapped word: 台北/新北捷運票價明年調漲,
 *   中央氣象署發布大雨/低溫特報, 立法院三讀通過預算案/勞基法修正案. That's
 *   how one institution's announcements look alike, and the swapped word is
 *   the news. Two versions of one story instead add or drop words (再創 /
 *   創, 今天), or rewrite more than a word.
 * - **Subject**: they open with a different two- or three-character name
 *   and go on alike: 深圳/廣州地鐵…今日開通運營. Opening with a different
 *   word of one character or of four or more is common in rewrites (大讚 /
 *   賴清德讚, 總預算案今天三讀 / 立法院三讀), so only names are taken.
 *
 * Section labels ([國際], 快訊》) are left out first. A swapped word shares no
 * token with its counterpart (創 against 再創歷史 is an addition, not a swap).
 */
export function swappedSlots(a: string, b: string): boolean {
  const { common, gaps } = alignmentGaps(cjkTokens(a), cjkTokens(b));
  if (common < 4 || gaps.length === 0) return false;
  if (gaps.length <= 3 && gaps.every((g) => isSwap(g, SLOT_MAX))) return true;
  const first = gaps[0]!;
  return first.start && isSwap(first, 3) && first.a.length >= 2 && first.b.length >= 2;
}

/**
 * Minimum overlap for two Chinese headlines to be the same story. Lower than
 * `SAME_STORY`: bigrams break wherever the wording changes (北捷 / 台北捷運),
 * so two versions of a story share fewer of them than two Spanish versions
 * share words. Measured on ~700 headlines of 14 Taiwanese feeds and ~430 of
 * 12 mainland ones on one day: across outlets, the pairs at 0.40–0.50 were
 * still the same story, and below 0.40 different ones began (two vote-buying
 * cases in Taichung and Tainan, 0.38). Different stories above it are a
 * swapped word, which `swappedSlots` catches.
 */
export const SAME_STORY_CJK = 0.4;
/** Shared bigrams needed besides the ratio: 3 is what two unrelated headlines from one ministry share. */
export const CJK_MIN_SHARED = 4;

/** Whether two headlines (with their bags) tell the same story. */
export function sameStory(a: { title: string; bag: Set<string> }, b: { title: string; bag: Set<string> }, threshold = SAME_STORY): boolean {
  if (!isCjk(a.title) && !isCjk(b.title)) return overlap(a.bag, b.bag) >= threshold;
  return sharedTerms(a.bag, b.bag) >= CJK_MIN_SHARED && overlap(a.bag, b.bag) >= SAME_STORY_CJK && !swappedSlots(a.title, b.title);
}

export interface Story {
  /** The version painted: the most recent of the group. */
  lead: NewsItem;
  /** Every version, `lead` included. */
  items: NewsItem[];
  /** Distinct outlets carrying it. 1 = exclusive or little followed. */
  consensus: number;
}

/**
 * Single-pass clustering against the group's representative, not all its
 * members: with single linkage, A like B and B like C would put A and C
 * together even if they share nothing.
 */
export function clusterStories(items: NewsItem[], threshold = SAME_STORY, minBag = MIN_BAG): Story[] {
  const bags = items.map((it) => ({ it, title: it.title, bag: titleBag(it.title) }));
  const taken = new Array<boolean>(bags.length).fill(false);
  const out: Story[] = [];
  for (let i = 0; i < bags.length; i += 1) {
    if (taken[i]) continue;
    const head = bags[i]!;
    taken[i] = true;
    const group = [head.it];
    if (head.bag.size >= minBag) {
      for (let j = i + 1; j < bags.length; j += 1) {
        if (taken[j]) continue;
        const other = bags[j]!;
        if (other.bag.size < minBag) continue;
        // Two outlets, not two pieces of the same paper on the same topic:
        // chronicle, analysis and opinion of one paper is coverage, not consensus.
        if (other.it.source === head.it.source) continue;
        if (sameStory(head, other, threshold)) {
          group.push(other.it);
          taken[j] = true;
        }
      }
    }
    group.sort((a, b) => b.published - a.published);
    out.push({ lead: group[0]!, items: group, consensus: new Set(group.map((g) => g.source)).size });
  }
  return out;
}

/**
 * The outlet a source belongs to, without the topic label: "20minutos IA" is
 * a separate source for taking turns, but the same paper, and a paper
 * contrasted with itself contrasts nothing. Only the exact suffix is cut.
 */
export function publisherOf(source: string): string {
  return source.replace(/ (?:IA|AI)$/, '');
}

/**
 * Two versions of the same fact from different outlets, if there are: the
 * pair with the **lowest** overlap below `maxOverlap`. Null with one outlet,
 * or when they repeat the same sentence.
 */
export function contrastPair(story: Story, maxOverlap = CONTRAST_MAX): [NewsItem, NewsItem] | null {
  if (story.items.length < 2) return null;
  let best: { pair: [NewsItem, NewsItem]; score: number } | null = null;
  for (let i = 0; i < story.items.length; i += 1) {
    for (let j = i + 1; j < story.items.length; j += 1) {
      const a = story.items[i]!;
      const b = story.items[j]!;
      if (publisherOf(a.source) === publisherOf(b.source)) continue;
      const score = overlap(titleBag(a.title), titleBag(b.title));
      // Strict: at exactly 0.80 the headlines differ only in a connector.
      if (score >= maxOverlap) continue;
      if (!best || score < best.score) best = { pair: [a, b], score };
    }
  }
  return best?.pair ?? null;
}

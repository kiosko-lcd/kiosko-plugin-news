/**
 * Press headlines from RSS feeds, no keys and no AI.
 *
 * One shared source, `news/deck`, reads every feed every ten minutes, groups
 * the same story told by several outlets (consensus) and orders the deck.
 * The widgets pick their story from it by the wall clock (`storyAt`): slot
 * `floor(now / rotateMs) + offset`, so every repaint and every widget agree
 * without shared state. Photos are loaded in each widget's `fetch`, because
 * only `fetch` gets the canvas API to decode them; the source only has URLs.
 *
 * The deck and the photos are kept on disk (`cacheDir`, in RAM): a network outage
 * keeps the screen rotating over what's stored instead of going blank.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Weather } from '@loksly/weather-astro';
import { definePlugin, defineSource, defineWidget, filterPatterns, matchFilter, t, type FetchContext, type RenderContext } from '@kiosko/sdk';
import { publisherOf, type Story } from './cluster.ts';
import { AI_MAX_AGE_MS, AI_TITLE_FILTER, DEFAULT_FEEDS_BY_LANGUAGE, DEFAULT_MAX_AGE_MS, JUNK_TITLE_FILTER, defaultFeeds } from './defaults.ts';
import { demoCornerWeather, demoDeck } from './demo.ts';
import { fetchAllFeeds, type FeedSource } from './feeds.ts';
import { drawColumn, drawHeadline, drawWaiting, type Painter } from './frame.ts';
import { cacheImage, loadPhoto, photoFor, pruneImageCache } from './images.ts';
import { buildDeck, storyAt } from './pool.ts';

export interface NewsDeck {
  /** In showing order; consensus stories first (see `buildDeck`). */
  stories: Story[];
  /** When the feeds were last read successfully. */
  updated: number;
  /** Feeds that gave nothing usable in the last read. */
  failed: string[];
}

/** What a widget shows now: the story (by link) and its photo, if it loaded. */
export interface NewsShot {
  link: string;
  /** Photo URL already decoded by `loadPhoto`, a `demo:<scene>`, or null. */
  photo: string | null;
}

const DECK_FILE = 'deck.json';
/** A stored deck older than this isn't news any more. */
const DECK_MAX_AGE_MS = 24 * 3600_000;
/** Photos downloaded more than this long ago are removed (they live in RAM, not on disk). */
const IMAGE_MAX_AGE_HOURS = 12;

/** Photos and the deck are re-fetchable: they live in `cacheDir` (RAM), never on the SSD. */
const cacheOf = (ctx: { cacheDir: string; dataDir: string }) => ctx.cacheDir || ctx.dataDir;
const imageDir = (ctx: { cacheDir: string; dataDir: string }) => join(cacheOf(ctx), 'images');
/** Stories tried from the current slot onwards when a photo doesn't load. */
const PHOTO_TRIES = 4;

const feedItem = t.object({
  name: t.string({ label: { en: 'Name', es: 'Nombre', 'zh-Hant': '名稱', 'zh-Hans': '名称', de: 'Name' }, placeholder: 'El País', help: { en: 'Shown on screen. Ending in " IA" marks a topic feed of the same outlet.', es: 'Sale en pantalla. Acabar en « IA» marca un feed temático de la misma cabecera.', 'zh-Hant': '顯示在螢幕上。以「 IA」結尾表示同一家媒體的主題訂閱源。', 'zh-Hans': '显示在屏幕上。以“ IA”结尾表示同一家媒体的主题订阅源。', de: 'Wird auf dem Bildschirm angezeigt. Endet der Name auf „ KI“ (oder „ IA“, „ AI“), ist es ein Themen-Feed desselben Mediums.' } }),
  url: t.string({ format: 'url', risk: 'network', label: { en: 'RSS URL', es: 'URL del RSS', 'zh-Hant': 'RSS 網址', 'zh-Hans': 'RSS 网址', de: 'RSS-URL' } }),
  titleFilter: t.string({ advanced: true, label: { en: 'Headline filter (regex)', es: 'Filtro de titular (regex)', 'zh-Hant': '標題篩選（正規表示式）', 'zh-Hans': '标题过滤（正则）', de: 'Schlagzeilenfilter (Regex)' }, help: { en: 'Only headlines matching it stay.', es: 'Sólo quedan los titulares que casan.', 'zh-Hant': '只保留符合的標題。', 'zh-Hans': '只保留匹配的标题。', de: 'Nur passende Schlagzeilen bleiben.' } }),
  maxAgeMs: t.duration({ default: 0, max: 30 * 24 * 3_600_000, advanced: true, label: { en: 'Maximum age', es: 'Antigüedad máxima', 'zh-Hant': '最長時效', 'zh-Hans': '最长时效', de: 'Maximales Alter' }, help: { en: '0: the general one.', es: '0: la general.', 'zh-Hant': '0：使用整體設定。', 'zh-Hans': '0：使用总体设置。', de: '0: der allgemeine Wert.' } }),
});

export const deck = defineSource({
  id: 'deck',
  name: { en: 'News deck', es: 'Mazo de noticias', 'zh-Hant': '新聞牌組', 'zh-Hans': '新闻卡组', de: 'Nachrichtenstapel' },
  description: {
    en: 'Reads the RSS feeds, drops junk and stale items, groups the same story across outlets and orders what to show.',
    es: 'Lee los RSS, quita relleno y noticias viejas, agrupa la misma historia de varias cabeceras y ordena qué enseñar.',
    'zh-Hant': '讀取 RSS 訂閱源，剔除無用和過時的項目，把各家媒體的同一則新聞歸成一組，並排定顯示順序。',
    'zh-Hans': '读取 RSS 订阅源，剔除无用和过时的条目，把各家媒体的同一条新闻归为一组，并排定显示顺序。',
    de: 'Liest die RSS-Feeds, verwirft Füllstoff und veraltete Meldungen, fasst dieselbe Geschichte verschiedener Medien zusammen und legt fest, was gezeigt wird.',
  },
  options: t.object({
    feeds: t.list(feedItem, {
      // Empty, not a list: the outlets depend on the user's language, which a
      // static default can't know. `read` fills them in (`defaultFeeds`).
      default: [],
      label: { en: 'Feeds', es: 'Fuentes', 'zh-Hant': '訂閱源', 'zh-Hans': '订阅源', de: 'Feeds' },
      help: {
        en: 'Empty: well-known outlets in your language. Order matters: a repeated story keeps the label of the first feed.',
        es: 'Vacío: cabeceras conocidas en tu idioma. El orden importa: una noticia repetida se queda con la etiqueta de la primera fuente.',
        'zh-Hant': '留空：使用你的語言的知名媒體。順序很重要：重複的新聞會沿用第一個訂閱源的標籤。',
        'zh-Hans': '留空：使用你的语言的知名媒体。顺序很重要：重复的新闻会沿用第一个订阅源的标签。',
        de: 'Leer: bekannte Medien in deiner Sprache. Die Reihenfolge zählt: Eine doppelte Meldung behält die Bezeichnung des ersten Feeds.',
      },
    }),
    topic: t.enum(['all', 'ai'], { label: { en: 'Topic', es: 'Tema', 'zh-Hant': '主題', 'zh-Hans': '主题', de: 'Thema' }, labels: { all: { en: 'Everything', es: 'Todo', 'zh-Hant': '全部', 'zh-Hans': '全部', de: 'Alles' }, ai: { en: 'Only AI', es: 'Sólo IA', 'zh-Hant': '只看 AI', 'zh-Hans': '只看 AI', de: 'Nur KI' } } }),
    maxAgeMs: t.duration({ default: DEFAULT_MAX_AGE_MS, max: 30 * 24 * 3_600_000, label: { en: 'Maximum age', es: 'Antigüedad máxima', 'zh-Hant': '最長時效', 'zh-Hans': '最长时效', de: 'Maximales Alter' }, help: { en: '0: no limit (undated items then pass too).', es: '0: sin límite (pasan también las que no traen fecha).', 'zh-Hant': '0：不限（沒有日期的項目也會通過）。', 'zh-Hans': '0：不限（没有日期的条目也会通过）。', de: '0: unbegrenzt (dann kommen auch Meldungen ohne Datum durch).' } }),
    rejectFilter: t.string({ default: JUNK_TITLE_FILTER, advanced: true, multiline: true, label: { en: 'Discard headlines (regex)', es: 'Descartar titulares (regex)', 'zh-Hant': '排除標題（正規表示式）', 'zh-Hans': '排除标题（正则）', de: 'Schlagzeilen verwerfen (Regex)' }, help: { en: 'Case-insensitive. Empty: keep everything.', es: 'Sin distinguir mayúsculas. Vacío: no se descarta nada.', 'zh-Hant': '不分大小寫。留空：全部保留。', 'zh-Hans': '不区分大小写。留空：全部保留。', de: 'Groß-/Kleinschreibung egal. Leer: nichts wird verworfen.' } }),
    maxStories: t.integer({ min: 5, max: 200, default: 60, advanced: true, label: { en: 'Stories in the deck', es: 'Historias en el mazo', 'zh-Hant': '牌組中的新聞數', 'zh-Hans': '卡组中的新闻数', de: 'Meldungen im Stapel' } }),
  }),
  intervalMs: 10 * 60_000,
  // A dozen outlets per read: more often than every two minutes is only noise for them.
  minIntervalMs: 2 * 60_000,
  // Feeds are read at once, each with 60 % of this, so one slow outlet fails alone instead of the whole read.
  timeoutMs: 25_000,
  async read(ctx): Promise<NewsDeck> {
    const o = ctx.options;
    const ai = o.topic === 'ai';
    // The user's own list as it is; with none, the outlets of their language.
    const chosen = o.feeds.filter((f) => f.url.trim());
    const own = chosen.length
      ? chosen
      : defaultFeeds(ctx.pickLanguage(Object.keys(DEFAULT_FEEDS_BY_LANGUAGE))).map((f) => ({ name: f.name, url: f.url, titleFilter: f.titleFilter ?? '', maxAgeMs: f.maxAgeMs ?? 0 }));
    const feeds: FeedSource[] = own
      .map((f) => ({
        name: f.name.trim() || new URL(f.url).hostname,
        url: f.url.trim(),
        titleFilter: (ai ? AI_TITLE_FILTER : f.titleFilter.trim()) || undefined,
        maxAgeMs: f.maxAgeMs || (ai ? AI_MAX_AGE_MS : undefined),
      }));
    const file = join(cacheOf(ctx), DECK_FILE);
    pruneImageCache(imageDir(ctx), IMAGE_MAX_AGE_HOURS, ctx.now);
    const timeoutMs = Math.max(1000, Math.round(ctx.timeoutMs * 0.6));
    const harvest = await fetchAllFeeds(feeds, { timeoutMs, log: ctx.log, rejectFilter: o.rejectFilter.trim(), maxAgeMs: o.maxAgeMs, now: ctx.now, signal: ctx.signal });
    if (harvest.items.length) {
      const fresh: NewsDeck = { stories: buildDeck(harvest.items, o.maxStories), updated: ctx.now, failed: harvest.failed };
      saveDeck(file, fresh, ctx.log);
      return fresh;
    }
    // Nothing came in: keep rotating over the last good deck while it's recent.
    const last = loadDeck(file, ctx.now);
    if (last) return { ...last, failed: harvest.failed };
    throw new Error(`no usable news from ${feeds.length} feeds (${harvest.failed.join(', ') || 'none configured'})`);
  },
  demo: ({ now, locale }) => demoDeck(now, locale),
  // The feeds that gave stories, for the widgets' outlets filter.
  choices: {
    outlets: (d) => [...new Set(d.stories.flatMap((s) => s.items.map((it) => it.source)))].sort((a, b) => a.localeCompare(b)).map((value) => ({ value })),
  },
});

function saveDeck(file: string, d: NewsDeck, log: (m: string) => void): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(d));
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    log(`could not keep the deck: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadDeck(file: string, now: number): NewsDeck | null {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as NewsDeck;
    return Array.isArray(d.stories) && d.stories.length && now - d.updated < DECK_MAX_AGE_MS ? d : null;
  } catch {
    return null;
  }
}

/* ---------- widgets ---------- */

const shared = {
  rotateMs: t.duration({ min: 10_000, max: 3600_000, default: 30_000, label: { en: 'Each story for', es: 'Cada noticia durante', 'zh-Hant': '每則新聞顯示', 'zh-Hans': '每条新闻显示', de: 'Jede Meldung für' } }),
  outlets: t.filter({
    choices: { source: 'news/deck', list: 'outlets' },
    label: { en: 'Outlets', es: 'Cabeceras', 'zh-Hant': '媒體', 'zh-Hans': '媒体', de: 'Medien' },
    help: {
      en: 'Empty: all. Feed names as in the news source (El País, Xataka IA…), comma-separated; * matches anything, a leading ! leaves out. A story carried by several shows the version of one of these.',
      es: 'Vacío: todas. Nombres de fuente como en el mazo de noticias (El País, Xataka IA…), separados por comas; * vale por cualquier cosa y un ! delante excluye. De una historia de varias se ve la versión de una de estas.',
      'zh-Hant': '留空：全部。填入新聞來源中的訂閱源名稱（El País、Xataka IA…），以逗號分隔；* 可比對任何內容，開頭加 ! 表示排除。多家媒體報導的新聞會顯示其中一家的版本。',
      'zh-Hans': '留空：全部。填写新闻数据源中的订阅源名称（El País、Xataka IA…），用逗号分隔；* 匹配任意内容，开头加 ! 表示排除。多家媒体报道的新闻会显示其中一家的版本。',
      de: 'Leer: alle. Feed-Namen wie in der Nachrichten-Datenquelle (tagesschau, heise KI…), durch Kommas getrennt; * steht für beliebigen Text, ein vorangestelltes ! schließt aus. Von einer Meldung mehrerer Medien wird die Fassung eines dieser Medien gezeigt.',
    },
  }),
  showStandfirst: t.boolean({ default: true, label: { en: 'Standfirst', es: 'Entradilla', 'zh-Hant': '導言', 'zh-Hans': '导语', de: 'Vorspann' }, help: { en: 'The summary under the headline. Off: the headline alone, with room for longer ones.', es: 'El resumen bajo el titular. Apagado: el titular solo, con sitio para los largos.', 'zh-Hant': '標題下方的摘要。關閉：只顯示標題，可容納較長的標題。', 'zh-Hans': '标题下方的摘要。关闭：只显示标题，可容纳较长的标题。', de: 'Die Zusammenfassung unter der Schlagzeile. Aus: nur die Schlagzeile, mit Platz für längere.' } }),
};
const DEMO_PHOTO = 'demo:';

const deckOf = (sources: Record<string, unknown>) => sources['news/deck'] as NewsDeck | undefined;

/**
 * The stories of the outlets a widget shows (all with an empty filter). A
 * story several outlets carry stays if one of them passes, led by that
 * outlet's version; its consensus still counts every outlet. Matched by the
 * feed name and by the paper's ("Xataka IA" is also "Xataka").
 */
export function storiesFor(stories: readonly Story[], outlets: readonly string[]): Story[] {
  if (!filterPatterns(outlets).length) return [...stories];
  const out: Story[] = [];
  for (const s of stories) {
    const items = s.items.filter((it) => matchFilter([it.source, publisherOf(it.source)], outlets));
    if (!items.length) continue;
    out.push(items.length === s.items.length ? s : { ...s, lead: items[0]!, items });
  }
  return out;
}

const storiesOf = (sources: Record<string, unknown>, o: { outlets: string[] }): Story[] => storiesFor(deckOf(sources)?.stories ?? [], o.outlets);

/**
 * The story for this slot and its photo. If the photo doesn't load, the next
 * stories are tried (up to `PHOTO_TRIES`): a frame without its photo looks
 * worse than skipping a story. Also warms the cache with the next slot's
 * photo, so the turn is instant.
 */
async function pickShot(ctx: FetchContext<{ rotateMs: number; offset: number; outlets: string[] }>): Promise<NewsShot | undefined> {
  const stories = storiesOf(ctx.sources, ctx.options);
  if (!stories.length) return undefined;
  const dir = imageDir(ctx);
  const io = { canvas: ctx.canvas, timeoutMs: 15_000, signal: ctx.signal, log: ctx.log };
  let first: Story | undefined;
  for (let i = 0; i < Math.min(PHOTO_TRIES, stories.length); i++) {
    const story = storyAt(stories, ctx.now, ctx.options.rotateMs, ctx.options.offset + i)!;
    first ??= story;
    const url = story.lead.image;
    if (!url) continue;
    if (url.startsWith(DEMO_PHOTO) || (await loadPhoto(dir, url, io))) {
      const next = storyAt(stories, ctx.now, ctx.options.rotateMs, ctx.options.offset + i + 1)?.lead.image;
      if (next && !next.startsWith(DEMO_PHOTO)) void cacheImage(dir, next, io.timeoutMs, ctx.signal).catch(() => {});
      return { link: story.lead.link, photo: url };
    }
  }
  return { link: first!.lead.link, photo: null };
}

/** The story to paint: the one `fetch` chose, or the slot's own until the first fetch. */
function current(ctx: { options: { rotateMs: number; offset: number; outlets: string[] }; data: NewsShot | undefined; sources: Record<string, unknown>; now: number }): { story: Story; photo: string | null } | null {
  const stories = storiesOf(ctx.sources, ctx.options);
  if (!stories.length) return null;
  const chosen = ctx.data ? stories.find((s) => s.lead.link === ctx.data!.link) : undefined;
  if (chosen) return { story: chosen, photo: ctx.data!.photo };
  return { story: storyAt(stories, ctx.now, ctx.options.rotateMs, ctx.options.offset)!, photo: null };
}

function painter(ctx: RenderContext<unknown, unknown>, g: Parameters<typeof drawHeadline>[0]['g']): Painter {
  return { g, kit: ctx.kit, fonts: ctx.theme.fonts, t: ctx.t, plural: ctx.plural, fmt: ctx.fmt, now: ctx.now };
}

const demoOf = (url: string | null) => (url?.startsWith(DEMO_PHOTO) ? url.slice(DEMO_PHOTO.length) : null);

function demoShot(o: { rotateMs: number; offset: number; outlets: string[] }, now: number, locale = 'en') {
  const d = demoDeck(now, locale);
  const s = storyAt(storiesFor(d.stories, o.outlets ?? []), now, o.rotateMs, o.offset) ?? d.stories[0]!;
  return { data: { link: s.lead.link, photo: s.lead.image }, sources: { 'news/deck': d, 'weather/current': demoCornerWeather(now, locale) } };
}

export const headline = defineWidget({
  id: 'headline',
  name: { en: 'Headline', es: 'Titular', 'zh-Hant': '頭條', 'zh-Hans': '头条', de: 'Schlagzeile' },
  description: {
    en: 'One story at a time over its photo, full-bleed: outlet, age, how many outlets carry it, headline and standfirst. With two versions of the same fact side by side when outlets tell it differently.',
    es: 'Una noticia cada vez sobre su foto a sangre: cabecera, antigüedad, cuántas cabeceras la llevan, titular y entradilla. Con dos versiones del mismo hecho lado a lado cuando las cabeceras lo cuentan distinto.',
    'zh-Hant': '一次一則新聞，滿版疊在照片上：媒體、時間、幾家媒體報導、標題與導言。各家媒體說法不同時，會並排顯示同一件事的兩個版本。',
    'zh-Hans': '一次一条新闻，满版叠加在照片上：媒体、时间、几家媒体报道、标题和导语。各家媒体说法不同时，会并排显示同一件事的两个版本。',
    de: 'Eine Meldung nach der anderen, randlos über ihrem Foto: Medium, Alter, wie viele Medien sie bringen, Schlagzeile und Vorspann. Erzählen die Medien dasselbe unterschiedlich, stehen zwei Fassungen nebeneinander.',
  },
  icon: 'newspaper',
  category: 'info',
  tags: ['news', 'noticias', 'rss', 'press', 'prensa', 'nachrichten', 'presse'],
  chrome: 'bare',
  size: { min: { w: 480, h: 200 }, preferred: { w: 1920, h: 462 } },
  options: t.object({
    ...shared,
    offset: t.integer({ min: 0, max: 50, default: 0, advanced: true, label: { en: 'Skip stories', es: 'Saltar noticias', 'zh-Hant': '略過新聞', 'zh-Hans': '跳过新闻', de: 'Meldungen überspringen' }, help: { en: 'So two news widgets on one screen don\'t show the same story.', es: 'Para que dos widgets de noticias en una pantalla no enseñen la misma.', 'zh-Hant': '讓同一螢幕上的兩個新聞小工具不會顯示同一則新聞。', 'zh-Hans': '让同一屏幕上的两个新闻小组件不会显示同一条新闻。', de: 'Damit zwei Nachrichten-Widgets auf einem Bildschirm nicht dieselbe Meldung zeigen.' } }),
    showContrast: t.boolean({ default: true, label: { en: 'Two versions side by side', es: 'Dos versiones lado a lado', 'zh-Hant': '兩個版本並排', 'zh-Hans': '两个版本并排', de: 'Zwei Fassungen nebeneinander' }, help: { en: 'On wide tiles, when two outlets tell the same fact differently.', es: 'En teselas anchas, cuando dos cabeceras cuentan el mismo hecho de forma distinta.', 'zh-Hant': '用於寬方格，當兩家媒體對同一件事說法不同時。', 'zh-Hans': '用于宽格子，当两家媒体对同一件事说法不同时。', de: 'Auf breiten Kacheln, wenn zwei Medien dasselbe unterschiedlich erzählen.' } }),
    showCorner: t.boolean({ default: true, label: { en: 'Clock and weather', es: 'Reloj y tiempo', 'zh-Hant': '時鐘與天氣', 'zh-Hans': '时钟和天气', de: 'Uhr und Wetter' } }),
  }),
  sources: ['news/deck', 'weather/current'],
  fetch: pickShot,
  intervalMs: 15_000,
  redraw: 'minute',
  visible: ({ sources, options }) => storiesOf(sources, options).length > 0,
  render(g, ctx) {
    const p = painter(ctx, g);
    const now = current(ctx);
    if (!now) return drawWaiting(p, ctx.box);
    const weather = ctx.sources['weather/current'] as Weather | undefined;
    const o = ctx.options;
    drawHeadline(p, now.story, photoFor(now.photo), demoOf(now.photo), ctx.box, weather, { contrast: o.showContrast, corner: o.showCorner, standfirst: o.showStandfirst });
  },
  demo: ({ options, now, locale }) => demoShot(options, now, locale),
});

export const column = defineWidget({
  id: 'column',
  name: { en: 'News column', es: 'Columna de noticias', 'zh-Hant': '新聞直欄', 'zh-Hans': '新闻竖栏', de: 'Nachrichtenspalte' },
  description: {
    en: 'The current story in a column for a shared screen: photo with rounded corners, clock and temperature on top, headline and standfirst below.',
    es: 'La noticia del momento en una columna para una pantalla compartida: foto con esquinas redondeadas, reloj y temperatura arriba, titular y entradilla abajo.',
    'zh-Hant': '在共用螢幕上以直欄顯示目前的新聞：圓角照片，上方是時鐘與溫度，下方是標題與導言。',
    'zh-Hans': '在共享屏幕上以竖栏显示当前新闻：圆角照片，上方是时钟和温度，下方是标题和导语。',
    de: 'Die aktuelle Meldung als Spalte für einen geteilten Bildschirm: Foto mit runden Ecken, oben Uhr und Temperatur, unten Schlagzeile und Vorspann.',
  },
  icon: 'newspaper',
  category: 'info',
  tags: ['news', 'noticias', 'rss', 'nachrichten'],
  chrome: 'bare',
  size: { min: { w: 240, h: 240 }, preferred: { w: 600, h: 462 } },
  options: t.object({
    ...shared,
    offset: t.integer({ min: 0, max: 50, default: 1, advanced: true, label: { en: 'Skip stories', es: 'Saltar noticias', 'zh-Hant': '略過新聞', 'zh-Hans': '跳过新闻', de: 'Meldungen überspringen' }, help: { en: 'So it doesn\'t repeat the story of a headline widget on the same screen.', es: 'Para no repetir la noticia de un titular en la misma pantalla.', 'zh-Hant': '避免重複同一螢幕上頭條小工具的新聞。', 'zh-Hans': '避免重复同一屏幕上头条小组件的新闻。', de: 'Damit es nicht die Meldung eines Schlagzeilen-Widgets auf demselben Bildschirm wiederholt.' } }),
    showCorner: t.boolean({ default: true, label: { en: 'Clock and temperature', es: 'Reloj y temperatura', 'zh-Hant': '時鐘與溫度', 'zh-Hans': '时钟和温度', de: 'Uhr und Temperatur' } }),
  }),
  sources: ['news/deck', 'weather/current'],
  fetch: pickShot,
  intervalMs: 15_000,
  redraw: 'minute',
  visible: ({ sources, options }) => storiesOf(sources, options).length > 0,
  render(g, ctx) {
    const p = painter(ctx, g);
    const now = current(ctx);
    if (!now) return drawWaiting(p, ctx.box);
    const weather = ctx.sources['weather/current'] as Weather | undefined;
    drawColumn(p, now.story, photoFor(now.photo), demoOf(now.photo), ctx.box, ctx.theme.radius, weather, { corner: ctx.options.showCorner, standfirst: ctx.options.showStandfirst });
  },
  demo: ({ options, now, locale }) => demoShot(options, now, locale),
});

export default definePlugin({
  id: 'news',
  name: { en: 'News', es: 'Noticias', 'zh-Hant': '新聞', 'zh-Hans': '新闻', de: 'Nachrichten' },
  version: '0.2.4',
  languages: ['en', 'es', 'zh-Hant', 'zh-Hans', 'de'],
  sdk: '^0.2.0',
  permissions: { network: ['user'] },
  optional: ['weather/current'],
  description: {
    en: 'Press headlines from RSS feeds with their photos. No keys and no AI: consensus across outlets measured with plain set overlap.',
    es: 'Titulares de prensa de los RSS con su foto. Sin claves ni IA: el consenso entre cabeceras se mide con solapamiento de términos.',
    'zh-Hant': '來自 RSS 訂閱源的新聞標題與照片。不需金鑰也不用 AI：各家媒體間的共識以簡單的詞彙重疊來衡量。',
    'zh-Hans': '来自 RSS 订阅源的新闻标题和照片。无需密钥也不用 AI：各家媒体之间的共识用简单的词汇重叠来衡量。',
    de: 'Schlagzeilen aus RSS-Feeds mit ihren Fotos. Ohne Schlüssel und ohne KI: Der Konsens zwischen Medien wird über einfache Wortüberschneidung gemessen.',
  },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'newspaper',
  sources: [deck],
  widgets: [headline, column],
  templates: [
    {
      id: 'news',
      name: { en: 'News and weather', es: 'Noticias y tiempo', 'zh-Hant': '新聞與天氣', 'zh-Hans': '新闻和天气', de: 'Nachrichten und Wetter' },
      icon: 'newspaper',
      wide: [
        { x: 0, y: 0, w: 3 / 5, h: 1, widgets: ['headline'], chrome: 'bare' },
        { x: 3 / 5, y: 0, w: 2 / 5, h: 1 / 2, widgets: ['weather/forecast'] },
        { x: 3 / 5, y: 1 / 2, w: 1 / 5, h: 1 / 2, widgets: [['core/clock', {showDate: true}]], chrome: 'bare' },
        { x: 4 / 5, y: 1 / 2, w: 1 / 5, h: 1 / 2, widgets: ['mirror/rainmap', 'mirror/earthquakes'] },
      ],
      square: [
        { x: 0, y: 0, w: 1, h: 0.65, widgets: ['column'], chrome: 'bare' },
        { x: 0, y: 0.65, w: 1, h: 0.35, widgets: ['weather/forecast'] },
      ],
      tall: [
        { x: 0, y: 0, w: 1, h: 11 / 24, widgets: ['headline'], chrome: 'bare' },
        { x: 0, y: 11 / 24, w: 1, h: 5 / 24, widgets: ['weather/forecast'] },
        { x: 0, y: 2 / 3, w: 1, h: 1 / 8, widgets: [['core/clock', {showDate: true}]], chrome: 'bare' },
        { x: 0, y: 19 / 24, w: 1, h: 5 / 24, widgets: ['mirror/rainmap', 'mirror/earthquakes'] },
      ],
    },
  ],
});

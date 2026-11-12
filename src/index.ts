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
import { AI_MAX_AGE_MS, AI_TITLE_FILTER, DEFAULT_FEEDS, DEFAULT_MAX_AGE_MS, JUNK_TITLE_FILTER } from './defaults.ts';
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
  name: t.string({ label: { en: 'Name', es: 'Nombre' }, placeholder: 'El País', help: { en: 'Shown on screen. Ending in " IA" marks a topic feed of the same outlet.', es: 'Sale en pantalla. Acabar en « IA» marca un feed temático de la misma cabecera.' } }),
  url: t.string({ format: 'url', risk: 'network', label: { en: 'RSS URL', es: 'URL del RSS' } }),
  titleFilter: t.string({ advanced: true, label: { en: 'Headline filter (regex)', es: 'Filtro de titular (regex)' }, help: { en: 'Only headlines matching it stay.', es: 'Sólo quedan los titulares que casan.' } }),
  maxAgeMs: t.duration({ default: 0, max: 30 * 24 * 3_600_000, advanced: true, label: { en: 'Maximum age', es: 'Antigüedad máxima' }, help: { en: '0: the general one.', es: '0: la general.' } }),
});

export const deck = defineSource({
  id: 'deck',
  name: { en: 'News deck', es: 'Mazo de noticias' },
  description: {
    en: 'Reads the RSS feeds, drops junk and stale items, groups the same story across outlets and orders what to show.',
    es: 'Lee los RSS, quita relleno y noticias viejas, agrupa la misma historia de varias cabeceras y ordena qué enseñar.',
  },
  options: t.object({
    feeds: t.list(feedItem, {
      default: DEFAULT_FEEDS.map((f) => ({ name: f.name, url: f.url, titleFilter: f.titleFilter ?? '', maxAgeMs: f.maxAgeMs ?? 0 })),
      label: { en: 'Feeds', es: 'Fuentes' },
      help: { en: 'Order matters: a repeated story keeps the label of the first feed.', es: 'El orden importa: una noticia repetida se queda con la etiqueta de la primera fuente.' },
    }),
    topic: t.enum(['all', 'ai'], { label: { en: 'Topic', es: 'Tema' }, labels: { all: { en: 'Everything', es: 'Todo' }, ai: { en: 'Only AI', es: 'Sólo IA' } } }),
    maxAgeMs: t.duration({ default: DEFAULT_MAX_AGE_MS, max: 30 * 24 * 3_600_000, label: { en: 'Maximum age', es: 'Antigüedad máxima' }, help: { en: '0: no limit (undated items then pass too).', es: '0: sin límite (pasan también las que no traen fecha).' } }),
    rejectFilter: t.string({ default: JUNK_TITLE_FILTER, advanced: true, multiline: true, label: { en: 'Discard headlines (regex)', es: 'Descartar titulares (regex)' }, help: { en: 'Case-insensitive. Empty: keep everything.', es: 'Sin distinguir mayúsculas. Vacío: no se descarta nada.' } }),
    maxStories: t.integer({ min: 5, max: 200, default: 60, advanced: true, label: { en: 'Stories in the deck', es: 'Historias en el mazo' } }),
  }),
  intervalMs: 10 * 60_000,
  // A dozen outlets per read: more often than every two minutes is only noise for them.
  minIntervalMs: 2 * 60_000,
  // Feeds are read at once, each with 60 % of this, so one slow outlet fails alone instead of the whole read.
  timeoutMs: 25_000,
  async read(ctx): Promise<NewsDeck> {
    const o = ctx.options;
    const ai = o.topic === 'ai';
    const feeds: FeedSource[] = o.feeds
      .filter((f) => f.url.trim())
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
  rotateMs: t.duration({ min: 10_000, max: 3600_000, default: 30_000, label: { en: 'Each story for', es: 'Cada noticia durante' } }),
  outlets: t.filter({
    label: { en: 'Outlets', es: 'Cabeceras' },
    help: {
      en: 'Empty: all. Feed names as in the news source (El País, Xataka IA…), comma-separated; * matches anything, a leading ! leaves out. A story carried by several shows the version of one of these.',
      es: 'Vacío: todas. Nombres de fuente como en el mazo de noticias (El País, Xataka IA…), separados por comas; * vale por cualquier cosa y un ! delante excluye. De una historia de varias se ve la versión de una de estas.',
    },
  }),
  showStandfirst: t.boolean({ default: true, label: { en: 'Standfirst', es: 'Entradilla' }, help: { en: 'The summary under the headline. Off: the headline alone, with room for longer ones.', es: 'El resumen bajo el titular. Apagado: el titular solo, con sitio para los largos.' } }),
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
  return { g, kit: ctx.kit, fonts: ctx.theme.fonts, t: ctx.t, fmt: ctx.fmt, now: ctx.now };
}

const demoOf = (url: string | null) => (url?.startsWith(DEMO_PHOTO) ? url.slice(DEMO_PHOTO.length) : null);

function demoShot(o: { rotateMs: number; offset: number; outlets: string[] }, now: number, locale = 'es') {
  const d = demoDeck(now, locale);
  const s = storyAt(storiesFor(d.stories, o.outlets ?? []), now, o.rotateMs, o.offset) ?? d.stories[0]!;
  return { data: { link: s.lead.link, photo: s.lead.image }, sources: { 'news/deck': d, 'weather/current': demoCornerWeather(now) } };
}

export const headline = defineWidget({
  id: 'headline',
  name: { en: 'Headline', es: 'Titular' },
  description: {
    en: 'One story at a time over its photo, full-bleed: outlet, age, how many outlets carry it, headline and standfirst. With two versions of the same fact side by side when outlets tell it differently.',
    es: 'Una noticia cada vez sobre su foto a sangre: cabecera, antigüedad, cuántas cabeceras la llevan, titular y entradilla. Con dos versiones del mismo hecho lado a lado cuando las cabeceras lo cuentan distinto.',
  },
  icon: 'newspaper',
  category: 'info',
  tags: ['news', 'noticias', 'rss', 'press', 'prensa'],
  chrome: 'bare',
  size: { min: { w: 480, h: 200 }, preferred: { w: 1920, h: 462 } },
  options: t.object({
    ...shared,
    offset: t.integer({ min: 0, max: 50, default: 0, advanced: true, label: { en: 'Skip stories', es: 'Saltar noticias' }, help: { en: 'So two news widgets on one screen don\'t show the same story.', es: 'Para que dos widgets de noticias en una pantalla no enseñen la misma.' } }),
    showContrast: t.boolean({ default: true, label: { en: 'Two versions side by side', es: 'Dos versiones lado a lado' }, help: { en: 'On wide tiles, when two outlets tell the same fact differently.', es: 'En teselas anchas, cuando dos cabeceras cuentan el mismo hecho de forma distinta.' } }),
    showCorner: t.boolean({ default: true, label: { en: 'Clock and weather', es: 'Reloj y tiempo' } }),
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
  name: { en: 'News column', es: 'Columna de noticias' },
  description: {
    en: 'The current story in a column for a shared screen: photo with rounded corners, clock and temperature on top, headline and standfirst below.',
    es: 'La noticia del momento en una columna para una pantalla compartida: foto con esquinas redondeadas, reloj y temperatura arriba, titular y entradilla abajo.',
  },
  icon: 'newspaper',
  category: 'info',
  tags: ['news', 'noticias', 'rss'],
  chrome: 'bare',
  size: { min: { w: 240, h: 240 }, preferred: { w: 600, h: 462 } },
  options: t.object({
    ...shared,
    offset: t.integer({ min: 0, max: 50, default: 1, advanced: true, label: { en: 'Skip stories', es: 'Saltar noticias' }, help: { en: 'So it doesn\'t repeat the story of a headline widget on the same screen.', es: 'Para no repetir la noticia de un titular en la misma pantalla.' } }),
    showCorner: t.boolean({ default: true, label: { en: 'Clock and temperature', es: 'Reloj y temperatura' } }),
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
  name: { en: 'News', es: 'Noticias' },
  version: '0.2.1',
  description: {
    en: 'Press headlines from RSS feeds with their photos. No keys and no AI: consensus across outlets measured with plain set overlap.',
    es: 'Titulares de prensa de los RSS con su foto. Sin claves ni IA: el consenso entre cabeceras se mide con solapamiento de términos.',
  },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'newspaper',
  sources: [deck],
  widgets: [headline, column],
});

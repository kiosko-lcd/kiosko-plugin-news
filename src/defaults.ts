/**
 * Default feeds and headline filters, from aimonitor's news panel. Every rule
 * here was measured against the real feeds; the notes say why it is the way it
 * is, so nobody "simplifies" it back into a known bug.
 */
import type { FeedSource } from './feeds.ts';

/**
 * AI headlines. There's no Spanish AI feed with a photo per article, so the
 * topic is taken from general technology feeds with this regex: zero AI to
 * talk about AI. Two groups: brands and products (unambiguous) and generic
 * terms (`IA`, `LLM`…), case-sensitive so `IA` doesn't match inside words.
 * Chinese terms go outside the `\b…\b` group: `\b` only sees ASCII word
 * characters, so it never matches between two Han characters (人工智慧).
 * Latin names inside a Chinese headline still do (AI晶片, 推出Gemini).
 */
export const AI_TITLE_FILTER =
  '\\b(?:[Aa]nthropic|[Cc]laude|[Cc]hat[Gg]PT|[Oo]pen[Aa][Ii]|[Gg]emini|[Dd]eep[Mm]ind|' +
  '[Cc]opilot|[Mm]idjourney|[Dd]eep[Ss]eek|[Mm]istral [Aa][Ii]|[Pp]erplexity|[Ll]lama \\d|[Gg]rok|' +
  '[Qq]wen|[Kk]imi|inteligencia artificial|IA|IAs|AI|AGI|AIGC|LLMs?|chatbots?|modelo de lenguaje|language model|red neuronal|neural network|superinteligencia)\\b' +
  // Chinese: Taiwan's words, then the mainland's.
  '|人工智慧|人工智能|大模型|語言模型|语言模型|生成式|機器學習|机器学习|深度學習|深度学习|神經網路|神经网络|聊天機器人|聊天机器人' +
  '|智能體|智能体|超級智慧|超级智能|通義|通义|千問|千问|文心一言|豆包|智譜|智谱|月之暗面|混元大模型';

const HOUR = 3_600_000;

/**
 * Maximum age of AI items. Technology feeds aren't chronological
 * like a front page: they mix this morning with features from months ago, and
 * matching the topic without a date limit filled the screen with stale AI.
 * 36 h is the measured balance: less starves weekends, more lets last week in.
 */
export const AI_MAX_AGE_MS = 36 * HOUR;

/** General maximum age: a safety net so a frozen outlet doesn't keep showing the day before yesterday. */
export const DEFAULT_MAX_AGE_MS = 72 * HOUR;

const ai = (name: string, url: string): FeedSource => ({ name, url, titleFilter: AI_TITLE_FILTER, maxAgeMs: AI_MAX_AGE_MS });

/**
 * The feeds used while the user hasn't chosen any, one list per language
 * (`ctx.pickLanguage(Object.keys(DEFAULT_FEEDS_BY_LANGUAGE))`), so a reader
 * in Taipei doesn't get Spanish papers. Only outlets whose feed carries a
 * photo per item: the widgets paint the photo, and an item without one is
 * dropped (Taiwan's CNA, PTS, LTN, iThome and TechNews, and mainland
 * 少数派 or 中新网, have none in their RSS). Checked by hand on 2026-11-20.
 *
 * Order matters: `dedupe` keeps the **first** appearance of an article, and
 * with it its source label, which is the key for taking turns. Topic feeds go
 * first, or their AI items would compete in the general front page's queue.
 * Topic feeds are named "<Outlet> IA" / "<Outlet> AI" (see `publisherOf`).
 */
export const DEFAULT_FEEDS_BY_LANGUAGE: Record<string, FeedSource[]> = {
  es: [
    ai('Xataka IA', 'https://feeds.weblogssl.com/xataka2'),
    ai('Hipertextual IA', 'https://hipertextual.com/feed'),
    ai('20minutos IA', 'https://www.20minutos.es/rss/tecnologia/'),
    ai('Omicrono IA', 'https://www.elespanol.com/rss/omicrono/'),
    { name: 'elDiario.es', url: 'https://www.eldiario.es/rss/' },
    { name: '20minutos', url: 'https://www.20minutos.es/rss/' },
    { name: 'El País', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada' },
    { name: 'La Vanguardia', url: 'https://www.lavanguardia.com/rss/home.xml' },
    { name: 'El Mundo', url: 'https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml' },
    { name: 'ABC', url: 'https://www.abc.es/rss/2.0/portada/' },
  ],
  en: [
    ai('The Verge AI', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'),
    ai('Ars Technica AI', 'https://feeds.arstechnica.com/arstechnica/index'),
    ai('The Guardian AI', 'https://www.theguardian.com/technology/rss'),
    ai('Wired AI', 'https://www.wired.com/feed/tag/ai/latest/rss'),
    { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
    { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' },
    { name: 'ABC News', url: 'https://abcnews.go.com/abcnews/internationalheadlines' },
  ],
  // Taiwan.
  'zh-Hant': [
    ai('科技報橘 AI', 'https://buzzorange.com/techorange/feed/'),
    ai('INSIDE AI', 'https://www.inside.com.tw/feed/rss'),
    ai('T客邦 AI', 'https://www.techbang.com/posts.rss'),
    { name: 'ETtoday', url: 'https://feeds.feedburner.com/ettoday/realtime' },
    { name: '鏡週刊', url: 'https://www.mirrormedia.mg/rss/news.xml' },
    { name: '新頭殼', url: 'https://newtalk.tw/rss/all' },
    { name: '關鍵評論網', url: 'https://feeds.feedburner.com/TheNewsLens' },
  ],
  // Mainland outlets, reachable from there. Few mainland papers keep an RSS
  // with photos (澎湃 has none, 新华网 and 中新网 no photos), so it leans to technology.
  'zh-Hans': [
    ai('IT之家 AI', 'https://www.ithome.com/rss/'),
    ai('雷锋网 AI', 'https://www.leiphone.com/feed'),
    { name: '36氪', url: 'https://www.36kr.com/feed' },
    { name: '钛媒体', url: 'https://www.tmtpost.com/rss.xml' },
    { name: '爱范儿', url: 'https://www.ifanr.com/feed' },
    { name: '极客公园', url: 'https://www.geekpark.net/rss' },
  ],
};

/** The feeds for a reader of `language`, one of `DEFAULT_FEEDS_BY_LANGUAGE`'s keys (as `ctx.pickLanguage` returns). */
export function defaultFeeds(language: string): FeedSource[] {
  return DEFAULT_FEEDS_BY_LANGUAGE[language] ?? DEFAULT_FEEDS_BY_LANGUAGE.en!;
}

/**
 * Headlines not worth a turn on a screen read at a glance: affiliate
 * advertorials, lottery results, clickbait, galleries, live blogs, listicles.
 * Compiled case-insensitive. Deliberately conservative: a dull story goes away
 * in thirty seconds, an important one that's never shown doesn't come back.
 * (`oferta` alone killed real economy news; `\d+% menos` killed a real
 * product launch: shop context is required instead.)
 */
export const JUNK_TITLE_FILTER = [
  // Advertorials and affiliates.
  '\\b(?:amazon|aliexpress|chollo|descuentazo|superventas|el corte ingl[eé]s',
  '|black friday|c[óo]digo promocional|por menos de \\d+ ?(?:euros|€)',
  '|merece la pena comprar|he probado (?:el|la|los|las)|comprar[íi]as)\\b',
  // Services: draws, horoscopes, results.
  '|\\b(?:euromillones|primitiva|bonoloto|loter[íi]a|sorteo|hor[óo]scopo|quiniela',
  '|cup[óo]n diario|comprobar (?:el|tu)|n[úu]meros premiados)\\b',
  // Clickbait vocabulary.
  '|\\b(?:la joya oculta|joya escondida|lo que nadie|nadie te (?:cuenta|dice)',
  '|no te lo vas a creer|te sorprender|vas a alucinar|el truco|este truco|los trucos',
  '|la raz[óo]n por la que|el motivo por el que|as[íi] es como|esto es lo que (?:pasa|hace|ocurre)',
  '|y no es lo que|el secreto (?:de|que)|dile adi[óo]s|te cambiar[áa] la vida',
  '|estas son las claves|las claves para)\\b',
  // Galleries and virals.
  '|\\b(?:en im[áa]genes|en fotos|las mejores fotos|foto a foto|el v[íi]deo viral',
  '|se hace viral|arrasa en (?:tiktok|redes)|revoluciona las redes)\\b',
  // Live blogs: their headline changes by itself and says nothing.
  '|\\b(?:en directo|minuto a minuto|s[íi]guelo en vivo|[úu]ltima hora de)\\b',
  // Recommendation lists.
  '|\\b(?:series recomendadas|pel[íi]culas recomendadas|las mejores series|recomendadas para)\\b',
  // "Name, job: «quote»" — filler testimonials.
  '|^[a-záéíóúñ]+, [a-záéíóúñ ]{3,28}: ["“\']',
  // "Las 7 claves de…", "Los 5 trucos para…"
  '|^(?:las?|los?) \\d+ (?:claves|cosas|razones|trucos|mejores|secretos|motivos)\\b',
  // Chinese, Taiwan's and the mainland's words, without \b (it never matches
  // between Han characters). Same purposes, same caution: 快訊 is a real
  // breaking story in Taiwan and 雙11 a real economy one in the mainland.
  // Advertorials and deals.
  '|優惠碼|优惠码|折扣碼|折扣码|限時優惠|限时优惠|好物推薦|好物推荐|必買|必买',
  // Draws, horoscopes and fortune-telling.
  '|威力彩|大樂透|大乐透|今彩539|統一發票|中獎號碼|中奖号码|雙色球|双色球|彩票開獎|彩票开奖',
  '|星座運勢|星座运势|生肖運勢|生肖运势|\\d生肖|十二生肖|塔羅|塔罗|紫微',
  // Clickbait: what the netizens did, the one trick.
  '|網友(?:傻眼|笑翻|暴動|炸鍋|狂讚|驚呆)|网友(?:傻眼|笑翻|炸锅|直呼|惊呆)|驚呆了|惊呆了|99%的人|你不知道的|一招(?:搞定|解決|解决)',
  // Galleries and virals.
  '|圖輯|图集|組圖|组图|爆紅|爆红|瘋傳|疯传',
  // Live blogs.
  '|文字直播|直播中|即時更新|实时更新|持續更新|持续更新|【直播】|【LIVE】',
  // Round-ups and lists.
  '|懶人包|懒人包|必看|盤點|盘点|推薦清單|推荐清单',
].join('');

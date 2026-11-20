/**
 * A believable deck for the gallery and the editor: no network, fictional
 * outlets and generic stories. Photos are `demo:<scene>` URLs, painted
 * procedurally by `demophoto.ts`.
 */
import type { Weather } from '@loksly/weather-astro';
import { localize } from '@kiosko/sdk';
import { clusterStories } from './cluster.ts';
import type { NewsItem } from './feeds.ts';
import type { NewsDeck } from './index.ts';

const MIN = 60_000;

function item(source: string, title: string, summary: string, scene: string, agoMin: number, now: number, slug: string): NewsItem {
  return { source, title, summary, image: `demo:${scene}`, link: `https://example.org/${slug}`, published: now - agoMin * MIN };
}

const EN = (now: number): NewsItem[] => [
  item('The Chronicle', 'Port expands its container terminal and expects to double cargo traffic within five years',
    'Works start in spring, reclaim 40 hectares from the sea and add six cranes. The port authority estimates 2,000 direct jobs during construction.', 'harbour', 12, now, 'port-1'),
  item('Coast Daily', 'Port expands container terminal to double cargo traffic',
    'The project adds six cranes and 40 hectares reclaimed from the sea.', 'harbour', 25, now, 'port-2'),
  item('News 24', 'Container terminal at the port will grow to double cargo traffic',
    'Shipping lines welcome the decision; neighbours ask for a noise study.', 'harbour', 41, now, 'port-3'),
  item('News 24', 'The metro will run all night during the end-of-year holidays',
    'Main lines will stay open non-stop from 24 December to 6 January, with trains every fifteen minutes after 1 am.', 'city', 48, now, 'metro'),
  item('The Chronicle', 'Plateau wind farm starts producing: first phase will power 90,000 homes',
    'The 32 turbines installed so far feed the grid from this week; the second phase goes out to tender in January.', 'field', 95, now, 'wind-1'),
  item('Coast Daily', 'Plateau wind farm starts producing late: first phase reaches 90,000 homes in winter',
    'Developers blame the delay on a shortage of transformers.', 'field', 130, now, 'wind-2'),
  item('Tech Today AI', 'An open language model matches the big ones at programming tasks',
    'The team publishes weights and evaluation data; in independent tests it solves 71% of the problems, close to commercial systems.', 'city', 180, now, 'open-model'),
];

const ZH_HANT = (now: number): NewsItem[] => [
  item('紀事報', '港口擴建貨櫃碼頭，五年內貨運量可望倍增',
    '工程明年春天動工，填海 40 公頃並新增六座起重機。港務局估計施工期間可創造 2,000 個直接就業機會。', 'harbour', 12, now, 'port-1'),
  item('海岸日報', '港口擴建貨櫃碼頭 拚貨運量倍增',
    '計畫新增六座起重機與 40 公頃填海新生地。', 'harbour', 25, now, 'port-2'),
  item('新聞 24', '港口貨櫃碼頭擴建 目標貨運量倍增',
    '航運業者歡迎這項決定；附近居民要求進行噪音評估。', 'harbour', 41, now, 'port-3'),
  item('新聞 24', '跨年連假期間捷運通宵行駛',
    '12 月 24 日至 1 月 6 日主要路線不收班，凌晨 1 點後每 15 分鐘一班。', 'city', 48, now, 'metro'),
  item('紀事報', '高原風場開始發電：第一期可供 9 萬戶用電',
    '目前已安裝的 32 座風機本週起併網供電；第二期將於 1 月招標。', 'field', 95, now, 'wind-1'),
  item('海岸日報', '高原風場延後發電：第一期冬季才可供 9 萬戶用電',
    '開發商將延誤歸咎於變壓器短缺。', 'field', 130, now, 'wind-2'),
  item('今日科技 AI', '開放語言模型在程式設計任務上追平大型模型',
    '團隊公開權重與評測資料；在獨立測試中解出 71% 的題目，接近商用系統。', 'city', 180, now, 'open-model'),
];

const ZH_HANS = (now: number): NewsItem[] => [
  item('纪事报', '港口扩建集装箱码头，五年内货运量有望翻番',
    '工程明年春天开工，填海 40 公顷并新增六台起重机。港务局估计施工期间将创造 2000 个直接就业岗位。', 'harbour', 12, now, 'port-1'),
  item('海岸日报', '港口扩建集装箱码头 货运量冲刺翻番',
    '项目新增六台起重机和 40 公顷填海用地。', 'harbour', 25, now, 'port-2'),
  item('新闻 24', '港口集装箱码头扩建 目标货运量翻番',
    '航运公司对此表示欢迎；周边居民要求开展噪声评估。', 'harbour', 41, now, 'port-3'),
  item('新闻 24', '元旦假期地铁通宵运营',
    '12 月 24 日至 1 月 6 日主要线路不停运，凌晨 1 点后每 15 分钟一班。', 'city', 48, now, 'metro'),
  item('纪事报', '高原风电场开始发电：一期可满足 9 万户用电',
    '目前已安装的 32 台风机本周起并网发电；二期将于 1 月招标。', 'field', 95, now, 'wind-1'),
  item('海岸日报', '高原风电场推迟发电：一期冬季才能满足 9 万户用电',
    '开发商将延误归咎于变压器短缺。', 'field', 130, now, 'wind-2'),
  item('今日科技 AI', '开源语言模型在编程任务上追平大模型',
    '团队公开权重和评测数据；在独立测试中解出 71% 的题目，接近商用系统。', 'city', 180, now, 'open-model'),
];

export function demoDeck(now: number, locale = 'es'): NewsDeck {
  const lang = localize({ en: 'en', es: 'es', 'zh-Hant': 'zh-Hant', 'zh-Hans': 'zh-Hans' }, locale);
  const items: NewsItem[] = lang === 'zh-Hant' ? ZH_HANT(now) : lang === 'zh-Hans' ? ZH_HANS(now) : lang === 'es' ? [
    item('La Crónica', 'El puerto amplía su terminal de contenedores y prevé duplicar el tráfico de mercancías en cinco años',
      'La obra, que arrancará en primavera, gana 40 hectáreas al mar y añade seis grúas. La autoridad portuaria calcula 2.000 empleos directos durante la construcción.', 'harbour', 12, now, 'puerto-1'),
    item('Diario Costa', 'El puerto amplía la terminal de contenedores para duplicar el tráfico de mercancías',
      'El proyecto suma seis grúas y 40 hectáreas ganadas al mar.', 'harbour', 25, now, 'puerto-2'),
    item('Noticias 24', 'La terminal de contenedores del puerto crecerá para duplicar el tráfico de mercancías',
      'Las navieras celebran la decisión; los vecinos piden un estudio de ruido.', 'harbour', 41, now, 'puerto-3'),
    item('Noticias 24', 'El metro funcionará toda la noche durante las fiestas de fin de año',
      'Las líneas principales abrirán sin interrupción del 24 de diciembre al 6 de enero, con trenes cada quince minutos a partir de la una.', 'city', 48, now, 'metro'),
    item('La Crónica', 'Los molinos de la meseta ya producen: la primera fase del parque eólico abastecerá a 90.000 hogares',
      'Los 32 aerogeneradores instalados hasta ahora vierten a la red desde esta semana; la segunda fase se licita en enero.', 'field', 95, now, 'eolico-1'),
    item('Diario Costa', 'El parque eólico de la meseta empieza a producir con retraso: su primera fase llega a 90.000 hogares en invierno',
      'Los promotores atribuyen la demora a la falta de transformadores.', 'field', 130, now, 'eolico-2'),
    item('Tecnología Hoy IA', 'Un modelo de lenguaje abierto iguala a los grandes en tareas de programación',
      'El equipo publica los pesos y los datos de evaluación; en pruebas independientes resuelve el 71% de los problemas, cerca de los sistemas comerciales.', 'city', 180, now, 'modelo-abierto'),
  ] : EN(now);
  const stories = clusterStories(items).sort((a, b) => b.consensus - a.consensus || b.lead.published - a.lead.published);
  return { stories, updated: now - 3 * MIN, failed: [] };
}

/** The little the news corner needs, in case the weather plugin isn't there to give its demo. */
export function demoCornerWeather(now: number): Weather {
  return {
    place: 'Madrid', temp: 14, feels: 12, code: 2, humidity: 60, wind: 10, night: false,
    days: [{ date: new Date(now).toISOString().slice(0, 10), code: 2, min: 6, max: 16, rain: 10 }],
    hours: [], fetched: now - 5 * MIN,
  };
}

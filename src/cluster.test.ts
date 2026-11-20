import { test } from 'node:test';
import assert from 'node:assert';
import { clusterStories, contrastPair, overlap, publisherOf, sameStory, swappedSlots, titleBag, withoutLabels } from './cluster.ts';
import type { NewsItem } from './feeds.ts';

function it(source: string, title: string, published = 0): NewsItem {
  return { title, summary: 's', image: 'i', source, link: `${source}/${title.slice(0, 12)}`, published };
}

test('cluster: the bag keeps content terms only', () => {
  const b = titleBag('El Gobierno de España aprueba la nueva ley');
  assert.ok(b.has('gobierno'));
  assert.ok(b.has('espana'), 'accents are normalised');
  assert.ok(b.has('aprueba'));
  assert.ok(!b.has('para') && !b.has('la'), 'stop words and short words go');
});

test('cluster: overlap is measured against the smaller bag', () => {
  const short = new Set(['muere', 'director', 'cyrano']);
  const long = new Set(['muere', 'director', 'cyrano', 'bergerac', 'cine', 'frances', 'aventura']);
  // Jaccard would give 3/7 and not group; overlap gives 1.
  assert.strictEqual(overlap(short, long), 1);
  assert.strictEqual(overlap(new Set(['nada', 'comun']), long), 0);
  assert.strictEqual(overlap(new Set(), long), 0);
});

test('cluster: groups the same fact told by different outlets', () => {
  const stories = clusterStories([
    it('elDiario.es', 'Mueren dos mujeres en el Puerto de Algeciras al caer al mar un coche'),
    it('El País', 'Dos mujeres mueren al caer un coche al mar en el puerto de Algeciras'),
    it('ABC', 'El Gobierno aprueba los presupuestos generales del Estado para el año'),
  ]);
  assert.strictEqual(stories.length, 2);
  assert.strictEqual(stories.find((s) => s.consensus === 2)?.items.length, 2);
  assert.strictEqual(stories.find((s) => s.consensus === 1)?.lead.source, 'ABC');
});

test('cluster: short headlines do not pull others in (the measured false positive)', () => {
  const items = [
    it('elDiario.es', 'El rey como ariete contra Sánchez'),
    it('La Vanguardia', 'El PP y Vox unen fuerzas contra Sánchez en una concentración por Ceuta'),
  ];
  assert.strictEqual(clusterStories(items).length, 2);
});

test('cluster: two pieces of the same paper are not consensus', () => {
  const stories = clusterStories([
    it('elDiario.es', 'El Gobierno aprueba la reforma laboral pactada con los sindicatos'),
    it('elDiario.es', 'El Gobierno aprueba la reforma laboral pactada con los sindicatos hoy'),
  ]);
  assert.strictEqual(stories.length, 2);
  assert.ok(stories.every((s) => s.consensus === 1));
});

test('cluster: a contrast only when the headlines really differ', () => {
  const same = clusterStories([
    it('El País', 'Dos mujeres mueren al caer un coche al mar en el puerto de Algeciras'),
    it('La Vanguardia', 'Dos mujeres mueren al caer un coche al mar en el puerto de Algeciras hoy'),
  ]);
  assert.strictEqual(contrastPair(same[0]!), null, 'repeating the sentence adds nothing');
  const apart = clusterStories([
    it('elDiario.es', 'La Policía analiza imágenes de redes sociales para apuntar a la posible participación de agentes marroquíes'),
    it('El Mundo', 'Las imágenes que demuestran la participación de agentes marroquíes en la entrada'),
  ]);
  const pair = contrastPair(apart[0]!);
  assert.ok(pair, 'same fact, opposite certainty: worth showing');
  assert.notStrictEqual(pair[0].source, pair[1].source);
  assert.strictEqual(contrastPair(clusterStories([it('ABC', 'El Gobierno aprueba los presupuestos generales del Estado')])[0]!), null);
});

test('cluster: a paper is not contrasted with itself through two feeds', () => {
  assert.strictEqual(publisherOf('20minutos IA'), '20minutos');
  assert.strictEqual(publisherOf('Xataka IA'), 'Xataka');
  assert.strictEqual(publisherOf('Diario IAS'), 'Diario IAS', 'only the exact suffix');
  const own = {
    lead: it('20minutos', 'OpenAI presenta su modelo más potente hasta la fecha'),
    items: [it('20minutos', 'OpenAI presenta su modelo más potente hasta la fecha'), it('20minutos IA', 'OpenAI lanza GPT tras frenar parte del desarrollo por seguridad')],
    consensus: 2,
  };
  assert.strictEqual(contrastPair(own), null);
  const pair = contrastPair({ ...own, items: [...own.items, it('Xataka IA', 'El nuevo modelo de OpenAI llega con dudas sobre su coste')] });
  assert.ok(pair);
  assert.notStrictEqual(publisherOf(pair[0].source), publisherOf(pair[1].source));
});

const story = (title: string) => ({ title, bag: titleBag(title) });

test('cluster: Chinese, the same story told differently is grouped', () => {
  for (const [a, b] of [
    // Taiwan.
    ['台積電第三季營收創新高', '台積電第三季營收再創歷史新高'],
    ['颱風山陀兒逼近 氣象署發布海上颱風警報', '氣象署發布山陀兒颱風海上警報 最快明天發陸警'],
    ['賴清德國慶演說：盼朝野團結守護台灣', '國慶大會賴清德致詞 呼籲朝野團結守護台灣'],
    ['立法院三讀通過明年度總預算案', '總預算案今天三讀通過 立法院完成明年度預算審查'],
    ['輝達執行長黃仁勳訪台 將與台積電董事長魏哲家會面', '黃仁勳抵台 輝達執行長預計與魏哲家會面'],
    ['台股收盤大漲300點 台積電領軍', '台積電領軍 台股今天收盤大漲逾300點'],
    ['教育部：明年起國中小營養午餐免費', '國中小營養午餐明年起免費 教育部說明配套'],
    // The mainland.
    ['小米发布新款电动汽车 售价21.59万元起', '小米新款电动汽车正式发布 起售价21.59万元'],
    ['国家统计局：10月CPI同比上涨0.3%', '10月CPI同比上涨0.3% 国家统计局发布最新数据'],
    ['华为发布Mate 80系列手机 搭载麒麟新芯片', '华为Mate 80系列正式发布 搭载新一代麒麟芯片'],
    ['深圳地铁14号线延长线今日开通运营', '深圳地铁14号线延长线开通 沿线居民出行更便利'],
    ['DeepSeek发布新一代大模型V4', 'DeepSeek V4大模型正式发布 性能比肩GPT-5'],
    // Taiwan's and the mainland's writing of the same headline.
    ['台積電第三季營收創新高', '台积电第三季营收创新高 AI需求强劲'],
    // Real pairs from the default feeds (2026-11-20), at the bottom of the range.
    ['賴清德讚「台中桂綸鎂」認證何欣純全國女狀元：當市長絕對第一名', '（影）大讚「台中桂綸鎂」 賴清德：何欣純未來一定是五星級市長'],
    ['13綠委缺席！普發2萬三讀擋不住 王婉諭轟：民進黨也須給人民交代', '普發2萬擋不住！綠委缺席成破口 民進黨團揭背後原因'],
    ['台灣九合一選舉前夕，通報 Meta 近 2,700 個疑中國介選帳號', '[政治] 台灣九合一選舉前夕 通報Meta近2700個疑中國介選帳號'],
    ['AI 攻克黎曼猜想？Anthropic 数学家宣称已与 Claude 合作完成证明', 'Anthropic数学家声称与Claude合作证明黎曼猜想 还提出广义黎曼猜想的证明'],
  ]) assert.ok(sameStory(story(a!), story(b!)), `same story: ${a} | ${b}`);
});

test('cluster: Chinese, different stories that look alike are not', () => {
  for (const [a, b] of [
    // One word swapped in the same sentence: that word is the news.
    ['台北捷運票價明年調漲 單程最低25元', '新北捷運票價明年調漲 單程最低25元'],
    ['中央氣象署發布大雨特報', '中央氣象署發布低溫特報'],
    ['立法院今天三讀通過預算案', '立法院今天三讀通過勞基法修正案'],
    ['台積電第三季營收創新高', '聯發科第三季營收創新高'],
    ['台股今天收盤上漲300點', '台股今天收盤下跌200點'],
    ['蘋果發表新款iPhone 售價維持不變', '三星發表新款折疊手機 售價維持不變'],
    ['OpenAI發表GPT-6 推理能力大幅提升', 'Google發表Gemini 4 推理能力大幅提升'],
    ['国家统计局：10月CPI同比上涨0.3%', '国家统计局：10月PPI同比下降2.1%'],
    ['小米发布新款电动汽车', '小米发布新款折叠屏手机'],
    // Same institution, same verb, different news.
    ['中央氣象署發布大雨特報 北北基宜防豪雨', '中央氣象署發布低溫特報 新竹以北探10度'],
    ['北京今天发布暴雨蓝色预警', '上海今天发布高温橙色预警'],
    ['深圳地铁14号线延长线今日开通运营', '广州地铁18号线北延段今日开通运营'],
    ['教育部宣布明年起高中課綱調整', '衛福部宣布明年起長照補助調整'],
    ['新竹科學園區停電 台積電廠區受影響', '台中科學園區停電 美光廠區受影響'],
    // Real, the closest pair of different stories in a day of Taiwanese feeds.
    ['台中和平區長候選人 涉以5千元買票羈押禁見', '台南2里長候選人涉賄選！每票2000元買票、招待旅遊 雙雙遭羈押'],
  ]) assert.ok(!sameStory(story(a!), story(b!)), `different stories: ${a} | ${b}`);
});

test('cluster: Chinese bags fold Traditional to Simplified and drop empty bigrams', () => {
  assert.deepStrictEqual([...titleBag('臺灣颱風')], [...titleBag('台湾台风')]);
  const b = titleBag('立法院今天宣布 CPI 上漲0.3%');
  assert.ok(!b.has('今天') && !b.has('宣布'), 'dates and reporting verbs say nothing');
  assert.ok(b.has('立法') && b.has('cpi') && b.has('0.3'), 'names and figures stay');
});

test('cluster: section labels are not part of a Chinese headline', () => {
  assert.strictEqual(withoutLabels('[國際] 歐盟願與英國建立緊密關係'), '歐盟願與英國建立緊密關係');
  assert.strictEqual(withoutLabels('快訊》夏莉絲案家長陳情'), '夏莉絲案家長陳情');
  assert.strictEqual(withoutLabels('[生活] 天氣預報／冷氣團影響'), '冷氣團影響');
  assert.strictEqual(withoutLabels('（影）大讚台中桂綸鎂'), '大讚台中桂綸鎂');
  assert.strictEqual(withoutLabels('廢非核公投意見會／黃士修指核電'), '廢非核公投意見會／黃士修指核電', 'a long topic is the headline');
});

test('cluster: a swapped slot is a different story; an added word is not', () => {
  assert.strictEqual(swappedSlots('台北市公車票價明年起調漲', '新北市公車票價明年起調漲'), true);
  assert.strictEqual(swappedSlots('台積電第三季營收創新高', '台積電第三季營收再創歷史新高'), false);
  assert.strictEqual(swappedSlots('北京发布暴雨红色预警', '北京发布暴雨红色预警 全市停课'), false);
});

test('cluster: Chinese stories group across outlets, Spanish ones as before', () => {
  const stories = clusterStories([
    it('ETtoday', '中央氣象署發布大雨特報 北北基宜防豪雨'),
    it('鏡週刊', '中央氣象署發布低溫特報 新竹以北探10度'),
    it('新頭殼', '颱風山陀兒逼近 氣象署發布海上颱風警報'),
    it('ETtoday', '氣象署發布山陀兒颱風海上警報 最快明天發陸警'),
    it('關鍵評論網', '台北捷運票價明年調漲 單程最低25元'),
    it('新頭殼', '新北捷運票價明年調漲 單程最低25元'),
  ]);
  assert.deepStrictEqual(stories.map((s) => s.consensus), [1, 1, 2, 1, 1]);
});

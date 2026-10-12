/*! 区域名识别（从文字层/OCR 的文字块里挑区域名）测试 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../js/labels.js');

// 用两份真实 PDF 的文字块样式造样例
const CAR_ITEMS = [
  { str: 'MURDOKU', x: 200, y: 60, h: 65 },
  { str: 'Car Repair', x: 60, y: 200, h: 30 },
  { str: 'Vaughn was murdered!', x: 600, y: 60, h: 22 },
  { str: '1', x: 610, y: 40, h: 22 },
  { str: 'Can be occupied', x: 1000, y: 260, h: 16 },
  { str: 'Car', x: 1010, y: 330, h: 15 },
  { str: 'Chair', x: 1080, y: 330, h: 15 },
  { str: 'TV', x: 1230, y: 330, h: 15 },
  { str: 'Shelf', x: 1300, y: 330, h: 15 },
  { str: 'RECEPTION', x: 989, y: 708, h: 22.4 },
  { str: 'WAITING AREA', x: 1346, y: 707, h: 22.4 },
  { str: 'STORAGE', x: 1414, y: 603, h: 22.4 },
  { str: 'GARAGE', x: 1076, y: 1022, h: 22.4 },
  { str: 'The murderer is…', x: 800, y: 1180, h: 20 },
];
const BOX = { x: 869, y: 384, w: 654, h: 648 };
const GEOM = { x0: 869, y0: 384, pitchX: 109, pitchY: 108, cols: 6, rows: 6 };

test('car-repair 风格：只挑出 4 个区域名', () => {
  const labels = L.pickRegionLabels(CAR_ITEMS, BOX, { maxSize: 0.5 * 109 });
  assert.deepEqual(labels.map(l => l.name).sort(), ['GARAGE', 'RECEPTION', 'STORAGE', 'WAITING AREA']);
});

test('没有外框时：全大写判据仍能排除图例物品与线索句，只会多收标题这类大字', () => {
  const labels = L.pickRegionLabels(CAR_ITEMS);
  const names = labels.map(l => l.name);
  assert.ok(!names.includes('Car') && !names.includes('Chair') && !names.includes('TV') && !names.includes('Shelf'),
    '图例物品名不该被当成区域名：' + names.join(' / '));
  assert.ok(!names.includes('Vaughn was murdered!'), '线索句不该被当成区域名');
  assert.ok(names.includes('MURDOKU'), '没有外框时标题会被收进来（所以调用方要传外框 + 字号上限）');
});

test('字号上限能挡住标题那种大字', () => {
  const labels = L.pickRegionLabels(CAR_ITEMS, null, { maxSize: 40 });
  assert.ok(!labels.map(l => l.name).includes('MURDOKU'));
});

test('标签坐标 → 格子：正确落格，框外返回 null', () => {
  assert.deepEqual(L.labelToCell({ x: 989, y: 708 }, GEOM), { r: 3, c: 1 });     // 989-869=120 → c=1；708-384=324 → r=3
  assert.equal(L.labelToCell({ x: 100, y: 100 }, GEOM), null);
  const seeds = L.labelsToSeeds(L.pickRegionLabels(CAR_ITEMS, BOX, { maxSize: 55 }), GEOM);
  assert.equal(seeds.length, 4, '应给出 4 个种子：' + JSON.stringify(seeds));
  assert.deepEqual(seeds.map(s => s.name).sort(), ['GARAGE', 'RECEPTION', 'STORAGE', 'WAITING AREA']);
  // 同一格只留一个种子
  const dup = L.labelsToSeeds([{ name: 'A', x: 900, y: 400 }, { name: 'B', x: 905, y: 405 }], GEOM);
  assert.equal(dup.length, 1);
});

test('识别区域由对齐好的网格推出：pad=0 就是网格矩形，默认四周放宽 0.2 格', () => {
  // car-repair：手画外框与网格矩形本来就是同一个（框用来定标），所以等价
  assert.deepEqual(L.areaBox(GEOM, 0), { x: 869, y: 384, w: 654, h: 648 });
  const a = L.areaBox(GEOM);
  assert.ok(Math.abs(a.x - BOX.x + 0.2 * 109) < 1e-9 && Math.abs(a.y - BOX.y + 0.2 * 108) < 1e-9,
    '默认 pad 应为 0.2 格：' + JSON.stringify(a));
  // 用推出来的区域挑名字，结果和手画框一致 —— 说明"框"退场后判据不变
  const names = L.pickRegionLabels(CAR_ITEMS, a, { maxSize: 0.5 * 109 }).map(l => l.name).sort();
  assert.deepEqual(names, ['GARAGE', 'RECEPTION', 'STORAGE', 'WAITING AREA']);
});

test('inBox：框内 / 框外 / 坐标缺失', () => {
  const box = L.areaBox(GEOM, 0);
  assert.equal(L.inBox({ x: 869, y: 384 }, box), true);            // 左上角算框内
  assert.equal(L.inBox({ x: 869 + 654, y: 384 + 648 }, box), true); // 右下角算框内
  assert.equal(L.inBox({ x: 868, y: 384 }, box), false);
  assert.equal(L.inBox({ x: 869, y: 384 + 649 }, box), false);
  assert.equal(L.inBox({ x: NaN, y: 384 }, box), false);
  assert.equal(L.inBox({ x: 0, y: 0 }, null), true, '没有框时不过滤');
});

test('family 风格：TEACHER’S AREA 里的撇号不影响判定', () => {
  const items = [
    { str: 'TEACHER’S AREA', x: 1177, y: 682, h: 26 },
    { str: 'FRONT AREA', x: 1116, y: 844, h: 26 },
    { str: 'BACK AREA', x: 1100, y: 1000, h: 26 },
    { str: 'He was in the', x: 200, y: 800, h: 26 },
    { str: 'Window', x: 1000, y: 300, h: 15 },
  ];
  const labels = L.pickRegionLabels(items, { x: 900, y: 400, w: 600, h: 700 }, { maxSize: 60 });
  assert.deepEqual(labels.map(l => l.name).sort(), ['BACK AREA', 'FRONT AREA', 'TEACHER’S AREA']);
});

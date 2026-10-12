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

test('截图标签：白底药丸 + 黑描边 + 黑字被找出来；白色物件/无描边/无字都不算', () => {
  // 200×130 的小图，格距 20：① 3 个真标签 ② 无字白抱枕 ③ 有黑框但没字的白板
  const W = 200, H = 130, pitch = 20;
  const raster = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = 255;
  const fill = (x0, y0, w, h, rgb) => {
    for (let y = y0; y < y0 + h; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || x >= W) continue;
        const o = (y * W + x) * 4;
        raster.data[o] = rgb[0]; raster.data[o + 1] = rgb[1]; raster.data[o + 2] = rgb[2];
      }
    }
  };
  fill(0, 0, W, H, [110, 160, 90]);                       // 草地绿底
  /** 画一枚标签：黑描边 + 白底 + 5 根"字"竖条 */
  const badge = (x, y, letters) => {
    const w = 10 + letters * 7, h = 12;
    fill(x, y, w, h, [10, 10, 10]);
    fill(x + 2, y + 2, w - 4, h - 4, [255, 255, 255]);
    for (let i = 0; i < letters; i++) fill(x + 4 + i * 7, y + 3, 4, 7, [12, 12, 12]);
    return { x: x + 2, y: y + 2, w: w - 4, h: h - 4 };
  };
  const want = [badge(6, 8, 5), badge(120, 8, 6), badge(6, 50, 5)];
  fill(60, 8, 40, 12, [255, 255, 255]);                   // 干扰 1：无字白抱枕
  fill(60, 50, 40, 12, [255, 255, 255]);                  // 干扰 2：有黑框但没字
  fill(60, 50, 40, 1, [0, 0, 0]); fill(60, 61, 40, 1, [0, 0, 0]);
  fill(60, 50, 1, 12, [0, 0, 0]); fill(99, 50, 1, 12, [0, 0, 0]);
  const found = L.findLabelBadges(raster, pitch);
  assert.equal(found.length, want.length, '应只找到 3 个标签，实际 ' + found.length + '：' +
    JSON.stringify(found.map(f => [f.x, f.y, f.w, f.h])));
  assert.deepEqual(found.map(f => f.x + ',' + f.y).sort(), want.map(w2 => w2.x + ',' + w2.y).sort(),
    '位置应与画的药丸对得上');
  assert.ok(found.every(f => f.ink >= 0.2 && f.glyphs >= 4), '黑字占比/字块数应在合理范围：' + JSON.stringify(found));
});

test('OCR 名字整理：用真实识别输出（contest 截图 17 个徽章）把空格补回来', () => {
  // 这些字符串是 tesseract 在 fixture 上真实的输出（字母准确率 99%，错的全是空格）
  const raw = ['CABINA', 'CAVERN', 'WOODS', 'FRIGATEA', 'BEACH', 'SLOOPA', 'SLOOPB', 'SLOOP CC',
               'CABIN B', 'GALLEON', 'DOCK', 'TAVERN', 'CABIN C', 'CLIFF', 'WATER', 'CLEARING', 'FRIGATE B'];
  const want = ['CABIN A', 'CAVERN', 'WOODS', 'FRIGATE A', 'BEACH', 'SLOOP A', 'SLOOP B', 'SLOOP C',
                'CABIN B', 'GALLEON', 'DOCK', 'TAVERN', 'CABIN C', 'CLIFF', 'WATER', 'CLEARING', 'FRIGATE B'];
  assert.deepEqual(L.mergeOcrNames(raw), want);
  // 单个词里的重复字母不能被收掉（CLIFF 不是 "尾词重复"）
  assert.deepEqual(L.mergeOcrNames(['CLIFF', 'SLOOP CC']), ['CLIFF', 'SLOOP C']);
  // 已知词只在"同一张图里确实出现过带空格的形式"时才用来切（没有词表就原样返回）
  assert.deepEqual(L.mergeOcrNames(['WOODS', 'BEACH']), ['WOODS', 'BEACH']);
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

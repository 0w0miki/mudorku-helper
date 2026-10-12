/* 图例卡片 → 物品清单：切分、名字归属、按"说明文字"判断可占据 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../js/legend.js');

function makeRaster(w, h, rgb) {
  const r = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    r.data[o] = rgb[0]; r.data[o + 1] = rgb[1]; r.data[o + 2] = rgb[2]; r.data[o + 3] = 255;
  }
  return r;
}
function fill(r, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= r.height) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= r.width) continue;
      const o = (y * r.width + x) * 4;
      r.data[o] = rgb[0]; r.data[o + 1] = rgb[1]; r.data[o + 2] = rgb[2];
    }
  }
}
/** 一个"图标"：主体 + 顶边 + 两条腿（故意画成互不相连的几块，考验合并） */
function icon(r, x, y, s) {
  fill(r, x + Math.round(4 * s), y + Math.round(6 * s), Math.round(26 * s), Math.round(20 * s), [80, 74, 68]);
  fill(r, x + Math.round(4 * s), y, Math.round(26 * s), Math.round(5 * s), [120, 112, 104]);
  fill(r, x + Math.round(8 * s), y + Math.round(25 * s), Math.round(5 * s), Math.round(8 * s), [70, 64, 58]);
  fill(r, x + Math.round(21 * s), y + Math.round(25 * s), Math.round(5 * s), Math.round(8 * s), [70, 64, 58]);
}
/** 一条"文字"：几条细横线（宽度不同，接近真实文字的形状） */
function text(r, x, y, width, height) {
  const n = Math.max(3, Math.round(width / (height * 0.9)));
  const cw = Math.max(2, Math.round(width / n) - 2);
  for (let i = 0; i < n; i++) fill(r, x + i * (cw + 2), y, cw, height, [55, 55, 55]);
}

test('图例卡片：切出图标、按"说明文字"定可占据、名字归到图标', () => {
  const r = makeRaster(560, 300, [246, 244, 240]);
  text(r, 20, 12, 90, 14);                       // 标题 ITEMS
  // 左栏：说明 + 3 个图标（每个图标下方一个名字）
  text(r, 30, 50, 150, 13);                      // Can be occupied
  icon(r, 30, 80, 1); text(r, 26, 118, 44, 11);
  icon(r, 130, 80, 1); text(r, 126, 118, 44, 11);
  icon(r, 230, 80, 1); text(r, 226, 118, 44, 11);
  // 右栏：说明 + 3 个图标
  text(r, 340, 50, 180, 13);                     // Cannot be occupied
  icon(r, 340, 80, 1); text(r, 336, 118, 44, 11);
  icon(r, 440, 80, 1); text(r, 436, 118, 44, 11);
  icon(r, 340, 170, 1); text(r, 336, 208, 44, 11);

  const sp = L.split(r);
  assert.equal(sp.icons.length, 6, '应切出 6 个图标，实得 ' + sp.icons.length);
  assert.ok(sp.textBoxes.length >= 2, '应给出待 OCR 的文字块（至少两条说明）：' + sp.textBoxes.length);
  const two = sp.groups.length >= 2 ? 2 : sp.groups.length;
  assert.ok(two >= 2, '应分成两组（左/右栏），实得 ' + sp.groups.length);
});

test('可占据按说明文字判断：不能占据的说明要让整组变成不可占据', () => {
  const r = makeRaster(560, 300, [246, 244, 240]);
  text(r, 30, 50, 150, 13);
  icon(r, 30, 80, 1); icon(r, 130, 80, 1);
  text(r, 340, 50, 180, 13);
  icon(r, 340, 80, 1); icon(r, 440, 80, 1);
  const sp = L.split(r);
  // 手工喂 OCR 结果（真实用法是 js/ocr.js 读出来）
  const ocr = [
    { x: 30, y: 50, text: 'Can be occupied', badge: { w: 150, h: 13 } },
    { x: 340, y: 50, text: 'Cannot be occupied', badge: { w: 180, h: 13 } },
  ];
  const items = L.annotate(sp, ocr);
  assert.equal(items.length, 4);
  const left = items.filter(it => it.box.x < 300), right = items.filter(it => it.box.x >= 300);
  assert.equal(left.length, 2); assert.equal(right.length, 2);
  const occ = gi => sp.groups[gi].occupiable;
  assert.equal(occ(left[0].group), true, '左栏应判为"可占据"：' + JSON.stringify(sp.groups.map(g => g.label)));
  assert.equal(occ(right[0].group), false, '右栏应判为"不可占据"：' + JSON.stringify(sp.groups.map(g => g.label)));
});

test('名字归属：图标旁边的文字成为它的名字（而不是被当成组说明）', () => {
  const r = makeRaster(400, 200, [246, 244, 240]);
  icon(r, 30, 40, 1); text(r, 90, 52, 60, 12);
  icon(r, 30, 120, 1); text(r, 90, 132, 60, 12);
  const sp = L.split(r);
  const ocr = [
    { x: 90, y: 52, text: 'CHAIR', badge: { w: 60, h: 12 } },
    { x: 90, y: 132, text: 'TABLE', badge: { w: 60, h: 12 } },
  ];
  const items = L.annotate(sp, ocr);
  const names = items.map(i => i.name).sort();
  assert.deepEqual(names, ['CHAIR', 'TABLE'], '名字应各归各的图标：' + JSON.stringify(items.map(i => i.name)));
});

test('说明文字读不懂时不硬猜（occupiable 留 null，交给用户定）', () => {
  assert.equal(L.classifyLabel('Can be occupied'), 'yes');
  assert.equal(L.classifyLabel('Cannot be occupied'), 'no');
  assert.equal(L.classifyLabel('不能放人'), 'no');
  assert.equal(L.classifyLabel('可占据'), 'yes');
  assert.equal(L.classifyLabel('Blah blah'), 'unknown');
  const r = makeRaster(400, 200, [246, 244, 240]);
  text(r, 20, 20, 120, 13);
  icon(r, 30, 60, 1); icon(r, 150, 60, 1);
  const sp = L.split(r);
  L.annotate(sp, [{ x: 20, y: 20, text: 'Some heading', badge: { w: 120, h: 13 } }]);
  assert.equal(sp.groups[0].occupiable, null, '读不懂就不猜：' + JSON.stringify(sp.groups[0]));
});

/* ── A. PDF 文字层当骨架 ─────────────────────────────────────────────── */

test('PDF 文字层：名字 + 坐标 → 物品清单（可占据按说明行判定）', () => {
  // 造一页"图例"：上面两行说明，下面图标 + 名字（模拟真实图例的排版）
  const r = makeRaster(600, 220, [235, 232, 245]);
  icon(r, 40, 70, 1); icon(r, 150, 70, 1);
  icon(r, 330, 70, 1); icon(r, 440, 70, 1);
  icon(r, 550, 70, 1);
  // 文字层（坐标为视口坐标，y 是基线）
  const text = [
    { str: 'Can be occupied', x: 30, y: 55, w: 150, h: 14 },
    { str: 'Cannot be occupied', x: 320, y: 55, w: 170, h: 14 },
    { str: 'Oil Slick', x: 28, y: 140, w: 60, h: 13 },
    { str: 'Car', x: 140, y: 140, w: 30, h: 13 },
    { str: 'TV', x: 320, y: 140, w: 22, h: 13 },
    { str: 'Shelf', x: 430, y: 140, w: 45, h: 13 },
    { str: 'Plant', x: 540, y: 140, w: 45, h: 13 },
    { str: 'Page 1 of 2', x: 500, y: 205, w: 70, h: 10 },
  ];
  const out = L.legendFromText(text, r);
  assert.equal(out.items.length, 5, '应认出 5 件物品：' + JSON.stringify(out.items.map(i => i.name)));
  const byName = Object.fromEntries(out.items.map(i => [i.name, i]));
  assert.ok(byName.Car && byName.TV && byName.Shelf && byName.Plant, '名字应来自文字层：' + JSON.stringify(Object.keys(byName)));
  assert.equal(byName.Car.occupiable, true, '左栏 = 可占据');
  assert.equal(byName.Shelf.occupiable, false, '右栏 = 不可占据');
  assert.ok(byName.Car.icon.x < 200, 'Car 的图标应在左边那件上：' + JSON.stringify(byName.Car.icon));
  assert.ok(byName.Shelf.icon.x > 380, 'Shelf 的图标应在右边那件上：' + JSON.stringify(byName.Shelf.icon));
  assert.ok(!byName['Page 1 of 2'], '页脚那种"附近没有图标"的文字要被丢掉');
});

test('PDF 文字层：一行里并排的几个名字按空隙拆开', () => {
  // 注意：现在要求"至少 3 个排成一行/一列"才认为找到了图例
  // （少于 3 个基本都是误报 —— contest 第 2 页把规则图里的 ROW/COLUMN 当成物品就吃过这个亏 ✗）
  const r = makeRaster(620, 120, [235, 232, 245]);
  icon(r, 30, 30, 1); icon(r, 230, 30, 1); icon(r, 430, 30, 1);
  const text = [
    { str: 'Chair', x: 25, y: 95, w: 45, h: 13 },
    { str: 'Table', x: 225, y: 95, w: 45, h: 13 },
    { str: 'Plant', x: 425, y: 95, w: 45, h: 13 },
  ];
  const out = L.legendFromText(text, r);
  assert.equal(out.items.length, 3, JSON.stringify(out.items.map(i => i.name)));
  assert.deepEqual(out.items.map(i => i.name).sort(), ['Chair', 'Plant', 'Table']);
});

test('PDF 文字层：正文句子不会被当成物品（不超过 3 个词、不成段）', () => {
  // 用户实测 familymurdoku：把 "I would've made the" 这类线索句子列成了物品 ✗
  const r = makeRaster(700, 300, [235, 232, 245]);
  icon(r, 40, 60, 1); icon(r, 240, 60, 1); icon(r, 440, 60, 1);
  const text = [
    { str: 'Can be occupied', x: 30, y: 40, w: 150, h: 14 },
    { str: 'Window', x: 35, y: 130, w: 60, h: 13 },
    { str: 'Chair', x: 235, y: 130, w: 45, h: 13 },
    { str: 'Shelf', x: 435, y: 130, w: 45, h: 13 },
    // 正文段落：三行紧挨着，每行好几个词
    { str: 'Someone drew a mean', x: 40, y: 210, w: 200, h: 13 },
    { str: 'caricature of the teacher', x: 40, y: 228, w: 240, h: 13 },
    { str: 'I would have made the', x: 40, y: 246, w: 220, h: 13 },
  ];
  const out = L.legendFromText(text, r);
  const names = out.items.map(i => i.name).sort();
  assert.deepEqual(names, ['Chair', 'Shelf', 'Window'], '只该认图例里那三件：' + JSON.stringify(names));
  assert.ok(!out.items.some(i => /would|caricature|Someone/.test(i.name)), '正文不该进来：' + JSON.stringify(names));
});

test('图例区域没有文字名时：按列投影切出一排图标（面板渐变不能干扰）', () => {
  // contest 第 2 页那种情况：图例物品在文字层里没名字，只能靠图标本身切分。
  // 二维连通域在这种"彩色药丸面板"上会整块粘住 ✗，列投影稳得多 ✓
  const r = makeRaster(560, 200, [60, 60, 90]);
  // 面板：带渐变的浅色药丸（模拟真实图例）
  for (let y = 60; y < 160; y++) {
    for (let x = 30; x < 530; x++) {
      const t2 = (x - 30) / 500;
      const g = Math.round(220 + 18 * Math.sin(t2 * 3.1));
      fill(r, x, y, 1, 1, [g, g - 6, g - 18]);
    }
  }
  [70, 190, 310, 430].forEach(ox => icon(r, ox, 90, 1));       // 四个图标排成一行
  const boxes = L.splitIconsByColumns(r, { x: 20, y: 50, w: 520, h: 130 });
  assert.ok(boxes.length >= 3 && boxes.length <= 6, '应切出约 4 个图标，实得 ' + boxes.length + '：' + JSON.stringify(boxes));
  const xs = boxes.map(b => b.x).sort((a, b) => a - b);
  assert.ok(xs[0] < 120 && xs[xs.length - 1] > 380, '应覆盖左右两端：' + JSON.stringify(xs));
  boxes.forEach(b => assert.ok(b.h >= 10 && b.w >= 10, '框要像图标：' + JSON.stringify(b)));
});

test('卡片图例：两排图标各自成排（contest 那种"一个说明行 + 两排图标"）', () => {
  // 直接对整张卡片做列投影会把两排的图标并成"跨排的柱子" ✗
  // 正确：先按行投影切出每一排，再在排内做列投影，并把"图标排 ↔ 紧跟其下的名字排"配对
  const r = makeRaster(560, 320, [190, 120, 120]);
  [60, 200, 340].forEach(ox => { icon(r, ox, 30, 1); text(r, ox + 4, 78, 40, 11); });   // 第一排
  [60, 200, 340].forEach(ox => { icon(r, ox, 170, 1); text(r, ox + 4, 218, 40, 11); }); // 第二排
  const rows = L.readCardLegend(r, { x: 20, y: 20, w: 520, h: 260 });
  assert.equal(rows.length, 6, '两排各 3 个图标 = 6 个：' + JSON.stringify(rows.map(x => [x.box.x, x.box.y])));
  const top = rows.filter(x => x.box.y < 120), bottom = rows.filter(x => x.box.y >= 120);
  assert.equal(top.length, 3, '第一排 3 个');
  assert.equal(bottom.length, 3, '第二排 3 个');
  rows.forEach(x => assert.ok(x.nameBox, '每个图标都该配到一个名字框：' + JSON.stringify(x)));
  const xs = top.map(x => x.box.x).sort((a, b) => a - b);
  assert.ok(xs[0] < 120 && xs[2] > 320, '第一排按 x 铺开：' + JSON.stringify(xs));
});

test('PDF 文字层：说明行画在图例**下方**时也能认出（不再只往下找）', () => {
  const r = makeRaster(700, 300, [235, 232, 245]);
  // 图标与名字在上，说明行在下
  icon(r, 60, 40, 1); icon(r, 260, 40, 1); icon(r, 460, 40, 1);
  const text = [
    { str: 'Chair', x: 55, y: 110, w: 45, h: 13 },
    { str: 'Table', x: 255, y: 110, w: 45, h: 13 },
    { str: 'Plant', x: 455, y: 110, w: 45, h: 13 },
    { str: 'Can be occupied', x: 250, y: 200, w: 150, h: 14 },
  ];
  const out = L.legendFromText(text, r);
  assert.equal(out.items.length, 3, '说明行在下时也该认出 3 件：' + JSON.stringify(out.items.map(i => i.name)));
  out.items.forEach(it => assert.equal(it.occupiable, true, '都应归到"可占据"：' + it.name + ' → ' + it.occupiable));
});

test('PDF 文字层：说明行贴着那排名字时，不该把名字判成"正文"', () => {
  // contest 的真实坑：can be occupied 的说明行就在第二排名字下方 30px，x 与中间几个名字重叠
  // → 成段判据（"上下还有别的文字"）把 barrel / shelf / crate / rope 全丢了 ✗
  const r = makeRaster(700, 300, [235, 232, 245]);
  [60, 200, 340, 480].forEach(ox => icon(r, ox, 40, 1));
  const text = [
    { str: 'crate', x: 55, y: 130, w: 45, h: 20 },
    { str: 'barrel', x: 195, y: 130, w: 56, h: 20 },
    { str: 'shelf', x: 335, y: 130, w: 46, h: 20 },
    { str: 'shrub', x: 475, y: 130, w: 55, h: 20 },
    { str: 'can be occupied', x: 190, y: 162, w: 150, h: 20 },   // 说明行：贴着名字下方，x 有重叠
  ];
  const out = L.legendFromText(text, r);
  const names = out.items.map(i => i.name).sort();
  assert.deepEqual(names, ['barrel', 'crate', 'shelf', 'shrub'],
    '说明行不该把名字判成正文：' + JSON.stringify(names) + ' · 丢弃=' + JSON.stringify(out.skipped));
});

test('PDF 文字层：单个字母 / 坐标标签不算物品名', () => {
  const r = makeRaster(700, 240, [235, 232, 245]);
  [60, 200, 340].forEach(ox => icon(r, ox, 30, 1));
  const text = [
    { str: 'chair', x: 55, y: 110, w: 45, h: 16 },
    { str: 'A', x: 195, y: 110, w: 12, h: 16 },        // 规则图里的字母标注
    { str: 'C9', x: 335, y: 110, w: 20, h: 16 },       // 坐标标签
    { str: 'Can be occupied', x: 100, y: 20, w: 150, h: 16 },
  ];
  const out = L.legendFromText(text, r);
  assert.deepEqual(out.items.map(i => i.name), ['chair'], '只该剩 chair：' + JSON.stringify(out.items.map(i => i.name)));
});

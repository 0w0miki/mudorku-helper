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

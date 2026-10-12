/*! 物品候选（P2）测试：点一个样例 → 找图上所有同类（模板匹配） */
const test = require('node:test');
const assert = require('node:assert');
const I = require('../js/items.js');

function makeRaster(w, h) {
  const r = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 3; i < r.data.length; i += 4) r.data[i] = 255;
  return r;
}
function fillRect(r, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= r.height) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= r.width) continue;
      const o = (y * r.width + x) * 4;
      r.data[o] = rgb[0]; r.data[o + 1] = rgb[1]; r.data[o + 2] = rgb[2];
    }
  }
}
function disc(r, cx, cy, rad, rgb) {
  for (let y = cy - rad; y <= cy + rad; y++) {
    for (let x = cx - rad; x <= cx + rad; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) fillRect(r, x, y, 1, 1, rgb);
    }
  }
}
/** 确定性噪声，模拟插画/JPEG 的纹理（模板匹配要能扛住） */
function addNoise(r, seed) {
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const o = (y * r.width + x) * 4;
      const d = Math.round((rnd() - 0.5) * 18);
      for (let k = 0; k < 3; k++) r.data[o + k] = Math.max(0, Math.min(255, r.data[o + k] + d));
    }
  }
}

const PITCH = 40, X0 = 20, Y0 = 20, N = 8;
/** 椅子图标：坐垫 + 靠背 + 两条腿（形状独特，便于检验"只找同类"） */
function chair(r, cx, cy, k) {
  const s = k || 1;
  fillRect(r, cx - Math.round(9 * s), cy - Math.round(7 * s), Math.round(18 * s), Math.round(11 * s), [70, 64, 58]);
  fillRect(r, cx - Math.round(9 * s), cy - Math.round(12 * s), Math.round(18 * s), Math.round(4 * s), [110, 100, 90]);
  fillRect(r, cx - Math.round(8 * s), cy + Math.round(4 * s), Math.round(3 * s), Math.round(5 * s), [60, 55, 50]);
  fillRect(r, cx + Math.round(5 * s), cy + Math.round(4 * s), Math.round(3 * s), Math.round(5 * s), [60, 55, 50]);
}
const rock = (r, cx, cy) => disc(r, cx, cy, 8, [120, 118, 112]);
const CHAIRS = [[1, 1], [1, 4], [4, 2], [6, 6]];
const ROCKS = [[3, 3], [3, 6], [5, 1]];

function makeMap(opts) {
  const o = opts || {};
  const r = makeRaster(X0 * 2 + N * PITCH, Y0 * 2 + N * PITCH);
  fillRect(r, 0, 0, r.width, r.height, [200, 190, 170]);
  for (let rr = 0; rr < N; rr++) {
    for (let cc = 0; cc < N; cc++) fillRect(r, X0 + cc * PITCH, Y0 + rr * PITCH, PITCH, PITCH, [226, 220, 205]);
  }
  CHAIRS.forEach(([rr, cc], i) => chair(r, X0 + cc * PITCH + PITCH / 2, Y0 + rr * PITCH + PITCH / 2,
    o.bigChair && i === 1 ? 1.15 : 1));
  ROCKS.forEach(([rr, cc]) => rock(r, X0 + cc * PITCH + PITCH / 2, Y0 + rr * PITCH + PITCH / 2));
  // 一次性装饰（不该被算进同类）
  fillRect(r, X0 + 7 * PITCH + 12, Y0 + 0 * PITCH + 10, 14, 14, [40, 90, 60]);
  fillRect(r, X0 + 5 * PITCH + 8, Y0 + 4 * PITCH + 20, 20, 8, [150, 60, 60]);
  addNoise(r, 20261012);
  return { raster: r, geom: { x0: X0, y0: Y0, pitchX: PITCH, pitchY: PITCH, cols: N, rows: N } };
}
const setOf = a => a.slice().sort().join(' ');

test('点一个样例 → 只找出同一件物品的格子（不牵连别的图案）', () => {
  const { raster, geom } = makeMap();
  const res = I.findSimilar(raster, geom, CHAIRS[0][0], CHAIRS[0][1]);
  assert.ok(res.ok, '应找到同类：' + JSON.stringify(res.stats));
  assert.equal(setOf(res.cells), setOf(CHAIRS.map(([r, c]) => r + ',' + c)),
    '椅子应恰好是那 4 格：' + setOf(res.cells));
  assert.ok(res.scores.every(s => s >= 0.5), '匹配分数应都超过下限：' + res.scores.join(','));
  assert.ok(!res.cells.includes('3,3'), '石头不该被当成椅子');
});

test('信息量少的样例（墓碑）不会被判成"到处都是"', () => {
  // 真实数据：墓碑只是一块灰石头，底色是均匀草地 → 旧版把 196 个格子都算成同类 ✗
  // 现在阈值含"中位数 + 余量"和"最高分的一个比例"，这种样例只会命中它自己
  const r = makeRaster(X0 * 2 + N * PITCH, X0 * 2 + N * PITCH);
  let seed = 99;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  for (let rr = 0; rr < N; rr++) {
    for (let cc = 0; cc < N; cc++) {
      const px = X0 + cc * PITCH, py = Y0 + rr * PITCH;
      const g = 200 + Math.round(rnd() * 20);
      fillRect(r, px, py, PITCH, PITCH, [g - 10, g, g - 20]);      // 每格底色略有不同（草地/纹理）
      // 每格再撒一点小斑点（纹理），保证"到处都有点暗的东西"
      for (let k = 0; k < 6; k++) {
        fillRect(r, px + Math.round(rnd() * (PITCH - 6)), py + Math.round(rnd() * (PITCH - 6)), 4, 4, [90, 95, 88]);
      }
    }
  }
  // 唯一一块墓碑
  fillRect(r, X0 + 2 * PITCH + 14, Y0 + 2 * PITCH + 12, 12, 16, [120, 120, 118]);
  const res = I.findSimilar(r, { x0: X0, y0: Y0, pitchX: PITCH, pitchY: PITCH, cols: N, rows: N }, 2, 2);
  assert.ok(!res.ok || res.cells.length <= 3,
    '不该匹配出一大片：' + (res.cells || []).length + ' 格 ' + JSON.stringify(res.stats));
});

test('样例取自空白格 → 明确返回 ok:false，不硬凑匹配', () => {
  const { raster, geom } = makeMap();
  const res = I.findSimilar(raster, geom, 7, 3);          // (7,3) 是空格
  assert.equal(res.ok, false, '空格子不该匹配出一堆格子：' + JSON.stringify(res.cells.slice(0, 6)));
});

test('格距变了（80px）也能用：所有判据都按格距归一', () => {
  const r = makeRaster(X0 * 2 + 6 * 80, Y0 * 2 + 6 * 80);
  fillRect(r, 0, 0, r.width, r.height, [200, 190, 170]);
  const cells = [[1, 1], [3, 4], [5, 2]];
  for (let rr = 0; rr < 6; rr++) {
    for (let cc = 0; cc < 6; cc++) fillRect(r, 20 + cc * 80, 20 + rr * 80, 80, 80, [226, 220, 205]);
  }
  cells.forEach(([rr, cc]) => chair(r, 20 + cc * 80 + 40, 20 + rr * 80 + 40, 2));
  addNoise(r, 7);
  const res = I.findSimilar(r, { x0: 20, y0: 20, pitchX: 80, pitchY: 80, cols: 6, rows: 6 }, cells[0][0], cells[0][1]);
  assert.ok(res.ok, '应找到：' + JSON.stringify(res.stats));
  assert.equal(setOf(res.cells), setOf(cells.map(([r2, c2]) => r2 + ',' + c2)), setOf(res.cells));
});

test('返回模板框与统计，便于 UI 显示"样例取自哪一格"', () => {
  const { raster, geom } = makeMap();
  const res = I.findSimilar(raster, geom, CHAIRS[0][0], CHAIRS[0][1]);
  assert.ok(res.template && res.template.w >= 15 && res.template.h >= 15, JSON.stringify(res.template));
  assert.ok(res.stats.threshold >= 0.6 && res.stats.maxScore >= res.stats.threshold, JSON.stringify(res.stats));
  assert.deepEqual(res.sample, { r: CHAIRS[0][0], c: CHAIRS[0][1] }, '应回报样例是哪一格');
  assert.equal(res.scores.length, res.cells.length, '每个候选都带一个分数');
});

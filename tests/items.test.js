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

/** 把"椅子"画到一张独立的 RGBA 小图里（当作图例卡片上抠下来的图标）；k 是缩放 */
function renderChairIcon(k) {
  const w = Math.round(22 * k), h = Math.round(26 * k);
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  const box = (x0, y0, bw, bh, c) => {
    for (let y = Math.round(y0 * k); y < Math.round((y0 + bh) * k); y++) {
      for (let x = Math.round(x0 * k); x < Math.round((x0 + bw) * k); x++) {
        if (y < 0 || y >= h || x < 0 || x >= w) continue;
        const o = (y * w + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      }
    }
  };
  box(2, 8, 18, 11, [70, 64, 58]);
  box(2, 3, 18, 4, [110, 100, 90]);
  box(3, 19, 3, 5, [60, 55, 50]);
  box(16, 19, 3, 5, [60, 55, 50]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (!img.data[o] && !img.data[o + 1] && !img.data[o + 2]) { img.data[o] = 226; img.data[o + 1] = 220; img.data[o + 2] = 205; }
  }
  return img;
}

test('图例卡片：一排图标里点哪个就只取哪个（点哪团取哪团）', () => {
  // 图例卡片常见长这样：[图标][图标][图标]  物品名文字
  // 早期实现取"窗口内所有非底色像素"的并集 → 模板变成"好几个图标的组合" ✗
  const W = 320, H = 170;
  const r = makeRaster(W, H);
  fillRect(r, 0, 0, W, H, [245, 243, 238]);                      // 卡片底色（干净白底）
  const icon = (ox, oy) => {
    fillRect(r, ox + 4, oy + 6, 34, 26, [80, 74, 68]);           // 主体
    fillRect(r, ox + 4, oy, 34, 6, [120, 112, 104]);             // 顶边
    fillRect(r, ox + 10, oy + 32, 6, 10, [70, 64, 58]);          // 腿
    fillRect(r, ox + 26, oy + 32, 6, 10, [70, 64, 58]);
  };
  icon(60, 60); icon(135, 60); icon(210, 60);                    // 三个图标并排
  fillRect(r, 250, 130, 60, 8, [60, 60, 60]);                    // 物品名文字（另一团）
  const gray = I.toGray(r);
  const cx = 135 + 21, cy = 60 + 20;                             // 点中间那个图标
  const win = 130;
  const m = I.cellMask(r, gray, W, H, cx - win / 2, cy - win / 2, win, win, { at: [cx, cy] });
  assert.ok(m, '应能在卡片上抠出一团');
  const bw = m.box.x1 - m.box.x0 + 1, bh = m.box.y1 - m.box.y0 + 1;
  assert.ok(bw <= 46 && bh <= 46, '只该抠出被点的那一个图标（约 40×42），实得 ' + bw + '×' + bh);
  // 点左边那个图标：抠出来的框应当整体往左移 75px（说明"跟着点击走"）
  const cxL = 60 + 21;                                    // 实际使用中窗口永远以点击处为中心
  const mL = I.cellMask(r, gray, W, H, cxL - win / 2, cy - win / 2, win, win, { at: [cxL, cy] });
  assert.ok(mL, '点左边的图标也该抠出一团');
  const absMid = cx - win / 2 + m.box.x0, absLeft = cxL - win / 2 + mL.box.x0;
  assert.ok(Math.abs((absMid - absLeft) - 75) <= 6,
    '两个图标相距 75px，抠出来的框也该相差 75px：' + (absMid - absLeft));
});

test('图例模板（实验性）：能找到一部分同类，且不会匹配出一大片', () => {
  // 现状说明：图例模板路线**还没调准** —— 同尺度下通常只能找到一部分同类，
  // 尺度和地图差太多、或物品本身长得平凡（墓碑那种）时基本找不到。
  // 这条测试锁定的是"下限行为"：至少能命中同类，而且不会像墓碑那次一样一次报几百格。
  const { raster, geom } = makeMap();
  // 夹具里模板和地图是同一比例，所以这里固定尺度 1；跨尺度的鲁棒性在真实地图上验证
  // （car-repair：图例里 49px 的汽车 → 地图上尺度 1.35 的两辆车，位置正确 ✓）
  const res = I.findSimilarFromTemplate(raster, geom, renderChairIcon(1), { scales: [1] });
  const cells = res.ok ? res.cells : [];
  const want = setOf(CHAIRS.map(([r, c]) => r + ',' + c)).split(' ');
  const hit = want.filter(k => cells.includes(k)).length;
  assert.ok(hit >= 1, '至少应命中一把椅子：' + hit + ' · ' + JSON.stringify(cells) + ' · ' + JSON.stringify(res.stats || res.reason));
  assert.ok(cells.length <= 10, '不该匹配出一大片：' + cells.length + ' 格');
  // 已知未解决：整块纯色的模板仍会命中十几个格子（方差防不住"模板本身没信息"这种情况），
  // 留给下一轮：模板自身要先过一道"信息量"检查（方差 / 边缘密度），再拿去匹配。
});

test('图例模板：拿石头去找椅子，误报不能泛滥（跨尺度匹配允许少量）', () => {
  const { raster, geom } = makeMap();
  // 造一个"石头"图标（纯圆），去地图上找 → 只能找到几块石头，不该把椅子也带上
  const k = 1, w = 22, h = 22;
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const d2 = (x - 11) ** 2 + (y - 11) ** 2;
    const c = d2 <= 64 ? [120, 118, 112] : [226, 220, 205];
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
  }
  const res = I.findSimilarFromTemplate(raster, geom, img);
  if (res.ok) {
    const chairKeys = setOf(CHAIRS.map(([r, c]) => r + ',' + c)).split(' ');
    const hit = res.cells.filter(kk => chairKeys.includes(kk)).length;
    assert.ok(hit <= 2, '石头模板匹配到的椅子不该超过 2 把（跨尺度匹配允许少量误报）：' + hit);
  }
});

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

test('带遮罩的模板：多尺度重采样后相关系数不会超过 1（曾经算出 1.192）', () => {
  // 回归测试：`resampleTmpl` 在缩放后必须按"遮罩内的均值"重新去均值 + 归一化，
  // 否则相关系数会大于 1，尺度选择就会挑到完全错误的尺度 ✗（真实地图上踩过）
  const { raster, geom } = makeMap();
  const icon = renderChairIcon(1);
  const w = icon.width, h = icon.height;
  const mask = new Uint8Array(w * h);
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const grey = (icon.data[o] + icon.data[o + 1] + icon.data[o + 2]) / 3;
      if (grey < 160) { mask[y * w + x] = 1; n++; }
    }
  }
  assert.ok(n > 100, '遮罩里应有足够多像素：' + n);
  for (const sc of [0.6, 0.9, 1, 1.5, 2.3]) {
    const res = I.findSimilarFromTemplate(raster, geom, icon, { mask, scales: [sc], relMin: -1, margin: -1, minScore: -1 });
    const scores = res.scores || [];
    assert.ok(scores.every(v => v <= 1.0001 && v >= -1.0001),
      '尺度 ' + sc + ' 的相关系数应在 [−1,1]：' + JSON.stringify(scores.slice(0, 6)));
  }
});

test('图例模板：可以指定排除区（图例本身画在地图上时别把自己当物品）', () => {
  const { raster, geom } = makeMap();
  const icon = renderChairIcon(1);
  const all = I.findSimilarFromTemplate(raster, geom, icon, { relMin: 0.5 });
  const [r0, c0] = CHAIRS[0];
  const box = { x: geom.x0 + c0 * geom.pitchX - 20, y: geom.y0 + r0 * geom.pitchY - 20,
    w: geom.pitchX + 40, h: geom.pitchY + 40 };
  const without = I.findSimilarFromTemplate(raster, geom, icon, { relMin: 0.5, exclude: [box] });
  const key = r0 + ',' + c0;
  if (all.ok && all.cells.includes(key)) {
    assert.ok(!without.ok || !without.cells.includes(key), '排除区里的格子不该再出现：' + JSON.stringify(without.cells));
  }
});

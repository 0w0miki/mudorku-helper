/*! 区域候选（P1）测试：合成地图上验证"连通同色块"能被正确找出来 */
const test = require('node:test');
const assert = require('node:assert');
const R = require('../js/regions.js');

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
function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** 造一张"3 个色块 + 纹理 + 图标遮挡"的地图 */
function makeMap({ cols, rows, pitch, x0, y0, icons = true, texture = true }) {
  const W = x0 * 2 + cols * pitch + 40, H = y0 * 2 + rows * pitch + 40;
  const r = makeRaster(W, H);
  fillRect(r, 0, 0, W, H, [250, 248, 242]);
  const truth = [];                       // truth[r][c] = 区域号
  const rand = rng(2026);
  const COLORS = [[206, 226, 190], [198, 216, 232], [232, 214, 176]];   // 浅绿 / 浅蓝 / 浅米
  for (let rr = 0; rr < rows; rr++) {
    truth.push([]);
    for (let cc = 0; cc < cols; cc++) {
      const zone = cc < cols / 3 ? 0 : (cc < cols * 2 / 3 ? 1 : 2);
      truth[rr].push(zone);
      const px = x0 + cc * pitch, py = y0 + rr * pitch;
      fillRect(r, px, py, pitch, pitch, COLORS[zone]);
      // 纹理：中间那块加斜线（模拟水波/草地）
      if (texture && zone === 1) {
        for (let d = 0; d < pitch; d += 6) {
          for (let t = 0; t < 3; t++) {
            const x = px + d + t, y = py + t;
            if (x < px + pitch && y < py + pitch) fillRect(r, x, y, 1, 1, [150, 175, 205]);
          }
        }
      }
      // 图标遮挡：中心 40% 一块深色
      if (icons && (rr * 5 + cc * 3) % 3 === 0) {
        const s = Math.round(pitch * 0.4);
        fillRect(r, px + Math.round((pitch - s) / 2), py + Math.round((pitch - s) / 2), s, s, [60, 55, 50]);
      }
    }
  }
  // 网格线 + 粗外框
  for (let cc = 0; cc <= cols; cc++) fillRect(r, x0 + cc * pitch, y0, 2, rows * pitch, [90, 86, 80]);
  for (let rr = 0; rr <= rows; rr++) fillRect(r, x0, y0 + rr * pitch, cols * pitch, 2, [90, 86, 80]);
  return { raster: r, truth, geom: { x0, y0, pitchX: pitch, pitchY: pitch, cols, rows } };
}

test('三个色块（含纹理与图标遮挡）：能连成三个区域', () => {
  const { raster, truth, geom } = makeMap({ cols: 12, rows: 9, pitch: 52, x0: 40, y0: 30 });
  const res = R.detectRegions(raster, geom);
  assert.ok(res.ok, '应识别出区域');
  assert.equal(res.regions.length, 3, '区域数：' + res.regions.length + ' ' + JSON.stringify(res.stats));

  // 每个检出区域应整体落在同一个真值色块里
  for (const reg of res.regions) {
    const zones = new Set();
    for (const k of reg.cells) {
      const [rr, cc] = k.split(',').map(Number);
      zones.add(truth[rr][cc]);
    }
    assert.equal(zones.size, 1, '一个检出区域跨了真值色块：' + [...zones].join(','));
  }
  // 覆盖率：三个区域的格子数应等于总格子数
  const total = res.regions.reduce((s, r2) => s + r2.size, 0);
  assert.equal(total, geom.cols * geom.rows, '所有格子都应被覆盖（' + total + '）');
  // 颜色大致对得上（检出色 vs 真值色，Lab 距离小于阈）
  for (const reg of res.regions) {
    const lab = R.srgbToLab(reg.rgb[0], reg.rgb[1], reg.rgb[2]);
    const zone = truth[reg.cells[0].split(',').map(Number)[0]][reg.cells[0].split(',').map(Number)[1]];
    const want = [[206, 226, 190], [198, 216, 232], [232, 214, 176]][zone];
    const wl = R.srgbToLab(want[0], want[1], want[2]);
    const d = Math.hypot(lab.L - wl.L, lab.a - wl.a, lab.b - wl.b);
    assert.ok(d < 12, '区域颜色偏差过大：' + d.toFixed(1) + '（' + reg.color + '）');
  }
});

test('整张同色 → 只出一个区域', () => {
  const { raster, geom } = makeMap({ cols: 6, rows: 5, pitch: 40, x0: 20, y0: 20, icons: false, texture: false });
  // 抹掉三色，改成同色
  fillRect(raster, geom.x0, geom.y0, geom.cols * 40, geom.rows * 40, [210, 225, 200]);
  const res = R.detectRegions(raster, geom);
  assert.ok(res.ok);
  assert.equal(res.regions.length, 1, '应为 1 个区域，实际 ' + res.regions.length);
  assert.equal(res.regions[0].size, 30);
});

test('越界的格子被标为不可用，而不是算成区域', () => {
  const { raster } = makeMap({ cols: 4, rows: 4, pitch: 50, x0: 10, y0: 10 });
  // 故意把行数设大，让下面几行落到图外
  const res = R.detectRegions(raster, { x0: 10, y0: 10, pitchX: 50, pitchY: 50, cols: 4, rows: 12 });
  assert.ok(res.stats.sampled < 48, '应有格子被判越界：' + res.stats.sampled);
  assert.ok(res.ok, '图内那部分仍应出区域');
});

test('取样用中位数：图标挡住中心不影响颜色判断', () => {
  const r = makeRaster(60, 60);
  fillRect(r, 0, 0, 60, 60, [200, 220, 180]);
  fillRect(r, 18, 18, 24, 24, [20, 20, 20]);          // 中心一大块黑（图标）
  const s = R.sampleCells(r, { x0: 0, y0: 0, pitchX: 60, pitchY: 60, cols: 1, rows: 1 });
  const cell = s.cells[0];
  assert.ok(cell.ok);
  assert.ok(Math.abs(cell.rgb[0] - 200) < 12 && Math.abs(cell.rgb[1] - 220) < 12,
    '颜色被图标带偏了：' + cell.rgb.join(','));
});

test('孤立的小格子（会被并进邻居）不能让识别崩溃', () => {
  // 5×5 同色，只有 (2,2) 是异色单格 → 走"过小分量并进最相似邻居"这条路径
  const { raster, geom } = makeMap({ cols: 5, rows: 5, pitch: 40, x0: 20, y0: 20, icons: false, texture: false });
  fillRect(raster, geom.x0, geom.y0, 5 * 40, 5 * 40, [210, 225, 200]);
  fillRect(raster, geom.x0 + 2 * 40 + 6, geom.y0 + 2 * 40 + 6, 28, 28, [70, 90, 120]);
  const res = R.detectRegions(raster, geom);
  assert.ok(res.ok, '不应崩溃：' + res.reason);
  assert.equal(res.regions.length, 1, '单格应被并进邻居，实际 ' + res.regions.length + ' 个区域');
  assert.equal(res.regions[0].size, 25, '应覆盖全部 25 格：' + res.regions[0].size);
});

test('同色地面 + 粗隔墙（car-repair 风格）：靠隔墙切分，不靠颜色', () => {
  // 6×6，地面**完全同色**，用粗黑隔墙分成三块（每块 2 列）
  const pitch = 60, x0 = 30, y0 = 30, N = 6;
  const r = makeRaster(x0 * 2 + N * pitch, y0 * 2 + N * pitch);
  const FLOOR = [200, 215, 225];
  fillRect(r, 0, 0, r.width, r.height, [250, 248, 242]);
  fillRect(r, x0, y0, N * pitch, N * pitch, FLOOR);
  // 细网格线（2px，深色）——不能被当成隔墙
  for (let c = 0; c <= N; c++) fillRect(r, x0 + c * pitch - 1, y0, 2, N * pitch, [90, 86, 80]);
  for (let rr = 0; rr <= N; rr++) fillRect(r, x0, y0 + rr * pitch - 1, N * pitch, 2, [90, 86, 80]);
  // 粗隔墙（6px，更深）：第 2|3 列、第 4|5 列之间
  for (const c of [2, 4]) fillRect(r, x0 + c * pitch - 3, y0, 6, N * pitch, [40, 42, 46]);
  const geom = { x0, y0, pitchX: pitch, pitchY: pitch, cols: N, rows: N };
  const out = R.detectRegions(r, geom);
  assert.ok(out.ok, '应识别出区域：' + out.reason);
  assert.equal(out.regions.length, 3, '应为 3 块（被两道隔墙分开），实际 ' + out.regions.length +
    ' 大小[' + out.stats.sizes.join(',') + '] 粗线边 ' + out.stats.boldEdges);
  const cols = out.regions.map(reg => [...new Set(reg.cells.map(k => Number(k.split(',')[1])))].sort((a, b) => a - b));
  assert.deepEqual(cols.map(c => c.join('-')), ['0-1', '2-3', '4-5'], '每块的列范围应等于真值：' + JSON.stringify(cols));
  for (const reg of out.regions) assert.equal(reg.size, 12, '每块 12 格：' + reg.size);
});

test('种子模式：区域名给出 k 与种子 → 用"边界强度"合并出恰好 k 块', () => {
  // 6×6；地面完全同色；每格之间都有 3px/深度50 的砖缝；区域隔墙是 6px/深度90
  const pitch = 60, x0 = 30, y0 = 30, N = 6;
  const r = makeRaster(x0 * 2 + N * pitch, y0 * 2 + N * pitch);
  fillRect(r, 0, 0, r.width, r.height, [250, 248, 242]);
  fillRect(r, x0, y0, N * pitch, N * pitch, [205, 190, 160]);
  // 砖缝：每一格边界都有一条（3px，中等深）
  for (let c = 1; c < N; c++) fillRect(r, x0 + c * pitch - 1, y0, 3, N * pitch, [150, 138, 112]);
  for (let rr = 1; rr < N; rr++) fillRect(r, x0, y0 + rr * pitch - 1, N * pitch, 3, [150, 138, 112]);
  // 区域隔墙（6px，更深）：第 3 列、第 3 行 → 切成 4 块 3×3
  for (const c of [3]) fillRect(r, x0 + c * pitch - 3, y0, 6, N * pitch, [40, 42, 46]);
  for (const rr of [3]) fillRect(r, x0, y0 + rr * pitch - 3, N * pitch, 6, [40, 42, 46]);
  const geom = { x0, y0, pitchX: pitch, pitchY: pitch, cols: N, rows: N };
  const seeds = [{ name: '左上', r: 1, c: 1 }, { name: '右上', r: 1, c: 4 },
                 { name: '左下', r: 4, c: 1 }, { name: '右下', r: 4, c: 4 }];
  const res = R.detectRegions(r, geom, { seeds });
  assert.ok(res.seeded, '应走种子模式');
  assert.equal(res.regions.length, 4, '应恰好 4 块：' + JSON.stringify(res.stats));
  for (const reg of res.regions) {
    assert.equal(reg.size, 9, reg.name + ' 应为 3×3=9 格：' + reg.size);
    const rs = [...new Set(reg.cells.map(k => Number(k.split(',')[0])))].sort((a, b) => a - b);
    const cs = [...new Set(reg.cells.map(k => Number(k.split(',')[1])))].sort((a, b) => a - b);
    assert.equal(rs.length, 3, '应占连续 3 行：' + rs.join(','));
    assert.equal(cs.length, 3, '应占连续 3 列：' + cs.join(','));
    assert.equal(rs[1] - rs[0], 1, '行要连续');
    assert.equal(cs[1] - cs[0], 1, '列要连续');
  }
  const names = res.regions.map(x => x.name).sort();
  assert.deepEqual(names, ['右上', '右下', '左上', '左下']);
  // 名字与位置要对上
  const find = n => res.regions.find(x => x.name === n);
  assert.ok(find('左上').cells.includes('1,1') && !find('左上').cells.includes('1,4'), '左上应含 (1,1) 不含 (1,4)');
});

test('种子模式：没有种子时不受影响（仍走颜色/粗线自适应）', () => {
  const { raster, geom } = makeMap({ cols: 6, rows: 6, pitch: 40, x0: 20, y0: 20 });
  const res = R.detectRegions(raster, geom, {});
  assert.ok(!res.seeded);
  assert.ok(res.ok, '仍应能识别');
});

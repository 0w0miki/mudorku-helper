/*! 自动对位几何层测试：用合成栅格覆盖各种劣化情形 */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../js/align.js');

// ---------------------------------------------------------------- 造图工具

function makeRaster(w, h) {
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
}
function put(r, x, y, v) {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const o = (y * r.width + x) * 4;
  r.data[o] = r.data[o + 1] = r.data[o + 2] = v;
  r.data[o + 3] = 255;
}
function fillBg(r, v) {
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) put(r, x, y, v);
}
// 可复现的伪随机
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function addNoise(r, amp, seed) {
  const rand = rng(seed);
  for (let i = 0; i < r.data.length; i += 4) {
    const d = (rand() * 2 - 1) * amp;
    r.data[i] = Math.max(0, Math.min(255, r.data[i] + d));
    r.data[i + 1] = r.data[i];
    r.data[i + 2] = r.data[i];
  }
}
/** 在灰度值之间按权重混合（等价于抗锯齿） */
function blend(r, x, y, v, wgt) {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height || wgt <= 0) return;
  const o = (y * r.width + x) * 4;
  r.data[o] = r.data[o] + (v - r.data[o]) * wgt;
  r.data[o + 1] = r.data[o];
  r.data[o + 2] = r.data[o];
  r.data[o + 3] = 255;
}
/** 抗锯齿地画一条覆盖 d 像素宽的线（真实渲染/截图就是这样的边缘） */
function paint(r, pos, along, ink, lineWidth) {
  // 覆盖 [pos, pos+lineWidth) 的区间，按面积权重分配
  for (let e = Math.floor(pos); e < pos + lineWidth; e++) {
    const wgt = Math.min(e + 1, pos + lineWidth) - Math.max(e, pos);
    for (const t of along) {
      if (r._vert) blend(r, e, t, ink, wgt);
      else blend(r, t, e, ink, wgt);
    }
  }
}
/** 画网格：竖线 x = x0 + k·pitch + shear·(y-cy)，横线 y = y0 + k·pitch + shear·(x-cx) */
function drawGrid(r, { pitch, x0 = 0, y0 = 0, lineWidth = 2, ink = 30, shear = 0 }) {
  const { width: w, height: h } = r;
  const cx = w / 2, cy = h / 2;
  r._vert = true;
  for (let k = 0; ; k++) {
    const base = x0 + k * pitch;
    if (base - Math.abs(shear) * h / 2 > w) break;
    const along = []; for (let y = 0; y < h; y++) along.push(y);
    paint(r, base + shear * (0 - cy) * 0 + (shear === 0 ? 0 : 0), along, ink, lineWidth);   // 占位，下面按行画
  }
  // 竖线：逐行计算亚像素位置（抗锯齿）
  for (let k = 0; ; k++) {
    const base = x0 + k * pitch;
    if (base - Math.abs(shear) * h / 2 > w) break;
    for (let y = 0; y < h; y++) {
      const xf = base + shear * (y - cy);
      for (let e = Math.floor(xf); e < xf + lineWidth; e++) {
        const wgt = Math.min(e + 1, xf + lineWidth) - Math.max(e, xf);
        blend(r, e, y, ink, wgt);
      }
    }
  }
  // 横线
  for (let k = -80; k <= 80; k++) {
    const base = y0 + k * pitch;
    if (base + Math.abs(shear) * w / 2 < 0) continue;
    if (base - Math.abs(shear) * w / 2 > h) break;
    for (let x = 0; x < w; x++) {
      const yf = base + shear * (x - cx);
      for (let e = Math.floor(yf); e < yf + lineWidth; e++) {
        const wgt = Math.min(e + 1, yf + lineWidth) - Math.max(e, yf);
        blend(r, x, e, ink, wgt);
      }
    }
  }
}

// ---------------------------------------------------------------- 用例

test('干净网格：pitch / 原点 / 行列数都能测出来', () => {
  const r = makeRaster(800, 600);
  fillBg(r, 255);
  drawGrid(r, { pitch: 40, x0: 25, y0: 15 });
  const d = A.detectGrid(r);
  assert.ok(d.ok, '应检出：' + d.reason);
  assert.ok(Math.abs(d.pitch.x - 40) < 1.5, 'pitchX=' + d.pitch.x);
  assert.ok(Math.abs(d.pitch.y - 40) < 1.5, 'pitchY=' + d.pitch.y);
  assert.ok(Math.abs(d.origin.x - 25) < 3, 'originX=' + d.origin.x);
  assert.ok(Math.abs(d.origin.y - 15) < 3, 'originY=' + d.origin.y);
  assert.ok(d.confidence > 0.6, 'confidence=' + d.confidence);
  assert.ok(d.lines.x.length >= 15, '竖线数=' + d.lines.x.length);
});

test('光照渐变（拍屏/拍照常见）：仍能测出 pitch', () => {
  const r = makeRaster(800, 600);
  for (let y = 0; y < 600; y++) for (let x = 0; x < 800; x++) put(r, x, y, Math.round(255 - x * 0.25));
  drawGrid(r, { pitch: 50, x0: 20, y0: 20, ink: 0 });
  // 线画成"比背景更暗"：用背景值的一半
  for (let y = 0; y < 600; y++) for (let x = 0; x < 800; x++) {
    const o = (y * 800 + x) * 4;
    if (r.data[o] === 0) put(r, x, y, Math.round((255 - x * 0.25) * 0.45));
  }
  const d = A.detectGrid(r);
  assert.ok(d.ok, '应检出：' + d.reason);
  assert.ok(Math.abs(d.pitch.x - 50) < 2, 'pitchX=' + d.pitch.x);
  assert.ok(d.confidence > 0.5, 'confidence=' + d.confidence);
});

test('噪声：加 ±18 灰阶噪声仍稳', () => {
  const r = makeRaster(800, 600);
  fillBg(r, 250);
  drawGrid(r, { pitch: 45, x0: 18, y0: 12, ink: 40 });
  addNoise(r, 18, 12345);
  const d = A.detectGrid(r);
  assert.ok(d.ok, '应检出：' + d.reason);
  assert.ok(Math.abs(d.pitch.x - 45) < 2, 'pitchX=' + d.pitch.x);
  assert.ok(Math.abs(d.pitch.y - 45) < 2, 'pitchY=' + d.pitch.y);
});

/** 把整张栅格绕中心重采样旋转（真实渲染/拍照的旋转就是这样来的） */
function rotateRaster(r, deg) {
  const { width: w, height: h } = r;
  const out = makeRaster(w, h);
  fillBg(out, 255);
  const rad = -deg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const lum = (x, y) => {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 255;
    return r.data[((y | 0) * w + (x | 0)) * 4];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = cos * dx - sin * dy + cx;
      const sy = sin * dx + cos * dy + cy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const v = lum(x0, y0) * (1 - fx) * (1 - fy) + lum(x0 + 1, y0) * fx * (1 - fy) +
                lum(x0, y0 + 1) * (1 - fx) * fy + lum(x0 + 1, y0 + 1) * fx * fy;
      put(out, x, y, v);
    }
  }
  return out;
}

test('整图旋转 2°：测出角度，摆正后 pitch 正确', () => {
  const flat = makeRaster(900, 700);
  fillBg(flat, 255);
  drawGrid(flat, { pitch: 48, x0: 30, y0: 30 });
  const r = rotateRaster(flat, 2);
  const d = A.detectGrid(r);
  assert.ok(d.ok, '应检出：' + d.reason);
  assert.ok(Math.abs(Math.abs(d.angle) - 2) < 0.6, 'angle=' + d.angle);
  assert.ok(Math.abs(d.pitch.x - 48) / 48 < 0.03, 'pitchX=' + d.pitch.x);

  // 自洽：按返回角度转回去，残余倾角应接近 0
  const { gray, w, h } = A.toGray(r, 1600);
  const back = A.estimateAngle(A.rotateGray(gray, w, h, -d.angle), w, h);
  assert.ok(Math.abs(back.angle) < 0.6, '转回后残余 angle=' + back.angle);
});

test('被裁切的地图：第一条线未必是 R1/C1，但 pitch 仍可靠', () => {
  const r = makeRaster(800, 600);
  fillBg(r, 255);
  drawGrid(r, { pitch: 60, x0: -35, y0: -35 });   // 左上角在画面外
  const d = A.detectGrid(r);
  assert.ok(d.ok, '应检出：' + d.reason);
  assert.ok(Math.abs(d.pitch.x - 60) < 2, 'pitchX=' + d.pitch.x);
  assert.ok(d.origin.x >= 0 && d.origin.x < 60, 'origin 应落在第一格内：' + d.origin.x);
  assert.ok(d.origin.x < 60 - 30, '说明左上角被切掉（origin 靠后）：' + d.origin.x);
});

test('纯噪声 / 纯白：必须明确失败，不能瞎给结果', () => {
  const noise = makeRaster(400, 400);
  const rand = rng(7);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) put(noise, x, y, Math.round(rand() * 255));
  const d1 = A.detectGrid(noise);
  assert.equal(d1.ok, false, '噪声图不该检出（' + JSON.stringify({ p: d1.pitch, c: d1.confidence }) + '）');

  const white = makeRaster(400, 400);
  fillBg(white, 255);
  assert.equal(A.detectGrid(white).ok, false, '纯白不该检出');
});

test('不依赖浏览器 API，且在 800×600 上足够快', () => {
  const r = makeRaster(800, 600);
  fillBg(r, 255);
  drawGrid(r, { pitch: 40 });
  const d = A.detectGrid(r);
  assert.ok(d.elapsedMs < 1500, '耗时 ' + d.elapsedMs + 'ms');
  assert.equal(typeof d.pitch.x, 'number');
});

test('真实感地图：区域纹理 + 图标 + 图例文字都不能骗到检测', () => {
  const P = 80, N = 24, X0 = 60, Y0 = 60;
  const r = makeRaster(X0 * 2 + P * N, Y0 * 2 + P * N);
  fillBg(r, 252);

  // 区域纹理：周期性短斜线/点阵（真实题目里草地、水波、沙地就是这样）
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const regionTone = (gx < 12 ? 128 : 176) + (gy < 8 ? 0 : 1);
      if ((gx + gy) % 3 === 0) continue;                      // 留一些"无纹理"区域
      for (let dy = 0; dy < P; dy++) {
        for (let dx = 0; dx < P; dx++) {
          const x = X0 + gx * P + dx, y = Y0 + gy * P + dy;
          if (dx >= 4 && dx <= P - 4 && dy >= 4 && dy <= P - 4) {
            const tile = ((dx * 7 + dy * 3) % 23) < 6 || ((dx + dy) % 17) < 3;
            if (tile) put(r, x, y, regionTone);
          }
        }
      }
      // 图标：格子里的小深色块（占中心 1/3）
      if ((gx * 5 + gy * 3) % 4 === 0) {
        for (let dy = Math.round(P * 0.35); dy < P * 0.65; dy++) {
          for (let dx = Math.round(P * 0.35); dx < P * 0.65; dx++) {
            put(r, X0 + gx * P + dx, Y0 + gy * P + dy, 40);
          }
        }
      }
    }
  }
  // 图例：一堆短竖条（像文字）
  for (let i = 0; i < 240; i++) {
    const x = 40 + (i % 40) * 22, y = Y0 + P * N + 30 + Math.floor(i / 40) * 34;
    for (let d = 0; d < 16; d++) put(r, x, y + d, 90);
  }
  // 网格线（细、贯穿整张地图）
  drawGrid(r, { pitch: P, x0: X0, y0: Y0, lineWidth: 2, ink: 70 });

  const dbg = A.detectGrid(r);
  console.log('   [debug] x', JSON.stringify({p:+dbg.pitch.x.toFixed(2), c:+dbg.x.contrast.toFixed(2), r:+dbg.x.ratio.toFixed(2), conf:+dbg.x.confidence.toFixed(2), n:dbg.x.count, want:dbg.x.expected}),
              '| y', JSON.stringify({p:+dbg.pitch.y.toFixed(2), c:+dbg.y.contrast.toFixed(2), r:+dbg.y.ratio.toFixed(2), conf:+dbg.y.confidence.toFixed(2)}));
  const d = dbg;
  assert.ok(d.ok, '应检出：' + d.reason + ' pitch=' + d.pitch.x.toFixed(1));
  assert.ok(Math.abs(d.pitch.x - P) < 2, '不该被纹理骗：pitchX=' + d.pitch.x.toFixed(2) + '（真值 ' + P + '）');
  assert.ok(Math.abs(d.pitch.y - P) < 2, 'pitchY=' + d.pitch.y.toFixed(2));
  assert.ok(d.cols >= N - 1 && d.cols <= N + 1, '可见列数 ' + d.cols);
});

test('框选区域：地图只占画面一部分时，别的方向的文字不再带偏', () => {
  const r = makeRaster(1200, 900);
  fillBg(r, 250);
  // 左边一块 10×8 的地图（pitch 60），右边全是"文字行"（短横杠）
  drawGrid(r, { pitch: 60, x0: 100, y0: 80, lineWidth: 2, ink: 60 });
  const rand = rng(99);
  for (let row = 0; row < 40; row++) {
    for (let i = 0; i < 26; i++) {
      const x = 760 + i * 16, y = 60 + row * 21;
      if (rand() < 0.6) continue;
      for (let d = 0; d < 9; d++) put(r, x + d, y, 90);
    }
  }
  const boxed = A.detectGrid(r, { region: { x: 100, y: 80, w: 600, h: 480 } });
  assert.ok(boxed.ok, '框选后应检出：' + boxed.reason);
  assert.ok(Math.abs(boxed.pitch.x - 60) < 2, 'pitchX=' + boxed.pitch.x);
  assert.ok(Math.abs(boxed.pitch.y - 60) < 2, 'pitchY=' + boxed.pitch.y);
  assert.ok(Math.abs(boxed.origin.x - 100) < 6, 'originX 要含框选偏移：' + boxed.origin.x);
  assert.ok(Math.abs(boxed.origin.y - 80) < 6, 'originY 要含框选偏移：' + boxed.origin.y);
});

test('暗色主题（整页反相）也能检出，并报告已反相', () => {
  const r = makeRaster(800, 600);
  fillBg(r, 20);                                   // 暗底
  drawGrid(r, { pitch: 45, x0: 20, y0: 15, lineWidth: 2, ink: 235 });   // 亮线
  const d = A.detectGrid(r);
  assert.equal(d.inverted, true, '应识别出反相');
  assert.ok(d.ok, '反相图也应检出：' + d.reason);
  assert.ok(Math.abs(d.pitch.x - 45) < 2, 'pitchX=' + d.pitch.x);
  assert.equal(A.detectGrid(makeRaster(4, 4) && r).inverted, true);
});

test('suggestPlacement：把 pitch/origin 换算成 bg.scale 与网格偏移', () => {
  const det = { ok: true, pitch: { x: 66, y: 66 }, origin: { x: 33, y: 132 }, confidence: 0.8 };
  const p = A.suggestPlacement(det, { cellSize: 44, srcW: 2048, srcH: 1400, bgW: 1600, bgH: 1094 });
  assert.ok(p.ok, p.message);
  // f = 44/66 = 0.6667；scale = f × 2048 / 1600 = 0.8533
  assert.ok(Math.abs(p.scale - 0.8533) < 0.002, 'scale=' + p.scale);
  assert.equal(p.gridX, 22);                       // 33 × 0.6667
  assert.equal(p.gridY, 88);                       // 132 × 0.6667
  // 检测失败时不能返回可用的落位
  assert.equal(A.suggestPlacement({ ok: false, reason: '未检出' }, {}).ok, false);
  // 超出缩放范围要明确拒绝，而不是硬夹
  const bad = A.suggestPlacement({ ok: true, pitch: { x: 4, y: 4 }, origin: { x: 0, y: 0 } },
    { cellSize: 44, srcW: 2048, srcH: 1400, bgW: 1600, bgH: 1094 });
  assert.equal(bad.ok, false);
  assert.ok(/超出范围/.test(bad.message), bad.message);
});

test('图片边缘有伪线时，原点不能被挪错一格', () => {
  const P = 60, X0 = 70, Y0 = 60;
  const r = makeRaster(900, 700);
  fillBg(r, 250);
  drawGrid(r, { pitch: P, x0: X0, y0: Y0, lineWidth: 2, ink: 40 });
  // 左边缘一条又短又淡的伪线（图片边框/阴影的典型样子）
  for (let y = 0; y < 60; y++) for (let d = 0; d < 1; d++) put(r, 8 + d, y, 225);
  const d = A.detectGrid(r);
  assert.ok(d.ok, '应检出：' + d.reason);
  assert.ok(Math.abs(d.pitch.x - P) < 2, 'pitchX=' + d.pitch.x);
  assert.ok(Math.abs(d.origin.x - X0) < 6, '原点不该被伪线挪一格：' + d.origin.x);
});

test('整页插画里的位图地图（P0.2 验收）：纹理/卡片/文字围着也能认出网格', () => {
  // 模仿 car-repair-color.pdf：整页插画，地图是位图、网格线细而浅，四周深色卡片与纹理
  const W = 1400, H = 1100;
  const r = makeRaster(W, H);
  fillBg(r, 236);
  const MX = 820, MY = 300, MW = 560, MH = 520, P = 56;   // 地图块：10×9 格
  const rand = rng(4242);
  // 四周：深色卡片 + 文字行 + 随机纹理
  for (let i = 0; i < 6; i++) {
    const x = 40 + (i % 2) * 380, y = 60 + Math.floor(i / 2) * 330;
    for (let dy = 0; dy < 260; dy++) for (let dx = 0; dx < 300; dx++) put(r, x + dx, y + dy, 96);
    for (let dy = 20; dy < 230; dy++) for (let dx = 20; dx < 280; dx++) put(r, x + dx, y + dy, 210);
  }
  for (let i = 0; i < 5000; i++) {
    const x = Math.floor(rand() * W), y = Math.floor(rand() * H);
    if (x > MX - 20 && x < MX + MW + 20 && y > MY - 20 && y < MY + MH + 20) continue;
    put(r, x, y, 60 + Math.floor(rand() * 60));
  }
  // 地图：浅色地板 + 家具 + 细浅网格线 + 少量粗区域边框
  for (let dy = 0; dy < MH; dy++) for (let dx = 0; dx < MW; dx++) put(r, MX + dx, MY + dy, 224);
  for (let i = 0; i < 16; i++) {
    const bx = MX + 20 + Math.floor(rand() * (MW - 120)), by = MY + 20 + Math.floor(rand() * (MH - 120));
    for (let dy = 0; dy < 60; dy++) for (let dx = 0; dx < 90; dx++) put(r, bx + dx, by + dy, 180);
  }
  for (let c = 0; c <= 10; c++) for (let y = MY; y < MY + MH; y++) put(r, MX + Math.round(c * P), y, 208);
  for (let rr = 0; rr <= 9; rr++) for (let x = MX; x < MX + MW; x++) put(r, x, MY + Math.round(rr * P), 208);
  for (let y = MY; y < MY + MH; y++) { put(r, MX + 3 * P, y, 150); put(r, MX + 7 * P, y, 150); }
  for (let x = MX; x < MX + MW; x++) put(r, x, MY + 4 * P, 150);

  const d = A.detectGrid(r, { region: { x: MX - 30, y: MY - 30, w: MW + 60, h: MH + 60 } });
  assert.ok(d.ok, '应检出：' + d.reason + ' pitch=' + d.pitch.x.toFixed(1) + '/' + d.pitch.y.toFixed(1));
  assert.ok(Math.abs(d.pitch.x - P) < 3, 'pitchX=' + d.pitch.x.toFixed(2) + '（真值 ' + P + '）');
  assert.ok(Math.abs(d.pitch.y - P) < 3, 'pitchY=' + d.pitch.y.toFixed(2));
  assert.ok(Math.abs(d.origin.x - MX) < 8, 'originX=' + d.origin.x.toFixed(1));
  assert.ok(d.squareness >= 0.9, 'squareness=' + d.squareness);
  assert.ok(d.signal === 'edge' || d.signal === 'ink', '信号=' + d.signal);
});

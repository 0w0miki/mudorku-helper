/*! Mudoku Helper — items.js
 * 物品候选：**"点一个样例 → 找同类"**（模板匹配），不是无监督聚类。
 *
 * 为什么不做"自动把物品都猜出来"：这些地图画得很密（树/石头/猪/家具/装饰混在一起，
 * 还叠着格线与区域边框），逐格聚类的实测结果是**噪声里的一堆巧合**（同一条暗色边框
 * 被当成一类"物品"，430 格并成一块）。而"同一件物品在这张图上是同一张画反复贴上去的"
 * 这一点非常可靠 —— 所以：用户点一下某个物品，我们把那一格当模板，在整张图上找
 * 所有"几乎一样"的位置，结果填进已有的物品草稿里（草稿本来就能手改格子）。
 *
 * 判据：
 *   1 先取样例格里"图标"的外接框当模板（不取整格：整格会把大片背景算进去，NCC 就没区分度）
 *   2 灰度 NCC 金字塔定位（缩小 4 倍找候选 → 候选附近全分辨率精算）拿到"像不像"
 *   3 再用**掩码 IoU** 复核形状：把两边的"深色图标掩码"都归一化到 16×16 比 IoU。
 *     NCC 对"同大小的深色团块"区分力不够（圆和方也能到 0.84），掩码 IoU + 实心程度才分得开
 *   4 多尺度（0.85 / 1.0 / 1.15）+ 尺寸/颜色复核；每个格子只留最高分
 *
 * 纯逻辑、不碰 DOM，浏览器挂 window.MurdokuItems，Node 可单测。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MurdokuItems = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCALES = [0.85, 1, 1.15];

  function toGray(raster) {
    const { data, width: W, height: H } = raster;
    const g = new Float32Array(W * H);
    for (let i = 0, o = 0; i < W * H; i++, o += 4) {
      g[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
    return g;
  }

  /** 盒式缩小（factor 倍），用于金字塔粗定位 */
  function downscale(gray, W, H, factor) {
    const w = Math.max(1, Math.floor(W / factor)), h = Math.max(1, Math.floor(H / factor));
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            const yy = y * factor + dy, xx = x * factor + dx;
            if (yy >= H || xx >= W) continue;
            s += gray[yy * W + xx]; n++;
          }
        }
        out[y * w + x] = n ? s / n : 0;
      }
    }
    return { g: out, w, h };
  }

  const GRID = 16;          // 形状描述子的分辨率

  function srgbToLab(r, g, b) {
    const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const R = f(r), G = f(g), B = f(b);
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const g2 = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    x = g2(x); y = g2(y); z = g2(z);
    return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
  }
  const labDist = (p2, q) => Math.sqrt((p2.L - q.L) ** 2 + (p2.a - q.a) ** 2 + (p2.b - q.b) ** 2);

  /**
   * 一格里的"图标掩码"：底色取格内众数颜色，**与底色差得明显的像素**都算图标
   * （不只看"更暗"：白椅子/白床这类浅色物品只有轮廓线更暗，用"只看暗"会把它们漏掉）。
   * 顺带清掉贯穿整格的直线（格线/区域边框漏进来时就是这种），并拒掉细长条。
   */
  function cellMask(raster, gray, W, H, rx0, ry0, rw, rh, options) {
    const opt = options || {};
    const padX = Math.max(1, Math.round(rw * 0.16)), padY = Math.max(1, Math.round(rh * 0.16));
    const x0 = rx0 + padX, y0 = ry0 + padY, w = rw - padX * 2, h = rh - padY * 2;
    if (w < 6 || h < 6 || x0 < 0 || y0 < 0 || x0 + w > W || y0 + h > H) return null;
    // 底色 = 4 位/通道量化后的众数，再取该桶像素的均值（比桶中心准）
    const bins = new Int32Array(4096);
    const idxOf = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = ((y0 + y) * W + x0 + x) * 4;
        bins[idxOf(raster.data[o], raster.data[o + 1], raster.data[o + 2])]++;
      }
    }
    let bestBin = 0, bestN = -1;
    for (let i2 = 0; i2 < bins.length; i2++) if (bins[i2] > bestN) { bestN = bins[i2]; bestBin = i2; }
    let sr = 0, sg = 0, sb = 0, sn = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = ((y0 + y) * W + x0 + x) * 4;
        if (idxOf(raster.data[o], raster.data[o + 1], raster.data[o + 2]) !== bestBin) continue;
        sr += raster.data[o]; sg += raster.data[o + 1]; sb += raster.data[o + 2]; sn++;
      }
    }
    if (!sn) return null;
    const base = [sr / sn, sg / sn, sb / sn];
    const diff = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = ((y0 + y) * W + x0 + x) * 4;
        diff[y * w + x] = Math.max(Math.abs(raster.data[o] - base[0]),
          Math.abs(raster.data[o + 1] - base[1]), Math.abs(raster.data[o + 2] - base[2]));
      }
    }
    const sorted = Float32Array.from(diff).sort();
    const p25 = sorted[Math.floor(sorted.length * 0.25)] || 0;
    const need = Math.max(24, p25 * 2.5);
    const mask = new Uint8Array(w * h);
    let n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (diff[y * w + x] > need) { mask[y * w + x] = 1; n++; }
    if (n < 12) return null;
    // opt.at=[px,py]（原图坐标）：**只保留包含这个点的那一团**。
    // 用途：从图例卡片上"点哪团取哪团"——一排 4 个图标里点一个就只取一个，
    // 旁边的物品名文字也自动排除（它是另一团）✗ 不这么做就只能取"窗口里所有非底色像素"的并集。
    if (opt.at) {
      const comp = componentAt(mask, w, h, Math.round(opt.at[0]) - x0, Math.round(opt.at[1]) - y0);
      if (comp && comp.n >= 12) {
        const only = new Uint8Array(w * h);
        for (const i2 of comp.cells) only[i2] = 1;
        mask.set(only);
        n = comp.n;
      }
    }
    // 清掉贯穿整格的直线（≥90% 的一整行/一整列都算图标 → 那是格线/边框，不是物品）
    const rowDark = new Int32Array(h), colDark = new Int32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { rowDark[y]++; colDark[x]++; }
    for (let y = 0; y < h; y++) if (rowDark[y] >= w * 0.9) for (let x = 0; x < w; x++) if (mask[y * w + x]) { mask[y * w + x] = 0; n--; }
    for (let x = 0; x < w; x++) if (colDark[x] >= h * 0.9) for (let y = 0; y < h; y++) if (mask[y * w + x]) { mask[y * w + x] = 0; n--; }
    if (n < 12) return null;
    let bx0 = w, bx1 = -1, by0 = h, by1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
    if (bx1 < 0) return null;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (bw < 5 || bh < 5) return null;
    // 细长条 = 格线/区域边框；但"长桌/大床"这类大件同样是细长的，
    // 区别在**它没那么薄**：只有既细长、又比格子短边还薄很多，才当成线拒掉
    if (Math.max(bw, bh) / Math.min(bw, bh) > 3.2 && Math.min(bw, bh) < Math.min(w, h) * 0.28) return null;
    const ch = [[], [], []];
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        if (!mask[y * w + x]) continue;
        const o = ((y0 + y) * W + x0 + x) * 4;
        ch[0].push(raster.data[o]); ch[1].push(raster.data[o + 1]); ch[2].push(raster.data[o + 2]);
      }
    }
    const med = k => { const a = ch[k].sort((p2, q) => p2 - q); return a[a.length >> 1] || 0; };
    const rgb = [med(0), med(1), med(2)];
    return {
      mask, w, h, box: { x0: bx0, y0: by0, x1: bx1, y1: by1, within: { x0, y0 } },
      pixels: n, bw, bh, fill: n / (bw * bh), rgb, lab: srgbToLab(rgb[0], rgb[1], rgb[2]),
    };
  }

  /** 掩码里"包含某一点"的那一团连通域（4 邻）；中心不在掩码上就取离它最近的那一团 */
  function componentAt(mask, w, h, px, py) {
    const seen = new Uint8Array(w * h);
    let seed = -1;
    if (px >= 0 && px < w && py >= 0 && py < h && mask[py * w + px]) seed = py * w + px;
    if (seed < 0) {
      let bd = Infinity;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!mask[y * w + x]) continue;
          const d = (x - px) * (x - px) + (y - py) * (y - py);
          if (d < bd) { bd = d; seed = y * w + x; }
        }
      }
    }
    if (seed < 0) return null;
    const stack = [seed];
    const cells = [];
    seen[seed] = 1;
    let n = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
    while (stack.length) {
      const i = stack.pop(), ix = i % w, iy = (i - ix) / w;
      n++; cells.push(i);
      if (ix < x0) x0 = ix; if (ix > x1) x1 = ix;
      if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || Math.abs((j % w) - ix) > 1) continue;
        if (!seen[j] && mask[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    return { n, x0, y0, x1, y1, cells };
  }

  /** 把掩码按外接框归一化成 GRID×GRID 位图（保持长宽比） */
  function shapeDesc(m) {
    const bw = m.box.x1 - m.box.x0 + 1, bh = m.box.y1 - m.box.y0 + 1;
    const scale = GRID / Math.max(bw, bh);
    const dw = Math.max(1, Math.round(bw * scale)), dh = Math.max(1, Math.round(bh * scale));
    const ox = (GRID - dw) >> 1, oy = (GRID - dh) >> 1;
    const out = new Uint8Array(GRID * GRID);
    for (let y = 0; y < dh; y++) {
      const sy = m.box.y0 + Math.min(bh - 1, Math.floor(y / scale));
      for (let x = 0; x < dw; x++) {
        const sx = m.box.x0 + Math.min(bw - 1, Math.floor(x / scale));
        if (m.mask[sy * m.w + sx]) out[(oy + y) * GRID + (ox + x)] = 1;
      }
    }
    return out;
  }

  /** 两个形状描述子的 IoU（±1 平移取最优） */
  function descIoU(a, b) {
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        let inter = 0, uni = 0;
        for (let y = 0; y < GRID; y++) {
          const by = y + dy;
          for (let x = 0; x < GRID; x++) {
            const bx = x + dx;
            const av = a[y * GRID + x];
            const bv = (bx < 0 || bx >= GRID || by < 0 || by >= GRID) ? 0 : b[by * GRID + bx];
            if (av && bv) inter++;
            if (av || bv) uni++;
          }
        }
        if (uni && inter / uni > best) best = inter / uni;
      }
    }
    return best;
  }

  /**
   * 样例格里"图标"的外接框：这类地图的物品是深色描边的插画，
   * 所以取"明显比本格底色暗"的像素的外接框（含内部浅色部分，因为物品本身常是浅色的）。
   * 只把这一小块当模板 —— 用整格当模板会把大片背景也算进去，NCC 就没区分度了
   * （实测：整格模板会把石头、装饰都算成"同类"）。
   */
  function iconBox(gray, W, H, rx0, ry0, rw, rh) {
    const padX = Math.max(1, Math.round(rw * 0.16)), padY = Math.max(1, Math.round(rh * 0.16));
    const x0 = rx0 + padX, y0 = ry0 + padY, w = rw - padX * 2, h = rh - padY * 2;
    if (w < 6 || h < 6 || x0 < 0 || y0 < 0 || x0 + w > W || y0 + h > H) return null;
    const hist = new Int32Array(32);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hist[Math.min(31, Math.max(0, Math.floor(gray[(y0 + y) * W + x0 + x] / 8)))]++;
    let mode = 0, bestN = -1;
    for (let i = 0; i < hist.length; i++) if (hist[i] > bestN) { bestN = hist[i]; mode = i; }
    const baseL = mode * 8 + 4;
    const cut = Math.min(120, baseL - 45);
    let bx0 = w, bx1 = -1, by0 = h, by1 = -1, n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (gray[(y0 + y) * W + x0 + x] >= cut) continue;
        n++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
    if (n < 12) return null;
    // 先清掉"贯穿整格的直线"：格线/区域边框被漏进来时就是这种（一整行或一整列几乎全暗）。
    // 不处理的话，一条边框会被当成"物品"，而且它在整行/整列上都"一样" ✗
    const rowDark = new Int32Array(h), colDark = new Int32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { rowDark[y]++; colDark[x]++; }
    // 阈值取 0.9：格线/边框是"几乎整条都暗"，而家具的一条横边（椅子靠背那种）只有 0.7~0.85
    for (let y = 0; y < h; y++) if (rowDark[y] >= w * 0.9) for (let x = 0; x < w; x++) if (mask[y * w + x]) { mask[y * w + x] = 0; n--; }
    for (let x = 0; x < w; x++) if (colDark[x] >= h * 0.9) for (let y = 0; y < h; y++) if (mask[y * w + x]) { mask[y * w + x] = 0; n--; }
    if (n < 12) return null;
    bx0 = w; bx1 = -1; by0 = h; by1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
    if (bx1 < 0) return null;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (bw < 5 || bh < 5) return null;
    // 细长条 = 线，不是物品（真物品最长也就 3:1）
    if (Math.max(bw, bh) / Math.min(bw, bh) > 3.2) return null;
    return { x: x0 + bx0 - 1, y: y0 + by0 - 1, w: bw + 2, h: bh + 2, pixels: n };
  }

  /** 抠一块模板并去均值归一化（NCC 用） */
  function patchAt(gray, W, H, x0, y0, w, h) {
    w = Math.max(3, Math.round(w)); h = Math.max(3, Math.round(h));
    if (x0 < 0 || y0 < 0 || x0 + w > W || y0 + h > H) return null;
    const p = new Float32Array(w * h);
    let s = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) { const v = gray[(y0 + y) * W + (x0 + x)]; p[y * w + x] = v; s += v; }
    }
    const mean = s / (w * h);
    let ss = 0;
    for (let i = 0; i < p.length; i++) { p[i] -= mean; ss += p[i] * p[i]; }
    const norm = Math.sqrt(ss) || 1;
    for (let i = 0; i < p.length; i++) p[i] /= norm;
    return { p, w, h, mean };
  }

  /** 单个位置的 NCC（模板已去均值归一化；返回 −1 表示退化） */
  function nccAt(gray, W, x0, y0, tmpl) {
    const { p, w, h } = tmpl;
    let s = 0, ss = 0, dot = 0;
    for (let y = 0; y < h; y++) {
      const rowOff = (y0 + y) * W + x0;
      for (let x = 0; x < w; x++) {
        const v = gray[rowOff + x];
        s += v; ss += v * v; dot += v * p[y * w + x];
      }
    }
    const n = w * h, mean = s / n;
    const den = Math.sqrt(Math.max(1e-6, ss - n * mean * mean));
    // 候选位置"几乎是均匀色块"时方差趋 0，相关系数会被放大成 7.8 这种离谱值 ✗
    // 所以要求这一块至少有约 3 个灰度级的标准差，否则直接判"不像"
    if (den < 3 * Math.sqrt(n)) return -1;
    return dot / den;
  }

  /** 带遮罩的得分图（模板有 mask 时用） */
  function maskedMap(gray, W, H, t, minStd) {
    const cols = Math.max(1, W - t.w + 1), rows = Math.max(1, H - t.h + 1);
    const map = new Float32Array(cols * rows).fill(-1);
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) map[ry * cols + rx] = maskedNccAt(gray, W, rx, ry, t, minStd);
    }
    return { map, cols, rows, step: 1 };
  }

  /** 把模板在图上滑一遍（步长 step），返回得分图 */
  function nccMap(gray, W, H, tmpl, step) {
    const { w, h } = tmpl;
    const cols = Math.max(1, Math.floor((W - w) / step) + 1), rows = Math.max(1, Math.floor((H - h) / step) + 1);
    const map = new Float32Array(cols * rows).fill(-1);
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        map[ry * cols + rx] = nccAt(gray, W, rx * step, ry * step, tmpl);
      }
    }
    return { map, cols, rows, step };
  }

  /** Otsu 阈值（64 桶，输入区间 [min,max]） */
  function otsu01(values, min, max) {
    if (!values.length) return 0.5;
    const bins = 64, hist = new Int32Array(bins);
    const span = (max - min) || 1;
    for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor((v - min) / span * bins)))]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += i * hist[i];
    let wB = 0, sumB = 0, best = -1, bestT = 1;
    for (let t = 0; t < bins; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; bestT = t; }
    }
    return min + (bestT + 1) / bins * span;
  }

  /**
   * 以某个格子为样例，找图上所有"几乎一样"的位置。
   * @param {{data:Uint8ClampedArray,width:number,height:number}} raster
   * @param {{x0,y0,pitchX,pitchY,cols,rows}} geom
   * @param {number} sampleR 样例所在行
   * @param {number} sampleC 样例所在列
   * @param {{inset?:number,minScore?:number,step?:number,coarse?:number,topK?:number}} [options]
   * @returns {{ok:boolean,reason?:string,cells:string[],scores:number[],template:{x,y,w,h},stats:object}}
   */
  function findSimilar(raster, geom, sampleR, sampleC, options) {
    const opt = Object.assign({ iou: 0.8, fillTol: 0.1, colourTol: 30, strongNcc: 0.9, minScore: 0.6, margin: 0.25, relMin: 0.8, step: 1, coarse: 4, topK: 200, radius: 7 }, options || {});
    const { width: W, height: H } = raster;
    if (!(W > 8) || !(H > 8)) return { ok: false, reason: '底图太小', cells: [], scores: [] };
    const gray = toGray(raster);
    const rx0 = Math.round(geom.x0 + sampleC * geom.pitchX), ry0 = Math.round(geom.y0 + sampleR * geom.pitchY);
    const rw = Math.round(geom.pitchX), rh = Math.round(geom.pitchY);
    if (rx0 < 0 || ry0 < 0 || rx0 + rw > W || ry0 + rh > H || rw < 12 || rh < 12) {
      return { ok: false, reason: '样例格在图外或太小', cells: [], scores: [] };
    }
    // 模板：格子里"深色图标"的外接框（深色物品，如树/石头/家具）；
    // 但如果那一格几乎没什么深色像素（浅色的白椅子、白床这类），就用**整格内部**当模板 ——
    // 实测这类浅色物品的掩码只有十几像素，靠它匹配会把所有同类都否掉。
    const sampleMask = cellMask(raster, gray, W, H, rx0, ry0, rw, rh);
    const insX = Math.max(1, Math.round(rw * 0.14)), insY = Math.max(1, Math.round(rh * 0.14));
    // 掩码拿不到（物品**占满整格**：长桌/大床，最常出现的颜色就是物品自己）→
    // 退化成"整格内部"当模板：此时不做掩码复核（useMask 为 false），只靠 NCC + 阈值
    let tx0, ty0, tw, th;
    if (sampleMask) {
      tx0 = Math.max(0, sampleMask.box.within.x0 + sampleMask.box.x0 - 1);
      ty0 = Math.max(0, sampleMask.box.within.y0 + sampleMask.box.y0 - 1);
      tw = Math.min(W - tx0, sampleMask.box.x1 - sampleMask.box.x0 + 3);
      th = Math.min(H - ty0, sampleMask.box.y1 - sampleMask.box.y0 + 3);
    } else {
      tx0 = rx0 + insX; ty0 = ry0 + insY;
      tw = rw - insX * 2; th = rh - insY * 2;
    }
    if (tw < 6 || th < 6 || tx0 < 0 || ty0 < 0 || tx0 + tw > W || ty0 + th > H) {
      return { ok: false, reason: '这一格的物品太小，换个格子取样', cells: [], scores: [] };
    }
    const tmpl = patchAt(gray, W, H, tx0, ty0, tw, th);
    if (!tmpl) return { ok: false, reason: '模板越界', cells: [], scores: [] };

    // ① 粗定位：缩小 coarse 倍滑一遍，留得分最高的 topK 个位置
    const K = opt.coarse;
    const cs = downscale(gray, W, H, K);
    const tmplC = patchAt(cs.g, cs.w, cs.h, Math.round(tx0 / K), Math.round(ty0 / K),
      Math.max(3, Math.round(tw / K)), Math.max(3, Math.round(th / K)));
    if (!tmplC) return { ok: false, reason: '模板太小', cells: [], scores: [] };
    const coarse = nccMap(cs.g, cs.w, cs.h, tmplC, 1);
    const cands = [];
    for (let i = 0; i < coarse.map.length; i++) if (coarse.map[i] >= 0) cands.push({ i, v: coarse.map[i] });
    cands.sort((a, b) => b.v - a.v);
    const picks = cands.slice(0, opt.topK);

    // ② 多尺度精算：只在候选位置附近按 step 找更高分
    const best = new Map();          // cellKey → {s,r,c}
    for (const sc of SCALES) {
      const twS = Math.max(6, Math.round(tw * sc)), thS = Math.max(6, Math.round(th * sc));
      const t = sc === 1 ? tmpl : patchAt(gray, W, H,
        tx0 - Math.round((twS - tw) / 2), ty0 - Math.round((thS - th) / 2), twS, thS);
      if (!t) continue;
      for (const pk of picks) {
        const px = (pk.i % coarse.cols) * K, py = Math.floor(pk.i / coarse.cols) * K;
        for (let dy = -opt.radius; dy <= opt.radius; dy += opt.step) {
          for (let dx = -opt.radius; dx <= opt.radius; dx += opt.step) {
            const x0 = px + dx + Math.round((tw - twS) / 2), y0 = py + dy + Math.round((th - thS) / 2);
            if (x0 < 0 || y0 < 0 || x0 + twS > W || y0 + thS > H) continue;
            const s = t.mask ? maskedNccAt(gray, W, x0, y0, t) : nccAt(gray, W, x0, y0, t);
            if (s <= -1) continue;
            const c = Math.floor((x0 + twS / 2 - geom.x0) / geom.pitchX);
            const r = Math.floor((y0 + thS / 2 - geom.y0) / geom.pitchY);
            if (r < 0 || c < 0 || r >= geom.rows || c >= geom.cols) continue;
            const key = r + ',' + c;
            if (!best.has(key) || s > best.get(key).s) best.set(key, { s, r, c });
          }
        }
      }
    }
    if (!best.size) return { ok: false, reason: '没找到相近的位置', cells: [], scores: [] };
    // 兜底第二遍：粗定位可能被画面里的装饰带偏（合成夹具里就出现过）。
    // 这时对**每个格子**、在粗定位峰值最高的前 2 个尺度上再精算一遍（只在这条兜底路上多花时间）。
    if (best.size <= 2) {
      const two = stat.slice(0, 2).map(x => x.sc);
      for (const sc of two) {
        const t = tmplCache.get(sc) || resampleTmpl(base, sc);
        tmplCache.set(sc, t);
        if (!t) continue;
        for (let r = 0; r < geom.rows; r++) {
          for (let c = 0; c < geom.cols; c++) {
            const cx2 = Math.round(geom.x0 + c * geom.pitchX + geom.pitchX / 2 - t.w / 2);
            const cy2 = Math.round(geom.y0 + r * geom.pitchY + geom.pitchY / 2 - t.h / 2);
            if (cx2 < 0 || cy2 < 0 || cx2 + t.w > W || cy2 + t.h > H) continue;
            if (inExclude(cx2 + t.w / 2, cy2 + t.h / 2)) continue;
            const sc2 = t.mask ? maskedNccAt(gray, W, cx2, cy2, t) : nccAt(gray, W, cx2, cy2, t);
            if (sc2 <= -1) continue;
            const key = r + ',' + c;
            const prev = best.get(key);
            if (!prev || sc2 > prev.s) best.set(key, { s: sc2, r, c, sc });
          }
        }
      }
    }
    // ③ 阈值取自这张图自己的 NCC 分布（Otsu）+ 下限。
    //    实测真实地图：同类 0.98~1.00，其它格子 ≤0.45，中间是空的 → 非常好分
    const vals = [...best.values()].map(v => v.s);
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    // 三档取大：绝对下限 / 这张图自己的 Otsu / 中位数+余量 / 最高分的一个比例。
    // 后两项是治"模板信息量太少"的：墓碑 vs 均匀草地时所有位置分都不低，
    // 只看 Otsu 会把 196 个格子都算成同类 ✗
    const thr = Math.max(opt.minScore, otsu01(vals, lo, hi), med + opt.margin, hi * opt.relMin);
    // ④ 复核（只在样例的掩码足够"厚实"时做）：比形状 IoU + 实心程度 + 颜色。
    //    掩码太薄（浅色物品只有轮廓）时不比 —— 那会把真同类全否掉（白椅子踩过这个坑）。
    const useMask = !!sampleMask && sampleMask.pixels >= 120;
    const sampleDesc = useMask ? shapeDesc(sampleMask) : null;
    const hits = [];
    for (const v of [...best.values()].filter(v2 => v2.s >= thr).sort((a, b) => b.s - a.s)) {
      // NCC 极高（≥0.9）时不必再看掩码：那已经是"几乎逐像素一样"了；
      // 掩码复核是用来挡住"NCC 中等但根本不是同类"的（同大小的深色团块容易混）
      if (useMask && v.s < opt.strongNcc) {
        const m = cellMask(raster, gray, W, H, Math.round(geom.x0 + v.c * geom.pitchX),
          Math.round(geom.y0 + v.r * geom.pitchY), rw, rh);
        if (m) {
          if (Math.abs(m.fill - sampleMask.fill) > opt.fillTol) continue;
          const sizeRatio = Math.max(m.bw, m.bh) / Math.max(sampleMask.bw, sampleMask.bh);
          if (sizeRatio < 0.7 || sizeRatio > 1.45) continue;
          if (labDist(m.lab, sampleMask.lab) > opt.colourTol) continue;
          if (descIoU(sampleDesc, shapeDesc(m)) < opt.iou) continue;
        }
      }
      hits.push({ key: v.r + ',' + v.c, iou: v.s, ncc: v.s });
    }
    // 只命中它自己 = 实质没找到同类（空格子、或这件物品全图只有一份）→ 明确说清楚
    if (hits.length <= 1) {
      return {
        ok: false,
        reason: '只找到它自己：这一格可能是空格，或者这件物品在这张图上只有一份',
        cells: [], scores: [],
        template: { x: tx0, y: ty0, w: tw, h: th }, sample: { r: sampleR, c: sampleC },
        stats: { sampled: best.size, matches: hits.length, threshold: Math.round(thr * 1000) / 1000, maxScore: Math.round(hi * 1000) / 1000 },
      };
    }
    if (!hits.length) {
      return { ok: false, reason: '没有别的格子像它（换一个更"独特"的样例试试）', cells: [], scores: [],
               template: { x: tx0, y: ty0, w: tw, h: th }, sample: { r: sampleR, c: sampleC },
               stats: { sampled: best.size, matches: 0, threshold: Math.round(thr * 1000) / 1000 } };
    }
    return {
      ok: true,
      cells: hits.map(h => h.key),
      scores: hits.map(h => Math.round(h.iou * 1000) / 1000),
      ncc: hits.map(h => Math.round(h.ncc * 1000) / 1000),
      template: { x: tx0, y: ty0, w: tw, h: th },
      sample: { r: sampleR, c: sampleC },
      stats: {
        sampled: best.size, matches: hits.length, maskChecked: useMask,
        threshold: Math.round(thr * 1000) / 1000, median: Math.round(med * 1000) / 1000,
        maxScore: Math.round(hi * 1000) / 1000,
      },
    };
  }


  /**
   * 把一张"外部模板"（图例卡片上抠下来的一块图标）变成归一化的灰度模板。
   * 与地图样例的区别只在于"模板从哪来"：一个来自地图格子，一个来自图例卡片。
   */
  function tmplFromImage(img, mask) {
    const w = Math.max(3, img.width | 0), h = Math.max(3, img.height | 0);
    const g = new Float64Array(w * h);
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, x), sy = Math.min(img.height - 1, y);
        const o = (sy * img.width + sx) * 4;
        const v = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
        g[y * w + x] = v; sum += v;
      }
    }
    const useMask = mask && mask.length === w * h;
    let cnt = 0, msum = 0;
    for (let i = 0; i < g.length; i++) if (!useMask || mask[i]) { msum += g[i]; cnt++; }
    const mean = cnt ? msum / cnt : sum / (w * h);
    let ss = 0;
    for (let i = 0; i < g.length; i++) {
      if (useMask && !mask[i]) { g[i] = 0; continue; }
      g[i] -= mean; ss += g[i] * g[i];
    }
    const norm = Math.sqrt(ss) || 1;
    for (let i = 0; i < g.length; i++) if (!useMask || mask[i]) g[i] /= norm;
    return { p: g, w, h, mask: useMask ? mask : null };
  }

  /** 把归一化模板按 k 倍重采样（最近邻）后重新归一化；有遮罩就一起缩放 */
  function resampleTmpl(t, k) {
    const w = Math.max(3, Math.round(t.w * k)), h = Math.max(3, Math.round(t.h * k));
    const g = new Float64Array(w * h);
    let m = null;
    if (t.mask) m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(t.h - 1, Math.floor(y / k));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(t.w - 1, Math.floor(x / k));
        g[y * w + x] = t.p[sy * t.w + sx];
        if (m) m[y * w + x] = t.mask[sy * t.w + sx];
      }
    }
    // 只对"遮罩内的像素"重新去均值 + 归一化。
    // **必须先减遮罩内的均值**：缩放后遮罩变了，原来"零均值"不再成立，
    // 不减的话相关系数会算出 1.192 这种 >1 的值 ✗（真实地图上踩过）
    const useMask = m && m.some(v => v);
    let cnt = 0, sum = 0;
    for (let i = 0; i < g.length; i++) if (!useMask || m[i]) { sum += g[i]; cnt++; }
    const mean = cnt ? sum / cnt : 0;
    let ss = 0;
    for (let i = 0; i < g.length; i++) {
      if (useMask && !m[i]) { g[i] = 0; continue; }
      g[i] -= mean;
      ss += g[i] * g[i];
    }
    const norm = Math.sqrt(ss) || 1;
    for (let i = 0; i < g.length; i++) if (!useMask || m[i]) g[i] /= norm;
    return { p: g, w, h, mask: useMask ? m : null };
  }

  /**
   * 带遮罩的 NCC：只在模板遮罩内的像素上算相关 —— **背景不参与**。
   * 图例卡片是干净的白底/单色底，抠出来的遮罩很准，所以这条路特别受益：
   * 同一件物品画在草地、沙地、石板上都能匹配上（用整块模板连背景比就会漏）。
   */
  function maskedNccAt(gray, W, x0, y0, t, minStd) {
    const tw = t.w;
    let sum = 0, ss = 0, dot = 0, n = 0;
    for (let i = 0; i < t.p.length; i++) {
      if (t.mask[i] !== 1) continue;
      const dy = (i - (i % tw)) / tw, dx = i % tw;
      const v = gray[(y0 + dy) * W + x0 + dx];
      sum += v; ss += v * v; dot += v * t.p[i];
      n++;
    }
    if (n < 12) return -1;
    const mean = sum / n;
    const den = Math.sqrt(Math.max(1e-6, ss - n * mean * mean));
    // 候选这块太平（方差≈0）时相关系数会被放大成离谱值 → 至少要有 minStd 个灰度级的标准差
    if (den < (minStd == null ? 3 : minStd) * Math.sqrt(n)) return -1;
    return dot / den;
  }

  /**
   * 用**外部模板**（图例卡片上的图标）在地图上找同类。
   * 与 findSimilar 的区别：模板不是从地图上取的，**尺度未知**（图例常比地图上的小/大），
   * 所以先在缩小 4 倍的金字塔上对一串尺度各滑一遍拿候选，再回全分辨率精算。
   * @param {object} raster 地图栅格 {data,width,height}
   * @param {object} geom   网格几何
   * @param {{data:Uint8ClampedArray,width:number,height:number}} img 模板图（RGBA）
   */
  function findSimilarFromTemplate(raster, geom, img, options) {
    const opt = Object.assign({
      scales: [0.75, 0.85, 1, 1.2, 1.4],   // 卡片可以缩放，让图例图标与地图上的大小接近即可；范围太大时小模板会到处瞎命中
      mask: null,                          // 可选：模板遮罩（图例卡片上抠出来的图标像素）
      exclude: null,                       // 可选：[{x,y,w,h}] 这些矩形里不找（图例本身在图上的位置）
      minScore: 0.6, margin: 0.25, relMin: 0.8, coarse: 4, perScale: 60, topK: 240, radius: 5, step: 2,
    }, options || {});
    const { width: W, height: H } = raster;
    if (!(W > 16) || !(H > 16) || !img || !img.width) return { ok: false, reason: '底图或模板太小', cells: [], scores: [] };
    const gray = toGray(raster);
    const base = tmplFromImage(img, opt.mask);
    const inExclude = (cx2, cy2) => {
      if (!opt.exclude || !opt.exclude.length) return false;
      for (const r of opt.exclude) {
        if (cx2 >= r.x && cx2 <= r.x + r.w && cy2 >= r.y && cy2 <= r.y + r.h) return true;
      }
      return false;
    };
    // ① 粗定位：每个尺度在金字塔上滑一遍。**先选尺度**：模板越小越容易瞎命中，
    //    所以用"峰值 − 中位数"（这个尺度上的信噪比）挑最合适的那个尺度，
    //    只在这个尺度（以及相邻尺度）上继续精算。
    const K = Math.max(2, Math.round(opt.coarse));
    const cs = downscale(gray, W, H, K);
    // **再粗一级**（K2 = 2K）：先在这个更小的图上整图滑一遍拿候选（像素少 4 倍 ✓，
    // 实测粗定位占了单件耗时 ~92% ✗ —— 5 个尺度各滑一遍 K=4 的整图就是大头 ✓），
    // 然后**只在候选附近**用 K=4 稀疏复筛 ✓（不再整图算 K=4 的图 ✓），
    // 最后照旧回全分辨率精算 ✓（那一步实测只占 ~8% ✓）
    const K2 = K * 2;
    const cs2 = downscale(gray, W, H, K2);
    const stat = [];
    const perScale = [];
    for (const sc of opt.scales) {
      const ct2 = resampleTmpl(base, sc / K2);
      if (ct2.w < 3 || ct2.h < 3 || ct2.w >= cs2.w || ct2.h >= cs2.h) continue;
      const map2 = ct2.mask ? maskedMap(cs2.g, cs2.w, cs2.h, ct2, 1) : nccMap(cs2.g, cs2.w, cs2.h, ct2, 1);
      // 注意：得分图的"每行有多少个位置"是 `map.cols`（= 图宽 − 模板宽 + 1），
      // **不是图宽** ✗ 用图宽换算会把候选映射到错误的位置（精算就全找不着了，踩过）
      const collect = (mm) => {
        const out = [];
        for (let i = 0; i < mm.map.length; i++) {
          if (mm.map[i] > 0) out.push({ x: i % mm.cols, y: Math.floor(i / mm.cols), v: mm.map[i] });
        }
        return out;
      };
      let stage1 = collect(map2);
      // 遮罩版一条都没命中时退回"整块模板"在这个粗尺度上再滑一次（保底；只做这一级 ✓）
      if (stage1.length < 4 && ct2.mask) {
        const map2b = nccMap(cs2.g, cs2.w, cs2.h, { p: ct2.p, w: ct2.w, h: ct2.h }, 1);
        stage1 = collect(map2b);
      }
      if (stage1.length < 4) continue;
      stage1.sort((a, b) => b.v - a.v);
      // **K=4 稀疏复筛**：只在粗候选附近（±(K2/K + 1) 个 K=4 格）逐点算，不整图 ✓
      const ct = resampleTmpl(base, sc / K);
      if (ct.w < 3 || ct.h < 3 || ct.w >= cs.w || ct.h >= cs.h) continue;
      const rad = Math.max(2, Math.round(K2 / K) + 1);
      const local = [];
      const samples = [];                     // **阈值用的样本**（多）· 候选名单只用 top perScale（少）✓
      const seenSpot = new Set();
      const tryN = Math.max(16, Math.min(stage1.length, (opt.perScale || 60) * 4));
      for (const c1 of stage1.slice(0, tryN)) {
        const bx = Math.round(c1.x * K2 / K), by = Math.round(c1.y * K2 / K);
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            const x = bx + dx, y = by + dy;
            if (x < 0 || y < 0 || x + ct.w > cs.w || y + ct.h > cs.h) continue;
            const key = x + ',' + y;
            if (seenSpot.has(key)) continue;
            seenSpot.add(key);
            let v = ct.mask ? maskedNccAt(cs.g, cs.w, x, y, ct) : -1;
            if (v <= -1) v = nccAt(cs.g, cs.w, x, y, ct);        // 遮罩版这里算不出来 → 退回整块模板 ✓
            if (v > 0) { local.push({ x, y, v, sc }); samples.push(v); }
          }
        }
      }
      if (local.length < 4) continue;
      // 阈值统计用**所有复筛过的点**（样本大，和"整图算一遍"的分布接近 ✓）；
      // 候选名单仍只用最强的 perScale 个 ✓
      // （上次半分辨率那版失败，就是样本变小 → 阈值跑偏 → 假阳性变多 ✗）
      const vals = samples.slice().sort((a, b) => a - b);
      const med = vals[vals.length >> 1], pk = vals[vals.length - 1];
      stat.push({ sc, contrast: pk - med, pk, med });
      local.sort((a, b) => b.v - a.v);
      perScale.push({ sc, list: local.slice(0, opt.perScale) });
    }
    if (!stat.length) return { ok: false, reason: '图例模板在地图上看不到相似的地方', cells: [], scores: [] };
    // 尺度：**不做"只选一个"**（粗图上选尺度会偏，把汽车认到错位置 ✗；只留前 3 个尺度
    // 也会漏掉真正的尺度 ✗），而是每个尺度都留候选一起精算、逐格取最高分。
    // 代价是"小模板可能嵌进大图案里"产生少量误报 → 由"峰值门槛 + 人工可改"兜底 ✓
    stat.sort((a, b) => (b.pk - a.pk) || (b.contrast - a.contrast));
    const cands = [];
    for (const ps of perScale) cands.push(...ps.list);
    if (!cands.length) return { ok: false, reason: '图例模板在地图上看不到相似的地方', cells: [], scores: [] };
    if (!cands.length) return { ok: false, reason: '图例模板在地图上看不到相似的地方', cells: [], scores: [] };
    if (!cands.length) return { ok: false, reason: '图例模板在地图上看不到相似的地方', cells: [], scores: [] };
    cands.sort((a, b) => b.v - a.v);
    const picks = cands.slice(0, opt.topK);
    // ② 回全分辨率精算（按各自的尺度）
    const best = new Map();
    const tmplCache = new Map();
    for (const pk of picks) {
      const sc = pk.sc;
      let t = tmplCache.get(sc);
      if (t === undefined) {
        t = resampleTmpl(base, sc);
        tmplCache.set(sc, t);
      }
      if (!t) continue;
      const px = pk.x * K, py = pk.y * K;
      for (let dy = -opt.radius; dy <= opt.radius; dy += opt.step) {
        for (let dx = -opt.radius; dx <= opt.radius; dx += opt.step) {
          const x0 = px + dx, y0 = py + dy;
          if (x0 < 0 || y0 < 0 || x0 + t.w > W || y0 + t.h > H) continue;
          if (inExclude(x0 + t.w / 2, y0 + t.h / 2)) continue;      // 图例自己那一块不算
          const s = t.mask ? maskedNccAt(gray, W, x0, y0, t) : nccAt(gray, W, x0, y0, t);
          if (s <= -1) continue;
          const c = Math.floor((x0 + t.w / 2 - geom.x0) / geom.pitchX);
          const r = Math.floor((y0 + t.h / 2 - geom.y0) / geom.pitchY);
          if (r < 0 || c < 0 || r >= geom.rows || c >= geom.cols) continue;
          const key = r + ',' + c;
          const prev = best.get(key);
          if (!prev || s > prev.s) best.set(key, { s, r, c, sc });
        }
      }
    }
    if (!best.size) return { ok: false, reason: '没找到相近的位置', cells: [], scores: [] };
    // ③ 阈值：与地图样例一致的四档
    const vals = [...best.values()].map(v => v.s);
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const hi = sorted[sorted.length - 1];
    const thr = Math.max(opt.minScore, otsu01(vals, sorted[0], hi), med + opt.margin, hi * opt.relMin);
    const hits = [...best.values()].filter(v => v.s >= thr).sort((a, b) => b.s - a.s);
    if (hits.length <= 1) {
      return {
        ok: false, reason: '只找到一处（这一格可能不是物品，或图例里选的不是它）', cells: [], scores: [],
        stats: { sampled: best.size, matches: hits.length, threshold: Math.round(thr * 1000) / 1000, maxScore: Math.round(hi * 1000) / 1000 },
      };
    }
    return {
      ok: true,
      cells: hits.map(h => h.r + ',' + h.c),
      scores: hits.map(h => Math.round(h.s * 1000) / 1000),
      scales: hits.map(h => h.sc),
      scaleStats: stat,
      template: { w: img.width, h: img.height },
      stats: {
        sampled: best.size, matches: hits.length, scale: hits[0].sc,
        threshold: Math.round(thr * 1000) / 1000, maxScore: Math.round(hi * 1000) / 1000,
      },
    };
  }

  return { findSimilar, findSimilarFromTemplate, tmplFromImage, resampleTmpl, maskedNccAt, componentAt, toGray, patchAt, nccAt, nccMap, downscale, cellMask, shapeDesc, descIoU, SCALES };
});

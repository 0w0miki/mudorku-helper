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
  function cellMask(raster, gray, W, H, rx0, ry0, rw, rh) {
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
    if (Math.max(bw, bh) / Math.min(bw, bh) > 3.2) return null;      // 细长条 = 线
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
    return den > 1e-3 ? dot / den : -1;
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
    const opt = Object.assign({ iou: 0.8, fillTol: 0.1, colourTol: 30, strongNcc: 0.9, minScore: 0.6, step: 1, coarse: 4, topK: 200, radius: 7 }, options || {});
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
    if (!sampleMask) return { ok: false, reason: '这一格里看不出明显的物品（换个格子取样）', cells: [], scores: [] };
    const tx0 = Math.max(0, sampleMask.box.within.x0 + sampleMask.box.x0 - 1);
    const ty0 = Math.max(0, sampleMask.box.within.y0 + sampleMask.box.y0 - 1);
    const tw = Math.min(W - tx0, sampleMask.box.x1 - sampleMask.box.x0 + 3);
    const th = Math.min(H - ty0, sampleMask.box.y1 - sampleMask.box.y0 + 3);
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
            const s = nccAt(gray, W, x0, y0, t);
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
    // ③ 阈值取自这张图自己的 NCC 分布（Otsu）+ 下限。
    //    实测真实地图：同类 0.98~1.00，其它格子 ≤0.45，中间是空的 → 非常好分
    const vals = [...best.values()].map(v => v.s);
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const thr = Math.max(0.6, otsu01(vals, lo, hi));
    // ④ 复核（只在样例的掩码足够"厚实"时做）：比形状 IoU + 实心程度 + 颜色。
    //    掩码太薄（浅色物品只有轮廓）时不比 —— 那会把真同类全否掉（白椅子踩过这个坑）。
    const useMask = sampleMask.pixels >= 120;
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
        threshold: Math.round(thr * 1000) / 1000, maxScore: Math.round(hi * 1000) / 1000,
      },
    };
  }

  return { findSimilar, toGray, patchAt, nccAt, nccMap, downscale, cellMask, shapeDesc, descIoU, SCALES };
});

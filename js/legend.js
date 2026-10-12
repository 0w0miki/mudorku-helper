/*! Mudoku Helper — legend.js
 * 图例卡片 → 物品清单（纯几何/文本归类，不碰 DOM，Node 可单测）。
 *
 * 为什么要自动化这一步：地图上"有哪些物品"很难猜（装饰太密），但**图例卡片**天生适合：
 * 图标彼此分离、底色统一、每个图标旁边写着名字、还分了"能放人 / 不能放人"两组。
 * 所以：切图标 → 旁边文字归给图标 → 分组说明（"Can be occupied"/"Cannot be occupied"）
 * 决定"可占据"旗标（**按说明文字判断，不靠左右位置猜**）。
 *
 * 分两步调用：
 *   const sp = split(raster);                 // 只做几何：图标、待 OCR 的文字块、分组
 *   const ocr = await readBadges(raster, sp.textBoxes);   // 交给 OCR（js/ocr.js）
 *   annotate(sp, ocr);                        // 把文字贴回图标（名字）与分组（可占据）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MurdokuLegend = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function toGray(raster) {
    const { data, width, height } = raster;
    const g = new Float32Array(width * height);
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
      g[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
    return g;
  }

  /** Otsu 阈值（64 桶） */
  function otsu01(values, min, max) {
    if (!values.length) return 0;
    const bins = 64, hist = new Int32Array(bins);
    const span = (max - min) || 1;
    for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor((v - min) / span * bins)))]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += i * hist[i];
    let wB = 0, sumB = 0, best = -1, bestT = 0;
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
   * **局部细节掩码**：按"这一小块里有多少明暗起伏"来判定，而不是"与某个底色有多不同"。
   * 真实图例是画在彩色药丸面板里的（面板又在另一种底色上），任何"全局底色"假设都会失效 ✗
   * 而图标的特点是**细节密度高**（描边 + 高光 + 阴影），面板/页底是平的 ✓
   * @returns {{mask:Uint8Array,w,h,detail:Float32Array,dw:number,dh:number,block:number}}
   */
  function detailMask(raster, opts) {
    const opt = opts || {};
    const B = opt.block || 4;
    const gray = toGray(raster);
    const { width: w, height: h } = raster;
    const dw = Math.max(1, Math.floor(w / B)), dh = Math.max(1, Math.floor(h / B));
    const detail = new Float32Array(dw * dh);
    let maxD = 0;
    for (let by = 0; by < dh; by++) {
      for (let bx = 0; bx < dw; bx++) {
        let s = 0, n = 0, mn = 255, mx = 0;
        for (let y = by * B; y < by * B + B; y++) {
          for (let x = bx * B; x < bx * B + B; x++) {
            const v = gray[y * w + x];
            s += v; n++;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        const mean = s / n;
        let dev = 0;
        for (let y = by * B; y < by * B + B; y++) {
          for (let x = bx * B; x < bx * B + B; x++) {
            const d = Math.abs(gray[y * w + x] - mean);
            if (d > dev) dev = d;
          }
        }
        detail[by * dw + bx] = Math.max(dev, (mx - mn) * 0.5);
        if (detail[by * dw + bx] > maxD) maxD = detail[by * dw + bx];
      }
    }
    // 阈值：取"细节最多的那一小撮块"。**不能用 Otsu**：真实图例里药丸面板本身有渐变/噪点，
    // Otsu 会把整块面板都算成"有细节"，于是两个面板各自变成一个巨大的"图标" ✗（踩过）
    const sorted = Array.from(detail).sort((a, b2) => a - b2);
    const q = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (opt.quantile || 0.85)))];
    const thr = Math.max(opt.minDetail || 6, Math.min(maxD, q));
    const blockMask = new Uint8Array(dw * dh);
    for (let i = 0; i < blockMask.length; i++) if (detail[i] > thr) blockMask[i] = 1;
    // 膨胀：把描边连起来（图标内部可能是平的）。**只胀 1 个块（4px）**：
    // 胀太多会把相邻的两个图标粘成一个 ✗（踩过）
    const rad = Math.max(1, Math.round(opt.dilate != null ? opt.dilate : 1));
    const grow = new Uint8Array(dw * dh);
    for (let by = 0; by < dh; by++) {
      for (let bx = 0; bx < dw; bx++) {
        if (!blockMask[by * dw + bx]) continue;
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            const yy = by + dy, xx = bx + dx;
            if (yy < 0 || xx < 0 || yy >= dh || xx >= dw) continue;
            grow[yy * dw + xx] = 1;
          }
        }
      }
    }
    const mask = new Uint8Array(w * h);
    for (let by = 0; by < dh; by++) {
      for (let bx = 0; bx < dw; bx++) {
        if (!grow[by * dw + bx]) continue;
        for (let y = by * B; y < Math.min(h, by * B + B); y++) {
          for (let x = bx * B; x < Math.min(w, bx * B + B); x++) mask[y * w + x] = 1;
        }
      }
    }
    return { mask, w, h, detail, dw, dh, block: B };
  }

  /** 与卡片底色的差异掩码：底色取"众数颜色"（图例卡片就是白底/单色底，这一步很干净） */
  function backgroundMask(raster, opts) {
    const opt = opts || {};
    const { data, width: w, height: h } = raster;
    const bins = new Int32Array(4096);
    const idx = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    for (let i = 0, o = 0; i < w * h; i++, o += 4) bins[idx(data[o], data[o + 1], data[o + 2])]++;
    let bestBin = 0, bestN = -1;
    for (let i = 0; i < bins.length; i++) if (bins[i] > bestN) { bestN = bins[i]; bestBin = i; }
    let sr = 0, sg = 0, sb = 0, sn = 0;
    for (let i = 0, o = 0; i < w * h; i++, o += 4) {
      if (idx(data[o], data[o + 1], data[o + 2]) !== bestBin) continue;
      sr += data[o]; sg += data[o + 1]; sb += data[o + 2]; sn++;
    }
    if (!sn) return null;
    const base = [sr / sn, sg / sn, sb / sn];
    const diff = new Float32Array(w * h);
    for (let i = 0, o = 0; i < w * h; i++, o += 4) {
      diff[i] = Math.max(Math.abs(data[o] - base[0]), Math.abs(data[o + 1] - base[1]), Math.abs(data[o + 2] - base[2]));
    }
    const sorted = Float32Array.from(diff).sort();
    const p25 = sorted[Math.floor(sorted.length * 0.25)] || 0;
    const need = opt.need != null ? opt.need : Math.max(24, p25 * 2.5);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) if (diff[i] > need) mask[i] = 1;
    return { mask, w, h, base };
  }

  /** 4 邻连通域 */
  function components(mask, w, h) {
    const seen = new Uint8Array(w * h);
    const out = [];
    for (let i = 0; i < mask.length; i++) {
      if (seen[i] || !mask[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let n = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
      const cells = [];
      while (stack.length) {
        const k = stack.pop(), kx = k % w, ky = (k - kx) / w;
        n++; cells.push(k);
        if (kx < x0) x0 = kx; if (kx > x1) x1 = kx;
        if (ky < y0) y0 = ky; if (ky > y1) y1 = ky;
        for (const j of [k - 1, k + 1, k - w, k + w]) {
          if (j < 0 || j >= w * h || Math.abs((j % w) - kx) > 1) continue;
          if (!seen[j] && mask[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      out.push({ n, cells, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return out;
  }

  const boxGap = (a, b) => Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const boxGapY = (a, b) => Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1));

  /** 把"离得近、尺寸不悬殊"的块并起来（椅子=靠背+坐垫+两条腿，本来就是几块） */
  function mergeNearby(comps, gap) {
    const list = comps.slice();
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < list.length && !merged; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (!a || !b) continue;
          if (boxGap(a, b) > gap || boxGapY(a, b) > gap) continue;
          const ratio = Math.max(a.h, b.h) / Math.max(1, Math.min(a.h, b.h));
          const ratioW = Math.max(a.w, b.w) / Math.max(1, Math.min(a.w, b.w));
          if (ratio > 2.6 || ratioW > 6) continue;      // 别把图标和一条长文字并到一起
          list[i] = {
            n: a.n + b.n, cells: a.cells.concat(b.cells),
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          };
          list[i].w = list[i].x1 - list[i].x0 + 1;
          list[i].h = list[i].y1 - list[i].y0 + 1;
          list.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
    return list;
  }

  /** 一行文字里的若干块并成一条"文字行" */
  function mergeTextLines(texts) {
    const list = texts.slice().sort((a, b) => a.x0 - b.x0);
    const lines = [];
    for (const t of list) {
      const same = lines.find(l => {
        const ov = Math.min(l.y1, t.y1) - Math.max(l.y0, t.y0);
        return ov > 0.5 * Math.min(l.h, t.h) && t.x0 - l.x1 <= Math.max(6, l.h * 1.2);
      });
      if (!same) { lines.push(Object.assign({}, t)); continue; }
      same.n += t.n;
      same.x0 = Math.min(same.x0, t.x0); same.x1 = Math.max(same.x1, t.x1);
      same.y0 = Math.min(same.y0, t.y0); same.y1 = Math.max(same.y1, t.y1);
      same.w = same.x1 - same.x0 + 1; same.h = same.y1 - same.y0 + 1;
    }
    return lines;
  }

  /** "可占据"判定：**根据图例里的说明文字**，不靠左右位置猜 */
  function classifyLabel(text) {
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!t) return 'unknown';
    // "cannot be occupied" / "can not" / "不可占据" / "不能放人" / "无法放置" ...
    if (/(cannot|can ?not|can't|not occup|no occup|unoccup|不可|不能|无法|禁止|不可放置|不放人)/.test(t)) return 'no';
    if (/(can be occup|occupiable|可以|可占据|可放置|能放|放人|可进入)/.test(t)) return 'yes';
    // 兜底：出现 "no"/"✗"/"×" 当成"不能"，出现 "yes"/"✓" 当成"能"
    if (/(^|\s)(no|not)(\s|$)|[✗×]/.test(t)) return 'no';
    if (/(^|\s)(yes|ok)(\s|$)|[✓√]/.test(t)) return 'yes';
    return 'unknown';
  }

  /**
   * 只做几何：切出图标、给出"待 OCR 的文字块"、按位置分组
   * @returns {{icons:Array, textBoxes:Array, groups:Array, gray:Float32Array, raster:object}}
   */
  function split(raster, options) {
    const opt = options || {};
    const bm = opt.method === 'color' ? backgroundMask(raster, opt) : detailMask(raster, opt);
    if (!bm) return { icons: [], textBoxes: [], groups: [] };
    const raw = components(bm.mask, raster.width, raster.height);
    const gap = Math.max(2, Math.round(Math.min(raster.width, raster.height) * opt.gapRatio || 4));
    const merged = mergeNearby(raw.filter(c => c.n >= (opt.minPixels || 8)), gap);
    if (!merged.length) return { icons: [], textBoxes: [], groups: [] };
    // 图标 = 高的那些；文字 = 矮扁的那些（字号远小于图标）。
    // 注意用**最高块的 55%**当门槛，而不是"中位数"：图例里文字条数往往比图标还多，
    // 中位数会落在文字上，把每条文字都当成图标 ✗（踩过）
    const maxH = merged.reduce((m, c) => Math.max(m, c.h), 0);
    const iconCut = Math.max(8, maxH * (opt.iconHeightRatio || 0.55));
    let icons = merged.filter(c => c.h >= iconCut);
    if (!icons.length) icons = merged.slice().sort((a, b) => b.n - a.n).slice(0, 1);
    const texts = merged.filter(c => !icons.includes(c));
    const lines = mergeTextLines(texts);
    const groups = groupIcons(icons);
    return {
      icons, textBoxes: lines.map(l => ({ x: l.x0, y: l.y0, w: l.w, h: l.h, line: l })),
      groups, gray: toGray(raster), raster, base: bm.base, method: opt.method || 'detail',
    };
  }

  /** 按"列"分组（图标列）；只有一列时按"行"分组 */
  function groupIcons(icons) {
    if (!icons.length) return [];
    const cols = [];
    for (const ic of icons.slice().sort((a, b) => a.x0 - b.x0)) {
      const col = cols.find(c => {
        const ov = Math.min(c.x1, ic.x1) - Math.max(c.x0, ic.x0);
        return ov > 0.6 * Math.min(c.x1 - c.x0, ic.x1 - ic.x0);
      });
      if (col) {
        col.icons.push(ic);
        col.x0 = Math.min(col.x0, ic.x0); col.x1 = Math.max(col.x1, ic.x1);
        col.y0 = Math.min(col.y0, ic.y0); col.y1 = Math.max(col.y1, ic.y1);
      } else {
        cols.push({ icons: [ic], x0: ic.x0, y0: ic.y0, x1: ic.x1, y1: ic.y1 });
      }
    }
    cols.forEach(c => { c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1; c.icons.sort((a, b) => a.y0 - b.y0); });
    if (cols.length > 1) return cols;
    // 只有一列 → 按行分（有些图例是上下两段）
    const rows = [];
    for (const ic of icons.slice().sort((a, b) => a.y0 - b.y0)) {
      const row = rows.find(r => {
        const ov = Math.min(r.y1, ic.y1) - Math.max(r.y0, ic.y0);
        return ov > 0.5 * Math.min(r.y1 - r.y0, ic.y1 - ic.y0) && Math.abs(ic.x0 - r.x0) < r.w * 0.5;
      });
      if (row) {
        row.icons.push(ic);
        row.x0 = Math.min(row.x0, ic.x0); row.x1 = Math.max(row.x1, ic.x1);
        row.y0 = Math.min(row.y0, ic.y0); row.y1 = Math.max(row.y1, ic.y1);
      } else {
        rows.push({ icons: [ic], x0: ic.x0, y0: ic.y0, x1: ic.x1, y1: ic.y1 });
      }
    }
    rows.forEach(r => { r.w = r.x1 - r.x0 + 1; r.h = r.y1 - r.y0 + 1; r.icons.sort((a, b) => a.x0 - b.x0); });
    return rows;
  }

  /**
   * 把 OCR 出来的文字贴回去：
   *  · 与某个图标"同一行、且在它旁边"的文字 → 那个图标的名字
   *  · 剩下的、离某组最近的整行文字 → 那组的说明（"可占据/不可占据"）
   * @param {object} sp split() 的结果
   * @param {Array<{x,y,text}>} ocr OCR 结果（js/ocr.js 的 readBadges 返回）
   */
  function annotate(sp, ocr) {
    const items = sp.icons.map(ic => ({ box: { x: ic.x0, y: ic.y0, w: ic.w, h: ic.h }, icon: ic, name: '', group: -1 }));
    const texts = (ocr || []).map(o => ({
      text: String(o.text || '').replace(/\s+/g, ' ').trim(),
      x0: o.x, y0: o.y,
      x1: o.x + (o.badge ? o.badge.w : 0), y1: o.y + (o.badge ? o.badge.h : 0),
    })).filter(t => t.text);
    const used = new Array(texts.length).fill(false);
    // ① 名字：同一行里"就挨着"的那块文字（图例常见两种：图标右边写名字、或名字在图标下面）
    for (const it of items) {
      let best = -1, bestScore = Infinity;
      texts.forEach((t, i) => {
        if (used[i]) return;
        // 名字只可能出现在图标的**右边**（同一行）或**下面**；
        // 出现在上方的通常是这一组的说明（"Can be occupied"那种），不能当成名字 ✗
        const below = t.y0 >= it.icon.y0 + it.icon.h * 0.5;
        const right = t.x0 >= it.icon.x1 - 2 && t.y0 < it.icon.y1 && t.y1 > it.icon.y0;
        if (!below && !right) return;
        const ovX = Math.min(it.icon.x1, t.x1) - Math.max(it.icon.x0, t.x0);
        const ovY = Math.min(it.icon.y1, t.y1) - Math.max(it.icon.y0, t.y0);
        const dx = ovX > 0 ? 0 : Math.max(it.icon.x0 - t.x1, t.x0 - it.icon.x1);
        const dy = ovY > 0 ? 0 : Math.max(it.icon.y0 - t.y1, t.y0 - it.icon.y1);
        if (dx > Math.max(2.5 * it.icon.w, 60)) return;          // 太远，不是它的名字
        if (dy > 1.2 * it.icon.h) return;                        // 差太多行
        const score = dx + dy * 1.5 + (ovX > 0 ? 0 : 6);
        if (score < bestScore) { bestScore = score; best = i; }
      });
      if (best >= 0) { it.name = texts[best].text; used[best] = true; }
    }
    // ② 分组说明：剩下的文字里，离某组"最近且在组的上方/下方"的整行
    sp.groups.forEach((g, gi) => {
      g.occupiable = null;
      g.label = '';
      let best = -1, bestD = Infinity;
      texts.forEach((t, i) => {
        if (used[i]) return;         // 已经是某个图标的名字 → 不再是分组说明
        const dx = Math.max(0, Math.max(g.x0 - t.x1, t.x0 - g.x1));
        const dy = t.y1 <= g.y0 ? g.y0 - t.y1 : (t.y0 >= g.y1 ? t.y0 - g.y1 : 0);
        const d = dy * 3 + dx;
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best >= 0 && bestD < Math.max(120, g.h * 4)) {
        used[best] = true;
        const cls = classifyLabel(texts[best].text);
        g.label = texts[best].text;
        g.occupiable = cls === 'yes' ? true : (cls === 'no' ? false : null);
      }
    });
    // ③ 图标归到组
    items.forEach(it => {
      sp.groups.forEach((g, gi) => {
        if (g.icons.includes(it.icon)) it.group = gi;
      });
    });
    sp.items = items;
    return items;
  }

  return { split, annotate, classifyLabel, backgroundMask, detailMask, otsu01, components, mergeNearby, groupIcons, toGray };
});

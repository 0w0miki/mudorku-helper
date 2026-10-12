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
    // 必须提到"能否占据"这件事，否则不算说明 —— 否则线索句里的 "not beside" 会被当成
    // "不可占据"的分组说明 ✗（真实 PDF 上踩过：一次多出一个假分组）
    const aboutOccup = /(occup|占据|放人|可进入|can be placed)/.test(t);
    if (!aboutOccup) return 'unknown';
    // "cannot be occupied" / "can not" / "不可占据" / "不能放人" / "无法放置" ...
    if (/(cannot|can ?not|can't|not occup|no occup|unoccup|不可|不能|无法|禁止|不放人)/.test(t)) return 'no';
    if (/(can be occup|occupiable|可以|可占据|可放置|能放|放人|可进入)/.test(t)) return 'yes';
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


  // ────────────────────────────────────────────────────────────────────────
  // A. PDF 文字层当骨架（最稳的一条路）
  //    为什么不再去"切图标"：真实图例画在彩色药丸面板里，像素级切分没有稳定解（见 docs）。
  //    而 PDF 有**文字层**：名字 + 精确坐标。名字的坐标本身就告诉你"这里有一件物品"，
  //    图标只需在"名字上方那条带"里取一次色差外接框即可 —— 带子很小、面板底色占主导，
  //    这一步非常稳。说明文字（Can be occupied / Cannot be occupied）同样来自文字层。
  // ────────────────────────────────────────────────────────────────────────

  /** 把 PDF 文字项按"同一行"归并（pdf.js 常把一行拆成好几个 item） */
  function mergeByLine(items) {
    const list = (items || []).filter(t => t && String(t.str || '').trim())
      .map(t => ({ str: String(t.str).trim(), x: t.x, y: t.y, w: t.w || 0, h: t.h || 10 }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const t of list) {
      const same = lines.find(l => Math.abs(l.y - t.y) <= Math.max(3, l.h * 0.5));
      if (!same) { lines.push({ str: t.str, x: t.x, y: t.y, w: t.w, h: t.h, items: [t] }); continue; }
      same.items.push(t);
      same.str = same.str + ' ' + t.str;
      const right = Math.max(same.x + same.w, t.x + t.w);
      same.x = Math.min(same.x, t.x);
      same.w = right - same.x;
      same.h = Math.max(same.h, t.h);
    }
    return lines;
  }

  /** 一行里按 x 空隙拆成若干"词块"（一行可能有几个物品名） */
  function splitByGaps(line, gapFactor) {
    const its = line.items.slice().sort((a, b) => a.x - b.x);
    const out = [];
    let cur = null;
    for (const t of its) {
      const gapNeed = Math.max(4, t.h * (gapFactor || 1.2));
      if (cur && t.x - (cur.x1) <= gapNeed) {
        cur.str += ' ' + t.str;
        cur.x1 = Math.max(cur.x1, t.x + t.w);
        cur.h = Math.max(cur.h, t.h);
      } else {
        if (cur) out.push(cur);
        cur = { str: t.str, x0: t.x, x1: t.x + t.w, y: t.y, h: t.h };
      }
    }
    if (cur) out.push(cur);
    return out.map(c => ({ str: c.str, x0: c.x0, x1: c.x1, y: c.y, h: c.h, w: c.x1 - c.x0 }));
  }

  /**
   * 在"一条带子"里找图标：底色取带内众数颜色，取与它差异明显的像素的外接框。
   * 带子 = 名字上方（或左侧）那一小块，面板底色在其中占主导，所以这一步很稳。
   */
  function findIconInBand(raster, x0, y0, x1, y1, opts) {
    const opt = opts || {};
    const W = raster.width, H = raster.height;
    const bx0 = Math.max(0, Math.round(x0)), bx1 = Math.min(W - 1, Math.round(x1));
    const by0 = Math.max(0, Math.round(y0)), by1 = Math.min(H - 1, Math.round(y1));
    if (bx1 - bx0 < 4 || by1 - by0 < 4) return null;
    const bins = new Int32Array(4096);
    const idx = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const d = raster.data;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const o = (y * W + x) * 4;
        bins[idx(d[o], d[o + 1], d[o + 2])]++;
      }
    }
    let bestBin = 0, bestN = -1;
    for (let i = 0; i < bins.length; i++) if (bins[i] > bestN) { bestN = bins[i]; bestBin = i; }
    let sr = 0, sg = 0, sb = 0, sn = 0;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const o = (y * W + x) * 4;
        if (idx(d[o], d[o + 1], d[o + 2]) !== bestBin) continue;
        sr += d[o]; sg += d[o + 1]; sb += d[o + 2]; sn++;
      }
    }
    if (!sn) return null;
    const base = [sr / sn, sg / sn, sb / sn];
    const diff = [];
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const o = (y * W + x) * 4;
        diff.push(Math.max(Math.abs(d[o] - base[0]), Math.abs(d[o + 1] - base[1]), Math.abs(d[o + 2] - base[2])));
      }
    }
    const sorted = diff.slice().sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length * 0.25)] || 0;
    const need = Math.max(opt.minDiff || 30, p25 * 3);
    let ix0 = W, ix1 = -1, iy0 = H, iy1 = -1, n = 0;
    let i = 0;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++, i++) {
        if (diff[i] <= need) continue;
        n++;
        if (x < ix0) ix0 = x; if (x > ix1) ix1 = x;
        if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
      }
    }
    if (n < (opt.minPixels || 40) || ix1 < 0) return null;
    return { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1, n };
  }

  /**
   * 从 PDF 文字层 + 渲染好的页面栅格，推出物品清单。
   * @param {Array<{str,x,y,w,h}>} textItems 文字项（坐标与 raster 同一尺度，y 为基线）
   * @param {{data,width,height}} raster 页面栅格
   * @returns {{items:Array, headings:Array, skipped:Array}}
   *   item = {name, occupiable, icon:{x,y,w,h}, heading}
   */
  function legendFromText(textItems, raster, options) {
    const opt = Object.assign({ nameBoxPad: 0.3 }, options || {});
    const lines = mergeByLine(textItems);
    // 同一行里可能有**两条**说明（真实图例就是"Can be occupied | Cannot be occupied"并排）✗
    // 所以先按 x 空隙把每行拆成"词块"，再逐块判定是说明还是物品名。
    // 空隙阈值给得宽一点（1.8 倍字高）：物品名内部的词间空隙不会这么大，不会把名字拆开 ✓
    const heads = [], nameParts = [];
    for (const ln of lines) {
      for (const part of splitByGaps(ln, 1.8)) {
        const cls = classifyLabel(part.str);
        if (cls !== 'unknown' && part.str.split(/\s+/).length <= 6) {
          heads.push({ str: part.str, x: part.x0, w: part.w, y: part.y, h: part.h, cls, occupiable: cls === 'yes' });
        } else {
          nameParts.push(part);
        }
      }
    }
    const headings = heads.map(h => ({ text: h.str, x: h.x, y: h.y, w: h.w, h: h.h, occupiable: h.occupiable }));
    // **物品名只在"说明行下方那条带"里找**：图例的结构就是
    //     [说明行] [图标行] [名字行]
    // 不限定范围的话，整页的线索/标题/区域名都会被当成物品
    // （真实 PDF 上实测一次扫出 64 件 ✗）
    let names = nameParts;
    if (heads.length) {
      const top = Math.min.apply(null, heads.map(h => h.y));
      const hh = Math.max.apply(null, heads.map(h => h.h)) || 12;
      // x 方向不设限：图例每一列常比它上面的说明行宽，限 x 会把最右边那件漏掉 ✗
      // 真正起过滤作用的是"y 在说明行下方一条带里" + "这件名字附近要能找到一个图标"
      names = nameParts.filter(nm => nm.y > top + hh * 0.5 && nm.y < top + hh * 14);
    }
    const items = [], skipped = [];
    for (const nm of names) {
      // 这一件属于哪一组：优先 x 范围重叠的说明；否则取最近的上方说明
      let head = null, bestD = Infinity;
      for (const h of heads) {
        const ov = Math.min(h.x + h.w, nm.x1) - Math.max(h.x, nm.x0);
        // 横向重叠 → 就是这组；否则按"横向还差多远"选最近的（说明行往往比它那列窄）
        const gapX = ov > 0 ? 0 : Math.min(Math.abs(nm.x0 - (h.x + h.w)), Math.abs(h.x - nm.x1));
        const d = gapX + Math.abs(nm.y - (h.y + h.h)) * 0.3;
        if (d < bestD) { bestD = d; head = h; }
      }
      const nameH = Math.max(6, nm.h);
      const pad = nameH * opt.nameBoxPad;
      // 名字上方的带子：从"最近的说明下沿"到"名字上沿"
      const bandTop = head ? Math.max(head.y + head.h, nm.y - nameH * 9) : nm.y - nameH * 9;
      const bandBottom = nm.y - nameH * 0.6;
      let icon = findIconInBand(raster, nm.x0 - pad - nameH * 0.5, bandTop, nm.x1 + pad + nameH * 0.5, bandBottom, opt);
      // 横排图例：图标在名字左边
      if (!icon) icon = findIconInBand(raster, nm.x0 - nameH * 8, nm.y - nameH * 1.5, nm.x0 - nameH * 0.4, nm.y + nameH * 0.6, opt);
      if (!icon) { skipped.push({ name: nm.str, why: '名字附近找不到图标' }); continue; }
      items.push({
        name: nm.str, occupiable: head ? head.occupiable : null,
        heading: head ? head.str : '', icon,
      });
    }
    return { items, headings, skipped, method: 'pdf-text' };
  }

  return { split, annotate, legendFromText, mergeByLine, splitByGaps, findIconInBand, classifyLabel, backgroundMask, detailMask, otsu01, components, mergeNearby, groupIcons, toGray };
});

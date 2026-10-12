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
    // 弯引号统一成直引号：真实 PDF 里写的是 "can’t be occupied"（U+2019）✗
    // 之前只认 ASCII 的 can't，导致这一条被判成"读不懂"，整组可占据旗标为空 ✗
    const t = String(text || '').toLowerCase()
      .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
      .replace(/\s+/g, ' ').trim();
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
    // 顺便把"图标像素遮罩"带出去：后面拿它当模板在地图上找同类时，
    // 用带遮罩的 NCC 只比图标像素（图例底色干净 → 遮罩准 → 背景不干扰）
    const bw = ix1 - ix0 + 1, bh = iy1 - iy0 + 1;
    const mask = new Uint8Array(bw * bh);
    i = 0;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++, i++) {
        if (diff[i] <= need) continue;
        const mx = x - ix0, my = y - iy0;
        if (mx < 0 || my < 0 || mx >= bw || my >= bh) continue;
        mask[my * bw + mx] = 1;
      }
    }
    return { x: ix0, y: iy0, w: bw, h: bh, n, mask };
  }

  /** 行投影：把 y 方向连续的"有墨"段找出来（每段 = 一排图标 或 一排名字） */
  function rowBands(mask, W, x0, x1, y0, y1, minInk, rowRatio) {
    // 先量一遍每行有多少"墨"，再按**相对阈值**切分：
    // 图例面板自己的底色在细节掩码里有残余（每行都有几十个像素），
    // 用"必须完全无墨"当分界会把整块面板粘成一个大带 ✗（真实截图实测：两排图标+两排名字
    // 粘成一个 240px 高的带）。改成"低于最密一排的 rowRatio"就算分界 ✓
    const ink = new Float64Array(Math.max(0, y1 - y0 + 1));
    let maxInk = 0;
    for (let y = y0; y <= y1; y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) if (mask[y * W + x]) n++;
      ink[y - y0] = n;
      if (n > maxInk) maxInk = n;
    }
    // 默认 0.18（合成夹具/常规卡片都用它）；**真实截图**需要更大的值（面板有底色纹理，
    // 行墨量永远不会掉到很低），由调用方显式传 rowRatio ≈ 0.4 ✓
    const thr = Math.max(minInk || 2, maxInk * (rowRatio == null ? 0.18 : rowRatio));
    const bands = [];
    let start = -1;
    for (let y = y0; y <= y1 + 1; y++) {
      const on = y <= y1 && ink[y - y0] >= thr;
      if (on && start < 0) start = y;
      if (!on && start >= 0) { bands.push({ y0: start, y1: y - 1, h: y - start }); start = -1; }
    }
    return bands;
  }

  /** 列投影：在一个 y 段里，把 x 方向连续的"有墨"段找出来（每段 = 一个图标 或 一个名字） */
  function colBands(mask, W, x0, x1, y0, y1, minInk, gap) {
    const segs = [];
    let start = -1;
    for (let x = x0; x <= x1 + 1; x++) {
      let ink = 0;
      if (x <= x1) {
        for (let y = y0; y <= y1; y++) if (mask[y * W + x]) ink++;
      }
      const on = x <= x1 && ink >= (minInk || 1);
      if (on && start < 0) start = x;
      if (!on && start >= 0) { segs.push([start, x - 1]); start = -1; }
    }
    const out = [];
    for (const s2 of segs) {
      const last = out[out.length - 1];
      if (last && s2[0] - last[1] <= (gap || 3)) { last[1] = s2[1]; continue; }
      out.push(s2.slice());
    }
    return out;
  }

  /**
   * 找"图例面板"：卡片上**大块纯色**的区域（图例都画在色块面板里）。
   * 为什么需要：真实截图除了图例，还有页面底色、地图残条、页脚版权文字……
   * 只在面板内部切分，这些就自然排除了 ✓（用户也不必把卡片框得那么准）
   * @returns {Array<{x,y,w,h,fill}>} 按像素数从多到少
   */
  function colourPanels(raster, opts) {
    const opt = opts || {};
    const W = raster.width, H = raster.height, d = raster.data;
    const bins = new Int32Array(4096);
    const idx = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    for (let i = 0, o = 0; i < W * H; i++, o += 4) bins[idx(d[o], d[o + 1], d[o + 2])]++;
    const order = Array.from(bins.keys()).sort((a, b) => bins[b] - bins[a]);
    const page = order[0];                                   // 出现最多的 = 页面底色
    const out = [];
    for (const bin of order.slice(0, 12)) {
      if (bin === page) continue;
      const n = bins[bin];
      if (n < W * H * (opt.minArea || 0.03)) break;
      // **取这个颜色最大的一团连通域**，而不是它的包围框：
      // 同一颜色可能零散出现在别处（版权字、图标高光…），包围框会横跨整张图 ✗
      const cmask = new Uint8Array(W * H);
      for (let i = 0, o = 0; i < W * H; i++, o += 4) {
        if (idx(d[o], d[o + 1], d[o + 2]) === bin) cmask[i] = 1;
      }
      const comps = components(cmask, W, H).sort((a, b2) => b2.n - a.n);
      const big = comps[0];
      if (!big || big.n < W * H * (opt.minArea || 0.03)) continue;
      const x0 = big.x0, x1 = big.x1, y0 = big.y0, y1 = big.y1, cnt = big.n;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const fill = cnt / (bw * bh);
      if (fill < (opt.minFill || 0.45)) continue;             // 太散 → 不是一块面板
      if (bw * bh > W * H * (opt.maxArea || 0.85)) continue;  // 太大 → 就是整页
      out.push({ x: x0, y: y0, w: bw, h: bh, fill });
      if (out.length >= (opt.maxPanels || 4)) break;
    }
    return out;
  }

  /**
   * **卡片图例解析（多排也能处理）**：contest 的图例是"一个说明行 + 两排图标"，
   * 直接对整张卡片做列投影会把两排的图标并成一根根跨排的柱子 ✗。
   * 正确顺序：先按**行投影**切出每一排（图标排 / 名字排），再在每排内部做**列投影**，
   * 然后把"图标排"与紧跟在它下面的"名字排"一一配对（按 x 中心最近）✓
   * @returns {Array<{box:{x,y,w,h}, nameBox:{x,y,w,h}|null}>}
   */
  function readCardLegend(raster, rect, options) {
    const opt = options || {};
    // 先找"图例面板"（大块纯色）—— 截图里除了图例还有页面底色/地图残条/页脚版权文字，
    // 只在面板内部切分，这些杂东西自然被排除 ✓（卡片也就不用框得那么准了）
    const panels = opt.noPanels ? [] : colourPanels(raster, opt);
    if (panels.length) {
      const items = [], headings = [];
      for (const p of panels) {
        const r2 = readRectLegend(raster, p, opt);
        items.push(...r2.items);
        headings.push(...r2.headings);
      }
      if (items.length >= 2) return { items, headings, panels };
    }
    return readRectLegend(raster, rect, opt);
  }

  /** 在一个矩形里切分（readCardLegend 的实现部分） */
  function readRectLegend(raster, rect, options) {
    const opt = options || {};
    const W = raster.width, H = raster.height;
    const x0 = Math.max(0, Math.round(rect.x)), x1 = Math.min(W - 1, Math.round(rect.x + rect.w - 1));
    const y0 = Math.max(0, Math.round(rect.y)), y1 = Math.min(H - 1, Math.round(rect.y + rect.h - 1));
    if (x1 - x0 < 12 || y1 - y0 < 12) return { items: [], headings: [] };
    const dm = detailMask(raster, opt);
    let bands = rowBands(dm.mask, W, x0, x1, y0, y1, Math.max(2, (x1 - x0) * 0.01), opt.rowRatio);
    // 丢掉太薄的噪声带
    bands = bands.filter(b => b.h >= 5);
    // 同一排图标有时被内部空隙切成两段（棕榈树的树干、椅子腿之间…）→ 间隙很小的相邻带先并起来 ✓
    // 不并的话"图标排 ↔ 名字排"会配错，件数也不对（真实截图实测：17 件被切成 12 件）
    const merged = [];
    for (const b of bands) {
      const last = merged[merged.length - 1];
      const gap = last ? b.y0 - last.y1 - 1 : 1e9;
      if (last && gap <= Math.max(2, Math.min(last.h, b.h) * 0.15)) {
        last.y1 = b.y1;
        last.h = last.y1 - last.y0 + 1;
        continue;
      }
      merged.push({ y0: b.y0, y1: b.y1, h: b.h });
    }
    bands = merged;
    if (!bands.length) return { items: [], headings: [] };
    const hs = bands.map(b => b.h).sort((a, b) => a - b);
    const maxH = hs[hs.length - 1];
    // 名字排 = 明显矮的那些（名字字号远小于图标）。阈值取"最高排的 65%"：
    // 细节掩码的阴晕会把名字排抬高几像素，取 0.5 会把名字排误判成图标排 ✗
    // （两排图例因此被切成 12 个碎片，踩过）
    const isName = b => b.h <= Math.max(8, maxH * 0.65);
    const rows = [];
    const usedAsName = new Set();
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (isName(b)) continue;
      // 紧跟在它下面的名字排（间隙不超过 1.5 个名字高）
      const next = bands[i + 1];
      const name = next && isName(next) && (next.y0 - b.y1) <= Math.max(6, next.h * 2.5) ? next : null;
      if (name) usedAsName.add(i + 1);
      rows.push({ icons: b, name });
    }
    // 没被当成名字排的矮带 = 说明行候选（"can't be occupied" 那种）→ 交给 OCR 判定可占据 ✓
    const headingBands = bands
      .map((b, i) => ({ b, i }))
      .filter(x => isName(x.b) && !usedAsName.has(x.i))
      .map(x => ({ x: x0, y: x.b.y0, w: x1 - x0 + 1, h: x.b.h }));
    const out = [];
    for (const row of rows) {
      // **用"名字排"当骨架**：名字之间有明显空隙，切得准；图标本身是几块拼的（椅子=靠背+坐垫+腿），
      // 直接切图标会被内部空隙切成好几块 ✗（踩过）。所以：名字列 → 该列上方那一段墨水的外接框 = 图标 ✓
      if (row.name) {
        // 间隙阈值 0.5 个字高：相邻两个名字之间要切开（截图实测 0.8 会把
        // "flowers shark"、"barrel shelf shrub table boulder" 并成一个 ✗），
        // 而多词名字内部（Oil Slick / Garbage bin）的空隙更小，不会被拆散 ✓
        // 列阈值也用"相对"的：名字带里同样有面板底色残余，用"只要 >0 就算有字"
        // 会把相邻两个名字并起来 ✗（实测 "flowers shark"、"table boulder" 被并）
        let nameMaxCol = 0;
        for (let x = x0; x <= x1; x++) {
          let n = 0;
          for (let y = row.name.y0; y <= row.name.y1; y++) if (dm.mask[y * W + x]) n++;
          if (n > nameMaxCol) nameMaxCol = n;
        }
        const nc = colBands(dm.mask, W, x0, x1, row.name.y0, row.name.y1,
          Math.max(2, Math.round(nameMaxCol * 0.15)), Math.max(3, row.name.h * 0.5));
        for (const ns of nc) {
          const w = ns[1] - ns[0] + 1;
          if (w < 4) continue;
          const pad = Math.max(4, Math.round(row.name.h * 0.8));
          const bx0 = Math.max(x0, ns[0] - pad), bx1 = Math.min(x1, ns[1] + pad);
          let ix0 = W, ix1 = -1, iy0 = H, iy1 = -1, n = 0;
          for (let x = bx0; x <= bx1; x++) {
            for (let y = row.icons.y0; y <= row.icons.y1; y++) {
              if (!dm.mask[y * W + x]) continue;
              n++;
              if (x < ix0) ix0 = x; if (x > ix1) ix1 = x;
              if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
            }
          }
          if (n < 20 || ix1 < 0) continue;
          out.push({
            box: { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 },
            nameBox: { x: ns[0], y: row.name.y0, w, h: row.name.h },
          });
        }
        continue;
      }
      // 没有名字排（图例不写名字）→ 退回图标排的列投影
      const ic = colBands(dm.mask, W, x0, x1, row.icons.y0, row.icons.y1,
        Math.max(1, row.icons.h * 0.06), Math.max(3, row.icons.h * 0.12));
      for (const s2 of ic) {
        const w = s2[1] - s2[0] + 1;
        if (w < Math.max(6, row.icons.h * 0.3)) continue;
        out.push({ box: { x: s2[0], y: row.icons.y0, w, h: row.icons.h }, nameBox: null });
      }
    }
    return { items: out, headings: headingBands };
  }

  /**
   * 卡片框内没有文字名时（contest 那种：图例物品在文字层里没名字）：
   * 用**列投影**把一排图标切开 —— 一维投影比二维连通域稳得多：
   * 面板的渐变只是抬高一点点基线，而图标会在列投影上形成一串明显的峰 ✓
   * @param {object} raster 页面栅格
   * @param {{x,y,w,h}} rect 卡片在页面栅格里的位置（图例区域）
   * @returns {Array<{x,y,w,h,n}>} 每个图标一个框
   */
  function splitIconsByColumns(raster, rect, options) {
    const opt = options || {};
    const W = raster.width, H = raster.height;
    const rx = Math.max(0, Math.round(rect.x)), ry = Math.max(0, Math.round(rect.y));
    const rx1 = Math.min(W - 1, Math.round(rect.x + rect.w - 1)), ry1 = Math.min(H - 1, Math.round(rect.y + rect.h - 1));
    if (rx1 - rx < 8 || ry1 - ry < 8) return [];
    const dm = detailMask(raster, opt);
    const col = new Float64Array(W);
    let maxCol = 0;
    for (let x = rx; x <= rx1; x++) {
      let n = 0;
      for (let y = ry; y <= ry1; y++) if (dm.mask[y * W + x]) n++;
      col[x] = n;
      if (n > maxCol) maxCol = n;
    }
    if (maxCol < 2) return [];
    const thr = Math.max(2, maxCol * (opt.colRatio || 0.25));
    const segs = [];
    let start = -1;
    for (let x = rx; x <= rx1 + 1; x++) {
      const on = x <= rx1 && col[x] >= thr;
      if (on && start < 0) start = x;
      if (!on && start >= 0) { segs.push({ x0: start, x1: x - 1 }); start = -1; }
    }
    if (!segs.length) return [];
    const widths = segs.map(s2 => s2.x1 - s2.x0 + 1).sort((a, b) => a - b);
    const medW = widths[widths.length >> 1];
    const merged = [];
    for (const s2 of segs) {
      const last = merged[merged.length - 1];
      if (last && s2.x0 - last.x1 <= Math.max(3, medW * 0.25)) { last.x1 = s2.x1; continue; }
      merged.push({ x0: s2.x0, x1: s2.x1 });
    }
    const out = [];
    for (const s2 of merged) {
      const w = s2.x1 - s2.x0 + 1;
      if (w < Math.max(6, medW * 0.4)) continue;
      let y0 = H, y1 = -1, n = 0;
      for (let x = s2.x0; x <= s2.x1; x++) {
        for (let y = ry; y <= ry1; y++) {
          if (!dm.mask[y * W + x]) continue;
          n++;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (n < (opt.minPixels || 30) || y1 < 0 || y1 - y0 < 5) continue;
      out.push({ x: s2.x0, y: y0, w, h: y1 - y0 + 1, n });
    }
    return out;
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
    // 有卡片框时**只在框里找**（用户框出来的就是图例区域，这比任何启发式都可靠 ✓）
    let src = textItems || [];
    if (opt.rects && opt.rects.length) {
      src = src.filter(t => opt.rects.some(r2 => {
        const cx2 = (t.x || 0) + (t.w || 0) / 2, cy2 = (t.y || 0) + (t.h || 0) / 2;
        return cx2 >= r2.x && cx2 <= r2.x + r2.w && cy2 >= r2.y && cy2 <= r2.y + r2.h;
      }));
    }
    const lines = mergeByLine(src);
    // 同一行里可能有**两条**说明（真实图例就是"Can be occupied | Cannot be occupied"并排）✗
    // 所以先按 x 空隙把每行拆成"词块"，再逐块判定是说明还是物品名。
    // 空隙阈值给得宽一点（1.8 倍字高）：物品名内部的词间空隙不会这么大，不会把名字拆开 ✓
    const heads = [], nameParts = [];
    for (const ln of lines) {
      // 间隙阈值 0.6 个字高：既能拆开相邻的两件物品名（contest 的 flowers/shark），
      // 又不会把多词名字（Oil Slick / Garbage bin）拆散 ✓
      for (const part of splitByGaps(ln, 0.6)) {
        part.line = ln;                   // 记住它来自哪一行（成段判定要跳过自己那一行）
        const cls = classifyLabel(part.str);
        if (cls !== 'unknown' && part.str.split(/\s+/).length <= 6) {
          heads.push({ str: part.str, x: part.x0, w: part.w, y: part.y, h: part.h, cls, occupiable: cls === 'yes' });
          ln.__isHeading = true;      // 这一行里有说明 → 成段判据要放过它（它本来就贴着图例）
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
      const hh = Math.max.apply(null, heads.map(h => h.h)) || 12;
      // 每条说明行**上下各 14 个字高**都算它的图例区。
      // 以前只取"最上面那条说明行往下 30 个字高" ✗ —— 说明行画在图例**下方**时整块都够不着 ✓
      // x 方向不设限：图例每一列常比说明行宽，限 x 会把最右边那件漏掉 ✗
      const reach = hh * 14;
      names = nameParts.filter(nm => heads.some(h => nm.y > h.y - reach && nm.y < h.y + reach));
    }
    // 三条硬判据（不然整页的线索句子都会被当成物品 ✗ —— familymurdoku/contest 上踩过）：
    //   ① 不像句子：不超过 3 个词、不含句读
    //   ② 不成段：上下一行半内没有另一行文字与它横向重叠（图例里的名字是孤立的）
    //   ③ 图标必须"正上方且尺寸合理"（在下面第三步里查）
    const looksLikeProse = (txt) => {
      const t2 = String(txt || '').trim();
      if (!t2) return true;
      const words = t2.split(/\s+/).filter(Boolean);
      if (words.length > 3) return true;
      if (/[.,;:!?…]/.test(t2)) return true;
      // 全大写 = 地图上的**区域名**（RECEPTION / WAITING AREA / TEACHER'S AREA…），不是物品名 ✗
      // （这三份真实 PDF 里图例物品名都是 Title case 或小写；区域名一律全大写）
      const letters = t2.replace(/[^A-Za-z]/g, '');
      // 单个字母（规则图里的 A / B 标注）不是物品名 ✓（"TV" 两个字符合法，所以门槛取 2）
      if (letters.length < 2) return true;
      // 坐标标签（C9 / C24 / R1）那种"短、带数字"的串不是物品名 ✓（contest 页面底部就有 C1~C24）
      if (/^[A-Za-z]{0,2}\d+$/.test(t2)) return true;
      // 全大写 = 区域名（RECEPTION / WAITING AREA / TEACHER'S AREA…）不是物品名 ✗
      if (letters.length >= 4 && letters === letters.toUpperCase()) return true;
      return false;
    };
    const isStacked = (piece) => lines.some(ln => {
      if (piece.line && ln === piece.line) return false;                  // 自己那一行（按对象比）
      if (ln.__isHeading) return false;                                  // 说明行不是正文 ✗
      if (Math.abs(ln.y - piece.y) < 0.5) return false;                   // 自己那一行（按坐标比）
      const ov = Math.min(ln.x + ln.w, piece.x1) - Math.max(ln.x, piece.x0);
      if (ov < 0.4 * (piece.x1 - piece.x0)) return false;
      const dy = Math.abs(ln.y - piece.y);
      return dy > 0 && dy < piece.h * 2.2;
    });
    const items = [], skipped = [];
    for (const nm of names) {
      if (looksLikeProse(nm.str)) { skipped.push({ name: nm.str, why: '像句子，不是物品名' }); continue; }
      if (isStacked(nm)) { skipped.push({ name: nm.str, why: '上下还有别的文字（像正文）' }); continue; }
      // 这一件属于哪一组：优先 x 范围重叠的说明；否则取最近的上方说明
      let head = null, bestD = Infinity;
      for (const h of heads) {
        const ov = Math.min(h.x + h.w, nm.x1) - Math.max(h.x, nm.x0);
        const gapX = ov > 0 ? 0 : Math.min(Math.abs(nm.x0 - (h.x + h.w)), Math.abs(h.x - nm.x1));
        // **优先"名字正上方的说明行"**：真实图例里说明行就在那一组的上面
        // （contest：上两排属于 can't be occupied，下面那排属于 can be occupied）。
        // 只看横向距离会按 x 归错组 ✗（左边的 fire/tree 会被归到右边那条说明下）
        const above = h.y < nm.y && (nm.y - h.y) < 40 * h.h;
        // 说明行也可能画在图例**下方**（有些图例是"图标在上面、说明在下面"）✓
        const below = h.y > nm.y && (h.y - nm.y) < 40 * h.h;
        // "上方"永远优先于"下方"：图例一般从上方标注；只有下方才有说明时才用下方 ✓
        // （否则页面底部那条说明会把上面那组的物品全都吸走 ✗，contest 上踩过）
        const d = above ? (nm.y - h.y) + gapX * 0.05
          : below ? 1e5 + (h.y - nm.y) * 1.5 + gapX * 0.2
          : 1e6 + gapX + Math.abs(nm.y - (h.y + h.h)) * 0.3;
        if (d < bestD) { bestD = d; head = h; }
      }
      const nameH = Math.max(6, nm.h);
      const pad = nameH * opt.nameBoxPad;
      // 名字上方的带子：从"最近的说明下沿"到"名字上沿"
      // 图标带：**只取名字正上方一小条**（4.5 个字高）。取太高会把上一排的图标和名字
      // 都包进来 → 外接框巨大 → 被尺寸判据否掉 ✗（contest 的两排图例就是这样只剩 5 件）
      // 只有当说明行确实在名字**上方**时才用它当下界；说明行在下方时用它会把带子弄反 ✗
      const headAbove = !!(head && head.y + head.h <= nm.y);
      const bandTop = headAbove ? Math.max(head.y + head.h, nm.y - nameH * 4.5) : nm.y - nameH * 4.5;
      const bandBottom = nm.y - nameH * 0.6;
      let icon = findIconInBand(raster, nm.x0 - pad - nameH * 0.5, bandTop, nm.x1 + pad + nameH * 0.5, bandBottom, opt);
      // 横排图例：图标在名字左边
      if (!icon) icon = findIconInBand(raster, nm.x0 - nameH * 8, nm.y - nameH * 1.5, nm.x0 - nameH * 0.4, nm.y + nameH * 0.6, opt);
      if (!icon) { skipped.push({ name: nm.str, why: '名字附近找不到图标' }); continue; }
      // 图标判据：图标要"落在名字这一列上"（中心在名字范围左右各 1 个字高内）+ 尺寸合理。
      // 不用"重叠 ≥50%"：图例里名字常是居中或左对齐，硬要求重叠会把真物品挡掉 ✗（踩过）
      const iconCx = icon.x + icon.w / 2;
      const verticalLayout = icon.y + icon.h <= nm.y + nameH;      // 图标在名字上方
      if (verticalLayout && (iconCx < nm.x0 - nameH || iconCx > nm.x1 + nameH)) {
        skipped.push({ name: nm.str, why: '上方的图案不在这一列' });
        continue;
      }
      const ratio = icon.h / nameH;
      if (ratio < 1.1 || ratio > 6) { skipped.push({ name: nm.str, why: '上方图案尺寸不像图标（' + ratio.toFixed(1) + '×字高）' }); continue; }
      items.push({
        name: nm.str, occupiable: head ? head.occupiable : null,
        heading: head ? head.str : '', icon, __name: { x0: nm.x0, x1: nm.x1, y: nm.y, h: nameH },
      });
    }
    // 最后一道关：**图例里的物品名是排成一行（或一列）的**。
    // 用"最大的一组对齐块"来检查：如果认出来的东西散落各处（比如把规则图里的
    // ROW / COLUMN 当成物品），说明这张图的图例根本不在这里 → 宁可说"没找到" ✗
    const groups = [];
    for (const it of items) {
      const nm = namePartsOf(it);
      // 容差按**名字高度**算（不是图标高度）：图标比名字高两三倍，用图标高度当容差会把
      // 散落各处的文字也凑成"一排" ✗（contest 上把规则图里的 ROW/COLUMN 凑成了一排）
      let g = groups.find(g2 => Math.abs(g2.y - nm.y) <= 1.5 * nm.h);
      if (!g) { g = { y: nm.y, list: [] }; groups.push(g); }
      g.list.push(it);
    }
    // 判据：**成排的比例**要够高。真实图例是 1~3 排（contest 就是 7+7+3 三排），
    // 而"把散落的正文当物品"时几乎个个单独成排 ✗ → 用"至少 2 个一组的比例"来区分 ✓
    const aligned = groups.reduce((a, g2) => a + (g2.list.length >= 2 ? g2.list.length : 0), 0);
    if (items.length >= 2 && aligned < items.length * 0.6) {
      return {
        items: [], headings, skipped: skipped.concat(items.map(it => ({ name: it.name, why: '物品名没有排成行/列，这张图可能没有图例' }))),
        method: 'pdf-text', reason: '没找到成排的图例物品名（这一页的文字层里可能没有物品名）',
      };
    }
    return { items, headings, skipped, method: 'pdf-text' };
  }

  /** 从 item 里拿回它的名字位置（给"排成行"判定用） */
  function namePartsOf(it) { return it.__name || { x0: it.icon ? it.icon.x : 0, y: it.icon ? it.icon.y : 0 };
  }

  return { split, annotate, legendFromText, readCardLegend, colourPanels, rowBands, colBands, splitIconsByColumns, mergeByLine, splitByGaps, findIconInBand, classifyLabel, backgroundMask, detailMask, otsu01, components, mergeNearby, groupIcons, toGray };
});

/*! Mudorku Helper — regions.js
 * 区域候选：在**已经对好位**的地图上，逐格取样 → 判断相邻格是否同属一个区域 →
 * 连通分量就是候选区域。纯逻辑、不依赖 DOM，浏览器里挂 window.MurdokuRegions。
 *
 * 为什么不用全局聚类：题目的区域 = 「四连通的同色/同纹块」。用相邻格的相似度做连通，
 * 不需要事先知道区域数量 k，也不需要手调阈值（Otsu 自动切）。
 *
 * 取样位置：每格取**内缩边框环**，不取中心——中心通常被家具/物品图标盖住。
 * 每格用**中位数**而不是均值，少数图标像素不会把颜色带偏。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MurdokuRegions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 颜色工具

  /** sRGB(0-255) → Lab（D65）。区域靠 a* 与 b* 区分最稳。 */
  function srgbToLab(r, g, b) {
    const f = v => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const R = f(r), G = f(g), B = f(b);
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const g2 = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    x = g2(x); y = g2(y); z = g2(z);
    return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
  }

  // ---------------------------------------------------------------- 取样

  /**
   * 逐格取样。返回每格的特征：
   *   lab   —— 中位数颜色（对图标/文字鲁棒）
   *   edge  —— 边框环里"强梯度像素"的比例（区分草地/水波/木纹这类纹理）
   *   luma  —— 中位亮度
   * @param {{data:Uint8ClampedArray,width:number,height:number}} raster
   * @param {{x0:number,y0:number,pitchX:number,pitchY:number,cols:number,rows:number}} geom
   */
  function sampleCells(raster, geom, options) {
    // inset：中心多大范围不采（避开图标/家具）
    // pad  ：贴着格线的那一圈也不采（网格线/粗外框就画在格界上，混进来会把边缘格
    //        的纹理特征抬高，导致整片同色地图被切成"边缘一圈 + 中间一块"）
    const opt = Object.assign({ inset: 0.28, pad: 0.07 }, options || {});
    const { data, width: W, height: H } = raster;
    const { x0, y0, pitchX, pitchY, cols, rows } = geom;

    // 全图梯度幅值（一次算好，供纹理特征用）
    const mag = new Float32Array(W * H);
    const gray = new Float32Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = gray[i + 1] - gray[i - 1];
        const gy = gray[i + W] - gray[i - W];
        mag[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }

    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px0 = Math.round(x0 + c * pitchX), py0 = Math.round(y0 + r * pitchY);
        const px1 = Math.round(x0 + (c + 1) * pitchX), py1 = Math.round(y0 + (r + 1) * pitchY);
        const w = px1 - px0, h = py1 - py0;
        if (w < 3 || h < 3 || px0 < 0 || py0 < 0 || px1 > W || py1 > H) {
          cells.push({ r, c, ok: false, reason: '越界或太小' });
          continue;
        }
        const mx = Math.max(1, Math.round(w * opt.inset));
        const my = Math.max(1, Math.round(h * opt.inset));
        const padX = Math.max(1, Math.round(w * opt.pad));
        const padY = Math.max(1, Math.round(h * opt.pad));
        const histR = new Int32Array(256), histG = new Int32Array(256), histB = new Int32Array(256);
        let n = 0, strong = 0, gradSum = 0;
        for (let y = py0; y < py1; y++) {
          const dy = Math.min(y - py0, py1 - 1 - y);
          if (dy < padY) continue;                          // 贴着横格线的一圈不采
          const inCoreY = dy >= my;
          for (let x = px0; x < px1; x++) {
            const dx = Math.min(x - px0, px1 - 1 - x);
            if (dx < padX) continue;                        // 贴着竖格线的一圈不采
            if (inCoreY && dx >= mx) continue;              // 中心核心不采
            const p = (y * W + x) * 4;
            histR[data[p]]++; histG[data[p + 1]]++; histB[data[p + 2]]++;
            const m = mag[y * W + x];
            gradSum += m;
            if (m > 90) strong++;
            n++;
          }
        }
        if (n < 8) { cells.push({ r, c, ok: false, reason: '取样太少' }); continue; }
        const medOf = hist => {
          let acc = 0;
          for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) return v; }
          return 255;
        };
        const R = medOf(histR), G = medOf(histG), B = medOf(histB);
        const lab = srgbToLab(R, G, B);
        cells.push({
          r, c, ok: true, key: r + ',' + c, rgb: [R, G, B], lab,
          edge: strong / n, grad: gradSum / n,
        });
      }
    }
    return { cells, mag };
  }

  // ---------------------------------------------------------------- 连通

  /** 相邻格之间的特征距离（色度为主，纹理/亮度次之） */
  function cellDistance(A, B) {
    const dL = A.lab.L - B.lab.L;
    const da = A.lab.a - B.lab.a;
    const db = A.lab.b - B.lab.b;
    const de = A.edge - B.edge;
    return Math.sqrt(dL * dL * 1.0 + da * da * 2.4 + db * db * 2.4 + de * de * 400);
  }

  /** Otsu 阈值（一维直方图，64 桶） */
  function otsu1d(values, maxV) {
    if (!values.length) return 0;
    const bins = 64;
    const hist = new Int32Array(bins);
    for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor(v / maxV * bins)))]++;
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
    return (bestT + 1) / bins * maxV;
  }

  /** 格子的中位亮度（由取到的中位色算） */
  function cellLuma(cell) {
    return 0.299 * cell.rgb[0] + 0.587 * cell.rgb[1] + 0.114 * cell.rgb[2];
  }

  /**
   * 探两格共享边上有没有"粗隔墙"。
   *
   * 区域边框/隔墙是画在格界上的深色粗线，而网格线往往也是深色——区别在**粗细**：
   * 取跨边 ±band 的窄带（band=2 → 5px），用【中位数】作代表值：
   *   · 细网格线（1~2px）只占窄带少数 → 中位数仍是格子颜色 → drop≈0，不算粗线
   *   · 粗隔墙（≥4px）占满窄带     → 中位数落在墙上     → drop 大，算边界
   * 两格颜色可以完全一样（car-repair 的地面就是），所以"有没有这条线"是比颜色更根本的判据。
   */
  function borderProbe(raster, geom, r, c, dir, lumaA, lumaB, options) {
    const opt = Object.assign(
      { span: 6, samples: 5, depthAbs: 22, depthRel: 0.09, minWidth: 4 }, options || {});
    const { data, width: W, height: H } = raster;
    const { x0, y0, pitchX, pitchY } = geom;
    const px0 = Math.round(x0 + c * pitchX), py0 = Math.round(y0 + r * pitchY);
    const px1 = Math.round(x0 + (c + 1) * pitchX), py1 = Math.round(y0 + (r + 1) * pitchY);
    const span = Math.max(2, Math.round(opt.span));
    const n = span * 2 + 1;
    const acc = new Float64Array(n);
    const cnt = new Int32Array(n);
    const lumaAt = (x, y) => {
      const o = (y * W + x) * 4;
      return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    };
    const samples = Math.max(3, Math.round(opt.samples));
    for (let s2 = 0; s2 < samples; s2++) {
      const t = 0.25 + 0.5 * (samples === 1 ? 0.5 : s2 / (samples - 1));   // 沿边取 25%~75%
      if (dir === 'right') {
        const y = Math.round(py0 + (py1 - py0) * t);
        for (let i = 0; i < n; i++) {
          const x = px1 - span + i;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          acc[i] += lumaAt(x, y); cnt[i]++;
        }
      } else {
        const x = Math.round(px0 + (px1 - px0) * t);
        for (let i = 0; i < n; i++) {
          const y = py1 - span + i;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          acc[i] += lumaAt(x, y); cnt[i]++;
        }
      }
    }
    const prof = [];
    for (let i = 0; i < n; i++) prof.push(cnt[i] ? acc[i] / cnt[i] : 255);
    const cellsLuma = (lumaA + lumaB) / 2;
    const need = Math.max(opt.depthAbs, cellsLuma * opt.depthRel);
    // 找"比两格明显更暗"的连续段，最长的一段就是线宽
    let best = 0, cur = 0;
    for (let i = 0; i < n; i++) {
      if (prof[i] < cellsLuma - need) { cur++; if (cur > best) best = cur; }
      else cur = 0;
    }
    const minLuma = Math.min.apply(null, prof);
    return {
      width: best,
      depth: Math.round((cellsLuma - minLuma) * 10) / 10,
      bold: best >= opt.minWidth,
    };
  }

  function unionFind(n) {
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const find = x => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    return { find, union: (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p[rb] = ra; } };
  }

  // ---------------------------------------------------------------- 主入口

  /**
   * 找出候选区域。
   * @returns {{ok:boolean,reason?:string,regions:Array<{cells:string[],color:string,rgb:number[],size:number}>,
   *            stats:object}}
   */
  function detectRegions(raster, geom, options) {
    const opt = Object.assign({ minSize: 2, mergeRatio: 0.55 }, options || {});
    const { cols, rows } = geom;
    if (!(cols > 0) || !(rows > 0)) return { ok: false, reason: '行列数为 0', regions: [] };
    const { cells } = sampleCells(raster, geom, opt);
    const idx = new Int32Array(cols * rows).fill(-1);
    const list = [];
    for (const cell of cells) {
      if (!cell.ok) continue;
      idx[cell.r * cols + cell.c] = list.length;
      list.push(cell);
    }
    if (list.length < 2) return { ok: false, reason: '可用格子太少（' + list.length + '）', regions: [] };

    // 相邻边 + 距离
    const edges = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = idx[r * cols + c];
        if (i < 0) continue;
        const li = list[i], lumI = cellLuma(li);
        if (c + 1 < cols) {
          const j = idx[r * cols + c + 1];
          if (j >= 0) {
            const bd = borderProbe(raster, geom, r, c, 'right', lumI, cellLuma(list[j]), opt);
            edges.push({ i, j, d: cellDistance(li, list[j]), bold: bd.bold, drop: bd.drop });
          }
        }
        if (r + 1 < rows) {
          const j = idx[(r + 1) * cols + c];
          if (j >= 0) {
            const bd = borderProbe(raster, geom, r, c, 'down', lumI, cellLuma(list[j]), opt);
            edges.push({ i, j, d: cellDistance(li, list[j]), bold: bd.bold, drop: bd.drop });
          }
        }
      }
    }
    if (!edges.length) return { ok: false, reason: '没有相邻格', regions: [] };
    // 阈值只用"没有粗线"的相邻对来标定：这样它反映的是这张地图**同一个区域内部**的
    // 颜色波动，而不是被跨区域的巨大色差拉偏（拿不到双峰时退到 45 分位）
    const open = edges.filter(e => !e.bold);
    const ds = (open.length >= 4 ? open : edges).map(e => e.d);
    const maxD = Math.max.apply(null, ds);
    let t = otsu1d(ds, Math.max(1, maxD)) * 1.15;
    const sorted = [...ds].sort((a, b) => a - b);
    if (!(t > 0) || t >= maxD) t = sorted[Math.floor(sorted.length * 0.45)] || maxD * 0.5;

    // 判据按地图风格自适应：
    //  · 有粗隔墙的地图（car-repair：地面同色，靠墙分区）→ **只看粗线**，颜色不参与
    //    （隔墙两侧颜色一模一样，颜色判据必然连成一片）
    //  · 只有颜色差异的地图（contest 那种色块）→ 靠颜色，阈值由"无粗线"的相邻对标定
    const boldRatio = edges.length ? edges.filter(e => e.bold).length / edges.length : 0;
    const walls = boldRatio >= 0.06;
    const uf = unionFind(list.length);
    for (const e of edges) {
      const same = walls ? !e.bold : e.d <= t;
      if (same) uf.union(e.i, e.j);
    }

    const groups = new Map();
    list.forEach((cell, i) => {
      const root = uf.find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    });
    let comps = [...groups.values()].map(ids => {
      const rgb = [0, 1, 2].map(k => {
        const v = ids.map(i => list[i].rgb[k]).sort((a, b) => a - b);
        return v[v.length >> 1];
      });
      const lab = { L: 0, a: 0, b: 0 };
      for (const i of ids) { lab.L += list[i].lab.L; lab.a += list[i].lab.a; lab.b += list[i].lab.b; }
      lab.L /= ids.length; lab.a /= ids.length; lab.b /= ids.length;
      return { ids, rgb, lab, size: ids.length };
    });

    // 太小的分量：并进"最相似的相邻分量"
    const compOf = new Map();      // cellIndex → compIndex
    const rebuild = () => {
      compOf.clear();
      // cp 可能是 null：上面把"太小被并走"的分量置成了 null，遍历时必须跳过，
      // 否则整条识别会直接抛异常（用户点按钮时表现为"什么都没发生"）
      comps.forEach((cp, ci) => { if (cp) cp.ids.forEach(i => compOf.set(i, ci)); });
    };
    rebuild();
    // 只沿"没有粗隔墙"的边找邻居：否则会把隔墙两侧、但平均色相近的两个区域重新并起来
    const adjacentComps = ci => {
      const out = new Map();
      for (const e of edges) {
        if (e.bold) continue;
        const a = compOf.get(e.i), b = compOf.get(e.j);
        if (a === ci && b !== ci) out.set(b, Math.min(out.get(b) ?? Infinity, e.d));
        if (b === ci && a !== ci) out.set(a, Math.min(out.get(a) ?? Infinity, e.d));
      }
      return out;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (let ci = 0; ci < comps.length; ci++) {
        const cp = comps[ci];
        if (!cp || cp.size >= opt.minSize) continue;
        const nb = adjacentComps(ci);
        if (!nb.size) continue;
        let best = -1, bestD = Infinity;
        for (const [cj, d] of nb) {
          const cd = Math.sqrt(
            (cp.lab.L - comps[cj].lab.L) ** 2 + (cp.lab.a - comps[cj].lab.a) ** 2 + (cp.lab.b - comps[cj].lab.b) ** 2);
          if (cd + d * 0.2 < bestD) { bestD = cd + d * 0.2; best = cj; }
        }
        if (best < 0) continue;
        comps[best].ids = comps[best].ids.concat(cp.ids);
        comps[best].size += cp.size;
        comps[ci] = null;
        rebuild();
        changed = true;
        break;
      }
    }
    comps = comps.filter(Boolean);

    // 相邻且颜色几乎一样的分量合并（修正过分割）
    let merged = true;
    while (merged) {
      merged = false;
      rebuild();
      outer: for (let a = 0; a < comps.length; a++) {
        for (let b = a + 1; b < comps.length; b++) {
          const nb = adjacentComps(a);
          if (!nb.has(b)) continue;
          const dLab = Math.sqrt(
            (comps[a].lab.L - comps[b].lab.L) ** 2 + (comps[a].lab.a - comps[b].lab.a) ** 2 +
            (comps[a].lab.b - comps[b].lab.b) ** 2);
          if (dLab < t * opt.mergeRatio) {
            comps[a].ids = comps[a].ids.concat(comps[b].ids);
            comps[a].size += comps[b].size;
            comps.splice(b, 1);
            merged = true;
            break outer;
          }
        }
      }
    }

    const hex = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
    const regions = comps.map(cp => ({
      cells: cp.ids.map(i => list[i].key),
      rgb: cp.rgb,
      color: hex(cp.rgb),
      size: cp.size,
      lab: cp.lab,
    })).sort((a, b) => b.size - a.size);

    return {
      ok: regions.length > 0,
      regions,
      stats: {
        sampled: list.length, total: cols * rows, edges: edges.length,
        boldEdges: edges.filter(e => e.bold).length, walls,
        threshold: Math.round(t * 10) / 10,
        sizes: regions.map(r => r.size),
        medianEdge: Math.round((list.reduce((s, c) => s + c.edge, 0) / list.length) * 1000) / 1000,
      },
    };
  }

  return { detectRegions, sampleCells, cellDistance, cellLuma, borderProbe, srgbToLab, otsu1d };
});

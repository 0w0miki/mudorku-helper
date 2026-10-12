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
      { span: 6, samples: 9, depthAbs: 22, depthRel: 0.09, minWidth: 3 }, options || {});
    const { data, width: W, height: H } = raster;
    const { x0, y0, pitchX, pitchY } = geom;
    const px0 = Math.round(x0 + c * pitchX), py0 = Math.round(y0 + r * pitchY);
    const px1 = Math.round(x0 + (c + 1) * pitchX), py1 = Math.round(y0 + (r + 1) * pitchY);
    // 窗口 ±6px（放宽到 ±0.15 格试过：car-repair 只是把错分从一处挪到另一处，未采纳）
    const span = Math.max(2, Math.round(opt.span));
    const n = span * 2 + 1;
    const lumaAt = (x, y) => {
      const o = (y * W + x) * 4;
      return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    };
    const cellsLuma = (lumaA + lumaB) / 2;
    const need = Math.max(opt.depthAbs, cellsLuma * opt.depthRel);
    const samples = Math.max(3, Math.round(opt.samples));
    // 沿**整条边**均匀取截面（不只中间那段）：被家具挡住的地方会空出来，
    // 用"覆盖率"表示这条边上有多长是墙，而不是要求整条边都连续是墙
    let covered = 0, maxWidth = 0, maxDepth = 0, lastDarkFrac = 0;
    for (let si = 0; si < samples; si++) {
      const t = 0.06 + 0.88 * (si / (samples - 1));
      const prof = [];
      if (dir === 'right') {
        const y = Math.round(py0 + (py1 - py0) * t);
        for (let i = 0; i < n; i++) {
          const x = px1 - span + i;
          if (x < 0 || y < 0 || x >= W || y >= H) { prof.push(255); continue; }
          prof.push(lumaAt(x, y));
        }
      } else {
        const x = Math.round(px0 + (px1 - px0) * t);
        for (let i = 0; i < n; i++) {
          const y = py1 - span + i;
          if (x < 0 || y < 0 || x >= W || y >= H) { prof.push(255); continue; }
          prof.push(lumaAt(x, y));
        }
      }
      let best = 0, cur = 0;
      for (let i = 0; i < n; i++) {
        if (prof[i] < cellsLuma - need) { cur++; if (cur > best) best = cur; }
        else cur = 0;
      }
      let minL = 255, darkPx = 0;
      for (const v of prof) { if (v < minL) minL = v; if (v < cellsLuma - need) darkPx++; }
      const depth = Math.round((cellsLuma - minL) * 10) / 10;
      const darkFrac = darkPx / n;
      lastDarkFrac = darkFrac;
      if (best > maxWidth) maxWidth = best;
      if (depth > maxDepth) maxDepth = depth;
      // 是墙：够宽、够深，而且**只占窗口一部分**（大块暗区 darkFrac≈1 → 不是墙）
      if (best >= opt.minWidth && depth >= need) covered++;   // 备注：darkFrac（窗口暗像素占比）仍会输出，供诊断判断"是墙还是大块暗区"
    }
    const coverage = covered / samples;
    return {
      coverage: Math.round(coverage * 1000) / 1000,
      width: maxWidth, depth: maxDepth, darkFrac: Math.round(lastDarkFrac * 100) / 100,
      bold: coverage >= 0.6,
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
            const wall = (bd.coverage || 0) * Math.min(1, Math.max(0, ((bd.width || 0) - 2) / 4));        // 这条边上"有多长是墙"（0~1）
            edges.push({ i, j, d: cellDistance(li, list[j]), bold: bd.bold, width: bd.width,
                         wall, cost: cellDistance(li, list[j]) + wall * 300 });
          }
        }
        if (r + 1 < rows) {
          const j = idx[(r + 1) * cols + c];
          if (j >= 0) {
            const bd = borderProbe(raster, geom, r, c, 'down', lumI, cellLuma(list[j]), opt);
            const wall = (bd.coverage || 0) * Math.min(1, Math.max(0, ((bd.width || 0) - 2) / 4));        // 这条边上"有多长是墙"（0~1）
            edges.push({ i, j, d: cellDistance(li, list[j]), bold: bd.bold, width: bd.width,
                         wall, cost: cellDistance(li, list[j]) + wall * 300 });
          }
        }
      }
    }
    if (!edges.length) return { ok: false, reason: '没有相邻格', regions: [] };
    // ---------------- 种子模式：由区域名给出 k 与种子，层次合并到恰好 k 块 ----------------
    // 不需要任何绝对阈值：只要求能排出"哪条边界更像墙"。合并最便宜的一对，
    // 硬约束是"两块都已经带区域名就不许合并"（那就是不同区域），直到剩 k 块。
    if (opt.seeds && opt.seeds.length) {
      const seedList = [];
      for (const sd of opt.seeds) {
        const i = idx[sd.r * cols + sd.c];
        if (i >= 0 && !seedList.some(x => x.i === i)) seedList.push({ i, name: sd.name || ('区域 ' + (seedList.length + 1)) });
      }
      if (seedList.length >= 1) {
        let live = list.map((_, i) => ({ ids: [i], names: new Set(), size: 1 }));
        seedList.forEach(sd => live[sd.i].names.add(sd.name));
        const compOf = new Int32Array(list.length);
        const rebuild = () => { compOf.fill(-1); live.forEach((c, ci) => c.ids.forEach(i => compOf[i] = ci)); };
        rebuild();
        const k = seedList.length;
        let guard = 0;
        while (live.length > k && guard++ <= list.length) {
          // 组件对之间用**平均代价**：只看最便宜的一条边，会被墙上一个缺口骗过去
          const pair = new Map();
          for (const e of edges) {
            const a = compOf[e.i], b = compOf[e.j];
            if (a < 0 || b < 0 || a === b) continue;
            if (live[a].names.size && live[b].names.size) continue;
            const key = a < b ? a + ':' + b : b + ':' + a;
            let acc = pair.get(key);
            if (!acc) { acc = { a: Math.min(a, b), b: Math.max(a, b), sum: 0, cnt: 0 }; pair.set(key, acc); }
            acc.sum += e.cost; acc.cnt++;
          }
          let best = null;
          for (const acc of pair.values()) {
            const mean = acc.sum / acc.cnt;
            if (!best || mean < best.mean) best = { a: acc.a, b: acc.b, mean };
          }
          if (!best) break;
          const A = live[best.a], B = live[best.b];
          A.ids = A.ids.concat(B.ids);
          A.size += B.size;
          for (const nm of B.names) A.names.add(nm);
          live = live.filter((_, ix) => ix !== best.b);
          rebuild();
        }

        // 多数投票平滑：被同一区域包围的零星格子归并过去，把边界修干净。
        // 保护两条：种子格不动；不让任何区域被清空。
        const owner = new Int32Array(list.length).fill(-1);
        const ownerOf = () => { owner.fill(-1); live.forEach((cp, ci) => cp.ids.forEach(i => owner[i] = ci)); };
        ownerOf();
        const seedCells = new Set(seedList.map(sd => sd.i));
        for (let iter = 0; iter < 4; iter++) {
          let changed = 0;
          for (let ii = 0; ii < list.length; ii++) {
            if (seedCells.has(ii)) continue;
            const cell = list[ii];
            const mine = owner[ii];
            if (mine < 0 || live[mine].size <= 1) continue;
            const counts = new Map();
            for (const dr of [-1, 0, 1]) {
              for (const dc of [-1, 0, 1]) {
                if (!dr && !dc) continue;
                const rr = cell.r + dr, cc = cell.c + dc;
                if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
                const j = idx[rr * cols + cc];
                if (j < 0 || j === ii) continue;
                const o = owner[j];
                if (o < 0) continue;
                counts.set(o, (counts.get(o) || 0) + 1);
              }
            }
            let bestO = -1, bestN = 0, total = 0;
            for (const [o, nn] of counts) { total += nn; if (nn > bestN) { bestN = nn; bestO = o; } }
            if (total >= 4 && bestO !== mine && bestN >= total * 0.75) {
              // 把这一格从原分量搬到 bestO
              live[mine].ids = live[mine].ids.filter(x => x !== ii);
              live[mine].size--;
              live[bestO].ids.push(ii);
              live[bestO].size++;
              owner[ii] = bestO;
              changed++;
            }
          }
          live = live.filter(cp => cp.ids.length > 0);
          ownerOf();
          if (!changed) break;
        }

        const hex2 = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
        const seeded = live.map(cp => {
          const rgb = [0, 1, 2].map(ki => {
            const v = cp.ids.map(i => list[i].rgb[ki]).sort((x, y) => x - y);
            return v[v.length >> 1];
          });
          const lab = { L: 0, a: 0, b: 0 };
          for (const i of cp.ids) { lab.L += list[i].lab.L; lab.a += list[i].lab.a; lab.b += list[i].lab.b; }
          lab.L /= cp.ids.length; lab.a /= cp.ids.length; lab.b /= cp.ids.length;
          return { ids: cp.ids, rgb, lab, size: cp.ids.length, name: [...cp.names][0] || '' };
        }).sort((a, b) => b.size - a.size);
        return {
          ok: seeded.length > 0,
          seeded: true,
          regions: seeded.map(cp => ({
            name: cp.name, cells: cp.ids.map(i => list[i].key), rgb: cp.rgb, color: hex2(cp.rgb),
            size: cp.size, lab: cp.lab,
          })),
          stats: {
            sampled: list.length, total: cols * rows, edges: edges.length,
            boldEdges: edges.filter(e => e.bold).length, walls: false, seeded: true,
            seeds: seedList.length, reached: seeded.length,
            threshold: null, sizes: seeded.map(r2 => r2.size),
          },
        };
      }
    }

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

  /**
   * 边界诊断：把每条相邻边的实测数据摊开，用来**按这张地图自己的分布**判断题据，
   * 而不是拍脑袋定阈值。不做任何判定，只给数据。
   */
  function diagnose(raster, geom, options) {
    const opt = Object.assign({ inset: 0.28, pad: 0.07, span: 6, minWidth: 3 }, options || {});
    const { cols, rows } = geom;
    const { cells } = sampleCells(raster, geom, opt);
    const idx = new Int32Array(cols * rows).fill(-1);
    const list = [];
    for (const cell of cells) {
      if (!cell.ok) continue;
      idx[cell.r * cols + cell.c] = list.length;
      list.push(cell);
    }
    const edges = [];
    const push = (i, j, r, c, dir) => {
      const bd = borderProbe(raster, geom, r, c, dir, cellLuma(list[i]), cellLuma(list[j]), opt);
      edges.push({
        i, j, r, c, dir,
        wall: Math.round((bd.coverage || 0) * Math.min(1, Math.max(0, ((bd.width || 0) - 2) / 4)) * 1000) / 1000,
        coverage: bd.coverage, width: bd.width, depth: bd.depth,
        d: Math.round(cellDistance(list[i], list[j]) * 10) / 10,
        cells: [list[i].key, list[j].key],
      });
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = idx[r * cols + c];
        if (i < 0) continue;
        if (c + 1 < cols) { const j = idx[r * cols + c + 1]; if (j >= 0) push(i, j, r, c, 'right'); }
        if (r + 1 < rows) { const j = idx[(r + 1) * cols + c]; if (j >= 0) push(i, j, r, c, 'down'); }
      }
    }
    const hist = new Array(10).fill(0);
    for (const e of edges) hist[Math.min(9, Math.max(0, Math.floor(e.wall * 10)))]++;
    return { geom, cols, rows, sampled: list.length, edges, hist,
             keys: list.map(c2 => c2.key), cells: list };
  }

  /**
   * 把诊断渲染成可复制的文本。
   * @param assignment Map(cellKey → 区域名)——来自当前已识别的区域，有了它才能列出
   *        "区域之间的边界"和"最可疑的边"
   */
  function formatDiagnosis(dg, assignment) {
    const nm = k => (assignment && assignment.get(k)) || '?';
    const L = [];
    const g = dg.geom;
    L.push('=== 边界诊断 ===');
    L.push('格 ' + dg.cols + '×' + dg.rows + ' · 可用格 ' + dg.sampled + ' · 相邻边 ' + dg.edges.length +
           ' · 格距 ' + g.pitchX.toFixed(1) + '×' + g.pitchY.toFixed(1));
    L.push('');
    L.push('墙强度分布（0.0~1.0，每 0.1 一档）：');
    const maxH = Math.max(1, ...dg.hist);
    for (let i = 0; i < 10; i++) {
      const bar = '█'.repeat(Math.round(dg.hist[i] / maxH * 28));
      L.push(' ' + (i / 10).toFixed(1) + '-' + ((i + 1) / 10).toFixed(1) + ' |' +
             bar.padEnd(28) + ' ' + dg.hist[i]);
    }
    if (!assignment || !assignment.size) {
      L.push('');
      L.push('（先点「自动识别区域」，这里才会列出区域之间的边界与可疑边）');
      return L.join('\n');
    }
    // 区域之间的边界
    const pairs = new Map();
    for (const e of dg.edges) {
      const a = nm(e.cells[0]), b = nm(e.cells[1]);
      if (a === b) continue;
      const key = a < b ? a + ' ↔ ' + b : b + ' ↔ ' + a;
      let acc = pairs.get(key);
      if (!acc) { acc = { n: 0, sum: 0, min: 9, max: -1, dsum: 0 }; pairs.set(key, acc); }
      acc.n++; acc.sum += e.wall; acc.dsum += e.d;
      if (e.wall < acc.min) acc.min = e.wall;
      if (e.wall > acc.max) acc.max = e.wall;
    }
    L.push('');
    L.push('区域之间的边界（按平均墙强度升序，最可疑的在前）：');
    [...pairs.entries()].map(([k, a]) => ({ k, ...a, mean: a.sum / a.n }))
      .sort((x, y) => x.mean - y.mean)
      .forEach(a => {
        L.push(' ' + a.k + ' | ' + a.n + ' 条边 | min ' + a.min.toFixed(2) +
               ' 均 ' + a.mean.toFixed(2) + ' max ' + a.max.toFixed(2) +
               ' | 色差均 ' + (a.dsum / a.n).toFixed(1));
      });
    // 跨区域但墙强度很低的边（可能不该分开）
    const weak = dg.edges.filter(e => nm(e.cells[0]) !== nm(e.cells[1]))
      .sort((a, b) => a.wall - b.wall).slice(0, 14);
    L.push('');
    L.push('最可疑的边（跨区域、墙强度低 → 也许本不该分开）：');
    for (const e of weak) {
      L.push(' ' + e.cells[0] + '-' + e.cells[1] + '  ' + nm(e.cells[0]) + '|' + nm(e.cells[1]) +
             '  wall ' + e.wall.toFixed(2) + '  cover ' + e.coverage.toFixed(2) +
             '  width ' + e.width + '  depth ' + e.depth + '  色差 ' + e.d);
    }
    // 同区域但墙强度很高的边（可能该分开）
    const strong = dg.edges.filter(e => nm(e.cells[0]) === nm(e.cells[1]) && e.wall >= 0.5)
      .sort((a, b) => b.wall - a.wall).slice(0, 10);
    L.push('');
    L.push('同区域内却像墙的边（墙强度 ≥0.5 → 也许该分开）：');
    for (const e of strong) {
      L.push(' ' + e.cells[0] + '-' + e.cells[1] + '  ' + nm(e.cells[0]) +
             '  wall ' + e.wall.toFixed(2) + '  width ' + e.width + '  depth ' + e.depth + '  色差 ' + e.d);
    }
    return L.join('\n');
  }

  return { detectRegions, diagnose, formatDiagnosis, sampleCells, cellDistance, cellLuma, borderProbe, srgbToLab, otsu1d };
});

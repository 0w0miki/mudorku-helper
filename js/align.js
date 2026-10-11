/*! Mudorku Helper — align.js
 * 自动对位的几何层：从栅格里找出网格（格距 / 原点 / 倾角），纯数学、不依赖 DOM。
 * 浏览器里挂到 window.MurdokuAlign，Node 下可直接 require() 做单元测试。
 *
 * 适用输入：栅格（PDF 渲染图 / 截图 / 扫描件 / 拍照矫正后）。
 * 思路：局部背景 → 墨迹图 → 列/行投影 → 梳状打分求周期与相位 → 峰值精修 →
 *      最小二乘拟合出 pitch/原点/倾角，残差与对比度换算成置信度。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MurdokuAlign = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = {
    analyzeSide: 1600,   // 分析用最长边（原图更大时先降采样）
    minPitch: 8,         // 一格最小像素
    maxPitch: 400,       // 一格最大像素
    minLines: 3,         // 少于这么多条线就认为没检出
  };

  // ---------------------------------------------------------------- 灰度与降采样

  /** RGBA 栅格 → 灰度图（盒式降采样，顺便把亮度取出来） */
  function toGray(raster, analyzeSide) {
    const { data, width, height } = raster;
    if (!data || !width || !height) throw new Error('raster 不完整');
    const longest = Math.max(width, height);
    const k = Math.max(1, Math.min(4, Math.ceil(longest / analyzeSide)));
    const w = Math.max(1, Math.floor(width / k));
    const h = Math.max(1, Math.floor(height / k));
    const gray = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy0 = y * k, sy1 = Math.min(height, sy0 + k);
      for (let x = 0; x < w; x++) {
        const sx0 = x * k, sx1 = Math.min(width, sx0 + k);
        let sum = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let o = (sy * width + sx0) * 4;
          for (let sx = sx0; sx < sx1; sx++, o += 4) {
            sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
            n++;
          }
        }
        gray[y * w + x] = n ? sum / n : 255;
      }
    }
    return { gray, w, h, scale: k };
  }

  // ---------------------------------------------------------------- 背景与墨迹

  /** 一维盒式模糊（滑动窗口，边缘钳制） */
  function blur1D(src, n, radius, out) {
    const res = out || new Float32Array(n);
    let sum = 0;
    const win = 2 * radius + 1;
    for (let i = -radius; i <= radius; i++) sum += src[Math.min(n - 1, Math.max(0, i))];
    for (let i = 0; i < n; i++) {
      res[i] = sum / win;
      const add = src[Math.min(n - 1, i + radius + 1)];
      const drop = src[Math.max(0, i - radius)];
      sum += add - drop;
    }
    return res;
  }

  /** 大核盒式模糊 → 局部背景（对光照不均/照片鲁棒） */
  function boxBlur(gray, w, h, radius) {
    const tmp = new Float32Array(w * h);
    const row = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      row.set(gray.subarray(y * w, y * w + w));
      blur1D(row, w, radius, row);
      tmp.set(row, y * w);
    }
    const col = new Float32Array(h);
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) col[y] = tmp[y * w + x];
      blur1D(col, h, radius, col);
      for (let y = 0; y < h; y++) out[y * w + x] = col[y];
    }
    return out;
  }

  /** 墨迹图：比局部背景暗的像素才计分（比绝对阈值稳） */
  function inkMap(gray, w, h, radius) {
    const bg = boxBlur(gray, w, h, radius);
    const ink = new Float32Array(w * h);
    for (let i = 0; i < ink.length; i++) {
      const d = bg[i] - gray[i];
      ink[i] = d > 0 ? d : 0;
    }
    return ink;
  }

  /** 投影：axis='x' 时按列累加（得到竖线的信号），'y' 按行累加 */
  function project(ink, w, h, axis) {
    if (axis === 'x') {
      const prof = new Float32Array(w);
      for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) prof[x] += ink[o + x];
      }
      return prof;
    }
    const prof = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      const o = y * w;
      for (let x = 0; x < w; x++) s += ink[o + x];
      prof[y] = s;
    }
    return prof;
  }

  /** Otsu 阈值（在墨迹图上自动分开"有墨/没墨"，不用手调） */
  function otsu(values) {
    const bins = new Int32Array(256);
    let n = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v <= 0) continue;
      bins[Math.min(255, Math.round(v))]++;
      n++;
    }
    if (!n) return Infinity;
    let sum = 0;
    for (let b = 0; b < 256; b++) sum += b * bins[b];
    let wB = 0, sumB = 0, best = 0, bestT = 0;
    for (let t = 0; t < 256; t++) {
      wB += bins[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * bins[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; bestT = t; }
    }
    return bestT;
  }

  /**
   * 行程长度加权投影：**只认长直线**。
   * 区域纹理、图例文字、图标都是"短行程"，网格线是"长行程"；
   * 用 runLength² 加权后，一条贯穿的地图网格线会把纹理压下去（无需调参）。
   * axis='x' → 逐列沿 y 找竖线行程；axis='y' 反之。
   */
  function runProfile(ink, w, h, axis, thresh, bounds) {
    const vert = axis === 'x';
    const outer = vert ? w : h;          // 有多少条"列/行"
    const inner = vert ? h : w;          // 每条里走多远
    // bounds=[lo,hi] 时只统计这一段：地图常只占画面一部分，图例/文字区会把
    // 另一个方向的周期带偏（真实例子里 y 就这样被文字行骗成半格距）
    const j0 = bounds ? Math.max(0, Math.floor(bounds[0])) : 0;
    const j1 = bounds ? Math.min(inner - 1, Math.ceil(bounds[1])) : inner - 1;
    const prof = new Float64Array(outer);
    const at = vert ? (i, j) => j * w + i : (i, j) => i * w + j;
    for (let i = 0; i < outer; i++) {
      let run = 0, sum = 0;
      for (let j = j0; j <= j1; j++) {
        if (ink[at(i, j)] >= thresh) run++;
        else {
          if (run > 1) sum += run * run;   // 短行程贡献极小
          run = 0;
        }
      }
      if (run > 1) sum += run * run;
      prof[i] = sum;
    }
    return prof;
  }

  // ---------------------------------------------------------------- 周期与相位

  /** 去线性趋势：光照渐变（拍屏/照片）会让投影整体倾斜，先扣掉再看周期 */
  function detrend(prof) {
    const n = prof.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += prof[i]; sxx += i * i; sxy += i * prof[i]; }
    const den = n * sxx - sx * sx;
    const slope = den ? (n * sxy - sx * sy) / den : 0;
    const intercept = (sy - slope * sx) / n;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = prof[i] - (intercept + slope * i);
    return out;
  }

  /** 归一化自相关（去均值、除以重叠区间能量），返回 lag → 系数[-1,1] */
  function autocorr(prof, maxLag) {
    const n = prof.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += prof[i];
    mean /= n;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = prof[i] - mean;
    const out = new Float32Array(maxLag + 1);
    for (let lag = 1; lag <= maxLag; lag++) {
      let s = 0, a = 0, b = 0;
      const lim = n - lag;
      for (let i = 0; i < lim; i++) {
        const x = d[i], y = d[i + lag];
        s += x * y; a += x * x; b += y * y;
      }
      const den = Math.sqrt(a * b);
      out[lag] = den > 0 ? s / den : 0;
    }
    return out;
  }

  /** 梳状打分：在 pitch/相位确定的位置上取墨迹（±1px 取最大，容忍半像素偏差） */
  function combScore(prof, pitch, phase) {
    const n = prof.length;
    let sum = 0, cnt = 0;
    for (let k = 0; ; k++) {
      const c = phase + k * pitch;
      if (c > n - 1) break;
      const i = Math.round(c);
      const v = Math.max(prof[i] || 0, prof[i - 1] || 0, prof[i + 1] || 0);
      sum += v; cnt++;
    }
    return cnt >= 2 ? sum / cnt : 0;
  }

  /**
   * 梳状统计：给出两个互补指标
   * - capture  = 梳齿窗口捕获的墨迹 / 全部墨迹（整倍数会漏掉一半线 → 掉下来）
   * - hitRatio = 真的落在墨迹上的梳齿比例（约数会有半数梳齿落在空处 → 掉下来）
   * 真周期两个都高；约数赢在 capture 输在 hitRatio，整倍数反之。两个都用才能定位基本周期。
   */
  function combStats(prof, pitch, phase, win, inkThresh) {
    const n = prof.length;
    // "有墨"必须是相对的：横线会在每一列都留一丁点墨，用 >0 判据会让命中率永远满分
    const t = inkThresh > 0 ? inkThresh : 0;
    const has = v => v > t;
    let total = 0;
    for (let i = 0; i < n; i++) if (has(prof[i])) total += prof[i];
    const used = new Uint8Array(n);
    let cap = 0, positions = 0, hits = 0;
    for (let k = 0; ; k++) {
      const c = Math.round(phase + k * pitch);
      if (c > n - 1) break;
      positions++;
      let hit = false;
      for (let i = Math.max(0, c - win); i <= Math.min(n - 1, c + win); i++) {
        if (has(prof[i])) hit = true;
        if (!used[i]) { used[i] = 1; if (has(prof[i])) cap += prof[i]; }
      }
      if (hit) hits++;
    }
    return {
      capture: total > 0 ? cap / total : 0,
      hitRatio: positions ? hits / positions : 0,
      positions,
    };
  }

  /**
   * 求格距与相位：
   * 1) 自相关里找**第一个足够强的峰**（而不是最大峰）——周期信号在 2p、3p 处同样有峰，
   *    取第一个才能避免把 2 倍格距当格距；同时要求至少 3 个周期，避免长 lag 的偶然高分
   * 2) 抛物线插值把 pitch 精确到亚像素
   * 3) 固定 pitch 后扫相位，用梳状打分的最高者
   */
  function findPitch(prof, minPitch, maxPitch) {
    const n = prof.length;
    const lo = Math.max(2, Math.round(minPitch));
    const hi = Math.min(Math.round(maxPitch), Math.floor((n - 1) / 3));
    if (hi <= lo + 1) return null;
    const ac = autocorr(prof, hi + 1);
    let maxAc = 0, argmax = lo;
    for (let l = lo; l <= hi; l++) if (ac[l] > maxAc) { maxAc = ac[l]; argmax = l; }
    if (maxAc <= 0.05) return null;

    // 候选 = 自相关局部极大 + 它们的 /2、/3（真周期可能根本没进自相关：区域粗边框
    // 会让"隔一条线"的结构更强，把真周期压下去）
    const set = new Set([argmax]);
    for (let l = lo; l <= hi; l++) {
      if (ac[l] >= maxAc * 0.3 && ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1]) set.add(l);
    }
    for (const l of [...set]) {
      for (const d of [2, 3]) {
        const q = l / d;
        if (q >= lo) set.add(Math.round(q * 100) / 100);
      }
    }

    let sumProf = 0;
    for (let i = 0; i < n; i++) sumProf += prof[i];
    const inkThresh = (sumProf / n) * 1.5;      // 只有明显高出平均的列才算"线"

    const scored = [];
    for (const cand of set) {
      // 相位：用"取最大"精修（±1px 窗口比宽窗口准）
      let bScore = -1, bPhase = 0;
      const span = Math.max(1, Math.round(cand));
      for (let ph = 0; ph < span; ph++) {
        const sc = combScore(prof, cand, ph);
        if (sc > bScore) { bScore = sc; bPhase = ph; }
      }
      const win = Math.max(1, Math.min(2, Math.round(cand * 0.06)));
      const st = combStats(prof, cand, bPhase, win, inkThresh);
      scored.push({ pitch: cand, phase: bPhase, score: bScore,
                    capture: st.capture, hitRatio: st.hitRatio });
    }

    // 判据：**min(命中率, 捕获率)** 在真周期上最大。
    //  真周期：两者都接近 1；约数（p/2）：捕获率满分但半数梳齿落在空处 → 命中率腰斩；
    //  整倍数（2p）：命中率满分但漏掉一半的线 → 捕获率腰斩。只有基本周期两者都高。
    //  这个判据自带区分能力，不需要额外的阈值。并列时取最小 pitch。
    for (const c of scored) c.fit = Math.min(c.hitRatio, c.capture);
    let bestFit = -1;
    for (const c of scored) if (c.fit > bestFit) bestFit = c.fit;
    const close = scored.filter(c => c.fit >= bestFit * 0.98).sort((a, b) => a.pitch - b.pitch);
    const pick = close[0];

    const ip = Math.max(1, Math.min(ac.length - 2, Math.round(pick.pitch)));
    const a0 = ac[ip - 1] || 0, a1 = ac[ip], a2 = ac[ip + 1] || 0;
    const den = a0 - 2 * a1 + a2;
    // 抛物线精修的偏移必须夹在 ±0.5：den 接近 0 时偏移会爆掉，把 pitch 变成负数/超大，
    // 下游按 pitch 步进的循环就再也走不到头（曾经把测试挂死在这）
    let pitch = pick.pitch;
    if (den) {
      const off = 0.5 * (a0 - a2) / den;
      if (Number.isFinite(off) && Math.abs(off) <= 0.5) pitch += off;
    }
    if (!(pitch > 0)) pitch = pick.pitch;
    return { pitch, phase: pick.phase, score: pick.score, capture: pick.capture,
             hitRatio: pick.hitRatio, ac: maxAc, candidates: scored.length };
  }

  // ---------------------------------------------------------------- 峰值精修与拟合

  /** 在预测位置附近精修线位；返回 [{ k, pos, strength }]（缺线跳过） */
  function refineLines(prof, pitch, phase, strengthFloor) {
    const n = prof.length;
    const lines = [];
    if (!(pitch > 0) || !Number.isFinite(pitch)) return lines;
    const half = Math.max(2, Math.round(pitch / 4));
    for (let k = -Math.ceil(phase / pitch); ; k++) {
      const c = Math.round(phase + k * pitch);
      if (c > n - 1) break;
      let peak = 0, peakAt = -1;
      for (let i = Math.max(0, c - half); i <= Math.min(n - 1, c + half); i++) {
        if (prof[i] > peak) { peak = prof[i]; peakAt = i; }
      }
      if (peakAt < 0 || peak < strengthFloor) continue;
      // 以峰值为中心取 ±2px 求墨迹加权质心 → 亚像素
      let sw = 0, swx = 0;
      for (let i = Math.max(0, peakAt - 2); i <= Math.min(n - 1, peakAt + 2); i++) {
        sw += prof[i]; swx += prof[i] * i;
      }
      lines.push({ k, pos: sw > 0 ? swx / sw : peakAt, strength: peak });
    }
    return lines;
  }

  /** 最小二乘：位置 = intercept + slope × 线序号 */
  function linfit(lines) {
    const n = lines.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const l of lines) { sx += l.k; sy += l.pos; sxx += l.k * l.k; sxy += l.k * l.pos; }
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const slope = (n * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / n;
    let ss = 0;
    for (const l of lines) { const d = l.pos - (intercept + slope * l.k); ss += d * d; }
    return { slope, intercept, rms: Math.sqrt(ss / n) };
  }

  // ---------------------------------------------------------------- 倾角

  /**
   * 估网格倾角：**沿某个方向做投影，网格摆正时投影最锐**（经典倾斜校正做法）。
   * 比梯度直方图稳：不受线条阶梯/纹理造成的方向噪声影响。
   * 返回角度（度）与锐度（越大越像规则网格）。
   */
  function estimateAngle(gray, w, h, options) {
    const o = Object.assign({ range: 6, step: 0.25, analyzeSide: 600 }, options || {});
    // 估角度不需要高分辨率：先降到 analyzeSide 以内，快一个数量级
    let g = gray, gw = w, gh = h;
    const longest = Math.max(w, h);
    if (longest > o.analyzeSide) {
      const k = Math.ceil(longest / o.analyzeSide);
      gw = Math.max(1, Math.floor(w / k));
      gh = Math.max(1, Math.floor(h / k));
      const small = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        const o0 = y * k * w;
        for (let x = 0; x < gw; x++) small[y * gw + x] = gray[o0 + x * k];
      }
      g = small; w = gw; h = gh;
    }
    const radius = Math.max(3, Math.round(Math.min(w, h) / 30));
    const ink = inkMap(g, w, h, radius);

    const scoreAt = deg => {
      const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      const off = Math.ceil(w * Math.abs(s)) + 1;
      const len = Math.ceil(h * c) + 2 * off + 2;
      const px = new Float64Array(len), py = new Float64Array(len);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const v = ink[row + x];
          if (!v) continue;
          px[Math.round(x * c + y * s)] += v;
          py[Math.round(-x * s + y * c) + off] += v;
        }
      }
      let score = 0;
      for (const prof of [px, py]) {
        let sum = 0, sum2 = 0;
        for (let i = 0; i < len; i++) { const v = prof[i]; if (v) { sum += v; sum2 += v * v; } }
        if (sum > 0) score += sum2 / (sum * sum);          // 越集中越大
      }
      return score;
    };

    const degs = [];
    for (let d = -o.range; d <= o.range + 1e-9; d += o.step) degs.push(Math.round(d * 1000) / 1000);
    const scores = degs.map(scoreAt);
    let bestI = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bestI]) bestI = i;
    let angle = degs[bestI];
    // 抛物线插值到亚步长
    if (bestI > 0 && bestI < scores.length - 1) {
      const a0 = scores[bestI - 1], a1 = scores[bestI], a2 = scores[bestI + 1];
      const den = a0 - 2 * a1 + a2;
      if (den) angle += 0.5 * (a0 - a2) / den * o.step;
    }
    let mean = 0;
    for (const v of scores) mean += v;
    mean /= scores.length;
    const sharpness = mean > 0 ? scores[bestI] / mean - 1 : 0;
    return { angle, sharpness: Math.round(sharpness * 1000) / 1000 };
  }

  /** 按角度旋转灰度图（双线性，中心旋转，越界取背景色 255） */
  function rotateGray(gray, w, h, angleDeg) {
    const r = -angleDeg * Math.PI / 180;            // 反向旋转把它摆正
    const cos = Math.cos(r), sin = Math.sin(r);
    const out = new Float32Array(w * h);
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx, dy = y - cy;
        const sx = cos * dx - sin * dy + cx;
        const sy = sin * dx + cos * dy + cy;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) { out[y * w + x] = 255; continue; }
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
        const fx = sx - x0, fy = sy - y0;
        const p00 = gray[y0 * w + x0], p10 = gray[y0 * w + x1];
        const p01 = gray[y1 * w + x0], p11 = gray[y1 * w + x1];
        out[y * w + x] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) +
                         p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 单方向分析

  /** 对一个方向的投影求 pitch/原点/置信度 */
  function analyzeAxis(prof, opts) {
    const minPitch = opts.minPitch, maxPitch = opts.maxPitch;
    const peakBase = findPitch(prof, minPitch, maxPitch);
    if (!peakBase) return { ok: false, reason: '找不到周期' };
    let mean = 0;
    for (let i = 0; i < prof.length; i++) mean += prof[i];
    mean /= prof.length;
    const contrast = mean > 0 ? peakBase.score / mean : 0;       // >1 说明线上确实更"墨"
    const strengthFloor = Math.max(mean * 0.6, peakBase.score * 0.35);
    const lines = refineLines(prof, peakBase.pitch, peakBase.phase, strengthFloor);
    const fit = linfit(lines);
    if (!fit) return { ok: false, reason: '线太少' };
    const want = Math.floor((prof.length - 1 - fit.intercept) / fit.slope) + 1;
    const ratio = want > 0 ? Math.min(1, lines.length / want) : 0;
    const residN = Math.min(1, (fit.rms / Math.max(1e-6, fit.slope)) * 20);
    const conf = Math.max(0, Math.min(1,
      0.4 * Math.min(1, Math.max(0, (contrast - 1.05) / 0.9)) +
      0.4 * ratio +
      0.2 * (1 - residN)));
    return {
      // 对比度太低说明"线"只是噪声的偶然堆积；覆盖太低说明周期对不上实际线位
      ok: lines.length >= opts.minLines && ratio >= 0.4 && contrast >= 2.0 && conf >= 0.45,
      pitch: fit.slope,
      origin: fit.intercept,
      lines: lines.map(l => l.pos),
      count: lines.length,
      expected: want,
      contrast, ratio, rms: fit.rms, confidence: conf,
      reason: '',
    };
  }

  // ---------------------------------------------------------------- 主入口

  /**
   * 从栅格检测网格。
   * @param {{data:Uint8ClampedArray,width:number,height:number}} raster
   * @param {{analyzeSide?:number,minPitch?:number,maxPitch?:number,minLines?:number}} [options]
   * @returns {{ok:boolean,reason?:string,confidence:number,pitch:{x:number,y:number},
   *            origin:{x:number,y:number},angle:number,cols:number,rows:number,
   *            lines:{x:number[],y:number[]},x:object,y:object,scale:number}}
   */
  function detectGrid(raster, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const t0 = Date.now();
    const { gray, w, h, scale } = toGray(raster, opts.analyzeSide);

    // 1) 倾角：先估，必要时把图摆正再找周期
    const ang = estimateAngle(gray, w, h);
    // 锐度太低时这个角度没有意义（空白图、纯噪声），不要瞎转
    const guess = (Math.abs(ang.angle) >= 0.3 && ang.sharpness >= 0.05) ? ang.angle : 0;

    // 2) 墨迹 + 投影（背景核取短边的 ~1/30，至少 4px）
    const radius = Math.max(4, Math.round(Math.min(w, h) / 30));
    const runAxes = (img) => {
      const ink = inkMap(img, w, h, radius);
      // 只认长直线：纹理/文字/图标的短行程会被 runLength² 压下去
      const thresh = Math.max(10, otsu(ink) * 0.6);
      const span = (ax) => (ax.ok && ax.lines && ax.lines.length >= 3)
        ? [Math.floor(ax.lines[0]), Math.ceil(ax.lines[ax.lines.length - 1])] : null;
      const ax0 = analyzeAxis(runProfile(ink, w, h, 'x', thresh), opts);
      // y 只统计 x 网格覆盖的那一段，避免右侧/下方图例与文字把周期带偏
      const ay = analyzeAxis(runProfile(ink, w, h, 'y', thresh, span(ax0)), opts);
      let ax = ax0;
      const yb = span(ay);
      if (yb) {
        const ax2 = analyzeAxis(runProfile(ink, w, h, 'x', thresh, yb), opts);
        if (ax2.ok || !ax0.ok) ax = ax2.ok ? ax2 : ax0;
      }
      return { x: ax, y: ay };
    };
    // 伪倾角会把线抹开反而更差：旋转前后各分析一次，按"两个方向都成立且置信度高"取更好的
    const scoreOf = r => {
      const okBoth = r.x.ok && r.y.ok;
      const sq = okBoth && r.x.pitch && r.y.pitch
        ? Math.min(r.x.pitch, r.y.pitch) / Math.max(r.x.pitch, r.y.pitch) : 0;
      return (okBoth ? 1 : 0) * 10 + sq + (r.x.confidence || 0) + (r.y.confidence || 0);
    };
    let angle = 0;
    let best = runAxes(gray);
    if (guess) {
      const rotated = runAxes(rotateGray(gray, w, h, -guess));
      if (scoreOf(rotated) > scoreOf(best)) { best = rotated; angle = guess; }
    }
    const ax = best.x, ay = best.y;

    const pitchX = ax.pitch || 0, pitchY = ay.pitch || 0;
    const okX = !!ax.ok, okY = !!ay.ok;
    // 一个方向成功也能用（框选只圈到局部、或另一方向线被纹理盖住）
    const ok = okX || okY;      // 最终是否可用见下面的 good（两个方向都要成立）
    const both = okX && okY;
    // 格子应接近正方形：x/y 差太多说明"检测到的东西"不是同一张网格
    const squareness = both ? Math.min(pitchX, pitchY) / Math.max(pitchX, pitchY) : 0;
    const good = both && squareness >= 0.75;
    const conf0 = ok ? ((ax.confidence || 0) * (okX ? 1 : 0) + (ay.confidence || 0) * (okY ? 1 : 0))
                       / ((okX ? 1 : 0) + (okY ? 1 : 0)) : 0;
    const conf = good ? conf0 : conf0 * squareness;
    const cols = okX ? Math.max(1, ax.expected) : 0;
    const rows = okY ? Math.max(1, ay.expected) : 0;

    // 全部换算回**原图像素**坐标（分析时可能降过采样），调用方直接用
    const K = scale;
    const at = v => Math.round(v * K * 100) / 100;
    return {
      ok: good, squareness: Math.round(squareness * 1000) / 1000,
      mismatch: both && !good,
      reason: good ? '' : (ok ? 'x/y 格距不一致，可能没框到地图' : (ax.reason || ay.reason || '未检出')),
      confidence: Math.round(conf * 1000) / 1000,
      pitch: { x: at(pitchX), y: at(pitchY) },
      origin: { x: at(ax.origin || 0), y: at(ay.origin || 0) },
      angle,
      sharpness: ang.sharpness,
      cols, rows,
      lines: { x: (ax.lines || []).map(at), y: (ay.lines || []).map(at) },
      x: ax, y: ay,
      scale,                                   // 分析图相对原图的降采样倍数
      elapsedMs: Date.now() - t0,
    };
  }

  return { detectGrid, toGray, boxBlur, inkMap, project, otsu, runProfile, detrend, combStats, autocorr, combScore, findPitch, refineLines, linfit,
           estimateAngle, rotateGray, DEFAULTS };
});

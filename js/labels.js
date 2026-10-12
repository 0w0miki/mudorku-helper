/*! Mudorku Helper — labels.js
 * 从图里的文字挑出"区域名"。区域名是画在地图上的**全大写**短标签
 * （RECEPTION / WAITING AREA / STORAGE / GARAGE / TEACHER'S AREA …），
 * 而图例物品名是首字母大写（Car / Chair / TV / Shelf），线索是整句文字。
 * 三个条件一起用就能干净地分开：**全大写 + 在地图外框内 + 字号不超过半格**。
 *
 * 拿到区域名的意义：不只是名字——**区域个数 k 与每个区域的种子格**也一起有了。
 * 纯逻辑、不依赖 DOM，浏览器挂 window.MurdokuLabels。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MurdokuLabels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 全大写（允许空格、数字、' ’ . - / &）；至少一个字母
  const ALL_CAPS = /^[A-Z0-9][A-Z0-9'’.\-\/& ]*$/;

  /**
   * 挑区域名。
   * @param {Array<{str:string,x:number,y:number,h?:number}>} items 文字块（含坐标，单位与栅格一致）
   * @param {{x:number,y:number,w:number,h:number}} [box] 地图外框；给了就只取框内的
   * @param {{minLetters?:number,maxWords?:number,maxSize?:number}} [options]
   *        maxSize：字号上限（一般传 0.5×格距，用来排除标题那种大字）
   */
  function pickRegionLabels(items, box, options) {
    const opt = Object.assign({ minLetters: 3, maxWords: 4, maxSize: 0 }, options || {});
    const out = [];
    for (const it of items || []) {
      const s = String((it && it.str) || '').trim();
      if (!s) continue;
      if (!ALL_CAPS.test(s)) continue;                    // 必须全大写（排除 Car / Chair / 整句）
      if (/^[0-9'’.\-\/& ]+$/.test(s)) continue;           // 纯数字/符号（步骤号 1 2 3）
      const letters = s.replace(/[^A-Za-z]/g, '');
      if (letters.length < opt.minLetters) continue;       // 排除 TV 这类两字母图例
      if (s.split(/\s+/).length > opt.maxWords) continue;
      const x = Number(it.x), y = Number(it.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (opt.maxSize > 0 && Number(it.h) > opt.maxSize) continue;
      if (!inBox(it, box)) continue;
      out.push({ name: s, x, y, h: Number(it.h) || 0 });
    }
    // 同一个名字在同一处只留一次（pdf.js 会把一行拆成多个 item）
    const seen = new Set();
    const uniq = [];
    for (const l of out) {
      const key = l.name + '@' + Math.round(l.x / 10) + ',' + Math.round(l.y / 10);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(l);
    }
    uniq.sort((a, b) => a.y - b.y || a.x - b.x);
    return uniq;
  }

  /**
   * 识别用的"图片区域" —— **直接由对齐好的网格推出**，不再依赖手画的框。
   * 网格矩形四周放宽 pad 格（默认 0.2），免得贴边的区域名因为基线坐标差几像素被切掉。
   * 手画的外框只用来定标（算格距与原点），定完就没有别的用途了：
   * 所以之后无论怎么微调网格、裁切底图，区域都自动跟着走。
   *
   * @param {{x0:number,y0:number,pitchX:number,pitchY:number,cols:number,rows:number}} geom
   * @param {number} [pad] 四周放宽的格数
   */
  function areaBox(geom, pad) {
    const p = pad == null ? 0.2 : Math.max(0, Number(pad) || 0);
    const mx = geom.pitchX * p, my = geom.pitchY * p;
    return {
      x: geom.x0 - mx, y: geom.y0 - my,
      w: geom.cols * geom.pitchX + 2 * mx, h: geom.rows * geom.pitchY + 2 * my,
    };
  }

  /** 文字块（基线左端坐标）是否落在区域里 */
  function inBox(item, box) {
    if (!box) return true;
    const x = Number(item && item.x), y = Number(item && item.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
  }

  /** 标签坐标 → 格子 (r,c)；格子外返回 null */
  function labelToCell(label, geom) {
    const c = Math.floor((label.x - geom.x0) / geom.pitchX);
    const r = Math.floor((label.y - geom.y0) / geom.pitchY);
    if (!(c >= 0 && c < geom.cols && r >= 0 && r < geom.rows)) return null;
    return { r, c };
  }

  /** 把标签列表直接转成 seeds（落在格子外的丢掉） */
  function labelsToSeeds(labels, geom) {
    const seeds = [];
    for (const l of labels) {
      const cell = labelToCell(l, geom);
      if (!cell) continue;
      if (seeds.some(s => s.r === cell.r && s.c === cell.c)) continue;   // 同一格只留一个
      seeds.push({ name: l.name, r: cell.r, c: cell.c });
    }
    return seeds;
  }

  /**
   * 找"区域名标签徽章" —— 截图没有文字层，但这类题面把区域名画成
   * **白底药丸 + 黑描边 + 黑字**（放大看就是一枚贴纸），视觉签名很强，可以直接找：
   *
   *   ① 白色连通域的大小 / 长宽比像药丸（高 ≈ 0.2~0.6 格、宽 ≤ 5 格）
   *   ② 框内有一撮**黑字**：≥3 个高度相近的黑字块（白色物件里没有这个）
   *   ③ 四条边的中点外侧都是黑描边（药丸的黑边）
   *   ④ 白色像素占外接框 40%~93%（实心白物件的填充率会更高）
   *
   * 找到它就有了 k 与种子格；名字先用「区域 N」，用户在侧栏改名即可。
   * @param {{data:Uint8ClampedArray,width:number,height:number}} raster
   * @param {number} pitch 格距（像素）；所有尺寸判据都按它归一，换分辨率不用重调
   * @returns {Array<{x:number,y:number,w:number,h:number,ink:number,glyphs:number}>}
   */
  function findLabelBadges(raster, pitch, options) {
    const opt = Object.assign({
      satMax: 48, darkMax: 92, whiteThresh: [248, 240, 230, 218, 206, 194],
      minH: 0.16, maxH: 0.62, minW: 0.5, maxW: 5.0, minAspect: 1.15,
      minFill: 0.4, maxFill: 0.94, minInk: 0.2, maxInk: 0.5,
      ringDark: 135, minGlyphs: 4, minN: 40, iou: 0.25, contain: 0.6,
    }, options || {});
    const { data, width: W, height: H } = raster;
    if (!(W > 8) || !(H > 8) || !(pitch > 4)) return [];
    const N = W * H;
    const luma = new Float32Array(N);
    const sat = new Uint8Array(N);
    for (let i = 0, o = 0; i < N; i++, o += 4) {
      const r = data[o], g = data[o + 1], b = data[o + 2];
      luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }
    // 连通域（4 邻），带外接框；x0..x1 / y0..y1 限定扫描范围（查框内黑字时用）
    const comps = (mask, minN, x0, y0, x1, y1) => {
      const seen = new Uint8Array(N), stack = [], out = [];
      const bx0 = x0 == null ? 0 : x0, by0 = y0 == null ? 0 : y0;
      const bx1 = x1 == null ? W - 1 : x1, by1 = y1 == null ? H - 1 : y1;
      for (let sy = by0; sy <= by1; sy++) {
        for (let sx = bx0; sx <= bx1; sx++) {
          const s0 = sy * W + sx;
          if (seen[s0] || !mask[s0]) continue;
          let n = 0, ax0 = sx, ax1 = sx, ay0 = sy, ay1 = sy;
          stack.length = 0; stack.push(s0); seen[s0] = 1;
          while (stack.length) {
            const i = stack.pop(), ix = i % W, iy = (i - ix) / W;
            n++;
            if (ix < ax0) ax0 = ix; if (ix > ax1) ax1 = ix;
            if (iy < ay0) ay0 = iy; if (iy > ay1) ay1 = iy;
            const nb = [i - 1, i + 1, i - W, i + W];
            for (const j of nb) {
              if (j < 0 || j >= N || Math.abs((j % W) - ix) > 1) continue;
              if (!seen[j] && mask[j]) { seen[j] = 1; stack.push(j); }
            }
          }
          if (n >= minN) out.push({ n, x0: ax0, y0: ay0, x1: ax1, y1: ay1 });
        }
      }
      return out;
    };
    /**
     * 一条边外侧 1~4px 里最暗的那 1/4 像素（药丸的黑描边就在这附近）。
     * 不能用"固定 3px 处的中位数"：描边只有 2~3px 厚，3px 处可能已经落到背景上，
     * 于是标签压在亮底（木甲板/沙地）上时就整条被否掉（FRIGATE A 就是这么漏的）。
     */
    const sideDark = (bx0, by0, bx1, by1, side) => {
      const vals = [];
      const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
      for (let off = 1; off <= 4; off++) {
        if (side === 'top' || side === 'bottom') {
          const y = side === 'top' ? by0 - off : by1 + off;
          if (y < 0 || y >= H) continue;
          for (let x = Math.round(bx0 + w * 0.15); x <= Math.round(bx1 - w * 0.15); x++) if (x >= 0 && x < W) vals.push(luma[y * W + x]);
        } else {
          const x = side === 'left' ? bx0 - off : bx1 + off;
          if (x < 0 || x >= W) continue;
          for (let y = Math.round(by0 + h * 0.15); y <= Math.round(by1 - h * 0.15); y++) if (y >= 0 && y < H) vals.push(luma[y * W + x]);
        }
      }
      if (!vals.length) return 255;
      vals.sort((a, b) => a - b);
      return vals[Math.max(0, Math.floor(vals.length * 0.25) - 1)];
    };
    /**
     * 在某个白阈值下扫一遍。
     * 为什么要在多个阈值上扫：标签压在**亮背景**（白木甲板、灰石板、沙地）上时，
     * 白阈值太低会和背景连成一片（外接框巨大 → 被否），太高又会把药丸自己切碎，
     * 不同标签的合适阈值不一样 —— 各扫一遍再合并最省事，也最稳。
     */
    const scan = whiteMin => {
      const white = new Uint8Array(N);
      for (let i = 0; i < N; i++) if (luma[i] > whiteMin && sat[i] < opt.satMax) white[i] = 1;
      const found = [];
      for (const cp of comps(white, opt.minN)) {
        const bw = cp.x1 - cp.x0 + 1, bh = cp.y1 - cp.y0 + 1;
        if (bh < pitch * opt.minH || bh > pitch * opt.maxH) continue;
        if (bw < pitch * opt.minW || bw > pitch * opt.maxW) continue;
        if (bw / bh < opt.minAspect) continue;
        const fill = cp.n / (bw * bh);
        if (fill < opt.minFill || fill > opt.maxFill) continue;
        // 框内的黑字：黑像素占比 + 至少 3 个高度相近的字块
        let ink = 0;
        for (let y = cp.y0; y <= cp.y1; y++) for (let x = cp.x0; x <= cp.x1; x++) if (luma[y * W + x] < opt.darkMax) ink++;
        const inkFrac = ink / (bw * bh);
        if (inkFrac < opt.minInk || inkFrac > opt.maxInk) continue;
        const inked = [];
        {
          const dark = new Uint8Array(N);
          for (let y = cp.y0; y <= cp.y1; y++) for (let x = cp.x0; x <= cp.x1; x++) if (luma[y * W + x] < opt.darkMax) dark[y * W + x] = 1;
          for (const g of comps(dark, 4, cp.x0, cp.y0, cp.x1, cp.y1)) {
            const gh = g.y1 - g.y0 + 1, gw = g.x1 - g.x0 + 1;
            if (gh >= Math.max(3, bh * 0.18) && gw <= bw * 0.5) inked.push(g);
          }
        }
        if (inked.length < opt.minGlyphs) continue;
        const hs = inked.map(g => g.y1 - g.y0 + 1).sort((a, b) => a - b);
        const med = hs[hs.length >> 1];
        const sameH = inked.filter(g => { const h2 = g.y1 - g.y0 + 1; return h2 >= med * 0.5 && h2 <= med * 1.8; }).length;
        if (sameH < opt.minGlyphs) continue;
        // 四条边外侧都要有黑描边（白色家具/枕头没有这个）
        const ring = ['top', 'bottom', 'left', 'right'].map(s => sideDark(cp.x0, cp.y0, cp.x1, cp.y1, s));
        if (Math.max.apply(null, ring) > opt.ringDark) continue;
        // 字的"列"：x 上重叠的字块并成一列（字母 i 的点、引号这类会在同一列）。
        // 注意只按**重叠**合并：按"高度的一个比例"当容差会把整串字母并成一列
        //（曾经用 med*0.35 而 med 是字高 → 每列都并到一起 → 空格再也补不出来）。
        const cols = [];
        inked.map(g => [g.x0, g.x1]).sort((a, b) => a[0] - b[0]).forEach(r2 => {
          const last = cols[cols.length - 1];
          if (last && r2[0] <= last[1] + 1) last[1] = Math.max(last[1], r2[1]);
          else cols.push([r2[0], r2[1]]);
        });
        found.push({
          x: cp.x0, y: cp.y0, w: bw, h: bh, ink: Math.round(inkFrac * 1000) / 1000,
          glyphs: inked.length, cols,
        });
      }
      return found;
    };
    const all = [];
    for (const t of opt.whiteThresh) {
      for (const bd of scan(t)) {
        const dup = all.some(o => {
          const ix = Math.max(0, Math.min(o.x + o.w, bd.x + bd.w) - Math.max(o.x, bd.x));
          const iy = Math.max(0, Math.min(o.y + o.h, bd.y + bd.h) - Math.max(o.y, bd.y));
          const inter = ix * iy;
          if (inter <= 0) return false;
          const iou = inter / (o.w * o.h + bd.w * bd.h - inter);
          const cover = inter / Math.min(o.w * o.h, bd.w * bd.h);   // 小框被大框套住
          return iou >= opt.iou || cover >= opt.contain;
        });
        if (!dup) all.push(bd);
      }
    }
    all.sort((a, b) => a.y - b.y || a.x - b.x);
    return all;
  }

  /**
   * 把 OCR 的原始输出整理成区域名。主要就干一件事：**补空格**。
   *
   * 实测（contest 截图 17 个徽章）：字母准确率 99%，唯一成片的错误是**词间空格**
   * —— `CABIN A` 读成 `CABINA`、`SLOOP B` 读成 `SLOOPB`。补空格用的是两条跨徽章线索：
   *
   * ① 有些徽章的空格 OCR 保住了（`CABIN B` / `FRIGATE B` / `SLOOP CC`）→ 这些前缀就是"已知词"；
   *    别的徽章读到 `CABINA`、`SLOOPA` 时，把"已知词 + 1~2 个尾字母"切开。
   *    （这一条不需要词典，也不需要知道题面是什么语言，纯粹靠同一张图里的一致性）
   * ② 尾词重复收掉：`SLOOP CC` → `SLOOP C`（`CLIFF` 这种单个词不受影响）
   * ③ 兜底才用几何：字块列间距里"最大间隔显著大于其余"时切一刀
   *
   * @param {Array<string|{name:string,badge?:object}>} items OCR 原始输出（可带徽章几何）
   * @returns {string[]} 整理后的名字
   */
  function mergeOcrNames(items) {
    const norm = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const raw = (items || []).map(it => norm(typeof it === 'string' ? it : it.name));
    const words = new Set();
    raw.forEach(s2 => s2.split(' ').forEach(w => { if (w.length >= 3) words.add(w); }));
    return raw.map((s0, i) => {
      const badge = (items && items[i] && items[i].badge) || null;
      let s = s0.replace(/ ([A-Z])\1$/, ' $1');                 // ② 尾词重复
      if (!s.includes(' ')) {
        for (let k = s.length - 1; k >= 3; k--) {                // ① 已知词 + 尾字母
          const head = s.slice(0, k), tail = s.slice(k);
          if (tail.length <= 2 && words.has(head)) { s = head + ' ' + tail; break; }
        }
      }
      if (!s.includes(' ') && badge && badge.cols && badge.cols.length > 2) {   // ③ 几何兜底
        const cols = badge.cols, letters = s.replace(/ /g, '');
        if (cols.length === letters.length) {
          const gaps = [];
          for (let k = 1; k < cols.length; k++) gaps.push(Math.max(0, cols[k][0] - cols[k - 1][1]));
          const rank = gaps.map((g, k) => [g, k]).sort((a, b) => b[0] - a[0]);
          if (rank[0][0] >= Math.max(4, 0.2 * (badge.h || 0)) && rank[0][0] >= rank[1][0] * 1.6) {
            const at = rank[0][1];
            s = letters.slice(0, at + 1) + ' ' + letters.slice(at + 1);
          }
        }
      }
      return s;
    });
  }

  return { pickRegionLabels, labelToCell, labelsToSeeds, areaBox, inBox, findLabelBadges, mergeOcrNames };
});

/*! Mudorku Helper — core.js
 * 纯逻辑层：不依赖 DOM / 浏览器 API，浏览器里挂到 window.MurdokuCore，
 * Node 下可直接 require() 做单元测试。
 *
 * 坐标约定：所有格子键都是字符串 "r,c"（0 基），避免集合/对象序列化时的类型问题。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MurdokuCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 常量

  // A–Z 去掉 X
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(ch => ch !== 'X');
  const MAX_PEOPLE = 100;
  const MAX_DIM = 40;
  const MIN_DIM = 1;
  // 棋盘缩放：每格显示的像素大小（对齐底图时需要更大的范围）
  const CELL_MIN = 12;
  const CELL_MAX = 160;
  const CELL_DEFAULT = 44;
  const CELL_STEP = 6;

  // 底图（衬在网格下方的图片 / PDF 页面）
  const HEAD_W_MAX = 132, HEAD_W_MIN = 56;  // 行统计条宽度（随格子大小缩放）
  const HEAD_H_MAX = 72, HEAD_H_MIN = 34;   // 列统计条高度
  const HEAD_LABELS = 6;                    // 一条里最多显示几个人，多出来的折成 +N
  const HEAD_CHIP_W = 22, HEAD_CHIP_H = 13; // 一个标签大致占的宽 / 高（估算容量用）
  const BG_SCALE_MIN = 0.1;
  const BG_SCALE_MAX = 4;
  const BG_OPACITY_MIN = 0.1;
  const GRID_LIMIT = 4000;   // 网格偏移上下限，防止拖飞
  const BG_KINDS = ['image', 'pdf'];

  const PERSON_COLORS = [
    '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2',
    '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#c026d3',
    '#b45309', '#1d4ed8', '#be123c', '#15803d', '#a21caf', '#0369a1',
    '#ca8a04', '#9333ea', '#059669', '#e11d48', '#0284c7', '#7c2d12',
    '#4338ca', '#a16207', '#155e75', '#86198f', '#3f6212', '#9a3412',
  ];
  const REGION_COLORS = [
    '#0ea5e9', '#f97316', '#22c55e', '#a855f7', '#eab308', '#14b8a6',
    '#f43f5e', '#6366f1', '#84cc16', '#ec4899', '#06b6d4', '#f59e0b',
  ];
  const ITEM_COLORS = [
    '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444',
    '#14b8a6', '#a855f7', '#f97316', '#06b6d4', '#84cc16', '#e11d48',
  ];

  const STATE_VERSION = 1;

  // ---------------------------------------------------------------- 基础工具

  function key(r, c) { return r + ',' + c; }

  function unkey(k) {
    const i = String(k).indexOf(',');
    return { r: Number(String(k).slice(0, i)), c: Number(String(k).slice(i + 1)) };
  }

  /** 只接受规范形式的格子键（必须是 "r,c"，不接受 "01,2" 这种写法） */
  function isValidKey(k, rows, cols) {
    if (typeof k !== 'string' || !/^\d+,\d+$/.test(k)) return false;
    const { r, c } = unkey(k);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return false;
    if (key(r, c) !== k) return false;
    return r >= 0 && c >= 0 && r < rows && c < cols;
  }

  function clampInt(v, lo, hi, dflt) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 128, g: 128, b: 128 };
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /** 第 index 个人物标签：A B C … W Y Z AA AB …（始终跳过含 X 的标签） */
  function labelFor(index) {
    let n = Math.max(0, Math.trunc(index));
    let out = '';
    for (;;) {
      out = LETTERS[n % LETTERS.length] + out;
      n = Math.floor(n / LETTERS.length) - 1;
      if (n < 0) break;
    }
    return out;
  }

  /** 人物数量 = min(行, 列)，并受上限保护 */
  function peopleCount(rows, cols) {
    return Math.max(0, Math.min(rows, cols, MAX_PEOPLE));
  }

  /** 四邻格 */
  function neighbors(r, c, rows, cols) {
    const out = [];
    if (r > 0) out.push(key(r - 1, c));
    if (r < rows - 1) out.push(key(r + 1, c));
    if (c > 0) out.push(key(r, c - 1));
    if (c < cols - 1) out.push(key(r, c + 1));
    return out;
  }

  /** 四连通判定 */
  function isConnected(cells) {
    if (!cells || cells.length <= 1) return true;
    const set = new Set(cells);
    const start = cells[0];
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      const { r, c } = unkey(cur);
      const nb = [
        key(r - 1, c), key(r + 1, c), key(r, c - 1), key(r, c + 1),
      ];
      for (const n of nb) {
        if (set.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    return seen.size === set.size;
  }

  /** 最大连通块（用于「只保留最大连通块」按钮） */
  function largestComponent(cells) {
    const set = new Set(cells || []);
    const seen = new Set();
    let best = [];
    for (const start of set) {
      if (seen.has(start)) continue;
      const comp = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        const { r, c } = unkey(cur);
        for (const n of [key(r - 1, c), key(r + 1, c), key(r, c - 1), key(r, c + 1)]) {
          if (set.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
      if (comp.length > best.length) best = comp;
    }
    return best;
  }

  function mergeRuns(nums) {
    const s = nums.slice().sort((a, b) => a - b);
    const out = [];
    let start = null, prev = null;
    for (const n of s) {
      if (start === null) { start = prev = n; continue; }
      if (n === prev + 1) { prev = n; continue; }
      out.push([start, prev]);
      start = prev = n;
    }
    if (start !== null) out.push([start, prev]);
    return out;
  }

  /**
   * 区域外轮廓：返回合并成一整段的边界线段（单位＝格）。
   * 每条线段 {x1,y1,x2,y2}，配合 SVG viewBox="0 0 cols rows" 直接使用。
   */
  function regionOutlineSegments(cells) {
    const set = new Set(cells || []);
    const hTop = new Map(), hBottom = new Map(), vLeft = new Map(), vRight = new Map();
    const add = (m, line, pos) => {
      let arr = m.get(line);
      if (!arr) { arr = []; m.set(line, arr); }
      arr.push(pos);
    };
    for (const k of set) {
      const { r, c } = unkey(k);
      if (!set.has(key(r - 1, c))) add(hTop, r, c);
      if (!set.has(key(r + 1, c))) add(hBottom, r + 1, c);
      if (!set.has(key(r, c - 1))) add(vLeft, c, r);
      if (!set.has(key(r, c + 1))) add(vRight, c + 1, r);
    }
    const segs = [];
    for (const [y, cols] of hTop) for (const [a, b] of mergeRuns(cols)) segs.push({ x1: a, y1: y, x2: b + 1, y2: y });
    for (const [y, cols] of hBottom) for (const [a, b] of mergeRuns(cols)) segs.push({ x1: a, y1: y, x2: b + 1, y2: y });
    for (const [x, rows] of vLeft) for (const [a, b] of mergeRuns(rows)) segs.push({ x1: x, y1: a, x2: x, y2: b + 1 });
    for (const [x, rows] of vRight) for (const [a, b] of mergeRuns(rows)) segs.push({ x1: x, y1: a, x2: x, y2: b + 1 });
    return segs;
  }

  /** 把线段列表转成 SVG path d（单位＝格） */
  function segmentsToPath(segs) {
    return (segs || []).map(s => 'M' + s.x1 + ' ' + s.y1 + 'L' + s.x2 + ' ' + s.y2).join('');
  }

  // ---------------------------------------------------------------- 状态构造

  function createState(rows, cols) {
    rows = clampInt(rows, MIN_DIM, MAX_DIM, 8);
    cols = clampInt(cols, MIN_DIM, MAX_DIM, 8);
    const n = peopleCount(rows, cols);
    const people = [];
    for (let i = 0; i < n; i++) {
      people.push({
        id: 'p' + (i + 1),
        label: labelFor(i),
        color: PERSON_COLORS[i % PERSON_COLORS.length],
        links: [], // {kind:'region'|'item', id, polarity:1|-1}
      });
    }
    return {
      version: STATE_VERSION,
      rows,
      cols,
      phase: 'prep', // 'prep' | 'play'
      people,
      regions: [], // {id,name,color,cells:string[]}
      items: [],   // {id,name,color,occupiable,cells:string[]}
      selectedPersonId: people.length ? people[0].id : null,
      settings: { cellSize: CELL_DEFAULT, liveValidate: true, leftMode: 'candidate', showHeads: true },
      // 衬在网格下方的底图（图片或 PDF 页面渲染结果）与网格在画布中的偏移
      bg: null,
      grid: { x: 0, y: 0 },
      play: {
        // xmarks[k] = { src:'user'|'place', by: personId|null }
        xmarks: {},
        // candidates[personId] = [key,...]
        candidates: {},
        // placed[personId] = key
        placed: {},
      },
    };
  }

  // ---------------------------------------------------------------- 底图与网格对位

  function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  /** 规范化底图元数据；返回 null 表示没有底图 */
  function normalizeBg(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const wRaw = Number(raw.w), hRaw = Number(raw.h);
    if (!Number.isFinite(wRaw) || !Number.isFinite(hRaw) || wRaw < 1 || hRaw < 1) return null;
    const w = Math.min(20000, Math.round(wRaw));
    const h = Math.min(20000, Math.round(hRaw));
    return {
      kind: BG_KINDS.indexOf(raw.kind) >= 0 ? raw.kind : 'image',
      name: String(raw.name == null ? '底图' : raw.name).slice(0, 80),
      w: Math.round(w),
      h: Math.round(h),
      srcW: Math.round(clampNum(raw.srcW, 1, 20000, w)),
      srcH: Math.round(clampNum(raw.srcH, 1, 20000, h)),
      scale: clampNum(raw.scale, BG_SCALE_MIN, BG_SCALE_MAX, 1),
      opacity: clampNum(raw.opacity, BG_OPACITY_MIN, 1, 0.85),
      visible: raw.visible !== false,
      // 裁切过之后置 true：图片与网格已对齐，之后缩放要三者同倍变化
      bound: raw.bound === true,
      page: Math.max(1, Math.round(clampNum(raw.page, 1, 999, 1))),
      pages: Math.max(1, Math.round(clampNum(raw.pages, 1, 999, 1))),
    };
  }

  /** 设置或移除底图 */
  function setBackground(state, bg) {
    if (!bg) {
      const had = !!state.bg;
      state.bg = null;
      state.grid = { x: 0, y: 0 };
      return { ok: had, message: had ? '已移除底图' : '当前没有底图' };
    }
    const next = normalizeBg(Object.assign({}, state.bg || {}, bg));
    if (!next) return { ok: false, message: '底图数据不合法' };
    state.bg = next;
    return { ok: true, message: '底图已就位', bg: next };
  }

  function updateBackground(state, patch) {
    if (!state.bg) return { ok: false, message: '当前没有底图' };
    const next = normalizeBg(Object.assign({}, state.bg, patch));
    if (!next) return { ok: false, message: '底图数据不合法' };
    state.bg = next;
    return { ok: true };
  }

  /** 底图实际占用的画面尺寸（图片原始像素 × 缩放） */
  function bgDisplaySize(state) {
    const b = state.bg;
    if (!b) return { w: 0, h: 0 };
    return { w: Math.round(b.w * b.scale), h: Math.round(b.h * b.scale) };
  }

  function setGridOffset(state, x, y) {
    const g = state.grid || (state.grid = { x: 0, y: 0 });
    g.x = Math.round(clampNum(x, -GRID_LIMIT, GRID_LIMIT, 0));
    g.y = Math.round(clampNum(y, -GRID_LIMIT, GRID_LIMIT, 0));
    return { ok: true };
  }

  function nudgeGrid(state, dx, dy) {
    const g = state.grid || (state.grid = { x: 0, y: 0 });
    return setGridOffset(state, g.x + dx, g.y + dy);
  }

  /**
   * 设置每格像素（缩放）。
   *
   * 底图**裁切过**之后会带 `bound` 标记：此时图片与网格已经对齐，缩放必须把
   * 格子、底图缩放、网格偏移三者同倍变化，否则对齐会散掉。没裁切过（还在对齐
   * 阶段）则只动格子、底图保持不动 —— 那正是「对齐」需要的自由度。
   */
  function setCellSize(state, cell) {
    const prev = state.settings.cellSize;
    const next = clampInt(cell, CELL_MIN, CELL_MAX, prev);
    if (next === prev) return { ok: false, changed: false, cellSize: prev };
    state.settings.cellSize = next;
    const b = state.bg;
    if (b && b.bound) {
      const k = next / prev;
      b.scale = clampNum(b.scale * k, BG_SCALE_MIN, BG_SCALE_MAX, b.scale);
      if (state.grid) {
        state.grid.x = Math.round(clampNum(state.grid.x * k, -GRID_LIMIT, GRID_LIMIT, state.grid.x));
        state.grid.y = Math.round(clampNum(state.grid.y * k, -GRID_LIMIT, GRID_LIMIT, state.grid.y));
      }
    }
    return { ok: true, changed: true, cellSize: next };
  }

  /**
   * 按网格外框算出底图该裁到哪儿（全部用【图片像素】坐标）。
   * 网格现在在屏幕坐标 (grid.x, grid.y)，除以底图缩放即得图片坐标。
   * margin 是希望四周多留的边距（屏幕 px）。
   *
   * @returns {{x,y,w,h,scale,gridX,gridY}|null} 裁切矩形 + 裁切后网格该摆在哪
   */
  function gridCropRect(state, margin) {
    const b = state.bg;
    if (!b) return null;
    const s = b.scale || 1;
    const cell = state.settings.cellSize;
    const gx = state.grid ? state.grid.x : 0;
    const gy = state.grid ? state.grid.y : 0;
    const m = Math.max(0, Number(margin) || 0) / s;
    const x0 = gx / s, y0 = gy / s;
    const x1 = (gx + state.cols * cell) / s, y1 = (gy + state.rows * cell) / s;
    const cx = Math.max(0, Math.floor(x0 - m));
    const cy = Math.max(0, Math.floor(y0 - m));
    const cx2 = Math.min(b.w, Math.ceil(x1 + m));
    const cy2 = Math.min(b.h, Math.ceil(y1 + m));
    const w = cx2 - cx, h = cy2 - cy;
    if (w < 8 || h < 8) return null;
    return {
      x: cx, y: cy, w, h, scale: s,
      // 裁切后网格左上角在新图里的屏幕坐标（对齐关系按构造保持不变）
      gridX: Math.round((x0 - cx) * s),
      gridY: Math.round((y0 - cy) * s),
    };
  }

  /** 画布布局：底图锚在 (0,0)，网格按 offset 摆放；画布尺寸取两者并集 */
  /** 行列提示表头是否显示：只有游玩阶段才有候选可提示 */
  function headsVisible(state) {
    return state.phase === 'play' && state.settings.showHeads !== false;
  }

  /** 行列提示表头占用的空间（隐藏时为 0）；随格子大小缩放，免得小格子时显得离谱 */
  function headSize(state) {
    if (!headsVisible(state)) return { w: 0, h: 0 };
    const cell = state.settings.cellSize;
    return {
      w: Math.round(Math.min(HEAD_W_MAX, Math.max(HEAD_W_MIN, cell * 1.25))),
      h: Math.round(Math.min(HEAD_H_MAX, Math.max(HEAD_H_MIN, cell * 0.78))),
    };
  }

  /**
   * 每行 / 每列都有哪些人的候选，以及该行是否已经有确定的人。
   * @returns {{rows:Array<{cands:string[],placed:string|null}>, cols:Array<...>}}
   */
  function linePeople(state) {
    const rows = [], cols = [];
    for (let r = 0; r < state.rows; r++) rows.push({ cands: [], placed: null });
    for (let c = 0; c < state.cols; c++) cols.push({ cands: [], placed: null });
    const split = k => {
      const i = String(k).indexOf(',');
      return [Number(String(k).slice(0, i)), Number(String(k).slice(i + 1))];
    };
    for (const p of state.people) {
      const at = state.play.placed[p.id];
      if (at) {
        const [r, c] = split(at);
        if (rows[r]) rows[r].placed = p.id;
        if (cols[c]) cols[c].placed = p.id;
      }
      for (const k of state.play.candidates[p.id] || []) {
        const [r, c] = split(k);
        if (rows[r] && rows[r].cands.indexOf(p.id) < 0) rows[r].cands.push(p.id);
        if (cols[c] && cols[c].cands.indexOf(p.id) < 0) cols[c].cands.push(p.id);
      }
    }
    return { rows, cols };
  }

  /**
   * 一条提示实际能放下几个标签。格子很小时文字面积也小，超过就会溢出格子，
   * 所以这里按「表头尺寸 × 格子尺寸」估个容量，多出来的折成 +N。
   */
  function headCapacity(state) {
    const cell = state.settings.cellSize;
    const hs = headSize(state);
    const lines = n => Math.max(1, Math.floor(n / HEAD_CHIP_H));
    const perLine = n => Math.max(1, Math.floor(n / HEAD_CHIP_W));
    const cap = n => Math.min(HEAD_LABELS, Math.max(1, n));
    return {
      // 行提示：宽度是 headW（可换行），每条高度 = 一个格子
      rowMax: cap(perLine(hs.w) * lines(cell)),
      // 列提示：宽度 = 一个格子，每条高度是 headH（可换行）
      colMax: cap(lines(cell) * lines(hs.h)),
    };
  }

  /**
   * 在行/列统计里点选一个人 P：把这一行（列）里**别人**的候选清掉，
   * 并给这些格子标 X —— 等于「这一行就是 P 的」。
   * P 自己在那一格的候选保留，那一格不会标 X（否则自相矛盾）。
   */
  function applyLineChoice(state, axis, index, pid) {
    const p = person(state, pid);
    if (!p) return { ok: false, message: '找不到这个人物' };
    const isCol = axis === 'col';
    const idx = Number(index);
    if (!(idx >= 0 && idx < (isCol ? state.cols : state.rows))) return { ok: false, message: '这一' + (isCol ? '列' : '行') + '不存在' };

    let cleared = 0, marked = 0, kept = 0;
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        if ((isCol ? c : r) !== idx) continue;
        const k = key(r, c);
        const mine = (state.play.candidates[pid] || []).indexOf(k) >= 0;
        let removed = 0;
        for (const other of state.people) {
          if (other.id === pid) continue;
          const arr = state.play.candidates[other.id];
          if (!arr) continue;
          let i;
          while ((i = arr.indexOf(k)) >= 0) { arr.splice(i, 1); removed++; }
        }
        cleared += removed;
        if (mine) { kept++; continue; }        // 留给 P 的格子：只清别人，不标 X
        // 这一行/列既然归 P，其余格子一律标 X（不只是"有别人候选"的那些）
        if (!xSource(state, k)) { toggleX(state, k); marked++; }
      }
    }
    if (!cleared && !marked) {
      return { ok: false, message: '这一' + (isCol ? '列' : '行') + '已经是 ' + p.label + ' 的了' };
    }
    return {
      ok: true, cleared, marked, kept, label: p.label,
      message: '第 ' + (idx + 1) + (isCol ? ' 列' : ' 行') + ' 归 ' + p.label + '：清掉 ' + cleared
        + ' 个别人的候选，其余 ' + marked + ' 格标了 ✕' + (kept ? '，' + kept + ' 格留给他' : ''),
    };
  }

  function boardLayout(state) {
    const cell = state.settings.cellSize;
    const gridW = state.cols * cell;
    const gridH = state.rows * cell;
    const gx = state.grid ? state.grid.x : 0;
    const gy = state.grid ? state.grid.y : 0;
    const bg = bgDisplaySize(state);
    const minX = Math.min(0, gx);
    const minY = Math.min(0, gy);
    const maxX = Math.max(bg.w, gx + gridW);
    const maxY = Math.max(bg.h, gy + gridH);
    // 行统计在网格右边、列统计在网格下面：画布只向右/下加宽，
    // 底图与网格都留在原位（不动原点），对位关系完全不受影响
    const head = headSize(state);
    return {
      cell, gridW, gridH, bgW: bg.w, bgH: bg.h,
      headW: head.w, headH: head.h,
      bgLeft: minX < 0 ? -minX : 0, bgTop: minY < 0 ? -minY : 0,
      gridLeft: gx - minX, gridTop: gy - minY,
      width: Math.max(maxX - minX, 1) + head.w, height: Math.max(maxY - minY, 1) + head.h,
    };
  }

  function nextId(list, prefix) {
    let max = 0;
    for (const it of list) {
      const m = /^(\D+)(\d+)$/.exec(it.id || '');
      if (m && m[1] === prefix + '-') max = Math.max(max, Number(m[2]));
    }
    return prefix + '-' + (max + 1);
  }

  // ---------------------------------------------------------------- 查询

  function person(state, id) { return (state.people || []).find(p => p.id === id) || null; }
  function region(state, id) { return (state.regions || []).find(x => x.id === id) || null; }
  function item(state, id) { return (state.items || []).find(x => x.id === id) || null; }

  /** 该格所属区域 id 列表 */
  function regionsAt(state, k) {
    const out = [];
    for (const reg of state.regions || []) if (reg.cells.indexOf(k) >= 0) out.push(reg.id);
    return out;
  }

  /** 该格上的所有物品（正常情况下最多一个） */
  function itemsAt(state, k) {
    const out = [];
    for (const it of state.items || []) if (it.cells.indexOf(k) >= 0) out.push(it);
    return out;
  }

  /** 该格上的物品（一个格子在 core 层强制只归属一个物品） */
  function itemAt(state, k) {
    for (const it of state.items || []) if (it.cells.indexOf(k) >= 0) return it;
    return null;
  }

  /** 该格上已放置的人物 id（最多一个） */
  function personAt(state, k) {
    const placed = state.play && state.play.placed || {};
    for (const id in placed) if (placed[id] === k) return id;
    return null;
  }

  /** 该格是否是「不可占据物品」格（自动 X）；同格多个物品时任一不可占据即视为不可放人 */
  function isAutoX(state, k) {
    for (const it of state.items || []) {
      if (!it.occupiable && it.cells.indexOf(k) >= 0) return true;
    }
    return false;
  }

  /** place 类 X 的主人列表（兼容旧存档里 by 是字符串的写法） */
  function placeOwners(state, k) {
    const rec = state.play && state.play.xmarks ? state.play.xmarks[k] : null;
    if (!rec || rec.src !== 'place') return [];
    if (Array.isArray(rec.by)) return rec.by.slice();
    return rec.by ? [rec.by] : [];
  }

  /** 当前所有"已确定人物"里，行列覆盖到 k 的人（k 本身除外） */
  function rowColOwners(state, k) {
    const { r, c } = unkey(k);
    const out = [];
    const placed = state.play && state.play.placed ? state.play.placed : {};
    for (const id in placed) {
      const at = placed[id];
      if (!at || at === k) continue;
      const q = unkey(at);
      if (q.r === r || q.c === c) out.push(id);
    }
    return out;
  }

  /**
   * 把"行列排除"补齐成自洽状态（导入外部 JSON 时用）：
   * 每个已确定人物都会独占其整行整列（除自身格），缺失的 place ✕ 补上，失效的主人剔除。
   */
  function reconcileExcludedX(state) {
    const placed = state.play.placed || {};
    for (const id in placed) {
      const at = placed[id];
      if (!at) continue;
      const { r, c } = unkey(at);
      const cells = [];
      for (let cc = 0; cc < state.cols; cc++) if (cc !== c) cells.push(key(r, cc));
      for (let rr = 0; rr < state.rows; rr++) if (rr !== r) cells.push(key(rr, c));
      for (const kk of cells) {
        if (isAutoX(state, kk)) continue;
        const rec = state.play.xmarks[kk];
        if (rec && rec.src === 'user') continue;      // 用户自己标的 X 也算数
        if (rec && rec.src === 'place') {
          const owners = Array.isArray(rec.by) ? rec.by : (rec.by ? [rec.by] : []);
          if (owners.indexOf(id) < 0) rec.by = owners.concat([id]);
          continue;
        }
        state.play.xmarks[kk] = { src: 'place', by: [id] };
      }
    }
    // 主人已经全部解除的 place ✕ → 删掉
    for (const kk in state.play.xmarks) {
      const rec = state.play.xmarks[kk];
      if (!rec || rec.src !== 'place') continue;
      const owners = (Array.isArray(rec.by) ? rec.by : (rec.by ? [rec.by] : []))
        .filter(id => !!placed[id]);
      if (owners.length) rec.by = owners;
      else delete state.play.xmarks[kk];
    }
  }

  /** X 的来源：'user' | 'place' | 'auto' | null */
  function xSource(state, k) {
    if (isAutoX(state, k)) return 'auto';
    const rec = state.play && state.play.xmarks ? state.play.xmarks[k] : null;
    return rec ? (rec.src || 'user') : null;
  }

  function isX(state, k) { return xSource(state, k) !== null; }

  /** 该格上的候选人物 id 列表 */
  function candidatesAt(state, k) {
    const out = [];
    const cand = state.play && state.play.candidates || {};
    for (const p of state.people || []) {
      const arr = cand[p.id];
      if (arr && arr.indexOf(k) >= 0) out.push(p.id);
    }
    return out;
  }

  function personCandidateCount(state, personId) {
    const arr = state.play && state.play.candidates ? state.play.candidates[personId] : null;
    return arr ? arr.length : 0;
  }

  /** 某人物当前所有合法格（不受 X / 已放置 / 同行列已放置影响） */
  function legalCells(state, personId) {
    const placed = state.play.placed || {};
    const freeRows = new Set(), freeCols = new Set();
    for (const id in placed) {
      if (id === personId) continue;
      const k = placed[id];
      if (!k) continue;
      const { r, c } = unkey(k);
      freeRows.add(r);
      freeCols.add(c);
    }
    const out = [];
    for (let r = 0; r < state.rows; r++) {
      for (let c = 0; c < state.cols; c++) {
        const k = key(r, c);
        if (xSource(state, k)) continue;
        if (personAt(state, k)) continue;
        if (freeRows.has(r) || freeCols.has(c)) continue;
        out.push(k);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 区域 / 物品 编辑

  /** 把 cells 从同一类实体的其它成员里摘掉（保证「一格只属于一个区域 / 一个物品」） */
  function claimCellsExclusively(state, list, ownerId, cells) {
    const pick = new Set(cells);
    for (const other of list) {
      if (other.id === ownerId) continue;
      other.cells = other.cells.filter(k => !pick.has(k));
    }
  }

  function createRegion(state, name, cells) {
    const clean = dedupeCells(state, cells);
    const color = REGION_COLORS[state.regions.length % REGION_COLORS.length];
    const reg = { id: nextId(state.regions, 'r'), name: name || ('区域 ' + (state.regions.length + 1)), color, cells: clean };
    // 一个格子只归属一个区域：从其它区域里摘掉
    claimCellsExclusively(state, state.regions, reg.id, clean);
    state.regions.push(reg);
    return reg;
  }

  function createItem(state, name, cells, occupiable) {
    const clean = dedupeCells(state, cells);
    const color = ITEM_COLORS[state.items.length % ITEM_COLORS.length];
    const it = {
      id: nextId(state.items, 'i'),
      name: name || ('物品 ' + (state.items.length + 1)),
      color,
      occupiable: occupiable !== false,
      cells: clean,
    };
    // 一个格子只归属一个物品：从其它物品里摘掉
    claimCellsExclusively(state, state.items, it.id, clean);
    state.items.push(it);
    return it;
  }

  function dedupeCells(state, cells) {
    const seen = new Set();
    const out = [];
    for (const k of cells || []) {
      if (!isValidKey(k, state.rows, state.cols) || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  }

  function deleteRegion(state, id) {
    state.regions = state.regions.filter(r => r.id !== id);
    for (const p of state.people) p.links = p.links.filter(l => !(l.kind === 'region' && l.id === id));
  }

  function deleteItem(state, id) {
    state.items = state.items.filter(i => i.id !== id);
    for (const p of state.people) p.links = p.links.filter(l => !(l.kind === 'item' && l.id === id));
  }

  const LABEL_MAX = 4;

  /** 编号规范化：去空白、限长、不允许含 X（X 在棋盘上表示「不能放人」）。
   *  返回合法编号，或 null 表示不合法。生成默认编号与导入校验共用这一套规则。 */
  function normalizeLabel(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s.length > LABEL_MAX) return null;
    if (/x/i.test(s)) return null;
    return s;
  }

  /** 修改人物编号（默认编号是 A–Z 跳过 X 自动生成的） */
  function setPersonLabel(state, personId, label) {
    const p = person(state, personId);
    if (!p) return { ok: false, message: '人物不存在' };
    const clean = normalizeLabel(label);
    if (!clean) {
      return { ok: false, message: '编号需为 1–' + LABEL_MAX + ' 个字符，且不能含 X（X 表示「不能放人」）' };
    }
    if (state.people.some(o => o.id !== personId && o.label === clean)) {
      return { ok: false, message: '编号「' + clean + '」已被其它人物占用' };
    }
    if (p.label === clean) return { ok: false, message: '编号没有变化' };
    const before = p.label;
    p.label = clean;
    return { ok: true, message: '已把 ' + before + ' 改名为「' + clean + '」' };
  }

  /** 设置人物关联：polarity 0 表示删除该关联，1 正 / -1 负。
   *  已存在的关联只改极性、保持原位置——切换正负不该让列表顺序跳动。 */
  function setLink(state, personId, kind, targetId, polarity) {
    const p = person(state, personId);
    if (!p) return null;
    const i = p.links.findIndex(l => l.kind === kind && l.id === targetId);
    if (polarity === 1 || polarity === -1) {
      if (i >= 0) p.links[i].polarity = polarity;
      else p.links.push({ kind, id: targetId, polarity });
    } else if (i >= 0) {
      p.links.splice(i, 1);
    }
    return p;
  }

  function getLink(state, personId, kind, targetId) {
    const p = person(state, personId);
    if (!p) return 0;
    const l = p.links.find(x => x.kind === kind && x.id === targetId);
    return l ? l.polarity : 0;
  }

  // ---------------------------------------------------------------- 游玩规则

  function clearCandidatesAt(state, k) {
    const cand = state.play.candidates;
    let removed = 0;
    for (const id in cand) {
      const i = cand[id].indexOf(k);
      if (i >= 0) { cand[id].splice(i, 1); removed++; }
    }
    return removed;
  }

  function clearCandidatesOf(state, personId) {
    const n = personCandidateCount(state, personId);
    state.play.candidates[personId] = [];
    return n;
  }

  function posText(k) {
    const { r, c } = unkey(k);
    return '(' + (r + 1) + ',' + (c + 1) + ')';
  }

  /** 用户手动标注 / 取消 X */
  function toggleX(state, k) {
    if (!isValidKey(k, state.rows, state.cols)) return { ok: false, message: '格子不存在' };
    const src = xSource(state, k);
    if (src === 'auto') {
      const it = itemAt(state, k);
      return { ok: false, message: posText(k) + ' 是「' + it.name + '」不可占据格，固定为 X' };
    }
    const pid = personAt(state, k);
    if (pid) return { ok: false, message: posText(k) + ' 已放置 ' + person(state, pid).label + '，不能再标 X' };

    if (src === 'place') {
      // 行列排除是"已确定人物"的推论，不能单独擦掉，否则地图会与规则脱节
      const names = placeOwners(state, k).map(id => person(state, id)).filter(Boolean).map(p => p.label).join('、');
      return {
        ok: false,
        message: posText(k) + ' 上的 X 来自 ' + (names || '已确定人物') + ' 的同行/同列排除，取消该人物的确定位置才能解除',
      };
    }
    if (src === 'user') {
      // 用户可能是在"某人行列排除"的格子上又标了 X；取消时要看行列排除是否仍然成立
      const owners = rowColOwners(state, k);
      if (owners.length) {
        state.play.xmarks[k] = { src: 'place', by: owners };
        const names = owners.map(id => person(state, id)).filter(Boolean).map(p => p.label).join('、');
        return { ok: true, message: '已取消 ' + posText(k) + ' 的手动 X（该格仍被 ' + names + ' 的同行/同列排除）' };
      }
      delete state.play.xmarks[k];
      return { ok: true, message: '已取消 ' + posText(k) + ' 的 X' };
    }
    state.play.xmarks[k] = { src: 'user', by: null };
    const n = clearCandidatesAt(state, k);
    return {
      ok: true,
      message: '已在 ' + posText(k) + ' 标 X' + (n ? '，同时清除了 ' + n + ' 个候选' : ''),
    };
  }

  /** 点击格子：切换候选 */
  function toggleCandidate(state, personId, k) {
    const p = person(state, personId);
    if (!p) return { ok: false, message: '请先选择一个人物' };
    if (!isValidKey(k, state.rows, state.cols)) return { ok: false, message: '格子不存在' };
    if (state.play.placed[personId]) {
      return { ok: false, message: p.label + ' 已确定位置，先「取消确定」再标注候选' };
    }
    const src = xSource(state, k);
    if (src) {
      return { ok: false, message: posText(k) + ' 已标 X，不能作为候选' };
    }
    const other = personAt(state, k);
    if (other) return { ok: false, message: posText(k) + ' 已放置 ' + person(state, other).label };

    const arr = state.play.candidates[personId] || (state.play.candidates[personId] = []);
    const i = arr.indexOf(k);
    if (i >= 0) {
      arr.splice(i, 1);
      return { ok: true, message: '已取消 ' + p.label + ' 在 ' + posText(k) + ' 的候选' };
    }
    arr.push(k);
    return { ok: true, message: p.label + ' 候选 +1 ' + posText(k) };
  }

  /**
   * 拖动刷选用：把候选「设成」on（true=加上，false=去掉），而不是翻转。
   * 已经是目标状态时返回 noop，避免拖动过程中对合法格子反复报错。
   */
  function setCandidate(state, personId, k, on) {
    const arr = state.play.candidates[personId] || (state.play.candidates[personId] = []);
    const has = arr.indexOf(k) >= 0;
    if (!!on === has) return { ok: true, noop: true, message: '' };
    return toggleCandidate(state, personId, k);
  }

  /** 拖动刷选用：把 X「设成」on；已经是目标状态（含 auto / 行列排除）时 noop */
  function setX(state, k, on) {
    const isNow = !!xSource(state, k);
    if (!!on === isNow) return { ok: true, noop: true, message: '' };
    return toggleX(state, k);
  }

  /**
   * 长按确定：把 personId 确定在 k，并在同行、同列（除当前格）标 X。
   * 返回 { ok, message }
   */
  function placePerson(state, personId, k) {
    const p = person(state, personId);
    if (!p) return { ok: false, message: '请先选择一个人物' };
    if (!isValidKey(k, state.rows, state.cols)) return { ok: false, message: '格子不存在' };

    const cur = state.play.placed[personId];
    if (cur === k) return { ok: false, message: p.label + ' 已经确定在 ' + posText(k) };

    const src = xSource(state, k);
    if (src === 'auto') {
      const it = itemAt(state, k);
      return { ok: false, message: posText(k) + ' 的「' + it.name + '」不可占据，不能放人' };
    }
    if (src === 'user') {
      return { ok: false, message: posText(k) + ' 已标 X，先取消 X 再确定' };
    }
    const other = personAt(state, k);
    if (other) return { ok: false, message: posText(k) + ' 已放置 ' + person(state, other).label };

    const { r, c } = unkey(k);
    const placed = state.play.placed;
    for (const id in placed) {
      if (id === personId || !placed[id]) continue;
      const q = unkey(placed[id]);
      if (q.r === r || q.c === c) {
        return {
          ok: false,
          message: '第 ' + (r + 1) + ' 行/第 ' + (c + 1) + ' 列已有 ' + person(state, id).label +
            ' 在 ' + posText(placed[id]) + '，不能再放 ' + p.label,
        };
      }
    }

    // 若该人物之前确定在别处，先撤销它的旧排除标记
    if (cur) unplacePerson(state, personId);

    placed[personId] = k;
    const clearedCand = clearCandidatesOf(state, personId);
    clearCandidatesAt(state, k); // 别人在该格的候选也失效

    // 同行/同列标 X。一个格子可能同时属于多个人的行列（交叉格），因此 by 记主人列表：
    // 只有全部主人都取消确定后，这个 X 才会消失。
    const mark = kk => {
      if (isAutoX(state, kk)) return false;              // 物品固定 X，无主
      const rec = state.play.xmarks[kk];
      if (rec && rec.src === 'user') return false;       // 用户自己标的 X，不动它
      if (rec && rec.src === 'place') {
        const owners = Array.isArray(rec.by) ? rec.by : (rec.by ? [rec.by] : []);
        if (owners.indexOf(personId) >= 0) return false;
        rec.by = owners.concat([personId]);
        return true;
      }
      state.play.xmarks[kk] = { src: 'place', by: [personId] };
      return true;
    };

    let marked = 0, candCleared = 0;
    for (let cc = 0; cc < state.cols; cc++) {
      if (cc === c) continue;
      const kk = key(r, cc);
      if (mark(kk)) { marked++; candCleared += clearCandidatesAt(state, kk); }
    }
    for (let rr = 0; rr < state.rows; rr++) {
      if (rr === r) continue;
      const kk = key(rr, c);
      if (mark(kk)) { marked++; candCleared += clearCandidatesAt(state, kk); }
    }

    return {
      ok: true,
      message: p.label + ' 已确定在 ' + posText(k) + '，同行列标了 ' + marked + ' 个 X' +
        (candCleared ? '，清除 ' + candCleared + ' 个失效候选' : '') +
        (clearedCand ? '，原有 ' + clearedCand + ' 个候选已清空' : ''),
    };
  }

  /** 取消确定位置，并移除由它产生的同行列 X（交叉格上属于别人的排除会保留） */
  function unplacePerson(state, personId) {
    const p = person(state, personId);
    if (!p || !state.play.placed[personId]) return { ok: false, message: '该人物没有确定位置' };
    const at = state.play.placed[personId];
    delete state.play.placed[personId];
    let removed = 0;
    for (const k in state.play.xmarks) {
      const rec = state.play.xmarks[k];
      if (!rec || rec.src !== 'place') continue;
      const owners = Array.isArray(rec.by) ? rec.by : (rec.by ? [rec.by] : []);
      const i = owners.indexOf(personId);
      if (i < 0) continue;
      owners.splice(i, 1);
      removed++;
      if (owners.length) rec.by = owners;
      else delete state.play.xmarks[k];
    }
    return { ok: true, message: '已取消 ' + p.label + ' 在 ' + posText(at) + ' 的确定，移除 ' + removed + ' 个排除 X' };
  }

  function clearPersonMarks(state, personId) {
    const p = person(state, personId);
    if (!p) return { ok: false, message: '人物不存在' };
    const wasPlaced = !!state.play.placed[personId];
    if (wasPlaced) unplacePerson(state, personId);
    const n = clearCandidatesOf(state, personId);
    return {
      ok: true,
      message: '已清除 ' + p.label + ' 的 ' + n + ' 个候选' + (wasPlaced ? '，并取消其确定位置' : ''),
    };
  }

  function clearAllMarks(state) {
    state.play = { xmarks: {}, candidates: {}, placed: {} };
    return { ok: true, message: '已清空游玩阶段的所有标记' };
  }

  // ---------------------------------------------------------------- 校验

  function validate(state) {
    const issues = [];
    const placedMap = state.play.placed || {};
    const entries = Object.keys(placedMap).filter(id => placedMap[id]).map(id => [id, placedMap[id]]);

    const byCell = new Map(), byRow = new Map(), byCol = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const [pid, k] of entries) {
      const { r, c } = unkey(k);
      push(byCell, k, pid); push(byRow, r, pid); push(byCol, c, pid);
    }
    for (const [k, ids] of byCell) {
      if (ids.length > 1) {
        issues.push({ level: 'error', key: k, text: posText(k) + ' 同时放了 ' + ids.map(i => person(state, i).label).join('、') });
      }
    }
    for (const [r, ids] of byRow) {
      if (ids.length > 1) {
        issues.push({ level: 'error', text: '第 ' + (r + 1) + ' 行有多个确定人物：' + ids.map(i => person(state, i).label).join('、') });
      }
    }
    for (const [c, ids] of byCol) {
      if (ids.length > 1) {
        issues.push({ level: 'error', text: '第 ' + (c + 1) + ' 列有多个确定人物：' + ids.map(i => person(state, i).label).join('、') });
      }
    }

    // 关联 / 硬约束
    for (const [pid, k] of entries) {
      const p = person(state, pid);
      if (!p) continue;
      const rec = state.play.xmarks ? state.play.xmarks[k] : null;
      if (rec && rec.src === 'user') {
        issues.push({ level: 'error', key: k, personId: pid, text: p.label + ' 放在了已标 X 的 ' + posText(k) });
      }
      const it = itemAt(state, k);
      if (it && !it.occupiable) {
        issues.push({ level: 'error', key: k, text: p.label + ' 放在不可占据的物品「' + it.name + '」上 ' + posText(k) });
      }
      // 注意：人物↔区域/物品的「关联」只是相关性提示（供悬停高亮参考），
      // 不是必须满足的规则，所以这里不做校验。
    }

    // 无合法位置 / 唯一候选冲突
    const singles = new Map();
    for (const p of state.people) {
      if (state.play.placed[p.id]) continue;
      const legal = legalCells(state, p.id);
      if (legal.length === 0) {
        issues.push({ level: 'error', personId: p.id, text: p.label + ' 已经没有任何可放的位置' });
      }
      const cand = (state.play.candidates[p.id] || []).filter(k => !xSource(state, k));
      if (cand.length === 1) {
        if (!singles.has(cand[0])) singles.set(cand[0], []);
        singles.get(cand[0]).push(p);
      }
      if (cand.length > 0 && cand.length !== (state.play.candidates[p.id] || []).length) {
        issues.push({ level: 'warn', personId: p.id, text: p.label + ' 有候选格已被 X 排除，可考虑清理' });
      }
      if (cand.length === 0 && legal.length > 0 && personCandidateCount(state, p.id) > 0) {
        issues.push({ level: 'warn', personId: p.id, text: p.label + ' 的所有候选都不合法了' });
      }
    }
    for (const [k, ps] of singles) {
      if (ps.length > 1) {
        issues.push({ level: 'error', key: k, text: ps.map(p => p.label).join('、') + ' 都只剩候选 ' + posText(k) + '，冲突' });
      }
    }
    return issues;
  }

  // ---------------------------------------------------------------- 序列化

  /** 序列化；bgData 为底图的 dataURL，只有导出时才带上（自动存档不写它，避免每次操作都写几 MB） */
  function serialize(state, bgData) {
    return JSON.stringify(bgData ? Object.assign({}, state, { bgData: bgData }) : state, null, 2);
  }

  const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
  const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

  /** 只接受安全字符集的 id，否则用兜底 id（避免被拼进 HTML 属性） */
  function sanitizeId(id, fallback) {
    return (typeof id === 'string' && SAFE_ID.test(id)) ? id : fallback;
  }

  /** 只接受 #rrggbb 形式颜色，否则用调色板兜底 */
  function sanitizeColor(color, fallback) {
    if (typeof color !== 'string') return fallback;
    const c = color.trim();
    return HEX_COLOR.test(c) ? c : fallback;
  }

  function deserialize(text) {
    const raw = typeof text === 'string' ? JSON.parse(text) : text;
    if (!raw || typeof raw !== 'object') throw new Error('数据格式不正确');
    const rows = clampInt(raw.rows, MIN_DIM, MAX_DIM, 8);
    const cols = clampInt(raw.cols, MIN_DIM, MAX_DIM, 8);
    const st = createState(rows, cols);
    st.phase = raw.phase === 'play' ? 'play' : 'prep';

    if (Array.isArray(raw.regions)) {
      st.regions = [];
      for (const r of raw.regions) {
        if (!r) continue;
        st.regions.push({
          id: sanitizeId(r.id, nextId(st.regions, 'r')),
          name: String(r.name == null ? '区域' : r.name).slice(0, 60),
          color: sanitizeColor(r.color, REGION_COLORS[st.regions.length % REGION_COLORS.length]),
          cells: dedupeCells(st, r.cells),
        });
      }
    }
    if (Array.isArray(raw.items)) {
      st.items = [];
      for (const it of raw.items) {
        if (!it) continue;
        st.items.push({
          id: sanitizeId(it.id, nextId(st.items, 'i')),
          name: String(it.name == null ? '物品' : it.name).slice(0, 60),
          color: sanitizeColor(it.color, ITEM_COLORS[st.items.length % ITEM_COLORS.length]),
          occupiable: it.occupiable !== false,
          cells: dedupeCells(st, it.cells),
        });
      }
    }
    // 一个格子只归属一个区域 / 一个物品（文件里靠后的优先，与 UI 保存行为一致）
    for (const list of [st.regions, st.items]) {
      const taken = new Set();
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].cells = list[i].cells.filter(k => (taken.has(k) ? false : (taken.add(k), true)));
      }
    }
    // 人物：id / 关联尽量保留，但标签必须满足「A–Z 且跳过 X、互不重复」；数量始终等于 min(rows,cols)
    if (Array.isArray(raw.people)) {
      const people = [];
      const usedIds = new Set();
      const usedLabels = new Set();
      const freeId = () => { let n = st.people.length; while (usedIds.has('p' + (++n))); return 'p' + n; };
      const freeLabel = () => { let i = 0; while (usedLabels.has(labelFor(i))) i++; return labelFor(i); };
      const takeLabel = (want, fallback) => {
        const clean = normalizeLabel(want);
        if (clean && !usedLabels.has(clean)) return clean;
        if (!usedLabels.has(fallback)) return fallback;
        return freeLabel();
      };
      for (let i = 0; i < raw.people.length && i < st.people.length; i++) {
        const src = raw.people[i] || {};
        const p = st.people[i];
        const want = sanitizeId(src.id, null);
        if (want && !usedIds.has(want)) p.id = want;
        else if (usedIds.has(p.id)) p.id = freeId();
        usedIds.add(p.id);
        p.label = takeLabel(src.label, p.label);
        usedLabels.add(p.label);
        if (Array.isArray(src.links)) {
          p.links = src.links
            .filter(l => l && (l.kind === 'region' || l.kind === 'item') && l.id)
            // polarity 0 表示"无关联"，丢弃；缺省按正向（默认正向）
            .map(l => ({ kind: l.kind, id: String(l.id), polarity: l.polarity === -1 ? -1 : (l.polarity === 0 ? 0 : 1) }))
            .filter(l => l.polarity !== 0);
        }
        people.push(p);
      }
      // 文件里人物不足时补齐默认人物，保证人物数 = min(行, 列)
      for (let i = people.length; i < st.people.length; i++) {
        const p = st.people[i];
        if (usedIds.has(p.id)) p.id = freeId();
        usedIds.add(p.id);
        p.label = takeLabel(null, p.label);
        usedLabels.add(p.label);
        people.push(p);
      }
      st.people = people;
    }
    // 关联目标可能已不存在
    for (const p of st.people) {
      p.links = p.links.filter(l => l.kind === 'region' ? !!region(st, l.id) : !!item(st, l.id));
    }

    const play = raw.play || {};
    st.play = { xmarks: {}, candidates: {}, placed: {} };
    if (play.xmarks && typeof play.xmarks === 'object') {
      for (const k in play.xmarks) {
        if (!isValidKey(k, rows, cols)) continue;
        const rec = play.xmarks[k];
        const src = (rec === 'user' || rec === 'place') ? rec : (rec && rec.src);
        if (src === 'user') {
          st.play.xmarks[k] = { src: 'user', by: null };
        } else if (src === 'place') {
          const rawBy = rec && rec.by;
          const owners = (Array.isArray(rawBy) ? rawBy : [rawBy])
            .filter(id => typeof id === 'string' && st.people.some(p => p.id === id));
          // 没有主人的 place 标记是脏数据（删不掉也说不通），直接丢弃
          if (owners.length) st.play.xmarks[k] = { src: 'place', by: owners };
        }
      }
    }
    if (play.candidates && typeof play.candidates === 'object') {
      for (const pid in play.candidates) {
        if (!st.people.some(p => p.id === pid)) continue;
        const arr = Array.isArray(play.candidates[pid]) ? play.candidates[pid] : [];
        st.play.candidates[pid] = dedupeCells(st, arr);
      }
    }
    if (play.placed && typeof play.placed === 'object') {
      for (const pid in play.placed) {
        const k = play.placed[pid];
        if (!st.people.some(p => p.id === pid) || !isValidKey(k, rows, cols)) continue;
        st.play.placed[pid] = k;
      }
    }
    // 导入的外部 JSON 可能缺少/残留行列排除 X，这里统一重算成自洽状态
    reconcileExcludedX(st);
    st.selectedPersonId = st.people.some(p => p.id === raw.selectedPersonId)
      ? raw.selectedPersonId
      : (st.people[0] ? st.people[0].id : null);
    if (raw.settings && typeof raw.settings === 'object') {
      st.settings.cellSize = clampInt(raw.settings.cellSize, CELL_MIN, CELL_MAX, CELL_DEFAULT);
      st.settings.liveValidate = raw.settings.liveValidate !== false;
      st.settings.leftMode = raw.settings.leftMode === 'x' ? 'x' : 'candidate';
      st.settings.showHeads = raw.settings.showHeads !== false;
    }
    st.bg = normalizeBg(raw.bg);
    if (raw.grid && typeof raw.grid === 'object') setGridOffset(st, raw.grid.x, raw.grid.y);
    return st;
  }

  return {
    LETTERS, MAX_PEOPLE, MAX_DIM, MIN_DIM, STATE_VERSION,
    CELL_MIN, CELL_MAX, CELL_DEFAULT, CELL_STEP,
    BG_SCALE_MIN, BG_SCALE_MAX, BG_OPACITY_MIN, GRID_LIMIT,
    PERSON_COLORS, REGION_COLORS, ITEM_COLORS,
    key, unkey, isValidKey, clampInt, hexToRgb, rgba,
    labelFor, peopleCount, neighbors, isConnected, largestComponent,
    regionOutlineSegments, segmentsToPath, mergeRuns,
    createState, nextId, sanitizeId, sanitizeColor,
    normalizeBg, setBackground, updateBackground, bgDisplaySize, setGridOffset, nudgeGrid, boardLayout,
    setCellSize, gridCropRect, headsVisible, headSize, linePeople, headCapacity, applyLineChoice, HEAD_LABELS,
    person, region, item, regionsAt, itemsAt, itemAt, personAt, placeOwners, rowColOwners,
    normalizeLabel, setPersonLabel, LABEL_MAX,
    isAutoX, xSource, isX, candidatesAt, personCandidateCount, legalCells,
    createRegion, createItem, deleteRegion, deleteItem, setLink, getLink, dedupeCells,
    claimCellsExclusively,
    toggleX, setX, toggleCandidate, setCandidate, placePerson, unplacePerson, clearPersonMarks,
    clearCandidatesAt, clearCandidatesOf, clearAllMarks,
    validate, posText, serialize, deserialize, reconcileExcludedX,
  };
});

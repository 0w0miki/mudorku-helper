/*! Mudorku Helper — board.js
 * 棋盘渲染与交互：
 *   · 网格 + 区域加粗外轮廓（SVG 覆盖层）
 *   · 悬停格子 → 高亮所在区域；悬停人物 → 高亮关联区域/物品（负向红色）
 *   · 左键点按 = 候选；右键 = 标 X；长按（带圆形进度条）= 确定人物并在同行列标 X
 *   · 准备阶段：在图上点选/拖选格子（草稿）
 */
(function () {
  'use strict';
  const Core = window.MurdokuCore;
  const MH = window.MH;
  const SVGNS = 'http://www.w3.org/2000/svg';

  // 长按判定时长。可以被 MH.ui.longPressMs 覆盖 —— 单元测试把它调小，跑得快很多 ✓
  const LONG_PRESS_MS = 700;
  const longPressMs = () => (MH.ui && MH.ui.longPressMs) || LONG_PRESS_MS;
  const MOVE_CANCEL_PX = 12;
  const CAND_SHOW_MAX = 4;
  const HL_POS = 'rgba(22,163,74,.40)';
  const HL_NEG = 'rgba(239,68,68,.46)';
  const DRAFT_REGION_BG = 'rgba(99,102,241,.30)';

  const B = {
    cellEls: new Map(),
    outlineEls: new Map(),
    baseBg: new Map(),
    gridSig: '',
    outlineSig: '',
    prevHl: new Map(),
    prevCand: new Set(),
    press: null,
    painting: false,
    paintMode: 'add',
    ringEl: null,
    ringLen: 0,
    _hoverKey: null,
    _hoverPid: null,

    // ------------------------------------------------------------ 初始化

    init() {
      const els = MH.els;
      this.boardEl = els.board;
      this.cellsEl = els.cells;
      this.overlay = els.overlay;
      this.regionLayer = els.regionLayer;
      this.draftPath = els.draftOutline;
      this.ringLayer = els.ringLayer;

      this.bgEl = els.bgLayer;
      this.gridBox = els.gridBox;
      this.rowHeadsEl = els.rowHeads;
      this.colHeadsEl = els.colHeads;
      this.headCornerEl = els.headCorner;
      this.rowHeadEls = [];
      this.colHeadEls = [];
      this.hotHead = null;
      this.handleEl = els.alignHandle;
      this.imgEl = null;

      this.handleEl.addEventListener('pointerdown', e => this.onHandleDown(e));
      this.boardEl.addEventListener('pointerdown', e => this.onPointerDown(e));
      this.boardEl.addEventListener('pointermove', e => this.onPointerMove(e));
      this.boardEl.addEventListener('contextmenu', e => this.onContextMenu(e));
      this.boardEl.addEventListener('pointerleave', () => {
        this.cancelPress();
        MH.ui.hoverCell = null;
        MH.ui.hoverPersonId = null;
        this._hoverKey = null;
        this._hoverPid = null;
        this.applyHover();
      });
      // 手势中途失焦（切窗口等）：把已刷的改动落地成一条历史，不要漏在历史之外
      window.addEventListener('blur', () => {
        if (this.gesture && this.gesture.painting) {
          this.gesture = null;
          MH.store.endGesture();
        }
      });
      window.addEventListener('pointerup', e => this.onPointerUp(e));
      // 触摸滑动 / 双指缩放 / 系统弹窗会发 pointercancel，必须当作取消，避免误放人物
      window.addEventListener('pointercancel', () => {
        this.painting = false;
        this._paintKey = null;
        this.cancelPress();
        if (this.gesture) {
          const g = this.gesture;
          this.gesture = null;
          if (g.painting) MH.store.endGesture();
        }
      });
      this.fixStrokes();
    },

    /**
     * 覆盖层的 viewBox 是以「格」为单位的（0 0 cols rows），所以任何描边只要忘了
     * vector-effect，stroke-width 就会被放大成一格几十像素的粗色带（曾经把选区糊死）。
     * 这里统一兜底，避免以后新增图形时重犯。
     */
    fixStrokes() {
      for (const el of this.overlay.querySelectorAll('path, rect, line, polyline, polygon, circle, ellipse')) {
        if (!el.getAttribute('vector-effect')) el.setAttribute('vector-effect', 'non-scaling-stroke');
      }
    },

    // ------------------------------------------------------------ 结构

    rebuildIfNeeded() {
      const st = MH.store.state;
      const gridSig = st.rows + 'x' + st.cols;
      if (gridSig !== this.gridSig) {
        this.buildGrid(st);
        this.buildCells(st);
        this.buildHeads(st);
        this.gridSig = gridSig;
        this.outlineSig = null;
      }
      const osig = st.regions.map(r => r.id + '|' + r.color + '|' + r.cells.join(',')).join('#');
      if (osig !== this.outlineSig) {
        this.buildOutlines(st);
        this.outlineSig = osig;
      }
      this.boardEl.style.setProperty('--cell', st.settings.cellSize + 'px');
      this.applyLayout(st);
      this.syncBackground(st);
      this.updateDraftOutline(st);
    },

    /** 底图锚在画布原点，网格按偏移摆放；画布尺寸取两者并集 */
    applyLayout(st) {
      const L = Core.boardLayout(st);
      this.boardEl.style.width = L.width + 'px';
      this.boardEl.style.height = L.height + 'px';
      this.bgEl.style.left = L.bgLeft + 'px';
      this.bgEl.style.top = L.bgTop + 'px';
      this.grilElPos = { left: L.gridLeft, top: L.gridTop };
      this.gridBox.style.left = L.gridLeft + 'px';
      this.gridBox.style.top = L.gridTop + 'px';
      this.gridBox.style.width = L.gridW + 'px';
      this.gridBox.style.height = L.gridH + 'px';
      // 表头贴在网格外侧：行标题在左边，列标题在上边，靠 CSS 变量定位
      this.gridBox.style.setProperty('--headw', L.headW + 'px');
      this.gridBox.style.setProperty('--headh', L.headH + 'px');
      this.gridBox.style.setProperty('--headfont', (Core.headFont(st.settings.cellSize) || 10) + 'px');
      this.boardEl.classList.toggle('has-heads', L.headW > 0);
      this.handleEl.style.left = (L.gridLeft + L.gridW) + 'px';
      this.handleEl.style.top = (L.gridTop + L.gridH) + 'px';
      this.boardEl.classList.toggle('aligning', !!MH.ui.aligning);
      this.boardEl.classList.toggle('has-bg', !!st.bg);
      this.handleEl.hidden = !(MH.ui.aligning && st.bg);
    },

    /**
     * 拖动类操作的轻量刷新：只重算布局（画布/网格/底图位置与尺寸），
     * 不重绘格子内容、不重建侧栏 —— 底图缩放/网格偏移都不影响格子内容。
     */
    refreshLayout() {
      const st = MH.store.state;
      this.rebuildIfNeeded();
      this.syncBackground(st);
    },

    /** 底图元素的尺寸与透明度 */
    syncBackground(st) {
      const b = st.bg;
      const L = Core.boardLayout(st);
      if (!b) {
        this.bgEl.hidden = true;
        this.bgEl.style.backgroundImage = '';
        return;
      }
      const url = MH.bgUrl();
      this.bgEl.hidden = !(b.visible && url);
      if (url) this.bgEl.style.backgroundImage = 'url("' + String(url).replace(/["\\]/g, '') + '")';
      this.bgEl.style.width = L.bgW + 'px';
      this.bgEl.style.height = L.bgH + 'px';
      this.bgEl.style.opacity = String(b.opacity);
    },

    buildGrid(st) {
      this.overlay.setAttribute('viewBox', '0 0 ' + st.cols + ' ' + st.rows);
      let d = '';
      for (let c = 1; c < st.cols; c++) d += 'M' + c + ' 0V' + st.rows;
      for (let r = 1; r < st.rows; r++) d += 'M0 ' + r + 'H' + st.cols;
      this.els_grid = this.overlay.querySelector('.grid-lines');
      if (this.els_grid) this.els_grid.setAttribute('d', d);
      const outer = this.overlay.querySelector('.grid-outer');
      if (outer) {
        outer.setAttribute('x', 0);
        outer.setAttribute('y', 0);
        outer.setAttribute('width', st.cols);
        outer.setAttribute('height', st.rows);
      }
    },

    /** 每行/列一条提示条（数量只随行列数变，内容在 paintHeads 里填） */
    buildHeads(st) {
      if (!this.rowHeadsEl || !this.colHeadsEl) return;
      this.rowHeadsEl.innerHTML = '';
      this.colHeadsEl.innerHTML = '';
      this.rowHeadEls = [];
      this.colHeadEls = [];
      for (let r = 0; r < st.rows; r++) {
        const d = document.createElement('div');
        d.className = 'head row-head';
        d.dataset.r = String(r);
        d.title = '第 ' + (r + 1) + ' 行';
        this.rowHeadsEl.appendChild(d);
        this.rowHeadEls.push(d);
      }
      for (let c = 0; c < st.cols; c++) {
        const d = document.createElement('div');
        d.className = 'head col-head';
        d.dataset.c = String(c);
        d.title = '第 ' + (c + 1) + ' 列';
        this.colHeadsEl.appendChild(d);
        this.colHeadEls.push(d);
      }
      this.hotHead = null;
    },

    /** 把每行/每列的人物候选写进提示条（已确定的人用实心标出） */
    paintHeads(st) {
      if (!this.rowHeadEls || !this.rowHeadEls.length) return;
      const esc = MH.esc;
      const LP = Core.linePeople(st);
      const cap = Core.headCapacity(st);
      const fill = (el, info, axis, i) => {
        if (!el) return;
        const items = [];
        if (info.placed) {
          const p = Core.person(st, info.placed);
          if (p) items.push({ id: p.id, label: p.label, color: p.color, done: true });
        }
        for (const pid of info.cands) {
          const p = Core.person(st, pid);
          if (p) items.push({ id: p.id, label: p.label, color: p.color, done: false });
        }
        // 容量按格子大小估算：格子小了就少显示几个，免得溢出格子（多出来的折成 +N）
        const max = axis === 'r' ? cap.rowMax : cap.colMax;
        const shown = items.slice(0, max);
        const rest = items.length - shown.length;
        const lineName = axis === 'r' ? ' 行' : ' 列';
        el.innerHTML = shown.map(it => {
          if (it.done) {
            return '<span class="hi done" style="--pc:' + esc(it.color) + '" title="' + esc(it.label) + ' 已确定在这一' + lineName.trim() + '">' + esc(it.label) + '</span>';
          }
          return '<button type="button" class="hi" data-act="head-pick" data-axis="' + (axis === 'r' ? 'row' : 'col') + '" data-line="' + i + '" data-id="' + esc(it.id) + '" ' +
            'style="--pc:' + esc(it.color) + '" title="点一下：把这一' + lineName.trim() + '里其他人的候选清掉并标 ✕（' + esc(it.label) + ' 保留）">' + esc(it.label) + '</button>';
        }).join('') + (rest > 0 ? '<span class="hi more" title="还有 ' + rest + ' 个人，点开列表看不到，可放大格子">+' + rest + '</span>' : '');
        el.classList.toggle('none', items.length === 0);
        const all = items.map(it => it.label + (it.done ? '（已确定）' : '')).join(' ');
        el.title = '第 ' + (i + 1) + lineName + '：' + (all || '没有候选')
          + (items.some(it => !it.done) ? ' · 点某个人可把这一' + lineName.trim() + '里其他人的候选清掉并标 ✕' : '');
      };
      LP.rows.forEach((info, r) => fill(this.rowHeadEls[r], info, 'r', r));
      LP.cols.forEach((info, c) => fill(this.colHeadEls[c], info, 'c', c));
    },

    buildCells(st) {
      this.cellsEl.style.gridTemplateColumns = 'repeat(' + st.cols + ', var(--cell))';
      const frag = document.createDocumentFragment();
      this.cellEls.clear();
      for (let r = 0; r < st.rows; r++) {
        for (let c = 0; c < st.cols; c++) {
          const k = Core.key(r, c);
          const el = document.createElement('div');
          el.className = 'cell';
          el.dataset.k = k;
          this.cellEls.set(k, el);
          frag.appendChild(el);
        }
      }
      this.cellsEl.textContent = '';
      this.cellsEl.appendChild(frag);
    },

    buildOutlines(st) {
      this.regionLayer.textContent = '';
      this.outlineEls.clear();
      for (const reg of st.regions) {
        const path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('class', 'region-outline');
        path.setAttribute('d', Core.segmentsToPath(Core.regionOutlineSegments(reg.cells)));
        path.setAttribute('stroke', reg.color);
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        path.dataset.region = reg.id;
        // 注意：颜色只用属性设置（不要写 inline style），否则会盖过 .pos/.neg 的悬停变色
        this.regionLayer.appendChild(path);
        this.outlineEls.set(reg.id, path);
      }
      this.fixStrokes();
    },

    updateDraftOutline() {
      const d = MH.ui.draft;
      if (!this.draftPath) return;
      if (!d || d.kind !== 'region' || !d.cells || !d.cells.size) {
        this.draftPath.setAttribute('d', '');
        return;
      }
      this.draftPath.setAttribute('d', Core.segmentsToPath(Core.regionOutlineSegments([...d.cells])));
    },

    // ------------------------------------------------------------ 绘制

    paint() {
      const st = MH.store.state;
      const draft = MH.ui.draft;
      this.paintHeads(st);
      this.baseBg = new Map();
      this.prevHl = new Map();
      this.prevCand = new Set();

      for (const [k, el] of this.cellEls) {
        const item = Core.itemAt(st, k);
        const regIds = Core.regionsAt(st, k);
        const inDraft = !!(draft && draft.cells && draft.cells.has(k));

        // 有可见底图时，格子底加一层半透明白纱，否则会把底图整个盖住。
        // 注意：多层 background 简写里只有最后一层能带颜色，所以每层都用 linear-gradient 表达。
        const hasBg = !!(st.bg && st.bg.visible && MH.bgUrl());
        const veil = hasBg ? 'linear-gradient(rgba(255,255,255,.34),rgba(255,255,255,.34))' : null;
        let tint = null;
        if (inDraft) tint = draft.kind === 'region' ? DRAFT_REGION_BG : Core.rgba(draft.color || '#8b5cf6', 0.30);
        else if (regIds.length) tint = Core.rgba(Core.region(st, regIds[0]).color, 0.16);
        const bg = [
          tint ? 'linear-gradient(' + tint + ',' + tint + ')' : null,
          veil,
        ].filter(Boolean).join(',') || '#ffffff';

        this.baseBg.set(k, bg);
        el.style.background = bg;
        el.className = 'cell' +
          (regIds.length ? ' in-region' : '') +
          (item ? ' has-item' : '') +
          (inDraft ? ' draft-cell' : '');
        el.innerHTML = this.cellInner(st, k, item);
        el.title = this.cellTitle(st, k, item);
      }
    },

    /** 编号越长字号越小，免得撑破圆形标记 / 候选小标签 */
    labelClass(label) {
      const n = String(label || '').length;
      return n >= 4 ? ' small' : n === 3 ? ' mid' : '';
    },

    cellInner(st, k, item) {
      const esc = MH.esc;
      let h = '';
      if (item) {
        const ic = esc(item.color);
        h += '<span class="item-ring ' + (item.occupiable ? 'occ' : 'block') + '" style="--ic:' + ic + '"></span>';
        h += '<span class="item-badge" style="--ic:' + ic + '">' + esc(item.name.slice(0, 1)) + '</span>';
      }
      if (st.phase !== 'play') return h;

      const pid = Core.personAt(st, k);
      if (pid) {
        const p = Core.person(st, pid);
        // **地图上不显示性别标记** ✓（用户明确要求 ✓）
        // 性别只显示在左边「人物」面板里 ✓（列表角标 + 选中行徽章 ✓）——
        // 格子里的圆点保持"只有一个编号" ✓，最干净好认 ✓
        h += '<span class="person-chip' + this.labelClass(p.label) + '" data-person="' + esc(p.id) +
          '" style="--pc:' + esc(p.color) + '">' + esc(p.label) + '</span>';
        return h;
      }
      const xs = Core.xSource(st, k);
      if (xs) {
        h += '<span class="xmark ' + xs + '">✕</span>';
        return h;
      }
      const cands = Core.candidatesAt(st, k);
      if (cands.length) {
        const shown = cands.slice(0, CAND_SHOW_MAX).map(id => {
          const p = Core.person(st, id);
          // **候选格不带性别标记** ✓（用户明确要求："地图中选中后不显示性别标记" ✓）
          // 出生时只有字母 ✓，干净好认 ✓；性别标记只在「已确定」的圆点上 ✓
          return '<i class="' + this.labelClass(p.label).trim() + '" data-person="' + esc(p.id) +
            '" style="--pc:' + esc(p.color) + '">' + esc(p.label) + '</i>';
        }).join('');
        const more = cands.length > CAND_SHOW_MAX ? '<i class="more">+' + (cands.length - CAND_SHOW_MAX) + '</i>' : '';
        h += '<span class="cands">' + shown + more + '</span>';
      }
      return h;
    },

    cellTitle(st, k, item) {
      const { r, c } = Core.unkey(k);
      const parts = ['第 ' + (r + 1) + ' 行 第 ' + (c + 1) + ' 列'];
      const regs = Core.regionsAt(st, k).map(id => Core.region(st, id).name);
      if (regs.length) parts.push('区域：' + regs.join('、'));
      if (item) parts.push('物品：' + item.name + '（' + (item.occupiable ? '可占据' : '不可占据') + '）');
      if (st.phase === 'play') {
        const pid = Core.personAt(st, k);
        if (pid) parts.push('已确定：' + Core.person(st, pid).label);
        else {
          const xs = Core.xSource(st, k);
          if (xs === 'auto') parts.push('固定不可放人（物品不可占据）');
          else if (xs === 'place') parts.push('被同行/同列排除');
          else if (xs === 'user') parts.push('已标记 X');
          const cands = Core.candidatesAt(st, k).map(id => Core.person(st, id).label);
          if (cands.length) parts.push('候选：' + cands.join('、'));
        }
      }
      return parts.join('\n');
    },

    // ------------------------------------------------------------ 悬停高亮

    applyHover() {
      const st = MH.store.state;
      const next = new Map();     // key -> {cls, bg}
      const outNext = new Map();  // regionId -> 'hl'|'pos'|'neg'

      const rank = { region: 1, pos: 2, neg: 3 };
      const add = (k, cls, color) => {
        const cur = next.get(k);
        if (cur && rank[cur.cls] >= rank[cls]) return;
        const bg = cls === 'neg' ? HL_NEG : cls === 'pos' ? HL_POS : Core.rgba(color, 0.42);
        next.set(k, { cls, bg });
      };
      const markOutline = (id, cls) => {
        const cur = outNext.get(id);
        if (cur === 'neg') return;
        if (cur === 'pos' && cls !== 'neg') return;
        outNext.set(id, cls);
      };

      // 悬停人物时，他自己的候选格要单独顶出来（和关联填色叠加，互不冲突）
      const candSet = new Set();
      const hoverPid = MH.ui.hoverPersonId;
      if (hoverPid) {
        for (const k of (st.play.candidates[hoverPid] || [])) candSet.add(k);
        const p = Core.person(st, hoverPid);
        if (p) {
          for (const link of p.links) {
            const cls = link.polarity === -1 ? 'neg' : 'pos';
            if (link.kind === 'region') {
              const reg = Core.region(st, link.id);
              if (!reg) continue;
              for (const k of reg.cells) add(k, cls, reg.color);
              markOutline(reg.id, cls);
            } else {
              const it = Core.item(st, link.id);
              if (!it) continue;
              for (const k of it.cells) add(k, cls, it.color);
            }
          }
        }
      }

      const hoverRegId = MH.ui.hoverRegionId;
      if (hoverRegId) {
        const reg = Core.region(st, hoverRegId);
        if (reg) {
          for (const k of reg.cells) add(k, 'region', reg.color);
          markOutline(reg.id, 'hl');
        }
      }
      const hoverItemId = MH.ui.hoverItemId;
      if (hoverItemId) {
        const it = Core.item(st, hoverItemId);
        if (it) for (const k of it.cells) add(k, 'region', it.color);
      }
      // 鼠标在网格里移动：只把所在区域的外框描亮，不填充格子
      // （填色留给「悬停人物」和「悬停侧栏里的区域/物品」，免得整片变色盖住候选与 ✕）
      if (MH.ui.hoverCell) {
        for (const id of Core.regionsAt(st, MH.ui.hoverCell)) markOutline(id, 'hl');
      }

      // 候选描边用被悬停人物的颜色，一眼能对上是"谁的候选"
      const hoverPerson = hoverPid ? Core.person(st, hoverPid) : null;
      const candRing = hoverPerson ? hoverPerson.color : '#0b1220';
      // 鼠标在哪一格，就把那一行/列的提示条点亮 —— 「当前行列」一眼可辨
      const hk = MH.ui.hoverCell;
      const hot = hk ? { r: +String(hk).split(',')[0], c: +String(hk).split(',')[1] } : null;
      const was = this.hotHead;
      if (was && (!hot || was.r !== hot.r || was.c !== hot.c)) {
        const rr = this.rowHeadEls[was.r], cc = this.colHeadEls[was.c];
        if (rr) rr.classList.remove('hot');
        if (cc) cc.classList.remove('hot');
      }
      if (hot) {
        const rr = this.rowHeadEls[hot.r], cc = this.colHeadEls[hot.c];
        if (rr) rr.classList.add('hot');
        if (cc) cc.classList.add('hot');
      }
      this.hotHead = hot;

      const touched = new Set([...this.prevHl.keys(), ...next.keys(), ...candSet, ...this.prevCand]);
      for (const k of touched) {
        const el = this.cellEls.get(k);
        if (!el) continue;
        const v = next.get(k);
        const isCand = candSet.has(k);
        el.classList.remove('hl-region', 'hl-pos', 'hl-neg');
        el.classList.toggle('hl-cand', isCand);
        if (isCand) el.style.setProperty('--cand-ring', candRing);
        else el.style.removeProperty('--cand-ring');
        // 同一格里可能有多人的候选，只把被悬停那个人的小标签点亮
        for (const i of el.querySelectorAll('.cands i')) {
          i.classList.toggle('on', isCand && i.dataset.person === hoverPid);
        }
        if (v) {
          el.style.background = v.bg;
          el.classList.add('hl-' + v.cls);
        } else {
          el.style.background = this.baseBg.get(k) || '#ffffff';
        }
      }
      this.prevHl = next;
      this.prevCand = candSet;

      for (const [id, path] of this.outlineEls) {
        const cls = outNext.get(id);
        path.classList.toggle('hl', cls === 'hl');
        path.classList.toggle('pos', cls === 'pos');
        path.classList.toggle('neg', cls === 'neg');
      }
    },

    // ------------------------------------------------------------ 交互

    onPointerDown(e) {
      if (e.button !== 0) return;
      const cellEl = e.target.closest ? e.target.closest('.cell') : null;
      if (!cellEl) return;
      const k = cellEl.dataset.k;
      const st = MH.store.state;

      // 物品取样模式：这一下就是"选样例格"（优先于草稿刷格 / 标 X）
      if (MH.ui.itemPicking) {
        e.preventDefault();
        MH.ui.itemPicking = false;
        document.body.classList.remove('picking');
        MH.render();
        if (MH.panels && MH.panels.itemSample) MH.panels.itemSample(k);
        return;
      }

      // 对齐模式：拖动 = 移动网格（此时不做区域/物品的刷选）
      if (MH.ui.aligning && st.bg) {
        e.preventDefault();
        this.alignDrag = {
          startX: e.clientX, startY: e.clientY,
          baseX: st.grid ? st.grid.x : 0, baseY: st.grid ? st.grid.y : 0,
        };
        return;
      }

      if (st.phase === 'prep') {
        if (!MH.ui.draft) return;
        // **Ctrl/Cmd + 点格子 = 按样例添加** ✓（用户要求 ✓）
        // 新建物品时最常见的动作就是"点一个格子当样例，让程序把同类找出来" ✓ ——
        // 以前要先点「按样例添加」按钮再点格子（两步 ✓）；现在按住 Ctrl 一步到位 ✓。
        // 只对**物品**草稿生效 ✓（区域没有"同类"的概念 ✓）。
        if (MH.ui.draft.kind === 'item' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          if (MH.panels && MH.panels.itemSample) MH.panels.itemSample(k);
          return;
        }
        e.preventDefault();
        this.painting = true;
        this.paintMode = MH.ui.draft.cells.has(k) ? 'remove' : 'add';
        this._paintKey = k;
        this.applyPaint(k);
        return;
      }

      e.preventDefault();
      this.gesture = {
        k,
        x: e.clientX,
        y: e.clientY,
        mode: st.settings.leftMode === 'x' ? 'x' : 'candidate',
        pid: st.selectedPersonId,
        painting: false,
        on: true,
        refused: 0,
        moved: 0,
      };
      // 「左键＝标 X」模式下不长按放人
      if (this.gesture.mode === 'candidate') this.startPress(k, e);
    },

    onPointerMove(e) {
      const target = e.target;
      const cellEl = target && target.closest ? target.closest('.cell') : null;
      const chip = target && target.closest ? target.closest('[data-person]') : null;
      const k = cellEl ? cellEl.dataset.k : null;
      const pid = chip ? chip.dataset.person : null;

      if (k !== this._hoverKey || pid !== this._hoverPid) {
        this._hoverKey = k;
        this._hoverPid = pid;
        MH.ui.hoverCell = k;
        MH.ui.hoverPersonId = pid;
        this.applyHover();
      }

      // 对齐模式：拖动移动网格
      if (this.alignDrag) {
        const st0 = MH.store.state;
        // 静默改：这里每移动一像素就触发一次，走 preview 会把侧栏（含滑块）整个重建
        MH.store.previewSilent(s => Core.setGridOffset(
          s,
          this.alignDrag.baseX + (e.clientX - this.alignDrag.startX),
          this.alignDrag.baseY + (e.clientY - this.alignDrag.startY)
        ));
        this.applyLayout(st0);
        return;
      }

      // 准备阶段：拖拽刷格
      if (this.painting && k && k !== this._paintKey) {
        this._paintKey = k;
        this.applyPaint(k);
      }

      // 游玩阶段：拖动超过阈值 → 转成连续刷选（单击 / 长按的语义不变）
      const g = this.gesture;
      if (g && !g.painting) {
        const dx = Math.abs(e.clientX - g.x);
        const dy = Math.abs(e.clientY - g.y);
        g.moved = Math.max(g.moved, dx, dy);
        if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) this.startPaint();
      }
      if (g && g.painting && k && k !== this._paintKey) {
        this._paintKey = k;
        this.paintCell(k);
      }

      if (this.press && !this.press.done) {
        const dx = Math.abs(e.clientX - this.press.x);
        const dy = Math.abs(e.clientY - this.press.y);
        if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) this.cancelPress();
      }
    },

    /** 拖动开始：方向以起点格当前状态为准（有→擦除，没有→添加） */
    startPaint() {
      const g = this.gesture;
      if (!g || g.painting) return;
      this.cancelPress();
      g.painting = true;
      g.label = g.mode === 'x' ? '拖动标 X' : '拖动标注候选';
      MH.store.beginGesture(g.label);
      const st = MH.store.state;
      if (g.mode === 'x') {
        g.on = !Core.xSource(st, g.k);
      } else {
        g.on = (st.play.candidates[g.pid] || []).indexOf(g.k) < 0;
      }
      this._paintKey = g.k;
      this.paintCell(g.k);
    },

    paintCell(k) {
      const g = this.gesture;
      if (!g || !g.painting) return;
      const res = MH.store.live(s => (g.mode === 'x'
        ? Core.setX(s, k, g.on)
        : Core.setCandidate(s, g.pid, k, g.on)));
      if (res && res.ok === false) g.refused++;
    },

    onPointerUp() {
      if (this.alignDrag) {
        this.alignDrag = null;
        MH.store.setSettings({});   // 拖动结束，落盘一次
        MH.render();
        return;
      }
      if (this.painting) { this.painting = false; this._paintKey = null; }
      const p = this.press;
      this.press = null;
      if (p && p.raf) cancelAnimationFrame(p.raf);
      this.hideRing();

      const g = this.gesture;
      this.gesture = null;
      if (g && g.painting) {
        this._paintKey = null;
        MH.store.endGesture();
        if (g.refused) MH.toast('有 ' + g.refused + ' 个格子不能' + (g.mode === 'x' ? '标 X' : '标注'), 'warn');
        return;
      }
      if (p && p.done) return;   // 长按已完成，别再当点击
      // 「左键＝标 X」模式下没有长按，p 为空，同样要处理单击
      if (g) this.handleClick(g.k);
    },

    onContextMenu(e) {
      const cellEl = e.target.closest ? e.target.closest('.cell') : null;
      if (!cellEl) return;
      e.preventDefault();
      const st = MH.store.state;
      if (st.phase !== 'play') return;
      const res = MH.store.commit('标 X', s => Core.toggleX(s, cellEl.dataset.k));
      MH.toast(res.message, res.ok ? 'ok' : 'warn');
    },

    /** 右下角手柄拖动 = 等比缩放网格（保持左上角不动） */
    onHandleDown(e) {
      if (e.button !== 0) return;
      const st = MH.store.state;
      if (!st.bg || !MH.ui.aligning) return;
      e.preventDefault();
      e.stopPropagation();
      const L = Core.boardLayout(st);
      this.handleDrag = {
        startX: e.clientX, startY: e.clientY,
        cell: st.settings.cellSize,
        gridW: L.gridW, gridH: L.gridH,
      };
      window.addEventListener('pointermove', this._onHandleMove = ev => {
        const d = this.handleDrag;
        if (!d) return;
        const w = Math.max(20, d.gridW + (ev.clientX - d.startX));
        const h = Math.max(20, d.gridH + (ev.clientY - d.startY));
        // 两个方向取平均，拖起来比较跟手
        const cell = Math.round((w / MH.store.state.cols + h / MH.store.state.rows) / 2);
        const st2 = MH.store.state;
        // 对齐模式下抓手只缩放网格（底图有「绑定缩放」也不跟），否则对位调不动
        MH.store.previewSilent(s => { Core.setCellSize(s, cell, { gridOnly: true }); });
        this.rebuildIfNeeded();     // --cell 变了，格子尺寸靠它刷新
        this.syncBackground(st2);
      });
      window.addEventListener('pointerup', this._onHandleUp = () => {
        window.removeEventListener('pointermove', this._onHandleMove);
        window.removeEventListener('pointerup', this._onHandleUp);
        this.handleDrag = null;
        MH.store.setSettings({});
        MH.render();
        if (MH.panels) MH.panels.render(MH.store.state);
      });
    },

    /** 对齐模式下用方向键微调（Shift 加速 10px） */
    nudge(dx, dy) {
      const st = MH.store.state;
      if (!st.bg || !MH.ui.aligning) return false;
      MH.store.setSettings({});
      MH.store.commit('微调网格位置', s => Core.nudgeGrid(s, dx, dy));
      return true;
    },

    /** 左键点按 */
    handleClick(k) {
      const st = MH.store.state;
      if (st.phase !== 'play') return;
      if (st.settings.leftMode === 'x') {
        const res = MH.store.commit('标 X', s => Core.toggleX(s, k));
        MH.toast(res.message, res.ok ? 'ok' : 'warn');
        return;
      }
      const pid = st.selectedPersonId;
      if (!pid) { MH.toast('请先在左侧选择一个人物', 'warn'); return; }
      const res = MH.store.commit('候选标注', s => Core.toggleCandidate(s, pid, k));
      if (!res.ok) MH.toast(res.message, 'warn');
    },

    // ------------------------------------------------------------ 长按

    startPress(k, e) {
      this.cancelPress();
      const press = { k, start: performance.now(), x: e.clientX, y: e.clientY, done: false, raf: 0 };
      this.press = press;
      this.showRing(k);
      const tick = now => {
        if (this.press !== press || press.done) return;
        const t = Math.min(1, (now - press.start) / longPressMs());
        this.setRing(t);
        if (t >= 1) {
          press.done = true;
          this.hideRing();
          this.finishPlace(k);
          return;
        }
        press.raf = requestAnimationFrame(tick);
      };
      press.raf = requestAnimationFrame(tick);
    },

    cancelPress() {
      const p = this.press;
      if (!p) return;
      if (p.raf) cancelAnimationFrame(p.raf);
      this.press = null;
      this.hideRing();
    },

    showRing(k) {
      const st = MH.store.state;
      const px = st.settings.cellSize;
      const { r, c } = Core.unkey(k);
      if (!this.ringEl) {
        const el = document.createElement('div');
        el.className = 'ring';
        el.innerHTML = '<svg viewBox="0 0 40 40">' +
          '<circle class="ring-bg" cx="20" cy="20" r="16"></circle>' +
          '<circle class="ring-fg" cx="20" cy="20" r="16"></circle></svg>';
        this.ringLayer.appendChild(el);
        this.ringEl = el;
        const fg = el.querySelector('.ring-fg');
        this.ringLen = 2 * Math.PI * 16;
        fg.style.strokeDasharray = String(this.ringLen);
      }
      this.ringEl.style.left = (c * px) + 'px';
      this.ringEl.style.top = (r * px) + 'px';
      this.ringEl.style.width = px + 'px';
      this.ringEl.style.height = px + 'px';
      this.ringEl.style.display = 'block';
      this.setRing(0);
    },

    setRing(t) {
      if (!this.ringEl) return;
      const fg = this.ringEl.querySelector('.ring-fg');
      if (fg) fg.style.strokeDashoffset = String(this.ringLen * (1 - t));
    },

    hideRing() {
      if (this.ringEl) this.ringEl.style.display = 'none';
    },

    finishPlace(k) {
      const st = MH.store.state;
      const p = Core.person(st, st.selectedPersonId);
      if (!p) { MH.toast('请先在左侧选择一个人物', 'warn'); return; }
      const res = MH.store.commit('确定 ' + p.label + ' 的位置', s => Core.placePerson(s, p.id, k));
      MH.toast(res.message, res.ok ? 'ok' : 'warn');
    },

    // ------------------------------------------------------------ 准备阶段草稿

    applyPaint(k) {
      const d = MH.ui.draft;
      if (!d) return;
      if (this.paintMode === 'remove') d.cells.delete(k);
      else d.cells.add(k);
      this.paint();
      this.updateDraftOutline(MH.store.state);   // 草稿外轮廓要跟着刷选实时更新
      this.applyHover();
      MH.panels.refreshDraftMeta();
    },

    flashCell(k) {
      const el = this.cellEls.get(k);
      if (!el) return;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
      const viewport = MH.els.viewport;
      if (viewport && el.offsetParent) {
        const cell = MH.store.state.settings.cellSize;
        const { r, c } = Core.unkey(k);
        viewport.scrollTo({
          left: Math.max(0, c * cell - viewport.clientWidth / 2),
          top: Math.max(0, r * cell - viewport.clientHeight / 2),
          behavior: 'smooth',
        });
      }
    },
  };

  MH.board = B;
})();

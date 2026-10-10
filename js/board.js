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

  const LONG_PRESS_MS = 700;
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
        this.gridSig = gridSig;
        this.outlineSig = null;
      }
      const osig = st.regions.map(r => r.id + '|' + r.color + '|' + r.cells.join(',')).join('#');
      if (osig !== this.outlineSig) {
        this.buildOutlines(st);
        this.outlineSig = osig;
      }
      this.boardEl.style.setProperty('--cell', st.settings.cellSize + 'px');
      this.updateDraftOutline(st);
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
      this.baseBg = new Map();
      this.prevHl = new Map();

      for (const [k, el] of this.cellEls) {
        const item = Core.itemAt(st, k);
        const regIds = Core.regionsAt(st, k);
        const inDraft = !!(draft && draft.cells && draft.cells.has(k));

        let bg = '#ffffff';
        if (inDraft) bg = draft.kind === 'region' ? DRAFT_REGION_BG : Core.rgba(draft.color || '#8b5cf6', 0.30);
        else if (regIds.length) bg = Core.rgba(Core.region(st, regIds[0]).color, 0.16);

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

      const hoverPid = MH.ui.hoverPersonId;
      if (hoverPid) {
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

      const touched = new Set([...this.prevHl.keys(), ...next.keys()]);
      for (const k of touched) {
        const el = this.cellEls.get(k);
        if (!el) continue;
        const v = next.get(k);
        el.classList.remove('hl-region', 'hl-pos', 'hl-neg');
        if (v) {
          el.style.background = v.bg;
          el.classList.add('hl-' + v.cls);
        } else {
          el.style.background = this.baseBg.get(k) || '#ffffff';
        }
      }
      this.prevHl = next;

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

      if (st.phase === 'prep') {
        if (!MH.ui.draft) return;
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
        const t = Math.min(1, (now - press.start) / LONG_PRESS_MS);
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

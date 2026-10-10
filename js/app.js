/*! Mudorku Helper — app.js
 * 命名空间 MH：编排渲染、提示条、全局动作分发、启动。
 */
(function () {
  'use strict';
  const Core = window.MurdokuCore;
  const StoreNS = window.MurdokuStore;

  const MH = window.MH = {
    core: Core,
    store: null,
    renderers: [],
    els: {},
    ui: {
      draft: null,          // {kind:'region'|'item', editingId, cells:Set, name, occupiable, color}
      hoverCell: null,
      hoverPersonId: null,
      hoverRegionId: null,
      hoverItemId: null,
      aligning: false,      // 对齐底图模式：拖动=移动网格
      bgBusy: false,        // 正在解析图片 / 渲染 PDF
    },

    /** 当前底图的 dataURL（来自 store，不进主存档） */
    bgUrl() {
      return MH.store && MH.store.bgData ? MH.store.bgData : null;
    },

    registerRenderer(fn) { MH.renderers.push(fn); },

    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
      ));
    },

    /** 全量重绘（棋盘结构 + 侧栏 + 悬停高亮） */
    render() {
      const st = MH.store.state;
      document.body.dataset.phase = st.phase;
      if (MH.board) { MH.board.rebuildIfNeeded(); MH.board.paint(); }
      for (const fn of MH.renderers) fn(st);
      if (MH.board) MH.board.applyHover();
    },

    /** 只刷新棋盘（拖拽刷格时用，避免侧栏输入框失焦） */
    repaintBoard() {
      if (MH.board) { MH.board.paint(); MH.board.applyHover(); }
    },

    toast(msg, kind) {
      if (!msg) return;
      const box = MH.els.toast;
      if (!box) return;
      const el = document.createElement('div');
      el.className = 'toast-item ' + (kind || '');
      el.textContent = msg;
      box.appendChild(el);
      setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 300);
      }, 2400);
    },

    openModal(id) {
      const m = document.getElementById(id);
      if (m) m.classList.add('open');
    },
    closeModal(id) {
      const m = id ? document.getElementById(id) : null;
      if (m) m.classList.remove('open');
      else document.querySelectorAll('.modal.open').forEach(x => x.classList.remove('open'));
    },

    /** 设置/取消草稿（新建或编辑区域、物品） */
    setDraft(draft) {
      MH.ui.draft = draft;
      if (MH.board) MH.board.updateDraftOutline(MH.store.state);
      MH.render();
    },

    boot() {
      const ids = ['board', 'cells', 'overlay', 'regionLayer', 'draftOutline', 'ringLayer', 'gridBox', 'bgLayer', 'alignHandle', 'viewport', 'sidebar', 'toast', 'fileInput', 'bgFileInput'];
      for (const id of ids) MH.els[id] = document.getElementById(id);

      MH.store = new StoreNS.Store('murdoku-helper.v1', undefined);
      MH.board.init();
      MH.panels.init();
      MH.store.subscribe(() => MH.render());
      MH.render();

      // 帮助弹窗：点遮罩关闭
      document.querySelectorAll('.modal').forEach(m => {
        m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
      });
    },
  };

  window.addEventListener('beforeunload', () => {
    if (MH.store) MH.store._persist();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', MH.boot);
  else MH.boot();
})();

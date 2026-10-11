/*! Mudorku Helper — store.js
 * 状态容器：提交（含撤销/重做历史）、持久化、导入导出。
 * 所有改动都通过 store.commit(label, mutator) 进行，mutator 返回 {ok:false} 时自动回滚。
 */
(function (root, factory) {
  const api = factory(root && root.MurdokuCore ? root.MurdokuCore : (typeof require === 'function' ? require('./core.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MurdokuStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  const HISTORY_LIMIT = 200;

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  class Store {
    constructor(storageKey, storage) {
      this.key = storageKey || 'murdoku-helper.v1';
      this.storage = storage !== undefined ? storage : safeStorage();
      this.listeners = [];
      this.undoStack = [];
      this.redoStack = [];
      this.state = this._load() || Core.createState(8, 8);
      this.bgData = this._loadBg();   // 底图 dataURL 单独存，不进主存档
    }

    /** 底图数据（dataURL）：体积大，单独一个 key，避免每次点击都重写几 MB */
    _loadBg() {
      if (!this.storage || !this.state.bg) return null;
      try { return this.storage.getItem(this.key + '.bg') || null; } catch (e) { return null; }
    }

    setBgData(dataUrl) {
      this.bgData = dataUrl || null;
      if (!this.storage) return { ok: !!dataUrl };
      try {
        if (this.bgData) this.storage.setItem(this.key + '.bg', this.bgData);
        else this.storage.removeItem(this.key + '.bg');
        return { ok: true };
      } catch (e) {
        // 配额不够：本次会话仍可用，但刷新后会丢
        console.warn('底图保存失败（可能超出 localStorage 配额）', e);
        return { ok: false, message: '底图太大，本次会话可用但刷新后会丢失；建议先压缩图片' };
      }
    }

    /** 手势/拖拽中的实时预览：改状态并立刻重绘，但不写历史也不落盘 */
    preview(mutator) {
      const res = mutator(this.state);
      this.notify({ type: 'preview' });
      return res;
    }

    /**
     * 只改状态，**不通知**。
     *
     * 给拖动类热路径用：preview 会触发整块重渲染，而侧栏里的滑块/输入框
     * 就在重渲染范围里 —— 拖到第二下节点就被换掉，拖动直接失效。
     * 用这个改完自己刷新画布，松手时再 touch() 落盘 + 全量重绘一次。
     */
    previewSilent(mutator) {
      return mutator(this.state);
    }

    // ---------------------------------------------------------- 订阅

    subscribe(fn) {
      this.listeners.push(fn);
      return () => { this.listeners = this.listeners.filter(f => f !== fn); };
    }

    notify(evt) {
      for (const fn of this.listeners.slice()) {
        try { fn(this.state, evt || {}); } catch (e) { console.error(e); }
      }
    }

    // ---------------------------------------------------------- 提交

    /**
     * @param {string} label 人类可读的操作名（显示在撤销按钮上）
     * @param {(state)=>any} mutator 直接修改 state
     * @returns mutator 的返回值（ok:false 时不写历史、不持久化）
     */
    commit(label, mutator) {
      const before = clone(this.state);
      let res;
      try {
        res = mutator(this.state);
      } catch (err) {
        this._restore(before);
        this.notify({ type: 'error', label });
        throw err;
      }
      if (res && res.ok === false) {
        this._restore(before); // 回滚（mutator 可能已改了一部分）
        return res;
      }
      this.undoStack.push({ label, snap: before });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      this._persist();
      this.notify({ type: 'commit', label });
      return res;
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    undoLabel() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : ''; }
    redoLabel() { return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : ''; }

    /** 原地恢复快照内容：保持 this.state 对象身份不变，外部缓存引用不会失效 */
    _restore(snap) {
      const cur = this.state;
      if (!cur || typeof cur !== 'object' || cur === snap) { this.state = snap; return; }
      for (const k of Object.keys(cur)) delete cur[k];
      Object.assign(cur, snap);
    }

    undo() {
      const entry = this.undoStack.pop();
      if (!entry) return { ok: false, message: '没有可撤销的操作' };
      this.redoStack.push({ label: entry.label, snap: clone(this.state) });
      const settings = this.state.settings;
      this._restore(entry.snap);
      this.state.settings = settings;   // 设置不进历史，撤销内容不该改缩放/工具模式
      this._persist();
      this.notify({ type: 'undo', label: entry.label });
      return { ok: true, message: '已撤销：' + entry.label };
    }

    redo() {
      const entry = this.redoStack.pop();
      if (!entry) return { ok: false, message: '没有可重做的操作' };
      this.undoStack.push({ label: entry.label, snap: clone(this.state) });
      const settings = this.state.settings;
      this._restore(entry.snap);
      this.state.settings = settings;   // 同上
      this._persist();
      this.notify({ type: 'redo', label: entry.label });
      return { ok: true, message: '已重做：' + entry.label };
    }

    /** 不进入历史的轻量设置修改（缩放、左键模式、实时校验开关等） */
    setSettings(patch) {
      Object.assign(this.state.settings, patch);
      this._persist();
      this.notify({ type: 'settings' });
    }

    /** 不进入历史的界面状态修改（如当前选中人物） */
    touch(label) {
      this._persist();
      this.notify({ type: 'touch', label: label || '' });
    }

    /** 手势期间直接改状态：立刻重绘但不写历史（配合 beginGesture / endGesture 合成一条） */
    live(mutator) {
      const res = mutator(this.state);
      this._persist();
      this.notify({ type: 'live' });
      return res;
    }

    /** 开始一段连续操作（拖动刷选）：先留一份快照 */
    beginGesture(label) {
      this._gesture = { label: label || '拖动标注', snap: clone(this.state) };
    }

    /** 结束手势：整段改动合并成一条撤销记录；没有实际变化就不记 */
    endGesture() {
      const g = this._gesture;
      this._gesture = null;
      if (!g) return { ok: false, message: '', changed: false };
      if (Core.serialize(g.snap) === Core.serialize(this.state)) return { ok: false, message: '', changed: false };
      this.undoStack.push({ label: g.label, snap: g.snap });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      this._persist();
      this.notify({ type: 'commit', label: g.label });
      return { ok: true, label: g.label, changed: true };
    }

    /** 整表替换（导入 / 重新生成地图） */
    replace(state, label, opts) {
      const snapshot = clone(this.state);
      this._restore(state);
      if (!opts || !opts.keepHistory) {
        this.undoStack.push({ label: label || '替换数据', snap: snapshot });
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
        this.redoStack.length = 0;
      }
      if (!this.state.bg) this.setBgData(null);
      this._persist();
      this.notify({ type: 'replace', label: label || '替换数据' });
    }

    // ---------------------------------------------------------- 持久化

    _persist() {
      if (!this.storage) return;
      try {
        this.storage.setItem(this.key, Core.serialize(this.state));
      } catch (e) {
        console.warn('保存失败（可能是隐私模式或超出配额）', e);
      }
    }

    _load() {
      if (!this.storage) return null;
      try {
        const text = this.storage.getItem(this.key);
        if (!text) return null;
        return Core.deserialize(text);
      } catch (e) {
        console.warn('本地存档解析失败，已忽略', e);
        return null;
      }
    }

    exportText() { return Core.serialize(this.state, this.bgData); }

    importText(text) {
      const raw = typeof text === 'string' ? JSON.parse(text) : text;
      const state = Core.deserialize(raw);
      this.setBgData(raw && raw.bgData ? String(raw.bgData) : null);
      this.replace(state, '导入数据');
      return state;
    }

    clearSaved() {
      if (this.storage) { try { this.storage.removeItem(this.key); } catch (e) { /* ignore */ } }
    }
  }

  function safeStorage() {
    try {
      if (typeof localStorage === 'undefined') return null;
      localStorage.setItem('__mh_probe__', '1');
      localStorage.removeItem('__mh_probe__');
      return localStorage;
    } catch (e) {
      return null;
    }
  }

  return { Store, clone, HISTORY_LIMIT };
});

/*! Mudorku Helper — snipper.js
 *
 * 右侧「PDF 摘录」悬浮窗。
 *
 * 用途：Murdoku 的 PDF 里除了地图页，往往还有一页写着人物/物品的具体信息。
 * 这个面板让你把那一块单独截出来钉在右边，游玩时一边看题一边对照，不用来回翻页。
 *
 * 与底图完全独立：**自己的文件、自己的页码**，可以是另一个 PDF，也可以和地图
 * 不在同一页。截下来的卡片存在 localStorage 单独的 key 里（不塞进主存档，
 * 免得每次点格子都要重写几 MB）。
 *
 * 加载时只建 DOM、不碰 canvas —— jsdom 下 getContext 会抛，而界面测试断言
 * 运行期无报错，所以所有绘制都在真正要截取时才发生。
 */
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  const doc = root.document;

  const PINS_KEY = 'murdoku-helper.v1.snipPins';   // 截下来的卡片
  const UI_KEY = 'murdoku-helper.v1.snipUi';       // 折叠状态 / 上次页码
  const MAX_SIDE = 1600;                           // 截取位图最长边上限（控制存档体积）
  const MIN_SIDE = 8;                              // 太小的框视为误拖，不生成卡片

  const CHEV = '<svg class="snipper-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>';
  const CHEV_DOWN = '<svg class="snipper-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 9 12 15.5 18.5 9"/></svg>';
  const GRIP = '<svg class="snipper-grip" viewBox="0 0 12 20" aria-hidden="true">' +
    '<circle cx="4" cy="5" r="1.3"/><circle cx="8" cy="5" r="1.3"/>' +
    '<circle cx="4" cy="10" r="1.3"/><circle cx="8" cy="10" r="1.3"/>' +
    '<circle cx="4" cy="15" r="1.3"/><circle cx="8" cy="15" r="1.3"/></svg>';

  const S = {
    collapsed: false,
    stageFolded: false,   // PDF 缩略图折叠起来，把空间让给卡片
    scroll: {},           // id -> {x,y}，重绘后恢复卡片内的平移
    img: null,        // 当前页的位图（HTMLImageElement）
    file: null,       // 当前 PDF/图片文件，翻页复用
    page: 1,
    pages: 1,
    busy: false,
    pins: [],         // {id, page, w, h, url}
    drag: null,
  };
  let el = null;
  let seq = 0;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function read(key, fb) {
    try { const t = root.localStorage.getItem(key); return t ? JSON.parse(t) : fb; } catch (e) { return fb; }
  }
  function write(key, v) {
    try { root.localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 配额/隐私模式：不影响本次会话 */ }
  }
  function toast(msg, kind) {
    if (root.MH && typeof root.MH.toast === 'function') root.MH.toast(msg, kind);
  }

  // ---------------------------------------------------------------- DOM

  function build() {
    const wrap = doc.createElement('div');
    wrap.className = 'snipper';
    wrap.id = 'snipper';
    wrap.innerHTML =
      '<button class="snipper-tab" type="button" data-snip="toggle" title="展开 / 收起 PDF 摘录">' + CHEV +
        '<span class="snipper-badge" data-snip="badge"></span></button>' +
      '<div class="snipper-panel">' +
        '<div class="snipper-head">' +
          '<b>PDF 摘录</b>' +
          '<span class="muted" data-snip="status"></span>' +
          '<span class="grow"></span>' +
          '<button class="ghost sm icon" type="button" data-snip="fold-stage" title="折叠 / 展开 PDF 缩略图">' + CHEV_DOWN + '</button>' +
          '<button class="ghost sm" type="button" data-snip="import">导入 PDF</button>' +
          '<button class="ghost sm icon" type="button" data-snip="toggle" title="收起面板">' + CHEV + '</button>' +
        '</div>' +
        '<div class="snipper-stage" data-snip="stage">' +
          '<div class="snipper-empty">导入一份 PDF（可以和地图不是同一页），<br>然后在页面上<b>拖一个矩形</b>把它截下来。</div>' +
        '</div>' +
        '<div class="snipper-foot">' +
          '<button class="ghost sm" type="button" data-snip="prev" title="上一页">◀</button>' +
          '<span class="muted" data-snip="page">—</span>' +
          '<button class="ghost sm" type="button" data-snip="next" title="下一页">▶</button>' +
          '<span class="grow"></span>' +
          '<button class="ghost sm danger" type="button" data-snip="clear">清空卡片</button>' +
        '</div>' +
        '<div class="snipper-pins" data-snip="pins"></div>' +
      '</div>' +
      '<input type="file" accept="application/pdf,.pdf,image/*" hidden data-snip="file">';
    doc.body.appendChild(wrap);
    return wrap;
  }

  const q = sel => el.querySelector('[data-snip="' + sel + '"]');

  // ---------------------------------------------------------------- 渲染

  function render() {
    if (!el) return;
    el.classList.toggle('collapsed', S.collapsed);
    el.classList.toggle('stage-folded', !!S.stageFolded);
    q('status').textContent = S.img ? '' : '独立于底图';
    q('page').textContent = S.pages > 1 ? (S.page + ' / ' + S.pages) : (S.img ? '1 页' : '—');
    q('prev').disabled = S.busy || S.page <= 1;
    q('next').disabled = S.busy || S.page >= S.pages;
    const badge = q('badge');
    badge.textContent = S.pins.length ? String(S.pins.length) : '';
    badge.hidden = !S.pins.length;
    renderStage();
    renderPins();
  }

  function renderStage() {
    const stage = q('stage');
    if (!S.img) {
      stage.classList.remove('has-img');
      if (!stage.querySelector('.snipper-empty')) {
        stage.innerHTML = '<div class="snipper-empty">导入一份 PDF（可以和地图不是同一页），<br>然后在页面上<b>拖一个矩形</b>把它截下来。</div>';
      }
      return;
    }
    stage.classList.add('has-img');
    let img = stage.querySelector('img.snipper-img');
    if (!img) {
      stage.innerHTML = '<img class="snipper-img" alt="PDF 页面"><div class="snipper-sel" hidden></div>';
      img = stage.querySelector('img.snipper-img');
    }
    if (img.src !== S.img.src) img.src = S.img.src;
  }

  function renderPins() {
    const box = q('pins');
    if (!S.pins.length) { box.innerHTML = ''; return; }
    box.innerHTML = S.pins.map(p => {
      const z = pinZoom(p);
      return '<figure class="snipper-pin" data-id="' + esc(p.id) + '">' +
        '<figcaption class="snipper-cap" title="按住这里拖动可以调整卡片顺序">' + GRIP +
        '<span class="muted">第 ' + p.page + ' 页</span>' +
        '<span class="muted snip-size">' + p.w + '×' + p.h + '</span>' +
        '<span class="grow"></span>' +
        '<button class="ghost sm icon" type="button" data-snip="pin-zoom" data-id="' + esc(p.id) + '" data-dir="-1" title="缩小">−</button>' +
        '<button class="ghost sm snip-pct" type="button" data-snip="pin-reset" data-id="' + esc(p.id) + '" title="点击还原到 100%">' + Math.round(z * 100) + '%</button>' +
        '<button class="ghost sm icon" type="button" data-snip="pin-zoom" data-id="' + esc(p.id) + '" data-dir="1" title="放大">+</button>' +
        '<button class="ghost sm icon" type="button" data-snip="pin-del" data-id="' + esc(p.id) + '" title="删除这张">✕</button>' +
        '</figcaption>' +
        '<div class="snipper-pin-body" data-snip="pin-body" data-id="' + esc(p.id) + '" title="放大后可以按住拖动查看">' +
        '<img src="' + esc(p.url) + '" alt="摘录" style="width:' + (z * 100) + '%">' +
        '</div>' +
        '</figure>';
    }).join('');
    // 重绘会丢滚动位置，按内存里的记录恢复
    for (const f of box.querySelectorAll('.snipper-pin')) {
      const sc = S.scroll[f.dataset.id];
      const body = f.querySelector('.snipper-pin-body');
      if (sc && body) { body.scrollLeft = sc.x; body.scrollTop = sc.y; }
    }
  }

  /** 卡片缩放系数（老存档没有这个字段就按 1 处理） */
  function pinZoom(p) {
    const z = Number(p && p.zoom);
    return Number.isFinite(z) && z > 0 ? Math.min(4, Math.max(0.5, z)) : 1;
  }

  /** 缩放某张卡片；dir=0 表示还原 */
  function zoomPin(id, dir) {
    const p = S.pins.find(x => x.id === id);
    if (!p) return;
    if (dir === 0) p.zoom = 1;
    else p.zoom = Math.min(4, Math.max(0.5, Math.round(pinZoom(p) * (dir > 0 ? 1.25 : 0.8) * 100) / 100));
    S.scroll[id] = { x: 0, y: 0 };
    savePins();
    render();
  }

  // ---------------------------------------------------------------- 持久化

  function savePins() {
    write(PINS_KEY, S.pins);
    if (S.pins.length === 0) {
      try { root.localStorage.removeItem(PINS_KEY); } catch (e) { /* ignore */ }
    }
  }
  function saveUi() { write(UI_KEY, { collapsed: S.collapsed, stageFolded: S.stageFolded, page: S.page }); }

  // ---------------------------------------------------------------- 载入

  async function loadFile(file) {
    if (!file) return;
    S.busy = true;
    render();
    try {
      const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
      S.file = file;
      if (isPdf) {
        if (!root.MH || typeof root.MH.renderPdfPage !== 'function') throw new Error('PDF 支持未就绪');
        toast('正在渲染 PDF…', 'ok');
        const res = await root.MH.renderPdfPage(file, 1);
        S.pages = res.pages || 1;
        S.page = 1;
        await setImage(res.dataUrl);
      } else {
        const url = URL.createObjectURL(file);
        S.pages = 1; S.page = 1;
        await setImage(url);
        URL.revokeObjectURL(url);
      }
      toast('已载入，在页面上拖一个矩形即可截取', 'ok');
    } catch (e) {
      S.img = null; S.file = null;
      toast('载入失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      S.busy = false;
      saveUi();
      render();
    }
  }

  function setImage(src) {
    return new Promise((resolve, reject) => {
      const img = new root.Image();
      img.onload = () => { S.img = img; resolve(img); };
      img.onerror = () => reject(new Error('图片解析失败'));
      img.src = src;
    });
  }

  async function gotoPage(next) {
    if (!S.file || S.pages <= 1 || S.busy) return;
    const p = Math.min(Math.max(1, next), S.pages);
    if (p === S.page) return;
    S.busy = true; render();
    try {
      const res = await root.MH.renderPdfPage(S.file, p);
      S.page = res.page || p;
      await setImage(res.dataUrl);
      saveUi();
    } catch (e) {
      toast('翻页失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      S.busy = false; render();
    }
  }

  // ---------------------------------------------------------------- 框选截取

  /** 舞台显示尺寸与源图像素的比例（显示坐标 → 源坐标要除以它） */
  function displayScale() {
    const img = el && q('stage').querySelector('img.snipper-img');
    if (!img || !img.naturalWidth) return 1;
    return img.getBoundingClientRect().width / img.naturalWidth || 1;
  }

  function stagePoint(e) {
    const stage = q('stage');
    const img = stage.querySelector('img.snipper-img');
    if (!img) return null;
    const box = img.getBoundingClientRect();
    return {
      x: Math.min(Math.max(0, e.clientX - box.left), box.width),
      y: Math.min(Math.max(0, e.clientY - box.top), box.height),
    };
  }

  function beginSelect(e) {
    if (!S.img || S.busy || e.button !== 0) return;
    const p = stagePoint(e);
    if (!p) return;
    e.preventDefault();
    S.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    paintSel();
    root.addEventListener('pointermove', onSelectMove);
    root.addEventListener('pointerup', endSelect);
  }

  function onSelectMove(e) {
    if (!S.drag) return;
    const p = stagePoint(e);
    if (!p) return;
    S.drag.x1 = p.x; S.drag.y1 = p.y;
    paintSel();
  }

  function paintSel() {
    const stage = q('stage');
    const box = stage.querySelector('.snipper-sel');
    if (!box) return;
    const d = S.drag;
    if (!d) { box.hidden = true; return; }
    // 框选坐标是相对图片左上角的；选中框绝对定位在 stage 里，要补上图片自身的偏移
    const img = stage.querySelector('img.snipper-img');
    const ox = img ? img.offsetLeft : 0;
    const oy = img ? img.offsetTop : 0;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    box.hidden = false;
    box.style.left = (ox + x) + 'px';
    box.style.top = (oy + y) + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  }

  function endSelect() {
    root.removeEventListener('pointermove', onSelectMove);
    root.removeEventListener('pointerup', endSelect);
    const d = S.drag;
    S.drag = null;
    paintSel();
    if (!d) return;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < MIN_SIDE || h < MIN_SIDE) return;      // 误点，不生成卡片
    pinRegion(x, y, w, h);
  }

  /** 把舞台上的矩形映射回源图像素并裁成一张卡片 */
  function pinRegion(x, y, w, h) {
    const img = S.img;
    if (!img) return;
    const k = displayScale();
    if (!k) { toast('页面还没渲染好', 'warn'); return; }
    let sx = Math.round(x / k), sy = Math.round(y / k);
    let sw = Math.round(w / k), sh = Math.round(h / k);
    sx = Math.max(0, Math.min(sx, img.naturalWidth - 1));
    sy = Math.max(0, Math.min(sy, img.naturalHeight - 1));
    sw = Math.max(1, Math.min(sw, img.naturalWidth - sx));
    sh = Math.max(1, Math.min(sh, img.naturalHeight - sy));

    const cv = doc.createElement('canvas');
    const ctx = cv.getContext('2d');
    if (!ctx) { toast('这个环境不支持画布，无法截取', 'error'); return; }
    // 超出上限就等比缩小，别让一张卡片撑爆 localStorage
    const shrink = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const ow = Math.max(1, Math.round(sw * shrink));
    const oh = Math.max(1, Math.round(sh * shrink));
    cv.width = ow; cv.height = oh;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, ow, oh);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, ow, oh);

    let url = cv.toDataURL('image/png');
    if (url.length > 400_000) url = cv.toDataURL('image/jpeg', 0.9);

    S.pins.push({ id: 'snip' + (++seq) + '-' + Date.now().toString(36), page: S.page, w: ow, h: oh, url });
    savePins();
    render();
    if (S.collapsed) { S.collapsed = false; saveUi(); render(); }
    toast('已截取一张（' + ow + '×' + oh + '）', 'ok');
  }

  function removePin(id) {
    S.pins = S.pins.filter(p => p.id !== id);
    savePins();
    render();
  }

  // ---------------------------------------------------------------- 事件

  function onClick(e) {
    const t = e.target.closest && e.target.closest('[data-snip]');
    if (!t || !el.contains(t)) return;
    const act = t.getAttribute('data-snip');
    if (act === 'toggle') { S.collapsed = !S.collapsed; saveUi(); render(); }
    else if (act === 'fold-stage') { S.stageFolded = !S.stageFolded; saveUi(); render(); }
    else if (act === 'import') { const f = q('file'); if (f) f.click(); }
    else if (act === 'pin-zoom') { zoomPin(t.getAttribute('data-id'), Number(t.getAttribute('data-dir'))); }
    else if (act === 'pin-reset') { zoomPin(t.getAttribute('data-id'), 0); }
    else if (act === 'prev') gotoPage(S.page - 1);
    else if (act === 'next') gotoPage(S.page + 1);
    else if (act === 'clear') {
      if (!S.pins.length) { toast('还没有卡片', 'warn'); return; }
      if (!root.confirm('清空所有摘录卡片？')) return;
      S.pins = []; savePins(); render();
      toast('已清空', 'ok');
    } else if (act === 'pin-del') {
      e.stopPropagation();
      removePin(t.getAttribute('data-id'));
    }
  }

  // ---------------------------------------------------------------- 卡片：平移 / 排序

  const DRAG_SLOP = 3;   // 超过这个位移才算拖动，避免误触发

  /** 卡片视口内按住拖动 = 平移（放大后看细节） */
  function beginPan(e, body) {
    if (e.button !== 0) return;
    e.preventDefault();
    const id = body.getAttribute('data-id');
    const start = { x: e.clientX, y: e.clientY, sl: body.scrollLeft, st: body.scrollTop };
    body.classList.add('panning');
    const move = ev => {
      body.scrollLeft = start.sl - (ev.clientX - start.x);
      body.scrollTop = start.st - (ev.clientY - start.y);
      S.scroll[id] = { x: body.scrollLeft, y: body.scrollTop };
    };
    const up = () => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      body.classList.remove('panning');
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
  }

  /** 按住卡片标题栏拖动 = 调整顺序（实时把节点搬到插入位置） */
  function beginReorder(e, cap) {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;          // 点按钮不算拖动
    e.preventDefault();
    const fig = cap.closest('.snipper-pin');
    const box = q('pins');
    const y0 = e.clientY;
    let active = false;
    const move = ev => {
      if (!active) {
        if (Math.abs(ev.clientY - y0) < DRAG_SLOP) return;
        active = true;
        fig.classList.add('dragging');
      }
      let ref = null;
      for (const other of box.children) {
        if (other === fig) continue;
        const r = other.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { ref = other; break; }
      }
      box.insertBefore(fig, ref);                    // ref 为 null 时插到末尾
    };
    const up = () => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      fig.classList.remove('dragging');
      if (!active) return;
      // 以 DOM 顺序为准重建数组
      const order = [...box.querySelectorAll('.snipper-pin')].map(n => n.getAttribute('data-id'));
      S.pins.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      savePins();
      render();
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
  }

  function onFileChange(e) {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
    e.target.value = '';
  }

  /** 从 localStorage 重新读取折叠状态与卡片，并重绘（挂载时也会走一遍） */
  function refresh() {
    const ui = read(UI_KEY, {}) || {};
    S.collapsed = !!ui.collapsed;
    S.stageFolded = !!ui.stageFolded;
    S.pins = read(PINS_KEY, []) || [];
    render();
  }

  function mount() {
    if (el) return el;
    el = build();
    el.addEventListener('click', onClick);
    q('file').addEventListener('change', onFileChange);
    q('stage').addEventListener('pointerdown', beginSelect);
    // 卡片是动态渲染的，用委托绑定
    el.addEventListener('pointerdown', e => {
      const body = e.target.closest && e.target.closest('.snipper-pin-body');
      if (body) { beginPan(e, body); return; }
      const cap = e.target.closest && e.target.closest('.snipper-cap');
      if (cap) beginReorder(e, cap);
    });
    q('stage').addEventListener('dragstart', e => e.preventDefault());
    refresh();
    return el;
  }

  root.MurdokuSnipper = { mount, refresh, render, state: S };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount);
  else mount();
})(typeof window !== 'undefined' ? window : null);

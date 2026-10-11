/*! Mudorku Helper — panels.js
 * 侧栏（准备阶段 / 游玩阶段）、顶栏同步、全局动作分发。
 */
(function () {
  'use strict';
  const Core = window.MurdokuCore;
  const MH = window.MH;
  const esc = s => MH.esc(s);

  // ---------------------------------------------------------------- 通用小组件

  function kindName(kind) { return kind === 'region' ? '区域' : '物品'; }

  function runCommit(label, fn) {
    const res = MH.store.commit(label, fn);
    if (res && res.message) MH.toast(res.message, res.ok === false ? 'warn' : 'ok');
    return res;
  }

  /** 已建立的关联：一个按钮切换正/负相关 + 一个 × 取消关联 */
  function linkRow(st, p, kind, t) {
    const pol = Core.getLink(st, p.id, kind, t.id);
    const neg = pol < 0;
    const hover = kind === 'region' ? 'data-hover-region="' + esc(t.id) + '"' : 'data-hover-item="' + esc(t.id) + '"';
    return '<div class="link-row" ' + hover + '>' +
      '<span class="dot" style="--c:' + esc(t.color) + '"></span>' +
      '<span class="nm" title="' + esc(t.name) + '">' + esc(t.name) + '</span>' +
      '<button class="tag ' + (neg ? 'neg' : 'pos') + '" data-act="link" data-kind="' + kind + '" data-id="' + esc(t.id) +
      '" data-pol="' + (neg ? 1 : -1) + '" title="点击切换正相关 / 负相关">' + (neg ? '− 负相关' : '+ 正相关') + '</button>' +
      '<button class="ghost sm" data-act="link" data-kind="' + kind + '" data-id="' + esc(t.id) + '" data-pol="0" title="取消关联">×</button>' +
      '</div>';
  }

  function personDetail(st, p) {
    const rows = [];
    for (const link of p.links) {
      const t = link.kind === 'region' ? Core.region(st, link.id) : Core.item(st, link.id);
      if (t) rows.push(linkRow(st, p, link.kind, t));
    }
    // 下拉框只列出还没关联过的目标
    const linked = new Set(p.links.map(l => l.kind + ':' + l.id));
    const groups = [];
    const collect = (kind, list, title) => {
      const opts = list.filter(t => !linked.has(kind + ':' + t.id))
        .map(t => '<option value="' + kind + ':' + esc(t.id) + '">' + esc(t.name) + '</option>');
      if (opts.length) groups.push('<optgroup label="' + title + '">' + opts.join('') + '</optgroup>');
    };
    collect('region', st.regions, '区域');
    collect('item', st.items, '物品');

    return '<div class="person-detail">' +
      '<div class="row center"><span class="chip sm" style="--pc:' + esc(p.color) + '">' + esc(p.label) + '</span><b>的相关性</b>' +
      '<span class="grow"></span>' +
      '<button class="ghost sm" data-act="rename-person" data-id="' + esc(p.id) + '" title="修改这个人的编号（1–4 个字符，不含 X）">改名</button></div>' +
      (rows.length
        ? '<div class="link-group"><div class="link-title">已关联 ' + rows.length + ' 项</div>' + rows.join('') + '</div>'
        : '<p class="hint">还没有关联。用下面的下拉框选一个区域或物品。</p>') +
      (groups.length
        ? '<label class="field">添加关联 <select id="linkPicker"><option value="">选择区域或物品…</option>' + groups.join('') + '</select></label>'
        : '<p class="hint">' + (st.regions.length + st.items.length ? '所有区域和物品都已关联。' : '还没有区域或物品，先在下面新建。') + '</p>') +
      '<p class="hint">关联只是<b>相关性提示</b>（不是必须满足的规则）：悬停该人物时高亮这些区域/物品，' +
      '<span class="tag pos">+ 正相关</span> 绿色 · <span class="tag neg">− 负相关</span> 红色。新添加的默认正相关，点标签可切换。</p>' +
      '</div>';
  }

  function draftHTML(st, d) {
    const cells = [...d.cells];
    const connected = d.kind !== 'region' || Core.isConnected(cells);
    const canSave = cells.length > 0 && connected;
    const showLargest = d.kind === 'region' && !connected && cells.length > 0;
    return '<div class="draft">' +
      '<div class="draft-head"><b>' + (d.editingId ? '编辑' : '新建') + kindName(d.kind) + '</b>' +
      '<button class="ghost sm" data-act="draft-cancel">取消</button></div>' +
      '<label class="field">名称 <input id="draftName" type="text" value="' + esc(d.name) + '" placeholder="' + (d.kind === 'region' ? '例如 红区' : '例如 苹果') + '"></label>' +
      (d.kind === 'item'
        ? '<div class="field radios">' +
          '<label><input type="radio" name="draftOcc" value="1" ' + (d.occupiable ? 'checked' : '') + '> 可占据（能放人）</label>' +
          '<label><input type="radio" name="draftOcc" value="0" ' + (!d.occupiable ? 'checked' : '') + '> 不可占据（不能放人）</label>' +
          '</div>'
        : '') +
      '<p class="hint" id="draftMeta">' + draftMetaText(d) + '</p>' +
      '<div class="row wrap">' +
      '<button class="ghost sm" data-act="draft-clear">清空选择</button>' +
      (d.kind === 'region'
        ? '<button class="ghost sm" data-act="draft-largest" style="display:' + (showLargest ? '' : 'none') + '">只保留最大连通块</button>'
        : '') +
      '<button class="primary sm" data-act="draft-save" ' + (canSave ? '' : 'disabled') + '>保存</button>' +
      '</div>' +
      '<p class="hint">在棋盘上单击切换格子，按住拖动可连续刷选。</p>' +
      '</div>';
  }

  function draftOverlap(d) {
    const cells = [...d.cells];
    if (!cells.length) return 0;
    const st = MH.store.state;
    const list = d.kind === 'region' ? st.regions : st.items;
    let n = 0;
    for (const t of list) {
      if (d.editingId && t.id === d.editingId) continue;
      for (const k of cells) if (t.cells.indexOf(k) >= 0) n++;
    }
    return n;
  }

  function draftMetaText(d) {
    const cells = [...d.cells];
    const connected = d.kind !== 'region' || Core.isConnected(cells);
    const overlap = draftOverlap(d);
    return '已选 <b>' + cells.length + '</b> 格 · ' +
      (d.kind === 'region'
        ? (cells.length ? (connected ? '<span class="good">四连通 ✓</span>' : '<span class="bad">不连通 ✗（区域必须四连通）</span>') : '<span class="muted">请选择格子</span>')
        : '<span class="muted">物品格不必连通</span>') +
      (overlap ? ' · <span class="bad">其中 ' + overlap + ' 格已在其它' + kindName(d.kind) + '里，保存后归属会移过来</span>' : '');
  }

  function bgCard(st) {
    const b = st.bg;
    const pct = v => (Math.round(v * 1000) / 10).toFixed(1) + '%';
    if (!b) {
      return '<section class="card">' +
        '<h2>底图 <span class="muted">图片 / PDF 衬在网格下方</span></h2>' +
        '<button class="ghost block" data-act="bg-import" ' + (MH.ui.bgBusy ? 'disabled' : '') + '>' +
        (MH.ui.bgBusy ? '正在解析…' : '＋ 导入图片或 PDF') + '</button>' +
        '<p class="hint">导入后会出现一个衬在网格下方的底图；打开「对齐底图」就能拖动网格、拖右下角手柄缩放，把它对准底图上的地图。</p>' +
        '</section>';
    }
    return '<section class="card">' +
      '<h2>底图 <span class="muted">' + esc(b.kind === 'pdf' ? 'PDF' : '图片') + '</span></h2>' +
      '<div class="row wrap">' +
      '<button class="ghost sm" data-act="bg-import" ' + (MH.ui.bgBusy ? 'disabled' : '') + '>更换</button>' +
      '<button class="ghost sm" data-act="bg-toggle">' + (b.visible ? '隐藏' : '显示') + '</button>' +
      '<button class="ghost sm" data-act="bg-fit">适应窗口</button>' +
      '<button class="ghost sm" data-act="bg-crop" title="按网格外框裁掉四周多余部分；裁完图片与网格绑定，缩放一起变">✂ 裁切到网格</button>' +
      '<button class="ghost sm danger" data-act="bg-remove">移除</button>' +
      '</div>' +
      '<p class="hint ellipsis" title="' + esc(b.name) + '">' + esc(b.name) +
      ' · ' + b.w + '×' + b.h + (b.kind === 'pdf' ? '（第 ' + b.page + '/' + b.pages + ' 页）' : '') + '</p>' +
      (b.kind === 'pdf' && b.pages > 1
        ? '<div class="row"><button class="ghost sm" data-act="bg-page" data-dir="-1">◀ 上一页</button>' +
          '<span class="meta">第 ' + b.page + ' / ' + b.pages + ' 页</span>' +
          '<button class="ghost sm" data-act="bg-page" data-dir="1">下一页 ▶</button></div>'
        : '') +
      '<label class="field">底图透明度 <input type="range" id="bgOpacity" min="10" max="100" step="5" value="' + Math.round(b.opacity * 100) + '"></label>' +
      // 步长 0.1%：底图对齐需要能落在精确的比例上（5% 一步对地图来说太粗了，
      // 一张 1000px 宽的图一步就是 50px 的误差，怎么都对不上）
      '<label class="field">底图缩放 <input type="range" id="bgScale" min="10" max="400" step="0.1" value="' + (Math.round(b.scale * 1000) / 10) + '">' +
      '<span class="meta" data-bg="scale">' + pct(b.scale) + '</span></label>' +
      '<div class="row wrap">' +
      '<button class="ghost sm" data-act="bg-scale-step" data-dir="-1" title="缩小 0.1%（按住 Shift 1%）">−</button>' +
      '<button class="ghost sm" data-act="bg-scale-step" data-dir="1" title="放大 0.1%（按住 Shift 1%）">+</button>' +
      '<span class="grow"></span>' +
      '<button class="ghost sm" data-act="bg-scale-reset" title="回到 100%">还原 100%</button>' +
      '</div>' +
      '<label class="check"><input type="checkbox" data-act="bg-align" ' + (MH.ui.aligning ? 'checked' : '') + '> <b>对齐底图</b>（拖动移动网格 · 拖右下角手柄缩放 · 方向键微调）</label>' +
      (MH.ui.aligning
        ? '<div class="row wrap"><span class="meta">网格偏移 ' + (st.grid ? st.grid.x : 0) + ', ' + (st.grid ? st.grid.y : 0) + ' px</span>' +
          '<span class="grow"></span><button class="ghost sm" data-act="bg-reset">网格归位</button></div>'
        : '<p class="hint">格子大小也可以调（顶栏 🔍 或下面的缩放），网格会以左上角为锚点变化。</p>') +
      '</section>';
  }

  function entityList(kind, st) {
    const list = kind === 'region' ? st.regions : st.items;
    if (!list.length) return '<li class="empty">还没有' + kindName(kind) + '</li>';
    return list.map(t => {
      const hover = kind === 'region' ? 'data-hover-region="' + esc(t.id) + '"' : 'data-hover-item="' + esc(t.id) + '"';
      return '<li ' + hover + '>' +
        '<button class="swatch" data-act="color-' + kind + '" data-id="' + esc(t.id) + '" style="--c:' + esc(t.color) + '" title="点击换颜色"></button>' +
        '<span class="nm">' + esc(t.name) + '</span>' +
        '<span class="meta">' + t.cells.length + ' 格</span>' +
        (kind === 'item'
          ? '<button class="occ ' + (t.occupiable ? '' : 'blocked') + '" data-act="toggle-occ" data-id="' + esc(t.id) + '" title="切换是否可占据">' + (t.occupiable ? '可占据' : '不可占据') + '</button>'
          : '') +
        '<button class="ghost sm" data-act="edit-' + kind + '" data-id="' + esc(t.id) + '">编辑</button>' +
        '<button class="ghost sm" data-act="rename-' + kind + '" data-id="' + esc(t.id) + '">改名</button>' +
        '<button class="ghost sm danger" data-act="del-' + kind + '" data-id="' + esc(t.id) + '">删除</button>' +
        '</li>';
    }).join('');
  }

  // ---------------------------------------------------------------- 准备阶段

  function prepHTML(st) {
    const sel = Core.person(st, st.selectedPersonId) || st.people[0] || null;
    const d = MH.ui.draft;
    const n = Core.peopleCount(st.rows, st.cols);
    return '' +
      bgCard(st) +

      '<section class="card">' +
      '<h2>地图</h2>' +
      '<div class="grid2">' +
      '<label class="field">行 <input id="rowsInput" type="number" min="1" max="40" value="' + st.rows + '"></label>' +
      '<label class="field">列 <input id="colsInput" type="number" min="1" max="40" value="' + st.cols + '"></label>' +
      '</div>' +
      '<div class="row wrap presets">' +
      [4, 5, 6, 7, 8, 9].map(v => '<button class="ghost sm" data-act="preset" data-v="' + v + '">' + v + '×' + v + '</button>').join('') +
      '</div>' +
      '<button class="primary block" data-act="gen">生成地图</button>' +
      '<p class="hint">人物数 = min(行, 列) = <b>' + n + '</b>，标签 A–Z 且跳过 X' +
      (st.people.length ? '：' + st.people.map(p => p.label).join(' ') : '') + '</p>' +
      '</section>' +

      '<section class="card">' +
      '<h2>人物 <span class="muted">点击选择后可设置关联</span></h2>' +
      '<div class="chips">' +
      st.people.map(p => '<button class="chip' + (sel && p.id === sel.id ? ' active' : '') + '" data-act="select-person" data-id="' + esc(p.id) + '" style="--pc:' + esc(p.color) + '">' + esc(p.label) + '</button>').join('') +
      '</div>' +
      (sel ? personDetail(st, sel) : '') +
      '</section>' +

      '<section class="card">' +
      '<h2>区域 <span class="muted">四连通 · 外轮廓加粗</span></h2>' +
      '<button class="ghost block" data-act="new-region" ' + (d ? 'disabled' : '') + '>＋ 新建区域</button>' +
      (d && d.kind === 'region' ? draftHTML(st, d) : '') +
      '<ul class="list">' + entityList('region', st) + '</ul>' +
      '</section>' +

      '<section class="card">' +
      '<h2>物品 <span class="muted">可占据 / 不可占据</span></h2>' +
      '<button class="ghost block" data-act="new-item" ' + (d ? 'disabled' : '') + '>＋ 新建物品</button>' +
      (d && d.kind === 'item' ? draftHTML(st, d) : '') +
      '<ul class="list">' + entityList('item', st) + '</ul>' +
      '</section>' +

      '<section class="card">' +
      '<h2>存档</h2>' +
      '<div class="row wrap">' +
      '<button class="ghost" data-act="export">导出 JSON</button>' +
      '<button class="ghost" data-act="import">导入 JSON</button>' +
      '<button class="ghost" data-act="help">操作说明</button>' +
      '</div>' +
      '<p class="hint">改动会自动保存在浏览器本地，可随时导出备份。</p>' +
      '</section>';
  }

  // ---------------------------------------------------------------- 游玩阶段

  function playPersonLinks(st, p) {
    const rows = [];
    for (const link of p.links) {
      const t = link.kind === 'region' ? Core.region(st, link.id) : Core.item(st, link.id);
      if (!t) continue;
      const hover = link.kind === 'region' ? 'data-hover-region="' + esc(t.id) + '"' : 'data-hover-item="' + esc(t.id) + '"';
      rows.push('<div class="link-row" ' + hover + '>' +
        '<span class="dot" style="--c:' + esc(t.color) + '"></span>' +
        '<span class="nm">' + esc(t.name) + '</span>' +
        '<span class="tag ' + (link.polarity < 0 ? 'neg' : 'pos') + '">' + (link.polarity < 0 ? '− 负相关' : '+ 正相关') + '</span>' +
        '</div>');
    }
    if (!rows.length) return '<p class="hint">该人物没有关联（可在准备阶段设置）。</p>';
    return '<div class="link-group"><div class="link-title">' + esc(p.label) + ' 的相关性 · 悬停查看高亮</div>' + rows.join('') + '</div>';
  }

  function issueCard(issues) {
    const errors = issues.filter(i => i.level === 'error').length;
    return '<section class="card">' +
      '<h2>检查 <span class="muted">' + (issues.length ? errors + ' 个冲突 / ' + (issues.length - errors) + ' 个提示' : '没有发现问题') + '</span></h2>' +
      '<ul class="issues">' +
      (issues.length
        ? issues.map(i => '<li class="issue ' + i.level + '"' + (i.key ? ' data-act="focus-issue" data-key="' + i.key + '" title="点击定位"' : '') + '>' + esc(i.text) + '</li>').join('')
        : '<li class="issue ok">目前的标记与关联都能对上 ✓</li>') +
      '</ul></section>';
  }

  /** 人物状态文案：已确定在哪 / 有几个候选 / 未标注 */
  function stateOf(st, p) {
    const at = st.play.placed[p.id];
    if (at) return '确定 ' + Core.posText(at);
    const cnt = Core.personCandidateCount(st, p.id);
    return cnt ? cnt + ' 个候选' : '未标注';
  }

  function playHTML(st) {
    const sel = Core.person(st, st.selectedPersonId) || st.people[0] || null;
    const placedCount = st.people.filter(p => st.play.placed[p.id]).length;
    const issues = st.settings.liveValidate ? Core.validate(st) : [];
    return '' +
      '<section class="card">' +
      '<h2>人物 <span class="muted">' + placedCount + '/' + st.people.length + ' 已确定</span></h2>' +
      // 人多时一行一个太长了（24 人 ≈ 700px 以上），改成紧凑网格：
      // 每格一个字母，角标显示候选数（✓ = 已确定），详情只给当前选中的人。
      '<ul class="plist">' +
      st.people.map(p => {
        const at = st.play.placed[p.id];
        const cnt = Core.personCandidateCount(st, p.id);
        // 人物只有编号（label），没有单独的姓名字段
        const title = (p.label || '') + ' · ' + stateOf(st, p);
        return '<li class="' + (sel && p.id === sel.id ? 'active ' : '') + (at ? 'placed' : '') + '"' +
          ' data-act="select-person" data-id="' + esc(p.id) + '" data-hover-person="' + esc(p.id) + '"' +
          ' style="--pc:' + esc(p.color) + '" title="' + esc(title) + '">' +
          '<span class="pl">' + esc(p.label) + '</span>' +
          (at ? '<span class="pb ok" title="已确定">✓</span>'
              : (cnt ? '<span class="pb" title="' + cnt + ' 个候选">' + cnt + '</span>' : '')) +
          '</li>';
      }).join('') +
      '</ul>' +
      // 只给当前人物显示详情与操作，避免每人两个按钮把列表撑成两倍高
      '<div class="pnow">' +
      (sel
        ? '<span class="chip sm" style="--pc:' + esc(sel.color) + '">' + esc(sel.label) + '</span>' +
          '<span class="muted">' + esc(stateOf(st, sel)) + '</span>' +
          '<span class="grow"></span>' +
          (st.play.placed[sel.id] ? '<button class="ghost sm" data-act="unplace-person" data-id="' + esc(sel.id) + '">取消确定</button>' : '') +
          '<button class="ghost sm" data-act="clear-person" data-id="' + esc(sel.id) + '">清除标记</button>'
        : '<span class="muted">还没有人物</span>') +
      '</div>' +
      (sel ? playPersonLinks(st, sel) : '') +
      '</section>' +

      '<section class="card">' +
      '<h2>工具</h2>' +
      '<div class="seg wide">' +
      '<button data-act="left-mode" data-mode="candidate" class="' + (st.settings.leftMode === 'candidate' ? 'active' : '') + '">左键＝候选</button>' +
      '<button data-act="left-mode" data-mode="x" class="' + (st.settings.leftMode === 'x' ? 'active' : '') + '">左键＝标 X</button>' +
      '</div>' +
      '<p class="hint">左键点按＝候选（可多处）· <b>按住拖动＝连续标注一片</b> · 右键＝切换 X<br>长按 0.7 秒＝确定该人物并在同行列标 X（仅「左键＝候选」模式；标 X 模式不长按放人）</p>' +
      '<label class="check"><input type="checkbox" data-act="toggle-live" ' + (st.settings.liveValidate ? 'checked' : '') + '> 实时检查冲突</label>' +
      '<label class="check"><input type="checkbox" data-act="toggle-heads" ' + (st.settings.showHeads !== false ? 'checked' : '') + '> 行列候选提示（网格外侧显示每行/列有哪些人）</label>' +
      '</section>' +

      '<section class="card">' +
      '<h2>操作</h2>' +
      '<div class="row wrap">' +
      '<button class="ghost" data-act="undo">撤销</button>' +
      '<button class="ghost" data-act="redo">重做</button>' +
      '<button class="ghost" data-act="clear-marks">清空全部标记</button>' +
      '<button class="ghost" data-act="phase" data-phase="prep">← 回到准备阶段</button>' +
      '</div></section>' +

      (st.bg
        ? '<section class="card"><h2>底图 <span class="muted">' + esc(st.bg.kind === 'pdf' ? 'PDF' : '图片') + '</span></h2>' +
          '<label class="check"><input type="checkbox" data-act="bg-toggle" ' + (st.bg.visible ? 'checked' : '') + '> 显示底图</label>' +
          '<p class="hint">对齐与透明度在「地图准备」阶段调整。</p></section>'
        : '') +

      (st.settings.liveValidate ? issueCard(issues) : '') +

      '<section class="card legend">' +
      '<h2>图例</h2>' +
      '<ul>' +
      '<li><span class="person-chip demo" style="--pc:#2563eb">A</span> 已确定的人物</li>' +
      '<li><span class="cands demo"><i style="--pc:#2563eb">A</i></span> 候选（可标注多处）</li>' +
      '<li><span class="xmark user">✕</span> 手动标记的 X</li>' +
      '<li><span class="xmark place">✕</span> 同行 / 同列被排除</li>' +
      '<li><span class="xmark auto">✕</span> 不可占据物品格（固定不能放人）</li>' +
      '<li><span class="swatch" style="--c:#0ea5e9"></span> 区域外轮廓（加粗）</li>' +
      '<li><span class="dot" style="--c:#8b5cf6"></span> 物品（边框实线＝可占据，虚线＝不可占据）</li>' +
      '</ul></section>';
  }

  // ---------------------------------------------------------------- 动作

  function setPhase(phase) {
    const st = MH.store.state;
    if (st.phase === phase) return;
    MH.ui.draft = null;
    MH.store.commit(phase === 'play' ? '进入游玩阶段' : '回到准备阶段', s => { s.phase = phase; return { ok: true }; });
    if (phase === 'play') {
      let auto = 0;
      for (let r = 0; r < st.rows; r++) for (let c = 0; c < st.cols; c++) if (Core.isAutoX(st, Core.key(r, c))) auto++;
      MH.toast('进入游玩阶段' + (auto ? '：' + auto + ' 个不可占据物品格已固定为 X' : ''), 'ok');
    }
  }

  function selectPerson(id) {
    const st = MH.store.state;
    if (st.selectedPersonId === id) return;
    st.selectedPersonId = id;
    // 「选人」的意图就是接下来要标这个人的候选。若左键还停在「标 X」，
    // 自动切回候选模式 —— 否则用户以为已经切到候选了，结果继续在盘上打 X。
    if (st.phase === 'play' && st.settings.leftMode === 'x') {
      MH.store.setSettings({ leftMode: 'candidate' });
      MH.toast('已切回「左键＝候选」', 'ok');
      return;
    }
    MH.store.touch('选择人物');
  }

  function startDraft(kind, editingId) {
    const st = MH.store.state;
    if (editingId) {
      const src = kind === 'region' ? Core.region(st, editingId) : Core.item(st, editingId);
      if (!src) return;
      MH.setDraft({
        kind, editingId, cells: new Set(src.cells), name: src.name,
        occupiable: src.occupiable !== false, color: src.color,
      });
    } else {
      const n = kind === 'region' ? st.regions.length : st.items.length;
      const pal = kind === 'region' ? Core.REGION_COLORS : Core.ITEM_COLORS;
      MH.setDraft({
        kind, editingId: null, cells: new Set(),
        name: kindName(kind) + ' ' + (n + 1), occupiable: true,
        color: pal[n % pal.length],
      });
    }
    MH.toast('在棋盘上点选格子，选好后点「保存」', 'ok');
  }

  function saveDraft() {
    const d = MH.ui.draft;
    if (!d) return;
    const cells = [...d.cells];
    if (!cells.length) { MH.toast('还没有选择任何格子', 'warn'); return; }
    if (d.kind === 'region' && !Core.isConnected(cells)) { MH.toast('区域必须是四连通的格子', 'warn'); return; }
    const name = String(d.name || '').trim() || ('未命名' + kindName(d.kind));
    const res = MH.store.commit((d.editingId ? '修改' : '新建') + kindName(d.kind), s => {
      let target;
      if (d.editingId) {
        target = d.kind === 'region' ? Core.region(s, d.editingId) : Core.item(s, d.editingId);
        if (!target) return { ok: false, message: '目标已不存在' };
      }
      // 一个格子只归属一个区域 / 一个物品：从同类里摘掉
      if (d.kind === 'region') {
        if (!target) target = Core.createRegion(s, name, cells);
        target.name = name;
        target.cells = Core.dedupeCells(s, cells);
        Core.claimCellsExclusively(s, s.regions, target.id, target.cells);
      } else {
        if (!target) target = Core.createItem(s, name, cells, d.occupiable !== false);
        target.name = name;
        target.cells = Core.dedupeCells(s, cells);
        target.occupiable = d.occupiable !== false;
        Core.claimCellsExclusively(s, s.items, target.id, target.cells);
      }
      return { ok: true };
    });
    if (res.ok === false) { MH.toast(res.message, 'warn'); return; }
    MH.ui.draft = null;
    MH.render();
    MH.toast('已保存「' + name + '」', 'ok');
  }

  const BG_KEY = 'murdoku-helper.v1';   // 与 store 主 key 对应，底图数据单独存

  /** 把任意图片源画到 canvas 并压到合理体积，返回 {dataUrl, w, h} */
  function encodeBitmap(src, maxSide) {
    const sw = src.width, sh = src.height;
    const k = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k));
    const h = Math.max(1, Math.round(sh * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    let url = cv.toDataURL('image/png');
    if (url.length > 1_200_000) url = cv.toDataURL('image/jpeg', 0.85);   // 太大就转 JPEG
    if (url.length > 2_200_000) url = cv.toDataURL('image/jpeg', 0.7);
    return { dataUrl: url, w, h, srcW: sw, srcH: sh };
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解析失败')); };
      img.src = url;
    });
  }

  /** PDF：按需加载本地 pdf.js（经典脚本 + blob worker，file:// 下也能跑） */
  let pdfLibReady = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('加载失败：' + src));
      document.head.appendChild(el);
    });
  }
  function ensurePdfLib() {
    if (pdfLibReady) return pdfLibReady;
    pdfLibReady = (async () => {
      if (!window.pdfjsLib) await loadScript('vendor/pdfjs/pdf.min.js');
      if (!window.__PDFJS_WORKER_SRC__) await loadScript('vendor/pdfjs/pdf.worker.inline.js');
      if (!window.pdfjsLib) throw new Error('pdf.js 未加载');
      const url = URL.createObjectURL(new Blob([window.__PDFJS_WORKER_SRC__], { type: 'text/javascript' }));
      window.pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(url);
      return window.pdfjsLib;
    })();
    return pdfLibReady;
  }

  async function renderPdfPage(file, pageNo) {
    const lib = await ensurePdfLib();
    if (!file.__pdfBytes) file.__pdfBytes = new Uint8Array(await file.arrayBuffer());
    if (!file.__pdfDoc) file.__pdfDoc = await lib.getDocument({ data: file.__pdfBytes, isEvalSupported: false }).promise;
    const doc = file.__pdfDoc;
    const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
    // 目标：最长边约 1600px
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(0.3, 1600 / Math.max(base.width, base.height)));
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { dataUrl: cv.toDataURL('image/png'), w: cv.width, h: cv.height, srcW: Math.round(base.width), srcH: Math.round(base.height), pages: doc.numPages, page: pageNo };
  }

  /** 导入底图（统一入口） */
  async function importBackground(file) {
    if (!file) return;
    MH.ui.bgBusy = true;
    MH.render();
    try {
      const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
      let res;
      if (isPdf) {
        MH.toast('正在渲染 PDF…', 'ok');
        res = await renderPdfPage(file, 1);
        file.__pdfName = file.name;
      } else {
        const img = await loadImageFile(file);
        res = encodeBitmap(img, 1600);
        res.pages = 1; res.page = 1;
      }
      await applyNewBackground(file, res);
    } catch (err) {
      MH.toast('底图导入失败：' + (err && err.message ? err.message : err), 'error');
    } finally {
      MH.ui.bgBusy = false;
      MH.render();
    }
  }

  async function applyNewBackground(file, res) {
    const save = MH.store.setBgData(res.dataUrl);
    const fit = fitScale(res.w, res.h);
    MH.store.commit('导入底图', s => {
      Core.setBackground(s, {
        kind: res.pages > 1 || /\.pdf$/i.test(file.name) ? 'pdf' : 'image',
        name: file.name,
        w: res.w, h: res.h, srcW: res.srcW, srcH: res.srcH,
        scale: fit, opacity: 0.85, visible: true,
        page: res.page || 1, pages: res.pages || 1,
      });
      Core.setGridOffset(s, 0, 0);
      return { ok: true };
    });
    // PDF 的原始文件留在内存里，方便翻页
    if (res.pages > 1) MH.ui.pdfFile = { file, res };
    if (save && save.ok === false) MH.toast(save.message, 'warn');
    else MH.toast('底图已导入，打开「对齐底图」把它和网格对上', 'ok');
  }

  /** 让底图恰好铺满可视区域 */
  function fitScale(w, h) {
    const vp = MH.els.viewport;
    const availW = Math.max(240, (vp ? vp.clientWidth : 900) - 60);
    const availH = Math.max(240, (vp ? vp.clientHeight : 600) - 60);
    return Math.max(Core.BG_SCALE_MIN, Math.min(Core.BG_SCALE_MAX, Math.min(1, availW / w, availH / h)));
  }

  /** 裁切时四周多留的边距（屏幕 px）——留一点是为了不把网格线切掉 */
  const CROP_MARGIN = 16;

  function loadDataUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('底图数据读取失败，请重新导入'));
      img.src = url;
    });
  }

  /**
   * 按网格外框把底图四周多余部分裁掉，并进入「绑定缩放」状态。
   *
   * 裁切不改变对齐关系：新图原点挪到裁切矩形左上角，网格偏移同步减去该位移
   * （gridCropRect 里算好的 gridX/gridY），所以画面上网格相对底图的位置一模一样。
   * 裁完把 bg.bound 置 true —— 之后缩放会让格子、底图、网格偏移同倍变化。
   */
  async function cropBackground() {
    const st = MH.store.state;
    const b = st.bg;
    if (!b) { MH.toast('还没有底图', 'warn'); return; }
    if (!MH.store.bgData) { MH.toast('底图数据不在内存里，请重新导入', 'warn'); return; }
    const rect = Core.gridCropRect(st, CROP_MARGIN);
    if (!rect) { MH.toast('网格还没有对齐，无法裁切', 'warn'); return; }
    if (rect.x === 0 && rect.y === 0 && rect.w === b.w && rect.h === b.h) {
      MH.store.commit('绑定缩放', s => { Core.updateBackground(s, { bound: true }); return { ok: true }; });
      MH.toast('底图已经是最小范围，已改为绑定缩放', 'ok');
      return;
    }
    MH.ui.bgBusy = true; MH.render();
    try {
      const img = await loadDataUrl(MH.store.bgData);
      const cv = document.createElement('canvas');
      cv.width = rect.w; cv.height = rect.h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, rect.w, rect.h);
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      let url = cv.toDataURL('image/png');
      if (url.length > 1_200_000) url = cv.toDataURL('image/jpeg', 0.9);
      MH.store.setBgData(url);
      MH.store.commit('裁切底图', s => {
        Core.updateBackground(s, {
          w: rect.w, h: rect.h, srcW: rect.w, srcH: rect.h,
          bound: true,
        });
        Core.setGridOffset(s, rect.gridX, rect.gridY);
        return { ok: true };
      });
      MH.ui.aligning = false;
      MH.toast('已裁到网格范围（' + rect.w + '×' + rect.h + '），之后缩放图片和网格会一起变', 'ok');
    } catch (e) {
      MH.toast('裁切失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      MH.ui.bgBusy = false; MH.render();
    }
  }

  async function switchPdfPage(dir) {
    const st = MH.store.state;
    const keep = MH.ui.pdfFile;
    if (!st.bg || !keep || !keep.file) { MH.toast('请重新导入该 PDF 后再翻页', 'warn'); return; }
    const next = Math.min(Math.max(1, st.bg.page + dir), st.bg.pages);
    if (next === st.bg.page) return;
    MH.ui.bgBusy = true; MH.render();
    try {
      const res = await renderPdfPage(keep.file, next);
      MH.store.setBgData(res.dataUrl);
      MH.store.commit('切换 PDF 页', s => {
        Core.updateBackground(s, { w: res.w, h: res.h, page: res.page, pages: res.pages });
        return { ok: true };
      });
      MH.toast('已切到第 ' + res.page + ' 页', 'ok');
    } catch (e) {
      MH.toast('翻页失败：' + e.message, 'error');
    } finally {
      MH.ui.bgBusy = false; MH.render();
    }
  }

  function generate() {
    const st = MH.store.state;
    const rowsInput = document.getElementById('rowsInput');
    const colsInput = document.getElementById('colsInput');
    const rows = Core.clampInt(rowsInput ? rowsInput.value : st.rows, 1, Core.MAX_DIM, st.rows);
    const cols = Core.clampInt(colsInput ? colsInput.value : st.cols, 1, Core.MAX_DIM, st.cols);
    const dirty = st.regions.length || st.items.length ||
      Object.keys(st.play.xmarks).length || Object.keys(st.play.placed).length ||
      Object.values(st.play.candidates || {}).some(a => a && a.length);
    if (dirty && !confirm('重新生成地图会清空区域、物品、人物关联与所有标记（含候选），确定继续？')) return;
    MH.ui.draft = null;
    MH.store.replace(Core.createState(rows, cols), '生成地图');
    MH.toast('已生成 ' + rows + '×' + cols + ' 地图，人物 ' + Core.peopleCount(rows, cols) + ' 个', 'ok');
  }

  function exportJSON() {
    const st = MH.store.state;
    try {
      const blob = new Blob([MH.store.exportText()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'murdoku-' + st.rows + 'x' + st.cols + '-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      MH.toast('已导出存档文件', 'ok');
    } catch (e) {
      MH.toast('导出失败：' + e.message, 'error');
    }
  }

  function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // 图片 / PDF → 当底图；JSON → 当存档
    const isBg = /^image\//.test(file.type) || /pdf$/i.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|pdf)$/i.test(file.name);
    if (isBg) { importBackground(file); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        MH.store.importText(String(reader.result));
        MH.ui.draft = null;
        MH.render();
        MH.toast('已导入存档', 'ok');
      } catch (err) {
        MH.toast('导入失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  const actions = {
    phase(el) { setPhase(el.dataset.phase); },
    preset(el) {
      const v = el.dataset.v;
      const a = document.getElementById('rowsInput'), b = document.getElementById('colsInput');
      if (a) a.value = v;
      if (b) b.value = v;
    },
    gen() { generate(); },
    'select-person'(el) { selectPerson(el.dataset.id); },
    link(el) {
      const st = MH.store.state;
      const pid = st.selectedPersonId;
      if (!pid) { MH.toast('请先选择一个人物', 'warn'); return; }
      const { kind, id, pol } = el.dataset;
      MH.store.commit('设置关联', s => { Core.setLink(s, pid, kind, id, Number(pol)); return { ok: true }; });
    },
    'new-region'() { startDraft('region'); },
    'new-item'() { startDraft('item'); },
    'edit-region'(el) { startDraft('region', el.dataset.id); },
    'edit-item'(el) { startDraft('item', el.dataset.id); },
    'draft-save'() { saveDraft(); },
    'draft-cancel'() { MH.setDraft(null); },
    'draft-clear'() {
      if (!MH.ui.draft) return;
      MH.ui.draft.cells.clear();
      MH.board.updateDraftOutline();
      MH.render();
    },
    'draft-largest'() {
      const d = MH.ui.draft;
      if (!d) return;
      d.cells = new Set(Core.largestComponent([...d.cells]));
      MH.board.updateDraftOutline();
      MH.render();
      MH.toast('已只保留最大的连通块', 'ok');
    },
    'rename-person'(el) { renamePerson(el.dataset.id); },
    'rename-region'(el) { renameEntity('region', el.dataset.id); },
    'rename-item'(el) { renameEntity('item', el.dataset.id); },
    'color-region'(el) { cycleColor('region', el.dataset.id); },
    'color-item'(el) { cycleColor('item', el.dataset.id); },
    'del-region'(el) { deleteEntity('region', el.dataset.id); },
    'del-item'(el) { deleteEntity('item', el.dataset.id); },
    'toggle-occ'(el) {
      const id = el.dataset.id;
      const res = MH.store.commit('切换可占据', s => {
        const t = Core.item(s, id);
        if (!t) return { ok: false, message: '物品不存在' };
        t.occupiable = !t.occupiable;
        return { ok: true, message: '「' + t.name + '」现在' + (t.occupiable ? '可以放人' : '不能放人（游玩阶段会固定标 X）') };
      });
      if (res.message) MH.toast(res.message, 'ok');
    },
    'left-mode'(el) { MH.store.setSettings({ leftMode: el.dataset.mode }); },
    zoom(el) {
      const st = MH.store.state;
      const next = st.settings.cellSize + Number(el.dataset.dir) * Core.CELL_STEP;
      // 走 Core.setCellSize：底图裁切过（bound）时它会连带缩放底图与网格偏移；
      // 但对齐阶段只缩放网格，否则相对关系不变、根本对不齐
      MH.store.live(s => Core.setCellSize(s, next, { gridOnly: !!MH.ui.aligning }));
    },
    'toggle-live'() {
      const st = MH.store.state;
      MH.store.setSettings({ liveValidate: !st.settings.liveValidate });
    },
    // 在行/列统计里点一个人：这一行（列）就是他的，清掉别人的候选并标 ✕
    'head-pick'(el) {
      const st = MH.store.state;
      const axis = el.dataset.axis === 'col' ? 'col' : 'row';
      const idx = Number(el.dataset.line);
      const pid = el.dataset.id;
      const res = MH.store.commit('按行列筛选', s => Core.applyLineChoice(s, axis, idx, pid));
      if (!res || res.ok === false) { MH.toast((res && res.message) || '没有可清理的候选', 'warn'); return; }
      MH.toast(res.message, 'ok');
    },
    'toggle-heads'() {
      const st = MH.store.state;
      MH.store.setSettings({ showHeads: st.settings.showHeads === false });
    },
    undo() { const r = MH.store.undo(); MH.toast(r.message, r.ok ? 'ok' : 'warn'); },
    redo() { const r = MH.store.redo(); MH.toast(r.message, r.ok ? 'ok' : 'warn'); },
    'clear-person'(el) {
      const id = el.dataset.id;
      runCommit('清除人物标记', s => Core.clearPersonMarks(s, id));
    },
    'unplace-person'(el) {
      const id = el.dataset.id;
      runCommit('取消确定位置', s => Core.unplacePerson(s, id));
    },
    'clear-marks'() {
      if (!confirm('清空游玩阶段的所有 X、候选与确定人物？')) return;
      runCommit('清空全部标记', s => Core.clearAllMarks(s));
    },
    'bg-import'() { if (MH.els.bgFileInput) MH.els.bgFileInput.click(); },
    'bg-toggle'() {
      MH.store.commit('底图显示切换', s => { Core.updateBackground(s, { visible: !s.bg.visible }); return { ok: true }; });
    },
    'bg-fit'() {
      MH.store.commit('底图适应窗口', s => {
        Core.updateBackground(s, { scale: fitScale(s.bg.w, s.bg.h) });
        return { ok: true };
      });
    },
    'bg-crop'() { cropBackground(); },
    'bg-scale-step'(el, e) {
      const st = MH.store.state;
      if (!st.bg) { MH.toast('还没有底图', 'warn'); return; }
      const step = (e && e.shiftKey ? 1 : 0.1) / 100;       // Shift = 粗调 1%
      applyBgScale(st.bg.scale + (Number(el.dataset.dir) || 1) * step);
    },
    'bg-scale-reset'() {
      const st = MH.store.state;
      if (!st.bg) { MH.toast('还没有底图', 'warn'); return; }
      applyBgScale(1);
    },
    'bg-remove'() {
      if (!confirm('移除底图？（网格与题目内容不受影响）')) return;
      MH.store.setBgData(null);
      MH.ui.aligning = false;
      MH.ui.pdfFile = null;
      MH.store.commit('移除底图', s => Core.setBackground(s, null));
    },
    'bg-reset'() { MH.store.commit('网格归位', s => Core.setGridOffset(s, 0, 0)); },
    'bg-page'(el) { switchPdfPage(Number(el.dataset.dir)); },
    'bg-align'() {
      MH.ui.aligning = !MH.ui.aligning;
      MH.ui.draft = null;
      MH.render();
      if (MH.ui.aligning) MH.toast('拖动棋盘移动网格 · 拖右下角手柄缩放 · 方向键微调', 'ok');
    },
    export() { exportJSON(); },
    import() { if (MH.els.fileInput) MH.els.fileInput.click(); },
    'reset-all'() {
      const st = MH.store.state;
      if (!confirm('重置整张地图（区域、物品、关联、标记全部清空）？')) return;
      MH.ui.draft = null;
      MH.store.replace(Core.createState(st.rows, st.cols), '重置地图');
      MH.toast('已重置', 'ok');
    },
    help() { MH.openModal('helpModal'); },
    'close-modal'(el) { MH.closeModal(el.dataset.modal); },
    'focus-issue'(el) {
      const k = el.dataset.key;
      if (k) MH.board.flashCell(k);
    },
  };

  function renamePerson(id) {
    const st = MH.store.state;
    const p = Core.person(st, id);
    if (!p) return;
    const label = prompt('给 ' + p.label + ' 换个编号（1–' + Core.LABEL_MAX + ' 个字符，不能含 X）：', p.label);
    if (label == null) return;
    const res = MH.store.commit('修改人物编号', s => Core.setPersonLabel(s, id, label));
    if (res && res.message) MH.toast(res.message, res.ok === false ? 'warn' : 'ok');
  }

  function renameEntity(kind, id) {
    const st = MH.store.state;
    const t = kind === 'region' ? Core.region(st, id) : Core.item(st, id);
    if (!t) return;
    const name = prompt('给' + kindName(kind) + '起个名字：', t.name);
    if (name == null) return;
    const clean = name.trim();
    if (!clean) { MH.toast('名称不能为空', 'warn'); return; }
    MH.store.commit('重命名' + kindName(kind), s => {
      const target = kind === 'region' ? Core.region(s, id) : Core.item(s, id);
      if (!target) return { ok: false, message: '目标不存在' };
      target.name = clean;
      return { ok: true, message: '已重命名为「' + clean + '」' };
    });
  }

  function cycleColor(kind, id) {
    const pal = kind === 'region' ? Core.REGION_COLORS : Core.ITEM_COLORS;
    MH.store.commit('换颜色', s => {
      const t = kind === 'region' ? Core.region(s, id) : Core.item(s, id);
      if (!t) return { ok: false, message: '目标不存在' };
      const i = pal.indexOf(t.color);
      t.color = pal[(i + 1) % pal.length];
      return { ok: true };
    });
  }

  function deleteEntity(kind, id) {
    const st = MH.store.state;
    const t = kind === 'region' ? Core.region(st, id) : Core.item(st, id);
    if (!t) return;
    if (!confirm('删除' + kindName(kind) + '「' + t.name + '」？相关的人物关联也会一并移除。')) return;
    MH.store.commit('删除' + kindName(kind), s => {
      if (kind === 'region') Core.deleteRegion(s, id); else Core.deleteItem(s, id);
      return { ok: true, message: '已删除「' + t.name + '」' };
    });
  }

  // ---------------------------------------------------------------- 事件绑定

  function onDocumentClick(e) {
    const el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    if (el.disabled) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    fn(el, e);
  }

  /** 设置底图缩放：拖动滑块、精调按钮、还原都走这里，顺带刷新数值显示 */
  /**
   * 底图热调节（缩放 / 透明度）的公共入口：拖动时**静默**改状态 + 只刷新画布，
   * 松手（change）时再 touch() 落盘 + 全量重绘。
   *
   * 走 store.preview 的话每次输入都触发整块重渲染，而侧栏里的滑块本身就在
   * 重渲染范围内 —— 拖到第二下节点被换掉，拖动直接失效（实测 40 步只生效 1 步）。
   * 这里再用 rAF 合并同帧的多次输入。
   */
  let bgRaf = 0;
  function applyBgPatch(patch) {
    if (!MH.store.state.bg) return;
    // 状态立即生效（数值显示、后续读取都立刻正确），只把画布刷新合并到一帧里
    MH.store.previewSilent(s => Core.updateBackground(s, patch));
    if (bgRaf) return;
    const flush = () => { bgRaf = 0; MH.board.refreshLayout(); };
    bgRaf = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(flush)
      : (setTimeout(flush, 16), 1);
  }

  function applyBgScale(v) {
    const st = MH.store.state;
    if (!st.bg) return;
    const next = Math.round(Core.clampNum(v, 0.1, 4, 1) * 1000) / 1000;
    const slider = document.getElementById('bgScale');
    if (slider) slider.value = String(Math.round(next * 1000) / 10);
    const meta = document.querySelector('[data-bg="scale"]');
    if (meta) meta.textContent = (Math.round(next * 1000) / 10).toFixed(1) + '%';
    applyBgPatch({ scale: next });
  }

  function onDocumentInput(e) {
    const t = e.target;
    if (t.id === 'draftName') {
      if (MH.ui.draft) MH.ui.draft.name = t.value;
    } else if (t.id === 'bgOpacity') {
      const v = Core.clampInt(t.value, 10, 100, 85) / 100;
      applyBgPatch({ opacity: v });
    } else if (t.id === 'bgScale') {
      // 注意用浮点 clamp：以前用 clampInt 会把值取整到 1%，细步长等于白调
      const v = Core.clampNum(t.value, 10, 400, 100) / 100;
      applyBgScale(v);
    } else if (t.id === 'cellSize') {
      MH.store.live(s => Core.setCellSize(s, t.value, { gridOnly: !!MH.ui.aligning }));
    }
  }

  function onDocumentChange(e) {
    const t = e.target;
    // 底图滑块松手：把拖动期间的静默改动落盘，并全量重绘一次（侧栏数值也跟着刷新）
    if (t.id === 'bgScale' || t.id === 'bgOpacity') {
      MH.store.touch('调整底图');     // 落盘 + 全量重绘一次（侧栏数值也跟着刷新）
      return;
    }
    if (t.name === 'draftOcc') {
      if (MH.ui.draft) { MH.ui.draft.occupiable = t.value === '1'; MH.render(); }
    } else if (t.id === 'linkPicker') {
      const v = t.value;
      t.value = '';
      if (!v) return;
      const i = v.indexOf(':');
      const kind = v.slice(0, i);
      const id = v.slice(i + 1);
      const st = MH.store.state;
      const pid = st.selectedPersonId;
      const target = kind === 'region' ? Core.region(st, id) : Core.item(st, id);
      if (!pid || !target) return;
      MH.store.commit('添加关联', s => { Core.setLink(s, pid, kind, id, 1); return { ok: true }; });
      MH.toast('已把 ' + Core.person(st, pid).label + ' 与「' + target.name + '」关联（正相关）', 'ok');
    } else if (t.id === 'fileInput') {
      onImportFile(e);
    } else if (t.id === 'bgFileInput') {
      const f = t.files && t.files[0];
      t.value = '';
      if (f) importBackground(f);
    }
  }

  function onSidebarHover(e) {
    const reg = e.target.closest('[data-hover-region]');
    const it = e.target.closest('[data-hover-item]');
    const per = e.target.closest('[data-hover-person]');
    const rid = reg ? reg.dataset.hoverRegion : null;
    const iid = it ? it.dataset.hoverItem : null;
    const pid = per ? per.dataset.hoverPerson : null;
    if (rid === MH.ui.hoverRegionId && iid === MH.ui.hoverItemId && pid === MH.ui.hoverPersonId) return;
    MH.ui.hoverRegionId = rid;
    MH.ui.hoverItemId = iid;
    MH.ui.hoverPersonId = pid;
    MH.board.applyHover();
  }

  function clearSidebarHover() {
    if (!MH.ui.hoverRegionId && !MH.ui.hoverItemId && !MH.ui.hoverPersonId) return;
    MH.ui.hoverRegionId = null;
    MH.ui.hoverItemId = null;
    MH.ui.hoverPersonId = null;
    MH.board.applyHover();
  }

  function syncChrome(st) {
    const tabPrep = document.getElementById('tabPrep');
    const tabPlay = document.getElementById('tabPlay');
    if (tabPrep) tabPrep.classList.toggle('active', st.phase === 'prep');
    if (tabPlay) tabPlay.classList.toggle('active', st.phase === 'play');

    const undoBtn = document.getElementById('btnUndo');
    if (undoBtn) {
      undoBtn.disabled = !MH.store.canUndo();
      undoBtn.title = MH.store.canUndo() ? '撤销：' + MH.store.undoLabel() : '没有可撤销的操作';
    }
    const redoBtn = document.getElementById('btnRedo');
    if (redoBtn) {
      redoBtn.disabled = !MH.store.canRedo();
      redoBtn.title = MH.store.canRedo() ? '重做：' + MH.store.redoLabel() : '没有可重做的操作';
    }
    const zoomOut = document.getElementById('btnZoomOut');
    const zoomIn = document.getElementById('btnZoomIn');
    if (zoomOut) {
      zoomOut.disabled = st.settings.cellSize <= Core.CELL_MIN;
      zoomOut.title = '缩小棋盘（当前每格 ' + st.settings.cellSize + 'px）';
    }
    if (zoomIn) {
      zoomIn.disabled = st.settings.cellSize >= Core.CELL_MAX;
      zoomIn.title = '放大棋盘（当前每格 ' + st.settings.cellSize + 'px）';
    }
    // 按钮和滑块是同一个设置的两种操作方式，保持同步
    const range = document.getElementById('cellSize');
    if (range) {
      if (Number(range.value) !== st.settings.cellSize) range.value = String(st.settings.cellSize);
      range.title = '棋盘缩放：拖动调整每格像素（当前 ' + st.settings.cellSize + 'px）';
    }

    const ph = document.getElementById('boardPhase');
    if (ph) ph.textContent = st.phase === 'prep' ? '① 地图准备' : '② 游玩';
    const hint = document.getElementById('boardHint');
    if (hint) {
      const d = MH.ui.draft;
      hint.textContent = st.phase === 'prep'
        ? (d
          ? '正在' + (d.editingId ? '编辑' : '新建') + kindName(d.kind) + '：点选格子，选好后在左侧保存'
          : '选中人物可设置关联 · 悬停格子查看所在区域')
        : '左键＝候选（可拖动连标）· 右键＝X · 长按＝确定位置并排除同行列 · 悬停人物查看相关性';
    }
  }

  const P = {
    init() {
      document.addEventListener('click', onDocumentClick);
      document.addEventListener('input', onDocumentInput);
      document.addEventListener('change', onDocumentChange);
      const sidebar = MH.els.sidebar;
      sidebar.addEventListener('pointermove', onSidebarHover);
      sidebar.addEventListener('pointerleave', clearSidebarHover);
      document.addEventListener('keydown', e => {
        const mod = e.metaKey || e.ctrlKey;
        const tag = (e.target && e.target.tagName) || '';
        // 输入框里让浏览器自己处理撤销/重做
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault();
          const r = MH.store.undo();
          MH.toast(r.message, r.ok ? 'ok' : 'warn');
        } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
          e.preventDefault();
          const r = MH.store.redo();
          MH.toast(r.message, r.ok ? 'ok' : 'warn');
        } else if (MH.ui.aligning && /^Arrow(Left|Right|Up|Down)$/.test(e.key)
                   && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          MH.board.nudge(dx, dy);
        } else if (e.key === 'Escape') {
          if (MH.ui.draft) { MH.setDraft(null); }
          else MH.closeModal();
        }
      });
    },

    render(st) {
      const el = MH.els.sidebar;
      if (!el) return;
      const top = el.scrollTop;
      el.innerHTML = st.phase === 'prep' ? prepHTML(st) : playHTML(st);
      el.scrollTop = top;
      syncChrome(st);
    },

    /** 拖拽刷格时只更新草稿提示，避免侧栏输入框失焦 */
    refreshDraftMeta() {
      const d = MH.ui.draft;
      const meta = document.getElementById('draftMeta');
      if (!d || !meta) return;
      meta.innerHTML = draftMetaText(d);
      const save = document.querySelector('[data-act="draft-save"]');
      if (save) {
        const cells = [...d.cells];
        save.disabled = !(cells.length && (d.kind !== 'region' || Core.isConnected(cells)));
      }
      const largest = document.querySelector('[data-act="draft-largest"]');
      if (largest && d.kind === 'region') {
        const cells = [...d.cells];
        largest.style.display = (!Core.isConnected(cells) && cells.length) ? '' : 'none';
      }
    },
  };

  MH.panels = P;
  // 右侧「PDF 摘录」悬浮窗（js/snipper.js）复用同一套 pdf.js 加载与渲染
  MH.ensurePdfLib = ensurePdfLib;
  MH.renderPdfPage = renderPdfPage;
  MH.registerRenderer(st => P.render(st));
})();

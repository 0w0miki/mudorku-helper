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

  /**
   * 物品编辑界面里的"点样例补格子"按钮。
   * 用法（按钮就在编辑界面里）：点它 → 在棋盘上点一个格子当样例 → 自动找出所有同类格子
   * → **追加到正在编辑的这件物品**（不会新建 ✓）。多找几次可以叠加，找到的还能手动加减。
   */
  function draftSampleButtons() {
    if (!MH.store.state.bg) return '';
    return '<button class="ghost sm" data-act="item-sample"' + (MH.ui.itemPicking ? ' disabled' : '') +
        ' title="点棋盘上一个格子当样例，自动把同类格子加到这件物品">' +
        (MH.ui.itemPicking ? '🔍 请点一个格子…' : '🔍 按样例添加') + '</button>';
  }

  function draftHTML(st, d, opts) {
    const inline = !!(opts && opts.inline);
    const cells = [...d.cells];
    const connected = d.kind !== 'region' || Core.isConnected(cells);
    const canSave = cells.length > 0 && connected;
    const showLargest = d.kind === 'region' && !connected && cells.length > 0;
    return '<div class="draft' + (inline ? ' inline' : '') + '">' +
      '<div class="draft-head"><b>' + (d.editingId ? '编辑' : '新建') + kindName(d.kind) + '</b>' +
      '<span class="grow"></span>' +
      '<button class="ghost sm" data-act="draft-cancel">' + (inline ? '收起' : '取消') + '</button></div>' +
      (d.kind === 'item' ? '<div class="row wrap draft-tools">' + draftSampleButtons() + '</div>' : '') +
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
      '<div class="row wrap">' +
      '<button class="ghost sm" data-act="bg-region" title="拖动矩形，正好圈住地图外框；再用当前行列数算出格距与偏移">▭ 框地图外框</button>' +
      (MH.ui.alignInfo ? '<span class="meta">' + esc(MH.ui.alignInfo) + '</span>' : '') +
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
    const d = MH.ui.draft;
    return list.map(t => {
      const hover = kind === 'region' ? 'data-hover-region="' + esc(t.id) + '"' : 'data-hover-item="' + esc(t.id) + '"';
      // 正在编辑这一项 → 编辑界面**直接展开在这一行下面**（不用往上滚 ✓）
      const editing = !!(d && d.kind === kind && d.editingId === t.id);
      const inline = editing ? draftHTML(st, d, { inline: true }) : '';
      return '<li class="' + (editing ? 'editing' : '') + '" ' + hover + '>' +
        '<button class="swatch" data-act="color-' + kind + '" data-id="' + esc(t.id) + '" style="--c:' + esc(t.color) + '" title="点击换颜色"></button>' +
        '<span class="nm">' + esc(t.name) + '</span>' +
        '<span class="meta">' + t.cells.length + ' 格</span>' +
        (kind === 'item'
          ? '<button class="occ ' + (t.occupiable ? '' : 'blocked') + '" data-act="toggle-occ" data-id="' + esc(t.id) + '" title="切换是否可占据">' + (t.occupiable ? '可占据' : '不可占据') + '</button>'
          : '') +
        '<button class="ghost sm" data-act="edit-' + kind + '" data-id="' + esc(t.id) + '">编辑</button>' +
        '<button class="ghost sm danger" data-act="del-' + kind + '" data-id="' + esc(t.id) + '">删除</button>' +
        inline +
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
      (!d && MH.store.state.bg
        ? '<button class="ghost block" data-act="detect-regions" ' + (MH.ui.ocrBusy ? 'disabled' : '') +
            ' title="在已对位的底图上逐格取色。区域名按输入自动取：PDF 读文字层；截图则自动找白底黑字标签并用内置 OCR 读名字（首次加载约 7.8MB）。结果都是候选，可撤销">' +
            (MH.ui.ocrBusy ? '🔍 正在识别（读区域名…）' : '🔍 自动识别区域') + '</button>' +
          '<p class="hint">PDF 读文字层；截图自动找区域名标签（白底药丸 + 黑描边 + 黑字）并用内置 OCR 读名字。名字读错点列表里的「改名」即可。</p>' +
          (MH.store.state.bg && !MH.store.state.bg.bound
            ? '<p class="hint warn">还差一步：底图还没对位（点「自动识别区域」只会提示）。先点「▭ 框地图外框」圈住地图，或勾「对齐底图」手动对准后退出。</p>'
            : '') +
          '<button class="ghost block" data-act="check-regions" title="点不出结果时先点这个：报告对位、网格位置、区域名来源、种子数，并让识别内核试跑一次（不改动任何数据）">🩺 识别自检</button>' +
          (readLabelCache(MH.store.state)
            ? '<div class="row"><span class="meta">记住了上次的 ' + readLabelCache(MH.store.state).length +
              ' 个区域名</span><span class="grow"></span>' +
              '<button class="ghost sm" data-act="clear-labels" title="忘掉记住的区域名，下次重新读（截图会重新 OCR）">清除记忆</button></div>'
            : '') +
          '<button class="ghost block" data-act="diag-regions" title="把每条相邻边的墙强度/覆盖率/宽度/深度摊开，用来按真实数据核对判据">🩺 边界诊断</button>'
        : '') +
      (MH.ui.diagText
        ? '<p class="hint">把下面这段复制发我（我按你的真实数字定判据，不再猜）：</p>' +
          '<textarea class="diag" readonly wrap="off" rows="14">' + esc(MH.ui.diagText) + '</textarea>' +
          '<div class="row"><button class="ghost sm" data-act="diag-copy">复制</button>' +
          '<span class="grow"></span><button class="ghost sm" data-act="diag-close">关闭</button></div>'
        : '') +
      (d && d.kind === 'region' ? draftHTML(st, d) : '') +
      '<ul class="list">' + entityList('region', st) + '</ul>' +
      '</section>' +

      '<section class="card">' +
      '<h2>物品 <span class="muted">可占据 / 不可占据</span></h2>' +
      '<button class="ghost block" data-act="new-item" ' + (d ? 'disabled' : '') + '>＋ 新建物品</button>' +
      (!d && MH.store.state.bg
        ? '<button class="ghost block" data-act="legend-auto" ' +
            ' title="从右侧图例卡片自动切出每个物品图标、认名字、按图例里的说明分\"可占据/不可占据\"，一次性建好物品清单（格子留空，地点再点样例补）">' +
            '🚀 从图例自动列出物品</button>' +
          '<button class="ghost block" data-act="legend-locate" ' +
            ' title="用图例里抠出来的图标当模板，逐件到地图上找格子（图例图标干净、无遮挡，比在地图上点样例可靠）">' +
            (MH.ui.locating ? '⏳ 正在找…（点这里取消）' : '📍 自动找地点（用图例图标）') + '</button>'
        : '') +
      (d && d.kind === 'item' && !d.editingId ? draftHTML(st, d) : '') +
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
      '</div></section>' +

      // 底图相关操作（导入 / 对齐 / 透明度 / 显示隐藏）都在准备阶段那张卡片里，
      // 游玩阶段不再重复放一个只有复选框的卡片

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

  /**
   * 用某一格当样例，找图上所有"同一件物品"的格子 → 直接填进物品草稿。
   * 这类地图上同一件物品是同一张画反复贴的，模板匹配（NCC + 形状复核）非常可靠；
   * 用户点一下样例即可，结果的格子还能在草稿里手工加减。
   */
  async function pickItemSample(k) {
    // **重入保护**：按下和点击事件可能各触发一次 ✗ —— 第二次（异步慢一点）会在用户已经
    // 输入名字之后才 render，把刚填的名字冲掉 ✓（e2e 里表现为偶发"名字没保存上" ✗）
    if (MH.ui.sampling) return;
    MH.ui.sampling = true;
    try {
    const I2 = window.MurdokuItems;
    if (!I2) { MH.toast('物品模块没加载（js/items.js）', 'error'); return; }
    const st = MH.store.state;
    if (!requireAligned(st)) return;
    const [r, c] = String(k).split(',').map(Number);
    let geo;
    try { geo = await regionGeometry(); } catch (err) { MH.toast(err.message, 'warn'); return; }
    if (!geo) { MH.toast('底图尺寸异常', 'warn'); return; }
    const t0 = Date.now();
    let res;
    try { res = I2.findSimilar(geo.raster, geo.geom, r, c); } catch (err) {
      MH.toast('找同类出错：' + (err && err.message ? err.message : err), 'error');
      return;
    }
    // **没找到同类也把点的那一格加进去** ✓：用户点这一格的意思就是"这件物品在这里"，
    // 找不到别的同类不该白点一下 ✗（再手工点一次很烦 ✓）
    if (!res.ok || !res.cells.length) {
      const put = applySampleToDraft([k]);
      MH.ui.draft.sample = { r, c };
      MH.ui.lastItemMatch = { sample: { r, c }, cells: [k], stats: res.stats || null,
        template: res.template || null, fallback: true };
      MH.render();
      MH.toast('没找到同类（' + (res.reason || '未知原因') + '）· 已把点的这一格加进去' +
        (put.reused ? '：本次 +' + put.added + ' 格，共 ' + put.total + ' 格' : '') +
        ' —— 可继续在棋盘上点/拖动加格子，再点「保存」', 'warn');
      return;
    }
    const put = applySampleToDraft(res.cells);
    MH.ui.draft.sample = { r, c };
    MH.ui.lastItemMatch = { sample: { r, c }, cells: res.cells, stats: res.stats, template: res.template };
    MH.render();
    MH.toast('找到 ' + res.cells.length + ' 格同类（' + (Date.now() - t0) + 'ms · 阈值 ' + res.stats.threshold + '）· ' +
      (put.reused ? '已追加到当前物品：本次 +' + put.added + ' 格，共 ' + put.total + ' 格' : '草稿里已圈好') +
      '：可在棋盘上加减，改完点「保存」', 'ok');
    } finally {
      MH.ui.sampling = false;
    }
  }

  /** 取第一张图例卡片的像素（画到 canvas 上再读） */
  async function legendCardRaster() {
    const pins = (window.MurdokuSnipper && window.MurdokuSnipper.state && window.MurdokuSnipper.state.pins) || [];
    if (!pins.length) return null;
    const pin = pins[0];
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('卡片图片读不出来')); img.src = pin.url; });
    const w = pin.w || img.naturalWidth, h = pin.h || img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    return { data: d.data, width: w, height: h };
  }

  /**
   * 图例来自 PDF 时走这条路：**直接读文字层**（名字 + 精确坐标 + 两栏说明），
   * 一个像素都不用猜。图标只需在"名字上方那条带"里取一次色差外接框 ——
   * 带子很小、底色占主导，很稳。真实图例画在彩色药丸面板里，纯像素切分没有稳定解 ✗
   */
  async function readLegendByPdf() {
    const Sn = window.MurdokuSnipper && window.MurdokuSnipper.state;
    const file = Sn && Sn.file;
    if (!file || !/pdf/i.test(file.type || file.name || '')) return null;
    await MH.ensurePdfLib();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    try {
      const page = await doc.getPage(Math.min(Math.max(1, Sn.page || 1), doc.numPages));
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(0.3, 1600 / Math.max(base.width, base.height)));
      const vp = page.getViewport({ scale });
      const cv = document.createElement('canvas');
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        const str = String(it.str || '').trim();
        if (!str) continue;
        const pt = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        items.push({
          str, x: pt[0], y: pt[1],
          w: (it.width || 0) * scale || str.length * 6,
          h: Math.abs(it.transform[3]) * scale || 10,
        });
      }
      const pageRaster = { data: img.data, width: img.width, height: img.height };
      const parsed = window.MurdokuLegend.legendFromText(items, pageRaster);
      parsed.raster = pageRaster;           // 供"裁出每个物品的图标当模板"用
      parsed.rawItems = items;              // 原始文字项：按卡片框重解析时要用
      parsed.page = { w: img.width, h: img.height, pageNo: Sn.page || 1 };
      return parsed;
    } finally {
      if (doc.destroy) doc.destroy();
    }
  }

  /**
   * 用**词级 OCR**（tesseract 的 TSV）从卡片上读图例：
   * 直接拿到"说明行"和"每个物品名"的**真实框** ✓ —— 不再靠"行墨量分排 + 列投影猜名字框" ✗
   * （猜出来的框会把相邻两个名字粘在一起，例如 "flowers shark"）
   * @returns {{items:Array, headings:Array}|null}
   */
  async function readCardLegendByOcr(raster, rect) {
    const O = window.MurdokuOCR;
    if (!O || !O.readWords) return null;
    const Lg = window.MurdokuLegend;
    // ① 整张卡 OCR 一次（大区域会自动分块）：拿到每个词的框 + 文字 + 置信度 ✓
    const all = await O.readWords(raster, rect,
      { zoom: 5, psm: 11, chars: O.WORDS, minConf: 65, onStatus: m => MH.toast(m, "ok") });
    if (!all || !all.length) return null;
    // ② 按 y 归行；行内再按 x 间隙分组（间隙 ≤0.6 字高 = 同一个名字，如 "Oil Slick"）
    const lines = [];
    for (const w of all) {
      const ln = lines.find(l => Math.abs(l.y - w.y) < Math.max(6, w.h * 0.7));
      if (ln) { ln.words.push(w); ln.y = Math.min(ln.y, w.y); ln.h = Math.max(ln.h, w.h); }
      else lines.push({ y: w.y, h: w.h, words: [w] });
    }
    const groupsOf = ln => {
      ln.words.sort((a, b) => a.x - b.x);
      const gs = [];
      for (const w of ln.words) {
        const last = gs[gs.length - 1];
        const gap = last ? w.x - (last.x + last.w) : 1e9;
        if (last && gap <= Math.max(3, w.h * 0.6)) {
          last.text = last.text + ' ' + w.text;
          last.w = (w.x + w.w) - last.x;
          last.h = Math.max(last.h, w.h);
        } else {
          gs.push({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h });
        }
      }
      return gs;
    };
    // ③ 说明行 = 含 "occupied/占据" 的行（**真去认字**，不再靠"没配上图标的矮排"反推 ✓）
    //    极性优先用 classifyLabel；OCR 把整行读残（"can occupied"）时退回关键词判断 ✓
    // 按"词块"分类（一行里可能有两条说明并排 ✓）。**只认 classifyLabel 判得出来的**：
    // 之前加过"含 occupied 就算"的放宽，会把别的行也糊进来（实测把整组极性搞乱 ✗）
    // 先按"词块"找**含 occupied/占据 的那块**（OCR 常把整行读残 ✗，按整行分类会漏掉整组），
    // 极性则取它**左边紧邻的 1~3 个词块**："can't" / "cannot" → 不可；"can"/别的 → 可 ✓
    // （car-repair 两个说明行在同一行，所以不能按"整行"判极性 ✗）
    const heads = [];
    for (const ln of lines) {
      const gs = groupsOf(ln);
      for (let i = 0; i < gs.length; i++) {
        // 允许「半个词」且不要求开头：整图 OCR 把 occupied 读成过 occ，
        // 而且它常和前面的词并成一块（"be occ"）—— 只要含 occ 就交给下面的
        // "抠一条放大重认"去读全 ✓
        if (!/occ|ocup|0cc|占据|放人/i.test(gs[i].text)) continue;
        const near = [];
        for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
          if (gs[k].x + gs[k].w < gs[i].x - Math.max(24, gs[i].h * 3.5)) break;   // 隔太远就不算
          near.unshift(gs[k].text);
        }
        let cls = Lg.classifyLabel(near.concat([gs[i].text]).join(' '));
        if (cls === 'unknown') cls = /(can't|cannot|no|not)/i.test(near.join(' ')) ? 'no' : 'yes';
        const x0 = near.length ? gs[i - near.length].x : gs[i].x;
        if (x0 > gs[i].x) { /* 保险：别越界 */ }
        heads.push({ x: Math.min(x0, gs[i].x), y: gs[i].y, w: gs[i].x + gs[i].w - Math.min(x0, gs[i].x),
          h: gs[i].h, text: near.concat([gs[i].text]).join(' '), occupiable: cls === 'yes' });
      }
    }
    if (!heads.length) return null;                      // 没有说明行就不是图例，别硬认
    // ③b 说明行**单独抠一条放大再 OCR**（单行模式 psm 7 认得准 ✓）：
    //     整图 OCR 会把 occupied 读残成 occ，极性也就无从判断 ✗
    for (const h of heads) {
      const hh = Math.max(8, h.h);
      const sx = Math.max(0, h.x - hh * 6);
      const strip = { x: sx, y: Math.max(0, h.y - hh * 0.8),
        w: Math.min(raster.width - sx, h.w + hh * 12), h: Math.min(raster.height, hh * 2.6) };
      try {
        const got = await O.readWords(raster, strip, { zoom: 8, psm: 7, chars: O.WORDS, minConf: 55 });
        const txt = (got || []).map(w2 => w2.text).join(' ').trim();
        if (txt) {
          h.text = txt;
          const cls = Lg.classifyLabel(txt);
          if (cls === 'yes') h.occupiable = true;
          else if (cls === 'no') h.occupiable = false;
        }
      } catch (err) { /* 读不到就保持原判 */ }
    }
    // ④ 每条说明行的**板底色**（它周围一圈的众数颜色）
    for (const h of heads) h.bg = Lg.ringColour(raster, h, 0.8);
    // ⑤ 名字 = 与某条说明行**同一块色板**上的词 ✓（比"切面板矩形"稳：真实截图底色有渐变，
    //    一切就整页连成一块，大面板会整个消失 —— contest 里 14 件物品的粉面板就这么丢过 ✗）
    const names = [], seen = [];
    for (const w of all) {
      const t2 = String(w.text || '').trim();
      const letters = t2.replace(/[^A-Za-z]/g, '');
      if (letters.length < 2) continue;
      // **这里不再"排除全大写"** ✓：截图路径的输入就是用户框定的图例（卡片），
      // 图例可能整块用大写风格（SHELF / CARPET…）；把它当"地图区域名"挡掉是错的 ✗
      // （那个启发式只留给"整页文字层解析"那条路，见 legend.js）
      // 短全大写（TV / NS 这种）另外把关：必须正上方有对齐图标（见 ⑥），挡掉版面碎片 ✓
      const shortCaps = letters === letters.toUpperCase() && letters.length < 4;
      if (/^[A-Za-z]{0,2}\d+$/.test(t2)) continue;                 // C9 这种坐标
      // **"像不像句子 / 像不像虚词"这两条只留给整页解析** ✗→✓
      // 截图路径的输入是用户框定的图例 ✓：图例里可能有长短语（"bag of gold coins"）✗，
      // 也可能正好叫 Area / Left 的物品 ✗ —— 拿地图/正文的启发式去挡是错的。
      // 这里只保留硬规则：≥2 字母、不是纯坐标（上面两条）+ 必须落在图例色板上（下面 ✓）
      const bg = Lg.ringColour(raster, w, 0.8);
      // 颜色对不上任何说明行时**先别丢**：可能只是那条说明没被认出来 ✓
      // （contest 的绿面板整组就是这么消失的 —— 名字读出来了却因为没锚点被丢 ✗）
      // 这类要更严的门槛才收：独立名字行 + 正上方有对齐图标（见下面 ⑥），挡掉版权/句子碎片 ✓
      const matched = heads.some(h => Lg.colourGap(bg, h.bg) <= 30);
      if (!matched) continue;      // 对不上任何说明行的色板 → 不是这组图例的名字
      if (heads.some(h => Math.abs(h.y - w.y) < Math.max(8, w.h))) continue;   // 说明行自己不算
      const ln = lines.find(l => l.words.includes(w));
      const merged = { text: t2, x: w.x, y: w.y, w: w.w, h: w.h, bg, matched, shortCaps,
        lineWords: ln ? ln.words.length : 1 };
      if (ln) {
        const gs = groupsOf(ln).find(g => Math.abs(g.x - w.x) < 2);
        if (gs) Object.assign(merged, { text: gs.text, w: gs.w, h: gs.h });
      }
      // 去重：**按框重叠**判同一处文字（"Oil Slick" 这个合并结果与它里面的 "Slick"
      // 框是重叠的 ✓；以前只比 x/y 临近，两个都会留下 → 同一件物品出现两遍 ✗）
      const clash = (a, b2) => {
        const ox = Math.min(a.x + a.w, b2.x + b2.w) - Math.max(a.x, b2.x);
        const oy = Math.min(a.y + a.h, b2.y + b2.h) - Math.max(a.y, b2.y);
        if (ox <= 0 || oy <= 0) return false;
        return (ox * oy) / Math.min(a.w * a.h, b2.w * b2.h) > 0.5;
      };
      if (seen.some(q => clash(q, merged))) continue;
      seen.push(merged);
      names.push(merged);
    }
    if (!names.length) return null;
    // ⑥ 每个名字 → 正上方那块墨迹 = 图标（找不到也算一件 —— 清单/可占据只需要名字 ✓）
    const withIcon = [];
    for (const nm of names) {
      const nameH = Math.max(6, nm.h);
      const pad = nameH * 0.8;
      let icon = Lg.findIconInBand(raster, nm.x - pad, nm.y - nameH * 5, nm.x + nm.w + pad, nm.y - nameH * 0.3);
      if (!icon) icon = Lg.findIconInBand(raster, nm.x - nameH * 8, nm.y - nameH * 1.5, nm.x - 2, nm.y + nameH * 0.6);
      if (icon) {
        // 图标在名字正上方才收（横向大致对齐、图标比字高），否则只当"没有图标"
        const icx = icon.x + icon.w / 2, ncx = nm.x + nm.w / 2;
        if (Math.abs(icx - ncx) > Math.max(icon.w * 0.55, nameH * 2)) icon = null;
        else if (icon.h < nameH * 1.3) icon = null;
      }
      if (nm.shortCaps && !icon) continue;      // 短全大写（TV 这种）要有图标才算数 ✓
      // 归属分两步：
      // ① 先取"名字上方最近的一**行**说明"（把 y 相近的说明合成一行 —— car-repair 两个面板
      //    的说明就在同一行 ✓）；
      // ② 这一行里有两条说明时，按 **x** 选（名字横向落在哪条说明下面 ✓）。
      // 只按颜色相近选会判反（两块图例面板颜色几乎一样 ✗），只看 y 也不行（同一行两条 ✗）
      const dyOf = h => (h.y + h.h <= nm.y + 4 ? (nm.y - h.y) : 1e5 + Math.abs(nm.y - h.y));
      const rows = [];
      for (const h of heads) {
        const row = rows.find(r => Math.abs(r.y - h.y) <= Math.max(12, h.h));
        if (row) { row.list.push(h); row.y = Math.min(row.y, h.y); row.h = Math.max(row.h, h.h); }
        else rows.push({ y: h.y, h: h.h, list: [h] });
      }
      let row = null;
      for (const r of rows) {
        const d = dyOf({ y: r.y, h: r.h });
        if (!row || d < dyOf({ y: row.y, h: row.h })) row = r;
      }
      let head = null;
      if (row) {
        for (const h of row.list) {
          const dx = (nm.x + nm.w < h.x ? h.x - (nm.x + nm.w) : (nm.x > h.x + h.w ? nm.x - (h.x + h.w) : 0));
          if (!head || dx < head.__dx) { head = h; head.__dx = dx; }
        }
      }
      withIcon.push({ nm, icon, head });
    }
    const items = [];
    for (const it of withIcon) {
      const nm = it.nm;
      items.push({ name: nm.text, occupiable: it.head ? it.head.occupiable : null,
        icon: it.icon || null, nameBox: { x: nm.x, y: nm.y, w: nm.w, h: nm.h } });
    }
    if (items.length < 2) return null;
    // 诊断用（e2e/探针也会读）：说明行与名字的框
    MH.ui.lastLegendDebug = { heads: heads.map(h => ({ text: h.text, x: h.x, y: h.y, w: h.w, h: h.h, occupiable: h.occupiable })),
      names: names.map(n => ({ text: n.text, x: n.x, y: n.y, w: n.w })) };
    return { items, headings: heads };
  }

  /** 批量 OCR 一批框（失败就返回空串，不抛） */
  async function ocrBoxes(raster, boxes) {
    const empty = new Array(boxes.length).fill('');
    if (!boxes.length || !window.MurdokuOCR) return empty;
    try {
      const got = await window.MurdokuOCR.readBadges(raster, boxes,
        { zoom: 4, chars: window.MurdokuOCR.WORDS, onStatus: m => MH.toast(m, 'ok') });
      return got.map(r2 => String(r2.text || '').replace(/\s+/g, ' ').trim());
    } catch (err) {
      MH.toast('文字识别失败（名字/分组会留空，可手动改）：' + err.message, 'warn');
      return empty;
    }
  }

  /** 用"说明行"给每件物品定可占据：优先它**上方**那条，否则取最近的 ✓ */
  function occupiableByHeads(items, heads) {
    items.forEach(it => {
      // 已经有明确结论的（词级 OCR 那条路会按"行 + x"仔细判过）不要覆盖 ✗
      // —— 这里只给"还没定"的兜底（以前无条件覆盖，把 car-repair 两面板的极性判反过）
      if (it.occupiable === true || it.occupiable === false) return;
      const ic = it.icon || it.box || { x: 0, y: 0, w: 1, h: 1 };
      let best = null, bestD = Infinity;
      (heads || []).forEach(h => {
        const above = h.y + (h.h || 0) <= ic.y + Math.max(4, ic.h * 0.3);
        const d = above ? (ic.y - h.y) : 1e5 + Math.abs(ic.y - h.y);
        if (d < bestD) { bestD = d; best = h; }
      });
      it.occupiable = best ? best.occupiable : null;
    });
    return items;
  }

  /**
   * 从图例卡片自动列出物品：切图标 → OCR 名字与分组说明 → 一次性建好物品。
   * **不自动填格子**（地图上"在哪"目前还不准）：先把"有哪些物品 + 名字 + 可占据"自动化。
   */
  /** 把当前页的卡片框换算成页面栅格坐标（图例区域 = 用户框出来的那块） */
  function cardRectsForPage(raster) {
    const Sn = window.MurdokuSnipper && window.MurdokuSnipper.state;
    if (!Sn || !raster) return [];
    const out = [];
    for (const pin of (Sn.pins || [])) {
      if (pin.page !== (Sn.page || 1) || !pin.srcPageW || !pin.srcPageH) continue;
      const kx = raster.width / pin.srcPageW, ky = raster.height / pin.srcPageH;
      out.push({ x: pin.srcX * kx, y: pin.srcY * ky, w: pin.srcW * kx, h: pin.srcH * ky });
    }
    return out;
  }

  /** 从栅格上裁一小块（做模板用） */
  function cropPatch(raster, box) {
    const w = Math.max(1, Math.round(box.w)), h = Math.max(1, Math.round(box.h));
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(raster.height - 1, Math.round(box.y) + y);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(raster.width - 1, Math.round(box.x) + x);
        const so = (sy * raster.width + sx) * 4, dst = (y * w + x) * 4;
        out[dst] = raster.data[so]; out[dst + 1] = raster.data[so + 1];
        out[dst + 2] = raster.data[so + 2]; out[dst + 3] = raster.data[so + 3];
      }
    }
    return { data: out, width: w, height: h };
  }

  /**
   * 用图例里抠出来的图标当模板，**逐个到地图上找地点**。
   * 模板来自图例 → 干净、无遮挡、底色统一（带遮罩的 NCC 只比图标像素）✓
   * 尺度未知 → 给一串尺度（图例图标和地图上的大小可能差一倍以上）。
   * 结果直接写进每件物品的格子；同一个格子只归一件物品（先到先得）。
   */
  async function locateLegendItems() {
    const I2 = window.MurdokuItems;
    const list = (MH.ui.legendItems || []).filter(it => it.patch && it.mask);
    if (!I2 || !list.length) { MH.toast('还没有图例图标模板：先点「从图例自动列出物品」', 'warn'); return; }
    const st = MH.store.state;
    if (!st.bg) { MH.toast('还没有底图', 'warn'); return; }
    if (!requireAligned(st)) return;
    let geo;
    try { geo = await regionGeometry(); } catch (err) { MH.toast(err.message, 'warn'); return; }
    if (!geo) { MH.toast('底图尺寸异常', 'warn'); return; }
    // 图例和地图在同一页（同一份 PDF 的同一页）时，把图例那一块排除掉，别把图例本身当物品
    const exclude = [];
    const lp = MH.ui.legendPage;
    if (lp && st.bg && st.bg.w && Math.abs(lp.w - st.bg.w) / st.bg.w < 0.35) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const it of list) {
        x0 = Math.min(x0, it.icon.x); y0 = Math.min(y0, it.icon.y);
        x1 = Math.max(x1, it.icon.x + it.icon.w); y1 = Math.max(y1, it.icon.y + it.icon.h);
      }
      if (isFinite(x0)) exclude.push({ x: x0 - 40, y: y0 - 60, w: x1 - x0 + 80, h: y1 - y0 + 120 });
    }
    const scales = [0.6, 0.75, 0.9, 1, 1.15, 1.35, 1.6, 1.9, 2.3, 2.8, 3.4];
    const t0 = Date.now();
    MH.toast('正在逐件到地图上找（' + list.length + ' 件）…', 'ok');
    const claimed = new Set();
    st.items.forEach(it => it.cells.forEach(k => claimed.add(k)));
    const report = [];
    let LAST_MS = 0;                                // 上一件耗时（显示在进度提示里，便于看慢在哪 ✓）
    const yieldFrame = () => new Promise(r => setTimeout(r, 0));
    MH.ui.locating = true;
    MH.ui.locateCancel = false;
    MH.render();
    try {
    for (let idx = 0; idx < list.length; idx++) {
      const it = list[idx];
      if (MH.ui.locateCancel) { MH.toast('已取消，剩下 ' + (list.length - idx) + ' 件没找', 'warn'); break; }
      // **逐件提示 + 让出一帧**：匹配是纯 JS 循环、会把界面冻住 ✗；
      // 让出一帧既能看到进度，也能点按钮取消 ✓
      MH.toast('找第 ' + (idx + 1) + '/' + list.length + ' 件：' + it.name +
        (idx ? '（上一件 ' + (LAST_MS >= 1000 ? Math.round(LAST_MS / 1000) + 's' : Math.round(LAST_MS) + 'ms') + '）' : '') + '…', 'ok');
      await yieldFrame();
      const tIt = Date.now();
      let res;
      try {
        res = I2.findSimilarFromTemplate(geo.raster, geo.geom, it.patch,
          // 跨尺度 + 画风差异，相关系数不会很高（实测真同类峰值 ~0.6~0.8），
          // 所以这里放宽到"相对峰值 0.8 以内"，并靠"先到先得 + 人工可改"兜底
          { mask: it.mask, scales, exclude, relMin: 0.8, margin: 0.12, minScore: 0.35 });
      } catch (err) { report.push({ name: it.name, hits: 0, msg: '出错：' + err.message }); continue; }
      // 把握不足就别乱填：宁可留空让用户手标，也不要给一堆错格子 ✗
      // （实测：大而高对比的物品峰值 ~0.64 且位置正确；找不准的物品峰值只有 ~0.5，
      //   勉强填出来的格子基本都是错的）
      const peak = res.stats ? res.stats.maxScore : 0;   // 早退（把握不足）时也带峰值 ✓
      if (res.ok && (peak < 0.55 || res.cells.length > 10)) {
        LAST_MS = Date.now() - tIt;
        report.push({ name: it.name, hits: 0, ms: LAST_MS, scale: res.stats.scale, peak,
          msg: peak < 0.55 ? '把握不足（峰值 ' + peak + '），建议手动点样例' : '匹配出 ' + res.cells.length + ' 格，太多了' });
        continue;
      }
      const cells = (res.ok ? res.cells : []).filter(k => !claimed.has(k));
      cells.forEach(k => claimed.add(k));
      const target = st.items.find(x => x.name === it.name);
      if (target && cells.length) {
        MH.store.commit('自动标地点：' + it.name, s2 => {
          const t2 = Core.item(s2, target.id);
          if (!t2) return;
          t2.cells = Core.dedupeCells(s2, cells);
          Core.claimCellsExclusively(s2, s2.items, t2.id, t2.cells);
        });
      }
      LAST_MS = Date.now() - tIt;
      report.push({ name: it.name, hits: cells.length, ms: LAST_MS, scale: res.ok ? res.stats.scale : null,
        msg: res.ok ? '' : (res.reason || '没找到') });
    }
    } finally {
      MH.ui.locating = false;
      MH.ui.locateCancel = false;
    }
    MH.ui.lastLocate = { items: list.length, report, ms: Date.now() - t0 };
    const found = report.filter(r => r.hits > 0);
    MH.render();
    MH.toast('自动找地点：' + found.length + '/' + report.length + ' 件找到（共 ' +
      found.reduce((a, r) => a + r.hits, 0) + ' 格，' + (Date.now() - t0) + 'ms）' +
      (found.length < report.length ? ' · 没找到的：' + report.filter(r => !r.hits).map(r => r.name).join('、') : '') +
      ' · 结果可在每件物品里手动加减',
      found.length ? 'ok' : 'warn');
  }

  async function runLegendAuto() {
    const Lg = window.MurdokuLegend;
    // 每个"没做成"的分支都要留下 MH.ui.lastLegend —— 否则外部（e2e / 探针）会一直等结果 ✗
    const giveUp = (why) => {
      MH.ui.lastLegend = { via: 'none', icons: 0, items: 0, names: [], headings: [], skipped: 0, unknowns: 0, reason: why };
      MH.toast(why, 'warn');
    };
    if (!Lg) { giveUp('图例模块没加载（js/legend.js）'); return; }
    const pins = (window.MurdokuSnipper && window.MurdokuSnipper.state && window.MurdokuSnipper.state.pins) || [];
    const Sn = window.MurdokuSnipper && window.MurdokuSnipper.state;
    const isPdf = !!(Sn && Sn.file && /pdf/i.test(Sn.file.type || Sn.file.name || ''));
    if (!pins.length && !isPdf) {
      giveUp('还没有图例：在右侧「PDF 摘录」导入图例那一页（PDF 最好，能直接读文字层）');
      return;
    }
    let out = null, via = '';
    // ① 首选：PDF 文字层（名字 + 坐标 + 说明都是现成的，最稳）
    if (isPdf) {
      try {
        MH.toast('正在读 PDF 文字层…', 'ok');
        out = await readLegendByPdf();
        if (out && out.raster) {
          const rects = cardRectsForPage(out.raster);
          const whole = out;                       // 整页结果留作最后的兜底
          let restricted = null;
          if (rects.length && out.rawItems) {
            // 用户框了图例 → **以卡片框为准**（以前是"整页够 2 件就不看框" ✗，等于忽略用户的操作）
            restricted = Lg.legendFromText(out.rawItems, out.raster, { rects });
            restricted.raster = out.raster;
            restricted.page = out.page;
            restricted.rawItems = out.rawItems;
            // **但"先按卡片裁掉文字再解析"会丢上下文** ✗：实测 car-repair 框住图例后
            // 只剩 Oil Slick/Car/Chair/TV（第二组整组丢、TV 极性也错），整页解析却是 7/7 ✓。
            // 所以再算一份"整页解析 + 按卡片筛物品"，谁给得多用谁 ✓
            // 收不收这件：看**框与卡片的重叠比例**（文字层给的框可能跨过卡片边界，
            // 只看中心点会把刚好压线的整件丢掉 ✗ —— TV 就这么丢过）
            const inCard = (b) => !!b && rects.some(r => {
              const ox = Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x);
              const oy = Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y);
              if (ox <= 0 || oy <= 0) return false;
              return (ox * oy) / (b.w * b.h) > 0.3;
            });
            const wholeInCard = {
              items: whole.items.filter(it => inCard(it.icon) || inCard(it.nameBox)),
              headings: whole.headings, skipped: whole.skipped || [],
              raster: out.raster, page: out.page, rawItems: out.rawItems,
            };
            // 优先用"整页解析 + 按卡片筛"（上下文完整、过滤更可靠 ✓）；
            // 它不足 2 件时才用"先裁文字再解析"的结果 ✓
            const better = wholeInCard.items.length >= 2 ? wholeInCard
              : (restricted.items.length >= 2 ? restricted : null);
            if (better) {
              out = better;
              via = 'pdf+card';
            } else if (whole.items.length >= 2) {
              // 卡片里实在没有成件的图例（框太小/框偏了）→ 用整页并提示 ✓
              MH.toast('卡片框里没找到成件的图例（框太小或框偏了？）→ 已按整页列出', 'warn');
              out = whole;
              via = 'pdf';
            }
          }
          const base = out;
          const needCardRows = rects.length && (base.items.length < whole.items.length || whole.items.length < 2);
          if (needCardRows) {
            // 只有"整页文字层也没有名字"（contest 那种）才走卡片切分 + OCR ✓；
            // 整页明明有名字，只是卡片没框到 → 用整页结果并提示，别去猜（猜出来是乱码 ✗）
            // 文字层里没有物品名（contest 就是这样）→ 在卡片框里按**行投影 + 列投影**切分：
            // 先分出"图标排 / 名字排"，再用名字排当骨架（名字之间空隙明显，切得准），
            // 每个名字正上方那一段墨水的外接框 = 该物品的图标 ✓ 多排图例也能处理 ✓
            MH.toast('这张图的图例物品没有文字名，改按"排 + 列"切分…', 'ok');
            const boxes = [], headBoxes = [];
            for (const r2 of rects) {
              const parsed = Lg.readCardLegend(out.raster, r2);
              boxes.push(...parsed.items);
              headBoxes.push(...parsed.headings);
            }
            // 文字层给了说明行就用它；没有就把图片上那几条"说明带"OCR 出来判 ✓
            let heads = out.headings || [];
            if (!heads.length && headBoxes.length) {
              const texts = await ocrBoxes(out.raster, headBoxes);
              heads = headBoxes.map((b, i) => {
                const cls = window.MurdokuLegend.classifyLabel(texts[i]);
                return { x: b.x, y: b.y, w: b.w, h: b.h, text: texts[i], occupiable: cls === 'yes' ? true : cls === 'no' ? false : null };
              });
            }
            // 只保留"落在某条说明行下方"的图标带（地图上的杂图案不在这些带里 ✓）
            const nearHead = b => {
              if (!heads.length) return true;
              const cy2 = b.box.y + b.box.h / 2;
              return heads.some(h => cy2 > h.y && cy2 < h.y + Math.max(600, h.h * 40));
            };
            const kept = boxes.filter(b => nearHead(b));
            const use = kept.length >= 2 ? kept : boxes;
            // 名字：每个名字框单独 OCR（比"整条名字行一起 OCR"准得多 ✓ —— 一行几个名字时
            // 整条丢给 OCR 会认成一串乱码）
            const names = await ocrBoxes(out.raster, use.map(b => b.nameBox || { x: 0, y: 0, w: 1, h: 1 }));
            if (use.length >= 2) {
              const cardItems = occupiableByHeads(use.map((b, i) => ({
                name: names[i] || '',
                occupiable: null,
                icon: b.box,
                nameBox: b.nameBox || null,
              })), heads);
              // **并进 base**（不能替换 ✗）：contest 的文字层只有说明没有名字，
              // 名字全靠这里的 OCR ✓；car-repair 则是文字层已经全了，这里只做补充 ✓
              const key = n => String(n || '').replace(/\s+/g, '').toLowerCase();
              const have = new Set(base.items.map(it => key(it.name)).filter(Boolean));
              const extra = cardItems.filter(it => {
                if (!it.name || have.has(key(it.name))) return false;
                // OCR 碎片（"oo" 这种两个字母的）不要
                if (String(it.name).replace(/[^A-Za-z]/g, '').length < 3) return false;
                // 同一个物品在两个来源里的框会有出入（文字层给的是文字块、OCR 给的是墨迹框），
                // 所以按**框重叠**判重（重叠 > 较小框的一半 = 同一件 ✓），名字只作辅助 ✓
                const boxes = [it.icon, it.nameBox].filter(Boolean);
                const overlap = (a, b2) => {
                  if (!a || !b2) return 0;
                  const ox = Math.min(a.x + a.w, b2.x + b2.w) - Math.max(a.x, b2.x);
                  const oy = Math.min(a.y + a.h, b2.y + b2.h) - Math.max(a.y, b2.y);
                  if (ox <= 0 || oy <= 0) return 0;
                  return (ox * oy) / Math.min(a.w * a.h, b2.w * b2.h);
                };
                return !base.items.some(b2 => boxes.some(bx => overlap(bx, b2.icon) > 0.5 || overlap(bx, b2.nameBox) > 0.5));
              });
              const merged = base.items.length ? base.items.concat(extra) : cardItems;
              if (merged.length > base.items.length || base.items.length < 2) {
                out = {
                  items: merged,
                  headings: (heads && heads.length ? heads : base.headings) || [],
                  skipped: base.skipped || [], raster: base.raster, page: base.page,
                  method: 'card-rows',
                };
                via = base.items.length >= 2 ? base.via || 'pdf+card' : 'card-rows';
              }
            }
          }
          if (out.items.length < 1 && !restricted && whole.items.length) {
            out = whole;                           // 框内什么都没找到 → 退回整页
            via = 'pdf';
          }
          if (out.items.length && via === '') via = 'pdf';
          // 卡片是按用户意图定义范围的：框小了就只列框内的 ✓（不再偷偷换成整页结果）
          if (rects.length && out.items.length && out.items.length < whole.items.length) {
            MH.toast('按卡片框列出 ' + out.items.length + ' 件（整页有 ' + whole.items.length + ' 件）；框大一点可以多列', 'ok');
          }
        } else if (out && out.items.length) via = 'pdf';
      } catch (err) { MH.toast('读 PDF 文字层失败：' + err.message, 'warn'); }
    }
    // ② 其次：图例卡片（截图来源）→ 切分 + OCR
    if (!out || !out.items.length) {
      if (!pins.length) {
        giveUp('这张图例没有文字层，也还没有卡片：框选图例做成卡片再试');
        return;
      }
      let raster;
      try { raster = await legendCardRaster(); } catch (err) { MH.toast(err.message, 'error'); return; }
      if (!raster) { giveUp('读不到图例卡片'); return; }
      // **优先用词级 OCR**：直接读出说明行和每个物品名的真实框 ✓
      // 读不出来（没引擎/字太小）再退回"行投影分排 + 列投影猜名字框"
      MH.toast('正在识别图例文字…', 'ok');
      let ocrRes = null;
      try {
        ocrRes = await readCardLegendByOcr(raster, { x: 0, y: 0, w: raster.width, h: raster.height });
      } catch (err) { MH.toast('文字识别失败，改按版面切分：' + err.message, 'warn'); }
      if (ocrRes && ocrRes.items.length >= 2) {
        out = {
          items: occupiableByHeads(ocrRes.items, ocrRes.headings),
          headings: ocrRes.headings.map(h => ({ text: h.text, occupiable: h.occupiable })),
          skipped: [],
          // **必须带上 raster** ✗→✓：图例模板（`patch`）是从它裁的，
          // 少了它 `legendItems` 里 patch/mask 全是 null →「📍 自动找地点」一件也匹配不了 ✗
          raster,
        };
        via = 'image-ocr';
      } else {
      MH.toast('正在切分图例卡片…', 'ok');
      let parsed;
      try {
        // rowRatio 0.4：截图里的图例面板自带底色纹理，行墨量掉不到很低，
        // 用默认 0.18 会把"图标排 + 名字排"粘成一块（实测只剩 5 件）
        parsed = Lg.readCardLegend(raster, { x: 0, y: 0, w: raster.width, h: raster.height }, { rowRatio: 0.4 });
      } catch (err) { giveUp('切分失败：' + err.message); return; }
      const heads = [];
      if (parsed.headings.length) {
        MH.toast('识别说明行…', 'ok');
        const texts = await ocrBoxes(raster, parsed.headings);
        parsed.headings.forEach((b, i) => {
          const cls = Lg.classifyLabel(texts[i]);
          if (cls !== 'unknown') heads.push({ x: b.x, y: b.y, w: b.w, h: b.h, text: texts[i], occupiable: cls === 'yes' });
        });
      }
      const use = parsed.items;
      if (use.length < 2) { giveUp('这张卡片上没切出成排的图标（试试框紧一点，只框图例那一块）'); return; }
      MH.toast('识别物品名…', 'ok');
      const rawNames = await ocrBoxes(raster, use.map(b => b.nameBox || { x: 0, y: 0, w: 1, h: 1 }));
      // 名字出来后再过一道"像不像物品名"：说明段落/OCR 碎片（"A" / "fae" / "2"）挡掉 ✓
      const looksLikeName = t => {
        const s2 = String(t || '').trim();
        if (!s2) return false;
        if (s2.split(/\s+/).length > 3 || /[.,;:!?…]/.test(s2)) return false;
        return s2.replace(/[^A-Za-z]/g, '').length >= 2;
      };
      const names = rawNames.map(t => (looksLikeName(t) ? t : ''));
      out = {
        raster,
        items: occupiableByHeads(use.map((b, i) => ({
          name: names[i] || '',
          occupiable: null,
          icon: b.box,
          nameBox: b.nameBox || null,
        })), heads),
        headings: heads.map(h => ({ text: h.text, occupiable: h.occupiable })),
        skipped: [],
      };
      via = 'image';
      }
    }
    const unknown = out.items.filter(i => i.occupiable === null || i.occupiable === undefined).length;
    // **按名字去重**：同一个图例点两次不该建出两套物品 ✗（用户改了名字再点会更乱）。
    // 已有同名物品 → 只更新"可占据"（**保留用户手填的格子**）；没有才新建 ✓
    const keyOf = n => String(n || '').replace(/\s+/g, '').toLowerCase();
    let made = 0, updated = 0, renamed = 0;
    MH.store.commit('从图例自动列出物品', st => {
      const byName = new Map();
      st.items.forEach(x => { const k2 = keyOf(x.name); if (k2 && !byName.has(k2)) byName.set(k2, x); });
      const unnamed = st.items.filter(x => /^物品\s*\d+/.test(String(x.name || '')));
      let unnamedIdx = 0;
      out.items.forEach((it, i) => {
        const want = (it.name || '').trim();
        let target = want ? byName.get(keyOf(want)) : null;
        if (!target && !want && unnamedIdx < unnamed.length) target = unnamed[unnamedIdx++];
        if (target) {
          const occ = it.occupiable === false ? false : true;
          if (target.occupiable !== occ) { target.occupiable = occ; updated++; }
          if (!want && /^物品\s*\d+/.test(String(target.name || ''))) { /* 占位名保持不变 */ }
          if (want && target.name !== want) { target.name = want; renamed++; }
          return;
        }
        const nm = want || ('物品 ' + (i + 1) + '（请改名）');
        Core.createItem(st, nm, [], it.occupiable === false ? false : true);
        made++;
      });
    });
    const page = out.raster || null;
    MH.ui.legendPage = out.page || null;
    MH.ui.legendItems = out.items.map(it => ({
      name: it.name, occupiable: it.occupiable, icon: it.icon || null,
      patch: (page && it.icon) ? cropPatch(page, it.icon) : null,
      mask: it.icon && it.icon.mask ? it.icon.mask : null,
    }));
    MH.ui.lastLegend = {
      via, icons: out.items.length, groups: (out.headings || []).length,
      items: made, names: out.items.map(i => i.name),
      occupiable: out.items.map(i => i.occupiable),
      headings: (out.headings || []).map(h => h.text + (h.occupiable === false ? '（不可）' : h.occupiable ? '（可）' : '')),
      skipped: (out.skipped || []).length, unknowns: unknown,
    };
    MH.render();
    const viaText = via === 'pdf' ? 'PDF 文字层' : via === 'pdf+card' ? '卡片框 + PDF 文字层'
      : via === 'card-icons' ? '卡片框内按图标切分（没有文字名，请改名）'
      : via === 'image-ocr' ? '截图文字识别' : '卡片版面切分';
    MH.toast('从图例列出 ' + made + ' 件物品（' + viaText + (updated ? ' · 更新了 ' + updated + ' 件的可占据' : '') + '）' +
      ((out.headings || []).length ? '：分组说明 ' + MH.ui.lastLegend.headings.join(' / ') : '') +
      (unknown ? ' · 有 ' + unknown + ' 件读不出分组，先都按"可占据"，请在物品列表里改' : '') +
      ' · 格子留空，点每件的「从样例找同类」补地点',
      unknown ? 'warn' : 'ok');
  }

  /**
   * 把"找同类"的结果放进草稿：**已经有物品草稿就追加进去**（编辑中 / 新建中都算），
   * 没有才新建草稿 ✓
   * 之前这里无条件 `startDraft('item')` —— 编辑某件物品时点「从样例找同类」会
   * 丢掉当前编辑、另起一个新物品 ✗（用户实测反馈）
   * @returns {{added:number,total:number,reused:boolean}}
   */
  function applySampleToDraft(cells) {
    const d = MH.ui.draft;
    if (d && d.kind === 'item') {
      const before = d.cells.size;
      cells.forEach(k => d.cells.add(k));
      return { added: d.cells.size - before, total: d.cells.size, reused: true };
    }
    startDraft('item');
    MH.ui.draft.cells = new Set(cells);
    return { added: cells.length, total: cells.length, reused: false };
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
        // 会话内留着：区域名要从 PDF 的文字层读（精确、免费）
        MH.bgPdfFile = file;
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

  // ---------------------------------------------------------------- 自动对位（P0）

  /** 把底图数据解码成像素，供识别使用（存档里的底图 ≤1600px，几何识别够用） */
  async function bgRaster() {
    if (!MH.store.bgData) throw new Error('底图数据不在内存里，请重新导入');
    const img = await loadDataUrl(MH.store.bgData);
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height);
    return { data: d.data, width: d.width, height: d.height };
  }

  /**
   * 自动对位：在底图上找出网格 → 换算成 bg.scale 与网格偏移 → 一次提交（可撤销）。
   * @param {{x:number,y:number,w:number,h:number}} [rectRatio]
   *        相对底图左上角、以底图显示尺寸为单位的框选比例（省略则整张图找）
   */


  /**
   * 按「地图外框」定标 —— 主路径，不需要任何识别。
   * 框的左上角 = 网格原点，框宽 ÷ 列数 = 格距 X，框高 ÷ 行数 = 格距 Y。
   * 用整幅跨度算格距，框边差 1~2px 摊到每格可以忽略；行列数来自题面（手填），
   * 所以整条路没有任何"猜"的成分。
   */
  async function applyBoxGeometry(rectRatio) {
    const A2 = window.MurdokuAlign;
    if (!A2) { MH.toast('几何模块没加载（js/align.js）', 'error'); return; }
    const st = MH.store.state;
    if (!st.bg) { MH.toast('还没有底图', 'warn'); return; }
    if (!(st.rows > 0) || !(st.cols > 0)) { MH.toast('先在左侧填好行 / 列并生成地图', 'warn'); return; }
    let raster;
    try { raster = await bgRaster(); } catch (err) { MH.toast(err.message, 'warn'); return; }
    const W = raster.width, H = raster.height;
    const box = { x: rectRatio.x * W, y: rectRatio.y * H, w: rectRatio.w * W, h: rectRatio.h * H };
    const pitchX = box.w / st.cols;
    const pitchY = box.h / st.rows;
    if (!(pitchX > 4) || !(pitchY > 4)) { MH.toast('框太小了，重新框一次', 'warn'); return; }
    const place = A2.suggestPlacement(
      { ok: true, pitch: { x: pitchX, y: pitchY }, origin: { x: box.x, y: box.y }, confidence: 1 },
      { cellSize: st.settings.cellSize, srcW: W, srcH: H, bgW: st.bg.w, bgH: st.bg.h,
        scaleMin: Core.BG_SCALE_MIN || 0.1, scaleMax: Core.BG_SCALE_MAX || 4 });
    if (!place.ok) { MH.ui.alignInfo = '外框定标超出范围'; MH.render(); MH.toast(place.message, 'warn'); return; }
    MH.store.commit('按地图外框定标', s2 => {
      Core.updateBackground(s2, { scale: place.scale, bound: true });
      Core.setGridOffset(s2, place.gridX, place.gridY);
    });
    const pct = Math.round(place.scale * 1000) / 10;
    MH.ui.alignInfo = '格距 ' + pitchX.toFixed(1) + '/' + pitchY.toFixed(1) + 'px · 缩放 ' + pct + '%';
    MH.render();
    const skew = pitchX / pitchY;
    MH.toast('已按外框定标：' + st.cols + ' 列 × ' + st.rows + ' 行，格距 ' + pitchX.toFixed(1) + '×' +
      pitchY.toFixed(1) + 'px → 缩放 ' + pct + '%' +
      (Math.abs(skew - 1) > 0.12 ? '（格子明显不是方的：行列数是不是填反了？）' : ''), 'ok');
  }

  /**
   * 异步动作的保险丝：异步函数里抛异常会变成 unhandled rejection，
   * 表现就是"点了按钮什么都没发生"（识别区域那次静默崩溃就是这么被漏掉的）。
   */
  function guard(fn) {
    return async (...args) => {
      try { await fn(...args); }
      catch (err) {
        MH.toast('操作出错：' + (err && err.message ? err.message : String(err)), 'error');
      }
    };
  }

  /**
   * 由当前对位参数算出"每格在底图上的像素矩形"。
   * 场景里：网格左上角相对底图左上角偏移 = grid.x/grid.y（显示 px），
   * 底图显示宽度 = boardLayout().bgW；所以 原图像素 = 显示 px × (原图宽 / 显示宽)。
   */
  async function regionGeometry() {
    const st = MH.store.state;
    const raster = await bgRaster();
    const lay = Core.boardLayout(st);
    if (!(lay.bgW > 0) || !(lay.bgH > 0)) return null;
    const sx = raster.width / lay.bgW, sy = raster.height / lay.bgH;
    const gx = lay.gridLeft - lay.bgLeft, gy = lay.gridTop - lay.bgTop;
    return {
      raster,
      geom: {
        x0: gx * sx, y0: gy * sy,
        pitchX: st.settings.cellSize * sx, pitchY: st.settings.cellSize * sy,
        cols: st.cols, rows: st.rows,
      },
    };
  }

  /**
   * 识别用的"图片区域" —— 由 regionGeometry() 的网格矩形直接推出（四周放宽 0.2 格）。
   * 手画的「地图外框」只负责**定标**（算格距与原点），定完就退场：
   * 之后不管怎么微调网格、改格子大小、裁切底图，区域都自动跟着走，不会再"框一次就固定住"。
   */
  function regionArea(geo) {
    const L2 = window.MurdokuLabels;
    if (L2 && L2.areaBox) return L2.areaBox(geo.geom);
    const g = geo.geom;
    return { x: g.x0, y: g.y0, w: g.cols * g.pitchX, h: g.rows * g.pitchY };
  }

  /** 缓存里的标签是按"上一次的框"筛的：对齐变过就按当前区域重筛一遍 */
  function filterLabels(labels, box) {
    const L2 = window.MurdokuLabels;
    if (!L2 || !L2.inBox) return labels || [];
    return (labels || []).filter(l => L2.inBox(l, box));
  }

  /** 网格矩形压在底图上的比例（挡住"网格根本不在图上就点识别"） */
  function gridOnBg(geo) {
    const g = geo.geom, W = geo.raster.width, H = geo.raster.height;
    const w = g.cols * g.pitchX, h = g.rows * g.pitchY;
    if (!(w > 0) || !(h > 0)) return 0;
    const ix = Math.max(0, Math.min(g.x0 + w, W) - Math.max(g.x0, 0));
    const iy = Math.max(0, Math.min(g.y0 + h, H) - Math.max(g.y0, 0));
    return (ix * iy) / (w * h);
  }

  /** 识别的共同前提：网格已经对到底图上（框过、裁过、或在「对齐底图」里手动对过） */
  function requireAligned(st) {
    if (!st.bg.bound) {
      MH.toast('底图还没对位（区域卡里点「🩺 识别自检」能看到细节）：' +
        '① 点「▭ 框地图外框」拖一个矩形圈住地图，或 ② 勾「对齐底图」手动对准后退出', 'warn');
      return false;
    }
    return true;
  }

  /**
   * 识别结果的"指纹"：名字、颜色、格子、id 任一被手动改过都会变。
   * 面板只在"原封没动"时才敢直接替换，否则先问一句。
   */
  function regionKey(reg) {
    return reg.id + '|' + reg.name + '|' + reg.color + '|' + (reg.cells || []).join(',');
  }

  /**
   * 上一次识别出来的区域是否"原封没动"（指纹一致，也没人挂关联）。
   * 是的话重新识别就直接替换，不必每次弹确认 —— "对好网格再识别一次"正是最常用的循环。
   */
  function detectionUntouched(st) {
    const last = MH.ui.lastDetect;
    if (!last || !last.length || last.length !== st.regions.length) return false;
    const ids = new Set(st.regions.map(r => r.id));
    if (st.people.some(p => (p.links || []).some(l => l.kind === 'region' && ids.has(l.id)))) return false;
    return st.regions.every((r, i) => regionKey(r) === last[i]);
  }

  const LABEL_KEY = 'murdoku-helper.v1.labels';
  /**
   * 缓存键 = 底图名 + 尺寸 + **一小段像素指纹**。
   * 只用"名字@宽"的话，**同名同宽的另一张图**会命中旧缓存（正是这类过期键把好数据挡住）；
   * 指纹让它必然落到不同的键上。底图被裁切/换页后 bgData 变了 → 键也变 → 自动失效 ✓
   */
  function labelCacheKey(st) {
    const b = st.bg || {};
    const data = MH.store && MH.store.bgData ? MH.store.bgData : '';
    let fp = 0;
    if (data) {
      const step = Math.max(1, Math.floor(data.length / 256));   // 采样 256 个字符，够区分不同图
      for (let i = 0; i < data.length; i += step) {
        fp = ((fp ^ data.charCodeAt(i)) * 16777619) >>> 0;
      }
    }
    return (b.name || '') + '@' + (b.w || 0) + 'x' + (b.h || 0) + '#' + fp.toString(36);
  }

  function readLabelCache(st) {
    try {
      const raw = localStorage.getItem(LABEL_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj && obj.key === labelCacheKey(st) && Array.isArray(obj.labels) ? obj.labels : null;
    } catch (_) { return null; }
  }

  function writeLabelCache(st, labels) {
    try {
      localStorage.setItem(LABEL_KEY, JSON.stringify({ key: labelCacheKey(st), labels }));
    } catch (_) { /* 存不下就算了，下次再选一次 PDF */ }
  }

  /**
   * 从 PDF 文字层读"区域名"。区域名是画在地图上的全大写短标签
   * （RECEPTION / WAITING AREA / STORAGE / TEACHER'S AREA …），
   * 拿到它同时得到三样东西：**区域个数 k、区域名字、每个名字落在哪一格（种子）**。
   */
  async function readRegionLabels(file, geom, box) {
    if (!file || !window.MurdokuLabels) return [];
    await MH.ensurePdfLib();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({ data }).promise;
    const st = MH.store.state;
    const pageNo = Math.min(doc.numPages, Math.max(1, (st.bg && st.bg.page) || 1));
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    // 与 bgData 同尺度（bg.w 就是底图栅格宽）
    const scale = ((st.bg && st.bg.w) || 1600) / base.width;
    const vp = page.getViewport({ scale });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const str = (it.str || '').trim();
      if (!str) continue;
      const pt = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      items.push({ str, x: pt[0], y: pt[1], h: Math.abs(it.transform[3]) * scale });
    }
    if (doc.destroy) doc.destroy();
    return window.MurdokuLabels.pickRegionLabels(items, box, {
      maxSize: 0.6 * Math.min(geom.pitchX, geom.pitchY),
    });
  }

  /**
   * 找区域名 —— **一个按钮内部按输入类型自动选路**（用户不需要知道是 PDF 还是截图）：
   *   ① 本地缓存（上一次读到的名字）
   *   ② PDF 文字层（有句柄时最准，能拿真名）
   *   ③ 截图：找"区域名标签徽章"（白底药丸 + 黑描边 + 黑字）拿位置 → 内置 OCR 读名字
   *
   * 判断顺序有个硬条件：**候选名字必须能落到 ≥2 个种子上**才采用。
   * 这条是踩坑之后加的：缓存里如果只剩 1 条（过期/之前用别的图存进去的），
   * 老逻辑会直接拿它当唯一来源 → 种子只有 1 个 → 退化成"无种子"，整张图碎成十几块，
   * 而图上明明有 17 个标签可用（用户实测遇到的正是这个）。
   */
  async function resolveLabels(st, geo) {
    const L2 = window.MurdokuLabels;
    const cached = readLabelCache(st) || [];
    const seedCount = ls => {
      if (!L2 || !ls || !ls.length) return 0;
      return L2.labelsToSeeds(ls, geo.geom).length;
    };
    if (seedCount(cached) >= 2) return { labels: cached, from: 'cache' };

    if (MH.bgPdfFile) {
      try {
        const area = regionArea(geo);
        const ls = await readRegionLabels(MH.bgPdfFile, geo.geom, area);
        if (seedCount(ls) >= 2) { writeLabelCache(st, ls); return { labels: ls, from: 'pdf' }; }
      } catch (_) { /* 读不到就走截图路线 */ }
    }

    let badges = [];
    if (L2 && L2.findLabelBadges) {
      const pitch = Math.min(geo.geom.pitchX, geo.geom.pitchY);
      badges = L2.findLabelBadges(geo.raster, pitch);
      MH.ui.lastBadges = badges;
      MH.ui.lastBadgePitch = pitch;
    }
    if (badges.length >= 2) {
      const toLabels = names => badges.map((b, i) => ({
        name: (names && names[i]) || ('区域 ' + (i + 1)),
        x: b.x + b.w / 2, y: b.y + b.h / 2, h: b.h, badge: true,
      }));
      // 截图：顺手把名字也读出来（第一次要加载 7.8MB；失败就退回「区域 N」，不影响流程）
      if (window.MurdokuOCR && L2.mergeOcrNames) {
        MH.ui.ocrBusy = true;
        MH.render();
        try {
          const read = await window.MurdokuOCR.readBadges(geo.raster, badges, {
            onStatus: m => MH.toast(m, 'ok'),
            onProgress: (i, n) => { if (i % 4 === 0 || i === n) MH.toast('读区域名 ' + i + '/' + n, 'ok'); },
          });
          const names = L2.mergeOcrNames(read.map(r => ({ name: r.text, badge: r.badge })));
          MH.ui.ocrNames = names;
          const ls = toLabels(names);
          writeLabelCache(st, ls);
          return { labels: ls, from: 'ocr' };
        } catch (err) {
          MH.toast('OCR 没成功（' + (err && err.message ? err.message : err) + '），先用「区域 N」占位，可在列表里改名', 'warn');
        } finally {
          MH.ui.ocrBusy = false;
          MH.render();
        }
      }
      const ls = toLabels(null);
      if (seedCount(ls) >= 2) return { labels: ls, from: 'badge' };
    }
    // 都不够 2 个种子：有缓存就用缓存（1 个也比没有强），最后再退到徽章/空
    if (cached.length) return { labels: cached, from: 'cache' };
    if (badges.length) return {
      labels: badges.map((b, i) => ({ name: '区域 ' + (i + 1), x: b.x + b.w / 2, y: b.y + b.h / 2, h: b.h, badge: true })),
      from: 'badge',
    };
    return { labels: [], from: '' };
  }

  /**
   * 识别自检：**点不出结果时先点这个**。不做任何改动，只回答"卡在哪一步"：
   * 对位了吗、网格压在底图上多少、区域名能从哪来、种子有几个、识别内核怎么说。
   */
  async function regionSelfCheck() {
    const st = MH.store.state;
    const L2 = window.MurdokuLabels;
    const L = ['=== 识别自检 ==='];
    if (!st.bg) {
      L.push('底图：没有。先「＋ 导入图片或 PDF」。');
      MH.ui.diagText = L.join('\n'); MH.render(); return;
    }
    const b = st.bg;
    L.push('底图：' + b.name + ' · ' + b.kind + ' · ' + b.w + '×' + b.h +
      (b.kind === 'pdf' ? '（第 ' + b.page + '/' + b.pages + ' 页）' : ''));
    L.push('已对位（bound）：' + (b.bound ? '是 ✓' : '**否 ✗**'));
    if (!b.bound) {
      L.push('  → 这一步没做，点「自动识别区域」只会提示、不会动手。两条路任选：');
      L.push('    ① 点「▭ 框地图外框」，拖一个矩形正好圈住地图（最快，自动算格距）');
      L.push('    ② 勾「对齐底图」手动把网格拖准 → **退出对齐模式即自动记录对位**');
    }
    L.push('网格：' + st.cols + '×' + st.rows + ' · 每格 ' + st.settings.cellSize + 'px · 底图缩放 ' +
      Math.round(b.scale * 1000) / 10 + '% · 偏移 (' + (st.grid ? st.grid.x : 0) + ',' + (st.grid ? st.grid.y : 0) + ')');
    let geo = null;
    try { geo = await regionGeometry(); } catch (err) { L.push('几何换算失败：' + err.message); }
    if (geo) {
      const ratio = gridOnBg(geo);
      L.push('网格压在底图上的比例：' + (ratio * 100).toFixed(0) + '%' + (ratio < 0.6 ? ' ✗（要 ≥60%，说明网格基本不在图上）' : ' ✓'));
      L.push('格距（原图像素）：' + geo.geom.pitchX.toFixed(1) + ' × ' + geo.geom.pitchY.toFixed(1) +
        (Math.min(geo.geom.pitchX, geo.geom.pitchY) < 6 ? ' ✗（太小了，行列数是不是填多了？）' : ''));
      const cached = readLabelCache(st) || [];          // 与 resolveLabels 一致：不按框二次过滤
      const badges = L2 && L2.findLabelBadges ? L2.findLabelBadges(geo.raster, Math.min(geo.geom.pitchX, geo.geom.pitchY)) : [];
      MH.ui.lastBadges = badges.length ? badges : MH.ui.lastBadges;
      L.push('区域名从哪来：');
      const cachedSeeds = cached.length && L2 ? L2.labelsToSeeds(cached, geo.geom).length : 0;
      L.push('  · 本地缓存：' + (cached.length ? cached.length + ' 个（其中种子 ' + cachedSeeds + ' 个' +
        (cachedSeeds < 2 ? ' → 不够 2 个，会被忽略、改用下面的来源' : '') + '）' : '无'));
      L.push('  · PDF 文字层句柄：' + (MH.bgPdfFile ? '有（会优先用它）' : '无（没选过 PDF 文件）'));
      L.push('  · 截图标签徽章：' + (badges.length ? badges.length + ' 个 ✓（会自动 OCR 读名字）' : '没找到 ✗（区域名不是"白底黑字药丸"样式？）'));
      const seeds = L2 ? L2.labelsToSeeds(cached, geo.geom) : [];
      L.push('种子（用于分区的定位点）：' + (seeds.length || badges.length) + ' 个' +
        ((seeds.length || badges.length) >= 2 ? '' : ' ✗（少于 2 个就只能靠颜色自适应，结果会很碎）'));
      const R2 = window.MurdokuRegions;
      if (R2 && b.bound && ratio >= 0.6) {
        const t0 = Date.now();
        const dry = cached.length >= 2
          ? R2.detectRegions(geo.raster, geo.geom, { seeds: L2.labelsToSeeds(cached, geo.geom) })
          : R2.detectRegions(geo.raster, geo.geom, badges.length >= 2
            ? { seeds: L2.labelsToSeeds(badges.map((bd, i) => ({ name: '区域 ' + (i + 1), x: bd.x + bd.w / 2, y: bd.y + bd.h / 2 })), geo.geom) }
            : {});
        L.push('识别内核试跑：' + (dry.ok ? 'ok ✓' : '失败 ✗ 原因：' + (dry.reason || '未知')));
        if (dry.ok) {
          L.push('  会分出 ' + dry.regions.length + ' 个候选区域，覆盖 ' + dry.stats.sampled + '/' + (st.cols * st.rows) +
            ' 格 · ' + (Date.now() - t0) + 'ms' + (dry.stats.picked ? ' · 选中 ' + dry.stats.picked : ''));
        }
      } else {
        L.push('识别内核试跑：跳过（先把对位 / 网格位置弄好）');
      }
    }
    L.push('');
    L.push('现有区域：' + st.regions.length + ' 个' + (st.regions.length ? '（' + st.regions.map(r => r.name).join(' / ') + '）' : ''));
    MH.ui.diagText = L.join('\n');
    MH.render();
    MH.toast('自检完成：把下面的文字发我就能定位', 'ok');
  }

  /**
   * 边界诊断：把每条相邻边的实测数据摊成文本（可复制发我），
   * 用来**按这张地图自己的分布**定判据，而不是拍脑袋调阈值。
   */
  async function runRegionDiagnosis() {
    const R2 = window.MurdokuRegions;
    if (!R2 || !R2.diagnose) { MH.toast('诊断模块没加载', 'error'); return; }
    const st = MH.store.state;
    if (!st.bg) { MH.toast('还没有底图', 'warn'); return; }
    if (!requireAligned(st)) return;
    const geo = await regionGeometry();
    if (!geo) { MH.toast('底图尺寸异常', 'warn'); return; }
    if (gridOnBg(geo) < 0.6) { MH.toast('网格大部分落在底图外面，先把网格对准地图', 'warn'); return; }
    // 没有已识别的区域时，先自动跑一遍识别（否则诊断里缺"区域之间的边界"那几节）
    if (!MH.store.state.regions.length) {
      MH.toast('先跑一遍区域识别，再做诊断', 'ok');
      await detectRegionsFromBg();
    }
    const t0 = Date.now();
    const dg = R2.diagnose(geo.raster, geo.geom);
    const assign = new Map();
    for (const reg of MH.store.state.regions) for (const k of reg.cells) assign.set(k, reg.name || '区域');
    let text = R2.formatDiagnosis(dg, assign);
    // 附上"标签 → 落在哪一格"：整体错位（例如整块偏一行）多半是种子格算错了，
    // 这几行能一眼看出来
    let labels = (await resolveLabels(MH.store.state, geo)).labels;
    if (labels.length) {
      const rows2 = ['格 → 种子：'];
      for (const l of labels) {
        const cell = window.MurdokuLabels.labelToCell(l, geo.geom);
        const cell2 = window.MurdokuLabels.labelToCell(
          { x: l.x, y: l.y + geo.geom.pitchY * 0.5 }, geo.geom);   // 视觉中心大约在基线下半格
        rows2.push(' "' + l.name + '" @(' + Math.round(l.x) + ',' + Math.round(l.y) + ') 字号 ' +
          Math.round(l.h) + ' → 基线格 ' + (cell ? '(' + cell.r + ',' + cell.c + ')' : '框外') +
          ' · 视觉中心格 ' + (cell2 ? '(' + cell2.r + ',' + cell2.c + ')' : '框外'));
      }
      text = text + '\n\n' + rows2.join('\n');
    }
    MH.ui.diagText = text;
    MH.render();
    MH.toast('诊断完成：' + dg.edges.length + ' 条相邻边 · ' + (Date.now() - t0) + 'ms · 点「复制」发我', 'ok');
  }

  /**
   * 有了"名字 + 位置"（labels）就跑一遍区域识别并落库。
   * PDF 文字层 / 截图标签徽章 / OCR 读出的名字都走这里，落库策略完全一致。
   */
  async function detectWithLabels(geo, labels, source) {
    const R = window.MurdokuRegions;
    const st = MH.store.state;
    const t0 = Date.now();
    const seeds = labels.length && window.MurdokuLabels
      ? window.MurdokuLabels.labelsToSeeds(labels, geo.geom) : [];
    // 有种子 → 种子约束的候选+打分+局部搜索；没有 → 回到颜色/粗线自适应
    const res = R.detectRegions(geo.raster, geo.geom, seeds.length >= 2 ? { seeds } : {});
    if (!res.ok) { MH.toast('没认出区域：' + (res.reason || '未知原因'), 'warn'); return; }
    const made = (res.regions || []).filter(r2 => r2.cells && r2.cells.length);
    if (!made.length) { MH.toast('没认出区域：结果为空，原有区域未改动', 'warn'); return; }
    // 再点一次识别 = **重新出一份候选**，不是追加。老区域必须先清掉：一个格子只属于一个区域，
    // 追加的话新区域会被 claimCellsExclusively 摘空 —— 就是"点两次出 6 个、其中 3 个 0 格"。
    // 只有在上一次的结果被动过（改过名/加过格子/挂过关联）时才问一句。
    const existing = st.regions.length;
    if (existing && !detectionUntouched(st) &&
        !confirm('已有 ' + existing + ' 个区域（可能手动改过）：识别会重建区域，原来的区域与它们的人物关联会被替换。\n继续？（可 ⌘Z 撤销）')) return;
    MH.store.commit('识别区域', s2 => {
      for (const reg of s2.regions.slice()) Core.deleteRegion(s2, reg.id);
      made.forEach((r2, i) => Core.createRegion(s2, r2.name || ('区域 ' + (i + 1)), r2.cells));
      s2.regions.forEach((reg, i) => { reg.color = made[i].color; });    // 用识别到的颜色，一眼能对上底图
    });
    // 记下这次的结果指纹：下次再点识别时用来判断"原封没动"（动过就先问一句）
    MH.ui.lastDetect = MH.store.state.regions.map(regionKey);
    MH.toast('识别出 ' + made.length + ' 个候选区域' +
      (seeds.length >= 2 ? '（按图上的区域名：' + labels.map(l => l.name).join(' / ') + '）' : '') +
      (existing ? '（替换了上一次的 ' + existing + ' 个）' : '') +
      ' · ' + res.stats.sampled + ' 格 · ' + (Date.now() - t0) + 'ms · 不满意可 ⌘Z 撤销', 'ok');
    void source;
  }

  /** 自动识别区域：产出候选后**一次提交**（可撤销），用户再手工增删改 */
  async function detectRegionsFromBg() {
    const R = window.MurdokuRegions;
    if (!R) { MH.toast('区域识别模块没加载（js/regions.js）', 'error'); return; }
    const st = MH.store.state;
    if (!st.bg) { MH.toast('还没有底图', 'warn'); return; }
    if (!requireAligned(st)) return;
    let geo;
    try { geo = await regionGeometry(); } catch (err) { MH.toast(err.message, 'warn'); return; }
    if (!geo) { MH.toast('底图尺寸异常', 'warn'); return; }
    if (gridOnBg(geo) < 0.6) { MH.toast('网格大部分落在底图外面，先把网格对准地图', 'warn'); return; }
    // ① 找区域名（PDF 文字层 / 截图标签徽章 / 本地缓存）→ 给出 k 个种子
    //    （读不到名字会退化成"无种子"，区域会碎成几十块——所以下面必须明确提示，不能静默降级）
    const resolved = await resolveLabels(st, geo);
    const labels = resolved.labels;
    if (resolved.from === 'cache') {
      MH.toast('这次用的是上次记住的 ' + labels.length + ' 个区域名（不对可在区域卡点「清除记忆」重来）', 'ok');
    }
    if (resolved.from === 'ocr') {
      MH.toast('截图路线：找到 ' + labels.length + ' 个区域名标签，OCR 读出的名字：' + labels.map(l => l.name).join(' / '), 'ok');
    } else if (resolved.from === 'badge') {
      MH.toast('这是截图：找到 ' + labels.length + ' 个区域名标签，名字先用「区域 1…」，可在左侧改名', 'ok');
    }
    if (!labels.length && st.bg.kind === 'pdf') {
      MH.toast('读区域名需要再选一次这份 PDF（只需一次，之后会记住）', 'ok');
      const inp = document.getElementById('labelFileInput');
      if (inp) { MH.ui.awaitLabels = geo; inp.click(); return; }
    }
    if (!labels.length) {
      MH.toast('没找到区域名：截图请确认区域名是"白底黑字的标签"，或用「＋ 新建区域」手工圈', 'warn');
    }
    await detectWithLabels(geo, labels, resolved.from);
  }

  /** 视口坐标 → 底图比例（0..1，相对底图左上角与显示尺寸） */


  /**
   * 按格定标：识别不出来时的手工路径，比拖滑块准得多。
   * 依次点三下 —— ① 地图左上角格线交点 ② 它右边相邻的交点 ③ 它下边相邻的交点。
   * 三个点直接给出格距与原点，换算方式与自动对位完全一致。
   */




  /** 框选地图范围：在棋盘上拖一个矩形，只在该范围里找网格 */
  function pickRegion() {
    if (!MH.store.state.bg) { MH.toast('还没有底图', 'warn'); return; }
    MH.ui.picking = !MH.ui.picking;
    const box = document.getElementById('regionBox');
    if (box) box.hidden = true;
    document.body.classList.toggle('picking', MH.ui.picking);
    MH.toast(MH.ui.picking ? '拖一个矩形，正好圈住地图外框（再点按钮取消）' : '已取消框选',
      MH.ui.picking ? 'ok' : 'warn');
  }

  function initLabelPick() {
    const inp = document.getElementById('labelFileInput');
    if (!inp) return;
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.value = '';
      if (!f) return;
      MH.bgPdfFile = f;
      guard(detectRegionsFromBg)();
    });
  }

  function initRegionPick() {
    const board = document.getElementById('board');
    const box = document.getElementById('regionBox');
    const gb = document.getElementById('gridBox');
    if (!board || !box || !gb) return;
    let start = null;
    let startV = null;
    const local = (e) => {
      const r = board.getBoundingClientRect();
      return { x: e.clientX - r.left + board.scrollLeft, y: e.clientY - r.top + board.scrollTop };
    };
    const end = () => {
      start = null;
      MH.ui.picking = false;
      document.body.classList.remove('picking');
      box.hidden = true;
    };
    board.addEventListener('pointerdown', e => {
      if (!MH.ui.picking) return;
      start = local(e);
      startV = { x: e.clientX, y: e.clientY };
      box.hidden = false;
      box.style.left = start.x + 'px';
      box.style.top = start.y + 'px';
      box.style.width = '0px';
      box.style.height = '0px';
      try { board.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    board.addEventListener('pointermove', e => {
      if (!MH.ui.picking || !start) return;
      const p = local(e);
      box.style.left = Math.min(start.x, p.x) + 'px';
      box.style.top = Math.min(start.y, p.y) + 'px';
      box.style.width = Math.abs(p.x - start.x) + 'px';
      box.style.height = Math.abs(p.y - start.y) + 'px';
    });
    board.addEventListener('pointerup', e => {
      if (!MH.ui.picking || !start || !startV) return;
      const x0 = Math.min(startV.x, e.clientX), y0 = Math.min(startV.y, e.clientY);
      const w = Math.abs(e.clientX - startV.x), h = Math.abs(e.clientY - startV.y);
      end();
      if (w < 20 || h < 20) { MH.toast('框太小了，重新点「框选地图」再试', 'warn'); return; }
      // 视口坐标 → 场景坐标：gridBox 的 rect 就对应场景里的 gridLeft/gridTop
      const st = MH.store.state;
      const lay = Core.boardLayout(st);
      const rect = gb.getBoundingClientRect();
      const sx = lay.gridLeft + (x0 - rect.left);
      const sy = lay.gridTop + (y0 - rect.top);
      const fx = (sx - lay.bgLeft) / Math.max(1, lay.bgW);
      const fy = (sy - lay.bgTop) / Math.max(1, lay.bgH);
      const fw = w / Math.max(1, lay.bgW);
      const fh = h / Math.max(1, lay.bgH);
      const c01 = v => Math.max(0, Math.min(1, v));
      const rectRatio = { x: c01(fx), y: c01(fy), w: c01(Math.min(fw, 1 - c01(fx))), h: c01(Math.min(fh, 1 - c01(fy))) };
      if (rectRatio.w <= 0.02 || rectRatio.h <= 0.02) { MH.toast('框到底图外面了，重新框一次', 'warn'); return; }
      guard(applyBoxGeometry)(rectRatio);
    });
  }

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
    if (dirty && !confirm('重新生成地图会清空区域、物品、人物关联与所有标记（含候选），确定继续？\n\n底图和网格对位会保留。')) return;
    MH.ui.draft = null;
    // 生成的只是"题面"，底图（导入的图片 / PDF）与网格对位、显示偏好都保留，
    // 免得每次改行列出错就要重新导入、重新对齐一次
    const next = Core.createState(rows, cols);
    if (st.bg) next.bg = st.bg;
    if (st.grid) next.grid = { x: st.grid.x, y: st.grid.y };
    next.settings = Object.assign({}, next.settings, st.settings || {});
    MH.store.replace(next, '生成地图');
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
    'legend-auto'() { guard(runLegendAuto)(); },
    'legend-locate'() {
      if (MH.ui.locating) { MH.ui.locateCancel = true; MH.toast('已请求取消，等这一件找完就停', 'warn'); return; }
      guard(locateLegendItems)();
    },
    'item-sample'() {
      if (!MH.store.state.bg) { MH.toast('还没有底图', 'warn'); return; }
      if (!requireAligned(MH.store.state)) return;
      MH.ui.itemPicking = !MH.ui.itemPicking;
      document.body.classList.toggle('picking', MH.ui.itemPicking);
      MH.toast(MH.ui.itemPicking
        ? '请在棋盘上点一个格子当样例（同类格子会加到当前物品）'
        : '已取消取样', MH.ui.itemPicking ? 'ok' : 'warn');
      MH.render();
    },
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
    'bg-region'() { pickRegion(); },
    'detect-regions'() { guard(detectRegionsFromBg)(); },
    'diag-regions'() { guard(runRegionDiagnosis)(); },
    'check-regions'() { guard(regionSelfCheck)(); },
    'clear-labels'() {
      try { localStorage.removeItem(LABEL_KEY); } catch (_) { /* 清不掉也不影响 */ }
      MH.ui.lastBadges = null;
      MH.toast('已忘掉记住的区域名，下次点识别会重新读（截图会重新 OCR）', 'ok');
      MH.render();
    },
    'diag-close'() { MH.ui.diagText = null; MH.render(); },
    'diag-copy'() {
      const t = MH.ui.diagText || '';
      if (!t) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(
          () => MH.toast('已复制，粘贴发我即可', 'ok'),
          () => MH.toast('复制失败：请手动选中文本复制', 'warn'));
      } else MH.toast('请手动选中文本复制', 'warn');
    },
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
      const was = MH.ui.aligning;
      MH.ui.aligning = !MH.ui.aligning;
      MH.ui.draft = null;
      // 退出对齐模式 = 这次对齐到此为止：记下 bound（识别区域与后续缩放都以此为前提），
      // 这样"只靠对齐网格"这条路径不需要再画一次外框就能开始识别
      if (was && !MH.ui.aligning && MH.store.state.bg && !MH.store.state.bg.bound) {
        MH.store.commit('记录对齐', s => Core.updateBackground(s, { bound: true }));
        MH.toast('已记下这次对齐（之后改格子大小，底图与网格一起缩放）', 'ok');
      }
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

  // ---------------------------------------------------------------- 侧栏宽度

  const SIDEBAR_KEY = 'murdoku-helper.v1.ui';
  const SIDEBAR_MIN = 300;      // 再窄卡片就挤了
  const SIDEBAR_DEFAULT = 372;

  function sidebarMax() {
    // 给棋盘留出至少 360px，窗口很窄时不至于把棋盘压没
    return Math.max(SIDEBAR_MIN, Math.min(760, window.innerWidth - 360));
  }

  function currentSidebarWidth() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w');
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : SIDEBAR_DEFAULT;
  }

  function applySidebarWidth(w, save) {
    const next = Math.round(Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, w)));
    document.documentElement.style.setProperty('--sidebar-w', next + 'px');
    if (save) {
      try { window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ sidebarW: next })); } catch (e) { /* 隐私模式忽略 */ }
    }
    return next;
  }

  function readSidebarWidth() {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_KEY);
      const v = raw ? JSON.parse(raw) : null;
      if (v && Number.isFinite(v.sidebarW)) return v.sidebarW;
    } catch (e) { /* ignore */ }
    return SIDEBAR_DEFAULT;
  }

  function initSidebarResizer() {
    const bar = document.getElementById('sidebarResizer');
    if (!bar) return;
    applySidebarWidth(readSidebarWidth(), false);

    bar.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startW = currentSidebarWidth();
      bar.classList.add('dragging');
      const move = ev => applySidebarWidth(startW + (ev.clientX - startX), false);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        bar.classList.remove('dragging');
        applySidebarWidth(currentSidebarWidth(), true);   // 松手才落盘
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    bar.addEventListener('dblclick', () => applySidebarWidth(SIDEBAR_DEFAULT, true));
    bar.addEventListener('keydown', e => {
      const step = e.shiftKey ? 40 : 12;
      if (e.key === 'ArrowLeft') { e.preventDefault(); applySidebarWidth(currentSidebarWidth() - step, true); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); applySidebarWidth(currentSidebarWidth() + step, true); }
      else if (e.key === 'Home') { e.preventDefault(); applySidebarWidth(SIDEBAR_MIN, true); }
      else if (e.key === 'End') { e.preventDefault(); applySidebarWidth(sidebarMax(), true); }
    });
  }

  const P = {
    init() {
      initSidebarResizer();
      initRegionPick();
      initLabelPick();
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
      // 正在编辑的那一项：把它滚进视野（编辑界面就展开在这一行下面）
      const editingLi = document.querySelector('.list li.editing');
      if (editingLi && editingLi.scrollIntoView) {
        try { editingLi.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老浏览器忽略 */ }
      }
      const largest = document.querySelector('[data-act="draft-largest"]');
      if (largest && d.kind === 'region') {
        const cells = [...d.cells];
        largest.style.display = (!Core.isConnected(cells) && cells.length) ? '' : 'none';
      }
    },
    /** 棋盘上点了一个样例格（board.js 调进来） */
    itemSample(k) { guard(pickItemSample)(k); },
    /** 从图例自动列出物品（也供 e2e 直接调） */
    legendAuto: () => guard(runLegendAuto)(),
    /** 用图例图标逐件到地图上找地点 */
    legendLocate: () => guard(locateLegendItems)(),
  };

  MH.panels = P;
  // 右侧「PDF 摘录」悬浮窗（js/snipper.js）复用同一套 pdf.js 加载与渲染
  MH.ensurePdfLib = ensurePdfLib;
  MH.renderPdfPage = renderPdfPage;
  MH.registerRenderer(st => P.render(st));
})();

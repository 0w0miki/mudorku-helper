/*! Mudorku Helper — 线索解析（纯函数，Node 可单测）
 *
 * 目标：把题目里"某个人的说明文字"解析成结构化线索 ✓
 *   输入：一段线索文本 + 当前的物品名/区域名清单（来自图例识别或手工）
 *   输出：{ kind, target, polarity, text }
 *     kind = 'in'        "He was in a car."            → 人在那件物品/那个区域里 ✓
 *          = 'beside'    "He was beside a shelf."      → 人在它旁边 ✓
 *          = 'not-beside' "…are not beside the ○"      → 不在旁边 ✗
 *          = 'none'      认不出（正文、规则说明、无关句子…）✓
 *
 * 为什么先做这一步：解析规则是整条链路里唯一"可以拿真实文本反复验证"的部分 ✓，
 * 识别（文字层/OCR）与交互都在它之上 ✓。
 */
(function (root) {
  'use strict';

  // 关系词（按"越长越具体"排，先匹配长的那条 ✓）
  const REL_WORDS = [
    { re: /(?:are|is|was|were|am)\s+not\s+beside/i, kind: 'not-beside' },
    { re: /\bnot\s+beside\b/i, kind: 'not-beside' },
    { re: /\bnot\s+next\s+to\b/i, kind: 'not-beside' },
    { re: /\b(?:are|is|was|were)\s+(?:sitting\s+|standing\s+)?beside\b/i, kind: 'beside' },
    { re: /\bbeside\b/i, kind: 'beside' },
    { re: /\bnext\s+to\b/i, kind: 'beside' },
    { re: /\badjacent\s+to\b/i, kind: 'beside' },
    // "was alone in the Waiting Area" ✓ —— 中间会插 alone/also/still 这类词 ✓
    { re: /\b(?:are|is|was|were)\s+(?:alone|also|still|then|just|directly)?\s*(?:in|on|at|inside)\b/i, kind: 'in' },
    { re: /\b(?:sitting|standing|lying|walking|sleeping)\s+(?:in|on|at)\b/i, kind: 'in' },
    { re: /\b(?:are|is|was|were)\s+(?:directly\s+)?(?:north|south|east|west|left|right|above|under|below)\s+of\b/i, kind: 'in' },
    // "was near / by X" = 邻近 ✓（当成 beside 更贴近语义 ✓）
    { re: /\b(?:are|is|was|were)\s+(?:near|by)\b/i, kind: 'beside' },
    { re: /\b(?:lived|lies|lay|sat|sits|stood|stands)\s+(?:in|on|at|by|near)\b/i, kind: 'in' },
    // golf 这类题："occupy a tee / the flag"、"within a sand pit" 都是"在那一格" ✓
    { re: /\b(?:occupie[sd]?|occupying|occupy)\b/i, kind: 'in' },
    { re: /\b(?:are|is|was|were)\s+within\b/i, kind: 'in' },
    { re: /\bwithin\b/i, kind: 'in' },
    { re: /\b(?:are|is|was|were)\s+inside\b/i, kind: 'in' },
    // **裸介词兜底** ✓：一句话里第二个地点常常没有动词短语
    // （"…in a chair **in the front area**" ✗ → 只靠动词短语会漏掉后半句 ✓）
    // 这些放在最后 ✓：具体句式先匹配 ✓，同一条关联按 (kind,目标) 去重 ✓
    { re: /\b(?:beside|next to|near)\b/i, kind: 'beside' },
    { re: /\b(?:inside|within|in)\b/i, kind: 'in' },
    { re: /\b(?:on|at|under|above|below)\b/i, kind: 'in' },
    { re: /\bin\s+(?:the\s+)?(?:top|bottom|first|second|third|fourth|fifth|last)\s+(?:row|column)\b/i, kind: 'in' },
  ];

  // 页脚署名：真线索偶尔会和它被切并成一块 ✗ —— 从"puzzle by/art by…"起截掉 ✓
  const CREDIT = /\b(?:puzzle (?:and concept )?by|art by|graphic design by|playtesters?|more at|murdoku\.com|clue:)\b/i;

  // 非线索：规则/说明/页眉页脚那种 ✓（宁可不认，也不要写错 ✗）
  const NOT_CLUE = [
    /one person per row/i, /what does .?beside.? mean/i, /to the left, right/i,
    /as soon as you/i, /block their entire/i, /exactly one/i, /rule:/i,
    /murdoku/i, /^art by/i, /puzzle and concept/i, /^playtesters/i,
    /puzzle by/i, /graphic design by/i,
    // 线索陈述是平铺直叙的 ✓；带括号的通常是版面上的说明文字 ✗
    // （family 那版混进来的 "the book (for teens and adults!) chair in the bottom row." ✗）
    /[()\[\]{}]/,
  ];

  const blockWidth = b => (b && b.w != null ? b.w : 40);

  // 线索都是"**某个人**在做/在某处" ✓ —— 句首要有人称主语
  // （实测真线索全是 "He was…" / "She was…" ✓；版面碎片的句首是 "chair in the bottom row." ✗
  //   "WHO WAS IN THE TOP ROW?" ✗。先量过"上方有没有头像" ✗ —— 整页都是插画，
  //   伪线索的密度 0.41~0.63 与真线索重叠 ✓，只有这条主语判据分得开 ✓）
  const SUBJECT = /^(?:he|she|they|it|i|the victim|the person|the culprit|the murderer|someone|somebody|there|the\s+[a-z]+)\b/i;

  // 人名不可能是这些词开头（He was / The Caricature / What happened / She was… ✗）
  const NAME_STOP = /^(he|she|it|they|the|a|an|what|who|where|when|there|this|that|and|or|but|if|as|in|on|at|for|with|by|to|of|is|are|was|were|can|could|do|does|did|no|not|one|two|three|read|find|rule|can)\b/i;

  const norm = s => String(s == null ? '' : s)
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const letters = s => String(s || '').replace(/[^A-Za-z]/g, '');

  /**
   * 把"带字体标注的文字块"整理成纯文本 + **加粗片段**（题目里物品名/关系词是加粗的 ✓）
   * PDF 文字层里加粗是**独立的文字块、字体与正文不同** ✓ —— 实测：
   *   "He was on an"(f1) + "oil slick."(f2) + "beside"(f2) + "a"(f1) + "shelf"(f2)
   * 字体名是 g_d0_f2 这种子集名，所以判据是"与这一块的正文字体不同" ✓
   * @param {Array<{text:string, font?:string, bold?:boolean}>} runs
   * @returns {{text:string, bolds:string[]}}
   */
  function readRuns(runs) {
    const list = (runs || []).filter(r => r && norm(r.text));
    if (!list.length) return { text: '', groups: [], bold: false };
    const text = list.map(r => norm(r.text)).join(' ').replace(/\s+/g, ' ').trim();
    // 按字体分组（字体名是 g_d0_f2 这种子集名，不能靠名字判"Bold" ✗）
    const byFont = new Map();
    for (const r of list) {
      const f = r.font == null ? '' : String(r.font);
      byFont.set(f, (((byFont.get(f) || '') + ' ' + norm(r.text)).replace(/\s+/g, ' ').trim()));
    }
    return {
      text,
      groups: [...byFont].map(([font, t]) => ({ font, text: t })),
      bold: list.some(r => r.bold === true),
    };
  }

  /**
   * 列出文本里**所有**被提到的物品/区域名（带位置 ✓）
   * 用于"关系词后面最近的那个才是目标" ✓
   */
  function findTargets(text, names) {
    const t = ' ' + norm(text).toLowerCase() + ' ';
    const out = [];
    for (const n of (names || [])) {
      if (!n || !n.name || letters(n.name).length < 2) continue;
      const parts = norm(n.name).toLowerCase().split(/\s+/).filter(Boolean)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (!parts.length) continue;
      const re = new RegExp('(^|[^a-z])' + parts.join('\\s+') + '(s|es)?([^a-z]|$)', 'i');
      const m = re.exec(t);
      if (m) out.push({ name: n.name, kind: n.kind, id: n.id == null ? null : n.id, at: m.index, len: letters(n.name).length });
    }
    return out;
  }

  /**
   * 在文本里找"被提到的物品/区域名"。
   * **长的优先** ✓（"Oil Slick" 要胜过 "Slick" ✗ —— 这是实际踩过的坑）
   * @param {string} text
   * @param {Array<{name:string, kind:'item'|'region', id?:string}>} names
   */
  function findTarget(text, names) {
    const t = ' ' + norm(text).toLowerCase() + ' ';
    const cands = (names || [])
      .filter(n => n && n.name && letters(n.name).length >= 2)
      .sort((a, b) => letters(b.name).length - letters(a.name).length);
    for (const n of cands) {
      // **空格要保留** ✗→✓：以前用"只留字母"去比，把 "Oil Slick" 变成 "oilslick"，
      // 而文本里写的是 "oil slick" → 永远匹配不上（于是只认出了 "Slick" ✗）
      const parts = norm(n.name).toLowerCase().split(/\s+/).filter(Boolean)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (!parts.length) continue;
      const raw = parts.join('\\s+');
      // 允许词形变化：名字后面可以跟 s/es（shelf→shelves 这种不规则先不管 ✓）
      const re = new RegExp('(^|[^a-z])' + raw + '(s|es)?([^a-z]|$)', 'i');
      if (re.test(t)) return { name: n.name, kind: n.kind, id: n.id == null ? null : n.id };
    }
    return null;
  }

  /**
   * 解析一段线索 ✓
   * @returns {{kind:string, target:object|null, polarity:number|null, text:string, reason:string}}
   */
  function parse(text, names, opts) {
    const opt = opts || {};
    const t = norm(text);
    const out = { kind: 'none', target: null, polarity: null, text: t, reason: '', bold: null };
    if (!t || letters(t).length < 4) { out.reason = '太短'; return out; }
    // 先把署名截掉 ✓（切块时偶尔会把页脚署名并进线索 ✗）—— **要在"规则文字"判断之前** ✗→✓，
    // 否则"真线索 + 署名"会整块被当成说明文字丢掉 ✗（实测踩过）
    const cut = t.search(CREDIT);
    const body = cut >= 0 ? t.slice(0, cut).trim() : t;   // 开头就是署名（cut===0）也要切 ✓
    if (letters(body).length < 4) { out.reason = '只有署名/说明文字'; return out; }
    // **句子必须有人称主语** ✓：真线索都是"He was… / She was…" ✓，
    // 而版面碎片的句首是 "chair in the bottom row." ✗、"WHO WAS IN THE TOP ROW?" ✗
    // （先量过"上方有没有头像" ✗ —— 整页都是插画，伪线索密度 0.41~0.63 与真线索重叠 ✓，
    //   这条主语判据才是真正分得开的 ✓）
    if (!SUBJECT.test(t)) { out.reason = '句首没有人称主语（像版面碎片）'; return out; }
    for (const bad of NOT_CLUE) {
      if (bad.test(body)) { out.reason = '规则/说明文字，不是线索'; return out; }
    }
    // **截断的残句不要** ✗：结尾落在介词/冠词/be 动词上，说明句子被切开了 ✓
    // （实测 family 里 "She was sitting in a" ✗ 与完整那句 "…in a chair in the front area." ✓
    //   重复 ✓ —— 残句被当成第二条线索 ✓）
    if (/\b(?:a|an|the|in|on|at|beside|of|to|with|by|and|or|is|was|were|are|be)\s*[.!?]?$/i.test(body)) {
      out.reason = '句子被截断（结尾是介词/冠词）';
      return out;
    }
    let kind = null;
    for (const r of REL_WORDS) { if (r.re.test(body)) { kind = r.kind; break; } }
    if (!kind) { out.reason = '没看到"在/在…旁边"这类关系词'; return out; }
    // 目标：**关系词后面最近的那个名字** ✓
    // （"She was sitting in a chair in the front area." 的关系词是 sitting in ✓ → 目标是 Chair ✓；
    //   以前"最长名字优先"会选成 FRONT AREA ✗ —— 那是第二个介词短语 ✓）
    const bodyCands = findTargets(body, names);
    // 关系词结束的位置（"…sitting in **a chair**" ✓ → 取它后面最近的名字 ✓）
    let relEnd = -1;
    for (const r of REL_WORDS) {
      const m = r.re.exec(body);
      if (m && (relEnd < 0 || m.index + m[0].length < relEnd)) relEnd = m.index + m[0].length;
    }
    let target = null;
    // ① **加粗/字体组优先** ✓（PDF 里物品名是独立字体块 ✓，最准 ✓；组内取最长的那一个 ✓）
    for (const g of (opt.groups || [])) {
      const hits = findTargets(g.text, names);
      if (!hits.length) continue;
      // 组里若也提到了多个名字 ✓，同样取"离关系词最近"的那个 ✓
      // （family 那条线索的加粗组里同时有 chair 与 front area ✗ → 用最长会选错 ✓）
      const gAt = body.toLowerCase().indexOf(norm(g.text).toLowerCase());
      const base = gAt >= 0 ? gAt + Math.max(0, relEnd) : -1;
      const best = hits.slice().sort((a, b) =>
        (base >= 0 ? (Math.abs(a.at + base - relEnd) - Math.abs(b.at + base - relEnd)) : 0) || (b.len - a.len))[0];
      target = { name: best.name, kind: best.kind, id: best.id };
      out.bold = g.text;
      break;
    }
    // ② 正文：取"离关系词最近"的那个 ✓
    //    （"She was sitting in a chair in the front area." → Chair ✓，不是 FRONT AREA ✗）
    if (!target && bodyCands.length) {
      const near = bodyCands.slice().sort((a, b) =>
        (Math.abs(a.at - relEnd) - Math.abs(b.at - relEnd)) || (b.len - a.len));
      target = { name: near[0].name, kind: near[0].kind, id: near[0].id };
    }
    // 有关系但没匹配到目标：**保留 kind** ✓（调用方据此提示"先补物品" ✓），但不给 target ✓
    if (!target) { out.reason = '没匹配到已列出的物品/区域名'; out.kind = kind; return out; }
    out.kind = kind;
    out.text = body;                       // 线索原文按"去掉署名"的版本返回 ✓
    out.target = target;
    // 极性："不/没有"就是负相关 ✗→✓
    // （"He was **not** sitting in a chair." 以前判成正相关 ✗ —— 这是会误导游玩的错 ✓）
    const neg = /\b(?:not|never|n't)\b/i.test(body);
    out.polarity = (kind === 'not-beside' || neg) ? -1 : 1;
    if (out.polarity === -1) out.negated = true;
    return out;
  }

  /**
   * 把一段文字**按句子切开** ✓。
   * 为什么必须切：切块时相邻两个气泡会粘在一起 ✗ —— 一句里"关系词"和"目标"可能来自
   * 不同的句子（"He was beside a desk. He was not sitting in a chair." 会配成 beside+Chair ✗）。
   * 逐句解析才能保证关系与目标同源 ✓，也才能把两句线索各算一条 ✓。
   */
  function splitClauses(text) {
    let t = norm(text);
    const cut = t.search(CREDIT);
    if (cut >= 0) t = t.slice(0, cut).trim();      // 页脚标注（clue:/puzzle by…）连尾巴一起去掉 ✓
    if (!t) return [];
    return t.split(/(?<=[.!?;])\s+/).map(x => x.trim()).filter(Boolean);
  }

  /**
   * **行优先**版面分析（OCR 逐词框专用 ✓）
   * 为什么不用逐对连边：词框的 y 有 ±5~10px 抖动 ✗，逐对判定会把一句话切碎 ✓
   * （实测 142 个词被切成 75 块 ✗ → 一条线索都认不出 ✗）。
   * 步骤：① 按 y 宽容差归行 ✓ → ② 行内按"大空隙"切段（气泡内词距小 ✓）→
   *      ③ 段按"竖向相邻 + 横向重叠"归块 ✓
   */
  function clusterLines(items, opts) {
    const opt = opts || {};
    const list = (items || []).filter(it => it && norm(it.text)).map((it, i) => ({
      i, text: norm(it.text), x: it.x, y: it.y,
      w: it.w == null ? Math.max(6, letters(it.text).length * 6) : it.w,
      h: it.h == null ? 12 : it.h, font: it.font, bold: it.bold,
    }));
    if (!list.length) return [];
    const hs = list.map(z => z.h).sort((a, b) => a - b);
    const medH = hs[hs.length >> 1] || 12;
    // ① 归行（宽容差 ✓）
    const lines = [];
    for (const it of list.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
      const ln = lines.find(l => Math.abs(l.y - it.y) <= Math.max(6, medH * (opt.lineTol == null ? 0.7 : opt.lineTol)));
      if (ln) { ln.items.push(it); ln.y = Math.min(ln.y, it.y); ln.y1 = Math.max(ln.y1, it.y + it.h); }
      else lines.push({ y: it.y, y1: it.y + it.h, items: [it] });
    }
    // ② 行内按大空隙切段 ✓
    const segs = [];
    for (const ln of lines) {
      ln.items.sort((a, b) => a.x - b.x);
      let cur = [ln.items[0]];
      const flush = () => {
        const f = cur[0], la = cur[cur.length - 1];
        segs.push({ y: Math.min.apply(null, cur.map(z => z.y)), y1: Math.max.apply(null, cur.map(z => z.y + z.h)),
          x: f.x, x1: la.x + la.w, items: cur.slice() });
      };
      for (let k = 1; k < ln.items.length; k++) {
        const gap = ln.items[k].x - (cur[cur.length - 1].x + cur[cur.length - 1].w);
        // **行内切段**的空隙阈值 ✓：段 = 同一列里的一小串词 ✓
        //
        // 这是个**有代价的旋钮** ✗（实测过 ✓）：
        //   · 调松（1.6 行高）→ 窄列沟（约 1.2~1.5 行高 ✓）会把**两列粘成一段** ✗（golf 实测 ✓）
        //   · 调紧（1.0 行高）→ 字距被拉宽的正文（两端对齐 ✓）会被**从中间切开** ✗，
        //     而**同行的段永远不会再合回去** ✓ → 一句完整的话被拆成碎片 → **整条线索丢掉** ✗
        //     （合成实测：词距 1.3 行高时，阈值 1.0 → 0 条 ✗、阈值 1.6 → 1 条 ✓）
        //
        // 因此**按来源给不同默认值** ✓：
        //   · OCR 逐词框（wordLevel ✓）：词距小、噪声大 ✓ → 1.0（宁可切开列 ✓，避免跨列粘连 ✓）
        //   · PDF 文字层 ✓：宽度精确、两端对齐常见 ✓ → 1.6（**别切坏句子** ✓）
        //
        // 真正的解法是"**按列沟检测**"（见文档 ✓）：沟是**跨多行重复出现的空白带** ✓，
        // 与绝对间隙无关 ✓ —— 那样就能既切准列、又不切坏句子 ✓。此处先按来源取值 ✓。
        const segGap = opt.segGap == null ? (opt.wordLevel ? 1.0 : 1.6) : opt.segGap;
        if (gap > Math.max(8, medH * segGap)) { flush(); cur = []; }
        cur.push(ln.items[k]);
      }
      if (cur.length) flush();
    }
    // ③ 段按"竖向相邻 + 横向重叠"归块 ✓
    const parent = segs.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        // **卡片分割线** ✓：用户框的卡片是一张一张的 ✓ —— 跨线的两段永不合并 ✓
        // （以前只靠"留白间隔" ✓，而间隔一旦小于"竖向相邻阈值"就会跨卡粘成一块 ✗，
        //  golf 实测三张卡的线索粘成一条 ✗ → 人名和文字对不上 ✓）
        if (opt.cuts && opt.cuts.length) {
          const mid = (Math.max(a.y, b.y) + Math.min(a.y1, b.y1)) / 2;
          const yA = a.y + (a.y1 - a.y) / 2, yB = b.y + (b.y1 - b.y) / 2;
          const crossed = opt.cuts.some(c => (yA - c) * (yB - c) < 0 || (mid && Math.abs(mid - c) < 1));
          if (crossed) continue;
        }
        const gapY = Math.max(0, Math.max(a.y - b.y1, b.y - a.y1));
        if (gapY > Math.max(8, medH * (opt.blockGap == null ? 1.8 : opt.blockGap))) continue;
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x, b.x);
        const narrow = Math.min(a.x1 - a.x, b.x1 - b.x);
        if (ox < narrow * 0.4) continue;
        if (looksLikePersonName(a.items.map(z => z.text).join(' ')) !==
            looksLikePersonName(b.items.map(z => z.text).join(' '))) continue;   // 人名单独成块 ✓
        union(a.i || i, b.i || j);
      }
    }
    // 组装（保持局部的阅读顺序 ✓）
    const groups = new Map();
    segs.forEach((sg, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(...sg.items);
    });
    const out = [];
    for (const arr of groups.values()) {
      const ls = [];
      for (const it of arr) {
        const ln = ls.find(l => Math.abs(l.y - it.y) <= Math.max(6, medH * 0.7));
        if (ln) ln.items.push(it); else ls.push({ y: it.y, items: [it] });
      }
      ls.sort((a, b) => a.y - b.y);
      const ordered = [];
      for (const ln of ls) ordered.push(...ln.items.slice().sort((a, b) => a.x - b.x));
      const byFont = new Map();
      for (const z of ordered) {
        const f = z.font == null ? '' : String(z.font);
        byFont.set(f, (((byFont.get(f) || '') + ' ' + z.text).replace(/\s+/g, ' ').trim()));
      }
      out.push({
        text: ordered.map(z => z.text).join(' ').replace(/\s+/g, ' ').trim(),
        x: Math.min.apply(null, ordered.map(z => z.x)),
        y: Math.min.apply(null, ordered.map(z => z.y)),
        w: Math.max.apply(null, ordered.map(z => z.x + z.w)) - Math.min.apply(null, ordered.map(z => z.x)),
        h: Math.max.apply(null, ordered.map(z => z.y + z.h)) - Math.min.apply(null, ordered.map(z => z.y)),
        runs: ordered.map(z => ({ text: z.text, font: z.font, bold: z.bold })),
        groups: [...byFont].map(([font, t]) => ({ font, text: t })),
      });
    }
    out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return out;
  }

  /**
   * 把**散点文字块**聚成"线索块"（②取字的核心 ✓）。
   * 为什么不做"先按 y 归行、再按 x 空隙切段" ✗：真实版面是**两列并排**的卡片 ✓，
   * 同一 y 上会横跨两张卡 ✗ —— 那样切出来的"行"跨列，一句话被撕成两半 ✗（实测 car-repair 只出 1/6 条）。
   * 改成**二维近邻聚类** ✓：只在"竖向接得上下"或"横向接得左右"时才连边 ✓，
   * 于是气泡里的话连成一块 ✓，不同卡片因为离得远而分开 ✓。
   * @param {Array<{text:string,x:number,y:number,w?:number,h?:number,font?:string,bold?:boolean}>} items
   */
  function cluster(items, opts) {
    const opt = opts || {};
    const list = (items || []).filter(it => it && norm(it.text))
      .map((it, i) => ({ i, text: norm(it.text), x: it.x, y: it.y,
        w: it.w == null ? Math.max(6, letters(it.text).length * 6) : it.w,
        h: it.h == null ? 12 : it.h, font: it.font, bold: it.bold }));
    // **人名单独进自己的块** ✓：并查集有传递性 —— 就算禁止"名字直接连线索"，
    // 名字-A-B-线索 这样的链也会把它们连成一块 ✗（实测 "Diane She was Waiting Area…"）。
    // 所以聚类时先把"像人名"的块拆出去 ✓，它们各自成块 ✓。
    const isName = it => looksLikePersonName(it.text);
    const parent = list.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    const gapX = (a, b) => Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
    const gapY = (a, b) => Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (isName(a) || isName(b)) continue;          // 人名不参与合并 ✓
        // 同行的 y 容差：OCR 的词框 y 抖动更大（实测能到 10px ✗）→ 放宽到 0.95 字高 ✓
        const sameLine = Math.abs(a.y - b.y) <= Math.max(opt.wordLevel ? 5 : 3,
          Math.min(a.h, b.h) * (opt.wordLevel ? 0.95 : 0.5));
        const lineGapX = gapX(a, b);
        // 竖向容差收紧到 0.6 字高 ✓：同一个气泡里的两行只隔 0.3~0.5 字高 ✓，
        // 而不同卡片/区域标签往往隔 1 个字高以上 → 不能连 ✗（1.2 就是把好几张卡连成一片的元凶）
        const stacked = gapY(a, b) <= Math.max(opt.wordLevel ? 6 : 4,
          Math.min(a.h, b.h) * (opt.gapY == null ? (opt.wordLevel ? 1.0 : 0.6) : opt.gapY));
        // 上下相邻：**必须真正同列** ✓ —— 要求横向重叠 ≥ 较窄那个的一半 ✓
        // （用"横向空隙小"会被斜着错开的碎片链式粘起来 ✗：实测把线索气泡和页脚粘成 664px 宽的一块 ✓）
        const oxSpan = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const narrow = Math.min(a.w, b.w);
        const colNear = oxSpan >= narrow * (opt.colOverlap == null ? 0.5 : opt.colOverlap);
        // 同一行：横向要挨着 ✓（隔很远的两张卡不能连 ✗）
        // 上下相邻：横向大致同列 ✓ 且**人名不跟线索连**（名字要单独成块 ✓）
        // 同行合并的空隙：**分来源** ✓
        //   · 文字层（PDF）：一个块往往就是一整段 ✓ → 收紧到 0.45 字高 ✓
        //     （放太松会把线索气泡和页脚链式粘起来 ✗，实测 664px 宽的一块 ✓）
        //   · OCR：给的是**逐词框** ✗ —— 词间距只有几个像素 ✓，用 0.45 字高会把每句都切碎 ✓
        //     （实测 142 个词被切成 75 块 ✗ → 一条线索都认不出 ✗）→ 放宽到 1.1 字高 ✓
        const sameLineRatio = opt.wordLevel ? 1.1 : 0.45;
        if (sameLine && lineGapX <= Math.max(opt.wordLevel ? 8 : 5, Math.min(a.h, b.h) * sameLineRatio)) { union(a.i, b.i); continue; }
        if (stacked && colNear) { union(a.i, b.i); continue; }
      }
    }
    const groups = new Map();
    for (const it of list) {
      const r = find(it.i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(it);
    }
    const blocks = [];
    for (const arr of groups.values()) {
      // **阅读顺序**：先按"行"归并（y 容差 ±0.6 字高 ✓），行内再按 x ✓
      // （OCR 每个词的 y 有几个像素的抖动 ✗ —— 直接按 y 排序会把同一行打乱：
      //   实测出现 "killer alone The with the was victim the in same ar" ✗）
      arr.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      const lines = [];
      for (const it of arr) {
        const ln = lines.find(l => Math.abs(l.y - it.y) <= Math.max(3, Math.min(l.h, it.h) * 0.6));
        if (ln) { ln.items.push(it); ln.y = Math.min(ln.y, it.y); }
        else lines.push({ y: it.y, h: it.h, items: [it] });
      }
      lines.sort((a, b) => a.y - b.y);
      const ordered = [];
      for (const ln of lines) ordered.push(...ln.items.slice().sort((a, b) => a.x - b.x));
      arr.length = 0;
      arr.push(...ordered);
      const x0 = Math.min.apply(null, arr.map(z => z.x));
      const x1 = Math.max.apply(null, arr.map(z => z.x + z.w));
      const y0 = Math.min.apply(null, arr.map(z => z.y));
      const y1 = Math.max.apply(null, arr.map(z => z.y + z.h));
      const text = arr.map(z => z.text).join(' ').replace(/\s+/g, ' ').trim();
      const byFont = new Map();
      for (const z of arr) {
        const f = z.font == null ? '' : String(z.font);
        byFont.set(f, (((byFont.get(f) || '') + ' ' + z.text).replace(/\s+/g, ' ').trim()));
      }
      blocks.push({ text, x: x0, y: y0, w: x1 - x0, h: y1 - y0, runs: arr.map(z => ({ text: z.text, font: z.font, bold: z.bold })),
        groups: [...byFont].map(([font, t]) => ({ font, text: t })) });
    }
    blocks.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return blocks;
  }

  /**
   * 端到端（纯部分 · 取字到解析）：散点文字 → 线索块 → 解析 → 线索候选 + 人名
   * @param {Array} items 带坐标的文字块（PDF 文字层或 OCR 词框 ✓）
   * @param {Array} names 已知物品/区域名
   */
  /**
   * **唯一的取字入口** ✓ —— 行优先版面分析（行 → 按大空隙切段 → 段竖向相邻归块 ✓）
   *
   * 为什么统一（2026-10-16）：PDF 走 `cluster`（逐对连边 ✗）、OCR 走 `clusterLines` ✓，
   * 两条路行为不一致 ✓ → 同类问题只在一侧出现，排查总要问"这次走哪条路" ✗。
   * 现在只有一条 ✓，差异只在阈值（`wordLevel` ✓）。
   *
   * 回归实测（三份真题 ✓）：
   * · car-repair：Diane 那条线索**变完整** ✓（"She was alone in the Waiting Area" ✓，
   *   旧路径截断成 "She was alone in the" ✗）
   * · familymurdoku：句子分块同样正常 ✓
   * · contest（6 条长条）：人名配对仍正确 ✓（Seraphina/Quincy/Rosalind/Ursula… ✓）
   */
  function readItems(items, names, opts) {
    const o = Object.assign({}, opts || {}, { blocks: true });
    return extract(clusterLines(items, o), names, o);
  }

  /** 兼容旧调用：OCR 来源 = 行优先 + 逐词框阈值 ✓（与 readItems 同一套算法 ✓） */
  function readOcrItems(items, names, opts) {
    return readItems(items, names, Object.assign({}, opts || {}, { wordLevel: true }));
  }

  /**
   * 把"一行行文字"归并成线索块（每块 = 一个人物卡上的那段话）。
   * 真实 PDF 的文字是流式的，同一张卡的句子可能被拆成好几行 ✓ 相邻一行合并 ✓；
   * 卡与卡之间通常有明显间距或换人 ✓。
   * @param {Array<{text:string, x?:number, y?:number, h?:number}>} lines
   * @param {{maxGapY?:number}} [opts]
   */
  function mergeBlocks(lines, opts) {
    const opt = opts || {};
    const list = (lines || [])
      .map(l => {
        if (!l) return null;
        // 行可以只给 runs（带字体 ✓）：文本从 runs 拼 ✓，加粗信息留着 ✓
        if (!norm(l.text) && Array.isArray(l.runs)) {
          const rr = readRuns(l.runs);
          return { text: rr.text, runs: l.runs, x: l.x == null ? 0 : l.x, y: l.y == null ? 0 : l.y,
            h: l.h == null ? 12 : l.h, w: l.w };
        }
        return { text: norm(l.text), runs: l.runs, x: l.x == null ? 0 : l.x, y: l.y == null ? 0 : l.y,
          h: l.h == null ? 12 : l.h, w: l.w };
      })
      .filter(l => l && l.text)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const blocks = [];
    const xGap = (bx, ln) => Math.max(0, Math.max(bx.x0 - (ln.x + (ln.w || 0)), ln.x - bx.x1));
    for (const ln of list) {
      // **在最近的几个开放块里找最合适的那个** ✓
      // （真实版面是**两列并排**的卡片 ✗ —— 只看"上一块"会被另一列插进来的行打断，
      //  结果一句线索被拆成两块、谁也认不出来 ✓）
      const limit = opt.maxGapY == null ? Math.max(8, ln.h * 2.2) : opt.maxGapY;
      let target = null, bestX = Infinity;
      for (let i = blocks.length - 1; i >= 0 && i >= blocks.length - 8; i--) {
        const bx = blocks[i];
        const gap = ln.y - bx.y1;
        if (gap < -2 || gap > limit) continue;               // 必须在它下面、且不隔太远 ✓
        if (looksLikePersonName(bx.text) && !looksLikePersonName(ln.text)) continue;   // 人名单独一块 ✓
        const gx = xGap(bx, ln);
        if (gx > Math.max(24, ln.h * 2)) continue;            // 横向要挨着（同一列）✓
        if (gx < bestX) { bestX = gx; target = bx; }
      }
      if (target) {
        target.lines.push(ln);
        target.text = (target.text + ' ' + ln.text).replace(/\s+/g, ' ').trim();
        target.y1 = Math.max(target.y1, ln.y + ln.h);
        target.x0 = Math.min(target.x0, ln.x);
        target.x1 = Math.max(target.x1, ln.x + (ln.w || 0));
      } else {
        blocks.push({ lines: [ln], text: ln.text, y0: ln.y, y1: ln.y + ln.h,
          x0: ln.x, x1: ln.x + (ln.w || 0) });
      }
    }
    return blocks;
  }

  /**
   * 从"文字行"里挑出人物名（1~2 个词、没有关系词、不是句子 ✓）
   * 真实题目里人物名就在头像卡上（car-repair 的 Anthony/Breck/Crystal… ✓）
   */
  function looksLikePersonName(text) {
    const t = norm(text);
    if (!t) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 2) return false;
    if (/[.,;:!?…]/.test(t.replace(/\.$/, ''))) return false;
    if (REL_WORDS.some(r => r.re.test(t))) return false;
    if (NOT_CLUE.some(re => re.test(t))) return false;
    const L = letters(t);
    if (L.length < 3) return false;
    if (t.length > 20) return false;                         // 人名不会是一长串 ✓
    if (NAME_STOP.test(t)) return false;                     // He was / The Caricature / What happened ✗
    if (L === L.toUpperCase()) return false;                 // 全大写 = 区域名 ✓
    if (!/^[A-Z]/.test(t)) return false;                     // 名字首字母大写 ✓
    return true;
  }

  /**
   * 这段文字**像不像线索陈述**（不要求里面有物品/区域 ✓）
   * 用户要求："整句都记录下来，不管有没有发现物品和区域的关联" ✓
   * —— 所以这里只挡"规则文字/署名/没有主语的碎片" ✓，其余（含"受害者说明"这类 ✓）都留下 ✓
   */
  function looksLikeClueStatement(text) {
    const t = norm(text);
    if (!t || letters(t).length < 6) return false;
    for (const bad of NOT_CLUE) if (bad.test(t)) return false;
    if (!SUBJECT.test(t)) return false;
    if (/^[^a-z]*(?:can't|cannot|can) be occupied/i.test(t)) return false;
    return true;
  }

  /**
   * 一句里可能提到**多个**目标 ✓：每个关系词配它后面最近的那个名字 ✓
   * 例："She was sitting in a chair in the front area." → `in Chair` + `in FRONT AREA` ✓（以前只出一条 ✗）
   *     "He was beside a desk. He was not sitting in a chair." → 两句各一条 ✓
   * @returns {Array<{kind,polarity,target,targetKind,targetId,bold,at}>}
   */
  function clauseLinks(clause, names, opts) {
    const opt = opts || {};
    let body = norm(clause);
    if (!body) return [];
    const cut = body.search(CREDIT);
    if (cut >= 0) body = body.slice(0, cut).trim();
    if (!body || letters(body).length < 4) return [];
    for (const bad of NOT_CLUE) if (bad.test(body)) return [];
    if (!SUBJECT.test(body)) return [];
    if (/\b(?:a|an|the|in|on|at|beside|of|to|with|by|and|or|is|was|were|are|be)\s*[.!?]?$/i.test(body)) return [];
    const neg = /\b(?:not|never|n't)\b/i.test(body);
    // 所有关系词的结束位置（按出现顺序 ✓）
    const rels = [];
    for (const r of REL_WORDS) {
      const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
      let m;
      while ((m = re.exec(body))) {
        rels.push({ kind: r.kind, end: m.index + m[0].length, at: m.index });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    rels.sort((a, b) => a.at - b.at);
    const namesRef = findTargets(body, names);
    if (!rels.length || !namesRef.length) return [];
    const used = new Set();
    const out = [];
    for (const r of rels) {
      // 该关系词后面最近、且还没被用掉的名字 ✓
      const after = namesRef
        .map((n, i) => ({ n, i, d: n.at - r.end }))
        .filter(x => x.d >= -2 && !used.has(x.i))
        .sort((a, b) => (Math.abs(a.d) - Math.abs(b.d)) || (b.n.len - a.n.len));
      if (!after.length) continue;
      const pick = after[0];
      used.add(pick.i);
      out.push({
        kind: r.kind, polarity: (r.kind === 'not-beside' || neg) ? -1 : 1,
        target: pick.n.name, targetKind: pick.n.kind, targetId: pick.n.id,
        bold: null, at: pick.n.at, text: body,
      });
    }
    return out;
  }

  /**
   * 端到端（纯部分）：给定文字行 + 名称清单 → **按"气泡"分组**的线索候选 ✓
   * 一个气泡 = 一个人的整段话 ✓ → 一行候选 ✓（内容整句记下来 ✓，里面能解析出的关联单独列出 ✓）
   * 为什么按气泡而不是按句子：用户要"整句都记录下来，不管有没有发现物品/区域的关联" ✓
   * —— 句子级会把无关的整句丢掉 ✗（Vaughn 的"受害者"说明、只有方向没有实物的线索… ✓）
   * @returns {{clues:Array, names:Array, skipped:Array, blocks:Array}}
   *   clues[i] = { text（整段原文 ✓）, person, x, y, links:[{kind,target,targetKind,targetId,polarity,bold}] }
   */
  function extract(lines, names, opts) {
    const already = opts && opts.blocks === true;
    const blocks = already ? (lines || []).filter(b => b && norm(b.text)) : mergeBlocks(lines, opts);
    const rows = [], personNames = [], skipped = [];
    for (const b of blocks) {
      const byFont = new Map();
      const fold = (g) => byFont.set(g.font, (((byFont.get(g.font) || '') + ' ' + g.text).replace(/\s+/g, ' ').trim()));
      if (Array.isArray(b.groups)) b.groups.forEach(fold);
      else for (const ln of (b.lines || [])) if (Array.isArray(ln.runs)) readRuns(ln.runs).groups.forEach(fold);
      const groupsAll = [...byFont].map(([font, text]) => ({ font, text }));
      const bx = Math.round(b.x != null ? b.x : b.x0);
      const by = Math.round(b.y != null ? b.y : b.y0);
      // 整段文字（把署名/页脚标注切掉 ✓）
      let whole = norm(b.text);
      const cut0 = whole.search(CREDIT);
      if (cut0 >= 0) whole = whole.slice(0, cut0).trim();
      // 段内逐句解析 → 收集**关联** ✓（一个都能没有 ✓ —— 那也照样记整句 ✓）
      const clauses = splitClauses(b.text);
      const links = [];
      for (const cl of clauses) {
        const key = norm(cl).replace(/\s+/g, ' ').toLowerCase();
        const gs = groupsAll.filter(g => key.includes(norm(g.text).toLowerCase()));
        // **一句里可能有多条关联** ✓（"…in a chair in the front area." → Chair + FRONT AREA ✓）
        const got = clauseLinks(cl, names, { groups: gs.length ? gs : groupsAll });
        for (const l of got) {
          // 先试加粗/字体组（PDF 里最准 ✓），否则用正文里就近的那个 ✓
          const g2 = (gs.length ? gs : groupsAll).map(g => findTarget(g.text, names)).find(Boolean);
          if (g2 && (g2.name === l.target || gs.length)) { l.bold = (gs.length ? gs[0].text : null); }
          if (links.some(x => x.target === l.target && x.kind === l.kind)) continue;
          links.push(l);
        }
      }
      // 人名块（很短、没有陈述）→ 只作为"归属用的名字" ✓
      if (!links.length && looksLikePersonName(b.text) && !looksLikeClueStatement(b.text)) {
        personNames.push({ name: b.text, x: bx, y: by, w: b.w });
        continue;
      }
      // **整句留下** ✓（有关联更好，没有也留 ✓）；只有规则文字/署名/碎片才丢 ✓
      if (looksLikeClueStatement(whole)) {
        rows.push({ text: whole, person: null, x: bx, y: by, links, block: b });
      } else {
        skipped.push({ text: whole, reason: links.length ? '有主语但要清理' : '规则文字/署名/没有主语' });
      }
    }
    // 整段文字里提到的人名（"clue: Crystal is the only person…" ✓）→ 作为归属线索的一部分 ✓
    const allNames = new Set(personNames.map(n => n.name));
    // 只保留"下方有内容"的人名 ✓，并把人的位置带给候选（按块/位置推定用 ✓）
    const used = new Set();
    for (const r of rows) {
      let best = null, bestKey = null;
      for (const n of personNames) {
        if (n.y > r.y + 4) continue;                       // 只看**上方**的名字 ✓
        // **横向关系优先** ✓：名字与线索在同一列（框有重叠）才算"这个人的" ✓
        // 以前只看纵向最近 ✗ —— contest 实测：一条线索正上方横向对齐的是 Seraphina ✓，
        // 但左边远处的 Rosalind 纵向更近（dy 10 vs 48 ✗）→ 被错认 ✓（这就是用户说的"对应不准" ✓）
        const nx1 = n.x + (n.w || 60), rx1 = r.x + (r.w || 60);
        const ox = Math.min(nx1, rx1) - Math.max(n.x, r.x);
        const sameCol = ox > 0;
        const dx = sameCol ? 0 : Math.min(Math.abs(n.x - r.x), Math.abs(nx1 - rx1));
        const dy = r.y - n.y;
        const key = [sameCol ? 0 : 1, dy, dx];
        const better = !bestKey || key[0] < bestKey[0] ||
          (key[0] === bestKey[0] && (key[1] < bestKey[1] - 1 ||
            (Math.abs(key[1] - bestKey[1]) <= 1 && key[2] < bestKey[2])));
        if (better) { best = n; bestKey = key; }
      }
      r.person = best ? best.name : null;
      if (best) used.add(best.name);
    }
    void allNames;
    return { clues: rows, names: personNames.filter(n => used.has(n.name)), skipped, blocks };
  }

  /**
   * 把线索上的"卡片人名"对应到应用里的人物（A–Z ✓）。
   * 规则（按用户要求 ✓）：
   *   ① 编号同名（用户把 A–Z 改成了题目里的名字 ✓）→ 直接对上
   *   ② 否则按**首字母** ✓：Anthony → A、Crystal → C…（这些人物的编号本来就是 A–Z 跳 X ✓）
   *   ③ 还对应不上的**留空**，由界面上手动选 （首字母不在编号里的，例如 V ✗ —— 不猜 ✓）
   * 同一个人不会被两条线索占用 ✓（按线索顺序先到先得 ✓）。
   * @param {Array<{person?:string, personId?:string}>} clues
   * @param {Array<{id:string, label:string}>} people
   */
  function mapByInitial(clues, people) {
    const used = new Set();
    const byLabel = new Map();
    for (const p of (people || [])) byLabel.set(String(p.label || '').toUpperCase(), p);
    // **已经指定过人物的候选先占位** ✓ —— 不要被后面的"位置推定"改派 ✗
    // （外部注入的候选、或用户手动指定的 ✓ 都靠这条保住 ✓）
    const known = new Set((people || []).map(p => p.id));
    const out = (clues || []).map(c => Object.assign({}, c, { personId: (c.personId && known.has(c.personId)) ? c.personId : '' }));
    for (const c of out) if (c.personId) used.add(c.personId);
    // ① 编号同名先占位 ✓
    for (const c of out) {
      if (!c.person) continue;
      const p = byLabel.get(norm(c.person).toUpperCase());
      if (p && !used.has(p.id)) { c.personId = p.id; c.mappedBy = 'label'; used.add(p.id); }
    }
    // ② 再按首字母 ✓
    for (const c of out) {
      if (c.personId || !c.person) continue;
      const first = (letters(c.person)[0] || '').toUpperCase();
      const p = first ? byLabel.get(first) : null;
      if (p && !used.has(p.id)) { c.personId = p.id; c.mappedBy = 'initial'; used.add(p.id); }
    }
    // ③ **卡片上没有名字的题**（例如 familymurdoku 那版用人像 ✓）：
    //    按线索在页面上的**位置顺序**（上→下、左→右）对应剩下的人物（A、B、C…✓）
    //    为什么要默认填：让用户一条条选太慢 ✗ —— 这类题他本来就得决定"哪个人像算 A"，
    //    按页面顺序给个默认，不对的地方一眼看得出、点一下就改 ✓
    //    凡是**没对上**的都补 ✓（包括"名字对不上"的：family 那版的假人名 Discover/
    //    The Caricature 就是这种情况 ✗ —— 留着空反而逼用户一条条选 ✗）
    const free = (people || []).filter(p => !used.has(p.id))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
    // **以"块"为单位**分配 ✓：一个气泡里的多句属于同一个人 ✓
    // （以前按"条"分配 → 同一人两句就白占两个人物名额 ✗ → 后面全部错位 ✗）
    const groups = new Map();
    out.forEach((c, i) => {
      const key = c.block || ('solo' + i);
      if (!groups.has(key)) groups.set(key, { y: c.y || 0, x: c.x || 0, items: [] });
      groups.get(key).items.push({ c, i });
    });
    const ordered = [...groups.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let k = 0;
    for (const g of ordered) {
      const done = g.items.filter(x => x.c.personId);
      if (done.length === g.items.length) continue;               // 全对上了 ✓
      // 块里已经有人对上 → 剩下的跟着同一个人 ✓
      let person = done.length ? (people || []).find(p => p.id === done[0].c.personId) : null;
      if (!person) person = free[k++];
      if (!person) break;
      for (const x of g.items) {
        if (x.c.personId) continue;
        out[x.i].personId = person.id;
        out[x.i].mappedBy = 'order';
      }
    }
    return out;
  }

  const api = { parse, findTarget, findTargets, clauseLinks, looksLikeClueStatement, clusterLines, splitClauses, mapByInitial, mergeBlocks, cluster, readItems, readOcrItems, looksLikePersonName, extract, readRuns, norm, REL_WORDS, NOT_CLUE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MurdokuClues = api;
})(typeof window !== 'undefined' ? window : globalThis);

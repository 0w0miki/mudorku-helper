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
    let kind = null;
    for (const r of REL_WORDS) { if (r.re.test(body)) { kind = r.kind; break; } }
    if (!kind) { out.reason = '没看到"在/在…旁边"这类关系词'; return out; }
    // **字体组优先** ✓：题目把物品名/关系词加粗（PDF 里是独立字体块 ✓），
    // 而"哪一组才是加粗"不用猜 ✗ —— **哪一组能匹配上已知物品/区域名就用哪一组** ✓
    // （实测：短句里加粗词可能比正文还多，靠"多数派 = 正文"会翻车 ✗）
    let target = null;
    for (const g of (opt.groups || [])) {
      const hit = findTarget(g.text, names);
      if (hit) { target = hit; out.bold = g.text; break; }
    }
    if (!target) target = findTarget(body, names);
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
        const sameLine = Math.abs(a.y - b.y) <= Math.max(3, Math.min(a.h, b.h) * 0.5);
        const lineGapX = gapX(a, b);
        // 竖向容差收紧到 0.6 字高 ✓：同一个气泡里的两行只隔 0.3~0.5 字高 ✓，
        // 而不同卡片/区域标签往往隔 1 个字高以上 → 不能连 ✗（1.2 就是把好几张卡连成一片的元凶）
        const stacked = gapY(a, b) <= Math.max(4, Math.min(a.h, b.h) * (opt.gapY == null ? 0.6 : opt.gapY));
        // 上下相邻：**必须真正同列** ✓ —— 要求横向重叠 ≥ 较窄那个的一半 ✓
        // （用"横向空隙小"会被斜着错开的碎片链式粘起来 ✗：实测把线索气泡和页脚粘成 664px 宽的一块 ✓）
        const oxSpan = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const narrow = Math.min(a.w, b.w);
        const colNear = oxSpan >= narrow * (opt.colOverlap == null ? 0.5 : opt.colOverlap);
        // 同一行：横向要挨着 ✓（隔很远的两张卡不能连 ✗）
        // 上下相邻：横向大致同列 ✓ 且**人名不跟线索连**（名字要单独成块 ✓）
        // 同行合并的空隙收紧到 0.45 字高 ✓：真实气泡之间不会只差那么点 ✓，
        // 而放太松会把"线索气泡"和旁边的页脚/说明**链式粘起来** ✗（实测 664px 宽的一块 ✓）
        if (sameLine && lineGapX <= Math.max(5, Math.min(a.h, b.h) * 0.45)) { union(a.i, b.i); continue; }
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
      arr.sort((a, b) => (a.y - b.y) || (a.x - b.x));
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
  function readItems(items, names, opts) {
    const o = Object.assign({}, opts || {}, { blocks: true });
    return extract(cluster(items, o), names, o);
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
   * 端到端（纯部分）：给定文字行 + 名称清单 → 线索候选
   * @returns {{clues:Array, names:Array, skipped:Array}}
   */
  function extract(lines, names, opts) {
    // 已经聚好的块别再合并一次 ✗（`cluster` 内部已经把容差收紧到 0.6 字高 ✓；
    // 这里再按 2.2 字高合并一次，会把相邻两张卡又粘起来 —— 实测踩过 ✓）
    const already = opts && opts.blocks === true;
    const blocks = already ? (lines || []).filter(b => b && norm(b.text)) : mergeBlocks(lines, opts);
    const clues = [], personNames = [], skipped = [];
    for (const b of blocks) {
      // 块的加粗片段 = 各行的加粗合起来 ✓（PDF 文字层才有的信息；OCR 没有就为空 ✓）
      const byFont = new Map();
      const fold = (g) => byFont.set(g.font, (((byFont.get(g.font) || '') + ' ' + g.text).replace(/\s+/g, ' ').trim()));
      if (Array.isArray(b.groups)) {
        b.groups.forEach(fold);                     // cluster() 已经按字体分好组了 ✓
      } else {
        for (const ln of (b.lines || [])) {
          if (Array.isArray(ln.runs)) readRuns(ln.runs).groups.forEach(fold);
        }
      }
      const groupsAll = [...byFont].map(([font, text]) => ({ font, text }));
      // **逐句解析** ✓：关系与目标必须同源；一块里有两句线索就各算一条 ✓
      const clauses = splitClauses(b.text);
      const parsedList = (clauses.length ? clauses : [b.text]).map(cl => {
        // 字体组只在**这一句范围内**生效 ✓（否则会拿别句的加粗词当目标 ✗）
        const key = norm(cl).replace(/\s+/g, ' ').toLowerCase();
        const gs = groupsAll.map(g => {
          const gt = norm(g.text).toLowerCase();
          return key.includes(gt) ? g : null;
        }).filter(Boolean);
        return parse(cl, names, { groups: gs.length ? gs : groupsAll });
      }).filter(r2 => r2.kind !== 'none' && r2.target);
      const p = parsedList[0] || parse(b.text, names, { groups: groupsAll });
      // 坐标两种来源都要认：`cluster()` 给的是 x/y ✓，`mergeBlocks()` 给的是 x0/y0 ✓
      // （写成 b.x0 时 cluster 的块会变成 NaN ✗ → 人名配对准失败 ✓ —— 单测先抓到的）
      const bx = Math.round(b.x != null ? b.x : b.x0);
      const by = Math.round(b.y != null ? b.y : b.y0);
      if (parsedList.length) {
        parsedList.forEach(r2 => clues.push({ text: r2.text, kind: r2.kind, polarity: r2.polarity, bold: r2.bold,
          target: r2.target.name, targetKind: r2.target.kind, targetId: r2.target.id, x: bx, y: by, block: b }));
      } else if (looksLikePersonName(b.text)) {
        personNames.push({ name: b.text, x: bx, y: by, w: b.w });
      } else {
        skipped.push({ text: b.text, reason: p.reason || '不是线索也不是人名' });
      }
    }
    // 人名候选：**不能在已知物品/区域清单里** ✗（Car/Chair/Shelf 这些是图例物品，
    // 真实 PDF 里它们和人物名看起来一样都是 Title case ✓ —— 实测混进来 8 个 ✗）
    const known = new Set((names || []).map(n => norm(n.name).toLowerCase()).filter(Boolean));
    for (let i = personNames.length - 1; i >= 0; i--) {
      const t = norm(personNames[i].name).toLowerCase();
      if (known.has(t)) personNames.splice(i, 1);
      else if (/\d/.test(personNames[i].name)) personNames.splice(i, 1);
    }
    // 人名 → 线索：**先要求横向有交叠**（名字在气泡正上方 ✓），再看竖向距离 ✓
    // （只看"谁在上方、更近"太弱 ✗ —— 实测线索会挂到页面另一头的标题上 ✓，
    //  和图例那套"heading 归属"是同一个教训 ✓）
    for (const c of clues) {
      const cw = Math.max(10, c.block ? blockWidth(c.block) : 40);
      let best = null, bestScore = Infinity;
      for (const n of personNames) {
        const nw = n.w != null ? n.w : 40;
        const ox = Math.min(n.x + nw, c.x + cw) - Math.max(n.x, c.x);
        const dx = ox > 0 ? 0 : Math.max(0, Math.max(n.x - (c.x + cw), c.x - (n.x + nw)));
        const above = n.y <= c.y + 4;
        const dy = above ? (c.y - n.y) : 1e5 + Math.abs(c.y - n.y);
        const score = (ox > 0 ? 0 : 1000 + dx) + dy;
        if (score < bestScore) { bestScore = score; best = n; }
      }
      c.person = best ? best.name : null;
      c.personX = best ? best.x : null;
    }
    // 只留下"真的挂住了线索"的人名 ✓：标题、页眉、说明里的名词都不是人名 ✗
    const usedNames = new Set(clues.map(c => c.person).filter(Boolean));
    const keep = personNames.filter(n => usedNames.has(n.name));
    return { clues, names: keep, skipped, blocks };
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
    // ① 编号同名先占位 ✓
    const out = (clues || []).map(c => Object.assign({ personId: '' }, c, { personId: '' }));
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

  const api = { parse, findTarget, splitClauses, mapByInitial, mergeBlocks, cluster, readItems, looksLikePersonName, extract, readRuns, norm, REL_WORDS, NOT_CLUE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MurdokuClues = api;
})(typeof window !== 'undefined' ? window : globalThis);

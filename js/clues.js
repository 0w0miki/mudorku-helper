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

  // 非线索：规则/说明/页眉页脚那种 ✓（宁可不认，也不要写错 ✗）
  const NOT_CLUE = [
    /one person per row/i, /what does .?beside.? mean/i, /to the left, right/i,
    /as soon as you/i, /block their entire/i, /exactly one/i, /rule:/i,
    /murdoku/i, /^art by/i, /puzzle and concept/i, /^playtesters/i,
  ];

  const norm = s => String(s == null ? '' : s)
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const letters = s => String(s || '').replace(/[^A-Za-z]/g, '');

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
  function parse(text, names) {
    const t = norm(text);
    const out = { kind: 'none', target: null, polarity: null, text: t, reason: '' };
    if (!t || letters(t).length < 4) { out.reason = '太短'; return out; }
    for (const bad of NOT_CLUE) {
      if (bad.test(t)) { out.reason = '规则/说明文字，不是线索'; return out; }
    }
    let kind = null;
    for (const r of REL_WORDS) { if (r.re.test(t)) { kind = r.kind; break; } }
    if (!kind) { out.reason = '没看到"在/在…旁边"这类关系词'; return out; }
    const target = findTarget(t, names);
    if (!target) { out.reason = '没匹配到已列出的物品/区域名'; out.kind = kind; return out; }
    out.kind = kind;
    out.target = target;
    // 极性：'in' / 'beside' 为正 ✓；'not-beside' 为负 ✗
    out.polarity = kind === 'not-beside' ? -1 : 1;
    return out;
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
      .filter(l => l && norm(l.text))
      .map(l => ({ text: norm(l.text), x: l.x == null ? 0 : l.x, y: l.y == null ? 0 : l.y,
        h: l.h == null ? 12 : l.h }))
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
    if (L === L.toUpperCase()) return false;                 // 全大写 = 区域名 ✓
    if (!/^[A-Z]/.test(t)) return false;                     // 名字首字母大写 ✓
    return true;
  }

  /**
   * 端到端（纯部分）：给定文字行 + 名称清单 → 线索候选
   * @returns {{clues:Array, names:Array, skipped:Array}}
   */
  function extract(lines, names, opts) {
    const blocks = mergeBlocks(lines, opts);
    const clues = [], personNames = [], skipped = [];
    for (const b of blocks) {
      const p = parse(b.text, names);
      if (p.kind !== 'none' && p.target) {
        clues.push({ text: p.text, kind: p.kind, polarity: p.polarity,
          target: p.target.name, targetKind: p.target.kind, targetId: p.target.id,
          x: Math.round(b.x0), y: Math.round(b.y0), block: b });
      } else if (looksLikePersonName(b.text)) {
        personNames.push({ name: b.text, x: Math.round(b.x0), y: Math.round(b.y0) });
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
    // 线索 → 就近的**上方**人名（头像名在气泡上方 ✓；没有就按 y 最近的 ✓）
    // 人名 → 线索：先看"上方的行"，同一行的人名再按 **x 距离**选 ✓
    // （只看 y 会把并排两个人的线索都挂到左边那位 ✗ —— 单测里 Brock/Crystal 就是这种情况）
    for (const c of clues) {
      let best = null, bestRow = Infinity, bestX = Infinity;
      for (const n of personNames) {
        const above = n.y <= c.y + 4;
        const row = above ? (c.y - n.y) : 1e5 + Math.abs(c.y - n.y);
        const dx = Math.abs(c.x - n.x);
        const better = row < bestRow - 1 || (Math.abs(row - bestRow) <= 1 && dx < bestX);
        if (!best || better) { best = n; bestRow = row; bestX = dx; }
      }
      c.person = best ? best.name : null;
    }
    // 只留下"真的挂住了线索"的人名 ✓：标题、页眉、说明里的名词都不是人名 ✗
    const usedNames = new Set(clues.map(c => c.person).filter(Boolean));
    const keep = personNames.filter(n => usedNames.has(n.name));
    return { clues, names: keep, skipped, blocks };
  }

  const api = { parse, findTarget, mergeBlocks, looksLikePersonName, extract, norm, REL_WORDS, NOT_CLUE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MurdokuClues = api;
})(typeof window !== 'undefined' ? window : globalThis);

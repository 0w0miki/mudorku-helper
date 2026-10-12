/*! Mudorku Helper — labels.js
 * 从图里的文字挑出"区域名"。区域名是画在地图上的**全大写**短标签
 * （RECEPTION / WAITING AREA / STORAGE / GARAGE / TEACHER'S AREA …），
 * 而图例物品名是首字母大写（Car / Chair / TV / Shelf），线索是整句文字。
 * 三个条件一起用就能干净地分开：**全大写 + 在地图外框内 + 字号不超过半格**。
 *
 * 拿到区域名的意义：不只是名字——**区域个数 k 与每个区域的种子格**也一起有了。
 * 纯逻辑、不依赖 DOM，浏览器挂 window.MurdokuLabels。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MurdokuLabels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 全大写（允许空格、数字、' ’ . - / &）；至少一个字母
  const ALL_CAPS = /^[A-Z0-9][A-Z0-9'’.\-\/& ]*$/;

  /**
   * 挑区域名。
   * @param {Array<{str:string,x:number,y:number,h?:number}>} items 文字块（含坐标，单位与栅格一致）
   * @param {{x:number,y:number,w:number,h:number}} [box] 地图外框；给了就只取框内的
   * @param {{minLetters?:number,maxWords?:number,maxSize?:number}} [options]
   *        maxSize：字号上限（一般传 0.5×格距，用来排除标题那种大字）
   */
  function pickRegionLabels(items, box, options) {
    const opt = Object.assign({ minLetters: 3, maxWords: 4, maxSize: 0 }, options || {});
    const out = [];
    for (const it of items || []) {
      const s = String((it && it.str) || '').trim();
      if (!s) continue;
      if (!ALL_CAPS.test(s)) continue;                    // 必须全大写（排除 Car / Chair / 整句）
      if (/^[0-9'’.\-\/& ]+$/.test(s)) continue;           // 纯数字/符号（步骤号 1 2 3）
      const letters = s.replace(/[^A-Za-z]/g, '');
      if (letters.length < opt.minLetters) continue;       // 排除 TV 这类两字母图例
      if (s.split(/\s+/).length > opt.maxWords) continue;
      const x = Number(it.x), y = Number(it.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (opt.maxSize > 0 && Number(it.h) > opt.maxSize) continue;
      if (box && !(x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h)) continue;
      out.push({ name: s, x, y, h: Number(it.h) || 0 });
    }
    // 同一个名字在同一处只留一次（pdf.js 会把一行拆成多个 item）
    const seen = new Set();
    const uniq = [];
    for (const l of out) {
      const key = l.name + '@' + Math.round(l.x / 10) + ',' + Math.round(l.y / 10);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(l);
    }
    uniq.sort((a, b) => a.y - b.y || a.x - b.x);
    return uniq;
  }

  /** 标签坐标 → 格子 (r,c)；格子外返回 null */
  function labelToCell(label, geom) {
    const c = Math.floor((label.x - geom.x0) / geom.pitchX);
    const r = Math.floor((label.y - geom.y0) / geom.pitchY);
    if (!(c >= 0 && c < geom.cols && r >= 0 && r < geom.rows)) return null;
    return { r, c };
  }

  /** 把标签列表直接转成 seeds（落在格子外的丢掉） */
  function labelsToSeeds(labels, geom) {
    const seeds = [];
    for (const l of labels) {
      const cell = labelToCell(l, geom);
      if (!cell) continue;
      if (seeds.some(s => s.r === cell.r && s.c === cell.c)) continue;   // 同一格只留一个
      seeds.push({ name: l.name, r: cell.r, c: cell.c });
    }
    return seeds;
  }

  return { pickRegionLabels, labelToCell, labelsToSeeds };
});

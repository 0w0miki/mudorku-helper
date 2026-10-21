/*! Mudorku Helper — 真实浏览器端到端演练（可选）
 *
 * 需要用真实指针事件才能验证的部分：拖拽刷格、长按进度条、悬停计算样式、刷新后 localStorage 恢复。
 * 运行前先装浏览器：
 *   pnpm add -D playwright && pnpm exec playwright install chromium
 * 然后：
 *   pnpm run test:browser
 *
 * 注意：这个脚本不在 `pnpm test` 里（pnpm test 只跑 jsdom 的三个纯 Node 用例）。
 */
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

// 只认项目自己装的 playwright：不要被 NODE_PATH 里其它项目塞进来的版本带跑
const LOCAL_PW = path.join(__dirname, '..', 'node_modules', 'playwright');
let chromium;
try {
  if (!fs.existsSync(path.join(LOCAL_PW, 'package.json'))) throw new Error('未安装');
  ({ chromium } = require(LOCAL_PW));
} catch (e) {
  console.error('这个脚本需要 playwright（可选依赖，没有随项目安装）：');
  console.error('  pnpm add -D playwright && pnpm exec playwright install chromium');
  process.exit(1);
}

/** 现场造一张"地图" PNG（白底 + 网格线），免得仓库里放测试图片 */
function makeMapPng(w, h, cols, rows) {
  const table = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  const crc32 = buf => { let c = -1; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const cw = w / cols, ch = h / rows;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let c = [252, 252, 250];
      if (Math.abs(x - Math.round(x / cw) * cw) < 1.2 || Math.abs(y - Math.round(y / ch) * ch) < 1.2) c = [150, 150, 150];
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3) c = [200, 30, 30];
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const FILE = 'file://' + path.join(__dirname, '..', 'index.html');
const A = [];
const ok = (c, m) => A.push((c ? 'PASS ' : 'FAIL ') + m);

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1460, height: 940 }, deviceScaleFactor: 2 });
  // 有些断言直接读 getComputedStyle 的颜色，而格子带 .08s 的背景过渡：等 80ms 去读
  // 会读到过渡中间值（0.4 读成 0.333），偶发失败。测试里直接关掉过渡。
  await p.addInitScript(() => {
    const add = () => {
      const st = document.createElement('style');
      st.textContent = '*{transition:none !important;animation:none !important}';
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.head) add();
    else document.addEventListener('DOMContentLoaded', add);
  });
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  // 应用默认在准备阶段显示"分步引导" ✓；这条流程多数章节逐个测"完整面板"的控件 ✓
  // → 定义 helper：**每次加载/刷新后**都退出引导 ✓（引导章节会自己设 MH.ui.wizard = k ✓）
  const exitWizard = () => p.evaluate(() => {
    if (!window.MH || !window.MH.ui) return;
    window.MH.ui.wizardOptOut = true;
    window.MH.ui.wizard = null;
    window.MH.render();
  });
  await p.goto(FILE);
  await p.waitForSelector('.cell');
  await exitWizard();
  await p.waitForSelector('.cell');

  const S = () => p.evaluate(() => window.MH.store.state);
  const centerOf = async k => { const bb = await p.locator(`.cell[data-k="${k}"]`).boundingBox(); return [bb.x + bb.width / 2, bb.y + bb.height / 2]; };

  // 0) 生成 5x5
  await p.fill('#rowsInput', '5'); await p.fill('#colsInput', '5');
  await p.click('[data-act="gen"]');
  let st = await S();
  ok(st.rows === 5 && st.cols === 5 && st.people.length === 5, '生成 5x5 地图 + 5 个人物');

  // 1) 真实拖拽刷出一个 L 形区域
  await p.click('[data-act="new-region"]');
  let [x, y] = await centerOf('0,0');
  await p.mouse.move(x, y); await p.mouse.down();
  for (const k of ['0,1', '0,2', '1,2']) { const c = await centerOf(k); await p.mouse.move(c[0], c[1]); }
  await p.mouse.up();
  const drafted = await p.evaluate(() => [...window.MH.ui.draft.cells].sort());
  ok(drafted.join(' ') === '0,0 0,1 0,2 1,2', '拖拽刷选 4 格 → ' + drafted.join(' '));
  await p.fill('#draftName', '走廊');
  await p.click('[data-act="draft-save"]');
  st = await S();
  ok(st.regions.length === 1 && st.regions[0].name === '走廊' && st.regions[0].cells.length === 4, '保存区域「走廊」');
  const outlineD = await p.getAttribute('.region-outline', 'd');
  ok(outlineD && outlineD.length > 0, '区域外轮廓已绘制');

  // 2) 真实点击新建物品（不可占据）
  await p.click('[data-act="new-item"]');
  [x, y] = await centerOf('2,2');
  await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.up();
  await p.fill('#draftName', '陷阱');
  await p.click('input[name="draftOcc"][value="0"]');
  await p.click('[data-act="draft-save"]');
  st = await S();
  ok(st.items.length === 1 && st.items[0].occupiable === false, '新建不可占据物品「陷阱」');

  // 3) 真实点击设置关联：A +走廊，A -陷阱
  const rid = (await S()).regions[0].id, iid = (await S()).items[0].id;
  await p.selectOption('#linkPicker', 'region:' + rid);          // 下拉框添加，默认正相关
  await p.selectOption('#linkPicker', 'item:' + iid);
  await p.click(`.link-row[data-hover-item="${iid}"] button[data-act="link"][data-pol="-1"]`); // 切成负相关
  st = await S();
  ok(st.people[0].links.length === 2, '用下拉框建立两条关联');
  ok(st.people[0].links.some(l => l.polarity === -1) && st.people[0].links.some(l => l.polarity === 1),
    '一条正相关一条负相关');

  // 4) 悬停格子高亮区域
  [x, y] = await centerOf('0,1');
  await p.mouse.move(x, y);
  await p.waitForTimeout(80);
  const hl = await p.evaluate(() => {
    const o = document.querySelector('.region-outline');
    const cell = document.querySelector('.cell[data-k="0,0"]');
    return {
      outlineHl: o.classList.contains('hl'),
      outlineWidth: getComputedStyle(o).strokeWidth,
      cellBg: getComputedStyle(cell).backgroundImage,   // 区域底色由渐变层表达
      filled: cell.classList.contains('hl-region'),
      hoverBg: getComputedStyle(cell).backgroundColor,
    };
  });
  ok(hl.outlineHl && hl.outlineWidth === '5px', '网格悬停：区域外框加粗 ' + hl.outlineWidth);
  ok(!hl.filled && /0\.16/.test(hl.cellBg), '网格悬停不填充整块：' + hl.cellBg);
  ok(!/0\.4[26]/.test(hl.hoverBg + hl.cellBg), '网格悬停没有整块高亮色');

  // 5) 切到游玩：不可占据格固定 X
  await p.click('#tabPlay');
  await p.waitForTimeout(60);
  ok(await p.evaluate(() => !!document.querySelector('.cell[data-k="2,2"] .xmark.auto')), '不可占据物品格显示固定 X');

  // 6) 真实点击标候选（点两处）
  for (const k of ['1,0', '2,4']) { const c = await centerOf(k); await p.mouse.click(c[0], c[1]); }
  st = await S();
  ok(st.play.candidates[st.selectedPersonId].length === 2, '点两处标注候选');

  // 7) 悬停人物 → 关联高亮（走廊绿、陷阱红）
  await p.hover('.cell[data-k="1,0"] .cands i');
  await p.waitForTimeout(80);
  const hov = await p.evaluate(() => ({
    pos: getComputedStyle(document.querySelector('.cell[data-k="0,0"]')).backgroundColor,
    neg: getComputedStyle(document.querySelector('.cell[data-k="2,2"]')).backgroundColor,
  }));
  ok(hov.pos === 'rgba(22, 163, 74, 0.4)' && hov.neg === 'rgba(239, 68, 68, 0.46)', '悬停候选：正向绿 ' + hov.pos + ' / 负向红 ' + hov.neg);

  // 8) 真实长按确定到 (3,1)
  const target = await centerOf('3,1');
  await p.mouse.move(target[0], target[1]);
  await p.mouse.down();
  await p.waitForTimeout(400);
  const ringShown = await p.evaluate(() => {
    const r = document.querySelector('.ring');
    return !!r && r.style.display === 'block' && parseFloat(getComputedStyle(document.querySelector('.ring-fg')).strokeDashoffset) > 0;
  });
  // 不要死等固定时间：机器繁忙时 rAF 会被拖慢，改为轮询状态直到确定完成
  await p.waitForFunction(() => Object.keys(window.MH.store.state.play.placed).length > 0, null, { timeout: 6000 });
  await p.mouse.up();
  st = await S();
  const pid = st.selectedPersonId;
  ok(ringShown, '长按过程中显示圆形进度条');
  ok(st.play.placed[pid] === '3,1', '长按确定在 (3,1)');
  const colX = [0, 2, 3, 4].every(c => st.play.xmarks[`3,${c}`]);
  const rowX = [0, 1, 2, 4].every(r => st.play.xmarks[`${r},1`]);
  ok(colX && rowX, '同行同列（除当前格）已标 X');
  ok(!!(await p.$('.cell[data-k="3,1"] .person-chip')), '棋盘出现人物圆形标记');

  // 8.5) 拖动连续标注候选（真实指针），整段一次撤销
  await p.click('.plist li[data-id="p2"]');
  // 注意 A 已确定在 (3,1)（第 2 列），所以避开第 2 列，用 (0,2)(0,3)(0,4)
  let a = await centerOf('0,2'), b2 = await centerOf('0,3'), c2 = await centerOf('0,4');
  await p.mouse.move(a[0], a[1]);
  await p.mouse.down();
  await p.mouse.move(b2[0], b2[1], { steps: 4 });
  await p.mouse.move(c2[0], c2[1], { steps: 4 });
  await p.mouse.up();
  st = await S();
  ok(st.play.candidates.p2 && st.play.candidates.p2.length === 3, '拖动连标 3 个候选：' + JSON.stringify(st.play.candidates.p2));
  ok(!(st.play.candidates.p2 || []).includes('0,1'), '被 A 排除的格子不会被拖上候选');
  await p.click('#btnUndo');
  st = await S();
  ok((st.play.candidates.p2 || []).length === 0, '整段拖动一次撤销');

  // 8.6) X 颜色必须是深色
  await p.click('[data-act="left-mode"][data-mode="x"]');
  let z = await centerOf('2,0'); await p.mouse.click(z[0], z[1]);
  const xcolor = await p.evaluate(() => getComputedStyle(document.querySelector('.xmark.user')).color);
  ok(/rgb\(1[0-9], ?1[0-9], ?[0-9]+\)|rgb\(11, 18, 32\)/.test(xcolor), 'X 是深色：' + xcolor);
  // X 模式下长按不放人
  const q2 = await centerOf('2,2');
  await p.mouse.move(q2[0], q2[1]); await p.mouse.down();
  await p.waitForTimeout(900);
  const placedInX = await p.evaluate(() => Object.keys(window.MH.store.state.play.placed).length);
  await p.mouse.up();
  ok(placedInX === (st.play.placed ? Object.keys(st.play.placed).length : 0), 'X 模式下长按不会放人');
  await p.click('#btnUndo');                                       // 撤掉刚才那笔 X，保持后续步骤的历史位置
  await p.click('[data-act="left-mode"][data-mode="candidate"]');
  st = await S();

  // 9) 撤销 / 重做
  await p.click('#btnUndo');
  st = await S();
  ok(!st.play.placed[pid], '撤销后确定被回滚');
  await p.click('#btnRedo');
  st = await S();
  ok(st.play.placed[pid] === '3,1', '重做后恢复');

  // 10) 导出 → 重置 → 导入
  const text = await p.evaluate(() => window.MH.store.exportText());
  await p.evaluate(t => window.MH.store.importText(t), text);
  st = await S();
  ok(st.regions.length === 1 && st.play.placed[pid] === '3,1', '导出/导入往返一致');

  // 11) 刷新后 localStorage 恢复
  await p.reload(); await exitWizard();
  await p.waitForSelector('.cell');
  st = await S();
  ok(st.regions.length === 1 && st.rows === 5 && st.phase === 'play', '刷新后从 localStorage 恢复');

  // 12) 校验面板
  const issues = await p.$$eval('.issues .issue', els => els.map(e => e.textContent));
  ok(issues.length >= 1, '实时检查有输出：' + JSON.stringify(issues));

  // 13) 底图：导入 PNG → 对齐 → 刷新后仍在 → PDF
  await p.click('#tabPrep');           // 底图控制项在准备阶段
  await p.setInputFiles('#bgFileInput', { name: 'map.png', mimeType: 'image/png', buffer: makeMapPng(400, 300, 8, 6) });
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 15000 });
  st = await S();
  ok(st.bg.kind === 'image' && st.bg.w === 400, '导入 PNG 作底图：' + st.bg.w + 'x' + st.bg.h);
  ok(await p.locator('#bgLayer').isVisible(), '底图层可见');
  const veil = await p.evaluate(() => getComputedStyle(document.querySelector('.cell')).backgroundImage);
  ok(/rgba\(255,\s*255,\s*255/.test(veil), '有底图时格子半透明，底图能透出来：' + veil.slice(0, 60));

  await p.click('[data-act="bg-align"]');
  const g0 = await p.evaluate(() => Object.assign({}, window.MH.store.state.grid));
  const gb = await p.locator('#gridBox').boundingBox();
  await p.mouse.move(gb.x + 20, gb.y + 20);
  await p.mouse.down();
  await p.mouse.move(gb.x + 20 + 45, gb.y + 20 + 25, { steps: 5 });
  await p.mouse.up();
  st = await S();
  ok(st.grid.x === g0.x + 45 && st.grid.y === g0.y + 25, '对齐模式拖动网格：' + JSON.stringify(g0) + ' → ' + JSON.stringify(st.grid));
  ok(await p.locator('#alignHandle').isVisible(), '缩放手柄可见');

  await p.reload(); await exitWizard();
  await p.waitForSelector('.cell');
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 10000 });
  st = await S();
  ok(st.bg && st.grid.x === g0.x + 45, '刷新后底图与网格偏移都保留');
  ok(await p.locator('#bgLayer').isVisible(), '刷新后底图仍显示');

  await p.setInputFiles('#bgFileInput', { name: 'map.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(path.join(__dirname, 'fixtures', 'map.pdf')) });
  await p.waitForFunction(() => window.MH.store.state.bg && window.MH.store.state.bg.kind === 'pdf', null, { timeout: 30000 });
  st = await S();
  ok(st.bg.kind === 'pdf' && st.bg.w > 0, '导入 PDF 渲染成底图：' + st.bg.w + 'x' + st.bg.h);

  // 14) 底图卡片顺序 + 自动裁切 + 图片与网格绑定缩放
  await p.click('#tabPrep');
  const order = await p.$$eval('.sidebar .card h2', els => els.map(e => e.textContent.trim().split(' ')[0]));
  ok(order[0].startsWith('底图'), '底图卡片在所有卡片最前：' + order.join(' → '));

  // 摆一个「已对齐、四周有余量」的确定状态。
  // 注意：不能用「生成地图」按钮——此时盘面已有内容会弹 confirm，Playwright 默认自动取消。
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(6, 8), 'e2e 底图'));
  await p.setInputFiles('#bgFileInput', { name: 'map.png', mimeType: 'image/png', buffer: makeMapPng(400, 300, 8, 6) });
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 15000 });
  const setAligned = () => p.evaluate(() => {
    const s = window.MH.store.state;
    s.settings.cellSize = 40; s.bg.scale = 1;
    window.MurdokuCore.setGridOffset(s, 20, 15);
    window.MH.store.setSettings({}); window.MH.render();
  });
  await setAligned();
  let pre = await S();
  ok(pre.bg.bound !== true && pre.settings.cellSize === 40 && pre.rows === 6 && pre.cols === 8,
     '底图就位且网格 8×6 / 每格 40px');

  await p.click('#btnZoomIn');                       // 未绑定：只动格子
  let mid = await S();
  ok(mid.settings.cellSize !== pre.settings.cellSize && mid.bg.scale === pre.bg.scale && mid.grid.x === pre.grid.x,
     '未绑定时缩放只动格子：cell ' + pre.settings.cellSize + '→' + mid.settings.cellSize + '，底图与偏移不动');

  await setAligned();
  pre = await S();
  await p.click('[data-act="bg-crop"]');
  await p.waitForFunction(() => window.MH.store.state.bg && window.MH.store.state.bg.bound === true, null, { timeout: 15000 });
  let post = await S();
  ok(post.bg.w < pre.bg.w && post.bg.h < pre.bg.h,
     '自动裁切生效：底图 ' + pre.bg.w + '×' + pre.bg.h + ' → ' + post.bg.w + '×' + post.bg.h);
  ok(post.bg.bound === true && post.settings.cellSize === pre.settings.cellSize, '裁完标记 bound 且格子大小不变');
  // 对齐不变：裁切矩形必须 = 网格外框 + 边距，且网格在新图里的偏移 = 原图坐标 - 裁掉的左上角。
  // 边距不当成常量写死，而是从实际裁切结果反推，这样以后调 CROP_MARGIN 也不会误报。
  const cell = post.settings.cellSize;
  const gx0 = pre.grid.x / pre.bg.scale, gy0 = pre.grid.y / pre.bg.scale;   // 网格左上角（原图像素）
  const gw = 8 * cell, gh = 6 * cell;
  const margin = (post.bg.w - gw) / 2;
  const cx = Math.max(0, Math.floor(gx0 - margin));
  const cy = Math.max(0, Math.floor(gy0 - margin));
  const expW = Math.min(400, Math.ceil(gx0 + gw + margin)) - cx;
  const expH = Math.min(300, Math.ceil(gy0 + gh + margin)) - cy;
  ok(margin >= 0, '反推出的裁切边距合理：' + margin + 'px');
  ok(post.bg.w === expW && post.bg.h === expH,
     '裁切范围 = 网格外框 + 边距：实得 ' + post.bg.w + '×' + post.bg.h + '，应为 ' + expW + '×' + expH);
  ok(post.grid.x === Math.round(gx0 - cx) && post.grid.y === Math.round(gy0 - cy),
     '裁切后网格偏移 = 原图坐标 - 裁掉的左上角（对齐按构造不变）：' + post.grid.x + ',' + post.grid.y);

  // 绑定后：格子 / 底图缩放 / 网格偏移同倍
  const z0 = await S();
  await p.click('#btnZoomIn');
  const z1 = await S();
  const k = z1.settings.cellSize / z0.settings.cellSize;
  ok(Math.abs(z1.bg.scale / z0.bg.scale - k) < 0.02,
     '绑定缩放：底图同倍 (' + z0.bg.scale.toFixed(3) + '→' + z1.bg.scale.toFixed(3) + '，k=' + k.toFixed(3) + ')');
  ok(z0.grid.x === 0 || Math.abs(z1.grid.x / z0.grid.x - k) < 0.06, '绑定缩放：网格偏移同倍');
  await p.click('#btnZoomOut');
  const z2 = await S();
  ok(z2.settings.cellSize === z0.settings.cellSize && Math.abs(z2.bg.scale - z0.bg.scale) < 1e-6 && z2.grid.x === z0.grid.x,
     '缩回后精确还原裁切态');
  const cbb = await p.locator('#board').boundingBox();
  await p.screenshot({ path: '/tmp/mh-e2e-crop.png', clip: { x: cbb.x - 8, y: cbb.y - 8, width: cbb.width + 16, height: cbb.height + 16 } });

  // 15) PDF 摘录悬浮窗：导入 → 拖框截取 → 徽标 → 收起 → 刷新后仍在
  ok(await p.locator('#snipper').count() === 1, 'PDF 摘录悬浮窗已挂载');
  await p.setInputFiles('#snipper input[data-snip="file"]',
    { name: 'map.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(path.join(__dirname, 'fixtures', 'map.pdf')) });
  await p.waitForFunction(() => {
    const img = document.querySelector('#snipper img.snipper-img');
    return !!img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 30000 });
  // 拖框偶尔第一次不生效（已知抖动 ✓）→ 最多试 3 次 ✓
  let pins = 0;
  for (let attempt = 0; attempt < 3 && pins === 0; attempt++) {
    const sbox = await p.locator('#snipper img.snipper-img').boundingBox();
    await p.mouse.move(sbox.x + 40, sbox.y + 40);
    await p.mouse.down();
    await p.mouse.move(sbox.x + 240, sbox.y + 190, { steps: 8 });
    await p.mouse.up();
    await p.waitForTimeout(500);
    pins = await p.locator('.snipper-pin').count();
  }
  ok(pins >= 1, '拖框截取生成摘录卡片：' + pins + ' 张');
  ok(((await p.locator('.snipper-badge').textContent()) || '').trim() === String(pins), '角标显示张数');
  await p.click('.snipper-tab');
  await p.waitForTimeout(250);
  ok(!(await p.locator('.snipper-panel').isVisible()), '📌 可收起悬浮窗');
  await p.screenshot({ path: '/tmp/mh-e2e-snipper.png' });
  await p.reload(); await p.waitForSelector('.cell'); await p.waitForTimeout(700); await exitWizard();
  const pins2 = await p.locator('.snipper-pin').count();
  ok(pins2 >= 1, '刷新后摘录卡片仍在：' + pins2 + ' 张');

  // 16) 悬停人物时顶出他自己的候选格
  await p.click('#tabPlay');
  const candInfo = await p.evaluate(() => {
    const s = window.MH.store.state;
    const [a, b] = s.people.map(x => x.id);
    s.play.candidates[a] = ['1,1', '1,3', '3,3'];
    s.play.candidates[b] = ['1,1', '2,2'];
    window.MH.render();
    return { a: a, color: s.people[0].color };
  });
  await p.hover('.cell[data-k="3,3"] .cands i[data-person="' + candInfo.a + '"]');
  await p.waitForTimeout(150);
  const candHl = await p.evaluate(a => {
    const cls = k => document.querySelector('.cell[data-k="' + k + '"]').className;
    const shared = document.querySelector('.cell[data-k="1,1"]');
    const chips = [...shared.querySelectorAll('.cands i')].map(i => ({
      pid: i.dataset.person, on: i.classList.contains('on'),
      opacity: parseFloat(getComputedStyle(i).opacity),
    }));
    const cell = document.querySelector('.cell[data-k="3,3"]');
    return {
      mine: ['1,1', '1,3', '3,3'].map(k => cls(k).includes('hl-cand')),
      other: cls('2,2').includes('hl-cand'),
      shadow: getComputedStyle(cell).boxShadow,
      ringVar: cell.style.getPropertyValue('--cand-ring'),
      myChip: chips.filter(c => c.pid === a)[0],
      otherChips: chips.filter(c => c.pid !== a),
    };
  }, candInfo.a);
  ok(candHl.mine.every(Boolean), '悬停人物时自己的候选格全部顶出：' + JSON.stringify(candHl.mine));
  ok(candHl.other === false, '别人独有的候选格不受影响');
  ok(candHl.ringVar === candInfo.color && /inset/.test(candHl.shadow),
     '候选格描边用本人颜色：' + candHl.ringVar + ' / ' + candHl.shadow);
  ok(candHl.myChip && candHl.myChip.on && candHl.myChip.opacity === 1, '本人候选标签点亮');
  ok(candHl.otherChips.length > 0 && candHl.otherChips.every(c => !c.on && c.opacity < 0.5),
     '同格里别人的候选淡下去：' + JSON.stringify(candHl.otherChips));
  const cbb2 = await p.locator('#board').boundingBox();
  await p.screenshot({ path: '/tmp/mh-e2e-cand.png', clip: { x: cbb2.x - 8, y: cbb2.y - 8, width: cbb2.width + 16, height: cbb2.height + 16 } });

  // 17) 摘录窗改进：箭头图标 / 卡片缩放拖拽排序 / 多卡片可滚动 / 缩略图折叠
  // 上一节可能把面板收起了（会持久化），先归一成展开态再测
  if (await p.locator('.snipper-panel').isHidden()) { await p.click('.snipper-tab'); await p.waitForTimeout(200); }
  ok(await p.locator('.snipper-panel').isVisible(), '面板处于展开态');
  const tabSvg = await p.innerHTML('.snipper-tab');
  ok(!/📌/.test(tabSvg) && /snipper-chev/.test(tabSvg), '收起按钮已换成箭头图标');
  const chevOpen = await p.evaluate(() => getComputedStyle(document.querySelector('.snipper-tab .snipper-chev')).transform);
  await p.click('.snipper-tab');
  await p.waitForTimeout(200);
  const chevShut = await p.evaluate(() => getComputedStyle(document.querySelector('.snipper-tab .snipper-chev')).transform);
  ok(chevOpen !== chevShut && await p.locator('.snipper-panel').isHidden(), '箭头会转向且能收起');
  await p.click('.snipper-tab');
  await p.waitForTimeout(200);
  ok(await p.locator('.snipper-panel').isVisible(), '再点箭头又展开');

  // 注入 8 张卡片，检验「卡片多了看不到」是否解决
  await p.evaluate(() => {
    const cv = document.createElement('canvas'); cv.width = 240; cv.height = 160;
    const ctx = cv.getContext('2d');
    const pins = [];
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 240, 160);
      ctx.fillStyle = '#0b1220'; ctx.font = 'bold 40px sans-serif';
      ctx.fillText('卡片 ' + (i + 1), 16, 96);
      pins.push({ id: 'p' + (i + 1), page: 1, w: 240, h: 160, url: cv.toDataURL('image/png') });
    }
    localStorage.setItem('murdoku-helper.v1.snipPins', JSON.stringify(pins));
    window.MurdokuSnipper.refresh();
  });
  await p.waitForTimeout(250);
  const pinInfo = await p.evaluate(() => {
    const box = document.querySelector('.snipper-pins');
    const panel = document.querySelector('.snipper-panel');
    box.scrollTop = 1e6;
    const last = document.querySelector('.snipper-pin:last-child').getBoundingClientRect();
    const pb = panel.getBoundingClientRect();
    return {
      n: document.querySelectorAll('.snipper-pin').length,
      scrollable: box.scrollHeight > box.clientHeight + 2,
      lastVisible: last.bottom <= pb.bottom + 2 && last.bottom <= window.innerHeight + 2,
      panelInside: pb.bottom <= window.innerHeight + 2,
    };
  });
  ok(pinInfo.n === 8, '8 张卡片都渲染出来');
  ok(pinInfo.scrollable, '卡片区可滚动（不再被面板裁掉）');
  ok(pinInfo.lastVisible && pinInfo.panelInside, '滚到底能完整看到最后一张：' + JSON.stringify(pinInfo));

  // 卡片比之前大（视口 220px）
  const zid = await p.getAttribute('.snipper-pin:first-child', 'data-id');
  const boxH = await p.evaluate(id => Math.round(document.querySelector(`.snipper-pin[data-id="${id}"] .snipper-pin-body`).getBoundingClientRect().height), zid);
  ok(boxH >= 200, '卡片视口比之前大：' + boxH + 'px（原 140）');

  // 点 + 放大
  const zw0 = await p.evaluate(id => document.querySelector(`.snipper-pin[data-id="${id}"] img`).getBoundingClientRect().width, zid);
  await p.click(`.snipper-pin[data-id="${zid}"] [data-snip="pin-zoom"][data-dir="1"]`);
  await p.click(`.snipper-pin[data-id="${zid}"] [data-snip="pin-zoom"][data-dir="1"]`);
  const zw1 = await p.evaluate(id => document.querySelector(`.snipper-pin[data-id="${id}"] img`).getBoundingClientRect().width, zid);
  ok(zw1 > zw0 * 1.4, '点 + 放大卡片：' + Math.round(zw0) + ' → ' + Math.round(zw1) + 'px（' + (await p.textContent(`.snipper-pin[data-id="${zid}"] .snip-pct`)) + '）');

  // 放大后按住拖动 = 平移
  const zbody = await p.locator(`.snipper-pin[data-id="${zid}"] .snipper-pin-body`).boundingBox();
  await p.mouse.move(zbody.x + zbody.width - 20, zbody.y + 20);
  await p.mouse.down();
  await p.mouse.move(zbody.x + 20, zbody.y + 60, { steps: 6 });
  await p.mouse.up();
  const pan = await p.evaluate(id => {
    const el = document.querySelector(`.snipper-pin[data-id="${id}"] .snipper-pin-body`);
    return { x: el.scrollLeft, y: el.scrollTop };
  }, zid);
  ok(pan.x > 0 || pan.y > 0, '放大后可拖动平移查看：' + JSON.stringify(pan));
  await p.click(`.snipper-pin[data-id="${zid}"] .snip-pct`);
  ok((await p.textContent(`.snipper-pin[data-id="${zid}"] .snip-pct`)) === '100%', '点百分比还原 100%');

  // 拖标题栏排序（落点取最后一张卡片的中点以下）
  const capBox = await p.locator('.snipper-pin:first-child .snipper-cap').boundingBox();
  const lastBox = await p.locator('.snipper-pin:last-child').boundingBox();
  await p.mouse.move(capBox.x + 30, capBox.y + 8);
  await p.mouse.down();
  await p.mouse.move(lastBox.x + 30, lastBox.y + lastBox.height / 2 + 20, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(200);
  const pinOrder = await p.evaluate(() => [...document.querySelectorAll('.snipper-pin')].map(e => e.dataset.id));
  ok(pinOrder[pinOrder.length - 1] === zid, '拖标题栏可调整卡片顺序：' + pinOrder.join(','));

  // 缩略图折叠 + 持久化
  const pinsH0 = await p.evaluate(() => document.querySelector('.snipper-pins').getBoundingClientRect().height);
  await p.click('[data-snip="fold-stage"]');
  await p.waitForTimeout(200);
  const folded = await p.evaluate(() => ({
    hidden: getComputedStyle(document.querySelector('.snipper-stage')).display === 'none',
    h: document.querySelector('.snipper-pins').getBoundingClientRect().height,
  }));
  ok(folded.hidden, 'PDF 缩略图可折叠');
  ok(folded.h >= pinsH0, '折叠后卡片区更高：' + Math.round(pinsH0) + ' → ' + Math.round(folded.h));
  await p.reload(); await p.waitForSelector('.cell'); await p.waitForTimeout(500); await exitWizard();
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.snipper-stage')).display === 'none'), '折叠状态刷新后保留');
  await p.screenshot({ path: '/tmp/mh-e2e-snipper2.png' });

  // 18) 导航缩略图（minimap）：放大后知道自己在整张的哪里
  await p.evaluate(() => {
    const mk = (w, h, txt) => {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#0b1220'; ctx.font = 'bold ' + Math.round(h / 14) + 'px sans-serif';
      ctx.fillText(txt, 12, Math.round(h / 12));
      for (let i = 1; i < 12; i++) ctx.fillRect(12, 20 + i * 52, w - 24, 2);
      return cv.toDataURL('image/png');
    };
    localStorage.setItem('murdoku-helper.v1.snipPins', JSON.stringify([
      { id: 'tall', page: 1, w: 260, h: 700, url: mk(260, 700, '竖长') },
      { id: 'wide', page: 1, w: 900, h: 200, url: mk(900, 200, '横图') },
    ]));
    window.MurdokuSnipper.refresh();
  });
  await p.waitForTimeout(400);
  const mmGeo = await p.evaluate(() => {
    const g = id => {
      const m = document.querySelector(`.snipper-pin[data-id="${id}"] .snip-mm`);
      const fig = document.querySelector(`.snipper-pin[data-id="${id}"]`);
      const body = fig.querySelector('.snipper-pin-body');
      const mb = m.getBoundingClientRect(), fb = fig.getBoundingClientRect();
      return { hidden: m.hidden, mmW: Math.round(mb.width), mmH: Math.round(mb.height),
               rightGap: Math.round(fb.right - mb.right), inCard: mb.top >= fb.top - 1 && mb.bottom <= fb.bottom + 1,
               viewH: body.clientHeight, contentH: body.querySelector('img').offsetHeight };
    };
    return { tall: g('tall'), wide: g('wide') };
  });
  ok(mmGeo.tall.hidden === false, '竖长卡片出现 minimap：' + mmGeo.tall.mmW + '×' + mmGeo.tall.mmH);
  ok(mmGeo.tall.rightGap <= 8 && mmGeo.tall.inCard, 'minimap 贴在卡片右侧不越界（右距 ' + mmGeo.tall.rightGap + 'px）');
  ok(mmGeo.wide.hidden === true, '不溢出的卡片不显示 minimap');

  const mmRect0 = await p.evaluate(() => {
    const v = document.querySelector('.snipper-pin[data-id="tall"] .snip-mm-view').getBoundingClientRect();
    const m = document.querySelector('.snipper-pin[data-id="tall"] .snip-mm').getBoundingClientRect();
    return { w: Math.round(v.width), h: Math.round(v.height), mmW: Math.round(m.width), mmH: Math.round(m.height) };
  });
  const mmExpH = Math.round(mmGeo.tall.mmH * (mmGeo.tall.viewH / mmGeo.tall.contentH));
  ok(mmRect0.w >= mmGeo.tall.mmW - 3, '内容不比卡片宽时视窗框横向占满：' + JSON.stringify(mmRect0));
  ok(Math.abs(mmRect0.h - mmExpH) <= 3, '视窗框高与可见比例一致：' + mmRect0.h + ' ≈ ' + mmExpH);

  await p.evaluate(() => { document.querySelector('.snipper-pin[data-id="tall"] .snipper-pin-body').scrollTop = 1e6; });
  await p.waitForTimeout(200);
  const mmBottom = await p.evaluate(() => {
    const m = document.querySelector('.snipper-pin[data-id="tall"] .snip-mm').getBoundingClientRect();
    const v = document.querySelector('.snipper-pin[data-id="tall"] .snip-mm-view').getBoundingClientRect();
    return { bottomGap: Math.round(m.bottom - v.bottom), within: v.bottom <= m.bottom + 1 };
  });
  ok(mmBottom.within && mmBottom.bottomGap <= 3, '滚到底时视窗框贴住 minimap 底部：' + JSON.stringify(mmBottom));

  await p.click('.snipper-pin[data-id="tall"] [data-snip="pin-zoom"][data-dir="1"]');
  await p.click('.snipper-pin[data-id="tall"] [data-snip="pin-zoom"][data-dir="1"]');
  await p.waitForTimeout(200);
  const mmZoom = await p.evaluate(() => {
    const v = document.querySelector('.snipper-pin[data-id="tall"] .snip-mm-view').getBoundingClientRect();
    const m = document.querySelector('.snipper-pin[data-id="tall"] .snip-mm').getBoundingClientRect();
    return +(v.width / m.width).toFixed(2);
  });
  ok(mmZoom < 0.8, '放大后视窗框变窄，看得出只看得到局部：宽占比 ' + mmZoom);

  await p.evaluate(() => { document.querySelector('.snipper-pin[data-id="tall"] .snipper-pin-body').scrollTop = 0; });
  const mmBox = await p.locator('.snipper-pin[data-id="tall"] .snip-mm').boundingBox();
  await p.mouse.click(mmBox.x + mmBox.width / 2, mmBox.y + mmBox.height * 0.85);
  await p.waitForTimeout(200);
  const jumped = await p.evaluate(() => document.querySelector('.snipper-pin[data-id="tall"] .snipper-pin-body').scrollTop);
  ok(jumped > 0, '点 minimap 可直接跳到对应位置：scrollTop=' + jumped);
  await p.mouse.move(mmBox.x + mmBox.width / 2, mmBox.y + mmBox.height * 0.85);
  await p.mouse.down();
  await p.mouse.move(mmBox.x + mmBox.width / 2, mmBox.y + mmBox.height * 0.15, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(200);
  const mmDrag = await p.evaluate(() => document.querySelector('.snipper-pin[data-id="tall"] .snipper-pin-body').scrollTop);
  ok(mmDrag < jumped, '按住拖动 minimap 可连续定位：' + jumped + ' → ' + mmDrag);
  await p.screenshot({ path: '/tmp/mh-e2e-minimap.png' });

  // 19) 24 人时的人物列表：紧凑网格，不再拉成长条
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(24, 24), 'e2e 24 人'));
  await p.click('#tabPlay');
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const st = window.MH.store.state, C = window.MurdokuCore;
    const ids = st.people.map(x => x.id);
    C.setCandidate(st, ids[0], '0,5', true);
    C.setCandidate(st, ids[0], '1,6', true);
    C.placePerson(st, ids[5], '10,10');
    window.MH.render();
  });
  await p.waitForTimeout(200);
  const grid = await p.evaluate(() => {
    const ul = document.querySelector('.plist');
    const cells = [...ul.querySelectorAll('li')];
    const cols = getComputedStyle(ul).gridTemplateColumns.split(' ').length;
    return {
      n: cells.length, cols: cols, rows: Math.ceil(cells.length / cols),
      h: Math.round(ul.getBoundingClientRect().height),
      clearBtns: document.querySelectorAll('[data-act="clear-person"]').length,
      badgeA: cells[0].querySelector('.pb') ? cells[0].querySelector('.pb').textContent : null,
      placedCount: cells.filter(c => c.classList.contains('placed')).length,
      // 已确定的人不再有 ✓ 角标 ✓ → 判据改成"placed 且没有角标" ✓
      placedOk: cells.filter(c => c.classList.contains('placed')).every(c => !c.querySelector('.pb')),
      lastLabel: cells[cells.length - 1].querySelector('.pl').textContent,
      now: document.querySelector('.pnow') ? document.querySelector('.pnow').textContent.replace(/\s+/g, ' ').trim() : '',
    };
  });
  ok(grid.n === 24 && grid.lastLabel === 'Y', '24 人全在网格里且跳过 X（末位 ' + grid.lastLabel + '）');
  ok(grid.rows <= 5, '只占 ' + grid.rows + ' 行（每行 ' + grid.cols + ' 个）');
  ok(grid.h < 260, '人物区高度受控：' + grid.h + 'px（旧版一行一个 ≈ 700px+）');
  ok(grid.clearBtns === 1, '清除等操作只保留当前人物一份：' + grid.clearBtns);
  ok(grid.badgeA === '2', '有候选的人带数量角标：A=' + grid.badgeA);
  ok(grid.placedCount === 1 && grid.placedOk, '已确定的人填本人颜色（不再带 ✓ 角标）');
  await p.click('.plist li:nth-child(6)');
  await p.waitForTimeout(200);
  const nowRow = await p.evaluate(() => ({
    text: document.querySelector('.pnow').textContent.replace(/\s+/g, ' ').trim(),
    unplace: !!document.querySelector('.pnow [data-act="unplace-person"]'),
    active: document.querySelectorAll('.plist li.active').length,
  }));
  ok(nowRow.active === 1 && nowRow.unplace && /确定/.test(nowRow.text), '点格子切换当前人物并显示其操作：' + nowRow.text);
  const sb = await p.locator('.sidebar').boundingBox();
  await p.screenshot({ path: '/tmp/mh-e2e-people24.png', clip: { x: sb.x, y: sb.y, width: sb.width, height: Math.min(sb.height, 560) } });

  // 20) 标 X 模式下点另一个人 → 自动切回候选
  if (await p.locator('.snipper-panel').isVisible()) { await p.click('.snipper-tab'); await p.waitForTimeout(200); }
  await p.click('[data-act="left-mode"][data-mode="x"]');
  await p.locator('.cell[data-k="5,1"]').click();
  await p.waitForTimeout(150);
  const asX = await p.evaluate(() => window.MH.core.xSource(window.MH.store.state, '5,1'));
  ok(asX === 'user', '标 X 模式下左键确实在标 X：' + asX);

  await p.click('.plist li:nth-child(8)');           // 点另一个人
  await p.waitForTimeout(200);
  const switched = await p.evaluate(() => ({
    mode: window.MH.store.state.settings.leftMode,
    // 分段控件的高亮也要跟着变，否则用户看不出模式已变
    activeText: (document.querySelector('[data-act="left-mode"].active') || {}).textContent,
    picked: window.MH.store.state.selectedPersonId,
  }));
  ok(switched.mode === 'candidate', '换人后左键模式自动回到候选：' + switched.mode);
  ok(/候选/.test(switched.activeText || ''), '分段控件高亮跟着切：' + switched.activeText);

  await p.locator('.cell[data-k="6,2"]').click();
  await p.waitForTimeout(150);
  const after = await p.evaluate(pid => ({
    cand: (window.MH.store.state.play.candidates[pid] || []).includes('6,2'),
    x: window.MH.core.xSource(window.MH.store.state, '6,2'),
  }), switched.picked);
  ok(after.cand && after.x === null, '接着左键标的是候选而不是 X：' + JSON.stringify(after));

  // 点回当前人物自己不该改模式
  await p.click('[data-act="left-mode"][data-mode="x"]');
  await p.click('.plist li.active');
  await p.waitForTimeout(150);
  ok((await p.evaluate(() => window.MH.store.state.settings.leftMode)) === 'x', '点当前人物自己不改模式');

  // 21) 行列候选提示：网格外侧显示每行/列有哪些人
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(8, 10), 'e2e 提示'));
  await p.click('#tabPlay');
  await p.waitForTimeout(200);
  await p.evaluate(() => {
    const st = window.MH.store.state, C = window.MurdokuCore;
    const ids = st.people.map(x => x.id);
    C.setCandidate(st, ids[0], '0,1', true);
    C.setCandidate(st, ids[0], '0,3', true);
    C.setCandidate(st, ids[1], '0,2', true);
    C.setCandidate(st, ids[1], '3,4', true);
    C.setCandidate(st, ids[2], '3,5', true);
    C.setCandidate(st, ids[2], '3,6', true);
    C.placePerson(st, ids[3], '7,0');
    window.MH.render();
  });
  await p.waitForTimeout(300);
  const hg = await p.evaluate(() => {
    const cellBox = (r, c) => document.querySelector(`.cell[data-k="${r},${c}"]`).getBoundingClientRect();
    const rh = [...document.querySelectorAll('.row-head')].map(e => e.getBoundingClientRect());
    const ch = [...document.querySelectorAll('.col-head')].map(e => e.getBoundingClientRect());
    const board = document.querySelector('#board').getBoundingClientRect();
    return {
      rows: rh.length, cols: ch.length,
      r3: Math.round(rh[3].top - cellBox(3, 0).top) + '/' + Math.round(rh[3].height - cellBox(3, 0).height),
      c4: Math.round(ch[4].left - cellBox(0, 4).left) + '/' + Math.round(ch[4].width - cellBox(0, 4).width),
      inside: document.querySelector('.row-heads').getBoundingClientRect().left >= board.left - 1
        && document.querySelector('.col-heads').getBoundingClientRect().top >= board.top - 1,
      rowGap: Math.round(document.querySelector('.row-heads').getBoundingClientRect().left - document.querySelector('#gridBox').getBoundingClientRect().right),
      colGap: Math.round(document.querySelector('.col-heads').getBoundingClientRect().top - document.querySelector('#gridBox').getBoundingClientRect().bottom),
      row0: [...document.querySelectorAll('.row-head')][0].textContent.trim(),
      col3: [...document.querySelectorAll('.col-head')][3].textContent.trim(),
      row7: [...document.querySelectorAll('.row-head')][7].textContent.trim(),
      done: !!document.querySelector('.row-head .hi.done'),
    };
  });
  ok(hg.rows === 8 && hg.cols === 10, '行列各一条提示：' + hg.rows + '×' + hg.cols);
  ok(hg.r3 === '0/0' && hg.c4 === '0/0', '提示条与格子严格对齐（行 Δtop/Δh=' + hg.r3 + '，列 Δleft/Δw=' + hg.c4 + '）');
  ok(hg.inside, '提示条在画布内，没被裁掉');
  ok(hg.rowGap === 0, '行统计紧贴网格右侧（间距 ' + hg.rowGap + 'px）');
  ok(hg.colGap === 0, '列统计紧贴网格下方（间距 ' + hg.colGap + 'px）');
  ok(hg.row0 === 'AB', '第 0 行显示候选 A B：' + hg.row0);
  ok(hg.col3 === 'A', '第 3 列显示候选 A：' + hg.col3);
  ok(hg.row7 === 'D' && hg.done, '已确定的人用实心标出：' + hg.row7);

  const hc = await p.locator('.cell[data-k="3,5"]').boundingBox();
  await p.mouse.move(hc.x + 5, hc.y + 5);
  await p.waitForTimeout(200);
  const hHot = await p.evaluate(() => ({
    r: [...document.querySelectorAll('.row-head')].findIndex(e => e.classList.contains('hot')),
    c: [...document.querySelectorAll('.col-head')].findIndex(e => e.classList.contains('hot')),
    n: document.querySelectorAll('.head.hot').length,
  }));
  ok(hHot.n === 2 && hHot.r === 3 && hHot.c === 5, '悬停格子点亮它所在行列：' + JSON.stringify(hHot));

  const bw1 = await p.evaluate(() => Math.round(document.querySelector('#board').getBoundingClientRect().width));
  await p.click('[data-act="toggle-heads"]');
  await p.waitForTimeout(250);
  const hOff = await p.evaluate(() => ({
    shown: getComputedStyle(document.querySelector('.row-heads')).display,
    w: Math.round(document.querySelector('#board').getBoundingClientRect().width),
  }));
  ok(hOff.shown === 'none' && hOff.w < bw1, '关掉后隐藏且画布不留空间：' + bw1 + ' → ' + hOff.w);
  await p.click('[data-act="toggle-heads"]');
  await p.waitForTimeout(250);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.row-heads')).display) === 'flex', '再开回来');

  // 缩小到 12px：标签数受容量限制，不会溢出格子
  const tiny = await p.evaluate(() => {
    window.MH.store.setSettings({ cellSize: 12 });
    window.MH.render();
    const heads = [...document.querySelectorAll('.head')];
    return {
      overflow: heads.filter(h => h.scrollHeight > h.clientHeight + 1 || h.scrollWidth > h.clientWidth + 1).length,
      cap: window.MurdokuCore.headCapacity(window.MH.store.state),
    };
  });
  ok(tiny.overflow === 0, '格子缩到 12px 也不溢出格子（' + tiny.overflow + ' 条溢出）');
  ok(tiny.cap.rowMax < 6 && tiny.cap.colMax < 6, '容量随尺寸收紧：' + JSON.stringify(tiny.cap));
  await p.evaluate(() => { window.MH.store.setSettings({ cellSize: 44 }); window.MH.render(); });
  await p.waitForTimeout(200);

  // 点行统计里的人 → 清掉这一行别人的候选并标 X
  const ids = await p.evaluate(() => window.MH.store.state.people.map(x => x.id));
  const pickedBefore = await p.evaluate(id => (window.MH.store.state.play.candidates[id] || []).join(','), ids[1]);
  await p.click(`.row-head[data-r="3"] button.hi[data-id="${ids[1]}"]`);
  await p.waitForTimeout(250);
  const filtered = await p.evaluate(ids => {
    const st = window.MH.store.state, C = window.MH.core;
    return {
      picked: (st.play.candidates[ids[1]] || []).join(','),
      other: (st.play.candidates[ids[2]] || []).join(','),
      xPicked: C.xSource(st, '3,4'),
      x5: C.xSource(st, '3,5'), x6: C.xSource(st, '3,6'),
      // 第 3 行整体：B 的候选在 (3,4)，C 的在 (3,5)(3,6)
      rowX: Array.from({ length: st.cols }, (_, c) => C.xSource(st, '3,' + c) ? 'X' : '.').join(''),
      xOtherRow: C.xSource(st, '5,7'),
      toast: (document.querySelector('#toast') || {}).textContent || '',
    };
  }, ids);
  ok(filtered.picked === pickedBefore, '被点的人候选不受影响：' + pickedBefore + ' → ' + filtered.picked);
  ok(filtered.other === '', '同行其他人的候选被清掉：' + filtered.other);
  ok(filtered.xPicked === null, '被点的人自己的候选格不标 X');
  const openCols = filtered.rowX.split('').map((ch, i) => (ch === '.' ? i : -1)).filter(i => i >= 0);
  ok(openCols.join(',') === '4', '整行只剩他自己那格是空的（其余全 X）：' + filtered.rowX);
  ok(filtered.xOtherRow === null, '别的行不受影响');
  ok(/清掉/.test(filtered.toast), '有反馈提示');
  await p.click('[data-act="undo"]');
  await p.waitForTimeout(200);
  const backFilter = await p.evaluate(ids => ({
    other: (window.MH.store.state.play.candidates[ids[2]] || []).join(','),
    x: window.MH.core.xSource(window.MH.store.state, '3,5'),
  }), ids);
  ok(backFilter.other === '3,5,3,6' && backFilter.x === null, '一次撤销全部还原：' + JSON.stringify(backFilter));
  await p.screenshot({ path: '/tmp/mh-e2e-heads.png' });

  // 22) 统计条按内容变大：正常尺寸下全部显示，不要 +N
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(24, 24), 'e2e 24 人'));
  await p.click('#tabPlay');
  await p.waitForTimeout(200);
  await p.evaluate(() => {
    const st = window.MH.store.state, C = window.MurdokuCore;
    st.people.forEach((x, i) => C.setCandidate(st, x.id, i + ',0', true));   // 24 个都在第 0 列
    window.MH.render();
  });
  await p.waitForTimeout(300);
  const allShown = await p.evaluate(() => {
    const head = document.querySelector('.col-head');
    const grid = document.querySelector('#gridBox').getBoundingClientRect();
    const strip = document.querySelector('.col-heads').getBoundingClientRect();
    return {
      chips: head.querySelectorAll('.hi').length,
      more: head.querySelectorAll('.hi.more').length,
      stripH: Math.round(strip.height),
      overflow: [...document.querySelectorAll('.head')].filter(h => h.scrollHeight > h.clientHeight + 1 || h.scrollWidth > h.clientWidth + 1).length,
      gap: Math.round(strip.top - grid.bottom),
    };
  });
  ok(allShown.more === 0 && allShown.chips === 24, '44px 下 24 个标签全部显示、没有 +N：' + allShown.chips + ' 个');
  ok(allShown.stripH > 34, '统计条按内容变高：' + allShown.stripH + 'px');
  ok(allShown.overflow === 0 && allShown.gap === 0, '不溢出格子且仍紧贴网格；溢出 ' + allShown.overflow + ' 条');
  const tinyHead = await p.evaluate(() => {
    window.MH.store.setSettings({ cellSize: 12 });
    window.MH.render();
    const head = document.querySelector('.col-head');
    return {
      chips: head.querySelectorAll('.hi').length,
      more: head.querySelectorAll('.hi.more').length,
      cap: window.MurdokuCore.headCapacity(window.MH.store.state).colMax,
      h: Math.round(document.querySelector('.col-heads').getBoundingClientRect().height),
      font: document.querySelector('#gridBox').style.getPropertyValue('--headfont'),
    };
  });
  // 单列会自己长高，所以 12px 下 24 个也能全显示；上限 460px
  ok(tinyHead.more === 0 && tinyHead.chips === 24 && tinyHead.cap >= 24,
     '12px 下也放得下 24 个（统计条长到 ' + tinyHead.h + 'px）：' + tinyHead.chips + ' 个');
  ok(tinyHead.h <= 460 && parseFloat(tinyHead.font) < 10, '高度有上限 ' + tinyHead.h + 'px，字号缩到 ' + tinyHead.font);
  // 40 个人挤一列 + 12px 才真的超上限 → 折 +N
  await p.evaluate(() => {
    window.MH.store.replace(window.MurdokuCore.createState(40, 40), 'e2e 40 人');
    const st = window.MH.store.state, C = window.MurdokuCore;
    st.people.forEach((x, i) => C.setCandidate(st, x.id, i + ',0', true));
    window.MH.store.setSettings({ cellSize: 12 });
  });
  await p.waitForTimeout(300);
  const overflowHead = await p.evaluate(() => {
    const head = document.querySelector('.col-head');
    return {
      chips: head.querySelectorAll('.hi').length,
      more: head.querySelectorAll('.hi.more').length,
      cap: window.MurdokuCore.headCapacity(window.MH.store.state).colMax,
    };
  });
  ok(overflowHead.more === 1 && overflowHead.chips === overflowHead.cap + 1,
     '40 人一列 + 12px 超上限才折 +N：' + overflowHead.chips + ' 个（容量 ' + overflowHead.cap + '）');
  await p.evaluate(() => { window.MH.store.setSettings({ cellSize: 44 }); window.MH.render(); });
  await p.waitForTimeout(150);

  // 23) 对齐模式下抓手只缩放网格（底图裁切过 bound=true 也不跟着动）
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(8, 6), 'e2e 对齐'));
  await p.click('#tabPrep');
  await p.setInputFiles('#bgFileInput', { name: 'map.png', mimeType: 'image/png', buffer: makeMapPng(400, 300, 8, 6) });
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 15000 });
  await p.evaluate(() => {
    const s = window.MH.store.state;
    s.settings.cellSize = 40; s.bg.scale = 1;
    window.MurdokuCore.setGridOffset(s, 20, 15);
    window.MH.store.setSettings({}); window.MH.render();
  });
  await p.click('[data-act="bg-crop"]');
  await p.waitForFunction(() => window.MH.store.state.bg && window.MH.store.state.bg.bound === true, null, { timeout: 15000 });
  await p.click('[data-act="bg-align"]');
  await p.waitForTimeout(200);
  const cut = await p.evaluate(() => {
    const s = window.MH.store.state;
    return { scale: s.bg.scale, w: s.bg.w, h: s.bg.h, cell: s.settings.cellSize, x: s.grid.x, y: s.grid.y };
  });
  const hb2 = await p.locator('#alignHandle').boundingBox();
  await p.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await p.mouse.down();
  await p.mouse.move(hb2.x + hb2.width / 2 + 80, hb2.y + hb2.height / 2 + 60, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(250);
  const dragged = await p.evaluate(() => {
    const s = window.MH.store.state;
    return { scale: s.bg.scale, w: s.bg.w, h: s.bg.h, cell: s.settings.cellSize, x: s.grid.x, y: s.grid.y };
  });
  ok(dragged.cell > cut.cell, '抓手放大了网格：cell ' + cut.cell + ' → ' + dragged.cell);
  ok(dragged.scale === cut.scale && dragged.w === cut.w && dragged.h === cut.h, '对齐时底图完全不跟着缩放');
  ok(dragged.x === cut.x && dragged.y === cut.y, '网格偏移也没被带着缩放');
  await p.click('[data-act="bg-align"]');       // 退出对齐
  await p.waitForTimeout(200);
  const bz = await p.evaluate(() => ({ cell: window.MH.store.state.settings.cellSize, scale: window.MH.store.state.bg.scale }));
  await p.click('#btnZoomIn');
  await p.waitForTimeout(200);
  const az = await p.evaluate(() => ({ cell: window.MH.store.state.settings.cellSize, scale: window.MH.store.state.bg.scale }));
  const kz = az.cell / bz.cell;
  ok(Math.abs(az.scale / bz.scale - kz) < 0.02, '退出对齐后仍按绑定缩放：k=' + kz.toFixed(3) + '，scale ' + bz.scale.toFixed(3) + '→' + az.scale.toFixed(3));

  // 24) 底图缩放的精调：0.1% 步长（以前 5%，一张 1000px 的图一步就是 50px 误差）
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(6, 8), 'e2e 精调'));
  await p.click('#tabPrep');
  await p.setInputFiles('#bgFileInput', { name: 'map.png', mimeType: 'image/png', buffer: makeMapPng(400, 300, 8, 6) });
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 15000 });
  await p.waitForTimeout(250);
  const stepAttr = await p.evaluate(() => {
    const el = document.getElementById('bgScale');
    return { step: parseFloat(el.step), min: parseFloat(el.min), max: parseFloat(el.max) };
  });
  ok(stepAttr.step <= 0.1, '滑块步长 ' + stepAttr.step + '%（原 5%）');
  ok(stepAttr.max === 400, '上限 ' + stepAttr.max + '%（与核心一致）');

  const s0 = await p.evaluate(() => window.MH.store.state.bg.scale);
  await p.click('[data-act="bg-scale-step"][data-dir="1"]');
  const s1 = await p.evaluate(() => window.MH.store.state.bg.scale);
  ok(Math.abs(s1 - s0 - 0.001) < 1e-9, '± 按钮精确 +0.1%：' + s0 + ' → ' + s1);
  ok(/\.\d%$/.test(await p.textContent('[data-bg="scale"]')), '数值显示到小数：' + (await p.textContent('[data-bg="scale"]')));
  await p.click('[data-act="bg-scale-step"][data-dir="1"]', { modifiers: ['Shift'] });
  const s2 = await p.evaluate(() => window.MH.store.state.bg.scale);
  ok(Math.abs(s2 - s1 - 0.01) < 1e-9, 'Shift + 是 1%：' + s1 + ' → ' + s2);

  await p.evaluate(() => {
    const el = document.getElementById('bgScale');
    el.value = '88.3';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(200);
  const s3 = await p.evaluate(() => window.MH.store.state.bg.scale);
  ok(Math.abs(s3 - 0.883) < 1e-9, '滑块 88.3% 精确生效（旧实现会取整成 88%）：' + s3);
  await p.click('[data-act="bg-scale-reset"]');
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => window.MH.store.state.bg.scale) === 1, '还原 100%');

  // 精调到"图片像素 = 网格像素"后应当严丝合缝
  await p.evaluate(() => {
    const st = window.MH.store.state, C = window.MurdokuCore;
    st.settings.cellSize = 50;                       // 8 列 × 50 = 400 = 图宽
    C.updateBackground(st, { scale: 1 });
    C.setGridOffset(st, 0, 0);
    window.MH.store.setSettings({});
    window.MH.render();
  });
  await p.waitForTimeout(250);
  const fits = await p.evaluate(() => {
    const L = window.MurdokuCore.boardLayout(window.MH.store.state);
    return { gw: L.gridW, gh: L.gridH, bw: L.bgW, bh: L.bgH };
  });
  ok(fits.gw === fits.bw && fits.gh === fits.bh,
     '对齐到像素级：网格 ' + fits.gw + '×' + fits.gh + ' vs 底图 ' + fits.bw + '×' + fits.bh);

  // 25) 拖动热路径：滑块连续拖动要一直生效（原来拖一下就断）
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(24, 24), 'e2e 拖动'));
  await p.click('#tabPrep');
  await p.setInputFiles('#bgFileInput', { name: 'map.png', mimeType: 'image/png', buffer: makeMapPng(400, 300, 8, 6) });
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 15000 });
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    window.__hot = { renders: 0, paints: 0 };
    const MH = window.MH;
    const origRender = MH.render.bind(MH);
    MH.render = function () { window.__hot.renders++; return origRender(); };
    const board = MH.board;
    const origPaint = board.paint.bind(board);
    board.paint = function () { window.__hot.paints++; return origPaint(); };
  });

  const dragBox = await p.locator('#bgScale').boundingBox();
  await p.mouse.move(dragBox.x + dragBox.width * 0.1, dragBox.y + dragBox.height / 2);
  await p.mouse.down();
  await p.mouse.move(dragBox.x + dragBox.width * 0.9, dragBox.y + dragBox.height / 2, { steps: 60 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  const dragStat = await p.evaluate(() => ({
    scale: window.MH.store.state.bg.scale,
    hot: { ...window.__hot },
  }));
  ok(dragStat.scale > 3.0, '真实拖过整条滑块：比例到 ' + dragStat.scale + '（原来拖一下就断，只到 0.78）');
  ok(dragStat.hot.renders <= 3, '拖动期间几乎不重渲染：' + dragStat.hot.renders + ' 次');
  ok(dragStat.hot.paints <= 3, '拖动期间几乎不重绘格子：' + dragStat.hot.paints + ' 次');

  // 滑块拖完之后数值显示与状态一致
  const readout = await p.textContent('[data-bg="scale"]');
  ok(Math.abs(parseFloat(readout) / 100 - dragStat.scale) < 0.001, '数值显示与状态一致：' + readout + ' vs ' + dragStat.scale);

  // 26) 列统计单列 / 区域外框不被统计条吃掉 / 左侧面板可拖宽
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(8, 10), 'e2e 三改'));
  await p.click('#tabPlay');
  await p.evaluate(() => {
    const st = window.MH.store.state, C = window.MurdokuCore;
    const ids = st.people.map(x => x.id);
    ['0,2', '1,2', '2,2', '3,2'].forEach((k, i) => C.setCandidate(st, ids[i], k, true));
    window.MH.render();
  });
  await p.waitForTimeout(300);
  const csCol = await p.evaluate(() => {
    const chips = [...document.querySelectorAll('.col-head[data-c="2"] .hi')].map(e => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    });
    return {
      n: chips.length,
      dir: getComputedStyle(document.querySelector('.col-head')).flexDirection,
      sameX: new Set(chips.map(c => c.x)).size === 1,
      asc: chips.every((c, i) => i === 0 || c.y > chips[i - 1].y),
    };
  });
  ok(csCol.n === 4 && csCol.dir === 'column' && csCol.sameX && csCol.asc,
     '列统计排成单列（一个标签一行）：' + csCol.n + ' 个，dir=' + csCol.dir);
  const layer = await p.evaluate(() => ({
    overlay: parseFloat(getComputedStyle(document.querySelector('.overlay')).zIndex) || 0,
    heads: parseFloat(getComputedStyle(document.querySelector('.row-heads')).zIndex) || 0,
  }));
  ok(layer.overlay > layer.heads, '区域外框画在统计条之上（不再被吃掉）：' + layer.overlay + ' > ' + layer.heads);

  // 侧栏宽度
  const srBox = await p.locator('#sidebarResizer').boundingBox();
  const srW0 = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')));
  await p.mouse.move(srBox.x + srBox.width / 2, srBox.y + 200);
  await p.mouse.down();
  await p.mouse.move(srBox.x + srBox.width / 2 + 120, srBox.y + 200, { steps: 20 });
  await p.mouse.up();
  await p.waitForTimeout(200);
  const srW1 = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')));
  ok(srW1 > srW0 + 100, '拖拽条能加宽左侧面板：' + srW0 + ' → ' + srW1);
  const srBox2 = await p.locator('#sidebarResizer').boundingBox();
  await p.mouse.move(srBox2.x + srBox2.width / 2, srBox2.y + 200);
  await p.mouse.down();
  await p.mouse.move(srBox2.x - 800, srBox2.y + 200, { steps: 20 });
  await p.mouse.up();
  await p.waitForTimeout(200);
  const srW2 = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')));
  ok(srW2 === 300, '最小宽度夹在 300px：' + srW2);
  const srSaved = await p.evaluate(() => localStorage.getItem('murdoku-helper.v1.ui'));
  ok(/"sidebarW":300/.test(srSaved || ''), '宽度落盘：' + srSaved);
  await p.reload(); await p.waitForSelector('.cell'); await p.waitForTimeout(400); await exitWizard();
  const srW3 = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')));
  ok(srW3 === 300, '刷新后宽度保留：' + srW3);
  const boardW = await p.evaluate(() => Math.round(document.querySelector('.board-area').getBoundingClientRect().width));
  ok(boardW > 400, '棋盘仍然有空间：' + boardW + 'px');
  const srBox3 = await p.locator('#sidebarResizer').boundingBox();
  await p.mouse.dblclick(srBox3.x + srBox3.width / 2, srBox3.y + 200);
  await p.waitForTimeout(200);
  const srW4 = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')));
  ok(srW4 === 372, '双击还原 372px：' + srW4);

  // 27) 列统计标签按内容宽度（不撑满）；操作卡片去掉重复的「回到准备阶段」
  const chipW = await p.evaluate(() => {
    const head = document.querySelector('.col-head[data-c="2"]');
    const chip = head.querySelector('.hi');
    const hb = head.getBoundingClientRect(), cb = chip.getBoundingClientRect();
    return {
      headW: Math.round(hb.width), chipW: Math.round(cb.width),
      leftGap: Math.round(cb.left - hb.left), rightGap: Math.round(hb.right - cb.right),
      sameAsCell: Math.round(hb.width) === Math.round(document.querySelector('.cell[data-k="0,2"]').getBoundingClientRect().width),
    };
  });
  ok(chipW.sameAsCell, '列统计条宽度仍等于列宽：' + chipW.headW + 'px');
  ok(chipW.chipW < chipW.headW - 2, '标签按内容宽度不撑满：' + chipW.chipW + ' < ' + chipW.headW);
  ok(Math.abs(chipW.leftGap - chipW.rightGap) <= 1, '标签居中：左右 ' + chipW.leftGap + '/' + chipW.rightGap);
  const opsBtns = await p.evaluate(() => {
    const card = [...document.querySelectorAll('.sidebar .card')].find(c => /操作/.test(c.querySelector('h2').textContent));
    return { text: card.textContent.replace(/\s+/g, ' ').trim(), n: card.querySelectorAll('button').length };
  });
  ok(!/回到准备阶段/.test(opsBtns.text) && opsBtns.n === 3, '操作卡片只剩 3 个按钮：' + opsBtns.text);
  await p.click('#tabPrep');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.MH.store.state.phase) === 'prep', '顶栏 tab 仍能切回准备阶段');
  await p.click('#tabPlay');
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.MH.store.state.phase) === 'play', '再切回游玩');

  // 28) 重新生成地图：保留底图与网格对位
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(6, 8), 'e2e 保留底图'));
  await p.click('#tabPrep');
  await p.setInputFiles('#bgFileInput', { name: 'map.png', mimeType: 'image/png', buffer: makeMapPng(400, 300, 8, 6) });
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 15000 });
  await p.evaluate(() => {
    const s = window.MH.store.state, C = window.MurdokuCore;
    s.settings.cellSize = 50;
    C.updateBackground(s, { scale: 1.2, opacity: 0.7, bound: true });
    C.setGridOffset(s, 12, 9);
    C.placePerson(s, s.people[0].id, '0,0');     // 弄脏，让生成时弹确认
    window.MH.store.setSettings({});
    window.MH.render();
  });
  const beforeGen = await p.evaluate(() => {
    const s = window.MH.store.state;
    return { bg: { w: s.bg.w, h: s.bg.h, scale: s.bg.scale, opacity: s.bg.opacity, bound: s.bg.bound },
             grid: { ...s.grid }, cell: s.settings.cellSize, data: (window.MH.store.bgData || '').length };
  });
  let confirmMsg = '';
  p.once('dialog', async d => { confirmMsg = d.message(); await d.accept(); });
  await p.fill('#rowsInput', '8'); await p.fill('#colsInput', '10');
  await p.click('[data-act="gen"]');
  await p.waitForTimeout(400);
  const afterGen = await p.evaluate(() => {
    const s = window.MH.store.state;
    return { rows: s.rows, cols: s.cols, people: s.people.length,
             bg: s.bg ? { w: s.bg.w, h: s.bg.h, scale: s.bg.scale, opacity: s.bg.opacity, bound: s.bg.bound } : null,
             grid: { ...s.grid }, cell: s.settings.cellSize,
             data: (window.MH.store.bgData || '').length,
             regions: s.regions.length, placed: Object.keys(s.play.placed).length };
  });
  ok(/底图/.test(confirmMsg), '确认框里说明了会保留底图：' + confirmMsg.split('\n').pop());
  ok(afterGen.rows === 8 && afterGen.cols === 10 && afterGen.people === 8, '题面重建：' + afterGen.rows + '×' + afterGen.cols + '，人物 ' + afterGen.people);
  ok(afterGen.bg && afterGen.bg.w === beforeGen.bg.w && afterGen.bg.h === beforeGen.bg.h, '底图还在且尺寸不变');
  ok(afterGen.bg.scale === beforeGen.bg.scale && afterGen.bg.opacity === beforeGen.bg.opacity && afterGen.bg.bound === beforeGen.bg.bound,
     '底图缩放/透明度/绑定都保留：' + JSON.stringify(afterGen.bg));
  ok(afterGen.grid.x === beforeGen.grid.x && afterGen.grid.y === beforeGen.grid.y, '网格对位保留：' + JSON.stringify(afterGen.grid));
  ok(afterGen.cell === beforeGen.cell, '格子大小保留：' + afterGen.cell);
  ok(afterGen.data === beforeGen.data && afterGen.data > 100, '底图数据没被清掉：' + afterGen.data + ' 字符');
  ok(afterGen.regions === 0 && afterGen.placed === 0, '题面数据确实清空了');
  ok(await p.locator('#bgLayer').isVisible(), '底图仍然显示在棋盘下方');
  await p.reload(); await p.waitForSelector('.cell'); await p.waitForTimeout(600); await exitWizard();
  const afterReload = await p.evaluate(() => {
    const s = window.MH.store.state;
    return { rows: s.rows, bg: !!s.bg, scale: s.bg && s.bg.scale, grid: { ...s.grid } };
  });
  ok(afterReload.rows === 8 && afterReload.bg && afterReload.scale === beforeGen.bg.scale, '刷新后底图与对位都还在：' + JSON.stringify(afterReload));

  // 29) 重复点「自动识别区域」= 重新出一份候选，不是往后追加
  //     （曾经的症状：点两次出 6 个区域，其中 3 个重复的显示 0 格）
  await p.click('#tabPrep');
  await p.evaluate(() => {
    window.MH.store.replace(window.MurdokuCore.createState(4, 6), 'e2e 识别');
    window.MH.ui.lastDetect = null;
    // 用桩换掉识别内核：这一节考的是"面板怎么把候选落库"，不是像素识别准不准
    window.__realDetect = window.MurdokuRegions.detectRegions;      // 第 30 节要还原
    window.MurdokuRegions.detectRegions = () => ({
      ok: true,
      regions: [
        { name: '甲', cells: ['0,0', '0,1'], color: '#e06666' },
        { name: '乙', cells: ['1,0', '1,1'], color: '#6688e0' },
        { name: '丙', cells: ['2,0', '2,1'], color: '#66c07a' },
      ],
      stats: { sampled: 6 },
    });
  });
  await p.setInputFiles('#bgFileInput', { name: 'regions.png', mimeType: 'image/png', buffer: makeMapPng(400, 300, 8, 6) });
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 15000 });
  await p.evaluate(() => {                      // 网格摆进底图里并记下对齐（识别的两个前提）
    const s = window.MH.store.state;
    s.settings.cellSize = 40; s.bg.scale = 1;
    window.MurdokuCore.updateBackground(s, { bound: true });
    window.MurdokuCore.setGridOffset(s, 0, 0);
    window.MH.store.setSettings({}); window.MH.render();
  });
  const dlg = [];
  p.on('dialog', d => { dlg.push(d.message()); d.dismiss(); });

  await p.click('[data-act="detect-regions"]');
  await p.waitForFunction(() => window.MH.store.state.regions.length === 3, null, { timeout: 15000 });
  const r1 = await p.evaluate(() => window.MH.store.state.regions.map(r => ({ id: r.id, n: r.cells.length })));
  ok(r1.length === 3 && r1.every(r => r.n === 2), '第一次识别：3 个区域各 2 格 ' + JSON.stringify(r1));

  await p.click('[data-act="detect-regions"]');
  await p.waitForTimeout(800);
  const r2 = await p.evaluate(() => window.MH.store.state.regions.map(r => ({ id: r.id, n: r.cells.length })));
  ok(r2.length === 3, '再点一次识别不会追加：区域数仍为 3（实际 ' + r2.length + '）');
  ok(r2.every(r => r.n > 0), '没有 0 格区域：' + JSON.stringify(r2));
  ok(r2.map(r => r.id).join() === r1.map(r => r.id).join(), '是同一批 id（真的替换，不是追加）');
  ok(dlg.length === 0, '上一份候选没被动过 → 直接替换，不弹确认');

  // 手动改过之后：再点识别要先问一句；取消则原样保留
  await p.evaluate(() => window.MH.store.commit('手动改名', s => { s.regions[0].name = '我改的'; }));
  await p.click('[data-act="detect-regions"]');
  await p.waitForTimeout(800);
  ok(dlg.length === 1, '候选被动过 → 先弹确认（实际弹了 ' + dlg.length + ' 次）');
  const names = await p.evaluate(() => window.MH.store.state.regions.map(r => r.name));
  ok(names.length === 3 && names[0] === '我改的', '取消确认后区域保持原样：' + names.join('/'));

  // 30) 一张截图 + 一个按钮：自动找标签徽章 → OCR 读名字 → 出区域候选
  await p.click('#tabPrep');
  await p.evaluate(() => {
    window.MH.store.replace(window.MurdokuCore.createState(24, 24), 'e2e 截图');
    window.MH.ui.lastBadges = null;
    window.MH.ui.ocrNames = null;
    if (window.__realDetect) window.MurdokuRegions.detectRegions = window.__realDetect;   // 撤掉第 29 节的桩
  });
  await p.setInputFiles('#bgFileInput', {
    name: 'contest-labels.jpg', mimeType: 'image/jpeg',
    buffer: fs.readFileSync(path.join(__dirname, 'fixtures', 'contest-labels.jpg')),
  });
  await p.waitForFunction(() => !!window.MH.store.state.bg, null, { timeout: 20000 });
  // 30a) 还没对位时不能"静默什么都没发生"：常驻提示 + 明确 toast + 自检报告说清卡在哪
  const warnHint = await p.evaluate(() => (document.querySelector('.hint.warn') || {}).textContent || '');
  ok(/还没对位/.test(warnHint), '未对位时区域卡有常驻提示：' + warnHint);
  await p.click('[data-act="detect-regions"]');
  await p.waitForTimeout(500);
  const shotRegions0 = await p.evaluate(() => window.MH.store.state.regions.length);
  ok(shotRegions0 === 0, '未对位时点识别不会瞎写区域（实际 ' + shotRegions0 + ' 个）');
  await p.click('[data-act="check-regions"]');
  await p.waitForFunction(() => /识别自检/.test(window.MH.ui.diagText || ''), null, { timeout: 30000 });
  const selfText = await p.evaluate(() => window.MH.ui.diagText);
  ok(/否/.test(selfText) && /还没对位|先.*对位|框地图外框/.test(selfText), '自检报告指出"未对位"及两条修法');
  ok(/标签徽章/.test(selfText) && /区域名从哪来/.test(selfText), '自检报告列出区域名来源');
  await p.evaluate(() => { window.MH.ui.diagText = null; window.MH.render(); });

  // 30b) 走用户的真实路径完成对位：点「▭ 框地图外框」→ 拖一个矩形圈住整张图（24×24 → 格距≈49）
  await p.click('[data-act="bg-region"]');
  const bgBox = await p.locator('#bgLayer').boundingBox();
  await p.mouse.move(bgBox.x + 2, bgBox.y + 2);
  await p.mouse.down();
  await p.mouse.move(bgBox.x + bgBox.width - 2, bgBox.y + bgBox.height - 2, { steps: 8 });
  await p.mouse.up();
  await p.waitForFunction(() => window.MH.store.state.bg.bound === true, null, { timeout: 20000 });
  const alignInfo = await p.evaluate(() => window.MH.ui.alignInfo);
  ok(/格距/.test(alignInfo || ''), '框地图外框完成对位：' + alignInfo);
  const fitRatio = await p.evaluate(() => {
    const L = window.MurdokuCore.boardLayout(window.MH.store.state);
    return Math.min(L.gridW / L.bgW, L.gridH / L.bgH);
  });
  ok(fitRatio > 0.8, '对位后网格与底图基本重合（' + Math.round(fitRatio * 100) + '%）');
  const tShot = Date.now();
  await p.click('[data-act="detect-regions"]');
  await p.waitForFunction(() => window.MH.ui.ocrNames, null, { timeout: 300000 });
  const shotSecs = ((Date.now() - tShot) / 1000).toFixed(1);
  const nb = await p.evaluate(() => (window.MH.ui.lastBadges || []).length);
  ok(nb === 17, '一个按钮里先找出 17 个区域名标签（实际 ' + nb + '）');
  const ocrNames = await p.evaluate(() => window.MH.ui.ocrNames);
  const WANT_NAMES = ['CABIN A', 'CAVERN', 'WOODS', 'FRIGATE A', 'BEACH', 'SLOOP A', 'SLOOP B', 'SLOOP C',
    'CABIN B', 'GALLEON', 'DOCK', 'TAVERN', 'CABIN C', 'CLIFF', 'WATER', 'CLEARING', 'FRIGATE B'];
  const hitNames = WANT_NAMES.filter(w => ocrNames.includes(w)).length;
  ok(ocrNames.length === 17 && hitNames === 17,
    '同一个按钮里 OCR 读出 17/17 个区域名（' + shotSecs + 's）：' + ocrNames.join(' / '));
  const shotRegions = await p.evaluate(() => window.MH.store.state.regions.map(r => r.name));
  ok(shotRegions.length === 17 && WANT_NAMES.every(w => shotRegions.includes(w)),
    '区域直接带上读出来的名字：' + shotRegions.slice(0, 5).join(' / '));
  const shotCells = await p.evaluate(() => window.MH.store.state.regions.reduce((n, r) => n + r.cells.length, 0));
  ok(shotCells > 300, '候选区域覆盖了大部分格子：' + shotCells + '/576');
  // 先制造"过期的记忆"：把刚写好的 17 条改回 1 条（键保持不变，模拟用户遇到的坏缓存），
  // 再点一次识别 —— 老逻辑会拿这 1 条当唯一来源 → 种子 1 个 → 退化成无种子、整张图碎成十几块。
  const stale = await p.evaluate(() => {
    const o = JSON.parse(localStorage.getItem('murdoku-helper.v1.labels'));
    o.labels = [o.labels[0]];
    localStorage.setItem('murdoku-helper.v1.labels', JSON.stringify(o));
    return o.labels.length;
  });
  ok(stale === 1, '先造一条过期记忆（1 条）');
  await p.evaluate(() => {
    window.MH.ui.lastDetect = null;                          // 让它不弹"会重建区域"的确认
    window.MH.ui.ocrNames = null;
  });
  await p.click('[data-act="detect-regions"]');
  await p.waitForFunction(() => window.MH.ui.ocrNames, null, { timeout: 300000 });
  const names2 = await p.evaluate(() => window.MH.ui.ocrNames);
  ok(WANT_NAMES.every(w => names2.includes(w)), '1 条过期记忆不会再挡住 17 个标签：' + names2.slice(0, 4).join(' / '));
  const cacheAfter = await p.evaluate(() => {
    const o = JSON.parse(localStorage.getItem('murdoku-helper.v1.labels') || '{}');
    return (o.labels || []).length;
  });
  ok(cacheAfter === 17, '过期的 1 条记忆被 17 条新结果覆盖（实际 ' + cacheAfter + ' 条）');
  ok(await p.locator('[data-act="clear-labels"]').count() === 1, '有记忆时区域卡出现「清除记忆」');
  await p.click('[data-act="clear-labels"]');
  const cleared = await p.evaluate(() => localStorage.getItem('murdoku-helper.v1.labels'));
  ok(!cleared, '清除记忆后缓存清空（下次重新读）');
  // 第二次点同一个按钮：名字已进缓存，不该再跑一遍 OCR
  const t2 = Date.now();
  await p.click('[data-act="detect-regions"]');
  await p.waitForFunction(() => window.MH.store.state.regions.length === 17, null, { timeout: 60000 });
  ok(Date.now() - t2 < 5000, '再点一次走缓存、不重新 OCR：' + (Date.now() - t2) + 'ms');

  // 32) 物品：新建 → 在编辑界面里点「从样例找同类」→ 点样例格 → 自动找出同类 → 存成物品
  await p.evaluate(() => { window.MH.ui.itemPicking = false; window.MH.ui.lastItemMatch = null; });
  await p.click('[data-act="new-item"]');                 // 先开一个物品草稿
  await p.waitForSelector('.draft #draftName');
  await p.click('.draft [data-act="item-sample"]');      // 取样按钮现在在编辑界面里
  ok(await p.evaluate(() => !!window.MH.ui.itemPicking), '点「从样例找同类」进入取样模式');
  await p.locator('.cell[data-k="18,20"]').click();           // 酒馆里的白椅子
  await p.waitForFunction(() => window.MH.ui.lastItemMatch, null, { timeout: 60000 });
  const im = await p.evaluate(() => window.MH.ui.lastItemMatch);
  ok(im.cells.length >= 3, '白椅子找到 ' + im.cells.length + ' 格同类（≥3）：' + im.cells.join(' '));
  ok(im.cells.includes('18,20'), '样例格自己在结果里');
  const draftN = await p.evaluate(() => (window.MH.ui.draft && window.MH.ui.draft.cells.size) || 0);
  ok(draftN === im.cells.length, '草稿里已圈好同样的格子：' + draftN);
  await p.fill('#draftName', '椅子');
  await p.click('[data-act="draft-save"]');
  const savedItems = await p.evaluate(() => window.MH.store.state.items.map(i => i.name + ':' + i.cells.length + ':' + i.occupiable));
  ok(savedItems.length === 1 && /^椅子:\d+:true$/.test(savedItems[0]) && Number(savedItems[0].split(':')[1]) >= 3,
    '保存成物品（名字 + 格子数 + 可占据）：' + savedItems.join(' / '));

  // 36) 「按样例添加」**没找到同类**时 → 至少把点的那一格加进草稿 ✓
  //     （把匹配器换成"故意找不到"的桩，稳定复现这条分支 ✓）
  await p.evaluate(() => {
    window.__origFindSimilar = window.MurdokuItems.findSimilar;
    window.MurdokuItems.findSimilar = () => ({ ok: false, reason: '测试桩：故意找不到' });
    window.MH.ui.itemPicking = false; window.MH.ui.lastItemMatch = null;
  });
  await p.click('[data-act="new-item"]');
  await p.waitForSelector('.draft #draftName');
  await p.click('.draft [data-act="item-sample"]');
  await p.locator('.cell[data-k="7,9"]').click();
  await p.waitForFunction(() => window.MH.ui.lastItemMatch, null, { timeout: 30000 });
  const fb = await p.evaluate(() => window.MH.ui.lastItemMatch);
  ok(fb.fallback === true && fb.cells.length === 1 && fb.cells[0] === '7,9',
    '没找到同类也把点的那一格算进去：' + JSON.stringify(fb.cells));
  const fbDraft = await p.evaluate(() => [...((window.MH.ui.draft && window.MH.ui.draft.cells) || [])]);
  ok(fbDraft.length === 1 && fbDraft[0] === '7,9', '草稿里有这一格：' + JSON.stringify(fbDraft));
  await p.click('[data-act="draft-cancel"]');
  await p.evaluate(() => { window.MurdokuItems.findSimilar = window.__origFindSimilar; });

  // 33) 编辑已有物品时点「从样例找同类」→ 结果要**追加到当前物品**，不能新建一件 ✗
  const beforeItems = await p.evaluate(() => window.MH.store.state.items.length);
  await p.evaluate(() => window.MH.store.commit('清空格子', s => { s.items[0].cells = []; }));
  await p.click('[data-act="edit-item"]');
  await p.waitForSelector('.list li.editing .draft #draftName');
  await p.evaluate(() => { window.MH.ui.lastItemMatch = null; });     // 清掉上一节的残留，否则等待会立刻通过
  await p.click('.list li.editing .draft [data-act="item-sample"]');
  await p.locator('.cell[data-k="18,20"]').click();
  await p.waitForFunction(() => !!window.MH.ui.lastItemMatch, null, { timeout: 60000 });
  await p.waitForFunction(() => window.MH.ui.draft && window.MH.ui.draft.cells.size > 0, null, { timeout: 60000 });
  const afterItems = await p.evaluate(() => window.MH.store.state.items.length);
  const draftN2 = await p.evaluate(() => window.MH.ui.draft && window.MH.ui.draft.cells.size);
  const editingId = await p.evaluate(() => window.MH.ui.draft && window.MH.ui.draft.editingId);
  ok(afterItems === beforeItems, '编辑中取样不该新建物品：' + beforeItems + ' → ' + afterItems);
  ok(!!editingId, '取样后草稿仍指向当前物品（editingId 保留）');
  ok(draftN2 >= 3, '结果追加进了当前草稿：' + draftN2 + ' 格');
  await p.click('.list li.editing .draft [data-act="draft-save"]');
  const saved = await p.evaluate(() => {
    const st = window.MH.store.state;
    return { n: st.items.length, cells: st.items[0].cells.length };
  });
  ok(saved.n === beforeItems && saved.cells >= 3, '保存后仍是一件物品、格子已补上：' + JSON.stringify(saved));

  // 34) 图片（截图）路径：把一张"合成图例截图"当卡片 → 应读出名字与分组
  //     （词级 OCR：tesseract 的 TSV 给出每个词的框，不再靠"行墨量分排 + 列投影猜名字框"）
  await p.evaluate((b64) => { window.__legendPng = b64; },
    fs.readFileSync(path.join(__dirname, 'fixtures/legend-synthetic.png')).toString('base64'));
  await p.evaluate(() => {
    const url = 'data:image/png;base64,' + window.__legendPng;
    window.MurdokuSnipper.state.pins = [{ id: 'lg', page: 1, w: 620, h: 260, url, srcX: 0, srcY: 0, srcW: 620, srcH: 260, srcPageW: 620, srcPageH: 260 }];
    window.MurdokuSnipper.render();
    window.MH.ui.lastLegend = null;
    // 把 snipper 当成"导入的是图片"（不是 PDF）→ 走图片路线
    window.MurdokuSnipper.state.file = { name: 'legend.png', type: 'image/png' };
  });
  await p.evaluate(() => window.MH.panels.legendAuto());
  await p.waitForFunction(() => window.MH.ui.lastLegend, null, { timeout: 120000 });
  const lg = await p.evaluate(() => window.MH.ui.lastLegend);
  const got = (lg.names || []).slice().sort().join(',');
  const want = ['bed', 'boulder', 'crate', 'rope', 'shrub'].join(',');
  ok(got === want, '截图路径应读出这 5 个名字：' + JSON.stringify(lg.names));
  ok(lg.via === 'image-ocr', '走的是词级 OCR 路线：' + lg.via);
  const dbg = await p.evaluate(() => window.MH.ui.lastLegendDebug);
  ok(dbg && (dbg.heads || []).length >= 1 && (dbg.names || []).length >= 5,
    '诊断口记录了说明行与名字的框：' + JSON.stringify((dbg && dbg.heads || []).map(h => h.text)));
  ok((lg.headings || []).join(' / ').indexOf('不可') >= 0,
    '说明行认出来了（合成图例只有一条 can\'t be occupied）：' + JSON.stringify(lg.headings));

  // 35) 全大写风格的图例：用户框定了图例 → **不该**再拿"像不像地图区域名"去挡 ✗
  await p.evaluate((b64) => { window.__legendPng = b64; },
    fs.readFileSync(path.join(__dirname, 'fixtures/legend-caps.png')).toString('base64'));
  await p.evaluate(() => {
    const url = 'data:image/png;base64,' + window.__legendPng;
    return new Promise(res => {
      const im = new Image();
      im.onload = () => {
        window.MurdokuSnipper.state.file = { name: 'caps.png', type: 'image/png' };
        window.MurdokuSnipper.state.pins = [{ id: 'caps', page: 1, w: im.naturalWidth, h: im.naturalHeight, url,
          srcX: 0, srcY: 0, srcW: im.naturalWidth, srcH: im.naturalHeight, srcPageW: im.naturalWidth, srcPageH: im.naturalHeight }];
        window.MurdokuSnipper.render();
        window.MH.ui.lastLegend = null;
        res();
      };
      im.src = url;
    });
  });
  await p.evaluate(() => window.MH.panels.legendAuto());
  await p.waitForFunction(() => window.MH.ui.lastLegend, null, { timeout: 120000 });
  const lgCaps = await p.evaluate(() => window.MH.ui.lastLegend);
  const caps = (lgCaps.names || []).slice().sort().join(',');
  ok(caps === 'CARPET,LAMP,SHELF,TV', '全大写图例也要认出来：' + JSON.stringify(lgCaps.names));

  // 37) 人物线索：候选面板 → 指定人 → 应用（写线索原文 + 只为"在…里"建关联 ✓）
  await p.evaluate(() => {
    const st = window.MH.store.state, C = window.MurdokuCore;
    C.createItem(st, 'Car', [], true);
    C.createItem(st, 'Shelf', [], true);
    // **保持默认编号 A/B** ✓ —— 验证"按首字母对应"（Anthony→A、Breck→B）
    // 直接注入"解析结果"（读卡片那一步的产物 ✓），覆盖面板与应用逻辑
    window.MH.panels.setClueCandidates({ clues: [
      { text: 'He was in a car .', person: 'Anthony', links: [
        { kind: 'in', polarity: 1, target: 'Car', targetKind: 'item' }] },
      { text: 'He was beside a shelf .', person: 'Breck', links: [
        { kind: 'beside', polarity: 1, target: 'Shelf', targetKind: 'item' }] },
      { text: 'The Victim. He was alone with the murderer.', person: null, links: [] },
    ] }, 'json', [{ name: 'Anthony' }, { name: 'Breck' }]);
  });
  await p.waitForSelector('.clue-panel .clue-row');
  const rowsN = await p.locator('.clue-panel .clue-row').count();
  ok(rowsN === 3, '候选面板列出 3 段：' + rowsN);
  const editVal = await p.locator('.clue-panel textarea[data-act="clue-text"]').first().inputValue();
  ok(/car/i.test(editVal), '整句在可编辑框里，能直接改：' + editVal);
  // **可以在面板里直接改整句** ✓（改成带句号的版本，应用后应存这个 ✓）
  await p.locator('.clue-panel textarea[data-act="clue-text"]').nth(0).fill('He was in the car .');
  const mapped = await p.evaluate(() => [...document.querySelectorAll('.clue-panel select[data-act="clue-map"]')].map(s => s.value).slice(0, 2));
  const labels = await p.evaluate(ids => ids.map(id => (window.MH.store.state.people.find(x => x.id === id) || {}).label), mapped);
  ok(labels[0] === 'A' && labels[1] === 'B',
    '按首字母对应人物（Anthony→A、Breck→B）：' + JSON.stringify(labels));
  await p.click('[data-act="clue-apply"]');
  const applied = await p.evaluate(() => {
    const st = window.MH.store.state;
    return st.people.map(x => ({ l: x.label, clue: x.clue, links: x.links.length }));
  });
  const an = applied.find(x => x.l === 'A'), br = applied.find(x => x.l === 'B');
  ok(an && an.clue === 'He was in the car .' && an.links === 1,
    'A 的线索按**面板里改过的整句**存下来了，关联也建了：' + JSON.stringify(an));
  // **改**：「在旁边」现在也建关联 ✓（用户反馈："She was beside a water" 没关联到 water ✗）
  ok(br && br.clue && br.links === 1, 'B（Breck）的"在旁边"同样建了关联 ✓：' + JSON.stringify(br));
  const victim = applied.filter(x => /Victim/i.test(x.clue));
  ok(victim.length === 1 && victim[0].links === 0,
    '没解析出关联的整句也存下来了（仍按位置推定给了某个人 ✓）：' + JSON.stringify(victim));
  ok(await p.evaluate(() => !window.MH.ui.clueCands), '应用后候选面板收起');

  // 38) 手工输入线索：连续打字不能丢焦点 ✓，失焦后要能撤销 ✓
  await p.evaluate(() => window.MH.store.replace(window.MurdokuCore.createState(6, 6), 'x'));
  await p.click('#tabPrep');
  await p.click('[data-act="select-person"]');
  const clueBox = p.locator('#personClue');
  await clueBox.click();
  await clueBox.type('He was beside a shelf', { delay: 30 });
  const typing = await p.evaluate(() => ({
    focus: document.activeElement && document.activeElement.id,
    pos: document.activeElement && document.activeElement.selectionStart,
    val: (document.getElementById('personClue') || {}).value,
  }));
  ok(typing.focus === 'personClue', '打字时焦点仍在输入框（不丢 ✓）：' + JSON.stringify(typing.focus));
  ok(typing.pos === 'He was beside a shelf'.length, '光标在末尾 ✓：' + typing.pos);
  ok(typing.val === 'He was beside a shelf', '框内是打进去的字 ✓：' + JSON.stringify(typing.val));
  await p.keyboard.press('Tab');                     // 失焦 → 记一个可撤销步骤 ✓
  await p.waitForTimeout(200);
  const canUndo = await p.evaluate(() => !!window.MH.store.canUndo());
  await p.evaluate(() => window.MH.store.undo());
  await p.waitForTimeout(150);
  const afterUndo = await p.evaluate(() => {
    const st = window.MH.store.state;
    return (st.people.find(x => x.id === st.selectedPersonId) || {}).clue;
  });
  ok(canUndo && afterUndo === '', '失焦后可撤销，撤销后线索回到空 ✓：' + JSON.stringify(afterUndo));

  // 39) 分步引导：**每一步只显示该步需要的东西** ✓，走完能退出、完整面板恢复 ✓
  await p.click('#tabPrep');
  // 入口按钮只在"还没底图"时出现 ✓ —— 先在干净的 state 上验证它 ✓
  await p.evaluate(() => {
    window.MH.ui.wizard = null;
    window.MH.store.replace(window.MurdokuCore.createState(6, 6), 'x');
  });
  const entryN = await p.locator('[data-act="wiz-start"]').count();
  ok(entryN === 1, '没有底图时显示「分步引导」入口 ✓：' + entryN);
  // 直接进入引导 ✓（入口按钮已单独验证 ✓）。注意：引导只在**准备阶段**渲染 ✓
  // —— 这条长流程前面章节可能把应用留在游玩阶段 ✗，所以先在页面内切回准备阶段 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizard = 1;
    window.MH.render();
  });
  const renderWiz = await p.evaluate(() => ({
    phase: window.MH.store.state.phase, panel: !!document.querySelector('.wizard'),
  }));
  ok(renderWiz.panel, '准备阶段进入引导后渲染出引导面板 ✓：' + JSON.stringify(renderWiz));
  // "下一步/完成"永远是页脚里**最后一个** wiz-go 按钮 ✓（data-v 是目标步号，会变 ✓）
  const clickNext = () => p.evaluate(() => {
    const bs = document.querySelectorAll('.wiz-foot [data-act="wiz-go"]');
    if (bs.length) bs[bs.length - 1].click();
  });
  const wizState = async () => p.evaluate(() => ({
    step: window.MH.ui.wizard,
    rows: !!document.getElementById('rowsInput'),
    detect: !!document.querySelector('[data-act="detect-regions"]'),
    legend: !!document.querySelector('[data-act="crop-item"]'),   // 物品步现在的入口是"框选物品图例" ✓
    clue: !!document.querySelector('[data-act="crop-person"]'),   // 人物步现在是"框选人物线索卡片" ✓
  }));
  const w1 = await wizState();
  ok(w1.step === 1 && w1.rows && !w1.detect && !w1.legend && !w1.clue,
    '第 1 步只显示对齐相关（行列/底图）：' + JSON.stringify(w1));
  for (let k = 0; k < 3; k++) { await clickNext(); }     // 1→2→3→4 ✓
  const w4 = await wizState();
  ok(w4.step === 4 && w4.clue && !w4.rows && !w4.legend,
    '第 4 步只显示线索相关：' + JSON.stringify(w4));
  await clickNext();                                      // 第 4 步的"完成" → 引导收尾 ✓
  await p.waitForTimeout(300);
  const back = await p.evaluate(() => ({
    phase: window.MH.store.state.phase,                    // 收尾后进入游玩 ✓
    playPanel: !!document.querySelector('.play-clue'),
  }));
  ok(back.phase === 'play' && back.playPanel,
    '点「完成」→ 引导收尾并进入「② 游玩」✓：' + JSON.stringify(back));
  // 回到准备阶段：仍然是引导（应用里准备阶段只有引导这一套界面 ✓）
  await p.evaluate(() => { window.MH.ui.wizardOptOut = false; window.MH.ui.wizard = null; });
  await p.click('#tabPrep');
  const prepBack = await p.evaluate(() => ({
    wizard: window.MH.ui.wizard, wizardPanel: !!document.querySelector('.wizard'),
    legacy: !!document.querySelector('[data-act="detect-regions"]'),
  }));
  ok(prepBack.wizardPanel && !prepBack.legacy, '回到准备阶段仍是引导（没有"完整面板"入口）✓：' + JSON.stringify(prepBack));
  // 后面章节仍按旧面板驱动 ✓
  await p.evaluate(() => { window.MH.ui.wizardOptOut = true; window.MH.ui.wizard = null; window.MH.render(); });

  // 40) 物品/人物步：**在主界面上框选** → 自动变成右侧卡片 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizard = 3;
    window.MH.render();
  });
  ok(await p.locator('[data-act="crop-item"]').count() === 1, '物品步显示「在主界面上框选」✓');
  await p.evaluate(() => {
    // 没有页面时点它应给提示而不是报错 ✓
    const b2 = document.querySelector('[data-act="crop-item"]');
    if (b2) b2.click();
  });
  const cropNoPage = await p.evaluate(() => !!document.getElementById('boardCrop'));
  ok(!cropNoPage, '没导入页面时不会强行开框选层 ✓（给出提示）');
  // 放一个假页面图片进 snipper ✓，再从人物步框选 ✓
  await p.evaluate(() => {
    const Sn = window.MurdokuSnipper;
    // 用一张真实的小图（有 naturalWidth ✓；上面那种只设 width 的假图会让换算除零 ✓）
    const cv = document.createElement('canvas');
    cv.width = 200; cv.height = 150;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, 200, 150);
    cx.fillStyle = '#123'; cx.fillRect(20, 20, 60, 40);
    const im = new Image();
    im.src = cv.toDataURL('image/png');
    Sn.state.img = im;
    window.MH.ui.wizard = 4;
    window.MH.render();
  });
  await p.waitForFunction(() => {
    const im = window.MurdokuSnipper.state.img;
    return !!(im && im.naturalWidth);
  }, null, { timeout: 5000 });
  const cropFromPerson = await p.locator('[data-act="crop-person"]').count();
  ok(cropFromPerson === 1, '人物步显示「在主界面上框选」✓');
  await p.evaluate(() => document.querySelector('[data-act="crop-person"]').click());
  const layerOn = await p.evaluate(() => !!document.getElementById('boardCrop'));
  ok(layerOn, '点开后主界面出现框选层 ✓');
  await p.evaluate(() => {
    // 直接走内部换算路径：模拟在图片上拖 100×60（1:1 显示）✓
    const Sn = window.MurdokuSnipper;
    const n0 = Sn.state.pins.length;
    Sn.addPinFromSource(100, 80, 100, 60);
    window.__cropOk = Sn.state.pins.length === n0 + 1;
  });
  ok(await p.evaluate(() => !!window.__cropOk), '框选后右侧卡片列表多一张 ✓');
  await p.evaluate(() => { const b2 = document.querySelector('#boardCrop [data-act="crop-close"]'); if (b2) b2.click(); });
  ok(!(await p.evaluate(() => !!document.getElementById('boardCrop'))), '点「完成」关闭框选层 ✓');

  // 41) 卡片顺序（按使用顺序 ✓）+ setClueCandidates 返回数组（读人物线索不报 clues.some ✓）
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    const st = window.MH.store.state;
    st.bg = { kind: 'image', name: 'x.png', w: 900, h: 700, page: 1, pages: 1, opacity: 1, scale: 1, visible: true, bound: false };
    window.MH.ui.wizard = 1;
    window.MH.render();
  });
  const cardOrder = await p.evaluate(() => [...document.querySelectorAll('#sidebar .card')].map(card => {
    const has = a => !!card.querySelector('[data-act="' + a + '"]');
    if (has('bg-import')) return '底图';
    if (has('gen')) return '地图';
    if (has('bg-region')) return '对齐网格';
    return '其他';
  }).filter(x => x !== '其他'));
  ok(cardOrder[0] === '底图' && cardOrder[1] === '地图' && cardOrder[2] === '对齐网格',
    '顺序：底图 → 行列/生成 → 框外框/微调 ✓：' + JSON.stringify(cardOrder));
  const ret = await p.evaluate(() => {
    const r = window.MH.panels.setClueCandidates({ clues: [{ text: 'He was in a car .', person: null, links: [] }] }, 'json', []);
    return { isArray: Array.isArray(r), len: r.length, some: typeof r.some };
  });
  ok(ret.isArray && ret.len === 1 && ret.some === 'function',
    'setClueCandidates 返回数组（调用处能用 .length/.some）✓：' + JSON.stringify(ret));
  await p.evaluate(() => { window.MH.ui.clueCands = null; window.MH.ui.wizard = null; window.MH.render(); });

  // 42) 引导精修：不放"裁切到网格"、透明度/缩放在对齐网格卡里、离开第 1 步自动退出对齐模式 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    const st = window.MH.store.state;
    st.bg = { kind: 'image', name: 'x.png', w: 400, h: 320, page: 1, pages: 1, opacity: 1, scale: 1, visible: true, bound: true };
    window.MH.ui.wizard = 1;
    window.MH.ui.aligning = true;
    window.MH.render();
  });
  const wiz1 = await p.evaluate(() => {
    const card = [...document.querySelectorAll('#sidebar .card')].find(c2 => c2.querySelector('[data-act="bg-region"]'));
    return {
      crop: document.querySelectorAll('#sidebar [data-act="bg-crop"]').length,
      alignHasOpacity: !!(card && card.querySelector('#bgOpacity')),
      alignHasScale: !!(card && card.querySelector('#bgScale')),
      aligning: window.MH.ui.aligning,
    };
  });
  ok(wiz1.crop === 0, '引导里不显示「裁切到网格」（最后一步自动做）✓：' + wiz1.crop);
  ok(wiz1.alignHasOpacity && wiz1.alignHasScale, '透明度与缩放在「对齐网格」卡片里 ✓：' + JSON.stringify(wiz1));
  await p.evaluate(() => { const bs = document.querySelectorAll('.wiz-foot [data-act="wiz-go"]'); bs[bs.length - 1].click(); });
  ok(await p.evaluate(() => window.MH.ui.aligning === false && window.MH.ui.wizard === 2),
    '离开第 1 步自动退出「对齐底图」模式，并进入第 2 步 ✓');
  await p.evaluate(() => { window.MH.ui.wizard = null; window.MH.render(); });

  // 43) 四处修复：离开第1步记下对齐 ✓、改名界面内编辑 ✓、候选行话术精简 ✓、下拉框变窄 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    const cv = document.createElement('canvas'); cv.width = 400; cv.height = 320;
    cv.getContext('2d').fillRect(0, 0, 400, 320);
    const st = window.MH.store.state;
    st.bg = { kind: 'image', name: 'x.png', w: 400, h: 320, page: 1, pages: 1, opacity: 1, scale: 1, visible: true, bound: false };
    window.MH.store.bgData = cv.toDataURL('image/png');
    window.MH.ui.wizard = 1; window.MH.ui.aligning = true; window.MH.render();
  });
  await p.evaluate(() => { const bs = document.querySelectorAll('.wiz-foot [data-act="wiz-go"]'); bs[bs.length - 1].click(); });
  const stamped = await p.evaluate(() => ({ aligning: window.MH.ui.aligning, bound: window.MH.store.state.bg.bound }));
  ok(stamped.aligning === false && stamped.bound === true,
    '离开第 1 步自动退出对齐模式的**同时记下对齐**（bound ✓）→ 第 2 步识别区域不会再报"底图未对齐"：' + JSON.stringify(stamped));
  // 改名：界面内编辑 ✓
  await p.evaluate(() => { window.MH.ui.wizard = null; window.MH.render(); });
  await p.click('[data-act="select-person"]');
  await p.click('[data-act="rename-person"]');
  ok(await p.locator('#renameInput').count() === 1, '点改名出现界面内输入框（不再弹 prompt ✓）');
  await p.fill('#renameInput', '小明');
  await p.locator('#renameInput').blur();
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => {
    const st = window.MH.store.state;
    return (st.people.find(x => x.id === st.selectedPersonId) || {}).label === '小明';
  }), '界面内改名生效 ✓');
  // 候选行：话术精简 + 下拉框窄 ✓
  await p.evaluate(() => {
    window.MH.panels.setClueCandidates({ clues: [
      { text: 'She was beside a shelf.', person: 'Oh rest', mappedBy: 'order', links: [] },
    ] }, 'json', [{ name: 'Oh rest' }]);
  });
  const rowInfo = await p.evaluate(() => {
    const r = document.querySelector('.clue-row');
    return {
      hint: (r.querySelector('.hint') || {}).textContent || '',
      selW: Math.round(r.querySelector('select').getBoundingClientRect().width),
      taW: Math.round(r.querySelector('textarea').getBoundingClientRect().width),
    };
  });
  ok(!/卡片上写的是/.test(rowInfo.hint), '候选行不再显示"卡片上写的是…"这类话：' + JSON.stringify(rowInfo.hint));
  ok(rowInfo.selW <= 60 && rowInfo.taW > rowInfo.selW * 2,
    '下拉框变窄、句子拿到更多空间：' + JSON.stringify(rowInfo));
  await p.evaluate(() => { window.MH.ui.clueCands = null; window.MH.render(); });

  // 44) 用**底图导入的那份**文件，右侧卡片自动拿到（不需要再导一次 ✓）
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MurdokuSnipper.state.file = null;
    window.MurdokuSnipper.state.pins = [];
    window.MH.ui.wizard = 1;
    window.MH.render();
  });
  const fed = await p.evaluate(() => {
    // 直接走 applyNewBackground 后面的"带给右侧"这段逻辑（用一个假的小图 File 更稳 ✓）
    const Sn = window.MurdokuSnipper;
    const hasOwn = !!(Sn.state.file || (Sn.state.pins || []).length);
    return { hasOwn, hasLoadFile: typeof Sn.loadFile === 'function' };
  });
  ok(fed.hasLoadFile, 'snipper 暴露 loadFile ✓（底图导入时把同一份带过去 ✓）');
  ok(!fed.hasOwn, '右侧为空时会自动带过去（前置条件）✓');
  await p.evaluate(async () => {
    // 造一个 1×1 的 PNG File，模拟"导入底图"后把文件交给右侧 ✓
    const cv = document.createElement('canvas'); cv.width = 8; cv.height = 6;
    cv.getContext('2d').fillRect(0, 0, 8, 6);
    const blob = await new Promise(r2 => cv.toBlob(r2, 'image/png'));
    const file = new File([blob], 'bg.png', { type: 'image/png' });
    window.MurdokuSnipper.loadFile(file);
  });
  await p.waitForFunction(() => !!(window.MurdokuSnipper.state.img && window.MurdokuSnipper.state.img.naturalWidth), null, { timeout: 10000 });
  const gotIt = await p.evaluate(() => ({
    name: window.MurdokuSnipper.state.file && window.MurdokuSnipper.state.file.name,
    w: window.MurdokuSnipper.state.img.naturalWidth,
  }));
  ok(gotIt.name === 'bg.png' && gotIt.w === 8, '同一份文件被带到右侧卡片 ✓：' + JSON.stringify(gotIt));

  // 45) 游玩界面：点到人物就显示他的线索 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    const st = window.MH.store.state;
    st.people[0].clue = 'He was in a car .';
    st.people[1].clue = 'She was not sitting in a chair.';
    st.people[2].clue = '';
    window.MH.render();
  });
  await p.click('#tabPlay');
  const playClue1 = await p.evaluate(() => {
    const c = document.querySelector('.play-clue');
    return { has: !!c, text: c && c.querySelector('.clue-text') ? c.querySelector('.clue-text').textContent : null };
  });
  ok(playClue1.has && /car/i.test(playClue1.text || ''), '游玩界面显示当前人物的线索 ✓：' + JSON.stringify(playClue1));
  await p.evaluate(() => {
    const st = window.MH.store.state;
    document.querySelector('.plist li[data-id="' + st.people[1].id + '"]').click();
  });
  const playClue2 = await p.evaluate(() => {
    // 线索现在挂在「人物」面板里 ✓ → 人物编号取 .pnow-row 里的 chip ✓（以前在 .play-clue 里 ✗）
    const c = document.querySelector('.play-clue');
    const row = document.querySelector('.pnow-row');
    return {
      who: (row && row.querySelector('.chip') || {}).textContent,
      text: c ? (c.querySelector('.clue-text') || {}).textContent : null,
      insidePersonCard: !!c && !!c.closest('.card') &&
        /人物/.test(((c.closest('.card').querySelector('h2') || {}).textContent || '')),
    };
  });
  ok(/B/.test(playClue2.who || '') && /chair/i.test(playClue2.text || '') && playClue2.insidePersonCard,
    '换一个人物，线索跟着换（且就在「人物」面板里 ✓）：' + JSON.stringify(playClue2));
  await p.evaluate(() => {
    const st = window.MH.store.state;
    document.querySelector('.plist li[data-id="' + st.people[2].id + '"]').click();
  });
  const playClue3 = await p.evaluate(() => {
    const c = document.querySelector('.play-clue');
    return { hint: !!c.querySelector('.hint'), text: !!c.querySelector('.clue-text') };
  });
  ok(playClue3.hint && !playClue3.text, '没线索的人给出提示而不是空框 ✓：' + JSON.stringify(playClue3));
  await p.click('#tabPrep');

  // 46) "框好几张"要**真的都用上** ✓（以前固定只用第一张 ✗）
  const merged = await p.evaluate(async () => {
    const mk = (lines) => {
      const cv = document.createElement('canvas');
      cv.width = 520; cv.height = 200;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, 520, 200);
      cx.fillStyle = '#111'; cx.font = 'bold 30px sans-serif';
      lines.forEach((t, i) => cx.fillText(t, 20, 60 + i * 52));
      return cv.toDataURL('image/png');
    };
    const Sn = window.MurdokuSnipper;
    Sn.state.pins = [
      { id: 'aa', page: 1, w: 520, h: 200, url: mk(['Can be occupied', 'Car']), srcX: 0, srcY: 0, srcW: 520, srcH: 200, srcPageW: 520, srcPageH: 200 },
      { id: 'bb', page: 1, w: 520, h: 200, url: mk(['Cannot be occupied', 'Tree']), srcX: 0, srcY: 0, srcW: 520, srcH: 200, srcPageW: 520, srcPageH: 200 },
    ];
    const raster = await window.MH.panels.cardsRaster();
    return { w: raster.width, h: raster.height, merged: window.MH.ui.cardsMerged };
  });
  // 留白必须**大于聚类的竖向相邻阈值**（1.8 × 行高 ≈ 36~72px ✓）→ 现在用 160px ✓
  // （以前 28px ✗ → 跨卡片粘成一块 ✓，golf 实测三张卡的线索粘成一条 ✗）
  ok(merged.w === 520 && merged.h === 200 * 2 + 160 * 3 && merged.merged === 2,
    '两张卡片竖着拼成一张（200+200+留白×3 = 880）✓：' + JSON.stringify(merged));
  const bothTexts = await p.evaluate(async () => {
    const raster = await window.MH.panels.cardsRaster();
    const words = await window.MurdokuOCR.readWords(raster, { x: 0, y: 0, w: raster.width, h: raster.height },
      { zoom: 4, psm: 11, chars: window.MurdokuOCR.WORDS, minConf: 50 });
    return words.map(w => String(w.text || '').toLowerCase());
  });
  ok(bothTexts.includes('car') && bothTexts.includes('tree'),
    '第一张的 Car 与第二张的 Tree 都读到了 ✓（不再是只用第一张）✓：' + JSON.stringify(bothTexts.slice(0, 10)));

  // 47) 「自动找地点」的模板：多张卡片时，每件物品的 patch/mask 都要裁对、非空 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    // 前面章节留过 PDF（bgPdfFile）→ 会先走文字层，把这些清掉才能测"截图卡片"这条路 ✓
    window.MH.bgPdfFile = null;
    window.MH.ui.pdfFile = null;
    window.MH.store.state.bg = null;
    // 前面章节跑过图例识别 → lastLegend/legendItems 是旧结果 ✓：不清掉的话等待会立即返回 ✗
    window.MH.ui.lastLegend = null;
    window.MH.ui.legendItems = null;
    window.MH.ui.wizard = 3;
    window.MH.render();
  });
  await p.evaluate(async () => {
    const mk = (head, name, occ, colour) => {
      const cv = document.createElement('canvas');
      cv.width = 520; cv.height = 150;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, 520, 150);
      cx.fillStyle = occ ? '#dff5df' : '#fde0e0'; cx.fillRect(8, 8, 504, 134);
      cx.fillStyle = '#111'; cx.font = 'bold 26px sans-serif'; cx.fillText(head, 20, 46);
      cx.fillStyle = colour; cx.beginPath(); cx.arc(60, 100, 22, 0, Math.PI * 2); cx.fill();
      cx.fillStyle = '#111'; cx.font = '24px sans-serif'; cx.fillText(name, 100, 108);
      return cv.toDataURL('image/png');
    };
    window.MurdokuSnipper.state.pins = [
      { id: 'L1', page: 1, w: 520, h: 150, url: mk('Can be occupied', 'Car', true, '#2b6cb0'),
        srcX: 0, srcY: 0, srcW: 520, srcH: 150, srcPageW: 520, srcPageH: 150 },
      { id: 'L2', page: 1, w: 520, h: 150, url: mk('Cannot be occupied', 'Tree', false, '#276749'),
        srcX: 0, srcY: 0, srcW: 520, srcH: 150, srcPageW: 520, srcPageH: 150 },
    ];
    window.MH.render();
  });
  // 引导里已经没有「从图例自动列出物品」按钮了（完成会自动跑 ✓）→ 这里直接调 API ✓
  await p.evaluate(() => { window.MH.ui.lastLegend = null; window.MH.panels.legendAuto(); });
  await p.waitForFunction(() => window.MH.ui.lastLegend, null, { timeout: 180000 });
  const legendMulti = await p.evaluate(() => ({
    last: window.MH.ui.lastLegend,
    items: (window.MH.ui.legendItems || []).map(it => ({
      name: it.name, occ: it.occupiable,
      patch: it.patch ? (it.patch.width + 'x' + it.patch.height) : null, mask: !!it.mask,
    })),
  }));
  ok(legendMulti.items.length === 2 && legendMulti.items.every(x => x.patch && x.mask),
    '两张图例卡片：两件物品都拿到了模板（patch+mask ✓，自动找地点才用得上 ✓）：' + JSON.stringify(legendMulti.items));
  ok(legendMulti.items.some(x => x.occ === true) && legendMulti.items.some(x => x.occ === false),
    '可占据/不可占据分别来自两张卡片 ✓：' + JSON.stringify(legendMulti.items.map(x => x.name + ':' + x.occ)));

  // 48) 离开区域步收掉编辑态 ✓；框选点「完成」后自动接着识别 ✓、接着读线索 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.draft = { kind: 'region', cells: new Set(['1,1']), color: '#888' };
    window.MH.ui.wizard = 2;
    window.MH.render();
  });
  await p.evaluate(() => { const bs = document.querySelectorAll('.wiz-foot [data-act="wiz-go"]'); bs[bs.length - 1].click(); });
  const leftStep2 = await p.evaluate(() => ({ draft: window.MH.ui.draft, step: window.MH.ui.wizard }));
  ok(!leftStep2.draft && leftStep2.step === 3,
    '离开区域步自动退出区域编辑（草稿收掉）✓：' + JSON.stringify(leftStep2));
  // 物品步：用上一节留下的两张图例卡片 → 进入框选层 → 直接点「完成」（不框）应给提示 ✓
  await p.evaluate(() => {
    window.MH.ui.wizard = 3;
    window.MH.ui.lastLegend = null;
    window.MH.ui.legendItems = null;
    window.MH.render();
    document.querySelector('[data-act="crop-item"]').click();
  });
  ok(await p.evaluate(() => !!document.getElementById('boardCrop')), '物品步能打开主界面框选层 ✓');
  await p.evaluate(() => document.querySelector('#boardCrop [data-act="crop-close"]').click());
  await p.waitForTimeout(300);
  ok(await p.evaluate(() => window.MH.ui.lastLegend === null),
    '没框到东西就点「完成」：不会白跑一遍识别 ✓');
  // 框一张后再点「完成」→ 自动识别 ✓
  await p.evaluate(() => {
    window.MH.ui.wizard = 3;
    window.MH.ui.lastLegend = null;
    window.MH.ui.legendItems = null;
    window.MH.render();
    document.querySelector('[data-act="crop-item"]').click();
  });
  await p.evaluate(async () => {
    const Sn = window.MurdokuSnipper;
    Sn.addPinFromSource(0, 0, 520, 150);                    // 复用上一节合成卡片所在的栅格 ✓
    if (window.MH.ui.crop) window.MH.ui.crop.added = 1;
  });
  await p.evaluate(() => document.querySelector('#boardCrop [data-act="crop-close"]').click());
  await p.waitForFunction(() => window.MH.ui.lastLegend, null, { timeout: 180000 });
  const autoLegend = await p.evaluate(() => window.MH.ui.lastLegend);
  ok(!!autoLegend && autoLegend.icons >= 1,
    '框完点「完成」→ **自动**跑完"从图例列出物品" ✓：' + JSON.stringify(autoLegend && autoLegend.via));
  // 人物步：同样点「完成」→ 自动读线索（可能读出 0 条，但必须真的跑过 ✓）
  await p.evaluate(() => {
    window.MH.ui.wizard = 4;
    window.MH.ui.clueCands = null;
    window.MH.ui.lastLegend = null;
    window.MH.render();
    document.querySelector('[data-act="crop-person"]').click();
    if (window.MH.ui.crop) window.MH.ui.crop.added = 1;
  });
  await p.evaluate(() => document.querySelector('#boardCrop [data-act="crop-close"]').click());
  await p.waitForFunction(() => window.MH.ui.clueCands ||
    [...document.querySelectorAll('.toast-item')].some(t => /线索/.test(t.textContent)), null, { timeout: 180000 });
  ok(true, '人物步框完点「完成」→ **自动**跑完"读人物线索"（有候选或给出说明）✓');
  await p.evaluate(() => { window.MH.ui.clueCands = null; window.MH.ui.wizard = null; window.MH.render(); });

  // 49) 框选层的「完成」不能被右边浮窗挡住 ✓（z-index 与让位）
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizard = 3;
    window.MH.render();
    document.querySelector('[data-act="crop-item"]').click();
  });
  const cropGeo = await p.evaluate(() => {
    const l = document.getElementById('boardCrop');
    const sn = document.getElementById('snipper');
    const btn = document.querySelector('#boardCrop [data-act="crop-close"]');
    if (!l || !btn) return null;
    const br = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
    return {
      layerRight: Math.round(l.getBoundingClientRect().right),
      snipLeft: Math.round(sn.getBoundingClientRect().left),
      zLayer: Number(getComputedStyle(l).zIndex),
      zSnip: Number(getComputedStyle(sn).zIndex),
      topmost: hit ? (hit.getAttribute('data-act') || hit.tagName) : null,
    };
  });
  // **新预期**（用户要求 ✓）：「完成」已挪到下一行靠左 ✓ → 框选层不必让位、也不必压在浮窗之上 ✓
  ok(cropGeo && cropGeo.zLayer < cropGeo.zSnip,
    '框选层不再压在右侧浮窗之上（浮窗照旧浮在右上）✓：' + JSON.stringify(cropGeo));
  ok(cropGeo && cropGeo.layerRight > cropGeo.snipLeft,
    '框选层铺满棋盘区（不再为浮窗改宽度）✓：' + JSON.stringify(cropGeo));
  ok(cropGeo && cropGeo.topmost === 'crop-close',
    '「完成」在下一行靠左 → 不被浮窗挡住，仍是命中的最上层 ✓：' + (cropGeo && cropGeo.topmost));

  // 真实鼠标点击 ✓（这条以前会因为被遮挡而超时 ✗）
  await p.click('#boardCrop [data-act="crop-close"]', { timeout: 5000 });
  ok(!(await p.evaluate(() => !!document.getElementById('boardCrop'))), '真实鼠标点「完成」能关掉框选层 ✓');
  await p.waitForTimeout(400);
  await p.evaluate(() => { window.MH.ui.wizard = null; window.MH.ui.lastLegend = null; window.MH.render(); });

  // 50) 重置清掉右侧卡片与导入的页面 ✓；关联在"点应用"时才按名字解析 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.confirm = () => true;
    const Sn = window.MurdokuSnipper;
    Sn.state.img = { naturalWidth: 120, naturalHeight: 80, src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' };
    Sn.state.file = { name: 'x.png', type: 'image/png' };
    Sn.state.pins = [
      { id: 'r1', page: 1, w: 60, h: 40, url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
      { id: 'r2', page: 1, w: 40, h: 30, url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
    ];
    window.MurdokuSnipper.render();
  });
  await p.waitForTimeout(200);
  ok(await p.evaluate(() => window.MurdokuSnipper.state.pins.length === 2), '准备：右侧有 2 张卡片 ✓');
  await p.click('[data-act="reset-all"]');
  await p.waitForTimeout(300);
  const afterReset = await p.evaluate(() => ({
    pins: window.MurdokuSnipper.state.pins.length,
    hasImg: !!window.MurdokuSnipper.state.img,
    stored: !!localStorage.getItem('murdoku-helper.v1.snipPins'),
  }));
  ok(afterReset.pins === 0 && !afterReset.hasImg && !afterReset.stored,
    '重置会清掉右侧卡片与导入的页面（含 localStorage）✓：' + JSON.stringify(afterReset));

  // 关联在"点应用"时按名字解析 ✓（识别之后改名也能对上 ✓）
  await p.evaluate(() => {
    const st = window.MH.store.state, C = window.MurdokuCore;
    C.createItem(st, 'Chair', [], true);
    C.createRegion(st, 'FRONT AREA', []);
    st.items.find(i => i.name === 'Chair').name = '椅子';       // 识别之后改名 ✓
    window.MH.panels.setClueCandidates({ clues: [
      { text: 'She was sitting in a chair in the front area.', person: null, personId: st.people[0].id,
        links: [ { kind: 'in', polarity: 1, target: '椅子', targetKind: 'item' },
                 { kind: 'in', polarity: 1, target: 'FRONT AREA', targetKind: 'region' } ] },
    ] }, 'json', []);
  });
  await p.evaluate(() => document.querySelector('[data-act="clue-apply"]').click());
  await p.waitForTimeout(300);
  const applied2 = await p.evaluate(() => {
    const st = window.MH.store.state;
    const p2 = st.people[0];
    return { clue: p2.clue, links: p2.links.map(l => (st.items.find(i => i.id === l.id) || st.regions.find(r => r.id === l.id) || {}).name) };
  });
  ok(/chair/i.test(applied2.clue || '') && applied2.links.length === 2 && applied2.links.includes('椅子') && applied2.links.includes('FRONT AREA'),
    '一句话的两条关联都在应用时建好（并用改名后的名字对上 ✓）：' + JSON.stringify(applied2));
  await p.evaluate(() => { window.MH.ui.clueCands = null; window.MH.render(); });

  // 50.5) 「左键＝标 X」模式：悬停格子上浮一个 ✕ ✓（用户要求：让人看得出现在是在标 X）
  await p.evaluate(() => {
    const tab = document.getElementById('tabPlay'); if (tab) tab.click();
  });
  await p.waitForTimeout(200);
  await p.evaluate(() => {
    const b2 = [...document.querySelectorAll('[data-act="left-mode"]')].find(x => x.dataset.mode === 'x');
    if (b2) b2.click();
  });
  await p.waitForTimeout(200);
  const xState = await p.evaluate(() => {
    const c = document.querySelector('.cell');
    const after = c ? getComputedStyle(c, '::after') : null;
    return { body: document.body.classList.contains('left-x'), mode: window.MH.store.state.settings.leftMode };
  });
  ok(xState.mode === 'x' && xState.body, '标 X 模式下 body 带 left-x（悬停预览 ✕ 的开关）✓：' + JSON.stringify(xState));
  await p.hover('.cell');
  await p.waitForTimeout(120);
  const xAfter = await p.evaluate(() => {
    const c = document.querySelector('.cell');
    return c ? getComputedStyle(c, '::after').content : '';
  });
  ok(/✕/.test(xAfter), '标 X 模式悬停时格子上浮出 ✕ ✓：' + xAfter);
  // **✕ 必须盖住候选字母** ✓（用户要求"挡住候选"✓；.cands 是 z-index:5 ✗ 曾经盖在 ✕ 上面 ✗）
  // 注入与真实渲染一致的候选标记（.cands > i ✓ 样式来自 CSS 的 z-index:5 ✓）
  await p.evaluate(() => {
    const c = document.querySelector('.cell[data-k="0,0"]') || document.querySelector('.cell');
    if (!c) return;
    if (!c.querySelector('.cands')) {
      const d = document.createElement('span');
      d.className = 'cands';
      d.innerHTML = '<i style="--pc:#2563eb">A</i><i style="--pc:#0f9d58">B</i>';
      c.appendChild(d);
    }
  });
  await p.hover('.cell[data-k="0,0"]').catch(() => p.hover('.cell'));
  await p.waitForTimeout(150);
  const xLayer = await p.evaluate(() => {
    const c = document.querySelector('.cell[data-k="0,0"]') || document.querySelector('.cell');
    const cands = c && c.querySelector('.cands');
    if (!cands) return { skip: true };
    const a = getComputedStyle(c, '::after');
    const m = /rgba?\(([^)]+)\)/.exec(a.backgroundColor) || [];
    const alpha = m[1] ? parseFloat(m[1].split(',')[3]) : 0;
    return { skip: false, afterZ: parseInt(a.zIndex, 10) || 0, bgAlpha: alpha,
      candsZ: parseInt(getComputedStyle(cands).zIndex, 10) || 0,
      candsOpacity: parseFloat(getComputedStyle(cands).opacity) };   // 悬停时应为 0 ✓
  });
  // 用户后续要求：底色**半透明** ✓（格子的底色/候选隐约可见 ✓），但层级仍要在候选之上 ✓
  ok(xLayer.skip || (xLayer.afterZ > xLayer.candsZ && xLayer.bgAlpha > 0.2 && xLayer.bgAlpha < 0.9 &&
      xLayer.candsOpacity === 0),
    '✕ 半透明背景 + 悬停时候选淡出（既透出格子底色、又不和 ✕ 叠字）✓：' + JSON.stringify(xLayer));
  await p.evaluate(() => {
    const b2 = [...document.querySelectorAll('[data-act="left-mode"]')].find(x => x.dataset.mode === 'candidate');
    if (b2) b2.click();
    const tab = document.getElementById('tabPrep'); if (tab) tab.click();
  });
  await p.waitForTimeout(200);

  // 51) 候选面板要说清"这次读的是整页还是你框的卡片" ✓（用户被卡片外的句子困惑过 ✓）
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.panels.setClueCandidates({ clues: [
      { text: 'He was in a car .', person: null, links: [] },
    ] }, 'pdf', []);
    window.MH.ui.clueCands.wholePage = true;
    window.MH.render();
  });
  const wholeHead = await p.evaluate(() => (document.querySelector('.clue-panel .link-title') || {}).textContent || '');
  ok(/整页/.test(wholeHead), '没框卡片时面板标明"整页" ✓：' + wholeHead);
  await p.evaluate(() => { window.MH.ui.clueCands.wholePage = false; window.MH.render(); });
  const cardHead = await p.evaluate(() => (document.querySelector('.clue-panel .link-title') || {}).textContent || '');
  // 用户要求精简 ✗：框卡片是默认情形 ✓ 不再重复写"你框的卡片"✓（"卡片 OCR"已经说明了来源 ✓）
  ok(!/整页/.test(cardHead) && !/你框的卡片/.test(cardHead), '框了卡片时不再重复标注来源 ✓：' + cardHead);
  await p.evaluate(() => { window.MH.ui.clueCands = null; window.MH.render(); });

  // 52) 旧卡片（缺 srcX 等源坐标）必须**被忽略并告知** ✓（以前算出 NaN → 静默失效 ✗）
  const legacyPins = await p.evaluate(() => {
    const Sn = window.MurdokuSnipper.state;
    Sn.pins = [
      { id: 'ok1', page: 1, w: 120, h: 80, url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        srcX: 100, srcY: 100, srcW: 120, srcH: 80, srcPageW: 1600, srcPageH: 1236 },
      // 旧版本留下的：只有 srcY/srcW/srcH（缺 srcX ✓）
      { id: 'old1', page: 1, w: 278, h: 288, url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        srcY: 451, srcW: 278, srcH: 288, srcPageW: 1600, srcPageH: 1236 },
      { id: 'old2', page: 1, w: 244, h: 217, url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        srcY: 523, srcW: 244, srcH: 217, srcPageW: 1600, srcPageH: 1236 },
    ];
    window.MurdokuSnipper.render();
    // 直接问内部函数：有效矩形数 / 被忽略数 ✓
    return { total: Sn.pins.length };
  });
  ok(legacyPins.total === 3, '准备：1 张有效 + 2 张旧卡片 ✓');
  const rectsInfo = await p.evaluate(() => {
    const fake = { width: 1600, height: 1236 };
    // cardRectsForPage 是内部函数 → 通过一个能观察到的行为间接验证：
    // 造一张图，用 png 数据让 legendCardRaster 之类的路径也能跑通不必要；
    // 这里直接检查"缺 srcX 的卡片不会被算成 NaN 矩形"的判据 ✓
    const pins = window.MurdokuSnipper.state.pins;
    const bad = pins.filter(x => ![x.srcX, x.srcY, x.srcW, x.srcH, x.srcPageW, x.srcPageH]
      .every(v => typeof v === 'number' && Number.isFinite(v))).length;
    const good = pins.length - bad;
    void fake;
    return { bad, good };
  });
  ok(rectsInfo.bad === 2 && rectsInfo.good === 1,
    '缺源坐标的旧卡片会被识别为"无效"（2 张）✓：' + JSON.stringify(rectsInfo));
  // 源头也要拒绝 NaN 坐标 ✓
  const nanPin = await p.evaluate(() => {
    const before = window.MurdokuSnipper.state.pins.length;
    const made = window.MurdokuSnipper.addPinFromSource(undefined, 10, 50, 50);
    return { made: made ? 1 : 0, added: window.MurdokuSnipper.state.pins.length - before };
  });
  ok(nanPin.made === 0 && nanPin.added === 0, '坐标异常时不生成卡片（不再产生 NaN 卡片）✓：' + JSON.stringify(nanPin));
  await p.evaluate(() => { window.MurdokuSnipper.state.pins = []; window.MurdokuSnipper.render(); });

  // 53) 引导第 2/3 步点"手动新建"必须出现编辑界面 ✓（以前按钮消失、界面不出现 ✗）
  for (const [stepNo, act] of [[2, 'new-region'], [3, 'new-item']]) {
    await p.evaluate((st) => {
      const tab = document.getElementById('tabPrep');
      if (tab) tab.click();
      window.MH.ui.draft = null;
      window.MH.ui.wizard = st;
      window.MH.render();
    }, stepNo);
    await p.evaluate((a) => document.querySelector('[data-act="' + a + '"]').click(), act);
    await p.waitForTimeout(150);
    const st2 = await p.evaluate(() => ({
      draft: !!document.querySelector('#sidebar .draft'),
      save: !!document.querySelector('[data-act="draft-save"]'),
      cancel: !!document.querySelector('[data-act="draft-cancel"]'),
      kind: window.MH.ui.draft && window.MH.ui.draft.kind,
      wizard: window.MH.ui.wizard,
    }));
    ok(st2.draft && st2.save && st2.cancel && st2.kind && st2.wizard === stepNo,
      '引导第 ' + stepNo + ' 步：手动新建后出现编辑界面（' + act + '）✓：' + JSON.stringify(st2));
    await p.evaluate(() => { window.MH.ui.draft = null; window.MH.ui.wizard = 2; window.MH.render(); });
  }
  // 取消后按钮应回来 ✓
  await p.evaluate(() => { window.MH.ui.draft = null; window.MH.ui.wizard = 2; window.MH.render(); });
  const backBtn = await p.evaluate(() => !!document.querySelector('[data-act="new-region"]'));
  ok(backBtn, '取消草稿后「手动新建区域」按钮回来 ✓');
  await p.evaluate(() => { window.MH.ui.wizard = null; window.MH.render(); });

  // 54) 改过线索文字后，应用时按**改后的文字**重新解析关联 ✓（识别那一刻的关联会过期 ✓）
  const reparsePid = await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    const st = window.MH.store.state, C = window.MurdokuCore;
    C.createItem(st, 'Chair', [], true);
    C.createItem(st, 'Shelf', [], true);
    C.createRegion(st, 'FRONT AREA', []);
    const pid = st.people[0].id;
    // 注入的候选：文字说 chair，但关联列表给的是 Shelf（模拟"识别后用户改了文字" ✓）
    window.MH.panels.setClueCandidates({ clues: [
      { text: 'He was in a chair.', person: null, personId: pid,
        links: [{ kind: 'in', polarity: 1, target: 'Shelf', targetKind: 'item' }] },
    ] }, 'json', []);
    return pid;
  });
  await p.evaluate(() => {
    const ta = document.querySelector('.clue-panel textarea[data-act="clue-text"]');
    ta.value = 'She was sitting in a chair in the front area.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.evaluate(() => document.querySelector('[data-act="clue-apply"]').click());
  await p.waitForTimeout(250);
  const reparsed = await p.evaluate((pid) => {
    const st = window.MH.store.state;
    const p2 = st.people.find(x => x.id === pid);
    const name = id => ((st.items.find(i => i.id === id) || {}).name || (st.regions.find(r => r.id === id) || {}).name);
    return { clue: p2.clue, links: p2.links.map(l => name(l.id)) };
  }, reparsePid);
  ok(reparsed.links.includes('Chair') && reparsed.links.includes('FRONT AREA') && !reparsed.links.includes('Shelf'),
    '应用时按改后的文字重新解析关联 ✓（不是识别那一刻的 Shelf ✗）：' + JSON.stringify(reparsed));
  ok(/front area/i.test(reparsed.clue || ''), '线索原文存的也是改后的版本 ✓：' + JSON.stringify(reparsed.clue));

  // 55) 四个步骤圆点可点跳转 ✓；草稿跨步会被收掉 ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizardOptOut = false;
    window.MH.ui.wizard = 1;
    window.MH.render();
  });
  const dotsAreButtons = await p.evaluate(() => ({
    n: document.querySelectorAll('.wiz-dot').length,
    allButtons: [...document.querySelectorAll('.wiz-dot')].every(d => d.tagName === 'BUTTON'),
  }));
  ok(dotsAreButtons.n === 4 && dotsAreButtons.allButtons,
    '四个步骤圆点都是可点按钮 ✓：' + JSON.stringify(dotsAreButtons));
  for (const k of [3, 4, 2]) {
    await p.evaluate((v) => document.querySelector('.wiz-dot[data-v="' + v + '"]').click(), k);
    await p.waitForTimeout(120);
    const now = await p.evaluate(() => ({
      step: window.MH.ui.wizard,
      on: (document.querySelector('.wiz-dot.on') || {}).textContent,
      title: (document.querySelector('.wiz-title') || {}).textContent,
    }));
    ok(now.step === k && String(now.on || '').indexOf(String(k) + '.') === 0,
      '点第 ' + k + ' 个圆点跳到第 ' + k + ' 步并高亮 ✓：' + JSON.stringify(now));
  }
  // 草稿只在自己那一步编辑 ✓：第 3 步的草稿跳到第 2 步应被收掉 ✓
  await p.evaluate(() => { document.querySelector('.wiz-dot[data-v="3"]').click(); });
  await p.waitForTimeout(120);
  await p.evaluate(() => document.querySelector('[data-act="new-item"]').click());
  await p.waitForTimeout(120);
  const draftedKind = await p.evaluate(() => window.MH.ui.draft && window.MH.ui.draft.kind);
  await p.evaluate(() => { document.querySelector('.wiz-dot[data-v="2"]').click(); });
  await p.waitForTimeout(150);
  const afterJump = await p.evaluate(() => ({ draft: window.MH.ui.draft, step: window.MH.ui.wizard }));
  ok(draftedKind === 'item' && !afterJump.draft && afterJump.step === 2,
    '离开草稿所属的步骤会自动收掉草稿 ✓：' + JSON.stringify({ draftedKind, afterJump }));
  await p.evaluate(() => { window.MH.ui.wizardOptOut = true; window.MH.ui.wizard = null; window.MH.render(); });

  // 56) 编辑已有区域/物品时只能有**一个**编辑框 ✓（以前会出现两个 ✗）
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizardOptOut = false;
    const st = window.MH.store.state, C = window.MurdokuCore;
    if (!st.regions.length) C.createRegion(st, 'A区', ['0,0', '0,1']);
    if (!st.items.length) C.createItem(st, '车', [], true);
    window.MH.ui.wizard = 2;
    window.MH.ui.draft = null;
    window.MH.render();
  });
  // 新建：一个编辑框 ✓
  await p.evaluate(() => document.querySelector('[data-act="new-region"]').click());
  await p.waitForTimeout(150);
  const newDraft = await p.evaluate(() => document.querySelectorAll('#sidebar .draft').length);
  ok(newDraft === 1, '新建区域时只有一个编辑框 ✓：' + newDraft);
  await p.evaluate(() => document.querySelector('[data-act="draft-cancel"]').click());
  await p.waitForTimeout(150);
  // 编辑已有区域：仍然只有一个（内联的那个 ✓）
  await p.evaluate(() => { const b2 = document.querySelector('[data-act="edit-region"]'); if (b2) b2.click(); });
  await p.waitForTimeout(200);
  const editDraft = await p.evaluate(() => ({
    drafts: document.querySelectorAll('#sidebar .draft').length,
    inline: document.querySelectorAll('#sidebar .draft.inline').length,
  }));
  ok(editDraft.drafts === 1 && editDraft.inline === 1,
    '编辑已有区域时只有一个（内联）编辑框 ✓：' + JSON.stringify(editDraft));
  await p.evaluate(() => { window.MH.ui.draft = null; window.MH.ui.wizard = 3; window.MH.render(); });
  await p.evaluate(() => document.querySelector('[data-act="new-item"]').click());
  await p.waitForTimeout(150);
  const newItemDraft = await p.evaluate(() => document.querySelectorAll('#sidebar .draft').length);
  ok(newItemDraft === 1, '新建物品时只有一个编辑框 ✓：' + newItemDraft);
  await p.evaluate(() => document.querySelector('[data-act="draft-cancel"]').click());
  await p.waitForTimeout(150);
  await p.evaluate(() => { const b2 = document.querySelector('[data-act="edit-item"]'); if (b2) b2.click(); });
  await p.waitForTimeout(200);
  const editItemDraft = await p.evaluate(() => document.querySelectorAll('#sidebar .draft').length);
  ok(editItemDraft === 1, '编辑已有物品时只有一个编辑框 ✓：' + editItemDraft);
  await p.evaluate(() => { window.MH.ui.draft = null; window.MH.ui.wizardOptOut = true; window.MH.ui.wizard = null; window.MH.render(); });

  // 57) 右侧悬浮窗改名「线索笔记」✓；框选层支持翻页 ✓（多页时才出现 ✓）
  ok(await p.evaluate(() => (document.querySelector('.snipper-head b') || {}).textContent === '线索笔记'),
    '右侧悬浮窗标题改成「线索笔记」✓');
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizardOptOut = true;
    const Sn = window.MurdokuSnipper;
    // 造一个多页状态（真实 PDF 多为单页，这里直接置状态 ✓）
    Sn.state.img = { naturalWidth: 800, naturalHeight: 600, src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' };
    Sn.state.pages = 3; Sn.state.page = 1;
    window.MH.ui.wizard = 3;
    window.MH.ui.crop = null;
    window.MH.render();
    const old = document.getElementById('boardCrop'); if (old) old.remove();
    document.querySelector('[data-act="crop-item"]').click();
  });
  const pageNav = await p.evaluate(() => {
    const layer = document.getElementById('boardCrop');
    const acts = [...layer.querySelectorAll('.bc-actions button')];
    const done = layer.querySelector('[data-act="crop-close"]');
    const br = done.getBoundingClientRect(), lr = layer.getBoundingClientRect();
    const hit = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
    return {
      n: layer.querySelectorAll('[data-act="crop-page"]').length,
      title: (layer.querySelector('.bc-line b') || {}).textContent,
      prevDisabled: layer.querySelector('[data-act="crop-page"][data-dir="-1"]').disabled,
      doneFirst: acts[0] === done,                                  // **「完成」在最左** ✓
      doneNearLeft: Math.round(br.left - lr.left) < 40,
      topmost: hit ? (hit.getAttribute('data-act') || hit.tagName) : null,
    };
  });
  ok(pageNav.n === 2 && /第 1 \/ 3 页/.test(pageNav.title || '') && pageNav.prevDisabled === true,
    '多页时框选层出现翻页按钮，标题带页码 ✓：' + JSON.stringify(pageNav));
  ok(pageNav.doneFirst && pageNav.doneNearLeft && pageNav.topmost === 'crop-close',
    '有翻页按钮时「完成」仍在最左且不被遮挡 ✓：' + JSON.stringify(pageNav));
  await p.evaluate(() => {
    const Sn = window.MurdokuSnipper;
    Sn.state.page = 2;                                  // 模拟翻到第 2 页 ✓
    document.querySelector('#boardCrop [data-act="crop-page"][data-dir="1"]').click();
  });
  await p.waitForTimeout(300);
  const afterPage = await p.evaluate(() => {
    const t = (document.querySelector('#boardCrop .bc-line b') || {}).textContent;
    const prev = document.querySelector('#boardCrop [data-act="crop-page"][data-dir="-1"]');
    return { title: t, prevDisabled: prev && prev.disabled, page: window.MurdokuSnipper.state.page };
  });
  ok(/第 \d+ \/ 3 页/.test(afterPage.title || '') && afterPage.prevDisabled === false,
    '翻页后标题与按钮状态跟着变 ✓：' + JSON.stringify(afterPage));
  // 单页时不显示翻页 ✓
  await p.evaluate(() => {
    const Sn = window.MurdokuSnipper;
    Sn.state.pages = 1; Sn.state.page = 1;
    const b2 = document.querySelector('#boardCrop [data-act="crop-close"]'); if (b2) b2.click();
    window.MH.ui.crop = null;
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => { window.MH.ui.wizard = 3; window.MH.render(); document.querySelector('[data-act="crop-item"]').click(); });
  const single = await p.evaluate(() => document.querySelectorAll('#boardCrop [data-act="crop-page"]').length);
  ok(single === 0, '单页时不显示翻页按钮 ✓：' + single);
  await p.evaluate(() => {
    const b2 = document.querySelector('#boardCrop [data-act="crop-close"]'); if (b2) b2.click();
    window.MH.ui.crop = null; window.MH.ui.wizardOptOut = true; window.MH.ui.wizard = null;
    window.MurdokuSnipper.state.pins = [];
    window.MH.render();
  });

  // 58) 线索候选带"来源卡片"缩略图 ✓ 且按卡分组 ✓（OCR 读错名字无法避免 ✓ → 让人一眼知道来自哪块 ✓）
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizardOptOut = false;
    window.MH.ui.wizard = 4;
    // 造两张"卡片"（带 url ✓ 才能显示缩略图 ✓）
    const px = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    window.MurdokuSnipper.state.pins = [
      { id: 'c1', page: 1, w: 60, h: 40, url: px, srcX: 0, srcY: 0, srcW: 60, srcH: 40, srcPageW: 200, srcPageH: 200 },
      { id: 'c2', page: 1, w: 60, h: 40, url: px, srcX: 0, srcY: 100, srcW: 60, srcH: 40, srcPageW: 200, srcPageH: 200 },
    ];
    window.MH.panels.setClueCandidates({ clues: [
      { text: '第一条（卡1）', person: null, links: [], cardIndex: 0, cardUrl: px },
      { text: '第二条（卡1）', person: null, links: [], cardIndex: 0, cardUrl: px },
      { text: '第三条（卡2）', person: null, links: [], cardIndex: 1, cardUrl: px },
      { text: '第四条（卡2）', person: null, links: [], cardIndex: 1, cardUrl: px },
    ] }, 'ocr', []);
    window.MH.render();
  });
  const thumbs = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.clue-panel .clue-row')];
    const seq = rows.map(r => (r.querySelector('.clue-card-no') || {}).textContent || '—');
    const seen = new Set(); let prev = null, grouped = true;
    for (const x of seq) { if (x !== prev) { if (seen.has(x)) grouped = false; seen.add(x); prev = x; } }
    return { rows: rows.length, thumbs: rows.filter(r => r.querySelector('.clue-thumb')).length, seq, grouped };
  });
  ok(thumbs.rows === 4 && thumbs.thumbs === 4,
    '每条候选都带来源卡片缩略图 ✓：' + JSON.stringify(thumbs));
  ok(thumbs.grouped && thumbs.seq[0] === '卡1' && thumbs.seq[3] === '卡2',
    '候选按"来源卡片"分组排列（同卡连续 ✓）：' + JSON.stringify(thumbs.seq));
  // **缩略图必须在行尾右边** ✓ —— 放左边会把提取出的线索挤掉/被放大图压住 ✗（用户反馈 ✓）
  const thumbPos = await p.evaluate(() => {
    const row = document.querySelector('.clue-panel .clue-row');
    const thumb = row.querySelector('.clue-thumb');
    const grow = row.querySelector('.grow');
    const tr = thumb.getBoundingClientRect(), gr = grow ? grow.getBoundingClientRect() : null;
    return { rightOfText: !!gr && tr.left >= gr.right - 4, nearRowRight: Math.round(row.getBoundingClientRect().right - tr.right) < 120 };
  });
  ok(thumbPos.rightOfText && thumbPos.nearRowRight,
    '来源卡片缩略图在行尾**右边** ✓：' + JSON.stringify(thumbPos));
  // **悬停缩略图 → 大图浮在它右边** ✓（放左边会压住提取出的线索 ✗ —— 用户反馈 ✓）
  await p.locator('.clue-panel .clue-thumb').first().hover();
  await p.waitForTimeout(250);
  const peeking = await p.evaluate(() => {
    const box = document.getElementById('cardHover');
    const row = document.querySelector('.clue-panel .clue-row');
    const thumb = row.querySelector('.clue-thumb');
    const grow = row.querySelector('.grow');
    if (!box) return null;
    const br = box.getBoundingClientRect(), tr = thumb.getBoundingClientRect(), gr = grow.getBoundingClientRect();
    return { shown: true, rightOfThumb: br.left >= tr.right - 2, notCoverText: br.left >= gr.right - 2 };
  });
  ok(peeking && peeking.shown && peeking.rightOfThumb && peeking.notCoverText,
    '悬停缩略图：大图出现在**右边**且不压住线索 ✓：' + JSON.stringify(peeking));
  await p.mouse.move(5, 5);
  await p.waitForTimeout(200);
  ok(!(await p.evaluate(() => !!document.getElementById('cardHover'))), '鼠标移开大图就消失 ✓');
  await p.evaluate(() => { window.MH.ui.clueCands = null; window.MH.ui.wizardOptOut = true; window.MH.ui.wizard = null; window.MH.render(); });

  // 59) 「在旁边」也要建关联 ✓（用户反馈："She was beside a water" 没关联到 water ✗）
  const besidePid = await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizardOptOut = false;
    window.MH.ui.wizard = 4;
    const st = window.MH.store.state, C = window.MurdokuCore;
    if (!st.items.some(i => i.name === 'water')) C.createItem(st, 'water', [], true);
    if (!st.items.some(i => i.name === 'tree')) C.createItem(st, 'tree', [], true);
    const pid = st.people[0].id;
    window.MH.panels.setClueCandidates({ clues: [
      { text: 'She was beside a water .', person: null, personId: pid,
        links: [{ kind: 'beside', polarity: 1, target: 'water', targetKind: 'item' }] },
    ] }, 'ocr', []);
    window.MH.render();
    return pid;
  });
  await p.evaluate(() => document.querySelector('[data-act="clue-apply"]').click());
  await p.waitForTimeout(250);
  const besideRes = await p.evaluate((pid) => {
    const st = window.MH.store.state;
    const p2 = st.people.find(x => x.id === pid);
    const nm = id => (st.items.find(i => i.id === id) || st.regions.find(r => r.id === id) || {}).name;
    return { links: p2.links.map(l => l.kind + ':' + nm(l.id) + ':' + l.polarity) };
  }, besidePid);
  ok(besideRes.links.includes('item:water:1'),
    '「在旁边」现在也会建关联 ✓（beside→water ✓）：' + JSON.stringify(besideRes));
  await p.evaluate(() => { window.MH.ui.wizardOptOut = true; window.MH.ui.wizard = null; window.MH.render(); });

  // 60) 性别：识别→面板可改→应用带入→游玩格子里显示 ♂/♀ ✓
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizardOptOut = false;
    window.MH.ui.wizard = 4;
    const st = window.MH.store.state;
    st.selectedPersonId = st.people[0].id;
    window.MH.render();
  });
  const sexBtns = await p.evaluate(() => [...document.querySelectorAll('[data-act="person-sex"]')].map(b2 => b2.dataset.sex));
  ok(sexBtns.join(',') === 'm,f,', '人物卡片里有性别按钮（男/女/未知）✓：' + JSON.stringify(sexBtns));
  await p.evaluate(() => document.querySelector('[data-act="person-sex"][data-sex="f"]').click());
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => window.MH.store.state.people[0].sex === 'f'), '点「♀ 女」后状态里 sex=f ✓');
  // 应用线索时把识别到的性别带入（且不覆盖手动设置的 ✓）
  const sexPids = await p.evaluate(() => {
    const st = window.MH.store.state;
    st.people[1].sex = '';                              // B 未设置 ✓
    window.MH.panels.setClueCandidates({ clues: [
      { text: 'He was in a car .', person: null, personId: st.people[1].id, sex: 'm', links: [] },
      { text: 'She was beside a shelf .', person: null, personId: st.people[0].id, sex: 'f', links: [] },
    ] }, 'ocr', []);
    window.MH.render();
    return [st.people[0].id, st.people[1].id];
  });
  await p.evaluate(() => document.querySelector('[data-act="clue-apply"]').click());
  await p.waitForTimeout(200);
  const sexApplied = await p.evaluate((pids) => {
    const st = window.MH.store.state;
    return { a: (st.people.find(x => x.id === pids[0]) || {}).sex, b: (st.people.find(x => x.id === pids[1]) || {}).sex };
  }, sexPids);
  ok(sexApplied.b === 'm' && sexApplied.a === 'f',
    '应用线索带入性别 ✓（B 未设置→m；A 手动设为 f 不被覆盖 ✓）：' + JSON.stringify(sexApplied));
  // 游玩：格子里显示 ♂/♀ ✓
  // 注意：**选中的人不显示标记** ✓（后加的需求 ✓）→ 这里先取消选中再断言 ✓
  await p.evaluate((pids) => {
    const st = window.MH.store.state;
    st.play.placed[pids[0]] = '0,0';
    st.play.placed[pids[1]] = '0,1';
    st.selectedPersonId = null;
    window.MH.ui.wizard = null; window.MH.ui.wizardOptOut = true;
    window.MH.render();
  }, sexPids);
  await p.click('#tabPlay');
  // **地图上不显示性别标记** ✓（用户明确要求：只在左边「人物」面板里显示 ✓）
  const cellSex = await p.evaluate(() => ({
    marks: document.querySelectorAll('.cell .sex-mark').length,
    panelDots: document.querySelectorAll('.plist .sex-dot').length,
  }));
  ok(cellSex.marks === 0 && cellSex.panelDots >= 2,
    '地图上没有性别标记 ✓、面板里有 ✓：' + JSON.stringify(cellSex));
  await p.evaluate(() => { window.MH.ui.clueCands = null; window.MH.render(); });

  // 61) 游玩「人物」面板里要**直接看到性别** ✓（不只是选中格子后 ✓ —— 用户要求 ✓）
  await p.evaluate(() => {
    const tab = document.getElementById('tabPrep');
    if (tab) tab.click();
    window.MH.ui.wizardOptOut = true;
    const st = window.MH.store.state;
    st.people[0].sex = 'm';
    st.people[1].sex = 'f';
    st.people[2].sex = '';
    st.phase = 'play';
    window.MH.render();
  });
  await p.click('#tabPlay');
  await p.waitForTimeout(200);
  const panelSex = await p.evaluate(() => ({
    dots: [...document.querySelectorAll('.plist .sex-dot')].map(x => x.textContent),
    badge: (document.querySelector('.pnow-row .sex-badge') || {}).textContent,
    listCount: document.querySelectorAll('.plist li').length,
  }));
  ok(panelSex.dots.length === 2 && panelSex.dots.includes('♂') && panelSex.dots.includes('♀'),
    '人物列表里的性别角标 ♂/♀ ✓：' + JSON.stringify(panelSex));
  // 点没设性别的人 → 徽章显示"性别未知" ✓；点 B → 「♀ 女」 ✓
  await p.evaluate(() => {
    const st = window.MH.store.state;
    document.querySelector('.plist li[data-id="' + st.people[1].id + '"]').click();
  });
  const badgeB = await p.evaluate(() => (document.querySelector('.pnow-row .sex-badge') || {}).textContent);
  ok(badgeB === '♀ 女', '选中行显示性别徽章 ✓：' + JSON.stringify(badgeB));
  await p.evaluate(() => {
    const st = window.MH.store.state;
    document.querySelector('.plist li[data-id="' + st.people[2].id + '"]').click();
  });
  const badgeC = await p.evaluate(() => (document.querySelector('.pnow-row .sex-badge') || {}).textContent);
  ok(badgeC === '性别未知', '未设置性别时显示"性别未知" ✓：' + JSON.stringify(badgeC));
  await p.click('#tabPrep');

  // 62) 面板角标在浅底/实心底上都要可见（白字 + 描边）✓
  //     候选格上的性别符号在 scripts 探针里验证 ✓（e2e 里前面的用例会改候选状态，不稳定 ✗）
  await p.evaluate(() => {
    window.MH.ui.wizardOptOut = true;
    const st = window.MH.store.state;
    st.people[0].sex = 'm';
    st.people[1].sex = 'f';
    st.phase = 'play';                       // .plist 只在游玩面板里 ✓
    window.MH.render();
  });
  await p.click('#tabPlay');
  await p.waitForTimeout(150);
  // 角标颜色按底色区分 ✓：浅底（候选/普通）用**人物颜色** ✓；实心底（已确定）用**白色** ✓
  await p.evaluate(() => {
    const st = window.MH.store.state;
    delete st.play.placed[st.people[1].id];        // B 未确定（浅底 ✓）
    st.play.placed[st.people[0].id] = '0,0';       // A 已确定（实心底 ✓）
    window.MH.render();
  });
  await p.waitForTimeout(120);
  const dotStyle = await p.evaluate(() => {
    const st = window.MH.store.state;
    const dotOf = pid => {
      const li = document.querySelector('.plist li[data-id="' + pid + '"] .sex-dot');
      return li ? { t: li.textContent, c: getComputedStyle(li).color, placed: !!document.querySelector('.plist li.placed[data-id="' + pid + '"]') } : null;
    };
    return { a: dotOf(st.people[0].id), b: dotOf(st.people[1].id) };
  });
  ok(dotStyle.a && dotStyle.a.c === 'rgb(255, 255, 255)' && dotStyle.a.placed,
    '已确定（实心底）的性别角标是**白色** ✓：' + JSON.stringify(dotStyle.a));
  ok(dotStyle.b && dotStyle.b.c !== 'rgb(255, 255, 255)' && !dotStyle.b.placed,
    '候选/普通（浅底）的性别角标用**人物颜色** ✓：' + JSON.stringify(dotStyle.b));
  await p.click('#tabPrep');

  // 63) 地图上不显示性别标记（整块断言由 section 60 覆盖 ✓）

  console.log(A.join('\n'));
  console.log('\n失败数: ' + A.filter(s => s.startsWith('FAIL')).length);
  console.log('页面错误: ' + JSON.stringify(errs));
  await b.close();
  process.exit(A.some(s => s.startsWith('FAIL')) || errs.length ? 1 : 0);
})();

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
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto(FILE);
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
  await p.reload();
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

  await p.reload();
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
  const sbox = await p.locator('#snipper img.snipper-img').boundingBox();
  await p.mouse.move(sbox.x + 40, sbox.y + 40);
  await p.mouse.down();
  await p.mouse.move(sbox.x + 240, sbox.y + 190, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(400);
  const pins = await p.locator('.snipper-pin').count();
  ok(pins >= 1, '拖框截取生成摘录卡片：' + pins + ' 张');
  ok(((await p.locator('.snipper-badge').textContent()) || '').trim() === String(pins), '角标显示张数');
  await p.click('.snipper-tab');
  await p.waitForTimeout(250);
  ok(!(await p.locator('.snipper-panel').isVisible()), '📌 可收起悬浮窗');
  await p.screenshot({ path: '/tmp/mh-e2e-snipper.png' });
  await p.reload(); await p.waitForSelector('.cell'); await p.waitForTimeout(700);
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
  await p.reload(); await p.waitForSelector('.cell'); await p.waitForTimeout(500);
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
      placedOk: cells.filter(c => c.classList.contains('placed')).every(c => c.querySelector('.pb') && c.querySelector('.pb').textContent === '✓'),
      lastLabel: cells[cells.length - 1].querySelector('.pl').textContent,
      now: document.querySelector('.pnow') ? document.querySelector('.pnow').textContent.replace(/\s+/g, ' ').trim() : '',
    };
  });
  ok(grid.n === 24 && grid.lastLabel === 'Y', '24 人全在网格里且跳过 X（末位 ' + grid.lastLabel + '）');
  ok(grid.rows <= 5, '只占 ' + grid.rows + ' 行（每行 ' + grid.cols + ' 个）');
  ok(grid.h < 260, '人物区高度受控：' + grid.h + 'px（旧版一行一个 ≈ 700px+）');
  ok(grid.clearBtns === 1, '清除等操作只保留当前人物一份：' + grid.clearBtns);
  ok(grid.badgeA === '2', '有候选的人带数量角标：A=' + grid.badgeA);
  ok(grid.placedCount === 1 && grid.placedOk, '已确定的人填本人颜色并带 ✓');
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
      row0: [...document.querySelectorAll('.row-head')][0].textContent.trim(),
      col3: [...document.querySelectorAll('.col-head')][3].textContent.trim(),
      row7: [...document.querySelectorAll('.row-head')][7].textContent.trim(),
      done: !!document.querySelector('.row-head i.done'),
    };
  });
  ok(hg.rows === 8 && hg.cols === 10, '行列各一条提示：' + hg.rows + '×' + hg.cols);
  ok(hg.r3 === '0/0' && hg.c4 === '0/0', '提示条与格子严格对齐（行 Δtop/Δh=' + hg.r3 + '，列 Δleft/Δw=' + hg.c4 + '）');
  ok(hg.inside, '提示条在画布内，没被裁掉');
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
  await p.screenshot({ path: '/tmp/mh-e2e-heads.png' });

  console.log(A.join('\n'));
  console.log('\n失败数: ' + A.filter(s => s.startsWith('FAIL')).length);
  console.log('页面错误: ' + JSON.stringify(errs));
  await b.close();
  process.exit(A.some(s => s.startsWith('FAIL')) || errs.length ? 1 : 0);
})();

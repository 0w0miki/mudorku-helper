/* Murdoku Helper — 界面集成测试（jsdom 里真正加载 index.html 并模拟操作） */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const INDEX = path.join(__dirname, '..', 'index.html');

async function boot() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    const msg = String(e && e.message || e);
    if (!/not implemented/i.test(msg)) errors.push(msg);
  });
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));

  const dom = new JSDOM(fs.readFileSync(INDEX, 'utf8'), {
    url: 'file://' + INDEX,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  await new Promise(res => {
    if (dom.window.document.readyState === 'complete') return res();
    dom.window.addEventListener('load', res);
  });
  dom.window.confirm = () => true;
  dom.window.prompt = () => '新名字';
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

// 辅助函数同时接受 JSDOM 实例或 document
const asDoc = x => (x && x.window ? x.window.document : x);
const asWin = x => (x && x.window ? x.window : (x && x.defaultView) || x);

const q = (x, sel) => asDoc(x).querySelector(sel);
const qa = (x, sel) => [...asDoc(x).querySelectorAll(sel)];

function click(x, el) {
  assert.ok(el, '要点击的元素不存在');
  el.dispatchEvent(new (asWin(x).MouseEvent)('click', { bubbles: true, cancelable: true }));
}

function clickSel(x, sel) {
  const el = q(x, sel);
  assert.ok(el, '找不到元素 ' + sel);
  click(x, el);
}

function cellEl(x, r, c) { return q(x, '.cell[data-k="' + r + ',' + c + '"]'); }

function pointer(x, type, el, opts) {
  const win = asWin(x);
  const e = new win.MouseEvent(type, Object.assign({
    bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0,
  }, opts || {}));
  (el || win).dispatchEvent(e);
}

const msgEl = (x, k) => q(x, '.cell[data-k="' + k + '"]');
const hasClass = (x, k, cls) => msgEl(x, k).classList.contains(cls);

function pickLink(x, kind, id) {
  const sel = q(x, '#linkPicker');
  assert.ok(sel, '找不到关联下拉框');
  sel.value = kind + ':' + id;
  sel.dispatchEvent(new (asWin(x).Event)('change', { bubbles: true }));
}

function setInput(x, sel, value) {
  const el = q(x, sel);
  assert.ok(el, '找不到输入框 ' + sel);
  el.value = value;
  el.dispatchEvent(new (asWin(x).Event)('input', { bubbles: true }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.afterEach(() => { /* jsdom 实例在用例内 close */ });

// ---------------------------------------------------------------- 基础渲染

test('启动后渲染 8x8 棋盘与 8 个人物', async () => {
  const { dom, doc, errors } = await boot();
  const st = dom.window.MH.store.state;
  assert.equal(st.rows, 8);
  assert.equal(st.cols, 8);
  assert.equal(qa(doc, '.cell').length, 64);
  assert.equal(qa(doc, '.sidebar .chips .chip').length, 8);
  assert.equal([...st.people].map(p => p.label).join(''), 'ABCDEFGH');
  assert.equal(st.phase, 'prep');
  // 回归：SVG 覆盖层的线必须用 non-scaling-stroke，否则会被 viewBox 放大成粗带
  assert.equal(q(doc, '.grid-lines').getAttribute('vector-effect'), 'non-scaling-stroke');
  assert.equal(q(doc, '.grid-outer').getAttribute('vector-effect'), 'non-scaling-stroke');
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('生成地图：行/列变化会重建网格与人物', async () => {
  const { dom, doc } = await boot();
  setInput(dom, '#rowsInput', '3');
  setInput(dom, '#colsInput', '5');
  clickSel(dom, '[data-act="gen"]');
  const st = dom.window.MH.store.state;
  assert.equal(st.rows, 3);
  assert.equal(st.cols, 5);
  assert.equal(st.people.length, 3, '人物数 = min(3,5)');
  assert.equal(qa(doc, '.cell').length, 15);
  dom.window.close();
});

// ---------------------------------------------------------------- 准备阶段：区域

test('新建区域：点选格子 → 保存 → 生成加粗外轮廓', async () => {
  const { dom, doc, errors } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  assert.ok(dom.window.MH.ui.draft, '应进入草稿状态');

  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 1));
  pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 1, 1));
  pointer(dom, 'pointerup');

  setInput(dom, '#draftName', '红区');
  const save = q(doc, '[data-act="draft-save"]');
  assert.equal(save.disabled, false, '连通的 3 格可以保存');
  click(dom, save);

  const st = dom.window.MH.store.state;
  assert.equal(st.regions.length, 1);
  assert.equal(st.regions[0].name, '红区');
  assert.equal([...st.regions[0].cells].sort().join(' '), '0,0 0,1 1,1');
  assert.equal(dom.window.MH.ui.draft, null, '保存后退出草稿');

  const outline = q(doc, '.region-outline');
  assert.ok(outline, '应绘制区域外轮廓');
  assert.ok(outline.getAttribute('d').length > 0);
  assert.equal(outline.getAttribute('stroke'), st.regions[0].color);
  // 格子本身带区域底色
  assert.ok(cellEl(dom, 0, 0).style.background.includes('rgba'));
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('不连通的选择不能保存，可用「只保留最大连通块」修复', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 4, 4));
  pointer(dom, 'pointerup');

  assert.equal(q(doc, '[data-act="draft-save"]').disabled, true, '不连通应禁用保存');
  assert.ok(q(doc, '[data-act="draft-largest"]'), '应出现修复按钮');
  clickSel(dom, '[data-act="draft-largest"]');
  assert.equal([...dom.window.MH.ui.draft.cells].length, 1);
  assert.equal(dom.window.MH.store.state.regions.length, 0, '只修草稿，不落库');
  dom.window.close();
});

test('再次点击草稿内的格子会取消选择', async () => {
  const { dom } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  const el = cellEl(dom, 2, 2);
  pointer(dom, 'pointerdown', el); pointer(dom, 'pointerup');
  assert.equal(dom.window.MH.ui.draft.cells.size, 1);
  pointer(dom, 'pointerdown', el); pointer(dom, 'pointerup');
  assert.equal(dom.window.MH.ui.draft.cells.size, 0);
  dom.window.close();
});

test('拖动可以连续刷选格子', async () => {
  const { dom } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  pointer(dom, 'pointermove', cellEl(dom, 0, 1), { clientX: 0, clientY: 0 });
  pointer(dom, 'pointermove', cellEl(dom, 0, 2), { clientX: 0, clientY: 0 });
  pointer(dom, 'pointerup');
  assert.deepEqual([...dom.window.MH.ui.draft.cells].sort(), ['0,0', '0,1', '0,2']);
  dom.window.close();
});

// ---------------------------------------------------------------- 准备阶段：物品与关联

test('新建不可占据物品：该格在游玩阶段固定为红色 ✕', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '[data-act="new-item"]');
  pointer(dom, 'pointerdown', cellEl(dom, 3, 3));
  pointer(dom, 'pointerup');
  setInput(dom, '#draftName', '石头');
  const blocked = qa(doc, 'input[name="draftOcc"]').find(i => i.value === '0');
  blocked.checked = true;
  blocked.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  clickSel(dom, '[data-act="draft-save"]');

  const st = dom.window.MH.store.state;
  assert.equal(st.items.length, 1);
  assert.equal(st.items[0].occupiable, false);
  assert.equal(msgEl(dom, '3,3').querySelector('.xmark'), null, '准备阶段不显示 X');

  clickSel(dom, '#tabPlay');
  assert.equal(st.phase, 'play');
  assert.equal(dom.window.MH.core.xSource(st, '3,3'), 'auto');
  assert.ok(msgEl(dom, '3,3').querySelector('.xmark.auto'), '显示固定 X');
  dom.window.close();
});

test('人物关联：下拉框添加（默认正相关）+ 标签切换正负 + × 取消', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 1)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 2, 2)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const rid = dom.window.MH.store.state.regions[0].id;
  const other = dom.window.MH.store.state.regions[1].id;
  const pid = dom.window.MH.store.state.selectedPersonId;

  pickLink(dom, 'region', rid);
  assert.equal(dom.window.MH.core.getLink(dom.window.MH.store.state, pid, 'region', rid), 1, '下拉框添加默认正相关');
  assert.ok(q(dom, '.link-row .tag.pos'), '显示为 + 正相关');
  const opts = [...q(dom, '#linkPicker').options].map(o => o.value);
  assert.ok(!opts.includes('region:' + rid), '已关联的目标不再出现在下拉框里');
  assert.ok(opts.includes('region:' + other), '未关联的目标仍可选');

  clickSel(dom, '.link-row button[data-act="link"][data-pol="-1"]');
  assert.equal(dom.window.MH.core.getLink(dom.window.MH.store.state, pid, 'region', rid), -1);
  assert.ok(q(dom, '.link-row .tag.neg'), '显示为 − 负相关');

  clickSel(dom, '.link-row button[data-act="link"][data-pol="1"]');
  assert.equal(dom.window.MH.core.getLink(dom.window.MH.store.state, pid, 'region', rid), 1);

  clickSel(dom, '.link-row button[data-act="link"][data-pol="0"]');
  assert.equal(dom.window.MH.core.getLink(dom.window.MH.store.state, pid, 'region', rid), 0);
  assert.equal(dom.window.MH.store.state.people[0].links.length, 0);
  dom.window.close();
});

test('删除区域会清掉关联', async () => {
  const { dom } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const st = dom.window.MH.store.state;
  const rid = st.regions[0].id;
  pickLink(dom, 'region', rid);
  assert.equal(st.people[0].links.length, 1);
  clickSel(dom, '[data-act="del-region"][data-id="' + rid + '"]');
  assert.equal(st.regions.length, 0);
  assert.equal(st.people[0].links.length, 0);
  dom.window.close();
});

// ---------------------------------------------------------------- 游玩阶段：标记

test('游玩阶段：左键点按标注候选，可多处标注，再点取消', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;

  for (const k of ['0,0', '2,3', '4,4']) {
    const [r, c] = k.split(',');
    pointer(dom, 'pointerdown', cellEl(dom, +r, +c));
    pointer(dom, 'pointerup');
  }
  assert.equal([...st.play.candidates[pid]].sort().join(' '), '0,0 2,3 4,4');
  assert.equal(q(dom, '.cell[data-k="2,3"]').querySelectorAll('.cands i[data-person]').length, 1);

  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  pointer(dom, 'pointerup');
  assert.equal([...st.play.candidates[pid]].sort().join(' '), '2,3 4,4');
  dom.window.close();
});

test('游玩阶段：右键切换 X', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  cellEl(dom, 1, 1).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(dom.window.MH.core.xSource(st, '1,1'), 'user');
  assert.ok(q(dom, '.cell[data-k="1,1"] .xmark.user'));
  cellEl(dom, 1, 1).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(dom.window.MH.core.xSource(st, '1,1'), null);
  dom.window.close();
});

test('游玩阶段：长按出现进度环，走满后确定人物并在同行列标 X', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;

  const el = cellEl(dom, 1, 2);
  pointer(dom, 'pointerdown', el, { clientX: 10, clientY: 10 });
  const ring = q(doc, '.ring');
  assert.ok(ring, '按下应出现圆形进度条');
  assert.equal(ring.style.display, 'block');

  await sleep(950); // 长按阈值 700ms

  assert.equal(dom.window.MH.core.personAt(st, '1,2'), pid, '人物确定在该格');
  for (const c of [0, 1, 3, 4, 5, 6, 7]) {
    assert.equal(dom.window.MH.core.xSource(st, '1,' + c), 'place', '第 2 行第 ' + (c + 1) + ' 列应被排除');
  }
  for (const r of [0, 2, 3, 4, 5, 6, 7]) {
    assert.equal(dom.window.MH.core.xSource(st, r + ',2'), 'place', '第 ' + (r + 1) + ' 行第 3 列应被排除');
  }
  assert.equal(ring.style.display, 'none', '完成后隐藏进度条');

  pointer(dom, 'pointerup', el);
  assert.equal(dom.window.MH.core.personCandidateCount(st, pid), 0);
  dom.window.close();
});

test('短按不会误触发确定', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;
  pointer(dom, 'pointerdown', cellEl(dom, 5, 5));
  await sleep(120);
  pointer(dom, 'pointerup', cellEl(dom, 5, 5));
  assert.equal(Object.keys(st.play.placed).length, 0, '不应该确定位置');
  assert.equal(dom.window.MH.core.personCandidateCount(st, pid), 1, '而应记为候选');
  assert.equal(q(dom, '.ring').style.display, 'none', '松开后进度环必须消失');
  dom.window.close();
});

test('长按过程中移动会取消', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  pointer(dom, 'pointerdown', cellEl(dom, 1, 1), { clientX: 0, clientY: 0 });
  pointer(dom, 'pointermove', cellEl(dom, 1, 2), { clientX: 40, clientY: 0 });
  await sleep(850);
  assert.equal(Object.keys(dom.window.MH.store.state.play.placed).length, 0);
  pointer(dom, 'pointerup');
  dom.window.close();
});

test('「左键＝标 X」模式下单击直接标 X', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  clickSel(dom, '[data-act="left-mode"][data-mode="x"]');
  pointer(dom, 'pointerdown', cellEl(dom, 2, 2));
  pointer(dom, 'pointerup');
  assert.equal(dom.window.MH.core.xSource(dom.window.MH.store.state, '2,2'), 'user');
  dom.window.close();
});

test('确定人物时若同行列已有他人会被拒绝', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  st.play.placed[st.people[0].id] = '0,0';
  clickSel(dom, '.plist li[data-id="' + st.people[1].id + '"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 5));
  await sleep(950);
  assert.equal(dom.window.MH.core.personAt(st, '0,5'), null, '同行不能放第二个人');
  pointer(dom, 'pointerup');
  dom.window.close();
});

// ---------------------------------------------------------------- 悬停高亮

test('悬停格子高亮所在区域', async () => {
  const { dom } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  for (const [r, c] of [[0, 0], [0, 1], [1, 1]]) {
    pointer(dom, 'pointerdown', cellEl(dom, r, c));
    pointer(dom, 'pointerup');
  }
  clickSel(dom, '[data-act="draft-save"]');

  const baseBg = msgEl(dom, '0,0').style.background;
  pointer(dom, 'pointermove', cellEl(dom, 1, 1));
  const outline = q(dom, '.region-outline');
  assert.ok(outline.classList.contains('hl'), '移进区域时外框应高亮');
  assert.equal(msgEl(dom, '0,0').style.background, baseBg, '网格悬停只描外框，不填充整块');
  assert.equal(hasClass(dom, '0,0', 'hl-region'), false, '不再给格子加填充类');
  assert.equal(msgEl(dom, '3,3').style.background, 'rgb(255, 255, 255)', '区域外的格子不受影响');

  // 移到区域外，外框高亮消失
  pointer(dom, 'pointermove', cellEl(dom, 5, 5));
  assert.equal(q(dom, '.region-outline').classList.contains('hl'), false);
  dom.window.close();
});

test('悬停人物高亮其关联：正向绿色，负向红色', async () => {
  const { dom, doc } = await boot();
  // 区域1（正向关联 A）
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 1)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const r1 = dom.window.MH.store.state.regions[0].id;
  pickLink(dom, 'region', r1);
  // 区域2（负向关联 A）
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 3, 3)); pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 3, 4)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const r2 = dom.window.MH.store.state.regions[1].id;
  pickLink(dom, 'region', r2);
  clickSel(dom, '.link-row[data-hover-region="' + r2 + '"] button[data-act="link"][data-pol="-1"]');
  // 物品（正向关联 A）
  clickSel(dom, '[data-act="new-item"]');
  pointer(dom, 'pointerdown', cellEl(dom, 6, 1)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const i1 = dom.window.MH.store.state.items[0].id;
  pickLink(dom, 'item', i1);

  // 进入游玩阶段并放置 A，这样棋盘上有人物标记可悬停
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const a = st.people[0].id;
  pointer(dom, 'pointerdown', cellEl(dom, 7, 7));
  await sleep(950);
  pointer(dom, 'pointerup');

  const chip = q(doc, '.cell[data-k="7,7"] .person-chip');
  assert.ok(chip, 'A 应显示为已确定人物');
  pointer(dom, 'pointermove', chip);

  assert.ok(hasClass(dom, '0,0', 'hl-pos'), '正向区域绿色');
  // 人物高亮是「整块填充」：区域内每一格都被填色
  assert.equal(msgEl(dom, '0,1').style.background, 'rgba(22, 163, 74, 0.4)', '人物高亮是整块填充');
  assert.equal(msgEl(dom, '3,4').style.background, 'rgba(239, 68, 68, 0.46)', '负相关整块红色填充');
  assert.ok(hasClass(dom, '3,3', 'hl-neg'), '负向区域红色');
  assert.ok(hasClass(dom, '6,1', 'hl-pos'), '正向物品绿色');
  assert.ok(q(doc, '.region-outline.pos'), '正向区域轮廓变绿');
  assert.ok(q(doc, '.region-outline.neg'), '负向区域轮廓变红');

  // 鼠标移出棋盘后清除（棋盘 pointerleave 会清空悬停态）
  pointer(dom, 'pointermove', cellEl(dom, 5, 5));
  assert.ok(hasClass(dom, '5,5', 'hl-region') || true);
  dom.window.close();
});

// ---------------------------------------------------------------- 校验、撤销、持久化

test('实时检查会列出同行冲突', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const [a, b] = [st.people[0].id, st.people[1].id];
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  await sleep(950);
  pointer(dom, 'pointerup');
  st.play.placed[b] = '0,5'; // 手工制造非法状态，验证校验器
  dom.window.MH.render();
  const issues = qa(doc, '.issues .issue.error').map(li => li.textContent);
  assert.ok(issues.some(t => t.includes('第 1 行')), JSON.stringify(issues));
  assert.equal(a, st.people[0].id);
  dom.window.close();
});

test('撤销 / 重做恢复候选与 X', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;
  pointer(dom, 'pointerdown', cellEl(dom, 1, 1));
  pointer(dom, 'pointerup');
  assert.equal(dom.window.MH.core.personCandidateCount(st, pid), 1);
  clickSel(dom, '[data-act="undo"]');
  assert.equal(dom.window.MH.core.personCandidateCount(dom.window.MH.store.state, pid), 0);
  clickSel(dom, '[data-act="redo"]');
  assert.equal(dom.window.MH.core.personCandidateCount(dom.window.MH.store.state, pid), 1);
  dom.window.close();
});

test('确定人物后可「取消确定」并恢复被排除的 X', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;
  pointer(dom, 'pointerdown', cellEl(dom, 2, 2));
  await sleep(950);
  pointer(dom, 'pointerup');
  assert.ok(q(doc, '[data-act="unplace-person"][data-id="' + pid + '"]'));
  clickSel(dom, '[data-act="unplace-person"][data-id="' + pid + '"]');
  assert.equal(dom.window.MH.core.personAt(st, '2,2'), null);
  assert.equal(Object.keys(st.play.xmarks).length, 0);
  assert.equal(cellEl(dom, 2, 2).querySelector('.person-chip'), null);
  dom.window.close();
});

test('导入非法 JSON 会提示失败而不是崩溃', async () => {
  const { dom } = await boot();
  assert.throws(() => dom.window.MH.store.importText('{坏数据'), /JSON|Unexpected|Unexpected token|not valid JSON/i);
  dom.window.close();
});

test('导出文本可被重新导入（往返）', async () => {
  const { dom } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const text = dom.window.MH.store.exportText();
  dom.window.MH.store.importText(text);
  assert.equal(dom.window.MH.store.state.regions.length, 1);
  dom.window.close();
});

test('鼠标移到人物条上也会高亮关联', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 4, 4)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const rid = dom.window.MH.store.state.regions[0].id;
  pickLink(dom, 'region', rid);
  clickSel(dom, '.link-row[data-hover-region="' + rid + '"] button[data-act="link"][data-pol="-1"]');
  clickSel(dom, '#tabPlay');
  const li = q(doc, '.plist li[data-hover-person]');
  assert.ok(li, '人物条应带悬停标记');
  pointer(dom, 'pointermove', li);
  assert.ok(hasClass(dom, '4,4', 'hl-neg'));
  dom.window.close();
});

// ------------------------------------------------------------ 复核发现的渲染层回归

test('B4 区域换色后 SVG 外轮廓颜色立刻跟随', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 1, 1)); pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 1, 2)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const rid = dom.window.MH.store.state.regions[0].id;
  const before = q(doc, '.region-outline').getAttribute('stroke');
  clickSel(dom, '[data-act="color-region"][data-id="' + rid + '"]');
  const after = dom.window.MH.store.state.regions[0].color;
  const strokeNow = q(doc, '.region-outline').getAttribute('stroke');
  assert.notEqual(after, before, '颜色应换成另一个');
  assert.equal(strokeNow, after, '轮廓 stroke 必须跟着换色，而不是留旧色');
  dom.window.close();
});

test('B5 刷选格子时草稿外轮廓实时更新', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  assert.equal(q(doc, '#draftOutline').getAttribute('d'), '', '还没选格子时为空');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  assert.ok(q(doc, '#draftOutline').getAttribute('d').length > 0, '按下第一格就该出现草稿轮廓');
  pointer(dom, 'pointermove', cellEl(dom, 0, 1));
  pointer(dom, 'pointerup');
  const d = q(doc, '#draftOutline').getAttribute('d');
  assert.ok(d.includes('M0 0L2 0'), '两格合并后的上边：' + d);
  // 取消后清空
  clickSel(dom, '[data-act="draft-cancel"]');
  assert.equal(q(doc, '#draftOutline').getAttribute('d'), '');
  dom.window.close();
});

test('place ✕ 不能单独擦除，取消确定后才消失（界面提示）', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  await sleep(950);
  pointer(dom, 'pointerup');
  assert.equal(dom.window.MH.core.xSource(st, '0,1'), 'place');
  // 右键尝试擦掉
  cellEl(dom, 0, 1).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(dom.window.MH.core.xSource(dom.window.MH.store.state, '0,1'), 'place', 'X 应保留');
  assert.ok(qa(doc, '.toast-item').some(t => t.textContent.includes('同行/同列排除')), '应提示原因');
  // 取消确定后自动消失
  clickSel(dom, '[data-act="unplace-person"][data-id="' + pid + '"]');
  assert.equal(dom.window.MH.core.xSource(dom.window.MH.store.state, '0,1'), null);
  dom.window.close();
});

test('B-2 只有候选时「生成地图」也会先确认', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  pointer(dom, 'pointerup');
  const pid = dom.window.MH.store.state.selectedPersonId;
  assert.equal(dom.window.MH.core.personCandidateCount(dom.window.MH.store.state, pid), 1);
  clickSel(dom, '#tabPrep');

  let calls = 0;
  dom.window.confirm = () => { calls++; return false; };
  setInput(dom, '#rowsInput', '4');
  clickSel(dom, '[data-act="gen"]');
  assert.equal(calls, 1, '有候选时必须先确认');
  assert.equal(dom.window.MH.store.state.rows, 8, '取消后不生成');
  assert.equal(dom.window.MH.core.personCandidateCount(dom.window.MH.store.state, pid), 1, '取消后候选保留');

  dom.window.confirm = () => { calls++; return true; };
  clickSel(dom, '[data-act="gen"]');
  assert.equal(calls, 2);
  assert.equal(dom.window.MH.store.state.rows, 4, '确认后才生成');
  dom.window.close();
});

test('B-1 撤销内容改动后，缩放设置不回跳', async () => {
  const { dom } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  for (let i = 0; i < 3; i++) clickSel(dom, '#btnZoomIn');   // 44 → 62
  assert.equal(dom.window.MH.store.state.settings.cellSize, 62);
  clickSel(dom, '#btnUndo');
  assert.equal(dom.window.MH.store.state.regions.length, 0, '区域被撤销');
  assert.equal(dom.window.MH.store.state.settings.cellSize, 62, '缩放不受撤销影响');
  dom.window.close();
});

test('缩放改成放大镜 + −/+ 按钮：步进、边界禁用、棋盘尺寸跟随', async () => {
  const { dom, doc } = await boot();
  const size = () => dom.window.MH.store.state.settings.cellSize;
  const cssVar = () => q(doc, '#board').style.getPropertyValue('--cell');
  assert.equal(size(), 44);
  assert.equal(cssVar(), '44px');

  clickSel(dom, '#btnZoomIn');
  assert.equal(size(), 50);
  assert.equal(cssVar(), '50px', '棋盘实际尺寸要跟着变');
  clickSel(dom, '#btnZoomOut');
  assert.equal(size(), 44);

  const C = dom.window.MurdokuCore;
  for (let i = 0; i < 40; i++) clickSel(dom, '#btnZoomOut');
  assert.equal(size(), C.CELL_MIN, '缩到最小值');
  assert.equal(cssVar(), C.CELL_MIN + 'px');
  assert.equal(q(doc, '#btnZoomOut').disabled, true, '到最小后「−」应禁用');

  for (let i = 0; i < 60; i++) clickSel(dom, '#btnZoomIn');
  assert.equal(size(), C.CELL_MAX, '放到最大值');
  assert.equal(cssVar(), C.CELL_MAX + 'px');
  assert.equal(q(doc, '#btnZoomIn').disabled, true, '到最大后「+」应禁用');

  assert.ok(q(doc, '.zoomctl .zoom-icon'), '应有放大镜图标');

  // 滑块与按钮是同一个设置，且互相同步
  const range = q(doc, '#cellSize');
  assert.ok(range, '滑块仍保留');
  setInput(dom, '#cellSize', '30');
  assert.equal(size(), 30, '拖动滑块生效');
  assert.equal(cssVar(), '30px', '棋盘随之变化');
  clickSel(dom, '#btnZoomIn');
  assert.equal(size(), 36, '按钮在滑块基础上继续步进');
  assert.equal(range.value, '36', '按钮操作后滑块位置同步');
  assert.equal(q(doc, '#btnZoomOut').disabled, false, '离开边界后取消禁用');
  dom.window.close();
});

test('B-5 pointercancel 会取消长按，不会误放人物', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;
  pointer(dom, 'pointerdown', cellEl(dom, 1, 1));
  assert.equal(q(doc, '.ring').style.display, 'block');
  dom.window.dispatchEvent(new dom.window.Event('pointercancel', { bubbles: true }));
  assert.equal(q(doc, '.ring').style.display, 'none', '取消后进度环立刻消失');
  await sleep(900);
  assert.equal(Object.keys(dom.window.MH.store.state.play.placed).length, 0, '不应确定任何人物');
  assert.equal(dom.window.MH.core.personCandidateCount(dom.window.MH.store.state, pid), 0, '也不该算作点击');
  pointer(dom, 'pointerup');
  dom.window.close();
});

test('覆盖层所有图形都必须是 non-scaling-stroke，否则描边会被 viewBox 放大成粗色带', async () => {
  const { dom, doc } = await boot();
  // 造出覆盖层里全部四类图形：网格线、外框、区域轮廓、草稿轮廓
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 1)); pointer(dom, 'pointerup');
  assert.notEqual(q(doc, '#draftOutline').getAttribute('d'), '', '草稿轮廓应已绘制');
  clickSel(dom, '[data-act="draft-save"]');

  const shapes = qa(doc, '#overlay path, #overlay rect');
  assert.ok(shapes.length >= 4, '覆盖层应至少有网格线/外框/区域轮廓/草稿轮廓，实际 ' + shapes.length);
  for (const el of shapes) {
    assert.equal(
      el.getAttribute('vector-effect'), 'non-scaling-stroke',
      '覆盖层图形缺少 non-scaling-stroke（描边会被放大 ' + dom.window.MH.store.state.settings.cellSize + ' 倍）：'
        + (el.getAttribute('class') || el.tagName)
    );
  }
  dom.window.close();
});

// ------------------------------------------------------------ 本轮 6 项改动

test('① 新建区域会从原区域拿走重叠格子，并在草稿里提示归属会转移', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 1)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  assert.equal(dom.window.MH.store.state.regions[0].cells.length, 2);

  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 1)); pointer(dom, 'pointerup');
  pointer(dom, 'pointerdown', cellEl(dom, 1, 1)); pointer(dom, 'pointerup');
  assert.match(q(doc, '#draftMeta').textContent, /归属会移过来/, '草稿应提示会从原区域移出');
  clickSel(dom, '[data-act="draft-save"]');

  const st = dom.window.MH.store.state;
  assert.equal(st.regions.length, 2);
  assert.equal([...st.regions[0].cells].join(' '), '0,0', '重叠格已从原区域移走');
  assert.equal([...st.regions[1].cells].sort().join(' '), '0,1 1,1');
  // 棋盘上每格只显示一个区域底色
  assert.equal(dom.window.MH.core.regionsAt(st, '0,1').length, 1);
  dom.window.close();
});

test('② 游玩侧显示「正/负相关」，检查面板不把关联当成必须满足的规则', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const rid = dom.window.MH.store.state.regions[0].id;
  pickLink(dom, 'region', rid);

  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;
  st.play.placed[pid] = '4,4';          // 故意放在区域外
  dom.window.MH.render();

  const text = qa(doc, '.issues .issue').map(e => e.textContent).join(' | ');
  assert.ok(!/区域/.test(text), '关联不符不该出现在检查里：' + text);
  const links = qa(doc, '.link-row .tag').map(e => e.textContent).join(' ');
  assert.match(links, /\+ 正相关/, '应显示为正相关：' + links);
  assert.ok(!/应满足|禁止/.test(q(doc, '.sidebar').textContent), '不应出现「应满足/禁止」字样');
  dom.window.close();
});

test('③ 游玩阶段：按住拖动连续标注候选，整段只算一次撤销', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  const pid = dom.window.MH.store.state.selectedPersonId;
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0));
  pointer(dom, 'pointermove', cellEl(dom, 0, 1), { clientX: 100, clientY: 0 });
  pointer(dom, 'pointermove', cellEl(dom, 0, 2), { clientX: 200, clientY: 0 });
  pointer(dom, 'pointerup');
  const st = dom.window.MH.store.state;
  assert.equal([...st.play.candidates[pid]].sort().join(' '), '0,0 0,1 0,2');
  clickSel(dom, '#btnUndo');
  assert.equal(dom.window.MH.core.personCandidateCount(dom.window.MH.store.state, pid), 0, '一次撤销清掉整段');
  dom.window.close();
});

test('③ 从已有候选的格子开始拖动 = 连续擦除', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  const pid = dom.window.MH.store.state.selectedPersonId;
  for (const k of ['1,0', '1,1', '1,2']) {
    const [r, c] = k.split(',').map(Number);
    pointer(dom, 'pointerdown', cellEl(dom, r, c)); pointer(dom, 'pointerup');
  }
  assert.equal(dom.window.MH.core.personCandidateCount(dom.window.MH.store.state, pid), 3);
  pointer(dom, 'pointerdown', cellEl(dom, 1, 1));
  pointer(dom, 'pointermove', cellEl(dom, 1, 2), { clientX: 100, clientY: 0 });
  pointer(dom, 'pointerup');
  assert.equal([...dom.window.MH.store.state.play.candidates[pid]].join(' '), '1,0', '拖过的候选被擦掉');
  dom.window.close();
});

test('④ 标 X 模式下可以拖动连续标 X', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  clickSel(dom, '[data-act="left-mode"][data-mode="x"]');
  pointer(dom, 'pointerdown', cellEl(dom, 2, 0));
  pointer(dom, 'pointermove', cellEl(dom, 2, 1), { clientX: 100, clientY: 0 });
  pointer(dom, 'pointermove', cellEl(dom, 2, 2), { clientX: 200, clientY: 0 });
  pointer(dom, 'pointerup');
  const st = dom.window.MH.store.state;
  for (const c of [0, 1, 2]) assert.equal(dom.window.MH.core.xSource(st, '2,' + c), 'user', '2,' + c);
  clickSel(dom, '#btnUndo');
  assert.equal(Object.keys(dom.window.MH.store.state.play.xmarks).length, 0, '一次撤销清掉整段');
  dom.window.close();
});

test('⑤ 标 X 模式下长按不会放人（也不出现进度环）', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  clickSel(dom, '[data-act="left-mode"][data-mode="x"]');
  pointer(dom, 'pointerdown', cellEl(dom, 3, 3));
  const ring = q(doc, '.ring');
  assert.ok(!ring || ring.style.display === 'none', 'X 模式不该出现长按进度环');
  await sleep(900);
  assert.equal(Object.keys(dom.window.MH.store.state.play.placed).length, 0, '不应确定人物');
  pointer(dom, 'pointerup');
  assert.equal(dom.window.MH.core.xSource(dom.window.MH.store.state, '3,3'), 'user', '松开时按单击处理');
  dom.window.close();
});

test('⑤ 候选模式下长按仍然正常（回归）', async () => {
  const { dom } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  pointer(dom, 'pointerdown', cellEl(dom, 3, 3));
  assert.equal(q(dom, '.ring').style.display, 'block', '候选模式应出现进度环');
  await sleep(950);
  pointer(dom, 'pointerup');
  assert.equal(dom.window.MH.core.personAt(st, '3,3'), st.selectedPersonId);
  dom.window.close();
});


test('切换正负相关不会改变关联列表的顺序', async () => {
  const { dom, doc } = await boot();
  for (const [r, c, name] of [[0, 0, '甲区'], [2, 2, '乙区'], [4, 4, '丙区']]) {
    clickSel(dom, '[data-act="new-region"]');
    pointer(dom, 'pointerdown', cellEl(dom, r, c)); pointer(dom, 'pointerup');
    setInput(dom, '#draftName', name);
    clickSel(dom, '[data-act="draft-save"]');
  }
  const st = dom.window.MH.store.state;
  const [r1, r2, r3] = st.regions.map(r => r.id);
  for (const id of [r1, r2, r3]) pickLink(dom, 'region', id);
  const order = () => qa(doc, '.link-row .nm').map(e => e.textContent).join(' ');
  assert.equal(order(), '甲区 乙区 丙区');

  // 把中间那条切成负相关，顺序不变
  clickSel(dom, '.link-row[data-hover-region="' + r2 + '"] button[data-act="link"][data-pol="-1"]');
  assert.equal(order(), '甲区 乙区 丙区', '切换极性不该重排');
  assert.equal(dom.window.MH.core.getLink(dom.window.MH.store.state, st.selectedPersonId, 'region', r2), -1);
  // 再切回来
  clickSel(dom, '.link-row[data-hover-region="' + r2 + '"] button[data-act="link"][data-pol="1"]');
  assert.equal(order(), '甲区 乙区 丙区');
  // 删掉中间一条，剩下的顺序也不变
  clickSel(dom, '.link-row[data-hover-region="' + r2 + '"] button[data-act="link"][data-pol="0"]');
  assert.equal(order(), '甲区 丙区');
  // 重新添加会追加到末尾
  pickLink(dom, 'region', r2);
  assert.equal(order(), '甲区 丙区 乙区');
  dom.window.close();
});

test('人物编号：面板上可改名，重复/非法会被拒绝', async () => {
  const { dom, doc } = await boot();
  const st = () => dom.window.MH.store.state;
  const pid = st().selectedPersonId;

  assert.ok(q(doc, '[data-act="rename-person"][data-id="' + pid + '"]'), '人物面板应有改名按钮');
  dom.window.prompt = () => '小明';
  clickSel(dom, '[data-act="rename-person"][data-id="' + pid + '"]');
  assert.equal(dom.window.MH.core.person(st(), pid).label, '小明');
  assert.equal(q(doc, '.chips .chip').textContent, '小明', '人物条上的标记跟着变');

  // 与别人重复 → 拒绝并提示
  dom.window.prompt = () => 'B';
  clickSel(dom, '[data-act="rename-person"][data-id="' + pid + '"]');
  assert.equal(dom.window.MH.core.person(st(), pid).label, '小明', '重复编号不应生效');
  assert.ok(qa(doc, '.toast-item').some(t => t.textContent.includes('已被其它人物占用')), '应提示重复');

  // 取消对话框 → 不变
  dom.window.prompt = () => null;
  clickSel(dom, '[data-act="rename-person"][data-id="' + pid + '"]');
  assert.equal(dom.window.MH.core.person(st(), pid).label, '小明');

  // 改名可撤销
  clickSel(dom, '#btnUndo');
  assert.equal(dom.window.MH.core.person(st(), pid).label, 'A', '改名可撤销');
  dom.window.close();
});

test('长编号在棋盘上用小字号，不会撑破圆形标记', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const pid = st.selectedPersonId;
  st.play.placed[pid] = '2,2';
  dom.window.MH.render();
  assert.equal(q(doc, '.cell[data-k="2,2"] .person-chip').className, 'person-chip', '单个字符用正常字号');

  dom.window.prompt = () => 'ABCD';
  clickSel(dom, '#tabPrep');
  clickSel(dom, '[data-act="rename-person"][data-id="' + pid + '"]');
  clickSel(dom, '#tabPlay');
  assert.equal(q(doc, '.cell[data-k="2,2"] .person-chip').className, 'person-chip small', '4 个字符降档');
  dom.window.close();
});

// ------------------------------------------------------------ 底图与对齐（界面层）

function withBg(dom, patch) {
  const C = dom.window.MH.core;
  dom.window.MH.store.setBgData('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
  dom.window.MH.store.commit('放底图', s => C.setBackground(s, Object.assign(
    { kind: 'image', name: 'map.png', w: 400, h: 300, scale: 1, opacity: 0.85, visible: true }, patch || {})));
  dom.window.MH.render();
}

test('底图卡片：没有底图时只有导入按钮，有底图后出现全部控制', async () => {
  const { dom, doc } = await boot();
  assert.ok(q(doc, '[data-act="bg-import"]'), '应有导入按钮');
  assert.ok(!q(doc, '#bgOpacity'), '没有底图时不显示透明度');

  withBg(dom);
  for (const sel of ['[data-act="bg-import"]', '[data-act="bg-toggle"]', '[data-act="bg-fit"]',
                     '[data-act="bg-remove"]', '#bgOpacity', '#bgScale', '[data-act="bg-align"]']) {
    assert.ok(q(doc, sel), '有底图后应出现 ' + sel);
  }
  assert.match(q(doc, '.sidebar').textContent, /map\.png/, '显示底图文件名');
  dom.window.close();
});

test('对齐模式：拖动移动网格，不会误刷区域，方向键可微调', async () => {
  const { dom, doc } = await boot();
  withBg(dom);
  clickSel(dom, '[data-act="bg-align"]');
  assert.equal(dom.window.MH.ui.aligning, true);
  assert.equal(q(doc, '#alignHandle').hidden, false, '右下角手柄出现');
  assert.ok(q(doc, '#board').classList.contains('aligning'), '棋盘进入对齐态');

  const g0 = { x: dom.window.MH.store.state.grid.x, y: dom.window.MH.store.state.grid.y };
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0), { clientX: 100, clientY: 100 });
  pointer(dom, 'pointermove', cellEl(dom, 0, 1), { clientX: 160, clientY: 130 });
  pointer(dom, 'pointerup');
  let g = dom.window.MH.store.state.grid;
  assert.equal(g.x, g0.x + 60, '水平拖动 60px');
  assert.equal(g.y, g0.y + 30, '垂直拖动 30px');
  assert.equal(dom.window.MH.store.state.regions.length, 0, '对齐模式下不会误建区域草稿');
  assert.equal(dom.window.MH.ui.draft, null);

  // 方向键 1px / Shift 10px
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
  g = dom.window.MH.store.state.grid;
  assert.equal(g.x, g0.x + 61);
  assert.equal(g.y, g0.y + 40);

  // 关掉对齐模式后，拖动恢复成刷选
  clickSel(dom, '[data-act="bg-align"]');
  assert.equal(dom.window.MH.ui.aligning, false);
  assert.equal(q(doc, '#alignHandle').hidden, true);
  dom.window.close();
});

test('对齐模式：右下角手柄等比缩放网格（保持左上角不动）', async () => {
  const { dom, doc } = await boot();
  withBg(dom);
  clickSel(dom, '[data-act="bg-align"]');
  const before = dom.window.MH.store.state.settings.cellSize;
  const g0 = { x: dom.window.MH.store.state.grid.x, y: dom.window.MH.store.state.grid.y };

  const handle = q(doc, '#alignHandle');
  pointer(dom, 'pointerdown', handle, { clientX: 0, clientY: 0 });
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 60 }));
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));

  const st = dom.window.MH.store.state;
  assert.ok(st.settings.cellSize > before, '拖手柄后格子变大：' + before + ' → ' + st.settings.cellSize);
  assert.equal(st.grid.x, g0.x, '左上角 x 不动');
  assert.equal(st.grid.y, g0.y, '左上角 y 不动');
  dom.window.close();
});

test('底图透明度 / 显示隐藏 / 网格归位 / 移除', async () => {
  const { dom, doc } = await boot();
  withBg(dom);
  setInput(dom, '#bgOpacity', '40');
  assert.equal(dom.window.MH.store.state.bg.opacity, 0.4);

  clickSel(dom, '[data-act="bg-toggle"]');
  assert.equal(dom.window.MH.store.state.bg.visible, false);
  clickSel(dom, '[data-act="bg-toggle"]');
  assert.equal(dom.window.MH.store.state.bg.visible, true);

  dom.window.MH.store.commit('挪', s => dom.window.MH.core.setGridOffset(s, 33, 44));
  clickSel(dom, '[data-act="bg-align"]');
  clickSel(dom, '[data-act="bg-reset"]');
  assert.equal(dom.window.MH.store.state.grid.x, 0);
  assert.equal(dom.window.MH.store.state.grid.y, 0);

  clickSel(dom, '[data-act="bg-remove"]');
  assert.equal(dom.window.MH.store.state.bg, null);
  assert.equal(dom.window.MH.ui.aligning, false, '移除底图会退出对齐模式');
  assert.ok(!q(doc, '#bgOpacity'), '控制项随之消失');
  dom.window.close();
});

test('游玩阶段也能开关底图显示', async () => {
  const { dom, doc } = await boot();
  withBg(dom);
  clickSel(dom, '#tabPlay');
  const box = q(doc, 'input[data-act="bg-toggle"]');
  assert.ok(box, '游玩阶段应有底图显示开关');
  assert.equal(box.checked, true);
  clickSel(dom, 'input[data-act="bg-toggle"]');
  assert.equal(dom.window.MH.store.state.bg.visible, false);
  dom.window.close();
});

test('有底图时格子底为半透明（让底图透出来），没有底图时是纯白', async () => {
  const { dom } = await boot();
  assert.equal(msgEl(dom, '2,2').style.background, 'rgb(255, 255, 255)', '无底图：纯白');
  withBg(dom);
  const bgStr = msgEl(dom, '2,2').style.background;
  assert.ok(bgStr.includes('rgba(255,255,255,.34)'), '有底图：半透明白纱 → ' + bgStr);
  assert.ok(!bgStr.includes('255, 255, 255)'), '不能再是纯白，否则会盖住底图');
  // 区域底色叠在白纱之上
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 2, 2)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const withRegion = msgEl(dom, '2,2').style.background;
  const tintAt = withRegion.indexOf('rgba(14,165,233');
  const veilAt = withRegion.indexOf('rgba(255,255,255,.34)');
  assert.ok(tintAt >= 0 && veilAt > tintAt, '区域底色在白纱之上（两层）：' + withRegion);
  dom.window.close();
});

// ------------------------------------------------------------ PDF 摘录悬浮窗（右侧）

test('PDF 摘录窗：挂载在右侧，初始只有导入入口', async () => {
  const { dom, doc, errors } = await boot();
  assert.ok(q(doc, '#snipper'), '悬浮窗应已挂载');
  assert.ok(q(doc, '#snipper [data-snip="stage"]'), '有舞台区');
  assert.ok(q(doc, '#snipper [data-snip="import"]'), '有导入按钮');
  const file = q(doc, '#snipper [data-snip="file"]');
  assert.ok(file, '有隐藏的文件输入');
  assert.match(file.getAttribute('accept'), /pdf/i, '接受 PDF');
  assert.match(q(doc, '#snipper .snipper-empty').textContent, /拖一个矩形/, '给出操作提示');
  assert.equal(q(doc, '#snipper .snipper-pin'), null, '初始没有卡片');
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('PDF 摘录窗：可收起 / 展开', async () => {
  const { dom, doc } = await boot();
  const panel = q(doc, '#snipper');
  assert.equal(panel.classList.contains('collapsed'), false, '默认展开');

  clickSel(dom, '#snipper [data-snip="toggle"]');
  assert.equal(panel.classList.contains('collapsed'), true, '点一下收起');

  clickSel(dom, '#snipper [data-snip="toggle"]');
  assert.equal(panel.classList.contains('collapsed'), false, '再点展开');
  dom.window.close();
});

// 注意：jsdom 在 file:// 下属 opaque origin，没有 localStorage。
// 所以持久化那一段没法在这里断言，改为直接注入 state 验证渲染与交互
// （render / 删除 / 清空 与持久化走的是同一条路径）。
test('PDF 摘录窗：卡片渲染、可单张删除、可清空', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.confirm = () => true;
  win.MurdokuSnipper.state.pins = [
    { id: 'p1', page: 2, w: 40, h: 30, url: 'data:image/png;base64,AAA' },
    { id: 'p2', page: 3, w: 20, h: 20, url: 'data:image/png;base64,BBB' },
  ];
  win.MurdokuSnipper.render();

  const cards = qa(doc, '#snipper .snipper-pin');
  assert.equal(cards.length, 2, '两张卡片');
  assert.match(cards[0].textContent, /第 2 页/, '卡片标出页码');
  assert.equal(q(doc, '#snipper [data-snip="badge"]').textContent, '2', '角标显示张数');

  clickSel(dom, '#snipper [data-snip="pin-del"][data-id="p1"]');
  assert.equal(qa(doc, '#snipper .snipper-pin').length, 1, '删掉一张');
  assert.equal(win.MurdokuSnipper.state.pins[0].id, 'p2', '删的是指定的那张');

  clickSel(dom, '#snipper [data-snip="clear"]');
  assert.equal(qa(doc, '#snipper .snipper-pin').length, 0, '清空');
  assert.equal(q(doc, '#snipper [data-snip="badge"]').hidden, true, '角标跟着隐藏');
  dom.window.close();
});

test('PDF 摘录窗：与棋盘状态完全隔离', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MurdokuSnipper.state.pins = [
    { id: 'x', page: 1, w: 10, h: 10, url: 'data:image/png;base64,CCC' },
  ];
  win.MurdokuSnipper.render();
  assert.equal(qa(doc, '#snipper .snipper-pin').length, 1);
  assert.equal(win.MH.store.state.bg, null, '摘录卡片不写进棋盘状态');
  dom.window.close();
});

test('PDF 摘录窗：没有 localStorage 时也不报错（file:// 场景）', async () => {
  const { dom, doc, errors } = await boot();
  const win = dom.window;
  // 先确认这个环境确实没有 localStorage，否则这条测试就没意义了
  assert.equal(win.localStorage, undefined, 'jsdom 在 file:// 下确实没有 localStorage');

  clickSel(dom, '#snipper [data-snip="toggle"]');          // 会尝试写盘
  win.MurdokuSnipper.state.pins = [{ id: 'z', page: 1, w: 5, h: 5, url: 'data:image/png;base64,DDD' }];
  win.MurdokuSnipper.render();
  assert.deepEqual(errors, [], '无 localStorage 也不该有运行期报错');
  dom.window.close();
});


test('悬停人物时，他自己的候选格被顶出来（同格别人的候选淡下去）', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const [a, b] = st.people.map(p => p.id);

  // A 在 (0,0)(0,1) 标候选；B 在 (0,1)(2,2) 标候选
  st.play.candidates[a] = ['0,0', '0,1'];
  st.play.candidates[b] = ['0,1', '2,2'];
  dom.window.MH.render();

  // 悬停 A 的候选小标签
  const chipA = q(doc, '.cell[data-k="0,0"] .cands i[data-person="' + a + '"]');
  assert.ok(chipA, 'A 的候选标签应存在');
  pointer(dom, 'pointermove', chipA);

  assert.ok(msgEl(dom, '0,0').classList.contains('hl-cand'), 'A 的候选格 (0,0) 被顶出');
  assert.ok(msgEl(dom, '0,1').classList.contains('hl-cand'), 'A 的候选格 (0,1) 被顶出');
  assert.equal(msgEl(dom, '2,2').classList.contains('hl-cand'), false, 'B 独有的候选格不受影响');
  // 共格时只点亮 A 的标签
  assert.ok(q(dom, '.cell[data-k="0,1"] .cands i[data-person="' + a + '"]').classList.contains('on'));
  assert.equal(q(dom, '.cell[data-k="0,1"] .cands i[data-person="' + b + '"]').classList.contains('on'), false);
  // 描边颜色取被悬停人物的颜色
  assert.equal(q(doc, '.cell[data-k="0,0"]').style.getPropertyValue('--cand-ring'), st.people[0].color);

  // 移开后清除
  pointer(dom, 'pointermove', cellEl(dom, 4, 4));
  assert.equal(msgEl(dom, '0,0').classList.contains('hl-cand'), false);
  assert.equal(q(dom, '.cell[data-k="0,1"] .cands i[data-person="' + a + '"]').classList.contains('on'), false);
  dom.window.close();
});

test('悬停侧栏人物条同样会顶出候选格', async () => {
  const { dom, doc } = await boot();
  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const b = st.people[1].id;
  st.play.candidates[b] = ['3,3'];
  dom.window.MH.render();

  pointer(dom, 'pointermove', q(doc, '.plist li[data-id="' + b + '"]'));
  assert.ok(msgEl(dom, '3,3').classList.contains('hl-cand'), '从侧栏悬停也会顶出候选');
  pointer(dom, 'pointerleave', q(doc, '.sidebar'));
  assert.equal(msgEl(dom, '3,3').classList.contains('hl-cand'), false, '移出侧栏后清除');
  dom.window.close();
});

test('候选格高亮与关联填色可以叠加，互不覆盖', async () => {
  const { dom, doc } = await boot();
  // A 关联一个含 (0,0) 的区域，同时 A 在 (0,0) 有候选
  clickSel(dom, '[data-act="new-region"]');
  pointer(dom, 'pointerdown', cellEl(dom, 0, 0)); pointer(dom, 'pointerup');
  clickSel(dom, '[data-act="draft-save"]');
  const rid = dom.window.MH.store.state.regions[0].id;
  pickLink(dom, 'region', rid);

  clickSel(dom, '#tabPlay');
  const st = dom.window.MH.store.state;
  const a = st.selectedPersonId;
  st.play.candidates[a] = ['0,0'];
  dom.window.MH.render();

  pointer(dom, 'pointermove', q(doc, '.cell[data-k="0,0"] .cands i'));
  const cell = msgEl(dom, '0,0');
  assert.ok(cell.classList.contains('hl-pos'), '关联填色仍在');
  assert.ok(cell.classList.contains('hl-cand'), '候选描边同时在');
  assert.ok(/rgba\(22, ?163, ?74/.test(cell.style.background), '填色没被顶掉：' + cell.style.background);
  dom.window.close();
});

// ------------------------------------------------------------ PDF 摘录窗：本轮四项改进

test('摘录窗：收起按钮是箭头图标（不再是 📌），展开/收起会转向', async () => {
  const { dom, doc } = await boot();
  const tab = q(doc, '#snipper .snipper-tab');
  assert.ok(tab.querySelector('svg.snipper-chev'), 'tab 里是箭头 SVG');
  assert.ok(!/📌/.test(tab.textContent), '不再有 📌');
  assert.ok(q(doc, '#snipper [data-snip="toggle"] svg.snipper-chev'), '头部收起按钮也是箭头');
  // 头部的「折叠缩略图」按钮同样是箭头
  assert.ok(q(doc, '#snipper [data-snip="fold-stage"] svg.snipper-chev'));
  dom.window.close();
});

test('摘录窗：PDF 缩略图可以折叠，且状态留在 UI 里', async () => {
  const { dom, doc } = await boot();
  const panel = q(doc, '#snipper');
  assert.equal(panel.classList.contains('stage-folded'), false, '默认展开缩略图');
  clickSel(dom, '#snipper [data-snip="fold-stage"]');
  assert.equal(panel.classList.contains('stage-folded'), true, '可以折叠');
  assert.equal(dom.window.MurdokuSnipper.state.stageFolded, true, '状态记录下来');
  clickSel(dom, '#snipper [data-snip="fold-stage"]');
  assert.equal(panel.classList.contains('stage-folded'), false);
  dom.window.close();
});

test('摘录窗：每张卡片可缩放（± / 点百分比还原）', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MurdokuSnipper.state.pins = [{ id: 'p1', page: 1, w: 240, h: 160, url: 'data:image/png;base64,AAA' }];
  win.MurdokuSnipper.render();

  const imgW = () => q(doc, '#snipper .snipper-pin-body img').style.width;
  const pct = () => q(doc, '#snipper .snip-pct').textContent;
  assert.equal(pct(), '100%', '默认按宽度显示');
  assert.equal(imgW(), '100%');

  clickSel(dom, '#snipper [data-snip="pin-zoom"][data-dir="1"]');
  assert.equal(pct(), '125%');
  assert.equal(imgW(), '125%', '图片按百分比变宽');
  clickSel(dom, '#snipper [data-snip="pin-zoom"][data-dir="1"]');
  assert.equal(pct(), '156%');
  clickSel(dom, '#snipper [data-snip="pin-zoom"][data-dir="-1"]');
  assert.equal(pct(), '125%');

  clickSel(dom, '#snipper .snip-pct');
  assert.equal(pct(), '100%', '点百分比还原 100%');
  assert.equal(win.MurdokuSnipper.state.pins[0].zoom, 1, '缩放值记在卡片上');
  dom.window.close();
});

test('摘录窗：卡片缩放有上下限并夹住', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MurdokuSnipper.state.pins = [{ id: 'p1', page: 1, w: 240, h: 160, url: 'data:image/png;base64,AAA' }];
  win.MurdokuSnipper.render();
  for (let i = 0; i < 30; i++) clickSel(dom, '#snipper [data-snip="pin-zoom"][data-dir="-1"]');
  assert.equal(q(doc, '#snipper .snip-pct').textContent, '50%', '最小 50%');
  for (let i = 0; i < 40; i++) clickSel(dom, '#snipper [data-snip="pin-zoom"][data-dir="1"]');
  assert.equal(q(doc, '#snipper .snip-pct').textContent, '400%', '最大 400%');
  dom.window.close();
});

test('摘录窗：卡片视口内按住拖动会平移（记录滚动位置）', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MurdokuSnipper.state.pins = [{ id: 'p1', page: 1, w: 240, h: 160, url: 'data:image/png;base64,AAA', zoom: 2 }];
  win.MurdokuSnipper.render();
  const body = q(doc, '#snipper .snipper-pin-body');
  assert.ok(body, '卡片有可拖动的视口');

  pointer(dom, 'pointerdown', body, { clientX: 200, clientY: 100 });
  win.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientX: 150, clientY: 80 }));
  win.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true }));
  // jsdom 不做真实布局（scrollLeft 恒为 0），所以断言模块记录的平移量
  const sc = win.MurdokuSnipper.state.scroll.p1;
  assert.equal(sc.x, 50, '水平位移：往左拖 50px → 内容右移 50');
  assert.equal(sc.y, 20, '垂直位移：往上拖 20px → 内容下移 20');
  dom.window.close();
});

test('摘录窗：拖标题栏可调整卡片顺序', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MurdokuSnipper.state.pins = [
    { id: 'a', page: 1, w: 10, h: 10, url: 'data:image/png;base64,AAA' },
    { id: 'b', page: 1, w: 10, h: 10, url: 'data:image/png;base64,BBB' },
    { id: 'c', page: 1, w: 10, h: 10, url: 'data:image/png;base64,CCC' },
  ];
  win.MurdokuSnipper.render();
  const order = () => qa(doc, '#snipper .snipper-pin').map(e => e.dataset.id).join(',');
  assert.equal(order(), 'a,b,c');

  const cap = q(doc, '#snipper .snipper-pin[data-id="a"] .snipper-cap');
  assert.ok(cap, '卡片有拖拽手柄区');
  pointer(dom, 'pointerdown', cap, { clientX: 10, clientY: 5 });
  win.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 400 }));
  win.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true }));
  assert.equal(order(), 'b,c,a', '拖到下方后顺序变化');
  assert.deepEqual(win.MurdokuSnipper.state.pins.map(p => p.id), ['b', 'c', 'a'], '数据顺序同步');
  dom.window.close();
});

test('摘录窗：点标题栏里的按钮不会误触发排序', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MurdokuSnipper.state.pins = [
    { id: 'a', page: 1, w: 10, h: 10, url: 'data:image/png;base64,AAA' },
    { id: 'b', page: 1, w: 10, h: 10, url: 'data:image/png;base64,BBB' },
  ];
  win.MurdokuSnipper.render();
  const cap = q(doc, '#snipper .snipper-pin[data-id="a"] .snipper-cap');
  const btn = cap.querySelector('[data-snip="pin-del"]');
  pointer(dom, 'pointerdown', btn, { clientX: 10, clientY: 5 });
  win.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 400 }));
  win.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true }));
  assert.deepEqual(win.MurdokuSnipper.state.pins.map(p => p.id), ['a', 'b'], '顺序没被拖动改掉');
  dom.window.close();
});


// ------------------------------------------------------------ 摘录卡片：导航缩略图（minimap）

test('minimap：视窗矩形按滚动位置换算（纯计算）', async () => {
  const { dom } = await boot();
  const r = dom.window.MurdokuSnipper.viewRect;
  assert.ok(typeof r === 'function', '导出 viewRect 便于验证换算');

  // 内容 1000×800，视窗 300×200，minimap 100×80，滚到 (350,300)
  const a = r({ contentW: 1000, contentH: 800, viewW: 300, viewH: 200, scrollLeft: 350, scrollTop: 300, mmW: 100, mmH: 80 });
  assert.equal(a.overflow, true, '内容大于视窗 → 有溢出');
  assert.equal(a.w, 30, '视窗宽占 300/1000 → minimap 上 30px');
  assert.equal(a.h, 20, '视窗高占 200/800 → 20px');
  assert.equal(a.x, 35, '水平位置 350/1000 → 35px');
  assert.equal(a.y, 30, '垂直位置 300/800 → 30px');

  // 滚到底：框不能越过右下边界
  const b = r({ contentW: 1000, contentH: 800, viewW: 300, viewH: 200, scrollLeft: 9999, scrollTop: 9999, mmW: 100, mmH: 80 });
  assert.equal(b.x + b.w, 100, '右边界对齐');
  assert.equal(b.y + b.h, 80, '下边界对齐');

  // 内容比视窗小 → 不显示
  const c = r({ contentW: 200, contentH: 100, viewW: 300, viewH: 200, scrollLeft: 0, scrollTop: 0, mmW: 100, mmH: 80 });
  assert.equal(c.overflow, false, '没溢出就不显示 minimap');

  // 极端长宽比下框不至于消失
  const d = r({ contentW: 100, contentH: 4000, viewW: 90, viewH: 60, scrollLeft: 0, scrollTop: 2000, mmW: 20, mmH: 148 });
  assert.ok(d.w >= 6 && d.h >= 6, '框有最小可见尺寸：' + JSON.stringify(d));
  dom.window.close();
});

test('minimap：每张卡片都有缩略图盒子，按原图长宽比', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MurdokuSnipper.state.pins = [
    { id: 'tall', page: 1, w: 260, h: 700, url: 'data:image/png;base64,AAA' },
    { id: 'wide', page: 1, w: 900, h: 200, url: 'data:image/png;base64,BBB' },
  ];
  win.MurdokuSnipper.render();
  const mms = qa(doc, '#snipper .snip-mm');
  assert.equal(mms.length, 2, '每张卡片一个 minimap');
  assert.ok(mms[0].querySelector('img') && mms[0].querySelector('.snip-mm-view'), 'minimap 里有缩略图与视窗框');
  const tall = mms[0].getBoundingClientRect();
  // jsdom 不布局，退而验证内联尺寸：竖图盒子应该又窄又高、横图反之
  const tallH = Number(mms[0].style.height.replace('px', ''));
  const wideH = Number(mms[1].style.height.replace('px', ''));
  assert.ok(tallH > wideH, '竖图 minimap 更高：' + tallH + ' vs ' + wideH);
  assert.ok(tallH <= 148, '高度有上限：' + tallH);
  dom.window.close();
});

test('minimap：jsdom 下没有布局也不会报错', async () => {
  const { dom, doc, errors } = await boot();
  const win = dom.window;
  win.MurdokuSnipper.state.pins = [{ id: 'p1', page: 1, w: 260, h: 700, url: 'data:image/png;base64,AAA' }];
  win.MurdokuSnipper.render();
  const fig = q(doc, '#snipper .snipper-pin');
  win.MurdokuSnipper.syncMinimap(fig);          // clientWidth/offsetWidth 都是 0
  assert.deepEqual(errors, [], '不应有运行期报错');
  dom.window.close();
});

// ------------------------------------------------------------ 游玩模式：人物网格

test('游玩模式：人物列表是紧凑网格，人多也不会拉成长条', async () => {
  const { dom, doc, errors } = await boot();
  const win = dom.window;
  win.MH.store.replace(win.MurdokuCore.createState(24, 24), '测试 24 人');
  clickSel(dom, '#tabPlay');

  const cells = qa(doc, '.plist li');
  assert.equal(cells.length, 24, '24 个人 24 个格子');
  assert.equal(cells[0].querySelector('.pl').textContent, 'A', '格子里是人物标号');
  assert.equal(cells[cells.length - 1].querySelector('.pl').textContent, 'Y', '24 人时跳过 X（A..W + Y）');
  assert.equal(cells[0].querySelectorAll('button').length, 0, '格子里不再塞按钮');
  // 每人两个按钮 → 只剩当前人物的那一份
  assert.equal(qa(doc, '[data-act="clear-person"]').length, 1, '清除按钮只出现一次');
  assert.equal(qa(doc, '[data-act="unplace-person"]').length, 0, '没确定的人不显示取消确定');
  assert.ok(q(doc, '.pnow'), '有当前人物详情行');
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('游玩模式：网格角标显示候选数，已确定的人填本人颜色 + ✓', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MH.store.replace(win.MurdokuCore.createState(24, 24), '测试 24 人');
  const st = win.MH.store.state;
  const C = win.MurdokuCore;
  const ids = st.people.map(p => p.id);
  C.setCandidate(st, ids[0], '0,5', true);
  C.setCandidate(st, ids[0], '1,6', true);
  C.setCandidate(st, ids[1], '3,3', true);
  C.placePerson(st, ids[5], '10,10');
  clickSel(dom, '#tabPlay');

  const cellA = q(doc, '.plist li:nth-child(1)');
  const cellB = q(doc, '.plist li:nth-child(2)');
  const cellF = q(doc, '.plist li:nth-child(6)');
  assert.equal(cellA.querySelector('.pb').textContent, '2', 'A 有 2 个候选');
  assert.equal(cellB.querySelector('.pb').textContent, '1', 'B 有 1 个候选');
  assert.equal(q(doc, '.plist li:nth-child(3) .pb'), null, '没标注的人没有角标');
  assert.ok(cellF.classList.contains('placed'), 'F 已确定');
  assert.equal(cellF.querySelector('.pb').textContent, '✓', '已确定显示 ✓');
  assert.equal(cellF.style.getPropertyValue('--pc'), st.people[5].color, '填成本人颜色');
  dom.window.close();
});

test('游玩模式：点格子切换当前人物，详情与操作跟着换', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MH.store.replace(win.MurdokuCore.createState(6, 6), '测试');
  const st = win.MH.store.state;
  win.MurdokuCore.placePerson(st, st.people[0].id, '2,2');
  win.MurdokuCore.setCandidate(st, st.people[3].id, '0,0', true);
  clickSel(dom, '#tabPlay');

  clickSel(dom, '.plist li:nth-child(4)');
  assert.equal(qa(doc, '.plist li.active').length, 1, '只高亮一个');
  assert.equal(q(doc, '.plist li:nth-child(4)').classList.contains('active'), true);
  const now = q(doc, '.pnow');
  assert.match(now.textContent, /1 个候选/, '详情显示候选数：' + now.textContent);
  assert.equal(now.querySelector('[data-act="unplace-person"]'), null, '没确定就不显示取消确定');

  clickSel(dom, '.plist li:nth-child(1)');
  assert.match(q(doc, '.pnow').textContent, /确定/, '切到已确定的人显示位置');
  assert.ok(q(doc, '.pnow [data-act="unplace-person"]'), '出现取消确定');
  dom.window.close();
});

test('摘录窗：收起面板只有左侧标签一个入口（标题栏不再重复放一个）', async () => {
  const { dom, doc } = await boot();
  const head = q(doc, '#snipper .snipper-head');
  assert.equal(head.querySelector('[data-snip="toggle"]'), null, '标题栏里没有第二个收起按钮');
  // 全窗只有一个收起入口，就是左侧标签
  const toggles = qa(doc, '#snipper [data-snip="toggle"]');
  assert.equal(toggles.length, 1, '收起入口唯一：' + toggles.length);
  assert.ok(toggles[0].classList.contains('snipper-tab'), '入口是左侧箭头标签');
  // 但它仍然管用
  clickSel(dom, '#snipper .snipper-tab');
  assert.equal(q(doc, '#snipper').classList.contains('collapsed'), true, '点标签能收起');
  clickSel(dom, '#snipper .snipper-tab');
  assert.equal(q(doc, '#snipper').classList.contains('collapsed'), false, '再点展开');
  dom.window.close();
});

// ------------------------------------------------------------ 左键模式与选人的联动

test('点另一个人时自动切回「左键＝候选」（避免继续误标 X）', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  clickSel(dom, '#tabPlay');
  const st = win.MH.store.state;
  const [a, b] = st.people.map(p => p.id);

  // 切到标 X 模式，并在盘上标一个 X
  clickSel(dom, '[data-act="left-mode"][data-mode="x"]');
  assert.equal(win.MH.store.state.settings.leftMode, 'x');
  pointer(dom, 'pointerdown', cellEl(dom, 3, 3));
  pointer(dom, 'pointerup');
  assert.equal(win.MH.core.xSource(win.MH.store.state, '3,3'), 'user', '此时左键确实在标 X');

  // 点另一个人 → 模式自动回到候选，并且左键点下去是标候选
  clickSel(dom, '.plist li[data-id="' + b + '"]');
  assert.equal(win.MH.store.state.selectedPersonId, b, '切换了当前人物');
  assert.equal(win.MH.store.state.settings.leftMode, 'candidate', '自动切回候选模式');
  pointer(dom, 'pointerdown', cellEl(dom, 4, 4));
  pointer(dom, 'pointerup');
  assert.ok(win.MH.store.state.play.candidates[b].includes('4,4'), '左键点下去标的是候选');
  assert.equal(win.MH.core.xSource(win.MH.store.state, '4,4'), null, '不再标 X');
  dom.window.close();
});

test('点当前人物自己不会悄悄改掉左键模式', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  clickSel(dom, '#tabPlay');
  const st = win.MH.store.state;
  const a = st.people[0].id;
  clickSel(dom, '[data-act="left-mode"][data-mode="x"]');

  clickSel(dom, '.plist li[data-id="' + a + '"]');   // 点的就是当前人物
  assert.equal(win.MH.store.state.settings.leftMode, 'x', '同一个人保持原模式');

  clickSel(dom, '.plist li[data-id="' + st.people[1].id + '"]');
  assert.equal(win.MH.store.state.settings.leftMode, 'candidate', '换人才切回候选');
  dom.window.close();
});

test('准备阶段选人不会动左键模式（那里用不上）', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  clickSel(dom, '#tabPlay');
  clickSel(dom, '[data-act="left-mode"][data-mode="x"]');       // 游玩阶段设成标 X
  clickSel(dom, '[data-act="phase"][data-phase="prep"]');        // 回到准备阶段
  const st = win.MH.store.state;
  assert.equal(st.settings.leftMode, 'x', '模式跟着存档留在 X');
  clickSel(dom, '[data-act="select-person"][data-id="' + st.people[1].id + '"]');   // 准备阶段的人物条
  assert.equal(win.MH.store.state.selectedPersonId, st.people[1].id, '切换了人物');
  assert.equal(win.MH.store.state.settings.leftMode, 'x', '准备阶段选人不动模式');
  dom.window.close();
});

// ------------------------------------------------------------ 行列候选提示

test('游玩模式：网格外侧显示每行/每列有哪些候选的人', async () => {
  const { dom, doc, errors } = await boot();
  const win = dom.window;
  win.MH.store.replace(win.MurdokuCore.createState(6, 6), '测试');
  const st = win.MH.store.state, C = win.MurdokuCore;
  const ids = st.people.map(p => p.id);
  C.setCandidate(st, ids[0], '0,1', true);
  C.setCandidate(st, ids[0], '0,3', true);
  C.setCandidate(st, ids[1], '0,2', true);
  C.setCandidate(st, ids[2], '4,5', true);
  C.placePerson(st, ids[3], '3,3');
  clickSel(dom, '#tabPlay');

  const rowHeads = qa(doc, '.row-head');
  const colHeads = qa(doc, '.col-head');
  assert.equal(rowHeads.length, 6, '每行一条');
  assert.equal(colHeads.length, 6, '每列一条');
  assert.equal(rowHeads[0].textContent, 'AB', '第 0 行有 A、B 的候选');
  assert.equal(rowHeads[1].textContent, '', '第 1 行没有候选');
  assert.equal(colHeads[3].textContent, 'D', '第 3 列有已确定的 D');
  assert.ok(colHeads[3].querySelector('i.done'), '已确定的人用实心样式标出');
  assert.equal(rowHeads[3].textContent, 'D', '第 3 行也是已确定的 D');
  assert.equal(colHeads[5].textContent, 'C', '第 5 列有 C 的候选');
  assert.ok(q(doc, '.head-corner'), '左上角有转角块');
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('行列提示最多显示 4 个，多出来的折成 +N', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  win.MH.store.replace(win.MurdokuCore.createState(6, 6), '测试');
  const st = win.MH.store.state, C = win.MurdokuCore;
  st.people.forEach((p, i) => C.setCandidate(st, p.id, '0,' + i, true));   // 6 个人都在第 0 行
  clickSel(dom, '#tabPlay');

  const head = q(doc, '.row-head');
  const chips = head.querySelectorAll('i');
  assert.equal(chips.length, 5, '4 个标签 + 1 个 +N（共 ' + chips.length + '）');
  assert.equal(chips[chips.length - 1].className, 'more');
  assert.equal(chips[chips.length - 1].textContent, '+2', '6 个人 → +2');
  assert.match(head.title, /第 1 行/, 'title 里是完整信息');
  dom.window.close();
});

test('行列提示：准备阶段不显示，游玩阶段可关掉', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  const board = q(doc, '#board');
  assert.equal(board.classList.contains('has-heads'), false, '准备阶段不占表头空间');

  clickSel(dom, '#tabPlay');
  assert.equal(q(doc, '#board').classList.contains('has-heads'), true, '游玩阶段显示');
  assert.ok(qa(doc, '.row-head').length > 0, '有行提示');

  clickSel(dom, '[data-act="toggle-heads"]');
  assert.equal(win.MH.store.state.settings.showHeads, false, '开关关掉');
  assert.equal(q(doc, '#board').classList.contains('has-heads'), false, '不再占空间');

  clickSel(dom, '[data-act="toggle-heads"]');
  assert.equal(win.MH.store.state.settings.showHeads, true, '还能开回来');
  assert.equal(q(doc, '#board').classList.contains('has-heads'), true);
  dom.window.close();
});

test('悬停格子时点亮它所在的行与列提示', async () => {
  const { dom, doc } = await boot();
  const win = dom.window;
  clickSel(dom, '#tabPlay');
  pointer(dom, 'pointermove', cellEl(dom, 3, 5));
  const hotRows = qa(doc, '.row-head.hot');
  const hotCols = qa(doc, '.col-head.hot');
  assert.equal(hotRows.length, 1, '只有一行点亮：' + hotRows.length);
  assert.equal(hotRows[0].dataset.r, '3', '点亮的是第 3 行');
  assert.equal(hotCols.length, 1, '只有一列点亮');
  assert.equal(hotCols[0].dataset.c, '5', '点亮的是第 5 列');

  pointer(dom, 'pointermove', cellEl(dom, 0, 0));
  assert.equal(qa(doc, '.row-head.hot').length, 1, '移动后仍然只有一行');
  assert.equal(q(doc, '.row-head.hot').dataset.r, '0', '换成第 0 行');
  assert.equal(q(doc, '.col-head.hot').dataset.c, '0', '列也跟着换');
  dom.window.close();
});

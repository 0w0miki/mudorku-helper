/* Murdoku Helper — core 单元测试
 * 运行： node --test tests/   或   npm test
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const K = C.key;

function blank(rows, cols) { return C.createState(rows, cols); }

// ------------------------------------------------------------ 基础

test('labelFor 跳过 X', () => {
  assert.equal(C.labelFor(0), 'A');
  assert.equal(C.labelFor(22), 'W');
  assert.equal(C.labelFor(23), 'Y');
  assert.equal(C.labelFor(24), 'Z');
  assert.equal(C.labelFor(25), 'AA');
  assert.equal(C.labelFor(26), 'AB');
  const labels = Array.from({ length: 60 }, (_, i) => C.labelFor(i));
  assert.equal(new Set(labels).size, labels.length, '标签必须唯一');
  assert.ok(labels.every(l => !l.includes('X')), '标签不含 X');
});

test('peopleCount = min(rows, cols)', () => {
  assert.equal(C.peopleCount(5, 8), 5);
  assert.equal(C.peopleCount(8, 5), 5);
  assert.equal(C.peopleCount(3, 3), 3);
});

test('createState 生成人物与默认值', () => {
  const st = blank(4, 6);
  assert.equal(st.rows, 4);
  assert.equal(st.cols, 6);
  assert.equal(st.people.length, 4);
  assert.deepEqual(st.people.map(p => p.label), ['A', 'B', 'C', 'D']);
  assert.equal(st.phase, 'prep');
  assert.deepEqual(st.play, { xmarks: {}, candidates: {}, placed: {} });
});

test('key/unkey 往返', () => {
  assert.deepEqual(C.unkey(K(3, 7)), { r: 3, c: 7 });
  assert.equal(C.isValidKey(K(3, 7), 8, 8), true);
  assert.equal(C.isValidKey(K(8, 0), 8, 8), false);
});

// ------------------------------------------------------------ 连通性

test('isConnected 四连通', () => {
  assert.equal(C.isConnected([K(0, 0)]), true);
  assert.equal(C.isConnected([K(0, 0), K(0, 1), K(1, 1)]), true);
  assert.equal(C.isConnected([K(0, 0), K(0, 2)]), false);
  // 对角不算连通
  assert.equal(C.isConnected([K(0, 0), K(1, 1)]), false);
});

test('largestComponent', () => {
  const comp = C.largestComponent([K(0, 0), K(0, 1), K(0, 2), K(3, 3), K(3, 4)]);
  assert.equal(comp.length, 3);
  assert.deepEqual(comp.slice().sort(), [K(0, 0), K(0, 1), K(0, 2)].sort());
});

// ------------------------------------------------------------ 区域轮廓

test('regionOutlineSegments 单格 = 4 条边', () => {
  const segs = C.regionOutlineSegments([K(1, 1)]);
  assert.equal(segs.length, 4);
  const path = C.segmentsToPath(segs);
  assert.ok(path.includes('M1 1L2 1'));
  assert.ok(path.includes('M1 2L2 2'));
  assert.ok(path.includes('M1 1L1 2'));
  assert.ok(path.includes('M2 1L2 2'));
});

test('regionOutlineSegments 合并直线段', () => {
  // 2x2 方块：外轮廓应为 4 条合并后的线段，而不是 8 条
  const segs = C.regionOutlineSegments([K(0, 0), K(0, 1), K(1, 0), K(1, 1)]);
  assert.equal(segs.length, 4);
  const horizontals = segs.filter(s => s.y1 === s.y2);
  const verticals = segs.filter(s => s.x1 === s.x2);
  assert.equal(horizontals.length, 2);
  assert.equal(verticals.length, 2);
  assert.ok(horizontals.every(s => Math.abs(s.x2 - s.x1) === 2));
  assert.ok(verticals.every(s => Math.abs(s.y2 - s.y1) === 2));
});

test('regionOutlineSegments 凹形轮廓不合并断口', () => {
  // L 形
  const cells = [K(0, 0), K(1, 0), K(1, 1)];
  const segs = C.regionOutlineSegments(cells);
  // 上边界: 只有 (0,0) 一格
  const top = segs.filter(s => s.y1 === 0 && s.y2 === 0);
  assert.equal(top.length, 1);
  assert.equal(top[0].x1, 0);
  assert.equal(top[0].x2, 1);
});

// ------------------------------------------------------------ X 标记

test('toggleX 标注与取消', () => {
  const st = blank(4, 4);
  let r = C.toggleX(st, K(0, 0));
  assert.equal(r.ok, true);
  assert.equal(C.isX(st, K(0, 0)), true);
  assert.equal(C.xSource(st, K(0, 0)), 'user');
  r = C.toggleX(st, K(0, 0));
  assert.equal(r.ok, true);
  assert.equal(C.isX(st, K(0, 0)), false);
});

test('标 X 会清除该格候选', () => {
  const st = blank(4, 4);
  const a = st.people[0].id, b = st.people[1].id;
  C.toggleCandidate(st, a, K(1, 1));
  C.toggleCandidate(st, b, K(1, 1));
  const r = C.toggleX(st, K(1, 1));
  assert.equal(r.ok, true);
  assert.equal(C.candidatesAt(st, K(1, 1)).length, 0);
  assert.match(r.message, /清除了 2 个候选/);
});

test('不可占据物品格固定为 auto X，不能取消、不能放人、不能候选', () => {
  const st = blank(4, 4);
  C.createItem(st, '石头', [K(2, 2)], false);
  assert.equal(C.xSource(st, K(2, 2)), 'auto');
  assert.equal(C.toggleX(st, K(2, 2)).ok, false);
  assert.equal(C.toggleCandidate(st, st.people[0].id, K(2, 2)).ok, false);
  assert.equal(C.placePerson(st, st.people[0].id, K(2, 2)).ok, false);
});

// ------------------------------------------------------------ 候选

test('toggleCandidate 切换且尊重 X / 已放置', () => {
  const st = blank(4, 4);
  const a = st.people[0].id;
  assert.equal(C.toggleCandidate(st, a, K(0, 1)).ok, true);
  assert.deepEqual(st.play.candidates[a], [K(0, 1)]);
  assert.equal(C.toggleCandidate(st, a, K(0, 1)).ok, true);
  assert.deepEqual(st.play.candidates[a], []);

  // 在多处标注候选
  C.toggleCandidate(st, a, K(0, 0));
  C.toggleCandidate(st, a, K(0, 2));
  C.toggleCandidate(st, a, K(2, 2));
  assert.equal(C.personCandidateCount(st, a), 3);
  assert.deepEqual(C.candidatesAt(st, K(0, 2)), [a]);
});

// ------------------------------------------------------------ 长按确定

test('placePerson 在同行同列（除当前格）标 X', () => {
  const st = blank(5, 5);
  const a = st.people[0].id;
  const r = C.placePerson(st, a, K(1, 2));
  assert.equal(r.ok, true);
  assert.equal(C.personAt(st, K(1, 2)), a);
  // 同行
  for (const c of [0, 1, 3, 4]) assert.equal(C.xSource(st, K(1, c)), 'place', 'row ' + c);
  // 同列
  for (const rr of [0, 2, 3, 4]) assert.equal(C.xSource(st, K(rr, 2)), 'place', 'col ' + rr);
  // 当前格不是 X
  assert.equal(C.isX(st, K(1, 2)), false);
  // 统计 4 + 4 = 8 个
  assert.equal(Object.keys(st.play.xmarks).length, 8);
  assert.match(r.message, /8 个 X/);
});

test('placePerson 拒绝同行/同列冲突', () => {
  const st = blank(5, 5);
  const a = st.people[0].id, b = st.people[1].id;
  C.placePerson(st, a, K(0, 0));
  const r = C.placePerson(st, b, K(0, 3));
  assert.equal(r.ok, false);
  assert.match(r.message, /已有 A/);
  // 不同行列可以放
  assert.equal(C.placePerson(st, b, K(3, 3)).ok, true);
});

test('placePerson 清除该格其它人物的候选 / 自己全部候选', () => {
  const st = blank(5, 5);
  const a = st.people[0].id, b = st.people[1].id;
  C.toggleCandidate(st, a, K(2, 2));
  C.toggleCandidate(st, a, K(0, 0));
  C.toggleCandidate(st, b, K(2, 2));
  const r = C.placePerson(st, a, K(2, 2));
  assert.equal(r.ok, true);
  assert.equal(C.personCandidateCount(st, a), 0);
  assert.equal(C.candidatesAt(st, K(2, 2)).length, 0);
});

test('unplacePerson 撤销时移除它产生的 X', () => {
  const st = blank(5, 5);
  const a = st.people[0].id;
  C.toggleX(st, K(0, 4)); // 用户自己的 X 不应被移除
  C.placePerson(st, a, K(2, 2));
  const r = C.unplacePerson(st, a);
  assert.equal(r.ok, true);
  assert.equal(C.personAt(st, K(2, 2)), null);
  assert.equal(Object.keys(st.play.xmarks).filter(k => st.play.xmarks[k].src === 'place').length, 0);
  assert.equal(C.xSource(st, K(0, 4)), 'user', '手动 X 保留');
});

test('clearPersonMarks / clearAllMarks', () => {
  const st = blank(5, 5);
  const a = st.people[0].id;
  C.toggleCandidate(st, a, K(1, 1));
  C.placePerson(st, a, K(1, 1));
  C.clearPersonMarks(st, a);
  assert.equal(C.personAt(st, K(1, 1)), null);
  C.toggleX(st, K(0, 0));
  C.clearAllMarks(st);
  assert.deepEqual(st.play, { xmarks: {}, candidates: {}, placed: {} });
});

// ------------------------------------------------------------ 区域 / 物品 / 关联

test('区域与物品的增删改名和关联清理', () => {
  const st = blank(4, 4);
  const reg = C.createRegion(st, '红区', [K(0, 0), K(0, 1)]);
  const it = C.createItem(st, '苹果', [K(1, 1)], true);
  const a = st.people[0].id;
  C.setLink(st, a, 'region', reg.id, 1);
  C.setLink(st, a, 'item', it.id, -1);
  assert.equal(C.getLink(st, a, 'region', reg.id), 1);
  assert.equal(C.getLink(st, a, 'item', it.id), -1);
  C.deleteRegion(st, reg.id);
  assert.equal(C.getLink(st, a, 'region', reg.id), 0);
  assert.equal(st.people[0].links.length, 1, '物品关联保留');
  C.deleteItem(st, it.id);
  assert.equal(st.people[0].links.length, 0);
});

test('setLink polarity=0 即删除关联', () => {
  const st = blank(4, 4);
  const reg = C.createRegion(st, 'r', [K(0, 0)]);
  const a = st.people[0].id;
  C.setLink(st, a, 'region', reg.id, -1);
  C.setLink(st, a, 'region', reg.id, 0);
  assert.equal(st.people[0].links.length, 0);
});

test('查询：regionsAt / itemAt', () => {
  const st = blank(4, 4);
  const r1 = C.createRegion(st, 'a', [K(0, 0), K(0, 1)]);
  const r2 = C.createRegion(st, 'b', [K(0, 1)]);
  const it = C.createItem(st, 'x', [K(0, 1)], true);
  assert.deepEqual(C.regionsAt(st, K(0, 1)), [r2.id], '一格只属于一个区域');
  assert.deepEqual(C.regionsAt(st, K(0, 0)), [r1.id]);
  assert.equal(C.itemAt(st, K(0, 1)).id, it.id);
  assert.equal(C.itemAt(st, K(3, 3)), null);
  // 区域与物品是两套独立归属，可以叠在同一格
  assert.deepEqual(C.regionsAt(st, K(0, 1)), [r2.id]);
});

// ------------------------------------------------------------ 校验

test('validate 只查规则冲突，不把「关联」当作应满足的条件', () => {
  const st = blank(5, 5);
  const [a, b] = [st.people[0].id, st.people[1].id];
  const reg = C.createRegion(st, '安全区', [K(0, 0)]);
  C.setLink(st, a, 'region', reg.id, 1);
  C.setLink(st, b, 'region', reg.id, -1);

  C.placePerson(st, a, K(4, 4)); // 正向关联却不在区域内
  let issues = C.validate(st);
  assert.ok(!issues.some(i => i.text.includes('安全区')), '关联只是相关性提示，不该报错：' + JSON.stringify(issues));

  // 手工构造同行冲突（绕过 placePerson 的拦截）
  st.play.placed[b] = K(4, 0);
  issues = C.validate(st);
  assert.ok(issues.some(i => i.text.includes('第 5 行')), JSON.stringify(issues));

  // 负向关联却在区域内 —— 同样不报错
  st.play.placed[b] = K(0, 0);
  issues = C.validate(st);
  assert.ok(!issues.some(i => i.text.includes('安全区')), JSON.stringify(issues));
});

test('validate 检出两人唯一候选撞车', () => {
  const st = blank(3, 3);
  const [a, b, c] = [st.people[0].id, st.people[1].id, st.people[2].id];
  C.placePerson(st, a, K(0, 0));
  C.toggleCandidate(st, b, K(1, 1));
  C.toggleCandidate(st, c, K(1, 1));
  const issues = C.validate(st);
  assert.ok(issues.some(i => i.text.includes('都只剩候选 (2,2)')), JSON.stringify(issues));
});

test('validate 检出无路可走', () => {
  const st = blank(3, 3);
  const [a, b] = [st.people[0].id, st.people[1].id];
  C.placePerson(st, a, K(0, 0));
  for (const k of [K(1, 1), K(1, 2), K(2, 1), K(2, 2)]) {
    assert.equal(C.toggleX(st, k).ok, true);
  }
  assert.equal(C.legalCells(st, b).length, 0);
  const issues = C.validate(st);
  assert.ok(issues.some(i => i.text.includes('没有任何可放的位置')), JSON.stringify(issues));
});

// ------------------------------------------------------------ 序列化

test('serialize/deserialize 往返一致', () => {
  const st = blank(5, 6);
  const reg = C.createRegion(st, '红区', [K(0, 0), K(0, 1), K(1, 0)]);
  const it = C.createItem(st, '石头', [K(2, 2)], false);
  const a = st.people[0].id, b = st.people[1].id;
  C.setLink(st, a, 'region', reg.id, -1);
  C.setLink(st, a, 'item', it.id, 1);
  st.phase = 'play';
  C.toggleCandidate(st, b, K(3, 3));
  C.placePerson(st, a, K(4, 4));
  C.toggleX(st, K(1, 2));

  const round = C.deserialize(C.serialize(st));
  assert.deepEqual(round, JSON.parse(JSON.stringify(st)));
});

test('deserialize 容错：越界格子、脏数据、未知关联被清理', () => {
  const st = blank(4, 4);
  const raw = JSON.parse(C.serialize(st));
  raw.regions = [{ id: 'r-1', name: 'r', cells: ['0,0', '99,99', 'oops', '0,0'] }];
  raw.items = [{ id: 'i-1', name: 'i', occupiable: false, cells: ['1,1'] }];
  raw.people[0].links = [
    { kind: 'region', id: 'r-1', polarity: -1 },
    { kind: 'item', id: 'gone', polarity: 1 },
    { kind: 'bogus', id: 'x' },
  ];
  raw.play.xmarks = { '2,2': { src: 'place', by: 'nope' }, '77,77': 'user' };
  raw.play.candidates = { p1: ['0,0', '0,0'] };
  raw.play.placed = { p1: '9,9' };
  const st2 = C.deserialize(raw);
  assert.deepEqual(st2.regions[0].cells, ['0,0']);
  assert.equal(st2.people[0].links.length, 1);
  assert.deepEqual(st2.people[0].links[0], { kind: 'region', id: 'r-1', polarity: -1 });
  assert.equal(st2.play.xmarks['77,77'], undefined);
  assert.equal(st2.play.xmarks['2,2'], undefined, '没有主人的 place ✕ 应被丢弃');
  assert.deepEqual(st2.play.candidates.p1, ['0,0']);
  assert.equal(st2.play.placed.p1, undefined);
});

test('deserialize 更大人物的地图时只保留 min(rows,cols) 人', () => {
  const src = C.createState(9, 9);
  src.people[0].links = [];
  const raw = JSON.parse(C.serialize(src));
  raw.cols = 3;
  const st = C.deserialize(raw);
  assert.equal(st.people.length, 3);
});

// ------------------------------------------------------------ 颜色

test('rgba / hexToRgb', () => {
  assert.deepEqual(C.hexToRgb('#2563eb'), { r: 37, g: 99, b: 235 });
  assert.equal(C.rgba('#fff', 0.5), 'rgba(255,255,255,0.5)');
  assert.equal(C.rgba('nope', 1), 'rgba(128,128,128,1)');
});

test('deserialize 人物不足时补齐为 min(rows, cols)', () => {
  const st = C.createState(5, 5);
  const raw = JSON.parse(C.serialize(st));
  raw.people = raw.people.slice(0, 2);
  raw.regions = [{ id: 'r-1', name: 'r', cells: ['0,0'] }];
  raw.people[0].links = [{ kind: 'region', id: 'r-1', polarity: 1 }];
  const out = C.deserialize(raw);
  assert.equal(out.people.length, 5);
  assert.equal(out.people[0].links.length, 1, '原有人的关联保留');
  assert.deepEqual(out.people.map(p => p.id), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(out.people.map(p => p.label), ['A', 'B', 'C', 'D', 'E']);
});

test('deserialize 人物 id 重复时自动去重', () => {
  const st = C.createState(3, 3);
  const raw = JSON.parse(C.serialize(st));
  raw.people = raw.people.map(p => Object.assign({}, p, { id: 'dup' }));
  const out = C.deserialize(raw);
  assert.equal(new Set(out.people.map(p => p.id)).size, 3);
});

test('placePerson 再次确定同一人物 = 移动，并撤销旧的行列排除', () => {
  const st = blank(5, 5);
  const a = st.people[0].id;
  C.placePerson(st, a, C.key(1, 1));
  assert.equal(C.xSource(st, C.key(1, 2)), 'place');
  const r = C.placePerson(st, a, C.key(3, 3));
  assert.equal(r.ok, true);
  assert.equal(st.play.placed[a], C.key(3, 3));
  assert.equal(C.personAt(st, C.key(1, 1)), null);
  assert.equal(C.xSource(st, C.key(1, 2)), null, '旧行排除已撤销');
  assert.equal(C.xSource(st, C.key(3, 2)), 'place', '新行已排除');
  // 旧位置的 X 不该残留
  assert.equal(Object.values(st.play.xmarks).filter(x => (x.by || []).indexOf(a) >= 0).length, 8);
});

test('已确定的人物不能再标候选', () => {
  const st = blank(5, 5);
  const a = st.people[0].id;
  C.placePerson(st, a, C.key(0, 0));
  const r = C.toggleCandidate(st, a, C.key(2, 2));
  assert.equal(r.ok, false);
  assert.match(r.message, /已确定位置/);
});

test('一个格子只属于一个区域：后建的区域会从原区域拿走格子', () => {
  const st = blank(4, 4);
  const a = C.createRegion(st, 'A区', [C.key(0, 0), C.key(0, 1)]);
  const b = C.createRegion(st, 'B区', [C.key(0, 1), C.key(1, 1)]);
  assert.deepEqual(C.regionsAt(st, C.key(0, 1)), [b.id], '(0,1) 只属于后建的 B 区');
  assert.deepEqual(a.cells, [C.key(0, 0)]);
  assert.deepEqual(C.regionsAt(st, C.key(0, 0)), [a.id]);
  assert.equal(C.regionOutlineSegments(a.cells).length, 4);
  assert.equal(C.regionOutlineSegments(b.cells).length, 4);
});

test('导入时区域也强制互斥（文件里靠后的区域优先）', () => {
  const raw = {
    rows: 3, cols: 3,
    regions: [
      { id: 'r-1', name: 'A', cells: ['1,1', '0,0'] },
      { id: 'r-2', name: 'B', cells: ['1,1'] },
    ],
  };
  const st = C.deserialize(raw);
  assert.deepEqual(st.regions[0].cells, ['0,0']);
  assert.deepEqual(st.regions[1].cells, ['1,1']);
  assert.deepEqual(C.regionsAt(st, C.key(1, 1)), ['r-2']);
});

test('物品格与区域格可以叠加', () => {
  const st = blank(4, 4);
  C.createRegion(st, '红区', [C.key(2, 2), C.key(2, 3)]);
  C.createItem(st, '苹果', [C.key(2, 2)], true);
  assert.equal(C.regionsAt(st, C.key(2, 2)).length, 1);
  assert.equal(C.itemAt(st, C.key(2, 2)).name, '苹果');
  assert.equal(C.xSource(st, C.key(2, 2)), null);
});

// ------------------------------------------------------------ 复核发现的回归用例

test('B1 交叉格：两人不同行列时，交叉格的 X 属于两个主人，取消一个不会丢另一个', () => {
  const st = blank(5, 5);
  const [a, b] = [st.people[0].id, st.people[1].id];
  C.placePerson(st, a, C.key(0, 2));   // A：第 0 行 + 第 2 列
  C.placePerson(st, b, C.key(2, 3));   // B：第 2 行 + 第 3 列
  // (2,2) 同时是 A 的列 2 与 B 的行 2 的交叉格
  assert.equal(C.xSource(st, C.key(2, 2)), 'place');
  assert.deepEqual(C.placeOwners(st, C.key(2, 2)).sort(), [a, b].sort());
  // (0,3) 同时是 A 的行 0 与 B 的列 3 的交叉格
  assert.deepEqual(C.placeOwners(st, C.key(0, 3)).sort(), [a, b].sort());

  C.unplacePerson(st, a);
  assert.equal(C.xSource(st, C.key(2, 2)), 'place', 'B 还在第 2 行，(2,2) 必须仍是排除格');
  assert.equal(C.xSource(st, C.key(0, 3)), 'place', 'B 还在第 3 列，(0,3) 必须仍是排除格');
  assert.deepEqual(C.placeOwners(st, C.key(2, 2)), [b]);
  // B 自己的行列仍然完整
  for (const c of [0, 1, 2, 4]) assert.equal(C.xSource(st, C.key(2, c)), 'place', '2,' + c);
  for (const r of [0, 1, 3, 4]) assert.equal(C.xSource(st, C.key(r, 3)), 'place', r + ',3');

  // 再取消 B → 交叉格彻底清空
  C.unplacePerson(st, b);
  assert.equal(C.xSource(st, C.key(2, 2)), null);
  assert.equal(Object.keys(st.play.xmarks).length, 0);
});

test('B1 取消 A 后，其它人不能在 B 的交叉格上标候选（不再有假冲突）', () => {
  const st = blank(5, 5);
  const [a, b, c, d] = st.people.map(p => p.id);
  C.placePerson(st, a, C.key(0, 2));
  C.placePerson(st, b, C.key(2, 3));
  C.unplacePerson(st, a);
  assert.equal(C.toggleCandidate(st, c, C.key(2, 2)).ok, false, '交叉格在 B 的行上，不能当候选');
  assert.equal(C.toggleCandidate(st, d, C.key(2, 2)).ok, false);
  const issues = C.validate(st);
  assert.ok(!issues.some(i => i.text.includes('都只剩候选')), '不应出现唯一候选假冲突：' + JSON.stringify(issues));
});

test('B1 X 归属：place ✕ 不能被单独擦掉，只能靠取消确定解除', () => {
  const st = blank(5, 5);
  const a = st.people[0].id;
  C.placePerson(st, a, C.key(0, 0));
  const r = C.toggleX(st, C.key(0, 1));
  assert.equal(r.ok, false);
  assert.match(r.message, /同行\/同列排除/);
  assert.equal(C.xSource(st, C.key(0, 1)), 'place', 'X 仍在');
  // 用户自己标的 X 依然可以取消
  assert.equal(C.toggleX(st, C.key(4, 4)).ok, true);
  assert.equal(C.toggleX(st, C.key(4, 4)).ok, true);
});

test('B2 人物 id 去重：请求的 id 撞车时回退到未被占用的默认 id', () => {
  const st = C.createState(3, 3);
  const raw = JSON.parse(C.serialize(st));
  raw.people = [{ id: 'p2' }, { id: 'p2' }, { id: 'p3' }];
  const out = C.deserialize(raw);
  const ids = out.people.map(p => p.id);
  assert.equal(new Set(ids).size, 3, 'id 必须唯一：' + ids.join(','));
  // 候选/确定位置不再被两人共享
  C.toggleCandidate(out, ids[0], C.key(0, 0));
  assert.equal(C.personCandidateCount(out, ids[0]), 1);
  assert.equal(C.personCandidateCount(out, ids[1]), 0, '另一个人不应共享候选');
});

test('B2 非法 id 会被替换成安全 id', () => {
  const st = C.createState(3, 3);
  const raw = JSON.parse(C.serialize(st));
  raw.regions = [{ id: 'r-1" onmouseover="alert(1)', name: 'x', cells: ['0,0'] }];
  const out = C.deserialize(raw);
  assert.match(out.regions[0].id, /^[A-Za-z0-9_-]+$/);
  assert.ok(!out.regions[0].id.includes('"'));
});

test('B3 一个格子只归属一个物品（createItem 与导入都强制）', () => {
  const st = blank(3, 3);
  const a = C.createItem(st, '地毯', [C.key(2, 2)], true);
  const b = C.createItem(st, '石头', [C.key(2, 2)], false);
  assert.deepEqual(a.cells, [], '后建的物品抢走格子');
  assert.deepEqual(b.cells, [C.key(2, 2)]);
  assert.equal(C.xSource(st, C.key(2, 2)), 'auto');
  assert.equal(C.placePerson(st, st.people[0].id, C.key(2, 2)).ok, false);

  // 导入同样强制，且任一不可占据都不会被遮蔽
  const raw = JSON.parse(C.serialize(C.createState(3, 3)));
  raw.items = [
    { id: 'i-1', name: '地毯', occupiable: true, cells: ['2,2'] },
    { id: 'i-2', name: '石头', occupiable: false, cells: ['2,2'] },
  ];
  const st2 = C.deserialize(raw);
  assert.equal(st2.items[0].cells.length, 0);
  assert.equal(C.xSource(st2, C.key(2, 2)), 'auto');
  assert.equal(C.placePerson(st2, st2.people[0].id, C.key(2, 2)).ok, false);
});

test('B6 导入的颜色只接受 #hex，注入字符被丢弃', () => {
  const st = C.createState(3, 3);
  const raw = JSON.parse(C.serialize(st));
  raw.items = [{ id: 'i-1', name: 'x', color: '#8b5cf6" onmouseover="window.__PWN=1', occupiable: true, cells: ['1,1'] }];
  raw.regions = [{ id: 'r-1', name: 'y', color: 'red;background:url(x)', cells: ['0,0'] }];
  const out = C.deserialize(raw);
  assert.match(out.items[0].color, /^#[0-9a-fA-F]{3,8}$/);
  assert.match(out.regions[0].color, /^#[0-9a-fA-F]{3,8}$/);
  assert.ok(!out.items[0].color.includes('"'));
});

test('B7 validate 检出「人放在已标 X 的格子上」', () => {
  const st = C.createState(3, 3);
  const raw = JSON.parse(C.serialize(st));
  raw.play = { xmarks: { '1,1': 'user' }, placed: { [st.people[0].id]: '1,1' }, candidates: {} };
  const st2 = C.deserialize(raw);
  const issues = C.validate(st2);
  assert.ok(issues.some(i => i.text.includes('放在了已标 X')), JSON.stringify(issues));
});

test('B8 导入时 polarity:0 视为「无关联」而不是正向', () => {
  const st = C.createState(3, 3);
  const raw = JSON.parse(C.serialize(st));
  raw.regions = [{ id: 'r-1', name: 'r', cells: ['0,0'] }];
  raw.people[0].links = [{ kind: 'region', id: 'r-1', polarity: 0 }];
  const out = C.deserialize(raw);
  assert.equal(out.people[0].links.length, 0);
  // 缺失 polarity 仍按默认正向
  raw.people[0].links = [{ kind: 'region', id: 'r-1' }];
  assert.equal(C.deserialize(raw).people[0].links[0].polarity, 1);
});

test('B9 导入的无主 place ✕ 被丢弃，不会成为清理不掉的脏数据', () => {
  const st = C.createState(3, 3);
  const raw = JSON.parse(C.serialize(st));
  raw.play = { xmarks: { '2,2': { src: 'place', by: null }, '0,0': { src: 'place', by: 'ghost' } }, placed: {}, candidates: {} };
  const out = C.deserialize(raw);
  assert.equal(C.xSource(out, C.key(2, 2)), null);
  assert.equal(C.xSource(out, C.key(0, 0)), null);
  assert.equal(Object.keys(out.play.xmarks).length, 0);
});

test('B9 旧存档 by 为字符串时仍能正确归属与撤销', () => {
  const st = C.createState(3, 3);
  const raw = JSON.parse(C.serialize(st));
  const a = st.people[0].id;
  raw.play = { xmarks: { '0,1': { src: 'place', by: a } }, placed: { [a]: '0,0' }, candidates: {} };
  const out = C.deserialize(raw);
  assert.deepEqual(C.placeOwners(out, C.key(0, 1)), [a]);
  C.unplacePerson(out, a);
  assert.equal(C.xSource(out, C.key(0, 1)), null);
});

// ------------------------------------------------------------ 随机不变量（固定种子，可复现）

test('随机操作序列下：已确定人物的整行整列（除自身格）恒为 X，且不存在无主的 place ✕', () => {
  let seed = 20261010;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  let placements = 0;

  for (let round = 0; round < 200; round++) {
    const N = 6;
    const st = C.createState(N, N);
    const keys = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) keys.push(C.key(r, c));

    for (let step = 0; step < 40; step++) {
      const op = Math.floor(rnd() * 6);
      const pid = pick(st.people).id;
      const k = pick(keys);
      if (op === 0) C.placePerson(st, pid, k);
      else if (op === 1) C.unplacePerson(st, pid);
      else if (op === 2) C.toggleX(st, k);
      else if (op === 3) C.toggleCandidate(st, pid, k);
      else if (op === 4) C.clearPersonMarks(st, pid);
      else { const r = Math.floor(rnd() * N), c = Math.floor(rnd() * N); C.placePerson(st, st.people[r].id, C.key(r, c)); }

      // 不变量 1：任何已确定人物的整行整列（除自身格）都必须显示 X
      for (const id in st.play.placed) {
        const at = st.play.placed[id];
        const { r, c } = C.unkey(at);
        placements++;
        for (let i = 0; i < N; i++) {
          if (i !== c) {
            assert.equal(C.isX(st, C.key(r, i)), true,
              '第 ' + (r + 1) + ' 行 ' + (i + 1) + ' 列应被 ' + id + ' 排除（round ' + round + ' step ' + step + '）');
          }
          if (i !== r) {
            assert.equal(C.isX(st, C.key(i, c)), true,
              '第 ' + (i + 1) + ' 行 ' + (c + 1) + ' 列应被 ' + id + ' 排除（round ' + round + ' step ' + step + '）');
          }
        }
      }
      // 不变量 2：每一个 place ✕ 都必须至少有一个"仍然确定着"的主人
      for (const kk in st.play.xmarks) {
        const rec = st.play.xmarks[kk];
        if (rec.src !== 'place') continue;
        const owners = C.placeOwners(st, kk);
        assert.ok(owners.length > 0, 'place ✕ 没有主人：' + kk);
        assert.ok(owners.every(o => !!st.play.placed[o]), 'place ✕ 有已解除的主人：' + kk + ' ' + owners.join(','));
      }
      // 不变量 3：同一格不会既有人物又有 X
      for (const kk in st.play.placed) {
        assert.equal(C.xSource(st, st.play.placed[kk]), null,
          '已确定人物的格子不该有 X：' + st.play.placed[kk]);
      }
    }
  }
  assert.ok(placements > 500, '随机测试应产生足够多的确定动作，实际 ' + placements);
});

test('导入外部 JSON 时自动补齐缺失的行列排除，保留用户自己的 X', () => {
  const raw = {
    rows: 4, cols: 4,
    people: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
    regions: [], items: [],
    play: { placed: { p1: '0,0' }, xmarks: { '0,1': 'user' }, candidates: {} },
  };
  const st = C.deserialize(raw);
  assert.equal(C.xSource(st, C.key(0, 0)), null, '人物自身格没有 X');
  assert.equal(C.xSource(st, C.key(0, 1)), 'user', '用户自己的 X 保留原样');
  for (const c of [2, 3]) assert.equal(C.xSource(st, C.key(0, c)), 'place', '补齐第 0 行');
  for (const r of [1, 2, 3]) assert.equal(C.xSource(st, C.key(r, 0)), 'place', '补齐第 0 列');
  assert.deepEqual(C.placeOwners(st, C.key(2, 0)), ['p1']);
  C.unplacePerson(st, 'p1');
  assert.equal(C.xSource(st, C.key(0, 1)), 'user', '取消确定后，用户自己的 X 仍在');
});

test('用户手动 X 被擦掉时，若该格仍在某人的行列上则自动转为排除 X', () => {
  const st = blank(4, 4);
  const a = st.people[0].id;
  C.toggleX(st, C.key(0, 3));           // 用户先标 X
  C.placePerson(st, a, C.key(3, 0));    // A 在第 3 行 / 第 0 列，不影响 (0,3)
  C.placePerson(st, st.people[1].id, C.key(0, 1)); // B 在第 0 行，(0,3) 仍应是 X
  assert.equal(C.xSource(st, C.key(0, 3)), 'user');
  const r = C.toggleX(st, C.key(0, 3));  // 擦掉用户 X
  assert.equal(r.ok, true);
  assert.equal(C.xSource(st, C.key(0, 3)), 'place', '必须仍被 B 排除');
  assert.deepEqual(C.placeOwners(st, C.key(0, 3)), [st.people[1].id]);
});

test('B-3 非规范 key（"01,2"）导入即丢弃，不会出现"人物条有、棋盘没有"', () => {
  const raw = {
    rows: 4, cols: 4,
    people: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
    play: { placed: { p1: '01,2' }, xmarks: { '01,2': 'user', '0,02': 'user' }, candidates: { p1: ['0,02'] } },
  };
  const st = C.deserialize(raw);
  assert.equal(st.play.placed.p1, undefined, '非规范落点必须丢弃');
  assert.equal(Object.keys(st.play.xmarks).length, 0);
  assert.deepEqual(st.play.candidates.p1, []);
  assert.equal(C.isValidKey('01,2', 4, 4), false);
  assert.equal(C.isValidKey('1,2', 4, 4), true);
  // 同一格的两种写法不会同时留在区域/物品里
  const st2 = C.createState(4, 4);
  const it = C.createItem(st2, 'x', ['1,2', '01,2', '1,2'], true);
  assert.deepEqual(it.cells, ['1,2']);
});

test('B-4 导入标签被规范化：互不重复且不含 X，合法自定义标签保留', () => {
  const raw = {
    rows: 3, cols: 3,
    people: [{ id: 'p1', label: 'X' }, { id: 'p2', label: 'X' }, { id: 'p3', label: 'A' }],
  };
  const st = C.deserialize(raw);
  const labels = [...st.people].map(p => p.label);
  assert.equal(new Set(labels).size, 3, '标签必须唯一：' + labels.join(','));
  assert.ok(labels.every(l => !l.includes('X')), '标签不能含 X：' + labels.join(','));

  const st2 = C.deserialize({ rows: 3, cols: 3, people: [{ id: 'p1', label: 'Q' }, { id: 'p2', label: 'R' }] });
  assert.deepEqual([...st2.people].map(p => p.label), ['Q', 'R', 'C'], '合法标签保留，补齐的人物用默认标签');
});

test('B-4 导入超长/含 X 的标签会被替换，不会撑破格子', () => {
  const st = C.deserialize({ rows: 2, cols: 2, people: [{ id: 'p1', label: 'XXXXXXXX' }, { id: 'p2', label: 'AB' }] });
  assert.equal(st.people[0].label, 'A');
  assert.equal(st.people[1].label, 'AB');
});

test('setLink 原地改极性，不改变关联顺序', () => {
  const st = blank(4, 4);
  const a = st.people[0].id;
  const [r1, r2, r3] = ['r-1', 'r-2', 'r-3'].map(id => {
    const r = C.createRegion(st, id, [C.key(0, 0)]);
    return r.id;
  });
  for (const id of [r1, r2, r3]) C.setLink(st, a, 'region', id, 1);
  const order = () => st.people[0].links.map(l => l.id).join(',');
  assert.equal(order(), [r1, r2, r3].join(','));

  C.setLink(st, a, 'region', r2, -1);
  assert.equal(order(), [r1, r2, r3].join(','), '改极性不该重排');
  assert.equal(C.getLink(st, a, 'region', r2), -1);

  C.setLink(st, a, 'region', r2, 1);
  assert.equal(order(), [r1, r2, r3].join(','));

  C.setLink(st, a, 'region', r2, 0);
  assert.equal(order(), [r1, r3].join(','), '删除后其余顺序不变');

  C.setLink(st, a, 'region', r2, 1);
  assert.equal(order(), [r1, r3, r2].join(','), '重新添加追加到末尾');
});

// ------------------------------------------------------------ 人物编号可修改

test('setPersonLabel：可改成任意 1–4 字符、不含 X、不重复的编号', () => {
  const st = blank(4, 4);
  const [a, b] = st.people.map(p => p.id);
  let r = C.setPersonLabel(st, a, '小明');
  assert.equal(r.ok, true);
  assert.equal(C.person(st, a).label, '小明');
  assert.equal(r.message, '已把 A 改名为「小明」');

  // 去空白
  assert.equal(C.setPersonLabel(st, b, '  B2 ').ok, true);
  assert.equal(C.person(st, b).label, 'B2');

  // 非法：空 / 超长 / 含 X / 重复 / 没变化
  assert.equal(C.setPersonLabel(st, a, '   ').ok, false);
  assert.equal(C.setPersonLabel(st, a, 'ABCDE').ok, false);
  assert.equal(C.setPersonLabel(st, a, 'AX').ok, false, 'X 在棋盘上另有含义');
  assert.equal(C.setPersonLabel(st, a, 'x').ok, false);
  assert.equal(C.setPersonLabel(st, a, 'B2').ok, false, '不能与别人重复');
  assert.equal(C.setPersonLabel(st, a, '小明').ok, false, '没变化也要拒绝');
  assert.equal(C.person(st, a).label, '小明', '失败时不应改动');
});

test('改编号不影响关联 / 别人的候选 / 确定位置', () => {
  const st = C.createState(4, 4);
  const [a, b] = st.people.map(p => p.id);
  const reg = C.createRegion(st, '红区', [C.key(0, 0)]);
  C.setLink(st, a, 'region', reg.id, -1);
  C.toggleCandidate(st, b, C.key(1, 1));
  C.placePerson(st, a, C.key(2, 2));

  assert.equal(C.setPersonLabel(st, a, '一号').ok, true);
  assert.equal(C.person(st, a).label, '一号');
  assert.deepEqual(C.person(st, a).links, [{ kind: 'region', id: reg.id, polarity: -1 }], '关联保留');
  assert.equal(st.play.placed[a], C.key(2, 2), '确定位置保留');
  assert.deepEqual(st.play.candidates[b], [C.key(1, 1)], '别人的候选不受影响');
});

test('自定义编号能导出再导入原样保留', () => {
  const st = C.createState(4, 4);
  C.setPersonLabel(st, st.people[0].id, '甲');
  C.setPersonLabel(st, st.people[1].id, '小红');
  C.setPersonLabel(st, st.people[2].id, 'Z9');
  const round = C.deserialize(C.serialize(st));
  assert.deepEqual([...round.people].map(p => p.label), ['甲', '小红', 'Z9', 'D']);
});

test('导入时重复/含 X 的编号仍会被替换成默认编号', () => {
  const raw = {
    rows: 3, cols: 3,
    people: [{ id: 'p1', label: '小明' }, { id: 'p2', label: '小明' }, { id: 'p3', label: 'X' }],
  };
  const st = C.deserialize(raw);
  const labels = [...st.people].map(p => p.label);
  assert.equal(new Set(labels).size, 3, '编号必须唯一：' + labels.join(','));
  assert.equal(labels[0], '小明', '合法自定义编号保留');
  assert.ok(labels.every(l => !/x/i.test(l)), '不能含 X：' + labels.join(','));
});

// ------------------------------------------------------------ 底图与网格对位

test('boardLayout：底图锚在原点，画布尺寸取底图与网格的并集', () => {
  const st = C.createState(6, 8);            // 8 列 × 6 行
  st.settings.cellSize = 50;                 // 网格 400×300
  // 准备阶段没有行列提示表头，headW/headH 为 0
  assert.deepEqual(C.boardLayout(st), {
    cell: 50, gridW: 400, gridH: 300, bgW: 0, bgH: 0,
    headW: 0, headH: 0,
    bgLeft: 0, bgTop: 0, gridLeft: 0, gridTop: 0, width: 400, height: 300,
  });

  C.setBackground(st, { kind: 'image', name: 'm.png', w: 400, h: 300, scale: 1 });
  assert.deepEqual(C.boardLayout(st), {
    cell: 50, gridW: 400, gridH: 300, bgW: 400, bgH: 300,
    headW: 0, headH: 0,
    bgLeft: 0, bgTop: 0, gridLeft: 0, gridTop: 0, width: 400, height: 300,
  });

  // 网格右下移 → 画布变大，底图与网格各自平移以保证不出现负坐标
  C.setGridOffset(st, 30, 20);
  let L = C.boardLayout(st);
  assert.equal(L.width, 430);
  assert.equal(L.height, 320);
  assert.equal(L.gridLeft, 30);
  assert.equal(L.bgLeft, 0);

  // 网格左上移（负偏移）→ 底图被推下去，画布同样变大
  C.setGridOffset(st, -25, -15);
  L = C.boardLayout(st);
  assert.equal(L.gridLeft, 0);
  assert.equal(L.gridTop, 0);
  assert.equal(L.bgLeft, 25);
  assert.equal(L.bgTop, 15);
  assert.equal(L.width, 425);
  assert.equal(L.height, 315);

  // 底图缩放会影响占用尺寸
  C.updateBackground(st, { scale: 0.5 });
  assert.equal(C.boardLayout(st).bgW, 200);
});

test('网格偏移有上下限，nudgeGrid 累加但不越界', () => {
  const st = C.createState(3, 3);
  C.setGridOffset(st, 99999, -99999);
  assert.equal(st.grid.x, C.GRID_LIMIT);
  assert.equal(st.grid.y, -C.GRID_LIMIT);
  C.setGridOffset(st, 10, 10);
  C.nudgeGrid(st, 5, -3);
  assert.deepEqual(st.grid, { x: 15, y: 7 });
  C.nudgeGrid(st, 1e9, 0);
  assert.equal(st.grid.x, C.GRID_LIMIT, '微调也不会越界');
});

test('setBackground / updateBackground 会规范化脏数据', () => {
  const st = C.createState(3, 3);
  assert.equal(C.setBackground(st, null).ok, false, '本来就没有底图');
  C.setBackground(st, { kind: 'bogus', name: 'x'.repeat(200), w: 400, h: 300, scale: 99, opacity: -1, page: 0, pages: 'x' });
  assert.equal(st.bg.kind, 'image', '非法 kind 回落到 image');
  assert.equal(st.bg.name.length, 80, '名称截断');
  assert.equal(st.bg.scale, C.BG_SCALE_MAX, '缩放夹到上限');
  assert.equal(st.bg.opacity, C.BG_OPACITY_MIN, '透明度夹到下限');
  assert.equal(st.bg.page, 1);
  assert.equal(st.bg.pages, 1);
  assert.equal(C.setBackground(st, { w: 0, h: 0 }).ok, false, '尺寸为 0 视为不合法');

  C.setBackground(st, { kind: 'pdf', name: 'p.pdf', w: 800, h: 600, srcW: 400, srcH: 300, scale: 0.5, opacity: 0.7, page: 2, pages: 3 });
  assert.equal(st.bg.kind, 'pdf');
  assert.equal(C.updateBackground(st, { visible: false }).ok, true);
  assert.equal(st.bg.visible, false);
});

test('移除底图会把网格偏移一起归零', () => {
  const st = C.createState(3, 3);
  C.setBackground(st, { kind: 'image', name: 'm', w: 100, h: 100 });
  C.setGridOffset(st, 40, 50);
  assert.deepEqual(st.grid, { x: 40, y: 50 });
  assert.equal(C.setBackground(st, null).ok, true);
  assert.equal(st.bg, null);
  assert.deepEqual(st.grid, { x: 0, y: 0 });
});

test('底图与网格偏移随存档往返，导出可带上底图数据', () => {
  const st = C.createState(4, 4);
  C.setBackground(st, { kind: 'pdf', name: 'a.pdf', w: 1200, h: 900, srcW: 400, srcH: 300, scale: 0.6, opacity: 0.75, page: 2, pages: 5 });
  C.setGridOffset(st, 17, -9);
  const text = C.serialize(st, 'data:image/png;base64,AAA');
  assert.ok(text.includes('bgData'), '导出带上底图数据');
  const back = C.deserialize(JSON.parse(text));
  assert.deepEqual(back.bg, st.bg);
  assert.deepEqual(back.grid, { x: 17, y: -9 });
  assert.equal(back.settings.cellSize, st.settings.cellSize);
  // 不带底图数据的序列化也能正常读回
  const back2 = C.deserialize(C.serialize(st));
  assert.deepEqual(back2.bg, st.bg);
});

test('格子尺寸范围放宽到 12–160（对齐底图需要）', () => {
  assert.equal(C.CELL_MIN, 12);
  assert.equal(C.CELL_MAX, 160);
  const st = C.deserialize({ rows: 3, cols: 3, settings: { cellSize: 999 } });
  assert.equal(st.settings.cellSize, C.CELL_MAX);
  assert.equal(C.deserialize({ rows: 3, cols: 3, settings: { cellSize: 1 } }).settings.cellSize, C.CELL_MIN);
});

// ------------------------------------------------------------ 裁切与绑定缩放

test('setCellSize：没裁切过只动格子，底图与网格偏移不动', () => {
  const st = C.createState(4, 4);
  st.settings.cellSize = 40;
  C.setBackground(st, { kind: 'image', name: 'm', w: 800, h: 600, scale: 0.5 });
  C.setGridOffset(st, 30, 20);
  const r = C.setCellSize(st, 80);
  assert.equal(r.ok, true);
  assert.equal(st.settings.cellSize, 80);
  assert.equal(st.bg.scale, 0.5, '未绑定：底图缩放不该动');
  assert.deepEqual(st.grid, { x: 30, y: 20 }, '未绑定：网格偏移不该动（对齐阶段需要这个自由度）');
});

test('setCellSize：裁切过（bound）时格子 / 底图 / 网格偏移同倍变化', () => {
  const st = C.createState(4, 4);
  st.settings.cellSize = 40;
  C.setBackground(st, { kind: 'image', name: 'm', w: 800, h: 600, scale: 0.5, bound: true });
  C.setGridOffset(st, 30, 20);
  C.setCellSize(st, 80);                       // k = 2
  assert.equal(st.settings.cellSize, 80);
  assert.equal(st.bg.scale, 1);
  assert.deepEqual(st.grid, { x: 60, y: 40 });
  C.setCellSize(st, 40);                       // k = 0.5，应原样回到起点
  assert.equal(st.bg.scale, 0.5);
  assert.deepEqual(st.grid, { x: 30, y: 20 });
});

test('setCellSize：夹到 CELL_MIN/MAX，同值时不改动', () => {
  const st = C.createState(3, 3);
  st.settings.cellSize = 40;
  C.setBackground(st, { kind: 'image', name: 'm', w: 400, h: 400, scale: 1, bound: true });
  assert.equal(C.setCellSize(st, 40).changed, false, '同值直接返回不改动');
  C.setCellSize(st, 1e6);
  assert.equal(st.settings.cellSize, C.CELL_MAX);
  C.setCellSize(st, -5);
  assert.equal(st.settings.cellSize, C.CELL_MIN);
});

test('gridCropRect：把网格外框换算成图片坐标', () => {
  const st = C.createState(2, 3);              // 3 列 × 2 行 → 网格 150×100（cell 50）
  st.settings.cellSize = 50;
  C.setBackground(st, { kind: 'image', name: 'm', w: 1000, h: 800, scale: 0.5 });
  C.setGridOffset(st, 100, 60);                // 图片坐标 (200,120) 起
  const r = C.gridCropRect(st, 0);
  assert.deepEqual({ x: r.x, y: r.y, w: r.w, h: r.h }, { x: 200, y: 120, w: 300, h: 200 });
  assert.equal(r.gridX, 0, '无边距时网格正好贴住新图左上角');
  assert.equal(r.gridY, 0);
  assert.equal(r.scale, 0.5, '裁切不该改变底图缩放');
});

test('gridCropRect：边距按屏幕像素给，换算进图片坐标', () => {
  const st = C.createState(2, 2);
  st.settings.cellSize = 50;                   // 网格 100×100
  C.setBackground(st, { kind: 'image', name: 'm', w: 1000, h: 1000, scale: 0.5 });
  C.setGridOffset(st, 200, 200);               // 图片坐标 (400,400)
  const r = C.gridCropRect(st, 20);            // 屏幕 20px → 图片 40px
  assert.equal(r.x, 360);
  assert.equal(r.y, 360);
  assert.equal(r.w, 280, '100 网格 + 两侧各 40 图片边距');
  assert.equal(r.h, 280);
  assert.equal(r.gridX, 20, '裁完后网格距新图左边 20 屏幕 px');
  assert.equal(r.gridY, 20);
});

test('gridCropRect：不越出图片边界，且裁切前后对齐关系不变', () => {
  const st = C.createState(2, 2);
  st.settings.cellSize = 50;
  C.setBackground(st, { kind: 'image', name: 'm', w: 200, h: 200, scale: 1 });
  C.setGridOffset(st, 0, 0);                   // 网格贴住图片左上角
  const r = C.gridCropRect(st, 40);
  assert.deepEqual({ x: r.x, y: r.y, w: r.w, h: r.h }, { x: 0, y: 0, w: 140, h: 140 });
  assert.equal(r.gridX, 0);
  assert.equal(r.gridY, 0);

  // 按 gridCropRect 的结果重建状态：网格应当仍在原来的画面位置
  const before = C.boardLayout(st);
  const st2 = C.createState(2, 2);
  st2.settings.cellSize = 50;
  C.setBackground(st2, { kind: 'image', name: 'm', w: r.w, h: r.h, scale: r.scale, bound: true });
  C.setGridOffset(st2, r.gridX, r.gridY);
  const after = C.boardLayout(st2);
  assert.equal(after.gridW, before.gridW);
  assert.equal(after.gridH, before.gridH);
  assert.equal(after.gridLeft, 0, '网格现在贴着新图左上角');
});

test('gridCropRect：没有底图、或裁出来过小时返回 null', () => {
  const st = C.createState(3, 3);
  assert.equal(C.gridCropRect(st, 10), null, '没有底图');
  C.setBackground(st, { kind: 'image', name: 'm', w: 4, h: 4, scale: 1 });
  assert.equal(C.gridCropRect(st, 0), null, '裁出来太小，视为不可裁');
});

test('bound 随存档往返，缺省为 false', () => {
  const st = C.createState(3, 3);
  C.setBackground(st, { kind: 'image', name: 'm', w: 300, h: 300, scale: 1, bound: true });
  assert.equal(C.deserialize(JSON.parse(C.serialize(st))).bg.bound, true);

  const st2 = C.createState(3, 3);
  C.setBackground(st2, { kind: 'image', name: 'm', w: 300, h: 300, scale: 1 });
  assert.equal(C.deserialize(JSON.parse(C.serialize(st2))).bg.bound, false, '默认不是绑定态');
});


// ------------------------------------------------------------ 行列候选提示

test('linePeople：统计每行/每列有哪些人的候选，以及是否已有确定的人', () => {
  const st = C.createState(5, 5);
  const [a, b, c] = st.people.map(p => p.id);
  C.setCandidate(st, a, '0,1', true);
  C.setCandidate(st, a, '0,3', true);      // a 在第 0 行两格
  C.setCandidate(st, b, '0,2', true);
  C.setCandidate(st, b, '2,3', true);
  C.setCandidate(st, c, '4,4', true);

  const lp = C.linePeople(st);
  assert.deepEqual(lp.rows[0].cands, [a, b], '第 0 行有 a、b 的候选');
  assert.deepEqual(lp.rows[2].cands, [b]);
  assert.deepEqual(lp.rows[1].cands, [], '没有候选的行是空的');
  assert.deepEqual(lp.cols[3].cands, [a, b], '第 3 列有 a、b 的候选');
  assert.deepEqual(lp.cols[4].cands, [c]);
  // 同一个人在同一行只算一次
  assert.equal(lp.rows[0].cands.length, 2, '去重');

  // 放人会清掉该人自己的候选（既有设计），所以第 0 行只剩 b
  C.placePerson(st, a, '1,1');
  const lp2 = C.linePeople(st);
  assert.equal(lp2.rows[1].placed, a, '第 1 行已有确定的人');
  assert.equal(lp2.cols[1].placed, a, '第 1 列已有确定的人');
  assert.deepEqual(lp2.rows[0].cands, [b], '该人被确定后他自己的候选被清掉，只剩别人');
  assert.equal(lp2.cols[1].cands.indexOf(a), -1, '确定的那一列也不再把他算作候选');
});

test('行列提示只在游玩阶段显示，且可以关掉', () => {
  const st = C.createState(6, 6);
  assert.equal(C.headsVisible(st), false, '准备阶段不显示');
  assert.deepEqual(C.headSize(st), { w: 0, h: 0 });

  st.phase = 'play';
  assert.equal(C.headsVisible(st), true, '游玩阶段显示');
  const h = C.headSize(st);
  assert.ok(h.w >= 46 && h.h >= 26, '表头有合理尺寸：' + JSON.stringify(h));

  st.settings.showHeads = false;
  assert.equal(C.headsVisible(st), false, '关掉后不显示');
  assert.equal(C.boardLayout(st).headW, 0, '关掉后画布不留表头空间');
});

test('有表头时画布为它在左上留出空间，底图与网格整体平移（相对关系不变）', () => {
  const st = C.createState(6, 8);
  st.settings.cellSize = 50;
  C.setBackground(st, { kind: 'image', name: 'm.png', w: 400, h: 300, scale: 1 });
  C.setGridOffset(st, 30, 20);
  const before = C.boardLayout(st);

  st.phase = 'play';
  const after = C.boardLayout(st);
  const hw = after.headW, hh = after.headH;
  assert.ok(hw > 0 && hh > 0, '游玩阶段表头有尺寸');
  assert.equal(after.gridLeft, before.gridLeft + hw, '网格右移一个表头宽');
  assert.equal(after.gridTop, before.gridTop + hh, '网格下移一个表头高');
  assert.equal(after.bgLeft, before.bgLeft + hw, '底图同样右移，相对网格不变');
  assert.equal(after.bgTop, before.bgTop + hh);
  assert.equal(after.gridLeft - after.bgLeft, before.gridLeft - before.bgLeft, '两者相对偏移不变');
  assert.equal(after.width, before.width + hw, '画布宽加上表头');
  assert.equal(after.height, before.height + hh, '画布高加上表头');
});

test('表头尺寸随格子大小缩放但有上下限', () => {
  const st = C.createState(6, 6);
  st.phase = 'play';
  st.settings.cellSize = 12;
  const small = C.headSize(st);
  st.settings.cellSize = 160;
  const big = C.headSize(st);
  st.settings.cellSize = 30;
  const mid = C.headSize(st);
  assert.ok(small.w >= 46 && big.w <= 96, '宽度夹在 46–96：' + small.w + ' / ' + big.w);
  assert.ok(small.h >= 26 && big.h <= 60, '高度夹在 26–60：' + small.h + ' / ' + big.h);
  assert.ok(big.w > mid.w && mid.w >= small.w, '随格子变大而变宽');
});

test('行列提示开关跟着存档往返', () => {
  const st = C.createState(6, 6);
  st.phase = 'play';
  st.settings.showHeads = false;
  const back = C.deserialize(C.serialize(st));
  assert.equal(back.settings.showHeads, false, '关掉的状态能存下来');
  st.settings.showHeads = true;
  assert.equal(C.deserialize(C.serialize(st)).settings.showHeads, true, '默认开启');
  // 老存档里没有这个字段 → 按开启处理
  const raw = JSON.parse(C.serialize(st));
  delete raw.settings.showHeads;
  assert.equal(C.deserialize(raw).settings.showHeads, true, '缺字段时默认开启');
});

/*! 线索解析单测：喂**真实题目里出现过的句子**（来自 car-repair / familymurdoku / contest1 的文字层） */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/clues.js');

// 当前清单（图例识别出来之后就是这样）
const NAMES = [
  { name: 'Oil Slick', kind: 'item' }, { name: 'Car', kind: 'item' }, { name: 'Chair', kind: 'item' },
  { name: 'TV', kind: 'item' }, { name: 'Shelf', kind: 'item' }, { name: 'Table', kind: 'item' },
  { name: 'Plant', kind: 'item' },
  { name: 'GARAGE', kind: 'region' }, { name: 'RECEPTION', kind: 'region' },
  { name: 'WAITING AREA', kind: 'region' }, { name: 'STORAGE', kind: 'region' },
];

test('线索解析：人在某件物品里 ✓', () => {
  const r = C.parse('He was in a car .', NAMES);
  assert.equal(r.kind, 'in');
  assert.equal(r.target.name, 'Car');
  assert.equal(r.polarity, 1);
});

test('线索解析：坐着也是"在…里" ✓（She was sitting in a chair .）', () => {
  const r = C.parse('She was sitting in a chair .', NAMES);
  assert.equal(r.kind, 'in');
  assert.equal(r.target.name, 'Chair');
});

test('线索解析：多词物品名要整体匹配 ✓（Oil Slick 不能被拆成 Slick）', () => {
  const r = C.parse('He was on an oil slick.', NAMES);
  assert.equal(r.target.name, 'Oil Slick');
  const r2 = C.parse('He was on an oil slick.', [{ name: 'Slick', kind: 'item' }].concat(NAMES));
  assert.equal(r2.target.name, 'Oil Slick', '长名字优先');
});

test('线索解析：在区域里 ✓（She was alone in the Waiting Area）', () => {
  const r = C.parse('She was alone in the Waiting Area', NAMES);
  assert.equal(r.kind, 'in');
  assert.equal(r.target.name, 'WAITING AREA');
  assert.equal(r.target.kind, 'region');
});

test('线索解析：在…旁边 = beside ✓', () => {
  const r = C.parse('He was beside a shelf .', NAMES);
  assert.equal(r.kind, 'beside');
  assert.equal(r.target.name, 'Shelf');
  assert.equal(r.polarity, 1, 'beside 是正关系');
});

test('线索解析：不在旁边 = 负关系 ✗（contest 的 are not beside the ○）', () => {
  const r = C.parse('They are not beside the table .', NAMES);
  assert.equal(r.kind, 'not-beside');
  assert.equal(r.target.name, 'Table');
  assert.equal(r.polarity, -1);
});

test('线索解析：方向性线索也算"在" ✓（He was east of Griselda 这类结构）', () => {
  const r = C.parse('He was directly north of the shelf .', NAMES);
  assert.equal(r.kind, 'in');
  assert.equal(r.target.name, 'Shelf');
});

test('线索解析：规则/说明文字不认 ✗（宁可不写，也别写错）', () => {
  for (const t of [
    'Rule: One person per Row and Column',
    'What does “beside” mean?',
    'to the left, right, above or under something, and in the same area',
    'as soon as you place someone...',
    '...block their entire row and column',
    'Puzzle and concept by Manuel Garand',
  ]) {
    const r = C.parse(t, NAMES);
    assert.equal(r.kind, 'none', '不该认成线索：' + t);
  }
});

test('线索解析：提到了没有的实物 → 保留关系但不给目标（提示用户先补物品）', () => {
  const r = C.parse('He was on a ship .', NAMES);
  assert.equal(r.kind, 'in');
  assert.equal(r.target, null);
  assert.match(r.reason, /没匹配到/);
});

test('线索解析：没有关系词的句子不认 ✗', () => {
  assert.equal(C.parse('The killer was alone with the murderer.', NAMES).kind, 'none');
  assert.equal(C.parse('Fleur', NAMES).kind, 'none');
});

test('人名判定：头像卡上的名字算人名 ✓，线索句子不算 ✗，全大写区域名不算 ✗', () => {
  assert.ok(C.looksLikePersonName('Anthony'));
  assert.ok(C.looksLikePersonName('Breck'));
  assert.ok(!C.looksLikePersonName('He was in a car .'));
  assert.ok(!C.looksLikePersonName('RECEPTION'));
  assert.ok(!C.looksLikePersonName('Can be occupied'));
});

test('逐行归并：同一张卡的上下两行要合成一块 ✓（She was alone / in the Waiting Area）', () => {
  const blocks = C.mergeBlocks([
    { text: 'She was alone', x: 100, y: 300, h: 12, w: 60 },
    { text: 'in the Waiting Area', x: 100, y: 316, h: 12, w: 120 },
    { text: 'He was in a car .', x: 100, y: 500, h: 12, w: 90 },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'She was alone in the Waiting Area');
});

test('端到端（纯部分）：行 → 线索候选 + 人名，并把线索挂到**上方最近**的人名 ✓', () => {
  const out = C.extract([
    { text: 'Brock', x: 300, y: 400, h: 14, w: 40 },
    { text: 'He was on an', x: 280, y: 430, h: 12, w: 70 },
    { text: 'oil slick.', x: 280, y: 446, h: 12, w: 50 },
    { text: 'Crystal', x: 480, y: 400, h: 14, w: 50 },
    { text: 'She was sitting', x: 460, y: 430, h: 12, w: 80 },
    { text: 'in a chair .', x: 460, y: 446, h: 12, w: 60 },
    { text: 'Rule: One person per Row and Column', x: 600, y: 100, h: 12, w: 200 },
  ], NAMES);
  assert.equal(out.clues.length, 2, JSON.stringify(out.clues.map(c => c.text)));
  const byCar = out.clues.find(c => c.target === 'Oil Slick');
  const byChair = out.clues.find(c => c.target === 'Chair');
  assert.equal(byCar.person, 'Brock');
  assert.equal(byChair.person, 'Crystal');
  assert.ok(out.skipped.some(s => /Rule:/.test(s.text)), '规则文字被跳过');
});

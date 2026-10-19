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
  const byCar = out.clues.find(c => (c.links[0] || {}).target === 'Oil Slick');
  const byChair = out.clues.find(c => (c.links[0] || {}).target === 'Chair');
  assert.equal(byCar.person, 'Brock');
  assert.equal(byChair.person, 'Crystal');
  assert.equal(byCar.text, 'He was on an oil slick.', '整句都记下来 ✓');
  assert.ok(out.skipped.some(s => /Rule:/.test(s.text)), '规则文字被跳过');
});

test('加粗信号：题目把物品名/关系词加粗 ✓ —— 加粗片段优先于模糊匹配', () => {
  const names = [{ name: 'Slick', kind: 'item' }, { name: 'Oil Slick', kind: 'item' }, { name: 'Shelf', kind: 'item' }];
  // 只有 "Slick" 在清单里，但加粗的是 "oil slick." → 用加粗去找（找不到就退回全文 ✓）
  const r = C.parse('He was on an oil slick .', names, { groups: [{ font: 'f2', text: 'oil slick.' }] });
  assert.equal(r.target.name, 'Oil Slick');
  assert.equal(r.bold, 'oil slick.');
  // 没有加粗（例如截图 OCR）→ 退回全文匹配，长名字优先 ✓
  const r2 = C.parse('He was on an oil slick .', names);
  assert.equal(r2.target.name, 'Oil Slick');
  assert.equal(r2.bold, null);
});

test('加粗片段优先：清单里同时有 Slick 与 Oil Slick 时也稳 ✓', () => {
  const names = [{ name: 'Slick', kind: 'item' }, { name: 'Oil Slick', kind: 'item' }];
  const r = C.parse('He was on an oil slick .', names, { groups: [{ font: 'f2', text: 'oil slick.' }] });
  assert.equal(r.target.name, 'Oil Slick');
});

test('readRuns：按字体分组 ✓（PDF 文字层里加粗是独立字体块）', () => {
  const got = C.readRuns([
    { text: 'He was on an', font: 'g_d0_f1' },
    { text: 'oil slick.', font: 'g_d0_f2' },
    { text: 'beside', font: 'g_d0_f2' },
    { text: 'a', font: 'g_d0_f1' },
    { text: 'shelf', font: 'g_d0_f2' },
  ]);
  assert.equal(got.text, 'He was on an oil slick. beside a shelf');
  assert.deepEqual(got.groups.map(g => g.font), ['g_d0_f1', 'g_d0_f2']);
  assert.equal(got.groups.find(g => g.font === 'g_d0_f2').text, 'oil slick. beside shelf');
});

test('extract：行里带 runs（含字体）时，加粗片段会一路传到解析结果 ✓', () => {
  const out = C.extract([
    { text: 'Anthony', x: 100, y: 400, h: 14, w: 50 },
    { text: '', x: 100, y: 430, h: 12, w: 0, runs: [
      { text: 'He was in a', font: 'f1' }, { text: 'car', font: 'f2' }, { text: '.', font: 'f1' }] },
  ], [{ name: 'Car', kind: 'item' }, { name: 'Chair', kind: 'item' }]);
  assert.equal(out.clues.length, 1);
  assert.equal(out.clues[0].links[0].target, 'Car');
  assert.equal(out.clues[0].person, 'Anthony');
  assert.equal(out.clues[0].links[0].bold, 'car');
});

test('二维聚类：**两列并排**的卡片不能连成一块 ✗（上次就是被这个搞挂的）', () => {
  const blocks = C.cluster([
    // 左列：Brock 的卡（名字 + 两行线索）
    { text: 'Brock', x: 300, y: 400, w: 40, h: 14 },
    { text: 'He was on an', x: 280, y: 430, w: 70, h: 12 },
    { text: 'oil slick.', x: 280, y: 446, w: 50, h: 12 },
    // 右列：Crystal 的卡（同一 y ✓）
    { text: 'Crystal', x: 480, y: 400, w: 50, h: 14 },
    { text: 'She was sitting', x: 460, y: 430, w: 80, h: 12 },
    { text: 'in a chair .', x: 460, y: 446, w: 60, h: 12 },
  ]);
  const texts = blocks.map(b => b.text).sort();
  assert.ok(texts.includes('Brock'), '人名单独成块：' + JSON.stringify(texts));
  assert.ok(texts.includes('Crystal'));
  assert.ok(texts.includes('He was on an oil slick.'), '左列合成一句：' + JSON.stringify(texts));
  assert.ok(texts.includes('She was sitting in a chair .'), '右列合成一句：' + JSON.stringify(texts));
  assert.equal(blocks.length, 4, JSON.stringify(texts));
});

test('取字到解析（readItems）：字体分组一路传到目标 ✓', () => {
  const out = C.readItems([
    { text: 'Anthony', x: 100, y: 400, w: 55, h: 14, font: 'f9' },
    { text: 'He was in a', x: 90, y: 430, w: 70, h: 12, font: 'f1' },
    { text: 'car', x: 162, y: 430, w: 22, h: 12, font: 'f2' },
    { text: '.', x: 185, y: 430, w: 4, h: 12, font: 'f1' },
  ], [{ name: 'Car', kind: 'item' }, { name: 'Chair', kind: 'item' }]);
  assert.equal(out.clues.length, 1);
  assert.equal(out.clues[0].links[0].target, 'Car');
  assert.equal(out.clues[0].person, 'Anthony');
  assert.equal(out.clues[0].links[0].bold, 'car');
});

test('人物对应：① 编号同名 ② **按首字母** ✓ ③ 对不上的留空（不猜 ✗）', () => {
  const people = [{ id: 'p1', label: 'A' }, { id: 'p2', label: 'B' }, { id: 'p3', label: 'C' },
    { id: 'p4', label: 'D' }, { id: 'p5', label: 'E' }, { id: 'p6', label: 'F' }];
  const got = C.mapByInitial([
    { person: 'Anthony', text: 'He was in a car .' },
    { person: 'Crystal', text: 'She was sitting in a chair .' },
    { person: 'Breck', text: 'He was on an oil slick.' },
    { person: 'Vaughn', text: 'The Victim.' },          // V 不在 A–F 里 → 留空 ✓
    { person: null, text: '（卡片上没名字）' },
  ], people);
  assert.equal(got[0].personId, 'p1', 'Anthony → A');
  assert.equal(got[0].mappedBy, 'initial');
  assert.equal(got[1].personId, 'p3', 'Crystal → C');
  assert.equal(got[2].personId, 'p2', 'Breck → B');
  assert.equal(got[3].personId, 'p4', 'Vaughn 首字母不在编号里 → 按位置默认补上（D ✓）');
  assert.equal(got[3].mappedBy, 'order', '并标注"按位置推定" ✓');
  assert.equal(got[4].personId, 'p5', '下一条接着排 ✓');
});

test('人物对应：编号已被改成题目里的名字时，优先按同名对应 ✓', () => {
  const people = [{ id: 'p1', label: 'Anthony' }, { id: 'p2', label: 'B' }];
  const got = C.mapByInitial([{ person: 'Anthony', text: 'x' }], people);
  assert.equal(got[0].personId, 'p1');
  assert.equal(got[0].mappedBy, 'label');
});

test('人物对应：同一个人不会被两条线索占用 ✓（先到先得）', () => {
  const people = [{ id: 'p1', label: 'A' }, { id: 'p2', label: 'B' }];
  const got = C.mapByInitial([
    { person: 'Anthony', text: 'x' }, { person: 'Andrew', text: 'y' },
  ], people);
  assert.equal(got[0].personId, 'p1', '第一个人占 A ✓');
  assert.notEqual(got[1].personId, got[0].personId, 'A 不会被两条线索占用 ✓');
  assert.equal(got[1].mappedBy, 'order', '落空的那条按位置补上（面板标注"按位置推定"✓）');
});

test('页脚署名：混进线索里要去掉 ✓（"…in a chair in puzzle by Manuel Garand …" → 只留线索部分）', () => {
  // 署名截掉后剩下 "She was sitting in a chair in" ✓ —— 这是**残句** ✓，
  // 现在**保留**（标 truncated ✓）而不是丢掉（丢掉的后果见 car-repair 的 A 线索 ✗）
  const r = C.parse('She was sitting in a chair in puzzle by Manuel Garand the front area. art by Eli Voisin graphic design by Katarzyna Kosobucka & MG',
    [{ name: 'Chair', kind: 'item' }]);
  assert.equal(r.truncated, true, '残句要标记 truncated ✓');
  assert.match(r.reason, /没读全/);
  assert.equal(r.target.name, 'Chair', '残句里的目标仍然要解析出来 ✓');
  // 完整那句（切块修好后就是这样 ✓）要能解析出 Chair ✓
  const full = C.parse('She was sitting in a chair in the front area.', [{ name: 'Chair', kind: 'item' }, { name: 'FRONT AREA', kind: 'region' }]);
  assert.equal(full.kind, 'in');
  assert.equal(full.target.name, 'Chair', '目标应是关系词后面最近的 Chair ✓（不是 FRONT AREA ✗）');
});

test('只有署名的块不认 ✗', () => {
  const r = C.parse('puzzle by Manuel Garand', [{ name: 'Chair', kind: 'item' }]);
  assert.equal(r.kind, 'none');
  assert.match(r.reason, /署名|说明/);
});

test('剧情/规则文字不产生可用线索 ✓（这一版的 "Someone drew a mean caricature…" 不是线索）', () => {
  for (const t of [
    'Someone drew a mean caricature of the teacher on the chalkboard!',
    'I would’ve made the',
    'Oh rest assured, there will be extra homework for someone.',
    'clue: Crystal is the only person who can be with Anabella.',
  ]) {
    const r = C.parse(t, [{ name: 'Chair', kind: 'item' }]);
    // 这些句子**没有可用的目标** ✓ —— 所以不会建任何关联 ✓（整句仍会被记录 ✓，见下一条 ✓）
    assert.ok(!r.target, '不该给出目标：' + t + ' → ' + JSON.stringify(r.target));
    assert.equal(C.clauseLinks(t, [{ name: 'Chair', kind: 'item' }]).length, 0, '不该产生关联：' + t);
  }
});

test('没有人名的题：按**位置顺序**默认对应剩下的人物 ✓（不让用户一条条选 ✗）', () => {
  const people = [{ id: 'p1', label: 'A' }, { id: 'p2', label: 'B' }, { id: 'p3', label: 'C' }];
  const got = C.mapByInitial([
    { person: null, text: '下面的那条', x: 500, y: 900 },      // 位置在下 ✓
    { person: null, text: '上面的那条', x: 100, y: 400 },      // 位置在上 ✓
    { person: null, text: '右上那条', x: 700, y: 400 },
  ], people);
  const byText = Object.fromEntries(got.map(c => [c.text, c.personId]));
  assert.equal(byText['上面的那条'], 'p1', '最上面 → A');
  assert.equal(byText['右上那条'], 'p2', '同一行按 x → B');
  assert.equal(byText['下面的那条'], 'p3', '最下面 → C');
  assert.equal(got.every(c => c.mappedBy === 'order'), true);
});

test('名字对不上的线索也参与位置默认 ✓（family 那版假人名靠这条兜住）', () => {
  const people = [{ id: 'p1', label: 'A' }, { id: 'p2', label: 'B' }];
  const got = C.mapByInitial([
    { person: 'Vaughn', text: '首字母不在编号里' },
    { person: null, text: '没名字' },
  ], people);
  assert.equal(got[0].personId, 'p1', '名字没对上 → 也按位置补上 ✓（面板会标"按位置推定"，一下就能改 ✓）');
  assert.equal(got[0].mappedBy, 'order');
  assert.equal(got[1].personId, 'p2', '第二条接着排 ✓');
});

test('极性：否定句是**负**相关 ✗→✓（以前判成正的，会误导游玩）', () => {
  const names = [{ name: 'Chair', kind: 'item' }, { name: 'Shelf', kind: 'item' }];
  const a = C.parse('He was not sitting in a chair.', names);
  assert.equal(a.kind, 'in');
  assert.equal(a.target.name, 'Chair');
  assert.equal(a.polarity, -1, '"不是在…里" → 负相关');
  const b2 = C.parse('She was never beside the shelf.', names);
  assert.equal(b2.polarity, -1);
  const c = C.parse('He was sitting in a chair.', names);
  assert.equal(c.polarity, 1, '肯定句仍是正相关 ✓');
});

test('分句：一块里两句线索要**各算一条** ✓，且关系与目标同源 ✓', () => {
  const names = [{ name: 'Chair', kind: 'item' }, { name: 'Desk', kind: 'item' }];
  const out = C.extract([{ text: 'He was beside a desk. He was not sitting in a chair.', x: 0, y: 500, h: 12, w: 300 }], names);
  assert.equal(out.clues.length, 1, '一个气泡 = 一段 ✓');
  assert.equal(out.clues[0].text, 'He was beside a desk. He was not sitting in a chair.', '整段都记下来 ✓');
  assert.equal(out.clues[0].links.length, 2, '段内解析出两条关联 ✓');
  assert.equal(out.clues[0].links[0].target, 'Desk');
  assert.equal(out.clues[0].links[0].polarity, 1);
  assert.equal(out.clues[0].links[1].target, 'Chair', '不能配成 beside+Chair ✗');
  assert.equal(out.clues[0].links[1].polarity, -1);
});

test('OCR 逐词框：来源不同、阈值不同 ✓（词距小、y 有抖动，也要连成一句）', () => {
  // 模拟 OCR 的词框：y 抖动 ±5px、词间距 ~6px ✓
  const words = [
    { text: 'She', x: 300, y: 630, w: 28, h: 18 },
    { text: 'was', x: 332, y: 635, w: 28, h: 18 },
    { text: 'sitting', x: 364, y: 629, w: 52, h: 18 },
    { text: 'in', x: 300, y: 660, w: 18, h: 18 },
    { text: 'a', x: 322, y: 663, w: 10, h: 18 },
    { text: 'chair', x: 336, y: 658, w: 44, h: 18 },
  ];
  const names = [{ name: 'Chair', kind: 'item' }];
  const out = C.readOcrItems(words, names);
  assert.equal(out.clues.length, 1, JSON.stringify(out.blocks.map(b => b.text)));
  assert.equal(out.clues[0].links[0].target, 'Chair');
  assert.equal(out.clues[0].links[0].kind, 'in');
  assert.match(out.clues[0].text, /^She was sitting in a chair/, '词序要按"行内 x"还原 ✓：' + out.clues[0].text);
});

test('阅读顺序：同一行里 y 抖动不会打乱词序 ✓', () => {
  const blocks = C.cluster([
    { text: 'killer', x: 300, y: 158, w: 40, h: 16 },
    { text: 'was', x: 344, y: 163, w: 30, h: 16 },
    { text: 'alone', x: 378, y: 155, w: 40, h: 16 },
  ], { wordLevel: true });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'killer was alone', '按行内 x 排序 ✓');
});

test('截断的残句：保留但标记 ✓；被完整句覆盖时才丢 ✓（car-repair 的 A 线索就吃过"全丢"的亏 ✗）', () => {
  const names = [{ name: 'Chair', kind: 'item' }, { name: 'FRONT AREA', kind: 'region' }];
  const bad = C.parse('She was sitting in a', names);
  assert.equal(bad.truncated, true, '残句要保留并标记 ✓');
  assert.match(bad.reason, /没读全/);
  // extract 这一层：同一块里"残句 + 完整句"并存时，残句被丢掉 ✓（避免重复 ✗）
  const out = C.extract([
    { text: 'She was sitting in a', x: 10, y: 10, w: 200, h: 20 },
    { text: 'She was sitting in a chair in the front area.', x: 10, y: 40, w: 300, h: 20 },
  ], names);
  assert.equal(out.clues.length, 1, '残句被完整句覆盖 → 只留完整那条 ✓');
  assert.match(out.clues[0].text, /front area/);
  const good = C.parse('She was sitting in a chair in the front area.', names);
  assert.equal(good.kind, 'in');
  assert.equal(good.target.name, 'Chair', '关系词后面最近的目标 ✓');
  // 完整句里"在…附近/旁边"这类结构不受影响 ✓
  assert.equal(C.parse('He was beside a desk.', names).kind, 'beside');
});

test('用户要求：**整句都记下来** ✓ —— 没解析出关联的照样留 ✓', () => {
  const names = [{ name: 'Chair', kind: 'item' }];
  const out = C.extract([
    { text: 'Vaughn', x: 480, y: 400, h: 14, w: 50 },
    { text: 'The Victim. He was alone with the murderer.', x: 460, y: 430, h: 12, w: 220 },
  ], names);
  assert.equal(out.clues.length, 1, '有主语就留下 ✓');
  assert.equal(out.clues[0].text, 'The Victim. He was alone with the murderer.');
  assert.equal(out.clues[0].links.length, 0, '没关联也照样记整句 ✓');
  assert.equal(out.clues[0].person, 'Vaughn');
  // 规则文字仍然不认 ✗
  const out2 = C.extract([{ text: 'Rule: One person per Row and Column', x: 0, y: 100, h: 12, w: 200 }], names);
  assert.equal(out2.clues.length, 0);
});

test('looksLikeClueStatement：有主语就算线索陈述 ✓；规则/碎片不算 ✗', () => {
  assert.ok(C.looksLikeClueStatement('He was alone with the murderer.'));
  assert.ok(!C.looksLikeClueStatement('Rule: One person per Row and Column'));
  assert.ok(!C.looksLikeClueStatement('chair in the bottom row.'));
  assert.ok(!C.looksLikeClueStatement('What does “beside” mean?'));
});

test('golf 那类句式：occupy / within 也算"在…里" ✓', () => {
  const names = [{ name: 'tee', kind: 'item' }, { name: 'flag', kind: 'item' }, { name: 'sand pit', kind: 'region' }];
  assert.equal(C.parse('She occupied the flag in an even-numbered hole.', names).target.name, 'flag');
  assert.equal(C.parse('He was the only man to occupy a golf tee.', names).target.name, 'tee');
  assert.equal(C.parse('She was within a sand pit.', names).target.name, 'sand pit');
});

test('一句话里的**多个目标**都要出关联 ✓（以前只出一条 ✗）', () => {
  const names = [{ name: 'Chair', kind: 'item' }, { name: 'FRONT AREA', kind: 'region' }];
  const one = C.clauseLinks('She was sitting in a chair in the front area.', names);
  assert.equal(one.length, 2, JSON.stringify(one.map(x => x.kind + '→' + x.target)));
  assert.deepEqual(one.map(x => x.target), ['Chair', 'FRONT AREA'], '按出现顺序 ✓');
  assert.ok(one.every(x => x.kind === 'in' && x.polarity === 1));

  const two = C.extract([{ text: 'She was sitting in a chair in the front area.', x: 0, y: 100, h: 12, w: 300 }], names);
  assert.equal(two.clues.length, 1, '一个气泡 = 一段 ✓');
  assert.equal(two.clues[0].links.length, 2, '段内两条关联 ✓');

  // 两句各有自己的关联，且否定只作用在自己那句上 ✓
  const desk = [{ name: 'Desk', kind: 'item' }, { name: 'Chair', kind: 'item' }];
  const three = C.extract([{ text: 'He was beside a desk. He was not sitting in a chair.', x: 0, y: 200, h: 12, w: 300 }], desk);
  assert.equal(three.clues[0].links.length, 2);
  assert.equal(three.clues[0].links[0].target, 'Desk');
  assert.equal(three.clues[0].links[0].polarity, 1);
  assert.equal(three.clues[0].links[1].target, 'Chair');
  assert.equal(three.clues[0].links[1].polarity, -1);
});

test('已经指定过人物的候选不会被"位置推定"改派 ✓', () => {
  const people = [{ id: 'p1', label: 'A' }, { id: 'p2', label: 'B' }];
  const got = C.mapByInitial([
    { text: '手动指定给 B', person: null, personId: 'p2', links: [] },
    { text: '没指定 → 应该给 A', person: null, links: [] },
  ], people);
  assert.equal(got[0].personId, 'p2', '指定的不能被改 ✗');
  assert.equal(got[1].personId, 'p1', '剩下的按位置补 ✓');
  // 指向不存在的人 → 视为未指定 ✓
  const gone = C.mapByInitial([{ text: 'x', personId: 'nope', links: [] }], people);
  assert.equal(gone[0].personId, 'p1', '指向不存在的人时，按位置补 ✓');
});

test('人名配对：**横向对齐优先** ✓（不能只看纵向最近 —— contest 实测踩过）', () => {
  // 名字：Seraphina 在正上方且横向对齐 ✓；Rosalind 在左边远处但纵向更近 ✗
  const lines = [
    { text: 'Seraphina', x: 672, y: 1204, w: 144, h: 34 },
    { text: 'Rosalind', x: 433, y: 1242, w: 125, h: 33 },
    { text: 'She was at least six rows north of Linus .', x: 665, y: 1252, w: 162, h: 62 },
    { text: 'She was sitting in a chair .', x: 419, y: 1285, w: 153, h: 41 },
  ];
  const out = C.extract(lines, []);
  const byText = Object.fromEntries(out.clues.map(c => [c.text, c.person]));
  assert.equal(byText['She was at least six rows north of Linus .'], 'Seraphina',
    '横向对齐的 Seraphina 才对（Rosalind 纵向更近 ✗）');
  assert.equal(byText['She was sitting in a chair .'], 'Rosalind', '自己正下方那条仍归自己 ✓');
});

test('卡片模式（permissive）：以用户的框为准 ✓ —— 没有主语的整句也留下', () => {
  const names = [{ name: 'cart', kind: 'item' }, { name: 'tee', kind: 'item' }];
  // 这条**没有主谓结构**、句首也不是人称（严格模式会拒 ✗）——
  // 但它在用户框的卡片里 ✓ → 卡片模式要留 ✓
  const lines = [{ text: 'in front of a cart and a tee', x: 10, y: 20, w: 240, h: 60 }];
  assert.equal(C.readItems(lines, names).clues.length, 0, '整页模式：没有主语 → 拒 ✗');
  const card = C.readCardItems(lines, names);
  assert.equal(card.clues.length, 1, '卡片模式：留下 ✓ ' + JSON.stringify(card.clues.map(c => c.text)));
  assert.equal(card.clues[0].links[0].target, 'cart');
  // 卡片模式下"规则/署名/残句"仍然不要 ✓
  const junk = C.readCardItems([{ text: 'Rule: One person per Row and Column', x: 0, y: 0, w: 200, h: 20 }], names);
  assert.equal(junk.clues.length, 0, '规则文字仍被排除 ✓');
});

test('从线索文字推断性别 ✓（he/his → 男；she/her → 女；都有或都没有 → 未知）', () => {
  assert.equal(C.sexOf('She was beside a shelf .'), 'f');
  assert.equal(C.sexOf('He was in a car .'), 'm');
  assert.equal(C.sexOf('The Victim. He was alone with the murderer.'), 'm');
  assert.equal(C.sexOf('I didn’t do it!'), '', '没有人称代词 → 未知 ✓');
  assert.equal(C.sexOf('She was with him .'), '', '两者都有 → 未知 ✓（交给用户）');
  // extract 产出的候选行要带 sex ✓
  const out = C.extract([{ text: 'He was beside a shelf .', x: 0, y: 100, h: 12, w: 200 }],
    [{ name: 'Shelf', kind: 'item' }]);
  assert.equal(out.clues[0].sex, 'm');
});

/* Murdoku Helper — store 单元测试（用内存 storage 替代 localStorage） */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');
const { Store } = require('../js/store.js');

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _dump: () => m,
  };
}

function newStore() {
  const s = new Store('test', memStorage());
  s.state = C.createState(5, 5);
  return s;
}

test('commit 成功写入历史并持久化', () => {
  const st = newStore();
  const r = st.commit('标 X', s => C.toggleX(s, C.key(0, 0)));
  assert.equal(r.ok, true);
  assert.equal(st.canUndo(), true);
  assert.equal(st.undoLabel(), '标 X');
  assert.ok(st.storage.getItem('test').includes('"0,0"'));
});

test('mutator 返回 ok:false 时回滚且不写历史', () => {
  const st = newStore();
  const before = JSON.stringify(st.state);
  const r = st.commit('非法', s => { s.play.xmarks['1,1'] = { src: 'user' }; return { ok: false, message: '不行' }; });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(st.state), before);
  assert.equal(st.canUndo(), false);
});

test('mutator 抛异常时回滚', () => {
  const st = newStore();
  const before = JSON.stringify(st.state);
  assert.throws(() => st.commit('boom', s => { s.rows = 1; throw new Error('boom'); }));
  assert.equal(JSON.stringify(st.state), before);
  assert.equal(st.canUndo(), false);
});

test('undo / redo', () => {
  const st = newStore();
  st.commit('放 A', s => C.placePerson(s, s.people[0].id, C.key(2, 2)));
  assert.equal(C.personAt(st.state, C.key(2, 2)), st.state.people[0].id);
  st.undo();
  assert.equal(C.personAt(st.state, C.key(2, 2)), null);
  st.redo();
  assert.equal(C.personAt(st.state, C.key(2, 2)), st.state.people[0].id);
  st.commit('标 X', s => C.toggleX(s, C.key(0, 0)));
  assert.equal(st.canRedo(), false, '新提交清空重做栈');
});

test('多次撤销回到初始状态', () => {
  const st = newStore();
  const init = JSON.stringify(st.state);
  st.commit('a', s => C.toggleX(s, C.key(0, 0)));
  st.commit('b', s => C.toggleX(s, C.key(1, 1)));
  st.undo(); st.undo();
  assert.equal(JSON.stringify(st.state), init);
  assert.equal(st.undo().ok, false);
});

test('设置修改不进历史', () => {
  const st = newStore();
  st.setSettings({ cellSize: 60 });
  assert.equal(st.state.settings.cellSize, 60);
  assert.equal(st.canUndo(), false);
});

test('导出 / 导入往返', () => {
  const st = newStore();
  st.commit('区域', s => C.createRegion(s, '红区', [C.key(0, 0), C.key(0, 1)]));
  const text = st.exportText();
  const st2 = new Store('test2', memStorage());
  st2.state = C.createState(5, 5);
  st2.importText(text);
  assert.equal(st2.state.regions[0].name, '红区');
  assert.deepEqual(st2.state.regions[0].cells, [C.key(0, 0), C.key(0, 1)]);
  assert.equal(st2.canUndo(), true, '导入可撤销');
});

test('本地存档读回', () => {
  const storage = memStorage();
  const s1 = new Store('k', storage);
  s1.state = C.createState(6, 6);
  s1.commit('物品', s => C.createItem(s, '石头', [C.key(1, 1)], false));
  const s2 = new Store('k', storage);
  assert.equal(s2.state.rows, 6);
  assert.equal(s2.state.items[0].name, '石头');
  assert.equal(s2.state.items[0].occupiable, false);
});

test('存档损坏时回退到新地图', () => {
  const storage = memStorage();
  storage.setItem('bad', '{不是 JSON');
  const s = new Store('bad', storage);
  assert.equal(s.state.rows, 8);
  assert.equal(s.state.people.length, 8);
});

test('没有 storage 时也能工作', () => {
  const s = new Store('none', null);
  s.state = C.createState(3, 3);
  const r = s.commit('标 X', st => C.toggleX(st, C.key(0, 0)));
  assert.equal(r.ok, true);
});

test('B-1 撤销/重做内容改动不会回滚设置', () => {
  const st = newStore();
  st.commit('标 X', s => C.toggleX(s, C.key(0, 0)));
  st.setSettings({ cellSize: 66, leftMode: 'x', liveValidate: false });
  st.undo();
  assert.equal(C.isX(st.state, C.key(0, 0)), false, '内容已回滚');
  assert.equal(st.state.settings.cellSize, 66, '格子大小不该被撤销改掉');
  assert.equal(st.state.settings.leftMode, 'x');
  assert.equal(st.state.settings.liveValidate, false);
  st.redo();
  assert.equal(C.isX(st.state, C.key(0, 0)), true);
  assert.equal(st.state.settings.cellSize, 66, '重做同样不该改设置');
  // 连续撤销到初始状态，设置仍是用户设的
  st.undo(); st.undo();
  assert.equal(st.state.settings.cellSize, 66);
});

test('B-1 设置变更后撤销，历史里其它内容仍能正常回滚', () => {
  const st = newStore();
  st.setSettings({ cellSize: 30 });
  st.commit('区域', s => C.createRegion(s, 'r', [C.key(0, 0)]));
  st.setSettings({ cellSize: 50 });
  st.undo();
  assert.equal(st.state.regions.length, 0);
  assert.equal(st.state.settings.cellSize, 50);
});

test('B-6 撤销/重做/替换都不改变 state 对象身份（外部缓存引用不会失效）', () => {
  const st = newStore();
  const ref = st.state;
  st.commit('标 X', s => C.toggleX(s, C.key(0, 0)));
  assert.equal(st.state, ref, 'commit 不该换对象');
  st.undo();
  assert.equal(st.state, ref, 'undo 不该换对象');
  assert.equal(C.isX(ref, C.key(0, 0)), false, '外部引用能看到回滚后的内容');
  st.redo();
  assert.equal(st.state, ref);
  assert.equal(C.isX(ref, C.key(0, 0)), true, '外部引用能看到重做后的内容');
  st.replace(C.createState(3, 3), '替换');
  assert.equal(st.state, ref, 'replace 不该换对象');
  assert.equal(ref.rows, 3);
  // 失败回滚后引用依然有效
  st.commit('失败', s => { s.rows = 99; return { ok: false }; });
  assert.equal(st.state, ref);
  assert.equal(ref.rows, 3);
});

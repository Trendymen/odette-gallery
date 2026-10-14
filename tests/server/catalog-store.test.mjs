import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCatalog } from '../../src/server/catalog.mjs';
import { createSelectionStore } from '../../src/server/selection-store.mjs';

async function fixture(t, ids = ['a', 'b']) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, 'manifest.json'), exclusionsPath = path.join(dir, 'exclusions.json');
  const stateFile = path.join(dir, 'state/custom.json');
  const catalog = () => readCatalog({ manifestPath, exclusionsPath });
  const policy = excluded => fs.writeFile(exclusionsPath, JSON.stringify({ excluded: excluded.map(id => ({ id })) }));
  await fs.writeFile(manifestPath, JSON.stringify(ids.map(id => ({ id })))); await policy([]);
  return { dir, stateFile, catalog, policy, manifestPath, exclusionsPath, store: createSelectionStore({ stateFile, readCatalog: catalog }) };
}

test('目录减去排除项，内容改变改变签名，坏目录拒绝', async t => {
  const f = await fixture(t); const first = await f.catalog();
  await f.policy(['b', 'removed']); const next = await f.catalog();
  assert.deepEqual([...next.allowedIds], ['a']); assert.deepEqual([...next.excludedIds], ['b', 'removed']);
  assert.notEqual(first.catalogRevision, next.catalogRevision);
  for (const value of [{}, [{ id: 'a' }, { id: 'a' }], [{ id: 'bad/id' }]]) {
    await fs.writeFile(f.manifestPath, JSON.stringify(value)); await assert.rejects(f.catalog());
  }
  await fs.writeFile(f.manifestPath, '[{"id":"a"}]');
  for (const value of ['{bad', '{"excluded":{}}', '{"excluded":[{"id":" a"}]}', '{"excluded":[{"id":"a"},{"id":"a"}]}']) {
    await fs.writeFile(f.exclusionsPath, value); await assert.rejects(f.catalog());
  }
});
test('首次GET持久创建空revision0，重建读取选择，相同值幂等', async t => {
  const f = await fixture(t); const empty = await f.store.get();
  assert.equal(empty.revision, 0); assert.deepEqual(empty.selectedIds, []);
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, []);
  const saved = await f.store.set('a', true); assert.equal(saved.revision, 1);
  assert.deepEqual((await createSelectionStore({ stateFile: f.stateFile, readCatalog: f.catalog }).get()).selectedIds, ['a']);
  assert.deepEqual(await f.store.set('a', true), saved);
});
test('100个不同ID并发持久保存不丢选择', async t => {
  const ids = Array.from({ length: 100 }, (_, i) => 'id_' + i), f = await fixture(t, ids);
  await Promise.all(ids.map(id => f.store.set(id, true)));
  const state = await f.store.get(); assert.equal(state.revision, 100); assert.equal(state.selectedIds.length, 100);
  assert.deepEqual(new Set(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds), new Set(ids));
});
test('目录签名变化即使选择不变也递增revision，清理排除及删除ID', async t => {
  const f = await fixture(t); await f.store.get(); await f.policy(['removed']);
  const state = await f.store.get(); assert.equal(state.revision, 1); assert.deepEqual(state.selectedIds, []);
  await f.store.set('a', true); await f.store.set('b', true); await f.policy(['a']);
  await fs.writeFile(f.manifestPath, '[{"id":"a"}]');
  const cleaned = await f.store.get(); assert.equal(cleaned.revision, 4); assert.deepEqual(cleaned.selectedIds, []);
  await assert.rejects(f.store.set('a', true), { status: 410 }); await assert.rejects(f.store.set('unknown', true), { status: 404 });
});
test('GET与PUT包含目录读取共用事务队列', async t => {
  const f = await fixture(t); const old = await f.catalog(); await f.policy(['b']); const latest = await f.catalog();
  let release, count = 0; const gate = new Promise(r => { release = r; });
  const store = createSelectionStore({ stateFile: f.stateFile, readCatalog: async () => { count++; if (count === 1) { await gate; return old; } return latest; } });
  const first = store.get(), second = store.get(); await new Promise(r => setTimeout(r, 20)); assert.equal(count, 1); release();
  assert.equal((await first).revision, 0); const newer = await second; assert.equal(newer.revision, 1); assert.deepEqual(newer.allowedIds, ['a']);
});
test('坏JSON或schema不覆盖，目录不可读不清空旧状态', async t => {
  const f = await fixture(t); await f.store.set('a', true); const original = await fs.readFile(f.stateFile, 'utf8');
  await fs.writeFile(f.manifestPath, '{bad'); await assert.rejects(f.store.get(), { status: 503 }); assert.equal(await fs.readFile(f.stateFile, 'utf8'), original);
  await fs.writeFile(f.manifestPath, '[{"id":"a"}]');
  for (const bad of ['{bad', JSON.stringify({ ...JSON.parse(original), schemaVersion: 2 })]) {
    await fs.writeFile(f.stateFile, bad); await assert.rejects(f.store.get(), { status: 500 }); assert.equal(await fs.readFile(f.stateFile, 'utf8'), bad);
  }
});
test('临时写入及rename失败保持旧文件，恢复后可重试', async t => {
  const f = await fixture(t); await f.store.get(); const original = await fs.readFile(f.stateFile, 'utf8');
  for (const operation of ['open', 'rename']) {
    let fail = true;
    const fsOps = { ...fs, [operation]: async (...args) => { if (fail && (operation === 'rename' || String(args[0]).includes('.tmp-'))) throw new Error('injected failure'); return fs[operation](...args); } };
    const store = createSelectionStore({ stateFile: f.stateFile, readCatalog: f.catalog, fsOps });
    await assert.rejects(store.set('a', true), { status: 500 }); assert.equal(await fs.readFile(f.stateFile, 'utf8'), original);
    fail = false; assert.deepEqual((await store.set('a', true)).selectedIds, ['a']); await f.store.set('a', false);
    await fs.writeFile(f.stateFile, original);
  }
});
test('文件写入或fsync失败不替换原状态，重试恢复', async t => {
  const f = await fixture(t); await f.store.get(); const original = await fs.readFile(f.stateFile, 'utf8');
  for (const method of ['writeFile', 'sync']) {
    let fail = true;
    const fsOps = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      if (String(args[0]).includes('.tmp-')) return { writeFile: (...values) => { if (fail && method === 'writeFile') throw new Error('write failed'); return handle.writeFile(...values); }, sync: () => { if (fail && method === 'sync') throw new Error('sync failed'); return handle.sync(); }, close: () => handle.close() };
      return handle;
    } };
    const store = createSelectionStore({ stateFile: f.stateFile, readCatalog: f.catalog, fsOps });
    await assert.rejects(store.set('a', true), { status: 500 }); assert.equal(await fs.readFile(f.stateFile, 'utf8'), original);
    fail = false; assert.deepEqual((await store.set('a', true)).selectedIds, ['a']); await fs.writeFile(f.stateFile, original);
  }
});
test('rename后目录open或sync失败，同值PUT及GET继续报错直到持久确认', async t => {
  for (const method of ['open', 'sync']) {
    const f = await fixture(t); await f.store.get(); let fail = true;
    const fsOps = { ...fs, open: async (...args) => {
      if (args[0] === path.dirname(f.stateFile) && fail && method === 'open') throw new Error('directory open failed');
      const handle = await fs.open(...args);
      if (args[0] === path.dirname(f.stateFile)) return { sync: () => { if (fail) throw new Error('directory sync failed'); return handle.sync(); }, close: () => handle.close() };
      return handle;
    } };
    const store = createSelectionStore({ stateFile: f.stateFile, readCatalog: f.catalog, fsOps });
    await assert.rejects(store.set('a', true), { status: 500 });
    const replaced = await fs.readFile(f.stateFile, 'utf8'); assert.deepEqual(JSON.parse(replaced).selectedIds, ['a']); assert.equal(JSON.parse(replaced).revision, 1);
    await assert.rejects(store.set('a', true), { status: 500 }); await assert.rejects(store.get(), { status: 500 });
    const rebuilt = createSelectionStore({ stateFile: f.stateFile, readCatalog: f.catalog, fsOps }); await assert.rejects(rebuilt.get(), { status: 500 });
    assert.equal(await fs.readFile(f.stateFile, 'utf8'), replaced);
    fail = false; assert.equal((await store.set('a', true)).revision, 1); assert.deepEqual((await store.get()).selectedIds, ['a']); assert.equal((await rebuilt.get()).revision, 1);
  }
});
test('删除标记独立持久markedIds，重建恢复且不修改定制选择', async t => {
  const f = await fixture(t); await f.store.set('a', true); const selected = await fs.readFile(f.stateFile, 'utf8');
  const stateFile = path.join(path.dirname(f.stateFile), 'deletion-marks.json');
  const marks = createSelectionStore({ stateFile, readCatalog: f.catalog, idsField: 'markedIds' });
  assert.deepEqual((await marks.get()).markedIds, []); assert.equal((await marks.get()).revision, 0);
  await Promise.all(['a', 'b'].map(id => marks.set(id, true))); assert.deepEqual((await marks.get()).markedIds, ['a', 'b']);
  assert.deepEqual((await createSelectionStore({ stateFile, readCatalog: f.catalog, idsField: 'markedIds' }).get()).markedIds, ['a', 'b']);
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), selected); assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).selectedIds, undefined);
  await marks.set('a', false); assert.deepEqual((await marks.get()).markedIds, ['b']);
  await f.policy(['b']); assert.deepEqual((await marks.get()).markedIds, []); await assert.rejects(marks.set('b', true), { status: 410 });
  const broken = '{broken'; await fs.writeFile(stateFile, broken); await assert.rejects(marks.get(), { status: 500 }); assert.equal(await fs.readFile(stateFile, 'utf8'), broken);
});

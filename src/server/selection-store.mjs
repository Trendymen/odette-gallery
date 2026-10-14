import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validId } from './catalog.mjs';

const galleryKey = 'odette_mousepad_updated';
const failure = (status, message, cause) => Object.assign(new Error(message, { cause }), { status });

export function createSelectionStore({ stateFile, readCatalog, fsOps = fs, idsField = 'selectedIds' }) {
  if (!['selectedIds', 'markedIds'].includes(idsField)) throw new Error('不支持的状态集合');
  const title = idsField === 'markedIds' ? '删除标记' : '定制候选';
  let queue = Promise.resolve();
  async function syncDirectory() {
    try {
      const dir = await fsOps.open(path.dirname(stateFile), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch (error) { throw failure(500, title + '保存失败，请重试', error); }
  }
  async function persist(state) {
    const directory = path.dirname(stateFile), temporary = stateFile + '.tmp-' + randomUUID();
    let handle;
    try {
      await fsOps.mkdir(directory, { recursive: true });
      handle = await fsOps.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = undefined;
      await fsOps.rename(temporary, stateFile);
      await syncDirectory();
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fsOps.rm(temporary, { force: true }).catch(() => {});
      throw failure(500, title + '保存失败，请重试', error);
    }
  }
  async function transaction(id, selected) {
    let catalog;
    try { catalog = await readCatalog(); } catch (error) { throw failure(503, '作品目录暂时不可用，请重试', error); }
    let state, missing = false;
    try { state = JSON.parse(await fsOps.readFile(stateFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure(500, title + '状态无法读取，请检查状态文件', error);
      missing = true;
      state = { schemaVersion: 1, galleryKey, revision: 0, catalogRevision: catalog.catalogRevision, updatedAt: new Date().toISOString(), [idsField]: [] };
    }
    if (state?.schemaVersion !== 1 || state.galleryKey !== galleryKey || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
        typeof state.catalogRevision !== 'string' || !state.catalogRevision || typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt)) ||
        !Array.isArray(state[idsField]) || state[idsField].some(id => !validId(id)) || new Set(state[idsField]).size !== state[idsField].length) {
      throw failure(500, title + '状态格式无效，请检查状态文件');
    }
    const chosen = new Set(state[idsField].filter(value => catalog.allowedIds.has(value)));
    const catalogChanged = state.catalogRevision !== catalog.catalogRevision || chosen.size !== state[idsField].length;
    if (id !== undefined) {
      if (!validId(id) || typeof selected !== 'boolean') throw failure(400, '作品ID或选择参数无效');
      if (catalog.excludedIds.has(id)) throw failure(410, '该作品已排除');
      if (!catalog.allowedIds.has(id)) throw failure(404, '未找到该作品');
      if (selected) chosen.add(id); else chosen.delete(id);
    }
    const selectionChanged = chosen.size !== state[idsField].length || [...chosen].some(value => !state[idsField].includes(value));
    if (catalogChanged || selectionChanged) {
      if (state.revision === Number.MAX_SAFE_INTEGER) throw failure(500, title + '版本号已超出范围');
      state = { ...state, revision: state.revision + 1, catalogRevision: catalog.catalogRevision, updatedAt: new Date().toISOString(), [idsField]: [...chosen].sort() };
    }
    if (missing || catalogChanged || selectionChanged) await persist(state);
    else await syncDirectory();
    return { ...state, [idsField]: [...state[idsField]], allowedIds: [...catalog.allowedIds].sort() };
  }
  function enqueue(id, selected) {
    const next = queue.then(() => transaction(id, selected));
    queue = next.catch(() => {});
    return next;
  }
  return { get: () => enqueue(), set: (id, selected) => enqueue(id, selected) };
}

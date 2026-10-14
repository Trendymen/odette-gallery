export function createCustomSelectionClient({ artworks, resource = 'custom-candidates' }) {
  if (!['custom-candidates', 'deletion-marks'].includes(resource)) throw new Error('不支持的状态集合');
  const idsField = resource === 'deletion-marks' ? 'markedIds' : 'selectedIds';
  const requestField = resource === 'deletion-marks' ? 'marked' : 'selected';
  const title = resource === 'deletion-marks' ? '删除标记' : '定制候选';
  const endpoint = '/api/' + resource;
  const known = new Set(artworks.map(item => String(item.id)));
  const listeners = new Set(), intents = new Map(), running = new Map();
  const deniedIds = new Set();
  let permissionEpoch = 0;
  let confirmed = new Set(), allowed = new Set(known), revision = -1, catalogRevision = null, ready = false, readError = null, serial = 0;
  const enabled = location.protocol === 'http:' || location.protocol === 'https:';
  let channel = null;
  function openChannel() {
    if (channel || !enabled || typeof BroadcastChannel !== 'function') return;
    channel = new BroadcastChannel('odette-' + resource);
    channel.addEventListener('message', () => { refresh(); });
  }

  function getSnapshot() {
    const local = new Set([...confirmed].filter(id => known.has(id) && allowed.has(id)));
    for (const [id, intent] of intents) if (allowed.has(id) && known.has(id)) { if (intent.selected) local.add(id); else local.delete(id); }
    const failures = [...intents].filter(([, intent]) => intent.error);
    const error = [readError, failures[0]?.[1].error].filter(Boolean).join('；') || null;
    return { [idsField]: [...local], allowedIds: [...allowed].filter(id => known.has(id)), ready, revision, catalogRevision,
      pendingIds: [...intents].filter(([, intent]) => !intent.error).map(([id]) => id), failedIds: failures.map(([id]) => id),
      error: !enabled ? '请启动本地服务后使用' + title : error };
  }
  const emit = () => { for (const listener of listeners) listener(getSnapshot()); };
  async function request(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : title + '请求失败'), { status: response.status });
    return data;
  }
  function accept(data, startedEpoch) {
    const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)) && new Set(ids).size === ids.length;
    if (data?.schemaVersion !== 1 || data.galleryKey !== 'odette_mousepad_updated' || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
        typeof data.catalogRevision !== 'string' || !data.catalogRevision || !validIds(data.allowedIds) || !validIds(data[idsField]) || data[idsField].some(id => !data.allowedIds.includes(id))) throw new Error(title + '响应格式无效');
    if (data.revision < revision) return;
    if (data.revision === revision && catalogRevision !== data.catalogRevision) throw new Error(title + '目录版本冲突');
    if (startedEpoch === permissionEpoch) deniedIds.clear();
    revision = data.revision; catalogRevision = data.catalogRevision;
    allowed = new Set(data.allowedIds.filter(id => !deniedIds.has(id))); confirmed = new Set(data[idsField].filter(id => allowed.has(id))); ready = true;
    for (const [id, intent] of intents) if (!allowed.has(id) && (!intent.error || startedEpoch === permissionEpoch)) intents.delete(id);
  }
  async function refresh() {
    if (!enabled) return;
    const startedRevision = revision;
    const startedEpoch = permissionEpoch;
    try { accept(await request(endpoint), startedEpoch); readError = null; }
    catch (error) { if (revision === startedRevision) readError = '读取失败：' + error.message; }
    emit();
  }
  function save(id) {
    if (running.has(id)) return running.get(id);
    const work = (async () => {
      while (intents.has(id) && !intents.get(id).error) {
        const sent = intents.get(id);
        const startedEpoch = permissionEpoch;
        try {
          const data = await request(endpoint + '/' + encodeURIComponent(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [requestField]: sent.selected }) });
          accept(data, startedEpoch);
          readError = null;
          if (intents.get(id)?.serial === sent.serial) intents.delete(id);
          else if (intents.has(id) && intents.get(id).selected === confirmed.has(id)) intents.delete(id);
          try { channel?.postMessage({ revision }); } catch { channel?.close(); channel = null; }
        } catch (error) {
          const terminal = error.status === 410 || error.status === 404;
          if (terminal) { deniedIds.add(id); allowed.delete(id); permissionEpoch++; }
          const current = intents.get(id);
          if (current && (terminal || current.serial === sent.serial)) current.error = '未保存：' + error.message;
        }
        emit();
      }
    })().finally(() => { running.delete(id); emit(); });
    running.set(id, work);
    return work;
  }
  function toggle(id, selected) {
    id = String(id);
    if (!enabled || !known.has(id) || !allowed.has(id) || typeof selected !== 'boolean') return;
    intents.set(id, { selected, serial: ++serial, error: null }); emit(); save(id);
  }
  async function flush() {
    const unsaved = message => Object.assign(new Error(message), { resource });
    if (!enabled) throw unsaved('请启动本地服务后使用' + title);
    while (running.size) await Promise.all([...running.values()]);
    if (!ready) await initial;
    if (!ready || readError) throw unsaved(getSnapshot().error ?? title + '尚未读取');
    while (running.size) await Promise.all([...running.values()]);
    const failed = getSnapshot().error;
    if (failed || intents.size) throw unsaved(failed ?? title + '尚未保存');
  }
  async function retry() {
    await refresh();
    if (!ready || readError) return;
    for (const [id, intent] of intents) { intent.error = null; save(id); }
    emit();
    await Promise.all([...running.values()]);
  }
  openChannel();
  window.addEventListener('focus', () => { refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pagehide', () => { channel?.close(); channel = null; });
  window.addEventListener('pageshow', event => { if (event.persisted) { openChannel(); refresh(); } });
  const initial = refresh();
  return { subscribe(listener) { listeners.add(listener); listener(getSnapshot()); return () => listeners.delete(listener); }, toggle, retry, flush, getSnapshot };
}

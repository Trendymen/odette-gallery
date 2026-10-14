import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles, exists, fingerprint } from './files.mjs';

export async function discoverSources({ currentRoot, originalRoot }) {
  const sources = [];
  for (const [collection, root] of [['current-session', currentRoot], ['original-session', originalRoot]]) {
    const work = path.join(root, 'work');
    if (!await exists(work)) continue;
    for (const file of await listFiles(work)) {
      const relative = path.relative(work, file);
      if (!/\.json$/i.test(relative)) continue;
      if ((collection === 'current-session' && /^x-supplement\//.test(relative)) || /all-review-ready|available.*original|original.*available|official.*source|source.*official/.test(relative)) sources.push({ originalAbsolutePath: file, collection, originalRelativePath: 'work/' + relative });
    }
  }
  for (const name of ['official-sources.json', 'manifest.json']) {
    const source = path.join(currentRoot, 'outputs/odette_mousepad_updated', name);
    if (await exists(source)) sources.push({ originalAbsolutePath: source, collection: 'current-session', originalRelativePath: 'outputs/odette_mousepad_updated/' + name });
  }
  for (const source of sources) Object.assign(source, await fingerprint(source.originalAbsolutePath));
  return sources;
}

export async function sourceLookup(sources) {
  const byPath = new Map(), byId = new Map();
  function add(map, key, record) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(record);
  }
  for (const source of sources) {
    let data;
    try { data = JSON.parse(await fs.readFile(source.originalAbsolutePath, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; continue; }
    function visit(value, pointer, inherited = {}) {
      if (!value || typeof value !== 'object') return;
      let context = inherited;
      if (!Array.isArray(value)) {
        const id = value.id ?? (value.mediaId ? 'x_' + value.mediaId : inherited.artworkId);
        const urls = [...new Set([...(inherited.sourceURLs ?? []), ...Object.entries(value).filter(([key, url]) => /source|url|post|link/i.test(key) && typeof url === 'string' && /^https?:\/\//.test(url)).map(([, url]) => url)])];
        const record = { sourceRecord: source.originalAbsolutePath + '#' + pointer, artworkId: id === undefined ? null : String(id), sourceURLs: urls };
        context = record;
        add(byId, record.artworkId, record);
        for (const [key, file] of Object.entries(value)) if (typeof file === 'string') {
          if (path.isAbsolute(file)) add(byPath, file, record);
          else if (['original', 'cropped', 'preview', 'frame'].includes(key) && !/^https?:\/\//.test(file)) add(byPath, path.resolve(path.dirname(source.originalAbsolutePath), file), record);
        }
      }
      for (const [key, child] of Object.entries(value)) visit(child, pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), context);
    }
    visit(data, '');
  }
  return (absolutePath, ids = []) => {
    const matches = [...(byPath.get(absolutePath) ?? []), ...ids.flatMap(id => byId.get(id) ?? [])];
    const sourceRecords = [...new Set(matches.map(x => x.sourceRecord))], sourceURLs = [...new Set(matches.flatMap(x => x.sourceURLs))];
    return { sourceRecords, sourceURLs, sourceStatus: sourceRecords.length || sourceURLs.length ? 'known' : 'unknown', artworkIds: [...new Set(matches.map(x => x.artworkId).filter(Boolean))] };
  };
}

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);

export async function readCatalog({ manifestPath, exclusionsPath }) {
  const [manifest, policy] = await Promise.all([
    readFile(manifestPath, 'utf8').then(JSON.parse), readFile(exclusionsPath, 'utf8').then(JSON.parse)
  ]);
  function ids(records) {
    if (!Array.isArray(records)) throw new Error('作品目录必须是数组');
    const result = new Set();
    for (const record of records) {
      if (!validId(record?.id) || result.has(record.id)) throw new Error('作品ID非法或重复');
      result.add(record.id);
    }
    return result;
  }
  const manifestIds = ids(manifest), excludedIds = ids(policy?.excluded);
  const allowedIds = new Set([...manifestIds].filter(id => !excludedIds.has(id)).sort());
  const catalogRevision = createHash('sha256').update(JSON.stringify({ manifest, policy })).digest('hex');
  return { allowedIds, excludedIds, catalogRevision };
}

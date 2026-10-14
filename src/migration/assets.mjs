import fs from 'node:fs/promises';
import path from 'node:path';
import { relativeFile, fingerprint, verifyFingerprint, inside } from './files.mjs';

export function collectAssets(manifest) {
  if (!Array.isArray(manifest)) throw new Error('manifest 必须是数组');
  const assets = new Map();
  for (const item of manifest) for (const variant of [item, ...(item.versions ?? []), ...(item.variants ?? [])]) {
    for (const kind of ['original', 'cropped', 'preview', 'frame']) {
      if (variant[kind] === undefined) continue;
      const relative = relativeFile(variant[kind]);
      if (!assets.has(relative)) assets.set(relative, { originalRelativePath: relative, artworkIds: [], sourceURLs: [] });
      const record = assets.get(relative), url = variant.source ?? item.source;
      if (!record.artworkIds.includes(item.id)) record.artworkIds.push(item.id);
      if (typeof url === 'string' && /^https?:\/\//.test(url) && !record.sourceURLs.includes(url)) record.sourceURLs.push(url);
    }
  }
  return [...assets.values()].sort((a, b) => a.originalRelativePath.localeCompare(b.originalRelativePath));
}
export async function verifyAssets(root) {
  const manifestPath = path.join(root, 'data/gallery/manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const inventory = collectAssets(manifest);
  const index = JSON.parse(await fs.readFile(path.join(root, 'data/provenance/assets.json'), 'utf8'));
  if (!Array.isArray(index.files) || index.files.length !== inventory.length) throw new Error('图片索引集合不一致');
  const indexed = new Map(index.files.map(record => [record.originalRelativePath, record]));
  if (indexed.size !== inventory.length) throw new Error('图片索引路径重复');
  for (const asset of inventory) {
    const record = indexed.get(asset.originalRelativePath);
    if (!record || record.projectRelativePath !== 'public/gallery/' + asset.originalRelativePath) throw new Error('图片索引路径不一致');
    await verifyFingerprint(path.join(root, relativeFile(record.projectRelativePath)), record);
  }
  await verifyFingerprint(manifestPath, index.manifest);
  await verifyFingerprint(path.join(root, 'data/policies/exclusions.json'), index.policy);
  const staged = JSON.parse(await fs.readFile(path.join(root, 'data/provenance/stage.json'), 'utf8'));
  for (const record of staged.files) {
    const file = path.resolve(root, relativeFile(record.projectRelativePath));
    if (!inside(root, file)) throw new Error('索引路径越界');
    await verifyFingerprint(file, record);
  }
  return { artworks: manifest.length, versions: manifest.reduce((sum, item) => sum + Math.max(1, item.versions?.length ?? 0), 0), images: inventory.length, stagedFiles: staged.files.length, manifest: await fingerprint(manifestPath) };
}

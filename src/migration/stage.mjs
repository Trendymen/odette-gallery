import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { projectPaths } from '../project-paths.mjs';
import { readCatalog } from '../server/catalog.mjs';
import { collectAssets } from './assets.mjs';
import { validateRoots, listFiles, fingerprint, writeJSON, copyVerified, exists, assertNoSymlink } from './files.mjs';
import { discoverSources, sourceLookup } from './sources.mjs';

export async function stageProject(options) {
  await validateRoots(options);
  const { currentRoot, projectRoot } = options, paths = projectPaths(projectRoot);
  const delivery = path.join(currentRoot, 'outputs/odette_mousepad_updated');
  const manifestPath = path.join(delivery, 'manifest.json'), exclusionsPath = path.join(currentRoot, 'work/male-pair-filter/exclusions.json');
  await assertNoSymlink(currentRoot, manifestPath);
  await assertNoSymlink(currentRoot, exclusionsPath);
  await readCatalog({ manifestPath, exclusionsPath });
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const inventory = collectAssets(manifest), assetPaths = new Set(inventory.map(x => x.originalRelativePath));
  const deliveryFiles = await listFiles(delivery), sources = await discoverSources(options), lookup = await sourceLookup(sources);
  const manifestHash = await fingerprint(manifestPath), policyHash = await fingerprint(exclusionsPath);
  const verificationPath = path.join(delivery, 'verification.json');
  const verification = await exists(verificationPath) ? JSON.parse(await fs.readFile(verificationPath, 'utf8')) : null;
  const files = [], assets = [];
  for (const asset of inventory) {
    const originalAbsolutePath = path.join(delivery, asset.originalRelativePath), hash = await fingerprint(originalAbsolutePath);
    const expected = verification?.files?.[asset.originalRelativePath];
    if (verification && (!expected || expected.bytes !== hash.bytes || expected.sha256 !== hash.sha256)) throw new Error('交付图片指纹不一致：' + asset.originalRelativePath);
    const provenance = lookup(originalAbsolutePath, asset.artworkIds);
    const metadata = await sharp(originalAbsolutePath).metadata();
    assets.push({ ...asset, ...provenance, dimensions: { width: metadata.width, height: metadata.height }, artworkIds: asset.artworkIds, sourceURLs: [...new Set([...asset.sourceURLs, ...provenance.sourceURLs])], originalAbsolutePath, projectRelativePath: 'public/gallery/' + asset.originalRelativePath, collection: 'active-gallery', ...hash });
  }
  for (const originalAbsolutePath of deliveryFiles) {
    const relative = path.relative(delivery, originalAbsolutePath);
    if (assetPaths.has(relative) || /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|svg)$/i.test(relative)) continue;
    files.push({ originalAbsolutePath, projectRelativePath: 'data/gallery/' + relative, collection: 'current-session', ...await fingerprint(originalAbsolutePath) });
  }
  files.push({ originalAbsolutePath: exclusionsPath, projectRelativePath: 'data/policies/exclusions.json', collection: 'current-session', ...policyHash });
  for (const source of sources) files.push({ ...source, projectRelativePath: 'data/provenance/sources/' + source.collection + '/' + source.originalRelativePath });
  const publicFiles = files.filter(record => record.projectRelativePath.startsWith('data/gallery/')).flatMap(record => {
    const relative = record.projectRelativePath.slice('data/gallery/'.length);
    return /\.html$/i.test(relative) || relative === 'manifest.json' ? [] : [{ ...record, projectRelativePath: 'public/gallery/' + relative }];
  });
  const copies = [...assets, ...files, ...publicFiles];
  for (const record of copies) await assertNoSymlink(projectRoot, path.join(projectRoot, record.projectRelativePath));
  await assertNoSymlink(projectRoot, paths.provenanceDirectory);
  await assertNoSymlink(projectRoot, paths.galleryDirectory);
  for (const record of copies) await copyVerified(record.originalAbsolutePath, path.join(projectRoot, record.projectRelativePath), record);
  await writeJSON(path.join(paths.provenanceDirectory, 'assets.json'), { manifest: manifestHash, policy: policyHash, files: assets });
  await writeJSON(path.join(paths.provenanceDirectory, 'stage.json'), { files });
  await writeJSON(path.join(paths.provenanceDirectory, 'sources.json'), { files: sources.map(source => ({ ...source, projectRelativePath: 'data/provenance/sources/' + source.collection + '/' + source.originalRelativePath })) });
  return { artworks: manifest.length, versions: manifest.reduce((sum, item) => sum + Math.max(1, item.versions?.length ?? 0), 0), images: assets.length, stagedFiles: files.length };
}

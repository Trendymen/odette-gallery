import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { collectAssets, verifyAssets } from '../../src/migration/assets.mjs';
import { fingerprint } from '../../src/migration/files.mjs';
test('资源并集合并共享文件并包括 versions/variants 历史文件，拒绝越界', () => {
  assert.deepEqual(collectAssets([{ id: 'a', original: 'o.png', versions: [{ preview: 'p.jpg' }, { original: 'o.png' }], variants: [{ frame: 'history.jpg' }] }]).map(x => x.originalRelativePath), ['history.jpg', 'o.png', 'p.jpg']);
  for (const value of ['../a', '/tmp/a', 'a/../b', 'a\\b', 'a\0b']) assert.throws(() => collectAssets([{ id: 'a', original: value }]), /路径/);
});
test('资源校验检出缺失、改字节和索引集合错误', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odette-verify-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['data/gallery', 'data/policies', 'data/provenance', 'public/gallery']) await fs.mkdir(path.join(root, dir), { recursive: true });
  const manifest = path.join(root, 'data/gallery/manifest.json'), policy = path.join(root, 'data/policies/exclusions.json'), image = path.join(root, 'public/gallery/o.png');
  await fs.writeFile(manifest, '[{"id":"a","original":"o.png"}]'); await fs.writeFile(policy, '{"excluded":[]}');
  await sharp({ create: { width: 14, height: 8, channels: 3, background: '#254063' } }).png().toFile(image);
  const index = { manifest: await fingerprint(manifest), policy: await fingerprint(policy), files: [{ originalRelativePath: 'o.png', projectRelativePath: 'public/gallery/o.png', ...await fingerprint(image) }] };
  await fs.writeFile(path.join(root, 'data/provenance/assets.json'), JSON.stringify(index)); await fs.writeFile(path.join(root, 'data/provenance/stage.json'), '{"files":[]}');
  assert.equal((await verifyAssets(root)).images, 1);
  await fs.writeFile(image, 'modified'); await assert.rejects(verifyAssets(root), /指纹不一致/);
  await fs.unlink(image); await assert.rejects(verifyAssets(root), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'data/provenance/assets.json'), JSON.stringify({ ...index, files: [] })); await assert.rejects(verifyAssets(root), /集合不一致/);
});

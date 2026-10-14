import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const project = path.resolve(import.meta.dirname, '../..');
async function fixture(t, manifest, policy = { excluded: [] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odette-generate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['data/gallery', 'data/policies', 'state/odette_mousepad_updated']) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'data/gallery/manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, 'data/policies/exclusions.json'), typeof policy === 'string' ? policy : JSON.stringify(policy));
  await fs.writeFile(path.join(root, 'state/odette_mousepad_updated/custom-candidates.json'), 'current state');
  const result = spawnSync(process.execPath, [path.join(project, 'scripts/generate-gallery.mjs'), '--project-root', root], { cwd: os.tmpdir(), encoding: 'utf8' });
  return { root, result };
}
const item = id => ({ id, number: 1, title: id, score: { total: 90 }, original: 'missing.png', preview: 'missing.jpg', cropped: 'missing-crop.png', frame: 'missing-frame.jpg', crop: { width: 1400, height: 800 } });
test('生成只过滤政策排除项，不读取排除图片，不改 canonical 或 state', async t => {
  const manifest = [item('keep'), { ...item('hidden'), styleReview: { defaultVisible: false } }, item('excluded')];
  const f = await fixture(t, manifest, { excluded: [{ id: 'excluded' }] }); assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(await fs.readFile(path.join(f.root, 'data/gallery/manifest.json'), 'utf8'), JSON.stringify(manifest));
  assert.equal(await fs.readFile(path.join(f.root, 'state/odette_mousepad_updated/custom-candidates.json'), 'utf8'), 'current state');
  for (const file of ['index.html', 'all-candidates.html', 'thumbnails.html']) { const html = await fs.readFile(path.join(f.root, 'public/gallery', file), 'utf8'); assert.ok(!html.includes('"id":"excluded"')); assert.ok(html.includes('"id":"hidden"')); }
});
for (const [name, manifest, policy] of [
  ['损坏策略', [item('keep')], '{bad'], ['缺少 excluded 数组', [item('keep')], {}],
  ['排除 ID 空白', [item('keep')], { excluded: [{ id: ' bad ' }] }],
  ['重复 ID', [item('keep'), item('keep')], { excluded: [] }], ['非法 ID', [item('../bad')], { excluded: [] }]
]) test('生成失败关闭：' + name, async t => {
  const f = await fixture(t, manifest, policy); assert.notEqual(f.result.status, 0); assert.doesNotMatch(f.result.stderr, /MODULE_NOT_FOUND/); await assert.rejects(fs.stat(path.join(f.root, 'public/gallery/index.html')), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const project = path.resolve(import.meta.dirname, '../..');
const cli = path.join(project, 'scripts/migrate-project.mjs');
const json = (file, value) => fs.writeFile(file, JSON.stringify(value));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odette-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const currentRoot = path.join(root, 'current'), originalRoot = path.join(root, 'original'), projectRoot = path.join(root, 'project');
  const delivery = path.join(currentRoot, 'outputs/odette_mousepad_updated');
  for (const dir of [delivery, path.join(currentRoot, 'work/male-pair-filter'), path.join(originalRoot, 'work'), path.join(originalRoot, 'outputs'), projectRoot]) await fs.mkdir(dir, { recursive: true });
  const item = { id: 'a', number: 1, source: 'https://example.test/a', original: 'o.png', cropped: 'c.png', preview: 'p.jpg', frame: 'f.jpg', versions: [{ preview: 'history.jpg' }] };
  for (const file of ['o.png', 'c.png', 'p.jpg', 'f.jpg', 'history.jpg']) await sharp({ create: { width: 14, height: 8, channels: 3, background: '#254063' } }).toFile(path.join(delivery, file));
  await fs.writeFile(path.join(delivery, 'index.html'), 'original HTML');
  await fs.writeFile(path.join(delivery, 'notes.txt'), '原文');
  await fs.writeFile(path.join(originalRoot, 'work/unknown.jpg'), '未知来源');
  await fs.mkdir(path.join(currentRoot, 'work/x-supplement'));
  await json(path.join(currentRoot, 'work/x-supplement/downloads.json'), [{ id: 'a', source: item.source, path: path.join(delivery, 'o.png') }]);
  await json(path.join(delivery, 'manifest.json'), [item]);
  await json(path.join(currentRoot, 'work/male-pair-filter/exclusions.json'), { excluded: [] });
  const run = mode => spawnSync(process.execPath, [cli, mode, '--current-root', currentRoot, '--original-root', originalRoot, '--project-root', projectRoot], { cwd: os.tmpdir(), encoding: 'utf8' });
  return { currentRoot, originalRoot, projectRoot, delivery, item, run };
}
test('stage 保留 canonical 原文、历史版本并集、非图片层次且不修改源', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.delivery, 'manifest.json'));
  const result = f.run('stage'); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readFile(path.join(f.projectRoot, 'data/gallery/manifest.json')), before);
  assert.deepEqual(await fs.readFile(path.join(f.delivery, 'manifest.json')), before);
  assert.deepEqual(await fs.readFile(path.join(f.projectRoot, 'public/gallery/history.jpg')), await fs.readFile(path.join(f.delivery, 'history.jpg')));
  assert.equal(await fs.readFile(path.join(f.projectRoot, 'data/gallery/notes.txt'), 'utf8'), '原文');
  assert.equal(await fs.readFile(path.join(f.delivery, 'index.html'), 'utf8'), 'original HTML');
  const index = JSON.parse(await fs.readFile(path.join(f.projectRoot, 'data/provenance/assets.json')));
  assert.equal(index.files.length, 5); assert.ok(index.files.every(x => x.sha256 && x.bytes > 0));
  assert.deepEqual(index.files.find(x => x.originalRelativePath === 'history.jpg').dimensions, { width: 14, height: 8 });
  assert.ok(index.files.find(x => x.originalRelativePath === 'o.png').sourceRecords.length);
});
test('stage 拒绝图片路径越界且不写 canonical', async t => {
  const f = await fixture(t); await json(path.join(f.delivery, 'manifest.json'), [{ ...f.item, preview: '../outside.jpg' }]);
  const result = f.run('stage'); assert.notEqual(result.status, 0); assert.match(result.stderr, /路径/);
  await assert.rejects(fs.stat(path.join(f.projectRoot, 'data/gallery/manifest.json')), { code: 'ENOENT' });
});
test('stage 非图片 public 目录上级链接在任何复制前拒绝，工程外没有新增文件', async t => {
  const f = await fixture(t), outside = path.join(f.originalRoot, 'outside');
  await fs.mkdir(path.join(f.delivery, 'reports')); await fs.writeFile(path.join(f.delivery, 'reports/notes.txt'), '非图片资料原文');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'existing.txt'), '保留原文');
  await fs.mkdir(path.join(f.projectRoot, 'public/gallery'), { recursive: true });
  await fs.symlink(outside, path.join(f.projectRoot, 'public/gallery/reports'));
  const result = f.run('stage');
  assert.deepEqual(await fs.readdir(outside), ['existing.txt']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /符号链接/);
  assert.equal(await fs.readFile(path.join(outside, 'existing.txt'), 'utf8'), '保留原文');
  await assert.rejects(fs.stat(path.join(f.projectRoot, 'data/gallery/manifest.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.projectRoot, 'public/gallery/o.png')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.delivery, 'reports/notes.txt'), 'utf8'), '非图片资料原文');
});
test('archive 原样保留资料、完整旧 delivery 和来源未知标记，建立兼容链接', async t => {
  const f = await fixture(t); const stage = f.run('stage'); assert.equal(stage.status, 0, stage.stderr);
  const result = f.run('archive'); assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(f.delivery, 'index.html'), 'utf8'), 'original HTML');
  assert.equal(await fs.readFile(path.join(f.originalRoot, 'work/unknown.jpg'), 'utf8'), '未知来源');
  assert.ok((await fs.lstat(path.join(f.currentRoot, 'work'))).isSymbolicLink());
  const index = JSON.parse(await fs.readFile(path.join(f.projectRoot, 'data/provenance/archive.json')));
  const unknown = index.files.find(x => x.originalAbsolutePath.endsWith('/unknown.jpg'));
  assert.equal(unknown.sourceStatus, 'unknown'); assert.deepEqual(unknown.sourceURLs, []);
  assert.equal(index.files.find(x => x.originalAbsolutePath.endsWith('/index.html')).sha256.length, 64);
  const history = index.files.find(x => x.originalAbsolutePath.endsWith('/history.jpg'));
  assert.deepEqual(history.artworkIds, ['a']); assert.ok(history.sourceURLs.includes('https://example.test/a'));
});
test('archive 全量预检目标冲突，在任何搬运前拒绝', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.projectRoot, 'archive/original-session/work'), { recursive: true });
  const result = f.run('archive'); assert.notEqual(result.status, 0); assert.match(result.stderr, /冲突/);
  assert.ok((await fs.lstat(path.join(f.currentRoot, 'work'))).isDirectory());
});
test('archive 拒绝未知符号链接，在任何搬运前拒绝', async t => {
  const f = await fixture(t); await fs.symlink(f.delivery, path.join(f.originalRoot, 'work/unknown-link'));
  const result = f.run('archive'); assert.notEqual(result.status, 0); assert.match(result.stderr, /符号链接/);
  assert.ok((await fs.lstat(path.join(f.currentRoot, 'work'))).isDirectory());
});
test('archive 拒绝目标上级符号链接，避免写到工程之外', async t => {
  const f = await fixture(t), outside = path.join(f.originalRoot, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.projectRoot, 'archive'));
  const result = f.run('archive'); assert.notEqual(result.status, 0); assert.match(result.stderr, /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []); assert.ok((await fs.lstat(path.join(f.currentRoot, 'work'))).isDirectory());
});
test('archive 拒绝根目录符号链接，避免根重叠绕过', async t => {
  const f = await fixture(t), link = path.join(path.dirname(f.currentRoot), 'alias'); await fs.symlink(f.currentRoot, link);
  const result = spawnSync(process.execPath, [cli, 'archive', '--current-root', link, '--original-root', f.originalRoot, '--project-root', f.projectRoot], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /符号链接/); assert.ok((await fs.lstat(path.join(f.currentRoot, 'work'))).isDirectory());
});
test('archive 搬运失败保留源和可恢复记录，不建立未经核验的链接', async t => {
  const f = await fixture(t);
  const { archiveProject } = await import('../../src/migration/archive.mjs');
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (from === path.join(f.currentRoot, 'work')) throw Object.assign(new Error('模拟跨卷失败'), { code: 'EXDEV' }); return rename(from, to); };
  try { await assert.rejects(archiveProject(f), /模拟跨卷失败/); } finally { fs.rename = rename; }
  assert.ok((await fs.lstat(path.join(f.currentRoot, 'work'))).isDirectory());
  const journal = JSON.parse(await fs.readFile(path.join(f.projectRoot, 'data/provenance/archive-recovery.json')));
  assert.equal(journal.operations[0].status, 'pending'); assert.match(journal.operations[0].error, /模拟跨卷失败/); assert.ok(journal.files.every(file => file.sha256 && file.bytes >= 0));
});
test('archive 拒绝 outputs 上级链接，不搬运外部目录中的文件', async t => {
  const f = await fixture(t), outside = path.join(f.originalRoot, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  const outputs = path.join(f.currentRoot, 'outputs'); await fs.rm(outputs, { recursive: true }); await fs.symlink(outside, outputs);
  const result = f.run('archive'); assert.notEqual(result.status, 0); assert.match(result.stderr, /符号链接/);
  assert.equal(await fs.readFile(path.join(outside, 'private.txt'), 'utf8'), 'private'); assert.ok((await fs.lstat(path.join(f.currentRoot, 'work'))).isDirectory());
});

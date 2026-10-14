import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createGalleryServer } from '../../src/server/server.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-http-')), galleryDirectory = path.join(dir, 'gallery');
  await fs.mkdir(galleryDirectory); await fs.writeFile(path.join(galleryDirectory, 'thumbnails.html'), '<h1>画廊</h1>');
  await fs.writeFile(path.join(galleryDirectory, 'image.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  await fs.writeFile(path.join(galleryDirectory, 'manifest.json'), '[{"id":"a"},{"id":"b"}]');
  const exclusionsPath = path.join(dir, 'exclusions.json'), stateFile = path.join(dir, 'state/custom.json');
  await fs.writeFile(exclusionsPath, '{"excluded":[{"id":"excluded"}]}');
  const server = createGalleryServer({ galleryDirectory, stateFile, exclusionsPath });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = (pathname, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(origin, { path: pathname, method, headers }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
    req.on('error', reject); req.end(body);
  });
  const put = (id, selected, options = {}) => request('/api/custom-candidates/' + id, { method: 'PUT', headers: { origin, 'content-type': 'application/json', ...options.headers }, body: JSON.stringify({ selected }), ...options });
  return { dir, galleryDirectory, stateFile, exclusionsPath, server, origin, request, put };
}
test('首页、图片、HEAD与JSON MIME，页面和API不缓存', async t => {
  const f = await fixture(t); const home = await f.request('/'); assert.equal(home.status, 200); assert.match(home.body, /画廊/); assert.match(home.headers['content-type'], /text\/html/); assert.equal(home.headers['cache-control'], 'no-store');
  assert.equal((await f.request('/image.jpg')).headers['content-type'], 'image/jpeg');
  assert.equal((await f.request('/image.jpg', { method: 'HEAD' })).body, '');
  assert.match((await f.request('/manifest.json')).headers['content-type'], /application\/json/);
  assert.equal((await f.request('/missing')).status, 404);
});
test('GET及增量PUT持久保存，重启服务恢复', async t => {
  const f = await fixture(t); const first = await f.request('/api/custom-candidates'); assert.equal(first.status, 200); assert.equal(first.headers['cache-control'], 'no-store'); assert.equal(JSON.parse(first.body).revision, 0);
  const saved = await f.put('a', true); assert.equal(saved.status, 200); assert.deepEqual(JSON.parse(saved.body).selectedIds, ['a']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).selectedIds, ['a']);
  const second = createGalleryServer({ galleryDirectory: f.galleryDirectory, stateFile: f.stateFile, exclusionsPath: f.exclusionsPath }); second.listen(0, '127.0.0.1'); await once(second, 'listening');
  try { assert.deepEqual((await fetch('http://127.0.0.1:' + second.address().port + '/api/custom-candidates').then(r => r.json())).selectedIds, ['a']); }
  finally { second.closeAllConnections(); await new Promise(r => second.close(r)); }
});
test('非法参数400、未知404、排除410、超大413、损坏状态500、目录503', async t => {
  const f = await fixture(t);
  for (const body of ['{}', '{"selected":1}', '{"selected":true,"extra":1}', '{bad', 'null']) assert.equal((await f.request('/api/custom-candidates/a', { method: 'PUT', headers: { origin: f.origin, 'content-type': 'application/json' }, body })).status, 400);
  assert.equal((await f.put('bad%2Fid', true)).status, 400); assert.equal((await f.put('unknown', true)).status, 404); assert.equal((await f.put('excluded', true)).status, 410);
  assert.equal((await f.put('a', true, { body: ' '.repeat(4097) })).status, 413);
  assert.equal((await f.put('a', true, { headers: { origin: f.origin, 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, body: ' '.repeat(4097) })).status, 413);
  await f.put('a', true); const original = await fs.readFile(f.stateFile, 'utf8');
  await fs.writeFile(path.join(f.galleryDirectory, 'manifest.json'), '{bad'); assert.equal((await f.request('/api/custom-candidates')).status, 503); assert.equal(await fs.readFile(f.stateFile, 'utf8'), original);
  await fs.writeFile(path.join(f.galleryDirectory, 'manifest.json'), '[{"id":"a"}]'); await fs.writeFile(f.stateFile, '{broken');
  assert.equal((await f.request('/api/custom-candidates')).status, 500); assert.equal(await fs.readFile(f.stateFile, 'utf8'), '{broken');
});
test('拒绝跨站Origin、非法Host、非JSON及错误方法', async t => {
  const f = await fixture(t);
  assert.equal((await f.put('a', true, { headers: { origin: 'http://evil.example', 'content-type': 'application/json' } })).status, 403);
  assert.equal((await f.request('/api/custom-candidates', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await f.put('a', true, { headers: { origin: f.origin, 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await f.put('a', true, { headers: { 'content-type': 'application/json' } })).status, 403);
  for (const [pathname, method] of [['/api/custom-candidates', 'POST'], ['/api/custom-candidates/a', 'GET'], ['/', 'PUT']]) assert.equal((await f.request(pathname, { method })).status, 405);
});
test('拒绝原始与编码路径穿越、非法编码、越界符号链接', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.dir, 'private.txt'), 'private'); await fs.symlink(path.join(f.dir, 'private.txt'), path.join(f.galleryDirectory, 'leak.txt'));
  for (const pathname of ['/../private.txt', '/%2e%2e/private.txt', '/%2e%2e%2fprivate.txt', '/%ZZ', '/%00', '/..%5cprivate.txt', '/leak.txt']) {
    const response = await f.request(pathname); assert.ok([400, 403].includes(response.status), pathname + ' ' + response.status); assert.ok(!response.body.includes('private'));
  }
});
test('指定临时端口被占用时退出，不重试其他端口', async t => {
  const blocker = http.createServer();
  blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const port = blocker.address().port;
  t.after(() => new Promise(r => blocker.close(r)));
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../src/server/start.mjs'), '--port', String(port), '--state-directory', os.tmpdir()]); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit'); assert.equal(code, 1); assert.ok(output.includes(String(port))); assert.ok(!output.includes('http://'));
});
test('删除标记API增量独立保存、重启恢复，校验沿用原安全边界', async t => {
  const f = await fixture(t); await f.put('a', true); const selected = await fs.readFile(f.stateFile, 'utf8');
  const marks = (id, body, headers = { origin: f.origin, 'content-type': 'application/json' }) => f.request('/api/deletion-marks/' + id, { method: 'PUT', headers, body: JSON.stringify(body) });
  const initial = await f.request('/api/deletion-marks'); assert.equal(initial.status, 200); assert.deepEqual(JSON.parse(initial.body).markedIds, []);
  const save = await marks('a', { marked: true }); assert.equal(save.status, 200); assert.deepEqual(JSON.parse(save.body).markedIds, ['a']); assert.equal(JSON.parse(save.body).selectedIds, undefined);
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), selected);
  assert.equal((await marks('a', { selected: true })).status, 400); assert.equal((await marks('excluded', { marked: true })).status, 410); assert.equal((await marks('unknown', { marked: true })).status, 404);
  assert.equal((await marks('a', { marked: true }, { origin: 'http://evil.example', 'content-type': 'application/json' })).status, 403);
  assert.equal((await f.request('/api/deletion-marks/a', { method: 'DELETE' })).status, 405);
  const second = createGalleryServer({ galleryDirectory: f.galleryDirectory, stateFile: f.stateFile, exclusionsPath: f.exclusionsPath }); second.listen(0, '127.0.0.1'); await once(second, 'listening');
  try { assert.deepEqual((await fetch('http://127.0.0.1:' + second.address().port + '/api/deletion-marks').then(r => r.json())).markedIds, ['a']); }
  finally { second.closeAllConnections(); await new Promise(r => second.close(r)); }
  assert.deepEqual(JSON.parse((await marks('a', { marked: false })).body).markedIds, []);
  const stateFile = path.join(path.dirname(f.stateFile), 'deletion-marks.json'); await fs.writeFile(stateFile, '{broken'); assert.equal((await f.request('/api/deletion-marks')).status, 500); assert.equal(await fs.readFile(stateFile, 'utf8'), '{broken');
});

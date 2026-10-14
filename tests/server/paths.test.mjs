import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { projectPaths, parseStartOptions } from '../../src/project-paths.mjs';
import { createGalleryServer } from '../../src/server/server.mjs';
test('项目路径由源码确定，启动参数仅允许指定端口及绝对状态目录', () => {
  const expected = path.resolve(import.meta.dirname, '../..'); assert.equal(projectPaths().root, expected);
  assert.equal(parseStartOptions([]).port, 58855);
  assert.equal(parseStartOptions(['--port', '0', '--state-directory', os.tmpdir()]).port, 0);
  assert.equal(parseStartOptions(['--port', '65535']).port, 65535);
  for (const args of [['--port', '-1'], ['--port', '65536'], ['--port', '1.2'], ['--port'], ['--state-directory', 'relative'], ['--host', 'localhost'], ['--port', '0', '--port', '1']]) assert.throws(() => parseStartOptions(args));
});
test('独立 canonical manifest 与 public 解耦，API 读取目录资格', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odette-canonical-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = projectPaths(root); await fs.mkdir(path.dirname(paths.manifestPath), { recursive: true }); await fs.mkdir(path.dirname(paths.exclusionsPath), { recursive: true }); await fs.mkdir(paths.galleryDirectory, { recursive: true });
  await fs.writeFile(paths.manifestPath, '[{"id":"a"}]'); await fs.writeFile(paths.exclusionsPath, '{"excluded":[]}');
  const server = createGalleryServer({ ...paths, stateFile: path.join(paths.stateDirectory, 'custom-candidates.json') }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/custom-candidates'); assert.equal(response.status, 200); assert.deepEqual((await response.json()).allowedIds, ['a']);
});
test('从其他 cwd 启动，输出临时实际端口，状态覆盖不接触正式状态', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'odette-start-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../src/server/start.mjs'), '--port', '0', '--state-directory', directory], { cwd: os.tmpdir() });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  const [chunk] = await once(child.stdout, 'data'); const url = chunk.toString().trim(); assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.notEqual(new URL(url).port, '58855');
  const response = await fetch(url); assert.equal(response.status, 200);
});

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function relativeFile(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').some(x => ['..', '.', ''].includes(x))) throw new Error('文件相对路径无效：' + value);
  return value;
}
export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
export async function exists(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function listFiles(root) {
  const result = [];
  async function visit(file) {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) throw new Error('拒绝未知符号链接：' + file);
    if (info.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    else if (info.isFile()) result.push(file);
    else throw new Error('文件类型不支持：' + file);
  }
  await visit(root);
  return result;
}
export async function fingerprint(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('需要普通文件：' + file);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest('hex') };
}
export async function verifyFingerprint(file, expected) {
  const actual = await fingerprint(file);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('文件指纹不一致：' + file);
}
export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file);
}
export async function copyVerified(source, destination, expected) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const old = await exists(destination);
  if (old) { await verifyFingerprint(destination, expected); return; }
  await fs.copyFile(source, destination, 1);
  await verifyFingerprint(destination, expected);
}
export async function assertNoSymlink(root, file = root) {
  if (!inside(root, file)) throw new Error('目标路径越界：' + file);
  const relative = path.relative(root, file);
  let current = root;
  for (const piece of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, piece);
    const info = await exists(current);
    if (info?.isSymbolicLink()) throw new Error('拒绝未知符号链接：' + current);
  }
}
export async function validateRoots({ currentRoot, originalRoot, projectRoot }) {
  for (const root of [currentRoot, originalRoot, projectRoot]) if (!root || !path.isAbsolute(root)) throw new Error('迁移根目录必须是绝对路径');
  const roots = [currentRoot, originalRoot, projectRoot].map(root => path.resolve(root));
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) if (inside(roots[i], roots[j]) || inside(roots[j], roots[i])) throw new Error('迁移根目录不能重叠');
  for (const root of roots) await assertNoSymlink(root);
  const actualRoots = await Promise.all(roots.map(root => fs.realpath(root)));
  for (let i = 0; i < actualRoots.length; i++) for (let j = i + 1; j < actualRoots.length; j++) if (inside(actualRoots[i], actualRoots[j]) || inside(actualRoots[j], actualRoots[i])) throw new Error('实际迁移根目录不能重叠');
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRoots, exists, listFiles, fingerprint, verifyFingerprint, writeJSON, assertNoSymlink } from './files.mjs';
import { discoverSources, sourceLookup } from './sources.mjs';

export async function archiveProject(options) {
  await validateRoots(options);
  const { currentRoot, originalRoot, projectRoot } = options;
  const operations = [];
  const add = (source, destination, collection) => operations.push({ source, destination, collection, status: 'pending' });
  add(path.join(currentRoot, 'work'), path.join(projectRoot, 'archive/current-session/work'), 'current-session');
  const outputs = path.join(currentRoot, 'outputs');
  await assertNoSymlink(currentRoot, outputs);
  if (await exists(outputs)) for (const name of (await fs.readdir(outputs)).sort()) add(path.join(outputs, name), path.join(projectRoot, 'archive/current-session', name === 'odette_mousepad_updated' ? 'delivery-extra' : 'outputs/' + name), 'current-session');
  for (const name of ['work', 'outputs']) add(path.join(originalRoot, name), path.join(projectRoot, 'archive/original-session', name), 'original-session');
  const active = [];
  for (const operation of operations) {
    if (!await exists(operation.source)) continue;
    await assertNoSymlink(operation.collection === 'current-session' ? currentRoot : originalRoot, operation.source);
    await assertNoSymlink(projectRoot, operation.destination);
    if (await exists(operation.destination)) throw new Error('归档目标冲突：' + operation.destination);
    operation.files = await listFiles(operation.source);
    active.push(operation);
  }
  const lookup = await sourceLookup(await discoverSources(options));
  const files = [];
  for (const operation of active) for (const file of operation.files) files.push({ originalAbsolutePath: file, projectRelativePath: path.relative(projectRoot, path.join(operation.destination, path.relative(operation.source, file))), collection: operation.collection, ...await fingerprint(file), ...lookup(file) });
  const journalPath = path.join(projectRoot, 'data/provenance/archive-recovery.json');
  await assertNoSymlink(projectRoot, journalPath);
  const journal = { operations: active.map(({ files: ignored, ...operation }) => operation), files };
  if (await exists(journalPath)) throw new Error('归档恢复记录已存在，请先核对上次操作');
  await writeJSON(journalPath, journal);
  for (const operation of journal.operations) {
    await fs.mkdir(path.dirname(operation.destination), { recursive: true });
    try {
      await fs.rename(operation.source, operation.destination);
      operation.status = 'moved'; await writeJSON(journalPath, journal);
      const expected = files.filter(file => file.originalAbsolutePath === operation.source || file.originalAbsolutePath.startsWith(operation.source + path.sep));
      const actual = await listFiles(operation.destination);
      if (actual.length !== expected.length) throw new Error('归档文件集合不一致：' + operation.destination);
      for (const record of expected) await verifyFingerprint(path.join(projectRoot, record.projectRelativePath), record);
      operation.status = 'verified'; await writeJSON(journalPath, journal);
      await fs.symlink(path.relative(path.dirname(operation.source), operation.destination), operation.source);
      operation.status = 'linked'; await writeJSON(journalPath, journal);
    } catch (error) {
      operation.error = error.message; await writeJSON(journalPath, journal); throw error;
    }
  }
  await writeJSON(path.join(projectRoot, 'data/provenance/archive.json'), { files, operations: journal.operations });
  return { archivedFiles: files.length, linkedLocations: journal.operations.length };
}

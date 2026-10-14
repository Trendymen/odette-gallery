import fs from 'node:fs/promises';
import path from 'node:path';
import { projectPaths } from '../src/project-paths.mjs';
import { readCatalog } from '../src/server/catalog.mjs';
import { writeScoredGallery } from '../src/gallery/render-scored-gallery.mjs';

export async function generateGallery(root) {
  const paths = projectPaths(root);
  const { allowedIds } = await readCatalog(paths);
  const items = JSON.parse(await fs.readFile(paths.manifestPath, 'utf8')).filter(item => allowedIds.has(item.id));
  const counts = await writeScoredGallery({ items, outputDirectory: paths.galleryDirectory });
  for (const name of ['scores.csv', 'README.txt']) {
    const source = path.join(root, 'data/gallery', name);
    try { await fs.copyFile(source, path.join(paths.galleryDirectory, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return counts;
}

if (process.argv[1] === import.meta.filename) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--project-root')) throw new Error('生成参数无效');
    const paths = projectPaths(args[1]);
    console.log(JSON.stringify(await generateGallery(paths.root)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

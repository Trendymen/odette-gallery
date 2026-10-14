import { projectRoot } from '../src/project-paths.mjs';
import { stageProject } from '../src/migration/stage.mjs';
import { archiveProject } from '../src/migration/archive.mjs';

try {
  const [mode, ...args] = process.argv.slice(2);
  if (!['stage', 'archive'].includes(mode)) throw new Error('迁移阶段必须是 stage 或 archive');
  const options = { projectRoot }, seen = new Set();
  const keys = { '--current-root': 'currentRoot', '--original-root': 'originalRoot', '--project-root': 'projectRoot' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!keys[key] || !value || seen.has(key)) throw new Error('迁移参数无效');
    seen.add(key); options[keys[key]] = value;
  }
  console.log(JSON.stringify(await (mode === 'stage' ? stageProject : archiveProject)(options)));
} catch (error) { console.error(error.message); process.exitCode = 1; }

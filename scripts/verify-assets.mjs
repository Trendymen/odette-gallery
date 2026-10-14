import { projectRoot } from '../src/project-paths.mjs';
import { verifyAssets } from '../src/migration/assets.mjs';
try { console.log(JSON.stringify(await verifyAssets(projectRoot))); }
catch (error) { console.error(error.message); process.exitCode = 1; }

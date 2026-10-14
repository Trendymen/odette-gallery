import path from 'node:path';

export const projectRoot = path.resolve(import.meta.dirname, '..');
export function projectPaths(root = projectRoot) {
  if (!path.isAbsolute(root)) throw new Error('工程根目录必须是绝对路径');
  return {
    root,
    galleryDirectory: path.join(root, 'public/gallery'),
    manifestPath: path.join(root, 'data/gallery/manifest.json'),
    exclusionsPath: path.join(root, 'data/policies/exclusions.json'),
    stateDirectory: path.join(root, 'state/odette_mousepad_updated'),
    provenanceDirectory: path.join(root, 'data/provenance')
  };
}

export function parseStartOptions(args, root = projectRoot) {
  const paths = projectPaths(root);
  let port = 58855, stateDirectory = paths.stateDirectory;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i], value = args[i + 1];
    if (!['--port', '--state-directory'].includes(option) || value === undefined || seen.has(option)) throw new Error('启动参数无效');
    seen.add(option);
    if (option === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('端口必须是 0..65535 的整数');
      port = Number(value);
    } else {
      if (!path.isAbsolute(value)) throw new Error('状态目录必须是绝对路径');
      stateDirectory = path.resolve(value);
    }
  }
  return { ...paths, port, stateFile: path.join(stateDirectory, 'custom-candidates.json'), deletionStateFile: path.join(stateDirectory, 'deletion-marks.json') };
}

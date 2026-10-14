import { createGalleryServer } from './server.mjs';
import { parseStartOptions } from '../project-paths.mjs';

try {
  const options = parseStartOptions(process.argv.slice(2));
  const server = createGalleryServer(options);
  server.once('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `127.0.0.1:${options.port} 已被占用，请先关闭原服务。` : '画廊服务启动失败：' + error.message);
    process.exitCode = 1;
  });
  server.listen(options.port, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port + '/'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

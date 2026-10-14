import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readCatalog, validId } from './catalog.mjs';
import { createSelectionStore } from './selection-store.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

export function createGalleryServer({ galleryDirectory, stateFile, exclusionsPath, manifestPath = path.join(galleryDirectory, 'manifest.json'), deletionStateFile = path.join(path.dirname(stateFile), 'deletion-marks.json') }) {
  const root = path.resolve(galleryDirectory);
  if (path.resolve(stateFile) === path.resolve(deletionStateFile)) throw new Error('两份状态文件必须使用不同路径');
  const catalog = () => readCatalog({ manifestPath, exclusionsPath });
  const resources = {
    'custom-candidates': { store: createSelectionStore({ stateFile, readCatalog: catalog }), field: 'selected' },
    'deletion-marks': { store: createSelectionStore({ stateFile: deletionStateFile, readCatalog: catalog, idsField: 'markedIds' }), field: 'marked' }
  };
  return http.createServer(async (req, res) => {
    function json(status, value) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    }
    try {
      const port = req.socket.localPort, host = req.headers.host;
      if (!host || !['127.0.0.1:' + port, 'localhost:' + port].includes(host)) fail(403, '仅允许本机访问');
      const rawPath = req.url.split('?')[0]; let pathname;
      try { pathname = decodeURIComponent(rawPath); } catch { fail(400, '路径编码无效'); }
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(piece => piece === '..')) fail(400, '路径无效');
      const route = pathname.match(/^\/api\/(custom-candidates|deletion-marks)(?:\/(.*))?$/);
      const resource = route && resources[route[1]];
      if (resource && route[2] === undefined) {
        if (req.method !== 'GET') fail(405, '请求方法不支持');
        json(200, await resource.store.get()); return;
      }
      if (resource) {
        if (req.method !== 'PUT') fail(405, '请求方法不支持');
        const id = route[2];
        if (!validId(id)) fail(400, '作品ID无效');
        if (req.headers.origin !== 'http://' + host || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) fail(403, '需要同源请求');
        if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) fail(400, '需要JSON请求');
        if (Number(req.headers['content-length']) > 4096) { req.resume(); fail(413, '请求内容过大'); }
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 4096) { req.resume(); fail(413, '请求内容过大'); } chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'JSON格式无效'); }
        if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body[resource.field] !== 'boolean') fail(400, '仅允许' + resource.field + '布尔参数');
        json(200, await resource.store.set(id, body[resource.field])); return;
      }
      if (pathname.startsWith('/api/')) fail(404, '接口不存在');
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, '请求方法不支持');
      const resolved = path.resolve(root, '.' + (pathname === '/' ? '/thumbnails.html' : pathname));
      if (!inside(root, resolved)) fail(403, '路径越界');
      let actual, actualRoot;
      try { [actual, actualRoot] = await Promise.all([fs.realpath(resolved), fs.realpath(root)]); }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail(404, '文件不存在'); throw error; }
      if (!inside(actualRoot, actual)) fail(403, '路径越界');
      const handle = await fs.open(actual, 'r');
      try {
        const info = await handle.stat(); if (!info.isFile()) fail(404, '文件不存在');
        const type = mime[path.extname(actual).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'x-content-type-options': 'nosniff', ...(type.startsWith('text/html') ? { 'cache-control': 'no-store' } : {}) });
        res.end(req.method === 'HEAD' ? undefined : await handle.readFile());
      } finally { await handle.close(); }
    } catch (error) {
      if (!res.headersSent) json(error.status ?? 500, { error: error.status ? error.message : '画廊服务读取失败，请重试' });
      else res.destroy(error);
    }
  });
}

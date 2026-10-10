/*! Mudorku Helper — 本地静态服务器（零依赖，仅用 Node 内置模块）
 *
 *   npm run serve          # 默认 http://localhost:8123
 *   node scripts/serve.js 9000
 *
 * 只用于本地预览：本项目本身不需要服务器，直接双击 index.html 也能跑。
 * 这里提供服务器只是为了方便局域网/移动端访问，或用更严格的浏览器策略测试。
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8123);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

async function resolveTarget(urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = path.resolve(ROOT, '.' + rel);
  // 防目录穿越：解析后的路径必须仍在项目目录内
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  let stat;
  try { stat = await fsp.stat(target); } catch (e) { return null; }
  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    try {
      const st2 = await fsp.stat(index);
      if (st2.isFile()) return index;
    } catch (e) { /* 没有 index */ }
    return null;
  }
  return stat.isFile() ? target : null;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const target = await resolveTarget(req.url || '/');
  if (!target) {
    return send(res, 404, '404 Not Found: ' + req.url, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': (await fsp.stat(target)).size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，换一个：node scripts/serve.js 9000');
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('Murdoku 助手 → http://' + HOST + ':' + PORT + '/');
  console.log('(根目录 ' + ROOT + '，Ctrl+C 停止)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}

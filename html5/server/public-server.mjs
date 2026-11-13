// Раздача готовой сборки (html5/dist) удалённым игрокам через туннель: сжатие без потерь (brotli/gzip), кэш в браузере
// и тот же WebSocket-мост на /bridge, что в vite.config.ts (хост принудительно 127.0.0.1, порты только 1212 и 1213).
// Запуск: cd html5; npx vite build; node server/public-server.mjs  (порт 5180, как у Vite — туннель на него и смотрит).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT ?? 5180);
// HOST=0.0.0.0 — страница и /bridge доступны из локальной сети (мост всё равно пускает только к 127.0.0.1:1212/1213)
const HOST = process.env.HOST ?? '127.0.0.1';
const BRIDGE_PORT = 5181;
const ALLOWED_PORTS = new Set(['1212', '1213']);
// /ws2 — новый сервер server2 (TypeScript, протокол v2), см. server2/README.md
const SERVER2_PORT = Number(process.env.SERVER2_PORT ?? 5290);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
};
/** уже сжатые форматы: повторное сжатие ничего не даёт */
const SKIP_COMPRESSION = new Set(['.png', '.jpg', '.webp', '.mp3', '.ogg', '.woff2', '.gz', '.zip']);

/** файл -> { mtime, raw, br, gzip } (сжатое считается один раз при первом запросе) */
const cache = new Map();

function load(file, stat) {
  let entry = cache.get(file);
  if (!entry || entry.mtime != stat.mtimeMs) {
    entry = { mtime: stat.mtimeMs, raw: fs.readFileSync(file), br: null, gzip: null, etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"` };
    cache.set(file, entry);
  }
  return entry;
}

function serve(request, response) {
  const url = new URL(request.url ?? '/', 'http://x');
  let relative = decodeURIComponent(url.pathname);
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.resolve(ROOT, '.' + relative);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end('not found');
    return;
  }
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const entry = load(file, stat);
  const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', ETag: entry.etag, Vary: 'Accept-Encoding' };
  if (relative.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'; // имена с хешем
  else if (ext == '.html') headers['Cache-Control'] = 'no-cache';
  else headers['Cache-Control'] = 'public, max-age=3600';
  if (request.headers['if-none-match'] == entry.etag) {
    response.writeHead(304, headers).end();
    return;
  }
  let body = entry.raw;
  const accept = String(request.headers['accept-encoding'] ?? '');
  if (!SKIP_COMPRESSION.has(ext) && body.length > 1024) {
    if (accept.includes('br')) {
      entry.br ??= zlib.brotliCompressSync(entry.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } });
      body = entry.br;
      headers['Content-Encoding'] = 'br';
    } else if (accept.includes('gzip')) {
      entry.gzip ??= zlib.gzipSync(entry.raw, { level: 9 });
      body = entry.gzip;
      headers['Content-Encoding'] = 'gzip';
    }
  }
  headers['Content-Length'] = body.length;
  response.writeHead(200, headers);
  response.end(request.method == 'HEAD' ? undefined : body);
}

const server = http.createServer(serve);

/** проброс WebSocket-запроса на локальный порт: тот же upgrade с другим путём и Host, дальше — байты как есть */
function pipeUpgrade(request, socket, head, port, target, extraHeaders = []) {
  const upstream = net.connect(port, '127.0.0.1', () => {
    const lines = [`GET ${target} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i];
      if (name.toLowerCase() == 'x-forwarded-for') continue;
      lines.push(`${name}: ${name.toLowerCase() == 'host' ? `127.0.0.1:${port}` : request.rawHeaders[i + 1]}`);
    }
    lines.push(...extraHeaders);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

/** /bridge: проброс WebSocket на мост, хост и порт ограничены; /ws2 — на server2, адрес игрока в X-Forwarded-For */
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://x');
  if (url.pathname == '/ws2') {
    pipeUpgrade(request, socket, head, SERVER2_PORT, '/ws2', [`X-Forwarded-For: ${socket.remoteAddress ?? ''}`]);
    return;
  }
  const port = url.searchParams.get('port') ?? '';
  if (url.pathname != '/bridge' || !ALLOWED_PORTS.has(port)) {
    socket.destroy();
    return;
  }
  pipeUpgrade(request, socket, head, BRIDGE_PORT, `/?host=127.0.0.1&port=${port}`);
});

server.listen(PORT, HOST, () =>
  console.log(`[public] http://${HOST}:${PORT}/ (${ROOT}) -> bridge ws://127.0.0.1:${BRIDGE_PORT}, server2 ws://127.0.0.1:${SERVER2_PORT}/ws2`),
);

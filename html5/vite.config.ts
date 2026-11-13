import { defineConfig } from 'vite';

// Порт не пересекается с Flash-частью: HTTP клиента там 8000, сервер 1212/1213.
// Порт не пересекается с Flash-частью: HTTP клиента там 8000, сервер 1212/1213.
// /bridge — тот же WebSocket-мост (5181), но для удалённых игроков через туннель: хост принудительно 127.0.0.1,
// порт только игровой (1212/1213), иначе мост стал бы открытым TCP-прокси в локальную сеть.
const ALLOWED_PORTS = new Set(['1212', '1213']);

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/bridge': {
        target: 'ws://127.0.0.1:5181',
        ws: true,
        rewrite: (path) => {
          const port = new URL(path, 'http://x').searchParams.get('port') ?? '';
          return `/?host=127.0.0.1&port=${ALLOWED_PORTS.has(port) ? port : '0'}`;
        },
      },
      // новый сервер server2 (протокол v2, server2/README.md)
      '/ws2': {
        target: 'ws://127.0.0.1:5290',
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

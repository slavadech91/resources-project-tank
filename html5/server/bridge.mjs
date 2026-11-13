/**
 * Мост WebSocket -> TCP для HTML5-клиента.
 *
 * Браузер не умеет открывать сырые TCP-соединения, а игровой сервер говорит
 * бинарным протоколом поверх TCP (1212 — главный канал, 1213 — каналы
 * пространств). Мост принимает WebSocket и проксирует байты один-в-один,
 * поэтому сервер трогать не нужно.
 *
 * Запуск:  node server/bridge.mjs [--port 5181] [--host 127.0.0.1]
 * Адрес подключения из клиента: ws://127.0.0.1:5181/?port=1212
 *
 * Реализация WebSocket (RFC 6455) своя, чтобы не тащить зависимости:
 * нужны только бинарные кадры, ping/pong и закрытие.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import net from 'node:net';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const PING_INTERVAL_MS = 15000;
const IDLE_TIMEOUT_MS = 45000;

function parseArgs(argv) {
  const options = { port: 5181, host: '127.0.0.1' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--host') options.host = argv[++index];
  }
  return options;
}

function frame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Разбор входящих кадров: браузер всегда маскирует данные. */
function createFrameParser(onMessage, onClose) {
  let pending = Buffer.alloc(0);
  let fragment = null;

  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const first = pending[0];
      const second = pending[1];
      const isFinal = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (pending.length < offset + 2) return;
        length = pending.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (pending.length < offset + 8) return;
        length = Number(pending.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (pending.length < offset + length) return;

      const payload = Buffer.from(pending.subarray(offset, offset + length));
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= pending[maskOffset + (index & 3)];
        }
      }
      pending = pending.subarray(offset + length);

      if (opcode === OPCODE.CLOSE) {
        onClose();
        return;
      }
      if (opcode === OPCODE.PING || opcode === OPCODE.PONG) continue;

      if (opcode === OPCODE.CONTINUATION) {
        if (!fragment) continue;
        fragment.parts.push(payload);
      } else {
        fragment = { opcode, parts: [payload] };
      }
      if (!isFinal || !fragment) continue;

      const whole = Buffer.concat(fragment.parts);
      fragment = null;
      onMessage(whole);
    }
  };
}

const options = parseArgs(process.argv.slice(2));

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  response.writeHead(426, { 'content-type': 'text/plain' });
  response.end('это WebSocket-мост, подключайтесь по ws://');
});

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const targetHost = url.searchParams.get('host') ?? '127.0.0.1';
  const targetPort = Number(url.searchParams.get('port') ?? 0);
  const key = request.headers['sec-websocket-key'];

  if (!key || !targetPort) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const tcp = net.connect({ host: targetHost, port: targetPort });
  tcp.setNoDelay(true);

  let closed = false;
  // браузер может пропасть без закрытия (туннель, сон, смена сети): тогда TCP к серверу жил вечно и танк игрока
  // оставался в бою. Раз в PING_INTERVAL_MS шлём PING (браузер отвечает PONG сам), без данных дольше IDLE_TIMEOUT_MS — закрываем
  let lastSeen = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_TIMEOUT_MS) {
      console.log(`[bridge] ${targetHost}:${targetPort} нет ответа от браузера, закрываю`);
      shutdown();
      return;
    }
    if (!socket.destroyed) socket.write(frame(OPCODE.PING, Buffer.alloc(0)));
  }, PING_INTERVAL_MS);
  const shutdown = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    tcp.destroy();
    socket.destroy();
  };

  socket.on('data', () => {
    lastSeen = Date.now();
  });
  socket.on(
    'data',
    createFrameParser(
      (payload) => {
        if (!tcp.destroyed) tcp.write(payload);
      },
      shutdown,
    ),
  );
  socket.on('close', shutdown);
  socket.on('error', shutdown);

  tcp.on('data', (chunk) => {
    if (!socket.destroyed) socket.write(frame(OPCODE.BINARY, chunk));
  });
  tcp.on('close', shutdown);
  tcp.on('error', () => {
    if (!socket.destroyed) socket.write(frame(OPCODE.CLOSE, Buffer.alloc(0)));
    shutdown();
  });

  console.log(`[bridge] ${targetHost}:${targetPort} подключено`);
});

server.listen(options.port, options.host, () => {
  console.log(`[bridge] ws://${options.host}:${options.port}/?port=1212 -> TCP 1212/1213`);
});

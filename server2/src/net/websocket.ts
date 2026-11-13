/**
 * Серверная сторона WebSocket (RFC 6455) без зависимостей — как `html5/server/bridge.mjs`, но с текстовыми кадрами,
 * проверками и ограничениями: кадры клиента обязаны быть маскированы, сообщение не больше maxMessageBytes, текст —
 * корректный UTF-8, ping раз в pingIntervalMs, без входящих данных idleTimeoutMs — закрытие, очередь отправки больше
 * maxBufferedBytes (клиент не успевает принимать) — закрытие.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_INVALID_DATA = 1007;
export const CLOSE_POLICY = 1008;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_INTERNAL = 1011;

export interface WebSocketLimits {
  maxMessageBytes: number;
  pingIntervalMs: number;
  idleTimeoutMs: number;
  maxBufferedBytes: number;
}

export const DEFAULT_LIMITS: WebSocketLimits = {
  maxMessageBytes: 64 * 1024,
  pingIntervalMs: 15000,
  idleTimeoutMs: 45000,
  maxBufferedBytes: 4 * 1024 * 1024,
};

function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  let header: Buffer;
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

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class WebSocketConnection {
  onText: (text: string) => void = () => {};
  onBinary: (data: Buffer) => void = () => {};
  onClose: (code: number, reason: string) => void = () => {};
  readonly remoteAddress: string;
  private readonly socket: Socket;
  private readonly limits: WebSocketLimits;
  private pending: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closed = false;
  private lastSeen = Date.now();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(socket: Socket, remoteAddress: string, limits: WebSocketLimits, head: Buffer = Buffer.alloc(0)) {
    this.socket = socket;
    this.remoteAddress = remoteAddress;
    this.limits = limits;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.lastSeen = Date.now();
      this.receive(chunk);
    });
    socket.on('close', () => this.finish(CLOSE_GOING_AWAY, 'соединение закрыто'));
    socket.on('error', () => this.finish(CLOSE_GOING_AWAY, 'ошибка сокета'));
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > limits.idleTimeoutMs) {
        this.close(CLOSE_GOING_AWAY, 'нет ответа');
        return;
      }
      this.sendFrame(OP_PING, Buffer.alloc(0));
    }, limits.pingIntervalMs);
    // байты, пришедшие вместе с запросом upgrade, — после того как владелец назначит обработчики
    if (head.length) queueMicrotask(() => this.receive(Buffer.from(head)));
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  sendText(text: string): void {
    this.sendFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  sendBinary(data: Uint8Array): void {
    this.sendFrame(OP_BINARY, data);
  }

  /** закрывающий кадр и разрыв; onClose вызывается один раз */
  close(code = CLOSE_NORMAL, reason = ''): void {
    if (this.closed) return;
    const text = Buffer.from(reason, 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    payload.set(text, 2);
    if (!this.socket.destroyed) this.socket.write(frame(OP_CLOSE, payload));
    this.finish(code, reason);
    this.socket.end();
    // не дождались закрытия от клиента — рвём
    setTimeout(() => this.socket.destroy(), 2000);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.pending = Buffer.alloc(0);
    this.fragments = [];
    this.onClose(code, reason);
  }

  private sendFrame(opcode: number, payload: Uint8Array): void {
    if (this.closed || this.socket.destroyed) return;
    if (this.socket.writableLength > this.limits.maxBufferedBytes) {
      this.close(CLOSE_POLICY, 'клиент не успевает принимать');
      return;
    }
    this.socket.write(frame(opcode, payload));
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (!this.closed) {
      const data = this.pending;
      if (data.length < 2) return;
      const first = data[0];
      const second = data[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if (first & 0x70) return this.close(CLOSE_PROTOCOL_ERROR, 'расширения не поддерживаются');
      if (!(second & 0x80)) return this.close(CLOSE_PROTOCOL_ERROR, 'кадр клиента без маски');
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (data.length < 4) return;
        length = data.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (data.length < 10) return;
        const big = data.readBigUInt64BE(2);
        if (big > BigInt(this.limits.maxMessageBytes)) return this.close(CLOSE_TOO_BIG, 'сообщение слишком большое');
        length = Number(big);
        offset = 10;
      }
      if (length > this.limits.maxMessageBytes) return this.close(CLOSE_TOO_BIG, 'сообщение слишком большое');
      if (data.length < offset + 4 + length) return;
      const mask = data.subarray(offset, offset + 4);
      const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.pending = data.subarray(offset + 4 + length);

      if (opcode >= 0x8) {
        if (!final || length > 125) return this.close(CLOSE_PROTOCOL_ERROR, 'неверный управляющий кадр');
        if (opcode === OP_CLOSE) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_NORMAL;
          if (!this.socket.destroyed) this.socket.write(frame(OP_CLOSE, payload.subarray(0, 2)));
          this.finish(code, 'закрыто клиентом');
          this.socket.end();
          return;
        }
        if (opcode === OP_PING) this.sendFrame(OP_PONG, payload);
        else if (opcode !== OP_PONG) return this.close(CLOSE_PROTOCOL_ERROR, 'неизвестный управляющий кадр');
        continue;
      }

      if (opcode === OP_CONTINUATION) {
        if (!this.fragments.length) return this.close(CLOSE_PROTOCOL_ERROR, 'продолжение без начала');
      } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (this.fragments.length) return this.close(CLOSE_PROTOCOL_ERROR, 'новое сообщение посреди фрагментов');
        this.fragmentOpcode = opcode;
        this.fragmentBytes = 0;
      } else {
        return this.close(CLOSE_PROTOCOL_ERROR, 'неизвестный кадр');
      }
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.limits.maxMessageBytes) return this.close(CLOSE_TOO_BIG, 'сообщение слишком большое');
      this.fragments.push(payload);
      if (!final) continue;
      const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
      this.fragments = [];
      if (this.fragmentOpcode === OP_TEXT) {
        let text: string;
        try {
          text = utf8.decode(message);
        } catch {
          return this.close(CLOSE_INVALID_DATA, 'текст не в UTF-8');
        }
        this.onText(text);
      } else {
        this.onBinary(message);
      }
    }
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** адрес клиента: за прокси public-server.mjs (127.0.0.1) — из X-Forwarded-For */
export function clientAddress(request: IncomingMessage): string {
  const direct = request.socket.remoteAddress ?? '';
  const loopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  const forwarded = header(request, 'x-forwarded-for').split(',')[0].trim();
  return loopback && forwarded ? forwarded : direct;
}

/** рукопожатие WebSocket; null — запрос не WebSocket (ответ 400 уже отправлен) */
export function acceptWebSocket(request: IncomingMessage, socket: Socket, head: Buffer, limits: WebSocketLimits = DEFAULT_LIMITS): WebSocketConnection | null {
  const key = header(request, 'sec-websocket-key');
  const upgrade = header(request, 'upgrade').toLowerCase();
  if (upgrade !== 'websocket' || header(request, 'sec-websocket-version') !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WebSocketConnection(socket, clientAddress(request), limits, head);
}

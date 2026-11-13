/**
 * Соединение с server2 (протокол v2, `protocol.ts`): запрос → обещание ответа, события сервера — подписка.
 * Работает в браузере и в Node 22+ (глобальный WebSocket) — им же пользуются smoke-тесты.
 */
import {
  PROTOCOL_VERSION,
  WS_PATH,
  type ErrorCode,
  type EventMessage,
  type EventName,
  type ReplyData,
  type RequestArgs,
  type RequestName,
} from './protocol.ts';

export class ServerError extends Error {
  readonly code: ErrorCode | 'timeout' | 'closed';

  constructor(code: ErrorCode | 'timeout' | 'closed', message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.code = code;
  }
}

interface Pending {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: ServerError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** адрес server2 рядом со страницей: тот же хост, путь /ws2 (прокси public-server.mjs и vite) */
export function defaultServerUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
}

export class Connection {
  /** закрытие соединения (сервер, сеть или close()) */
  onClose: ((code: number, reason: string) => void) | null = null;
  /** двоичный кадр боя (battleCodec.ts) */
  onBinary: ((data: Uint8Array) => void) | null = null;
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(message: never) => void>>();
  private nextId = 1;
  private closed = false;
  measureMessages = false;
  private messageCpuMs = 0;
  private messageCount = 0;
  private readonly drainedMessageTiming = { cpuMs: 0, count: 0 };
  serverName = '';

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      if (!this.measureMessages) {
        this.onMessage(event.data);
        return;
      }
      const start = performance.now();
      try {
        this.onMessage(event.data);
      } finally {
        this.messageCpuMs += performance.now() - start;
        this.messageCount++;
      }
    };
    ws.onclose = (event) => this.finish(event.code, event.reason);
  }

  drainMessageTiming(): { cpuMs: number; count: number } {
    const timing = this.drainedMessageTiming;
    timing.cpuMs = this.messageCpuMs;
    timing.count = this.messageCount;
    this.messageCpuMs = this.messageCount = 0;
    return timing;
  }

  /** открыть соединение и поздороваться (проверка версии протокола) */
  static connect(url: string, timeoutMs = 10000): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new ServerError('timeout', `нет соединения с ${url}`));
      }, timeoutMs);
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new ServerError('closed', `не удалось подключиться к ${url}`));
      };
      ws.onopen = () => {
        clearTimeout(timer);
        ws.onerror = null;
        const connection = new Connection(ws);
        connection.request('hello', { version: PROTOCOL_VERSION }).then(
          (reply) => {
            connection.serverName = reply.server;
            resolve(connection);
          },
          (error: unknown) => {
            connection.close();
            reject(error);
          },
        );
      };
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  request<K extends RequestName>(type: K, args: RequestArgs<K>, timeoutMs = 15000): Promise<ReplyData<K>> {
    if (this.closed) return Promise.reject(new ServerError('closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ServerError('timeout', type));
      }, timeoutMs);
      this.pending.set(id, { resolve: (data) => resolve(data as ReplyData<K>), reject, timer });
      this.ws.send(JSON.stringify({ ...args, t: type, id }));
    });
  }

  /** двоичный кадр боя; закрытое соединение — молча (бой сейчас остановится) */
  sendBinary(data: Uint8Array): void {
    if (!this.closed) this.ws.send(data);
  }

  /** байт в очереди отправки (снапшоты не копятся при медленной сети) */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /** подписка на событие сервера; возвращает отписку */
  on<K extends EventName>(type: K, listener: (message: EventMessage<K>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (message: never) => void);
    return () => set.delete(listener as (message: never) => void);
  }

  close(): void {
    if (this.closed) return;
    this.ws.close(1000);
    this.finish(1000, 'закрыто клиентом');
  }

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.onBinary?.(new Uint8Array(data));
      return;
    }
    if (typeof data !== 'string') return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.t === 'reply') {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message);
      else pending.reject(new ServerError(message.error as ErrorCode, message.message as string | undefined));
      return;
    }
    const set = this.listeners.get(message.t as string);
    if (set) for (const listener of [...set]) (listener as (message: unknown) => void)(message);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ServerError('closed', reason));
    }
    this.pending.clear();
    this.onClose?.(code, reason);
  }
}

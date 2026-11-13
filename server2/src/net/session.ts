/**
 * Соединение игрока: разбор JSON-сообщений протокола v2, порядок обработки (запросы одного игрока — строго по
 * очереди), ограничение частоты, ответы и события. Что делает каждый запрос — `handlers.ts`.
 */
import {
  PROTOCOL_VERSION,
  PUBLIC_REQUESTS,
  type EventMessage,
  type EventName,
  type Events,
  type KickReason,
  type RequestName,
  type UserInfo,
} from '../../../html5/src/net2/protocol.ts';
import type { App } from '../app.ts';
import { RequestError } from '../errors.ts';
import { handlers } from '../handlers.ts';
import { logError } from '../log.ts';
import { CLOSE_NORMAL, CLOSE_POLICY, CLOSE_PROTOCOL_ERROR, type WebSocketConnection } from './websocket.ts';

const RATE_PER_SECOND = 40;
const RATE_BURST = 120;
/** запросов в очереди одного игрока */
const MAX_QUEUED = 32;
/** двоичных кадров боя (состояние 20 Гц, пинги, повторы при смене управления) */
const FRAMES_PER_SECOND = 80;
const FRAMES_BURST = 200;

let nextSessionId = 1;

export class Session {
  readonly id = nextSessionId++;
  readonly ws: WebSocketConnection;
  private readonly app: App;
  user: UserInfo | null = null;
  helloDone = false;
  readonly knownPrivateBattles=new Set<number>();
  private tokens = RATE_BURST;
  private refilledAt = Date.now();
  private frameTokens = FRAMES_BURST;
  private framesRefilledAt = Date.now();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(app: App, ws: WebSocketConnection) {
    this.app = app;
    this.ws = ws;
    ws.onText = (text) => this.onText(text);
    ws.onBinary = (data) => this.onBinary(data);
    ws.onClose = () => app.removeSession(this);
  }

  get address(): string {
    return this.ws.remoteAddress;
  }

  get isOpen(): boolean {
    return this.ws.isOpen;
  }

  send<K extends EventName>(type: K, data: Events[K]): void {
    const message = { t: type, ...data } as EventMessage<K>;
    this.ws.sendText(JSON.stringify(message));
  }

  kick(reason: KickReason): void {
    this.send('kicked', { reason });
    this.ws.close(CLOSE_NORMAL, reason);
  }

  /** кадры боя (battleCodec.ts) — только после входа */
  private onBinary(data: Uint8Array): void {
    const now = Date.now();
    this.frameTokens = Math.min(FRAMES_BURST, this.frameTokens + ((now - this.framesRefilledAt) / 1000) * FRAMES_PER_SECOND);
    this.framesRefilledAt = now;
    if (this.frameTokens < 1) {
      this.ws.close(CLOSE_POLICY, 'слишком много кадров');
      return;
    }
    this.frameTokens -= 1;
    if (!this.user || !this.app.rooms.onFrame(this, data)) this.ws.close(CLOSE_PROTOCOL_ERROR, 'неверный кадр');
  }

  private onText(text: string): void {
    const now = Date.now();
    this.tokens = Math.min(RATE_BURST, this.tokens + ((now - this.refilledAt) / 1000) * RATE_PER_SECOND);
    this.refilledAt = now;
    if (this.tokens < 1 || this.queued >= MAX_QUEUED) {
      this.ws.close(CLOSE_POLICY, 'слишком много сообщений');
      return;
    }
    this.tokens -= 1;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.ws.close(CLOSE_PROTOCOL_ERROR, 'не JSON');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.ws.close(CLOSE_PROTOCOL_ERROR, 'ожидался объект');
      return;
    }
    const request = message as Record<string, unknown>;
    const type = request.t;
    const id = request.id;
    if (typeof type !== 'string' || typeof id !== 'number' || !Number.isSafeInteger(id)) {
      this.ws.close(CLOSE_PROTOCOL_ERROR, 'нет t или id');
      return;
    }
    this.queued++;
    this.queue = this.queue.then(() => this.handle(type, id, request)).finally(() => this.queued--);
  }

  private async handle(type: string, id: number, args: Record<string, unknown>): Promise<void> {
    if (!this.isOpen) return;
    let reply: Record<string, unknown>;
    try {
      if (!Object.prototype.hasOwnProperty.call(handlers, type)) throw new RequestError('unknown_request', type);
      const name = type as RequestName;
      if (name === 'hello') {
        if (args.version !== PROTOCOL_VERSION) throw new RequestError('version', `сервер говорит на версии ${PROTOCOL_VERSION}`);
        this.helloDone = true;
      } else if (!this.helloDone) {
        throw new RequestError('bad_request', 'первым должен быть hello');
      } else if (!this.user && !PUBLIC_REQUESTS.includes(name)) {
        throw new RequestError('not_authenticated');
      }
      const data = await handlers[name](this.app, this, args);
      reply = { ...data, t: 'reply', id, ok: true };
    } catch (error) {
      if (error instanceof RequestError) {
        reply = { t: 'reply', id, ok: false, error: error.code };
        if (error.message !== error.code) reply.message = error.message;
      } else {
        logError('session', `${this.user?.name ?? this.address}: ${type} —`, error);
        reply = { t: 'reply', id, ok: false, error: 'server_error' };
      }
    }
    if (this.isOpen) this.ws.sendText(JSON.stringify(reply));
  }
}

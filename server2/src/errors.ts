/** Ошибка запроса: уходит клиенту как `{ok: false, error, message}`; прочие исключения — `server_error` и журнал. */
import type { ErrorCode, ShotHit, Vec3 } from '../../html5/src/net2/protocol.ts';

export class RequestError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message = '') {
    super(message || code);
    this.code = code;
  }
}

type Args = Record<string, unknown>;

export function stringArg(args: Args, name: string, maxLength = 200): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length > maxLength) throw new RequestError('bad_request', `поле ${name}: ожидалась строка`);
  return value;
}

export function intArg(args: Args, name: string, min: number, max: number): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RequestError('bad_request', `поле ${name}: ожидалось целое ${min}…${max}`);
  }
  return value;
}

/** координата боя: конечные числа не дальше километра… сотни километров от центра карты */
const MAX_COORDINATE = 1e7;

export function vecValue(value: unknown, name: string): Vec3 {
  const vector = value as Partial<Vec3> | null;
  const ok = (axis: unknown): axis is number => typeof axis === 'number' && Number.isFinite(axis) && Math.abs(axis) <= MAX_COORDINATE;
  if (!vector || typeof vector !== 'object' || !ok(vector.x) || !ok(vector.y) || !ok(vector.z)) throw new RequestError('bad_request', `поле ${name}: ожидался вектор`);
  return { x: vector.x, y: vector.y, z: vector.z };
}

/** необязательный вектор: нет поля или null — null */
export function optionalVec(args: Args, name: string): Vec3 | null {
  return args[name] == null ? null : vecValue(args[name], name);
}

export function shotHitValue(value: unknown, name: string): ShotHit {
  if (!value || typeof value !== 'object') throw new RequestError('bad_request', `поле ${name}: ожидалось попадание`);
  const hit = value as Args;
  return {
    userId: intArg(hit, 'userId', 1, 0xffffffff),
    life: intArg(hit, 'life', 0, 0x7fffffff),
    local: vecValue(hit.local, `${name}.local`),
    world: vecValue(hit.world, `${name}.world`),
    position: vecValue(hit.position, `${name}.position`),
  };
}

/** не больше `limit` попыток за `windowMs` на ключ (адрес клиента) */
export class AttemptLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly attempts = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  take(key: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }

  prune(now = Date.now()): void {
    for (const [key, times] of this.attempts) if (times.every((time) => now - time >= this.windowMs)) this.attempts.delete(key);
  }
}

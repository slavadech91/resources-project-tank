/**
 * Небольшой клиент MariaDB / MySQL без зависимостей: протокол 4.1 (handshake v10, вход `mysql_native_password`,
 * в том числе через AuthSwitch), COM_QUERY с текстовыми результатами, пул соединений, транзакции.
 * Параметры подставляются на стороне клиента (`?` → экранированное значение), как у mysql.connector старого сервера.
 * Серверный режим без NO_BACKSLASH_ESCAPES (у MariaDB по умолчанию), поэтому экранирование — обратной косой.
 */
import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';

export interface DbOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolSize: number;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export type SqlValue = null | undefined | number | bigint | boolean | string | Date | Uint8Array;
export type Row = Record<string, unknown>;

export interface QueryResult<T = Row> {
  rows: T[];
  affectedRows: number;
  insertId: number;
}

export class DbError extends Error {
  readonly code: number;
  readonly sqlState: string;

  constructor(message: string, code = 0, sqlState = '') {
    super(message);
    this.code = code;
    this.sqlState = sqlState;
  }
}

/** ER_DUP_ENTRY */
export const ER_DUP_ENTRY = 1062;

const CLIENT_LONG_PASSWORD = 0x1;
const CLIENT_LONG_FLAG = 0x4;
const CLIENT_CONNECT_WITH_DB = 0x8;
const CLIENT_PROTOCOL_41 = 0x200;
const CLIENT_TRANSACTIONS = 0x2000;
const CLIENT_SECURE_CONNECTION = 0x8000;
const CLIENT_MULTI_RESULTS = 0x20000;
const CLIENT_PLUGIN_AUTH = 0x80000;
/** utf8mb4_unicode_ci — как у таблиц базы */
const CHARSET_UTF8MB4 = 224;
const CHARSET_BINARY = 63;
const COM_QUIT = 0x01;
const COM_QUERY = 0x03;
const COM_PING = 0x0e;
const MAX_PACKET = 0xffffff;

// типы столбцов
const NUMERIC_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);

interface Column {
  name: string;
  type: number;
  charset: number;
}

class Reader {
  pos = 0;
  readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  u8(): number {
    return this.buf[this.pos++];
  }

  u16(): number {
    const value = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return value;
  }

  u32(): number {
    const value = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  /** целое с префиксом длины; null для 0xfb (NULL в строке результата) */
  lenenc(): number | null {
    const first = this.u8();
    if (first < 0xfb) return first;
    if (first === 0xfb) return null;
    if (first === 0xfc) return this.u16();
    if (first === 0xfd) {
      const value = this.buf[this.pos] | (this.buf[this.pos + 1] << 8) | (this.buf[this.pos + 2] << 16);
      this.pos += 3;
      return value;
    }
    const value = Number(this.buf.readBigUInt64LE(this.pos));
    this.pos += 8;
    return value;
  }

  bytes(length: number): Buffer {
    const value = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

  lenencBytes(): Buffer | null {
    const length = this.lenenc();
    return length === null ? null : this.bytes(length);
  }

  lenencString(): string {
    return (this.lenencBytes() ?? Buffer.alloc(0)).toString('utf8');
  }

  nulString(): string {
    let end = this.buf.indexOf(0, this.pos);
    if (end < 0) end = this.buf.length;
    const value = this.buf.toString('utf8', this.pos, end);
    this.pos = Math.min(end + 1, this.buf.length);
    return value;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }
}

function sha1(...parts: Uint8Array[]): Buffer {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** mysql_native_password: SHA1(pw) XOR SHA1(seed + SHA1(SHA1(pw))) */
function scramble(password: string, seed: Uint8Array): Buffer {
  if (!password) return Buffer.alloc(0);
  const stage1 = sha1(Buffer.from(password, 'utf8'));
  const stage2 = sha1(stage1);
  const mix = sha1(seed, stage2);
  for (let i = 0; i < mix.length; i++) mix[i] ^= stage1[i];
  return mix;
}

function errorFromPacket(packet: Buffer): DbError {
  const reader = new Reader(packet);
  reader.u8();
  const code = reader.u16();
  let sqlState = '';
  if (packet[reader.pos] === 0x23) {
    reader.pos++;
    sqlState = reader.bytes(5).toString('ascii');
  }
  return new DbError(`MariaDB ${code}: ${packet.toString('utf8', reader.pos)}`, code, sqlState);
}

function isEof(packet: Buffer): boolean {
  return packet[0] === 0xfe && packet.length < 9;
}

const ESCAPES: Record<string, string> = {
  '\0': '\\0',
  '\n': '\\n',
  '\r': '\\r',
  '\b': '\\b',
  '\t': '\\t',
  '\x1a': '\\Z',
  '\\': '\\\\',
  "'": "\\'",
  '"': '\\"',
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** DATETIME в местном времени (как datetime.now() старого сервера) */
export function formatDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function escapeValue(value: SqlValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DbError(`нечисловое значение в запросе: ${value}`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return `'${formatDateTime(value)}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${value.replace(/[\0\n\r\b\t\x1a\\'"]/g, (ch) => ESCAPES[ch])}'`;
}

/** подстановка параметров: каждый `?` в тексте запроса (в шаблонах server2 нет `?` внутри строк) */
export function formatQuery(sql: string, params: readonly SqlValue[]): string {
  let index = 0;
  const text = sql.replace(/\?/g, () => {
    if (index >= params.length) throw new DbError(`параметров меньше, чем «?»: ${sql}`);
    return escapeValue(params[index++]);
  });
  if (index !== params.length) throw new DbError(`параметров больше, чем «?»: ${sql}`);
  return text;
}

function convert(raw: Buffer, column: Column): unknown {
  if (NUMERIC_TYPES.has(column.type)) return Number(raw.toString('ascii'));
  if (column.charset === CHARSET_BINARY && column.type !== 7 && column.type !== 10 && column.type !== 11 && column.type !== 12) {
    return Buffer.from(raw);
  }
  return raw.toString('utf8');
}

class Connection {
  readonly socket: Socket;
  private readonly queryTimeoutMs: number;
  private pending: Buffer = Buffer.alloc(0);
  private readonly packets: Buffer[] = [];
  private readonly waiters: Array<{ resolve: (packet: Buffer) => void; reject: (error: Error) => void }> = [];
  private seq = 0;
  private failure: Error | null = null;
  lastUsed = Date.now();

  private constructor(socket: Socket, queryTimeoutMs: number) {
    this.socket = socket;
    this.queryTimeoutMs = queryTimeoutMs;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new DbError('соединение с базой закрыто')));
  }

  get dead(): boolean {
    return this.failure !== null;
  }

  static async open(options: DbOptions): Promise<Connection> {
    const socket = connect({ host: options.host, port: options.port });
    const connection = new Connection(socket, options.queryTimeoutMs ?? 15000);
    const timer = setTimeout(() => connection.fail(new DbError('база не ответила на подключение')), options.connectTimeoutMs ?? 5000);
    try {
      await connection.handshake(options);
    } catch (error) {
      connection.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return connection;
  }

  private onData(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 4) {
      const length = this.pending[0] | (this.pending[1] << 8) | (this.pending[2] << 16);
      if (this.pending.length < 4 + length) return;
      if (length === MAX_PACKET) {
        this.fail(new DbError('пакеты больше 16 МБ не поддерживаются'));
        return;
      }
      this.seq = (this.pending[3] + 1) & 0xff;
      const packet = Buffer.from(this.pending.subarray(4, 4 + length));
      this.pending = this.pending.subarray(4 + length);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(packet);
      else this.packets.push(packet);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.socket.destroy();
  }

  destroy(): void {
    this.fail(new DbError('соединение закрыто'));
  }

  private read(): Promise<Buffer> {
    const packet = this.packets.shift();
    if (packet) return Promise.resolve(packet);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private write(payload: Uint8Array): void {
    if (this.failure) throw this.failure;
    if (payload.length >= MAX_PACKET) throw new DbError('запрос больше 16 МБ');
    const header = Buffer.alloc(4);
    header[0] = payload.length & 0xff;
    header[1] = (payload.length >> 8) & 0xff;
    header[2] = (payload.length >> 16) & 0xff;
    header[3] = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    this.socket.write(Buffer.concat([header, payload]));
  }

  private command(code: number, body: Uint8Array = Buffer.alloc(0)): void {
    this.seq = 0;
    this.packets.length = 0;
    this.write(Buffer.concat([Buffer.from([code]), body]));
  }

  private async handshake(options: DbOptions): Promise<void> {
    const greeting = await this.read();
    if (greeting[0] === 0xff) throw errorFromPacket(greeting);
    const reader = new Reader(greeting);
    const protocol = reader.u8();
    if (protocol !== 10) throw new DbError(`неизвестный протокол базы ${protocol}`);
    reader.nulString(); // версия сервера
    reader.u32(); // id соединения
    const seed1 = reader.bytes(8);
    reader.u8();
    let serverCaps = reader.u16();
    let plugin = 'mysql_native_password';
    let seed = Buffer.from(seed1);
    if (reader.remaining > 0) {
      reader.u8(); // кодировка сервера
      reader.u16(); // статус
      serverCaps |= reader.u16() << 16;
      const authLength = reader.u8();
      reader.bytes(10);
      if (serverCaps & CLIENT_SECURE_CONNECTION) {
        const seed2 = reader.bytes(Math.max(13, authLength - 8));
        // seed2 заканчивается NUL: в соль входят 12 байт
        seed = Buffer.concat([seed1, seed2.subarray(0, 12)]);
      }
      if (serverCaps & CLIENT_PLUGIN_AUTH) plugin = reader.nulString() || plugin;
    }
    if (!(serverCaps & CLIENT_PROTOCOL_41)) throw new DbError('сервер базы без протокола 4.1');

    const caps =
      CLIENT_LONG_PASSWORD |
      CLIENT_LONG_FLAG |
      CLIENT_PROTOCOL_41 |
      CLIENT_TRANSACTIONS |
      CLIENT_SECURE_CONNECTION |
      CLIENT_MULTI_RESULTS |
      (serverCaps & CLIENT_PLUGIN_AUTH) |
      (options.database ? CLIENT_CONNECT_WITH_DB : 0);
    const auth = plugin === 'mysql_native_password' ? scramble(options.password, seed) : Buffer.alloc(0);
    const head = Buffer.alloc(32);
    head.writeUInt32LE(caps >>> 0, 0);
    head.writeUInt32LE(MAX_PACKET, 4);
    head[8] = CHARSET_UTF8MB4;
    const parts: Uint8Array[] = [head, Buffer.from(options.user + '\0', 'utf8'), Buffer.from([auth.length]), auth];
    if (options.database) parts.push(Buffer.from(options.database + '\0', 'utf8'));
    if (caps & CLIENT_PLUGIN_AUTH) parts.push(Buffer.from('mysql_native_password\0', 'ascii'));
    this.write(Buffer.concat(parts));

    for (;;) {
      const reply = await this.read();
      if (reply[0] === 0x00) return;
      if (reply[0] === 0xff) throw errorFromPacket(reply);
      if (reply[0] === 0xfe) {
        // AuthSwitchRequest: другой плагин или новая соль
        const switchReader = new Reader(reply);
        switchReader.u8();
        const name = switchReader.nulString();
        if (name !== 'mysql_native_password') throw new DbError(`вход в базу через «${name}» не поддерживается`);
        const data = switchReader.bytes(switchReader.remaining);
        this.write(scramble(options.password, data.subarray(0, 20)));
        continue;
      }
      throw new DbError(`неожиданный ответ базы при входе: 0x${reply[0].toString(16)}`);
    }
  }

  async query<T = Row>(sql: string): Promise<QueryResult<T>> {
    this.lastUsed = Date.now();
    const timer = setTimeout(() => this.fail(new DbError(`запрос не выполнен за ${this.queryTimeoutMs} мс: ${sql.slice(0, 120)}`)), this.queryTimeoutMs);
    try {
      this.command(COM_QUERY, Buffer.from(sql, 'utf8'));
      return await this.readResult<T>();
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(): Promise<void> {
    this.command(COM_PING);
    const reply = await this.read();
    if (reply[0] === 0xff) throw errorFromPacket(reply);
  }

  quit(): void {
    if (this.failure) return;
    try {
      this.command(COM_QUIT);
    } catch {
      // уже закрыто
    }
    this.socket.end();
  }

  private async readResult<T>(): Promise<QueryResult<T>> {
    const first = await this.read();
    if (first[0] === 0xff) throw errorFromPacket(first);
    if (first[0] === 0x00) {
      const reader = new Reader(first);
      reader.u8();
      return { rows: [], affectedRows: reader.lenenc() ?? 0, insertId: reader.lenenc() ?? 0 };
    }
    if (first[0] === 0xfb) throw new DbError('LOAD DATA LOCAL не поддерживается');
    const count = new Reader(first).lenenc() ?? 0;
    const columns: Column[] = [];
    for (let i = 0; i < count; i++) {
      const reader = new Reader(await this.read());
      reader.lenencString(); // catalog
      reader.lenencString(); // schema
      reader.lenencString(); // table
      reader.lenencString(); // org_table
      const name = reader.lenencString();
      reader.lenencString(); // org_name
      reader.lenenc(); // длина фиксированных полей (0x0c)
      const charset = reader.u16();
      reader.u32(); // длина столбца
      const type = reader.u8();
      columns.push({ name, type, charset });
    }
    const eof = await this.read();
    if (!isEof(eof)) throw new DbError('ожидался EOF после описания столбцов');
    const rows: T[] = [];
    for (;;) {
      const packet = await this.read();
      if (packet[0] === 0xff) throw errorFromPacket(packet);
      if (isEof(packet)) break;
      const reader = new Reader(packet);
      const row: Row = {};
      for (const column of columns) {
        const raw = reader.lenencBytes();
        row[column.name] = raw === null ? null : convert(raw, column);
      }
      rows.push(row as T);
    }
    return { rows, affectedRows: 0, insertId: 0 };
  }
}

/** соединение, выданное транзакции: те же запросы, что у пула */
export interface Queryable {
  query<T = Row>(sql: string, params?: readonly SqlValue[]): Promise<QueryResult<T>>;
}

export class Database implements Queryable {
  private readonly options: DbOptions;
  private readonly idle: Connection[] = [];
  private readonly waiting: Array<{ resolve: (connection: Connection) => void; reject: (error: Error) => void }> = [];
  private total = 0;
  private closed = false;
  private readonly keepAlive: ReturnType<typeof setInterval>;

  constructor(options: DbOptions) {
    this.options = options;
    // простаивающие соединения раз в 5 минут проверяются: база закрывает их после wait_timeout
    this.keepAlive = setInterval(() => this.pingIdle(), 300000);
  }

  async query<T = Row>(sql: string, params: readonly SqlValue[] = []): Promise<QueryResult<T>> {
    const text = formatQuery(sql, params);
    const connection = await this.acquire();
    try {
      return await connection.query<T>(text);
    } finally {
      this.release(connection);
    }
  }

  /** запросы fn — в одной транзакции; исключение — ROLLBACK */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const connection = await this.acquire();
    let active = true;
    const tx: Queryable = {
      query: <R = Row>(sql: string, params: readonly SqlValue[] = []): Promise<QueryResult<R>> => {
        if (!active) return Promise.reject(new DbError('транзакция уже завершена'));
        return connection.query<R>(formatQuery(sql, params));
      },
    };
    try {
      await connection.query('START TRANSACTION');
      const result = await fn(tx);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      if (!connection.dead) await connection.query('ROLLBACK').catch(() => connection.destroy());
      throw error;
    } finally {
      active = false;
      this.release(connection);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.keepAlive);
    for (const connection of this.idle.splice(0)) connection.quit();
    for (const waiter of this.waiting.splice(0)) waiter.reject(new DbError('пул базы закрыт'));
  }

  private async acquire(): Promise<Connection> {
    if (this.closed) throw new DbError('пул базы закрыт');
    while (this.idle.length) {
      const connection = this.idle.pop()!;
      if (!connection.dead) return connection;
      this.total--;
    }
    if (this.total < this.options.poolSize) {
      this.total++;
      try {
        return await Connection.open(this.options);
      } catch (error) {
        this.total--;
        throw error;
      }
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private release(connection: Connection): void {
    if (connection.dead || this.closed) {
      this.total--;
      if (this.closed) connection.quit();
      const waiter = this.waiting.shift();
      if (waiter) this.acquire().then(waiter.resolve, waiter.reject);
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(connection);
    else this.idle.push(connection);
  }

  private pingIdle(): void {
    const now = Date.now();
    for (const connection of this.idle.splice(0)) {
      if (connection.dead) {
        this.total--;
        continue;
      }
      if (now - connection.lastUsed < 240000) {
        this.idle.push(connection);
        continue;
      }
      connection.lastUsed = now;
      connection.ping().then(
        () => this.release(connection),
        () => this.release(connection),
      );
    }
  }
}

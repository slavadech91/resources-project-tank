/**
 * Минимальные объявления Node.js для проверки типов server2: пакета @types/node в проекте нет (скачивание — только с
 * разрешения пользователя), поэтому здесь только то API, которым server2 пользуется. Расширять по мере надобности.
 */

interface NodeEventTarget {
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: BufferEncoding): Buffer;
  static from(data: ArrayLike<number> | ArrayBuffer): Buffer;
  static alloc(size: number, fill?: number): Buffer;
  static allocUnsafe(size: number): Buffer;
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  static byteLength(text: string, encoding?: BufferEncoding): number;
  static isBuffer(value: unknown): value is Buffer;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
  write(text: string, offset?: number, encoding?: BufferEncoding): number;
  readUInt8(offset: number): number;
  readUInt16LE(offset: number): number;
  readUInt16BE(offset: number): number;
  readUInt32LE(offset: number): number;
  readUInt32BE(offset: number): number;
  readInt32BE(offset: number): number;
  readBigUInt64BE(offset: number): bigint;
  readBigUInt64LE(offset: number): bigint;
  writeUInt8(value: number, offset: number): number;
  writeUInt16LE(value: number, offset: number): number;
  writeUInt16BE(value: number, offset: number): number;
  writeUInt32LE(value: number, offset: number): number;
  writeUInt32BE(value: number, offset: number): number;
  writeBigUInt64BE(value: bigint, offset: number): number;
  equals(other: Uint8Array): boolean;
}

type BufferEncoding = 'utf8' | 'utf-8' | 'ascii' | 'latin1' | 'binary' | 'hex' | 'base64';

declare const process: NodeEventTarget & {
  env: Record<string, string | undefined>;
  argv: string[];
  pid: number;
  platform: string;
  version: string;
  exitCode: number | undefined;
  cwd(): string;
  exit(code?: number): never;
  uptime(): number;
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
};

interface ImportMeta {
  url: string;
}

declare module 'node:net' {
  export interface Socket extends NodeEventTarget {
    readonly remoteAddress: string | undefined;
    readonly destroyed: boolean;
    readonly writableLength: number;
    write(data: Uint8Array | string, callback?: (error?: Error) => void): boolean;
    end(data?: Uint8Array | string): this;
    destroy(error?: Error): this;
    setNoDelay(noDelay?: boolean): this;
    setKeepAlive(enable?: boolean, initialDelay?: number): this;
    setTimeout(timeout: number, callback?: () => void): this;
  }
  export function connect(options: { host: string; port: number }): Socket;
  export function createConnection(options: { host: string; port: number }): Socket;
}

declare module 'node:http' {
  import type { Socket } from 'node:net';
  export interface IncomingMessage extends NodeEventTarget {
    readonly url: string | undefined;
    readonly method: string | undefined;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly socket: Socket;
  }
  export interface ServerResponse extends NodeEventTarget {
    writeHead(status: number, headers?: Record<string, string | number>): this;
    end(data?: string | Uint8Array): this;
  }
  export interface Server extends NodeEventTarget {
    listen(port: number, host: string, callback?: () => void): this;
    close(callback?: (error?: Error) => void): this;
  }
  export function createServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(): Buffer;
    digest(encoding: 'hex' | 'base64'): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Buffer;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: BufferEncoding): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string, encoding?: BufferEncoding): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { mtimeMs: number; size: number };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  const path: { join: typeof join; resolve: typeof resolve; dirname: typeof dirname };
  export default path;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:worker_threads' {
  export interface MessagePort extends NodeEventTarget {
    postMessage(value: unknown): void;
  }
  export class Worker implements NodeEventTarget {
    constructor(file: string | URL, options?: { workerData?: unknown });
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    postMessage(value: unknown): void;
    terminate(): Promise<number>;
    unref(): void;
  }
  export const parentPort: MessagePort | null;
  export const isMainThread: boolean;
}

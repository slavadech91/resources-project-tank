/**
 * bcrypt (OpenBSD, `$2b$`) без зависимостей — совместим с Python `bcrypt`, которым старый сервер хеширует пароли.
 * Синхронный и тяжёлый (стоимость 12 — 4096 повторов расширения ключа): вызывать из воркера (`bcrypt-worker.ts`).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { P_INIT, S_INIT } from './blowfishTables.ts';

const ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SALT_BYTES = 16;
const HASH_BYTES = 23;
const MAX_KEY_BYTES = 72;
/** "OrpheanBeholderScryDoubt" — 6 слов big-endian */
const MAGIC = Int32Array.from([0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274]);
const HASH_PATTERN = /^\$2[aby]\$(\d\d)\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/;

export const MIN_COST = 4;
export const MAX_COST = 31;

const P = new Int32Array(18);
const S = new Int32Array(1024);
/** шифруемый блок [l, r]: encipher() меняет его на месте */
const LR = new Int32Array(2);

// Блок передаётся через LR, а не аргументами, и после каждого сложения стоит `| 0`: на 32-битном V8 (Debian i686)
// целые вне 31 бита в аргументах упаковываются в объекты кучи, а суммы вне int32 считаются в double с медленным
// переводом обратно — без этого bcrypt там был в 4 раза медленнее C-версии
function encipher(): void {
  let l = LR[0] ^ P[0];
  let r = LR[1];
  for (let i = 1; i < 17; i += 2) {
    r ^= (((((S[l >>> 24] + S[256 | ((l >>> 16) & 0xff)]) | 0) ^ S[512 | ((l >>> 8) & 0xff)]) + S[768 | (l & 0xff)]) | 0) ^ P[i];
    l ^= (((((S[r >>> 24] + S[256 | ((r >>> 16) & 0xff)]) | 0) ^ S[512 | ((r >>> 8) & 0xff)]) + S[768 | (r & 0xff)]) | 0) ^ P[i + 1];
  }
  LR[0] = r ^ P[17];
  LR[1] = l;
}

/** 18 слов потока байт `data` по кругу (как Blowfish_stream2word) */
function streamWords(data: Uint8Array): Int32Array {
  const words = new Int32Array(18);
  let j = 0;
  for (let i = 0; i < 18; i++) {
    let word = 0;
    for (let k = 0; k < 4; k++) {
      word = (word << 8) | data[j];
      j = (j + 1) % data.length;
    }
    words[i] = word;
  }
  return words;
}

/** Blowfish_expandstate: ключ в P, затем перешифровка P и S с подмешиванием соли (поток соли идёт сквозь P и S) */
function expandState(key: Int32Array, salt: Int32Array): void {
  for (let i = 0; i < 18; i++) P[i] ^= key[i];
  LR[0] = 0;
  LR[1] = 0;
  let w = 0;
  for (let i = 0; i < 18; i += 2) {
    LR[0] ^= salt[w++ & 3];
    LR[1] ^= salt[w++ & 3];
    encipher();
    P[i] = LR[0];
    P[i + 1] = LR[1];
  }
  for (let i = 0; i < 1024; i += 2) {
    LR[0] ^= salt[w++ & 3];
    LR[1] ^= salt[w++ & 3];
    encipher();
    S[i] = LR[0];
    S[i + 1] = LR[1];
  }
}

/** Blowfish_expand0state: то же без соли */
function expand0State(key: Int32Array): void {
  for (let i = 0; i < 18; i++) P[i] ^= key[i];
  LR[0] = 0;
  LR[1] = 0;
  for (let i = 0; i < 18; i += 2) {
    encipher();
    P[i] = LR[0];
    P[i + 1] = LR[1];
  }
  for (let i = 0; i < 1024; i += 2) {
    encipher();
    S[i] = LR[0];
    S[i + 1] = LR[1];
  }
}

/** ключ $2b$: байты UTF-8 пароля + NUL, не длиннее 72 байт (как bcrypt до версии 5 в Python — обрезка) */
function passwordKey(password: string): Uint8Array {
  const bytes = new TextEncoder().encode(password);
  if (bytes.length >= MAX_KEY_BYTES) return bytes.subarray(0, MAX_KEY_BYTES);
  const key = new Uint8Array(bytes.length + 1);
  key.set(bytes);
  return key;
}

function digest(password: string, salt: Uint8Array, cost: number): Uint8Array {
  const key = passwordKey(password);
  const keyWords = streamWords(key);
  const saltWords = streamWords(salt);
  P.set(P_INIT);
  S.set(S_INIT);
  expandState(keyWords, saltWords);
  for (let round = 2 ** cost; round > 0; round--) {
    expand0State(keyWords);
    expand0State(saltWords);
  }
  const text = Int32Array.from(MAGIC);
  for (let n = 0; n < 64; n++) {
    for (let b = 0; b < 6; b += 2) {
      LR[0] = text[b];
      LR[1] = text[b + 1];
      encipher();
      text[b] = LR[0];
      text[b + 1] = LR[1];
    }
  }
  const out = new Uint8Array(24);
  for (let i = 0; i < 6; i++) {
    out[i * 4] = text[i] >>> 24;
    out[i * 4 + 1] = text[i] >>> 16;
    out[i * 4 + 2] = text[i] >>> 8;
    out[i * 4 + 3] = text[i];
  }
  return out.subarray(0, HASH_BYTES);
}

function encode64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    let c1 = bytes[i++];
    out += ALPHABET[c1 >> 2];
    c1 = (c1 & 0x03) << 4;
    if (i >= bytes.length) {
      out += ALPHABET[c1];
      break;
    }
    let c2 = bytes[i++];
    c1 |= c2 >> 4;
    out += ALPHABET[c1];
    c1 = (c2 & 0x0f) << 2;
    if (i >= bytes.length) {
      out += ALPHABET[c1];
      break;
    }
    c2 = bytes[i++];
    c1 |= c2 >> 6;
    out += ALPHABET[c1] + ALPHABET[c2 & 0x3f];
  }
  return out;
}

function decode64(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const at = (i: number): number => ALPHABET.indexOf(text[i]);
  let o = 0;
  let i = 0;
  while (o < length) {
    const c1 = at(i++);
    const c2 = at(i++);
    out[o++] = (c1 << 2) | ((c2 & 0x30) >> 4);
    if (o >= length) break;
    const c3 = at(i++);
    out[o++] = ((c2 & 0x0f) << 4) | ((c3 & 0x3c) >> 2);
    if (o >= length) break;
    const c4 = at(i++);
    out[o++] = ((c3 & 0x03) << 6) | c4;
  }
  return out;
}

export function hashPassword(password: string, cost: number, salt: Uint8Array = randomBytes(SALT_BYTES)): string {
  if (!Number.isInteger(cost) || cost < MIN_COST || cost > MAX_COST) throw new Error(`bcrypt: стоимость ${cost} вне ${MIN_COST}…${MAX_COST}`);
  if (salt.length !== SALT_BYTES) throw new Error('bcrypt: соль — 16 байт');
  return `$2b$${String(cost).padStart(2, '0')}$${encode64(salt)}${encode64(digest(password, salt, cost))}`;
}

/** проверка пароля по хешу `$2a$`/`$2b$`/`$2y$` (стоимость берётся из хеша) */
export function checkPassword(password: string, hash: string): boolean {
  const match = HASH_PATTERN.exec(hash);
  if (!match) return false;
  const cost = Number(match[1]);
  if (cost < MIN_COST || cost > MAX_COST) return false;
  const expected = new TextEncoder().encode(match[3]);
  const actual = new TextEncoder().encode(encode64(digest(password, decode64(match[2], SALT_BYTES), cost)));
  return timingSafeEqual(expected, actual);
}

/**
 * Байтовый слой протокола Tanki Online 2014.
 *
 * Особенности оригинала, которые нужно повторять буквально:
 *  - все примитивы big-endian, кроме 3ds (там little-endian, но это не протокол);
 *  - длина строки и массива кодируется переменным числом байт (LenghtCodec);
 *  - в начале каждого пакета идёт "optional map" — битовая карта того, какие
 *    необязательные поля присутствуют (OptionalCodec пишет 0 = есть, 1 = нет);
 *  - пакеты длиной >= 16384 сервер сжимает zlib и ставит флаг 0x80 в первом байте.
 */

const LONG_PACKAGE_FLAG = 0x80;
const ZIPPED_FLAG = 0x40;
const LONG_PACKAGE_THRESHOLD = 16384;

export class ByteReader {
  readonly data: Uint8Array;
  private readonly view: DataView;
  offset = 0;

  private optionalBits: number[] = [];
  private optionalPos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  get optionalRemaining(): number {
    return this.optionalBits.length - this.optionalPos;
  }

  u8(): number {
    return this.data[this.offset++];
  }

  i8(): number {
    const value = this.data[this.offset++];
    return value > 127 ? value - 256 : value;
  }

  i16(): number {
    const value = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return value;
  }

  i32(): number {
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  i64(): number {
    const value = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return Number(value);
  }

  f32(): number {
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return value;
  }

  f64(): number {
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return value;
  }

  bool(): boolean {
    return this.u8() === 1;
  }

  bytes(count: number): Uint8Array {
    const out = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  /** LenghtCodec: 1, 2 или 3 байта в зависимости от величины. */
  readLength(): number {
    const first = this.u8();
    if ((first & 0x80) === 0) return first;
    const second = this.u8();
    if ((second & 0x40) === 0) return ((first & 0x3f) << 8) + second;
    const third = this.u8();
    return ((first & 0x3f) << 16) + (second << 8) + third;
  }

  str(): string {
    const size = this.readLength();
    const raw = this.bytes(size);
    return new TextDecoder().decode(raw);
  }

  /** SimpleStringCodec: длина одним байтом. */
  ascii(): string {
    const size = this.u8();
    return new TextDecoder().decode(this.bytes(size));
  }

  vec3(): { x: number; y: number; z: number } {
    return { x: this.f32(), y: this.f32(), z: this.f32() };
  }

  /** Разбор optional map в начале пакета (порт OptionalMapCodec.decode). */
  readOptionalMap(): void {
    const bits: number[] = [];
    const pushByte = (byte: number): void => {
      for (let shift = 7; shift >= 0; shift -= 1) bits.push((byte >> shift) & 1);
    };

    const first = this.u8();
    if ((first & 0x80) !== 0) {
      const firstValue = first & 0x3f;
      let maskLength: number;
      if ((first & 0x40) !== 0) {
        const second = this.u8();
        const third = this.u8();
        maskLength = (firstValue << 16) + (second << 8) + third;
      } else {
        maskLength = firstValue;
      }
      for (let index = 0; index < maskLength; index += 1) pushByte(this.u8());
    } else {
      const firstValue = (first << 3) & 0xff;
      const count = (first & 0x60) >> 5;
      if (count === 0) {
        pushByte(firstValue);
      } else if (count === 1) {
        const second = this.u8();
        pushByte(firstValue + (second >> 5));
        pushByte((second << 3) & 0xff);
      } else if (count === 2) {
        const second = this.u8();
        const third = this.u8();
        pushByte(firstValue + (second >> 5));
        pushByte(((second << 3) & 0xff) + (third >> 5));
        pushByte((third << 3) & 0xff);
      } else {
        const second = this.u8();
        const third = this.u8();
        const fourth = this.u8();
        pushByte(firstValue + (second >> 5));
        pushByte(((second << 3) & 0xff) + (third >> 5));
        pushByte(((third << 3) & 0xff) + (fourth >> 5));
        pushByte((fourth << 3) & 0xff);
      }
    }
    this.optionalBits = bits;
    this.optionalPos = 0;
  }

  readOptionalBit(): boolean {
    const bit = this.optionalBits[this.optionalPos] ?? 0;
    this.optionalPos += 1;
    return bit === 1;
  }
}

export class ByteWriter {
  private chunks: Uint8Array[] = [];
  readonly optionalBits: number[] = [];

  get length(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    return total;
  }

  u8(value: number): void {
    this.chunks.push(new Uint8Array([value & 0xff]));
  }

  i8(value: number): void {
    const array = new Uint8Array(1);
    new DataView(array.buffer).setInt8(0, value);
    this.chunks.push(array);
  }

  i16(value: number): void {
    const array = new Uint8Array(2);
    new DataView(array.buffer).setInt16(0, value, false);
    this.chunks.push(array);
  }

  i32(value: number): void {
    const array = new Uint8Array(4);
    new DataView(array.buffer).setInt32(0, value, false);
    this.chunks.push(array);
  }

  u32(value: number): void {
    const array = new Uint8Array(4);
    new DataView(array.buffer).setUint32(0, value, false);
    this.chunks.push(array);
  }

  i64(value: number): void {
    const array = new Uint8Array(8);
    new DataView(array.buffer).setBigInt64(0, BigInt(value), false);
    this.chunks.push(array);
  }

  f32(value: number): void {
    const array = new Uint8Array(4);
    new DataView(array.buffer).setFloat32(0, value, false);
    this.chunks.push(array);
  }

  f64(value: number): void {
    const array = new Uint8Array(8);
    new DataView(array.buffer).setFloat64(0, value, false);
    this.chunks.push(array);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  bytes(data: Uint8Array): void {
    this.chunks.push(data);
  }

  writeLength(value: number): void {
    if (value < 128) {
      this.u8(value & 0x7f);
      return;
    }
    if (value < 16384) {
      const encoded = (value & 16383) + 32768;
      this.u8((encoded & 0xff00) >> 8);
      this.u8(encoded & 0xff);
      return;
    }
    const encoded = (value & 4194303) + 12582912;
    this.u8((encoded & 0xff0000) >> 16);
    this.u8((encoded & 0xff00) >> 8);
    this.u8(encoded & 0xff);
  }

  str(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.writeLength(encoded.length);
    this.bytes(encoded);
  }

  ascii(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.u8(encoded.length);
    this.bytes(encoded);
  }

  vec3(value: { x: number; y: number; z: number }): void {
    this.f32(value.x);
    this.f32(value.y);
    this.f32(value.z);
  }

  writeOptionalBit(bit: number): void {
    this.optionalBits.push(bit);
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const array of arrays) total += array.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

/** optional map -> байты (порт OptionalMapCodec.encode). */
export function encodeOptionalMap(bits: number[]): Uint8Array {
  if (bits.length === 0) return new Uint8Array([0]);

  const bytes: number[] = [];
  for (let index = 0; index < bits.length; index += 1) {
    const byteIndex = index >> 3;
    if (byteIndex >= bytes.length) bytes.push(0);
    if (bits[index] === 1) bytes[byteIndex] |= 0x80 >> (index & 7);
  }

  const size = bits.length;
  const out: number[] = [];
  if (size <= 5) {
    out.push((bytes[0] & 0xff) >> 3);
    return new Uint8Array(out);
  }
  if (size <= 13) {
    out.push(((bytes[0] & 0xff) >> 3) + 0x20);
    out.push((((bytes[1] & 0xff) >> 3) + ((bytes[0] << 5) & 0xff)) & 0xff);
    return new Uint8Array(out);
  }
  if (size <= 21) {
    out.push(((bytes[0] & 0xff) >> 3) + 0x40);
    out.push((((bytes[1] & 0xff) >> 3) + ((bytes[0] << 5) & 0xff)) & 0xff);
    out.push((((bytes[2] & 0xff) >> 3) + ((bytes[1] << 5) & 0xff)) & 0xff);
    return new Uint8Array(out);
  }
  if (size <= 29) {
    out.push(((bytes[0] & 0xff) >> 3) + 0x60);
    out.push((((bytes[1] & 0xff) >> 3) + ((bytes[0] << 5) & 0xff)) & 0xff);
    out.push((((bytes[2] & 0xff) >> 3) + ((bytes[1] << 5) & 0xff)) & 0xff);
    out.push((((bytes[3] & 0xff) >> 3) + ((bytes[2] << 5) & 0xff)) & 0xff);
    return new Uint8Array(out);
  }
  // длинная форма, как в OptionalMapCodec.encode: число байт маски + маска без последнего байта
  if (bytes.length < 0x40) {
    out.push(0x80 | (bytes.length & 0x3f));
  } else {
    out.push(0x80 | 0x40 | ((bytes.length >> 16) & 0x3f));
    out.push((bytes.length >> 8) & 0xff);
    out.push(bytes.length & 0xff);
  }
  for (let index = 0; index < bytes.length - 1; index += 1) out.push(bytes[index]);
  return new Uint8Array(out);
}

/** Собирает пакеты из потока байт: TCP/WebSocket режет данные как хочет. */
export class PackageStream {
  private pending: Uint8Array = new Uint8Array(0);

  async push(data: Uint8Array): Promise<ByteReader[]> {
    this.pending = concatBytes(this.pending, data);
    const packets: ByteReader[] = [];

    for (;;) {
      if (this.pending.length < 2) break;
      const first = this.pending[0];
      let headerSize: number;
      let size: number;
      let compressed: boolean;

      if ((first & LONG_PACKAGE_FLAG) !== 0) {
        if (this.pending.length < 4) break;
        size = ((first & 0x7f) << 24) | (this.pending[1] << 16) | (this.pending[2] << 8) | this.pending[3];
        compressed = true;
        headerSize = 4;
      } else {
        compressed = (first & ZIPPED_FLAG) !== 0;
        size = ((first & 0x3f) << 8) | this.pending[1];
        headerSize = 2;
      }

      if (this.pending.length < headerSize + size) break;

      let body: Uint8Array = this.pending.slice(headerSize, headerSize + size);
      this.pending = this.pending.slice(headerSize + size);
      if (compressed) body = await inflate(body);

      const reader = new ByteReader(body);
      reader.readOptionalMap();
      packets.push(reader);
    }

    return packets;
  }
}

export function wrapPackage(writer: ByteWriter): Uint8Array {
  const payload = writer.toBytes();
  const optionalMap = encodeOptionalMap(writer.optionalBits);
  const size = payload.length + optionalMap.length;
  if (size >= LONG_PACKAGE_THRESHOLD) {
    throw new Error(
      `пакет ${size} байт: сервер сжимает длинные пакеты и не умеет их разжимать (PackageCodec.decode), отправлять такие нельзя`,
    );
  }
  const header = new Uint8Array([(size & 0xff00) >> 8, size & 0xff]);
  return concatBytes(header, optionalMap, payload);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(data as unknown as BufferSource);
  void writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(new Uint8Array(value));
  }
  return concatBytes(...chunks);
}

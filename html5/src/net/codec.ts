/** Разбор/сборка данных по схеме, сгенерированной из серверного кода. */

import type { ByteReader, ByteWriter } from './bytes.ts';
import type { Op } from './schema.ts';

export type DecodedValue = unknown;

/** Значение по набору операций. Одна безымянная операция -> "голое" значение. */
export function decodeValue(reader: ByteReader, ops: Op[]): DecodedValue {
  if (ops.length === 1 && !ops[0].n) return decodeOp(reader, ops[0]);

  const out: Record<string, DecodedValue> = {};
  let anonymous = 0;
  for (const op of ops) {
    const key = op.n && op.n.length > 0 ? op.n : `#${anonymous++}`;
    out[key] = decodeOp(reader, op);
  }
  return out;
}

function decodeOp(reader: ByteReader, op: Op): DecodedValue {
  switch (op.t) {
    case 'i8':
      return reader.i8();
    case 'i16':
      return reader.i16();
    case 'i32':
      return reader.i32();
    case 'u32':
      return reader.u32();
    case 'i64':
      return reader.i64();
    case 'f32':
      return reader.f32();
    case 'f64':
      return reader.f64();
    case 'bool':
      return reader.bool();
    case 'str':
      return reader.str();
    case 'ascii':
      return reader.ascii();
    case 'len':
      return reader.readLength();
    case 'vec3':
      return reader.vec3();
    case 'raw':
      return { raw: op.size, bytes: reader.bytes(op.size).slice() };
    case 'struct':
      return decodeValue(reader, op.o);
    case 'arr': {
      const count = reader.readLength();
      const items: DecodedValue[] = [];
      for (let index = 0; index < count; index += 1) items.push(decodeValue(reader, op.o));
      return items;
    }
    case 'opt': {
      const absent = reader.readOptionalBit();
      return absent ? null : decodeValue(reader, op.o);
    }
    default: {
      const unknownOp = op as { t: string };
      throw new Error(`неизвестная операция схемы: ${unknownOp.t}`);
    }
  }
}

/** Запись значения по схеме (нужна для команд клиента). */
export function encodeValue(writer: ByteWriter, ops: Op[], value: unknown): void {
  const single = ops.length === 1 && !ops[0].n;
  const source = (single ? value : value) as Record<string, unknown>;

  for (const op of ops) {
    const item = single ? value : source?.[op.n ?? ''];
    encodeOp(writer, op, item);
  }
}

function encodeOp(writer: ByteWriter, op: Op, value: unknown): void {
  switch (op.t) {
    case 'i8':
      writer.i8(Number(value ?? 0));
      return;
    case 'i16':
      writer.i16(Number(value ?? 0));
      return;
    case 'i32':
      writer.i32(Number(value ?? 0));
      return;
    case 'u32':
      writer.u32(Number(value ?? 0));
      return;
    case 'i64':
      writer.i64(Number(value ?? 0));
      return;
    case 'f32':
      writer.f32(Number(value ?? 0));
      return;
    case 'f64':
      writer.f64(Number(value ?? 0));
      return;
    case 'bool':
      writer.bool(Boolean(value));
      return;
    case 'str':
      writer.str(String(value ?? ''));
      return;
    case 'ascii':
      writer.ascii(String(value ?? ''));
      return;
    case 'len':
      writer.writeLength(Number(value ?? 0));
      return;
    case 'vec3': {
      const vector = (value ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
      writer.vec3(vector);
      return;
    }
    case 'raw':
      writer.bytes(new Uint8Array(op.size));
      return;
    case 'struct':
      encodeValue(writer, op.o, value);
      return;
    case 'arr': {
      const items = (value ?? []) as unknown[];
      writer.writeLength(items.length);
      for (const item of items) encodeValue(writer, op.o, item);
      return;
    }
    case 'opt': {
      const absent = value === null || value === undefined;
      writer.writeOptionalBit(absent ? 1 : 0);
      if (!absent) encodeValue(writer, op.o, value);
      return;
    }
    default: {
      const unknownOp = op as { t: string };
      throw new Error(`неизвестная операция схемы: ${unknownOp.t}`);
    }
  }
}

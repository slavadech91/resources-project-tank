/**
 * Двоичные кадры боя протокола v2 (общий файл клиента и server2, только DataView): первый байт — тип кадра, дальше
 * big-endian. Состояние танка — 68 байт, как SyncSample синхронизации v2 (tanks/net/sync/SyncProtocol.ts).
 *
 * клиент → сервер: PING (i32 pingId, i32 clientMs), STATE (состояние своего танка);
 * сервер → клиент: PONG (i32 pingId, i32 clientMs, i32 serverMs), SNAPSHOT (i32 serverMs, u16 count,
 * count × (u32 userId, состояние)), CORRECTION (последнее принятое состояние своего танка — движение отвергнуто).
 */
import type { SyncSample } from '../tanks/net/sync/SyncProtocol.ts';

export const FRAME = {
  PING: 1,
  STATE: 2,
  PONG: 3,
  SNAPSHOT: 4,
  CORRECTION: 5,
} as const;

export const SAMPLE_SIZE = 68;
/** игроков в одном снапшоте (больше в бою не бывает) */
export const MAX_SNAPSHOT_TANKS = 64;

export function writeSample(view: DataView, offset: number, sample: SyncSample): void {
  const seq = sample.seq & 0xffff;
  view.setInt16(offset, seq >= 0x8000 ? seq - 0x10000 : seq);
  view.setInt32(offset + 2, sample.sampleTime | 0);
  view.setInt32(offset + 6, sample.life | 0);
  view.setInt8(offset + 10, sample.chassis);
  view.setInt8(offset + 11, sample.turretControl);
  const floats = [sample.turretAngle, sample.px, sample.py, sample.pz, sample.qx, sample.qy, sample.qz, sample.qw, sample.vx, sample.vy, sample.vz, sample.ax, sample.ay, sample.az];
  for (let i = 0; i < floats.length; i++) view.setFloat32(offset + 12 + i * 4, floats[i]);
}

export function readSample(view: DataView, offset: number): SyncSample {
  const f = (index: number): number => view.getFloat32(offset + 12 + index * 4);
  return {
    seq: view.getInt16(offset) & 0xffff,
    sampleTime: view.getInt32(offset + 2),
    life: view.getInt32(offset + 6),
    chassis: view.getInt8(offset + 10),
    turretControl: view.getInt8(offset + 11),
    turretAngle: f(0),
    px: f(1),
    py: f(2),
    pz: f(3),
    qx: f(4),
    qy: f(5),
    qz: f(6),
    qw: f(7),
    vx: f(8),
    vy: f(9),
    vz: f(10),
    ax: f(11),
    ay: f(12),
    az: f(13),
  };
}

function frame(type: number, size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(1 + size);
  bytes[0] = type;
  return { bytes, view: new DataView(bytes.buffer) };
}

export function encodePing(pingId: number, clientMs: number): Uint8Array {
  const { bytes, view } = frame(FRAME.PING, 8);
  view.setInt32(1, pingId | 0);
  view.setInt32(5, clientMs | 0);
  return bytes;
}

export function encodePong(pingId: number, clientMs: number, serverMs: number): Uint8Array {
  const { bytes, view } = frame(FRAME.PONG, 12);
  view.setInt32(1, pingId | 0);
  view.setInt32(5, clientMs | 0);
  view.setInt32(9, serverMs | 0);
  return bytes;
}

export function encodeState(type: typeof FRAME.STATE | typeof FRAME.CORRECTION, sample: SyncSample): Uint8Array {
  const { bytes, view } = frame(type, SAMPLE_SIZE);
  writeSample(view, 1, sample);
  return bytes;
}

export function encodeSnapshot(serverMs: number, tanks: { userId: number; sample: SyncSample }[]): Uint8Array {
  const count = Math.min(tanks.length, MAX_SNAPSHOT_TANKS);
  const { bytes, view } = frame(FRAME.SNAPSHOT, 6 + count * (4 + SAMPLE_SIZE));
  view.setInt32(1, serverMs | 0);
  view.setUint16(5, count);
  let offset = 7;
  for (let i = 0; i < count; i++) {
    view.setUint32(offset, tanks[i].userId >>> 0);
    writeSample(view, offset + 4, tanks[i].sample);
    offset += 4 + SAMPLE_SIZE;
  }
  return bytes;
}

export type Frame =
  | { type: typeof FRAME.PING; pingId: number; clientMs: number }
  | { type: typeof FRAME.PONG; pingId: number; clientMs: number; serverMs: number }
  | { type: typeof FRAME.STATE | typeof FRAME.CORRECTION; sample: SyncSample }
  | { type: typeof FRAME.SNAPSHOT; serverMs: number; tanks: { userId: number; sample: SyncSample }[] };

/** разбор кадра; неверная длина или неизвестный тип — null */
export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.length < 1) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = data[0];
  switch (type) {
    case FRAME.PING:
      return data.length == 9 ? { type, pingId: view.getInt32(1), clientMs: view.getInt32(5) } : null;
    case FRAME.PONG:
      return data.length == 13 ? { type, pingId: view.getInt32(1), clientMs: view.getInt32(5), serverMs: view.getInt32(9) } : null;
    case FRAME.STATE:
    case FRAME.CORRECTION:
      return data.length == 1 + SAMPLE_SIZE ? { type, sample: readSample(view, 1) } : null;
    case FRAME.SNAPSHOT: {
      if (data.length < 7) return null;
      const count = view.getUint16(5);
      if (count > MAX_SNAPSHOT_TANKS || data.length != 7 + count * (4 + SAMPLE_SIZE)) return null;
      const tanks: { userId: number; sample: SyncSample }[] = [];
      let offset = 7;
      for (let i = 0; i < count; i++) {
        tanks.push({ userId: view.getUint32(offset), sample: readSample(view, offset + 4) });
        offset += 4 + SAMPLE_SIZE;
      }
      return { type, serverMs: view.getInt32(1), tanks };
    }
    default:
      return null;
  }
}

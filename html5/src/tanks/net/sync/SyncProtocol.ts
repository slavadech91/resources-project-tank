/**
 * Синхронизация v2 (html5/docs/SYNC_V2.md): номера команд и состояние танка — пара серверному
 * global_models/battle/common/sync_service.py (encode_state / decode_state), 68 байт big-endian.
 */
import type { ByteReader, ByteWriter } from '../../../net/bytes.ts';

export const SYNC_COMMAND = {
  /** к → с, на объект своего танка: i32 ping_id, i32 client_ms */
  PING: 390000020,
  /** с → к: i32 ping_id, i32 client_ms, i32 server_ms */
  PONG: 390000021,
  /** к → с, на объект своего танка: состояние */
  STATE: 390000022,
  /** с → к, на объект, куда шёл PING: i32 server_ms, i16 count, count × (i64 id танка, состояние) */
  SNAPSHOT: 390000023,
  /** с → к: последнее принятое сервером состояние своего танка (движение отвергнуто) */
  CORRECTION: 390000024,
} as const;

/** конверт попадания с view_time (shot_registry.SHOT_ENVELOPE_V2_COMMAND_ID) */
export const SHOT_ENVELOPE_V2 = 390000005;

export interface SyncSample {
  /** 16 бит по кругу */
  seq: number;
  /** серверное время снятия состояния, мс */
  sampleTime: number;
  /** жизнь танка (spawn_token сервера) */
  life: number;
  chassis: number;
  turretControl: number;
  turretAngle: number;
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
}

export function decodeSample(reader: ByteReader): SyncSample {
  return {
    seq: reader.i16() & 0xffff,
    sampleTime: reader.i32(),
    life: reader.i32(),
    chassis: reader.i8(),
    turretControl: reader.i8(),
    turretAngle: reader.f32(),
    px: reader.f32(),
    py: reader.f32(),
    pz: reader.f32(),
    qx: reader.f32(),
    qy: reader.f32(),
    qz: reader.f32(),
    qw: reader.f32(),
    vx: reader.f32(),
    vy: reader.f32(),
    vz: reader.f32(),
    ax: reader.f32(),
    ay: reader.f32(),
    az: reader.f32(),
  };
}

export function encodeSample(sample: SyncSample, writer: ByteWriter): void {
  const seq = sample.seq & 0xffff;
  writer.i16(seq >= 0x8000 ? seq - 0x10000 : seq);
  writer.i32(sample.sampleTime | 0);
  writer.i32(sample.life | 0);
  writer.i8(sample.chassis);
  writer.i8(sample.turretControl);
  writer.f32(sample.turretAngle);
  writer.f32(sample.px);
  writer.f32(sample.py);
  writer.f32(sample.pz);
  writer.f32(sample.qx);
  writer.f32(sample.qy);
  writer.f32(sample.qz);
  writer.f32(sample.qw);
  writer.f32(sample.vx);
  writer.f32(sample.vy);
  writer.f32(sample.vz);
  writer.f32(sample.ax);
  writer.f32(sample.ay);
  writer.f32(sample.az);
}

/** все числа конечны, кватернион не нулевой — иначе сэмпл выбрасывается */
export function isValidSample(sample: SyncSample): boolean {
  const values = [sample.px, sample.py, sample.pz, sample.qx, sample.qy, sample.qz, sample.qw, sample.vx, sample.vy, sample.vz, sample.ax, sample.ay, sample.az, sample.turretAngle];
  for (const value of values) if (!Number.isFinite(value)) return false;
  return sample.qx * sample.qx + sample.qy * sample.qy + sample.qz * sample.qz + sample.qw * sample.qw > 0.25;
}

/** seq a новее b (по кругу 16 бит) */
export function seqNewer(a: number, b: number): boolean {
  const delta = (a - b) & 0xffff;
  return delta != 0 && delta < 0x8000;
}

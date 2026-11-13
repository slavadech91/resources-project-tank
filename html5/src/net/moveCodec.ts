/**
 * MoveCommandCodec (decompiled/field_readable/alternativa/tanks/models/tank/codec/MoveCommandCodec.as,
 * серверный порт — src/scripts/client/layouts/battle/battle_codecs.py).
 *
 * Команда движения = байт control + 21 байт «bit area»: 12 компонент подряд, старший бит первым:
 *   положение (3 x 17 бит, шаг 1), ориентация (3 x 13, шаг π/4096),
 *   линейная скорость (3 x 13, шаг 1), угловая скорость (3 x 13, шаг 0.005).
 * Значение хранится как trunc(x / шаг) - 2^(n-1) (в n битах, со смещением); при чтении — наоборот.
 */

export const MOVE_BIT_AREA_SIZE = 21;
const POSITION_BITS = 17;
const ORIENTATION_BITS = 13;
const LINEAR_VELOCITY_BITS = 13;
const ANGULAR_VELOCITY_BITS = 13;
const ANGLE_FACTOR = Math.PI / 4096;
const ANGULAR_VELOCITY_FACTOR = 0.005;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface MoveCommand {
  control: number;
  position: Vec3Like;
  orientation: Vec3Like;
  linearVelocity: Vec3Like;
  angularVelocity: Vec3Like;
}

export function createMoveCommand(): MoveCommand {
  return {
    control: 0,
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0 },
    linearVelocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
  };
}

class BitArea {
  position = 0;
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  write(bitCount: number, value: number): void {
    for (let shift = bitCount - 1; shift >= 0; shift -= 1) {
      const bit = Math.floor(value / 2 ** shift) % 2 === 1;
      const index = this.position >> 3;
      const mask = 1 << (7 ^ (this.position & 7));
      if (bit) this.data[index] |= mask;
      else this.data[index] &= 255 ^ mask;
      this.position += 1;
    }
  }

  read(bitCount: number): number {
    let out = 0;
    for (let shift = bitCount - 1; shift >= 0; shift -= 1) {
      if (this.data[this.position >> 3] & (1 << (7 ^ (this.position & 7)))) out += 2 ** shift;
      this.position += 1;
    }
    return out;
  }
}

function prepareValue(value: number, half: number, factor: number): number {
  const scaled = Math.trunc(value / factor);
  const shifted = scaled >= -half ? scaled - half : 0;
  // как min(half, shifted) у оригинала, затем маска n бит при записи (отрицательные — в дополнительном коде)
  return Math.min(half, shifted);
}

function writeVector(area: BitArea, vector: Vec3Like, bitCount: number, factor: number): void {
  const half = 2 ** (bitCount - 1);
  const mask = 2 ** bitCount;
  for (const component of [vector.x, vector.y, vector.z]) {
    const prepared = prepareValue(component, half, factor);
    area.write(bitCount, ((prepared % mask) + mask) % mask);
  }
}

function readVector(area: BitArea, bitCount: number, factor: number): Vec3Like {
  const half = 2 ** (bitCount - 1);
  return {
    x: (area.read(bitCount) - half) * factor,
    y: (area.read(bitCount) - half) * factor,
    z: (area.read(bitCount) - half) * factor,
  };
}

/** 21 байт bit area без байта control. */
export function encodeMoveBitArea(command: MoveCommand): Uint8Array {
  const area = new BitArea(new Uint8Array(MOVE_BIT_AREA_SIZE));
  writeVector(area, command.position, POSITION_BITS, 1);
  writeVector(area, command.orientation, ORIENTATION_BITS, ANGLE_FACTOR);
  writeVector(area, command.linearVelocity, LINEAR_VELOCITY_BITS, 1);
  writeVector(area, command.angularVelocity, ANGULAR_VELOCITY_BITS, ANGULAR_VELOCITY_FACTOR);
  return area.data;
}

export function decodeMoveBitArea(control: number, bytes: Uint8Array): MoveCommand {
  const area = new BitArea(bytes);
  return {
    control,
    position: readVector(area, POSITION_BITS, 1),
    orientation: readVector(area, ORIENTATION_BITS, ANGLE_FACTOR),
    linearVelocity: readVector(area, LINEAR_VELOCITY_BITS, 1),
    angularVelocity: readVector(area, ANGULAR_VELOCITY_BITS, ANGULAR_VELOCITY_FACTOR),
  };
}

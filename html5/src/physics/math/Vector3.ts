// 1:1 из decompiled/field_readable/alternativa/math/Vector3.as
import type { Matrix3 } from './Matrix3.ts';
import type { Matrix4 } from './Matrix4.ts';

export class Vector3 {
  static readonly ZERO = new Vector3(0, 0, 0);
  static readonly X_AXIS = new Vector3(1, 0, 0);
  static readonly Y_AXIS = new Vector3(0, 1, 0);
  static readonly Z_AXIS = new Vector3(0, 0, 1);
  static readonly DOWN = new Vector3(0, 0, -1);

  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static isFiniteVector(v: Vector3 | null): boolean {
    return v != null && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  }

  static interpolateTo(t: number, a: Vector3, b: Vector3, result: Vector3): void {
    result.x = a.x + t * (b.x - a.x);
    result.y = a.y + t * (b.y - a.y);
    result.z = a.z + t * (b.z - a.z);
  }

  static distanceBetween(a: Vector3, b: Vector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  interpolate(t: number, a: Vector3, b: Vector3): void {
    this.x = a.x + t * (b.x - a.x);
    this.y = a.y + t * (b.y - a.y);
    this.z = a.z + t * (b.z - a.z);
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  lengthSqr(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  setLength(length: number): Vector3 {
    const sqr = this.x * this.x + this.y * this.y + this.z * this.z;
    if (sqr == 0) {
      this.x = length;
    } else {
      const k = length / Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
      this.x *= k;
      this.y *= k;
      this.z *= k;
    }
    return this;
  }

  normalize(): Vector3 {
    let d = this.x * this.x + this.y * this.y + this.z * this.z;
    if (d == 0) {
      this.x = 1;
    } else {
      d = Math.sqrt(d);
      this.x /= d;
      this.y /= d;
      this.z /= d;
    }
    return this;
  }

  add(v: Vector3): Vector3 {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addScaled(k: number, v: Vector3): Vector3 {
    this.x += k * v.x;
    this.y += k * v.y;
    this.z += k * v.z;
    return this;
  }

  subtract(v: Vector3): Vector3 {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  sum(a: Vector3, b: Vector3): Vector3 {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  diff(a: Vector3, b: Vector3): Vector3 {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  diff2d(a: Vector3, b: Vector3): Vector3 {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = 0;
    return this;
  }

  scale(k: number): Vector3 {
    this.x *= k;
    this.y *= k;
    this.z *= k;
    return this;
  }

  /** § "8§ */
  reverse(): Vector3 {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(v: Vector3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vector3): Vector3 {
    const x = this.y * v.z - this.z * v.y;
    const y = this.z * v.x - this.x * v.z;
    const z = this.x * v.y - this.y * v.x;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  cross2(a: Vector3, b: Vector3): Vector3 {
    this.x = a.y * b.z - a.z * b.y;
    this.y = a.z * b.x - a.x * b.z;
    this.z = a.x * b.y - a.y * b.x;
    return this;
  }

  transform3(m: Matrix3): Vector3 {
    const x = this.x;
    const y = this.y;
    const z = this.z;
    this.x = m.a * x + m.b * y + m.c * z;
    this.y = m.e * x + m.f * y + m.g * z;
    this.z = m.i * x + m.j * y + m.k * z;
    return this;
  }

  transformTransposed3(m: Matrix3): Vector3 {
    const x = this.x;
    const y = this.y;
    const z = this.z;
    this.x = m.a * x + m.e * y + m.i * z;
    this.y = m.b * x + m.f * y + m.j * z;
    this.z = m.c * x + m.g * y + m.k * z;
    return this;
  }

  transform4(m: Matrix4): Vector3 {
    const x = this.x;
    const y = this.y;
    const z = this.z;
    this.x = m.a * x + m.b * y + m.c * z + m.d;
    this.y = m.e * x + m.f * y + m.g * z + m.h;
    this.z = m.i * x + m.j * y + m.k * z + m.l;
    return this;
  }

  transformInverse4(m: Matrix4): Vector3 {
    const x = this.x - m.d;
    const y = this.y - m.h;
    const z = this.z - m.l;
    this.x = m.a * x + m.e * y + m.i * z;
    this.y = m.b * x + m.f * y + m.j * z;
    this.z = m.c * x + m.g * y + m.k * z;
    return this;
  }

  transformVector4(m: Matrix4): Vector3 {
    const x = this.x;
    const y = this.y;
    const z = this.z;
    this.x = m.a * x + m.b * y + m.c * z;
    this.y = m.e * x + m.f * y + m.g * z;
    this.z = m.i * x + m.j * y + m.k * z;
    return this;
  }

  reset(x = 0, y = 0, z = 0): Vector3 {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: Vector3): Vector3 {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  toString(): string {
    return `Vector3 (${this.x.toFixed(5)}, ${this.y.toFixed(5)}, ${this.z.toFixed(5)})`;
  }

  distanceToXYSquared(v: Vector3): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return dx * dx + dy * dy;
  }

  distanceToXY(v: Vector3): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  distanceTo(v: Vector3): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  distanceToSquared(v: Vector3): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  setLengthAlongDirection(direction: Vector3, length: number): void {
    const current = this.x * direction.x + this.y * direction.y + this.z * direction.z;
    const delta = length - current;
    this.x += delta * direction.x;
    this.y += delta * direction.y;
    this.z += delta * direction.z;
  }

  projectOnPlane(normal: Vector3): void {
    const d = this.x * normal.x + this.y * normal.y + this.z * normal.z;
    this.x -= d * normal.x;
    this.y -= d * normal.y;
    this.z -= d * normal.z;
  }
}

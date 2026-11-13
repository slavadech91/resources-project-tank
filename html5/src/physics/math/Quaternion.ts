// 1:1 из decompiled/field_readable/alternativa/math/Quaternion.as
import type { Matrix3 } from './Matrix3.ts';
import type { Matrix4 } from './Matrix4.ts';
import { Vector3 } from './Vector3.ts';

export class Quaternion {
  private static readonly tmp = new Quaternion();

  w: number;
  x: number;
  y: number;
  z: number;

  constructor(w = 1, x = 0, y = 0, z = 0) {
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static multiply(q1: Quaternion, q2: Quaternion, result: Quaternion): void {
    result.w = q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z;
    result.x = q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y;
    result.y = q1.w * q2.y + q1.y * q2.w + q1.z * q2.x - q1.x * q2.z;
    result.z = q1.w * q2.z + q1.z * q2.w + q1.x * q2.y - q1.y * q2.x;
  }

  reset(w = 1, x = 0, y = 0, z = 0): Quaternion {
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  normalize(): Quaternion {
    let d = this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z;
    if (d == 0) {
      this.w = 1;
    } else {
      d = 1 / Math.sqrt(d);
      this.w *= d;
      this.x *= d;
      this.y *= d;
      this.z *= d;
    }
    return this;
  }

  prepend(q: Quaternion): Quaternion {
    const w = this.w * q.w - this.x * q.x - this.y * q.y - this.z * q.z;
    const x = this.w * q.x + this.x * q.w + this.y * q.z - this.z * q.y;
    const y = this.w * q.y + this.y * q.w + this.z * q.x - this.x * q.z;
    const z = this.w * q.z + this.z * q.w + this.x * q.y - this.y * q.x;
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  append(q: Quaternion): Quaternion {
    const w = q.w * this.w - q.x * this.x - q.y * this.y - q.z * this.z;
    const x = q.w * this.x + q.x * this.w + q.y * this.z - q.z * this.y;
    const y = q.w * this.y + q.y * this.w + q.z * this.x - q.x * this.z;
    const z = q.w * this.z + q.z * this.w + q.x * this.y - q.y * this.x;
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  rotateByVector(v: Vector3): Quaternion {
    const w = -v.x * this.x - v.y * this.y - v.z * this.z;
    const x = v.x * this.w + v.y * this.z - v.z * this.y;
    const y = v.y * this.w + v.z * this.x - v.x * this.z;
    const z = v.z * this.w + v.x * this.y - v.y * this.x;
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  addScaledVector(v: Vector3, scale: number): Quaternion {
    const vx = v.x * scale;
    const vy = v.y * scale;
    const vz = v.z * scale;
    const w = -this.x * vx - this.y * vy - this.z * vz;
    const x = vx * this.w + vy * this.z - vz * this.y;
    const y = vy * this.w + vz * this.x - vx * this.z;
    const z = vz * this.w + vx * this.y - vy * this.x;
    this.w += 0.5 * w;
    this.x += 0.5 * x;
    this.y += 0.5 * y;
    this.z += 0.5 * z;
    let d = this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z;
    if (d == 0) {
      this.w = 1;
    } else {
      d = 1 / Math.sqrt(d);
      this.w *= d;
      this.x *= d;
      this.y *= d;
      this.z *= d;
    }
    return this;
  }

  toMatrix3(m: Matrix3): Quaternion {
    const xx = 2 * this.x * this.x;
    const yy = 2 * this.y * this.y;
    const zz = 2 * this.z * this.z;
    const xy = 2 * this.x * this.y;
    const yz = 2 * this.y * this.z;
    const zx = 2 * this.z * this.x;
    const wx = 2 * this.w * this.x;
    const wy = 2 * this.w * this.y;
    const wz = 2 * this.w * this.z;
    m.a = 1 - yy - zz;
    m.b = xy - wz;
    m.c = zx + wy;
    m.e = xy + wz;
    m.f = 1 - xx - zz;
    m.g = yz - wx;
    m.i = zx - wy;
    m.j = yz + wx;
    m.k = 1 - xx - yy;
    return this;
  }

  toMatrix4(m: Matrix4): Quaternion {
    const xx = 2 * this.x * this.x;
    const yy = 2 * this.y * this.y;
    const zz = 2 * this.z * this.z;
    const xy = 2 * this.x * this.y;
    const yz = 2 * this.y * this.z;
    const zx = 2 * this.z * this.x;
    const wx = 2 * this.w * this.x;
    const wy = 2 * this.w * this.y;
    const wz = 2 * this.w * this.z;
    m.a = 1 - yy - zz;
    m.b = xy - wz;
    m.c = zx + wy;
    m.e = xy + wz;
    m.f = 1 - xx - zz;
    m.g = yz - wx;
    m.i = zx - wy;
    m.j = yz + wx;
    m.k = 1 - xx - yy;
    return this;
  }

  length(): number {
    return Math.sqrt(this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z);
  }

  lengthSqr(): number {
    return this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z;
  }

  /** §with§ */
  setFromAxisAngle(axis: Vector3, angle: number): Quaternion {
    this.w = Math.cos(0.5 * angle);
    const k = Math.sin(0.5 * angle) / Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
    this.x = axis.x * k;
    this.y = axis.y * k;
    this.z = axis.z * k;
    return this;
  }

  setFromAxisAngleComponents(x: number, y: number, z: number, angle: number): Quaternion {
    this.w = Math.cos(0.5 * angle);
    const k = Math.sin(0.5 * angle) / Math.sqrt(x * x + y * y + z * z);
    this.x = x * k;
    this.y = y * k;
    this.z = z * k;
    return this;
  }

  toAxisVector(result: Vector3 | null = null): Vector3 {
    if (this.w < -1 || this.w > 1) this.normalize();
    if (result == null) result = new Vector3();
    if (this.w > -1 && this.w < 1) {
      if (this.w == 0) {
        result.x = this.x;
        result.y = this.y;
        result.z = this.z;
      } else {
        const angle = 2 * Math.acos(this.w);
        const k = 1 / Math.sqrt(1 - this.w * this.w);
        result.x = this.x * k * angle;
        result.y = this.y * k * angle;
        result.z = this.z * k * angle;
      }
    } else {
      result.x = 0;
      result.y = 0;
      result.z = 0;
    }
    return result;
  }

  /** § c§ — углы Эйлера */
  getEulerAngles(result: Vector3 | null): Vector3 {
    const xx = 2 * this.x * this.x;
    const yy = 2 * this.y * this.y;
    const zz = 2 * this.z * this.z;
    const xy = 2 * this.x * this.y;
    const yz = 2 * this.y * this.z;
    const zx = 2 * this.z * this.x;
    const wx = 2 * this.w * this.x;
    const wy = 2 * this.w * this.y;
    const wz = 2 * this.w * this.z;
    const a = 1 - yy - zz;
    const b = xy - wz;
    const e = xy + wz;
    const f = 1 - xx - zz;
    const i = zx - wy;
    const j = yz + wx;
    const k = 1 - xx - yy;
    if (result == null) result = new Vector3();
    if (-1 < i && i < 1) {
      result.x = Math.atan2(j, k);
      result.y = -Math.asin(i);
      result.z = Math.atan2(e, a);
    } else {
      result.x = 0;
      result.y = i <= -1 ? Math.PI : -Math.PI;
      result.y *= 0.5;
      result.z = Math.atan2(-b, f);
    }
    return result;
  }

  setFromEulerAnglesXYZ(rx: number, ry: number, rz: number): void {
    this.setFromAxisAngleComponents(1, 0, 0, rx);
    Quaternion.tmp.setFromAxisAngleComponents(0, 1, 0, ry);
    this.append(Quaternion.tmp);
    this.normalize();
    Quaternion.tmp.setFromAxisAngleComponents(0, 0, 1, rz);
    this.append(Quaternion.tmp);
    this.normalize();
  }

  conjugate(): void {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
  }

  nlerp(q1: Quaternion, q2: Quaternion, t: number): Quaternion {
    let k = 1 - t;
    this.w = q1.w * k + q2.w * t;
    this.x = q1.x * k + q2.x * t;
    this.y = q1.y * k + q2.y * t;
    this.z = q1.z * k + q2.z * t;
    k = this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z;
    if (k == 0) {
      this.w = 1;
    } else {
      k = 1 / Math.sqrt(k);
      this.w *= k;
      this.x *= k;
      this.y *= k;
      this.z *= k;
    }
    return this;
  }

  subtract(q: Quaternion): Quaternion {
    this.w -= q.w;
    this.x -= q.x;
    this.y -= q.y;
    this.z -= q.z;
    return this;
  }

  diff(q1: Quaternion, q2: Quaternion): Quaternion {
    this.w = q2.w - q1.w;
    this.x = q2.x - q1.x;
    this.y = q2.y - q1.y;
    this.z = q2.z - q1.z;
    return this;
  }

  /** Ось Z повёрнутой системы координат (из Quaternion.getZAxis клиента 2019) */
  getZAxis(result: Vector3): Vector3 {
    const xx = 2 * this.x * this.x;
    const yy = 2 * this.y * this.y;
    const yz = 2 * this.y * this.z;
    const zx = 2 * this.z * this.x;
    const wx = 2 * this.w * this.x;
    const wy = 2 * this.w * this.y;
    result.x = zx + wy;
    result.y = yz - wx;
    result.z = 1 - xx - yy;
    return result;
  }

  copy(q: Quaternion): Quaternion {
    this.w = q.w;
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    return this;
  }

  clone(): Quaternion {
    return new Quaternion(this.w, this.x, this.y, this.z);
  }

  slerp(q1: Quaternion, q2: Quaternion, t: number): Quaternion {
    let sign = 1;
    let cos = q1.w * q2.w + q1.x * q2.x + q1.y * q2.y + q1.z * q2.z;
    if (cos < 0) {
      cos = -cos;
      sign = -1;
    }
    if (1 - cos < 0.001) {
      const k1 = 1 - t;
      const k2 = t * sign;
      this.w = q1.w * k1 + q2.w * k2;
      this.x = q1.x * k1 + q2.x * k2;
      this.y = q1.y * k1 + q2.y * k2;
      this.z = q1.z * k1 + q2.z * k2;
      this.normalize();
    } else {
      const angle = Math.acos(cos);
      const sin = Math.sin(angle);
      const k1 = Math.sin((1 - t) * angle) / sin;
      const k2 = (Math.sin(t * angle) / sin) * sign;
      this.w = q1.w * k1 + q2.w * k2;
      this.x = q1.x * k1 + q2.x * k2;
      this.y = q1.y * k1 + q2.y * k2;
      this.z = q1.z * k1 + q2.z * k2;
    }
    return this;
  }

  isFinite(): boolean {
    return Number.isFinite(this.w) && Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }
}

// 1:1 из decompiled/field_readable/alternativa/math/Matrix3.as
import type { Vector3 } from './Vector3.ts';

export class Matrix3 {
  static readonly ZERO = new Matrix3(0, 0, 0, 0, 0, 0, 0, 0, 0);
  static readonly IDENTITY = new Matrix3();

  a: number;
  b: number;
  c: number;
  e: number;
  f: number;
  g: number;
  i: number;
  j: number;
  k: number;

  constructor(a = 1, b = 0, c = 0, e = 0, f = 1, g = 0, i = 0, j = 0, k = 1) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.e = e;
    this.f = f;
    this.g = g;
    this.i = i;
    this.j = j;
    this.k = k;
  }

  toIdentity(): Matrix3 {
    this.a = this.f = this.k = 1;
    this.b = this.c = this.e = this.g = this.i = this.j = 0;
    return this;
  }

  invert(): Matrix3 {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const e = this.e;
    const f = this.f;
    const g = this.g;
    const i = this.i;
    const j = this.j;
    const k = this.k;
    const det = 1 / (-c * f * i + b * g * i + c * e * j - a * g * j - b * e * k + a * f * k);
    this.a = (f * k - g * j) * det;
    this.b = (c * j - b * k) * det;
    this.c = (b * g - c * f) * det;
    this.e = (g * i - e * k) * det;
    this.f = (a * k - c * i) * det;
    this.g = (c * e - a * g) * det;
    this.i = (e * j - f * i) * det;
    this.j = (b * i - a * j) * det;
    this.k = (a * f - b * e) * det;
    return this;
  }

  append(m: Matrix3): Matrix3 {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const e = this.e;
    const f = this.f;
    const g = this.g;
    const i = this.i;
    const j = this.j;
    const k = this.k;
    this.a = m.a * a + m.b * e + m.c * i;
    this.b = m.a * b + m.b * f + m.c * j;
    this.c = m.a * c + m.b * g + m.c * k;
    this.e = m.e * a + m.f * e + m.g * i;
    this.f = m.e * b + m.f * f + m.g * j;
    this.g = m.e * c + m.f * g + m.g * k;
    this.i = m.i * a + m.j * e + m.k * i;
    this.j = m.i * b + m.j * f + m.k * j;
    this.k = m.i * c + m.j * g + m.k * k;
    return this;
  }

  prepend(m: Matrix3): Matrix3 {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const e = this.e;
    const f = this.f;
    const g = this.g;
    const i = this.i;
    const j = this.j;
    const k = this.k;
    this.a = a * m.a + b * m.e + c * m.i;
    this.b = a * m.b + b * m.f + c * m.j;
    this.c = a * m.c + b * m.g + c * m.k;
    this.e = e * m.a + f * m.e + g * m.i;
    this.f = e * m.b + f * m.f + g * m.j;
    this.g = e * m.c + f * m.g + g * m.k;
    this.i = i * m.a + j * m.e + k * m.i;
    this.j = i * m.b + j * m.f + k * m.j;
    this.k = i * m.c + j * m.g + k * m.k;
    return this;
  }

  prependTransposed(m: Matrix3): Matrix3 {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const e = this.e;
    const f = this.f;
    const g = this.g;
    const i = this.i;
    const j = this.j;
    const k = this.k;
    this.a = a * m.a + b * m.b + c * m.c;
    this.b = a * m.e + b * m.f + c * m.g;
    this.c = a * m.i + b * m.j + c * m.k;
    this.e = e * m.a + f * m.b + g * m.c;
    this.f = e * m.e + f * m.f + g * m.g;
    this.g = e * m.i + f * m.j + g * m.k;
    this.i = i * m.a + j * m.b + k * m.c;
    this.j = i * m.e + j * m.f + k * m.g;
    this.k = i * m.i + j * m.j + k * m.k;
    return this;
  }

  add(m: Matrix3): Matrix3 {
    this.a += m.a;
    this.b += m.b;
    this.c += m.c;
    this.e += m.e;
    this.f += m.f;
    this.g += m.g;
    this.i += m.i;
    this.j += m.j;
    this.k += m.k;
    return this;
  }

  subtract(m: Matrix3): Matrix3 {
    this.a -= m.a;
    this.b -= m.b;
    this.c -= m.c;
    this.e -= m.e;
    this.f -= m.f;
    this.g -= m.g;
    this.i -= m.i;
    this.j -= m.j;
    this.k -= m.k;
    return this;
  }

  transpose(): Matrix3 {
    let t = this.b;
    this.b = this.e;
    this.e = t;
    t = this.c;
    this.c = this.i;
    this.i = t;
    t = this.g;
    this.g = this.j;
    this.j = t;
    return this;
  }

  transformVector(v: Vector3, result: Vector3): void {
    result.x = this.a * v.x + this.b * v.y + this.c * v.z;
    result.y = this.e * v.x + this.f * v.y + this.g * v.z;
    result.z = this.i * v.x + this.j * v.y + this.k * v.z;
  }

  transformVectorInverse(v: Vector3, result: Vector3): void {
    result.x = this.a * v.x + this.e * v.y + this.i * v.z;
    result.y = this.b * v.x + this.f * v.y + this.j * v.z;
    result.z = this.c * v.x + this.g * v.y + this.k * v.z;
  }

  createSkewSymmetric(v: Vector3): Matrix3 {
    this.a = this.f = this.k = 0;
    this.b = -v.z;
    this.c = v.y;
    this.e = v.z;
    this.g = -v.x;
    this.i = -v.y;
    this.j = v.x;
    return this;
  }

  copy(m: Matrix3): Matrix3 {
    this.a = m.a;
    this.b = m.b;
    this.c = m.c;
    this.e = m.e;
    this.f = m.f;
    this.g = m.g;
    this.i = m.i;
    this.j = m.j;
    this.k = m.k;
    return this;
  }

  /** R = Rz * Ry * Rx */
  setRotationMatrix(rx: number, ry: number, rz: number): Matrix3 {
    const cosX = Math.cos(rx);
    const sinX = Math.sin(rx);
    const cosY = Math.cos(ry);
    const sinY = Math.sin(ry);
    const cosZ = Math.cos(rz);
    const sinZ = Math.sin(rz);
    const cosZsinY = cosZ * sinY;
    const sinZsinY = sinZ * sinY;
    this.a = cosZ * cosY;
    this.b = cosZsinY * sinX - sinZ * cosX;
    this.c = cosZsinY * cosX + sinZ * sinX;
    this.e = sinZ * cosY;
    this.f = sinZsinY * sinX + cosZ * cosX;
    this.g = sinZsinY * cosX - cosZ * sinX;
    this.i = -sinY;
    this.j = cosY * sinX;
    this.k = cosY * cosX;
    return this;
  }

  fromAxisAngle(axis: Vector3, angle: number): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const x = axis.x;
    const y = axis.y;
    const z = axis.z;
    this.a = t * x * x + c;
    this.b = t * x * y - z * s;
    this.c = t * x * z + y * s;
    this.e = t * x * y + z * s;
    this.f = t * y * y + c;
    this.g = t * y * z - x * s;
    this.i = t * x * z - y * s;
    this.j = t * y * z + x * s;
    this.k = t * z * z + c;
  }

  clone(): Matrix3 {
    return new Matrix3(this.a, this.b, this.c, this.e, this.f, this.g, this.i, this.j, this.k);
  }

  /** § c§ — углы Эйлера */
  getEulerAngles(result: Vector3): void {
    if (-1 < this.i && this.i < 1) {
      result.x = Math.atan2(this.j, this.k);
      result.y = -Math.asin(this.i);
      result.z = Math.atan2(this.e, this.a);
    } else {
      result.x = 0;
      result.y = this.i <= -1 ? Math.PI : -Math.PI;
      result.y *= 0.5;
      result.z = Math.atan2(-this.b, this.f);
    }
  }

  getAxis(index: number, result: Vector3): void {
    switch (index) {
      case 0:
        result.reset(this.a, this.e, this.i);
        break;
      case 1:
        result.reset(this.b, this.f, this.j);
        break;
      case 2:
        result.reset(this.c, this.g, this.k);
    }
  }
}

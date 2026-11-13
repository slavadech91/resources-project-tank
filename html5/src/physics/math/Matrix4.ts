// 1:1 из decompiled/field_readable/alternativa/math/Matrix4.as
import type { Matrix3 } from './Matrix3.ts';
import type { Vector3 } from './Vector3.ts';

export class Matrix4 {
  static readonly IDENTITY = new Matrix4();

  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
  i: number;
  j: number;
  k: number;
  l: number;

  constructor(a = 1, b = 0, c = 0, d = 0, e = 0, f = 1, g = 0, h = 0, i = 0, j = 0, k = 1, l = 0) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
    this.g = g;
    this.h = h;
    this.i = i;
    this.j = j;
    this.k = k;
    this.l = l;
  }

  toIdentity(): Matrix4 {
    this.a = this.f = this.k = 1;
    this.b = this.c = this.e = this.g = this.i = this.j = this.d = this.h = this.l = 0;
    return this;
  }

  invert(): Matrix4 {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const d = this.d;
    const e = this.e;
    const f = this.f;
    const g = this.g;
    const h = this.h;
    const i = this.i;
    const j = this.j;
    const k = this.k;
    const l = this.l;
    const det = -c * f * i + b * g * i + c * e * j - a * g * j - b * e * k + a * f * k;
    this.a = (-g * j + f * k) / det;
    this.b = (c * j - b * k) / det;
    this.c = (-c * f + b * g) / det;
    this.d = (d * g * j - c * h * j - d * f * k + b * h * k + c * f * l - b * g * l) / det;
    this.e = (g * i - e * k) / det;
    this.f = (-c * i + a * k) / det;
    this.g = (c * e - a * g) / det;
    this.h = (c * h * i - d * g * i + d * e * k - a * h * k - c * e * l + a * g * l) / det;
    this.i = (-f * i + e * j) / det;
    this.j = (b * i - a * j) / det;
    this.k = (-b * e + a * f) / det;
    this.l = (d * f * i - b * h * i - d * e * j + a * h * j + b * e * l - a * f * l) / det;
    return this;
  }

  append(m: Matrix4): Matrix4 {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const d = this.d;
    const e = this.e;
    const f = this.f;
    const g = this.g;
    const h = this.h;
    const i = this.i;
    const j = this.j;
    const k = this.k;
    const l = this.l;
    this.a = m.a * a + m.b * e + m.c * i;
    this.b = m.a * b + m.b * f + m.c * j;
    this.c = m.a * c + m.b * g + m.c * k;
    this.d = m.a * d + m.b * h + m.c * l + m.d;
    this.e = m.e * a + m.f * e + m.g * i;
    this.f = m.e * b + m.f * f + m.g * j;
    this.g = m.e * c + m.f * g + m.g * k;
    this.h = m.e * d + m.f * h + m.g * l + m.h;
    this.i = m.i * a + m.j * e + m.k * i;
    this.j = m.i * b + m.j * f + m.k * j;
    this.k = m.i * c + m.j * g + m.k * k;
    this.l = m.i * d + m.j * h + m.k * l + m.l;
    return this;
  }

  prepend(m: Matrix4): Matrix4 {
    const a = this.a;
    const b = this.b;
    const c = this.c;
    const d = this.d;
    const e = this.e;
    const f = this.f;
    const g = this.g;
    const h = this.h;
    const i = this.i;
    const j = this.j;
    const k = this.k;
    const l = this.l;
    this.a = a * m.a + b * m.e + c * m.i;
    this.b = a * m.b + b * m.f + c * m.j;
    this.c = a * m.c + b * m.g + c * m.k;
    this.d = a * m.d + b * m.h + c * m.l + d;
    this.e = e * m.a + f * m.e + g * m.i;
    this.f = e * m.b + f * m.f + g * m.j;
    this.g = e * m.c + f * m.g + g * m.k;
    this.h = e * m.d + f * m.h + g * m.l + h;
    this.i = i * m.a + j * m.e + k * m.i;
    this.j = i * m.b + j * m.f + k * m.j;
    this.k = i * m.c + j * m.g + k * m.k;
    this.l = i * m.d + j * m.h + k * m.l + l;
    return this;
  }

  transformVector(v: Vector3, result: Vector3): void {
    result.x = this.a * v.x + this.b * v.y + this.c * v.z + this.d;
    result.y = this.e * v.x + this.f * v.y + this.g * v.z + this.h;
    result.z = this.i * v.x + this.j * v.y + this.k * v.z + this.l;
  }

  transformVectorInverse(v: Vector3, result: Vector3): void {
    const x = v.x - this.d;
    const y = v.y - this.h;
    const z = v.z - this.l;
    result.x = this.a * x + this.e * y + this.i * z;
    result.y = this.b * x + this.f * y + this.j * z;
    result.z = this.c * x + this.g * y + this.k * z;
  }

  transformVectors(source: Vector3[], result: Vector3[]): void {
    this.transformVectorsN(source, result, source.length);
  }

  transformVectorsN(source: Vector3[], result: Vector3[], count: number): void {
    for (let n = 0; n < count; n++) {
      const v = source[n];
      const r = result[n];
      r.x = this.a * v.x + this.b * v.y + this.c * v.z + this.d;
      r.y = this.e * v.x + this.f * v.y + this.g * v.z + this.h;
      r.z = this.i * v.x + this.j * v.y + this.k * v.z + this.l;
    }
  }

  /** § !5§ */
  transformVectorsInverse(source: Vector3[], result: Vector3[]): void {
    this.transformVectorsInverseN(source, result, source.length);
  }

  transformVectorsInverseN(source: Vector3[], result: Vector3[], count: number): void {
    for (let n = 0; n < count; n++) {
      const v = source[n];
      const r = result[n];
      const x = v.x - this.d;
      const y = v.y - this.h;
      const z = v.z - this.l;
      r.x = this.a * x + this.e * y + this.i * z;
      r.y = this.b * x + this.f * y + this.j * z;
      r.z = this.c * x + this.g * y + this.k * z;
    }
  }

  getAxis(index: number, result: Vector3): void {
    switch (index) {
      case 0:
        result.x = this.a;
        result.y = this.e;
        result.z = this.i;
        return;
      case 1:
        result.x = this.b;
        result.y = this.f;
        result.z = this.j;
        return;
      case 2:
        result.x = this.c;
        result.y = this.g;
        result.z = this.k;
        return;
      case 3:
        result.x = this.d;
        result.y = this.h;
        result.z = this.l;
        return;
    }
  }

  /** как в оригинале: с переносом (d, h, l) */
  deltaTransformVector(v: Vector3, result: Vector3): void {
    result.x = this.a * v.x + this.b * v.y + this.c * v.z + this.d;
    result.y = this.e * v.x + this.f * v.y + this.g * v.z + this.h;
    result.z = this.i * v.x + this.j * v.y + this.k * v.z + this.l;
  }

  deltaTransformVectorInverse(v: Vector3, result: Vector3): void {
    result.x = this.a * v.x + this.e * v.y + this.i * v.z;
    result.y = this.b * v.x + this.f * v.y + this.j * v.z;
    result.z = this.c * v.x + this.g * v.y + this.k * v.z;
  }

  copy(m: Matrix4): Matrix4 {
    this.a = m.a;
    this.b = m.b;
    this.c = m.c;
    this.d = m.d;
    this.e = m.e;
    this.f = m.f;
    this.g = m.g;
    this.h = m.h;
    this.i = m.i;
    this.j = m.j;
    this.k = m.k;
    this.l = m.l;
    return this;
  }

  setFromMatrix3(m: Matrix3, position: Vector3): Matrix4 {
    this.a = m.a;
    this.b = m.b;
    this.c = m.c;
    this.d = position.x;
    this.e = m.e;
    this.f = m.f;
    this.g = m.g;
    this.h = position.y;
    this.i = m.i;
    this.j = m.j;
    this.k = m.k;
    this.l = position.z;
    return this;
  }

  setOrientationFromMatrix3(m: Matrix3): Matrix4 {
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

  setRotationMatrix(rx: number, ry: number, rz: number): Matrix4 {
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

  setMatrix(x: number, y: number, z: number, rx: number, ry: number, rz: number): Matrix4 {
    this.setRotationMatrix(rx, ry, rz);
    this.d = x;
    this.h = y;
    this.l = z;
    return this;
  }

  /** § c§ */
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

  setPosition(position: Vector3): void {
    this.d = position.x;
    this.h = position.y;
    this.l = position.z;
  }

  clone(): Matrix4 {
    return new Matrix4(this.a, this.b, this.c, this.d, this.e, this.f, this.g, this.h, this.i, this.j, this.k, this.l);
  }
}

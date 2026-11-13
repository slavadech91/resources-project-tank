// 1:1 из alternativa/physics/collision/CollisionShape.as и primitives/{CollisionBox,CollisionRect,CollisionTriangle,CollisionSphere}.as
import { Matrix4 } from '../math/Matrix4.ts';
import { Vector3 } from '../math/Vector3.ts';
import type { Body } from '../Body.ts';
import { AABB, PhysicsMaterial } from './types.ts';

export class CollisionShape {
  static readonly BOX = 1; // §,!1§
  static readonly SPHERE = 2; // §8!E§
  static readonly RECT = 4; // §>!T§
  static readonly TRIANGLE = 8; // §%!L§

  type: number; // §,3§
  collisionGroup: number; // §'!_§
  body: Body | null = null; // §7b§
  localTransform: Matrix4 | null = null; // §1Y§
  transform = new Matrix4(); // §`"1§
  aabb = new AABB(); // §1F§
  material: PhysicsMaterial; // §&";§

  constructor(type: number, collisionGroup: number, material: PhysicsMaterial) {
    this.type = type;
    this.collisionGroup = collisionGroup;
    this.material = material;
  }

  setBody(body: Body | null, localTransform: Matrix4 | null = null): void {
    if (this.body == body) return;
    this.body = body;
    if (body != null) {
      if (localTransform != null) {
        if (this.localTransform == null) this.localTransform = new Matrix4();
        this.localTransform.copy(localTransform);
      } else {
        this.localTransform = null;
      }
    }
  }

  calculateAABB(): AABB {
    return this.aabb;
  }

  raycast(_origin: Vector3, _direction: Vector3, _epsilon: number, _normal: Vector3): number {
    return -1;
  }

  clone(): CollisionShape {
    return this.createPrimitive().copyFrom(this);
  }

  copyFrom(source: CollisionShape): CollisionShape {
    this.type = source.type;
    this.transform.copy(source.transform);
    this.collisionGroup = source.collisionGroup;
    this.setBody(source.body, source.localTransform);
    this.aabb.copyFrom(source.aabb);
    return this;
  }

  protected createPrimitive(): CollisionShape {
    return new CollisionShape(this.type, this.collisionGroup, this.material);
  }
}

export class CollisionBox extends CollisionShape {
  hs = new Vector3(); // §<H§ — половины размеров

  constructor(halfSize: Vector3, collisionGroup: number, material: PhysicsMaterial) {
    super(CollisionShape.BOX, collisionGroup, material);
    this.hs.copy(halfSize);
  }

  override calculateAABB(): AABB {
    const t = this.transform;
    const box = this.aabb;
    let a = t.a < 0 ? -t.a : t.a;
    let b = t.b < 0 ? -t.b : t.b;
    let c = t.c < 0 ? -t.c : t.c;
    box.maxX = this.hs.x * a + this.hs.y * b + this.hs.z * c;
    box.minX = -box.maxX;
    a = t.e < 0 ? -t.e : t.e;
    b = t.f < 0 ? -t.f : t.f;
    c = t.g < 0 ? -t.g : t.g;
    box.maxY = this.hs.x * a + this.hs.y * b + this.hs.z * c;
    box.minY = -box.maxY;
    a = t.i < 0 ? -t.i : t.i;
    b = t.j < 0 ? -t.j : t.j;
    c = t.k < 0 ? -t.k : t.k;
    box.maxZ = this.hs.x * a + this.hs.y * b + this.hs.z * c;
    box.minZ = -box.maxZ;
    box.minX += t.d;
    box.maxX += t.d;
    box.minY += t.h;
    box.maxY += t.h;
    box.minZ += t.l;
    box.maxZ += t.l;
    return box;
  }

  override copyFrom(source: CollisionShape): CollisionShape {
    if (!(source instanceof CollisionBox)) return this;
    super.copyFrom(source);
    this.hs.copy(source.hs);
    return this;
  }

  protected override createPrimitive(): CollisionShape {
    return new CollisionBox(this.hs, this.collisionGroup, this.material);
  }

  override raycast(origin: Vector3, direction: Vector3, epsilon: number, normal: Vector3): number {
    const t = this.transform;
    let tMin = -1;
    let tMax = 1e308;
    let t1: number;
    let t2: number;
    let x = origin.x - t.d;
    let y = origin.y - t.h;
    let z = origin.z - t.l;
    const ox = t.a * x + t.e * y + t.i * z;
    const oy = t.b * x + t.f * y + t.j * z;
    const oz = t.c * x + t.g * y + t.k * z;
    x = t.a * direction.x + t.e * direction.y + t.i * direction.z;
    y = t.b * direction.x + t.f * direction.y + t.j * direction.z;
    z = t.c * direction.x + t.g * direction.y + t.k * direction.z;
    if (x < epsilon && x > -epsilon) {
      if (ox < -this.hs.x || ox > this.hs.x) return -1;
    } else {
      t1 = (-this.hs.x - ox) / x;
      t2 = (this.hs.x - ox) / x;
      if (t1 < t2) {
        if (t1 > tMin) {
          tMin = t1;
          normal.x = -1;
          normal.y = normal.z = 0;
        }
        if (t2 < tMax) tMax = t2;
      } else {
        if (t2 > tMin) {
          tMin = t2;
          normal.x = 1;
          normal.y = normal.z = 0;
        }
        if (t1 < tMax) tMax = t1;
      }
      if (tMax < tMin) return -1;
    }
    if (y < epsilon && y > -epsilon) {
      if (oy < -this.hs.y || oy > this.hs.y) return -1;
    } else {
      t1 = (-this.hs.y - oy) / y;
      t2 = (this.hs.y - oy) / y;
      if (t1 < t2) {
        if (t1 > tMin) {
          tMin = t1;
          normal.y = -1;
          normal.x = normal.z = 0;
        }
        if (t2 < tMax) tMax = t2;
      } else {
        if (t2 > tMin) {
          tMin = t2;
          normal.y = 1;
          normal.x = normal.z = 0;
        }
        if (t1 < tMax) tMax = t1;
      }
      if (tMax < tMin) return -1;
    }
    if (z < epsilon && z > -epsilon) {
      if (oz < -this.hs.z || oz > this.hs.z) return -1;
    } else {
      t1 = (-this.hs.z - oz) / z;
      t2 = (this.hs.z - oz) / z;
      if (t1 < t2) {
        if (t1 > tMin) {
          tMin = t1;
          normal.z = -1;
          normal.x = normal.y = 0;
        }
        if (t2 < tMax) tMax = t2;
      } else {
        if (t2 > tMin) {
          tMin = t2;
          normal.z = 1;
          normal.x = normal.y = 0;
        }
        if (t1 < tMax) tMax = t1;
      }
      if (tMax < tMin) return -1;
    }
    x = normal.x;
    y = normal.y;
    z = normal.z;
    normal.x = t.a * x + t.b * y + t.c * z;
    normal.y = t.e * x + t.f * y + t.g * z;
    normal.z = t.i * x + t.j * y + t.k * z;
    return tMin;
  }
}

export class CollisionRect extends CollisionShape {
  private static readonly EPSILON = 0.005; // §,!E§
  hs = new Vector3(); // §<H§

  constructor(halfSize: Vector3, collisionGroup: number, material: PhysicsMaterial) {
    super(CollisionShape.RECT, collisionGroup, material);
    this.hs.copy(halfSize);
  }

  override calculateAABB(): AABB {
    const t = this.transform;
    let a = t.a < 0 ? -t.a : t.a;
    let b = t.b < 0 ? -t.b : t.b;
    let c = t.c < 0 ? -t.c : t.c;
    const box = this.aabb;
    box.maxX = this.hs.x * a + this.hs.y * b + CollisionRect.EPSILON * c;
    box.minX = -box.maxX;
    a = t.e < 0 ? -t.e : t.e;
    b = t.f < 0 ? -t.f : t.f;
    c = t.g < 0 ? -t.g : t.g;
    box.maxY = this.hs.x * a + this.hs.y * b + CollisionRect.EPSILON * c;
    box.minY = -box.maxY;
    a = t.i < 0 ? -t.i : t.i;
    b = t.j < 0 ? -t.j : t.j;
    c = t.k < 0 ? -t.k : t.k;
    box.maxZ = this.hs.x * a + this.hs.y * b + CollisionRect.EPSILON * c;
    box.minZ = -box.maxZ;
    box.minX += t.d;
    box.maxX += t.d;
    box.minY += t.h;
    box.maxY += t.h;
    box.minZ += t.l;
    box.maxZ += t.l;
    return box;
  }

  override copyFrom(source: CollisionShape): CollisionShape {
    if (!(source instanceof CollisionRect)) return this;
    super.copyFrom(source);
    this.hs.copy(source.hs);
    return this;
  }

  protected override createPrimitive(): CollisionShape {
    return new CollisionRect(this.hs, this.collisionGroup, this.material);
  }

  override raycast(origin: Vector3, direction: Vector3, epsilon: number, normal: Vector3): number {
    const t = this.transform;
    let x = origin.x - t.d;
    let y = origin.y - t.h;
    let z = origin.z - t.l;
    let ox = t.a * x + t.e * y + t.i * z;
    let oy = t.b * x + t.f * y + t.j * z;
    const oz = t.c * x + t.g * y + t.k * z;
    x = t.a * direction.x + t.e * direction.y + t.i * direction.z;
    y = t.b * direction.x + t.f * direction.y + t.j * direction.z;
    z = t.c * direction.x + t.g * direction.y + t.k * direction.z;
    if (z > -epsilon && z < epsilon) return -1;
    const time = -oz / z;
    if (time < 0) return -1;
    ox += x * time;
    oy += y * time;
    if (ox < -this.hs.x - epsilon || ox > this.hs.x + epsilon || oy < -this.hs.y - epsilon || oy > this.hs.y + epsilon) {
      return -1;
    }
    if (direction.x * t.c + direction.y * t.g + direction.z * t.k > 0) {
      normal.x = -t.c;
      normal.y = -t.g;
      normal.z = -t.k;
    } else {
      normal.x = t.c;
      normal.y = t.g;
      normal.z = t.k;
    }
    return time;
  }
}

export class CollisionTriangle extends CollisionShape {
  v0 = new Vector3(); // §=!]§
  v1 = new Vector3(); // § "4§
  v2 = new Vector3(); // §+!z§
  e0 = new Vector3(); // §4!B§
  e1 = new Vector3(); // §4u§
  e2 = new Vector3(); // §8!z§

  constructor(v0: Vector3, v1: Vector3, v2: Vector3, collisionGroup: number, material: PhysicsMaterial) {
    super(CollisionShape.TRIANGLE, collisionGroup, material);
    this.initVertices(v0, v1, v2);
  }

  override calculateAABB(): AABB {
    const box = this.aabb;
    const t = this.transform;
    const eps = 0.005;
    const ex = eps * t.c;
    const ey = eps * t.g;
    const ez = eps * t.k;
    let p = this.v0.x * t.a + this.v0.y * t.b;
    box.minX = box.maxX = p + ex;
    let q = p - ex;
    if (q > box.maxX) box.maxX = q;
    else if (q < box.minX) box.minX = q;
    p = this.v0.x * t.e + this.v0.y * t.f;
    box.minY = box.maxY = p + ey;
    q = p - ey;
    if (q > box.maxY) box.maxY = q;
    else if (q < box.minY) box.minY = q;
    p = this.v0.x * t.i + this.v0.y * t.j;
    box.minZ = box.maxZ = p + ez;
    q = p - ez;
    if (q > box.maxZ) box.maxZ = q;
    else if (q < box.minZ) box.minZ = q;
    for (const v of [this.v1, this.v2]) {
      p = v.x * t.a + v.y * t.b;
      q = p + ex;
      if (q > box.maxX) box.maxX = q;
      else if (q < box.minX) box.minX = q;
      q = p - ex;
      if (q > box.maxX) box.maxX = q;
      else if (q < box.minX) box.minX = q;
      p = v.x * t.e + v.y * t.f;
      q = p + ey;
      if (q > box.maxY) box.maxY = q;
      else if (q < box.minY) box.minY = q;
      q = p - ey;
      if (q > box.maxY) box.maxY = q;
      else if (q < box.minY) box.minY = q;
      p = v.x * t.i + v.y * t.j;
      q = p + ez;
      if (q > box.maxZ) box.maxZ = q;
      else if (q < box.minZ) box.minZ = q;
      q = p - ez;
      if (q > box.maxZ) box.maxZ = q;
      else if (q < box.minZ) box.minZ = q;
    }
    box.minX += t.d;
    box.maxX += t.d;
    box.minY += t.h;
    box.maxY += t.h;
    box.minZ += t.l;
    box.maxZ += t.l;
    return box;
  }

  override raycast(origin: Vector3, direction: Vector3, epsilon: number, normal: Vector3): number {
    const t = this.transform;
    const dn = direction.x * t.c + direction.y * t.g + direction.z * t.k;
    if (dn < epsilon && dn > -epsilon) return -1;
    let x = origin.x - t.d;
    let y = origin.y - t.h;
    const z = origin.z - t.l;
    const on = x * t.c + y * t.g + z * t.k;
    const time = -on / dn;
    if (time < 0) return -1;
    const lx = x * t.a + y * t.e + z * t.i;
    const ly = x * t.b + y * t.f + z * t.j;
    x = lx + time * (direction.x * t.a + direction.y * t.e + direction.z * t.i);
    y = ly + time * (direction.x * t.b + direction.y * t.f + direction.z * t.j);
    if (
      this.e0.x * (y - this.v0.y) - this.e0.y * (x - this.v0.x) < 0 ||
      this.e1.x * (y - this.v1.y) - this.e1.y * (x - this.v1.x) < 0 ||
      this.e2.x * (y - this.v2.y) - this.e2.y * (x - this.v2.x) < 0
    ) {
      return -1;
    }
    if (direction.x * t.c + direction.y * t.g + direction.z * t.k > 0) {
      normal.x = -t.c;
      normal.y = -t.g;
      normal.z = -t.k;
    } else {
      normal.x = t.c;
      normal.y = t.g;
      normal.z = t.k;
    }
    return time;
  }

  override copyFrom(source: CollisionShape): CollisionShape {
    super.copyFrom(source);
    if (source instanceof CollisionTriangle) {
      this.v0.copy(source.v0);
      this.v1.copy(source.v1);
      this.v2.copy(source.v2);
      this.e0.copy(source.e0);
      this.e1.copy(source.e1);
      this.e2.copy(source.e2);
    }
    return this;
  }

  protected override createPrimitive(): CollisionShape {
    return new CollisionTriangle(this.v0, this.v1, this.v2, this.collisionGroup, this.material);
  }

  private initVertices(v0: Vector3, v1: Vector3, v2: Vector3): void {
    this.v0.copy(v0);
    this.v1.copy(v1);
    this.v2.copy(v2);
    this.e0.diff(v1, v0);
    this.e0.normalize();
    this.e1.diff(v2, v1);
    this.e1.normalize();
    this.e2.diff(v0, v2);
    this.e2.normalize();
  }
}

export class CollisionSphere extends CollisionShape {
  r = 0; // §[z§

  constructor(radius: number, collisionGroup: number, material: PhysicsMaterial) {
    super(CollisionShape.SPHERE, collisionGroup, material);
    this.r = radius;
  }

  override calculateAABB(): AABB {
    const box = this.aabb;
    const t = this.transform;
    box.maxX = t.d + this.r;
    box.minX = t.d - this.r;
    box.maxY = t.h + this.r;
    box.minY = t.h - this.r;
    box.maxZ = t.l + this.r;
    box.minZ = t.l - this.r;
    return box;
  }

  override raycast(origin: Vector3, direction: Vector3, _epsilon: number, _normal: Vector3): number {
    const t = this.transform;
    const x = origin.x - t.d;
    const y = origin.y - t.h;
    const z = origin.z - t.l;
    const b = direction.x * x + direction.y * y + direction.z * z;
    if (b > 0) return -1;
    const a = direction.x * direction.x + direction.y * direction.y + direction.z * direction.z;
    const d = b * b - a * (x * x + y * y + z * z - this.r * this.r);
    if (d < 0) return -1;
    return -(b + Math.sqrt(d)) / a;
  }

  override copyFrom(source: CollisionShape): CollisionShape {
    if (!(source instanceof CollisionSphere)) return this;
    super.copyFrom(source);
    this.r = source.r;
    return this;
  }

  protected override createPrimitive(): CollisionShape {
    return new CollisionSphere(this.r, this.collisionGroup, this.material);
  }
}

// 1:1 из alternativa/physics/collision/types/{AABB,RayHit}.as, alternativa/physics/PhysicsMaterial.as
// и интерфейсов фильтров. Имена полей — по AlternativaPhysics 2.0.1.0 (assets/physics_ref_src).
import { Vector3 } from '../math/Vector3.ts';
import type { Body } from '../Body.ts';
import type { CollisionShape } from './CollisionShape.ts';

export class AABB {
  minX = 1e308; // §@"?§
  minY = 1e308; // §^!#§
  minZ = 1e308; // §!%§
  maxX = -1e308; // §!!9§
  maxY = -1e308; // §+"Q§
  maxZ = -1e308; // §+D§

  setSize(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxY = maxY;
    this.maxZ = maxZ;
  }

  /** § !z§ */
  addBoundBox(box: AABB): void {
    this.minX = box.minX < this.minX ? box.minX : this.minX;
    this.minY = box.minY < this.minY ? box.minY : this.minY;
    this.minZ = box.minZ < this.minZ ? box.minZ : this.minZ;
    this.maxX = box.maxX > this.maxX ? box.maxX : this.maxX;
    this.maxY = box.maxY > this.maxY ? box.maxY : this.maxY;
    this.maxZ = box.maxZ > this.maxZ ? box.maxZ : this.maxZ;
  }

  addPoint(x: number, y: number, z: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
  }

  infinity(): void {
    this.minX = 1e308;
    this.minY = 1e308;
    this.minZ = 1e308;
    this.maxX = -1e308;
    this.maxY = -1e308;
    this.maxZ = -1e308;
  }

  intersects(box: AABB, epsilon: number): boolean {
    return !(
      this.minX > box.maxX + epsilon ||
      this.maxX < box.minX - epsilon ||
      this.minY > box.maxY + epsilon ||
      this.maxY < box.minY - epsilon ||
      this.minZ > box.maxZ + epsilon ||
      this.maxZ < box.minZ - epsilon
    );
  }

  copyFrom(box: AABB): void {
    this.minX = box.minX;
    this.minY = box.minY;
    this.minZ = box.minZ;
    this.maxX = box.maxX;
    this.maxY = box.maxY;
    this.maxZ = box.maxZ;
  }

  clone(): AABB {
    const box = new AABB();
    box.copyFrom(this);
    return box;
  }

  getSizeX(): number {
    return this.maxX - this.minX;
  }

  getSizeY(): number {
    return this.maxY - this.minY;
  }

  getSizeZ(): number {
    return this.maxZ - this.minZ;
  }
}

export class RayHit {
  shape: CollisionShape | null = null; // §9!q§
  position = new Vector3(); // §2J§
  normal = new Vector3(); // §-3§
  t = 0; // §+h§

  copy(hit: RayHit): void {
    this.shape = hit.shape;
    this.position.copy(hit.position);
    this.normal.copy(hit.normal);
    this.t = hit.t;
  }

  clear(): void {
    this.shape = null;
  }
}

export class PhysicsMaterial {
  static readonly DEFAULT = new PhysicsMaterial();

  restitution: number; // §#!k§
  friction: number; // §++§

  constructor(restitution = 0, friction = 0.3) {
    this.restitution = restitution;
    this.friction = friction;
  }
}

export interface BodyCollisionFilter {
  considerBodies(body1: Body, body2: Body): boolean;
}

export interface ICollisionFilter {
  considerCollision(shape: CollisionShape): boolean;
}

export interface IRayCollisionFilter {
  considerBody(body: Body): boolean;
}

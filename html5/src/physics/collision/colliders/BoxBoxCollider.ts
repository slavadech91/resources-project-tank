// 1:1 из alternativa/physics/collision/colliders/BoxBoxCollider.as
import { Matrix4 } from '../../math/Matrix4.ts';
import { Vector3 } from '../../math/Vector3.ts';
import type { Collider, ShapeContact } from '../../Contacts.ts';
import type { CollisionBox, CollisionShape } from '../CollisionShape.ts';
import { ColliderUtils, createVertices, FaceSide, PolygonsIntersectionUtils } from './ColliderUtils.ts';

const axis = new Vector3(); // §-!w§
const axis10 = new Vector3(); // §<D§
const axis11 = new Vector3(); // §7+§
const axis12 = new Vector3(); // §@!9§
const axis20 = new Vector3(); // §`,§
const axis21 = new Vector3(); // §`!l§
const axis22 = new Vector3(); // §-P§
const toBox1 = new Vector3(); // §?!&§
const face1 = createVertices(4); // §,!L§
const face2 = createVertices(4); // §3"[§
const basis = new Matrix4(); // §`!K§

export class BoxBoxCollider implements Collider {
  private readonly epsilon: number; // §`3§
  private readonly bestAxis = new Vector3(); // §7w§
  private minOverlap = 0; // §<"$§

  constructor(epsilon: number) {
    this.epsilon = epsilon;
  }

  getContacts(shape1: CollisionShape, shape2: CollisionShape, result: ShapeContact[]): void {
    if (this.haveCollision(shape1, shape2)) {
      this.findContacts(shape1 as CollisionBox, shape2 as CollisionBox, this.bestAxis, result);
    }
  }

  haveCollision(shape1: CollisionShape, shape2: CollisionShape): boolean {
    this.minOverlap = 10000000000;
    const box1 = shape1 as CollisionBox;
    const box2 = shape2 as CollisionBox;
    const t1 = box1.transform;
    const t2 = box2.transform;
    const delta = toBox1;
    delta.x = t1.d - t2.d;
    delta.y = t1.h - t2.h;
    delta.z = t1.l - t2.l;
    axis10.x = t1.a;
    axis10.y = t1.e;
    axis10.z = t1.i;
    if (!this.testOverlapOnMainAxis(box1, box2, axis10, delta)) return false;
    axis11.x = t1.b;
    axis11.y = t1.f;
    axis11.z = t1.j;
    if (!this.testOverlapOnMainAxis(box1, box2, axis11, delta)) return false;
    axis12.x = t1.c;
    axis12.y = t1.g;
    axis12.z = t1.k;
    if (!this.testOverlapOnMainAxis(box1, box2, axis12, delta)) return false;
    axis20.x = t2.a;
    axis20.y = t2.e;
    axis20.z = t2.i;
    if (!this.testOverlapOnMainAxis(box1, box2, axis20, delta)) return false;
    axis21.x = t2.b;
    axis21.y = t2.f;
    axis21.z = t2.j;
    if (!this.testOverlapOnMainAxis(box1, box2, axis21, delta)) return false;
    axis22.x = t2.c;
    axis22.y = t2.g;
    axis22.z = t2.k;
    if (!this.testOverlapOnMainAxis(box1, box2, axis22, delta)) return false;
    if (!this.testOverlapOnDerivedAxis(box1, box2, axis10, axis20, delta)) return false;
    if (!this.testOverlapOnDerivedAxis(box1, box2, axis10, axis21, delta)) return false;
    if (!this.testOverlapOnDerivedAxis(box1, box2, axis10, axis22, delta)) return false;
    if (!this.testOverlapOnDerivedAxis(box1, box2, axis11, axis20, delta)) return false;
    if (!this.testOverlapOnDerivedAxis(box1, box2, axis11, axis21, delta)) return false;
    if (!this.testOverlapOnDerivedAxis(box1, box2, axis11, axis22, delta)) return false;
    if (!this.testOverlapOnDerivedAxis(box1, box2, axis12, axis20, delta)) return false;
    if (!this.testOverlapOnDerivedAxis(box1, box2, axis12, axis21, delta)) return false;
    return this.testOverlapOnDerivedAxis(box1, box2, axis12, axis22, delta);
  }

  private testOverlapOnMainAxis(box1: CollisionBox, box2: CollisionBox, a: Vector3, delta: Vector3): boolean {
    const overlap = this.getOverlapOnAxis(box1, box2, a, delta);
    return this.registerOverlap(overlap, a);
  }

  private testOverlapOnDerivedAxis(box1: CollisionBox, box2: CollisionBox, a1: Vector3, a2: Vector3, delta: Vector3): boolean {
    const a = axis;
    a.x = a1.y * a2.z - a1.z * a2.y;
    a.y = a1.z * a2.x - a1.x * a2.z;
    a.z = a1.x * a2.y - a1.y * a2.x;
    const lengthSqr = a.x * a.x + a.y * a.y + a.z * a.z;
    if (lengthSqr < 1e-10) return true;
    const k = 1 / Math.sqrt(lengthSqr);
    a.x *= k;
    a.y *= k;
    a.z *= k;
    const overlap = this.getOverlapOnAxis(box1, box2, a, delta);
    return this.registerOverlap(overlap, a);
  }

  private registerOverlap(overlap: number, a: Vector3): boolean {
    if (overlap < this.epsilon) return false;
    if (overlap + this.epsilon < this.minOverlap) {
      this.minOverlap = overlap;
      this.bestAxis.x = a.x;
      this.bestAxis.y = a.y;
      this.bestAxis.z = a.z;
    }
    return true;
  }

  getOverlapOnAxis(box1: CollisionBox, box2: CollisionBox, a: Vector3, delta: Vector3): number {
    let t = box1.transform;
    let p = (t.a * a.x + t.e * a.y + t.i * a.z) * box1.hs.x;
    if (p < 0) p = -p;
    let sum = p;
    p = (t.b * a.x + t.f * a.y + t.j * a.z) * box1.hs.y;
    if (p < 0) p = -p;
    sum += p;
    p = (t.c * a.x + t.g * a.y + t.k * a.z) * box1.hs.z;
    if (p < 0) p = -p;
    sum += p;
    t = box2.transform;
    p = (t.a * a.x + t.e * a.y + t.i * a.z) * box2.hs.x;
    if (p < 0) p = -p;
    sum += p;
    p = (t.b * a.x + t.f * a.y + t.j * a.z) * box2.hs.y;
    if (p < 0) p = -p;
    sum += p;
    p = (t.c * a.x + t.g * a.y + t.k * a.z) * box2.hs.z;
    if (p < 0) p = -p;
    sum += p;
    p = delta.x * a.x + delta.y * a.y + delta.z * a.z;
    if (p < 0) p = -p;
    return sum - p;
  }

  private findContacts(box1: CollisionBox, box2: CollisionBox, normal: Vector3, result: ShapeContact[]): void {
    const t1 = box1.transform;
    const t2 = box2.transform;
    const delta = toBox1;
    delta.x = t1.d - t2.d;
    delta.y = t1.h - t2.h;
    delta.z = t1.l - t2.l;
    if (normal.x * delta.x + normal.y * delta.y + normal.z * delta.z < 0) {
      normal.x = -normal.x;
      normal.y = -normal.y;
      normal.z = -normal.z;
    }
    ColliderUtils.buildContactBasis(normal, t1, t2, basis);
    ColliderUtils.getBoxFaceVerticesInCCWOrder(box1, normal, FaceSide.BACK, face1);
    ColliderUtils.getBoxFaceVerticesInCCWOrder(box2, normal, FaceSide.FRONT, face2);
    ColliderUtils.transformFaceToReferenceSpace(basis, box1.transform, face1, 4);
    ColliderUtils.transformFaceToReferenceSpace(basis, box2.transform, face2, 4);
    PolygonsIntersectionUtils.findContacts(box1, face1, 4, box2, face2, 4, basis, result);
  }
}

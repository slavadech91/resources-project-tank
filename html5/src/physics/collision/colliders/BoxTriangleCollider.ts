// 1:1 из alternativa/physics/collision/colliders/BoxTriangleCollider.as
import { Matrix4 } from '../../math/Matrix4.ts';
import { Vector3 } from '../../math/Vector3.ts';
import type { Collider, ShapeContact } from '../../Contacts.ts';
import { CollisionBox, type CollisionShape, type CollisionTriangle } from '../CollisionShape.ts';
import { ColliderUtils, createVertices, FaceSide, PolygonsIntersectionUtils } from './ColliderUtils.ts';

export class BoxTriangleCollider implements Collider {
  epsilon: number; // §`3§
  private minOverlap = 0; // §<"$§
  private readonly toBox = new Vector3(); // §9!x§
  private readonly axis = new Vector3(); // §-m§
  private readonly boxAxisX = new Vector3(); // §4!?§
  private readonly boxAxisY = new Vector3(); // §!"D§
  private readonly boxAxisZ = new Vector3(); // §=!l§
  private readonly edge0 = new Vector3(); // §,!`§
  private readonly edge1 = new Vector3(); // §<Q§
  private readonly edge2 = new Vector3(); // §`1§
  private readonly bestAxis = new Vector3(); // §7w§
  private readonly basis = new Matrix4(); // §`!K§
  private readonly boxFace = createVertices(4); // §>"+§
  private readonly triangleFace = createVertices(3); // §<'§

  constructor(epsilon: number) {
    this.epsilon = epsilon;
  }

  getContacts(shape1: CollisionShape, shape2: CollisionShape, result: ShapeContact[]): void {
    if (!this.haveCollision(shape1, shape2)) return;
    let box: CollisionBox;
    let triangle: CollisionTriangle;
    if (shape1 instanceof CollisionBox) {
      box = shape1;
      triangle = shape2 as CollisionTriangle;
    } else {
      box = shape2 as CollisionBox;
      triangle = shape1 as CollisionTriangle;
    }
    this.findContacts(box, triangle, this.bestAxis, result);
  }

  haveCollision(shape1: CollisionShape, shape2: CollisionShape): boolean {
    let box: CollisionBox;
    let triangle: CollisionTriangle;
    if (shape1 instanceof CollisionBox) {
      box = shape1;
      triangle = shape2 as CollisionTriangle;
    } else {
      box = shape2 as CollisionBox;
      triangle = shape1 as CollisionTriangle;
    }
    const tb = box.transform;
    const tt = triangle.transform;
    this.toBox.x = tb.d - tt.d;
    this.toBox.y = tb.h - tt.h;
    this.toBox.z = tb.l - tt.l;
    this.minOverlap = 10000000000;
    this.axis.x = tt.c;
    this.axis.y = tt.g;
    this.axis.z = tt.k;
    if (!this.testOverlapOnMainAxis(box, triangle, this.axis, this.toBox)) return false;
    this.boxAxisX.x = tb.a;
    this.boxAxisX.y = tb.e;
    this.boxAxisX.z = tb.i;
    if (!this.testOverlapOnMainAxis(box, triangle, this.boxAxisX, this.toBox)) return false;
    this.boxAxisY.x = tb.b;
    this.boxAxisY.y = tb.f;
    this.boxAxisY.z = tb.j;
    if (!this.testOverlapOnMainAxis(box, triangle, this.boxAxisY, this.toBox)) return false;
    this.boxAxisZ.x = tb.c;
    this.boxAxisZ.y = tb.g;
    this.boxAxisZ.z = tb.k;
    if (!this.testOverlapOnMainAxis(box, triangle, this.boxAxisZ, this.toBox)) return false;
    let e = triangle.e0;
    this.edge0.x = tt.a * e.x + tt.b * e.y + tt.c * e.z;
    this.edge0.y = tt.e * e.x + tt.f * e.y + tt.g * e.z;
    this.edge0.z = tt.i * e.x + tt.j * e.y + tt.k * e.z;
    if (!this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisX, this.edge0, this.toBox)) return false;
    if (!this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisY, this.edge0, this.toBox)) return false;
    if (!this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisZ, this.edge0, this.toBox)) return false;
    e = triangle.e1;
    this.edge1.x = tt.a * e.x + tt.b * e.y + tt.c * e.z;
    this.edge1.y = tt.e * e.x + tt.f * e.y + tt.g * e.z;
    this.edge1.z = tt.i * e.x + tt.j * e.y + tt.k * e.z;
    if (!this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisX, this.edge1, this.toBox)) return false;
    if (!this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisY, this.edge1, this.toBox)) return false;
    if (!this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisZ, this.edge1, this.toBox)) return false;
    e = triangle.e2;
    this.edge2.x = tt.a * e.x + tt.b * e.y + tt.c * e.z;
    this.edge2.y = tt.e * e.x + tt.f * e.y + tt.g * e.z;
    this.edge2.z = tt.i * e.x + tt.j * e.y + tt.k * e.z;
    if (!this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisX, this.edge2, this.toBox)) return false;
    if (!this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisY, this.edge2, this.toBox)) return false;
    return this.testOverlapOnDerivedAxis(box, triangle, this.boxAxisZ, this.edge2, this.toBox);
  }

  private testOverlapOnMainAxis(box: CollisionBox, triangle: CollisionTriangle, a: Vector3, delta: Vector3): boolean {
    const overlap = this.getOverlapOnAxis(box, triangle, a, delta);
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

  private testOverlapOnDerivedAxis(box: CollisionBox, triangle: CollisionTriangle, a1: Vector3, a2: Vector3, delta: Vector3): boolean {
    const a = this.axis;
    a.x = a1.y * a2.z - a1.z * a2.y;
    a.y = a1.z * a2.x - a1.x * a2.z;
    a.z = a1.x * a2.y - a1.y * a2.x;
    const lengthSqr = a.x * a.x + a.y * a.y + a.z * a.z;
    if (lengthSqr < 1e-10) return true;
    const k = 1 / Math.sqrt(lengthSqr);
    a.x *= k;
    a.y *= k;
    a.z *= k;
    const overlap = this.getOverlapOnAxis(box, triangle, a, delta);
    return this.registerOverlap(overlap, a);
  }

  private getOverlapOnAxis(box: CollisionBox, triangle: CollisionTriangle, a: Vector3, delta: Vector3): number {
    const t = box.transform;
    const hs = box.hs;
    let boxProjection = 0;
    let p = (t.a * a.x + t.e * a.y + t.i * a.z) * hs.x;
    if (p < 0) boxProjection -= p;
    else boxProjection += p;
    p = (t.b * a.x + t.f * a.y + t.j * a.z) * hs.y;
    if (p < 0) boxProjection -= p;
    else boxProjection += p;
    p = (t.c * a.x + t.g * a.y + t.k * a.z) * hs.z;
    if (p < 0) boxProjection -= p;
    else boxProjection += p;
    let distance = delta.x * a.x + delta.y * a.y + delta.z * a.z;
    const tt = triangle.transform;
    const ax = tt.a * a.x + tt.e * a.y + tt.i * a.z;
    const ay = tt.b * a.x + tt.f * a.y + tt.j * a.z;
    const az = tt.c * a.x + tt.g * a.y + tt.k * a.z;
    let triangleProjection = 0;
    const v0 = triangle.v0;
    const v1 = triangle.v1;
    const v2 = triangle.v2;
    if (distance < 0) {
      distance = -distance;
      p = v0.x * ax + v0.y * ay + v0.z * az;
      if (p < triangleProjection) triangleProjection = p;
      p = v1.x * ax + v1.y * ay + v1.z * az;
      if (p < triangleProjection) triangleProjection = p;
      p = v2.x * ax + v2.y * ay + v2.z * az;
      if (p < triangleProjection) triangleProjection = p;
      triangleProjection = -triangleProjection;
    } else {
      p = v0.x * ax + v0.y * ay + v0.z * az;
      if (p > triangleProjection) triangleProjection = p;
      p = v1.x * ax + v1.y * ay + v1.z * az;
      if (p > triangleProjection) triangleProjection = p;
      p = v2.x * ax + v2.y * ay + v2.z * az;
      if (p > triangleProjection) triangleProjection = p;
    }
    return boxProjection + triangleProjection - distance;
  }

  private findContacts(box: CollisionBox, triangle: CollisionTriangle, normal: Vector3, result: ShapeContact[]): void {
    const tb = box.transform;
    const tt = triangle.transform;
    const delta = this.toBox;
    delta.x = tb.d - tt.d;
    delta.y = tb.h - tt.h;
    delta.z = tb.l - tt.l;
    if (normal.x * delta.x + normal.y * delta.y + normal.z * delta.z < 0) {
      normal.x = -normal.x;
      normal.y = -normal.y;
      normal.z = -normal.z;
    }
    const basis = this.basis;
    ColliderUtils.buildContactBasis(normal, tb, tt, basis);
    ColliderUtils.getBoxFaceVerticesInCCWOrder(box, normal, FaceSide.BACK, this.boxFace);
    ColliderUtils.getTriangleFaceInCCWOrder(triangle, normal, this.triangleFace);
    ColliderUtils.transformFaceToReferenceSpace(basis, tb, this.boxFace, 4);
    ColliderUtils.transformFaceToReferenceSpace(basis, tt, this.triangleFace, 3);
    const start = result.length;
    PolygonsIntersectionUtils.findContacts(box, this.boxFace, 4, triangle, this.triangleFace, 3, basis, result);
    let end = result.length;
    for (let n = start; n < end; n++) {
      const contact = result[n];
      const contactNormal = contact.normal;
      if (contactNormal.x * tt.c + contactNormal.y * tt.g + contactNormal.z * tt.k < 0) {
        contact.dispose();
        end--;
        result[n] = result[end];
        result[end] = null as unknown as ShapeContact;
        n--;
      }
    }
    if (end < result.length) result.length = end;
  }
}

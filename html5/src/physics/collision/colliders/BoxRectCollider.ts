// 1:1 из alternativa/physics/collision/colliders/BoxRectCollider.as
import { Matrix4 } from '../../math/Matrix4.ts';
import { Vector3 } from '../../math/Vector3.ts';
import type { Collider, ShapeContact } from '../../Contacts.ts';
import { CollisionBox, CollisionRect, type CollisionShape } from '../CollisionShape.ts';
import { ColliderUtils, createVertices, FaceSide, PolygonsIntersectionUtils } from './ColliderUtils.ts';

const boxFace = createVertices(4); // §>"+§
const rectFace = createVertices(4); // §`!-§
const basis = new Matrix4(); // §`!K§

export class BoxRectCollider implements Collider {
  private readonly toBox = new Vector3(); // §?!&§
  private readonly axis = new Vector3(); // §-!w§
  private readonly boxAxisX = new Vector3(); // §4!?§
  private readonly boxAxisY = new Vector3(); // §!"D§
  private readonly boxAxisZ = new Vector3(); // §=!l§
  private readonly rectAxisX = new Vector3(); // §,!`§
  private readonly rectAxisY = new Vector3(); // §<Q§
  private readonly rectNormal = new Vector3(); // §`1§
  private readonly bestAxis = new Vector3(); // §7w§
  private minOverlap = 0; // §<"$§
  private readonly epsilon: number; // §`3§

  constructor(epsilon: number) {
    this.epsilon = epsilon;
  }

  getContacts(shape1: CollisionShape, shape2: CollisionShape, result: ShapeContact[]): void {
    if (this.haveCollision(shape1, shape2)) {
      let rect: CollisionRect;
      let box: CollisionBox;
      if (shape1 instanceof CollisionRect) {
        rect = shape1;
        box = shape2 as CollisionBox;
      } else {
        rect = shape2 as CollisionRect;
        box = shape1 as CollisionBox;
      }
      this.findContacts(box, rect, this.bestAxis, result);
    }
  }

  haveCollision(shape1: CollisionShape, shape2: CollisionShape): boolean {
    let box: CollisionBox;
    let rect: CollisionRect;
    this.minOverlap = 10000000000;
    if (shape1 instanceof CollisionBox) {
      box = shape1;
      rect = shape2 as CollisionRect;
    } else {
      box = shape2 as CollisionBox;
      rect = shape1 as CollisionRect;
    }
    const tb = box.transform;
    const tr = rect.transform;
    this.toBox.x = tb.d - tr.d;
    this.toBox.y = tb.h - tr.h;
    this.toBox.z = tb.l - tr.l;
    this.rectNormal.x = tr.c;
    this.rectNormal.y = tr.g;
    this.rectNormal.z = tr.k;
    if (!this.testMainAxis(box, rect, this.rectNormal, this.toBox)) return false;
    this.boxAxisX.x = tb.a;
    this.boxAxisX.y = tb.e;
    this.boxAxisX.z = tb.i;
    if (!this.testMainAxis(box, rect, this.boxAxisX, this.toBox)) return false;
    this.boxAxisY.x = tb.b;
    this.boxAxisY.y = tb.f;
    this.boxAxisY.z = tb.j;
    if (!this.testMainAxis(box, rect, this.boxAxisY, this.toBox)) return false;
    this.boxAxisZ.x = tb.c;
    this.boxAxisZ.y = tb.g;
    this.boxAxisZ.z = tb.k;
    if (!this.testMainAxis(box, rect, this.boxAxisZ, this.toBox)) return false;
    this.rectAxisX.x = tr.a;
    this.rectAxisX.y = tr.e;
    this.rectAxisX.z = tr.i;
    this.rectAxisY.x = tr.b;
    this.rectAxisY.y = tr.f;
    this.rectAxisY.z = tr.j;
    if (!this.testDerivedAxis(box, rect, this.boxAxisX, this.rectAxisX, this.toBox)) return false;
    if (!this.testDerivedAxis(box, rect, this.boxAxisX, this.rectAxisY, this.toBox)) return false;
    if (!this.testDerivedAxis(box, rect, this.boxAxisY, this.rectAxisX, this.toBox)) return false;
    if (!this.testDerivedAxis(box, rect, this.boxAxisY, this.rectAxisY, this.toBox)) return false;
    if (!this.testDerivedAxis(box, rect, this.boxAxisZ, this.rectAxisX, this.toBox)) return false;
    if (!this.testDerivedAxis(box, rect, this.boxAxisZ, this.rectAxisY, this.toBox)) return false;
    return true;
  }

  private testMainAxis(box: CollisionBox, rect: CollisionRect, a: Vector3, delta: Vector3): boolean {
    const overlap = this.getOverlapOnAxis(box, rect, a, delta);
    return this.registerOverlap(overlap, a);
  }

  private testDerivedAxis(box: CollisionBox, rect: CollisionRect, a1: Vector3, a2: Vector3, delta: Vector3): boolean {
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
    const overlap = this.getOverlapOnAxis(box, rect, a, delta);
    return this.registerOverlap(overlap, a);
  }

  private getOverlapOnAxis(box: CollisionBox, rect: CollisionRect, a: Vector3, delta: Vector3): number {
    let t = box.transform;
    let p = (t.a * a.x + t.e * a.y + t.i * a.z) * box.hs.x;
    if (p < 0) p = -p;
    let sum = p;
    p = (t.b * a.x + t.f * a.y + t.j * a.z) * box.hs.y;
    if (p < 0) p = -p;
    sum += p;
    p = (t.c * a.x + t.g * a.y + t.k * a.z) * box.hs.z;
    if (p < 0) p = -p;
    sum += p;
    t = rect.transform;
    p = (t.a * a.x + t.e * a.y + t.i * a.z) * rect.hs.x;
    if (p < 0) p = -p;
    sum += p;
    p = (t.b * a.x + t.f * a.y + t.j * a.z) * rect.hs.y;
    if (p < 0) p = -p;
    sum += p;
    p = delta.x * a.x + delta.y * a.y + delta.z * a.z;
    if (p < 0) p = -p;
    return sum - p;
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

  private findContacts(box: CollisionBox, rect: CollisionRect, normal: Vector3, result: ShapeContact[]): void {
    const tb = box.transform;
    const tr = rect.transform;
    const delta = this.toBox;
    delta.x = tb.d - tr.d;
    delta.y = tb.h - tr.h;
    delta.z = tb.l - tr.l;
    if (normal.x * delta.x + normal.y * delta.y + normal.z * delta.z < 0) {
      normal.x = -normal.x;
      normal.y = -normal.y;
      normal.z = -normal.z;
    }
    ColliderUtils.buildContactBasis(normal, tb, tr, basis);
    ColliderUtils.getBoxFaceVerticesInCCWOrder(box, normal, FaceSide.BACK, boxFace);
    ColliderUtils.getRectFaceInCCWOrder(rect, normal, rectFace);
    ColliderUtils.transformFaceToReferenceSpace(basis, tb, boxFace, 4);
    ColliderUtils.transformFaceToReferenceSpace(basis, tr, rectFace, 4);
    const start = result.length;
    PolygonsIntersectionUtils.findContacts(box, boxFace, 4, rect, rectFace, 4, basis, result);
    let end = result.length;
    for (let n = start; n < end; n++) {
      const contact = result[n];
      const contactNormal = contact.normal;
      const nx = tr.c;
      const ny = tr.g;
      const nz = tr.k;
      // контакт с обратной стороной прямоугольника отбрасывается
      if (contactNormal.x * nx + contactNormal.y * ny + contactNormal.z * nz < 0) {
        contact.dispose();
        end--;
        result[n] = result[end];
        result[end] = null as unknown as ShapeContact;
        n--;
      } else if (Math.abs(tr.k) > 0.999) {
        contactNormal.x = nx;
        contactNormal.y = ny;
        contactNormal.z = nz;
      }
    }
    if (end < result.length) result.length = end;
  }
}

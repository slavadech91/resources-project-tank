// 1:1 из alternativa/physics/collision/colliders/{ColliderUtils,FaceSide,Vertex,PolygonsIntersectionUtils}.as
import type { Matrix4 } from '../../math/Matrix4.ts';
import { Vector3 } from '../../math/Vector3.ts';
import { ShapeContact } from '../../Contacts.ts';
import type { CollisionBox, CollisionRect, CollisionShape, CollisionTriangle } from '../CollisionShape.ts';

export class Vertex {
  readonly local = new Vector3(); // §`!R§ — в координатах фигуры
  readonly world = new Vector3(); // §=!y§
  readonly reference = new Vector3(); // §+m§ — в базисе контакта
}

export class FaceSide {
  static readonly FRONT = new FaceSide(); // §;"2§
  static readonly BACK = new FaceSide(); // §5![§
}

export function createVertices(count: number): Vertex[] {
  const result: Vertex[] = [];
  for (let n = 0; n < count; n++) result.push(new Vertex());
  return result;
}

export class ColliderUtils {
  private static readonly axis1 = new Vector3(); // §,N§
  private static readonly axis2 = new Vector3(); // §3!6§

  static buildContactBasis(normal: Vector3, _transform1: Matrix4, _transform2: Matrix4, basis: Matrix4): void {
    const x = ColliderUtils.axis1;
    const y = ColliderUtils.axis2;
    if (Math.abs(normal.x) < Math.abs(normal.y)) {
      x.x = 0;
      x.y = normal.z;
      x.z = -normal.y;
    } else {
      x.x = -normal.z;
      x.y = 0;
      x.z = normal.x;
    }
    x.normalize();
    y.x = normal.y * x.z - normal.z * x.y;
    y.y = normal.z * x.x - normal.x * x.z;
    y.z = normal.x * x.y - normal.y * x.x;
    basis.a = x.x;
    basis.e = x.y;
    basis.i = x.z;
    basis.b = y.x;
    basis.f = y.y;
    basis.j = y.z;
    basis.c = normal.x;
    basis.g = normal.y;
    basis.k = normal.z;
  }

  static transformFaceToReferenceSpace(basis: Matrix4, shapeTransform: Matrix4, vertices: Vertex[], count: number): void {
    for (let n = 0; n < count; n++) {
      const vertex = vertices[n];
      shapeTransform.transformVector(vertex.local, vertex.world);
      basis.transformVectorInverse(vertex.world, vertex.reference);
    }
  }

  static getBoxFaceVerticesInCCWOrder(box: CollisionBox, direction: Vector3, side: FaceSide, vertices: Vertex[]): void {
    const t = box.transform;
    let axis = 0;
    let x = t.a;
    let y = t.e;
    let z = t.i;
    let projection = x * direction.x + y * direction.y + z * direction.z;
    let maxAbs = Math.abs(projection);
    x = t.b;
    y = t.f;
    z = t.j;
    let p = x * direction.x + y * direction.y + z * direction.z;
    let abs = Math.abs(p);
    if (abs > maxAbs) {
      maxAbs = abs;
      projection = p;
      axis = 1;
    }
    x = t.c;
    y = t.g;
    z = t.k;
    p = x * direction.x + y * direction.y + z * direction.z;
    abs = Math.abs(p);
    if (abs > maxAbs) {
      projection = p;
      axis = 2;
    }
    let sign = projection > 0 ? 1 : -1;
    if (side == FaceSide.BACK) sign = -sign;
    const hs = box.hs;
    let v: Vector3;
    switch (axis) {
      case 0:
        v = vertices[0].local;
        v.x = sign * hs.x;
        v.y = hs.y;
        v.z = hs.z;
        v = vertices[1].local;
        v.x = sign * hs.x;
        v.y = -hs.y;
        v.z = hs.z;
        v = vertices[2].local;
        v.x = sign * hs.x;
        v.y = -hs.y;
        v.z = -hs.z;
        v = vertices[3].local;
        v.x = sign * hs.x;
        v.y = hs.y;
        v.z = -hs.z;
        break;
      case 1:
        v = vertices[0].local;
        v.x = hs.x;
        v.y = sign * hs.y;
        v.z = hs.z;
        v = vertices[1].local;
        v.x = hs.x;
        v.y = sign * hs.y;
        v.z = -hs.z;
        v = vertices[2].local;
        v.x = -hs.x;
        v.y = sign * hs.y;
        v.z = -hs.z;
        v = vertices[3].local;
        v.x = -hs.x;
        v.y = sign * hs.y;
        v.z = hs.z;
        break;
      case 2:
        v = vertices[0].local;
        v.x = hs.x;
        v.y = hs.y;
        v.z = sign * hs.z;
        v = vertices[1].local;
        v.x = -hs.x;
        v.y = hs.y;
        v.z = sign * hs.z;
        v = vertices[2].local;
        v.x = -hs.x;
        v.y = -hs.y;
        v.z = sign * hs.z;
        v = vertices[3].local;
        v.x = hs.x;
        v.y = -hs.y;
        v.z = sign * hs.z;
        break;
      default:
        throw new Error();
    }
    if (projection < 0) {
      let swap = vertices[0];
      vertices[0] = vertices[3];
      vertices[3] = swap;
      swap = vertices[1];
      vertices[1] = vertices[2];
      vertices[2] = swap;
    }
  }

  static getRectFaceInCCWOrder(rect: CollisionRect, direction: Vector3, vertices: Vertex[]): void {
    const hs = rect.hs;
    let vertex = vertices[0];
    vertex.local.x = hs.x;
    vertex.local.y = hs.y;
    vertex.local.z = 0;
    vertex = vertices[1];
    vertex.local.x = -hs.x;
    vertex.local.y = hs.y;
    vertex.local.z = 0;
    vertex = vertices[2];
    vertex.local.x = -hs.x;
    vertex.local.y = -hs.y;
    vertex.local.z = 0;
    vertex = vertices[3];
    vertex.local.x = hs.x;
    vertex.local.y = -hs.y;
    vertex.local.z = 0;
    const t = rect.transform;
    const projection = direction.x * t.c + direction.y * t.g + direction.z * t.k;
    if (projection < 0) {
      vertex = vertices[0];
      vertices[0] = vertices[3];
      vertices[3] = vertex;
      vertex = vertices[1];
      vertices[1] = vertices[2];
      vertices[2] = vertex;
    }
  }

  static getTriangleFaceInCCWOrder(triangle: CollisionTriangle, direction: Vector3, vertices: Vertex[]): void {
    let vertex = vertices[0];
    vertex.local.x = triangle.v0.x;
    vertex.local.y = triangle.v0.y;
    vertex.local.z = 0;
    vertex = vertices[1];
    vertex.local.x = triangle.v1.x;
    vertex.local.y = triangle.v1.y;
    vertex.local.z = 0;
    vertex = vertices[2];
    vertex.local.x = triangle.v2.x;
    vertex.local.y = triangle.v2.y;
    vertex.local.z = 0;
    const t = triangle.transform;
    const projection = direction.x * t.c + direction.y * t.g + direction.z * t.k;
    if (projection < 0) {
      vertex = vertices[0];
      vertices[0] = vertices[2];
      vertices[2] = vertex;
    }
  }
}

interface Point {
  x: number;
  y: number;
}

function points(count: number): Point[] {
  const result: Point[] = [];
  for (let n = 0; n < count; n++) result.push({ x: 0, y: 0 });
  return result;
}

export class PolygonsIntersectionUtils {
  private static readonly projected1 = points(8); // §6"R§
  private static readonly projected2 = points(8); // §0!"§
  private static readonly intersection = points(8); // §6§
  private static clipSource = points(8); // §`!c§
  private static clipTarget = points(8); // §1!h§
  private static readonly crossing: Point = { x: 0, y: 0 }; // §]q§
  private static readonly normal1 = new Vector3(); // §&"W§
  private static readonly normal2 = new Vector3(); // §3"+§

  static findContacts(
    shape1: CollisionShape,
    face1: Vertex[],
    count1: number,
    shape2: CollisionShape,
    face2: Vertex[],
    count2: number,
    basis: Matrix4,
    result: ShapeContact[],
  ): void {
    const P = PolygonsIntersectionUtils;
    P.calculateFaceNormal(face1, P.normal1);
    P.calculateFaceNormal(face2, P.normal2);
    P.fillProjectedPoints(face1, count1, P.projected1);
    P.fillProjectedPoints(face2, count2, P.projected2);
    const count = P.findPolygonsIntersection(P.projected1, count1, P.projected2, count2, P.intersection);
    for (let n = 0; n < count; n++) {
      const point = P.intersection[n];
      const z1 = P.getFaceZ(point, face1[0].reference, P.normal1);
      const z2 = P.getFaceZ(point, face2[0].reference, P.normal2);
      if (z2 > z1) {
        const contact = ShapeContact.create();
        contact.shape1 = shape1;
        contact.shape2 = shape2;
        const position = contact.position;
        position.x = point.x;
        position.y = point.y;
        position.z = 0.5 * (z1 + z2);
        position.transform4(basis);
        contact.penetration = z2 - z1;
        contact.normal.x = basis.c;
        contact.normal.y = basis.g;
        contact.normal.z = basis.k;
        result[result.length] = contact;
      }
    }
  }

  private static calculateFaceNormal(face: Vertex[], result: Vector3): void {
    const p0 = face[0].reference;
    const p1 = face[1].reference;
    const p2 = face[2].reference;
    const ax = p1.x - p0.x;
    const ay = p1.y - p0.y;
    const az = p1.z - p0.z;
    const bx = p2.x - p0.x;
    const by = p2.y - p0.y;
    const bz = p2.z - p0.z;
    result.x = ay * bz - az * by;
    result.y = az * bx - ax * bz;
    result.z = ax * by - ay * bx;
    result.normalize();
  }

  private static fillProjectedPoints(face: Vertex[], count: number, result: Point[]): void {
    for (let n = 0; n < count; n++) {
      const vertex = face[n];
      const point = result[n];
      point.x = vertex.reference.x;
      point.y = vertex.reference.y;
    }
  }

  private static findPolygonsIntersection(polygon1: Point[], count1: number, polygon2: Point[], count2: number, result: Point[]): number {
    const P = PolygonsIntersectionUtils;
    P.copyPoints(polygon2, P.clipSource, count2);
    let count = count2;
    let previous = polygon1[count1 - 1];
    for (let n = 0; n < count1; n++) {
      const current = polygon1[n];
      count = P.clip(previous, current, P.clipSource, P.clipTarget, count);
      if (count == 0) break;
      previous = current;
      const swap = P.clipSource;
      P.clipSource = P.clipTarget;
      P.clipTarget = swap;
    }
    P.copyPoints(P.clipSource, result, count);
    return count;
  }

  private static copyPoints(source: Point[], target: Point[], count: number): void {
    for (let n = 0; n < count; n++) {
      target[n].x = source[n].x;
      target[n].y = source[n].y;
    }
  }

  private static clip(edgeStart: Point, edgeEnd: Point, source: Point[], target: Point[], count: number): number {
    const P = PolygonsIntersectionUtils;
    let previous = source[count - 1];
    let previousInside = P.arePointsCCW(edgeStart, edgeEnd, previous);
    let resultCount = 0;
    for (let n = 0; n < count; n++) {
      const current = source[n];
      const currentInside = P.arePointsCCW(edgeStart, edgeEnd, current);
      if (currentInside) {
        if (!previousInside) {
          P.calculateIntersection(edgeStart, edgeEnd, previous, current, P.crossing);
          P.setPoint(P.crossing, target, resultCount++);
        }
        P.setPoint(current, target, resultCount++);
      } else if (previousInside) {
        P.calculateIntersection(edgeStart, edgeEnd, previous, current, P.crossing);
        P.setPoint(P.crossing, target, resultCount++);
      }
      previousInside = currentInside;
      previous = current;
    }
    return resultCount;
  }

  private static setPoint(point: Point, target: Point[], index: number): void {
    const p = target[index];
    p.x = point.x;
    p.y = point.y;
  }

  private static arePointsCCW(a: Point, b: Point, c: Point): boolean {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const acx = c.x - a.x;
    const acy = c.y - a.y;
    return abx * acy - aby * acx > 0;
  }

  private static calculateIntersection(a: Point, b: Point, c: Point, d: Point, result: Point): void {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const cdx = d.x - c.x;
    const cdy = d.y - c.y;
    const acx = c.x - a.x;
    const acy = c.y - a.y;
    const t = (abx * acy - aby * acx) / (aby * cdx - abx * cdy);
    result.x = c.x + t * cdx;
    result.y = c.y + t * cdy;
  }

  private static getFaceZ(point: Point, facePoint: Vector3, normal: Vector3): number {
    const d = facePoint.dot(normal);
    return (d - point.x * normal.x - point.y * normal.y) / normal.z;
  }
}

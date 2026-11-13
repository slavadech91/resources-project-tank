// 1:1 из alternativa/tanks/physics/TanksCollisionDetector.as
import { Body } from '../../physics/Body.ts';
import { BodyContact, type Collider, type CollisionDetector, type ShapeContact } from '../../physics/Contacts.ts';
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { BoxBoxCollider } from '../../physics/collision/colliders/BoxBoxCollider.ts';
import { BoxRectCollider } from '../../physics/collision/colliders/BoxRectCollider.ts';
import { BoxTriangleCollider } from '../../physics/collision/colliders/BoxTriangleCollider.ts';
import { CollisionKdTree, type CollisionKdNode } from '../../physics/collision/CollisionKdTree.ts';
import { CollisionShape } from '../../physics/collision/CollisionShape.ts';
import { AABB, type IRayCollisionFilter, RayHit } from '../../physics/collision/types.ts';
import type { TankBody } from './TankBody.ts';

const AABB_EPSILON = 0.01; // §]!3§

class MinMax {
  min = 0; // §,!K§
  max = 0; // §+!l§
}

export class TanksCollisionDetector implements CollisionDetector {
  private readonly colliders: Record<number, Collider> = {}; // §]!T§
  private readonly tmpHit = new RayHit(); // §+"J§
  private readonly minMax = new MinMax(); // §+?§
  private readonly normal = new Vector3(); // §[_§
  private readonly point = new Vector3(); // §;!G§
  private readonly dynamicHit = new RayHit(); // §@1§
  private readonly rayAABB = new AABB(); // §;"3§
  private readonly shapeContacts: ShapeContact[] = []; // §4_§
  tree = new CollisionKdTree(); // §2!9§
  private readonly threshold = 0.0001; // §&!@§
  private readonly tankBodies: TankBody[] = []; // §4!I§
  private staticBody: Body = null as unknown as Body; // §5"M§

  constructor() {
    const epsilon = 0.000001;
    this.setCollider(CollisionShape.BOX, CollisionShape.BOX, new BoxBoxCollider(epsilon));
    this.setCollider(CollisionShape.BOX, CollisionShape.RECT, new BoxRectCollider(epsilon));
    this.setCollider(CollisionShape.BOX, CollisionShape.TRIANGLE, new BoxTriangleCollider(epsilon));
    this.createStaticBody();
  }

  private setCollider(type1: number, type2: number, collider: Collider): void {
    this.colliders[type1 | type2] = collider;
  }

  private createStaticBody(): void {
    this.staticBody = new Body(1, new Matrix3(), 10000000000);
    this.staticBody.movable = false;
  }

  buildKdTree(shapes: CollisionShape[], boundBox: AABB | null = null): void {
    for (const shape of shapes) shape.body = this.staticBody;
    this.tree.createTree(shapes, boundBox);
  }

  addTankBody(tankBody: TankBody): void {
    this.tankBodies.push(tankBody);
  }

  /** танки на поле — для наведения по секторам целей */
  getTankBodies(): readonly TankBody[] {
    return this.tankBodies;
  }

  removeTankBody(tankBody: TankBody): void {
    const index = this.tankBodies.indexOf(tankBody);
    if (index > -1) {
      const last = this.tankBodies.length - 1;
      this.tankBodies[index] = this.tankBodies[last];
      this.tankBodies.length = last;
    }
  }

  getBodyContacts(contacts: BodyContact[]): void {
    const count = this.tankBodies.length;
    // клиент 2019: контакт со статикой — это и корпус, и гусеницы
    for (let n = 0; n < count; n++) {
      const tankBody = this.tankBodies[n];
      tankBody.wasStaticContacts = tankBody.hasStaticContacts;
      const tank = tankBody.body.data as { hasTracksContactsWithStatic?(): boolean } | null;
      tankBody.hasStaticContacts = tank?.hasTracksContactsWithStatic?.() ?? false;
      tankBody.hasTankContacts = false;
    }
    for (let n = 0; n < count; n++) {
      const tankBody = this.tankBodies[n];
      const before = contacts.length;
      this.getContactsWithStatic(tankBody, contacts);
      if (before != contacts.length) tankBody.hasStaticContacts = true;
      this.getContactsWithOtherBodies(tankBody, n + 1, contacts);
    }
  }

  /** контакты фигуры со статикой карты (клиент 2019, для проверки полёта) */
  getShapeContactsWithStatic(shape: CollisionShape, result: ShapeContact[]): void {
    this.getShapeNodeCollisions(this.tree.rootNode, shape, result);
  }

  private getContactsWithStatic(tankBody: TankBody, contacts: BodyContact[]): void {
    // кинематическое тело (чужой танк по снапшотам) со статикой не сталкивается: оба неподвижны
    if (tankBody.body.frozen || tankBody.body.kinematic) return;
    const shapes = tankBody.staticCollisionShapes;
    const count = shapes.length;
    for (let n = 0; n < count; n++) {
      this.getShapeNodeCollisions(this.tree.rootNode, shapes[n], this.shapeContacts);
    }
    if (this.shapeContacts.length > 0) {
      const contact = BodyContact.create();
      contact.body1 = tankBody.body;
      contact.body2 = this.staticBody;
      contact.setShapeContacts(this.shapeContacts);
      this.shapeContacts.length = 0;
      contacts[contacts.length] = contact;
    }
  }

  private getContactsWithOtherBodies(tankBody: TankBody, startIndex: number, contacts: BodyContact[]): void {
    const count = this.tankBodies.length;
    for (let n = startIndex; n < count; n++) {
      const other = this.tankBodies[n];
      const body1 = tankBody.body;
      const body2 = other.body;
      if (body1.kinematic && body2.kinematic) continue;
      if (!(body1.frozen && body2.frozen) && body1.aabb.intersects(body2.aabb, AABB_EPSILON)) {
        this.getContacts(tankBody.tankCollisionBox, other.tankCollisionBox, this.shapeContacts);
        const numContacts = this.shapeContacts.length;
        if (numContacts > 0) {
          const accept1 = body1.postCollisionFilter == null || body1.postCollisionFilter.considerBodies(body1, body2);
          const accept2 = body2.postCollisionFilter == null || body2.postCollisionFilter.considerBodies(body2, body1);
          if (accept1 && accept2) {
            const contact = BodyContact.create();
            contact.body1 = body1;
            contact.body2 = body2;
            contact.setShapeContacts(this.shapeContacts);
            contacts[contacts.length] = contact;
            // клиент 2019 (penetratedBodies): касание отмечается у обоих танков
            tankBody.hasTankContacts = true;
            other.hasTankContacts = true;
          } else {
            for (let m = 0; m < numContacts; m++) this.shapeContacts[m].dispose();
          }
          this.shapeContacts.length = 0;
        }
      }
    }
  }

  getContacts(shape1: CollisionShape, shape2: CollisionShape, result: ShapeContact[]): void {
    if ((shape1.collisionGroup & shape2.collisionGroup) == 0) return;
    if (shape1.body == shape2.body) return;
    if (!shape1.aabb.intersects(shape2.aabb, AABB_EPSILON)) return;
    const collider = this.colliders[shape1.type | shape2.type];
    collider.getContacts(shape1, shape2, result);
  }

  testCollision(shape1: CollisionShape, shape2: CollisionShape): boolean {
    if ((shape1.collisionGroup & shape2.collisionGroup) == 0) return false;
    if (shape1.body == shape2.body) return false;
    if (!shape1.aabb.intersects(shape2.aabb, AABB_EPSILON)) return false;
    const collider = this.colliders[shape1.type | shape2.type];
    return collider.haveCollision(shape1, shape2);
  }

  raycast(origin: Vector3, direction: Vector3, collisionMask: number, maxTime: number, filter: IRayCollisionFilter | null, result: RayHit): boolean {
    const staticHit = this.raycastStatic(origin, direction, collisionMask, maxTime, filter, result);
    const dynamicHit = this.raycastDynamic(origin, direction, collisionMask, maxTime, filter, this.dynamicHit);
    if (!(dynamicHit || staticHit)) return false;
    if (dynamicHit && staticHit) {
      if (result.t > this.dynamicHit.t) result.copy(this.dynamicHit);
      this.dynamicHit.clear();
      return true;
    }
    if (staticHit) {
      this.dynamicHit.clear();
      return true;
    }
    result.copy(this.dynamicHit);
    this.dynamicHit.clear();
    return true;
  }

  /** §'" § */
  raycastStatic(origin: Vector3, direction: Vector3, collisionMask: number, maxTime: number, filter: IRayCollisionFilter | null, result: RayHit): boolean {
    const mm = this.minMax;
    if (!this.getRayBoundBoxIntersection(origin, direction, this.tree.rootNode.boundBox, mm)) return false;
    if (mm.max < 0 || mm.min > maxTime) return false;
    if (mm.min <= 0) {
      mm.min = 0;
      this.point.x = origin.x;
      this.point.y = origin.y;
      this.point.z = origin.z;
    } else {
      this.point.x = origin.x + mm.min * direction.x;
      this.point.y = origin.y + mm.min * direction.y;
      this.point.z = origin.z + mm.min * direction.z;
    }
    if (mm.max > maxTime) mm.max = maxTime;
    const hit = this.testRayAgainstNode(this.tree.rootNode, origin, this.point, direction, collisionMask, mm.min, mm.max, filter, result);
    return hit ? result.t <= maxTime : false;
  }

  hasStaticHit(origin: Vector3, direction: Vector3, collisionMask: number, maxTime: number, filter: IRayCollisionFilter | null = null): boolean {
    const hit = this.raycastStatic(origin, direction, collisionMask, maxTime, filter, this.tmpHit);
    this.tmpHit.clear();
    return hit;
  }

  private getShapeNodeCollisions(node: CollisionKdNode, shape: CollisionShape, result: ShapeContact[]): void {
    if (node.indices != null) {
      const children = this.tree.staticChildren;
      const indices = node.indices;
      const count = indices.length;
      for (let n = 0; n < count; n++) this.getContacts(shape, children[indices[n]], result);
    }
    if (node.axis == -1) return;
    let min = NaN;
    let max = NaN;
    switch (node.axis) {
      case 0:
        min = shape.aabb.minX;
        max = shape.aabb.maxX;
        break;
      case 1:
        min = shape.aabb.minY;
        max = shape.aabb.maxY;
        break;
      case 2:
        min = shape.aabb.minZ;
        max = shape.aabb.maxZ;
    }
    if (min < node.coord) this.getShapeNodeCollisions(node.negativeNode as CollisionKdNode, shape, result);
    if (max > node.coord) this.getShapeNodeCollisions(node.positiveNode as CollisionKdNode, shape, result);
    if (node.splitTree != null && min < node.coord && max > node.coord) {
      this.getShapeNodeCollisions(node.splitTree.rootNode, shape, result);
    }
  }

  private testShapeNodeCollision(shape: CollisionShape, node: CollisionKdNode): boolean {
    if (node.indices != null) {
      const children = this.tree.staticChildren;
      const indices = node.indices;
      const count = indices.length;
      for (let n = 0; n < count; n++) {
        if (this.testCollision(shape, children[indices[n]])) return true;
      }
    }
    if (node.axis == -1) return false;
    let min = NaN;
    let max = NaN;
    switch (node.axis) {
      case 0:
        min = shape.aabb.minX;
        max = shape.aabb.maxX;
        break;
      case 1:
        min = shape.aabb.minY;
        max = shape.aabb.maxY;
        break;
      case 2:
        min = shape.aabb.minZ;
        max = shape.aabb.maxZ;
    }
    if (node.splitTree != null && min < node.coord && max > node.coord) {
      if (this.testShapeNodeCollision(shape, node.splitTree.rootNode)) return true;
    }
    if (min < node.coord) {
      if (this.testShapeNodeCollision(shape, node.negativeNode as CollisionKdNode)) return true;
    }
    if (max > node.coord) {
      if (this.testShapeNodeCollision(shape, node.positiveNode as CollisionKdNode)) return true;
    }
    return false;
  }

  private raycastDynamic(origin: Vector3, direction: Vector3, collisionMask: number, maxTime: number, filter: IRayCollisionFilter | null, result: RayHit): boolean {
    const ex = origin.x + direction.x * maxTime;
    const ey = origin.y + direction.y * maxTime;
    const ez = origin.z + direction.z * maxTime;
    const box = this.rayAABB;
    if (ex < origin.x) {
      box.minX = ex;
      box.maxX = origin.x;
    } else {
      box.minX = origin.x;
      box.maxX = ex;
    }
    if (ey < origin.y) {
      box.minY = ey;
      box.maxY = origin.y;
    } else {
      box.minY = origin.y;
      box.maxY = ey;
    }
    if (ez < origin.z) {
      box.minZ = ez;
      box.maxZ = origin.z;
    } else {
      box.minZ = origin.z;
      box.maxZ = ez;
    }
    let minTime = maxTime + 1;
    const count = this.tankBodies.length;
    for (let n = 0; n < count; n++) {
      const body = this.tankBodies[n].body;
      let bb = body.aabb;
      if (box.maxX < bb.minX || box.minX > bb.maxX || box.maxY < bb.minY || box.minY > bb.maxY || box.maxZ < bb.minZ || box.minZ > bb.maxZ) continue;
      for (let m = 0; m < body.numCollisionShapes; m++) {
        const shape = (body.collisionShapes as CollisionShape[])[m];
        if ((shape.collisionGroup & collisionMask) == 0) continue;
        bb = shape.aabb;
        if (box.maxX < bb.minX || box.minX > bb.maxX || box.maxY < bb.minY || box.minY > bb.maxY || box.maxZ < bb.minZ || box.minZ > bb.maxZ) continue;
        if (filter != null && !filter.considerBody(body)) continue;
        const t = shape.raycast(origin, direction, this.threshold, this.normal);
        if (t >= 0 && t < minTime) {
          minTime = t;
          result.shape = shape;
          result.normal.x = this.normal.x;
          result.normal.y = this.normal.y;
          result.normal.z = this.normal.z;
        }
      }
    }
    if (minTime > maxTime) return false;
    result.position.x = origin.x + direction.x * minTime;
    result.position.y = origin.y + direction.y * minTime;
    result.position.z = origin.z + direction.z * minTime;
    result.t = minTime;
    return true;
  }

  private getRayBoundBoxIntersection(origin: Vector3, direction: Vector3, bb: AABB, result: MinMax): boolean {
    let t1 = NaN;
    let t2 = NaN;
    result.min = -1;
    result.max = 1e308;
    for (let axis = 0; axis < 3; axis++) {
      switch (axis) {
        case 0:
          if (!(direction.x < this.threshold && direction.x > -this.threshold)) {
            t1 = (bb.minX - origin.x) / direction.x;
            t2 = (bb.maxX - origin.x) / direction.x;
            break;
          }
          if (origin.x < bb.minX || origin.x > bb.maxX) return false;
          continue;
        case 1:
          if (!(direction.y < this.threshold && direction.y > -this.threshold)) {
            t1 = (bb.minY - origin.y) / direction.y;
            t2 = (bb.maxY - origin.y) / direction.y;
            break;
          }
          if (origin.y < bb.minY || origin.y > bb.maxY) return false;
          continue;
        case 2:
          if (!(direction.z < this.threshold && direction.z > -this.threshold)) {
            t1 = (bb.minZ - origin.z) / direction.z;
            t2 = (bb.maxZ - origin.z) / direction.z;
            break;
          }
          if (origin.z < bb.minZ || origin.z > bb.maxZ) return false;
          continue;
      }
      if (t1 < t2) {
        if (t1 > result.min) result.min = t1;
        if (t2 < result.max) result.max = t2;
      } else {
        if (t2 > result.min) result.min = t2;
        if (t1 < result.max) result.max = t1;
      }
      if (result.max < result.min) return false;
    }
    return true;
  }

  private testRayAgainstNode(
    node: CollisionKdNode,
    origin: Vector3,
    localOrigin: Vector3,
    direction: Vector3,
    collisionMask: number,
    t1: number,
    t2: number,
    filter: IRayCollisionFilter | null,
    result: RayHit,
  ): boolean {
    if (node.indices != null && this.getRayNodeIntersection(origin, direction, collisionMask, this.tree.staticChildren, node.indices, filter, result)) {
      return true;
    }
    if (node.axis == -1) return false;
    let splitTime = NaN;
    let currChildNode: CollisionKdNode = null as unknown as CollisionKdNode;
    switch (node.axis) {
      case 0:
        if (direction.x > -this.threshold && direction.x < this.threshold) splitTime = t2 + 1;
        else splitTime = (node.coord - origin.x) / direction.x;
        currChildNode = (localOrigin.x < node.coord ? node.negativeNode : node.positiveNode) as CollisionKdNode;
        break;
      case 1:
        if (direction.y > -this.threshold && direction.y < this.threshold) splitTime = t2 + 1;
        else splitTime = (node.coord - origin.y) / direction.y;
        currChildNode = (localOrigin.y < node.coord ? node.negativeNode : node.positiveNode) as CollisionKdNode;
        break;
      case 2:
        if (direction.z > -this.threshold && direction.z < this.threshold) splitTime = t2 + 1;
        else splitTime = (node.coord - origin.z) / direction.z;
        currChildNode = (localOrigin.z < node.coord ? node.negativeNode : node.positiveNode) as CollisionKdNode;
    }
    if (splitTime < t1 || splitTime > t2) {
      return this.testRayAgainstNode(currChildNode, origin, localOrigin, direction, collisionMask, t1, t2, filter, result);
    }
    const hit = this.testRayAgainstNode(currChildNode, origin, localOrigin, direction, collisionMask, t1, splitTime, filter, result);
    if (hit) return true;
    this.point.x = origin.x + splitTime * direction.x;
    this.point.y = origin.y + splitTime * direction.y;
    this.point.z = origin.z + splitTime * direction.z;
    if (node.splitTree != null) {
      let splitNode: CollisionKdNode | null = node.splitTree.rootNode;
      while (splitNode != null && splitNode.axis != -1) {
        switch (splitNode.axis) {
          case 0:
            splitNode = this.point.x < splitNode.coord ? splitNode.negativeNode : splitNode.positiveNode;
            break;
          case 1:
            splitNode = this.point.y < splitNode.coord ? splitNode.negativeNode : splitNode.positiveNode;
            break;
          case 2:
            splitNode = this.point.z < splitNode.coord ? splitNode.negativeNode : splitNode.positiveNode;
        }
      }
      if (splitNode != null && splitNode.indices != null) {
        const count = splitNode.indices.length;
        for (let n = 0; n < count; n++) {
          const shape = this.tree.staticChildren[splitNode.indices[n]];
          if ((shape.collisionGroup & collisionMask) == 0) continue;
          if (filter != null && !filter.considerBody(shape.body as Body)) continue;
          result.t = shape.raycast(origin, direction, this.threshold, result.normal);
          if (result.t >= 0) {
            // как в оригинале: позиция — точка на плоскости раздела
            result.position.copy(this.point);
            result.shape = shape;
            return true;
          }
        }
      }
    }
    const otherNode = (currChildNode == node.negativeNode ? node.positiveNode : node.negativeNode) as CollisionKdNode;
    return this.testRayAgainstNode(otherNode, origin, this.point, direction, collisionMask, splitTime, t2, filter, result);
  }

  private getRayNodeIntersection(
    origin: Vector3,
    direction: Vector3,
    collisionMask: number,
    shapes: CollisionShape[],
    indices: number[],
    filter: IRayCollisionFilter | null,
    result: RayHit,
  ): boolean {
    const count = indices.length;
    let minTime = 1e308;
    for (let n = 0; n < count; n++) {
      const shape = shapes[indices[n]];
      if ((shape.collisionGroup & collisionMask) == 0) continue;
      if (filter != null && !filter.considerBody(shape.body as Body)) continue;
      const t = shape.raycast(origin, direction, this.threshold, this.normal);
      if (t > 0 && t < minTime) {
        minTime = t;
        result.shape = shape;
        result.normal.x = this.normal.x;
        result.normal.y = this.normal.y;
        result.normal.z = this.normal.z;
      }
    }
    if (minTime == 1e308) return false;
    result.position.x = origin.x + direction.x * minTime;
    result.position.y = origin.y + direction.y * minTime;
    result.position.z = origin.z + direction.z * minTime;
    result.t = minTime;
    return true;
  }

  testStaticCollision(shape: CollisionShape): boolean {
    return this.testShapeNodeCollision(shape, this.tree.rootNode);
  }
}

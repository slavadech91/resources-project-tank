// 1:1 из alternativa/physics/{ShapeContact,BodyContact}.as и collision/{CollisionDetector,Collider}.as
import type { Matrix3 } from './math/Matrix3.ts';
import { Vector3 } from './math/Vector3.ts';
import type { Body } from './Body.ts';
import type { CollisionShape } from './collision/CollisionShape.ts';
import type { IRayCollisionFilter, RayHit } from './collision/types.ts';

export class ShapeContact {
  private static poolSize = 0; // §;"U§
  private static readonly pool: (ShapeContact | null)[] = []; // §@!B§

  position = new Vector3(); // §2J§
  penetration = 0; // §^!o§
  normal = new Vector3(); // §-3§
  tangent1 = new Vector3(); // §@"3§
  tangent2 = new Vector3(); // §3d§
  restitutionVelocity = 0; // §9",§ — желаемая скорость разделения (отскок)
  penetrationVelocity = 0; // §?""§ — псевдоскорость выталкивания
  normalDenominator = 0; // §3H§
  tangent1Denominator = 0; // §2O§
  tangent2Denominator = 0; // §9"1§
  angularTermN1 = 0; // §7"O§
  angularTermN2 = 0; // §;!n§
  angularTermT1a = 0; // §%!K§
  angularTermT2a = 0; // §<?§
  angularTermT1b = 0; // §;"N§
  angularTermT2b = 0; // §="S§
  r1 = new Vector3(); // §[`§
  r2 = new Vector3(); // §#>§
  accumulatedNormalImpulse = 0; // §;!C§
  accumulatedTangent1Impulse = 0; // §4!4§
  accumulatedTangent2Impulse = 0; // §<"!§
  satisfied = false; // §^!m§
  restitution = 0; // §#!k§
  friction = 0; // §++§
  shape1: CollisionShape = null as unknown as CollisionShape; // §1!&§
  shape2: CollisionShape = null as unknown as CollisionShape; // §2?§

  static create(): ShapeContact {
    if (ShapeContact.poolSize == 0) return new ShapeContact();
    --ShapeContact.poolSize;
    const contact = ShapeContact.pool[ShapeContact.poolSize] as ShapeContact;
    ShapeContact.pool[ShapeContact.poolSize] = null;
    return contact;
  }

  dispose(): void {
    this.shape1 = null as unknown as CollisionShape;
    this.shape2 = null as unknown as CollisionShape;
    ShapeContact.pool[ShapeContact.poolSize] = this;
    ++ShapeContact.poolSize;
  }

  calculatePersistentFrameData(): void {
    const body1 = this.shape1.body as Body;
    const body2 = this.shape2.body as Body;
    this.restitution = this.shape1.material.restitution;
    const restitution2 = this.shape2.material.restitution;
    if (restitution2 < this.restitution) this.restitution = restitution2;
    this.friction = this.shape1.material.friction;
    const friction2 = this.shape2.material.friction;
    if (friction2 < this.friction) this.friction = friction2;
    // клиент 2019
    if ((body1.slipperyMode && !body2.movable) || (body2.slipperyMode && !body1.movable)) this.friction = 0;
    let p = body1.state.position;
    this.r1.x = this.position.x - p.x;
    this.r1.y = this.position.y - p.y;
    this.r1.z = this.position.z - p.z;
    p = body2.state.position;
    this.r2.x = this.position.x - p.x;
    this.r2.y = this.position.y - p.y;
    this.r2.z = this.position.z - p.z;
    if (Math.abs(this.normal.x) < Math.abs(this.normal.y)) {
      this.tangent1.cross2(this.normal, Vector3.X_AXIS).normalize();
    } else {
      this.tangent1.cross2(this.normal, Vector3.Y_AXIS).normalize();
    }
    this.tangent2.cross2(this.normal, this.tangent1);
    this.accumulatedNormalImpulse = 0;
    this.accumulatedTangent1Impulse = 0;
    this.accumulatedTangent2Impulse = 0;
    this.normalDenominator = 0;
    this.tangent1Denominator = 0;
    this.tangent2Denominator = 0;
    if (body1.movable) {
      this.angularTermN1 = this.calculateAngularInertiaTerm(this.normal, this.r1, body1.invInertiaWorld);
      this.angularTermT1a = this.calculateAngularInertiaTerm(this.tangent1, this.r1, body1.invInertiaWorld);
      this.angularTermT2a = this.calculateAngularInertiaTerm(this.tangent2, this.r1, body1.invInertiaWorld);
      this.normalDenominator += body1.invMass + this.angularTermN1;
      this.tangent1Denominator += body1.invMass + this.angularTermT1a;
      this.tangent2Denominator += body1.invMass + this.angularTermT2a;
    }
    if (body2.movable) {
      this.angularTermN2 = this.calculateAngularInertiaTerm(this.normal, this.r2, body2.invInertiaWorld);
      this.angularTermT1b = this.calculateAngularInertiaTerm(this.tangent1, this.r2, body2.invInertiaWorld);
      this.angularTermT2b = this.calculateAngularInertiaTerm(this.tangent2, this.r2, body2.invInertiaWorld);
      this.normalDenominator += body2.invMass + this.angularTermN2;
      this.tangent1Denominator += body2.invMass + this.angularTermT1b;
      this.tangent2Denominator += body2.invMass + this.angularTermT2b;
    }
    this.restitutionVelocity = this.getSeparationVelocity();
    if (this.restitutionVelocity < 0) this.restitutionVelocity = -this.restitution * this.restitutionVelocity;
  }

  private calculateAngularInertiaTerm(direction: Vector3, r: Vector3, invInertia: Matrix3): number {
    let x = r.y * direction.z - r.z * direction.y;
    let y = r.z * direction.x - r.x * direction.z;
    let z = r.x * direction.y - r.y * direction.x;
    const ix = invInertia.a * x + invInertia.b * y + invInertia.c * z;
    const iy = invInertia.e * x + invInertia.f * y + invInertia.g * z;
    const iz = invInertia.i * x + invInertia.j * y + invInertia.k * z;
    x = iy * r.z - iz * r.y;
    y = iz * r.x - ix * r.z;
    z = ix * r.y - iy * r.x;
    return x * direction.x + y * direction.y + z * direction.z;
  }

  getSeparationVelocity(): number {
    let w = (this.shape1.body as Body).state.rotation;
    let cx = w.y * this.r1.z - w.z * this.r1.y;
    let cy = w.z * this.r1.x - w.x * this.r1.z;
    let cz = w.x * this.r1.y - w.y * this.r1.x;
    let v = (this.shape1.body as Body).state.velocity;
    let vx = v.x + cx;
    let vy = v.y + cy;
    let vz = v.z + cz;
    w = (this.shape2.body as Body).state.rotation;
    cx = w.y * this.r2.z - w.z * this.r2.y;
    cy = w.z * this.r2.x - w.x * this.r2.z;
    cz = w.x * this.r2.y - w.y * this.r2.x;
    v = (this.shape2.body as Body).state.velocity;
    vx -= v.x + cx;
    vy -= v.y + cy;
    vz -= v.z + cz;
    return vx * this.normal.x + vy * this.normal.y + vz * this.normal.z;
  }

  /** calcualteDynamicFrameData — опечатка как в оригинале не сохраняется */
  calculateDynamicFrameData(allowedPenetration: number, penetrationSpeed: number, maxPenetrationCorrection: number, dt: number): void {
    const body1 = this.shape1.body as Body;
    const body2 = this.shape2.body as Body;
    this.normalDenominator = 0;
    this.tangent1Denominator = 0;
    this.tangent2Denominator = 0;
    if (body1.movable) {
      this.normalDenominator += body1.invMass + this.angularTermN1;
      this.tangent1Denominator += body1.invMass + this.angularTermT1a;
      this.tangent2Denominator += body1.invMass + this.angularTermT2a;
    }
    if (body2.movable) {
      this.normalDenominator += body2.invMass + this.angularTermN2;
      this.tangent1Denominator += body2.invMass + this.angularTermT1b;
      this.tangent2Denominator += body2.invMass + this.angularTermT2b;
    }
    if (this.penetration > allowedPenetration) {
      let depth = this.penetration - allowedPenetration;
      if (depth > maxPenetrationCorrection) depth = maxPenetrationCorrection;
      this.penetrationVelocity = (penetrationSpeed * depth) / dt;
    } else {
      this.penetrationVelocity = 0;
    }
  }
}

export class BodyContact {
  private static poolHead: BodyContact | null = null; // §="B§

  body1: Body = null as unknown as Body; // §8o§
  body2: Body = null as unknown as Body; // §4!S§
  shapeContacts: ShapeContact[] = []; // §4_§
  private next: BodyContact | null = null; // §throw§

  static create(): BodyContact {
    if (BodyContact.poolHead == null) return new BodyContact();
    const contact = BodyContact.poolHead;
    BodyContact.poolHead = contact.next;
    contact.next = null;
    return contact;
  }

  dispose(): void {
    this.body1 = null as unknown as Body;
    this.body2 = null as unknown as Body;
    const count = this.shapeContacts.length;
    for (let n = 0; n < count; n++) this.shapeContacts[n].dispose();
    this.shapeContacts.length = 0;
    this.next = BodyContact.poolHead;
    BodyContact.poolHead = this;
  }

  copy(source: BodyContact): void {
    this.body1 = source.body1;
    this.body2 = source.body2;
    const contacts = source.shapeContacts;
    const count = contacts.length;
    for (let n = 0; n < count; n++) this.shapeContacts[this.shapeContacts.length] = contacts[n];
  }

  setShapeContacts(contacts: ShapeContact[]): void {
    const count = contacts.length;
    for (let n = 0; n < count; n++) this.shapeContacts[n] = contacts[n];
  }
}

export interface CollisionDetector {
  getBodyContacts(contacts: BodyContact[]): void;
  raycast(origin: Vector3, direction: Vector3, collisionMask: number, maxTime: number, filter: IRayCollisionFilter | null, result: RayHit): boolean;
  /** §'" § */
  raycastStatic(origin: Vector3, direction: Vector3, collisionMask: number, maxTime: number, filter: IRayCollisionFilter | null, result: RayHit): boolean;
  hasStaticHit(origin: Vector3, direction: Vector3, collisionMask: number, maxTime: number, filter?: IRayCollisionFilter | null): boolean;
  getContacts(shape1: CollisionShape, shape2: CollisionShape, result: ShapeContact[]): void;
  testCollision(shape1: CollisionShape, shape2: CollisionShape): boolean;
}

export interface Collider {
  getContacts(shape1: CollisionShape, shape2: CollisionShape, result: ShapeContact[]): void;
  haveCollision(shape1: CollisionShape, shape2: CollisionShape): boolean;
}

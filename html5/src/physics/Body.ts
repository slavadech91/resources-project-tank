// 1:1 из alternativa/physics/{Body,BodyState}.as. Имена полей — по AlternativaPhysics 2.0.1.0.
// EncryptedNumber (maxSpeedXY) заменён обычным числом.
import { Matrix3 } from './math/Matrix3.ts';
import type { Matrix4 } from './math/Matrix4.ts';
import { Quaternion } from './math/Quaternion.ts';
import { Vector3 } from './math/Vector3.ts';
import type { CollisionShape } from './collision/CollisionShape.ts';
import { AABB, type BodyCollisionFilter } from './collision/types.ts';
import type { PhysicsScene } from './PhysicsScene.ts';

export class BodyState {
  velocity = new Vector3(); // § "G§
  orientation = new Quaternion(); // §,!i§
  rotation = new Vector3(); // § do§ — угловая скорость
  position = new Vector3(); // §2J§

  copy(state: BodyState): void {
    this.position.copy(state.position);
    this.orientation.copy(state.orientation);
    this.velocity.copy(state.velocity);
    this.rotation.copy(state.rotation);
  }

  isValid(): boolean {
    return this.velocity.isFinite() && this.rotation.isFinite() && this.position.isFinite() && this.orientation.isFinite();
  }
}

export class Body {
  static linDamping = 0.997; // §`"<§
  static rotDamping = 0.997; // §4i§
  private static readonly MAX_VERTICAL_SPEED = 1500; // §!"[§
  private static readonly r = new Vector3(); // §!!1§
  private static readonly f = new Vector3(); // §8"M§

  id = 0; // §5!=§
  data: unknown = null; // §'n§
  scene: PhysicsScene | null = null; // §6"E§
  movable = true; // §=s§
  /**
   * html5 (синхронизация v2): позу телу задают снаружи перед каждым шагом (чужой танк по снапшотам) — для контактов
   * оно как статика (бесконечная масса), силы и гравитация его не двигают. movable при этом всегда false.
   */
  kinematic = false;
  canFreeze = false; // §-!`§
  /** Клиент 2019: танк в полёте не цепляется за статику — трение о неё 0 (ShapeContact) */
  slipperyMode = false;
  freezeCounter = 0; // §^H§
  frozen = false; // §"!m§
  aabb = new AABB(); // §1F§
  postCollisionFilter: BodyCollisionFilter | null = null; // §@!c§
  accel = new Vector3(); // §[i§
  angleAccel = new Vector3(); // §5"H§
  prevState = new BodyState(); // §>Z§
  mass = 1; // § use§
  invMass = 1; // §33§
  invInertia = new Matrix3(); // §`_§
  invInertiaWorld = new Matrix3(); // §78§
  baseMatrix = new Matrix3(); // §!"=§
  prevVelocity = new Vector3(); // §>u§
  state = new BodyState(); // §'!W§
  private maxSpeedXY = 0; // §3h§ (EncryptedNumber)
  private maxVerticalSpeedJump = 600; // §?V§
  private minAccelZ = -1100; // §'T§
  collisionShapes: CollisionShape[] | null = null; // §;H§
  numCollisionShapes = 0; // §+L§
  forceAccum = new Vector3(); // §]1§
  torqueAccum = new Vector3(); // §4!5§
  pseudoVelocity = new Vector3(); // §="V§
  pseudoRotation = new Vector3(); // §!q§

  constructor(mass: number, invInertia: Matrix3, maxSpeedXY: number) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.invInertia.copy(invInertia);
    this.maxSpeedXY = maxSpeedXY;
  }

  addCollisionShape(shape: CollisionShape, localTransform: Matrix4 | null = null): void {
    if (this.collisionShapes == null) {
      this.collisionShapes = [];
      this.numCollisionShapes = 0;
    }
    this.collisionShapes.push(shape);
    this.numCollisionShapes = this.collisionShapes.length;
    shape.setBody(this, localTransform);
  }

  removeCollisionShape(shape: CollisionShape): void {
    if (this.collisionShapes != null && this.numCollisionShapes > 0) {
      const index = this.collisionShapes.indexOf(shape);
      if (index >= 0) {
        shape.setBody(null);
        this.collisionShapes[index] = this.collisionShapes[--this.numCollisionShapes];
        if (this.numCollisionShapes == 0) this.collisionShapes = null;
        else this.collisionShapes.length = this.numCollisionShapes;
      }
    }
  }

  interpolate(t: number, position: Vector3, orientation: Quaternion): void {
    const k = 1 - t;
    position.x = this.prevState.position.x * k + this.state.position.x * t;
    position.y = this.prevState.position.y * k + this.state.position.y * t;
    position.z = this.prevState.position.z * k + this.state.position.z * t;
    orientation.w = this.prevState.orientation.w * k + this.state.orientation.w * t;
    orientation.x = this.prevState.orientation.x * k + this.state.orientation.x * t;
    orientation.y = this.prevState.orientation.y * k + this.state.orientation.y * t;
    orientation.z = this.prevState.orientation.z * k + this.state.orientation.z * t;
  }

  setPosition(position: Vector3): void {
    this.state.position.copy(position);
  }

  setPositionXYZ(x: number, y: number, z: number): void {
    this.state.position.reset(x, y, z);
  }

  setVelocity(velocity: Vector3): void {
    this.state.velocity.copy(velocity);
  }

  setVelocityXYZ(x: number, y: number, z: number): void {
    this.state.velocity.reset(x, y, z);
  }

  setRotation(rotation: Vector3): void {
    this.state.rotation.copy(rotation);
  }

  setRotationXYZ(x: number, y: number, z: number): void {
    this.state.rotation.reset(x, y, z);
  }

  setOrientation(orientation: Quaternion): void {
    this.state.orientation.copy(orientation);
  }

  /** §for § */
  setMaxSpeedXY(value: number): void {
    this.maxSpeedXY = value;
  }

  applyWorldImpulseAtLocalPoint(localPoint: Vector3, direction: Vector3, magnitude: number): void {
    const k = magnitude * this.invMass;
    this.state.velocity.x += k * direction.x;
    this.state.velocity.y += k * direction.y;
    this.state.velocity.z += k * direction.z;
    const x = (localPoint.y * direction.z - localPoint.z * direction.y) * magnitude;
    const y = (localPoint.z * direction.x - localPoint.x * direction.z) * magnitude;
    const z = (localPoint.x * direction.y - localPoint.y * direction.x) * magnitude;
    const m = this.invInertiaWorld;
    this.state.rotation.x += m.a * x + m.b * y + m.c * z;
    this.state.rotation.y += m.e * x + m.f * y + m.g * z;
    this.state.rotation.z += m.i * x + m.j * y + m.k * z;
  }

  applyWorldPseudoImpulseAtLocalPoint(localPoint: Vector3, direction: Vector3, magnitude: number): void {
    const k = magnitude * this.invMass;
    this.pseudoVelocity.x += k * direction.x;
    this.pseudoVelocity.y += k * direction.y;
    this.pseudoVelocity.z += k * direction.z;
    const x = (localPoint.y * direction.z - localPoint.z * direction.y) * magnitude;
    const y = (localPoint.z * direction.x - localPoint.x * direction.z) * magnitude;
    const z = (localPoint.x * direction.y - localPoint.y * direction.x) * magnitude;
    const m = this.invInertiaWorld;
    this.pseudoRotation.x += m.a * x + m.b * y + m.c * z;
    this.pseudoRotation.y += m.e * x + m.f * y + m.g * z;
    this.pseudoRotation.z += m.i * x + m.j * y + m.k * z;
  }

  applyImpulse(direction: Vector3, magnitude: number): void {
    const k = magnitude * this.invMass;
    this.state.velocity.x += k * direction.x;
    this.state.velocity.y += k * direction.y;
    this.state.velocity.z += k * direction.z;
  }

  addForce(force: Vector3): void {
    this.forceAccum.add(force);
  }

  addForceXYZ(x: number, y: number, z: number): void {
    this.forceAccum.x += x;
    this.forceAccum.y += y;
    this.forceAccum.z += z;
  }

  addWorldForceXYZ(px: number, py: number, pz: number, fx: number, fy: number, fz: number): void {
    this.forceAccum.x += fx;
    this.forceAccum.y += fy;
    this.forceAccum.z += fz;
    const p = this.state.position;
    const rx = px - p.x;
    const ry = py - p.y;
    const rz = pz - p.z;
    this.torqueAccum.x += ry * fz - rz * fy;
    this.torqueAccum.y += rz * fx - rx * fz;
    this.torqueAccum.z += rx * fy - ry * fx;
  }

  addWorldForce(point: Vector3, force: Vector3): void {
    this.forceAccum.add(force);
    this.torqueAccum.add(Body.r.diff(point, this.state.position).cross(force));
  }

  /** §9" § */
  addWorldForceScaled(point: Vector3, force: Vector3, scale: number): void {
    const fx = scale * force.x;
    const fy = scale * force.y;
    const fz = scale * force.z;
    this.forceAccum.x += fx;
    this.forceAccum.y += fy;
    this.forceAccum.z += fz;
    const p = this.state.position;
    const rx = point.x - p.x;
    const ry = point.y - p.y;
    const rz = point.z - p.z;
    this.torqueAccum.x += ry * fz - rz * fy;
    this.torqueAccum.y += rz * fx - rx * fz;
    this.torqueAccum.z += rx * fy - ry * fx;
  }

  addLocalForce(localPoint: Vector3, localForce: Vector3): void {
    this.baseMatrix.transformVector(localPoint, Body.r);
    this.baseMatrix.transformVector(localForce, Body.f);
    this.forceAccum.add(Body.f);
    this.torqueAccum.add(Body.r.cross(Body.f));
  }

  addWorldForceAtLocalPoint(localPoint: Vector3, force: Vector3): void {
    this.baseMatrix.transformVector(localPoint, Body.r);
    this.forceAccum.add(force);
    this.torqueAccum.add(Body.r.cross(force));
  }

  addTorque(torque: Vector3): void {
    this.torqueAccum.add(torque);
  }

  clearAccumulators(): void {
    this.forceAccum.x = this.forceAccum.y = this.forceAccum.z = 0;
    this.torqueAccum.x = this.torqueAccum.y = this.torqueAccum.z = 0;
  }

  calcAccelerations(): void {
    this.accel.x = this.forceAccum.x * this.invMass;
    this.accel.y = this.forceAccum.y * this.invMass;
    this.accel.z = this.forceAccum.z * this.invMass;
    const m = this.invInertiaWorld;
    const t = this.torqueAccum;
    this.angleAccel.x = m.a * t.x + m.b * t.y + m.c * t.z;
    this.angleAccel.y = m.e * t.x + m.f * t.y + m.g * t.z;
    this.angleAccel.z = m.i * t.x + m.j * t.y + m.k * t.z;
  }

  calcDerivedData(): void {
    this.state.orientation.toMatrix3(this.baseMatrix);
    this.invInertiaWorld.copy(this.invInertia).append(this.baseMatrix).prependTransposed(this.baseMatrix);
    if (this.collisionShapes != null) {
      this.aabb.infinity();
      for (let n = 0; n < this.numCollisionShapes; n++) {
        const shape = this.collisionShapes[n];
        shape.transform.setFromMatrix3(this.baseMatrix, this.state.position);
        if (shape.localTransform != null) shape.transform.prepend(shape.localTransform);
        shape.calculateAABB();
        this.aabb.addBoundBox(shape.aabb);
      }
    }
  }

  saveState(): void {
    this.prevState.copy(this.state);
  }

  restoreState(): void {
    this.state.copy(this.prevState);
  }

  integrateVelocity(dt: number): void {
    const v = this.state.velocity;
    this.prevVelocity.copy(v);
    if (this.accel.z < this.minAccelZ) this.accel.z = this.minAccelZ;
    v.x += this.accel.x * dt;
    v.y += this.accel.y * dt;
    v.z += this.accel.z * dt;
    const vz = Math.abs(v.z);
    if (vz > Body.MAX_VERTICAL_SPEED) v.z *= Body.MAX_VERTICAL_SPEED / vz;
    const w = this.state.rotation;
    w.x += this.angleAccel.x * dt;
    w.y += this.angleAccel.y * dt;
    w.z += this.angleAccel.z * dt;
    v.x *= Body.linDamping;
    v.y *= Body.linDamping;
    v.z *= Body.linDamping;
    const vx = v.x;
    const vy = v.y;
    const speedXY = Math.sqrt(vx * vx + vy * vy);
    const maxSpeed = this.maxSpeedXY;
    if (speedXY > maxSpeed) {
      const k = maxSpeed / speedXY;
      v.x *= k;
      v.y *= k;
    }
    w.x *= Body.rotDamping;
    w.y *= Body.rotDamping;
    w.z *= Body.rotDamping;
    if (w.length() > 10) w.setLength(10);
    if (v.z - this.prevVelocity.z > this.maxVerticalSpeedJump) v.z = this.prevVelocity.z + this.maxVerticalSpeedJump;
  }

  integratePosition(dt: number): void {
    // как в оригинале: позиция — новый объект Vector3 (ссылки на старую позицию устаревают)
    const position = new Vector3();
    const p = this.state.position;
    const v = this.state.velocity;
    position.x = p.x + v.x * dt;
    position.y = p.y + v.y * dt;
    position.z = p.z + v.z * dt;
    this.state.position = position;
    this.state.orientation.addScaledVector(this.state.rotation, dt);
  }

  integratePseudoVelocity(dt: number): void {
    this.state.position.x += this.pseudoVelocity.x * dt;
    this.state.position.y += this.pseudoVelocity.y * dt;
    this.state.position.z += this.pseudoVelocity.z * dt;
    this.state.orientation.addScaledVector(this.pseudoRotation, dt);
    this.pseudoVelocity.reset();
    this.pseudoRotation.reset();
  }
}

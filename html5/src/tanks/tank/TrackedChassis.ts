// 1:1 из alternativa/tanks/battle/objects/tank/TrackedChassis.as
import type { Body } from '../../physics/Body.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { PhysicsScene } from '../../physics/PhysicsScene.ts';
import { clamp, numberSign, sign } from '../utils/MathUtils.ts';
import { type SuspensionParams, type SuspensionRay, TankConst, Track, type ValueSmoother } from './Suspension.ts';

const MIN_ACCELERATION = 400; // §0!!§
export const TURN_SPEED_COUNT = 7;
const xAxis = new Vector3(); // §9h§
const yAxis = new Vector3(); // §5"K§
const zAxis = new Vector3(); // §9Q§
const surfaceVelocity = new Vector3(); // §'"§
const surfaceAngularVelocity = new Vector3(); // §-!9§
const relativeVelocity = new Vector3(); // §4!i§
const relativeAngularVelocity = new Vector3(); // include
const force = new Vector3(); // §%a§
const averagePoint = new Vector3(); // §`"H§

export class TrackedChassis {
  private readonly body: Body; // §7b§
  private readonly params: SuspensionParams; // §%L§
  private readonly maxSpeedSmoother: ValueSmoother; // §2R§
  leftTrack: Track = null as unknown as Track; // §9"&§
  rightTrack: Track = null as unknown as Track; // §true §
  locked = false; // §,"&§
  moveDirection = 0; // §`!j§
  turnDirection = 0; // §73§
  reverseBackTurn = false; // §<!D§
  private acceleration = 0; // §+!h§
  private reverseAcceleration = 0; // §`"Z§
  private sideAcceleration = 0; // §1"4§
  private turnAcceleration = 0; // §3!U§
  private reverseTurnAcceleration = 0; // §1z§
  /**
   * клиент 2019: гашение вращения без нажатого поворота (turnStabilizationAcceleration). Сервер 2014
   * его не шлёт — тогда, как в 2014 и в данных Narukami (Хорнет 130/130), равно ускорению поворота.
   */
  private stabilizationAcceleration = NaN;
  /** клиент 2019: доля скорости поворота, из TURN_SPEED_COUNT; с клавиатуры всегда полная */
  turnSpeedNumber = TURN_SPEED_COUNT;
  movementSpeedFactor = 1;

  constructor(body: Body, params: SuspensionParams, maxSpeedSmoother: ValueSmoother, size: Vector3) {
    this.body = body;
    this.params = params;
    this.maxSpeedSmoother = maxSpeedSmoother;
    this.createTracks(TankConst.RAYS_PER_TRACK, size);
  }

  private createTracks(numRays: number, size: Vector3): void {
    const length = size.y * 0.8;
    const width = size.x - 40;
    this.leftTrack = new Track(this.body, numRays, new Vector3(-0.5 * width, 0, -0.5 * size.z + TankConst.TRACK_RAY_Z_OFFSET), length, this.params, -1);
    this.rightTrack = new Track(this.body, numRays, new Vector3(0.5 * width, 0, -0.5 * size.z + TankConst.TRACK_RAY_Z_OFFSET), length, this.params, 1);
  }

  setAcceleration(value: number): void {
    this.acceleration = value;
  }

  setReverseAcceleration(value: number): void {
    this.reverseAcceleration = value;
  }

  setSideAcceleration(value: number): void {
    this.sideAcceleration = value;
  }

  setTurnAcceleration(value: number): void {
    this.turnAcceleration = value;
  }

  setReverseTurnAcceleration(value: number): void {
    this.reverseTurnAcceleration = value;
  }

  setStabilizationAcceleration(value: number): void {
    this.stabilizationAcceleration = value;
  }

  getAcceleration(): number {
    return this.acceleration;
  }

  getActualMovementDirection(): number {
    return this.locked ? 0 : this.moveDirection;
  }

  getActualTurnDirection(): number {
    return this.locked ? 0 : this.turnDirection;
  }

  setTracksCollisionGroup(group: number): void {
    this.leftTrack.setCollisionGroup(group);
    this.rightTrack.setCollisionGroup(group);
  }

  applyForces(maxSpeed: number, maxTurnSpeed: number, dt: number): void {
    this.adjustSuspensionSpringCoeff();
    this.calculateSuspensionContacts(dt);
    this.applyMovementForces(maxSpeed, maxTurnSpeed, dt);
    this.applySlopeHack();
  }

  private adjustSuspensionSpringCoeff(): void {
    const weight = (this.body.scene as PhysicsScene).gravity.length() * this.body.mass;
    this.params.springCoeff = weight / (2 * TankConst.RAYS_PER_TRACK * (this.params.maxRayLength - this.params.nominalRayLength));
  }

  private calculateSuspensionContacts(dt: number): void {
    this.leftTrack.calculateSuspensionContacts(dt);
    this.rightTrack.calculateSuspensionContacts(dt);
  }

  private applyMovementForces(maxSpeed: number, maxTurnSpeed: number, dt: number): void {
    if (this.leftTrack.numContacts + this.rightTrack.numContacts > 0) {
      this.doApplyMovementForces(maxSpeed, maxTurnSpeed, dt);
    }
  }

  private doApplyMovementForces(maxSpeed: number, maxTurnSpeed: number, dt: number): void {
    maxSpeed *= this.movementSpeedFactor;
    const moveDirection = this.locked ? 0 : this.moveDirection;
    const turnDirection = this.locked ? 0 : this.turnDirection;
    const velocity = this.body.state.velocity;
    const rotation = this.body.state.rotation;
    const m = this.body.baseMatrix;
    xAxis.x = m.a;
    xAxis.y = m.e;
    xAxis.z = m.i;
    yAxis.x = m.b;
    yAxis.y = m.f;
    yAxis.z = m.j;
    zAxis.x = m.c;
    zAxis.y = m.g;
    zAxis.z = m.k;
    // на крутых склонах (наклон больше 45°) тяга ослабевает, после 60° пропадает
    let slopeFactor = 1;
    const minSlope = Math.PI / 4;
    const maxSlope = Math.PI / 3;
    if (zAxis.z < Math.cos(minSlope)) {
      if (zAxis.z < Math.cos(maxSlope)) slopeFactor = 0;
      else slopeFactor = (maxSlope - Math.acos(zAxis.z)) / (maxSlope - minSlope);
    }
    this.calculateSurfaceVelocities(surfaceVelocity, surfaceAngularVelocity);
    relativeVelocity.x = velocity.x - surfaceVelocity.x;
    relativeVelocity.y = velocity.y - surfaceVelocity.y;
    relativeVelocity.z = velocity.z - surfaceVelocity.z;
    relativeAngularVelocity.x = rotation.x - surfaceAngularVelocity.x;
    relativeAngularVelocity.y = rotation.y - surfaceAngularVelocity.y;
    relativeAngularVelocity.z = rotation.z - surfaceAngularVelocity.z;
    const forwardSpeed = relativeVelocity.x * yAxis.x + relativeVelocity.y * yAxis.y + relativeVelocity.z * yAxis.z;
    const turnSpeed = relativeAngularVelocity.x * zAxis.x + relativeAngularVelocity.y * zAxis.y + relativeAngularVelocity.z * zAxis.z;
    let sideSpeed = relativeVelocity.x * xAxis.x + relativeVelocity.y * xAxis.y + relativeVelocity.z * xAxis.z;
    const sideDelta = this.sideAcceleration * slopeFactor * dt;
    if (sideSpeed < 0) {
      if (sideDelta > -sideSpeed) sideSpeed = 0;
      else sideSpeed += sideDelta;
    } else if (sideSpeed > 0) {
      if (sideDelta > sideSpeed) sideSpeed = 0;
      else sideSpeed -= sideDelta;
    }
    relativeVelocity.setLengthAlongDirection(xAxis, sideSpeed);
    velocity.x = surfaceVelocity.x + relativeVelocity.x;
    velocity.y = surfaceVelocity.y + relativeVelocity.y;
    velocity.z = surfaceVelocity.z + relativeVelocity.z;
    const leftContacts = this.leftTrack.numContacts;
    const rightContacts = this.rightTrack.numContacts;
    let acceleration = this.acceleration;
    let turnAcceleration = this.turnAcceleration;
    if (leftContacts > 0 || rightContacts > 0) {
      let speedDelta = 0;
      if (moveDirection == 0) {
        speedDelta = -sign(forwardSpeed) * acceleration * dt;
        if (sign(forwardSpeed) != sign(forwardSpeed + speedDelta)) speedDelta = -forwardSpeed;
      } else {
        if (sign(forwardSpeed) * sign(moveDirection) < 0) acceleration = this.reverseAcceleration;
        speedDelta = moveDirection * acceleration * dt;
      }
      const newSpeed = clamp(forwardSpeed + speedDelta, -maxSpeed, maxSpeed);
      let actualDelta = newSpeed - forwardSpeed;
      const one = 1;
      const speedRatio = clamp(1 - Math.abs(forwardSpeed / maxSpeed), 0, 1);
      if (speedRatio < one && moveDirection * sign(forwardSpeed) > 0 && actualDelta * moveDirection > 0) actualDelta *= speedRatio / one;
      let accel = actualDelta / dt;
      if (Math.abs(accel) < MIN_ACCELERATION && Math.abs(newSpeed) > 0.5 * this.maxSpeedSmoother.getTargetValue()) {
        accel = numberSign(accel, 0.1) * MIN_ACCELERATION;
      }
      const totalForce = accel * this.body.mass;
      const numContacts = leftContacts + rightContacts;
      // клиент 2019: добавка считается по обеим гусеницам (в 2014 — только по левой: 0.42·(10 − левые))
      const effectiveForce = (totalForce * (numContacts + 0.21 * (2 * TankConst.RAYS_PER_TRACK - numContacts))) / 10;
      const rayForce = effectiveForce / numContacts;
      const maxAngle = Math.PI / 4;
      const cutoffAngle = Math.PI / 3;
      for (let n = 0; n < TankConst.RAYS_PER_TRACK; n++) {
        this.applyForceFromRay(this.leftTrack.rays[n], yAxis, rayForce, cutoffAngle, maxAngle);
        this.applyForceFromRay(this.rightTrack.rays[n], yAxis, rayForce, cutoffAngle, maxAngle);
      }
      let turnFactor = 1;
      if (leftContacts == 0 || rightContacts == 0) turnFactor = 0.5;
      let turnDelta = 0;
      if (turnDirection == 0) {
        const stabilization = Number.isNaN(this.stabilizationAcceleration) ? turnAcceleration : this.stabilizationAcceleration;
        turnDelta = -sign(turnSpeed) * stabilization * slopeFactor * dt;
        if (sign(turnSpeed) != sign(turnSpeed + turnDelta)) turnDelta = -turnSpeed;
      } else {
        if (this.isReversedTurn(turnDirection, turnSpeed, moveDirection)) turnAcceleration = this.reverseTurnAcceleration;
        turnDelta = turnDirection * turnAcceleration * slopeFactor * dt;
        if (moveDirection == -1 && this.reverseBackTurn) turnDelta = -turnDelta;
      }
      let turnLimit = maxTurnSpeed;
      if (turnDirection != 0) turnLimit = (maxTurnSpeed * this.turnSpeedNumber) / TURN_SPEED_COUNT;
      turnLimit *= turnFactor;
      const newTurnSpeed = clamp(turnSpeed + turnDelta, -turnLimit, turnLimit);
      relativeAngularVelocity.setLengthAlongDirection(zAxis, newTurnSpeed);
      rotation.x = surfaceAngularVelocity.x + relativeAngularVelocity.x;
      rotation.y = surfaceAngularVelocity.y + relativeAngularVelocity.y;
      rotation.z = surfaceAngularVelocity.z + relativeAngularVelocity.z;
    }
  }

  /** клиент 2019: при «обратном» повороте задним ходом направление сравнивается с учётом инверсии */
  private isReversedTurn(turnDirection: number, turnSpeed: number, moveDirection: number): boolean {
    const k = this.reverseBackTurn && moveDirection < 0 ? -1 : 1;
    return turnDirection * turnSpeed * k < 0;
  }

  private calculateSurfaceVelocities(velocity: Vector3, angularVelocity: Vector3): void {
    const k = 1 / (this.leftTrack.numContacts + this.rightTrack.numContacts);
    let x = 0;
    let y = 0;
    let z = 0;
    for (let n = 0; n < TankConst.RAYS_PER_TRACK; n++) {
      let ray = this.leftTrack.rays[n];
      if (ray.hasCollision) {
        const p = ray.rayHit.position;
        x += p.x;
        y += p.y;
        z += p.z;
      }
      ray = this.rightTrack.rays[n];
      if (ray.hasCollision) {
        const p = ray.rayHit.position;
        x += p.x;
        y += p.y;
        z += p.z;
      }
    }
    x *= k;
    y *= k;
    z *= k;
    averagePoint.x = x;
    averagePoint.y = y;
    averagePoint.z = z;
    velocity.x = 0;
    velocity.y = 0;
    velocity.z = 0;
    angularVelocity.x = 0;
    angularVelocity.y = 0;
    angularVelocity.z = 0;
    for (let n = 0; n < TankConst.RAYS_PER_TRACK; n++) {
      this.addVelocitiesFromRay(this.leftTrack.rays[n], averagePoint, velocity, angularVelocity);
      this.addVelocitiesFromRay(this.rightTrack.rays[n], averagePoint, velocity, angularVelocity);
    }
    velocity.x *= k;
    velocity.y *= k;
    velocity.z *= k;
    angularVelocity.x *= k;
    angularVelocity.y *= k;
    angularVelocity.z *= k;
  }

  private addVelocitiesFromRay(ray: SuspensionRay, center: Vector3, velocity: Vector3, angularVelocity: Vector3): void {
    if (!ray.hasCollision) return;
    velocity.x += ray.surfaceVelocity.x;
    velocity.y += ray.surfaceVelocity.y;
    velocity.z += ray.surfaceVelocity.z;
    const p = ray.rayHit.position;
    const rx = p.x - center.x;
    const ry = p.y - center.y;
    const rz = p.z - center.z;
    const lengthSqr = rx * rx + ry * ry + rz * rz;
    if (lengthSqr > 1) {
      const k = 1 / lengthSqr;
      const v = ray.surfaceVelocity;
      angularVelocity.x += (ry * v.z - rz * v.y) * k;
      angularVelocity.y += (rz * v.x - rx * v.z) * k;
      angularVelocity.z += (rx * v.y - ry * v.x) * k;
    }
  }

  private applyForceFromRay(ray: SuspensionRay, direction: Vector3, magnitude: number, cutoffAngle: number, maxAngle: number): void {
    if (!ray.hasCollision) return;
    const x = direction.x;
    const y = direction.y;
    const z = direction.z;
    const lengthSqr = x * x + y * y + z * z;
    if (lengthSqr > 0.00001) {
      let angle = Math.acos(ray.rayHit.normal.z);
      if (angle < 0) angle = -angle;
      if (angle < cutoffAngle) {
        let k = magnitude / Math.sqrt(lengthSqr);
        if (angle > maxAngle) k *= (cutoffAngle - angle) / (cutoffAngle - maxAngle);
        force.x = x * k;
        force.y = y * k;
        force.z = z * k;
        this.body.addWorldForceAtLocalPoint(ray.getOrigin(), force);
      }
    }
  }

  /** Гравитация вдоль склона компенсируется, если склон круче 45° и половина лучей касается земли. */
  private applySlopeHack(): void {
    if (this.rightTrack.numContacts >= this.rightTrack.numRays >> 1 || this.leftTrack.numContacts >= this.leftTrack.numRays >> 1) {
      const m = this.body.baseMatrix;
      const gravity = (this.body.scene as PhysicsScene).gravity;
      const projection = gravity.x * m.c + gravity.y * m.g + gravity.z * m.k;
      const g = gravity.length();
      const limit = Math.SQRT1_2 * g;
      if (projection < -limit || projection > limit) {
        const fx = (m.c * projection - gravity.x) * this.body.mass;
        const fy = (m.g * projection - gravity.y) * this.body.mass;
        const fz = (m.k * projection - gravity.z) * this.body.mass;
        this.body.addForceXYZ(fx, fy, fz);
      }
    }
  }
}

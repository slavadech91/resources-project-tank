// 1:1 из alternativa/tanks/battle/objects/tank/{TankConst,SuspensionParams,ValueSmoother,EncryptedValueSmoother,
// RayCollisionFilter,SuspensionRay,Track}.as. EncryptedNumber заменены обычными числами.
import type { Body } from '../../physics/Body.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { RayHit, type IRayCollisionFilter } from '../../physics/collision/types.ts';
import type { PhysicsScene } from '../../physics/PhysicsScene.ts';
import { MAX_SLOPE_ANGLE_COS } from '../physics/TankBody.ts';

export const TankConst = {
  TRACK_RAY_Z_OFFSET: 10, // §<"H§
  RAYS_PER_TRACK: 5, // §3!X§
} as const;

export class SuspensionParams {
  maxRayLength = 50; // §-!'§
  nominalRayLength = 25; // §4""§
  springCoeff = 0; // §>!1§
  dampingCoeff = 1000; // §2t§
}

export interface ValueSmoother {
  reset(value: number): void;
  update(dt: number): number;
  setTargetValue(value: number): void;
  getTargetValue(): number;
}

export class EncryptedValueSmoother implements ValueSmoother {
  private currentValue: number; // §8"V§
  private targetValue: number; // §3"I§
  private readonly smoothingSpeedUp: number; // §6M§
  private readonly smoothingSpeedDown: number; // §]![§

  constructor(smoothingSpeedUp: number, smoothingSpeedDown: number, targetValue: number, currentValue: number) {
    this.smoothingSpeedUp = smoothingSpeedUp;
    this.smoothingSpeedDown = smoothingSpeedDown;
    this.targetValue = targetValue;
    this.currentValue = currentValue;
  }

  reset(value: number): void {
    this.currentValue = value;
    this.targetValue = value;
  }

  update(dt: number): number {
    let current = this.currentValue;
    const target = this.targetValue;
    if (current < target) {
      current += this.smoothingSpeedUp * dt;
      if (current > target) current = target;
    } else if (current > target) {
      current -= this.smoothingSpeedDown * dt;
      if (current < target) current = target;
    }
    this.currentValue = current;
    return current;
  }

  setTargetValue(value: number): void {
    this.targetValue = value;
  }

  getTargetValue(): number {
    return this.targetValue;
  }
}

class RayCollisionFilter implements IRayCollisionFilter {
  private readonly body: Body; // §7b§

  constructor(body: Body) {
    this.body = body;
  }

  considerBody(body: Body): boolean {
    return this.body != body;
  }
}

export class SuspensionRay {
  collisionGroup = 0; // §'!_§
  hasCollision = false; // §5"-§
  rayHit = new RayHit(); // §0!G§
  springForce = 0; // §^"A§
  readonly surfaceVelocity = new Vector3(); // §]!m§ — скорость точки контакта
  speed = 0; // §9"$§ — скорость танка относительно поверхности под лучом
  private readonly body: Body; // §7b§
  private readonly origin = new Vector3(); // §;"H§
  private readonly direction = new Vector3(); // §4"G§
  private readonly params: SuspensionParams; // §%L§
  private readonly globalOrigin = new Vector3(); // §,!,§
  private readonly globalDirection = new Vector3(); // §<J§
  private prevDisplacement = 0; // §!-§
  private readonly filter: RayCollisionFilter; // §["D§

  constructor(body: Body, origin: Vector3, direction: Vector3, params: SuspensionParams) {
    this.body = body;
    this.origin.copy(origin);
    this.direction.copy(direction);
    this.params = params;
    this.filter = new RayCollisionFilter(body);
  }

  update(dt: number): void {
    this.raycast();
    if (this.hasCollision) {
      this.calculateSpringForce(dt);
      this.calculateContactVelocity();
    }
  }

  private raycast(): void {
    const m = this.body.baseMatrix;
    const d = this.direction;
    this.globalDirection.x = m.a * d.x + m.b * d.y + m.c * d.z;
    this.globalDirection.y = m.e * d.x + m.f * d.y + m.g * d.z;
    this.globalDirection.z = m.i * d.x + m.j * d.y + m.k * d.z;
    const p = this.body.state.position;
    const o = this.origin;
    this.globalOrigin.x = m.a * o.x + m.b * o.y + m.c * o.z;
    this.globalOrigin.y = m.e * o.x + m.f * o.y + m.g * o.z;
    this.globalOrigin.z = m.i * o.x + m.j * o.y + m.k * o.z;
    this.globalOrigin.x += p.x;
    this.globalOrigin.y += p.y;
    this.globalOrigin.z += p.z;
    if (this.hasCollision) {
      this.prevDisplacement = this.params.maxRayLength - this.rayHit.t;
    }
    const scene = this.body.scene as PhysicsScene;
    this.hasCollision = scene.collisionDetector.raycast(
      this.globalOrigin,
      this.globalDirection,
      this.collisionGroup,
      this.params.maxRayLength,
      this.filter,
      this.rayHit,
    );
    // клиент 2019: поверхность круче 60° не держит подвеску
    if (this.hasCollision) this.hasCollision = this.rayHit.normal.z > MAX_SLOPE_ANGLE_COS;
  }

  calculateSpringForce(dt: number): void {
    const displacement = this.params.maxRayLength - this.rayHit.t;
    this.springForce = this.params.springCoeff * displacement;
    const velocity = (displacement - this.prevDisplacement) / dt;
    this.springForce += velocity * this.params.dampingCoeff;
    if (this.springForce < 0) this.springForce = 0;
  }

  private calculateContactVelocity(): void {
    const body = (this.rayHit.shape as NonNullable<RayHit['shape']>).body as Body;
    if (body.data != null) {
      const position = body.state.position;
      const velocity = body.state.velocity;
      const rotation = body.state.rotation;
      const hit = this.rayHit.position;
      const rx = hit.x - position.x;
      const ry = hit.y - position.y;
      const rz = hit.z - position.z;
      this.surfaceVelocity.x = rotation.y * rz - rotation.z * ry;
      this.surfaceVelocity.y = rotation.z * rx - rotation.x * rz;
      this.surfaceVelocity.z = rotation.x * ry - rotation.y * rx;
      this.surfaceVelocity.x += velocity.x;
      this.surfaceVelocity.y += velocity.y;
      this.surfaceVelocity.z += velocity.z;
    } else {
      this.surfaceVelocity.x = 0;
      this.surfaceVelocity.y = 0;
      this.surfaceVelocity.z = 0;
    }
  }

  getGlobalOrigin(): Vector3 {
    return this.globalOrigin;
  }

  getGlobalDirection(): Vector3 {
    return this.globalDirection;
  }

  getOrigin(): Vector3 {
    return this.origin;
  }

  getActualLength(): number {
    if (this.hasCollision) return this.rayHit.t;
    return this.params.maxRayLength;
  }
}

export class Track {
  body: Body; // §7b§
  rays: SuspensionRay[] = []; // §>">§
  numRays = 0; // §5L§
  numContacts = 0; // §#!q§
  params: SuspensionParams = null as unknown as SuspensionParams; // §%L§
  animationSpeed = 0; // §-"T§
  side: number; // §`!5§ — -1 левая, 1 правая
  readonly averageSurfaceVelocity = new Vector3(); // §8!G§

  constructor(body: Body, numRays: number, position: Vector3, length: number, params: SuspensionParams, side: number) {
    this.body = body;
    this.side = side;
    this.setTrackParams(numRays, position, length, params);
  }

  setTrackParams(numRays: number, position: Vector3, length: number, params: SuspensionParams): void {
    this.numRays = numRays;
    this.params = params;
    this.rays = new Array<SuspensionRay>(numRays);
    const step = length / (numRays - 1);
    for (let n = 0; n < numRays; n++) {
      const origin = new Vector3(position.x, position.y + 0.5 * length - n * step, position.z);
      this.rays[n] = new SuspensionRay(this.body, origin, Vector3.DOWN, params);
    }
  }

  setCollisionGroup(group: number): void {
    for (let n = 0; n < this.numRays; n++) this.rays[n].collisionGroup = group;
  }

  /** луч стоит на статике, а не на танке (клиент 2019) */
  hasContactsWithStatic(): boolean {
    for (const ray of this.rays) {
      if (ray.hasCollision && ray.rayHit.shape?.body?.data == null) return true;
    }
    return false;
  }

  calculateSuspensionContacts(dt: number): void {
    this.numContacts = 0;
    this.averageSurfaceVelocity.x = 0;
    this.averageSurfaceVelocity.y = 0;
    this.averageSurfaceVelocity.z = 0;
    const velocity = this.body.state.velocity;
    for (let n = 0; n < this.numRays; n++) {
      const ray = this.rays[n];
      ray.update(dt);
      if (ray.hasCollision) {
        ++this.numContacts;
        this.body.addWorldForceScaled(ray.getGlobalOrigin(), ray.getGlobalDirection(), -ray.springForce);
        this.averageSurfaceVelocity.x += ray.surfaceVelocity.x;
        this.averageSurfaceVelocity.y += ray.surfaceVelocity.y;
        this.averageSurfaceVelocity.z += ray.surfaceVelocity.z;
        const vx = velocity.x - ray.surfaceVelocity.x;
        const vy = velocity.y - ray.surfaceVelocity.y;
        const vz = velocity.z - ray.surfaceVelocity.z;
        ray.speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      } else {
        ray.speed = 0;
      }
    }
    if (this.numContacts > 1) {
      this.averageSurfaceVelocity.x /= this.numContacts;
      this.averageSurfaceVelocity.y /= this.numContacts;
      this.averageSurfaceVelocity.z /= this.numContacts;
    }
  }

  /** §null§ — плавное изменение скорости анимации гусеницы */
  setAnimationSpeed(target: number, delta: number): void {
    if (this.animationSpeed < target) {
      const value = this.animationSpeed + delta;
      this.animationSpeed = value > target ? target : value;
    } else if (this.animationSpeed > target) {
      const value = this.animationSpeed - delta;
      this.animationSpeed = value < target ? target : value;
    }
  }
}

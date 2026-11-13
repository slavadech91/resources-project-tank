// Рикошет по оригиналу: RicochetWeapon, RicochetShot, RicochetTargetingSystem (клиент 2014) и Narukami.
// Стрельба автоматическая, пока держится кнопка: темп ограничен перезарядкой, а после первых выстрелов —
// энергией (ёмкость 1000, зарядка 100/с, расход 133.71…119 на выстрел у M0–M3). Шар летит с радиусом 0.5 м:
// 6 радиальных лучей ловят танки, от статики отражается и летит дальше, пока не истратит всю дальность
// (отскоков не ограничено). После первого отскока может попасть в самого стрелка. Наведение — веер лучей
// вверх/вниз, каждый луч с отскоками; прямая цель получает приоритет +2.
import type { Body } from '../../physics/Body.ts';
import { RayHit, type IRayCollisionFilter } from '../../physics/collision/types.ts';
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { BattleRunner, PhysicsController, PhysicsInterpolator } from '../BattleRunner.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import type { GraphicEffect } from '../sfx/SmokyEffects.ts';
import type { RicochetBall, RicochetEffects } from '../sfx/RicochetEffects.ts';
import type { SimpleKeyboardWeaponController } from '../tank/Controllers.ts';
import type { Tank, TankWeapon } from '../tank/Tank.ts';
import { MarginalCollider } from './SectorTargeting.ts';
import { AllGlobalGunParams, WeaponForces, calculateMainGunParams } from './SmokyWeapon.ts';

/** RicochetCC в клиентском масштабе: м/с, м, м, единицы энергии и единиц в секунду */
export class RicochetData {
  constructor(
    public speed = 94.75,
    public range = 72.9,
    public shotRadius = 0.5,
    public energyCapacity = 1000,
    public energyPerShot = 133.71,
    public energyRecharge = 100,
    public maxBounces = Infinity,
  ) {}
}

/** Что слушает сеть; bounces — сколько раз шар отразился до попадания (для своего попадания) */
export interface RicochetShotListener {
  onShot(shotId: number, direction: Vector3): void;
  onShotHit(shotId: number, target: Tank, point: Vector3, bounces: number): void;
}

let nextShotId = 0;

/** RicochetShot: 6 радиальных лучей (NUM_RADIAL_RAYS) */
const NUM_RADIAL_RAYS = 6;
const RADIAL_STEP = (2 * Math.PI) / NUM_RADIAL_RAYS;
/** отступ точки отскока от стены, чтобы следующий луч не попал в неё же */
const BOUNCE_OFFSET = 0.1;
/** при наведении: сколько отскоков моделировать (в оригинале без предела, здесь страховка от цикла) */
const MAX_TARGET_BOUNCES = 32;
/** BaseRicochetTargeEvaluator.DISTANCE_WEIGHT и бонус прямой видимости */
const DISTANCE_WEIGHT = 0.65;
const DIRECT_PRIORITY = 2;

const rayHit = new RayHit();
const radialHit = new RayHit();
const staticNormal = new Vector3();
const targetRotated = new Vector3();
const targetMatrix = new Matrix3();

function tankOf(body: Body | null | undefined): Tank | null {
  const data = body?.data as Tank | null | undefined;
  return data != null && typeof data.health == 'number' ? data : null;
}

/** самый ортогональный оси вектор: вокруг него строятся 6 точек радиальных лучей */
function mostOrthogonalAxis(direction: Vector3, result: Vector3): Vector3 {
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  if (ax <= ay && ax <= az) result.reset(0, direction.z, -direction.y);
  else if (ay <= az) result.reset(-direction.z, 0, direction.x);
  else result.reset(direction.y, -direction.x, 0);
  return result;
}

interface RicochetAmmunition {
  runner: BattleRunner;
  effects: RicochetEffects | null;
  data: RicochetData;
  impactForce: number;
}

/** шар Рикошета: полёт с отскоками, 6 радиальных лучей, взрыв на танке; в стрелка — только после отскока */
class RicochetShot implements PhysicsController, PhysicsInterpolator, IRayCollisionFilter, GraphicEffect {
  private readonly position = new Vector3();
  private readonly prevPosition = new Vector3();
  private readonly renderPosition = new Vector3();
  private readonly direction = new Vector3();
  private readonly radialPoints: Vector3[] = Array.from({ length: NUM_RADIAL_RAYS }, () => new Vector3());
  private readonly radialAxis = new Vector3();
  private readonly radialRotation = new Matrix3();
  private traveled = 0;
  private bounces = 0;
  private alive = true;
  private readonly ball: RicochetBall | null;

  constructor(
    readonly shotId: number,
    private readonly ammo: RicochetAmmunition,
    position: Vector3,
    direction: Vector3,
    private readonly shooter: Body,
    private readonly onHit: ((shotId: number, target: Tank, point: Vector3, bounces: number) => void) | null,
    private readonly onEnd: ((shotId: number) => void) | null,
    /** false — чужой шар: урон считает сервер, но толчок от попадания виден всем */
    private readonly reportHit: boolean,
  ) {
    this.position.copy(position);
    this.prevPosition.copy(position);
    this.renderPosition.copy(position);
    this.direction.copy(direction).normalize();
    this.ball = ammo.effects ? ammo.effects.createBall() : null;
    this.initRadialPoints();
    ammo.runner.addPhysicsController(this);
    ammo.runner.addPhysicsInterpolator(this);
    ammo.effects?.scene.addGraphicEffect(this);
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** RicochetShot.considerBody: любой танк останавливает шар, стрелок — только после первого отскока */
  considerBody(body: Body): boolean {
    return body !== this.shooter || this.bounces > 0;
  }

  private initRadialPoints(): void {
    mostOrthogonalAxis(this.direction, this.radialAxis).normalize().scale(this.ammo.data.shotRadius * 100);
    this.radialRotation.fromAxisAngle(this.direction, RADIAL_STEP);
    for (let i = 0; i < NUM_RADIAL_RAYS; i++) {
      this.radialPoints[i].copy(this.position).add(this.radialAxis);
      this.radialRotation.transformVector(this.radialAxis, this.radialAxis);
    }
  }

  runBeforePhysicsUpdate(dt: number): void {
    if (!this.alive) return;
    const data = this.ammo.data;
    const range = data.range * 100;
    if (this.traveled >= range) {
      // RicochetShot.update: на конце дальности шар просто исчезает, без взрыва
      this.kill();
      return;
    }
    const detector = this.ammo.runner.getCollisionDetector();
    let remaining = Math.min(data.speed * 100 * dt, range - this.traveled);
    this.prevPosition.copy(this.position);
    while (remaining > 0 && this.alive) {
      let hitStatic = false;
      let staticT = 0;
      let rayLength = remaining;
      if (detector.raycast(this.position, this.direction, CollisionGroup.WEAPON, remaining, this, rayHit)) {
        const tank = tankOf(rayHit.shape?.body);
        if (tank != null) {
          this.position.addScaled(rayHit.t, this.direction);
          this.hitTank(tank, this.position);
          return;
        }
        hitStatic = true;
        staticT = rayHit.t;
        staticNormal.copy(rayHit.normal).normalize();
        rayLength = staticT;
      }
      // 6 лучей толщины шара: танк может задеть край, а не центр
      for (let i = 0; i < NUM_RADIAL_RAYS; i++) {
        if (!detector.raycast(this.radialPoints[i], this.direction, CollisionGroup.WEAPON, rayLength, this, radialHit)) {
          this.radialPoints[i].addScaled(rayLength, this.direction);
          continue;
        }
        const tank = tankOf(radialHit.shape?.body);
        if (tank != null) {
          // Narukami reports the shell centre at impact, not the offset radial ray.
          this.hitTank(tank, this.position.clone().addScaled(radialHit.t, this.direction));
          return;
        }
        this.radialPoints[i].addScaled(rayLength, this.direction);
      }
      if (hitStatic) {
        if (this.bounces >= data.maxBounces) {
          this.kill();
          return;
        }
        this.traveled += staticT;
        remaining -= staticT;
        this.position.addScaled(staticT, this.direction);
        // RicochetShot.reflectTrajectory
        this.direction.addScaled(-2 * this.direction.dot(staticNormal), staticNormal).normalize();
        this.position.addScaled(BOUNCE_OFFSET, staticNormal);
        this.bounces++;
        this.ammo.effects?.createBounceEffects(this.position);
        this.initRadialPoints();
      } else {
        this.traveled += remaining;
        this.position.addScaled(remaining, this.direction);
        remaining = 0;
      }
    }
  }

  private hitTank(tank: Tank, point: Vector3): void {
    tank.applyWeaponHit(point, this.direction, this.ammo.impactForce);
    this.ammo.effects?.createExplosionEffects(point);
    if (this.reportHit) this.onHit?.(this.shotId, tank, point.clone(), this.bounces);
    this.kill();
  }

  interpolatePhysicsState(t: number): void {
    this.renderPosition.interpolate(t, this.prevPosition, this.position);
  }

  play(delta: number, cameraPosition: Vector3): boolean {
    if (!this.alive) return false;
    this.ball?.update(delta, this.renderPosition, this.direction, 1, cameraPosition);
    return true;
  }

  /** взрыв по событию сервера (чужой шар мог разойтись с нашей физикой) */
  explodeAt(point: Vector3): void {
    if (!this.alive) return;
    this.ammo.effects?.createExplosionEffects(point);
    this.kill();
  }

  private kill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.ammo.runner.removePhysicsController(this);
    this.ammo.runner.removePhysicsInterpolator(this);
    this.onEnd?.(this.shotId);
  }

  destroy(): void {
    this.kill();
    this.ball?.destroy();
  }
}

/**
 * RicochetTargetingSystem.considerBody: луч наведения не выбирает стрелка, но любой танк (в т.ч. союзник
 * или труп) останавливает его — своих отсекает приоритет цели, как TeamDMRicochetTargetEvaluator
 */
class RicochetTargetFilter implements IRayCollisionFilter {
  shooter: Body | null = null;

  considerBody(body: Body): boolean {
    return body !== this.shooter;
  }
}

/** RicochetTargetingSystem: веер лучей вверх/вниз, каждый с отскоками, приоритет как BaseRicochetTargeEvaluator */
class RicochetTargeting {
  autoAimUp = 0;
  autoAimDown = 0;
  private readonly filter = new RicochetTargetFilter();
  private readonly marginalCollider: MarginalCollider;
  private readonly hit = new RayHit();
  private readonly dir = new Vector3();
  private readonly origin = new Vector3();
  private readonly initial = new Vector3();
  private readonly bestDirection = new Vector3();
  private best = 0;

  constructor(
    private readonly detector: TanksCollisionDetector,
    public maxDistance: number,
    public maxBounces = MAX_TARGET_BOUNCES,
  ) {
    this.marginalCollider = new MarginalCollider(detector);
  }

  setAutoAimAngles(up: number, down: number): void {
    this.autoAimUp = Math.max(0, up);
    this.autoAimDown = Math.max(0, down);
  }

  target(shooter: Body, params: AllGlobalGunParams, result: { direction: Vector3 }): void {
    this.filter.shooter = shooter;
    this.best = 0;
    const maxAngle = Math.max(this.autoAimUp, this.autoAimDown);
    this.checkDirection(params.muzzlePosition, params.direction, 0, maxAngle);
    const raysUp = Math.trunc((this.autoAimUp * 8 * 180) / Math.PI);
    const raysDown = Math.trunc((this.autoAimDown * 8 * 180) / Math.PI);
    const stepUp = raysUp > 0 ? this.autoAimUp / raysUp : 0;
    const stepDown = raysDown > 0 ? this.autoAimDown / raysDown : 0;
    if (raysUp > 0) {
      targetMatrix.fromAxisAngle(params.elevationAxis, stepUp);
      this.initial.copy(params.direction);
      for (let i = 0; i < raysUp; i++) {
        targetMatrix.transformVector(this.initial, targetRotated);
        this.initial.copy(targetRotated);
        this.checkDirection(params.muzzlePosition, this.initial, (i + 1) * stepUp, maxAngle);
      }
    }
    if (raysDown > 0) {
      targetMatrix.fromAxisAngle(params.elevationAxis, -stepDown);
      this.initial.copy(params.direction);
      for (let i = 0; i < raysDown; i++) {
        targetMatrix.transformVector(this.initial, targetRotated);
        this.initial.copy(targetRotated);
        this.checkDirection(params.muzzlePosition, this.initial, (i + 1) * stepDown, maxAngle);
      }
    }
    this.filter.shooter = null;
    if (this.best > 0) result.direction.copy(this.bestDirection);
    else result.direction.copy(params.direction);
  }

  private checkDirection(origin: Vector3, rayDirection: Vector3, angle: number, maxAngle: number): void {
    this.origin.copy(origin);
    this.dir.copy(rayDirection);
    let remaining = this.maxDistance;
    let bounces = 0;
    while (remaining > 0 && bounces <= this.maxBounces) {
      if (!this.detector.raycast(this.origin, this.dir, CollisionGroup.WEAPON, remaining, this.filter, this.hit)) return;
      remaining = Math.max(0, remaining - this.hit.t);
      const body = this.hit.shape?.body ?? null;
      const tank = tankOf(body);
      if (tank != null && body !== this.filter.shooter && tank.health > 0 && !tank.friendly) {
        const direct = bounces > 0 || !this.marginalCollider.segmentWithStaticIntersection(this.origin, this.hit.position);
        if (direct) {
          const traveled = this.maxDistance - remaining;
          const priority =
            1 - (DISTANCE_WEIGHT * traveled) / Math.max(1, this.maxDistance) - ((1 - DISTANCE_WEIGHT) * angle) / Math.max(1e-6, maxAngle) +
            (bounces == 0 ? DIRECT_PRIORITY : 0);
          if (priority > this.best) {
            this.best = priority;
            this.bestDirection.copy(rayDirection);
          }
          return;
        }
      }
      if (this.hit.normal.length() < 1e-6) return;
      staticNormal.copy(this.hit.normal).normalize();
      const dot = this.dir.dot(staticNormal);
      this.dir.addScaled(-2 * dot, staticNormal).normalize();
      this.origin.copy(this.hit.position).addScaled(0.5, staticNormal);
      bounces++;
    }
  }
}

const gunParams = new AllGlobalGunParams();
const shotDirection = new Vector3();
const staticHit = new RayHit();

export class RicochetWeapon implements TankWeapon {
  private enabled = false;
  private nextShotTime = 0;
  /** время, когда энергия была такой, что при 0 она бы равнялась energy; getEnergy(time) */
  private energyBaseTime = 0;
  private platform: Tank | null = null;
  readonly ammo: RicochetAmmunition;
  listener: RicochetShotListener | null = null;
  private readonly targeting: RicochetTargeting;
  private readonly targetingResult: { direction: Vector3 } = { direction: new Vector3() };

  constructor(
    private reloadTime: number,
    readonly forces: WeaponForces,
    private readonly controller: SimpleKeyboardWeaponController,
    runner: BattleRunner,
  ) {
    this.ammo = { runner, effects: null, data: new RicochetData(), impactForce: forces.getImpactForce() };
    this.targeting = new RicochetTargeting(runner.getCollisionDetector(), this.ammo.data.range * 100);
    this.targeting.setAutoAimAngles(0.15708, 0.20944);
    this.setEnergyFull();
  }

  set effects(effects: RicochetEffects | null) {
    this.ammo.effects = effects;
  }

  get effects(): RicochetEffects | null {
    return this.ammo.effects;
  }

  configure(data: RicochetData): void {
    this.ammo.data = data;
    this.targeting.maxDistance = data.range * 100;
    this.targeting.maxBounces = Math.min(data.maxBounces, MAX_TARGET_BOUNCES);
    this.setEnergyFull();
  }

  /** WeaponCommonCC.reload_time: у модификации пушки своя перезарядка */
  setReloadTime(reloadTime: number): void {
    this.reloadTime = Math.max(1, reloadTime);
  }

  setAutoAimAngles(up: number, down: number): void {
    this.targeting.setAutoAimAngles(up, down);
  }

  init(tank: Tank): void {
    this.platform = tank;
    this.reset();
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.controller.discardStoredAction();
  }

  disable(): void {
    this.enabled = false;
  }

  reset(): void {
    this.controller.discardStoredAction();
    this.nextShotTime = 0;
    this.setEnergyFull();
  }

  /** RicochetWeapon.getStatus: доля заряда баллона, а не перезарядки */
  getStatus(): number {
    return Math.min(1, Math.max(0, this.energyNow(performance.now()) / this.config.energyCapacity));
  }

  runLogic(time: number, _delta: number): void {
    // оригинал считает время getTimer() в целых мс: без округления перезарядка иногда пропускает кадр
    const now = Math.floor(time);
    // RicochetWeapon.runLogic: wasActive() — удержание или короткий клик между кадрами
    if (this.enabled && this.controller.wasActive() && now >= this.nextShotTime) {
      const energy = this.energyNow(now);
      if (energy >= this.config.energyPerShot) this.shoot(now, energy);
    }
    this.controller.discardStoredAction();
  }

  private get config(): RicochetData {
    return this.ammo.data;
  }

  /** RicochetWeapon.getEnergy/setEnergyBaseTime: энергия растёт со временем и тратится выстрелом */
  private energyNow(time: number): number {
    const rate = this.config.energyRecharge / 1000;
    if (rate <= 0) return 0;
    return Math.min(this.config.energyCapacity, Math.max(0, rate * (time - this.energyBaseTime)));
  }

  private setEnergy(time: number, energy: number): void {
    const rate = this.config.energyRecharge / 1000;
    this.energyBaseTime = rate > 0 ? time - energy / rate : time;
  }

  private setEnergyFull(): void {
    this.setEnergy(performance.now(), this.config.energyCapacity);
  }

  private shoot(time: number, energy: number): void {
    const tank = this.platform as Tank;
    this.setEnergy(time, energy - this.config.energyPerShot);
    this.nextShotTime = time + this.reloadTime;
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], gunParams);
    tank.getBody().addWorldForceScaled(gunParams.muzzlePosition, gunParams.direction, -this.forces.getRecoilForce());
    this.ammo.effects?.createShotEffects(tank.skin.turret.muzzles[0], tank.getTurretMatrix());
    const detector = this.ammo.runner.getCollisionDetector();
    if (detector.raycastStatic(gunParams.barrelOrigin, gunParams.direction, CollisionGroup.STATIC, tank.skin.turret.muzzles[0].y, null, staticHit)) {
      shotDirection.copy(gunParams.direction);
    } else {
      this.targeting.target(tank.getBody(), gunParams, this.targetingResult);
      shotDirection.copy(this.targetingResult.direction);
    }
    const shotId = nextShotId++;
    new RicochetShot(
      shotId,
      this.ammo,
      gunParams.muzzlePosition,
      shotDirection,
      tank.getBody(),
      (id, target, point, bounces) => this.listener?.onShotHit(id, target, point, bounces),
      null,
      true,
    );
    this.listener?.onShot(shotId, shotDirection);
  }
}

/** RemoteRicochetWeapon: чужой Рикошет по событию battle.ricochet — отдача, шар и толчки без сообщений серверу */
export class RemoteRicochetWeapon {
  private readonly params = new AllGlobalGunParams();
  private readonly shots = new Map<number, RicochetShot>();

  constructor(
    private readonly recoilForce: number,
    readonly ammo: RicochetAmmunition,
  ) {}

  fire(tank: Tank, shotId: number, direction: Vector3): void {
    const muzzle = tank.skin.turret.muzzles[0];
    calculateMainGunParams(tank, muzzle, this.params);
    tank.getBody().addWorldForceScaled(this.params.muzzlePosition, this.params.direction, -this.recoilForce);
    this.ammo.effects?.createShotEffects(muzzle, tank.getTurretMatrix());
    this.shots.set(
      shotId,
      new RicochetShot(shotId, this.ammo, this.params.muzzlePosition, direction, tank.getBody(), null, (id) => this.shots.delete(id), false),
    );
  }

  /** сервер подтвердил попадание: если наш шар ещё летит — толчок и взрыв по серверной точке */
  hitByServer(shotId: number, point: Vector3, target: Tank, direction: Vector3): void {
    const shot = this.shots.get(shotId);
    if (!shot) return;
    target.applyWeaponHit(point, direction, this.ammo.impactForce);
    shot.explodeAt(point);
    this.shots.delete(shotId);
  }

  /** попадание по событию сервера: если шар уже взорвался у нас сам — второго взрыва нет */
  explode(shotId: number, point: Vector3): void {
    const shot = this.shots.get(shotId);
    if (!shot) return;
    shot.explodeAt(point);
    this.shots.delete(shotId);
  }

  stopEffects(): void {
    for (const shot of this.shots.values()) shot.destroy();
    this.shots.clear();
  }
}

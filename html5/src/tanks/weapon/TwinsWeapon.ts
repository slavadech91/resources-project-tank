// Twins: alternativa/tanks/models/weapon/plasma/PlasmaWeapon.as, RemotePlasmaWeapon.as, PlasmaShot.as, PlasmaAmmunition.as
// + weakening/DistanceWeakening.as и MarginalCollider.segmentWithStaticIntersection.
// Стволы по очереди (2), каждый выстрел — медленный шар плазмы (PlasmaGunData: дальность, скорость, радиус),
// который летит в шагах физики и проверяет попадание лучом по центру и восемью лучами по окружности радиуса шара.
// Свой выстрел уходит на сервер как FIRE (ствол, номер шара, направление), попадание в танк — как HIT; урон считает сервер.
import type { Body } from '../../physics/Body.ts';
import { RayHit, type IRayCollisionFilter } from '../../physics/collision/types.ts';
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { BattleRunner, PhysicsController, PhysicsInterpolator } from '../BattleRunner.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import type { GraphicEffect } from '../sfx/SmokyEffects.ts';
import { PlasmaShotParams, PlasmaSprite, type TwinsEffects } from '../sfx/TwinsEffects.ts';
import type { SimpleKeyboardWeaponController } from '../tank/Controllers.ts';
import type { Tank, TankWeapon } from '../tank/Tank.ts';
import { SectorTargeting, TargetingResult, commonTargetPriority } from './SectorTargeting.ts';
import { AllGlobalGunParams, WeaponForces, calculateMainGunParams } from './SmokyWeapon.ts';

/** TwinsModel.createLocalWeapon: число стволов */
const NUM_BARRELS = 2;

/** TwinsCC в клиентском масштабе (BattleUtils.toClientScale, ×100): turrets.json twins_data distance 60, speed 25, shot_radius 0.5 */
export class PlasmaGunData {
  constructor(
    public shotRange = 6000,
    public shotSpeed = 2500,
    public shotRadius = 50,
  ) {}
}

/** DistanceWeakening: полный урон до maxDamageRadius, дальше линейно до minDamagePercent на minDamageRadius */
export class DistanceWeakening {
  constructor(
    private readonly fullDamageDistance = 1500,
    private readonly minDamageDistance = 5000,
    private readonly minDamagePercent = 2,
  ) {}

  getImpactCoeff(distance: number): number {
    const range = this.minDamageDistance - this.fullDamageDistance;
    if (range <= 0 || distance <= this.fullDamageDistance) return 1;
    if (distance >= this.minDamageDistance) return 0.01 * this.minDamagePercent;
    return 0.01 * (this.minDamagePercent + ((this.minDamageDistance - distance) * (100 - this.minDamagePercent)) / range);
  }

  getFullDamageDistance(): number {
    return this.fullDamageDistance;
  }
}

/** IPlasmaShotCallback: шар попал в танк */
interface PlasmaShotCallback {
  plasmaShotHit(shotId: number, body: Body, hitPoint: Vector3): void;
}

/** IPlasmaWeaponCallback: что слушает сеть */
export interface TwinsShotListener {
  onShot(barrel: number, shotId: number, direction: Vector3): void;
  /** попадание в танк: target — танк, hitPoint — мировая точка */
  onShotHit(shotId: number, target: Tank, hitPoint: Vector3): void;
}

/** Всё, что нужно шару: физика, эффекты, параметры пушки и ослабление */
export interface PlasmaAmmunition {
  runner: BattleRunner;
  effects: TwinsEffects | null;
  gun: PlasmaGunData;
  weakening: DistanceWeakening;
  impactForce: number;
}

/** PlasmaShot.§[e§: лучей по окружности шара */
const NUM_RADIAL_RAYS = 8;
const RADIAL_ANGLE = (2 * Math.PI) / NUM_RADIAL_RAYS;
const DOWN = new Vector3(0, 0, -1);

let nextShotId = 0; // PlasmaAmmunition.§#5§

const radialRotation = new Matrix3();
const radialAxis = new Vector3();
const stepVector = new Vector3();
const firstTickPoint = new Vector3();
const firstTickDirection = new Vector3();
const segment = new Vector3();
const shotHit = new RayHit();
const segmentHit = new RayHit();

function tankOf(body: Body | null | undefined): Tank | null {
  const data = body?.data as Tank | null | undefined;
  return data != null && typeof data.health == 'number' ? data : null;
}

/** MarginalCollider.segmentWithStaticIntersection: тонкий бокс вдоль отрезка — здесь луч по статике */
function segmentHitsStatic(detector: TanksCollisionDetector, from: Vector3, to: Vector3): boolean {
  segment.diff(to, from);
  const length = segment.length();
  if (length < 1e-6) return false;
  segment.scale(1 / length);
  return detector.raycastStatic(from, segment, CollisionGroup.STATIC, length, null, segmentHit);
}

/** PlasmaShot.getMostOrthogonalAxis: ось, перпендикулярная направлению */
function mostOrthogonalAxis(v: Vector3, result: Vector3): Vector3 {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ax <= ay && ax <= az) return result.reset(0, v.z, -v.y);
  if (ay <= az) return result.reset(-v.z, 0, v.x);
  return result.reset(v.y, -v.x, 0);
}

/** PlasmaShot: шар плазмы (PhysicsController + PhysicsInterpolator + Renderer) */
class PlasmaShot implements PhysicsController, PhysicsInterpolator, IRayCollisionFilter, GraphicEffect {
  private readonly barrelOrigin = new Vector3(); // §+"=§
  private readonly position = new Vector3(); // §!!v§
  private readonly prevPosition = new Vector3(); // §%"O§
  private readonly muzzle = new Vector3(); // §"e§
  private readonly renderPosition = new Vector3(); // §8I§
  private readonly direction = new Vector3(); // §6y§
  private readonly radialPoints: Vector3[] = Array.from({ length: NUM_RADIAL_RAYS }, () => new Vector3());
  private traveled = 0; // §""'§
  private firstTick = true; // §'!2§
  private alive = true;
  private readonly sprite: PlasmaSprite | null;
  private frame: number; // §[";§
  private rotation = Math.random() * 2 * Math.PI;
  private alpha = 1;

  constructor(
    readonly shotId: number,
    private readonly ammo: PlasmaAmmunition,
    barrelOrigin: Vector3,
    muzzle: Vector3,
    direction: Vector3,
    private readonly shooter: Body,
    private readonly callback: PlasmaShotCallback | null,
  ) {
    this.barrelOrigin.copy(barrelOrigin);
    this.position.copy(muzzle);
    this.prevPosition.copy(muzzle);
    this.muzzle.copy(muzzle);
    this.renderPosition.copy(muzzle);
    this.direction.copy(direction);
    const effects = ammo.effects;
    this.sprite = effects ? new PlasmaSprite(effects.scene.parent, effects.shotAnimation) : null;
    this.frame = this.sprite ? this.sprite.numFrames * Math.random() : 0;
    ammo.runner.addPhysicsController(this);
    ammo.runner.addPhysicsInterpolator(this);
    effects?.scene.addGraphicEffect(this);
  }

  considerBody(body: Body): boolean {
    return body != this.shooter;
  }

  runBeforePhysicsUpdate(dt: number): void {
    if (!this.alive) return;
    const detector = this.ammo.runner.getCollisionDetector();
    if (this.firstTick) {
      if (this.processFirstTick(detector)) return;
      this.firstTick = false;
    }
    const gun = this.ammo.gun;
    if (this.traveled > gun.shotRange) {
      this.kill();
      return;
    }
    const step = gun.shotSpeed * dt;
    if (detector.raycast(this.position, this.direction, CollisionGroup.WEAPON, step, this, shotHit)) {
      const body = shotHit.shape?.body ?? null;
      // статика — взрыв сразу; танк — если между дулом и точкой попадания нет статики (MarginalCollider)
      if (tankOf(body) == null || !segmentHitsStatic(detector, this.muzzle, shotHit.position)) {
        this.applyImpact(body, shotHit.position, this.direction, this.traveled + shotHit.t);
        this.kill();
        return;
      }
    }
    stepVector.copy(this.direction).scale(step);
    for (const point of this.radialPoints) {
      if (detector.raycast(point, this.direction, CollisionGroup.WEAPON, step, this, shotHit)) {
        const body = shotHit.shape?.body ?? null;
        if (tankOf(body) != null && !segmentHitsStatic(detector, this.muzzle, shotHit.position)) {
          this.applyImpact(body, shotHit.position, this.direction, this.traveled + shotHit.t);
          this.kill();
          return;
        }
      }
      point.add(stepVector);
    }
    this.traveled += step;
    this.prevPosition.copy(this.position);
    this.position.add(stepVector);
  }

  interpolatePhysicsState(t: number): void {
    this.renderPosition.interpolate(t, this.prevPosition, this.position);
  }

  /** PlasmaShot.render: кадр анимации, вращение −3 рад/с, угасание в конце дальности */
  play(delta: number): boolean {
    if (!this.alive) return false;
    const sprite = this.sprite;
    if (sprite) {
      const seconds = delta / 1000;
      this.frame += sprite.fps * seconds;
      if (this.frame >= sprite.numFrames) this.frame = 0;
      this.rotation -= 3 * seconds;
      const left = this.ammo.gun.shotRange - this.traveled;
      if (left < PlasmaShotParams.FADE_DISTANCE) this.alpha = Math.max(0, left / PlasmaShotParams.FADE_DISTANCE);
      sprite.update(this.renderPosition, this.frame, this.rotation, this.alpha);
    }
    return true;
  }

  /** PlasmaShot.destroy: шар уходит из физики; спрайт убирает сцена эффектов, когда play вернёт false */
  private kill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.ammo.runner.removePhysicsController(this);
    this.ammo.runner.removePhysicsInterpolator(this);
  }

  /** GraphicEffect.destroy */
  destroy(): void {
    this.kill();
    this.sprite?.destroy();
  }

  private initRadialPoints(center: Vector3, direction: Vector3, radius: number): void {
    mostOrthogonalAxis(direction, radialAxis).normalize().scale(radius);
    radialRotation.fromAxisAngle(direction, RADIAL_ANGLE);
    this.radialPoints[0].copy(center).add(radialAxis);
    for (let i = 1; i < NUM_RADIAL_RAYS; i++) {
      radialAxis.transform3(radialRotation);
      this.radialPoints[i].copy(center).add(radialAxis);
    }
  }

  /**
   * PlasmaShot.processFirstTick: дуло под поверхностью — взрыв на месте; затем отрезок «начало ствола → дуло»
   * центральным и радиальными лучами (ствол упёрся в стену или в танк вплотную).
   */
  private processFirstTick(detector: TanksCollisionDetector): boolean {
    const radius = this.ammo.gun.shotRadius;
    firstTickPoint.copy(this.position);
    firstTickPoint.z += radius;
    if (detector.raycastStatic(firstTickPoint, DOWN, CollisionGroup.STATIC, radius, null, shotHit)) {
      this.applyImpact(null, shotHit.position, null, 0);
      this.kill();
      return true;
    }
    firstTickDirection.diff(this.position, this.barrelOrigin);
    const length = firstTickDirection.length();
    firstTickDirection.normalize();
    if (detector.raycast(this.barrelOrigin, firstTickDirection, CollisionGroup.WEAPON, length, this, shotHit)) {
      this.applyImpact(shotHit.shape?.body ?? null, shotHit.position, firstTickDirection, 0);
      this.kill();
      return true;
    }
    this.initRadialPoints(this.barrelOrigin, firstTickDirection, radius);
    for (const point of this.radialPoints) {
      if (!detector.raycast(point, this.direction, CollisionGroup.WEAPON, length, this, shotHit)) continue;
      const body = shotHit.shape?.body ?? null;
      if (tankOf(body) == null) continue;
      this.barrelOrigin.addScaled(shotHit.t, firstTickDirection);
      this.applyImpact(body, this.barrelOrigin, firstTickDirection, 0);
      this.kill();
      return true;
    }
    this.initRadialPoints(this.position, this.direction, radius);
    return false;
  }

  /** PlasmaShot.applyImpact: взрыв, толчок танка и сообщение о попадании; по статике — след */
  private applyImpact(body: Body | null, point: Vector3, direction: Vector3 | null, distance: number): void {
    const coeff = this.ammo.weakening.getImpactCoeff(distance);
    this.ammo.effects?.createExplosion(point, coeff);
    const tank = tankOf(body);
    if (tank != null && body != null) {
      tank.applyWeaponHit(point, direction ?? this.direction, this.ammo.impactForce * coeff);
      this.callback?.plasmaShotHit(this.shotId, body, point.clone());
    } else {
      this.ammo.effects?.createHitMark(point, this.barrelOrigin);
    }
  }
}

const gunParams = new AllGlobalGunParams(); // §4"?§
const shotDirection = new Vector3(); // §`!e§
const staticHit = new RayHit(); // §0!G§

/** PlasmaWeapon: свой Twins */
export class TwinsWeapon implements TankWeapon, PlasmaShotCallback {
  private enabled = false; // §"!y§
  private nextShotTime = 0; // §,!M§
  private barrel = 0; // §`Z§
  private numBarrels = NUM_BARRELS; // §2!#§
  private platform: Tank | null = null; // §&!f§
  readonly ammo: PlasmaAmmunition;
  listener: TwinsShotListener | null = null; // §1!C§
  private readonly targeting: SectorTargeting;
  private readonly targetingResult = new TargetingResult();

  constructor(
    private reloadTime: number,
    readonly forces: WeaponForces,
    private readonly controller: SimpleKeyboardWeaponController,
    runner: BattleRunner,
  ) {
    this.ammo = { runner, effects: null, gun: new PlasmaGunData(), weakening: new DistanceWeakening(), impactForce: forces.getImpactForce() };
    // наведение по секторам целей на дальность выстрела; наклонённые лучи — от дула (setShotFromMuzzle)
    const targeting: SectorTargeting = new SectorTargeting(runner.getCollisionDetector(), {
      maxDistance: this.ammo.gun.shotRange,
      fromMuzzle: true,
      priority: (tank, distance, angle) =>
        commonTargetPriority(tank, distance, angle, this.ammo.weakening.getFullDamageDistance(), Math.max(targeting.autoAimUp, targeting.autoAimDown)),
    });
    targeting.setAutoAimAngles(0.15708, 0.20944);
    this.targeting = targeting;
  }

  set effects(effects: TwinsEffects | null) {
    this.ammo.effects = effects;
  }

  get effects(): TwinsEffects | null {
    return this.ammo.effects;
  }

  /** TwinsCC и WeaponWeakeningCC от сервера */
  configure(gun: PlasmaGunData, weakening: DistanceWeakening): void {
    this.ammo.gun = gun;
    this.ammo.weakening = weakening;
    this.targeting.options.maxDistance = gun.shotRange;
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
    this.numBarrels = Math.max(1, Math.min(NUM_BARRELS, tank.skin.turret.muzzles.length));
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
    this.barrel = 0;
  }

  getStatus(): number {
    const status = 1 - (this.nextShotTime - performance.now()) / this.reloadTime;
    return status > 1 ? 1 : status;
  }

  runLogic(time: number, _delta: number): void {
    if (this.enabled && this.controller.wasActive() && time >= this.nextShotTime) this.shoot(time);
    this.controller.discardStoredAction();
  }

  plasmaShotHit(shotId: number, body: Body, hitPoint: Vector3): void {
    const tank = tankOf(body);
    // TwinsModel.onShotHit: по мёртвому танку не сообщаем
    if (tank != null && tank.health > 0) this.listener?.onShotHit(shotId, tank, hitPoint);
  }

  private shoot(time: number): void {
    const tank = this.platform as Tank;
    this.nextShotTime = time + this.reloadTime;
    const muzzle = tank.skin.turret.muzzles[this.barrel];
    calculateMainGunParams(tank, muzzle, gunParams);
    tank.getBody().addWorldForceScaled(gunParams.muzzlePosition, gunParams.direction, -this.forces.getRecoilForce());
    this.ammo.effects?.createShotEffects(muzzle, tank.getTurretMatrix());
    const detector = this.ammo.runner.getCollisionDetector();
    // ствол в стене — летит прямо (взорвётся на первом шаге); иначе наведение по секторам целей
    if (detector.raycastStatic(gunParams.barrelOrigin, gunParams.direction, CollisionGroup.STATIC, muzzle.y, null, staticHit)) {
      shotDirection.copy(gunParams.direction);
    } else {
      this.targeting.target(tank.getBody(), gunParams, this.targetingResult);
      shotDirection.copy(this.targetingResult.direction);
    }
    const shotId = nextShotId++;
    new PlasmaShot(shotId, this.ammo, gunParams.barrelOrigin, gunParams.muzzlePosition, shotDirection, tank.getBody(), this);
    this.listener?.onShot(this.barrel, shotId, shotDirection);
    this.barrel = (this.barrel + 1) % this.numBarrels;
  }
}

/** RemotePlasmaWeapon: чужой Twins по команде FIRE — отдача, вспышка и шар без сообщений серверу */
export class RemoteTwinsWeapon {
  private readonly params = new AllGlobalGunParams();

  constructor(
    private readonly recoilForce: number,
    readonly ammo: PlasmaAmmunition,
  ) {}

  fire(tank: Tank, barrel: number, shotId: number, direction: Vector3): void {
    const muzzles = tank.skin.turret.muzzles;
    const muzzle = muzzles[Math.max(0, Math.min(barrel, muzzles.length - 1))];
    calculateMainGunParams(tank, muzzle, this.params);
    tank.getBody().addWorldForceScaled(this.params.muzzlePosition, this.params.direction, -this.recoilForce);
    this.ammo.effects?.createShotEffects(muzzle, tank.getTurretMatrix());
    new PlasmaShot(shotId, this.ammo, this.params.barrelOrigin, this.params.muzzlePosition, direction, tank.getBody(), null);
  }
}

// Рельса: models/weapon/railgun/RailgunWeapon.as, RailgunTargetingSystem.as (DMRailgunTargetEvaluator),
// RailgunShotResult, DirectionShotResult, MultibodyCollisionFilter, weapon/shared/MarginalCollider.
// Пробел -> зарядка chargingTime мс (эффект и звук) -> выстрел: луч пробивает танки насквозь до статики,
// каждый следующий получает impactForce × weakening^i. Наведение — по секторам целей (SectorTargeting) в углах DiscreteShotModel.
// Урон считает сервер: на него уходят startCharging / fire / fireDummy (RailgunModel).
import type { Body } from '../../physics/Body.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import { getDistantPoint, type RailgunEffects } from '../sfx/RailgunEffects.ts';
import type { SimpleKeyboardWeaponController } from '../tank/Controllers.ts';
import type { Tank, TankWeapon } from '../tank/Tank.ts';
import { SectorTargeting, TargetingResult, commonTargetPriority } from './SectorTargeting.ts';
import { AllGlobalGunParams, WeaponForces, calculateMainGunParams, isTurretAboveGround } from './SmokyWeapon.ts';

/** RailgunTargetingSystem: дистанция в приоритете нормируется на 20000, луч 1e10 */
const FULL_DISTANCE = 20000;
const MAX_RAY_LENGTH = 10000000000;
/** PenetratingTargetPriorityCalculator: доля общего приоритета рядом с эффективностью попадания */
const COMMON_PRIORITY_WEIGHT = 0.000001;

/** DMRailgunTargetEvaluator: живой танк — 1, мёртвый — 0; своих в DM нет; при равенстве — ближе к прицелу */
function railgunPriority(tank: Tank, distance: number, angle: number, maxAngle: number): number {
  const efficiency = tank.health > 0 ? 1 : 0;
  return efficiency + commonTargetPriority(tank, distance, angle, FULL_DISTANCE, maxAngle) * COMMON_PRIORITY_WEIGHT;
}

/** Что слушает сеть (RailgunCallback) */
export interface RailgunShotListener {
  onStartCharging(): void;
  /** targets/hitPoints — танки, пробитые лучом по порядку, и точки попадания в мировых координатах */
  onShot(staticHitPoint: Vector3 | null, targets: Tank[], hitPoints: Vector3[]): void;
  onShotDummy(): void;
}

/** RailgunShotResult */
export class RailgunShotResult {
  readonly staticHitPoint = new Vector3(); // §8"A§
  readonly staticHitNormal = new Vector3(); // §@!V§
  hasStaticHit = false; // §;""§
  readonly targets: Body[] = []; // §'q§
  readonly hitPoints: Vector3[] = []; // §!i§
  readonly direction = new Vector3(); // §`!e§

  /** TargetingResult: пробитые танки по порядку и статика, в которую упёрся луч */
  setTargetingResult(result: TargetingResult): void {
    this.direction.copy(result.direction);
    this.targets.length = 0;
    this.hitPoints.length = 0;
    for (const hit of result.hits) {
      this.targets.push(hit.body as Body);
      this.hitPoints.push(hit.position.clone());
    }
    this.hasStaticHit = result.staticHit != null;
    if (result.staticHit != null) {
      this.staticHitPoint.copy(result.staticHit.position);
      this.staticHitNormal.copy(result.staticHit.normal);
    }
  }

  setStaticHitPoint(point: Vector3, normal: Vector3): void {
    this.hasStaticHit = true;
    this.staticHitPoint.copy(point);
    this.staticHitNormal.copy(normal);
  }

  getStaticHitPoint(): Vector3 | null {
    return this.hasStaticHit ? this.staticHitPoint : null;
  }
}

const gunParams = new AllGlobalGunParams(); // §4"?§

export class RailgunWeapon implements TankWeapon {
  private enabled = false; // §"!y§
  private charging = false; // §2a§
  private nextTime = 0; // §-L§
  private platform: Tank | null = null; // §&!f§
  effects: RailgunEffects | null = null; // §=5§
  listener: RailgunShotListener | null = null; // §1!C§
  private chargingTime: number; // §2!@§
  private weakeningCoeff: number; // §;W§
  private readonly targeting: SectorTargeting; // §9";§
  private readonly targetingResult = new TargetingResult();

  constructor(
    private reloadTime: number, // §=!'§
    readonly forces: WeaponForces, // §4!-§
    private readonly controller: SimpleKeyboardWeaponController, // § !R§
    private readonly collisionDetector: TanksCollisionDetector,
    chargingTime: number,
    weakeningCoeff: number,
    autoAimUp: number,
    autoAimDown: number,
  ) {
    this.chargingTime = chargingTime;
    this.weakeningCoeff = weakeningCoeff;
    // луч пробивает танки до статики; цели — по секторам (PenetratingTargetingSystem)
    const targeting: SectorTargeting = new SectorTargeting(collisionDetector, {
      maxDistance: MAX_RAY_LENGTH,
      penetrating: true,
      weakeningCoeff,
      priority: (tank, distance, angle) => railgunPriority(tank, distance, angle, Math.max(targeting.autoAimUp, targeting.autoAimDown)),
    });
    targeting.setAutoAimAngles(autoAimUp, autoAimDown);
    this.targeting = targeting;
  }

  /** RailgunCC и ShotCC от сервера */
  configure(chargingTime: number, weakeningCoeff: number): void {
    this.chargingTime = chargingTime;
    this.weakeningCoeff = weakeningCoeff;
    this.targeting.options.weakeningCoeff = weakeningCoeff;
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
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.controller.discardStoredAction();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.effects?.stopEffects();
  }

  reset(): void {
    this.enabled = false;
    this.effects?.stopEffects();
    this.nextTime = 0;
    this.charging = false;
  }

  getStatus(): number {
    const now = performance.now();
    const status = this.charging ? (this.nextTime - now) / this.chargingTime : 1 - (this.nextTime - now) / this.reloadTime;
    return Math.min(1, Math.max(0, status));
  }

  runLogic(time: number, _delta: number): void {
    if (this.charging) {
      if (time >= this.nextTime) this.shoot(time);
    } else if (this.enabled) {
      if (time >= this.nextTime && this.controller.wasActive()) this.startCharging(time);
    }
    this.controller.discardStoredAction();
  }

  private startCharging(time: number): void {
    const tank = this.platform as Tank;
    this.charging = true;
    this.nextTime = time + this.chargingTime;
    const muzzle = tank.skin.turret.muzzles[0];
    this.effects?.createChargeEffect(muzzle, tank.getTurretMatrix(), this.chargingTime);
    calculateMainGunParams(tank, muzzle, gunParams);
    this.effects?.createSoundEffect(gunParams.muzzlePosition);
    this.listener?.onStartCharging();
  }

  private shoot(time: number): void {
    const tank = this.platform as Tank;
    this.charging = false;
    this.nextTime = time + this.reloadTime;
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], gunParams);
    // отдача приложена к дулу
    tank.getBody().addWorldForceScaled(gunParams.muzzlePosition, gunParams.direction, -this.forces.getRecoilForce());
    if (isTurretAboveGround(tank.getBody(), gunParams, this.collisionDetector)) {
      const result = new RailgunShotResult();
      this.targeting.target(tank.getBody(), gunParams, this.targetingResult);
      result.setTargetingResult(this.targetingResult);
      if (result.hitPoints.length > 0) this.applyImpactToTargets(result);
      this.createShotEffect(result);
      this.listener?.onShot(
        result.getStaticHitPoint()?.clone() ?? null,
        result.targets.map((body) => body.data as Tank),
        result.hitPoints.map((point) => point.clone()),
      );
    } else {
      this.listener?.onShotDummy();
    }
  }

  private applyImpactToTargets(result: RailgunShotResult): void {
    let weakening = 1;
    for (let i = 0; i < result.targets.length; i++) {
      (result.targets[i].data as Tank).applyWeaponHit(result.hitPoints[i], result.direction, this.forces.getImpactForce() * weakening);
      weakening *= this.weakeningCoeff;
    }
  }

  private createShotEffect(result: RailgunShotResult): void {
    const effects = this.effects;
    if (!effects) return;
    let end = result.getStaticHitPoint();
    if (end == null && result.targets.length > 0) end = getDistantPoint(gunParams.barrelOrigin, result.direction);
    effects.createShotTrail(gunParams.muzzlePosition, end, gunParams.direction);
    effects.createStaticHitMark(gunParams.barrelOrigin, result.getStaticHitPoint());
    if (end != null) {
      if (result.hasStaticHit) effects.createStaticHitEffect(gunParams.muzzlePosition, result.staticHitPoint, result.staticHitNormal);
      if (result.targets.length > 0) effects.createTargetHitEffects(gunParams.muzzlePosition, end, result.hitPoints, result.targets);
    }
  }
}

/** RemoteRailgunWeapon: зарядка и выстрел чужой рельсы по командам сервера */
export class RemoteRailgunWeapon {
  constructor(
    private readonly forces: WeaponForces,
    private readonly chargingTime: number,
    private readonly weakeningCoeff: number,
    readonly effects: RailgunEffects,
  ) {}

  startCharging(tank: Tank): void {
    const muzzle = tank.skin.turret.muzzles[0];
    this.effects.createChargeEffect(muzzle, tank.getTurretMatrix(), this.chargingTime);
    calculateMainGunParams(tank, muzzle, gunParams);
    this.effects.createSoundEffect(gunParams.muzzlePosition);
  }

  /** hitPoints — уже в мировых координатах (RailgunModel.fire переводит их из системы цели) */
  fire(tank: Tank, staticHitPoint: Vector3 | null, targets: (Body | null)[] | null, hitPoints: Vector3[] | null): void {
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], gunParams);
    tank.getBody().addWorldForceScaled(gunParams.muzzlePosition, gunParams.direction, -this.forces.getRecoilForce());
    let end = staticHitPoint;
    if (targets != null && hitPoints != null && targets.length > 0) {
      const direction = new Vector3().diff(hitPoints[hitPoints.length - 1], gunParams.barrelOrigin).normalize();
      if (direction.isFinite()) {
        if (end == null) end = getDistantPoint(gunParams.barrelOrigin, direction);
        let weakening = 1;
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i]?.data as Tank | null | undefined;
          if (target != null && hitPoints[i].isFinite()) target.applyWeaponHit(hitPoints[i], direction, this.forces.getImpactForce() * weakening);
          weakening *= this.weakeningCoeff;
        }
      }
      this.effects.createTargetHitEffects(gunParams.muzzlePosition, hitPoints[hitPoints.length - 1], hitPoints, targets);
    }
    this.effects.createShotTrail(gunParams.muzzlePosition, end, gunParams.direction);
    if (staticHitPoint != null) {
      this.effects.createStaticHitMark(gunParams.barrelOrigin, staticHitPoint);
      this.effects.createStaticHitEffect(gunParams.muzzlePosition, staticHitPoint, this.effects.getStaticHitPointNormal(gunParams.muzzlePosition, staticHitPoint));
    }
  }

  fireDummy(tank: Tank): void {
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], gunParams);
    tank.getBody().addWorldForceScaled(gunParams.muzzlePosition, gunParams.direction, -this.forces.getRecoilForce());
  }

  stopEffects(): void {
    this.effects.stopEffects();
  }
}

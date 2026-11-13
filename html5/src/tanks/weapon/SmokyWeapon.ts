// alternativa/tanks/models/weapon/smoky/SmokyWeapon.as + WeaponUtils.calculateMainGunParams + WeaponForces.
// Перенесены выстрел по пробелу, перезарядка, отдача, попадание в статику и эффекты.
// Цель: центральный луч CommonTargetingSystem; в сетевом бою ещё и автонаведение по вертикали в пределах углов
// из DiscreteShotModel (у Смоки +9°/−12°) — по секторам целей (SectorTargeting, как в поздних клиентах ТО).
// Выстрел уходит на сервер через shotListener как FIRE / FIRE_STATIC / FIRE_TARGET (урон считает сервер).
import type { Body } from '../../physics/Body.ts';
import { RayHit, type IRayCollisionFilter } from '../../physics/collision/types.ts';
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import { SectorTargeting, TargetingResult, commonTargetPriority, type TargetingHit } from './SectorTargeting.ts';
import type { ShotEffects } from '../sfx/SmokyEffects.ts';
import type { SimpleKeyboardWeaponController } from '../tank/Controllers.ts';
import type { Tank, TankWeapon } from '../tank/Tank.ts';

/** WeaponConst.§%_§ — множитель силы удара и отдачи из WeaponCommonCC */
export const WEAPON_FORCE_SCALE = 5000000;

/** AllGlobalGunParams: §"e§ дуло, §+"=§ начало ствола, §2;§ ось X башни, §4"G§ направление */
export class AllGlobalGunParams {
  readonly muzzlePosition = new Vector3(); // §"e§
  readonly barrelOrigin = new Vector3(); // §+"=§
  readonly elevationAxis = new Vector3(); // §2;§
  readonly direction = new Vector3(); // §4"G§
}

const barrelLocal = new Vector3(); // §?G§

export function calculateMainGunParams(tank: Tank, localMuzzle: Vector3, result: AllGlobalGunParams): void {
  const m = tank.getTurretMatrix();
  m.transformVector(localMuzzle, result.muzzlePosition);
  barrelLocal.x = localMuzzle.x;
  barrelLocal.y = 0;
  barrelLocal.z = localMuzzle.z;
  m.transformVector(barrelLocal, result.barrelOrigin);
  result.elevationAxis.x = m.a;
  result.elevationAxis.y = m.e;
  result.elevationAxis.z = m.i;
  result.direction.x = m.b;
  result.direction.y = m.f;
  result.direction.z = m.j;
}

export class WeaponForces {
  constructor(
    private readonly impactForce: number,
    private readonly recoilForce: number,
  ) {}

  getImpactForce(): number {
    return this.impactForce;
  }

  getRecoilForce(): number {
    return this.recoilForce;
  }
}

const gunParams = new AllGlobalGunParams(); // §6!i§

/** CommonTargetingSystem.§>"8§ — дальность луча */
const TARGETING_MAX_DISTANCE = 1000000;

/** фильтр лучей, пропускающий собственный танк (§["D§ в CommonTargetingSystem) */
class ExcludeBodyFilter implements IRayCollisionFilter {
  body: Body | null = null;

  considerBody(body: Body): boolean {
    return body != this.body;
  }
}

/** углы автонаведения Смоки в оригинале: +9° вверх, −12° вниз; сервер присылает их в DiscreteShotModel */
const DEFAULT_AUTO_AIM_UP = (9 * Math.PI) / 180;
const DEFAULT_AUTO_AIM_DOWN = (12 * Math.PI) / 180;
/** CommonTargetEvaluator (DM): дистанция в приоритете нормируется на это значение */
const FULL_DISTANCE = 1e7;

/** Что слушает сеть: куда ушёл выстрел */
export interface WeaponShotListener {
  onFire(): void;
  onFireStatic(hitPoint: Vector3): void;
  /** target — танк-цель; hitLocal — точка попадания в системе цели, hitWorld — в мировой */
  onFireTarget(target: Tank, hitLocal: Vector3, hitWorld: Vector3): void;
}

const aboveGroundVector = new Vector3(); // §]"C§

/** BattleUtils.isTurretAboveGround: между центром тела и началом ствола нет статики */
export function isTurretAboveGround(body: Body, params: AllGlobalGunParams, detector: TanksCollisionDetector): boolean {
  const position = body.state.position;
  aboveGroundVector.diff(params.barrelOrigin, position);
  return !detector.hasStaticHit(position, aboveGroundVector, CollisionGroup.STATIC, 1, null);
}

export class SmokyWeapon implements TankWeapon {
  private enabled = false; // §"!y§
  private reloadTime: number; // §=!'§
  private nextShotTime = 0; // §-L§
  private platform: Tank | null = null; // §&!f§
  private readonly filter = new ExcludeBodyFilter();
  private readonly hit = new RayHit();
  /** эффекты выстрела (Смоки или Гром); null — без эффектов */
  impactListener:((point:Vector3,body:Body|null)=>number)|null=null;
  effects: ShotEffects | null = null; // §=5§
  /** вызывается при выстреле — для отладки */
  onShot: ((params: AllGlobalGunParams) => void) | null = null;
  /** сеть: отправка выстрела на сервер; включает автонаведение */
  shotListener: WeaponShotListener | null = null;
  private readonly targeting: SectorTargeting;
  private readonly targetingResult = new TargetingResult();
  private readonly aimDirection = new Vector3();
  private readonly targetEuler = new Vector3();
  private readonly targetMatrix = new Matrix3();
  private readonly hitLocal = new Vector3();

  constructor(
    reloadTime: number,
    readonly forces: WeaponForces,
    private readonly controller: SimpleKeyboardWeaponController,
    private readonly collisionDetector: TanksCollisionDetector,
  ) {
    this.reloadTime = reloadTime;
    const targeting: SectorTargeting = new SectorTargeting(collisionDetector, {
      maxDistance: TARGETING_MAX_DISTANCE,
      priority: (target, distance, angle) =>
        commonTargetPriority(target, distance, angle, FULL_DISTANCE, Math.max(targeting.autoAimUp, targeting.autoAimDown)),
    });
    targeting.setAutoAimAngles(DEFAULT_AUTO_AIM_UP, DEFAULT_AUTO_AIM_DOWN);
    this.targeting = targeting;
  }

  /** WeaponCommonCC.reload_time: у модификации пушки своя перезарядка */
  setReloadTime(reloadTime: number): void {
    this.reloadTime = Math.max(1, reloadTime);
  }

  /** ShotCC.autoAimingAngleUp / autoAimingAngleDown, радианы */
  setAutoAimAngles(up: number, down: number): void {
    this.targeting.setAutoAimAngles(up, down);
  }

  init(tank: Tank): void {
    this.platform = tank;
    this.reset();
  }

  enable(): void {
    this.enabled = true;
    this.controller.discardStoredAction();
  }

  disable(): void {
    this.enabled = false;
  }

  reset(): void {
    this.nextShotTime = performance.now();
  }

  getStatus(): number {
    const status = 1 - (this.nextShotTime - performance.now()) / this.reloadTime;
    return status > 1 ? 1 : status;
  }

  runLogic(time: number, _delta: number): void {
    if (this.controller.wasActive()) {
      if (this.enabled && time >= this.nextShotTime) this.shoot(time);
      this.controller.discardStoredAction();
    }
  }

  private shoot(time: number): void {
    const tank = this.platform as Tank;
    this.nextShotTime = time + this.reloadTime;
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], gunParams);
    // отдача: сила вдоль ствола назад, приложенная к началу ствола
    tank.getBody().addWorldForceScaled(gunParams.barrelOrigin, gunParams.direction, -this.forces.getRecoilForce());
    this.effects?.createShotEffects(tank.skin.turret.muzzles[0], tank.getTurretMatrix());
    const aboveGround = isTurretAboveGround(tank.getBody(), gunParams, this.collisionDetector);
    const listener = this.shotListener;
    const aimedHit = aboveGround && listener != null ? this.findAimedTank(tank) : null;
    if (aboveGround && (aimedHit != null || this.getTarget(tank, this.hit))) {
      const position = aimedHit != null ? aimedHit.position : this.hit.position;
      const direction = aimedHit != null ? this.aimDirection : gunParams.direction;
      const body = aimedHit != null ? aimedHit.body : (this.hit.shape?.body ?? null);
      if(this.impactListener)position.add(aimedHit?.normal??this.hit.normal);
      this.effects?.createExplosionEffects(position);
      const impact=this.impactListener?.(position,body)??1;
      if (body != null && body.data != null) {
        (body.data as Tank).applyWeaponHit(position, direction, this.forces.getImpactForce()*impact);
      } else {
        this.effects?.createExplosionMark(gunParams.barrelOrigin, position);
      }
      if (listener != null) {
        if (aimedHit != null) {
          const aimed = aimedHit.tank as Tank;
          this.toTargetLocal(aimed, position, this.hitLocal);
          listener.onFireTarget(aimed, this.hitLocal, position);
        } else if (body == null || body.data == null) {
          listener.onFireStatic(position);
        } else {
          listener.onFire();
        }
      }
    } else {
      listener?.onFire();
    }
    this.onShot?.(gunParams);
  }

  private toTargetLocal(target: Tank, world: Vector3, result: Vector3): void {
    const state = target.getBody().state;
    state.orientation.getEulerAngles(this.targetEuler);
    this.targetMatrix.setRotationMatrix(this.targetEuler.x, this.targetEuler.y, this.targetEuler.z);
    result.diff(world, state.position);
    this.targetMatrix.transformVectorInverse(result, result);
  }

  /** наведение по секторам целей (SectorTargeting); попадание в живой танк или null */
  private findAimedTank(tank: Tank): TargetingHit | null {
    this.targeting.target(tank.getBody(), gunParams, this.targetingResult);
    const hit = this.targetingResult.hits[0];
    const target = hit?.tank;
    if (target == null || !(target.health > 0)) return null;
    this.aimDirection.copy(this.targetingResult.direction);
    return hit;
  }

  /** CommonTargetingSystem.getTarget, центральный луч от начала ствола */
  private getTarget(tank: Tank, result: RayHit): boolean {
    this.filter.body = tank.getBody();
    const found = this.collisionDetector.raycast(gunParams.barrelOrigin, gunParams.direction, CollisionGroup.WEAPON, TARGETING_MAX_DISTANCE, this.filter, result);
    this.filter.body = null;
    return found;
  }
}

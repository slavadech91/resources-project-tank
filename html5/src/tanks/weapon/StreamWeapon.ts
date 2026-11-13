import { RayHit } from '../../physics/collision/types.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import { isTurretAboveGround } from './SmokyWeapon.ts';
import type { Body } from '../../physics/Body.ts';
// Потоковые пушки: Огнемёт, Фриз, Изида (StreamWeaponGlobalModel, FlameThrowerModel, FreezeModel, IsisModel).
// Струя держится, пока нажата кнопка: энергия тратится (discharge_rate), после отпускания восстанавливается за
// weapon_reload_time. Клиент шлёт battle.streamStart / streamTick (раз в tickMs, цели в конусе) / streamStop;
// урон, поджиг, заморозку и лечение союзника считает сервер.
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import type { EffectsScene } from '../sfx/SmokyEffects.ts';
import type { ContinuousEffect, StreamEffectFactory, StreamKind } from '../sfx/StreamEffects.ts';
import type { SimpleKeyboardWeaponController } from '../tank/Controllers.ts';
import type { Tank, TankWeapon } from '../tank/Tank.ts';
import { AllGlobalGunParams, WeaponForces, calculateMainGunParams } from './SmokyWeapon.ts';

/** StreamWeaponCC + FlameThrowerCC / FreezeCC / IsisCC от сервера */
export class StreamData {
  constructor(
    public kind: StreamKind = 'firebird',
    /** период тика урона, мс */
    public tickMs = 500,
    /** ёмкость энергии */
    public energyCapacity = 1000,
    /** расход энергии в секунду при стрельбе */
    public dischargeRate = 100,
    /** полное восстановление энергии, мс */
    public rechargeMs = 14000,
    /** угол конуса (радианы) и дальность (м) */
    public coneAngle = 0.7,
    public range = 20,
  ) {}
}

/** цель струи: танк и точка попадания в мировых координатах */
export interface StreamTarget {
  target: Tank;
  point: Vector3;
}

/** Что слушает сеть */
export interface StreamShotListener {
  onStart(): void;
  onTarget?(targets: StreamTarget[], origin?: Vector3): void;
  onTick(targets: StreamTarget[], wall: Vector3 | null, healing: boolean, origin?: Vector3): void;
  onStop(): void;
}

const gunParams = new AllGlobalGunParams();
const toTarget = new Vector3();

export class StreamWeapon implements TankWeapon {
  private enabled = false;
  private platform: Tank | null = null;
  private firing = false;
  private energy = 0;
  private energyAt = 0;
  private lastTickAt = 0;
  private needsRelease = false;
  private flameTicksLeft = 0;
  private effect: ContinuousEffect | null = null;
  private config = new StreamData();
  effectsFactory: StreamEffectFactory | null = null;
  listener: StreamShotListener | null = null;

  constructor(
    readonly forces: WeaponForces,
    private readonly controller: SimpleKeyboardWeaponController,
    private readonly collisionDetector: TanksCollisionDetector,
    private readonly scene: EffectsScene,
    private readonly kind: StreamKind,
  ) {
    this.config.kind = kind;
  }

  configure(config: StreamData): void {
    this.config = config;
    this.config.kind = this.kind;
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
    if (!this.enabled) return;
    this.enabled = false;
    if (this.firing) this.stop();
  }

  reset(): void {
    this.needsRelease=false;
    this.enabled = false;
    if (this.firing) this.stop();
    this.energy = this.config.energyCapacity;
    this.energyAt = performance.now();
    this.controller.discardStoredAction();
  }

  get isFiring(): boolean {
    return this.firing;
  }

  get streamKind(): StreamKind {
    return this.kind;
  }

  getStatus(): number {
    return Math.min(1, Math.max(0, this.energy / Math.max(1, this.config.energyCapacity)));
  }

  runLogic(time: number, _delta: number): void {
    const dt = Math.max(0, time - this.energyAt) / 1000;
    this.energyAt = time;
    if (this.firing) this.energy = Math.max(0, this.energy - this.config.dischargeRate * dt);
    else this.energy = Math.min(this.config.energyCapacity, this.energy + (this.config.energyCapacity / Math.max(0.1, this.config.rechargeMs / 1000)) * dt);

    const pulled = this.controller.isTriggerPulled();
    if (!pulled) this.needsRelease = false;
    if (this.kind !== 'isida' && this.firing && this.energy <= 0) this.needsRelease = true;
    if (this.firing && (!pulled || (this.energy <= 0 && (this.kind === 'isida' || this.flameTicksLeft === 0)) || !this.enabled)) this.stop();
    if (this.enabled && pulled && !this.needsRelease && !this.firing && this.energy > 0) this.start(time);
    this.controller.discardStoredAction();
    if (!this.firing) return;

    const tank = this.platform as Tank;
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], gunParams);
    const { targets, wall, healing } = this.collectTargets(tank);
    const effect = this.effect;
    if (effect) {
      effect.aim(gunParams.muzzlePosition, gunParams.direction, tank);
      effect.setBuffedMode?.(tank.weaponBuffed);
      if (this.kind === 'isida') effect.setTarget(targets[0]?.point ?? wall, healing);
    }
    if (time - this.lastTickAt >= this.config.tickMs && (this.kind === 'isida' || this.flameTicksLeft > 0)) {
      if (this.kind !== 'isida') this.flameTicksLeft--;
      this.lastTickAt = time;
      this.listener?.onTick(targets, wall, healing, gunParams.muzzlePosition);
    }
    if (this.kind !== 'isida' && this.energy <= 0 && this.flameTicksLeft === 0) this.stop();
  }

  private start(time: number): void {
    this.firing = true;
    this.flameTicksLeft = this.config.dischargeRate > 0 ? Math.trunc(this.energy * 1000 / this.config.dischargeRate / this.config.tickMs) : 2147483647;
    this.energyAt = time;
    // StreamWeapon: the first damage tick follows one complete interval.
    this.lastTickAt = this.kind !== 'isida' ? time : time - this.config.tickMs;
    if (this.effectsFactory) {
      this.effect = this.effectsFactory.create(this.scene);
      this.effect.configure?.(this.config.range,this.config.coneAngle);
      this.effect.start();
    }
    this.listener?.onStart();
  }

  private stop(): void {
    if (!this.firing) return;
    this.firing = false;
    this.energyAt = performance.now();
    this.effect?.stop();
    if (this.kind === 'isida') this.effect?.destroy();
    this.effect = null;
    this.listener?.onStop();
  }

  /** цели под струёй: у Изиды — луч по прицелу (враг или союзник), у Огнемёта/Фриза — все в конусе */
  private collectTargets(tank: Tank): { targets: StreamTarget[]; wall: Vector3 | null; healing: boolean } {
    const range = this.config.range * 100;
    const targets: StreamTarget[] = [];
    let wall: Vector3 | null = null;
    let healing = false;
    if (this.kind !== 'isida' && !isTurretAboveGround(tank.getBody(),gunParams,this.collisionDetector)) return {targets,wall,healing};
    const half = Math.max(0.05, this.config.coneAngle * 0.5);
    for (const tankBody of this.collisionDetector.getTankBodies()) {
      const body = tankBody.body;
      if (body === tank.getBody()) continue;
      const target = body.data as Tank | null | undefined;
      if (target == null || typeof target.health != 'number' || !(target.health > 0) || target.friendly) continue;
      toTarget.diff(body.state.position, gunParams.barrelOrigin);
      const length = toTarget.length();
      if (length < 1e-6) continue;
      const radius = target.getBoundSphereRadius();
      if (length - radius > range) continue;
      const angle = Math.acos(Math.min(1, Math.max(-1, toTarget.dot(gunParams.direction) / length)));
      const halfAngle = Math.asin(Math.min(radius, length) / length);
      if (angle > half + halfAngle) continue;
      if (this.kind !== 'isida') {
        const hit=new RayHit(), direction=body.state.position.clone().subtract(gunParams.muzzlePosition).normalize();
        const distance=gunParams.muzzlePosition.clone().subtract(body.state.position).length()+radius;
        if(!this.collisionDetector.raycast(gunParams.muzzlePosition,direction,CollisionGroup.WEAPON,distance,
          {considerBody:(candidate:Body)=>candidate===body||candidate.data==null},hit)||hit.shape?.body!==body) continue;
        targets.push({target,point:hit.position.clone()});
        continue;
      }
      targets.push({ target, point: body.state.position.clone() });
    }
    return { targets, wall, healing };
  }
}

/** RemoteStreamWeapon: чужая струя по событиям battle.stream — частицы из дула, у Изиды луч до цели */
export class RemoteStreamWeapon {
  private effect: ContinuousEffect | null = null;
  private targetPoint: Vector3 | null = null;
  private attachment: (() => Vector3 | null) | null = null;
  private healing = false;
  private targetBody: Body | null = null;
  private buffed = false;
  setBuffedMode(value: boolean): void { this.buffed = value; this.effect?.setBuffedMode?.(value); }
  private readonly params = new AllGlobalGunParams();

  constructor(
    private readonly factory: StreamEffectFactory,
    private readonly scene: EffectsScene,
    private readonly range = 20, private readonly cone = 0.7,
  ) {}

  get isActive(): boolean {
    return this.effect != null;
  }

  start(tank: Tank): void {
    if (this.effect) return;
    this.effect = this.factory.create(this.scene);
    this.effect.configure?.(this.range,this.cone);
    this.effect.start();
    this.effect.setBuffedMode?.(this.buffed);
    this.aim(tank);
  }

  /** каждый кадр: струя из дула по текущему повороту башни чужого танка */
  aim(tank: Tank): void {
    const effect = this.effect;
    if (!effect) return;
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], this.params);
    effect.aim(this.params.muzzlePosition, this.params.direction, tank);
    effect.setTarget(this.attachment ? this.attachment() : this.targetPoint, this.healing, this.targetBody);
  }

  /** цель луча Изиды (мир); null — никого под лучом */
  setTarget(point: Vector3 | null, healing: boolean, attachment: (() => Vector3 | null) | null = null, body: Body | null = null): void {
    this.targetBody = body;
    this.attachment = attachment;
    this.targetPoint = point ? point.clone() : null;
    this.healing = healing;
    this.effect?.setTarget(this.targetPoint, healing, this.targetBody);
  }

  stop(): void {
    this.effect?.stop();
    this.effect = null;
    this.targetPoint = null;
    this.attachment = null;
  }
}

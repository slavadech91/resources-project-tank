import type { ShaftAimSounds } from '../sfx/ShaftAimSounds.ts';
import { Matrix3 } from '../../physics/math/Matrix3.ts';
// Шафт: models/weapon/shaft/ShaftWeapon.as, ShaftModel.as, ShaftTargetingSystem.
// Короткое нажатие — аркадный выстрел 20–28. Удержание при полной энергии — прицельный режим: танк «заряжается»
// (энергия тратится, урон растёт), на отпускании — прямой луч до первой цели, без автонаведения.
// Аркада использует автонаведение; оптика стреляет строго по направлению камеры. Урон считает server2.
import type { Body } from '../../physics/Body.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import { getDistantPoint } from '../sfx/RailgunEffects.ts';
import type { ShaftEffects } from '../sfx/ShaftEffects.ts';
import type { SimpleKeyboardWeaponController } from '../tank/Controllers.ts';
import type { Tank, TankWeapon } from '../tank/Tank.ts';
import { SectorTargeting, TargetingResult, commonTargetPriority } from './SectorTargeting.ts';
import { AllGlobalGunParams, WeaponForces, calculateMainGunParams, isTurretAboveGround } from './SmokyWeapon.ts';

const MAX_RAY_LENGTH = 10000000000;
const FULL_DISTANCE = 20000;
/** RailgunTargetingSystem: доля общего приоритета рядом с эффективностью попадания */
const COMMON_PRIORITY_WEIGHT = 0.000001;
/** короче — аркадный выстрел, дольше — вход в оптику (как «клик / удержание» в TO) */
const SCOPE_HOLD_MS = 200;

/** DMRailgunTargetEvaluator: живой танк — 1, мёртвый — 0; при равенстве — ближе к прицелу */
function shaftPriority(tank: Tank, distance: number, angle: number, maxAngle: number): number {
  const efficiency = tank.health > 0 ? 1 : 0;
  return efficiency + commonTargetPriority(tank, distance, angle, FULL_DISTANCE, maxAngle) * COMMON_PRIORITY_WEIGHT;
}

/** ShaftCC + ShaftShotCC + WeaponCommonCC от сервера */
export class ShaftData {
  constructor(
    /** полная энергия, единицы */
    public maxEnergy = 1000,
    /** набор энергии в секунду = maxEnergy / время перезарядки */
    public chargeRate = 296,
    /** расход при прицеливании, единиц в секунду (урон растёт с потраченной энергией) */
    public dischargeRate = 277,
    /** сколько энергии нужно на аркадный выстрел */
    public fastShotEnergy = 300,
    /** пауза после прицельного выстрела, мс */
    public afterShotPauseMs = 500,
    /** урон каждой следующей пробитой цели */
    public weakeningCoeff = 0.24,
    public targetingTransitionMs = 500,
    public initialFov = 0.6981,
    public minimumFov = 0.4014,
    public verticalSpeed = 0.2,
    public horizontalSpeed = 0.2,
    public targetingAcceleration = 0.47,
    public elevationUp = Math.PI/6,
    public elevationDown = Math.PI/6,
  ) {}
}

/** Что слушает сеть */
export interface ShaftShotListener {
  /** вход в прицельный режим и выход из него */
  onAim(active: boolean): void;
  /** aimed — прицельный; targets/hitPoints — пробитые танки по порядку и точки попадания в мире */
  onShot(aimed: boolean, staticHitPoint: Vector3 | null, targets: Tank[], hitPoints: Vector3[]): void;
}

const gunParams = new AllGlobalGunParams();

export class ShaftWeapon implements TankWeapon {
  private enabled = false;
  private platform: Tank | null = null;
  private nextShotTime = 0;
  /** энергия и время её последнего пересчёта (performance.now) */
  private energy = 0;
  private energyAt = 0;
  private aiming = false;
  private aimExitAt = 0;
  private readonly shotView=new AllGlobalGunParams();
  private elevation = 0;
  private elevationTarget = 0;
  private directionTarget = 0;
  setAimWorldDirection:((angle:number)=>void)|null=null;
  private elevationSpeed = 0;
  elevationInput = 0;
  onScope: ((active:boolean)=>void) | null = null;
  private aimStartedAt = 0;
  /** время нажатия, ещё не решено: короткое — аркада, долгое — оптика; −1 — решения нет */
  private scopePressAt = -1;
  private chargeSoundPlayed = false;
  private aimSounds:ShaftAimSounds|null=null;
  aimSoundVolume:()=>number=()=>1;
  private reloadTime: number;
  private config = new ShaftData();
  effects: ShaftEffects | null = null;
  listener: ShaftShotListener | null = null;
  private readonly aimedTargeting: SectorTargeting;
  private readonly arcadeTargeting: SectorTargeting;
  private readonly aimedResult = new TargetingResult();
  private readonly arcadeResult = new TargetingResult();

  constructor(
    reloadTime: number,
    readonly forces: WeaponForces,
    private readonly controller: SimpleKeyboardWeaponController,
    private readonly collisionDetector: TanksCollisionDetector,
    autoAimUp: number,
    autoAimDown: number,
  ) {
    this.reloadTime = reloadTime;
    const aimed: SectorTargeting = new SectorTargeting(collisionDetector, {
      maxDistance: MAX_RAY_LENGTH,
      penetrating: false,
      weakeningCoeff: this.config.weakeningCoeff,
      priority: (tank, distance, angle) => shaftPriority(tank, distance, angle, Math.max(aimed.autoAimUp, aimed.autoAimDown)),
    });
    aimed.setAutoAimAngles(0, 0);
    this.aimedTargeting = aimed;
    const arcade: SectorTargeting = new SectorTargeting(collisionDetector, {
      maxDistance: MAX_RAY_LENGTH,
      priority: (tank, distance, angle) => shaftPriority(tank, distance, angle, Math.max(arcade.autoAimUp, arcade.autoAimDown)),
    });
    arcade.setAutoAimAngles(autoAimUp, autoAimDown);
    this.arcadeTargeting = arcade;
  }

  /** ShaftCC: энергия, расход и пауза от сервера; перезарядка — из TurretSpec */
  configure(config: ShaftData): void {
    this.config = config;
    this.aimedTargeting.options.weakeningCoeff = config.weakeningCoeff;
    if (!this.aiming) this.energy = Math.min(this.energy, config.maxEnergy);
  }

  /** WeaponCommonCC.reload_time: у модификации пушки своя перезарядка */
  setReloadTime(reloadTime: number): void {
    this.reloadTime = Math.max(1, reloadTime);
  }

  setAutoAimAngles(up: number, down: number): void {
    this.aimedTargeting.setAutoAimAngles(0, 0);
    this.arcadeTargeting.setAutoAimAngles(up, down);
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
    this.scopePressAt = -1;
    if (this.aiming) this.cancelAim();
  }

  reset(): void {
    this.enabled = false;
    this.scopePressAt = -1;
    if (this.aiming) this.cancelAim();
    this.nextShotTime = 0;
    this.energy = this.config.maxEnergy;
    this.energyAt = performance.now();
    this.chargeSoundPlayed = false;
    this.controller.discardStoredAction();
  }

  /** идёт прицеливание (камера в оптике) */
  get isAiming(): boolean {
    return this.aiming;
  }

  /** 0 — обычный обзор, 1 — полная оптика */
  getAimZoom(now = performance.now()): number {
    if (!this.aiming) return 0;
    return Math.min(1, Math.max(0, (now - this.aimStartedAt) / this.config.targetingTransitionMs));
  }

  getStatus(): number {
    return Math.min(1,Math.max(0,this.energyNow(performance.now())/this.config.maxEnergy));
  }

  get aimCharge():number {return Math.min(1,Math.max(0,(this.config.maxEnergy-this.energyNow(performance.now()))/this.config.maxEnergy));}
  get scopeFov():number{
    // Visual calibration requested by the user: twice the final optical magnification.
    const finalFov=2*Math.atan(Math.tan(this.config.minimumFov/2)/2);
    return this.config.initialFov+(finalFov-this.config.initialFov)*this.aimCharge;
  }
  get scopeTurnSpeed():number{return this.config.horizontalSpeed;}
  get scopeReady():boolean{return this.aiming && this.getAimZoom()>=1 && this.aimExitAt===0;}
  /** Mouse target moves immediately; the physical mount/elevation follows with its own limits. */
  aimMouse(dx:number,dy:number,sensitivity:number,inverse:boolean,radiansPerPixel:number):void{
    if(!this.scopeReady)return;
    const gain=radiansPerPixel*sensitivity/8;
    const actual=this.currentWorldDirection();
    const delta=this.directionTarget-actual-dx*gain;
    const wrapped=Math.atan2(Math.sin(delta),Math.cos(delta));
    const limit=Math.PI/12; // ShaftWeapon.MAX_DIRECTION_DELTA = 15 degrees.
    this.directionTarget=actual+Math.max(-limit,Math.min(limit,wrapped));
    this.elevationTarget=Math.max(-this.config.elevationDown,Math.min(this.config.elevationUp,
      Math.max(this.elevation-limit,Math.min(this.elevation+limit,this.elevationTarget-dy*gain*(inverse?-1:1)))));
    this.setAimWorldDirection?.(this.directionTarget);
  }
  private currentWorldDirection():number{
    const tank=this.platform as Tank,params=new AllGlobalGunParams();
    calculateMainGunParams(tank,tank.skin.turret.muzzles[0],params);
    return Math.atan2(-params.direction.x,params.direction.y);
  }
  getScopeTargetDirection():Vector3{
    const tank=this.platform as Tank,params=new AllGlobalGunParams();
    calculateMainGunParams(tank,tank.skin.turret.muzzles[0],params);
    const yaw=new Matrix3();yaw.fromAxisAngle(new Vector3(0,0,1),this.directionTarget-this.currentWorldDirection());
    yaw.transformVector(params.direction.clone(),params.direction);
    yaw.transformVector(params.elevationAxis.clone(),params.elevationAxis);
    const pitch=new Matrix3();pitch.fromAxisAngle(params.elevationAxis,this.elevationTarget);
    const direction=new Vector3();pitch.transformVector(params.direction,direction);return direction;
  }
  get isPostShotPause():boolean{return this.aiming&&this.aimExitAt>0;}
  /** Presentation-only view: retain the shot's world view while the real tank recoils. */
  getScopeCameraParams(result:AllGlobalGunParams):void{
    if(this.isPostShotPause){
      result.barrelOrigin.copy(this.shotView.barrelOrigin);result.direction.copy(this.shotView.direction);result.elevationAxis.copy(this.shotView.elevationAxis);return;
    }
    this.getScopeParams(result);result.direction.copy(this.getScopeTargetDirection());
  }
  getScopeParams(result:AllGlobalGunParams):void{
    const tank=this.platform as Tank;
    calculateMainGunParams(tank,tank.skin.turret.muzzles[0],result);
    const rotation=new Matrix3();rotation.fromAxisAngle(result.elevationAxis,this.elevation);rotation.transformVector(result.direction.clone(),result.direction);
  }

  runLogic(time: number, delta: number): void {
    if(!this.enabled)return;
    this.energyNow(time);
    if(this.aiming && this.aimExitAt>0){if(time>=this.aimExitAt)this.endScope();return;}
    // нажатие ещё не разрешено: отпустили быстро — аркада, держим — оптика
    if (!this.aiming && this.scopePressAt >= 0) {
      if (!this.controller.isTriggerPulled()) {
        this.controller.discardStoredAction();
        this.scopePressAt = -1;
        this.shootArcade(time);
        return;
      }
      this.controller.discardStoredAction();
      if (time - this.scopePressAt >= SCOPE_HOLD_MS && this.energy >= this.config.maxEnergy) {
        this.scopePressAt = -1;
        this.startAim(time);
      }
      return;
    }
    if (this.aiming) {
      // прицел держится, пока нажата кнопка; отпускание — выстрел
      if (!this.controller.isTriggerPulled()) {
        this.controller.discardStoredAction();
        if(time-this.aimStartedAt<this.config.targetingTransitionMs){
          this.energy=this.config.maxEnergy;this.endScope();this.listener?.onAim(false);this.shootArcade(time);
        }else this.shootAimed(time);
        return;
      }
      this.controller.discardStoredAction();
      if(time-this.aimStartedAt>=this.config.targetingTransitionMs){
        const dt=delta/1000;
        if(this.elevationInput)this.elevationTarget=Math.max(-this.config.elevationDown,Math.min(this.config.elevationUp,this.elevationTarget+this.elevationInput*this.config.verticalSpeed*dt));
        const diff=this.elevationTarget-this.elevation;
        if(diff===0 || Math.sign(diff)!==Math.sign(this.elevationSpeed))this.elevationSpeed=0;
        this.elevationSpeed=Math.sign(diff)*Math.min(this.config.verticalSpeed,Math.abs(this.elevationSpeed)+this.config.targetingAcceleration*dt);
        this.elevation+=Math.sign(diff)*Math.min(Math.abs(diff),Math.abs(this.elevationSpeed)*dt);
      }
      this.aimSounds?.setMoving(Math.abs(this.elevationTarget-this.elevation)>1e-6 || (this.platform?.getTurretController()?.isRotating()??false));
      if (!this.chargeSoundPlayed) {
        const fullChargeMs = (this.config.maxEnergy / Math.max(1, this.config.dischargeRate)) * 1000;
        if (time - this.aimStartedAt >= fullChargeMs) {
          this.chargeSoundPlayed = true;
          this.aimSounds?.stopCharging();
        }
      }
      return;
    }
    if (this.enabled && this.controller.wasActive()) {
      this.controller.discardStoredAction();
      if (time < this.nextShotTime) return;
      const energy = this.energyNow(time);
      if (energy >= this.config.maxEnergy) this.scopePressAt = time;
      else if (energy >= this.config.fastShotEnergy) this.scopePressAt = time;
      return;
    }
    this.controller.discardStoredAction();
    this.energyNow(time);
  }

  /** ShaftWeaponGlobalModel.energy: набор только вне прицела */
  private energyNow(time: number): number {
    const dt = Math.max(0, time - this.energyAt) / 1000;
    this.energy = Math.max(0,Math.min(this.config.maxEnergy, this.energy + (this.aiming && this.aimExitAt===0 ? -this.config.dischargeRate : this.config.chargeRate) * dt));
    this.energyAt = time;
    return this.energy;
  }

  private muzzlePoint(): Vector3 {
    const tank = this.platform as Tank;
    const point = new Vector3();
    tank.getTurretMatrix().transformVector(tank.skin.turret.muzzles[0], point);
    return point;
  }

  private startAim(time: number): void {
    this.aiming = true;
    this.aimStartedAt = time;
    this.chargeSoundPlayed = false;
    this.energy = this.config.maxEnergy;
    this.energyAt = time;
    this.elevation=0;this.elevationTarget=0;this.directionTarget=this.currentWorldDirection();this.elevationSpeed=0;this.aimExitAt=0;
    this.onScope?.(true);
    this.aimSounds?.stop();
    this.aimSounds=this.effects?.startAimSounds(()=>this.muzzlePoint(),this.aimSoundVolume,()=>this.enabled&&this.aiming&&this.aimExitAt===0&&this.controller.isTriggerPulled())??null;
    this.listener?.onAim(true);
  }

  private endScope():void{this.aimSounds?.stop();this.aimSounds=null;this.aiming=false;this.aimExitAt=0;this.onScope?.(false);}

  private cancelAim(): void {
    this.endScope();
    this.energyAt = performance.now();
    this.listener?.onAim(false);
  }

  private shootAimed(time: number): void {
    this.aimSounds?.stop();this.aimSounds=null;
    const tank = this.platform as Tank;
    this.scopePressAt = -1;
    this.getScopeCameraParams(this.shotView);
    this.aimExitAt=time+this.config.afterShotPauseMs;
    this.energyAt = time;
    this.nextShotTime = time + this.reloadTime;
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], gunParams);
    tank.getBody().addWorldForceScaled(gunParams.barrelOrigin, gunParams.direction, -this.forces.getRecoilForce());
    const aboveGround = isTurretAboveGround(tank.getBody(), gunParams, this.collisionDetector);
    if (!aboveGround) {
      this.listener?.onShot(true, null, [], []);
      return;
    }
    this.getScopeParams(gunParams);
    this.aimedTargeting.target(tank.getBody(), gunParams, this.aimedResult);
    const result = this.aimedResult;
    const targets = result.hits.map((hit) => hit.body as Body);
    const hitPoints = result.hits.map((hit) => hit.position.clone());
    let weakening = 1;
    for (let i = 0; i < targets.length; i++) {
      (targets[i].data as Tank).applyWeaponHit(hitPoints[i], result.direction, this.forces.getImpactForce() * weakening);
      weakening *= this.config.weakeningCoeff;
    }
    const staticPoint = result.staticHit?.position.clone() ?? null;
    let end = staticPoint;
    if (end == null && hitPoints.length > 0) end = hitPoints[hitPoints.length - 1];
    const effects = this.effects;
    if (effects) {
      effects.createShotEffects(tank.skin.turret.muzzles[0], tank.getTurretMatrix());
      effects.createShotTrail(gunParams.muzzlePosition, end ?? getDistantPoint(gunParams.barrelOrigin,result.direction));
      if (end != null) effects.createExplosionEffects(end);
      if (staticPoint != null) effects.createExplosionMark(gunParams.barrelOrigin, staticPoint);
    }
    this.listener?.onShot(true, staticPoint, targets.map((body) => body.data as Tank), hitPoints);
  }

  private shootArcade(time: number): void {
    const tank = this.platform as Tank;
    this.scopePressAt = -1;
    this.energy = Math.max(0, this.energy - this.config.fastShotEnergy);
    this.energyAt = time;
    this.nextShotTime = time + this.reloadTime;
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], gunParams);
    tank.getBody().addWorldForceScaled(gunParams.barrelOrigin, gunParams.direction, -this.forces.getRecoilForce());
    const aboveGround = isTurretAboveGround(tank.getBody(), gunParams, this.collisionDetector);
    if (!aboveGround) {
      this.listener?.onShot(false, null, [], []);
      return;
    }
    this.arcadeTargeting.target(tank.getBody(), gunParams, this.arcadeResult);
    const result = this.arcadeResult;
    const target = result.hits[0];
    const aimDirection = new Vector3().copy(result.direction);
    let end = result.staticHit?.position.clone() ?? null;
    const targets: Tank[] = [];
    const hitPoints: Vector3[] = [];
    if (target) {
      const aim = target.body as Body;
      const aimTank = aim.data as Tank;
      aimTank.applyWeaponHit(target.position, aimDirection, this.forces.getImpactForce());
      targets.push(aimTank);
      hitPoints.push(target.position.clone());
      end = target.position.clone();
    }
    const effects = this.effects;
    if (effects) {
      effects.createShotEffects(tank.skin.turret.muzzles[0], tank.getTurretMatrix());
      effects.createShotTrail(gunParams.muzzlePosition, end ?? getDistantPoint(gunParams.barrelOrigin, aimDirection));
      if (end != null) effects.createExplosionEffects(end);
      if (!target && result.staticHit != null) effects.createExplosionMark(gunParams.barrelOrigin, result.staticHit.position);
    }
    this.listener?.onShot(false, target ? null : (result.staticHit?.position.clone() ?? null), targets, hitPoints);
  }
}

/** RemoteShaftWeapon: чужой Шафт по событиям battle.shaftAim / battle.shaft */
export class RemoteShaftWeapon {
  private aimSounds:ShaftAimSounds|null=null;
  private readonly params = new AllGlobalGunParams();

  constructor(
    private readonly recoilForce: number,
    private readonly impactForce: number,
    private readonly weakeningCoeff: number,
    readonly effects: ShaftEffects,
  ) {}

  stopAim():void{this.aimSounds?.stop();this.aimSounds=null;}
  aim(tank:Tank,active:boolean):void{
    this.stopAim();
    if(!active)return;
    this.aimSounds=this.effects.startAimSounds(()=>{
      calculateMainGunParams(tank,tank.skin.turret.muzzles[0],this.params);
      return this.params.muzzlePosition;
    },()=>1,()=>tank.health>0);
  }

  /** hitPoints — уже мировые точки попадания пробитых целей */
  fire(tank: Tank, staticHit: Vector3 | null, targets: (Body | null)[], hitPoints: Vector3[]): void {
    this.stopAim();
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], this.params);
    tank.getBody().addWorldForceScaled(this.params.muzzlePosition, this.params.direction, -this.recoilForce);
    this.effects.createShotEffects(tank.skin.turret.muzzles[0], tank.getTurretMatrix());
    let end = staticHit;
    if (end == null && hitPoints.length > 0) end = hitPoints[hitPoints.length - 1];
    this.effects.createShotTrail(this.params.muzzlePosition, end ?? getDistantPoint(this.params.barrelOrigin,this.params.direction));
    if (end != null) this.effects.createExplosionEffects(end);
    if (staticHit != null) this.effects.createExplosionMark(this.params.barrelOrigin, staticHit);
    let weakening = 1;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]?.data as Tank | null | undefined;
      if (target != null && hitPoints[i]) target.applyWeaponHit(hitPoints[i], this.params.direction, this.impactForce * weakening);
      weakening *= this.weakeningCoeff;
    }
  }
}

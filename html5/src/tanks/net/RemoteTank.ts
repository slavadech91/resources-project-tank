// Remote tanks use the same dynamic Body, chassis and contact solver as the local tank.
// Snapshots reconcile outside tank contacts; contact impulses survive the physics step.
import type * as THREE from 'three';
import { Quaternion } from '../../physics/math/Quaternion.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { BattleRunner, PhysicsController, PostPhysicsController } from '../BattleRunner.ts';
import type { TankSkin } from '../render/TankSkin.ts';
import { ChassisController, TankControlLockBits, TurretController } from '../tank/Controllers.ts';
import { Tank } from '../tank/Tank.ts';
import type { ShotEffects } from '../sfx/SmokyEffects.ts';
import { TankSounds, type AudioEngine, type SoundListener } from '../sfx/Sound.ts';
import type { TankExplosionEffects } from '../sfx/TankExplosionEffects.ts';
import type { UserTitle } from '../display/UserTitle.ts';
import { AllGlobalGunParams, calculateMainGunParams } from '../weapon/SmokyWeapon.ts';
import { ServerTankState } from './DesyncDebug.ts';
import { InterpolatedState, type StateBuffer } from './sync/StateBuffer.ts';
import { RemoteBodyReconciler } from './sync/RemoteBodyReconciler.ts';
import type { SyncSample } from './sync/SyncProtocol.ts';

/** TankModel.updateTitleVisibility: ник противника скрывается дальше 7050 и показывается ближе 7000 */
const TITLE_SHOW_DISTANCE = 7000; // §6![§
const TITLE_HIDE_DISTANCE = 7050; // §#o§
const TITLE_VISIBILITY_INTERVAL_MS = 83;
const REMOTE_TITLE_HEIGHT = 200; // TankModel §%"J§
/** ReadyToSpawnTask: труп растворяется за последние 500 мс */
const CORPSE_FADE_TIME = 500;
const ENGINE_FADE_START = 5000;
const ENGINE_SOUND_RANGE = 7000;
/** башню чужого танка вращает не управление, а буфер снапшотов */
const SYNC_TURRET_LOCK = 1 << 8;

/** BattleUtils.toClientScale */
function toClientScale(value: number): number {
  return value * 100;
}

const tmpEuler = new Vector3();

export class RemoteTank implements PhysicsController, PostPhysicsController {
  serverDrivenBot=false;
  readonly tank: Tank;
  readonly skin: TankSkin;
  readonly userId: number;
  private readonly chassisController: ChassisController;
  private readonly turretController: TurretController;
  private readonly world: THREE.Object3D;
  private readonly runner: BattleRunner;
  private visible = false;
  private inBattle = false;
  private dead = false;
  private disposed = false;
  private sounds: TankSounds | null = null;
  private lastSoundUpdate = performance.now();
  private nextTitleVisibilityCheck = 0;
  private deathDeadline = 0;
  incarnation = 0;
  private readonly gunParams = new AllGlobalGunParams();
  /** ник со званием над танком (TankModel.configureTankTitleAsRemote) */
  title: UserTitle | null = null;
  /** отладка рассинхрона (F7): последний сэмпл, поправки */
  readonly desync = new ServerTankState();

  // ---- синхронизация v2
  private networkDriven = false;
  /** поза, пока в буфере нет сэмплов этой жизни (точка спавна) */
  private readonly hold = new InterpolatedState();
  private readonly raw = new InterpolatedState();
  /** Network correction is suspended during physical tank contacts. */
  private readonly reconciliation = new RemoteBodyReconciler();
  /** Первая сетевая поза уже установлена. */
  private hasOutput = false;
  private lastChassis = -1;
  private lastTurretControl = -1;
  /** сколько мс за последним сэмплом */
  extrapolatedMs = 0;

  get health(): number {
    return this.tank.health;
  }

  set health(value: number) {
    this.tank.health = value;
  }

  constructor(
    userId: number,
    skin: TankSkin,
    world: THREE.Object3D,
    runner: BattleRunner,
    private readonly buffer: StateBuffer,
    /** серверное время отрисовки для локального времени физики (performance.now) */
    private readonly renderTime: (physicsTime: number) => number,
    soundEngine?: AudioEngine,
  ) {
    this.userId = userId;
    this.skin = skin;
    this.world = world;
    this.runner = runner;
    const hull = skin.hull.spec;
    const turret = skin.turret.spec;
    this.turretController = new TurretController(turret.turretRotationSpeed, turret.turretRotationAcceleration, false);
    this.turretController.lock(SYNC_TURRET_LOCK);
    this.tank = new Tank(hull.mass, hull.damping, skin, this.turretController, { init: () => undefined, reset: () => undefined });
    this.chassisController = new ChassisController(this.tank);
    // TankModel.setTankSpec: the same chassis parameters for live remote bodies and corpses.
    this.tank.setReverseAcceleration(toClientScale(hull.reverseAcceleration));
    this.tank.setSideAcceleration(toClientScale(hull.sideAcceleration));
    this.tank.setTurnAcceleration(hull.turnAcceleration);
    this.tank.setReverseTurnAcceleration(hull.reverseTurnAcceleration);
    this.tank.setMaxSpeed(toClientScale(hull.speed), true);
    this.tank.setMaxTurnSpeed(hull.turnSpeed, true);
    this.tank.setAcceleration(toClientScale(hull.acceleration));
    this.turretController.setMaxTurnSpeed(turret.turretRotationSpeed, true);
    skin.addToScene(world);
    this.setMeshesVisible(false);
    if (soundEngine) void TankSounds.load(soundEngine).then((sounds) => {
      if (!this.disposed) this.sounds = sounds;
    });
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** танк на поле и жив (его ведут снапшоты) */
  get isActive(): boolean {
    return this.inBattle && !this.dead;
  }

  get isDead(): boolean {
    return this.dead;
  }

  private setMeshesVisible(visible: boolean): void {
    this.visible = visible;
    this.skin.hull.mesh.visible = visible;
    this.skin.turret.mesh.visible = visible;
  }

  /** Tank.addToBattle / removeFromBattle; reconcile before the dynamic physics step. */
  private setInBattle(value: boolean): void {
    if (value == this.inBattle) return;
    this.inBattle = value;
    if (value) {
      this.runner.addBodyWrapper(this.tank.tankBody);
      this.runner.addPhysicsController(this);
      this.runner.addPostPhysicsController(this);
      this.runner.addPhysicsInterpolator(this.tank);
    } else {
      this.runner.removeBodyWrapper(this.tank.tankBody);
      this.runner.removePhysicsController(this);
      this.runner.removePostPhysicsController(this);
      this.runner.removePhysicsInterpolator(this.tank);
    }
  }

  private setNetworkDriven(value: boolean): void {
    const body = this.tank.getBody();
    this.networkDriven = value;
    body.kinematic = false;
    body.movable = true;
    body.frozen = false;
    body.freezeCounter = 0;
  }

  /**
   * TankModel.spawn: появляется на месте (spawn — точка из SPAWN, до первых сэмплов новой жизни стоит там),
   * до ACTIVATE_TANK «полуактивен»
   */
  spawn(position: Vector3, orientation: Quaternion, turretAngle: number, activated: boolean): void {
    this.setInBattle(true);
    this.setNetworkDriven(true);
    this.dead = false;
    this.nextTitleVisibilityCheck = performance.now() + ((this.userId >>> 0) * 29) % TITLE_VISIBILITY_INTERVAL_MS;
    this.deathDeadline = 0;
    this.hasOutput = false;
    this.lastChassis = this.lastTurretControl = -1;
    this.tank.skin.setNormalState();
    this.tank.spawn();
    this.chassisController.unlock(TankControlLockBits.DEAD | TankControlLockBits.BATTLE_FINISH);
    const hold = this.hold;
    hold.position.copy(position);
    hold.orientation.copy(orientation).normalize();
    hold.velocity.reset();
    hold.angularVelocity.reset();
    hold.turretAngle = turretAngle;
    hold.chassis = 0;
    hold.turretControl = 0;
    hold.orientation.getEulerAngles(tmpEuler);
    this.tank.setPhysicsState(position, tmpEuler, hold.velocity, hold.angularVelocity);
    this.turretController.setDirectionImmediate(turretAngle);
    this.turretController.applyControlState(0);
    this.chassisController.setControlState(0);
    if (activated) this.activate();
    else this.tank.setSemiActivatedState();
    // поза сразу (до первого шага физики): из буфера, если сэмплы уже есть
    this.applyPose(this.runner.getPhysicsScene().time,0,true);
    this.tank.interpolatePhysicsState(1);
    this.tank.render();
    this.setMeshesVisible(true);
  }

  /** SPAWN по событию: точка спавна, углы Эйлера */
  spawnAt(position: Vector3, euler: Vector3, turretAngle: number, activated: boolean): void {
    const orientation = new Quaternion();
    orientation.setFromEulerAnglesXYZ(euler.x, euler.y, euler.z);
    this.spawn(position, orientation, turretAngle, activated);
  }

  /** танк есть в снапшоте, а у нас его нет на поле (пропущен SPAWN, вход в бой) — появляется там, где он есть */
  spawnFromSample(sample: SyncSample, activated: boolean): void {
    this.spawn(new Vector3(sample.px, sample.py, sample.pz), new Quaternion(sample.qw, sample.qx, sample.qy, sample.qz), sample.turretAngle, activated);
  }

  activate(): void {
    this.tank.setActivatedState();
  }

  /** KILL: труп — обычное тело физики с «мёртвой» краской и взрывом, пока не придёт новый SPAWN (TankModel.kill) */
  kill(effects: TankExplosionEffects | null, respawnDelay: number): void {
    if (!this.inBattle || this.dead) return;
    this.dead = true;
    if (this.sounds) this.sounds.enabled = false;
    // труп продолжает с той позы и скорости, что показаны сейчас
    this.setNetworkDriven(false);
    // ReadyToSpawnTask: труп стоит respawnDelay мс, последние 500 мс растворяется, затем уходит из боя
    this.deathDeadline = performance.now() + respawnDelay;
    this.chassisController.setControlState(0);
    this.turretController.applyControlState(0);
    this.chassisController.lock(TankControlLockBits.DEAD);
    this.tank.kill();
    this.title?.hide();
    this.tank.applyDeathKick();
    if (effects) {
      this.tank.skin.setDeadState(effects.deadColoring);
      effects.create(this.tank);
    }
  }

  /** TankModel.disableAllTanks (конец раунда): значки над ним прячутся (стоит он по снапшотам — владелец заблокирован) */
  freeze(): void {
    this.chassisController.setControlState(0);
    this.turretController.applyControlState(0);
    this.chassisController.lock(TankControlLockBits.BATTLE_FINISH);
    this.title?.hideIndicators();
  }

  /** Танк вышел из боя: пропадает */
  remove(): void {
    if (this.sounds) this.sounds.enabled = false;
    this.title?.hideImmediate();
    this.setMeshesVisible(false);
    this.chassisController.setControlState(0);
    this.chassisController.lock(TankControlLockBits.DEAD);
    this.setInBattle(false);
    this.hasOutput = false;
  }

  /**
   * SET_SPECIFICATION: нитро и заморозка меняют скорость чужого танка (TankModel.setSpecification для всех танков).
   * Живой танк и труп используют эти характеристики в общей физике; снапшоты корректируют свободное движение.
   */
  setSpecification(speed: number, turnSpeed: number, turretRotationSpeed: number, acceleration: number): void {
    this.tank.setMaxSpeed(toClientScale(speed), false);
    this.tank.setMaxTurnSpeed(turnSpeed, false);
    this.tank.setAcceleration(toClientScale(acceleration));
    this.turretController.setMaxTurnSpeed(turretRotationSpeed, false);
  }

  /** нитро чужого танка: характеристики × factor (TankSpecification.set_tank_speed_with_factor), 1 — возврат */
  setSpeedFactor(factor: number): void {
    const hull = this.skin.hull.spec;
    const turret = this.skin.turret.spec;
    this.tank.setMaxSpeed(toClientScale(hull.speed * factor), false);
    this.tank.setMaxTurnSpeed(hull.turnSpeed * factor, false);
    this.tank.setAcceleration(toClientScale(hull.acceleration * factor));
    this.turretController.setMaxTurnSpeed(turret.turretRotationSpeed * factor, false);
  }

  // ------------------------------------------------------------ шаг физики

  runBeforePhysicsUpdate(dt:number):void{
    if(this.networkDriven)this.applyPose(this.runner.getPhysicsScene().time,dt);
    this.tank.runBeforePhysicsUpdate(dt);
  }

  runAfterPhysicsUpdate(dt:number):void{
    this.tank.runAfterPhysicsUpdate(dt);
    // Do not reapply snapshots here: their old pose/velocity would erase the collision impulse.
  }

  private applyPose(physicsTime:number,dt:number,initialize=false):void{
    const raw=this.raw;
    if(!this.buffer.sample(this.renderTime(physicsTime),raw)){
      this.copyState(this.hold,raw);raw.extrapolatedMs=0;
    }
    this.extrapolatedMs=raw.extrapolatedMs;
    const body=this.tank.getBody();
    this.reconciliation.reconcile(body,raw,dt,this.tank.tankBody.hasTankContacts,initialize||!this.hasOutput,this.serverDrivenBot);
    // Server AI slows down at turns/waypoints. Replaying its control bits at full garage
    // speed otherwise drives the predicted body away while contact reconciliation is paused.
    if(this.serverDrivenBot){
      const speed=Math.hypot(raw.velocity.x,raw.velocity.y);
      this.tank.setMaxSpeed(speed,true);
    }
    this.turretController.setDirectionImmediate(raw.turretAngle);
    if(raw.chassis!==this.lastChassis){this.lastChassis=raw.chassis;this.chassisController.setControlState(raw.chassis);}
    if(raw.turretControl!==this.lastTurretControl){this.lastTurretControl=raw.turretControl;this.turretController.applyControlState(raw.turretControl);}
    body.frozen=false;body.freezeCounter=0;body.calcDerivedData();
    this.hasOutput=true;
  }

  private copyState(from: InterpolatedState, to: InterpolatedState): void {
    to.position.copy(from.position);
    to.orientation.copy(from.orientation);
    to.velocity.copy(from.velocity);
    to.angularVelocity.copy(from.angularVelocity);
    to.turretAngle = from.turretAngle;
    to.chassis = from.chassis;
    to.turretControl = from.turretControl;
  }

  /** величина текущей поправки и последнего скачка, ушедшего в неё (см) — для отладки */
  get correction(): number {
    return this.reconciliation.magnitude;
  }

  get lastCorrection(): number {
    return this.reconciliation.lastJump;
  }

  // ------------------------------------------------------------ выстрелы и отрисовка

  updateSound(now: number, listener: SoundListener): void {
    const sounds = this.sounds;
    if (!sounds || !this.isActive) return;
    const delta = Math.min(100, now - this.lastSoundUpdate);
    this.lastSoundUpdate = now;
    const position = this.tank.getBody().state.position;
    const distance = position.distanceTo(listener.position);
    if (distance >= ENGINE_SOUND_RANGE) {
      sounds.enabled = false;
      return;
    }
    const chassis = this.tank.chassis;
    if (chassis.getActualMovementDirection() !== 0) sounds.setAccelerationMode();
    else if (chassis.getActualTurnDirection() !== 0) sounds.setTurningMode();
    else sounds.setIdleMode();
    sounds.enabled = true;
    const gain = Math.min(1, (ENGINE_SOUND_RANGE - distance) / (ENGINE_SOUND_RANGE - ENGINE_FADE_START));
    sounds.play(delta, listener, position, gain);
  }

  /** SHOOT*: вспышка и звук чужого выстрела (RemoteSmokyWeapon.shoot); отдачу живого танка покажут его сэмплы */
  playShot(effects: ShotEffects | null, recoilForce: number): void {
    if (!this.inBattle) return;
    const muzzle = this.skin.turret.muzzles[0];
    calculateMainGunParams(this.tank, muzzle, this.gunParams);
    if (!this.networkDriven) this.tank.getBody().addWorldForceScaled(this.gunParams.barrelOrigin, this.gunParams.direction, -recoilForce);
    effects?.createShotEffects(muzzle, this.tank.getTurretMatrix());
  }

  get barrelOrigin(): Vector3 {
    return this.gunParams.barrelOrigin;
  }

  get barrelDirection(): Vector3 {
    return this.gunParams.direction;
  }

  /** отрисовка после шага физики (интерполяцию состояний делает BattleRunner) */
  render(): void {
    if (this.deathDeadline != 0) {
      const now = performance.now();
      this.tank.skin.setAlpha(Math.min(1, Math.max(0, (this.deathDeadline - now) / CORPSE_FADE_TIME)));
      if (now > this.deathDeadline) {
        this.deathDeadline = 0;
        this.remove();
        return;
      }
    }
    if (this.visible) this.tank.render();
  }

  /**
   * TankModel.renderUserTitles + updateTitleVisibility (DM, противник): ник виден, пока танк в бою, ближе 7000
   * к камере и хотя бы одна точка корпуса не закрыта статикой; project — проекция точки карты в пиксели экрана.
   */
  updateTitle(camera: Vector3, project: (x: number, y: number, z: number) => { x: number; y: number } | null, now = performance.now()): void {
    const title = this.title;
    if (!title) return;
    title.setHealth(this.tank.health);
    if (this.inBattle && !this.dead) {
      const distance = this.tank.getBody().state.position.distanceToSquared(camera);
      if (distance >= TITLE_HIDE_DISTANCE ** 2) title.hide();
      else if (now >= this.nextTitleVisibilityCheck) {
        this.nextTitleVisibilityCheck = now + TITLE_VISIBILITY_INTERVAL_MS;
        if (this.tank.isInvisible(camera)) title.hide();
        else if (distance < TITLE_SHOW_DISTANCE ** 2) title.show();
      }
    }
    // Tank.render: заголовок в точке меша башни; UserTitle.update поднимает его на высоту из конструктора —
    // у чужих танков 200 (TankModel.createUserTitle), у своего 0
    const m = this.tank.getTurretMatrix();
    const screen = this.visible && title.needsProjection ? project(m.d, m.h, m.l + REMOTE_TITLE_HEIGHT) : null;
    title.update(screen?.x ?? null, screen?.y ?? null);
  }

  dispose(): void {
    this.disposed = true;
    this.title?.dispose();
    this.title = null;
    this.remove();
    this.world.remove(this.skin.hull.mesh);
    this.world.remove(this.skin.turret.mesh);
  }
}

import {appearanceMedia} from '../net2/appearance.ts';
import { AllGlobalGunParams } from './weapon/SmokyWeapon.ts';
import { IsidaWeapon, type IsidaConfig } from './weapon/IsidaWeapon.ts';
// Локальный танк на карте без сервера: сборка как в TankModel.objectLoaded/initLocalTank + BattleRunner.tick.
import * as THREE from 'three';
import { Vector3 } from '../physics/math/Vector3.ts';
import type { ServerMap } from '../map/types.ts';
import { BattleRunner } from './BattleRunner.ts';
import { FlyCameraController } from './camera/FlyCameraController.ts';
import { FollowCameraController, followCamera, CAMERA_FOLLOWS_MOUSE, type GameCamera } from './camera/FollowCameraController.ts';
import { parseCollisionGeometry } from './map/CollisionGeometryParser.ts';
import { TankSkin } from './render/TankSkin.ts';
import { TitleConfigFlags, UserTitle, loadProgressBarSkins, type ProgressBarSkins } from './display/UserTitle.ts';
import { BATTLE_TEAM } from '../net/battle-entry.ts';
import { TankSounds, type SoundListener, type SoundManager } from './sfx/Sound.ts';
import { TurboSound } from './sfx/TurboSound.ts';
import { EffectsScene, SmokyEffects } from './sfx/SmokyEffects.ts';
import { TankExplosionEffects } from './sfx/TankExplosionEffects.ts';
import { ShaftEffects } from './sfx/ShaftEffects.ts';
import { StreamEffectFactory, type StreamKind } from './sfx/StreamEffects.ts';
import { RicochetEffects } from './sfx/RicochetEffects.ts';
import { ThunderEffects } from './sfx/ThunderEffects.ts';
import {
  KeyboardSource,
  LocalChassisController,
  LocalTurretController,
  SimpleKeyboardWeaponController,
  TankControlLockBits,
  type ChassisControlListener,
  type TurretControlListener,
} from './tank/Controllers.ts';
import { Tank } from './tank/Tank.ts';
import { TURN_SPEED_COUNT } from './tank/TrackedChassis.ts';
import { MouseInput } from './tank/MouseInput.ts';
import { SmokyWeapon, WEAPON_FORCE_SCALE, WeaponForces, type WeaponShotListener } from './weapon/SmokyWeapon.ts';
import { RailgunWeapon, type RailgunShotListener } from './weapon/RailgunWeapon.ts';
import { RailgunEffects } from './sfx/RailgunEffects.ts';
import { TwinsEffects } from './sfx/TwinsEffects.ts';
import { DistanceWeakening, PlasmaGunData, TwinsWeapon, type TwinsShotListener } from './weapon/TwinsWeapon.ts';
import { ShaftData, ShaftWeapon, type ShaftShotListener } from './weapon/ShaftWeapon.ts';
import { StreamData, StreamWeapon, type StreamShotListener } from './weapon/StreamWeapon.ts';
import { RicochetData, RicochetWeapon, type RicochetShotListener } from './weapon/RicochetWeapon.ts';

/** настройки мыши (SettingEnum.MOUSE_CONTROL, MOUSE_SENSITIVITY, MOUSE_Y_INVERSE клиента 2019) */
export interface MouseSettings {
  mouseControl: boolean;
  mouseSensitivity: number;
  mouseYInverse: boolean;
}

/** Медиа боя: tools/convert_battle_media.py → html5/public/battle */
const BATTLE_MEDIA = 'battle';
/** BattlefieldModel §+!A§ — время полёта камеры к точке спавна, мс */
const FLY_CAMERA_TIME = 3000;
/** ReadyToSpawnTask: труп растворяется за последние 500 мс */
const CORPSE_FADE_TIME = 500;
/** рельса до прихода данных сервера (RailgunCC, ShotCC): turrets.json railgun_data / discrete_shot_data / weapon_weakening_coeff */
const RAILGUN_DEFAULT_CHARGING_TIME = 1200;
const RAILGUN_DEFAULT_WEAKENING = 0.202;
const RAILGUN_DEFAULT_AIM_UP = 0.15708;
const RAILGUN_DEFAULT_AIM_DOWN = 0.20944;

/** BattleUtils.toClientScale */
function toClientScale(value: number): number {
  return value * 100;
}

/** Camera3D.fov в Alternativa3D — по диагонали экрана; CameraFovCorrector.getCameraFov */
function getCameraFov(width: number, height: number): number {
  const unit = height / 9;
  const ratio = width / unit;
  const maxFov = Math.PI / 2;
  if (ratio <= 12) return maxFov;
  let corrected = ratio - (16 - 12);
  if (corrected < 12) corrected = 12;
  const correctedWidth = corrected * unit;
  const focal = (Math.sqrt(correctedWidth * correctedWidth + height * height) * 0.5) / Math.tan(maxFov * 0.5);
  return Math.atan((Math.sqrt(width * width + height * height) * 0.5) / focal) * 2;
}

/** Диагональный угол обзора -> вертикальный для THREE.PerspectiveCamera (в градусах) */
function verticalFovDegrees(diagonalFov: number, width: number, height: number): number {
  const focal = (Math.sqrt(width * width + height * height) * 0.5) / Math.tan(diagonalFov * 0.5);
  return THREE.MathUtils.radToDeg(2 * Math.atan((height * 0.5) / focal));
}

const forward = new THREE.Vector3();
const up = new THREE.Vector3();
const target = new THREE.Vector3();

export class TankDemo {
  readonly runner: BattleRunner;
  readonly tank: Tank;
  private readonly cameraController: FollowCameraController;
  private readonly gameCamera: GameCamera = { position: new Vector3(), rotation: new Vector3() };
  readonly chassisController: LocalChassisController;
  readonly turretController: LocalTurretController;
  /** оружие по башне скина: у каждой пушки своя модель и механика */
  private readonly weapon: SmokyWeapon | RailgunWeapon | TwinsWeapon | ShaftWeapon | StreamWeapon | RicochetWeapon;
  /** сеть: изменения управления шасси и башней уходят на сервер (TankModel.onChassisControlChanged / sendTurretControlCommand) */
  netChassisListener: ChassisControlListener | null = null;
  netTurretListener: TurretControlListener | null = null;
  private readonly cameraMatrix = new THREE.Matrix4();
  private readonly cameraEuler = new THREE.Euler(0, 0, 0, 'ZYX');
  readonly effectsScene: EffectsScene;
  private readonly keyboard: KeyboardSource;
  private scopeUp=false;
  private scopeDown=false;
  private scopeLeft=false;
  private scopeRight=false;
  private scopeActive=false;
  private readonly scopeParams=new AllGlobalGunParams();
  private readonly scopeStartPosition=new THREE.Vector3();
  private readonly scopeStartRotation=new THREE.Quaternion();
  private scopeCaptured=false;
  private scopeWasPostShot=false;
  private scopeReturnAt=-1;
  private readonly scopeLastPosition=new THREE.Vector3();
  private readonly scopeLastRotation=new THREE.Quaternion();
  private scopeLastFov=1;
  private readonly flyCamera: FlyCameraController;
  private flying = false;
  private deathDeadline = 0;
  private onReadyToSpawn: (() => void) | null = null;
  /** первый спавн в бою — без полёта камеры (§ !Z§ в TankModel) */
  private firstSpawn = true;
  /**
   * SpawnCameraConfigurator.setupCamera + battleReadinessService.unlockUser: до первого PREPARE_TO_SPAWN камера
   * стоит где попало, и бой не рисуется — иначе в первый тик виден случайный кадр карты.
   */
  cameraReady = false;
  private readonly world: THREE.Object3D;
  private inBattle = false;
  private weaponController: SimpleKeyboardWeaponController = null as unknown as SimpleKeyboardWeaponController;
  /** мышь в бою (BattleInputService 2019) */
  private mouseInput: MouseInput | null = null;
  explosionEffects: TankExplosionEffects | null = null;
  private tankSounds: TankSounds | null = null;
  /** турбонаддув — только у корпуса Varan */
  private turbo: TurboSound | null = null;
  /** заголовок над танком (§ !6§ в Tank.as) */
  private title: UserTitle | null = null;
  private titleSkins: ProgressBarSkins | null = null;
  /** команда своего танка (BATTLE_TEAM): полоска здоровья цвета своей команды */
  private team: number = BATTLE_TEAM.NONE;
  /** значки эффектов своего танка: тип -> время окончания, мс (для заголовка, который ещё грузится) */
  private readonly activeEffects = new Map<number, number>();
  private disposed = false;
  private readonly titlePosition = new THREE.Vector3();
  private screenCamera: THREE.PerspectiveCamera | null = null;
  private screenWidth = 0;
  private screenHeight = 0;
  /** оптика Шафта: затемнение по краям и прицел */
  private scopeOverlay: HTMLDivElement | null = null;
  private scopeReticle:HTMLImageElement|null=null;
  private readonly listener: SoundListener = { position: new Vector3(), xAxis: new Vector3() };

  private constructor(
    map: ServerMap,
    gravity: number,
    skin: TankSkin,
    world: THREE.Object3D,
    readonly soundManager: SoundManager,
    offlineSpawn: boolean,
    private readonly archiveEffects: boolean,
  ) {
    const keyboard = new KeyboardSource(window);
    this.keyboard = keyboard;
    keyboard.addListener((key,down)=>{
      if(!(this.weapon instanceof ShaftWeapon))return;
      if(key===87||key===38)this.scopeUp=down;
      if(key===83||key===40)this.scopeDown=down;
      this.weapon.elevationInput=Number(this.scopeUp)-Number(this.scopeDown);
      if(key===65||key===37)this.scopeLeft=down;
      if(key===68||key===39)this.scopeRight=down;
      if(this.scopeActive && [65,37,68,39].includes(key))this.turretController.applyControlState((this.scopeLeft?1:0)|(this.scopeRight?2:0));
    });
    this.world = world;
    this.runner = new BattleRunner(gravity);
    this.runner.buildStaticGeometry(parseCollisionGeometry(map));
    this.effectsScene = new EffectsScene(world, this.runner.getCollisionDetector());

    const hullSpec = skin.hull.spec;
    const turretSpec = skin.turret.spec;
    const turretController = new LocalTurretController(turretSpec.turretRotationSpeed, turretSpec.turretRotationAcceleration, keyboard);
    const forces = new WeaponForces(turretSpec.impactForce * WEAPON_FORCE_SCALE, turretSpec.kickback * WEAPON_FORCE_SCALE);
    this.turretController = turretController;
    turretController.setListener({ onTurretControlChanged: (control) => this.netTurretListener?.onTurretControlChanged(control) });
    const weaponController = new SimpleKeyboardWeaponController(keyboard);
    this.weaponController = weaponController;
    turretController.turretWorldDirection = () => this.tank.getInterpolatedTurretWorldDirection();
    const turretKind = skin.turretKind;
    this.weapon =
      skin.railgunModification != null
        ? new RailgunWeapon(
            turretSpec.reloadTime,
            forces,
            weaponController,
            this.runner.getCollisionDetector(),
            RAILGUN_DEFAULT_CHARGING_TIME,
            RAILGUN_DEFAULT_WEAKENING,
            RAILGUN_DEFAULT_AIM_UP,
            RAILGUN_DEFAULT_AIM_DOWN,
          )
        : turretKind == 'twins'
          ? new TwinsWeapon(turretSpec.reloadTime, forces, weaponController, this.runner)
          : turretKind == 'shaft'
            ? new ShaftWeapon(turretSpec.reloadTime, forces, weaponController, this.runner.getCollisionDetector(), RAILGUN_DEFAULT_AIM_UP, RAILGUN_DEFAULT_AIM_DOWN)
            : turretKind == 'isida'
              ? new IsidaWeapon(forces, weaponController, this.runner.getCollisionDetector(), this.effectsScene)
            : turretKind == 'firebird' || turretKind == 'freeze'
              ? new StreamWeapon(forces, weaponController, this.runner.getCollisionDetector(), this.effectsScene, turretKind)
              : turretKind == 'ricochet'
                ? new RicochetWeapon(turretSpec.reloadTime, forces, weaponController, this.runner)
                : new SmokyWeapon(turretSpec.reloadTime, forces, weaponController, this.runner.getCollisionDetector());
    this.tank = new Tank(hullSpec.mass, hullSpec.damping, skin, turretController, this.weapon);
    this.chassisController = new LocalChassisController(this.tank, keyboard, {
      onChassisControlChanged: (control) => this.netChassisListener?.onChassisControlChanged(control),
    });

    // TankModel.objectLoaded + setTankSpec
    this.tank.setReverseAcceleration(toClientScale(hullSpec.reverseAcceleration));
    this.tank.setSideAcceleration(toClientScale(hullSpec.sideAcceleration));
    this.tank.setTurnAcceleration(hullSpec.turnAcceleration);
    this.tank.setReverseTurnAcceleration(hullSpec.reverseTurnAcceleration);
    this.tank.setMaxSpeed(toClientScale(hullSpec.speed), true);
    this.tank.setMaxTurnSpeed(hullSpec.turnSpeed, true);
    this.tank.setAcceleration(toClientScale(hullSpec.acceleration));
    turretController.setMaxTurnSpeed(turretSpec.turretRotationSpeed, true);

    this.runner.addLogicUnit(this.weapon);
    skin.addToScene(world);
    // TankModel.addTankToBattle: в сетевом бою свой танк попадает в сцену и физику только по SPAWN
    if (offlineSpawn) this.setInBattle(true);
    else this.setMeshesVisible(false);

    if(this.weapon instanceof ShaftWeapon){
    this.weapon.setAimWorldDirection=angle=>this.turretController.aimAtWorldDirection(angle);
    this.weapon.onScope=(active)=>{
      if(!active&&this.scopeWasPostShot&&this.tank.health>0)this.scopeReturnAt=performance.now();
      if(active)this.scopeReturnAt=-1;
      this.scopeWasPostShot=false;
      this.scopeActive=active;this.scopeCaptured=false;
      if(active){this.chassisController.lock(TankControlLockBits.SHAFT_AIM);this.turretController.setMaxTurnSpeed(this.weapon instanceof ShaftWeapon?this.weapon.scopeTurnSpeed:turretSpec.turretRotationSpeed,true);}
      else {this.chassisController.unlock(TankControlLockBits.SHAFT_AIM);this.turretController.applyControlState(0);this.turretController.onAddToBattle();this.turretController.setMaxTurnSpeed(turretSpec.turretRotationSpeed,true);}
    };}
    this.cameraController = new FollowCameraController(this.gameCamera, this.runner.getCollisionDetector(), keyboard);
    this.cameraController.setTarget(this.tank);
    this.flyCamera = new FlyCameraController(this.gameCamera);

    if (offlineSpawn) {
      this.spawn(map);
      this.cameraReady = true;
    }
  }

  /** Выход из боя: танк, заголовок, звуки и подписки на клавиатуру убираются */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mouseInput?.dispose();
    this.mouseInput = null;
    this.turretController.disable();
    this.netChassisListener = null;
    this.netTurretListener = null;
    this.setShotListener(null);
    this.setRailgunListener(null);
    this.setTwinsListener(null);
    this.setShaftListener(null);
    this.setStreamListener(null);
    this.setRicochetListener(null);
    this.removeScopeOverlay();
    this.weapon.disable();
    this.tank.kill();
    this.setInBattle(false);
    this.world.remove(this.tank.skin.hull.mesh);
    this.world.remove(this.tank.skin.turret.mesh);
    this.title?.dispose();
    this.title = null;
    this.keyboard.dispose();
    this.effectsScene.clear();
    this.turbo?.dispose();
    this.turbo = null;
  }

  /**
   * Управление мышью как в клиенте 2019: клик по сцене захватывает мышь, движение по горизонтали ведёт башню
   * и камеру, по вертикали — высоту камеры, колесо — высоту камеры, ЛКМ — выстрел, ПКМ — осмотреться.
   */
  enableMouseControl(element: HTMLElement, settings: () => MouseSettings): void {
    this.mouseInput?.dispose();
    this.tank.turretSoundAllowed = () => !this.scopeActive;
    this.tank.turretSoundVolume = () => settings().mouseControl && followCamera.mode===CAMERA_FOLLOWS_MOUSE ? 0.125 : 1;
    const apply = (): void => {
      const value = settings();
      this.turretController.mouseSensitivity = value.mouseSensitivity;
      this.cameraController.mouseYInverse = value.mouseYInverse;
    };
    apply();
    const input = new MouseInput(
      element,
      {
        onMouseLock: (locked) => {
          apply();
          this.turretController.onMouseLock(locked);
        },
        onMouseRelativeMovement: (dx, dy) => {
          this.aimRelative(dx,dy);
        },
        onMouseWheel: (delta) => this.cameraController.onMouseWheel(delta),
        onShot: (down) => this.weaponController.setMouseTrigger(down),
        onLookAround: (down) => this.turretController.onLookAround(down),
      },
      () => settings().mouseControl && this.cameraReady,
    );
    this.turretController.releaseMouse = () => input.releaseMouse();
    this.mouseInput = input;
  }

  setTouchKey(keyCode:number,down:boolean):void {this.keyboard.setVirtualKey(keyCode,down);}

  setTouchMovement(axes:{move:number;turn:number}|null):void {
    this.tank.chassis.movementSpeedFactor=axes?.move ? Math.abs(axes.move) : 1;
    this.tank.chassis.turnSpeedNumber=TURN_SPEED_COUNT*(axes?.turn ? Math.abs(axes.turn) : 1);
  }

  aimTouch(dx:number,dy:number):void {
    if(!this.cameraReady)return;
    this.turretController.onMouseLock(true);
    // A finger drag covers fewer CSS pixels than a desktop mouse movement.
    this.aimRelative(dx*8,dy*8);
  }

  private aimRelative(dx:number,dy:number):void {
          if(this.weapon instanceof ShaftWeapon && this.weapon.isAiming){
            const focal=this.screenHeight>0&&this.screenCamera ? this.screenHeight/(2*Math.tan(this.screenCamera.fov*Math.PI/360)):1000;
            this.weapon.aimMouse(dx,dy,this.turretController.mouseSensitivity,this.cameraController.mouseYInverse,1/focal);
            return;
          }
          const before=followCamera.direction;
          this.turretController.onMouseRelativeMovement(dx, dy);
          const delta=followCamera.direction-before;
          this.cameraController.onMouseRelativeMovement(dx, dy, Math.atan2(Math.sin(delta),Math.cos(delta)));
  }

  releaseMouse(): void {
    this.mouseInput?.releaseMouse();
  }

  /** настройки мыши поменялись: чувствительность и инверсия сразу, выключенное управление отпускает мышь */
  applyMouseSettings(settings: MouseSettings): void {
    this.turretController.mouseSensitivity = settings.mouseSensitivity;
    this.cameraController.mouseYInverse = settings.mouseYInverse;
    if (!settings.mouseControl) this.mouseInput?.releaseMouse();
  }

  /** Tank.addToBattle / removeFromBattle */
  private setInBattle(value: boolean): void {
    if (value == this.inBattle) return;
    this.inBattle = value;
    if (value) {
      this.runner.addBodyWrapper(this.tank.tankBody);
      this.runner.addPhysicsController(this.tank);
      this.runner.addPostPhysicsController(this.tank);
      this.runner.addPhysicsInterpolator(this.tank);
    } else {
      this.runner.removeBodyWrapper(this.tank.tankBody);
      this.runner.removePhysicsController(this.tank);
      this.runner.removePostPhysicsController(this.tank);
      this.runner.removePhysicsInterpolator(this.tank);
    }
  }

  private setMeshesVisible(visible: boolean): void {
    this.tank.skin.hull.mesh.visible = visible;
    this.tank.skin.turret.mesh.visible = visible;
  }

  /** TankModel.kill + createDeathEffects для своего танка: труп остаётся на карте с «мёртвой» краской и взрывом */
  killFromServer(respawnDelay: number, onReadyToSpawn: () => void): void {
    // ReadyToSpawnTask: труп стоит respawnDelay мс, последние 500 мс растворяется, затем уходит из боя
    this.deathDeadline = performance.now() + respawnDelay;
    this.onReadyToSpawn = onReadyToSpawn;
    // TankModel.killLocalTank: lockFollowCamera — камера больше не идёт за танком
    this.cameraController.setLocked(true);
    this.chassisController.setControlState(0);
    this.chassisController.lock(TankControlLockBits.DEAD);
    this.turretController.lock(TankControlLockBits.DEAD);
    this.weapon.disable();
    this.tank.kill();
    this.tank.applyDeathKick();
    this.title?.setHealth(0);
    this.title?.hide();
    const effects = this.explosionEffects;
    if (effects) {
      this.tank.skin.setDeadState(effects.deadColoring);
      effects.create(this.tank);
    }
  }

  /**
   * TankModel.onBattleFinish: disableUserControls + lockMovementControl + lockWeapon(BATTLE_FINISH), Tank.disable прячет значки.
   * Танк остаётся стоять на месте до рестарта.
   */
  finishBattle(): void {
    this.chassisController.lock(TankControlLockBits.BATTLE_FINISH);
    this.turretController.lock(TankControlLockBits.BATTLE_FINISH);
    this.turretController.applyControlState(0);
    this.weapon.disable();
    this.activeEffects.clear();
    this.title?.hideIndicators();
  }

  /**
   * TankModel.onBattleRestart: removeTankFromBattle — танк (живой или труп) уходит с поля, дальше обычные PREPARE_TO_SPAWN и SPAWN.
   * Блокировка конца раунда снимается, шасси остаётся заблокированным до спавна (DEAD).
   */
  restartBattle(): void {
    this.deathDeadline = 0;
    this.onReadyToSpawn = null;
    this.chassisController.setControlState(0);
    this.chassisController.lock(TankControlLockBits.DEAD);
    this.chassisController.unlock(TankControlLockBits.BATTLE_FINISH);
    this.turretController.unlock(TankControlLockBits.BATTLE_FINISH);
    this.weapon.disable();
    this.title?.hide();
    this.setMeshesVisible(false);
    this.setInBattle(false);
  }

  /** EffectActivatedEvent: значок эффекта (индекс 1 аптечка, 2 броня, 3 мощность, 4 нитро) над своим танком на leftMs */
  showEffect(type: number, leftMs: number): void {
    if (type === 3) { this.tank.weaponBuffed=true; if (this.weapon instanceof IsidaWeapon) this.weapon.setBuffedMode(true); }
    this.activeEffects.set(type, performance.now() + leftMs);
    this.title?.showIndicator(type, leftMs);
  }

  /** EffectStoppedEvent */
  hideEffect(type: number): void {
    if (type === 3) { this.tank.weaponBuffed=false; if (this.weapon instanceof IsidaWeapon) this.weapon.setBuffedMode(false); }
    this.activeEffects.delete(type);
    this.title?.hideIndicator(type);
  }

  /**
   * TankModel.setSpecification (SET_SPECIFICATION): сервер меняет скорость, поворот, поворот башни и разгон (нитро, заморозка).
   * Значения стартуют плавно (immediate = false), как setTankSpec во Flash.
   */
  setSpecification(speed: number, turnSpeed: number, turretRotationSpeed: number, acceleration: number): void {
    this.tank.setMaxSpeed(toClientScale(speed), false);
    this.tank.setMaxTurnSpeed(turnSpeed, false);
    this.tank.setAcceleration(toClientScale(acceleration));
    this.turretController.setMaxTurnSpeed(turretRotationSpeed, false);
  }

  /**
   * Нитро (TankSpecification.set_tank_speed_with_factor): скорость, поворот корпуса, поворот башни и разгон
   * умножаются на factor; 1 — возврат к исходным. Значения стартуют плавно, как setSpecification.
   */
  setSpeedFactor(factor: number): void {
    const hull = this.tank.skin.hull.spec;
    const turret = this.tank.skin.turret.spec;
    this.tank.setMaxSpeed(toClientScale(hull.speed * factor), false);
    this.tank.setMaxTurnSpeed(hull.turnSpeed * factor, false);
    this.tank.setAcceleration(toClientScale(hull.acceleration * factor));
    this.turretController.setMaxTurnSpeed(turret.turretRotationSpeed * factor, false);
  }

  /** TankModel.createTankSounds + SmokySFXModel.objectLoaded: звуки и эффекты грузятся вслед за танком */
  private async loadMedia(): Promise<void> {
    const engine = this.soundManager.engine;
    const sounds = await TankSounds.load(engine);
    if (this.disposed) return;
    this.tankSounds = sounds;
    if (/\/hulls\/varan\//.test(this.tank.skin.hull.source)) {
      this.turbo = new TurboSound(engine);
      console.info('турбонаддув Varan включён');
    }
    this.tank.sounds = sounds;
    sounds.setIdleMode();
    sounds.turretSoundEnabled = true;
    // до SPAWN танк не в бою — двигатель молчит (Tank.spawn включит звуки)
    sounds.enabled = this.inBattle;
    // TankModel.createUserTitle(локальный танк) + initLocalUserTitle: здоровье, перезарядка, значки эффектов
    this.titleSkins = await loadProgressBarSkins(`${BATTLE_MEDIA}/usertitle`);
    if (this.disposed) return;
    const title = new UserTitle(document.body, this.titleSkins, this.tank.skin.hull.spec.armor, this.archiveEffects);
    title.setSkin(this.teamSkin(this.titleSkins));
    title.setHealth(this.tank.health);
    title.setConfiguration(TitleConfigFlags.HEALTH | TitleConfigFlags.WEAPON | TitleConfigFlags.EFFECTS);
    // до SPAWN танка в бою нет — заголовок покажет spawnFromServer
    if (this.inBattle) title.show();
    else title.hide();
    this.title = title;
    // эффекты, пришедшие до загрузки заголовка (вход в бой с активной аптечкой, бронёй и т. д.)
    const now = performance.now();
    for (const [type, end] of this.activeEffects) if (end > now) title.showIndicator(type, end - now);
    const media=appearanceMedia(this.tank.skin.turretStyle);
    const weapon = this.weapon;
    if (weapon instanceof RailgunWeapon) {
      weapon.effects = await RailgunEffects.load(this.tank.skin.railgunModification ?? 0, this.soundManager, this.effectsScene,`${media}/railgun`);
    } else if (weapon instanceof TwinsWeapon) {
      weapon.effects = await TwinsEffects.load(this.soundManager, this.effectsScene,media,this.tank.skin.turretModification);
    } else if (weapon instanceof ShaftWeapon) {
      weapon.effects = await ShaftEffects.load(media, this.soundManager, this.effectsScene,this.tank.skin.turretModification);
    } else if (weapon instanceof StreamWeapon) {
      weapon.effectsFactory = await StreamEffectFactory.load(weapon.streamKind, media, this.soundManager, this.tank.skin.turretModification);
    } else if (weapon instanceof RicochetWeapon) {
      weapon.effects = await RicochetEffects.load(media, this.soundManager, this.effectsScene, this.tank.skin.turretModification);
    } else if (this.tank.skin.turretKind == 'thunder') {
      weapon.effects = await ThunderEffects.load(media, this.soundManager, this.effectsScene,this.tank.skin.turretModification);
    } else {
      weapon.effects = await SmokyEffects.load(media, this.soundManager, this.effectsScene,this.tank.skin.turretModification);
    }
    this.explosionEffects = await TankExplosionEffects.load(BATTLE_MEDIA, this.soundManager, this.effectsScene);
  }

  /** offlineSpawn = false — танк ждёт SPAWN от сервера (сетевой бой) */
  static async create(map: ServerMap, gravity: number, world: THREE.Object3D, soundManager: SoundManager, offlineSpawn = true, tankSkin: TankSkin | null = null, archiveEffects = false): Promise<TankDemo> {
    const skin = tankSkin ?? (await TankSkin.load('tank_parts/hulls/hunter/m0', 'tank_parts/turrets/smoky/m0', 'tank_parts/paints/green.jpg'));
    const demo = new TankDemo(map, gravity, skin, world, soundManager, offlineSpawn, archiveEffects);
    demo.loadMedia().catch((error: unknown) => console.warn('звуки и эффекты не загружены', error));
    return demo;
  }

  /** Спавн как на сервере: точка спавна + 100 по Z (map_loader.py), углы из карты */
  spawn(map: ServerMap): void {
    const point = map.spawns.find((spawn) => spawn.type == 'dm') ?? map.spawns[0];
    const position = new Vector3(point?.position.x ?? 0, point?.position.y ?? 0, (point?.position.z ?? 0) + 100);
    const rotation = new Vector3(point?.rotation.x ?? 0, point?.rotation.y ?? 0, point?.rotation.z ?? 0);
    this.tank.health = this.tank.skin.hull.spec.armor;
    this.title?.setHealth(this.tank.health);
    this.title?.show();
    this.tank.spawn();
    this.tank.setPhysicsState(position, rotation, new Vector3(), new Vector3());
    this.tank.setActivatedState();
    this.chassisController.unlock(TankControlLockBits.DEAD);
    this.turretController.unlock(TankControlLockBits.DEAD);
    this.weapon.enable();
    this.tank.interpolatePhysicsState(1);
    this.turretController.onAddToBattle();
    const cameraPosition = new Vector3();
    const cameraDirection = new Vector3();
    this.tank.getCameraParams(cameraPosition, cameraDirection);
    this.cameraController.setTargetParams(cameraPosition, cameraDirection);
  }

  /**
   * TankModel.spawn для своего танка: позиция и углы от сервера, танк «полуактивен» (без оружия) до ACTIVATE_TANK.
   * Шасси разблокировано сразу (в оригинале управление работает и во время активации).
   */
  spawnFromServer(position: Vector3, rotation: Vector3, health: number): void {
    this.tank.health = health;
    this.title?.setHealth(health);
    this.title?.show();
    this.setInBattle(true);
    this.setMeshesVisible(true);
    this.tank.skin.setNormalState();
    this.title?.show();
    this.tank.spawn();
    this.tank.setPhysicsState(position, rotation, new Vector3(), new Vector3());
    this.tank.setSemiActivatedState();
    this.chassisController.unlock(TankControlLockBits.DEAD);
    this.weapon.disable();
    this.tank.interpolatePhysicsState(1);
    this.turretController.onAddToBattle();
    this.deathDeadline = 0;
    // TankModel.spawn: unlockFollowCamera + activateFollowCamera — после полёта камера плавно переходит к слежению
    this.cameraController.setLocked(false);
    if (this.flying) {
      this.flying = false;
      this.cameraController.syncWithCamera();
    } else {
      const cameraPosition = new Vector3();
      const cameraDirection = new Vector3();
      this.tank.getCameraParams(cameraPosition, cameraDirection);
      this.cameraController.setTargetParams(cameraPosition, cameraDirection);
    }
    this.firstSpawn = false;
  }

  /**
   * TankModel.prepareToSpawn: камера 3 с летит к виду на точку спавна (BattlefieldModel.activateFlyCamera);
   * при первом спавне в бою — сразу ставится туда без полёта.
   */
  prepareToSpawn(position: Vector3, rotation: Vector3): void {
    const direction = new Vector3(-Math.sin(rotation.z), Math.cos(rotation.z), 0);
    if (this.firstSpawn) {
      // SpawnCameraConfigurator (firstSpawn): activateFollowCamera, setFollowCameraState(позиция, направление), lockFollowCamera
      this.cameraController.setLocked(true);
      this.cameraController.setTargetParams(position, direction);
      this.cameraReady = true;
      return;
    }
    const cameraPosition = new Vector3();
    const cameraRotation = new Vector3();
    this.cameraController.getTargetCameraParams(position, direction, cameraPosition, cameraRotation);
    this.flyCamera.init(cameraPosition, cameraRotation, FLY_CAMERA_TIME);
    this.flying = true;
  }

  /** ReadyToSpawnTask.runLogic: растворение трупа и уход из боя по истечении времени */
  private updateDeath(now: number): void {
    if (this.deathDeadline == 0) return;
    this.tank.skin.setAlpha(Math.min(1, Math.max(0, (this.deathDeadline - now) / CORPSE_FADE_TIME)));
    if (now <= this.deathDeadline) return;
    this.deathDeadline = 0;
    this.setMeshesVisible(false);
    this.setInBattle(false);
    const callback = this.onReadyToSpawn;
    this.onReadyToSpawn = null;
    callback?.();
  }

  /** сеть: выстрелы своего оружия уходят на сервер, включается автонаведение по вертикали */
  setThunderImpactListener(listener:((point:Vector3,body:import('../physics/Body.ts').Body|null)=>number)|null):void{
    if(this.weapon instanceof SmokyWeapon)this.weapon.impactListener=listener;
  }
  setShotListener(listener: WeaponShotListener | null): void {
    if (this.weapon instanceof SmokyWeapon) this.weapon.shotListener = listener;
  }

  /** сеть: зарядка и выстрелы рельсы (RailgunCallback) */
  setRailgunListener(listener: RailgunShotListener | null): void {
    if (this.weapon instanceof RailgunWeapon) this.weapon.listener = listener;
  }

  /** сеть: выстрелы и попадания Twins (IPlasmaWeaponCallback) */
  setTwinsListener(listener: TwinsShotListener | null): void {
    if (this.weapon instanceof TwinsWeapon) this.weapon.listener = listener;
  }

  /** сеть: вход в прицел и выстрелы Шафта */
  setShaftListener(listener: ShaftShotListener | null): void {
    if (this.weapon instanceof ShaftWeapon) this.weapon.listener = listener;
  }

  /** сеть: струя Огнемёта, Фриза и Изиды */
  setStreamListener(listener: StreamShotListener | null): void {
    if (this.weapon instanceof StreamWeapon) this.weapon.listener = listener;
  }

  /** сеть: выстрелы и попадания Рикошета */
  setRicochetListener(listener: RicochetShotListener | null): void {
    if (this.weapon instanceof RicochetWeapon) this.weapon.listener = listener;
  }

  /** ShaftCC + ShaftShotCC от сервера */
  configureShaft(data: ShaftData): void {
    if (this.weapon instanceof ShaftWeapon) this.weapon.configure(data);
  }

  /** StreamWeaponCC от сервера (тик, энергия, конус, дальность) */
  configureIsida(data: IsidaConfig): void {
    if (this.weapon instanceof IsidaWeapon) this.weapon.configureIsida(data);
  }

  configureStream(data: StreamData): void {
    if (this.weapon instanceof StreamWeapon) this.weapon.configure(data);
  }

  /** RicochetCC от сервера (отскоки, скорость, дальность) */
  configureRicochet(data: RicochetData): void {
    if (this.weapon instanceof RicochetWeapon) this.weapon.configure(data);
  }

  /** эффекты своего Грома (для чужих выстрелов Грома — общие) */
  get thunderEffects(): ThunderEffects | null {
    return this.weapon instanceof SmokyWeapon && this.weapon.effects instanceof ThunderEffects ? this.weapon.effects : null;
  }

  /** эффекты своего Рикошета (для чужих шаров — общие) */
  get ricochetEffects(): RicochetEffects | null {
    return this.weapon instanceof RicochetWeapon ? this.weapon.effects : null;
  }

  /** эффекты своего Шафта (для чужих выстрелов — общие) */
  get shaftEffects(): ShaftEffects | null {
    return this.weapon instanceof ShaftWeapon ? this.weapon.effects : null;
  }

  /** загруженные текстуры своей струи и её вид */
  get streamEffectFactory(): StreamEffectFactory | null {
    return this.weapon instanceof StreamWeapon ? this.weapon.effectsFactory : null;
  }

  get streamKind(): StreamKind | null {
    return this.weapon instanceof StreamWeapon ? this.weapon.streamKind : null;
  }

  /** 0 — обычный обзор, 1 — полная оптика Шафта */
  get shaftAimZoom(): number {
    return this.weapon instanceof ShaftWeapon ? this.weapon.getAimZoom() : 0;
  }

  /** TwinsCC + WeaponWeakeningCC от сервера */
  configureTwins(gun: PlasmaGunData, weakening: DistanceWeakening): void {
    if (this.weapon instanceof TwinsWeapon) this.weapon.configure(gun, weakening);
  }

  /** эффекты своего Twins (для чужих Twins, пока свои не загружены — null) */
  get twinsEffects(): TwinsEffects | null {
    return this.weapon instanceof TwinsWeapon ? this.weapon.effects : null;
  }

  get isRailgun(): boolean {
    return this.weapon instanceof RailgunWeapon;
  }

  /** RailgunCC от сервера: время зарядки и ослабление за каждую пробитую цель */
  configureRailgun(chargingTime: number, weakeningCoeff: number): void {
    if (this.weapon instanceof RailgunWeapon) this.weapon.configure(chargingTime, weakeningCoeff);
  }

  /** WeaponCommonCC.reload_time от сервера: у каждой модификации пушки своя перезарядка */
  configureReload(reloadMs: number): void {
    if (reloadMs <= 0 || this.weapon instanceof StreamWeapon) return;
    this.weapon.setReloadTime(reloadMs);
  }

  setAutoAimAngles(up: number, down: number): void {
    if (this.weapon instanceof StreamWeapon) return;
    this.weapon.setAutoAimAngles(up, down);
  }

  /** эффекты своего Смоки (у остальных пушек — null) */
  get weaponEffects(): SmokyEffects | null {
    return this.weapon instanceof SmokyWeapon && this.weapon.effects instanceof SmokyEffects ? this.weapon.effects : null;
  }

  get weaponForces(): WeaponForces {
    return this.weapon.forces;
  }

  /** TankModel.activateTank: боевое состояние и оружие */
  activateFromServer(): void {
    this.tank.setActivatedState();
    this.turretController.unlock(TankControlLockBits.DEAD);
    this.weapon.enable();
  }

  /** TankModel.configureTankTitle: в командном бою заголовок своего танка — цвета своей команды */
  setTeam(team: number): void {
    this.team = team;
    if (this.title && this.titleSkins) this.title.setSkin(this.teamSkin(this.titleSkins));
  }

  private teamSkin(skins: ProgressBarSkins): ProgressBarSkins['dm'] {
    return this.team == BATTLE_TEAM.RED ? skins.red : this.team == BATTLE_TEAM.BLUE ? skins.blue : skins.dm;
  }

  /** Brackets stay at screen centre. Camera follows the mouse target; reticle projects the physical barrel. */
  private updateScopeOverlay(zoom:number,camera:THREE.PerspectiveCamera,width:number,height:number):void{
    if(zoom<=0.01){if(this.scopeOverlay)this.scopeOverlay.style.opacity='0';return;}
    if(!this.scopeOverlay)this.scopeOverlay=this.createScopeOverlay();
    this.scopeOverlay.style.opacity=String(Math.min(1,zoom));
    if(this.scopeReticle && this.weapon instanceof ShaftWeapon){
      this.weapon.getScopeParams(this.scopeParams);
      const direction=this.scopeParams.direction;
      camera.updateMatrixWorld();
      const local=new THREE.Vector3(direction.x,direction.z,-direction.y).applyQuaternion(camera.quaternion.clone().invert());
      const focal=height/(2*Math.tan(camera.fov*Math.PI/360));
      const visible=local.z<0;
      this.scopeReticle.style.display=visible?'block':'none';
      if(visible){
        this.scopeReticle.style.left=`${width/2+local.x/-local.z*focal}px`;
        this.scopeReticle.style.top=`${height/2-local.y/-local.z*focal}px`;
      }
    }
  }
  private createScopeOverlay():HTMLDivElement{
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:6;opacity:0;';
    const reticle=document.createElement('img');
    reticle.src=`${BATTLE_MEDIA}/images/turrets/shaft/sight.svg`;
    reticle.style.cssText='position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(70vmin,666px);height:min(70vmin,666px);';
    const brackets=document.createElement('div');
    brackets.style.cssText='position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(15.55vmin,148px);height:min(11.98vmin,114px);';
    brackets.innerHTML='<svg viewBox="0 0 148 114" width="100%" height="100%" fill="none" stroke="#85ff39" stroke-width="2"><path d="M26 1H1V113H26 M122 1H147V113H122"/></svg>';
    this.scopeReticle=reticle;
    overlay.append(reticle,brackets);document.body.appendChild(overlay);return overlay;
  }
  private removeScopeOverlay(): void {
    this.scopeOverlay?.remove();
    this.scopeOverlay = null;
    this.scopeReticle=null;
  }

  setHealth(health: number): void {
    this.tank.health = health;
    this.title?.setHealth(health);
  }

  /** число контактов танка с геометрией: активировать можно только на свободном месте (TankModel.onReadyToActivate) */
  getCollisionCount(): number {
    return this.tank.getCollisionCount();
  }

  /**
   * Шаг без отрисовки, пока вкладка скрыта или окно закрыто другим (браузер не даёт кадров): физика и смерть
   * идут дальше, иначе свой танк «замирал» для себя, а чужие танки и толчки по своему расходились с сервером.
   */
  simulate(): void {
    this.runner.tick();
    this.updateDeath(performance.now());
  }

  /** BattleRunner.tick + BattleScene3D.render: физика, отрисовка танка, камера */
  readonly cpuTiming = { physicsAndInput: 0, camera: 0 };

  update(camera: THREE.PerspectiveCamera, width: number, height: number, frameTime?: number, profile = false): void {
    const start = profile ? performance.now() : 0;
    this.mouseInput?.flushMotion();
    const delta = this.runner.tick(frameTime);
    this.updateDeath(performance.now());
    this.tank.render();
    const cameraStart = profile ? performance.now() : 0;
    if (this.flying) this.flyCamera.update(delta);
    else this.cameraController.update(delta);
    this.applyCamera(camera, width, height);
    this.updateScopeOverlay(this.shaftAimZoom,camera,width,height);
    if (profile) {
      this.cpuTiming.physicsAndInput = cameraStart - start;
      this.cpuTiming.camera = performance.now() - cameraStart;
    }
    this.tank.skin.hull.mesh.visible=this.inBattle&&!this.scopeActive;
    this.tank.skin.turret.mesh.visible=this.inBattle&&!this.scopeActive;
    // BattleScene3D: графические эффекты; SoundManager: звуки относительно камеры
    const soundCamera=this.listener.position.reset(camera.position.x,-camera.position.z,camera.position.y);
    this.effectsScene.update(delta, soundCamera);
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    this.listener.xAxis.reset(e[0], -e[2], e[1]);
    if (this.inBattle) this.tankSounds?.play(delta, this.listener, this.tank.getBody().state.position);
    if (this.turbo) {
      const chassis = this.tank.chassis;
      const velocity = this.tank.getBody().state.velocity;
      const maxSpeed = this.tank.getMaxSpeed();
      const speedRatio = maxSpeed > 0 ? Math.hypot(velocity.x, velocity.y) / maxSpeed : 0;
      // газ — движение вперёд/назад, поворот на месте — частичная нагрузка
      const throttle = chassis.getActualMovementDirection() != 0 ? 1 : chassis.getActualTurnDirection() != 0 ? 0.4 : 0;
      const enabled = this.inBattle && (this.tankSounds?.enabled ?? false);
      this.turbo.update(delta, throttle, speedRatio, enabled, this.listener, this.tank.getBody().state.position);
    }
    this.soundManager.update(delta, this.listener);
    this.updateTitle(camera, width, height);
  }

  /** Tank.render: заголовок в точке меша башни, перезарядка — 100 × weapon.getStatus() (int) */
  private updateTitle(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    this.screenCamera = camera;
    this.screenWidth = width;
    this.screenHeight = height;
    if (!this.title) return;
    // вне боя (труп ушёл, камера летит к респавну) заголовок убирается сразу: hide() только запускает затухание,
    // которое идёт в update(), а он вне боя не вызывается — полоски застывали на экране
    if (!this.inBattle) {
      this.title.hideImmediate();
      return;
    }
    this.title.setWeaponStatus(Math.trunc(100 * this.weapon.getStatus()));
    const m = this.tank.getTurretMatrix();
    const screen = this.projectToScreen(m.d, m.h, m.l);
    this.title.update(screen?.x ?? null, screen?.y ?? null);
  }

  /** точка карты -> CSS-пиксели экрана по камере последнего кадра; null — за камерой */
  projectToScreen(x: number, y: number, z: number): { x: number; y: number } | null {
    const camera = this.screenCamera;
    if (!camera) return null;
    // координаты карты (Z вверх) -> Three.js (Y вверх)
    const p = this.titlePosition.set(x, z, -y).project(camera);
    if (p.z > 1 || p.z < -1) return null;
    return { x: ((p.x + 1) / 2) * this.screenWidth, y: ((1 - p.y) / 2) * this.screenHeight };
  }

  /** позиция камеры в координатах карты */
  getCameraPosition(): Vector3 {
    return this.gameCamera.position;
  }

  get soundListener(): SoundListener {
    return this.listener;
  }

  /** Камера Alternativa3D смотрит вдоль своей оси +Z, верх экрана — ось -Y; мир Z-вверх -> Three.js Y-вверх */
  private applyCamera(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const p = this.gameCamera.position;
    const r = this.gameCamera.rotation;
    this.cameraEuler.set(r.x, r.y, r.z, 'ZYX');
    this.cameraMatrix.makeRotationFromEuler(this.cameraEuler);
    const e = this.cameraMatrix.elements;
    // столбцы: 0..2 — ось X, 4..6 — ось Y, 8..10 — ось Z
    forward.set(e[8], e[10], -e[9]);
    up.set(-e[4], -e[6], e[5]);
    camera.position.set(p.x, p.z, -p.y);
    camera.up.copy(up);
    target.copy(camera.position).add(forward);
    camera.lookAt(target);
    // Шафт в прицеле сужает поле зрения (ShaftModel.zoom)
    let diagonalFov=getCameraFov(width,height);
    if(this.weapon instanceof ShaftWeapon && this.weapon.isAiming){
      if(!this.scopeCaptured){this.scopeStartPosition.copy(camera.position);this.scopeStartRotation.copy(camera.quaternion);this.scopeCaptured=true;}
      this.weapon.getScopeCameraParams(this.scopeParams);
      const p=this.scopeParams.barrelOrigin,d=this.scopeParams.direction,axis=this.scopeParams.elevationAxis;
      const at=new THREE.Vector3(p.x,p.z,-p.y),dir=new THREE.Vector3(d.x,d.z,-d.y);
      const right=new THREE.Vector3(axis.x,axis.z,-axis.y);
      const up=new THREE.Vector3().crossVectors(right,dir).normalize();
      const scope=new THREE.PerspectiveCamera();scope.position.copy(at);scope.up.copy(up);scope.lookAt(at.clone().add(dir));
      const transition=this.weapon.getAimZoom();
      camera.position.lerpVectors(this.scopeStartPosition,at,transition);
      camera.quaternion.slerpQuaternions(this.scopeStartRotation,scope.quaternion,transition);
      diagonalFov+=(this.weapon.scopeFov-diagonalFov)*transition;
      this.scopeWasPostShot=this.weapon.isPostShotPause;
      this.scopeLastPosition.copy(camera.position);this.scopeLastRotation.copy(camera.quaternion);this.scopeLastFov=diagonalFov;
    }else if(this.scopeReturnAt>=0){
      const t=Math.min(1,Math.max(0,(performance.now()-this.scopeReturnAt)/450)),weight=t*t*(3-2*t);
      if(!this.inBattle||this.tank.health<=0||t>=1)this.scopeReturnAt=-1;
      else{
        camera.position.lerpVectors(this.scopeLastPosition,camera.position,weight);
        camera.quaternion.slerpQuaternions(this.scopeLastRotation,camera.quaternion,weight);
        diagonalFov=this.scopeLastFov+(diagonalFov-this.scopeLastFov)*weight;
      }
    }
    const fov = verticalFovDegrees(diagonalFov,width,height);
    if (Math.abs(camera.fov - fov) > 0.01 || camera.near != 40) {
      camera.fov = fov;
      camera.near = 40;
      camera.far = 200000;
      camera.updateProjectionMatrix();
    }
  }

  respawn(map: ServerMap): void {
    this.spawn(map);
  }
}

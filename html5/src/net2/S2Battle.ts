import {appearanceMedia,type AppearanceStyle} from './appearance.ts';
import {S2Flags} from './S2Flags.ts';
import type {CtfFlag,BattleMode} from './protocol.ts';
import {RayHit} from '../physics/collision/types.ts';
import {DamageNumbers} from '../ui/hud/DamageNumbers.ts';
import {Sound3D, Sound3DEffect, type Sound, type SoundChannel} from '../tanks/sfx/Sound.ts';
import {BattleKillFeed} from '../ui/hud/BattleKillFeed.ts';
import { ISIDA_DEFAULT } from './isida.ts';
/**
 * Бой на server2 (протокол v2): то же, что NetBattle для старого протокола, но поверх JSON-событий battle.* и
 * двоичных кадров battleCodec. Свой танк шлёт состояние 20 раз в секунду (и сразу при смене управления, перед
 * выстрелом), чужие танки рисуются по снапшотам через буфер интерполяции с общей задержкой; попадания уходят с
 * viewTime — серверным временем, на которое стоят чужие танки у стрелка (компенсация лага на сервере).
 */
import type * as THREE from 'three';
import { Matrix3 } from '../physics/math/Matrix3.ts';
import { Vector3 } from '../physics/math/Vector3.ts';
import type { Body } from '../physics/Body.ts';
import { TitleConfigFlags, UserTitle, loadProgressBarSkins, type ProgressBarSkins } from '../tanks/display/UserTitle.ts';
import { RemoteTank } from '../tanks/net/RemoteTank.ts';
import type { BattleStatsView, SuicideIndicatorView } from '../tanks/net/NetBattle.ts';
import { ServerClock } from '../tanks/net/sync/ServerClock.ts';
import { InterpolationDelay, StateBuffer } from '../tanks/net/sync/StateBuffer.ts';
import { isValidSample, type SyncSample } from '../tanks/net/sync/SyncProtocol.ts';
import type { TankSkin } from '../tanks/render/TankSkin.ts';
import { RailgunEffects } from '../tanks/sfx/RailgunEffects.ts';
import { SmokyEffects } from '../tanks/sfx/SmokyEffects.ts';
import { TwinsEffects } from '../tanks/sfx/TwinsEffects.ts';
import { ThunderEffects } from '../tanks/sfx/ThunderEffects.ts';
import { ShaftEffects } from '../tanks/sfx/ShaftEffects.ts';
import { RicochetEffects } from '../tanks/sfx/RicochetEffects.ts';
import { StreamEffectFactory, type StreamKind } from '../tanks/sfx/StreamEffects.ts';
import type { Tank } from '../tanks/tank/Tank.ts';
import type { TankDemo } from '../tanks/TankDemo.ts';
import { RemoteRailgunWeapon, type RailgunShotListener } from '../tanks/weapon/RailgunWeapon.ts';
import { WEAPON_FORCE_SCALE, WeaponForces, type WeaponShotListener } from '../tanks/weapon/SmokyWeapon.ts';
import { DistanceWeakening, PlasmaGunData, RemoteTwinsWeapon, type TwinsShotListener } from '../tanks/weapon/TwinsWeapon.ts';
import { RemoteShaftWeapon, ShaftData, type ShaftShotListener } from '../tanks/weapon/ShaftWeapon.ts';
import { RemoteStreamWeapon, StreamData, type StreamShotListener } from '../tanks/weapon/StreamWeapon.ts';
import { RemoteRicochetWeapon, RicochetData, type RicochetShotListener } from '../tanks/weapon/RicochetWeapon.ts';
import { STAT_TEAM, type StatRow } from '../ui/hud/BattleStats.ts';
import { FRAME, decodeFrame, encodePing, encodeState } from './battleCodec.ts';
import type { Connection } from './Connection.ts';
import { S2Bonuses } from './S2Bonuses.ts';
import type { BonusRegionMarks } from '../map/bonusRegions.ts';
import { S2Inventory, type InventoryPanel } from './S2Inventory.ts';
import { S2Mines } from './S2Mines.ts';
import { TEAM, type BattleInfo, type BattlePlayer, type BattleTeam, type EffectIndex, type EventMessage, type EventName, type RequestArgs, type RequestName, type ShotHit, type ShotResult, type Vec3, type WeaponInfo } from './protocol.ts';

/** состояние своего танка 20 раз в секунду; по смене управления — сразу, но не чаще раза в 30 мс */
const STATE_INTERVAL_MS = 50;
const MIN_STATE_INTERVAL_MS = 30;
/** снапшоты идут (последний не старше), а живого танка в них нет дольше MISSING_HIDE_MS — он не на поле */
const SNAPSHOT_STALE_MS = 500;
const MISSING_HIDE_MS = 2000;
const SERVER_SILENCE_MS = 12000;
/** череп самоуничтожения показывается на секунду дольше задержки сервера (TankModel) */
const SUICIDE_INDICATOR_EXTRA_MS = 1000;
/** BattleUtils.toClientScale */
const CLIENT_SCALE = 100;

const toLocalEuler = new Vector3();
const toLocalMatrix = new Matrix3();

/** BattleUtils.globalToLocal: точка в системе корпуса */
function globalToLocal(body: Body, point: Vector3): Vec3 {
  body.state.orientation.getEulerAngles(toLocalEuler);
  toLocalMatrix.setRotationMatrix(toLocalEuler.x, toLocalEuler.y, toLocalEuler.z);
  const result = new Vector3();
  result.diff(point, body.state.position);
  toLocalMatrix.transformVectorInverse(result, result);
  return { x: result.x, y: result.y, z: result.z };
}

/** BattleUtils.localToGlobal */
function localToGlobal(body: Body, point: Vec3): Vector3 {
  body.state.orientation.getEulerAngles(toLocalEuler);
  toLocalMatrix.setRotationMatrix(toLocalEuler.x, toLocalEuler.y, toLocalEuler.z);
  const result = new Vector3(point.x, point.y, point.z);
  toLocalMatrix.transformVector(result, result);
  return result.add(body.state.position);
}

const vec = (v: Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const vector3 = (v: Vec3): Vector3 => new Vector3(v.x, v.y, v.z);

function statTeam(team: BattleTeam): number {
  return team == TEAM.RED ? STAT_TEAM.RED : team == TEAM.BLUE ? STAT_TEAM.BLUE : STAT_TEAM.NONE;
}

/** TwinsModel.objectLoaded: PlasmaGunData в клиентском масштабе */
function twinsGunData(weapon: WeaponInfo): PlasmaGunData {
  const gun = new PlasmaGunData();
  if (weapon.twins?.distance) gun.shotRange = weapon.twins.distance * CLIENT_SCALE;
  if (weapon.twins?.speed) gun.shotSpeed = weapon.twins.speed * CLIENT_SCALE;
  if (weapon.twins?.shotRadius != null) gun.shotRadius = weapon.twins.shotRadius * CLIENT_SCALE;
  return gun;
}

/** WeaponWeakeningModel.getDistanceWeakening */
function weakeningData(weapon: WeaponInfo): DistanceWeakening {
  return new DistanceWeakening(weapon.maxDamageRadius * CLIENT_SCALE, (weapon.minDamageRadius || 0.01) * CLIENT_SCALE, Math.min(100, weapon.minDamagePercent));
}

/** ShaftCC + ShaftShotCC: энергия, расход и пауза после прицельного выстрела */
function shaftData(weapon: WeaponInfo): ShaftData {
  const shaft = weapon.shaft;
  if (!shaft) return new ShaftData();
  return new ShaftData(shaft.maxEnergy, shaft.chargeRate, shaft.dischargeRate, shaft.fastShotEnergy, shaft.afterShotPauseMs, shaft.weakeningCoeff,shaft.targetingTransitionMs,shaft.initialFov,shaft.minimumFov,shaft.verticalSpeed,shaft.horizontalSpeed);
}

/** StreamWeaponCC: тик, энергия, восстановление, конус и дальность */
function streamData(weapon: WeaponInfo, kind: StreamKind): StreamData {
  const stream = weapon.stream;
  if (!stream) return new StreamData(kind);
  return new StreamData(kind, stream.tickMs, stream.energyCapacity, stream.dischargeRate, stream.rechargeMs, stream.coneAngle, stream.range);
}

/** RicochetCC: скорость, дальность пути, радиус шара и энергия */
function ricochetData(weapon: WeaponInfo): RicochetData {
  const data = new RicochetData();
  if (weapon.ricochet) {
    data.speed = weapon.ricochet.speed;
    data.range = weapon.ricochet.range;
    data.shotRadius = weapon.ricochet.shotRadius;
    data.energyCapacity = weapon.ricochet.energyCapacity;
    data.energyPerShot = weapon.ricochet.energyPerShot;
    data.energyRecharge = weapon.ricochet.energyRecharge;
    data.maxBounces = weapon.ricochet.maxBounces ?? data.maxBounces;
  }
  return data;
}

function isStreamKind(kind: string | null): kind is StreamKind {
  return kind == 'firebird' || kind == 'freeze' || kind == 'isida';
}

/** поля HUD, которые ведёт бой: таймер раунда, фонд (BattleHud.setTimeLimit/stopTime/setFund), инвентарь и сообщения */
export interface S2BattleHud extends InventoryPanel {
  setTime(seconds: number): void;
  stopTime(): void;
  setFund(fund: number): void;
  /** сообщение по центру сверху на ms миллисекунд (золотой ящик) */
  notice(text: string, ms?: number,color?:string): void;
  setTeamScore?(mode:BattleMode,scores:[number,number],flags:CtfFlag[]):void;
}

interface RemoteEntry {
  player: BattlePlayer;
  tank: RemoteTank | null;
  /** что сделать с танком, когда загрузится скин */
  queue: ((tank: RemoteTank) => void)[];
  railgun: RemoteRailgunWeapon | null;
  twins: RemoteTwinsWeapon | null;
  shaft: RemoteShaftWeapon | null;
  stream: RemoteStreamWeapon | null;
  ricochet: RemoteRicochetWeapon | null;
  buffer: StateBuffer;
  /** последняя известная жизнь; сэмплы прошлых жизней и жизни, в которой танк уничтожен, отбрасываются */
  life: number;
  deadLife: number;
  /** когда танк последний раз был в снапшоте (performance.now), 0 — в этой жизни не был */
  lastSeen: number;
  /** загруженный скин и заголовок живут дольше танка: между раундами танк снимается с поля и создаётся заново */
  skin: TankSkin | null;
  title: UserTitle | null;
  /** оружие чужих эффектов создаётся один раз на игрока, а не на каждую жизнь */
  weaponReady: boolean;
  /** нитро чужого танка: множитель характеристик (SET_SPECIFICATION), переживает смену танка в новом раунде */
  speedFactor: number;
  smokyEffects?:SmokyEffects;
}

export class S2Battle {
  private readonly remotes = new Map<number, RemoteEntry>();
  private readonly offEvents: (() => void)[] = [];
  private readonly clock: ServerClock;
  private lastPongAt = performance.now();
  private lastUpdateAt = this.lastPongAt;
  private readonly onOffline = (): void => this.connection.close();
  private readonly delay = new InterpolationDelay();
  private readonly statRows = new Map<number, StatRow>();
  private flags:S2Flags|null=null;
  private flagState:CtfFlag[]=[];
  private readonly dropFlagKey=(event:KeyboardEvent):void=>{const t=event.target as HTMLElement|null;if(event.code!=='KeyF'||event.repeat||t?.closest('input,textarea,[contenteditable="true"]')||!this.activated||!this.demo.chassisController.isEnabled())return;event.preventDefault();this.request('battle.dropFlag',{});};
  private refreshTeamHud():void {this.hud?.setTeamScore?.(this.info.battle.mode,this.teamScores,this.flagState);}
  private teamScores: [number, number];
  private readonly damageNumbers=new DamageNumbers();
  private goldSound:Promise<Sound>|null=null;
  private readonly repairSound: Promise<Sound>;
  private goldChannel:SoundChannel|null=null;
  private goldNoticeToken=0;
  private readonly killFeed=new BattleKillFeed();
  private localTeam: BattleTeam;
  private readonly weapon: WeaponInfo;
  /** ящики на поле: отрисовка общая с BonusManager (BonusField), подбор — запросом battle.takeBonus */
  private readonly bonuses: S2Bonuses;
  /** инвентарь боя: клавиши 1–5, счётчики из гаража, перезарядка по ответу сервера */
  private readonly inventory: S2Inventory;
  /** мины на поле: отрисовка MineField, события battle.mine* */
  private readonly mines: S2Mines;
  private titleSkins: Promise<ProgressBarSkins> | null = null;
  private skins: ProgressBarSkins | null = null;
  private smokyEffects: SmokyEffects | null = null;
  private readonly twinsEffectsByStyle=new Map<string,Promise<TwinsEffects>>();
  private readonly smokyEffectsByStyle=new Map<string,Promise<SmokyEffects>>();
  /** эффекты новых пушек: свои загружает TankDemo, для чужих — общая копия на бой */
  private thunderEffectsByMod=new Map<string,ThunderEffects>();
  private thunderEffectsLoading=new Map<string,Promise<ThunderEffects>>();
  private shaftEffectsLoading=new Map<string,Promise<ShaftEffects>>();
  /** эффекты Рикошета по модификации пушки: у m0–m3 свои текстуры */
  private readonly ricochetEffectsByMod = new Map<string, Promise<RicochetEffects>>();
  private readonly streamFactories = new Map<string, Promise<StreamEffectFactory>>();
  private spawned = false;
  private activated = false;
  private stopped = false;
  private suicideRequested = false;
  private activationTimer: ReturnType<typeof setTimeout> | null = null;
  private localLife = 0;
  private syncSeq = 0;
  private nextStateAt = 0;
  private lastStateSentAt = 0;
  private controlChangePending = false;
  private lastSnapshotAt = 0;
  /** серверное время отрисовки чужих танков для локального времени физики */
  private readonly renderTime = (physicsTime: number): number => this.clock.toServer(physicsTime) - this.delay.current;

  constructor(
    private readonly connection: Connection,
    private readonly info: BattleInfo,
    private readonly localId: number,
    private readonly demo: TankDemo,
    private readonly world: THREE.Object3D,
    private readonly loadSkin: (parts: BattlePlayer['parts']) => Promise<TankSkin>,
    private readonly log: (message: string) => void = () => undefined,
    private readonly stats: BattleStatsView | null = null,
    private readonly suicideIndicator: SuicideIndicatorView | null = null,
    /** бой закрыт сервером (удалён) */
    private readonly onClosed: () => void = () => undefined,
    /** таймер и фонд в HUD (вход в идущий бой, конец раунда, новый раунд) */
    private readonly hud: S2BattleHud | null = null,
    bonusRegionMarks: BonusRegionMarks | null = null,
  ) {
    this.goldSound=demo.soundManager.engine.load('battle/sounds/gold.mp3');
    this.repairSound = demo.soundManager.engine.load('battle/sounds/repair_kit.mp3');
    const local = info.players.find((player) => player.userId == localId);
    if (!local) throw new Error('в бою нет своего танка');
    demo.tank.maxHealth = local.maxHealth;
    this.localTeam = local.team;
    this.weapon = local.weapon;
    this.teamScores = [...info.teamScores];
    demo.setTeam(local.team);
    demo.setShotListener(this.shotListener);
    if(this.weapon.kind==='thunder')demo.setThunderImpactListener((point,excluded)=>{
      const coefficient=this.thunderDistanceFactor(this.weapon,point,demo.tank.getBody().state.position);
      this.applyThunderSplash(point,excluded,this.weapon,demo.weaponForces.getImpactForce(),coefficient);return coefficient;
    });
    demo.setRailgunListener(this.railgunListener);
    demo.setTwinsListener(this.twinsListener);
    demo.setShaftListener(this.shaftListener);
    demo.setStreamListener(this.streamListener);
    demo.setRicochetListener(this.ricochetListener);
    demo.configureTwins(twinsGunData(this.weapon), weakeningData(this.weapon));
    demo.configureReload(this.weapon.reloadMs);
    if (this.weapon.kind == 'railgun') demo.configureRailgun(this.weapon.chargingMs, this.weapon.weakeningCoeff);
    if (this.weapon.kind == 'shaft') demo.configureShaft(shaftData(this.weapon));
    if (isStreamKind(this.weapon.kind)) demo.configureStream(streamData(this.weapon, this.weapon.kind));
    if (this.weapon.kind === 'isida') demo.configureIsida(this.weapon.isida?.config ?? ISIDA_DEFAULT);
    if (this.weapon.kind == 'ricochet') demo.configureRicochet(ricochetData(this.weapon));
    if (this.weapon.autoAimUp || this.weapon.autoAimDown) demo.setAutoAimAngles(this.weapon.autoAimUp, this.weapon.autoAimDown);

    // свой танк ждёт спавна: шасси заблокировано, оружие выключено
    demo.chassisController.lock(1);
    demo.netChassisListener = { onChassisControlChanged: () => this.onControlChanged() };
    demo.netTurretListener = { onTurretControlChanged: () => this.onControlChanged() };

    this.clock = new ServerClock((pingId, clientMs) => connection.sendBinary(encodePing(pingId, clientMs)));
    connection.onBinary = (data) => this.onFrame(data);
    // ящики берёт только живой активный танк (группа BONUS_WITH_TANK); звук подбора — общий AudioEngine
    this.bonuses = new S2Bonuses(
      world,
      demo.runner.getCollisionDetector(),
      () => (this.spawned && this.activated ? this.demo.tank.getBody() : null),
      info.bonusFallSpeed,
      (bonusId) => this.request('battle.takeBonus', { bonusId }),
      demo.soundManager,
      bonusRegionMarks,
      info.mapKey === '2042' || info.mapKey === 'sandbox',
    );
    for (const bonus of info.bonuses) this.bonuses.spawn(bonus);
    // инвентарь: слоты появляются из BattleInfo, применение — battle.activateItem (ответ — battle.inventory)
    this.inventory = new S2Inventory(connection, info.inventory, hud, (index) => this.request('battle.activateItem', { index }));
    this.mines = new S2Mines(world, demo.effectsScene, demo.soundManager, localId, () => this.localTeam, info.mines);
    this.subscribe();
    window.addEventListener('offline', this.onOffline);

    if(info.battle.mode==='ctf'){
      this.flags=new S2Flags(world,localId,demo.soundManager);this.flagState=info.flags??[];this.flags.set(this.flagState);window.addEventListener('keydown',this.dropFlagKey);
      void connection.request('battle.flags',{}).then(({flags})=>{if(!this.stopped){this.flagState=flags;this.flags?.set(flags);this.refreshTeamHud();}});
    }
    stats?.setExternalTeamScore?.(true);
    this.refreshTeamHud();
    stats?.setEnabled(true, localId);
    stats?.setTeamScores(...this.teamScores);
    for (const player of info.players) {
      this.setStatRow(player);
      if (player.userId != localId) this.addRemote(player);
    }
    this.publishStats();
    this.hud?.setFund(info.fund);
    // вход во время экрана итогов: таблица с отсчётом до нового раунда, таймер стоит
    if (info.roundEndInSec != null) {
      this.stats?.showFinish(info.roundEndInSec, new Map());
      this.hud?.stopTime();
    } else {
      this.hud?.setTime(info.timeLeftSec);
    }
    SmokyEffects.load(appearanceMedia('gen2'), demo.soundManager, demo.effectsScene)
      .then((effects) => (this.smokyEffects = effects))
      .catch((error: unknown) => this.log(`бой: эффекты Смоки не загружены: ${String(error)}`));
    this.request('battle.ready', {});
    this.resyncBonuses();
    this.resyncMines();
    void this.connection.request('battle.effects', {}).then(({ effects }) => {
      if (this.stopped) return;
      for (const { userId, effect, leftMs } of effects) this.setEffectIndicator(userId, effect, leftMs);
    }).catch((error: unknown) => {
      if (!this.stopped) this.log(`бой: battle.effects — ${String(error)}`);
    });
  }

  /** сверка ящиков: за время загрузки карты события о ящиках могли пройти мимо */
  private resyncBonuses(): void {
    this.connection.request('battle.bonuses', {}).then(
      ({ bonuses }) => !this.stopped && this.bonuses.reset(bonuses),
      (error: unknown) => this.log(`бой: battle.bonuses — ${String(error)}`),
    );
  }

  /** сверка мин после загрузки карты */
  private resyncMines(): void {
    this.connection.request('battle.mines', {}).then(
      ({ mines }) => !this.stopped && this.mines.reset(mines),
      (error: unknown) => this.log(`бой: battle.mines — ${String(error)}`),
    );
  }

  /** запрос без ожидания: ошибка — в журнал (бой продолжается) */
  private request<K extends RequestName>(type: K, args: RequestArgs<K>): void {
    if (this.stopped) return;
    this.connection.request(type, args).catch((error: unknown) => this.log(`бой: ${type} — ${String(error)}`));
  }

  private on<K extends EventName>(type: K, handler: (message: EventMessage<K>) => void): void {
    this.offEvents.push(this.connection.on(type, (message) => !this.stopped && handler(message)));
  }

  stop(): void {
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('keydown',this.dropFlagKey);this.flags?.stop();this.flags=null;this.hud?.setTeamScore?.('dm',[0,0],[]);
    this.goldNoticeToken++;this.goldChannel?.stop();this.goldChannel=null;
    this.damageNumbers.dispose();
    this.killFeed.dispose();
    this.stopped = true;
    this.stats?.setEnabled(false);
    this.suicideIndicator?.hide();
    this.bonuses.stop();
    this.inventory.stop();
    this.mines.stop();
    for (const off of this.offEvents) off();
    this.offEvents.length = 0;
    this.connection.onBinary = null;
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.demo.netChassisListener = null;
    this.demo.netTurretListener = null;
    this.demo.setThunderImpactListener(null);
    this.demo.setShotListener(null);
    this.demo.setRailgunListener(null);
    this.demo.setTwinsListener(null);
    this.demo.setShaftListener(null);
    this.demo.setStreamListener(null);
    this.demo.setRicochetListener(null);
    for (const entry of this.remotes.values()) {
      entry.railgun?.stopEffects();
      entry.stream?.stop();
      entry.shaft?.stopAim();
      entry.ricochet?.stopEffects();
      entry.tank?.dispose();
    }
    this.remotes.clear();
  }

  /** самоуничтожение (Delete): один раз за жизнь, у активного танка с незаблокированным управлением */
  requestSuicide(): void {
    if (this.suicideRequested || !this.spawned || !this.activated || !this.demo.chassisController.isEnabled()) return;
    this.suicideRequested = true;
    this.request('battle.suicide', {});
  }

  /** каждый кадр после шага физики: часы, отправка состояния, кто на поле, отрисовка чужих танков */
  update(): void {
    this.damageNumbers.update((x,y,z)=>this.demo.projectToScreen(x,y,z));
    const now = performance.now();
    // A backgrounded or suspended tab may not have sent pings during the gap.
    if (now - this.lastUpdateAt > 2000) this.lastPongAt = now;
    this.lastUpdateAt = now;
    if (now - this.lastPongAt > SERVER_SILENCE_MS) {
      this.connection.close();
      return;
    }
    this.clock.update(now);
    this.delay.update(now);
    this.updateSending(now);
    this.hideMissingTanks(now);
    this.bonuses.update();
    this.flags?.update(id=>{
      const tank=id===this.localId?(this.spawned?this.demo.tank:null):this.remotes.get(id)?.tank?.tank;
      if(!tank)return null;const pos=new Vector3();tank.skin.turretMatrix.transformVector(tank.skin.turret.flagMountPoint,pos);pos.z-=50;return pos;
    });
    this.inventory.update(now);
    const camera = this.demo.getCameraPosition();
    const project = (x: number, y: number, z: number): { x: number; y: number } | null => this.demo.projectToScreen(x, y, z);
    for (const entry of this.remotes.values()) {
      entry.tank?.render();
      entry.tank?.updateSound(now, this.demo.soundListener);
      entry.tank?.updateTitle(camera, project, now);
      if (entry.stream?.isActive) {
        if (entry.tank?.isVisible) entry.stream.aim(entry.tank.tank);
        else entry.stream.stop();
      }
    }
  }

  get remoteCount(): number {
    return this.remotes.size;
  }

  activateInventorySlot(index: number): void {
    this.inventory.activateSlot(index);
  }

  setInventoryGuiLocked(locked: boolean): void {
    this.inventory.setGuiLocked(locked);
  }

  // ------------------------------------------------------------ события боя

  private subscribe(): void {
    this.on('battle.player', ({ player }) => {
      this.setStatRow(player);
      this.publishStats();
      if (player.userId != this.localId && !this.remotes.has(player.userId)) this.addRemote(player);
    });
    this.on('battle.playerLeft', ({ userId }) => {
      if (this.statRows.delete(userId)) this.publishStats();
      const entry = this.remotes.get(userId);
      if (!entry) return;
      entry.railgun?.stopEffects();
      entry.stream?.stop();
      entry.shaft?.stopAim();
      entry.ricochet?.stopEffects();
      this.withRemote(entry, (tank) => tank.dispose());
      this.remotes.delete(userId);
      this.log(`бой: ${entry.player.name} вышел`);
    });
    this.on('battle.prepare', ({ position, orientation }) => this.demo.prepareToSpawn(vector3(position), vector3(orientation)));
    this.on('battle.spawn', (message) => (message.userId == this.localId ? this.onLocalSpawn(message) : this.onRemoteSpawn(message)));
    this.on('battle.activate', ({ userId, life }) => {
      if (userId == this.localId) {
        if (life != this.localLife || !this.spawned) return;
        this.activated = true;
        this.inventory.setLocked(false);
        this.demo.activateFromServer();
        return;
      }
      const entry = this.remotes.get(userId);
      if (entry && life >= entry.life) this.withRemote(entry, (tank) => tank.activate());
    });
    this.on('battle.damage',message=>this.damageNumbers.add(message.position,message.amount,message.type));
    this.on('battle.health', ({ userId, life, health }) => this.applyHealth(userId, life, health));
    this.on('battle.kill', message=>{
      const victim=this.info.players.find(p=>p.userId===message.userId)??this.remotes.get(message.userId)?.player;
      const killer=this.info.players.find(p=>p.userId===message.killerId)??this.remotes.get(message.killerId??-1)?.player;
      const user=(p:BattlePlayer)=>({id:p.userId,name:p.name,rank:p.rank,team:p.team===TEAM.RED?'red' as const:p.team===TEAM.BLUE?'blue' as const:'none' as const});
      if(victim)this.killFeed.add({victim:user(victim),killer:killer?user(killer):null,weapon:message.weapon??killer?.weapon.kind??null,key:`${message.userId}:${message.life}`});
      if(message.userId===this.localId)this.onLocalKill(message.respawnDelayMs);else this.onRemoteKill(message.userId,message.life,message.respawnDelayMs);
    });
    this.on('battle.stat', ({ userId, kills, deaths, score }) => {
      const row = this.statRows.get(userId);
      if (!row) return;
      Object.assign(row, { kills, deaths, score });
      this.publishStats();
    });
    this.on('battle.teamScore', ({ scores }) => {
      this.teamScores = [...scores];
      this.stats?.setTeamScores(...this.teamScores);
      this.refreshTeamHud();
    });
    this.on('battle.suicideStarted', ({ delayMs }) => this.suicideIndicator?.show(delayMs + SUICIDE_INDICATOR_EXTRA_MS));
    this.on('battle.smoky', (message) => this.onRemoteSmoky(message));
    this.on('battle.railCharge', ({ shooterId }) => {
      const shooter = this.remotes.get(shooterId);
      if (shooter?.railgun && shooter.tank?.isVisible) shooter.railgun.startCharging(shooter.tank.tank);
    });
    this.on('battle.rail', (message) => this.onRemoteRail(message));
    this.on('battle.twins', ({ shooterId, barrel, shotId, direction }) => {
      const shooter = this.remotes.get(shooterId);
      if (shooter?.twins && shooter.tank?.isVisible) shooter.twins.fire(shooter.tank.tank, barrel, shotId, vector3(direction));
    });
    this.on('battle.thunder', (message) => this.onRemoteThunder(message));
    this.on('battle.ricochet', ({ shooterId, shotId, direction }) => {
      const shooter = this.remotes.get(shooterId);
      if (shooter?.ricochet && shooter.tank?.isVisible) shooter.ricochet.fire(shooter.tank.tank, shotId, vector3(direction));
    });
    this.on('battle.ricochetHit', (message) => this.onRemoteRicochetHit(message));
    this.on('battle.shaftAim', ({ shooterId, active }) => {
      const shooter = this.remotes.get(shooterId);
      if (shooter?.shaft && shooter.tank?.isVisible) shooter.shaft.aim(shooter.tank.tank, active);
    });
    this.on('battle.shaft', (message) => this.onRemoteShaft(message));
    this.on('battle.stream', (message) => this.onRemoteStream(message));
    this.on('battle.bonusSpawned', ({ bonus }) => this.bonuses.spawn(bonus));
    this.on('battle.bonusTaken', ({ bonusId }) => this.bonuses.take(bonusId));
    this.on('battle.bonusesRemoved', ({ bonusIds }) => this.bonuses.remove(bonusIds));
    this.on('battle.minePlaced', ({ mine }) => this.mines.spawn(mine));
    this.on('battle.mineActivated', ({ mineId }) => this.mines.activated(mineId));
    this.on('battle.mineExploded', ({ mineId }) => this.mines.exploded(mineId));
    this.on('battle.minesRemoved', ({ mineIds }) => this.mines.remove(mineIds));
    this.on('battle.effect', ({ userId, effect, leftMs, position }) => {
      this.setEffectIndicator(userId, effect, leftMs);
      if (position) void this.repairSound.then(sound => {
        if (this.stopped) return;
        this.demo.soundManager.addEffect(new Sound3DEffect(vector3(position), new Sound3D(sound, 1000, 5000, 5, 1)));
      });
    });
    this.on('battle.spec', ({ userId, speedFactor, temperature }) => {
      this.setSpeedFactor(userId, speedFactor);
      const tank = userId === this.localId ? this.demo.tank : this.remotes.get(userId)?.tank?.tank;
      if (tank && temperature != null) tank.temperature = temperature;
    });
    // золото: сообщение всем, через delaySec падает ящик (gold_notification_message старого сервера — в протоколе;
    // в html5-клиенте своего окна уведомления нет, показываем понятную строку)
    this.on('battle.goldNotify', () => {
      this.hud?.notice('Скоро будет сброшен золотой ящик');
      const token=++this.goldNoticeToken;
      if(!this.info.battle.withoutGoldSiren)void this.goldSound?.then(sound=>{if(!this.stopped&&token===this.goldNoticeToken){this.goldChannel?.stop();this.goldChannel=sound.play();}});
    });
    this.on('battle.flags',message=>{
      this.flagState=message.flags;this.flags?.set(message.flags,message.action);this.refreshTeamHud();
      if(message.action){
        const ours=message.flagTeam===this.localTeam,name=message.name??'',verb={taken:'подобрал',dropped:'потерял',returned:'вернул',captured:'доставил'}[message.action];
        const text=name?`${name} ${verb} ${ours?'наш':'вражеский'} флаг`:`${ours?'Наш':'Вражеский'} флаг возвращён на базу`;
        const positive=message.action==='returned'?ours:message.action==='dropped'?ours:!ours;
        this.hud?.notice(text,undefined,positive?'#00ff00':'#ffff00');
        const row=message.userId==null?null:this.statRows.get(message.userId);
        if(row){const red=row.team===STAT_TEAM.RED,team=red?'Red':'Blue',flag=message.flagTeam===0?'Red':'Blue';
          const action={taken:'Pick',dropped:'Drop',returned:'Bringback',captured:'Deliver'}[message.action];
          this.killFeed.add({victim:{id:row.userId,name:row.name,rank:row.rank,team:red?'red':'blue'},killer:null,weapon:null,actionIcon:`ctf/ctf${team}Player${action}${flag}flagIcon`});
        }
      }
    });
    this.on('battle.goldTaken' , ({ name, crystals }) => this.hud?.notice(`${name} забрал золотой ящик: +${crystals}`, 6000));
    this.on('battle.fund', ({ fund }) => this.hud?.setFund(fund));
    this.on('battle.roundEnd', (message) => this.onRoundEnd(message));
    this.on('battle.restart', () => this.onRoundRestart());
    this.on('battle.roundStart', (message) => this.onRoundStart(message));
    this.on('battle.closed', () => this.onClosed());
  }

  /** StatisticsModel.roundFinish: управление и оружие запираются, итоги с наградой, таймер стоит на нуле */
  private onRoundEnd(message: EventMessage<'battle.roundEnd'>): void {
    this.spawned = false;
    this.activated = false;
    this.suicideRequested = false;
    this.inventory.setLocked(true);
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = null;
    this.suicideIndicator?.hide();
    for (const result of message.results) {
      const row = this.statRows.get(result.userId);
      if (row) Object.assign(row, { kills: result.kills, deaths: result.deaths, score: result.score });
    }
    this.publishStats();
    this.teamScores = [...message.teamScores];
    this.stats?.setTeamScores(...this.teamScores);
      this.refreshTeamHud();
    this.demo.finishBattle();
    this.hud?.stopTime();
    this.hud?.setFund(message.fund);
    this.stats?.showFinish(message.timeToRestartSec, new Map(message.results.map((result) => [result.userId, result.reward])));
    this.log(`бой: конец раунда, фонд ${message.fund}`);
  }

  /** BattleFieldModel.battleRestart: все танки уходят с поля до спавнов нового раунда */
  private onRoundRestart(): void {
    this.goldNoticeToken++;this.goldChannel?.stop();this.goldChannel=null;
    this.damageNumbers.clear();
    this.killFeed.clear();
    this.spawned = false;
    this.activated = false;
    this.suicideRequested = false;
    this.inventory.setLocked(true);
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = null;
    this.suicideIndicator?.hide();
    this.demo.restartBattle();
    this.stats?.hideFinish();
    this.bonuses.removeAll();
    this.mines.removeAll();
    for (const entry of this.remotes.values()) this.clearRemoteTank(entry);
    this.log('бой: танки уходят с поля');
  }

  /** ROUND_START: новые команды, обнулённая статистика, таймер нового раунда, спавн по battle.ready */
  private onRoundStart(message: EventMessage<'battle.roundStart'>): void {
    const teams = new Map(message.teams.map((entry) => [entry.userId, entry.team]));
    const ownTeam = teams.get(this.localId);
    if (ownTeam != null && ownTeam != this.localTeam) {
      this.localTeam = ownTeam;
      this.demo.setTeam(ownTeam);
    }
    for (const entry of this.remotes.values()) {
      const team = teams.get(entry.player.userId);
      if (team == null) continue;
      entry.player.team = team;
      this.applyTeam(entry);
    }
    for (const row of this.statRows.values()) {
      row.kills = 0;
      row.deaths = 0;
      row.score = 0;
      const team = teams.get(row.userId);
      if (team != null) row.team = statTeam(team);
    }
    this.publishStats();
    this.suicideRequested = false;
    this.hud?.setTime(message.timeLeftSec);
    this.request('battle.ready', {});
    this.log(`бой: новый раунд, ${message.timeLeftSec} с`);
  }

  /** танк снимается с поля, но скин и заголовок остаются для спавна нового раунда */
  private clearRemoteTank(entry: RemoteEntry): void {
    entry.railgun?.stopEffects();
    entry.stream?.stop();
      entry.shaft?.stopAim();
    entry.ricochet?.stopEffects();
    const tank = entry.tank;
    entry.tank = null;
    entry.queue.length = 0;
    entry.buffer.clear();
    entry.lastSeen = 0;
    entry.deadLife = -1;
    if (!tank) return;
    tank.title = null;
    tank.dispose();
    entry.title?.hideImmediate();
  }

  private onLocalSpawn(message: EventMessage<'battle.spawn'>): void {
    if (message.team != this.localTeam) {
      this.localTeam = message.team;
      this.demo.setTeam(message.team);
      for (const entry of this.remotes.values()) this.applyTeam(entry);
    }
    this.spawned = true;
    this.activated = false;
    this.suicideRequested = false;
    this.inventory.setLocked(true);
    this.localLife = message.life;
    this.nextStateAt = 0;
    this.demo.spawnFromServer(vector3(message.position), vector3(message.orientation), message.health);
    this.scheduleActivation();
    this.log(`бой: спавн, жизнь ${message.life}, здоровье ${message.health}`);
  }

  /** TankActivationTask: через activationDelayMs, если танк ни во что не упирается — battle.activate */
  private scheduleActivation(): void {
    if (this.activationTimer) clearTimeout(this.activationTimer);
    const life = this.localLife;
    const tryActivate = (): void => {
      this.activationTimer = null;
      if (!this.spawned || life != this.localLife || this.stopped) return;
      if (this.demo.getCollisionCount() == 0) this.request('battle.activate', { life });
      else this.activationTimer = setTimeout(tryActivate, 100);
    };
    this.activationTimer = setTimeout(tryActivate, this.info.activationDelayMs);
  }

  private onLocalKill(respawnDelayMs: number): void {
    this.spawned = false;
    this.activated = false;
    this.inventory.setLocked(true);
    this.suicideIndicator?.hide();
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = null;
    this.demo.killFromServer(respawnDelayMs, () => this.request('battle.ready', {}));
    this.log(`бой: танк уничтожен, спавн через ${respawnDelayMs} мс`);
  }

  private onRemoteSpawn(message: EventMessage<'battle.spawn'>): void {
    const entry = this.remotes.get(message.userId);
    if (!entry) return;
    entry.player.team = message.team;
    entry.life = message.life;
    entry.buffer.clear();
    entry.lastSeen = 0;
    this.applyTeam(entry);
    // после battle.restart танка на поле нет — создаём заново на его скине
    this.attachRemoteTank(entry);
    this.withRemote(entry, (tank) => {
      tank.health = message.health;
      tank.spawnAt(vector3(message.position), vector3(message.orientation), 0, false);
    });
  }

  private onRemoteKill(userId: number, life: number, respawnDelayMs: number): void {
    const entry = this.remotes.get(userId);
    if (!entry) return;
    // сэмплы этой жизни (снапшот мог уйти до смерти) танк на поле уже не возвращают
    entry.deadLife = Math.max(entry.deadLife, life);
    entry.railgun?.stopEffects();
    entry.stream?.stop();
      entry.shaft?.stopAim();
    entry.ricochet?.stopEffects();
    this.withRemote(entry, (tank) => tank.kill(this.demo.explosionEffects, respawnDelayMs));
  }

  private applyHealth(userId: number, life: number, health: number): void {
    if (userId == this.localId) {
      if (life == this.localLife) this.demo.setHealth(health);
      return;
    }
    const entry = this.remotes.get(userId);
    if (entry && life == entry.life) this.withRemote(entry, (tank) => (tank.health = health));
  }

  // ------------------------------------------------------------ таблица игроков, ники, команды

  private setStatRow(player: BattlePlayer): void {
    this.statRows.set(player.userId, { userId: player.userId, name: player.name, rank: player.rank, kills: player.kills, deaths: player.deaths, score: player.score, team: statTeam(player.team) });
  }

  private publishStats(): void {
    this.stats?.setRows([...this.statRows.values()]);
  }

  /** значок эффекта припаса (EffectDescriptionModel): своему танку — TankDemo, чужому — заголовок */
  private setEffectIndicator(userId: number, effect: EffectIndex, leftMs: number | null): void {
    if (userId == this.localId) {
      this.inventory.setEffect(effect, leftMs);
      if (leftMs == null) this.demo.hideEffect(effect);
      else this.demo.showEffect(effect, leftMs);
      return;
    }
    const entry = this.remotes.get(userId);
    if (!entry) return;
    const endsAt = leftMs == null ? null : performance.now() + leftMs;
    if (effect === 3) entry.stream?.setBuffedMode(leftMs != null);
    this.withRemote(entry, (tank) => {
      const remaining = endsAt === null ? 0 : endsAt - performance.now();
      if (effect === 3) tank.tank.weaponBuffed = remaining > 0;
      if (remaining <= 0) tank.title?.hideIndicator(effect);
      else tank.title?.showIndicator(effect, remaining);
    });
  }

  /** нитро (SET_SPECIFICATION): характеристики танка × factor, 1 — возврат к исходным */
  private setSpeedFactor(userId: number, factor: number): void {
    if (userId == this.localId) {
      this.demo.setSpeedFactor(factor);
      return;
    }
    const entry = this.remotes.get(userId);
    if (!entry) return;
    entry.speedFactor = factor;
    this.withRemote(entry, (tank) => tank.setSpeedFactor(factor));
  }

  /** в командном бою ник и полоска цвета команды, у союзников видно HP; союзник — не цель наведения */
  private applyTeam(entry: RemoteEntry): void {
    this.withRemote(entry, (tank) => {
      const team = entry.player.team;
      const ally = team != TEAM.NONE && team == this.localTeam;
      tank.tank.friendly = ally && !this.info.friendlyFire;
      const skins = this.skins;
      const row = this.statRows.get(entry.player.userId);
      if (row) row.team = statTeam(team);
      if (!tank.title || !skins) return;
      tank.title.setSkin(team == TEAM.RED ? skins.red : team == TEAM.BLUE ? skins.blue : skins.dm);
      tank.title.setConfiguration(TitleConfigFlags.LABEL | TitleConfigFlags.EFFECTS | (ally ? TitleConfigFlags.HEALTH : 0));
    });
  }

  private async createTitle(player: BattlePlayer): Promise<UserTitle> {
    this.titleSkins ??= loadProgressBarSkins('battle/usertitle');
    const skins = await this.titleSkins;
    this.skins = skins;
    const title = new UserTitle(document.body, skins, player.maxHealth, true);
    title.setSkin(skins.dm);
    title.setConfiguration(TitleConfigFlags.LABEL | TitleConfigFlags.EFFECTS);
    title.setRank(player.rank);
    title.setLabelText(player.name);
    return title;
  }

  private addRemote(player: BattlePlayer): void {
    const entry: RemoteEntry = {
      player,
      tank: null,
      queue: [],
      railgun: null,
      twins: null,
      shaft: null,
      stream: null,
      ricochet: null,
      buffer: new StateBuffer(),
      life: player.life,
      deadLife: player.state == 'dead' ? player.life : -1,
      lastSeen: 0,
      skin: null,
      title: null,
      weaponReady: false,
      speedFactor: 1,
    };
    this.remotes.set(player.userId, entry);
    Promise.all([this.loadSkin(player.parts), this.createTitle(player)])
      .then(([skin, title]) => {
        if (this.stopped || this.remotes.get(player.userId) != entry) {
          title.dispose();
          return;
        }
        entry.skin = skin;
        entry.title = title;
        this.attachRemoteTank(entry);
        const newest = entry.buffer.newest;
        if (newest && entry.lastSeen > 0 && performance.now() - entry.lastSeen < MISSING_HIDE_MS) {
          // пока грузился скин, танк уже был в снапшотах — появляется там, где он сейчас
          entry.tank?.spawnFromSample(newest, player.state != 'spawned');
        } else if ((player.state == 'spawned' || player.state == 'active') && player.position && player.orientation) {
          entry.tank?.spawnAt(vector3(player.position), vector3(player.orientation), 0, player.state == 'active');
        }
      })
      .catch((error: unknown) => this.log(`бой: не загрузился танк ${player.name}: ${String(error)}`));
  }

  /** RemoteTank на загруженном скине: первый вход в бой и спавн нового раунда после battle.restart */
  private attachRemoteTank(entry: RemoteEntry): void {
    const skin = entry.skin;
    if (!skin || entry.tank) return;
    const tank = new RemoteTank(entry.player.userId, skin, this.world, this.demo.runner, entry.buffer, this.renderTime, this.demo.soundManager.engine);
    tank.serverDrivenBot = entry.player.isBot===true;
    tank.title = entry.title;
    tank.health = entry.player.health;
    tank.tank.maxHealth = entry.player.maxHealth;
    // нитро могло действовать, когда танка не было на поле (раунд, смерть)
    if (entry.speedFactor != 1) tank.setSpeedFactor(entry.speedFactor);
    if (!entry.weaponReady) {
      this.createRemoteWeapon(entry, skin);
      entry.weaponReady = true;
    }
    entry.tank = tank;
    this.applyTeam(entry);
    for (const task of entry.queue) task(tank);
    entry.queue.length = 0;
  }

  /** оружие чужого танка: силы его башни, параметры его пушки, общие эффекты */
  private createRemoteWeapon(entry: RemoteEntry, skin: TankSkin): void {
    const spec = skin.turret.spec;
    const forces = new WeaponForces(spec.impactForce * WEAPON_FORCE_SCALE, spec.kickback * WEAPON_FORCE_SCALE);
    const weapon = entry.player.weapon;
    if (skin.railgunModification != null) {
      RailgunEffects.load(skin.railgunModification, this.demo.soundManager, this.demo.effectsScene,`${appearanceMedia(skin.turretStyle)}/railgun`)
        .then((effects) => {
          if (this.stopped || this.remotes.get(entry.player.userId) != entry) return;
          entry.railgun = new RemoteRailgunWeapon(forces, weapon.chargingMs || 1200, weapon.weakeningCoeff || 0.202, effects);
        })
        .catch((error: unknown) => this.log(`бой: эффекты рельсы не загружены: ${String(error)}`));
    }
    if (skin.isTwins) {
      const twins = new RemoteTwinsWeapon(forces.getRecoilForce(), {
        runner: this.demo.runner,
        effects: null,
        gun: twinsGunData(weapon),
        weakening: weakeningData(weapon),
        impactForce: forces.getImpactForce(),
      });
      entry.twins = twins;
      const key=`${skin.turretStyle}:${skin.turretModification}`;
      let effects=this.twinsEffectsByStyle.get(key);
      if(!effects){effects=TwinsEffects.load(this.demo.soundManager,this.demo.effectsScene,appearanceMedia(skin.turretStyle),skin.turretModification);this.twinsEffectsByStyle.set(key,effects);}
      effects.then((effects) => (twins.ammo.effects = effects)).catch((error: unknown) => this.log(`бой: эффекты Twins не загружены: ${String(error)}`));
    }
    const kind = skin.turretKind;
    if(kind==='smoky'){
      const key=`${skin.turretStyle}:${skin.turretModification}`;let pending=this.smokyEffectsByStyle.get(key);
      if(!pending){pending=SmokyEffects.load(appearanceMedia(skin.turretStyle),this.demo.soundManager,this.demo.effectsScene,skin.turretModification);this.smokyEffectsByStyle.set(key,pending);}
      pending.then(effects=>{if(this.remotes.get(entry.player.userId)===entry)entry.smokyEffects=effects;}).catch(error=>this.log(String(error)));
    }
    if (kind == 'thunder') {
      this.ensureThunderEffects(skin.turretModification,skin.turretStyle).catch((error: unknown) => this.log(`бой: эффекты Грома не загружены: ${String(error)}`));
    } else if (kind == 'shaft') {
      this.ensureShaftEffects(skin.turretModification,skin.turretStyle)
        .then((effects) => {
          if (this.stopped || this.remotes.get(entry.player.userId) != entry) return;
          entry.shaft = new RemoteShaftWeapon(forces.getRecoilForce(), forces.getImpactForce(), weapon.shaft?.weakeningCoeff ?? 0.24, effects);
        })
        .catch((error: unknown) => this.log(`бой: эффекты Шафта не загружены: ${String(error)}`));
    } else if (isStreamKind(kind)) {
      this.ensureStreamFactory(kind, skin.turretModification,skin.turretStyle)
        .then((factory) => {
          if (this.stopped || this.remotes.get(entry.player.userId) != entry) return;
          entry.stream = new RemoteStreamWeapon(factory, this.demo.effectsScene, weapon.stream?.range ?? 20, weapon.stream?.coneAngle ?? 0.7);
          entry.stream.setBuffedMode(entry.tank?.tank.weaponBuffed ?? false);
        })
        .catch((error: unknown) => this.log(`бой: эффекты струи не загружены: ${String(error)}`));
    } else if (kind == 'ricochet') {
      this.ensureRicochetEffects(skin.turretModification,skin.turretStyle)
        .then((effects) => {
          if (this.stopped || this.remotes.get(entry.player.userId) != entry) return;
          entry.ricochet = new RemoteRicochetWeapon(forces.getRecoilForce(), { runner: this.demo.runner, effects, data: ricochetData(weapon), impactForce: forces.getImpactForce() });
        })
        .catch((error: unknown) => this.log(`бой: эффекты Рикошета не загружены: ${String(error)}`));
    }
  }

  /** общие эффекты новых пушек: если своя пушка того же вида — берём уже загруженные TankDemo */
  private ensureThunderEffects(mod=0,style:AppearanceStyle='gen2'):Promise<ThunderEffects>{
    const key=`${style}:${mod}`,own=this.demo.thunderEffects;
    if(own&&this.demo.tank.skin.turretModification===mod&&this.demo.tank.skin.turretStyle===style){this.thunderEffectsByMod.set(key,own);return Promise.resolve(own);}
    let pending=this.thunderEffectsLoading.get(key);
    if(!pending){pending=ThunderEffects.load(appearanceMedia(style),this.demo.soundManager,this.demo.effectsScene,mod).then(effects=>{this.thunderEffectsByMod.set(key,effects);return effects;});this.thunderEffectsLoading.set(key,pending);}
    return pending;
  }
  private ensureShaftEffects(mod=0,style:AppearanceStyle='gen2'):Promise<ShaftEffects>{
    const key=`${style}:${mod}`,own=this.demo.shaftEffects;
    if(own?.modification===mod&&this.demo.tank.skin.turretStyle===style)return Promise.resolve(own);
    let pending=this.shaftEffectsLoading.get(key);if(!pending){pending=ShaftEffects.load(appearanceMedia(style),this.demo.soundManager,this.demo.effectsScene,mod);this.shaftEffectsLoading.set(key,pending);}return pending;
  }
  private ensureRicochetEffects(mod:number,style:AppearanceStyle='gen2'):Promise<RicochetEffects>{
    const key=`${style}:${mod}`,own=this.demo.ricochetEffects;
    if(own?.modification===mod&&this.demo.tank.skin.turretStyle===style)return Promise.resolve(own);
    let pending=this.ricochetEffectsByMod.get(key);if(!pending){pending=RicochetEffects.load(appearanceMedia(style),this.demo.soundManager,this.demo.effectsScene,mod);this.ricochetEffectsByMod.set(key,pending);}return pending;
  }
  private ensureStreamFactory(kind:StreamKind,mod=0,style:AppearanceStyle='gen2'):Promise<StreamEffectFactory>{
    const key=`${style}:${kind}:${mod}`;let pending=this.streamFactories.get(key);
    if(!pending){const own=this.demo.streamEffectFactory;pending=own&&this.demo.streamKind===kind&&this.demo.tank.skin.turretModification===mod&&this.demo.tank.skin.turretStyle===style?Promise.resolve(own):StreamEffectFactory.load(kind,appearanceMedia(style),this.demo.soundManager,mod);this.streamFactories.set(key,pending);}return pending;
  }

  private withRemote(entry: RemoteEntry, task: (tank: RemoteTank) => void): void {
    if (entry.tank) task(entry.tank);
    else entry.queue.push(task);
  }

  // ------------------------------------------------------------ синхронизация: свой танк

  private onControlChanged(): void {
    if (!this.spawned) return;
    if (performance.now() - this.lastStateSentAt >= MIN_STATE_INTERVAL_MS) this.sendState();
    else this.controlChangePending = true;
  }

  private updateSending(now: number): void {
    if (!this.spawned) return;
    if (now >= this.nextStateAt) {
      this.nextStateAt = this.nextStateAt + STATE_INTERVAL_MS > now ? this.nextStateAt + STATE_INTERVAL_MS : now + STATE_INTERVAL_MS;
      this.sendState();
    } else if (this.controlChangePending && now - this.lastStateSentAt >= MIN_STATE_INTERVAL_MS) {
      this.sendState();
    }
  }

  /** состояние тела на время последнего шага физики и серверное время этого шага */
  private sendState(): void {
    if (!this.spawned || !this.clock.isSynced || this.stopped) return;
    const state = this.demo.tank.getBody().state;
    if (!state.isValid()) return;
    this.syncSeq = (this.syncSeq + 1) & 0xffff;
    const sample: SyncSample = {
      seq: this.syncSeq,
      sampleTime: Math.round(this.clock.toServer(this.demo.runner.getPhysicsScene().time)),
      life: this.localLife,
      chassis: this.demo.chassisController.getControlState(),
      turretControl: this.demo.turretController.getControl(),
      turretAngle: this.demo.turretController.getDirection(),
      px: state.position.x,
      py: state.position.y,
      pz: state.position.z,
      qx: state.orientation.x,
      qy: state.orientation.y,
      qz: state.orientation.z,
      qw: state.orientation.w,
      vx: state.velocity.x,
      vy: state.velocity.y,
      vz: state.velocity.z,
      ax: state.rotation.x,
      ay: state.rotation.y,
      az: state.rotation.z,
    };
    this.connection.sendBinary(encodeState(FRAME.STATE, sample));
    this.lastStateSentAt = performance.now();
    this.controlChangePending = false;
  }

  private onFrame(data: Uint8Array): void {
    if (this.stopped) return;
    const frame = decodeFrame(data);
    if (!frame) return;
    if (frame.type == FRAME.PONG) {
      this.lastPongAt = performance.now();
      this.clock.onPong(frame.clientMs, frame.serverMs, this.lastPongAt);
    }
    else if (frame.type == FRAME.SNAPSHOT) this.onSnapshot(frame.tanks);
    else if (frame.type == FRAME.CORRECTION) this.onCorrection(frame.sample);
  }

  /** сервер отверг движение (скорость) — танк возвращается в последнее принятое состояние */
  private onCorrection(sample: SyncSample): void {
    if (!this.spawned || sample.life !== this.localLife || !isValidSample(sample)) return;
    const body = this.demo.tank.getBody();
    const state = body.state;
    state.position.reset(sample.px, sample.py, sample.pz);
    state.orientation.reset(sample.qw, sample.qx, sample.qy, sample.qz).normalize();
    state.velocity.reset(sample.vx, sample.vy, sample.vz);
    state.rotation.reset(sample.ax, sample.ay, sample.az);
    body.saveState();
    body.calcDerivedData();
    this.sendState();
    this.log(`бой: сервер вернул танк в (${sample.px.toFixed(0)}, ${sample.py.toFixed(0)}, ${sample.pz.toFixed(0)})`);
  }

  /** viewTime попадания: серверное время, на которое стоят чужие танки в физике (их видели лучи оружия) */
  private viewTime(): number {
    return Math.round(this.renderTime(this.demo.runner.getPhysicsScene().time)) | 0;
  }

  // ------------------------------------------------------------ синхронизация: чужие танки

  private onSnapshot(tanks: { userId: number; sample: SyncSample }[]): void {
    const now = performance.now();
    const arrival = this.clock.isSynced ? this.clock.toServer(now) : null;
    this.lastSnapshotAt = now;
    for (const { userId, sample } of tanks) {
      const entry = this.remotes.get(userId);
      if (entry && isValidSample(sample)) this.acceptSample(entry, sample, arrival, now);
    }
  }

  /** жизнь отсекает прошлое; новая жизнь очищает буфер; живой танк из снапшота, которого нет на поле, появляется */
  private acceptSample(entry: RemoteEntry, sample: SyncSample, arrival: number | null, now: number): void {
    if (sample.life < entry.life || sample.life <= entry.deadLife) return;
    if (sample.life > entry.life) {
      entry.life = sample.life;
      entry.buffer.clear();
    }
    entry.lastSeen = now;
    const previousNewest = entry.buffer.newest?.sampleTime ?? null;
    if (!entry.buffer.push(sample)) return;
    if (arrival != null) this.delay.addArrival(arrival, sample.sampleTime, previousNewest);
    const tank = entry.tank;
    if (!tank || tank.isActive) return;
    tank.spawnFromSample(sample, true);
    this.applyTeam(entry);
    this.log(`бой: ${entry.player.name} на поле по снапшоту`);
  }

  /** живой танк пропал из снапшотов (а они идут) дольше 2 с — его нет на поле */
  private hideMissingTanks(now: number): void {
    if (now - this.lastSnapshotAt > SNAPSHOT_STALE_MS) return;
    for (const entry of this.remotes.values()) {
      const tank = entry.tank;
      if (!tank?.isActive || entry.lastSeen == 0 || now - entry.lastSeen < MISSING_HIDE_MS) continue;
      entry.lastSeen = 0;
      entry.buffer.clear();
      entry.railgun?.stopEffects();
      entry.stream?.stop();
      entry.shaft?.stopAim();
      entry.ricochet?.stopEffects();
      tank.remove();
      this.log(`бой: ${entry.player.name} пропал из снапшотов — убран с поля`);
    }
  }

  // ------------------------------------------------------------ выстрелы

  private findEntryByTank(tank: Tank): RemoteEntry | null {
    for (const entry of this.remotes.values()) if (entry.tank?.tank === tank) return entry;
    return null;
  }

  /** попадание по танку: точка в его системе, мировая точка и где он стоял у стрелка */
  private shotHit(entry: RemoteEntry, body: Body, world: Vector3): ShotHit {
    return { userId: entry.player.userId, life: entry.life, local: globalToLocal(body, world), world: vec(world), position: vec(body.state.position) };
  }

  /** ответ на выстрел: HP целей и крит Смоки (SmokyModel.localCriticalHit — эффект в центре цели) */
  private onShotResult(result: ShotResult): void {
    for (const hit of result.hits) {
      const entry = this.remotes.get(hit.userId);
      if (!entry) {
        // сплеш Грома задел самого стрелка
        continue;
      }
      this.applyHealth(hit.userId, hit.life, hit.health);
      const target = entry.tank?.tank;
      if (hit.critical && target) (this.demo.weaponEffects ?? this.smokyEffects)?.createCriticalHitEffects(target.getBody().state.position);
      // сплеш Грома: вспышка разрыва над каждым задетым танком (урон уже посчитан сервером)

    }
  }

  private shoot<K extends 'battle.smoky' | 'battle.thunder' | 'battle.rail' | 'battle.twinsHit' | 'battle.ricochetHit' | 'battle.shaft' | 'battle.streamTick'>(type: K, args: RequestArgs<K>): void {
    if (this.stopped) return;
    this.connection.request(type, args).then(
      (result) => !this.stopped && this.onShotResult(result as ShotResult),
      (error: unknown) => this.log(`бой: ${type} — ${String(error)}`),
    );
  }

  /** Смоки или Гром: выстрел в никуда, в стену или в танк; перед попаданием — свежее состояние своего танка */
  private readonly shotListener: WeaponShotListener = {
    onFire: () => {
      if (!this.spawned) return;
      if (this.weapon.kind == 'thunder') this.shoot('battle.thunder', { viewTime: this.viewTime() });
      else this.shoot('battle.smoky', { viewTime: this.viewTime() });
    },
    onFireStatic: (hitPoint) => {
      if (!this.spawned) return;
      if (this.weapon.kind == 'thunder') this.shoot('battle.thunder', { viewTime: this.viewTime(), hit: vec(hitPoint) });
      else this.shoot('battle.smoky', { viewTime: this.viewTime(), hit: vec(hitPoint) });
    },
    onFireTarget: (target, _hitLocal, hitWorld) => {
      if (!this.spawned) return;
      const entry = this.findEntryByTank(target);
      if (!entry) return;
      this.sendState();
      const hit = this.shotHit(entry, target.getBody(), hitWorld);
      if (this.weapon.kind == 'thunder') this.shoot('battle.thunder', { viewTime: this.viewTime(), target: hit });
      else this.shoot('battle.smoky', { viewTime: this.viewTime(), target: hit });
    },
  };

  private readonly railgunListener: RailgunShotListener = {
    onStartCharging: () => {
      if (this.spawned) this.request('battle.railCharge', {});
    },
    onShotDummy: () => {
      if (this.spawned) this.shoot('battle.rail', { viewTime: this.viewTime(), hit: null, targets: [], dummy: true });
    },
    onShot: (staticHitPoint, targets, hitPoints) => {
      if (!this.spawned) return;
      const hits: ShotHit[] = [];
      targets.forEach((target, index) => {
        const entry = this.findEntryByTank(target);
        if (entry) hits.push(this.shotHit(entry, target.getBody(), hitPoints[index]));
      });
      this.sendState();
      this.shoot('battle.rail', { viewTime: this.viewTime(), hit: staticHitPoint ? vec(staticHitPoint) : null, targets: hits });
    },
  };

  private readonly twinsListener: TwinsShotListener = {
    onShot: (barrel, shotId, direction) => {
      if (!this.spawned) return;
      this.sendState();
      this.request('battle.twins', { barrel, shotId, direction: vec(direction) });
    },
    onShotHit: (shotId, target, hitPoint) => {
      const entry = this.findEntryByTank(target);
      if (entry) this.shoot('battle.twinsHit', { viewTime: this.viewTime(), shotId, target: this.shotHit(entry, target.getBody(), hitPoint) });
    },
  };

  /** Шафт: вход в прицел и выстрел; урон по заряду и пробитие считает сервер */
  private readonly shaftListener: ShaftShotListener = {
    onAim: (active) => {
      if (this.spawned) this.request('battle.shaftAim', { active });
    },
    onShot: (aimed, staticHitPoint, targets, hitPoints) => {
      if (!this.spawned) return;
      const hits: ShotHit[] = [];
      targets.forEach((target, index) => {
        const entry = this.findEntryByTank(target);
        if (entry) hits.push(this.shotHit(entry, target.getBody(), hitPoints[index]));
      });
      this.sendState();
      this.shoot('battle.shaft', { viewTime: this.viewTime(), aimed, hit: staticHitPoint ? vec(staticHitPoint) : null, targets: hits });
    },
  };

  /** Струя: старт, тики с целями в конусе и стоп */
  private readonly streamListener: StreamShotListener = {
    onTarget: (targets, origin) => {
      if (!this.spawned) return;
      const target=targets[0], entry=target ? this.findEntryByTank(target.target) : null;
      this.sendState();
      this.request('battle.isidaTarget', { viewTime: this.viewTime(), origin, target: target && entry ? this.shotHit(entry,target.target.getBody(),target.point) : null });
    },
    onStart: () => {
      if (this.spawned) this.request('battle.streamStart', { viewTime: this.viewTime() });
    },
    onTick: (targets, _wall, _healing, origin) => {
      if (!this.spawned) return;
      const hits: ShotHit[] = [];
      for (const target of targets) {
        const entry = this.findEntryByTank(target.target);
        if (entry) hits.push(this.shotHit(entry, target.target.getBody(), target.point));
      }
      this.sendState();
      this.shoot('battle.streamTick', { viewTime: this.viewTime(), targets: hits, origin });
    },
    onStop: () => {
      if (this.spawned) this.request('battle.streamStop', {});
    },
  };

  /** Рикошет: выстрел и попадание снаряда (как Twins) */
  private readonly ricochetListener: RicochetShotListener = {
    onShot: (shotId, direction) => {
      if (!this.spawned) return;
      this.sendState();
      this.request('battle.ricochet', { shotId, direction: vec(direction) });
    },
    onShotHit: (shotId, target, hitPoint, bounces) => {
      if (!this.spawned) return;
      if (target === this.demo.tank) {
        // свой шар вернулся после отскока (RicochetShot.considerBody): сервер разрешает попадание
        const body = target.getBody();
        const self: ShotHit = {
          userId: this.localId,
          life: this.localLife,
          local: globalToLocal(body, hitPoint),
          world: vec(hitPoint),
          position: vec(body.state.position),
        };
        this.shoot('battle.ricochetHit', { viewTime: this.viewTime(), shotId, bounces, target: self });
        return;
      }
      const entry = this.findEntryByTank(target);
      if (entry) this.shoot('battle.ricochetHit', { viewTime: this.viewTime(), shotId, bounces, target: this.shotHit(entry, target.getBody(), hitPoint) });
    },
  };

  /** тело танка игрока в бою (свой или чужой); null — танка нет на поле */
  private bodyOfUser(userId: number): Body | null {
    if (userId == this.localId) return this.spawned ? this.demo.tank.getBody() : null;
    const tank = this.remotes.get(userId)?.tank;
    return tank?.isVisible ? tank.tank.getBody() : null;
  }

  /** чужой выстрел Смоки: вспышка и отдача, взрыв в стене или на цели с толчком, крит */
  private onRemoteSmoky(message: EventMessage<'battle.smoky'>): void {
    const shooter = this.remotes.get(message.shooterId)?.tank;
    if (!shooter?.isVisible) return;
    const effects = this.remotes.get(message.shooterId)?.smokyEffects??null;
    const spec = shooter.skin.turret.spec;
    const forces = new WeaponForces(spec.impactForce * WEAPON_FORCE_SCALE, spec.kickback * WEAPON_FORCE_SCALE);
    shooter.playShot(effects, forces.getRecoilForce());
    if (message.hit) {
      const world = vector3(message.hit);
      effects?.createExplosionEffects(world);
      effects?.createExplosionMark(shooter.barrelOrigin, world);
      return;
    }
    if (!message.target) return;
    const body = this.bodyOfUser(message.target.userId);
    if (!body) return;
    const world = localToGlobal(body, message.target.local);
    effects?.createExplosionEffects(world);
    (body.data as Tank).applyWeaponHit(world, shooter.barrelDirection, forces.getImpactForce() * message.impact);
    if (message.critical) effects?.createCriticalHitEffects(body.state.position);
  }

  /** чужая рельса: точки целей из их систем — в мировые */
  private onRemoteRail(message: EventMessage<'battle.rail'>): void {
    const shooter = this.remotes.get(message.shooterId);
    const weapon = shooter?.railgun;
    const tank = shooter?.tank;
    if (!weapon || !tank?.isVisible) return;
    if (message.dummy) {
      weapon.fireDummy(tank.tank);
      return;
    }
    const targets: (Body | null)[] = [];
    const hitPoints: Vector3[] = [];
    for (const target of message.targets) {
      const body = this.bodyOfUser(target.userId);
      targets.push(body);
      hitPoints.push(body ? localToGlobal(body, target.local) : vector3(target.local));
    }
    weapon.fire(tank.tank, message.hit ? vector3(message.hit) : null, targets.length ? targets : null, hitPoints.length ? hitPoints : null);
  }

  private thunderDistanceFactor(weapon:WeaponInfo,point:Vector3,origin:Vector3):number{
    const distance=point.clone().subtract(origin).length()/100,full=weapon.maxDamageRadius,end=weapon.minDamageRadius,min=weapon.minDamagePercent/100;
    return end<=full||distance<=full?1:distance>=end?min:1-(1-min)*(distance-full)/(end-full);
  }
  private applyThunderSplash(point:Vector3,excluded:Body|null,weapon:WeaponInfo,force:number,coefficient:number):void{
    const splash=weapon.splash;if(!splash)return;const radius=splash.radius*100,detector=this.demo.runner.getCollisionDetector();
    for(const wrapper of detector.getTankBodies()){
      const body=wrapper.body,tank=body.data as Tank|null;
      if(body===excluded||!tank||tank.health<=0)continue;
      const delta=body.state.position.clone().subtract(point),distance=delta.length();if(distance>=radius||distance<.001)continue;
      const blocked=[0,-tank.getHalfLength()*.75,tank.getHalfLength()*.75].every(y=>{
        const end=new Vector3(0,y,0).transform3(body.baseMatrix).add(body.state.position),direction=end.subtract(point);
        return detector.raycastStatic(point,direction,255,.999,null,new RayHit());
      });if(blocked)continue;
      const fullRadius = (splash.fullDamageRadius ?? 0) * 100;
      const factor = 1 - Math.max(0, distance - fullRadius) / Math.max(1, radius - fullRadius);
      const min = splash.minimumDamagePercent;
      const attenuation = min === undefined
        ? (splash.damageTo > 0 ? (splash.damageFrom + (splash.damageTo - splash.damageFrom) * factor) / splash.damageTo : 0)
        : min / 100 + (1 - min / 100) * factor;
      const splashForce = splash.impactForce === undefined ? force : splash.impactForce * WEAPON_FORCE_SCALE;
      tank.applyWeaponHit(body.state.position,delta.scale(1/distance),splashForce*coefficient*attenuation);
    }
  }
  /** чужой Гром: вспышка и отдача, разрыв в стене или на цели (сплеш уже нанёс сервер) */
  private onRemoteThunder(message: EventMessage<'battle.thunder'>): void {
    const shooter = this.remotes.get(message.shooterId)?.tank;
    if (!shooter?.isVisible) return;
    const effects = this.thunderEffectsByMod.get(`${shooter.skin.turretStyle}:${shooter.skin.turretModification}`);
    const spec = shooter.skin.turret.spec;
    const forces = new WeaponForces(spec.impactForce * WEAPON_FORCE_SCALE, spec.kickback * WEAPON_FORCE_SCALE);
    shooter.playShot(effects??null, forces.getRecoilForce());
    let world: Vector3 | null = message.hit ? vector3(message.hit) : null;
    let body: Body | null = null;
    if (message.target) {
      body = this.bodyOfUser(message.target.userId);
      if (body) world = localToGlobal(body, message.target.local);
    }
    if (!world) return;
    effects?.createExplosionEffects(world);
    if(!body)effects?.createExplosionMark(shooter.barrelOrigin, world);
    const weapon=this.remotes.get(message.shooterId)!.player.weapon;
    const coefficient=this.thunderDistanceFactor(weapon,world,shooter.tank.getBody().state.position);
    this.applyThunderSplash(world,body,weapon,forces.getImpactForce(),coefficient);
    if (body) (body.data as Tank).applyWeaponHit(world, shooter.barrelDirection, forces.getImpactForce()*coefficient);
  }

  /** чужой Шафт: луч, разрыв и толчок пробитым танкам */
  private onRemoteShaft(message: EventMessage<'battle.shaft'>): void {
    const shooter = this.remotes.get(message.shooterId);
    const weapon = shooter?.shaft;
    const tank = shooter?.tank;
    if (!weapon || !tank?.isVisible) return;
    const targets: (Body | null)[] = [];
    const hitPoints: Vector3[] = [];
    for (const target of message.targets) {
      const body = this.bodyOfUser(target.userId);
      targets.push(body);
      hitPoints.push(body ? localToGlobal(body, target.local) : vector3(target.local));
    }
    weapon.fire(tank.tank, message.hit ? vector3(message.hit) : null, targets, hitPoints);
  }

  /** чужая струя: включение, цели (луч Изиды) и выключение */
  private onRemoteStream(message: EventMessage<'battle.stream'>): void {
    const entry = this.remotes.get(message.shooterId);
    const weapon = entry?.stream;
    const tank = entry?.tank;
    if (!entry || !weapon || !tank?.isVisible) return;
    if (!message.active) {
      weapon.stop();
      return;
    }
    if (!weapon.isActive) weapon.start(tank.tank);
    weapon.aim(tank.tank);
    let point: Vector3 | null = message.hit ? vector3(message.hit) : null;
    let healing = false;
    const first = message.targets[0];
    if (first) {
      const body = this.bodyOfUser(first.userId);
      if (body) point = localToGlobal(body, first.local);
      const targetEntry = this.remotes.get(first.userId);
      const targetTeam = first.userId === this.localId ? this.localTeam : targetEntry?.player.team;
      healing = entry.player.team != TEAM.NONE && targetTeam === entry.player.team;
    }
    weapon.setTarget(point, healing, first ? () => {
      const body = this.bodyOfUser(first.userId);
      const target = body?.data as Tank | null;
      return body && target && target.health > 0 ? localToGlobal(body, first.local) : null;
    } : null, first ? this.bodyOfUser(first.userId) : null);
  }

  /** чужой снаряд Рикошета попал: шар взрывается, если ещё летит (иначе взрыв уже был) */
  private onRemoteRicochetHit(message: EventMessage<'battle.ricochetHit'>): void {
    const shooter = this.remotes.get(message.shooterId);
    const weapon = shooter?.ricochet;
    const body = this.bodyOfUser(message.target.userId);
    if (!weapon || !body) return;
    const world = localToGlobal(body, message.target.local);
    // если наша физика уже провела шар в цель, попадание и толчок уже были — второй раз не надо
    weapon.hitByServer(message.shotId, world, body.data as Tank, shooter?.tank?.barrelDirection ?? new Vector3(0, 0, 1));
  }
}

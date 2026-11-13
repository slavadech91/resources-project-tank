// Связь боя с сервером: спавн своего танка, события боя и синхронизация движения v2 (html5/docs/SYNC_V2.md):
// свой танк шлёт SYNC_STATE 20 раз в секунду (и сразу при смене управления, перед выстрелом и припасом), чужие танки
// рисуются по SYNC_SNAPSHOT через буфер интерполяции с общей задержкой, попадания уходят с view_time (компенсация
// лага на сервере). Снапшот — источник истины о том, кто на поле. Старая синхронизация (MOVE / MOVEMENT_CONTROL /
// ROTATE_TURRET по правилам оригинала) — backup/sync_v1.
import type * as THREE from 'three';
import { MODEL_ID, type ClientEvents, type GameClient, type RemoteObject } from '../../net/client.ts';
import { decodeMoveBitArea, type MoveCommand } from '../../net/moveCodec.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { Quaternion } from '../../physics/math/Quaternion.ts';
import type { TankDemo } from '../TankDemo.ts';
import type { TankSkin } from '../render/TankSkin.ts';
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import type { Tank } from '../tank/Tank.ts';
import { WEAPON_FORCE_SCALE, WeaponForces, type WeaponShotListener } from '../weapon/SmokyWeapon.ts';
import { RemoteRailgunWeapon, type RailgunShotListener } from '../weapon/RailgunWeapon.ts';
import { RailgunEffects } from '../sfx/RailgunEffects.ts';
import { TwinsEffects } from '../sfx/TwinsEffects.ts';
import { DistanceWeakening, PlasmaGunData, RemoteTwinsWeapon, type TwinsShotListener } from '../weapon/TwinsWeapon.ts';
import { SmokyEffects } from '../sfx/SmokyEffects.ts';
import type { Body } from '../../physics/Body.ts';
import { RemoteTank } from './RemoteTank.ts';
import { SHOT_COMMAND, ShotTracker, UNKNOWN_LIFE, type ShotRecord, type ShotTarget } from './ShotTracker.ts';
import type { ByteReader, ByteWriter } from '../../net/bytes.ts';
import { ServerClock } from './sync/ServerClock.ts';
import { InterpolationDelay, StateBuffer } from './sync/StateBuffer.ts';
import { SYNC_COMMAND, decodeSample, encodeSample, isValidSample, type SyncSample } from './sync/SyncProtocol.ts';
import { DESYNC_DEBUG_AVAILABLE, DesyncDebug, effectName, type CommandStatus, type DesyncRemoteInfo } from './DesyncDebug.ts';
import { BonusManager } from '../bonuses/BonusManager.ts';
import { TitleConfigFlags, UserTitle, loadProgressBarSkins, type ProgressBarSkins } from '../display/UserTitle.ts';
import { INVENTORY_ITEM_MODEL_ID, InventoryController, type InventoryPanel } from '../inventory/InventoryController.ts';
import { STAT_TEAM, type StatRow } from '../../ui/hud/BattleStats.ts';
import { BATTLE_TEAM, enteredBattleFriendlyFire } from '../../net/battle-entry.ts';

/** DurationControllerModel: time_left_in_ms — сколько ещё действует эффект на момент загрузки объекта */
const DURATION_CONTROLLER_MODEL_ID = 300100033;
/** EffectDescriptionModel: index (1 аптечка, 2 броня, 3 мощность, 4 нитро), tank_game_object_id */
const EFFECT_DESCRIPTION_MODEL_ID = 300100037;

/** StatisticsDmModel: ники и звания игроков DM (user_infos в данных модели, USER_CONNECTED при входе нового) */
const STATISTICS_DM_MODEL_ID = 300080031;
/** StatisticsModel: time_left (с) в данных модели — остаток времени боя на момент загрузки объекта */
const STATISTICS_MODEL_ID = 300080032;
/** DiscreteShotModel (ShotCC): углы автонаведения и перезарядка оружия */
const DISCRETE_SHOT_MODEL_ID = 300100032;
/** RailgunModel (RailgunCC): charging_time_msec, weakening_coeff; команды сервера START_CHARGING / FIRE / FIRE_DUMMY */
const RAILGUN_MODEL_ID = 300100061;

/** TwinsModel (TwinsCC: distance, shot_radius, speed в метрах); команда сервера FIRE(shooter_id, barrel, shot_id, shot_direction) */
const TWINS_MODEL_ID = 300100090;
/** WeaponWeakeningModel (WeaponWeakeningCC): радиусы полного и минимального урона (м), минимальный процент */
const WEAPON_WEAKENING_MODEL_ID = 300100094;

/** StatisticsTeamModel: blue/red_user_infos + счёт команд; CHANGE_TEAM_SCORE, USER_CONNECTED с командой */
const STATISTICS_TEAM_MODEL_ID = 300080033;

interface StatUserInfo {
  uid?: string;
  rank?: number;
  user_id?: number;
  kills?: number;
  deaths?: number;
  score?: number;
}

/** таблица игроков (ui/hud/BattleStats) */
export interface BattleStatsView {
  setExternalTeamScore?(value:boolean):void;
  setEnabled(enabled: boolean, localUserId?: number): void;
  setRows(rows: StatRow[]): void;
  setTeamScores(red: number, blue: number): void;
  showFinish(timeToRestartSec: number, rewards: Map<number, number>): void;
  hideFinish(): void;
}

export const TANK_COMMAND = {
  ACTIVATE: 300100081,
  CONFIRM_SPAWN: 300100082,
  DEATH_CONFIRMATION: 300100083,
  MOVE: 300100084,
  MOVEMENT_CONTROL: 300100085,
  READY_TO_SPAWN: 300100086,
  ROTATE_TURRET: 300100087,
  /** TankModelServer.suicideCommand: Delete, смерть через 10 с */
  SUICIDE: 300100088,
} as const;

/** TankModel §=!r§: сколько показывается череп самоуничтожения (сервер убивает через 10 с) */
const SUICIDE_INDICATOR_MS = 11000;

/** controls.SuicideIndicator */
export interface SuicideIndicatorView {
  show(timeMs: number): void;
  hide(): void;
}

/** синхронизация v2: состояние своего танка 20 раз в секунду; по смене управления — сразу, но не чаще раза в 30 мс */
const STATE_INTERVAL_MS = 50;
const MIN_STATE_INTERVAL_MS = 30;
/** жизнь своего танка (spawn_token) не пришла в HEALTH_STATE за столько после SPAWN — запросить ещё раз */
const LIFE_REQUEST_MS = 500;
/** снапшоты идут (последний не старше), а живого танка в них нет дольше MISSING_HIDE_MS — он не на поле */
const SNAPSHOT_STALE_MS = 500;
const MISSING_HIDE_MS = 2000;
/** после KILL с неизвестной жизнью сэмплы танка не возвращают его на поле столько мс (снапшот, ушедший до смерти) */
const KILL_GUARD_MS = 1500;
/** танк старого протокола (MOVE раз в 2 с и по смене управления) экстраполируется дольше */
const LEGACY_EXTRAPOLATION_MS = 2000;
const DEFAULT_ACTIVATION_DELAY_MS = 3000;
/** server_properties.tank_dead_time_in_ms — если в KILL нет respawn_delay */
const DEFAULT_RESPAWN_DELAY_MS = 3000;
/** DeathConfirmationTimeoutTask: сколько ждать DEATH_CONFIRMED чужого танка */
const DEATH_CONFIRMATION_TIMEOUT_MS = 2000;

export const WEAPON_COMMAND = {
  FIRE: 300100074,
  FIRE_STATIC: 300100075,
  FIRE_TARGET: 300100076,
} as const;

/** RailgunModelServer: fireCommand / fireDummyCommand / startChargingCommand */
export const RAILGUN_COMMAND = {
  FIRE: 300100056,
  FIRE_DUMMY: 300100057,
  START_CHARGING: 300100058,
} as const;

/** TwinsModelServer: fireCommand(clientTime, barrel, shotId, direction) / hitCommand(shotId, target, incarnation, targetPosition, hitPoint) */
export const TWINS_COMMAND = {
  FIRE: 300100108,
  HIT: 300100109,
} as const;

interface TwinsData {
  distance?: number;
  shot_radius?: number;
  speed?: number;
}

interface WeakeningData {
  maximum_damage_radius?: number;
  minimum_damage_percent?: number;
  minimum_damage_radius?: number;
}

/** BattleUtils.toClientScale */
const CLIENT_SCALE = 100;

interface RailgunData {
  charging_time_msec?: number;
  weakening_coeff?: number;
}

type Vec3 = { x: number; y: number; z: number };

const toLocalEuler = new Vector3();
const toLocalMatrix = new Matrix3();

/** BattleUtils.globalToLocal: точка в системе корпуса танка */
function globalToLocal(body: Body, point: Vector3, result: Vector3): Vector3 {
  body.state.orientation.getEulerAngles(toLocalEuler);
  toLocalMatrix.setRotationMatrix(toLocalEuler.x, toLocalEuler.y, toLocalEuler.z);
  result.diff(point, body.state.position);
  toLocalMatrix.transformVectorInverse(result, result);
  return result;
}

/** BattleUtils.localToGlobal */
function localToGlobal(body: Body, point: Vector3): Vector3 {
  body.state.orientation.getEulerAngles(toLocalEuler);
  toLocalMatrix.setRotationMatrix(toLocalEuler.x, toLocalEuler.y, toLocalEuler.z);
  toLocalMatrix.transformVector(point, point);
  return point.add(body.state.position);
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

type CommandEvent = ClientEvents['command'];

interface SpawnArgs {
  team: unknown;
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number };
  health: number;
  incarnation_id: number;
}

interface TankModelData {
  local?: boolean;
  max_health?: number;
  tank_parts?: { weapon_id?: number };
  tank_initialization_data?: {
    team?: unknown;
    health?: number;
    incarnation_id?: number | null;
    logic_state?: number | null;
    tank_state?: {
      position: { x: number; y: number; z: number };
      orientation: { x: number; y: number; z: number };
      turret_angle: number;
    } | null;
  };
}

interface RemoteEntry {
  userId: number;
  tank: RemoteTank | null;
  queue: ((tank: RemoteTank) => void)[];
  /** KILL пришёл, ждём DEATH_CONFIRMED */
  pendingKill: { delay: number; timer: ReturnType<typeof setTimeout> } | null;
  /** RemoteRailgunWeapon, если у танка рельса */
  railgun: RemoteRailgunWeapon | null;
  /** RemotePlasmaWeapon, если у танка Twins */
  twins: RemoteTwinsWeapon | null;
  /** BATTLE_TEAM танка */
  team: number;
  /** сэмплы снапшотов (синхронизация v2); есть и до загрузки скина */
  buffer: StateBuffer;
  /** последняя известная жизнь (spawn_token) танка; null — неизвестна */
  life: number | null;
  /** жизнь, в которой пришёл KILL: её сэмплы танк на поле не возвращают */
  deadLife: number | null;
  killedAt: number;
  /** когда танк последний раз был в снапшоте (performance.now), 0 — в этой жизни не был */
  lastSeen: number;
  /** танк хоть раз был в снапшоте — он html5, MOVE старого протокола для него не нужны */
  snapshotSeen: boolean;
  legacySeq: number;
  legacyTurretAngle: number;
  legacyTurretControl: number;
}

/** TeamCodec приходит числом или структурой из одного числа (enum-кодек); нет команды — NONE */
function teamValue(value: unknown): number {
  if (value == null) return BATTLE_TEAM.NONE;
  const team = typeof value == 'number' ? value : Number(Object.values(value as object)[0]);
  return team == BATTLE_TEAM.RED || team == BATTLE_TEAM.BLUE ? team : BATTLE_TEAM.NONE;
}

const samplePosition = new Vector3();
const sampleVelocity = new Vector3();
const sampleOrientation = new Quaternion();

export class NetBattle {
  private readonly remotes = new Map<number, RemoteEntry>();
  /** надёжная регистрация попаданий (ShotTracker) и HP по revision из HEALTH_STATE / SHOT_ACK */
  private readonly shots: ShotTracker;
  private readonly offHealthState: () => void;
  /** последняя применённая revision HP по объекту танка; есть запись — устаревший SET_HEALTH без revision не применяем */
  private readonly healthRevisions = new Map<number, number>();
  /** жизнь танка (spawn_token сервера) — уходит в конверте попадания, чтобы старое попадание не легло на новую жизнь */
  private readonly lives = new Map<number, number>();
  /** user_id -> ник и звание (BattleUserInfoService во Flash) */
  private readonly userInfos = new Map<number, { name: string; rank: number }>();
  private titleSkins: Promise<ProgressBarSkins> | null = null;
  private skins: ProgressBarSkins | null = null;
  /** команда своего танка (BATTLE_TEAM); NONE — DM */
  private localTeam: number = BATTLE_TEAM.NONE;
  private readonly friendlyFire = enteredBattleFriendlyFire;
  private readonly localId: number;
  private readonly activationDelay: number;
  private readonly handlers: { command: (event: CommandEvent) => void; objects: (event: ClientEvents['objects']) => void; unloaded: (event: ClientEvents['unloaded']) => void };

  readonly bonuses: BonusManager;
  private inventory: InventoryController | null = null;
  /** объекты эффектов (EffectDescription): id объекта -> танк и индекс эффекта */
  private readonly effectObjects = new Map<number, { tankId: number; index: number }>();
  private weaponId = 0;
  private incarnation = 0;
  private specificationId = 0;
  private spawned = false;
  private stopped = false;
  /** BattleFieldModel.battleActive: false между BATTLE_FINISH и BATTLE_RESTART */
  private battleActive = true;
  /** строки таблицы игроков: user_id (он же id танка) -> статистика */
  private readonly statRows = new Map<number, StatRow>();
  private teamScores: [number, number] = [0, 0];
  /** ClientTankState.ACTIVE: после ACTIVATE_TANK до смерти/рестарта */
  private activated = false;
  /** TankModel §2D§: самоуничтожение уже запрошено в этой жизни */
  private suicideRequested = false;
  private activationTimer: ReturnType<typeof setTimeout> | null = null;

  // синхронизация v2
  private readonly clock: ServerClock;
  private readonly delay = new InterpolationDelay();
  private readonly offSync: (() => void)[] = [];
  private syncSeq = 0;
  private nextStateAt = 0;
  private lastStateSentAt = 0;
  private controlChangePending = false;
  /** жизнь своего танка (spawn_token из HEALTH_STATE после SPAWN); null — ещё не пришла, состояние не шлём */
  private localLife: number | null = null;
  private lifeRequestedAt = 0;
  private lastSnapshotAt = 0;
  /** серверное время отрисовки чужих танков для локального времени физики */
  private readonly renderTime = (physicsTime: number): number => this.clock.toServer(physicsTime) - this.delay.current;
  /** эффекты чужих Смоки (свой танк может быть с рельсой) */
  private smokyEffects: SmokyEffects | null = null;
  /** отладка рассинхрона (F7) и что стало с текущей командой сервера */
  private readonly desync: DesyncDebug | null;
  private commandStatus: CommandStatus = 'ok';

  constructor(
    private readonly client: GameClient,
    readonly spaceName: string,
    private readonly demo: TankDemo,
    private readonly world: THREE.Object3D,
    private readonly loadSkin: (tank: RemoteObject) => Promise<TankSkin>,
    private readonly log: (message: string) => void = () => undefined,
    /** FundAndLimits.initTime: остаток времени боя от сервера (0 — без лимита) */
    private readonly onTimeLeft: (seconds: number) => void = () => undefined,
    /** слоты инвентаря HUD (клавиши 1-5) */
    inventoryPanel: InventoryPanel | null = null,
    /** таблица игроков: Tab и итоги раунда */
    private readonly stats: BattleStatsView | null = null,
    /** конец раунда: таймер HUD останавливается на нуле */
    private readonly onTimeStop: () => void = () => undefined,
    /** череп самоуничтожения по центру экрана */
    private readonly suicideIndicator: SuicideIndicatorView | null = null,
  ) {
    const space = client.getSpace(spaceName);
    if (!space) throw new Error(`нет пространства ${spaceName}`);
    const local = [...space.objects.values()].find((object) => (object.models.get(MODEL_ID.TANK) as TankModelData | undefined)?.local);
    if (!local) throw new Error('в бою нет своего танка');
    this.localId = local.id;
    this.localTeam = teamValue((local.models.get(MODEL_ID.TANK) as TankModelData).tank_initialization_data?.team);
    demo.setTeam(this.localTeam);
    this.weaponId = (local.models.get(MODEL_ID.TANK) as TankModelData).tank_parts?.weapon_id ?? 0;
    demo.setShotListener(this.shotListener);
    demo.setRailgunListener(this.railgunListener);
    demo.setTwinsListener(this.twinsListener);
    demo.configureTwins(this.twinsGunData(this.weaponId), this.weakeningData(this.weaponId));
    const railgun = this.railgunData(this.weaponId);
    if (railgun?.charging_time_msec != null && railgun.weakening_coeff != null) demo.configureRailgun(railgun.charging_time_msec, railgun.weakening_coeff);
    const shot = space.objects.get(this.weaponId)?.models.get(DISCRETE_SHOT_MODEL_ID) as
      | { auto_aiming_angle_up?: number; auto_aiming_angle_down?: number }
      | undefined;
    if (shot?.auto_aiming_angle_up != null && shot.auto_aiming_angle_down != null) {
      demo.setAutoAimAngles(shot.auto_aiming_angle_up, shot.auto_aiming_angle_down);
    }
    const field = client.findObjectWithModel(space, MODEL_ID.BATTLE_FIELD);
    const fieldData = field?.models.get(MODEL_ID.BATTLE_FIELD) as { tank_activation_delay_in_ms?: number } | undefined;
    this.activationDelay = fieldData?.tank_activation_delay_in_ms ?? DEFAULT_ACTIVATION_DELAY_MS;

    // свой танк ждёт SPAWN: шасси заблокировано, оружие выключено
    demo.chassisController.lock(1);
    demo.netChassisListener = { onChassisControlChanged: () => this.onControlChanged() };
    demo.netTurretListener = { onTurretControlChanged: () => this.onControlChanged() };

    // синхронизация v2: часы, снапшоты чужих танков, коррекция своего
    this.clock = new ServerClock((pingId, clientMs) => {
      try {
        this.client.sendCommand(this.spaceName, this.localId, SYNC_COMMAND.PING, (writer) => {
          writer.i32(pingId);
          writer.i32(clientMs);
        });
      } catch {
        // соединение закрыто — бой сейчас остановится
      }
    });
    const onSync = (commandId: number, handler: (reader: ByteReader) => void): void => {
      this.offSync.push(
        client.onRawCommand(commandId, (name, _objectId, reader) => {
          if (name == this.spaceName && !this.stopped) handler(reader);
        }),
      );
    };
    onSync(SYNC_COMMAND.PONG, (reader) => {
      reader.i32();
      const clientMs = reader.i32();
      const serverMs = reader.i32();
      this.clock.onPong(clientMs, serverMs, performance.now());
    });
    onSync(SYNC_COMMAND.SNAPSHOT, (reader) => this.onSnapshot(reader));
    onSync(SYNC_COMMAND.CORRECTION, (reader) => this.onCorrection(reader));

    this.desync = DESYNC_DEBUG_AVAILABLE ? new DesyncDebug(world) : null;
    this.handlers = {
      command: (event) => this.onCommand(event),
      objects: (event) => this.onObjects(event),
      unloaded: (event) => this.onUnloaded(event),
    };
    client.on('command', this.handlers.command);
    client.on('objects', this.handlers.objects);
    client.on('unloaded', this.handlers.unloaded);

    this.shots = new ShotTracker(client, spaceName, {
      onTargetHealth: (targetId, hp, revision, life) => this.applyHealthState(targetId, hp, revision, life),
      // без подтверждения — просим у сервера актуальное HP целей
      onUnresolved: (targetIds) => {
        for (const id of targetIds) this.client.sendCommand(this.spaceName, id, SHOT_COMMAND.HEALTH_SYNC);
      },
      log: (message) => this.log(message),
    });
    // HEALTH_STATE: HP i32, максимум i32, revision i32, жизнь i32 — на объект танка
    this.offHealthState = client.onRawCommand(SHOT_COMMAND.HEALTH_STATE, (name, objectId, reader) => {
      if (name != this.spaceName) return;
      const hp = reader.i32();
      reader.i32();
      const revision = reader.i32();
      const life = reader.i32();
      this.applyHealthState(objectId, hp, revision, life);
    });

    this.bonuses = new BonusManager(
      client,
      spaceName,
      world,
      demo.runner.getCollisionDetector(),
      // TankModel.activateTank: группа BONUS_WITH_TANK — ящики берёт только активный танк
      () => (this.spawned && this.activated ? demo.tank.getBody() : null),
      demo.soundManager,
    );

    stats?.setEnabled(true, this.localId);
    // вход в бой во время экрана итогов: до BATTLE_RESTART танки стоят (спавн придёт с новым раундом)
    if ((fieldData as { active?: boolean } | undefined)?.active === false) this.battleActive = false;
    if (inventoryPanel) {
      // StateCorrectionEvent перед применением припаса: свежая позиция на сервере (мина ставится там, где стоит танк)
      this.inventory = new InventoryController(client, spaceName, inventoryPanel, () => this.sendState());
    }
    for (const object of space.objects.values()) {
      this.readStatistics(object);
      this.readTimeLeft(object);
      this.addTankObject(object);
      this.inventory?.addObject(object);
      this.addEffectObject(object);
    }
    SmokyEffects.load('battle', demo.soundManager, demo.effectsScene)
      .then((effects) => (this.smokyEffects = effects))
      .catch((error: unknown) => this.log(`бой: эффекты Смоки не загружены: ${String(error)}`));
    client.sendCommand(spaceName, this.localId, TANK_COMMAND.READY_TO_SPAWN);
    this.log('бой: READY_TO_SPAWN отправлен');
  }

  /** RailgunModel в объекте оружия (tank_parts.weapon_id) */
  private railgunData(weaponId: number | undefined): RailgunData | undefined {
    if (!weaponId) return undefined;
    return this.client.getSpace(this.spaceName)?.objects.get(Number(weaponId))?.models.get(RAILGUN_MODEL_ID) as RailgunData | undefined;
  }

  stop(): void {
    this.stopped = true;
    this.stats?.setEnabled(false);
    this.suicideIndicator?.hide();
    this.bonuses.stop();
    this.inventory?.dispose();
    this.inventory = null;
    this.effectObjects.clear();
    this.desync?.dispose();
    this.client.off('command', this.handlers.command);
    this.client.off('objects', this.handlers.objects);
    this.client.off('unloaded', this.handlers.unloaded);
    this.shots.stop('бой покинут');
    this.offHealthState();
    for (const off of this.offSync) off();
    this.offSync.length = 0;
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.demo.netChassisListener = null;
    this.demo.netTurretListener = null;
    this.demo.setShotListener(null);
    for (const entry of this.remotes.values()) {
      if (entry.pendingKill) clearTimeout(entry.pendingKill.timer);
      entry.railgun?.stopEffects();
      entry.tank?.dispose();
    }
    this.remotes.clear();
  }

  /**
   * TankModel.requestSuicide (Delete): один раз за жизнь, только активный танк с незаблокированным управлением.
   * Череп показывается сразу, убивает сервер (через 10 с, KILL с причиной SUICIDE).
   */
  requestSuicide(): void {
    if (this.suicideRequested || !this.spawned || !this.activated || !this.battleActive) return;
    if (!this.demo.chassisController.isEnabled()) return;
    this.suicideRequested = true;
    this.suicideIndicator?.show(SUICIDE_INDICATOR_MS);
    this.client.sendCommand(this.spaceName, this.localId, TANK_COMMAND.SUICIDE);
    this.log('бой: запрошено самоуничтожение');
  }

  /** Каждый кадр после шага физики: часы и отправка состояния (v2), кто на поле по снапшотам, отрисовка чужих танков */
  update(): void {
    const now = performance.now();
    this.clock.update(now);
    this.delay.update(now);
    this.updateSending(now);
    this.hideMissingTanks(now);
    this.bonuses.update();
    this.inventory?.update(performance.now());
    const camera = this.demo.getCameraPosition();
    const project = (x: number, y: number, z: number): { x: number; y: number } | null => this.demo.projectToScreen(x, y, z);
    for (const entry of this.remotes.values()) {
      entry.tank?.render();
      entry.tank?.updateSound(now, this.demo.soundListener);
      entry.tank?.updateTitle(camera, project, now);
    }
    if (this.desync) this.updateDesyncDebug(this.desync);
  }

  private updateDesyncDebug(desync: DesyncDebug): void {
    const remotes: DesyncRemoteInfo[] = [];
    for (const [id, entry] of this.remotes) {
      const tank = entry.tank;
      if (!tank) continue;
      const sync = `буфер ${entry.buffer.size}, экстраполяция ${Math.round(tank.extrapolatedMs)} мс, поправка ${(tank.correction / 100).toFixed(2)} м`;
      remotes.push({ id, name: this.ownerName(id), tank: tank.tank, active: tank.isActive, state: tank.desync, effects: this.effectsText(id), sync });
    }
    desync.update(
      {
        tank: this.demo.tank,
        spawned: this.spawned,
        activated: this.activated,
        lastSentTime: this.lastStateSentAt,
        specificationId: this.specificationId,
        effects: this.effectsText(this.localId),
        sync:
          `RTT ${Math.round(this.clock.bestRtt)} мс (сглаж. ${Math.round(this.clock.smoothedRtt)}), ` +
          `задержка отрисовки ${Math.round(this.delay.current)} → ${Math.round(this.delay.target)} мс, ` +
          `снапшот ${this.lastSnapshotAt ? Math.round(performance.now() - this.lastSnapshotAt) : '—'} мс назад, жизнь ${this.localLife ?? '—'}`,
      },
      remotes,
    );
  }

  /** активные эффекты припасов на танке */
  private effectsText(tankId: number): string {
    const names: string[] = [];
    for (const effect of this.effectObjects.values()) if (effect.tankId == tankId) names.push(effectName(effect.index));
    return names.join(', ');
  }

  /** чья команда: свой танк, ник игрока или id объекта */
  private ownerName(objectId: number): string {
    if (objectId == this.localId) return 'свой танк';
    const info = this.userInfos.get(objectId);
    if (info) return info.name;
    return this.remotes.has(objectId) ? `танк ${objectId}` : `объект ${objectId}`;
  }

  // ------------------------------------------------------------ ники (StatisticsDmModel)

  /** team: undefined — команду строки не трогаем (CHANGE_USER_STAT/REFRESH без команды) */
  private addUserInfos(infos: StatUserInfo[], team?: number): void {
    for (const info of infos) {
      if (info.user_id == null) continue;
      const userId = Number(info.user_id);
      if (info.uid) {
        this.userInfos.set(userId, { name: info.uid, rank: info.rank ?? 1 });
        const entry = this.remotes.get(userId);
        if (entry?.tank) this.applyUserInfo(entry.tank);
      }
      const known = this.userInfos.get(userId);
      const row = this.statRows.get(userId) ?? { userId, name: '', rank: 1, kills: 0, deaths: 0, score: 0, team: STAT_TEAM.NONE };
      row.name = known?.name ?? row.name;
      row.rank = known?.rank ?? row.rank;
      if (info.kills != null) row.kills = info.kills;
      if (info.deaths != null) row.deaths = info.deaths;
      if (info.score != null) row.score = info.score;
      if (team != null) row.team = team;
      this.statRows.set(userId, row);
    }
    this.publishStats();
  }

  private removeStatRow(userId: number): void {
    if (this.statRows.delete(userId)) this.publishStats();
  }

  private publishStats(): void {
    this.stats?.setRows([...this.statRows.values()].filter((row) => row.name));
  }

  /** данные StatisticsDmModel / StatisticsTeamModel объекта статистики */
  private readStatistics(object: { models: Map<number, unknown> }): void {
    const dm = object.models.get(STATISTICS_DM_MODEL_ID) as { user_infos?: StatUserInfo[] } | undefined;
    if (dm?.user_infos) this.addUserInfos(dm.user_infos, STAT_TEAM.NONE);
    const team = object.models.get(STATISTICS_TEAM_MODEL_ID) as
      | { score_red?: number; score_blue?: number; red_user_infos?: StatUserInfo[]; blue_user_infos?: StatUserInfo[] }
      | undefined;
    if (!team) return;
    if (team.red_user_infos) this.addUserInfos(team.red_user_infos, STAT_TEAM.RED);
    if (team.blue_user_infos) this.addUserInfos(team.blue_user_infos, STAT_TEAM.BLUE);
    this.teamScores = [team.score_red ?? 0, team.score_blue ?? 0];
    this.stats?.setTeamScores(...this.teamScores);
  }

  /**
   * TankModel.configureTankTitleAsRemote + CommonTargetEvaluator: в командном бою ник и полоска цвета команды,
   * у союзников видно HP; без огня по своим союзник — не цель наведения
   */
  private applyTeam(entry: RemoteEntry): void {
    this.withRemote(entry, (tank) => {
      const team = entry.team;
      const ally = team != BATTLE_TEAM.NONE && team == this.localTeam;
      tank.tank.friendly = ally && !this.friendlyFire;
      const skins = this.skins;
      if (!tank.title || !skins) return;
      tank.title.setSkin(team == BATTLE_TEAM.RED ? skins.red : team == BATTLE_TEAM.BLUE ? skins.blue : skins.dm);
      tank.title.setConfiguration(TitleConfigFlags.LABEL | TitleConfigFlags.EFFECTS | (ally ? TitleConfigFlags.HEALTH : 0));
    });
  }

  private applyUserInfo(tank: RemoteTank): void {
    const info = this.userInfos.get(tank.userId);
    if (!info || !tank.title) return;
    tank.title.setRank(info.rank);
    tank.title.setLabelText(info.name);
  }

  /** TankModel.createUserTitle + configureTankTitleAsRemote (DM): ник со званием и место под значки эффектов */
  private async createTitle(maxHealth: number): Promise<UserTitle> {
    this.titleSkins ??= loadProgressBarSkins('battle/usertitle');
    const skins = await this.titleSkins;
    this.skins = skins;
    const title = new UserTitle(document.body, skins, maxHealth);
    title.setSkin(skins.dm);
    title.setConfiguration(TitleConfigFlags.LABEL | TitleConfigFlags.EFFECTS);
    return title;
  }

  // ------------------------------------------------------------ синхронизация v2: свой танк

  private clientTime(): number {
    return Math.floor(performance.now()) | 0;
  }

  /** смена управления шасси или башни: состояние уходит сразу (не чаще раза в 30 мс), расписание 20 Гц не сдвигается */
  private onControlChanged(): void {
    if (!this.spawned) return;
    if (performance.now() - this.lastStateSentAt >= MIN_STATE_INTERVAL_MS) this.sendState();
    else this.controlChangePending = true;
  }

  private updateSending(now: number): void {
    if (!this.spawned) return;
    if (this.localLife == null) {
      // жизнь (spawn_token) приходит в HEALTH_STATE сразу за SPAWN; потерялась — просим ещё раз
      if (now - this.lifeRequestedAt > LIFE_REQUEST_MS) {
        this.lifeRequestedAt = now;
        this.client.sendCommand(this.spaceName, this.localId, SHOT_COMMAND.HEALTH_SYNC);
      }
      return;
    }
    if (now >= this.nextStateAt) {
      this.nextStateAt = this.nextStateAt + STATE_INTERVAL_MS > now ? this.nextStateAt + STATE_INTERVAL_MS : now + STATE_INTERVAL_MS;
      this.sendState();
    } else if (this.controlChangePending && now - this.lastStateSentAt >= MIN_STATE_INTERVAL_MS) {
      this.sendState();
    }
  }

  /**
   * SYNC_STATE: состояние тела на время последнего шага физики (body.state — его же видят лучи оружия), серверное
   * время этого шага, жизнь, управление и башня. Сразу, без расписания — перед выстрелом и припасом.
   */
  private sendState(): void {
    if (!this.spawned || this.localLife == null || !this.clock.isSynced) return;
    const state = this.demo.tank.getBody().state;
    if (!state.isValid()) return;
    this.syncSeq = (this.syncSeq + 1) & 0xffff;
    const physicsTime = this.demo.runner.getPhysicsScene().time;
    const sample: SyncSample = {
      seq: this.syncSeq,
      sampleTime: Math.round(this.clock.toServer(physicsTime)),
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
    this.client.sendCommand(this.spaceName, this.localId, SYNC_COMMAND.STATE, (writer) => encodeSample(sample, writer));
    this.lastStateSentAt = performance.now();
    this.controlChangePending = false;
  }

  /** SYNC_CORRECTION: сервер отверг движение (скорость) — танк возвращается в последнее принятое состояние */
  private onCorrection(reader: ByteReader): void {
    const sample = decodeSample(reader);
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

  /** view_time попадания: серверное время, на которое стоят чужие танки в физике (их видели лучи оружия) */
  private viewTime(): number {
    return this.renderTime(this.demo.runner.getPhysicsScene().time);
  }

  // ------------------------------------------------------------ синхронизация v2: чужие танки

  /** SYNC_SNAPSHOT: i32 server_ms, i16 count, count × (i64 id танка, состояние) */
  private onSnapshot(reader: ByteReader): void {
    const now = performance.now();
    const arrival = this.clock.toServer(now);
    reader.i32();
    const count = reader.i16();
    this.lastSnapshotAt = now;
    for (let i = 0; i < count; i++) {
      const tankId = reader.i64();
      const sample = decodeSample(reader);
      if (tankId == this.localId || !isValidSample(sample)) continue;
      const entry = this.remotes.get(tankId);
      if (entry) this.acceptSample(entry, sample, this.clock.isSynced ? arrival : null, now, true);
    }
  }

  /**
   * Сэмпл чужого танка. Жизнь отсекает прошлое (сэмплы до смерти и прошлых жизней); новая жизнь очищает буфер. Живой
   * танк из снапшота, которого у нас нет на поле (пропущен SPAWN, скрыт), появляется там, где он есть.
   */
  private acceptSample(entry: RemoteEntry, sample: SyncSample, arrival: number | null, now: number, fromSnapshot: boolean): void {
    if (entry.life != null && sample.life < entry.life) return;
    if (entry.deadLife != null && sample.life <= entry.deadLife) return;
    if (entry.deadLife == null && entry.killedAt > 0 && now - entry.killedAt < KILL_GUARD_MS) return;
    const newLife = entry.life == null || sample.life > entry.life;
    entry.life = sample.life;
    this.lives.set(entry.userId, sample.life);
    if (fromSnapshot) {
      entry.lastSeen = now;
      entry.snapshotSeen = true;
    }
    if (newLife) entry.buffer.clear();
    const previousNewest = entry.buffer.newest?.sampleTime ?? null;
    if (!entry.buffer.push(sample)) return;
    if (arrival != null) this.delay.addArrival(arrival, sample.sampleTime, previousNewest);
    const tank = entry.tank;
    if (!tank) return;
    samplePosition.reset(sample.px, sample.py, sample.pz);
    sampleVelocity.reset(sample.vx, sample.vy, sample.vz);
    sampleOrientation.reset(sample.qw, sample.qx, sample.qy, sample.qz).normalize();
    tank.desync.record(tank.lastCorrection, samplePosition, sampleOrientation, sampleVelocity);
    if (!tank.isActive) {
      tank.spawnFromSample(sample, true);
      this.applyTeam(entry);
      this.log(`бой: ${this.ownerName(entry.userId)} на поле по снапшоту`);
    }
  }

  /** живой танк пропал из снапшотов (а они идут) дольше 2 с — его нет на поле */
  private hideMissingTanks(now: number): void {
    if (now - this.lastSnapshotAt > SNAPSHOT_STALE_MS) return;
    for (const entry of this.remotes.values()) {
      const tank = entry.tank;
      if (!tank?.isActive || entry.lastSeen == 0 || entry.pendingKill || now - entry.lastSeen < MISSING_HIDE_MS) continue;
      entry.lastSeen = 0;
      entry.buffer.clear();
      entry.railgun?.stopEffects();
      tank.remove();
      this.log(`бой: ${this.ownerName(entry.userId)} пропал из снапшотов — убран с поля`);
    }
  }

  /** MOVE старого протокола (танк не html5): сэмпл на время прихода минус половина RTT, экстраполяция дольше */
  private acceptLegacyMove(entry: RemoteEntry, move: MoveCommand): void {
    if (entry.snapshotSeen || !this.clock.isSynced) return;
    sampleOrientation.setFromEulerAnglesXYZ(move.orientation.x, move.orientation.y, move.orientation.z);
    entry.legacySeq = (entry.legacySeq + 1) & 0xffff;
    entry.buffer.maxExtrapolationMs = LEGACY_EXTRAPOLATION_MS;
    const sample: SyncSample = {
      seq: entry.legacySeq,
      sampleTime: Math.round(this.clock.now() - this.clock.smoothedRtt / 2),
      life: entry.life ?? this.lives.get(entry.userId) ?? 0,
      chassis: move.control,
      turretControl: entry.legacyTurretControl,
      turretAngle: entry.legacyTurretAngle,
      px: move.position.x,
      py: move.position.y,
      pz: move.position.z,
      qx: sampleOrientation.x,
      qy: sampleOrientation.y,
      qz: sampleOrientation.z,
      qw: sampleOrientation.w,
      vx: move.linearVelocity.x,
      vy: move.linearVelocity.y,
      vz: move.linearVelocity.z,
      ax: move.angularVelocity.x,
      ay: move.angularVelocity.y,
      az: move.angularVelocity.z,
    };
    if (isValidSample(sample)) this.acceptSample(entry, sample, null, performance.now(), false);
  }

  // ------------------------------------------------------------ выстрелы

  /** SmokyModel: FIRE / FIRE_STATIC / FIRE_TARGET уходят на объект оружия; перед попаданием по танку — свежие положение и башня */
  private readonly shotListener: WeaponShotListener = {
    onFire: () => {
      if (!this.spawned || !this.weaponId) return;
      this.client.sendCommand(this.spaceName, this.weaponId, WEAPON_COMMAND.FIRE, (writer) => writer.i32(this.clientTime()));
    },
    onFireStatic: (hitPoint) => {
      if (!this.spawned || !this.weaponId) return;
      this.client.sendCommand(this.spaceName, this.weaponId, WEAPON_COMMAND.FIRE_STATIC, (writer) => {
        writer.i32(this.clientTime());
        writer.vec3(hitPoint);
      });
    },
    onFireTarget: (target, hitLocal, hitWorld) => {
      if (!this.spawned || !this.weaponId) return;
      const entry = this.findEntryByTank(target);
      if (!entry?.tank) return;
      // аргументы снимаются сейчас: повтор конверта шлёт те же байты
      const position = target.getBody().state.position.clone();
      const local = hitLocal.clone();
      const world = hitWorld.clone();
      const time = this.clientTime();
      const incarnation = entry.tank.incarnation;
      this.sendState();
      this.shots.send(
        'smoky',
        this.weaponId,
        WEAPON_COMMAND.FIRE_TARGET,
        [this.shotTarget(entry.userId)],
        (writer) => {
          writer.i32(time);
          writer.i64(entry.userId);
          writer.i16(incarnation);
          writer.vec3(position);
          writer.vec3(local);
          writer.vec3(world);
        },
        this.viewTime(),
      );
    },
  };

  /** RailgunModel: startCharging / fire / fireDummy на объект оружия; перед fire — свежие положение и башня */
  private readonly railgunListener: RailgunShotListener = {
    onStartCharging: () => {
      if (!this.spawned || !this.weaponId) return;
      this.client.sendCommand(this.spaceName, this.weaponId, RAILGUN_COMMAND.START_CHARGING, (writer) => writer.i32(this.clientTime()));
    },
    onShotDummy: () => {
      if (!this.spawned || !this.weaponId) return;
      this.client.sendCommand(this.spaceName, this.weaponId, RAILGUN_COMMAND.FIRE_DUMMY, (writer) => writer.i32(this.clientTime()));
    },
    onShot: (staticHitPoint, targets, hitPoints) => {
      if (!this.spawned || !this.weaponId) return;
      // RailgunModel.onShot: цели — пользователи, точки — в системе цели, плюс поколение, положение цели и мировые точки
      const ids: number[] = [];
      const local: Vector3[] = [];
      const incarnations: number[] = [];
      const positions: Vector3[] = [];
      const world: Vector3[] = [];
      for (let i = 0; i < targets.length; i++) {
        const entry = this.findEntryByTank(targets[i]);
        if (!entry?.tank) continue;
        const body = targets[i].getBody();
        ids.push(entry.userId);
        local.push(globalToLocal(body, hitPoints[i], new Vector3()));
        incarnations.push(entry.tank.incarnation);
        positions.push(body.state.position.clone());
        world.push(hitPoints[i].clone());
      }
      this.sendState();
      // пустые списки уходят как null (Vector.<...> == null в RailgunModel.onShot)
      const has = ids.length > 0;
      const time = this.clientTime();
      const staticPoint = staticHitPoint ? staticHitPoint.clone() : null;
      const write = (writer: ByteWriter): void => {
        const vectors = (items: Vector3[]): void => {
          writer.writeOptionalBit(has ? 0 : 1);
          if (!has) return;
          writer.writeLength(items.length);
          for (const item of items) writer.vec3(item);
        };
        writer.i32(time);
        writer.writeOptionalBit(staticPoint ? 0 : 1);
        if (staticPoint) writer.vec3(staticPoint);
        writer.writeOptionalBit(has ? 0 : 1);
        if (has) {
          writer.writeLength(ids.length);
          for (const id of ids) writer.i64(id);
        }
        vectors(local);
        writer.writeOptionalBit(has ? 0 : 1);
        if (has) {
          writer.writeLength(incarnations.length);
          for (const incarnation of incarnations) writer.i16(incarnation);
        }
        vectors(positions);
        vectors(world);
      };
      // с целями — конвертом с подтверждением (урон), без целей — как раньше (только эффект у других)
      if (has) this.shots.send('railgun', this.weaponId, RAILGUN_COMMAND.FIRE, ids.map((id) => this.shotTarget(id)), write, this.viewTime());
      else this.client.sendCommand(this.spaceName, this.weaponId, RAILGUN_COMMAND.FIRE, write);
    },
  };

  /** TwinsModel.onShot / onShotHit: перед выстрелом — свежие башня и положение (TurretStateCorrectionEvent, StateCorrectionEvent) */
  private readonly twinsListener: TwinsShotListener = {
    onShot: (barrel, shotId, direction) => {
      if (!this.spawned || !this.weaponId || !this.battleActive) return;
      this.sendState();
      this.client.sendCommand(this.spaceName, this.weaponId, TWINS_COMMAND.FIRE, (writer) => {
        writer.i32(this.clientTime());
        writer.i8(barrel);
        writer.i32(shotId);
        writer.vec3(direction);
      });
    },
    onShotHit: (shotId, target, hitPoint) => {
      if (!this.weaponId || !this.battleActive) return;
      const entry = this.findEntryByTank(target);
      if (!entry?.tank) return;
      const position = target.getBody().state.position.clone();
      const point = hitPoint.clone();
      const incarnation = entry.tank.incarnation;
      this.shots.send(
        'twins',
        this.weaponId,
        TWINS_COMMAND.HIT,
        [this.shotTarget(entry.userId)],
        (writer) => {
          writer.i32(shotId);
          writer.i64(entry.userId);
          writer.i16(incarnation);
          writer.vec3(position);
          writer.vec3(point);
        },
        this.viewTime(),
      );
    },
  };

  /** RailgunModel.startCharging / fire / fireDummy чужой рельсы */
  private onRemoteRailgun(event: CommandEvent): void {
    const args = event.args as { shooter_id: number; static_hit_point?: Vec3 | null; target_ids?: number[] | null; target_hit_points?: Vec3[] | null };
    const shooter = this.remotes.get(Number(args.shooter_id));
    const weapon = shooter?.railgun;
    const tank = shooter?.tank;
    if (!weapon || !tank || !tank.isVisible) return;
    if (event.name == 'START_CHARGING') {
      weapon.startCharging(tank.tank);
      return;
    }
    if (event.name == 'FIRE_DUMMY') {
      weapon.fireDummy(tank.tank);
      return;
    }
    // RailgunModel.fire: точки целей из их систем — в мировые; при расхождении длин цели и точки отбрасываются
    let hitPoints: Vector3[] | null = null;
    let targets: (Body | null)[] | null = null;
    const points = args.target_hit_points;
    if (points != null && points.every(isFiniteVec3)) {
      const converted = points.map((p) => new Vector3(p.x, p.y, p.z));
      hitPoints = converted;
      if (args.target_ids != null) {
        targets = args.target_ids.map((id) => this.bodyOfUser(Number(id)));
        if (targets.length == converted.length) {
          targets.forEach((body, i) => {
            if (body) localToGlobal(body, converted[i]);
          });
        } else {
          targets = null;
          hitPoints = null;
        }
      }
    }
    const point = args.static_hit_point;
    const staticHitPoint = point && isFiniteVec3(point) ? new Vector3(point.x, point.y, point.z) : null;
    weapon.fire(tank.tank, staticHitPoint, targets, hitPoints);
  }

  /** тело танка игрока в бою (свой или чужой); null — танка нет */
  private bodyOfUser(userId: number): Body | null {
    if (userId == this.localId) return this.spawned ? this.demo.tank.getBody() : null;
    const tank = this.remotes.get(userId)?.tank;
    return tank?.isVisible ? tank.tank.getBody() : null;
  }

  /**
   * StatisticsModel.objectLoadedPost → startCountdownTimeLimit(timeLeft). time_left сервер посчитал при отправке объекта,
   * а бой мы создаём после загрузки карты и скинов (через туннель — десятки секунд): вычитаем прошедшее с получения время.
   */
  private readTimeLeft(object: { models: Map<number, unknown>; loadedAt?: number }): void {
    const data = object.models.get(STATISTICS_MODEL_ID) as { time_left?: number; limits?: { time_limit_in_sec?: number } } | undefined;
    if (data?.time_left == null) return;
    if (!data.limits?.time_limit_in_sec) {
      this.onTimeLeft(0);
      return;
    }
    const elapsed = object.loadedAt != null ? (performance.now() - object.loadedAt) / 1000 : 0;
    this.onTimeLeft(Math.max(0, data.time_left - elapsed));
  }

  private findEntryByTank(tank: Tank): RemoteEntry | null {
    for (const entry of this.remotes.values()) if (entry.tank?.tank === tank) return entry;
    return null;
  }

  /** SHOOT / SHOOT_STATIC / SHOOT_TARGET чужого оружия: вспышка, отдача, взрыв и толчок цели */
  private onRemoteShot(event: CommandEvent): void {
    const args = event.args as { shooter_id: number; hit_point?: { x: number; y: number; z: number }; target_id?: number; weakening_coff?: number; is_critical_hit?: boolean };
    const shooter = this.remotes.get(args.shooter_id);
    const shooterTank = shooter?.tank;
    if (!shooterTank) return;
    const effects = this.demo.weaponEffects ?? this.smokyEffects;
    // силы — башни стрелка (WeaponCommonCC его оружия), а не своего танка
    const spec = shooterTank.skin.turret.spec;
    const forces = new WeaponForces(spec.impactForce * WEAPON_FORCE_SCALE, spec.kickback * WEAPON_FORCE_SCALE);
    shooterTank.playShot(effects, forces.getRecoilForce());
    const point = args.hit_point;
    if (!point) return;
    if (event.name == 'SHOOT_STATIC') {
      const world = new Vector3(point.x, point.y, point.z);
      effects?.createExplosionEffects(world);
      effects?.createExplosionMark(shooterTank.barrelOrigin, world);
      return;
    }
    // SHOOT_TARGET: точка дана в системе цели
    const targetId = args.target_id ?? 0;
    const target = targetId == this.localUserId() ? this.demo.tank : this.remotes.get(targetId)?.tank?.tank;
    if (!target) return;
    const state = target.getBody().state;
    const euler = new Vector3();
    state.orientation.getEulerAngles(euler);
    const rotation = new Matrix3();
    rotation.setRotationMatrix(euler.x, euler.y, euler.z);
    const world = new Vector3(point.x, point.y, point.z);
    rotation.transformVector(world, world);
    world.add(state.position);
    effects?.createExplosionEffects(world);
    target.applyWeaponHit(world, shooterTank.barrelDirection, forces.getImpactForce() * (args.weakening_coff ?? 1));
    // RemoteSmokyWeapon.simulateTargetShot
    if (args.is_critical_hit) effects?.createCriticalHitEffects(state.position);
  }

  private localUserId(): number {
    return this.localId;
  }

  // ------------------------------------------------------------ приём

  private onCommand(event: CommandEvent): void {
    if (event.spaceName != this.spaceName) return;
    this.commandStatus = event.name ? 'ok' : 'undecoded';
    this.handleCommand(event);
    this.desync?.recordCommand(event.name, event.commandId, this.ownerName(event.objectId), this.commandStatus);
  }

  private handleCommand(event: CommandEvent): void {
    if (!event.name) return;
    if (event.name == 'USER_CONNECTED' || event.name == 'USER_DISCONNECTED') {
      // DM: USER_CONNECTED(user_info_list) / USER_DISCONNECTED(user_id); у командной модели оба называются USER_CONNECTED,
      // уход отличается отсутствием списка
      const args = event.args as { user_id?: number; user_info_list?: StatUserInfo[]; user_infos?: StatUserInfo[]; team?: number } | undefined;
      const list = args?.user_info_list ?? args?.user_infos;
      if (list) this.addUserInfos(list, event.model == STATISTICS_TEAM_MODEL_ID ? args?.team : STAT_TEAM.NONE);
      else if (args?.user_id != null) this.removeStatRow(Number(args.user_id));
      return;
    }
    if (event.name == 'CHANGE_USER_STAT') {
      const args = event.args as { user_info?: StatUserInfo; team?: number } | undefined;
      if (args?.user_info) this.addUserInfos([args.user_info], args.team);
      return;
    }
    if (event.name == 'REFRESH_USERS_STAT') {
      const args = event.args as { user_infos?: StatUserInfo[] } | undefined;
      if (args?.user_infos) this.addUserInfos(args.user_infos);
      return;
    }
    if (event.name == 'CHANGE_TEAM_SCORE') {
      const args = event.args as { team: number; score: number };
      if (args.team == STAT_TEAM.RED) this.teamScores[0] = args.score;
      if (args.team == STAT_TEAM.BLUE) this.teamScores[1] = args.score;
      this.stats?.setTeamScores(...this.teamScores);
      return;
    }
    if (event.name == 'ROUND_FINISH') {
      // StatisticsModel.roundFinish: итоги с наградой (фонд) и отсчётом до нового раунда, таймер боя стоит на нуле
      const args = event.args as { time_to_restart: number; user_infos?: { fund: number; user_id: number }[] };
      const rewards = new Map<number, number>();
      for (const reward of args.user_infos ?? []) rewards.set(Number(reward.user_id), reward.fund);
      this.onTimeStop();
      this.stats?.showFinish(args.time_to_restart, rewards);
      this.log(`бой: раунд окончен, рестарт через ${args.time_to_restart} с`);
      return;
    }
    if (event.name == 'BATTLE_FINISH') {
      this.finishBattle();
      return;
    }
    if (event.name == 'BATTLE_RESTART') {
      this.restartBattle();
      return;
    }
    if (event.name == 'SHOOT' || event.name == 'SHOOT_STATIC' || event.name == 'SHOOT_TARGET') {
      this.onRemoteShot(event);
      return;
    }
    if (event.model == TWINS_MODEL_ID && event.name == 'FIRE') {
      this.onRemoteTwins(event);
      return;
    }
    if (event.model == RAILGUN_MODEL_ID && (event.name == 'START_CHARGING' || event.name == 'FIRE' || event.name == 'FIRE_DUMMY')) {
      this.onRemoteRailgun(event);
      return;
    }
    if (event.name == 'BONUS_TAKEN' || event.name == 'SPAWN_BONUSES' || event.name == 'REMOVE_BONUSES') {
      this.bonuses.onCommand(event.name, event.args);
      return;
    }
    if (event.name == 'ACTIVATE' && event.model == INVENTORY_ITEM_MODEL_ID) {
      // InventoryItemModel.activated: сервер принял применение припаса
      this.inventory?.onActivated(event.objectId);
      return;
    }
    if (event.name == 'ROUND_START') {
      // StatisticsModel.roundStart: новый раунд, таймер с полного лимита
      this.onTimeLeft((event.args as { new_time_limit: number }).new_time_limit);
      this.stats?.hideFinish();
      return;
    }
    if (event.name == 'LOCAL_CRITICAL_HIT') {
      // SmokyModel.localCriticalHit: наш выстрел оказался критическим — эффект в центре цели
      const targetId = (event.args as { target_id: number }).target_id;
      const target = this.remotes.get(targetId)?.tank?.tank;
      if (target) (this.demo.weaponEffects ?? this.smokyEffects)?.createCriticalHitEffects(target.getBody().state.position);
      return;
    }
    if (event.objectId == this.localId) this.onLocalCommand(event);
    else this.onRemoteCommand(event);
  }

  private onLocalCommand(event: CommandEvent): void {
    switch (event.name) {
      case 'PREPARE_TO_SPAWN': {
        const args = event.args as { position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number } };
        this.demo.prepareToSpawn(new Vector3(args.position.x, args.position.y, args.position.z), new Vector3(args.orientation.x, args.orientation.y, args.orientation.z));
        this.log('бой: PREPARE_TO_SPAWN');
        break;
      }
      case 'SPAWN': {
        const args = event.args as SpawnArgs;
        this.incarnation = args.incarnation_id;
        // команды меняются местами между раундами (statistics swap_every_tank_team)
        const team = teamValue(args.team);
        if (team != this.localTeam) {
          this.localTeam = team;
          this.demo.setTeam(team);
          for (const remote of this.remotes.values()) this.applyTeam(remote);
        }
        this.spawned = true;
        this.activated = false;
        this.suicideRequested = false;
        this.demo.spawnFromServer(
          new Vector3(args.position.x, args.position.y, args.position.z),
          new Vector3(args.orientation.x, args.orientation.y, args.orientation.z),
          args.health,
        );
        this.client.sendCommand(this.spaceName, this.localId, TANK_COMMAND.CONFIRM_SPAWN, (writer) => writer.i16(this.incarnation));
        // новая жизнь: состояние пойдёт, когда HEALTH_STATE (следом за SPAWN) скажет её номер
        this.localLife = null;
        this.lifeRequestedAt = performance.now();
        this.nextStateAt = 0;
        this.scheduleActivation();
        this.log(`бой: SPAWN, здоровье ${args.health}, танк в (${args.position.x.toFixed(0)}, ${args.position.y.toFixed(0)}, ${args.position.z.toFixed(0)})`);
        break;
      }
      case 'ACTIVATE_TANK':
        this.activated = true;
        this.inventory?.setLocked(false);
        this.demo.activateFromServer();
        this.log('бой: ACTIVATE_TANK');
        break;
      case 'SET_HEALTH':
        // сервер с HEALTH_STATE шлёт его следом — применяем его (по revision), а не SET_HEALTH
        if (!this.healthRevisions.has(event.objectId)) this.demo.setHealth((event.args as { health: number }).health);
        break;
      case 'KILL': {
        // TankModel.killLocalTank: подтверждаем смерть; труп живёт respawn_delay, затем READY_TO_SPAWN (ReadyToSpawnTask)
        const delay = (event.args as { respawn_delay?: number } | null)?.respawn_delay ?? DEFAULT_RESPAWN_DELAY_MS;
        this.spawned = false;
        this.activated = false;
        this.suicideIndicator?.hide();
        this.inventory?.setLocked(true);
        if (this.activationTimer) clearTimeout(this.activationTimer);
        this.client.sendCommand(this.spaceName, this.localId, TANK_COMMAND.DEATH_CONFIRMATION);
        this.demo.killFromServer(delay, () => {
          // после конца раунда спавн придёт сам с новым раундом (TankSpawnerModel.onBattleFinish снимает ReadyToPlaceTask)
          if (this.stopped || !this.battleActive) return;
          this.client.sendCommand(this.spaceName, this.localId, TANK_COMMAND.READY_TO_SPAWN);
        });
        this.log(`бой: танк уничтожен, новый спавн через ${delay} мс`);
        break;
      }
      case 'SET_SPECIFICATION': {
        const args = event.args as { speed: number; turn_speed: number; turret_rotation_speed: number; acceleration: number; specification_id?: number } | null;
        if (!args) break;
        if (args.specification_id != null) this.specificationId = args.specification_id;
        // нитро и заморозка меняют скорость, поворот, поворот башни и разгон своего танка
        this.demo.setSpecification(args.speed, args.turn_speed, args.turret_rotation_speed, args.acceleration);
        break;
      }
      default:
        this.commandStatus = 'ignored';
        break;
    }
  }

  /**
   * BattleFieldModel.battleFinish → TankModel.onBattleFinish: управление и оружие всех танков блокируются, припасы
   * тоже (InventoryModel.onBattleFinish), ожидающий спавн отменяется. Танки стоят до BATTLE_RESTART.
   */
  private finishBattle(): void {
    this.battleActive = false;
    this.suicideIndicator?.hide();
    if (this.activationTimer) clearTimeout(this.activationTimer);
    this.activationTimer = null;
    this.inventory?.setLocked(true);
    this.demo.finishBattle();
    for (const entry of this.remotes.values()) {
      entry.railgun?.stopEffects();
      this.withRemote(entry, (tank) => tank.freeze());
    }
    this.log('бой: BATTLE_FINISH');
  }

  /**
   * BattleFieldModel.battleRestart → TankModel.onBattleRestart: все танки (живые и трупы) уходят с поля;
   * сервер следом шлёт ROUND_START и каждому PREPARE_TO_SPAWN + SPAWN на новых точках.
   */
  private restartBattle(): void {
    this.battleActive = true;
    this.spawned = false;
    this.activated = false;
    this.inventory?.setLocked(true);
    this.bonuses.removeAll();
    this.demo.restartBattle();
    for (const entry of this.remotes.values()) {
      if (entry.pendingKill) clearTimeout(entry.pendingKill.timer);
      entry.pendingKill = null;
      entry.buffer.clear();
      entry.lastSeen = 0;
      this.withRemote(entry, (tank) => tank.remove());
    }
    this.stats?.hideFinish();
    this.log('бой: BATTLE_RESTART');
  }

  /** TankActivationTask: через tank_activation_delay_in_ms, если танк ни во что не упирается, шлём ACTIVATE */
  private scheduleActivation(): void {
    if (this.activationTimer) clearTimeout(this.activationTimer);
    const tryActivate = (): void => {
      if (!this.spawned) return;
      if (this.demo.getCollisionCount() == 0) {
        this.client.sendCommand(this.spaceName, this.localId, TANK_COMMAND.ACTIVATE);
        this.activationTimer = null;
      } else {
        this.activationTimer = setTimeout(tryActivate, 100);
      }
    };
    this.activationTimer = setTimeout(tryActivate, this.activationDelay);
  }

  private onRemoteCommand(event: CommandEvent): void {
    const entry = this.remotes.get(event.objectId);
    if (!entry) {
      this.commandStatus = 'no-object';
      return;
    }
    switch (event.name) {
      case 'SPAWN': {
        const args = event.args as SpawnArgs;
        entry.team = teamValue(args.team);
        this.applyTeam(entry);
        // новая жизнь: до её первых сэмплов танк стоит в точке спавна
        entry.buffer.clear();
        entry.lastSeen = 0;
        entry.killedAt = 0;
        if (entry.pendingKill) clearTimeout(entry.pendingKill.timer);
        entry.pendingKill = null;
        this.withRemote(entry, (tank) => {
          tank.health = args.health;
          tank.incarnation = args.incarnation_id;
          tank.spawnAt(new Vector3(args.position.x, args.position.y, args.position.z), new Vector3(args.orientation.x, args.orientation.y, args.orientation.z), 0, false);
        });
        break;
      }
      case 'ACTIVATE_TANK':
        this.withRemote(entry, (tank) => tank.activate());
        break;
      case 'MOVE': {
        // старый протокол (не html5-клиент): html5-танки ведут снапшоты
        const move = this.decodeMove(event.args);
        if (move) this.acceptLegacyMove(entry, move);
        break;
      }
      case 'UPDATE_MOVEMENT_CONTROL':
        break;
      case 'ROTATE_TURRET': {
        const args = event.args as { rotate_turret_command?: { angle: number; control: number } } | null;
        const command = args?.rotate_turret_command;
        if (command) {
          entry.legacyTurretAngle = command.angle;
          entry.legacyTurretControl = command.control;
        }
        break;
      }
      case 'SET_HEALTH':
        if (!this.healthRevisions.has(event.objectId)) this.withRemote(entry, (tank) => (tank.health = (event.args as { health: number }).health));
        break;
      case 'SET_SPECIFICATION': {
        const args = event.args as { speed: number; turn_speed: number; turret_rotation_speed: number; acceleration: number } | null;
        if (args) this.withRemote(entry, (tank) => tank.setSpecification(args.speed, args.turn_speed, args.turret_rotation_speed, args.acceleration));
        break;
      }
      case 'KILL': {
        // TankModel.kill для чужого танка: смерть показывается по DEATH_CONFIRMED или через 2 с (DeathConfirmationTimeoutTask)
        const delay = (event.args as { respawn_delay?: number } | null)?.respawn_delay ?? DEFAULT_RESPAWN_DELAY_MS;
        if (entry.pendingKill) clearTimeout(entry.pendingKill.timer);
        // сэмплы этой жизни (снапшот мог уйти до смерти) танк на поле уже не возвращают
        entry.deadLife = entry.life;
        entry.killedAt = performance.now();
        entry.railgun?.stopEffects();
        entry.pendingKill = { delay, timer: setTimeout(() => this.confirmRemoteDeath(entry), DEATH_CONFIRMATION_TIMEOUT_MS) };
        break;
      }
      case 'DEATH_CONFIRMED':
        this.confirmRemoteDeath(entry);
        break;
      default:
        this.commandStatus = 'ignored';
        break;
    }
  }

  private confirmRemoteDeath(entry: RemoteEntry): void {
    const pending = entry.pendingKill;
    if (!pending) return;
    clearTimeout(pending.timer);
    entry.pendingKill = null;
    this.withRemote(entry, (tank) => tank.kill(this.demo.explosionEffects, pending.delay));
  }

  private decodeMove(args: unknown): MoveCommand | null {
    const wrapper = args as { move_command?: { control: number; get_data: { bytes: Uint8Array } } } | null;
    const command = wrapper?.move_command;
    if (!command?.get_data?.bytes) return null;
    return decodeMoveBitArea(command.control, command.get_data.bytes);
  }

  private onObjects(event: ClientEvents['objects']): void {
    if (event.spaceName != this.spaceName) return;
    for (const object of event.added) {
      // объект статистики может прийти позже танков — тогда ники берутся из него здесь
      this.readStatistics(object);
      this.readTimeLeft(object);
      this.bonuses.addObject(object);
      this.addTankObject(object);
      this.inventory?.addObject(object);
      this.addEffectObject(object);
    }
  }

  /**
   * EffectDescriptionModel.objectLoaded: на танке с id tank_game_object_id включился эффект припаса (взятый из ящика или
   * применённый из инвентаря — сервер создаёт один и тот же объект) — значок с оставшимся временем (DurationController).
   */
  private addEffectObject(object: RemoteObject): void {
    const data = object.models.get(EFFECT_DESCRIPTION_MODEL_ID) as { index: number; tank_game_object_id: number | bigint } | undefined;
    if (!data) return;
    const duration = object.models.get(DURATION_CONTROLLER_MODEL_ID) as { time_left_in_ms?: number } | undefined;
    const tankId = Number(data.tank_game_object_id);
    this.effectObjects.set(object.id, { tankId, index: data.index });
    this.setEffectIndicator(tankId, data.index, duration?.time_left_in_ms ?? 0);
  }

  /** EffectStoppedEvent: значок мигает и гаснет; если на танке уже новый такой же эффект (обновление таймера) — не трогаем */
  private removeEffectObject(id: number): void {
    const effect = this.effectObjects.get(id);
    if (!effect) return;
    this.effectObjects.delete(id);
    for (const other of this.effectObjects.values()) if (other.tankId == effect.tankId && other.index == effect.index) return;
    this.setEffectIndicator(effect.tankId, effect.index, null);
  }

  /** leftMs == null — убрать значок */
  private setEffectIndicator(tankId: number, index: number, leftMs: number | null): void {
    if (tankId == this.localId) {
      if (leftMs == null) this.demo.hideEffect(index);
      else this.demo.showEffect(index, leftMs);
      return;
    }
    const entry = this.remotes.get(tankId);
    if (!entry) return;
    this.withRemote(entry, (tank) => {
      if (leftMs == null) tank.title?.hideIndicator(index);
      else tank.title?.showIndicator(index, leftMs);
    });
  }

  private onUnloaded(event: ClientEvents['unloaded']): void {
    if (event.spaceName != this.spaceName) return;
    for (const id of event.ids) {
      this.removeEffectObject(id);
      const entry = this.remotes.get(id);
      if (!entry) continue;
      entry.railgun?.stopEffects();
      this.withRemote(entry, (tank) => tank.dispose());
      this.remotes.delete(id);
      this.log(`бой: игрок ${id} вышел`);
    }
  }

  private addTankObject(object: RemoteObject): void {
    const data = object.models.get(MODEL_ID.TANK) as TankModelData | undefined;
    if (!data || data.local || this.remotes.has(object.id)) return;
    const entry: RemoteEntry = {
      userId: object.id,
      tank: null,
      queue: [],
      pendingKill: null,
      railgun: null,
      twins: null,
      team: teamValue(data.tank_initialization_data?.team),
      buffer: new StateBuffer(),
      life: null,
      deadLife: null,
      killedAt: 0,
      lastSeen: 0,
      snapshotSeen: false,
      legacySeq: 0,
      legacyTurretAngle: 0,
      legacyTurretControl: 0,
    };
    this.remotes.set(object.id, entry);
    this.log(`бой: чужой танк, игрок ${object.id}`);
    Promise.all([this.loadSkin(object), this.createTitle(data.max_health ?? 0)])
      .then(([skin, title]) => {
        if (this.stopped || this.remotes.get(object.id) != entry) {
          title.dispose();
          return;
        }
        const tank = new RemoteTank(object.id, skin, this.world, this.demo.runner, entry.buffer, this.renderTime, this.demo.soundManager.engine);
        this.createRemoteRailgun(entry, skin, data.tank_parts?.weapon_id);
        this.createRemoteTwins(entry, skin, data.tank_parts?.weapon_id);
        tank.title = title;
        this.applyUserInfo(tank);
        const init = data.tank_initialization_data;
        const state = init?.tank_state;
        const newest = entry.buffer.newest;
        tank.health = init?.health ?? 0;
        tank.incarnation = init?.incarnation_id ?? 0;
        if (newest && entry.lastSeen > 0 && performance.now() - entry.lastSeen < MISSING_HIDE_MS) {
          // пока грузился скин, танк уже был в снапшотах — появляется там, где он сейчас
          tank.spawnFromSample(newest, init?.logic_state != 1);
        } else if (state && init?.logic_state) {
          tank.spawnAt(
            new Vector3(state.position.x, state.position.y, state.position.z),
            new Vector3(state.orientation.x, state.orientation.y, state.orientation.z),
            state.turret_angle,
            init.logic_state == 2,
          );
        }
        entry.tank = tank;
        this.applyTeam(entry);
        for (const task of entry.queue) task(tank);
        entry.queue.length = 0;
      })
      .catch((error: unknown) => this.log(`бой: не загрузился скин чужого танка: ${String(error)}`));
  }

  /** RailgunModel.createRemoteWeapon: силы башни, RailgunCC оружия и эффекты своей модификации */
  private createRemoteRailgun(entry: RemoteEntry, skin: TankSkin, weaponId: number | undefined): void {
    const modification = skin.railgunModification;
    if (modification == null) return;
    const data = this.railgunData(weaponId);
    const spec = skin.turret.spec;
    const forces = new WeaponForces(spec.impactForce * WEAPON_FORCE_SCALE, spec.kickback * WEAPON_FORCE_SCALE);
    RailgunEffects.load(modification, this.demo.soundManager, this.demo.effectsScene)
      .then((effects) => {
        if (this.stopped || this.remotes.get(entry.userId) != entry) return;
        entry.railgun = new RemoteRailgunWeapon(forces, data?.charging_time_msec ?? 1200, data?.weakening_coeff ?? 0.202, effects);
      })
      .catch((error: unknown) => this.log(`бой: эффекты рельсы не загружены: ${String(error)}`));
  }

  /** TwinsModel.createRemoteWeapon: отдача и сила удара башни, TwinsCC и ослабление оружия стрелка, общие эффекты */
  private createRemoteTwins(entry: RemoteEntry, skin: TankSkin, weaponId: number | undefined): void {
    if (!skin.isTwins) return;
    const spec = skin.turret.spec;
    const forces = new WeaponForces(spec.impactForce * WEAPON_FORCE_SCALE, spec.kickback * WEAPON_FORCE_SCALE);
    const weapon = new RemoteTwinsWeapon(forces.getRecoilForce(), {
      runner: this.demo.runner,
      effects: null,
      gun: this.twinsGunData(weaponId),
      weakening: this.weakeningData(weaponId),
      impactForce: forces.getImpactForce(),
    });
    entry.twins = weapon;
    this.loadTwinsEffects()
      .then((effects) => (weapon.ammo.effects = effects))
      .catch((error: unknown) => this.log(`бой: эффекты Twins не загружены: ${String(error)}`));
  }

  private twinsEffectsLoading: Promise<TwinsEffects> | null = null;

  /** эффекты чужих Twins: свои, если они уже есть, иначе один общий набор */
  private loadTwinsEffects(): Promise<TwinsEffects> {
    const own = this.demo.twinsEffects;
    if (own) return Promise.resolve(own);
    this.twinsEffectsLoading ??= TwinsEffects.load(this.demo.soundManager, this.demo.effectsScene);
    return this.twinsEffectsLoading;
  }

  /** TwinsModel.objectLoaded: PlasmaGunData в клиентском масштабе */
  private twinsGunData(weaponId: number | undefined): PlasmaGunData {
    const data = weaponId ? (this.client.getSpace(this.spaceName)?.objects.get(Number(weaponId))?.models.get(TWINS_MODEL_ID) as TwinsData | undefined) : undefined;
    const gun = new PlasmaGunData();
    if (data?.distance) gun.shotRange = data.distance * CLIENT_SCALE;
    if (data?.speed) gun.shotSpeed = data.speed * CLIENT_SCALE;
    if (data?.shot_radius != null) gun.shotRadius = data.shot_radius * CLIENT_SCALE;
    return gun;
  }

  /** WeaponWeakeningModel.objectLoaded + getDistanceWeakening */
  private weakeningData(weaponId: number | undefined): DistanceWeakening {
    const data = weaponId
      ? (this.client.getSpace(this.spaceName)?.objects.get(Number(weaponId))?.models.get(WEAPON_WEAKENING_MODEL_ID) as WeakeningData | undefined)
      : undefined;
    if (!data) return new DistanceWeakening();
    const valid = (value: number | undefined): value is number => value != null && !Number.isNaN(value);
    return new DistanceWeakening(
      valid(data.maximum_damage_radius) ? data.maximum_damage_radius * CLIENT_SCALE : 0,
      valid(data.minimum_damage_radius) ? data.minimum_damage_radius * CLIENT_SCALE : 1,
      valid(data.minimum_damage_percent) ? Math.min(100, data.minimum_damage_percent) : 0,
    );
  }

  /** TwinsModel.fire: чужой выстрел (только пока бой идёт и танк виден) */
  private onRemoteTwins(event: CommandEvent): void {
    if (!this.battleActive) return;
    const args = event.args as { shooter_id: number; barrel: number; shot_id: number; shot_direction: Vec3 };
    const shooter = this.remotes.get(Number(args.shooter_id));
    const weapon = shooter?.twins;
    const tank = shooter?.tank;
    if (!weapon || !tank || !tank.isVisible || !args.shot_direction) return;
    const direction = new Vector3(args.shot_direction.x, args.shot_direction.y, args.shot_direction.z);
    weapon.fire(tank.tank, args.barrel, args.shot_id, direction);
  }

  private shotTarget(userId: number): ShotTarget {
    return { userId, life: this.lives.get(userId) ?? UNKNOWN_LIFE };
  }

  /** HEALTH_STATE / SHOT_ACK: абсолютное серверное HP; применяется, только если revision новее уже применённой */
  private applyHealthState(objectId: number, hp: number, revision: number, life: number): void {
    const known = this.healthRevisions.get(objectId);
    if (known !== undefined && revision <= known) return;
    this.healthRevisions.set(objectId, revision);
    this.lives.set(objectId, life);
    if (objectId == this.localId) {
      // номер жизни своего танка уходит в каждом SYNC_STATE (сервер отсекает состояния прошлой жизни)
      if (this.spawned) this.localLife = life;
      this.demo.setHealth(hp);
      return;
    }
    const entry = this.remotes.get(objectId);
    if (!entry) return;
    if (entry.life == null || life > entry.life) entry.life = life;
    this.withRemote(entry, (tank) => (tank.health = hp));
  }

  /** журнал попаданий для отладки (__tanki.shots()) */
  get shotRecords(): ShotRecord[] {
    return this.shots.records();
  }

  get shotSummary(): string {
    return this.shots.summary();
  }

  private withRemote(entry: RemoteEntry, task: (tank: RemoteTank) => void): void {
    if (entry.tank) task(entry.tank);
    else entry.queue.push(task);
  }

  get remoteCount(): number {
    return this.remotes.size;
  }
}

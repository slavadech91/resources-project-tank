import {CtfState} from './ctf.ts';
import { BotWorld, type BotParticipant } from './botWorld.ts';
import type { BotEquipment, BotHull, BotPaint, BotProfile } from './botProfile.ts';
import { ISIDA_DEFAULT } from '../../../html5/src/net2/isida.ts';
/**
 * Бой server2: игроки и их танки, спавн (battle.ready → prepare → через spawnDelayMs spawn → battle.activate),
 * синхронизация v2 (состояние своего танка с проверкой скорости, снапшоты 20 Гц, история положений для компенсации
 * лага), выстрелы Смоки / рельсы / Twins, урон, смерть и статистика. Формулы и допуски — как у старого сервера
 * (sync_service.py, weapon_common / smoky / railgun / twins / weapon_weakening, tank_global_model.damage_tank).
 */
import {
  CHAT_KIND,
  EFFECT,
  TEAM,
  type ActiveEffectInfo,
  type BattleInfo,
  type BattlePlayer,
  type BattleRoundPlayer,
  type BattleSummary,
  type BattleTeam,
  type BattleUserSummary,
  type BonusInfo,
  type BonusKind,
  type ChatKind,
  type EffectIndex,
  type EventName,
  type Events,
  type InventoryItemInfo,
  type KillReason,
  type MineInfo,
  type ShotHit,
  type ShotResult,
  type TankState,
  type UserInfo,
  type Vec3,
  type WeaponInfo,
} from '../../../html5/src/net2/protocol.ts';
import { FRAME, encodeSnapshot, encodeState } from '../../../html5/src/net2/battleCodec.ts';
import { Matrix3 } from '../../../html5/src/physics/math/Matrix3.ts';
import { Vector3 } from '../../../html5/src/physics/math/Vector3.ts';
import { RayHit } from '../../../html5/src/physics/collision/types.ts';
import type { TanksCollisionDetector } from '../../../html5/src/tanks/physics/TanksCollisionDetector.ts';
import { isValidSample, seqNewer, type SyncSample } from '../../../html5/src/tanks/net/sync/SyncProtocol.ts';
import type { BattleTimings, InventoryKind, InventorySlotConfig } from '../config.ts';
import { RequestError } from '../errors.ts';
import { log, logError } from '../log.ts';
import type { Session } from '../net/session.ts';
import type { Loadout } from './loadout.ts';
import { inKillZone, spawnsFor, type MapData, type SpawnPoint } from './mapData.ts';
import { bonusDropPosition, bonusZoneKey } from '../../../html5/src/map/bonusDrop.ts';

const SNAPSHOT_INTERVAL_MS = 50;
/** история положений для компенсации лага */
const HISTORY_MS = 1500;
/** состояние «из будущего» дальше этого — время снятия заменяется временем приёма */
const MAX_SAMPLE_AHEAD_MS = 500;
/** проверка скорости: путь не длиннее (скорость корпуса · 2 + 10 м/с) · dt + 3 м; три нарушения подряд — коррекция */
const SPEED_FACTOR = 2;
const SPEED_ALLOWANCE_CM = 1000;
const DISTANCE_ALLOWANCE_CM = 300;
const VIOLATIONS_BEFORE_CORRECTION = 3;
/** проверка стен: рыскаем лучом только на больших скачках за одно состояние (обычно 50 см при 10 м/с) */
const WALL_MIN_MOVE_CM = 250;
/** нормаль поверхности «стена» — наклон больше 53° от вертикали; пол и пандусы пропускаем */
const WALL_MAX_UP_NORMAL = 0.6;
/** у самой цели луч в стену не считается: танк стоит вплотную */
const WALL_END_ALLOWANCE_CM = 40;
/** попадание: цель в истории на view_time стрелка не дальше 4 м (+ путь за 50 мс), иначе старая проверка */
const LAG_COMPENSATED_ALLOWANCE_CM = 400;
const LAG_COMPENSATED_SPEED_SEC = 0.05;
/** maximum_allowed_tank_position_difference + путь с последнего состояния (не больше 2,5 с) и за 0,5 с задержки */
const POSITION_DIFFERENCE_CM = 1500;
const MAX_STATE_AGE_SEC = 2.5;
const NETWORK_LAG_SEC = 0.5;
/** выстрел раньше перезарядки: допуск на джиттер сети */
const RELOAD_TOLERANCE = 0.8;
const RELOAD_JITTER_MS = 50;
/** очередь отправки игрока больше — снапшот пропускается (медленная сеть) */
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_TWINS_SHOTS = 32;
const MAX_RAIL_TARGETS = 16;
/** Temperature.apply_temperature_effects: шаг остывания/заморозки, мс */
const TEMPERATURE_TICK_MS = 200;
// Патч 469: 1000 HP сразу и 3000 HP за 3 с. В проекте HP в масштабе до обновления 2016 года (÷10).
const REPAIR_INSTANT_HP = 100;
const REPAIR_DURATION_MS = 3000;
const REPAIR_TICK_MS = 250;
const REPAIR_TICK_HP = 25;
/** потоковая пушка: допуск к интервалу тика (джиттер сети) */
const STREAM_TICK_TOLERANCE_MS = 80;
/** потоковая пушка: сколько целей в конусе принимаем за тик */
const MAX_STREAM_TARGETS = 8;
/** сколько живёт зарегистрированный выстрел Рикошета */
const RICOCHET_SHOT_LIFE_MS = 5000;
/** фонд нового боя (StatisticsGlobalModel.fund = 100); новые раунды начинаются с 0 */
export const INITIAL_FUND = 100;

/** что бой делает с профилями игроков (база и события user) */
export interface BattleHooks {
  /** опыт за уничтожение (user_property_model.add_buffered_score) */
  addKillScore(session: Session, userId: number, score: number): void;
  /** кристаллы из фонда в конце раунда (StatisticsModel.give_fund_to_users) */
  giveFund(entries: { session: Session; userId: number; crystals: number }[]): void;
  /** кристаллы за ящик (BattleFieldBonusGlobalModel.add_crystals_to_user_id) */
  giveCrystals(session: Session, userId: number, crystals: number): void;
  /** припас из инвентаря израсходован (UserItems.count − 1) */
  consumeItem(session: Session, userId: number, itemId: number): void;
}

/** Ящик занимает зону с момента появления до подбора или очистки раунда. */
interface BattleBonus {
  id: number;
  kind: BonusKind;
  position: Vec3;
  spawnedAt: number;
  zoneKey: string;
}

/** слот инвентаря игрока: припас, счётчик и перезарядка (InventoryItemModel) */
interface InventorySlot {
  index: number;
  itemId: number;
  kind: InventoryKind;
  cooldownMs: number;
  count: number;
  /** серверное время готовности (Date.now) */
  readyAt: number;
}

/** мина на поле (mine.Mine + BattleMinesGlobalModel) */
interface BattleMine {
  id: number;
  ownerId: number;
  team: BattleTeam;
  position: Vec3;
  activated: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * battle_fund_calculator.calculate_blue_and_red_fund: слабейшая команда получает четверть доли от счёта,
 * остальное — победившей; при равном счёте фонд делится пополам.
 */
export function splitTeamFund(blueScore: number, redScore: number, fund: number): [number, number] {
  if (blueScore === redScore) return [fund / 2, fund / 2];
  if (blueScore <= redScore) {
    const blue = Math.trunc((blueScore / redScore) * fund * 0.25);
    return [blue, fund - blue];
  }
  const red = Math.trunc((redScore / blueScore) * fund * 0.25);
  return [fund - red, red];
}

/** battle_fund_calculator.share_battle_fund_between_tanks: доля score^1.5, остаток — игроку с лучшим счётом */
export function shareFund(scores: number[], fund: number): number[] {
  const rewards = new Array<number>(scores.length).fill(0);
  if (!scores.length) return rewards;
  const total = scores.reduce((sum, score) => sum + Math.pow(score, 1.5), 0);
  if (!total || !fund) return rewards;
  let given = 0;
  for (let i = 0; i < scores.length; i++) {
    rewards[i] = Math.floor((fund * Math.pow(scores[i], 1.5)) / total);
    given += rewards[i];
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  rewards[best] += Math.floor(fund - given);
  return rewards;
}

/** серверное время боя, мс (монотонное, общее для часов всех клиентов) */
export function serverMs(): number {
  return Math.round(performance.now()) | 0;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function uniform(from: number, to: number): number {
  return from + Math.random() * (to - from);
}

/** как Quaternion.getEulerAngles клиента (sync_service.quaternion_to_euler) */
function quaternionToEuler(x: number, y: number, z: number, w: number): Vec3 {
  const xx = 2 * x * x, yy = 2 * y * y, zz = 2 * z * z;
  const xy = 2 * x * y, yz = 2 * y * z, zx = 2 * z * x;
  const wx = 2 * w * x, wy = 2 * w * y, wz = 2 * w * z;
  const a = 1 - yy - zz;
  const b = xy - wz;
  const e = xy + wz;
  const f = 1 - xx - zz;
  const i = zx - wy;
  const j = yz + wx;
  const k = 1 - xx - yy;
  if (i > -1 && i < 1) return { x: Math.atan2(j, k), y: -Math.asin(i), z: Math.atan2(e, a) };
  return { x: 0, y: (i <= -1 ? Math.PI : -Math.PI) * 0.5, z: Math.atan2(-b, f) };
}

/** WeaponWeakening.get_impact_coeff: множитель урона по расстоянию (см) */
function weakening(distanceCm: number, weapon: WeaponInfo): number {
  const d = distanceCm / 100;
  const falloff = weapon.minDamageRadius - weapon.maxDamageRadius;
  if (falloff <= 0 || d <= weapon.maxDamageRadius) return 1;
  if (d >= weapon.minDamageRadius) return 0.01 * weapon.minDamagePercent;
  return 0.01 * (weapon.minDamagePercent + ((weapon.minDamageRadius - d) * (100 - weapon.minDamagePercent)) / falloff);
}

class Player {
  readonly session: Session;
  readonly userId: number;
  readonly name: string;
  readonly rank: number;
  readonly loadout: Loadout;
  team: BattleTeam;
  state: TankState = 'out';
  life = 0;
  health = 0;
  position: Vec3 | null = null;
  orientation: Vec3 | null = null;
  kills = 0;
  deaths = 0;
  score = 0;
  /** последнее принятое состояние и серверное время его приёма */
  last: { sample: SyncSample; received: number } | null = null;
  history: SyncSample[] = [];
  violations = 0;
  /** battle.prepare отправлен, ждём спавна */
  preparing = false;
  pendingSpawn:SpawnPoint|null=null;
  spawnedAt = 0;
  deadUntil = 0;
  lastShotAt = -Infinity;
  chargeAt = -Infinity;
  readonly twinsShots = new Map<number, { at: number; origin: Vec3 | null; used: boolean }>();
  readonly ricochetShots = new Map<number, { at: number; origin: Vec3 | null; used: boolean }>();
  /** Рикошет: запас энергии шара (ёмкость 1000, зарядка 100/с) */
  ricochetEnergy = 0;
  ricochetEnergyAt = 0;
  /** потоковая пушка: энергия, тик урона и трансляция струи */
  streamEnergy = 0;
  streamEnergyAt = 0;
  streamFiring = false;
  lastStreamTickAt = -Infinity;
  flameTicksLeft = 0;
  lastStreamEventAt = 0;
  streamTargetIds: number[] = [];
  isidaTarget: ShotHit | null = null;
  isidaTickAt = 0;
  isidaTicksLeft = 0;
  sentTemperature = 0;
  isidaDrain = ISIDA_DEFAULT.dischargeIdleRate;
  /** Шафт: прицельный режим и запас энергии */
  shaftAiming = false;
  shaftDrainAt = 0;
  shaftEnergy = 0;
  shaftEnergyAt = 0;
  /** температура: поджиг Огнемётом (положительная) и заморозка Фризом (отрицательная) */
  heat = 0;
  heatSource: Player | null = null;
  lastBurnAt = 0;
  cold = 0;
  coldSource: Player | null = null;
  /** параметры последнего источника температуры (FreezeModelCC / FlameThrowerModelCC) */
  coldMinTemperature = -5;
  coldBodyMaxFreezing = 0.1;
  coldTurretMaxFreezing = 0.1;
  coldDefrosting = 0.3;
  heatLimit = 0.281818;
  heatCooling = 0.016;
  burnMin = 3;
  burnMax = 6;
  /** последний отправленный клиентам множитель скорости (нитро × заморозка) */
  sentSpeedFactor = 1;
  timers = new Set<ReturnType<typeof setTimeout>>();
  suicideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Действующие эффекты припасов и время их окончания. */
  readonly effects = new Map<EffectIndex, { timer: ReturnType<typeof setTimeout>; endsAt: number }>();
  /** инвентарь боя: клавиши 1–5, количество из гаража и перезарядка */
  readonly inventory: InventorySlot[] = [];

  constructor(session: Session, user: UserInfo, loadout: Loadout, team: BattleTeam, inventory: InventorySlotConfig[],readonly isBot=false) {
    this.session = session;
    this.userId = user.id;
    this.name = user.name;
    this.rank = user.rank;
    this.loadout = loadout;
    this.team = team;
    for (const rule of inventory) {
      this.inventory.push({ index: rule.index, itemId: rule.itemId, kind: rule.kind, cooldownMs: rule.cooldownMs, count: loadout.inventoryCounts.get(rule.itemId) ?? 0, readyAt: 0 });
    }
  }

  get alive(): boolean {
    return this.state === 'spawned' || this.state === 'active';
  }

  later(ms: number, task: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      task();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.suicideTimer = null;
  }
}

export class Battle {
  readonly summary: BattleSummary;
  readonly map: MapData;
  private readonly timings: BattleTimings;
  private readonly onPlayersChanged: (battle: Battle) => void;
  private readonly hooks: BattleHooks;
  private readonly players = new Map<number, Player>();
  private botDefinition:{profile:BotProfile;equipment:BotEquipment[];hulls:BotHull[];paints:BotPaint[]}|null=null;
  private readonly botGuns = new Map<number, BotEquipment['gun']>();
  private readonly botProfiles = new Map<number,BotProfile>();
  private nextBotShotId = 0;
  private botWorld:BotWorld|null=null;
  private botTimer:ReturnType<typeof setInterval>|null=null;
  private botTime=0;
  private botAccumulator=0;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private temperatureTimer: ReturnType<typeof setInterval> | null = null;
  private ctf:CtfState|null=null;
  private teamScores: [number, number] = [0, 0];
  private roundStartedAt = Date.now();
  private fund = INITIAL_FUND;
  /** раунд идёт: между итогами и новым раундом выстрелы и спавн не принимаются (BattleFieldModel.active) */
  private roundActive = true;
  private roundTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAt = 0;
  /** ящики на поле (BattleFieldBonusGlobalModel.bonuses_by_id) */
  private readonly bonuses = new Map<number, BattleBonus>();
  private bonusId = 0;
  private supplyTimer: ReturnType<typeof setInterval> | null = null;
  /** отложенные выпадения золота: каждый fund change может запланировать своё (old: threading.Timer на бросок) */
  private readonly goldTimers = new Set<ReturnType<typeof setTimeout>>();
  /** try_drop_crystal_box: счётчик изменений фонда (старый сервер его не сбрасывает после выпадения) */
  private fundChangesSinceCrystal = 0;
  private pendingCrystalDrops = 0;
  private fundChangesSinceGold=0;
  /** мины на поле (BattleMinesGlobalModel.mines_by_id) */
  private readonly mines = new Map<number, BattleMine>();
  private mineId = 0;
  /** статика карты для лучей (мины, проверка стен); null — карта без геометрии столкновений */
  private readonly detector: TanksCollisionDetector | null;
  private readonly down = new Vector3(0, 0, -1);
  private readonly mineOrigin = new Vector3();
  private readonly tankPoint = new Vector3();
  private readonly mineHit = new RayHit();
  private readonly wallOrigin = new Vector3();
  private readonly wallDirection = new Vector3();
  private readonly wallHit = new RayHit();
  private readonly localPoint = new Vector3();
  private readonly localMatrix = new Matrix3();

  constructor(summary: BattleSummary, map: MapData, timings: BattleTimings, onPlayersChanged: (battle: Battle) => void, hooks: BattleHooks, detector: TanksCollisionDetector | null = null) {
    this.summary = summary;
    this.map = map;
    this.timings = timings;
    this.onPlayersChanged = onPlayersChanged;
    this.hooks = hooks;
    this.detector = detector;
    if(summary.mode==='ctf'&&map.flagBases)this.ctf=new CtfState(map.flagBases,
      (a,b)=>!this.detector?.raycastStatic(new Vector3(a.x,a.y,a.z),new Vector3(b.x-a.x,b.y-a.y,b.z-a.z),255,.999,null,new RayHit()),
      p=>{const hit=new RayHit();if(!this.detector?.raycastStatic(new Vector3(p.x,p.y,p.z+50),this.down,255,100000,null,hit))return null;const q=hit.position;return inKillZone(this.map,q)?null:{x:q.x,y:q.y,z:q.z+50};},
      (action,flag,player)=>this.broadcast('battle.flags',{flags:this.flagsInfo(),action,flagTeam:flag.team,userId:player?.userId,name:player?this.players.get(player.userId)?.name:undefined}),
      p=>{this.teamScores[p.team as 0|1]++;this.broadcast('battle.teamScore',{scores:[...this.teamScores]});this.onPlayersChanged(this);if(this.summary.scoreLimit>0&&this.teamScores[p.team as 0|1]>=this.summary.scoreLimit)this.endRound();});
  }

  configureBots(profile:BotProfile,loadout:Loadout,equipment:BotEquipment[]=[{loadout,gun:profile}],hulls:BotHull[]=[],paints:BotPaint[]=[]):void{
    const restricted=this.summary.equipmentConstraintsMode && this.summary.equipmentConstraintsMode!=='NONE';
    this.botDefinition??={profile,equipment:restricted?equipment.slice(0,1):equipment,hulls:restricted?[]:hulls,paints};
  }

  private ensureBots():void{
    const count=this.summary.botCount??0,definition=this.botDefinition;
    if(!count||!definition||this.botWorld)return;
    this.botWorld=new BotWorld(this.map,definition.profile,(id,sample)=>{
      const p=this.players.get(id);if(p)this.acceptState(p.session,sample);
    }, (id, hit, targets, shot) => {
      const player = this.players.get(id);
      if (!player) return;
      const targetHits = targets.flatMap((target) => {
        const victim = this.players.get(target.id);
        return victim?.position
          ? [{ userId: victim.userId, life: victim.life, position: victim.position, local: target.local, world: target.world }]
          : [];
      });
      const {session} = player;
      const weapon = player.loadout.weapon;
      const target = targetHits[0] ?? null;
      const time = serverMs();
      switch (weapon.kind) {
        case 'railgun': this.rail(session, time, hit, targetHits, false); break;
        case 'smoky': this.smoky(session, time, hit, target); break;
        case 'thunder': this.thunder(session, time, hit, target); break;
        case 'shaft': this.shaft(session, time, shot.aimed&&player.shaftAiming, hit, targetHits); break;
        case 'twins':
        case 'ricochet': {
          const shotId = ++this.nextBotShotId;
          const twins = weapon.kind === 'twins';
          if (twins) this.twins(session, shot.barrel, shotId, shot.direction);
          else this.ricochet(session, shotId, shot.direction);
          const speed = (twins ? weapon.twins?.speed : weapon.ricochet?.speed) ?? 0;
          if ((twins ? player.twinsShots : player.ricochetShots).has(shotId)) {
            this.botWorld?.launchProjectile(id,shotId,shot.origin,shot.direction,speed,
              (twins?weapon.twins?.distance:weapon.ricochet?.range)??0,!twins);
          }
          break;
        }
        case 'isida':
          if (player.isidaTarget?.userId !== target?.userId || player.isidaTarget?.life !== target?.life) this.isidaTarget(session, time, target, shot.origin);
          this.streamTick(session, time, targetHits, shot.origin);
          if (player.isidaTarget && player.isidaTicksLeft <= 0) this.streamStop(session);
          break;
        case 'firebird':
        case 'freeze': this.streamTick(session, time, targetHits, shot.origin); break;
      }
      if (weapon.stream) {
        if (player.streamFiring && this.streamEnergyNow(player) <= 0) this.streamStop(session);
        if (!player.streamFiring) this.botWorld?.streamDepleted(id, weapon.stream.rechargeMs);
      }
    },Math.random,(id,bonusId)=>{const p=this.players.get(id);if(p)this.takeBonus(p.session,bonusId);},id=>{
      const p=this.players.get(id);if(!p)return;
      if(p.loadout.weapon.kind==='shaft')this.shaftAim(p.session,true);else this.railCharge(p.session);
    },(id,active)=>{
      const p=this.players.get(id);
      if(!p)return;
      if(active)this.streamStart(p.session);else this.streamStop(p.session);
    },(shooter,shotId,hit,bounces)=>{
      const player=this.players.get(shooter),victim=this.players.get(hit.id);
      if(!player||!victim?.position)return;
      const target={userId:hit.id,life:victim.life,position:victim.position,local:hit.local,world:hit.world};
      if(player.loadout.weapon.kind==='twins')this.twinsHit(player.session,serverMs(),shotId,target);
      else this.ricochetHit(player.session,serverMs(),shotId,target,bounces);
    },id=>{const player=this.players.get(id);if(player?.alive)this.kill(player,'suicide',null);},id=>{
      const player=this.players.get(id);if(player?.alive)this.suicide(player.session);
    });
    const equipment = [...definition.equipment];
    for (let i = equipment.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [equipment[i], equipment[j]] = [equipment[j], equipment[i]];
    }
    const usedKinds=new Set<string>();
    const names=['Maksim_77','veterok','Sanych','Kedr','LunarFox','NORD','Serj_92','miron','Yar-13','Kruk','Vega_5','Snegir','Pilot_34','Kosoy','Antei','Orionik','sova24','Kvant','Nikita_R','Sokolov','Buran','Shum','Neon_42','Leshiy','Kamen','vlad_07','Zarya','Granit','Stepan_56','alex-t','Volna','k0met','Rys-9','Korsar','Tuman','Solo_89','Don_48','Skif','Juno','Vint','Rostik','Moryak','Stinger','Rami','Fokus','Rubin','Serg_161','Klin','Barsik','Klever','Minty','Razgon','Zevs_31','Rus_44','Bereg','Nemo','M1ha','Atlas_18','Krot','Tolik_63','Gorizont','Povorot','Amber_21','Shtil'];
    const occupiedNames=new Set([...this.players.values()].map(p=>p.name.toLowerCase()));
    const availableNames=names.filter(name=>!occupiedNames.has(name.toLowerCase()));
    for(let i=0;i<count;i++){
      const id=0xf0000000+i;
      const capacity=this.teamMode?Math.floor(this.summary.maxPeople/2):this.summary.maxPeople;
      const slots=(this.teamMode?[TEAM.RED,TEAM.BLUE]:[TEAM.NONE]).map(team=>{
        const members=[...this.players.values()].filter(p=>p.team===team);
        return {team,free:capacity-members.length-(members.some(p=>!p.isBot)?0:1)};
      }).sort((a,b)=>b.free-a.free);
      if(slots[0].free<=0)break;
      const anchor=[...this.players.values()].find(p=>!p.isBot)?.rank??1;
      const low=Math.max(this.summary.minRank,anchor-3),high=Math.min(this.summary.maxRank,anchor+4);
      const rank=low+Math.floor(Math.random()*(high-low+1));
      const name=availableNames.splice(Math.floor(Math.random()*availableNames.length),1)[0]??`Tanker_${id}`;
      const user:UserInfo={id,name,rank,score:0,rankScore:0,nextRankScore:100,crystals:0,admin:false};
      const session={user,isOpen:false,ws:{bufferedAmount:0,sendBinary:()=>{}},send:()=>{}} as unknown as Session;
      const available=equipment.filter(entry=>entry.minRank===undefined||entry.minRank<=rank);
      const fresh=available.find(entry=>!usedKinds.has(entry.loadout.weapon.kind));
      if(!fresh)usedKinds.clear();
      const kind=(fresh??available[0]).loadout.weapon.kind;
      usedKinds.add(kind);
      const selected=available.filter(entry=>entry.loadout.weapon.kind===kind).sort((a,b)=>(b.minRank??0)-(a.minRank??0))[0];
      const hulls=new Map<string|undefined,BotHull>();
      for(const hull of definition.hulls)if(hull.minRank<=rank&&(hulls.get(hull.loadout.hullKind)?.minRank??-1)<hull.minRank)hulls.set(hull.loadout.hullKind,hull);
      const choices=[...hulls.values()];
      const hull=choices[i%choices.length];
      let loadout=hull?{...selected.loadout,hullKind:hull.loadout.hullKind,mass:hull.loadout.mass,size:hull.loadout.size,
        speed:hull.loadout.speed,maxHealth:hull.loadout.maxHealth,parts:{...selected.loadout.parts,hull:hull.loadout.parts.hull}}:selected.loadout;
      if(hull)this.botProfiles.set(id,{...definition.profile,...hull.profile});
      const paint=definition.paints[Math.floor(Math.random()*definition.paints.length)];
      if(paint)loadout={...loadout,parts:{...loadout.parts,paint:paint.id},resistances:paint.resistances};
      this.botGuns.set(id,selected.gun);
      const player=new Player(session,user,loadout,slots[0].team,[],true);
      this.players.set(id,player);this.broadcast('battle.player',{player:this.playerInfo(player)});this.ready(session);
    }
    this.botTime=Date.now();this.botAccumulator=0;
    this.botTimer=setInterval(()=>{try{this.updateBots();}catch(error){logError('bots',String(error));}},33);
  }

  private stopBots():void{
    if(this.botTimer)clearInterval(this.botTimer);this.botTimer=null;
    this.botWorld?.clear();this.botWorld=null;
    this.botGuns.clear();
    this.botProfiles.clear();
    for(const [id,p] of this.players)if(p.isBot){p.clearTimers();this.players.delete(id);}
  }

  private updateBots():void{
    const now=Date.now();this.botAccumulator+=Math.min(200,Math.max(0,now-this.botTime));this.botTime=now;
    if(!this.roundActive){this.botAccumulator=0;return;}
    for(const p of this.players.values())if(p.isBot&&!p.alive&&!p.preparing&&now>=p.deadUntil)this.ready(p.session);
    while(this.botAccumulator>=33&&this.botWorld){
      this.botAccumulator-=33;
      const players:BotParticipant[]=[...this.players.values()].map(p=>({id:p.userId,team:p.team,state:p.state,life:p.life,health:p.health,position:p.position,orientation:p.orientation,sample:p.last?.sample??null,loadout:p.loadout,speedFactor:p.sentSpeedFactor,shotAt:p.lastShotAt}));
      this.botWorld.step(players,serverMs()-Math.floor(this.botAccumulator),now-Math.floor(this.botAccumulator),{bonuses:this.bonusesInfo(),fallSpeed:this.timings.bonusFallSpeed,flags:this.flagsInfo()});
    }
  }

  getTeamScores():[number,number] {return [...this.teamScores];}

  get playerCount(): number {
    return this.players.size;
  }

  private get teamMode(): boolean {
    return this.summary.mode !== 'dm';
  }

  /** игроков по командам: [красные, синие]; в DM все в первом */
  counts(): [number, number] {
    const counts: [number, number] = [0, 0];
    for (const player of this.players.values()) counts[player.team === TEAM.BLUE ? 1 : 0]++;
    return counts;
  }

  /** кто сейчас в бою — окно информации о бое в лобби */
  userSummaries(): BattleUserSummary[] {
    return [...this.players.values()].map((player) => ({ userId: player.userId, name: player.name, rank: player.rank, kills: player.kills, score:player.score, team: player.team }));
  }

  /** команда входящего: в DM — без команды; в TDM — запрошенная, если в ней есть место, иначе меньшая */
  pickTeam(userId: number, requested: BattleTeam | undefined): BattleTeam {
    const counts: [number,number] = [0,0];
    for(const p of this.players.values())if(!p.isBot)counts[p.team===TEAM.BLUE?1:0]++;
    const existing = this.players.get(userId);
    if (existing) counts[existing.team === TEAM.BLUE ? 1 : 0]--;
    if (!this.teamMode) {
      if (counts[0] >= this.summary.maxPeople) throw new RequestError('forbidden', 'бой заполнен');
      return TEAM.NONE;
    }
    const perTeam = Math.max(1, Math.floor(this.summary.maxPeople / 2));
    const free = (team: 0 | 1): boolean => counts[team] < perTeam;
    if ((requested === TEAM.RED || requested === TEAM.BLUE) && free(requested) && (this.summary.autoBalance===false || counts[requested]<=counts[1-requested])) return requested;
    const smaller: 0 | 1 = counts[0] <= counts[1] ? 0 : 1;
    if (free(smaller)) return smaller;
    throw new RequestError('forbidden', 'бой заполнен');
  }

  add(session: Session, user: UserInfo, loadout: Loadout, team: BattleTeam): BattleInfo {
    const previous = this.players.get(user.id);
    if (previous) this.remove(previous.session);
    const player = new Player(session, user, loadout, team, this.timings.inventory);
    const limit=this.teamMode?Math.floor(this.summary.maxPeople/2):this.summary.maxPeople;
    const members=[...this.players.values()].filter(p=>p.team===team);
    if(members.length>=limit){
      const bot=members.find(p=>p.isBot);
      if(bot){this.botWorld?.remove(bot.userId);this.botGuns.delete(bot.userId);this.botProfiles.delete(bot.userId);this.remove(bot.session);}
    }
    if (!this.players.size) this.beginRound();
    this.players.set(user.id, player);
    this.ensureBots();
    this.broadcast('battle.player', { player: this.playerInfo(player) }, player);
    this.snapshotTimer ??= setInterval(() => this.sendSnapshots(), SNAPSHOT_INTERVAL_MS);
    this.startTemperatureLoop();
    this.onPlayersChanged(this);
    log('battle', `${user.name}: вошёл в бой ${this.summary.id} «${this.summary.name}» (${this.players.size} в бою)`);
    return this.info(player);
  }

  /** выход игрока (сам, закрыл соединение, вошёл в другой бой) */
  remove(session: Session): void {
    const userId = session.user?.id;
    const player = userId != null ? this.players.get(userId) : undefined;
    if (!player || player.session !== session) return;
    this.ctf?.drop(player);
    player.clearTimers();
    this.removeUserMines(player.userId);
    this.players.delete(player.userId);
    this.broadcast('battle.playerLeft', { userId: player.userId });
    if (![...this.players.values()].some(p=>!p.isBot)) {
      this.stopBots();
      if (this.snapshotTimer) clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
      if (this.temperatureTimer) clearInterval(this.temperatureTimer);
      this.temperatureTimer = null;
      this.pauseRound();
    }
    this.onPlayersChanged(this);
    log('battle', `${player.name}: вышел из боя ${this.summary.id}`);
  }

  /** бой удалён: все игроки вне боя */
  close(): Session[] {
    this.stopBots();
    const sessions = [...this.players.values()].map((player) => player.session);
    for (const player of this.players.values()) {
      player.clearTimers();
      player.session.send('battle.closed', { battleId: this.summary.id });
    }
    this.players.clear();
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
    if (this.temperatureTimer) clearInterval(this.temperatureTimer);
    this.temperatureTimer = null;
    if (this.supplyTimer) clearInterval(this.supplyTimer);
    this.supplyTimer = null;
    for (const timer of this.goldTimers) clearTimeout(timer);
    this.goldTimers.clear();
    this.bonuses.clear();
    for (const mine of this.mines.values()) clearTimeout(mine.timer);
    this.mines.clear();
    this.clearRoundTimers();
    return sessions;
  }

  info(viewer: Player | null = null): BattleInfo {
    const limit = this.summary.timeLimitSec;
    const now = Date.now();
    return {
      battle: this.summary,
      mapKey: this.map.key,
      players: [...this.players.values()].map((player) => this.playerInfo(player)),
      flags:this.flagsInfo(),
      teamScores: [...this.teamScores],
      timeLeftSec: this.roundActive && limit ? Math.max(0, limit - (now - this.roundStartedAt) / 1000) : 0,
      fund: this.fund,
      roundEndInSec: this.roundActive ? null : Math.max(0, Math.ceil((this.restartAt - now) / 1000)),
      bonuses: [...this.bonuses.values()].map((bonus) => this.bonusInfo(bonus)),
      bonusRegions: this.map.bonusRegions
        .filter(region => !region.modes.length || region.modes.includes(this.summary.mode))
        .map(({ position, rotation, min, max, modes, bonusTypes }) => ({ position, rotation, min, max, gameModes: modes, bonusTypes })),
      bonusFallSpeed: this.timings.bonusFallSpeed,
      inventory: viewer ? viewer.inventory.map((slot) => this.inventoryInfo(slot)) : [],
      mines: this.minesInfo(),
      activationDelayMs: this.timings.activationDelayMs,
      respawnDelayMs: this.timings.deadTimeMs,
      friendlyFire: this.summary.friendlyFire??false,
    };
  }

  /** сверка ящиков после загрузки карты у клиента */
  bonusesInfo(): BonusInfo[] {
    return [...this.bonuses.values()].map((bonus) => this.bonusInfo(bonus));
  }

  effectsInfo(): ActiveEffectInfo[] {
    const now = Date.now();
    const effects: ActiveEffectInfo[] = [];
    for (const player of this.players.values()) {
      for (const [effect, { endsAt }] of player.effects) {
        if (endsAt > now) effects.push({ userId: player.userId, effect, leftMs: endsAt - now });
      }
    }
    return effects;
  }

  /** сверка мин после загрузки карты у клиента */
  minesInfo(): MineInfo[] {
    return [...this.mines.values()].map((mine) => this.mineInfo(mine));
  }

  private mineInfo(mine: BattleMine): MineInfo {
    return { mineId: mine.id, ownerId: mine.ownerId, team: mine.team, position: mine.position, activated: mine.activated };
  }

  private inventoryInfo(slot: InventorySlot): InventoryItemInfo {
    return { index: slot.index, itemId: slot.itemId, count: this.summary.withoutSupplies||slot.kind==='mine'&&this.summary.withoutMines||slot.kind==='firstAid'&&this.summary.withoutMedkit?0:slot.count, cooldownMs: slot.cooldownMs };
  }

  private playerInfo(player: Player): BattlePlayer {
    return {
      userId: player.userId,
      isBot: player.isBot,
      name: player.name,
      rank: player.rank,
      team: player.team,
      parts: player.loadout.parts,
      weapon: player.loadout.weapon,
      maxHealth: player.loadout.maxHealth,
      health: Math.round(player.health),
      state: player.state,
      life: player.life,
      position: player.position,
      orientation: player.orientation,
      kills: player.kills,
      deaths: player.deaths,
      score: player.score,
    };
  }

  private player(session: Session): Player {
    const player = session.user ? this.players.get(session.user.id) : undefined;
    if (!player || player.session !== session) throw new RequestError('bad_request', 'не в бою');
    return player;
  }

  private send<K extends EventName>(player: Player, type: K, data: Events[K]): void {
    if (player.session.isOpen) player.session.send(type, data);
  }

  private broadcast<K extends EventName>(type: K, data: Events[K], except: Player | null = null): void {
    for (const player of this.players.values()) if (player !== except) this.send(player, type, data);
  }

  // ------------------------------------------------------------------ спавн и смерть

  /** клиент готов: точка спавна, battle.prepare себе и спавн через spawnDelayMs (после смерти — не раньше конца экрана смерти) */
  ready(session: Session): void {
    const player = this.player(session);
    if (!this.roundActive) return;
    if (player.preparing || player.alive) return;
    const wait = player.deadUntil - Date.now();
    if (player.state === 'dead' && wait > 0) {
      player.later(wait + 20, () => this.players.get(player.userId) === player && this.ready(session));
      return;
    }
    const spawns = spawnsFor(this.map, player.team);
    const free=player.isBot?spawns.filter(point=>[...this.players.values()].every(other=>{
      if(other===player||(!other.alive&&!other.preparing))return true;
      const p=other.pendingSpawn?.position??other.position;if(!p)return true;
      const clearance=(Math.max(player.loadout.size.x,player.loadout.size.y)+Math.max(other.loadout.size.x,other.loadout.size.y))/2;
      return Math.abs(p.z-point.position.z)>250||Math.hypot(p.x-point.position.x,p.y-point.position.y)>clearance;
    })):spawns;
    if(!free.length){
      player.preparing=true;
      player.later(500,()=>{player.preparing=false;if(this.players.get(player.userId)===player)this.ready(session);});return;
    }
    const point = free[Math.floor(Math.random() * free.length)];
    player.pendingSpawn=point;
    player.preparing = true;
    player.life++;
    const life = player.life;
    this.send(player, 'battle.prepare', { position: point.position, orientation: point.orientation, spawnDelayMs: this.timings.spawnDelayMs });
    player.later(this.timings.spawnDelayMs, () => this.spawn(player, life, point));
  }

  private spawn(player: Player, life: number, point: SpawnPoint): void {
    // раунд окончился, пока шла задержка спавна: поедет только с новым battle.ready нового раунда
    if (!this.roundActive) return;
    if (this.players.get(player.userId) !== player || player.life !== life) return;
    player.preparing = false;player.pendingSpawn=null;
    player.state = 'spawned';
    player.health = player.loadout.maxHealth;
    player.position = { ...point.position };
    player.orientation = { ...point.orientation };
    player.last = null;
    player.history = [];
    player.violations = 0;
    player.spawnedAt = Date.now();
    player.lastShotAt = -Infinity;
    player.chargeAt = -Infinity;
    player.twinsShots.clear();
    player.ricochetShots.clear();
    player.ricochetEnergy = player.loadout.weapon.ricochet?.energyCapacity ?? 0;
    player.ricochetEnergyAt = Date.now();
    // потоковые и Шафт: запас энергии полный (StreamWeaponGlobalModel: TODO fill energy after respawning)
    player.streamEnergy = player.loadout.weapon.stream?.energyCapacity ?? 0;
    player.streamEnergyAt = Date.now();
    player.streamFiring = false;
    player.isidaTarget = null;
    player.streamTargetIds = [];
    player.lastStreamTickAt = -Infinity;
    player.shaftAiming = false;
    player.shaftEnergy = player.loadout.weapon.shaft?.maxEnergy ?? 0;
    player.shaftEnergyAt = Date.now();
    this.resetTemperature(player);
    if(player.isBot){this.botWorld?.spawn(player.userId,life,point,this.botGuns.get(player.userId),this.botProfiles.get(player.userId));player.later(this.timings.activationDelayMs,()=>this.activate(player.session,life));}
    this.broadcast('battle.spawn', { userId: player.userId, life, team: player.team, position: point.position, orientation: point.orientation, health: player.health });
  }

  /** активация после задержки (раньше — откладывается до положенного времени) */
  activate(session: Session, life: number): void {
    const player = this.player(session);
    if (player.state !== 'spawned' || player.life !== life) return;
    const wait = player.spawnedAt + this.timings.activationDelayMs - 300 - Date.now();
    if (wait > 0) {
      player.later(wait, () => this.players.get(player.userId) === player && this.activate(session, life));
      return;
    }
    if(player.isBot&&this.botWorld&&!this.botWorld.canActivate(player.userId)){player.later(250,()=>this.activate(session,life));return;}
    player.state = 'active';
    // InventoryModel.onLocalTankActivationEvent: при активации танка перезарядки слотов сбрасываются
    for (const slot of player.inventory) slot.readyAt = 0;
    this.broadcast('battle.activate', { userId: player.userId, life });
  }

  suicide(session: Session): void {
    const player = this.player(session);
    if (!this.roundActive) return;
    if (!player.alive || player.suicideTimer) return;
    const life = player.life;
    this.send(player, 'battle.suicideStarted', { delayMs: this.timings.suicideDelayMs });
    player.suicideTimer = player.later(this.timings.suicideDelayMs, () => {
      player.suicideTimer = null;
      if (player.life === life) this.kill(player, 'suicide', null);
    });
  }

  private kill(player: Player, reason: KillReason, killer: Player | null, weapon:string|null=killer?.loadout.weapon.kind??null): void {
    if (!player.alive || !this.roundActive) return;
    if (player.suicideTimer) {
      clearTimeout(player.suicideTimer);
      player.timers.delete(player.suicideTimer);
      player.suicideTimer = null;
    }
    // эффекты живут вместе с танком: со смертью значки гаснут, нитро возвращает скорость
    this.clearEffects(player);
    player.state = 'dead';
    this.ctf?.drop(player);
    if(player.isBot)this.botWorld?.remove(player.userId);
    player.health = 0;
    player.deadUntil = Date.now() + this.timings.deadTimeMs;
    player.last = null;
    player.history = [];
    this.broadcast('battle.kill', { userId: player.userId, life: player.life, killerId: killer?.userId ?? null, reason, weapon, respawnDelayMs: this.timings.deadTimeMs });
    // самоуничтожение статистику не меняет (add_kill только для KILLED_IN_BATTLE)
    if (reason !== 'killed') return;
    player.deaths++;
    this.broadcastStat(player);
    if (!killer || killer === player || this.teamMode && killer.team===player.team) return;
    killer.kills++;
    killer.score += this.timings.killScore;
    this.broadcastStat(killer);
    // old: battle_field_global_model.add_score_to_user_property(kill_score, killer_id) и statistics.add_kill → add_fund
    if(!killer.isBot)this.hooks.addKillScore(killer.session, killer.userId, this.timings.killScore);
    this.addFund(this.timings.killFund);
    if (this.summary.mode==='tdm' && killer.team !== player.team && (killer.team === TEAM.RED || killer.team === TEAM.BLUE)) {
      this.teamScores[killer.team]++;
      this.broadcast('battle.teamScore', { scores: [...this.teamScores] });
      this.onPlayersChanged(this);
    }
    // лимит очков старого сервера считается по убийствам и только в DM (statistics_global_model.add_kill)
    const scoreLimit = this.summary.scoreLimit;
    if (scoreLimit > 0 && ((!this.teamMode && killer.kills >= scoreLimit)||(this.summary.mode==='tdm' && this.teamScores[killer.team as 0|1]>=scoreLimit))) this.endRound();
  }

  private addFund(amount: number): void {
    if (amount <= 0 || !this.roundActive) return;
    this.fund += amount;
    // StatisticsGlobalModel.add_fund: сначала battle_fund_changed (золото, ящик кристаллов), потом fund_change
    this.bonusFundChanged();
    this.broadcast('battle.fund', { fund: this.fund });
  }

  // ------------------------------------------------------------------ ящики и припасы

  private bonusInfo(bonus: BattleBonus): BonusInfo {
    return { bonusId: bonus.id, kind: bonus.kind, position: bonus.position, zoneKey: bonus.zoneKey, ageMs: Math.max(0, serverMs() - bonus.spawnedAt) };
  }

  /** BattleFieldBonusGlobalModel.spawn_supplie_boxes_loop: раз в supplie_box_spawn_time_in_sec случайный припас */
  private startSupplyLoop(): void {
    this.supplyTimer ??= setInterval(() => this.spawnSupplyBox(), this.timings.supplySpawnMs);
  }

  private spawnSupplyBox(): void {
    if (this.summary.withoutBonuses || !this.roundActive || !this.players.size) return;
    // get_random_supplie_bonus_type: ящики припасов (броня, аптечка, нитро, урон), без кристаллов и золота
    const kinds: BonusKind[] = ['armor', 'med', 'nos', 'power'];
    this.spawnBonus(kinds[Math.floor(Math.random() * kinds.length)]);
  }

  private spawnBonus(kind: BonusKind): boolean {
    if (kind === 'gold' ? this.summary.withoutGoldBoxes : kind === 'crystal' ? this.summary.withoutCrystals : this.summary.withoutBonuses) return false;
    if (!this.roundActive || !this.players.size) return false;
    const occupied = new Set([...this.bonuses.values()].map(bonus => bonus.zoneKey));
    const free = this.map.bonusRegions.filter(region =>
      (!region.modes.length || region.modes.includes(this.summary.mode)) &&
      !occupied.has(bonusZoneKey(region.position)));
    let regions = free.filter(region => region.kinds.includes(kind));
    // У архивной 2042 каждый тип ящика закреплён за своими зонами.
    if (kind === 'crystal' && !regions.length && this.map.key !== '2042' && this.map.key !== 'sandbox') {
      regions = free.filter(region => region.kinds.some(type => type !== 'gold'));
    }
    if (!regions.length) return false;
    const region = regions[Math.floor(Math.random() * regions.length)];
    const position = bonusDropPosition(region.position, region.min, region.max);
    // generate_new_bonus_id: 1, 2, …; на переполнении — снова с 1
    this.bonusId = this.bonusId >= 0xffffffff ? 1 : this.bonusId + 1;
    const bonus: BattleBonus = { id: this.bonusId, kind, position, spawnedAt: serverMs(), zoneKey: bonusZoneKey(region.position) };
    this.bonuses.set(bonus.id, bonus);
    this.broadcast('battle.bonusSpawned', { bonus: this.bonusInfo(bonus) });
    return true;
  }

  private dropPendingCrystal(): void {
    if (this.pendingCrystalDrops > 0 && this.spawnBonus('crystal')) this.pendingCrystalDrops--;
  }

  /** remove_all_bonuses: конец раунда — ящики убираются, в новом раунде падают заново */
  private removeAllBonuses(): void {
    for(const timer of this.goldTimers)clearTimeout(timer);this.goldTimers.clear();
    this.fundChangesSinceGold=0;
    this.fundChangesSinceCrystal = 0;
    this.pendingCrystalDrops = 0;
    const ids = [...this.bonuses.keys()];
    this.bonuses.clear();
    if (ids.length) this.broadcast('battle.bonusesRemoved', { bonusIds: ids });
  }

  /** battle_fund_changed: золото (randint(1, probability) == 1) и ящик кристаллов раз в N изменений фонда */
  private bonusFundChanged(): void {
    if (!this.summary.withoutGoldBoxes && ++this.fundChangesSinceGold >= 10) {
      this.fundChangesSinceGold=0;
      const delaySec = 10;
      this.broadcast('battle.goldNotify', { message: this.timings.goldNotificationMessage, delaySec });
      const timer = setTimeout(() => {
        this.goldTimers.delete(timer);
        this.spawnBonus('gold');
      }, 10000);
      this.goldTimers.add(timer);
    }
    // старый сервер счётчик не сбрасывает: после порога ящик выпадает на каждое изменение фонда
    if (!this.summary.withoutCrystals && ++this.fundChangesSinceCrystal >= this.timings.numFundChangesForCrystalDrop) {
      this.pendingCrystalDrops++;
      this.dropPendingCrystal();
    }
  }

  /**
   * ATTEMPT_TO_TAKE_BONUS: живой танк берёт существующий ящик (расстояние старый сервер не проверял — подбор
   * приходит от клиента, когда куб ящика коснулся танка).
   */
  takeBonus(session: Session, bonusId: number): void {
    if (!this.roundActive) return;
    const player = this.player(session);
    const bonus = this.bonuses.get(bonusId);
    if (!bonus || player.state !== 'active') return;
    this.bonuses.delete(bonusId);
    this.applyBonus(player, bonus.kind);
    this.broadcast('battle.bonusTaken', { bonusId, userId: player.userId, kind: bonus.kind });
    this.dropPendingCrystal();
  }

  /** attempt_to_take_bonus: припас действует на живой танк (если такой эффект уже есть — аптечка не лечит заново) */
  private applyBonus(player: Player, kind: BonusKind): void {
    if (kind === 'armor') this.activateEffect(player, EFFECT.DOUBLE_ARMOR, this.timings.effectMs.doubleArmor);
    else if (kind === 'power') this.activateEffect(player, EFFECT.DOUBLE_POWER, this.timings.effectMs.doublePower);
    else if (kind === 'nos') this.activateEffect(player, EFFECT.NITRO, this.timings.effectMs.nitro);
    else if (kind === 'med') this.activateFirstAid(player);
    else if (kind === 'gold') {
      if(!player.isBot)this.hooks.giveCrystals(player.session, player.userId, this.timings.goldBoxReward);
      this.broadcast('battle.goldTaken', { userId: player.userId, name: player.name, crystals: this.timings.goldBoxReward });
    } else if (kind === 'crystal' && !player.isBot) this.hooks.giveCrystals(player.session, player.userId, this.timings.crystalBoxReward);
  }

  /** activate_double_*_effect / activate_nitro_effect: повторное взятие обновляет время (full_effect_timer) */
  private activateEffect(player: Player, effect: EffectIndex, durationMs: number, onExpire?: () => void): ReturnType<typeof setTimeout> {
    const previous = player.effects.get(effect);
    if (previous) {
      clearTimeout(previous.timer);
      player.timers.delete(previous.timer);
    }
    const timer = player.later(durationMs, () => {
      if (player.effects.get(effect)?.timer !== timer) return;
      player.effects.delete(effect);
      onExpire?.();
      this.broadcast('battle.effect', { userId: player.userId, effect, leftMs: null });
      if (effect === EFFECT.NITRO) this.sendSpec(player);
    });
    player.effects.set(effect, { timer, endsAt: Date.now() + durationMs });
    this.broadcast('battle.effect', {
      userId: player.userId, effect, leftMs: durationMs,
      ...(effect === EFFECT.FIRST_AID && player.position ? { position: player.position } : {}),
    });
    if (effect === EFFECT.NITRO) this.sendSpec(player);
    return timer;
  }

  private endEffect(player: Player, effect: EffectIndex): void {
    const active = player.effects.get(effect);
    if (!active) return;
    const { timer } = active;
    clearTimeout(timer);
    player.timers.delete(timer);
    player.effects.delete(effect);
    this.broadcast('battle.effect', { userId: player.userId, effect, leftMs: null });
    if (effect === EFFECT.NITRO) this.sendSpec(player);
  }

  /** death и новый раунд: эффекты с танка снимаются, значки гаснут, температура и струя сбрасываются */
  private clearEffects(player: Player): void {
    for (const effect of [...player.effects.keys()]) this.endEffect(player, effect);
    this.resetTemperature(player);
    if (player.streamFiring) {
      player.streamFiring = false;
      player.streamTargetIds = [];
      this.broadcast('battle.stream', { shooterId: player.userId, active: false, kind: player.loadout.weapon.kind, targets: [], hit: null });
    }
    player.shaftAiming = false;
  }

  /** SET_SPECIFICATION: нитро × заморозка; клиенту уходит только заметное изменение */
  private sendSpec(player: Player): void {
    const nitro = player.effects.has(EFFECT.NITRO) ? this.timings.nitroSpeedFactor : 1;
    const ratio = player.cold < 0 ? Math.min(1, Math.max(0, player.cold / player.coldMinTemperature)) : 0;
    const factor = nitro * (1 + (player.coldBodyMaxFreezing - 1) * ratio);
    const temperature = player.heat > 0 ? player.heat : player.cold;
    if (Math.abs(factor - player.sentSpeedFactor) < 0.005 && Math.abs(temperature-player.sentTemperature)<0.0001) return;
    player.sentTemperature = temperature;
    player.sentSpeedFactor = factor;
    this.broadcast('battle.spec', { userId: player.userId, speedFactor: factor, temperature });
  }

  /** смерть, спавн и новый раунд: температура обнуляется, скорость возвращается */
  private resetTemperature(player: Player): void {
    player.heat = 0;
    player.heatSource = null;
    player.lastBurnAt = 0;
    player.cold = 0;
    player.coldSource = null;
    const nitro = player.effects.has(EFFECT.NITRO) ? this.timings.nitroSpeedFactor : 1;
    if (Math.abs(player.sentSpeedFactor - nitro) > 0.005 || player.sentTemperature !== 0) {
      player.sentTemperature = 0;
      player.sentSpeedFactor = nitro;
      this.broadcast('battle.spec', { userId: player.userId, speedFactor: nitro, temperature: 0 });
    }
  }

  /** Temperature.apply_temperature_effects: остывание, горение раз в секунду и замедление от Фриза */
  private startTemperatureLoop(): void {
    this.temperatureTimer ??= setInterval(() => this.updateTemperatures(), TEMPERATURE_TICK_MS);
  }

  private updateTemperatures(): void {
    const now = Date.now();
    const dt = TEMPERATURE_TICK_MS / 1000;
    for (const player of this.players.values()) {
      if (player.state !== 'active') continue;
      let changed = false;
      if (player.heat > 0) {
        player.heat = Math.max(0, player.heat - player.heatCooling * dt);
        if (player.heat > 0 && now - player.lastBurnAt >= 1000 && player.heatSource) {
          player.lastBurnAt = now;
          const factor = Math.min(1, player.heat / Math.max(0.0001, player.heatLimit));
          this.damage(player, player.burnMin + (player.burnMax - player.burnMin) * factor, player.heatSource);
        }
        if (player.heat === 0) player.heatSource = null;
        changed = true;
      }
      if (player.cold < 0) {
        player.cold = Math.min(0, player.cold + player.coldDefrosting * dt);
        if (player.cold === 0) player.coldSource = null;
        changed = true;
      }
      if (changed) this.sendSpec(player);
    }
  }

  private activateFirstAid(player: Player): void {
    if (player.health >= player.loadout.maxHealth || player.effects.has(EFFECT.FIRST_AID)) return;
    this.resetTemperature(player);

    const startedAt = Date.now();
    let applied = 0;
    const heal = (finalTick: boolean): void => {
      if (!this.roundActive || !player.alive) return;
      if (!finalTick && player.effects.get(EFFECT.FIRST_AID)?.timer !== timer) return;
      const elapsed = finalTick ? REPAIR_DURATION_MS : Math.min(Date.now() - startedAt, REPAIR_DURATION_MS);
      const total = REPAIR_INSTANT_HP + Math.floor(elapsed / REPAIR_TICK_MS) * REPAIR_TICK_HP;
      const health = Math.min(player.loadout.maxHealth, player.health + total - applied);
      applied = total;
      if (health > player.health) {
        player.health = health;
        this.broadcast('battle.health', { userId: player.userId, life: player.life, health: Math.round(health) });
      }
      if (finalTick) return;
      if (player.health >= player.loadout.maxHealth) {
        this.endEffect(player, EFFECT.FIRST_AID);
        return;
      }
      const nextTick = (Math.floor(elapsed / REPAIR_TICK_MS) + 1) * REPAIR_TICK_MS;
      if (nextTick < REPAIR_DURATION_MS) player.later(nextTick - elapsed, () => heal(false));
    };
    const timer = this.activateEffect(player, EFFECT.FIRST_AID, REPAIR_DURATION_MS, () => heal(true));
    heal(false);
  }

  // ------------------------------------------------------------------ инвентарь и мины

  /**
   * ACTIVATE (InventoryItemModel.try_activate): только живой активный танк (припасы блокируются до ACTIVATE_TANK),
   * припас есть и перезарядка прошла. Количество списывается из гаража (UserItems.count), эффект — как у ящика.
   */
  activateItem(session: Session, index: number): void {
    if (!this.roundActive) return;
    const player = this.player(session);
    if (player.state !== 'active') return;
    const slot = player.inventory.find((item) => item.index === index);
    if (!slot || slot.count <= 0 || Date.now() < slot.readyAt || this.summary.withoutSupplies || slot.kind==='mine'&&this.summary.withoutMines || slot.kind==='firstAid'&&this.summary.withoutMedkit) return;
    if (slot.kind === 'firstAid' && (player.health >= player.loadout.maxHealth || player.effects.has(EFFECT.FIRST_AID))) return;
    slot.count--;
    slot.readyAt = Date.now() + slot.cooldownMs;
    this.hooks.consumeItem(player.session, player.userId, slot.itemId);
    if (slot.kind === 'doubleArmor') this.activateEffect(player, EFFECT.DOUBLE_ARMOR, this.timings.effectMs.doubleArmor);
    else if (slot.kind === 'doublePower') this.activateEffect(player, EFFECT.DOUBLE_POWER, this.timings.effectMs.doublePower);
    else if (slot.kind === 'nitro') this.activateEffect(player, EFFECT.NITRO, this.timings.effectMs.nitro);
    else if (slot.kind === 'mine') this.dropMine(player);
    this.send(player, 'battle.inventory', { index: slot.index, count: slot.count, cooldownMs: slot.cooldownMs });
    if (slot.kind === 'firstAid') this.activateFirstAid(player);
  }

  /**
   * BattleMinesGlobalModel.add_mine: луч вниз от точки танка + 100 до земли, мина — точка попадания +
   * mine_offset_from_ground. Нет земли под танком — мина не ставится (припас при этом уже израсходован, как в старом
   * клиенте: try_activate списывает раньше drop_mine).
   */
  private dropMine(player: Player): void {
    if (!this.detector || !player.position) return;
    this.mineOrigin.reset(player.position.x, player.position.y, player.position.z + 100);
    if (!this.detector.raycastStatic(this.mineOrigin, this.down, 255, 4000, null, this.mineHit)) return;
    const position = { x: this.mineHit.position.x, y: this.mineHit.position.y, z: this.mineHit.position.z + this.timings.mineOffsetFromGround };
    if(this.ctf?.flags.some(f=>Math.hypot(position.x-f.base.x,position.y-f.base.y,position.z-f.base.z)<(this.timings.mineMinDistanceFromBase??203)))return;
    // generate_new_mine_id: 1, 2, …; на переполнении — снова с 1
    this.mineId = this.mineId >= 0xffffffff ? 1 : this.mineId + 1;
    const mine: BattleMine = { id: this.mineId, ownerId: player.userId, team: player.team, position, activated: false, timer: setTimeout(() => this.activateMine(mine.id), this.timings.mineActivateMs) };
    this.mines.set(mine.id, mine);
    this.broadcast('battle.minePlaced', { mine: this.mineInfo(mine) });
  }

  /** ACTIVATE_MINE через mine_activate_time_ms */
  private activateMine(mineId: number): void {
    const mine = this.mines.get(mineId);
    if (!mine) return;
    mine.activated = true;
    this.broadcast('battle.mineActivated', { mineId });
  }

  /**
   * check_mine_hit при каждом принятом состоянии танка: мина противника взведена и её точка (+60) внутри рамки
   * танка (hull_size / 2). Наступить на свою мину нельзя.
   */
  private checkMines(player: Player): void {
    if (!player.position || !player.orientation || !this.mines.size) return;
    const half = { x: this.playerHalfSize(player, 'x'), y: this.playerHalfSize(player, 'y'), z: this.playerHalfSize(player, 'z') };
    const tankPosition = this.tankPoint.reset(player.position.x, player.position.y, player.position.z);
    this.localMatrix.setRotationMatrix(player.orientation.x, player.orientation.y, player.orientation.z);
    for (const mine of [...this.mines.values()]) {
      if (!mine.activated || mine.ownerId === player.userId) continue;
      if (!this.summary.friendlyFire && this.teamMode && mine.team === player.team) continue;
      this.localPoint.reset(mine.position.x, mine.position.y, mine.position.z + 60);
      this.localPoint.diff(this.localPoint, tankPosition);
      this.localMatrix.transformVectorInverse(this.localPoint, this.localPoint);
      // колёсный клиренс: у лёгких корпусов центр выше рамки на высоту подвески
      if (Math.abs(this.localPoint.x) < half.x && Math.abs(this.localPoint.y) < half.y && Math.abs(this.localPoint.z) < half.z + 40) {
        this.explodeMine(mine, player);
        return;
      }
    }
  }

  private playerHalfSize(player: Player, axis: 'x' | 'y' | 'z'): number {
    return Math.max(20, player.loadout.size[axis] / 2);
  }

  /** explode_mine: мина исчезает, танк получает mine_damage (старый сервер — 20, без эффектов и красок) */
  private explodeMine(mine: BattleMine, target: Player): void {
    this.removeMine(mine.id);
    this.broadcast('battle.mineExploded', { mineId: mine.id, userId: target.userId });
    const owner = this.players.get(mine.ownerId) ?? null;
    const lost=Math.min(target.health,this.timings.mineDamage);
    target.health = Math.max(0, target.health - this.timings.mineDamage);
    if (lost > 0) this.endEffect(target, EFFECT.FIRST_AID);
    if(owner&&owner!==target&&target.position&&lost>0)this.send(owner,'battle.damage',{position:{...target.position,z:target.position.z+100},amount:Math.max(1,Math.round(lost)),type:Math.round(target.health)<=0?'fatal':'normal'});
    this.broadcast('battle.health', { userId: target.userId, life: target.life, health: Math.round(target.health) });
    if (Math.round(target.health) <= 0) this.kill(target, 'killed', owner && owner !== target ? owner : null,'mine');
  }

  private removeMine(mineId: number): void {
    const mine = this.mines.get(mineId);
    if (!mine) return;
    clearTimeout(mine.timer);
    this.mines.delete(mineId);
  }

  /** remove_user_mines: мины игрока снимаются (выход из боя) */
  private removeUserMines(userId: number): void {
    const ids = [...this.mines.values()].filter((mine) => mine.ownerId === userId).map((mine) => mine.id);
    for (const id of ids) this.removeMine(id);
    if (ids.length) this.broadcast('battle.minesRemoved', { mineIds: ids });
  }

  /** конец раунда: все мины убираются */
  private removeAllMines(): void {
    const ids = [...this.mines.keys()];
    for (const mine of this.mines.values()) clearTimeout(mine.timer);
    this.mines.clear();
    if (ids.length) this.broadcast('battle.minesRemoved', { mineIds: ids });
  }

  // ------------------------------------------------------------------ раунд

  /** первый игрок в пустом бою: раунд начинается сейчас */
  private beginRound(): void {
    this.roundActive = true;
    this.restartAt = 0;
    this.roundStartedAt = Date.now();
    this.scheduleRoundTimer();
    // цикл ящиков припасов стартует вместе с боем и тикает через границы раундов (как spawn_supplie_boxes_loop)
    this.startSupplyLoop();
  }

  /** последний игрок вышел: бой замирает, следующий вход начнёт новый раунд с фондом 100 */
  private pauseRound(): void {
    this.clearRoundTimers();
    this.roundActive = true;
    this.restartAt = 0;
    this.fund = INITIAL_FUND;
    this.teamScores = [0, 0];
    this.ctf?.reset();
    this.broadcast('battle.flags',{flags:this.flagsInfo()});
    this.roundStartedAt = Date.now();
  }

  private scheduleRoundTimer(): void {
    this.clearRoundTimer();
    const limit = this.summary.timeLimitSec;
    if (limit <= 0) return;
    const left = Math.max(0, limit * 1000 - (Date.now() - this.roundStartedAt));
    this.roundTimer = setTimeout(() => this.endRound(), left);
  }

  private clearRoundTimer(): void {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = null;
  }

  private clearRoundTimers(): void {
    this.clearRoundTimer();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** итоги раунда по игрокам: делёж фонда как battle_fund_calculator (в TDM — сначала между командами) */
  private roundResults(): BattleRoundPlayer[] {
    const players = [...this.players.values()].filter(p=>!p.isBot);
    let rewards: number[];
    if (this.teamMode) {
      const [blueFund, redFund] = splitTeamFund(this.teamScores[1], this.teamScores[0], this.fund);
      const red = players.filter((player) => player.team !== TEAM.BLUE);
      const blue = players.filter((player) => player.team === TEAM.BLUE);
      const redRewards = shareFund(red.map((player) => player.score), redFund);
      const blueRewards = shareFund(blue.map((player) => player.score), blueFund);
      const byUser = new Map<number, number>();
      red.forEach((player, index) => byUser.set(player.userId, redRewards[index]));
      blue.forEach((player, index) => byUser.set(player.userId, blueRewards[index]));
      rewards = players.map((player) => byUser.get(player.userId) ?? 0);
    } else {
      rewards = shareFund(players.map((player) => player.score), this.fund);
    }
    return [...this.players.values()].map(player=>({userId:player.userId,kills:player.kills,deaths:player.deaths,score:player.score,reward:rewards[players.indexOf(player)]??0}));
  }

  /** конец раунда (StatisticsGlobalModel.battle_end): итоги с наградой, начисление фонда, рестарт через round_end_screen_time */
  private endRound(): void {
    if (!this.roundActive) return;
    this.botWorld?.clear();
    this.roundActive = false;
    this.clearRoundTimer();
    // battle_end: ящики и мины убираются вместе с концом раунда
    this.removeAllBonuses();
    this.removeAllMines();
    const results = this.roundResults();
    const timeToRestartSec = Math.max(1, Math.round(this.timings.roundEndScreenMs / 1000));
    this.broadcast('battle.roundEnd', { timeToRestartSec, fund: this.fund, results, teamScores: [...this.teamScores] });
    const entries = results
      .map((result) => {
        const player = this.players.get(result.userId);
        return player&&!player.isBot ? { session: player.session, userId: result.userId, crystals: result.reward } : null;
      })
      .filter((entry): entry is { session: Session; userId: number; crystals: number } => entry != null);
    this.hooks.giveFund(entries);
    log('battle', `бой ${this.summary.id}: конец раунда, фонд ${this.fund}, награды ${results.map((result) => `${result.userId}:${result.reward}`).join(' ')}`);
    this.restartAt = Date.now() + this.timings.roundEndScreenMs;
    this.restartTimer = setTimeout(() => this.startNewRound(), this.timings.roundEndScreenMs);
  }

  /** новый раунд (StatisticsGlobalModel.start_new_round): фонд 0, статистика обнулена, в TDM команды меняются местами */
  private startNewRound(): void {
    this.restartTimer = null;
    this.fund = 0;
    this.roundActive = true;
    this.restartAt = 0;
    const players = [...this.players.values()];
    if (!players.length) {
      this.roundStartedAt = Date.now();
      return;
    }
    this.roundStartedAt = Date.now();
    this.ctf?.reset();
    this.broadcast('battle.flags',{flags:this.flagsInfo()});
    if (this.teamMode) this.teamScores = [0, 0];
    for (const player of players) {
      this.clearEffects(player);
      player.clearTimers();
      player.kills = 0;
      player.deaths = 0;
      player.score = 0;
      player.state = 'out';
      player.health = 0;
      player.preparing = false;player.pendingSpawn=null;
      player.position = null;
      player.orientation = null;
      player.last = null;
      player.history = [];
      player.violations = 0;
      player.deadUntil = 0;
      player.suicideTimer = null;
      if (this.teamMode) player.team = player.team === TEAM.BLUE ? TEAM.RED : TEAM.BLUE;
    }
    this.broadcast('battle.restart', {});
    this.broadcast('battle.teamScore', { scores: [...this.teamScores] });
    this.broadcast('battle.roundStart', { timeLeftSec: this.summary.timeLimitSec, teams: players.map((player) => ({ userId: player.userId, team: player.team })) });
    this.scheduleRoundTimer();
    this.onPlayersChanged(this);
    log('battle', `бой ${this.summary.id}: новый раунд, лимит ${this.summary.timeLimitSec} с`);
  }

  private broadcastStat(player: Player): void {
    this.broadcast('battle.stat', { userId: player.userId, kills: player.kills, deaths: player.deaths, score: player.score });
    // окно информации о бое в лобби показывает убийства — обновляем список
    this.onPlayersChanged(this);
  }

  // ------------------------------------------------------------------ чат

  /** сообщение чата всем игрокам боя (chat_service.broadcast) */
  broadcastChat(author: string, rank: number, kind: ChatKind, text: string): void {
    this.broadcast('battle.chat', { author, rank, kind, text });
  }

  /** ответ на команду только её автору (chat_service.reply) */
  sendChatTo(userId: number, author: string, rank: number, kind: ChatKind, text: string): void {
    const player = this.players.get(userId);
    if (player) this.send(player, 'battle.chat', { author, rank, kind, text });
  }

  /** /restart: администратор завершает раунд текущего боя (StatisticsGlobalModel.battle_end) */
  adminEndRound(): boolean {
    if (!this.roundActive) return false;
    this.broadcastChat('', 0, CHAT_KIND.SYSTEM, 'Администратор завершил раунд');
    this.endRound();
    return true;
  }

  // ------------------------------------------------------------------ синхронизация

  /** STATE своего танка: жизнь, порядок, скорость; упал с карты или в зону смерти — самоуничтожение */
  acceptState(session: Session, sample: SyncSample): void {
    const player = session.user ? this.players.get(session.user.id) : undefined;
    if (!player || player.session !== session || !player.alive || !this.roundActive) return;
    if (sample.life !== player.life || !isValidSample(sample)) return;
    const now = serverMs();
    if (sample.sampleTime > now + MAX_SAMPLE_AHEAD_MS) sample.sampleTime = now;
    const last = player.last;
    if (last&&!player.isBot) {
      if (!seqNewer(sample.seq, last.sample.seq)) return;
      if (!this.speedOk(player, last, sample, now) || this.wallBlocked(last.sample, sample)) {
        if (++player.violations >= VIOLATIONS_BEFORE_CORRECTION) {
          player.violations = 0;
          session.ws.sendBinary(encodeState(FRAME.CORRECTION, last.sample));
          log('battle', `${player.name}: движение отклонено, коррекция`);
        }
        return;
      }
      player.violations = 0;
    }
    const position = { x: sample.px, y: sample.py, z: sample.pz };
    if (position.z <= this.timings.minAllowedZ || inKillZone(this.map, position) || (player.isBot && last && this.wallBlocked(last.sample,sample))) {
      this.kill(player, 'suicide', null);
      return;
    }
    player.last = { sample, received: now };
    player.history.push(sample);
    const limit = sample.sampleTime - HISTORY_MS;
    while (player.history.length > 1 && player.history[0].sampleTime < limit) player.history.shift();
    player.position = position;
    player.orientation = quaternionToEuler(sample.qx, sample.qy, sample.qz, sample.qw);
    // check_mine_hit идёт после каждого принятого состояния танка
    this.checkMines(player);
  }

  /** путь между состояниями не длиннее, чем танк мог проехать (по времени приёма и времени снятия) */
  private speedOk(player: Player, last: { sample: SyncSample; received: number }, sample: SyncSample, now: number): boolean {
    const dtReceived = Math.max(now - last.received, 0) / 1000;
    const dtSample = Math.max(sample.sampleTime - last.sample.sampleTime, 0) / 1000;
    const dt = Math.max(dtReceived, Math.min(dtSample, dtReceived + 0.5), SNAPSHOT_INTERVAL_MS / 1000);
    const allowed = (player.loadout.speed * 100 * SPEED_FACTOR + SPEED_ALLOWANCE_CM) * dt + DISTANCE_ALLOWANCE_CM;
    const dx = sample.px - last.sample.px;
    const dy = sample.py - last.sample.py;
    return dx * dx + dy * dy <= allowed * allowed;
  }

  /**
   * Проверка физикой на сервере: на большом скачке (телепорт/спидхак) луч между прошлым и новым состоянием не
   * должен упираться в стену карты. Пол, пандусы и лестницы (нормаль вверх) пропускаются — их клиентская физика
   * проходит штатно; мины и лучи используют ту же статику (collision.ts).
   */
  private wallBlocked(last: SyncSample, sample: SyncSample): boolean {
    if (!this.detector) return false;
    const dx = sample.px - last.px;
    const dy = sample.py - last.py;
    const dz = sample.pz - last.pz;
    const length = Math.hypot(dx, dy, dz);
    if (length < WALL_MIN_MOVE_CM) return false;
    this.wallOrigin.reset(last.px, last.py, last.pz);
    this.wallDirection.reset(dx / length, dy / length, dz / length);
    if (!this.detector.raycastStatic(this.wallOrigin, this.wallDirection, 255, length, null, this.wallHit)) return false;
    if (this.wallHit.t >= length - WALL_END_ALLOWANCE_CM) return false;
    return Math.abs(this.wallHit.normal.z) < WALL_MAX_UP_NORMAL;
  }

  /** положение танка на серверное время (интерполяция по истории, чуть дальше последнего — по скорости, до 200 мс) */
  private positionAt(player: Player, time: number): Vec3 | null {
    const history = player.history;
    if (!history.length || !Number.isFinite(time)) return null;
    let index = history.findIndex((sample) => sample.sampleTime >= time);
    if (index === 0) return { x: history[0].px, y: history[0].py, z: history[0].pz };
    if (index < 0) {
      const last = history[history.length - 1];
      const dt = Math.min(time - last.sampleTime, 200) / 1000;
      return { x: last.px + last.vx * dt, y: last.py + last.vy * dt, z: last.pz + last.vz * dt };
    }
    const a = history[index - 1];
    const b = history[index];
    const span = b.sampleTime - a.sampleTime;
    const k = span <= 0 ? 0 : (time - a.sampleTime) / span;
    return { x: a.px + (b.px - a.px) * k, y: a.py + (b.py - a.py) * k, z: a.pz + (b.pz - a.pz) * k };
  }

  flagsInfo(){return this.ctf?.snapshot()??[];}
  dropFlag(session:Session):void {const p=this.players.get(session.user!.id);if(p&&p.session===session&&p.state==='active'&&this.roundActive)this.ctf?.drop(p);}

  private sendSnapshots(): void {
    if(this.roundActive)this.ctf?.step([...this.players.values()]);
    const tanks: { userId: number; sample: SyncSample }[] = [];
    for (const player of this.players.values()) {
      if (player.alive && player.last && player.last.sample.life === player.life) tanks.push({ userId: player.userId, sample: player.last.sample });
    }
    if (!tanks.length) return;
    const now = serverMs();
    for (const receiver of this.players.values()) {
      const others = tanks.filter((tank) => tank.userId !== receiver.userId);
      if (!others.length || !receiver.session.isOpen || receiver.session.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      receiver.session.ws.sendBinary(encodeSnapshot(now, others));
    }
  }

  // ------------------------------------------------------------------ выстрелы

  private reloaded(player: Player, reloadMs: number): boolean {
    const now = Date.now();
    if (now - player.lastShotAt < reloadMs * RELOAD_TOLERANCE - RELOAD_JITTER_MS) return false;
    player.lastShotAt = now;
    return true;
  }

  /** цель попадания (check_shooting_params): жива, та же жизнь, не союзник, там, где её видел стрелок */
  private checkTarget(shooter: Player, hit: ShotHit, viewTime: number, allowSelf = false): Player | null {
    const target = this.players.get(hit.userId);
    const reject = (reason: string): null => {
      log('battle', `попадание ${shooter.name} → ${target?.name ?? hit.userId} отклонено: ${reason}`);
      return null;
    };
    if (!target) return reject('нет цели');
    if (target === shooter && !allowSelf) return reject('нет цели');
    if (target.state !== 'active' || hit.life !== target.life) return reject(`цель ${target.state}, жизнь ${hit.life}/${target.life}`);
    if (!this.summary.friendlyFire && target !== shooter && this.teamMode && target.team === shooter.team) return null;
    const speed = target.last ? Math.hypot(target.last.sample.vx, target.last.sample.vy, target.last.sample.vz) : 0;
    const past = this.positionAt(target, viewTime);
    if (past && distance(past, hit.position) <= LAG_COMPENSATED_ALLOWANCE_CM + speed * LAG_COMPENSATED_SPEED_SEC) return target;
    if (!target.position) return reject('позиция цели неизвестна');
    const age = target.last ? (serverMs() - target.last.received) / 1000 : MAX_STATE_AGE_SEC;
    const allowed = POSITION_DIFFERENCE_CM + speed * (Math.min(age, MAX_STATE_AGE_SEC) + NETWORK_LAG_SEC);
    const difference = distance(target.position, hit.position);
    return difference <= allowed ? target : reject(`позиция расходится на ${difference.toFixed(0)} см (допуск ${allowed.toFixed(0)})`);
  }

  /** damage_tank: защита краски, HP всем, смерть — когда округлённое HP дошло до нуля */
  private damage(target: Player, damage: number, shooter: Player, critical=false): void {
    if (target.state !== 'active') return;
    // apply_effects_to_damage: двойная броня цели вдвое уменьшает урон, двойной урон стрелка — вдвое увеличивает
    if (target.effects.has(EFFECT.DOUBLE_ARMOR)) damage *= 0.5;
    if (shooter.effects.has(EFFECT.DOUBLE_POWER)) damage *= 2;
    const protection = target.loadout.resistances.get(`${shooter.loadout.weapon.kind === 'isida' ? 'isis' : shooter.loadout.weapon.kind}_resistance`) ?? 0;
    const oldHealth=target.health;
    target.health = Math.max(0, target.health - (damage - damage * protection * 0.01));
    if (oldHealth > target.health) this.endEffect(target, EFFECT.FIRST_AID);
    if(target.position&&oldHealth>target.health)this.send(shooter,'battle.damage',{position:{...target.position,z:target.position.z+100},amount:Math.max(1,Math.round(oldHealth-target.health)),type:Math.round(target.health)<=0?'fatal':critical?'critical':'normal'});
    if(target.isBot&&target.health<oldHealth&&Math.round(target.health)>0&&target!==shooter&&(!this.teamMode||target.team!==shooter.team)){
      this.botWorld?.hitBy(target.userId,{id:shooter.userId,team:shooter.team,position:shooter.position,state:shooter.state,health:shooter.health},Date.now());
    }
    this.broadcast('battle.health', { userId: target.userId, life: target.life, health: Math.round(target.health) });
    if (Math.round(target.health) <= 0) this.kill(target, 'killed', shooter);
  }

  private hitResult(target: Player, critical: boolean): ShotResult['hits'][number] {
    return { userId: target.userId, health: Math.round(target.health), life: target.life, critical };
  }

  /** Смоки (и пушки без своей модели в html5): урон from…to, крит, ослабление по расстоянию */
  smoky(session: Session, viewTime: number, hit: Vec3 | null, targetHit: ShotHit | null): ShotResult {
    if (!this.roundActive) return { hits: [] };
    const player = this.player(session);
    const weapon = player.loadout.weapon;
    if (!player.alive || weapon.kind !== 'smoky' || !this.reloaded(player, weapon.reloadMs)) return { hits: [] };
    const target = targetHit ? this.checkTarget(player, targetHit, viewTime) : null;
    if (!target || !targetHit) {
      this.broadcast('battle.smoky', { shooterId: player.userId, hit: hit ?? targetHit?.world ?? null, target: null, impact: 1, critical: false }, player);
      return { hits: [] };
    }
    const loadout = player.loadout;
    const impact = player.position ? weakening(distance(player.position, targetHit.position), weapon) : 1;
    const critical = Math.random() < loadout.criticalChance;
    let damage = uniform(loadout.damageFrom, loadout.damageTo);
    if (critical) damage = loadout.absoluteCriticalDamage ? loadout.criticalDamage : damage * (1 + loadout.criticalDamage / 100);
    this.broadcast('battle.smoky', { shooterId: player.userId, hit: null, target: { userId: target.userId, local: targetHit.local }, impact, critical }, player);
    this.damage(target, critical && loadout.absoluteCriticalDamage ? damage : damage * impact, player,critical);
    return { hits: [this.hitResult(target, critical)] };
  }

  railCharge(session: Session): void {
    if (!this.roundActive) return;
    const player = this.player(session);
    if (!player.alive || player.loadout.weapon.kind !== 'railgun') return;
    player.chargeAt = Date.now();
    this.broadcast('battle.railCharge', { shooterId: player.userId }, player);
  }

  /** рельса: после зарядки; цели по расстоянию от стрелка, урон каждой следующей × weakeningCoeff */
  rail(session: Session, viewTime: number, hit: Vec3 | null, targetHits: ShotHit[], dummy: boolean): ShotResult {
    if (!this.roundActive) return { hits: [] };
    const player = this.player(session);
    const weapon = player.loadout.weapon;
    if (!player.alive || weapon.kind !== 'railgun') return { hits: [] };
    const sinceCharge = Date.now() - player.chargeAt;
    if (sinceCharge > weapon.chargingMs + 5000 || !this.reloaded(player, weapon.reloadMs + weapon.chargingMs)) return { hits: [] };
    player.chargeAt = -Infinity;
    if (dummy) {
      this.broadcast('battle.rail', { shooterId: player.userId, hit: null, targets: [], dummy: true }, player);
      return { hits: [] };
    }
    const origin = player.position;
    const seen = new Set<number>();
    const ordered = targetHits
      .filter((candidate) => !seen.has(candidate.userId) && seen.add(candidate.userId))
      .sort((a, b) => (origin ? distance(origin, a.world) - distance(origin, b.world) : 0))
      .slice(0, MAX_RAIL_TARGETS);
    const valid = ordered.flatMap((candidate) => {
      const target = this.checkTarget(player, candidate, viewTime);
      return target ? [{ candidate, target }] : [];
    });
    this.broadcast('battle.rail', { shooterId: player.userId, hit, targets: valid.map((entry) => ({ userId: entry.target.userId, local: entry.candidate.local })), dummy: false }, player);
    let damage = uniform(player.loadout.damageFrom, player.loadout.damageTo);
    const hits: ShotResult['hits'] = [];
    for (const { target } of valid) {
      this.damage(target, damage, player);
      damage *= weapon.weakeningCoeff;
      hits.push(this.hitResult(target, false));
    }
    return { hits };
  }

  twins(session: Session, barrel: number, shotId: number, direction: Vec3): void {
    if (!this.roundActive) return;
    const player = this.player(session);
    const weapon = player.loadout.weapon;
    if (!player.alive || weapon.kind !== 'twins' || !this.reloaded(player, weapon.reloadMs)) return;
    player.twinsShots.set(shotId, { at: Date.now(), origin: player.position ? { ...player.position } : null, used: false });
    if (player.twinsShots.size > MAX_TWINS_SHOTS) player.twinsShots.delete(player.twinsShots.keys().next().value as number);
    this.broadcast('battle.twins', { shooterId: player.userId, barrel, shotId, direction }, player);
  }

  /** снаряд Twins: один раз, пока летит; урон с ослаблением от точки выстрела */
  twinsHit(session: Session, viewTime: number, shotId: number, targetHit: ShotHit): ShotResult {
    if (!this.roundActive) return { hits: [] };
    const player = this.player(session);
    const weapon = player.loadout.weapon;
    const shot = player.twinsShots.get(shotId);
    if (!player.alive || !shot || shot.used) return { hits: [] };
    const flightMs = weapon.twins && weapon.twins.speed > 0 ? (weapon.twins.distance / weapon.twins.speed) * 1000 : 3000;
    if (Date.now() - shot.at > flightMs + 1500) return { hits: [] };
    shot.used = true;
    const target = this.checkTarget(player, targetHit, viewTime);
    if (!target) return { hits: [] };
    const impact = shot.origin ? weakening(distance(shot.origin, targetHit.position), weapon) : 1;
    this.damage(target, uniform(player.loadout.damageFrom, player.loadout.damageTo) * impact, player);
    return { hits: [this.hitResult(target, false)] };
  }

  /**
   * Гром: прямой урон как у Смоки (без критов) и разрыв — сплеш по всем живым танкам в радиусе, кроме цели
   * прямого попадания; стрелок тоже получает урон (ThunderGlobalModel.apply_splash_damage).
   */
  thunder(session: Session, viewTime: number, hit: Vec3 | null, targetHit: ShotHit | null): ShotResult {
    if (!this.roundActive) return { hits: [] };
    const player = this.player(session);
    const weapon = player.loadout.weapon;
    if (!player.alive || weapon.kind !== 'thunder' || !this.reloaded(player, weapon.reloadMs)) return { hits: [] };
    const target = targetHit ? this.checkTarget(player, targetHit, viewTime) : null;
    const center = target && targetHit ? targetHit.world : hit;
    const baseDamage = center ? uniform(player.loadout.damageFrom, player.loadout.damageTo) : 0;
    this.broadcast('battle.thunder', {
      shooterId: player.userId,
      hit: center,
      target: target && targetHit ? { userId: target.userId, local: targetHit.local } : null,
    }, player);
    const hits: ShotResult['hits'] = [];
    if (target && targetHit) {
      const impact = player.position ? weakening(distance(player.position, targetHit.world), weapon) : 1;
      this.damage(target, baseDamage * impact, player);
      hits.push(this.hitResult(target, false));
    }
    const splash = weapon.splash;
    if (center && splash && splash.radius > 0) {
      const radius = splash.radius * 100;
      const distanceFactor=player.position?weakening(distance(player.position,center),weapon):1;
      for (const other of this.players.values()) {
        if (other === target || !other.alive || !other.position) continue;
        // дружественный огонь выключен: в TDM свои под разрыв не попадают (кроме самого стрелка)
        if (!this.summary.friendlyFire && other !== player && this.teamMode && other.team === player.team) continue;
        const d = distance(other.position, center);
        if (d >= radius) continue;
        if(this.detector){
          const angle=other.orientation?.z??0,offset=other.loadout.size.y*.375;
          const hidden=[0,-offset,offset].every(y=>{
            const point=new Vector3(other.position!.x-Math.sin(angle)*y,other.position!.y+Math.cos(angle)*y,other.position!.z);
            const from=new Vector3(center.x,center.y,center.z),direction=point.subtract(from);
            return this.detector!.raycastStatic(from,direction,255,.999,null,new RayHit());
          });if(hidden)continue;
        }
        const fullRadius = (splash.fullDamageRadius ?? 0) * 100;
        const factor = 1 - Math.max(0, d - fullRadius) / Math.max(1, radius - fullRadius);
        const min = splash.minimumDamagePercent;
        const splashDamage = min === undefined
          ? splash.damageFrom + (splash.damageTo - splash.damageFrom) * factor
          : baseDamage * (min / 100 + (1 - min / 100) * factor);
        if (splashDamage <= 0) continue;
        this.damage(other, splashDamage*distanceFactor, player);
        hits.push(this.hitResult(other, false));
      }
    }
    return { hits };
  }

  /** Рикошет: выстрел регистрируется, попадание клиент сообщает сам (как Twins) */
  ricochet(session: Session, shotId: number, direction: Vec3): void {
    if (!this.roundActive) return;
    const player = this.player(session);
    const weapon = player.loadout.weapon;
    const ricochet = weapon.ricochet;
    if (!player.alive || weapon.kind !== 'ricochet' || !ricochet) return;
    if (!Number.isFinite(direction.x + direction.y + direction.z)) return;
    // энергия важнее перезарядки: при 100/с она и ограничивает темп после первых выстрелов
    if (this.ricochetEnergyNow(player) < ricochet.energyPerShot) return;
    if (!this.reloaded(player, weapon.reloadMs)) return;
    player.ricochetEnergy -= ricochet.energyPerShot;
    player.ricochetEnergyAt = Date.now();
    player.ricochetShots.set(shotId, { at: Date.now(), origin: player.position ? { ...player.position } : null, used: false });
    if (player.ricochetShots.size > MAX_TWINS_SHOTS) player.ricochetShots.delete(player.ricochetShots.keys().next().value as number);
    this.broadcast('battle.ricochet', { shooterId: player.userId, shotId, direction }, player);
  }

  /** энергия Рикошета: восстанавливается всё время, тратится выстрелом (RicochetWeapon.getEnergy) */
  private ricochetEnergyNow(player: Player): number {
    const ricochet = player.loadout.weapon.ricochet;
    if (!ricochet) return 0;
    const now = Date.now();
    player.ricochetEnergy = Math.min(
      ricochet.energyCapacity,
      player.ricochetEnergy + (ricochet.energyRecharge * (now - player.ricochetEnergyAt)) / 1000,
    );
    player.ricochetEnergyAt = now;
    return player.ricochetEnergy;
  }

  ricochetHit(session: Session, viewTime: number, shotId: number, targetHit: ShotHit, bounces: number): ShotResult {
    if (!this.roundActive) return { hits: [] };
    const player = this.player(session);
    const shot = player.ricochetShots.get(shotId);
    if (!player.alive || !shot || shot.used || Date.now() - shot.at > RICOCHET_SHOT_LIFE_MS) return { hits: [] };
    shot.used = true;
    // свой шар после отскока может попасть в стрелка (RicochetShot.considerBody)
    const self = targetHit.userId === player.userId;
    if (self && bounces <= 0) return { hits: [] };
    const target = this.checkTarget(player, targetHit, viewTime, self);
    if (!target) return { hits: [] };
    const weapon = player.loadout.weapon;
    const impact = shot.origin ? weakening(distance(shot.origin, targetHit.position), weapon) : 1;
    const critical = Math.random() < player.loadout.criticalChance;
    let damage = uniform(player.loadout.damageFrom, player.loadout.damageTo) * impact;
    if (critical) damage *= 1 + player.loadout.criticalDamage / 100;
    this.broadcast('battle.ricochetHit', { shooterId: player.userId, shotId, target: { userId: target.userId, local: targetHit.local } }, player);
    this.damage(target, damage, player);
    return { hits: [this.hitResult(target, critical)] };
  }

  /** Шафт: энергия копится только при полной зарядке (has_enought_energy) */
  private shaftEnergyNow(player: Player): number {
    const shaft = player.loadout.weapon.shaft;
    if (!shaft) return 0;
    const now = Date.now();
    player.shaftEnergy = Math.max(0,Math.min(shaft.maxEnergy, player.shaftEnergy + ((player.shaftAiming ? -shaft.dischargeRate : shaft.chargeRate) * (now - player.shaftEnergyAt)) / 1000));
    player.shaftEnergyAt = now;
    return player.shaftEnergy;
  }

  /** вход в прицельный режим (activate_manual_targeting) и выход из него */
  shaftAim(session: Session, active: boolean): void {
    if (!this.roundActive) return;
    const player = this.player(session);
    const shaft = player.loadout.weapon.shaft;
    if (!player.alive || !shaft || player.loadout.weapon.kind !== 'shaft') return;
    if (active) {
      if (player.shaftAiming || player.state !== 'active' || Date.now()-player.lastShotAt<player.loadout.weapon.reloadMs || this.shaftEnergyNow(player) < shaft.maxEnergy-0.001) return;
      player.shaftAiming = true;
      player.shaftDrainAt = Date.now();
      player.shaftEnergyAt = Date.now();
    } else {
      if (!player.shaftAiming) return;
      this.shaftEnergyNow(player);
      if(Date.now()-player.shaftDrainAt<(shaft.targetingTransitionMs??500))player.shaftEnergy=shaft.maxEnergy;
      player.shaftAiming = false;
      player.shaftEnergyAt = Date.now();
    }
    this.broadcast('battle.shaftAim', { shooterId: player.userId, active }, player);
  }

  /** Шафт: аркадный выстрел (быстрый, 20–28) или прицельный (47–110 по заряду, пробивает цели) */
  shaft(session: Session, viewTime: number, aimed: boolean, hit: Vec3 | null, targetHits: ShotHit[]): ShotResult {
    if (!this.roundActive) return { hits: [] };
    const player = this.player(session);
    const weapon = player.loadout.weapon;
    const shaft = weapon.shaft;
    if (!player.alive || !shaft || weapon.kind !== 'shaft') return { hits: [] };
    const now = Date.now();
    const origin = player.position;
    const ordered = targetHits
      .filter((candidate, index, list) => list.findIndex((entry) => entry.userId === candidate.userId) === index)
      .slice(0, MAX_RAIL_TARGETS)
      .sort((a, b) => (origin ? distance(origin, a.position) - distance(origin, b.position) : 0));
    if (aimed) {
      if (!player.shaftAiming || !this.reloaded(player, weapon.reloadMs)) return { hits: [] };
      const remaining=this.shaftEnergyNow(player);
      const drained=shaft.maxEnergy-remaining;
      const damage = shaft.aimedMinDamage + (shaft.aimedMaxDamage - shaft.aimedMinDamage) * (drained / Math.max(1, shaft.maxEnergy));
      player.shaftAiming = false;
      player.shaftEnergy = remaining;
      player.shaftEnergyAt = now;
      const valid = ordered.slice(0,1).map((candidate) => ({ candidate, target: this.checkTarget(player, candidate, viewTime) })).filter((entry) => entry.target != null) as { candidate: ShotHit; target: Player }[];
      this.broadcast('battle.shaft', { shooterId: player.userId, aimed: true, hit, targets: valid.map((entry) => ({ userId: entry.target.userId, local: entry.candidate.local })) }, player);
      const hits: ShotResult['hits'] = [];
      let factor = 1;
      for (const { target } of valid) {
        this.damage(target, damage * factor, player);
        factor *= shaft.weakeningCoeff;
        hits.push(this.hitResult(target, false));
      }
      return { hits };
    }
    if (player.shaftAiming || this.shaftEnergyNow(player) < shaft.fastShotEnergy || !this.reloaded(player, weapon.reloadMs)) return { hits: [] };
    player.shaftEnergy = Math.max(0, player.shaftEnergy - shaft.fastShotEnergy);
    player.shaftEnergyAt = now;
    let first: ShotHit | null = null;
    let target: Player | null = null;
    for (const candidate of ordered) {
      target = this.checkTarget(player, candidate, viewTime);
      if (target) {
        first = candidate;
        break;
      }
    }
    this.broadcast('battle.shaft', {
      shooterId: player.userId,
      aimed: false,
      hit,
      targets: target && first ? [{ userId: target.userId, local: first.local }] : [],
    }, player);
    if (!target || !first) return { hits: [] };
    const impact = origin ? weakening(distance(origin, first.position), weapon) : 1;
    this.damage(target, uniform(player.loadout.damageFrom, player.loadout.damageTo) * impact, player);
    return { hits: [this.hitResult(target, false)] };
  }

  /** потоковая пушка: энергия тратится при стрельбе и восстанавливается после (StreamWeaponGlobalModel) */
  private streamEnergyNow(player: Player): number {
    const stream = player.loadout.weapon.stream;
    if (!stream) return 0;
    const now = Date.now();
    const dt = Math.max(0, now - player.streamEnergyAt) / 1000;
    if (player.streamFiring) player.streamEnergy = Math.max(0, player.streamEnergy - (player.loadout.weapon.kind === 'isida' ? player.isidaDrain : stream.dischargeRate) * dt);
    else {
      const recharge = player.loadout.weapon.kind === 'isida' ? (player.loadout.weapon.isida?.config ?? ISIDA_DEFAULT).chargeRate : stream.energyCapacity / Math.max(0.1, stream.rechargeMs / 1000);
      player.streamEnergy = Math.min(stream.energyCapacity, player.streamEnergy + recharge * dt);
    }
    player.streamEnergyAt = now;
    return player.streamEnergy;
  }

  streamStart(session: Session): void {
    if (!this.roundActive) return;
    const player = this.player(session);
    const stream = player.loadout.weapon.stream;
    if (!player.alive || !stream || player.streamFiring || this.streamEnergyNow(player) <= 0) return;
    player.streamFiring = true;
    player.lastStreamTickAt = player.loadout.weapon.kind !== 'isida' ? Date.now() : -Infinity;
    player.flameTicksLeft = stream.dischargeRate > 0 ? Math.trunc(player.streamEnergy * 1000 / stream.dischargeRate / stream.tickMs) : 2147483647;
    player.streamTargetIds = [];
    player.lastStreamEventAt = 0;
    player.isidaTarget = null;
    player.isidaDrain = (player.loadout.weapon.isida?.config ?? ISIDA_DEFAULT).dischargeIdleRate;
    player.streamEnergyAt = Date.now();
    this.broadcast('battle.stream', { shooterId: player.userId, active: true, kind: player.loadout.weapon.kind, targets: [], hit: null });
  }

  /** тик струи: урон (Огнемёт, Фриз, Изида) или лечение союзника (Изида) и температура */
  streamTick(session: Session, viewTime: number, targetHits: ShotHit[], origin: Vec3 | null = null): ShotResult {
    if (!this.roundActive) return { hits: [] };
    const player = this.player(session);
    const weapon = player.loadout.weapon;
    if (weapon.kind === 'isida') return this.isidaTick(player, viewTime, targetHits, origin);
    const stream = weapon.stream;
    if (!player.alive || !stream || !player.streamFiring) return { hits: [] };
    const now = Date.now();
    if (now - player.lastStreamTickAt < stream.tickMs - STREAM_TICK_TOLERANCE_MS) return { hits: [] };
    if (this.streamEnergyNow(player) <= 0 && (weapon.kind === 'isida' || player.flameTicksLeft <= 0)) {
      player.streamFiring = false;
      this.broadcast('battle.stream', { shooterId: player.userId, active: false, kind: weapon.kind, targets: [], hit: null });
      return { hits: [] };
    }
    if (weapon.kind !== 'isida') { if (player.flameTicksLeft <= 0) return {hits:[]}; player.flameTicksLeft--; }
    player.lastStreamTickAt = now;
    const seen = new Set<number>();
    const hits: ShotResult['hits'] = [];
    const targets: { userId: number; local: Vec3 }[] = [];
    let firstHit: Vec3 | null = null;
    for (const candidate of targetHits.slice(0, MAX_STREAM_TARGETS)) {
      if (seen.has(candidate.userId)) continue;
      seen.add(candidate.userId);
      const target = this.players.get(candidate.userId);
      if (!target || target === player || !target.alive || candidate.life !== target.life) continue;
      if (stream.range > 0 && distance(player.position ?? candidate.position, candidate.position) > stream.range * 100 + 200) continue;
      const valid = this.checkTarget(player, candidate, viewTime);
      if (!valid) continue;
      if(origin&&player.position&&this.detector){
        if(distance(origin,player.position)>Math.hypot(player.loadout.size.x,player.loadout.size.y,player.loadout.size.z)+500)continue;
        const from=new Vector3(origin.x,origin.y,origin.z);
        const direction=new Vector3(candidate.world.x-origin.x,candidate.world.y-origin.y,candidate.world.z-origin.z);
        const length=direction.length();
        if(length>10&&this.detector.hasStaticHit(from,direction.scale(1/length),255,length-10,null))continue;
      }
      let damage = player.loadout.damageFrom;
      damage *= weakening(candidate.position ? distance(player.position ?? candidate.position, candidate.position) : 0, weapon);
      this.damage(valid, damage, player);
      hits.push(this.hitResult(valid, false));
      targets.push({ userId: valid.userId, local: candidate.local });
      firstHit ??= candidate.world;
      if (weapon.kind === 'firebird' && weapon.flame) {
        const flame = weapon.flame;
        valid.heatLimit = flame.temperatureLimit;
        valid.heatCooling = flame.coolingRate;
        valid.burnMin = flame.burnDamageMin;
        valid.burnMax = flame.burnDamageMax;
        valid.heat = Math.min(flame.temperatureLimit, valid.heat + flame.heatingRate);
        valid.heatSource = player;
        valid.lastBurnAt ||= now;
      } else if (weapon.kind === 'freeze' && weapon.freeze) {
        const freeze = weapon.freeze;
        valid.coldMinTemperature = freeze.minTemperature;
        valid.coldBodyMaxFreezing = freeze.bodyMaxFreezing;
        valid.coldTurretMaxFreezing = freeze.turretMaxFreezing;
        valid.coldDefrosting = freeze.defrostingSpeed;
        valid.cold = Math.max(freeze.minTemperature, valid.cold - freeze.freezingSpeed);
        valid.coldSource = player;
        this.sendSpec(valid);
      }
    }
    const ids = targets.map((target) => target.userId);
    const changed = ids.length !== player.streamTargetIds.length || ids.some((id, index) => id !== player.streamTargetIds[index]);
    if (changed || now - player.lastStreamEventAt >= 200) {
      player.streamTargetIds = ids;
      player.lastStreamEventAt = now;
      this.broadcast('battle.stream', { shooterId: player.userId, active: true, kind: weapon.kind, targets, hit: firstHit });
    }
    return { hits };
  }

  /** Narukami's setTarget/resetTarget is independent of damage ticks. */
  isidaTarget(session: Session, viewTime: number, hit: ShotHit | null, origin: Vec3 | null = null): void {
    const player = this.player(session);
    if (!this.roundActive || !player.alive || !player.streamFiring || player.loadout.weapon.kind !== 'isida') return;
    this.streamEnergyNow(player); // settle old state's drain before switching
    const target = hit ? this.validIsidaTarget(player, hit, viewTime, origin) : null;
    const previous = player.isidaTarget;
    if (!target) hit = null;
    const changed = previous?.userId !== hit?.userId || previous?.life !== hit?.life;
    player.isidaTarget = hit;
    const cc = player.loadout.weapon.isida?.config ?? ISIDA_DEFAULT;
    player.isidaDrain = !target ? cc.dischargeIdleRate : this.teamMode && player.team === target.team ? cc.dischargeHealingRate : cc.dischargeDamageRate;
    if (changed) {
      player.isidaTickAt = Date.now() + cc.checkPeriodMsec;
      player.isidaTicksLeft = !target ? 0 : player.isidaDrain > 0 ? Math.trunc(player.streamEnergy * 1000 / player.isidaDrain / cc.checkPeriodMsec) : 2147483647;
    }
    this.broadcast('battle.stream', { shooterId: player.userId, active: true, kind: 'isida',
      targets: hit ? [{userId: hit.userId, local: hit.local}] : [], hit: hit?.world ?? null }, player);
  }

  private validIsidaTarget(player: Player, hit: ShotHit, viewTime: number, gunOrigin: Vec3 | null): Player | null {
    const target = this.players.get(hit.userId);
    const cc = player.loadout.weapon.isida?.config ?? ISIDA_DEFAULT;
    if (!target || target === player || target.state !== 'active' || target.life !== hit.life || !player.position) return null;
    const historical = this.positionAt(target, viewTime) ?? target.position;
    if (!historical || distance(historical, hit.position) > LAG_COMPENSATED_ALLOWANCE_CM) return null;
    if (distance(player.position, hit.world) > cc.radius + 200) return null;
    // Server has map collision geometry; reject a connection through a wall, for allies too.
    if (!gunOrigin || distance(gunOrigin, player.position) > Math.hypot(player.loadout.size.x,player.loadout.size.y,player.loadout.size.z)+500) return null;
    const origin = new Vector3(gunOrigin.x,gunOrigin.y,gunOrigin.z);
    const direction = new Vector3(hit.world.x-origin.x,hit.world.y-origin.y,hit.world.z-origin.z);
    const length=direction.length(); direction.normalize();
    if (this.detector?.hasStaticHit(origin,direction,255,Math.max(0,length-10),null)) return null;
    return target;
  }

  private isidaTick(player: Player, viewTime: number, hits: ShotHit[], origin: Vec3 | null): ShotResult {
    const weapon=player.loadout.weapon, data=weapon.isida, cc=data?.config ?? ISIDA_DEFAULT;
    if (!player.alive || !player.streamFiring || !data || hits.length !== 1) return {hits:[]};
    const now=Date.now(), selected=player.isidaTarget, hit=hits[0];
    if (!selected || selected.userId!==hit.userId || selected.life!==hit.life || now + STREAM_TICK_TOLERANCE_MS < player.isidaTickAt) return {hits:[]};
    this.streamEnergyNow(player);
    if (player.isidaTicksLeft <= 0) return {hits:[]};
    const target=this.validIsidaTarget(player,hit,viewTime,origin);
    if (!target) { this.isidaTarget(player.session,viewTime,null); return {hits:[]}; }
    player.isidaTicksLeft--;
    // Keep the scheduled cadence despite jitter, with at most one late tick per request.
    player.isidaTickAt=Math.max(player.isidaTickAt+cc.checkPeriodMsec,now+cc.checkPeriodMsec-STREAM_TICK_TOLERANCE_MS);
    const ally=this.teamMode && player.team===target.team;
    if (ally) {
      const healed=Math.min(data.healingPerPeriod,target.loadout.maxHealth-target.health);
      target.health=Math.min(target.loadout.maxHealth,target.health+data.healingPerPeriod);
      if(healed>0&&target.position)this.send(player,'battle.damage',{position:{...target.position,z:target.position.z+100},amount:Math.max(1,Math.round(healed)),type:'heal'});
      this.broadcast('battle.health',{userId:target.userId,life:target.life,health:Math.round(target.health)});
    } else {
      const before=target.health;
      this.damage(target,data.damagePerPeriod,player);
      const restored=Math.max(0,before-target.health)*data.selfHealingPercent/100;
      if (restored>0 && player.state==='active') {
        player.health=Math.min(player.loadout.maxHealth,player.health+restored);
        this.broadcast('battle.health',{userId:player.userId,life:player.life,health:Math.round(player.health)});
      }
    }
    return {hits:[this.hitResult(target,false)]};
  }

  streamStop(session: Session): void {
    const player = this.player(session);
    if (!player.streamFiring) return;
    this.streamEnergyNow(player);
    player.streamFiring = false;
    player.isidaTarget = null;
    player.streamTargetIds = [];
    player.streamEnergyAt = Date.now();
    this.broadcast('battle.stream', { shooterId: player.userId, active: false, kind: player.loadout.weapon.kind, targets: [], hit: null });
  }
}

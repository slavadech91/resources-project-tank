import type {AppearanceMap,AppearanceStyle} from './appearance.ts';
import type { IsidaConfig } from './isida.ts';
import type { BonusRegion } from '../map/types.ts';
/**
 * Протокол v2: html5-клиент ↔ server2 (TypeScript-сервер, `server2/`). Общий файл: server2 импортирует его при сборке,
 * поэтому здесь только типы и чистые функции без DOM и Node.
 *
 * WebSocket на пути WS_PATH. Текстовые кадры — JSON-объекты с полем `t` (тип):
 * - запрос клиента `{t, id, ...аргументы}` → ответ `{t: 'reply', id, ok: true, ...данные}` или
 *   `{t: 'reply', id, ok: false, error, message?}` (`id` — номер запроса у клиента);
 * - событие сервера `{t, ...данные}` без `id`.
 * Первый запрос — `hello`; до входа доступны только `hello`, `auth.login`, `auth.register`.
 * Двоичные кадры — поток боя (часы и синхронизация движения), формат — `battleCodec.ts`.
 */

export const PROTOCOL_VERSION = 1;
export const BEGINNER_BATTLE_ID = 0x7ffffffe;
export const WS_PATH = '/ws2';

/** правила старого сервера (login/registration_command_handler.py) */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{1,20}$/;
export const PASSWORD_MAX_LENGTH = 50;
export const BATTLE_NAME_MAX_LENGTH = 30;

export type ErrorCode =
  | 'bad_request'
  | 'unknown_request'
  | 'not_authenticated'
  | 'forbidden'
  | 'wrong_password'
  | 'name_taken'
  | 'invalid_name'
  | 'invalid_password'
  | 'not_found'
  | 'no_crystals'
  | 'rate_limited'
  | 'version'
  | 'server_error';

export interface UserInfo {
  id: number;
  name: string;
  /** звание 1–30 */
  rank: number;
  score: number;
  /** очки начала текущего звания */
  rankScore: number;
  /** очки следующего звания (у последнего — его же порог) */
  nextRankScore: number;
  crystals: number;
  admin: boolean;
}

export type BattleMode = 'dm' | 'tdm' | 'ctf';

export interface MapSummary {
  id: number;
  name: string;
  maxPeople: number;
  modes: BattleMode[];
  minRank: number;
  maxRank: number;
  theme: string;
  /** id ресурса превью (configs/path_to_id.json) — картинка лобби `/lobby/res/<id>.png` */
  previewId: number;
}

/** лимиты нового боя по умолчанию (dm_battle_limit / tdm_battle_limit сервера) */
export interface BattleLimit {
  scoreLimit: number;
  timeLimitSec: number;
}

export const MAX_BOTS = 16;

export interface BattleRules {
 autoBalance?:boolean;friendlyFire?:boolean;withoutBonuses?:boolean;withoutCrystals?:boolean;withoutSupplies?:boolean;withoutMines?:boolean;withoutMedkit?:boolean;withoutGoldBoxes?:boolean;withoutGoldSiren?:boolean;withoutUpgrades?:boolean;privateBattle?:boolean;
 equipmentConstraintsMode?:'NONE'|'HORNET_RAILGUN'|'WASP_RAILGUN'|'HORNET_WASP_RAILGUN';
}
export interface BattleSettings extends BattleRules {
  botCount?: number;
  name: string;
  mode: BattleMode;
  mapId: number;
  maxPeople: number;
  timeLimitSec: number;
  scoreLimit: number;
  minRank: number;
  maxRank: number;
}

/** игрок в бою для окна информации о бое: ник, звание, убийства (BattleInfoView старого клиента) */
export interface BattleUserSummary {
  score?:number;
  userId: number;
  name: string;
  rank: number;
  kills: number;
  team: BattleTeam;
}

export interface BattleSummary extends BattleSettings {
  teamScores?:[number,number];
  id: number;
  mapName: string;
  /** игроков в бою по командам (в DM — всё в `players[0]`) */
  players: [number, number];
  /** кто сейчас в бою (DM — все, TDM — по командам) */
  users: BattleUserSummary[];
}

/** свойство предмета: id ItemProperty (hull_armor = 0, …), значения M0…max-улучшения (в единицах гаража) */
export interface ItemPropertyValue {
  itemPropertyId: number;
  initial: number;
  final: number;
}

/** улучшаемый параметр: id ItemGarageProperty (hull_armor = 1, damage = 40, …), уровень микроулучшений */
export interface UpgradeInfo {
  propertyId: number;
  level: number;
  maxLevel: number;
}

/**
 * Предмет гаража для игрока (как модели предмета старого протокола): id — id предмета из configs/garage_items,
 * картинки и модели — id ресурсов (configs/path_to_id.json). Категория — ITEM_CATEGORY (0 пушка, 1 корпус, 2 краска,
 * 3 припас, 4 плагин, 5 комплект, 6 эмблема). Цена — с учётом скидки не пересчитана (как BuyableModel), скидка — %.
 */
export interface GarageItemInfo {
  id: number;
  name: string;
  description: string;
  category: number;
  position: number;
  minRank: number;
  maxRank: number;
  previewId: number;
  price: number;
  discount: number;
  saleImageId: number | null;
  baseItemId: number | null;
  modification: number;
  object3dsId: number | null;
  coloringId: number | null;
  /** у припасов — сколько есть у игрока */
  count: number;
  countable: boolean;
  /** все свойства предмета (одни на все улучшаемые параметры) */
  values: ItemPropertyValue[];
  upgrades: UpgradeInfo[];
}

/** склад (купленное), магазин и надетое — id предметов */
export interface GarageLists {
  appearances?:AppearanceMap;
  depot: number[];
  market: number[];
  mounted: number[];
}

// ------------------------------------------------------------------ бой

/**
 * Бой: JSON — вход/выход, спавн, выстрелы, урон, смерть, статистика; двоичные кадры (`battleCodec.ts`) — часы и
 * синхронизация движения v2 (состояние своего танка 20 Гц, снапшоты чужих). Координаты — как в карте (см),
 * углы — радианы. Жизнь (`life`) — номер жизни танка: растёт с каждым спавном, отсекает запоздавшие состояния и попадания.
 */

/** команда танка — как BATTLE_TEAM клиента */
export const TEAM = { RED: 0, BLUE: 1, NONE: 2 } as const;
export type BattleTeam = (typeof TEAM)[keyof typeof TEAM];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** оружие танка для клиента: тип и параметры, которые старый сервер отдавал моделями оружия */
export interface WeaponInfo {
  /** smoky, twins, railgun, thunder, shaft, firebird, freeze, isida, ricochet */
  kind: string;
  reloadMs: number;
  autoAimUp: number;
  autoAimDown: number;
  /** ослабление урона по расстоянию, м и % */
  maxDamageRadius: number;
  minDamageRadius: number;
  minDamagePercent: number;
  /** рельса: зарядка, мс; урон каждой следующей цели умножается на weakeningCoeff */
  chargingMs: number;
  weakeningCoeff: number;
  /** Twins: дальность, радиус и скорость снаряда, м */
  twins: { distance: number; shotRadius: number; speed: number } | null;
  /** Гром: разрывной снаряд; радиус сплеша (м) и урон в центре/на краю (HP) */
  splash: { radius: number; damageFrom: number; damageTo: number; fullDamageRadius?: number; minimumDamagePercent?: number; impactForce?: number } | null;
  /** потоковые пушки (Огнемёт, Фриз, Изида): тик, энергия, конус и дальность (м) */
  stream: { tickMs: number; energyCapacity: number; dischargeRate: number; rechargeMs: number; coneAngle: number; range: number } | null;
  /** Шафт: аркадный и прицельный выстрел, энергия зарядки и расход при прицеливании */
  shaft: {
    aimedMinDamage: number;
    aimedMaxDamage: number;
    maxEnergy: number;
    chargeRate: number;
    dischargeRate: number;
    fastShotEnergy: number;
    aimedImpact: number;
    targetingTransitionMs?:number; initialFov?:number; minimumFov?:number; horizontalSpeed?:number; verticalSpeed?:number;
    afterShotPauseMs: number;
    /** урон каждой следующей пробитой цели */
    weakeningCoeff: number;
  } | null;
  /** Фриз: замедление от температуры */
  freeze: { freezingSpeed: number; defrostingSpeed: number; minTemperature: number; bodyMaxFreezing: number; turretMaxFreezing: number } | null;
  /** Огнемёт: поджиг цели */
  flame: { heatingRate: number; coolingRate: number; burnDamageMin: number; burnDamageMax: number; temperatureLimit: number } | null;
  /** Изида: урон и лечение за период, доля самолечения */
  isida: { healingPerPeriod: number; damagePerPeriod: number; selfHealingPercent: number; config?: IsidaConfig } | null;
  /** Рикошет: скорость (м/с), полная дальность пути (м), радиус шара (м) и энергия */
  ricochet: {
    speed: number;
    range: number;
    shotRadius: number;
    energyCapacity: number;
    energyPerShot: number;
    energyRecharge: number;
    maxBounces?: number;
  } | null;
}

/** состояние танка на сервере: вне поля (ждёт спавна), появился (без оружия), активен, уничтожен */
export type TankState = 'out' | 'spawned' | 'active' | 'dead';

export interface BattlePlayer {
  isBot?: boolean;
  userId: number;
  name: string;
  rank: number;
  team: BattleTeam;
  /** id ресурсов моделей корпуса и пушки и картинки краски (как TankPartIds клиента) */
  parts: { hull: number | null; turret: number | null; paint: number | null; hullStyle?:AppearanceStyle;turretStyle?:AppearanceStyle };
  weapon: WeaponInfo;
  maxHealth: number;
  health: number;
  state: TankState;
  life: number;
  /** где танк сейчас (или точка спавна) — для входящего в идущий бой */
  position: Vec3 | null;
  orientation: Vec3 | null;
  kills: number;
  deaths: number;
  score: number;
}

export type CtfAction = 'taken' | 'dropped' | 'returned' | 'captured';
export interface CtfFlag { team:0|1; base:Vec3; position:Vec3; state:'base'|'carried'|'dropped'; carrierId:number|null; returnAt:number; }

export interface BattleInfo {
  flags?:CtfFlag[];
  battle: BattleSummary;
  /** папка карты клиента (public/maps/<mapKey>) */
  mapKey: string;
  players: BattlePlayer[];
  /** счёт красных и синих */
  teamScores: [number, number];
  /** до конца раунда, с (0 — без лимита времени) */
  timeLeftSec: number;
  /** фонд боя, кристаллы (StatisticsModel.fund) */
  fund: number;
  /** идут итоги раунда: через столько секунд новый раунд (null — раунд идёт) */
  roundEndInSec: number | null;
  /** ящики на поле при входе */
  bonuses: BonusInfo[];
  /** Серверные зоны для меток карты в текущем режиме. */
  bonusRegions?: BonusRegion[];
  /** скорость падения ящика, единиц карты в секунду (server_properties.bonus_fall_speed) */
  bonusFallSpeed: number;
  /** инвентарь боя (клавиши 1–5) */
  inventory: InventoryItemInfo[];
  /** мины на поле при входе */
  mines: MineInfo[];
  activationDelayMs: number;
  respawnDelayMs: number;
  friendlyFire: boolean;
}

/** итог раунда по игроку (ROUND_FINISH rewards старого сервера: награда из фонда) */
export interface BattleRoundPlayer {
  userId: number;
  kills: number;
  deaths: number;
  score: number;
  /** кристаллы из фонда боя */
  reward: number;
}

/** ящик на поле: тип (модель клиента bonuses/<kind>_box.json) */
export type BonusKind = 'armor' | 'crystal' | 'gold' | 'med' | 'nos' | 'power';

/** индексы EffectDescriptionModel старого сервера (FIRST_AID_EFFECT_INDEX и т. д.): значки над танком */
export const EFFECT = { FIRST_AID: 1, DOUBLE_ARMOR: 2, DOUBLE_POWER: 3, NITRO: 4 } as const;
export type EffectIndex = (typeof EFFECT)[keyof typeof EFFECT];

export interface ActiveEffectInfo {
  userId: number;
  effect: EffectIndex;
  leftMs: number;
}

/**
 * Ящик на поле (BattleBonus): точка подвеса на парашюте — как position бонуса старого сервера. Клиент сам опускает
 * ящик на землю (лучом вниз по статике карты) со скоростью bonusFallSpeed; за время жизни ящика отвечает сервер.
 */
export interface BonusInfo {
  bonusId: number;
  kind: BonusKind;
  position: Vec3;
  /** Ключ центра зоны, без случайного смещения точки падения. */
  zoneKey?: string;
  /** сколько ящик уже существует, мс: вход в бой посреди падения и уже лежащий ящик */
  ageMs: number;
}

/**
 * Припас в инвентаре боя (InventoryItemModel старого сервера): клавиши 1–5 в порядке slots server_properties
 * (аптечка, двойная броня, двойной урон, нитро, мина). Счётчик и перезарядку ведёт сервер; перезарядка
 * сбрасывается при активации танка (InventoryModel.onLocalTankActivationEvent).
 */
export interface InventoryItemInfo {
  /** 1–5: клавиша, кадр иконки InventoryIcon и слот HUD (slot − 1) */
  index: number;
  /** id предмета гаража (server_properties, 500–504) */
  itemId: number;
  /** сколько припасов у игрока */
  count: number;
  /** перезарядка слота после применения, мс (0 — без перезарядки) */
  cooldownMs: number;
}

/** мина на поле (BattleMinesGlobalModel): точка уже на земле (+ mine_offset_from_ground), сервер её посчитал лучом */
export interface MineInfo {
  mineId: number;
  ownerId: number;
  team: BattleTeam;
  position: Vec3;
  /** взвелась через mine_activate_time_ms; до этого на неё нельзя наступить */
  activated: boolean;
}

/** вид сообщения чата (chat_service.py: 0 игрок, 1 система, 2 ответ на команду) */
export const CHAT_KIND = { PLAYER: 0, SYSTEM: 1, REPLY: 2 } as const;
export type ChatKind = (typeof CHAT_KIND)[keyof typeof CHAT_KIND];

/** попадание по танку: точка в системе цели и в мире, позиция цели, какой её видел стрелок */
export interface ShotHit {
  userId: number;
  life: number;
  local: Vec3;
  world: Vec3;
  position: Vec3;
}

/** итог выстрела для стрелка: HP целей после попадания (отклонённые цели не попадают в список) */
export interface ShotResult {
  hits: { userId: number; health: number; life: number; critical: boolean }[];
}

export interface LobbyChatMessage {messageId:number;userId:number;author:string;rank:number;text:string;recipient?:{userId:number;author:string;rank:number}}

export interface DailyMission {
  id: 'kills' | 'score' | 'boxes';
  title: string;
  target: number;
  reward: number;
  progress: number;
  claimed: boolean;
}

export interface DailyMissionsState {
  day: string;
  resetInMs: number;
  missions: DailyMission[];
}

export interface Requests {
  'missions.list': { req: Record<string, never>; res: DailyMissionsState };
  'missions.claim': { req: { missionId: DailyMission['id']; day: string }; res: DailyMissionsState };
  hello: { req: { version: number }; res: { server: string; version: number } };
  'auth.login': { req: { username: string; password: string }; res: { user: UserInfo } };
  'auth.register': { req: { username: string; password: string }; res: { user: UserInfo } };
  /** список боёв и карт; после него приходят события lobby.battle / lobby.battleRemoved */
  'lobby.battles': { req: Record<string, never>; res: { battles: BattleSummary[]; maps: MapSummary[]; limits: Record<BattleMode, BattleLimit> } };
  'lobby.chatWatch':{req:Record<string,never>;res:{messages:LobbyChatMessage[]}};
  'lobby.chatUnwatch':{req:Record<string,never>;res:Record<string,never>};
  'lobby.chatSend':{req:{text:string};res:Record<string,never>};
  'lobby.getBattle':{req:{battleId:number};res:{battle:BattleSummary}};
  'lobby.create': { req: BattleSettings; res: { battle: BattleSummary } };
  'lobby.remove': { req: { battleId: number }; res: Record<string, never> };
  /** весь гараж: предметы и списки */
  'garage.appearance':{req:{itemId:number;style:AppearanceStyle};res:{appearances:AppearanceMap}};
  'garage.load': { req: Record<string, never>; res: GarageLists & { items: GarageItemInfo[] } };
  /** покупка (припас — count штук); price — ожидаемая сумма, при расхождении с сервером покупка отклоняется */
  'garage.buy': { req: { itemId: number; count: number; price: number }; res: GarageLists & { updated: GarageItemInfo[] } };
  /** покупка следующей модификации: itemId — следующая модификация, price — её цена со скидкой за улучшения */
  'garage.buyNext': { req: { itemId: number; price: number }; res: GarageLists & { updated: GarageItemInfo[] } };
  'garage.mount': { req: { itemId: number }; res: GarageLists };
  /** вход в бой (team — в командном бою, иначе в меньшую команду); после него идут события battle.* и двоичные кадры */
  'battle.join': { req: { battleId: number; team?: BattleTeam }; res: { info: BattleInfo } };
  'battle.leave': { req: Record<string, never>; res: Record<string, never> };
  /** клиент готов к спавну (карта загружена; после смерти — экран смерти прошёл) */
  'battle.flags': {req:Record<string,never>;res:{flags:CtfFlag[]}};
  'battle.dropFlag': {req:Record<string,never>;res:Record<string,never>};
  'battle.ready': { req: Record<string, never>; res: Record<string, never> };
  /** танк ни во что не упирается после задержки активации — включить оружие */
  'battle.activate': { req: { life: number }; res: Record<string, never> };
  /** самоуничтожение (через 10 с) */
  'battle.suicide': { req: Record<string, never>; res: Record<string, never> };
  /** Смоки: выстрел в никуда (нет ни hit, ни target), в стену (hit) или в танк (target); viewTime — серверное время чужих танков у стрелка */
  'battle.smoky': { req: { viewTime: number; hit?: Vec3; target?: ShotHit }; res: ShotResult };
  'battle.railCharge': { req: Record<string, never>; res: Record<string, never> };
  /** рельса: точка в стене (если луч упёрся в стену) и пробитые танки по порядку от стрелка; dummy — башня в земле, луча нет */
  'battle.rail': { req: { viewTime: number; hit: Vec3 | null; targets: ShotHit[]; dummy?: boolean }; res: ShotResult };
  /** Twins: выстрел снарядом (направление — единичный вектор) */
  'battle.twins': { req: { barrel: number; shotId: number; direction: Vec3 }; res: Record<string, never> };
  /** снаряд Twins попал в танк */
  'battle.twinsHit': { req: { viewTime: number; shotId: number; target: ShotHit }; res: ShotResult };
  /** Гром: выстрел в никуда, в стену (hit) или в танк (target); сплеш считает сервер */
  'battle.thunder': { req: { viewTime: number; hit?: Vec3; target?: ShotHit }; res: ShotResult };
  /** Рикошет: выстрел (направление — единичный вектор), снаряд отражается от статики у клиента */
  'battle.ricochet': { req: { shotId: number; direction: Vec3 }; res: Record<string, never> };
  /** снаряд Рикошета попал в танк; bounces > 0 разрешает попадание в самого стрелка (свой отскок) */
  'battle.ricochetHit': { req: { viewTime: number; shotId: number; target: ShotHit; bounces?: number }; res: ShotResult };
  /** Шафт: вход в прицельный режим и выход из него (энергия копится при полной перезарядке) */
  'battle.shaftAim': { req: { active: boolean }; res: Record<string, never> };
  /** Шафт: выстрел; aimed — прицельный (targets пробиваются по порядку с weakeningCoeff), иначе аркадный */
  'battle.shaft': { req: { viewTime: number; aimed: boolean; hit: Vec3 | null; targets: ShotHit[] }; res: ShotResult };
  /** потоковая пушка: начало струи (расход энергии и звук) */
  'battle.streamStart': { req: { viewTime: number }; res: Record<string, never> };
  /** потоковая пушка: тик урона/лечения по целям в конусе (не чаще tickMs) */
  'battle.streamTick': { req: { viewTime: number; targets: ShotHit[]; origin?: Vec3 }; res: ShotResult };
  'battle.isidaTarget': { req: { viewTime: number; target: ShotHit | null; origin?: Vec3 }; res: Record<string, never> };
  'battle.streamStop': { req: Record<string, never>; res: Record<string, never> };
  /** танк коснулся ящика (ATTEMPT_TO_TAKE_BONUS): сервер проверяет, что танк жив и ящик есть, и применяет припас */
  'battle.takeBonus': { req: { bonusId: number }; res: Record<string, never> };
  /** сверка ящиков после загрузки карты: что на поле сейчас (события за время загрузки клиент пропустил) */
  'battle.bonuses': { req: Record<string, never>; res: { bonuses: BonusInfo[] } };
  'battle.effects': { req: Record<string, never>; res: { effects: ActiveEffectInfo[] } };
  /** применить припас из инвентаря (клавиши 1–5); сервер проверяет активность танка, количество и перезарядку */
  'battle.activateItem': { req: { index: number }; res: Record<string, never> };
  /** сверка мин после загрузки карты */
  'battle.mines': { req: Record<string, never>; res: { mines: MineInfo[] } };
  /** сообщение чата боя; текст с «/» — команда администратора (ответ — событие battle.chat) */
  'battle.chat': { req: { text: string }; res: Record<string, never> };
}

export type KickReason = 'relogin' | 'banned' | 'shutdown' | 'admin';

/** почему танк уничтожен */
export type KillReason = 'killed' | 'suicide';

export interface Events {
  user: { user: UserInfo };
  'lobby.chat':{message:LobbyChatMessage};
  'lobby.battle': { battle: BattleSummary };
  'lobby.battleRemoved': { battleId: number };
  kicked: { reason: KickReason };
  'battle.player': { player: BattlePlayer };
  'battle.playerLeft': { userId: number };
  /** только себе: камера летит к точке спавна, через spawnDelayMs — battle.spawn */
  'battle.prepare': { position: Vec3; orientation: Vec3; spawnDelayMs: number };
  'battle.spawn': { userId: number; life: number; team: BattleTeam; position: Vec3; orientation: Vec3; health: number };
  'battle.activate': { userId: number; life: number };
  'battle.health': { userId: number; life: number; health: number };
  'battle.damage': {position:Vec3;amount:number;type:'normal'|'critical'|'fatal'|'heal'};
  'battle.kill': { weapon?: string|null; userId: number; life: number; killerId: number | null; reason: KillReason; respawnDelayMs: number };
  'battle.stat': { userId: number; kills: number; deaths: number; score: number };
  'battle.teamScore': { scores: [number, number] };
  /** фонд боя изменился (StatisticsModel.add_fund → FUND_CHANGE) */
  'battle.fund': { fund: number };
  /** раунд окончен: итоги с наградой из фонда и отсчётом до нового (StatisticsModel.roundFinish) */
  'battle.roundEnd': { timeToRestartSec: number; fund: number; results: BattleRoundPlayer[]; teamScores: [number, number] };
  /** танки уходят с поля (BattleFieldModel.battleRestart), до новых спавнов */
  'battle.restart': Record<string, never>;
  /** новый раунд: лимит времени, команды после смены; статистика игроков обнулена (roundStart) */
  'battle.roundStart': { timeLeftSec: number; teams: { userId: number; team: BattleTeam }[] };
  /** самоуничтожение принято: череп на экране, смерть через delayMs */
  'battle.suicideStarted': { delayMs: number };
  /** новый ящик упал на поле (SPAWN_BONUSES) */
  'battle.bonusSpawned': { bonus: BonusInfo };
  /** ящик взят игроком (BONUS_TAKEN) — ящик поднимается и исчезает */
  'battle.bonusTaken': { bonusId: number; userId: number; kind: BonusKind };
  /** ящики убраны: истёк срок жизни или конец раунда (REMOVE_BONUSES) */
  'battle.bonusesRemoved': { bonusIds: number[] };
  /** припас подействовал на танк: значок эффекта; leftMs null — эффект кончился (EffectDescriptionModel) */
  'battle.effect': { userId: number; effect: EffectIndex; leftMs: number | null; position?: Vec3 };
  /** характеристики танка умножены (SET_SPECIFICATION: нитро 1.3 и возврат к 1) */
  'battle.spec': { userId: number; speedFactor: number; temperature?: number };
  /** золотой ящик скоро упадёт: сообщение всем (gold_notification_message), через delaySec — ящик */
  'battle.flags': {flags:CtfFlag[];action?:CtfAction;flagTeam?:0|1;userId?:number;name?:string};
  'battle.goldNotify': { message: string; delaySec: number };
  /** золотой ящик взят (GOLD_TAKEN) */
  'battle.goldTaken': { userId: number; name: string; crystals: number };
  /** припас применён: новый счётчик и перезарядка (только игроку) */
  'battle.inventory': { index: number; count: number; cooldownMs: number };
  /** мина поставлена (PUT_MINE) — точка уже на земле */
  'battle.minePlaced': { mine: MineInfo };
  /** мина взвелась через mine_activate_time_ms (ACTIVATE_MINE) */
  'battle.mineActivated': { mineId: number };
  /** мина взорвалась под танком (EXPLODE_MINE) */
  'battle.mineExploded': { mineId: number; userId: number };
  /** мины сняты (конец раунда, выход владельца) — REMOVE_MINES */
  'battle.minesRemoved': { mineIds: number[] };
  /** сообщение чата боя (chat_service.py: автор и звание; kind 0 игрок, 1 система, 2 ответ на команду) */
  'battle.chat': { author: string; rank: number; kind: ChatKind; text: string };
  /** выстрелы других игроков (стрелку не приходят) */
  'battle.smoky': { shooterId: number; hit: Vec3 | null; target: { userId: number; local: Vec3 } | null; impact: number; critical: boolean };
  'battle.railCharge': { shooterId: number };
  'battle.rail': { shooterId: number; hit: Vec3 | null; targets: { userId: number; local: Vec3 }[]; dummy: boolean };
  'battle.twins': { shooterId: number; barrel: number; shotId: number; direction: Vec3 };
  /** Гром: разрыв; сплеш уже нанесён, у всех — взрыв в точке */
  'battle.thunder': { shooterId: number; hit: Vec3 | null; target: { userId: number; local: Vec3 } | null };
  /** Рикошет: выстрел и попадание (для шаров и отскоков у чужих танков) */
  'battle.ricochet': { shooterId: number; shotId: number; direction: Vec3 };
  'battle.ricochetHit': { shooterId: number; shotId: number; target: { userId: number; local: Vec3 } };
  /** Шафт: вход/выход из прицела и выстрел */
  'battle.shaftAim': { shooterId: number; active: boolean };
  'battle.shaft': { shooterId: number; aimed: boolean; hit: Vec3 | null; targets: { userId: number; local: Vec3 }[] };
  /** потоковая пушка: струя включена (targets — кто под ней), выключена или изменились цели */
  'battle.stream': { shooterId: number; active: boolean; kind: string; targets: { userId: number; local: Vec3 }[]; hit: Vec3 | null };
  /** бой закрыт (удалён администратором) — игрок уже вне боя */
  'battle.closed': { battleId: number };
}

export type RequestName = keyof Requests;
export type EventName = keyof Events;
export type RequestArgs<K extends RequestName> = Requests[K]['req'];
export type ReplyData<K extends RequestName> = Requests[K]['res'];

export type RequestMessage<K extends RequestName = RequestName> = { t: K; id: number } & RequestArgs<K>;
export type ReplyOk<K extends RequestName = RequestName> = { t: 'reply'; id: number; ok: true } & ReplyData<K>;
export interface ReplyError {
  t: 'reply';
  id: number;
  ok: false;
  error: ErrorCode;
  message?: string;
}
export type EventMessage<K extends EventName = EventName> = { t: K } & Events[K];

/** допустимая ширина диапазона званий боя по званию создателя (rank_ranges.py старого сервера), звание 1–30 */
const RANK_RANGE_LENGTH = [5, 5, 5, 5, 6, 6, 6, 7, 7, 8, 8, 8, 9, 9, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 12, 13, 14, 15, 16];

export function rankRangeLength(rank: number): number {
  return RANK_RANGE_LENGTH[Math.max(1, Math.min(30, rank)) - 1];
}

export const PUBLIC_REQUESTS: readonly RequestName[] = ['hello', 'auth.login', 'auth.register'];

/** пароль — как у старого сервера `^.{1,50}$`: 1–50 символов (кодовых точек, как в Python), без перевода строки */
export function isValidPassword(password: string): boolean {
  const length = Array.from(password).length;
  return length >= 1 && length <= PASSWORD_MAX_LENGTH && !password.includes('\n');
}

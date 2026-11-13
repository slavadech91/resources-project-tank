import type {AppearanceMap,AppearanceStyle} from '../net2/appearance.ts';
import type {BattleRules} from '../net2/protocol.ts';
/**
 * Данные лобби по протоколу: разделы (LobbyLayoutModel SHOW_BATTLE_SELECT / SHOW_GARAGE), список боёв и информация
 * о выбранном бое (battle_select), предметы гаража (garage). Только чтение моделей и отправка команд, без интерфейса.
 */

import { MODEL_ID, type GameClient, type RemoteObject } from './client.ts';

export const LOBBY_COMMAND = {
  SHOW_BATTLE_SELECT: 300070008,
  SHOW_GARAGE: 300070009,
  ON_BATTLE_SELECT: 300090024,
  FIGHT_DM: 300090007,
  /** BattleCreateModelCommandHandler (сервер): CREATE_BATTLE(BattleCreateCodec) */
  CREATE_BATTLE: 300090001,
  /** GarageModelCommandHandler (сервер): клиент -> сервер */
  ITEM_BOUGHT: 300040000,
  ITEM_MOUNTED: 300040001,
  KIT_BOUGHT: 300040002,
  NEXT_MODIFICATION_BOUGHT: 300040003,
} as const;

const MODEL = {
  BATTLE_SELECT: 300090011,
  BATTLE_ITEM: 300090008,
  BATTLE_DM_ITEM: 300090004,
  TEAM_BATTLE_ITEM: 300090028,
  BATTLE_INFO: 300090007,
  BATTLE_DM_INFO: 300090003,
  TEAM_BATTLE_INFO: 300090027,
  MAP_INFO: 300090019,
  BATTLE_CREATE: 300090002,
  GARAGE: 300040008,
  DESCRIPTION: 170002,
  BUYABLE: 300040001,
  COUNTABLE: 300040004,
  DISCOUNT: 300040006,
  KIT: 300040007,
  CATEGORY: 300040010,
  ITEM: 300040012,
  MODIFICATION: 300040016,
  OBJECT_3DS: 300040017,
  UPGRADEABLE: 300040026,
  COLORING: 300070004,
} as const;

export const BATTLE_MODE = { DM: 0, TDM: 1, CTF: 2, CP: 3 } as const;

/** ItemCategoryEnum */
export const ITEM_CATEGORY = { WEAPON: 0, ARMOR: 1, COLOR: 2, INVENTORY: 3, PLUGIN: 4, KIT: 5, EMBLEM: 6 } as const;

export interface LobbyBattle {
  objectId: number;
  battleId: number;
  name: string;
  mode: number;
  mapName: string;
  maxPeople: number;
  /** DM: число игроков; TDM/CTF/CP: красные и синие */
  all: number;
  reds: number;
  blues: number;
  rankMin: number;
  rankMax: number;
  proBattle: boolean;
  privateBattle: boolean;
  suspicious: boolean;
  noSupplies: boolean;
}

export interface BattleUser {
  score?:number;
  userId: number;
  kills: number;
  suspicious: boolean;
}

export interface LobbyBattleInfo {
  teamScores?:[number,number];
  objectId: number;
  battleId: number;
  name: string;
  mode: number;
  mapName: string;
  previewId: number;
  maxPeople: number;
  scoreLimit: number;
  timeLimit: number;
  timeLeft: number;
  rankMin: number;
  rankMax: number;
  proBattle: boolean;
  withoutBonuses: boolean;
  withoutCrystals: boolean;
  withoutSupplies: boolean;
  withoutUpgrades: boolean;
  autoBalance: boolean;
  friendlyFire: boolean;
  users: BattleUser[];
  reds: BattleUser[];
  blues: BattleUser[];
}

export interface UpgradeProperty {
  propertyId: number;
  level: number;
  maxLevel: number;
  /** значения: initial/final по id свойства ItemProperty; у нашего сервера обычно нет */
  values: { itemPropertyId: number; initial: number; final: number }[] | null;
}

export interface GarageItem {
  objectId: number;
  name: string;
  description: string;
  category: number;
  position: number;
  minRank: number;
  maxRank: number;
  previewId: number;
  price: number;
  buyable: boolean;
  count: number;
  discount: number;
  saleImageId: number | null;
  baseItemId: number | null;
  modification: number;
  object3dsId: number | null;
  coloringId: number | null;
  properties: UpgradeProperty[];
}

type Data = Record<string, unknown>;

function model<T = Data>(object: RemoteObject | undefined, id: number): T | undefined {
  return object?.models.get(id) as T | undefined;
}

function enumValue(value: unknown): number {
  if (typeof value == 'number') return value;
  if (value && typeof value == 'object') return Number(Object.values(value)[0] ?? 0);
  return 0;
}

/** Ник и звание игроков из UidNotifier / RankNotifier (команды SET_UID / SET_RANK в lobby) */
export class UserDirectory {
  private readonly uids = new Map<number, string>();
  private readonly ranks = new Map<number, number>();

  constructor(client: GameClient) {
    client.on('command', (event) => {
      if (event.name == 'SET_UID') for (const info of (event.args as { user_infos: { uid: string; user_id: number }[] }).user_infos) this.uids.set(info.user_id, info.uid);
      if (event.name == 'SET_RANK') for (const info of (event.args as { user_infos: { rank: number; user_id: number }[] }).user_infos) this.ranks.set(info.user_id, info.rank);
    });
  }

  uid(userId: number): string {
    return this.uids.get(userId) ?? `#${userId}`;
  }

  rank(userId: number): number {
    return this.ranks.get(userId) ?? 1;
  }
}

export function showBattleSelect(client: GameClient): void {
  const layout = client.findObjectWithModel(client.getSpace('lobby'), MODEL_ID.LOBBY_LAYOUT);
  if (layout) client.sendCommand('lobby', layout.id, LOBBY_COMMAND.SHOW_BATTLE_SELECT);
}

export function showGarage(client: GameClient): void {
  const layout = client.findObjectWithModel(client.getSpace('lobby'), MODEL_ID.LOBBY_LAYOUT);
  if (layout) client.sendCommand('lobby', layout.id, LOBBY_COMMAND.SHOW_GARAGE);
}

/** BattleSelectModel.onBattleSelect: сервер загружает объект информации о бое */
export function selectBattle(client: GameClient, battleObjectId: number): void {
  const select = client.findObjectWithModel(client.getSpace('battle_select'), MODEL.BATTLE_SELECT);
  if (select) client.sendCommand('battle_select', select.id, LOBBY_COMMAND.ON_BATTLE_SELECT, (writer) => writer.i64(battleObjectId));
}

export function readBattles(client: GameClient): LobbyBattle[] {
  const space = client.getSpace('battle_select');
  const battles: LobbyBattle[] = [];
  for (const object of space?.objects.values() ?? []) {
    const item = model<{
      battle_id: number;
      name: string;
      battle_mode: unknown;
      map_game_object_id: number;
      max_people_count: number;
      without_supplies: boolean;
      private_battle: boolean;
      pro_battle: boolean;
      suspicious: boolean;
      rank_range?: { min: number; max: number };
    }>(object, MODEL.BATTLE_ITEM);
    if (!item) continue;
    const map = model<{ map_name: string }>(space?.objects.get(item.map_game_object_id), MODEL.MAP_INFO);
    const dm = model<{ user_ids: number[] }>(object, MODEL.BATTLE_DM_ITEM);
    const team = model<{ blue_user_ids: number[]; red_user_ids: number[] }>(object, MODEL.TEAM_BATTLE_ITEM);
    battles.push({
      objectId: object.id,
      battleId: item.battle_id,
      name: item.name,
      mode: enumValue(item.battle_mode),
      mapName: map?.map_name ?? '',
      maxPeople: item.max_people_count,
      all: dm?.user_ids.length ?? 0,
      reds: team?.red_user_ids.length ?? 0,
      blues: team?.blue_user_ids.length ?? 0,
      rankMin: item.rank_range?.min ?? 0,
      rankMax: item.rank_range?.max ?? 0,
      proBattle: item.pro_battle,
      privateBattle: item.private_battle,
      suspicious: item.suspicious,
      noSupplies: item.without_supplies,
    });
  }
  return battles;
}

function users(list: { user_id: number; kills?: number; score?: number; suspicious?: boolean }[] | undefined): BattleUser[] {
  return (list ?? []).map((info) => ({ userId: info.user_id, kills: info.kills ?? info.score ?? 0, suspicious: info.suspicious ?? false }));
}

export function readBattleInfo(client: GameClient): LobbyBattleInfo | null {
  const space = client.getSpace('battle_select');
  const object = client.findObjectWithModel(space, MODEL.BATTLE_INFO);
  const info = model<{
    battle_id: number;
    name: string;
    battle_mode: unknown;
    map_game_object_id: number;
    max_people_count: number;
    limits: { score_limit: number; time_limit_in_sec: number };
    time_left_in_seconds: number;
    rank_range: { min: number; max: number };
    pro_battle: boolean;
    without_bonuses: boolean;
    without_crystals: boolean;
    without_supplies: boolean;
    without_upgrades: boolean;
  }>(object, MODEL.BATTLE_INFO);
  if (!object || !info) return null;
  const map = model<{ map_name: string; preview_image: number }>(space?.objects.get(info.map_game_object_id), MODEL.MAP_INFO);
  const dm = model<{ user_infos: { user_id: number; kills: number; suspicious: boolean }[] }>(object, MODEL.BATTLE_DM_INFO);
  const team = model<{
    auto_balance: boolean;
    friendly_fire: boolean;
    red_user_infos: { user_id: number; score: number; suspicious: boolean }[];
    blue_user_infos: { user_id: number; score: number; suspicious: boolean }[];
  }>(object, MODEL.TEAM_BATTLE_INFO);
  return {
    objectId: object.id,
    battleId: info.battle_id,
    name: info.name,
    mode: enumValue(info.battle_mode),
    mapName: map?.map_name ?? '',
    previewId: map?.preview_image ?? 0,
    maxPeople: info.max_people_count,
    scoreLimit: info.limits.score_limit,
    timeLimit: info.limits.time_limit_in_sec,
    timeLeft: info.time_left_in_seconds,
    rankMin: info.rank_range.min,
    rankMax: info.rank_range.max,
    proBattle: info.pro_battle,
    withoutBonuses: info.without_bonuses,
    withoutCrystals: info.without_crystals,
    withoutSupplies: info.without_supplies,
    withoutUpgrades: info.without_upgrades,
    autoBalance: team?.auto_balance ?? false,
    friendlyFire: team?.friendly_fire ?? false,
    users: users(dm?.user_infos),
    reds: users(team?.red_user_infos),
    blues: users(team?.blue_user_infos),
  };
}

/** MapInfoModel карт из battle_select (объекты map_<имя>) */
export interface LobbyMap {
  mapId: number;
  name: string;
  maxPeople: number;
  previewId: number;
  rankMin: number;
  rankMax: number;
  modes: number[];
  theme: number;
}

export function readMaps(client: GameClient): LobbyMap[] {
  const maps: LobbyMap[] = [];
  for (const object of client.getSpace('battle_select')?.objects.values() ?? []) {
    const map = model<{
      enabled: boolean;
      map_id: number;
      map_name: string;
      max_people: number;
      preview_image: number;
      rank_limit: { min: number; max: number };
      supported_modes: unknown[];
      theme: unknown;
    }>(object, MODEL.MAP_INFO);
    if (!map || map.enabled === false) continue;
    maps.push({
      mapId: map.map_id,
      name: map.map_name,
      maxPeople: map.max_people,
      previewId: map.preview_image,
      rankMin: map.rank_limit?.min ?? 1,
      rankMax: map.rank_limit?.max ?? 30,
      modes: (map.supported_modes ?? []).map(enumValue),
      theme: enumValue(map.theme),
    });
  }
  return maps.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** BattleCreateModel: лимиты по режимам (DM, TDM, CTF, CP) и ширина диапазона званий для звания игрока */
export interface BattleCreateLimits {
  disabled: boolean;
  limits: { scoreLimit: number; timeLimit: number }[];
  maxRangeLength: number;
}

export function readBattleCreate(client: GameClient): BattleCreateLimits | null {
  const object = client.findObjectWithModel(client.getSpace('battle_select'), MODEL.BATTLE_CREATE);
  const data = model<{
    battle_creation_disabled: boolean;
    battle_limits: { score_limit: number; time_limit_in_sec: number }[];
    max_range_length: number;
  }>(object, MODEL.BATTLE_CREATE);
  if (!data) return null;
  return {
    disabled: data.battle_creation_disabled,
    limits: data.battle_limits.map((limit) => ({ scoreLimit: limit.score_limit, timeLimit: limit.time_limit_in_sec })),
    maxRangeLength: data.max_range_length,
  };
}

export interface NewBattle extends BattleRules {
  botCount?: number;
  name: string;
  mode: number;
  mapId: number;
  theme: number;
  maxPeople: number;
  scoreLimit: number;
  timeLimit: number;
  rankMin: number;
  rankMax: number;
  withoutBonuses: boolean;
  withoutCrystals: boolean;
  withoutSupplies: boolean;
  autoBalance: boolean;
  friendlyFire: boolean;
}

/** CREATE_BATTLE: поля в порядке BattleCreateCodec.decode сервера */
export function createBattle(client: GameClient, battle: NewBattle): void {
  const object = client.findObjectWithModel(client.getSpace('battle_select'), MODEL.BATTLE_CREATE);
  if (!object) return;
  client.sendCommand('battle_select', object.id, LOBBY_COMMAND.CREATE_BATTLE, (writer) => {
    writer.bool(battle.autoBalance);
    writer.i32(battle.mode);
    writer.bool(battle.friendlyFire);
    writer.i32(battle.scoreLimit);
    writer.i32(battle.timeLimit);
    writer.i64(battle.mapId);
    writer.i8(battle.maxPeople);
    writer.str(battle.name);
    writer.bool(false); // private_battle
    writer.bool(false); // pro_battle
    writer.i32(battle.rankMax);
    writer.i32(battle.rankMin);
    writer.i32(battle.theme);
    writer.bool(battle.withoutBonuses);
    writer.bool(battle.withoutCrystals);
    writer.bool(battle.withoutSupplies);
    writer.bool(false); // without_upgrades
  });
}

export function readGarageItem(object: RemoteObject): GarageItem | null {
  const description = model<{ name: string | null; description: string | null }>(object, MODEL.DESCRIPTION);
  const item = model<{ max_rank: number; min_rank: number; position: number; preview_image: number }>(object, MODEL.ITEM);
  if (!description || !item) return null;
  const buyable = model<{ buyable: boolean; price: number }>(object, MODEL.BUYABLE);
  const discount = model<{ discount: number; image: number | null }>(object, MODEL.DISCOUNT);
  const modification = model<{ base_item_id: number; modification_index: number }>(object, MODEL.MODIFICATION);
  const upgradeable = model<{
    new_upgradable_propertys: {
      property_id: number;
      level: number;
      max_level: number;
      properties: { final_value: number; initial_value: number; item_property: { item_property_id: number } }[] | null;
    }[];
  }>(object, MODEL.UPGRADEABLE);
  return {
    objectId: object.id,
    name: description.name ?? '',
    description: description.description ?? '',
    category: enumValue(model<{ item_category_enum: unknown }>(object, MODEL.CATEGORY)?.item_category_enum),
    position: item.position,
    minRank: item.min_rank,
    maxRank: item.max_rank,
    previewId: item.preview_image,
    price: buyable?.price ?? 0,
    buyable: buyable?.buyable ?? false,
    count: model<{ count: number }>(object, MODEL.COUNTABLE)?.count ?? 0,
    discount: discount?.discount ?? 0,
    saleImageId: discount?.image ?? null,
    baseItemId: modification?.base_item_id ?? null,
    modification: modification?.modification_index ?? 0,
    object3dsId: model<{ resource_id: number }>(object, MODEL.OBJECT_3DS)?.resource_id ?? null,
    coloringId: model<{ coloring_image_id: number }>(object, MODEL.COLORING)?.coloring_image_id ?? null,
    properties: (upgradeable?.new_upgradable_propertys ?? []).map((property) => ({
      propertyId: property.property_id,
      level: property.level,
      maxLevel: property.max_level,
      values: property.properties?.map((value) => ({ itemPropertyId: value.item_property.item_property_id, initial: value.initial_value, final: value.final_value })) ?? null,
    })),
  };
}

/** данные гаража для окна (GarageView): старый протокол — GarageState, server2 — S2Garage */
export interface GarageData {
  readonly appearances?:AppearanceMap;
  setAppearance?(item:GarageItem,style:AppearanceStyle):void;
  readonly depot: number[];
  readonly market: number[];
  readonly mounted: number[];
  item(objectId: number): GarageItem | null;
  items(ids: number[]): GarageItem[];
  modifications(item: GarageItem): GarageItem[];
  mount(objectId: number): void;
  buy(item: GarageItem, count?: number): void;
  buyNextModification(next: GarageItem): void;
}

/** Состояние гаража: предметы пространства garage и списки INIT_DEPOT / INIT_MARKET / INIT_MOUNTED */
export class GarageState implements GarageData {
  depot: number[] = [];
  market: number[] = [];
  mounted: number[] = [];
  garageBoxResource = 0;
  onChange: (() => void) | null = null;

  constructor(private readonly client: GameClient) {
    client.on('command', (event) => {
      if (event.spaceName != 'garage') return;
      const items = (event.args as { items?: number[] } | null)?.items;
      if (event.name == 'INIT_DEPOT' && items) this.depot = items;
      else if (event.name == 'INIT_MARKET' && items) this.market = items;
      else if (event.name == 'INIT_MOUNTED' && items) this.mounted = items;
      else return;
      this.normalize();
      this.onChange?.();
    });
    client.on('space', (space) => {
      if (space.name != 'garage') return;
      this.depot = this.market = this.mounted = [];
      this.loaded.clear();
    });
    client.on('objects', (event) => {
      if (event.spaceName != 'garage') return;
      const garage = client.findObjectWithModel(client.getSpace('garage'), MODEL.GARAGE);
      this.garageBoxResource = model<{ garage_box_resource: number }>(garage, MODEL.GARAGE)?.garage_box_resource ?? 0;
      for (const object of event.added) {
        // ItemModel.mount_item на сервере досылает предмету Item3DModel повторной загрузкой объекта:
        // это знак «предмет куплен/надет» (так Flash узнаёт о новом надетом предмете)
        if (this.loaded.has(object.id)) this.onMounted(object.id);
        else this.loaded.add(object.id);
      }
      this.onChange?.();
    });
  }

  private readonly loaded = new Set<number>();

  /**
   * Сервер присылает в складе все купленные модификации предмета, а в магазине — и модификации уже купленного:
   * на складе оставляем старшую модификацию каждого предмета, из магазина убираем предметы со склада
   * (следующая модификация покупается кнопкой «Купить Mn» в окне предмета).
   */
  private normalize(): void {
    const best = new Map<number, GarageItem>();
    for (const id of this.depot) {
      const item = this.item(id);
      if (item?.baseItemId == null) continue;
      const current = best.get(item.baseItemId);
      if (!current || item.modification > current.modification) best.set(item.baseItemId, item);
    }
    this.depot = this.depot.filter((id) => {
      const item = this.item(id);
      return item?.baseItemId == null || best.get(item.baseItemId)?.objectId == id;
    });
    this.market = this.market.filter((id) => {
      const item = this.item(id);
      return item?.baseItemId == null || !best.has(item.baseItemId);
    });
  }

  private onMounted(objectId: number): void {
    const item = this.item(objectId);
    if (!item) return;
    if (!this.depot.includes(objectId)) {
      this.depot = [...this.depot, objectId];
      // купленная модификация заменяет прежнюю в складе, предмет уходит из магазина
      const siblings = new Set(this.modifications(item).map((other) => other.objectId));
      siblings.delete(objectId);
      this.depot = this.depot.filter((id) => !siblings.has(id));
      this.market = this.market.filter((id) => id != objectId && !siblings.has(id));
    }
    if (item.category == ITEM_CATEGORY.INVENTORY) return;
    this.mounted = [...this.mounted.filter((id) => this.item(id)?.category != item.category), objectId];
  }

  item(objectId: number): GarageItem | null {
    const object = this.client.getSpace('garage')?.objects.get(objectId);
    return object ? readGarageItem(object) : null;
  }

  items(ids: number[]): GarageItem[] {
    return ids.map((id) => this.item(id)).filter((item): item is GarageItem => item != null);
  }

  /** все модификации того же предмета (по base_item_id), по возрастанию номера */
  modifications(item: GarageItem): GarageItem[] {
    if (item.baseItemId == null) return [item];
    const all: GarageItem[] = [];
    for (const object of this.client.getSpace('garage')?.objects.values() ?? []) {
      const other = readGarageItem(object);
      if (other && other.baseItemId == item.baseItemId) all.push(other);
    }
    return all.sort((a, b) => a.modification - b.modification);
  }

  mount(objectId: number): void {
    const garage = this.client.findObjectWithModel(this.client.getSpace('garage'), MODEL.GARAGE);
    if (garage) this.client.sendCommand('garage', garage.id, LOBBY_COMMAND.ITEM_MOUNTED, (writer) => writer.i64(objectId));
  }

  buy(item: GarageItem, count = 1): void {
    const garage = this.client.findObjectWithModel(this.client.getSpace('garage'), MODEL.GARAGE);
    if (!garage) return;
    this.client.sendCommand('garage', garage.id, LOBBY_COMMAND.ITEM_BOUGHT, (writer) => {
      writer.i64(item.objectId);
      writer.i32(count);
      writer.i32(item.price * count);
    });
    // число припасов сервер не присылает (Flash считает сам): прибавляем к данным предмета, карточка и плитка обновятся
    const countable = this.client.getSpace('garage')?.objects.get(item.objectId)?.models.get(MODEL.COUNTABLE) as { count?: number } | undefined;
    if (countable) {
      countable.count = (countable.count ?? 0) + count;
      this.onChange?.();
    }
  }

  /** GarageModel.buyNextModification: объект — купленная (предыдущая) модификация, цена — следующей */
  buyNextModification(next: GarageItem): void {
    const garage = this.client.findObjectWithModel(this.client.getSpace('garage'), MODEL.GARAGE);
    const previous = this.modifications(next).find((mod) => mod.modification == next.modification - 1);
    if (!garage || !previous) return;
    this.client.sendCommand('garage', garage.id, LOBBY_COMMAND.NEXT_MODIFICATION_BOUGHT, (writer) => {
      writer.i64(previous.objectId);
      writer.i32(next.price);
    });
  }
}

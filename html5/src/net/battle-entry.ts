/**
 * Вход в бой по протоколу: лобби -> SHOW_BATTLE_SELECT -> ON_BATTLE_SELECT(выбранный бой) -> FIGHT -> пространство боя.
 * Сервер возвращает игрока в бой, который тот покинул закрытием клиента (placeholder в battle_select_global_model),
 * поэтому после входа пространство боя может появиться само — тогда выбор боя не нужен.
 */

import { MODEL_ID, type GameClient } from './client.ts';

export const BATTLE_COMMAND = {
  SHOW_BATTLE_SELECT: 300070008,
  ON_BATTLE_SELECT: 300090024,
  FIGHT: 300090007,
  /** TeamBattleInfoModel.fight(team): TeamCodec — 0 красные, 1 синие */
  FIGHT_TEAM: 300090028,
} as const;

export const BATTLE_ITEM_MODEL = 300090008;
export const BATTLE_SELECT_MODEL = 300090011;
export const BATTLE_DM_INFO_MODEL = 300090003;
export const TEAM_BATTLE_INFO_MODEL = 300090027;
/** команда для входа в командный бой (TeamCodec сервера) */
export const FIGHT_TEAM = { RED: 0, BLUE: 1 } as const;
/** TeamCodec в бою: 0 красные, 1 синие, 2 — без команды (DM) */
export const BATTLE_TEAM = { RED: 0, BLUE: 1, NONE: 2 } as const;
/** огонь по своим боя, в который вошли последним (TeamBattleInfoModel; при возврате в покинутый бой неизвестен — выкл) */
export let enteredBattleFriendlyFire = false;
/** BattleInfoModel: battle_id объекта информации о бое */
export const BATTLE_INFO_MODEL = 300090007;
const ENTER_TIMEOUT_MS = 15000;

const REJOIN_WAIT_MS = 1500;

export interface BattleListItem {
  objectId: number;
  battleId: number;
  name: string;
  mapGameObjectId: number;
  battleMode: number;
  maxPeople: number;
  withoutSupplies: boolean;
  privateBattle: boolean;
  proBattle: boolean;
  rankMin: number;
  rankMax: number;
}

export const BATTLE_MODE_NAMES = ['DM', 'TDM', 'CTF', 'CP'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findBattleSpace(client: GameClient): string | null {
  return client.getSpaceNames().find((name) => name.startsWith('battle_field')) ?? null;
}

export function listBattles(client: GameClient): BattleListItem[] {
  const space = client.getSpace('battle_select');
  const out: BattleListItem[] = [];
  for (const object of space?.objects.values() ?? []) {
    if (!object.modelIds.includes(BATTLE_ITEM_MODEL)) continue;
    const data = object.models.get(BATTLE_ITEM_MODEL) as {
      battle_id: number;
      name: string;
      map_game_object_id: number;
      battle_mode: unknown;
      max_people_count: number;
      without_supplies: boolean;
      private_battle: boolean;
      pro_battle: boolean;
      rank_range?: { min: number; max: number };
    };
    // battle_mode приходит структурой из одного числа (enum-кодек)
    const mode = typeof data.battle_mode == 'number' ? data.battle_mode : Number(Object.values(data.battle_mode as object)[0] ?? 0);
    out.push({
      objectId: object.id,
      battleId: data.battle_id,
      name: data.name,
      mapGameObjectId: data.map_game_object_id,
      battleMode: mode,
      maxPeople: data.max_people_count,
      withoutSupplies: data.without_supplies,
      privateBattle: data.private_battle,
      proBattle: data.pro_battle,
      rankMin: data.rank_range?.min ?? 0,
      rankMax: data.rank_range?.max ?? 0,
    });
  }
  return out;
}

/** Открывает окно выбора боя (если ещё не открыто) и возвращает список боёв; пустой, если боёв нет */
export async function loadBattleList(client: GameClient): Promise<BattleListItem[]> {
  const layout = await client.waitForModelObject('lobby', MODEL_ID.LOBBY_LAYOUT);
  if (listBattles(client).length == 0) {
    // список уже открыт (сервер открывает его сам после входа и выхода из боя) — повторная команда только мешает
    if (!client.getSpace('battle_select')) client.sendCommand('lobby', layout.id, BATTLE_COMMAND.SHOW_BATTLE_SELECT);
    try {
      await client.waitForModelObject('battle_select', BATTLE_ITEM_MODEL, 4000);
    } catch {
      return [];
    }
    await sleep(500);
  }
  return listBattles(client);
}

/**
 * Заходит в бой battleId (null — первый бой DM «Арена»). Возвращает имя пространства боя.
 * Если игрок уже в бою (возврат в покинутый бой), остаётся в нём.
 */
export async function enterBattle(
  client: GameClient,
  battleId: number | null,
  log: (message: string) => void = () => undefined,
  team: number | null = null,
): Promise<string> {
  const layout = await client.waitForModelObject('lobby', MODEL_ID.LOBBY_LAYOUT);
  await sleep(REJOIN_WAIT_MS);
  const rejoined = findBattleSpace(client);
  if (rejoined) {
    enteredBattleFriendlyFire = false;
    log(`возврат в покинутый бой: ${rejoined}`);
    return rejoined;
  }

  if (listBattles(client).length == 0) {
    if (!client.getSpace('battle_select')) client.sendCommand('lobby', layout.id, BATTLE_COMMAND.SHOW_BATTLE_SELECT);
    await client.waitForModelObject('battle_select', BATTLE_ITEM_MODEL);
    await sleep(500);
  }
  const select = await client.waitForModelObject('battle_select', BATTLE_SELECT_MODEL);
  const battles = listBattles(client);
  const target = battles.find((item) => (battleId === null ? item.name.includes('Арена') && item.battleMode === 0 : item.battleId === battleId));
  if (!target) throw new Error(`бой ${battleId ?? 'Арена DM'} не найден среди ${battles.map((item) => item.battleId).join(', ')}`);
  log(`выбран бой ${target.battleId} «${target.name}»`);

  // FIGHT — объекту информации именно этого боя: после выбора другого боя в окне старый объект ещё может быть в пространстве,
  // и FIGHT ему сервер молча игнорирует (вход зависал навсегда)
  const findInfo = () =>
    [...(client.getSpace('battle_select')?.objects.values() ?? [])].find(
      (object) =>
        (object.models.has(BATTLE_DM_INFO_MODEL) || object.models.has(TEAM_BATTLE_INFO_MODEL)) &&
        Number((object.models.get(BATTLE_INFO_MODEL) as { battle_id?: number } | undefined)?.battle_id) === target.battleId,
    );
  let info = findInfo();
  if (!info) {
    client.sendCommand('battle_select', select.id, BATTLE_COMMAND.ON_BATTLE_SELECT, (writer) => writer.i64(target.objectId));
    const started = Date.now();
    while (!(info = findInfo())) {
      if (Date.now() - started > ENTER_TIMEOUT_MS) throw new Error(`нет информации о бое ${target.battleId}`);
      await sleep(100);
    }
  }

  let handler: ((space: { name: string }) => void) | null = null;
  const opened = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (handler) client.off('space', handler);
      reject(new Error(`сервер не открыл бой ${target.battleId}`));
    }, ENTER_TIMEOUT_MS);
    handler = (space: { name: string }): void => {
      if (!space.name.startsWith('battle_field')) return;
      clearTimeout(timer);
      if (handler) client.off('space', handler);
      resolve(space.name);
    };
    client.on('space', handler);
  });
  const teamInfo = info.models.get(TEAM_BATTLE_INFO_MODEL) as { friendly_fire?: boolean } | undefined;
  enteredBattleFriendlyFire = teamInfo?.friendly_fire ?? false;
  if (info.models.has(TEAM_BATTLE_INFO_MODEL)) {
    // командный бой: без выбора — в команду, где меньше игроков (кнопка «Играть» панели сервера)
    let side = team;
    if (side == null) {
      const data = info.models.get(TEAM_BATTLE_INFO_MODEL) as { red_user_infos?: unknown[]; blue_user_infos?: unknown[] } | undefined;
      side = (data?.blue_user_infos?.length ?? 0) < (data?.red_user_infos?.length ?? 0) ? FIGHT_TEAM.BLUE : FIGHT_TEAM.RED;
    }
    log(`команда: ${side == FIGHT_TEAM.RED ? 'красные' : 'синие'}`);
    client.sendCommand('battle_select', info.id, BATTLE_COMMAND.FIGHT_TEAM, (writer) => writer.i32(side));
  } else {
    client.sendCommand('battle_select', info.id, BATTLE_COMMAND.FIGHT);
  }
  return opened;
}

/**
 * Выход из боя в окно выбора боя (как кнопка «Битвы» в бою): сервер убирает игрока из боя, закрывает пространство боя
 * и заново открывает battle_select. Возвращает свежий список боёв.
 */
/**
 * Выход из боя сразу в нужный раздел: одна команда SHOW_BATTLE_SELECT или SHOW_GARAGE (сервер сам выводит из боя).
 * Раньше «Гараж» из боя слал две команды подряд, а сервер выполняет команды основного канала параллельно — они
 * мешали друг другу. Ждём только появления пространства раздела: список боёв может быть пустым (бой закончился),
 * ожидание объекта боя тогда не заканчивалось, и гараж не открывался до F5.
 */
export async function leaveBattle(client: GameClient, target: 'battles' | 'garage' = 'battles'): Promise<BattleListItem[]> {
  const layout = await client.waitForModelObject('lobby', MODEL_ID.LOBBY_LAYOUT);
  client.sendCommand('lobby', layout.id, target == 'garage' ? SHOW_GARAGE_COMMAND : BATTLE_COMMAND.SHOW_BATTLE_SELECT);
  const spaceName = target == 'garage' ? 'garage' : 'battle_select';
  const started = Date.now();
  while (!client.getSpace(spaceName) && Date.now() - started < 10000) await sleep(50);
  if (target == 'battles') await sleep(300);
  return listBattles(client);
}

/** LobbyLayoutModel.SHOW_GARAGE (net/lobby.ts LOBBY_COMMAND) */
const SHOW_GARAGE_COMMAND = 300070009;

/** Номер боя из имени пространства battle_field_N */
export function battleIdFromSpace(spaceName: string): number {
  return Number(spaceName.replace('battle_field_', ''));
}

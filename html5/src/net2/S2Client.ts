/**
 * Сессия html5 на server2 (`?s2`): соединение, вход, профиль, список боёв и карт. Данные отдаются окнам лобби в тех же
 * типах, что у старого протокола (`net/lobby.ts`), — окна не знают, с каким сервером работают.
 */
import type { UserInfo as LegacyUserInfo } from '../net/client.ts';
import { BATTLE_MODE, type BattleCreateLimits, type BattleUser, type LobbyBattle, type LobbyBattleInfo, type LobbyMap, type NewBattle } from '../net/lobby.ts';
import { getSavedBridge, isLocalPage } from '../net/transport-ws.ts';
import { Connection, ServerError } from './Connection.ts';
import { rankRangeLength, TEAM, WS_PATH, type BattleLimit, type BattleMode, type BattleSummary, type KickReason, type MapSummary, type UserInfo } from './protocol.ts';

const MODE_NUMBER: Record<BattleMode, number> = { dm: BATTLE_MODE.DM, tdm: BATTLE_MODE.TDM, ctf:BATTLE_MODE.CTF };

/** профиль server2 в типе старого протокола (верхняя панель, окна лобби) */
export function legacyUser(user: UserInfo): LegacyUserInfo {
  return { uid: user.name, userId: user.id, crystals: user.crystals, rank: user.rank, score: user.score, nextRankScore: user.nextRankScore };
}

/** текст ошибки для игрока */
export function errorText(error: unknown): string {
  if (!(error instanceof ServerError)) return error instanceof Error ? error.message : String(error);
  const detail = error.message.includes(': ') ? error.message.slice(error.message.indexOf(': ') + 2) : '';
  switch (error.code) {
    case 'wrong_password':
      return 'Неверный логин или пароль';
    case 'name_taken':
      return 'Это имя уже занято';
    case 'invalid_name':
      return 'Логин: до 20 латинских букв, цифр или «_»';
    case 'invalid_password':
      return detail ? `Пароль: ${detail.replace(/^пароль: /, '')}` : 'Недопустимый пароль';
    case 'rate_limited':
      return 'Слишком много попыток, подождите минуту';
    case 'version':
      return 'Клиент устарел — обновите страницу';
    case 'timeout':
    case 'closed':
      return 'Сервер не отвечает';
    case 'forbidden':
      return detail || 'Недостаточно прав';
    case 'bad_request':
      return detail ? `Ошибка: ${detail}` : 'Неверный запрос';
    default:
      return 'Ошибка сервера';
  }
}

/**
 * Адрес server2: ?s2=адрес; на этом компьютере и на странице с игрового сервера — тот же хост (прокси /ws2 у vite и
 * public-server.mjs); на удалённом хостинге — хост сохранённого адреса моста (туннель того же веб-сервера).
 */
export function s2UrlFromLocation(): string {
  const override = new URLSearchParams(window.location.search).get('s2');
  if (override && /^wss?:\/\//.test(override)) return override;
  const saved = isLocalPage() ? '' : getSavedBridge();
  if (saved) {
    const url = new URL(saved);
    url.pathname = WS_PATH;
    url.search = '';
    return url.toString();
  }
  return `${window.location.protocol == 'https:' ? 'wss' : 'ws'}://${window.location.host}${WS_PATH}`;
}

export class S2Client {
  readonly connection: Connection;
  user: UserInfo | null = null;
  maps: MapSummary[] = [];
  linkedBattleId:number|null=null;
  limits: Record<BattleMode, BattleLimit> | null = null;
  private readonly battles = new Map<number, BattleSummary>();

  hasBattle(id: number): boolean { return this.battles.has(id); }
  /** профиль изменился (вход, кристаллы, звание) */
  onUser: ((user: UserInfo) => void) | null = null;
  /** список боёв изменился */
  onBattles: (() => void) | null = null;
  /** соединение закрыто; reason — если сервер выбил (вход с другого места, бан, остановка) */
  onClose: ((reason: KickReason | null) => void) | null = null;
  private kickReason: KickReason | null = null;

  private constructor(connection: Connection) {
    this.connection = connection;
    connection.on('user', ({ user }) => {
      this.user = user;
      this.onUser?.(user);
    });
    connection.on('lobby.battle', ({ battle }) => {
      this.battles.set(battle.id, battle);
      this.onBattles?.();
    });
    connection.on('lobby.battleRemoved', ({ battleId }) => {
      this.battles.delete(battleId);
      this.onBattles?.();
    });
    connection.on('kicked', ({ reason }) => (this.kickReason = reason));
    connection.onClose = () => this.onClose?.(this.kickReason);
  }

  static async connect(url = s2UrlFromLocation()): Promise<S2Client> {
    return new S2Client(await Connection.connect(url));
  }

  get isAdmin(): boolean {
    return this.user?.admin ?? false;
  }

  async authenticate(mode: 'login' | 'register', username: string, password: string): Promise<UserInfo> {
    const { user } = await this.connection.request(mode == 'login' ? 'auth.login' : 'auth.register', { username, password });
    this.user = user;
    this.onUser?.(user);
    return user;
  }

  /** список боёв и карт; дальше изменения приходят событиями */
  async loadLobby(): Promise<void> {
    const reply = await this.connection.request('lobby.battles', {});
    this.maps = reply.maps;
    this.limits = reply.limits;
    this.battles.clear();
    for (const battle of reply.battles) this.battles.set(battle.id, battle);
    const match=/^#\/?battle[=/]([0-9a-f]{1,16})$/i.exec(window.location.hash);
    if(match){const battleId=parseInt(match[1],16);try{const {battle}=await this.connection.request('lobby.getBattle',{battleId});this.battles.set(battle.id,battle);this.linkedBattleId=battle.id;}catch(error){console.warn('Битва по ссылке недоступна',error);}}
    this.onBattles?.();
  }

  async createBattle(battle: NewBattle): Promise<void> {
    const mode = (Object.keys(MODE_NUMBER) as BattleMode[]).find((key) => MODE_NUMBER[key] == battle.mode) ?? 'dm';
    const reply = await this.connection.request('lobby.create', {
      ...battle,
      botCount:battle.botCount??0,
      name: battle.name,
      mode,
      mapId: battle.mapId,
      maxPeople: battle.maxPeople,
      timeLimitSec: battle.timeLimit,
      scoreLimit: battle.scoreLimit,
      minRank: battle.rankMin,
      maxRank: battle.rankMax,
    });
    this.battles.set(reply.battle.id, reply.battle);
    this.onBattles?.();
  }

  async removeBattle(battleId: number): Promise<void> {
    await this.connection.request('lobby.remove', { battleId });
    this.battles.delete(battleId);
    this.onBattles?.();
  }

  close(): void {
    this.connection.close();
  }

  // --- данные для окон лобби (типы старого протокола) ---

  lobbyBattles(): LobbyBattle[] {
    return [...this.battles.values()].map((battle) => ({
      objectId: battle.id,
      battleId: battle.id,
      name: battle.name,
      mode: MODE_NUMBER[battle.mode],
      mapName: battle.mapName,
      maxPeople: battle.maxPeople,
      all: battle.players[0] + battle.players[1],
      reds: battle.players[0],
      blues: battle.players[1],
      rankMin: battle.minRank,
      rankMax: battle.maxRank,
      proBattle: false,
      privateBattle: battle.privateBattle??false,
      suspicious: false,
      noSupplies: battle.withoutSupplies??false,
    }));
  }

  /** ник игрока боя по id (UidNotifier старого протокола): из списков игроков боёв */
  userName(userId: number): string {
    for (const battle of this.battles.values()) for (const user of battle.users ?? []) if (user.userId == userId) return user.name;
    return `#${userId}`;
  }

  userRank(userId: number): number {
    for (const battle of this.battles.values()) for (const user of battle.users ?? []) if (user.userId == userId) return user.rank;
    return 1;
  }

  battleInfo(battleId: number | null): LobbyBattleInfo | null {
    const battle = battleId == null ? undefined : this.battles.get(battleId);
    if (!battle) return null;
    const map = this.maps.find((candidate) => candidate.id == battle.mapId);
    const toUser = (user: NonNullable<BattleSummary['users']>[number]): BattleUser => ({ userId: user.userId, kills: user.kills, score:user.score, suspicious: false });
    const list = battle.users ?? [];
    const dm = battle.mode === 'dm';
    return {
      objectId: battle.id,
      battleId: battle.id,
      name: battle.name,
      mode: MODE_NUMBER[battle.mode],
      mapName: battle.mapName,
      previewId: map?.previewId ?? 0,
      maxPeople: dm?battle.maxPeople:Math.max(1,Math.floor(battle.maxPeople/2)),
      teamScores:battle.teamScores??[0,0],
      scoreLimit: battle.scoreLimit,
      timeLimit: battle.timeLimitSec,
      timeLeft: battle.timeLimitSec,
      rankMin: battle.minRank,
      rankMax: battle.maxRank,
      proBattle: false,
      withoutBonuses: battle.withoutBonuses??false,
      withoutCrystals: battle.withoutCrystals??false,
      withoutSupplies: battle.withoutSupplies??false,
      withoutUpgrades: battle.withoutUpgrades??false,
      autoBalance: battle.autoBalance??true,
      friendlyFire: battle.friendlyFire??false,
      users: dm ? list.map(toUser) : [],
      reds: dm ? [] : list.filter((user) => user.team === TEAM.RED).map(toUser),
      blues: dm ? [] : list.filter((user) => user.team === TEAM.BLUE).map(toUser),
    };
  }

  lobbyMaps(): LobbyMap[] {
    return this.maps.map((map) => ({
      mapId: map.id,
      name: map.name,
      maxPeople: map.maxPeople,
      previewId: map.previewId,
      rankMin: map.minRank,
      rankMax: map.maxRank,
      modes: map.modes.map((mode) => MODE_NUMBER[mode]),
      theme: ({summer:0,winter:1,space:2,summer_night:3,winter_night:4,summer_old:5} as Record<string,number>)[map.theme]??0,
    }));
  }

  createLimits(): BattleCreateLimits {
    const limits = this.limits;
    const limit = (mode: BattleMode): { scoreLimit: number; timeLimit: number } => ({
      scoreLimit: limits?.[mode]?.scoreLimit ?? 0,
      timeLimit: limits?.[mode]?.timeLimitSec ?? 900,
    });
    return { disabled: !this.isAdmin, limits: [limit('dm'), limit('tdm'), limit('ctf')], maxRangeLength: rankRangeLength(this.user?.rank ?? 1) };
  }
}

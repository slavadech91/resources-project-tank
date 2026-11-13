import {LobbyChatService} from './chat/lobbyChat.ts';
/** Состояние сервера: соединения, кто в сети, подписчики лобби, общие сервисы (база, bcrypt, баны, карты, бои). */
import type { EventName, Events, MapSummary, UserInfo } from '../../html5/src/net2/protocol.ts';
import type { BanList } from './auth/bans.ts';
import type { Hasher } from './auth/hasher.ts';
import { BattleRooms } from './battle/rooms.ts';
import type { MapData } from './battle/mapData.ts';
import type { ServerConfig } from './config.ts';
import type { Database } from './db/mysql.ts';
import type { GarageService } from './garage/garage.ts';
import { AttemptLimiter, RequestError } from './errors.ts';
import { RANK_REWARDS, rankForScore } from './game/ranks.ts';
import { loadUserInfo } from './game/users.ts';
import type { BattleRegistry } from './lobby/battles.ts';
import { missionDay, recordMission } from './lobby/missions.ts';
import { log } from './log.ts';
import { Session } from './net/session.ts';
import type { WebSocketConnection } from './net/websocket.ts';

/** попыток входа и регистрации с одного адреса в минуту */
const AUTH_ATTEMPTS_PER_MINUTE = 10;

/** поля профиля, которые меняют начисления боя */
interface AwardRow {
  score: number;
  crystals: number;
}

export interface AppServices {
  config: ServerConfig;
  db: Database;
  hasher: Hasher;
  bans: BanList;
  maps: MapSummary[];
  battles: BattleRegistry;
  garage: GarageService;
  /** точки спавна и зоны смерти карт по id */
  mapData: Map<number, MapData>;
}

export class App {
  readonly lobbyChat=new LobbyChatService();
  readonly config: ServerConfig;
  readonly db: Database;
  readonly hasher: Hasher;
  readonly bans: BanList;
  readonly maps: MapSummary[];
  readonly battles: BattleRegistry;
  readonly garage: GarageService;
  /** идущие бои */
  readonly rooms: BattleRooms;
  /** имена (нижний регистр), которые сейчас регистрируются */
  readonly registering = new Set<string>();
  private readonly sessions = new Set<Session>();
  private readonly online = new Map<number, Session>();
  private readonly lobbyWatchers = new Set<Session>();
  private readonly authLimiter = new AttemptLimiter(AUTH_ATTEMPTS_PER_MINUTE, 60000);
  private readonly pruneTimer: ReturnType<typeof setInterval>;
  /** очередь начислений по игроку: убийства и фонд не должны обгонять друг друга в базе */
  private readonly awardQueues = new Map<number, Promise<void>>();

  constructor(services: AppServices) {
    this.config = services.config;
    this.db = services.db;
    this.hasher = services.hasher;
    this.bans = services.bans;
    this.maps = services.maps;
    this.battles = services.battles;
    this.garage = services.garage;
    this.rooms = new BattleRooms(this, services.mapData);
    this.pruneTimer = setInterval(() => this.authLimiter.prune(), 60000);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  stats(): Record<string, unknown> {
    const rooms = this.rooms.stats;
    return { sessions: this.sessions.size, online: this.online.size, battles: this.battles.list().length, activeBattles: rooms.battles, inBattle: rooms.players, uptimeSec: Math.round(process.uptime()) };
  }

  addSession(ws: WebSocketConnection): Session {
    const session = new Session(this, ws);
    this.sessions.add(session);
    return session;
  }

  removeSession(session: Session): void {
    this.lobbyChat.remove(session);
    this.sessions.delete(session);
    this.lobbyWatchers.delete(session);
    this.rooms.leave(session);
    if (session.user && this.online.get(session.user.id) === session) {
      this.online.delete(session.user.id);
      log('auth', `${session.user.name}: вышел`);
    }
  }

  limitAuth(session: Session): void {
    if (!this.authLimiter.take(session.address)) throw new RequestError('rate_limited', 'слишком много попыток, подождите минуту');
  }

  /** вход состоялся: профиль из базы; прежнее соединение того же игрока закрывается */
  async signIn(session: Session, userId: number): Promise<UserInfo> {
    const user = await loadUserInfo(this.db, userId);
    if (!user) throw new RequestError('server_error', 'профиль не найден');
    if (!session.isOpen) return user;
    const previous = this.online.get(userId);
    if (previous && previous !== session) {
      log('auth', `${user.name}: вход с другого места, прежнее соединение закрыто`);
      previous.kick('relogin');
    }
    session.user = user;
    this.online.set(userId, session);
    log('auth', `${user.name}: вошёл (${session.address})`);
    return user;
  }

  /** профиль заново из базы (кристаллы после покупки) — событие user игроку */
  async refreshUser(session: Session): Promise<void> {
    if (!session.user) return;
    const user = await loadUserInfo(this.db, session.user.id);
    if (!user || !session.isOpen) return;
    session.user = user;
    session.send('user', { user });
  }

  /**
   * Опыт за уничтожение (user_property_model.add_buffered_score): сразу в базу; при переходе на новое звание —
   * кристаллы за него (check_for_rank_up), затем событие user игроку.
   */
  addBattleScore(session: Session, userId: number, score: number): void {
    if (score <= 0) return;
    const day = missionDay();
    this.queueAward(userId, async () => {
      await this.db.transaction(async (tx) => {
        const { rows } = await tx.query<AwardRow>('SELECT score, crystals FROM UserProperties WHERE id = ? FOR UPDATE', [userId]);
        const row = rows[0];
        if (!row) return;
        const before = rankForScore(row.score);
        const total = row.score + score;
        const after = rankForScore(total);
        let reward = 0;
        for (let rank = before.rank + 1; rank <= after.rank; rank++) reward += RANK_REWARDS[rank - 1] ?? 0;
        await tx.query('UPDATE UserProperties SET score = ?, crystals = crystals + ? WHERE id = ?', [total, reward, userId]);
        await recordMission(tx, userId, 'kills', 1, day);
        await recordMission(tx, userId, 'score', score, day);
      });
      if (session.isOpen && session.user?.id === userId) await this.refreshUser(session);
    });
  }

  /** Кристаллы за ящик (add_crystals_to_user_id): в базу, событие user */
  giveBattleCrystals(session: Session, userId: number, crystals: number): void {
    if (crystals <= 0) return;
    const day = missionDay();
    this.queueAward(userId, async () => {
      await this.db.transaction(async tx => {
        await tx.query('UPDATE UserProperties SET crystals = crystals + ? WHERE id = ?', [crystals, userId]);
        await recordMission(tx, userId, 'boxes', crystals, day);
      });
      if (session.isOpen && session.user?.id === userId) await this.refreshUser(session);
    });
  }

  /** Припас из инвентаря израсходован (InventoryItemModel.subtract_supplie_from_user): UserItems.count − 1 */
  consumeBattleItem(_session: Session, userId: number, itemId: number): void {
    this.queueAward(userId, async () => {
      await this.db.query('UPDATE UserItems SET count = GREATEST(count - 1, 0) WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    });
  }

  /** Фонд в конце раунда (StatisticsModel.give_fund_to_users): кристаллы в базу, событие user */
  giveBattleFund(entries: { session: Session; userId: number; crystals: number }[]): void {
    for (const entry of entries) {
      if (entry.crystals <= 0) continue;
      this.queueAward(entry.userId, async () => {
        await this.db.query('UPDATE UserProperties SET crystals = crystals + ? WHERE id = ?', [entry.crystals, entry.userId]);
        if (entry.session.isOpen && entry.session.user?.id === entry.userId) await this.refreshUser(entry.session);
      });
    }
  }

  /** ошибка начисления не валит бой: журнал, очередь игрока продолжается */
  private queueAward(userId: number, task: () => Promise<void>): void {
    const previous = this.awardQueues.get(userId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => log('battle', `начисление игроку ${userId}: ${String(error)}`));
    this.awardQueues.set(userId, next);
    void next.finally(() => {
      if (this.awardQueues.get(userId) === next) this.awardQueues.delete(userId);
    });
  }

  /** игрок в сети по нику (chat_service.online_client, без учёта регистра) */
  sessionByName(name: string): Session | null {
    const lower = name.toLowerCase();
    for (const session of this.online.values()) if (session.user?.name.toLowerCase() === lower) return session;
    return null;
  }

  /** id игрока по нику (chat_service.user_id_by_name) */
  async userIdByName(name: string): Promise<number | null> {
    const { rows } = await this.db.query<{ id: number }>('SELECT id FROM Users WHERE username = ? LIMIT 1', [name]);
    return rows[0]?.id ?? null;
  }

  /** /crystals ник число: минус — забрать; событие user онлайн-игроку; null — игрока нет */
  async changeCrystalsByName(name: string, amount: number): Promise<number | null> {
    const userId = await this.userIdByName(name);
    if (userId == null) return null;
    await this.db.query('UPDATE UserProperties SET crystals = GREATEST(0, crystals + ?) WHERE id = ?', [amount, userId]);
    const session = this.sessionByName(name);
    if (session) await this.refreshUser(session);
    const { rows } = await this.db.query<{ crystals: number }>('SELECT crystals FROM UserProperties WHERE id = ?', [userId]);
    return rows[0]?.crystals ?? null;
  }

  /** /exp ник число: минус — забрать; при новом звании начисляются кристаллы за него */
  async changeScoreByName(name: string, amount: number): Promise<number | null> {
    const userId = await this.userIdByName(name);
    if (userId == null) return null;
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<AwardRow>('SELECT score, crystals FROM UserProperties WHERE id = ? FOR UPDATE', [userId]);
      const row = rows[0];
      if (!row) return;
      const total = Math.max(0, row.score + amount);
      let reward = 0;
      if (amount > 0) {
        const before = rankForScore(row.score);
        const after = rankForScore(total);
        for (let rank = before.rank + 1; rank <= after.rank; rank++) reward += RANK_REWARDS[rank - 1] ?? 0;
      }
      await tx.query('UPDATE UserProperties SET score = ?, crystals = crystals + ? WHERE id = ?', [total, reward, userId]);
    });
    const session = this.sessionByName(name);
    if (session) await this.refreshUser(session);
    const { rows } = await this.db.query<{ score: number }>('SELECT score FROM UserProperties WHERE id = ?', [userId]);
    return rows[0]?.score ?? null;
  }

  /** /resetgarage ник: склад и надетое очищаются (garage_tables.reset_user_garage); false — игрока нет */
  async resetGarageByName(name: string): Promise<boolean> {
    const userId = await this.userIdByName(name);
    if (userId == null) return false;
    await this.garage.resetUser(userId);
    return true;
  }

  watchLobby(session: Session): void {
    this.lobbyWatchers.add(session);
  }

  broadcastLobby<K extends EventName>(type: K, data: Events[K]): void {
    for (const session of this.lobbyWatchers) {
      const battle=type==='lobby.battle'?(data as Events['lobby.battle']).battle:null;
      if(battle?.privateBattle&&!session.user?.admin&&!session.knownPrivateBattles.has(battle.id))continue;
      session.send(type,data);
    }
  }

  shutdown(): void {
    clearInterval(this.pruneTimer);
    this.rooms.shutdown();
    for (const session of [...this.sessions]) session.kick('shutdown');
  }
}

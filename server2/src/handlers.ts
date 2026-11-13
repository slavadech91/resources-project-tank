/** Обработчики запросов протокола v2: имя запроса → функция (проверка аргументов внутри). */
import { CHAT_KIND, PROTOCOL_VERSION, type ReplyData, type RequestName } from '../../html5/src/net2/protocol.ts';
import type { App } from './app.ts';
import { claimMission, listMissions } from './lobby/missions.ts';
import { login, register } from './auth/auth.ts';
import { runChatCommand } from './chat/commands.ts';
import { intArg, optionalVec, RequestError, shotHitValue, stringArg, vecValue } from './errors.ts';
import type { Session } from './net/session.ts';
import { TEAM, type BattleTeam, type GarageLists } from '../../html5/src/net2/protocol.ts';

type Handler<K extends RequestName> = (app: App, session: Session, args: Record<string, unknown>) => Promise<ReplyData<K>>;

function lists(snapshot: GarageLists): GarageLists {
  return { depot: snapshot.depot, market: snapshot.market, mounted: snapshot.mounted,appearances:snapshot.appearances };
}

/** после покупки: свежие списки, затронутые предметы и новый баланс (событие user) */
async function afterPurchase(app: App, session: Session, touched: number[]): Promise<GarageLists & { updated: ReturnType<App['garage']['infos']> }> {
  const snapshot = await app.garage.snapshot(app.db, session.user!.id);
  await app.refreshUser(session);
  return { ...lists(snapshot), updated: app.garage.infos(snapshot, touched) };
}

/** серверное время, на которое стрелок видел чужие танки (i32) */
function viewTime(args: Record<string, unknown>): number {
  return intArg(args, 'viewTime', -0x80000000, 0x7fffffff);
}

function teamArg(args: Record<string, unknown>): BattleTeam | undefined {
  if (args.team == null) return undefined;
  const team = intArg(args, 'team', 0, 2);
  return team === TEAM.RED || team === TEAM.BLUE ? team : undefined;
}

function requireAdmin(session: Session): void {
  if (!session.user?.admin) throw new RequestError('forbidden', 'только для администратора');
}

export const handlers: { [K in RequestName]: Handler<K> } = {
  hello: async () => ({ server: 'server2', version: PROTOCOL_VERSION }),
  'auth.login': login,
  'auth.register': register,
  'lobby.battles': async (app, session) => {
    app.watchLobby(session);
    return { battles: app.battles.list().filter(b=>!b.privateBattle||session.user?.admin||session.knownPrivateBattles.has(b.id)), maps: app.maps, limits: app.config.battleLimits };
  },
  'lobby.getBattle':async(app,session,args)=>{const battle=app.battles.get(intArg(args,'battleId',1,0xffffffff));if(!battle)throw new RequestError('not_found','нет такого боя');session.knownPrivateBattles.add(battle.id);return {battle};},
  'lobby.chatWatch':async(app,session)=>({messages:app.lobbyChat.watch(session)}),
  'lobby.chatUnwatch':async(app,session)=>{app.lobbyChat.unwatch(session);return {};},
  'lobby.chatSend':async(app,session,args)=>{app.lobbyChat.send(session,args.text);return {};},
  'lobby.create': async (app, session, args) => {
    requireAdmin(session);
    const battle = await app.battles.create(app.battles.validate(args));
    app.broadcastLobby('lobby.battle', { battle });
    return { battle };
  },
  'lobby.remove': async (app, session, args) => {
    requireAdmin(session);
    const battleId = intArg(args, 'battleId', 1, 0xffffffff);
    if (!(await app.battles.remove(battleId))) throw new RequestError('not_found', 'нет такого боя');
    app.rooms.close(battleId);
    app.broadcastLobby('lobby.battleRemoved', { battleId });
    return {};
  },
  'garage.appearance':async(app,session,args)=>({appearances:await app.garage.appearances.set(session.user!.id,intArg(args,'itemId',0,0xffffffff),args.style)}),
  'missions.list': (app, session) => listMissions(app.db, session.user!.id),
  'missions.claim': async (app, session, args) => {
    const userId = session.user!.id;
    await claimMission(app.db, userId, stringArg(args, 'missionId', 12), stringArg(args, 'day', 10));
    await app.refreshUser(session);
    return listMissions(app.db, userId);
  },
  'garage.load': async (app, session) => {
    const snapshot = await app.garage.load(session.user!.id);
    return { ...lists(snapshot), items: app.garage.infos(snapshot) };
  },
  'garage.buy': async (app, session, args) => {
    const touched = await app.garage.buy(
      session.user!.id,
      session.user!.rank,
      intArg(args, 'itemId', 0, 0xffffffff),
      intArg(args, 'count', 0, 9999),
      intArg(args, 'price', 0, 0x7fffffff),
      session.user!.admin,
    );
    return afterPurchase(app, session, touched);
  },
  'garage.buyNext': async (app, session, args) => {
    const touched = await app.garage.buyNext(session.user!.id, session.user!.rank, intArg(args, 'itemId', 0, 0xffffffff), intArg(args, 'price', 0, 0x7fffffff),session.user!.admin);
    return afterPurchase(app, session, touched);
  },
  'garage.mount': async (app, session, args) => {
    await app.garage.mount(session.user!.id, intArg(args, 'itemId', 0, 0xffffffff));
    return lists(await app.garage.snapshot(app.db, session.user!.id));
  },
  'battle.join': async (app, session, args) => ({ info: await app.rooms.join(session, intArg(args, 'battleId', 1, 0xffffffff), teamArg(args)) }),
  'battle.leave': async (app, session) => {
    app.rooms.leave(session);
    return {};
  },
  'battle.flags':async(app,session)=>({flags:app.rooms.battleOf(session).flagsInfo()}),
  'battle.dropFlag':async(app,session)=>{app.rooms.battleOf(session).dropFlag(session);return {};},
  'battle.ready': async (app, session) => {
    app.rooms.battleOf(session).ready(session);
    return {};
  },
  'battle.activate': async (app, session, args) => {
    app.rooms.battleOf(session).activate(session, intArg(args, 'life', 0, 0x7fffffff));
    return {};
  },
  'battle.suicide': async (app, session) => {
    app.rooms.battleOf(session).suicide(session);
    return {};
  },
  'battle.smoky': async (app, session, args) =>
    app.rooms.battleOf(session).smoky(session, viewTime(args), optionalVec(args, 'hit'), args.target == null ? null : shotHitValue(args.target, 'target')),
  'battle.railCharge': async (app, session) => {
    app.rooms.battleOf(session).railCharge(session);
    return {};
  },
  'battle.rail': async (app, session, args) => {
    if (!Array.isArray(args.targets) || args.targets.length > 32) throw new RequestError('bad_request', 'поле targets: ожидался список');
    const targets = args.targets.map((target, index) => shotHitValue(target, `targets[${index}]`));
    return app.rooms.battleOf(session).rail(session, viewTime(args), optionalVec(args, 'hit'), args.dummy === true ? [] : targets, args.dummy === true);
  },
  'battle.twins': async (app, session, args) => {
    app.rooms.battleOf(session).twins(session, intArg(args, 'barrel', 0, 1), intArg(args, 'shotId', -0x80000000, 0x7fffffff), vecValue(args.direction, 'direction'));
    return {};
  },
  'battle.twinsHit': async (app, session, args) =>
    app.rooms.battleOf(session).twinsHit(session, viewTime(args), intArg(args, 'shotId', -0x80000000, 0x7fffffff), shotHitValue(args.target, 'target')),
  'battle.thunder': async (app, session, args) =>
    app.rooms.battleOf(session).thunder(session, viewTime(args), optionalVec(args, 'hit'), args.target == null ? null : shotHitValue(args.target, 'target')),
  'battle.ricochet': async (app, session, args) => {
    app.rooms.battleOf(session).ricochet(session, intArg(args, 'shotId', -0x80000000, 0x7fffffff), vecValue(args.direction, 'direction'));
    return {};
  },
  'battle.ricochetHit': async (app, session, args) =>
    app.rooms.battleOf(session).ricochetHit(
      session,
      viewTime(args),
      intArg(args, 'shotId', -0x80000000, 0x7fffffff),
      shotHitValue(args.target, 'target'),
      args.bounces == null ? 0 : intArg(args, 'bounces', 0, 1000),
    ),
  'battle.shaftAim': async (app, session, args) => {
    app.rooms.battleOf(session).shaftAim(session, args.active === true);
    return {};
  },
  'battle.shaft': async (app, session, args) => {
    if (!Array.isArray(args.targets) || args.targets.length > 32) throw new RequestError('bad_request', 'поле targets: ожидался список');
    const targets = args.targets.map((target, index) => shotHitValue(target, `targets[${index}]`));
    return app.rooms.battleOf(session).shaft(session, viewTime(args), args.aimed === true, optionalVec(args, 'hit'), targets);
  },
  'battle.streamStart': async (app, session) => {
    app.rooms.battleOf(session).streamStart(session);
    return {};
  },
  'battle.streamTick': async (app, session, args) => {
    if (!Array.isArray(args.targets) || args.targets.length > 32) throw new RequestError('bad_request', 'поле targets: ожидался список');
    const targets = args.targets.map((target, index) => shotHitValue(target, `targets[${index}]`));
    return app.rooms.battleOf(session).streamTick(session, viewTime(args), targets, optionalVec(args, 'origin'));
  },
  'battle.isidaTarget': async (app, session, args) => {
    app.rooms.battleOf(session).isidaTarget(session, viewTime(args), args.target == null ? null : shotHitValue(args.target, 'target'), optionalVec(args, 'origin'));
    return {};
  },
  'battle.streamStop': async (app, session) => {
    app.rooms.battleOf(session).streamStop(session);
    return {};
  },
  'battle.takeBonus': async (app, session, args) => {
    app.rooms.battleOf(session).takeBonus(session, intArg(args, 'bonusId', 1, 0xffffffff));
    return {};
  },
  'battle.bonuses': async (app, session) => ({ bonuses: app.rooms.battleOf(session).bonusesInfo() }),
  'battle.effects': async (app, session) => ({ effects: app.rooms.battleOf(session).effectsInfo() }),
  'battle.activateItem': async (app, session, args) => {
    app.rooms.battleOf(session).activateItem(session, intArg(args, 'index', 1, 5));
    return {};
  },
  'battle.mines': async (app, session) => ({ mines: app.rooms.battleOf(session).minesInfo() }),
  'battle.chat': async (app, session, args) => {
    const battle = app.rooms.battleOf(session);
    const text = stringArg(args, 'text').trim();
    if (!text) return {};
    if (text.startsWith('/')) await runChatCommand(app, session, battle, text);
    else battle.broadcastChat(session.user!.name, session.user!.rank, CHAT_KIND.PLAYER, text);
    return {};
  },
};

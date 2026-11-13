import {equipmentAllowed} from './rules.ts';
import { loadBotProfile } from './botProfile.ts';
/**
 * Идущие бои: бой из списка лобби оживает при входе первого игрока. Игрок — не больше чем в одном бою; вход в другой
 * бой выводит из прежнего. Число игроков уходит в лобби событием lobby.battle.
 */
import type { BattleInfo, BattleTeam } from '../../../html5/src/net2/protocol.ts';
import { FRAME, decodeFrame, encodePong } from '../../../html5/src/net2/battleCodec.ts';
import type { TanksCollisionDetector } from '../../../html5/src/tanks/physics/TanksCollisionDetector.ts';
import type { App } from '../app.ts';
import { RequestError } from '../errors.ts';
import type { Session } from '../net/session.ts';
import { Battle, serverMs } from './battle.ts';
import { buildCollisionDetector } from './collision.ts';
import { loadLoadout } from './loadout.ts';
import type { MapData } from './mapData.ts';

export class BattleRooms {
  private readonly app: App;
  private readonly maps: Map<number, MapData>;
  private readonly rooms = new Map<number, Battle>();
  /** в каком бою игрок (по соединению) */
  private readonly bySession = new Map<Session, Battle>();
  /** статика карт для серверных лучей — строится при первом бое на карте */
  private readonly detectors = new Map<number, TanksCollisionDetector | null>();
  private botProfile: ReturnType<typeof loadBotProfile> | undefined;

  constructor(app: App, maps: Map<number, MapData>) {
    this.app = app;
    this.maps = maps;
  }

  battleOf(session: Session): Battle {
    const battle = this.bySession.get(session);
    if (!battle) throw new RequestError('bad_request', 'не в бою');
    return battle;
  }

  async join(session: Session, battleId: number, team: BattleTeam | undefined): Promise<BattleInfo> {
    const user = session.user!;
    const check = (): { battle: Battle; team: BattleTeam } => {
      const summary = this.app.battles.get(battleId);
      if (!summary) throw new RequestError('not_found', 'нет такого боя');
      const map = this.maps.get(summary.mapId);
      if (!map) throw new RequestError('server_error', 'карта боя не загружена');
      if (user.rank < summary.minRank || user.rank > summary.maxRank) throw new RequestError('forbidden', 'звание не подходит для этого боя');
      const battle =
        this.rooms.get(battleId) ??
        new Battle(summary, map, this.app.config.battle, (changed) => this.playersChanged(changed), {
          addKillScore: (session, userId, score) => this.app.addBattleScore(session, userId, score),
          giveFund: (entries) => this.app.giveBattleFund(entries),
          giveCrystals: (session, userId, crystals) => this.app.giveBattleCrystals(session, userId, crystals),
          consumeItem: (session, userId, itemId) => this.app.consumeBattleItem(session, userId, itemId),
        }, this.detectorFor(map));
      return { battle, team: battle.pickTeam(user.id, team) };
    };
    const summary=this.app.battles.get(battleId)!;
    check();
    const loadout = await loadLoadout(this.app.garage, user.id, this.app.config.battle.inventory,summary.withoutUpgrades??false);
    if (!session.isOpen) throw new RequestError('bad_request', 'соединение закрыто');
    // пока грузилось снаряжение, бой могли удалить или заполнить
    const { battle, team: chosen } = check();
    if(battle.summary.botCount){
      const bots=this.botProfile??=loadBotProfile(this.app.config.configDir,this.app.garage.catalog);
      battle.configureBots(bots.profile,bots.loadout,bots.equipment,bots.hulls,bots.paints);
    }
    if(!equipmentAllowed(battle.summary,loadout.hullKind,loadout.weapon.kind))throw new RequestError('forbidden','Снаряжение не соответствует формату битвы');
    this.leave(session);
    this.rooms.set(battleId, battle);
    this.bySession.set(session, battle);
    return battle.add(session, user, loadout, chosen);
  }

  leave(session: Session): void {
    const battle = this.bySession.get(session);
    if (!battle) return;
    this.bySession.delete(session);
    battle.remove(session);
  }

  /** бой удалён из лобби */
  close(battleId: number): void {
    const battle = this.rooms.get(battleId);
    if (!battle) return;
    this.rooms.delete(battleId);
    for (const session of battle.close()) this.bySession.delete(session);
  }

  shutdown(): void {
    for (const id of [...this.rooms.keys()]) this.close(id);
  }

  /** двоичный кадр игрока; false — нарушение протокола (соединение закрывается) */
  onFrame(session: Session, data: Uint8Array): boolean {
    const frame = decodeFrame(data);
    if (!frame) return false;
    if (frame.type === FRAME.PING) {
      session.ws.sendBinary(encodePong(frame.pingId, frame.clientMs, serverMs()));
      return true;
    }
    if (frame.type === FRAME.STATE) {
      this.bySession.get(session)?.acceptState(session, frame.sample);
      return true;
    }
    return false;
  }

  get stats(): { battles: number; players: number } {
    return { battles: this.rooms.size, players: this.bySession.size };
  }

  private playersChanged(battle: Battle): void {
    const summary = battle.summary;
    summary.teamScores=battle.getTeamScores();
    summary.players = battle.counts();
    summary.users = battle.userSummaries();
    if (this.app.battles.get(summary.id) === summary) this.app.broadcastLobby('lobby.battle', { battle: summary });
  }

  /** статика карты для лучей: строится один раз на карту */
  private detectorFor(map: MapData): TanksCollisionDetector | null {
    if (!this.detectors.has(map.mapId)) this.detectors.set(map.mapId, buildCollisionDetector(map.xml));
    return this.detectors.get(map.mapId) ?? null;
  }
}

import {battleRules} from '../battle/rules.ts';
/**
 * Список боёв server2. Бои хранятся в своей таблице S2Battles (настройки — JSON), чтобы не мешать старому серверу
 * с его таблицей Battles. Пока таблица пуста, создаются бои по умолчанию. Сами бои — этап 3; сейчас это список.
 */
import { BEGINNER_BATTLE_ID, MAX_BOTS, BATTLE_NAME_MAX_LENGTH, type BattleMode, type BattleSettings, type BattleSummary, type MapSummary } from '../../../html5/src/net2/protocol.ts';
import type { Database } from '../db/mysql.ts';
import { intArg, RequestError, stringArg } from '../errors.ts';
import { log, logError } from '../log.ts';

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS S2Battles (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  data TEXT NOT NULL,
  created DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const MAX_TIME_LIMIT_SEC = 24 * 3600;
const MAX_SCORE_LIMIT = 9999;

export class BattleRegistry {
  private readonly db: Database;
  private readonly maps: MapSummary[];
  private readonly battles = new Map<number, BattleSummary>();
  /** таблица недоступна (нет прав) — бои только в памяти */
  private memoryOnly = false;
  private nextMemoryId = 1;

  constructor(db: Database, maps: MapSummary[]) {
    this.db = db;
    this.maps = maps;
  }

  async load(): Promise<void> {
    try {
      await this.db.query(CREATE_TABLE);
      const { rows } = await this.db.query<{ id: number; data: string }>('SELECT id, data FROM S2Battles ORDER BY id');
      for (const row of rows) {
        try {
          this.battles.set(row.id, this.summary(row.id, this.validate(JSON.parse(row.data) as Record<string, unknown>)));
        } catch (error) {
          logError('lobby', `бой ${row.id} пропущен: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.memoryOnly = true;
      logError('lobby', `таблица S2Battles недоступна, бои только в памяти: ${(error as Error).message}`);
    }
    if (!this.battles.size) {
      for (const settings of this.defaults()) await this.create(settings);
    }
    const sandbox=this.maps.find(map=>map.name==='Песочница'&&map.modes.includes('ctf'));
    if(sandbox)this.battles.set(BEGINNER_BATTLE_ID,this.summary(BEGINNER_BATTLE_ID,{
      name:'Песочница для новичков',mode:'ctf',mapId:sandbox.id,maxPeople:sandbox.maxPeople,
      timeLimitSec:900,scoreLimit:10,minRank:sandbox.minRank,maxRank:sandbox.maxRank,
      botCount:Math.max(0,Math.floor(sandbox.maxPeople/2)*2-2),
    }));
    log('lobby', `боёв: ${this.battles.size}`);
  }

  list(): BattleSummary[] {
    return [...this.battles.values()];
  }

  get(id: number): BattleSummary | undefined {
    return this.battles.get(id);
  }

  /** проверка настроек от клиента; ошибка — bad_request с понятным текстом */
  validate(args: Record<string, unknown>): BattleSettings {
    const map = this.maps.find((candidate) => candidate.id === args.mapId);
    if (!map) throw new RequestError('bad_request', 'нет такой карты');
    const mode = stringArg(args, 'mode', 8) as BattleMode;
    if (!map.modes.includes(mode)) throw new RequestError('bad_request', `режим ${mode} на этой карте недоступен`);
    const name = Array.from(stringArg(args, 'name', 200).replace(/[\u0000-\u001f\u007f]/g, '').trim())
      .slice(0, BATTLE_NAME_MAX_LENGTH)
      .join('');
    const minRank = intArg(args, 'minRank', map.minRank, map.maxRank);
    const maxPeople=intArg(args,'maxPeople',2,map.maxPeople);
    const botCount=intArg({...args,botCount:args.botCount??0},'botCount',0,Math.min(MAX_BOTS,(mode!=='dm'?Math.floor(maxPeople/2)*2:maxPeople)-1));
    const rules=battleRules(args);
    if(botCount>0&&rules.equipmentConstraintsMode==='HORNET_RAILGUN')throw new RequestError('bad_request','Боты на Васпах не подходят для формата ХР');
    return {
      ...rules,
      botCount,
      name: name || `${map.name} ${mode.toUpperCase()}`,
      mode,
      mapId: map.id,
      maxPeople: intArg(args, 'maxPeople', 2, map.maxPeople),
      timeLimitSec: intArg(args, 'timeLimitSec', 0, MAX_TIME_LIMIT_SEC),
      scoreLimit: intArg(args, 'scoreLimit', 0, MAX_SCORE_LIMIT),
      minRank,
      maxRank: intArg(args, 'maxRank', minRank, map.maxRank),
    };
  }

  async create(settings: BattleSettings): Promise<BattleSummary> {
    let id: number;
    if (this.memoryOnly) {
      id = this.nextMemoryId++;
    } else {
      const result = await this.db.query('INSERT INTO S2Battles (data, created) VALUES (?, ?)', [JSON.stringify(settings), new Date()]);
      id = result.insertId;
    }
    const battle = this.summary(id, settings);
    this.battles.set(id, battle);
    return battle;
  }

  async remove(id: number): Promise<boolean> {
    if (id===BEGINNER_BATTLE_ID) return false;
    if (!this.battles.has(id)) return false;
    if (!this.memoryOnly) await this.db.query('DELETE FROM S2Battles WHERE id = ?', [id]);
    this.battles.delete(id);
    return true;
  }

  private summary(id: number, settings: BattleSettings): BattleSummary {
    const map = this.maps.find((candidate) => candidate.id === settings.mapId);
    return { ...settings, id, mapName: map?.name ?? `#${settings.mapId}`, players: [0, 0], users: [] };
  }

  private defaults(): BattleSettings[] {
    const result: BattleSettings[] = [];
    for (const map of this.maps) {
      if (map.name.toLowerCase() === 'test') continue;
      for (const mode of map.modes) {
        result.push({
          name: `${map.name} ${mode.toUpperCase()}`,
          mode,
          mapId: map.id,
          maxPeople: map.maxPeople,
          timeLimitSec: 900,
          scoreLimit: 0,
          minRank: map.minRank,
          maxRank: map.maxRank,
        });
      }
    }
    return result;
  }
}

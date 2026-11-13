import type { DailyMission, DailyMissionsState } from '../../../html5/src/net2/protocol.ts';
import type { Database, Queryable } from '../db/mysql.ts';
import { RequestError } from '../errors.ts';

const missions = [
  { id: 'kills', title: 'Уничтожь противников', target: 10, reward: 100 },
  { id: 'score', title: 'Заработай опыт в боях', target: 100, reward: 150 },
  { id: 'boxes', title: 'Подбери кристаллы в бою', target: 30, reward: 100 },
] as const;

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const MOSCOW_OFFSET_MS = 3 * HOUR_MS;

export async function initMissions(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS S2DailyMissions (
    user_id INT UNSIGNED NOT NULL, mission_day CHAR(10) NOT NULL, mission_id VARCHAR(12) NOT NULL,
    progress INT UNSIGNED NOT NULL, claimed TINYINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, mission_day, mission_id)
  ) ENGINE=InnoDB`);
}

export async function recordMission(db: Queryable, userId: number, id: DailyMission['id'], amount: number, day = missionDay()): Promise<void> {
  const target = missions.find(mission => mission.id === id)!.target;
  await db.query(`INSERT INTO S2DailyMissions (user_id, mission_day, mission_id, progress)
    VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE progress = LEAST(?, progress + VALUES(progress))`,
    [userId, day, id, Math.min(amount, target), target]);
}

export function missionDay(now = Date.now()): string {
  return new Date(now + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

export async function listMissions(db: Queryable, userId: number): Promise<DailyMissionsState> {
  const now = Date.now();
  const day = missionDay(now);
  const resetAt = now + DAY_MS - (now + MOSCOW_OFFSET_MS) % DAY_MS;
  const { rows } = await db.query<{ mission_id: string; progress: number; claimed: number }>(
    'SELECT mission_id, progress, claimed FROM S2DailyMissions WHERE user_id = ? AND mission_day = ?', [userId, day]);
  return { day, resetInMs: Math.max(0, resetAt - Date.now()), missions: missions.map(mission => {
    const row = rows.find(entry => entry.mission_id === mission.id);
    return { ...mission, progress: row?.progress ?? 0, claimed: Boolean(row?.claimed) };
  }) };
}

export async function claimMission(db: Database, userId: number, id: string, day: string): Promise<void> {
  const mission = missions.find(entry => entry.id === id);
  if (!mission || day !== missionDay()) throw new RequestError('bad_request', 'Обнови список заданий');
  await db.transaction(async tx => {
    const { rows } = await tx.query<{ progress: number; claimed: number }>(
      'SELECT progress, claimed FROM S2DailyMissions WHERE user_id = ? AND mission_day = ? AND mission_id = ? FOR UPDATE',
      [userId, day, id]);
    const row = rows[0];
    if (!row || row.progress < mission.target || row.claimed) throw new RequestError('bad_request', 'Награда недоступна');
    await tx.query('UPDATE S2DailyMissions SET claimed = 1 WHERE user_id = ? AND mission_day = ? AND mission_id = ?', [userId, day, id]);
    await tx.query('UPDATE UserProperties SET crystals = crystals + ? WHERE id = ?', [mission.reward, userId]);
  });
}

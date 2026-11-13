/** Профиль игрока из общих со старым сервером таблиц Users и UserProperties. */
import type { UserInfo } from '../../../html5/src/net2/protocol.ts';
import type { Queryable } from '../db/mysql.ts';
import { rankForScore } from './ranks.ts';

/** роли старого сервера (UserProperties.user_roles, JSON-массив): 0 — игрок, 1 — администратор, 2 — наблюдатель */
export const ROLE_ADMIN = 1;

interface ProfileRow {
  id: number;
  username: string;
  crystals: number;
  score: number;
  user_roles: string | null;
}

function parseRoles(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const roles: unknown = JSON.parse(raw);
    return Array.isArray(roles) ? roles.filter((role): role is number => typeof role === 'number') : [];
  } catch {
    return [];
  }
}

export async function loadUserInfo(db: Queryable, userId: number): Promise<UserInfo | null> {
  const { rows } = await db.query<ProfileRow>(
    'SELECT u.id, u.username, p.crystals, p.score, p.user_roles FROM Users u JOIN UserProperties p ON p.id = u.id WHERE u.id = ?',
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.username,
    ...rankForScore(row.score),
    score: row.score,
    crystals: row.crystals,
    admin: parseRoles(row.user_roles).includes(ROLE_ADMIN),
  };
}

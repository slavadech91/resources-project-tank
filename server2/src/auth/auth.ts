/**
 * Вход и регистрация — по правилам старого сервера (login/registration_model_command_handler.py), в те же таблицы:
 * пароль bcrypt `$2b$12$` в Users.password, стартовые кристаллы и очки, роли `[0]`, пустая строка MountedItems.
 * Неизвестное имя, неверный пароль и бан — одна ошибка `wrong_password`, как в старом клиенте.
 */
import { isValidPassword, USERNAME_PATTERN, type UserInfo } from '../../../html5/src/net2/protocol.ts';
import type { App } from '../app.ts';
import { DbError, ER_DUP_ENTRY } from '../db/mysql.ts';
import { RequestError, stringArg } from '../errors.ts';
import { log } from '../log.ts';
import type { Session } from '../net/session.ts';

interface CredentialsRow {
  id: number;
  password: Buffer | string;
}

function credentials(session: Session, args: Record<string, unknown>): { username: string; password: string } {
  if (session.user) throw new RequestError('bad_request', 'уже выполнен вход');
  return { username: stringArg(args, 'username', 64), password: stringArg(args, 'password', 256) };
}

function storedHash(value: Buffer | string): string {
  // BINARY(60) дополняется нулями, если значение короче
  return (typeof value === 'string' ? value : Buffer.from(value).toString('latin1')).replace(/\0+$/, '');
}

export async function login(app: App, session: Session, args: Record<string, unknown>): Promise<{ user: UserInfo }> {
  const { username, password } = credentials(session, args);
  if (!USERNAME_PATTERN.test(username) || !isValidPassword(password)) throw new RequestError('wrong_password');
  app.limitAuth(session);
  if (app.bans.bannedUntil(username) !== null) {
    log('auth', `${username}: вход отклонён — бан (${session.address})`);
    throw new RequestError('wrong_password');
  }
  const { rows } = await app.db.query<CredentialsRow>('SELECT id, password FROM Users WHERE username = ? LIMIT 1', [username]);
  const row = rows[0];
  if (!row || !(await app.hasher.check(password, storedHash(row.password)))) {
    log('auth', `${username}: неверное имя или пароль (${session.address})`);
    throw new RequestError('wrong_password');
  }
  return { user: await app.signIn(session, row.id) };
}

export async function register(app: App, session: Session, args: Record<string, unknown>): Promise<{ user: UserInfo }> {
  const { username, password } = credentials(session, args);
  if (!USERNAME_PATTERN.test(username)) throw new RequestError('invalid_name');
  const length = Array.from(password).length;
  if (!isValidPassword(password) || length < app.config.minPasswordLength || length > app.config.maxPasswordLength) {
    throw new RequestError('invalid_password', `пароль: от ${app.config.minPasswordLength} до ${app.config.maxPasswordLength} символов`);
  }
  app.limitAuth(session);
  const key = username.toLowerCase();
  if (app.registering.has(key)) throw new RequestError('name_taken');
  app.registering.add(key);
  let userId: number;
  try {
    // сравнение в базе без учёта регистра (utf8mb4_unicode_ci) — как users_table.user_exist
    const { rows } = await app.db.query('SELECT id FROM Users WHERE username = ? LIMIT 1', [username]);
    if (rows.length) throw new RequestError('name_taken');
    const hash = await app.hasher.hash(password, app.config.bcryptCost);
    const now = new Date();
    userId = await app.db.transaction(async (tx) => {
      const { insertId } = await tx.query('INSERT INTO Users (username, password, email, reg_date) VALUES (?, ?, ?, ?)', [username, hash, '', now]);
      await tx.query(
        'INSERT INTO UserProperties (id, crystals, score, last_visit, next_crystal_reward, user_roles) VALUES (?, ?, ?, ?, ?, ?)',
        [insertId, app.config.startingCrystals, app.config.startingScore, now, now, '[0]'],
      );
      await tx.query('INSERT INTO MountedItems (user_id, weapon_slot, armor_slot, color_slot) VALUES (?, NULL, NULL, NULL)', [insertId]);
      return insertId;
    });
  } catch (error) {
    if (error instanceof DbError && error.code === ER_DUP_ENTRY) throw new RequestError('name_taken');
    throw error;
  } finally {
    app.registering.delete(key);
  }
  log('auth', `${username}: зарегистрирован, id ${userId} (${session.address})`);
  return { user: await app.signIn(session, userId) };
}

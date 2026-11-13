/**
 * Команды администратора в чате боя (chat_service.py): /help, /kick, /ban, /unban, /restart, /crystals, /exp,
 * /resetgarage, /delbattle. Выполняет только администратор (роль 1 в UserProperties.user_roles); ответы — сообщения
 * чата вида REPLY, /restart дополнительно SYSTEM всем в бою.
 */
import { CHAT_KIND } from '../../../html5/src/net2/protocol.ts';
import type { App } from '../app.ts';
import type { Battle } from '../battle/battle.ts';
import { log } from '../log.ts';
import type { Session } from '../net/session.ts';

export const CHAT_HELP =
  'Команды: /kick ник · /ban ник [минут] · /unban ник · /restart (завершить раунд текущего боя) · ' +
  '/crystals ник число · /exp ник число (минус — забрать) · /resetgarage ник · /delbattle номер_боя';

function amount(text: string | undefined): number | null {
  if (text == null) return null;
  const value = Number(text);
  return Number.isInteger(value) ? value : null;
}

/** текст с «/» из чата боя; обычный текст сюда не попадает */
export async function runChatCommand(app: App, session: Session, battle: Battle, text: string): Promise<void> {
  const user = session.user;
  if (!user) return;
  const parts = text.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  const reply = (message: string): void => battle.sendChatTo(user.id, '', 0, CHAT_KIND.REPLY, message);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);
  if (!user.admin) {
    reply('Команды чата доступны только администраторам');
    return;
  }
  log('chat', `${user.name}: ${text}`);
  switch (name) {
    case 'help':
      reply(CHAT_HELP);
      return;
    case 'kick': {
      if (!args[0]) return reply('Кого отключить? /kick ник');
      const target = app.sessionByName(args[0]);
      if (!target) return reply(`Игрок ${args[0]} не в сети`);
      target.kick('admin');
      return reply(`${args[0]} отключён`);
    }
    case 'ban': {
      if (!args[0]) return reply('Кого забанить? /ban ник [минут]');
      if ((await app.userIdByName(args[0])) == null) return reply(`Игрока ${args[0]} нет`);
      const minutes = amount(args[1]) ?? 0;
      app.bans.set(args[0], minutes * 60);
      app.sessionByName(args[0])?.kick('banned');
      return reply(`${args[0]} забанен ${minutes ? `на ${minutes} мин` : 'навсегда'}`);
    }
    case 'unban': {
      if (!args[0]) return reply('Кого разбанить? /unban ник');
      return reply(app.bans.remove(args[0]) ? `${args[0]} разбанен` : `${args[0]} не в бане`);
    }
    case 'restart':
      if (!battle.adminEndRound()) reply('Раунд уже завершён');
      return;
    case 'crystals':
    case 'exp': {
      if (!args[0] || amount(args[1]) == null) return reply(`Число: /${name} ник число`);
      const delta = amount(args[1])!;
      const result = name === 'crystals' ? await app.changeCrystalsByName(args[0], delta) : await app.changeScoreByName(args[0], delta);
      if (result == null) return reply(`Игрока ${args[0]} нет`);
      return reply(`${args[0]}: ${name === 'crystals' ? 'кристаллы' : 'опыт'} ${delta >= 0 ? '+' : ''}${delta}, теперь ${result}`);
    }
    case 'resetgarage': {
      if (!args[0]) return reply('Кому? /resetgarage ник');
      if (!(await app.resetGarageByName(args[0]))) return reply(`Игрока ${args[0]} нет`);
      app.sessionByName(args[0])?.kick('admin');
      return reply(`Гараж ${args[0]} обнулён (игрок отключён, при входе — стартовый набор)`);
    }
    case 'delbattle': {
      const battleId = amount(args[0]);
      if (battleId == null || !(await app.battles.remove(battleId))) return reply(`Боя ${args[0] ?? ''} нет`);
      app.rooms.close(battleId);
      app.broadcastLobby('lobby.battleRemoved', { battleId });
      return reply(`Бой #${battleId} удалён`);
    }
    default:
      return reply('Неизвестная команда. ' + CHAT_HELP);
  }
}

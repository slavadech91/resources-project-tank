/**
 * Панель отладки сети (слева): вход, список боёв, пространства, журнал. Видна только администратору (ADMIN_STATE);
 * остальные входят через окно авторизации (ui/AuthWindow.ts), которое вызывает authenticate этой панели.
 */

import { GameClient, MODEL_ID } from '../net/client.ts';
import type { UserInfo } from '../net/client.ts';
import { BATTLE_MODE_NAMES, findBattleSpace, listBattles, loadBattleList, type BattleListItem } from '../net/battle-entry.ts';
import { bridgeUrlFromLocation, createBridgeConnect, getSavedBridge, isLocalPage, saveBridge } from '../net/transport-ws.ts';

const MAX_LOG_LINES = 300;
const COLLAPSED_KEY = 'tanki.netPanelCollapsed';
/** сколько ждать после входа, не вернёт ли сервер в покинутый бой */
const REJOIN_WAIT_MS = 1500;
/** сколько ждать ответа на логин; регистрацию с занятым именем сервер молча игнорирует — тогда ошибка по таймауту */
const LOGIN_TIMEOUT_MS = 30000;
const REGISTER_TIMEOUT_MS = 15000;

export type AuthMode = 'login' | 'register';

export interface NetPanel {
  readonly client: GameClient | null;
  readonly inBattle: boolean;
  /** вход в бой (кнопка «Играть» лобби) */
  joinBattle(battleId: number, team?: number | null): void;
  /** выход из боя; resolve после выхода */
  leaveBattle(target?: 'battles' | 'garage'): Promise<void>;
  /** сервер сам закрыл бой (администратор удалил его): панель снова «в лобби» */
  battleClosed(): void;
  /** подключение к мосту и вход/регистрация; resolve — после login-ok, reject — с текстом ошибки для игрока */
  authenticate(mode: AuthMode, username: string, password: string, remember: boolean): Promise<void>;
}

export function createNetPanel(
  root: HTMLElement,
  onUser?: (user: UserInfo) => void,
  onEnterBattle?: (client: GameClient, battleId: number | null, team?: number | null) => Promise<void>,
  onLeaveBattle?: (client: GameClient, target: 'battles' | 'garage') => Promise<void>,
  onClient?: (client: GameClient) => void,
): NetPanel {
  const panel = document.createElement('div');
  panel.id = 'net';
  panel.innerHTML = `
    <div class="net-title"><span>Сервер (M1: мост + протокол)</span><button id="net-collapse" type="button" title="Свернуть / развернуть">–</button></div>
    <div class="net-status" id="net-status">не подключено</div>
    <form id="net-form" autocomplete="off">
      <label id="net-bridge-row" hidden>адрес сервера <input id="net-bridge" type="text" spellcheck="false" placeholder="https://xxxx.lhr.life" /></label>
      <label>логин <input id="net-login" type="text" spellcheck="false" /></label>
      <label>пароль <input id="net-password" type="password" /></label>
      <label class="net-inline"><input id="net-remember" type="checkbox" /> запомнить</label>
      <button id="net-submit" type="submit">Войти</button>
    </form>
    <div class="net-user" id="net-user"></div>
    <div class="net-battle">
      <div class="net-battle-head">Список боёв <span><button id="net-battle-leave" type="button" hidden>Выйти из боя</button> <button id="net-battle-refresh" type="button" disabled>Обновить</button></span></div>
      <div class="net-battles" id="net-battles">войдите, чтобы увидеть бои</div>
    </div>
    <div class="net-spaces" id="net-spaces"></div>
    <div class="net-tank" id="net-tank"></div>
    <div class="net-log" id="net-log"></div>
  `;
  // до ADMIN_STATE=true панели не видно
  panel.hidden = true;
  root.appendChild(panel);

  // свернуть панель до заголовка и статуса; состояние помнит браузер
  const collapseButton = required<HTMLButtonElement>(panel, '#net-collapse');
  const setCollapsed = (collapsed: boolean): void => {
    panel.classList.toggle('net-collapsed', collapsed);
    collapseButton.textContent = collapsed ? '+' : '–';
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // хранилище недоступно — просто не запоминаем
    }
  };
  collapseButton.addEventListener('click', () => setCollapsed(!panel.classList.contains('net-collapsed')));
  try {
    if (localStorage.getItem(COLLAPSED_KEY) == '1') setCollapsed(true);
  } catch {
    // без хранилища панель развёрнута
  }

  const statusElement = required<HTMLElement>(panel, '#net-status');
  const form = required<HTMLFormElement>(panel, '#net-form');
  const loginInput = required<HTMLInputElement>(panel, '#net-login');
  // страница с удалённого хостинга: адрес туннеля до игрового сервера вводит игрок (запоминается в браузере)
  const bridgeRow = required<HTMLElement>(panel, '#net-bridge-row');
  const bridgeInput = required<HTMLInputElement>(panel, '#net-bridge');
  if (!isLocalPage() && !new URLSearchParams(window.location.search).has('bridge')) {
    bridgeRow.hidden = false;
    bridgeInput.value = getSavedBridge();
    bridgeInput.addEventListener('change', () => {
      saveBridge(bridgeInput.value);
      // до успешного подключения клиента можно просто пересоздать с новым адресом
      if (client && !connected) client = null;
      else if (client) writeLog('адрес сервера изменён: обновите страницу');
    });
  }
  const passwordInput = required<HTMLInputElement>(panel, '#net-password');
  const rememberInput = required<HTMLInputElement>(panel, '#net-remember');
  const submitButton = required<HTMLButtonElement>(panel, '#net-submit');
  const userElement = required<HTMLElement>(panel, '#net-user');
  const battlesElement = required<HTMLElement>(panel, '#net-battles');
  const leaveButton = required<HTMLButtonElement>(panel, '#net-battle-leave');
  const refreshButton = required<HTMLButtonElement>(panel, '#net-battle-refresh');
  const spacesElement = required<HTMLElement>(panel, '#net-spaces');
  const tankElement = required<HTMLElement>(panel, '#net-tank');
  const logElement = required<HTMLElement>(panel, '#net-log');

  let client: GameClient | null = null;
  let connected = false;

  const writeLog = (message: string): void => {
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    logElement.appendChild(line);
    while (logElement.childElementCount > MAX_LOG_LINES) logElement.firstElementChild?.remove();
    logElement.scrollTop = logElement.scrollHeight;
  };

  const setStatus = (text: string, kind: 'ok' | 'wait' | 'error' = 'wait'): void => {
    statusElement.textContent = text;
    statusElement.dataset.kind = kind;
  };

  const showUser = (user: UserInfo): void => {
    onUser?.(user);
    userElement.textContent = `${user.uid} (id ${user.userId}) — кристаллы ${user.crystals}, ранг ${user.rank}, очки ${user.score}/${user.nextRankScore}`;
  };

  const showSpaces = (): void => {
    if (!client) return;
    const lines: string[] = [];
    for (const name of client.getSpaceNames()) {
      const space = client.getSpace(name);
      if (!space) continue;
      if (name.startsWith('battle_field')) {
        const tanks = [...space.objects.values()].filter((object) => object.modelIds.includes(MODEL_ID.TANK));
        lines.push(`${name}: объектов ${space.objects.size}, танков ${tanks.length}`);
      } else {
        lines.push(`${name}: объектов ${space.objects.size}`);
      }
    }
    spacesElement.textContent = lines.join(' · ');

    const battleName = client.getSpaceNames().find((name) => name.startsWith('battle_field'));
    const battleSpace = battleName ? client.getSpace(battleName) : undefined;
    const tank = battleSpace
      ? [...battleSpace.objects.values()].find((object) => object.modelIds.includes(MODEL_ID.TANK))
      : undefined;
    const data = tank?.models.get(MODEL_ID.TANK) as
      | {
          local?: boolean;
          max_health?: number;
          tank_initialization_data?: {
            health?: number;
            logic_state?: number;
            position?: { x: number; y: number; z: number };
          };
        }
      | undefined;
    if (data) {
      const init = data.tank_initialization_data ?? {};
      const position = init.position ?? { x: 0, y: 0, z: 0 };
      const own = data.local ? ' (свой)' : '';
      tankElement.textContent =
        `танк: здоровье ${init.health ?? 0}/${data.max_health ?? 0}, ` +
        `состояние ${init.logic_state ?? -1}, ` +
        `позиция ${position.x.toFixed(0)}/${position.y.toFixed(0)}/${position.z.toFixed(0)}${own}`;
    }
  };

  const ensureClient = async (): Promise<GameClient> => {
    if (client) return client;

    const bridge = bridgeUrlFromLocation();
    const created = new GameClient({ connect: createBridgeConnect(bridge), host: '127.0.0.1', mainPort: 1212 });

    created.on('log', (message) => {
      writeLog(message);
      showSpaces();
    });
    created.on('space', (space) => {
      setStatus(`пространство ${space.name}`, 'ok');
      showSpaces();
    });
    created.on('user', showUser);
    created.on('login-ok', (payload) => {
      setStatus(`вошли как ${payload.username}`, 'ok');
      submitButton.disabled = false;
      submitButton.textContent = 'Войти ещё раз';
      refreshButton.disabled = false;
      // сервер сам возвращает игрока в бой, который тот покинул закрытием клиента: тогда сразу загружаем этот бой
      setTimeout(() => {
        if (client && findBattleSpace(client) && !inBattle) joinBattle(null);
        else void refreshBattles();
      }, REJOIN_WAIT_MS);
    });
    created.on('login-failed', () => {
      setStatus('неверный логин или пароль', 'error');
      submitButton.disabled = false;
    });
    created.on('admin', (admin) => {
      panel.hidden = !admin;
    });
    created.on('error', (payload) => {
      writeLog(`ОШИБКА: ${payload.message}`);
      if (payload.error instanceof Error) writeLog(`  ${payload.error.message}`);
      if (payload.error instanceof Error && payload.error.stack) writeLog(payload.error.stack.split('\n')[1] ?? '');
    });

    client = created;
    (window as unknown as { net: GameClient }).net = created;
    onClient?.(created);
    return created;
  };

  let inBattle = false;
  // последний полученный список: в бою battle_select закрыт, показываем его
  let lastBattles: BattleListItem[] = [];

  const renderBattles = (fresh: BattleListItem[]): void => {
    if (fresh.length > 0 || !inBattle) lastBattles = fresh;
    const battles = inBattle ? lastBattles : fresh;
    battlesElement.textContent = '';
    if (inBattle) {
      const note = document.createElement('div');
      note.textContent = 'Вы в бою. Чтобы зайти в другой, нажмите «Выйти из боя».';
      battlesElement.appendChild(note);
    }
    if (battles.length == 0) {
      battlesElement.textContent = 'боёв нет';
      return;
    }
    for (const battle of battles) {
      const mode = BATTLE_MODE_NAMES[battle.battleMode] ?? `режим ${battle.battleMode}`;
      const flags = [battle.privateBattle ? 'закрытый' : '', battle.proBattle ? 'PRO' : '', battle.withoutSupplies ? 'без бонусов' : ''].filter(Boolean).join(', ');
      const row = document.createElement('div');
      row.className = 'net-battle-row';
      const title = document.createElement('span');
      title.textContent = `#${battle.battleId} ${battle.name} · ${mode} · до ${battle.maxPeople} · ранг ${battle.rankMin}–${battle.rankMax}${flags ? ` · ${flags}` : ''}`;
      const join = document.createElement('button');
      join.type = 'button';
      join.textContent = 'Войти';
      // html5-клиент пока умеет только DM (без команд и флагов)
      join.disabled = inBattle || battle.battleMode != 0 || battle.privateBattle || !onEnterBattle;
      if (inBattle) join.title = 'вы уже в бою: сначала нажмите «Выйти из боя»';
      else if (battle.battleMode != 0) join.title = 'в html5 пока только DM';
      else if (battle.privateBattle) join.title = 'закрытый бой';
      join.addEventListener('click', () => joinBattle(battle.battleId));
      row.append(title, join);
      battlesElement.appendChild(row);
    }
  };

  const refreshBattles = async (): Promise<void> => {
    if (!client) return;
    refreshButton.disabled = true;
    try {
      renderBattles(await loadBattleList(client));
    } catch (error) {
      battlesElement.textContent = `не удалось получить список: ${error instanceof Error ? error.message : String(error)}`;
    }
    refreshButton.disabled = false;
  };

  const joinBattle = (battleId: number | null, team: number | null = null): void => {
    if (!client || !onEnterBattle || inBattle) return;
    inBattle = true;
    for (const button of battlesElement.querySelectorAll('button')) button.disabled = true;
    setStatus(battleId == null ? 'возвращаюсь в покинутый бой…' : `вхожу в бой #${battleId}…`);
    onEnterBattle(client, battleId, team)
      .then(() => {
        setStatus('в бою', 'ok');
        leaveButton.hidden = false;
        if (client) renderBattles(listBattles(client));
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error), 'error');
        writeLog(`ОШИБКА входа в бой: ${error instanceof Error ? error.message : String(error)}`);
        inBattle = false;
        if (client) renderBattles(listBattles(client));
      });
  };

  const leave = async (target: 'battles' | 'garage' = 'battles'): Promise<void> => {
    if (!client || !onLeaveBattle || !inBattle) return;
    leaveButton.disabled = true;
    setStatus('выхожу из боя…');
    try {
      await onLeaveBattle(client, target);
      inBattle = false;
      leaveButton.hidden = true;
      setStatus('в лобби', 'ok');
      await refreshBattles();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
      writeLog(`ОШИБКА выхода из боя: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      leaveButton.disabled = false;
    }
  };
  leaveButton.addEventListener('click', () => void leave('battles'));

  refreshButton.addEventListener('click', () => void refreshBattles());

  /** подключиться (при первом входе) и отправить логин или регистрацию */
  const send = async (mode: AuthMode, username: string, password: string, remember: boolean): Promise<GameClient> => {
    const active = await ensureClient();
    if (!connected) {
      setStatus('подключаюсь к мосту…');
      try {
        await active.connect();
      } catch (error) {
        // мост не ответил: следующая попытка возьмёт адрес заново
        client = null;
        throw error;
      }
      connected = true;
      setStatus('подключено, гружу entrance…');
    }
    setStatus(mode == 'login' ? 'отправляю логин…' : 'отправляю регистрацию…');
    if (mode == 'login') await active.login(username, password, remember);
    else await active.register(username, password, remember);
    return active;
  };

  const authenticate = async (mode: AuthMode, username: string, password: string, remember: boolean): Promise<void> => {
    const active = await send(mode, username, password, remember);
    await new Promise<void>((resolve, reject) => {
      const done = (error: Error | null): void => {
        window.clearTimeout(timer);
        active.off('login-ok', ok);
        active.off('login-failed', failed);
        if (error) reject(error);
        else resolve();
      };
      const ok = (): void => done(null);
      const failed = (): void => done(new Error('Неверный логин или пароль'));
      const timer = window.setTimeout(
        () => done(new Error(mode == 'register' ? 'Имя занято или недопустимо' : 'Сервер не ответил на вход')),
        mode == 'register' ? REGISTER_TIMEOUT_MS : LOGIN_TIMEOUT_MS,
      );
      active.on('login-ok', ok);
      active.on('login-failed', failed);
    });
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const username = loginInput.value.trim();
      const password = passwordInput.value;
      if (!username || !password) {
        setStatus('введите логин и пароль', 'error');
        return;
      }

      submitButton.disabled = true;
      try {
        await send('login', username, password, rememberInput.checked);
        passwordInput.value = '';
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), 'error');
        writeLog(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
        submitButton.disabled = false;
      }
    })();
  });

  return {
    get client() {
      return client;
    },
    get inBattle() {
      return inBattle;
    },
    joinBattle: (battleId, team) => joinBattle(battleId, team ?? null),
    leaveBattle: leave,
    battleClosed: () => {
      if (!inBattle) return;
      inBattle = false;
      leaveButton.hidden = true;
      setStatus('бой закрыт сервером', 'ok');
      if (client) renderBattles(listBattles(client));
    },
    authenticate,
  };
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`нет элемента ${selector}`);
  return element;
}

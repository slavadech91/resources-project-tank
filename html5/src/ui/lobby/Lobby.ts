import {LobbyChat} from './LobbyChat.ts';
/**
 * Лобби поверх 3D: общий фон и разделы «Битвы» / «Гараж» (как LobbyLayoutModel оригинала).
 * Раздел показывается по пространству, которое открыл сервер (battle_select / garage); в бою лобби скрыто.
 * Пока раздел грузится (пространство, данные сервера, картинки, модель танка), он скрыт под экраном загрузки.
 * С server2 (`?s2`, attachS2) разделы строятся по данным S2Client, без пространств старого протокола.
 */

import './lobby.css';
import type { GameClient, UserInfo } from '../../net/client.ts';
import {
  GarageState,
  UserDirectory,
  createBattle,
  readBattleCreate,
  readBattleInfo,
  readBattles,
  readMaps,
  selectBattle,
  showBattleSelect,
  showGarage,
  type LobbyBattleInfo,
} from '../../net/lobby.ts';
import { BattleSelectView } from './BattleSelectView.ts';
import { GarageView } from './GarageView.ts';
import { el, loadLobbyAssets } from './widgets.ts';
import { LobbyLoader, waitForImages } from '../LobbyLoader.ts';
import { errorText, legacyUser, type S2Client } from '../../net2/S2Client.ts';
import { S2Garage } from '../../net2/S2Garage.ts';

/** данные раздела приходят пачками объектов и команд: раздел считается полученным после такой паузы в них */
const DATA_QUIET_MS = 200;
const DATA_WAIT_MAX_MS = 3000;
const IMAGES_WAIT_MAX_MS = 8000;
const TANK_WAIT_MAX_MS = 15000;
/** сервер не открыл раздел — экран загрузки не висит вечно */
const SECTION_WAIT_MAX_MS = 15000;
const SECTION_CAPTION = { battles: 'Загрузка списка битв…', garage: 'Загрузка гаража…' } as const;

export type LobbySection = 'battles' | 'garage' | null;

export interface LobbyCallbacks {
  /** team: null — бой DM, иначе FIGHT_TEAM (0 красные, 1 синие); client null — бой server2 */
  onFight(client: GameClient | null, info: LobbyBattleInfo, team: number | null): void;
  onSection(section: LobbySection): void;
  /** данные игрока изменились в лобби (кристаллы после покупки) */
  onUser(user: UserInfo): void;
}

export class Lobby {
  readonly root: HTMLDivElement;
  private client: GameClient | null = null;
  private s2: S2Client | null = null;
  /** выбранный бой server2 (у старого сервера выбор хранит сервер) */
  private s2Selected: number | null = null;
  /** гараж server2: один на все сессии (окно гаража создаётся один раз) */
  private readonly s2Garage = new S2Garage();
  private lobbyChat:LobbyChat|null=null;
  private battleView: BattleSelectView | null = null;
  private garageView: GarageView | null = null;
  private garage: GarageState | null = null;
  private users: UserDirectory | null = null;
  private user: UserInfo | null = null;
  private section: LobbySection = null;
  private pending = 0;
  private readonly ready: Promise<void>;
  readonly loader: LobbyLoader;
  /** номер текущей загрузки раздела: устаревшая загрузка не трогает экран */
  private loadToken = 0;
  private lastData = 0;

  constructor(parent: HTMLElement, private readonly callbacks: LobbyCallbacks) {
    // как во Flash: до входа и вне боя под окнами — только фон (public/lobby/background.jpg), сцена боя не видна
    this.root = el('div', 'lb-root', parent);
    this.loader = new LobbyLoader(parent);
    // запуск страницы: интерфейс не показывается, пока не загружены картинки окон и шрифт
    this.loader.start('Загрузка интерфейса…', true);
    this.ready = loadLobbyAssets((fraction) => this.loader.progress(fraction)).then(() => this.loader.stop());
  }

  /** картинки окон и шрифт загружены (до этого окно входа не показывается) */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** вход принят: главное меню грузится под экраном загрузки до первого готового раздела */
  beginLoad(): void {
    const token = ++this.loadToken;
    this.loader.start('Загрузка главного меню…', true);
    this.loader.progress(0.3);
    this.watchdog(token);
  }

  /** Подключить клиента до логина: команды INIT_* и SET_UID приходят сразу после входа */
  attach(client: GameClient): void {
    this.client = client;
    this.users = new UserDirectory(client);
    this.garage = new GarageState(client);
    this.garage.onChange = () => this.schedule();
    client.on('user', (user) => {
      this.user = user;
      this.battleView?.setUserRank(user.rank);
      this.callbacks.onUser(user);
      this.schedule();
    });
    client.on('admin', (admin) => {
      this.battleView?.setCanCreate(admin);
      // администратору доступны и нереализованные пушки
      this.garageView?.refresh();
    });
    client.on('space', (space) => {
      if (space.name == 'lobby' || space.name == 'battle_select') client.requestAdminState();
      if (space.name == 'battle_select') void this.show('battles');
      else if (space.name == 'garage') void this.show('garage');
      else if (space.name.startsWith('battle_field')) this.hide();
    });
    const touch = (event: { spaceName: string }): void => {
      if (event.spaceName != 'battle_select' && event.spaceName != 'garage') return;
      this.lastData = performance.now();
      this.schedule();
    };
    client.on('objects', touch);
    client.on('unloaded', touch);
    client.on('command', touch);
  }

  /** server2: профиль и список боёв приходят от S2Client */
  attachS2(s2: S2Client): void {
    this.s2 = s2;
    this.lobbyChat?.connect(s2.connection);
    this.s2Garage.connect(s2.connection);
    this.s2Garage.onChange = () => {
      this.lastData = performance.now();
      this.schedule();
    };
    this.s2Garage.onError = (error) => window.alert(errorText(error));
    s2.onUser = (user) => {
      this.user = legacyUser(user);
      this.battleView?.setUserRank(user.rank);
      this.battleView?.setCanCreate(user.admin);
      this.callbacks.onUser(this.user);
      this.schedule();
    };
    s2.onBattles = () => {
      this.lastData = performance.now();
      this.schedule();
    };
    if (s2.user) s2.onUser(s2.user);
  }

  /** Кнопки «Битвы» / «Гараж» верхней панели */
  open(section: 'battles' | 'garage'): void {
    if (this.s2) {
      void this.show(section);
      return;
    }
    if (!this.client) return;
    const token = ++this.loadToken;
    this.loader.start(SECTION_CAPTION[section]);
    this.loader.progress(0.1);
    this.root.classList.add('lb-loading');
    this.watchdog(token);
    if (section == 'battles') showBattleSelect(this.client);
    else showGarage(this.client);
  }

  hide(): void {
    if(this.lobbyChat)this.lobbyChat.visible=false;
    // в бою свой экран загрузки (BattleLoader)
    this.loadToken++;
    this.loader.stop();
    this.root.classList.remove('lb-loading');
    this.root.hidden = true;
    if (this.garageView) this.garageView.visible = false;
    this.section = null;
    this.callbacks.onSection(null);
  }

  private async show(section: 'battles' | 'garage'): Promise<void> {
    await this.ready;
    if (!this.client && !this.s2) return;
    const token = ++this.loadToken;
    this.loader.start(SECTION_CAPTION[section]);
    this.loader.progress(0.4);
    this.root.classList.add('lb-loading');
    this.lastData = performance.now();
    this.watchdog(token);
    this.root.hidden = false;
    this.section = section;
    try {
      if (this.s2) {
        // гараж server2 приходит одним ответом — до построения окна
        if (section == 'garage' && !this.s2Garage.isLoaded) await this.s2Garage.load();
        if (token != this.loadToken) return;
        this.buildS2(section, this.s2);
      } else if (this.client) this.build(section, this.client);
    } catch (error) {
      // ошибка построения раздела не должна оставлять экран загрузки навсегда
      console.error('лобби: раздел не построен', error);
    }
    await this.settle(section, token);
  }

  private build(section: 'battles' | 'garage', client: GameClient): void {
    if (section == 'battles' && !this.battleView) {
      this.battleView = new BattleSelectView(this.root, {
        onSelect: (battle) => selectBattle(client, battle.objectId),
        onFight: (info, team) => this.callbacks.onFight(client, info, team),
        onCreate: (battle) => createBattle(client, battle),
        onDelete: (info) => client.sendChat(`/delbattle ${info.battleId}`),
        maps: () => readMaps(client),
        createLimits: () => readBattleCreate(client),
        uid: (id) => this.users?.uid(id) ?? `#${id}`,
        rank: (id) => this.users?.rank(id) ?? 1,
      });
      if (this.user) this.battleView.setUserRank(this.user.rank);
      this.battleView.setCanCreate(client.isAdmin);
    }
    if (section == 'garage' && !this.garageView && this.garage) {
      this.garageView = new GarageView(this.root, this.garage, {
        userName: () => this.user?.uid ?? '',
        userRank: () => this.user?.rank ?? 1,
        crystals: () => this.user?.crystals ?? 0,
        spend: (price) => client.spendCrystals(price),
        isAdmin: () => client.isAdmin,
      });
    }
    if (this.battleView) this.battleView.visible = section == 'battles';
    if (this.garageView) this.garageView.visible = section == 'garage';
    this.callbacks.onSection(section);
    this.refresh();
  }

  private buildS2(section: 'battles' | 'garage', s2: S2Client): void {
    this.lobbyChat??=new LobbyChat(this.root);
    this.lobbyChat.connect(s2.connection);
    this.lobbyChat.visible=true;
    const report = (error: unknown): void => window.alert(errorText(error));
    // окно живёт дольше сессии (повторный вход — новый S2Client): берём текущую
    const current = (): S2Client => this.s2 ?? s2;
    if(this.s2Selected==null&&s2.linkedBattleId!=null)this.s2Selected=s2.linkedBattleId;
    if (section == 'battles' && !this.battleView) {
      this.battleView = new BattleSelectView(this.root, {
        onSelect: (battle) => {
          this.s2Selected = battle.battleId;
          this.schedule();
        },
        onFight: (info, team) => this.callbacks.onFight(null, info, team),
        onCreate: (battle) => void current().createBattle(battle).catch(report),
        botsSupported:true,
        onDelete: (info) => void current().removeBattle(info.battleId).catch(report),
        maps: () => current().lobbyMaps(),
        createLimits: () => current().createLimits(),
        uid: (id) => current().userName(id),
        rank: (id) => current().userRank(id),
      });
      if (this.user) this.battleView.setUserRank(this.user.rank);
      this.battleView.setCanCreate(s2.isAdmin);
    }
    if (section == 'garage' && !this.garageView) {
      this.garageView = new GarageView(this.root, this.s2Garage, {
        userName: () => this.user?.uid ?? '',
        userRank: () => this.user?.rank ?? 1,
        crystals: () => this.user?.crystals ?? 0,
        // баланс после покупки присылает server2 (событие user)
        spend: () => undefined,
        isAdmin: () => current().isAdmin,
      });
    }
    if (this.battleView) this.battleView.visible = section == 'battles';
    if (this.garageView) this.garageView.visible = section == 'garage';
    this.callbacks.onSection(section);
    this.refresh();
  }

  /** раздел готов: данные сервера пришли, картинки и модель танка загружены — снять экран загрузки */
  private async settle(section: 'battles' | 'garage', token: number): Promise<void> {
    const started = performance.now();
    while (performance.now() - this.lastData < DATA_QUIET_MS && performance.now() - started < DATA_WAIT_MAX_MS) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (token != this.loadToken) return;
    try {
      // перерисовка по последним данным уже в DOM (schedule — кадром позже)
      this.refresh();
      this.loader.progress(0.6);
      await waitForImages(this.root, (fraction) => token == this.loadToken && this.loader.progress(0.6 + 0.3 * fraction), IMAGES_WAIT_MAX_MS);
      if (section == 'garage' && this.garageView) {
        await Promise.race([this.garageView.tankLoading, new Promise((resolve) => setTimeout(resolve, TANK_WAIT_MAX_MS))]);
      }
    } catch (error) {
      console.error('лобби: ошибка при загрузке раздела', error);
    } finally {
      this.finishLoad(token);
    }
  }

  private finishLoad(token: number): void {
    if (token != this.loadToken) return;
    this.loader.progress(1);
    this.loader.stop();
    // окна раскладываются по ширине текста: после загрузки (шрифт, картинки, показ) — заново, как при изменении окна
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    this.root.classList.remove('lb-loading');
  }

  private watchdog(token: number): void {
    setTimeout(() => this.finishLoad(token), SECTION_WAIT_MAX_MS);
  }

  /** перерисовка не чаще раза в кадр: объекты и команды приходят пачками */
  private schedule(): void {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.refresh();
    });
  }

  private refresh(): void {
    if (this.root.hidden || !this.section) return;
    if (this.s2) {
      if (this.section == 'battles' && this.battleView) {
        this.battleView.setBattles(this.s2.lobbyBattles());
        this.battleView.setInfo(this.s2.battleInfo(this.s2Selected));
      }
      if (this.section == 'garage' && this.garageView) this.garageView.refresh();
      return;
    }
    const client = this.client;
    if (!client) return;
    if (this.section == 'battles' && this.battleView && client.getSpace('battle_select')) {
      this.battleView.setBattles(readBattles(client));
      this.battleView.setInfo(readBattleInfo(client));
    }
    if (this.section == 'garage' && this.garageView && client.getSpace('garage')) this.garageView.refresh();
  }
}

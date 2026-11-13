import {TeamBattleRoster} from './TeamBattleRoster.ts';
/**
 * Раздел «Битвы»: BattleListView (средняя треть экрана) и BattleInfoDMView / BattleInfoParamsView (правая треть).
 * Левая треть — LobbyChat (общий чат server2).
 */

import { BATTLE_MODE, type BattleCreateLimits, type LobbyBattle, type LobbyBattleInfo, type LobbyMap, type NewBattle, type BattleUser } from '../../net/lobby.ts';
import { BigButton, DefaultButton, HEADER, INNER, RES, TankWindow, UI, WindowInner, bitmap, el, label, place, sprite } from './widgets.ts';
import { BattleCreateView } from './BattleCreateView.ts';
import { FIGHT_TEAM } from '../../net/battle-entry.ts';
import { themed } from '../theme.ts';
import { glassIcon } from '../glassIcons.ts';

/** BattleListView: MIN_FLASH_WIDTH, MIN_FLASH_HEIGHT, HEADER_HEIGHT */
export const MIN_FLASH_WIDTH = 970;
export const MIN_FLASH_HEIGHT = 530;
export const HEADER_HEIGHT = 60;
const ROW_HEIGHT = 20;
/** fl.controls.CellRenderer: иконка строки с отступом textPadding */
const ROW_ICON_X = 5;

/** цвета строк BattleListView.myIcon */
const COLOR = {
  get NORMAL(): string {
    return themed('#59ff32'); // 5898034
  },
  get SELECTED(): string {
    return themed('#0c220d'); // TankWindowInner.GREEN
  },
  OFF: '#b1b1b1', // 11645361
  OFF_SELECTED: '#585858', // 5789784
  SUSPICIOUS: '#ffc000',
  FULL: '#868686', // 8816262
};

/** BattleInfoIcons: кадры */
const ICON = { TIME_LIMIT: 1, KILL_LIMIT: 2, FRIENDLY_FIRE: 3, AUTO_BALANCE: 4, CTF: 7, PAYD: 8, INVENTORY_BONUS: 9, TEAM_SCORE: 10, UPGRADES: 12, PRO_BATTLE: 13, CRYSTAL_BONUS: 14 };

export interface BattleSelectCallbacks {
  botsSupported?:boolean;
  onSelect(battle: LobbyBattle): void;
  /** team: null — DM, иначе FIGHT_TEAM (0 красные, 1 синие) */
  onFight(info: LobbyBattleInfo, team: number | null): void;
  onCreate(battle: NewBattle): void;
  /** администратор удаляет бой (/delbattle) */
  onDelete(info: LobbyBattleInfo): void;
  maps(): LobbyMap[];
  createLimits(): BattleCreateLimits | null;
  uid(userId: number): string;
  rank(userId: number): number;
}

function threeSlice(parent: HTMLElement, base: string, className = 'lb-row-bg'): HTMLDivElement {
  const holder = el('div', className, parent);
  for (const part of ['LEFT', 'CENTER', 'RIGHT']) {
    const piece = el('div', '', holder);
    piece.style.backgroundImage = `url(${UI()}/${base}_${part}.png)`;
    if (part != 'CENTER') piece.style.width = part == 'LEFT' ? '5px' : '5px';
  }
  return holder;
}

/** Abris (кадры 1–6): рамка с числом игроков */
function abris(parent: HTMLElement, frame: number, x: number): void {
  sprite(parent, 'Abris', frame, x, 1);
}

export class BattleSelectView {
  readonly root: HTMLDivElement;
  // BattleListView
  private readonly listWindow: TankWindow;
  private readonly listInner: WindowInner;
  private readonly list: HTMLDivElement;
  private readonly createButton: DefaultButton;
  private canCreate = false;
  private readonly modeBoxes: { mode: number; node: HTMLDivElement; icon: HTMLImageElement; pressed: boolean }[] = [];
  // BattleInfoDMView
  private readonly infoWindow: TankWindow;
  private readonly infoPanel: HTMLDivElement;
  private readonly infoFrame: WindowInner;
  private readonly preview: HTMLDivElement;
  private readonly previewImage: HTMLImageElement;
  private readonly nameLabel: HTMLDivElement;
  private readonly iconBar: HTMLDivElement;
  private readonly rankBar: HTMLDivElement;
  private readonly urlField: HTMLDivElement;
  private readonly urlText: HTMLDivElement;
  private readonly copyButton: DefaultButton;
  private readonly usersInner: WindowInner;
  private readonly teamRoster:TeamBattleRoster;
  private readonly users: HTMLDivElement;
  private readonly fightButton: BigButton;
  // BattleInfoTeamView: «За красных» / «За синих»
  private readonly fightRed: BigButton;
  private readonly fightBlue: BigButton;
  /** «Удалить бой» — только администратору */
  private readonly deleteButton: DefaultButton;
  private timeLabel: HTMLDivElement | null = null;
  // BattleCreateView: на месте окна информации о бое
  private readonly createView: BattleCreateView;
  private creating = false;

  private battles: LobbyBattle[] = [];
  private selectedId: number | null = null;
  private info: LobbyBattleInfo | null = null;
  private userRank = 1;
  private timeEnd = 0;
  private timer = 0;
  private timerObjectId = -1;
  private infoWidth = 0;
  private infoHeight = 0;

  constructor(parent: HTMLElement, private readonly callbacks: BattleSelectCallbacks) {
    this.root = el('div', 'lb-panel lb-battle-panel', parent);
    this.root.style.inset = '0';

    this.listWindow = new TankWindow(this.root, HEADER.CURRENT_BATTLES);
    this.listInner = new WindowInner(this.listWindow.root, INNER.GREEN, true);
    this.list = el('div', 'lb-list', this.listWindow.root);
    this.createButton = new DefaultButton(this.listWindow.root, 'Создать');
    this.createButton.onClick = () => this.setCreating(true);
    this.createButton.setEnabled(false);
    for (const [mode, icon] of [
      [BATTLE_MODE.DM, 'dm'],
      [BATTLE_MODE.TDM, 'tdm'],
      [BATTLE_MODE.CTF, 'ctf'],
      [BATTLE_MODE.CP, 'cp'],
    ] as const) {
      // BattleModeCheckBox: состояния 30×30 и значок режима по центру
      const node = el('div', 'lb-abs lb-modebox', this.listWindow.root);
      node.style.width = node.style.height = '30px';
      node.style.cursor = 'pointer';
      const state = bitmap(node, 'BattleModeCheckBox_normalStateClass.png');
      state.classList.add('lb-modebox-state');
      const image = bitmap(node, `BattleModeIcons_${icon}IconClass.png`);
      image.classList.add('lb-modebox-image');
      el('div', 'lb-modebox-icon', node).innerHTML = glassIcon(icon);
      image.onload = () => place(image, (30 - image.naturalWidth) / 2, (30 - image.naturalHeight) / 2 + (box.pressed ? 1 : 0));
      const box = { mode, node, icon: state, pressed: false };
      node.addEventListener('mouseenter', () => !box.pressed && (state.src = `${UI()}/BattleModeCheckBox_overStateClass.png`));
      node.addEventListener('mouseleave', () => !box.pressed && (state.src = `${UI()}/BattleModeCheckBox_normalStateClass.png`));
      node.addEventListener('click', () => {
        box.pressed = !box.pressed;
        node.classList.toggle('lb-pressed', box.pressed);
        state.src = `${UI()}/BattleModeCheckBox_${box.pressed ? 'pressed' : 'normal'}StateClass.png`;
        place(image, (30 - image.naturalWidth) / 2, (30 - image.naturalHeight) / 2 + (box.pressed ? 1 : 0));
        this.renderList();
      });
      this.modeBoxes.push(box);
    }

    this.infoWindow = new TankWindow(this.root, HEADER.BATTLE_INFO);
    this.infoPanel = el('div', 'lb-abs', this.infoWindow.root);
    this.preview = el('div', 'lb-abs', this.infoPanel);
    this.preview.style.overflow = 'hidden';
    this.previewImage = el('img', 'lb-abs', this.preview);
    this.previewImage.draggable = false;
    this.infoFrame = new WindowInner(this.infoPanel, INNER.TRANSPARENT);
    this.nameLabel = label(this.infoPanel, '', 'lb-info-name');
    this.nameLabel.style.font = "18px/25px 'MyriadPro', Arial, sans-serif";
    this.nameLabel.style.textShadow = '0 0 3px #000, 0 0 3px #000, 0 0 3px #000';
    this.nameLabel.style.overflow = 'hidden';
    this.iconBar = el('div', 'lb-abs', this.infoPanel);
    this.iconBar.style.filter = 'drop-shadow(0 0 2px #000) drop-shadow(0 0 2px #000)';
    this.rankBar = el('div', 'lb-abs', this.infoPanel);
    this.urlField = el('div', 'lb-input', this.infoPanel);
    for (const part of ['InputLeft', 'InputCenter', 'InputRight']) el('div', '', this.urlField).style.backgroundImage = `url(${UI()}/${part}.png)`;
    (this.urlField.children[0] as HTMLElement).style.width = '5px';
    (this.urlField.children[2] as HTMLElement).style.width = '5px';
    this.urlText = label(this.urlField, '');
    this.urlText.style.userSelect = 'text';
    this.copyButton = new DefaultButton(this.infoPanel, 'Скопировать ссылку');
    this.copyButton.onClick = () => {
      const url=new URL(window.location.href);url.hash=this.urlText.textContent??'';
      const fallback=()=>{const field=document.createElement('textarea');field.value=url.href;field.style.position='fixed';field.style.opacity='0';document.body.appendChild(field);field.select();document.execCommand('copy');field.remove();};
      if(navigator.clipboard)void navigator.clipboard.writeText(url.href).catch(fallback);else fallback();
    };
    this.teamRoster=new TeamBattleRoster(this.infoWindow.root);this.teamRoster.visible=false;
    this.usersInner = new WindowInner(this.infoWindow.root, INNER.GREEN, true);
    this.users = el('div', 'lb-list', this.infoWindow.root);
    this.fightButton = new BigButton(this.infoWindow.root, 'Играть');
    this.fightButton.setIcon('play_icons_ALL.png');
    this.fightButton.onClick = () => this.info && this.callbacks.onFight(this.info, null);
    this.fightRed = new BigButton(this.infoWindow.root, 'Играть');
    this.fightRed.setIcon('/battle/team_info/play_red.png');
    this.fightRed.onClick = () => this.info && this.callbacks.onFight(this.info, FIGHT_TEAM.RED);
    this.fightBlue = new BigButton(this.infoWindow.root, 'Играть');
    this.fightBlue.setIcon('/battle/team_info/play_blue.png');
    this.fightBlue.onClick = () => this.info && this.callbacks.onFight(this.info, FIGHT_TEAM.BLUE);
    this.deleteButton = new DefaultButton(this.infoWindow.root, 'Удалить бой');
    this.deleteButton.onClick = () => {
      const info = this.info;
      if (info && window.confirm(`Удалить бой #${info.battleId} «${info.name}»? Игроки в нём вернутся в список боёв.`)) this.callbacks.onDelete(info);
    };
    this.deleteButton.root.style.display = 'none';
    this.infoWindow.root.style.visibility = 'hidden';

    this.createView = new BattleCreateView(this.root, {
      onCreate: (battle) => {
        this.callbacks.onCreate(battle);
        // сервер добавит бой в список и сам выберет его (BattleSelectModel.showBattle) — покажется информация о нём
        this.setCreating(false);
      },
      onCancel: () => this.setCreating(false),
    });
    this.createView.visible = false;

    window.addEventListener('resize', this.layout);
    this.layout();
  }

  set visible(value: boolean) {
    this.root.style.display = value ? '' : 'none';
    if (value) this.layout();else this.createView.closeMenus();
  }

  /** создавать бои пока могут только администраторы (ADMIN_STATE сервера); сервер проверяет это сам */
  setCanCreate(value: boolean): void {
    this.canCreate = value;
    this.createView.setBotsEnabled(value&&!!this.callbacks.botsSupported);
    if (!value && this.creating) this.setCreating(false);
    this.createButton.setEnabled(value && !this.creating);
    this.createButton.root.title = value ? '' : 'Создавать бои могут только администраторы';
    this.deleteButton.root.style.display = value ? '' : 'none';
    this.layout();
  }

  setUserRank(rank: number): void {
    this.userRank = rank;
    this.createView.setUserRank(rank);
    this.renderList();
  }

  private setCreating(value: boolean): void {
    this.creating = value;
    if (value) this.createView.reset(this.callbacks.maps(), this.callbacks.createLimits());
    this.createView.visible = value;
    this.createButton.setEnabled(!value && this.canCreate);
    this.infoWindow.root.style.visibility = !value && this.info ? '' : 'hidden';
  }

  setBattles(battles: LobbyBattle[]): void {
    this.battles = battles;
    if (this.selectedId != null && !battles.some((battle) => battle.objectId == this.selectedId)) this.selectedId = null;
    this.renderList();
    // как BattleListController: если ничего не выбрано — выбрать первый доступный бой
    if (this.selectedId == null) {
      const first = this.sorted().find((battle) => this.accessible(battle));
      if (first) this.select(first);
    }
  }

  setInfo(info: LobbyBattleInfo | null): void {
    this.info = info;
    this.infoWindow.root.style.visibility = info && !this.creating ? '' : 'hidden';
    if (!info) return;
    this.nameLabel.textContent = info.name+(info.proBattle&&info.mode!==BATTLE_MODE.DM?' ★':'');
    this.nameLabel.style.font=info.mode===BATTLE_MODE.DM?"18px/25px 'MyriadPro',Arial,sans-serif":"bold 16px/23px 'MyriadPro',Arial,sans-serif";
    this.previewImage.src = `${RES}/${info.previewId}.png`;
    this.urlText.textContent = `#/battle/${info.battleId.toString(16).padStart(16, '0')}`;
    this.renderIcons(info);
    this.renderRanks(info);
    this.renderUsers(info);
    const team = info.mode != BATTLE_MODE.DM;
    this.teamRoster.visible=team;this.usersInner.root.hidden=team;this.users.hidden=team;
    this.copyButton.caption=team?'Копировать':'Скопировать ссылку';
    this.fightButton.root.style.display = team ? 'none' : '';
    this.fightRed.root.style.display = this.fightBlue.root.style.display = team ? '' : 'none';
    this.fightButton.setEnabled(!team && info.users.length < info.maxPeople);
    this.fightRed.setEnabled(team && info.reds.length < info.maxPeople);
    this.fightBlue.setEnabled(team && info.blues.length < info.maxPeople);
    // BattleInfoDMController: отсчёт времени заново только при смене объекта информации о бое
    if (info.objectId != this.timerObjectId) {
      this.timerObjectId = info.objectId;
      window.clearInterval(this.timer);
      this.timeEnd = performance.now() + info.timeLeft * 1000;
      if (info.timeLimit > 0) this.timer = window.setInterval(() => this.updateTime(), 500);
    }
    this.updateTime();
    this.layout();
  }

  private accessible(battle: LobbyBattle): boolean {
    return this.userRank >= battle.rankMin && this.userRank <= battle.rankMax;
  }

  /** BattleListView.sortBattleList: подозрительные, доступные, с друзьями, затем новые сверху */
  private sorted(): LobbyBattle[] {
    const pressed = this.modeBoxes.filter((box) => box.pressed).map((box) => box.mode);
    return this.battles
      .filter((battle) => pressed.length == 0 || pressed.includes(battle.mode))
      .sort(
        (a, b) =>
          Number(b.suspicious) - Number(a.suspicious) ||
          Number(this.accessible(b)) - Number(this.accessible(a)) ||
          b.battleId - a.battleId,
      );
  }

  private select(battle: LobbyBattle): void {
    if (this.selectedId == battle.objectId) return;
    this.selectedId = battle.objectId;
    this.renderList();
    this.callbacks.onSelect(battle);
  }

  private renderList(): void {
    this.list.textContent = '';
    const width = this.list.clientWidth || parseInt(this.list.style.width || '300', 10);
    const scrolled = this.battles.length * ROW_HEIGHT > this.list.clientHeight;
    const iconWidth = width - (scrolled ? 32 : 20);
    for (const battle of this.sorted()) {
      const selected = battle.objectId == this.selectedId;
      const open = this.accessible(battle);
      const row = el('div', 'lb-row', this.list);
      const skin = open ? (selected ? 'cell_normal_SELECTED' : 'cell_normal_UP') : selected ? 'cell_off_SELECTED' : 'cell_off_UP';
      threeSlice(row, skin);
      row.addEventListener('click', () => this.select(battle));
      const icon = el('div', 'lb-abs', row);
      place(icon, ROW_ICON_X, 1, iconWidth, 18);
      const nameColor = battle.suspicious ? COLOR.SUSPICIOUS : selected ? (open ? COLOR.SELECTED : COLOR.OFF_SELECTED) : open ? COLOR.NORMAL : COLOR.OFF;
      const color = selected ? (open ? COLOR.SELECTED : COLOR.OFF_SELECTED) : open ? COLOR.NORMAL : COLOR.OFF;
      const half = Math.trunc(iconWidth * 0.55);
      if (battle.proBattle) sprite(icon, 'SportBattleItemIcon', selected ? (open ? 2 : 4) : open ? 1 : 3, -2, 3);
      const name = label(icon, battle.name);
      place(name, 8, -1, half - 6, 18);
      name.style.color = nameColor;
      const map = label(icon, battle.mapName);
      map.style.color = color;
      // x = iconWidth − textWidth + 2: правый край на 2 px за шириной значка
      map.style.right = '-2px';
      map.style.top = '-1px';
      if (battle.mode == BATTLE_MODE.DM) {
        const full = battle.all == battle.maxPeople;
        abris(icon, full ? 1 : 2, half);
        const count = label(icon, String(battle.all));
        place(count, Math.trunc(half - 0.5), -1, 52, 16);
        count.style.textAlign = 'center';
        count.style.color = full ? COLOR.FULL : '#fff';
      } else {
        const redFull = battle.reds == battle.maxPeople;
        const blueFull = battle.blues == battle.maxPeople;
        abris(icon, redFull ? 3 : 5, half);
        abris(icon, blueFull ? 4 : 6, half + 27);
        const reds = label(icon, String(battle.reds));
        place(reds, Math.trunc(half - 0.5), -1, 27, 16);
        reds.style.textAlign = 'center';
        reds.style.color = redFull ? COLOR.FULL : '#fff';
        const blues = label(icon, String(battle.blues));
        place(blues, Math.trunc(half + 26.5), -1, 25, 16);
        blues.style.textAlign = 'center';
        blues.style.color = blueFull ? COLOR.FULL : '#fff';
      }
    }
  }

  /** BattleInfoParamsView.setUp: значки лимитов и настроек боя (выключенные — полупрозрачные) */
  private renderIcons(info: LobbyBattleInfo): void {
    if(info.mode!==BATTLE_MODE.DM){this.renderTeamIcons(info);return;}
    this.iconBar.textContent = '';
    this.timeLabel = null;
    let x = 0;
    const add = (frame: number, enabled: boolean): HTMLDivElement => {
      const holder = el('div', 'lb-abs', this.iconBar);
      if (x > 0) x += 9; // ICON_VERTICAL_MARGIN
      place(holder, x, 0);
      sprite(holder, 'BattleInfoIcons', frame, 0, 0);
      holder.style.opacity = enabled ? '1' : '0.5';
      x += 18;
      return holder;
    };
    if (info.timeLimit > 0) {
      add(ICON.TIME_LIMIT, true);
      this.timeLabel = label(this.iconBar, '');
      this.timeLabel.style.font = "14px/20px 'MyriadPro', Arial, sans-serif";
      place(this.timeLabel, 18, -2, 50, 20);
      x = 18 + 32;
    }
    const modeIcon = ICON.KILL_LIMIT;
    const mode = add(modeIcon, true);
    if (info.scoreLimit > 0) {
      const limit = label(this.iconBar, String(info.scoreLimit));
      limit.style.font = "14px/20px 'MyriadPro', Arial, sans-serif";
      place(limit, parseInt(mode.style.left, 10) + 16, -2);
      x += 6 + 8 * String(info.scoreLimit).length;
    }
    add(ICON.PRO_BATTLE, info.proBattle);
    add(ICON.INVENTORY_BONUS, !info.withoutBonuses);
    add(ICON.CRYSTAL_BONUS, !info.withoutCrystals);
    add(ICON.PAYD, !info.withoutSupplies);
    add(ICON.UPGRADES, !info.withoutUpgrades);
    if (info.mode != BATTLE_MODE.DM) {
      add(ICON.AUTO_BALANCE, info.autoBalance);
      add(ICON.FRIENDLY_FIRE, info.friendlyFire);
    }
  }

  private renderTeamIcons(info:LobbyBattleInfo):void {
    this.iconBar.replaceChildren();this.timeLabel=null;
    const text=(value:string,x:number)=>{const node=label(this.iconBar,value);node.style.font="14px/20px 'MyriadPro',Arial,sans-serif";place(node,x,-2);return node;};
    text(String(info.maxPeople*2),0);
    let x=28;
    if(info.timeLimit>0){sprite(this.iconBar,'BattleInfoIcons',ICON.TIME_LIMIT,x,0);this.timeLabel=text('',x+19);x+=72;}
    sprite(this.iconBar,'BattleInfoIcons',info.mode===BATTLE_MODE.CTF?ICON.CTF:ICON.KILL_LIMIT,x,0);text(String(info.scoreLimit),x+19);
    const flags:[[number,boolean],...Array<[number,boolean]>]=[[ICON.INVENTORY_BONUS,!info.withoutBonuses],[ICON.CRYSTAL_BONUS,!info.withoutCrystals],[ICON.AUTO_BALANCE,info.autoBalance],[ICON.FRIENDLY_FIRE,info.friendlyFire],[ICON.PAYD,!info.withoutSupplies],[ICON.UPGRADES,!info.withoutUpgrades]];
    flags.forEach(([icon,on],index)=>{const holder=el('div','lb-abs',this.iconBar);place(holder,index*27,27);sprite(holder,'BattleInfoIcons',icon,0,0);holder.style.opacity=on?'1':'.5';});
  }

  /** rangBar: значки званий от максимального к минимальному справа налево, по 15 px */
  private renderRanks(info: LobbyBattleInfo): void {
    this.rankBar.textContent = '';
    if (info.rankMin == 0 || info.rankMax == 0) return;
    let column = 0;
    let row = 0;
    for (let rank = info.rankMax; rank >= info.rankMin; rank--) {
      sprite(this.rankBar, 'RangIconSmall', rank, column * 15, row * 16);
      column--;
      if (column < -15) {
        row--;
        column = 0;
      }
    }
  }

  /** TeamListRenderer: игроки (звание, ник, убийства) и пустые места «Пусто» */
  private renderUsers(info: LobbyBattleInfo): void {
    this.users.textContent = '';
    if (info.mode == BATTLE_MODE.DM) {
      this.renderUserList(this.users, info.users, info.maxPeople, null);
      return;
    }
    this.teamRoster.set(info,this.callbacks.uid,this.callbacks.rank);
  }

  private renderUserList(parent: HTMLElement, users: BattleUser[], maxPeople: number, color: string | null): void {
    const list: (BattleUser | null)[] = [...users];
    while (list.length < maxPeople) list.push(null);
    for (const user of list) {
      const row = el('div', 'lb-row', parent);
      if (color) row.style.boxShadow = `inset 3px 0 0 ${color}`;
      row.style.cursor = 'default';
      threeSlice(row, 'cell_normal_UP');
      if (user) {
        const rank = sprite(row, 'RangIconSmall', this.callbacks.rank(user.userId), 5, 3);
        rank.style.filter = 'none';
        const name = label(row, this.callbacks.uid(user.userId));
        place(name, 22, 1);
        name.style.color = user.suspicious ? COLOR.SUSPICIOUS : '#fff';
        const kills = label(row, String(user.kills));
        kills.style.right = '19px';
        kills.style.top = '1px';
      } else {
        const empty = label(row, 'Пусто');
        place(empty, 15, 1);
        empty.style.opacity = '0.5';
      }
    }
  }

  private updateTime(): void {
    if (!this.timeLabel || !this.info) return;
    const left = Math.max(0, Math.round((this.timeEnd - performance.now()) / 1000));
    this.timeLabel.textContent = `${Math.trunc(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  /** BattleListView.resize и BattleInfoDMView.resize */
  readonly layout = (): void => {
    const third = Math.trunc(Math.max(MIN_FLASH_WIDTH, window.innerWidth) / 3);
    const height = Math.max(window.innerHeight - HEADER_HEIGHT, MIN_FLASH_HEIGHT);

    this.listWindow.setBounds(third, HEADER_HEIGHT, third, height);
    const innerWidth = third - 22;
    const innerHeight = height - 58;
    this.listInner.setBounds(11, 11, innerWidth, innerHeight);
    place(this.list, 15, 15, innerWidth - 4, innerHeight - 8);
    let x = 11;
    for (const box of this.modeBoxes) {
      place(box.node, x, height - 42);
      x += 30 + 5;
    }
    this.createButton.setBounds(third - 96 - 11, height - 42, 96);

    this.infoWindow.setBounds(third * 2, HEADER_HEIGHT, third, height);
    this.infoWidth = third - 22;
    this.infoHeight = Math.trunc(height * 0.4);
    this.layoutInfoPanel();
    const usersTop = this.infoHeight + 14;
    // у администратора под списком игроков — кнопка «Удалить бой»
    const usersHeight = height - this.infoHeight - 80 - (this.canCreate ? 38 : 0);
    this.usersInner.setBounds(11, usersTop, third - 22, usersHeight);
    place(this.users, 15, usersTop + 4, third - 22 - 4, usersHeight - 8);
    this.fightButton.setBounds(third - 130 - 11, height - 61, 130);
    this.teamRoster.layout(third,height,this.infoHeight,this.canCreate?38:0);
    const half = Math.min(130,Math.floor((third-110)/2));
    this.fightRed.setBounds(11, height - 61, half);
    this.fightBlue.setBounds(third - 11 - half, height - 61, half);
    this.deleteButton.setBounds(11, height - 61 - 38, 120);
    this.createView.setBounds(third * 2, HEADER_HEIGHT, third, height);
    this.renderList();
  };

  /** BattleInfoParamsView: set width / set height */
  private layoutInfoPanel(): void {
    const width = this.infoWidth;
    const height = this.infoHeight;
    place(this.infoPanel, 11, 11, width, height);
    const copyWidth = this.info?.mode!==BATTLE_MODE.DM?80:'Скопировать ссылку'.length * 7;
    const frameHeight = height - 30 - 3;
    this.infoFrame.setBounds(0, 0, width, frameHeight);
    // превью 750×500 обрезано по центру: rect.x = 375 − w/2, rect.y = 250 − h/2
    place(this.preview, 1, 1, width - 2, frameHeight - 2);
    place(this.previewImage, -Math.trunc(375 - width / 2), -Math.trunc(250 - height / 2));
    place(this.nameLabel, 10, 10, width - 20, 25);
    place(this.iconBar, 12, 40);
    place(this.rankBar, width - 23, frameHeight - 23);
    place(this.urlField, 0, height - 30, width - copyWidth - 3, 30);
    this.copyButton.setBounds(width - copyWidth, height - 30, copyWidth);
  }
}

import {TeamScore} from './TeamScore.ts';
import type {BattleMode,CtfFlag} from '../../net2/protocol.ts';
// HUD оригинала в DOM: верхняя панель (controls.panel.Indicators + MainPanel*Button), слоты инвентаря
// (InventoryModel), фонд/таймер/счёт (FundAndLimits, TimeLimitField, PlayerScoreField, режим DM) и FPSText.
// Картинки: tools/extract_hud_assets.py -> public/battle/hud.
import './hud.css';
import { GLASS_UI_EVENT, hudBase, isGlassUi } from '../theme.ts';
import { glassIcon, type GlassIconName } from '../glassIcons.ts';

// поднимать при изменении tools/extract_hud_assets.py, иначе браузер отдаст старые картинки из кеша
const ASSET_VERSION = '3';

/** опыт начала каждого звания (src/scripts/client/ranks.py, звания 2014 года) */
const RANK_SCORES = [0, 100, 500, 1500, 3700, 7100, 12300, 20000, 29000, 41000, 57000, 76000, 98000, 125000, 156000, 192000, 233000, 280000,
  332000, 390000, 455000, 527000, 606000, 692000, 787000, 889000, 1000000, 1122000, 1255000, 1400000];

const RANK_NAMES = [
  'Новобранец', 'Рядовой', 'Ефрейтор', 'Капрал', 'Мастер-капрал', 'Сержант', 'Штаб-сержант', 'Мастер-сержант', 'Первый сержант', 'Сержант-майор',
  'Уорент-офицер 1', 'Уорент-офицер 2', 'Уорент-офицер 3', 'Уорент-офицер 4', 'Уорент-офицер 5', 'Третий лейтенант', 'Второй лейтенант',
  'Первый лейтенант', 'Капитан', 'Майор', 'Подполковник', 'Полковник', 'Бригадир', 'Генерал-майор', 'Генерал-лейтенант', 'Генерал', 'Маршал',
  'Фельдмаршал', 'Командор', 'Генералиссимус',
];

/** Кадры BattleInfoIcons */
const BattleIcon = { TIME_LIMIT: 1, KILL_LIMIT: 2, MONEY: 5 };

/** Money.numToString: тысячи через пробел */
function formatNumber(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  parent?.appendChild(created);
  return created;
}

function label(parent: HTMLElement, text = ''): HTMLDivElement {
  const result = element('div', 'hud-label', parent);
  result.textContent = text;
  return result;
}

function image(parent: HTMLElement, src: string, width?: number, height?: number): HTMLImageElement {
  const result = document.createElement('img');
  result.src = `${hudBase()}/${src}?v=${ASSET_VERSION}`;
  result.draggable = false;
  if (width) result.width = width;
  if (height) result.height = height;
  parent.appendChild(result);
  return result;
}

function place(node: HTMLElement, x: number, y: number): void {
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
}

export interface PlayerInfo {
  name: string;
  /** звание, с 1 */
  rank: number;
  score: number;
  nextRankScore: number;
  crystals: number;
  /** место в рейтинге, 0 — не показывать */
  place?: number;
  /** число у стрелки K/D */
  kd?: number;
}

export type HudButtonName = 'battles' | 'garage' | 'friends' | 'buy' | 'help' | 'config' | 'bug' | 'close' | 'missions';

export interface HudCallbacks {
  onSoundToggle?(muted: boolean): void;
  onButton?(name: HudButtonName): void;
  onInventoryPress?(index: number): void;
}

interface InventorySlotView {
  node: HTMLElement;
  icon: HTMLImageElement;
  cooldown: HTMLDivElement;
  count: HTMLDivElement;
  itemIndex: number;
  readiness: number;
  effectStatus: number | null;
  effect?: HTMLDivElement;
  flashLayer?: HTMLDivElement;
  flash?: Animation;
}

interface ButtonSpec {
  name: string;
  folder: string;
  /** векторная иконка современного интерфейса (ui/glassIcons.ts) */
  icon: GlassIconName;
  width: number;
  caption?: string;
  action: HudButtonName | 'sound';
}

const PANEL_BUTTONS = {
  missions: { name: 'missions', folder: 'btn_missions', icon: 'gear', width: 28, action: 'missions' },
  buy: { name: 'buy', folder: 'btn_account', icon: 'plus', width: 75, caption: 'Купить', action: 'buy' },
  referal: { name: 'referal', folder: 'btn_referal', icon: 'userPlus', width: 28, action: 'friends' },
  friends: { name: 'friends', folder: 'btn_friends', icon: 'users', width: 90, caption: 'Друзья', action: 'friends' },
  battles: { name: 'battles', folder: 'btn_battles', icon: 'swords', width: 90, caption: 'Битвы', action: 'battles' },
  garage: { name: 'garage', folder: 'btn_garage', icon: 'tank', width: 90, caption: 'Гараж', action: 'garage' },
  help: { name: 'help', folder: 'btn_help', icon: 'help', width: 28, action: 'help' },
  sound: { name: 'sound', folder: 'btn_sound', icon: 'sound', width: 28, action: 'sound' },
  config: { name: 'config', folder: 'btn_config', icon: 'gear', width: 28, action: 'config' },
  bug: { name: 'bug', folder: 'btn_bug', icon: 'bug', width: 28, action: 'bug' },
  close: { name: 'close', folder: 'btn_close', icon: 'close', width: 23, action: 'close' },
} satisfies Record<string, ButtonSpec>;

const CRYSTAL_PILL_WIDTH = 74;
/** на сколько таблетка кристаллов сдвинута влево от своего места в ряду */
const CRYSTAL_SHIFT = 5;
/** на сколько таблетка кристаллов длиннее вправо (число сдвигается вместе с ромбом) */
const CRYSTAL_EXTEND = 5;
/** одинаковый зазор между «Купить», «Друзья», «Битвы» и «Гараж» */
const BUTTON_GAP = 5;
/** на сколько рамка фонда/таймера короче расчёта оригинала (её левый край и рамка счёта остаются на местах) */
const FUND_FRAME_TRIM = 6;
/** на сколько рамка счёта короче, чем в расчёте оригинала (правая часть блока) */
const SCORE_FRAME_TRIM = 0;
/** современный интерфейс: все плашки и кнопки панели — с одинаковым зазором, без наложений; классика — как в оригинале */
const GLASS_GAP = 6;
const GLASS_ICON_GAP = 3;
/** плашка кристаллов: поле слева, число, зазор, ромб 9 px, поле справа */
const GLASS_PILL_PADDING = 8;
const GLASS_DIAMOND_GAP = 4;
const GLASS_DIAMOND_WIDTH = 9;
/** полоска опыта — линия внизу плашки ника, внутри рамки */
const GLASS_XP_INSET = 3;
const SLOT_COUNT = 5;
const SUPPLY_NAMES = ['Аптечка', 'Двойная защита', 'Двойной урон', 'Ускорение', 'Мина'];
const SUPPLY_ASSETS = 'battle/inventory-narukami';
const SUPPLY_FLASH = ['#badf1d', '#e3a463', '#ff6937', '#ffe713', '#00ddad'];
const ARCHIVE_MASK_SIZE = 40;
const ARCHIVE_MASK_POINTS = [[40, 0], [40, 40], [0, 40], [0, 0], [20, 0], [20, 20]];

/** CooldownIndicator.draw: the remaining sector is clipped against the square's edges. */
export function archiveCooldownClip(status: number): string {
  const angle = status * 2 * Math.PI;
  const edge = Math.floor((angle + Math.PI / 4) / (Math.PI / 2));
  const half = ARCHIVE_MASK_SIZE / 2;
  const tangent = Math.tan(angle);
  let point: number[];
  switch (edge) {
    case 1: point = [ARCHIVE_MASK_SIZE, half * (1 - 1 / tangent)]; break;
    case 2: point = [half * (1 - tangent), ARCHIVE_MASK_SIZE]; break;
    case 3: point = [0, half * (1 + 1 / tangent)]; break;
    default: point = [half * (1 + tangent), 0];
  }
  const points = [point, ...ARCHIVE_MASK_POINTS.slice(edge)];
  return `polygon(${points.map(([x, y]) => `${Math.trunc(x)}px ${Math.trunc(y)}px`).join(',')})`;
}
const WINK_PERIOD_MS = 500;
const TIME_WINK_LIMIT_SEC = 30;
const FPS_FRAMES = 10;
const FRAME_HISTORY = 240;
const FRAME_GRAPH_HEIGHT = 36;
const FRAME_GRAPH_INTERVAL = 100;

interface PanelItem {
  node: HTMLElement;
  width: number;
  /** отступ до следующего элемента */
  gap: number;
}

export class BattleHud {
  private readonly root = element('div', 'hud-root');
  // верхняя панель
  private readonly top = element('div', 'hud-top', this.root);
  private readonly playerLabel: HTMLDivElement;
  private readonly ratingLabel: HTMLDivElement;
  private readonly kdLabel: HTMLDivElement;
  private readonly kdIcon: HTMLElement;
  private readonly crystalLabel: HTMLDivElement;
  private readonly rankIcon: HTMLImageElement;
  private readonly xpBar: HTMLDivElement;
  /** прибавка опыта: ярко подсвечивается и гаснет */
  private readonly xpGain: HTMLDivElement;
  private gainFrom = 0;
  private gainTo = 0;
  private lastRank = 0;
  private lastScore = -1;
  private readonly nameIndicator: HTMLDivElement;
  private leftItems: PanelItem[] = [];
  private rightItems: PanelItem[] = [];
  // фонд и лимиты
  private readonly field = element('div', 'hud-field', this.root);
  private readonly fundIcon: HTMLDivElement;
  private readonly fundText: HTMLDivElement;
  private readonly diamond: HTMLImageElement;
  private readonly timeField: HTMLDivElement;
  private readonly timeText: HTMLDivElement;
  private readonly scoreField = element('div', 'hud-field', this.root);
  private teamMode:BattleMode='dm';
  private teamIndicator:TeamScore;
  private readonly scoreText: HTMLDivElement;
  private readonly fps = element('div', 'hud-fps', this.root);
  private readonly fpsValue: HTMLDivElement;
  private readonly frameGraph = element('div', 'hud-frame-graph', this.fps);
  private readonly framePeak = element('div', 'hud-frame-peak', this.frameGraph);
  private readonly frameCanvas = document.createElement('canvas');
  private readonly frameContext = this.frameCanvas.getContext('2d');
  private readonly frameTimes = new Float32Array(FRAME_HISTORY);
  private frameTimeIndex = 0;
  private frameTimeCount = 0;
  private previousFrame = 0;
  private lastGraphUpdate = 0;
  private readonly inventory = element('div', 'hud-inventory', this.root);
  private readonly slots: InventorySlotView[] = [];
  private muted = false;
  private progress = 0;
  private timeLimit = 0;
  private timeEnd = 0;
  private fpsFrames = 0;
  private fpsStart = performance.now();
  private winkTimer = 0;
  private fpsVisible = true;
  private battleWidgets = true;
  private activeButton: HudButtonName | null = null;
  private activeClickable = false;
  private readonly buttonRefresh: [HudButtonName, (active: boolean) => void][] = [];

  constructor(
    parent: HTMLElement,
    private readonly callbacks: HudCallbacks = {},
    private readonly archiveInventory = false,
  ) {
    parent.appendChild(this.root);
    this.root.id = 'hud-battle';

    // --- Indicators: таблетка с именем (растягивается), таблетка кристаллов
    this.rankIcon = image(this.top, 'rank_normal/1.png');
    this.rankIcon.classList.add('abs');
    const nameIndicator = element('div', 'hud-ind', this.top);
    this.nameIndicator = nameIndicator;
    element('div', 'hud-pill hud-pill-name', nameIndicator);
    this.xpBar = element('div', 'hud-xp', nameIndicator);
    this.xpGain = element('div', 'hud-xp-gain', nameIndicator);
    this.playerLabel = label(nameIndicator);
    place(this.playerLabel, 9, 5);
    this.ratingLabel = label(nameIndicator);
    // kdicon: серые стрелки вверх/вниз (в SWF значок вырезан из таблетки красной стрелкой, рисуем сами)
    this.kdIcon = element('div', 'abs', nameIndicator);
    this.kdIcon.innerHTML =
      '<svg width="9" height="10" viewBox="0 0 9 10"><g fill="none" stroke="#c8c8c8" stroke-width="1.2"><path d="M8 4V2.5H2.5"/><path d="M1 8V7.5h5.5"/></g><g fill="#c8c8c8"><path d="M0 2.5 3 0v5z"/><path d="M9 7.5 6 5v5z"/></g></svg>';
    this.kdIcon.style.display = 'flex';
    this.kdLabel = label(nameIndicator, '0');
    this.kdLabel.style.color = '#c8c8c8';

    const crystalIndicator = element('div', 'hud-ind', this.top);
    crystalIndicator.style.width = `${CRYSTAL_PILL_WIDTH + CRYSTAL_EXTEND}px`;
    element('div', 'hud-pill hud-pill-crystal', crystalIndicator);
    // ромб кристалла впечатан в картинку таблетки; в современном интерфейсе таблетки нет — ромб отдельно
    image(crystalIndicator, 'diamond/1.png').classList.add('abs', 'hud-glass-diamond');
    this.crystalLabel = label(crystalIndicator, '0');
    this.crystalLabel.style.width = '59px';
    this.crystalLabel.style.textAlign = 'right';
    place(this.crystalLabel, CRYSTAL_PILL_WIDTH + CRYSTAL_EXTEND - 20 - 59, 5); // правый край числа за 5 px до ромба

    // --- Кнопки главной панели: слева направо после таблеток и справа налево от края
    this.leftItems = [
      { node: crystalIndicator, width: CRYSTAL_PILL_WIDTH, gap: 4 },
      { node: this.addButton(PANEL_BUTTONS.buy), width: 75, gap: BUTTON_GAP },
      { node: this.addButton(PANEL_BUTTONS.friends), width: 90, gap: BUTTON_GAP },
      { node: this.addButton(PANEL_BUTTONS.battles), width: 90, gap: BUTTON_GAP },
      { node: this.addButton(PANEL_BUTTONS.garage), width: 90, gap: 0 },
    ];
    this.rightItems = [
      ...(archiveInventory ? [PANEL_BUTTONS.missions] : []),
      PANEL_BUTTONS.referal,
      PANEL_BUTTONS.config,
      PANEL_BUTTONS.sound,
      PANEL_BUTTONS.help,
      PANEL_BUTTONS.close,
    ].map((spec) => ({ node: this.addButton(spec), width: spec.width, gap: spec.name == 'close' ? 12 : 0 }));

    // --- Фонд боя + лимит времени (FundAndLimits) и счёт игрока (PlayerScoreField)
    this.addFrame(this.field);
    this.fundIcon = this.addBattleIcon(this.field, BattleIcon.MONEY);
    this.fundText = label(this.field);
    this.diamond = image(this.field, 'diamond/1.png');
    this.diamond.classList.add('abs');
    this.timeField = element('div', 'abs', this.field);
    this.addBattleIcon(this.timeField, BattleIcon.TIME_LIMIT);
    this.timeText = label(this.timeField);
    this.timeText.style.left = '24px';

    this.addFrame(this.scoreField);
    place(this.addBattleIcon(this.scoreField, BattleIcon.KILL_LIMIT), 6, 7);
    this.scoreText = label(this.scoreField);
    this.scoreText.style.font = "bold 18px/22px 'MyriadPro', Arial, sans-serif";
    place(this.scoreText, 35, 9);

    this.teamIndicator=new TeamScore(this.scoreField);

    // --- FPSText
    label(this.fps, 'FPS: ');
    this.fpsValue = element('div', 'hud-fps-value', this.fps);
    this.fpsValue.textContent = '60';
    this.frameCanvas.width = FRAME_HISTORY;
    this.frameCanvas.height = FRAME_GRAPH_HEIGHT;
    this.frameGraph.title = 'Время кадра и пик за последние 240 кадров';
    this.frameGraph.append(this.frameCanvas);
    document.addEventListener('visibilitychange', this.resetFrameTiming);

    // --- Инвентарь: пять пустых слотов
    this.inventory.classList.toggle('archive-inventory', archiveInventory);
    for (let n = 0; n < SLOT_COUNT; n++) {
      const slot = element(archiveInventory ? 'button' : 'div', 'hud-slot', this.inventory);
      if (slot instanceof HTMLButtonElement) {
        slot.type = 'button';
        slot.tabIndex = -1;
        slot.setAttribute('aria-label', SUPPLY_NAMES[n]);
        slot.addEventListener('click', () => callbacks.onInventoryPress?.(n + 1));
      }
      place(slot, (archiveInventory ? 0 : 10) + n * 50, 0);
      const icon = image(slot, 'inventory_icons/7.png', 40, 40);
      const cooldown = element('div', 'hud-cooldown', slot);
      const effect = archiveInventory ? element('div', 'hud-supply-effect', slot) : undefined;
      if (effect) effect.style.backgroundImage = `url(${SUPPLY_ASSETS}/${n + 1}-bg.png)`;
      const flashLayer = archiveInventory ? element('div', 'hud-supply-flash', slot) : undefined;
      if (flashLayer) flashLayer.style.backgroundColor = SUPPLY_FLASH[n];
      const key = element('div', 'hud-key', slot);
      key.textContent = String(n + 1);
      const count = element('div', 'hud-count', slot);
      const view = { node: slot, icon, cooldown, count, itemIndex: 0, readiness: 1, effectStatus: null, effect, flashLayer };
      this.slots.push(view);
      if (archiveInventory) this.updateSupplyIcon(view, n);
    }

    this.setPlayer({ name: 'player', rank: 1, score: 0, nextRankScore: 100, crystals: 0, place: 1, kd: 0 });
    this.setFund(0);
    this.setScore(0);
    this.setTimeLimit(0);
    window.addEventListener('resize', this.layout);
    window.addEventListener(GLASS_UI_EVENT, this.layout);
    void document.fonts.load("12px 'MyriadPro'").then(() => this.layout());
    this.layout();
  }

  /** Indicators: progress, playerInfo, scoreLabel, kdRatio, crystalInfo */
  setPlayer(info: PlayerInfo): void {
    const rank = Math.max(1, info.rank);
    this.rankIcon.src = `${hudBase()}/rank_normal/${rank}.png?v=${ASSET_VERSION}`;
    const rankName = RANK_NAMES[rank - 1] ?? `Звание ${rank}`;
    this.playerLabel.textContent = `${formatNumber(info.score)} / ${formatNumber(info.nextRankScore)}   ${rankName} ${info.name}`;
    this.ratingLabel.textContent = info.place ? `Рейтинг: #${formatNumber(info.place)}` : '';
    this.kdLabel.textContent = formatNumber(info.kd ?? 0);
    this.crystalLabel.textContent = formatNumber(info.crystals);
    // прогресс внутри звания: от порога текущего звания до следующего
    const start = RANK_SCORES[rank - 1] ?? 0;
    const span = info.nextRankScore - start;
    const previous = this.progress;
    this.progress = span > 0 ? Math.max(0, Math.min(1, (info.score - start) / span)) : 0;
    if (this.lastScore >= 0 && info.score > this.lastScore) this.flashGain(rank > this.lastRank ? 0 : previous, this.progress);
    this.lastRank = rank;
    this.lastScore = info.score;
    this.layout();
  }

  /** прибавленный опыт поверх полоски: вспышка ярким цветом и плавное угасание */
  private flashGain(from: number, to: number): void {
    this.gainFrom = from;
    this.gainTo = to;
    const gain = this.xpGain;
    gain.style.transition = 'none';
    gain.style.opacity = '1';
    gain.style.boxShadow = '0 0 8px 2px rgba(255, 60, 40, 0.9)';
    void gain.offsetWidth;
    gain.style.transition = 'opacity 1.6s ease-out 0.5s, box-shadow 1.6s ease-out 0.5s';
    gain.style.opacity = '0';
    gain.style.boxShadow = '0 0 0 0 rgba(255, 60, 40, 0)';
  }

  /** FieldStatistics.updateFund */
  setFund(value: number): void {
    this.fundText.textContent = `Фонд битвы: ${formatNumber(value)}`;
    this.layout();
  }

  /** PlayerScoreField.setScore: число убийств игрока */
  setTeamScore(mode:BattleMode,scores:[number,number],flags:CtfFlag[]=[]):void {
    this.teamMode=mode;
    for(const child of this.scoreField.children)if(!child.classList.contains('hud-frame')&&!child.classList.contains('protanki-team-score'))(child as HTMLElement).style.display=mode==='dm'?'':'none';
    this.teamIndicator.set(mode,scores,flags);this.layout();
  }

  setScore(value: number): void {
    this.scoreText.textContent = String(value);
    this.layout();
  }

  /** FundAndLimits.initTime + TimeLimitField; 0 убирает поле времени */
  setTimeLimit(seconds: number): void {
    this.timeLimit = seconds;
    this.timeEnd = performance.now() + seconds * 1000;
    this.timeField.style.display = seconds > 0 ? '' : 'none';
    window.clearInterval(this.winkTimer);
    this.winkTimer = 0;
    if (seconds > 0) this.winkTimer = window.setInterval(() => this.updateTime(), 250);
    this.updateTime();
    this.layout();
  }

  /** StatisticsModel.roundFinish → BattleStatistics.finish: отсчёт останавливается на нуле, поле остаётся */
  stopTime(): void {
    if (this.timeLimit <= 0) return;
    this.timeEnd = performance.now();
    window.clearInterval(this.winkTimer);
    this.winkTimer = 0;
    this.updateTime();
    this.timeText.style.visibility = 'visible';
  }

  setFpsVisible(visible: boolean): void {
    this.fpsVisible = visible;
    const display = visible && this.battleWidgets ? '' : 'none';
    if (this.fps.style.display !== display) this.resetFrameTiming();
    this.fps.style.display = display;
  }

  /**
   * InventoryModel.assignItemToSlot: в слот встаёт припас (itemIndex 1..5 — кадр иконки InventoryIcon), null — пустой слот (кадр 7).
   * count — сколько осталось; 0 — слот затемнён.
   */
  setInventorySlot(slot: number, itemIndex: number | null, count = 0): void {
    const view = this.slots[slot];
    if (!view) return;
    view.itemIndex = itemIndex ?? 0;
    if (!this.archiveInventory) view.icon.src = `${hudBase()}/inventory_icons/${itemIndex ?? 7}.png?v=${ASSET_VERSION}`;
    this.setInventoryCount(slot, itemIndex == null ? null : count);
  }

  setInventoryCount(slot: number, count: number | null): void {
    const view = this.slots[slot];
    if (!view) return;
    if (this.archiveInventory) {
      const filled = view.itemIndex !== 0 && count !== null && count > 0;
      view.node.toggleAttribute('data-filled', filled);
      view.count.textContent = filled ? String(count) : '';
      this.updateSupplyIcon(view, slot);
      return;
    }
    view.count.textContent = count == null ? '' : String(count);
    view.icon.style.opacity = count == 0 ? '0.4' : '';
  }

  /** CooldownIndicator: status 0 — только что применён, 1 — готов; затемнение убывает по часовой стрелке от 12 часов */
  setInventoryCooldown(slot: number, status: number): void {
    const view = this.slots[slot];
    if (!view) return;
    const wasReady = this.supplyReady(view);
    const cooldownChanged = (view.readiness < 1) !== (status < 1);
    view.readiness = status;
    if (this.archiveInventory) {
      view.cooldown.style.display = status < 1 ? 'block' : 'none';
      if (status < 1) view.cooldown.style.clipPath = archiveCooldownClip(status);
      if (cooldownChanged) this.updateSupplyIcon(view, slot, wasReady);
      return;
    }
    if (status >= 1) {
      view.cooldown.style.background = '';
      view.cooldown.style.clipPath = '';
      view.cooldown.style.display = 'none';
      return;
    }
    const angle = (status * 360).toFixed(1);
    view.cooldown.style.display = 'block';
    view.cooldown.style.background = `conic-gradient(from ${angle}deg, rgba(0,0,0,0.7) 0deg, rgba(0,0,0,0.7) ${(360 - status * 360).toFixed(1)}deg, transparent ${(360 - status * 360).toFixed(1)}deg)`;
  }

  setInventoryEffect(slot: number, status: number | null): void {
    const view = this.slots[slot];
    if (!view?.effect) return;
    const wasReady = this.supplyReady(view);
    const effectChanged = (view.effectStatus === null) !== (status === null);
    view.effectStatus = status;
    view.effect.style.display = status === null ? 'none' : 'block';
    if (status !== null) view.effect.style.clipPath = archiveCooldownClip(status);
    if (effectChanged) this.updateSupplyIcon(view, slot, wasReady);
  }

  private supplyReady(view: InventorySlotView): boolean {
    return view.readiness >= 1 && view.effectStatus === null;
  }

  private updateSupplyIcon(view: InventorySlotView, slot: number, wasReady = this.supplyReady(view)): void {
    const ready = this.supplyReady(view);
    const locked = this.inventory.classList.contains('hud-locked');
    const filled = view.node.hasAttribute('data-filled');
    const active = view.effectStatus !== null;
    const state = active ? 'color' : ready && filled && !locked ? 'white' : 'gray';
    const path = `${SUPPLY_ASSETS}/${slot + 1}-${state}.png`;
    if (view.icon.getAttribute('src') !== path) view.icon.src = path;
    view.node.toggleAttribute('data-busy', !ready);
    view.node.toggleAttribute('data-effect', active);
    if (!ready || locked || !filled) {
      view.flash?.cancel();
    } else if (!wasReady && view.flashLayer) {
      view.flash?.cancel();
      view.flash = view.flashLayer.animate([
        { opacity: 0, offset: 0 }, { opacity: 0.75, offset: 1 / 7 }, { opacity: 0, offset: 0.5 },
        { opacity: 0.75, offset: 9 / 14 }, { opacity: 0, offset: 1 },
      ], 700);
    }
  }

  /** InventoryLock: пока танк не активен (до ACTIVATE_TANK, после смерти) припасы не применяются, слоты притушены */
  setInventoryLocked(locked: boolean): void {
    this.inventory.classList.toggle('hud-locked', locked);
    if (this.archiveInventory) this.slots.forEach((view, slot) => this.updateSupplyIcon(view, slot));
  }

  /** До входа в игру верхней панели нет совсем (видно только окно авторизации) */
  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
    // пока панель скрыта, тексты имеют нулевую ширину — раскладка по ним сбивалась до изменения размера окна
    if (visible) this.layout();
  }

  /** В лобби виджеты боя (фонд, счёт, инвентарь, FPS) скрыты; верхняя панель видна всегда */
  setBattleWidgetsVisible(visible: boolean): void {
    this.battleWidgets = visible;
    for (const node of [this.field, this.scoreField, this.inventory]) node.style.display = visible ? '' : 'none';
    this.setFpsVisible(this.fpsVisible);
    // в бою полоса верхней панели без тёмной подложки (современный интерфейс, ui/glass.css)
    this.root.classList.toggle('hud-in-battle', visible);
    // пока виджеты скрыты, offsetWidth текста фонда и счёта — 0, и рамки сжимались: пересчитать при показе
    if (visible) this.layout();
  }

  /** MainPanel: кнопка текущего раздела лобби — зелёная (кадр 1) и не нажимается */
  /** clickable — подсвечена, но нажимается (в бою «Битвы»: выход в список боёв) */
  setActiveButton(name: HudButtonName | null, clickable = false): void {
    this.activeButton = name;
    this.activeClickable = clickable;
    for (const [action, refresh] of this.buttonRefresh) refresh(action == name);
  }

  /** FPSText.onEnterFrame: считает раз в 10 кадров */
  frame(now: number): void {
    if (!this.fpsVisible || !this.battleWidgets || document.hidden) return;
    if (!this.previousFrame) {
      this.previousFrame = this.fpsStart = now;
      return;
    }
    const delta = now - this.previousFrame;
    this.previousFrame = now;
    if (delta <= 0) return;
    this.frameTimes[this.frameTimeIndex] = delta;
    this.frameTimeIndex = (this.frameTimeIndex + 1) % FRAME_HISTORY;
    this.frameTimeCount = Math.min(this.frameTimeCount + 1, FRAME_HISTORY);
    if (now - this.lastGraphUpdate >= FRAME_GRAPH_INTERVAL) {
      this.drawFrameGraph(delta);
      this.lastGraphUpdate = now;
    }
    this.fpsFrames += 1;
    if (this.fpsFrames < FPS_FRAMES) return;
    this.fpsValue.textContent = String(Math.trunc((1000 * this.fpsFrames) / (now - this.fpsStart)));
    this.fpsFrames = 0;
    this.fpsStart = now;
  }

  private readonly resetFrameTiming = (): void => {
    this.previousFrame = 0;
    this.fpsFrames = 0;
    this.frameTimeIndex = 0;
    this.frameTimeCount = 0;
    this.lastGraphUpdate = 0;
    this.framePeak.textContent = '';
    this.frameContext?.clearRect(0, 0, FRAME_HISTORY, FRAME_GRAPH_HEIGHT);
  };

  private drawFrameGraph(delta: number): void {
    const ctx = this.frameContext;
    if (!ctx) return;
    let peak = 0;
    for (let i = 0; i < this.frameTimeCount; i++) peak = Math.max(peak, this.frameTimes[i]);
    this.framePeak.textContent = `${delta.toFixed(1)} мс · пик ${peak.toFixed(1)}`;
    const scale = FRAME_GRAPH_HEIGHT / Math.max(33.3, peak);
    ctx.clearRect(0, 0, FRAME_HISTORY, FRAME_GRAPH_HEIGHT);
    ctx.fillStyle = '#80dc71';
    ctx.beginPath();
    const start = this.frameTimeIndex + FRAME_HISTORY - this.frameTimeCount;
    for (let i = 0; i < this.frameTimeCount; i++) {
      const height = Math.max(1, Math.round(this.frameTimes[(start + i) % FRAME_HISTORY] * scale));
      ctx.rect(FRAME_HISTORY - this.frameTimeCount + i, FRAME_GRAPH_HEIGHT - height, 1, height);
    }
    ctx.fill();
    ctx.fillStyle = '#ffc578';
    ctx.fillRect(0, FRAME_GRAPH_HEIGHT - Math.round(peak * scale), FRAME_HISTORY, 1);
  }

  private updateTime(): void {
    if (this.timeLimit <= 0) return;
    const left = Math.max(0, Math.round((this.timeEnd - performance.now()) / 1000));
    const two = (n: number): string => (n > 9 ? String(n) : `0${n}`);
    this.timeText.textContent = `${two(Math.trunc(left / 60))} : ${two(left % 60)}`;
    // WinkingField: в последние секунды поле мигает
    const hidden = left <= TIME_WINK_LIMIT_SEC && Math.floor(performance.now() / WINK_PERIOD_MS) % 2 == 1;
    this.timeText.style.visibility = hidden ? 'hidden' : 'visible';
  }

  private addButton(spec: ButtonSpec): HTMLElement {
    const button = element('div', 'hud-btn', this.top);
    button.dataset.name = spec.name;
    button.style.width = `${spec.width}px`;
    // векторная иконка современного интерфейса (ui/glass.css); в классическом иконка — на картинке кнопки
    const icon = element('div', 'hud-btn-icon', button);
    icon.innerHTML = spec.action === 'missions'
      ? '<img src="/lobby/missions/tab-star.png" alt="">'
      : glassIcon(spec.icon);
    if (spec.action === 'missions') {
      button.title = 'Задания';
      button.setAttribute('aria-label', 'Задания');
    }
    button.style.backgroundImage = `url(${hudBase()}/${spec.folder}/${spec.width == 23 ? 1 : 2}.png)`;
    if (spec.caption) {
      const text = label(button, spec.caption);
      text.style.left = '25px';
      text.style.width = `${spec.width - 28}px`;
    }
    // кадры: 1 — зелёная (неактивна), 2 — обычная, 3 — под курсором, 4 — нажата (у «закрыть» один кадр)
    const frames = spec.width == 23 ? 1 : 4;
    const isActive = (): boolean => spec.action != 'sound' && this.activeButton == spec.action;
    const setFrame = (frame: number): void => {
      button.style.backgroundImage = `url(${hudBase()}/${spec.folder}/${Math.min(isActive() ? 1 : frame, frames)}.png)`;
      button.classList.toggle('hud-btn-active', isActive());
    };
    if (spec.action != 'sound') {
      const action = spec.action;
      this.buttonRefresh.push([action, (active) => {
        button.style.cursor = active && !this.activeClickable ? 'default' : '';
        setFrame(2);
      }]);
    }
    button.addEventListener('mouseenter', () => setFrame(3));
    button.addEventListener('mouseleave', () => setFrame(2));
    button.addEventListener('mousedown', () => setFrame(4));
    button.addEventListener('mouseup', () => setFrame(3));
    button.addEventListener('click', () => {
      if (isActive() && !this.activeClickable) return;
      if (spec.action == 'sound') {
        this.muted = !this.muted;
        button.style.opacity = this.muted ? '0.5' : '1';
        button.classList.toggle('hud-btn-muted', this.muted);
        this.callbacks.onSoundToggle?.(this.muted);
      } else {
        this.callbacks.onButton?.(spec.action);
      }
    });
    return button;
  }

  private addBattleIcon(parent: HTMLElement, frame: number): HTMLDivElement {
    const holder = element('div', 'hud-icon', parent);
    image(holder, `battle_icons/${frame}.png`, 24, 24);
    return holder;
  }

  private addFrame(parent: HTMLElement): void {
    const frame = element('div', 'hud-frame', parent);
    element('div', 'hud-frame-l', frame).style.backgroundImage = `url(${hudBase()}/frame_left.png)`;
    element('div', 'hud-frame-c', frame).style.backgroundImage = `url(${hudBase()}/frame_center.png)`;
    element('div', 'hud-frame-r', frame).style.backgroundImage = `url(${hudBase()}/frame_right.png)`;
  }

  /** DefaultLayout + FieldStatistics.adjustFields + FPSText.onResize + InventoryModel.onResize */
  private readonly layout = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // MainPanel: справа налево значки и «закрыть», слева направо значок звания, таблетка имени (тянется), кристаллы и кнопки
    const glass = isGlassUi();
    let right = width - (glass ? 4 : 2);
    for (let index = this.rightItems.length - 1; index >= 0; index--) {
      const item = this.rightItems[index];
      right -= item.width;
      place(item.node, right, index == this.rightItems.length - 1 && !glass ? 3 : 0);
      right -= glass ? (index == this.rightItems.length - 1 ? GLASS_GAP : GLASS_ICON_GAP) : item.gap;
    }
    right -= glass ? GLASS_GAP - GLASS_ICON_GAP : 3;
    const crystalIndicator = this.leftItems[0].node;
    if (glass) {
      // по ширине содержимого: число слева, ромб сразу за ним
      this.crystalLabel.style.width = '';
      this.crystalLabel.style.textAlign = 'left';
      place(this.crystalLabel, GLASS_PILL_PADDING, 5);
      crystalIndicator.style.width = `${GLASS_PILL_PADDING * 2 + this.crystalLabel.offsetWidth + GLASS_DIAMOND_GAP + GLASS_DIAMOND_WIDTH}px`;
    } else {
      this.crystalLabel.style.width = '59px';
      this.crystalLabel.style.textAlign = 'right';
      place(this.crystalLabel, CRYSTAL_PILL_WIDTH + CRYSTAL_EXTEND - 20 - 59, 5);
      crystalIndicator.style.width = `${CRYSTAL_PILL_WIDTH + CRYSTAL_EXTEND}px`;
    }
    const leftTotal = this.leftItems.reduce((sum, item, index) => sum + (glass ? item.node.offsetWidth : item.width) + (glass ? (index < this.leftItems.length - 1 ? GLASS_GAP : 0) : item.gap), 0);
    // у классической таблетки имени справа декоративный хвост 14 px (её зазор 17 его учитывает)
    const nameLeft = 60;
    const nameGap = glass ? GLASS_GAP : 17;
    const nameWidth = Math.max(120, right - leftTotal - nameGap - nameLeft);
    place(this.rankIcon, 8, -1);
    this.nameIndicator.style.width = `${nameWidth}px`;
    place(this.nameIndicator, nameLeft, 0);
    // классика: полоса на всю таблетку с хвостом; современный: линия внутри рамки
    const barLeft = glass ? GLASS_XP_INSET : -1;
    const barWidth = glass ? nameWidth - GLASS_XP_INSET * 2 : nameWidth + 4;
    this.xpBar.style.left = `${barLeft}px`;
    this.xpBar.style.width = `${barWidth * this.progress}px`;
    this.xpGain.style.left = `${barLeft + barWidth * this.gainFrom}px`;
    this.xpGain.style.width = `${Math.max(2, barWidth * (this.gainTo - this.gainFrom))}px`;
    let x = nameLeft + nameWidth + nameGap;
    for (const item of this.leftItems) {
      // таблетка кристаллов стоит левее на CRYSTAL_SHIFT, остальные кнопки на своих местах
      place(item.node, item.node == this.leftItems[0].node && !glass ? x - CRYSTAL_SHIFT : x, 0);
      x += glass ? item.node.offsetWidth + GLASS_GAP : item.width + item.gap;
    }

    // Indicators.width: K/D у правого края таблетки с тем же отступом, что слева у текста (9)
    const kdWidth = this.kdLabel.offsetWidth;
    const kdX = nameWidth - (glass ? 10 : 7) - kdWidth;
    place(this.kdLabel, kdX, 5);
    place(this.kdIcon, kdX - 4 - 9, 9);
    place(this.ratingLabel, kdX - 4 - 9 - 6 - this.ratingLabel.offsetWidth, 5);

    // FundAndLimits.adjustFields: [иконка][Фонд боя ◆] [таймер]
    place(this.fundIcon, 14, 11);
    place(this.fundText, 14 + 27, 11);
    place(this.diamond, 14 + 27 + this.fundText.offsetWidth + 4, 11 + 4);
    let end = 14 + 27 + this.fundText.offsetWidth + 4 + this.diamond.offsetWidth;
    if (this.timeLimit > 0) {
      place(this.timeField, end + 7, 11);
      end += 7 + 24 + this.timeText.offsetWidth;
    }
    this.field.style.width = `${12 + end - FUND_FRAME_TRIM}px`;
    this.scoreField.style.width = `${this.teamMode==='dm'?35 + this.scoreText.offsetWidth + 10 - SCORE_FRAME_TRIM:this.teamIndicator.width}px`;

    // DefaultLayout: виджеты прижаты к правому нижнему углу с отступом 10
    // левый край блока не двигается при изменении длины рамки счёта
    const total = 12 + end + 10 + this.scoreField.offsetWidth + SCORE_FRAME_TRIM;
    place(this.field, width - total + 2, height - 50);
    place(this.scoreField, width - total + 2 + 12 + end + 10, height - 50);
    place(this.fps, width - 50, height - 74);
    place(this.inventory, this.archiveInventory ? Math.max(0, (width - 240) / 2) : 0, height - 50);
  };
}

/**
 * Элементы интерфейса оригинала на DOM: controls.TankWindow, TankWindowInner, TankWindowHeader, DefaultButton,
 * BigButton (GreyBigButtonSkin), спрайты MovieClip (кадр + смещение точки привязки).
 * Картинки — tools/extract_lobby_assets.py -> public/lobby/ui.
 */
import { lobbyUi, themed } from '../theme.ts';

/** картинки лобби текущей темы (ui/theme.ts) */
export const UI = lobbyUi;
export const RES = '/lobby/res';
/** версия картинок-ресурсов: менять при обновлении превью (иначе браузер до часа держит старые) */
export const RES_VERSION = '2';

/** TankWindowHeader: номер заголовка (кадр = номер + 25 для русского) */
export const HEADER = {
  CHAT: 5,
  CURRENT_BATTLES: 6,
  BATTLE_INFO: 7,
  YOUR_TANK: 9,
  INFORMATION: 10,
  YOUR_ITEMS: 24,
  SHOP: 25,
} as const;
const HEADER_LANG_OFFSET_RU = 25;
/** подписи заголовков текстом — для современного интерфейса (ui/glass.css), где табличка-картинка скрыта */
const HEADER_TEXT: Record<number, string> = {
  [HEADER.CHAT]: 'Чат',
  [HEADER.CURRENT_BATTLES]: 'Список битв',
  [HEADER.BATTLE_INFO]: 'Информация о битве',
  [HEADER.YOUR_TANK]: 'Ваш танк',
  [HEADER.INFORMATION]: 'Информация',
  [HEADER.YOUR_ITEMS]: 'Ваши предметы',
  [HEADER.SHOP]: 'Магазин',
};

/** TankWindowInner: цвет фона (ARGB) */
export const INNER = {
  get GREEN(): string {
    return themed('#0c220d');
  },
  TRANSPARENT: 'transparent',
} as const;

interface SpriteInfo {
  x: number;
  y: number;
  frames: number;
}
const spriteInfo = new Map<string, SpriteInfo>();
const SPRITES = [
  'TankWindowHeader', 'WindowTopLeftCorner', 'WindowTopRightCorner', 'WindowBottomLeftCorner', 'WindowBottomRightCorner',
  'WindowInnerBlink', 'Abris', 'SportBattleItemIcon', 'GarageItemBackground', 'IconGarageMod', 'InputCheckIcon',
  'RangIconSmall', 'RangIconNormal', 'BattleInfoIcons', 'Diamond', 'ScrollArrowDownGreen', 'ScrollArrowUpGreen',
];

/** Смещения спрайтов (info.json рядом с кадрами); вызывать до построения окон. onProgress — доля 0..1 для экрана загрузки */
export async function loadLobbyAssets(onProgress?: (fraction: number) => void): Promise<void> {
  const total = SPRITES.length + 1;
  let done = 0;
  const step = (): void => onProgress?.(++done / total);
  await Promise.all(
    SPRITES.map(async (name) => {
      try {
        const response = await fetch(`${UI()}/${name}/info.json`);
        if (response.ok) spriteInfo.set(name, (await response.json()) as SpriteInfo);
      } catch {
        // нет картинки — элемент просто не будет нарисован
      }
      step();
    }),
  );
  await document.fonts.load("12px 'MyriadPro'").catch(() => undefined);
  step();
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
}

export function place(node: HTMLElement, x: number, y: number, width?: number, height?: number): void {
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
  if (width != null) node.style.width = `${Math.max(0, Math.round(width))}px`;
  if (height != null) node.style.height = `${Math.max(0, Math.round(height))}px`;
}

/** Кадр MovieClip как img с учётом точки привязки (x, y — позиция точки привязки в родителе) */
export function sprite(parent: HTMLElement, name: string, frame: number, x = 0, y = 0): HTMLImageElement {
  const info = spriteInfo.get(name) ?? { x: 0, y: 0, frames: 1 };
  const img = el('img', 'lb-abs', parent);
  img.draggable = false;
  img.src = `${UI()}/${name}/${frame}.png`;
  img.dataset.ox = String(info.x);
  img.dataset.oy = String(info.y);
  moveSprite(img, x, y);
  return img;
}

export function moveSprite(img: HTMLImageElement, x: number, y: number): void {
  place(img, x + Number(img.dataset.ox ?? 0), y + Number(img.dataset.oy ?? 0));
}

export function setSpriteFrame(img: HTMLImageElement, name: string, frame: number): void {
  img.src = `${UI()}/${name}/${frame}.png`;
}

export function bitmap(parent: HTMLElement, file: string, x = 0, y = 0): HTMLImageElement {
  const img = el('img', 'lb-abs', parent);
  img.draggable = false;
  img.src = `${UI()}/${file}`;
  place(img, x, y);
  return img;
}

export function label(parent: HTMLElement, text = '', className = ''): HTMLDivElement {
  const node = el('div', `lb-label ${className}`.trim(), parent);
  node.textContent = text;
  return node;
}

/** controls.TankWindow: тайл фона, края 11 px, угловые спрайты, заголовок сверху по центру */
export class TankWindow {
  readonly root: HTMLDivElement;
  private header: HTMLImageElement | null = null;
  width = 100;
  height = 100;

  constructor(parent: HTMLElement, private readonly headerId = 0) {
    this.root = el('div', 'lb-window', parent);
    el('div', 'lb-window-bg', this.root);
    el('div', 'lb-window-top', this.root);
    el('div', 'lb-window-bottom', this.root);
    el('div', 'lb-window-left', this.root);
    el('div', 'lb-window-right', this.root);
    const tl = sprite(this.root, 'WindowTopLeftCorner', 1);
    tl.className = 'lb-abs lb-corner-tl';
    const tr = sprite(this.root, 'WindowTopRightCorner', 1);
    tr.className = 'lb-abs lb-corner-tr';
    const bl = sprite(this.root, 'WindowBottomLeftCorner', 1);
    bl.className = 'lb-abs lb-corner-bl';
    const br = sprite(this.root, 'WindowBottomRightCorner', 1);
    br.className = 'lb-abs lb-corner-br';
    for (const corner of [tl, tr, bl, br]) corner.style.left = corner.style.top = '';
    if (headerId > 0) {
      this.header = sprite(this.root, 'TankWindowHeader', headerId + HEADER_LANG_OFFSET_RU);
      this.header.classList.add('lb-window-header');
      label(this.root, HEADER_TEXT[headerId] ?? '', headerId > 23 ? 'lb-window-caption lb-window-caption-v' : 'lb-window-caption');
    }
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    this.width = Math.round(width);
    this.height = Math.round(height);
    place(this.root, x, y, this.width, this.height);
    // TankWindow.header: горизонтальный — по центру на 13 px выше окна, вертикальный (id > 23) — слева по центру высоты
    if (this.header) {
      if (this.headerId > 23) moveSprite(this.header, -13, Math.trunc(this.height / 2));
      else moveSprite(this.header, Math.trunc(this.width / 2), -13);
    }
  }
}

/** controls.TankWindowInner: заливка цветом, края 6 px, «блик» сверху для зелёного */
export class WindowInner {
  readonly root: HTMLDivElement;
  private readonly blink: HTMLImageElement | null = null;

  constructor(parent: HTMLElement, color: string, showBlink = false) {
    this.root = el('div', 'lb-inner', parent);
    const fill = el('div', 'lb-inner-fill', this.root);
    fill.style.background = color;
    if (showBlink && color == INNER.GREEN) {
      const clip = el('div', 'lb-inner-clip', this.root);
      this.blink = el('img', 'lb-abs', clip);
      this.blink.src = `${UI()}/WindowInnerBlink/1.png`;
      this.blink.draggable = false;
    }
    for (const part of ['t', 'b', 'l', 'r', 'tl', 'tr', 'bl', 'br']) el('div', `lb-inner-${part}`, this.root);
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    place(this.root, x, y, Math.floor(width), Math.floor(height));
    if (this.blink) {
      // blink.width = w - 2, height = 174 * (w - 2) / 310
      this.blink.style.width = `${Math.floor(width) - 2}px`;
      this.blink.style.height = `${(174 * (Math.floor(width) - 2)) / 310}px`;
    }
  }
}

type ButtonState = 'UP' | 'OVER' | 'DOWN' | 'OFF';

/** controls.DefaultButton (ColorButton "def"): три части по 30 px высотой, подпись 12 px с тенью */
export class DefaultButton {
  readonly root: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private enabled = true;
  onClick: (() => void) | null = null;

  constructor(parent: HTMLElement, caption: string) {
    this.root = el('div', 'lb-button', parent);
    for (const part of ['l', 'c', 'r']) el('div', `lb-button-${part}`, this.root);
    this.text = label(this.root, caption, 'lb-button-label');
    this.setState('UP');
    this.root.addEventListener('mouseenter', () => this.enabled && this.setState('OVER'));
    this.root.addEventListener('mouseleave', () => this.enabled && this.setState('UP'));
    this.root.addEventListener('mousedown', () => this.enabled && this.setState('DOWN'));
    this.root.addEventListener('mouseup', () => this.enabled && this.setState('OVER'));
    this.root.addEventListener('click', () => this.enabled && this.onClick?.());
  }

  set caption(value: string) {
    this.text.textContent = value;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    this.setState(value ? 'UP' : 'OFF');
  }

  setBounds(x: number, y: number, width: number): void {
    place(this.root, x, y, width, 30);
  }

  private setState(state: ButtonState): void {
    // состояние для CSS современного интерфейса (ui/glass.css), где картинки кнопки не рисуются
    this.root.dataset.state = state;
    const base = state == 'OFF' ? 'button_OFF' : `button_def_${state}`;
    const [l, c, r] = this.root.children as unknown as HTMLElement[];
    l.style.backgroundImage = `url(${UI()}/${base}_LEFT.png)`;
    c.style.backgroundImage = `url(${UI()}/${base}_CENTER.png)`;
    r.style.backgroundImage = `url(${UI()}/${base}_RIGHT.png)`;
    this.text.style.top = state == 'DOWN' ? '7px' : '6px';
    this.root.style.cursor = state == 'OFF' ? 'default' : 'pointer';
  }
}

type BigSkin = 'Grey' | 'Green' | 'Gold';

/** controls.BigButton / BigButtonBase: GreyBigButtonSkin (h50), подпись 14 px, значок слева (BattleBigButton) */
export class BigButton {
  readonly root: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private icon: HTMLImageElement | null = null;
  private enabled = true;
  private state: 'Up' | 'Over' | 'Down' = 'Up';
  onClick: (() => void) | null = null;

  constructor(parent: HTMLElement, caption: string, private skin: BigSkin = 'Grey') {
    this.root = el('div', 'lb-bigbutton', parent);
    for (const part of ['l', 'c', 'r']) el('div', `lb-button-${part}`, this.root);
    this.text = label(this.root, caption, 'lb-bigbutton-label');
    this.setState('Up');
    this.root.addEventListener('mouseenter', () => this.enabled && this.setState('Over'));
    this.root.addEventListener('mouseleave', () => this.enabled && this.setState('Up'));
    this.root.addEventListener('mousedown', () => this.enabled && this.setState('Down'));
    this.root.addEventListener('mouseup', () => this.enabled && this.setState('Over'));
    this.root.addEventListener('click', () => this.enabled && this.onClick?.());
  }

  /** две строки (ThreeLineBigButton.showInTwoRows): подпись выше, вторая строка — цена */
  set caption(value: string) {
    this.text.textContent = value;
    this.twoRows = value.includes('\n');
    this.setState(this.state);
  }

  private twoRows = false;

  setSkin(skin: BigSkin): void {
    this.skin = skin;
    this.setState(this.state);
  }

  /** BattleBigButton.icon: значок слева, подпись правее значка */
  setIcon(file: string): void {
    this.icon = file.startsWith('/')?el('img','lb-abs',this.root):bitmap(this.root, file);
    if(file.startsWith('/')){this.icon.src=file;this.icon.draggable=false;}
    this.icon.onload = () => this.layoutIcon();
  }

  /** ButtonBase.enabled: выключенная кнопка рисуется общим скином H50ButtonSkin, подпись не меняется */
  setEnabled(value: boolean): void {
    this.enabled = value;
    this.root.style.cursor = value ? '' : 'default';
    this.setState('Up');
  }

  setBounds(x: number, y: number, width: number): void {
    place(this.root, x, y, width, 50);
    this.layoutIcon();
  }

  private layoutIcon(): void {
    const width = parseInt(this.root.style.width || '120', 10);
    // верх подписи задаёт setState (style.top); offsetTop не брать — он зависит от CSS и копил бы сдвиг
    const top = parseInt(this.text.style.top || '15', 10);
    if (!this.icon || !this.icon.naturalWidth) {
      place(this.text, 2, top, width - 4);
      return;
    }
    place(this.icon, 6, Math.trunc(25 - this.icon.naturalHeight / 2));
    place(this.text, this.icon.naturalWidth + 4, top, width - 8 - this.icon.naturalWidth);
  }

  private setState(state: 'Up' | 'Over' | 'Down'): void {
    this.state = state;
    this.root.dataset.state = this.enabled ? state : 'OFF';
    this.root.dataset.skin = this.skin;
    const [l, c, r] = this.root.children as unknown as HTMLElement[];
    const skin = (part: string): string =>
      this.enabled ? `url(${UI()}/${this.skin}BigButtonSkin_${part}${state}Class.png)` : `url(${UI()}/H50ButtonSkin_${part}Class.png)`;
    l.style.backgroundImage = skin('left');
    c.style.backgroundImage = skin('middle');
    r.style.backgroundImage = skin('right');
    const top = this.twoRows ? 6 : 15;
    this.text.style.top = `${state == 'Down' ? top + 1 : top}px`;
  }
}

/** Money.numToString: разряды через пробел */
/**
 * controls.NumStepper: поле на 5 цифр (TankInputBase, x 19, ширина 55) и StepperButton (x 75): верхняя половина — +шаг,
 * нижняя — −шаг. Удержание: через 500 мс повтор каждые 75 мс, каждые 7 повторов шаг растёт по STEPS, если значение кратно.
 */
export class NumStepper {
  private static readonly STEPS = [1, 5, 10, 20, 50, 100, 200, 500];
  readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly button: HTMLImageElement;
  private current = 1;
  private min = 1;
  private max = 1;
  private enabled = true;
  private holdTimer = 0;
  private repeatTimer = 0;
  private repeatCounter = 0;
  private stepIndex = 0;
  onChange: ((value: number) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'lb-abs lb-stepper', parent);
    const field = el('div', 'lb-input', this.root);
    for (const part of ['InputLeft', 'InputCenter', 'InputRight']) el('div', '', field).style.backgroundImage = `url(${UI()}/${part}.png)`;
    (field.children[0] as HTMLElement).style.width = '5px';
    (field.children[2] as HTMLElement).style.width = '5px';
    place(field, 19, 0, 55);
    this.input = el('input', 'lb-stepper-input', field);
    this.input.inputMode = 'numeric';
    this.input.maxLength = 5;
    this.input.addEventListener('input', () => {
      this.input.value = this.input.value.replace(/\D/g, '');
    });
    this.input.addEventListener('change', () => this.setFromText());
    this.input.addEventListener('keydown', (event) => {
      if (event.key == 'Enter') this.input.blur();
    });
    this.button = el('img', 'lb-abs', this.root);
    this.button.draggable = false;
    this.button.src = `${UI()}/StepperButton/1.png`;
    place(this.button, 75, 0);
    this.button.addEventListener('mousedown', (event) => this.onButtonDown(event));
    for (const name of ['mouseup', 'mouseleave'] as const) this.button.addEventListener(name, () => this.stopRepeat());
    this.draw();
  }

  get value(): number {
    return this.current;
  }

  set value(value: number) {
    this.current = Math.max(this.min, Math.min(this.max, Math.trunc(value) || this.min));
    this.draw();
  }

  setRange(min: number, max: number): void {
    this.min = min;
    this.max = Math.max(min, max);
    this.value = this.current;
  }

  /** выключенный степпер полупрозрачный (alpha 0.7) */
  setEnabled(value: boolean): void {
    this.enabled = value;
    this.input.disabled = !value;
    this.root.style.opacity = value ? '1' : '0.7';
    if (!value) this.stopRepeat();
  }

  private setFromText(): void {
    const before = this.current;
    this.value = Number(this.input.value);
    if (this.current != before) this.onChange?.(this.current);
  }

  private onButtonDown(event: MouseEvent): void {
    if (!this.enabled || event.button != 0) return;
    event.preventDefault();
    this.setFromText();
    const up = event.offsetY < 15;
    this.button.src = `${UI()}/StepperButton/${up ? 2 : 3}.png`;
    this.stepIndex = 0;
    this.repeatCounter = 0;
    this.change(up, 1);
    this.holdTimer = window.setTimeout(() => {
      this.repeatTimer = window.setInterval(() => this.repeat(up), 75);
    }, 500);
  }

  private repeat(up: boolean): void {
    this.change(up, NumStepper.STEPS[this.stepIndex]);
    this.repeatCounter += 1;
    if (this.repeatCounter >= 7 && this.stepIndex + 1 < NumStepper.STEPS.length && this.current % NumStepper.STEPS[this.stepIndex + 1] == 0) {
      this.repeatCounter = 0;
      this.stepIndex += 1;
    }
  }

  private change(up: boolean, step: number): void {
    const before = this.current;
    this.value = this.current + (up ? step : -step);
    if (this.current != before) this.onChange?.(this.current);
  }

  private stopRepeat(): void {
    window.clearTimeout(this.holdTimer);
    window.clearInterval(this.repeatTimer);
    this.holdTimer = 0;
    this.repeatTimer = 0;
    this.button.src = `${UI()}/StepperButton/1.png`;
  }

  private draw(): void {
    this.input.value = String(this.current);
  }
}

export function formatMoney(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

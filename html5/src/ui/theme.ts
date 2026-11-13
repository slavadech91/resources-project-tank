/**
 * Тема интерфейса лобби и верхней панели боя: красно-тёмно-серая (настройка «Красная тема») или зелёно-серая оригинала.
 * Картинки темы — полная перекрашенная копия: tools/recolor_ui_theme.py -> public/themes/red (оригиналы не тронуты).
 * CSS темы — ui/theme.css под классом html.theme-red. Уже построенные окна при переключении перекрашиваются
 * заменой путей картинок и цветов в DOM, новые строятся сразу с путями и цветами текущей темы.
 */
import './theme.css';
import './glass.css';

const RED_ROOT = 'themes/red/';
let redTheme = false;

/** цвета текста и заливок оригинала -> цвета темы */
const RED_COLORS: Record<string, string> = {
  '#59ff32': '#ff5a46', // светло-зелёный текст (строки списка боёв, названия в гараже)
  '#0c220d': '#240f0e', // TankWindowInner.GREEN — фон внутренних окон
  '#05d118': '#e8382c', // зелёный текст характеристик
  '#86ff04': '#ff7a4a', // UpgradeColors.LIGHT_GREEN
  '#84a867': '#b97c70', // установленная пушка в гараже
};

export function isRedTheme(): boolean {
  return redTheme;
}

/** путь к картинкам лобби ('/lobby/ui' или '/themes/red/lobby/ui') */
export function lobbyUi(): string {
  return `/${redTheme ? RED_ROOT : ''}lobby/ui`;
}

/** путь к картинкам HUD относительно страницы ('battle/hud' или 'themes/red/battle/hud') */
export function hudBase(): string {
  return `${redTheme ? RED_ROOT : ''}battle/hud`;
}

export function themed(color: string): string {
  return redTheme ? (RED_COLORS[color.toLowerCase()] ?? color) : color;
}

/** современный интерфейс (html.ui-glass, ui/glass.css): только CSS, геометрия окон не меняется */
export function setGlassUi(enabled: boolean): void {
  if (enabled == isGlassUi()) return;
  document.documentElement.classList.toggle('ui-glass', enabled);
  // у современного интерфейса своя раскладка верхней панели (BattleHud.layout)
  window.dispatchEvent(new Event(GLASS_UI_EVENT));
}

export const GLASS_UI_EVENT = 'tanki-glass-ui';

export function isGlassUi(): boolean {
  return document.documentElement.classList.contains('ui-glass');
}

/** включить/выключить красную тему; при смене перекрашивает уже построенный интерфейс */
export function setRedTheme(enabled: boolean): void {
  document.documentElement.classList.toggle('theme-red', enabled);
  if (enabled == redTheme) return;
  redTheme = enabled;
  restyle(document.body);
}

const PATH = /(^|["'(/])(lobby\/ui\/|battle\/hud\/)/g;

function convertPath(value: string): string {
  return redTheme ? value.replace(PATH, `$1${RED_ROOT}$2`).replace(/themes\/red\/themes\/red\//g, RED_ROOT) : value.replace(/themes\/red\//g, '');
}

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** rgb(...) как его отдаёт style -> цвет другой темы */
const COLOR_SWAP = new Map<string, string>();
for (const [green, red] of Object.entries(RED_COLORS)) {
  COLOR_SWAP.set(rgb(green), red);
  COLOR_SWAP.set(rgb(red), green);
}

function restyle(root: HTMLElement): void {
  for (const node of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    if (node instanceof HTMLImageElement) {
      const src = node.getAttribute('src');
      if (src) {
        const next = convertPath(src);
        if (next != src) node.setAttribute('src', next);
      }
    }
    const style = node.style;
    if (style.backgroundImage) {
      const next = convertPath(style.backgroundImage);
      if (next != style.backgroundImage) style.backgroundImage = next;
    }
    for (const property of ['color', 'backgroundColor'] as const) {
      const value = style[property];
      const swap = value ? COLOR_SWAP.get(value) : undefined;
      if (swap) style[property] = swap;
    }
  }
}

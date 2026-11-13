/**
 * Экран загрузки интерфейса: запуск страницы, главное меню после входа и разделы «Битвы» / «Гараж».
 * Пока раздел не готов (пространство от сервера, окна построены, картинки и модель танка загружены), его не видно —
 * поверх лежит экран с полосой прогресса. Загрузка из кэша короче SHOW_DELAY_MS экран не показывает вовсе.
 */

import './loader.css';

const SHOW_DELAY_MS = 120;

export class LobbyLoader {
  private readonly root = document.createElement('div');
  private readonly caption = document.createElement('div');
  private readonly fill = document.createElement('div');
  private readonly percent = document.createElement('div');
  private timer = 0;
  private active = false;
  private fraction = 0;

  constructor(parent: HTMLElement) {
    this.root.className = 'lobby-loader';
    this.root.hidden = true;
    this.caption.className = 'lobby-loader-caption';
    const bar = document.createElement('div');
    bar.className = 'lobby-loader-bar';
    this.fill.className = 'lobby-loader-fill';
    bar.appendChild(this.fill);
    this.percent.className = 'lobby-loader-percent';
    const box = document.createElement('div');
    box.className = 'lobby-loader-box';
    box.append(this.caption, bar, this.percent);
    this.root.appendChild(box);
    parent.appendChild(this.root);
  }

  get loading(): boolean {
    return this.active;
  }

  /** full — на весь экран (запуск, вход), иначе под верхней панелью; повторный start меняет только подпись */
  start(caption: string, full = false): void {
    this.caption.textContent = caption;
    if (this.active) return;
    this.active = true;
    this.fraction = 0;
    this.render();
    this.root.classList.toggle('lobby-loader-full', full);
    window.clearTimeout(this.timer);
    if (full) this.root.hidden = false;
    else this.timer = window.setTimeout(() => (this.root.hidden = !this.active), SHOW_DELAY_MS);
  }

  /** доля 0..1; прогресс не уходит назад */
  progress(fraction: number): void {
    if (!this.active) return;
    this.fraction = Math.max(this.fraction, Math.min(1, fraction));
    this.render();
  }

  stop(): void {
    this.active = false;
    window.clearTimeout(this.timer);
    this.root.hidden = true;
  }

  private render(): void {
    const value = Math.round(this.fraction * 100);
    this.fill.style.width = `${value}%`;
    this.percent.textContent = `${value}%`;
  }
}

/** Ждёт картинки внутри root (ещё не загруженные), сообщая долю загруженных; не дольше timeoutMs */
export function waitForImages(root: ParentNode, onProgress: (fraction: number) => void, timeoutMs = 15000): Promise<void> {
  const pending = [...root.querySelectorAll('img')].filter((image) => image.src && !image.complete);
  if (pending.length == 0) {
    onProgress(1);
    return Promise.resolve();
  }
  let done = 0;
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, timeoutMs);
    for (const image of pending) {
      const finish = (): void => {
        onProgress(++done / pending.length);
        if (done < pending.length) return;
        window.clearTimeout(timer);
        resolve();
      };
      image.addEventListener('load', finish, { once: true });
      image.addEventListener('error', finish, { once: true });
    }
  });
}

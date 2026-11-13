/**
 * Экран загрузки боя (loaderWindowService клиента): закрывает экран от «В бой» до готовности боя —
 * карта построена и пришёл первый PREPARE_TO_SPAWN (BattleReadinessService.unlockMap + unlockUser).
 */
export class BattleLoader {
  private readonly root: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'battle-loader';
    this.root.hidden = true;
    const text = document.createElement('div');
    text.className = 'battle-loader-text';
    text.textContent = 'Загрузка боя…';
    const bar = document.createElement('div');
    bar.className = 'battle-loader-bar';
    bar.appendChild(document.createElement('div'));
    this.root.append(text, bar);
    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }
}

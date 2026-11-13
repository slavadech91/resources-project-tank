/**
 * controls.SuicideIndicator (символ 611 из 0_tank_gui): серый круг с черепом «che» в центре экрана (BattleView).
 * Череп мигает всё чаще: следующее переключение через (конец − сейчас) / RATIO, по истечении времени индикатор гаснет.
 */

import './hud.css';

const HUD_BASE = 'battle/hud';
const ASSET_VERSION = '3';
const RATIO = 10;

export class SuicideIndicator {
  private readonly root = document.createElement('div');
  private readonly skull = document.createElement('img');
  private endTime = 0;
  private nextTime = 0;
  private frame = 0;

  constructor(parent: HTMLElement) {
    this.root.className = 'suicide-indicator';
    const background = document.createElement('img');
    background.src = `${HUD_BASE}/suicide_bg.png?v=${ASSET_VERSION}`;
    this.skull.src = `${HUD_BASE}/suicide_skull/1.png?v=${ASSET_VERSION}`;
    this.skull.className = 'suicide-skull';
    this.root.append(background, this.skull);
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  /** BattleView.showSuicideIndicator(timeMs) */
  show(timeMs: number): void {
    const now = performance.now();
    this.endTime = now + timeMs;
    this.nextTime = now + (this.endTime - now) / RATIO;
    this.skull.style.visibility = 'visible';
    this.root.hidden = false;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.tick);
  }

  /** BattleView.hideSuicideIndicator: смерть, конец боя, выход */
  hide(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.root.hidden = true;
  }

  private readonly tick = (): void => {
    const now = performance.now();
    if (now >= this.nextTime) {
      this.skull.style.visibility = this.skull.style.visibility == 'hidden' ? 'visible' : 'hidden';
      this.nextTime += (this.endTime - now) / RATIO;
    }
    if (now >= this.endTime) {
      this.hide();
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  };
}

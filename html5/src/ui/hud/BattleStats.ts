/**
 * Таблица игроков боя (StatisticsDmModel / StatisticsTeamModel → BattleStatistics):
 * пока зажат Tab — текущая статистика; после ROUND_FINISH — итоги раунда с наградой и отсчётом до рестарта
 * (StatisticsModel.roundFinish(timeToRestart, rewards)).
 */

import './hud.css';

const HUD_BASE = 'battle/hud';
const ASSET_VERSION = '3';

/** Team (team.py): 0 — DM, 1 — красные, 2 — синие */
export const STAT_TEAM = { NONE: 0, RED: 1, BLUE: 2 } as const;

export interface StatRow {
  userId: number;
  name: string;
  rank: number;
  kills: number;
  deaths: number;
  score: number;
  team: number;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

/** Порядок как в таблице оригинала: очки, затем убийства, затем меньше смертей */
function compareRows(a: StatRow, b: StatRow): number {
  return b.score - a.score || b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name);
}

function ratio(row: StatRow): string {
  if (row.deaths == 0) return row.kills > 0 ? String(row.kills) : '—';
  return (row.kills / row.deaths).toFixed(2);
}

export class BattleStats {
  private readonly root = element('div', 'stats-root');
  private readonly title = element('div', 'stats-title', this.root);
  private readonly subtitle = element('div', 'stats-subtitle', this.root);
  private readonly tables = element('div', 'stats-tables', this.root);
  /** TeamScoreIndicator: счёт команд вверху по центру, только в командном бою */
  private readonly teamScore = element('div', 'team-score');
  private readonly redScore = element('span', 'team-score-red', this.teamScore, '0');
  private readonly blueScore = element('span', 'team-score-blue', this.teamScore, '0');
  private rows: StatRow[] = [];
  private localUserId = 0;
  private teamScores: [number, number] = [0, 0];
  private tabDown = false;
  private finished = false;
  private rewards = new Map<number, number>();
  private restartAt = 0;
  private countdown = 0;
  private enabled = false;
  private externalTeamScore=false;
  setExternalTeamScore(value:boolean):void {this.externalTeamScore=value;this.updateTeamScore();}

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code != 'Tab' || !this.enabled) return;
    event.preventDefault();
    if (this.tabDown) return;
    this.tabDown = true;
    this.refresh();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code != 'Tab') return;
    event.preventDefault();
    this.tabDown = false;
    this.refresh();
  };

  constructor(parent: HTMLElement) {
    parent.appendChild(this.root);
    this.root.hidden = true;
    parent.appendChild(this.teamScore);
    this.teamScore.hidden = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => {
      this.tabDown = false;
      this.refresh();
    });
  }

  /** вход в бой / выход: таблица работает только в бою */
  setEnabled(enabled: boolean, localUserId = 0): void {
    this.enabled = enabled;
    this.localUserId = localUserId;
    if (!enabled) {
      this.rows = [];
      this.rewards.clear();
      this.finished = false;
      this.tabDown = false;
      window.clearInterval(this.countdown);
      this.countdown = 0;
    }
    this.updateTeamScore();
    this.refresh();
  }

  setRows(rows: StatRow[]): void {
    this.rows = rows;
    this.updateTeamScore();
    if (!this.root.hidden) this.render();
  }

  setTeamScores(red: number, blue: number): void {
    this.teamScores = [red, blue];
    this.redScore.textContent = String(red);
    this.blueScore.textContent = String(blue);
    this.updateTeamScore();
    if (!this.root.hidden) this.render();
  }

  private updateTeamScore(): void {
    this.teamScore.hidden = !(!this.externalTeamScore && this.enabled && this.rows.some((row) => row.team != STAT_TEAM.NONE));
  }

  /** StatisticsModel.roundFinish: итоги видны сами, без Tab, до рестарта */
  showFinish(timeToRestartSec: number, rewards: Map<number, number>): void {
    this.finished = true;
    this.rewards = rewards;
    this.restartAt = performance.now() + timeToRestartSec * 1000;
    window.clearInterval(this.countdown);
    this.countdown = window.setInterval(() => this.updateSubtitle(), 250);
    this.refresh();
  }

  /** BattleRestart / roundStart: итоги убираются */
  hideFinish(): void {
    this.finished = false;
    this.rewards.clear();
    window.clearInterval(this.countdown);
    this.countdown = 0;
    this.refresh();
  }

  private refresh(): void {
    const visible = this.enabled && (this.finished || this.tabDown);
    this.root.hidden = !visible;
    if (visible) this.render();
  }

  private updateSubtitle(): void {
    if (!this.finished) {
      this.subtitle.textContent = '';
      return;
    }
    const left = Math.max(0, Math.ceil((this.restartAt - performance.now()) / 1000));
    this.subtitle.textContent = `Новый бой начнётся через ${left} с`;
  }

  private render(): void {
    this.root.classList.toggle('stats-finished', this.finished);
    this.title.textContent = this.finished ? 'Бой окончен' : 'Статистика боя';
    this.updateSubtitle();
    this.tables.replaceChildren();
    const team = this.rows.some((row) => row.team != STAT_TEAM.NONE);
    if (!team) {
      this.renderTable([...this.rows].sort(compareRows), null);
      return;
    }
    this.renderTable(this.rows.filter((row) => row.team == STAT_TEAM.RED).sort(compareRows), STAT_TEAM.RED);
    this.renderTable(this.rows.filter((row) => row.team == STAT_TEAM.BLUE).sort(compareRows), STAT_TEAM.BLUE);
  }

  private renderTable(rows: StatRow[], team: number | null): void {
    const box = element('div', 'stats-table', this.tables);
    if (team != null) {
      box.classList.add(team == STAT_TEAM.RED ? 'stats-red' : 'stats-blue');
      const score = team == STAT_TEAM.RED ? this.teamScores[0] : this.teamScores[1];
      element('div', 'stats-team', box, `${team == STAT_TEAM.RED ? 'Красные' : 'Синие'}: ${score}`);
    }
    const table = element('table', '', box);
    const head = element('tr', 'stats-head', table);
    const columns = ['#', '', 'Игрок', 'Уничтожил', 'Подбит', 'У/П', 'Очки'];
    if (this.finished) columns.push('Награда');
    for (const caption of columns) element('th', '', head, caption);
    rows.forEach((row, index) => {
      const line = element('tr', row.userId == this.localUserId ? 'stats-local' : '', table);
      element('td', 'stats-place', line, String(index + 1));
      const rankCell = element('td', 'stats-rank', line);
      const icon = element('img', '', rankCell);
      icon.src = `${HUD_BASE}/rank_normal/${Math.max(1, row.rank)}.png?v=${ASSET_VERSION}`;
      element('td', 'stats-name', line, row.name);
      element('td', '', line, String(row.kills));
      element('td', '', line, String(row.deaths));
      element('td', '', line, ratio(row));
      element('td', '', line, String(row.score));
      if (this.finished) element('td', 'stats-reward', line, String(this.rewards.get(row.userId) ?? 0));
    });
  }
}

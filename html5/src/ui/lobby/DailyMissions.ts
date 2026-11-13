import type { Connection } from '../../net2/Connection.ts';
import type { DailyMissionsState } from '../../net2/protocol.ts';
import { errorText } from '../../net2/S2Client.ts';
import { TankWindow, WindowInner, INNER } from './widgets.ts';
import './daily-missions.css';

const template = `
  <div class="missions-window">
    <h2 id="missions-title"><img src="/lobby/missions/header-ru.png" alt="Задания" width="188" height="43"></h2>
    <div class="missions-tabs" role="tablist" aria-label="Разделы заданий">
      <button type="button" class="missions-button" role="tab" aria-selected="false" disabled>Основные</button>
      <button type="button" class="missions-button" role="tab" id="missions-daily-tab" aria-controls="missions-daily">Ежедневные</button>
      <button type="button" class="missions-button" role="tab" aria-selected="false" disabled>Еженедельные</button>
      <button type="button" class="missions-button" role="tab" id="missions-challenges-tab" aria-controls="missions-challenges">Челленджи</button>
    </div>
    <section id="missions-daily" role="tabpanel" aria-labelledby="missions-daily-tab">
      <div class="daily-missions-list"></div>
      <p class="daily-missions-status" role="status"></p>
    </section>
    <section id="missions-challenges" role="tabpanel" aria-labelledby="missions-challenges-tab" hidden>
      <div class="missions-challenge-level"><strong>0</strong><span>Уровень</span></div>
      <div class="missions-challenge-silver"><img src="/lobby/missions/diamond-silver.png" alt="Обычные награды"></div>
      <div class="missions-challenge-gold"><img src="/lobby/missions/diamond-gold.png" alt="Премиальные награды"></div>
      <div class="missions-challenge-summary">
        <div class="missions-challenge-stars"><img src="/lobby/missions/diamond-star.png" alt="">Звёзды 0/0</div>
        <div class="missions-challenge-clock" title="Сезон не запущен"><img src="/lobby/missions/diamond-clock.png" alt=""><span aria-label="Сезон не запущен">—</span></div>
      </div>
      <div class="missions-challenge-rewards"></div>
    </section>
    <form method="dialog"><button class="missions-button" type="submit">Закрыть</button></form>
  </div>
`;

type MissionTab = 'daily' | 'challenges';

// Narukami TimeFormatter: два соседних разряда, нулевой младший разряд скрыт.
function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  if (hours >= 24) return '1д';
  if (hours) return minutes ? `${hours}ч ${minutes}м` : `${hours}ч`;
  if (minutes) return seconds ? `${minutes}м ${seconds}с` : `${minutes}м`;
  return `${seconds}с`;
}

export class DailyMissions {
  private readonly dialog = document.createElement('dialog');
  private readonly tabs: Record<MissionTab, HTMLButtonElement>;
  private readonly panels: Record<MissionTab, HTMLElement>;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private openId = 0;
  private resetTimer: number | undefined;

  constructor(parent: HTMLElement) {
    this.dialog.className = 'daily-missions';
    this.dialog.setAttribute('aria-labelledby', 'missions-title');
    this.dialog.innerHTML = template;
    const frame = new TankWindow(this.dialog.querySelector('.missions-window')!);
    frame.root.classList.add('missions-frame');
    this.tabs = {
      daily: this.dialog.querySelector('#missions-daily-tab')!,
      challenges: this.dialog.querySelector('#missions-challenges-tab')!,
    };
    this.panels = {
      daily: this.dialog.querySelector('#missions-daily')!,
      challenges: this.dialog.querySelector('#missions-challenges')!,
    };
    const rewards = new WindowInner(this.dialog.querySelector('.missions-challenge-rewards')!, INNER.GREEN);
    rewards.root.classList.add('missions-frame');
    this.list = this.dialog.querySelector('.daily-missions-list')!;
    this.status = this.dialog.querySelector('.daily-missions-status')!;
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.stopCountdown();
    });
    for (const tab of ['daily', 'challenges'] as const) {
      const button = this.tabs[tab];
      button.addEventListener('click', () => this.selectTab(tab));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'daily' : event.key === 'End' ? 'challenges' : tab === 'daily' ? 'challenges' : 'daily';
        this.selectTab(next);
        this.tabs[next].focus();
      });
    }
    this.selectTab('daily');
    parent.append(this.dialog);
  }

  async open(connection: Connection): Promise<void> {
    if (this.dialog.open) return;
    const openId = ++this.openId;
    this.stopCountdown();
    this.selectTab('daily');
    this.dialog.showModal();
    await this.loadMissions(connection, openId);
  }

  private async loadMissions(connection: Connection, openId: number): Promise<void> {
    this.list.replaceChildren();
    this.status.textContent = 'Загрузка…';
    try {
      const state = await connection.request('missions.list', {});
      if (this.isCurrent(openId)) this.render(connection, state, openId);
    } catch {
      if (this.isCurrent(openId)) this.status.textContent = 'Не удалось загрузить задания';
    }
  }

  private selectTab(selected: MissionTab): void {
    for (const tab of ['daily', 'challenges'] as const) {
      const active = tab === selected;
      this.tabs[tab].setAttribute('aria-selected', String(active));
      this.tabs[tab].tabIndex = active ? 0 : -1;
      this.panels[tab].hidden = !active;
    }
  }

  private isCurrent(openId: number): boolean {
    return this.dialog.open && openId === this.openId;
  }

  private stopCountdown(): void {
    window.clearInterval(this.resetTimer);
    this.resetTimer = undefined;
  }

  private render(connection: Connection, { day, resetInMs, missions }: DailyMissionsState, openId: number): void {
    this.stopCountdown();
    this.status.textContent = '';
    this.list.replaceChildren(...missions.map(mission => {
      const row = document.createElement('article');
      const card = document.createElement('div');
      card.className = 'daily-mission-card';
      const frame = new WindowInner(card, INNER.GREEN);
      frame.root.classList.add('missions-frame');
      const art = document.createElement('div');
      art.className = 'daily-mission-art';
      art.setAttribute('aria-hidden', 'true');
      const details = document.createElement('div');
      details.className = 'daily-mission-details';
      if (mission.claimed) {
        card.classList.add('daily-mission-completed');
        const timer = document.createElement('div');
        timer.className = 'daily-mission-countdown';
        timer.setAttribute('role', 'timer');
        timer.setAttribute('aria-label', 'До нового задания');
        timer.innerHTML = '<img src="/lobby/missions/completed-clock.png" alt=""><span class="daily-mission-time"></span>';
        card.append(timer);
        art.innerHTML = '<img src="/lobby/missions/completed-star.png" alt="" width="280" height="120">';
        details.innerHTML = '<p>Эта миссия была выполнена.</p><p>Возвращайся в игру завтра за новой миссией.</p>';
      } else {
        art.dataset.kind = mission.id;
        const icon = { kills: 'skull', score: 'star', boxes: 'box' }[mission.id];
        for (let i = 0; i < 3; i++) {
          const image = document.createElement('img');
          image.src = `/lobby/missions/${icon}.png`;
          image.alt = '';
          art.append(image);
        }
        details.innerHTML = '<div><span>Задание</span><div class="daily-mission-objective"><strong></strong><output></output></div></div><div><span>Награда</span><div class="daily-mission-reward"></div></div>';
        details.querySelector('strong')!.textContent = mission.title;
        details.querySelector('output')!.textContent = `${mission.progress}/${mission.target}`;
        details.querySelector('.daily-mission-reward')!.textContent = `Кристаллы × ${mission.reward}`;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Забрать приз';
      button.disabled = mission.claimed || mission.progress < mission.target;
      if (!button.disabled) {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const next = await connection.request('missions.claim', { missionId: mission.id, day });
            if (this.isCurrent(openId)) this.render(connection, next, openId);
          } catch (error) {
            if (!this.isCurrent(openId)) return;
            this.status.textContent = errorText(error);
            button.disabled = false;
          }
        });
      }
      card.append(art, details);
      row.append(card, button);
      return row;
    }));

    const countdowns = this.list.querySelectorAll('.daily-mission-time');
    const resetAt = performance.now() + resetInMs;
    const tick = () => {
      const remainingMs = resetAt - performance.now();
      const label = formatCountdown(remainingMs);
      for (const countdown of countdowns) countdown.textContent = label;
      if (remainingMs <= 0) {
        this.stopCountdown();
        if (this.isCurrent(openId)) void this.loadMissions(connection, openId);
      }
    };
    this.resetTimer = window.setInterval(tick, 1000);
    tick();
  }
}

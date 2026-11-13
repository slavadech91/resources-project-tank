/**
 * Чат боя (chat_service.py сервера): Enter — открыть строку ввода, Enter ещё раз — отправить, Esc — закрыть.
 * Сообщения видят html5-игроки того же боя. Текст с «/» — команда администратора (/help — список).
 * Пока строка ввода открыта, клавиши до управления танком не доходят.
 */

import './hud.css';
import { CHAT_KIND, type ChatMessage, type GameClient } from '../../net/client.ts';

const HUD_BASE = 'battle/hud';
/** как в BattleStats: значки званий из той же папки */
const ASSET_VERSION = '3';
const MAX_LINES = 40;
/** сообщения видны столько, потом гаснут (при открытом вводе видна вся история) */
const SHOW_MS = 15000;

interface Line {
  node: HTMLElement;
  at: number;
}

export class BattleChat {
  private readonly root = document.createElement('div');
  private readonly log = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly lines: Line[] = [];
  private client: GameClient | null = null;
  /** свой отправитель (server2): текст уходит запросом battle.chat */
  private sender: ((text: string) => void) | null = null;
  /** права администратора, если клиент их не сообщает (server2 берёт из профиля) */
  private admin: boolean | null = null;
  private enabled = false;
  private readonly timer: number;

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || this.isOpen || event.code != 'Enter' && event.code != 'NumpadEnter') return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName == 'INPUT' || target.tagName == 'TEXTAREA' || target.tagName == 'SELECT')) return;
    event.preventDefault();
    this.open();
  };

  constructor(parent: HTMLElement) {
    this.root.className = 'chat-root';
    this.log.className = 'chat-log';
    this.input.className = 'chat-input';
    this.input.maxLength = 200;
    this.input.hidden = true;
    this.root.append(this.log, this.input);
    parent.appendChild(this.root);
    this.root.hidden = true;

    window.addEventListener('keydown', this.onWindowKeyDown);
    // клавиши в строке ввода не доходят до танка, инвентаря, таблицы и самоуничтожения (они слушают window)
    this.input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.code == 'Enter' || event.code == 'NumpadEnter') {
        event.preventDefault();
        this.send();
      } else if (event.code == 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    this.input.addEventListener('keyup', (event) => event.stopPropagation());
    this.input.addEventListener('blur', () => this.close());
    this.timer = window.setInterval(() => this.fade(), 1000);
  }

  /** подписка на сообщения клиента (после входа) */
  attach(client: GameClient): void {
    this.client = client;
    this.admin = null;
    client.on('chat', (message) => this.add(message));
    client.on('admin', () => this.updatePlaceholder());
    this.updatePlaceholder();
  }

  /** server2: отправитель текста (null — снова через старый клиент) */
  setSender(sender: ((text: string) => void) | null): void {
    this.sender = sender;
  }

  setAdmin(admin: boolean): void {
    this.admin = admin;
    this.updatePlaceholder();
  }

  /** сообщение сервера (server2: событие battle.chat) */
  receive(message: ChatMessage): void {
    this.add(message);
  }

  /** чат работает только в бою */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.hidden = !enabled;
    if (!enabled) {
      this.close();
      this.lines.length = 0;
      this.log.replaceChildren();
    }
  }

  get isOpen(): boolean {
    return !this.input.hidden;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onWindowKeyDown);
    window.clearInterval(this.timer);
    this.root.remove();
  }

  private open(): void {
    // зажатые клавиши движения отпустятся в строке ввода, а их keyup туда и уйдёт: отпускаем всё сразу
    window.dispatchEvent(new Event('blur'));
    this.input.hidden = false;
    this.root.classList.add('chat-open');
    this.input.focus();
    this.fade();
  }

  private close(): void {
    if (this.input.hidden) return;
    this.input.value = '';
    this.input.hidden = true;
    this.root.classList.remove('chat-open');
    this.input.blur();
    this.fade();
  }

  private send(): void {
    const text = this.input.value.trim();
    this.close();
    if (!text) return;
    try {
      if (this.sender) this.sender(text);
      else this.client?.sendChat(text);
    } catch (error) {
      this.add({ author: '', rank: 0, kind: CHAT_KIND.REPLY, text: `не отправлено: ${String(error)}` });
    }
  }

  private updatePlaceholder(): void {
    this.input.placeholder = (this.admin ?? this.client?.isAdmin) ? 'Сообщение или команда (/help)' : 'Сообщение';
  }

  private add(message: ChatMessage): void {
    const node = document.createElement('div');
    node.className = 'chat-line';
    if (message.kind == CHAT_KIND.PLAYER) {
      const icon = document.createElement('img');
      icon.src = `${HUD_BASE}/rank_normal/${Math.max(1, message.rank)}.png?v=${ASSET_VERSION}`;
      const author = document.createElement('span');
      author.className = 'chat-author';
      author.textContent = `${message.author}: `;
      node.append(icon, author, document.createTextNode(message.text));
    } else {
      node.classList.add(message.kind == CHAT_KIND.SYSTEM ? 'chat-system' : 'chat-reply');
      node.textContent = message.text;
    }
    this.log.appendChild(node);
    this.lines.push({ node, at: performance.now() });
    while (this.lines.length > MAX_LINES) this.lines.shift()?.node.remove();
    this.log.scrollTop = this.log.scrollHeight;
    this.fade();
  }

  private fade(): void {
    const now = performance.now();
    for (const line of this.lines) line.node.classList.toggle('chat-faded', !this.isOpen && now - line.at > SHOW_MS);
  }
}

// Отладка рассинхрона (F7): что сервер прислал, а бой html5 не обработал, и насколько чужие танки расходятся с сервером.
// Призрак — рамка корпуса там, где танк по последнему MOVE от сервера, и линия до него от того, что рисует клиент;
// цвет — по величине поправки при последнем MOVE (её видно глазом как рывок). Панель обновляется 5 раз в секунду.
import * as THREE from 'three';
import { Quaternion } from '../../physics/math/Quaternion.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { Matrix4 } from '../../physics/math/Matrix4.ts';
import type { Tank } from '../tank/Tank.ts';

/** выключатель всей отладки: false — F7 ничего не делает, команды и MOVE не записываются, панель не создаётся (ради FPS) */
export const DESYNC_DEBUG_AVAILABLE = false;
const STORAGE_KEY = 'tanki.desyncDebug';
/** окно, за которое показывается наибольшая поправка */
const CORRECTION_WINDOW_MS = 10000;
/** поправки, см (1 м = 100): до OK — зелёный, до WARN — жёлтый, дальше — красный */
const CORRECTION_OK = 50;
const CORRECTION_WARN = 150;
const PANEL_UPDATE_MS = 200;
const RECENT_LIMIT = 14;
const EFFECT_NAMES: Record<number, string> = { 1: 'аптечка', 2: 'броня', 3: 'урон', 4: 'нитро' };

let enabled = false;
try {
  enabled = localStorage.getItem(STORAGE_KEY) == '1';
} catch {
  enabled = false;
}

export function isDesyncDebugEnabled(): boolean {
  return DESYNC_DEBUG_AVAILABLE && enabled;
}

/** F7: включить/выключить; выбор помнится в браузере */
export function toggleDesyncDebug(): boolean {
  if (!DESYNC_DEBUG_AVAILABLE) return false;
  enabled = !enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // без хранилища — только до перезагрузки
  }
  return enabled;
}

export function effectName(index: number): string {
  return EFFECT_NAMES[index] ?? `эффект ${index}`;
}

/** Последнее состояние чужого танка от сервера (MOVE) и поправки, которые оно вызвало */
export class ServerTankState {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly orientation = new Quaternion();
  /** время последнего нового сэмпла (performance.now), 0 — не было */
  time = 0;
  moves = 0;
  /** сэмпл пришёл, когда танк мёртв или не на поле — клиент его выбросил */
  ignoredMoves = 0;
  /** последний скачок данных, ушедший в сглаживаемую поправку (синхронизация v2), единицы карты (см) */
  lastCorrection = 0;
  private readonly corrections: { time: number; value: number }[] = [];

  record(correction: number, position: Vector3, orientation: Quaternion, velocity: Vector3): void {
    const now = performance.now();
    this.lastCorrection = correction;
    this.position.copy(position);
    this.velocity.copy(velocity);
    this.orientation.copy(orientation);
    this.time = now;
    this.moves++;
    this.corrections.push({ time: now, value: this.lastCorrection });
    while (this.corrections.length > 0 && now - this.corrections[0].time > CORRECTION_WINDOW_MS) this.corrections.shift();
  }

  maxCorrection(): number {
    const now = performance.now();
    let max = 0;
    for (const entry of this.corrections) if (now - entry.time <= CORRECTION_WINDOW_MS) max = Math.max(max, entry.value);
    return max;
  }
}

/** что стало с командой сервера в бою html5 */
export type CommandStatus = 'ok' | 'ignored' | 'no-object' | 'undecoded';

const STATUS_TEXT: Record<CommandStatus, string> = {
  ok: 'обработана',
  ignored: 'пропущена',
  'no-object': 'нет танка',
  undecoded: 'не разобрана',
};

export interface DesyncLocalInfo {
  tank: Tank;
  spawned: boolean;
  activated: boolean;
  /** когда ушло последнее SYNC_STATE (performance.now) */
  lastSentTime: number;
  specificationId: number;
  effects: string;
  /** часы и задержка отрисовки синхронизации v2 */
  sync: string;
}

export interface DesyncRemoteInfo {
  id: number;
  name: string;
  tank: Tank;
  active: boolean;
  state: ServerTankState;
  effects: string;
  /** буфер снапшотов: сэмплов, экстраполяция, текущая поправка */
  sync: string;
}

interface Ghost {
  root: THREE.Group;
  box: THREE.LineSegments;
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function correctionColor(value: number): string {
  if (value < CORRECTION_OK) return '#5ee06a';
  if (value < CORRECTION_WARN) return '#f2d24b';
  return '#ff5a4f';
}

function meters(value: number): string {
  return (value / 100).toFixed(2);
}

function ago(time: number, now: number): string {
  return time == 0 ? '—' : `${((now - time) / 1000).toFixed(1)} с`;
}

export class DesyncDebug {
  private readonly panel: HTMLDivElement;
  private readonly group = new THREE.Group();
  private readonly ghosts = new Map<number, Ghost>();
  /** пропущенные команды: ключ — имя и чья, значение — сколько и когда последняя */
  private readonly problems = new Map<string, { count: number; time: number; status: CommandStatus }>();
  private readonly totals: Record<CommandStatus, number> = { ok: 0, ignored: 0, 'no-object': 0, undecoded: 0 };
  private readonly recent: { time: number; text: string; status: CommandStatus }[] = [];
  private lastPanelUpdate = 0;
  private shown = false;

  constructor(private readonly world: THREE.Object3D) {
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      maxWidth: 'min(620px, calc(100vw - 16px))',
      maxHeight: 'calc(100vh - 16px)',
      overflow: 'auto',
      padding: '8px 10px',
      background: 'rgba(0, 0, 0, 0.72)',
      color: '#e6e6e6',
      font: '12px/1.35 Consolas, monospace',
      whiteSpace: 'pre',
      zIndex: '50',
      pointerEvents: 'none',
      borderRadius: '4px',
    } satisfies Partial<CSSStyleDeclaration>);
    this.panel.hidden = true;
    document.body.appendChild(this.panel);
    this.group.name = 'desync-debug';
    this.group.visible = false;
    world.add(this.group);
  }

  /** каждая команда пространства боя; who — свой танк, ник или id объекта */
  recordCommand(name: string | null, commandId: number, who: string, status: CommandStatus): void {
    this.totals[status]++;
    const label = name ?? `#${commandId}`;
    if (status != 'ok') {
      const key = `${label} — ${who}`;
      const problem = this.problems.get(key) ?? { count: 0, time: 0, status };
      problem.count++;
      problem.time = performance.now();
      problem.status = status;
      this.problems.set(key, problem);
    }
    // MOVE и повороты башни идут постоянно — в ленту только остальное
    if (status == 'ok' && (label == 'MOVE' || label == 'ROTATE_TURRET' || label == 'UPDATE_MOVEMENT_CONTROL')) return;
    this.recent.push({ time: performance.now(), text: `${label} — ${who}`, status });
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
  }

  update(local: DesyncLocalInfo, remotes: DesyncRemoteInfo[]): void {
    const visible = isDesyncDebugEnabled();
    if (visible != this.shown) {
      this.shown = visible;
      this.panel.hidden = !visible;
      this.group.visible = visible;
    }
    if (!visible) return;
    this.updateGhosts(remotes);
    const now = performance.now();
    if (now - this.lastPanelUpdate < PANEL_UPDATE_MS) return;
    this.lastPanelUpdate = now;
    this.panel.innerHTML = this.renderPanel(local, remotes, now);
  }

  private updateGhosts(remotes: DesyncRemoteInfo[]): void {
    const seen = new Set<number>();
    for (const remote of remotes) {
      const state = remote.state;
      if (!remote.active || state.time == 0) continue;
      seen.add(remote.id);
      const ghost = this.ghosts.get(remote.id) ?? this.createGhost(remote.id, remote.tank);
      ghost.root.visible = true;
      ghost.root.position.set(state.position.x, state.position.y, state.position.z);
      ghost.root.quaternion.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w);
      ghost.material.color.set(correctionColor(state.lastCorrection));
      const client = remote.tank.getBody().state.position;
      const positions = ghost.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      positions.setXYZ(0, client.x, client.y, client.z);
      positions.setXYZ(1, state.position.x, state.position.y, state.position.z);
      positions.needsUpdate = true;
      ghost.line.geometry.computeBoundingSphere();
    }
    for (const [id, ghost] of this.ghosts) if (!seen.has(id)) ghost.root.visible = false;
  }

  private createGhost(id: number, tank: Tank): Ghost {
    const material = new THREE.LineBasicMaterial({ color: correctionColor(0), depthTest: false, transparent: true, opacity: 0.9 });
    const collisionBox = tank.tankBody.tankCollisionBox;
    const hs = collisionBox.hs;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(hs.x * 2, hs.y * 2, hs.z * 2)), material);
    const offset = collisionBox.localTransform as Matrix4;
    box.position.set(offset.d, offset.h, offset.l);
    const root = new THREE.Group();
    root.add(box);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(lineGeometry, material);
    line.frustumCulled = false;
    box.renderOrder = line.renderOrder = 1000;
    const ghost: Ghost = { root, box, line, material };
    this.group.add(root, line);
    this.ghosts.set(id, ghost);
    return ghost;
  }

  private renderPanel(local: DesyncLocalInfo, remotes: DesyncRemoteInfo[], now: number): string {
    const lines: string[] = [];
    const tank = local.tank;
    const speed = tank.getBody().state.velocity.length();
    lines.push('<b>Рассинхрон</b>  (F7 — скрыть; рамка — последний сэмпл танка, цвет — последний скачок данных, ушедший в сглаживание)');
    lines.push(
      `Свой: ${local.spawned ? (local.activated ? 'в бою' : 'спавн') : 'не на поле'}, скорость ${meters(speed)} / макс ${meters(tank.getMaxSpeed())} м/с, ` +
        `состояние отправлено ${ago(local.lastSentTime, now)} назад, spec ${local.specificationId}${local.effects ? `, ${escapeHtml(local.effects)}` : ''}`,
    );
    lines.push(`Синхронизация v2: ${escapeHtml(local.sync)}`,
    );
    lines.push('');
    lines.push('Чужие танки   скачок: последний / макс за 10 с   сэмпл   скорость/макс   буфер   эффекты');
    if (remotes.length == 0) lines.push('  —');
    for (const remote of remotes) {
      const state = remote.state;
      const last = state.lastCorrection;
      const max = state.maxCorrection();
      const remoteSpeed = remote.tank.getBody().state.velocity.length();
      const serverSpeed = state.velocity.length();
      const status = remote.active ? '' : ' (не на поле)';
      const ignored = state.ignoredMoves > 0 ? `  <span style="color:#ff5a4f">сэмплов выброшено: ${state.ignoredMoves}</span>` : '';
      lines.push(
        `  ${escapeHtml(remote.name)}${status}  ` +
          `<span style="color:${correctionColor(last)}">${meters(last)} м</span> / <span style="color:${correctionColor(max)}">${meters(max)} м</span>  ` +
          `${ago(state.time, now)} назад (${state.moves})  ` +
          `${meters(remoteSpeed)}/${meters(remote.tank.getMaxSpeed())} м/с, сервер ${meters(serverSpeed)}  ${escapeHtml(remote.sync)}` +
          `${remote.effects ? `  ${escapeHtml(remote.effects)}` : ''}${ignored}`,
      );
    }
    lines.push('');
    const totals = this.totals;
    lines.push(
      `Команды сервера: обработано ${totals.ok}, <span style="color:#f2d24b">пропущено ${totals.ignored}</span>, ` +
        `<span style="color:#f2d24b">нет танка ${totals['no-object']}</span>, <span style="color:#ff5a4f">не разобрано ${totals.undecoded}</span>`,
    );
    const problems = [...this.problems.entries()].sort((a, b) => b[1].time - a[1].time).slice(0, 12);
    if (problems.length > 0) {
      lines.push('Не обработаны боем html5 (последние сверху):');
      for (const [key, problem] of problems) {
        lines.push(
          `  <span style="color:${problem.status == 'undecoded' ? '#ff5a4f' : '#f2d24b'}">×${problem.count} ${escapeHtml(key)}</span> — ${STATUS_TEXT[problem.status]}, ${ago(problem.time, now)} назад`,
        );
      }
    }
    lines.push('');
    lines.push('Последние команды (без снапшотов):');
    for (const entry of [...this.recent].reverse()) {
      const color = entry.status == 'ok' ? '#aaaaaa' : entry.status == 'undecoded' ? '#ff5a4f' : '#f2d24b';
      lines.push(`  <span style="color:${color}">${ago(entry.time, now)}  ${escapeHtml(entry.text)}${entry.status == 'ok' ? '' : ` — ${STATUS_TEXT[entry.status]}`}</span>`);
    }
    return lines.join('\n');
  }

  dispose(): void {
    this.panel.remove();
    this.world.remove(this.group);
    for (const ghost of this.ghosts.values()) {
      ghost.box.geometry.dispose();
      ghost.line.geometry.dispose();
      ghost.material.dispose();
    }
    this.ghosts.clear();
  }
}

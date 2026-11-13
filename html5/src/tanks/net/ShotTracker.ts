/**
 * Надёжная регистрация попаданий (пара серверному global_models/battle/common/shot_registry.py).
 *
 * Попадание, которое определил клиент стрелка, уходит в конверте SHOT_ENVELOPE: shotId (уникален в сессии — случайная
 * база + счётчик), номер попытки, «жизни» целей и вложенная команда протокола 2014 (Smoky FIRE_TARGET, Railgun FIRE,
 * Twins HIT). Сервер выполняет вложенную команду один раз и отвечает SHOT_ACK: applied / duplicate / rejected
 * с причиной, по каждой цели — HP, revision и жизнь.
 *
 * Без ACK конверт повторяется с тем же shotId (сервер повтор не применяет, а отвечает прежним результатом):
 * тайм-аут — от сглаженного RTT, с удвоением; попыток не больше MAX_ATTEMPTS, очередь не больше MAX_PENDING, ожидание
 * не дольше MAX_AGE_MS. TCP сам доставляет байты, поэтому повтор нужен, когда ответа нет: сервер не обработал команду
 * (исключение, перезапуск), соединение оборвалось и т.п. Неразрешённые попадания остаются в журнале с причиной.
 *
 * Эффекты попадания клиент рисует сразу, не дожидаясь ACK: журнал различает «обнаружено и отправлено» и
 * «подтверждено сервером».
 *
 * Синхронизация v2: конверт SHOT_ENVELOPE_V2 несёт ещё view_time — серверное время, в котором стрелок видел цели
 * (время отрисовки чужих танков); сервер сверяет положение цели с её историей на это время (компенсация лага).
 */

import type { GameClient } from '../../net/client.ts';
import type { ByteReader, ByteWriter } from '../../net/bytes.ts';
import { SHOT_ENVELOPE_V2 } from './sync/SyncProtocol.ts';

export const SHOT_COMMAND = {
  ENVELOPE: 390000001,
  ACK: 390000002,
  HEALTH_SYNC: 390000003,
  HEALTH_STATE: 390000004,
} as const;

const RESULT_NAMES = ['applied', 'duplicate', 'rejected'] as const;
export type ShotResult = (typeof RESULT_NAMES)[number] | 'unresolved';

/** жизнь цели неизвестна (не было HEALTH_STATE) — сервер её не проверяет */
export const UNKNOWN_LIFE = -1;

const MAX_ATTEMPTS = 4;
const MAX_PENDING = 64;
const MAX_AGE_MS = 10000;
const MIN_TIMEOUT_MS = 300;
const MAX_TIMEOUT_MS = 2500;
/** до первого замера RTT */
const INITIAL_TIMEOUT_MS = 800;
const TICK_MS = 50;
const JOURNAL_SIZE = 300;

export interface ShotTarget {
  userId: number;
  life: number;
}

export interface AckTarget {
  targetId: number;
  applied: boolean;
  reason: string;
  hp: number;
  revision: number;
  life: number;
  damage: number;
}

/** запись журнала: жизненный цикл одного попадания */
export interface ShotRecord {
  shotId: number;
  weapon: string;
  targets: number[];
  /** performance.now() обнаружения попадания клиентом */
  detectedAt: number;
  /** моменты отправок (первая и повторы) */
  sends: number[];
  ackAt: number | null;
  result: ShotResult | null;
  reason: string;
  /** только по ACK на первую отправку (без повторов — правило Карна) */
  rttMs: number | null;
  ackTargets: AckTarget[];
}

interface Pending {
  record: ShotRecord;
  objectId: number;
  commandId: number;
  targets: ShotTarget[];
  write: (writer: ByteWriter) => void;
  nextAt: number;
  /** серверное время, в котором стрелок видел цели (v2); null — конверт v1 */
  viewTime: number | null;
}

export interface ShotTrackerCallbacks {
  /** актуальное серверное HP цели из ACK */
  onTargetHealth(targetId: number, hp: number, revision: number, life: number): void;
  /** попадание не подтверждено: запросить HP целей заново */
  onUnresolved(targetIds: number[]): void;
  log(message: string): void;
}

export class ShotTracker {
  private nextId: number;
  private readonly pending = new Map<number, Pending>();
  private readonly journal: ShotRecord[] = [];
  private srtt = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly offAck: () => void;
  readonly stats = { detected: 0, resent: 0, applied: 0, duplicate: 0, rejected: 0, unresolved: 0 };

  constructor(
    private readonly client: GameClient,
    private readonly spaceName: string,
    private readonly callbacks: ShotTrackerCallbacks,
  ) {
    // случайная база: shotId не повторяются и после перезахода (сервер помнит их по игроку ~2 мин)
    this.nextId = Math.floor(Math.random() * 0x3fffffff) + 1;
    this.offAck = client.onRawCommand(SHOT_COMMAND.ACK, (spaceName, objectId, reader) => {
      if (spaceName == this.spaceName) this.onAck(objectId, reader);
    });
    this.timer = setInterval(() => this.tick(performance.now()), TICK_MS);
  }

  /** попадание обнаружено: конверт уходит сразу и ждёт ACK. write пишет аргументы вложенной команды (одинаково при повторах) */
  send(weapon: string, objectId: number, commandId: number, targets: ShotTarget[], write: (writer: ByteWriter) => void, viewTime: number | null = null): number {
    const shotId = this.nextId;
    this.nextId = this.nextId >= 0x7ffffffe ? 1 : this.nextId + 1;
    const now = performance.now();
    const record: ShotRecord = {
      shotId,
      weapon,
      targets: targets.map((target) => target.userId),
      detectedAt: now,
      sends: [],
      ackAt: null,
      result: null,
      reason: '',
      rttMs: null,
      ackTargets: [],
    };
    this.stats.detected++;
    this.remember(record);
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.values().next().value;
      if (oldest) this.resolveUnacked(oldest, 'очередь ожидания переполнена');
    }
    const pending: Pending = { record, objectId, commandId, targets, write, nextAt: 0, viewTime: viewTime == null ? null : Math.round(viewTime) | 0 };
    this.pending.set(shotId, pending);
    this.transmit(pending, now);
    return shotId;
  }

  /** бой окончен или соединение закрыто: ожидающие — неразрешённые */
  stop(reason: string): void {
    clearInterval(this.timer);
    this.offAck();
    for (const pending of [...this.pending.values()]) this.resolveUnacked(pending, reason, false);
  }

  /** журнал последних попаданий (для отладки: __tanki.shots()) */
  records(): ShotRecord[] {
    return [...this.journal];
  }

  summary(): string {
    const s = this.stats;
    return `попаданий ${s.detected}, подтверждено ${s.applied}, повтор ${s.duplicate}, отклонено ${s.rejected}, без ответа ${s.unresolved}, повторных отправок ${s.resent}, RTT ${Math.round(this.srtt)} мс, ждут ${this.pending.size}`;
  }

  private remember(record: ShotRecord): void {
    this.journal.push(record);
    if (this.journal.length > JOURNAL_SIZE) this.journal.shift();
  }

  private timeout(attempt: number): number {
    const base = this.srtt > 0 ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, this.srtt * 2 + 100)) : INITIAL_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS * 2, base * 2 ** (attempt - 1));
  }

  private transmit(pending: Pending, now: number): void {
    const attempt = pending.record.sends.length + 1;
    pending.record.sends.push(now);
    pending.nextAt = now + this.timeout(attempt);
    const viewTime = pending.viewTime;
    this.client.sendCommand(this.spaceName, pending.objectId, viewTime == null ? SHOT_COMMAND.ENVELOPE : SHOT_ENVELOPE_V2, (writer) => {
      writer.i32(pending.record.shotId);
      writer.i8(attempt);
      writer.writeLength(pending.targets.length);
      for (const target of pending.targets) {
        writer.i64(target.userId);
        writer.i32(target.life);
      }
      if (viewTime != null) writer.i32(viewTime);
      writer.i64(pending.commandId);
      pending.write(writer);
    });
  }

  private tick(now: number): void {
    for (const pending of [...this.pending.values()]) {
      if (now < pending.nextAt) continue;
      if (pending.record.sends.length >= MAX_ATTEMPTS || now - pending.record.detectedAt > MAX_AGE_MS) {
        this.resolveUnacked(pending, `нет ответа сервера после ${pending.record.sends.length} отправок`);
        continue;
      }
      this.stats.resent++;
      this.transmit(pending, now);
    }
  }

  private resolveUnacked(pending: Pending, reason: string, resync = true): void {
    this.pending.delete(pending.record.shotId);
    pending.record.result = 'unresolved';
    pending.record.reason = reason;
    this.stats.unresolved++;
    this.callbacks.log(`попадание ${pending.record.shotId} (${pending.record.weapon}) не подтверждено: ${reason}`);
    if (resync) this.callbacks.onUnresolved(pending.record.targets);
  }

  /** SHOT_ACK: shotId i32, результат i8, причина, цели [(id i64, применён i8, причина, HP i32, revision i32, жизнь i32, урон f32)] */
  private onAck(_objectId: number, reader: ByteReader): void {
    const shotId = reader.i32();
    const result = RESULT_NAMES[reader.i8()] ?? 'rejected';
    const reason = reader.str();
    const targets: AckTarget[] = [];
    const count = reader.readLength();
    for (let i = 0; i < count; i++) {
      targets.push({
        targetId: reader.i64(),
        applied: reader.i8() == 1,
        reason: reader.str(),
        hp: reader.i32(),
        revision: reader.i32(),
        life: reader.i32(),
        damage: reader.f32(),
      });
    }
    const now = performance.now();
    for (const target of targets) if (target.revision >= 0) this.callbacks.onTargetHealth(target.targetId, target.hp, target.revision, target.life);

    const pending = this.pending.get(shotId);
    if (!pending) return; // ответ на повтор, уже учтённый, или на неразрешённое — HP всё равно применили выше
    this.pending.delete(shotId);
    const record = pending.record;
    record.ackAt = now;
    record.result = result;
    record.reason = reason;
    record.ackTargets = targets;
    if (record.sends.length == 1) {
      record.rttMs = now - record.sends[0];
      this.srtt = this.srtt > 0 ? this.srtt * 0.875 + record.rttMs * 0.125 : record.rttMs;
    }
    this.stats[result]++;
    if (result == 'rejected') {
      const details = targets.filter((target) => !target.applied && target.reason).map((target) => `${target.targetId}: ${target.reason}`);
      this.callbacks.log(`попадание ${shotId} (${record.weapon}) отклонено сервером: ${[reason, ...details].filter(Boolean).join('; ')}`);
    }
  }
}

/**
 * Оценка серверного времени синхронизации (sync_service.server_ms — мс от старта процесса сервера) по SYNC_PING / PONG.
 *
 * Каждый ответ даёт RTT и смещение: serverMs + RTT / 2 − localNow. Берётся замер с наименьшим RTT из последних
 * SAMPLES (у него меньше всего очередей в туннеле, значит и ошибка половины RTT меньше). Применённое смещение к этой
 * цели подтягивается не быстрее MAX_SLEW (доля прошедшего времени): время интерполяции не прыгает, когда цель
 * меняется. Первый замер и расхождение больше SNAP_MS применяются сразу.
 */

const SAMPLES = 16;
/** не больше 5 % хода часов: 50 мс поправки — за секунду */
const MAX_SLEW = 0.05;
const SNAP_MS = 1000;
/** первые пинги — чаще, чтобы быстрее найти замер с малым RTT */
const FAST_PINGS = 6;
const FAST_INTERVAL_MS = 150;
const INTERVAL_MS = 1000;

interface ClockSample {
  rtt: number;
  offset: number;
}

export class ServerClock {
  private readonly samples: ClockSample[] = [];
  private offset = 0;
  private targetOffset = 0;
  private synced = false;
  private lastUpdate = 0;
  private nextPingAt = 0;
  private pings = 0;
  private nextPingId = 1;
  /** RTT лучшего замера и сглаженный RTT (для отладки и запаса задержки) */
  bestRtt = 0;
  smoothedRtt = 0;

  private readonly sendPing: (pingId: number, clientMs: number) => void;

  /** без свойств-параметров: модуль запускается и в node (инструменты html5/tools) */
  constructor(sendPing: (pingId: number, clientMs: number) => void) {
    this.sendPing = sendPing;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  /** серверное время для локального момента (performance.now) */
  toServer(localMs: number): number {
    return localMs + this.offset;
  }

  /** локальный момент (performance.now) для серверного времени */
  toLocal(serverMs: number): number {
    return serverMs - this.offset;
  }

  now(): number {
    return this.toServer(performance.now());
  }

  /** каждый кадр: подтягивание смещения и пинги по расписанию */
  update(localNow: number): void {
    if (this.synced) {
      const elapsed = Math.max(0, Math.min(100, localNow - this.lastUpdate));
      const maxStep = elapsed * MAX_SLEW;
      const delta = this.targetOffset - this.offset;
      this.offset += Math.max(-maxStep, Math.min(maxStep, delta));
    }
    this.lastUpdate = localNow;
    if (localNow >= this.nextPingAt) {
      this.pings++;
      this.nextPingAt = localNow + (this.pings < FAST_PINGS ? FAST_INTERVAL_MS : INTERVAL_MS);
      const pingId = this.nextPingId;
      this.nextPingId = this.nextPingId >= 0x7ffffffe ? 1 : this.nextPingId + 1;
      this.sendPing(pingId, Math.floor(localNow) | 0);
    }
  }

  /** SYNC_PONG */
  onPong(clientMs: number, serverMs: number, localNow: number): void {
    // client_ms — младшие 32 бита performance.now() в момент отправки
    const rtt = ((Math.floor(localNow) | 0) - clientMs) >>> 0;
    if (rtt > 10000) return;
    const offset = serverMs + rtt / 2 - localNow;
    this.samples.push({ rtt, offset });
    if (this.samples.length > SAMPLES) this.samples.shift();
    let best = this.samples[0];
    for (const sample of this.samples) if (sample.rtt < best.rtt) best = sample;
    this.bestRtt = best.rtt;
    this.smoothedRtt = this.smoothedRtt == 0 ? rtt : this.smoothedRtt * 0.875 + rtt * 0.125;
    this.targetOffset = best.offset;
    if (!this.synced || Math.abs(this.targetOffset - this.offset) > SNAP_MS) {
      this.offset = this.targetOffset;
      this.synced = true;
    }
  }

  get offsetMs(): number {
    return this.offset;
  }
}

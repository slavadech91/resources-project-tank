/**
 * Буфер состояний чужого танка (синхронизация v2): сэмплы из SYNC_SNAPSHOT по серверному времени снятия; состояние
 * на время отрисовки — интерполяция между соседними сэмплами, за последним — короткая экстраполяция.
 *
 * Между сэмплами: позиция — кубический сплайн Эрмита по позициям и скоростям (движение без изломов на каждом сэмпле),
 * если скорости согласуются с перемещением, иначе линейно; ориентация — slerp; башня — по кратчайшей дуге; скорости —
 * линейно. Управление (гусеницы, звук) — из сэмпла не позже времени.
 */
import { Quaternion } from '../../../physics/math/Quaternion.ts';
import { Vector3 } from '../../../physics/math/Vector3.ts';
import { seqNewer, type SyncSample } from './SyncProtocol.ts';

/** дальше последнего сэмпла танк едет по скорости не больше стольких мс, потом стоит */
export const MAX_EXTRAPOLATION_MS = 250;
/** промежуток между сэмплами длиннее — без сплайна (данных о движении между ними нет) */
const MAX_SPLINE_GAP_MS = 300;
/** скорости сэмплов «согласуются» с перемещением: отличие от средней скорости не больше 50 % + 150 см/с */
const SPLINE_VELOCITY_TOLERANCE = 0.5;
const SPLINE_VELOCITY_ALLOWANCE = 150;
const HISTORY_MS = 1500;
const MAX_SAMPLES = 64;

export class InterpolatedState {
  readonly position = new Vector3();
  readonly orientation = new Quaternion();
  readonly velocity = new Vector3();
  readonly angularVelocity = new Vector3();
  turretAngle = 0;
  chassis = 0;
  turretControl = 0;
  /** мс за последним сэмплом (0 — между сэмплами или до первого) */
  extrapolatedMs = 0;
}

const qa = new Quaternion();
const qb = new Quaternion();
const omega = new Vector3();

/** разность углов to − from по кратчайшей дуге, (−π, π] */
export function shortestArc(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  else if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function wrapAngle(angle: number): number {
  if (angle > Math.PI) return angle - Math.PI * 2;
  if (angle < -Math.PI) return angle + Math.PI * 2;
  return angle;
}

function setQuaternion(q: Quaternion, sample: SyncSample): Quaternion {
  return q.reset(sample.qw, sample.qx, sample.qy, sample.qz).normalize();
}

export class StateBuffer {
  private readonly samples: SyncSample[] = [];
  /** экстраполяция дальше последнего сэмпла, мс (у танков по MOVE старого протокола — дольше) */
  maxExtrapolationMs = MAX_EXTRAPOLATION_MS;

  get size(): number {
    return this.samples.length;
  }

  get newest(): SyncSample | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** false — повтор или старее последнего (снапшот повторяет последний сэмпл танка, пока не придёт новый) */
  push(sample: SyncSample): boolean {
    const newest = this.newest;
    if (newest) {
      if (!seqNewer(sample.seq, newest.seq)) return false;
      // время снятия идёт вперёд вместе с seq (часы отправителя подтягиваются плавно, но не назад)
      if (sample.sampleTime <= newest.sampleTime) sample.sampleTime = newest.sampleTime + 1;
    }
    this.samples.push(sample);
    const limit = sample.sampleTime - HISTORY_MS;
    while (this.samples.length > 2 && (this.samples.length > MAX_SAMPLES || this.samples[0].sampleTime < limit)) this.samples.shift();
    return true;
  }

  /** состояние на серверное время time; false — сэмплов нет */
  sample(time: number, out: InterpolatedState): boolean {
    const samples = this.samples;
    const count = samples.length;
    if (count == 0) return false;
    const last = samples[count - 1];
    if (time >= last.sampleTime) {
      this.extrapolate(last, time - last.sampleTime, out);
      return true;
    }
    const first = samples[0];
    if (time <= first.sampleTime) {
      this.copy(first, out);
      return true;
    }
    // последний сэмпл с sampleTime <= time (сэмплов немного — линейный поиск с конца)
    let index = count - 2;
    while (index > 0 && samples[index].sampleTime > time) index--;
    this.interpolate(samples[index], samples[index + 1], time, out);
    return true;
  }

  private copy(sample: SyncSample, out: InterpolatedState): void {
    out.position.reset(sample.px, sample.py, sample.pz);
    setQuaternion(out.orientation, sample);
    out.velocity.reset(sample.vx, sample.vy, sample.vz);
    out.angularVelocity.reset(sample.ax, sample.ay, sample.az);
    out.turretAngle = sample.turretAngle;
    out.chassis = sample.chassis;
    out.turretControl = sample.turretControl;
    out.extrapolatedMs = 0;
  }

  private extrapolate(sample: SyncSample, aheadMs: number, out: InterpolatedState): void {
    this.copy(sample, out);
    out.extrapolatedMs = aheadMs;
    const dt = Math.min(aheadMs, this.maxExtrapolationMs) / 1000;
    if (dt > 0) {
      out.position.x += sample.vx * dt;
      out.position.y += sample.vy * dt;
      out.position.z += sample.vz * dt;
      omega.reset(sample.ax, sample.ay, sample.az);
      out.orientation.addScaledVector(omega, dt);
    }
    if (aheadMs >= this.maxExtrapolationMs) {
      // данных нет дольше предела: танк стоит там, куда доехал
      out.velocity.reset();
      out.angularVelocity.reset();
    }
  }

  private interpolate(a: SyncSample, b: SyncSample, time: number, out: InterpolatedState): void {
    const spanMs = b.sampleTime - a.sampleTime;
    const s = spanMs > 0 ? (time - a.sampleTime) / spanMs : 1;
    const dt = spanMs / 1000;
    let spline = spanMs <= MAX_SPLINE_GAP_MS && dt > 0;
    if (spline) {
      const mx = (b.px - a.px) / dt;
      const my = (b.py - a.py) / dt;
      const mz = (b.pz - a.pz) / dt;
      const mean = Math.sqrt(mx * mx + my * my + mz * mz);
      const tolerance = mean * SPLINE_VELOCITY_TOLERANCE + SPLINE_VELOCITY_ALLOWANCE;
      const da = Math.hypot(a.vx - mx, a.vy - my, a.vz - mz);
      const db = Math.hypot(b.vx - mx, b.vy - my, b.vz - mz);
      spline = da <= tolerance && db <= tolerance;
    }
    if (spline) {
      const s2 = s * s;
      const s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1;
      const h10 = (s3 - 2 * s2 + s) * dt;
      const h01 = -2 * s3 + 3 * s2;
      const h11 = (s3 - s2) * dt;
      out.position.reset(
        h00 * a.px + h10 * a.vx + h01 * b.px + h11 * b.vx,
        h00 * a.py + h10 * a.vy + h01 * b.py + h11 * b.vy,
        h00 * a.pz + h10 * a.vz + h01 * b.pz + h11 * b.vz,
      );
    } else {
      out.position.reset(a.px + (b.px - a.px) * s, a.py + (b.py - a.py) * s, a.pz + (b.pz - a.pz) * s);
    }
    out.orientation.slerp(setQuaternion(qa, a), setQuaternion(qb, b), s).normalize();
    out.velocity.reset(a.vx + (b.vx - a.vx) * s, a.vy + (b.vy - a.vy) * s, a.vz + (b.vz - a.vz) * s);
    out.angularVelocity.reset(a.ax + (b.ax - a.ax) * s, a.ay + (b.ay - a.ay) * s, a.az + (b.az - a.az) * s);
    out.turretAngle = wrapAngle(a.turretAngle + shortestArc(a.turretAngle, b.turretAngle) * s);
    out.chassis = a.chassis;
    out.turretControl = a.turretControl;
    out.extrapolatedMs = 0;
  }
}

/**
 * Общая задержка отрисовки чужих танков: renderTime = serverNow − delay. Задержка должна покрывать «возраст»
 * последнего сэмпла к моменту прихода следующего (путь владелец → сервер → мы, ожидание тика снапшота и интервал
 * отправки) — тогда время отрисовки почти всегда между двумя сэмплами (экстраполяция — только последние десятки мс). Цель — 95-й перцентиль
 * возрастов за последние секунды + запас; к цели задержка идёт плавно (ход времени отрисовки 0,9–1,05 от реального),
 * чтобы движение не ускорялось и не замедлялось заметно.
 */
const AGE_WINDOW = 120;
const PERCENTILE_INTERVAL_MS = 100;
const PERCENTILE = 0.95;
const DELAY_MARGIN_MS = 10;
/**
 * сколько последних мс перед приходом следующего сэмпла можно экстраполировать: по скорости на такой отрезок ошибка
 * доли сантиметра (html5/tools/sync-sim.ts), а задержка отрисовки на столько же меньше
 */
const EXTRAPOLATION_ALLOWANCE_MS = 35;
export const MIN_DELAY_MS = 60;
export const MAX_DELAY_MS = 600;
const INITIAL_DELAY_MS = 150;
/** доля прошедшего времени: рост задержки (время отрисовки замедляется на 10 %) и уменьшение (ускоряется на 5 %) */
const GROW_RATE = 0.1;
const SHRINK_RATE = 0.05;
/** интервал отправки состояния владельцем (20 Гц) — для первого сэмпла танка, когда возраста предыдущего нет */
const SEND_INTERVAL_MS = 50;

export class InterpolationDelay {
  private readonly ages: number[] = [];
  private readonly sortedAges: number[] = [];
  private agesDirty = false;
  private nextPercentileAt = 0;
  private cursor = 0;
  private lastUpdate = 0;
  current = INITIAL_DELAY_MS;
  target = INITIAL_DELAY_MS;

  /**
   * пришёл новый сэмпл: arrival — серверное время прихода, previousNewest — время предыдущего последнего сэмпла
   * этого танка (null — первый)
   */
  addArrival(arrival: number, sampleTime: number, previousNewest: number | null): void {
    const age = previousNewest != null ? arrival - previousNewest : arrival - sampleTime + SEND_INTERVAL_MS;
    if (!Number.isFinite(age) || age < 0 || age > 5000) return;
    if (this.ages.length < AGE_WINDOW) this.ages.push(age);
    else {
      this.ages[this.cursor] = age;
      this.cursor = (this.cursor + 1) % AGE_WINDOW;
    }
    this.agesDirty = true;
  }

  update(localNow: number): void {
    if (this.agesDirty && localNow >= this.nextPercentileAt) {
      const sorted = this.sortedAges;
      sorted.length = this.ages.length;
      for (let i = 0; i < sorted.length; i++) sorted[i] = this.ages[i];
      sorted.sort((x, y) => x - y);
      const value = sorted[Math.floor(sorted.length * PERCENTILE)];
      this.target = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, value + DELAY_MARGIN_MS - EXTRAPOLATION_ALLOWANCE_MS));
      this.agesDirty = false;
      this.nextPercentileAt = localNow + PERCENTILE_INTERVAL_MS;
    }
    const elapsed = this.lastUpdate == 0 ? 0 : Math.max(0, Math.min(100, localNow - this.lastUpdate));
    this.lastUpdate = localNow;
    const delta = this.target - this.current;
    if (delta > 0) this.current += Math.min(delta, elapsed * GROW_RATE);
    else this.current += Math.max(delta, -elapsed * SHRINK_RATE);
  }

  reset(): void {
    this.ages.length = 0;
    this.cursor = 0;
    this.agesDirty = false;
    this.nextPercentileAt = 0;
    this.current = this.target = INITIAL_DELAY_MS;
  }
}

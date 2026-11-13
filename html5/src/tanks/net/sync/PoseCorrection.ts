/**
 * Сглаживаемая поправка позы чужого танка (синхронизация v2): показанное = состояние буфера + поправка. Когда данные
 * буфера скачком меняются на том же времени (новый сэмпл после экстраполяции, первый сэмпл новой жизни, сдвиг времени
 * отрисовки), поправка принимает скачок на себя — показанная поза не дёргается, — и затем экспоненциально гаснет.
 */
import { Quaternion } from '../../../physics/math/Quaternion.ts';
import { Vector3 } from '../../../physics/math/Vector3.ts';
import { shortestArc, wrapAngle, type InterpolatedState } from './StateBuffer.ts';

/** постоянная времени угасания, с: за 150 мс остаётся ~10 % */
export const CORRECTION_TAU = 0.065;
/** скачок больше — не сетевая ошибка, а перемещение (новая жизнь, телепорт): без сглаживания */
export const SNAP_DISTANCE = 1000;

const identity = new Quaternion();
const conjugate = new Quaternion();

export class PoseCorrection {
  readonly position = new Vector3();
  readonly orientation = new Quaternion();
  turret = 0;
  /** величина последнего скачка, ушедшего в поправку (см) */
  lastJump = 0;

  reset(): void {
    this.position.reset();
    this.orientation.reset();
    this.turret = 0;
  }

  /** показанная поза (shown*) должна остаться прежней при новом состоянии буфера raw */
  absorb(shownPosition: Vector3, shownOrientation: Quaternion, shownTurret: number, raw: InterpolatedState): void {
    const previous = this.position.length();
    this.position.diff(shownPosition, raw.position);
    conjugate.copy(raw.orientation).conjugate();
    Quaternion.multiply(shownOrientation, conjugate, this.orientation);
    this.orientation.normalize();
    this.turret = shortestArc(raw.turretAngle, shownTurret);
    const jump = Math.abs(this.position.length() - previous);
    if (jump > 1) this.lastJump = jump;
    if (this.position.length() > SNAP_DISTANCE) this.reset();
  }

  decay(dt: number): void {
    const k = Math.exp(-dt / CORRECTION_TAU);
    this.position.scale(k);
    this.orientation.slerp(identity, this.orientation, k).normalize();
    this.turret *= k;
  }

  /** показанная поза: состояние буфера + поправка; возвращает угол башни */
  apply(raw: InterpolatedState, position: Vector3, orientation: Quaternion): number {
    position.copy(raw.position).add(this.position);
    Quaternion.multiply(this.orientation, raw.orientation, orientation);
    orientation.normalize();
    return wrapAngle(raw.turretAngle + this.turret);
  }

  get magnitude(): number {
    return this.position.length();
  }
}

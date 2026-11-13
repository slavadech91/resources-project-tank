// 1:1 из alternativa/tanks/battle/objects/tank/tankskin/TracksAnimator.as клиента 2019 (Narukami):
// скорость прокрутки текстуры гусениц по скорости корпуса относительно земли под средним лучом подвески.
import type { Body } from '../../physics/Body.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { TankSkin } from '../render/TankSkin.ts';
import { numberSign, sign } from '../utils/MathUtils.ts';
import type { Track, ValueSmoother } from './Suspension.ts';
import type { TrackedChassis } from './TrackedChassis.ts';

const MIN_TRACK_SPEED = 100;
const bodyPointVelocity = new Vector3();

export class TracksAnimator {
  constructor(
    private readonly chassis: TrackedChassis,
    private readonly skin: TankSkin,
    private readonly maxSpeedSmoother: ValueSmoother,
  ) {}

  /** @param dt секунды с прошлого кадра */
  animate(dt: number): void {
    this.calculateTrackAnimationSpeed(this.chassis.leftTrack, dt);
    this.calculateTrackAnimationSpeed(this.chassis.rightTrack, dt);
    this.skin.updateTracks(dt * this.chassis.leftTrack.animationSpeed, dt * this.chassis.rightTrack.animationSpeed);
  }

  private calculateTrackAnimationSpeed(track: Track, dt: number): void {
    if (this.hasCorrectContacts(track)) this.animateTrackWithContacts(track, dt);
    else this.animateTrackWithoutContacts(track, dt);
  }

  /** танк не перевёрнут и гусеница касается земли */
  private hasCorrectContacts(track: Track): boolean {
    return track.body.baseMatrix.k > 0 && track.numContacts > 0;
  }

  private animateTrackWithContacts(track: Track, dt: number): void {
    const speed = this.getTrackSpeed(track);
    if (this.requiresSynchronizedAnimation(track, speed)) {
      track.animationSpeed = speed;
    } else {
      track.setAnimationSpeed(this.getDesiredSpeedCoeff(track) * MIN_TRACK_SPEED, this.chassis.getAcceleration() * dt);
    }
  }

  /** скорость точки корпуса над средним лучом вдоль оси Y корпуса относительно поверхности */
  private getTrackSpeed(track: Track): number {
    const surface = track.averageSurfaceVelocity;
    const ray = track.rays[track.numRays >> 1];
    getBodyPointVelocity(track.body, ray.getGlobalOrigin(), bodyPointVelocity);
    const x = bodyPointVelocity.x - surface.x;
    const y = bodyPointVelocity.y - surface.y;
    const z = bodyPointVelocity.z - surface.z;
    const m = track.body.baseMatrix;
    return x * m.b + y * m.f + z * m.j;
  }

  private requiresSynchronizedAnimation(track: Track, speed: number): boolean {
    const coeff = this.getDesiredSpeedCoeff(track);
    return Math.abs(speed) > 0.8 * MIN_TRACK_SPEED || coeff == 0 || numberSign(speed, 1) * sign(coeff) == -1;
  }

  /** куда должна крутиться гусеница по нажатым клавишам: вперёд/назад, при повороте на месте — в разные стороны */
  private getDesiredSpeedCoeff(track: Track): number {
    const move = this.chassis.getActualMovementDirection();
    const turn = this.chassis.getActualTurnDirection();
    if (move == 0) return track.side * turn * 0.5;
    if (turn == 0) return move;
    return (move * (3 + track.side * turn)) / 4;
  }

  /** в воздухе гусеница разгоняется к скорости по клавишам */
  private animateTrackWithoutContacts(track: Track, dt: number): void {
    const coeff = this.getDesiredSpeedCoeff(track);
    track.setAnimationSpeed(coeff * this.maxSpeedSmoother.getTargetValue(), this.chassis.getAcceleration() * dt);
  }
}

function getBodyPointVelocity(body: Body, point: Vector3, result: Vector3): void {
  const p = body.state.position;
  const rx = point.x - p.x;
  const ry = point.y - p.y;
  const rz = point.z - p.z;
  const w = body.state.rotation;
  result.x = w.y * rz - w.z * ry;
  result.y = w.z * rx - w.x * rz;
  result.z = w.x * ry - w.y * rx;
  const v = body.state.velocity;
  result.x += v.x;
  result.y += v.y;
  result.z += v.z;
}

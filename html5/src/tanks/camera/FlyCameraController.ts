// 1:1 из alternativa/tanks/camera/FlyCameraController.as + AngleValues.as: полёт камеры к точке спавна.
// Камера летит по кубической кривой Безье от текущего места к виду на точку спавна; обе контрольные точки подняты
// на 3000 над самой высокой из двух точек. Путь и углы разгоняются до середины пути, затем тормозят.
import { Vector3 } from '../../physics/math/Vector3.ts';
import { clampAngle } from '../utils/MathUtils.ts';
import type { GameCamera } from './FollowCameraController.ts';

/** §23§ — подъём контрольных точек кривой над картой */
const FLIGHT_HEIGHT = 3000;

/** AngleValues: поворот на кратчайший угол с постоянным ускорением (разгон, затем торможение) */
class AngleValues {
  private done = 0; // §`b§
  private total = 0; // §5"F§
  private acceleration = 0; // §5"H§
  private speed = 0; // §&'§
  private sign = 1; // §,5§

  init(from: number, to: number, accelerationCoeff: number): void {
    this.total = to - from;
    if (this.total < 0) {
      this.total = -this.total;
      this.sign = -1;
    } else {
      this.sign = 1;
    }
    if (this.total > Math.PI) {
      this.sign = -this.sign;
      this.total = 2 * Math.PI - this.total;
    }
    this.acceleration = accelerationCoeff * this.total;
    this.speed = 0;
    this.done = 0;
  }

  reverseAcceleration(): void {
    this.acceleration = -this.acceleration;
  }

  update(dt: number): number {
    if (this.done >= this.total) return 0;
    const dv = this.acceleration * dt;
    let step = (this.speed + 0.5 * dv) * dt;
    this.speed += dv;
    const left = this.total - this.done;
    if (left < step) step = left;
    this.done += step;
    return step * this.sign;
  }
}

const point = new Vector3();

export class FlyCameraController {
  private readonly start = new Vector3(); // §!"Q§
  private readonly control1 = new Vector3(); // §^!J§
  private readonly control2 = new Vector3(); // §'"#§
  private readonly end = new Vector3(); // §5"S§
  private length = 0; // §""'§ — длина прямой от начала до конца, по ней меряется путь
  private distance = 0; // § !U§
  private acceleration = 0; // §[i§
  private speed = 0; // §9"$§
  private readonly pitch = new AngleValues(); // §2!h§
  private readonly yaw = new AngleValues(); // §"!P§

  constructor(private readonly camera: GameCamera) {}

  /** position/rotation — куда прилететь (вид на точку спавна), duration — время полёта, мс */
  init(position: Vector3, rotation: Vector3, duration: number): void {
    this.start.copy(this.camera.position);
    this.control1.copy(this.start);
    this.end.copy(position);
    this.control2.copy(this.end);
    this.control1.z = this.control2.z = Math.max(this.start.z, this.end.z) + FLIGHT_HEIGHT;
    const accelerationCoeff = 4000000 / (duration * duration);
    this.pitch.init(clampAngle(this.camera.rotation.x), rotation.x, accelerationCoeff);
    this.yaw.init(clampAngle(this.camera.rotation.z), rotation.z, accelerationCoeff);
    this.length = point.diff(this.end, this.start).length();
    this.acceleration = this.length * accelerationCoeff;
    this.distance = 0;
    this.speed = 0;
  }

  /** @param deltaMs время кадра, мс */
  update(deltaMs: number): void {
    if (this.speed < 0) return;
    if (this.distance > 0.5 * this.length && this.acceleration > 0) {
      this.acceleration = -this.acceleration;
      this.pitch.reverseAcceleration();
      this.yaw.reverseAcceleration();
    }
    const dt = 0.001 * deltaMs;
    const dv = this.acceleration * dt;
    this.distance += (this.speed + 0.5 * dv) * dt;
    this.speed += dv;
    if (this.distance > this.length) this.distance = this.length;
    const t = this.length > 0 ? this.distance / this.length : 1;
    this.bezier(t, point);
    this.camera.position.copy(point);
    this.camera.rotation.x += this.pitch.update(dt);
    this.camera.rotation.z += this.yaw.update(dt);
  }

  private bezier(t: number, result: Vector3): void {
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * t * u * u;
    const b2 = 3 * t * t * u;
    const b3 = t * t * t;
    result.x = b0 * this.start.x + b1 * this.control1.x + b2 * this.control2.x + b3 * this.end.x;
    result.y = b0 * this.start.y + b1 * this.control1.y + b2 * this.control2.y + b3 * this.end.y;
    result.z = b0 * this.start.z + b1 * this.control1.z + b2 * this.control2.z + b3 * this.end.z;
  }
}

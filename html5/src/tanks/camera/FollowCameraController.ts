// 1:1 из alternativa/tanks/camera/FollowCameraController.as.
// Отличие: столкновение камеры со сценой во Flash ищет EllipsoidCollider (сфера радиуса 50) по видимой
// геометрии карты; здесь — луч по физической геометрии карты (TanksCollisionDetector) с тем же отступом.
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { RayHit } from '../../physics/collision/types.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import { clamp, clampAngle, clampAngleFast, snap } from '../utils/MathUtils.ts';
import type { KeyboardSource } from '../tank/Controllers.ts';

const CAMERA_VSPEED = 0.5; // консольная переменная cam_vspeed
const MIN_ALT_PITCH = (5 * Math.PI) / 180; // §^!K§
const KEYS_UP = [33, 221, 81]; // PAGE_UP, ], Q
const KEYS_DOWN = [34, 219, 69]; // PAGE_DOWN, [, E
const COLLIDER_RADIUS = 50; // §`!]§
const LINEAR_SPEED_THRESHOLD = 10; // §[!n§
const ANGULAR_THRESHOLD = Math.PI / 180; // §[!?§
const SNAP_EPSILON = 10; // §#Q§
const PITCH_CORRECTION = (10 * Math.PI) / 180; // §1!H§
const ALT_K = 1; // §%!7§
const MIN_DISTANCE = 300; // §6"9§

const cameraPoint = new Vector3(); // §;"-§
const tmp = new Vector3(); // §>C§
const rotationMatrix = new Matrix3(); // §]"X§
const axis = new Vector3(); // §-m§
const direction = new Vector3(); // §%u§
const position = new Vector3(); // §&!O§
const rotation = new Vector3(); // §7"%§
const origin = new Vector3(); // §&V§
const flatDirection = new Vector3(); // §@!^§
const delta = new Vector3(); // §8!3§
const rayHit = new RayHit();

export interface CameraTarget {
  getCameraParams(position: Vector3, direction: Vector3): void;
}

/** Камера в осях игры: позиция и углы rotationX/Y/Z Alternativa3D (камера смотрит вдоль своей оси Z) */
export interface GameCamera {
  readonly position: Vector3;
  readonly rotation: Vector3;
}

class CameraPositionData {
  extraPitch = 0; // §^"W§
  t = 1; // §+h§ — доля свободного расстояния до камеры
  readonly position = new Vector3(); // §2J§
}

interface Point {
  x: number;
  y: number;
}

function getLinearSpeed(distance: number): number {
  return 5 * distance; // Narukami FollowCameraController.MAX_CAMERA_MOVE_SPEED
}

/** Режим камеры клиента 2019 (FollowCameraController.followCameraMode/followCameraDirection) */
export const CAMERA_FOLLOWS_TURRET = 0;
export const CAMERA_FOLLOWS_MOUSE = 1;
export const followCamera = { mode: CAMERA_FOLLOWS_TURRET, direction: 0 };

/** 2019: за мышью камера поворачивается быстрее (MAX_CAMERA_ROTATE_SPEED 9), за башней — 3 */
const MIN_CAMERA_ROTATE_SPEED = 3;
const MAX_CAMERA_ROTATE_SPEED = 9;
/** 2019: ROTATE_SENS — наклон камеры мышью по вертикали */
const ROTATE_SENS = 0.001;

function getAngularSpeed(angle: number, speed: number): number {
  const k = followCamera.mode == CAMERA_FOLLOWS_TURRET ? MIN_CAMERA_ROTATE_SPEED : MAX_CAMERA_ROTATE_SPEED;
  if (angle < -ANGULAR_THRESHOLD) return k * (angle + ANGULAR_THRESHOLD);
  if (angle > ANGULAR_THRESHOLD) return k * (angle - ANGULAR_THRESHOLD);
  return speed;
}

function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const a = 3 * (p1 - p0);
  const b = 3 * p0 - 6 * p1 + 3 * p2;
  const c = -p0 + 3 * p1 - 3 * p2 + p3;
  return p0 + t * a + t * t * b + t * t * t * c;
}

export class FollowCameraController {
  private alternateSettings = false; // §`!1§
  heightLocked = false; // §=P§
  private distance = 0; // §]!x§
  private locked = false; // §4"J§
  private keyUp = false; // §[j§
  private keyDown = false; // §4!L§
  /** 2019: колесо мыши — число шагов изменения высоты */
  private mouseWheel = 0;
  /** 2019: сдвиг высоты камеры движением мыши по вертикали, −1…1 */
  private mouseLookShift = 0;
  private pendingMouseYaw = 0;
  private readonly mouseOrbit = new Vector3();
  /** 2019: settings.mouseYInverse */
  mouseYInverse = false;
  private target: CameraTarget | null = null; // §-p§
  private readonly position = new Vector3(); // §2J§
  private readonly rotation = new Vector3(); // §[!7§
  private readonly targetPosition = new Vector3(); // §@z§
  private readonly targetDirection = new Vector3(); // §<"V§
  private linearSpeed = 0; // §>!C§
  private pitchSpeed = 0; // §`M§
  private yawSpeed = 0; // §5!"§
  private readonly positionData = new CameraPositionData(); // §[V§
  private elevationAngle = 0; // § "W§
  private cameraT = 0; // §,!e§
  private readonly curvePoint: Point = { x: 0, y: 0 }; // §`j§
  private readonly p0: Point = { x: 145, y: 545 }; // §&!L§
  private readonly p1: Point = { x: 930, y: 1395 }; // §6!g§
  private readonly p2: Point = { x: 2245, y: 1565 }; // §+!M§
  private readonly p3: Point = { x: 3105, y: 760 }; // §!C§

  constructor(
    private readonly camera: GameCamera,
    private readonly collisionDetector: TanksCollisionDetector,
    keyboard: KeyboardSource,
  ) {
    this.setCameraT(0.2);
    keyboard.addListener((keyCode, down) => {
      if (KEYS_DOWN.indexOf(keyCode) >= 0) this.keyDown = down;
      else if (KEYS_UP.indexOf(keyCode) >= 0) this.keyUp = down;
    });
  }

  setTarget(target: CameraTarget): void {
    this.target = target;
  }

  setAlternateSettings(value: boolean): void {
    this.alternateSettings = value;
  }

  setTargetParams(targetPosition: Vector3, targetDirection: Vector3): void {
    this.targetPosition.copy(targetPosition);
    this.targetDirection.copy(targetDirection);
    this.getCameraPositionData(targetPosition, targetDirection, this.positionData);
    this.position.copy(this.positionData.position);
    this.rotation.x = this.getPitchAngle(this.positionData) - 0.5 * Math.PI;
    this.rotation.y = 0;
    this.rotation.z = Math.atan2(-targetDirection.x, targetDirection.y);
    this.setPosition(this.position);
    this.setOrientation(this.rotation);
  }

  /** @param deltaMs время кадра в миллисекундах */
  update(deltaMs: number): void {
    if (this.target == null) return;
    let dt = deltaMs * 0.001;
    if (dt > 0.1) dt = 0.1;
    this.updateCameraHeight(dt);
    if (!this.locked) this.recalculateTargetData();
    this.getCameraPositionData(this.targetPosition, this.targetDirection, this.positionData);
    // Apply only fresh mouse motion immediately. Preserve the original camera
    // spring for tank translation, suspension, recoil and non-mouse turret motion.
    if (!this.locked && followCamera.mode === CAMERA_FOLLOWS_MOUSE && this.pendingMouseYaw !== 0) {
      const angle=this.pendingMouseYaw,c=Math.cos(angle),s=Math.sin(angle);
      const x=this.position.x-this.targetPosition.x,y=this.position.y-this.targetPosition.y;
      this.position.x=this.targetPosition.x+c*x-s*y;
      this.position.y=this.targetPosition.y+s*x+c*y;
      this.rotation.z=clampAngle(this.rotation.z+angle);
      const orbit=this.mouseOrbit.copy(this.position).subtract(this.targetPosition);
      const length=orbit.length();
      if(length>0)this.getCollisionPoint(this.targetPosition,orbit.scale(1/length),length,this.position);
    }
    this.pendingMouseYaw=0;
    delta.diff(this.positionData.position, this.position);
    const distance = delta.length();
    if (distance > LINEAR_SPEED_THRESHOLD) this.linearSpeed = getLinearSpeed(distance - LINEAR_SPEED_THRESHOLD);
    let step = this.linearSpeed * dt;
    if (step > distance) step = distance;
    delta.normalize().scale(step);
    const targetPitch = this.getPitchAngle(this.positionData);
    const targetYaw = Math.atan2(-this.targetDirection.x, this.targetDirection.y);
    const pitch = clampAngle(this.rotation.x + 0.5 * Math.PI);
    const yaw = clampAngle(this.rotation.z);
    const pitchDelta = clampAngleFast(targetPitch - pitch);
    this.pitchSpeed = getAngularSpeed(pitchDelta, this.pitchSpeed);
    let pitchStep = this.pitchSpeed * dt;
    if ((pitchDelta > 0 && pitchStep > pitchDelta) || (pitchDelta < 0 && pitchStep < pitchDelta)) pitchStep = pitchDelta;
    const yawDelta = clampAngleFast(targetYaw - yaw);
    this.yawSpeed = getAngularSpeed(yawDelta, this.yawSpeed);
    let yawStep = this.yawSpeed * dt;
    if ((yawDelta > 0 && yawStep > yawDelta) || (yawDelta < 0 && yawStep < yawDelta)) yawStep = yawDelta;
    this.linearSpeed = snap(this.linearSpeed, 0, SNAP_EPSILON);
    this.pitchSpeed = snap(this.pitchSpeed, 0, SNAP_EPSILON);
    this.yawSpeed = snap(this.yawSpeed, 0, SNAP_EPSILON);
    this.position.add(delta);
    this.rotation.x += pitchStep;
    this.rotation.z += yawStep;
    position.copy(this.position);
    rotation.copy(this.rotation);
    this.setPosition(position);
    this.setOrientation(rotation);
  }

  /** §-!>§: куда встанет камера, глядя на цель (позиция и углы) — конечная точка полёта камеры к спавну */
  getTargetCameraParams(targetPosition: Vector3, targetDirection: Vector3, resultPosition: Vector3, resultRotation: Vector3): void {
    this.getCameraPositionData(targetPosition, targetDirection, this.positionData);
    resultRotation.x = this.getPitchAngle(this.positionData) - 0.5 * Math.PI;
    resultRotation.y = 0;
    resultRotation.z = Math.atan2(-targetDirection.x, targetDirection.y);
    resultPosition.copy(this.positionData.position);
  }

  /** activateFollowCamera после полёта: продолжаем с того места, где камера сейчас */
  syncWithCamera(): void {
    this.pendingMouseYaw=0;
    this.position.copy(this.camera.position);
    this.rotation.copy(this.camera.rotation);
    this.linearSpeed = 0;
    this.pitchSpeed = 0;
    this.yawSpeed = 0;
  }

  setLocked(value: boolean): void {
    this.locked = value;
    if (value) { this.mouseWheel = 0; this.pendingMouseYaw=0; }
  }

  /** 2019 onMouseRelativeMovement: мышь вверх-вниз поднимает и опускает камеру */
  onMouseRelativeMovement(_dx: number, dy: number, yawDelta = 0): void {
    if (this.locked) return;
    this.pendingMouseYaw += yawDelta;
    this.mouseLookShift = clamp(this.mouseLookShift + dy * ROTATE_SENS * (this.mouseYInverse ? -1 : 1), -1, 1);
  }

  /** 2019 onMouseWheel: delta как во Flash (вверх — положительная) */
  onMouseWheel(value: number): void {
    if (this.locked) return;
    const delta = value * (this.mouseYInverse ? -1 : 1);
    if (delta > 1 && this.mouseWheel < 0) this.mouseWheel = 0;
    if (delta < 1 && this.mouseWheel > 0) this.mouseWheel = 0;
    this.mouseWheel = delta * 2;
  }

  getCameraT(): number {
    return this.cameraT;
  }

  setCameraT(value: number): void {
    this.cameraT = clamp(value, 0, 1);
    const t = clamp(this.cameraT + this.mouseLookShift * 0.1, 0, 1);
    this.curvePoint.x = bezier(t, this.p0.x, this.p1.x, this.p2.x, this.p3.x);
    this.curvePoint.y = bezier(t, this.p0.y, this.p1.y, this.p2.y, this.p3.y);
    this.elevationAngle = Math.atan2(this.curvePoint.x, this.curvePoint.y);
    this.distance = Math.sqrt(this.curvePoint.x * this.curvePoint.x + this.curvePoint.y * this.curvePoint.y);
  }

  recalculateTargetData(): void {
    (this.target as CameraTarget).getCameraParams(this.targetPosition, this.targetDirection);
  }

  private getCameraPositionData(targetPosition: Vector3, targetDirection: Vector3, result: CameraPositionData): void {
    const angle = this.elevationAngle;
    const length = Math.sqrt(targetDirection.x * targetDirection.x + targetDirection.y * targetDirection.y);
    if (length < 0.00001) {
      flatDirection.x = 1;
      flatDirection.y = 0;
    } else {
      flatDirection.x = targetDirection.x / length;
      flatDirection.y = targetDirection.y / length;
    }
    flatDirection.z = 0;
    result.extraPitch = 0;
    result.t = 1;
    origin.copy(targetPosition);
    axis.x = flatDirection.y;
    axis.y = -flatDirection.x;
    axis.z = 0;
    flatDirection.reverse();
    rotationMatrix.fromAxisAngle(axis, -angle);
    rotationMatrix.transformVector(flatDirection, direction);
    this.getCollisionPoint(origin, direction, this.distance, cameraPoint);
    const free = tmp.copy(origin).subtract(cameraPoint).length();
    result.t = free / this.distance;
    if (free < MIN_DISTANCE) {
      origin.copy(cameraPoint);
      const up = MIN_DISTANCE - free;
      this.getCollisionPoint(origin, Vector3.Z_AXIS, up, cameraPoint);
    }
    result.position.copy(cameraPoint);
  }

  private getCollisionPoint(from: Vector3, dir: Vector3, length: number, result: Vector3): void {
    if (this.collisionDetector.raycastStatic(from, dir, CollisionGroup.STATIC, length + 4 * COLLIDER_RADIUS, null, rayHit)) {
      // Сфера радиуса R, летящая вдоль луча, касается плоскости попадания раньше луча на R / cos.
      // EllipsoidCollider ставит камеру в точку касания + (R + 0.1) по нормали, то есть центр сферы + 0.1.
      const normal = rayHit.normal;
      let cos = -(dir.x * normal.x + dir.y * normal.y + dir.z * normal.z);
      if (cos < 0.2) cos = 0.2;
      let t = rayHit.t - COLLIDER_RADIUS / cos;
      if (t < 0) t = 0;
      rayHit.clear();
      if (t < length) {
        result.x = from.x + t * dir.x + 0.1 * normal.x;
        result.y = from.y + t * dir.y + 0.1 * normal.y;
        result.z = from.z + t * dir.z + 0.1 * normal.z;
        return;
      }
    }
    result.copy(from).addScaled(length, dir);
  }

  private updateCameraHeight(dt: number): void {
    // 2019: шаг колеса работает как нажатие Q/E на один кадр
    let wheelUp = false;
    let wheelDown = false;
    if (this.mouseWheel < 0) {
      wheelUp = true;
      ++this.mouseWheel;
    } else if (this.mouseWheel > 0) {
      wheelDown = true;
      --this.mouseWheel;
    }
    const up = this.keyUp || wheelUp;
    const down = this.keyDown || wheelDown;
    if (!this.heightLocked && up != down) {
      const sign = up ? 1 : -1;
      this.setCameraT(this.getCameraT() + sign * CAMERA_VSPEED * dt);
    } else {
      this.setCameraT(this.getCameraT());
    }
  }

  private getPitchAngle(data: CameraPositionData): number {
    let angle = this.elevationAngle - PITCH_CORRECTION;
    if (angle < 0) angle = 0;
    const t = data.t;
    if (t >= 1 || angle < MIN_ALT_PITCH || !this.alternateSettings) return data.extraPitch - angle;
    const x = this.curvePoint.x;
    return data.extraPitch - Math.atan2(t * x, ALT_K * x * (1 / Math.tan(angle) - (1 - t) / Math.tan(this.elevationAngle)));
  }

  private setPosition(value: Vector3): void {
    this.camera.position.copy(value);
  }

  private setOrientation(value: Vector3): void {
    this.camera.rotation.copy(value);
  }
}

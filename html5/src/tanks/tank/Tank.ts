import {turretHitGeometry,type TurretHitBox} from './TurretHitGeometry.ts';
import {CollisionBox} from '../../physics/collision/CollisionShape.ts';
import {PhysicsMaterial} from '../../physics/collision/types.ts';
// Физическая часть alternativa/tanks/battle/objects/tank/Tank.as (1:1): корпус, подвеска, шасси, башня,
// интерполяция, параметры камеры и звуки (TankSounds). Ники, пыль и валидаторы античита не переносились.
import { Body, BodyState } from '../../physics/Body.ts';
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Matrix4 } from '../../physics/math/Matrix4.ts';
import { Quaternion } from '../../physics/math/Quaternion.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { BodyCollisionFilter } from '../../physics/collision/types.ts';
import { CollisionGroup, TankBody } from '../physics/TankBody.ts';
import type { TankSkin } from '../render/TankSkin.ts';
import { sampleTrackMarks } from '../render/TrackMarks.ts';
import type { TankSounds } from '../sfx/Sound.ts';
import { createStaticCollisionBoxes, createTankCollisionBox } from './CollisionBoxesBuilder.ts';
import type { MovementTarget, TurretController } from './Controllers.ts';
import { EncryptedValueSmoother, SuspensionParams, TankConst, type ValueSmoother } from './Suspension.ts';
import { TrackedChassis } from './TrackedChassis.ts';
import { TracksAnimator } from './TracksAnimator.ts';
import { CAMERA_FOLLOWS_MOUSE, followCamera } from '../camera/FollowCameraController.ts';

const tmpVector = new Vector3(); // §>C§
const tmpMatrix3 = new Matrix3(); // §]"F§
const hullMatrix = new Matrix4(); // §'!6§
const cameraMatrix = new Matrix4(); // §>!V§
const visibilityPoint = new Vector3(); // §9!^§
const visibilityOrigin = new Vector3(); // §@!N§
const visibilityDirection = new Vector3(); // §'!U§

/** PhysicsUtils.setBoxInvInertia */
function setBoxInvInertia(mass: number, halfSize: Vector3, result: Matrix3): void {
  if (mass <= 0) throw new Error('mass <= 0');
  result.copy(Matrix3.IDENTITY);
  if (mass == Infinity) return;
  const xx = halfSize.x * halfSize.x;
  const yy = halfSize.y * halfSize.y;
  const zz = halfSize.z * halfSize.z;
  result.a = 3 / (mass * (yy + zz));
  result.f = 3 / (mass * (zz + xx));
  result.k = 3 / (mass * (xx + yy));
}

export interface TankWeapon {
  init(tank: Tank): void;
  reset(): void;
}

export class Tank implements MovementTarget, BodyCollisionFilter {
  maxHealth = 0;
  weaponBuffed = false;
  health = 0; // §^W§
  /** союзник в командном бою без огня по своим: не цель наведения (CommonTargetEvaluator.isTankTarget) */
  friendly = false;
  /** Positive = burning; negative = frozen (Isis target priority). */
  temperature = 0;
  private readonly turretController: TurretController; // §2>§
  tankBody: TankBody = null as unknown as TankBody; // §6"S§
  readonly turretCollisions:CollisionBox[]=[];
  private turretGeometry:TurretHitBox[]=[];
  private collisionCount = 0; // §2!T§
  readonly skin: TankSkin; // §<!f§
  private readonly tracksAnimator: TracksAnimator;
  private lastRenderTime = 0;
  private readonly maxSpeedSmoother: ValueSmoother = new EncryptedValueSmoother(100, 1000, 0, 0); // §2R§
  private readonly maxTurnSpeedSmoother: ValueSmoother = new EncryptedValueSmoother(0.3, 10, 0, 0); // §=F§
  private readonly suspensionParams = new SuspensionParams(); // §%L§
  /** §7D§ — смещение меша корпуса относительно центра тела */
  readonly skinCenterOffset = new Vector3();
  /** §8I§ — интерполированная позиция тела */
  readonly interpolatedPosition = new Vector3();
  /** §<"B§ — интерполированная ориентация тела */
  readonly interpolatedOrientation = new Quaternion();
  /** §%q§ — интерполированный угол башни */
  interpolatedTurretDirection = 0;
  chassis: TrackedChassis; // §,""§
  private halfLength: number; // §%!3§
  private readonly prevState = new BodyState(); // §2!5§
  private boundSphereRadius = 0; // §&!]§
  private visibilityPoints: Vector3[] = []; // §9"7§
  private weapon: TankWeapon; // §=![§
  /** §^">§; null — танк без звука */
  /** Local player can suppress turret audio for mouse aiming; remote tanks keep the default. */
  turretSoundAllowed: () => boolean = () => true;
  turretSoundVolume: () => number = () => 1;
  sounds: TankSounds | null = null;

  constructor(mass: number, damping: number, skin: TankSkin, turretController: TurretController, weapon: TankWeapon) {
    this.skin = skin;
    this.suspensionParams.dampingCoeff = damping;
    const size = Tank.calculateBodySize(skin);
    const halfSize = new Vector3(size.x / 2, size.y / 2, size.z / 2);
    this.halfLength = halfSize.y;
    this.createBody(mass, halfSize);
    this.createCollisionShapes(halfSize);
    this.createVisibilityPoints(halfSize);
    this.chassis = new TrackedChassis(this.tankBody.body, this.suspensionParams, this.maxSpeedSmoother, size);
    this.tracksAnimator = new TracksAnimator(this.chassis, skin, this.maxSpeedSmoother);
    this.calculateSkinCenterOffset(size);
    this.initTurretGeometry();
    this.weapon = weapon;
    weapon.init(this);
    this.turretController = turretController;
    this.tankBody.onTankInited();
  }

  private static calculateBodySize(skin: TankSkin): Vector3 {
    const b = skin.hull.bounds;
    return new Vector3(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
  }

  getBody(): Body {
    return this.tankBody.body;
  }

  /** createVisibilityPoints: 6 точек по бокам корпуса (локальные координаты, z = 0) */
  private createVisibilityPoints(halfSize: Vector3): void {
    const x = halfSize.x;
    const y = halfSize.y;
    this.visibilityPoints = [
      new Vector3(-x, y, 0), new Vector3(x, y, 0),
      new Vector3(-x, 0, 0), new Vector3(x, 0, 0),
      new Vector3(-x, -y, 0), new Vector3(x, -y, 0),
    ];
  }

  /** isInvisible: ни одна точка корпуса не видна из camera (луч до точки упирается в статику) */
  isInvisible(camera: Vector3): boolean {
    for (const point of this.visibilityPoints) {
      if (this.isPointVisible(visibilityPoint.copy(point), camera)) return false;
    }
    return true;
  }

  private isPointVisible(point: Vector3, camera: Vector3): boolean {
    const body = this.tankBody.body;
    point.transform3(body.baseMatrix);
    point.add(body.state.position);
    visibilityOrigin.copy(camera);
    visibilityDirection.diff(point, visibilityOrigin);
    const detector = body.scene?.collisionDetector;
    if (!detector) return true;
    return !detector.hasStaticHit(visibilityOrigin, visibilityDirection, CollisionGroup.STATIC, 1);
  }

  getTurretController(): TurretController {
    return this.turretController;
  }

  /** Точка и направление взгляда для камеры: точка mount (на 10 ниже) в мире, ось Y башни */
  getCameraParams(position: Vector3, direction: Vector3): void {
    this.interpolatedOrientation.toMatrix3(tmpMatrix3);
    tmpVector.copy(this.skinCenterOffset);
    tmpVector.transform3(tmpMatrix3);
    tmpVector.add(this.interpolatedPosition);
    hullMatrix.setFromMatrix3(tmpMatrix3, tmpVector);
    const mount = this.skin.hull.turretMountPoint;
    cameraMatrix.setMatrix(mount.x, mount.y, mount.z - 10, 0, 0, this.interpolatedTurretDirection);
    cameraMatrix.append(hullMatrix);
    position.reset(cameraMatrix.d, cameraMatrix.h, cameraMatrix.l);
    // клиент 2019: при управлении мышью камера смотрит туда, куда направлена мышь, а не башня
    if (followCamera.mode == CAMERA_FOLLOWS_MOUSE) direction.reset(-Math.sin(followCamera.direction), Math.cos(followCamera.direction), 0);
    else direction.reset(cameraMatrix.b, cameraMatrix.f, cameraMatrix.j);
  }

  /** Tank.getInterpolatedTurretWorldDirection (2019): угол башни в мире (0 — вдоль оси Y карты) */
  getInterpolatedTurretWorldDirection(): number {
    this.interpolatedOrientation.toMatrix3(tmpMatrix3);
    tmpVector.reset(-Math.sin(this.interpolatedTurretDirection), Math.cos(this.interpolatedTurretDirection), 0);
    tmpVector.transform3(tmpMatrix3);
    return Math.atan2(-tmpVector.x, tmpVector.y);
  }

  lockMovement(locked: boolean): void {
    this.chassis.locked = locked;
  }

  /** Tank.kill: здоровье 0, звуки двигателя и башни выключены */
  kill(): void {
    this.health = 0;
    if (this.sounds) {
      this.sounds.setIdleMode();
      this.sounds.turretSoundEnabled = false;
      this.sounds.enabled = false;
    }
  }

  /** TankModel.createDeathEffects: «подбрасывание» трупа и вращение */
  applyDeathKick(): void {
    const state = this.tankBody.body.state;
    this.tankBody.body.clearAccumulators();
    state.velocity.z += 500;
    state.rotation.reset(2, 2, 2);
  }

  spawn(): void {
    this.tankBody.body.clearAccumulators();
    if (this.sounds) this.sounds.enabled = true;
    this.weapon.reset();
    if (this.sounds) {
      this.sounds.setIdleMode();
      this.sounds.turretSoundEnabled = true;
    }
    this.chassis.locked = false;
    this.turretController.reset();
  }

  setActivatedState(): void {
    this.setBodyCollisionGroup(CollisionGroup.TANK | CollisionGroup.ACTIVE_TRACK | CollisionGroup.WEAPON);
    this.setTracksCollisionGroup(CollisionGroup.ACTIVE_TRACK);
    this.skin.setAlpha(1);
    this.tankBody.body.postCollisionFilter = null;
  }

  setSemiActivatedState(): void {
    this.setBodyCollisionGroup(CollisionGroup.TANK);
    this.setTracksCollisionGroup(CollisionGroup.INACTIVE_TRACK);
    // полупрозрачный, без столкновений с танками (considerBodies) и вне луча оружия (нет группы WEAPON)
    this.skin.setAlpha(0.5);
    this.tankBody.body.postCollisionFilter = this;
  }

  considerBodies(body1: Body, body2: Body): boolean {
    if (body1.postCollisionFilter != null && body2.postCollisionFilter == null) {
      ++(body1.data as Tank).collisionCount;
    } else if (body1.postCollisionFilter == null && body2.postCollisionFilter != null) {
      ++(body2.data as Tank).collisionCount;
    }
    return false;
  }

  setMaxSpeed(value: number, immediate: boolean): void {
    if (immediate) this.maxSpeedSmoother.reset(value);
    else this.maxSpeedSmoother.setTargetValue(value);
  }

  /** заданная максимальная скорость (к ней плавно идёт текущая) — для отладки рассинхрона */
  getMaxSpeed(): number {
    return this.maxSpeedSmoother.getTargetValue();
  }

  setMaxTurnSpeed(value: number, immediate: boolean): void {
    if (immediate) this.maxTurnSpeedSmoother.reset(value);
    else this.maxTurnSpeedSmoother.setTargetValue(value);
  }

  runBeforePhysicsUpdate(dt: number): void {
    this.collisionCount = 0;
    const maxSpeed = this.maxSpeedSmoother.update(dt);
    const maxTurnSpeed = this.maxTurnSpeedSmoother.update(dt);
    this.tankBody.body.setMaxSpeedXY(maxSpeed);
    this.chassis.applyForces(maxSpeed, maxTurnSpeed, dt);
    // клиент 2019: в полёте без опоры гусеницами трение о статику пропадает
    this.tankBody.body.slipperyMode = !this.hasTracksContactsWithStatic() && this.tankBody.isSoaring();
    this.rotateTurret(dt);
    this.savePhysicsState();
  }

  runAfterPhysicsUpdate(_dt: number): void {
    this.ensureBodyStateIsValid();
  }

  private ensureBodyStateIsValid(): void {
    const body = this.tankBody.body;
    const state = body.state;
    if (!state.isValid()) {
      state.copy(this.prevState);
      body.saveState();
    }
  }

  interpolatePhysicsState(t: number): void {
    this.tankBody.body.interpolate(t, this.interpolatedPosition, this.interpolatedOrientation);
    this.interpolatedOrientation.normalize();
    this.interpolatedTurretDirection = this.turretController.getInterpolatedDirection(t);
  }

  /** render + LocalHullTransformUpdater.update: меш корпуса со смещением §7D§, башня на mount */
  render(): void {
    // Tank.render(time, deltaMs): гусеницы крутятся по времени кадра
    const now = performance.now();
    const dt = this.lastRenderTime == 0 ? 0 : Math.min(0.1, (now - this.lastRenderTime) * 0.001);
    this.lastRenderTime = now;
    this.tracksAnimator.animate(dt);
    this.interpolatedOrientation.toMatrix3(tmpMatrix3);
    tmpVector.copy(this.skinCenterOffset);
    tmpVector.transform3(tmpMatrix3);
    tmpVector.add(this.interpolatedPosition);
    hullMatrix.setFromMatrix3(tmpMatrix3, tmpVector);
    this.skin.updateHullTransform(hullMatrix);
    this.skin.updateTurretTransform(this.interpolatedTurretDirection);
    sampleTrackMarks(this);
  }

  setBodyCollisionGroup(group: number): void {
    this.tankBody.tankCollisionBox.collisionGroup = group;
    for(const box of this.turretCollisions)box.collisionGroup=group & CollisionGroup.WEAPON;
  }

  getBodyCollisionGroup(): number {
    return this.tankBody.tankCollisionBox.collisionGroup;
  }

  setTracksCollisionGroup(group: number): void {
    this.chassis.setTracksCollisionGroup(group);
  }

  setMovementParams(moveDirection: number, turnDirection: number, reverseBackTurn: boolean): void {
    this.chassis.moveDirection = moveDirection;
    this.chassis.turnDirection = turnDirection;
    this.chassis.reverseBackTurn = reverseBackTurn;
    if (!this.chassis.locked && this.sounds) {
      if (moveDirection != 0) this.sounds.setAccelerationMode();
      else if (turnDirection != 0) this.sounds.setTurningMode();
      else this.sounds.setIdleMode();
    }
  }

  /** setPhysicsState: позиция, углы Эйлера, скорость и угловая скорость */
  setPhysicsState(position: Vector3, orientation: Vector3, velocity: Vector3, rotation: Vector3): void {
    const body = this.tankBody.body;
    const state = body.state;
    state.position.copy(position);
    state.orientation.setFromEulerAnglesXYZ(orientation.x, orientation.y, orientation.z);
    state.velocity.copy(velocity);
    state.rotation.copy(rotation);
    body.saveState();
    body.calcDerivedData();
  }

  getCollisionCount(): number {
    return this.collisionCount;
  }

  private initTurretGeometry():void {
    this.turretGeometry=turretHitGeometry(this.skin.turret.part?.physicalObjects??this.skin.turret.part?.objects??[]);
    for(const item of this.turretGeometry){
      const box=new CollisionBox(item.halfSize,0,PhysicsMaterial.DEFAULT);
      this.turretCollisions.push(box);this.tankBody.body.addCollisionShape(box,new Matrix4());
    }
    this.updateTurretPhysics(0);
  }

  private updateTurretPhysics(direction:number):void {
    const mount=this.skin.hull.turretMountPoint;
    this.turretCollisions.forEach((box,i)=>{
      const transform=box.localTransform!;
      transform.setMatrix(mount.x+this.skinCenterOffset.x,mount.y+this.skinCenterOffset.y,mount.z+this.skinCenterOffset.z,0,0,direction);
      transform.prepend(this.turretGeometry[i].transform);
    });
  }

  private rotateTurret(dt: number): void {
    this.turretController.rotate(dt, this.tankBody.body.baseMatrix);
    this.updateTurretPhysics(this.turretController.getDirection());
    this.sounds?.playTurretSound(this.turretController.isRotating() && this.turretSoundAllowed(),this.turretSoundVolume());
  }

  private savePhysicsState(): void {
    this.prevState.copy(this.tankBody.body.state);
  }

  private createBody(mass: number, halfSize: Vector3): void {
    const body = new Body(mass, Matrix3.ZERO, 0);
    setBoxInvInertia(mass, halfSize, body.invInertia);
    body.data = this;
    this.tankBody = new TankBody(body);
  }

  /** § !#§ */
  private createCollisionShapes(halfSize: Vector3): void {
    const height = 2 * halfSize.z - (this.suspensionParams.nominalRayLength - TankConst.TRACK_RAY_Z_OFFSET);
    createTankCollisionBox(halfSize, height, this.tankBody);
    createStaticCollisionBoxes(halfSize, height, this.tankBody);
    this.setBoundSphereRadius(halfSize, height);
  }

  private setBoundSphereRadius(halfSize: Vector3, height: number): void {
    const v = new Vector3(halfSize.x, halfSize.y, height / 2);
    const localTransform = this.tankBody.tankCollisionBox.localTransform as Matrix4;
    this.boundSphereRadius = v.length() + Math.abs(localTransform.l);
  }

  private calculateSkinCenterOffset(size: Vector3): void {
    const b = this.skin.hull.bounds;
    this.skinCenterOffset.x = -0.5 * (b.minX + b.maxX);
    this.skinCenterOffset.y = -0.5 * (b.minY + b.maxY);
    this.skinCenterOffset.z = -0.5 * size.z - this.suspensionParams.nominalRayLength + TankConst.TRACK_RAY_Z_OFFSET;
  }

  getHalfLength(): number {
    return this.halfLength;
  }

  getBoundSphereRadius(): number {
    return this.boundSphereRadius;
  }

  applyWeaponHit(position: Vector3, direction: Vector3, force: number): void {
    if (this.health > 0) {
      this.tankBody.body.addWorldForceScaled(position, direction, force);
      this.tankBody.additionForcesSum.addScaled(force, direction);
    }
  }

  /** гусеница стоит на статике, а не на другом танке (клиент 2019) */
  hasTracksContactsWithStatic(): boolean {
    return this.chassis.leftTrack.hasContactsWithStatic() || this.chassis.rightTrack.hasContactsWithStatic();
  }

  setStabilizationAcceleration(value: number): void {
    this.chassis.setStabilizationAcceleration(value);
  }

  setAcceleration(value: number): void {
    this.chassis.setAcceleration(value);
  }

  setReverseAcceleration(value: number): void {
    this.chassis.setReverseAcceleration(value);
  }

  setSideAcceleration(value: number): void {
    this.chassis.setSideAcceleration(value);
  }

  setTurnAcceleration(value: number): void {
    this.chassis.setTurnAcceleration(value);
  }

  setReverseTurnAcceleration(value: number): void {
    this.chassis.setReverseTurnAcceleration(value);
  }

  getTurretMatrix(): Matrix4 {
    return this.skin.turretMatrix;
  }
}

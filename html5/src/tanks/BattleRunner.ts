// 1:1 из alternativa/tanks/battle/BattleRunner.as: фиксированный шаг физики 33 мс,
// догонка не больше 200 мс, затем интерполяция состояния для отрисовки.
import { PhysicsScene } from '../physics/PhysicsScene.ts';
import { Vector3 } from '../physics/math/Vector3.ts';
import type { CollisionShape } from '../physics/collision/CollisionShape.ts';
import { TanksCollisionDetector } from './physics/TanksCollisionDetector.ts';
import type { TankBody } from './physics/TankBody.ts';

const MAX_FRAME_LAG = 200; // §%"6§
const PHYSICS_STEP = 33; // §7"§
const TIME_SCALE = 1000; // §6e§
const MAX_UP_VELOCITY = 200; // TankPhysicsScene 2019
const upAxis = new Vector3();

export interface LogicUnit {
  runLogic(time: number, delta: number): void;
}

export interface PhysicsController {
  runBeforePhysicsUpdate(dt: number): void;
}

export interface PostPhysicsController {
  runAfterPhysicsUpdate(dt: number): void;
}

export interface PhysicsInterpolator {
  interpolatePhysicsState(t: number): void;
}

export class BattleRunner {
  private readonly physicsScene: PhysicsScene; // §8]§
  private readonly collisionDetector: TanksCollisionDetector; // §,"+§
  private time: number; // §4x§
  private readonly logicUnits: LogicUnit[] = []; // §=b§
  private readonly physicsControllers: PhysicsController[] = []; // §2!;§
  private readonly postPhysicsControllers: PostPhysicsController[] = []; // §@!d§
  private readonly physicsInterpolators: PhysicsInterpolator[] = []; // §2&§

  constructor(gravity: number) {
    this.physicsScene = new PhysicsScene();
    this.physicsScene.gravity.reset(0, 0, -gravity);
    this.physicsScene.collisionIterations = 4;
    this.physicsScene.contactIterations = 4;
    this.physicsScene.allowedPenetration = 5;
    this.collisionDetector = new TanksCollisionDetector();
    this.physicsScene.collisionDetector = this.collisionDetector;
    this.time = performance.now();
    this.physicsScene.time = this.time;
  }

  buildStaticGeometry(shapes: CollisionShape[]): void {
    this.collisionDetector.buildKdTree(shapes);
  }

  getCollisionDetector(): TanksCollisionDetector {
    return this.collisionDetector;
  }

  getPhysicsScene(): PhysicsScene {
    return this.physicsScene;
  }

  addLogicUnit(unit: LogicUnit): void {
    if (this.logicUnits.indexOf(unit) < 0) this.logicUnits.push(unit);
  }

  addBodyWrapper(tankBody: TankBody): void {
    this.physicsScene.addBody(tankBody.body);
    this.collisionDetector.addTankBody(tankBody);
  }

  removeBodyWrapper(tankBody: TankBody): void {
    this.physicsScene.removeBody(tankBody.body);
    this.collisionDetector.removeTankBody(tankBody);
  }

  addPhysicsController(controller: PhysicsController): void {
    if (this.physicsControllers.indexOf(controller) < 0) this.physicsControllers.push(controller);
  }

  addPostPhysicsController(controller: PostPhysicsController): void {
    if (this.postPhysicsControllers.indexOf(controller) < 0) this.postPhysicsControllers.push(controller);
  }

  addPhysicsInterpolator(interpolator: PhysicsInterpolator): void {
    if (this.physicsInterpolators.indexOf(interpolator) < 0) this.physicsInterpolators.push(interpolator);
  }

  removePhysicsController(controller: PhysicsController): void {
    const index = this.physicsControllers.indexOf(controller);
    if (index >= 0) this.physicsControllers.splice(index, 1);
  }

  removePostPhysicsController(controller: PostPhysicsController): void {
    const index = this.postPhysicsControllers.indexOf(controller);
    if (index >= 0) this.postPhysicsControllers.splice(index, 1);
  }

  removePhysicsInterpolator(interpolator: PhysicsInterpolator): void {
    const index = this.physicsInterpolators.indexOf(interpolator);
    if (index >= 0) this.physicsInterpolators.splice(index, 1);
  }

  /** Один кадр: логика, физика, интерполяция. Возвращает время кадра (мс) для отрисовки. */
  tick(frameTime = performance.now()): number {
    const now = Math.max(this.time, frameTime);
    const delta = now - this.time;
    this.time = now;
    this.runLogic(now, delta);
    this.runPhysics(PHYSICS_STEP);
    return delta;
  }

  private runLogic(time: number, delta: number): void {
    for (const unit of this.logicUnits) unit.runLogic(time, delta);
  }

  private runPhysics(step: number): void {
    const scene = this.physicsScene;
    if (this.time - scene.time > MAX_FRAME_LAG) scene.time = this.time - MAX_FRAME_LAG;
    while (scene.time < this.time) {
      this.stepPhysics(step);
    }
    this.runPhysicsInterpolators();
  }

  /** One fixed physics step, also used by the headless server bot simulation. */
  stepPhysics(step=PHYSICS_STEP):void{
    this.runPhysicsControllers(step/TIME_SCALE);
    this.physicsScene.update(step);
    this.postPhysicsTankProcessor();
    this.runPostPhysicsControllers(step/TIME_SCALE);
  }

  /**
   * TankPhysicsScene.postPhysicsTankProcessor клиента 2019: скорость «вверх» по оси танка не больше
   * 200 (кроме подлёта от попаданий и уже начатого прыжка) — танк не подбрасывает от ударов о статику
   * и других танков.
   */
  private postPhysicsTankProcessor(): void {
    for (const tankBody of this.collisionDetector.getTankBodies()) {
      const velocity = tankBody.body.state.velocity;
      const up = tankBody.body.state.orientation.getZAxis(upAxis);
      let upSpeed = velocity.x * up.x + velocity.y * up.y + velocity.z * up.z;
      if (up.z < -0.1 || (up.z < 0.1 && upSpeed < 0)) {
        upSpeed = -upSpeed;
        up.reverse();
      }
      tankBody.updateSoaring(this.collisionDetector);
      if (tankBody.hasStaticContacts || tankBody.wasStaticContacts || tankBody.hasTankContacts || !tankBody.isSoaring()) {
        let limit = MAX_UP_VELOCITY;
        if (!tankBody.hasStaticContacts && tankBody.isSoaring() && tankBody.previousUpVelocity > limit) {
          limit = tankBody.previousUpVelocity;
        }
        let hitSpeed = (tankBody.additionForcesSum.dot(up) * tankBody.body.invMass * PHYSICS_STEP) / 1000;
        if (hitSpeed < MAX_UP_VELOCITY) hitSpeed = 0;
        limit = Math.max(hitSpeed, limit);
        if (upSpeed > limit) {
          const excess = upSpeed - limit;
          velocity.x -= excess * up.x;
          velocity.y -= excess * up.y;
          velocity.z -= excess * up.z;
          upSpeed = limit;
        }
      }
      tankBody.previousUpVelocity = upSpeed;
      tankBody.additionForcesSum.reset();
    }
  }

  private runPhysicsControllers(dt: number): void {
    for (const controller of this.physicsControllers) controller.runBeforePhysicsUpdate(dt);
  }

  private runPostPhysicsControllers(dt: number): void {
    for (const controller of this.postPhysicsControllers) controller.runAfterPhysicsUpdate(dt);
  }

  private runPhysicsInterpolators(): void {
    const t = 1 + (this.time - this.physicsScene.time) / PHYSICS_STEP;
    for (const interpolator of this.physicsInterpolators) interpolator.interpolatePhysicsState(t);
  }
}

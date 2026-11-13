// Разовая проверка механики Рикошета без сервера: энергия, автоматическая очередь, отскок и попадание
// в самого стрелка. Запуск: node --experimental-transform-types html5/tools/ricochet-unit.ts
import { Matrix4 } from '../src/physics/math/Matrix4.ts';
import { Vector3 } from '../src/physics/math/Vector3.ts';
import { RayHit } from '../src/physics/collision/types.ts';
import { RicochetData, RicochetWeapon } from '../src/tanks/weapon/RicochetWeapon.ts';
import { WeaponForces } from '../src/tanks/weapon/SmokyWeapon.ts';

class FakeDetector {
  wallX = 1e9;
  shooterBody: any = null;
  raycast(origin: Vector3, direction: Vector3, _mask: number, maxTime: number, filter: any, hit: RayHit): boolean {
    let best = Infinity;
    let kind: 'wall' | 'tank' | null = null;
    let normal = new Vector3();
    if (direction.x > 1e-9) {
      const t = (this.wallX - origin.x) / direction.x;
      if (t >= 0 && t <= maxTime && t < best) {
        best = t;
        kind = 'wall';
        normal = new Vector3(-1, 0, 0);
      }
    }
    if (this.shooterBody && (!filter || filter.considerBody(this.shooterBody))) {
      const b = 2 * (origin.x * direction.x + origin.y * direction.y + origin.z * direction.z);
      const c = origin.x * origin.x + origin.y * origin.y + origin.z * origin.z - 100 * 100;
      const disc = b * b - 4 * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / 2;
        if (t >= 0 && t <= maxTime && t < best) {
          best = t;
          kind = 'tank';
        }
      }
    }
    if (!kind) return false;
    hit.t = best;
    hit.position.copy(origin).addScaled(best, direction);
    hit.normal.copy(normal);
    hit.shape = { body: kind === 'tank' ? this.shooterBody : { data: null } } as any;
    return true;
  }
  raycastStatic(): boolean {
    return false;
  }
  getTankBodies(): any[] {
    return [];
  }
}

class FakeRunner {
  readonly controllers: any[] = [];
  constructor(readonly detector: FakeDetector) {}
  addPhysicsController(controller: any): void {
    this.controllers.push(controller);
  }
  removePhysicsController(controller: any): void {
    const index = this.controllers.indexOf(controller);
    if (index >= 0) this.controllers.splice(index, 1);
  }
  addPhysicsInterpolator(): void {}
  removePhysicsInterpolator(): void {}
  getCollisionDetector(): any {
    return this.detector;
  }
}

function makeTank(detector: FakeDetector): { tank: any; body: any; matrix: Matrix4 } {
  const matrix = new Matrix4(0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0);
  const body: any = { data: null, state: { position: new Vector3() }, addWorldForceScaled(): void {} };
  const tank: any = {
    health: 100,
    friendly: true,
    skin: { turret: { muzzles: [new Vector3(0, 0, 0)] } },
    getTurretMatrix: () => matrix,
    getBody: () => body,
    applyWeaponHit(): void {},
  };
  body.data = tank;
  detector.shooterBody = body;
  return { tank, body, matrix };
}

function makeWeapon(detector: FakeDetector, runner: FakeRunner, tank: any) {
  const controller: any = {
    trigger: true,
    wasActive() { return this.trigger; },
    isTriggerPulled() { return this.trigger; },
    discardStoredAction(): void {},
  };
  const weapon = new RicochetWeapon(600, new WeaponForces(100, 100), controller, runner as any);
  weapon.init(tank);
  weapon.enable();
  return { weapon, controller };
}

function energyTest(): void {
  const detector = new FakeDetector();
  const runner = new FakeRunner(detector);
  const { tank } = makeTank(detector);
  const { weapon } = makeWeapon(detector, runner, tank);
  const start = performance.now();
  const shots: number[] = [];
  for (let time = 0; time <= 7400; time += 100) {
    const before = runner.controllers.length;
    weapon.runLogic(start + time, 100);
    if (runner.controllers.length > before) shots.push(time);
  }
  const status = weapon.getStatus();
  const expected = [0, 600, 1200, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600, 7400];
  // после 12-го выстрела энергии на 7200 не хватает (115 < 133.71), на 7400 — хватает (135.48)
  const ok = shots.length === expected.length && shots.every((time, index) => time === expected[index]);
  console.log(ok ? 'OK' : 'FAIL', 'очередь по энергии:', shots.join(', '));
  console.log(status < 0.01 ? 'OK' : 'FAIL', `баллон после последнего выстрела ${(status * 100).toFixed(2)}%`);
}

function bounceTest(): void {
  const detector = new FakeDetector();
  detector.wallX = 1000;
  const runner = new FakeRunner(detector);
  const { tank } = makeTank(detector);
  const { weapon } = makeWeapon(detector, runner, tank);
  const hits: { bounces: number; target: any }[] = [];
  weapon.listener = {
    onShot: () => undefined,
    onShotHit: (_id, target, _point, bounces) => hits.push({ bounces, target }),
  };
  const start = performance.now();
  weapon.runLogic(start, 16);
  const shot = runner.controllers[0];
  if (!shot) {
    console.log('FAIL', 'шар не создан');
    return;
  }
  for (let i = 0; i < 60 && hits.length === 0; i++) shot.runBeforePhysicsUpdate(0.016);
  console.log(hits.length === 1 && hits[0].target === tank ? 'OK' : 'FAIL', `попадание в стрелка после отскока: ${hits.length ? hits[0].bounces : 'нет'}`);
}

energyTest();
bounceTest();

// Regression: only the shooter's own shell in an empty scene; no second tank.
function radialMovementTest(): void {
  const detector = new FakeDetector();
  const runner = new FakeRunner(detector);
  const {tank} = makeTank(detector);
  const {weapon} = makeWeapon(detector,runner,tank);
  weapon.runLogic(performance.now(),16);
  const shot = runner.controllers[0] as any;
  const before = shot.radialPoints.map((p: Vector3)=>p.clone());
  const centre = shot.position.clone();
  shot.runBeforePhysicsUpdate(0.016);
  const delta = shot.position.clone().diff(shot.position, centre);
  for(let i=0;i<6;i++) {
    const expected = before[i].add(delta);
    if(new Vector3().diff(shot.radialPoints[i],expected).length()>1e-6) throw new Error('radial ray stayed behind shell');
  }
  console.log('OK six radial rays follow shell centre');
}
radialMovementTest();

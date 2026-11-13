// Offline checks only: own weapon/controller and an empty scene. No second tank or server login.
// node --experimental-transform-types html5/tools/isida-unit.ts
import assert from 'node:assert/strict';
import { Matrix4 } from '../src/physics/math/Matrix4.ts';
import { Vector3 } from '../src/physics/math/Vector3.ts';
import { IsidaWeapon, ISIDA_DEFAULT } from '../src/tanks/weapon/IsidaWeapon.ts';
import { WeaponForces } from '../src/tanks/weapon/SmokyWeapon.ts';
import type { Tank } from '../src/tanks/tank/Tank.ts';
import type { SimpleKeyboardWeaponController } from '../src/tanks/tank/Controllers.ts';
import type { TanksCollisionDetector } from '../src/tanks/physics/TanksCollisionDetector.ts';
import type { EffectsScene } from '../src/tanks/sfx/SmokyEffects.ts';

let pulled = false;
const controller = { isTriggerPulled: () => pulled, discardStoredAction() {} } as SimpleKeyboardWeaponController;
const detector = { hasStaticHit: () => false, raycast: () => false } as unknown as TanksCollisionDetector;
const ownBody = { state: { position: new Vector3() } };
const own = { skin: { turret: { muzzles: [new Vector3(0,100,0)] } },
  getBody: () => ownBody, getTurretMatrix: () => new Matrix4() } as unknown as Tank;
const gun = new IsidaWeapon(new WeaponForces(0,0), controller, detector, {} as EffectsScene);
gun.configureIsida({ ...ISIDA_DEFAULT, capacity: 10, chargeRate: 2, dischargeIdleRate: 5 });
gun.init(own); gun.enable();
let starts = 0, stops = 0, ticks = 0;
gun.listener = { onStart: () => starts++, onStop: () => stops++, onTick: () => ticks++ };
const time = performance.now();
const step = (ms: number) => gun.runLogic(time+ms,33);
pulled = true; step(0);
assert.equal(gun.isFiring,true);
step(1000); assert.ok(Math.abs(gun.getStatus()-0.5)<0.001);
step(2100); assert.equal(gun.isFiring,false); assert.equal(stops,1);
step(3100); assert.ok(Math.abs(gun.getStatus()-0.2)<0.001);
assert.equal(gun.isFiring,false,'held trigger must not restart after depletion');
assert.equal(starts,1); assert.equal(ticks,0,'idle has no damage ticks');
pulled=false;step(3133);pulled=true;step(3166);
assert.equal(gun.isFiring,true,'release and fresh press restart'); assert.equal(starts,2);
gun.disable(); assert.equal(gun.isFiring,false); assert.equal(stops,2);
step(4000); assert.equal(gun.isFiring,false,'disabled weapon cannot start');
console.log('Isida: idle drain, recharge, empty-trigger latch, release/restart, disable, no idle ticks — OK');

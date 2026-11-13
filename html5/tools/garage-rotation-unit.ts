import assert from 'node:assert/strict';
import {GarageRotation} from '../src/ui/lobby/GarageRotation.ts';
const r=new GarageRotation();r.resetClock(0);r.begin(0,600,0);r.move(50);r.update(16);r.move(100);r.update(32);r.end(101,33);
assert.ok(Math.abs(r.speed)>1,'frame samples preserve release speed despite a tiny last pointer event');
const angle=r.angle,speed=r.speed;r.update(49);assert.ok(r.angle<angle);assert.ok(Math.abs(r.speed)<Math.abs(speed));assert.ok(Math.abs(r.speed-speed*Math.exp(-1.5*.016))<1e-10);
r.begin(100,600,50);r.move(200);r.update(66);r.update(82);r.update(98);r.end(200,100);assert.equal(r.speed,0,'holding mouse stationary before release cancels momentum');
r.cancel(100);r.update(10099);assert.equal(r.speed,0);r.update(10100);assert.ok(r.speed>0,'original 10s auto-rotation delay');r.cancel(10101);assert.equal(r.speed,0);
console.log('Garage rotation: per-frame sampling, release momentum, original exponential decay, stationary release, auto delay and cancellation OK');

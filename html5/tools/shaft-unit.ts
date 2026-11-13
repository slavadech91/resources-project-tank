// Own weapon + empty map: no login, opponent or account changes.
import assert from 'node:assert/strict';
import { ShaftWeapon,ShaftData } from '../src/tanks/weapon/ShaftWeapon.ts';
import { AllGlobalGunParams,WeaponForces } from '../src/tanks/weapon/SmokyWeapon.ts';
import { Vector3 } from '../src/physics/math/Vector3.ts';
import { Matrix4 } from '../src/physics/math/Matrix4.ts';
let now=1000,pulled=false,shots:boolean[]=[],aims:boolean[]=[];
Object.defineProperty(performance,'now',{value:()=>now,configurable:true});
const controller={isTriggerPulled:()=>pulled,wasActive:()=>pulled,discardStoredAction:()=>{}};
const detector={getTankBodies:()=>[],hasStaticHit:()=>false,raycast:()=>false,raycastStatic:()=>false};
let recoilForce=NaN;
const body={state:{position:new Vector3()},addWorldForceScaled:(_p:Vector3,_d:Vector3,force:number)=>{recoilForce=force;}};
const mountMatrix=new Matrix4();
const tank={skin:{turret:{muzzles:[new Vector3(0,100,0)]}},getTurretMatrix:()=>mountMatrix,getBody:()=>body,getTurretController:()=>({isRotating:()=>false})};
const gun=new ShaftWeapon(1000,new WeaponForces(0,321),controller as any,detector as any,0.2,0.2);
gun.configure(new ShaftData(1000,1000,200,1000,500,0.24,500));
gun.init(tank as any);gun.enable();
gun.listener={onAim:v=>aims.push(v),onShot:aimed=>shots.push(aimed)};
function step(ms:number){now+=ms;gun.runLogic(now,ms);}
pulled=true;step(0);step(100);pulled=false;step(0);
assert.deepEqual(shots,[false],'short release fires arcade');assert.equal(gun.getStatus(),0);
step(1000);pulled=true;step(0);step(200);
assert.equal(gun.isAiming,true);assert.equal(gun.getStatus(),1,'entering scope does not erase energy');
step(500);assert.ok(Math.abs(gun.getStatus()-0.9)<1e-8,'energy drains continuously through transition');
gun.aimMouse(0,-100,8,false,0.001);step(1000);
const params=new AllGlobalGunParams();gun.getScopeParams(params);
assert.ok(params.direction.z>0,'vertical input elevates actual shot direction');
assert.ok(Math.abs(params.direction.length()-1)<1e-8);
assert.ok(Math.abs(gun.scopeFov-(0.6981+(2*Math.atan(Math.tan(0.4014/2)/2)-0.6981)*0.3))<1e-8,'FOV follows spent charge');
const beforeShotView=new AllGlobalGunParams();gun.getScopeCameraParams(beforeShotView);
pulled=false;step(0);assert.deepEqual(shots,[false,true]);assert.equal(gun.isAiming,true,'post-shot scope pause');
assert.equal(recoilForce,-321,'aimed shot keeps its complete physical recoil force');
mountMatrix.setMatrix(0,-60,80,0.35,0,0);
const afterShotView=new AllGlobalGunParams();gun.getScopeCameraParams(afterShotView);
assert.deepEqual(afterShotView.direction,beforeShotView.direction,'recoil pitch does not lift the post-shot camera');
assert.deepEqual(afterShotView.barrelOrigin,beforeShotView.barrelOrigin,'post-shot camera retains its world position');
gun.getScopeParams(params);assert.ok(params.direction.clone().subtract(beforeShotView.direction).length()>0.1,'physical gun still follows the recoiling body');
mountMatrix.setMatrix(0,0,0,0,0,0);
step(500);assert.equal(gun.isAiming,false);assert.ok(gun.getStatus()>0.7,'remaining energy is preserved');
step(1000);pulled=true;step(0);step(200);step(100);pulled=false;step(0);
assert.deepEqual(shots,[false,true,false],'release during activation is an arcade shot');
assert.deepEqual(aims,[true,true,false]);
console.log('Shaft: arcade, activation, gradual drain, elevation, FOV, aimed release, scope pause and activation cancellation OK');

// The mouse target must move before the actual mount and remain fixed while it catches up.
const {LocalTurretController}=await import('../src/tanks/tank/Controllers.ts');
const {Matrix3}=await import('../src/physics/math/Matrix3.ts');
const mount=new LocalTurretController(0.2,0.47,{addListener:()=>{}} as any);
gun.setAimWorldDirection=angle=>mount.aimAtWorldDirection(angle);
gun.reset();gun.enable();pulled=true;step(0);step(200);step(500);
gun.aimMouse(100,-100,8,false,0.001);
const wanted=gun.getScopeTargetDirection();
gun.getScopeParams(params);
assert.ok(wanted.x>0.09 && wanted.z>0.09,'brackets respond to mouse on both axes immediately');
assert.equal(params.direction.x,0,'mouse does not teleport the physical turret');
const base=new Matrix3();
for(let i=0;i<100;i++){
  mount.rotate(0.01,base);mountMatrix.setRotationMatrix(0,0,mount.getDirection());step(10);
}
gun.getScopeParams(params);
assert.ok(params.direction.clone().subtract(wanted).length()<1e-8,'physical sight catches up with the fixed mouse target');
gun.aimMouse(100000,100000,8,false,0.001);
const limited=gun.getScopeTargetDirection();
const actualYaw=Math.atan2(-params.direction.x,params.direction.y),targetYaw=Math.atan2(-limited.x,limited.y);
assert.ok(Math.abs(targetYaw-actualYaw)<=Math.PI/12+1e-8,'horizontal separation capped at Narukami 15 degrees');
console.log('Shaft mouse: instant independent target, physical mount/elevation catch-up, bounded separation OK');

let audioStopped=false;
gun.effects={startAimSounds:()=>({stop:()=>{audioStopped=true;},setMoving:()=>{},stopCharging:()=>{}}),
  createShotEffects:()=>{},createShotTrail:()=>{},createExplosionEffects:()=>{},createExplosionMark:()=>{}} as any;
gun.reset();gun.enable();pulled=true;step(0);step(200);step(500);
gun.listener={onAim:()=>{},onShot:()=>assert.equal(audioStopped,true,'aim audio stops before the shot callback')};
pulled=false;step(0);assert.equal(audioStopped,true);assert.equal(gun.isAiming,true,'camera may remain during post-shot pause while audio is already stopped');
console.log('Shaft: audio stops synchronously on shot, before leaving post-shot scope pause OK');

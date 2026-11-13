// Empty-scene regression checks; no server login or second tank.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Vector3 } from '../src/physics/math/Vector3.ts';
import { TextureAnimation, EffectsScene } from '../src/tanks/sfx/SmokyEffects.ts';
import { FlamethrowerEffect, FREEZE_VISUAL } from '../src/tanks/sfx/FlamethrowerEffects.ts';
import type { Sound, SoundManager } from '../src/tanks/sfx/Sound.ts';
import type { TanksCollisionDetector } from '../src/tanks/physics/TanksCollisionDetector.ts';

const parent=new THREE.Group();
let wall=false;
const detector={raycastStatic: (_o:unknown,_d:unknown,_mask:number,_length:number,_filter:unknown,hit:{t:number})=>{hit.t=0;return wall;}} as unknown as TanksCollisionDetector;
const scene=new EffectsScene(parent,detector);
const texture=new THREE.Texture({width:2750,height:150} as any);
const animation=new TextureAnimation(texture,[{u0:0,v0:0,u1:1,v1:1}],30);
const sound={play:()=>null} as unknown as Sound;
const manager={addEffect:()=>{}} as unknown as SoundManager;
const effect=new FlamethrowerEffect(animation,texture,sound,manager,scene,{},FREEZE_VISUAL,animation);
effect.configure(20,0);effect.aim(new Vector3(),new Vector3(0,1,0));effect.start();
effect.play(16,new Vector3(0,-1000,500));
const particles=parent.children.filter(o=>o instanceof THREE.Sprite) as THREE.Sprite[];
assert.equal(particles.length,1);assert.ok(particles[0].position.y>90);
const y=particles[0].position.y,size=particles[0].scale.x;
effect.stop();assert.equal(effect.play(100,new Vector3(0,-1000,500)),true);
assert.ok(Math.abs(particles[0].position.y-y-200)<1e-6,'particle speed is range cm/s');
assert.ok(particles[0].scale.x>size,'particles grow with travelled distance');
assert.equal(parent.children.filter(o=>o instanceof THREE.Sprite).length,1,'no emission after stop');
wall=true;assert.equal(effect.play(16,new Vector3()),false,'wall removes remaining particles');
effect.destroy();assert.equal(parent.children.length,0,'all meshes removed');
console.log('Freeze: emission, range-based speed, growth, stop/drain, wall collision and cleanup OK');

// Own weapon in an empty collision scene: delayed ticks, full tank budget, no auto-restart.
const { StreamWeapon, StreamData } = await import('../src/tanks/weapon/StreamWeapon.ts');
const { WeaponForces } = await import('../src/tanks/weapon/SmokyWeapon.ts');
const { Matrix4 } = await import('../src/physics/math/Matrix4.ts');
let trigger=true,ticks=0,stops=0;
const controller={isTriggerPulled:()=>trigger,discardStoredAction:()=>{}};
const empty={hasStaticHit:()=>false,getTankBodies:()=>[]};
const gun=new StreamWeapon(new WeaponForces(0,0),controller as any,empty as any,scene,'freeze');
gun.configure(new StreamData('freeze',500,1000,100,14000,0.7,20));
gun.init({skin:{turret:{muzzles:[new Vector3(0,100,0)]}},getTurretMatrix:()=>new Matrix4(),getBody:()=>({state:{position:new Vector3()}})} as any);
gun.listener={onStart:()=>{},onTick:()=>ticks++,onStop:()=>stops++};gun.enable();
const start=performance.now();gun.runLogic(start,0);assert.equal(ticks,0,'no immediate damage tick');
for(let ms=33;ms<=12000;ms+=33)gun.runLogic(start+ms,33);
assert.equal(ticks,20,'last energy-budget tick is retained');assert.equal(stops,1);assert.equal(gun.isFiring,false);
trigger=false;gun.runLogic(start+12033,33);trigger=true;gun.runLogic(start+12066,33);assert.equal(gun.isFiring,true);
console.log('Freeze: first-tick delay, complete energy budget and trigger latch OK');

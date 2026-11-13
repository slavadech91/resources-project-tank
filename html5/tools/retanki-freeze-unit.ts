import assert from 'node:assert/strict';
import * as THREE from 'three';
import {RetankiFreezeEffect} from '../src/tanks/sfx/RetankiFreezeEffect.ts';
import {EffectsScene} from '../src/tanks/sfx/SmokyEffects.ts';
import {Vector3} from '../src/physics/math/Vector3.ts';
const parent=new THREE.Group(),scene=new EffectsScene(parent,{raycastStatic:()=>false} as any);
const textures=Array.from({length:16},()=>new THREE.Texture());
const effect=new RetankiFreezeEffect(scene,textures,textures,{play:()=>null} as any,{addEffect:()=>{}} as any);
effect.aim(new Vector3(),new Vector3(0,1,0));effect.start();
for(let i=0;i<500;i++){effect.play(16,new Vector3());assert.equal(parent.children.length,84);for(const child of parent.children){assert.ok(child.scale.x<=340);assert.ok(Number.isFinite(child.position.y));}}
assert.ok(parent.children.some(p=>p.visible));effect.stop();for(let i=0;i<50;i++)effect.play(16,new Vector3());assert.equal(parent.children.filter(p=>p.visible).length,0);
effect.destroy();assert.equal(parent.children.length,0);console.log('ReTanki Freeze: bounded two-layer pools, particle growth, stop/drain and cleanup OK');

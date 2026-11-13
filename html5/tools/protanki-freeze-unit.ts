import assert from 'node:assert/strict';
import * as THREE from 'three';
import {PROTANKI_FREEZE_VISUAL} from '../src/tanks/sfx/FreezeEffects.ts';
import {FlamethrowerEffect} from '../src/tanks/sfx/FlamethrowerEffects.ts';
import {TextureAnimation,EffectsScene} from '../src/tanks/sfx/SmokyEffects.ts';
import {Vector3} from '../src/physics/math/Vector3.ts';
for(const range of [10,30]){
 const parent=new THREE.Group(),scene=new EffectsScene(parent,{raycastStatic:()=>false} as any),texture=new THREE.Texture();
 texture.image={width:150,height:150};
 const animation=new TextureAnimation(texture,[{u0:0,v0:0,u1:1,v1:1}],30);
 const effect=new FlamethrowerEffect(animation,texture,{play:()=>null} as any,{addEffect:()=>{}} as any,scene,{},PROTANKI_FREEZE_VISUAL);
 effect.configure(range,0);effect.aim(new Vector3(),new Vector3(0,1,0));effect.start();effect.play(16,new Vector3(0,-1000,500));
 const p=parent.children.find(p=>p instanceof THREE.Sprite)!;const y=p.position.y;
 effect.stop();effect.play(100,new Vector3(0,-1000,500));assert.ok(Math.abs(p.position.y-y-200)<.0001,'particle travels at fixed 2000cm/s independently of range');effect.destroy();
}
assert.equal(PROTANKI_FREEZE_VISUAL.maxParticles,20);assert.equal(PROTANKI_FREEZE_VISUAL.length,350);assert.equal(PROTANKI_FREEZE_VISUAL.width,210);
console.log('Protanki Freeze: source plane dimensions, fixed speed independent of range and particle limit OK');

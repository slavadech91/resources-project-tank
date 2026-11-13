// Narukami ThunderShotEffect/Trail: three screen-blended sprites and three triangular rays.
import * as THREE from 'three';
import {Vector3} from '../../physics/math/Vector3.ts';
import type {Matrix4} from '../../physics/math/Matrix4.ts';

const FLASH_DURATION_MS=100;
const ORIGINAL_DURATION_SECONDS=0.05;
const SPRITE_START=[40,75,80];
const SPRITE_SPEED=[500,1000,1500];
const RAY_SPEED=[1500,2500,1300];

export class ThunderShotEffect{
 private sprites:THREE.Sprite[]=[];private rays:THREE.Mesh[]=[];
 private elapsed=0;
 private firstFrame=true;
 private angles=[Math.random()*Math.PI*2,Math.random()*Math.PI*2,Math.random()*Math.PI*2];
 constructor(parent:THREE.Object3D,private muzzle:Vector3,private matrix:Matrix4,material:THREE.Material){
  const map=(material as THREE.MeshBasicMaterial).map;
  for(const size of [120,99.75,79.5]){
   const flash=new THREE.SpriteMaterial({
    map,transparent:true,premultipliedAlpha:true,depthWrite:false,
    blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcColorFactor,
    rotation:Math.random()*Math.PI*2,
   });
   // Three's sprite shader omits premultiplication. Screen blending needs RGB × alpha.
   flash.onBeforeCompile=shader=>{
    shader.fragmentShader=shader.fragmentShader.replace(
     '#include <fog_fragment>',
     '#include <fog_fragment>\n#include <premultiplied_alpha_fragment>',
    );
   };
   const sprite=new THREE.Sprite(flash);
   sprite.scale.set(size,size,1);sprite.renderOrder=10;parent.add(sprite);this.sprites.push(sprite);
  }
  for(const scale of [.8,.75,.82]){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([-4,0,0,4,0,0,0,240*scale,0],3));const ray=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0xfcbe0e,transparent:true,premultipliedAlpha:true,opacity:.3,depthWrite:false,side:THREE.DoubleSide,blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcColorFactor}));ray.renderOrder=10;parent.add(ray);this.rays.push(ray);}
 }
 play(delta:number,_camera:Vector3):boolean{
  // The first delta belongs to the frame before the shot appeared.
  if(this.firstFrame)this.firstFrame=false;
  else this.elapsed+=delta;
  if(this.elapsed>=FLASH_DURATION_MS)return false;

  const animationTime=ORIGINAL_DURATION_SECONDS*this.elapsed/FLASH_DURATION_MS;
  const m=this.matrix,origin=new Vector3();
  m.transformVector(this.muzzle,origin);
  const direction=new THREE.Vector3(m.b,m.f,m.j).normalize();
  const barrelAxis=new THREE.Vector3(0,1,0);
  const base=new THREE.Quaternion().setFromUnitVectors(barrelAxis,direction);
  this.sprites.forEach((sprite,i)=>{
   const distance=SPRITE_START[i]+SPRITE_SPEED[i]*animationTime;
   sprite.position.set(origin.x,origin.y,origin.z).addScaledVector(direction,distance);
  });
  this.rays.forEach((ray,i)=>{
   ray.quaternion.copy(base).multiply(new THREE.Quaternion().setFromAxisAngle(barrelAxis,this.angles[i]));
   const offset=new THREE.Vector3([0,-7,7][i],0,i===0?10:0).applyQuaternion(ray.quaternion);
   ray.position.set(origin.x,origin.y,origin.z).addScaledVector(direction,RAY_SPEED[i]*animationTime).add(offset);
  });
  return true;
 }
 destroy():void{for(const sprite of this.sprites){sprite.removeFromParent();sprite.material.dispose();}for(const ray of this.rays){ray.removeFromParent();ray.geometry.dispose();(ray.material as THREE.Material).dispose();}}
}

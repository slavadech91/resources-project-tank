import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { Matrix4 } from '../../physics/math/Matrix4.ts';
import type { GraphicEffect } from './SmokyEffects.ts';

// Gen2 muzzle is a single still, not a 30fps animation: explicitly time its visibility.
export class ShaftMuzzleFlash implements GraphicEffect {
  private readonly sprite:THREE.Sprite;
  private left=150;
  private first=true;
  constructor(parent:THREE.Object3D,texture:THREE.Texture,private muzzle:Vector3,private matrix:Matrix4){
    const material=new THREE.SpriteMaterial({map:texture,transparent:true,depthWrite:false,fog:false});
    material.onBeforeCompile=shader=>{
      shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
        #include <map_fragment>
        float edgeDistance=length((vMapUv-vec2(0.5))*2.0);
        diffuseColor.a*=1.0-smoothstep(0.65,1.0,edgeDistance);
      `);
    };
    material.customProgramCacheKey=()=> 'shaft-muzzle-soft-alpha-v1';
    this.sprite=new THREE.Sprite(material);
    this.sprite.scale.set(80,80,1);this.sprite.renderOrder=10;parent.add(this.sprite);
  }
  play(delta:number,_camera:Vector3):boolean{
    // Guarantee an initial rendered frame even when the first update catches up a long frame.
    if(this.first)this.first=false;else this.left-=delta;
    const point=new Vector3();this.matrix.transformVector(this.muzzle,point);
    this.sprite.position.set(point.x,point.y,point.z);
    return this.left>0;
  }
  destroy():void{this.sprite.removeFromParent();this.sprite.material.dispose();}
}

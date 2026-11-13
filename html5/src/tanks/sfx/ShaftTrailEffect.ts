// Narukami Trail1 / TrailEffect1: textured view-facing strip, width 48, fade 300ms.
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { GraphicEffect } from './SmokyEffects.ts';
export class ShaftTrailEffect implements GraphicEffect {
  private mesh:THREE.Mesh<THREE.BufferGeometry,THREE.MeshBasicMaterial>;
  private left=300;
  private direction:Vector3;
  constructor(parent:THREE.Object3D,private from:Vector3,to:Vector3,texture:THREE.Texture){
    this.direction=new Vector3().diff(to,from);
    const length=this.direction.length();this.direction.normalize();
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([-24,0,0,24,0,0,24,length,0,-24,length,0],3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,1,1,0,1],2));geometry.setIndex([0,1,2,0,2,3]);
    this.mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,side:THREE.DoubleSide,fog:false}));
    this.mesh.matrixAutoUpdate=false;this.mesh.renderOrder=10;this.mesh.frustumCulled=false;parent.add(this.mesh);
  }
  play(delta:number,camera:Vector3):boolean{
    this.left-=delta;this.mesh.material.opacity=Math.max(0,this.left/300);
    const d=this.direction,p=this.from,n=new Vector3().diff(camera,p);n.addScaled(-n.dot(d),d);
    if(n.lengthSqr()<1e-8)n.reset(d.y,-d.x,0);
    if(n.lengthSqr()<1e-8)n.reset(1,0,0);
    n.normalize();const side=new Vector3().cross2(d,n).normalize();
    this.mesh.matrix.set(side.x,d.x,n.x,p.x,side.y,d.y,n.y,p.y,side.z,d.z,n.z,p.z,0,0,0,1);this.mesh.matrixWorldNeedsUpdate=true;
    return this.left>0;
  }
  destroy():void{this.mesh.removeFromParent();this.mesh.geometry.dispose();this.mesh.material.dispose();}
}

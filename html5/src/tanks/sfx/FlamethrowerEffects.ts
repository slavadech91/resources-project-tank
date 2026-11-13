import { AnimatedLightEffect, type LightFrame } from '../../render/DynamicLights.ts';
// Narukami FlamethrowerEffectsParams / StreamWeaponGraphicEffect / StreamWeaponMuzzlePlane.
// Gen 2 uses five vertical muzzle frames in shot.png and ten square fireball frames.
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { RayHit } from '../../physics/collision/types.ts';
import type { Tank } from '../tank/Tank.ts';
import { makeSoftParticle } from '../../render/BattleRenderer.ts';
import { Sound3D, type Sound, type SoundManager } from './Sound.ts';
import { loadAnimation, loadEffectTexture, type EffectsScene, type TextureAnimation } from './SmokyEffects.ts';

export interface StreamVisualParams { width:number; length:number; startSize:number; endSize:number; muzzleFrames:number; muzzleFps:number; longitudinalU?:boolean; particleSpeed?:number; maxParticles?:number }
export const FIREBIRD_VISUAL:StreamVisualParams={width:100,length:300,startSize:50,endSize:400,muzzleFrames:5,muzzleFps:30};
export const FREEZE_VISUAL:StreamVisualParams={width:210,length:175,startSize:75,endSize:450,muzzleFrames:1,muzzleFps:30,longitudinalU:true};

interface FlameParticle { sprite: THREE.Sprite; offset: THREE.Vector2; repeat: THREE.Vector2; velocity: Vector3; distance: number; frame: number; spin: number }

interface FlameColor {t:number;redMultiplier:number;greenMultiplier:number;blueMultiplier:number;alphaMultiplier:number;redOffset:number;greenOffset:number;blueOffset:number;alphaOffset:number}
export class FlamethrowerEffectFactory {
  static async load(base: string, mod: number, sounds: SoundManager): Promise<FlamethrowerEffectFactory> {
    const [fire,muzzle,sound,lighting,colors]=await Promise.all([
      loadAnimation(`${base}/multiframe/turrets/firebird/m${mod}/fire`,true,true),
      loadEffectTexture(`${base}/images/turrets/firebird/muzzle`,true),
      sounds.engine.load(`${base}/sounds/turrets/firebird/flame.mp3`),
      fetch(`${base}/multiframe/turrets/firebird/m${mod}/fire/lighting.json`).then(r=>{if(!r.ok)throw new Error("Firebird lighting unavailable");return r.json() as Promise<Record<string,LightFrame[]>>;}),
      fetch(`${base}/multiframe/turrets/firebird/m${mod}/fire/color-transform.json`).then(r=>r.json() as Promise<FlameColor[]>),
    ]);
    muzzle.generateMipmaps=false; muzzle.minFilter=THREE.LinearFilter;
    return new FlamethrowerEffectFactory(fire,muzzle,sound,sounds,lighting,colors);
  }
  private constructor(private fire:TextureAnimation,private muzzle:THREE.Texture,private sound:Sound,private sounds:SoundManager,private lighting:Record<string,LightFrame[]>,private colors:FlameColor[]){}
  create(scene:EffectsScene):FlamethrowerEffect{return new FlamethrowerEffect(this.fire,this.muzzle,this.sound,this.sounds,scene,this.lighting,FIREBIRD_VISUAL,undefined,this.colors);}
}

export class FlamethrowerEffect {
  private tank:Tank|null=null;
  private readonly from=new Vector3();
  private readonly direction=new Vector3(0,1,0);
  private range=2000;
  private cone=0.7;
  private active=false;
  private dead=false;
  private disposed=false;
  private timer=0;
  private lightTime=0;
  private lightLoop=false;
  private lights:AnimatedLightEffect[]=[];
  private readonly fireLightPosition=new Vector3();
  private time=0;
  private readonly particles:FlameParticle[]=[];
  private readonly plane:THREE.Mesh<THREE.BufferGeometry,THREE.MeshBasicMaterial>;
  private readonly hit=new RayHit();
  private readonly sound:Sound3D;

  constructor(private fire:TextureAnimation,muzzle:THREE.Texture,sound:Sound,sounds:SoundManager,private scene:EffectsScene,private lighting:Record<string,LightFrame[]>,private visual:StreamVisualParams=FIREBIRD_VISUAL,private muzzleAnimation?:TextureAnimation,private colors:FlameColor[]=[]){
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([-visual.width/2,0,0,visual.width/2,0,0,visual.width/2,visual.length,0,-visual.width/2,visual.length,0],3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,0.2,0,0.2,1,0,1],2));
    geometry.setIndex([0,1,2,0,2,3]);
    this.plane=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:muzzle,transparent:true,depthWrite:false,side:THREE.DoubleSide,fog:false}));
    if(muzzleAnimation){
      const bounds={value:new THREE.Vector4(0,0,1,1)};this.plane.material.userData.frameBounds=bounds;
      this.plane.material.onBeforeCompile=shader=>{
        shader.uniforms.freezeFrameBounds=bounds;
        shader.fragmentShader='uniform vec4 freezeFrameBounds;\n'+shader.fragmentShader;
        shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
          vec2 frameUv=(vMapUv-freezeFrameBounds.xy)/freezeFrameBounds.zw;
          vec2 edge=min(frameUv,vec2(1.0)-frameUv);
          diffuseColor.a*=smoothstep(0.0,0.035,edge.x)*smoothstep(0.0,0.035,edge.y);`);
      };
    }
    this.plane.matrixAutoUpdate=false;this.plane.frustumCulled=false;this.plane.renderOrder=10;this.plane.visible=false;
    scene.parent.add(this.plane);scene.addGraphicEffect(this);
    this.sound=new Sound3D(sound,1000,5000,5,1);
    const owner=this;
    sounds.addEffect({enabled:true,get numSounds(){return owner.active?1:0;},
      play:(_dt,listener)=>this.sound.checkVolume(listener.position,this.from,listener.xAxis),destroy:()=>this.sound.stop()});
  }
  configure(range:number,cone:number):void{this.range=Math.max(1,range*100);this.cone=this.visual===FIREBIRD_VISUAL?Math.min(cone,0.12):cone;}
  aim(from:Vector3,direction:Vector3,tank?:Tank):void{this.from.copy(from);this.direction.copy(direction);if(tank)this.tank=tank;}
  setTarget():void{}
  start():void{this.active=true;this.sound.play(0,99999);}
  stop():void{this.active=false;this.dead=true;this.plane.visible=false;this.sound.stop();this.lights.forEach(l=>l.destroy());this.lights=[];}
  play(delta:number,camera:Vector3):boolean{
    if(this.disposed)return false;
    const dt=Math.min(100,Math.max(0,delta))/1000;this.time+=delta;
    const detector=this.scene.getCollisionDetector();
    const barrelLength=this.tank?.skin.turret.muzzles[0].y??0;
    const origin=this.from.clone().addScaled(-barrelLength,this.direction);
    const blocked=detector.raycastStatic(origin,this.direction,255,barrelLength+this.visual.length,null,this.hit);
    this.plane.visible=this.active&&!blocked;
    if(this.plane.visible){
      const normal=new Vector3().diff(camera,this.from);normal.addScaled(-normal.dot(this.direction),this.direction).normalize();
      const side=new Vector3().cross2(this.direction,normal).normalize();
      const d=this.direction,p=this.from;
      this.plane.matrix.set(side.x,d.x,normal.x,p.x,side.y,d.y,normal.y,p.y,side.z,d.z,normal.z,p.z,0,0,0,1);this.plane.matrixWorldNeedsUpdate=true;
      const frame=Math.floor(this.time*this.visual.muzzleFps/1000)%(this.muzzleAnimation?.frames.length??this.visual.muzzleFrames);
      const rect=this.muzzleAnimation?.frames[frame];
      const lo=rect?rect.u0+0.5/(this.plane.material.map!.image.width):(frame+0.01)/this.visual.muzzleFrames;
      const hi=rect?rect.u1-0.5/(this.plane.material.map!.image.width):(frame+0.99)/this.visual.muzzleFrames;
      const inset=rect?0.5/this.plane.material.map!.image.height:0;
      const bottom=rect?1-rect.v1+inset:0,top=rect?1-rect.v0-inset:1;
      if(this.plane.material.userData.frameBounds)this.plane.material.userData.frameBounds.value.set(lo,bottom,hi-lo,top-bottom);
      const uv=this.plane.geometry.attributes.uv as THREE.BufferAttribute;
      if(this.visual.longitudinalU){uv.setXY(0,lo,top);uv.setXY(1,lo,bottom);uv.setXY(2,hi,bottom);uv.setXY(3,hi,top);}
      else {uv.setXY(0,lo,bottom);uv.setXY(1,hi,bottom);uv.setXY(2,hi,top);uv.setXY(3,lo,top);}
      uv.needsUpdate=true;
    }
    this.fireLightPosition.copy(this.from).addScaled(blocked?Math.max(0,this.hit.t-barrelLength):Math.min(1500,this.range),this.direction);
    this.lightTime+=delta;
    const frames=this.lighting[this.lightLoop?'loop':'start'];
    if(this.active && frames?.length){
      if(this.lights.length===0){
        this.lights=[new AnimatedLightEffect(frames,()=>this.from.clone().add(new Vector3(0,0,100))),
          new AnimatedLightEffect(this.lighting[this.lightLoop?'loopFire':'startFire']??frames,()=>this.fireLightPosition)];
      }
      this.lights.forEach(l=>l.play(delta));
      if(this.lightTime>=frames[frames.length-1].time){this.lights.forEach(l=>l.destroy());this.lights=[];this.lightTime=0;this.lightLoop=true;}
    }
    const max=this.visual.maxParticles??Math.min(50,Math.floor(1.1*this.range/100));
    const speed=this.visual.particleSpeed??this.range; // 100cm/s per metre of configured range: one-second flight.
    this.timer=Math.max(0,this.timer-delta);
    if(this.active&&this.timer<=0&&this.particles.length<max){
      this.timer=1000*this.range/(Math.max(1,max)*speed);
      const offset=90+Math.random()*40;
      if(!blocked||this.hit.t>=barrelLength+offset)this.emit(offset,speed);
    }
    for(let i=this.particles.length-1;i>=0;i--){
      const p=this.particles[i],position=new Vector3(p.sprite.position.x,p.sprite.position.y,p.sprite.position.z);
      if(p.distance>this.range||detector.raycastStatic(position,p.velocity,255,dt,null,this.hit)){
        p.sprite.removeFromParent();p.sprite.material.dispose();this.particles.splice(i,1);continue;
      }
      p.sprite.position.x+=p.velocity.x*dt;p.sprite.position.y+=p.velocity.y*dt;p.sprite.position.z+=p.velocity.z*dt;
      p.distance+=speed*dt;p.sprite.material.rotation+=3*dt*p.spin;
      const frame=this.fire.frameTexture(Math.floor(p.frame)%this.fire.frames.length);
      p.frame+=this.fire.fps*dt;
      p.sprite.material.map=frame;
      p.offset.copy(frame.offset);
      p.repeat.copy(frame.repeat);
      if(this.colors.length){
        const t=Math.min(1,p.distance/this.range);let index=1;while(index<this.colors.length-1&&this.colors[index].t<t)index++;
        const a=this.colors[index-1],b=this.colors[index],f=Math.max(0,Math.min(1,(t-a.t)/Math.max(.00001,b.t-a.t)));
        const mix=(key:keyof FlameColor)=>a[key]+(b[key]-a[key])*f;
        const color=p.sprite.material.userData.flameColor;
        color.mult.value.set(mix('redMultiplier'),mix('greenMultiplier'),mix('blueMultiplier'),mix('alphaMultiplier'));
        color.offset.value.set(mix('redOffset')/255,mix('greenOffset')/255,mix('blueOffset')/255,mix('alphaOffset')/255);
      }
      const size=Math.min(this.visual.endSize,this.visual.startSize+2*(this.visual.endSize-this.visual.startSize)*p.distance/this.range);
      p.sprite.scale.set(size,size,1);p.sprite.material.opacity=Math.max(0,Math.min(1,(this.range-p.distance)/(this.range*0.2)));
    }
    return !this.dead||this.particles.length>0;
  }
  private emit(offset:number,speed:number):void{
    const angle=Math.random()*Math.PI*2,r=Math.random()*Math.tan(this.cone/2);
    const m=this.tank?.getTurretMatrix();
    const side=m?new Vector3(m.a,m.e,m.i):new Vector3(1,0,0);
    const up=new Vector3().cross2(side,this.direction);
    const direction=this.direction.clone().addScaled(r*Math.cos(angle),side).addScaled(r*Math.sin(angle),up).normalize();
    const texture=this.fire.frameTexture(0);
    const frameOffset=texture.offset.clone(),frameRepeat=texture.repeat.clone();
    const material=new THREE.SpriteMaterial({map:texture,transparent:true,depthWrite:false,fog:false,rotation:Math.random()*Math.PI*2});
    makeSoftParticle(material,130);
    if(this.visual.longitudinalU){
      const previous=material.onBeforeCompile;
      material.onBeforeCompile=(shader,renderer)=>{
        previous(shader,renderer);
        shader.uniforms.freezeParticleOffset={value:frameOffset};shader.uniforms.freezeParticleRepeat={value:frameRepeat};
        shader.fragmentShader='uniform vec2 freezeParticleOffset;uniform vec2 freezeParticleRepeat;\n'+shader.fragmentShader;
        shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
          vec2 particleUv=(vMapUv-freezeParticleOffset)/freezeParticleRepeat;
          vec2 particleEdge=min(particleUv,vec2(1.0)-particleUv);
          diffuseColor.a*=smoothstep(0.0,0.13,particleEdge.x)*smoothstep(0.0,0.13,particleEdge.y);`);
      };
    }
    if(this.colors.length){
      const color={mult:{value:new THREE.Vector4(1,1,1,1)},offset:{value:new THREE.Vector4()}};material.userData.flameColor=color;
      const previous=material.onBeforeCompile;
      material.onBeforeCompile=(shader,renderer)=>{previous(shader,renderer);shader.uniforms.flameMult=color.mult;shader.uniforms.flameOffset=color.offset;
        shader.fragmentShader='uniform vec4 flameMult;uniform vec4 flameOffset;\n'+shader.fragmentShader;
        shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\ndiffuseColor=clamp(diffuseColor*flameMult+flameOffset,0.0,1.0);');};
    }
    const sprite=new THREE.Sprite(material);sprite.renderOrder=10;sprite.scale.set(this.visual.startSize,this.visual.startSize,1);
    sprite.position.set(this.from.x+offset*direction.x,this.from.y+offset*direction.y,this.from.z+offset*direction.z);
    const velocity=direction.scale(speed);if(this.tank)velocity.add(this.tank.getBody().state.velocity);
    this.scene.parent.add(sprite);
    this.particles.push({sprite,offset:frameOffset,repeat:frameRepeat,velocity,distance:offset,frame:Math.random()*this.fire.frames.length,spin:Math.random()<0.5?1:-1});
  }
  destroy():void{
    if(this.disposed)return;this.disposed=true;this.active=false;this.sound.stop();this.lights.forEach(l=>l.destroy());this.lights=[];
    for(const p of this.particles){p.sprite.removeFromParent();p.sprite.material.dispose();}this.particles.length=0;
    this.plane.removeFromParent();this.plane.geometry.dispose();this.plane.material.dispose();
  }
}

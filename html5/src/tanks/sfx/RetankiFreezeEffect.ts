// Visual port of ReTankiOnline WeaponManager at 3ffafdc; sizes/speeds converted m -> cm.
import * as THREE from 'three';
import {Vector3} from '../../physics/math/Vector3.ts';
import {Sound3D,type Sound,type SoundManager} from './Sound.ts';
import {loadAnimation,type EffectsScene,type TextureAnimation} from './SmokyEffects.ts';
interface Particle{sprite:THREE.Sprite;life:number;active:boolean;velocity:Vector3;maxLife:number;start:number;end:number;opacity:number;rotation:number;frames:THREE.Texture[]}
export class RetankiFreezeFactory{
 private constructor(private breeze:THREE.Texture[],private flakes:THREE.Texture[],private sound:Sound,private sounds:SoundManager){}
 static async load(base:string,sounds:SoundManager,mod=0):Promise<RetankiFreezeFactory>{
  const [a,b,sound]=await Promise.all([loadAnimation(`${base}/multiframe/turrets/freeze/m${mod}/plane`,true,true),loadAnimation(`${base}/multiframe/turrets/freeze/m${mod}/particle`,true,true),sounds.engine.load(`${base}/sounds/turrets/freeze/freeze.mp3`)]);
  const frames=(animation:TextureAnimation)=>animation.frames.map((_,index)=>animation.frameTexture(index));
  return new RetankiFreezeFactory(frames(a),frames(b),sound,sounds);
 }
 create(scene:EffectsScene):RetankiFreezeEffect{return new RetankiFreezeEffect(scene,this.breeze,this.flakes,this.sound,this.sounds);}
}
export class RetankiFreezeEffect{
 private readonly from=new Vector3();private readonly direction=new Vector3(0,1,0);
 private pools:Particle[][]=[];private active=false;private dead=false;private disposed=false;private elapsed=0;private readonly sound:Sound3D;
 constructor(scene:EffectsScene,breeze:THREE.Texture[],flakes:THREE.Texture[],sound:Sound,sounds:SoundManager){
  const pool=(count:number,frames:THREE.Texture[],color:number,life:number,start:number,end:number,opacity:number,rotation:number)=>Array.from({length:count},()=>{
   const material=new THREE.SpriteMaterial({map:frames[0],color,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity});
   const sprite=new THREE.Sprite(material);sprite.visible=false;sprite.renderOrder=10;scene.parent.add(sprite);
   return {sprite,life:0,active:false,velocity:new Vector3(),maxLife:life,start,end,opacity,rotation:(Math.random()-.5)*rotation,frames};
  });
  this.pools=[pool(48,breeze,0x88ccff,.65,32,340,.34,1.6),pool(36,flakes,0xddf4ff,.52,22,180,.65,6.5)];
  this.sound=new Sound3D(sound,1000,5000,5,.85);scene.addGraphicEffect(this);
  const owner=this;
  sounds.addEffect({enabled:true,get numSounds(){return owner.active?1:0;},play:(_dt,listener)=>this.sound.checkVolume(listener.position,this.from,listener.xAxis),destroy:()=>this.sound.stop()});
 }
 configure(_range:number,_cone:number):void{}
 aim(from:Vector3,direction:Vector3):void{this.from.copy(from);this.direction.copy(direction);}
 setTarget():void{} setBuffedMode():void{}
 start():void{this.active=true;this.sound.play(0,99999);}
 stop():void{this.active=false;this.dead=true;this.sound.stop();}
 private emit(pool:Particle[],speed:number,spread:number):void{
  const p=pool.find(p=>!p.active);if(!p)return;p.active=true;p.life=0;p.sprite.visible=true;p.sprite.material.rotation=Math.random()*Math.PI*2;
  p.sprite.position.set(this.from.x+this.direction.x*25,this.from.y+this.direction.y*25,this.from.z+this.direction.z*25);p.sprite.scale.set(p.start,p.start,1);
  p.velocity.copy(this.direction).add(new Vector3((Math.random()-.5)*spread,(Math.random()-.5)*spread,(Math.random()-.5)*spread)).normalize().scale(speed);
 }
 play(delta:number,_camera:Vector3):boolean{
  if(this.disposed)return false;const dt=Math.min(100,Math.max(0,delta))/1000;this.elapsed+=delta;
  if(this.active&&this.elapsed>24){this.elapsed=0;this.emit(this.pools[0],2450,.16);if(Math.random()<.75)this.emit(this.pools[1],2550,.12);}
  let alive=false;
  for(const pool of this.pools)for(const p of pool){if(!p.active)continue;p.life+=dt;const t=p.life/p.maxLife;
   if(t>=1){p.active=false;p.sprite.visible=false;continue;}alive=true;
   p.sprite.position.x+=p.velocity.x*dt;p.sprite.position.y+=p.velocity.y*dt;p.sprite.position.z+=p.velocity.z*dt;
   p.sprite.material.map=p.frames[Math.min(p.frames.length-1,Math.floor(t*p.frames.length))];
   const size=p.start+(p.end-p.start)*Math.pow(t,.7);p.sprite.scale.set(size,size,1);p.sprite.material.rotation+=p.rotation*dt;
   p.sprite.material.opacity=p.opacity*(t<.12?t/.12:t>.4?1-(t-.4)/.6:1);
  }
  return !this.dead||alive;
 }
 destroy():void{if(this.disposed)return;this.disposed=true;this.sound.stop();for(const pool of this.pools)for(const p of pool){p.sprite.removeFromParent();p.sprite.material.dispose();}this.pools=[];}
}

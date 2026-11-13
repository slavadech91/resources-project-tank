import * as THREE from 'three';
import type {CtfFlag,CtfAction,Vec3} from './protocol.ts';
import type {Sound,SoundManager,SoundChannel} from '../tanks/sfx/Sound.ts';
/** CTFFlag: bottom anchor, height 400cm, half alpha on local carrier. */
export class S2Flags {
  private root=new THREE.Group();private flags:CtfFlag[]=[];private sprites=new Map<number,THREE.Sprite>();
  private disposed=false;private sounds=new Map<CtfAction,Sound>();private channels=new Set<SoundChannel>();
  constructor(world:THREE.Object3D,private localId:number,sounds:SoundManager){
    world.add(this.root);
    for(const [action,name] of Object.entries({taken:'Taken',dropped:'Dropped',returned:'Returned',captured:'Captured'}))void sounds.engine.load(`battle/ctf/Flag${name}.mp3`).then(sound=>{if(!this.disposed)this.sounds.set(action as CtfAction,sound);});
    for(const [team,name] of ['red','blue'].entries()){
      void new THREE.TextureLoader().loadAsync(`battle/ctf/flag_${name}.png`).then(map=>{
        if(this.disposed){map.dispose();return;}map.colorSpace=THREE.NoColorSpace;const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map,transparent:true,depthWrite:false}));sprite.center.set(.5,0);sprite.scale.set(200,400,1);this.sprites.set(team,sprite);this.root.add(sprite);
      }).catch(console.error);
      void Promise.all([fetch(`battle/ctf/pedestal_${name}.json`).then(r=>r.json()),new THREE.TextureLoader().loadAsync(`battle/ctf/pedestal_${name}.jpg`)]).then(([data,map])=>{
        if(this.disposed){map.dispose();return;}map.colorSpace=THREE.NoColorSpace;const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uvs,2));g.setIndex(data.indices);g.computeVertexNormals();const mesh=new THREE.Mesh(g,new THREE.MeshLambertMaterial({map}));mesh.userData.team=team;mesh.userData.pedestal=true;this.root.add(mesh);
      }).catch(console.error);
    }
  }
  set(flags:CtfFlag[],action?:CtfAction):void {this.flags=flags;if(action){const channel=this.sounds.get(action)?.play();if(channel){this.channels.add(channel);channel.onComplete=()=>this.channels.delete(channel);}}}
  update(position:(id:number)=>Vec3|null):void {
    for(const f of this.flags){
      const sprite=this.sprites.get(f.team);if(sprite){const carrier=f.carrierId==null?null:position(f.carrierId),p=carrier??f.position;sprite.visible=f.state!=='carried'||!!carrier;sprite.position.set(p.x,p.y,p.z);sprite.material.opacity=f.carrierId===this.localId ? 0.5 : 1;}
      for(const mesh of this.root.children)if(mesh.userData.pedestal&&mesh.userData.team===f.team)mesh.position.set(f.base.x,f.base.y,f.base.z-80);
    }
  }
  stop():void {this.disposed=true;for(const c of this.channels)c.stop();this.channels.clear();this.root.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.Sprite){if(o instanceof THREE.Mesh)o.geometry.dispose();o.material.map?.dispose();o.material.dispose();}});this.root.removeFromParent();}
}

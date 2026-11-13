// Per-weapon ownership: local and remote shafts may share media, never audio lifetime.
import { Vector3 } from '../../physics/math/Vector3.ts';
import { Sound3D, SoundOptions, type Sound, type SoundManager } from './Sound.ts';
export class ShaftAimSounds {
  private readonly charging:Sound3D;
  private readonly targeting:Sound3D;
  private stopped=false;
  constructor(manager:SoundManager,scope:Sound,target:Sound,position:()=>Vector3,volume:()=>number=()=>1,active:()=>boolean=()=>true){
    this.charging=new Sound3D(scope,SoundOptions.nearRadius,SoundOptions.farRadius,SoundOptions.farDelimiter,0.35);
    this.targeting=new Sound3D(target,SoundOptions.nearRadius,SoundOptions.farRadius,SoundOptions.farDelimiter,1);
    this.charging.play(0,9999);
    const owner=this;
    manager.addEffect({enabled:true,get numSounds(){return owner.stopped?0:1;},
      play:(_delta,listener)=>{
        if(this.stopped)return;
        if(!active()){this.stop();return;}
        const from=position();
        this.charging.checkVolume(listener.position,from,listener.xAxis);
        this.targeting.volume=volume();
        this.targeting.checkVolume(listener.position,from,listener.xAxis);
      },destroy:()=>this.stop()});
  }
  setMoving(active:boolean):void{
    if(this.stopped)return;
    if(active){if(!this.targeting.isPlaying())this.targeting.play(0,9999);}
    else this.targeting.stop();
  }
  stopCharging():void{this.charging.stop();}
  stop():void{this.stopped=true;this.charging.stop();this.targeting.stop();}
}

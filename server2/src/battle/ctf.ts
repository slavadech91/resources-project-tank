// Server authority for ProtankiClientRemake CTFModel/CTFFlag rules.
import {TEAM,type Vec3,type CtfFlag,type CtfAction} from '../../../html5/src/net2/protocol.ts';
export interface FlagPlayer {userId:number;team:number;state:string;health?:number;position:Vec3|null;orientation:Vec3|null;loadout?:{size:Vec3}}
export class CtfState {
  readonly flags:CtfFlag[];
  private blocked=new Map<number,number>();
  constructor(bases:[Vec3,Vec3],private visible:(a:Vec3,b:Vec3)=>boolean,private ground:(p:Vec3)=>Vec3|null,private emit:(action:CtfAction,flag:CtfFlag,player:FlagPlayer|null)=>void,private capture:(p:FlagPlayer)=>void,private returnMs=30000){
    this.flags=bases.map((base,team)=>({team:team as 0|1,base:{...base},position:{...base},state:'base',carrierId:null,returnAt:0}));
  }
  reset():void {this.blocked.clear();for(const f of this.flags)this.toBase(f);}
  snapshot():CtfFlag[]{return this.flags.map(f=>({...f,base:{...f.base},position:{...f.position}}));}
  private toBase(f:CtfFlag):void {f.state='base';f.carrierId=null;f.position={...f.base};f.returnAt=0;}
  drop(p:FlagPlayer,now=Date.now()):void {
    const f=this.flags.find(f=>f.carrierId===p.userId);if(!f||!p.position)return;
    const pos=this.ground(p.position);this.blocked.set(p.userId,now+5000);
    if(!pos){this.toBase(f);this.emit('returned',f,null);return;}
    f.state='dropped';f.carrierId=null;f.position=pos;f.returnAt=now+this.returnMs;this.emit('dropped',f,p);
  }
  step(players:FlagPlayer[],now=Date.now()):void {
    for(const [id,until] of this.blocked)if(until<=now)this.blocked.delete(id);
    for(const f of this.flags){
      if(f.state==='carried'){
        const p=players.find(p=>p.userId===f.carrierId);
        if(!p||p.state!=='active'||p.health===0||!p.position){if(p?.position)this.drop(p,now);else {this.toBase(f);this.emit('returned',f,null);}continue;}
        f.position={...p.position};
      }else if(f.state==='dropped'&&now>=f.returnAt){this.toBase(f);this.emit('returned',f,null);}
    }
    for(const p of players){
      if(p.state!=='active'||p.health===0||!p.position||(p.team!==TEAM.RED&&p.team!==TEAM.BLUE))continue;
      const own=this.flags[p.team],enemy=this.flags[1-p.team],pos=p.position;
      const touching=(f:CtfFlag)=>{
        const yaw=p.orientation?.z??0,dx=f.position.x-pos.x,dy=f.position.y-pos.y;
        const x=dx*Math.cos(yaw)+dy*Math.sin(yaw),y=-dx*Math.sin(yaw)+dy*Math.cos(yaw);
        // Original flag trigger 95x95x400 intersecting the hull, not a distance-only sphere.
        const hx=(p.loadout?.size.x??155)/2,hy=(p.loadout?.size.y??255)/2,hz=(p.loadout?.size.z??100)/2,c=Math.abs(Math.cos(yaw)),s=Math.abs(Math.sin(yaw)),r=47.5;
        return Math.abs(x)<=hx+r*(c+s)&&Math.abs(y)<=hy+r*(c+s)&&Math.abs(dx)<=r+hx*c+hy*s&&Math.abs(dy)<=r+hx*s+hy*c&&pos.z+hz>=f.position.z&&pos.z-hz<=f.position.z+400&&this.visible(pos,{...f.position,z:f.position.z+100});
      };
      if(own.state==='dropped'&&touching(own)){this.toBase(own);this.emit('returned',own,p);}
      if(enemy.carrierId===p.userId&&own.state==='base'&&touching(own)){
        this.toBase(enemy);this.emit('captured',enemy,p);this.capture(p);return;
      }
      if(enemy.state!=='carried'&&!this.blocked.has(p.userId)&&touching(enemy)){
        enemy.state='carried';enemy.carrierId=p.userId;enemy.position={...pos};enemy.returnAt=0;this.emit('taken',enemy,p);
      }
    }
  }
}

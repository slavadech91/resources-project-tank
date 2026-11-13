import {loadGraphicsSettings} from '../settings/GraphicsSettings.ts';
import type {Vec3} from '../../net2/protocol.ts';
export class DamageNumbers {
 private rows:{node:HTMLDivElement;origin:Vec3;z:number;vx:number;vy:number}[]=[];
 private enabled=loadGraphicsSettings().showDamage;
 private last=performance.now();
 private changed=()=>{this.enabled=loadGraphicsSettings().showDamage;if(!this.enabled)this.clear();};
 constructor(){window.addEventListener('tanki-graphics-change',this.changed);}
 add(origin:Vec3,amount:number,type:string):void{
  if(!this.enabled||amount<=0)return;
  const node=document.createElement('div');
  const color=type==='fatal'?15741974:type==='critical'?14207247:type==='heal'?381208:16777215;
  node.textContent=String(Math.round(amount));
  node.style.cssText=`position:fixed;z-index:39;pointer-events:none;width:60px;height:20px;font:16px Tahoma,Arial,sans-serif;color:#${color.toString(16).padStart(6,'0')};text-shadow:0 0 2px #000,0 0 2px #000;transform:translate(-50%,-50%);visibility:hidden`;
  document.body.appendChild(node);this.rows.push({node,origin:{...origin},z:0,vx:Math.random()-.5,vy:Math.random()-.5});
  if(this.rows.length>128)this.rows.shift()!.node.remove();
 }
 update(project:(x:number,y:number,z:number)=>{x:number;y:number}|null):void{
  const now=performance.now(),dt=Math.min(100,now-this.last)/1000;this.last=now;
  for(let i=this.rows.length-1;i>=0;i--){const r=this.rows[i];r.z+=(r.z<100?1000:100)*dt;
   if(r.z>=300){r.node.remove();this.rows.splice(i,1);continue;}
   const p=project(r.origin.x+r.z*r.vx,r.origin.y+r.z*r.vy,r.origin.z+r.z);
   r.node.style.visibility=p?'visible':'hidden';if(p){r.node.style.left=p.x+'px';r.node.style.top=p.y+'px';}r.node.style.opacity=String(r.z<250?1:(300-r.z)/50);
  }
 }
 clear():void{for(const r of this.rows)r.node.remove();this.rows=[];this.last=performance.now();}
 dispose():void{this.clear();window.removeEventListener('tanki-graphics-change',this.changed);}
}

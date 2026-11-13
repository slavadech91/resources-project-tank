// ProtankiClientRemake BattlefieldMessages/Message: three rows, original alpha states.
import './hud.css';
export function noticeAlpha(age:number,duration?:number):number {
 if(duration!=null){if(age<700)return 1-.4*age/700;if(age<700+duration)return .6;return Math.max(0,.6*(1-(age-700-duration)/700));}
 if(age<500)return age/500;if(age<2500)return 1;if(age<3200)return 1-.4*(age-2500)/700;if(age<13200)return .6;return Math.max(0,.6*(1-(age-13200)/700));
}
export class BattleNotice {
 private readonly root=document.createElement('div');
 private messages:{node:HTMLElement;start:number;duration?:number}[]=[];
 private frame=0;
 constructor(parent:HTMLElement){this.root.className='battle-notice';parent.appendChild(this.root);}
 show(text:string,ms?:number,color='#ffff00'):void {
  if(this.messages.length===3)this.messages.shift()!.node.remove();
  const node=document.createElement('div');node.textContent=text;node.style.color=color;this.root.appendChild(node);
  this.messages.push({node,start:performance.now(),duration:ms&&ms>0?ms:undefined});if(!this.frame)this.tick();
 }
 private tick=():void=>{
  this.frame=0;const now=performance.now();
  this.messages=this.messages.filter(m=>{const age=now-m.start,life=m.duration==null?13900:m.duration+1400;if(age>=life){m.node.remove();return false;}m.node.style.opacity=String(noticeAlpha(age,m.duration));return true;});
  if(this.messages.length)this.frame=requestAnimationFrame(this.tick);
 };
 hide():void {cancelAnimationFrame(this.frame);this.frame=0;this.messages=[];this.root.replaceChildren();}
}

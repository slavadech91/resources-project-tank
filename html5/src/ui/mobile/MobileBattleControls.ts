import {stickAxes,stickKeys} from './TouchStick.ts';
import type {TankDemo} from '../../tanks/TankDemo.ts';
import './mobile-battle.css';

export function battleKey(code:string,down:boolean):void {
 document.body.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,key:code==='Tab'?'Tab':code==='Delete'?'Delete':code.startsWith('Digit')?code.slice(5):code==='KeyF'?'f':code,bubbles:true,cancelable:true}));
}
function battleTap(code:string):void {battleKey(code,true);battleKey(code,false);}
interface Callbacks {tank:()=>TankDemo|null;active:()=>boolean;leave:()=>void;garage:()=>void;settings:()=>void}
export class MobileBattleControls {
 private lobbyNav=document.createElement('div');private root=document.createElement('div');private fullscreen=document.createElement('button');private status=document.createElement('div');
 private current:TankDemo|null=null;private active=false;private keys=new Set<number>();private releases=new Set<()=>void>();
 private inventory:{button:HTMLButtonElement;count:HTMLElement;cooldown:HTMLElement}[]=[];private refreshAt=0;
 private readonly coarse=matchMedia('(pointer:coarse)');
 private readonly forceTouch=new URLSearchParams(location.search).get('touch')==='1';
 private mobile=()=>this.coarse.matches||this.forceTouch;
 constructor(parent:HTMLElement,private callbacks:Callbacks,archiveInventory=false){
  this.root.className='mobile-battle-controls';this.root.hidden=true;parent.appendChild(this.root);
  this.fullscreen.hidden=true;this.fullscreen.type='button';this.fullscreen.className='mobile-fullscreen';this.fullscreen.textContent='⛶';this.fullscreen.title='Полный экран';this.fullscreen.setAttribute('aria-label','Полный экран');parent.append(this.fullscreen);this.fullscreen.onclick=()=>void this.toggleFullscreen();
  this.status.className='mobile-status';parent.append(this.status);
  this.lobbyNav.hidden=true;this.lobbyNav.className='mobile-lobby-nav';parent.append(this.lobbyNav);this.button(this.lobbyNav,'Битвы',callbacks.leave);this.button(this.lobbyNav,'Гараж',callbacks.garage);this.button(this.lobbyNav,'⚙',callbacks.settings);
  const bar=this.element('div','mobile-battle-menu');
  this.button(bar,'Битвы',()=>{this.release();callbacks.leave();});this.button(bar,'⚙',()=>{this.release();callbacks.settings();});this.button(bar,'Чат',()=>{this.release();battleTap('Enter');});
  let statsOpen=false;const stats=this.button(bar,'Счёт',()=>{statsOpen=!statsOpen;battleKey('Tab',statsOpen);stats.classList.toggle('held',statsOpen);});this.releases.add(()=>{if(statsOpen){statsOpen=false;battleKey('Tab',false);stats.classList.remove('held');}});
  this.button(bar,'Флаг',()=>battleTap('KeyF'));this.button(bar,'Респаун',()=>battleTap('Delete'));
  const stick=this.element('div','mobile-stick'),knob=this.element('div','mobile-stick-knob',stick);stick.setAttribute('aria-label','Движение танка');
  let stickPointer:number|null=null,cx=0,cy=0;
  const stopStick=()=>{stickPointer=null;knob.style.transform='translate(-50%,-50%)';this.setKeys([]);this.current?.setTouchMovement(null);};this.releases.add(stopStick);
  const move=(e:PointerEvent)=>{if(e.pointerId!==stickPointer)return;const x=e.clientX-cx,y=e.clientY-cy,l=Math.hypot(x,y),k=Math.min(1,60/Math.max(l,1));knob.style.transform=`translate(calc(-50% + ${x*k}px),calc(-50% + ${y*k}px))`;this.current?.setTouchMovement(stickAxes(x,y));this.setKeys(stickKeys(x,y));};
  stick.onpointerdown=e=>{if(stickPointer!=null)return;e.preventDefault();const r=stick.getBoundingClientRect();cx=r.left+r.width/2;cy=r.top+r.height/2;stickPointer=e.pointerId;stick.setPointerCapture(e.pointerId);move(e);};
  stick.onpointermove=move;stick.onpointerup=e=>{if(e.pointerId===stickPointer)stopStick();};stick.onpointercancel=stick.onpointerup;stick.onlostpointercapture=stick.onpointerup;
  const aim=this.element('div','mobile-aim-area');aim.setAttribute('aria-label','Проведи пальцем для наведения башни');
  const hint=this.element('span','mobile-aim-hint',aim);hint.textContent='Наведение';let aimPointer:number|null=null,ax=0,ay=0;
  const stopAim=()=>{aimPointer=null;};this.releases.add(stopAim);
  aim.onpointerdown=e=>{if(aimPointer!=null)return;e.preventDefault();aimPointer=e.pointerId;ax=e.clientX;ay=e.clientY;aim.setPointerCapture(e.pointerId);};
  aim.onpointermove=e=>{if(e.pointerId!==aimPointer)return;e.preventDefault();this.current?.aimTouch(e.clientX-ax,e.clientY-ay);ax=e.clientX;ay=e.clientY;};
  aim.onpointerup=e=>{if(e.pointerId===aimPointer)stopAim();};aim.onpointercancel=aim.onpointerup;aim.onlostpointercapture=aim.onpointerup;
  const fire=this.button(this.root,'ОГОНЬ');fire.className='mobile-fire';this.hold(fire,()=>this.current?.setTouchKey(32,true),()=>this.current?.setTouchKey(32,false),(dx,dy)=>this.current?.aimTouch(dx,dy));
  const center=this.button(this.root,'Центр',()=>this.tap(67));center.className='mobile-center';
  const camera=this.element('div','mobile-camera');const up=this.button(camera,'Камера +'),down=this.button(camera,'Камера −');
  this.hold(up,()=>this.current?.setTouchKey(81,true),()=>this.current?.setTouchKey(81,false));this.hold(down,()=>this.current?.setTouchKey(69,true),()=>this.current?.setTouchKey(69,false));
  if (!archiveInventory) {
   const tray=this.element('div','mobile-inventory');
   ['✚','◈','×2','↑','●'].forEach((caption,i)=>{const button=this.button(tray,caption,()=>battleTap(`Digit${i+1}`));const cooldown=this.element('span','mobile-inventory-cooldown',button),count=this.element('span','mobile-inventory-count',button);button.setAttribute('aria-label',['Аптечка','Броня','Урон','Нитро','Мина'][i]);this.inventory.push({button,count,cooldown});});
  }
  this.root.addEventListener('contextmenu',e=>e.preventDefault());
  window.addEventListener('blur',()=>this.release());document.addEventListener('visibilitychange',()=>{if(document.hidden)this.release();});
  document.addEventListener('fullscreenchange',()=>window.dispatchEvent(new Event('resize')));
  document.addEventListener('webkitfullscreenchange',()=>window.dispatchEvent(new Event('resize')));
  document.addEventListener('focusin',e=>{if((e.target as HTMLElement)?.matches('input,textarea'))this.release();});
 }
 private element(tag:string,cls:string,parent:HTMLElement=this.root):HTMLElement {const e=document.createElement(tag);e.className=cls;parent.appendChild(e);return e;}
 private button(parent:HTMLElement,text:string,click?:()=>void):HTMLButtonElement {const b=document.createElement('button');b.type='button';b.textContent=text;if(click)b.onclick=click;parent.appendChild(b);return b;}
 private hold(button:HTMLElement,down:()=>void,up:()=>void,move?:(dx:number,dy:number)=>void):void {
  let pointer:number|null=null,x=0,y=0;const release=()=>{if(pointer==null)return;pointer=null;button.classList.remove('held');up();};this.releases.add(release);
  button.onpointerdown=e=>{if(pointer!=null)return;e.preventDefault();pointer=e.pointerId;x=e.clientX;y=e.clientY;button.setPointerCapture(e.pointerId);button.classList.add('held');down();};
  button.onpointermove=e=>{if(e.pointerId!==pointer||!move)return;move(e.clientX-x,e.clientY-y);x=e.clientX;y=e.clientY;};
  const end=(e:PointerEvent)=>{if(e.pointerId===pointer)release();};button.onpointerup=end;button.onpointercancel=end;button.onlostpointercapture=end;
 }
 private setKeys(next:number[]):void {const set=new Set(next);for(const key of this.keys)if(!set.has(key))this.current?.setTouchKey(key,false);for(const key of set)if(!this.keys.has(key))this.current?.setTouchKey(key,true);this.keys=set;}
 private tap(key:number):void {this.current?.setTouchKey(key,true);this.current?.setTouchKey(key,false);}
 release():void {for(const stop of this.releases)stop();this.setKeys([]);this.current?.setTouchKey(32,false);this.current?.setTouchKey(81,false);this.current?.setTouchKey(69,false);}
 update(now:number):void {
  const enabled=this.mobile(),active=enabled&&this.callbacks.active(),tank=active?this.callbacks.tank():null;
  if(tank!==this.current||active!==this.active){this.release();this.current=tank;this.active=active;this.root.hidden=!active;document.documentElement.classList.toggle('mobile-battle',active);}
  document.documentElement.classList.toggle('mobile-device',enabled);
  this.lobbyNav.hidden=!enabled||active||!document.querySelector<HTMLElement>('.auth-window')?.hidden;
  this.fullscreen.hidden=!enabled;this.fullscreen.classList.toggle('in-battle',active);
  if(this.inventory.length&&active&&now>=this.refreshAt){this.refreshAt=now+200;const slots=document.querySelectorAll<HTMLElement>('.hud-slot');this.inventory.forEach((item,i)=>{const slot=slots[i];item.count.textContent=slot?.querySelector('.hud-count')?.textContent??'';item.cooldown.style.height=slot?.querySelector<HTMLElement>('.hud-cooldown')?.style.height??'0';});}
 }
 private async toggleFullscreen():Promise<void>{
  this.release();const doc=document as Document&{webkitFullscreenElement?:Element;webkitExitFullscreen?:()=>Promise<void>};const root=document.documentElement as HTMLElement&{webkitRequestFullscreen?:()=>Promise<void>};
  try{
   if(doc.fullscreenElement||doc.webkitFullscreenElement){if(doc.exitFullscreen)await doc.exitFullscreen();else await doc.webkitExitFullscreen?.();return;}
   const request=root.requestFullscreen??root.webkitRequestFullscreen;
   if(!request){this.status.textContent='Для полного экрана открой игру через «На экран Домой» в меню браузера';setTimeout(()=>this.status.textContent='',6000);return;}
   await request.call(root);try{await (screen.orientation as ScreenOrientation&{lock?:(mode:string)=>Promise<void>}).lock?.('landscape');}catch{/* Rotation can remain under the browser/user's control. */}
  }catch{this.status.textContent='Полный экран недоступен в этом браузере';setTimeout(()=>this.status.textContent='',4000);}
 }
}

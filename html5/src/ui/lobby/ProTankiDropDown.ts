/** ProTanki DropDownList/ComboR: DOM popup instead of the operating system's select menu. */
import {INNER,WindowInner,el} from './widgets.ts';
let nextId=0;
export class ProTankiDropDown {
 private readonly button:HTMLButtonElement;
 private readonly popup:HTMLDivElement;
 private readonly list:HTMLDivElement;
 private readonly frame:WindowInner;
 private rows:HTMLButtonElement[]=[];
 private openState=false;
 constructor(readonly select:HTMLSelectElement){
  select.hidden=true;select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  this.button=el('button','bc-select',select.parentElement!);this.button.type='button';this.button.setAttribute('aria-haspopup','listbox');this.button.setAttribute('aria-label',select.getAttribute('aria-label')??'Выбор');
  this.popup=el('div','bc-dropdown-popup',document.body);this.popup.hidden=true;this.popup.id=`bc-dropdown-${++nextId}`;this.button.setAttribute('aria-controls',this.popup.id);
  this.frame=new WindowInner(this.popup,INNER.TRANSPARENT);this.frame.root.style.backgroundImage="url('/battle/battle_create/DPLBackground_bitmapBG.jpg')";
  this.list=el('div','bc-dropdown-list',this.popup);this.list.setAttribute('role','listbox');this.list.setAttribute('aria-label',select.getAttribute('aria-label')??'Выбор');
  this.button.onclick=()=>this.openState?this.close():this.open();
  this.button.onkeydown=event=>this.key(event);this.list.onkeydown=event=>this.key(event);
  document.addEventListener('pointerdown',event=>{if(this.openState&&!this.popup.contains(event.target as Node)&&!this.button.contains(event.target as Node))this.close();},true);
  window.addEventListener('resize',()=>this.close());window.addEventListener('blur',()=>this.close());
  window.addEventListener('scroll',event=>{if(this.openState&&(!(event.target instanceof Node)||!this.popup.contains(event.target)))this.close();},true);
  this.sync();
 }
 sync():void{this.button.textContent=this.select.selectedOptions[0]?.textContent??'';this.button.disabled=this.select.disabled;this.button.title=this.select.title;this.button.setAttribute('aria-expanded',String(this.openState));if(this.select.disabled)this.close();}
 close():void{this.openState=false;this.popup.hidden=true;this.button.setAttribute('aria-expanded','false');this.select.parentElement!.classList.remove('bc-select-open');}
 private open():void{
  if(this.select.disabled)return;
  this.list.replaceChildren();this.rows=[];
  for(const [index,option]of Array.from(this.select.options).entries()){
   const row=el('button','bc-dropdown-row',this.list);row.type='button';row.textContent=option.text;row.disabled=option.disabled;row.setAttribute('role','option');row.setAttribute('aria-selected',String(index===this.select.selectedIndex));
   row.onclick=()=>{this.select.selectedIndex=index;this.select.dispatchEvent(new Event('change',{bubbles:true}));this.sync();this.close();this.button.focus({preventScroll:true});};this.rows.push(row);
  }
  const rect=this.button.getBoundingClientRect(),width=rect.width,preferred=Math.min(274,this.rows.length*20+8),below=window.innerHeight-rect.bottom-6,above=rect.top-6;
  const down=below>=Math.min(preferred,100)||below>=above,height=Math.min(preferred,Math.max(28,down?below:above));
  this.popup.style.left=Math.max(0,Math.min(window.innerWidth-width,rect.left))+'px';this.popup.style.top=(down?rect.bottom:rect.top-height)+'px';this.popup.style.width=width+'px';this.popup.style.height=height+'px';this.frame.setBounds(0,0,width,height);
  this.openState=true;this.popup.hidden=false;this.button.setAttribute('aria-expanded','true');this.select.parentElement!.classList.add('bc-select-open');
  const selected=this.rows[this.select.selectedIndex];if(selected&&!selected.disabled){selected.focus({preventScroll:true});this.list.scrollTop=Math.max(0,selected.offsetTop-this.list.clientHeight/2);}else this.rows.find(row=>!row.disabled)?.focus({preventScroll:true});
 }
 private key(event:KeyboardEvent):void{
  event.stopPropagation();
  if(event.key==='Escape'){event.preventDefault();this.close();this.button.focus({preventScroll:true});return;}
  if(event.key==='Tab'){this.close();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();
  if(!this.openState){this.open();return;}
  const enabled=this.rows.filter(row=>!row.disabled),index=enabled.indexOf(document.activeElement as HTMLButtonElement);
  const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:Math.max(0,Math.min(enabled.length-1,index+(event.key==='ArrowDown'?1:-1)));enabled[next]?.focus({preventScroll:true});enabled[next]?.scrollIntoView({block:'nearest'});
 }
}

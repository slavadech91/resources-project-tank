import type {AppearanceStyle} from '../../net2/appearance.ts';
import {DefaultButton,HEADER,TankWindow,el,label,place} from './widgets.ts';
/** Temporary home for the appearance choice, opened by the existing Upgrade button. */
export class AppearanceDialog{
 private readonly root=el('div','garage-appearance-overlay',document.body);
 private readonly window=new TankWindow(this.root,HEADER.INFORMATION);
 private readonly title=label(this.window.root,'');
 private readonly description=label(this.window.root,'Текстуры и эффекты для всех модификаций M0–M3');
 private readonly hint=label(this.window.root,'В бою применяется при следующем входе.');
 private readonly choices:{style:AppearanceStyle;image:HTMLImageElement;button:DefaultButton}[]=[];
 private readonly closeButton:DefaultButton;
 private choose:((style:AppearanceStyle)=>void)|null=null;
 constructor(){
  this.root.hidden=true;this.root.onclick=event=>{if(event.target===this.root)this.close();};
  for(const style of ['gen2','old']as const){const image=el('img','lb-abs',this.window.root);image.draggable=false;const button=new DefaultButton(this.window.root,style==='old'?'Old':'Gen 2');button.onClick=()=>{this.choose?.(style);this.close();};this.choices.push({style,image,button});}
  this.closeButton=new DefaultButton(this.window.root,'×');this.closeButton.onClick=()=>this.close();
  place(this.title,15,15);this.title.style.fontSize='16px';this.title.style.overflow='hidden';this.title.style.textOverflow='ellipsis';place(this.description,15,42);place(this.hint,15,223);this.hint.style.color='#b9cbb9';
  window.addEventListener('resize',()=>this.layout());window.addEventListener('keydown',event=>{if(!this.root.hidden&&event.key==='Escape'){event.preventDefault();event.stopPropagation();this.close();}},true);
 }
 show(name:string,path:string,current:AppearanceStyle,choose:(style:AppearanceStyle)=>void):void{
  this.choose=choose;this.title.textContent=name+' — оформление';this.description.textContent=(path.startsWith('hulls/')?'Текстуры':'Текстуры и эффекты')+' для всех модификаций M0–M3';this.hint.textContent=path.startsWith('hulls/')?'Эффекты общие. В бою — со следующего входа.':'В бою применяется при следующем входе.';for(const choice of this.choices){choice.image.src=`/tank_parts/styles/${choice.style}/${path}/preview.png?v=1`;choice.button.caption=(choice.style===current?'✓ ':'')+(choice.style==='old'?'Old':'Gen 2');choice.button.setEnabled(choice.style!==current);}this.root.hidden=false;this.layout();
 }
 close():void{this.root.hidden=true;this.choose=null;}
 private layout():void{const width=Math.min(420,Math.max(300,window.innerWidth-20)),column=(width-24)/2,imageWidth=Math.min(164,column-8);this.window.setBounds(Math.max(0,(window.innerWidth-width)/2),Math.max(24,(window.innerHeight-260)/2),width,260);this.closeButton.setBounds(width-42,11,30);this.title.style.width=(width-65)+'px';this.choices.forEach((choice,index)=>{place(choice.image,12+index*column+(column-imageWidth)/2,70,imageWidth,imageWidth*106/164);choice.button.setBounds(12+index*column+(column-130)/2,184,130);});}
}

/** CategoryButtonsList/ItemCategoryButton: equal widths, 5px gaps, icon+text/text/icon LOD. */
import {el,place} from './widgets.ts';
import './garage-categories.css';
const ROOT='/battle/garage_tabs';
const CATEGORIES=[[0,'Пушки','weapon'],[1,'Корпуса','armor'],[2,'Краски','color'],[3,'Припасы','inventory'],[5,'Комплекты','kit'],[4,'Особое','special']] as const;
export class GarageCategories {
 readonly root:HTMLDivElement;
 selected=0;
 onSelect:((category:number)=>void)|null=null;
 private readonly buttons:{id:number;root:HTMLButtonElement;icon:HTMLImageElement;text:HTMLSpanElement;pieces:HTMLDivElement[]}[]=[];
 constructor(parent:HTMLElement){
  this.root=el('div','garage-categories',parent);this.root.setAttribute('role','tablist');
  for(const[id,name,icon]of CATEGORIES){const root=el('button','garage-category',this.root);root.type='button';root.setAttribute('role','tab');root.title=name;
   const pieces=['l','c','r'].map(side=>el('div','garage-category-'+side,root));const image=el('img','garage-category-icon',root);image.src=`${ROOT}/ItemCategoryButton_${icon}IconClass.png`;image.draggable=false;
   const text=el('span','garage-category-text',root);text.textContent=name;
   const button={id,root,icon:image,text,pieces};this.buttons.push(button);root.onclick=()=>{this.select(id);try{localStorage.setItem('tanki.garage.category',String(id));}catch{}this.onSelect?.(id);};
   root.onpointerenter=()=>this.draw(id,'OVER');root.onpointerleave=()=>this.draw(id,'UP');root.onpointerdown=()=>this.draw(id,'DOWN');root.onpointerup=()=>this.draw(id,'OVER');
  }
  let saved=0;try{saved=Number(localStorage.getItem('tanki.garage.category')??0);}catch{}this.select(CATEGORIES.some(c=>c[0]===saved)?saved:0);
 }
 select(id:number):void{this.selected=id;for(const button of this.buttons){button.root.setAttribute('aria-selected',String(button.id===id));button.root.disabled=button.id===id;this.draw(button.id,'UP');}}
 private draw(id:number,state:string):void{
  const button=this.buttons.find(b=>b.id===id)!;const selected=id===this.selected;
  ['LEFT','CENTER','RIGHT'].forEach((part,index)=>{button.pieces[index].style.backgroundImage=`url(${ROOT}/${selected?'GreenMediumButtonSkin_'+['left','middle','right'][index]+'DownClass':'button_def_'+state+'_'+part}.png)`;});
 }
 setBounds(x:number,y:number,width:number):void{
  place(this.root,x,y,width,30);const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(ctx)ctx.font='12px MyriadPro,Arial,sans-serif';
  const maxText=Math.max(...this.buttons.map(b=>Math.ceil(ctx?.measureText(b.text.textContent??'').width??80)));
  let size=(width-5*(this.buttons.length-1))/this.buttons.length;const iconText=size>=maxText+33,textOnly=!iconText&&size>=maxText+12;
  size=iconText?Math.min(size,maxText+40):textOnly?Math.min(size,maxText+26):30;
  this.buttons.forEach((button,index)=>{place(button.root,index*(size+5),0,size,30);button.icon.hidden=textOnly;button.text.hidden=!iconText&&!textOnly;button.root.classList.toggle('garage-category-icon-text',iconText);button.root.classList.toggle('garage-category-icon-only',!iconText&&!textOnly);});
 }
}

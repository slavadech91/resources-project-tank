import type {LobbyBattleInfo,BattleUser} from '../../net/lobby.ts';
import {WindowInner,UI,el,label,place,sprite} from './widgets.ts';
import './team-battle-info.css';
/** ProTanki BattleInfoTeamView/BattleInfo{Red,Blue}UserListRenderer. */
export class TeamBattleRoster {
 private panels:WindowInner[]=[];private lists:HTMLElement[]=[];
 private readonly score:HTMLElement;private red:HTMLElement;private blue:HTMLElement;
 constructor(parent:HTMLElement){
  for(const [index,team] of ['red','blue'].entries()){
   const panel=new WindowInner(parent,index===0?'#621700':'#002c59',true);panel.root.classList.add('team-info-panel',`team-info-${team}`);
   const blink=panel.root.querySelector<HTMLImageElement>('.lb-inner-clip img');if(blink)blink.src=`${UI()}/WindowInnerBlink/${index===0?3:2}.png`;
   this.panels.push(panel);this.lists.push(el('div','team-info-list',panel.root));
  }
  this.score=el('div','team-info-score',parent);this.red=el('span','team-info-score-red',this.score);el('span','',this.score).textContent=':';this.blue=el('span','team-info-score-blue',this.score);
 }
 set(info:LobbyBattleInfo,uid:(id:number)=>string,rank:(id:number)=>number):void {
  const scores=info.teamScores??[0,0];this.red.textContent=String(scores[0]);this.blue.textContent=String(scores[1]);
  [info.reds,info.blues].forEach((users,index)=>{
   const list=this.lists[index],scroll=list.scrollTop;list.replaceChildren();
   const rows:(BattleUser|null)[]=[...users].sort((a,b)=>(b.score??b.kills)-(a.score??a.kills));while(rows.length<info.maxPeople)rows.push(null);
   for(const user of rows){const row=el('div','team-info-row',list);
    for(const side of ['left','center','right'])el('div',`team-info-row-${side}`,row);
    if(user){sprite(row,'RangIconSmall',rank(user.userId),5,3);const name=label(row,uid(user.userId),'team-info-name');if(user.suspicious)name.style.color='#ffc000';label(row,String(user.score??user.kills),'team-info-kills');}
    else label(row,'Пусто','team-info-empty');
   }
   list.scrollTop=scroll;
  });
 }
 set visible(value:boolean){for(const panel of this.panels)panel.root.hidden=!value;this.score.hidden=!value;}
 layout(width:number,height:number,infoHeight:number,adminGap:number):void {
  const left=Math.floor((width-25)/2),top=infoHeight+14,h=height-infoHeight-80-adminGap;
  this.panels[0].setBounds(11,top,left,h);this.panels[1].setBounds(14+left,top,width-left-25,h);
  place(this.score,11,height-51,width-22,30);
 }
}

import type {BattleMode,CtfFlag} from '../../net2/protocol.ts';
/** TeamScoreFieldBase/TDMScoreField/ComplexTeamScoreIndicator, inside the existing WhiteFrame. */
export class TeamScore {
 readonly root=document.createElement('div');
 private red=document.createElement('span');private blue=document.createElement('span');
 private left=document.createElement('span');private right=document.createElement('span');private kill=document.createElement('img');
 constructor(parent:HTMLElement){this.root.className='protanki-team-score';this.red.className='pts-red';this.blue.className='pts-blue';this.left.className='pts-flag';this.right.className='pts-flag';for(const [i,slot] of [this.left,this.right].entries()){for(const suffix of ['', '-lost']){const image=document.createElement('img');image.src=`battle/ctf/${i===0?'red':'blue'}${suffix}.png`;image.className=suffix?'pts-lost':'pts-normal';slot.appendChild(image);}}this.kill.src='battle/hud/battle_icons/2.png';this.kill.className='pts-kill';this.root.append(this.left,this.red,this.kill,this.blue,this.right);parent.appendChild(this.root);this.set('dm',[0,0],[]);}
 set(mode:BattleMode,scores:[number,number],flags:CtfFlag[]):void {
  this.root.hidden=mode==='dm';this.root.classList.toggle('pts-ctf',mode==='ctf');this.red.textContent=String(scores[0]);this.blue.textContent=String(scores[1]);
  this.red.style.minWidth=this.blue.style.minWidth=`${Math.max(String(scores[0]).length,String(scores[1]).length)}ch`;
  for(const [i,slot] of [this.left,this.right].entries()){
    const f=flags.find(f=>f.team===i);slot.classList.toggle('pts-carried',f?.state==='carried');slot.classList.toggle('pts-dropped',f?.state==='dropped');slot.title=f?.state==='base'?'Флаг на базе':f?.state==='carried'?'Флаг у противника':'Флаг потерян';
  }
 }
 get width():number{return this.root.offsetWidth;}
}

import { FEED_COLORS,KillFeedModel,feedWeaponIcon,type FeedKill,type FeedLine,type FeedUser } from './KillFeedModel.ts';
import './killfeed.css';

/** Original bitmap sizes, ordering, spacing and lifetime; no animation-frame polling. */
export class BattleKillFeed {
  private readonly root=document.createElement('div');
  private readonly model=new KillFeedModel();
  private readonly rows=new Map<FeedLine,HTMLElement>();
  private timer:ReturnType<typeof setTimeout>|null=null;
  constructor(parent:HTMLElement=document.body){
    this.root.className='battle-killfeed';this.root.setAttribute('role','log');
    this.root.setAttribute('aria-label','Уничтожения в бою');this.root.setAttribute('aria-live','polite');parent.appendChild(this.root);
  }
  add(kill:FeedKill):void{
    const line=this.model.add(kill,performance.now());if(!line)return;
    const row=document.createElement('div');row.className='battle-killfeed-line';
    if(line.actionIcon){this.user(row,line.victim);this.icon(row,line.actionIcon,'Действие с флагом');}
    else if(!line.killer||line.killer.id===line.victim.id){
      row.classList.add('battle-killfeed-self');this.user(row,line.victim);this.icon(row,'self-destroy','Самоуничтожение');
    }else{
      this.user(row,line.killer);
      const icon=feedWeaponIcon(line.weapon);if(icon)this.icon(row,icon,line.weapon??'');
      this.user(row,line.victim);
    }
    this.rows.set(line,row);this.root.appendChild(row);this.synchronize();
  }
  clear():void{
    if(this.timer!==null)clearTimeout(this.timer);this.timer=null;
    this.model.clear();this.rows.clear();this.root.replaceChildren();
  }
  dispose():void{this.clear();this.root.remove();}
  private synchronize():void{
    if(this.timer!==null)clearTimeout(this.timer);this.timer=null;
    this.model.expire(performance.now());
    for(const [line,row]of this.rows)if(!this.model.lines.includes(line)){row.remove();this.rows.delete(line);}
    const first=this.model.lines[0];
    if(first)this.timer=setTimeout(()=>this.synchronize(),Math.max(1,first.expiresAt-performance.now()));
  }
  private user(parent:HTMLElement,user:FeedUser):void{
    const label=document.createElement('span');label.className='battle-killfeed-user';label.style.color=FEED_COLORS[user.team];
    const rank=document.createElement('span');rank.className='battle-killfeed-rank';
    const image=document.createElement('img');image.src=`battle/killfeed/ranks/${Math.max(1,Math.min(31,Math.trunc(user.rank)))}.png?v=1`;image.alt='';image.draggable=false;rank.appendChild(image);
    const name=document.createElement('span');name.className='battle-killfeed-name';name.textContent=user.name;
    label.append(rank,name);parent.appendChild(label);
  }
  private icon(parent:HTMLElement,name:string,alt:string):void{
    const image=document.createElement('img');image.className='battle-killfeed-weapon';
    image.src=name.startsWith('ctf/')?`battle/${name}.png?v=1`:`battle/killfeed/${name}.png?v=1`;image.width=16;image.height=16;image.alt=alt;image.draggable=false;parent.appendChild(image);
  }
}

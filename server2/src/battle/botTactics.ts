export type BotTask='patrol'|'watch'|'snipe'|'attackMove'|'evade'|'retreat'|'reloadCover'|'peek'|'investigate'|'supply'|'drop'|'objective';
export interface TacticalContext {
  hp:number;visible:boolean;range:number;memory:boolean;danger:boolean;afraid:boolean;
  justFired:boolean;cover:boolean;medical:boolean;supply:boolean;drop:boolean;canFire:boolean;
}
/** Priority/utility choice only. Geometry and task execution remain in BotWorld. */
export function chooseBotTask(c:TacticalContext,random:()=>number):BotTask{
  if(c.hp<0.35&&(c.visible||c.afraid))return 'retreat';
  if(c.medical&&c.hp<0.7&&!c.visible)return 'supply';
  if(c.afraid&&random()<0.7)return 'retreat';
  if(c.danger&&c.visible&&random()<0.55)return 'evade';
  if(c.justFired&&c.memory&&c.cover&&random()<0.65)return 'reloadCover';
  if(c.visible){
    if(c.canFire&&c.range>2400&&random()<0.55)return 'snipe';
    return 'attackMove';
  }
  if(c.supply&&random()<0.45)return 'supply';
  if(c.memory)return 'investigate';
  if(c.drop)return 'drop';
  return 'patrol';
}

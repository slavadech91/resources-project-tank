// Narukami: BattleMessagesOutput / MessageLine / MessageColor (source details in docs/KILLFEED_PORT.md).
export const KILL_FEED_LIMIT=10;
export const KILL_FEED_LIFE_MS=30000;
export const KILL_FEED_FADE_MS=1000;
export type FeedTeam='red'|'blue'|'none';
export interface FeedUser {id:number;name:string;rank:number;team:FeedTeam}
export interface FeedKill {actionIcon?:string;victim:FeedUser;killer:FeedUser|null;weapon:string|null;key?:string}
export interface FeedLine extends FeedKill {createdAt:number;expiresAt:number}
export const FEED_COLORS:Record<FeedTeam,string>={red:'#f03416',blue:'#4797ff',none:'#00ff00'};
const WEAPONS=new Set(['artillery','atField','devastation','firebird','freeze','gauss','isis','machinegun','mine','nuclear','railgun','ricochet','rocket','shaft','shotgun','smoky','thunder','twins']);
export function feedWeaponIcon(kind:string|null):string|null{
  const normalized=({isida:'isis',firebird_overheat:'firebird',smoky_critical:'smoky',machine_gun:'machinegun',terminator:'devastation',at_field:'atField'} as Record<string,string>)[kind??'']??kind;
  return normalized&&WEAPONS.has(normalized)?normalized:null;
}
export class KillFeedModel {
  readonly lines:FeedLine[]=[];
  private readonly seen=new Set<string>();
  add(kill:FeedKill,now:number):FeedLine|null{
    if(kill.key&&this.seen.has(kill.key))return null;
    if(kill.key){this.seen.add(kill.key);if(this.seen.size>512)this.seen.delete(this.seen.values().next().value!);}
    const line:FeedLine={...kill,victim:{...kill.victim},killer:kill.killer?{...kill.killer}:null,createdAt:now,expiresAt:now+KILL_FEED_LIFE_MS+KILL_FEED_FADE_MS};
    this.lines.push(line);if(this.lines.length>KILL_FEED_LIMIT)this.lines.shift();return line;
  }
  expire(now:number):void{while(this.lines.length&&this.lines[0].expiresAt<=now)this.lines.shift();}
  clear():void{this.lines.length=0;this.seen.clear();}
}

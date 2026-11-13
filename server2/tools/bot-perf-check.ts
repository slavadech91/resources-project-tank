// Short offline CPU/step-time measurement; no sessions, network, accounts or timers.
import { resolve } from 'node:path';
import { GarageCatalog } from '../src/garage/catalog.ts';
import { loadBotProfile } from '../src/battle/botProfile.ts';
import { loadMapData,spawnsFor } from '../src/battle/mapData.ts';
import { BotWorld,type BotParticipant } from '../src/battle/botWorld.ts';
const configDir=resolve('dev/configs'),{profile,loadout}=loadBotProfile(configDir,new GarageCatalog(configDir));
const map=[...loadMapData(configDir).values()].find(m=>m.key==='silence')!;
const frames=Number(process.env.BOT_PERF_FRAMES??180);
for(const count of (process.argv.length>2?process.argv.slice(2).map(Number):[4,8,16])){
  const spawns=spawnsFor(map,2);let seed=9341;
  const actors:BotParticipant[]=Array.from({length:count},(_,i)=>({id:0xf0000000+i,team:2,state:'active',life:1,health:loadout.maxHealth,position:{...spawns[i%spawns.length].position},orientation:spawns[i%spawns.length].orientation,sample:null,loadout,speedFactor:1}));
  const world=new BotWorld(map,profile,(id,s)=>{const p=actors[id-0xf0000000];p.position={x:s.px,y:s.py,z:s.pz};p.sample=s;},()=>{},()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32));
  for(const p of actors)world.spawn(p.id,1,{position:p.position!,orientation:p.orientation!});
  const cpu=process.cpuUsage(),steps:number[]=[];
  for(let frame=0;frame<frames;frame++){const t=performance.now();world.step(actors,frame*33,frame*33);steps.push(performance.now()-t);}
  const used=process.cpuUsage(cpu);steps.sort((a,b)=>a-b);
  console.log(JSON.stringify({bots:count,baked:world.navigation.baked,steps:steps.length,simulatedSec:frames*.033,cpuCorePercent:Math.round((used.user+used.system)/(frames*33000)*100),p95Ms:+steps[Math.floor(steps.length*.95)].toFixed(2),maxMs:+steps.at(-1)!.toFixed(2),rssMB:Math.round(process.memoryUsage().rss/1048576)}));
  world.clear();
}

// Real collision map, offline physical traversal. No live client/accounts/network.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { GarageCatalog } from '../src/garage/catalog.ts';
import { loadBotProfile } from '../src/battle/botProfile.ts';
import { loadMapData } from '../src/battle/mapData.ts';
import { BotWorld,type BotParticipant } from '../src/battle/botWorld.ts';
const configDir=resolve('dev/configs'),{profile,loadout}=loadBotProfile(configDir,new GarageCatalog(configDir));
const map=[...loadMapData(configDir).values()].find(m=>m.key==='arena')!;
for(const uphill of [true,false]){
  const spawn={position:{x:1750,y:uphill?-2200:-3500,z:uphill?130:430},orientation:{x:0,y:0,z:uphill?Math.PI:0}};
  const goal={x:1750,y:uphill?-3500:-2200,z:uphill?300:0};
  const actor:BotParticipant={id:1,team:2,state:'active',life:1,health:loadout.maxHealth,position:spawn.position,orientation:spawn.orientation,sample:null,loadout,speedFactor:1};
  const world=new BotWorld(map,profile,(_id,s)=>{actor.position={x:s.px,y:s.py,z:s.pz};actor.sample=s;},()=>{},()=>0.5);
  assert.equal(world.navigation.baked,true,'real map graph is ready before the first AI tick');
  const route=world.navigation.route(spawn.position,goal);
  assert.ok(route.some(n=>(n.normal?.z??1)<0.95),'route passes through the actual incline');
  assert.ok(world.navigation.walkable({x:1750,y:-2500,z:0},{x:1750,y:-2750,z:150}),'exact floor/ramp boundary is supported');
  assert.ok(world.navigation.walkable({x:1750,y:-2750,z:150},{x:1750,y:-3000,z:300}),'exact ramp/upper platform boundary is supported');
  world.spawn(1,1,spawn);const b=(world as any).bots.get(1);
  b.path=world.navigation.smooth(spawn.position,route);b.task='patrol';b.decisionAt=60000;
  for(let frame=0;frame<600;frame++)world.step([actor],frame*33,frame*33);
  assert.ok(Math.abs(actor.position!.y-goal.y)<260,JSON.stringify({uphill,position:actor.position,goal}));
  assert.ok(Math.abs(actor.position!.z-goal.z-89.25)<80,'tank reached the correct surface level on suspension');
  world.clear();
}
const world=new BotWorld(map,profile,()=>{},()=>{},()=>0.5);
const spawn=map.spawns.dm[0];world.spawn(1,1,spawn);
const b=(world as any).bots.get(1);
(world as any).assignTask(b,'patrol',spawn.position,null,null,0);
assert.ok(b.path.length>0);assert.ok(b.taskUntil>30000,'distant patrol has time to finish rather than an 18 second expiry');
assert.ok(Math.hypot(b.destination.x-spawn.position.x,b.destination.y-spawn.position.y)>3000,JSON.stringify({spawn:spawn.position,destination:[b.destination.x,b.destination.y,b.destination.z],far:Math.max(...world.navigation.reachable(spawn.position,8000).map(n=>Math.hypot(n.x-spawn.position.x,n.y-spawn.position.y)))}));
const first=b.destination;
const self:BotParticipant={id:1,team:2,state:'active',life:1,health:loadout.maxHealth,position:spawn.position,orientation:spawn.orientation,sample:null,loadout,speedFactor:1};
b.progressAt=b.taskUntil;
(world as any).think(1,b,self,[self],b.taskUntil+1);
assert.equal(b.destination,first,'elapsed time alone does not discard an unfinished search route');
world.clear();
console.log('Real Arena: floor/ramp/upper seams, physical uphill/downhill, ready graph and persistent distant patrol OK');

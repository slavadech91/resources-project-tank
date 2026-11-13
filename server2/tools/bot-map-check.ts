// Offline headless navigation/physics on an exported map. No login or live opponent.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { GarageCatalog } from '../src/garage/catalog.ts';
import { loadBotProfile } from '../src/battle/botProfile.ts';
import { loadMapData,spawnsFor } from '../src/battle/mapData.ts';
import { BotWorld,type BotParticipant } from '../src/battle/botWorld.ts';
const configDir=resolve('dev/configs'),catalog=new GarageCatalog(configDir),{profile,loadout}=loadBotProfile(configDir,catalog);
const key=process.argv[2]??'arena';
const map=[...loadMapData(configDir).values()].find(m=>m.key===key);assert.ok(map,'map is present');
const spawn=spawnsFor(map,2)[0];
const actor:BotParticipant={id:0xf0000000,team:2,state:'active',life:1,health:loadout.maxHealth,position:{...spawn.position},orientation:spawn.orientation,sample:null,loadout,speedFactor:1};
let travelled=0,fallen=0,last={...spawn.position},seed=97512;
const world=new BotWorld(map,profile,(_id,s)=>{
  assert.ok(Number.isFinite(s.px)&&Number.isFinite(s.pz));
  travelled+=Math.hypot(s.px-last.x,s.py-last.y);last={x:s.px,y:s.py,z:s.pz};actor.position=last;actor.sample=s;
  if(s.pz<-2000)fallen++;
},()=>{},()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32));
world.spawn(actor.id,1,spawn);
for(let frame=0;frame<900;frame++)world.step([actor],frame*33,frame*33);
if(process.argv.includes('--debug')){const b=[...(world as any).bots.values()][0];console.log({nodes:world.navigation.nodes.length,reachable:world.navigation.reachable(actor.position!).length,far:Math.max(...world.navigation.reachable(actor.position!).map(n=>Math.hypot(n.x-actor.position!.x,n.y-actor.position!.y))),task:b?.task,position:actor.position,control:b?.control,goal:b?.path[0],destination:b?.destination,velocity:actor.sample&&[actor.sample.vx,actor.sample.vy],yaw:actor.sample&&[actor.sample.qw,actor.sample.qz]});}
world.clear();
assert.ok(world.navigation.nodes.length>5,'walkable graph has nodes');assert.ok(travelled>300,'bot explores actual map');
assert.equal(fallen,0,'no sustained fall below map in this deterministic scenario');
console.log('Offline map check:',key,{nodes:world.navigation.nodes.length,travelled:Math.round(travelled),fallen});

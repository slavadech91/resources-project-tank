// Offline only: synthetic map, in-memory sessions, no database/network/account changes.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { GarageCatalog } from '../src/garage/catalog.ts';
import { loadBotProfile } from '../src/battle/botProfile.ts';
import { BotWorld, type BotParticipant } from '../src/battle/botWorld.ts';
import { Battle } from '../src/battle/battle.ts';
import { BattleRegistry } from '../src/lobby/battles.ts';
import { loadConfig } from '../src/config.ts';
import { handlers } from '../src/handlers.ts';
import type { MapData } from '../src/battle/mapData.ts';
import type { BattleSettings, BattleSummary } from '../../html5/src/net2/protocol.ts';

const root=resolve(process.argv[2]??'.'),config=loadConfig({TANKI_DEV:resolve(root,'dev')});
const catalog=new GarageCatalog(config.configDir),{profile,loadout}=loadBotProfile(config.configDir,catalog);
assert.equal(loadout.parts.hull,profile.hullId);assert.equal(loadout.parts.turret,profile.turretId);
assert.equal(loadout.weapon.kind,'railgun');assert.equal(loadout.maxHealth,profile.hull.armor);
const spawn={position:{x:-1000,y:-1000,z:130},orientation:{x:0,y:0,z:0}};
const floor='<collision-box id="fixture"><size><x>5000</x><y>5000</y><z>100</z></size><position><x>0</x><y>0</y><z>-50</z></position><rotation><x>0</x><y>0</y><z>0</z></rotation></collision-box>';
const second={position:{x:1000,y:-1000,z:130},orientation:{x:0,y:0,z:0}};
const map:MapData={mapId:1,key:'test',xml:floor,spawns:{dm:[spawn,second],red:[spawn],blue:[second]},killZones:[],bonusRegions:[]};
let seed=9341;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
const participants:BotParticipant[]=[{id:0xf0000000,team:2,state:'active',life:1,health:loadout.maxHealth,position:{...spawn.position},orientation:{...spawn.orientation},sample:null,loadout,speedFactor:1},
  {id:123,team:2,state:'active',life:1,health:loadout.maxHealth,position:{x:-1000,y:650,z:90},orientation:{x:0,y:0,z:0},sample:null,loadout,speedFactor:1}];
let shots=0,hits=0,travel=0,moveFrames=0,spinFrames=0,last=spawn.position;
const world=new BotWorld(map,profile,(_id,s)=>{
  if(s.chassis&1)moveFrames++;
  if(s.chassis&12&&!(s.chassis&3))spinFrames++;
  const position={x:s.px,y:s.py,z:s.pz};travel+=Math.hypot(position.x-last.x,position.y-last.y);last=position;
  participants[0].position=position;participants[0].sample=s;
  assert.ok(Number.isFinite(s.pz)&&s.pz>-100,'bot keeps ground contact on the synthetic floor');
},(_id,_point,targets)=>{shots++;if(targets.some(target=>target.id===123))hits++;},random);
world.spawn(participants[0].id,1,spawn);
for(let frame=0;frame<1000;frame++)world.step(participants,frame*33,frame*33);
assert.ok(world.navigation.nodes.length>20);assert.ok(travel>200,'bot drives using its chassis and suspension');
assert.ok(shots>0&&hits>0,'visible target can be detected and hit with Railgun');
assert.ok(shots<14,'bot observes Railgun reload and reaction timing');
assert.ok(moveFrames>120,'a stationary enemy must not pin the bot into idle hull aiming');
world.clear();
console.log('Bots: catalog Wasp M3/Railgun M0 loadout, headless suspension/movement, navigation, detection, firing and reload OK', {shots,hits,travel:Math.round(travel),moveFrames,spinFrames});

const wall=map.xml+'<collision-box><size><x>5000</x><y>100</y><z>1000</z></size><position><x>0</x><y>0</y><z>500</z></position><rotation><x>0</x><y>0</y><z>0</z></rotation></collision-box>';
let hiddenShots=0;
const hidden=new BotWorld({...map,xml:wall},profile,(_id,s)=>{participants[0].position={x:s.px,y:s.py,z:s.pz};},()=>hiddenShots++,random);
participants[0].position={...spawn.position};hidden.spawn(participants[0].id,1,spawn);
for(let frame=0;frame<150;frame++)hidden.step(participants,frame*33,frame*33);
assert.equal(hiddenShots,0,'bots must not detect or shoot through the separating wall');hidden.clear();

const registry=new BattleRegistry({} as any,[{id:1,name:'Test',maxPeople:20,modes:['dm','tdm'],minRank:1,maxRank:30,theme:'summer',previewId:0}]);
const settings:BattleSettings={name:'Bots',mode:'dm',mapId:1,maxPeople:20,timeLimitSec:0,scoreLimit:0,minRank:1,maxRank:30,botCount:2};
assert.equal(registry.validate({...settings,botCount:16}).botCount,16);
for(const count of [-1,1.5,17,NaN])assert.throws(()=>registry.validate({...settings,botCount:count}));
assert.throws(()=>registry.validate({...settings,maxPeople:2,botCount:2}),'reserve one human slot');
assert.throws(()=>registry.validate({...settings,mode:'tdm',maxPeople:3,botCount:2}),'respect per-team capacity');
await assert.rejects(()=>handlers['lobby.create']({} as any,{user:{admin:false}} as any,settings as any),/администратора/);

const summary:BattleSummary={...settings,id:9,mapName:'Test',players:[0,0],users:[]};
const user={id:123,name:'OfflineFixture',rank:1,score:0,rankScore:0,nextRankScore:100,crystals:0,admin:true};
const session={user,isOpen:true,ws:{bufferedAmount:0,sendBinary:()=>{}},send:()=>{}} as any;
const battle=new Battle(summary,map,{...config.battle,spawnDelayMs:0,activationDelayMs:0,deadTimeMs:0,roundEndScreenMs:10},()=>{},
  {addKillScore:(_s,id)=>assert.ok(id<0xf0000000),giveFund:entries=>assert.ok(entries.every(e=>e.userId<0xf0000000)),giveCrystals:()=>{},consumeItem:()=>{}} as any);
try{
  battle.configureBots(profile,loadout);battle.add(session,user,loadout,2);
  await new Promise(r=>setTimeout(r,25));
  const bots=battle.info().players.filter(p=>p.userId>=0xf0000000);
  assert.equal(bots.length,2);assert.ok(bots.every(p=>p.state==='active'));
  assert.equal(battle.playerCount,3);
  const victim=(battle as any).players.get(bots[0].userId);
  (battle as any).kill(victim,'killed',(battle as any).players.get(user.id));
  (battle as any).updateBots();await new Promise(r=>setTimeout(r,25));
  assert.ok(battle.info().players.find(p=>p.userId===victim.userId)!.life>bots[0].life,'dead bots respawn');
  battle.adminEndRound();await new Promise(r=>setTimeout(r,70));
  assert.equal(battle.info().roundEndInSec,null,'round restarts with bots');
  battle.remove(session);assert.equal(battle.playerCount,0,'last human leaving removes all bots');
  assert.equal((battle as any).botTimer,null);assert.equal((battle as any).botWorld,null);
}finally{battle.close();}
console.log('Bots: admin-only validation, count limits, shared battle lifecycle, respawn/round restart and empty-room cleanup OK');

const crowded=new Battle({...summary,id:10}, {...map,spawns:{dm:[spawn],red:[spawn],blue:[spawn]}},
  {...config.battle,spawnDelayMs:0,activationDelayMs:0},()=>{},
  {addKillScore:()=>{},giveFund:()=>{},giveCrystals:()=>{},consumeItem:()=>{}} as any);
try{
  crowded.configureBots(profile,loadout);crowded.add(session,user,loadout,2);
  await new Promise(r=>setTimeout(r,25));
  assert.equal(crowded.info().players.filter(p=>p.userId>=0xf0000000&&['spawned','active'].includes(p.state)).length,1,'bots reserve occupied spawn points instead of spawning inside each other');
}finally{crowded.close();}
console.log('Bots: crowded spawn reservation OK');

const crowd:BotParticipant[]=Array.from({length:16},(_,i)=>({id:0xf0000000+i,team:2,state:'active',life:1,health:loadout.maxHealth,
  position:{x:-1500+(i%4)*1000,y:-1500+Math.floor(i/4)*1000,z:130},orientation:{x:0,y:0,z:0},sample:null,loadout,speedFactor:1}));
let samples=0;
const maxWorld=new BotWorld(map,profile,(id,s)=>{const p=crowd.find(p=>p.id===id)!;p.position={x:s.px,y:s.py,z:s.pz};p.sample=s;samples++;assert.ok(Number.isFinite(s.pz));},()=>{},random);
for(const p of crowd)maxWorld.spawn(p.id,p.life,{position:p.position!,orientation:p.orientation!});
for(let frame=0;frame<200;frame++)maxWorld.step(crowd,frame*33,frame*33);
assert.equal(samples,16*200);maxWorld.clear();console.log('Bots: 16 simultaneous headless actors produce valid snapshots OK');

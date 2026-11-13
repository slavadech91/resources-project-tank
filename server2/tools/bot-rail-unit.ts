// Offline real bot/loadout: charge timing, reload, physical shot and death cleanup.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { GarageCatalog } from '../src/garage/catalog.ts';
import { loadBotProfile } from '../src/battle/botProfile.ts';
import { BotWorld,type BotParticipant } from '../src/battle/botWorld.ts';
import { Battle } from '../src/battle/battle.ts';
import type { MapData } from '../src/battle/mapData.ts';
import type { ShotHit } from '../../html5/src/net2/protocol.ts';
const configDir=resolve('dev/configs'),catalog=new GarageCatalog(configDir),{profile,loadout}=loadBotProfile(configDir,catalog);
const items=[...catalog.items.values()];
assert.equal(items.find(i=>i.object3dsId===profile.hullId)?.modification,3);
assert.equal(items.find(i=>i.object3dsId===profile.turretId)?.modification,0);
assert.equal(loadout.weapon.kind,'railgun');assert.ok(loadout.weapon.chargingMs>0);
const spawn={position:{x:0,y:0,z:130},orientation:{x:0,y:0,z:0}};
const map:MapData={mapId:1,key:'rail-fixture',xml:'<collision-box><size><x>12000</x><y>12000</y><z>100</z></size><position><x>0</x><y>0</y><z>-50</z></position><rotation><x>0</x><y>0</y><z>0</z></rotation></collision-box>',spawns:{dm:[spawn],red:[spawn],blue:[spawn]},killZones:[],bonusRegions:[]};
map.xml += '<collision-box><size><x>1000</x><y>100</y><z>400</z></size><position><x>0</x><y>4900</y><z>200</z></position><rotation><x>0</x><y>0</y><z>0</z></rotation></collision-box>';
const bot:BotParticipant={id:1,team:2,state:'active',life:1,health:loadout.maxHealth,position:spawn.position,orientation:spawn.orientation,sample:null,loadout,speedFactor:1};
const target:BotParticipant={...bot,id:2,position:{x:0,y:4000,z:89.25}};
const second:BotParticipant={...target,id:3,position:{x:0,y:4400,z:89.25}};
const behindWall:BotParticipant={...target,id:4,position:{x:0,y:5250,z:89.25}};
const actors = [bot, target, second, behindWall];
let now=0,chargedAt=-Infinity,lastShot=-Infinity,charges=0,shots=0,hits=0,penetrations=0;
const world=new BotWorld(map,profile,(_id,s)=>{bot.position={x:s.px,y:s.py,z:s.pz};},(_id,hit,victims)=>{
  assert.ok(now-chargedAt>=loadout.weapon.chargingMs,'rail never fires before full charging time');
  assert.ok(now-lastShot>=loadout.weapon.reloadMs+loadout.weapon.chargingMs,'rail reload and subsequent charge both elapse');
  lastShot=now;shots++;if(victims[0]?.id===2)hits++;
  assert.ok(!victims.some(victim=>victim.id===4),'rail stops at the wall');
  if (victims.length === 2) {
    assert.deepEqual(victims.map(victim=>victim.id),[2,3]);
    assert.equal(hit?.y,4850,'beam ends on the near side of the wall');
    penetrations++;
  }
},()=>0.4,()=>{},()=>{chargedAt=now;charges++;});
world.spawn(1,1,spawn);const state=(world as any).bots.get(1);state.task='snipe';state.taskUntil=60000;
for(let frame=0;frame<1000;frame++){now=frame*33;world.step(actors,now,now);}
assert.ok(charges>=2&&shots>=2&&hits>=1,'bot charges, fires and can hit with Railgun');
assert.ok(penetrations>=1,'bot rail penetrates two aligned tanks');
assert.ok(charges-shots<=1,'only one pending charged shot');
state.chargingUntil=now+1000;world.remove(1);
world.step(actors,now+2000,now+2000);assert.equal((world as any).bots.has(1),false,'removed bot cannot finish its pending charge');
world.clear();

const battle = new Battle({ mode:'dm' } as ConstructorParameters<typeof Battle>[0], map,
  {} as ConstructorParameters<typeof Battle>[2], () => {}, {} as ConstructorParameters<typeof Battle>[4]) as any;
const fixedDamage = 100;
function player(actor: BotParticipant) {
  return {
    userId:actor.id, name:String(actor.id), life:1, state:'active', alive:true, position:actor.position,
    health:1000, chargeAt:Date.now()-loadout.weapon.chargingMs, lastShotAt:-Infinity, effects:new Map(),
    history:[], loadout:{...loadout, damageFrom:fixedDamage, damageTo:fixedDamage},
  };
}
const shooter = player(bot), first = player(target), next = player(second);
shooter.position = spawn.position;
battle.roundActive = true;
battle.player = () => shooter;
battle.players.set(first.userId, first);
battle.players.set(next.userId, next);
battle.send = () => {};
const events: { userId: number }[][] = [];
battle.broadcast = (event: string, payload: { targets: { userId: number }[] }) => {
  if (event === 'battle.rail') events.push(payload.targets);
};
function reportHit(actor: ReturnType<typeof player>): ShotHit {
  return { userId:actor.userId, life:actor.life, position:actor.position!, world:actor.position!, local:{x:0,y:0,z:0} };
}
const result = battle.rail({}, 0, { x:0, y:4850, z:130 }, [reportHit(next), reportHit(first), reportHit(first)], false);
assert.deepEqual(result.hits.map((hit: { userId: number }) => hit.userId),[2,3]);
assert.deepEqual(events[0].map(hit=>hit.userId),[2,3]);
assert.equal(first.health,1000-fixedDamage);
assert.equal(next.health,1000-fixedDamage*loadout.weapon.weakeningCoeff);
console.log('Railgun charge, reload, ordered penetration, weakening and wall stop OK',{charges,shots,hits,penetrations});

// Offline integration checks; no database, login or browser.
import assert from 'node:assert/strict';
import {battleRules,equipmentAllowed} from '../src/battle/rules.ts';
import {Battle} from '../src/battle/battle.ts';
import {BattleRegistry} from '../src/lobby/battles.ts';
import {GarageCatalog} from '../src/garage/catalog.ts';
import {assembleLoadout} from '../src/battle/loadout.ts';
import {handlers} from '../src/handlers.ts';
import {App} from '../src/app.ts';
const defaults=battleRules({});assert.equal(defaults.autoBalance,true);assert.equal(defaults.withoutGoldBoxes,false);
assert.throws(()=>battleRules({withoutMines:'false'}));assert.throws(()=>battleRules({reArmorEnabled:true}));assert.throws(()=>battleRules({equipmentConstraintsMode:'LIGHT'}));
assert.ok(equipmentAllowed({equipmentConstraintsMode:'WASP_RAILGUN'},'wasp','railgun'));assert.ok(!equipmentAllowed({equipmentConstraintsMode:'WASP_RAILGUN'},'hornet','railgun'));assert.ok(!equipmentAllowed({equipmentConstraintsMode:'HORNET_WASP_RAILGUN'},'wasp','smoky'));
const map:any={id:1,name:'test',modes:['tdm'],minRank:1,maxRank:30,maxPeople:20};
const registry=new BattleRegistry({} as any,[map]);const input={mapId:1,mode:'tdm',name:'test',minRank:1,maxRank:30,maxPeople:10,botCount:2,timeLimitSec:900,scoreLimit:10,withoutMines:true,privateBattle:true,friendlyFire:true};
const settings=registry.validate(input);assert.equal(settings.withoutMines,true);assert.equal(settings.privateBattle,true);assert.equal(settings.friendlyFire,true);assert.throws(()=>registry.validate({...input,equipmentConstraintsMode:'HORNET_RAILGUN'}));
const regions = ['armor', 'gold', 'crystal'].map((kind, i) => ({
  modes: ['tdm'], kinds: [kind], position: {x:i*1000,y:0,z:0},
  min: {x:i*1000-250,y:-250,z:0}, max: {x:i*1000+250,y:250,z:300},
}));
const b=new Battle({...settings,id:1} as any,{key:'test',bonusRegions:regions} as any,{} as any,()=>{},{} as any) as any;
let consumed=0;const events:any[]=[];b.broadcast=(type:string,data:any)=>events.push({type,...data});b.send=()=>{};b.roundActive=true;
const red:any={userId:1,team:0,state:'active',alive:true,life:1,position:{x:0,y:0,z:100},last:null,history:[],inventory:[{index:5,kind:'mine',itemId:50,count:4,readyAt:0,cooldownMs:1000}]};
const blue:any={...red,userId:2,team:1};b.players.set(1,red);b.players.set(2,blue);b.player=()=>red;b.hooks.consumeItem=()=>consumed++;b.dropMine=()=>{};
b.activateItem({},5);assert.equal(red.inventory[0].count,4);assert.equal(consumed,0,'disabled mines never consume stock');assert.equal(b.inventoryInfo(red.inventory[0]).count,0);
b.summary.withoutMines=false;b.summary.withoutSupplies=true;b.activateItem({},5);assert.equal(consumed,0);b.summary.withoutSupplies=false;b.activateItem({},5);assert.equal(consumed,1);assert.equal(red.inventory[0].count,3);
// Team selection and direct hit validation use the same stored settings.
b.summary.autoBalance=true;b.players.set(3,{...red,userId:3});assert.equal(b.pickTeam(4,0),1);b.summary.autoBalance=false;assert.equal(b.pickTeam(4,0),0);
const hit={userId:3,life:1,position:{x:0,y:0,z:100}};b.positionAt=()=>null;b.summary.friendlyFire=false;assert.equal(b.checkTarget(red,hit,0),null);b.summary.friendlyFire=true;assert.equal(b.checkTarget(red,hit,0).userId,3);b.playerInfo=()=>({});assert.equal(b.info().friendlyFire,true);
// Three independent switches: supply boxes, crystals and gold.
b.summary.withoutBonuses=true;b.summary.withoutGoldBoxes=true;b.summary.withoutCrystals=true;
for(const kind of ['armor','gold','crystal'])b.spawnBonus(kind);assert.equal(b.bonuses.size,0);
b.summary.withoutCrystals=false;b.spawnBonus('crystal');assert.equal(b.bonuses.size,1);b.summary.withoutGoldBoxes=false;b.spawnBonus('gold');assert.equal(b.bonuses.size,2);b.summary.withoutBonuses=false;b.spawnBonus('armor');assert.equal(b.bonuses.size,3);
const armor = [...b.bonuses.values()].find(bonus => bonus.kind === 'armor')!;
assert.ok(Math.hypot(armor.position.x, armor.position.y) <= 75);
b.spawnBonus('armor');assert.equal(b.bonuses.size,3,'occupied zone refuses another drop');
regions[0].kinds.push('crystal');
b.spawnBonus('crystal');assert.equal(b.bonuses.size,3,'occupied shared zone refuses another kind');
b.applyBonus=()=>{};
b.takeBonus({}, armor.id);
b.spawnBonus('armor');assert.equal(b.bonuses.size,3,'pickup frees the zone');
b.timings.numFundChangesForCrystalDrop = 2;
b.fundChangesSinceCrystal = 1;
b.bonusFundChanged();
assert.equal(b.pendingCrystalDrops, 1, 'all eligible zones occupied: keep the earned drop');
b.takeBonus({}, armor.id); // stale pickup cannot free a zone
assert.equal(b.pendingCrystalDrops, 1);
const crystal = [...b.bonuses.values()].find(bonus => bonus.kind === 'crystal')!;
b.takeBonus({}, crystal.id);
assert.equal(b.pendingCrystalDrops, 0, 'freeing a zone releases the pending drop without another fund change');
assert.equal(events.at(-1).bonus.zoneKey, crystal.zoneKey);
b.removeAllBonuses();
regions.push({
  modes: ['tdm'], kinds: ['med'], position: { x: 3000, y: 0, z: 0 },
  min: { x: 2750, y: -250, z: 0 }, max: { x: 3250, y: 250, z: 300 },
});
b.spawnBonus('armor');
b.spawnBonus('crystal');
b.spawnBonus('crystal');
assert.equal(events.at(-1).bonus.zoneKey, '3000:0:0', 'crystal falls in another free supply zone');
b.removeAllBonuses();
const archiveBattle = new Battle({...settings,id:2} as any,{key:'2042',bonusRegions:regions.slice(2)} as any,{} as any,()=>{},{} as any) as any;
archiveBattle.players.set(red.userId, red);
archiveBattle.broadcast = b.broadcast;
archiveBattle.applyBonus = () => {};
archiveBattle.player = () => red;
assert.equal(archiveBattle.spawnBonus('crystal'), true);
assert.equal(archiveBattle.spawnBonus('crystal'), false, '2042 keeps its free medkit zone reserved for medkits');
archiveBattle.pendingCrystalDrops = 1;
const archiveCrystal = [...archiveBattle.bonuses.values()][0];
archiveBattle.takeBonus({}, archiveCrystal.id);
assert.equal(archiveBattle.pendingCrystalDrops, 0, 'the pending crystal drops when its own zone is free');
assert.equal(events.at(-1).bonus.zoneKey, archiveCrystal.zoneKey);
const effectPlayer = { ...red, effects: new Map(), timers: new Set(), later: (ms: number, callback: () => void) => setTimeout(callback, ms) };
b.players.clear();
b.players.set(effectPlayer.userId, effectPlayer);
b.activateEffect(effectPlayer, 2, 1000);
assert.ok(b.effectsInfo()[0].leftMs <= 1000);
b.activateEffect(effectPlayer, 2, 2000);
assert.ok(b.effectsInfo()[0].leftMs > 1000, 'snapshot reports the refreshed effect duration');
b.endEffect(effectPlayer, 2);
assert.deepEqual(b.effectsInfo(), [], 'expired effects are absent from the snapshot');
// Real catalog: restrictions use hull resource paths, and no-upgrades restores base health/damage.
const catalog=new GarageCatalog('dev/configs'),items=[...catalog.items.values()];
const hull=items.find(i=>i.category==='armor'&&i.objectPath?.includes('/wasp/')&&i.modification===3)!;const gun=items.find(i=>i.category==='weapon'&&i.weapon?.kind==='railgun'&&i.modification===0)!;
assert.ok(hull&&gun);const owned=new Map([hull,gun].map(i=>[i.id,{count:1,levels:new Map(i.upgrades.map(u=>[u.propertyId,u.maxLevel]))}])) as any;
const upgraded=assembleLoadout([hull,gun],owned,[]),base=assembleLoadout([hull,gun],owned,[],true);assert.equal(base.hullKind,'wasp');assert.ok(base.maxHealth<upgraded.maxHealth);assert.ok(base.damageFrom<upgraded.damageFrom);assert.equal(base.maxHealth,Math.round(hull.battle.get('hull_armor')!.initial));
// Private battles are absent from list/events until a link is resolved, or admin access.
const publicBattle={id:1},privateBattle={id:2,privateBattle:true};const app:any={battles:{list:()=>[publicBattle,privateBattle],get:(id:number)=>id===2?privateBattle:publicBattle},watchLobby:()=>{},maps:[],config:{battleLimits:{}}};
const viewer:any={user:{admin:false},knownPrivateBattles:new Set(),send:(type:string,data:any)=>events.push({type,...data})};
assert.equal((await handlers['lobby.battles'](app,viewer,{})).battles.length,1);await handlers['lobby.getBattle'](app,viewer,{battleId:2});assert.equal((await handlers['lobby.battles'](app,viewer,{})).battles.length,2);
const stranger:any={...viewer,knownPrivateBattles:new Set(),send:()=>{throw Error('private broadcast leaked');}};App.prototype.broadcastLobby.call({lobbyWatchers:new Set([stranger])} as any,'lobby.battle',{battle:privateBattle} as any);
await assert.rejects(()=>handlers['lobby.create'](app,viewer,input));
console.log('Creation rules: validation, equipment, bot format, stock/cooldowns, teams, hits, independent bonus flags, real base stats and private links OK');

// Offline state/geometry checks: no connection, database or game client.
import assert from 'node:assert/strict';
import {CtfState,type FlagPlayer} from '../src/battle/ctf.ts';
import {parseFlagBases,loadMapData} from '../src/battle/mapData.ts';
import {loadMaps} from '../src/game/maps.ts';
const bases:[any,any]=[{x:0,y:0,z:0},{x:2000,y:0,z:0}];
const events:string[]=[],scores=[0,0];let blocked=false;
const state=new CtfState(bases,()=>!blocked,p=>({x:p.x,y:p.y,z:0}),(a)=>events.push(a),p=>scores[p.team]++);
const red:FlagPlayer={userId:1,team:0,state:'active',position:{x:2000,y:0,z:100},orientation:{x:0,y:0,z:0},loadout:{size:{x:155,y:255,z:100}}};
const blue:FlagPlayer={...red,userId:2,team:1,position:{x:0,y:0,z:100}};
blocked=true;state.step([red],0);assert.equal(state.flags[1].state,'base','wall protects flag from pickup');
blocked=false;red.state='spawned';state.step([red],1);assert.equal(state.flags[1].state,'base','ghost tanks cannot pick up flags');
red.state='active';state.step([red,blue],2);assert.equal(state.flags[0].carrierId,2);assert.equal(state.flags[1].carrierId,1);
red.position={x:0,y:0,z:100};blue.position={x:2000,y:0,z:100};state.step([red,blue],3);assert.deepEqual(scores,[0,0],'cannot capture with own flag missing');
state.drop(blue,4);assert.equal(state.flags[0].state,'dropped');
blue.position={x:1000,y:0,z:100};red.position={x:2000,y:0,z:100};state.step([red,blue],5);assert.equal(state.flags[0].state,'base','teammate returns dropped own flag');
red.position={x:0,y:0,z:100};state.step([red,blue],6);assert.deepEqual(scores,[1,0]);assert.equal(state.flags[1].state,'base');
red.position={x:2000,y:0,z:100};state.step([red],10);state.drop(red,11);state.step([red],12);assert.equal(state.flags[1].state,'dropped','F drop has 5s pickup lock');
state.step([red],5012);assert.equal(state.flags[1].carrierId,1,'pickup lock expires');
red.state='dead';state.step([red],5013);assert.equal(state.flags[1].state,'dropped','death drops flag');
state.step([],35014);assert.equal(state.flags[1].state,'base','unattended flag returns automatically');
const copy=state.snapshot();copy[0].base.x=999;assert.equal(state.flags[0].base.x,0,'late join snapshot does not alias state');
state.reset();assert.ok(state.flags.every(f=>f.state==='base'&&f.carrierId===null));
assert.equal(parseFlagBases('<map/>'),undefined);
const maps=loadMaps('dev/configs'),data=loadMapData('dev/configs');
for(const m of maps.filter(m=>m.modes.includes('ctf')))assert.ok(data.get(m.id)?.flagBases,`CTF map ${m.name} has original bases`);
assert.ok(maps.some(m=>m.modes.includes('ctf')));
console.log('CTF: pickup, cover, ghost state, own return, capture prerequisite, score, F lock, death, timeout, snapshots and original map bases OK');

// Actual Battle constructor wires capture to team score/limit, not kill count.
const {Battle}=await import('../src/battle/battle.ts');
const emitted:any[]=[];
const battle=new Battle({id:77,mode:'ctf',scoreLimit:1,timeLimitSec:0} as any,{flagBases:bases,key:'test'} as any,{} as any,()=>{},{} as any) as any;
let ended=false;battle.endRound=()=>{ended=true;};battle.broadcast=(type:string,value:any)=>emitted.push({type,...value});
red.state='active';red.position={x:2000,y:0,z:100};battle.ctf.step([red],1);red.position={x:0,y:0,z:100};battle.ctf.step([red],2);
assert.deepEqual(battle.teamScores,[1,0]);assert.ok(ended,'capture limit ends the CTF round');assert.ok(emitted.some(e=>e.type==='battle.flags'&&e.action==='captured'));assert.ok(emitted.some(e=>e.type==='battle.teamScore'));assert.equal(battle.teamMode,true);
console.log('CTF Battle integration: capture broadcasts, team score and round limit OK');

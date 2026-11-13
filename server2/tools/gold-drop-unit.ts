import assert from 'node:assert/strict';
import {Battle} from '../src/battle/battle.ts';
const notifications:any[]=[],drops:string[]=[],scheduled:{fn:()=>void,ms:number}[]=[];
const saved=globalThis.setTimeout;
globalThis.setTimeout=((fn:()=>void,ms:number)=>{scheduled.push({fn,ms});return 1;}) as any;
try{
const b=Object.create(Battle.prototype) as any;
Object.assign(b,{summary:{},roundActive:true,fund:100,fundChangesSinceGold:0,fundChangesSinceCrystal:0,goldTimers:new Set(),timings:{numFundChangesForCrystalDrop:10000,goldNotificationMessage:'gold'},broadcast:(name:string,args:any)=>{if(name==='battle.goldNotify')notifications.push(args);},spawnBonus:(kind:string)=>drops.push(kind)});
for(let i=0;i<9;i++)b.addFund(1);assert.equal(notifications.length,0);
b.addFund(1);assert.equal(notifications.length,1);assert.equal(notifications[0].delaySec,10);assert.equal(scheduled[0].ms,10000);assert.equal(drops.length,0);
scheduled[0].fn();assert.deepEqual(drops,['gold']);
b.addFund(0);b.addFund(-1);assert.equal(b.fundChangesSinceGold,0);
for(let i=0;i<10;i++)b.addFund(2);assert.equal(notifications.length,2);
console.log('Gold: every 10 positive fund changes, no early drop, 10s warning and zero/negative changes ignored OK');
}finally{globalThis.setTimeout=saved;}

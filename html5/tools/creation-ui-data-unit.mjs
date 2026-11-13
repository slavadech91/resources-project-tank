// Offline data contract checks; no DOM, game account or network.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {build}=createRequire(require.resolve('../node_modules/vite'))('esbuild');
import {GarageCatalog} from '../../server2/src/garage/catalog.ts';
import {S2Client} from '../src/net2/S2Client.ts';
const compiled=await build({entryPoints:['html5/src/ui/lobby/garageValues.ts'],bundle:true,write:false,format:'esm',platform:'node',loader:{'.css':'empty'}});
const {garageTable}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const catalog=new GarageCatalog('dev/configs');let changed=0,preservedFraction=0;
const rounded=new Set([1,40,41,45,52,55,58,62]);
for(const item of catalog.items.values()){
 if(item.category!=='weapon'&&item.category!=='armor')continue;
 const properties=item.upgrades.map(u=>({...u,values:item.values})),columns=properties.map(p=>p.propertyId);
 const original=garageTable([properties],columns)[0],current=garageTable([properties],columns,true)[0];
 for(let i=0;i<columns.length;i++){
  if(!current[i])continue;
  if(rounded.has(columns[i])){assert.match(current[i].text,/^\d+(?:-\d+)?$/);if(current[i].text!==original[i].text)changed++;}
  else{assert.equal(current[i].text,original[i].text,`${item.name} ${columns[i]} keeps precision`);if(current[i].text.includes('.'))preservedFraction++;}
 }
}
assert.ok(changed>0&&preservedFraction>0,'real catalog includes rounded damage/health and unchanged fractional stats');
let sent;const client=Object.create(S2Client.prototype);Object.assign(client,{battles:new Map(),connection:{request:async(type,data)=>{sent={type,data};return {battle:{...data,id:1}};}}});
const rules={autoBalance:false,friendlyFire:true,withoutBonuses:true,withoutCrystals:true,withoutSupplies:true,withoutMines:true,withoutMedkit:true,withoutGoldBoxes:true,withoutGoldSiren:true,withoutUpgrades:true,privateBattle:true,equipmentConstraintsMode:'WASP_RAILGUN'};
await client.createBattle({...rules,name:'Test',mode:1,mapId:1,maxPeople:10,botCount:3,timeLimit:600,scoreLimit:20,rankMin:1,rankMax:5,theme:0});
assert.equal(sent.type,'lobby.create');for(const [key,value]of Object.entries(rules))assert.equal(sent.data[key],value,key);assert.equal(sent.data.botCount,3);assert.equal(sent.data.mode,'tdm');assert.equal(sent.data.timeLimitSec,600);
console.log(`Garage: ${changed} damage/health values rounded, ${preservedFraction} other fractional values preserved; creation flags/bots survive client serialization OK`);

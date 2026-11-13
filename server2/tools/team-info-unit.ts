// Offline lobby mapping, no connection or account access.
import assert from 'node:assert/strict';
import {S2Client} from '../../html5/src/net2/S2Client.ts';
import {BattleRooms} from '../src/battle/rooms.ts';
import {Battle} from '../src/battle/battle.ts';
const battle:any={id:1,name:'Test',mode:'ctf',mapId:1,mapName:'Test',maxPeople:10,scoreLimit:5,timeLimitSec:900,minRank:1,maxRank:30,teamScores:[2,3],users:[{userId:7,kills:4,score:40,team:0},{userId:8,kills:5,team:1}]};
const client=Object.create(S2Client.prototype) as any;client.maps=[];client.battles=new Map([[1,battle]]);
const info=client.battleInfo(1);assert.equal(info.maxPeople,5,'team slots use half the battle capacity');assert.deepEqual(info.teamScores,[2,3]);assert.equal(info.reds[0].userId,7);assert.equal(info.reds[0].score,40);assert.equal(info.blues[0].userId,8);
battle.mode='dm';const dm=client.battleInfo(1);assert.equal(dm.maxPeople,10);assert.equal(dm.users.length,2);assert.equal(dm.reds.length,0);
const live=Object.create(Battle.prototype) as any;live.teamScores=[4,1];const copy=live.getTeamScores();copy[0]=99;assert.deepEqual(live.teamScores,[4,1]);
const events:any[]=[];const rooms=Object.create(BattleRooms.prototype) as any;rooms.app={battles:{get:()=>battle},broadcastLobby:(type:string,data:any)=>events.push({type,data})};
rooms.playersChanged({summary:battle,getTeamScores:()=>[4,1],counts:()=>[2,3],userSummaries:()=>[]});assert.deepEqual(battle.teamScores,[4,1]);assert.equal(events[0].type,'lobby.battle');
console.log('Team Battle Info: per-team capacity, DM capacity retained, red/blue mapping and live lobby scores OK');

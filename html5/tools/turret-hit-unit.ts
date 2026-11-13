// Real exported models + physics raycasts, no browser/network/second player.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {Tank} from '../src/tanks/tank/Tank.ts';
import {TurretController} from '../src/tanks/tank/Controllers.ts';
import {Vector3} from '../src/physics/math/Vector3.ts';
import {CollisionGroup} from '../src/tanks/physics/TankBody.ts';
import {TanksCollisionDetector} from '../src/tanks/physics/TanksCollisionDetector.ts';
import {RayHit} from '../src/physics/collision/types.ts';
import {turretHitGeometry} from '../src/tanks/tank/TurretHitGeometry.ts';
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const hull=read('html5/public/tank_parts/hulls/wasp/m3/part.json');
const h=hull.objects.find((o:any)=>o.name==='hull'),v=h.positions;
const bounds={minX:Math.min(...v.filter((_v:number,i:number)=>i%3===0)),maxX:Math.max(...v.filter((_v:number,i:number)=>i%3===0)),minY:Math.min(...v.filter((_v:number,i:number)=>i%3===1)),maxY:Math.max(...v.filter((_v:number,i:number)=>i%3===1)),minZ:Math.min(...v.filter((_v:number,i:number)=>i%3===2)),maxZ:Math.max(...v.filter((_v:number,i:number)=>i%3===2))};
const mount=hull.objects.find((o:any)=>/^mount/i.test(o.name)).position;
let count=0;
for(const kind of readdirSync('html5/public/tank_parts/turrets'))for(let mod=0;mod<4;mod++){
  const path=`html5/public/tank_parts/turrets/${kind}/m${mod}/part.json`;if(!existsSync(path))continue;
  const part=read(path),boxes=turretHitGeometry(part.objects);assert.ok(boxes.length,`${kind} M${mod} has hit geometry`);
  const explicit=part.objects.filter((o:any)=>/box.*/i.test(o.name)&&o.positions?.length);
  if(explicit.length)assert.equal(boxes.length,explicit.length,'service boxes take precedence over full mesh');
  const skin={hull:{bounds,turretMountPoint:new Vector3(...mount)},turret:{part,muzzles:[new Vector3()]}} as any;
  const turret=new TurretController(1,1,false),tank=new Tank(1000,1,skin,turret,{init:()=>{},reset:()=>{}});
  const body=tank.getBody(),detector=new TanksCollisionDetector();detector.buildKdTree([]);detector.addTankBody(tank.tankBody);
  body.state.position.reset(1000,2000,300);tank.setBodyCollisionGroup(CollisionGroup.WEAPON|CollisionGroup.TANK);
  for(const angle of [0,Math.PI/2,Math.PI]){
    (tank as any).updateTurretPhysics(angle);body.calcDerivedData();
    const box=tank.turretCollisions.reduce((a,b)=>a.transform.l+a.hs.z>b.transform.l+b.hs.z?a:b);
    const point=new Vector3();box.transform.transformVector(new Vector3(0,0,box.hs.z*.7),point);
    const origin=new Vector3(point.x-1000,point.y,point.z),hit=new RayHit();
    assert.ok(detector.raycast(origin,new Vector3(1,0,0),CollisionGroup.WEAPON,2000,null,hit),`${kind} M${mod}: turret ray at ${angle}`);
    assert.ok(tank.turretCollisions.includes(hit.shape as any),`${kind} M${mod}: hit turret above hull`);
    tank.setBodyCollisionGroup(CollisionGroup.TANK);assert.equal(detector.raycast(origin,new Vector3(1,0,0),CollisionGroup.WEAPON,2000,null,new RayHit()),false,'spawn ghost is not a weapon target');
    tank.setBodyCollisionGroup(CollisionGroup.WEAPON|CollisionGroup.TANK);
    assert.ok(tank.turretCollisions.every(b=>b.collisionGroup===CollisionGroup.WEAPON),'turret does not collide with hulls/tracks/static');
  }
  count++;
}
console.log(`Turret hits: ${count} real M0–M3 models, explicit/fallback geometry, three turret angles, body broad phase, ghost exclusion and weapon-only masks OK`);

// Offline rigid boxes only. No game clients, accounts, opponent or server.
import assert from 'node:assert/strict';
import { Body } from '../src/physics/Body.ts';
import { PhysicsScene } from '../src/physics/PhysicsScene.ts';
import { CollisionBox } from '../src/physics/collision/CollisionShape.ts';
import { PhysicsMaterial } from '../src/physics/collision/types.ts';
import { Matrix3 } from '../src/physics/math/Matrix3.ts';
import { Vector3 } from '../src/physics/math/Vector3.ts';
import { TankBody } from '../src/tanks/physics/TankBody.ts';
import { TanksCollisionDetector } from '../src/tanks/physics/TanksCollisionDetector.ts';
import { RemoteBodyReconciler } from '../src/tanks/net/sync/RemoteBodyReconciler.ts';
import { InterpolatedState } from '../src/tanks/net/sync/StateBuffer.ts';
import { RemoteTank } from '../src/tanks/net/RemoteTank.ts';

function impact(mass1:number,mass2:number,speed:number){
  const scene=new PhysicsScene(),detector=new TanksCollisionDetector();
  scene.gravity.reset();scene.allowedPenetration=5;scene.collisionDetector=detector;detector.buildKdTree([]);
  function box(mass:number,x:number){
    const inertia=new Matrix3();inertia.a=inertia.f=inertia.k=0;
    const body=new Body(mass,inertia,100000);body.state.position.x=x;
    const wrapper=new TankBody(body);
    const shape=new CollisionBox(new Vector3(50,50,50),1,new PhysicsMaterial(0,0.2));
    body.addCollisionShape(shape);wrapper.tankCollisionBox=shape;
    scene.addBody(body);detector.addTankBody(wrapper);return wrapper;
  }
  const a=box(mass1,-49),b=box(mass2,49);a.body.state.velocity.x=speed;
  scene.update(33);
  const expected=mass1*speed/(mass1+mass2)*Body.linDamping;
  assert.ok(Math.abs(a.body.state.velocity.x-expected)<1e-6,JSON.stringify({mass1,mass2,speed,expected,a:a.body.state.velocity,b:b.body.state.velocity,contacts:b.hasTankContacts}));
  assert.ok(Math.abs(b.body.state.velocity.x-expected)<1e-6,'finite mass body receives its share of momentum');
  assert.equal(a.body.state.velocity.z,0);assert.equal(b.body.state.velocity.z,0,'horizontal contact creates no vertical launch');
  assert.equal(b.hasTankContacts,true);
  return {a,b,scene,expected};
}
for(const speed of [100,800,1500]){impact(1000,1000,speed);impact(1000,3000,speed);}

const {b,scene}=impact(1000,1000,800),body=b.body;
const target=new InterpolatedState();target.position.x=49;
const reconciler=new RemoteBodyReconciler();
const remote=Object.create(RemoteTank.prototype) as any;
Object.assign(remote,{networkDriven:true,hasOutput:true,raw:target,hold:new InterpolatedState(),reconciliation:reconciler,
  buffer:{sample:()=>true},renderTime:(t:number)=>t,runner:{getPhysicsScene:()=>scene},
  turretController:{setDirectionImmediate:()=>{},applyControlState:()=>{}},chassisController:{setControlState:()=>{}},
  tank:{tankBody:b,getBody:()=>body,runBeforePhysicsUpdate:()=>{},runAfterPhysicsUpdate:()=>{}}});
remote.setNetworkDriven(true);
assert.equal(body.movable,true);assert.equal(body.kinematic,false,'remote body uses finite physical mass');
const position=body.state.position.clone(),velocity=body.state.velocity.clone();
remote.runBeforePhysicsUpdate(0.033);remote.runAfterPhysicsUpdate(0.033);
assert.deepEqual(body.state.position,position,'snapshots do not pull a contacting body back');
assert.deepEqual(body.state.velocity,velocity,'contact impulse survives remote pre/post-physics callbacks');
for(let i=0;i<8;i++){
  remote.runBeforePhysicsUpdate(0.033);scene.update(33);remote.runAfterPhysicsUpdate(0.033);
  assert.ok(body.state.position.x>=position.x,'sustained pushing does not reset the pushed body to the old snapshot');
  assert.ok(Number.isFinite(body.state.position.x));
}
const free=new Body(1000,new Matrix3(),10000);free.state.position.x=100;
const raw=new InterpolatedState();
reconciler.reconcile(free,raw,0.033,false);
assert.ok(free.state.position.x>0&&free.state.position.x<100,'outside contacts the body converges smoothly to authority');
const pushedBot=new Body(1100,new Matrix3(),10000);pushedBot.state.position.x=1800;
pushedBot.state.velocity.x=800;
reconciler.reconcile(pushedBot,raw,0.033,true,false,true);
assert.equal(pushedBot.state.velocity.x,800,'bot contact impulses are retained');
assert.ok(pushedBot.state.position.x>=1800-120*0.033-1e-6,'bot correction during contact is capped');
const contactedX=pushedBot.state.position.x;
reconciler.reconcile(pushedBot,raw,0.033,false,false,true);
assert.ok(pushedBot.state.position.x>=contactedX-400*0.033-1e-6,'large bot prediction error recovers at bounded speed instead of teleporting');
reconciler.reconcile(pushedBot,raw,0.033,false,true,true);
assert.equal(pushedBot.state.position.x,0,'explicit new-life initialization still places bot exactly');
console.log('Contacts: equal/unequal masses, momentum at 100/800/1500cm/s, no vertical impulse, retained pushing and smooth network recovery OK');

import assert from 'node:assert/strict';
import {Vector3} from '../src/physics/math/Vector3.ts';
import {LocalTurretController} from '../src/tanks/tank/Controllers.ts';
import {FollowCameraController,followCamera,CAMERA_FOLLOWS_MOUSE} from '../src/tanks/camera/FollowCameraController.ts';
const keyboard={addListener:()=>{}};
function setup(){
  followCamera.mode=CAMERA_FOLLOWS_MOUSE;followCamera.direction=0;
  const camera={position:new Vector3(),rotation:new Vector3()};
  const controller=new FollowCameraController(camera,{raycastStatic:()=>false} as any,keyboard as any);
  let x=0;
  controller.setTarget({getCameraParams:(p,d)=>{p.reset(x,0,100);d.reset(-Math.sin(followCamera.direction),Math.cos(followCamera.direction),0);}});
  controller.setTargetParams(new Vector3(0,0,100),new Vector3(0,1,0));
  return {camera,controller,move:(value:number)=>x=value};
}
function run(events:number[],dt:number){
  const {camera,controller}=setup();
  const turret=new LocalTurretController(1,2,keyboard as any);turret.onAddToBattle();
  for(const dx of events){
    const before=followCamera.direction;turret.onMouseRelativeMovement(dx,0);
    const d=followCamera.direction-before;
    controller.onMouseRelativeMovement(dx,0,Math.atan2(Math.sin(d),Math.cos(d)));
  }
  controller.update(dt);
  assert.ok(Math.abs(camera.rotation.z-followCamera.direction)<1e-10,'fresh mouse input has no dead zone or chase delay');
  return camera.rotation.z;
}
assert.ok(Math.abs(run([100],1000/30)-run(Array(100).fill(1),1000/144))<1e-10);
run([1],1000/60);
const motion=setup();motion.move(1000);motion.controller.update(1000/60);
assert.ok(motion.camera.position.x>0&&motion.camera.position.x<1000,'tank translation retains the camera spring');
const turn=setup();followCamera.direction=1;turn.controller.update(1000/60);
assert.ok(turn.camera.rotation.z>0&&turn.camera.rotation.z<1,'non-input direction change retains follow behaviour');
console.log('Mouse: direct small input and equal sensitivity at 30/144 FPS; tank translation and non-input turning keep camera damping OK');

// Steady lateral motion: Narukami cam_maxmove=5, maxPositionError=10.
for(const fps of [30,60,144]){
  const lateral=setup(),dt=1/fps,speed=1000;
  for(let frame=1;frame<=fps*5;frame++){lateral.move(speed*frame*dt);lateral.controller.update(dt*1000);}
  const lag=speed*5-lateral.camera.position.x;
  const expected=10+speed/5-speed*dt;
  assert.ok(Math.abs(lag-expected)<0.01,`lateral following at ${fps}FPS: ${lag} vs ${expected}`);
}
console.log('Camera: steady lateral lag matches Narukami coefficient 5 at 30/60/144FPS OK');

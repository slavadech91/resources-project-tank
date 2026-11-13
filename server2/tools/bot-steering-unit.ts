import assert from 'node:assert/strict';
import { botSteering } from '../src/battle/botSteering.ts';
const position={x:0,y:0,z:0};
assert.equal(botSteering(position,0,1,null,3).control,0,'no route means no arbitrary hull turning');
assert.equal(botSteering(position,0,0,{x:0,y:1000,z:0},3).control,1,'straight path keeps forward drive');
const angle=0.1,goal={x:-Math.sin(angle)*1000,y:Math.cos(angle)*1000,z:0};
assert.equal(botSteering(position,0,1,goal,3).control,1,'brake rotation before overshooting, without counter-steering');
assert.ok(botSteering(position,0,0,{x:-1000,y:0,z:0},3).control&4,'large heading error still permits a necessary turn');
for(const desired of [-1.2,-0.2,0.2,1.2]){
  const goal={x:-Math.sin(desired)*1000,y:Math.cos(desired)*1000,z:0};
  let yaw=0,speed=0,reversals=0,last=0;
  for(let i=0;i<200;i++){
    const control=botSteering(position,yaw,speed,goal,3).control;
    const direction=control&4?1:control&8?-1:0;
    if(direction&&last&&direction!==last)reversals++;
    if(direction)last=direction;
    const target=direction*1.3,delta=Math.max(-3*0.033,Math.min(3*0.033,target-speed));
    speed+=delta;yaw+=speed*0.033;
  }
  assert.ok(Math.abs(yaw-desired)<0.12,'settles within heading tolerance');
  assert.ok(reversals<=1,'does not alternate endlessly left and right');
}
console.log('Bot steering: independent hull rest, continuous forward drive, stopping-angle braking and bounded reversals OK');

import type { Vec3 } from '../../../html5/src/net2/protocol.ts';

/** Continuous chassis steering; turret aiming is deliberately independent. */
export function botSteering(position:Vec3,yaw:number,yawSpeed:number,goal:Vec3|null,turnAcceleration:number):{control:number;speed:number}{
  if(!goal)return {control:0,speed:1};
  const desired=Math.atan2(-(goal.x-position.x),goal.y-position.y);
  const error=Math.atan2(Math.sin(desired-yaw),Math.cos(desired-yaw));
  const stoppingAngle=yawSpeed*yawSpeed/(2*Math.max(0.1,turnAcceleration));
  const braking=yawSpeed*error>0&&Math.abs(error)<=stoppingAngle+0.04;
  const turn=!braking&&Math.abs(error)>0.09?(error>0?4:8):0;
  const move=Math.abs(error)<1.15?1:0;
  return {control:move|turn,speed:Math.max(0.3,1-Math.abs(error)/1.6)};
}

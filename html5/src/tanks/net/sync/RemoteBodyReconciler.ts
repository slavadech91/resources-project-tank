import type { Body } from '../../../physics/Body.ts';
import { CORRECTION_TAU, SNAP_DISTANCE } from './PoseCorrection.ts';
import type { InterpolatedState } from './StateBuffer.ts';

/** Network reconciliation around a dynamic body. Never replace a contact solver's result after a step. */
export class RemoteBodyReconciler {
  magnitude=0;
  lastJump=0;
  reconcile(body:Body,target:InterpolatedState,dt:number,contact:boolean,initialize=false,serverBot=false):void{
    const state=body.state;
    this.magnitude=state.position.clone().subtract(target.position).length();
    this.lastJump=this.magnitude;
    // A new life/teleport is explicit. During tank contacts, retain the full physical response,
    // including momentum and displacement; pulling toward an old snapshot fights pushing.
    const snap=initialize||(!serverBot&&!contact&&this.magnitude>SNAP_DISTANCE);
    if(contact&&!snap&&!serverBot)return;
    // Bot authority has no implicit teleports within a life. After a local push,
    // recover continuously rather than snapping a >10m accumulated prediction error.
    let weight=snap?1:1-Math.exp(-dt/(serverBot?0.15:CORRECTION_TAU));
    if(serverBot&&!snap&&this.magnitude>0)weight=Math.min(weight,(contact?120:400)*dt/this.magnitude);
    state.position.scale(1-weight).addScaled(weight,target.position);
    state.orientation.slerp(state.orientation.clone(),target.orientation,weight).normalize();
    if(!contact||snap){
      state.velocity.scale(1-weight).addScaled(weight,target.velocity);
      state.rotation.scale(1-weight).addScaled(weight,target.angularVelocity);
    }
  }
}

/** ProTanki tankpreview: sample manual rotation per rendered frame, then exp(-1.5t) deceleration. */
export class GarageRotation {
 angle=-150*Math.PI/180;
 speed=0;
 private state:'idle'|'manual'|'decelerate'|'auto'='idle';
 private stateTime=0;
 private lastTime=0;
 private startX=0;
 private mouseX=0;
 private startAngle=0;
 private width=1;
 private samples:[{time:number;angle:number},{time:number;angle:number}]=[{time:0,angle:0},{time:0,angle:0}];
 resetClock(now:number):void{this.lastTime=now;this.stateTime=now;}
 begin(x:number,width:number,now:number):void{this.startX=this.mouseX=x;this.width=Math.max(1,width);this.startAngle=this.angle;this.state='manual';this.samples=[{time:now,angle:this.angle},{time:now,angle:this.angle}];this.lastTime=now;}
 move(x:number):void{this.mouseX=x;}
 private manualAngle():number{return this.startAngle+(this.startX-this.mouseX)*2*Math.PI/this.width;}
 end(x:number,now:number):void{if(this.state!=='manual')return;this.mouseX=x;this.angle=this.manualAngle();const previous=this.samples[1];const seconds=(now-previous.time)/1000||.1;this.speed=(this.angle-previous.angle)/seconds;this.state='decelerate';this.lastTime=now;}
 cancel(now:number):void{this.state='idle';this.speed=0;this.resetClock(now);}
 update(now:number):void{
  const dt=Math.max(0,Math.min(.2,(now-this.lastTime)/1000));this.lastTime=now;
  if(this.state==='manual'){this.angle=this.manualAngle();this.samples=[{time:now,angle:this.angle},this.samples[0]];return;}
  if(this.state==='idle'&&now-this.stateTime>=10000){this.state='auto';this.speed=0;}
  if(this.state==='auto'){this.speed=Math.min(5*Math.PI/180,this.speed+5*Math.PI/180*dt);this.angle+=this.speed*dt;}
  else if(this.state==='decelerate'){this.angle+=this.speed*dt;if(Math.abs(this.speed)>.02)this.speed*=Math.exp(-1.5*dt);else{this.speed=0;this.state='idle';this.stateTime=now;}}
 }
}

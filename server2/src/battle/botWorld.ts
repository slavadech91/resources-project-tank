import { chooseBotTask, type BotTask } from './botTactics.ts';
import { botSteering } from './botSteering.ts';
import { BattleRunner } from '../../../html5/src/tanks/BattleRunner.ts';
import { Tank } from '../../../html5/src/tanks/tank/Tank.ts';
import { ChassisController, TankControlLockBits, TurretController, TurretControlType } from '../../../html5/src/tanks/tank/Controllers.ts';
import type { TankSkin } from '../../../html5/src/tanks/render/TankSkin.ts';
import { Body } from '../../../html5/src/physics/Body.ts';
import { TankBody, CollisionGroup } from '../../../html5/src/tanks/physics/TankBody.ts';
import { createTankCollisionBox } from '../../../html5/src/tanks/tank/CollisionBoxesBuilder.ts';
import { SuspensionParams,TankConst } from '../../../html5/src/tanks/tank/Suspension.ts';
import { RayHit } from '../../../html5/src/physics/collision/types.ts';
import { Matrix3 } from '../../../html5/src/physics/math/Matrix3.ts';
import { Matrix4 } from '../../../html5/src/physics/math/Matrix4.ts';
import { Vector3 } from '../../../html5/src/physics/math/Vector3.ts';
import { parseCollisionGeometry } from '../../../html5/src/tanks/map/CollisionGeometryParser.ts';
import { AllGlobalGunParams, calculateMainGunParams, WEAPON_FORCE_SCALE } from '../../../html5/src/tanks/weapon/SmokyWeapon.ts';
import type { ServerMap } from '../../../html5/src/map/types.ts';
import type { SyncSample } from '../../../html5/src/tanks/net/sync/SyncProtocol.ts';
import type { Vec3, BattleTeam, TankState, BonusInfo, CtfFlag } from '../../../html5/src/net2/protocol.ts';
import { parseCollisionXml } from './collision.ts';
import { BotNavigation, type NavNode, type DropPlan } from './botNavigation.ts';
import type { BotEquipment, BotProfile } from './botProfile.ts';
import type { Loadout } from './loadout.ts';
import type { MapData, SpawnPoint } from './mapData.ts';

export interface BotParticipant {
  id:number;team:BattleTeam;state:TankState;life:number;health:number;position:Vec3|null;orientation:Vec3|null;
  sample:SyncSample|null;loadout:Loadout;speedFactor:number;shotAt?:number;
}
interface EnemyMemory {id:number;position:Vec3;aim:Vec3;seenAt:number}
interface CoverPlan {cover:NavNode;peek:NavNode|null}
interface BotSupply {id:number;kind:string;position:Vec3}
interface BotState {
  objective?:string; objectiveGoal?:Vec3; blockedSince?:number; unsupportedSince?:number; goldId?:number;
  pass?:{allyId:number;until:number;goal:Vec3|null};
  yielding?:{allyId:number;until:number};
  streamLostAt?:number; overturnedAt?:number; suicideRequested?:boolean;
  railTarget?:{id:number;point:Vec3};
  profile:BotProfile;gun:BotEquipment['gun'];barrel:number;streaming:boolean;
  safeCache:{at:number;position:Vec3;yaw:number;input:number;goal:Vec3|null;allowed:number}|null;
  tank:Tank;turret:TurretController;chassis:ChassisController;life:number;seq:number;control:number;
  path:NavNode[];decisionAt:number;pauseUntil:number;reverseUntil:number;nextShot:number;chargingUntil:number;target:number|null;reactionAt:number;
  progress:Vector3;progressYaw:number;progressAt:number;planAt:number;holdUntil:number;destination:Vec3|null;
  hitFocus:{id:number;until:number}|null;
  patrolHistory:Vec3[];
  task:BotTask;taskUntil:number;memory:EnemyMemory|null;lastHealth:number;fearUntil:number;
  cover:CoverPlan|null;bonusId:number|null;scanAt:number;scanAngle:number;justFired:boolean;
  lastEnemyShot:number;evadeAt:number;drop:DropPlan|null;dropUntil:number;dropCheckAt:number;
}
export interface BotHit {id:number;local:Vec3;world:Vec3}
interface BotProjectile {id:number;shooter:number;position:Vector3;direction:Vector3;speed:number;remaining:number;bounces:number;ricochet:boolean}
function wrap(a:number):number{return Math.atan2(Math.sin(a),Math.cos(a));}
function vector(p:Vec3):Vector3{return new Vector3(p.x,p.y,p.z);}
function xyz(p:Vector3):Vec3{return {x:p.x,y:p.y,z:p.z};}

/** Browser-free instance of the client's tank/chassis/suspension and fixed 33ms solver. */
export class BotWorld {
  private readonly runner:BattleRunner;
  readonly navigation:BotNavigation;
  private readonly bots=new Map<number,BotState>();
  private readonly humans=new Map<number,TankBody>();
  private readonly hit=new RayHit();
  private readonly gun=new AllGlobalGunParams();
  private planningBudget=1;
  private readonly supplies=new Map<number,BotSupply>();
  private readonly supplyCache=new Map<number,{position:Vec3;fallMs:number}>();
  private readonly gold=new Map<number,BotSupply>();
  private readonly projectiles:BotProjectile[]=[];
  private teams=new Map<BattleTeam,BotParticipant[]>();
  constructor(map:MapData,private profile:BotProfile,
    private publish:(id:number,sample:SyncSample)=>void,
    private shoot:(id:number,hit:Vec3|null,targets:BotHit[],shot:{origin:Vec3;direction:Vec3;barrel:number;aimed:boolean})=>void,
    private random:()=>number=Math.random,
    private takeSupply:(id:number,bonusId:number)=>void=()=>{},
    private charge:(id:number)=>void=()=>{},
    private stream:(id:number,active:boolean)=>void=()=>{},
    private projectileHit:(shooter:number,id:number,hit:BotHit,bounces:number)=>void=()=>{},
    private lost:(id:number)=>void=()=>{},
    private suicide:(id:number)=>void=()=>{}){
    this.runner=new BattleRunner(map.gravity??1000);
    this.runner.buildStaticGeometry(parseCollisionGeometry({...parseCollisionXml(map.xml),spawns:[],bonusRegions:[]} as unknown as ServerMap));
    this.navigation=new BotNavigation(this.runner.getCollisionDetector(),map,(profile.bounds.maxX-profile.bounds.minX)/2+10);
  }
  spawn(id:number,life:number,point:SpawnPoint,gun:BotEquipment['gun']=this.profile,p=this.profile):void{
    this.remove(id);
    const hullMatrix=new Matrix4(),turretMatrix=new Matrix4();
    const mount=new Vector3(...p.mount);
    const muzzles = [new Vector3(...gun.muzzle)];
    if (gun.secondMuzzle) muzzles.push(new Vector3(...gun.secondMuzzle));
    const skin={hull:{bounds:p.bounds,turretMountPoint:mount},turret:{muzzles},turretMatrix,
      setAlpha:()=>{},updateTracks:()=>{},updateHullTransform:(m:Matrix4)=>hullMatrix.copy(m),
      updateTurretTransform:(angle:number)=>turretMatrix.setMatrix(mount.x,mount.y,mount.z+1,0,0,angle).append(hullMatrix)} as unknown as TankSkin;
    const turret=new TurretController(gun.turret.turretRotationSpeed,gun.turret.turretRotationAcceleration,false);
    const tank=new Tank(p.hull.mass,p.hull.damping,skin,turret,{init:()=>{},reset:()=>{}});
    tank.maxHealth=p.hull.armor;tank.health=p.hull.armor;
    tank.setMaxSpeed(p.hull.speed*100,true);tank.setMaxTurnSpeed(p.hull.turnSpeed,true);
    tank.setAcceleration(p.hull.acceleration*100);tank.setReverseAcceleration(p.hull.reverseAcceleration*100);
    tank.setSideAcceleration(p.hull.sideAcceleration*100);tank.setTurnAcceleration(p.hull.turnAcceleration);
    tank.setReverseTurnAcceleration(p.hull.reverseTurnAcceleration);
    tank.spawn();tank.setSemiActivatedState();
    tank.setPhysicsState(vector(point.position),vector(point.orientation),new Vector3(),new Vector3());
    const chassis=new ChassisController(tank);chassis.unlock(TankControlLockBits.DEAD);
    this.runner.addBodyWrapper(tank.tankBody);this.runner.addPhysicsController(tank);this.runner.addPostPhysicsController(tank);
    this.bots.set(id,{profile:p,gun,barrel:0,streaming:false,safeCache:null,tank,turret,chassis,life,seq:0,control:0,path:[],decisionAt:0,pauseUntil:0,reverseUntil:0,nextShot:0,chargingUntil:0,target:null,reactionAt:0,progress:vector(point.position),progressYaw:point.orientation.z,progressAt:0,planAt:0,holdUntil:0,destination:null,hitFocus:null,patrolHistory:[],task:'patrol',taskUntil:0,memory:null,lastHealth:p.hull.armor,fearUntil:0,cover:null,bonusId:null,scanAt:0,scanAngle:point.orientation.z,justFired:false,lastEnemyShot:-Infinity,evadeAt:0,drop:null,dropUntil:0,dropCheckAt:0});
    tank.interpolatePhysicsState(1);tank.render();
  }
  /** One roll per damaging hit; capture the attacker's position now, never track it through walls. */
  hitBy(id:number,attacker:Pick<BotParticipant,'id'|'team'|'position'|'state'|'health'>,now:number):boolean{
    const b=this.bots.get(id);
    if(!b||attacker.id===id||!attacker.position||attacker.state!=='active'||attacker.health<=0||this.random()>=0.75)return false;
    const position={...attacker.position};
    b.memory={id:attacker.id,position,aim:{...position,z:position.z+30},seenAt:now};
    b.hitFocus={id:attacker.id,until:now+12000};b.target=attacker.id;
    if(!b.streaming)b.reactionAt=now+160+this.random()*220;
    b.taskUntil=now;b.decisionAt=0;
    return true;
  }
  canActivate(id:number):boolean{return (this.bots.get(id)?.tank.getCollisionCount()??0)===0;}
  streamDepleted(id:number,rechargeMs:number):void{
    const bot=this.bots.get(id);
    if(!bot)return;
    bot.streaming=false;
    bot.streamLostAt=undefined;
    bot.nextShot=Date.now()+rechargeMs;
  }
  remove(id:number):void{
    const b=this.bots.get(id);if(!b)return;
    this.runner.removeBodyWrapper(b.tank.tankBody);this.runner.removePhysicsController(b.tank);this.runner.removePostPhysicsController(b.tank);this.bots.delete(id);
    for(let i=this.projectiles.length-1;i>=0;i--)if(this.projectiles[i].shooter===id)this.projectiles.splice(i,1);
  }
  launchProjectile(shooter:number,id:number,origin:Vec3,direction:Vec3,speed:number,range:number,ricochet:boolean):void{
    if(speed>0&&range>0)this.projectiles.push({id,shooter,position:vector(origin),direction:vector(direction).normalize(),speed:speed*100,remaining:range*100,bounces:0,ricochet});
  }
  private stepProjectiles():void{
    const detector=this.runner.getCollisionDetector();
    const impacts:{shot:BotProjectile;hit:BotHit}[]=[];
    for(let i=this.projectiles.length-1;i>=0;i--){
      const shot=this.projectiles[i];
      let travel=Math.min(shot.remaining,shot.speed*0.033);
      while(travel>0.01&&shot.remaining>0&&shot.bounces<8){
        const shooter=this.bots.get(shot.shooter)?.tank.getBody();
        const filter={considerBody:(body:Body)=>shot.bounces>0||body!==shooter};
        if(!detector.raycast(shot.position,shot.direction,CollisionGroup.WEAPON,travel,filter,this.hit)){
          shot.position.addScaled(travel,shot.direction);shot.remaining-=travel;break;
        }
        const body=this.hit.shape?.body;
        const id=(body?.data as {botUserId?:number}|null)?.botUserId;
        if(body&&id!=null){
          const local=this.hit.position.clone().subtract(body.state.position).transformTransposed3(body.baseMatrix);
          shot.remaining=0;
          impacts.push({shot,hit:{id,local:xyz(local),world:xyz(this.hit.position)}});
          break;
        }
        if(!shot.ricochet){shot.remaining=0;break;}
        const distance=Math.max(1,this.hit.t);
        travel-=distance;shot.remaining-=distance;shot.bounces++;
        const normal=this.hit.normal;
        shot.direction.addScaled(-2*shot.direction.dot(normal),normal).normalize();
        shot.position.copy(this.hit.position).addScaled(1,shot.direction);
      }
      if(shot.remaining<=0||shot.bounces>=8)this.projectiles.splice(i,1);
    }
    for(const {shot,hit} of impacts)this.projectileHit(shot.shooter,shot.id,hit,shot.bounces);
  }
  clear():void{
    for(const id of this.bots.keys())this.remove(id);
    for(const body of this.humans.values())this.runner.removeBodyWrapper(body);
    this.humans.clear();this.supplies.clear();this.supplyCache.clear();this.gold.clear();
  }
  private synchronizeHumans(players:BotParticipant[],sampleTime:number):void{
    const alive=new Set<number>();
    for(const p of players){
      if(this.bots.has(p.id)||p.state!=='active'||!p.position)continue;
      alive.add(p.id);let wrapper=this.humans.get(p.id);
      if(!wrapper){
        const mass=p.loadout.mass??1500,size=this.profile.collisionSizes?.[String(p.loadout.parts.hull)]??p.loadout.size;
        const inertia=new Matrix3();inertia.a=12/(mass*(size.y**2+size.z**2));inertia.f=12/(mass*(size.x**2+size.z**2));inertia.k=12/(mass*(size.x**2+size.y**2));
        const body=new Body(mass,inertia,0);body.kinematic=true;wrapper=new TankBody(body);
        const half=new Vector3(size.x/2,size.y/2,size.z/2);
        const height=size.z-(new SuspensionParams().nominalRayLength-TankConst.TRACK_RAY_Z_OFFSET);
        createTankCollisionBox(half,height,wrapper);
        wrapper.tankCollisionBox.collisionGroup=CollisionGroup.TANK|CollisionGroup.WEAPON;
        this.humans.set(p.id,wrapper);this.runner.addBodyWrapper(wrapper);
      }
      const body=wrapper.body,s=p.sample;
      body.data={botUserId:p.id};body.state.position.copy(vector(p.position));
      if(s){const age=Math.max(0,Math.min(100,sampleTime-s.sampleTime))/1000;body.state.position.add(new Vector3(s.vx*age,s.vy*age,s.vz*age));body.state.orientation.reset(s.qw,s.qx,s.qy,s.qz);body.state.velocity.reset(s.vx,s.vy,s.vz);body.state.rotation.reset(s.ax,s.ay,s.az);}
      else {const o=p.orientation??{x:0,y:0,z:0};body.state.orientation.setFromEulerAnglesXYZ(o.x,o.y,o.z);body.state.velocity.reset();body.state.rotation.reset();}
      body.frozen=false;body.calcDerivedData();
    }
    for(const [id,body] of this.humans)if(!alive.has(id)){this.runner.removeBodyWrapper(body);this.humans.delete(id);}
  }
  private sees(from:Vec3,to:Vec3):boolean{
    const direction=vector(to).subtract(vector(from)),distance=direction.length();
    return distance<1||!this.runner.getCollisionDetector().raycastStatic(vector(from),direction.scale(1/distance),255,Math.max(0,distance-1),null,this.hit);
  }
  private allies(self:BotParticipant):BotParticipant[]{
    return (this.teams.get(self.team)??[]).filter(p=>p.id!==self.id);
  }
  /** Hulls on another floor and hulls beyond the endpoint do not occupy this lane. */
  private laneBlocker(from:Vec3,to:Vec3,allies:BotParticipant[],width:number):BotParticipant|undefined{
    const dx=to.x-from.x,dy=to.y-from.y,len2=dx*dx+dy*dy;
    if(len2<1)return undefined;
    let nearest:BotParticipant|undefined,nearestT=1;
    const limit=width*Math.sqrt(len2);
    for(const ally of allies){
      const p=ally.position!,x=p.x-from.x,y=p.y-from.y;
      const t=(x*dx+y*dy)/len2;
      if(t<=0||t>=nearestT||Math.abs(p.z-from.z-(to.z-from.z)*t)>=170||Math.abs(x*dy-y*dx)>=limit)continue;
      nearest=ally;nearestT=t;
    }
    return nearest;
  }
  private formationRoute(from:Vec3,goal:Vec3,allies:BotParticipant[],preferred:number,shotLane:boolean,side:number):NavNode[]{
    const heading=Math.atan2(from.y-goal.y,from.x-goal.x);
    return this.navigation.tacticalRoute(from,node=>{
      const distance=Math.hypot(node.x-goal.x,node.y-goal.y);
      if(distance<preferred*0.55||distance>preferred*1.65||Math.abs(node.z-goal.z)>520)return -Infinity;
      const elevated={x:node.x,y:node.y,z:node.z+115};
      if(!this.sees(elevated,goal)||shotLane&&this.laneBlocker(elevated,goal,allies,145))return -Infinity;
      let separation=850;
      for(const ally of allies){
        const reserved=this.bots.get(ally.id)?.destination??ally.position!;
        if(Math.abs(reserved.z-node.z)<220)separation=Math.min(separation,Math.hypot(reserved.x-node.x,reserved.y-node.y));
      }
      if(separation<320)return -Infinity;
      const angle=wrap(Math.atan2(node.y-goal.y,node.x-goal.x)-heading);
      return separation-Math.abs(distance-preferred)-0.3*Math.hypot(node.x-from.x,node.y-from.y)+Math.sin(angle)*side*180;
    });
  }
  private perceive(b:BotState,target:BotParticipant):Vec3|null{
    if(!target.position)return null;
    const from=b.tank.getBody().state.position.clone().add(new Vector3(0,0,100));
    const center=target.position,distance=Math.hypot(center.x-from.x,center.y-from.y,center.z-from.z);
    if(distance>9000)return null;
    const yaw=b.tank.getBody().state.orientation.getEulerAngles(new Vector3()).z+b.turret.getDirection();
    const planar=Math.hypot(center.x-from.x,center.y-from.y);
    if(planar>2400&&Math.abs(wrap(Math.atan2(-(center.x-from.x),center.y-from.y)-yaw))>Math.PI*0.82)return null;
    const height=Math.min(120,target.loadout.size.z/2+35),side=Math.min(110,target.loadout.size.x*0.35);
    for(const [x,y,z] of [[0,0,30],[0,0,height],[side,0,30],[-side,0,30],[0,side,30],[0,-side,30]]){
      const point={x:center.x+x,y:center.y+y,z:center.z+z};
      if(this.sees(from,point))return point;
    }
    return null;
  }
  private findCover(position:Vec3,threat:Vec3):CoverPlan|null{
    const nodes=this.navigation.reachable(position),stride=Math.max(1,Math.floor(nodes.length/100));
    let best:CoverPlan|null=null,bestScore=-Infinity;
    for(let i=0;i<nodes.length;i+=stride){
      const node=nodes[i],travel=Math.hypot(node.x-position.x,node.y-position.y);
      if(travel<200||travel>2800)continue;
      const hidden=[-95,0,95].every(x=>!this.sees(threat,{x:node.x+x,y:node.y,z:node.z+125}));
      if(!hidden)continue;
      const peek=node.links.find(n=>this.sees(threat,{x:n.x,y:n.y,z:n.z+125}))??null;
      const score=(peek?500:0)-travel+Math.min(1000,Math.hypot(node.x-threat.x,node.y-threat.y))*0.2;
      if(score>bestScore){bestScore=score;best={cover:node,peek};}
    }
    if(best&&!best.peek){
      const cover=best.cover;
      best.peek=nodes.filter(n=>Math.hypot(n.x-cover.x,n.y-cover.y)<1300).sort((a,b)=>Math.hypot(a.x-cover.x,a.y-cover.y)-Math.hypot(b.x-cover.x,b.y-cover.y)).find(n=>this.sees(threat,{x:n.x,y:n.y,z:n.z+125}))??null;
    }
    return best;
  }
  private chooseSupply(position:Vec3,hp:number):BotSupply|null{
    let best:BotSupply|null=null,score=-Infinity;
    for(const supply of this.supplies.values()){
      const distance=Math.hypot(supply.position.x-position.x,supply.position.y-position.y);
      if(distance>4500||supply.kind==='med'&&hp>0.9)continue;
      const value=(supply.kind==='med'?(1-hp)*5000:1300)-distance;
      if(value>score){score=value;best=supply;}
    }
    return best;
  }
  private routeAway(position:Vec3,threat:Vec3,sideways=false):NavNode[]{
    const dx=position.x-threat.x,dy=position.y-threat.y,len=Math.hypot(dx,dy)||1,side=this.random()<0.5?-1:1;
    return this.navigation.tacticalRoute(position,node=>{
      const x=node.x-position.x,y=node.y-position.y,travel=Math.hypot(x,y);
      if(travel<400||travel>(sideways?1300:3000))return -Infinity;
      return sideways?side*(x*-dy+y*dx)/len-Math.abs((x*dx+y*dy)/len)*0.3:Math.hypot(node.x-threat.x,node.y-threat.y)-travel*0.35;
    });
  }
  private assignTask(b:BotState,task:BotTask,position:Vec3,enemy:BotParticipant|null,supply:BotSupply|null,now:number,dropRoute:NavNode[]=[],weapon:Loadout['weapon']|null=null,allies:BotParticipant[]=[]):void{
    b.task=task;b.taskUntil=now+4000+this.random()*4000;b.path=[];b.holdUntil=0;b.pauseUntil=0;b.bonusId=null;b.drop=null;
    const memory=b.memory,focus=enemy?.position??memory?.position??null;
    if(task==='snipe'||task==='watch'){
      b.taskUntil=now+2500+this.random()*4000;b.scanAt=0;
    }else if(task==='retreat'||task==='reloadCover'){
      if(b.cover)b.path=this.navigation.smooth(position,this.navigation.route(position,b.cover.cover));
      if(!b.path.length&&focus)b.path=this.routeAway(position,focus);
      b.taskUntil=now+(task==='retreat'?7000:4500);
    }else if(task==='peek'){
      const goal=b.cover?.peek??focus;
      if(goal)b.path=this.navigation.routeToPoint(position,goal);
      b.taskUntil=now+4500;
    }else if(task==='evade'&&focus){
      b.path=this.routeAway(position,focus,true);b.taskUntil=now+1500+this.random()*700;b.evadeAt=now+3500;
    }else if(task==='investigate'&&focus){
      b.path=this.navigation.routeToPoint(position,focus);b.taskUntil=now+8000;
      if(Math.hypot(position.x-focus.x,position.y-focus.y)<400){b.task='watch';b.taskUntil=now+3000;b.scanAt=0;}
    }else if(task==='supply'&&supply){
      b.bonusId=supply.id;b.path=this.navigation.routeToPoint(position,supply.position);b.taskUntil=now+14000;
    }else if(task==='drop'){
      b.path=dropRoute;b.taskUntil=now+8000;
    }else if(task==='attackMove'&&focus){
      const targetHeight=enemy?Math.min(100,enemy.loadout.size.z/2):50;
      const preferred = weapon?.stream ? Math.max(350, weapon.stream.range * 65) : 2100;
      if(allies.some(ally=>Math.hypot(ally.position!.x-position.x,ally.position!.y-position.y)<1600&&Math.abs(ally.position!.z-position.z)<240)){
        b.path=this.formationRoute(position,memory?.aim??focus,allies,preferred,false,this.random()<0.5?1:-1);
      }
      if(!b.path.length)b.path=this.navigation.tacticalRoute(position,node=>{
        const range=Math.hypot(node.x-focus.x,node.y-focus.y),travel=Math.hypot(node.x-position.x,node.y-position.y);
        if(range<Math.min(900,preferred*0.55)||range>6500||travel<500)return -Infinity;
        const elevation=Math.atan2(focus.z+targetHeight-node.z-130,range);
        if(elevation>(weapon?.autoAimUp??0)||elevation<-(weapon?.autoAimDown??0)||!this.sees({x:node.x,y:node.y,z:node.z+130},b.memory?.aim??focus))return -Infinity;
        return -Math.abs(range-preferred)-travel*0.25+this.random()*150;
      });
      if(!b.path.length)b.path=this.navigation.chooseRoute(position,this.random,focus);
      if(!b.path.length)b.path=this.navigation.smooth(position,this.navigation.route(position,focus));
    }else{
      b.path=this.navigation.chooseRoute(position,this.random,null,b.patrolHistory);b.task='patrol';
      let length=0,previous:Vec3=position;for(const node of b.path){length+=Math.hypot(node.x-previous.x,node.y-previous.y,node.z-previous.z);previous=node;}
      b.taskUntil=now+Math.max(30000,length/(b.profile.hull.speed*100*0.35)*1000+15000);
      if(b.path.length){const last=b.path.at(-1)!;b.patrolHistory.push({x:last.x,y:last.y,z:last.z});if(b.patrolHistory.length>6)b.patrolHistory.shift();}
    }
    b.destination=b.path.at(-1)??null;b.planAt=now+1000;
    if(!b.path.length&&!['watch','snipe'].includes(b.task)){b.task='watch';b.taskUntil=now+1200;b.scanAt=0;}
  }
  private scan(b:BotState,yaw:number,now:number):number{
    if(now<b.scanAt)return b.scanAngle;
    b.scanAt=now+900+this.random()*700;
    const from=b.tank.getBody().state.position.clone().add(new Vector3(0,0,130));
    let best=yaw,bestScore=-Infinity;
    for(let i=0;i<8;i++){
      const angle=yaw+i*Math.PI/4,direction=new Vector3(-Math.sin(angle),Math.cos(angle),0);
      const blocked=this.runner.getCollisionDetector().raycastStatic(from,direction,255,4500,null,this.hit);
      const score=(blocked?this.hit.t:4500)+this.random()*1200-(Math.abs(wrap(angle-b.scanAngle))<0.3?2500:0);
      if(score>bestScore){bestScore=score;best=angle;}
    }
    b.scanAngle=best;return best;
  }
  private think(id:number,b:BotState,self:BotParticipant,players:BotParticipant[],now:number,flags:readonly CtfFlag[]=[]):void{
    const body=b.tank.getBody(),position=body.state.position,yaw=body.state.orientation.getEulerAngles(new Vector3()).z;
    let gold:BotSupply|undefined,nearestGold=Infinity;
    for(const candidate of this.gold.values()){
      const distance=Math.hypot(candidate.position.x-position.x,candidate.position.y-position.y,candidate.position.z-position.z);
      if(distance<nearestGold){gold=candidate;nearestGold=distance;}
    }
    if(!gold&&b.goldId!==undefined){b.goldId=undefined;b.path=[];b.destination=null;b.taskUntil=now;b.planAt=now;}
    if(b.hitFocus&&(now>=b.hitFocus.until||!players.some(p=>p.id===b.hitFocus!.id&&p.state==='active'&&p.health>0&&(self.team===2||p.team!==self.team))))b.hitFocus=null;
    const own=flags.find(flag=>flag.team===self.team), opposing=flags.find(flag=>flag.team!==self.team);
    const allies=this.allies(self);
    const priority=(p:BotParticipant)=>vector(p.position!).subtract(position).lengthSqr()*(p.id===own?.carrierId?0.35:p.id===b.hitFocus?.id?0.5:p.id===b.target?0.68:1);
    const isida=self.loadout.weapon.kind==='isida';
    const candidates=players.filter(p=>p.id!==id&&p.state==='active'&&p.health>0&&p.position&&(self.team===2||p.team!==self.team||
      isida&&p.health<p.loadout.maxHealth*0.75&&Math.hypot(p.position.x-position.x,p.position.y-position.y)<(self.loadout.weapon.stream?.range??0)*100));
    candidates.sort((a,c)=>priority(a)-priority(c));
    const locked=b.railTarget;
    let enemy:BotParticipant|null=null,point:Vec3|null=null;
    for(const candidate of candidates){
      if(locked&&candidate.id!==locked.id)continue;
      point=this.perceive(b,candidate);
      if(point){enemy=candidate;break;}
    }
    if(locked&&point)locked.point={...point};
    const acquired=!!enemy&&b.target!==enemy.id;
    if(acquired){b.target=enemy!.id;b.reactionAt=now+160+this.random()*220;}
    if(enemy&&point)b.memory={id:enemy.id,position:{...enemy.position!},aim:{...point},seenAt:now};
    if(b.memory&&now-b.memory.seenAt>12000){b.memory=null;if(!enemy)b.target=null;}
    const hp=self.health/Math.max(1,self.loadout.maxHealth),hurt=self.health<b.lastHealth-0.1;
    if(hurt)b.fearUntil=now+2000+this.random()*3000;
    b.lastHealth=self.health;
    const range=enemy?vector(enemy.position!).subtract(position).length():Infinity;
    const weapon = self.loadout.weapon;
    const passesAllies=weapon.kind==='firebird'||weapon.kind==='freeze'||weapon.kind==='railgun';
    const blockedFire=!!point&&!passesAllies&&!!this.laneBlocker({x:position.x,y:position.y,z:position.z+60},point,allies,125);
    const sustained=!!weapon.stream||weapon.kind==='twins'||weapon.kind==='ricochet';
    const engaged=sustained&&!!enemy&&hp>0.35&&(!weapon.stream||range<=weapon.stream.range*100+250);
    const aimed=enemy&&enemy.position?Math.abs(wrap(Math.atan2(-(position.x-enemy.position.x),position.y-enemy.position.y)-(enemy.orientation?.z??0)-(enemy.sample?.turretAngle??0)))<0.14:false;
    const newShot=!!enemy&&enemy.shotAt!=null&&enemy.shotAt!==b.lastEnemyShot&&now-enemy.shotAt<500;
    if(enemy?.shotAt!=null)b.lastEnemyShot=enemy.shotAt;
    const danger=!!enemy&&(self.team===2||enemy.team!==self.team)&&now>=b.evadeAt&&(newShot||aimed&&now-(enemy.shotAt??-Infinity)>enemy.loadout.weapon.reloadMs);
    if(b.task==='supply'&&!this.supplies.has(b.bonusId??-1))b.taskUntil=now;
    if(b.task==='reloadCover'&&!b.path.length&&now>=b.nextShot+180){this.assignTask(b,'peek',position,enemy,null,now,[],self.loadout.weapon);}
    const urgent=hurt||hp<0.35&&!!enemy&&b.task!=='retreat'||danger&&b.task!=='evade';
    if(b.task==='patrol'&&b.path.length&&!enemy&&!b.memory&&now>=b.taskUntil)b.taskUntil=now+15000;
    const replan=now>=b.taskUntil||acquired&&['patrol','watch','investigate'].includes(b.task)||(!engaged&&urgent)||b.justFired&&b.task!=='reloadCover';
    if(gold){
      const changed=b.goldId!==gold.id;
      if(changed){b.path=[];b.destination=null;b.holdUntil=0;b.pauseUntil=0;b.drop=null;b.planAt=now;}
      b.goldId=gold.id;b.task='supply';b.bonusId=gold.id;
      if(this.planningBudget>0&&now>=b.planAt&&!b.path.length&&nearestGold>130){
        this.planningBudget--;
        b.path=this.navigation.routeToPoint(position,gold.position);
        b.destination=b.path.at(-1)??null;b.planAt=now+500;
      }
    }else if(!locked&&own&&opposing&&(b.task==='objective'||opposing.carrierId===id||own.state!=='base'||!enemy)){
      const carrier=opposing.carrierId===id;
      const defender=id%3===0;
      const role=carrier?'capture':own.state!=='base'&&(defender||opposing.state!=='carried')?'recover':
        opposing.state==='carried'&&!defender?'escort':defender?'defend':'attack';
      const flag=role==='recover'?own:opposing;
      const goal=role==='capture'||role==='defend'?own.base:flag.position;
      const objective=`${role}:${flag.state}:${flag.carrierId}`;
      if(this.planningBudget>0&&now>=b.planAt&&(b.objective!==objective||!b.path.length||!b.objectiveGoal||Math.hypot(goal.x-b.objectiveGoal.x,goal.y-b.objectiveGoal.y)>500)){
        this.planningBudget--;
        const support=(role==='attack'||role==='recover')&&allies.some(ally=>{
          const p=ally.position!;
          return Math.hypot(p.x-goal.x,p.y-goal.y)+280<Math.hypot(position.x-goal.x,position.y-goal.y);
        });
        const hold=(role==='defend'||role==='escort'||support)&&Math.hypot(position.x-goal.x,position.y-goal.y)<900&&
          !allies.some(ally=>Math.abs(ally.position!.z-position.z)<170&&Math.hypot(ally.position!.x-position.x,ally.position!.y-position.y)<500);
        const spread=role==='defend'||role==='escort'||support;
        b.path=hold?[]:spread&&allies.length?this.formationRoute(position,goal,allies,role==='defend'?800:650,false,id%2?1:-1):[];
        if(!hold&&!b.path.length&&(!spread||role==='attack'||role==='recover'||Math.hypot(position.x-goal.x,position.y-goal.y)>1600)){
          b.path=this.navigation.routeToPoint(position,goal);
        }
        b.destination=b.path.at(-1)??null;
        b.objective=objective;
        b.objectiveGoal={...goal};
        b.task='objective';b.planAt=now+(b.path.length?700:1500);
      }
    }else if(!locked&&replan&&this.planningBudget>0&&!(b.drop&&now<b.dropUntil)){
      this.planningBudget--;
      if(danger)b.evadeAt=now+3500;
      if(b.memory&&(hurt||b.justFired||hp<0.5||now>=b.taskUntil))b.cover=this.findCover(position,b.memory.aim);
      const supply=this.chooseSupply(position,hp);
      let dropRoute:NavNode[]=[];
      if(!enemy&&!b.memory&&now>=b.dropCheckAt){if(b.patrolHistory.length&&this.random()<0.12)dropRoute=this.navigation.findDrop(position,this.random);b.dropCheckAt=now+10000;}
      const canFire=enemy&&point?this.canAim(b,point,self.loadout):false;
      const task=engaged?'attackMove':chooseBotTask({hp,visible:!!enemy,range,memory:!!b.memory,danger,afraid:now<b.fearUntil&&(!b.hitFocus||hp<0.35),
        justFired:b.justFired,cover:!!b.cover,medical:supply?.kind==='med',supply:!!supply,drop:!!dropRoute.length,canFire},this.random);
      if(!(danger&&task!=='evade'&&!hurt&&now<b.taskUntil)&&!(b.justFired&&task!=='reloadCover'&&!hurt&&now<b.taskUntil))this.assignTask(b,task,position,enemy,supply,now,dropRoute,self.loadout.weapon,allies);b.justFired=false;
      if(acquired&&task==='attackMove'&&canFire&&!weapon.stream&&range<2400&&now>=b.nextShot){
        b.holdUntil=now+Math.max(550,weapon.chargingMs+450);
      }
    }
    if(!gold&&blockedFire&&point&&!locked&&opposing?.carrierId!==id&&this.planningBudget>0&&now>=b.planAt&&!b.drop){
      this.planningBudget--;
      const flank=this.formationRoute(position,point,allies,weapon.stream?weapon.stream.range*65:Math.max(800,Math.min(range,2400)),true,id%2?1:-1);
      if(flank.length){b.path=flank;b.destination=flank.at(-1)!;b.holdUntil=0;}
      b.planAt=now+900;
    }
    if(!b.progressAt){b.progressAt=now;b.progress.copy(position);b.progressYaw=yaw;}
    if(now<b.reverseUntil&&b.chargingUntil===0)return;
    if(!b.drop&&!b.yielding&&b.path.length&&now>=b.holdUntil&&now-b.progressAt>950){
      if(position.clone().subtract(b.progress).length()<80&&Math.abs(wrap(yaw-b.progressYaw))<0.25){
        b.reverseUntil=now+380+this.random()*260;b.control=2|(this.random()<0.5?4:8);b.path=[];b.taskUntil=b.reverseUntil;b.progressAt=now;return;
      }
      b.progress.copy(position);b.progressYaw=yaw;b.progressAt=now;
    }
    const projectileSpeed=(weapon.twins?.speed??weapon.ricochet?.speed??0)*100;
    const lead=projectileSpeed>0?Math.min(0.65,range/projectileSpeed):0.035;
    const velocity=enemy?.sample;
    const aim=point&&velocity?{x:point.x+velocity.vx*lead,y:point.y+velocity.vy*lead,z:point.z+velocity.vz*lead}:point??locked?.point??b.memory?.aim??b.path[0];
    const heading=b.task==='watch'&&!enemy&&!locked?this.scan(b,yaw,now):aim?Math.atan2(-(aim.x-position.x),aim.y-position.y):this.scan(b,yaw,now);
    b.turret.setTargetControl(TurretControlType.TARGET_ANGLE_WORLD,heading);
    const stream = weapon.stream;
    const inRange = !!enemy && !!point && (!stream || range <= stream.range * 100);
    if(!inRange||blockedFire||b.task==='retreat'&&hp<=0.35)this.loseStreamAim(id,b,now);
    const completingCharge=b.chargingUntil>0&&now>=b.chargingUntil;
    if(b.chargingUntil>0&&!completingCharge)return;
    if(!completingCharge&&(!inRange||blockedFire||now<b.reactionAt||now<b.nextShot||b.task==='retreat'&&!hurt&&!engaged))return;
    const muzzles = b.tank.skin.turret.muzzles;
    calculateMainGunParams(b.tank,muzzles[b.barrel],this.gun);
    const projectile = weapon.kind === 'twins' || weapon.kind === 'ricochet';
    const origin = projectile ? this.gun.muzzlePosition : this.gun.barrelOrigin;
    const firePoint=point&&projectile?aim:point;
    const delta=firePoint?vector(firePoint).subtract(origin):null;
    const barrelAngle = projectile ? Math.atan2(Math.abs(muzzles[b.barrel].x), Math.max(1, range - muzzles[b.barrel].y)) : 0;
    const tolerance=stream?Math.max(0.06,stream.coneAngle*(b.streaming?0.5:0.3)):0.06;
    const aligned=!!delta&&Math.abs(wrap(Math.atan2(-delta.x,delta.y)-yaw-b.turret.getDirection()))<=tolerance+barrelAngle&&this.canAim(b,point!,self.loadout);
    if(!completingCharge&&!aligned){
      this.loseStreamAim(id,b,now);
      return;
    }
    b.streamLostAt=undefined;
    if(weapon.kind==='railgun'&&!completingCharge){
      b.railTarget={id:enemy!.id,point:{...point!}};
      b.chargingUntil=now+weapon.chargingMs;this.charge(id);return;
    }
    if(weapon.shaft&&!completingCharge&&range>2600&&b.task==='snipe'){
      b.chargingUntil=now+Math.min(1300,900+range/15);this.charge(id);return;
    }
    if (stream && !b.streaming) {
      b.streaming = true;
      b.nextShot = now + stream.tickMs;
      this.stream(id, true);
      return;
    }
    b.chargingUntil=0;
    b.railTarget=undefined;
    const elevation=aligned&&delta?Math.atan2(delta.z,Math.hypot(delta.x,delta.y)):Math.atan2(this.gun.direction.z,Math.hypot(this.gun.direction.x,this.gun.direction.y));
    const interval=stream?.tickMs??weapon.reloadMs;
    b.nextShot = sustained ? Math.max(now + interval - 33, b.nextShot + interval) : now + interval + 100 + this.random()*450;
    if (!sustained) b.justFired=true;
    const miss=!stream&&range>1800&&this.random()<0.08;
    const shotHeading=aligned&&delta?Math.atan2(-delta.x,delta.y):yaw+b.turret.getDirection();
    const shotYaw=shotHeading+(miss?(this.random()-0.5)*0.11:0);
    const direction=new Vector3(-Math.sin(shotYaw)*Math.cos(elevation),Math.cos(shotYaw)*Math.cos(elevation),Math.sin(elevation));
    if (projectile && !this.sees(this.gun.barrelOrigin, origin)) return;
    const penetrating = weapon.kind === 'railgun' || weapon.kind === 'firebird' || weapon.kind === 'freeze';
    const targets: BotHit[] = [];
    const excluded = new Set([body]);
    const filter = { considerBody: (candidate: Body) => !excluded.has(candidate) };
    const detector = this.runner.getCollisionDetector();
    let hit: Vec3 | null = null;
    const maxDistance = (stream?.range ?? weapon.twins?.distance ?? weapon.ricochet?.range ?? 1000) * 100;
    while (!projectile && detector.raycast(origin, direction, CollisionGroup.WEAPON, maxDistance, filter, this.hit)) {
      const other = this.hit.shape?.body;
      const targetId = (other?.data as { botUserId?: number } | null)?.botUserId;
      if (!other || targetId == null) {
        hit = xyz(this.hit.position);
        break;
      }
      const local = this.hit.position.clone().subtract(other.state.position).transformTransposed3(other.baseMatrix);
      targets.push({ id: targetId, local: xyz(local), world: xyz(this.hit.position) });
      if (!penetrating) break;
      excluded.add(other);
    }
    if (!stream) body.addWorldForceScaled(this.gun.barrelOrigin,this.gun.direction,-b.gun.turret.kickback*WEAPON_FORCE_SCALE);
    this.shoot(id,hit,targets,{origin:xyz(this.gun.muzzlePosition),direction:xyz(direction),barrel:b.barrel,aimed:!!weapon.shaft&&completingCharge});
    b.barrel = (b.barrel + 1) % muzzles.length;
  }
  private loseStreamAim(id:number,b:BotState,now:number):void{
    if(!b.streaming)return;
    b.streamLostAt??=now;
    if(now-b.streamLostAt<550)return;
    b.streaming=false;b.streamLostAt=undefined;this.stream(id,false);
  }
  private canAim(b:BotState,point:Vec3,loadout:Loadout):boolean{
    calculateMainGunParams(b.tank,b.tank.skin.turret.muzzles[b.barrel],this.gun);
    const direction=vector(point).subtract(this.gun.barrelOrigin);
    const stream = loadout.weapon.stream;
    if (stream && direction.length() > stream.range * 100) return false;
    direction.normalize();
    const up=new Vector3().cross2(this.gun.elevationAxis,this.gun.direction);
    const pitch=Math.atan2(direction.dot(up),direction.dot(this.gun.direction));
    const cone = stream ? stream.coneAngle / 2 : 0;
    return pitch<=Math.max(loadout.weapon.autoAimUp,cone)&&pitch>=-Math.max(loadout.weapon.autoAimDown,cone);
  }
  private drive(b:BotState,p:BotParticipant,now:number):void{
    const body=b.tank.getBody(),position=body.state.position;
    if(now<b.reverseUntil){b.control=this.safeControl(b,b.control,null,now);b.chassis.setControlState(b.control);return;}
    if(now<b.pauseUntil||now<b.holdUntil){b.control=0;b.chassis.setControlState(0);return;}
    const descent=b.task==='drop'?b.path.at(-1):null;
    if(descent?.drop&&!b.drop&&Math.hypot(descent.drop.from.x-position.x,descent.drop.from.y-position.y)<400){
      const floor=this.navigation.nearest(position);
      if(floor&&this.navigation.walkable(floor,descent.drop.from))b.path=[descent];
    }
    if(b.path[0]?.drop&&!b.drop){b.drop=b.path[0].drop!;b.dropUntil=now+6500;}
    if(b.drop){
      const landing=b.drop.landing;
      if(now>=b.dropUntil||(position.z<landing.z+180&&b.tank.hasTracksContactsWithStatic())){
        b.drop=null;b.path=[];b.taskUntil=now;
      }else{
        const yaw=body.state.orientation.getEulerAngles(new Vector3()).z;
        const steering=botSteering(position,yaw,body.state.rotation.z,landing,b.profile.hull.turnAcceleration);
        b.control=steering.control;b.tank.setMaxSpeed(Math.min(b.drop.speed,b.profile.hull.speed*100*p.speedFactor),true);
        b.chassis.setControlState(b.control);return;
      }
    }
    let reached=false;
    while(b.path.length&&Math.hypot(b.path[0].x-position.x,b.path[0].y-position.y)<150&&Math.abs(b.path[0].z-position.z)<240){b.path.shift();reached=true;}
    if(reached&&!b.path.length){
      b.destination=null;
      // Brief aimed stop after a combat relocation, then resume moving to a new position.
      if(b.task==='reloadCover')b.holdUntil=Math.max(now,b.nextShot);
      else if(b.task==='retreat'){b.holdUntil=now+2200;b.taskUntil=b.holdUntil;}
      else if(b.task==='supply')b.taskUntil=now+1200;
      else if(b.task==='patrol'&&this.random()<0.15){b.task='watch';b.scanAt=0;b.taskUntil=now+1500+this.random()*1500;}
      else {b.holdUntil=b.task==='attackMove'||b.task==='peek'?now+700:now;b.taskUntil=b.holdUntil;}
      b.progressAt=now;
    }
    const goal=b.path[0]??null,yaw=body.state.orientation.getEulerAngles(new Vector3()).z;
    const allies=this.allies(p);
    if(b.yielding){
      const other=allies.find(ally=>ally.id===b.yielding!.allyId);
      if(other&&now<b.yielding.until){
        const behind={x:position.x+Math.sin(yaw)*420,y:position.y-Math.cos(yaw)*420,z:position.z};
        b.control=this.laneBlocker(position,behind,allies,Math.max(210,p.loadout.size.x))?0:this.safeControl(b,2,null,now);
        b.tank.setMaxSpeed(Math.min(330,b.profile.hull.speed*100*p.speedFactor),true);
        b.progressAt=now;b.chassis.setControlState(b.control);return;
      }
      b.yielding=undefined;
    }
    let steeringGoal:Vec3|null=goal,followingSpeed=Infinity;
    if(goal&&allies.length){
      const dx=goal.x-position.x,dy=goal.y-position.y,distance=Math.hypot(dx,dy)||1;
      const speed=Math.hypot(body.state.velocity.x,body.state.velocity.y);
      const braking=speed*speed/(2*Math.max(180,b.profile.hull.acceleration*65));
      const look=Math.min(1200,Math.max(780,braking+560)),fx=dx/distance,fy=dy/distance;
      const ally=this.laneBlocker(position,{x:position.x+fx*look,y:position.y+fy*look,z:position.z},allies,Math.max(210,p.loadout.size.x));
      if(ally){
        const other=ally.position!,gap=Math.hypot(other.x-position.x,other.y-position.y);
        if(b.pass?.allyId!==ally.id||b.pass.until<=now){
          const floor={x:position.x,y:position.y,z:position.z-85};
          const side=(other.x-position.x)*fy-(other.y-position.y)*fx>70?-1:1;
          const offset=(p.loadout.size.x+ally.loadout.size.x)/2+110;
          let clear:Vec3|null=null;
          for(const direction of [side,-side]){
            const pass={x:other.x+fy*offset*direction+fx*120,y:other.y-fx*offset*direction+fy*120,z:floor.z};
            if(!this.laneBlocker(position,{...pass,z:position.z},allies,185)&&this.navigation.canDrive(floor,pass)){clear=pass;break;}
          }
          b.pass={allyId:ally.id,until:now+350,goal:clear};
        }
        if(b.pass.goal)steeringGoal=b.pass.goal;
        else {
          const allyBot=this.bots.get(ally.id),allyGoal=allyBot?.path[0];
          const facing=ally.orientation?.z??0;
          const headingX=allyGoal?allyGoal.x-other.x:-Math.sin(facing);
          const headingY=allyGoal?allyGoal.y-other.y:Math.cos(facing);
          const oncoming=(headingX*fx+headingY*fy)<-0.55*Math.hypot(headingX,headingY);
          const spacing=(p.loadout.size.y+ally.loadout.size.y)/2+(oncoming?180:120);
          if(oncoming&&gap<spacing+180&&(!allyBot||(!allyBot.yielding&&(!allyGoal||p.id>ally.id)))){
            b.yielding={allyId:ally.id,until:now+900};b.control=0;b.progressAt=now;b.chassis.setControlState(0);return;
          }
          const pace=Math.max(0,(ally.sample?.vx??0)*fx+(ally.sample?.vy??0)*fy);
          followingSpeed=pace+Math.sqrt(2*b.profile.hull.acceleration*65*Math.max(0,gap-spacing));
        }
      }
    }
    const steering=botSteering(position,yaw,body.state.rotation.z,steeringGoal,b.profile.hull.turnAcceleration);
    b.control=steering.control;
    const distance=goal?Math.hypot(goal.x-position.x,goal.y-position.y):0;
    const stoppingSpeed=Math.sqrt(2*b.profile.hull.acceleration*100*Math.max(40,distance-90));
    b.tank.setMaxSpeed(Math.min(b.profile.hull.speed*100*p.speedFactor*steering.speed,stoppingSpeed,followingSpeed),true);
    if(followingSpeed<35){b.control&=~3;b.progressAt=now;}
    const allowed=this.safeControl(b,b.control,steeringGoal,now);
    if((b.control&3)&&!(allowed&3))b.blockedSince??=now;
    else b.blockedSince=undefined;
    if(b.blockedSince!==undefined&&now-b.blockedSince>=320){
      b.blockedSince=undefined;b.path=[];b.destination=null;b.planAt=now+400;b.taskUntil=now+400;
      b.reverseUntil=now+400;b.control=2|(this.random()<0.5?4:8);
      b.chassis.setControlState(this.safeControl(b,b.control,null,now));return;
    }
    if(allowed!==b.control&&now>=b.planAt&&b.task!=='drop'){
      b.path=b.destination?this.navigation.smooth(position,this.navigation.route(position,b.destination)):[];
      b.planAt=now+800;
    }
    b.control=allowed;
    b.chassis.setControlState(b.control);
  }

  private safeControl(b:BotState,control:number,goal:Vec3|null,now:number):number{
    if(!(control&3))return control;
    const body=b.tank.getBody(),p=body.state.position,yaw=body.state.orientation.getEulerAngles(new Vector3()).z;
    const cached=b.safeCache;
    if(cached&&cached.input===control&&cached.goal===goal&&now-cached.at<100&&Math.hypot(p.x-cached.position.x,p.y-cached.position.y)<80&&Math.abs(wrap(yaw-cached.yaw))<0.12)return cached.allowed;
    const sign=control&2?-1:1;
    const z=p.z-85;
    const start={x:p.x,y:p.y,z};
    const speed=Math.hypot(body.state.velocity.x,body.state.velocity.y);
    let look=Math.max(b.tank.getHalfLength()+70,speed*speed/(2*b.profile.hull.acceleration*100)+b.tank.getHalfLength()+60);
    if(goal&&sign>0)look=Math.min(look,Math.hypot(goal.x-p.x,goal.y-p.y)+(b.task==='drop'?0:b.tank.getHalfLength()/2));
    const ahead={x:p.x-sign*Math.sin(yaw)*look,y:p.y+sign*Math.cos(yaw)*look,z};
    const allowed=this.navigation.canDrive(start,ahead)?control:control&~3;
    b.safeCache={at:now,position:xyz(p),yaw,input:control,goal,allowed};
    return allowed;
  }

  private updateSupplies(bonuses:BonusInfo[],fallSpeed:number):void{
    this.supplies.clear();this.gold.clear();const alive=new Set(bonuses.map(b=>b.bonusId));
    for(const id of this.supplyCache.keys())if(!alive.has(id))this.supplyCache.delete(id);
    for(const bonus of bonuses){
      let cached=this.supplyCache.get(bonus.bonusId);
      if(!cached){
        const origin=vector(bonus.position),detector=this.runner.getCollisionDetector();
        if(!detector.raycastStatic(origin,new Vector3(0,0,-1),255,100000,null,this.hit))continue;
        const position=xyz(this.hit.position);
        const ceiling=detector.raycastStatic(origin,new Vector3(0,0,1),255,100000,null,this.hit);
        cached={position,fallMs:ceiling?0:Math.max(0,(bonus.position.z-position.z-75)/Math.max(1,fallSpeed)*1000)};
        this.supplyCache.set(bonus.bonusId,cached);
      }
      const supply={id:bonus.bonusId,kind:bonus.kind,position:cached.position};
      if(bonus.kind==='gold')this.gold.set(bonus.bonusId,supply);
      if(bonus.ageMs>=cached.fallMs)this.supplies.set(bonus.bonusId,supply);
      else if(bonus.kind==='gold'){
        const z=cached.position.z+Math.max(0,cached.fallMs-bonus.ageMs)*fallSpeed/1000;
        this.supplies.set(bonus.bonusId,{...supply,position:{...cached.position,z}});
      }
    }
  }
  step(players:BotParticipant[],sampleTime:number,now:number,context:{bonuses:BonusInfo[];fallSpeed:number;flags?:CtfFlag[]}={bonuses:[],fallSpeed:300}):void{
    this.updateSupplies(context.bonuses,context.fallSpeed);
    this.planningBudget=this.gold.size?2:1;this.navigation.expand(2);this.synchronizeHumans(players,sampleTime);
    this.teams.clear();
    for(const p of players)if(p.team!==2&&p.state==='active'&&p.position){
      const team=this.teams.get(p.team);
      if(team)team.push(p);else this.teams.set(p.team,[p]);
    }
    const byId=new Map(players.map(p=>[p.id,p]));
    for(const [id,b] of this.bots){
      const p=byId.get(id);if(!p||!['active','spawned'].includes(p.state)||p.life!==b.life){this.remove(id);continue;}
      b.tank.health=p.health;
      // Preserve Tank as Body.data for suspension/contact processing, with an explicit network id.
      (b.tank as Tank&{botUserId:number}).botUserId=id;
      b.tank.setMaxSpeed(b.profile.hull.speed*100*p.speedFactor,true);
      b.tank.setMaxTurnSpeed(b.profile.hull.turnSpeed*p.speedFactor,true);
      b.tank.setAcceleration(b.profile.hull.acceleration*100*p.speedFactor);
      b.turret.setMaxTurnSpeed(b.gun.turret.turretRotationSpeed*p.speedFactor,true);
      const up=b.tank.getBody().baseMatrix.k;
      if(p.state==='active'&&up<0.12)b.overturnedAt??=now;
      else b.overturnedAt=undefined;
      if(b.suicideRequested||b.overturnedAt!==undefined&&now-b.overturnedAt>=2400){
        b.control=0;b.chassis.setControlState(0);
        if(b.streaming){b.streaming=false;this.stream(id,false);}
        if(!b.suicideRequested){b.suicideRequested=true;this.suicide(id);}
      }else if(p.state==='active'){b.tank.setActivatedState();if(now>=b.decisionAt){b.decisionAt=now+(p.loadout.weapon.stream||p.loadout.weapon.twins||p.loadout.weapon.ricochet?66:100+this.random()*50);this.think(id,b,p,players,now,context.flags??[]);}this.drive(b,p,now);}
      else b.chassis.setControlState(0);
    }
    this.runner.stepPhysics();
    this.stepProjectiles();
    for(const [id,b] of this.bots){
      b.tank.interpolatePhysicsState(1);b.tank.render();
      const s=b.tank.getBody().state,q=s.orientation;
      if(b.tank.hasTracksContactsWithStatic()||b.drop||Math.abs(s.velocity.z)>140)b.unsupportedSince=undefined;
      else {
        b.unsupportedSince??=now;
        if(now-b.unsupportedSince>3500&&!this.runner.getCollisionDetector().raycastStatic(s.position,new Vector3(0,0,-1),255,450,null,this.hit)){
          this.lost(id);continue;
        }
      }
      this.publish(id,{seq:(++b.seq)&65535,sampleTime,life:b.life,chassis:b.control,turretControl:0,turretAngle:b.turret.getDirection(),px:s.position.x,py:s.position.y,pz:s.position.z,qx:q.x,qy:q.y,qz:q.z,qw:q.w,vx:s.velocity.x,vy:s.velocity.y,vz:s.velocity.z,ax:s.rotation.x,ay:s.rotation.y,az:s.rotation.z});
      if(this.bots.has(id)&&byId.get(id)?.state==='active'&&!b.suicideRequested)for(const [bonusId,supply] of this.supplies){
        if(Math.hypot(s.position.x-supply.position.x,s.position.y-supply.position.y)<190&&Math.abs(s.position.z-supply.position.z-75)<150){
          this.supplies.delete(bonusId);this.gold.delete(bonusId);this.takeSupply(id,bonusId);
        }
      }
    }
  }
}

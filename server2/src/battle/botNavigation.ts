import { createHash } from 'node:crypto';
import bakedGraphs from '../../data/bot-navigation.json' with {type:'json'};
import { Vector3 } from '../../../html5/src/physics/math/Vector3.ts';
import { RayHit } from '../../../html5/src/physics/collision/types.ts';
import type { TanksCollisionDetector } from '../../../html5/src/tanks/physics/TanksCollisionDetector.ts';
import { inKillZone, type MapData } from './mapData.ts';
import type { Vec3 } from '../../../html5/src/net2/protocol.ts';

export interface BakedBotGraph {hash:string;nodes:[number,number,number,number,number,number,number[]][]}
export interface DropPlan {from:Vec3;landing:Vec3;speed:number;drop:number}
export interface NavNode extends Vec3 { key:string; links:NavNode[]; normal?:Vec3; drop?:DropPlan }
const CELL=250,MAX_NODES=8000;
/** Incremental walkable graph. Ground support + width clearance prevent routes through walls/over cliffs. */
export class BotNavigation {
  static useBaked=true;
  readonly fingerprint:string;
  readonly baked:boolean;
  readonly nodes:NavNode[]=[];
  private readonly byKey=new Map<string,NavNode>();
  private readonly queries=new Map<string,NavNode>();
  private readonly misses=new Set<string>();
  private queue=0;
  private readonly hit=new RayHit();
  constructor(private detector:TanksCollisionDetector,private map:MapData,private radius:number){
    this.fingerprint=createHash('sha256').update('surface-patrol-v1').update(map.xml).update(JSON.stringify([map.killZones,map.spawns,radius])).digest('hex');
    const cached=(bakedGraphs as unknown as Record<string,BakedBotGraph>)[map.key];
    this.baked=BotNavigation.useBaked&&cached?.hash===this.fingerprint;
    if(this.baked){
      for(const [x,y,z,nx,ny,nz]of cached.nodes){const key=`${Math.round(x/CELL)},${Math.round(y/CELL)},${Math.round(z/50)}`;const node={x,y,z,key,normal:{x:nx,y:ny,z:nz},links:[]};this.nodes.push(node);this.byKey.set(key,node);}
      cached.nodes.forEach((row,i)=>{this.nodes[i].links=row[6].map(j=>this.nodes[j]);});this.queue=this.nodes.length;return;
    }
    for(const spawn of [...map.spawns.dm,...map.spawns.red,...map.spawns.blue])this.probe(Math.round(spawn.position.x/CELL),Math.round(spawn.position.y/CELL),spawn.position.z,1000);
  }
  seed(point:Vec3):void{this.probe(Math.round(point.x/CELL),Math.round(point.y/CELL),point.z);}
  serialize():BakedBotGraph{
    const ids=new Map(this.nodes.map((node,i)=>[node,i]));
    return {hash:this.fingerprint,nodes:this.nodes.map(n=>[n.x,n.y,n.z,n.normal?.x??0,n.normal?.y??0,n.normal?.z??1,n.links.map(next=>ids.get(next)!)])};
  }
  private ground(x:number,y:number,z:number,depth:number):(Vec3&{normal:Vec3})|null{
    const sample=(ox:number,oy:number)=>{
      if(!this.detector.raycastStatic(new Vector3(x+ox,y+oy,z+120),new Vector3(0,0,-1),255,depth,null,this.hit)||this.hit.normal.z<0.5)return null;
      const normal={x:this.hit.normal.x,y:this.hit.normal.y,z:this.hit.normal.z};
      return {x,y,z:this.hit.position.z+(normal.x*ox+normal.y*oy)/normal.z,normal};
    };
    let floor=sample(0,0);
    if(!floor){
      // Exact shared edges in the original plane meshes can miss a vertical ray.
      // Require two matching sub-centimetre neighbours; never bridge a real cliff.
      let matches=0;
      for(const [ox,oy]of[[0.5,0],[-0.5,0],[0,0.5],[0,-0.5]]){
        const nearby=sample(ox,oy);if(!nearby)continue;
        if(!floor){floor=nearby;matches=1;}else if(Math.abs(floor.z-nearby.z)<2)matches++;
      }
      if(matches<2)return null;
    }
    return floor&&!inKillZone(this.map,{x,y,z:floor.z+80})?floor:null;
  }
  private probe(gx:number,gy:number,z:number,depth=240):NavNode|null{
    const query=`${gx},${gy},${Math.round(z/50)},${depth}`;
    if(this.misses.has(query))return null;
    const cached=this.queries.get(query);if(cached)return cached;
    const floor=this.ground(gx*CELL,gy*CELL,z,depth);
    if(!floor){this.misses.add(query);return null;}
    const key=`${gx},${gy},${Math.round(floor.z/50)}`;
    const known=this.byKey.get(key);if(known){this.queries.set(query,known);return known;}
    if(this.nodes.length>=MAX_NODES)return null;
    for(const [dx,dy] of [[this.radius,0],[-this.radius,0],[0,this.radius],[0,-this.radius]]){
      if(!this.traceGround(floor,{x:floor.x+dx,y:floor.y+dy,z:floor.z})){
        this.misses.add(query);return null;
      }
    }
    if(this.detector.raycastStatic(new Vector3(floor.x,floor.y,floor.z+10),new Vector3(0,0,1),255,220,null,this.hit)){this.misses.add(query);return null;}
    const node={...floor,key,links:[]};this.byKey.set(key,node);this.queries.set(query,node);this.nodes.push(node);return node;
  }
  clear(from:Vec3,to:Vec3):boolean{
    const dx=to.x-from.x,dy=to.y-from.y,len=Math.hypot(dx,dy);
    if(len<1)return true;
    const sx=-dy/len,sy=dx/len;
    for(const offset of [-this.radius,0,this.radius]){
      const start=new Vector3(from.x+sx*offset,from.y+sy*offset,from.z+90);
      const direction=new Vector3(dx,dy,to.z-from.z);const distance=direction.length();direction.scale(1/distance);
      if(this.detector.raycastStatic(start,direction,255,distance,null,this.hit))return false;
    }
    return true;
  }
  expand(budget=30):void{
    while(budget-->0&&this.queue<this.nodes.length&&this.nodes.length<MAX_NODES){
      const node=this.nodes[this.queue++],gx=Math.round(node.x/CELL),gy=Math.round(node.y/CELL);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
        const surface=this.traceGround(node,{x:(gx+dx)*CELL,y:(gy+dy)*CELL,z:node.z});
        if(!surface)continue;
        const other=this.probe(gx+dx,gy+dy,surface.z);
        if(!other||node.links.includes(other)||!this.walkable(node,other))continue;
        if(!node.links.includes(other))node.links.push(other);
        if(!other.links.includes(node))other.links.push(node);
      }
    }
  }
  nearest(point:Vec3):NavNode|null{
    let best:NavNode|null=null,distance=Infinity;
    for(const node of this.nodes){
      if(Math.abs(node.z-point.z)>300)continue;
      const d=Math.hypot(node.x-point.x,node.y-point.y)+Math.abs(node.z-point.z)*2;
      if(d<distance){distance=d;best=node;}
    }
    return distance<1000?best:null;
  }
  /** Follow short pieces of the actual surface, including flat/ramp/flat joints.
   * A single tangent or a low straight chord incorrectly treats the crest as a wall. */
  private traceGround(from:Vec3,to:Vec3):(Vec3&{normal:Vec3})|null{
    let floor=this.ground(from.x,from.y,from.z,350);if(!floor)return null;
    const distance=Math.hypot(to.x-from.x,to.y-from.y),count=Math.max(1,Math.ceil(distance/60));
    for(let i=1;i<=count;i++){
      const t=i/count,x=from.x+(to.x-from.x)*t,y=from.y+(to.y-from.y)*t;
      const expected=floor.z-(floor.normal.x*(x-floor.x)+floor.normal.y*(y-floor.y))/floor.normal.z;
      const next=this.ground(x,y,expected,240);
      if(!next||Math.abs(next.z-expected)>110||Math.abs(next.z-floor.z)>Math.hypot(x-floor.x,y-floor.y)*Math.sqrt(3)+20)return null;
      const start=new Vector3(floor.x,floor.y,floor.z+90),direction=new Vector3(next.x-floor.x,next.y-floor.y,next.z-floor.z),length=direction.length();
      if(length>0&&this.detector.raycastStatic(start,direction.scale(1/length),255,length,null,this.hit))return null;
      floor=next;
    }
    return floor;
  }
  walkable(from:Vec3,to:Vec3):boolean{
    const end=this.traceGround(from,to);if(!end||Math.abs(end.z-to.z)>80)return false;
    const dx=to.x-from.x,dy=to.y-from.y,len=Math.hypot(dx,dy)||1;
    for(const side of [-1,1]){
      const ox=-dy/len*this.radius*side,oy=dx/len*this.radius*side;
      const start=this.traceGround(from,{x:from.x+ox,y:from.y+oy,z:from.z});
      if(!start||!this.traceGround(start,{x:to.x+ox,y:to.y+oy,z:to.z}))return false;
    }
    return true;
  }
  canDrive(from:Vec3,to:Vec3):boolean{
    const end=this.traceGround(from,to);return !!end&&this.walkable(from,end);
  }
  smooth(from:Vec3,path:NavNode[]):NavNode[]{
    const result:NavNode[]=[];
    let anchor:Vec3={x:from.x,y:from.y,z:this.nearest(from)?.z??from.z},index=0;
    while(index<path.length){
      let next=index;
      for(let j=Math.min(path.length-1,index+5);j>index;j--){
        if(Math.hypot(path[j].x-anchor.x,path[j].y-anchor.y)>1000)continue;
        if(this.walkable(anchor,path[j])){next=j;break;}
      }
      result.push(path[next]);anchor=path[next];index=next+1;
    }
    return result;
  }
  /** Pick a destination from the current connected component, never a random unreachable island. */
  chooseRoute(from:Vec3,random:()=>number,focus:Vec3|null=null,recent:Vec3[]=[]):NavNode[]{
    const start=this.nearest(from);if(!start)return [];
    const parent=new Map<NavNode,NavNode|null>([[start,null]]),distance=new Map<NavNode,number>([[start,0]]),queue=[start];
    for(let i=0;i<queue.length;i++)for(const next of queue[i].links){
      if(parent.has(next))continue;parent.set(next,queue[i]);distance.set(next,distance.get(queue[i])!+Math.hypot(next.x-queue[i].x,next.y-queue[i].y,next.z-queue[i].z));queue.push(next);
    }
    let candidates=queue.filter(node=>{
      const travel=Math.hypot(node.x-from.x,node.y-from.y);
      if(travel<(focus?700:1400))return false;
      const range=focus?Math.hypot(node.x-focus.x,node.y-focus.y):0;
      return !focus||range>=850&&range<=2600;
    });
    if(!candidates.length&&!focus)candidates=queue.filter(node=>Math.hypot(node.x-from.x,node.y-from.y)>500);
    if(!candidates.length)return [];
    if(!focus){
      const farthest=Math.max(...candidates.map(n=>Math.hypot(n.x-from.x,n.y-from.y)));
      candidates=candidates.filter(n=>Math.hypot(n.x-from.x,n.y-from.y)>=farthest*0.6);
      const score=(n:NavNode)=>distance.get(n)!+Math.abs(n.z-start.z)*2+(recent.length?Math.min(2500,...recent.map(p=>Math.hypot(p.x-n.x,p.y-n.y))):0);
      candidates=candidates.map(node=>({node,score:score(node)})).sort((a,b)=>b.score-a.score).slice(0,Math.max(1,Math.ceil(candidates.length*0.15))).map(row=>row.node);
    }
    const end=candidates[Math.min(candidates.length-1,Math.floor(random()*candidates.length))];
    const path=[end];while(parent.get(path[0]))path.unshift(parent.get(path[0])!);
    return this.smooth(from,path);
  }
  reachable(from:Vec3,limit=1800):NavNode[]{
    const first=this.nearest(from);if(!first)return [];
    const nodes=[first],seen=new Set([first]);
    for(let i=0;i<nodes.length&&i<limit;i++)for(const next of nodes[i].links){if(!seen.has(next)){seen.add(next);nodes.push(next);}}
    return nodes;
  }
  tacticalRoute(from:Vec3,score:(node:NavNode)=>number):NavNode[]{
    const candidates=this.reachable(from).map(node=>({node,score:score(node)})).filter(c=>Number.isFinite(c.score)).sort((a,b)=>b.score-a.score);
    for(const candidate of candidates.slice(0,8)){
      const path=this.route(from,candidate.node);if(path.length>1)return this.smooth(from,path);
    }
    return [];
  }
  routeToPoint(from:Vec3,to:Vec3):NavNode[]{
    const path=this.smooth(from,this.route(from,to));if(!path.length)return [];
    const floor=this.ground(to.x,to.y,to.z,1000);
    if(floor&&this.walkable(path[path.length-1],floor))path.push({...floor,key:'exact',links:[]});
    return path;
  }
  /** Optional one-way ledge descent, checked against a broad landing area and an airborne corridor. */
  findDrop(from:Vec3,random:()=>number):NavNode[]{
    const upper=this.reachable(from,700).filter(n=>Math.hypot(n.x-from.x,n.y-from.y)<1000&&Math.abs(n.z-from.z+85)<180);
    if(!upper.length)return [];
    for(let attempt=0;attempt<24;attempt++){
      const start=upper[Math.floor(random()*upper.length)],angle=Math.floor(random()*8)*Math.PI/4;
      const dx=Math.cos(angle),dy=Math.sin(angle),distance=750;
      const lower=this.ground(start.x+dx*distance,start.y+dy*distance,start.z,1400);
      if(!lower)continue;
      const drop=start.z-lower.z;if(drop<150||drop>1000)continue;
      let broad=true;
      for(const [x,y] of [[350,0],[-350,0],[0,350],[0,-350]]){
        const edge=this.ground(lower.x+x,lower.y+y,lower.z,240);
        if(!edge||Math.abs(edge.z-lower.z)>60){broad=false;break;}
      }
      if(!broad)continue;
      let edgeDistance=0;
      for(let d=125;d<distance;d+=125){const support=this.ground(start.x+dx*d,start.y+dy*d,start.z,240);if(!support){edgeDistance=d-60;break;}}
      if(edgeDistance<=0||edgeDistance>500)continue;
      const flight=Math.sqrt(2*drop/(this.map.gravity??1000)),speed=(distance-edgeDistance)/flight;
      if(speed<200||speed>850)continue;
      let clear=true,previous=new Vector3(start.x+dx*edgeDistance,start.y+dy*edgeDistance,start.z+100);
      for(let i=1;i<=8;i++){
        const t=i/8,p=new Vector3(start.x+dx*(edgeDistance+(distance-edgeDistance)*t),start.y+dy*(edgeDistance+(distance-edgeDistance)*t),start.z+100-drop*t*t);
        const direction=p.clone().subtract(previous),length=direction.length();
        if(this.detector.raycastStatic(previous,direction.scale(1/length),255,length,null,this.hit)){clear=false;break;}previous=p;
      }
      if(!clear)continue;
      const route=this.smooth(from,this.route(from,start));if(!route.length)continue;
      route.push({...lower,key:'drop-landing',links:[],drop:{from:start,landing:lower,speed,drop}});return route;
    }
    return [];
  }
  route(from:Vec3,to:Vec3):NavNode[]{
    const start=this.nearest(from),end=this.nearest(to);if(!start||!end)return [];
    const open=new Set([start]),scores=new Map<NavNode,number>([[start,0]]),parent=new Map<NavNode,NavNode>();
    let budget=2000;
    while(open.size&&budget-->0){
      let current:NavNode|null=null,best=Infinity;
      for(const node of open){const f=scores.get(node)!+Math.hypot(node.x-end.x,node.y-end.y,node.z-end.z);if(f<best){best=f;current=node;}}
      if(!current)break;
      if(current===end){const path=[end];while(parent.has(path[0]))path.unshift(parent.get(path[0])!);return path;}
      open.delete(current);
      for(const next of current.links){
        const cost=scores.get(current)!+Math.hypot(next.x-current.x,next.y-current.y,next.z-current.z);
        if(cost>=(scores.get(next)??Infinity))continue;
        scores.set(next,cost);parent.set(next,current);open.add(next);
      }
    }
    return [];
  }
}

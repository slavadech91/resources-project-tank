import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GarageCatalog } from '../garage/catalog.ts';
import { assembleLoadout, type Loadout } from './loadout.ts';

export interface BotProfile {
  collisionSizes?:Record<string,{x:number;y:number;z:number}>;
  bounds:{minX:number;minY:number;minZ:number;maxX:number;maxY:number;maxZ:number};
  mount:[number,number,number]; muzzle:[number,number,number];
  hull:{mass:number;damping:number;speed:number;turnSpeed:number;acceleration:number;reverseAcceleration:number;sideAcceleration:number;turnAcceleration:number;reverseTurnAcceleration:number;armor:number};
  turret:{turretRotationSpeed:number;turretRotationAcceleration:number;impactForce:number;kickback:number;reloadTime:number};
  hullId:number;turretId:number;paintId:number;
}
export interface BotEquipment {
  loadout: Loadout;
  minRank?: number;
  gun: Pick<BotProfile, 'muzzle' | 'turret'> & { secondMuzzle?: BotProfile['muzzle'] };
}
export interface BotHull {
  minRank:number;
  loadout:Loadout;
  profile: Pick<BotProfile,'bounds'|'mount'|'hull'>;
}
export interface BotPaint {id:number;resistances:Loadout['resistances']}

export function loadBotProfile(configDir:string,catalog:GarageCatalog){
  const profile=JSON.parse(readFileSync(resolve(configDir,'../../server2/data/bot-loadout.json'),'utf8')) as BotProfile;
  const items=[...catalog.items.values()];
  const hull=items.find(i=>i.object3dsId===profile.hullId&&i.category==='armor');
  const turret=items.find(i=>i.object3dsId===profile.turretId&&i.category==='weapon');
  const paint=items.find(i=>i.coloringId===profile.paintId);
  if(!hull||!turret||!paint)throw new Error('Wasp M3/Railgun M0 bot profile is missing from catalog');
  const loadout = assembleLoadout([hull,turret,paint],new Map(),[]);
  const equipment: BotEquipment[] = [{ loadout, gun: profile }];
  for (const item of items) {
    if (item.category!=='weapon'||!item.weapon||!item.objectPath)continue;
    const match=/turrets\/[^/]+\/m[0-3]$/.exec(item.objectPath);
    if(!match||item===turret)continue;
    const file = resolve(configDir, '../../html5/public/tank_parts', match[0], 'part.json');
    let json:string;
    try {json=readFileSync(file,'utf8');} catch {continue;}
    const part = JSON.parse(json) as {
      objects: { name: string; position: BotProfile['muzzle'] }[];
      physicalObjects?: { name: string; position: BotProfile['muzzle'] }[];
      spec: BotProfile['turret'];
    };
    const [muzzle, second] = (part.physicalObjects ?? part.objects).filter(object => /muzzle.*/.test(object.name));
    if (!muzzle) continue;
    equipment.push({ minRank:item.minRank, loadout: assembleLoadout([hull, item, paint], new Map(), [],true),
      gun: { muzzle: muzzle.position, secondMuzzle: second?.position, turret: part.spec } });
  }
  const hulls:BotHull[]=[];
  for(const item of items){
    if(item.category!=='armor'||!item.objectPath)continue;
    const path=/hulls\/(?:wasp|hornet|hunter|viking|dictator|titan|mammoth)\/m[0-3]$/.exec(item.objectPath)?.[0];
    if(!path)continue;
    let json:string;
    try{json=readFileSync(resolve(configDir,'../../html5/public/tank_parts',path,'part.json'),'utf8');}catch{continue;}
    const part=JSON.parse(json) as {objects:{name:string;position:BotProfile['mount'];positions?:number[]}[];spec:BotProfile['hull']};
    const mount=part.objects.find(object=>/mount/i.test(object.name));
    const vertices=part.objects.find(object=>/hull/i.test(object.name))?.positions;
    if(!mount||!vertices?.length)continue;
    const bounds={minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity};
    for(let i=0;i<vertices.length;i+=3){
      bounds.minX=Math.min(bounds.minX,vertices[i]);bounds.maxX=Math.max(bounds.maxX,vertices[i]);
      bounds.minY=Math.min(bounds.minY,vertices[i+1]);bounds.maxY=Math.max(bounds.maxY,vertices[i+1]);
      bounds.minZ=Math.min(bounds.minZ,vertices[i+2]);bounds.maxZ=Math.max(bounds.maxZ,vertices[i+2]);
    }
    hulls.push({minRank:item.minRank,loadout:assembleLoadout([item,paint],new Map(),[],true),profile:{bounds,mount:mount.position,hull:part.spec}});
  }
  const paints=items.filter(item=>item.category==='color'&&item.id>=120&&item.id<125&&item.coloringId!=null)
    .map(item=>({id:item.coloringId!,resistances:assembleLoadout([item],new Map(),[],true).resistances}));
  return {profile,loadout,equipment,hulls,paints};
}

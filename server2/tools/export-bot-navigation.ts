// Precompute private numeric walkable graphs on the development machine, not on Atom.
// Re-run after changing map collisions, Wasp size or BotNavigation surface checks.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GarageCatalog } from '../src/garage/catalog.ts';
import { loadBotProfile } from '../src/battle/botProfile.ts';
import { loadMapData } from '../src/battle/mapData.ts';
import { BotWorld } from '../src/battle/botWorld.ts';
import { BotNavigation,type BakedBotGraph } from '../src/battle/botNavigation.ts';
import { parseCollisionXml } from '../src/battle/collision.ts';
import { parseCollisionGeometry } from '../../html5/src/tanks/map/CollisionGeometryParser.ts';
import type { ServerMap } from '../../html5/src/map/types.ts';
const configDir=resolve('dev/configs'),{profile}=loadBotProfile(configDir,new GarageCatalog(configDir));
BotNavigation.useBaked=false;
const result:Record<string,BakedBotGraph>={};
for(const map of loadMapData(configDir).values()){
  const world=new BotWorld(map,profile,()=>{},()=>{}),geometry=parseCollisionXml(map.xml);
  const shapes=parseCollisionGeometry({...geometry,spawns:[],bonusRegions:[]} as ServerMap);
  // Start from ramp interiors too, so platforms without a spawn do not depend on discovery order.
  for(const shape of shapes.slice(0,geometry.planes.length)){
    const t=shape.transform;
    if(t.k>0.5&&t.k<0.99)world.navigation.seed({x:t.d,y:t.h,z:t.l});
  }
  for(let i=0;i<400;i++)world.navigation.expand(30);
  result[map.key]=world.navigation.serialize();
  console.log(map.key,{nodes:world.navigation.nodes.length,ramps:world.navigation.nodes.filter(n=>(n.normal?.z??1)<0.95).length});
  world.clear();
}
writeFileSync(resolve('server2/data/bot-navigation.json'),JSON.stringify(result)+'\n');

import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {appearancePartPath,appearanceMedia} from '../src/net2/appearance.ts';
import {appearancePhysicsMesh} from '../src/tanks/render/appearanceGeometry.ts';
import {turretHitGeometry} from '../src/tanks/tank/TurretHitGeometry.ts';
import {getUVFramesFromTexture} from '../src/tanks/sfx/SmokyEffects.ts';
const root='html5/public/',manifest=JSON.parse(readFileSync(root+'tank_parts/appearances.json','utf8'));let parts=0;
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));const file=(path:string)=>assert.ok(existsSync(root+path),path);
for(const [family,styles]of Object.entries(manifest.parts)as[string,string[]][]){
 assert.deepEqual(styles,['gen2','old']);
 for(const style of styles)for(let mod=0;mod<4;mod++){
  const relative=`${family}/m${mod}`,path=`tank_parts/styles/${style}/${relative}`;
  const data=json(root+path+'/part.json');let canonical=root+'tank_parts/'+relative+'/part.json';if(!existsSync(canonical))canonical=root+'tank_parts/'+family+'/m0/part.json';const base=json(canonical);
  assert.deepEqual(data.spec,base.spec);assert.deepEqual(data.physicalObjects,base.objects,'physical points/hitboxes stay canonical');
  const role=family.startsWith('hulls/')?/hull/i:/turret/i,visual=data.objects.find((o:any)=>role.test(o.name)),physical=appearancePhysicsMesh(visual,data.physicalObjects);
  assert.deepEqual(physical,base.objects.find((o:any)=>role.test(o.name)),'case/name variants must select the same physical root');
  if(family.startsWith('turrets/'))assert.deepEqual(turretHitGeometry(data.physicalObjects),turretHitGeometry(base.objects));
  for(const name of ['details.png','lightmap.jpg','preview.png'])file(path+'/'+name);parts++;
 }
}
assert.equal(parts,128);assert.equal(appearancePartPath('turrets/thunder/m2'),'styles/gen2/turrets/thunder/m2');
for(let mod=0;mod<4;mod++)for(const style of ['gen2','old']){
 const source=`assets/cosmetic_variants_src/Turrets/thunder/${style==='old'?'old/':''}m${mod}/details.png`,target=root+`tank_parts/styles/${style}/turrets/thunder/m${mod}/details.png`;assert.deepEqual(readFileSync(target),readFileSync(source));
}
for(const atlas of manifest.effects){const info=json(root+atlas.path+'/info.json'),image=readFileSync(root+atlas.path+'/image.png');assert.equal(image.readUInt32BE(16),atlas.size[0]);assert.equal(image.readUInt32BE(20),atlas.size[1]);const frames=getUVFramesFromTexture(...atlas.size,info.frame_width,info.frame_height,info.num_frames);assert.equal(frames.length,info.num_frames,atlas.path);for(const f of frames)assert.ok(f.u0>=0&&f.v0>=0&&f.u1<=1.0000001&&f.v1<=1.0000001);}
for(const style of ['gen2','old']as const){const media=appearanceMedia(style);
 for(const kind of ['smoky','thunder','shaft'])for(const name of ['image.jpg','alpha.jpg'])file(`${media}/images/turrets/${kind}/m0/explosion_mark/${name}`);
 for(const name of ['image.jpg','alpha.jpg'])file(`${media}/images/turrets/twins/m0/hit_mark/${name}`);
 for(let mod=0;mod<4;mod++){for(const kind of ['smoky','thunder'])file(`${media}/images/turrets/${kind}/m${mod}/shot/image.png`);for(const name of ['muzzle_flash'])file(`${media}/images/turrets/twins/m${mod}/${name}/image.png`);for(const name of ['trail','muzzle_flash'])file(`${media}/images/turrets/ricochet/m${mod}/${name}/image.png`);for(const name of ['heal_shaft','damage_shaft'])file(`${media}/images/turrets/isida/m${mod}/${name}/image.png`);for(const name of ['lighting.json','color-transform.json'])file(`${media}/multiframe/turrets/firebird/m${mod}/fire/${name}`);for(const name of ['charge.png','trail.png'])file(`${media}/railgun/m${mod}/${name}`);}
 for(const path of ['firebird/flame.mp3','freeze/freeze.mp3','isida/idle.mp3','isida/damage.mp3','isida/healing.mp3','smoky/m0/shot.mp3','smoky/m0/explosion.mp3','twins/m0/shot.mp3','thunder/m0/shot.mp3','thunder/m0/explosion.mp3','ricochet/m0/shot.mp3','ricochet/m0/ricochet.mp3','ricochet/m0/explosion.mp3','shaft/m0/shot.mp3','shaft/m0/explosion.mp3','shaft/m0/scope.mp3','shaft/m0/targeting.mp3'])file(`${media}/sounds/turrets/${path}`);
 for(const path of ['info.json','shot.mp3','rings.png','pow.png','hit_mark.png'])file(`${media}/railgun/${path}`);
}
console.log(`Cosmetic assets: ${parts} UV-compatible parts, canonical bounds/spec/points/hitboxes, exact Thunder source textures, ${manifest.effects.length} valid atlases and complete loader/audio paths OK`);

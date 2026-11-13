// Narukami TurretSkinCacheItem.parseGeometry / TurretGeometryItem.
import {Matrix4} from '../../physics/math/Matrix4.ts';
import {Vector3} from '../../physics/math/Vector3.ts';
import type {PartObject} from '../render/TankSkin.ts';
export interface TurretHitBox {halfSize:Vector3;transform:Matrix4}
export function turretHitGeometry(objects:readonly PartObject[]):TurretHitBox[] {
  const boxes=objects.filter(o=>/box.*/i.test(o.name)&&o.positions?.length);
  const source=boxes.length?boxes:objects.filter(o=>o.positions?.length&&!/(box.*|fmnt.*|muzzle.*|laser|rocket)/i.test(o.name));
  return source.map(o=>{
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],vertices=o.positions!;
    for(let i=0;i<vertices.length;i++) {const axis=i%3;min[axis]=Math.min(min[axis],vertices[i]);max[axis]=Math.max(max[axis],vertices[i]);}
    // Our exported root retains the editor translation; TankSkin mounts its mesh at zero.
    const pos=o.parent?o.position:[0,0,0],r=o.rotation;
    const transform=new Matrix4();transform.setMatrix((min[0]+max[0])/2+pos[0],(min[1]+max[1])/2+pos[1],(min[2]+max[2])/2+pos[2],r[0],r[1],r[2]);
    return {halfSize:new Vector3((max[0]-min[0])/2,(max[1]-min[1])/2,(max[2]-min[2])/2),transform};
  }).filter(b=>b.halfSize.x>0&&b.halfSize.y>0&&b.halfSize.z>0);
}

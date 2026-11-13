import type {PartObject} from './TankSkin.ts';
/** Old assets use names such as Hull/turret_Vol; keep the canonical physical root by role. */
export function appearancePhysicsMesh(visual:PartObject,physical:readonly PartObject[]|undefined):PartObject{
 const role=/hull/i.test(visual.name)?/hull/i:/turret/i;
 return physical?.find(object=>object.name.toLowerCase()===visual.name.toLowerCase())??physical?.find(object=>role.test(object.name)&&object.positions?.length)??visual;
}

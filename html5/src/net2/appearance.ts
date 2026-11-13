/** Cosmetic generation is independent of equipment levels and gameplay values. */
export type AppearanceStyle='gen2'|'old';
export type AppearanceMap=Record<string,AppearanceStyle>;
export const ORIGINAL_TURRETS=['smoky','twins','firebird','railgun','isida','thunder','freeze','ricochet','shaft'] as const;
export const ORIGINAL_HULLS=['wasp','hunter','titan','dictator','hornet','viking','mammoth'] as const;
export function appearanceFamily(path:string):string|null{
 const match=/(hulls|turrets)\/([a-z_]+)\/m[0-3](?:\/|$)/.exec(path);if(!match)return null;
 const names:readonly string[]=match[1]==='hulls'?ORIGINAL_HULLS:ORIGINAL_TURRETS;
 return names.includes(match[2])?`${match[1]}/${match[2]}`:null;
}
export function appearancePartPath(path:string,style:AppearanceStyle='gen2'):string{return appearanceFamily(path)?`styles/${style}/${path}`:path;}
export function appearanceFor(path:string,styles:AppearanceMap|undefined):AppearanceStyle{return styles?.[appearanceFamily(path)??'']??'gen2';}
export function appearanceMedia(style:AppearanceStyle):string{return `battle/styles/${style}`;}

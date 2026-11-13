import type {BattleRules} from '../../../html5/src/net2/protocol.ts';
import {RequestError} from '../errors.ts';
export const RULE_DEFAULTS={autoBalance:true,friendlyFire:false,withoutBonuses:false,withoutCrystals:false,withoutSupplies:false,withoutMines:false,withoutMedkit:false,withoutGoldBoxes:false,withoutGoldSiren:false,withoutUpgrades:false,privateBattle:false} as const;
export function battleRules(args:Record<string,unknown>):BattleRules {
 const rules:Record<string,unknown>={};
 for(const [key,fallback] of Object.entries(RULE_DEFAULTS)){const value=args[key]??fallback;if(typeof value!=='boolean')throw new RequestError('bad_request',`параметр ${key}: требуется флажок`);rules[key]=value;}
 const format=args.equipmentConstraintsMode??'NONE';
 if(!['NONE','HORNET_RAILGUN','WASP_RAILGUN','HORNET_WASP_RAILGUN'].includes(String(format)))throw new RequestError('bad_request','этот формат пока недоступен');
 rules.equipmentConstraintsMode=format;
 for(const key of ['esportDropTiming','goldZone','parkourMode','reArmorEnabled','reducedResistances','randomGold','withoutGoldZone','dependentCooldownEnabled','clanBattle','ultimatesEnabled'])if(args[key]===true)throw new RequestError('bad_request',`модификатор ${key} ещё не поддерживается`);
 return rules as BattleRules;
}
export function equipmentAllowed(rules:BattleRules,hull:string|undefined,weapon:string):boolean {
 switch(rules.equipmentConstraintsMode??'NONE'){
  case 'HORNET_RAILGUN':return hull==='hornet'&&weapon==='railgun';
  case 'WASP_RAILGUN':return hull==='wasp'&&weapon==='railgun';
  case 'HORNET_WASP_RAILGUN':return (hull==='hornet'||hull==='wasp')&&weapon==='railgun';
  default:return true;
 }
}

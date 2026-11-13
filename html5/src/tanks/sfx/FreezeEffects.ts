// ReTanki particle movement with original TO Gen 2 per-modification atlases.
import {RetankiFreezeFactory} from './RetankiFreezeEffect.ts';
import type {SoundManager} from './Sound.ts';
import type {EffectsScene} from './SmokyEffects.ts';
export class FreezeEffectFactory{
 private constructor(private factory:RetankiFreezeFactory){}
 static async load(base:string,mod:number,sounds:SoundManager):Promise<FreezeEffectFactory>{return new FreezeEffectFactory(await RetankiFreezeFactory.load(base,sounds,mod));}
 create(scene:EffectsScene){return this.factory.create(scene);}
}

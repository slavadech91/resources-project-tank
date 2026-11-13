import { FreezeEffectFactory } from './FreezeEffects.ts';
import { FlamethrowerEffectFactory } from './FlamethrowerEffects.ts';
import type { Tank } from '../tank/Tank.ts';
// Separate factories using Narukami stream geometry and per-modification media.
import type { Body } from '../../physics/Body.ts';
import { IsidaEffectFactory } from './IsidaEffects.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { SoundManager } from './Sound.ts';
import { EffectsScene, type GraphicEffect } from './SmokyEffects.ts';

export interface ContinuousEffect extends GraphicEffect {
  aim(from: Vector3, direction: Vector3, tank?: Tank): void;
  configure?(range: number, cone: number): void;
  setTarget(to: Vector3 | null, healing: boolean, body?: Body | null): void;
  start(): void; stop(): void; setBuffedMode?(value: boolean): void;
}

export type StreamKind = 'firebird' | 'freeze' | 'isida';

interface StreamData { kind:StreamKind; particle:null; muzzle:null; sound:null }
export class StreamEffectFactory {
  static async load(kind: StreamKind, base: string, soundManager: SoundManager, modification = 0): Promise<StreamEffectFactory> {
    if (kind === 'isida') return new StreamEffectFactory({ kind, particle: null, muzzle: null, sound: null }, soundManager, await IsidaEffectFactory.load(base, modification, soundManager));
    if (kind === 'firebird') return new StreamEffectFactory({kind,particle:null,muzzle:null,sound:null},soundManager,null,await FlamethrowerEffectFactory.load(base,modification,soundManager));
    return new StreamEffectFactory({kind,particle:null,muzzle:null,sound:null},soundManager,null,null,await FreezeEffectFactory.load(base,modification,soundManager));
  }

  private constructor(
    private readonly data: StreamData,
    _soundManager: SoundManager,
    private readonly isidaFactory: IsidaEffectFactory | null = null,
    private readonly flameFactory: FlamethrowerEffectFactory | null = null,
    private readonly freezeFactory: FreezeEffectFactory | null = null,
  ) {}

  get kind(): StreamKind { return this.data.kind; }

  create(scene: EffectsScene): ContinuousEffect {
    if (this.flameFactory) return this.flameFactory.create(scene);
    if (this.isidaFactory) return this.isidaFactory.create(scene);
    if (this.freezeFactory) return this.freezeFactory.create(scene);
    throw new Error("Missing stream effect factory");
  }
}

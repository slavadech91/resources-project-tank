import { ShaftAimSounds } from './ShaftAimSounds.ts';
import { ShaftMuzzleFlash } from './ShaftMuzzleFlash.ts';
// Shaft: modification-specific muzzle and impact. No connecting trail (user original-game reference).
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { Matrix4 } from '../../physics/math/Matrix4.ts';
import { Sound3D, Sound3DEffect, SoundOptions, type Sound, type SoundManager } from './Sound.ts';
import { AnimatedSpriteEffect, EffectsScene, loadAnimation, loadEffectTexture, type TextureAnimation } from './SmokyEffects.ts';

const EXPLOSION_SIZE = 200;
const EXPLOSION_OFFSET_TO_CAMERA = 110;
const MARK_RADIUS = 50;


interface ShaftSFXData {
  muzzleFlashAnimation: TextureAnimation;
  explosionAnimation: TextureAnimation;
  markMaterial: THREE.MeshLambertMaterial;
  shotSound: Sound;
  explosionSound: Sound;
  scopeSound: Sound;
  targetingSound: Sound;
}

export class ShaftEffects {
  private constructor(
    private readonly soundManager: SoundManager,
    private readonly scene: EffectsScene,
    private readonly data: ShaftSFXData,
    readonly modification:number,
  ) {}

  static async load(base: string, soundManager: SoundManager, scene: EffectsScene,modification=0): Promise<ShaftEffects> {
    const engine = soundManager.engine;
    const [muzzleFlashAnimation, explosionAnimation, markTexture, shotSound, explosionSound, scopeSound, targetingSound] = await Promise.all([
      loadAnimation(`${base}/multiframe/turrets/shaft/m${modification}/muzzle_flash`,true),
      loadAnimation(`${base}/multiframe/turrets/shaft/m${modification}/explosion`,true),
      loadEffectTexture(`${base}/images/turrets/shaft/m0/explosion_mark`),
      engine.load(`${base}/sounds/turrets/shaft/m0/shot.mp3`),
      engine.load(`${base}/sounds/turrets/shaft/m0/explosion.mp3`),
      engine.load(`${base}/sounds/turrets/shaft/m0/scope.mp3`),
      engine.load(`${base}/sounds/turrets/shaft/m0/targeting.mp3`),
    ]);
    const markMaterial = new THREE.MeshLambertMaterial({
      map: markTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    return new ShaftEffects(soundManager, scene, { muzzleFlashAnimation, explosionAnimation, markMaterial, shotSound, explosionSound, scopeSound, targetingSound },modification);
  }

  startAimSounds(position:()=>Vector3,volume:()=>number=()=>1,active:()=>boolean=()=>true):ShaftAimSounds{
    return new ShaftAimSounds(this.soundManager,this.data.scopeSound,this.data.targetingSound,position,volume,active);
  }

  /** выстрел: вспышка на дуле (VFX ShaftShootSFXModel) и звук */
  createShotEffects(localMuzzle: Vector3, turretMatrix: Matrix4): void {
    this.soundManager.addEffect(new Sound3DEffect(new Vector3(turretMatrix.d, turretMatrix.h, turretMatrix.l), new Sound3D(this.data.shotSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, 1)));
    this.scene.addGraphicEffect(new ShaftMuzzleFlash(this.scene.parent,this.data.muzzleFlashAnimation.texture,localMuzzle.clone(),turretMatrix));
  }

  /** Reference selected by the user: muzzle and impact only, no connecting trail. */
  createShotTrail(_from:Vector3,_to:Vector3|null):void{}

  createExplosionEffects(position: Vector3): void {
    this.soundManager.addEffect(new Sound3DEffect(position, new Sound3D(this.data.explosionSound, SoundOptions.nearRadius * 2, SoundOptions.farRadius * 2, SoundOptions.farDelimiter, 1), 80));
    this.scene.addGraphicEffect(new AnimatedSpriteEffect(this.scene.parent, this.data.explosionAnimation, EXPLOSION_SIZE, position.clone(), EXPLOSION_OFFSET_TO_CAMERA,1,0,null,0,130,0xffffff,500));
  }

  createExplosionMark(barrelOrigin: Vector3, position: Vector3): void {
    this.scene.addDecal(position, barrelOrigin, MARK_RADIUS, this.data.markMaterial);
  }
}

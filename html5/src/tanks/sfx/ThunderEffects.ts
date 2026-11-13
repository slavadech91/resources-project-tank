import {ThunderShotEffect} from './ThunderShotEffect.ts';
// Эффекты Грома: models/weapon/thunder/sfx/ThunderEffects.as + ThunderSFXModel.
// Narukami: три спрайта и три луча у дула, один разрыв в точке контакта,
// след только на статике и звук взрыва без задержки. Критов у Грома нет.
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { Matrix4 } from '../../physics/math/Matrix4.ts';
import { AnimatedLightEffect, LIGHTING } from '../../render/DynamicLights.ts';
import { Sound3D, Sound3DEffect, SoundOptions, type Sound, type SoundManager } from './Sound.ts';
import { AnimatedSpriteEffect, EffectsScene, loadAnimation, loadEffectTexture, type ShotEffects, type TextureAnimation } from './SmokyEffects.ts';

const SHOT_SOUND_VOLUME = 0.7;
const EXPLOSION_SIZE = 1000;
const EXPLOSION_OFFSET_TO_CAMERA = 110;
const EXPLOSION_SOUND_DELAY = 0;
const MARK_RADIUS = 250;

interface ThunderSFXData {
  muzzleFlashMaterial: THREE.Material;
  explosionAnimation: TextureAnimation;
  markMaterial: THREE.MeshLambertMaterial;
  shotSound: Sound;
  explosionSound: Sound;
}

export class ThunderEffects implements ShotEffects {
  private constructor(
    private readonly soundManager: SoundManager,
    private readonly scene: EffectsScene,
    private readonly data: ThunderSFXData,
  ) {}

  static async load(base: string, soundManager: SoundManager, scene: EffectsScene,mod=0): Promise<ThunderEffects> {
    const engine = soundManager.engine;
    const [shotTexture, explosionAnimation, markTexture, shotSound, explosionSound] = await Promise.all([
      loadEffectTexture(`${base}/images/turrets/thunder/m${mod}/shot`,base.includes('/styles/')),
      loadAnimation(`${base}/multiframe/turrets/thunder/m${mod}/explosion`,base.includes('/styles/')),
      loadEffectTexture(`${base}/images/turrets/thunder/m0/explosion_mark`),
      engine.load(`${base}/sounds/turrets/thunder/m0/shot.mp3`),
      engine.load(`${base}/sounds/turrets/thunder/m0/explosion.mp3`),
    ]);
    const muzzleFlashMaterial = new THREE.MeshBasicMaterial({ map: shotTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const markMaterial = new THREE.MeshLambertMaterial({
      map: markTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    return new ThunderEffects(soundManager, scene, { muzzleFlashMaterial, explosionAnimation, markMaterial, shotSound, explosionSound });
  }

  createShotEffects(localMuzzle: Vector3, turretMatrix: Matrix4): void {
    const sound = new Sound3D(this.data.shotSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, SHOT_SOUND_VOLUME);
    const muzzle=new Vector3();turretMatrix.transformVector(localMuzzle,muzzle);
    this.soundManager.addEffect(new Sound3DEffect(muzzle, sound));
    this.scene.addGraphicEffect(
      new ThunderShotEffect(this.scene.parent, localMuzzle.clone(), turretMatrix, this.data.muzzleFlashMaterial),
    );
    const lightMuzzle = localMuzzle.clone();
    const lightPosition = new Vector3();
    this.scene.addGraphicEffect(new AnimatedLightEffect(LIGHTING.thunder.shot, () => {
      turretMatrix.transformVector(lightMuzzle, lightPosition);
      return lightPosition;
    }));
  }

  createExplosionEffects(position: Vector3): void {
    const sound = new Sound3D(this.data.explosionSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, 0.7);
    this.soundManager.addEffect(new Sound3DEffect(position, sound, EXPLOSION_SOUND_DELAY));
    this.scene.addGraphicEffect(
      new AnimatedSpriteEffect(this.scene.parent, this.data.explosionAnimation, EXPLOSION_SIZE, position.clone(), EXPLOSION_OFFSET_TO_CAMERA,1,Math.random()*Math.PI*2),
    );
    const impact = position.clone();
    const lightPosition = new Vector3();
    this.scene.addGraphicEffect(new AnimatedLightEffect(LIGHTING.thunder.hit, (cameraPosition) => {
      if (!cameraPosition) return impact;
      return lightPosition.diff(cameraPosition, impact).normalize().scale(EXPLOSION_OFFSET_TO_CAMERA).add(impact);
    }));
  }

  createExplosionMark(barrelOrigin: Vector3, position: Vector3): void {
    this.scene.addDecal(position, barrelOrigin, MARK_RADIUS, this.data.markMaterial);
  }
}

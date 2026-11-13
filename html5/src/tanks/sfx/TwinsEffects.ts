// Эффекты Twins: models/weapon/plasma/PlasmaEffects.as + TwinsSFXModel.as + графика PlasmaShot.as
// (спрайт шара, взрыв, след на статике). BCSH у Twins M0 нулевой ("def"), поэтому картинки берутся как есть.
// Не перенесены: вспышки света (AnimatedLightEffect «shot», «bullet», «hit»).
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { Matrix4 } from '../../physics/math/Matrix4.ts';
import {
  AnimatedSpriteEffect,
  EffectsScene,
  PlaneMuzzleFlashEffect,
  RenderOrder,
  TextureAnimation,
  loadAnimation,
  loadEffectTexture,
} from './SmokyEffects.ts';
import { Sound3D, Sound3DEffect, SoundOptions, type Sound, type SoundManager } from './Sound.ts';

/** PlasmaEffects: размер вспышки (§3A§) и её время (§?";§, мс) */
const MUZZLE_FLASH_SIZE = 120;
const MUZZLE_FLASH_TIME = 50;
/** PlasmaEffects.createSoundEffect */
const SHOT_SOUND_VOLUME = 0.8;

/** PlasmaShotParams */
export const PlasmaShotParams = {
  SHOT_SIZE: 250, // §!!D§
  EXPLOSION_SIZE: 300, // §0"H§
  EXPLOSION_OFFSET_TO_CAMERA: 110, // §2"P§
  FADE_DISTANCE: 500, // §<"U§ — шар гаснет на последних 500 единицах дальности
  DECAL_RADIUS: 100, // §?o§
};



export class TwinsEffects {
  private constructor(
    private readonly soundManager: SoundManager,
    readonly scene: EffectsScene,
    private readonly muzzleFlashMaterial: THREE.Material,
    readonly shotAnimation: TextureAnimation,
    private readonly explosionAnimation: TextureAnimation,
    private readonly hitMarkMaterial: THREE.Material,
    private readonly shotSound: Sound,
  ) {}

  static async load(soundManager: SoundManager, scene: EffectsScene,base='battle',mod=0): Promise<TwinsEffects> {
    const [flashTexture, shotAnimation, explosionAnimation, markTexture, shotSound] = await Promise.all([
      loadEffectTexture(`${base}/images/turrets/twins/m${mod}/muzzle_flash`,base.includes('/styles/')),
      loadAnimation(`${base}/multiframe/turrets/twins/m${mod}/shot`,base.includes('/styles/')),
      loadAnimation(`${base}/multiframe/turrets/twins/m${mod}/explosion`,base.includes('/styles/')),
      loadEffectTexture(`${base}/images/turrets/twins/m0/hit_mark`),
      soundManager.engine.load(`${base}/sounds/turrets/twins/m0/shot.mp3`),
    ]);
    const muzzleFlashMaterial = new THREE.MeshBasicMaterial({ map: flashTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const hitMarkMaterial = new THREE.MeshLambertMaterial({
      map: markTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    return new TwinsEffects(soundManager, scene, muzzleFlashMaterial, shotAnimation, explosionAnimation, hitMarkMaterial, shotSound);
  }

  /** PlasmaEffects.createShotEffects: вспышка у дула ствола и звук в позиции башни */
  createShotEffects(localMuzzle: Vector3, turretMatrix: Matrix4): void {
    this.scene.addGraphicEffect(
      new PlaneMuzzleFlashEffect(this.scene.parent, localMuzzle.clone(), turretMatrix, this.muzzleFlashMaterial, MUZZLE_FLASH_TIME, MUZZLE_FLASH_SIZE, MUZZLE_FLASH_SIZE),
    );
    const sound = new Sound3D(this.shotSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, SHOT_SOUND_VOLUME);
    this.soundManager.addEffect(new Sound3DEffect(new Vector3(turretMatrix.d, turretMatrix.h, turretMatrix.l), sound));
  }

  /** PlasmaShot.createExplosionEffect: размер растёт с коэффициентом ослабления, случайный поворот */
  createExplosion(position: Vector3, impactCoeff: number): void {
    const size = (PlasmaShotParams.EXPLOSION_SIZE * (1 + impactCoeff)) / 2;
    this.scene.addGraphicEffect(
      new AnimatedSpriteEffect(
        this.scene.parent,
        this.explosionAnimation,
        size,
        position.clone(),
        PlasmaShotParams.EXPLOSION_OFFSET_TO_CAMERA,
        1,
        Math.random() * 2 * Math.PI,
      ),
    );
  }

  /** PlasmaShot.createHitMark: след на статике (DecalEffect) */
  createHitMark(position: Vector3, barrelOrigin: Vector3): void {
    this.scene.addDecal(position, barrelOrigin, PlasmaShotParams.DECAL_RADIUS, this.hitMarkMaterial);
  }
}

/** AnimatedSprite3D шара плазмы: общий атлас, кадр, поворот и прозрачность задаёт PlasmaShot */
export class PlasmaSprite {
  private readonly sprite: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;

  constructor(
    parent: THREE.Object3D,
    private readonly animation: TextureAnimation,
  ) {
    this.material = new THREE.SpriteMaterial({ map: animation.frameTexture(0), transparent: true, depthWrite: false, fog: false });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.set(PlasmaShotParams.SHOT_SIZE, PlasmaShotParams.SHOT_SIZE, 1);
    this.sprite.renderOrder = RenderOrder.EFFECTS;
    parent.add(this.sprite);
  }

  get numFrames(): number {
    return this.animation.frames.length;
  }

  get fps(): number {
    return this.animation.fps;
  }

  update(position: Vector3, frameIndex: number, rotation: number, alpha: number): void {
    this.material.map = this.animation.frameTexture(frameIndex);
    this.material.rotation = rotation;
    this.material.opacity = alpha;
    this.sprite.position.set(position.x, position.y, position.z);
  }

  destroy(): void {
    this.sprite.removeFromParent();
    this.material.dispose();
  }
}

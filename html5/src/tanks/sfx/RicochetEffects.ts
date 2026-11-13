// Эффекты Рикошета по оригиналу: RicochetSFXData/RicochetShot/RicochetEffects (2014) и Narukami.
// Ассеты — TO-Assets Turrets/ricochet (m0–m3): шар 10 кадров по 150 px, взрыв 20 по 200 px,
// хвост 512×32, звуки выстрела, отскока и взрыва. Muzzle Gen 2 — обращённый к камере спрайт 150×150 на 100 мс; привязка к башне.
// Спрайт шара 300, взрыв 266, вспышка отскока 80, хвост 100×300; у чужих выстрелов те же эффекты.
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { Matrix4 } from '../../physics/math/Matrix4.ts';
import { makeSoftParticle } from '../../render/BattleRenderer.ts';
import { Sound3D, Sound3DEffect, SoundOptions, type Sound, type SoundManager } from './Sound.ts';
import {
  AnimatedSpriteEffect,
  type GraphicEffect,
  EffectsScene,
  RenderOrder,
  loadAnimation,
  loadEffectTexture,
  type TextureAnimation,
} from './SmokyEffects.ts';

/** RicochetShot: SPRITE_SIZE, EXPLOSION_SPRITE_SIZE, TRAIL_WIDTH */
const BALL_SIZE = 300;
const EXPLOSION_SIZE = 266;
const BUMP_SIZE = 80;
const TRAIL_WIDTH = 100;
const TRAIL_LENGTH = 300;
/** addSoundEffect: громкость выстрела, отскока и взрыва */
const SOUND_VOLUME = 0.8;
const MODS = 4;

/** RicochetShot.render: спрайт шара, вращающийся хвост и затухание хвоста по углу к камере */
export class RicochetBall {
  private readonly sprite: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;
  private readonly trail: THREE.Mesh;
  private readonly trailMaterial: THREE.MeshBasicMaterial;
  private frame: number;
  private rotation: number;
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();
  private readonly trailPosition = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    private readonly animation: TextureAnimation,
    trailTexture: THREE.Texture,
  ) {
    this.material = new THREE.SpriteMaterial({ map: animation.frameTexture(0), transparent: true, depthWrite: false, fog: false });
    makeSoftParticle(this.material, 90);
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.set(BALL_SIZE, BALL_SIZE, 1);
    this.sprite.renderOrder = RenderOrder.EFFECTS;
    this.frame = Math.random() * animation.frames.length;
    this.rotation = Math.random() * Math.PI * 2;
    this.material.rotation = this.rotation;
    parent.add(this.sprite);

    this.trailMaterial = new THREE.MeshBasicMaterial({
      map: trailTexture,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    makeSoftParticle(this.trailMaterial, 50);
    this.trail = new THREE.Mesh(new THREE.PlaneGeometry(TRAIL_LENGTH, TRAIL_WIDTH), this.trailMaterial);
    this.trail.matrixAutoUpdate = false;
    this.trail.frustumCulled = false;
    this.trail.renderOrder = RenderOrder.EFFECTS;
    parent.add(this.trail);
  }

  /** position — интерполированная точка шара, direction — текущее направление полёта */
  update(delta: number, position: Vector3, direction: Vector3, alpha: number, cameraPosition: Vector3): void {
    this.frame += delta * 0.001 * this.animation.fps;
    if (this.frame >= this.animation.frames.length) this.frame %= this.animation.frames.length;
    this.material.map = this.animation.frameTexture(this.frame);
    this.rotation -= 0.003 * delta;
    this.material.rotation = this.rotation;
    const size = BALL_SIZE * alpha;
    this.sprite.scale.set(size, size, 1);
    this.sprite.position.set(position.x, position.y, position.z);

    // SFXUtils.alignObjectPlaneToView: длинная ось плоскости — вдоль полёта, нормаль — к камере
    this.axisX.set(direction.x, direction.y, direction.z).normalize();
    this.toCamera.set(cameraPosition.x - position.x, cameraPosition.y - position.y, cameraPosition.z - position.z);
    this.axisZ.copy(this.toCamera).addScaledVector(this.axisX, -this.toCamera.dot(this.axisX));
    if (this.axisZ.lengthSq() < 1e-8) this.axisZ.set(0, 0, 1);
    else this.axisZ.normalize();
    this.axisY.crossVectors(this.axisZ, this.axisX).normalize();
    this.trailPosition.set(position.x, position.y, position.z).addScaledVector(this.axisX, -TRAIL_LENGTH * 0.5);
    this.trail.matrix.makeBasis(this.axisX, this.axisY, this.axisZ);
    this.trail.matrix.setPosition(this.trailPosition);
    this.trail.matrixWorldNeedsUpdate = true;

    // хвост виден хуже, когда камера смотрит вдоль полёта (RicochetShot.render)
    let trailAlpha = alpha;
    const length = this.toCamera.length();
    if (length > 1e-3) {
      const dot = Math.abs((this.toCamera.x * direction.x + this.toCamera.y * direction.y + this.toCamera.z * direction.z) / length);
      if (dot > 0.5) trailAlpha = 2 * (1 - dot) * alpha;
    }
    this.trailMaterial.opacity = Math.max(0, Math.min(1, trailAlpha));
  }

  destroy(): void {
    this.sprite.removeFromParent();
    this.material.dispose();
    this.trail.removeFromParent();
    this.trail.geometry.dispose();
    this.trailMaterial.dispose();
  }
}

/** Gen 2 radial flash: camera-facing sprite, following the turret for the entire 100ms.
 * Deliberate deviation from Narukami's longitudinal PlaneMuzzleFlashEffect: that plane
 * foreshortens the circular texture when viewed from behind the barrel.
 */
class RicochetMuzzleFlash implements GraphicEffect {
  private readonly sprite: THREE.Sprite;
  private readonly local: Vector3;
  private readonly position = new Vector3();
  private elapsed = 0;
  constructor(parent: THREE.Object3D, local: Vector3, private readonly matrix: Matrix4, material: THREE.SpriteMaterial) {
    this.local = local.clone();
    this.sprite = new THREE.Sprite(material);
    this.sprite.scale.set(150,150,1);
    this.sprite.renderOrder = RenderOrder.EFFECTS;
    parent.add(this.sprite);
    this.updatePosition();
  }
  private updatePosition(): void {
    this.matrix.transformVector(this.local,this.position);
    this.sprite.position.set(this.position.x,this.position.y,this.position.z);
  }
  play(delta: number): boolean {
    if (this.elapsed >= 100) return false;
    this.elapsed += delta;
    this.updatePosition();
    return true;
  }
  destroy(): void { this.sprite.removeFromParent(); }
}

interface RicochetSFXData {
  shotAnimation: TextureAnimation;
  explosionAnimation: TextureAnimation;
  trailTexture: THREE.Texture;
  muzzleMaterial: THREE.SpriteMaterial;
  shotSound: Sound;
  ricochetSound: Sound;
  explosionSound: Sound;
}

export class RicochetEffects {
  private constructor(
    private readonly soundManager: SoundManager,
    readonly scene: EffectsScene,
    private readonly data: RicochetSFXData,
    /** модификация пушки (m0–m3), по ней выбраны текстуры */
    readonly modification: number,
  ) {}

  static async load(base: string, soundManager: SoundManager, scene: EffectsScene, modification = 0): Promise<RicochetEffects> {
    const mod = Math.max(0, Math.min(MODS - 1, Math.trunc(modification)));
    const engine = soundManager.engine;
    const [shotAnimation, explosionAnimation, trailTexture, muzzleTexture, shotSound, ricochetSound, explosionSound] = await Promise.all([
      loadAnimation(`${base}/multiframe/turrets/ricochet/m${mod}/shot`, true),
      loadAnimation(`${base}/multiframe/turrets/ricochet/m${mod}/explosion`, true),
      loadEffectTexture(`${base}/images/turrets/ricochet/m${mod}/trail`, true),
      loadEffectTexture(`${base}/images/turrets/ricochet/m${mod}/muzzle_flash`, true),
      engine.load(`${base}/sounds/turrets/ricochet/m0/shot.mp3`),
      engine.load(`${base}/sounds/turrets/ricochet/m0/ricochet.mp3`),
      engine.load(`${base}/sounds/turrets/ricochet/m0/explosion.mp3`),
    ]);
    return new RicochetEffects(
      soundManager,
      scene,
      { shotAnimation, explosionAnimation, trailTexture, shotSound, ricochetSound, explosionSound,
        muzzleMaterial: new THREE.SpriteMaterial({ map: muzzleTexture, transparent: true, depthWrite: false, fog: false }) },
      mod,
    );
  }

  get parent(): THREE.Object3D {
    return this.scene.parent;
  }

  createBall(): RicochetBall {
    return new RicochetBall(this.scene.parent, this.data.shotAnimation, this.data.trailTexture);
  }

  /** Gen 2 billboard adaptation: source size/lifetime and turret attachment, without foreshortening. */
  createShotEffects(localMuzzle: Vector3, turretMatrix: Matrix4): void {
    this.scene.addGraphicEffect(new RicochetMuzzleFlash(this.scene.parent, localMuzzle, turretMatrix, this.data.muzzleMaterial));
    const muzzle = new Vector3();
    turretMatrix.transformVector(localMuzzle, muzzle);
    this.playSound(this.data.shotSound, muzzle);
  }

  /** RicochetShot.createBumpEffects: вспышка 80 и звук отскока */
  createBounceEffects(position: Vector3): void {
    this.scene.addGraphicEffect(
      new AnimatedSpriteEffect(this.scene.parent, this.data.explosionAnimation, BUMP_SIZE, position.clone(), 50, 1, Math.random() * Math.PI * 2),
    );
    this.playSound(this.data.ricochetSound, position);
  }

  /** RicochetShot.createExplosionEffect: взрыв 266 и звук */
  createExplosionEffects(position: Vector3): void {
    this.scene.addGraphicEffect(
      new AnimatedSpriteEffect(this.scene.parent, this.data.explosionAnimation, EXPLOSION_SIZE, position.clone(), 50, 1, Math.random() * Math.PI * 2),
    );
    this.playSound(this.data.explosionSound, position);
  }

  private playSound(sound: Sound, position: Vector3): void {
    this.soundManager.addEffect(
      new Sound3DEffect(position.clone(), new Sound3D(sound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, SOUND_VOLUME)),
    );
  }
}

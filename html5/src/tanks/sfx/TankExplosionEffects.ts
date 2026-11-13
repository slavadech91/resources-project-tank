// Взрыв уничтоженного танка: alternativa/tanks/models/tank/explosion/TankExplosionModel.as (createExplosionEffects)
// + звук из TankModel.createDeathEffects. Ударная волна на земле, огненный взрыв и три клуба дыма, летящие вверх.
// Не перенесена вспышка света AnimatedLightEffect (в нашем освещении нет точечных источников).
import * as THREE from 'three';
import { RayHit } from '../../physics/collision/types.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { loadImageWithAlpha } from '../render/TankSkin.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import type { Tank } from '../tank/Tank.ts';
import { Sound3D, Sound3DEffect, SoundOptions, type Sound, type SoundManager } from './Sound.ts';
import { AnimatedSpriteEffect, loadAnimation, RenderOrder, type EffectsScene, type GraphicEffect, type TextureAnimation } from './SmokyEffects.ts';
import { AnimatedLightEffect, LIGHTING } from '../../render/DynamicLights.ts';

/** TankExplosionModel: размеры (при масштабе 1) в единицах карты */
const EXPLOSION_SIZE = 800;
const SMOKE_SIZE = 400;
const SHOCK_WAVE_SIZE = 1000;
/** диагональ корпуса, при которой масштаб равен 1 */
const REFERENCE_DIAGONAL = 600;
const SMOKE_SPEED = 800;
const SMOKE_SPEED_RANDOM = 200;
const SMOKE_GRAVITY = -2000;
const EXPLOSION_OFFSET_TO_CAMERA = 200;
const SHOCK_WAVE_RAY = 500;
const SHOCK_WAVE_FULL_SIZE_DISTANCE = 200;
const DEATH_SOUND_VOLUME = 1;

/** AnimatedPlaneEffect: плоскость на земле с покадровой анимацией, один проход */
class AnimatedPlaneEffect implements GraphicEffect {
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private frame = 0;
  private readonly framesPerMs: number;

  constructor(
    parent: THREE.Object3D,
    private readonly animation: TextureAnimation,
    size: number,
    position: Vector3,
    normal: Vector3,
  ) {
    const material = new THREE.MeshBasicMaterial({
      map: animation.frameTexture(0),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    this.mesh.position.set(position.x, position.y, position.z);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(normal.x, normal.y, normal.z));
    this.mesh.renderOrder = RenderOrder.EFFECTS - 1;
    this.mesh.frustumCulled = false;
    this.framesPerMs = 0.001 * animation.fps;
    parent.add(this.mesh);
  }

  play(delta: number): boolean {
    const frames = this.animation.frames;
    if (this.frame >= frames.length) return false;
    this.mesh.material.map = this.animation.frameTexture(this.frame);
    this.frame += delta * this.framesPerMs;
    return true;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const origin = new Vector3();
const down = new Vector3(0, 0, -1);
const hit = new RayHit();

export class TankExplosionEffects {
  private constructor(
    private readonly soundManager: SoundManager,
    private readonly scene: EffectsScene,
    private readonly explosion: TextureAnimation,
    private readonly shockWave: TextureAnimation,
    private readonly smoke: TextureAnimation,
    private readonly deathSound: Sound,
    /** текстура «мёртвого» танка (battle/images/dead_color) */
    readonly deadColoring: CanvasImageSource & { width: number; height: number },
  ) {}

  static async load(base: string, soundManager: SoundManager, scene: EffectsScene): Promise<TankExplosionEffects> {
    const [explosion, shockWave, smoke, deathSound, dead] = await Promise.all([
      loadAnimation(`${base}/multiframe/tank_explosion/explosion`),
      loadAnimation(`${base}/multiframe/tank_explosion/shock_wave`),
      loadAnimation(`${base}/multiframe/tank_explosion/smoke`),
      soundManager.engine.load(`${base}/sounds/tank/death_sound.mp3`),
      loadImageWithAlpha(`${base}/images/dead_color/image.jpg`, undefined),
    ]);
    return new TankExplosionEffects(soundManager, scene, explosion, shockWave, smoke, deathSound, dead as CanvasImageSource & { width: number; height: number });
  }

  /** TankModel.createDeathEffects + TankExplosionModel.createExplosionEffects для убитого танка */
  create(tank: Tank): void {
    const hull = tank.skin.hull.bounds;
    const dx = hull.maxX - hull.minX;
    const dy = hull.maxY - hull.minY;
    const dz = hull.maxZ - hull.minZ;
    const scale = Math.sqrt(dx * dx + dy * dy + dz * dz) / REFERENCE_DIAGONAL;
    const position = tank.getBody().state.position;
    origin.copy(position);

    this.createShockWave(scale);
    this.createFire(scale);
    this.createSmoke(scale);
    // HullCommonCC: свет взрыва корпуса
    const lightPosition = origin.clone();
    this.scene.addGraphicEffect(new AnimatedLightEffect(LIGHTING.tank.explosion, () => lightPosition));

    const turret = tank.skin.turretMatrix;
    const sound = new Sound3D(this.deathSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, DEATH_SOUND_VOLUME);
    this.soundManager.addEffect(new Sound3DEffect(new Vector3(turret.d, turret.h, turret.l), sound, 0));
  }

  /** ударная волна на земле под танком (луч вниз на 500) */
  private createShockWave(scale: number): void {
    const detector = this.scene.getCollisionDetector();
    if (!detector.raycastStatic(origin, down, CollisionGroup.STATIC, SHOCK_WAVE_RAY, null, hit)) return;
    const point = hit.position.clone();
    point.z += 10;
    let size = SHOCK_WAVE_SIZE;
    if (hit.t > SHOCK_WAVE_FULL_SIZE_DISTANCE) size *= (SHOCK_WAVE_RAY - hit.t) / (SHOCK_WAVE_RAY - SHOCK_WAVE_FULL_SIZE_DISTANCE);
    this.scene.addGraphicEffect(new AnimatedPlaneEffect(this.scene.parent, this.shockWave, size * scale, point, hit.normal));
  }

  private createFire(scale: number): void {
    const position = origin.clone();
    position.z += 50;
    const size = EXPLOSION_SIZE * scale;
    this.scene.addGraphicEffect(
      new AnimatedSpriteEffect(this.scene.parent, this.explosion, size, position, EXPLOSION_OFFSET_TO_CAMERA, 1, Math.random() * 2 * Math.PI),
    );
  }

  /** три клуба дыма, разлетающиеся в стороны и вверх и падающие под действием «гравитации» */
  private createSmoke(scale: number): void {
    const size = SMOKE_SIZE * scale;
    for (let n = 0; n < 3; n++) {
      const speed = SMOKE_SPEED + Math.random() * SMOKE_SPEED_RANDOM;
      const velocity = new Vector3(speed * (1 - 2 * Math.random()), speed * (1 - 2 * Math.random()), speed * 0.5 * (1 + Math.random()));
      const position = origin.clone();
      position.z += 50;
      this.scene.addGraphicEffect(new AnimatedSpriteEffect(this.scene.parent, this.smoke, size, position, 0, 1, Math.random() * 2 * Math.PI, velocity, SMOKE_GRAVITY));
    }
  }
}

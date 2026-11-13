// Эффекты Смоки: models/weapon/smoky/sfx/SmokyEffects.as + SmokySFXModel.as и используемые ими
// PlaneMuzzleFlashEffect, AnimatedSpriteEffect, StaticObject3DPositionProvider, SFXUtils.alignObjectPlaneToView,
// GraphicsUtils.getUVFramesFromTexture, DecalFactory и FadingDecalsRenderer из BattleScene3D.
// Не перенесены: вспышки света (AnimatedLightEffect — в нашем освещении нет точечных источников),
// мягкие края спрайтов (softAttenuation) и затухание следа по глубине в шейдере Decal.
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import type { Matrix4 } from '../../physics/math/Matrix4.ts';
import { RayHit } from '../../physics/collision/types.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import { loadImageWithAlpha } from '../render/TankSkin.ts';
import { Sound3D, Sound3DEffect, SoundOptions, type Sound, type SoundManager } from './Sound.ts';
import { makeSoftParticle } from '../../render/BattleRenderer.ts';
import { AnimatedLightEffect, LIGHTING } from '../../render/DynamicLights.ts';

/** SmokyEffectsParams */
const SmokyEffectsParams = {
  MUZZLE_FLASH_WIDTH: 60, // §-K§
  MUZZLE_FLASH_LENGTH: 210, // §>!!§
  SHOT_SOUND_VOLUME: 1, // §2"U§
  EXPLOSION_OFFSET_TO_CAMERA: 110, // §2"P§
  MUZZLE_FLASH_TIME: 100, // §8"H§
  EXPLOSION_SOUND_DELAY: 100, // §^!i§
  DECAL_RADIUS: 250, // §`"4§
};

/** BattleScene3D: сколько следов держим (§@!"§) и сколько гасим лишние (§9"'§, мс) */
const MAX_DECALS = 10;
const DECAL_FADE_TIME = 20000;

/** UVFrame: углы кадра, v сверху вниз как во Flash */
export interface UVFrame {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** TextureAnimation: текстура, кадры и fps (§2I§) */
export class TextureAnimation {
  private readonly frameTextures: THREE.Texture[];

  frameTexture(index: number): THREE.Texture {
    return this.frameTextures[Math.min(Math.max(0, Math.trunc(index)), this.frameTextures.length - 1)] ?? this.texture;
  }

  constructor(
    readonly texture: THREE.Texture,
    readonly frames: UVFrame[],
    readonly fps: number,
    linearInset = false,
  ) {
    // These views share a WebGL texture. Creating them here keeps the source version
    // stable while effects play, so changing the UV frame cannot upload the atlas again.
    const insetX = linearInset ? 0.5 / texture.image.width : 0;
    const insetY = linearInset ? 0.5 / texture.image.height : 0;
    if (linearInset) {
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
    }
    this.frameTextures = frames.map(frame => {
      const view = texture.clone();
      view.repeat.set(frame.u1 - frame.u0 - 2 * insetX, frame.v1 - frame.v0 - 2 * insetY);
      view.offset.set(frame.u0 + insetX, 1 - frame.v1 + insetY);
      return view;
    });
    prepareEffectTexture(texture);
  }
}

/** GraphicsUtils.getUVFramesFromTexture: кадры слева направо, сверху вниз; целочисленное деление как в AS3 */
export function getUVFramesFromTexture(width: number, height: number, frameWidth: number, frameHeight: number, numFrames: number): UVFrame[] {
  const fw = Math.min(frameWidth, width);
  const columns = Math.trunc(width / fw);
  const fh = Math.min(frameHeight, height);
  const rows = Math.trunc(height / fh);
  let count = columns * rows;
  if (numFrames > 0 && count > numFrames) count = numFrames;
  const frames: UVFrame[] = [];
  for (let row = 0; row < rows && frames.length < count; row++) {
    for (let column = 0; column < columns && frames.length < count; column++) {
      frames.push({ u0: (column * fw) / width, v0: (row * fh) / height, u1: ((column + 1) * fw) / width, v1: ((row + 1) * fh) / height });
    }
  }
  return frames;
}

export function createTexture(image: CanvasImageSource): THREE.Texture {
  const texture = image instanceof HTMLCanvasElement ? new THREE.CanvasTexture(image) : new THREE.Texture(image as HTMLImageElement);
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

let prepareEffectTexture: (texture: THREE.Texture) => void = () => {};

export function setEffectTexturePreparer(prepare: (texture: THREE.Texture) => void): void {
  prepareEffectTexture = prepare;
}

const effectTextures = new Map<string, Promise<THREE.Texture>>();
const effectAnimations = new Map<string, Promise<TextureAnimation>>();

function loadEffectAsset<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = load().catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

/** png=true — один RGBA-файл image.png (без потерь и без отдельной маски); иначе старый image.jpg + alpha.jpg */
export async function loadEffectTexture(base: string, png = false): Promise<THREE.Texture> {
  return loadEffectAsset(effectTextures, `${base}:${png}`, async () => {
    const image = png
      ? await loadImageWithAlpha(`${base}/image.png`, undefined)
      : await loadImageWithAlpha(`${base}/image.jpg`, `${base}/alpha.jpg`);
    const texture = createTexture(image);
    prepareEffectTexture(texture);
    return texture;
  });
}

interface MultiframeInfo {
  fps: number;
  frame_width: number;
  frame_height: number;
  num_frames: number;
}

/** png=true — полоса кадров в одном RGBA-файле image.png */
export async function loadAnimation(base: string, png = false, linearInset = false): Promise<TextureAnimation> {
  return loadEffectAsset(effectAnimations, `${base}:${png}:${linearInset}`, async () => {
    const [image, info] = await Promise.all([
      png
        ? loadImageWithAlpha(`${base}/image.png`, undefined)
        : loadImageWithAlpha(`${base}/image.jpg`, `${base}/alpha.jpg`),
      fetch(`${base}/info.json`).then((response) => response.json() as Promise<MultiframeInfo>),
    ]);
    const { width, height } = image as HTMLCanvasElement;
    const texture = createTexture(image);
    return new TextureAnimation(texture, getUVFramesFromTexture(width, height, info.frame_width, info.frame_height, info.num_frames), info.fps, linearInset);
  });
}

/** GraphicEffect */
export interface GraphicEffect {
  /** false — эффект закончился */
  play(delta: number, cameraPosition: Vector3): boolean;
  destroy(): void;
}

const spriteMaterialPool = new Map<number, THREE.SpriteMaterial[]>();

export function acquireEffectSpriteMaterial(texture: THREE.Texture, softAttenuation: number): THREE.SpriteMaterial {
  const reused = spriteMaterialPool.get(softAttenuation)?.pop();
  if (reused) {
    reused.map = texture;
    reused.rotation = 0;
    reused.color.setHex(0xffffff);
    return reused;
  }
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false });
  makeSoftParticle(material, softAttenuation);
  return material;
}

export function releaseEffectSpriteMaterial(material: THREE.SpriteMaterial, softAttenuation: number): void {
  let pool = spriteMaterialPool.get(softAttenuation);
  if (!pool) spriteMaterialPool.set(softAttenuation, pool = []);
  if (pool.length < 8) pool.push(material);
  else material.dispose();
}

const axisY = new Vector3();
const muzzle = new Vector3();
const toCamera = new Vector3();
const axisX = new Vector3();
const axisZ = new Vector3();

/** PlaneMuzzleFlashEffect: плоскость вдоль ствола (SimplePlane(1, 1, 0.5, 0)), повёрнутая к камере */
export class PlaneMuzzleFlashEffect implements GraphicEffect {
  private readonly mesh: THREE.Mesh;
  private timeLeft: number; // §#!`§

  constructor(
    parent: THREE.Object3D,
    private readonly localMuzzle: Vector3,
    private readonly turretMatrix: Matrix4,
    material: THREE.Material,
    time: number,
    width: number,
    length: number,
  ) {
    const x0 = -0.5 * width;
    const x1 = x0 + width;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([x0, 0, 0, x1, 0, 0, x1, length, 0, x0, length, 0], 3));
    // setUVs(0,0, 0,1, 1,1, 1,0): u вдоль ствола, v поперёк; v перевёрнут под flipY
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 1, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RenderOrder.EFFECTS;
    this.timeLeft = time;
    parent.add(this.mesh);
  }

  play(delta: number, cameraPosition: Vector3): boolean {
    if (this.timeLeft < 0) return false;
    this.timeLeft -= delta;
    const m = this.turretMatrix;
    m.transformVector(this.localMuzzle, muzzle);
    axisY.reset(m.b, m.f, m.j);
    // SFXUtils.alignObjectPlaneToView: ось Y плоскости — вдоль ствола, нормаль Z — к камере
    toCamera.diff(cameraPosition, muzzle);
    const along = toCamera.dot(axisY);
    axisZ.copy(toCamera).addScaled(-along, axisY);
    // камера почти вдоль ствола: проекция вырождается, плоскость схлопнулась бы в полоску
    if (axisZ.lengthSqr() < 1e-6) {
      axisZ.reset(axisY.y, -axisY.x, 0);
      if (axisZ.lengthSqr() < 1e-6) axisZ.reset(0, 0, 1);
    }
    axisZ.normalize();
    axisX.cross2(axisY, axisZ).normalize();
    this.mesh.matrix.set(axisX.x, axisY.x, axisZ.x, muzzle.x, axisX.y, axisY.y, axisZ.y, muzzle.y, axisX.z, axisY.z, axisZ.z, muzzle.z, 0, 0, 0, 1);
    this.mesh.matrixWorldNeedsUpdate = true;
    return true;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}

/** AnimatedSpriteEffect + StaticObject3DPositionProvider: спрайт в точке, сдвинутый к камере */
export class AnimatedSpriteEffect implements GraphicEffect {
  private readonly sprite: THREE.Sprite;
  private frame = 0; // §[";§
  private readonly framesPerMs: number; // §]9§
  private loops: number; // §+!7§

  constructor(
    parent: THREE.Object3D,
    private readonly animation: TextureAnimation,
    size: number,
    private readonly position: Vector3,
    private readonly offsetToCamera: number,
    loops = 1,
    rotation = 0,
    /** MovingObject3DPositionProvider: скорость и ускорение по Z (мс → с пересчитывается в play) */
    private readonly velocity: Vector3 | null = null,
    private readonly gravity = 0,
    /** AnimatedSpriteEffect.init: softAttenuation спрайта, по умолчанию 130 */
    private readonly softAttenuation = 130,
    /** цветовой множитель (Рикошет — голубые шары поверх плазмы Twins) */
    color = 0xffffff,
    height = size,
  ) {
    const material = acquireEffectSpriteMaterial(animation.frameTexture(0), softAttenuation);
    material.rotation = rotation;
    material.color.setHex(color);
    this.sprite = new THREE.Sprite(material);
    this.sprite.scale.set(size, height, 1);
    this.sprite.renderOrder = RenderOrder.EFFECTS;
    this.framesPerMs = 0.001 * animation.fps;
    this.loops = loops;
    parent.add(this.sprite);
  }

  play(delta: number, cameraPosition: Vector3): boolean {
    this.setFrameIndex(this.frame);
    this.frame += delta * this.framesPerMs;
    if (this.velocity) {
      const dt = delta / 1000;
      this.position.addScaled(dt, this.velocity);
      this.velocity.z += this.gravity * dt;
    }
    toCamera.diff(cameraPosition, this.position).normalize();
    this.sprite.position.set(
      this.position.x + this.offsetToCamera * toCamera.x,
      this.position.y + this.offsetToCamera * toCamera.y,
      this.position.z + this.offsetToCamera * toCamera.z,
    );
    const numFrames = this.animation.frames.length;
    if (this.loops > 0 && this.frame >= numFrames) {
      --this.loops;
      if (this.loops == 0) return false;
      this.frame -= numFrames;
    }
    return true;
  }

  private setFrameIndex(index: number): void {
    this.sprite.material.map = this.animation.frameTexture(index);
  }

  destroy(): void {
    this.sprite.removeFromParent();
    releaseEffectSpriteMaterial(this.sprite.material, this.softAttenuation);
  }
}

/** Порядок прозрачных объектов: следы лежат на карте, эффекты (вспышки, взрывы) — поверх следов */
export const RenderOrder = {
  DECALS: 1,
  EFFECTS: 10,
};

/** DecalFactory: глубина бокса следа (attenuation) и предельный угол между нормалями граней и следа */
const DECAL_DEPTH = 300;
const DECAL_MAX_ANGLE = (85 * Math.PI) / 180;

const triangle = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const edge1 = new THREE.Vector3();
const edge2 = new THREE.Vector3();
const faceNormal = new THREE.Vector3();
const sphere = new THREE.Sphere();

/**
 * KDContainer.createDecal + collectPolygons/clip: грани непрозрачных мешей карты, повёрнутые к следу
 * (угол нормалей не больше 85°), обрезаются боксом [-r, r] × [-r, r] × [-depth, depth] вокруг точки попадания;
 * UV — проекция на плоскость следа. Координаты — карты (группа world).
 */
export function buildDecalGeometry(
  meshes: THREE.Mesh[],
  center: Vector3,
  normal: Vector3,
  radius: number,
  depth: number,
  angle = Math.random() * 2 * Math.PI,
): THREE.BufferGeometry | null {
  const axisZ = new THREE.Vector3(normal.x, normal.y, normal.z);
  // поворот вокруг нормали (по умолчанию случайный)
  const helper = Math.abs(axisZ.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const axisX = new THREE.Vector3().crossVectors(helper, axisZ).normalize();
  const axisY = new THREE.Vector3().crossVectors(axisZ, axisX);
  const x = axisX.clone().multiplyScalar(Math.cos(angle)).addScaledVector(axisY, Math.sin(angle));
  const y = new THREE.Vector3().crossVectors(axisZ, x);
  const origin = new THREE.Vector3(center.x, center.y, center.z);
  const minDot = Math.cos(DECAL_MAX_ANGLE) - 0.001;
  const reach = Math.sqrt(2 * radius * radius + depth * depth);
  const clipBounds = new THREE.Box3(origin.clone().addScalar(-reach), origin.clone().addScalar(reach));

  const positions: number[] = [];
  const uvs: number[] = [];
  const toDecal = (v: THREE.Vector3): number[] => {
    edge1.subVectors(v, origin);
    return [edge1.dot(x), edge1.dot(y), edge1.dot(axisZ)];
  };
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (mesh.matrixAutoUpdate) mesh.updateMatrix();
    sphere.copy(geometry.boundingSphere as THREE.Sphere).applyMatrix4(mesh.matrix);
    if (sphere.center.distanceTo(origin) > sphere.radius + reach) continue;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    // Batched props have their geometry baked into map coordinates. Skip distant
    // props before touching their triangles or allocating clip polygons.
    const parts = mesh.userData.parts as { end: number; bounds: THREE.Box3 }[] | undefined;
    let nextPart = 0;
    let partEnd = 0;
    for (let i = 0; i < count; i += 3) {
      if (parts && i === partEnd) {
        const part = parts[nextPart++];
        partEnd = part.end * 3;
        if (!part.bounds.intersectsBox(clipBounds)) {
          i = partEnd - 3;
          continue;
        }
      }
      for (let k = 0; k < 3; k++) {
        triangle[k].fromBufferAttribute(position, index ? index.getX(i + k) : i + k).applyMatrix4(mesh.matrix);
      }
      edge1.subVectors(triangle[1], triangle[0]);
      edge2.subVectors(triangle[2], triangle[0]);
      faceNormal.crossVectors(edge1, edge2).normalize();
      if (faceNormal.dot(axisZ) < minDot) continue;
      let polygon = triangle.map(toDecal);
      // Sutherland–Hodgman по шести плоскостям бокса
      for (const [axis, limit] of [
        [0, radius],
        [0, -radius],
        [1, radius],
        [1, -radius],
        [2, depth],
        [2, -depth],
      ]) {
        const inside = (p: number[]): boolean => (limit > 0 ? p[axis] <= limit : p[axis] >= limit);
        const clipped: number[][] = [];
        for (let n = 0; n < polygon.length; n++) {
          const a = polygon[n];
          const b = polygon[(n + 1) % polygon.length];
          if (inside(a)) clipped.push(a);
          if (inside(a) != inside(b)) {
            const t = (limit - a[axis]) / (b[axis] - a[axis]);
            clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
          }
        }
        polygon = clipped;
        if (polygon.length < 3) break;
      }
      if (polygon.length < 3) continue;
      for (let n = 1; n < polygon.length - 1; n++) {
        for (const p of [polygon[0], polygon[n], polygon[n + 1]]) {
          edge2.copy(origin).addScaledVector(x, p[0]).addScaledVector(y, p[1]).addScaledVector(axisZ, p[2]);
          positions.push(edge2.x, edge2.y, edge2.z);
          // v во Flash сверху вниз, под flipY переворачиваем
          uvs.push(p[0] / (2 * radius) + 0.5, 0.5 - p[1] / (2 * radius));
        }
      }
    }
  }
  if (positions.length == 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** След взрыва на геометрии карты; лишние следы гаснут как в FadingDecalsRenderer */
class Decal {
  readonly mesh: THREE.Mesh;
  private fadeLeft = -1;

  constructor(parent: THREE.Object3D, material: THREE.Material, geometry: THREE.BufferGeometry) {
    this.mesh = new THREE.Mesh(geometry, material.clone());
    this.mesh.renderOrder = RenderOrder.DECALS;
    parent.add(this.mesh);
  }

  startFading(): void {
    this.fadeLeft = DECAL_FADE_TIME;
  }

  /** false — след погас */
  update(delta: number): boolean {
    if (this.fadeLeft < 0) return true;
    this.fadeLeft -= delta;
    if (this.fadeLeft <= 0) return false;
    (this.mesh.material as THREE.MeshLambertMaterial).opacity = this.fadeLeft / DECAL_FADE_TIME;
    return true;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const decalDirection = new Vector3(); // §4"G§
const decalSide = new Vector3(); // §=!_§
const decalUp = new Vector3(); // §<!6§
const decalNormal = new Vector3(); // §-3§
const decalOrigin = new Vector3();
const decalHit = new RayHit();
const Z_AXIS = new Vector3(0, 0, 1);

/** Графические эффекты и следы боя (часть BattleScene3D) */
export class EffectsScene {
  private readonly effects: GraphicEffect[] = [];
  private readonly decals: Decal[] = [];
  private readonly fadingDecals: Decal[] = [];

  constructor(
    readonly parent: THREE.Object3D,
    private readonly collisionDetector: TanksCollisionDetector,
  ) {}

  /** Меши пропов карты (buildRealProps) без прозрачных материалов — как Mesh в KDContainer.clip */
  private getStaticMeshes(): THREE.Mesh[] {
    return this.parent.children.filter((object): object is THREE.Mesh => {
      if (!(object instanceof THREE.Mesh) || object.userData.propName == null) return false;
      const material = object.material as THREE.Material;
      return !material.transparent && material.alphaTest == 0;
    });
  }

  getCollisionDetector(): TanksCollisionDetector {
    return this.collisionDetector;
  }

  addGraphicEffect(effect: GraphicEffect): void {
    this.effects.push(effect);
  }

  /** BattleScene3D.addDecal + DecalFactory.createDecal: нормаль — среднее по пяти лучам вдоль выстрела */
  addDecal(position: Vector3, origin: Vector3, radius: number, material: THREE.Material): void {
    decalDirection.diff(position, origin);
    const maxTime = decalDirection.length() + 200;
    decalDirection.normalize();
    decalSide.cross2(decalDirection, Z_AXIS).normalize();
    decalUp.cross2(decalSide, decalDirection);
    decalNormal.reset(0, 0, 0);
    const offsets: [number, Vector3][] = [
      [0, decalSide],
      [50, decalSide],
      [50, decalUp],
      [-50, decalSide],
      [-50, decalUp],
    ];
    for (const [offset, axis] of offsets) {
      // лучи от начала ствола и четырёх точек вокруг него, вдоль выстрела
      decalOrigin.copy(origin).addScaled(offset, axis);
      if (this.collisionDetector.raycastStatic(decalOrigin, decalDirection, CollisionGroup.STATIC, maxTime, null, decalHit)) {
        decalNormal.add(decalHit.normal);
      }
    }
    if (decalNormal.length() < 1e-6) return;
    decalNormal.normalize();
    const geometry = buildDecalGeometry(this.getStaticMeshes(), position, decalNormal, radius, DECAL_DEPTH);
    if (geometry == null) return;
    const decal = new Decal(this.parent, material, geometry);
    this.decals.unshift(decal);
    if (this.decals.length > MAX_DECALS) {
      const old = this.decals.pop() as Decal;
      old.startFading();
      this.fadingDecals.push(old);
    }
  }

  /**
   * Выход из боя: эффекты (взрывы, вспышки, шары плазмы) и следы живут в общей группе world, которая переживает бой, —
   * без очистки они оставались висеть в воздухе на следующей карте.
   */
  clear(): void {
    for (const effect of this.effects) effect.destroy();
    this.effects.length = 0;
    for (const decal of [...this.decals, ...this.fadingDecals]) decal.destroy();
    this.decals.length = 0;
    this.fadingDecals.length = 0;
  }

  update(delta: number, cameraPosition: Vector3): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (!this.effects[i].play(delta, cameraPosition)) {
        this.effects[i].destroy();
        this.effects.splice(i, 1);
      }
    }
    for (let i = this.fadingDecals.length - 1; i >= 0; i--) {
      if (!this.fadingDecals[i].update(delta)) {
        this.fadingDecals[i].destroy();
        this.fadingDecals.splice(i, 1);
      }
    }
  }
}

/** Общий вид эффектов дискретного выстрела: Смоки, Гром (взрыв, вспышка, след на стене) */
export interface ShotEffects {
  createShotEffects(localMuzzle: Vector3, turretMatrix: Matrix4): void;
  createExplosionEffects(position: Vector3): void;
  createExplosionMark(barrelOrigin: Vector3, position: Vector3): void;
}

/** SmokySFXData: что загружает SmokySFXModel.objectLoaded */
interface SmokySFXData {
  muzzleFlashMaterial: THREE.Material; // §?"9§
  explosionAnimation: TextureAnimation; // §?8§
  explosionMarkMaterial: THREE.MeshLambertMaterial; // §+<§
  explosionSize: number; // §]j§
  criticalHitAnimation: TextureAnimation; // §[!+§
  criticalHitSize: number; // §="+§
  shotSound: Sound; // §0"0§
  explosionSound: Sound; // §%M§
}

/** turrets.json → smoky_sfx_data.explosion_size / critical_hit_size */
const SMOKY_EXPLOSION_SIZE = 300;
const SMOKY_CRITICAL_HIT_SIZE = 375;
/** SmokyEffects.createCriticalHitEffects: initLooped(..., loops = 2), сдвиг к камере §2"P§ + 50 */
const CRITICAL_HIT_LOOPS = 2;
const CRITICAL_HIT_OFFSET_TO_CAMERA = SmokyEffectsParams.EXPLOSION_OFFSET_TO_CAMERA + 50;

export class SmokyEffects implements ShotEffects {
  private constructor(
    private readonly soundManager: SoundManager,
    private readonly scene: EffectsScene,
    private readonly data: SmokySFXData,
  ) {}

  static async load(base: string, soundManager: SoundManager, scene: EffectsScene,mod=0): Promise<SmokyEffects> {
    const engine = soundManager.engine;
    const [shotTexture, explosionAnimation, criticalHitAnimation, markTexture, shotSound, explosionSound] = await Promise.all([
      loadEffectTexture(`${base}/images/turrets/smoky/m${mod}/shot`,base.includes('/styles/')),
      loadAnimation(`${base}/multiframe/turrets/smoky/m${mod}/explosion`,base.includes('/styles/')),
      loadAnimation(`${base}/multiframe/turrets/smoky/m${mod}/critical_hit`,base.includes('/styles/')),
      loadEffectTexture(`${base}/images/turrets/smoky/m0/explosion_mark`),
      engine.load(`${base}/sounds/turrets/smoky/m0/shot.mp3`),
      engine.load(`${base}/sounds/turrets/smoky/m0/explosion.mp3`),
    ]);
    const muzzleFlashMaterial = new THREE.MeshBasicMaterial({ map: shotTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    // след освещается как пропы, под которыми лежит
    const explosionMarkMaterial = new THREE.MeshLambertMaterial({
      map: markTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    return new SmokyEffects(soundManager, scene, {
      muzzleFlashMaterial,
      explosionAnimation,
      explosionMarkMaterial,
      explosionSize: SMOKY_EXPLOSION_SIZE,
      criticalHitAnimation,
      criticalHitSize: SMOKY_CRITICAL_HIT_SIZE,
      shotSound,
      explosionSound,
    });
  }

  /** localMuzzle — дуло в координатах башни, turretMatrix — матрица меша башни */
  createShotEffects(localMuzzle: Vector3, turretMatrix: Matrix4): void {
    this.createShotSoundEffect(turretMatrix);
    // свет выстрела у дула, идёт за башней
    const muzzleLocal = localMuzzle.clone();
    const lightPosition = new Vector3();
    this.scene.addGraphicEffect(new AnimatedLightEffect(LIGHTING.smoky.shot, () => (turretMatrix.transformVector(muzzleLocal, lightPosition), lightPosition)));
    this.scene.addGraphicEffect(
      new PlaneMuzzleFlashEffect(
        this.scene.parent,
        localMuzzle.clone(),
        turretMatrix,
        this.data.muzzleFlashMaterial,
        SmokyEffectsParams.MUZZLE_FLASH_TIME,
        SmokyEffectsParams.MUZZLE_FLASH_WIDTH,
        SmokyEffectsParams.MUZZLE_FLASH_LENGTH,
      ),
    );
  }

  /** звук в позиции меша башни */
  private createShotSoundEffect(turretMatrix: Matrix4): void {
    const sound = new Sound3D(this.data.shotSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, SmokyEffectsParams.SHOT_SOUND_VOLUME);
    this.soundManager.addEffect(new Sound3DEffect(new Vector3(turretMatrix.d, turretMatrix.h, turretMatrix.l), sound));
  }

  createExplosionEffects(position: Vector3): void {
    const lightPosition = position.clone();
    this.scene.addGraphicEffect(new AnimatedLightEffect(LIGHTING.smoky.hit, () => lightPosition));
    const sound = new Sound3D(this.data.explosionSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, 1);
    this.soundManager.addEffect(new Sound3DEffect(position, sound, SmokyEffectsParams.EXPLOSION_SOUND_DELAY));
    this.scene.addGraphicEffect(
      new AnimatedSpriteEffect(this.scene.parent, this.data.explosionAnimation, this.data.explosionSize, position.clone(), SmokyEffectsParams.EXPLOSION_OFFSET_TO_CAMERA),
    );
  }

  /** крит: анимация в центре танка-цели, проигрывается дважды; своего звука у крита нет */
  createCriticalHitEffects(position: Vector3): void {
    this.scene.addGraphicEffect(
      new AnimatedSpriteEffect(
        this.scene.parent,
        this.data.criticalHitAnimation,
        this.data.criticalHitSize,
        position.clone(),
        CRITICAL_HIT_OFFSET_TO_CAMERA,
        CRITICAL_HIT_LOOPS,
        0,
        null,
        0,
        70, // SmokyEffects.createCriticalHitEffects: initLooped(..., 70, ...)
      ),
    );
  }

  /**
   * У Смоки следа на поверхности нет: explosion_mark — след Грома, в клиенте 2014 года он у Смоки по ошибке
   * (сервер для Flash отдаёт прозрачную версию ресурса, tools/disable_smoky_decal.py). addDecal оставлен для Грома.
   */
  createExplosionMark(_barrelOrigin: Vector3, _position: Vector3): void {}
}

// Эффекты рельсы: models/weapon/railgun/RailgunEffects.as + RailgunSFXModel.objectLoadedPost и используемые ими
// ChargeEffect, ShotTrailEffect/ShotTrail, RailgunPowEffect, DistanceScaledAnimatedPlaneEffect/AnimatedPlane,
// AnimatedSpriteEffect, SFXUtils.alignObjectPlaneToView.
// Не перенесены: вспышки света (AnimatedLightEffect, TubeLightEffect — в нашем освещении нет точечных источников),
// мягкие края (softAttenuation). Кадры заряда (ChargingTextureRegistry) собраны заранее: tools/add_railgun_battle.py.
import * as THREE from 'three';
import { Matrix4 } from '../../physics/math/Matrix4.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { RayHit } from '../../physics/collision/types.ts';
import type { Body } from '../../physics/Body.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import type { Tank } from '../tank/Tank.ts';
import { AnimatedSpriteEffect, RenderOrder, TextureAnimation, acquireEffectSpriteMaterial, getUVFramesFromTexture, releaseEffectSpriteMaterial, type EffectsScene, type GraphicEffect, type UVFrame } from './SmokyEffects.ts';
import { Sound3D, Sound3DEffect, SoundOptions, type Sound, type SoundManager } from './Sound.ts';
import { makeSoftParticle } from '../../render/BattleRenderer.ts';
import { AnimatedLightEffect, LIGHTING, TubeLightEffect } from '../../render/DynamicLights.ts';
import { patchEffectMaterial } from '../../render/effects/EffectStrength.ts';

function soft<T extends THREE.Material>(material: T, softAttenuation: number): T {
  makeSoftParticle(material, softAttenuation);
  return material;
}

/** RailgunEffects: размеры заряда (§8-§), колец (§8[§), сферы (§0!k§), вспышки (§#3§), следа (§`"4§) */
const CHARGE_SIZE = 300;
const RINGS_SIZE = 300;
const SPHERE_SIZE = 200;
const DECAL_RADIUS = 50;
/** след выстрела: ширина растёт с 10 до 10 × 6 за 1500 мс (§"!,§, §9u§), громкость звука §&!<§ */
const TRAIL_WIDTH = 10;
const TRAIL_WIDTH_FACTOR = 6;
const TRAIL_TIME = 1500;
const SOUND_VOLUME = 1;
/** RailgunUtils: точка «в бесконечности» вдоль выстрела */
const DISTANT_POINT = 100000;
/** ShotTrail: v растягивается на 500 единиц длины */
const TRAIL_V_LENGTH = 500;
/** AnimatedSpriteEffect колец: сдвиг к камере (StaticObject3DPositionProvider.init(point, 30)) */
const SPHERE_OFFSET_TO_CAMERA = 30;
/** DistanceScaledAnimatedPlaneEffect: дальше 3000 плоскость подрастает на расстояние / 5000 */
const DISTANCE_SCALE_START = 3000;
const DISTANCE_SCALE_FACTOR = 1 / 5000;
/** RemoteRailgunWeapon.getStaticHitPointNormal: длина луча за нормалью */
const NORMAL_RAY_LENGTH = 100;
const trailMaterials = new WeakMap<THREE.MeshBasicMaterial, THREE.MeshBasicMaterial[]>();

function acquireTrailMaterial(base: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  const material = trailMaterials.get(base)?.pop() ?? soft(base.clone(), 80);
  material.opacity = base.opacity;
  patchEffectMaterial(material);
  return material;
}

function releaseTrailMaterial(base: THREE.MeshBasicMaterial, material: THREE.MeshBasicMaterial): void {
  let pool = trailMaterials.get(base);
  if (!pool) trailMaterials.set(base, pool = []);
  if (pool.length < 8) pool.push(material);
  else material.dispose();
}

export function getDistantPoint(origin: Vector3, direction: Vector3): Vector3 {
  return origin.clone().addScaled(DISTANT_POINT, direction);
}

const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();
const toCamera = new Vector3();

/**
 * SFXUtils.alignObjectPlaneToView: ось Y плоскости — вдоль direction, нормаль Z — к камере.
 * scaleX растягивает плоскость поперёк (ширина следа).
 */
function alignPlaneToView(mesh: THREE.Object3D, position: Vector3, direction: Vector3, cameraPosition: Vector3, scaleX = 1): void {
  axisY.copy(direction);
  toCamera.diff(cameraPosition, position);
  axisZ.copy(toCamera).addScaled(-toCamera.dot(axisY), axisY);
  if (axisZ.lengthSqr() < 1e-10) axisZ.reset(axisY.z, 0, -axisY.x);
  axisZ.normalize();
  axisX.cross2(axisY, axisZ);
  mesh.matrix.set(
    axisX.x * scaleX, axisY.x, axisZ.x, position.x,
    axisX.y * scaleX, axisY.y, axisZ.y, position.y,
    axisX.z * scaleX, axisY.z, axisZ.z, position.z,
    0, 0, 0, 1,
  );
  mesh.matrixWorldNeedsUpdate = true;
}

/** UV кадра Flash (v сверху вниз) -> Three.js под flipY */
function setQuadFrame(uv: THREE.BufferAttribute, frame: UVFrame): void {
  // вершины AnimatedPlane: (−x, +y) u0 v0, (−x, −y) u0 v1, (+x, −y) u1 v1, (+x, +y) u1 v0
  uv.setXY(0, frame.u0, 1 - frame.v0);
  uv.setXY(1, frame.u0, 1 - frame.v1);
  uv.setXY(2, frame.u1, 1 - frame.v1);
  uv.setXY(3, frame.u1, 1 - frame.v0);
  uv.needsUpdate = true;
}

/** AnimatedPlane(width, height, x, y, z): двусторонняя плоскость с анимацией кадров */
function createAnimatedPlane(width: number, height: number, x: number, y: number, z: number, material: THREE.Material): THREE.Mesh {
  const w = width / 2;
  const h = height / 2;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([x - w, y + h, z, x - w, y - h, z, x + w, y - h, z, x + w, y + h, z], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(8).fill(0), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = RenderOrder.EFFECTS;
  return mesh;
}

function effectMaterial(texture: THREE.Texture): THREE.MeshBasicMaterial {
  // эффекты рельсы светятся сами: аддитивное смешивание + холодный цвет с запасом по яркости (bloom подхватывает)
  return new THREE.MeshBasicMaterial({
    map: texture,
    color: new THREE.Color(0x9fd8ff).multiplyScalar(1.4),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/** AnimatedPlane.setTime: кадр = int(время × fps / 1000), не дальше последнего */
function frameAt(animation: TextureAnimation, time: number): UVFrame {
  const frames = animation.frames;
  return frames[Math.min(Math.trunc(time * 0.001 * animation.fps), frames.length - 1)];
}

function oneLoopTime(animation: TextureAnimation): number {
  return animation.frames.length / (0.001 * animation.fps);
}

const chargePosition = new Vector3();

/** ChargeEffect: спрайт заряда у дула (на 10 вперёд), идёт за башней; все кадры — за время зарядки */
class ChargeEffect implements GraphicEffect {
  private readonly sprite: THREE.Sprite;
  private readonly localPosition: Vector3;
  private frame = 0; // §&u§
  private readonly framesPerMs: number; // §`"J§

  constructor(
    parent: THREE.Object3D,
    private readonly animation: TextureAnimation,
    localMuzzle: Vector3,
    private readonly turretMatrix: Matrix4,
    chargingTime: number,
  ) {
    this.sprite = new THREE.Sprite(acquireEffectSpriteMaterial(animation.frameTexture(0), 0));
    this.sprite.scale.set(CHARGE_SIZE, CHARGE_SIZE, 1);
    this.sprite.renderOrder = RenderOrder.EFFECTS;
    this.localPosition = localMuzzle.clone();
    this.localPosition.y += 10;
    // RailgunEffects.§#" §: fps = 1000 × кадров / время зарядки
    this.framesPerMs = (0.001 * 1000 * animation.frames.length) / chargingTime;
    parent.add(this.sprite);
  }

  play(delta: number): boolean {
    const frames = this.animation.frames;
    if (this.frame >= frames.length) return false;
    this.turretMatrix.transformVector(this.localPosition, chargePosition);
    this.sprite.position.set(chargePosition.x, chargePosition.y, chargePosition.z);
    this.sprite.material.map = this.animation.frameTexture(this.frame);
    this.frame += this.framesPerMs * delta;
    return true;
  }

  kill(): void {
    this.frame = this.animation.frames.length + 1;
  }

  destroy(): void {
    this.sprite.removeFromParent();
    releaseEffectSpriteMaterial(this.sprite.material, 0);
  }
}

/**
 * ShotTrailEffect + ShotTrail: полоса от дула до точки попадания. За 1500 мс ширина растёт с 10 до 60, прозрачность
 * уходит в 0, текстура (повтор каждые 500 единиц) бежит со скоростью 1 → 0 (торможение 5 × (0 − 1) / 1500 × 1000).
 */
class ShotTrailEffect implements GraphicEffect {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly uv: THREE.BufferAttribute;
  private readonly origin: Vector3;
  private readonly direction = new Vector3();
  private readonly length: number;
  private timeLeft: number; // §`">§
  private widthFactor = 1; // §@!q§
  private readonly widthSpeed: number; // §^!4§
  private readonly alphaSpeed: number; // §%"+§
  private uvSpeed = 1; // §#2§
  private readonly uvAcceleration: number; // §`!`§
  private uvOffset = 0; // §]!`§

  constructor(parent: THREE.Object3D, from: Vector3, to: Vector3, private readonly baseMaterial: THREE.MeshBasicMaterial) {
    this.origin = from.clone();
    this.direction.diff(to, from);
    this.length = Math.max(10, this.direction.length());
    this.direction.scale(1 / this.direction.length());
    this.timeLeft = TRAIL_TIME;
    this.widthSpeed = (TRAIL_WIDTH_FACTOR - 1) / TRAIL_TIME;
    this.alphaSpeed = 1 / TRAIL_TIME;
    this.uvAcceleration = ((5 * (0 - 1)) / TRAIL_TIME) * 1000;
    const geometry = new THREE.BufferGeometry();
    // ширина 1 (масштаб по X — в матрице), длина вдоль Y
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, this.length, 0, -0.5, this.length, 0], 3));
    this.uv = new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 0, 0, 0], 2);
    geometry.setAttribute('uv', this.uv);
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.material = acquireTrailMaterial(this.baseMaterial);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RenderOrder.EFFECTS;
    this.updateUV();
    parent.add(this.mesh);
  }

  /** ShotTrail: v у дула = длина / 500 + сдвиг, у конца — сдвиг; Three.js переворачивает v (повтор, поэтому просто минус) */
  private updateUV(): void {
    const near = -(this.length / TRAIL_V_LENGTH + this.uvOffset);
    const far = -this.uvOffset;
    this.uv.setXY(0, 0, near);
    this.uv.setXY(1, 1, near);
    this.uv.setXY(2, 1, far);
    this.uv.setXY(3, 0, far);
    this.uv.needsUpdate = true;
  }

  play(delta: number, cameraPosition: Vector3): boolean {
    if (this.timeLeft < 0) return false;
    this.timeLeft -= delta;
    this.widthFactor += this.widthSpeed * delta;
    this.material.opacity = Math.max(0, this.material.opacity - this.alphaSpeed * delta);
    // ShotTrail.update
    const seconds = 0.001 * delta;
    this.uvOffset += this.uvSpeed * seconds;
    if (this.uvSpeed >= 0) {
      while (this.uvOffset >= 1) this.uvOffset -= 1;
    } else {
      while (this.uvOffset <= -1) this.uvOffset += 1;
    }
    this.uvSpeed += this.uvAcceleration * seconds;
    if (this.uvSpeed < 0) this.uvSpeed = 0;
    this.updateUV();
    alignPlaneToView(this.mesh, this.origin, this.direction, cameraPosition, TRAIL_WIDTH * this.widthFactor);
    return true;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    releaseTrailMaterial(this.baseMaterial, this.material);
  }
}

/**
 * DistanceScaledAnimatedPlaneEffect (AnimatedPlaneEffect + SquareAnimatedPlane(100)): плоскость колец по нормали поверхности,
 * масштаб size / 100 растёт на (1 мс⁻¹ × 0.001) за мс; дальше 3000 от камеры плоскость ещё и подрастает.
 */
class RingsPlaneEffect implements GraphicEffect {
  private readonly mesh: THREE.Mesh;
  private readonly uv: THREE.BufferAttribute;
  private time = 0; // §=!h§
  private readonly loopTime: number; // §&]§
  private readonly baseScale: number; // §7!7§
  private scale: number; // §^!T§
  private readonly growth = 0.001; // §^!4§ = 0.001 × 1
  /** положение и поворот плоскости (rotationX/Y/Z из getRotation) без масштаба */
  private readonly matrix = new Matrix4();

  constructor(
    parent: THREE.Object3D,
    private readonly animation: TextureAnimation,
    material: THREE.Material,
    size: number,
    private readonly position: Vector3,
    rotation: Vector3,
  ) {
    this.mesh = createAnimatedPlane(100, 100, 0, 0, 10, material);
    this.uv = this.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    this.loopTime = oneLoopTime(animation);
    this.baseScale = size / 100;
    this.scale = this.baseScale;
    this.matrix.setMatrix(position.x, position.y, position.z, rotation.x, rotation.y, rotation.z);
    parent.add(this.mesh);
  }

  play(delta: number, cameraPosition: Vector3): boolean {
    if (this.time >= this.loopTime) return false;
    setQuadFrame(this.uv, frameAt(this.animation, this.time));
    this.time += delta;
    const m = this.matrix;
    const s = this.scale;
    this.mesh.matrix.set(m.a * s, m.b * s, m.c, m.d, m.e * s, m.f * s, m.g, m.h, m.i * s, m.j * s, m.k, m.l, 0, 0, 0, 1);
    this.mesh.matrixWorldNeedsUpdate = true;
    this.scale = this.baseScale + this.baseScale * this.growth * this.time;
    const distance = cameraPosition.distanceTo(this.position);
    if (distance > DISTANCE_SCALE_START) this.scale += distance * DISTANCE_SCALE_FACTOR;
    return true;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}

/** RailgunPowEffect: AnimatedPlane(30, 200, 0, −100, 0) в точке попадания, вытянута назад вдоль выстрела к стрелку */
class RailgunPowEffect implements GraphicEffect {
  private readonly mesh: THREE.Mesh;
  private readonly uv: THREE.BufferAttribute;
  private time = 0;
  private readonly loopTime: number;
  private readonly position: Vector3;
  private readonly direction: Vector3;

  constructor(
    parent: THREE.Object3D,
    private readonly animation: TextureAnimation,
    material: THREE.Material,
    position: Vector3,
    direction: Vector3,
  ) {
    this.mesh = createAnimatedPlane(30, 200, 0, -100, 0, material);
    this.uv = this.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    this.loopTime = oneLoopTime(animation);
    this.position = position.clone();
    this.direction = direction.clone();
    parent.add(this.mesh);
  }

  play(delta: number, cameraPosition: Vector3): boolean {
    if (this.time >= this.loopTime) return false;
    setQuadFrame(this.uv, frameAt(this.animation, this.time));
    this.time += delta;
    alignPlaneToView(this.mesh, this.position, this.direction, cameraPosition);
    return true;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}

/** RailgunEffects.getRotation: углы плоскости, чья нормаль Z смотрит вдоль normal */
function getRotation(normal: Vector3, result: Vector3): Vector3 {
  result.x = Math.atan2(normal.z, Math.sqrt(normal.x * normal.x + normal.y * normal.y)) - Math.PI / 2;
  result.y = 0;
  result.z = -Math.atan2(normal.x, normal.y);
  return result;
}

const meshInverse = new THREE.Matrix4();
const localRay = new THREE.Ray();
const triangleA = new THREE.Vector3();
const triangleB = new THREE.Vector3();
const triangleC = new THREE.Vector3();
const intersection = new THREE.Vector3();
const edge1 = new THREE.Vector3();
const edge2 = new THREE.Vector3();

interface MeshHit {
  time: number;
  point: Vector3;
  normal: Vector3;
}

/**
 * RailgunEffects.raycast: Mesh.intersectRay в системе меша; луч origin + t·vector, t ≥ 0.
 * Матрица меша — в координатах карты (TankSkin.updateHullTransform / updateTurretTransform).
 */
function raycastMesh(mesh: THREE.Mesh, origin: Vector3, vector: Vector3): MeshHit | null {
  meshInverse.copy(mesh.matrix).invert();
  localRay.origin.set(origin.x, origin.y, origin.z).applyMatrix4(meshInverse);
  localRay.direction.set(vector.x, vector.y, vector.z).transformDirection(meshInverse);
  const scale = new THREE.Vector3(vector.x, vector.y, vector.z).applyMatrix3(new THREE.Matrix3().setFromMatrix4(meshInverse)).length();
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  let best: MeshHit | null = null;
  for (let i = 0; i < count; i += 3) {
    triangleA.fromBufferAttribute(position, index ? index.getX(i) : i);
    triangleB.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1);
    triangleC.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2);
    if (localRay.intersectTriangle(triangleA, triangleB, triangleC, false, intersection) == null) continue;
    // время в единицах исходного вектора (как Vector3D в intersectRay)
    const time = intersection.distanceTo(localRay.origin) / scale;
    if (best != null && time >= best.time) continue;
    edge1.subVectors(triangleB, triangleA);
    edge2.subVectors(triangleC, triangleA);
    const normal = edge1.cross(edge2).transformDirection(mesh.matrix);
    const world = intersection.clone().applyMatrix4(mesh.matrix);
    best = { time, point: new Vector3(world.x, world.y, world.z), normal: new Vector3(normal.x, normal.y, normal.z) };
  }
  return best;
}

/** RailgunEffects.getRaycastData: ближайшее попадание луча по корпусу или башне */
function raycastTank(tank: Tank, origin: Vector3, vector: Vector3): MeshHit | null {
  const hull = raycastMesh(tank.skin.hull.mesh, origin, vector);
  const turret = raycastMesh(tank.skin.turret.mesh, origin, vector);
  if (hull == null) return turret;
  if (turret == null) return hull;
  return turret.time < hull.time ? turret : hull;
}

/** RailgunSFXData: что собирает RailgunSFXModel.objectLoadedPost (свет не переносится) */
interface RailgunSFXData {
  trailMaterial: THREE.MeshBasicMaterial; // §<!j§
  chargeAnimation: TextureAnimation; // §;D§
  ringsAnimation: TextureAnimation; // §2!V§
  ringsMaterial: THREE.MeshBasicMaterial;
  hitMarkMaterial: THREE.MeshLambertMaterial; // §`!4§
  shotSound: Sound; // §9!m§
  powAnimation: TextureAnimation; // §7!8§
  powMaterial: THREE.MeshBasicMaterial;
}

interface RailgunInfo {
  charge: { frame: number; frames: number };
  rings: { frames: number; width: number; height: number; fps: number };
  pow: { frames: number; width: number; height: number; fps: number };
}

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.colorSpace = THREE.NoColorSpace;
        resolve(texture);
      },
      undefined,
      () => reject(new Error('не загрузилась текстура ' + url)),
    );
  });
}

async function loadSheet(url: string, frameWidth: number, frameHeight: number, frames: number, fps: number): Promise<TextureAnimation> {
  const texture = await loadTexture(url);
  const image = texture.image as { width: number; height: number };
  return new TextureAnimation(texture, getUVFramesFromTexture(image.width, image.height, frameWidth, frameHeight, frames), fps);
}

const hitPoint = new Vector3(); // §"%§
const hitNormal = new Vector3(); // §'!H§
const shotDirection = new Vector3(); // §5!>§
const trailVector = new Vector3(); // §>!'§
const rayVector = new Vector3(); // §7e§
const planeRotation = new Vector3(); // §<L§
const normalRayOrigin = new Vector3();
const normalRayDirection = new Vector3();
const normalRayHit = new RayHit();

/** Медиа рельсы: tools/add_railgun_battle.py → html5/public/battle/railgun */
const RAILGUN_MEDIA = 'battle/railgun';
const loaded = new Map<string, Promise<RailgunSFXData>>();
let prepareRailgun: (scene: THREE.Scene, textures: THREE.Texture[]) => void = () => {};

export function setRailgunPreparer(prepare: typeof prepareRailgun): void {
  prepareRailgun = prepare;
}

function warmRailgun(data: RailgunSFXData, trailTexture: THREE.Texture, hitMarkTexture: THREE.Texture): void {
  const scene = new THREE.Scene();
  const quad = new THREE.PlaneGeometry();
  const trail = acquireTrailMaterial(data.trailMaterial);
  const charge = acquireEffectSpriteMaterial(data.chargeAnimation.frameTexture(0), 0);
  patchEffectMaterial(charge);
  patchEffectMaterial(data.ringsMaterial);
  patchEffectMaterial(data.powMaterial);
  scene.add(new THREE.Sprite(charge));
  for (const material of [trail, data.ringsMaterial, data.powMaterial, data.hitMarkMaterial]) {
    scene.add(new THREE.Mesh(quad, material));
  }
  try {
    prepareRailgun(scene, [trailTexture, hitMarkTexture]);
  } catch (error) {
    console.warn('Не удалось подготовить рендер эффектов рельсы', error);
  } finally {
    quad.dispose();
    releaseTrailMaterial(data.trailMaterial, trail);
    releaseEffectSpriteMaterial(charge, 0);
  }
}

async function loadData(modification: number,base:string): Promise<RailgunSFXData> {
  const info = (await fetch(`${base}/info.json`).then((response) => response.json())) as RailgunInfo;
  const [trailTexture, chargeAnimation, ringsAnimation, powAnimation, hitMarkTexture] = await Promise.all([
    loadTexture(`${base}/m${modification}/trail.png`),
    // ChargingTextureRegistry: 30 кадров в ряд, кадр квадратный; fps задаёт время зарядки (ChargeEffect)
    loadSheet(`${base}/m${modification}/charge.png`, info.charge.frame, info.charge.frame, info.charge.frames, 0),
    loadSheet(`${base}/rings.png`, info.rings.width, info.rings.height, info.rings.frames, info.rings.fps),
    loadSheet(`${base}/pow.png`, info.pow.width, info.pow.height, info.pow.frames, info.pow.fps),
    loadTexture(`${base}/hit_mark.png`),
  ]);
  // RailgunSFXModel.getTrailMaterial: повтор вдоль следа, без мипмапов
  trailTexture.wrapS = THREE.ClampToEdgeWrapping;
  trailTexture.wrapT = THREE.RepeatWrapping;
  trailTexture.generateMipmaps = false;
  trailTexture.minFilter = THREE.LinearFilter;
  trailTexture.needsUpdate = true;
  const data: RailgunSFXData = {
    trailMaterial: effectMaterial(trailTexture),
    chargeAnimation,
    ringsAnimation,
    ringsMaterial: effectMaterial(ringsAnimation.texture),
    // след освещается как пропы, под которыми лежит (как у Смоки)
    hitMarkMaterial: new THREE.MeshLambertMaterial({ map: hitMarkTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    shotSound: null as unknown as Sound,
    powAnimation,
    powMaterial: effectMaterial(powAnimation.texture),
  };
  warmRailgun(data, trailTexture, hitMarkTexture);
  return data;
}

/** Эффекты одного оружия (RailgunEffects создаётся на каждое оружие: свой заряд и свой звук) */
export class RailgunEffects {
  private chargeEffect: ChargeEffect | null = null; // §2!c§
  private chargeLight: AnimatedLightEffect | null = null;
  private soundEffect: Sound3DEffect | null = null; // §9"D§

  private constructor(
    private readonly soundManager: SoundManager,
    private readonly scene: EffectsScene,
    private readonly data: RailgunSFXData,
  ) {}

  /** modification — номер модификации башни (m0..m3): своя текстура заряда и следа */
  static async load(modification: number, soundManager: SoundManager, scene: EffectsScene,base=RAILGUN_MEDIA): Promise<RailgunEffects> {
    const key=`${base}:${modification}`;let promise = loaded.get(key);
    if (!promise) {
      promise = Promise.all([loadData(modification,base), soundManager.engine.load(`${base}/shot.mp3`)]).then(([data, sound]) => ({ ...data, shotSound: sound }));
      loaded.set(key, promise);
      promise.catch(() => loaded.delete(key));
    }
    return new RailgunEffects(soundManager, scene, await promise);
  }

  /** createChargeEffect: прежний заряд гасится */
  createChargeEffect(localMuzzle: Vector3, turretMatrix: Matrix4, chargingTime: number): void {
    this.chargeEffect?.kill();
    {
      this.chargeEffect = new ChargeEffect(this.scene.parent, this.data.chargeAnimation, localMuzzle, turretMatrix, chargingTime);
      this.scene.addGraphicEffect(this.chargeEffect);
      // свет заряда у дула: анимация растянута на время зарядки (AnimatedLightEffect.initFromTime)
      const muzzleLocal = localMuzzle.clone();
      const lightPosition = new Vector3();
      this.chargeLight?.kill();
      this.chargeLight = new AnimatedLightEffect(LIGHTING.railgun.charge, () => (turretMatrix.transformVector(muzzleLocal, lightPosition), lightPosition), chargingTime);
      this.scene.addGraphicEffect(this.chargeLight);
    }
  }

  /** createSoundEffect: один звук на зарядку и выстрел, в позиции дула */
  createSoundEffect(position: Vector3): void {
    this.soundEffect?.destroy();
    const sound = new Sound3D(this.data.shotSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, SOUND_VOLUME);
    this.soundEffect = new Sound3DEffect(position, sound);
    this.soundManager.addEffect(this.soundEffect);
  }

  /** createShotTrail: след рисуется, только если точка впереди ствола */
  createShotTrail(muzzle: Vector3, end: Vector3 | null, direction: Vector3): void {
    const to = end ?? getDistantPoint(muzzle, direction);
    trailVector.diff(to, muzzle);
    if (trailVector.dot(direction) > 0) {
      this.scene.addGraphicEffect(new ShotTrailEffect(this.scene.parent, muzzle, to, this.data.trailMaterial));
    }
    // свет выстрела у дула и вдоль луча (TubeLightEffect)
    this.chargeLight?.kill();
    this.chargeLight = null;
    const shotPosition = muzzle.clone();
    this.scene.addGraphicEffect(new AnimatedLightEffect(LIGHTING.railgun.shot, () => shotPosition));
    this.scene.addGraphicEffect(new TubeLightEffect(LIGHTING.railgun.rail, muzzle, to));
  }

  createStaticHitMark(barrelOrigin: Vector3, point: Vector3 | null): void {
    if (point != null) this.scene.addDecal(point, barrelOrigin, DECAL_RADIUS, this.data.hitMarkMaterial);
  }

  stopEffects(): void {
    this.chargeEffect?.kill();
    this.chargeEffect = null;
    this.chargeLight?.kill();
    this.chargeLight = null;
    this.soundEffect?.destroy();
    this.soundEffect = null;
  }

  /**
   * createTargetHitEffects: точка попадания уточняется лучом от дула к end по мешам корпуса и башни цели
   * (нормаль — грани меша); без пересечения — проекция присланной точки на луч, нормаль — вдоль выстрела.
   */
  createTargetHitEffects(muzzle: Vector3, end: Vector3, hitPoints: Vector3[], targets: (Body | null)[]): void {
    rayVector.diff(end, muzzle);
    shotDirection.copy(rayVector).normalize();
    for (let i = 0; i < targets.length; i++) {
      const tank = targets[i]?.data as Tank | null | undefined;
      if (tank == null) continue;
      const hit = raycastTank(tank, muzzle, rayVector);
      if (hit == null) {
        // projectHitPoint
        hitPoint.diff(hitPoints[i], muzzle);
        const along = hitPoint.dot(shotDirection);
        hitPoint.copy(muzzle).addScaled(along, shotDirection);
        hitNormal.copy(shotDirection);
      } else {
        hitPoint.copy(hit.point);
        hitNormal.copy(hit.normal);
      }
      this.createHitEffect(hitPoint, hitNormal, shotDirection);
    }
  }

  createStaticHitEffect(muzzle: Vector3, point: Vector3, normal: Vector3): void {
    shotDirection.diff(point, muzzle).normalize();
    this.createHitEffect(point, normal, shotDirection);
  }

  /** createHitEffect: плоскость колец по нормали, спрайт колец 200 со сдвигом к камере 30 и вспышка вдоль выстрела */
  private createHitEffect(point: Vector3, normal: Vector3, direction: Vector3): void {
    const parent = this.scene.parent;
    this.scene.addGraphicEffect(new RingsPlaneEffect(parent, this.data.ringsAnimation, this.data.ringsMaterial, RINGS_SIZE, point.clone(), getRotation(normal, planeRotation).clone()));
    // сфера колец: softAttenuation 0 (RailgunEffects.createHitEffect)
    this.scene.addGraphicEffect(new AnimatedSpriteEffect(parent, this.data.ringsAnimation, SPHERE_SIZE, point.clone(), SPHERE_OFFSET_TO_CAMERA, 1, 0, null, 0, 0));
    const lightPosition = point.clone();
    this.scene.addGraphicEffect(new AnimatedLightEffect(LIGHTING.railgun.hit, () => lightPosition));
    this.scene.addGraphicEffect(new RailgunPowEffect(parent, this.data.powAnimation, this.data.powMaterial, point, direction));
  }

  /** RemoteRailgunWeapon.getStaticHitPointNormal: луч от точки на 1 назад вдоль выстрела, иначе — против выстрела */
  getStaticHitPointNormal(muzzle: Vector3, point: Vector3): Vector3 {
    normalRayDirection.diff(point, muzzle).normalize();
    normalRayOrigin.copy(point).subtract(normalRayDirection);
    if (this.scene.getCollisionDetector().raycastStatic(normalRayOrigin, normalRayDirection, CollisionGroup.STATIC, NORMAL_RAY_LENGTH, null, normalRayHit)) {
      return normalRayHit.normal.clone();
    }
    return normalRayDirection.clone().reverse();
  }
}

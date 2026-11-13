import { makeWetSurface } from '../../render/weather/WetSurfaces.ts';
import {appearancePhysicsMesh} from './appearanceGeometry.ts';
import type {AppearanceStyle} from '../../net2/appearance.ts';
// Отображение танка: по alternativa/tanks/battle/objects/tank/{TankSkin,TankSkinPart,TankSkinHull,TankSkinTurret}.as.
// Детали конвертирует tools/convert_tank_parts.py в html5/public/tank_parts.
import * as THREE from 'three';
import { Matrix4 } from '../../physics/math/Matrix4.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { registerAmbientShadowCaster, type AmbientShadowCaster } from '../../render/AmbientShadows.ts';
import { materialLibrary } from '../../render/materials/MaterialLibrary.ts';

// поднимать при изменении конвертера, иначе браузер отдаст кеш
const ASSET_VERSION = '5';
const PART_VERSION = '6';

export interface PartObject {
  name: string;
  parent: string | null;
  position: [number, number, number];
  rotation: [number, number, number];
  positions?: number[];
  uvs?: number[];
  indices?: number[];
  /** грани по материалам 3ds (convert_tank_parts.py, чанк 0x4130) */
  faceMaterials?: Record<string, number[]>;
}

/** Параметры корпуса в единицах сервера (TankModelCC + TankInitializationData) */
export interface HullSpec {
  mass: number;
  damping: number;
  speed: number;
  turnSpeed: number;
  acceleration: number;
  reverseAcceleration: number;
  sideAcceleration: number;
  turnAcceleration: number;
  reverseTurnAcceleration: number;
  /** максимум здоровья (TankModelCC.max_health = hull_armor) */
  armor: number;
}

/** Параметры башни (WeaponCommonCC) */
export interface TurretSpec {
  turretRotationSpeed: number;
  turretRotationAcceleration: number;
  impactForce: number;
  kickback: number;
  reloadTime: number;
}

interface PartJson {
  physicalObjects?:PartObject[];
  appearance?:AppearanceStyle;
  objects: PartObject[];
  textures: Record<string, { file: string; alpha?: string }>;
  spec: HullSpec | TurretSpec;
}

export interface MeshBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // ассеты могут лежать на CDN (другой домен): без CORS canvas с картинкой нельзя читать
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('не загрузилась картинка ' + url));
    image.src = url;
  });
}

/** Картинка с альфой из отдельного jpg (images.xml: details.png -> details.jpg + details_alpha.jpg) */
export async function loadImageWithAlpha(url: string, alphaUrl: string | undefined): Promise<CanvasImageSource> {
  const image = await loadImage(url);
  if (!alphaUrl) return image;
  const alpha = await loadImage(alphaUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.drawImage(alpha, 0, 0, image.width, image.height);
  const alphaData = context.getImageData(0, 0, image.width, image.height).data;
  context.clearRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, image.width, image.height);
  for (let n = 0; n < imageData.data.length; n += 4) imageData.data[n + 3] = alphaData[n];
  context.putImageData(imageData, 0, 0);
  return canvas;
}

function findObject(part: PartJson, pattern: RegExp): PartObject | undefined {
  return part.objects.find((object) => pattern.test(object.name));
}

/** @param faces номера граней; без них — все грани, кроме excluded */
function buildGeometry(object: PartObject, faces: number[] | null = null, excluded: Set<number> | null = null): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(object.positions ?? [], 3));
  // V как в 3ds: Three.js переворачивает текстуру (flipY), см. map/proplibs.ts
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(object.uvs ?? [], 2));
  const all = object.indices ?? [];
  if (faces == null && excluded == null) {
    geometry.setIndex(all);
  } else {
    const keep = faces != null ? new Set(faces) : null;
    const indices: number[] = [];
    const count = all.length / 3;
    for (let face = 0; face < count; face++) {
      if (keep != null ? !keep.has(face) : excluded?.has(face)) continue;
      indices.push(all[3 * face], all[3 * face + 1], all[3 * face + 2]);
    }
    geometry.setIndex(indices);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** TankSkin.createTrackSkins: гусеницы — грани материала tracks (у Хантера в 3ds он назван track) */
function trackFaces(object: PartObject): number[] {
  const result: number[] = [];
  for (const [name, faces] of Object.entries(object.faceMaterials ?? {})) if (/^tracks?$/i.test(name)) result.push(...faces);
  return result;
}

/** Затемнение крутящихся гусениц (по просьбе пользователя: текстура details на ходу выглядит блеклой); 1 — как в оригинале */
const TRACK_SHADE = 0.6;

/**
 * TrackSkin + TrackMaterial (2019): гусеница рисуется текстурой details, которая сдвигается по U на пройденный путь;
 * ratio — сколько U приходится на единицу длины (среднее по граням, по первому ребру грани).
 */
class TrackSkin {
  readonly mesh: THREE.Mesh;
  private readonly ratio: number;
  private distance = 0;
  private readonly trackMap: THREE.Texture | null;

  constructor(object: PartObject, faces: number[], details: CanvasImageSource | null) {
    const p = object.positions ?? [];
    const uv = object.uvs ?? [];
    const indices = object.indices ?? [];
    let sum = 0;
    for (const face of faces) {
      const a = indices[3 * face];
      const b = indices[3 * face + 1];
      const length = Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
      const uvLength = Math.hypot(uv[2 * a] - uv[2 * b], uv[2 * a + 1] - uv[2 * b + 1]);
      if (length > 0) sum += uvLength / length;
    }
    this.ratio = faces.length > 0 ? sum / faces.length : 0;
    if (details) {
      const texture = new THREE.Texture(details as HTMLImageElement);
      texture.wrapS = THREE.RepeatWrapping;
      texture.colorSpace = THREE.NoColorSpace;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      this.trackMap = texture;
    } else {
      this.trackMap = null;
    }
    // гусеницы — тёмный грубый металл: PBR даёт блик по тракам, Lambert такого не умел
    const material = materialLibrary.create({
      flatShading: true,
      side: THREE.DoubleSide,
      map: this.trackMap,
      roughness: 0.9,
      metalness: 0.35,
    }) as THREE.MeshStandardMaterial;
    material.color.setScalar(TRACK_SHADE);
    this.mesh = new THREE.Mesh(buildGeometry(object, faces), material);
  }

  /** TrackSkin.move: путь в единицах мира */
  move(delta: number): void {
    this.distance = (this.distance + delta * this.ratio) % 1;
    if (this.trackMap) this.trackMap.offset.x = this.distance;
  }

  /** живой танк — своя текстура гусениц, мёртвый — общая «мёртвая» текстура корпуса (setTracksMaterial) */
  setMap(map: THREE.Texture | null): void {
    const material = this.mesh.material as THREE.MeshStandardMaterial;
    material.map = map ?? this.trackMap;
    // мёртвый танк — как корпус, без затемнения
    material.color.setScalar(map ? 1 : TRACK_SHADE);
    material.needsUpdate = true;
  }

  setAlpha(alpha: number): void {
    const material = this.mesh.material as THREE.MeshStandardMaterial;
    const transparent = alpha < 1;
    if (material.transparent != transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
    material.opacity = alpha;
  }
}

function boundsOf(object: PartObject): MeshBounds {
  const p = object.positions ?? [];
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let n = 0; n < p.length; n += 3) {
    bounds.minX = Math.min(bounds.minX, p[n]);
    bounds.maxX = Math.max(bounds.maxX, p[n]);
    bounds.minY = Math.min(bounds.minY, p[n + 1]);
    bounds.maxY = Math.max(bounds.maxY, p[n + 1]);
    bounds.minZ = Math.min(bounds.minZ, p[n + 2]);
    bounds.maxZ = Math.max(bounds.maxZ, p[n + 2]);
  }
  return bounds;
}

/** Деталь танка: меш, lightmap и details (TankSkinPart) */
export class TankSkinPart {
  readonly mesh: THREE.Mesh;
  readonly bounds: MeshBounds;
  protected constructor(
    readonly part: PartJson,
    meshObject: PartObject,
    private readonly lightmap: CanvasImageSource & { width: number; height: number },
    private readonly details: CanvasImageSource | null,
    excludedFaces: Set<number> | null = null,
  ) {
    this.bounds = boundsOf(appearancePhysicsMesh(meshObject,part.physicalObjects));
    // Грани танка в Flash освещаются по нормали грани (calculateFacesNormals)
    // броня: краска по металлу — заметный блик и отражение окружения
    const material = materialLibrary.create({
      color: 0xffffff,
      flatShading: true,
      side: THREE.DoubleSide,
      roughness: 0.62,
      metalness: 0.35,
    }) as THREE.MeshStandardMaterial;
    makeWetSurface(material, true);
    this.mesh = new THREE.Mesh(buildGeometry(meshObject, null, excludedFaces), material);
    this.mesh.matrixAutoUpdate = false;
  }

  /** createTexture: краска плиткой, поверх lightmap в режиме HARDLIGHT, сверху details */
  applyColoring(coloring: CanvasImageSource & { width: number; height: number }): void {
    this.normalMap = this.createColoredTexture(coloring);
    const material = this.mesh.material as THREE.MeshStandardMaterial;
    material.map = this.normalMap;
    material.needsUpdate = true;
  }

  private normalMap: THREE.Texture | null = null;
  private deadMap: THREE.Texture | null = null;

  /** TankSkin.setDeadState: вместо краски на деталь ложится текстура «мёртвого» танка */
  setDeadState(deadColoring: CanvasImageSource & { width: number; height: number }): void {
    this.deadMap ??= this.createColoredTexture(deadColoring);
    const material = this.mesh.material as THREE.MeshStandardMaterial;
    material.map = this.deadMap;
    material.needsUpdate = true;
    this.onDeadState(this.deadMap);
  }

  protected onDeadState(_deadMap: THREE.Texture): void {}

  protected onNormalState(): void {}

  protected onAlpha(_alpha: number): void {}

  /** TankSkin.setAlpha: полупрозрачность (0.5 — танк после спавна до активации, к 0 — исчезающий труп) */
  setAlpha(alpha: number): void {
    const material = this.mesh.material as THREE.MeshStandardMaterial;
    const transparent = alpha < 1;
    if (material.transparent != transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
    material.opacity = alpha;
    this.onAlpha(alpha);
  }

  setNormalState(): void {
    this.onNormalState();
    if (!this.normalMap) return;
    const material = this.mesh.material as THREE.MeshStandardMaterial;
    material.map = this.normalMap;
    material.needsUpdate = true;
  }

  private createColoredTexture(coloring: CanvasImageSource & { width: number; height: number }): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = this.lightmap.width;
    canvas.height = this.lightmap.height;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = context.createPattern(coloring, 'repeat') as CanvasPattern;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'hard-light';
    context.drawImage(this.lightmap, 0, 0);
    context.globalCompositeOperation = 'source-over';
    if (this.details) context.drawImage(this.details, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    // цвет без sRGB-преобразований, как во Flash (см. map/lighting.ts)
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = 4;
    return texture;
  }

  protected static async loadTextures(baseUrl: string, part: PartJson) {
    const lightmapEntry = part.textures['lightmap.jpg'];
    const detailsEntry = part.textures['details.png'];
    const lightmap = lightmapEntry
      ? await loadImage(`${baseUrl}/${lightmapEntry.file}?v=${ASSET_VERSION}`)
      : solidCanvas('#7f7f7f');
    const details = detailsEntry
      ? await loadImageWithAlpha(
          `${baseUrl}/${detailsEntry.file}?v=${ASSET_VERSION}`,
          detailsEntry.alpha ? `${baseUrl}/${detailsEntry.alpha}?v=${ASSET_VERSION}` : undefined,
        )
      : null;
    return { lightmap, details };
  }
}

function solidCanvas(color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.fillStyle = color;
  context.fillRect(0, 0, 4, 4);
  return canvas;
}

export class TankSkinHull extends TankSkinPart {
  readonly turretMountPoint: Vector3; // §^!w§
  /** путь детали (tank_parts/hulls/<имя>/<mN>) — по нему включаются особенности корпуса (турбина Varan) */
  source = '';

  get spec(): HullSpec {
    return this.part.spec as HullSpec;
  }

  private readonly leftTrack: TrackSkin | null = null;
  private readonly rightTrack: TrackSkin | null = null;

  private constructor(part: PartJson, meshObject: PartObject, lightmap: HTMLImageElement | HTMLCanvasElement, details: CanvasImageSource | null) {
    const tracks = trackFaces(meshObject);
    super(part, meshObject, lightmap, details, tracks.length > 0 ? new Set(tracks) : null);
    if (tracks.length > 0) {
      // TankSkin.addFaceToTrackSkin: левая гусеница — грани, у которых первая вершина с x < 0
      const p = meshObject.positions ?? [];
      const indices = meshObject.indices ?? [];
      this.leftTrack = new TrackSkin(meshObject, tracks.filter((face) => p[3 * indices[3 * face]] < 0), details);
      this.rightTrack = new TrackSkin(meshObject, tracks.filter((face) => p[3 * indices[3 * face]] >= 0), details);
      this.mesh.add(this.leftTrack.mesh, this.rightTrack.mesh);
    }
    const mount = findObject({...part,objects:part.physicalObjects??part.objects}, /mount/i);
    if (!mount) throw new Error('у корпуса нет точки mount');
    this.turretMountPoint = new Vector3(mount.position[0], mount.position[1], mount.position[2]);
  }

  /** TankSkin.updateTracks: путь левой и правой гусеницы за кадр */
  updateTracks(left: number, right: number): void {
    this.leftTrack?.move(left);
    this.rightTrack?.move(right);
  }

  protected override onDeadState(deadMap: THREE.Texture): void {
    this.leftTrack?.setMap(deadMap);
    this.rightTrack?.setMap(deadMap);
  }

  protected override onNormalState(): void {
    this.leftTrack?.setMap(null);
    this.rightTrack?.setMap(null);
  }

  protected override onAlpha(alpha: number): void {
    this.leftTrack?.setAlpha(alpha);
    this.rightTrack?.setAlpha(alpha);
  }

  static async load(baseUrl: string): Promise<TankSkinHull> {
    const part = await fetchJson<PartJson>(`${baseUrl}/part.json?v=${PART_VERSION}`);
    const meshObject = findObject(part, /hull/i);
    if (!meshObject) throw new Error('в 3ds корпуса нет объекта hull');
    const { lightmap, details } = await TankSkinPart.loadTextures(baseUrl, part);
    const hull = new TankSkinHull(part, meshObject, lightmap, details);
    hull.source = baseUrl;
    return hull;
  }
}

export class TankSkinTurret extends TankSkinPart {
  readonly flagMountPoint: Vector3; // §=!+§
  readonly muzzles: Vector3[]; // §@!t§

  get spec(): TurretSpec {
    return this.part.spec as TurretSpec;
  }

  private constructor(part: PartJson, meshObject: PartObject, lightmap: HTMLImageElement | HTMLCanvasElement, details: CanvasImageSource | null) {
    super(part, meshObject, lightmap, details);
    const flag = findObject({...part,objects:part.physicalObjects??part.objects}, /fmnt/i);
    this.flagMountPoint = flag ? new Vector3(flag.position[0], flag.position[1], flag.position[2]) : new Vector3();
    this.muzzles = (part.physicalObjects??part.objects).filter((object) => /muzzle.*/.test(object.name)).map((object) => new Vector3(object.position[0], object.position[1], object.position[2]));
    if (this.muzzles.length == 0) throw new Error('у башни нет точек muzzle');
  }

  static async load(baseUrl: string): Promise<TankSkinTurret> {
    const part = await fetchJson<PartJson>(`${baseUrl}/part.json?v=${PART_VERSION}`);
    const meshObject = findObject(part, /turret/i);
    if (!meshObject) throw new Error('в 3ds башни нет объекта turret');
    const { lightmap, details } = await TankSkinPart.loadTextures(baseUrl, part);
    return new TankSkinTurret(part, meshObject, lightmap, details);
  }
}

const turretLocal = new Matrix4(); // §"!z§

function toThree(m: Matrix4, target: THREE.Matrix4): void {
  target.set(m.a, m.b, m.c, m.d, m.e, m.f, m.g, m.h, m.i, m.j, m.k, m.l, 0, 0, 0, 1);
}

export class TankSkin {
  readonly hullMatrix = new Matrix4(); // положение меша корпуса (§?3§)
  readonly turretMatrix = new Matrix4(); // положение меша башни (§8!v§)

  constructor(
    readonly hull: TankSkinHull,
    readonly turret: TankSkinTurret,
    /** путь детали башни (tank_parts/turrets/<пушка>/m<n>): по нему выбирается оружие и его эффекты */
    readonly turretPath = '',
  ) {}

  /** номер модификации рельсы (0..3) или null, если башня не рельса */
  get railgunModification(): number | null {
    const match = /turrets\/railgun\/m(\d)/.exec(this.turretPath);
    return match ? Number(match[1]) : null;
  }

  /** башня — Twins (TwinsModel, плазма) */
  get isTwins(): boolean {
    return /turrets\/twins\//.test(this.turretPath);
  }

  /** имя пушки из пути башни: smoky, railgun, twins, thunder, shaft, firebird, freeze, isida, ricochet */
  get turretStyle():AppearanceStyle{return this.turret.part.appearance??'gen2';}

  get turretKind(): string | null {
    const match = /turrets\/([a-z_]+)\/m\d/.exec(this.turretPath);
    return match ? match[1] : null;
  }

  /** модификация башни m0–m3 из пути (0, если путь без номера) */
  get turretModification(): number {
    const match = /turrets\/[a-z_]+\/m(\d)/.exec(this.turretPath);
    return match ? Math.max(0, Math.min(3, Number(match[1]))) : 0;
  }

  static async load(hullPath: string, turretPath: string, paintUrl: string): Promise<TankSkin> {
    const [hull, turret, paint] = await Promise.all([
      TankSkinHull.load(hullPath),
      TankSkinTurret.load(turretPath),
      loadImage(`${paintUrl}?v=${ASSET_VERSION}`),
    ]);
    hull.applyColoring(paint);
    turret.applyColoring(paint);
    return new TankSkin(hull, turret, turretPath);
  }

  setDeadState(deadColoring: CanvasImageSource & { width: number; height: number }): void {
    this.hull.setDeadState(deadColoring);
    this.turret.setDeadState(deadColoring);
  }

  setNormalState(): void {
    this.hull.setNormalState();
    this.turret.setNormalState();
  }

  setAlpha(alpha: number): void {
    this.hull.setAlpha(alpha);
    this.turret.setAlpha(alpha);
  }

  updateTracks(left: number, right: number): void {
    this.hull.updateTracks(left, right);
  }

  addToScene(parent: THREE.Object3D): void {
    parent.add(this.hull.mesh);
    parent.add(this.turret.mesh);
    // «Тень под танком» (TankSkin.createAmbientShadow): заслоняют корпус с гусеницами и башня, alpha тени — от alpha танка
    this.shadowCaster ??= {
      meshes: [this.hull.mesh, this.turret.mesh],
      alpha: () => {
        const material = this.hull.mesh.material as THREE.Material;
        return material.transparent ? material.opacity : 1;
      },
    };
    registerAmbientShadowCaster(this.shadowCaster);
  }

  private shadowCaster: AmbientShadowCaster | null = null;

  /** updateHullTransform: матрица корпуса уже собрана из интерполированного состояния */
  updateHullTransform(matrix: Matrix4): void {
    this.hullMatrix.copy(matrix);
    toThree(this.hullMatrix, this.hull.mesh.matrix);
    this.hull.mesh.matrixWorldNeedsUpdate = true;
  }

  /** updateTurretTransform: башня стоит на точке mount (+1 по Z) и повёрнута на угол direction */
  updateTurretTransform(direction: number): void {
    const mount = this.hull.turretMountPoint;
    turretLocal.setMatrix(mount.x, mount.y, mount.z + 1, 0, 0, direction);
    turretLocal.append(this.hullMatrix);
    this.turretMatrix.copy(turretLocal);
    toThree(this.turretMatrix, this.turret.mesh.matrix);
    this.turret.mesh.matrixWorldNeedsUpdate = true;
  }
}

import * as THREE from 'three';
import { deriveSurfaceMaps } from './SurfaceMaps.ts';

/**
 * Фабрика материалов рендера: единственное место, где решается «PBR или старый Lambert».
 *
 * Пока у ассетов 2014 года нет карт нормалей/шероховатости, PBR строится на том, что есть:
 * diffuse-текстура (albedo), плоские нормали геометрии (flatShading), шероховатость по умолчанию
 * и окружение (scene.environment), которое даёт недорогой отражённый свет.
 *
 * `pbr = false` возвращает прежние MeshLambertMaterial — для сравнения (?nopbr) и на слабых машинах.
 */
export interface MaterialSpec {
  /** diffuse-текстура (albedo) */
  map?: THREE.Texture | null;
  /** цвет-множитель (если текстуры нет — базовый цвет) */
  color?: number;
  side?: THREE.Side;
  alphaTest?: number;
  transparent?: boolean;
  opacity?: number;
  flatShading?: boolean;
  depthWrite?: boolean;
  roughness?: number;
  metalness?: number;
  /** сколько отражённого света окружения добавлять (только PBR) */
  envMapIntensity?: number;
}

export class MaterialLibrary {
  /** включён ли PBR-путь (false — старые Lambert-материалы) */
  pbr = true;
  /** насколько шероховаты материалы по умолчанию: старые текстуры без карт шероховатости */
  defaultRoughness = 0.88;
  defaultMetalness = 0.02;
  envMapIntensity = 0.22;
  /** считать нормали/шероховатость из diffuse-текстуры (PBR-карты неровностей) */
  deriveMaps = true;

  private readonly cache = new Map<string, THREE.Material>();

  /** материал по описанию; с кэшем по явному ключу (если передан) */
  create(spec: MaterialSpec, key?: string): THREE.Material {
    if (key) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    const material = this.pbr ? this.createPbr(spec) : this.createLegacy(spec);
    if (key) this.cache.set(key, material);
    return material;
  }

  private createLegacy(spec: MaterialSpec): THREE.MeshLambertMaterial {
    return new THREE.MeshLambertMaterial({
      map: spec.map ?? undefined,
      color: spec.color ?? 0xffffff,
      side: spec.side ?? THREE.FrontSide,
      alphaTest: spec.alphaTest ?? 0,
      transparent: spec.transparent ?? false,
      opacity: spec.opacity ?? 1,
      flatShading: spec.flatShading ?? false,
      depthWrite: spec.depthWrite ?? true,
    });
  }

  private createPbr(spec: MaterialSpec): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      map: spec.map ?? undefined,
      color: spec.color ?? 0xffffff,
      side: spec.side ?? THREE.FrontSide,
      alphaTest: spec.alphaTest ?? 0,
      transparent: spec.transparent ?? false,
      opacity: spec.opacity ?? 1,
      flatShading: spec.flatShading ?? false,
      depthWrite: spec.depthWrite ?? true,
      roughness: spec.roughness ?? this.defaultRoughness,
      metalness: spec.metalness ?? this.defaultMetalness,
      envMapIntensity: spec.envMapIntensity ?? this.envMapIntensity,
    });
    if (this.deriveMaps && spec.map) {
      const maps = deriveSurfaceMaps(spec.map);
      if (maps) {
        material.normalMap = maps.normalMap;
        material.roughnessMap = maps.roughnessMap;
        // шероховатость берётся из карты, множитель — 1
        material.roughness = 1;
        material.normalScale.set(0.7, 0.7);
        material.needsUpdate = true;
      }
    }
    return material;
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    this.cache.clear();
  }
}

/** общая библиотека: материалы карты, пропов и декораций создаются здесь */
export const materialLibrary = new MaterialLibrary();

/**
 * Окружение для PBR: градиент «небо → горизонт → земля», размытый в PMREM.
 * Дорого создавать каждый кадр, поэтому один раз при старте; пересоздаём только при смене палитры карты.
 */
export function createSkyEnvironment(
  renderer: THREE.WebGLRenderer,
  sky: number,
  horizon: number,
  ground: number,
): THREE.Texture {
  const width = 128;
  const height = 64;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('createSkyEnvironment: нет 2d-контекста');
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;
  gradient.addColorStop(0, hex(sky));
  gradient.addColorStop(0.55, hex(horizon));
  gradient.addColorStop(1, hex(ground));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;

  const generator = new THREE.PMREMGenerator(renderer);
  const environment = generator.fromEquirectangular(texture).texture;
  generator.dispose();
  texture.dispose();
  return environment;
}

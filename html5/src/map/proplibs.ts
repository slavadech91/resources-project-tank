import { makeWetSurface } from '../render/weather/WetSurfaces.ts';
import * as THREE from 'three';
import type { PropPlacement } from './types';
import { makeAmbientShadowReceiver } from '../render/AmbientShadows.ts';
import { materialLibrary } from '../render/materials/MaterialLibrary.ts';

// Библиотеки пропов: конвертированные из library.tara данные
// (см. tools/convert_proplibs.py). Меши приходят плоскими массивами.

// Версия ассетов: поднимать при изменении конвертера, иначе браузер отдаст кеш.
export const ASSET_VERSION = '32'

export interface MeshPart {
  name: string;
  positions: number[];
  uvs: number[];
  indices: number[];
  /** своя текстура объекта 3ds (материал не основной: Plane_1 «Slope 1» — grass.jpg); нет — текстура пропа */
  texture?: string;
}

export interface LibraryProp {
  name: string;
  mesh: string | null;
  textures: Record<string, string>;
  /** Sprite3D: кусты, деревья, таблички; originY — доля высоты от верха до точки привязки */
  sprite?: { file: string; originY: number; scale: number } | null;
}

export interface LibraryJson {
  library: string;
  sourceDir: string;
  version: number;
  groups: { name: string; props: LibraryProp[] }[];
  meshes: Record<string, MeshPart[]>;
  textures: string[];
}

/** Запись из proplibs.xml карты */
export interface PropLibraryRef {
  name: string;
  dir: string;
  version: number;
}

function parseXml(source: string): Document {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.getElementsByTagName('parsererror')[0]) throw new Error('плохой XML proplibs');
  return doc;
}

export function parseProplibs(source: string): PropLibraryRef[] {
  const doc = parseXml(source);
  return Array.from(doc.getElementsByTagName('library')).map((el) => ({
    name: el.getAttribute('name') ?? '',
    dir: (el.getAttribute('resource-id') ?? '').split('/').pop() ?? '',
    version: Number(el.getAttribute('version') ?? '1'),
  }));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Собирает все части меша в одну геометрию (позиции, UV, индексы) */
function mergeParts(parts: MeshPart[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  for (const part of parts) {
    positions.push(...part.positions);
    if (part.uvs.length > 0) {
      // V в 3ds идёт снизу вверх — как и ждёт Three.js при flipY = true (по умолчанию
      // у TextureLoader), поэтому берём как есть. С `1 - v` атласы съезжали
      // (на щите Promotion вместо плаката рисовался камень из низа атласа).
      uvs.push(...part.uvs);
    } else {
      // у всех вершин должен быть UV, иначе атрибуты разъедутся
      for (let i = 0; i < part.positions.length / 3; i += 1) uvs.push(0, 0);
    }
    for (const index of part.indices) indices.push(index + vertexOffset);
    vertexOffset += part.positions.length / 3;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export interface PropLibraryData {
  ref: PropLibraryRef;
  json: LibraryJson;
  propByName: Map<string, LibraryProp>;
  geometryByMesh: Map<string, THREE.BufferGeometry>;
  /** части меша со своими текстурами — отдельные геометрии */
  extraByMesh: Map<string, { texture: string; geometry: THREE.BufferGeometry }[]>;
  dir: string;
}

export async function loadPropLibraries(
  refs: PropLibraryRef[],
  baseUrl: string,
): Promise<Map<string, PropLibraryData>> {
  const result = new Map<string, PropLibraryData>();

  await Promise.all(
    refs.map(async (ref) => {
      const url = `${baseUrl}/proplibs/${ref.dir}/library.json?v=${ASSET_VERSION}`;
      let json: LibraryJson;
      try {
        json = await fetchJson<LibraryJson>(url);
      } catch (error) {
        console.warn(`библиотека пропов не найдена: ${ref.name} (${url})`, error);
        return;
      }

      const propByName = new Map<string, LibraryProp>();
      for (const group of json.groups) {
        for (const prop of group.props) propByName.set(prop.name, prop);
      }

      const geometryByMesh = new Map<string, THREE.BufferGeometry>();
      const extraByMesh = new Map<string, { texture: string; geometry: THREE.BufferGeometry }[]>();
      for (const [meshFile, parts] of Object.entries(json.meshes)) {
        geometryByMesh.set(meshFile, mergeParts(parts.filter((part) => !part.texture)));
        const byTexture = new Map<string, MeshPart[]>();
        for (const part of parts) if (part.texture) byTexture.set(part.texture, [...(byTexture.get(part.texture) ?? []), part]);
        if (byTexture.size > 0) extraByMesh.set(meshFile, [...byTexture].map(([texture, list]) => ({ texture, geometry: mergeParts(list) })));
      }

      result.set(ref.name, { ref, json, propByName, geometryByMesh, extraByMesh, dir: ref.dir });
    }),
  );

  return result;
}

/** Кеш текстур и материалов на библиотеку */
export class MaterialPool {
  private textureCache = new Map<string, THREE.Texture>();
  private materialCache = new Map<string, THREE.Material>();

  constructor(
    private loader: THREE.TextureLoader,
    private baseUrl: string,
  ) {}

  private spriteMaterialCache = new Map<string, THREE.SpriteMaterial>();

  private texture(library: PropLibraryData, textureFile: string): THREE.Texture {
    const textureKey = `${library.dir}/${textureFile}`;
    let map = this.textureCache.get(textureKey);
    if (!map) {
      map = this.loader.load(`${this.baseUrl}/proplibs/${library.dir}/tex/${textureFile}?v=${ASSET_VERSION}`);
      // цвет без sRGB-преобразований, как во Flash (см. lighting.ts)
      map.colorSpace = THREE.NoColorSpace;
      map.anisotropy = 4;
      this.textureCache.set(textureKey, map);
    }
    return map;
  }

  /** Материал спрайта: картинка с прозрачностью, отсечение по альфе, без освещения */
  getSprite(library: PropLibraryData, textureFile: string): THREE.SpriteMaterial {
    const key = `${library.dir}/${textureFile}`;
    let material = this.spriteMaterialCache.get(key);
    if (!material) {
      material = new THREE.SpriteMaterial({ map: this.texture(library, textureFile), alphaTest: 0.5, transparent: false });
      this.spriteMaterialCache.set(key, material);
    }
    return material;
  }

  get(library: PropLibraryData, textureFile: string | null): THREE.Material {
    const key = textureFile ? `${library.dir}/${textureFile}` : `${library.dir}::none`;
    const cached = this.materialCache.get(key);
    if (cached) return cached;

    const map = textureFile ? this.texture(library, textureFile) : null;

    // Пропы — открытые оболочки из 3ds: рисуем с обеих сторон и с плоскими нормалями
    // (в моделях нет групп сглаживания, углы должны быть резкими, как в оригинале).
    // PNG — с прозрачностью (перила моста brid_1.png): отсекаем по альфе, без сортировки.
    const material = materialLibrary.create({
      map: map ?? undefined,
      color: map ? 0xffffff : 0x8b9099,
      side: THREE.DoubleSide,
      flatShading: true,
      alphaTest: textureFile && /\.png$/i.test(textureFile) ? 0.5 : 0,
      roughness: 0.94,
      metalness: 0.01,
    });
    // «Тень под танком» ложится на пропы карты
    makeAmbientShadowReceiver(material);
    makeWetSurface(material);
    this.materialCache.set(key, material);
    return material;
  }
}

/** Строит меши пропов карты; пропы без модели возвращает для запасных боксов */
export function buildRealProps(
  props: PropPlacement[],
  libraries: Map<string, PropLibraryData>,
  pool: MaterialPool,
  parent: THREE.Object3D,
): { placed: number; skipped: PropPlacement[] } {
  let placed = 0;
  const skipped: PropPlacement[] = [];

  for (const prop of props) {
    const library = libraries.get(prop.library);
    const libraryProp = library?.propByName.get(prop.name);
    const meshFile = libraryProp?.mesh ?? null;
    const geometry = meshFile ? library!.geometryByMesh.get(meshFile) : undefined;

    const spriteInfo = libraryProp?.sprite;
    if (library && !geometry && spriteInfo?.file) {
      parent.add(buildSprite(prop, library, spriteInfo, pool));
      placed += 1;
      continue;
    }

    if (!library || !geometry) {
      skipped.push(prop);
      continue;
    }

    // текстура пропа: имя из map.xml, иначе текстура по умолчанию (ключ '')
    const textures = libraryProp?.textures ?? {};
    // имя текстуры из карты может отсутствовать в библиотеке (у новых пропов материалы зашиты в 3ds):
// тогда берём первую текстуру самого пропа, чтобы материал не оставался серым без карты
const textureFile =
      (prop.texture ? textures[prop.texture] : undefined) ??
      textures[''] ??
      Object.values(textures)[0] ??
      null;
    const parts = [{ geometry, material: pool.get(library, textureFile) }];
    for (const extra of library.extraByMesh.get(meshFile!) ?? []) parts.push({ geometry: extra.geometry, material: pool.get(library, extra.texture) });
    for (const part of parts) {
      if (!part.geometry.getAttribute('position')?.count) continue;
      const mesh = new THREE.Mesh(part.geometry, part.material);
      mesh.position.set(prop.position.x, prop.position.y, prop.position.z);
      // порядок поворотов как в Alternativa: Rz·Ry·Rx
      mesh.rotation.set(prop.rotation.x, prop.rotation.y, prop.rotation.z, 'ZYX');
      mesh.userData.library = prop.library;
      mesh.userData.propName = prop.name;
      mesh.userData.texture = prop.texture ?? '';
      parent.add(mesh);
    }
    placed += 1;
  }

  return { placed, skipped };
}

/**
 * Sprite3D из библиотеки: картинка всегда повёрнута к камере, размер — пиксели картинки × scale,
 * точка пропа — на высоте originY от верха картинки (0.99 — почти нижний край, спрайт стоит на земле).
 */
function buildSprite(prop: PropPlacement, library: PropLibraryData, info: { file: string; originY: number; scale: number }, pool: MaterialPool): THREE.Sprite {
  const material = pool.getSprite(library, info.file);
  const sprite = new THREE.Sprite(material);
  sprite.position.set(prop.position.x, prop.position.y, prop.position.z);
  sprite.center.set(0.5, 1 - info.originY);
  const applySize = (): void => {
    const image = material.map?.image as { width?: number; height?: number } | undefined;
    if (image?.width && image.height) sprite.scale.set(image.width * info.scale, image.height * info.scale, 1);
  };
  applySize();
  if (sprite.scale.x == 1) {
    // текстура ещё грузится: размер выставим, когда придёт картинка
    const timer = setInterval(() => {
      applySize();
      if (sprite.scale.x != 1) clearInterval(timer);
    }, 100);
  }
  sprite.userData.library = prop.library;
  sprite.userData.propName = prop.name;
  return sprite;
}

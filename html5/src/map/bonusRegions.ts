// Метки зон выпадения ящиков (BonusRegionService / BonusRegion из клиента Narukami; в клиенте 2014 их нет).
// В Narukami метка — квадрат REGION_SIZE × REGION_SIZE в точке зоны (+5 по высоте), но у наших карт точка зоны —
// низ бокса, откуда падает ящик, и она бывает выше земли. Поэтому метка ищет землю лучом вниз и ложится на неё
// следом (как DecalEffect: грани пропов под меткой обрезаются её боксом), повёрнутым как зона.
// Показывается настройкой «Показывать зоны ящиков» (settings.showDropZones).
// В бою server2 общая зона показывает тип текущего ящика.
import * as THREE from 'three';
import { Vector3 } from '../physics/math/Vector3.ts';
import { buildDecalGeometry } from '../tanks/sfx/SmokyEffects.ts';
import type { BonusRegion } from './types.ts';
import type { BattleMode, BonusInfo, BonusKind } from '../net2/protocol.ts';
import { BONUS_MARK_SIZE, BONUS_RAY_START, bonusZoneKey } from './bonusDrop.ts';
import { addShaderPatch } from '../render/shaderHooks.ts';

/** BonusRegionService.REGION_SIZE / REGION_DECAL_ACSENSION */
const REGION_DECAL_ASCENSION = 5;
/** глубина бокса следа: грани выше и ниже земли на столько ещё попадают в метку */
const DECAL_DEPTH = 150;
/** луч к земле начинается над верхом бокса зоны и идёт вниз не дальше этого */
const GROUND_RAY_LENGTH = 5000;

/** тип бонуса из map_server.xml -> текстура метки */
const REGION_TEXTURES: Record<string, string> = {
  armorup: 'battle/bonus_regions/overhaul/armorup.webp',
  damageup: 'battle/bonus_regions/overhaul/damageup.webp',
  medkit: 'battle/bonus_regions/overhaul/medkit.webp',
  nitro: 'battle/bonus_regions/overhaul/nitro.webp',
};
const ARCHIVE_GOLD_MARK = 'battle/bonus_regions/2042-2019/cry.png';
const ARCHIVE_2042_TEXTURES: Record<string, string> = {
  armorup: 'battle/bonus_regions/2042-2019/arm.png',
  damageup: 'battle/bonus_regions/2042-2019/dam.png',
  medkit: 'battle/bonus_regions/2042-2019/hea.png',
  nitro: 'battle/bonus_regions/2042-2019/nit.png',
  crystal: ARCHIVE_GOLD_MARK,
  crystal_100: ARCHIVE_GOLD_MARK,
};
const REGION_KIND: Record<BonusKind, string> = {
  armor: 'armorup', power: 'damageup', med: 'medkit', nos: 'nitro', crystal: 'crystal', gold: 'crystal_100',
};
/** версия текстур в адресе: браузер держит картинки час, после замены текстур увеличивать */
const REGION_TEXTURE_VERSION = 3;

/** Порядок отрисовки: раньше остальных прозрачных объектов (ящиков, следов, эффектов) — метка лежит на полу под ними */
const DECALS_RENDER_ORDER = -1;

const raycaster = new THREE.Raycaster();
const down = new THREE.Vector3(0, 0, -1);
const normalMatrix = new THREE.Matrix3();

export class BonusRegionMarks {
  readonly group = new THREE.Group();
  private readonly materials = new Map<string, THREE.MeshLambertMaterial>();
  private readonly loadedTextures = new Map<string, THREE.Texture>();
  private readonly zones = new Map<string, { mesh: THREE.Mesh; idleType?: string }>();
  private readonly active = new Map<number, string>();
  private readonly textures: Record<string, string>;
  private readonly archive2042: boolean;

  /** groundMeshes — непрозрачные меши пропов карты (дети world с userData.propName) */
  constructor(regions: BonusRegion[], private readonly textureLoader: THREE.TextureLoader, groundMeshes: THREE.Mesh[], mode?: BattleMode, mapKey?: string) {
    this.group.name = 'bonus-regions';
    this.archive2042 = mapKey === '2042' || mapKey === 'sandbox';
    this.textures = mapKey && !mapKey.includes('old') ? ARCHIVE_2042_TEXTURES : REGION_TEXTURES;
    const zones = new Map<string, { region: BonusRegion; types: Set<string> }>();
    groundMeshes[0]?.parent?.updateMatrixWorld(true);
    for (const region of regions) {
      if (mode && region.gameModes.length && !region.gameModes.includes(mode)) continue;
      const key = bonusZoneKey(region.position);
      let zone = zones.get(key);
      if (!zone) zones.set(key, zone = { region, types: new Set() });
      for (const type of region.bonusTypes) {
        if (this.textures[type] || type === 'crystal' || type === 'crystal_100') zone.types.add(type);
      }
    }
    for (const [key, { region, types }] of zones) {
      const defaultType = [...types].find(type => this.textures[type]);
      if (!defaultType && types.size < 2) continue;
      const idleType = mode && types.size > 1 ? undefined : defaultType;
      // Archive Zone.as draws the 256 px texture on a 512 × 512 plane.
      const size = this.textures === ARCHIVE_2042_TEXTURES ? 512 : BONUS_MARK_SIZE;
      const mesh = this.createMark(region, region.rotation.z, size, groundMeshes, this.material(idleType ?? [...types][0]));
      mesh.visible = idleType !== undefined;
      mesh.renderOrder = DECALS_RENDER_ORDER;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.zones.set(key, { mesh, idleType });
    }
  }

  private material(type: string): THREE.MeshLambertMaterial {
    const cached = this.materials.get(type);
    if (cached) return cached;
    const url = this.textures[type];
    const material = new THREE.MeshLambertMaterial({
      map: this.loadTexture(url), color: type === 'crystal_100' && !url ? 0xffbf46 : 0xffffff, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    if (type === 'crystal' && url === ARCHIVE_GOLD_MARK) {
      addShaderPatch(material, 'blueCrystalMark', (shader) => {
        // Swap red and blue to retain the yellow artwork's highlights and alpha.
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
          '#include <map_fragment>\n\tdiffuseColor.rgb = diffuseColor.bgr;');
      });
    }
    this.materials.set(type, material);
    return material;
  }

  private loadTexture(url?: string): THREE.Texture {
    const path = url ? `${url}?v=${REGION_TEXTURE_VERSION}` : 'battle/hud/diamond/1.png';
    const cached = this.loadedTextures.get(path);
    if (cached) return cached;
    const texture = this.textureLoader.load(path, url ? undefined : (loaded) => {
      const icon = loaded.image as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const scale = 24 / Math.max(icon.width, icon.height);
      const width = icon.width * scale, height = icon.height * scale;
      canvas.getContext('2d')?.drawImage(icon, (64 - width) / 2, (64 - height) / 2, width, height);
      loaded.image = canvas;
      loaded.needsUpdate = true;
    });
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = 4;
    this.loadedTextures.set(path, texture);
    return texture;
  }

  spawn(bonus: BonusInfo): void {
    if (this.archive2042) return;
    const key = bonus.zoneKey;
    const zone = key === undefined ? undefined : this.zones.get(key);
    if (key === undefined || !zone) return;
    this.active.set(bonus.bonusId, key);
    zone.mesh.material = this.material(REGION_KIND[bonus.kind]);
    zone.mesh.visible = true;
  }

  remove(bonusId: number): void {
    const key = this.active.get(bonusId);
    if (key === undefined) return;
    this.active.delete(bonusId);
    const zone = this.zones.get(key)!;
    zone.mesh.visible = zone.idleType !== undefined;
    if (zone.idleType) zone.mesh.material = this.material(zone.idleType);
  }

  keepOnly(ids: ReadonlySet<number>): void {
    for (const id of this.active.keys()) {
      if (!ids.has(id)) this.remove(id);
    }
  }

  /** след на земле под зоной; если земли под ней не нашлось — плоский квадрат как в Narukami */
  private createMark(region: BonusRegion, angle: number, size: number, groundMeshes: THREE.Mesh[], material: THREE.Material): THREE.Mesh {
    const { position } = region;
    // координаты карты (z вверх) — в группе world, которая сама повёрнута в сцене: луч переводим в сцену и обратно
    const space = groundMeshes[0]?.parent ?? null;
    const top = Math.max(region.max.z, position.z) + BONUS_RAY_START;
    const origin = new THREE.Vector3(position.x, position.y, top);
    const direction = down.clone();
    if (space) {
      origin.applyMatrix4(space.matrixWorld);
      direction.transformDirection(space.matrixWorld);
    }
    raycaster.set(origin, direction);
    raycaster.far = top - position.z + GROUND_RAY_LENGTH;
    const hit = raycaster.intersectObjects(groundMeshes, false)[0];
    if (hit && space) space.worldToLocal(hit.point);
    if (hit?.face) {
      normalMatrix.getNormalMatrix(hit.object.matrix);
      const normal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
      if (normal.z < 0) normal.negate();
      // ось X следа при нормали вверх — (cos(a − π/2), sin(a − π/2)): сдвигаем, чтобы метка смотрела как зона
      const geometry = buildDecalGeometry(
        groundMeshes,
        new Vector3(hit.point.x, hit.point.y, hit.point.z),
        new Vector3(normal.x, normal.y, normal.z),
        size / 2,
        DECAL_DEPTH,
        angle + Math.PI / 2,
      );
      if (geometry) return new THREE.Mesh(geometry, material);
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    mesh.position.set(position.x, position.y, (hit?.point.z ?? position.z) + REGION_DECAL_ASCENSION);
    mesh.rotation.set(region.rotation.x, region.rotation.y, region.rotation.z);
    return mesh;
  }

  get count(): number {
    return this.group.children.length;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const child of this.group.children) (child as THREE.Mesh).geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const texture of this.loadedTextures.values()) texture.dispose();
  }
}

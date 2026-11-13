// Мины на поле (BattleMinesModel): плоский диск на земле с картинкой mine/<вид>_mine — своя (friendly),
// союзная (blue), вражеская (red), ещё не взведённая (empty). Взрыв — кадры multiframe/mine/main_explosion,
// звуки mine/activate, mine/explosion. Общая часть net2/S2Mines; координаты — карты (группа world, ось Z вверх).
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { Sound3D, Sound3DEffect, SoundOptions, type Sound, type SoundManager } from '../sfx/Sound.ts';
import { AnimatedSpriteEffect, createTexture, loadAnimation, type EffectsScene, type TextureAnimation } from '../sfx/SmokyEffects.ts';
import { loadImageWithAlpha } from '../render/TankSkin.ts';

/** радиус мины (модель mine_model: диск 75 см) */
const MINE_RADIUS = 37.5;
const MINE_EXPLOSION_SIZE = 500;
const MINE_EXPLOSION_OFFSET = 200;
const ACTIVE_SOUND_VOLUME = 0.7;
const EXPLOSION_SOUND_VOLUME = 1;

export type MineTextureKind = 'red' | 'blue' | 'friendly' | 'empty';

export interface MineSpawnInfo {
  id: number;
  position: { x: number; y: number; z: number };
  kind: MineTextureKind;
}

interface Mine {
  id: number;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  kind: MineTextureKind;
  position: Vector3;
}

export class MineField {
  private readonly mines = new Map<number, Mine>();
  private readonly textures = new Map<MineTextureKind, THREE.Texture>();
  private readonly textureLoads = new Map<MineTextureKind, Promise<void>>();
  private explosion: TextureAnimation | null = null;
  private activateSound: Sound | null = null;
  private explosionSound: Sound | null = null;
  private readonly group = new THREE.Group();
  private stopped = false;

  constructor(
    world: THREE.Object3D,
    private readonly effectsScene: EffectsScene,
    private readonly soundManager: SoundManager,
    base = 'battle',
  ) {
    world.add(this.group);
    for (const kind of ['red', 'blue', 'friendly', 'empty'] as MineTextureKind[]) this.loadTexture(kind, base);
    loadAnimation(`${base}/multiframe/mine/main_explosion`)
      .then((animation) => (this.explosion = animation))
      .catch(() => undefined);
    soundManager.engine
      .load(`${base}/sounds/mine/activate.mp3`)
      .then((sound) => (this.activateSound = sound))
      .catch(() => undefined);
    soundManager.engine
      .load(`${base}/sounds/mine/explosion.mp3`)
      .then((sound) => (this.explosionSound = sound))
      .catch(() => undefined);
  }

  private loadTexture(kind: MineTextureKind, base: string): void {
    if (this.textureLoads.has(kind)) return;
    this.textureLoads.set(
      kind,
      loadImageWithAlpha(`${base}/images/mine/${kind}_mine/image.jpg`, undefined)
        .then((image) => {
          const texture = createTexture(image);
          this.textures.set(kind, texture);
          for (const mine of this.mines.values()) if (mine.kind === kind) this.applyTexture(mine);
        })
        .catch(() => undefined),
    );
  }

  private applyTexture(mine: Mine): void {
    const texture = this.textures.get(mine.kind);
    if (!texture) return;
    mine.material.map = texture;
    mine.material.color.set(0xffffff);
    mine.material.needsUpdate = true;
  }

  /** PUT_MINE */
  spawn(info: MineSpawnInfo): void {
    if (this.stopped || this.mines.has(info.id)) return;
    const material = new THREE.MeshBasicMaterial({ color: 0x555555, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(MINE_RADIUS, 24), material);
    const position = new Vector3(info.position.x, info.position.y, info.position.z);
    mesh.position.set(position.x, position.y, position.z);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const mine: Mine = { id: info.id, mesh, material, kind: info.kind, position };
    this.mines.set(info.id, mine);
    this.applyTexture(mine);
  }

  /** ACTIVATE_MINE и смена вида (своя/союзная/вражеская) */
  setKind(id: number, kind: MineTextureKind): void {
    const mine = this.mines.get(id);
    if (!mine || mine.kind === kind) return;
    mine.kind = kind;
    this.applyTexture(mine);
  }

  /** мина взвелась: звук постановки на взвод */
  activated(position: { x: number; y: number; z: number }): void {
    if (!this.activateSound) return;
    const sound = new Sound3D(this.activateSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, ACTIVE_SOUND_VOLUME);
    this.soundManager.addEffect(new Sound3DEffect(new Vector3(position.x, position.y, position.z), sound, 0));
  }

  /** EXPLODE_MINE: взрыв в точке мины, затем мина исчезает */
  explode(id: number): void {
    const mine = this.mines.get(id);
    const position = mine ? mine.position.clone() : null;
    this.remove([id]);
    if (!position) return;
    if (this.explosion) {
      const point = position.clone();
      point.z += 50;
      this.effectsScene.addGraphicEffect(new AnimatedSpriteEffect(this.effectsScene.parent, this.explosion, MINE_EXPLOSION_SIZE, point, MINE_EXPLOSION_OFFSET, 1));
    }
    if (this.explosionSound) {
      const sound = new Sound3D(this.explosionSound, SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, EXPLOSION_SOUND_VOLUME);
      this.soundManager.addEffect(new Sound3DEffect(position, sound, 0));
    }
  }

  remove(ids: number[]): void {
    for (const id of ids) {
      const mine = this.mines.get(id);
      if (!mine) continue;
      mine.mesh.removeFromParent();
      mine.mesh.geometry.dispose();
      mine.material.dispose();
      this.mines.delete(id);
    }
  }

  removeAll(): void {
    this.remove([...this.mines.keys()]);
  }

  /** сверка после загрузки карты: остаются только мины сервера */
  keepOnly(ids: Set<number>): void {
    this.remove([...this.mines.keys()].filter((id) => !ids.has(id)));
  }

  update(): void {}

  stop(): void {
    this.stopped = true;
    this.removeAll();
    this.group.removeFromParent();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.explosion?.texture.dispose();
    this.explosion = null;
  }
}

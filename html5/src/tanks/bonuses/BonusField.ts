// Ящики на поле (alternativa.tanks.models.battlefield.BattleFieldBonusModel + BattleBonus): ящик на парашюте
// падает с bonus_fall_speed, на земле парашют отрывается, подбор — касанием куба ящика (BonusTrigger).
// Общая часть BonusManager (старый протокол) и net2/S2Bonuses (server2): им остаётся перевести свои события в
// spawn / take / remove. Модели и текстуры берутся из public/bonuses.
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { RayHit } from '../../physics/collision/types.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import { Sound3D, Sound3DEffect, type Sound, type SoundManager } from '../sfx/Sound.ts';
import type { Body } from '../../physics/Body.ts';
import { CollisionBox } from '../../physics/collision/CollisionShape.ts';
import { PhysicsMaterial } from '../../physics/collision/types.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import { dynamicLights } from '../../render/DynamicLights.ts';

// размеры BattleBonus (Alternativa): spawn_position — место ящика, точка подвеса на 450 выше, парашют на 50 ниже подвеса
const PARACHUTE_OFFSET = 50;
const BOX_OFFSET = 450;
const BOX_HALF = 75;
const CORD_RADIUS = 266;
const CORD_COUNT = 12;
const SWING_AMPLITUDE = 0.1;
const SWING_SPEED = 1;
const ROTATION_SPEED = 0.1;
const BONUS_ROTATION_SPEED_TIME = 1;
const SPAWN_FADE_MS = 1000;
const PICKUP_MS = 2000;
const PARACHUTE_DETACH_MS = 1000;
const REMOVE_BLINK_MS = 1000;
const REMOVE_BLINK_PERIOD_MS = 150;
const TAKE_RETRY_MS = 600;
const MAX_FALL = 100000;
/** BonusConst: поверхность ровная, если cos наклона > cos(1°); скорость доворота LandingController */
const FLAT_COS = Math.cos(Math.PI / 180);
const LANDING_SPEED = 2.5;
const OVERHAUL_BOXES = new Set(['armor_box', 'med_box', 'nos_box', 'power_box']);
const BOX_GLOW: Record<string, number> = {
  armor_box: 0xf4d797, crystal_box: 0x37d8ff, gold_box: 0xffa92f,
  med_box: 0xc7ef50, nos_box: 0xf8f049, power_box: 0xff5143,
};
const MAX_BOX_LIGHTS = 4;
const BOX_LIGHT_RANGE = 420;

function glowTexture(): THREE.DataTexture {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const radius = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
      const i = (y * size + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
      pixels[i + 3] = Math.round(255 * Math.max(0, 1 - radius) ** 1.8);
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** ящик от сервера: id (сквозной), модель (файл в public/bonuses без .json), точка подвеса и возраст */
export interface BonusSpawnInfo {
  id: number;
  kind: string;
  position: { x: number; y: number; z: number };
  /** сколько ящик уже существует, мс */
  ageMs: number;
}

export interface BonusFieldOptions {
  /** звук подбора (BattlefieldBonus sound: battle/sounds/bonus_take.mp3) */
  soundManager: SoundManager;
  /** танк коснулся ящика (ATTEMPT_TO_TAKE_BONUS) — отправляет свой протокол */
  onTake: (id: number) => void;
  archiveBoxes?: boolean;
}

interface MeshData {
  positions: number[];
  uvs: number[];
  indices: number[];
}

type Phase = 'spawn' | 'falling' | 'landed' | 'taken' | 'removing';

interface Bonus {
  id: number;
  root: THREE.Group;
  box: THREE.Mesh;
  glow: THREE.SpriteMaterial;
  parachute: THREE.Group;
  cords: THREE.LineSegments;
  materials: THREE.Material[];
  /** подвес (карта: x, y, z) */
  x: number;
  y: number;
  z: number;
  landZ: number;
  phase: Phase;
  age: number;
  phaseTime: number;
  detachTime: number;
  /** возраст на момент посадки: с него качание и вращение замирают */
  landedAt: number | null;
  /** начальный угол по Z (bonusId × 10°) */
  startAngle: number;
  /** точка земли и её нормаль: ящик на склоне доворачивается вокруг точки (LandingController) */
  ground: THREE.Vector3;
  tiltAxis: THREE.Vector3;
  tiltTotal: number;
  tiltDone: number;
  /** подъём ящика при подборе */
  lift: number;
  lastAttempt: number;
}

export class BonusField {
  private readonly bonuses = new Map<number, Bonus>();
  private readonly meshes = new Map<string, Promise<THREE.BufferGeometry>>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly group = new THREE.Group();
  private readonly glowMap = glowTexture();
  private readonly boxLights = new Map<Bonus, THREE.PointLight>();
  private readonly hit = new RayHit();
  private readonly origin = new Vector3();
  private readonly down = new Vector3(0, 0, -1);
  private readonly up = new Vector3(0, 0, 1);
  /** BonusTrigger: куб 150, пересечение с любой фигурой танка (хотя бы краем) — подбор */
  private readonly trigger = new CollisionBox(new Vector3(BOX_HALF, BOX_HALF, BOX_HALF), 0xff, new PhysicsMaterial());
  private readonly triggerMatrix = new THREE.Matrix4();
  private readonly triggerPosition = new THREE.Vector3();
  private fallSpeed = 0;
  private last = performance.now();
  private pickupSound: Sound | null = null;
  private stopped = false;

  constructor(
    private readonly world: THREE.Object3D,
    private readonly detector: TanksCollisionDetector,
    /** танк игрока, которым берут ящики (null — танка нет на поле) */
    private readonly tankBody: () => Body | null,
    private readonly options: BonusFieldOptions,
  ) {
    world.add(this.group);
    void options.soundManager.engine.load('battle/sounds/bonus_take.mp3').then((sound) => {
      if (!this.stopped) this.pickupSound = sound;
    });
  }

  /** bonus_fall_speed сервера (единиц карты в секунду) */
  setFallSpeed(value: number): void {
    this.fallSpeed = value;
  }

  /** SPAWN_BONUSES: ageMs — ящик уже падал (вход в бой, когда он ещё в воздухе) */
  spawn(info: BonusSpawnInfo): void {
    if (this.stopped || this.bonuses.has(info.id)) return;
    const boxName = info.kind;
    const { x, y, z } = info.position;
    const boxMaterial = this.material(boxName);
    const parachuteMaterial = this.material('parachute', THREE.DoubleSide);
    const innerMaterial = this.material('parachute_inner', THREE.DoubleSide);
    const cordMaterial = new THREE.LineBasicMaterial({ color: 0xcfcfcf, transparent: true, opacity: 0 });

    const cordPoints: number[] = [];
    for (let n = 0; n < CORD_COUNT; n++) {
      const angle = (n / CORD_COUNT) * Math.PI * 2;
      cordPoints.push(Math.cos(angle) * CORD_RADIUS, Math.sin(angle) * CORD_RADIUS, -PARACHUTE_OFFSET, 0, 0, -BOX_OFFSET + BOX_HALF);
    }
    const cordGeometry = new THREE.BufferGeometry();
    cordGeometry.setAttribute('position', new THREE.Float32BufferAttribute(cordPoints, 3));
    const cords = new THREE.LineSegments(cordGeometry, cordMaterial);

    const root = new THREE.Group();
    const parachute = new THREE.Group();
    parachute.position.z = -PARACHUTE_OFFSET;
    const box = new THREE.Mesh(new THREE.BufferGeometry(), boxMaterial);
    box.position.z = -BOX_OFFSET;
    const glow = new THREE.SpriteMaterial({
      map: this.glowMap, color: BOX_GLOW[boxName] ?? 0xffffff, opacity: 0,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const halo = new THREE.Sprite(glow);
    halo.scale.set(320, 320, 1);
    halo.renderOrder = 3;
    box.add(halo);
    root.add(parachute, box, cords);
    this.group.add(root);

    // BattleBonus.spawn: земля под точкой; под потолком или если падение уже закончилось (заход в бой) — ящик сразу на земле, без парашюта
    const ground = this.findGround(x, y, z);
    const landZ = ground.point.z;
    const tiltTotal = ground.normal.z > FLAT_COS ? 0 : Math.acos(Math.min(1, ground.normal.z));
    const fallTime = this.fallSpeed > 0 ? Math.max(0, (z - landZ - BOX_HALF) / this.fallSpeed) : 0;
    const elapsedMs = Math.max(0, info.ageMs);
    const direct = this.isUnderCeiling(x, y, z) || fallTime * 1000 <= elapsedMs;
    const startAngle = (Math.PI * 10 * (info.id & 0xffff)) / 180;
    const bonus: Bonus = {
      id: info.id,
      root,
      box,
      glow,
      parachute,
      cords,
      materials: [boxMaterial, parachuteMaterial, innerMaterial, cordMaterial],
      x,
      y,
      z: z + BOX_OFFSET,
      landZ,
      phase: direct ? 'landed' : 'spawn',
      age: direct ? 0 : elapsedMs / 1000 - fallTime,
      phaseTime: 0,
      detachTime: 0,
      landedAt: null,
      lastAttempt: 0,
      startAngle,
      ground: ground.point,
      tiltAxis: new THREE.Vector3(0, 0, 1).cross(ground.normal).normalize(),
      tiltTotal,
      tiltDone: 0,
      lift: 0,
    };
    if (direct) {
      bonus.z = landZ + BOX_HALF + BOX_OFFSET;
      bonus.landedAt = fallTime * BONUS_ROTATION_SPEED_TIME;
      bonus.tiltDone = tiltTotal;
      bonus.detachTime = -10; // парашюта нет: updateParachute сразу считает его отвалившимся
      bonus.parachute.visible = false;
      bonus.cords.visible = false;
      this.setOpacity(bonus, 1, 0);
    } else {
      // ящик уже падал elapsedMs: подвес ниже на скорость × время
      bonus.z -= this.fallSpeed * (elapsedMs / 1000);
    }
    this.bonuses.set(info.id, bonus);
    this.place(bonus);

    void Promise.all([this.geometry(boxName), this.geometry('parachute'), this.geometry('parachute_inner')]).then(([boxGeometry, parachuteGeometry, innerGeometry]) => {
      if (this.stopped || this.bonuses.get(info.id) != bonus) return;
      box.geometry = boxGeometry;
      parachute.add(new THREE.Mesh(parachuteGeometry, parachuteMaterial), new THREE.Mesh(innerGeometry, innerMaterial));
    });
  }

  /** BONUS_TAKEN: ящик поднимается и исчезает */
  take(id: number): void {
    const bonus = this.bonuses.get(id);
    if (!bonus || bonus.phase == 'taken') return;
    bonus.phase = 'taken';
    bonus.phaseTime = 0;
    if (this.pickupSound) {
      this.offset.copy(bonus.box.position).applyQuaternion(bonus.root.quaternion).add(bonus.root.position);
      const sound = new Sound3D(this.pickupSound, 1000, 4500, 10, 2.5);
      this.options.soundManager.addEffect(new Sound3DEffect(new Vector3(this.offset.x, this.offset.y, this.offset.z), sound));
    }
  }

  /** REMOVE_BONUSES: срок жизни истёк или конец раунда — ящик мигает и пропадает */
  remove(id: number): void {
    const bonus = this.bonuses.get(id);
    if (!bonus || bonus.phase == 'taken' || bonus.phase == 'removing') return;
    bonus.phase = 'removing';
    bonus.phaseTime = 0;
  }

  /** BATTLE_RESTART: все оставшиеся ящики исчезают, как по REMOVE_BONUSES */
  removeAll(): void {
    for (const id of [...this.bonuses.keys()]) this.remove(id);
  }

  /** оставить только ящики из списка (сверка после входа в бой); остальные убираются сразу */
  keepOnly(ids: Set<number>): void {
    for (const bonus of [...this.bonuses.values()]) {
      if (ids.has(bonus.id)) continue;
      this.dispose(bonus);
      this.bonuses.delete(bonus.id);
    }
  }

  /** Отладка: состояние ящиков и расстояния до танка (window.__tanks.netBattle.bonuses.debug()) */
  debug(): unknown[] {
    const tank = this.tankBody()?.state.position ?? null;
    return [...this.bonuses.values()].map((bonus) => ({
      id: bonus.id,
      phase: bonus.phase,
      x: Math.round(bonus.x),
      y: Math.round(bonus.y),
      boxZ: Math.round(bonus.z - BOX_OFFSET),
      landZ: Math.round(bonus.landZ),
      dist: tank ? Math.round(Math.hypot(tank.x - bonus.x, tank.y - bonus.y)) : null,
      dz: tank ? Math.round(tank.z - (bonus.z - BOX_OFFSET)) : null,
    }));
  }

  stop(): void {
    this.stopped = true;
    for (const bonus of this.bonuses.values()) this.dispose(bonus);
    this.bonuses.clear();
    this.glowMap.dispose();
    this.world.remove(this.group);
  }

  // ------------------------------------------------------------ загрузка

  private assetPath(name: string, mesh: boolean): string {
    if (this.options.archiveBoxes && name.endsWith('_box')) {
      return `bonuses/2042-2019/${name}.${mesh ? 'json' : 'jpg'}`;
    }
    if (OVERHAUL_BOXES.has(name)) return `bonuses/overhaul/${name}.${mesh ? 'json' : 'webp'}`;
    return `bonuses/${name}.${mesh ? 'json' : 'jpg'}`;
  }

  private geometry(name: string): Promise<THREE.BufferGeometry> {
    let result = this.meshes.get(name);
    if (!result) {
      result = fetch(this.assetPath(name, true))
        .then((response) => response.json() as Promise<MeshData>)
        .then((data) => {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
          geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
          geometry.setIndex(data.indices);
          return geometry;
        });
      this.meshes.set(name, result);
    }
    return result;
  }

  private texture(name: string): THREE.Texture {
    let texture = this.textures.get(name);
    if (!texture) {
      texture = new THREE.TextureLoader().load(this.assetPath(name, false));
      texture.colorSpace = THREE.NoColorSpace;
      this.textures.set(name, texture);
    }
    return texture;
  }

  private material(name: string, side: THREE.Side = THREE.FrontSide): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ map: this.texture(name), transparent: true, opacity: 0, side });
  }

  // ------------------------------------------------------------ земля

  /** BattleBonus.isUnderCeil: луч вверх от точки спавна упирается в статику */
  private isUnderCeiling(x: number, y: number, z: number): boolean {
    this.origin.reset(x, y, z);
    return this.detector.hasStaticHit(this.origin, this.up, CollisionGroup.STATIC, MAX_FALL);
  }

  /** Земля под точкой (по статике карты) и её нормаль; без попадания — на 1000 ниже, нормаль вверх (как в BattleBonus) */
  private findGround(x: number, y: number, z: number): { point: THREE.Vector3; normal: THREE.Vector3 } {
    this.origin.reset(x, y, z);
    this.hit.clear();
    if (this.detector.raycastStatic(this.origin, this.down, CollisionGroup.STATIC, MAX_FALL, null, this.hit)) {
      return { point: new THREE.Vector3(this.hit.position.x, this.hit.position.y, this.hit.position.z), normal: new THREE.Vector3(this.hit.normal.x, this.hit.normal.y, this.hit.normal.z) };
    }
    return { point: new THREE.Vector3(x, y, z - 1000), normal: new THREE.Vector3(0, 0, 1) };
  }

  // ------------------------------------------------------------ фазы

  private setOpacity(bonus: Bonus, boxOpacity: number, parachuteOpacity: number): void {
    const [box, parachute, inner, cord] = bonus.materials;
    box.opacity = boxOpacity;
    bonus.glow.opacity = boxOpacity * 0.9;
    // полупрозрачный (появляется или растворяется) ящик не пишет глубину, иначе следы и метки зон под ним пропадают
    box.depthWrite = boxOpacity >= 1;
    parachute.opacity = parachuteOpacity;
    inner.opacity = parachuteOpacity;
    cord.opacity = parachuteOpacity;
  }

  private readonly euler = new THREE.Euler();
  private readonly qz = new THREE.Quaternion();
  private readonly qt = new THREE.Quaternion();
  private readonly offset = new THREE.Vector3();

  private place(bonus: Bonus): void {
    if (bonus.landedAt != null) {
      // на земле подвес = центр ящика: поворот вокруг оси склона на tiltDone, центр — над точкой земли
      this.qz.setFromEuler(this.euler.set(0, 0, bonus.startAngle + bonus.landedAt * ROTATION_SPEED));
      this.qt.setFromAxisAngle(bonus.tiltAxis, bonus.tiltDone);
      bonus.root.quaternion.copy(this.qt).multiply(this.qz);
      this.offset.set(0, 0, BOX_HALF).applyQuaternion(this.qt);
      bonus.root.position.copy(bonus.ground).add(this.offset);
      bonus.box.position.set(0, 0, bonus.lift);
      bonus.cords.position.z = BOX_OFFSET;
      return;
    }
    const swing = Math.sin(bonus.age * SWING_SPEED) * SWING_AMPLITUDE;
    bonus.root.position.set(bonus.x, bonus.y, bonus.z);
    bonus.root.rotation.set(swing, 0, bonus.startAngle + bonus.age * ROTATION_SPEED);
    bonus.box.position.set(0, 0, -BOX_OFFSET + bonus.lift);
  }

  private dispose(bonus: Bonus): void {
    const light = this.boxLights.get(bonus);
    if (light) {
      dynamicLights.release(light);
      this.boxLights.delete(bonus);
    }
    this.group.remove(bonus.root);
    for (const material of bonus.materials) material.dispose();
    bonus.cords.geometry.dispose();
    bonus.glow.dispose();
  }

  /** Каждый кадр: падение, анимации, касание танка */
  update(): void {
    const now = performance.now();
    const delta = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    for (const bonus of [...this.bonuses.values()]) {
      bonus.age += delta;
      bonus.phaseTime += delta * 1000;
      const landZ = bonus.landZ + BOX_OFFSET + BOX_HALF;
      switch (bonus.phase) {
        case 'spawn': {
          const fade = Math.min(bonus.phaseTime / SPAWN_FADE_MS, 1);
          this.fall(bonus, delta, landZ);
          this.setOpacity(bonus, fade, fade);
          if (fade >= 1 && bonus.phase == 'spawn') bonus.phase = bonus.z <= landZ ? 'landed' : 'falling';
          break;
        }
        case 'falling':
          this.fall(bonus, delta, landZ);
          break;
        case 'landed':
          break;
        case 'taken': {
          const t = Math.min(bonus.phaseTime / PICKUP_MS, 1);
          bonus.lift = t * 150;
          bonus.box.scale.setScalar(1 + t * 0.4);
          this.setOpacity(bonus, 1 - t, 0);
          if (t >= 1) this.finish(bonus);
          break;
        }
        case 'removing': {
          const t = bonus.phaseTime / REMOVE_BLINK_MS;
          const visible = Math.floor(bonus.phaseTime / REMOVE_BLINK_PERIOD_MS) % 2 == 0;
          this.setOpacity(bonus, visible ? 1 - t : 0, 0);
          if (t >= 1) this.finish(bonus);
          break;
        }
      }
      if (bonus.landedAt != null && bonus.tiltDone < bonus.tiltTotal) bonus.tiltDone = Math.min(bonus.tiltTotal, bonus.tiltDone + LANDING_SPEED * delta);
      this.updateParachute(bonus);
      this.place(bonus);
      if (this.tankBody() && (bonus.phase == 'spawn' || bonus.phase == 'falling' || bonus.phase == 'landed')) this.tryTake(bonus, now);
    }
    this.updateBoxLights();
  }

  private updateBoxLights(): void {
    const position = this.tankBody()?.state.position;
    const nearest = dynamicLights.isEnabled() ? [...this.bonuses.values()]
      .filter(bonus => bonus.glow.opacity > 0)
      .sort((a, b) => {
        if (!position) return 0;
        const distance = (bonus: Bonus) => (bonus.x - position.x) ** 2 + (bonus.y - position.y) ** 2;
        return distance(a) - distance(b);
      })
      .slice(0, MAX_BOX_LIGHTS) : [];
    for (const [bonus, light] of this.boxLights) {
      if (nearest.includes(bonus)) continue;
      dynamicLights.release(light);
      this.boxLights.delete(bonus);
    }
    for (const bonus of nearest) {
      let light = this.boxLights.get(bonus);
      if (!light) {
        const slot = dynamicLights.acquire();
        if (!slot) break;
        light = slot;
        this.boxLights.set(bonus, light);
        light.color.copy(bonus.glow.color);
        light.distance = BOX_LIGHT_RANGE;
        light.decay = -75;
      }
      light.position.copy(bonus.box.position).applyQuaternion(bonus.root.quaternion).add(bonus.root.position);
      light.position.z += 30;
      light.intensity = 7.5 * bonus.glow.opacity;
    }
  }

  private fall(bonus: Bonus, delta: number, landZ: number): void {
    if (bonus.z > landZ) bonus.z = Math.max(landZ, bonus.z - this.fallSpeed * delta);
    if (bonus.z <= landZ && bonus.landedAt == null) {
      bonus.landedAt = bonus.age;
      bonus.detachTime = bonus.age;
      if (bonus.phase == 'falling') bonus.phase = 'landed';
    }
  }

  /** После посадки парашют падает, расширяясь и исчезая за 1 с, потом убирается вместе со стропами */
  private updateParachute(bonus: Bonus): void {
    if (bonus.phase != 'landed' && !(bonus.phase == 'spawn' && bonus.z <= bonus.landZ + BOX_OFFSET + BOX_HALF)) return;
    const [, parachute, inner, cord] = bonus.materials;
    const t = Math.min((bonus.age - bonus.detachTime) * 1000 / PARACHUTE_DETACH_MS, 1);
    parachute.opacity = inner.opacity = cord.opacity = 1 - t;
    bonus.parachute.scale.setScalar(1 + t * 0.4);
    bonus.parachute.position.z = BOX_OFFSET - PARACHUTE_OFFSET - t * 120;
    bonus.cords.visible = t < 1;
    bonus.parachute.visible = t < 1;
  }

  /** BonusTrigger.update: положение и поворот куба по ящику (в воздухе — по подвесу ниже на 450) */
  private updateTrigger(bonus: Bonus): void {
    bonus.root.updateMatrix();
    this.triggerMatrix.copy(bonus.root.matrix);
    const e = this.triggerMatrix.elements;
    if (bonus.landedAt == null) {
      // ящик в воздухе висит на 450 ниже подвеса вдоль его оси
      this.triggerPosition.set(0, 0, -BOX_OFFSET).applyMatrix4(bonus.root.matrix);
      e[12] = this.triggerPosition.x;
      e[13] = this.triggerPosition.y;
      e[14] = this.triggerPosition.z;
    }
    const t = this.trigger.transform;
    t.a = e[0]; t.b = e[4]; t.c = e[8]; t.d = e[12];
    t.e = e[1]; t.f = e[5]; t.g = e[9]; t.h = e[13];
    t.i = e[2]; t.j = e[6]; t.k = e[10]; t.l = e[14];
    this.trigger.calculateAABB();
  }

  /** BonusTrigger.checkTrigger: любая фигура тела танка пересекает куб ящика → один запрос подбора (повтор раз в 0.6 с) */
  private tryTake(bonus: Bonus, now: number): void {
    const body = this.tankBody();
    // ящик в фазе появления ещё не берётся (как BonusTrigger до конца спавна)
    if (!body || bonus.phase == 'spawn' || now - bonus.lastAttempt < TAKE_RETRY_MS) return;
    this.updateTrigger(bonus);
    const shapes = body.collisionShapes;
    if (!shapes) return;
    let touched = false;
    for (let n = 0; n < body.numCollisionShapes && !touched; n++) touched = this.detector.testCollision(shapes[n], this.trigger);
    if (!touched) return;
    bonus.lastAttempt = now;
    this.options.onTake(bonus.id);
  }

  private finish(bonus: Bonus): void {
    this.dispose(bonus);
    this.bonuses.delete(bonus.id);
  }
}

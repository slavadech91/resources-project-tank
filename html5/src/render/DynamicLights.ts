import * as THREE from 'three';
import type { Vector3 } from '../physics/math/Vector3.ts';
import type { GraphicEffect } from '../tanks/sfx/SmokyEffects.ts';

/**
 * «Динамическое освещение» клиента 2019 (Camera3D.deferredLighting, DepthRenderer: OmniLight/TubeLight от эффектов).
 * Свет — AnimatedLightEffect/TubeLightEffect с LightAnimation по ключевым кадрам LightEffectItem; параметры кадров
 * сервер присылает в LightingSFXEntity пушек. Наш сервер 2014 их не шлёт — значения взяты с сервера Narukami
 * (RailgunTemplate, SmokyTemplate, HullTemplate). Параметры Грома подобраны по его эффектам.
 *
 * Вклад в цвет: текстура × 2 × свет (fc: add ft6, ft6 в TextureMaterialFragmentShader) — как у солнца,
 * поэтому интенсивность PointLight = 2π × intensity (Lambert в Three.js делит на π, см. map/lighting.ts).
 * Источники — постоянный пул PointLight в группе мира (оси карты): число источников не меняется, шейдеры не
 * перекомпилируются; свободные — с нулевой яркостью. Выключение настройки убирает пул из сцены.
 */

export interface LightFrame {
  attenuationBegin: number;
  attenuationEnd: number;
  color: number;
  intensity: number;
  /** мс от начала */
  time: number;
}

const frame = (attenuationBegin: number, attenuationEnd: number, color: number, intensity: number, time: number): LightFrame => ({
  attenuationBegin,
  attenuationEnd,
  color,
  intensity,
  time,
});

/** LightingSFXEntity с сервера Narukami (имена эффектов как у клиента 2019) */
export const LIGHTING = {
  railgun: {
    charge: [frame(200, 200, 0xff00ff, 1.7, 0), frame(200, 800, 0xff00ff, 1.3, 600)],
    hit: [frame(1, 2, 0xff00ff, 2, 0), frame(200, 600, 0xff00ff, 2, 100), frame(1, 2, 0xff00ff, 0, 500)],
    rail: [frame(200, 1000, 0xff00ff, 1.5, 0), frame(1, 2, 0xff00ff, 0, 500)],
    shot: [frame(100, 600, 0xff00ff, 1.7, 0), frame(1, 2, 0xff00ff, 0, 300)],
  },
  smoky: {
    hit: [frame(170, 300, 0xffbf00, 1.7, 0), frame(100, 300, 0xffbf00, 0, 400)],
    shot: [frame(190, 450, 0xfcdd76, 1.9, 0), frame(1, 2, 0xfcdd76, 0, 300)],
  },
  thunder: {
    shot: [frame(170, 560, 0xffdc78, 1.9, 0), frame(80, 260, 0xffb64a, 0.5, 90), frame(1, 2, 0xffb64a, 0, 240)],
    hit: [frame(200, 850, 0xffc16a, 2.1, 0), frame(180, 650, 0xff942c, 1.0, 130), frame(1, 2, 0xff942c, 0, 480)],
  },
  tank: {
    explosion: [frame(1, 2, 0xcca538, 0, 0), frame(500, 1500, 0xcca538, 1.2, 100), frame(1, 2, 0xcca538, 0, 1200)],
  },
} as const;

const LIGHT_SCALE = 2 * Math.PI;
const POOL_SIZE = 12;
/** TubeLight рельсы — цепочкой точечных источников вдоль луча не реже, чем через столько единиц */
const TUBE_STEP = 1200;
const TUBE_MAX_LIGHTS = 4;

interface LightState {
  attenuationBegin: number;
  attenuationEnd: number;
  color: THREE.Color;
  intensity: number;
}

const colorA = new THREE.Color();
const colorB = new THREE.Color();

/** LightAnimation.updateByTime: кадр по времени (растянутому на timeToLive), линейная интерполяция всех полей */
function sample(frames: readonly LightFrame[], time: number, timeToLive: number, out: LightState): void {
  const last = frames[frames.length - 1];
  const scaled = timeToLive > 0 ? time * (last.time / timeToLive) : time;
  let index = frames.length - 1;
  let t = 0;
  if (scaled < last.time) {
    for (let i = 0; i < frames.length - 1; i++) {
      if (scaled >= frames[i].time && scaled < frames[i + 1].time) {
        index = i;
        t = (scaled - frames[i].time) / (frames[i + 1].time - frames[i].time);
        break;
      }
    }
  }
  const a = frames[index];
  const b = frames[Math.min(index + 1, frames.length - 1)];
  out.intensity = a.intensity + (b.intensity - a.intensity) * t;
  out.attenuationBegin = a.attenuationBegin + (b.attenuationBegin - a.attenuationBegin) * t;
  out.attenuationEnd = a.attenuationEnd + (b.attenuationEnd - a.attenuationEnd) * t;
  colorA.setHex(a.color);
  colorB.setHex(b.color);
  out.color.copy(colorA).lerp(colorB, t);
}

class DynamicLightPool {
  readonly group = new THREE.Group();
  private readonly free: THREE.PointLight[] = [];
  private enabled = false;
  private parent: THREE.Object3D | null = null;

  constructor() {
    this.group.name = 'dynamic-lights';
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, -1);
      light.castShadow = false;
      this.group.add(light);
      this.free.push(light);
    }
  }

  /** группа мира (оси карты) — туда вешается пул при включённой настройке */
  attach(parent: THREE.Object3D): void {
    this.parent = parent;
    if (this.enabled) parent.add(this.group);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && this.parent) this.parent.add(this.group);
    else this.group.removeFromParent();
  }

  isEnabled(): boolean {
    return this.enabled && this.group.parent != null;
  }

  acquire(): THREE.PointLight | null {
    return this.free.pop() ?? null;
  }

  release(light: THREE.PointLight): void {
    light.intensity = 0;
    this.free.push(light);
  }
}

export const dynamicLights = new DynamicLightPool();

const state: LightState = { attenuationBegin: 0, attenuationEnd: 0, color: new THREE.Color(), intensity: 0 };

function applyState(light: THREE.PointLight, intensityScale = 1): void {
  light.color.copy(state.color);
  light.intensity = state.intensity * LIGHT_SCALE * intensityScale;
  light.distance = Math.max(state.attenuationEnd, 0.001);
  // отрицательный decay включает затухание клиента 2019 (shaderHooks); begin = 0 тоже должен дать отрицательное число
  light.decay = -Math.max(Math.min(state.attenuationBegin, state.attenuationEnd), 0.0001);
}

/** AnimatedLightEffect: источник в точке (позиция каждый кадр из position()), время жизни — последний кадр или timeToLive */
export class AnimatedLightEffect implements GraphicEffect {
  private time = 0;
  private light: THREE.PointLight | null;
  private readonly timeToLive: number;

  constructor(
    private readonly frames: readonly LightFrame[],
    private readonly position: (cameraPosition?: Vector3) => Vector3,
    timeToLive?: number,
  ) {
    this.timeToLive = timeToLive ?? frames[frames.length - 1].time;
    this.light = dynamicLights.isEnabled() ? dynamicLights.acquire() : null;
  }

  play(delta: number, cameraPosition?: Vector3): boolean {
    if (!this.light) return false;
    sample(this.frames, this.time, this.timeToLive, state);
    applyState(this.light);
    const p = this.position(cameraPosition);
    this.light.position.set(p.x, p.y, p.z);
    this.time += delta;
    return this.time <= this.timeToLive;
  }

  kill(): void {
    this.time = this.timeToLive + 1;
  }

  destroy(): void {
    if (this.light) dynamicLights.release(this.light);
    this.light = null;
  }
}

/**
 * TubeLightEffect (луч рельсы): в оригинале — один источник-отрезок; здесь цепочка точечных источников вдоль луча
 * (не больше TUBE_MAX_LIGHTS), яркость делится между ними, чтобы середина луча не пересвечивалась.
 */
export class TubeLightEffect implements GraphicEffect {
  private time = 0;
  private readonly lights: THREE.PointLight[] = [];
  private readonly timeToLive: number;

  constructor(
    private readonly frames: readonly LightFrame[],
    from: Vector3,
    to: Vector3,
  ) {
    this.timeToLive = frames[frames.length - 1].time;
    if (!dynamicLights.isEnabled()) return;
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const count = Math.min(TUBE_MAX_LIGHTS, Math.max(1, Math.ceil(length / TUBE_STEP)));
    for (let i = 0; i < count; i++) {
      const light = dynamicLights.acquire();
      if (!light) break;
      const t = (i + 0.5) / count;
      light.position.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
      this.lights.push(light);
    }
  }

  play(delta: number): boolean {
    if (this.lights.length == 0) return false;
    sample(this.frames, this.time, this.timeToLive, state);
    const scale = 1 / Math.sqrt(this.lights.length);
    for (const light of this.lights) applyState(light, scale);
    this.time += delta;
    return this.time <= this.timeToLive;
  }

  destroy(): void {
    for (const light of this.lights) dynamicLights.release(light);
    this.lights.length = 0;
  }
}

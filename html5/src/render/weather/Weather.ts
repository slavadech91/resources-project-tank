import * as THREE from 'three';
import { rainSurfaceUniforms } from './WetSurfaces.ts';

/**
 * Режим «Непогода», фаза 1: дождь, ветвистые молнии, мокрость.
 *
 * Дождь — один InstancedMesh из вытянутых билбордов в боксе вокруг камеры, движение капель
 * считается в вершинном шейдере от времени. Молния — ломаная с ответвлениями (LineSegments,
 * аддитивная) + импульс света и вспышка неба. Мокрость — множитель отражений PBR-материалов.
 */

export interface WeatherSettings {
  enabled: boolean;
  rain: number;
  wind: number;
  lightning: number;
  wetness: number;
}

export const DEFAULT_WEATHER: WeatherSettings = { enabled: false, rain: 0.6, wind: 0.3, lightning: 0.4, wetness: 0.7 };

const DROP_COUNT = 5000;
const AREA = 3200;
const HEIGHT = 2200;
const DROP_SPEED = 4200;
const BOLT_LIFE = 0.16;

const rainVertex = `attribute vec3 offset;
uniform float time;
uniform float wind;
uniform float rain;
varying float vAlpha;
varying vec2 vDropUv;
void main() {
  float seed = fract(offset.x * 0.037 + offset.z * 0.071);
  float fall = mod(offset.y - time * ${DROP_SPEED.toFixed(1)} * mix(0.75, 1.2, seed), ${HEIGHT.toFixed(1)});
  vec3 center = vec3(offset.x + wind * (${HEIGHT.toFixed(1)} - fall) * 0.35, fall - 850.0, offset.z);
  vec4 mv = modelViewMatrix * vec4(center, 1.0);
  float streak = mix(17.0, 43.0, seed);
  mv.xy += vec2(position.x * mix(0.65, 1.3, seed) - position.y * wind * streak * 0.35, position.y * streak);
  gl_Position = projectionMatrix * mv;
  float fade = smoothstep(90.0, 500.0, -mv.z) * (1.0 - smoothstep(1500.0, 2700.0, -mv.z));
  vAlpha = fade * mix(0.5, 1.0, rain) * mix(0.65, 1.0, seed);
  vDropUv = uv;
}`;

const rainFragment = `uniform vec3 rainColor;
varying float vAlpha;
varying vec2 vDropUv;
void main() {
  float width = 1.0 - smoothstep(0.05, 0.5, abs(vDropUv.x - 0.5));
  float lengthFade = smoothstep(0.0, 0.15, vDropUv.y) * (1.0 - smoothstep(0.12, 1.0, vDropUv.y));
  gl_FragColor = vec4(rainColor, vAlpha * width * lengthFade * 0.48);
}`;

interface Bolt {
  line: THREE.LineSegments;
  material: THREE.LineBasicMaterial;
  age: number;
}

export class Weather {
  readonly rainMesh: THREE.InstancedMesh;
  onFlash: ((intensity: number) => void) | null = null;

  private readonly rainMaterial: THREE.ShaderMaterial;
  private readonly flashLight: THREE.PointLight;
  private readonly flashAmbient: THREE.AmbientLight;
  private readonly bolts: Bolt[] = [];
  private readonly cameraPosition = new THREE.Vector3();
  private settings: WeatherSettings = { ...DEFAULT_WEATHER };
  private nextLightning = 4;
  private flashLeft = 0;

  constructor(private readonly scene: THREE.Scene) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const offsets = new Float32Array(DROP_COUNT * 3);
    for (let i = 0; i < DROP_COUNT; i += 1) {
      offsets[i * 3] = (Math.random() - 0.5) * AREA;
      offsets[i * 3 + 1] = Math.random() * HEIGHT;
      offsets[i * 3 + 2] = (Math.random() - 0.5) * AREA;
    }
    geometry.setAttribute('offset', new THREE.InstancedBufferAttribute(offsets, 3));
    this.rainMaterial = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        wind: { value: 0.3 },
        rain: { value: 0.6 },
        rainColor: { value: new THREE.Color(0xbdd7ea) },
      },
      vertexShader: rainVertex,
      fragmentShader: rainFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.rainMesh = new THREE.InstancedMesh(geometry, this.rainMaterial, DROP_COUNT);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.visible = false;
    this.rainMesh.layers.set(2);
    scene.add(this.rainMesh);

    this.flashLight = new THREE.PointLight(0xbfd4ff, 0, 12000);
    this.flashLight.position.set(0, 0, 6000);
    scene.add(this.flashLight);
    this.flashAmbient = new THREE.AmbientLight(0x9fb8d8, 0);
    scene.add(this.flashAmbient);
  }

  setSettings(settings: WeatherSettings): void {
    this.settings = { ...settings };
    this.rainMesh.visible = settings.enabled && settings.rain > 0.01;
    this.rainMesh.count = Math.round(DROP_COUNT * settings.rain);
    rainSurfaceUniforms.groundWetness.value = settings.enabled ? settings.wetness : 0;
    rainSurfaceUniforms.groundRain.value = settings.enabled ? settings.rain : 0;
    this.rainMaterial.uniforms.rain.value = settings.rain;
    this.rainMaterial.uniforms.wind.value = settings.wind;
    if (!settings.enabled) {
      this.flashLeft = 0;
      this.flashLight.intensity = 0;
      this.flashAmbient.intensity = 0;
      this.clearBolts();
      this.onFlash?.(0);
    }
  }

  /** кадр: дождь, вспышки, молнии */
  update(deltaSeconds: number, camera: THREE.Camera): void {
    if (!this.settings.enabled) return;
    this.rainMaterial.uniforms.time.value += deltaSeconds;
    rainSurfaceUniforms.groundRainTime.value = this.rainMaterial.uniforms.time.value;
    camera.getWorldPosition(this.cameraPosition);
    this.rainMesh.position.copy(this.cameraPosition);

    if (this.settings.lightning > 0.02) {
      this.nextLightning -= deltaSeconds;
      if (this.nextLightning <= 0) {
        this.nextLightning = 3 + Math.random() * (14 - this.settings.lightning * 11);
        this.flashLeft = 0.22;
        this.onFlash?.(1);
        this.spawnBolt();
      }
    }
    if (this.flashLeft > 0) {
      this.flashLeft = Math.max(0, this.flashLeft - deltaSeconds);
      const phase = this.flashLeft > 0.12 ? 1 : 0.45;
      const power = this.settings.lightning * phase;
      this.flashLight.intensity = 2 * Math.PI * 40 * power;
      this.flashAmbient.intensity = 2 * Math.PI * 0.6 * power;
    } else {
      this.flashLight.intensity = 0;
      this.flashAmbient.intensity = 0;
    }

    for (let i = this.bolts.length - 1; i >= 0; i -= 1) {
      const bolt = this.bolts[i];
      bolt.age += deltaSeconds;
      bolt.material.opacity = Math.max(0, 1 - bolt.age / BOLT_LIFE);
      if (bolt.age >= BOLT_LIFE) {
        this.scene.remove(bolt.line);
        bolt.line.geometry.dispose();
        bolt.material.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  /** мокрость: множитель отражений окружения у PBR-материалов (1 — как есть) */
  wetness(): number {
    return this.settings.enabled ? 1 + this.settings.wetness * 2.2 : 1;
  }

  /** ветвистая молния: ломаная от неба до земли с ответвлениями */
  private spawnBolt(): void {
    const camera = this.cameraPosition;
    const start = new THREE.Vector3(
      camera.x + (Math.random() - 0.5) * 1600,
      camera.y + 2200,
      camera.z + (Math.random() - 0.5) * 1600,
    );
    const end = new THREE.Vector3(start.x + (Math.random() - 0.5) * 900, camera.y - 40, start.z + (Math.random() - 0.5) * 900);
    const points: number[] = [];
    const segment = (from: THREE.Vector3, to: THREE.Vector3): void => {
      points.push(from.x, from.y, from.z, to.x, to.y, to.z);
    };
    let previous = start.clone();
    for (let i = 1; i <= 14; i += 1) {
      const point = new THREE.Vector3().lerpVectors(start, end, i / 14);
      point.x += (Math.random() - 0.5) * 160;
      point.z += (Math.random() - 0.5) * 160;
      segment(previous, point);
      if (i > 3 && i < 11 && Math.random() < 0.45) {
        const branch = point
          .clone()
          .add(new THREE.Vector3((Math.random() - 0.5) * 600, -120 - Math.random() * 320, (Math.random() - 0.5) * 600));
        segment(point, branch);
      }
      previous = point;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(0xdce8ff).multiplyScalar(2.4),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const line = new THREE.LineSegments(geometry, material);
    line.layers.set(2);
    line.frustumCulled = false;
    this.scene.add(line);
    this.bolts.push({ line, material, age: 0 });
  }

  private clearBolts(): void {
    for (const bolt of this.bolts) {
      this.scene.remove(bolt.line);
      bolt.line.geometry.dispose();
      bolt.material.dispose();
    }
    this.bolts.length = 0;
  }
}

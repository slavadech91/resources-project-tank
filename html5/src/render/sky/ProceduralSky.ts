import * as THREE from 'three';
import { LAYER_SPRITE } from '../passes/layers.ts';

const vertexShader = `varying vec3 vDirection;
void main() {
	vDirection = position;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * Небо: градиент по высоте, диск солнца с гало и процедурные облака (fbm от направления луча).
 * Рисуется куполом вокруг камеры, без освещения и тумана — это фон кадра.
 */
const fragmentShader = `uniform vec3 sunDirection;
uniform vec3 zenithColor;
uniform vec3 horizonColor;
uniform vec3 groundColor;
uniform vec3 sunColor;
uniform float time;
uniform float cloudCover;
uniform float cloudOffset;
varying vec3 vDirection;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
	float value = 0.0;
	float amplitude = 0.5;
	for (int i = 0; i < 5; i++) {
		value += amplitude * noise(p);
		p *= 2.03;
		amplitude *= 0.5;
	}
	return value;
}

void main() {
	vec3 dir = normalize(vDirection);
	float elevation = dir.y;

	// градиент: зенит → горизонт → земля (для камеры, смотрящей вниз)
	vec3 color = mix(zenithColor, horizonColor, pow(1.0 - clamp(elevation, 0.0, 1.0), 1.7));
	color = mix(color, groundColor, smoothstep(0.0, -0.2, elevation));

	float sunDot = max(dot(dir, normalize(sunDirection)), 0.0);
	// гало вокруг солнца и сам диск (значения >1 — bloom их подхватывает)
	color += sunColor * pow(sunDot, 320.0) * 1.1;
	color += sunColor * pow(sunDot, 12.0) * 0.12;
	color = mix(color, sunColor * 3.0, smoothstep(0.9994, 0.99985, sunDot));

	// облачный слой: проекция на плоскость при малой высоте растягивается,
	// поэтому облака уходят к горизонту, а не висят над головой
	if (elevation > 0.005) {
		vec2 uv = dir.xz / (elevation + cloudOffset) * 0.35 + vec2(time * 0.0035, time * 0.0018);
		float clouds = fbm(uv * 1.7);
		clouds = smoothstep(cloudCover, cloudCover + 0.32, clouds);
		float lit = 0.7 + 0.3 * sunDot;
		vec3 cloudColor = mix(vec3(0.5, 0.55, 0.62), sunColor * 1.12, lit);
		float fade = smoothstep(0.005, 0.1, elevation);
		color = mix(color, cloudColor * 1.05, clouds * fade * 0.9);
	}

	gl_FragColor = vec4(color, 1.0);
}`;

export interface SkyPalette {
  zenith: number;
  horizon: number;
  ground: number;
  sun: number;
}

export const DEFAULT_SKY: SkyPalette = { zenith: 0x2f6ea8, horizon: 0xbcd7ea, ground: 0x6b6f66, sun: 0xfff0cf };

/** купол неба вокруг камеры: градиент, солнце, облака (замена JPG-скайбоксу) */
export class ProceduralSky {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly sunDirection = new THREE.Vector3(0, 1, 0);

  constructor(radius = 60000) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        sunDirection: { value: this.sunDirection },
        zenithColor: { value: new THREE.Color(DEFAULT_SKY.zenith) },
        horizonColor: { value: new THREE.Color(DEFAULT_SKY.horizon) },
        groundColor: { value: new THREE.Color(DEFAULT_SKY.ground) },
        sunColor: { value: new THREE.Color(DEFAULT_SKY.sun) },
        time: { value: 0 },
        cloudCover: { value: 0.52 },
        cloudOffset: { value: 0.06 },
      },
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    // слой непрозрачных спрайтов: не попадает в проход глубины (SSAO/мягкие частицы),
    // но рисуется в непрозрачном проходе кадра
    this.mesh.layers.set(LAYER_SPRITE);
  }

  /** направление НА солнце в мировых координатах (не направление лучей) */
  setSunDirection(direction: THREE.Vector3, color = DEFAULT_SKY.sun): void {
    this.sunDirection.copy(direction).normalize();
    (this.material.uniforms.sunColor.value as THREE.Color).setHex(color);
  }

  setPalette(palette: Partial<SkyPalette>): void {
    const apply = (key: 'zenithColor' | 'horizonColor' | 'groundColor' | 'sunColor', value?: number): void => {
      if (value != null) (this.material.uniforms[key].value as THREE.Color).setHex(value);
    };
    apply('zenithColor', palette.zenith);
    apply('horizonColor', palette.horizon);
    apply('groundColor', palette.ground);
    apply('sunColor', palette.sun);
  }

  /** прижатие облаков к горизонту: меньше — ниже к горизонту (0.02…0.25) */
  setCloudOffset(value: number): void {
    this.material.uniforms.cloudOffset.value = THREE.MathUtils.clamp(value, 0.02, 0.25);
  }

  setCloudCover(value: number): void {
    this.material.uniforms.cloudCover.value = THREE.MathUtils.clamp(value, 0.2, 0.8);
  }

  /** облака плывут: время в секундах */
  update(time: number): void {
    this.material.uniforms.time.value = time;
  }

  /** купол всегда вокруг камеры (координаты Three.js) */
  follow(x: number, y: number, z: number): void {
    this.mesh.position.set(x, y, z);
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }
}

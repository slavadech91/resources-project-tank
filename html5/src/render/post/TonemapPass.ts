import * as THREE from 'three';
import type { RenderContext, RenderPass } from '../frame/FrameGraph.ts';

const fullscreenVertex = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Финальный проход: HDR-кадр + bloom → экспозиция → ACES tone mapping → простой грейд
 * (насыщенность, контраст, виньетка) → экран.
 *
 * ACES-кривая сжимает пересветы «как в кино»; mix(c, aces(c), toneMix) оставляет возможность
 * ослабить эффект, не меняя материал сцены. Всё считается в одном проходе — дёшево.
 */
const tonemapFragment = `uniform sampler2D hdr;
uniform sampler2D bloom;
uniform float exposure;
uniform float bloomStrength;
uniform float toneMix;
uniform float saturation;
uniform float contrast;
uniform float vignette;
varying vec2 vUv;

vec3 aces(vec3 x) {
	const float a = 2.51;
	const float b = 0.03;
	const float c = 2.43;
	const float d = 0.59;
	const float e = 0.14;
	return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
	vec3 color = texture2D(hdr, vUv).rgb + texture2D(bloom, vUv).rgb * bloomStrength;
	color *= exposure;
	vec3 mapped = aces(color);
	color = mix(color, mapped, toneMix);
	// насыщенность вокруг яркости
	float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
	color = mix(vec3(luma), color, saturation);
	// контраст вокруг середины
	color = (color - 0.5) * contrast + 0.5;
	// виньетка
	float d = length(vUv - 0.5) * 2.0;
	float v = smoothstep(1.25, 0.35, d);
	color *= mix(1.0, v, vignette);
	gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

/** экспозиция и грейд «кинематографично, но близко к оригиналу» */
export interface ToneMappingSettings {
  exposure: number;
  bloomStrength: number;
  toneMix: number;
  saturation: number;
  contrast: number;
  vignette: number;
}

export const DEFAULT_TONEMAP: ToneMappingSettings = {
  exposure: 0.55,
  bloomStrength: 0.5,
  toneMix: 0.85,
  saturation: 1.08,
  contrast: 1.08,
  vignette: 0.18,
};

/** финальный проход кадра: пишет в экран (renderTarget = null) */
export class TonemapPass implements RenderPass {
  readonly name = 'tonemap';
  enabled = false;
  readonly settings: ToneMappingSettings = { ...DEFAULT_TONEMAP };

  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material = new THREE.ShaderMaterial({
    uniforms: {
      hdr: { value: null },
      bloom: { value: null },
      exposure: { value: DEFAULT_TONEMAP.exposure },
      bloomStrength: { value: DEFAULT_TONEMAP.bloomStrength },
      toneMix: { value: DEFAULT_TONEMAP.toneMix },
      saturation: { value: DEFAULT_TONEMAP.saturation },
      contrast: { value: DEFAULT_TONEMAP.contrast },
      vignette: { value: DEFAULT_TONEMAP.vignette },
    },
    vertexShader: fullscreenVertex,
    fragmentShader: tonemapFragment,
    depthTest: false,
    depthWrite: false,
  });

  constructor() {
    this.quad.frustumCulled = false;
    this.quad.material = this.material;
  }

  render(context: RenderContext): void {
    const hdr = context.targets.hdrTarget;
    if (!hdr) return;
    const uniforms = this.material.uniforms;
    uniforms.hdr.value = hdr.texture;
    uniforms.bloom.value = context.targets.bloomTarget?.texture ?? null;
    uniforms.exposure.value = this.settings.exposure;
    uniforms.bloomStrength.value = this.settings.bloomStrength;
    uniforms.toneMix.value = this.settings.toneMix;
    uniforms.saturation.value = this.settings.saturation;
    uniforms.contrast.value = this.settings.contrast;
    uniforms.vignette.value = this.settings.vignette;
    context.renderer.setRenderTarget(null);
    context.renderer.clear();
    context.renderer.render(this.quad, this.camera);
  }
}

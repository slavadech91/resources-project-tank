import * as THREE from 'three';
import type { RenderContext, RenderPass } from '../frame/FrameGraph.ts';
import type { BattlePassState } from './types.ts';
import { depthTargetSize } from './DepthPrepass.ts';

/**
 * Мягкие частицы (camera.softTransparency клиента 2019): проход заполняет uniform-переменные глубиной
 * из предпрохода, а материалы с makeSoftParticle гасят прозрачность у пересечения с геометрией.
 */
export class SoftParticlePass implements RenderPass {
  readonly name = 'soft-particles';
  enabled = false;

  constructor(private readonly state: BattlePassState) {}

  render(context: RenderContext): void {
    const depth = context.targets.depthTarget;
    if (!depth) return;
    const camera = context.frame.camera;
    this.state.soft.softDepth.value = depth.depthTexture;
    this.state.soft.softParams.value.set(camera.near, camera.far, this.state.settings.softParticles ? 1 : 0);
    this.state.soft.softScreen.value.copy(context.size);
  }
}

export const SSAO_RADIUS = 400;
export const SSAO_RANGE = 1200;
export const SSAO_ALPHA = 1.4;
export const SSAO_SAMPLES = 12;

const fullscreenVertex = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** DepthRendererSSAOFragmentShader по смыслу: выборки вокруг точки в радиусе ssaoRadius, вклад по N·v и дальности */
export function createSsaoMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      depth: { value: null },
      cameraNear: { value: 1 },
      cameraFar: { value: 200000 },
      projection: { value: new THREE.Vector2(1, 1) },
      size: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: fullscreenVertex,
    fragmentShader: `uniform sampler2D depth;
uniform float cameraNear;
uniform float cameraFar;
uniform vec2 projection;
uniform vec2 size;
varying vec2 vUv;
float viewDepth(vec2 uv) {
	float d = texture2D(depth, uv).x;
	return cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
}
vec3 viewPosition(vec2 uv) {
	float z = viewDepth(uv);
	return vec3((uv * 2.0 - 1.0) * z / projection, -z);
}
void main() {
	float z = viewDepth(vUv);
	if (z > cameraFar * 0.5) { gl_FragColor = vec4(0.0); return; }
	vec3 p = viewPosition(vUv);
	vec2 texel = 1.0 / size;
	vec3 px = viewPosition(vUv + vec2(texel.x, 0.0)) - p;
	vec3 py = viewPosition(vUv + vec2(0.0, texel.y)) - p;
	vec3 n = normalize(cross(px, py));
	float angle = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
	vec2 radius = ${SSAO_RADIUS.toFixed(1)} * projection * 0.5 / z;
	float ao = 0.0;
	for (int i = 0; i < ${SSAO_SAMPLES}; i++) {
		float a = angle + float(i) * 2.3999632;
		float r = (float(i) + 0.5) / ${SSAO_SAMPLES.toFixed(1)};
		vec3 s = viewPosition(vUv + vec2(cos(a), sin(a)) * radius * r) - p;
		float d = length(s);
		ao += max(dot(n, s / max(d, 0.001)) - 0.1, 0.0) * max(1.0 - d / ${SSAO_RANGE.toFixed(1)}, 0.0);
	}
	gl_FragColor = vec4(vec3(ao / ${SSAO_SAMPLES.toFixed(1)}), 1.0);
}`,
    depthTest: false,
    depthWrite: false,
  });
}

/** цвет кадра × (1 − k × ao), ao слегка размыт (4 соседа в половинном разрешении) */
export function createSsaoApplyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ao: { value: null }, k: { value: new THREE.Vector3() }, texel: { value: new THREE.Vector2() } },
    vertexShader: fullscreenVertex,
    fragmentShader: `uniform sampler2D ao;
uniform vec3 k;
uniform vec2 texel;
varying vec2 vUv;
void main() {
	float a = texture2D(ao, vUv).r * 0.4
		+ (texture2D(ao, vUv + vec2(texel.x, 0.0)).r + texture2D(ao, vUv - vec2(texel.x, 0.0)).r
		+ texture2D(ao, vUv + vec2(0.0, texel.y)).r + texture2D(ao, vUv - vec2(0.0, texel.y)).r) * 0.15;
	gl_FragColor = vec4(clamp(vec3(1.0) - k * a, 0.0, 1.0), 1.0);
}`,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
  });
}

/** затенение по буферу глубины в буфер AO */
export class SsaoComputePass implements RenderPass {
  readonly name = 'ssao-compute';
  enabled = false;

  constructor(private readonly state: BattlePassState) {}

  render(context: RenderContext): void {
    const depth = context.targets.depthTarget;
    const ao = context.targets.aoTarget;
    if (!depth || !ao) return;
    const { width, height } = depthTargetSize(context);
    const camera = context.frame.camera;
    const uniforms = this.state.ssaoMaterial.uniforms;
    uniforms.depth.value = depth.depthTexture;
    uniforms.cameraNear.value = camera.near;
    uniforms.cameraFar.value = camera.far;
    uniforms.projection.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
    uniforms.size.value.set(width, height);
    this.state.quad.material = this.state.ssaoMaterial;
    context.renderer.setRenderTarget(ao);
    context.renderer.render(this.state.quad, this.state.quadCamera);
  }
}

/** наложение AO на уже нарисованный кадр (смешивание: dest × src) */
export class SsaoApplyPass implements RenderPass {
  readonly name = 'ssao-apply';
  enabled = false;

  constructor(private readonly state: BattlePassState) {}

  render(context: RenderContext): void {
    const ao = context.targets.aoTarget;
    if (!ao) return;
    const { width, height } = depthTargetSize(context);
    const color = this.state.ssaoColor;
    const k = (channel: number): number => (1 - (2 * ((color >> channel) & 0xff)) / 255) * SSAO_ALPHA;
    this.state.ssaoApply.uniforms.ao.value = ao.texture;
    this.state.ssaoApply.uniforms.k.value.set(k(16), k(8), k(0));
    this.state.ssaoApply.uniforms.texel.value.set(1 / width, 1 / height);
    this.state.quad.material = this.state.ssaoApply;
    context.renderer.render(this.state.quad, this.state.quadCamera);
  }
}

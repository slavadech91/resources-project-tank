import * as THREE from 'three';
import type { RenderContext, RenderPass } from '../frame/FrameGraph.ts';

const fullscreenVertex = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Яркая часть кадра: 4-точечная выборка в 1/4 разрешения и мягкий порог (knee).
 * Всё, что темнее threshold, не попадает в свечение; ярче — уходит в bloom с плавным входом.
 */
const brightFragment = `uniform sampler2D source;
uniform vec2 texel;
uniform float threshold;
uniform float knee;
varying vec2 vUv;
void main() {
	vec3 sum = texture2D(source, vUv + texel * vec2(-1.0, -1.0)).rgb
		+ texture2D(source, vUv + texel * vec2(1.0, -1.0)).rgb
		+ texture2D(source, vUv + texel * vec2(-1.0, 1.0)).rgb
		+ texture2D(source, vUv + texel * vec2(1.0, 1.0)).rgb;
	vec3 color = sum * 0.25;
	float luma = max(max(color.r, color.g), color.b);
	float soft = clamp(luma - threshold + knee, 0.0, 2.0 * knee);
	soft = soft * soft / (4.0 * knee + 0.0001);
	float contribution = max(soft, luma - threshold) / max(luma, 0.0001);
	gl_FragColor = vec4(color * contribution, 1.0);
}`;

/** размытие в одном направлении: 5 отсчётов гауссиана в 1/4 разрешения */
const blurFragment = `uniform sampler2D source;
uniform vec2 direction;
varying vec2 vUv;
void main() {
	vec3 sum = texture2D(source, vUv).rgb * 0.227027;
	sum += (texture2D(source, vUv + direction * 1.384615).rgb + texture2D(source, vUv - direction * 1.384615).rgb) * 0.316216;
	sum += (texture2D(source, vUv + direction * 3.230769).rgb + texture2D(source, vUv - direction * 3.230769).rgb) * 0.070270;
	gl_FragColor = vec4(sum, 1.0);
}`;

/**
 * Bloom: яркий проход в 1/4 разрешения → размытие по горизонтали → по вертикали.
 * Итог лежит в targets.bloomTarget, его складывает с кадром TonemapPass.
 * Параметры подобраны под текущие (не физические) яркости клиента: порог ниже 1, чтобы
 * вспышки выстрелов и белые блики начинали светиться.
 */
export class BloomPass implements RenderPass {
  readonly name = 'bloom';
  enabled = false;
  /** порог яркости, ниже которого свечения нет */
  threshold = 1.1;
  /** мягкость перехода у порога */
  knee = 0.45;

  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly brightMaterial = new THREE.ShaderMaterial({
    uniforms: {
      source: { value: null },
      texel: { value: new THREE.Vector2(1, 1) },
      threshold: { value: 0.72 },
      knee: { value: 0.25 },
    },
    vertexShader: fullscreenVertex,
    fragmentShader: brightFragment,
    depthTest: false,
    depthWrite: false,
  });
  private readonly blurMaterial = new THREE.ShaderMaterial({
    uniforms: { source: { value: null }, direction: { value: new THREE.Vector2() } },
    vertexShader: fullscreenVertex,
    fragmentShader: blurFragment,
    depthTest: false,
    depthWrite: false,
  });

  constructor() {
    this.quad.frustumCulled = false;
    this.quad.material = this.brightMaterial;
  }

  render(context: RenderContext): void {
    const hdr = context.targets.hdrTarget;
    if (!hdr) return;
    const { bright, blurA, blurB } = context.targets.ensureBloom(hdr.width, hdr.height);
    const { renderer } = context;

    this.brightMaterial.uniforms.source.value = hdr.texture;
    this.brightMaterial.uniforms.texel.value.set(1 / hdr.width, 1 / hdr.height);
    this.brightMaterial.uniforms.threshold.value = this.threshold;
    this.brightMaterial.uniforms.knee.value = this.knee;
    this.quad.material = this.brightMaterial;
    renderer.setRenderTarget(bright);
    renderer.render(this.quad, this.camera);

    this.blurMaterial.uniforms.source.value = bright.texture;
    this.blurMaterial.uniforms.direction.value.set(1 / bright.width, 0);
    this.quad.material = this.blurMaterial;
    renderer.setRenderTarget(blurA);
    renderer.render(this.quad, this.camera);

    this.blurMaterial.uniforms.source.value = blurA.texture;
    this.blurMaterial.uniforms.direction.value.set(0, 1 / bright.height);
    renderer.setRenderTarget(blurB);
    renderer.render(this.quad, this.camera);
  }
}

import * as THREE from 'three';
import { addShaderPatch } from '../shaderHooks.ts';
import type { SoftParticleUniforms } from '../passes/types.ts';

/**
 * Мягкие частицы (camera.softTransparency клиента 2019): uniform-переменные общие для всех материалов,
 * проход SoftParticlePass заполняет их глубиной сцены раз в кадр.
 */
export const softUniforms: SoftParticleUniforms = {
  softDepth: { value: null as THREE.Texture | null },
  // near, far, включено
  softParams: { value: new THREE.Vector3(1, 200000, 0) },
  softScreen: { value: new THREE.Vector2(1, 1) },
};

/**
 * Помечает материал «мягкой частицей»: прозрачность домножается на saturate((глубина сцены −
 * глубина фрагмента) / softAttenuation) — частица гаснет у пересечения с геометрией.
 */
export function makeSoftParticle(material: THREE.Material, softAttenuation: number): void {
  if (softAttenuation <= 0) return;
  addShaderPatch(material, 'soft', (shader) => {
    Object.assign(shader.uniforms, softUniforms);
    shader.uniforms.softAttenuation = { value: softAttenuation };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D softDepth;
uniform vec3 softParams;
uniform vec2 softScreen;
uniform float softAttenuation;
float softViewDepth(float depth) {
	return softParams.x * softParams.y / (softParams.y - depth * (softParams.y - softParams.x));
}`,
      )
      .replace(
        '#include <fog_fragment>',
        `if (softParams.z > 0.5) {
	float sceneDepth = softViewDepth(texture2D(softDepth, gl_FragCoord.xy / softScreen).x);
	gl_FragColor.a *= clamp((sceneDepth - softViewDepth(gl_FragCoord.z)) / softAttenuation, 0.0, 1.0);
}
#include <fog_fragment>`,
      );
  });
}

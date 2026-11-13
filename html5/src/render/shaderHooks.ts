import * as THREE from 'three';

/**
 * Общие правки шейдеров Three.js под движок клиента 2019 (Narukami: a3d.hardware, TextureMaterialFragmentShader,
 * DepthRendererLightFragmentShader). Ставятся один раз до компиляции первого материала.
 *
 * Туман (Camera3D.fogNear/fogFar/fogAlpha): доля = clamp((z − near) / (far − near)) × alpha — линейно и не до конца,
 * а не smoothstep до 1, как у THREE.Fog. alpha — общий uniform fogAlpha (0 — тумана нет, без перекомпиляции).
 *
 * Точечный свет (OmniLight в DepthRenderer): свет × saturate((end − d) / (end − begin))² × max(N·L, 0).
 * У THREE.PointLight это включается отрицательным decay: decay = −attenuationBegin, distance = attenuationEnd.
 */

/** uniform-переменные, общие для всех материалов (одни и те же объекты { value }) */
export const sharedUniforms = {
  fogAlpha: { value: 0 },
};

let installed = false;

export function installShaderHooks(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.fog_pars_fragment = chunks.fog_pars_fragment.replace('uniform vec3 fogColor;', 'uniform vec3 fogColor;\n\tuniform float fogAlpha;');
  chunks.fog_fragment = `#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = clamp( ( vFogDepth - fogNear ) / ( fogFar - fogNear ), 0.0, 1.0 );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * fogAlpha );
#endif`;
  const attenuation = 'float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {';
  if (!chunks.lights_pars_begin.includes(attenuation)) throw new Error('shaderHooks: нет getDistanceAttenuation в lights_pars_begin');
  chunks.lights_pars_begin = chunks.lights_pars_begin.replace(
    attenuation,
    `${attenuation}
	if ( decayExponent < 0.0 ) {
		// OmniLight клиента 2019: begin = -decay, end = distance
		return pow2( saturate( ( cutoffDistance - lightDistance ) / max( cutoffDistance + decayExponent, 0.001 ) ) );
	}`,
  );
  // всем материалам — общие uniform-переменные (onBeforeCompile по умолчанию пустой)
  THREE.Material.prototype.onBeforeCompile = function (shader: THREE.WebGLProgramParametersWithUniforms): void {
    applySharedUniforms(shader);
  };
}

/** для своих onBeforeCompile: сначала общие uniform-переменные */
export function applySharedUniforms(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.fogAlpha = sharedUniforms.fogAlpha;
}

const materialPatches = new WeakMap<THREE.Material, Map<string, (shader: THREE.WebGLProgramParametersWithUniforms) => void>>();

/** добавить свою правку шейдера материала поверх общих (несколько правок на одном материале складываются) */
export function addShaderPatch(material: THREE.Material, key: string, patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  let patches = materialPatches.get(material);
  if (!patches) materialPatches.set(material, patches = new Map());
  patches.set(key, patch);
  material.onBeforeCompile = (shader) => {
    applySharedUniforms(shader);
    for (const apply of patches.values()) apply(shader);
  };
  const keys = [...patches.keys()].join(',');
  material.customProgramCacheKey = () => keys;
  material.needsUpdate = true;
}

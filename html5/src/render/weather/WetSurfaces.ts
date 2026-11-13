import { Color, type Material } from 'three';
import { addShaderPatch } from '../shaderHooks.ts';
import { shelterUniforms } from './RainShelter.ts';

export const rainSurfaceUniforms = {
  groundWetness: { value: 0 },
  groundRain: { value: 0 },
  groundRainTime: { value: 0 },
  wetSkyColor: { value: new Color(0x5a6a78) },
};

/** World-space puddles and ripples that continue across neighbouring map props. */
export function makeWetSurface(material: Material, armor = false): void {
  addShaderPatch(material, armor ? 'wet-armor' : 'wet-surface', (shader) => {
    Object.assign(shader.uniforms, rainSurfaceUniforms, shelterUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 wetWorldPosition;\nvarying vec3 wetLocalPosition;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wetPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wetPosition = instanceMatrix * wetPosition;
        #endif
        wetWorldPosition = (modelMatrix * wetPosition).xyz;
        wetLocalPosition = transformed;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 wetWorldPosition;
        varying vec3 wetLocalPosition;
        uniform float groundWetness;
        uniform float groundRain;
        uniform float groundRainTime;
        uniform vec3 wetSkyColor;
        uniform sampler2D rainRoofDepth;
        uniform vec4 rainRoofBounds;
        uniform vec2 rainRoofRange;

        float rainExposure(vec3 p) {
          vec2 uv = vec2(p.x - rainRoofBounds.x, rainRoofBounds.y - p.z) * rainRoofBounds.zw;
          if (rainRoofRange.y <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
          float roof = texture2D(rainRoofDepth, uv).r;
          float separation = (rainRoofRange.x - p.y) - roof / rainRoofRange.y;
          return 1.0 - smoothstep(22.0, 45.0, separation);
        }

        float wetHash(vec2 p) {
          vec3 q = fract(p.xyx * 0.1031);
          q += dot(q, q.yzx + 33.33);
          return fract((q.x + q.y) * q.z);
        }
        float wetNoise(vec2 p) {
          vec2 cell = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(wetHash(cell), wetHash(cell + vec2(1, 0)), f.x),
            mix(wetHash(cell + vec2(0, 1)), wetHash(cell + vec2(1, 1)), f.x), f.y);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float waterGlint = 0.0;
        if (groundWetness > 0.0) {
          float exposedWetness = groundWetness * rainExposure(wetWorldPosition);
          vec3 up = viewMatrix[1].xyz;
          float upward = clamp(dot(nonPerturbedNormal, up), 0.0, 1.0);
          vec3 eye = normalize(vViewPosition);
          float fresnel = 0.04 + 0.96 * pow(1.0 - clamp(dot(nonPerturbedNormal, eye), 0.0, 1.0), 5.0);
          ${armor ? `
          // The wet film stays on the moving armor and gathers on upward-facing panels.
          vec2 panel = wetLocalPosition.xy + wetLocalPosition.z * vec2(0.36, 0.19);
          float film = exposedWetness * mix(0.35, 1.0, upward) * mix(0.68, 1.0, wetNoise(panel / 28.0));
          diffuseColor.rgb *= 1.0 - 0.16 * film;
          #ifdef STANDARD
            roughnessFactor = mix(roughnessFactor, 0.16, film);
          #endif
          waterGlint = fresnel * film * 0.48;
          ` : `
          vec2 ground = wetWorldPosition.xz;
          vec2 basin = ground + 85.0 * vec2(wetNoise(ground / 178.0), wetNoise(ground.yx / 202.0 + 42.0));
          float groundPattern = wetNoise(basin / vec2(290.0, 210.0)) * 0.86 + wetNoise(ground / 56.0) * 0.14;
          float horizontal = smoothstep(0.89, 0.99, upward);
          float puddle = horizontal * smoothstep(0.72 - 0.18 * groundWetness, 0.78 - 0.18 * groundWetness, groundPattern);
          float water = puddle * exposedWetness;
          diffuseColor.rgb *= 1.0 - (0.11 * exposedWetness + 0.29 * water);
          waterGlint = fresnel * water * 0.64;
          #ifdef STANDARD
            roughnessFactor = mix(roughnessFactor, 0.42, exposedWetness * 0.36);
            roughnessFactor = mix(roughnessFactor, 0.09, water);
            normal = normalize(mix(normal, nonPerturbedNormal, water * 0.7));
          #endif
          vec2 tile = ground / 52.0;
          float pixelSize = max(length(fwidth(tile)), 0.012);
          if (water > 0.01 && groundRain > 0.01 && pixelSize < 0.22) {
            vec2 cell = floor(tile);
            float seed = wetHash(cell);
            vec2 drop = vec2(0.25) + 0.50 * vec2(seed, wetHash(cell + 71.0));
            vec2 fromDrop = fract(tile) - drop;
            float age = fract(groundRainTime * mix(0.8, 1.5, seed) + seed * 19.0);
            float radius = age * 0.25;
            float distanceToRing = length(fromDrop) - radius;
            float ring = 1.0 - smoothstep(pixelSize * 0.55, pixelSize + 0.026, abs(distanceToRing));
            float ripple = ring * smoothstep(0.0, 0.12, age) * (1.0 - age) * water * groundRain;
            vec2 slope = fromDrop / max(length(fromDrop), 0.01) * sin(distanceToRing * 62.0) * ripple * 0.26;
            normal = normalize(normal + mat3(viewMatrix) * vec3(slope.x, 0.0, slope.y));
            waterGlint += ripple * (0.09 + 0.22 * fresnel);
          }
          `}
        }`)
      .replace('#include <opaque_fragment>', `outgoingLight += wetSkyColor * waterGlint;
        #include <opaque_fragment>`);
  });
}

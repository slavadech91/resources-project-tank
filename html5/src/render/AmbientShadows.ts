import * as THREE from 'three';
import { addShaderPatch } from './shaderHooks.ts';

/**
 * «Тень под танком» клиента 2019: AmbientShadows + Shadow(128, 8, 100, 1, 1, 0x111122, 0.6) у TankSkin
 * (direction (0, 0, −1), offset 90, backFadeRange 90; заслоняют корпус и башня).
 *
 * Shadow: силуэт заслонителей сверху в ортографической проекции → клетка 128 px атласа (ShadowAtlas) с размытием
 * 8 px (поля клетки 1 + blur, чтобы размытие не выходило за клетку); приёмники в объёме под танком
 * (от верха + offset до низа + attenuation) получают поверх цвет 0x111122 с прозрачностью
 * силуэт × затухание × alpha. Тени гаснут по расстоянию от камеры: AmbientShadows near 4000 → far 7000
 * (там они ещё подстраиваются под FPS — берём значения для высокого FPS).
 *
 * Приёмники — материалы карты (makeAmbientShadowReceiver): шейдер перебирает активные тени (не больше MAX_SHADOWS).
 */

const MAP_SIZE = 128;
const BLUR = 8;
const ATTENUATION = 100;
const OFFSET = 90;
const BACK_FADE_RANGE = 90;
const COLOR = 0x111122;
const ALPHA = 0.6;
const NEAR_DISTANCE = 4000;
const FAR_DISTANCE = 7000;
const MAX_SHADOWS = 16;
const ATLAS_TILES = 4; // 4 × 4 клетки
const ATLAS_SIZE = MAP_SIZE * ATLAS_TILES;
const CASTER_LAYER = 3;

export interface AmbientShadowCaster {
  /** меши-заслонители (корпус с гусеницами, башня) — прямые дети группы мира, матрицы в осях карты */
  meshes: THREE.Mesh[];
  /** 0..1: прозрачность танка (у оригинала alpha тени = alpha танка × 0.6) */
  alpha(): number;
}

const uniforms = {
  ambientShadowAtlas: { value: null as THREE.Texture | null },
  ambientShadowCount: { value: 0 },
  ambientShadowEnabled: { value: 0 },
  // planeX, planeY, planeSize, верх (Z) в осях карты
  ambientShadowRect: { value: Array.from({ length: MAX_SHADOWS }, () => new THREE.Vector4()) },
  // клетка атласа (u, v), высота заслонителей, alpha
  ambientShadowData: { value: Array.from({ length: MAX_SHADOWS }, () => new THREE.Vector4()) },
  ambientShadowColor: { value: new THREE.Color(COLOR) },
  ambientShadowWorldToMap: { value: new THREE.Matrix4() },
};

/** материал карты получает тени под танками */
export function makeAmbientShadowReceiver(material: THREE.Material): void {
  addShaderPatch(material, 'ambientShadow', (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAmbientShadowWorld;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvAmbientShadowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vAmbientShadowWorld;
uniform sampler2D ambientShadowAtlas;
uniform int ambientShadowCount;
uniform float ambientShadowEnabled;
uniform vec4 ambientShadowRect[${MAX_SHADOWS}];
uniform vec4 ambientShadowData[${MAX_SHADOWS}];
uniform vec3 ambientShadowColor;
uniform mat4 ambientShadowWorldToMap;`,
      )
      .replace(
        '#include <fog_fragment>',
        `if (ambientShadowEnabled > 0.5) {
	vec3 mapPosition = (ambientShadowWorldToMap * vec4(vAmbientShadowWorld, 1.0)).xyz;
	float lit = 1.0;
	for (int i = 0; i < ${MAX_SHADOWS}; i++) {
		if (i >= ambientShadowCount) break;
		vec4 rect = ambientShadowRect[i];
		vec4 data = ambientShadowData[i];
		vec2 uv = (mapPosition.xy - rect.xy) / rect.z;
		if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
		float depth = rect.w - mapPosition.z;
		float fade = clamp((depth - ${OFFSET.toFixed(1)}) / ${BACK_FADE_RANGE.toFixed(1)}, 0.0, 1.0)
			* clamp((data.z + ${ATTENUATION.toFixed(1)} - depth) / ${ATTENUATION.toFixed(1)}, 0.0, 1.0);
		float silhouette = texture2D(ambientShadowAtlas, data.xy + uv * ${(1 / ATLAS_TILES).toFixed(4)}).r;
		lit *= 1.0 - silhouette * fade * data.w;
	}
	gl_FragColor.rgb = mix(ambientShadowColor, gl_FragColor.rgb, lit);
}
#include <fog_fragment>`,
      );
  });
}

const blurVertex = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function blurMaterial(direction: THREE.Vector2): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { source: { value: null }, direction: { value: direction } },
    vertexShader: blurVertex,
    fragmentShader: `uniform sampler2D source;
uniform vec2 direction;
varying vec2 vUv;
void main() {
	float sum = 0.0;
	for (int i = -${BLUR}; i <= ${BLUR}; i++) sum += texture2D(source, vUv + direction * float(i)).r;
	gl_FragColor = vec4(vec3(sum / ${(2 * BLUR + 1).toFixed(1)}), 1.0);
}`,
    depthTest: false,
    depthWrite: false,
  });
}

const corner = new THREE.Vector3();
const box = new THREE.Box3();
const cameraMapPosition = new THREE.Vector3();

/** все танки с тенью (TankSkin.addToScene); тень строится только у тех, что висят прямо в группе мира */
const casters = new Set<AmbientShadowCaster>();

export function registerAmbientShadowCaster(caster: AmbientShadowCaster): void {
  if (casters.has(caster)) return;
  casters.add(caster);
  for (const mesh of caster.meshes) mesh.traverse((object) => (object.userData.ambientShadowCaster = true));
}

export class AmbientShadows {
  private readonly atlas = new THREE.WebGLRenderTarget(ATLAS_SIZE, ATLAS_SIZE, { depthBuffer: true });
  private readonly temp = new THREE.WebGLRenderTarget(ATLAS_SIZE, ATLAS_SIZE, { depthBuffer: false });
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 10000);
  private readonly silhouette = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, side: THREE.DoubleSide });
  private readonly blurH = blurMaterial(new THREE.Vector2(1 / ATLAS_SIZE, 0));
  private readonly blurV = blurMaterial(new THREE.Vector2(0, 1 / ATLAS_SIZE));
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private enabled = false;

  constructor(private readonly world: THREE.Object3D) {
    this.camera.layers.set(CASTER_LAYER);
    this.camera.name = 'ambient-shadow-camera';
    world.add(this.camera);
    uniforms.ambientShadowAtlas.value = this.atlas.texture;
    this.quad.frustumCulled = false;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    uniforms.ambientShadowEnabled.value = enabled ? 1 : 0;
    if (!enabled) uniforms.ambientShadowCount.value = 0;
  }

  /** до кадра: силуэты ближайших к камере танков в атлас и параметры для приёмников */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.enabled) return;
    this.world.updateMatrixWorld();
    uniforms.ambientShadowWorldToMap.value.copy(this.world.matrixWorld).invert();
    camera.getWorldPosition(cameraMapPosition);
    cameraMapPosition.applyMatrix4(uniforms.ambientShadowWorldToMap.value);

    const visible: { caster: AmbientShadowCaster; distance: number; fade: number }[] = [];
    for (const caster of casters) {
      const mesh = caster.meshes[0];
      if (!mesh.parent) {
        casters.delete(caster);
        continue;
      }
      if (mesh.parent != this.world || !mesh.visible) continue;
      const position = mesh.matrix.elements;
      const distance = Math.hypot(position[12] - cameraMapPosition.x, position[13] - cameraMapPosition.y, position[14] - cameraMapPosition.z);
      const fade = 1 - THREE.MathUtils.clamp((distance - NEAR_DISTANCE) / (FAR_DISTANCE - NEAR_DISTANCE), 0, 1);
      const alpha = caster.alpha();
      if (fade <= 0 || alpha <= 0) continue;
      visible.push({ caster, distance, fade: fade * alpha });
    }
    visible.sort((a, b) => a.distance - b.distance);
    const count = Math.min(visible.length, MAX_SHADOWS);
    uniforms.ambientShadowCount.value = count;
    if (count == 0) return;

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;
    const previousAutoClear = renderer.autoClear;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const previousBackground = scene.background;
    renderer.autoClear = false;
    scene.background = null;
    scene.overrideMaterial = this.silhouette;
    renderer.setRenderTarget(this.atlas);
    renderer.setClearColor(0x000000, 1);
    this.atlas.scissorTest = false;
    this.atlas.viewport.set(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    renderer.setRenderTarget(this.atlas);
    renderer.clear();
    this.atlas.scissorTest = true;
    const inner = MAP_SIZE - 2 - 2 * BLUR;

    for (let i = 0; i < count; i++) {
      const { caster, fade } = visible[i];
      // рамка заслонителей в осях карты (Shadow.checkVisibility для direction (0, 0, −1))
      box.makeEmpty();
      for (const mesh of caster.meshes) {
        // с дочерними мешами (гусеницы корпуса)
        mesh.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const geometry = object.geometry as THREE.BufferGeometry;
          if (!geometry.boundingBox) geometry.computeBoundingBox();
          const b = geometry.boundingBox!;
          for (let c = 0; c < 8; c++) {
            corner.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z);
            if (object != mesh) corner.applyMatrix4(object.matrix);
            box.expandByPoint(corner.applyMatrix4(mesh.matrix));
          }
        });
      }
      const width = box.max.x - box.min.x;
      const height = box.max.y - box.min.y;
      const size = Math.max(width, height);
      const planeSize = (size * MAP_SIZE) / inner;
      const centerX = (box.min.x + box.max.x) / 2;
      const centerY = (box.min.y + box.max.y) / 2;
      const tileX = i % ATLAS_TILES;
      const tileY = Math.floor(i / ATLAS_TILES);

      this.camera.left = -planeSize / 2;
      this.camera.right = planeSize / 2;
      this.camera.top = planeSize / 2;
      this.camera.bottom = -planeSize / 2;
      this.camera.near = 1;
      this.camera.far = box.max.z - box.min.z + 20;
      this.camera.position.set(centerX, centerY, box.max.z + 10);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();

      this.atlas.viewport.set(tileX * MAP_SIZE, tileY * MAP_SIZE, MAP_SIZE, MAP_SIZE);
      this.atlas.scissor.set(tileX * MAP_SIZE, tileY * MAP_SIZE, MAP_SIZE, MAP_SIZE);
      renderer.setRenderTarget(this.atlas);
      renderer.render(scene, this.camera);

      uniforms.ambientShadowRect.value[i].set(centerX - planeSize / 2, centerY - planeSize / 2, planeSize, box.max.z);
      uniforms.ambientShadowData.value[i].set(tileX / ATLAS_TILES, tileY / ATLAS_TILES, box.max.z - box.min.z, ALPHA * fade);
    }
    this.atlas.scissorTest = false;
    this.atlas.viewport.set(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    scene.overrideMaterial = previousOverride;
    scene.background = previousBackground;

    // размытие 8 px по горизонтали и вертикали (ShadowAtlas)
    this.blurH.uniforms.source.value = this.atlas.texture;
    this.quad.material = this.blurH;
    renderer.setRenderTarget(this.temp);
    renderer.render(this.quad, this.quadCamera);
    this.blurV.uniforms.source.value = this.temp.texture;
    this.quad.material = this.blurV;
    renderer.setRenderTarget(this.atlas);
    renderer.render(this.quad, this.quadCamera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.autoClear = previousAutoClear;
  }
}

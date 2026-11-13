import * as THREE from 'three';

/**
 * Освещение боя как в оригинале: alternativa/tanks/battle/Lighting.as.
 *
 *   setup(lightColor, shadowColor, angleX, angleZ):
 *     ambient       = shadowColor
 *     directional   = lightColor - shadowColor (по каналам)
 *     направление   = (0, 1, 0), повёрнутый матрицей setRotationMatrix(angleX, 0, angleZ)
 *
 * Параметры карты — dynamic_shadow_params в dev/configs/graphics_settings/default.json
 * (angle_y там — это angleZ в Lighting.setup).
 *
 * Шейдер движка (decompiled/engine: Camera3D.as — lightParams, TextureMaterial.as — fc10/fc11):
 *   цвет = texture * (2 * ambient + 2 * light * max(N·L, 0))
 * — цвета передаются в шейдер как `color * 2 / 255`. Считается прямо в значениях цвета,
 * без гамма-преобразований: отключаем color management Three.js, а интенсивность
 * ставим 2π (Lambert в Three.js делит на π — BRDF_Lambert).
 */
const ALTERNATIVA_LIGHT_SCALE = 2 * Math.PI;
/**
 * Контраст теней: ambient ослабляем, солнце усиливаем — освещённые поверхности остаются
 * той же яркости (ambient + sun * N·L), а затенённые заметно темнее.
 */
/** сила ambient-света: 1 — как в оригинале, меняется ползунком */
export const AMBIENT_STRENGTH = 1.0;
export interface LightingParams {
  lightColor: number;
  shadowColor: number;
  angleX: number;
  angleZ: number;
}

export const DEFAULT_LIGHTING: LightingParams = {
  lightColor: 0xc7bdab,
  shadowColor: 0x54646f,
  // подобрано вручную по оригиналу (ползунки в окне настроек); из конфига сервера было -1 / -0.5
  angleX: -2.15,
  angleZ: 2.64,
};

export function setupRawColorPipeline(renderer: THREE.WebGLRenderer): void {
  THREE.ColorManagement.enabled = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
}

function subtractColor(a: number, b: number): number {
  const channel = (shift: number): number => Math.max(0, ((a >> shift) & 0xff) - ((b >> shift) & 0xff));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/** Направление лучей в осях карты (Z вверх): (0,1,0) после поворота X на angleX, затем Z на angleZ. */
export function lightDirection(params: LightingParams): THREE.Vector3 {
  // Matrix3.setRotationMatrix в alternativa.math: R = Rz * Ry * Rx — у Three.js это порядок 'ZYX'
  const rotation = new THREE.Euler(params.angleX, 0, params.angleZ, 'ZYX');
  return new THREE.Vector3(0, 1, 0).applyEuler(rotation).normalize();
}

export interface BattleLights {
  ambient: THREE.AmbientLight;
  sun: THREE.DirectionalLight;
  /** направление лучей в осях карты (Z вверх) */
  direction: THREE.Vector3;
  /** shadowMapCorrectionFactor из BattleScene3D (сервер шлёт 0 — это его догадка, см. TODO в battle_field_global_model.py) */
  correctionFactor: number;
  /** сила направленного света (ползунок «Солнце») */
  sunStrength: number;
  /** включена ли настройка «Динамические тени» (нужно для пересчёта света при смене силы) */
  shadowsEnabled: boolean;
}

/**
 * Карта теней как alternativa.engine3d.core.ShadowMap, параметры из ShadowMap-контроллера боя
 * (decompiled/orglib: §#G§/§9T§): mapSize 2048, near 5000, far 10000, bias 0.5, additionalSpace 3000.
 * Оригинал рисует глубину с точки зрения солнца в ортографической проекции, подогнанной под пирамиду камеры
 * (дальность far), и в шейдере фильтрует её 8 выборками с поворотом по шуму; свет = ambient + sun * min(N·L, 1 - тень).
 * В Three.js — штатная shadow map направленного света (PCF) с такой же областью и размером карты.
 */
const SHADOW_MAP_SIZE = 2048;
const SHADOW_HALF_EXTENT = 6000;
const SHADOW_LIGHT_DISTANCE = 10000;
const SHADOW_EXTRA_SPACE = 3000;

/**
 * Настройка «Динамические тени» меняет не только тени, но и сам свет: BattleScene3D.render ставит
 * directionalLight.intensity = shadowMapCorrectionFactor + shadowMapStrength * (1 - shadowMapCorrectionFactor),
 * а shadowMapStrength = 0 без карты теней. Сервер шлёт shadowMapCorrectionFactor = 0, поэтому без динамических теней
 * направленный свет гаснет и остаётся один ambient (плоская картинка), с ними интенсивность 1.
 */
export const SHADOW_MAP_CORRECTION_FACTOR = 0.03;

export function setLightingStrengths(lights: BattleLights, ambientStrength: number, sunStrength: number): void {
  lights.ambient.intensity = ALTERNATIVA_LIGHT_SCALE * ambientStrength;
  lights.sunStrength = sunStrength;
  setDynamicShadows(lights, lights.shadowsEnabled);
}

/**
 * «Темнота теней»: опускает заливку (ambient) и одновременно поднимает солнце.
 * В тени остаётся только ambient, поэтому тень темнеет; на освещённых местах потеря заливки
 * компенсируется прибавкой солнца, и общая яркость сцены почти не меняется.
 * 0 — как сейчас, 1 — тени максимально глубокие.
 */
export function setShadowDarkness(lights: BattleLights, ambientStrength: number, sunStrength: number, darkness: number): void {
  const k = Math.min(Math.max(darkness, 0), 1);
  setLightingStrengths(lights, ambientStrength * (1 - 0.6 * k), sunStrength * (1 + 0.5 * k));
}

export function setDynamicShadows(lights: BattleLights, enabled: boolean): void {
  lights.shadowsEnabled = enabled;
  const strength = enabled ? 1 : 0;
  lights.sun.intensity =
    ALTERNATIVA_LIGHT_SCALE * lights.sunStrength * (lights.correctionFactor + strength * (1 - lights.correctionFactor));
}

/** Угол солнца: angleX и angleZ из dynamic_shadow_params (angle_x, angle_y). */
export function setSunAngles(lights: BattleLights, angleX: number, angleZ: number): void {
  lights.direction.copy(lightDirection({ ...DEFAULT_LIGHTING, angleX, angleZ }));
  lights.sun.position.copy(lights.sun.target.position).addScaledVector(lights.direction, -SHADOW_LIGHT_DISTANCE);
}

/** Добавляет ambient и направленный свет в группу мира (оси оригинала). */
export function addBattleLighting(world: THREE.Object3D, params: LightingParams = DEFAULT_LIGHTING): BattleLights {
  const ambient = new THREE.AmbientLight(params.shadowColor, ALTERNATIVA_LIGHT_SCALE * AMBIENT_STRENGTH);
  world.add(ambient);

  const sun = new THREE.DirectionalLight(subtractColor(params.lightColor, params.shadowColor), ALTERNATIVA_LIGHT_SCALE);
  const direction = lightDirection(params);
  sun.position.copy(direction).multiplyScalar(-SHADOW_LIGHT_DISTANCE);
  sun.target.position.set(0, 0, 0);

  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -SHADOW_HALF_EXTENT;
  shadowCamera.right = SHADOW_HALF_EXTENT;
  shadowCamera.top = SHADOW_HALF_EXTENT;
  shadowCamera.bottom = -SHADOW_HALF_EXTENT;
  shadowCamera.near = 1;
  shadowCamera.far = SHADOW_LIGHT_DISTANCE + SHADOW_HALF_EXTENT + SHADOW_EXTRA_SPACE;
  shadowCamera.updateProjectionMatrix();
  // единицы — сантиметры карты: смещения подобраны под лист размером в сотни единиц
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 2;

  world.add(sun);
  world.add(sun.target);
  return { ambient, sun, direction, correctionFactor: SHADOW_MAP_CORRECTION_FACTOR, sunStrength: 1, shadowsEnabled: false };
}

const lightRight = new THREE.Vector3();
const lightUp = new THREE.Vector3();
const MAP_UP = new THREE.Vector3(0, 0, 1);

/**
 * Ставит область карты теней вокруг точки фокуса (в осях карты). Центр привязан к сетке текселей,
 * чтобы края теней не дрожали при движении камеры.
 */
export function updateShadowFocus(lights: BattleLights, focus: THREE.Vector3): void {
  const { sun, direction } = lights;
  lightRight.crossVectors(direction, MAP_UP).normalize();
  lightUp.crossVectors(lightRight, direction).normalize();
  const texel = (2 * SHADOW_HALF_EXTENT) / SHADOW_MAP_SIZE;
  const x = focus.dot(lightRight);
  const y = focus.dot(lightUp);
  const target = sun.target.position.copy(focus);
  target.addScaledVector(lightRight, Math.round(x / texel) * texel - x);
  target.addScaledVector(lightUp, Math.round(y / texel) * texel - y);
  sun.position.copy(target).addScaledVector(direction, -SHADOW_LIGHT_DISTANCE);
}

/** Тени отбрасывают и принимают все освещаемые непрозрачные меши (эффекты и декали — нет). */
export function applyShadowFlags(root: THREE.Object3D, enabled: boolean): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.Material;
    const lambertOrStandard =
      (material as THREE.MeshLambertMaterial).isMeshLambertMaterial ||
      (material as THREE.MeshStandardMaterial).isMeshStandardMaterial;
    const eligible = enabled && lambertOrStandard && !material.transparent;
    mesh.castShadow = eligible;
    mesh.receiveShadow = eligible;
  });
}

/**
 * Фильтр теней как в TextureMaterial оригинала: 8 выборок по кольцу радиусом noiseRadius * (0.3…1) текселя
 * (в оригинале noiseRadius = 1.3; здесь 1.1 текселя),
 * начальная фаза кольца случайна в 0…π/4 для каждого пикселя (в оригинале — текстура шума 64x64 по экрану,
 * тут — хэш от gl_FragCoord по тому же периоду), жёсткое сравнение глубины, среднее по 8. Даёт зернистый край тени.
 * Включается для THREE.PCFShadowMap; вызывать до первого рендера.
 */
export function installNoisyShadowFilter(): void {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const start = chunk.indexOf('#if defined( SHADOWMAP_TYPE_PCF )');
  const end = chunk.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )');
  const frustum = '\t\tbool inFrustum = shadowCoord.x';
  if (start < 0 || end < 0 || !chunk.includes(frustum)) {
    console.warn('шейдерный чанк теней изменился: шум на краях теней не установлен');
    return;
  }
  const noisy = `#if defined( SHADOWMAP_TYPE_PCF )
			vec2 noiseCell = mod( gl_FragCoord.xy, 64.0 );
			float noiseAngle = fract( sin( dot( noiseCell, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 0.7853981633974483;
			float noiseScale = 0.3 + 0.7 * fract( sin( dot( noiseCell, vec2( 39.346, 11.135 ) ) ) * 24634.6345 );
			vec2 noiseStep = ( 1.1 * noiseScale ) / shadowMapSize;
			shadow = 0.0;
			for ( int i = 0; i < 8; i ++ ) {
				float ringAngle = noiseAngle + float( i ) * 0.7853981633974483;
				vec2 sampleUv = shadowCoord.xy + vec2( cos( ringAngle ), sin( ringAngle ) ) * noiseStep;
				vec2 texel = clamp( floor( sampleUv * shadowMapSize ), vec2( 0.0 ), shadowMapSize - 1.0 );
				vec2 texelCenter = ( texel + 0.5 ) / shadowMapSize;
				float receiverDepth = shadowCoord.z + clamp( dot( depthGradient, texelCenter - shadowCoord.xy ), -0.002, 0.002 );
				shadow += texture2DCompare( shadowMap, texelCenter, receiverDepth );
			}
			shadow *= 0.125;
		`;
  // Nearest filtering returns depth at the texel centre. Compare it with the
  // receiver plane at that same point, rather than with the fragment's depth.
  // Evaluate derivatives before the per-fragment frustum branch.
  const gradient = `#if defined( SHADOWMAP_TYPE_PCF )
    vec3 shadowDx = dFdx( shadowCoord.xyz );
    vec3 shadowDy = dFdy( shadowCoord.xyz );
    float jacobian = shadowDx.x * shadowDy.y - shadowDx.y * shadowDy.x;
    vec2 depthGradient = vec2( 0.0 );
    if ( abs( jacobian ) > 1e-12 ) {
      depthGradient = vec2(
        shadowDx.z * shadowDy.y - shadowDy.z * shadowDx.y,
        shadowDx.x * shadowDy.z - shadowDy.x * shadowDx.z
      ) / jacobian;
    }
    #endif
`;
  THREE.ShaderChunk.shadowmap_pars_fragment = (chunk.slice(0, start) + noisy + chunk.slice(end))
    .replace(frustum, gradient + frustum);
}

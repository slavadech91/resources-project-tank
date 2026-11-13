import * as THREE from 'three';
import { AmbientShadows } from './AmbientShadows.ts';
import { dynamicLights } from './DynamicLights.ts';
import { installShaderHooks, sharedUniforms } from './shaderHooks.ts';
import { makeSoftParticle, softUniforms } from './effects/SoftParticles.ts';
import { AmbientShadowsPass, LayerAssignPass, createFullscreenQuad } from './passes/LayerPasses.ts';
import { DepthPrepass, createDepthMaterial } from './passes/DepthPrepass.ts';
import {
  SoftParticlePass,
  SsaoApplyPass,
  SsaoComputePass,
  createSsaoApplyMaterial,
  createSsaoMaterial,
} from './passes/SsaoPasses.ts';
import { FinishFramePass, FullScenePass, OpaqueScenePass, TransparentScenePass } from './passes/ScenePasses.ts';
import { BloomPass } from './post/BloomPass.ts';
import { TonemapPass } from './post/TonemapPass.ts';
import { needsDepth, type BattleEffectsSettings, type BattlePassState, type MapFogParams } from './passes/types.ts';
import type { RenderCore } from './RenderCore.ts';

export { makeSoftParticle, softUniforms };
export type { BattleEffectsSettings, MapFogParams };

/**
 * Кадр боя с эффектами камеры клиента 2019 (Narukami: BattleScene3D + a3d.hardware Camera3D/DepthRenderer):
 *
 *  - «Туман» (Fog.enable/disable): параметры карты fog_params (color, alpha, near_limit, far_limit) в Camera3D;
 *    выключенный — alpha 0. Формула — shaderHooks.
 *  - «Мягкие частицы» (camera.softTransparency): проход SoftParticlePass заполняет глубину, материалы
 *    с makeSoftParticle гасят прозрачность у пересечения с геометрией.
 *  - «Глубокие тени» (camera.ssao, ssaoRadius 400, ssaoRange 1200, ssaoAlpha 1.4, ssaoColor карты):
 *    затенение по буферу глубины; цвет непрозрачной геометрии × (1 − k × ao).
 *  - «Тень под танком» — AmbientShadows, «Динамическое освещение» — DynamicLights.
 *
 * Сам кадр собирается проходами FrameGraph (src/render/passes): слои → тень под танком → глубина →
 * мягкие частицы → SSAO → непрозрачное → SSAO поверх → прозрачное → финал. Класс только выставляет
 * включённость проходов по настройкам и хранит состояние материалов.
 */

/** dev/configs/graphics_settings/default.json — пока карта не прислала свои */
const DEFAULT_FOG: MapFogParams = { alpha: 0.25, color: 0xddf1ff, nearLimit: 5000, farLimit: 10000 };
const DEFAULT_SSAO_COLOR = 0x2e2920;

export class BattleRenderer {
  readonly ambientShadows: AmbientShadows;
  private readonly settings: BattleEffectsSettings = {
    fog: false,
    softParticles: false,
    ssao: false,
    shadows: false,
    dynamicLighting: false,
  };
  private fogParams: MapFogParams = DEFAULT_FOG;
  /** туман из настроек (вкладка «Небо и свет»); null — параметры карты */
  private fogOverride: MapFogParams | null = null;
  private readonly state: BattlePassState;
  private readonly passes: {
    layers: LayerAssignPass;
    ambient: AmbientShadowsPass;
    full: FullScenePass;
    depth: DepthPrepass;
    soft: SoftParticlePass;
    ssaoCompute: SsaoComputePass;
    opaque: OpaqueScenePass;
    ssaoApply: SsaoApplyPass;
    transparent: TransparentScenePass;
    finish: FinishFramePass;
    bloom: BloomPass;
    tonemap: TonemapPass;
  };
  /** кинематографичный пайплайн: HDR-кадр + bloom + ACES tone mapping */
  private cinematic = true;
  /** настройки tone mapping (экспозиция, bloom, грейд) — доступны из консоли через __tanki */
  readonly tonemap = new TonemapPass();
  /** проход bloom: порог яркости и мягкость (ползунки окна настроек) */
  readonly bloom = new BloomPass();

  constructor(
    private readonly core: RenderCore,
    world: THREE.Object3D,
  ) {
    installShaderHooks();
    this.ambientShadows = new AmbientShadows(world);
    dynamicLights.attach(world);
    core.renderer.shadowMap.autoUpdate = false;

    const { quad, camera: quadCamera } = createFullscreenQuad();
    this.state = {
      settings: this.settings,
      soft: softUniforms,
      depthMaterial: createDepthMaterial(),
      ssaoMaterial: createSsaoMaterial(),
      ssaoApply: createSsaoApplyMaterial(),
      quad,
      quadCamera,
      ambientShadows: this.ambientShadows,
      ssaoColor: DEFAULT_SSAO_COLOR,
      savedBackground: null,
      savedOverride: null,
    };

    // порядок проходов = прежний порядок операций в render(): менять только вместе с проверкой картинки
    const graph = core.graph;
    this.passes = {
      layers: graph.add(new LayerAssignPass()) as LayerAssignPass,
      ambient: graph.add(new AmbientShadowsPass(this.state)) as AmbientShadowsPass,
      full: graph.add(new FullScenePass(this.state)) as FullScenePass,
      depth: graph.add(new DepthPrepass(this.state)) as DepthPrepass,
      soft: graph.add(new SoftParticlePass(this.state)) as SoftParticlePass,
      ssaoCompute: graph.add(new SsaoComputePass(this.state)) as SsaoComputePass,
      opaque: graph.add(new OpaqueScenePass(this.state)) as OpaqueScenePass,
      ssaoApply: graph.add(new SsaoApplyPass(this.state)) as SsaoApplyPass,
      transparent: graph.add(new TransparentScenePass()) as TransparentScenePass,
      finish: graph.add(new FinishFramePass(this.state)) as FinishFramePass,
      bloom: graph.add(this.bloom) as BloomPass,
      tonemap: graph.add(this.tonemap) as TonemapPass,
    };

    this.applyFog();
    this.core.setPostProcessing(this.cinematic);
  }

  /** включить/выключить кинематографичный пайплайн (сравнение: ?legacy) */
  setPostProcessing(enabled: boolean): void {
    this.cinematic = enabled;
    this.core.setPostProcessing(enabled);
  }

  /** переопределение тумана из окна настроек (null — параметры карты) */
  setFogOverride(fog: MapFogParams | null): void {
    this.fogOverride = fog;
    this.applyFog();
  }

  setSettings(settings: BattleEffectsSettings): void {
    Object.assign(this.settings, settings);
    this.applyFog();
    this.ambientShadows.setEnabled(settings.shadows);
    dynamicLights.setEnabled(settings.dynamicLighting);
  }

  /** параметры карты: BattleMapModelData.fog_params и ssao_color */
  setMapParams(fog: MapFogParams | null, ssaoColor: number | null): void {
    this.fogParams = fog ?? DEFAULT_FOG;
    this.state.ssaoColor = ssaoColor ?? DEFAULT_SSAO_COLOR;
    this.applyFog();
  }

  private applyFog(): void {
    const params = this.fogOverride ?? this.fogParams;
    const { color, nearLimit, farLimit, alpha } = params;
    // Fog.enable: туман только при ненулевом цвете
    const enabled = this.settings.fog && color != 0;
    const scene = this.core.scene;
    if (!(scene.fog instanceof THREE.Fog)) scene.fog = new THREE.Fog(color, nearLimit, farLimit);
    const fog = scene.fog as THREE.Fog;
    fog.color.setHex(color);
    fog.near = nearLimit;
    fog.far = farLimit;
    sharedUniforms.fogAlpha.value = enabled ? alpha : 0;
  }

  /** включает проходы по настройкам эффектов и рисует кадр через граф */
  render(camera: THREE.PerspectiveCamera, dynamicShadows: boolean): void {
    const need = needsDepth(this.settings);
    this.passes.layers.enabled = need || this.settings.shadows;
    this.passes.ambient.enabled = this.settings.shadows;
    this.passes.full.enabled = !need;
    this.passes.depth.enabled = need;
    this.passes.soft.enabled = need;
    this.passes.ssaoCompute.enabled = need && this.settings.ssao;
    this.passes.opaque.enabled = need;
    this.passes.ssaoApply.enabled = need && this.settings.ssao;
    this.passes.transparent.enabled = need;
    this.passes.finish.enabled = need;
    this.passes.bloom.enabled = this.cinematic;
    this.passes.tonemap.enabled = this.cinematic;
    this.core.render(dynamicShadows, camera);
  }
}

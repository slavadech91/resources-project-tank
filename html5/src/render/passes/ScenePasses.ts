import * as THREE from 'three';
import type { RenderContext, RenderPass } from '../frame/FrameGraph.ts';
import type { BattlePassState } from './types.ts';
import { LAYER_OPAQUE, LAYER_SPRITE, LAYER_TRANSPARENT } from './layers.ts';

/**
 * Кадр без глубины (мягкие частицы и SSAO выключены): весь мир одним вызовом, как обычный
 * THREE-рендер — автоочистка, все слои, обновление shadow map по настройкам.
 */
export class FullScenePass implements RenderPass {
  readonly name = 'scene-full';
  enabled = false;

  constructor(private readonly state: BattlePassState) {}

  render(context: RenderContext): void {
    const camera = context.frame.camera;
    this.state.soft.softParams.value.z = 0;
    camera.layers.enableAll();
    context.renderer.shadowMap.needsUpdate = context.frame.dynamicShadows;
    context.renderer.setRenderTarget(context.target);
    context.renderer.autoClear = true;
    context.renderer.render(context.scene, camera);
  }
}

/**
 * Непрозрачная геометрия в буфер кадра: очистка, затем меши слоя 0 и непрозрачные спрайты слоя 2.
 * Фон-цвет Three.js сам чистит буфер в начале render, поэтому на время проходов фон снимается,
 * а цвет очистки выставляется явно.
 */
export class OpaqueScenePass implements RenderPass {
  readonly name = 'scene-opaque';
  enabled = false;

  constructor(private readonly state: BattlePassState) {}

  render(context: RenderContext): void {
    const { renderer, scene } = context;
    const camera = context.frame.camera;
    renderer.setRenderTarget(context.target);
    renderer.autoClear = false;
    const background = this.state.savedBackground;
    if (background instanceof THREE.Color) renderer.setClearColor(background, 1);
    scene.background = null;
    renderer.clear();
    camera.layers.set(LAYER_OPAQUE);
    camera.layers.enable(LAYER_SPRITE);
    renderer.shadowMap.needsUpdate = context.frame.dynamicShadows;
    renderer.render(scene, camera);
  }
}

/** прозрачная геометрия (слой 1) поверх уже нарисованного кадра */
export class TransparentScenePass implements RenderPass {
  readonly name = 'scene-transparent';
  enabled = false;

  render(context: RenderContext): void {
    const camera = context.frame.camera;
    camera.layers.set(LAYER_TRANSPARENT);
    context.renderer.render(context.scene, camera);
  }
}

/** конец кадра: вернуть слои камеры, фон сцены и автоочистку — как было до проходов */
export class FinishFramePass implements RenderPass {
  readonly name = 'finish';
  enabled = false;

  constructor(private readonly state: BattlePassState) {}

  render(context: RenderContext): void {
    context.frame.camera.layers.enableAll();
    context.scene.background = this.state.savedBackground;
    context.renderer.autoClear = true;
    // дальше кадр читают проходы пост-обработки: экран освобождаем, если рисовали в HDR-буфер
    context.renderer.setRenderTarget(null);
  }
}

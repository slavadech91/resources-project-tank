import * as THREE from 'three';
import type { RenderContext, RenderPass } from '../frame/FrameGraph.ts';
import type { BattlePassState } from './types.ts';
import { LAYER_OPAQUE } from './layers.ts';

/** глубина для мягких частиц и SSAO считается в половинном разрешении (depthBufferScale клиента 2019) */
export const DEPTH_SCALE = 0.5;

/** размер буфера глубины по размеру кадра */
export function depthTargetSize(context: RenderContext): { width: number; height: number } {
  return {
    width: Math.max(1, Math.floor(context.size.x * DEPTH_SCALE)),
    height: Math.max(1, Math.floor(context.size.y * DEPTH_SCALE)),
  };
}

/** материал предпрохода: пишем только глубину, две стороны (у моделей клиента открытые оболочки) */
export function createDepthMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ colorWrite: false, fog: false, side: THREE.DoubleSide });
}

/**
 * Предпроход глубины непрозрачной геометрии. Как DepthRenderer клиента 2019: отдельный проход,
 * фон и overrideMaterial снимаются на время, shadow map здесь не обновляется.
 */
export class DepthPrepass implements RenderPass {
  readonly name = 'depth';
  enabled = false;

  constructor(private readonly state: BattlePassState) {}

  render(context: RenderContext): void {
    const { renderer, scene } = context;
    const camera = context.frame.camera;
    const { width, height } = depthTargetSize(context);
    const targets = context.targets.ensure(width, height);

    this.state.savedBackground = scene.background;
    this.state.savedOverride = scene.overrideMaterial;
    scene.background = null;
    scene.overrideMaterial = this.state.depthMaterial;
    camera.layers.set(LAYER_OPAQUE);
    renderer.shadowMap.needsUpdate = false;
    renderer.autoClear = true;
    renderer.setRenderTarget(targets.depth);
    renderer.render(scene, camera);
    scene.overrideMaterial = this.state.savedOverride;
    scene.background = this.state.savedBackground;
  }
}

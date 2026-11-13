import * as THREE from 'three';
import type { RenderContext, RenderPass } from '../frame/FrameGraph.ts';
import type { BattlePassState } from './types.ts';
import { assignSceneLayers } from './layers.ts';

/**
 * Раскладка объектов сцены по слоям (нужна проходам, которые рисуют не всю сцену сразу).
 * Включается, когда включены мягкие частицы/SSAO или тень под танком.
 */
export class LayerAssignPass implements RenderPass {
  readonly name = 'layers';
  enabled = false;

  render(context: RenderContext): void {
    assignSceneLayers(context.scene);
  }
}

/** «Тень под танком»: AmbientShadows рисует силуэты в буфер глубины своей камерой */
export class AmbientShadowsPass implements RenderPass {
  readonly name = 'ambient-shadows';
  enabled = false;

  constructor(private readonly state: BattlePassState) {}

  render(context: RenderContext): void {
    this.state.ambientShadows.update(context.renderer, context.scene, context.frame.camera);
  }
}

/** Общий fullscreen-квад для проходов пост-обработки (SSAO и будущих) */
export function createFullscreenQuad(): { quad: THREE.Mesh; camera: THREE.OrthographicCamera } {
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  return { quad, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
}

import type * as THREE from 'three';
import type { RenderTargets } from './RenderTargets.ts';

/**
 * Кадр рендера: всё, что системе рендера нужно знать о текущем кадре.
 * Камера — из RenderCore (её же передаёт main.ts), deltaMs — для анимаций эффектов.
 */
export interface RenderFrame {
  camera: THREE.PerspectiveCamera;
  deltaMs: number;
  /** «Динамические тени» из настроек графики: обновлять ли shadow map в этом кадре */
  dynamicShadows: boolean;
}

/** Общий контекст прохода: рендерер, сцена, цели рендера, размер буфера и данные кадра */
export interface RenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly targets: RenderTargets;
  /** размер буфера рисования (уже с учётом pixelRatio) */
  readonly size: THREE.Vector2;
  readonly frame: RenderFrame;
  /**
   * Куда рисуют проходы сцены: null — прямо в экран, HDR-цель — если включена пост-обработка.
   * Проходы пост-обработки в конце кадра возвращают null и пишут на экран сами.
   */
  readonly target: THREE.WebGLRenderTarget | null;
}

/**
 * Проход кадра. `enabled` переключается владельцем графа каждый кадр (настройки качества),
 * поэтому новый эффект — это новый проход, а не правка одного большого render().
 */
export interface RenderPass {
  readonly name: string;
  enabled: boolean;
  render(context: RenderContext): void;
}

/** Упорядоченный список проходов: рисует только включённые, строго по порядку добавления */
export class FrameGraph {
  private readonly passes: RenderPass[] = [];

  add(pass: RenderPass): RenderPass {
    this.passes.push(pass);
    return pass;
  }

  /** проход по имени — чтобы включать/выключать его из настроек или отладки */
  get(name: string): RenderPass | undefined {
    return this.passes.find((pass) => pass.name == name);
  }

  get all(): readonly RenderPass[] {
    return this.passes;
  }

  render(context: RenderContext): void {
    for (const pass of this.passes) {
      if (pass.enabled) pass.render(context);
    }
  }
}

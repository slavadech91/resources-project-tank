import * as THREE from 'three';
import { FrameGraph, type RenderContext, type RenderFrame } from './frame/FrameGraph.ts';
import { RenderTargets } from './frame/RenderTargets.ts';

export interface RenderCoreOptions {
  /** контейнер, в который добавляется canvas */
  parent: HTMLElement;
  antialias?: boolean;
  /** цвет фона сцены (по умолчанию — тёмный фон клиента) */
  background?: number;
  /**
   * Настройка рендерера до создания сцены: цветовой пайплайн, шейдерные правки, подготовка текстур.
   * Вызывается после setPixelRatio/setSize, до appendChild и до создания сцены.
   */
  configure?: (renderer: THREE.WebGLRenderer) => void;
}

/**
 * Ядро рендера: владеет рендерером, сценой, камерой, размером буфера и графом кадров.
 * Всё остальное (игровые системы, эффекты, карта) не создаёт THREE.WebGLRenderer и не решает,
 * что и в каком порядке рисовать — это делает FrameGraph.
 */
export class RenderCore {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** порядок проходов кадра; системы добавляют свои проходы через add() */
  readonly graph = new FrameGraph();
  readonly targets = new RenderTargets();
  /** размер буфера рисования с учётом pixelRatio (заполняется в render) */
  readonly size = new THREE.Vector2();

  private readonly frame: RenderFrame;
  private lastTime = 0;
  /** включена ли пост-обработка: кадр сцены рисуется в HDR-буфер, а не в экран */
  private postEnabled = false;

  constructor(options: RenderCoreOptions) {
    const renderer = new THREE.WebGLRenderer({
      antialias: options.antialias ?? true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, matchMedia('(pointer:coarse)').matches ? 1.25 : 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.type = THREE.PCFShadowMap;
    options.configure?.(renderer);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(options.background ?? 0x0e0e16);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 200000);
    this.frame = { camera: this.camera, deltaMs: 0, dynamicShadows: false };

    options.parent.appendChild(renderer.domElement);
  }

  /** данные текущего кадра (камера, delta, динамические тени) — только чтение для проходов */
  get frameState(): Readonly<RenderFrame> {
    return this.frame;
  }

  resize(width = window.innerWidth, height = window.innerHeight): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /** включить/выключить пост-обработку (HDR-буфер + bloom + tone mapping) */
  setPostProcessing(enabled: boolean): void {
    this.postEnabled = enabled;
  }

  /** кадр: обновляет паспорт кадра и прогоняет включённые проходы графа */
  render(dynamicShadows: boolean, camera?: THREE.PerspectiveCamera): void {
    const now = performance.now();
    this.frame.deltaMs = this.lastTime ? now - this.lastTime : 0;
    this.lastTime = now;
    if (camera) this.frame.camera = camera;
    this.frame.dynamicShadows = dynamicShadows;
    this.renderer.getDrawingBufferSize(this.size);
    const width = Math.max(1, Math.floor(this.size.x));
    const height = Math.max(1, Math.floor(this.size.y));
    const target = this.postEnabled ? this.targets.ensureHdr(width, height) : null;
    const context: RenderContext = {
      renderer: this.renderer,
      scene: this.scene,
      targets: this.targets,
      size: this.size,
      frame: this.frame,
      target,
    };
    this.graph.render(context);
  }

  /** очистка кадра без сцены (экран загрузки боя) */
  clear(): void {
    this.renderer.clear();
  }

  dispose(): void {
    this.targets.dispose();
    this.renderer.dispose();
  }
}

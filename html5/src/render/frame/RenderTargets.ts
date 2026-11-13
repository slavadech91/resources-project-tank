import * as THREE from 'three';

/**
 * Цели рендера кадра.
 *
 *  - depth — глубина непрозрачной геометрии в половинном разрешении (мягкие частицы, SSAO);
 *  - ao — буфер затенения;
 *  - hdr — кадр сцены в half-float: в него рисуют проходы сцены, из него читают bloom и tone mapping;
 *  - bloom — яркая часть кадра, размытая в 1/4 разрешения (яркость + две проходки блюра).
 *
 * Пересоздаются только при смене размера буфера; освобождаются через dispose().
 */
export class RenderTargets {
  private depth: THREE.WebGLRenderTarget | null = null;
  private ao: THREE.WebGLRenderTarget | null = null;
  private hdr: THREE.WebGLRenderTarget | null = null;
  private bright: THREE.WebGLRenderTarget | null = null;
  private blurA: THREE.WebGLRenderTarget | null = null;
  private blurB: THREE.WebGLRenderTarget | null = null;

  get depthTarget(): THREE.WebGLRenderTarget | null {
    return this.depth;
  }

  get aoTarget(): THREE.WebGLRenderTarget | null {
    return this.ao;
  }

  get hdrTarget(): THREE.WebGLRenderTarget | null {
    return this.hdr;
  }

  /** итоговая размытая яркая часть кадра (её читает tone mapping) */
  get bloomTarget(): THREE.WebGLRenderTarget | null {
    return this.blurB;
  }

  get brightTarget(): THREE.WebGLRenderTarget | null {
    return this.bright;
  }

  get blurTargetA(): THREE.WebGLRenderTarget | null {
    return this.blurA;
  }

  get blurTargetB(): THREE.WebGLRenderTarget | null {
    return this.blurB;
  }

  ensure(width: number, height: number): { depth: THREE.WebGLRenderTarget; ao: THREE.WebGLRenderTarget } {
    if (this.depth && this.depth.width == width && this.depth.height == height && this.ao) {
      return { depth: this.depth, ao: this.ao };
    }
    this.depth?.dispose();
    this.ao?.dispose();
    const depthTexture = new THREE.DepthTexture(width, height);
    depthTexture.type = THREE.UnsignedIntType;
    this.depth = new THREE.WebGLRenderTarget(width, height, { depthTexture, depthBuffer: true });
    this.ao = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
    return { depth: this.depth, ao: this.ao };
  }

  /** HDR-буфер кадра сцены (half-float, без depth — глубину считает отдельный препрепасс) */
  ensureHdr(width: number, height: number): THREE.WebGLRenderTarget {
    if (this.hdr && this.hdr.width == width && this.hdr.height == height) return this.hdr;
    this.hdr?.dispose();
    this.hdr = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // MSAA на HDR-цели: canvas antialias действует только на экран, а кадр теперь идёт через буфер
      samples: 4,
    });
    return this.hdr;
  }

  /** цели bloom: яркая часть в 1/4 разрешения и две размытые копии */
  ensureBloom(width: number, height: number): {
    bright: THREE.WebGLRenderTarget;
    blurA: THREE.WebGLRenderTarget;
    blurB: THREE.WebGLRenderTarget;
  } {
    const w = Math.max(1, Math.floor(width / 4));
    const h = Math.max(1, Math.floor(height / 4));
    if (this.bright && this.bright.width == w && this.bright.height == h) {
      return { bright: this.bright, blurA: this.blurA!, blurB: this.blurB! };
    }
    this.bright?.dispose();
    this.blurA?.dispose();
    this.blurB?.dispose();
    const options: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    };
    this.bright = new THREE.WebGLRenderTarget(w, h, options);
    this.blurA = new THREE.WebGLRenderTarget(w, h, options);
    this.blurB = new THREE.WebGLRenderTarget(w, h, options);
    return { bright: this.bright, blurA: this.blurA, blurB: this.blurB };
  }

  dispose(): void {
    this.depth?.dispose();
    this.ao?.dispose();
    this.hdr?.dispose();
    this.bright?.dispose();
    this.blurA?.dispose();
    this.blurB?.dispose();
    this.depth = null;
    this.ao = null;
    this.hdr = null;
    this.bright = null;
    this.blurA = null;
    this.blurB = null;
  }
}

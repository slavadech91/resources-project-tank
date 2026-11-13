import * as THREE from 'three';

/**
 * Карты неровностей из обычной diffuse-текстуры (у ассетов 2014 года их нет).
 *
 *  - normalMap: яркость текстуры трактуется как высота, по ней Собель даёт наклон, из наклона —
 *    нормаль в тангенциальном пространстве (как будто краска/штукатурка имеет рельеф);
 *  - roughnessMap: чем темнее место, тем грубее поверхность (тёмное = грязь/износ), светлое — гладкое.
 *
 * Карты считаются один раз на текстуру и кэшируются по uuid; разрешение фиксированное (256),
 * потому что это шум рельефа, а не детализация.
 */
export interface DerivedSurfaceMaps {
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

const SIZE = 256;
const cache = new Map<string, DerivedSurfaceMaps | null>();

function drawSource(image: HTMLImageElement): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, SIZE, SIZE);
  return context.getImageData(0, 0, SIZE, SIZE);
}

function luma(data: Uint8ClampedArray, index: number): number {
  return (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255;
}

/** нормали и шероховатость из картинки; null — если картинка ещё не загружена */
export function deriveSurfaceMaps(texture: THREE.Texture, strength = 2.2): DerivedSurfaceMaps | null {
  const cached = cache.get(texture.uuid);
  if (cached !== undefined) return cached;

  const image = texture.image as HTMLImageElement | undefined;
  if (!image || !image.width || !image.height) {
    cache.set(texture.uuid, null);
    return null;
  }
  const source = drawSource(image);
  if (!source) {
    cache.set(texture.uuid, null);
    return null;
  }
  const data = source.data;

  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = SIZE;
  normalCanvas.height = SIZE;
  const normalContext = normalCanvas.getContext('2d');
  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = SIZE;
  roughCanvas.height = SIZE;
  const roughContext = roughCanvas.getContext('2d');
  if (!normalContext || !roughContext) {
    cache.set(texture.uuid, null);
    return null;
  }
  const normalImage = normalContext.createImageData(SIZE, SIZE);
  const roughImage = roughContext.createImageData(SIZE, SIZE);

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const left = luma(data, (((y * SIZE) + ((x - 1 + SIZE) % SIZE)) << 2));
      const right = luma(data, (((y * SIZE) + ((x + 1) % SIZE)) << 2));
      const up = luma(data, ((((y - 1 + SIZE) % SIZE) * SIZE + x) << 2));
      const down = luma(data, ((((y + 1) % SIZE) * SIZE + x) << 2));
      const dx = (right - left) * strength;
      const dy = (down - up) * strength;
      // нормаль из наклона высоты: ( -dx, -dy, 1 ), сжатая в 0…1
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const nx = (-dx / length) * 0.5 + 0.5;
      const ny = (-dy / length) * 0.5 + 0.5;
      const nz = (1 / length) * 0.5 + 0.5;
      const offset = ((y * SIZE) + x) << 2;
      normalImage.data[offset] = nx * 255;
      normalImage.data[offset + 1] = ny * 255;
      normalImage.data[offset + 2] = nz * 255;
      normalImage.data[offset + 3] = 255;

      const brightness = luma(data, offset);
      // шероховатость: тёмное — грубее (0.95), светлое — гладкое (0.55)
      const roughness = 0.95 - brightness * 0.4;
      roughImage.data[offset] = roughness * 255;
      roughImage.data[offset + 1] = roughness * 255;
      roughImage.data[offset + 2] = roughness * 255;
      roughImage.data[offset + 3] = 255;
    }
  }
  normalContext.putImageData(normalImage, 0, 0);
  roughContext.putImageData(roughImage, 0, 0);

  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.colorSpace = THREE.NoColorSpace;
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.colorSpace = THREE.NoColorSpace;

  const maps = { normalMap, roughnessMap };
  cache.set(texture.uuid, maps);
  return maps;
}

/** сбросить кэш (например, при смене палитры карты) */
export function clearDerivedSurfaceMaps(): void {
  for (const maps of cache.values()) {
    maps?.normalMap.dispose();
    maps?.roughnessMap.dispose();
  }
  cache.clear();
}

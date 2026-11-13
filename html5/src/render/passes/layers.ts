import type * as THREE from 'three';

/**
 * Слои сцены для проходов рендера. Проставляются каждый кадр (объекты появляются и исчезают):
 * 0 — непрозрачные меши, 1 — прозрачные, 2 — непрозрачные спрайты (не попадают в проход глубины),
 * 3 — заслонители теней под танком (вдобавок к своему слою).
 */
export const LAYER_OPAQUE = 0;
export const LAYER_TRANSPARENT = 1;
export const LAYER_SPRITE = 2;
export const LAYER_CASTER = 3;

/** раскладывает объекты сцены по слоям: по прозрачности материала, свет — во все слои */
export function assignSceneLayers(scene: THREE.Scene): void {
  scene.traverse((object) => {
    if ((object as THREE.Light).isLight) {
      object.layers.enableAll();
      return;
    }
    const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    const first = Array.isArray(material) ? material[0] : material;
    let mask = first?.transparent
      ? 1 << LAYER_TRANSPARENT
      : (object as THREE.Sprite).isSprite
        ? 1 << LAYER_SPRITE
        : 1 << LAYER_OPAQUE;
    if (object.userData.ambientShadowCaster) mask |= 1 << LAYER_CASTER;
    object.layers.mask = mask;
  });
}

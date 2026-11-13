import * as THREE from 'three';
import { addShaderPatch } from '../shaderHooks.ts';

/**
 * Сила эффектов оружия относительно остальной картины.
 *
 * Эффекты (вспышки, трассеры, взрывы, дым) — спрайты и аддитивные меши. Общая «идеальная» картинка
 * подбирается по миру, а эффекты при этом выглядят тускло или наоборот пересветлёнными, поэтому их
 * яркость масштабируется отдельным множителем прямо в шейдере материала: gl_FragColor.rgb *= fxStrength.
 *
 * Значения >1 выводят эффект за пределы 1.0 — bloom подхватывает его и он начинает светиться.
 */
export const effectStrength = { value: 1.6 };

const PATCH_KEY = 'fxStrength';
const patched = new WeakSet<THREE.Material>();

/** пометить материал эффекта: домножать цвет на общий множитель (один раз на материал) */
export function patchEffectMaterial(material: THREE.Material): void {
  if (patched.has(material)) return;
  patched.add(material);
  addShaderPatch(material, PATCH_KEY, (shader) => {
    // вставлять множитель можно только туда, где есть gl_FragColor и куда можно объявить uniform
    if (!shader.fragmentShader.includes('#include <common>') || !shader.fragmentShader.includes('#include <dithering_fragment>')) return;
    shader.uniforms.fxStrength = effectStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float fxStrength;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.rgb *= fxStrength;');
  });
}

function isEffectMaterial(material: THREE.Material, object: THREE.Object3D): boolean {
  // только эффекты: спрайты и Basic-материалы с прозрачностью/аддитивным смешиванием.
  // Танк и карта — Standard/Lambert, их прозрачность (тень, fade) к эффектам не относится.
  if ((object as THREE.Sprite).isSprite) return true;
  if ((material as THREE.SpriteMaterial).isSpriteMaterial) return true;
  const basic = material as THREE.MeshBasicMaterial;
  if (basic.isMeshBasicMaterial === true) return material.transparent || material.blending !== THREE.NormalBlending;
  return false;
}

/** Подключить общий множитель к материалам добавленного объекта. */
function patchObject(object: THREE.Object3D): void {
  const material = (object as THREE.Sprite).material as THREE.Material | THREE.Material[] | undefined;
  if (Array.isArray(material)) {
    for (const item of material) if (item && isEffectMaterial(item, object)) patchEffectMaterial(item);
  } else if (material && isEffectMaterial(material, object)) patchEffectMaterial(material);
}

/** Подключаем новый материал до первого кадра эффекта, включая эффекты в динамических группах. */
export function watchEffectStrength(root: THREE.Group): void {
  const added = ({ child }: { child: THREE.Object3D }): void => child.traverse(attach);
  const removed = ({ child }: { child: THREE.Object3D }): void => child.traverse(detach);
  const attach = (object: THREE.Object3D): void => {
    patchObject(object);
    if (!(object as THREE.Group).isGroup) return;
    object.addEventListener('childadded', added);
    object.addEventListener('childremoved', removed);
  };
  const detach = (object: THREE.Object3D): void => {
    if (!(object as THREE.Group).isGroup) return;
    object.removeEventListener('childadded', added);
    object.removeEventListener('childremoved', removed);
  };
  root.traverse(attach);
}

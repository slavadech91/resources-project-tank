import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Склейка статичных пропов карты: один меш на материал вместо тысяч отдельных (на Тишине 1683 меша → ~130).
 * Треугольников на карте мало (~19 тыс.), поэтому отсечение по пирамиде видимости почти ничего не экономит,
 * а каждый отдельный объект стоит CPU дважды за кадр — в основном проходе и в карте динамических теней.
 * Картинка та же: вершины переносятся в координаты родителя, материалы (текстура, flatShading, обе стороны) прежние.
 * Склеенные меши помечены userData.propName, как пропы: на них ложатся следы выстрелов и метки зон ящиков.
 * userData.parts — какой проп в каких треугольниках батча (инспектор пропов ui/hud/PropInspector).
 */

/** проп внутри склеенного меша: треугольники до end (не включая) */
export interface BatchPart {
  end: number;
  bounds: THREE.Box3;
  library: string;
  name: string;
  texture: string;
  position: THREE.Vector3;
  rotation: THREE.Euler;
}
export function mergeStaticProps(parent: THREE.Object3D, meshes: THREE.Mesh[]): THREE.Mesh[] {
  const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
  for (const mesh of meshes) {
    const material = mesh.material as THREE.Material;
    const list = byMaterial.get(material);
    if (list) list.push(mesh);
    else byMaterial.set(material, [mesh]);
  }

  const merged: THREE.Mesh[] = [];
  for (const [material, list] of byMaterial) {
    const geometries = list.map((mesh) => {
      mesh.updateMatrix();
      return mesh.geometry.clone().applyMatrix4(mesh.matrix);
    });
    const geometry = list.length == 1 ? geometries[0] : mergeGeometries(geometries);
    if (!geometry) continue; // разные наборы атрибутов — оставляем как было
    geometry.computeBoundingSphere();
    for (const mesh of list) parent.remove(mesh);
    const batch = new THREE.Mesh(geometry, material);
    batch.userData.propName = 'batch';
    let end = 0;
    batch.userData.parts = list.map((mesh, index): BatchPart => {
      const part = geometries[index];
      part.computeBoundingBox();
      end += (part.index ? part.index.count : part.getAttribute('position').count) / 3;
      const data = mesh.userData;
      return { end, bounds: part.boundingBox!, library: String(data.library ?? ''), name: String(data.propName ?? ''), texture: String(data.texture ?? ''), position: mesh.position.clone(), rotation: mesh.rotation.clone() };
    });
    if (geometry != geometries[0]) for (const part of geometries) part.dispose();
    batch.matrixAutoUpdate = false;
    parent.add(batch);
    merged.push(batch);
  }
  return merged;
}

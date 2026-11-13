import { makeWetSurface } from '../render/weather/WetSurfaces.ts';
import * as THREE from 'three';
import type { ClientMap, ServerMap, PropPlacement, Vec3 } from './types';
import { makeAmbientShadowReceiver } from '../render/AmbientShadows.ts';
import { materialLibrary } from '../render/materials/MaterialLibrary.ts';

// Построение отрисовки карты. Всё строится в «оригинальных» осях (Z вверх),
// перевод в Y-up делает группа world в main.ts.

export interface MapStats {
  boxes: number;
  planes: number;
  triangles: number;
  props: number;
  spawns: number;
}

export interface ServerMapViewOptions {
  /** показывать объёмы коллизий (отладка, по умолчанию выключено) */
  collisions: boolean;
  /** показывать маркеры точек спавна (отладка) */
  spawns: boolean;
}

/** Углы из map.xml как в Alternativa (Matrix3.setRotationMatrix): Rz·Ry·Rx — в Three.js это порядок 'ZYX' */
function euler(rotation: Vec3): THREE.Euler {
  return new THREE.Euler(rotation.x, rotation.y, rotation.z, 'ZYX');
}

/**
 * Коллизии сервера и маркеры спавнов — это отладочный слой, а не карта.
 * По умолчанию он невидим (иначе синие объёмы закрывают всю геометрию),
 * включается параметром ?debug=collisions,spawns или клавишами.
 */
export function buildServerMap(
  map: ServerMap,
  parent: THREE.Object3D,
  options: ServerMapViewOptions = { collisions: false, spawns: false },
): MapStats {
  const debug = new THREE.Group();
  debug.name = 'debug-layer';
  debug.visible = options.collisions || options.spawns;
  parent.add(debug);

  const solid = materialLibrary.create({ color: 0x5b6b7d, roughness: 0.95 }) as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;
  makeAmbientShadowReceiver(solid);
  const volume = materialLibrary.create({
    color: 0x4a6fa5,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });

  const boxGeometryCache = new THREE.BoxGeometry(1, 1, 1);

  const collisionGroup = new THREE.Group();
  collisionGroup.name = 'debug-collisions';
  collisionGroup.visible = options.collisions;
  debug.add(collisionGroup);

  for (const box of map.boxes) {
    const mesh = new THREE.Mesh(boxGeometryCache, volume);
    mesh.scale.set(box.size.x, box.size.y, box.size.z);
    mesh.position.set(box.position.x, box.position.y, box.position.z);
    mesh.rotation.copy(euler(box.rotation));
    collisionGroup.add(mesh);
  }

  for (const plane of map.planes) {
    const mesh = new THREE.Mesh(boxGeometryCache, solid);
    mesh.scale.set(plane.width, plane.length, 4);
    mesh.position.set(plane.position.x, plane.position.y, plane.position.z);
    mesh.rotation.copy(euler(plane.rotation));
    collisionGroup.add(mesh);
  }

  // треугольники собираем в одну геометрию — их сотни, отдельные меши не нужны
  const positions: number[] = [];
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const vertex = new THREE.Vector3();

  for (const triangle of map.triangles) {
    quaternion.setFromEuler(euler(triangle.rotation));
    matrix.compose(
      new THREE.Vector3(triangle.position.x, triangle.position.y, triangle.position.z),
      quaternion,
      scale,
    );
    for (const v of [triangle.v0, triangle.v1, triangle.v2]) {
      vertex.set(v.x, v.y, v.z).applyMatrix4(matrix);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  }

  if (positions.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    collisionGroup.add(new THREE.Mesh(geometry, solid));
  }

  // маркеры спавнов: синие — синяя команда, красные — красная, жёлтые — DM
  const spawnsGroup = new THREE.Group();
  spawnsGroup.name = 'debug-spawns';
  spawnsGroup.visible = options.spawns;
  debug.add(spawnsGroup);

  const spawnGeometry = new THREE.CylinderGeometry(60, 60, 300, 8);
  for (const spawn of map.spawns) {
    const color = spawn.type === 'blue' ? 0x3b7bd6 : spawn.type === 'red' ? 0xd64b3b : 0xd6c23b;
    const mesh = new THREE.Mesh(spawnGeometry, new THREE.MeshBasicMaterial({ color }));
    mesh.position.set(spawn.position.x, spawn.position.y, spawn.position.z + 150);
    spawnsGroup.add(mesh);
  }

  return {
    boxes: map.boxes.length,
    planes: map.planes.length,
    triangles: map.triangles.length,
    props: 0,
    spawns: map.spawns.length,
  };
}

/** Включает/выключает отладочный слой коллизий и спавнов. */
export function setDebugVisibility(root: THREE.Object3D, kind: 'collisions' | 'spawns', visible: boolean): boolean {
  const wrapper = root.getObjectByName('debug-layer');
  const group = root.getObjectByName(kind === 'collisions' ? 'debug-collisions' : 'debug-spawns');
  if (!group) return false;
  group.visible = visible;
  if (wrapper) wrapper.visible = wrapper.children.some((child) => child.visible);
  return visible;
}

/** Запасные боксы для пропов, которым не нашлось модели в библиотеке */
export function buildProps(map: ClientMap | PropPlacement[], parent: THREE.Object3D): number {
  const props = Array.isArray(map) ? map : map.props;
  const geometry = new THREE.BoxGeometry(250, 250, 150);
  const materials = new Map<string, THREE.Material>();
  const colorFor = (library: string): THREE.Material => {
    let material = materials.get(library);
    if (!material) {
      // стабильный цвет по имени библиотеки — чтобы соседние пропы различались
      let hash = 0;
      for (let i = 0; i < library.length; i += 1) hash = (hash * 31 + library.charCodeAt(i)) | 0;
      const color = new THREE.Color().setHSL(((hash >>> 0) % 360) / 360, 0.35, 0.45);
      material = materialLibrary.create({ color: color.getHex(), roughness: 0.9 });
      makeAmbientShadowReceiver(material);
      makeWetSurface(material);
      materials.set(library, material);
    }
    return material;
  };

  for (const prop of props) {
    const mesh = new THREE.Mesh(geometry, colorFor(prop.library));
    mesh.position.set(prop.position.x, prop.position.y, prop.position.z + 75);
    mesh.rotation.copy(euler(prop.rotation));
    mesh.userData.library = prop.library;
    mesh.userData.propName = prop.name;
    parent.add(mesh);
  }

  return props.length;
}

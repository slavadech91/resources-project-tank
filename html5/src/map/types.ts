// Типы данных карт Tanki 2014. Единицы — сантиметры, ось Z направлена вверх
// (как в оригинале). В Y-up Three.js переводим только в слое отрисовки.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** collision-box из конфига карты сервера */
export interface BoxCollision {
  size: Vec3;
  position: Vec3;
  rotation: Vec3;
}

/** collision-plane: прямоугольник в плоскости XY до поворота */
export interface PlaneCollision {
  width: number;
  length: number;
  position: Vec3;
  rotation: Vec3;
}

/** collision-triangle: три локальные вершины + позиция/поворот */
export interface TriangleCollision {
  v0: Vec3;
  v1: Vec3;
  v2: Vec3;
  position: Vec3;
  rotation: Vec3;
}

export interface SpawnPoint {
  type: string;
  position: Vec3;
  rotation: Vec3;
}

/** bonus-region: бокс, в котором падают ящики, точка метки (position или центр низа бокса), режимы и типы бонусов */
export interface BonusRegion {
  position: Vec3;
  rotation: Vec3;
  min: Vec3;
  max: Vec3;
  gameModes: string[];
  bonusTypes: string[];
}

/** Геометрия и точки из dev/configs/maps/map_<map>.xml */
export interface ServerMap {
  boxes: BoxCollision[];
  planes: PlaneCollision[];
  triangles: TriangleCollision[];
  spawns: SpawnPoint[];
  bonusRegions: BonusRegion[];
}

/** Один проп в клиентском map.xml */
export interface PropPlacement {
  library: string;
  group: string;
  name: string;
  texture: string | null;
  position: Vec3;
  rotation: Vec3;
}

/** Расстановка пропов из battle_lazy/maps/<Map>/<ver>/map.xml */
export interface ClientMap {
  props: PropPlacement[];
}

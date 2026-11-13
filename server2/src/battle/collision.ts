/**
 * Статика карты для серверных лучей: тот же разбор collision-box/plane/triangle из XML и тот же
 * TanksCollisionDetector (kd-дерево), что у клиента — код физики общий, без THREE. Нужна минам
 * (BattleMinesGlobalModel.calculate_mine_position — луч вниз) и проверке движения танка сквозь стены.
 */
import type { BoxCollision, PlaneCollision, ServerMap, TriangleCollision, Vec3 } from '../../../html5/src/map/types.ts';
import { parseCollisionGeometry } from '../../../html5/src/tanks/map/CollisionGeometryParser.ts';
import { TanksCollisionDetector } from '../../../html5/src/tanks/physics/TanksCollisionDetector.ts';
import { logError } from '../log.ts';

function axis(block: string, name: string): number {
  return Number(new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1] ?? 0) || 0;
}

function vector(block: string, tag: string): Vec3 {
  const inner = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? '';
  return { x: axis(inner, 'x'), y: axis(inner, 'y'), z: axis(inner, 'z') };
}

function number(block: string, tag: string): number {
  return Number(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1] ?? 0) || 0;
}

/** геометрия столкновений карты как его разбирает клиент (html5/src/map/loaders.ts) */
export function parseCollisionXml(xml: string): Pick<ServerMap, 'boxes' | 'planes' | 'triangles'> {
  const boxes: BoxCollision[] = [];
  for (const match of xml.matchAll(/<collision-box\b[^>]*>([\s\S]*?)<\/collision-box>/g)) {
    const block = match[1];
    boxes.push({ size: vector(block, 'size'), position: vector(block, 'position'), rotation: vector(block, 'rotation') });
  }
  const planes: PlaneCollision[] = [];
  for (const match of xml.matchAll(/<collision-plane\b[^>]*>([\s\S]*?)<\/collision-plane>/g)) {
    const block = match[1];
    planes.push({ width: number(block, 'width'), length: number(block, 'length'), position: vector(block, 'position'), rotation: vector(block, 'rotation') });
  }
  const triangles: TriangleCollision[] = [];
  for (const match of xml.matchAll(/<collision-triangle\b[^>]*>([\s\S]*?)<\/collision-triangle>/g)) {
    const block = match[1];
    triangles.push({ v0: vector(block, 'v0'), v1: vector(block, 'v1'), v2: vector(block, 'v2'), position: vector(block, 'position'), rotation: vector(block, 'rotation') });
  }
  return { boxes, planes, triangles };
}

/** детектор статики карты; null — в карте нет геометрии столкновений (лучи не работают) */
export function buildCollisionDetector(xml: string): TanksCollisionDetector | null {
  const geometry = parseCollisionXml(xml);
  const total = geometry.boxes.length + geometry.planes.length + geometry.triangles.length;
  if (!total) return null;
  try {
    const shapes = parseCollisionGeometry({ ...geometry, spawns: [], bonusRegions: [] } as ServerMap);
    const detector = new TanksCollisionDetector();
    detector.buildKdTree(shapes);
    return detector;
  } catch (error) {
    logError('battle', `геометрия столкновений не разобрана: ${(error as Error).message}`);
    return null;
  }
}

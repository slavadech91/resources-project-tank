// 1:1 из alternativa/tanks/models/battle/battlefield/map/CollisionGeometryParser.as
// XML уже разобран в ServerMap (map/loaders.ts); порядок фигур как в оригинале: плоскости, боксы, треугольники.
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { CollisionBox, CollisionRect, CollisionTriangle, type CollisionShape } from '../../physics/collision/CollisionShape.ts';
import { PhysicsMaterial } from '../../physics/collision/types.ts';
import type { ServerMap, Vec3 } from '../../map/types.ts';

const MATERIAL = new PhysicsMaterial(0, 1); // §7!#§
const COLLISION_GROUP = 255; // §5!^§
const halfSize = new Vector3(); // §`!0§
const position = new Vector3(); // §2J§
const rotation = new Vector3(); // §[!7§
const orientation = new Matrix3(); // §]"X§

function setOrientation(shape: CollisionShape, pos: Vec3, rot: Vec3): void {
  position.reset(pos.x, pos.y, pos.z);
  rotation.reset(rot.x, rot.y, rot.z);
  orientation.setRotationMatrix(rotation.x, rotation.y, rotation.z);
  shape.transform.setFromMatrix3(orientation, position);
}

export function parseCollisionGeometry(map: ServerMap): CollisionShape[] {
  const result: CollisionShape[] = [];
  for (const plane of map.planes) {
    halfSize.x = 0.5 * plane.width;
    halfSize.y = 0.5 * plane.length;
    halfSize.z = 0;
    const shape = new CollisionRect(halfSize, COLLISION_GROUP, MATERIAL);
    setOrientation(shape, plane.position, plane.rotation);
    result.push(shape);
  }
  for (const box of map.boxes) {
    halfSize.reset(box.size.x, box.size.y, box.size.z);
    halfSize.scale(0.5);
    const shape = new CollisionBox(halfSize, COLLISION_GROUP, MATERIAL);
    setOrientation(shape, box.position, box.rotation);
    result.push(shape);
  }
  const v0 = new Vector3();
  const v1 = new Vector3();
  const v2 = new Vector3();
  for (const triangle of map.triangles) {
    v0.reset(triangle.v0.x, triangle.v0.y, triangle.v0.z);
    v1.reset(triangle.v1.x, triangle.v1.y, triangle.v1.z);
    v2.reset(triangle.v2.x, triangle.v2.y, triangle.v2.z);
    const shape = new CollisionTriangle(v0, v1, v2, COLLISION_GROUP, MATERIAL);
    setOrientation(shape, triangle.position, triangle.rotation);
    result.push(shape);
  }
  return result;
}

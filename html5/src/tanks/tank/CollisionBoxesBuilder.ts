// 1:1 из alternativa/tanks/battle/objects/tank/CollisionBoxesBuilder.as
import { Matrix4 } from '../../physics/math/Matrix4.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { CollisionBox } from '../../physics/collision/CollisionShape.ts';
import { PhysicsMaterial } from '../../physics/collision/types.ts';
import { CollisionGroup, type TankBody } from '../physics/TankBody.ts';
import { numbersEqual } from '../utils/MathUtils.ts';

const TOP_MATERIAL = new PhysicsMaterial(0, 1); // §0"G§
const BODY_MATERIAL = new PhysicsMaterial(0, 0.2); // §5"2§

/**
 * Фигуры для столкновений со статикой: два наклонных бокса спереди и сзади (скос «носа» и «кормы»),
 * нижний и верхний боксы. halfSize — половины габаритов корпуса, height — высота коробки над подвеской.
 */
export function createStaticCollisionBoxes(halfSize: Vector3, height: number, tankBody: TankBody): void {
  const h = height - 10;
  const halfLength = halfSize.y;
  const halfHeight = h / 2;
  const k = 0.82;
  let c = 1 - ((1 - k) * (1 - k) * halfLength * halfLength) / (halfHeight * halfHeight);
  if (c > 0) c = Math.sqrt(c);
  else c = 1 - ((1 - k) * halfLength) / halfHeight;
  const slope = ((k - 1) * halfLength) / ((1 + c) * halfHeight);
  const offset = c * halfHeight - slope * halfLength;
  const tan = ((1 - k) * halfLength) / ((1 + c) * halfHeight);
  const limit = ((1 - c) * halfHeight) / ((1 - k) * halfLength);
  let y: number;
  let z: number;
  if (numbersEqual(tan, limit, 0.00001) || tan < limit) {
    y = k * halfLength;
    z = slope * y + offset;
  } else {
    y = ((1 - c) * halfHeight) / slope + halfLength;
    z = halfHeight;
  }
  let dz = z - c * halfHeight;
  let dy = halfLength - y;
  const boxHalfY = Math.sqrt(dz * dz + dy * dy) / 2;
  dz = (1 + c) * halfHeight;
  dy = (1 - k) * halfLength;
  const boxHalfZ = Math.sqrt(dz * dz + dy * dy) / 2;
  let box = new CollisionBox(new Vector3(halfSize.x, boxHalfY, boxHalfZ), CollisionGroup.STATIC, BODY_MATERIAL);
  const transform = new Matrix4();
  const angle = Math.atan(tan);
  transform.setRotationMatrix(-angle, 0, 0);
  const posY = k * halfLength + boxHalfZ * Math.sin(angle) - boxHalfY * Math.cos(angle);
  const posZ = -halfHeight + boxHalfZ * Math.cos(angle) + boxHalfY * Math.sin(angle) - (halfSize.z - h / 2);
  transform.setPosition(new Vector3(0, posY, posZ));
  tankBody.body.addCollisionShape(box, transform);
  tankBody.staticCollisionShapes.push(box);
  box = new CollisionBox(new Vector3(halfSize.x, boxHalfY, boxHalfZ), CollisionGroup.STATIC, BODY_MATERIAL);
  transform.setRotationMatrix(angle, 0, 0);
  transform.setPosition(new Vector3(0, -posY, posZ));
  tankBody.body.addCollisionShape(box, transform);
  tankBody.staticCollisionShapes.push(box);
  const lowerHeight = (height * 3) / 4;
  const lowerHalfSize = new Vector3(halfSize.x, halfSize.y * k, lowerHeight / 2);
  const lowerTransform = new Matrix4();
  lowerTransform.l = lowerHalfSize.z - halfSize.z;
  const lowerBox = new CollisionBox(lowerHalfSize, CollisionGroup.STATIC, BODY_MATERIAL);
  tankBody.body.addCollisionShape(lowerBox, lowerTransform);
  tankBody.staticCollisionShapes.push(lowerBox);
  const upperHeight = (height * 3) / 4;
  const upperHalfSize = new Vector3(halfSize.x, halfSize.y * k, upperHeight / 2);
  const upperTransform = new Matrix4();
  upperTransform.l = height - upperHalfSize.z - halfSize.z;
  const upperBox = new CollisionBox(upperHalfSize, CollisionGroup.STATIC, TOP_MATERIAL);
  tankBody.body.addCollisionShape(upperBox, upperTransform);
  tankBody.staticCollisionShapes.push(upperBox);
}

export function createTankCollisionBox(halfSize: Vector3, height: number, tankBody: TankBody): void {
  const boxHalfSize = new Vector3(halfSize.x, halfSize.y, height / 2);
  const box = new CollisionBox(boxHalfSize, 0, BODY_MATERIAL);
  const transform = new Matrix4();
  transform.l = height / 2 - halfSize.z;
  tankBody.body.addCollisionShape(box, transform);
  tankBody.tankCollisionBox = box;
}

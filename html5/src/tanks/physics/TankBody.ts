// 1:1 из alternativa/tanks/physics/{TankBody,CollisionGroup}.as
// Полёт (SoaringChecker), подлёт и учёт контактов — из клиента 2019 (Narukami, alternativa/tanks/physics).
import type { Body } from '../../physics/Body.ts';
import { CollisionBox, type CollisionShape } from '../../physics/collision/CollisionShape.ts';
import { PhysicsMaterial } from '../../physics/collision/types.ts';
import type { ShapeContact } from '../../physics/Contacts.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';

export const CollisionGroup = {
  TANK: 1, // §;$§
  ACTIVE_TRACK: 2, // §#!f§
  INACTIVE_TRACK: 4, // §]!>§
  WEAPON: 8, // §;"J§
  STATIC: 16, // §4">§
  BONUS_WITH_TANK: 64, // §"!Q§
} as const;

/** cos(60°) — круче этого поверхность не считается опорой (TankConst.MAX_SLOPE_ANGLE_COS, 2019) */
export const MAX_SLOPE_ANGLE_COS = Math.cos(Math.PI / 3);

/** Источник контактов со статикой для проверки полёта (TanksCollisionDetector) */
export interface StaticContactSource {
  getShapeContactsWithStatic(shape: CollisionShape, result: ShapeContact[]): void;
}

const HALF_WHEEL_SIZE = 12.5;
const soaringContacts: ShapeContact[] = [];

/**
 * SoaringChecker клиента 2019: коробка танка, опущенная на половину колеса; если под ней нет
 * поверхности положе 60°, танк «парит».
 */
class SoaringChecker {
  private readonly tankBody: TankBody;
  private readonly testBox: CollisionBox;
  private wasSoaring = false;
  private soaring = false;
  private staticIsNear = false;

  constructor(tankBody: TankBody) {
    this.tankBody = tankBody;
    const halfSize = tankBody.tankCollisionBox.hs.clone();
    halfSize.z += HALF_WHEEL_SIZE;
    this.testBox = new CollisionBox(halfSize, -1, PhysicsMaterial.DEFAULT);
    this.testBox.body = tankBody.body;
  }

  update(detector: StaticContactSource): void {
    this.wasSoaring = this.soaring;
    const t = this.testBox.transform;
    t.copy(this.tankBody.tankCollisionBox.transform);
    t.d -= t.c * HALF_WHEEL_SIZE;
    t.h -= t.g * HALF_WHEEL_SIZE;
    t.l -= t.k * HALF_WHEEL_SIZE;
    this.testBox.calculateAABB();
    detector.getShapeContactsWithStatic(this.testBox, soaringContacts);
    let maxCos = 0;
    for (const contact of soaringContacts) {
      // нормаль направлена от shape1 к shape2
      const cos = contact.shape1 == this.testBox ? contact.normal.z : -contact.normal.z;
      maxCos = Math.max(maxCos, cos);
      contact.dispose();
    }
    this.staticIsNear = soaringContacts.length > 0;
    soaringContacts.length = 0;
    this.soaring = maxCos < MAX_SLOPE_ANGLE_COS;
  }

  isSoaring(): boolean {
    return this.soaring;
  }

  isJumpBegin(): boolean {
    return this.soaring && !this.wasSoaring;
  }

  isJumpEnd(): boolean {
    return this.wasSoaring && !this.soaring;
  }

  isElasticStaticCollisionWhenSoaring(): boolean {
    return this.soaring && this.staticIsNear;
  }
}

export class TankBody {
  id = 0; // §5!=§
  body: Body; // §7b§
  /** §]U§ — коробка для столкновений танк-танк */
  tankCollisionBox: CollisionBox = null as unknown as CollisionBox;
  /** §8![§ — фигуры для столкновений со статикой */
  staticCollisionShapes: CollisionShape[] = [];
  /** контакт со статикой корпусом или гусеницами (как hasContactsWithStatic 2019) */
  hasStaticContacts = false; // §8"=§
  hasTankContacts = false; // §6z§
  /** значение hasStaticContacts на прошлом шаге */
  wasStaticContacts = false;
  /** сумма внешних сил за шаг (попадания) — подлёт от них не ограничивается */
  readonly additionForcesSum = new Vector3();
  previousUpVelocity = 0;
  private soaringChecker: SoaringChecker | null = null;

  constructor(body: Body) {
    this.body = body;
  }

  /** вызывается, когда коробки столкновений уже созданы */
  onTankInited(): void {
    this.soaringChecker = new SoaringChecker(this);
  }

  updateSoaring(detector: StaticContactSource): void {
    this.soaringChecker?.update(detector);
  }

  isSoaring(): boolean {
    return this.soaringChecker?.isSoaring() ?? false;
  }

  isJumpBegin(): boolean {
    return this.soaringChecker?.isJumpBegin() ?? false;
  }

  isJumpEnd(): boolean {
    return this.soaringChecker?.isJumpEnd() ?? false;
  }

  isElasticStaticCollisionWhenSoaring(): boolean {
    return this.soaringChecker?.isElasticStaticCollisionWhenSoaring() ?? false;
  }
}

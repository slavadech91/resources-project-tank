// 1:1 из alternativa/physics/collision/colliders/BoxSphereCollider.as
import { Vector3 } from '../../math/Vector3.ts';
import { type Collider, ShapeContact } from '../../Contacts.ts';
import { CollisionSphere, type CollisionBox, type CollisionShape } from '../CollisionShape.ts';

export class BoxSphereCollider implements Collider {
  private readonly sphereLocal = new Vector3(); // §=A§ — центр сферы в координатах бокса
  private readonly closest = new Vector3(); // §>P§
  private readonly boxPosition = new Vector3(); // §8!w§
  private readonly spherePosition = new Vector3(); // §;>§

  getContacts(shape1: CollisionShape, shape2: CollisionShape, result: ShapeContact[]): void {
    let sphere: CollisionSphere;
    let box: CollisionBox;
    if (shape1 instanceof CollisionSphere) {
      sphere = shape1;
      box = shape2 as CollisionBox;
    } else {
      sphere = shape2 as CollisionSphere;
      box = shape1 as CollisionBox;
    }
    sphere.transform.getAxis(3, this.spherePosition);
    const tb = box.transform;
    tb.getAxis(3, this.boxPosition);
    tb.transformVectorInverse(this.spherePosition, this.sphereLocal);
    const hs = box.hs;
    const rx = hs.x + sphere.r;
    const ry = hs.y + sphere.r;
    const rz = hs.z + sphere.r;
    const s = this.sphereLocal;
    if (s.x > rx || s.x < -rx || s.y > ry || s.y < -ry || s.z > rz || s.z < -rz) return;
    this.clampToBox(hs);
    const distanceSqr = s.subtract(this.closest).lengthSqr();
    if (distanceSqr > sphere.r * sphere.r) return;
    const contact = ShapeContact.create();
    contact.shape1 = sphere;
    contact.shape2 = box;
    contact.normal.copy(this.closest).transform4(tb).subtract(this.spherePosition).normalize().reverse();
    contact.penetration = sphere.r - Math.sqrt(distanceSqr);
    contact.position.copy(contact.normal).scale(-sphere.r).add(this.spherePosition);
    result[result.length] = contact;
  }

  haveCollision(shape1: CollisionShape, shape2: CollisionShape): boolean {
    let sphere: CollisionSphere;
    let box: CollisionBox;
    if (shape1 instanceof CollisionSphere) {
      sphere = shape1;
      box = shape2 as CollisionBox;
    } else {
      sphere = shape2 as CollisionSphere;
      box = shape1 as CollisionBox;
    }
    sphere.transform.getAxis(3, this.spherePosition);
    const tb = box.transform;
    tb.getAxis(3, this.boxPosition);
    tb.transformVectorInverse(this.spherePosition, this.sphereLocal);
    const hs = box.hs;
    const rx = hs.x + sphere.r;
    const ry = hs.y + sphere.r;
    const rz = hs.z + sphere.r;
    const s = this.sphereLocal;
    if (s.x > rx || s.x < -rx || s.y > ry || s.y < -ry || s.z > rz || s.z < -rz) return false;
    this.clampToBox(hs);
    const distanceSqr = s.subtract(this.closest).lengthSqr();
    return distanceSqr <= sphere.r * sphere.r;
  }

  private clampToBox(hs: Vector3): void {
    const s = this.sphereLocal;
    const c = this.closest;
    if (s.x > hs.x) c.x = hs.x;
    else if (s.x < -hs.x) c.x = -hs.x;
    else c.x = s.x;
    if (s.y > hs.y) c.y = hs.y;
    else if (s.y < -hs.y) c.y = -hs.y;
    else c.y = s.y;
    if (s.z > hs.z) c.z = hs.z;
    else if (s.z < -hs.z) c.z = -hs.z;
    else c.z = s.z;
  }
}

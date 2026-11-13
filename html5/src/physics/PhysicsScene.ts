// 1:1 из alternativa/physics/{PhysicsScene,QuickUnionFind}.as и contactislands/{ContactIsland,ContactLevels,IslandsGenerator}.as
import { Vector3 } from './math/Vector3.ts';
import type { Body } from './Body.ts';
import { type BodyContact, type CollisionDetector, type ShapeContact } from './Contacts.ts';

export class QuickUnionFind {
  private parent: number[] = [0]; // §["!§
  private size: number[] = [0]; // §+!3§

  init(count: number): void {
    this.parent.length = count;
    this.size.length = count;
    for (let n = 0; n < count; n++) {
      this.parent[n] = n;
      this.size[n] = 1;
    }
  }

  union(a: number, b: number): void {
    if (!this.connected(a, b)) {
      const rootA = this.root(a);
      const rootB = this.root(b);
      const sizeA = this.size[rootA];
      const sizeB = this.size[rootB];
      if (sizeA > sizeB) {
        this.parent[rootB] = rootA;
        this.size[rootA] += sizeB;
      } else {
        this.parent[rootA] = rootB;
        this.size[rootB] += sizeA;
      }
    }
  }

  connected(a: number, b: number): boolean {
    return this.root(a) == this.root(b);
  }

  root(index: number): number {
    let n = index;
    while (this.parent[n] != n) n = this.parent[n];
    return n;
  }
}

const COLLISION_PHASE = 0; // §;!4§
const CONTACT_PHASE = 1; // §9!A§

export class ContactLevels {
  private contacts: BodyContact[] = []; // §#!t§

  init(contacts: BodyContact[]): void {
    const count = contacts.length;
    this.contacts.length = count;
    for (let n = 0; n < count; n++) this.contacts[n] = contacts[n];
  }

  clear(): void {
    this.contacts.length = 0;
  }

  getStaticLevel(levelContacts: BodyContact[], levelBodies: Body[]): void {
    let n = 0;
    while (n < this.contacts.length) {
      const contact = this.contacts[n];
      if (this.isStaticContact(contact)) {
        levelContacts[levelContacts.length] = contact;
        levelBodies[levelBodies.length] = this.getNonStaticBody(contact);
        this.removeContact(n);
        n--;
      }
      n++;
    }
    n = 0;
    while (n < this.contacts.length) {
      const contact = this.contacts[n];
      if (levelBodies.indexOf(contact.body1) >= 0 && levelBodies.indexOf(contact.body2) >= 0) {
        levelContacts[levelContacts.length] = contact;
        this.removeContact(n);
        n--;
      }
      n++;
    }
  }

  private isStaticContact(contact: BodyContact): boolean {
    return !(contact.body1.movable && contact.body2.movable);
  }

  private getNonStaticBody(contact: BodyContact): Body {
    if (contact.body1.movable) return contact.body1;
    return contact.body2;
  }

  private removeContact(index: number): void {
    const last = this.contacts.length - 1;
    this.contacts[index] = this.contacts[last];
    this.contacts.length = last;
  }

  getNextLevel(prevBodies: Body[], levelContacts: BodyContact[], levelBodies: Body[]): void {
    let n = 0;
    while (n < this.contacts.length) {
      const contact = this.contacts[n];
      if (this.isInContactWith(prevBodies, contact)) {
        levelContacts[levelContacts.length] = contact;
        levelBodies[levelBodies.length] = this.getNextLevelBody(contact, prevBodies);
        this.removeContact(n);
        n--;
      }
      n++;
    }
    n = 0;
    while (n < this.contacts.length) {
      const contact = this.contacts[n];
      if (levelBodies.indexOf(contact.body1) >= 0 && levelBodies.indexOf(contact.body2) >= 0) {
        levelContacts[levelContacts.length] = contact;
        this.removeContact(n);
        n--;
      }
      n++;
    }
  }

  private isInContactWith(bodies: Body[], contact: BodyContact): boolean {
    return bodies.indexOf(contact.body1) >= 0 || bodies.indexOf(contact.body2) >= 0;
  }

  private getNextLevelBody(contact: BodyContact, bodies: Body[]): Body {
    if (bodies.indexOf(contact.body1) < 0) return contact.body1;
    return contact.body2;
  }

  hasContacts(): boolean {
    return this.contacts.length > 0;
  }
}

export class ContactIsland {
  private static poolSize = 0;
  private static readonly pool: (ContactIsland | null)[] = [];
  private static readonly tmp = new Vector3(); // §4!i§

  readonly bodyContacts: BodyContact[] = []; // §["T§
  private scene: PhysicsScene | null = null; // §8]§
  private readonly contacts: ShapeContact[] = []; // §#!6§
  private readonly levelContacts: ShapeContact[] = []; // §;d§
  private prevLevelBodies: Body[] = []; // §?j§
  private levelBodies: Body[] = []; // §4!M§
  private readonly levelBodyContacts: BodyContact[] = []; // §?!r§
  private readonly levels = new ContactLevels(); // §@_§

  static create(): ContactIsland {
    if (ContactIsland.poolSize == 0) return new ContactIsland();
    --ContactIsland.poolSize;
    const island = ContactIsland.pool[ContactIsland.poolSize] as ContactIsland;
    ContactIsland.pool[ContactIsland.poolSize] = null;
    return island;
  }

  dispose(): void {
    this.scene = null;
    this.bodyContacts.length = 0;
    this.contacts.length = 0;
    this.levelContacts.length = 0;
    this.prevLevelBodies.length = 0;
    this.levelBodies.length = 0;
    this.levelBodyContacts.length = 0;
    this.levels.clear();
    ContactIsland.pool[ContactIsland.poolSize++] = this;
  }

  init(scene: PhysicsScene): void {
    this.scene = scene;
    const count = this.bodyContacts.length;
    const result = this.contacts;
    for (let n = 0; n < count; n++) {
      const shapeContacts = this.bodyContacts[n].shapeContacts;
      const shapeCount = shapeContacts.length;
      for (let m = 0; m < shapeCount; m++) result[result.length] = shapeContacts[m];
    }
  }

  collisionPhase(iterations: number): void {
    this.resolveCollisions(iterations);
  }

  contactPhase(iterations: number): void {
    this.resolveContacts(iterations);
  }

  private resolveCollisions(iterations: number): void {
    const count = this.contacts.length;
    for (let i = 0; i < iterations; i++) {
      this.shuffleContacts(this.contacts);
      for (let n = 0; n < count; n++) this.resolveContact(this.contacts[n], COLLISION_PHASE);
    }
  }

  private resolveContacts(iterations: number): void {
    const scene = this.scene as PhysicsScene;
    this.processContacts(iterations);
    this.levels.init(this.bodyContacts);
    this.levels.getStaticLevel(this.levelBodyContacts, this.levelBodies);
    if (this.levelBodyContacts.length > 0) {
      this.getShapeContacts(this.levelBodyContacts, this.levelContacts);
      this.resolveContactsForLevel(iterations, this.levelContacts);
      this.calculatePseudoVelocities(iterations, this.levelContacts);
      while (this.levels.hasContacts()) {
        const swap = this.prevLevelBodies;
        this.prevLevelBodies = this.levelBodies;
        this.levelBodies = swap;
        this.levelBodyContacts.length = 0;
        this.levelBodies.length = 0;
        this.levels.getNextLevel(this.prevLevelBodies, this.levelBodyContacts, this.levelBodies);
        this.setBodiesMobility(this.prevLevelBodies, false);
        this.levelContacts.length = 0;
        this.getShapeContacts(this.levelBodyContacts, this.levelContacts);
        const count = this.levelContacts.length;
        for (let n = 0; n < count; n++) {
          this.levelContacts[n].calculateDynamicFrameData(scene.allowedPenetration, scene.penetrationSpeed, scene.maxPenetrationCorrection, scene.dt);
        }
        this.resolveContactsForLevel(iterations, this.levelContacts);
        this.calculatePseudoVelocities(iterations, this.levelContacts);
        this.setBodiesMobility(this.prevLevelBodies, true);
      }
    } else {
      this.getShapeContacts(this.bodyContacts, this.levelContacts);
      this.resolveContactsForLevel(iterations, this.levelContacts);
      this.calculatePseudoVelocities(iterations, this.levelContacts);
    }
  }

  private processContacts(iterations: number): void {
    const count = this.contacts.length;
    for (let i = 0; i < iterations; i++) {
      this.shuffleContacts(this.contacts);
      for (let n = 0; n < count; n++) this.resolveContact(this.contacts[n], CONTACT_PHASE);
    }
  }

  private getShapeContacts(bodyContacts: BodyContact[], result: ShapeContact[]): void {
    const count = bodyContacts.length;
    for (let n = 0; n < count; n++) {
      const shapeContacts = bodyContacts[n].shapeContacts;
      const shapeCount = shapeContacts.length;
      for (let m = 0; m < shapeCount; m++) result[result.length] = shapeContacts[m];
    }
  }

  private shuffleContacts(contacts: ShapeContact[]): void {
    const count = contacts.length;
    for (let n = 1; n < count; n++) {
      const index = (n * Math.random()) | 0;
      const contact = contacts[index];
      contacts[index] = contacts[n];
      contacts[n] = contact;
    }
  }

  private resolveContactsForLevel(iterations: number, contacts: ShapeContact[]): void {
    for (let i = 0; i < iterations; i++) {
      this.shuffleContacts(contacts);
      const count = contacts.length;
      for (let n = 0; n < count; n++) this.resolveContact(contacts[n], CONTACT_PHASE);
    }
  }

  private calculatePseudoVelocities(iterations: number, contacts: ShapeContact[]): void {
    for (let i = 0; i < iterations; i++) {
      this.shuffleContacts(contacts);
      const count = contacts.length;
      for (let n = 0; n < count; n++) this.resolveContactPseudoVelocity(contacts[n]);
    }
  }

  private setBodiesMobility(bodies: Body[], movable: boolean): void {
    const count = bodies.length;
    for (let n = 0; n < count; n++) bodies[n].movable = movable && !bodies[n].kinematic;
  }

  private resolveContact(contact: ShapeContact, phase: number): void {
    let targetVelocity: number;
    const normal = contact.normal;
    const body1 = contact.shape1.body as Body;
    const body2 = contact.shape2.body as Body;
    const relativeVelocity = ContactIsland.tmp;
    this.calculateRelativeVelocity(contact, relativeVelocity);
    let normalVelocity = relativeVelocity.x * normal.x + relativeVelocity.y * normal.y + relativeVelocity.z * normal.z;
    if (phase == CONTACT_PHASE) {
      targetVelocity = 0;
      if (normalVelocity < 0) {
        contact.satisfied = false;
      } else if (contact.satisfied) {
        return;
      }
    } else {
      contact.satisfied = true;
      targetVelocity = contact.restitutionVelocity;
    }
    const tangentVelocity1 = relativeVelocity.dot(contact.tangent1);
    const tangentVelocity2 = relativeVelocity.dot(contact.tangent2);
    let impulse1 = contact.accumulatedTangent1Impulse - tangentVelocity1 / contact.tangent1Denominator;
    let impulse2 = contact.accumulatedTangent2Impulse - tangentVelocity2 / contact.tangent2Denominator;
    const impulseSqr = impulse1 * impulse1 + impulse2 * impulse2;
    const maxFriction = contact.friction * contact.accumulatedNormalImpulse;
    if (impulseSqr > maxFriction * maxFriction) {
      const impulseLength = Math.sqrt(impulseSqr);
      impulse1 *= maxFriction / impulseLength;
      impulse2 *= maxFriction / impulseLength;
    }
    const delta1 = impulse1 - contact.accumulatedTangent1Impulse;
    const delta2 = impulse2 - contact.accumulatedTangent2Impulse;
    contact.accumulatedTangent1Impulse = impulse1;
    contact.accumulatedTangent2Impulse = impulse2;
    if (body1.movable) {
      body1.applyWorldImpulseAtLocalPoint(contact.r1, contact.tangent1, delta1);
      body1.applyWorldImpulseAtLocalPoint(contact.r1, contact.tangent2, delta2);
    }
    if (body2.movable) {
      body2.applyWorldImpulseAtLocalPoint(contact.r2, contact.tangent1, -delta1);
      body2.applyWorldImpulseAtLocalPoint(contact.r2, contact.tangent2, -delta2);
    }
    this.calculateRelativeVelocity(contact, relativeVelocity);
    normalVelocity = relativeVelocity.x * normal.x + relativeVelocity.y * normal.y + relativeVelocity.z * normal.z;
    const velocityDelta = targetVelocity - normalVelocity;
    let normalImpulse = contact.accumulatedNormalImpulse + velocityDelta / contact.normalDenominator;
    if (normalImpulse < 0) normalImpulse = 0;
    const normalDelta = normalImpulse - contact.accumulatedNormalImpulse;
    contact.accumulatedNormalImpulse = normalImpulse;
    if (body1.movable) body1.applyWorldImpulseAtLocalPoint(contact.r1, contact.normal, normalDelta);
    if (body2.movable) body2.applyWorldImpulseAtLocalPoint(contact.r2, contact.normal, -normalDelta);
  }

  private calculateRelativeVelocity(contact: ShapeContact, result: Vector3): void {
    const body1 = contact.shape1.body as Body;
    const body2 = contact.shape2.body as Body;
    let w = body1.state.rotation;
    let r = contact.r1;
    let x = w.y * r.z - w.z * r.y;
    let y = w.z * r.x - w.x * r.z;
    let z = w.x * r.y - w.y * r.x;
    let v = body1.state.velocity;
    result.x = v.x + x;
    result.y = v.y + y;
    result.z = v.z + z;
    w = body2.state.rotation;
    r = contact.r2;
    x = w.y * r.z - w.z * r.y;
    y = w.z * r.x - w.x * r.z;
    z = w.x * r.y - w.y * r.x;
    v = body2.state.velocity;
    result.x -= v.x + x;
    result.y -= v.y + y;
    result.z -= v.z + z;
  }

  private resolveContactPseudoVelocity(contact: ShapeContact): void {
    const relativeVelocity = ContactIsland.tmp;
    this.calculateRelativePseudoVelocity(contact, relativeVelocity);
    const normalVelocity =
      relativeVelocity.x * contact.normal.x + relativeVelocity.y * contact.normal.y + relativeVelocity.z * contact.normal.z;
    const velocityDelta = contact.penetrationVelocity - normalVelocity;
    const impulse = velocityDelta / contact.normalDenominator;
    const body1 = contact.shape1.body as Body;
    const body2 = contact.shape2.body as Body;
    if (body1.movable) body1.applyWorldPseudoImpulseAtLocalPoint(contact.r1, contact.normal, impulse);
    if (body2.movable) body2.applyWorldPseudoImpulseAtLocalPoint(contact.r2, contact.normal, -impulse);
  }

  /** § n§ */
  private calculateRelativePseudoVelocity(contact: ShapeContact, result: Vector3): void {
    const body1 = contact.shape1.body as Body;
    const body2 = contact.shape2.body as Body;
    let w = body1.pseudoRotation;
    let r = contact.r1;
    let x = w.y * r.z - w.z * r.y;
    let y = w.z * r.x - w.x * r.z;
    let z = w.x * r.y - w.y * r.x;
    let v = body1.pseudoVelocity;
    result.x = v.x + x;
    result.y = v.y + y;
    result.z = v.z + z;
    w = body2.pseudoRotation;
    r = contact.r2;
    x = w.y * r.z - w.z * r.y;
    y = w.z * r.x - w.x * r.z;
    z = w.x * r.y - w.y * r.x;
    v = body2.pseudoVelocity;
    result.x -= v.x + x;
    result.y -= v.y + y;
    result.z -= v.z + z;
  }
}

export class IslandsGenerator {
  readonly islands: ContactIsland[] = []; // §&!>§
  private readonly islandByRoot = new Map<number, ContactIsland>(); // §=!b§
  private readonly unionFind = new QuickUnionFind(); // §+!f§
  private readonly scene: PhysicsScene; // §8]§

  constructor(scene: PhysicsScene) {
    this.scene = scene;
  }

  generate(contacts: BodyContact[], bodyCount: number): void {
    this.createUnions(contacts, bodyCount);
    this.createIslands(contacts);
  }

  private createUnions(contacts: BodyContact[], bodyCount: number): void {
    this.unionFind.init(bodyCount);
    const count = contacts.length;
    for (let n = 0; n < count; n++) {
      const contact = contacts[n];
      if (contact.body1.movable && contact.body2.movable) this.unionFind.union(contact.body1.id, contact.body2.id);
    }
  }

  private createIslands(contacts: BodyContact[]): void {
    const count = contacts.length;
    for (let n = 0; n < count; n++) {
      const contact = contacts[n];
      const root = contact.body1.movable ? this.unionFind.root(contact.body1.id) : this.unionFind.root(contact.body2.id);
      let island = this.islandByRoot.get(root);
      if (island == null) {
        island = ContactIsland.create();
        this.islands[this.islands.length] = island;
        this.islandByRoot.set(root, island);
      }
      island.bodyContacts[island.bodyContacts.length] = contact;
    }
    const islandCount = this.islands.length;
    for (let n = 0; n < islandCount; n++) this.islands[n].init(this.scene);
    this.islandByRoot.clear();
  }

  clear(): void {
    const count = this.islands.length;
    for (let n = 0; n < count; n++) this.islands[n].dispose();
    this.islands.length = 0;
  }
}

export class PhysicsScene {
  private static readonly TIME_SCALE = 1000; // §1!e§ (EncryptedInt)

  penetrationSpeed = 0.7; // §1!s§
  maxPenetrationCorrection = 10; // §`!g§
  allowedPenetration = 0.01; // §[!x§
  collisionIterations = 4; // § 7§
  contactIterations = 4; // §7!u§
  freezeSteps = 10; // §`!X§
  linSpeedFreezeLimit = 5; // §["L§
  angSpeedFreezeLimit = 0.05; // §1!4§
  readonly gravity = new Vector3(0, 0, -9.8); // § l§
  collisionDetector: CollisionDetector = null as unknown as CollisionDetector; // §,"+§
  bodies: Body[] = []; // §=<§
  frame = 0; // §6=§
  time = 0; // §4x§
  dt = 0; // §`n§
  private readonly bodyContacts: BodyContact[] = []; // §["T§
  private readonly islandsGenerator: IslandsGenerator; // §5!1§

  constructor() {
    this.islandsGenerator = new IslandsGenerator(this);
  }

  addBody(body: Body): void {
    body.scene = this;
    body.id = this.bodies.length;
    this.bodies.push(body);
  }

  removeBody(body: Body): void {
    const index = this.bodies.indexOf(body);
    if (index > -1) {
      const last = this.bodies.length - 1;
      const lastBody = this.bodies[last];
      this.bodies[index] = lastBody;
      lastBody.id = index;
      this.bodies.length = last;
      body.scene = null;
    }
  }

  /** @param stepMs шаг в миллисекундах (int) */
  update(stepMs: number): void {
    ++this.frame;
    this.time += stepMs;
    this.dt = stepMs / PhysicsScene.TIME_SCALE;
    this.applyForces();
    this.detectCollisions();
    this.prepareBodyContacts(this.bodyContacts, this.dt);
    this.islandsGenerator.generate(this.bodyContacts, this.bodies.length);
    this.resolveCollisions(this.islandsGenerator.islands);
    this.integrateVelocities(this.dt);
    this.resolveContacts(this.islandsGenerator.islands);
    this.islandsGenerator.clear();
    this.disposeBodyContacts(this.bodyContacts);
    this.integratePositions(this.dt);
    this.postPhysics();
  }

  private applyForces(): void {
    const count = this.bodies.length;
    for (let n = 0; n < count; n++) {
      const body = this.bodies[n];
      body.calcAccelerations();
      if (body.movable && !body.frozen) {
        body.accel.x += this.gravity.x;
        body.accel.y += this.gravity.y;
        body.accel.z += this.gravity.z;
      }
    }
  }

  private detectCollisions(): void {
    this.calculateBodiesDerivedData();
    this.collisionDetector.getBodyContacts(this.bodyContacts);
  }

  private calculateBodiesDerivedData(): void {
    const count = this.bodies.length;
    for (let n = 0; n < count; n++) {
      const body = this.bodies[n];
      if (!body.frozen) {
        body.saveState();
        body.calcDerivedData();
      }
    }
  }

  private prepareBodyContacts(contacts: BodyContact[], dt: number): void {
    const count = contacts.length;
    for (let n = 0; n < count; n++) this.prepareShapeContacts(contacts[n].shapeContacts, dt);
  }

  private prepareShapeContacts(contacts: ShapeContact[], dt: number): void {
    const count = contacts.length;
    for (let n = 0; n < count; n++) {
      const contact = contacts[n];
      contact.calculatePersistentFrameData();
      contact.calculateDynamicFrameData(this.allowedPenetration, this.penetrationSpeed, this.maxPenetrationCorrection, dt);
    }
  }

  private resolveCollisions(islands: ContactIsland[]): void {
    const count = islands.length;
    for (let n = 0; n < count; n++) islands[n].collisionPhase(this.collisionIterations);
  }

  private resolveContacts(islands: ContactIsland[]): void {
    const count = islands.length;
    for (let n = 0; n < count; n++) islands[n].contactPhase(this.contactIterations);
  }

  private integrateVelocities(dt: number): void {
    const count = this.bodies.length;
    for (let n = 0; n < count; n++) this.bodies[n].integrateVelocity(dt);
  }

  private integratePositions(dt: number): void {
    const count = this.bodies.length;
    for (let n = 0; n < count; n++) {
      const body = this.bodies[n];
      if (body.movable && !body.frozen) {
        body.integratePosition(dt);
        body.integratePseudoVelocity(dt);
      }
    }
  }

  private postPhysics(): void {
    const count = this.bodies.length;
    for (let n = 0; n < count; n++) {
      const body = this.bodies[n];
      body.clearAccumulators();
      body.calcDerivedData();
      if (body.canFreeze && !body.frozen) {
        const state = body.state;
        if (state.velocity.length() < this.linSpeedFreezeLimit && state.rotation.length() < this.angSpeedFreezeLimit) {
          ++body.freezeCounter;
          if (body.freezeCounter >= this.freezeSteps) body.frozen = true;
        } else {
          body.freezeCounter = 0;
          body.frozen = false;
        }
      }
    }
  }

  private disposeBodyContacts(contacts: BodyContact[]): void {
    const count = contacts.length;
    for (let n = 0; n < count; n++) contacts[n].dispose();
    contacts.length = 0;
  }
}

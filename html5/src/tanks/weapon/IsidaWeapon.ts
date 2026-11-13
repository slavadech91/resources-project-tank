// Narukami LocalHealingGun / IsisDirectionCalculator / IsisTargetPriorityCalculator.
// Client reference: Narukami; server reference copyright Daniil Pryima, AGPL-3.0-or-later.
import type { Body } from '../../physics/Body.ts';
import { CollisionBox } from '../../physics/collision/CollisionShape.ts';
import { PhysicsMaterial } from '../../physics/collision/types.ts';
import { RayHit } from '../../physics/collision/types.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import type { EffectsScene } from '../sfx/SmokyEffects.ts';
import type { ContinuousEffect } from '../sfx/StreamEffects.ts';
import type { SimpleKeyboardWeaponController } from '../tank/Controllers.ts';
import type { Tank } from '../tank/Tank.ts';
import { AllGlobalGunParams, WeaponForces, calculateMainGunParams, isTurretAboveGround } from './SmokyWeapon.ts';
import { StreamData, StreamWeapon, type StreamTarget } from './StreamWeapon.ts';

import { ISIDA_DEFAULT, type IsidaConfig } from '../../net2/isida.ts';
export { ISIDA_DEFAULT, type IsidaConfig } from '../../net2/isida.ts';

export class IsidaWeapon extends StreamWeapon {
  private localEnabled = false;
  private localTank: Tank | null = null;
  private shooting = false;
  private energyValue = 1000;
  private energyTime = 0;
  private nextTickTime = 0;
  private ticksLeft = 0;
  private updateHitTime = 0;
  private released = true;
  private currentTarget: Tank | null = null;
  private healingMode = false;
  private readonly contactLocal=new Vector3();
  private isidaEffect: ContinuousEffect | null = null;
  private buffed = false;
  setBuffedMode(value: boolean): void { this.buffed = value; this.isidaEffect?.setBuffedMode?.(value); }
  private cc = { ...ISIDA_DEFAULT };
  private readonly selectedOrigin = new Vector3();
  private readonly params = new AllGlobalGunParams();
  private readonly hitResult = new RayHit();
  private readonly bonusLocal = new Vector3();
  private bonusValid = false;

  constructor(forces: WeaponForces, private readonly input: SimpleKeyboardWeaponController,
    private readonly detector: TanksCollisionDetector, private readonly fxScene: EffectsScene) {
    super(forces, input, detector, fxScene, 'isida');
  }

  configureIsida(config: IsidaConfig): void { this.cc = { ...config }; }
  override configure(_config: StreamData): void { /* IsidaCC, not StreamWeaponCC */ }
  override init(tank: Tank): void { this.localTank = tank; this.reset(); }
  override enable(): void { this.localEnabled = true; }
  override disable(): void { this.localEnabled = false; this.finish(); }
  override reset(): void {
    this.finish(); this.buffed = false; this.localEnabled = false; this.energyValue = this.cc.capacity;
    this.energyTime = performance.now(); this.released = !this.input.isTriggerPulled();
  }
  override get isFiring(): boolean { return this.shooting; }
  override getStatus(): number { return Math.max(0, Math.min(1, this.energyValue / this.cc.capacity)); }

  private drain(): number {
    return !this.currentTarget ? this.cc.dischargeIdleRate : this.healingMode ? this.cc.dischargeHealingRate : this.cc.dischargeDamageRate;
  }

  override runLogic(time: number, _delta: number): void {
    const dt = Math.max(0, time - this.energyTime) / 1000;
    this.energyTime = time;
    this.energyValue = Math.max(0, Math.min(this.cc.capacity,
      this.energyValue + (this.shooting ? -this.drain() : this.cc.chargeRate) * dt));
    const pulled = this.input.isTriggerPulled();
    if (!pulled) this.released = true;
    if (this.shooting && (!pulled || !this.localEnabled)) this.finish();
    if (!this.localEnabled || !this.localTank) return;
    if (!this.shooting && pulled && this.released) {
      this.released = false; this.shooting = true;
      this.isidaEffect = this.effectsFactory?.create(this.fxScene) ?? null;
      this.isidaEffect?.start(); this.isidaEffect?.setBuffedMode?.(this.buffed); this.listener?.onStart();
    }
    if (!this.shooting) return;
    const selected = this.selectTarget(this.localTank);
    const changed = this.currentTarget !== (selected?.target ?? null);
    if(selected){
      const body=selected.target.getBody(),m=body.baseMatrix,p=body.state.position;
      if(changed){
        const x=selected.point.x-p.x,y=selected.point.y-p.y,z=selected.point.z-p.z;
        this.contactLocal.reset(m.a*x+m.e*y+m.i*z,m.b*x+m.f*y+m.j*z,m.c*x+m.g*y+m.k*z);
      }
      m.transformVector(this.contactLocal,selected.point);selected.point.add(p);
    }
    this.currentTarget = selected?.target ?? null;
    this.healingMode = this.currentTarget?.friendly ?? false;
    if (changed) {
      this.nextTickTime = time + this.cc.checkPeriodMsec;
      this.ticksLeft = this.currentTarget ? (this.drain() > 0 ? Math.trunc(this.energyValue * 1000 / this.drain() / this.cc.checkPeriodMsec) : 2147483647) : 0;
    }
    const targets = selected ? [selected] : [];
    if (changed || time - this.updateHitTime >= 250) {
      this.updateHitTime = time; this.listener?.onTarget?.(targets, this.selectedOrigin);
    }
    this.isidaEffect?.aim(this.params.muzzlePosition, this.params.direction);
    this.isidaEffect?.setTarget(selected?.point ?? null, this.healingMode, selected?.target.getBody() ?? null);
    if (this.ticksLeft > 0 && time >= this.nextTickTime) {
      this.ticksLeft--; this.nextTickTime = time + this.cc.checkPeriodMsec;
      this.listener?.onTick(targets, null, this.healingMode, this.selectedOrigin);
    }
    if (this.ticksLeft === 0 && this.energyValue <= 0) this.finish();
    this.input.discardStoredAction();
  }

  private finish(): void {
    if (this.shooting) this.listener?.onStop();
    this.shooting = false; this.currentTarget = null; this.bonusValid = false; this.ticksLeft = 0;
    this.isidaEffect?.stop(); this.isidaEffect = null; // GraphicEffect owns the 13/s fade-out.
  }

  private selectTarget(tank: Tank): StreamTarget | null {
    const p = this.params;
    calculateMainGunParams(tank, tank.skin.turret.muzzles[0], p);
    if (!isTurretAboveGround(tank.getBody(), p, this.detector)) return null;
    const up = new Vector3().cross2(p.elevationAxis, p.direction);
    const screen = 2 * Math.tan(this.cc.coneAngle / 2);
    const directions: { direction: Vector3; angle: number; bonus: number }[] = [];
    for (let i = 0; i < 11; i++) for (let j = 0; j < 11; j++) {
      const direction = p.direction.clone().addScaled(-screen / 2 + i * screen / 10, up)
        .addScaled(-screen / 2 + j * screen / 10, p.elevationAxis).normalize();
      const angle = Math.acos(Math.max(-1, Math.min(1, direction.dot(p.direction))));
      if (angle <= this.cc.coneAngle / 2) directions.push({ direction, angle, bonus: 0 });
    }
    const matrix = tank.getTurretMatrix();
    if (this.currentTarget && this.bonusValid) {
      const b = this.bonusLocal;
      const direction = new Vector3(matrix.a*b.x + matrix.b*b.y + matrix.c*b.z,
        matrix.e*b.x + matrix.f*b.y + matrix.g*b.z, matrix.i*b.x + matrix.j*b.y + matrix.k*b.z).normalize();
      directions.push({ direction, angle: Math.acos(Math.max(-1, Math.min(1, direction.dot(p.direction)))), bonus: 10 });
    }
    const filter = { considerBody: (body: Body) => body !== tank.getBody() };
    let best: StreamTarget | null = null;
    let bestPriority = -Infinity, bestAngle = Infinity;
    for (const { direction, angle, bonus } of directions) {
      const origin = direction.dot(p.direction) > 0.9999 ? p.barrelOrigin : p.muzzlePosition;
      if (!this.detector.raycast(origin, direction, CollisionGroup.WEAPON, this.cc.radius, filter, this.hitResult)) continue;
      const target = this.hitResult.shape?.body?.data as Tank | undefined;
      if (!target || target === tank || !(target.health > 0)) continue;
      if (this.marginalBlocked(origin, this.hitResult.position, direction)) continue;
      const injured = target.health < (target.maxHealth || target.skin.hull.spec.armor) - 0.0001;
      const temperature = target.temperature;
      const teamPriority = target.friendly ? (injured ? 3 + (temperature > 0.0001 ? 5 : temperature < -0.0001 ? 4 : 0) : 1) : 2;
      const common = target.friendly ? 0 : 1000 - (0.65 * this.hitResult.t / (this.cc.radius - 50) + 0.35 * angle / this.cc.coneAngle);
      const priority = teamPriority + common * 0.0001 + (target === this.currentTarget ? 100 : 0) + bonus;
      if (priority > bestPriority || (priority === bestPriority && angle === 0 && bestAngle !== 0)) {
        this.selectedOrigin.copy(origin);
        bestPriority = priority; bestAngle = angle;
        best = { target, point: this.hitResult.position.clone() };
        // transpose rotation: store winning ray in the turret's local axes.
        this.bonusLocal.reset(matrix.a*direction.x + matrix.e*direction.y + matrix.i*direction.z,
          matrix.b*direction.x + matrix.f*direction.y + matrix.j*direction.z,
          matrix.c*direction.x + matrix.g*direction.y + matrix.k*direction.z);
      }
    }
    this.bonusValid = best !== null;
    return best;
  }

  /** Narukami MarginalCollider: exact oriented box, transverse half-size 6.5. */
  private marginalBlocked(origin: Vector3, end: Vector3, direction: Vector3): boolean {
    const box = new CollisionBox(new Vector3(6.5, new Vector3().diff(end,origin).length()/2, 6.5), CollisionGroup.STATIC, PhysicsMaterial.DEFAULT);
    const m=box.transform;
    if (Math.abs(direction.y) < Math.cos(Math.PI/180)) {
      const axis=new Vector3().cross2(new Vector3(0,1,0),direction).normalize();
      const angle=Math.acos(Math.max(-1,Math.min(1,direction.y))), c=Math.cos(angle), t=1-c, s=Math.sin(angle);
      const {x,y,z}=axis;
      m.a=c+x*x*t; m.b=x*y*t-z*s; m.c=x*z*t+y*s;
      m.e=y*x*t+z*s; m.f=c+y*y*t; m.g=y*z*t-x*s;
      m.i=z*x*t-y*s; m.j=z*y*t+x*s; m.k=c+z*z*t;
    }
    m.d=(origin.x+end.x)/2; m.h=(origin.y+end.y)/2; m.l=(origin.z+end.z)/2;
    box.calculateAABB(); return this.detector.testStaticCollision(box);
  }
}

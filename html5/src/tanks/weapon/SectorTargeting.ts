// Наведение по секторам целей — схема поздних клиентов ТО (сверено с Narukami: TargetingSystem, TargetingSectorsCalculator,
// SectorsSplitter, TargetingPriorityCalculator, SingleTargetDirectionProcessor, DirectionProcessorForPenetratingWeapons).
// Вместо веера лучей через 1/8° (CommonTargetingSystem 2014) для каждого танка в радиусе считается сектор углов наклона
// ствола, под которыми он виден (по описанной сфере), сектора режутся на отрезки и в каждом пускается 16 лучей —
// лучи сгущаются у целей, поэтому дальние и маленькие цели не проскакивают между лучами.
// Плоскость наведения та же: поворот вокруг оси X башни, вбок наведения нет.
import type { Body } from '../../physics/Body.ts';
import { CollisionBox } from '../../physics/collision/CollisionShape.ts';
import { PhysicsMaterial, RayHit, type IRayCollisionFilter } from '../../physics/collision/types.ts';
import { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { CollisionGroup } from '../physics/TankBody.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import type { Tank } from '../tank/Tank.ts';
import type { AllGlobalGunParams } from './SmokyWeapon.ts';

/** SectorsSplitter.DIRECTIONS_PER_SECTOR */
const DIRECTIONS_PER_SECTOR = 16;
/** CommonDirectionProcessor.COS_ALMOST_ZERO_ANGLE — почти прямой луч идёт от начала ствола */
const COS_ALMOST_ZERO_ANGLE = 0.9999;
/** MarginalCollider: полутолщина бокса отрезка */
const MARGIN = 6.5;
const COS_1_DEGREE = Math.cos(Math.PI / 180);
const Y_AXIS = new Vector3(0, 1, 0);

/** MarginalCollider: бокс 13 × длина × 13 вдоль отрезка — не проходит ли отрезок сквозь статику */
export class MarginalCollider {
  private readonly box = new CollisionBox(new Vector3(1, 1, 1), CollisionGroup.STATIC, new PhysicsMaterial());
  private readonly halfSize = new Vector3();
  private readonly center = new Vector3();
  private readonly direction = new Vector3();
  private readonly axis = new Vector3();
  private readonly rotation = new Matrix3();

  constructor(private readonly detector: TanksCollisionDetector) {}

  segmentWithStaticIntersection(from: Vector3, to: Vector3): boolean {
    this.halfSize.diff(from, to);
    this.halfSize.y = this.halfSize.length() / 2;
    this.halfSize.x = MARGIN;
    this.halfSize.z = MARGIN;
    this.box.hs.copy(this.halfSize);
    this.center.sum(from, to).scale(0.5);
    this.direction.diff(to, from).normalize();
    const t = this.box.transform;
    t.toIdentity();
    if (Math.abs(this.direction.y) < COS_1_DEGREE) {
      this.axis.cross2(Y_AXIS, this.direction).normalize();
      this.rotation.fromAxisAngle(this.axis, Math.acos(this.direction.dot(Y_AXIS)));
      t.setFromMatrix3(this.rotation, this.center);
    } else {
      t.setPosition(this.center);
    }
    this.box.calculateAABB();
    return this.detector.testStaticCollision(this.box);
  }
}

/** приоритет цели: танк, дистанция до неё, угол наклона луча; 0 — не цель (мёртвый) */
export type TargetPriority = (tank: Tank, distance: number, angle: number) => number;

/**
 * DMCommonTargetEvaluator: живой — 1000 − (0.65 · дистанция / полная + 0.35 · |угол| / максимальный), мёртвый — 0.
 * Угол наклона луча со знаком (вниз — минус), в приоритете — модуль: побеждает луч ближе всего к прицелу,
 * а не самый нижний.
 */
export function commonTargetPriority(tank: Tank, distance: number, angle: number, fullDistance: number, maxAngle: number): number {
  if (!(tank.health > 0)) return 0;
  return 1000 - ((0.65 * distance) / Math.max(1, fullDistance) + (0.35 * Math.abs(angle)) / Math.max(1e-6, maxAngle));
}

export interface SectorTargetingOptions {
  /** дальность лучей и отбора целей */
  maxDistance: number;
  priority: TargetPriority;
  /** рельса: луч пробивает танки до статики, приоритет следующих × weakening^i */
  penetrating?: boolean;
  weakeningCoeff?: number;
  /** setShotFromMuzzle: наклонённые лучи — от дула (Твинс), иначе от начала ствола */
  fromMuzzle?: boolean;
}

/** попадание луча; static — статика или танк, до которого отрезок проходит сквозь статику */
export class TargetingHit {
  readonly position = new Vector3();
  readonly normal = new Vector3();
  t = 0;
  body: Body | null = null;
  isStatic = false;

  get tank(): Tank | null {
    return this.isStatic ? null : ((this.body?.data as Tank | null | undefined) ?? null);
  }
}

/** TargetingResult: выбранное направление, танки по порядку и статика в конце (если луч в неё упёрся) */
export class TargetingResult {
  readonly direction = new Vector3();
  readonly hits: TargetingHit[] = [];
  staticHit: TargetingHit | null = null;
}

class TargetingSector {
  constructor(
    readonly left: number,
    readonly right: number,
    readonly distance: number,
    readonly tank: Tank,
  ) {}
}

class TargetingDirection {
  constructor(
    readonly direction: Vector3,
    readonly angle: number,
    readonly maxPriority: number,
  ) {}
}

class ExcludeBodiesFilter implements IRayCollisionFilter {
  readonly bodies = new Set<Body>();

  considerBody(body: Body): boolean {
    return !this.bodies.has(body);
  }
}

export class SectorTargeting {
  autoAimUp = 0;
  autoAimDown = 0;
  private readonly marginalCollider: MarginalCollider;
  private readonly filter = new ExcludeBodiesFilter();
  private readonly rayHit = new RayHit();
  private readonly up = new Vector3();
  private readonly toTarget = new Vector3();
  private readonly rotation = new Matrix3();
  private readonly step = new Matrix3();
  private readonly rayDirection = new Vector3();
  private readonly sectors: TargetingSector[] = [];
  private readonly overlap: TargetingSector[] = [];
  private readonly directions: TargetingDirection[] = [];
  private hits: TargetingHit[] = [];
  private spareHits: TargetingHit[] = [];

  constructor(
    private readonly detector: TanksCollisionDetector,
    readonly options: SectorTargetingOptions,
  ) {
    this.marginalCollider = new MarginalCollider(detector);
  }

  setAutoAimAngles(up: number, down: number): void {
    this.autoAimUp = Math.max(0, up);
    this.autoAimDown = Math.max(0, down);
  }

  /** TargetingSystem.target: направление с наибольшим приоритетом; без целей — прямо по стволу */
  target(shooter: Body, params: AllGlobalGunParams, result: TargetingResult): void {
    this.collectSectors(shooter, params);
    this.splitSectors(params);
    this.directions.push(new TargetingDirection(params.direction, 0, 0));
    this.directions.sort((a, b) => b.maxPriority - a.maxPriority);
    // прямой луч с приоритетом 0 есть всегда, поэтому результат будет выбран
    let best = -Infinity;
    for (const candidate of this.directions) {
      if (candidate.maxPriority < best) break;
      this.process(shooter, params, candidate.direction);
      const priority = this.hitsPriority(candidate.angle);
      if (priority > best || (priority == best && candidate.angle == 0)) {
        best = priority;
        this.setResult(candidate.direction, result);
      }
    }
    this.directions.length = 0;
  }

  /** TargetingSectorsCalculator: сектор углов наклона ствола, под которыми виден каждый танк */
  private collectSectors(shooter: Body, params: AllGlobalGunParams): void {
    this.sectors.length = 0;
    this.up.cross2(params.elevationAxis, params.direction);
    for (const tankBody of this.detector.getTankBodies()) {
      const body = tankBody.body;
      const tank = body.data as Tank | null | undefined;
      if (body == shooter || tank == null || tank.friendly) continue;
      const radius = tank.getBoundSphereRadius();
      this.toTarget.diff(body.state.position, params.barrelOrigin);
      const length = this.toTarget.length();
      if (length < 1e-6) continue;
      const distance = Math.max(0, length - radius);
      if (distance > this.options.maxDistance) continue;
      const forward = this.toTarget.dot(params.direction);
      const side = Math.atan2(this.toTarget.dot(params.elevationAxis), forward);
      const elevation = Math.atan2(this.toTarget.dot(this.up), forward);
      const halfAngle = Math.asin(Math.min(radius, length) / length);
      if (Math.abs(side) > halfAngle) continue;
      const left = Math.max(elevation - halfAngle, -this.autoAimDown);
      const right = Math.min(elevation + halfAngle, this.autoAimUp);
      if (left < right) this.sectors.push(new TargetingSector(left, right, distance, tank));
    }
    this.sectors.sort((a, b) => a.left - b.left);
  }

  /** SectorsSplitter: отрезки между границами перекрывающихся секторов, в каждом 16 лучей */
  private splitSectors(params: AllGlobalGunParams): void {
    const overlap = this.overlap;
    overlap.length = 0;
    let from = -Infinity;
    for (const sector of this.sectors) {
      while (overlap.length > 0 && from < sector.left) {
        const to = Math.min(this.minRight(), sector.left);
        this.addDirections(params, from, to);
        this.removeEndedSectors(to);
        from = to;
      }
      from = sector.left;
      overlap.push(sector);
    }
    while (overlap.length > 0) {
      const to = this.minRight();
      this.addDirections(params, from, to);
      this.removeEndedSectors(to);
      from = to;
    }
  }

  private minRight(): number {
    let right = Infinity;
    for (const sector of this.overlap) right = Math.min(right, sector.right);
    return right;
  }

  private removeEndedSectors(to: number): void {
    const overlap = this.overlap;
    for (let i = overlap.length - 1; i >= 0; i--) if (overlap[i].right <= to) overlap.splice(i, 1);
  }

  private addDirections(params: AllGlobalGunParams, from: number, to: number): void {
    if (!(to > from)) return;
    // ближние цели первыми: пробивающий луч сначала попадает в них
    const byDistance = [...this.overlap].sort((a, b) => a.distance - b.distance);
    const stepAngle = (to - from) / DIRECTIONS_PER_SECTOR;
    let angle = from + stepAngle * 0.5;
    this.rotation.fromAxisAngle(params.elevationAxis, angle);
    this.rotation.transformVector(params.direction, this.rayDirection);
    this.step.fromAxisAngle(params.elevationAxis, stepAngle);
    for (let n = 0; n < DIRECTIONS_PER_SECTOR; n++) {
      this.directions.push(new TargetingDirection(this.rayDirection.clone(), angle, this.sectorsPriority(angle, byDistance)));
      this.step.transformVector(this.rayDirection.clone(), this.rayDirection);
      angle += stepAngle;
    }
    if (from <= 0 && 0 <= to) this.directions.push(new TargetingDirection(params.direction, 0, this.sectorsPriority(0, byDistance)));
  }

  /** TargetingPriorityCalculator.getPriorityForSectors: верхняя оценка приоритета луча в этом отрезке */
  private sectorsPriority(angle: number, byDistance: TargetingSector[]): number {
    const weakening = this.options.weakeningCoeff ?? 0;
    let priority = 0;
    for (let i = byDistance.length - 1; i >= 0; i--) {
      const sector = byDistance[i];
      priority = Math.max(this.options.priority(sector.tank, sector.distance, angle) + weakening * priority, priority);
    }
    return priority;
  }

  /** TargetingPriorityCalculator.getPriorityForRayHits: танки луча по порядку с ослаблением, статика — 0 */
  private hitsPriority(angle: number): number {
    const weakening = this.options.weakeningCoeff ?? 0;
    let factor = 1;
    let priority = 0;
    for (const hit of this.hits) {
      const tank = hit.tank;
      if (tank != null && !tank.friendly) priority += this.options.priority(tank, hit.t, angle) * factor;
      factor *= weakening;
    }
    return priority;
  }

  /** SingleTargetDirectionProcessor / DirectionProcessorForPenetratingWeapons */
  private process(shooter: Body, params: AllGlobalGunParams, direction: Vector3): void {
    this.spareHits.push(...this.hits);
    this.hits.length = 0;
    const origin =
      this.options.fromMuzzle && direction.dot(params.direction) <= COS_ALMOST_ZERO_ANGLE ? params.muzzlePosition : params.barrelOrigin;
    this.filter.bodies.add(shooter);
    while (this.detector.raycast(origin, direction, CollisionGroup.WEAPON, this.options.maxDistance, this.filter, this.rayHit)) {
      const hit = this.spareHits.pop() ?? new TargetingHit();
      const body = this.rayHit.shape?.body ?? null;
      hit.position.copy(this.rayHit.position);
      hit.normal.copy(this.rayHit.normal);
      hit.t = this.rayHit.t;
      hit.body = body;
      hit.isStatic = body == null || body.data == null || this.marginalCollider.segmentWithStaticIntersection(origin, this.rayHit.position);
      this.hits.push(hit);
      if (hit.isStatic || !this.options.penetrating) break;
      this.filter.bodies.add(body as Body);
    }
    this.filter.bodies.clear();
  }

  /** TargetingResult.setData: статика, если есть, — последней и отдельно */
  private setResult(direction: Vector3, result: TargetingResult): void {
    result.direction.copy(direction);
    // результат хранит свои копии: this.hits переиспользуются следующими лучами
    result.hits.length = 0;
    result.staticHit = null;
    for (const hit of this.hits) {
      const copy = new TargetingHit();
      copy.position.copy(hit.position);
      copy.normal.copy(hit.normal);
      copy.t = hit.t;
      copy.body = hit.body;
      copy.isStatic = hit.isStatic;
      if (copy.isStatic) result.staticHit = copy;
      else result.hits.push(copy);
    }
  }
}

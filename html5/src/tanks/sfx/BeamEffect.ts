// Процедурный луч для оружия без готовых спрайтов 2014 года (Шафт-след, Изида): цилиндр с аддитивным
// материалом от дула до цели. Живёт заданное время (или до destroy — у непрерывной струи Изиды).
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { RenderOrder, type GraphicEffect } from './SmokyEffects.ts';

const axisY = new THREE.Vector3(0, 1, 0);
const direction = new THREE.Vector3();

export class BeamEffect implements GraphicEffect {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly lifeMs: number;
  private leftMs: number;
  private readonly baseOpacity: number;
  private readonly radius: number;
  private destroyed = false;

  constructor(parent: THREE.Object3D, from: Vector3, to: Vector3, color: number, radius = 9, lifeMs = 0, opacity = 0.9) {
    this.from.copy(from);
    this.to.copy(to);
    this.lifeMs = lifeMs;
    this.leftMs = lifeMs;
    this.baseOpacity = opacity;
    this.radius = radius;
    this.material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), this.material);
    this.mesh.renderOrder = RenderOrder.EFFECTS;
    parent.add(this.mesh);
    this.update();
  }

  /** новая цель луча (непрерывная струя) */
  setTo(to: Vector3): void {
    this.to.copy(to);
    this.update();
  }

  /** начало луча переехало вместе с дулом */
  setFrom(from: Vector3): void {
    this.from.copy(from);
    this.update();
  }

  /** цвет луча: Изида лечит зелёным и ранит красным */
  setColor(color: number): void {
    this.material.color.setHex(color);
  }

  private update(): void {
    direction.set(this.to.x - this.from.x, this.to.y - this.from.y, this.to.z - this.from.z);
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 1e-3) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    direction.multiplyScalar(1 / length);
    this.mesh.position.set((this.from.x + this.to.x) / 2, (this.from.y + this.to.y) / 2, (this.from.z + this.to.z) / 2);
    this.mesh.quaternion.setFromUnitVectors(axisY, direction);
    this.mesh.scale.set(this.radius, length, this.radius);
  }

  play(delta: number, _cameraPosition: Vector3): boolean {
    if (this.destroyed) return false;
    if (this.lifeMs <= 0) return true;
    this.leftMs -= delta;
    const k = Math.max(0, this.leftMs / this.lifeMs);
    this.material.opacity = this.baseOpacity * k;
    return this.leftMs > 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

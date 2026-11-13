/**
 * Инспектор пропов для администратора (и офлайн-режима): F6 — включить/выключить, Shift+F6 — скопировать сводку.
 * Луч из прицела (центр экрана; при свободном курсоре — из-под курсора) ищет проп карты и показывает его библиотеку,
 * имя, текстуру, позицию и поворот, точку попадания, координаты камеры и танка (координаты карты) и строку ?cam=
 * для офлайн-режима (координаты Three.js), чтобы баг текстур можно было открыть с того же ракурса.
 * Пропы склеены в батчи (map/batching.ts) — проп внутри батча находится по номеру треугольника (userData.parts).
 */

import * as THREE from 'three';
import type { BatchPart } from '../../map/batching.ts';

const PICK_INTERVAL_MS = 150;

export interface PropInspectorSource {
  camera: THREE.Camera;
  /** группа карты: её локальные координаты — координаты карты */
  world: THREE.Object3D;
  /** объекты карты (пропы и батчи) */
  targets(): THREE.Object3D[];
  /** позиция своего танка в координатах карты, если он есть */
  tankPosition(): { x: number; y: number; z: number } | null;
  /** доступен ли инспектор сейчас (администратор или офлайн) */
  allowed(): boolean;
}

function vec(v: { x: number; y: number; z: number }): string {
  return `${v.x.toFixed(0)}, ${v.y.toFixed(0)}, ${v.z.toFixed(0)}`;
}

function degrees(value: number): string {
  return `${Math.round(THREE.MathUtils.radToDeg(value))}°`;
}

export class PropInspector {
  private readonly root = document.createElement('div');
  private readonly crosshair = document.createElement('div');
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly mapPoint = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private mouse: { x: number; y: number } | null = null;
  private active = false;
  private timer = 0;
  private text = '';

  constructor(
    parent: HTMLElement,
    private readonly source: PropInspectorSource,
  ) {
    this.root.className = 'inspector-root';
    this.crosshair.className = 'inspector-crosshair';
    this.root.hidden = this.crosshair.hidden = true;
    parent.append(this.root, this.crosshair);
    window.addEventListener('keydown', (event) => {
      if (event.code != 'F6') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName == 'INPUT' || target.tagName == 'TEXTAREA')) return;
      event.preventDefault();
      if (event.shiftKey) {
        if (this.active) void navigator.clipboard?.writeText(this.text).catch(() => undefined);
        return;
      }
      this.setActive(!this.active);
    });
    // курсор свободен (лобби, свободная камера) — луч из-под курсора; при захвате мыши — из центра
    window.addEventListener('mousemove', (event) => {
      this.mouse = document.pointerLockElement ? null : { x: event.clientX, y: event.clientY };
    });
  }

  private setActive(active: boolean): void {
    if (active && !this.source.allowed()) {
      console.info('инспектор пропов доступен только администратору');
      return;
    }
    this.active = active;
    this.root.hidden = this.crosshair.hidden = !active;
    window.clearInterval(this.timer);
    if (active) {
      this.timer = window.setInterval(() => this.pick(), PICK_INTERVAL_MS);
      this.pick();
    }
  }

  private pick(): void {
    if (!this.source.allowed()) {
      this.setActive(false);
      return;
    }
    const camera = this.source.camera;
    const mouse = this.mouse;
    this.crosshair.hidden = mouse != null;
    this.pointer.set(mouse ? (mouse.x / window.innerWidth) * 2 - 1 : 0, mouse ? -(mouse.y / window.innerHeight) * 2 + 1 : 0);
    this.raycaster.setFromCamera(this.pointer, camera);
    const hits = this.raycaster.intersectObjects(this.source.targets(), true);
    const hit = hits.find((item) => item.object.visible && item.object.userData.propName != null) ?? null;

    const world = this.source.world;
    const lines: string[] = [];
    if (hit) {
      const part = this.findPart(hit);
      if (part) {
        lines.push(`Проп: ${part.library} / ${part.name}${part.texture ? ` (текстура ${part.texture})` : ''}`);
        lines.push(`  позиция ${vec(part.position)} · поворот z ${degrees(part.rotation.z)}${part.rotation.x || part.rotation.y ? `, x ${degrees(part.rotation.x)}, y ${degrees(part.rotation.y)}` : ''}`);
      } else {
        lines.push('Проп: не определён');
      }
      this.mapPoint.copy(hit.point);
      world.worldToLocal(this.mapPoint);
      lines.push(`Точка: ${vec(this.mapPoint)} · до неё ${hit.distance.toFixed(0)}`);
    } else {
      lines.push('Проп: нет попадания');
    }
    camera.updateMatrixWorld();
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    this.mapPoint.copy(cameraPosition);
    world.worldToLocal(this.mapPoint);
    lines.push(`Камера: ${vec(this.mapPoint)}`);
    const tank = this.source.tankPosition();
    if (tank) lines.push(`Танк: ${vec(tank)}`);
    camera.getWorldDirection(this.forward);
    const look = hit ? hit.point : cameraPosition.clone().addScaledVector(this.forward, 1000);
    lines.push(`?cam=${[cameraPosition.x, cameraPosition.y, cameraPosition.z, look.x, look.y, look.z].map((n) => Math.round(n)).join(',')}`);
    lines.push('F6 — закрыть · Shift+F6 — скопировать');
    this.text = lines.slice(0, -1).join('\n');
    this.root.textContent = lines.join('\n');
  }

  /** проп по попаданию: отдельный меш — его userData, батч — диапазон треугольников с faceIndex */
  private findPart(hit: THREE.Intersection): Omit<BatchPart, 'bounds'> | null {
    const data = hit.object.userData;
    const parts = data.parts as BatchPart[] | undefined;
    if (!parts) {
      if (data.propName == null) return null;
      return {
        end: 0,
        library: String(data.library ?? ''),
        name: String(data.propName),
        texture: String(data.texture ?? ''),
        position: hit.object.position,
        rotation: hit.object.rotation,
      };
    }
    const face = hit.faceIndex ?? -1;
    if (face < 0) return null;
    let low = 0;
    let high = parts.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (parts[middle].end > face) high = middle;
      else low = middle + 1;
    }
    return parts[low] ?? null;
  }
}

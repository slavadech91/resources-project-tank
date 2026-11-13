import * as THREE from 'three';
import type { Tank } from '../tank/Tank.ts';

const CAPACITY = 4096;
const LIFE_SECONDS = 24;
const TREAD_PITCH = 15;
const batches = new WeakMap<THREE.Object3D, TrackMarks>();

interface Contact {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  side: THREE.Vector3;
  phase: number;
}

/** Ground marks share one draw call and a fixed-size ring buffer for the battle. */
export class TrackMarks {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions = new THREE.BufferAttribute(new Float32Array(CAPACITY * 18), 3).setUsage(THREE.DynamicDrawUsage);
  private readonly tread = new THREE.BufferAttribute(new Float32Array(CAPACITY * 18), 3).setUsage(THREE.DynamicDrawUsage);
  private readonly history = new WeakMap<Tank, [Contact | null, Contact | null]>();
  private readonly delta = new THREE.Vector3();
  private readonly now = { value: 0 };
  private readonly start = performance.now();
  private next = 0;
  private count = 0;

  constructor(world: THREE.Object3D) {
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('tread', this.tread);
    this.geometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      uniforms: { now: this.now },
      vertexShader: `
        attribute vec3 tread;
        varying vec3 vTread;
        varying float vDistance;
        void main() {
          vTread = tread;
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          vDistance = -viewPosition.z;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform float now;
        varying vec3 vTread;
        varying float vDistance;
        void main() {
          float age = now - vTread.z;
          float lifetime = 1.0 - smoothstep(7.0, ${LIFE_SECONDS.toFixed(1)}, age);
          float edge = abs(vTread.y * 2.0 - 1.0);
          float crossbar = vTread.x - 0.26 * edge;
          float tooth = abs(fract(crossbar) - 0.5);
          float aa = clamp(fwidth(crossbar), 0.03, 0.25);
          float lug = 1.0 - smoothstep(0.22 - aa, 0.22 + aa, tooth);
          float shoulder = smoothstep(0.71, 0.8, edge);
          float outline = 1.0 - smoothstep(0.83, 1.0, edge);
          float grit = 0.82 + 0.18 * sin(vTread.x * 17.3 + vTread.y * 34.1);
          float detail = 1.0 - smoothstep(1400.0, 2800.0, vDistance);
          float opacity = outline * lifetime * grit * detail * (0.14 + 0.24 * lug + 0.10 * shoulder);
          if (opacity < 0.005) discard;
          gl_FragColor = vec4(vec3(0.15, 0.112, 0.075), opacity);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.name = 'tank-track-marks';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    world.add(mesh);
    batches.set(world, this);
  }

  update(time: number): void {
    this.now.value = (time - this.start) * 0.001;
  }

  clear(): void {
    this.next = this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  sample(tank: Tank): void {
    if (tank.health <= 0 || !tank.tankBody.body.scene) {
      this.history.delete(tank);
      return;
    }
    let pair = this.history.get(tank);
    if (!pair) this.history.set(tank, pair = [null, null]);
    const { leftTrack, rightTrack } = tank.chassis;
    const matrix = tank.tankBody.body.baseMatrix;
    const bounds = tank.skin.hull.bounds;
    const halfWidth = THREE.MathUtils.clamp((bounds.maxX - bounds.minX) * 0.105, 14, 27);
    for (const index of [0, 1] as const) {
      const rays = (index === 0 ? leftTrack : rightTrack).rays;
      // Use a central contact so the trail survives short gaps under the end rollers.
      const mid = Math.floor(rays.length / 2);
      const ray = [rays[mid], rays[mid - 1]].find(
        candidate => candidate?.hasCollision && candidate.rayHit.shape?.body?.data == null,
      );
      if (!ray) {
        pair[index] = null;
        continue;
      }
      const { position, normal } = ray.rayHit;
      const previous = pair[index];
      const distance = previous ? this.delta.set(position.x, position.y, position.z).sub(previous.position).length() : 0;
      if (previous && distance < 12) continue;
      const next: Contact = {
        position: new THREE.Vector3(position.x, position.y, position.z),
        normal: new THREE.Vector3(normal.x, normal.y, normal.z),
        side: new THREE.Vector3(matrix.a, matrix.e, matrix.i),
        phase: 0,
      };
      next.side.addScaledVector(next.normal, -next.side.dot(next.normal)).normalize().multiplyScalar(halfWidth);
      pair[index] = next;
      if (!previous || distance > 110 || previous.normal.dot(next.normal) < 0.92 || Math.abs(this.delta.dot(next.normal)) > 9) continue;
      const phase = previous.phase + distance / TREAD_PITCH;
      this.writeSegment(previous, next, phase);
      next.phase = phase % 1;
    }
  }

  private writeSegment(from: Contact, to: Contact, phase: number): void {
    const first = this.next * 6;
    const write = (offset: number, contact: Contact, side: number, u: number) => {
      const { position, normal } = contact;
      const width = contact.side;
      this.positions.setXYZ(first + offset, position.x + side * width.x + normal.x,
        position.y + side * width.y + normal.y, position.z + side * width.z + normal.z);
      this.tread.setXYZ(first + offset, u, (side + 1) * 0.5, this.now.value);
    };
    write(0, from, -1, from.phase);
    write(1, from, 1, from.phase);
    write(2, to, -1, phase);
    write(3, to, -1, phase);
    write(4, from, 1, from.phase);
    write(5, to, 1, phase);
    for (const attribute of [this.positions, this.tread]) {
      attribute.addUpdateRange(first * 3, 18);
      attribute.needsUpdate = true;
    }
    this.next = (this.next + 1) % CAPACITY;
    if (this.count < CAPACITY) this.geometry.setDrawRange(0, ++this.count * 6);
  }
}

export function sampleTrackMarks(tank: Tank): void {
  const world = tank.skin.hull.mesh?.parent;
  if (world) batches.get(world)?.sample(tank);
}

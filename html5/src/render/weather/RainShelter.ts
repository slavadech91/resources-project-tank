import * as THREE from 'three';

const SIZE = 1024;
export const shelterUniforms = {
  rainRoofDepth: { value: null as THREE.DepthTexture | null },
  rainRoofBounds: { value: new THREE.Vector4() },
  rainRoofRange: { value: new THREE.Vector2() },
};

/** A top-down depth pass records the first surface that rain can reach. */
export class RainShelter {
  private meshes: readonly THREE.Mesh[] = [];
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false });

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  setMap(meshes: readonly THREE.Mesh[]): void {
    this.target?.dispose();
    this.target = null;
    this.meshes = meshes;
    shelterUniforms.rainRoofDepth.value = null;
    shelterUniforms.rainRoofRange.value.set(0, 0);
  }

  prepare(): void {
    if (this.target || !this.meshes.length) return;
    const scene = new THREE.Scene();
    const bounds = new THREE.Box3();
    for (const mesh of this.meshes) {
      mesh.updateWorldMatrix(true, false);
      const depthMesh = new THREE.Mesh(mesh.geometry, this.material);
      depthMesh.matrixAutoUpdate = false;
      depthMesh.matrix.copy(mesh.matrixWorld);
      scene.add(depthMesh);
      bounds.expandByObject(depthMesh);
    }
    if (bounds.isEmpty()) return;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const halfX = size.x * 0.5 + 50;
    const halfZ = size.z * 0.5 + 50;
    const top = bounds.max.y + 50;
    const camera = new THREE.OrthographicCamera(-halfX, halfX, halfZ, -halfZ, 1, size.y + 100);
    camera.up.set(0, 0, -1);
    camera.position.set(center.x, top, center.z);
    camera.lookAt(center.x, bounds.min.y, center.z);

    const depthTexture = new THREE.DepthTexture(SIZE, SIZE, THREE.UnsignedIntType);
    const target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthTexture });
    const previousTarget = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(target);
      this.renderer.clear(false, true, false);
      this.renderer.render(scene, camera);
    } catch (error) {
      target.dispose();
      throw error;
    } finally {
      this.renderer.setRenderTarget(previousTarget);
    }
    this.target = target;
    shelterUniforms.rainRoofDepth.value = depthTexture;
    shelterUniforms.rainRoofBounds.value.set(center.x - halfX, center.z + halfZ, 1 / (2 * halfX), 1 / (2 * halfZ));
    shelterUniforms.rainRoofRange.value.set(top - camera.near, 1 / (camera.far - camera.near));
  }
}

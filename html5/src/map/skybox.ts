// Скайбокс боя: alternativa/engine3d/objects/SkyBox.as + models/battle/battlefield/BattleSkyBox.as.
// Картинка — одна полоса: 4 боковые грани квадратами подряд (RIGHT, BACK, LEFT, FRONT), затем TOP и BOTTOM
// с зазорами по 8 пикселей. Куб стоит в позиции камеры и рисуется первым, без записи глубины.
import * as THREE from 'three';

/** BattleSkyBox.§"d§ */
const SKYBOX_SIZE = 200000;

type Face = 'left' | 'right' | 'back' | 'front' | 'bottom' | 'top';

/** flash.geom.Matrix: u' = a*u + c*v + tx, v' = b*u + d*v + ty */
interface UVMatrix {
  a: number;
  d: number;
  tx: number;
  ty: number;
}

/** Вершины граней как в конструкторе SkyBox (x, y, z, u, v), uvPadding = 0 */
function skyBoxFaces(half: number): Record<Face, number[][]> {
  const s = half;
  return {
    left: [
      [-s, -s, s, 0, 0],
      [-s, -s, -s, 0, 1],
      [-s, s, -s, 1, 1],
      [-s, s, s, 1, 0],
    ],
    right: [
      [s, s, s, 0, 0],
      [s, s, -s, 0, 1],
      [s, -s, -s, 1, 1],
      [s, -s, s, 1, 0],
    ],
    back: [
      [s, -s, s, 0, 0],
      [s, -s, -s, 0, 1],
      [-s, -s, -s, 1, 1],
      [-s, -s, s, 1, 0],
    ],
    front: [
      [-s, s, s, 0, 0],
      [-s, s, -s, 0, 1],
      [s, s, -s, 1, 1],
      [s, s, s, 1, 0],
    ],
    bottom: [
      [-s, s, -s, 0, 0],
      [-s, -s, -s, 0, 1],
      [s, -s, -s, 1, 1],
      [s, s, -s, 1, 0],
    ],
    top: [
      [-s, -s, s, 0, 0],
      [-s, s, s, 0, 1],
      [s, s, s, 1, 1],
      [s, -s, s, 1, 0],
    ],
  };
}

/** Раскладка UV из BattleSkyBox */
function battleSkyBoxUV(width: number, height: number): Record<Face, UVMatrix> {
  const ratio = height / width;
  const sides: Face[] = ['right', 'back', 'left', 'front'];
  const result = {} as Record<Face, UVMatrix>;
  sides.forEach((face, index) => {
    result[face] = { a: ratio, d: 1, tx: index * ratio, ty: 0 };
  });
  result.top = { a: -ratio, d: -1, tx: (5 * height + 8) / width, ty: 1 };
  result.bottom = { a: -ratio, d: -1, tx: 1, ty: 1 };
  return result;
}

function createGeometry(width: number, height: number): THREE.BufferGeometry {
  const faces = skyBoxFaces(SKYBOX_SIZE * 0.5);
  const uv = battleSkyBoxUV(width, height);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const face of Object.keys(faces) as Face[]) {
    const base = positions.length / 3;
    const m = uv[face];
    for (const [x, y, z, u, v] of faces[face]) {
      positions.push(x, y, z);
      // v во Flash отсчитывается сверху, в WebGL (flipY) — снизу
      uvs.push(m.a * u + m.tx, 1 - (m.d * v + m.ty));
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

export class BattleSkyBox {
  readonly mesh: THREE.Mesh;

  private constructor(texture: THREE.Texture, width: number, height: number) {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
      // туман неба (TextureMaterial у SkyBox, skyFogConst): небо дальше far, доля тумана = alpha
      fog: true,
    });
    this.mesh = new THREE.Mesh(createGeometry(width, height), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'skybox';
  }

  static async load(url: string): Promise<BattleSkyBox> {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    const image = texture.image as HTMLImageElement;
    return new BattleSkyBox(texture, image.width, image.height);
  }

  /** SkyBox.autoSize: куб всегда вокруг камеры (координаты карты, Z вверх) */
  follow(x: number, y: number, z: number): void {
    this.mesh.position.set(x, y, z);
  }
}

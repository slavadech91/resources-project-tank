/**
 * TankPreviewWindow: бокс гаража и танк в отдельном WebGL-окне.
 * Камера как в оригинале: контейнер повёрнут на −135° вокруг X, камера на 730 от центра, начальный поворот −150°
 * вокруг Z; поле зрения Camera3D — 90° по диагонали. Вращение мышью (полный оборот на ширину окна), после отпускания
 * замедление exp(−1.5·t), через 10 с без действий — автоповорот до 5°/с с ускорением 5°/с².
 * Текстуры без освещения (TextureMaterial), танк смещён на −17 по X (Tank3D).
 */

import * as THREE from 'three';
import {GarageRotation} from './GarageRotation.ts';
import { TankSkin } from '../../tanks/render/TankSkin.ts';

const CAMERA_ANGLE = (-135 * Math.PI) / 180;
const CAMERA_DISTANCE = 730;
const TANK_OFFSET_X = -17;

interface BoxObject {
  name: string;
  positions?: number[];
  uvs?: number[];
  indices?: number[];
  position: number[];
}



export class GaragePreview {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 10, 20000);
  private readonly tankGroup = new THREE.Group();
  private readonly rotation=new GarageRotation();
  private pointerId:number|null=null;
  private animationFrame=0;
  private width = 100;
  private height = 100;
  private running = false;
  private skin: TankSkin | null = null;
  private skinKey = '';

  constructor(parent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'lb-abs';
    parent.appendChild(this.canvas);
    this.tankGroup.position.x = TANK_OFFSET_X;
    this.scene.add(this.tankGroup);
    this.canvas.style.touchAction='none';
    this.canvas.addEventListener('pointerdown',this.onPointerDown);
    this.canvas.addEventListener('pointermove',this.onPointerMove);
    this.canvas.addEventListener('pointerup',this.onPointerUp);
    this.canvas.addEventListener('pointercancel',this.onPointerCancel);
    this.canvas.addEventListener('lostpointercapture',this.onPointerCancel);
    window.addEventListener('blur',()=>this.cancelDrag());
    void this.loadBox();
  }

  private async loadBox(): Promise<void> {
    const response = await fetch('/lobby/garage_box/part.json');
    if (!response.ok) return;
    const data = (await response.json()) as { objects: BoxObject[]; texture: string };
    const texture = await new THREE.TextureLoader().loadAsync(`/lobby/garage_box/${data.texture}`);
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    for (const object of data.objects) {
      if (!object.positions || !object.indices) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(object.positions, 3));
      if (object.uvs && object.uvs.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(object.uvs, 2));
      geometry.setIndex(object.indices);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(object.position[0], object.position[1], object.position[2]);
      this.scene.add(mesh);
    }
  }

  /** Tank3D.setHull / setTurret / setColorMap */
  async setTank(hullPath: string, turretPath: string, paintUrl: string): Promise<void> {
    const key = `${hullPath}|${turretPath}|${paintUrl}`;
    if (key == this.skinKey) return;
    this.skinKey = key;
    const skin = await TankSkin.load(hullPath, turretPath, paintUrl);
    if (key != this.skinKey) return;
    this.tankGroup.clear();
    this.skin = skin;
    // в гараже нет света: все меши танка, включая гусеницы (дочерние меши корпуса), — без освещения, с тем же цветом
    for (const part of [skin.hull, skin.turret]) {
      part.mesh.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const lit = object.material as THREE.MeshLambertMaterial;
        object.material = new THREE.MeshBasicMaterial({ map: lit.map, color: lit.color, side: THREE.DoubleSide });
      });
    }
    skin.addToScene(this.tankGroup);
    const identity = skin.hullMatrix;
    identity.toIdentity();
    skin.updateHullTransform(identity);
    skin.updateTurretTransform(0);
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.canvas.style.left = `${Math.round(x)}px`;
    this.canvas.style.top = `${Math.round(y)}px`;
    this.renderer.setSize(this.width, this.height);
    // Camera3D: fov 90° по диагонали окна
    const halfDiagonal = Math.hypot(this.width, this.height) / 2;
    this.camera.fov = (2 * Math.atan((this.height / 2) / halfDiagonal) * 180) / Math.PI;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rotation.resetClock(performance.now());
    const frame = (): void => {
      if (!this.running) return;
      this.animationFrame=requestAnimationFrame(frame);
      this.update();
      this.render();
    };
    this.animationFrame=requestAnimationFrame(frame);
  }

  stop(): void {
    this.running=false;cancelAnimationFrame(this.animationFrame);this.cancelDrag();
  }
  private update(): void {this.rotation.update(performance.now());}

  private render(): void {
    // позиция и «верх» камеры: Rz(rotationZ)·Rx(−135°)·(0, 0, −730); камера Alternativa смотрит по своей +Z, верх экрана — −Y
    const rx = new THREE.Matrix4().makeRotationX(CAMERA_ANGLE);
    const rz = new THREE.Matrix4().makeRotationZ(this.rotation.angle);
    const m = rz.multiply(rx);
    const position = new THREE.Vector3(0, 0, -CAMERA_DISTANCE).applyMatrix4(m);
    const up = new THREE.Vector3(0, -1, 0).transformDirection(m);
    this.camera.position.copy(position);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  private readonly onPointerDown=(event:PointerEvent):void=>{
    if(!event.isPrimary||event.button!==0||this.pointerId!==null)return;
    event.preventDefault();this.pointerId=event.pointerId;this.canvas.setPointerCapture(event.pointerId);
    this.rotation.begin(event.clientX,this.width,performance.now());
  };
  private readonly onPointerMove=(event:PointerEvent):void=>{if(event.pointerId===this.pointerId)this.rotation.move(event.clientX);};
  private readonly onPointerUp=(event:PointerEvent):void=>{
    if(event.pointerId!==this.pointerId)return;this.pointerId=null;
    this.rotation.end(event.clientX,performance.now());if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);
  };
  private readonly onPointerCancel=(event:PointerEvent):void=>{if(event.pointerId===this.pointerId)this.cancelDrag();};
  private cancelDrag():void{const pointer=this.pointerId;this.pointerId=null;this.rotation.cancel(performance.now());if(pointer!==null&&this.canvas.hasPointerCapture(pointer))this.canvas.releasePointerCapture(pointer);}

  get hasTank(): boolean {
    return this.skin != null;
  }
}

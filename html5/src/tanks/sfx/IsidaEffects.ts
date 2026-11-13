import type { Body } from '../../physics/Body.ts';
// HealingGunGraphicEffect / HealingGunShaft / HealingGunSoundEffect from Narukami.
// Uses Gen 2's separate start/end/idle strips instead of reversing Gen 1's single ball.
import * as THREE from 'three';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { Sound3D, type Sound, type SoundManager, type SoundListener } from './Sound.ts';
import { loadAnimation, loadEffectTexture, type TextureAnimation, type EffectsScene, type GraphicEffect } from './SmokyEffects.ts';
import { AnimatedLightEffect, type LightFrame } from '../../render/DynamicLights.ts';
import { addShaderPatch } from '../../render/shaderHooks.ts';

type Mode = 'idle' | 'healing' | 'damage';
interface ModeAssets { start: TextureAnimation; end: TextureAnimation | null; shaft: THREE.Texture | null; sound: Sound }
type Assets = Record<Mode, ModeAssets>;

export class IsidaEffectFactory {
  static async load(base: string, mod: number, sounds: SoundManager): Promise<IsidaEffectFactory> {
    const frames = `${base}/multiframe/turrets/isida/m${mod}`;
    const images = `${base}/images/turrets/isida/m${mod}`;
    const [idle, healStart, healEnd, damageStart, damageEnd, healShaft, damageShaft, idleSound, healSound, damageSound] = await Promise.all([
      loadAnimation(`${frames}/idle_spark`, true), loadAnimation(`${frames}/heal_start`, true), loadAnimation(`${frames}/heal_end`, true),
      loadAnimation(`${frames}/damage_start`, true), loadAnimation(`${frames}/damage_end`, true),
      loadEffectTexture(`${images}/heal_shaft`, true), loadEffectTexture(`${images}/damage_shaft`, true),
      sounds.engine.load(`${base}/sounds/turrets/isida/idle.mp3`), sounds.engine.load(`${base}/sounds/turrets/isida/healing.mp3`),
      sounds.engine.load(`${base}/sounds/turrets/isida/damage.mp3`),
    ]);
    for (const texture of [healShaft, damageShaft]) {
      texture.wrapS = THREE.ClampToEdgeWrapping; texture.wrapT = THREE.RepeatWrapping;
      // Atlas frames must not bleed into neighbours through mip levels.
      texture.generateMipmaps = false; texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
    }
    return new IsidaEffectFactory({ idle: { start: idle, end: null, shaft: null, sound: idleSound },
      healing: { start: healStart, end: healEnd, shaft: healShaft, sound: healSound },
      damage: { start: damageStart, end: damageEnd, shaft: damageShaft, sound: damageSound } }, sounds);
  }
  private constructor(private readonly assets: Assets, private readonly sounds: SoundManager) {}
  create(scene: EffectsScene): IsidaEffect { return new IsidaEffect(this.assets, this.sounds, scene); }
}

export class IsidaEffect implements GraphicEffect {
  private readonly from = new Vector3();
  private readonly endpoint = new Vector3();
  private readonly smoothed = new Vector3();
  private readonly oldPoint = new Vector3();
  private smoothPosition = 1;
  private targetBody: Body | null = null;
  private readonly localPoint = new Vector3();
  private readonly camera = new Vector3();
  private readonly startSprite: THREE.Sprite;
  private readonly endSprite: THREE.Sprite;
  private readonly shaft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly uv = new Float32Array(42 * 2);
  private readonly vertices = new Float32Array(42 * 3);
  private mode: Mode = 'idle';
  private active = false;
  private dead = false;
  private disposed = false;
  private visibility = 0;
  private time = 0;
  private waveTime = 0;
  private sound: Sound3D | null = null;
  private light: AnimatedLightEffect | null = null;
  private lightTime = 0;
  private lightStarted = false;
  private beamLights: AnimatedLightEffect[] = [];
  private readonly attackFrameBlend = { value: 0 };
  setBuffedMode(_value: boolean): void { /* User reference: one beam, including double damage. */ }

  constructor(private readonly assets: Assets, sounds: SoundManager, scene: EffectsScene) {
    this.startSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: assets.idle.start.frameTexture(0), depthWrite: false, transparent: true, fog: false }));
    this.endSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: assets.damage.start.frameTexture(0), depthWrite: false, transparent: true, fog: false }));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.vertices, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    const indices: number[] = [];
    for (let i=0;i<20;i++) { const k=i*2; indices.push(k,k+2,k+3,k,k+3,k+1); }
    geometry.setIndex(indices);
    this.shaft = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    addShaderPatch(this.shaft.material, 'isida-attack-frame-blend', shader => {
      shader.uniforms.isidaAttackFrameBlend = this.attackFrameBlend;
      shader.fragmentShader = 'uniform float isidaAttackFrameBlend;\n' + shader.fragmentShader.replace(
        '#include <map_fragment>',
        THREE.ShaderChunk.map_fragment.replace('diffuseColor *= sampledDiffuseColor;', `
          if (isidaAttackFrameBlend > 0.0) {
            vec4 nextFrame = texture2D(map, vec2(fract(vMapUv.x + 0.2), vMapUv.y));
            vec3 rgb = mix(sampledDiffuseColor.rgb * sampledDiffuseColor.a, nextFrame.rgb * nextFrame.a, isidaAttackFrameBlend);
            float alpha = mix(sampledDiffuseColor.a, nextFrame.a, isidaAttackFrameBlend);
            sampledDiffuseColor = vec4(rgb / max(alpha, 0.0001), alpha);
          }
          diffuseColor *= sampledDiffuseColor;
        `),
      );
    });
    for (const object of [this.startSprite, this.endSprite, this.shaft]) {
      object.frustumCulled = false; object.renderOrder = 10; object.visible = false; scene.parent.add(object);
    }
    scene.addGraphicEffect(this);
    sounds.addEffect({ enabled: true, get numSounds() { return owner.dead ? 0 : 1; },
      play: (_delta: number, listener: SoundListener) => this.sound?.checkVolume(listener.position, this.from, listener.xAxis),
      destroy: () => this.sound?.stop() });
    const owner = this;
  }

  aim(from: Vector3, _direction: Vector3): void { this.from.copy(from); }
  setTarget(point: Vector3 | null, healing: boolean, body: Body | null = null): void {
    const changedTarget = this.targetBody !== body;
    this.targetBody = body;
    const mode: Mode = point ? (healing ? 'healing' : 'damage') : 'idle';
    if (mode !== this.mode || changedTarget || !this.sound) {
      this.mode = mode; this.visibility = 0; this.waveTime = 0;
      this.sound?.stop(); this.sound = new Sound3D(this.assets[mode].sound, 1000, 2000, 2, 1);
      if (this.active) this.sound.play(200, 100000);
      this.shaft.material.map = this.assets[mode].shaft; this.shaft.material.needsUpdate = true;
      this.light?.destroy(); this.light = null; this.lightTime = 0; this.lightStarted = false;
      this.beamLights.forEach(light => light.destroy()); this.beamLights = [];
    }
    if (point && (changedTarget || !body)) {
      const local = point.clone();
      if (body) {
        const m=body.baseMatrix, p=body.state.position;
        const x=local.x-p.x, y=local.y-p.y, z=local.z-p.z;
        local.reset(m.a*x+m.e*y+m.i*z,m.b*x+m.f*y+m.j*z,m.c*x+m.g*y+m.k*z);
      }
      if (changedTarget) {
        this.localPoint.copy(local); this.oldPoint.copy(local); this.smoothPosition=1;
      } else if (new Vector3().diff(local,this.endpoint).lengthSqr()>100) {
        this.oldPoint.copy(this.localPoint); this.smoothPosition=0;
      }
      this.endpoint.copy(local);
    }
  }

  start(): void { this.active = true; this.setTarget(null, false); }
  stop(): void { this.active = false; this.dead = true; this.sound?.stop(); }

  play(delta: number, cameraPosition: Vector3): boolean {
    if (this.disposed) return false;
    this.visibility = Math.max(0, Math.min(1, this.visibility + (this.active ? 1 : -1) * 13 * delta / 1000));
    if (this.dead && this.visibility <= 0) return false;
    this.time += delta; this.waveTime += delta; this.camera.copy(cameraPosition);
    const scale = 0.2 + 0.8 * this.visibility;
    const data = this.assets[this.mode];
    const animate = (sprite: THREE.Sprite, animation: TextureAnimation): void => {
      const index = Math.floor(this.time * animation.fps / 1000) % animation.frames.length;
      sprite.material.map = animation.frameTexture(index);
    };
    animate(this.startSprite, data.start);
    this.startSprite.visible = true; this.startSprite.position.set(this.from.x,this.from.y,this.from.z);
    this.startSprite.scale.set(150*scale,150*scale,1); this.startSprite.material.opacity = this.visibility;
    this.endSprite.visible = this.shaft.visible = this.mode !== 'idle';
    if (data.end && data.shaft) {
      this.smoothPosition = Math.min(1, this.smoothPosition + 0.1);
      this.localPoint.copy(this.oldPoint).scale(1-this.smoothPosition).addScaled(this.smoothPosition,this.endpoint);
      if (this.targetBody) {
        this.targetBody.baseMatrix.transformVector(this.localPoint,this.smoothed);
        this.smoothed.add(this.targetBody.state.position);
      } else this.smoothed.copy(this.localPoint);
      animate(this.endSprite,data.end); this.endSprite.position.set(this.smoothed.x,this.smoothed.y,this.smoothed.z);
      this.endSprite.scale.set(150*scale,150*scale,1); this.endSprite.material.opacity = this.visibility;
      this.updateShaft(scale);
    }
    this.lightTime += delta;
    if (this.active && this.lightTime >= (this.lightStarted ? 600 : 300)) { this.light?.destroy(); this.light = null; this.lightTime = 0; this.lightStarted = true;
      this.beamLights.forEach(light => light.destroy()); this.beamLights = []; }
    if (this.active && !this.light) {
      const color = this.mode === 'damage' ? 0xfd4210 : this.mode === 'healing' ? 0x00ffaa : 0x00ff55;
      const frames: LightFrame[] = [{attenuationBegin:200,attenuationEnd:400,color,intensity:this.mode==='idle'?1:0.7,time:0},
        {attenuationBegin:100,attenuationEnd:300,color,intensity:this.mode==='idle'?1:0.7,time:300},
        {attenuationBegin:200,attenuationEnd:400,color,intensity:this.mode==='idle'?1:0.7,time:600}];
      const startFrames: LightFrame[] = [{attenuationBegin:1,attenuationEnd:2,color,intensity:0,time:0}, {...frames[0],time:300}];
      this.light = new AnimatedLightEffect(this.lightStarted ? frames : startFrames, () => this.from);
      if (this.mode !== 'idle') for (const t of [0.33,0.67]) {
        this.beamLights.push(new AnimatedLightEffect(frames, () => this.from.clone().scale(1-t).addScaled(t,this.smoothed)));
      }
    }
    this.light?.play(delta); this.beamLights.forEach(light => light.play(delta));
    return true;
  }

  private updateShaft(scale: number): void {
    const d = new Vector3().diff(this.smoothed,this.from); const length = Math.max(10,d.length()); d.normalize();
    const side = new Vector3().cross2(d,new Vector3().diff(this.camera,this.from)).normalize();
    const direction = this.mode === 'healing' ? 1 : -1;
    const seconds = this.waveTime / 1000;
    // The five columns are successive animation frames of one beam.
    const attack = this.mode === 'damage';
    const animation = this.waveTime * (attack ? 12 : 30) / 1000;
    const frame = Math.floor(animation) % 5;
    const fraction = animation % 1;
    this.attackFrameBlend.value = attack ? fraction * fraction * (3 - 2 * fraction) : 0;
    const width = attack ? 195 : 120, segment = 600;
      for(let i=0;i<=20;i++) {
        const y = length-i*length/20, centered=length/2-y;
        const fade = Math.min(1,Math.min(y,length-y)/200);
        const wave1 = 750, wave2 = 450;
        const bend = -(Math.sin(2*Math.PI*(centered+direction*450*seconds)/wave1)
          +Math.sin(2*Math.PI*(centered+direction*400*seconds)/wave2))*10*fade;
        for(let j=0;j<2;j++) {
          const k=i*2+j, x=((j===0?-width/2:width/2)+bend)*scale;
          this.vertices[k*3]=this.from.x+d.x*y+side.x*x;
          this.vertices[k*3+1]=this.from.y+d.y*y+side.y*x;
          this.vertices[k*3+2]=this.from.z+d.z*y+side.z*x;
          this.uv[k*2]=(frame+(j===0?0.005:0.995))/5;
          this.uv[k*2+1]=centered/segment+direction*(800/segment)*seconds;
        }
      }
    this.shaft.geometry.attributes.position.needsUpdate=true; this.shaft.geometry.attributes.uv.needsUpdate=true;
    this.shaft.material.opacity=this.visibility;
  }
  destroy(): void {
    if(this.disposed)return; this.disposed=true; this.dead=true; this.sound?.stop(); this.light?.destroy(); this.beamLights.forEach(light=>light.destroy());
    for(const object of [this.startSprite,this.endSprite,this.shaft]) { object.removeFromParent(); object.material.dispose(); }
    this.shaft.geometry.dispose();
  }
}

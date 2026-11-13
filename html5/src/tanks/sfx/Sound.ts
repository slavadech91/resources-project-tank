// Звук боя: flash.media.Sound/SoundChannel на Web Audio и порты alternativa/tanks/sfx
// Sound3D, SoundOptions, Sound3DEffect, EngineSounds, TankSounds и models/battle/battlefield/AmbientSound.
import { Vector3 } from '../../physics/math/Vector3.ts';

/** Камера для звука: позиция §2J§ и ось X §+"8§ (GameCamera) */
export interface SoundListener {
  readonly position: Vector3;
  readonly xAxis: Vector3;
}

/** Общий AudioContext. Браузер запускает звук только после действия пользователя. */
export class AudioEngine {
  readonly context = new AudioContext();
  readonly output: AudioNode;
  private readonly buffers = new Map<string, Promise<Sound>>();
  private readonly channels = new Set<SoundChannel>();
  playbackEnabled = true;

  constructor() {
    // во Flash громкость >1 усиливает сигнал (холостой ход двигателя играет с громкостью 2..6):
    // компрессор не даёт таким звукам хрипеть при клиппинге
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.connect(this.context.destination);
    this.output = limiter;
    const resume = (): void => {
      if (this.muted_ || this.context.state != 'suspended') return;
      void this.context.resume();
    };
    window.addEventListener('keydown', resume, true);
    window.addEventListener('pointerdown', resume, true);
  }

  private muted_ = false;

  /** кнопка звука в верхней панели (MainPanelSoundButton): выключает весь звук игры */
  get muted(): boolean {
    return this.muted_;
  }

  set muted(value: boolean) {
    this.muted_ = value;
    if (value) void this.context.suspend();
    else void this.context.resume();
  }

  load(url: string): Promise<Sound> {
    let sound = this.buffers.get(url);
    if (!sound) {
      sound = fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then((data) => this.context.decodeAudioData(data))
        .then((buffer) => new Sound(this, buffer))
        .catch((error: unknown) => {
          console.warn('звук не загружен', url, error);
          return new Sound(this, null);
        });
      this.buffers.set(url, sound);
    }
    return sound;
  }

  track(channel: SoundChannel): void {
    this.channels.add(channel);
  }

  release(channel: SoundChannel): void {
    this.channels.delete(channel);
  }

  stopAll(): void {
    for (const channel of this.channels) channel.stop();
  }
}

/** flash.media.SoundTransform */
export class SoundTransform {
  constructor(
    public volume = 1,
    public pan = 0,
  ) {}
}

/** flash.media.Sound */
export class Sound {
  constructor(
    private readonly engine: AudioEngine,
    private readonly buffer: AudioBuffer | null,
  ) {}

  /** Sound.play(startTime мс, loops): при loops > 1 звук повторяется с startTime */
  play(startTime = 0, loops = 0, transform: SoundTransform | null = null): SoundChannel | null {
    if (this.buffer == null || !this.engine.playbackEnabled) return null;
    return new SoundChannel(this.engine, this.buffer, startTime / 1000, loops > 1, transform ?? new SoundTransform());
  }
}

/** flash.media.SoundChannel */
export class SoundChannel {
  private readonly source: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private readonly panner: StereoPannerNode;
  private stopped = false;
  /** Event.SOUND_COMPLETE */
  onComplete: (() => void) | null = null;

  constructor(private readonly engine: AudioEngine, buffer: AudioBuffer, offset: number, loop: boolean, transform: SoundTransform) {
    const context = engine.context;
    this.source = context.createBufferSource();
    this.source.buffer = buffer;
    this.gain = context.createGain();
    this.panner = context.createStereoPanner();
    this.source.connect(this.gain).connect(this.panner).connect(engine.output);
    if (loop) {
      this.source.loop = true;
      this.source.loopStart = offset;
      this.source.loopEnd = buffer.duration;
    }
    this.soundTransform = transform;
    this.source.onended = () => {
      if (this.stopped) return;
      const complete = this.onComplete;
      this.release();
      complete?.();
    };
    this.source.start(0, Math.min(offset, buffer.duration));
    engine.track(this);
  }

  set soundTransform(transform: SoundTransform) {
    this.gain.gain.value = transform.volume;
    this.panner.pan.value = Math.max(-1, Math.min(1, transform.pan));
  }

  stop(): void {
    if (this.stopped) return;
    this.source.onended = null;
    this.source.stop();
    this.release();
  }

  private release(): void {
    this.stopped = true;
    this.source.onended = null;
    this.onComplete = null;
    this.source.disconnect();
    this.gain.disconnect();
    this.panner.disconnect();
    this.engine.release(this);
  }
}

/** SoundOptions: ближняя и дальняя дистанция, затухание на дальней */
export const SoundOptions = {
  nearRadius: 1000, // §"!R§
  farRadius: 5000, // §%!?§
  farDelimiter: 5, // §`!I§
};

/** Sound3D: громкость и панорама по расстоянию до камеры */
export class Sound3D {
  private sound: Sound; // §9!m§
  private channel_: SoundChannel | null = null; // §!!2§
  private readonly transform = new SoundTransform(0); // §`"1§
  private nearRadius = 0; // §"!R§
  private distanceCoeff = 0; // §#!C§
  private volume_ = 1; // §18§
  private baseVolume_ = 1; // §'!@§
  private effectiveVolume = 1; // § !%§

  constructor(sound: Sound, nearRadius: number, farRadius: number, farDelimiter: number, baseVolume: number) {
    this.sound = sound;
    this.init(sound, nearRadius, farRadius, farDelimiter, baseVolume);
  }

  init(sound: Sound, nearRadius: number, farRadius: number, farDelimiter: number, baseVolume: number): void {
    this.sound = sound;
    this.nearRadius = nearRadius;
    this.baseVolume_ = baseVolume;
    this.distanceCoeff = (Math.sqrt(farDelimiter) - 1) / (farRadius - nearRadius);
    this.volume = 1;
  }

  isPlaying(): boolean {
    return this.channel_ != null;
  }

  get channel(): SoundChannel | null {
    return this.channel_;
  }

  get baseVolume(): number {
    return this.baseVolume_;
  }

  set baseVolume(value: number) {
    this.baseVolume_ = value;
    this.updateEffectiveVolume();
  }

  get volume(): number {
    return this.volume_;
  }

  set volume(value: number) {
    this.volume_ = value;
    this.updateEffectiveVolume();
  }

  calculateSoundProperties(listenerPosition: Vector3, soundPosition: Vector3, listenerXAxis: Vector3, result: SoundTransform): void {
    let dx = soundPosition.x - listenerPosition.x;
    let dy = soundPosition.y - listenerPosition.y;
    let dz = soundPosition.z - listenerPosition.z;
    let distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < this.nearRadius) {
      result.volume = 1;
      result.pan = 0;
    } else {
      let volume = 1 + this.distanceCoeff * (distance - this.nearRadius);
      volume = 1 / (volume * volume);
      result.volume = volume;
      distance = 1 / distance;
      dx *= distance;
      dy *= distance;
      dz *= distance;
      result.pan = (dx * listenerXAxis.x + dy * listenerXAxis.y + dz * listenerXAxis.z) * (1 - volume);
    }
  }

  checkVolume(listenerPosition: Vector3, soundPosition: Vector3, listenerXAxis: Vector3, gain = 1): void {
    if (this.channel_ != null) {
      this.calculateSoundProperties(listenerPosition, soundPosition, listenerXAxis, this.transform);
      this.transform.volume *= this.effectiveVolume * gain;
      this.channel_.soundTransform = this.transform;
    }
  }

  play(startTime: number, loops: number): SoundChannel | null {
    if (this.channel_ != null) this.channel_.stop();
    return (this.channel_ = this.sound.play(startTime, loops));
  }

  stop(): void {
    if (this.channel_ != null) {
      this.channel_.stop();
      this.channel_ = null;
    }
  }

  private updateEffectiveVolume(): void {
    this.effectiveVolume = this.baseVolume_ * this.volume_;
  }
}

/** ISound3DEffect */
export interface Sound3DEffectLike {
  play(delta: number, listener: SoundListener): void;
  destroy(): void;
  enabled: boolean;
  readonly numSounds: number;
}

/** Sound3DEffect: одиночный звук в точке, с задержкой запуска */
export class Sound3DEffect implements Sound3DEffectLike {
  private readonly position = new Vector3(); // §2J§
  private delay: number; // §3T§
  private channel: SoundChannel | null = null; // §`!C§
  private enabled_ = false; // §>"&§
  private started = false; // §&?§

  constructor(
    position: Vector3,
    private readonly sound: Sound3D,
    delay = 0,
    private readonly startTime = 0,
  ) {
    this.position.copy(position);
    this.delay = delay;
  }

  play(delta: number, listener: SoundListener): void {
    this.delay -= delta;
    if (this.delay > 0) return;
    if (!this.started) {
      this.started = true;
      this.channel = this.sound.play(this.startTime, 1);
      if (this.channel == null) {
        this.onSoundComplete();
        return;
      }
      this.channel.onComplete = () => this.onSoundComplete();
    }
    this.sound.checkVolume(listener.position, this.position, listener.xAxis);
  }

  destroy(): void {
    this.sound.stop();
    this.onSoundComplete();
  }

  set enabled(value: boolean) {
    if (this.enabled_ == value) return;
    this.enabled_ = value;
    if (!value) this.onSoundComplete();
  }

  get enabled(): boolean {
    return this.enabled_;
  }

  get numSounds(): number {
    return this.enabled_ ? 1 : 0;
  }

  private onSoundComplete(): void {
    if (this.channel != null) this.channel.onComplete = null;
    this.enabled_ = false;
    this.channel = null;
  }
}

/** SoundManager (упрощённо): эффекты живут, пока звучат; без ограничения числа одновременных звуков */
export class SoundManager {
  private readonly effects: Sound3DEffectLike[] = [];

  constructor(readonly engine: AudioEngine) {}

  playSound(sound: Sound, startTime = 0, loops = 0, transform: SoundTransform | null = null): SoundChannel | null {
    return sound.play(startTime, loops, transform);
  }

  stopSound(channel: SoundChannel): void {
    channel.stop();
  }

  addEffect(effect: Sound3DEffectLike): void {
    effect.enabled = true;
    this.effects.push(effect);
  }

  stopAll(): void {
    for (const effect of this.effects) effect.destroy();
    this.effects.length = 0;
    this.engine.stopAll();
  }

  update(delta: number, listener: SoundListener): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      effect.play(delta, listener);
      if (effect.numSounds == 0) {
        effect.destroy();
        this.effects.splice(i, 1);
      }
    }
  }
}

/** AmbientSound: фон карты, громкость 0.5 */
export class AmbientSound {
  private channel: SoundChannel | null = null; // §`!7§

  constructor(
    private readonly sound: Sound,
    private readonly soundManager: SoundManager,
  ) {}

  play(enabled: boolean): void {
    if (enabled) {
      if (this.channel == null) this.channel = this.soundManager.playSound(this.sound, 0, 100000, new SoundTransform(0.5));
    } else if (this.channel != null) {
      this.soundManager.stopSound(this.channel);
      this.channel = null;
    }
  }
}

const enum EngineMode {
  SILENT = 0, // §-!c§
  IDLE = 1, // §'!?§
  ACCELERATION = 2, // §+!^§
  MOVING = 3, // §`!%§
  TURNING = 4, // §#l§
}

/** скорость затухания при переходе на холостой ход, в 1/мс (§["B§) */
const FADE_SPEED = 0.001;

/** EngineSounds: холостой ход, разгон (один раз), движение (по кругу) */
export class EngineSounds {
  private mode = EngineMode.SILENT; // §8Y§
  private current: Sound3D; // §#"Y§
  private readonly idleSound: Sound3D; // §0w§
  private readonly startMovingSound: Sound3D; // §?!H§
  private readonly movingSound: Sound3D; // §!v§
  private startMovingChannel: SoundChannel | null = null; // §`!C§
  private fading = false; // §]M§
  private fadeTargetVolume = 1; // §4!&§
  private nextSound: Sound3D | null = null; // §?!;§

  constructor(idle: Sound, startMoving: Sound, moving: Sound) {
    const near = SoundOptions.nearRadius;
    const far = SoundOptions.farRadius;
    const delimiter = SoundOptions.farDelimiter;
    this.idleSound = new Sound3D(idle, near, far, delimiter, 2);
    this.startMovingSound = new Sound3D(startMoving, near, far, delimiter, 1);
    this.movingSound = new Sound3D(moving, near, far, delimiter, 1);
    this.current = this.idleSound;
  }

  update(delta: number, listenerPosition: Vector3, soundPosition: Vector3, listenerXAxis: Vector3, gain = 1): void {
    if (this.mode == EngineMode.SILENT) return;
    if (this.fading) {
      this.current.volume -= FADE_SPEED * delta;
      if (this.current.volume < this.fadeTargetVolume) {
        this.fading = false;
        this.stop();
        this.current = this.idleSound;
        this.current.volume = this.mode == EngineMode.IDLE ? 2 : 3;
        this.current.play(0, 10000);
      }
    }
    if (this.nextSound != null) {
      this.startMovingChannel = null;
      this.current.stop();
      this.current = this.nextSound;
      this.current.volume = 1;
      this.current.play(0, 10000);
      this.nextSound = null;
    }
    this.current.checkVolume(listenerPosition, soundPosition, listenerXAxis, gain);
  }

  setSilentMode(): void {
    if (this.mode != EngineMode.SILENT) {
      this.mode = EngineMode.SILENT;
      this.fading = false;
      this.nextSound = null;
      this.stop();
    }
  }

  setIdleMode(): void {
    if (this.mode != EngineMode.IDLE) {
      if (this.mode == EngineMode.SILENT) {
        this.current = this.idleSound;
        this.current.volume = 1;
        this.current.play(0, 1000);
      } else {
        this.fading = true;
        this.fadeTargetVolume = 0.2;
      }
      this.mode = EngineMode.IDLE;
    }
  }

  setAccelerationMode(): void {
    if (this.mode == EngineMode.ACCELERATION || this.mode == EngineMode.MOVING) return;
    this.fading = false;
    this.mode = EngineMode.ACCELERATION;
    this.current.stop();
    this.current = this.startMovingSound;
    this.current.volume = 1;
    this.startMovingChannel = this.current.play(0, 0);
    if (this.startMovingChannel != null) this.startMovingChannel.onComplete = () => this.soundComplete();
  }

  setTurningMode(): void {
    if (this.mode != EngineMode.TURNING) {
      if (this.mode == EngineMode.SILENT) {
        this.current = this.idleSound;
        this.current.volume = 3;
        this.current.play(0, 1000);
      } else if (this.mode == EngineMode.IDLE) {
        if (!this.fading) this.current.volume = 3;
      } else {
        this.fading = true;
      }
      this.fadeTargetVolume = 0.6;
      this.mode = EngineMode.TURNING;
    }
  }

  stop(): void {
    if (this.startMovingChannel != null) {
      this.startMovingChannel.onComplete = null;
      this.startMovingChannel = null;
    }
    this.current.stop();
  }

  private soundComplete(): void {
    if (this.startMovingChannel == null || this.mode != EngineMode.ACCELERATION) return;
    this.startMovingChannel.onComplete = null;
    this.mode = EngineMode.MOVING;
    this.movingSound.volume = this.startMovingSound.volume;
    this.nextSound = this.movingSound;
  }
}

/** TankSounds: двигатель и поворот башни */
export class TankSounds {
  private readonly engine: EngineSounds; // §&"1§
  private readonly turretSound: Sound3D; // §4"0§
  private mode = EngineMode.IDLE; // §'"C§
  private enabled_ = false; // §>"&§
  private turretSoundEnabled_ = false; // §,r§
  private readonly position = new Vector3(); // §<!u§

  static async load(engine: AudioEngine): Promise<TankSounds> {
    const [idle, startMoving, moving, turret] = await Promise.all(
      ['engine_idle', 'engine_start_moving', 'engine_moving', 'turret_rotation'].map(
        (name) => engine.load(`battle/sounds/tank/${name}.mp3`),
      ),
    );
    return new TankSounds(idle, startMoving, moving, turret);
  }

  constructor(idle: Sound, startMoving: Sound, moving: Sound, turret: Sound) {
    this.engine = new EngineSounds(idle, startMoving, moving);
    this.turretSound = new Sound3D(turret, 500, 2000, 5, 0.5);
  }

  setIdleMode(): void {
    this.mode = EngineMode.IDLE;
    if (this.enabled_) this.engine.setIdleMode();
  }

  setAccelerationMode(): void {
    this.mode = EngineMode.ACCELERATION;
    if (this.enabled_) this.engine.setAccelerationMode();
  }

  setTurningMode(): void {
    this.mode = EngineMode.TURNING;
    if (this.enabled_) this.engine.setTurningMode();
  }

  playTurretSound(rotating: boolean,volume=1): void {
    this.turretSound.volume=volume;
    if (!this.enabled_) return;
    if (rotating && this.turretSoundEnabled_) {
      if (!this.turretSound.isPlaying()) {
        const channel = this.turretSound.play(100, 0);
        if (channel != null) channel.onComplete = () => this.onTurretSoundComplete();
      }
    } else if (this.turretSound.isPlaying()) {
      this.turretSound.stop();
    }
  }

  private onTurretSoundComplete(): void {
    if (this.turretSoundEnabled_) this.turretSound.play(3000, 9999);
  }

  set turretSoundEnabled(value: boolean) {
    if (this.turretSoundEnabled_ != value) {
      this.turretSoundEnabled_ = value;
      if (!value) this.turretSound.stop();
    }
  }

  /** play: позиция звука — центр тела танка */
  play(delta: number, listener: SoundListener, bodyPosition: Vector3, gain = 1): void {
    if (!this.enabled_) return;
    this.position.copy(bodyPosition);
    this.engine.update(delta, listener.position, this.position, listener.xAxis, gain);
    this.turretSound.checkVolume(listener.position, this.position, listener.xAxis);
  }

  set enabled(value: boolean) {
    if (this.enabled_ != value) {
      this.enabled_ = value;
      this.updateSounds();
    }
  }

  get enabled(): boolean {
    return this.enabled_;
  }

  private updateSounds(): void {
    if (this.enabled_) {
      switch (this.mode) {
        case EngineMode.IDLE:
          this.engine.setIdleMode();
          break;
        case EngineMode.ACCELERATION:
          this.engine.setAccelerationMode();
          break;
        case EngineMode.TURNING:
          this.engine.setTurningMode();
      }
    } else {
      this.turretSound.stop();
      this.engine.setSilentMode();
    }
  }
}

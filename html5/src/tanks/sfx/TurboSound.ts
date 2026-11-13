// Турбонаддув корпуса Varan: синтез на Web Audio поверх сэмплов двигателя (EngineSounds), только у своего танка.
// Звук двигателя в игре — сэмплы без оборотов, поэтому «обороты» оцениваются по скорости танка и газу:
// наддув набирается с задержкой (турбояма), вал турбины раскручивается и тормозит с инерцией,
// свист (два тона) и шум воздуха следуют за валом, при сбросе газа на наддуве — звук сброса по варианту
// (без помпажа «сутутуту»). Вариант выбирается в настройках («Звук турбины Varan»), переключается на лету.
import type { AudioEngine } from './Sound.ts';
import { Sound, Sound3D, SoundOptions, SoundTransform } from './Sound.ts';
import type { Vector3 } from '../../physics/math/Vector3.ts';
import type { SoundListener } from './Sound.ts';

/** звук при сбросе газа на наддуве: шум через фильтр с понижением частоты */
interface LiftSound {
  /** bandpass — «тсс» клапана, lowpass — глухой «ффух» перепуска */
  filter: BiquadFilterType;
  /** частота фильтра в начале и в конце, Гц */
  from: number;
  to: number;
  q: number;
  /** срез низких частот, Гц (0 — без него) */
  highpass: number;
  /** длительность спада, с */
  decay: number;
  /** громкость на полном наддуве */
  peak: number;
}

export interface TurboPreset {
  name: string;
  /** свист вала, Гц: от холостых до полного наддува */
  whineMin: number;
  whineMax: number;
  /** второй тон: отношение частот, форма; основной тон — синус */
  harmonic: number;
  harmonicType: OscillatorType;
  whineGain: number;
  harmonicGain: number;
  /** постоянные времени, с: набор и спад наддува, раскрутка и выбег вала */
  boostRise: number;
  boostFall: number;
  shaftRise: number;
  shaftFall: number;
  /** шум воздуха на впуске: центр фильтра по валу, добротность, громкость */
  airMin: number;
  airMax: number;
  airQ: number;
  airGain: number;
  /** звук сброса газа (null — нет, свист просто затихает) */
  lift: LiftSound | null;
  /** общая громкость относительно двигателя */
  volume: number;
}

/** варианты 1–3 (0 — выключено) */
export const TURBO_PRESETS: TurboPreset[] = [
  {
    // бензиновая спортивная: звонкий свист, короткий резкий «тсс» клапана
    name: 'Спорт',
    whineMin: 2200,
    whineMax: 8000,
    harmonic: 2.01,
    harmonicType: 'triangle',
    whineGain: 0.3,
    harmonicGain: 0.07,
    boostRise: 0.45,
    boostFall: 0.15,
    shaftRise: 0.3,
    shaftFall: 1.2,
    airMin: 1200,
    airMax: 5500,
    airQ: 1.4,
    airGain: 0.4,
    lift: { filter: 'bandpass', from: 5200, to: 3000, q: 1.2, highpass: 2500, decay: 0.22, peak: 0.8 },
    volume: 0.5,
  },
  {
    // большая турбина дизеля: низкий свист, долгая турбояма и выбег, мощный впуск, глухой «ффух» перепуска
    name: 'Дизель',
    whineMin: 1100,
    whineMax: 4200,
    harmonic: 1.5,
    harmonicType: 'sine',
    whineGain: 0.26,
    harmonicGain: 0.1,
    boostRise: 0.9,
    boostFall: 0.35,
    shaftRise: 0.6,
    shaftFall: 2.2,
    airMin: 500,
    airMax: 2600,
    airQ: 0.7,
    airGain: 0.6,
    lift: { filter: 'lowpass', from: 900, to: 250, q: 0.7, highpass: 0, decay: 0.6, peak: 0.55 },
    volume: 0.5,
  },
  {
    // маленькая быстрая турбина: тонкий чистый свист, без сброса — свист просто быстро затихает
    name: 'Компакт',
    whineMin: 3500,
    whineMax: 11000,
    harmonic: 3.0,
    harmonicType: 'sine',
    whineGain: 0.28,
    harmonicGain: 0.03,
    boostRise: 0.25,
    boostFall: 0.12,
    shaftRise: 0.18,
    shaftFall: 0.8,
    airMin: 2000,
    airMax: 7000,
    airQ: 1.8,
    airGain: 0.22,
    lift: null,
    volume: 0.5,
  },
];

/** порог наддува для звука сброса */
const LIFT_THRESHOLD = 0.4;

let variant = 1;

/** вариант звука: 0 — выключен, 1..3 — TURBO_PRESETS */
export function setTurboVariant(value: number): void {
  variant = Math.max(0, Math.min(TURBO_PRESETS.length, Math.round(value)));
}

export class TurboSound {
  private readonly context: AudioContext;
  private readonly output: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly whine: OscillatorNode;
  private readonly whine2: OscillatorNode;
  private readonly whineGain: GainNode;
  private readonly whine2Gain: GainNode;
  private readonly airFilter: BiquadFilterNode;
  private readonly airGain: GainNode;
  private readonly noise: AudioBuffer;
  private readonly noiseSource: AudioBufferSourceNode;
  private readonly distance = new Sound3D(new Sound(null as unknown as AudioEngine, null), SoundOptions.nearRadius, SoundOptions.farRadius, SoundOptions.farDelimiter, 1);
  private readonly transform = new SoundTransform();
  private boost = 0;
  private shaft = 0;
  private time = 0;
  private wasOnThrottle = false;

  constructor(engine: AudioEngine) {
    const context = (this.context = engine.context);
    this.panner = context.createStereoPanner();
    this.output = context.createGain();
    this.output.gain.value = 0;
    this.output.connect(this.panner).connect(engine.output);

    // свист крыльчатки: основной тон и второй тон
    this.whine = context.createOscillator();
    this.whine.type = 'sine';
    this.whine2 = context.createOscillator();
    this.whineGain = context.createGain();
    this.whine2Gain = context.createGain();
    this.whineGain.gain.value = 0;
    this.whine2Gain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.output);
    this.whine2.connect(this.whine2Gain).connect(this.output);

    // шум воздуха на впуске: белый шум через полосовой фильтр, центр следует за валом
    this.noise = TurboSound.createNoise(context);
    this.noiseSource = context.createBufferSource();
    this.noiseSource.buffer = this.noise;
    this.noiseSource.loop = true;
    this.airFilter = context.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airGain = context.createGain();
    this.airGain.gain.value = 0;
    this.noiseSource.connect(this.airFilter).connect(this.airGain).connect(this.output);

    this.whine.start();
    this.whine2.start();
    this.noiseSource.start();
  }

  private static createNoise(context: BaseAudioContext): AudioBuffer {
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * delta, мс; throttle — газ 0..1 (поворот на месте — частичная нагрузка); speedRatio — скорость / максимальная;
   * enabled — двигатель звучит (танк в бою и жив)
   */
  update(delta: number, throttle: number, speedRatio: number, enabled: boolean, listener: SoundListener, position: Vector3): void {
    const preset = TURBO_PRESETS[variant - 1];
    const active = enabled && preset != null;
    const p = preset ?? TURBO_PRESETS[0];
    const dt = Math.min(delta, 100) / 1000;
    this.time += dt;
    const onThrottle = active && throttle > 0.5;
    // «обороты»: холостые 0.3, растут со скоростью и под нагрузкой
    const rpm = Math.min(1, 0.3 + 0.6 * Math.min(1, speedRatio) + (onThrottle ? 0.15 : 0));
    const target = active ? throttle * rpm ** 1.6 : 0;
    this.boost += (target - this.boost) * (1 - Math.exp(-dt / (target > this.boost ? p.boostRise : p.boostFall)));
    if (this.wasOnThrottle && !onThrottle && active && p.lift && this.boost > LIFT_THRESHOLD) this.liftOff(p.lift, this.boost);
    this.wasOnThrottle = onThrottle;
    const shaftTarget = active ? Math.max(this.boost, 0.12 * rpm) : 0;
    this.shaft += (shaftTarget - this.shaft) * (1 - Math.exp(-dt / (shaftTarget > this.shaft ? p.shaftRise : p.shaftFall)));

    const now = this.context.currentTime;
    const smooth = 0.03;
    // лёгкое «плавание» тона, как у настоящей крыльчатки
    const wobble = 1 + 0.004 * Math.sin(this.time * 23) + 0.002 * Math.sin(this.time * 61);
    const frequency = (p.whineMin + (p.whineMax - p.whineMin) * this.shaft) * wobble;
    if (this.whine2.type != p.harmonicType) this.whine2.type = p.harmonicType;
    this.whine.frequency.setTargetAtTime(frequency, now, smooth);
    this.whine2.frequency.setTargetAtTime(frequency * p.harmonic, now, smooth);
    this.whineGain.gain.setTargetAtTime(p.whineGain * this.shaft ** 2, now, smooth);
    this.whine2Gain.gain.setTargetAtTime(p.harmonicGain * this.shaft ** 3, now, smooth);
    this.airFilter.Q.setTargetAtTime(p.airQ, now, smooth);
    this.airFilter.frequency.setTargetAtTime(p.airMin + (p.airMax - p.airMin) * this.shaft, now, smooth);
    this.airGain.gain.setTargetAtTime(p.airGain * this.boost ** 1.5 + 0.1 * p.airGain * this.shaft, now, smooth);

    this.distance.calculateSoundProperties(listener.position, position, listener.xAxis, this.transform);
    this.output.gain.setTargetAtTime(active ? p.volume * this.transform.volume : 0, now, 0.05);
    this.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, this.transform.pan)), now, 0.05);
  }

  /** сброс газа: короткий шум с быстрой атакой, спадом и понижением фильтра */
  private liftOff(lift: LiftSound, boost: number): void {
    const context = this.context;
    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    let node: AudioNode = source;
    if (lift.highpass > 0) {
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = lift.highpass;
      node = node.connect(highpass);
    }
    const filter = context.createBiquadFilter();
    filter.type = lift.filter;
    filter.Q.value = lift.q;
    filter.frequency.setValueAtTime(lift.from, now);
    filter.frequency.exponentialRampToValueAtTime(lift.to, now + lift.decay);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(lift.peak * boost, now + 0.015);
    gain.gain.setTargetAtTime(0.0001, now + 0.03, lift.decay / 3);
    node.connect(filter).connect(gain).connect(this.output);
    source.start(now, Math.random());
    source.stop(now + lift.decay * 2 + 0.1);
    source.onended = () => source.disconnect();
  }

  dispose(): void {
    this.whine.stop();
    this.whine2.stop();
    this.noiseSource.stop();
    this.output.disconnect();
  }
}

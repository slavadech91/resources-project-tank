/**
 * Стенд синхронизации v2 без сервера (?offline&synctest=задержка,джиттер — мс в одну сторону): рядом со своим танком
 * появляется чужой, которого ведёт настоящий RemoteTank (кинематическое тело, буфер, задержка, поправка) по сэмплам
 * «владельца», едущего по окружности с остановками, через имитацию сети (задержка, джиттер, порядок TCP, редкие
 * залипания). Видно плавность, гусеницы и столкновения со своим танком; __tanki.syncTest() — статистика.
 */
import type * as THREE from 'three';
import { Quaternion } from '../../../physics/math/Quaternion.ts';
import { Vector3 } from '../../../physics/math/Vector3.ts';
import type { TankDemo } from '../../TankDemo.ts';
import { TankSkin } from '../../render/TankSkin.ts';
import { RemoteTank } from '../RemoteTank.ts';
import { InterpolatedState, InterpolationDelay, StateBuffer } from './StateBuffer.ts';
import type { SyncSample } from './SyncProtocol.ts';

const RADIUS = 900;
const SPEED = 700;
const SEND_INTERVAL_MS = 50;
const SNAPSHOT_INTERVAL_MS = 50;
const STALL_CHANCE = 0.003;
const STALL_MS = 300;

export interface SyncTestBench {
  stats(): string;
  dispose(): void;
}

export async function startSyncTestBench(demo: TankDemo, world: THREE.Object3D, latencyMs: number, jitterMs: number): Promise<SyncTestBench> {
  const skin = await TankSkin.load('tank_parts/hulls/hunter/m0', 'tank_parts/turrets/smoky/m0', 'tank_parts/paints/green.jpg');
  const buffer = new StateBuffer();
  const delay = new InterpolationDelay();
  const remote = new RemoteTank(1, skin, world, demo.runner, buffer, (physicsTime) => physicsTime - delay.current);
  // окружность перед своим танком (по оси +Y корпуса), чтобы чужой танк ездил в кадре
  const body = demo.tank.getBody();
  const start = body.state.position.clone();
  const forward = new Vector3(body.baseMatrix.b, body.baseMatrix.f, 0).normalize();
  const center = new Vector3(start.x + forward.x * (RADIUS + 700), start.y + forward.y * (RADIUS + 700), start.z);
  const started = performance.now();

  /** путь «владельца»: окружность, каждые 6 с — остановка на 1,5 с; башня качается */
  const truth = (time: number): { position: Vector3; velocity: Vector3; heading: number; turn: number; turret: number; moving: boolean } => {
    const t = (time - started) / 1000;
    const cycle = t % 6;
    const laps = Math.floor(t / 6);
    // путь вдоль окружности: 4,5 с езды на цикл, затем стоит (резкая остановка — худший случай для интерполяции)
    const distance = (laps * 4.5 + Math.min(cycle, 4.5)) * SPEED;
    const angle = distance / RADIUS;
    const moving = cycle < 4.5;
    const speed = moving ? SPEED : 0;
    const position = new Vector3(center.x + RADIUS * Math.cos(angle), center.y + RADIUS * Math.sin(angle), center.z);
    const velocity = new Vector3(-Math.sin(angle) * speed, Math.cos(angle) * speed, 0);
    // корпус смотрит по +Y: касательная (−sin, cos) — это +Y, повёрнутый вокруг Z на тот же угол
    return { position, velocity, heading: angle, turn: moving ? SPEED / RADIUS : 0, turret: Math.sin(t * 0.8) * 1.2, moving };
  };

  let seq = 0;
  const random = Math.random;
  let lastArrival = 0;
  let stallUntil = 0;
  let serverLast: SyncSample | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const deliver = (send: () => void, sentAt: number): void => {
    const gauss = Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());
    if (random() < STALL_CHANCE) stallUntil = sentAt + STALL_MS;
    const at = Math.max(sentAt + latencyMs + Math.abs(gauss) * jitterMs, stallUntil, lastArrival);
    lastArrival = at;
    const timer = setTimeout(() => {
      timers.delete(timer);
      send();
    }, Math.max(0, at - performance.now()));
    timers.add(timer);
  };
  // владелец → «сервер»
  const ownerTimer = setInterval(() => {
    const now = performance.now();
    const t = truth(now);
    seq = (seq + 1) & 0xffff;
    const half = t.heading / 2;
    const sample: SyncSample = {
      seq,
      sampleTime: Math.round(now),
      life: 1,
      chassis: t.moving ? 1 | (1 << 2) : 0,
      turretControl: 0,
      turretAngle: t.turret,
      px: t.position.x,
      py: t.position.y,
      pz: t.position.z,
      qx: 0,
      qy: 0,
      qz: Math.sin(half),
      qw: Math.cos(half),
      vx: t.velocity.x,
      vy: t.velocity.y,
      vz: 0,
      ax: 0,
      ay: 0,
      az: t.turn,
    };
    deliver(() => (serverLast = sample), now);
  }, SEND_INTERVAL_MS);
  // «сервер» → наблюдатель: последний сэмпл раз в 50 мс
  let lastServerSend = 0;
  const serverTimer = setInterval(() => {
    const sample = serverLast;
    if (!sample) return;
    const now = performance.now();
    const sentAt = Math.max(now, lastServerSend);
    lastServerSend = sentAt;
    deliver(() => {
      const previous = buffer.newest?.sampleTime ?? null;
      if (buffer.push({ ...sample })) delay.addArrival(performance.now(), sample.sampleTime, previous);
    }, sentAt);
  }, SNAPSHOT_INTERVAL_MS);

  const first = truth(performance.now());
  const euler = new Vector3();
  new Quaternion(Math.cos(first.heading / 2), 0, 0, Math.sin(first.heading / 2)).getEulerAngles(euler);
  remote.spawnAt(first.position, euler, 0, true);

  const errors: number[] = [];
  const probe = new InterpolatedState();
  let frame = 0;
  const loop = (): void => {
    frame = requestAnimationFrame(loop);
    const now = performance.now();
    delay.update(now);
    remote.render();
    // тело стоит на время шага физики (scene.time), а не кадра
    const rt = demo.runner.getPhysicsScene().time - delay.current;
    if (buffer.sample(rt, probe)) {
      const expected = truth(rt).position;
      const shown = remote.tank.getBody().state.position;
      errors.push(Math.hypot(shown.x - expected.x, shown.y - expected.y));
      if (errors.length > 600) errors.shift();
    }
  };
  frame = requestAnimationFrame(loop);

  return {
    stats() {
      const sorted = [...errors].sort((a, b) => a - b);
      const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
      return (
        `задержка ${delay.current.toFixed(0)} → ${delay.target.toFixed(0)} мс, буфер ${buffer.size}, экстраполяция ${remote.extrapolatedMs.toFixed(0)} мс, ` +
        `поправка ${(remote.correction / 100).toFixed(2)} м, ошибка p99 ${(p99 / 100).toFixed(2)} м (за ~10 с)`
      );
    },
    dispose() {
      cancelAnimationFrame(frame);
      clearInterval(ownerTimer);
      clearInterval(serverTimer);
      for (const timer of timers) clearTimeout(timer);
      remote.dispose();
    },
  };
}

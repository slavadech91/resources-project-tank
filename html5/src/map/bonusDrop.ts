import type { Vec3 } from '../net2/protocol.ts';

export const BONUS_MARK_SIZE = 500;
export const BONUS_RAY_START = 200;
export const BONUS_DROP_RADIUS = 75;

export function bonusZoneKey(position: Vec3): string {
  return `${Math.round(position.x)}:${Math.round(position.y)}:${Math.round(position.z)}`;
}

export function bonusDropPosition(position: Vec3, min: Vec3, max: Vec3, random = Math.random): Vec3 {
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(random()) * BONUS_DROP_RADIUS;
  const clampAxis = (center: number, offset: number, low: number, high: number) =>
    center < low || center > high ? center : Math.max(low, Math.min(high, center + offset));
  return {
    x: clampAxis(position.x, radius * Math.cos(angle), min.x, max.x),
    y: clampAxis(position.y, radius * Math.sin(angle), min.y, max.y),
    z: Math.max(position.z, max.z) + BONUS_RAY_START,
  };
}

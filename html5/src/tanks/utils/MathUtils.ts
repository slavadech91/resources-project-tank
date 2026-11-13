// 1:1 из alternativa/tanks/utils/MathUtils.as
export const PI2 = 2 * Math.PI; // §-!@§

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clampAngle(angle: number): number {
  angle %= PI2;
  if (angle < -Math.PI) return PI2 + angle;
  if (angle > Math.PI) return angle - PI2;
  return angle;
}

export function clampAngleFast(angle: number): number {
  if (angle < -Math.PI) return PI2 + angle;
  if (angle > Math.PI) return angle - PI2;
  return angle;
}

export function moveValueTowards(value: number, target: number, delta: number): number {
  if (value < target) {
    value += delta;
    return value > target ? target : value;
  }
  if (value > target) {
    value -= delta;
    return value < target ? target : value;
  }
  return value;
}

export function snap(value: number, target: number, epsilon: number): number {
  if (value > target - epsilon && value < target + epsilon) return target;
  return value;
}

/** sign (§@!o§) */
export function sign(value: number): number {
  if (value < 0) return -1;
  if (value > 0) return 1;
  return 0;
}

export function numberSign(value: number, threshold: number): number {
  if (value < 0) return value < -threshold ? -1 : 0;
  if (value > 0) return value > threshold ? 1 : 0;
  return 0;
}

export function numbersEqual(a: number, b: number, epsilon: number): boolean {
  const d = a - b;
  if (d < 0) return d > -epsilon;
  return d < epsilon;
}

import type { BonusRegion, ServerMap, ClientMap, Vec3, SpawnPoint } from './types';

// Разбор XML карт Tanki. Формат плоский: теги с вложенными <x>/<y>/<z>,
// поэтому обычный DOMParser без зависимостей.

function numberFrom(parent: Element | null, tag: string, fallback = 0): number {
  const el = parent?.getElementsByTagName(tag)[0];
  const value = el?.textContent?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function vec3From(parent: Element | null, tag: string): Vec3 {
  const el = parent?.getElementsByTagName(tag)[0] ?? null;
  return {
    x: numberFrom(el, 'x'),
    y: numberFrom(el, 'y'),
    z: numberFrom(el, 'z'),
  };
}

function text(parent: Element | null, tag: string): string | null {
  const el = parent?.getElementsByTagName(tag)[0];
  const value = el?.textContent?.trim();
  return value ? value : null;
}

function parseXml(source: string): Document {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error('не удалось разобрать XML: ' + error.textContent);
  return doc;
}

export function parseServerMap(source: string): ServerMap {
  const doc = parseXml(source);
  const root = doc.documentElement;

  const boxes = Array.from(root.getElementsByTagName('collision-box')).map((el) => ({
    size: vec3From(el, 'size'),
    position: vec3From(el, 'position'),
    rotation: vec3From(el, 'rotation'),
  }));

  const planes = Array.from(root.getElementsByTagName('collision-plane')).map((el) => ({
    width: numberFrom(el, 'width'),
    length: numberFrom(el, 'length'),
    position: vec3From(el, 'position'),
    rotation: vec3From(el, 'rotation'),
  }));

  const triangles = Array.from(root.getElementsByTagName('collision-triangle')).map((el) => ({
    v0: vec3From(el, 'v0'),
    v1: vec3From(el, 'v1'),
    v2: vec3From(el, 'v2'),
    position: vec3From(el, 'position'),
    rotation: vec3From(el, 'rotation'),
  }));

  const spawns: SpawnPoint[] = Array.from(root.getElementsByTagName('spawn-point')).map((el) => ({
    type: el.getAttribute('type') ?? 'dm',
    position: vec3From(el, 'position'),
    rotation: vec3From(el, 'rotation'),
  }));

  const bonusRegions: BonusRegion[] = Array.from(root.getElementsByTagName('bonus-region')).map((el) => {
    const min = vec3From(el, 'min');
    const max = vec3From(el, 'max');
    const hasPosition = el.getElementsByTagName('position').length > 0;
    const values = (tag: string): string[] => Array.from(el.getElementsByTagName(tag)).map((item) => item.textContent?.trim() ?? '');
    return {
      position: hasPosition ? vec3From(el, 'position') : { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: min.z },
      rotation: vec3From(el, 'rotation'),
      min,
      max,
      gameModes: values('game-mode'),
      bonusTypes: values('bonus-type'),
    };
  });

  return { boxes, planes, triangles, spawns, bonusRegions };
}

export function parseClientMap(source: string): ClientMap {
  const doc = parseXml(source);
  const props = Array.from(doc.getElementsByTagName('prop')).map((el) => ({
    library: el.getAttribute('library-name') ?? '',
    group: el.getAttribute('group-name') ?? 'default',
    name: el.getAttribute('name') ?? '',
    texture: text(el, 'texture-name'),
    position: vec3From(el, 'position'),
    rotation: vec3From(el, 'rotation'),
  }));
  return { props };
}

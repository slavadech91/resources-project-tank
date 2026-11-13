/**
 * Карта для боя: точки спавна из XML карты (`configs/maps/<map_xml>`, как map_loader.parse_spawn_points: z + 100),
 * зоны смерти из maps.json (kill_zones), зоны выпадения ящиков (bonus-region) и папка карты клиента (последняя
 * часть map_resource).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEAM, type BattleTeam, type BonusKind, type Vec3 } from '../../../html5/src/net2/protocol.ts';
import { logError } from '../log.ts';

export interface SpawnPoint {
  position: Vec3;
  orientation: Vec3;
}

/** зона выпадения ящиков: бокс min..max, режимы и типы (map_info.BonusRegion старого сервера) */
export interface BonusRegion {
  position: Vec3;
  rotation: Vec3;
  min: Vec3;
  max: Vec3;
  modes: string[];
  kinds: BonusKind[];
  bonusTypes: string[];
}

export interface MapData {
  gravity?:number;
  flagBases?:[Vec3,Vec3];
  mapId: number;
  /** public/maps/<key> клиента */
  key: string;
  /** исходный XML карты — из него лениво строится статика для серверных лучей */
  xml: string;
  spawns: Record<'dm' | 'red' | 'blue', SpawnPoint[]>;
  killZones: { min: Vec3; max: Vec3 }[];
  bonusRegions: BonusRegion[];
}

/** map_info.bonus_type_string_to_enum: имя типа в XML -> тип ящика (неизвестные не выпадают) */
const BONUS_KIND_BY_XML: Record<string, BonusKind> = {
  armorup: 'armor',
  crystal: 'crystal',
  crystal_100: 'gold',
  medkit: 'med',
  nitro: 'nos',
  damageup: 'power',
};

interface MapConfig {
  gravity?:number;
  map_id: number;
  map_xml?: string;
  map_resource?: string;
  kill_zones?: { min: Vec3; max: Vec3 }[];
}

function vector(xml: string, tag: string): Vec3 {
  const block = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? '';
  const axis = (name: string): number => Number(new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1] ?? 0) || 0;
  return { x: axis('x'), y: axis('y'), z: axis('z') };
}

export function parseSpawns(xml: string): MapData['spawns'] {
  const spawns: MapData['spawns'] = { dm: [], red: [], blue: [] };
  for (const match of xml.matchAll(/<spawn-point\s+([^>]*)>([\s\S]*?)<\/spawn-point>/g)) {
    const type = /type="([a-z]+)"/.exec(match[1])?.[1] ?? 'dm';
    const position = vector(match[2], 'position');
    position.z += 100;
    const point = { position, orientation: vector(match[2], 'rotation') };
    if (type === 'red' || type === 'blue') spawns[type].push(point);
    else spawns.dm.push(point);
  }
  return spawns;
}

/** Координаты position совпадают с центром метки клиента. */
export function parseBonusRegions(xml: string): BonusRegion[] {
  const regions: BonusRegion[] = [];
  for (const match of xml.matchAll(/<bonus-region\b[^>]*>([\s\S]*?)<\/bonus-region>/g)) {
    const block = match[1];
    const values = (tag: string): string[] => [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((item) => item[1].trim());
    const bonusTypes = [...new Set(values('bonus-type').filter(name => Object.hasOwn(BONUS_KIND_BY_XML, name)))];
    const kinds = [...new Set(bonusTypes.map(name => BONUS_KIND_BY_XML[name]))];
    if (!kinds.length) continue;
    const min = vector(block, 'min'), max = vector(block, 'max');
    const position = /<position>/.test(block) ? vector(block, 'position') : {
      x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: min.z,
    };
    regions.push({ position, rotation: vector(block, 'rotation'), min, max, modes: values('game-mode'), kinds, bonusTypes });
  }
  return regions;
}

export function loadMapData(configDir: string): Map<number, MapData> {
  const config = JSON.parse(readFileSync(join(configDir, 'maps.json'), 'utf8')) as { maps: MapConfig[] };
  const result = new Map<number, MapData>();
  for (const map of config.maps) {
    try {
      const xml = readFileSync(join(configDir, 'maps', map.map_xml ?? ''), 'utf8');
      result.set(map.map_id, {
        gravity:map.gravity??1000,
        mapId: map.map_id,
        key: (map.map_resource ?? '').split('/').filter(Boolean).pop() ?? 'arena',
        xml,
        flagBases:parseFlagBases(xml),
        spawns: parseSpawns(xml),
        killZones: map.kill_zones ?? [],
        bonusRegions: parseBonusRegions(xml),
      });
    } catch (error) {
      logError('battle', `карта ${map.map_id} (${map.map_xml}) не загружена: ${(error as Error).message}`);
    }
  }
  return result;
}

/** точки спавна команды; нет своих — любые (DM без dm-точек, TDM без командных) */
export function spawnsFor(map: MapData, team: BattleTeam): SpawnPoint[] {
  const own = team === TEAM.RED ? map.spawns.red : team === TEAM.BLUE ? map.spawns.blue : map.spawns.dm;
  if (own.length) return own;
  const all = [...map.spawns.dm, ...map.spawns.red, ...map.spawns.blue];
  return all.length ? all : [{ position: { x: 0, y: 0, z: 1000 }, orientation: { x: 0, y: 0, z: 0 } }];
}

export function inKillZone(map: MapData, p: Vec3): boolean {
  return map.killZones.some((zone) => p.x >= zone.min.x && p.x <= zone.max.x && p.y >= zone.min.y && p.y <= zone.max.y && p.z >= zone.min.z && p.z <= zone.max.z);
}

export function parseFlagBases(xml:string):[Vec3,Vec3]|undefined {
 if(!/<ctf-flags>/.test(xml))return undefined;
 // CTFModel.Z_DISPLACEMENT: pedestal sits 80cm below the flag origin.
 const red=vector(xml,'flag-red'),blue=vector(xml,'flag-blue');red.z+=80;blue.z+=80;return [red,blue];
}

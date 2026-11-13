import {appearancePartPath,type AppearanceStyle} from '../../net2/appearance.ts';
// Детали танка по данным сервера: TankModel.tank_parts -> объекты корпуса/пушки (Object3DSModel.resource_id) и краски
// (ColoringModel.coloring_image_id) -> пути в public/tank_parts по lobby/parts.json (tools/extract_lobby_assets.py).
import type { RemoteObject, RemoteSpace } from '../../net/client.ts';
import { TankSkin } from './TankSkin.ts';

const TANK_MODEL_ID = 300100078;
const OBJECT_3DS_MODEL_ID = 300040017;
const COLORING_MODEL_ID = 300070004;

const DEFAULT_HULL = 'hulls/hunter/m0';
const DEFAULT_TURRET = 'turrets/smoky/m0';
const DEFAULT_PAINT = 'paints/green.jpg';

export interface TankPartIds {
  hullStyle?:AppearanceStyle;turretStyle?:AppearanceStyle;
  hull: number | null;
  turret: number | null;
  paint: number | null;
}

/** версия lobby/parts.json: менять при добавлении деталей и красок (иначе браузер до часа держит старую карту) */
const PARTS_VERSION = '3';

let partsMap: Promise<Record<number, string>> | null = null;

/** lobby/parts.json: id ресурса Object3DS / краски -> путь детали в public/tank_parts */
export function loadPartsMap(): Promise<Record<number, string>> {
  partsMap ??= fetch(`/lobby/parts.json?v=${PARTS_VERSION}`)
    .then((response) => (response.ok ? (response.json() as Promise<Record<number, string>>) : {}))
    .catch(() => ({}));
  return partsMap;
}

/** id ресурсов деталей танка из объектов пространства боя */
export function tankPartIds(space: RemoteSpace | undefined, tank: RemoteObject): TankPartIds {
  const data = tank.models.get(TANK_MODEL_ID) as { tank_parts?: { hull_id?: number; weapon_id?: number; color_id?: number } } | undefined;
  const parts = data?.tank_parts;
  const model = <T>(id: number | undefined, modelId: number): T | undefined => (id == null ? undefined : (space?.objects.get(Number(id))?.models.get(modelId) as T | undefined));
  const hull = model<{ resource_id?: number }>(parts?.hull_id, OBJECT_3DS_MODEL_ID)?.resource_id;
  const turret = model<{ resource_id?: number }>(parts?.weapon_id, OBJECT_3DS_MODEL_ID)?.resource_id;
  const paint = model<{ coloring_image_id?: number }>(parts?.color_id, COLORING_MODEL_ID)?.coloring_image_id;
  return { hull: hull != null ? Number(hull) : null, turret: turret != null ? Number(turret) : null, paint: paint != null ? Number(paint) : null };
}

/** Скин танка по id ресурсов; неизвестная деталь — Хантер/Смоки/зелёная, модификация без своей модели — M0 */
export async function loadTankSkin(ids: TankPartIds): Promise<TankSkin> {
  const map = await loadPartsMap();
  const hull = appearancePartPath((ids.hull != null ? map[ids.hull] : undefined) ?? DEFAULT_HULL,ids.hullStyle);
  const turret = appearancePartPath((ids.turret != null ? map[ids.turret] : undefined) ?? DEFAULT_TURRET,ids.turretStyle);
  const paint = (ids.paint != null ? map[ids.paint] : undefined) ?? DEFAULT_PAINT;
  const attempts: [string, string, string][] = [
    [hull, turret, paint],
    [hull, turret, DEFAULT_PAINT],
    [hull.replace(/m\d$/, 'm0'), turret.replace(/m\d$/, 'm0'), DEFAULT_PAINT],
    [DEFAULT_HULL, DEFAULT_TURRET, DEFAULT_PAINT],
  ];
  let lastError: unknown = null;
  for (const [h, t, p] of attempts) {
    try {
      return await TankSkin.load(`tank_parts/${h}`, `tank_parts/${t}`, `tank_parts/${p}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

import {appearanceFor,type AppearanceMap,type AppearanceStyle} from '../../../html5/src/net2/appearance.ts';
import { ISIDA_DEFAULT } from '../../../html5/src/net2/isida.ts';
/**
 * Снаряжение танка в бою — надетые корпус, пушка и краска игрока с уровнями микроулучшений (как
 * DatabaseGarageItem.get_property_value старого сервера: initial + (final − initial) · уровень / максимум).
 */
import type { WeaponInfo } from '../../../html5/src/net2/protocol.ts';
import type { InventorySlotConfig } from '../config.ts';
import type { ItemDef } from '../garage/catalog.ts';
import type { GarageService, GarageSnapshot } from '../garage/garage.ts';

export interface Loadout {
  hullKind?:string;
  mass?:number;
  parts: { hull: number | null; turret: number | null; paint: number | null;hullStyle?:AppearanceStyle;turretStyle?:AppearanceStyle };
  weapon: WeaponInfo;
  maxHealth: number;
  /** м/с — проверка скорости синхронизации */
  speed: number;
  damageFrom: number;
  damageTo: number;
  criticalChance: number;
  /** Урон критического попадания или процент добавки в старых конфигах. */
  criticalDamage: number;
  absoluteCriticalDamage?: boolean;
  /** <пушка>_resistance краски, % */
  resistances: Map<string, number>;
  /** габариты корпуса (hull_size), см — рамка попадания мины */
  size: { x: number; y: number; z: number };
  /** припасы инвентаря: id предмета -> сколько у игрока (UserItems.count) */
  inventoryCounts: Map<number, number>;
}

/** Рикошет M0–M3: скорость снаряда (м/с) и расход энергии на выстрел (ёмкость 1000, зарядка 100/с) */
const RICOCHET_SPEED = [94.75, 104.57, 114.39, 120];
const RICOCHET_ENERGY_PER_SHOT = [133.71, 127.99, 122.27, 119];

function value(item: ItemDef | undefined, name: string, levels: Map<number, number> | undefined, fallback: number): number {
  const property = item?.battle.get(name);
  if (!item || !property) return fallback;
  if (property.upgrade == null) return property.initial;
  const upgrade = item.upgrades.find((candidate) => candidate.propertyId === property.upgrade);
  if (!upgrade || upgrade.maxLevel <= 0) return property.initial;
  const level = Math.max(0, Math.min(upgrade.maxLevel, levels?.get(upgrade.propertyId) ?? upgrade.level));
  return property.initial + (property.final - property.initial) * (level / upgrade.maxLevel);
}

export async function loadLoadout(garage: GarageService, userId: number, inventory: InventorySlotConfig[],withoutUpgrades=false): Promise<Loadout> {
  const snapshot: GarageSnapshot = await garage.load(userId);
  const catalog = garage.catalog;
  const mounted = snapshot.mounted.map((id) => catalog.get(id)).filter((item): item is ItemDef => item != null);
  return assembleLoadout(mounted,snapshot.owned,inventory,withoutUpgrades,snapshot.appearances);
}

export function assembleLoadout(mounted:ItemDef[],owned:GarageSnapshot['owned'],inventory:InventorySlotConfig[],withoutUpgrades=false,appearances:AppearanceMap={}):Loadout{
  const hull = mounted.find((item) => item.category === 'armor');
  const turret = mounted.find((item) => item.category === 'weapon');
  const paint = mounted.find((item) => item.category === 'color');
  const inventoryCounts = new Map<number, number>();
  for (const slot of inventory) inventoryCounts.set(slot.itemId, owned.get(slot.itemId)?.count ?? 0);
  const levels = (item: ItemDef | undefined): Map<number, number> | undefined => (item ? withoutUpgrades?new Map(item.upgrades.map(u=>[u.propertyId,0])):owned.get(item.id)?.levels : undefined);
  const hullValue = (name: string, fallback: number): number => value(hull, name, levels(hull), fallback);
  const gun = (name: string, fallback: number): number => value(turret, name, levels(turret), fallback);
  const resistances = new Map<string, number>();
  for (const [name] of paint?.battle ?? []) if (name.endsWith('_resistance')) resistances.set(name, value(paint, name, levels(paint), 0));
  const data = turret?.weapon;
  const kind = data?.kind ?? 'smoky';
  const streamKind = kind === 'firebird' || kind === 'freeze' || kind === 'isida';
  const isidaConfig = data?.isida;
  const ricochetMod = Math.max(0, Math.min(RICOCHET_SPEED.length - 1, turret?.modification ?? 0));
  // у потоковых пушек weapon_reload_time — секунды полной зарядки энергии (14, 12.74, 11.71), у остальных — мс
  const rawReload = gun('weapon_reload_time', 1000);
  const streamRechargeMs = rawReload < 100 ? rawReload * 1000 : rawReload;
  return {
    hullKind:/hulls\/([^/]+)/.exec(hull?.objectPath??'')?.[1],
    parts: { hull: hull?.object3dsId ?? null, turret: turret?.object3dsId ?? null, paint: paint?.coloringId ?? null,hullStyle:appearanceFor(hull?.objectPath??'',appearances),turretStyle:appearanceFor(turret?.objectPath??'',appearances) },
    weapon: {
      kind,
      reloadMs: streamKind ? streamRechargeMs : rawReload,
      autoAimUp: data?.autoAimUp ?? 0,
      autoAimDown: data?.autoAimDown ?? 0,
      maxDamageRadius: gun('weapon_max_damage_radius', 0),
      minDamageRadius: gun('weapon_min_damage_radius', 0),
      minDamagePercent: gun('weapon_min_damage_percent', 100),
      chargingMs: data?.chargingMs ?? 0,
      weakeningCoeff: gun('weapon_weakening_coeff', 1),
      twins: data?.twins ?? null,
      splash: data?.splash ?? null,
      stream: streamKind
        ? {
            tickMs: kind === 'isida' ? isidaConfig?.checkPeriodMsec ?? ISIDA_DEFAULT.checkPeriodMsec : data?.stream?.tickMs ?? 500,
            energyCapacity: kind === 'isida' ? isidaConfig?.capacity ?? ISIDA_DEFAULT.capacity : data?.stream?.energyCapacity ?? 1000,
            dischargeRate: gun('weapon_discharge_rate', 100),
            rechargeMs: streamRechargeMs,
            coneAngle: kind === 'isida' ? isidaConfig?.coneAngle ?? ISIDA_DEFAULT.coneAngle : data?.flame?.coneAngle ?? data?.freeze?.coneAngle ?? 0.7,
            range: kind === 'isida' ? (isidaConfig?.radius ?? ISIDA_DEFAULT.radius) / 100 : Math.min(gun('weapon_min_damage_radius', 15), 100),
          }
        : null,
      shaft: data?.shaft
        ? {
            aimedMinDamage: gun('shaft_aiming_mode_min_damage', 47),
            aimedMaxDamage: gun('shaft_aiming_mode_max_damage', 110),
            maxEnergy: data.shaft.maxEnergy,
            // зарядка до полного — за время перезарядки (ShaftGlobalModel: max_energy / (reload/1000))
            chargeRate: data.shaft.chargeRate ?? data.shaft.maxEnergy / Math.max(0.1, rawReload / 1000),
            dischargeRate: gun('shaft_aiming_mode_charge_rate', 277),
            fastShotEnergy: data.shaft.fastShotEnergy,
            aimedImpact: gun('shaft_aimed_shot_impact', 200),
            afterShotPauseMs: data.shaft.afterShotPauseMs,
            weakeningCoeff: data.shaft.weakeningCoeff,
            targetingTransitionMs:data.shaft.targetingTransitionMs,
            initialFov:data.shaft.initialFov,minimumFov:data.shaft.minimumFov,
            horizontalSpeed:gun('shaft_horizontal_targeting_speed',0.2),
            verticalSpeed:gun('shaft_vertical_targeting_speed',0.2),
          }
        : null,
      freeze: data?.freeze ?? null,
      flame: data?.flame
        ? { ...data.flame, temperatureLimit: gun('flame_temperature_limit', 0.281818) }
        : null,
      isida:
        kind === 'isida'
          ? {
              // Existing legacy values are per 500ms; preserve DPS at Narukami's 250ms tick.
              config: isidaConfig ?? { ...ISIDA_DEFAULT,
                capacity: data?.stream?.energyCapacity ?? 1000,
                chargeRate: (data?.stream?.energyCapacity ?? 1000) / Math.max(0.1, streamRechargeMs/1000),
                dischargeDamageRate: gun('weapon_discharge_rate',100),
                dischargeHealingRate: gun('weapon_discharge_rate',100),
                // LocalHealingGun has a separate IDLE drain; keep the template's 1:2 ratio.
                dischargeIdleRate: gun('weapon_discharge_rate',100)/2,
              },
              healingPerPeriod: gun('isis_healing_per_period', 0) * (isidaConfig ? 1 : ISIDA_DEFAULT.checkPeriodMsec / 500),
              damagePerPeriod: gun('damage_per_period', gun('damage_from', 0)) * (isidaConfig ? 1 : ISIDA_DEFAULT.checkPeriodMsec / 500),
              selfHealingPercent: gun('isis_self_healing_percent', 0),
            }
          : null,
      ricochet:
        kind === 'ricochet'
          ? data?.ricochet ?? {
              speed: RICOCHET_SPEED[ricochetMod],
              // в гараже это «дальность» пушки — полный путь шара с отскоками
              range: gun('weapon_min_damage_radius', 72.9),
              shotRadius: 0.5,
              energyCapacity: 1000,
              energyPerShot: RICOCHET_ENERGY_PER_SHOT[ricochetMod],
              energyRecharge: 100,
            }
          : null,
    },
    mass:hullValue('hull_mass',1500),
    maxHealth: Math.round(hullValue('hull_armor', 100)),
    speed: hullValue('hull_speed', 10),
    damageFrom: gun('damage_from', 0),
    damageTo: gun('damage_to', 0),
    criticalChance: gun('critical_hit_chance', 0),
    criticalDamage: gun('critical_hit_damage', 0),
    absoluteCriticalDamage: data?.absoluteCriticalDamage,
    resistances,
    size: hull?.size ?? { x: 300, y: 500, z: 150 },
    inventoryCounts,
  };
}

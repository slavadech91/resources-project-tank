/**
 * Каталог гаража из общих конфигов `configs/garage_items/*.json` — как loaders/garage_item_loader старого сервера:
 * модификации корпусов и пушек, краски, припасы, комплекты, временные предметы. Предметы с role_specific_item старый
 * сервер не показывает (get_all_items_for_role их теряет) — server2 тоже. Картинки и модели — id ресурсов.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemPropertyValue, WeaponInfo } from '../../../html5/src/net2/protocol.ts';
import type { IsidaConfig } from '../../../html5/src/net2/isida.ts';

export type ItemCategory = 'weapon' | 'armor' | 'color' | 'inventory' | 'plugin' | 'kit' | 'emblem';

/** ItemCategoryEnum клиента (name_to_id.item_category_enum_name_to_id) */
export const CATEGORY_ID: Record<ItemCategory, number> = { weapon: 0, armor: 1, color: 2, inventory: 3, plugin: 4, kit: 5, emblem: 6 };

/** ItemGarageProperty — улучшаемые параметры (name_to_id.garage_property_to_id_dic) */
const GARAGE_PROPERTY_ID: Record<string, number> = {
  hull_armor: 1, hull_speed: 2, hull_turn_speed: 3, hull_power: 4, hull_mass: 5,
  firebird_resistance: 20, smoky_resistance: 21, twins_resistance: 22, railgun_resistance: 23, isis_resistance: 24,
  mine_resistance: 25, thunder_resistance: 26, freeze_resistance: 27, ricochet_resistance: 28, shaft_resistance: 29,
  damage: 40, damage_per_second: 41, weapon_cooldown_time: 42, aiming_mode_cooldown_time: 43, critical_hit_chance: 44,
  critical_hit_damage: 45, shot_range: 46, turret_turn_speed: 47, aiming_error: 48, shot_area: 49, cone_angle: 50,
  charging_time: 51, fire_damage: 52, weapon_weakening_coeff: 53, isis_radius: 54, isis_damage: 55,
  isis_healing_per_second: 56, isis_self_healing_percent: 57, aiming_mode_damage: 58, aiming_weapon_discharge_rate: 59,
  shaft_aimed_shot_impact: 60, shaft_targeting_speed: 61, shaft_arcade_damage: 62, weapon_impact_force: 63,
  weapon_kickback: 64, weapon_reticle_speed: 65, weapon_charge_rate: 66, weapon_min_damage_percent: 67,
  thunder_min_splash_damage_percent: 68,
};

/** ItemProperty — свойства предмета (name_to_id.item_property_name_to_id_dic), по порядку с 0 */
const ITEM_PROPERTIES = [
  'hull_armor', 'hull_speed', 'hull_side_acceleration', 'hull_turn_speed', 'hull_turn_acceleration',
  'hull_reverse_turn_acceleration', 'hull_acceleration', 'hull_reverse_acceleration', 'hull_mass', 'turret_turn_speed',
  'turret_rotation_acceleration', 'impact_force', 'damage_from', 'damage_to', 'weapon_reload_time',
  'weapon_charging_time', 'weapon_weakening_coeff', 'firebird_resistance', 'smoky_resistance', 'twins_resistance',
  'railgun_resistance', 'isis_resistance', 'mine_resistance', 'thunder_resistance', 'freeze_resistance',
  'ricochet_resistance', 'shaft_resistance', 'shaft_aiming_mode_min_damage', 'shaft_aiming_mode_max_damage',
  'shaft_vertical_targeting_speed', 'shaft_horizontal_targeting_speed', 'shaft_aiming_mode_charge_rate',
  'shaft_aimed_shot_impact', 'shaft_rotation_deceleration_coeff', 'weapon_charge_rate', 'weapon_kickback',
  'weapon_min_damage_percent', 'weapon_min_damage_radius', 'weapon_max_damage_radius', 'critical_hit_chance',
  'critical_hit_damage', 'thunder_min_splash_damage_percent', 'thunder_splash_damage_impact', 'weapon_discharge_rate',
  'damage_per_period', 'isis_healing_per_period', 'isis_self_healing_percent', 'isis_radius', 'flame_temperature_limit',
  'weapon_reticle_speed', 'weapon_reticle_radius', 'energy_per_shot',
];
const ITEM_PROPERTY_ID = new Map(ITEM_PROPERTIES.map((name, index) => [name, index]));

/** скорость поворота корпуса в бою — рад/с, в гараже — град/с (garage_codecs.PropertyData.GARAGE_UNIT_FACTOR) */
const GARAGE_UNIT_FACTOR: Record<string, number> = { hull_turn_speed: 180 / Math.PI };

export interface LinearParam {
  initial: number;
  step: number;
}

export interface UpgradeDef {
  /** id ItemGarageProperty */
  propertyId: number;
  level: number;
  maxLevel: number;
  cost: LinearParam;
}

export interface KitEntry {
  item: number;
  count: number;
  mount: boolean;
}

/** свойство предмета для боя: значения M0 улучшений и максимума (единицы сервера), улучшаемый параметр */
export interface BattleProperty {
  initial: number;
  final: number;
  /** id ItemGarageProperty, уровень которого двигает значение; null — не улучшается */
  upgrade: number | null;
}

/** данные пушки для боя (weapon_data старого сервера): тип, зарядка рельсы, снаряд Twins, углы автонаведения и особые механики */
export interface WeaponDef {
  /** turrets/<kind>/ в пути модели: smoky, twins, railgun, … */
  kind: string;
  chargingMs: number;
  twins: { distance: number; shotRadius: number; speed: number } | null;
  autoAimUp: number;
  autoAimDown: number;
  /** Гром: thunder_splash_data (радиус в метрах, урон сплеша) */
  splash: WeaponInfo['splash'];
  ricochet: WeaponInfo['ricochet'];
  isida: IsidaConfig | null;
  absoluteCriticalDamage: boolean;
  /** потоковые пушки: stream_weapon_data */
  stream: { tickMs: number; energyCapacity: number } | null;
  flame: { coneAngle: number; heatingRate: number; coolingRate: number; burnDamageMin: number; burnDamageMax: number } | null;
  freeze: { coneAngle: number; freezingSpeed: number; defrostingSpeed: number; turretMaxFreezing: number; bodyMaxFreezing: number; minTemperature: number } | null;
  /** Шафт: shaft_data */
  shaft: {
    afterShotPauseMs: number;
    fastShotEnergy: number;
    maxEnergy: number;
    chargeRate?: number;
    weakeningCoeff: number;
    targetingTransitionMs: number;
    initialFov: number;
    minimumFov: number;
  } | null;
}

export interface ItemDef {
  objectPath?:string;
  id: number;
  name: string;
  description: string;
  category: ItemCategory;
  position: number;
  minRank: number;
  maxRank: number;
  previewId: number;
  /** цена без скидки (BuyableModel) */
  price: number;
  /** скидка, доля 0…1 */
  discount: number;
  saleImageId: number | null;
  baseItemId: number | null;
  modification: number | null;
  object3dsId: number | null;
  coloringId: number | null;
  countable: boolean;
  kit: { items: KitEntry[]; discount: number } | null;
  temporaryLifeSec: number | null;
  values: ItemPropertyValue[];
  upgrades: UpgradeDef[];
  /** свойства по имени item_property (без пересчёта в единицы гаража) */
  battle: Map<string, BattleProperty>;
  weapon: WeaponDef | null;
  /** габариты корпуса (tank_physics.hull_size) — рамка попадания мины, как tank_global_model.size */
  size: { x: number; y: number; z: number } | null;
}

type Json = Record<string, any>;

export class GarageCatalog {
  readonly items = new Map<number, ItemDef>();
  private readonly byBase = new Map<number, ItemDef[]>();

  constructor(configDir: string) {
    const resourceIds = JSON.parse(readFileSync(join(configDir, 'path_to_id.json'), 'utf8')) as Record<string, number>;
    const resource = (path: unknown): number | null => (typeof path === 'string' && path in resourceIds ? resourceIds[path] : null);
    const folder = join(configDir, 'garage_items');
    for (const file of ['hulls', 'turrets', 'paints', 'countable_items', 'kits', 'temporary_items', 'useless_items']) {
      const json = JSON.parse(readFileSync(join(folder, `${file}.json`), 'utf8')) as Json;
      for (const group of Object.values(json)[0] as Json[]) {
        for (const entry of (group.modifications as Json[] | undefined) ?? [group]) {
          if ('role_specific_item' in entry) continue;
          const item = this.parse(entry, resource);
          this.items.set(item.id, item);
          if (item.baseItemId != null) {
            const list = this.byBase.get(item.baseItemId) ?? [];
            list.push(item);
            list.sort((a, b) => (a.modification ?? 0) - (b.modification ?? 0));
            this.byBase.set(item.baseItemId, list);
          }
        }
      }
    }
  }

  get(id: number): ItemDef | undefined {
    return this.items.get(id);
  }

  /** все модификации предмета по base_item_id, по возрастанию */
  modifications(item: ItemDef): ItemDef[] {
    return item.baseItemId == null ? [item] : this.byBase.get(item.baseItemId) ?? [item];
  }

  /** цена со скидкой (BuyableModelData.price_with_discount) */
  discountedPrice(item: ItemDef): number {
    return item.price - item.price * item.discount;
  }

  /** цена в магазине: у комплекта — сумма предметов со скидкой комплекта (calculate_kit_price) */
  shopPrice(item: ItemDef): number {
    if (!item.kit) return Math.round(this.discountedPrice(item));
    let total = 0;
    for (const entry of item.kit.items) {
      const part = this.items.get(entry.item);
      if (!part) continue;
      const price = this.discountedPrice(part);
      total += (price - item.kit.discount * price) * entry.count;
    }
    return Math.trunc(total);
  }

  private parse(entry: Json, resource: (path: unknown) => number | null): ItemDef {
    const info = (entry.item_info ?? {}) as Json;
    const properties = ((entry.properties as Json[] | undefined) ?? []).filter((property) => ITEM_PROPERTY_ID.has(property.item_property));
    const kit = entry.kit as Json | undefined;
    const kind = entry.item_category === 'weapon' ? /\/turrets\/([a-z_]+)\//.exec(String(entry.object_3ds ?? ''))?.[1] ?? null : null;
    const twins = entry.twins_data as Json | undefined;
    const splashData = entry.thunder_splash_data as Json | undefined;
    const streamData = entry.stream_weapon_data as Json | undefined;
    const flameData = entry.flame_thrower_data as Json | undefined;
    const freezeData = entry.freeze_data as Json | undefined;
    const shaftData = entry.shaft_data as Json | undefined;
    const discount = Number(entry.discount?.discount ?? 0);
    const hullSize = (entry.tank_physics as Json | undefined)?.hull_size as Json | undefined;
    const size = hullSize ? { x: Number(hullSize.x ?? 0), y: Number(hullSize.y ?? 0), z: Number(hullSize.z ?? 0) } : null;
    return {
      id: Number(entry.id),
      name: String(entry.description?.name ?? ''),
      description: String(entry.description?.description ?? ''),
      category: entry.item_category as ItemCategory,
      position: Number(info.position ?? 0),
      minRank: Number(info.min_rank ?? 1),
      maxRank: Number(info.max_rank ?? 30),
      previewId: resource(info.preview_image) ?? 0,
      price: Number(entry.price ?? 0),
      discount,
      saleImageId: discount ? resource(entry.discount?.discount_image) : null,
      baseItemId: entry.modification ? Number(entry.modification.base_item_id) : null,
      modification: entry.modification ? Number(entry.modification.modification_index) : null,
      objectPath:typeof entry.object_3ds==='string'?entry.object_3ds:undefined,
      object3dsId: resource(entry.object_3ds),
      coloringId: resource(entry.coloring),
      countable: 'count' in entry,
      kit: kit ? { items: (kit.kit_items as Json[]).map((part) => ({ item: Number(part.item), count: Number(part.count), mount: Boolean(part.mount) })), discount: Number(kit.discount ?? 0) } : null,
      temporaryLifeSec: entry.temporary_data ? Number(entry.temporary_data.life_time_in_sec) : null,
      values: properties.map((property) => {
        const factor = GARAGE_UNIT_FACTOR[property.item_property] ?? 1;
        return { itemPropertyId: ITEM_PROPERTY_ID.get(property.item_property)!, initial: property.initial_value * factor, final: property.final_value * factor };
      }),
      upgrades: ((entry.upgradable_property_datas as Json[] | undefined) ?? [])
        .filter((data) => data.property in GARAGE_PROPERTY_ID)
        .map((data) => ({
          propertyId: GARAGE_PROPERTY_ID[data.property],
          level: Number(data.level ?? 0),
          maxLevel: Number(data.max_level ?? 0),
          cost: { initial: Number(data.cost?.initial_number ?? 0), step: Number(data.cost?.step ?? 0) },
        })),
      battle: new Map(
        properties.map((property) => [
          String(property.item_property),
          {
            initial: Number(property.initial_value),
            final: Number(property.final_value),
            upgrade: property.upgradable_property in GARAGE_PROPERTY_ID ? GARAGE_PROPERTY_ID[property.upgradable_property] : null,
          },
        ]),
      ),
      weapon: kind
        ? {
            kind,
            chargingMs: Number(entry.railgun_data?.charging_time ?? 0),
            twins: twins ? { distance: Number(twins.distance), shotRadius: Number(twins.shot_radius), speed: Number(twins.speed) } : null,
            autoAimUp: Number(entry.discrete_shot_data?.auto_aiming_angle_up ?? 0),
            autoAimDown: Number(entry.discrete_shot_data?.auto_aiming_angle_down ?? 0),
            absoluteCriticalDamage: entry.critical_damage_is_absolute === true,
            isida: entry.isida_data ? entry.isida_data as IsidaConfig : null,
            ricochet: entry.ricochet_data ? {
              speed: entry.ricochet_data.shellSpeed, range: entry.ricochet_data.shotDistance,
              shotRadius: entry.ricochet_data.shellRadius, energyCapacity: entry.ricochet_data.energyCapacity,
              energyPerShot: entry.ricochet_data.energyPerShot, energyRecharge: entry.ricochet_data.energyRechargeSpeed,
              maxBounces: entry.ricochet_data.maxRicochetCount,
            } : null,
            splash: splashData
              ? { radius: Number(splashData.radius ?? 0), damageFrom: Number(splashData.damage_from ?? 0), damageTo: Number(splashData.damage_to ?? 0),
                  fullDamageRadius: splashData.max_damage_radius, minimumDamagePercent: splashData.min_damage_percent,
                  impactForce: splashData.impact_force }
              : null,
            stream: streamData ? { tickMs: Number(streamData.weapon_tick_interval_msec ?? 500), energyCapacity: Number(streamData.energy_capacity ?? 1000) } : null,
            flame: flameData
              ? {
                  coneAngle: Number(flameData.cone_angle ?? 0.7),
                  heatingRate: Number(flameData.heating_rate ?? 0.025),
                  coolingRate: Number(flameData.cooling_rate ?? 0.016),
                  burnDamageMin: Number(flameData.burn_damage_min ?? 3),
                  burnDamageMax: Number(flameData.burn_damage_max ?? 6),
                }
              : null,
            freeze: freezeData
              ? {
                  coneAngle: Number(freezeData.cone_angle ?? 0.7),
                  freezingSpeed: Number(freezeData.freezing_speed ?? 0.8),
                  defrostingSpeed: Number(freezeData.defrosting_speed ?? 0.3),
                  turretMaxFreezing: Number(freezeData.turret_max_freezing ?? 0.1),
                  bodyMaxFreezing: Number(freezeData.body_max_freezing ?? 0.1),
                  minTemperature: Number(freezeData.min_temperature ?? -5),
                }
              : null,
            shaft: shaftData
              ? {
                  afterShotPauseMs: Number(shaftData.after_shot_pause ?? 500),
                  fastShotEnergy: Number(shaftData.fast_shot_energy ?? 1000),
                  maxEnergy: Number(shaftData.max_energy ?? 1000),
                  chargeRate: shaftData.charge_rate,
                  weakeningCoeff: Number(shaftData.weakening_coeff ?? 0.24),
                  targetingTransitionMs: Number(shaftData.targeting_transition_time ?? 500),
                  initialFov: Number(shaftData.initial_fov ?? 0.6981),
                  minimumFov: Number(shaftData.minimum_fov ?? 0.4014),
                }
              : null,
          }
        : null,
      size,
    };
  }
}

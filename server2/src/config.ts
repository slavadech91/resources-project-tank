/**
 * Настройки server2: общие со старым сервером конфиги из папки `dev` (рабочая папка процесса или TANKI_DEV) —
 * `configs/server_properties.json` (база, стартовые кристаллы и очки, длина пароля) — плюс переменные окружения.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BattleLimit, BattleMode, BonusKind } from '../../html5/src/net2/protocol.ts';

export interface ServerConfig {
  host: string;
  port: number;
  devDir: string;
  configDir: string;
  db: { host: string; port: number; user: string; password: string; database: string; poolSize: number };
  startingCrystals: number;
  startingScore: number;
  minPasswordLength: number;
  maxPasswordLength: number;
  /** стоимость bcrypt для новых паролей (у старого сервера — 12, по умолчанию gensalt()) */
  bcryptCost: number;
  /** лимиты нового боя по умолчанию (dm_battle_limit / tdm_battle_limit) */
  battleLimits: Record<BattleMode, BattleLimit>;
  /** стартовые предметы нового игрока (выдаются и надеваются при первом открытии гаража) */
  startingItems: number[];
  battle: BattleTimings;
}

/** припас инвентаря боя (клавиша 1–5) */
export type InventoryKind = 'firstAid' | 'doubleArmor' | 'doublePower' | 'nitro' | 'mine';

/** слот инвентаря: item_id и cool_down_time_in_sec из server_properties */
export interface InventorySlotConfig {
  /** 1–5: клавиша */
  index: number;
  itemId: number;
  kind: InventoryKind;
  cooldownMs: number;
}

/** тайминги боя (tank_*_in_ms server_properties) и очки за уничтожение */
export interface BattleTimings {
  /** от battle.prepare до спавна */
  spawnDelayMs: number;
  /** после спавна клиент шлёт battle.activate не раньше */
  activationDelayMs: number;
  /** экран смерти: следующий спавн не раньше */
  deadTimeMs: number;
  suicideDelayMs: number;
  /** ниже — танк упал с карты */
  minAllowedZ: number;
  killScore: number;
  /** фонд боя за уничтожение (kill_fund) */
  killFund: number;
  /** экран итогов раунда до нового раунда (round_end_screen_time_in_sec) */
  roundEndScreenMs: number;
  /** ящики и припасы (server_properties: bonus_fall_speed, *_box_life_time_in_sec, supplie_box_spawn_time_in_sec) */
  bonusFallSpeed: number;
  supplySpawnMs: number;
  boxLifeMs: Record<BonusKind, number>;
  crystalBoxReward: number;
  goldBoxReward: number;
  /** randint(1, gold_box_drop_probability) == 1 на каждое изменение фонда (1 — каждый раз) */
  goldDropProbability: number;
  goldDropDelayMs: number;
  goldNotificationMessage: string;
  /** crystal box: раз в num_fund_changes_for_crystal_drop изменений фонда (счётчик старый сервер не сбрасывает) */
  numFundChangesForCrystalDrop: number;
  /** длительность эффектов брони, урона и ускорения */
  effectMs: { doubleArmor: number; doublePower: number; nitro: number };
  nitroSpeedFactor: number;
  /** инвентарь боя: припасы и их перезарядка (InventoryModel старого клиента) */
  inventory: InventorySlotConfig[];
  /** мины (battle_mines_global_model, server_properties mine_*) */
  mineActivateMs: number;
  mineDamage: number;
  mineOffsetFromGround: number;
  mineRadius: number;
  mineMinDistanceFromBase?:number;
  mineImpactForce: number;
}

function battleLimit(value: unknown): BattleLimit {
  const limit = (value ?? {}) as { score_limit?: unknown; time_limit_in_sec?: unknown };
  return { scoreLimit: number(limit.score_limit, 0), timeLimitSec: number(limit.time_limit_in_sec, 900) };
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** секунды из конфига -> мс */
function seconds(value: unknown, fallback: number): number {
  return Math.max(0, number(value, fallback) * 1000);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const devDir = resolve(env.TANKI_DEV ?? process.cwd());
  const configDir = join(devDir, 'configs');
  const properties = JSON.parse(readFileSync(join(configDir, 'server_properties.json'), 'utf8')) as Record<string, unknown>;
  // старый сервер подключается к "localhost" через mysql.connector (TCP); MariaDB слушает только 127.0.0.1
  const dbHost = String(env.DB_HOST ?? properties.database_addres ?? '127.0.0.1');
  return {
    host: env.HOST ?? '127.0.0.1',
    port: number(env.PORT, 5290),
    devDir,
    configDir,
    db: {
      host: dbHost === 'localhost' ? '127.0.0.1' : dbHost,
      port: number(env.DB_PORT, 3306),
      user: String(env.DB_USER ?? properties.database_user ?? 'root'),
      password: String(env.DB_PASSWORD ?? properties.database_password ?? ''),
      database: String(env.DB_NAME ?? properties.database_name ?? 'tanki_2014_database'),
      poolSize: Math.max(1, Math.min(10, number(env.DB_POOL, 4))),
    },
    startingCrystals: number(properties.starting_crystals, 0),
    startingScore: number(properties.starting_score, 0),
    minPasswordLength: number(properties.min_password_length, 1),
    maxPasswordLength: number(properties.max_password_length, 50),
    bcryptCost: number(env.BCRYPT_COST, 12),
    battleLimits: { dm: battleLimit(properties.dm_battle_limit), tdm: battleLimit(properties.tdm_battle_limit), ctf:battleLimit(properties.ctf_battle_limit) },
    startingItems: Array.isArray(properties.starting_item_ids) ? properties.starting_item_ids.map(Number).filter(Number.isInteger) : [],
    battle: {
      spawnDelayMs: number(properties.tank_spawn_delay_in_ms, 4000),
      activationDelayMs: number(properties.tank_activation_delay_in_ms, 3000),
      deadTimeMs: number(properties.tank_dead_time_in_ms, 3000),
      suicideDelayMs: 10000,
      minAllowedZ: number(properties.min_allowed_z, -2000),
      killScore: number(properties.kill_score, 10),
      killFund: number(properties.kill_fund, 1),
      roundEndScreenMs: Math.max(1000, number(properties.round_end_screen_time_in_sec, 10) * 1000),
      bonusFallSpeed: number(properties.bonus_fall_speed, 200),
      supplySpawnMs: Math.max(1000, number(properties.supplie_box_spawn_time_in_sec, 10) * 1000),
      boxLifeMs: {
        armor: seconds(properties.armor_box_life_time_in_sec, 60),
        crystal: seconds(properties.crystal_box_life_time_in_sec, 1200),
        gold: seconds(properties.gold_box_life_time_in_sec, 720000),
        med: seconds(properties.med_box_life_time_in_sec, 120),
        nos: seconds(properties.nos_box_life_time_in_sec, 120),
        power: seconds(properties.power_box_life_time_in_sec, 120),
      },
      crystalBoxReward: number(properties.crystal_box_reward, 10),
      goldBoxReward: number(properties.gold_box_reward, 1000),
      goldDropProbability: Math.max(1, number(properties.gold_box_drop_probability, 1)),
      goldDropDelayMs: Math.max(0, number(properties.gold_drop_time, 10) * 1000),
      goldNotificationMessage: String(properties.gold_notification_message ?? 'Gold box will be dropped soon!'),
      numFundChangesForCrystalDrop: Math.max(1, number(properties.num_fund_changes_for_crystal_drop, 1)),
      effectMs: {
        doubleArmor: seconds(properties.double_armor_effect_time_in_sec, 60),
        doublePower: seconds(properties.double_power_effect_time_in_sec, 60),
        nitro: seconds(properties.nitro_effect_time_in_sec, 60),
      },
      nitroSpeedFactor: number(properties.nitro_speed_coefficient, 1.3),
      inventory: [
        { index: 1, itemId: number(properties.first_aid_item_id, 500), kind: 'firstAid', cooldownMs: seconds(properties.first_aid_cool_down_time_in_sec, 75) },
        { index: 2, itemId: number(properties.double_armor_item_id, 501), kind: 'doubleArmor', cooldownMs: seconds(properties.double_armor_cool_down_time_in_sec, 75) },
        { index: 3, itemId: number(properties.double_power_item_id, 502), kind: 'doublePower', cooldownMs: seconds(properties.double_power_cool_down_time_in_sec, 75) },
        { index: 4, itemId: number(properties.nitro_item_id, 503), kind: 'nitro', cooldownMs: seconds(properties.nitro_cool_down_time_in_sec, 75) },
        { index: 5, itemId: number(properties.mine_item_id, 504), kind: 'mine', cooldownMs: seconds(properties.mine_cool_down_time_in_sec, 0) },
      ],
      mineMinDistanceFromBase:number(properties.mine_min_distance_from_base,203),
      mineActivateMs: Math.max(0, number(properties.mine_activate_time_ms, 1000)),
      mineDamage: number(properties.mine_damage, 20),
      mineOffsetFromGround: number(properties.mine_offset_from_ground, 20),
      mineRadius: number(properties.mine_radius, 2463),
      mineImpactForce: number(properties.mine_impact_force, 2004.4),
    },
  };
}

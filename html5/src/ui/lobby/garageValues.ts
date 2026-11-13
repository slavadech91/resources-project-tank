/**
 * Значения таблицы модификаций гаража, как их считает клиент 2014 года:
 * ItemPropertyParamsServiceImpl (какие ItemProperty и множитель у колонки), UpgradableItemPropertyValue (SUM / RANGE),
 * GaragePropertyCalculator (значение по уровню микроапгрейда и число знаков), UpgradableParamsModel.initializePrecision.
 * Проверка тех же формул на конфигах сервера — tools/check_garage_table.py.
 */

import type { UpgradeProperty } from '../../net/lobby.ts';
import { themed } from '../theme.ts';

/** ItemGarageProperty (id сервера) → ItemProperty id, множитель, диапазон «от-до» */
const PARAMS: Record<number, { props: number[]; multiplier: number; range?: boolean }> = {
  1: { props: [0], multiplier: 1 }, // hull_armor
  2: { props: [1], multiplier: 1 }, // hull_speed
  3: { props: [3], multiplier: 1 }, // hull_turn_speed (сервер шлёт в градусах)
  4: { props: [6], multiplier: 100 }, // hull_power = hull_acceleration
  5: { props: [8], multiplier: 1 }, // hull_mass
  20: { props: [17], multiplier: 1 },
  21: { props: [18], multiplier: 1 },
  22: { props: [19], multiplier: 1 },
  23: { props: [20], multiplier: 1 },
  24: { props: [21], multiplier: 1 },
  26: { props: [23], multiplier: 1 },
  27: { props: [24], multiplier: 1 },
  28: { props: [25], multiplier: 1 },
  29: { props: [26], multiplier: 1 },
  40: { props: [12, 13], multiplier: 1, range: true }, // damage
  41: { props: [44], multiplier: 2 }, // damage_per_second = damage_per_period
  42: { props: [14, 15], multiplier: 0.001 }, // weapon_cooldown_time
  44: { props: [39], multiplier: 100 }, // critical_hit_chance
  45: { props: [40], multiplier: 1 }, // critical_hit_damage
  46: { props: [37], multiplier: 1 }, // shot_range = weapon_min_damage_radius
  47: { props: [9], multiplier: 180 / Math.PI }, // turret_turn_speed
  52: { props: [48], multiplier: 22 }, // fire_damage = flame_temperature_limit
  53: { props: [16], multiplier: 100 }, // weapon_weakening_coeff
  54: { props: [47], multiplier: 1 }, // isis_radius
  55: { props: [44], multiplier: 2 }, // isis_damage
  56: { props: [45], multiplier: 2 }, // isis_healing_per_second
  57: { props: [46], multiplier: 1 }, // isis_self_healing_percent
  58: { props: [28], multiplier: 1 }, // aiming_mode_damage
  60: { props: [32], multiplier: 100 }, // shaft_aimed_shot_impact
  62: { props: [12, 13], multiplier: 1, range: true }, // shaft_arcade_damage
  63: { props: [11], multiplier: 100 }, // weapon_impact_force
  66: { props: [14], multiplier: 1 }, // weapon_charge_rate
  67: { props: [36], multiplier: 1 }, // weapon_min_damage_percent
};

/** Number.toFixed во Flash и в JS одинаков для наших чисел */
class Calculator {
  precision = 0;
  private factor = 1;
  private maxWeight = 1;

  constructor(
    private readonly initial: number,
    private readonly final: number,
    private readonly maxLevel: number,
  ) {
    if (maxLevel <= 0) return;
    this.maxWeight = this.weight(maxLevel);
    const delta = Math.abs(this.calculate(maxLevel) - this.calculate(maxLevel - 1));
    // AS3: int(Infinity) = 0 при delta = 0
    const precision = delta > 0 ? Math.ceil(-Math.log(delta) / Math.LN10) : 0;
    this.precision = Math.max(precision, 0);
    this.factor = Math.pow(10, -this.precision);
    if (this.precision > 0) {
      this.precision--;
      this.factor *= 10;
      const zero = '+' + (0).toFixed(this.precision);
      for (let level = 0; level < maxLevel; level++) {
        if (this.delta(level) == zero) {
          this.precision++;
          this.factor *= 0.1;
          break;
        }
      }
    }
  }

  value(level: number): number {
    return this.calculate(level);
  }

  text(level: number): string {
    return this.round(this.calculate(level)).toFixed(this.precision);
  }

  setPrecision(precision: number): void {
    this.precision = precision;
    this.factor = Math.pow(10, -precision);
  }

  private delta(level: number): string {
    const d = this.round(this.round(this.calculate(level + 1)) - this.round(this.calculate(level)));
    return (d < 0 ? '−' : '+') + Math.abs(d).toFixed(this.precision);
  }

  private weight(level: number): number {
    return Math.log(level + 1) / Math.LN2 + (level * 5) / this.maxLevel;
  }

  private calculate(level: number): number {
    if (level == 0) return this.initial;
    return this.initial + (this.weight(level) * (this.final - this.initial)) / this.maxWeight;
  }

  private round(x: number): number {
    return Math.round(x / this.factor) * this.factor;
  }
}

export interface GarageValue {
  text: string;
  /** UpgradeColors: белый, светло-зелёный (улучшено), золотой (максимум) */
  color: string;
}

/** Калькуляторы ячейки: один или два (минимум и максимум диапазона); null — значений нет */
function cellCalculators(property: UpgradeProperty): Calculator[] | null {
  const params = PARAMS[property.propertyId];
  if (!params || !property.values) return null;
  const values = property.values.filter((value) => params.props.includes(value.itemPropertyId));
  if (params.range) {
    if (values.length != 2) return null;
    const [a, b] = values.map((value) => new Calculator(value.initial, value.final, property.maxLevel));
    const [low, high] = a.value(0) < b.value(0) ? [a, b] : [b, a];
    low.setPrecision(high.precision);
    return [low, high];
  }
  if (!values.length) return null;
  const initial = values.reduce((sum, value) => sum + value.initial, 0) * params.multiplier;
  const final = values.reduce((sum, value) => sum + value.final, 0) * params.multiplier;
  return [new Calculator(initial, final, property.maxLevel)];
}

/**
 * Строки таблицы: для каждой модификации — значения колонок в порядке `columns` (ItemGarageProperty id).
 * Число знаков колонки — наибольшее среди модификаций (initializePrecision).
 */
export function garageTable(rows: UpgradeProperty[][], columns: number[], roundDamageAndHealth = false): (GarageValue | null)[][] {
  const cells = rows.map((properties) =>
    columns.map((column) => {
      const property = properties.find((p) => p.propertyId == column);
      return property ? { property, calculators: cellCalculators(property) } : null;
    }),
  );
  columns.forEach((_column, index) => {
    const precision = Math.max(0, ...cells.map((row) => row[index]?.calculators?.at(-1)?.precision ?? 0));
    for (const row of cells) row[index]?.calculators?.forEach((calculator) => calculator.setPrecision(precision));
  });
  return cells.map((row) =>
    row.map((cell) => {
      if (!cell?.calculators) return null;
      const { property, calculators } = cell;
      // UpgradeColors: GOLD 16580352, LIGHT_GREEN 8847108, WHITE
      const color = property.maxLevel > 0 && property.level == property.maxLevel ? '#fcff00' : property.level > 0 ? themed('#86ff04') : '#ffffff';
      return { text: calculators.map((calculator) => roundDamageAndHealth && [1,40,41,45,52,55,58,62].includes(property.propertyId) ? String(Math.round(calculator.value(property.level))) : calculator.text(property.level)).join('-'), color };
    }),
  );
}

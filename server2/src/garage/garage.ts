import {AppearanceStore} from './appearance.ts';
/**
 * Гараж игрока на server2 — те же таблицы и правила, что у старого сервера (garage_tables.py, buyable_model.py,
 * item_model.py): UserItems + PropertyLevels (уровни микроулучшений), MountedItems (надетые пушка, корпус, краска).
 * Нет предметов — выдаются стартовые (starting_item_ids) и надеваются. Покупка нового предмета сразу его надевает;
 * следующая модификация заменяет прежнюю (её улучшения на максимуме дают скидку). Кристаллы списываются в той же
 * транзакции условием `crystals >= цена`, так что двойная покупка или гонка запросов не уводит баланс в минус.
 */
import type { GarageItemInfo, GarageLists } from '../../../html5/src/net2/protocol.ts';
import { formatDateTime, type Database, type Queryable } from '../db/mysql.ts';
import { RequestError } from '../errors.ts';
import { CATEGORY_ID, type GarageCatalog, type ItemDef } from './catalog.ts';

const SLOT: Partial<Record<ItemDef['category'], string>> = { weapon: 'weapon_slot', armor: 'armor_slot', color: 'color_slot' };
const MAX_COUNT = 9999;

interface OwnedItem {
  itemId: number;
  count: number;
  levelsId: number | null;
  /** уровни улучшений: id ItemGarageProperty → уровень */
  levels: Map<number, number>;
}

export interface GarageSnapshot extends GarageLists {
  owned: Map<number, OwnedItem>;
}

export class GarageService {
  private readonly db: Database;
  readonly catalog: GarageCatalog;
  readonly appearances:AppearanceStore;
  private readonly startingItems: number[];

  constructor(db: Database, catalog: GarageCatalog, startingItems: number[]) {
    this.db = db;
    this.catalog = catalog;
    this.appearances=new AppearanceStore(db,catalog);
    this.startingItems = startingItems;
  }

  /** гараж игрока; у нового — стартовые предметы (как DatabaseGarageItemLoader.create_starting_items) */
  async load(userId: number): Promise<GarageSnapshot> {
    let snapshot = await this.snapshot(this.db, userId);
    if (snapshot.owned.size === 0 && this.startingItems.length) {
      await this.db.transaction(async (tx) => {
        const owned = await this.ownedRows(tx, userId, true);
        if (owned.size) return;
        for (const id of this.startingItems) {
          const item = this.catalog.get(id);
          if (!item) continue;
          await this.addItem(tx, userId, item, 1);
          await this.mountInDb(tx, userId, item);
        }
      });
      snapshot = await this.snapshot(this.db, userId);
    }
    return snapshot;
  }

  /** предмет для игрока: цена магазина, его число припасов и уровни улучшений */
  info(item: ItemDef, owned: OwnedItem | undefined): GarageItemInfo {
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      category: CATEGORY_ID[item.category],
      position: item.position,
      minRank: item.minRank,
      maxRank: item.maxRank,
      previewId: item.previewId,
      price: this.catalog.shopPrice(item),
      discount: item.discount * 100,
      saleImageId: item.saleImageId,
      baseItemId: item.baseItemId,
      modification: item.modification ?? 0,
      object3dsId: item.object3dsId,
      coloringId: item.coloringId,
      count: item.countable ? owned?.count ?? 0 : 0,
      countable: item.countable,
      values: item.values,
      upgrades: item.upgrades.map((upgrade) => ({
        propertyId: upgrade.propertyId,
        level: owned?.levels.get(upgrade.propertyId) ?? upgrade.level,
        maxLevel: upgrade.maxLevel,
      })),
    };
  }

  infos(snapshot: GarageSnapshot, ids: Iterable<number> = this.catalog.items.keys()): GarageItemInfo[] {
    const result: GarageItemInfo[] = [];
    for (const id of new Set(ids)) {
      const item = this.catalog.get(id);
      if (item) result.push(this.info(item, snapshot.owned.get(id)));
    }
    return result;
  }

  /** покупка предмета или комплекта; возвращает затронутые предметы */
  async buy(userId: number, rank: number, itemId: number, count: number, expectedPrice: number, admin=false): Promise<number[]> {
    const item = this.require(itemId);
    if (!admin && rank < item.minRank) throw new RequestError('forbidden', `доступно со звания ${item.minRank}`);
    if (item.kit) return this.buyKit(userId, item, expectedPrice);
    if (!item.countable) count = 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new RequestError('bad_request', `количество 1…${MAX_COUNT}`);
    const total = Math.round(this.catalog.discountedPrice(item) * count);
    if (expectedPrice !== total) throw new RequestError('bad_request', `цена ${total}`);
    return this.db.transaction(async (tx) => {
      const owned = await this.ownedRows(tx, userId, true);
      const current = owned.get(item.id);
      if (current && !item.countable) throw new RequestError('bad_request', 'уже куплено');
      if (!current && item.baseItemId != null && this.ownedModification(owned, item)) throw new RequestError('bad_request', 'модификация уже есть на складе');
      await this.spend(tx, userId, total);
      if (current) {
        await tx.query('UPDATE UserItems SET count = count + ? WHERE user_id = ? AND item_id = ?', [count, userId, item.id]);
      } else {
        await this.addItem(tx, userId, item, count);
        await this.mountInDb(tx, userId, item);
      }
      return [item.id];
    });
  }

  /** следующая модификация вместо купленной (BuyableModel.buy_next_modification) */
  async buyNext(userId: number, rank: number, itemId: number, expectedPrice: number, admin=false): Promise<number[]> {
    const next = this.require(itemId);
    if (next.baseItemId == null || !next.modification) throw new RequestError('bad_request', 'у предмета нет модификаций');
    if (!admin && rank < next.minRank) throw new RequestError('forbidden', `доступно со звания ${next.minRank}`);
    const previous = this.catalog.modifications(next).find((mod) => mod.modification === next.modification! - 1);
    if (!previous) throw new RequestError('bad_request', 'нет предыдущей модификации');
    return this.db.transaction(async (tx) => {
      const owned = await this.ownedRows(tx, userId, true);
      const current = owned.get(previous.id);
      if (!current) throw new RequestError('bad_request', `сначала купите M${previous.modification}`);
      const base = this.catalog.discountedPrice(next);
      const price = Math.round(base - this.modificationDiscount(previous, current) * base);
      if (expectedPrice !== price) throw new RequestError('bad_request', `цена ${price}`);
      await this.spend(tx, userId, price);
      await this.addItem(tx, userId, next, 1);
      await this.mountInDb(tx, userId, next);
      await this.removeItem(tx, userId, current);
      return [next.id, previous.id];
    });
  }

  /** /resetgarage: удалить предметы и уровни, снять надетое (garage_tables.reset_user_garage) */
  async resetUser(userId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ property_levels_id: number | null }>('SELECT property_levels_id FROM UserItems WHERE user_id = ?', [userId]);
      for (const row of rows) if (row.property_levels_id != null) await tx.query('DELETE FROM PropertyLevels WHERE id = ?', [row.property_levels_id]);
      await tx.query('DELETE FROM UserItems WHERE user_id = ?', [userId]);
      await tx.query('UPDATE MountedItems SET weapon_slot = NULL, armor_slot = NULL, color_slot = NULL WHERE user_id = ?', [userId]);
    });
  }

  /** надеть купленный корпус, пушку или краску */
  async mount(userId: number, itemId: number): Promise<void> {
    const item = this.require(itemId);
    if (!SLOT[item.category]) throw new RequestError('bad_request', 'этот предмет не надевается');
    const { rows } = await this.db.query('SELECT item_id FROM UserItems WHERE user_id = ? AND item_id = ? LIMIT 1', [userId, item.id]);
    if (!rows.length) throw new RequestError('bad_request', 'предмет не куплен');
    await this.mountInDb(this.db, userId, item);
  }

  private require(itemId: number): ItemDef {
    const item = this.catalog.get(itemId);
    if (!item) throw new RequestError('not_found', 'нет такого предмета');
    return item;
  }

  /** комплект: цена по составу; предметы, которые уже есть в той же или старшей модификации, пропускаются */
  private async buyKit(userId: number, kit: ItemDef, expectedPrice: number): Promise<number[]> {
    const price = this.catalog.shopPrice(kit);
    if (expectedPrice !== price) throw new RequestError('bad_request', `цена ${price}`);
    return this.db.transaction(async (tx) => {
      const owned = await this.ownedRows(tx, userId, true);
      await this.spend(tx, userId, price);
      const touched: number[] = [];
      for (const entry of kit.kit!.items) {
        const part = this.catalog.get(entry.item);
        if (!part) continue;
        const current = owned.get(part.id);
        if (part.countable) {
          if (current) await tx.query('UPDATE UserItems SET count = count + ? WHERE user_id = ? AND item_id = ?', [entry.count, userId, part.id]);
          else await this.addItem(tx, userId, part, entry.count);
          touched.push(part.id);
          continue;
        }
        if (current) continue;
        const older = part.baseItemId != null ? this.ownedModification(owned, part) : undefined;
        if (older && (this.catalog.get(older.itemId)?.modification ?? 0) >= (part.modification ?? 0)) continue;
        await this.addItem(tx, userId, part, 1);
        if (entry.mount) await this.mountInDb(tx, userId, part);
        if (older) {
          await this.removeItem(tx, userId, older);
          touched.push(older.itemId);
        }
        touched.push(part.id);
      }
      return touched;
    });
  }

  /** скидка на следующую модификацию: доля цены, уже вложенная в улучшения на максимуме (calculate_modification_discount) */
  private modificationDiscount(item: ItemDef, owned: OwnedItem): number {
    const price = this.catalog.discountedPrice(item);
    if (price === 0) return 0;
    let discount = 0;
    for (const upgrade of item.upgrades) {
      if (owned.levels.get(upgrade.propertyId) !== upgrade.maxLevel) continue;
      let spent = 0;
      for (let level = 0; level < upgrade.maxLevel; level++) spent += upgrade.cost.initial + upgrade.cost.step * level;
      discount += spent / price;
    }
    return Math.round(discount * 100) / 100;
  }

  private ownedModification(owned: Map<number, OwnedItem>, item: ItemDef): OwnedItem | undefined {
    for (const mod of this.catalog.modifications(item)) {
      const current = owned.get(mod.id);
      if (current) return current;
    }
    return undefined;
  }

  /** списание: при нехватке кристаллов строка не меняется — покупка отклоняется */
  private async spend(tx: Queryable, userId: number, price: number): Promise<void> {
    if (price <= 0) return;
    const result = await tx.query('UPDATE UserProperties SET crystals = crystals - ? WHERE id = ? AND crystals >= ?', [price, userId, price]);
    if (result.affectedRows !== 1) throw new RequestError('no_crystals', 'недостаточно кристаллов');
  }

  /** garage_tables.add_item: уровни улучшений — новая группа PropertyLevels (MAX(id) + 1, под блокировкой) */
  private async addItem(tx: Queryable, userId: number, item: ItemDef, count: number): Promise<void> {
    let levelsId: number | null = null;
    if (item.upgrades.length) {
      const { rows } = await tx.query<{ last: number | null }>('SELECT MAX(id) AS last FROM PropertyLevels FOR UPDATE');
      levelsId = (rows[0]?.last ?? 0) + 1;
      for (const upgrade of item.upgrades) {
        await tx.query('INSERT INTO PropertyLevels (id, property_id, property_level) VALUES (?, ?, ?)', [levelsId, upgrade.propertyId, upgrade.level]);
      }
    }
    const expiration = item.temporaryLifeSec ? formatDateTime(new Date(Date.now() + item.temporaryLifeSec * 1000)) : null;
    await tx.query(
      'INSERT INTO UserItems (user_id, item_id, upgrading_property_id, upgrade_done_time, property_levels_id, count, temporary_item_expiration) VALUES (?, ?, NULL, NULL, ?, ?, ?)',
      [userId, item.id, levelsId, count, expiration],
    );
  }

  private async removeItem(tx: Queryable, userId: number, owned: OwnedItem): Promise<void> {
    await tx.query('DELETE FROM UserItems WHERE item_id = ? AND user_id = ?', [owned.itemId, userId]);
    if (owned.levelsId != null) await tx.query('DELETE FROM PropertyLevels WHERE id = ?', [owned.levelsId]);
  }

  private async mountInDb(tx: Queryable, userId: number, item: ItemDef): Promise<void> {
    const slot = SLOT[item.category];
    if (!slot) return;
    await tx.query(`INSERT INTO MountedItems (user_id, ${slot}) VALUES (?, ?) ON DUPLICATE KEY UPDATE ${slot} = VALUES(${slot})`, [userId, item.id]);
  }

  private async ownedRows(db: Queryable, userId: number, lock = false): Promise<Map<number, OwnedItem>> {
    const { rows } = await db.query<{ item_id: number; count: number | null; property_levels_id: number | null }>(
      `SELECT item_id, count, property_levels_id FROM UserItems WHERE user_id = ?${lock ? ' FOR UPDATE' : ''}`,
      [userId],
    );
    const owned = new Map<number, OwnedItem>();
    const levelIds = rows.map((row) => row.property_levels_id).filter((id): id is number => id != null);
    const levels = new Map<number, Map<number, number>>();
    if (levelIds.length) {
      const result = await db.query<{ id: number; property_id: number; property_level: number }>(
        `SELECT id, property_id, property_level FROM PropertyLevels WHERE id IN (${levelIds.map(() => '?').join(', ')})`,
        levelIds,
      );
      for (const row of result.rows) {
        const group = levels.get(row.id) ?? new Map<number, number>();
        group.set(row.property_id, row.property_level);
        levels.set(row.id, group);
      }
    }
    for (const row of rows) {
      if (!this.catalog.get(row.item_id)) continue;
      owned.set(row.item_id, {
        itemId: row.item_id,
        count: row.count ?? 0,
        levelsId: row.property_levels_id,
        levels: row.property_levels_id != null ? levels.get(row.property_levels_id) ?? new Map() : new Map(),
      });
    }
    return owned;
  }

  /** списки как GarageModel.add_item_to_list + нормализация html5: на складе старшая модификация, в магазине — M0 некупленных */
  async snapshot(db: Queryable, userId: number): Promise<GarageSnapshot> {
    const owned = await this.ownedRows(db, userId);
    const { rows } = await db.query<{ weapon_slot: number | null; armor_slot: number | null; color_slot: number | null }>(
      'SELECT weapon_slot, armor_slot, color_slot FROM MountedItems WHERE user_id = ?',
      [userId],
    );
    const slots = rows[0];
    const mounted = slots ? [slots.weapon_slot, slots.armor_slot, slots.color_slot].filter((id): id is number => id != null && owned.has(id)) : [];
    const depot: number[] = [];
    const market: number[] = [];
    const ownedBases = new Set<number>();
    for (const id of owned.keys()) {
      const base = this.catalog.get(id)?.baseItemId;
      if (base != null) ownedBases.add(base);
    }
    for (const item of this.catalog.items.values()) {
      if (owned.has(item.id)) {
        const best = item.baseItemId == null ? item : this.catalog.modifications(item).filter((mod) => owned.has(mod.id)).pop();
        if (best === item) depot.push(item.id);
      } else if (item.baseItemId == null || (item.modification === 0 && !ownedBases.has(item.baseItemId))) {
        market.push(item.id);
      }
    }
    return { owned, depot, market, mounted,appearances:await this.appearances.get(userId) };
  }
}

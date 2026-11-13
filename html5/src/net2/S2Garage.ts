import type {AppearanceMap,AppearanceStyle} from './appearance.ts';
/**
 * Гараж server2 для окна GarageView (интерфейс GarageData, как GarageState старого протокола). Покупки и установка —
 * запросы к server2; списки и затронутые предметы приходят в ответе, новый баланс — событием user. Надевание
 * показывается сразу (как во Flash), ответ сервера его подтверждает.
 */
import type { GarageData, GarageItem } from '../net/lobby.ts';
import type { Connection } from './Connection.ts';
import type { GarageItemInfo, GarageLists } from './protocol.ts';

function toGarageItem(info: GarageItemInfo): GarageItem {
  return {
    objectId: info.id,
    name: info.name,
    description: info.description,
    category: info.category,
    position: info.position,
    minRank: info.minRank,
    maxRank: info.maxRank,
    previewId: info.previewId,
    price: info.price,
    buyable: true,
    count: info.count,
    discount: info.discount,
    saleImageId: info.saleImageId,
    baseItemId: info.baseItemId,
    modification: info.modification,
    object3dsId: info.object3dsId,
    coloringId: info.coloringId,
    // как UpgradeableParamsConstructorModel: у каждого улучшаемого параметра — все свойства предмета
    properties: info.upgrades.map((upgrade) => ({ propertyId: upgrade.propertyId, level: upgrade.level, maxLevel: upgrade.maxLevel, values: info.values })),
  };
}

export class S2Garage implements GarageData {
  appearances:AppearanceMap={};
  depot: number[] = [];
  market: number[] = [];
  mounted: number[] = [];
  onChange: (() => void) | null = null;
  /** ошибка покупки или установки (текст для игрока показывает владелец) */
  onError: ((error: unknown) => void) | null = null;
  private connection: Connection | null = null;
  private readonly byId = new Map<number, GarageItem>();
  private loaded = false;

  /** новая сессия (окно гаража живёт дольше соединения): прежние данные сбрасываются */
  connect(connection: Connection): void {
    this.connection = connection;
    this.byId.clear();this.appearances={};
    this.depot = this.market = this.mounted = [];
    this.loaded = false;
  }

  private get server(): Connection {
    if (!this.connection) throw new Error('гараж server2 без соединения');
    return this.connection;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<void> {
    const reply = await this.server.request('garage.load', {});
    this.byId.clear();
    for (const info of reply.items) this.byId.set(info.id, toGarageItem(info));
    this.applyLists(reply);
    this.loaded = true;
    this.onChange?.();
  }

  item(objectId: number): GarageItem | null {
    return this.byId.get(objectId) ?? null;
  }

  items(ids: number[]): GarageItem[] {
    return ids.map((id) => this.byId.get(id)).filter((item): item is GarageItem => item != null);
  }

  modifications(item: GarageItem): GarageItem[] {
    if (item.baseItemId == null) return [item];
    return [...this.byId.values()].filter((other) => other.baseItemId == item.baseItemId).sort((a, b) => a.modification - b.modification);
  }

  setAppearance(item:GarageItem,style:AppearanceStyle):void{this.server.request('garage.appearance',{itemId:item.objectId,style}).then(reply=>{this.appearances=reply.appearances;this.onChange?.();},error=>this.fail(error));}

  mount(objectId: number): void {
    const item = this.item(objectId);
    if (!item) return;
    this.mounted = [...this.mounted.filter((id) => this.item(id)?.category != item.category), objectId];
    this.onChange?.();
    this.server.request('garage.mount', { itemId: objectId }).then(
      (reply) => this.update(reply, []),
      (error: unknown) => this.fail(error),
    );
  }

  buy(item: GarageItem, count = 1): void {
    this.server.request('garage.buy', { itemId: item.objectId, count, price: item.price * count }).then(
      (reply) => this.update(reply, reply.updated),
      (error: unknown) => this.fail(error),
    );
  }

  buyNextModification(next: GarageItem): void {
    this.server.request('garage.buyNext', { itemId: next.objectId, price: next.price }).then(
      (reply) => this.update(reply, reply.updated),
      (error: unknown) => this.fail(error),
    );
  }

  private update(lists: GarageLists, updated: GarageItemInfo[]): void {
    for (const info of updated) this.byId.set(info.id, toGarageItem(info));
    this.applyLists(lists);
    this.onChange?.();
  }

  private applyLists(lists: GarageLists): void {
    if(lists.appearances)this.appearances=lists.appearances;
    this.depot = lists.depot;
    this.market = lists.market;
    this.mounted = lists.mounted;
  }

  /** ошибка: показать и вернуть списки сервера (надевание могло не состояться) */
  private fail(error: unknown): void {
    this.onError?.(error);
    this.connection?.request('garage.load', {}).then(
      (reply) => this.update(reply, reply.items),
      () => undefined,
    );
  }
}

import {appearanceFamily,appearanceFor,appearancePartPath} from '../../net2/appearance.ts';
import {AppearanceDialog} from './AppearanceDialog.ts';
/**
 * Раздел «Гараж»: GarageWindow (правые две трети экрана) — TankPreviewWindow «Мой танк», ItemInfoPanel «Информация»,
 * Один PartsList с вкладками ProTanki (плитки 203×130, горизонтальная прокрутка).
 */

import { loadPartsMap } from '../../tanks/render/tankParts.ts';
import { ITEM_CATEGORY, type GarageData, type GarageItem } from '../../net/lobby.ts';
import {GarageCategories} from './GarageCategories.ts';
import { GaragePreview } from './GaragePreview.ts';
import { garageTable } from './garageValues.ts';
import { BigButton, HEADER, INNER, NumStepper, RES, RES_VERSION, TankWindow, WindowInner, bitmap, el, formatMoney, label, place, setSpriteFrame, sprite } from './widgets.ts';
import { themed } from '../theme.ts';

/** пушки, у которых в html5 есть стрельба (tanks/weapon); остальные в магазине «В разработке» — купить может только администратор.
 *  Корпуса все рабочие (модели всех восьми есть, физика общая). Сервер покупку не ограничивает: Flash-клиент умеет всё */

/** базовый порядок гаража (пользователь, 28.10): пушки, корпуса, припасы, затем краски и прочее; неизвестные — в конце группы */
const CATEGORY_ORDER: number[] = [ITEM_CATEGORY.WEAPON, ITEM_CATEGORY.ARMOR, ITEM_CATEGORY.INVENTORY, ITEM_CATEGORY.COLOR];
const TURRET_ORDER = ['smoky', 'twins', 'firebird', 'railgun', 'isida', 'thunder', 'freeze', 'ricochet', 'shaft'];
const IMPLEMENTED_TURRETS = new Set(TURRET_ORDER);
const HULL_ORDER = ['wasp', 'hunter', 'titan', 'dictator', 'hornet', 'viking', 'mammoth', 'varan'];
/** строки M0–M3 ниже значков характеристик (по просьбе пользователя, 28.10) */
const MOD_TABLE_SHIFT = 7;
const HEADER_HEIGHT = 60;
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 530;
/** GarageWindow: itemInfoPanelWidth, высота окон списков, отступ под вертикальный заголовок */
const INFO_WIDTH = 412;
const LIST_HEIGHT = 205;
const LIST_INNER_HEIGHT=169;

const MARGIN = 11;
/** ItemInfoPanel */
const BOTTOM_MARGIN = 64;
const HORIZONTAL_MARGIN = 12;
const VERTICAL_MARGIN = 9;
const BUTTON_WIDTH = 120;
/** ItemInfoPanel.INVENTORY_MAX_VALUE */
const INVENTORY_MAX_VALUE = 9999;
const TEXT_GREEN = '#05d118'; // 381208

/** ItemPropertyParamsServiceImpl: значок и порядок свойства (ItemGarageProperty id) */
const PROPERTY_ICONS: Record<number, [string, number]> = {
  1: ['bitmapArmor', 1], 2: ['bitmapSpeed', 2], 3: ['bitmapTurnSpeed', 3], 4: ['bitmapHullPower', 5], 5: ['bitmapHullMass', 4],
  20: ['bitmapFireResistance', 14], 21: ['bitmapMechResistance', 13], 22: ['bitmapPlasmaResistance', 15], 23: ['bitmapRailResistance', 16],
  24: ['bitmapVampireResistance', 17], 26: ['bitmapThunderResistance', 18], 27: ['bitmapFreezeResistance', 19],
  28: ['bitmapRicochetResistance', 20], 29: ['shaftResistanceClass', 21],
  40: ['bitmapArmorWear', 3], 41: ['bitmapArmorWear', 3], 42: ['bitmapRateOfFire', 5], 44: ['percentClass', 23], 45: ['smokyCritClass', 24],
  46: ['bitmapRange', 9], 47: ['bitmapTurretRotationRate', 7], 52: ['firebirdClass', 25], 53: ['piercingCoeffClass', 28],
  54: ['bitmapHealingRadius', 22], 55: ['bitmapVampireRate', 2], 56: ['bitmapHealRate', 1], 57: ['selfMedicationPercentClass', 3],
  58: ['shaftDamageClass', 1], 60: ['aimingImpactForceClass', 2], 62: ['bitmapArmorWear', 3], 63: ['impactForceClass', 4],
  65: ['bitmapRicochetResistance', 26], 66: ['bitmapRateOfFire', 4], 67: ['minDamagePercentClass', 30],
};

/** PartsList.myIcon: имя кадра GarageItemBackground по категории */
function backgroundFrame(item: GarageItem, locked: boolean, installed: boolean, selected: boolean): number {
  let base = 'PLUGIN';
  if (locked) base = 'OFF';
  else if (item.category == ITEM_CATEGORY.WEAPON) base = 'GUN';
  else if (item.category == ITEM_CATEGORY.ARMOR) base = 'SHIELD';
  else if (item.category == ITEM_CATEGORY.COLOR) base = 'COLOR';
  else if (item.category == ITEM_CATEGORY.INVENTORY) base = 'ENGINE';
  const frames: Record<string, number> = { OFF: 1, SHIELD: 3, GUN: 7, ENGINE: 11, COLOR: 15, PLUGIN: 19 };
  const canInstall = base == 'SHIELD' || base == 'GUN' || base == 'ENGINE' || base == 'COLOR';
  return frames[base] + (installed && canInstall ? 2 : 0) + (selected ? 1 : 0);
}

interface Tile {
  item: GarageItem;
  depot: boolean;
  /** картинка скидки (ресурс) или null */
  sale: number | null;
  /** звание для сортировки: −1 у предметов склада, 0 — доступен, иначе нужное звание */
  rank: number;
}

export interface GarageCallbacks {
  userName(): string;
  userRank(): number;
  crystals(): number;
  /** GarageModel: moneyService.spend — сервер не присылает новый баланс, клиент вычитает цену сам */
  spend(price: number): void;
  /** администратор может покупать нереализованные в html5 пушки */
  isAdmin(): boolean;
}

class PartsList {
  readonly window: TankWindow;
  readonly inner: WindowInner;
  readonly list: HTMLDivElement;
  tiles: Tile[] = [];
  selected: number | null = null;
  onSelect: ((tile: Tile) => void) | null = null;
  /** предмет магазина ещё не реализован в html5 (подпись «В разработке») */
  unfinished: (item: GarageItem) => boolean = () => false;
  appearancePreview:(item:GarageItem)=>string|null=()=>null;
  /** ключ сортировки плиток (GarageView.sortKey) */
  sortKey: (item: GarageItem) => number[] = (item) => [item.position];
  private backgrounds: { img: HTMLImageElement; item: GarageItem; locked: boolean; installed: boolean }[] = [];

  constructor(parent: HTMLElement, header: number) {
    this.window = new TankWindow(parent, header);
    this.inner = new WindowInner(parent, INNER.GREEN, true);
    this.list = el('div', 'lb-tiles', parent);
    // колесо мыши крутит плитки по горизонтали, как TileList
    this.list.addEventListener('wheel', (event) => {
      this.list.scrollLeft += event.deltaY;
      event.preventDefault();
    });
  }

  /** выбор предмета меняет только кадр подложки, плитки не пересоздаются (иначе картинки мигают) */
  updateSelection(): void {
    for (const { img, item, locked, installed } of this.backgrounds) {
      setSpriteFrame(img, 'GarageItemBackground', backgroundFrame(item, locked, installed, item.objectId == this.selected));
    }
  }

  render(mounted: number[]): void {
    const scroll = this.list.scrollLeft;
    this.list.textContent = '';
    this.backgrounds = [];
    // вместо dp.sortOn(["rang", "sort"]) оригинала — порядок по категориям и типам (CATEGORY_ORDER и др.)
    const keys = new Map(this.tiles.map((tile) => [tile, this.sortKey(tile.item)]));
    this.tiles.sort((a, b) => {
      const ka = [a.depot?-1:a.rank,...keys.get(a)??[]];
      const kb = [b.depot?-1:b.rank,...keys.get(b)??[]];
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? 0) != (kb[i] ?? 0)) return (ka[i] ?? 0) - (kb[i] ?? 0);
      return 0;
    });
    for (const tile of this.tiles) {
      const node = el('div', 'lb-tile', this.list);
      const item = tile.item;
      const selected = item.objectId == this.selected;
      const locked = tile.rank > 0 && !tile.depot;
      const installed = tile.depot && mounted.includes(item.objectId) && item.category != ITEM_CATEGORY.INVENTORY;
      const background = sprite(node, 'GarageItemBackground', backgroundFrame(item, locked, installed, selected));
      this.backgrounds.push({ img: background, item, locked, installed });
      const preview = el('img', 'lb-abs', node);
      preview.draggable = false;
      preview.src = this.appearancePreview(item)??`${RES}/${item.previewId}.png?v=${RES_VERSION}`;
      place(preview, 19, 18);
      if (!tile.depot && this.unfinished(item)) {
        preview.style.opacity = '0.45';
        const soon = label(node, 'В разработке', 'lb-tile-soon');
        place(soon, 8, 106);
      }
      let color = themed('#59ff32'); // 5898034
      if (locked) {
        color = '#c0c0c0'; // 12632256
        if (item.category != ITEM_CATEGORY.PLUGIN) sprite(node, 'RangIconNormal', tile.rank, 135, 60);
      } else if (installed) {
        color = item.category == ITEM_CATEGORY.WEAPON ? themed('#84a867') : item.category == ITEM_CATEGORY.ARMOR ? '#8f9ca4' : '#a899ae';
      }
      if (tile.depot && (item.category == ITEM_CATEGORY.WEAPON || item.category == ITEM_CATEGORY.ARMOR)) sprite(node, 'IconGarageMod', item.modification + 1, 159, 7);
      if (item.category == ITEM_CATEGORY.INVENTORY && tile.depot) {
        const count = label(node, item.count == 0 ? ' ' : `×${item.count}`);
        count.style.font = "16px/25px 'MyriadPro', Arial, sans-serif";
        count.style.color = color;
        count.style.textAlign = 'right';
        place(count, 90, 100, 100, 25);
      }
      const name = label(node, item.name);
      name.style.color = color;
      place(name, 3, 2, 150);
      if ((!tile.depot || item.category == ITEM_CATEGORY.INVENTORY) && item.price > 0) {
        const price = label(node, formatMoney(item.price));
        price.style.color = color;
        price.style.right = `${203 - 184}px`;
        price.style.top = '2px';
        sprite(node, 'Diamond', 1, 186, 6);
      }
      if (tile.sale != null) {
        const sale = el('img', 'lb-abs', node);
        sale.draggable = false;
        sale.src = `${RES}/${tile.sale}.png`;
        // прижата к левому нижнему углу плитки 130 px сразу, без сдвига после загрузки
        sale.style.left = '0px';
        sale.style.bottom = '0px';
      }
      node.addEventListener('click', () => {
        this.selected = item.objectId;
        this.onSelect?.(tile);
      });
    }
    this.list.scrollLeft = scroll;
  }

  setBounds(x: number, y: number, width: number): void {
    this.window.setBounds(x, y, width, LIST_HEIGHT);
    this.inner.setBounds(x + MARGIN, y + MARGIN, width - MARGIN * 2, LIST_INNER_HEIGHT - MARGIN * 2);
    // Native scrollbar and its track sit at the list's bottom; keep tiles in place and raise that edge by 8px.
    place(this.list, x + MARGIN + 4, y + MARGIN + 4, width - MARGIN * 2 - 8, LIST_INNER_HEIGHT - MARGIN * 2 + 1 - 8);
  }
}

export class GarageView {
  readonly root: HTMLDivElement;
  private readonly previewWindow: TankWindow;
  private readonly previewBevel: WindowInner;
  readonly preview: GaragePreview;
  // ItemInfoPanel
  private readonly infoWindow: TankWindow;
  private readonly infoInner: WindowInner;
  private readonly infoArea: HTMLDivElement;
  private readonly itemName: HTMLDivElement;
  private readonly description: HTMLDivElement;
  private readonly leftPreview: HTMLImageElement;
  private readonly propertiesPanel: HTMLDivElement;
  private readonly modTable: HTMLDivElement;
  private readonly buyButton: BigButton;
  /** ItemInfoPanel.inventoryNumStepper: сколько припасов купить (1..9999, не больше, чем хватает кристаллов) */
  private readonly countStepper: NumStepper;
  private stepperVisible = false;
  private buyTarget: GarageItem | null = null;
  private readonly equipButton: BigButton;
  private readonly upgradeButton: BigButton;
  private appearanceDialog:AppearanceDialog|null=null;
  private readonly partsList:PartsList;
  private readonly categories:GarageCategories;
  private depotTiles:Tile[]=[];
  private storeTiles:Tile[]=[];
  private infoWidth = INFO_WIDTH;
  private infoHeight = 300;
  private selected: Tile | null = null;
  private refreshing=false;

  constructor(parent: HTMLElement, private readonly state: GarageData, private readonly callbacks: GarageCallbacks) {
    this.root = el('div', 'lb-panel', parent);

    this.previewWindow = new TankWindow(this.root, HEADER.YOUR_TANK);
    this.preview = new GaragePreview(this.previewWindow.root);
    this.previewBevel = new WindowInner(this.previewWindow.root, INNER.TRANSPARENT);
    this.previewBevel.root.style.pointerEvents = 'none';

    this.infoWindow = new TankWindow(this.root, HEADER.INFORMATION);
    this.infoInner = new WindowInner(this.infoWindow.root, INNER.GREEN, true);
    this.infoArea = el('div', 'lb-abs', this.infoWindow.root);
    this.infoArea.style.overflowY = 'auto';
    this.infoArea.style.overflowX = 'hidden';
    this.itemName = label(this.infoArea, '');
    this.itemName.style.font = "18px/22px 'MyriadPro', Arial, sans-serif";
    this.itemName.style.color = themed(TEXT_GREEN);
    place(this.itemName, HORIZONTAL_MARGIN - 3, VERTICAL_MARGIN - 7);
    this.propertiesPanel = el('div', 'lb-abs', this.infoArea);
    this.modTable = el('div', 'lb-abs', this.infoArea);
    this.leftPreview = el('img', 'lb-abs', this.infoArea);
    this.leftPreview.draggable = false;
    this.description = el('div', 'lb-text', this.infoArea);
    this.description.style.color = themed(TEXT_GREEN);

    this.buyButton = new BigButton(this.infoWindow.root, 'Купить', 'Green');
    this.buyButton.onClick = () => this.buy();
    this.countStepper = new NumStepper(this.infoWindow.root);
    this.countStepper.onChange = () => this.updateBuyButton();
    this.countStepper.root.style.display = 'none';
    this.equipButton = new BigButton(this.infoWindow.root, 'Установить');
    this.equipButton.onClick = () => {
      if (this.selected) this.state.mount(this.selected.item.objectId);
    };
    this.upgradeButton = new BigButton(this.infoWindow.root, 'Улучшить');
    this.upgradeButton.onClick=()=>{
      const item=this.selected?.item;if(!item||!this.state.setAppearance||item.object3dsId==null)return;
      const path=this.parts[item.object3dsId];if(!path||!appearanceFamily(path))return;
      this.appearanceDialog??=new AppearanceDialog();this.appearanceDialog.show(item.name,path,appearanceFor(path,this.state.appearances),style=>this.state.setAppearance?.(item,style));
    };

    this.partsList=new PartsList(this.root,0);
    this.categories=new GarageCategories(this.root);
    this.partsList.onSelect=tile=>this.select(tile);
    this.partsList.unfinished=item=>this.unfinished(item)&&!this.callbacks.isAdmin();
    this.partsList.sortKey=item=>this.sortKey(item);
    this.partsList.appearancePreview=item=>this.appearancePreview(item);
    this.categories.onSelect=()=>{this.partsList.list.scrollLeft=0;this.renderCategory();};
    void loadPartsMap().then(parts=>{this.parts=parts;this.refresh();});

    this.showGreeting();
    window.addEventListener('resize', this.layout);
    this.layout();
  }

  set visible(value: boolean) {
    this.root.style.display = value ? '' : 'none';
    if (value) {
      this.layout();
      this.preview.start();
    } else {
      this.preview.stop();this.appearanceDialog?.close();
    }
  }

  /** Новые данные гаража: перестроить списки, обновить превью танка */
  refresh(): void {
    this.refreshing=true;
    const rank = this.callbacks.userRank();
    // GarageWindow.addItemToWarehouse: на складе скидка видна у расходников и у следующей модификации
    const depotSale = (item: GarageItem): number | null => {
      if (item.category == ITEM_CATEGORY.INVENTORY) return item.saleImageId;
      if (item.baseItemId == null) return null;
      return this.state.modifications(item).find((mod) => mod.modification == item.modification + 1)?.saleImageId ?? null;
    };
    this.depotTiles = this.state.items(this.state.depot).map((item) => ({ item, depot: true, rank: -1, sale: depotSale(item) }));
    this.storeTiles = this.state.items(this.state.market).map((item) => ({
      item,
      depot: false,
      sale: item.saleImageId,
      // GarageWindow.addItemToStore: нужное звание, если текущее вне диапазона
      rank: this.callbacks.isAdmin()?0:rank < item.minRank ? item.minRank : rank > item.maxRank ? item.maxRank : 0,
    }));
    this.renderCategory();
    if (this.selected) {
      const all = [...this.depotTiles, ...this.storeTiles];
      const previous = this.selected.item;
      // купленная модификация — другой объект: карточка переходит на неё (тот же base_item_id)
      const fresh =
        all.find((tile) => tile.item.objectId == previous.objectId) ??
        (previous.baseItemId != null ? all.find((tile) => tile.item.baseItemId == previous.baseItemId) : undefined);
      if (fresh) {
        this.selected = fresh;
        this.partsList.selected=fresh.item.objectId;
        this.partsList.updateSelection();
        this.showItem(fresh);
      }
    }
    this.refreshing=false;
    this.tankLoading = this.updateTank(this.selected?.item).catch(() => undefined);
  }

  private renderCategory():void{
    const seen=new Set<number>(),category=this.categories.selected;
    this.partsList.tiles=[...this.depotTiles,...this.storeTiles].filter(tile=>{if(seen.has(tile.item.objectId))return false;seen.add(tile.item.objectId);return category===ITEM_CATEGORY.PLUGIN?[ITEM_CATEGORY.PLUGIN,ITEM_CATEGORY.EMBLEM].includes(tile.item.category as 4|6):tile.item.category===category;});
    this.partsList.render(this.state.mounted);
    if(!this.partsList.tiles.length){this.selected=null;this.partsList.selected=null;this.showGreeting();this.itemName.textContent='Нет предметов';this.description.textContent='В этой категории пока нет предметов';return;}
    if(this.partsList.tiles.length&&!this.partsList.tiles.some(t=>t.item.objectId===this.selected?.item.objectId))this.select(this.partsList.tiles.find(t=>this.state.mounted.includes(t.item.objectId))??this.partsList.tiles[0]);
  }

  /** загрузка модели танка в окне «Ваш танк» (экран загрузки гаража ждёт её) */
  tankLoading: Promise<void> = Promise.resolve();

  private async updateTank(previewItem?:GarageItem): Promise<void> {
    const mounted = this.state.items(this.state.mounted).filter(item=>!previewItem||item.category!==previewItem.category);if(previewItem)mounted.push(previewItem);
    const hull = mounted.find((item) => item.category == ITEM_CATEGORY.ARMOR);
    const turret = mounted.find((item) => item.category == ITEM_CATEGORY.WEAPON);
    const paint = mounted.find((item) => item.category == ITEM_CATEGORY.COLOR);
    if (!hull?.object3dsId || !turret?.object3dsId) return;
    const parts = await loadPartsMap();
    const hullPath = parts[hull.object3dsId];
    const turretPath = parts[turret.object3dsId];
    const paintPath = (paint?.coloringId != null ? parts[paint.coloringId] : undefined) ?? 'paints/green.jpg';
    if (!hullPath || !turretPath) return;
    const load = (h: string, t: string): Promise<void> => this.preview.setTank(`tank_parts/${appearancePartPath(h,appearanceFor(h,this.state.appearances))}`, `tank_parts/${appearancePartPath(t,appearanceFor(t,this.state.appearances))}`, `tank_parts/${paintPath}`);
    // у части модификаций своих моделей нет (в конфиге они ссылаются на M0) — тогда берём M0
    await load(hullPath, turretPath).catch(() => load(hullPath.replace(/m\d$/, 'm0'), turretPath.replace(/m\d$/, 'm0'))).catch((error: unknown) => console.warn('гараж: танк не загружен', error));
  }

  private select(tile: Tile): void {
    this.selected = tile;
    this.partsList.selected=tile.item.objectId;
    this.partsList.updateSelection();
    this.showItem(tile);if(!this.refreshing)this.tankLoading=this.updateTank(tile.item).catch(()=>undefined);
  }

  private showGreeting(): void {
    this.itemName.textContent = `Hello, ${this.callbacks.userName()}!`;
    this.description.textContent = 'Description';
    this.propertiesPanel.style.display = 'none';
    this.modTable.style.display = 'none';
    this.leftPreview.style.display = 'none';
    for (const button of [this.buyButton, this.equipButton, this.upgradeButton]) button.root.style.display = 'none';
    this.setStepperVisible(false);
    this.layoutInfo();
  }

  private appearancePreview(item:GarageItem):string|null{
    const path=item.object3dsId!=null?this.parts[item.object3dsId]:undefined;
    return path&&appearanceFamily(path)?`/tank_parts/${appearancePartPath(path,appearanceFor(path,this.state.appearances))}/preview.png?v=1`:null;
  }

  private parts: Record<number, string> = {};

  /** категория, тип пушки/корпуса (по пути модели), модификация, порядок сервера */
  private sortKey(item: GarageItem): number[] {
    const rank = (list: readonly (string | number)[], value: string | number | undefined): number => {
      const index = value == null ? -1 : list.indexOf(value);
      return index < 0 ? list.length : index;
    };
    const path = item.object3dsId != null ? this.parts[item.object3dsId] : undefined;
    const kind = path?.match(/^(?:turrets|hulls)\/([^/]+)\//)?.[1];
    const typeOrder = item.category == ITEM_CATEGORY.WEAPON ? rank(TURRET_ORDER, kind) : item.category == ITEM_CATEGORY.ARMOR ? rank(HULL_ORDER, kind) : 0;
    return [rank(CATEGORY_ORDER, item.category), typeOrder, item.modification ?? 0, item.position];
  }

  /** пушка, стрельбы которой в html5 ещё нет (по пути модели: turrets/<имя>/mN) */
  private unfinished(item: GarageItem): boolean {
    if (item.category != ITEM_CATEGORY.WEAPON || item.object3dsId == null) return false;
    const path = this.parts[item.object3dsId];
    const kind = path?.match(/^turrets\/([^/]+)\//)?.[1];
    return kind != null && !IMPLEMENTED_TURRETS.has(kind);
  }

  /** ItemInfoPanel.showItemInfo */
  private showItem(tile: Tile): void {
    const item = tile.item;
    const modifications = this.state.modifications(item);
    const isModification = item.baseItemId != null && modifications.length > 1;
    this.itemName.textContent = item.name;
    this.description.textContent = item.description;
    this.leftPreview.src = this.appearancePreview(item)??`${RES}/${item.previewId}.png?v=${RES_VERSION}`;
    this.leftPreview.style.display = '';
    const upgradable = item.category == ITEM_CATEGORY.WEAPON || item.category == ITEM_CATEGORY.ARMOR;

    // панель свойств: значки по порядку свойства, у оружия и корпусов — таблица модификаций
    const properties = [...item.properties].filter((property) => PROPERTY_ICONS[property.propertyId]).sort((a, b) => PROPERTY_ICONS[a.propertyId][1] - PROPERTY_ICONS[b.propertyId][1]);
    this.propertiesPanel.textContent = '';
    this.modTable.textContent = '';
    this.propertiesPanel.style.display = properties.length ? '' : 'none';
    this.modTable.style.display = properties.length && upgradable ? '' : 'none';
    if (properties.length) this.buildProperties(properties.map((property) => property.propertyId), upgradable, upgradable ? modifications : [], item);

    // кнопки: магазин — «Купить»; склад — «Установить» и «Купить Mn+1» для модификаций
    const owned = tile.depot;
    const mounted = this.state.mounted.includes(item.objectId);
    let buyVisible = !owned || item.category == ITEM_CATEGORY.INVENTORY;
    let buyTarget: GarageItem = item;
    if (owned && upgradable && isModification && item.modification < 3) {
      const next = modifications.find((other) => other.modification == item.modification + 1);
      if (next) {
        buyVisible = true;
        buyTarget = next;
      }
    }
    this.buyButton.root.style.display = buyVisible ? '' : 'none';
    // ItemInfoPanel.updateStepperAndBuyButton: у расходников (CountableItem) — выбор количества
    const countable = buyVisible && item.category == ITEM_CATEGORY.INVENTORY;
    if (countable && this.buyTarget?.objectId != item.objectId) this.countStepper.value = 1;
    this.buyTarget = buyVisible ? buyTarget : null;
    this.setStepperVisible(countable);
    if (buyVisible) this.updateBuyButton();
    const equipVisible = owned && item.category != ITEM_CATEGORY.INVENTORY && item.category != ITEM_CATEGORY.PLUGIN && item.category != ITEM_CATEGORY.EMBLEM;
    this.equipButton.root.style.display = equipVisible ? '' : 'none';
    this.equipButton.caption = mounted ? 'Установлено' : 'Установить';
    this.equipButton.setEnabled(!mounted);
    this.upgradeButton.root.style.display = upgradable ? '' : 'none';
    const appearance=upgradable&&item.object3dsId!=null&&appearanceFamily(this.parts[item.object3dsId]??'');
    this.upgradeButton.setEnabled(!!appearance&&!!this.state.setAppearance);this.upgradeButton.root.title=appearance?'Выбрать текстуры и эффекты Gen 2 / Old':'У этой модели нет отдельного Old-варианта';
    this.layoutInfo();
  }

  private setStepperVisible(visible: boolean): void {
    this.stepperVisible = visible;
    this.countStepper.root.style.display = visible ? '' : 'none';
  }

  /** BuyButton.setInfo(цена, количество, звание): подпись с ценой за всё количество; степпер — до 9999 и по кристаллам */
  private updateBuyButton(): void {
    const target = this.buyTarget;
    const tile = this.selected;
    if (!target || !tile) return;
    const caption = tile.depot && target != tile.item ? `Купить M${target.modification}` : 'Купить';
    const rank = this.callbacks.userRank();
    const locked = !this.callbacks.isAdmin()&&(rank < target.minRank || rank > target.maxRank);
    let count = 1;
    if (this.stepperVisible) {
      const affordable = target.price > 0 ? Math.floor(this.callbacks.crystals() / target.price) : INVENTORY_MAX_VALUE;
      const max = Math.min(INVENTORY_MAX_VALUE, affordable);
      this.countStepper.setRange(1, Math.max(1, max));
      this.countStepper.setEnabled(!locked && max > 0);
      if (locked) this.countStepper.value = 1;
      count = this.countStepper.value;
    }
    if (this.unfinished(target) && !this.callbacks.isAdmin()) {
      this.buyButton.caption = 'В разработке';
      this.buyButton.setEnabled(false);
      return;
    }
    const total = target.price * count;
    this.buyButton.caption = `${caption}${count > 1 ? ` ×${count}` : ''}\n${formatMoney(total)} ◆${locked ? `  звание ${target.minRank}` : ''}`;
    this.buyButton.setEnabled(!locked && this.callbacks.crystals() >= total);
  }

  /** propertiesPanel (фон + значки) и ModTable (строки M0–M3: значения свойств, индикатор, звание, цена) */
  private buildProperties(columns: number[], withTable: boolean, modifications: GarageItem[], item: GarageItem): void {
    const icons = columns.map((column) => PROPERTY_ICONS[column][0]);
    const width = this.infoWidth - MARGIN * 2 - 2 - HORIZONTAL_MARGIN * 2;
    const left = withTable ? 'ItemInfoPanelBitmaps_bitmapUpgradeTableLeft.png' : 'ItemInfoPanelBitmaps_bitmapPropertiesLeft.png';
    const center = withTable ? 'ItemInfoPanelBitmaps_bitmapUpgradeTableCenter.png' : 'ItemInfoPanelBitmaps_bitmapPropertiesCenter.png';
    const leftImage = bitmap(this.propertiesPanel, left);
    const centerImage = bitmap(this.propertiesPanel, center);
    const rightImage = bitmap(this.propertiesPanel, left);
    rightImage.style.transform = 'scaleX(-1)';
    leftImage.onload = () => {
      const w = leftImage.naturalWidth;
      place(centerImage, w, 0, width - 2 * w, leftImage.naturalHeight);
      place(rightImage, width - w, 0);
      this.propertiesPanel.style.height = `${leftImage.naturalHeight}px`;
      this.layoutInfo();
    };
    this.propertiesPanel.style.width = `${width}px`;

    // ModInfoRow.updatePositions: справа налево ромб (9×11), цена, звание (RANK_WIDTH 13), индикатор модификации (17×13);
    // слева колонки свойств, ширина колонки = (индикатор.x − 2·hSpace) / число свойств
    const ROW_HEIGHT = 17;
    const H_SPACE = 10;
    const DIAMOND_WIDTH = 9;
    const INDICATOR_WIDTH = 17;
    const ICON_SIZE = 32;
    // ModTable.maxCostWidth: ширина самой длинной цены (TextField с автоподбором: текст + 4 px полей)
    const costWidth = Math.max(0, ...modifications.map((mod) => textWidth(formatMoney(mod.price)) + 4));
    const diamondX = width - DIAMOND_WIDTH - H_SPACE;
    const rankX = diamondX - 3 - costWidth - H_SPACE - 13;
    const indicatorX = rankX - INDICATOR_WIDTH - H_SPACE;
    const count = icons.length;
    const columnWidth = withTable ? (indicatorX - 2 * H_SPACE) / Math.max(1, count) : 0;
    icons.forEach((icon, index) => {
      // ItemPropertyIcon: подложка backIcon и значок со сдвигом (1, 1); над таблицей — по центру колонки (getPositions)
      const holder = el('div', 'lb-abs', this.propertiesPanel);
      bitmap(holder, 'ItemInfoPanelBitmaps_backIconClass.png');
      bitmap(holder, `ItemInfoPanelBitmaps_${icon}.png`, 1, 1);
      const x = withTable
        ? Math.round(H_SPACE + columnWidth * index + columnWidth / 2 - ICON_SIZE / 2)
        : Math.round((width - count * ICON_SIZE - 10 * (count - 1)) / 2) + index * (ICON_SIZE + 10);
      place(holder, x, 6);
    });
    if (!withTable) return;
    const rows = modifications.length > 1 ? modifications : [item];
    // ModTable.resizeSelection: x = 3, ширина width − 6: левый край, растянутая середина, отражённый левый край
    const selectionWidth = width - 6;
    const selection = el('div', 'lb-abs', this.modTable);
    const selectionLeft = bitmap(selection, 'ModTable_upgradeSelectionLeftClass.png');
    const selectionCenter = bitmap(selection, 'ModTable_upgradeSelectionCenterClass.png');
    const selectionRight = bitmap(selection, 'ModTable_upgradeSelectionLeftClass.png');
    selectionRight.style.transform = 'scaleX(-1)';
    selectionLeft.onload = () => {
      const edge = selectionLeft.naturalWidth;
      place(selectionCenter, edge, 0, selectionWidth - edge * 2, selectionLeft.naturalHeight);
      place(selectionRight, selectionWidth - edge, 0);
    };
    const values = garageTable(rows.map((mod) => mod.properties), columns, item.category === ITEM_CATEGORY.WEAPON || item.category === ITEM_CATEGORY.ARMOR);
    rows.forEach((mod, index) => {
      const row = el('div', 'lb-abs', this.modTable);
      place(row, 0, index * ROW_HEIGHT, width, ROW_HEIGHT);
      const selected = mod.objectId == item.objectId;
      if (selected) place(selection, 3, index * ROW_HEIGHT);
      values[index].forEach((value, column) => {
        if (!value) return;
        const text = label(row, value.text);
        text.style.color = value.color;
        text.style.textAlign = 'center';
        // ModInfoRow.select: выбранная строка жирнее
        if (selected) text.style.fontWeight = 'bold';
        place(text, Math.round(H_SPACE + columnWidth * column), 0, Math.round(columnWidth));
      });
      if (rows.length > 1) bitmap(row, `UpgradeIndicator_m${mod.modification}Class.png`, indicatorX, 3);
      sprite(row, 'RangIconSmall', Math.max(1, mod.minRank), rankX, 2);
      const cost = label(row, formatMoney(mod.price));
      cost.style.right = `${width - diamondX + 3}px`;
      cost.style.top = '0px';
      if (selected) cost.style.fontWeight = 'bold';
      sprite(row, 'Diamond', 1, diamondX, 3);
    });
    this.modTable.style.width = `${width}px`;
    this.modTable.style.height = `${rows.length * ROW_HEIGHT}px`;
  }

  private buy(): void {
    const tile = this.selected;
    if (!tile) return;
    const item = tile.item;
    if (this.buyTarget && this.unfinished(this.buyTarget) && !this.callbacks.isAdmin()) return;
    if (tile.depot && item.category != ITEM_CATEGORY.INVENTORY) {
      const next = this.state.modifications(item).find((other) => other.modification == item.modification + 1);
      if (!next) return;
      this.state.buyNextModification(next);
      this.callbacks.spend(next.price);
    } else {
      const count = this.stepperVisible ? this.countStepper.value : 1;
      if (this.callbacks.crystals() < item.price * count) return;
      this.state.buy(item, count);
      this.callbacks.spend(item.price * count);
    }
  }

  /** GarageModel.onResize + GarageWindow.resize */
  readonly layout = (): void => {
    const stageWidth = Math.max(MIN_WIDTH, window.innerWidth);
    const x0 = Math.round(stageWidth / 3);
    const width = Math.round((stageWidth * 2) / 3);
    const height = Math.max(window.innerHeight - HEADER_HEIGHT, MIN_HEIGHT);
    place(this.root, x0, HEADER_HEIGHT, width, height);

    const top=height-LIST_HEIGHT;
    this.partsList.setBounds(0,top,width);
    this.categories.setBounds(MARGIN,top+163,width-MARGIN*2-8);
    this.previewWindow.setBounds(0, 0, width - INFO_WIDTH, top);
    this.previewBevel.setBounds(MARGIN, MARGIN, width - INFO_WIDTH - MARGIN * 2, top - MARGIN * 2);
    this.preview.setBounds(MARGIN + 1, MARGIN + 1, width - INFO_WIDTH - MARGIN * 2 - 2, top - MARGIN * 2 - 2);

    this.infoWidth = INFO_WIDTH;
    this.infoHeight = top;
    this.infoWindow.setBounds(width - INFO_WIDTH, 0, INFO_WIDTH, top);
    this.layoutInfo();
  };

  /** ItemInfoPanel.resize и setButtonsPosition */
  private layoutInfo(): void {
    const width = this.infoWidth;
    const height = this.infoHeight;
    this.infoInner.setBounds(MARGIN, MARGIN, width - MARGIN * 2, height - MARGIN - BOTTOM_MARGIN);
    const areaWidth = width - MARGIN * 2 - 2;
    const contentWidth = areaWidth - HORIZONTAL_MARGIN * 2;
    place(this.infoArea, MARGIN + 1, MARGIN + 1 + 3, areaWidth + 6, height - MARGIN - BOTTOM_MARGIN - 2 - 6);
    const panelVisible = this.propertiesPanel.style.display != 'none';
    const panelTop = Math.round(VERTICAL_MARGIN * 2 + 22 - 7);
    place(this.propertiesPanel, HORIZONTAL_MARGIN, panelTop);
    const panelHeight = panelVisible ? parseInt(this.propertiesPanel.style.height || '0', 10) : 0;
    place(this.modTable, HORIZONTAL_MARGIN, panelTop + 32 + 2 + MOD_TABLE_SHIFT);
    let descriptionTop = panelVisible ? panelTop + panelHeight + VERTICAL_MARGIN - 4 : VERTICAL_MARGIN + 24 - 7;
    let descriptionLeft = HORIZONTAL_MARGIN - 3;
    let descriptionWidth = contentWidth;
    if (this.leftPreview.style.display != 'none') {
      const previewTop = panelVisible ? panelTop + panelHeight + VERTICAL_MARGIN : VERTICAL_MARGIN + 24;
      place(this.leftPreview, 0, previewTop);
      descriptionLeft = (this.leftPreview.naturalWidth || 164) - 3;
      descriptionWidth = contentWidth - descriptionLeft - 3;
      descriptionTop = Math.max(descriptionTop, previewTop - 4);
    }
    place(this.description, descriptionLeft, descriptionTop, descriptionWidth);

    const buttonTop = height - MARGIN - 50 + 1;
    // ItemInfoPanel.setButtonsPosition: степпер слева (x −7 от кнопок), «Купить» — правее на ширину степпера + 10
    if (this.stepperVisible) {
      place(this.countStepper.root, MARGIN - 7, buttonTop + Math.trunc((50 - 31) / 2));
      this.buyButton.setBounds(MARGIN - 7 + 95 + 10, buttonTop, BUTTON_WIDTH);
    } else {
      this.buyButton.setBounds(MARGIN, buttonTop, BUTTON_WIDTH);
    }
    this.equipButton.setBounds(width - MARGIN - BUTTON_WIDTH, buttonTop, BUTTON_WIDTH);
    this.upgradeButton.setBounds(MARGIN + BUTTON_WIDTH + 15, buttonTop, BUTTON_WIDTH);
  }
}

let measureContext: CanvasRenderingContext2D | null = null;

/** ширина подписи шрифтом лобби (MyriadPro 12) */
function textWidth(text: string): number {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * 6;
  measureContext.font = "12px 'MyriadPro', 'Myriad Pro', Arial, sans-serif";
  return Math.ceil(measureContext.measureText(text).width);
}

// Инвентарь боя (клавиши 1-5): alternativa/tanks/models/battle/gui/inventory/{InventoryModel,InventoryItemModel,InventoryItem}.as.
// Сервер создаёт по объекту на каждый припас (InventoryItemModel: item_index 1..5, count, cool_down_time_in_sec). Клавиша шлёт
// ACTIVATE объекту припаса (перед этим — коррекция позиции, как StateCorrectionEvent во Flash), сервер проверяет
// количество и перезарядку и отвечает ACTIVATE — только тогда запускается перезарядка и уменьшается счётчик.
import type { GameClient, RemoteObject } from '../../net/client.ts';

/** InventoryItemModel */
export const INVENTORY_ITEM_MODEL_ID = 300100051;
/** клиентская команда InventoryItemModel.activate */
const ACTIVATE_COMMAND_ID = 300100048;

/** InventoryModel.initKeyCodes: 1-5 и цифровая клавиатура */
const KEY_SLOTS: Record<string, number> = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4,
  Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4,
};

interface InventoryItemData {
  item_index: number;
  count: number;
  cool_down_time_in_sec: number;
}

/** InventoryItem: перезарядка идёт от момента ответа сервера */
interface Item {
  objectId: number;
  index: number;
  count: number;
  cooldownMs: number;
  cooldownStart: number;
}

/** то, что инвентарь рисует: слоты HUD (BattleHud) */
export interface InventoryPanel {
  setInventorySlot(slot: number, itemIndex: number | null, count?: number): void;
  setInventoryCount(slot: number, count: number | null): void;
  setInventoryCooldown(slot: number, status: number): void;
  setInventoryLocked(locked: boolean): void;
}

export class InventoryController {
  private readonly items: (Item | null)[] = [null, null, null, null, null];
  private readonly byObject = new Map<number, Item>();
  private locked = true;
  private readonly onKeyDown = (event: KeyboardEvent): void => this.keyDown(event);

  constructor(
    private readonly client: GameClient,
    private readonly spaceName: string,
    private readonly panel: InventoryPanel,
    /** StateCorrectionEvent перед активацией: сервер ставит мину и считает эффекты от последней известной позиции */
    private readonly beforeActivate: () => void,
  ) {
    panel.setInventoryLocked(true);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** InventoryItemModel.objectLoaded */
  addObject(object: RemoteObject): void {
    const data = object.models.get(INVENTORY_ITEM_MODEL_ID) as InventoryItemData | undefined;
    if (!data) return;
    const slot = data.item_index - 1;
    if (slot < 0 || slot >= this.items.length) return;
    const item: Item = { objectId: object.id, index: data.item_index, count: data.count, cooldownMs: data.cool_down_time_in_sec * 1000, cooldownStart: -1 };
    this.items[slot] = item;
    this.byObject.set(object.id, item);
    this.panel.setInventorySlot(slot, item.index, item.count);
  }

  /** InventoryItemModel.activated: сервер принял применение — перезарядка пошла, счётчик уменьшился */
  onActivated(objectId: number): void {
    const item = this.byObject.get(objectId);
    if (!item) return;
    item.cooldownStart = performance.now();
    item.count = Math.max(0, item.count - 1);
    this.panel.setInventoryCount(item.index - 1, item.count);
  }

  /** InventoryModel.onLocalTankActivationEvent: активный танк — слоты открыты, перезарядки сброшены; смерть и конец боя — закрыты */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.panel.setInventoryLocked(locked);
    if (!locked) {
      for (const item of this.items) if (item) item.cooldownStart = -1;
    }
  }

  /** InventoryModel.onEnterFrame: круговой индикатор перезарядки */
  update(now: number): void {
    this.items.forEach((item, slot) => {
      if (!item) return;
      let status = 1;
      if (item.cooldownStart >= 0) {
        status = (now - item.cooldownStart) / Math.max(1, item.cooldownMs);
        if (status >= 1) {
          status = 1;
          item.cooldownStart = -1;
        }
      }
      this.panel.setInventoryCooldown(slot, status);
    });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    for (let slot = 0; slot < this.items.length; slot++) {
      this.panel.setInventorySlot(slot, null);
      this.panel.setInventoryCooldown(slot, 1);
    }
    this.panel.setInventoryLocked(false);
    this.items.fill(null);
    this.byObject.clear();
  }

  /** InventoryModel.onKeyDown + InventoryItemModel.requestActivation: активируем, если слот открыт, припас есть и перезарядка прошла */
  private keyDown(event: KeyboardEvent): void {
    if (event.repeat || this.locked) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName == 'INPUT' || target.tagName == 'TEXTAREA' || target.isContentEditable)) return;
    const slot = KEY_SLOTS[event.code];
    if (slot == null) return;
    const item = this.items[slot];
    if (!item || item.count <= 0 || item.cooldownStart >= 0) return;
    this.beforeActivate();
    this.client.sendCommand(this.spaceName, item.objectId, ACTIVATE_COMMAND_ID);
  }
}

/**
 * Инвентарь боя server2 (клавиши 1–5): сервер присылает припасы с количеством из гаража (BattleInfo.inventory),
 * клавиша шлёт battle.activateItem, сервер проверяет активность танка, счётчик и перезарядку и отвечает событием
 * battle.inventory — только тогда идут перезарядка и уменьшение счётчика (как ACTIVATE старого протокола).
 * Раскладка слотов и HUD — InventoryModel/InventoryItemModel старого клиента.
 */
import type { Connection } from './Connection.ts';
import type { InventoryItemInfo } from './protocol.ts';

/** InventoryModel.initKeyCodes: 1-5 и цифровая клавиатура */
const KEY_SLOTS: Record<string, number> = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4,
  Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4,
};

/** то, что рисует HUD (BattleHud.setInventory*) */
export interface InventoryPanel {
  setInventorySlot(slot: number, itemIndex: number | null, count?: number): void;
  setInventoryCount(slot: number, count: number | null): void;
  setInventoryCooldown(slot: number, status: number): void;
  setInventoryEffect?(slot: number, status: number | null): void;
  setInventoryLocked(locked: boolean): void;
}

interface Item {
  info: InventoryItemInfo;
  /** performance.now начала перезарядки; −1 — готова */
  cooldownStart: number;
}

export class S2Inventory {
  private readonly items: (Item | null)[] = [null, null, null, null, null];
  private readonly effects = new Map<number, { start: number; duration: number }>();
  private locked = true;
  private guiLocked = false;
  private readonly offEvent: () => void;
  private readonly onKeyDown = (event: KeyboardEvent): void => this.keyDown(event);

  constructor(
    connection: Connection,
    inventory: InventoryItemInfo[],
    private readonly panel: InventoryPanel | null,
    private readonly send: (index: number) => void,
  ) {
    for (const info of inventory) {
      const slot = info.index - 1;
      if (slot < 0 || slot >= this.items.length) continue;
      this.items[slot] = { info: { ...info }, cooldownStart: -1 };
      panel?.setInventorySlot(slot, info.index, info.count);
      panel?.setInventoryCooldown(slot, 1);
    }
    panel?.setInventoryLocked(true);
    this.offEvent = connection.on('battle.inventory', ({ index, count, cooldownMs }) => this.activated(index, count, cooldownMs));
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** InventoryItemModel.activated: сервер принял применение — перезарядка пошла, счётчик уменьшился */
  private activated(index: number, count: number, cooldownMs: number): void {
    const item = this.items[index - 1];
    if (!item) return;
    item.info.count = count;
    item.info.cooldownMs = cooldownMs;
    item.cooldownStart = cooldownMs > 0 ? performance.now() : -1;
    this.panel?.setInventoryCount(index - 1, count);
    this.panel?.setInventoryCooldown(index - 1, item.cooldownStart < 0 ? 1 : 0);
  }

  /** InventoryModel.onLocalTankActivationEvent: активный танк — слоты открыты, перезарядки сброшены */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.panel?.setInventoryLocked(locked || this.guiLocked);
    if (locked) for (const index of this.effects.keys()) this.setEffect(index, null);
    if (!locked) this.items.forEach((item, slot) => {
      if (item && item.cooldownStart >= 0) {
        item.cooldownStart = -1;
        this.panel?.setInventoryCooldown(slot, 1);
      }
    });
  }

  setGuiLocked(locked: boolean): void {
    this.guiLocked = locked;
    this.panel?.setInventoryLocked(this.locked || locked);
  }

  setEffect(index: number, leftMs: number | null): void {
    if (leftMs === null || leftMs <= 0) {
      if (this.effects.delete(index)) this.panel?.setInventoryEffect?.(index - 1, null);
      return;
    }
    this.effects.set(index, { start: performance.now(), duration: leftMs });
    this.panel?.setInventoryEffect?.(index - 1, 0);
  }

  /** InventoryModel.onEnterFrame: круговой индикатор перезарядки */
  update(now: number): void {
    this.items.forEach((item, slot) => {
      if (!item || item.cooldownStart < 0) return;
      const status = Math.min(1, (now - item.cooldownStart) / Math.max(1, item.info.cooldownMs));
      if (status >= 1) item.cooldownStart = -1;
      this.panel?.setInventoryCooldown(slot, status);
    });
    for (const [index, effect] of this.effects) {
      const progress = Math.max(0, (now - effect.start) / effect.duration);
      if (progress >= 1) this.setEffect(index, null);
      else this.panel?.setInventoryEffect?.(index - 1, progress);
    }
  }

  stop(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.offEvent();
    for (const index of this.effects.keys()) this.setEffect(index, null);
    for (let slot = 0; slot < this.items.length; slot++) {
      this.panel?.setInventorySlot(slot, null);
      this.panel?.setInventoryCooldown(slot, 1);
    }
    this.panel?.setInventoryLocked(false);
    this.items.fill(null);
  }

  /** InventoryModel.onKeyDown: активный танк, припас есть, перезарядка прошла */
  private keyDown(event: KeyboardEvent): void {
    if (event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName == 'INPUT' || target.tagName == 'TEXTAREA' || target.isContentEditable)) return;
    const slot = KEY_SLOTS[event.code];
    if (slot == null) return;
    this.activateSlot(slot + 1);
  }

  activateSlot(index: number): void {
    if (this.locked || this.guiLocked || this.effects.has(index)) return;
    const item = this.items[index - 1];
    if (!item || item.info.count <= 0 || item.cooldownStart >= 0) return;
    this.send(item.info.index);
  }
}

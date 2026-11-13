/**
 * Ящики server2 (протокол v2): battle.bonusSpawned / battle.bonusTaken / battle.bonusesRemoved, запрос
 * battle.takeBonus. Рисование, падение, парашют и подбор касанием — общий BonusField (он же у BonusManager старого
 * протокола); здесь только перевод типов сервера в модели клиента.
 */
import type * as THREE from 'three';
import type { BonusRegionMarks } from '../map/bonusRegions.ts';
import type { Body } from '../physics/Body.ts';
import { BonusField } from '../tanks/bonuses/BonusField.ts';
import type { TanksCollisionDetector } from '../tanks/physics/TanksCollisionDetector.ts';
import type { SoundManager } from '../tanks/sfx/Sound.ts';
import type { BonusInfo, BonusKind } from './protocol.ts';

/** тип ящика -> модель клиента public/bonuses/<файл>.json */
const BOX_FILE: Record<BonusKind, string> = { armor: 'armor_box', crystal: 'crystal_box', gold: 'gold_box', med: 'med_box', nos: 'nos_box', power: 'power_box' };

export class S2Bonuses {
  private readonly field: BonusField;

  constructor(
    world: THREE.Object3D,
    detector: TanksCollisionDetector,
    tankBody: () => Body | null,
    fallSpeed: number,
    onTake: (bonusId: number) => void,
    soundManager: SoundManager,
    private readonly marks: BonusRegionMarks | null,
    archiveBoxes: boolean,
  ) {
    this.field = new BonusField(world, detector, tankBody, { soundManager, onTake, archiveBoxes });
    this.field.setFallSpeed(fallSpeed);
  }

  spawn(bonus: BonusInfo): void {
    this.marks?.spawn(bonus);
    this.field.spawn({ id: bonus.bonusId, kind: BOX_FILE[bonus.kind] ?? bonus.kind, position: bonus.position, ageMs: bonus.ageMs });
  }

  /** ящик взят: поднимается и исчезает */
  take(bonusId: number): void {
    this.marks?.remove(bonusId);
    this.field.take(bonusId);
  }

  /** ящики убраны сервером (срок жизни, конец раунда) */
  remove(bonusIds: number[]): void {
    for (const bonusId of bonusIds) {
      this.marks?.remove(bonusId);
      this.field.remove(bonusId);
    }
  }

  /** конец раунда на клиенте: оставшиеся ящики исчезают */
  removeAll(): void {
    this.marks?.keepOnly(new Set());
    this.field.removeAll();
  }

  /**
   * Сверка с сервером после входа в бой: ящики, о которых клиент не слышал за время загрузки карты, появляются,
   * исчезнувшие — сразу убираются.
   */
  reset(bonuses: BonusInfo[]): void {
    const ids = new Set(bonuses.map((bonus) => bonus.bonusId));
    this.marks?.keepOnly(ids);
    this.field.keepOnly(ids);
    for (const bonus of bonuses) this.spawn(bonus);
  }

  update(): void {
    this.field.update();
  }

  debug(): unknown[] {
    return this.field.debug();
  }

  stop(): void {
    this.field.stop();
  }
}

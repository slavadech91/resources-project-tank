// Припасы старого протокола (alternativa.tanks.models.battlefield.BattleFieldBonusModel): объекты поля и типов ящиков,
// команды SPAWN_BONUSES / REMOVE_BONUSES / BONUS_TAKEN и ATTEMPT_TO_TAKE_BONUS. Падение, парашют и подбор касанием —
// в BonusField (им же пользуется server2).
import type * as THREE from 'three';
import type { GameClient, RemoteObject } from '../../net/client.ts';
import type { Body } from '../../physics/Body.ts';
import type { TanksCollisionDetector } from '../physics/TanksCollisionDetector.ts';
import type { SoundManager } from '../sfx/Sound.ts';
import { BonusField } from './BonusField.ts';

export const BONUS_FIELD_MODEL_ID = 300100007;
const BONUS_COMMON_MODEL_ID = 300100015;
const ATTEMPT_TO_TAKE_BONUS = 300100005;

/** box_resource -> файл ящика (resource id из configs/path_to_id.json: /battle/3ds/bonuses/<name>) */
const BOX_BY_RESOURCE: Record<number, string> = { 1: 'armor_box', 2: 'crystal_box', 3: 'gold_box', 4: 'med_box', 5: 'nos_box', 8: 'power_box' };

interface BonusFieldData {
  bonus_fall_speed?: number;
  bonuses?: SpawnInfo[];
}

interface SpawnInfo {
  bonus_id: number | bigint;
  bonus_game_object_id: number | bigint;
  get_time?: number;
  spawn_position: { x: number; y: number; z: number };
}

function toNumber(value: number | bigint): number {
  return Number(value);
}

export class BonusManager {
  private readonly boxTypeByObject = new Map<number, string>();
  private readonly field: BonusField;
  private fieldId = 0;

  constructor(
    private readonly client: GameClient,
    private readonly spaceName: string,
    world: THREE.Object3D,
    detector: TanksCollisionDetector,
    tankBody: () => Body | null,
    soundManager: SoundManager,
  ) {
    this.field = new BonusField(world, detector, tankBody, {
      soundManager,
      onTake: (id) => {
        if (!this.fieldId) return;
        this.client.sendCommand(this.spaceName, this.fieldId, ATTEMPT_TO_TAKE_BONUS, (writer) => writer.i64(id));
      },
    });
    const space = client.getSpace(spaceName);
    for (const object of space?.objects.values() ?? []) this.addObject(object);
  }

  /** Новые объекты боя: типы ящиков (BonusCommonModel) и поле припасов с уже лежащими ящиками */
  addObject(object: RemoteObject): void {
    const common = object.models.get(BONUS_COMMON_MODEL_ID) as { box_resource?: number | bigint } | undefined;
    if (common?.box_resource != null) {
      const name = BOX_BY_RESOURCE[toNumber(common.box_resource)];
      if (name) this.boxTypeByObject.set(object.id, name);
    }
    const field = object.models.get(BONUS_FIELD_MODEL_ID) as BonusFieldData | undefined;
    if (field) {
      this.fieldId = object.id;
      this.field.setFallSpeed(field.bonus_fall_speed ?? 0);
      for (const info of field.bonuses ?? []) this.spawn(info);
    }
  }

  /** команды BattleFieldBonusModel */
  onCommand(name: string, args: unknown): void {
    if (name == 'SPAWN_BONUSES') {
      const list = (args as { bonuses?: SpawnInfo[] } | null)?.bonuses ?? [];
      for (const info of list) this.spawn(info);
    } else if (name == 'REMOVE_BONUSES') {
      const ids = (args as { bonus_ids?: (number | bigint)[] } | null)?.bonus_ids ?? [];
      for (const id of ids) this.field.remove(toNumber(id));
    } else if (name == 'BONUS_TAKEN') {
      this.field.take(toNumber((args as { bonus_id: number | bigint }).bonus_id));
    }
  }

  /** ящик старого сервера: тип — по объекту BonusCommonModel, возраст — get_time */
  private spawn(info: SpawnInfo): void {
    const kind = this.boxTypeByObject.get(toNumber(info.bonus_game_object_id));
    if (!kind) return;
    this.field.spawn({ id: toNumber(info.bonus_id), kind, position: info.spawn_position, ageMs: info.get_time ?? 0 });
  }

  /** новый раунд (BATTLE_RESTART): все оставшиеся ящики исчезают, как по REMOVE_BONUSES */
  removeAll(): void {
    this.field.removeAll();
  }

  /** Отладка: состояние ящиков и расстояния до танка (window.__tanks.netBattle.bonuses.debug()) */
  debug(): unknown[] {
    return this.field.debug();
  }

  stop(): void {
    this.field.stop();
  }

  update(): void {
    this.field.update();
  }
}

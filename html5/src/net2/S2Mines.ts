/**
 * Мины server2: battle.minePlaced / battle.mineActivated / battle.mineExploded / battle.minesRemoved, сверка
 * battle.mines после загрузки карты. Отрисовка и звук — общий MineField; здесь вид мины по отношению к игроку
 * (своя — friendly, союзная в TDM — blue, вражеская — red, невзведённая — empty).
 */
import type * as THREE from 'three';
import type { EffectsScene } from '../tanks/sfx/SmokyEffects.ts';
import type { SoundManager } from '../tanks/sfx/Sound.ts';
import { MineField, type MineTextureKind } from '../tanks/mines/MineField.ts';
import { TEAM, type BattleTeam, type MineInfo } from './protocol.ts';

export class S2Mines {
  private readonly field: MineField;
  private readonly mines = new Map<number, MineInfo>();

  constructor(
    world: THREE.Object3D,
    effectsScene: EffectsScene,
    soundManager: SoundManager,
    private readonly localId: number,
    /** команда игрока меняется в TDM между раундами; мины снимаются в конце раунда, так что вид пересчитывается редко */
    private readonly team: () => BattleTeam,
    mines: MineInfo[],
  ) {
    this.field = new MineField(world, effectsScene, soundManager);
    for (const mine of mines) this.spawn(mine);
  }

  private kind(info: MineInfo): MineTextureKind {
    if (!info.activated) return 'empty';
    if (info.ownerId === this.localId) return 'friendly';
    if (info.team !== TEAM.NONE && info.team === this.team()) return 'blue';
    return 'red';
  }

  spawn(info: MineInfo): void {
    const existing = this.mines.get(info.mineId);
    if (existing) Object.assign(existing, info);
    else this.mines.set(info.mineId, { ...info });
    this.field.spawn({ id: info.mineId, position: info.position, kind: this.kind(info) });
  }

  activated(mineId: number): void {
    const info = this.mines.get(mineId);
    if (!info) return;
    info.activated = true;
    this.field.setKind(mineId, this.kind(info));
    this.field.activated(info.position);
  }

  exploded(mineId: number): void {
    this.mines.delete(mineId);
    this.field.explode(mineId);
  }

  remove(mineIds: number[]): void {
    for (const mineId of mineIds) this.mines.delete(mineId);
    this.field.remove(mineIds);
  }

  removeAll(): void {
    this.mines.clear();
    this.field.removeAll();
  }

  /** сверка после загрузки карты: мины, о которых клиент не слышал, появляются; исчезнувшие — убираются */
  reset(mines: MineInfo[]): void {
    this.field.keepOnly(new Set(mines.map((mine) => mine.mineId)));
    const ids = new Set(mines.map((mine) => mine.mineId));
    for (const id of [...this.mines.keys()]) if (!ids.has(id)) this.mines.delete(id);
    for (const mine of mines) this.spawn(mine);
  }

  stop(): void {
    this.mines.clear();
    this.field.stop();
  }
}

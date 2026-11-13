import type * as THREE from 'three';
import type { AmbientShadows } from '../AmbientShadows.ts';

/** эффекты кадра боя (настройки «Отображение») */
export interface BattleEffectsSettings {
  fog: boolean;
  softParticles: boolean;
  ssao: boolean;
  shadows: boolean;
  dynamicLighting: boolean;
}

/** fog_params карты (BattleMapModelData): цвет, прозрачность, ближняя и дальняя границы */
export interface MapFogParams {
  alpha: number;
  color: number;
  nearLimit: number;
  farLimit: number;
}

/** uniform-переменные мягких частиц: глубина сцены, near/far/включено, размер экрана */
export interface SoftParticleUniforms {
  softDepth: { value: THREE.Texture | null };
  softParams: { value: THREE.Vector3 };
  softScreen: { value: THREE.Vector2 };
}

/**
 * Состояние кадра боя, общее для проходов. Создаётся BattleRenderer; проходы из src/render/passes
 * читают из него материалы, цели и настройки, но не меняют их (кроме временного фона сцены).
 */
export interface BattlePassState {
  /** настройки эффектов; объект живёт всё время и меняется по месту (setSettings) */
  readonly settings: BattleEffectsSettings;
  readonly soft: SoftParticleUniforms;
  readonly depthMaterial: THREE.MeshBasicMaterial;
  readonly ssaoMaterial: THREE.ShaderMaterial;
  readonly ssaoApply: THREE.ShaderMaterial;
  readonly quad: THREE.Mesh;
  readonly quadCamera: THREE.OrthographicCamera;
  readonly ambientShadows: AmbientShadows;
  /** ssao_color карты (0xRRGGBB) */
  ssaoColor: number;
  /** фон сцены, снятый на время проходов (восстанавливается в финальном проходе) */
  savedBackground: THREE.Scene['background'];
  /** overrideMaterial сцены, снятый на время прохода глубины */
  savedOverride: THREE.Material | null;
}

/** включены ли проходы, которым нужна глубина сцены */
export function needsDepth(settings: BattleEffectsSettings): boolean {
  return settings.softParticles || settings.ssao;
}

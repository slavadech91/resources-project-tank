// Настройки графики как в окне настроек оригинала (ISettingsService). Хранятся в localStorage.
export interface GraphicsSettings {
  showDamage: boolean;
  showFPS: boolean;
  adaptiveFPS: boolean;
  showSky: boolean;
  showChat: boolean;
  mipMapping: boolean;
  autoQuality: boolean;
  dynamicShadows: boolean;
  fog: boolean;
  softParticles: boolean;
  antialiasing: boolean;
  ssao: boolean;
  shadows: boolean;
  dynamicLighting: boolean;
  /** метки зон выпадения ящиков (SettingEnum.SHOW_DROP_ZONES в клиенте Narukami) */
  showDropZones: boolean;
  /** управление мышью (SettingEnum.MOUSE_CONTROL клиента 2019) */
  mouseControl: boolean;
  /** инверсия мыши по вертикали (MOUSE_Y_INVERSE) */
  mouseYInverse: boolean;
  /** чувствительность мыши 1…20 (MOUSE_SENSITIVITY) */
  mouseSensitivity: number;
  /** красно-тёмно-серая тема лобби и верхней панели (ui/theme.ts), выкл — зелёная оригинала */
  redTheme: boolean;
  /** современный интерфейс: окна и кнопки лобби в стиле чата, настроек и таблицы Tab (ui/glass.css), положение то же */
  glassUi: boolean;
  /** подбор света (angle_x, angle_y из dynamic_shadow_params и shadowMapCorrectionFactor) */
  sunAngleX: number;
  sunAngleZ: number;
  correctionFactor: number;
  /** звук турбины корпуса Varan: 0 — выкл, 1 — «Спорт», 2 — «Дизель», 3 — «Компакт» (tanks/sfx/TurboSound.ts) */
  turboVariant: number;
  /** режим «Непогода»: дождь, молнии, мокрые поверхности */
  weather: boolean;
  rainStrength: number;
  /** небо/туман/свет при включённой непогоде (вкладка «Непогода») */
  weatherSkyZenith: number;
  weatherSkyHorizon: number;
  weatherSkySun: number;
  weatherCloudCover: number;
  weatherFogColor: number;
  weatherFogAlpha: number;
  weatherAmbientColor: number;
  weatherSunColor: number;
  weatherSkyGround: number;
  weatherCloudOffset: number;
  weatherFogNear: number;
  weatherFogFar: number;
  weatherAmbientStrength: number;
  weatherSunStrength: number;
  weatherShadowDarkness: number;
  windStrength: number;
  lightningRate: number;
  wetness: number;
  /** процедурное небо (градиент, солнце, облака) вместо JPG-скайбокса */
  proceduralSky: boolean;
  /** палитра неба и параметры облаков (вкладка «Небо и свет») */
  skyZenith: number;
  skyHorizon: number;
  skyGround: number;
  skySun: number;
  cloudCover: number;
  /** прижатие облаков к горизонту: меньше — ниже (0.02…0.25) */
  cloudOffset: number;
  /** темнота теней: 0 — как есть, 1 — максимум (ambient вниз, солнце вверх с компенсацией) */
  shadowDarkness: number;
  /** яркость эффектов оружия относительно мира (1 — как в шейдере, >1 — светится от bloom) */
  fxStrength: number;
  /** туман: цвет, плотность и границы */
  fogColor: number;
  fogAlpha: number;
  fogNear: number;
  fogFar: number;
  /** цвета источников света */
  ambientColor: number;
  lightSunColor: number;
  /** PBR-материалы (MeshStandardMaterial + окружение); применяется после перезагрузки страницы */
  pbrMaterials: boolean;
  /** PBR-карты неровностей: нормали и шероховатость из diffuse-текстуры (после перезагрузки) */
  derivePbrMaps: boolean;
  /** пост-обработка: HDR-буфер, bloom и tone mapping (src/render/post) */
  postProcessing: boolean;
  exposure: number;
  bloomStrength: number;
  bloomThreshold: number;
  /** доля ACES-кривой: 0 — линейный кадр, 1 — полностью ACES */
  toneMix: number;
  saturation: number;
  contrast: number;
  vignette: number;
  /** сила ambient-света карты (1 — как в оригинале) */
  ambientStrength: number;
  /** сила направленного света (1 — как в оригинале) */
  sunStrength: number;
  /** интенсивность отражённого света окружения у PBR-материалов */
  envIntensity: number;
}

/** числовые ползунки окна настроек (не флаги) */
export type GraphicsNumberKey =
  | 'sunAngleX'
  | 'sunAngleZ'
  | 'correctionFactor'
  | 'mouseSensitivity'
  | 'exposure'
  | 'bloomStrength'
  | 'bloomThreshold'
  | 'toneMix'
  | 'saturation'
  | 'contrast'
  | 'vignette'
  | 'ambientStrength'
  | 'sunStrength'
  | 'envIntensity'
  | 'cloudCover'
  | 'cloudOffset'
  | 'fxStrength'
  | 'shadowDarkness'
  | 'rainStrength'
  | 'windStrength'
  | 'lightningRate'
  | 'wetness'
  | 'weatherCloudCover'
  | 'weatherFogAlpha'
  | 'weatherSkyZenith'
  | 'weatherSkyHorizon'
  | 'weatherSkySun'
  | 'weatherFogColor'
  | 'weatherAmbientColor'
  | 'weatherSunColor'
  | 'weatherSkyGround'
  | 'weatherCloudOffset'
  | 'weatherFogNear'
  | 'weatherFogFar'
  | 'weatherAmbientStrength'
  | 'weatherSunStrength'
  | 'weatherShadowDarkness'
  | 'fogAlpha'
  | 'fogNear'
  | 'fogFar'
  | 'skyZenith'
  | 'skyHorizon'
  | 'skyGround'
  | 'skySun'
  | 'fogColor'
  | 'ambientColor'
  | 'lightSunColor';

export type GraphicsFlag = Exclude<keyof GraphicsSettings, GraphicsNumberKey | 'turboVariant'>;

export const DEFAULT_GRAPHICS_SETTINGS: GraphicsSettings = {
  showDamage: true,
  showFPS: true,
  adaptiveFPS: false,
  showSky: true,
  showChat: true,
  mipMapping: true,
  autoQuality: false,
  dynamicShadows: true,
  fog: true,
  softParticles: false,
  antialiasing: false,
  ssao: true,
  shadows: false,
  dynamicLighting: false,
  showDropZones: true,
  mouseControl: true,
  mouseYInverse: false,
  mouseSensitivity: 8,
  redTheme: false,
  glassUi: false,
  sunAngleX: -2.86,
  sunAngleZ: -1.13,
  correctionFactor: 0.03,
  turboVariant: 1,
  weather: false,
  rainStrength: 0.6,
  weatherSkyZenith: 0x24303d,
  weatherSkyHorizon: 0x5a6a78,
  weatherSkySun: 0xd8e6ff,
  weatherCloudCover: 0.82,
  weatherFogColor: 0x8fa3b5,
  weatherFogAlpha: 0.45,
  weatherAmbientColor: 0x39485a,
  weatherSunColor: 0x9fb0c4,
  weatherSkyGround: 0x2b3036,
  weatherCloudOffset: 0.04,
  weatherFogNear: 1800,
  weatherFogFar: 9000,
  weatherAmbientStrength: 0.4,
  weatherSunStrength: 0.5,
  weatherShadowDarkness: 0.3,
  windStrength: 0.3,
  lightningRate: 0.4,
  wetness: 0.7,
  proceduralSky: true,
  skyZenith: 0x2f6ea8,
  skyHorizon: 0xbcd7ea,
  skyGround: 0x6b6f66,
  skySun: 0xfff0cf,
  cloudCover: 0.52,
  cloudOffset: 0.06,
  shadowDarkness: 0,
  fxStrength: 1.6,
  fogColor: 0xddf1ff,
  fogAlpha: 0.25,
  fogNear: 5000,
  fogFar: 10000,
  ambientColor: 0x54646f,
  lightSunColor: 0xc7bdab,
  pbrMaterials: true,
  derivePbrMaps: true,
  postProcessing: true,
  exposure: 0.87,
  bloomStrength: 0.33,
  bloomThreshold: 1.46,
  toneMix: 0.41,
  saturation: 0.90,
  contrast: 0.98,
  vignette: 0.54,
  ambientStrength: 0.41,
  sunStrength: 1.53,
  envIntensity: 0.37,
};

const STORAGE_KEY = 'tanki.graphics';

export function loadGraphicsSettings(): GraphicsSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<GraphicsSettings>;
    return { ...DEFAULT_GRAPHICS_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_GRAPHICS_SETTINGS };
  }
}

export function saveGraphicsSettings(settings: GraphicsSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    window.dispatchEvent(new Event('tanki-graphics-change'));
  } catch {
    // без хранилища настройки просто не запоминаются
  }
}

import { setEffectTexturePreparer } from './tanks/sfx/SmokyEffects.ts';
import { setRailgunPreparer } from './tanks/sfx/RailgunEffects.ts';
import {MobileBattleControls} from './ui/mobile/MobileBattleControls.ts';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parseClientMap, parseServerMap } from './map/loaders';
import { buildProps, buildServerMap, setDebugVisibility } from './map/build';
import { MaterialPool, buildRealProps, loadPropLibraries, parseProplibs } from './map/proplibs';
import { mergeStaticProps } from './map/batching.ts';
import { setTurboVariant } from './tanks/sfx/TurboSound.ts';
import { createNetPanel, type AuthMode } from './ui/net-panel.ts';
import { AuthWindow } from './ui/AuthWindow.ts';
import { Lobby } from './ui/lobby/Lobby.ts';
import { MODEL_ID, type GameClient, type RemoteObject, type UserInfo } from './net/client.ts';
import { addBattleLighting, installNoisyShadowFilter, applyShadowFlags, setDynamicShadows, setShadowDarkness, setSunAngles, setupRawColorPipeline, updateShadowFocus } from './map/lighting.ts';
import { loadGraphicsSettings, type GraphicsSettings } from './ui/settings/GraphicsSettings.ts';
import { setGlassUi, setRedTheme } from './ui/theme.ts';
import { BonusRegionMarks } from './map/bonusRegions.ts';
import { SettingsWindow } from './ui/settings/SettingsWindow.ts';
import { TankDemo } from './tanks/TankDemo.ts';
import { BattleHud } from './ui/hud/BattleHud.ts';
import { DailyMissions } from './ui/lobby/DailyMissions.ts';
import { BattleStats } from './ui/hud/BattleStats.ts';
import { BattleChat } from './ui/hud/BattleChat.ts';
import { PropInspector } from './ui/hud/PropInspector.ts';
import { SuicideIndicator } from './ui/hud/SuicideIndicator.ts';
import { BattleNotice } from './ui/hud/BattleNotice.ts';
import { BattleLoader } from './ui/hud/BattleLoader.ts';
import { BattleSkyBox } from './map/skybox.ts';
import { AmbientSound, AudioEngine, SoundManager } from './tanks/sfx/Sound.ts';
import type { BonusRegion, ServerMap } from './map/types.ts';
import { battleIdFromSpace, enterBattle, leaveBattle, listBattles } from './net/battle-entry.ts';
import { NetBattle } from './tanks/net/NetBattle.ts';
import { startSyncTestBench, type SyncTestBench } from './tanks/net/sync/SyncTestBench.ts';
import { toggleDesyncDebug } from './tanks/net/DesyncDebug.ts';
import { loadTankSkin, tankPartIds } from './tanks/render/tankParts.ts';
import { TrackMarks } from './tanks/render/TrackMarks.ts';
import { BattleRenderer } from './render/BattleRenderer.ts';
import { createSkyEnvironment, materialLibrary } from './render/materials/MaterialLibrary.ts';
import { ProceduralSky } from './render/sky/ProceduralSky.ts';
import { Weather } from './render/weather/Weather.ts';
import { RainShelter } from './render/weather/RainShelter.ts';
import { rainSurfaceUniforms } from './render/weather/WetSurfaces.ts';
import { effectStrength, watchEffectStrength } from './render/effects/EffectStrength.ts';
import { RenderCore } from './render/RenderCore.ts';
import { S2Client, errorText, s2UrlFromLocation } from './net2/S2Client.ts';
import { BEGINNER_BATTLE_ID, type BattleMode, type BattleTeam, type KickReason } from './net2/protocol.ts';
import { S2Battle } from './net2/S2Battle.ts';

const appElement = document.getElementById('app');
const hudElement = document.getElementById('hud');
if (!appElement || !hudElement) throw new Error('нет контейнеров #app / #hud');
const app: HTMLElement = appElement;
const hud: HTMLElement = hudElement;

// гравитация карты из dev/configs/maps.json (у всех карт 1000)
const MAP_GRAVITY = 1000;
// ?free — свободная камера без танка
const FREE_CAMERA = new URLSearchParams(window.location.search).has('free');
// ?offline или ?free — без сервера; по умолчанию открывается лобби с выбором боя
const OFFLINE_MODE = FREE_CAMERA || new URLSearchParams(window.location.search).has('offline');
// Overhaul uses server2. ?server=legacy opts into the old Flash bridge for local development.
const S2_MODE = !OFFLINE_MODE && new URLSearchParams(window.location.search).get('server') !== 'legacy';
// скайбокс и фоновый звук карты из dev/configs/maps.json (sky_box, environment_sound); файлы — tools/convert_battle_media.py
/** скайбокс карты, как sky_box в configs/maps.json (tools/add_to_skyboxes.py): по ProTanki и TO-Assets */
const SKYBOX_BY_MAP: Record<string, string> = { arena: 'mountains', silence: 'silence', silence_old: 'silence_old', silence_2_old: 'silence_old', serpuhov: 'hills' };
const SKYBOX_VERSION = '3';
function skyboxUrl(mapName: string): string {
  return `battle/images/skyboxes/${SKYBOX_BY_MAP[mapName] ?? 'mountains'}/image.jpg?v=${SKYBOX_VERSION}`;
}
const AMBIENT_SOUND_URL = 'battle/sounds/environment/default.mp3';

// Ядро рендера: рендерер, сцена, камера, размер буфера и граф проходов кадра (src/render/**).
// Цветовой пайплайн и шейдерные правки включаются до создания сцены — как и раньше.
const core = new RenderCore({
  parent: app,
  configure: (createdRenderer) => {
    setEffectTexturePreparer(texture => createdRenderer.initTexture(texture));
    installNoisyShadowFilter();
    createdRenderer.shadowMap.type = THREE.PCFShadowMap;
    // цвета без sRGB-преобразований, как во Flash; до создания любых THREE.Color
    setupRawColorPipeline(createdRenderer);
  },
});
const renderer = core.renderer;
const scene = core.scene;
const camera = core.camera;
setRailgunPreparer((effects, textures) => {
  for (const texture of textures) renderer.initTexture(texture);
  renderer.compile(effects, camera, scene);
});
camera.position.set(0, -7500, 6000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.maxDistance = 80000;
controls.minDistance = 200;

// ?cam=px,py,pz,tx,ty,tz — позиция камеры и точка взгляда (координаты Three.js, Y вверх)
const camParam = new URLSearchParams(window.location.search).get('cam');
if (camParam) {
  const [px, py, pz, tx, ty, tz] = camParam.split(',').map(Number);
  camera.position.set(px, py, pz);
  controls.target.set(tx ?? 0, ty ?? 0, tz ?? 0);
}
controls.update();

const profileCpu = new URLSearchParams(window.location.search).get('profile') === 'cpu';
const cpuFrames: number[][] = [];
let cpuFrameCursor = 0;

function cpuProfile() {
  if (!profileCpu) return 'Открой клиент с параметром &profile=cpu';
  const phases = ['frameInterval', 'localAndHud', 'networkAndScene', 'renderSubmit', 'total', 'physicsAndInput', 'camera', 'rafStartOffset', 'socketCallbacks'];
  const ordered = [...cpuFrames.slice(cpuFrameCursor), ...cpuFrames.slice(0, cpuFrameCursor)];
  const intervals = cpuFrames.map(frame => frame[0]).sort((a, b) => a - b);
  const typicalIntervalMs = intervals[Math.floor(intervals.length * 0.25)] ?? 0;
  const threshold = typicalIntervalMs * 1.5;
  const spikes = ordered.flatMap((frame, index) => {
    const before = ordered[index - 1];
    if (!before || frame[0] < threshold) return [];
    return [{
      intervalMs: frame[0], precedingCpuMs: before[4], localAndHudMs: before[1],
      physicsAndInputMs: before[5], cameraMs: before[6], networkAndSceneMs: before[2],
      renderSubmitMs: before[3], rafStartOffsetMs: frame[7], precedingRafStartOffsetMs: before[7],
      socketCallbackMsBetweenFrames: frame[8], socketMessagesBetweenFrames: frame[9],
      precedingDrawCalls: before[10], precedingTriangles: before[11],
    }];
  }).sort((a, b) => b.intervalMs - a.intervalMs).slice(0, 12);
  return {
    map: currentMapName,
    frames: cpuFrames.length,
    typicalIntervalMs,
    longIntervals: intervals.filter(interval => interval >= threshold).length,
    spikes,
    ms: Object.fromEntries(phases.map((phase, index) => {
      const values = cpuFrames.map(frame => frame[index]).sort((a, b) => a - b);
      return [phase, {
        p50: values[Math.floor((values.length - 1) * 0.5)] ?? 0,
        p95: values[Math.floor((values.length - 1) * 0.95)] ?? 0,
        max: values.at(-1) ?? 0,
      }];
    })),
  };
}

// для отладки из консоли браузера
(window as unknown as { __tanki: unknown }).__tanki = {
  THREE,
  scene,
  camera,
  controls,
  renderer,
  renderCore: core,
  frameGraph: core.graph,
  get tank() {
    return tankDemo;
  },
  get netBattle() {
    return netBattle;
  },
  get battleRenderer() {
    return battleRenderer;
  },
  cpuProfile,
  /** стенд синхронизации v2 без сервера (?offline&synctest=задержка,джиттер) */
  syncTest() {
    return syncTestBench?.stats() ?? 'стенд не запущен: ?offline&synctest=80,30';
  },
  /** журнал попаданий текущего боя (ShotTracker): __tanki.shots() — записи, __tanki.shotSummary — итоги */
  shots() {
    return netBattle?.shotRecords ?? [];
  },
  get shotSummary() {
    return netBattle?.shotSummary ?? 'не в бою';
  },
};

// Мир в оригинальных осях (X, Y, Z-вверх). Поворотом группы переводим в Y-вверх Three.js.
const world = new THREE.Group();
watchEffectStrength(world);
const trackMarks = new TrackMarks(world);
world.rotation.x = -Math.PI / 2;
// карта не двигается: без этого группа каждый кадр заново пересчитывала мировые матрицы всех своих детей
world.updateMatrix();
world.matrixAutoUpdate = false;
scene.add(world);
// туман, мягкие частицы, SSAO, тень под танком, динамический свет (настройки «Отображение», клиент 2019)
const battleRenderer = new BattleRenderer(core, world);
// ?legacy — сравнение с прежней картинкой: без HDR-буфера, bloom и tone mapping
if (new URLSearchParams(window.location.search).has('legacy')) battleRenderer.setPostProcessing(false);

// свет как в боевой библиотеке Flash (Lighting.as)
const battleLights = addBattleLighting(world);
const graphicsSettings = loadGraphicsSettings();
// PBR-материалы включаются настройкой «PBR-материалы» (?nopbr — принудительно выкл);
// без них картинка остаётся прежней (Lambert), поэтому по умолчанию выключены
const NO_PBR = new URLSearchParams(window.location.search).has('nopbr');
materialLibrary.pbr = graphicsSettings.pbrMaterials && !NO_PBR;
materialLibrary.deriveMaps = graphicsSettings.derivePbrMaps;
if (materialLibrary.pbr) scene.environment = createSkyEnvironment(renderer, 0xa9c2d8, 0xc7bdab, 0x54646f);
// процедурное небо: градиент, солнце с гало и облака вместо JPG-скайбокса карты
const proceduralSky = new ProceduralSky();
scene.add(proceduralSky.mesh);
// режим «Непогода»: дождь, молнии, мокрые поверхности
const weather = new Weather(scene);
const rainShelter = new RainShelter(renderer);
// новый объёмный эффект выстрела рельсы (ядро + импульсы + импакт + цветной свет)

// тема интерфейса — до постройки панели и лобби
setRedTheme(graphicsSettings.redTheme);
setGlassUi(graphicsSettings.glassUi);

const audioEngine = new AudioEngine();
audioEngine.playbackEnabled = false;
const soundManager = new SoundManager(audioEngine);
// верхняя панель, инвентарь, фонд/таймер/счёт и FPS как в оригинале (режим DM; пока без сервера боя)
const BATTLE_TIME_LIMIT_SEC = 600;
// настройки графики (окно «Отображение» оригинала); «Динамические тени» меняют и сам свет, см. map/lighting.ts
/** отражения окружения у PBR-материалов: ползунок «Отражения окружения» */
function applyEnvIntensity(value: number): void {
  materialLibrary.envMapIntensity = value;
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      if (standard && standard.isMeshStandardMaterial) standard.envMapIntensity = value;
    }
  });
}

function applyGraphicsSettings(settings: GraphicsSettings): void {
  battleLights.correctionFactor = settings.correctionFactor;
  setSunAngles(battleLights, settings.sunAngleX, settings.sunAngleZ);
  setDynamicShadows(battleLights, settings.dynamicShadows);
  renderer.shadowMap.enabled = settings.dynamicShadows;
  battleLights.sun.castShadow = settings.dynamicShadows;
  applyShadowFlags(world, settings.dynamicShadows);
  hudPanel.setFpsVisible(settings.showFPS);
  if (skyBox) skyBox.mesh.visible = settings.showSky && !settings.proceduralSky;
  proceduralSky.setVisible(settings.proceduralSky && settings.showSky);
  proceduralSky.setSunDirection(battleLights.direction.clone().applyQuaternion(world.quaternion).negate());
  bonusRegionMarks?.setVisible(settings.showDropZones);
  battleRenderer.setSettings(settings);
  // пост-обработка и свет — ползунки окна «Отображение» (нулевые значения дают прежнюю картинку)
  battleRenderer.setPostProcessing(settings.postProcessing);
  battleRenderer.bloom.threshold = settings.bloomThreshold;
  battleRenderer.bloom.knee = Math.max(0.01, settings.bloomThreshold * 0.4);
  Object.assign(battleRenderer.tonemap.settings, {
    exposure: settings.exposure,
    bloomStrength: settings.bloomStrength,
    toneMix: settings.toneMix,
    saturation: settings.saturation,
    contrast: settings.contrast,
    vignette: settings.vignette,
  });
  // небо, туман и цвета света — вкладка «Небо и свет»
  // при включённой непогоде небо, туман и свет берутся из штормового пресета (вкладка «Непогода»)
  if (settings.weather) {
    rainShelter.prepare();
    proceduralSky.setPalette({ zenith: settings.weatherSkyZenith, horizon: settings.weatherSkyHorizon, ground: settings.weatherSkyGround, sun: settings.weatherSkySun });
    proceduralSky.setCloudCover(settings.weatherCloudCover);
    proceduralSky.setCloudOffset(settings.weatherCloudOffset);
    battleRenderer.setFogOverride({ color: settings.weatherFogColor, alpha: settings.weatherFogAlpha, nearLimit: settings.weatherFogNear, farLimit: settings.weatherFogFar });
    battleLights.ambient.color.setHex(settings.weatherAmbientColor);
    battleLights.sun.color.setHex(settings.weatherSunColor);
    setShadowDarkness(battleLights, settings.weatherAmbientStrength, settings.weatherSunStrength, settings.weatherShadowDarkness);
  } else {
    proceduralSky.setPalette({ zenith: settings.skyZenith, horizon: settings.skyHorizon, ground: settings.skyGround, sun: settings.skySun });
    proceduralSky.setCloudCover(settings.cloudCover);
    proceduralSky.setCloudOffset(settings.cloudOffset);
    battleRenderer.setFogOverride({ color: settings.fogColor, alpha: settings.fogAlpha, nearLimit: settings.fogNear, farLimit: settings.fogFar });
    battleLights.ambient.color.setHex(settings.ambientColor);
    battleLights.sun.color.setHex(settings.lightSunColor);
    setShadowDarkness(battleLights, settings.ambientStrength, settings.sunStrength, settings.shadowDarkness);
  }
  // погода: дождь, молнии, мокрость
  rainSurfaceUniforms.wetSkyColor.value.setHex(settings.weatherSkyHorizon);
  weather.setSettings({ enabled: settings.weather, rain: settings.rainStrength, wind: settings.windStrength, lightning: settings.lightningRate, wetness: settings.wetness });
  // яркость эффектов оружия — отдельно от мира (спрайты/аддитивные меши домножаются в шейдере)
  effectStrength.value = settings.fxStrength;
  applyEnvIntensity(settings.envIntensity * weather.wetness());
  setRedTheme(settings.redTheme);
  setGlassUi(settings.glassUi);
  setTurboVariant(settings.turboVariant);
}
const settingsWindow = new SettingsWindow(document.body, graphicsSettings, (_key, settings) => {
  applyGraphicsSettings(settings);
  tankDemo?.applyMouseSettings(settings);
}, (visible) => s2Battle?.setInventoryGuiLocked(visible));
const dailyMissions = new DailyMissions(document.body);
const hudPanel = new BattleHud(document.body, {
  onSoundToggle: (muted) => (audioEngine.muted = muted),
  onInventoryPress: (index) => s2Battle?.activateInventorySlot(index),
  onButton: (name) => {
    if (name == 'config') settingsWindow.toggle();
    else if (name === 'missions' && s2Client) void dailyMissions.open(s2Client.connection);
    else if (name == 'battles' || name == 'garage') void openLobbySection(name);
  },
}, S2_MODE);
// таблица игроков: Tab в бою и итоги раунда
const battleStats = new BattleStats(document.body);
// чат боя по Enter и команды администраторов
const battleChat = new BattleChat(document.body);
const suicideIndicator = new SuicideIndicator(document.body);
// сообщения боя (золотой ящик: скоро упадёт / взят)
const battleNotice = new BattleNotice(document.body);
// BattleReadinessService: от «В бой» до готовой карты и первого PREPARE_TO_SPAWN — экран загрузки, виджеты боя скрыты
const battleLoader = new BattleLoader(document.body);

function setBattleLoading(loading: boolean): void {
  if (loading) {
    battleLoader.show();
    hudPanel.setBattleWidgetsVisible(false);
  } else if (battleLoader.visible) {
    battleLoader.hide();
    if (tankDemo) hudPanel.setBattleWidgetsVisible(true);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
}
// Лобби (разделы «Битвы» / «Гараж»); в бою скрыто
const lobby = new Lobby(document.body, {
  onFight: (client, info, team) => {
    if (client) netPanel.joinBattle(info.battleId, team);
    else void joinS2Battle(info.battleId, team);
  },
  onSection: (section) => {
    // окно поверх боя отпускает мышь (MouseLockLockType клиента 2019)
    if (section != null) tankDemo?.releaseMouse();
    // в бою (и пока он грузится) «Битвы» подсвечены, как в оригинале, но нажимаются — выход в список боёв
    const inBattle = section == null && (battleLoader.visible || tankDemo != null);
    hudPanel.setActiveButton(inBattle ? 'battles' : section, inBattle);
    hudPanel.setBattleWidgetsVisible(section == null && !battleLoader.visible);
  },
  onUser: (user) => showPlayer(user),
});

function showPlayer(user: UserInfo): void {
  hudPanel.setPlayer({ name: user.uid, rank: user.rank, score: user.score, nextRankScore: user.nextRankScore, crystals: user.crystals, place: 1, kd: 0 });
}

async function openLobbySection(section: 'battles' | 'garage'): Promise<void> {
  // из боя: сначала выход (сервер откроет список боёв), затем нужный раздел
  // из боя — сразу в раздел одной командой (пространство раздела откроет лобби само)
  if (s2Battle) {
    await leaveS2Battle();
    lobby.open(section);
    return;
  }
  if (netPanel.inBattle) {
    await netPanel.leaveBattle(section);
    return;
  }
  lobby.open(section);
}
// в сетевом бою остаток времени приходит от сервера (NetBattle.onTimeLeft)
if (OFFLINE_MODE) hudPanel.setTimeLimit(BATTLE_TIME_LIMIT_SEC);
let skyBox: BattleSkyBox | null = null;
let bonusRegionMarks: BonusRegionMarks | null = null;
applyGraphicsSettings(graphicsSettings);
const cameraWorldPosition = new THREE.Vector3();
const shadowFocus = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
let shadowFlagFrame = 0;
let previousFrameTimeForWeather = performance.now();
/** раз в полсекунды помечаем материалы новых эффектов (они создаются и удаляются в бою) */

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.text();
}

let hudText = 'загрузка…';
const LOBBY_TEXT = 'Лобби: войдите и выберите бой в списке справа';
let tankDemo: TankDemo | null = null;
let netBattle: NetBattle | null = null;
/** бой server2 */
let s2Battle: S2Battle | null = null;
/** подписка на чат боя server2 (снимается при выходе) */
let s2ChatOff: (() => void) | null = null;
let syncTestBench: SyncTestBench | null = null;
let serverMapData: ServerMap | null = null;
const mobileControls=new MobileBattleControls(document.body,{
  tank:()=>tankDemo,
  active:()=>!!tankDemo&&lobby.root.hidden&&!battleLoader.visible,
  leave:()=>void openLobbySection('battles'),
  garage:()=>void openLobbySection('garage'),
  settings:()=>settingsWindow.toggle(),
}, S2_MODE);

// Отладочные слои выключены: ?debug=collisions,spawns или клавиши C/V
const debugFlags = new URLSearchParams(window.location.search).get('debug') ?? '';
const debugState = {
  collisions: debugFlags.includes('collisions'),
  spawns: debugFlags.includes('spawns'),
};

let currentMapName = '';
let mapObjects: THREE.Object3D[] = [];
let battleLoadVersion = 0;
let ambientSound: AmbientSound | null = null;

/** Карта боя в html5 по map_resource_id модели BATTLE_MAP (dev/configs/path_to_id.json); карты лежат в public/maps */
const MAP_BY_RESOURCE_ID: Record<number, string> = { 73: 'arena', 184: 'silence', 324: 'serpuhov' };

function mapNameForBattle(client: GameClient, spaceName: string, battleName: string): string {
  const space = client.getSpace(spaceName);
  const map = space ? client.findObjectWithModel(space, MODEL_ID.BATTLE_MAP) : undefined;
  const resourceId = (map?.models.get(MODEL_ID.BATTLE_MAP) as { map_resource_id?: number } | undefined)?.map_resource_id;
  if (resourceId != null && MAP_BY_RESOURCE_ID[resourceId]) return MAP_BY_RESOURCE_ID[resourceId];
  if (battleName.includes('Серпухов')) return 'serpuhov';
  return battleName.includes('Тишина') ? 'silence' : 'arena';
}

/** BattleMapModelData: туман (fog_params) и цвет SSAO карты */
function applyMapGraphics(client: GameClient, spaceName: string): void {
  const space = client.getSpace(spaceName);
  const map = space ? client.findObjectWithModel(space, MODEL_ID.BATTLE_MAP) : undefined;
  const data = map?.models.get(MODEL_ID.BATTLE_MAP) as
    | { fog_params?: { alpha: number; color: number; far_limit: number; near_limit: number }; ssao_color?: number }
    | undefined;
  const fog = data?.fog_params;
  battleRenderer.setMapParams(
    fog ? { alpha: fog.alpha, color: fog.color, nearLimit: fog.near_limit, farLimit: fog.far_limit } : null,
    data?.ssao_color ?? null,
  );
}

/** Строит карту в мире; всё добавленное запоминается, чтобы выгрузить при выходе из боя */
async function loadMap(mapName: string, mode?: BattleMode, bonusRegions?: BonusRegion[]): Promise<ServerMap> {
  const loadVersion = ++battleLoadVersion;
  const [serverXml, clientXml, proplibsXml] = await Promise.all([
    fetchText(`maps/${mapName}/map_server.xml${mapName === '2042' ? '?v=zones2019' : ''}`),
    fetchText(`maps/${mapName}/map_client.xml`),
    fetchText(`maps/${mapName}/proplibs.xml`),
  ]);

  const serverMap = parseServerMap(serverXml);
  if (bonusRegions) serverMap.bonusRegions = bonusRegions;
  const clientMap = parseClientMap(clientXml);
  const libraryRefs = parseProplibs(proplibsXml);

  const libraries = await loadPropLibraries(libraryRefs, '');
  if (loadVersion !== battleLoadVersion) throw new Error('загрузка карты отменена');
  const textureLoader = new THREE.TextureLoader();
  const pool = new MaterialPool(textureLoader, '');

  const before = new Set<THREE.Object3D>(world.children);
  const stats = buildServerMap(serverMap, world, debugState);
  const placed = buildRealProps(clientMap.props, libraries, pool, world);
  const fallbackBoxes = buildProps(placed.skipped, world);
  // статичная карта: матрицы считаем один раз (спрайты — нет, их размер выставляется после загрузки картинки)
  for (const object of world.children) {
    if (before.has(object)) continue;
    object.traverse((child) => {
      if ((child as THREE.Sprite).isSprite) return;
      child.updateMatrix();
      child.matrixAutoUpdate = false;
    });
  }
  const propMeshes = world.children.filter((object): object is THREE.Mesh => object instanceof THREE.Mesh && object.userData.propName != null && !before.has(object));
  const batches = mergeStaticProps(world, propMeshes);
  for (const batch of batches) {
    batch.updateWorldMatrix(true, false);
    batch.matrixWorldAutoUpdate = false;
  }
  // земля для меток зон ящиков — непрозрачные пропы карты (как KDContainer для следов)
  const groundMeshes = world.children.filter((object): object is THREE.Mesh => {
    if (!(object instanceof THREE.Mesh) || object.userData.propName == null || before.has(object)) return false;
    const material = object.material as THREE.Material;
    return !material.transparent && material.alphaTest == 0;
  });
  bonusRegionMarks = new BonusRegionMarks(serverMap.bonusRegions, textureLoader, groundMeshes, mode, mapName);
  rainShelter.setMap(groundMeshes);
  if (graphicsSettings.weather) rainShelter.prepare();
  bonusRegionMarks.setVisible(graphicsSettings.showDropZones);
  world.add(bonusRegionMarks.group);
  mapObjects = world.children.filter((object) => !before.has(object));
  currentMapName = mapName;

  const libraryReport = libraryRefs
    .map((ref) => `${ref.name}: ${libraries.has(ref.name) ? 'ок' : 'нет данных'}`)
    .join(', ');

  serverMapData = serverMap;
  BattleSkyBox.load(skyboxUrl(mapName))
    .then((loaded) => {
      if (loadVersion !== battleLoadVersion) return;
      skyBox = loaded;
      world.add(loaded.mesh);
      mapObjects.push(loaded.mesh);
      loaded.mesh.visible = graphicsSettings.showSky && !graphicsSettings.proceduralSky;
    })
    .catch((error: unknown) => console.warn('скайбокс не загружен', error));
  // BattlefieldModel: фон играет, пока включён звук
  audioEngine.playbackEnabled = true;
  void audioEngine.load(AMBIENT_SOUND_URL).then((sound) => {
    if (loadVersion !== battleLoadVersion) return;
    ambientSound = new AmbientSound(sound, soundManager);
    ambientSound.play(true);
  });

  hudText = [
    `Карта: ${mapName}  |  библиотек пропов: ${libraries.size}/${libraryRefs.length}`,
    `пропы: ${placed.placed} с моделями, ${fallbackBoxes} без модели, склеены в ${batches.length} мешей`,
    `коллизии (отладка): ${stats.boxes} боксов, ${stats.planes} плоскостей, ${stats.triangles} треугольников, спавнов ${stats.spawns}`,
    libraryReport,
  ].join('\n');
  return serverMap;
}

/** Выход из боя: карта и танк выгружаются, камера возвращается в лобби */
function unloadBattle(): void {
  cpuFrames.length = 0;
  cpuFrameCursor = 0;
  if (profileCpu && s2Client) {
    s2Client.connection.measureMessages = false;
    s2Client.connection.drainMessageTiming();
  }
  ++battleLoadVersion;
  audioEngine.playbackEnabled = false;
  ambientSound?.play(false);
  ambientSound = null;
  battleLoader.hide();
  battleChat.setEnabled(false);
  s2ChatOff?.();
  s2ChatOff = null;
  battleChat.setSender(null);
  battleNotice.hide();
  hudPanel.setTeamScore('dm',[0,0]);
  battleStats.setExternalTeamScore(false);
  netBattle?.stop();
  netBattle = null;
  s2Battle?.stop();
  s2Battle = null;
  hudPanel.setTimeLimit(0);
  tankDemo?.dispose();
  tankDemo = null;
  soundManager.stopAll();
  for (const object of mapObjects) {
    world.remove(object);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
    });
  }
  mapObjects = [];
  rainShelter.setMap([]);
  trackMarks.clear();
  bonusRegionMarks?.dispose();
  bonusRegionMarks = null;
  skyBox = null;
  serverMapData = null;
  currentMapName = '';
  camera.position.set(0, -7500, 6000);
  controls.target.set(0, 0, 0);
  controls.enabled = true;
  controls.update();
}

/** Режим без сервера: ?offline — карта «Арена» со своим танком, ?free — свободная камера */
async function startOffline(): Promise<void> {
  const serverMap = await loadMap(new URLSearchParams(window.location.search).get('map') ?? 'arena');
  if (!FREE_CAMERA) {
    tankDemo = await TankDemo.create(serverMap, MAP_GRAVITY, world, soundManager);
    tankDemo.enableMouseControl(renderer.domElement, () => graphicsSettings);
    controls.enabled = false;
    const syncTest = new URLSearchParams(window.location.search).get('synctest');
    if (syncTest != null) {
      const [latency, jitter] = syncTest.split(',').map((value) => Number(value) || 0);
      syncTestBench = await startSyncTestBench(tankDemo, world, latency ?? 80, jitter ?? 30);
    }
  }
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyP' && event.ctrlKey && event.altKey && profileCpu) {
    event.preventDefault();
    if (event.repeat || !cpuFrames.length) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(cpuProfile(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'overhaul-frame-profile.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else if (event.key === 'F8') {
    event.preventDefault();
    debugState.collisions = !debugState.collisions;
    setDebugVisibility(world, 'collisions', debugState.collisions);
  } else if (event.key === 'F9') {
    event.preventDefault();
    debugState.spawns = !debugState.spawns;
    setDebugVisibility(world, 'spawns', debugState.spawns);
  } else if (event.key === 'F7') {
    // отладка рассинхрона: пропущенные команды сервера и призраки чужих танков по серверу
    event.preventDefault();
    toggleDesyncDebug();
  } else if (event.key === 'Delete') {
    // сетевой бой: самоуничтожение через сервер (череп, смерть через 10 с); без сервера — мгновенный респаун для отладки
    if (netBattle) netBattle.requestSuicide();
    else if (s2Battle) s2Battle.requestSuicide();
    else if (tankDemo && serverMapData) tankDemo.respawn(serverMapData);
  }
});

// Фоновый шаг боя: в скрытой/перекрытой вкладке requestAnimationFrame не вызывается (а таймеры главного потока
// урезаются до раза в секунду и реже), поэтому шаг задаёт таймер воркера — его браузер не душит. Срабатывает, только
// если обычных кадров нет дольше BACKGROUND_TICK_AFTER_MS; физика, коррекции позиции (MOVE) и сеть идут как в кадре.
const BACKGROUND_TICK_MS = 33;
const BACKGROUND_TICK_AFTER_MS = 200;
let lastFrameTime = performance.now();
function startBackgroundTicker(): void {
  try {
    const source = `let timer;
onmessage = ({data: hidden}) => {
  clearInterval(timer);
  if (hidden) timer = setInterval(() => postMessage(0), ${BACKGROUND_TICK_MS});
};`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    const updateVisibility = (): void => worker.postMessage(document.hidden);
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();
    worker.onmessage = () => {
      if (!document.hidden || performance.now() - lastFrameTime < BACKGROUND_TICK_AFTER_MS) return;
      tankDemo?.simulate();
      netBattle?.update();
      s2Battle?.update();
    };
  } catch (error) {
    console.warn('фоновый шаг боя недоступен', error);
  }
}
startBackgroundTicker();

function animate(frameTime = performance.now()): void {
  requestAnimationFrame(animate);
  const frameInterval = frameTime - lastFrameTime;
  lastFrameTime = frameTime;
  const measure = profileCpu && tankDemo?.cameraReady === true && !battleLoader.visible && !document.hidden;
  const frameStart = measure ? performance.now() : 0;
  const socket = measure ? s2Client?.connection : undefined;
  if (socket) socket.measureMessages = true;
  const socketTiming = socket?.drainMessageTiming();
  trackMarks.update(lastFrameTime);
  hudPanel.frame(lastFrameTime);
  mobileControls.update(performance.now());
  if (tankDemo) tankDemo.update(camera, window.innerWidth, window.innerHeight, frameTime, measure);
  else controls.update();
  const localDone = measure ? performance.now() : 0;
  // купол неба всегда вокруг камеры, облака плывут по времени кадра
  weather.update(Math.max(0, (lastFrameTime - previousFrameTimeForWeather) / 1000), camera);
  previousFrameTimeForWeather = lastFrameTime;
  if (proceduralSky.mesh.visible || skyBox?.mesh.visible || graphicsSettings.dynamicShadows) {
    camera.getWorldPosition(cameraWorldPosition);
  }
  if (proceduralSky.mesh.visible) {
    proceduralSky.follow(cameraWorldPosition.x, cameraWorldPosition.y, cameraWorldPosition.z);
    proceduralSky.update(lastFrameTime * 0.001);
  }
  netBattle?.update();
  s2Battle?.update();
  if (skyBox?.mesh.visible) {
    // Three.js (x, y, z) -> координаты карты (x, -z, y)
    skyBox.follow(cameraWorldPosition.x, -cameraWorldPosition.z, cameraWorldPosition.y);
  }
  if (graphicsSettings.dynamicShadows) {
    // область теней — вокруг точки перед камерой (в осях карты); новые меши (снаряды, танки) получают флаги раз в полсекунды
    shadowFocus.copy(cameraWorldPosition);
    camera.getWorldDirection(cameraForward);
    shadowFocus.addScaledVector(cameraForward, 3000);
    updateShadowFocus(battleLights, world.worldToLocal(shadowFocus));
    if (++shadowFlagFrame % 30 == 0) applyShadowFlags(world, true);
  }
  // лобби закрывает весь экран — сцену не рисуем
  // в сетевом бою кадр рисуем только после первой настройки камеры (PREPARE_TO_SPAWN)
  // BattleReadinessService.tryToUnlock: бой показывается вместе с первой настройкой камеры
  if (battleLoader.visible && tankDemo?.cameraReady) setBattleLoading(false);
  const renderStart = measure ? performance.now() : 0;
  if (lobby.root.hidden) {
    if (battleLoader.visible || (tankDemo && !tankDemo.cameraReady)) renderer.clear();
    else battleRenderer.render(camera, graphicsSettings.dynamicShadows);
  }
  if (measure && tankDemo && frameInterval > 0 && frameInterval < 200) {
    const end = performance.now();
    const { physicsAndInput, camera: cameraCpu } = tankDemo.cpuTiming;
    const sample = cpuFrames[cpuFrameCursor] ?? (cpuFrames[cpuFrameCursor] = []);
    sample[0] = frameInterval;
    sample[1] = localDone - frameStart;
    sample[2] = renderStart - localDone;
    sample[3] = end - renderStart;
    sample[4] = end - frameStart;
    sample[5] = physicsAndInput;
    sample[6] = cameraCpu;
    sample[7] = frameStart - frameTime;
    sample[8] = socketTiming?.cpuMs ?? 0;
    sample[9] = socketTiming?.count ?? 0;
    sample[10] = renderer.info.render.calls;
    sample[11] = renderer.info.render.triangles;
    cpuFrameCursor = (cpuFrameCursor + 1) % 480;
  }
}

// шрифт MyriadPro догрузился позже раскладки — ширины текстов изменились: разложить интерфейс заново
document.fonts.addEventListener('loadingdone', () => window.dispatchEvent(new Event('resize')));

window.addEventListener('resize', () => {
  core.resize(window.innerWidth, window.innerHeight);
});

if (OFFLINE_MODE) {
  lobby.hide();
  startOffline().catch((error: unknown) => {
    hudText = 'ошибка загрузки карты:\n' + String(error);
    hud.textContent = hudText;
    console.error(error);
  });
}
// до входа — только фон лобби и окно авторизации: без верхней панели и виджетов боя
if (!OFFLINE_MODE) {
  hudPanel.setBattleWidgetsVisible(false);
  hudPanel.setVisible(false);
}
hud.textContent = OFFLINE_MODE ? 'загрузка…' : LOBBY_TEXT;
// отладочная строка карты/боя — без сервера и у администратора
hud.hidden = !OFFLINE_MODE;

// Панель входа: живой сервер juhe1 через WebSocket-мост (html5/server/bridge.mjs)
// инспектор пропов: F6 у администратора (и без сервера)
new PropInspector(document.body, {
  camera,
  world,
  targets: () => mapObjects,
  tankPosition: () => tankDemo?.tank.getBody().state.position ?? null,
  allowed: () => OFFLINE_MODE || (netPanel.client?.isAdmin ?? false) || (s2Client?.isAdmin ?? false),
});

const netPanel = createNetPanel(
  document.body,
  (user) => showPlayer(user),
  async (client, battleId, team) => {
    if (netBattle) throw new Error('уже в бою');
    // список боёв закроется при входе (сервер убирает battle_select), поэтому название берём заранее
    const knownBattles = listBattles(client);
    setBattleLoading(true);
    let spaceName: string;
    try {
      spaceName = await enterBattle(client, battleId, (message) => console.log('[бой]', message), team ?? null);
    } catch (error) {
      setBattleLoading(false);
      throw error;
    }
    try {
      // карту выбираем по бою, в который действительно попали (сервер мог вернуть в покинутый)
      const item = knownBattles.find((battle) => battle.battleId == battleIdFromSpace(spaceName));
      await client.waitForModelObject(spaceName, MODEL_ID.BATTLE_MAP, 180000);
      const serverMap = await loadMap(mapNameForBattle(client, spaceName, item?.name ?? ''));
      applyMapGraphics(client, spaceName);
      // корпус, пушка и краска каждого танка — по его tank_parts (объекты корпуса/пушки/краски пространства боя)
      const loadSkin = (tank: RemoteObject) => loadTankSkin(tankPartIds(client.getSpace(spaceName), tank));
      await client.waitForModelObject(spaceName, MODEL_ID.TANK, 180000);
      const localTank = [...(client.getSpace(spaceName)?.objects.values() ?? [])].find((object) => (object.models.get(MODEL_ID.TANK) as { local?: boolean } | undefined)?.local);
      const localSkin = localTank ? await loadSkin(localTank) : null;
      tankDemo = await TankDemo.create(serverMap, MAP_GRAVITY, world, soundManager, false, localSkin);
      tankDemo.enableMouseControl(renderer.domElement, () => graphicsSettings);
      controls.enabled = false;
      netBattle = new NetBattle(
        client,
        spaceName,
        tankDemo,
        world,
        loadSkin,
        (message) => console.log('[бой]', message),
        (seconds) => hudPanel.setTimeLimit(seconds),
        hudPanel,
        battleStats,
        () => hudPanel.stopTime(),
        suicideIndicator,
      );
      battleChat.setEnabled(true);
      hud.textContent = `Бой #${battleIdFromSpace(spaceName)} «${item?.name ?? ''}», карта ${currentMapName}`;
    } catch (error) {
      unloadBattle();
      await leaveBattle(client).catch(() => undefined);
      throw error;
    }
  },
  async (client, target) => {
    unloadBattle();
    hud.textContent = LOBBY_TEXT;
    await leaveBattle(client, target);
  },
  (client) => {
    // бой закрыл сервер (администратор удалил его) — выгружаем карту и танк, как при выходе
    client.on('space-closed', (space) => {
      if (!netBattle || !space.name.startsWith('battle_field')) return;
      unloadBattle();
      hud.textContent = LOBBY_TEXT;
      netPanel.battleClosed();
    });
    battleChat.attach(client);
    lobby.attach(client);
    client.on('admin', (admin) => (hud.hidden = !admin));
    // вход принят: окно авторизации закрывается, главное меню грузится под экраном загрузки
    client.on('login-ok', () => {
      authWindow.hide();
      hudPanel.setVisible(true);
      lobby.beginLoad();
    });
  },
);

/** server2: текущая сессия (null — не вошли или соединение закрыто) */
let s2Client: S2Client | null = null;
const KICK_TEXT: Record<KickReason, string> = {
  relogin: 'Выполнен вход с другого устройства',
  banned: 'Аккаунт заблокирован',
  shutdown: 'Сервер перезапускается — войдите снова через минуту',
  admin: 'Вас отключил администратор',
};

async function authenticateS2(mode: AuthMode, username: string, password: string): Promise<void> {
  s2Client?.close();
  s2Client = null;
  let s2: S2Client;
  try {
    s2 = await S2Client.connect();
  } catch {
    throw new Error(`Сервер недоступен (${s2UrlFromLocation()})`);
  }
  try {
    await s2.authenticate(mode, username, password);
    s2Client = s2;
    s2.onClose = (reason) => {
      if (s2Client !== s2) return;
      s2Client = null;
      if (s2Battle || s2Joining) unloadBattle();
      lobby.hide();
      hudPanel.setVisible(false);
      hud.hidden = true;
      authWindow.show();
      authWindow.showMessage(reason ? KICK_TEXT[reason] : 'Соединение с сервером потеряно');
    };
    lobby.attachS2(s2);
    hud.hidden = !s2.isAdmin;
    hudPanel.setVisible(true);
    lobby.beginLoad();
    await s2.loadLobby();
    lobby.open('battles');
    if (mode === 'register' && s2.hasBattle(BEGINNER_BATTLE_ID)) void joinS2Battle(BEGINNER_BATTLE_ID, null);
  } catch (error) {
    if (s2Client === s2) s2Client = null;
    s2.close();
    throw new Error(errorText(error));
  }
}

let s2Joining = false;

/**
 * Вход в бой server2: battle.join → карта и свой танк (детали из снаряжения) → S2Battle (он сразу шлёт battle.ready,
 * экран загрузки уходит с первой настройкой камеры по battle.prepare). Ошибка — выход из боя и список боёв.
 */
async function joinS2Battle(battleId: number, team: number | null): Promise<void> {
  const s2 = s2Client;
  const userId = s2?.user?.id;
  if (!s2 || userId == null || s2Battle || s2Joining || tankDemo || netBattle) return;
  s2Joining = true;
  setBattleLoading(true);
  lobby.hide();
  const log = (message: string): void => console.log('[бой s2]', message);
  try {
    const { info } = await s2.connection.request('battle.join', team == null ? { battleId } : { battleId, team: team as BattleTeam });
    if (s2Client !== s2) throw new Error('соединение с сервером потеряно');
    const joinedAt = performance.now();
    const serverMap = await loadMap(info.mapKey, info.battle.mode, info.bonusRegions);
    const loadVersion = battleLoadVersion;
    const local = info.players.find((player) => player.userId == userId);
    const localSkin = local ? await loadTankSkin(local.parts) : null;
    if (s2Client !== s2 || loadVersion !== battleLoadVersion) throw new Error('загрузка боя отменена');
    const demo = await TankDemo.create(serverMap, MAP_GRAVITY, world, soundManager, false, localSkin, true);
    if (s2Client !== s2 || loadVersion !== battleLoadVersion) {
      demo.dispose();
      throw new Error('загрузка боя отменена');
    }
    tankDemo = demo;
    tankDemo.enableMouseControl(renderer.domElement, () => graphicsSettings);
    controls.enabled = false;
    if (info.timeLeftSec > 0) hudPanel.setTimeLimit(Math.max(0, info.timeLeftSec - (performance.now() - joinedAt) / 1000));
    hudPanel.setFund(info.fund);
    s2Battle = new S2Battle(
      s2.connection,
      info,
      userId,
      tankDemo,
      world,
      (parts) => loadTankSkin(parts),
      log,
      battleStats,
      suicideIndicator,
      () => {
        // бой удалён администратором
        unloadBattle();
        hud.textContent = LOBBY_TEXT;
        lobby.open('battles');
      },
      {
        setTime: (seconds) => hudPanel.setTimeLimit(seconds),
        stopTime: () => hudPanel.stopTime(),
        setFund: (fund) => hudPanel.setFund(fund),
        notice: (text, ms, color) => battleNotice.show(text, ms, color),
        setTeamScore:(mode,scores,flags)=>hudPanel.setTeamScore(mode,scores,flags),
        setInventorySlot: (slot, itemIndex, count) => hudPanel.setInventorySlot(slot, itemIndex, count),
        setInventoryCount: (slot, count) => hudPanel.setInventoryCount(slot, count),
        setInventoryCooldown: (slot, status) => hudPanel.setInventoryCooldown(slot, status),
        setInventoryEffect: (slot, status) => hudPanel.setInventoryEffect(slot, status),
        setInventoryLocked: (locked) => hudPanel.setInventoryLocked(locked),
      },
      bonusRegionMarks,
    );
    s2Battle.setInventoryGuiLocked(settingsWindow.visible);
    // чат боя server2: сообщения событием battle.chat, текст — запросом battle.chat
    s2ChatOff = s2.connection.on('battle.chat', (message) => battleChat.receive({ author: message.author, rank: message.rank, kind: message.kind, text: message.text }));
    battleChat.setAdmin(s2.user?.admin ?? false);
    battleChat.setSender((text) =>
      s2.connection.request('battle.chat', { text }).catch((error: unknown) => console.warn('[бой s2] чат', error)),
    );
    battleChat.setEnabled(true);
    hud.textContent = `server2: бой #${info.battle.id} «${info.battle.name}», карта ${currentMapName}`;
  } catch (error) {
    unloadBattle();
    hud.textContent = LOBBY_TEXT;
    if (s2Client === s2) {
      await s2.connection.request('battle.leave', {}).catch(() => undefined);
      lobby.open('battles');
      window.alert(`Не удалось войти в бой: ${errorText(error)}`);
    }
  } finally {
    s2Joining = false;
  }
}

async function leaveS2Battle(): Promise<void> {
  const s2 = s2Client;
  unloadBattle();
  hud.textContent = LOBBY_TEXT;
  await s2?.connection.request('battle.leave', {}).catch(() => undefined);
}

const authWindow = new AuthWindow(document.body, (mode, username, password, remember) =>
  S2_MODE ? authenticateS2(mode, username, password) : netPanel.authenticate(mode, username, password, remember),
);
if (!OFFLINE_MODE) void lobby.whenReady().then(() => authWindow.show());

animate();

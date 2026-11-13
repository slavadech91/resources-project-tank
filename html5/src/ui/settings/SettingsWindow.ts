// Окно настроек графики: раздел «Отображение» оригинала (чекбоксы в том же порядке и с теми же подписями).
import './settings.css';
import { TURBO_PRESETS } from '../../tanks/sfx/TurboSound.ts';
import { DEFAULT_GRAPHICS_SETTINGS, saveGraphicsSettings, type GraphicsFlag, type GraphicsNumberKey, type GraphicsSettings } from './GraphicsSettings.ts';

const ROWS: Array<Array<[GraphicsFlag, string] | null>> = [
  [['showFPS', 'Показывать FPS'], ['adaptiveFPS', 'Адаптивный FPS'], ['showSky', 'Показывать небо'], ['showChat', 'Показывать боевой чат']],
  [['mipMapping', 'Мип-маппинг'], ['showDropZones', 'Показывать зоны ящиков'], ['redTheme', 'Красная тема интерфейса'], ['glassUi', 'Современный интерфейс']],
  [['showDamage', 'Показывать урон']],
  [['autoQuality', 'Автоматическая настройка качества графики']],
  [['dynamicShadows', 'Динамические тени'], ['fog', 'Туман'], ['softParticles', 'Мягкие частицы'], ['antialiasing', 'Сглаживание']],
  [['ssao', 'Глубокие тени'], ['shadows', 'Тень под танком'], null, ['dynamicLighting', 'Динамическое освещение']],
];

/** раздел «Управление» клиента 2019 (ControlSettingsTab) */
const CONTROL_ROWS: Array<Array<[GraphicsFlag, string]>> = [[['mouseControl', 'Управление мышью'], ['mouseYInverse', 'Инверсия мыши по вертикали']]];

export class SettingsWindow {
  private readonly root = document.createElement('div');

  constructor(
    parent: HTMLElement,
    settings: GraphicsSettings,
    onChange: (key: keyof GraphicsSettings, settings: GraphicsSettings) => void,
    private readonly onVisibilityChange?: (visible: boolean) => void,
  ) {
    this.root.className = 'settings-window';
    this.root.hidden = true;
    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Отображение';
    this.root.appendChild(title);
    this.enableDrag(title);
    for (const row of ROWS) {
      const line = document.createElement('div');
      line.className = 'settings-row';
      for (const cell of row) {
        if (!cell) {
          line.appendChild(document.createElement('span'));
          continue;
        }
        const [key, text] = cell;
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = settings[key];
        box.addEventListener('change', () => {
          settings[key] = box.checked;
          saveGraphicsSettings(settings);
          onChange(key, settings);
        });
        label.append(box, document.createElement('i'), text);
        line.appendChild(label);
      }
      this.root.appendChild(line);
    }
    this.root.appendChild(this.createSlider(settings, onChange, 'sunAngleX', 'Угол солнца X (angle_x)', -Math.PI, Math.PI, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'sunAngleZ', 'Угол солнца Z (angle_y)', -Math.PI, Math.PI, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'correctionFactor', 'Яркость солнца без теней', 0, 1, 0.01));
    const render = document.createElement('div');
    render.className = 'settings-title';
    render.textContent = 'Рендер: пост-обработка и свет';
    this.root.appendChild(render);
    this.root.appendChild(this.createCheckBox(settings, onChange, 'proceduralSky', 'Процедурное небо (солнце и облака)'));
    this.root.appendChild(this.createCheckBox(settings, onChange, 'postProcessing', 'Пост-обработка (HDR, bloom, tone mapping)'));
    this.root.appendChild(this.createCheckBox(settings, onChange, 'pbrMaterials', 'PBR-материалы (после перезагрузки)'));
    this.root.appendChild(this.createCheckBox(settings, onChange, 'derivePbrMaps', 'PBR-карты неровностей (после перезагрузки)'));
    this.root.appendChild(this.createSlider(settings, onChange, 'exposure', 'Экспозиция', 0.2, 2, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'bloomStrength', 'Сила bloom', 0, 2, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'bloomThreshold', 'Порог bloom', 0.2, 4, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'toneMix', 'Доля ACES (tone mapping)', 0, 1, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'saturation', 'Насыщенность', 0.4, 1.8, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'contrast', 'Контраст', 0.6, 1.6, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'vignette', 'Виньетка', 0, 1, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'ambientStrength', 'Сила ambient (тени)', 0, 2, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'sunStrength', 'Сила солнца', 0, 3, 0.01));
    this.root.appendChild(this.createSlider(settings, onChange, 'envIntensity', 'Отражения окружения (PBR)', 0, 1, 0.01));
    const section = document.createElement('div');
    section.className = 'settings-title';
    section.textContent = 'Управление';
    this.root.appendChild(section);
    for (const row of CONTROL_ROWS) {
      const line = document.createElement('div');
      line.className = 'settings-row';
      for (const [key, text] of row) line.appendChild(this.createCheckBox(settings, onChange, key, text));
      this.root.appendChild(line);
    }
    this.root.appendChild(this.createSlider(settings, onChange, 'mouseSensitivity', 'Чувствительность мыши', 1, 20, 1));
    const sound = document.createElement('div');
    sound.className = 'settings-title';
    sound.textContent = 'Звук';
    this.root.appendChild(sound);
    this.root.appendChild(this.createTurboSelect(settings, onChange));
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:6px;margin:8px 0;';
    const displayPanel = document.createElement('div');
    const skyPanel = this.createSkyPanel(settings, onChange);
    const weatherPanel = this.createWeatherPanel(settings, onChange);
    const displayTab = document.createElement('button');
    displayTab.textContent = 'Отображение';
    const skyTab = document.createElement('button');
    skyTab.textContent = 'Небо';
    const weatherTab = document.createElement('button');
    weatherTab.textContent = 'Непогода';
    const selectTab = (index: number): void => {
      displayPanel.hidden = index !== 0;
      skyPanel.hidden = index !== 1;
      weatherPanel.hidden = index !== 2;
      displayTab.style.fontWeight = index === 0 ? '700' : '400';
      skyTab.style.fontWeight = index === 1 ? '700' : '400';
      weatherTab.style.fontWeight = index === 2 ? '700' : '400';
    };
    displayTab.addEventListener('click', () => selectTab(0));
    skyTab.addEventListener('click', () => selectTab(1));
    weatherTab.addEventListener('click', () => selectTab(2));
    tabs.append(displayTab, skyTab, weatherTab);
    // всё собранное выше (кроме заголовка) уходит во вкладку «Отображение»
    for (const child of [...this.root.children]) if (child !== title) displayPanel.appendChild(child);
    this.root.append(tabs, displayPanel, skyPanel, weatherPanel);
    selectTab(0);
    const close = document.createElement('button');
    close.textContent = 'Закрыть';
    close.addEventListener('click', () => this.toggle());
    this.root.appendChild(close);
    parent.appendChild(this.root);
  }

  private createCheckBox(
    settings: GraphicsSettings,
    onChange: (key: keyof GraphicsSettings, settings: GraphicsSettings) => void,
    key: GraphicsFlag,
    text: string,
  ): HTMLElement {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = settings[key];
    box.addEventListener('change', () => {
      settings[key] = box.checked;
      saveGraphicsSettings(settings);
      onChange(key, settings);
    });
    label.append(box, document.createElement('i'), text);
    return label;
  }

  /** выбор звука турбины Varan, переключается сразу */
  private createTurboSelect(settings: GraphicsSettings, onChange: (key: keyof GraphicsSettings, settings: GraphicsSettings) => void): HTMLElement {
    const line = document.createElement('div');
    line.className = 'settings-slider';
    const select = document.createElement('select');
    ['Выкл', ...TURBO_PRESETS.map((preset) => preset.name)].forEach((name, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = name;
      select.appendChild(option);
    });
    select.value = String(settings.turboVariant);
    select.addEventListener('change', () => {
      settings.turboVariant = Number(select.value);
      saveGraphicsSettings(settings);
      onChange('turboVariant', settings);
    });
    line.append('Звук турбины Varan', select);
    return line;
  }

  /** цветовой ползунок: input[type=color], значение — число 0xRRGGBB */
  private createColor(
    settings: GraphicsSettings,
    onChange: (key: keyof GraphicsSettings, settings: GraphicsSettings) => void,
    key: GraphicsNumberKey,
    text: string,
  ): HTMLElement {
    const line = document.createElement('div');
    line.className = 'settings-slider';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = '#' + settings[key].toString(16).padStart(6, '0');
    input.addEventListener('input', () => {
      settings[key] = parseInt(input.value.slice(1), 16);
      saveGraphicsSettings(settings);
      onChange(key, settings);
    });
    const reset = document.createElement('button');
    reset.textContent = 'Сброс';
    reset.addEventListener('click', () => {
      settings[key] = DEFAULT_GRAPHICS_SETTINGS[key];
      input.value = '#' + settings[key].toString(16).padStart(6, '0');
      saveGraphicsSettings(settings);
      onChange(key, settings);
    });
    line.append(text, input, reset);
    return line;
  }

  /** содержимое вкладки «Небо и свет»: палитра неба, облака, туман, цвета света */
  private createSkyPanel(
    settings: GraphicsSettings,
    onChange: (key: keyof GraphicsSettings, settings: GraphicsSettings) => void,
  ): HTMLDivElement {
    const panel = document.createElement('div');
    const add = (element: HTMLElement): void => {
      panel.appendChild(element);
    };
    const title = (text: string): void => {
      const line = document.createElement('div');
      line.className = 'settings-title';
      line.textContent = text;
      add(line);
    };

    title('Небо');
    add(this.createColor(settings, onChange, 'skyZenith', 'Цвет зенита'));
    add(this.createColor(settings, onChange, 'skyHorizon', 'Цвет горизонта'));
    add(this.createColor(settings, onChange, 'skyGround', 'Цвет ниже горизонта'));
    add(this.createColor(settings, onChange, 'skySun', 'Цвет солнца'));
    add(this.createSlider(settings, onChange, 'cloudCover', 'Плотность облаков', 0.2, 0.85, 0.01));
    add(this.createSlider(settings, onChange, 'cloudOffset', 'Прижатие облаков к горизонту', 0.02, 0.25, 0.005));
    add(this.createSlider(settings, onChange, 'fxStrength', 'Яркость эффектов оружия', 0.2, 4, 0.05));

    title('Туман');
    add(this.createColor(settings, onChange, 'fogColor', 'Цвет тумана'));
    add(this.createSlider(settings, onChange, 'fogAlpha', 'Плотность тумана', 0, 1, 0.01));
    add(this.createSlider(settings, onChange, 'fogNear', 'Начало тумана', 0, 20000, 100));
    add(this.createSlider(settings, onChange, 'fogFar', 'Конец тумана', 1000, 40000, 100));

    title('Свет');
    add(this.createColor(settings, onChange, 'ambientColor', 'Цвет затенённых мест'));
    add(this.createColor(settings, onChange, 'lightSunColor', 'Цвет солнца на объектах'));
    add(this.createSlider(settings, onChange, 'shadowDarkness', 'Темнота теней', 0, 1, 0.01));
    return panel;
  }

  /** содержимое вкладки «Непогода»: погода + свои небо/туман/свет, которые замещают «Небо» при включении */
  private createWeatherPanel(
    settings: GraphicsSettings,
    onChange: (key: keyof GraphicsSettings, settings: GraphicsSettings) => void,
  ): HTMLDivElement {
    const panel = document.createElement('div');
    const add = (element: HTMLElement): void => {
      panel.appendChild(element);
    };
    const title = (text: string): void => {
      const line = document.createElement('div');
      line.className = 'settings-title';
      line.textContent = text;
      add(line);
    };

    title('Погода');
    add(this.createCheckBox(settings, onChange, 'weather', 'Непогода (дождь и молнии)'));
    add(this.createSlider(settings, onChange, 'rainStrength', 'Сила дождя', 0, 1, 0.01));
    add(this.createSlider(settings, onChange, 'windStrength', 'Ветер', 0, 1, 0.01));
    add(this.createSlider(settings, onChange, 'lightningRate', 'Частота молний', 0, 1, 0.01));
    add(this.createSlider(settings, onChange, 'wetness', 'Мокрость поверхностей', 0, 1, 0.01));

    title('Небо при непогоде');
    add(this.createColor(settings, onChange, 'weatherSkyZenith', 'Цвет зенита (шторм)'));
    add(this.createColor(settings, onChange, 'weatherSkyHorizon', 'Цвет горизонта (шторм)'));
    add(this.createColor(settings, onChange, 'weatherSkySun', 'Цвет солнца (шторм)'));
    add(this.createColor(settings, onChange, 'weatherSkyGround', 'Цвет ниже горизонта (шторм)'));
    add(this.createSlider(settings, onChange, 'weatherCloudOffset', 'Прижатие облаков (шторм)', 0.02, 0.25, 0.005));
    add(this.createSlider(settings, onChange, 'weatherCloudCover', 'Плотность облаков (шторм)', 0.2, 0.95, 0.01));

    title('Туман и свет при непогоде');
    add(this.createColor(settings, onChange, 'weatherFogColor', 'Цвет тумана (шторм)'));
    add(this.createSlider(settings, onChange, 'weatherFogAlpha', 'Плотность тумана (шторм)', 0, 1, 0.01));
    add(this.createSlider(settings, onChange, 'weatherFogNear', 'Начало тумана (шторм)', 0, 20000, 100));
    add(this.createSlider(settings, onChange, 'weatherFogFar', 'Конец тумана (шторм)', 1000, 40000, 100));
    add(this.createColor(settings, onChange, 'weatherAmbientColor', 'Цвет затенённых мест (шторм)'));
    add(this.createColor(settings, onChange, 'weatherSunColor', 'Цвет солнца на объектах (шторм)'));
    add(this.createSlider(settings, onChange, 'weatherAmbientStrength', 'Сила ambient (шторм)', 0, 2, 0.01));
    add(this.createSlider(settings, onChange, 'weatherSunStrength', 'Сила солнца (шторм)', 0, 3, 0.01));
    add(this.createSlider(settings, onChange, 'weatherShadowDarkness', 'Темнота теней (шторм)', 0, 1, 0.01));
    return panel;
  }

  private createSlider(
    settings: GraphicsSettings,
    onChange: (key: keyof GraphicsSettings, settings: GraphicsSettings) => void,
    key: GraphicsNumberKey,
    text: string,
    min: number,
    max: number,
    step: number,
  ): HTMLElement {
    const line = document.createElement('div');
    line.className = 'settings-slider';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(settings[key]);
    const value = document.createElement('b');
    const show = (): void => {
      value.textContent = settings[key].toFixed(step >= 1 ? 0 : 2);
    };
    show();
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      show();
      saveGraphicsSettings(settings);
      onChange(key, settings);
    });
    const reset = document.createElement('button');
    reset.textContent = 'Сброс';
    reset.addEventListener('click', () => {
      settings[key] = DEFAULT_GRAPHICS_SETTINGS[key];
      input.value = String(settings[key]);
      show();
      saveGraphicsSettings(settings);
      onChange(key, settings);
    });
    line.append(text, input, value, reset);
    return line;
  }

  /** Окно перетаскивается за заголовок; позиция запоминается. */
  private enableDrag(handle: HTMLElement): void {
    const key = 'tanki.settingsWindowPos';
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { left: number; top: number } | null;
      if (saved) this.place(saved.left, saved.top);
    } catch {
      // позиция по умолчанию
    }
    handle.addEventListener('pointerdown', (event) => {
      const rect = this.root.getBoundingClientRect();
      const dx = event.clientX - rect.left;
      const dy = event.clientY - rect.top;
      handle.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent): void => this.place(e.clientX - dx, e.clientY - dy);
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        try {
          const r = this.root.getBoundingClientRect();
          localStorage.setItem(key, JSON.stringify({ left: r.left, top: r.top }));
        } catch {
          // без хранилища позиция не запоминается
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private place(left: number, top: number): void {
    const maxLeft = Math.max(0, window.innerWidth - 80);
    const maxTop = Math.max(0, window.innerHeight - 40);
    this.root.style.transform = 'none';
    this.root.style.left = `${Math.min(Math.max(left, 0), maxLeft)}px`;
    this.root.style.top = `${Math.min(Math.max(top, 0), maxTop)}px`;
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
    this.onVisibilityChange?.(this.visible);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }
}

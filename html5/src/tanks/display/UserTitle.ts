// Заголовок над танком: alternativa/tanks/display/usertitle/UserTitle.as, ProgressBar.as, ProgressBarSkin.as, TitleConfigFlags.as.
// Во Flash это Sprite3D с perspectiveScale = false в «переднем» контейнере (поверх сцены): картинка пиксель в пиксель
// в точке меша башни. Здесь — canvas поверх WebGL, позиция — проекция той же точки.
// Перенесены полоски здоровья и перезарядки, ник со значком звания (у чужих танков) и значки эффектов (EffectIndicator + Blinker).

/** TitleConfigFlags */
export const TitleConfigFlags = {
  LABEL: 1, // get
  HEALTH: 2, // §5!v§
  WEAPON: 4, // §;"J§
  EFFECTS: 8, // §6G§
};

// UserTitle: размеры в пикселях
const LABEL_HEIGHT = 13; // §+"K§
const LABEL_TO_HEALTH = 2; // §6"6§
const HEALTH_TO_WEAPON = -1; // §5j§
const EFFECTS_GAP = 4; // §0!j§
const EFFECT_SIZE = 16; // §"h§
const EFFECT_SPACING = 4; // §5"U§
const BAR_WIDTH = 100; // § !F§
const BAR_HEIGHT = 8; // §'f§
const MARGIN = 3; // §,n§
/** скорость появления и исчезновения, 1/мс (§3D§) */
const ALPHA_SPEED = 0.002;
const RANK_ICON_WIDTH = 13; // §1"2§
const RANK_TO_LABEL = 0; // §%!T§
/** controls.Label: MyriadPro 12, thickness 50 */
const LABEL_FONT = "12px 'MyriadPro', Arial, sans-serif";
/** TextField: текст отступает от верхнего края на 2 пикселя (gutter) */
const LABEL_GUTTER = 2;
/** RangIconSmall: tools/extract_hud_assets.py → html5/public/battle/hud/rank_small/<звание>.png */
const RANK_ICON_BASE = 'battle/hud/rank_small';

const rankIcons = new Map<number, HTMLImageElement>();
const effectIcons = new Map<number, HTMLImageElement>();
const archiveEffectIcons = new Map<number, HTMLImageElement>();
const EFFECT_ICON_NAMES: Record<number, string> = { 1: 'effectHealth', 2: 'effectArmor', 3: 'effectPower', 4: 'effectNitro' };
const ARCHIVE_EFFECT_ICONS: Record<number, { name: string; width: number; height: number }> = {
  1: { name: 'health', width: 20, height: 20 },
  2: { name: 'armor', width: 18, height: 20 },
  3: { name: 'power', width: 22, height: 22 },
  4: { name: 'nitro', width: 19, height: 21 },
};

/** значки эффектов: tools/extract_usertitle_skins.py -> html5/public/battle/usertitle/effect<Имя>.png */
function getEffectIcon(type: number, archive: boolean): HTMLImageElement {
  const cache = archive ? archiveEffectIcons : effectIcons;
  let icon = cache.get(type);
  if (!icon) {
    icon = new Image();
    // ассеты могут лежать на CDN (другой домен): без CORS canvas с картинкой нельзя читать
    icon.crossOrigin = 'anonymous';
    icon.src = archive ? `battle/inventory-2019/effects/${ARCHIVE_EFFECT_ICONS[type].name}.png` : `battle/usertitle/${EFFECT_ICON_NAMES[type]}.png`;
    cache.set(type, icon);
  }
  return icon;
}

function getRankIcon(rank: number): HTMLImageElement {
  let icon = rankIcons.get(rank);
  if (!icon) {
    icon = new Image();
    // ассеты могут лежать на CDN (другой домен): без CORS canvas с картинкой нельзя читать
    icon.crossOrigin = 'anonymous';
    icon.src = `${RANK_ICON_BASE}/${rank}.png`;
    rankIcons.set(rank, icon);
  }
  return icon;
}

/** Картинки скинов: tools/extract_usertitle_skins.py → html5/public/battle/usertitle */
const SKIN_IMAGES = [
  'hpLeftDm', 'hpRightDm', 'hpLeftBgDm', 'hpRightBgDm',
  'hpLeftBlue', 'hpRightBlue', 'hpLeftBgBlue', 'hpRightBgBlue',
  'hpLeftRed', 'hpRightRed', 'hpLeftBgRed', 'hpRightBgRed',
  'weaponLeft', 'weaponRight', 'weaponLeftBg', 'weaponRightBg',
  'barShadow', 'barShadowLeft', 'barShadowRight',
] as const;
type SkinImage = (typeof SKIN_IMAGES)[number];

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // ассеты могут лежать на CDN (другой домен): без CORS canvas с картинкой нельзя читать
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('не загрузилась картинка ' + url));
    image.src = url;
  });
}

function rgb(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}

/** ProgressBarSkin: цвета заполнения и фона, края полоски и тень */
export class ProgressBarSkin {
  constructor(
    readonly color: string, // §="L§
    readonly bgColor: string, // §[!a§
    readonly left: HTMLImageElement, // §<!=§
    readonly leftBg: HTMLImageElement, // §7!y§
    readonly right: HTMLImageElement, // §]8§
    readonly rightBg: HTMLImageElement, // §63§
    readonly shadow: HTMLImageElement, // §]p§
    readonly shadowLeft: HTMLImageElement, // §%!^§
    readonly shadowRight: HTMLImageElement, // §+!Y§
    readonly darkBackground=false,
  ) {}
}

export interface ProgressBarSkins {
  dm: ProgressBarSkin; // §'U§
  blue: ProgressBarSkin; // §'!v§
  red: ProgressBarSkin; // §7! §
  weapon: ProgressBarSkin; // §"!N§
}

export async function loadProgressBarSkins(base: string): Promise<ProgressBarSkins> {
  const images = {} as Record<SkinImage, HTMLImageElement>;
  await Promise.all(SKIN_IMAGES.map(async (name) => (images[name] = await loadImage(`${base}/${name}.png`))));
  const i = images;
  const shadows = [i.barShadow, i.barShadowLeft, i.barShadowRight] as const;
  return {
    dm: new ProgressBarSkin(rgb(4964125), rgb(2448911), i.hpLeftDm, i.hpLeftBgDm, i.hpRightDm, i.hpRightBgDm, ...shadows),
    blue: new ProgressBarSkin(rgb(4691967), rgb(2181375), i.hpLeftBlue, i.hpLeftBgBlue, i.hpRightBlue, i.hpRightBgBlue, ...shadows),
    red: new ProgressBarSkin(rgb(15741974), '#511006', i.hpLeftRed, i.hpLeftBgRed, i.hpRightRed, i.hpRightBgRed, ...shadows, true),
    weapon: new ProgressBarSkin(rgb(14207247), rgb(7758340), i.weaponLeft, i.weaponLeftBg, i.weaponRight, i.weaponRightBg, ...shadows),
  };
}

/** ProgressBar: рисует полоску в canvas заголовка */
class ProgressBar {
  private skin!: ProgressBarSkin; // §<!f§
  private capWidth = 0; // §+M§
  private barHeight = 0; // §[Z§
  private shadowCapWidth = 0; // §&!1§
  private shadowHeight = 0; // §`!S§
  private barX = 0; // §6!%§
  private barY = 0; // §2!`§
  private progress_ = 0; // §[""§

  constructor(
    private readonly x: number,
    private readonly y: number,
    private readonly maxValue: number, // §2!p§
    private readonly width: number, // §[!0§
    skin: ProgressBarSkin,
  ) {
    this.setSkin(skin);
  }

  setSkin(skin: ProgressBarSkin): void {
    this.skin = skin;
    this.capWidth = skin.leftBg.width;
    this.barHeight = skin.leftBg.height;
    this.shadowCapWidth = skin.shadowLeft.width;
    this.shadowHeight = skin.shadow.height;
    this.barX = this.shadowCapWidth - this.capWidth;
    this.barY = (this.shadowHeight - this.barHeight) >> 1;
  }

  set progress(value: number) {
    this.progress_ = Math.max(0, Math.min(this.maxValue, value));
  }

  draw(context: CanvasRenderingContext2D): void {
    const s = this.skin;
    const w = this.width;
    const cap = this.capWidth;
    // fillRect(§#[§, 0): прямоугольник полоски вместе с тенью
    context.clearRect(this.x, this.y, 2 * this.shadowCapWidth + w, this.shadowHeight);
    context.save();
    context.translate(this.x, this.y);
    // тень: beginBitmapFill без матрицы — плитка от начала полоски
    this.fillBitmap(context, s.shadowLeft, 0, 0, this.shadowCapWidth, this.shadowHeight, 0, 0, true);
    this.fillBitmap(context, s.shadow, this.shadowCapWidth, 0, w - 2 * cap, this.shadowHeight, 0, 0, true);
    this.fillBitmap(context, s.shadowRight, this.shadowCapWidth + w - 2 * cap, 0, this.shadowCapWidth, this.shadowHeight, 0, 0, true);
    let filled = Math.trunc((w * this.progress_) / this.maxValue);
    const end = w - cap;
    let drawn = 0;
    if (filled >= cap) {
      if (filled == w) {
        this.drawFullBar(context, s.color, s.left, s.right);
        drawn = filled;
      } else {
        this.fillBitmap(context, s.left, this.barX, this.barY, cap, this.barHeight, this.barX, this.barY, false);
        if (filled > cap) {
          if (filled > end) filled = end;
          drawn = filled;
          context.fillStyle = s.color;
          context.fillRect(this.barX + cap, this.barY, filled - cap, this.barHeight);
        } else {
          drawn = cap;
        }
      }
    }
    if (drawn == 0) {
      this.drawFullBar(context, s.bgColor, s.leftBg, s.rightBg);
    } else if (drawn < w) {
      context.fillStyle = s.bgColor;
      context.fillRect(this.barX + drawn, this.barY, end - drawn, this.barHeight);
      this.fillBitmap(context, s.rightBg, this.barX + end, this.barY, cap, this.barHeight, this.barX + end, this.barY, false);
    }
    context.restore();
  }

  private drawFullBar(context: CanvasRenderingContext2D, color: string, left: HTMLImageElement, right: HTMLImageElement): void {
    const end = this.width - this.capWidth;
    this.fillBitmap(context, left, this.barX, this.barY, this.capWidth, this.barHeight, this.barX, this.barY, false);
    context.fillStyle = color;
    context.fillRect(this.barX + this.capWidth, this.barY, end - this.capWidth, this.barHeight);
    this.fillBitmap(context, right, this.barX + end, this.barY, this.capWidth, this.barHeight, this.barX + end, this.barY, false);
  }

  /** Graphics.beginBitmapFill(bitmap, matrix(tx, ty), repeat) + drawRect */
  private fillBitmap(
    context: CanvasRenderingContext2D,
    image: HTMLImageElement,
    x: number,
    y: number,
    width: number,
    height: number,
    tx: number,
    ty: number,
    repeat: boolean,
  ): void {
    if (width <= 0 || height <= 0) return;
    const pattern = context.createPattern(image, repeat ? 'repeat' : 'no-repeat');
    if (!pattern) return;
    pattern.setTransform(new DOMMatrix([1, 0, 0, 1, tx, ty]));
    const dark=this.skin.darkBackground&&(image===this.skin.leftBg||image===this.skin.rightBg);
    if(dark){context.save();context.filter='brightness(0.5)';}
    context.fillStyle = pattern;
    context.fillRect(x, y, width, height);
    if(dark)context.restore();
  }
}


/** InventoryItemType: номера эффектов совпадают с номерами слотов инвентаря */
export const EffectType = { HEALTH: 1, ARMOR: 2, POWER: 3, NITRO: 4 } as const;
const EFFECT_TYPES: number[] = [EffectType.HEALTH, EffectType.ARMOR, EffectType.POWER, EffectType.NITRO];
/** за сколько до конца значок начинает мигать; у аптечки мигает всё время (100000) */
const BLINK_LEAD_TIME = 3000;
const BLINK_LEAD_TIME_HEALTH = 100000;
const EFFECT_MIN_ALPHA = 0.2; // §!<§

/** alternativa/tanks/sfx/Blinker.as: прозрачность ходит между min и max, интервал смены уменьшается до минимума */
class Blinker {
  private minValue: number; // §`@§
  private readonly maxValue: number; // §2!p§
  private range: number; // §&"H§
  private value = 0; // §]`§
  private speed = 0; // §?;§
  private interval = 0; // §[L§
  private nextSwitch = 0; // §=!B§

  constructor(
    private readonly initialInterval: number,
    private readonly minInterval: number,
    private readonly intervalStep: number,
    minValue: number,
    maxValue: number,
    private readonly speedCoeff: number,
  ) {
    this.minValue = minValue;
    this.maxValue = maxValue;
    this.range = maxValue - minValue;
  }

  setMinValue(value: number): void {
    if (value <= this.maxValue) {
      this.minValue = value;
      this.range = this.maxValue - this.minValue;
    }
  }

  init(now: number): void {
    this.value = this.maxValue;
    this.interval = this.initialInterval;
    this.speed = this.getSpeed(-1);
    this.nextSwitch = now + this.interval;
  }

  updateValue(now: number, delta: number): number {
    this.value += this.speed * delta;
    if (this.value > this.maxValue) this.value = this.maxValue;
    if (this.value < this.minValue) this.value = this.minValue;
    if (now >= this.nextSwitch) {
      if (this.interval > this.minInterval) {
        this.interval -= this.intervalStep;
        if (this.interval < this.minInterval) this.interval = this.minInterval;
      }
      this.nextSwitch = now + this.interval;
      this.speed = this.speed < 0 ? this.getSpeed(1) : this.getSpeed(-1);
    }
    return this.value;
  }

  private getSpeed(direction: number): number {
    return (direction * this.speedCoeff * this.range) / this.interval;
  }
}

/** EffectIndicator.state: HIDDEN -> JUST_SHOWN -> VISIBLE; HIDING — мигание до полного исчезновения */
const IND_HIDDEN = 1;
const IND_JUST_SHOWN = 2;
const IND_VISIBLE = 4;
const IND_HIDING = 8;

/** alternativa/tanks/display/usertitle/EffectIndicator.as: значок эффекта 16x16, мигает перед концом и при снятии */
class EffectIndicator {
  private state = IND_HIDDEN;
  private blinkStart = 0; // §6!E§
  private blinking = false; // §!f§
  private alpha = 1; // §[!$§
  private dirty = false; // §>!S§
  private x = 0;
  private y = 0;
  private readonly blinker: Blinker;

  constructor(
    readonly effectId: number,
    private readonly leadTime: number,
    private readonly title: UserTitle,
    initialInterval: number,
    intervalStep: number,
    readonly width = EFFECT_SIZE,
    readonly height = EFFECT_SIZE,
  ) {
    this.blinker = new Blinker(initialInterval, 20, intervalStep, EFFECT_MIN_ALPHA, 1, 10);
  }

  isVisible(): boolean {
    return (this.state & IND_VISIBLE) != 0;
  }

  isHidden(): boolean {
    return this.state == IND_HIDDEN;
  }

  show(leftMs: number, now: number): void {
    this.state &= ~IND_HIDING;
    if (this.state != IND_VISIBLE || this.alpha != 1) this.dirty = true;
    this.blinkStart = now + leftMs - this.leadTime;
    this.blinking = false;
    this.alpha = 1;
    if (this.state == IND_HIDDEN) this.state = IND_JUST_SHOWN;
  }

  hide(now: number): void {
    if (this.state == IND_JUST_SHOWN) {
      this.title.doHideIndicator(this);
      this.state = IND_HIDDEN;
      return;
    }
    if ((this.state & (IND_HIDDEN | IND_HIDING)) != 0) return;
    this.state |= IND_HIDING;
    this.blinker.setMinValue(0);
    if (!this.blinking) {
      this.blinkStart = 0;
      this.blinker.init(now);
      this.blinking = true;
    }
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.dirty = true;
  }

  forceRedraw(): void {
    this.dirty = true;
  }

  clear(context: CanvasRenderingContext2D): void {
    if (this.state == IND_HIDDEN || this.state == IND_JUST_SHOWN) return;
    context.clearRect(this.x, this.y, this.width, this.height);
  }

  update(now: number, delta: number, context: CanvasRenderingContext2D, icon: HTMLImageElement): void {
    if (this.state == IND_HIDDEN) return;
    if (this.dirty) this.draw(context, icon);
    if (now > this.blinkStart) this.updateBlinking(now, delta, context, icon);
    if (this.state == IND_JUST_SHOWN) this.state = IND_VISIBLE;
  }

  private updateBlinking(now: number, delta: number, context: CanvasRenderingContext2D, icon: HTMLImageElement): void {
    if (this.blinking) {
      const alpha = this.blinker.updateValue(now, delta);
      if (alpha != this.alpha) {
        this.alpha = alpha;
        this.draw(context, icon);
      }
      if ((this.state & IND_HIDING) != 0 && this.alpha == 0) {
        this.title.doHideIndicator(this);
        this.state = IND_HIDDEN;
      }
    } else {
      this.blinker.setMinValue(EFFECT_MIN_ALPHA);
      this.blinker.init(now);
      this.blinking = true;
    }
  }

  private draw(context: CanvasRenderingContext2D, icon: HTMLImageElement): void {
    // The first frame may arrive before the image. Retry on the next frame.
    if (!icon.complete || icon.naturalWidth == 0) return;
    this.dirty = false;
    this.clear(context);
    context.save();
    context.globalAlpha = this.alpha;
    context.drawImage(icon, this.x, this.y);
    context.restore();
  }
}

/** UserTitle: ник со званием, здоровье, перезарядка, значки эффектов */
export class UserTitle {
  private labelText = ''; // §]W§
  private rank = 0; // §;_§
  private labelWidth = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private configuration = 0; // §%V§
  private dirty = 0; // §0!@§
  private healthBar: ProgressBar | null = null; // §]"#§
  private weaponBar: ProgressBar | null = null; // §<4§
  private health = 0; // §^W§
  private weaponStatus = 0; // §8!Y§
  private hidden = true; // §9e§
  private alpha = 0;
  private lastTime = 0; // §4x§
  private skin: ProgressBarSkin; // §>!X§
  private indicators: EffectIndicator[] | null = null; // §1!Y§
  private visibleIndicators = 0; // §]!;§
  private indicatorsDirty = false; // §9!z§
  private effectsY = 0; // §0x§
  private screenX = NaN;
  private screenY = NaN;

  constructor(
    parent: HTMLElement,
    private readonly skins: ProgressBarSkins,
    private readonly maxHealth: number, // §^v§
    private readonly archiveEffects = false,
  ) {
    this.skin = skins.dm;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;image-rendering:pixelated;display:none;';
    this.context = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    parent.appendChild(this.canvas);
    this.lastTime = performance.now();
  }

  show(): void {
    this.hidden = false;
  }

  hide(): void {
    this.hidden = true;
  }

  get needsProjection(): boolean {
    return !this.hidden || this.alpha > 0;
  }

  hideImmediate(): void {
    this.hidden = true;
    this.alpha = 0;
    this.canvas.style.display = 'none';
  }

  setConfiguration(configuration: number): void {
    if (this.configuration != configuration) {
      this.configuration = configuration;
      if (configuration != 0) this.rebuild();
    }
  }

  private rebuild(): void {
    this.setupTexture();
    this.setupComponents();
  }

  /** setTeamType: цвет ника и полоски здоровья (ProgressBarSkin команды) */
  setSkin(skin: ProgressBarSkin): void {
    if (this.skin != skin) {
      this.skin = skin;
      this.invalidate(TitleConfigFlags.LABEL | TitleConfigFlags.HEALTH | TitleConfigFlags.WEAPON);
    }
  }

  setRank(rank: number): void {
    if (this.rank != rank) {
      this.rank = rank;
      const icon = getRankIcon(rank);
      if (!icon.complete) icon.addEventListener('load', () => this.invalidate(TitleConfigFlags.LABEL), { once: true });
      this.invalidate(TitleConfigFlags.LABEL | TitleConfigFlags.HEALTH | TitleConfigFlags.WEAPON | TitleConfigFlags.EFFECTS);
    }
  }

  setLabelText(text: string): void {
    if (this.labelText != text) {
      this.labelText = text;
      if (this.hasAnyFlag(TitleConfigFlags.LABEL)) this.rebuild();
      // ширина ника зависит от шрифта: когда MyriadPro догрузится, размер пересчитывается
      void document.fonts.load(LABEL_FONT).then(() => {
        if (this.hasAnyFlag(TitleConfigFlags.LABEL)) this.rebuild();
      });
    }
  }

  setHealth(value: number): void {
    if (this.health != value) {
      this.health = value;
      this.invalidate(TitleConfigFlags.HEALTH);
    }
  }

  setWeaponStatus(value: number): void {
    if (this.weaponStatus != value) {
      this.weaponStatus = value;
      this.invalidate(TitleConfigFlags.WEAPON);
    }
  }

  /** update + setPosition: screenX/screenY — проекция точки в CSS-пикселях, null — точка за камерой */
  update(screenX: number | null, screenY: number | null): void {
    const now = performance.now();
    const delta = now - this.lastTime;
    this.lastTime = now;
    this.updateVisibility(delta);
    if (this.dirty != 0) {
      if (this.isDirtyAndHasOption(TitleConfigFlags.LABEL)) {
        // После очистки всего холста восстанавливаются и полоски, и значки.
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.drawLabel();
        this.dirty |= (TitleConfigFlags.HEALTH | TitleConfigFlags.WEAPON | TitleConfigFlags.EFFECTS) & this.configuration;
      }
      if (this.isDirtyAndHasOption(TitleConfigFlags.HEALTH) && this.healthBar) {
        this.healthBar.setSkin(this.skin);
        this.healthBar.progress = this.health;
        this.healthBar.draw(this.context);
      }
      if (this.isDirtyAndHasOption(TitleConfigFlags.WEAPON) && this.weaponBar) {
        this.weaponBar.progress = this.weaponStatus;
        this.weaponBar.draw(this.context);
      }
      if (this.isDirtyAndHasOption(TitleConfigFlags.EFFECTS)) {
        for (const indicator of this.indicators ?? []) indicator.forceRedraw();
      }
      this.dirty = 0;
    }
    if (this.hasAnyFlag(TitleConfigFlags.EFFECTS)) this.updateEffectIndicators(now, delta);
    const visible = this.alpha > 0 && screenX != null && screenY != null;
    const display = visible ? 'block' : 'none';
    if (this.canvas.style.display !== display) this.canvas.style.display = display;
    if (visible) {
      // Sprite3D: центр картинки в точке, целые пиксели — без размытия
      const x = Math.round(screenX - this.canvas.width / 2);
      const y = Math.round(screenY - this.canvas.height / 2);
      if (this.screenX !== x || this.screenY !== y) {
        this.canvas.style.transform = `translate(${x}px, ${y}px)`;
        this.screenX = x;
        this.screenY = y;
      }
      const opacity = String(this.alpha);
      if (this.canvas.style.opacity !== opacity) this.canvas.style.opacity = opacity;
    }
  }

  /** showIndicator: значок эффекта на leftMs миллисекунд (мигает последние 3 с) */
  showIndicator(type: number, leftMs: number): void {
    if (!this.hasAnyFlag(TitleConfigFlags.EFFECTS)) return;
    const indicator = this.getIndicator(type);
    if (!indicator) return;
    if (indicator.isHidden()) this.changeVisibleIndicators(1);
    indicator.show(leftMs, performance.now());
  }

  hideIndicator(type: number): void {
    if (!this.hasAnyFlag(TitleConfigFlags.EFFECTS)) return;
    this.getIndicator(type)?.hide(performance.now());
  }

  hideIndicators(): void {
    for (const type of EFFECT_TYPES) this.hideIndicator(type);
  }

  /** doHideIndicator */
  doHideIndicator(indicator: EffectIndicator): void {
    indicator.clear(this.context);
    this.changeVisibleIndicators(-1);
  }

  private changeVisibleIndicators(delta: number): void {
    this.visibleIndicators += delta;
    this.indicatorsDirty = true;
  }

  private getIndicator(type: number): EffectIndicator | undefined {
    if (!this.indicators) {
      this.indicators = EFFECT_TYPES.map((effect) => {
        const heal = effect === EffectType.HEALTH;
        const size = this.archiveEffects ? ARCHIVE_EFFECT_ICONS[effect] : undefined;
        return new EffectIndicator(effect, heal ? BLINK_LEAD_TIME_HEALTH : BLINK_LEAD_TIME, this, 300, heal ? 0 : 30, size?.width, size?.height);
      });
    }
    return this.indicators.find((indicator) => indicator.effectId == type);
  }

  /** updateEffectIndicators: значки стоят в ряд по центру, скрытые места не занимают */
  private updateEffectIndicators(now: number, delta: number): void {
    const indicators = this.indicators;
    if (!indicators) return;
    if (this.indicatorsDirty) {
      this.indicatorsDirty = false;
      const count = this.visibleIndicators;
      const width = Math.max(0, count - 1) * EFFECT_SPACING + count * EFFECT_SIZE;
      let x = (this.canvas.width - width) >> 1;
      for (const indicator of indicators) {
        if (indicator.isVisible()) indicator.clear(this.context);
        if (!indicator.isHidden()) {
          indicator.setPosition(x, this.effectsY);
          x += indicator.width + (this.archiveEffects ? 1 : EFFECT_SPACING);
        }
      }
    }
    for (const indicator of indicators) indicator.update(now, delta, this.context, getEffectIcon(indicator.effectId, this.archiveEffects));
  }

  dispose(): void {
    this.canvas.remove();
  }

  private isDirtyAndHasOption(flag: number): boolean {
    return (flag & this.dirty & this.configuration) == flag;
  }

  private invalidate(flags: number): void {
    this.dirty |= flags & this.configuration;
  }

  private hasAnyFlag(flags: number): boolean {
    return (flags & this.configuration) != 0;
  }

  /** updateLabel: значок звания и ник цветом скина, по центру, с чёрным свечением GlowFilter(0, 0.8, 4, 4, 3) */
  private drawLabel(): void {
    const context = this.context;
    const x = (this.canvas.width - (RANK_ICON_WIDTH + RANK_TO_LABEL + this.labelWidth)) >> 1;
    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.8)';
    context.shadowBlur = 2;
    const icon = getRankIcon(this.rank);
    context.font = LABEL_FONT;
    context.textBaseline = 'top';
    context.fillStyle = this.skin.color;
    // сила свечения 3 — тот же рисунок три раза
    for (let pass = 0; pass < 3; pass++) {
      if (icon.complete && icon.naturalWidth > 0) context.drawImage(icon, x, MARGIN + LABEL_GUTTER + (12-icon.naturalHeight)/2);
      context.fillText(this.labelText, x + RANK_ICON_WIDTH + RANK_TO_LABEL, MARGIN + LABEL_GUTTER);
    }
    context.restore();
  }

  private measureLabel(): number {
    this.context.font = LABEL_FONT;
    return Math.ceil(this.context.measureText(this.labelText).width);
  }

  private setupTexture(): void {
    let width = 0;
    let height = 0;
    if (this.hasAnyFlag(TitleConfigFlags.LABEL)) {
      this.labelWidth = this.measureLabel();
      width = RANK_ICON_WIDTH + RANK_TO_LABEL + this.labelWidth;
      height = LABEL_HEIGHT;
    }
    if (this.hasAnyFlag(TitleConfigFlags.HEALTH)) {
      width = Math.max(width, BAR_WIDTH);
      if (this.hasAnyFlag(TitleConfigFlags.LABEL)) height += LABEL_TO_HEALTH;
      height += BAR_HEIGHT;
      if (this.hasAnyFlag(TitleConfigFlags.WEAPON)) height += HEALTH_TO_WEAPON + BAR_HEIGHT;
    }
    if (this.hasAnyFlag(TitleConfigFlags.EFFECTS)) {
      const count = 4;
      const effectWidth = this.archiveEffects ? 82 : count * EFFECT_SIZE + (count - 1) * EFFECT_SPACING;
      width = Math.max(width, effectWidth);
      if (this.hasAnyFlag(TitleConfigFlags.LABEL | TitleConfigFlags.HEALTH)) height += this.archiveEffects ? 2 : EFFECTS_GAP;
      this.effectsY = height + MARGIN;
      height += this.archiveEffects ? 22 : EFFECT_SIZE;
    }
    this.indicatorsDirty = true; // холст пересоздан — значки переставляются и рисуются заново
    this.canvas.width = width + 2 * MARGIN;
    this.canvas.height = height + 2 * MARGIN;
    this.canvas.style.width = `${this.canvas.width}px`;
    this.canvas.style.height = `${this.canvas.height}px`;
    this.invalidate(TitleConfigFlags.LABEL | TitleConfigFlags.HEALTH | TitleConfigFlags.WEAPON | TitleConfigFlags.EFFECTS);
  }

  private setupComponents(): void {
    let y = MARGIN;
    if (this.hasAnyFlag(TitleConfigFlags.LABEL)) y += LABEL_HEIGHT;
    if (this.hasAnyFlag(TitleConfigFlags.HEALTH)) {
      if (this.hasAnyFlag(TitleConfigFlags.LABEL)) y += LABEL_TO_HEALTH;
      const x = (this.canvas.width - BAR_WIDTH) >> 1;
      this.healthBar = new ProgressBar(x, y, this.maxHealth, BAR_WIDTH, this.skin);
      y += BAR_HEIGHT;
      if (this.hasAnyFlag(TitleConfigFlags.WEAPON)) {
        y += HEALTH_TO_WEAPON;
        this.weaponBar = new ProgressBar(x, y, 100, BAR_WIDTH, this.skins.weapon);
      }
    }
  }

  private updateVisibility(delta: number): void {
    if (this.hidden) {
      if (this.alpha > 0) this.alpha = Math.max(0, this.alpha - ALPHA_SPEED * delta);
    } else if (this.alpha < 1) {
      this.alpha = Math.min(1, this.alpha + ALPHA_SPEED * delta);
    }
  }
}

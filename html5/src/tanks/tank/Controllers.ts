// 1:1 из alternativa/tanks/battle/objects/tank/{TurretController,LocalTurretController,TurretControlKeyMap,
// ChassisController,LocalChassisController,ChassisControlKeyMap,SimpleValueSmoother}.as
// и alternativa/tanks/models/weapon/shared/SimpleKeyboardWeaponController.as.
// Клавиши — keyCode Flash; в браузере это те же коды KeyboardEvent.keyCode.
import { clamp, clampAngle, moveValueTowards, PI2, sign } from '../utils/MathUtils.ts';
import type { Matrix3 } from '../../physics/math/Matrix3.ts';
import { Vector3 } from '../../physics/math/Vector3.ts';
import { CAMERA_FOLLOWS_MOUSE, CAMERA_FOLLOWS_TURRET, followCamera } from '../camera/FollowCameraController.ts';
import { EncryptedValueSmoother, type ValueSmoother } from './Suspension.ts';

const enum Key {
  LEFT = 37,
  UP = 38,
  RIGHT = 39,
  DOWN = 40,
  SPACE = 32,
  A = 65,
  C = 67,
  D = 68,
  S = 83,
  W = 87,
  X = 88,
  Y = 89,
  Z = 90,
  COMMA = 188,
  PERIOD = 190,
  SLASH = 191,
}

function getBitValue(value: number, bit: number): number {
  return (value >> bit) & 1;
}

function changeBitValue(value: number, bit: number, set: boolean): number {
  return set ? value | (1 << bit) : value & ~(1 << bit);
}

/**
 * Источник клавиатурных событий (stage во Flash). Повторы автоповтора отбрасываются.
 * Окно потеряло фокус (alt+tab, свернули) — keyup браузер уже не пришлёт: все зажатые клавиши отпускаются,
 * иначе танк продолжал ехать/стрелять сам, пока игрок не вернётся.
 */
export class KeyboardSource {
  private readonly listeners: ((keyCode: number, down: boolean) => void)[] = [];
  private readonly pressed = new Set<number>();
  private readonly virtualPressed=new Set<number>();

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || isTyping(event)) return;
    const already=this.pressed.has(event.keyCode)||this.virtualPressed.has(event.keyCode);
    this.pressed.add(event.keyCode);
    if(!already)this.emit(event.keyCode, true);
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (isTyping(event) && !this.pressed.has(event.keyCode)) return;
    this.pressed.delete(event.keyCode);
    if(!this.virtualPressed.has(event.keyCode))this.emit(event.keyCode, false);
  };
  private readonly releaseAll = (): void => {
    for (const keyCode of new Set([...this.pressed,...this.virtualPressed])) {
      this.pressed.delete(keyCode);this.virtualPressed.delete(keyCode);
      this.emit(keyCode, false);
    }
  };
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.releaseAll();
  };

  constructor(private readonly target: Window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.listeners.length = 0;
  }

  setVirtualKey(keyCode:number,down:boolean):void {
    const before=this.pressed.has(keyCode)||this.virtualPressed.has(keyCode);
    if(down)this.virtualPressed.add(keyCode);else this.virtualPressed.delete(keyCode);
    const after=this.pressed.has(keyCode)||this.virtualPressed.has(keyCode);
    if(before!==after)this.emit(keyCode,after);
  }

  addListener(listener: (keyCode: number, down: boolean) => void): void {
    this.listeners.push(listener);
  }

  private emit(keyCode: number, down: boolean): void {
    for (const listener of this.listeners) listener(keyCode, down);
  }
}

function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return target != null && (target.tagName == 'INPUT' || target.tagName == 'TEXTAREA');
}

export class SimpleValueSmoother extends EncryptedValueSmoother {}

// ---------------------------------------------------------------- башня ----

/** TurretControlType клиента 2019: клавиши (направление вращения) или угол-цель — в осях танка или мира (мышь) */
export const TurretControlType = {
  ROTATION_DIRECTION: 0,
  TARGET_ANGLE_LOCAL: 1,
  TARGET_ANGLE_WORLD: 2,
} as const;

/** Turret.ANGLE_EPSILON (2019) */
const ANGLE_EPSILON = (0.5 * Math.PI) / 180;
const worldDirection = new Vector3();

export class TurretController {
  static readonly BIT_LEFT = 0; // §[!H§
  static readonly BIT_RIGHT = 1; // §!Z§
  static readonly BIT_CENTER = 2; // §8!+§

  private readonly maxTurnSpeedSmoother: ValueSmoother = new SimpleValueSmoother(0.3, 10, 0, 0); // §=F§
  private maxTurnSpeed = 0; // §&"2§
  private turnAcceleration = 0; // §3i§
  protected turnSpeed = 0; // §1J§
  private prevDirection = 0; // §2!D§
  private direction = 0; // §,!V§
  private lastTurnDirection = 0; // §>!7§
  private turnDirection = 0; // §73§
  private centering = false; // §<Y§
  private lockMask = 0; // §var§ (BitMask)
  private readonly resetControlOnReset: boolean; // §""B§
  private control = 0; // §!+§
  /** 2019: вид управления и угол-цель для TARGET_ANGLE_* */
  protected controlType: number = TurretControlType.ROTATION_DIRECTION;
  private targetAngle = 0;

  constructor(maxTurnSpeed: number, turnAcceleration: number, resetControlOnReset: boolean) {
    this.resetControlOnReset = resetControlOnReset;
    this.setMaxTurnSpeed(maxTurnSpeed, true);
    this.turnAcceleration = turnAcceleration;
  }

  lock(bits: number): void {
    this.lockMask |= bits;
    if (this.lockMask != 0) this.turnSpeed = 0;
  }

  unlock(bits: number): void {
    const wasEmpty = this.lockMask == 0;
    this.lockMask &= ~bits;
    if (this.lockMask == 0 && !wasEmpty) {
      this.centering = false;
      this.doUnlock();
    }
  }

  applyControlState(control: number): void {
    this.controlType = TurretControlType.ROTATION_DIRECTION;
    this.control = control;
    const left = getBitValue(control, TurretController.BIT_LEFT);
    const right = getBitValue(control, TurretController.BIT_RIGHT);
    this.turnDirection = left - right;
    this.centering = left + right == 0 && (this.centering || getBitValue(control, TurretController.BIT_CENTER) == 1);
  }

  /** Turret.setTurretControlState (2019) для TARGET_ANGLE_LOCAL / TARGET_ANGLE_WORLD */
  setTargetControl(type: number, angle: number): void {
    this.controlType = type;
    this.targetAngle = angle;
    this.centering = false;
  }

  setDirectionImmediate(direction: number): void {
    this.direction = direction;
  }

  getDirection(): number {
    return this.direction;
  }

  getControl(): number {
    return this.control;
  }

  /** @param baseMatrix ориентация корпуса — для угла-цели в осях мира (Tank.rotateTurret 2019) */
  rotate(dt: number, baseMatrix: Matrix3 | null = null): void {
    this.prevDirection = this.direction;
    this.maxTurnSpeed = this.maxTurnSpeedSmoother.update(dt);
    if (this.lockMask != 0) return;
    if (this.controlType == TurretControlType.TARGET_ANGLE_LOCAL) {
      this.rotateToLocalDirection(dt, this.targetAngle);
      return;
    }
    if (this.controlType == TurretControlType.TARGET_ANGLE_WORLD) {
      this.rotateToLocalDirection(dt, baseMatrix ? localFromWorldDirection(this.targetAngle, baseMatrix) : this.targetAngle);
      return;
    }
    let turnDirection: number;
    if (this.centering) {
      if (this.direction == 0) {
        this.finishTurretCentering();
        return;
      }
      turnDirection = this.direction < 0 ? 1 : -1;
    } else {
      turnDirection = this.turnDirection;
    }
    if (this.lastTurnDirection != turnDirection) {
      this.turnSpeed = 0;
      this.lastTurnDirection = turnDirection;
    }
    if (turnDirection == 0) {
      this.turnSpeed = 0;
      return;
    }
    this.turnSpeed += turnDirection * this.turnAcceleration * dt;
    this.turnSpeed = clamp(this.turnSpeed, -this.maxTurnSpeed, this.maxTurnSpeed);
    const wasNegative = this.direction < 0;
    this.direction += this.turnSpeed * dt;
    if (this.centering && wasNegative != this.direction < 0) {
      this.direction = 0;
      this.finishTurretCentering();
    }
    if (this.direction < -Math.PI) this.direction += PI2;
    else if (this.direction > Math.PI) this.direction -= PI2;
  }

  /** Turret.rotateToLocalDirection (2019): разгон к углу-цели и точная остановка на нём */
  private rotateToLocalDirection(dt: number, target: number): void {
    const delta = clampAngle(target - this.direction);
    if (Math.abs(delta) < ANGLE_EPSILON) {
      this.direction = target;
      this.turnSpeed = 0;
      return;
    }
    if (delta * this.turnSpeed <= 0) this.turnSpeed = 0;
    const step = this.turnSpeed * dt;
    if (Math.abs(step) > Math.abs(delta)) this.direction = target;
    else this.direction = clampAngle(this.direction + step);
    this.turnSpeed = moveValueTowards(this.turnSpeed, sign(delta) * this.maxTurnSpeed, this.turnAcceleration * dt);
  }

  private finishTurretCentering(): void {
    this.centering = false;
    this.turnSpeed = 0;
    this.onTurretCenteringComplete();
  }

  protected onTurretCenteringComplete(): void {}

  getInterpolatedDirection(t: number): number {
    let result: number;
    const delta = this.direction - this.prevDirection;
    if (delta < -Math.PI) {
      result = this.prevDirection + t * (PI2 + delta);
      if (result > Math.PI) result -= PI2;
    } else if (delta > Math.PI) {
      result = this.prevDirection - t * (PI2 - delta);
      if (result < -Math.PI) result += PI2;
    } else {
      result = this.prevDirection + t * delta;
    }
    return result;
  }

  isRotating(): boolean {
    return this.turnSpeed != 0;
  }

  reset(): void {
    this.turnSpeed = 0;
    this.prevDirection = 0;
    this.direction = 0;
    this.maxTurnSpeedSmoother.reset(this.maxTurnSpeedSmoother.getTargetValue());
    this.centering = false;
    if (this.resetControlOnReset) this.turnDirection = 0;
  }

  setMaxTurnSpeed(value: number, immediate: boolean): void {
    if (immediate) {
      this.maxTurnSpeed = value;
      this.maxTurnSpeedSmoother.reset(value);
    } else {
      this.maxTurnSpeedSmoother.setTargetValue(value);
    }
  }

  getMaxTurnSpeed(): number {
    return this.maxTurnSpeedSmoother.getTargetValue();
  }

  setTurnAcceleration(value: number): void {
    this.turnAcceleration = value;
  }

  getTurnAcceleration(): number {
    return this.turnAcceleration;
  }

  protected doUnlock(): void {}

  protected isNotLocked(): boolean {
    return this.lockMask == 0;
  }
}

/** Turret.getLocalDirectionFromWorldDirection (2019) */
function localFromWorldDirection(angle: number, baseMatrix: Matrix3): number {
  worldDirection.reset(-Math.sin(angle), Math.cos(angle), 0);
  worldDirection.transformTransposed3(baseMatrix);
  return Math.atan2(-worldDirection.x, worldDirection.y);
}

export interface TurretControlListener {
  onTurretControlChanged(control: number): void; // § ,§
}

/** LocalTurretController 2019: MOUSE_SENS_MUL */
const MOUSE_SENS_MUL = 0.0001;

export class LocalTurretController extends TurretController {
  private listener: TurretControlListener | null = null; // §^!@§
  private keyState = 0; // §][§
  private readonly handlers = new Map<number, (down: boolean) => number>(); // §@"6§
  /** 2019: мировой угол, куда смотрит мышь */
  private mouseLookDirection = 0;
  /** 2019: правая кнопка (LOOK_AROUND) — башня стоит, камера крутится */
  private lockTurretDirection = false;
  /** 2019: settingsService.mouseSensitivity (1…20) */
  mouseSensitivity = 8;
  /** мировой угол башни своего танка (Tank.getInterpolatedTurretWorldDirection) */
  turretWorldDirection: () => number = () => 0;
  /** BattleInputService.releaseMouse */
  releaseMouse: () => void = () => undefined;
  /** биты для сервера, пока башня наводится по углу: куда она сейчас вращается */
  private virtualControl = 0;

  constructor(maxTurnSpeed: number, turnAcceleration: number, keyboard: KeyboardSource, language = 'ru') {
    super(maxTurnSpeed, turnAcceleration, false);
    // TurretControlKeyMap.initDefaultKeyMap: для немецкой раскладки «влево» — Y
    const keyLeft = language == 'de' ? Key.Y : Key.Z;
    this.applyControlState(0);
    for (const key of [keyLeft, Key.COMMA]) this.handlers.set(key, (down) => changeBitValue(this.keyState, TurretController.BIT_LEFT, down));
    for (const key of [Key.X, Key.PERIOD]) this.handlers.set(key, (down) => changeBitValue(this.keyState, TurretController.BIT_RIGHT, down));
    for (const key of [Key.C, Key.SLASH]) this.handlers.set(key, (down) => changeBitValue(this.keyState, TurretController.BIT_CENTER, down));
    keyboard.addListener((keyCode, down) => this.onKey(keyCode, down));
  }

  setListener(listener: TurretControlListener): void {
    this.listener = listener;
  }

  /** при наведении мышью сервер получает направление вращения, а не клавиши */
  override getControl(): number {
    return this.controlType == TurretControlType.ROTATION_DIRECTION ? super.getControl() : this.virtualControl;
  }

  override rotate(dt: number, baseMatrix: Matrix3 | null = null): void {
    super.rotate(dt, baseMatrix);
    if (this.controlType == TurretControlType.ROTATION_DIRECTION) return;
    const control = this.turnSpeed > 0 ? 1 << TurretController.BIT_LEFT : this.turnSpeed < 0 ? 1 << TurretController.BIT_RIGHT : 0;
    if (control != this.virtualControl) {
      this.virtualControl = control;
      if (this.isNotLocked()) this.listener?.onTurretControlChanged(control);
    }
  }

  protected override doUnlock(): void {
    this.listener?.onTurretControlChanged(this.getControl());
  }

  private onKey(keyCode: number, down: boolean): void {
    const handler = this.handlers.get(keyCode);
    if (handler == null) return;
    const control = handler(down);
    // 2019 rotateLeft/rotateRight/center: клавиши башни возвращают камеру за башней и отпускают мышь
    const centerKey = keyCode == Key.C || keyCode == Key.SLASH;
    if (!centerKey || down) {
      followCamera.mode = CAMERA_FOLLOWS_TURRET;
      this.releaseMouse();
    }
    if (control != this.keyState || this.controlType != TurretControlType.ROTATION_DIRECTION) {
      this.keyState = changeBitValue(control, TurretController.BIT_CENTER, false);
      this.virtualControl = 0;
      this.applyControlState(control);
      if (this.isNotLocked()) this.listener?.onTurretControlChanged(control);
    }
  }

  protected override onTurretCenteringComplete(): void {
    this.listener?.onTurretControlChanged(0);
  }

  /** 2019 onMouseLock: захват мыши переводит камеру и башню на мышь */
  onMouseLock(locked: boolean): void {
    if (locked && followCamera.mode != CAMERA_FOLLOWS_MOUSE) {
      this.mouseLookDirection = this.turretWorldDirection();
      followCamera.mode = CAMERA_FOLLOWS_MOUSE;
      followCamera.direction = this.mouseLookDirection;
      this.setTargetControl(TurretControlType.TARGET_ANGLE_WORLD, this.mouseLookDirection);
    }
  }

  /** Scope owns the target angle; keep normal mouse orientation aligned for a seamless exit. */
  aimAtWorldDirection(angle:number):void{
    this.mouseLookDirection=clampAngle(angle);
    followCamera.direction=this.mouseLookDirection;
    this.setTargetControl(TurretControlType.TARGET_ANGLE_WORLD,this.mouseLookDirection);
  }

  /** 2019 onMouseRelativeMovement */
  onMouseRelativeMovement(dx: number, _dy: number): void {
    this.mouseLookDirection = clampAngle(this.mouseLookDirection - dx * this.mouseSensitivity * MOUSE_SENS_MUL);
    followCamera.direction = this.mouseLookDirection;
    if (!this.lockTurretDirection) this.setTargetControl(TurretControlType.TARGET_ANGLE_WORLD, this.mouseLookDirection);
  }

  /** 2019 LOOK_AROUND (правая кнопка мыши): башня держит угол, камера осматривается */
  onLookAround(down: boolean): void {
    this.lockTurretDirection = down;
    if (followCamera.mode != CAMERA_FOLLOWS_MOUSE) return;
    if (down) this.setTargetControl(TurretControlType.TARGET_ANGLE_LOCAL, this.getDirection());
    else this.setTargetControl(TurretControlType.TARGET_ANGLE_WORLD, this.mouseLookDirection);
  }

  /** 2019 onAddToBattle: после спавна мышь смотрит туда же, куда башня */
  onAddToBattle(): void {
    if (followCamera.mode != CAMERA_FOLLOWS_MOUSE) return;
    this.mouseLookDirection = this.turretWorldDirection();
    followCamera.direction = this.mouseLookDirection;
    this.setTargetControl(TurretControlType.TARGET_ANGLE_WORLD, this.mouseLookDirection);
  }

  /** 2019 disable: выход из боя — камера снова за башней */
  disable(): void {
    this.lockTurretDirection = false;
    followCamera.mode = CAMERA_FOLLOWS_TURRET;
    this.keyState = 0;
    this.virtualControl = 0;
    this.applyControlState(0);
  }
}

// ---------------------------------------------------------------- шасси ----

export interface MovementTarget {
  setMovementParams(moveDirection: number, turnDirection: number, reverseBackTurn: boolean): void;
}

export const TankControlLockBits = {
  DEAD: 1, // §+3§ — по умолчанию шасси заблокировано, пока танк не заспавнен
  SHAFT_AIM: 4,
  BATTLE_FINISH: 2, // §>!>§ — TankModel.onBattleFinish: раунд окончен, до рестарта никто не ездит
} as const;

export class ChassisController {
  static readonly BIT_FORWARD = 0; // §4"5§
  static readonly BIT_BACK = 1; // §1!z§
  static readonly BIT_LEFT = 2; // §[!H§
  static readonly BIT_RIGHT = 3; // §!Z§
  static readonly BIT_REVERSE_BACK_TURN = 4; // §2"S§

  protected controlState = 0; // §][§
  private readonly tank: MovementTarget; // §=u§
  private lockMask = 0; // §var§

  constructor(tank: MovementTarget) {
    this.tank = tank;
    this.lockMask |= TankControlLockBits.DEAD;
  }

  isEnabled(): boolean {
    return this.lockMask == 0;
  }

  lock(bits: number): void {
    const wasEmpty = this.lockMask == 0;
    this.lockMask |= bits;
    if (wasEmpty && this.lockMask != 0) this.applyControlState(0);
  }

  unlock(bits: number): void {
    const wasEmpty = this.lockMask == 0;
    this.lockMask &= ~bits;
    if (this.lockMask == 0 && !wasEmpty) {
      this.applyControlState(this.controlState);
      this.doUnlock();
    }
  }

  getControlState(): number {
    return this.controlState;
  }

  setControlState(control: number): void {
    this.controlState = control;
    if (this.lockMask == 0) this.applyControlState(control);
  }

  protected doUnlock(): void {}

  protected isNotLocked(): boolean {
    return this.lockMask == 0;
  }

  applyControlState(control: number): void {
    const move = getBitValue(control, ChassisController.BIT_FORWARD) - getBitValue(control, ChassisController.BIT_BACK);
    const turn = getBitValue(control, ChassisController.BIT_LEFT) - getBitValue(control, ChassisController.BIT_RIGHT);
    this.tank.setMovementParams(move, turn, getBitValue(control, ChassisController.BIT_REVERSE_BACK_TURN) == 1);
  }
}

export interface ChassisControlListener {
  onChassisControlChanged(control: number): void;
}

export class LocalChassisController extends ChassisController {
  private static readonly REVERSE_BACK_TURN_MASK = 1 << ChassisController.BIT_REVERSE_BACK_TURN; // §#!3§

  private readonly listener: ChassisControlListener | null; // §^!@§
  private readonly handlers = new Map<number, (down: boolean) => number>(); // §@"6§
  private reverseBackTurnBits = 0; // §!d§

  constructor(tank: MovementTarget, keyboard: KeyboardSource, listener: ChassisControlListener | null) {
    super(tank);
    this.listener = listener;
    for (const key of [Key.UP, Key.W]) this.handlers.set(key, (down) => changeBitValue(this.controlState, ChassisController.BIT_FORWARD, down));
    for (const key of [Key.DOWN, Key.S]) this.handlers.set(key, (down) => changeBitValue(this.controlState, ChassisController.BIT_BACK, down));
    for (const key of [Key.LEFT, Key.A]) this.handlers.set(key, (down) => changeBitValue(this.controlState, ChassisController.BIT_LEFT, down));
    for (const key of [Key.RIGHT, Key.D]) this.handlers.set(key, (down) => changeBitValue(this.controlState, ChassisController.BIT_RIGHT, down));
    keyboard.addListener((keyCode, down) => this.onKey(keyCode, down));
  }

  protected override doUnlock(): void {
    this.listener?.onChassisControlChanged(this.controlState);
  }

  setReversedBackTurn(value: boolean): void {
    if (value) {
      this.reverseBackTurnBits = LocalChassisController.REVERSE_BACK_TURN_MASK;
    } else {
      this.reverseBackTurnBits = 0;
      this.controlState &= ~LocalChassisController.REVERSE_BACK_TURN_MASK;
    }
  }

  private onKey(keyCode: number, down: boolean): void {
    const handler = this.handlers.get(keyCode);
    if (handler == null) return;
    const control = handler(down) | this.reverseBackTurnBits;
    if (control != this.controlState) {
      this.setControlState(control);
      if (this.isNotLocked()) this.listener?.onChassisControlChanged(control);
    }
  }
}

// --------------------------------------------------------------- оружие ----

export class SimpleKeyboardWeaponController {
  private triggerPulled = false; // §5!m§
  private storedAction = false; // §?"D§
  /** 2019: выстрел — пробел или левая кнопка мыши при захваченной мыши (GameActionEnum.SHOT) */
  private keyDown = false;
  private mouseDown = false;

  constructor(keyboard: KeyboardSource) {
    keyboard.addListener((keyCode, down) => {
      if (keyCode != Key.SPACE) return;
      this.keyDown = down;
      this.updateTrigger();
    });
  }

  setMouseTrigger(down: boolean): void {
    this.mouseDown = down;
    this.updateTrigger();
  }

  private updateTrigger(): void {
    const down = this.keyDown || this.mouseDown;
    if (down && !this.triggerPulled) {
      this.triggerPulled = true;
      this.storedAction = true;
    } else if (!down && this.triggerPulled) {
      this.triggerPulled = false;
    }
  }

  wasActive(): boolean {
    return this.triggerPulled || this.storedAction;
  }

  isTriggerPulled(): boolean {
    return this.triggerPulled;
  }

  discardStoredAction(): void {
    this.storedAction = false;
  }
}

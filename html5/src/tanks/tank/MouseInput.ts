// Мышь в бою — по BattleInputServiceImpl клиента 2019 (Narukami).
// Отличие: Flash захватывает мышь только в полноэкранном режиме (первый клик — fullscreen, второй — mouseLock);
// в браузере Pointer Lock работает и в окне, поэтому мышь захватывается первым же кликом по сцене.

export interface MouseControlListener {
  onMouseLock(locked: boolean): void;
  onMouseRelativeMovement(dx: number, dy: number): void;
  onMouseWheel(delta: number): void;
  /** GameActionEnum.SHOT — левая кнопка при захваченной мыши */
  onShot(down: boolean): void;
  /** GameActionEnum.LOOK_AROUND — правая кнопка при захваченной мыши */
  onLookAround(down: boolean): void;
}

export class MouseInput {
  private locked = false;
  private shot = false;
  private lookAround = false;
  private dx = 0;
  private dy = 0;

  private readonly onMouseDown = (event: MouseEvent): void => {
    this.flushMotion();
    if (event.button == 0) {
      if (this.locked) this.setShot(true);
      else if (this.canLock()) this.requestLock();
    } else if (event.button == 2 && this.locked) {
      this.setLookAround(true);
    }
  };
  private readonly onMouseUp = (event: MouseEvent): void => {
    this.flushMotion();
    if (event.button == 0) this.setShot(false);
    else if (event.button == 2) this.setLookAround(false);
  };
  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    if (event.movementY * this.dy < 0) this.flushMotion();
    this.dx += event.movementX;
    this.dy += event.movementY;
  };
  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.locked || event.deltaY == 0) return;
    this.flushMotion();
    event.preventDefault();
    // Flash MouseEvent.delta: вверх — положительная, около 3 за щелчок
    this.listener.onMouseWheel(event.deltaY < 0 ? 3 : -3);
  };
  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.locked) event.preventDefault();
  };
  private readonly onLockChange = (): void => {
    const locked = document.pointerLockElement == this.element;
    if (locked == this.locked) return;
    this.locked = locked;
    if (!locked) {
      this.dx = this.dy = 0;
      this.setShot(false);
      this.setLookAround(false);
    }
    this.listener.onMouseLock(locked);
  };
  /** окно потеряло фокус — кнопки отпущены (BattleInputServiceImpl.onPlayerDeactivate) */
  private readonly onBlur = (): void => {
    this.dx = this.dy = 0;
    this.setShot(false);
    this.setLookAround(false);
  };

  constructor(
    private readonly element: HTMLElement,
    private readonly listener: MouseControlListener,
    /** settings.mouseControl и разрешение захвата (бой показан, танк в бою) */
    private readonly canLock: () => boolean,
  ) {
    element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onLockChange);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.releaseMouse();
    this.element.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    window.removeEventListener('blur', this.onBlur);
  }

  isLocked(): boolean {
    return this.locked;
  }

  flushMotion(): void {
    if (this.dx === 0 && this.dy === 0) return;
    const { dx, dy } = this;
    this.dx = this.dy = 0;
    this.listener.onMouseRelativeMovement(dx, dy);
  }

  /** BattleInputService.releaseMouse */
  releaseMouse(): void {
    if (this.locked && document.pointerLockElement == this.element) document.exitPointerLock();
  }

  private requestLock(): void {
    // Prefer raw deltas: equal physical movement gives equal aim, without OS acceleration.
    // Browsers lacking raw-input support retain normal Pointer Lock as a fallback.
    const fallback = (): void => {
      try {
        const result = this.element.requestPointerLock() as unknown;
        if (result instanceof Promise) result.catch(() => undefined);
      } catch { /* A later user click can retry after Esc or a focus change. */ }
    };
    try {
      const request = this.element.requestPointerLock as (options?: {unadjustedMovement: boolean}) => Promise<void> | void;
      const result = request.call(this.element, {unadjustedMovement: true});
      if (result instanceof Promise) result.catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'NotSupportedError') fallback();
      });
    } catch (error) {
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'NotSupportedError')) fallback();
    }
  }

  private setShot(down: boolean): void {
    if (down == this.shot) return;
    this.shot = down;
    this.listener.onShot(down);
  }

  private setLookAround(down: boolean): void {
    if (down == this.lookAround) return;
    this.lookAround = down;
    this.listener.onLookAround(down);
  }
}

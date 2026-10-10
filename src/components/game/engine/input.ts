/** Keyboard + mouse input with pointer-lock, drag-look fallback and virtual (touch) support. */
export class Input {
  private down = new Set<string>();
  private pressedFrame = new Set<string>();

  // --- Virtual (touch) input, driven by the React touch-control layer ------
  /** Analog joystick axes: x = strafe (+right), z = forward (+up on the pad). */
  virtualMove = { x: 0, z: 0 };
  /** Hold-to-dig (LMB equivalent for the touch DIG button). */
  virtualDig = false;
  /** Hold-to-use (RMB hold equivalent — jetpack thrust). Tap also sets rightClicked once. */
  virtualUseHold = false;
  /** Sprint toggle for touch (maps to ShiftLeft reads). */
  virtualSprint = false;

  /** Set both joystick axes at once (React touch handlers call this). */
  setVirtualMove(x: number, z: number): void {
    this.virtualMove.x = x;
    this.virtualMove.z = z;
  }

  setVirtualDig(v: boolean): void {
    this.virtualDig = v;
  }

  setVirtualUseHold(v: boolean): void {
    this.virtualUseHold = v;
  }

  /** Flip the touch sprint toggle; returns the new state. */
  toggleVirtualSprint(): boolean {
    this.virtualSprint = !this.virtualSprint;
    return this.virtualSprint;
  }
  private el: HTMLElement | null = null;
  private onEsc: (() => void) | null = null;

  mouseDX = 0;
  mouseDY = 0;
  leftDown = false;
  rightDown = false;
  leftClicked = false;
  rightClicked = false;
  wheelDelta = 0;
  locked = false;
  pointerLockFailed = false;

  attach(el: HTMLElement, onEsc?: () => void): () => void {
    this.el = el;
    this.onEsc = onEsc ?? null;
    const kd = (e: KeyboardEvent) => {
      if (e.repeat) {
        if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
        return;
      }
      // Let the browser handle typing in no inputs exist, but keep game keys working.
      if (['Space', 'F5', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.code === 'Escape' && !this.locked) this.onEsc?.();
      this.down.add(e.code);
      this.pressedFrame.add(e.code);
    };
    const ku = (e: KeyboardEvent) => this.down.delete(e.code);
    const blur = () => {
      this.down.clear();
      this.leftDown = false;
      this.rightDown = false;
    };
    const md = (e: MouseEvent) => {
      if (e.button === 0) {
        this.leftDown = true;
        this.leftClicked = true;
      }
      if (e.button === 2) {
        this.rightDown = true;
        this.rightClicked = true;
      }
    };
    const mu = (e: MouseEvent) => {
      if (e.button === 0) this.leftDown = false;
      if (e.button === 2) this.rightDown = false;
    };
    const mm = (e: MouseEvent) => {
      // movementX works both when pointer-locked and during normal drags
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.wheelDelta += Math.sign(e.deltaY);
    };
    const ctx = (e: Event) => e.preventDefault();

    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    el.addEventListener('mousedown', md);
    window.addEventListener('mouseup', mu);
    window.addEventListener('mousemove', mm);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', ctx);

    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      el.removeEventListener('mousedown', md);
      window.removeEventListener('mouseup', mu);
      window.removeEventListener('mousemove', mm);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', ctx);
    };
  }

  /** Try to pointer-lock; on failure the game falls back to drag-look. */
  requestLock(): void {
    if (this.locked || !this.el) return;
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          this.pointerLockFailed = true;
        });
      }
    } catch {
      this.pointerLockFailed = true;
    }
  }

  exitLock(): void {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* noop */
    }
  }

  setLocked(v: boolean): void {
    this.locked = v;
  }

  /** Raw keyboard state WITHOUT virtual mapping (for analog blending). */
  keyDown(code: string): boolean {
    return this.down.has(code);
  }

  isDown(code: string): boolean {
    // Virtual (touch) axes blend in over the keyboard state.
    if (this.virtualSprint && code === 'ShiftLeft') return true;
    if (code === 'KeyW' && this.virtualMove.z > 0.4) return true;
    if (code === 'KeyS' && this.virtualMove.z < -0.4) return true;
    if (code === 'KeyA' && this.virtualMove.x < -0.4) return true;
    if (code === 'KeyD' && this.virtualMove.x > 0.4) return true;
    return this.down.has(code);
  }

  /** Simulate a key press from a touch button (fires justPressed for one frame). */
  pressCode(code: string): void {
    this.down.add(code);
    this.pressedFrame.add(code);
  }

  /** Release a touch-held key. */
  releaseCode(code: string): void {
    this.down.delete(code);
  }

  /** Touch look: accumulate drag deltas exactly like mouse movement. */
  addLook(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  /** Touch USE tap — one-shot RMB click (place block / use item). */
  tapUse(): void {
    this.rightClicked = true;
  }

  /** Touch FIRE tap — one-shot LMB click (tank cannon / horn). */
  tapFire(): void {
    this.leftClicked = true;
  }

  justPressed(code: string): boolean {
    return this.pressedFrame.has(code);
  }

  /** Consume accumulated mouse deltas (call once per frame). */
  consumeMouse(): { dx: number; dy: number } {
    const r = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return r;
  }

  /** Call at the very end of each frame. */
  endFrame(): void {
    this.pressedFrame.clear();
    this.leftClicked = false;
    this.rightClicked = false;
    this.wheelDelta = 0;
  }
}

/**
 * Draggable divider between the charts and the right-hand column.
 *
 * The position is a fraction of the workspace width, kept in localStorage so a
 * reload does not undo the adjustment. Everything except the event wiring is a
 * pure function, which is also where the awkward parts live: clamping, a
 * storage that may throw, and a stored value that may be nonsense.
 */

export const SPLIT_KEY = "term-app.split";
export const DEFAULT_SPLIT = 4 / 6;

/** Both sides stay usable: a chart narrower than this is unreadable, and so is
 *  a terminal. */
export const MIN_SPLIT = 0.25;
export const MAX_SPLIT = 0.85;

export function clampSplit(fraction: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, fraction));
}

/** Fraction the divider should take, given where the pointer is. */
export function splitFromPointer(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return DEFAULT_SPLIT;
  return clampSplit((clientX - left) / width);
}

/**
 * Storage can throw rather than merely fail: Safari in private mode raises on
 * setItem, and a page served from a sandboxed frame raises on access. A saved
 * layout is not worth an exception on startup.
 */
export function loadSplit(storage: Pick<Storage, "getItem"> | null): number {
  try {
    const raw = storage?.getItem(SPLIT_KEY);
    if (!raw) return DEFAULT_SPLIT;
    return clampSplit(Number.parseFloat(raw));
  } catch {
    return DEFAULT_SPLIT;
  }
}

export function saveSplit(storage: Pick<Storage, "setItem"> | null, fraction: number): void {
  try {
    storage?.setItem(SPLIT_KEY, clampSplit(fraction).toFixed(4));
  } catch {
    /* Not worth surfacing: the layout simply will not persist. */
  }
}

export interface SplitterElements {
  workspace: HTMLElement;
  handle: HTMLElement;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

export class Splitter {
  private fraction: number;

  /** Called after every change, so the charts can re-measure. */
  onChange: () => void = () => {};

  constructor(private readonly el: SplitterElements) {
    this.fraction = loadSplit(el.storage ?? null);
    this.apply();
    this.bind();
  }

  private apply(): void {
    this.el.workspace.style.setProperty("--split", `${(this.fraction * 100).toFixed(3)}%`);
  }

  private set(fraction: number, persist: boolean): void {
    this.fraction = clampSplit(fraction);
    this.apply();
    if (persist) saveSplit(this.el.storage ?? null, this.fraction);
    this.onChange();
  }

  private bind(): void {
    const { handle, workspace } = this.el;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      handle.classList.add("dragging");

      const move = (ev: PointerEvent) => {
        const rect = workspace.getBoundingClientRect();
        // Not persisted per move: a drag fires these by the hundred.
        this.set(splitFromPointer(ev.clientX, rect.left, rect.width), false);
      };
      const up = () => {
        handle.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        saveSplit(this.el.storage ?? null, this.fraction);
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });

    handle.addEventListener("dblclick", () => this.set(DEFAULT_SPLIT, true));

    // Keyboard: the divider is focusable, so it should not be mouse-only.
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === "ArrowLeft") this.set(this.fraction - step, true);
      else if (e.key === "ArrowRight") this.set(this.fraction + step, true);
      else if (e.key === "Home") this.set(DEFAULT_SPLIT, true);
      else return;
      e.preventDefault();
    });
  }

  get value(): number { return this.fraction; }
}

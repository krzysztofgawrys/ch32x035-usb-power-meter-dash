/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SPLIT, MAX_SPLIT, MIN_SPLIT, SPLIT_KEY, Splitter,
  clampSplit, loadSplit, saveSplit, splitFromPointer,
} from "./splitter.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

/** Storage that throws, as Safari's does in private mode. */
const hostileStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem() { throw new DOMException("denied"); },
  setItem() { throw new DOMException("denied"); },
};

describe("clampSplit", () => {
  it("keeps both sides usable", () => {
    expect(clampSplit(0.01)).toBe(MIN_SPLIT);
    expect(clampSplit(0.99)).toBe(MAX_SPLIT);
    expect(clampSplit(0.5)).toBe(0.5);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampSplit(NaN)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Infinity)).toBe(DEFAULT_SPLIT);
  });
});

describe("splitFromPointer", () => {
  it("maps a pointer position to a fraction of the container", () => {
    expect(splitFromPointer(500, 0, 1000)).toBeCloseTo(0.5, 9);
    expect(splitFromPointer(700, 200, 1000)).toBeCloseTo(0.5, 9);
  });

  it("clamps a pointer dragged past either edge", () => {
    expect(splitFromPointer(-500, 0, 1000)).toBe(MIN_SPLIT);
    expect(splitFromPointer(5000, 0, 1000)).toBe(MAX_SPLIT);
  });

  it("survives a container with no width, which happens before layout", () => {
    expect(splitFromPointer(100, 0, 0)).toBe(DEFAULT_SPLIT);
  });
});

describe("persistence", () => {
  it("round-trips through storage", () => {
    const store = memoryStorage();
    saveSplit(store, 0.42);
    expect(loadSplit(store)).toBeCloseTo(0.42, 4);
  });

  it("clamps a stored value that is out of range", () => {
    const store = memoryStorage();
    store.map.set(SPLIT_KEY, "0.99");
    expect(loadSplit(store)).toBe(MAX_SPLIT);
  });

  it("ignores stored junk", () => {
    const store = memoryStorage();
    store.map.set(SPLIT_KEY, "banana");
    expect(loadSplit(store)).toBe(DEFAULT_SPLIT);
  });

  it("defaults when nothing was ever stored", () => {
    expect(loadSplit(memoryStorage())).toBe(DEFAULT_SPLIT);
    expect(loadSplit(null)).toBe(DEFAULT_SPLIT);
  });

  /** Storage can throw outright, not merely fail; startup must not die for it. */
  it("survives a storage that throws on both reads and writes", () => {
    expect(loadSplit(hostileStorage)).toBe(DEFAULT_SPLIT);
    expect(() => saveSplit(hostileStorage, 0.5)).not.toThrow();
  });
});

describe("Splitter", () => {
  let workspace: HTMLElement;
  let handle: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div class="workspace"><div id="h"></div></div>';
    workspace = document.querySelector(".workspace") as HTMLElement;
    handle = document.getElementById("h") as HTMLElement;
    workspace.getBoundingClientRect = () =>
      ({ width: 1000, left: 0, right: 1000, top: 0, bottom: 600, height: 600, x: 0, y: 0, toJSON: () => ({}) });
  });

  it("applies the stored fraction on construction", () => {
    const store = memoryStorage();
    store.map.set(SPLIT_KEY, "0.4");
    new Splitter({ workspace, handle, storage: store });
    expect(workspace.style.getPropertyValue("--split")).toBe("40.000%");
  });

  it("follows a drag and saves once it ends", () => {
    const store = memoryStorage();
    const s = new Splitter({ workspace, handle, storage: store });

    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 666, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 300, pointerId: 1, bubbles: true }));
    // Mid-drag the value moves but nothing is written: a drag fires hundreds.
    expect(s.value).toBeCloseTo(0.3, 6);
    expect(store.map.has(SPLIT_KEY)).toBe(false);

    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    expect(loadSplit(store)).toBeCloseTo(0.3, 4);
  });

  it("ignores a drag with anything but the left button", () => {
    const s = new Splitter({ workspace, handle, storage: memoryStorage() });
    handle.dispatchEvent(new PointerEvent("pointerdown", { button: 1, clientX: 100, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, pointerId: 1, bubbles: true }));
    expect(s.value).toBe(DEFAULT_SPLIT);
  });

  it("resets on double click", () => {
    const store = memoryStorage();
    store.map.set(SPLIT_KEY, "0.3");
    const s = new Splitter({ workspace, handle, storage: store });
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(s.value).toBe(DEFAULT_SPLIT);
    expect(loadSplit(store)).toBeCloseTo(DEFAULT_SPLIT, 4);
  });

  it("nudges with the arrow keys, so it is not mouse-only", () => {
    const s = new Splitter({ workspace, handle, storage: memoryStorage() });
    const before = s.value;
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(s.value).toBeCloseTo(before - 0.02, 6);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    expect(s.value).toBeCloseTo(before + 0.08, 6);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(s.value).toBe(DEFAULT_SPLIT);
  });

  it("notifies the owner so the charts can re-measure", () => {
    const s = new Splitter({ workspace, handle, storage: memoryStorage() });
    let calls = 0;
    s.onChange = () => { calls++; };
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(calls).toBe(1);
  });
});

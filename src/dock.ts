/**
 * Panel layout: which panes exist, where they sit, and how that survives a
 * reload.
 *
 * Built on dockview-core, used as a plain layout widget - there is no React or
 * Vue here and the rest of the app is untouched by it. It replaces a
 * hand-rolled two-pane splitter, which could only ever draw one line down the
 * middle: this gives arbitrary nesting, tab groups, panels floating over the
 * layout, and panels popped out into separate browser windows.
 *
 * Panels do not own their content. Each one adopts an element built elsewhere
 * and hands it back untouched on dispose, so dragging a chart across the
 * layout re-parents a live uPlot instead of rebuilding it - the view, the
 * zoom and the cursor all survive the move.
 */

import {
  createDockview,
  type DockviewApi,
  type IContentRenderer,
  type IDockviewPanel,
} from "dockview-core";

export const LAYOUT_KEY = "term-app.layout";

export interface PanelSpec {
  id: string;
  title: string;
  /** The element this panel shows. Created once, re-parented as needed. */
  element: HTMLElement;
  /**
   * Size limits, reapplied whenever the panel is reopened. Without them a
   * panel that was closed and shown again comes back at the default size,
   * which for a one-line strip means a mostly empty box.
   */
  constraints?: {
    minimumHeight?: number;
    maximumHeight?: number;
    minimumWidth?: number;
    maximumWidth?: number;
  };
  /**
   * A one-line bar rather than a view: gets a group to itself and keeps the
   * height in `constraints`.
   *
   * It keeps its tab bar, shrunk by CSS rather than removed. Hiding it
   * outright reclaims the 28px, but the tab bar is also the drag handle -
   * dockview offers no other one for a docked group, `dragHandle` applies
   * only to floating ones - so a headerless strip cannot be moved at all.
   */
  strip?: boolean;
  /** Width a strip opens at. Only a starting point; the user can resize it. */
  initialWidth?: number;
  /**
   * Whether the panel may be closed. Defaults to true.
   *
   * The toolbar is false, because it carries the menu every other panel is
   * reopened from - closing it would leave no way back short of clearing
   * localStorage. dockview has no option for this, so the tab's close button
   * is hidden in CSS and hide()/toggle() refuse here; both are needed, since
   * either alone leaves a route to a dead end.
   */
  closable?: boolean;
}

type Edge = "above" | "below" | "left" | "right";

export type StripPlacement =
  | { direction: Edge }
  | { referencePanel: string; direction: Edge };

/**
 * Adds a panel in a group of its own, at a fixed height.
 *
 * Used by show(), so a strip reopened from the menu comes back looking the
 * way the default layout has it: alone in its group, at its pinned height.
 *
 * The two api.addGroup calls are one call logically; they are written out
 * because the placement is a union and spreading it does not narrow, and
 * because `exactOptionalPropertyTypes` rejects handing an optional property
 * an explicit undefined.
 */
export function addStripPanel(api: DockviewApi, spec: PanelSpec, at: StripPlacement): void {
  // The height is the group's, tab bar included - hence the compact header
  // for these groups in style.css.
  const base = {
    ...(spec.constraints ? { constraints: spec.constraints } : {}),
    ...(spec.constraints?.minimumHeight !== undefined
      ? { initialHeight: spec.constraints.minimumHeight }
      : {}),
    ...(spec.initialWidth !== undefined ? { initialWidth: spec.initialWidth } : {}),
  };

  const group = "referencePanel" in at
    ? api.addGroup({ ...base, referencePanel: at.referencePanel, direction: at.direction })
    : api.addGroup({ ...base, direction: at.direction });

  api.addPanel({
    id: spec.id, component: spec.id, title: spec.title,
    inactive: true, position: { referenceGroup: group },
  });
}

/** Where each panel goes the first time, and after a reset. */
export interface DefaultLayout {
  (api: DockviewApi): void;
}

export interface DockOptions {
  host: HTMLElement;
  panels: readonly PanelSpec[];
  defaultLayout: DefaultLayout;
  /**
   * Panels that should start out the same height as each other.
   *
   * Applied only when the layout comes from the default, never afterwards -
   * a height the user dragged is a decision, and re-levelling it would undo
   * their work every time the window changed.
   */
  equalHeight?: readonly string[];
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

export class Dock {
  readonly api: DockviewApi;
  private readonly specs = new Map<string, PanelSpec>();
  private saveTimer = 0;
  /** True when this session started from the default rather than a saved layout. */
  private usedDefault = false;

  /** Called after any change to which panels are open. */
  onVisibilityChange: () => void = () => {};

  constructor(private readonly opts: DockOptions) {
    for (const p of opts.panels) this.specs.set(p.id, p);

    this.api = createDockview(opts.host, {
      createComponent: (options) => this.renderer(options.id),
      // Keeps a floated panel reachable: dragged past the edge it would
      // otherwise be stranded off-screen with no way back short of a reset.
      floatingGroupBounds: "boundedWithinViewport",
    });

    // Subscribed before the layout is built, so it sees every panel including
    // the ones restore() and reset() are about to create.
    this.api.onDidAddPanel((panel) => {
      this.pin(panel, true);
      panel.api.onDidGroupChange(() => this.pin(panel, true));
      // Dragging a sash resizes panels without changing the layout's shape,
      // and onDidLayoutChange does not fire for it - it reports structure, not
      // geometry. Without this a column narrowed by hand was never written
      // down, and the next reload brought back the width before the drag.
      panel.api.onDidDimensionsChange(() => this.scheduleSave());
    });

    this.usedDefault = !this.restore();
    if (this.usedDefault) this.reset();

    /*
     * Nothing above this point knows how big the dock is: dockview learns its
     * size from a resize observation, which lands after the constructor has
     * returned. So the first honest moment to pin heights - and to persist
     * anything - is the first observation with a real size.
     */
    const settle = new ResizeObserver(() => {
      if (!(this.api.width > 0 && this.api.height > 0)) return;
      settle.disconnect();
      this.pinAll(true);
      // Only for a fresh default: a restored layout carries heights the user
      // chose, and levelling them here would throw that away on every load.
      if (this.usedDefault) this.equalise();
      this.save();
    });
    settle.observe(opts.host);

    // A group's id can come back on a later layout; its old verdict must not.
    this.api.onDidRemoveGroup((group) => this.pinned.delete(group.id));

    this.api.onDidLayoutChange(() => {
      // No resize here: this also fires while a sash is being dragged, and
      // forcing a height mid-drag would fight the pointer. It is here to
      // release the limits if something else joins a strip's group.
      this.pinAll(false);
      this.scheduleSave();
      this.onVisibilityChange();
    });
  }

  /**
   * Adapts a panel spec to dockview's renderer contract.
   *
   * `element` is the content element itself rather than a wrapper, and
   * `dispose` deliberately does nothing: the element belongs to whoever built
   * it and will be adopted again when the panel reopens.
   */
  private renderer(id: string): IContentRenderer {
    const spec = this.specs.get(id);
    const element = spec?.element ?? document.createElement("div");
    if (!spec) element.textContent = `unknown panel: ${id}`;
    return { element, init: () => {} };
  }

  /**
   * Holds the one-line panels to their height.
   *
   * Size limits belong to the GROUP, not the panel, and they are arguments to
   * addGroup rather than layout state. Every way a panel can arrive in a group
   * therefore has to reapply them, and each was found as its own bug:
   *
   *   - built by the default layout        (from the serialized constant)
   *   - reopened from the Panels menu      (show -> addStripPanel)
   *   - restored from localStorage         (toJSON does not carry them)
   *   - DRAGGED SOMEWHERE ELSE             (docking creates a brand new group)
   *
   * The last one is why this is wired to events rather than called at startup:
   * a dragged strip landed in a fresh, unconstrained group and sprang open to
   * a third of the window.
   *
   * `resize` is only for arrivals. Calling setSize on every layout change
   * would fight the user mid-drag, and the memo below keeps setConstraints
   * from running in circles.
   */
  private readonly pinned = new Map<string, string>();

  private pin(panel: IDockviewPanel, resize: boolean): void {
    // Nothing to pin against until the grid knows its own size; the resize
    // observation that gives it one runs pinAll again.
    if (!(this.api.width > 0 && this.api.height > 0)) return;
    const spec = this.specs.get(panel.id);
    if (!spec?.constraints) return;

    // Only while the strip is alone in its group. Tabbed together with a
    // chart, a 44px ceiling would apply to the chart too.
    const alone = panel.group.panels.length === 1;
    const want = alone ? JSON.stringify(spec.constraints) : "free";
    if (this.pinned.get(panel.group.id) === want) return;
    this.pinned.set(panel.group.id, want);

    if (!alone) {
      panel.group.api.setConstraints({ minimumHeight: 0, maximumHeight: Number.MAX_SAFE_INTEGER });
      return;
    }
    panel.group.api.setConstraints(spec.constraints);
    const height = spec.constraints.minimumHeight;
    if (resize && height !== undefined) panel.group.api.setSize({ height });
  }

  /**
   * Shares the charts' space out evenly between them.
   *
   * Deliberately expressed as "divide what these already occupy", not "take
   * the window, subtract the strips, divide by four". The two give the same
   * answer while the charts are stacked together, and the first keeps giving
   * a sensible one after a panel is closed, popped out, or dragged elsewhere
   * - it never has to know what else is on screen.
   */
  private equalise(): void {
    const ids = this.opts.equalHeight ?? [];
    if (ids.length < 2 || !(this.api.height > 0)) return;

    const groups = ids
      .map((id) => this.api.getPanel(id)?.group)
      .filter((g): g is NonNullable<typeof g> => !!g);
    // Only when each one is alone in its own group and they are all open;
    // anything else and "equal height" no longer means what it says.
    if (groups.length !== ids.length) return;
    if (new Set(groups.map((g) => g.id)).size !== groups.length) return;
    if (groups.some((g) => g.panels.length !== 1)) return;

    const total = groups.reduce((sum, g) => sum + g.api.height, 0);
    const each = Math.floor(total / groups.length);
    if (each < 1) return;
    for (const g of groups) g.api.setSize({ height: each });
  }

  private pinAll(resize: boolean): void {
    for (const spec of this.specs.values()) {
      if (!spec.constraints) continue;
      const panel = this.api.getPanel(spec.id);
      if (panel) this.pin(panel, resize);
    }
  }

  get openPanels(): string[] {
    return this.api.panels.map((p) => p.id);
  }

  isOpen(id: string): boolean {
    return this.api.getPanel(id) !== undefined;
  }

  /** Adds a closed panel back, or focuses it if it is already open. */
  show(id: string): void {
    const existing = this.api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const spec = this.specs.get(id);
    if (!spec) return;
    if (spec.strip) addStripPanel(this.api, spec, { direction: "above" });
    else this.api.addPanel({ id, component: id, title: spec.title, ...spec.constraints });
  }

  /** False for panels that must always be on screen; see PanelSpec.closable. */
  closable(id: string): boolean {
    return this.specs.get(id)?.closable !== false;
  }

  hide(id: string): void {
    if (!this.closable(id)) return;
    const panel = this.api.getPanel(id);
    if (panel) this.api.removePanel(panel);
  }

  toggle(id: string): void {
    if (this.isOpen(id)) this.hide(id);
    else this.show(id);
  }

  /** Floats the panel over the layout, adding it first if it was closed. */
  float(id: string): void {
    this.show(id);
    const panel = this.api.getPanel(id);
    if (panel) this.api.addFloatingGroup(panel, { width: 520, height: 320 });
  }

  /** Opens the panel in a separate browser window. */
  async popout(id: string): Promise<void> {
    this.show(id);
    const panel = this.api.getPanel(id);
    if (panel) await this.api.addPopoutGroup(panel);
  }

  /** Back to the layout the app ships with, discarding what was stored. */
  reset(): void {
    for (const panel of [...this.api.panels]) this.api.removePanel(panel);
    this.opts.defaultLayout(this.api);
    // Group ids come out of the serialized default, so every reset recreates
    // the same ones and the memo would wave them through as already pinned.
    // Without the limits dockview falls back to its own minimum group height,
    // which is well above a one-line strip - that is the growth.
    this.pinned.clear();
    this.pinAll(true);
    this.equalise();
    // The default is the last line of defence, so a mistake in it has nowhere
    // to fall back to - it has to be noisy instead. This fires when a panel is
    // renamed and src/default-layout.ts is not updated with it.
    const unknown = this.unknownPanels();
    if (unknown.length) {
      console.error(`dock: the default layout names panels that do not exist: ${unknown.join(", ")}`);
    }
    this.save();
  }

  /** Ids present in the layout that the app does not define. */
  private unknownPanels(): string[] {
    return this.api.panels.map((p) => p.id).filter((id) => !this.specs.has(id));
  }

  /**
   * Layout changes arrive in bursts while a panel is being dragged. Writing
   * on every one of them would hit localStorage hundreds of times per drag.
   */
  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 250) as unknown as number;
  }

  private save(): void {
    // Sizes in the serialized grid are absolute pixels measured against the
    // grid's own width and height, and restoring scales from those. Until
    // dockview has taken its first resize observation - which is async, so
    // not before the constructor returns - it believes it is 0x0. Saving then
    // persists a layout whose every size is relative to nothing, and the next
    // reload lays the panels out at whatever that scales to. That is what made
    // the right-hand column come back the wrong width.
    if (!(this.api.width > 0 && this.api.height > 0)) return;
    try {
      this.opts.storage?.setItem(LAYOUT_KEY, JSON.stringify(this.api.toJSON()));
    } catch {
      /* Not worth surfacing: the layout simply will not persist. */
    }
  }

  /**
   * Returns false if there was nothing usable to restore.
   *
   * A stored layout is the one piece of state that can brick the whole app:
   * it is written by one version and read by the next, and a panel id that no
   * longer exists, or a half-written string, makes fromJSON throw during
   * startup - leaving a blank page and no obvious way back. So it is treated
   * as untrusted input, and anything that goes wrong falls through to the
   * default layout with the bad copy discarded.
   */
  private restore(): boolean {
    let raw: string | null = null;
    try {
      raw = this.opts.storage?.getItem(LAYOUT_KEY) ?? null;
    } catch {
      return false;
    }
    if (!raw) return false;

    try {
      this.api.fromJSON(JSON.parse(raw));
      // An empty layout is as unusable as a broken one, and it is what a
      // half-finished write leaves behind.
      if (this.api.panels.length === 0) throw new Error("layout has no panels");
      // A panel the app no longer defines renders as a placeholder the user
      // cannot get rid of. Renaming one id is enough to cause it, so an
      // unrecognised id condemns the whole stored layout rather than leaving
      // a dead panel wedged in it - which conveniently makes a rename reset
      // everyone's layout instead of half-breaking it.
      const unknown = this.unknownPanels();
      if (unknown.length) throw new Error(`unknown panels: ${unknown.join(", ")}`);
      return true;
    } catch (err) {
      console.warn("dock: stored layout rejected, falling back to the default", err);
      try {
        this.opts.storage?.removeItem(LAYOUT_KEY);
      } catch { /* nothing to do */ }
      this.api.clear();
      return false;
    }
  }
}

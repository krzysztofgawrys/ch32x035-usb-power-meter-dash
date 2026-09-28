/**
 * The arrangement the app opens with, and what "Reset layout" goes back to.
 *
 * Held as a serialized layout rather than built with addPanel calls. Both work,
 * but a hand-built one only approximates an arrangement someone actually
 * wanted: the call order decides which cell each split carves up, the sizes
 * have to be guessed, and getting it wrong is silent - see the note on
 * addPanel splitting cells, not columns. This is a layout that was dragged
 * into shape in the browser and read back out of localStorage, so it is exact.
 *
 * To change it: arrange the panels, copy `term-app.layout` out of
 * localStorage, paste it here, and drop any ids the app no longer defines.
 *
 * Sizes are pixels against the `width` and `height` below; dockview scales
 * them to whatever the window really is, so the numbers are proportions in
 * disguise and do not need touching for a different screen.
 */

import type { SerializedDockview } from "dockview-core";

export const DEFAULT_LAYOUT: SerializedDockview = {
  grid: {
    root: {
      type: "branch",
      data: [
        // Left column: the figures strip, then the four charts at one quarter
        // each of what is left (1242 - 54 = 1188). Dock.equalise() redoes this
        // against the real window, but starting level means the first paint
        // does not jump.
        {
          type: "branch",
          data: [
            { type: "leaf", data: { views: ["stats"], activeView: "stats", id: "16" }, size: 54 },
            { type: "leaf", data: { views: ["v"], activeView: "v", id: "10" }, size: 297 },
            { type: "leaf", data: { views: ["i"], activeView: "i", id: "13" }, size: 297 },
            { type: "leaf", data: { views: ["p"], activeView: "p", id: "14" }, size: 297 },
            { type: "leaf", data: { views: ["s"], activeView: "s", id: "15" }, size: 297 },
          ],
          size: 1608,
        },
        // Right column: both toolbars above the device panes.
        {
          type: "branch",
          data: [
            { type: "leaf", data: { views: ["toolbar"], activeView: "toolbar", id: "11" }, size: 54 },
            { type: "leaf", data: { views: ["connect"], activeView: "connect", id: "21" }, size: 54 },
            { type: "leaf", data: { views: ["controls"], activeView: "controls", id: "20" }, size: 567 },
            { type: "leaf", data: { views: ["terminal"], activeView: "terminal", id: "22" }, size: 567 },
          ],
          size: 952,
        },
      ],
      size: 1242,
    },
    width: 2560,
    height: 1242,
    orientation: "HORIZONTAL" as SerializedDockview["grid"]["orientation"],
  },
  panels: {
    v: { id: "v", contentComponent: "v", title: "Voltage" },
    i: { id: "i", contentComponent: "i", title: "Current" },
    p: { id: "p", contentComponent: "p", title: "Power" },
    s: { id: "s", contentComponent: "s", title: "V shunt" },
    stats: { id: "stats", contentComponent: "stats", title: "Statistics" },
    toolbar: { id: "toolbar", contentComponent: "toolbar", title: "Toolbar" },
    connect: { id: "connect", contentComponent: "connect", title: "Connect" },
    controls: { id: "controls", contentComponent: "controls", title: "Controls" },
    terminal: { id: "terminal", contentComponent: "terminal", title: "Terminal" },
  },
  activeGroup: "22",
};

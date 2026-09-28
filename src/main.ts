/** Wiring: DOM controls, serial session, sample extraction, terminal, charts. */

import "./dockview.css";
import "./style.css";

import { ChartPanel } from "./charts.js";
import { METRICS } from "./store.js";
import { commandSequence, streamEffect } from "./commands.js";
import { ControlPanel } from "./control.js";
import { confirmDialog } from "./dialog.js";
import { QUERY_COMMANDS, parseSetting, refreshFor } from "./settings.js";
import { DEFAULT_LAYOUT } from "./default-layout.js";
import { Dock, type PanelSpec } from "./dock.js";
import { SampleScanner } from "./parse.js";
import { SerialSession, isSerialSupported, portLabel, type LogKind, type SerialConfig } from "./serial.js";
import { TerminalView, type ViewMode } from "./terminal.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

/**
 * Panel bodies live in <template> in the markup, so their ids stay declared in
 * one place instead of being built in JavaScript. Cloning happens once, at
 * startup, before anything looks those ids up - the dock only ever moves the
 * resulting element around.
 */
/**
 * Somewhere for a clone to wait until a panel adopts it.
 *
 * It has to be in the document, or getElementById cannot find the ids inside
 * it. It must not be in the page flow: parked as plain children of <body>,
 * which is a flex column, the four panel bodies took real space and the dock
 * measured itself against what was left.
 */
const holding = document.createElement("div");
holding.hidden = true;
document.body.appendChild(holding);

function fromTemplate(id: string): HTMLElement {
  const tpl = document.getElementById(id);
  if (!(tpl instanceof HTMLTemplateElement)) throw new Error(`missing template #${id}`);
  const node = tpl.content.firstElementChild?.cloneNode(true);
  if (!(node instanceof HTMLElement)) throw new Error(`empty template #${id}`);
  holding.appendChild(node);
  return node;
}

const panelBody = {
  stats: fromTemplate("tpl-view"),
  toolbar: fromTemplate("tpl-toolbar"),
  connect: fromTemplate("tpl-connect"),
  controls: fromTemplate("tpl-controls"),
  terminal: fromTemplate("tpl-terminal"),
};

const el = {
  output: $<HTMLElement>("output"),
  paneControl: $<HTMLElement>("pane-control"),
  dock: $<HTMLElement>("dock"),
  viewMenuBtn: $<HTMLButtonElement>("btn-view-menu"),
  viewMenuGroup: $<HTMLElement>("view-menu-group"),
  resetLayout: $<HTMLButtonElement>("btn-reset-layout"),
  connect: $<HTMLButtonElement>("btn-connect"),
  disconnect: $<HTMLButtonElement>("btn-disconnect"),
  knownPorts: $<HTMLSelectElement>("known-ports"),
  forget: $<HTMLButtonElement>("btn-forget"),

  chartWindow: $<HTMLSelectElement>("chart-window"),
  chartZero: $<HTMLInputElement>("chart-zero"),
  optEcho: $<HTMLInputElement>("opt-echo"),
  optAcc: $<HTMLInputElement>("opt-acc"),
  clearCharts: $<HTMLButtonElement>("btn-clear-charts"),
  saveCsv: $<HTMLButtonElement>("btn-save-csv"),
  liveBtn: $<HTMLButtonElement>("btn-live"),
  viewSpan: $<HTMLElement>("view-span"),
  viewCovered: $<HTMLElement>("view-covered"),
  viewSamples: $<HTMLElement>("view-samples"),
  viewAvgCurrent: $<HTMLElement>("view-avg-i"),
  viewCharge: $<HTMLElement>("view-charge"),
  viewAvgPower: $<HTMLElement>("view-avg-p"),
  viewEnergy: $<HTMLElement>("view-energy"),
  viewTotalCharge: $<HTMLElement>("view-total-charge"),
  viewTotalEnergy: $<HTMLElement>("view-total-energy"),
  accBackwards: $<HTMLElement>("acc-backwards"),
  accBackwardsN: $<HTMLElement>("acc-backwards-n"),

  mode: $<HTMLSelectElement>("mode"),
  optTs: $<HTMLInputElement>("opt-ts"),
  optScroll: $<HTMLInputElement>("opt-scroll"),
  optWrap: $<HTMLInputElement>("opt-wrap"),
  sendEol: $<HTMLSelectElement>("send-eol"),
  pause: $<HTMLButtonElement>("btn-pause"),
  clear: $<HTMLButtonElement>("btn-clear"),
  saveTxt: $<HTMLButtonElement>("btn-save-txt"),
  saveBin: $<HTMLButtonElement>("btn-save-bin"),

  statState: $<HTMLElement>("stat-state"),
  statPort: $<HTMLElement>("stat-port"),
  statRx: $<HTMLElement>("stat-rx"),
  statTx: $<HTMLElement>("stat-tx"),
  statSamples: $<HTMLElement>("stat-samples"),
  statRate: $<HTMLElement>("stat-rate"),
  statMangled: $<HTMLElement>("stat-mangled"),
  statMangledN: $<HTMLElement>("stat-mangled-n"),
  statBuf: $<HTMLElement>("stat-buf"),
  unsupported: $<HTMLElement>("unsupported"),
};

const term = new TerminalView(el.output);
const control = new ControlPanel(el.paneControl);

const charts = new ChartPanel({
  windowSelect: el.chartWindow,
  zeroCheck: el.chartZero,
  countEl: el.statSamples,
  liveBtn: el.liveBtn,
  viewSpan: el.viewSpan,
  viewCovered: el.viewCovered,
  viewSamples: el.viewSamples,
  viewAvgCurrent: el.viewAvgCurrent,
  viewCharge: el.viewCharge,
  viewAvgPower: el.viewAvgPower,
  viewEnergy: el.viewEnergy,
  viewTotalCharge: el.viewTotalCharge,
  viewTotalEnergy: el.viewTotalEnergy,
  accBackwards: el.accBackwards,
  accBackwardsN: el.accBackwardsN,
});

/*
 * Height of the one-line panels, tab bar included: an 18px compact header
 * (see .dv-groupview:has in style.css) over 36px of content, which is what a
 * 28px button with 4px padding needs.
 *
 * One number for all three rather than a snug fit each, because Statistics
 * and Window share a row and a row has a single height - a 44px ceiling on
 * one and 54px on the other is unsatisfiable, and what gives is the taller
 * one's buttons. Statistics gains a few pixels of breathing room it does not
 * need; that is the price of them sitting side by side.
 *
 * Minimum and maximum are pinned to the same number so a stray drag cannot
 * turn one into a half-empty box. The header stays because it is the only
 * thing dockview lets you drag a docked group by.
 */
const STRIP_HEIGHT = 54;

/**
 * The eight dockable panels.
 *
 * Every chart is its own panel rather than one "Charts" pane, which is the
 * point of the exercise: any one of them can be given the whole width, tabbed
 * behind another, or popped out onto a second monitor while the rest stay put.
 */
const PANELS: readonly PanelSpec[] = [
  ...METRICS.map((m) => ({
    id: m.key,
    title: m.title,
    element: charts.chartElement(m.key)!,
  })),
  { id: "stats", title: "Statistics", element: panelBody.stats, strip: true,
    constraints: { minimumHeight: STRIP_HEIGHT, maximumHeight: STRIP_HEIGHT } },
  // Not closable: it carries the Panels menu, so closing it would remove the
  // only way to bring anything back.
  { id: "toolbar", title: "Toolbar", element: panelBody.toolbar, strip: true,
    closable: false,
    constraints: { minimumHeight: STRIP_HEIGHT, maximumHeight: STRIP_HEIGHT } },
  { id: "connect", title: "Connect", element: panelBody.connect, strip: true,
    constraints: { minimumHeight: STRIP_HEIGHT, maximumHeight: STRIP_HEIGHT } },
  { id: "controls", title: "Controls", element: panelBody.controls },
  { id: "terminal", title: "Terminal", element: panelBody.terminal },
];



const dock = new Dock({
  host: el.dock,
  panels: PANELS,
  storage: globalThis.localStorage,
  defaultLayout: (api) => api.fromJSON(DEFAULT_LAYOUT),
  // The four charts share whatever the strips leave, evenly - until the user
  // drags one, which is then left alone.
  equalHeight: METRICS.map((m) => m.key),
});

/**
 * Show/hide menu for the panels.
 *
 * Closing a panel destroys nothing - the element goes back to whoever owns it
 * and returns intact - so this is genuinely a visibility control. It matters
 * most for "View": that strip is the only place charge and energy appear, and
 * without a way back a closed one would look like data loss.
 */
function buildViewMenu(): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "view-menu hidden";

  for (const spec of PANELS) {
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset["panel"] = spec.id;
    box.addEventListener("change", () => dock.toggle(spec.id));

    // A panel that cannot be closed still gets a row - it belongs in the
    // list - but the box is fixed on and says why.
    if (!dock.closable(spec.id)) {
      box.disabled = true;
      row.title = `${spec.title} is always open`;
    }

    const name = document.createElement("span");
    name.textContent = spec.title;

    const pop = document.createElement("button");
    pop.type = "button";
    pop.className = "popout";
    pop.textContent = "↗";
    pop.title = `Open ${spec.title} in a separate window`;
    pop.addEventListener("click", (e) => {
      e.preventDefault();
      void dock.popout(spec.id);
    });

    row.append(box, name, pop);
    menu.appendChild(row);
  }

  /*
   * Parked on <body>, not inside the toolbar.
   *
   * The toolbar is a 54px panel with its overflow clipped, so a dropdown
   * anchored inside it would be cut off at the first row. Fixed positioning
   * from the button's own rectangle escapes that, and escapes any transform
   * dockview puts on the panel too.
   */
  document.body.appendChild(menu);
  return menu;
}

const viewMenu = buildViewMenu();

function syncViewMenu(): void {
  for (const box of viewMenu.querySelectorAll<HTMLInputElement>("input[data-panel]")) {
    box.checked = dock.isOpen(box.dataset["panel"]!);
  }
}

dock.onVisibilityChange = syncViewMenu;
syncViewMenu();

function placeViewMenu(): void {
  const r = el.viewMenuBtn.getBoundingClientRect();
  viewMenu.style.top = `${Math.round(r.bottom + 4)}px`;
  // Right-aligned to the button, nudged back inside if that would overflow.
  const width = viewMenu.offsetWidth || 190;
  viewMenu.style.left = `${Math.round(Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)))}px`;
}

function setViewMenuOpen(open: boolean): void {
  viewMenu.classList.toggle("hidden", !open);
  el.viewMenuBtn.setAttribute("aria-expanded", String(open));
  if (!open) return;
  syncViewMenu();
  placeViewMenu();
}

el.viewMenuBtn.addEventListener("click", () => {
  setViewMenuOpen(viewMenu.classList.contains("hidden"));
});

// The toolbar can be dragged anywhere, so a menu positioned once would end up
// detached from its button.
addEventListener("resize", () => {
  if (!viewMenu.classList.contains("hidden")) placeViewMenu();
});

// Click anywhere else closes it; the menu is a popover, not a mode.
document.addEventListener("pointerdown", (e) => {
  if (viewMenu.classList.contains("hidden")) return;
  const target = e.target as Node;
  if (el.viewMenuGroup.contains(target) || viewMenu.contains(target)) return;
  setViewMenuOpen(false);
});

el.resetLayout.addEventListener("click", () => {
  dock.reset();
  syncViewMenu();
});

/**
 * Web Serial gives no product name, only USB ids. The device introduces itself
 * on connect ("USBpm 1.0.199 - type 'help'"), so the first line it prints is a
 * far better label than a hex pair - and it is the only real name available.
 */
let deviceName: string | null = null;
let portLabelText = "";

const scanner = new SampleScanner(
  (t, v, i, p, s) => {
    // Samples arriving is the ground truth for "the stream is running".
    lastSampleAt = Date.now();
    if (!streaming) setStreaming(true);
    charts.add(t, v, i, p, s);
  },
  (t, acc) => {
    charts.addAcc(t, acc.charge, acc.energy);
  },
  (line) => {
    applySettings(line);
    if (deviceName || !serial.isOpen) return;
    const text = line.replace(/^[\s>]+/, "").trim();
    // Skip a bare prompt or a command echo; take the first line with substance.
    if (text.length < 3) return;
    deviceName = text;
    el.statPort.textContent = `${text}  (${portLabelText})`;
  },
);

/**
 * Mirrors the device's reported settings into the control panel dropdowns.
 *
 * The ids differ from the field names in one place: the I2C control is
 * "i2c-backend" because "i2c" is already the command.
 */
function applySettings(line: string): void {
  const found = parseSetting(line);
  if (!found) return;
  if (found.mode) control.setValue("mode", found.mode);
  if (found.avg) control.setValue("avg", found.avg);
  if (found.range) control.setValue("range", found.range);
  if (found.lcd) control.setValue("lcd", found.lcd);
  if (found.i2c) control.setValue("i2c-backend", found.i2c);
}

/** Asks the device to state its settings. Quiet: three lines nobody typed. */
function querySettings(only?: string): void {
  if (!serial.isOpen) return;
  for (const cmd of only ? [only] : QUERY_COMMANDS) {
    void serial.writeLine(cmd, term.eol, true);
  }
}

/**
 * Polls the device's hardware accumulators.
 *
 * The app's own charge and energy are a sum over the samples that reached us;
 * the INA228 integrates every conversion internally. Reading `acc` on a timer
 * is the only way to see the exact figures without a firmware change, and the
 * difference between two readings gives the true total for that interval.
 */
const ACC_POLL_MS = 1000;
/** No samples for this long means the stream is not running, whatever we think. */
const STREAM_IDLE_MS = 3000;

let accTimer = 0;
let streaming = false;
let lastSampleAt = 0;

/**
 * Whether the device is streaming, which is also when its accumulators move:
 * the firmware integrates only inside `if (usb_streaming)`, and `start` zeroes
 * them. Polling `acc` outside that window asks a frozen counter the same
 * question once a second and puts a command into the stream for nothing.
 *
 * Taken from the commands we send, with sample flow as the backstop - the
 * device may already have been streaming when we connected, and we would never
 * have seen the `start`.
 */
function setStreaming(on: boolean): void {
  if (streaming === on) return;
  streaming = on;
  term.hideAccPolling = on && el.optAcc.checked;
  if (!on && serial.isOpen && el.optAcc.checked) {
    // `stop` freezes the accumulators, so one last read captures the exact
    // session total rather than whatever the previous poll happened to catch.
    // Deliberately not hidden: it lands right under the stop summary.
    setTimeout(() => {
      if (serial.isOpen) void serial.writeLine("acc", term.eol, true);
    }, 250);
  }
}

/** Notices `start` and `stop`, whichever tab they were sent from. */
function noteCommand(text: string): void {
  const effect = streamEffect(text);
  if (effect) setStreaming(effect === "start");
}

function setAccPolling(on: boolean): void {
  term.hideAccPolling = on && streaming;
  clearInterval(accTimer);
  accTimer = 0;
  if (!on || !serial.isOpen) return;
  accTimer = setInterval(() => {
    if (lastSampleAt && Date.now() - lastSampleAt > STREAM_IDLE_MS) setStreaming(false);
    if (streaming && serial.isOpen) void serial.writeLine("acc", term.eol, true);
  }, ACC_POLL_MS) as unknown as number;
}


let rxBytes = 0;
let knownPorts: SerialPort[] = [];
let paused = false;

const serial = new SerialSession({
  onData(data) {
    // performance.now() rather than Date.now(): sub-millisecond and monotonic.
    // Whole-millisecond arrival times make every sample in a chunk collide,
    // and in fast mode chunks can land several times per millisecond.
    const t = performance.timeOrigin + performance.now();
    rxBytes += data.length;
    // Sample extraction runs here, not in the render path, so it keeps working
    // while the terminal is paused or showing a hex dump, and so replaying the
    // buffer on a view change cannot feed the charts twice.
    scanner.feed(t, data);
    term.push({ t, data });
    scheduleStats();
  },
  onLog(text, kind) { term.sysLine(text, kind as LogKind); },
  onConnected(label) {
    scanner.reset();
    deviceName = null;
    portLabelText = label;
    el.statPort.textContent = label;
    term.sysLine(`--- connected: ${label} ---`);
    setConnectedUI(true);
    streaming = false;
    lastSampleAt = 0;
    setAccPolling(el.optAcc.checked);
    // Both lines deasserted, which is exactly what the removed checkboxes did
    // in their default state - the configuration this device is known to work
    // with. Left explicit rather than inherited from the browser default,
    // which the spec does not pin down. A device that needs DTR asserted to
    // start talking would be fixed here.
    void serial.setSignals(false, false);
    void refreshPorts();
  },
  onDisconnected(reason) {
    term.flush();
    term.sysLine(`--- disconnected${reason ? " (" + reason + ")" : ""} ---`);
    el.statPort.textContent = "";
    deviceName = null;
    setAccPolling(false);
    streaming = false;
    setConnectedUI(false);
// The greeting line this replaced existed to prove which build was loaded,
// back when stale caching was a live problem. Hashed asset names settled that,
// so the build id lives here instead: visible on hover, absent from the log.
document.querySelector(".status")?.setAttribute("title", `build ${__BUILD_ID__}`);
  },
  onPortsChanged() { void refreshPorts(); },
});

/* ------------------------------------------------------------------ */
/* UI state                                                            */
/* ------------------------------------------------------------------ */

function setConnectedUI(on: boolean): void {
  el.connect.disabled = on;
  el.disconnect.disabled = !on;
  el.knownPorts.disabled = on;
  el.forget.disabled = on || !el.knownPorts.value;
  el.statState.className = "dot " + (on ? "on" : "off");
  el.statState.textContent = on ? "connected" : "disconnected";
  term.setPromptEnabled(on);
  control.setEnabled(on);
  if (on) {
    // Give the greeting a moment to finish, then ask what the device is set
    // to. Until the answers arrive the dropdowns keep showing "...".
    setTimeout(() => querySettings(), 300);
  } else {
    control.clearValues();
  }
}

let statsFrame = 0;
function scheduleStats(): void {
  if (statsFrame) return;
  statsFrame = requestAnimationFrame(() => {
    statsFrame = 0;
    el.statRx.textContent = rxBytes.toLocaleString("en-US");
    el.statTx.textContent = serial.txBytes.toLocaleString("en-US");
    const held = term.heldChunks;
    el.statBuf.textContent = held ? `held: ${held} chunks` : "";
    // Only appears once it happens, so a healthy session stays uncluttered.
    const sps = scanner.samplesPerSecond;
    // The tilde is the honest part: without device timestamps the reader has
    // to assume an even spacing it cannot verify, so the figure describes the
    // chunk arrivals rather than the acquisition.
    const timed = scanner.deviceTimed;
    el.statRate.textContent = sps > 0
      ? `${timed ? "" : "~"}${Math.round(sps).toLocaleString("en-US")}/s`
      : "--";
    el.statRate.title = timed
      ? "Sample times come from the device"
      : "This firmware sends no timestamps; sample times are interpolated from chunk arrivals";
    el.statMangled.classList.toggle("hidden", scanner.mangled === 0);
    el.statMangledN.textContent = scanner.mangled.toLocaleString("en-US");
  });
}

async function refreshPorts(): Promise<void> {
  knownPorts = await serial.listPorts();
  el.knownPorts.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = knownPorts.length ? "-- pick a remembered port --" : "no remembered ports";
  el.knownPorts.appendChild(none);
  knownPorts.forEach((port, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = `${idx + 1}. ${portLabel(port)}`;
    el.knownPorts.appendChild(opt);
  });
  el.forget.disabled = !el.knownPorts.value || serial.isOpen;
}

/**
 * The device is USB CDC, where the line settings are nominal: the host sends
 * them, the firmware ignores them, and nothing on the wire changes. They used
 * to be editable, which only invited people to tune numbers that do nothing.
 *
 * `port.open()` still requires a baud rate, so one is supplied here. Bringing
 * the controls back would mean restoring this object from the form; SerialConfig
 * already carries every field.
 */
const CDC_CONFIG: SerialConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

function download(blob: Blob, ext: string, prefix: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${prefix}-${stamp}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

el.connect.addEventListener("click", () => {
  const sel = el.knownPorts.value;
  const preferred = sel !== "" ? (knownPorts[Number(sel)] ?? null) : null;
  void serial.connect(preferred, CDC_CONFIG);
});

el.disconnect.addEventListener("click", () => void serial.disconnect("closed from the toolbar"));

el.knownPorts.addEventListener("change", () => {
  el.forget.disabled = !el.knownPorts.value || serial.isOpen;
});

el.forget.addEventListener("click", async () => {
  const sel = el.knownPorts.value;
  const port = sel !== "" ? knownPorts[Number(sel)] : undefined;
  if (!port) return;
  await port.forget();
  await refreshPorts();
  term.sysLine("--- port access revoked ---");
});


el.mode.addEventListener("change", () => term.setMode(el.mode.value as ViewMode));

el.optTs.addEventListener("change", () => el.output.classList.toggle("no-ts", !el.optTs.checked));
el.optWrap.addEventListener("change", () => el.output.classList.toggle("wrap", el.optWrap.checked));
el.optScroll.addEventListener("change", () => { term.autoScroll = el.optScroll.checked; });
el.sendEol.addEventListener("change", () => { term.eol = decodeEol(el.sendEol.value); });

// Showing or hiding measurement lines only affects future lines, so redraw
// the terminal from the raw buffer to apply it to what is already there.
el.optAcc.addEventListener("change", () => setAccPolling(el.optAcc.checked));

el.optEcho.addEventListener("change", () => {
  term.echoSamples = el.optEcho.checked;
  term.rerender();
});

// Scrolling up turns follow off; returning to the bottom turns it back on.
el.output.addEventListener("scroll", () => {
  const atBottom = el.output.scrollHeight - el.output.scrollTop - el.output.clientHeight < 4;
  if (el.optScroll.checked !== atBottom) {
    el.optScroll.checked = atBottom;
    term.autoScroll = atBottom;
  }
});

// Pause freezes the display only. Bytes keep arriving and samples keep landing
// in the chart store; both catch up on resume.
el.pause.addEventListener("click", () => {
  paused = !paused;
  term.paused = paused;
  charts.setPaused(paused);
  el.pause.classList.toggle("active", paused);
  el.pause.textContent = paused ? "Resume" : "Pause";
  el.statState.classList.toggle("paused", paused);
  if (!paused) term.flush();
  scheduleStats();
});

el.clear.addEventListener("click", () => {
  rxBytes = 0;
  term.clear();
  scheduleStats();
});

el.clearCharts.addEventListener("click", () => charts.clear());

el.saveTxt.addEventListener("click", () => {
  download(new Blob([term.logText(el.optTs.checked)], { type: "text/plain;charset=utf-8" }),
           "txt", "serial-log");
});

el.saveBin.addEventListener("click", () => {
  download(new Blob([term.rawBytes()], { type: "application/octet-stream" }), "bin", "serial-log");
});

el.saveCsv.addEventListener("click", () => {
  if (!charts.count) {
    term.sysLine("No samples captured yet.", "err");
    return;
  }
  download(charts.toCSVBlob(), "csv", "samples");
  charts.markSaved();
});

/**
 * Sends one user command, plus whatever has to bracket it - see
 * commandSequence, which decides that and is where the reasoning lives.
 *
 * Awaited one at a time so the device's shell sees them in the order intended.
 * Not quiet: the app is speaking on the user's behalf and should say so in the
 * log, the same as any command typed by hand.
 */
async function sendCommand(text: string): Promise<void> {
  if (streamEffect(text) === "start" && !(await beginCapture())) return;
  noteCommand(text);
  for (const line of commandSequence(text)) await serial.writeLine(line, term.eol);
  // Commands that change a setting but only answer "OK" have to be read back,
  // or the dropdown would keep showing the value from before the change.
  const refresh = refreshFor(text);
  if (refresh) setTimeout(() => querySettings(refresh), 150);
}

/**
 * Clears the charts for a new capture, asking first if that would throw
 * anything away.
 *
 * `start` zeroes the device's accumulators and begins a new session, so
 * leaving the previous one on the charts would draw two captures as one
 * continuous trace with a meaningless gap between them - and the totals in the
 * view bar would cover both. The old data has to go.
 *
 * It goes silently once it has been exported, and only then. Returns false if
 * the user would rather keep it, in which case nothing is sent at all: better
 * to leave the device alone than to start a capture the user just declined.
 */
async function beginCapture(): Promise<boolean> {
  if (charts.unsaved) {
    const n = charts.count.toLocaleString("en-US");
    const ok = await confirmDialog({
      title: "Discard the current capture?",
      body: `${n} samples have not been saved to CSV.\n` +
            `Starting a new capture clears them from the charts.`,
      confirmLabel: "Discard and start",
      danger: true,
    });
    if (!ok) {
      term.sysLine("Start cancelled - save the CSV first, or clear the charts.", "err");
      return false;
    }
  }
  charts.clear();
  return true;
}

term.onSubmit = (text) => void sendCommand(text);

// Not quiet: the terminal is right below the buttons, so echoing the command
// is what makes the pair read as a dialogue.
control.onCommand = (command) => void sendCommand(command);


term.onControl = (code, label) => void serial.writeByte(code, label);

function decodeEol(raw: string): string {
  return raw.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

function isChromium(): boolean {
  const ua = navigator.userAgent;
  return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/OPR\//.test(ua);
}

/**
 * navigator.serial is exposed only in a secure context and only for a real
 * origin. Distinguish the causes so the banner says what to actually fix.
 */
function showUnsupported(): void {
  const title = $<HTMLElement>("unsupported-title");
  const body = $<HTMLElement>("unsupported-body");

  if (location.protocol === "file:") {
    title.textContent = "Opened via file:// - Web Serial will not work.";
    body.innerHTML =
      " Browsers do not expose <code>navigator.serial</code> to files on disk." +
      " The app has to be served over HTTP:" +
      "<ol><li><code>docker compose up -d</code> in the app directory.</li>" +
      "<li>Open <code>http://localhost:8080</code>.</li></ol>";
  } else if (!window.isSecureContext) {
    title.textContent = "Insecure context - Web Serial is unavailable.";
    body.innerHTML =
      " This origin is not trusted. Only <code>https://</code> and" +
      " <code>http://localhost</code> / <code>127.0.0.1</code> qualify - plain" +
      " <code>http://</code> to an IP address does not." +
      " Use localhost, put TLS in front, or add this origin to" +
      " <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>.";
  } else if (!isChromium()) {
    title.textContent = "This browser does not implement the Web Serial API.";
    body.innerHTML = " Use Chrome or Edge 89+. Firefox and Safari do not ship this API.";
  } else {
    title.textContent = "Web Serial is disabled in this browser.";
    body.innerHTML =
      " The engine supports it but the API was not exposed. Usual causes:" +
      " enterprise policy (<code>DefaultSerialGuardSetting</code> - check" +
      " <code>chrome://policy</code>), guest mode, or a disabled" +
      " <code>chrome://flags/#enable-experimental-web-platform-features</code>.";
  }

  $<HTMLElement>("unsupported-diag").textContent =
    `origin: ${location.origin} | protocol: ${location.protocol}` +
    ` | secureContext: ${window.isSecureContext} | chromium: ${isChromium()}`;

  el.unsupported.classList.remove("hidden");
}

term.eol = decodeEol(el.sendEol.value);
term.echoSamples = el.optEcho.checked;
term.autoScroll = el.optScroll.checked;
setConnectedUI(false);

if (!isSerialSupported()) {
  showUnsupported();
  el.connect.disabled = true;
} else {
  void refreshPorts();
  window.addEventListener("beforeunload", () => void serial.disconnect("page closing"));
}

scheduleStats();

# USB Power Meter Dashboard

Live power-profiler charts and a serial terminal for the CH32X035 + INA228 USB
power meter, running entirely in the browser on the **Web Serial API**. No
backend: the browser opens the port itself, so measurements never travel over
the network. The container serves a static bundle and nothing else.

Four synchronised charts (voltage, current, power, shunt voltage) fed at ~3900
samples/s, with the sample times coming from the device rather than from
packet arrivals. Buttons for the device's whole command set, and a terminal
underneath them for everything else.

TypeScript, built with Vite, charts drawn by [uPlot](https://github.com/leeoniya/uPlot),
tested with Vitest. No UI framework - see "Why no framework" below.

## Running (WSL host)

```bash
cd ch32x035-usb-power-meter-dash
docker compose up -d --build
```

The container listens on `0.0.0.0:8080`. From a browser on Windows:

```
http://localhost:8080
```

WSL2 forwards `localhost` into the distro, and `localhost` is a **secure
context**, so Web Serial is allowed to open ports.

Then: **Connect** -> pick a port in the browser dialog.

Without compose:

```bash
docker build -t usb-power-meter-dash .
docker run -d --name usb-power-meter-dash -p 8080:8080 usb-power-meter-dash
```

## Running from GitHub Pages

The **Deploy to GitHub Pages** workflow builds the bundle and publishes it.
It is `workflow_dispatch` only - run it from the Actions tab when you want the
published copy to move. Deploying on every push would make a half-finished
commit the live one, and the container on the WSL host is the working copy
anyway.

Pages serves over `https://`, which is a secure context, so Web Serial works
there with no container and no local setup. That makes it the copy to use from
a machine that is not the one running Docker.

One-off setup in the repository: **Settings -> Pages -> Source: GitHub
Actions**. Nothing else - `base: "./"` in `vite.config.ts` already makes the
bundle work from a project subpath without knowing the repository name.

## Developing

```bash
npm install
npm run dev      # Vite dev server on :5173, hot reload
npm test         # Vitest, 210 tests
npm run build    # tsc --noEmit, then the production bundle into dist/
```

`npm run build` type-checks before bundling, and the Dockerfile runs the same
command, so a type error fails the image rather than shipping.

## Reaching it from another machine requires HTTPS

Web Serial is only exposed in a **secure context**:

- `https://` with a valid certificate,
- `http://localhost` and `http://127.0.0.1`.

Browsing to the WSL distro's own address instead - `http://172.x.y.z:8080` -
is **not** a secure context. The page loads, but `navigator.serial` will not exist and you get
the red banner instead of a port list. That is a browser rule, not an
application limitation.

| Option | When |
|---|---|
| TLS reverse proxy (Caddy, Traefik, `cloudflared`) in front of the container | Proper long-term setup |
| `ssh -L 8080:localhost:8080` from the client machine | Quick, no certificates |
| `chrome://flags/#unsafely-treat-insecure-origin-as-secure` + the origin | Testing only |

The container deliberately does not terminate TLS - certificates belong in
the proxy layer, not in an image holding a static bundle.

Note: the browser on the user's machine owns the serial port. The container
in WSL needs no hardware access, no `--device` and no `usbipd`.

## Requirements

**Chrome or Edge 89+.** Firefox and Safari do not implement Web Serial.
If the API is missing, the banner identifies which specific cause applies
(`file://`, no secure context, wrong browser, blocked by policy) and prints
the origin and `secureContext` for diagnosis.

## Troubleshooting: "Failed to open serial port"

Chrome collapses every OS-level failure into this one opaque message.
In practice it is almost always the first cause:

1. **Another program holds the port.** Windows COM ports are exclusive -
   Arduino IDE serial monitor, PuTTY, a flashing tool, or a second tab of
   this app will block it. Close it and retry.
2. **Stale remembered handle.** If you picked a port from the dropdown and
   the device was unplugged and replugged since, the handle is dead. Clear
   the dropdown selection and use **Connect** to pick the device again.
3. **No working driver** for the adapter (CH340, CP210x, FTDI clones).

The app prints these hints in the log whenever an open attempt fails, along
with an `attempted:` line naming the port and the exact settings it tried -
Chrome's own message names neither.

If the log shows a bare `--- disconnected ---` with no reason, that is a user
action (the toolbar button, or the page closing). A fault names itself:
`device unplugged` or `stream closed by the device`.

## Live charts

The left side holds four nRF Power Profiler style strip charts - Voltage,
Current, Power and V shunt. The right side holds the control buttons with the
terminal directly underneath.

**Drag the divider** between them to resize; double-click it to go back to the
4/6 default, or focus it and use the arrow keys (Shift for bigger steps). The
position is kept in `localStorage`, clamped so neither side can be squeezed
into uselessness. A storage that throws - Safari in private mode does - is
treated as no storage: the layout simply will not persist.

Lines matching a measurement format are routed to the charts and kept out of
the terminal, so the log stays readable and only shows commands and responses.
Two layouts are recognised, matching the device's slow and fast modes:

```
4.914 V, 476695 uA, 2342788 uW, Vsh=4766953 nV, t=00f4b1   -> charts  (slow)
4.819,713968,3440711,7139687,1a2b3c                        -> charts  (fast)
> mode fast                                                -> terminal
OK: 102 samples in 13697 ms -> 7 sps acquired              -> terminal
  delivered 102 (7/s), dropped 0 (0/s)                     -> terminal
```

Both carry the same quantities in the same units (V, uA, uW, nV); fast mode
just drops the labels. The trailing field is the sample's own timestamp, the
low 24 bits of the device's microsecond counter in hex - see [Sample
timestamps](#sample-timestamps-come-from-the-device). It is optional: firmware
that predates it is still plotted, from interpolated times.

The patterns live in `SAMPLE_FORMATS` in `src/parse.ts` and are anchored at
both ends, so prompts, echoes and summary lines cannot be mistaken for data -
the fast pattern demands exactly four bare numbers and, if a fifth field is
present, exactly six hex digits. Tick "Echo samples in terminal" to show them
in the log too, dimmed.

To support another firmware format, add a regex that captures the same four
groups in the same units; nothing else needs changing.

Sample extraction runs on the raw byte stream, not in the render path. That
means it keeps working while the terminal is paused or set to hex view, and
replaying the buffer on a view change cannot double-count samples.

Chart details:

- Values are stored in SI base units; axes pick their own engineering prefix,
  so 476695 uA reads as 476.7 mA.
- Each pixel column is drawn as a min/max envelope with a mean trace over it,
  so dense capture shows its spread instead of aliasing.
- Window selector from 10 s to all, optional zero-based Y, min/avg/max for the
  visible window, and a crosshair shared across all four charts on hover.
- **Export CSV** writes every retained sample (timestamp, V, A, W, V shunt).
- Ring buffer keeps the last 1 000 000 raw samples (`PROFILER_CAP` in `src/store.ts`).
- Redraw is capped at 25 fps - charts are data views, not animations. The
  column aggregation runs once per redraw for all four charts, not once each.
- The terminal assembles lines in memory and only creates DOM elements for
  lines it will actually show, so filtered sample rows cost nothing.

### Zoom, selection and panning

| Gesture | Effect |
|---|---|
| Drag across a chart | frame that range and leave live follow |
| Wheel | zoom around the pointer |
| Shift+wheel, or middle-button drag | pan through history |
| Double click, or the **Live** button | resume following live data |

Panning to the right-hand edge also resumes following, at whatever zoom you
are on - the same way a tailing log view behaves.

**all** frames exactly what has been captured, however little that is, and the
trace densifies as history grows. It is capped only by what the coarse tier
still holds (3.6 h).

Any gesture leaves the preset, and the control says so by switching to
**custom**. The control follows the preset that was *asked for*, not the window
that results: with less capture than the preset, `clampView` narrows the window,
so syncing to the result made the list snap to "custom" the instant a preset was
picked - which left the presets unusable. It used to go on reading "all" while the view had quietly become a
fixed scrolling window - a stray wheel over a chart was enough, and panning to
the live edge hid it further by keeping the Live button away. The only cure was
toggling the preset off and back on, which is a bug report that took a while to
pin down.

Every window is clamped to the data, so a 30 s preset over 10 s of capture
shows 10 s. Gestures operate on the clamped window rather than the preset,
otherwise zooming from a preset wider than the data would land straight back on
the clamp and appear to do nothing.

The x axis is **relative to the newest sample** - `-30s`, `-1m30s`, `now` -
not a wall clock. Label precision follows the tick spacing uPlot settles on, so
zooming in yields `-1.25s` and then `-1.8ms` rather than three ticks all
rounding to the same `-1.2s`. The decimals come from the spacing itself, not
from `-log10(incr)`: at 2.5 s spacing that formula gives zero decimals and
labels the tick at -12.5 s as `-13s`, which is distinct from its neighbours and
wrong. On a 30 s window absolute time reads `:22 :23 ... :49`, which
says nothing about how far back you are looking. The reference is the newest
sample rather than the right edge of the view, so panning into history reads
`-5m30s ... -5m00s` instead of resetting to zero at whatever is on screen.

Because x carries offsets rather than timestamps, every gesture adds the
reference back before acting. Non-finite coordinates are dropped at the door:
uPlot's `posToVal` yields NaN when the plot has no usable geometry, and a NaN
anchor used to propagate through `clampView` and leave the viewport permanently
NaN, unrecoverable without a reload.

**Zoom moves the aggregation window, not the uPlot scale.** This is the whole
point. The charts hold no data: they are handed one aggregated column per
pixel. Rescaling inside uPlot would stretch those columns into blur. Changing
the window makes `ColumnAggregator` re-read the range, dropping to a finer tier
or to raw samples, so zooming in genuinely reveals detail - down to individual
samples. uPlot is configured with `cursor.drag.setScale: false` for exactly
this reason; it draws the selection rectangle and reports it, nothing more.

The bar above the charts describes whatever is on screen: span, sample count,
average current and power, and the integrated charge (mAh) and energy (mWh).
Because zoom and selection are the same operation, those figures are also the
statistics for a range you just selected.

Charge and energy come from the window average times its duration. With uniform
sampling that is identical to summing `value * dt` per sample, and it keeps
working when the numbers come from summary buckets, where per-sample spacing is
no longer available. There is a test asserting the two agree.

The bar's `window` is the range on screen and `history` is the whole capture
held in the buffers - what **all** would frame. An earlier version showed
coverage *inside* the window instead, which the window caps by definition, so
it could never exceed the preset and told nobody anything.

### Charge and energy come from the device, not from here

The INA228 integrates charge and energy **in hardware, on every ADC
conversion**. The stream only carries what the firmware sends, so anything the
app computed would be a sum over the samples that happened to arrive - never
matching, and inviting the question of which figure to believe. So the app does
not compute them at all.

**Polling runs only between `start` and `stop`.** The firmware integrates
inside `if (usb_streaming)`, so outside that window the counter is frozen -
asking it once a second would interrogate an unchanging value and inject a
command into the stream for nothing. The state is taken from the commands the
app sends, whichever tab they came from, with sample flow as a backstop: three
seconds without a sample means the stream is not running, whatever we thought,
which covers a device that was already streaming when the app connected.

On `stop` one final read is sent and left visible, landing under the session
summary - `stop` freezes the accumulators, so that read is the exact session
total rather than whatever the previous poll happened to catch.

Otherwise it polls the existing `acc` command once a second, parses the reply
(`6.342 mAh, 31.098 mWh`), and reports the **difference between two readings**
across the visible range. That is exact for the interval between them, with no
firmware change.

**`charge` and `energy` are the change across the visible range, not the
running total.** Over a 30 s window they look nothing like a ten-minute
accumulator, so the running total is printed beside them:

```
charge 3.552 mAh of 116.8 mAh     energy 17.33 mWh of 559.5 mWh
```

The `of` figure is exactly what `acc` prints, which makes the delta verifiable
instead of something to take on faith. It also ticks once a second, so it
doubles as proof that polling is alive.

`charge` and `energy` stay `--` only until two readings fall inside the window.

Samples alone define the timeline. When the measurement stops the charts stop
too - no scrolling, and `history` stops growing - even though polling carries
on. Letting accumulator readings extend the timeline was tried and reverted:
it produced motion with nothing behind it.

Charge still survives a stop, because the readings taken while the stream was
running remain inside the frozen window. Only the running total keeps moving,
which is what tells you the device is still alive.

Two things enforce this. An empty chart is anchored to a fixed instant rather
than `Date.now()`, because the poller redraws once a second and a live clock
there made the axis of an empty chart crawl. And a redraw whose geometry and
sample count are unchanged skips the chart entirely, so no future path can turn
polling into visible motion - it also saves the aggregation pass.

Before any data arrives the axis spans the selected preset. It used to span a
token one second, which `clampView` then imposed on the preset, drawing an axis
full of sub-second tick labels that looked like arbitrary times. The anchor is
the moment the page loaded, so on a long-idle tab that axis reads stale - it is
an empty chart, and a stale label beats a crawling one.

If the device ever reports a value **lower** than the previous one, an
`acc went back Nx` counter appears in the status bar. The step has to be
skipped, but an accumulator running backwards is not something to swallow
silently - it means either a reset or a device-side fault.

A device-side `acc reset` is handled by summing the readings step by step and
skipping the one negative step, rather than by discarding the range. Everything
either side of the reset is real charge; only the amount between the last
reading and the reset instant is unknowable, which is at most one poll
interval. Discarding the whole range - the first attempt - meant the figures
never came back on a wide window, because the pre-reset reading stayed in range
forever.

Charge and energy carry engineering prefixes (`nAh`, `uAh`, `mAh`), because
sleep-current profiling lands well below a milliamp-hour and a fixed `mAh`
would read `0.000` and look broken.

When the window really is too short to move the device's last printed digit,
the bar says `< 1.000 uAh` rather than zero. The app learns that step by
watching the smallest positive change the device ever reports, so it adapts to
whatever resolution the firmware prints. 17.74 uA over 30 s is 0.000148 mAh -
below three decimals of mAh, so the device itself reports no change at all.
Widen the window, or have the firmware print more decimals.

Numbers are matched strictly, with at most one decimal point. The obvious
`[\d.]+` accepts `6.3424.884` and `parseFloat` then quietly returns `6.3424`,
so a reply spliced by the sample stream became a plausible but wrong reading -
visible as the accumulators jumping while the device itself reported a rising
series. The same strictness applies to the labelled sample layout.

Poll traffic is kept out of the log - the echo and reply would otherwise add
lines every second. Untick **Poll acc** to stop polling and see them normally;
the app then writes nothing to the port on its own, which is the first thing to
turn off when diagnosing anything stream-related.

Two gotchas worth knowing.

The device prints its `> ` prompt without a trailing newline, so the next line
assembles as `> acc`, not a bare `acc`. The echo and reply patterns both
tolerate a leading prompt for that reason.

The firmware answers commands from a different context than the one writing
samples, so in fast mode a reply can land **in the middle of a measurement
row**:

```
4                              <- row interrupted here
> acc                          <- hidden by the poll filter
6.342 mAh, 31.098 mWh          <- hidden by the poll filter
.884,476156,2325631,4761562    <- orphaned tail, unparseable
```

The tail has lost its leading digit, so parsing it would invent a wrong value -
0.884 V instead of 4.884 V. It is discarded instead, and counted: a **split
rows** figure appears in the status bar once it happens. Losing one sample per
poll out of 4000 is harmless, but it should be visible rather than silent. If
the count climbs faster than the poll rate, something else is fragmenting the
stream.

If the firmware ever does emit accumulator values unprompted, prefer a separate
line type (`ACC 6.342,31.098`) over widening the sample row: the fast format is
defined as exactly four bare numbers, and a fifth field would break the parser.

### Why there are two aggregation tiers

Scanning raw samples costs O(visible), which at a full buffer measured 248 ms
per redraw. Past the ~40 ms frame budget the animation-frame loop never catches
up and the page stops responding, which is exactly how it failed in fast mode.

So every sample is also folded into fixed-duration buckets as it arrives
(`SummaryStore` in `src/store.ts`). Two resolutions, because one cannot serve both ends: a 5 ms
bucket keeps a 10 s window smooth at 4000 samples/s, but scanning 5 ms buckets
across 15 minutes would be 180k iterations. `aggregate()` picks the coarsest
tier whose buckets still fit inside one pixel column, so the chart is never
blocky and never scans more than it has to.

| Tier | Bucket | Span held |
|---|---|---|
| raw samples | - | 1 M samples (250 s at 4000 sps) |
| fine | 5 ms | 327 s |
| coarse | 200 ms | 3.6 h |

Buckets carry exact min, max, sum and count, so **no spike is lost**. Verified
against per-window ground truth at 4000 samples/s with single-sample spikes and
dips: min and max match exactly on every window. The sample count can differ by
up to one bucket at each window edge, because the bucket straddling the edge is
counted whole - 0.05% at 4000 sps, which only affects the displayed average.

Measured at 4000 samples/s with a 1 M sample buffer:

| Window | Source | Redraw |
|---|---|---|
| 10 s | 5 ms | 1.5 ms |
| 30 s | 5 ms | 3.1 ms |
| 1 min | 5 ms | 6.1 ms |
| 5 min | 200 ms | 0.7 ms |
| 15 min | 200 ms | 0.7 ms |
| all | 200 ms | 1.5 ms |

Ingest (parse plus all three stores) costs 0.19% of real time at that rate.

Sample values are stored as Float32. The device sends at most 7 significant
digits, which Float32 represents exactly, and halving the width is what makes
a 1 M sample ring plus two tiers fit in roughly 32 MB.

### Throughput ceiling

At 4000 samples/s the fast format is about 117 KB/s, which needs roughly
**1.2 Mbaud** on a real UART. On a plain 115200 link the physical ceiling is
about 380 samples/s regardless of what the firmware does. USB CDC devices
ignore the baud setting, so this only bites on genuine serial hardware.

### Sample timestamps come from the device

Each sample carries the low 24 bits of the firmware's microsecond counter, six
hex digits at the end of the line. `TickClock` in `src/parse.ts` unwraps the
counter and ties it to the host clock once, at the newest sample of the first
chunk that carries a stamp. Everything after that is the device's own timeline.

**Why the reader cannot work it out itself.** USB delivers whole chunks, so a
reader without stamps sees one instant for a burst of samples and has to invent
the spacing inside it. The only thing it can invent is an even spacing, and the
spacing is not even. The firmware redraws its LCD from the main loop every
~267 ms (250 ms plus the draw, since `lcd_next_update` is set after it), which
stops acquisition for runs of up to 23 ms. A real 50 s capture lost 1.72 s to
127 such pauses - 3.4% of the samples - and an evenly spaced reader smears them
across their neighbours instead of drawing the gap. The visible symptom was
sessions reporting 3752 and 3779 sps while the rate between pauses was 3973.

**Wrapping.** Six hex digits hold 16.777216 s. A stamp lower than its
predecessor means one rollover, which is unambiguous because no gap in the
stream comes close to 16 s. A reboot looks the same, but rebooting
re-enumerates USB and that resets the reader.

**Drift.** The anchor is never adjusted. Host and device clocks drift by a few
hundred ppm, a fraction of a second per hour, and re-anchoring to correct it
would either move samples already drawn or make the timeline jump backwards -
timestamps must stay strictly increasing, which the ring's binary search
depends on.

**Cost.** Seven bytes per line, about 28 KB/s at 4000 samples/s. The stamp is
absolute rather than a delta because the firmware drops a line outright when
the CDC ring is full; a delta would take that sample's interval with it and
shift everything after.

#### Fallback for firmware without stamps

Unstamped lines are still plotted. Spacing then comes from the **measured**
sample rate; the status bar prefixes it with `~` to say so. A nominal rate
declared by the device would be the intended one rather than the achieved one -
which diverges exactly when the device cannot keep up. Dividing the arrival
interval by the batch size instead inherits USB jitter, visible once you zoom
in. Chunks are timed with `performance.now()` rather than `Date.now()` so
sub-millisecond arrivals do not collide.

A real capture had 565 backward steps on this path: `performance.now()` is
quantised to about 100 us, so two chunks can share an arrival time, and the old
fallback then invented 1 ms per sample and rewound over rows already emitted.
The charts drew those as tears. A gap far longer than the samples account for
is left visible rather than smeared into the spacing.

### `start` clears the charts

A capture is a session, not a continuation. `start` zeroes the device's
accumulators and begins counting again, so keeping the previous one on the
charts would draw two captures as one trace with a meaningless gap between
them, and the totals in the view bar would cover both.

So `start` - typed or clicked - empties the buffer first. It does that
silently once the data has been exported, and asks first when it has not.
Declining sends nothing at all: better to leave the device alone than to begin
a capture the user just refused.

`ChartPanel.unsaved` is what decides. `markSaved()` is called by the Save CSV
handler and cleared again by the next sample, so a capture that carried on
after an export counts as unsaved - the file holds only the first part of it.

The Clear charts button is deliberately left without a prompt: it says what it
does, and the whole point of it is to not be asked.

### The device's display is blanked during a capture

`commandSequence()` in `src/commands.ts` sends `lcd off` immediately before
`start` and `lcd on` immediately after `stop`. Both appear in the log; the
Display control in the Acquisition group drives the same command by hand.

The device redraws its panel from the same loop that reads the INA228, so the
draw and the sampling cannot happen at once. Measured on real captures:

| | gap | period | lost |
|---|---|---|---|
| original | 10.2-23.6 ms | 265.5 ms | 6.13% |
| direct registers + 16-bit SPI | 2.1-4.5 ms | 252.7 ms | 1.30% |
| DMA painter (firmware 1.0.234) | ~0.12 ms | 250 ms | ~0.2% |
| `lcd off` | none | - | 0% |

The last row is why the app sends the command rather than relying on the
firmware being fast enough. It is also not only about the total: the period was
stable to within 0.5 ms, so a periodic load close to 253 ms would have landed
in the blind spot every single time and vanished from the trace completely,
not by 1.3%.

Order matters, which is what `commandSequence` exists to make testable. `lcd
off` has to reach the device before streaming begins, or the first refresh is
still in the data. `dfu` is excluded from the pairing: it counts as a stop, but
the device reboots and nothing reads the follow-up.

## Features

| Area | What you get |
|---|---|
| Line settings | none - the device is USB CDC, where baud and framing are nominal and change nothing on the wire |
| View | text (UTF-8) or a 16-byte hex dump with ASCII column, switchable live |
| Reading | millisecond timestamps, auto-scroll, wrapping, pause |
| Saving | `.txt` (what you see) and `.bin` (raw bytes from the buffer) |
| Sending | click the terminal and type - see "Typing" below |
| Signals | none in the UI. Both lines are deasserted on connect, which is what the removed checkboxes did by default and what this device works with. `setSignals` in `src/main.ts` is the one place to change if a device needs DTR asserted before it will talk |
| Ports | list of already-granted ports, "Forget" revokes access |

## Control panel

The right column has the control buttons on top and the terminal underneath,
both always visible. The buttons map the device's shell, grouped as streaming,
accumulators, acquisition, diagnostics and danger.

The panel has no output of its own. Replies land in the terminal immediately
below it, which is also where the command echo goes, so the pair reads as a
dialogue. An earlier version put the two behind tabs and needed a duplicate
reply feed on the control side - pressing a button and then switching panes to
see what happened was worse than simply showing both.

The catalogue lives in `src/commands.ts` as plain data, taken from the
firmware's own command table (`shell_cmds` in `App/main.c`) rather than from
its `help` text - so the argument ranges are the real ones. Averaging offers
only the eight values the INA228 accepts; ADC range only 0 and 1. Adding a
command is one entry in that array.

Selects have no "current value": the device does not report its settings in a
form the app could read back, so they sit on a placeholder and return to it
after sending. A control that guessed the device's state would be worse than
one that admits it does not know.

`reset` and `dfu` need a second click within three seconds - they wipe
calibration and reboot the device respectively, and they sit next to the
harmless diagnostics buttons.

### What the firmware actually does

Worth knowing, because it contradicts the obvious reading of `help`:

- **`start` zeroes the accumulators** and `stop` freezes them. Charge and
  energy are already per-session; they do **not** run in the background. The
  firmware only integrates inside `if (usb_streaming)`.
- That also explains an accumulator appearing to jump backwards: a `start`
  between two polls resets it to zero.
- `cal` blocks for several seconds, and the firmware deliberately discards
  sample intervals longer than four conversion periods so the pause is not
  integrated as if current had flowed throughout.
- `mode` switching resets the sample clock for the same reason.

## Typing

There is no input box. Click anywhere in the terminal to focus it - a blue bar
appears on its left edge and the caret starts blinking - then type. The prompt
is an ordinary line pinned to the bottom of the log.

| Key | Effect |
|---|---|
| Enter | send the line plus the EOL selected in the toolbar |
| Backspace / Escape | delete the last character / clear the line |
| Up / Down | command history |
| Ctrl+C | send `0x03` when nothing is selected, otherwise copy |
| Ctrl+L | clear the terminal |
| Paste | multi-line paste sends each line in turn |

Editing is local and the text goes out only on Enter, rather than forwarding
each keystroke raw. That way what you type is visible even on a device that
does not echo, and a typo can be fixed before it is sent. Ctrl+C is logged as
`[Ctrl+C 0x03]` so an interrupt is never silent.

## Behaviour and limits

- **Port names.** Web Serial exposes neither the `COMx` number nor a product
  string - `getInfo()` returns the USB vendor and product ids and nothing more.
  Known vendor ids are named (`WCH 1a86:fe0c`), and once connected the status
  bar shows the greeting the device prints for itself, which is the only real
  name available: `USBpm 1.0.199 - type 'help' (WCH 1a86:fe0c)`.
- **Control characters** in text mode are shown as `\xNN` (except TAB).
  Use hex mode for byte-level inspection.
- **CR, CRLF and LF** are normalised to a single line break so every device
  looks the same. A device that overwrites a line with a bare `CR`
  (a progress bar, say) will produce many lines.
- **Memory limits:** 5000 lines in the DOM and 4 MB of raw bytes
  (`MAX_LINES`, `MAX_BUFFER` at the top of `src/terminal.ts`). Older data is dropped,
  which also affects `.bin` export and the redraw on mode change.
- **Rendering is batched** once per animation frame so high baud rates do not
  freeze the UI.
- **Pause** stops drawing only - data keeps arriving and is buffered
  (up to 8192 chunks), then drawn on resume.

## Files

```
index.html              markup only; no logic
src/main.ts             wiring: DOM controls, session, terminal, charts
src/serial.ts           Web Serial session: ports, read loop, writes, DTR/RTS
src/parse.ts            line assembly, both sample formats, unit conversion
src/store.ts            sample ring, summary tiers, column aggregation
src/charts.ts           four uPlot charts fed from the aggregator
src/terminal.ts         byte buffer, text/hex renderers, inline prompt
src/format.ts           engineering-prefix formatting
src/*.test.ts           Vitest suites
nginx.conf              headers, gzip, cache, /healthz
Dockerfile              node build stage, nginx runtime stage
compose.yml             deployment
```

## Caching

Vite emits content-hashed filenames under `/assets`, so those are served
`public, max-age=31536000, immutable` - a rebuild produces new names rather
than new content at old names. `index.html` is the one file with a stable name,
so it is always `no-cache`: it is what points at the current hashes.

This replaced an earlier hand-rolled scheme of blanket `no-store` plus manual
`?v=` query strings that had to be bumped in three places by hand. Getting rid
of it was a large part of why the build step was worth introducing.

## Why no framework

The hot path here is a ring buffer and a canvas, not a component tree. A
framework would only manage the toolbars, and pushing thousands of samples per
second through any reactivity system would be slower than the plain DOM code it
replaced. TypeScript and modules gave the maintainability that was actually
missing; Svelte remains an option for the UI shell if the controls grow.

Measured cost of the whole ingest path at 4000 samples/s - parse, terminal and
all three stores - is about 1.3% of real time, which is also why the serial
reader was left on the main thread instead of moving it into a Web Worker.

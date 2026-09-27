/** Web Serial session: port selection, read loop, writes and modem signals. */

export interface SerialConfig {
  baudRate: number;
  /** The spec allows only these; keeping them literal stops a bad <select> value
      from reaching port.open() and failing with an opaque browser error. */
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: ParityType;
  flowControl: FlowControlType;
}

export type LogKind = "sys" | "err" | "tx";

export interface SerialHandlers {
  onData(data: Uint8Array): void;
  onLog(text: string, kind: LogKind): void;
  onConnected(label: string, config: SerialConfig): void;
  onDisconnected(reason?: string): void;
  onPortsChanged(): void;
}

/**
 * Web Serial exposes no port name and no product string - `getInfo()` returns
 * the USB vendor and product ids and nothing else. Naming the vendor is the
 * most that can be done from the API; the readable device name comes from the
 * greeting the device itself prints on connect.
 */
const USB_VENDORS: Readonly<Record<string, string>> = {
  "0403": "FTDI",
  "0483": "STMicroelectronics",
  "067b": "Prolific",
  "10c4": "Silicon Labs",
  "1366": "SEGGER",
  "1915": "Nordic",
  "1a86": "WCH",
  "2341": "Arduino",
  "2e8a": "Raspberry Pi",
  "303a": "Espressif",
};

export function portLabel(port: SerialPort): string {
  const info = port.getInfo();
  if (info.usbVendorId == null) return "serial port";
  const v = info.usbVendorId.toString(16).padStart(4, "0");
  const p = (info.usbProductId ?? 0).toString(16).padStart(4, "0");
  const vendor = USB_VENDORS[v];
  return vendor ? `${vendor} ${v}:${p}` : `USB ${v}:${p}`;
}

export function isSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export class SerialSession {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopDone: Promise<void> | null = null;
  private keepReading = false;
  txBytes = 0;

  constructor(private readonly h: SerialHandlers) {
    if (!isSerialSupported()) return;
    navigator.serial.addEventListener("connect", () => this.h.onPortsChanged());
    navigator.serial.addEventListener("disconnect", (e) => {
      if (this.port && e.target === this.port) void this.disconnect("device unplugged");
      this.h.onPortsChanged();
    });
  }

  get isOpen(): boolean { return this.port !== null; }

  listPorts(): Promise<SerialPort[]> {
    return isSerialSupported() ? navigator.serial.getPorts() : Promise.resolve([]);
  }

  async connect(preferred: SerialPort | null, config: SerialConfig): Promise<void> {
    if (this.port) return;

    // Resolve the port first: dismissing the picker is a normal user action,
    // not an error, and must not be confused with open() failing.
    let port = preferred;
    if (!port) {
      try {
        port = await navigator.serial.requestPort();
      } catch (e) {
        if ((e as DOMException).name === "NotFoundError") return;
        this.h.onLog(`Port selection failed: ${(e as Error).message}`, "err");
        return;
      }
    }

    try {
      await port.open({ ...config, bufferSize: 65536 });
    } catch (e) {
      this.explainOpenFailure(e as DOMException, preferred !== null, config, portLabel(port));
      this.h.onPortsChanged();
      return;
    }

    this.port = port;
    this.keepReading = true;
    this.h.onConnected(portLabel(port), config);
    this.readLoopDone = this.readLoop();
  }

  /**
   * Chrome collapses every OS-level failure into the same opaque
   * "Failed to open serial port", so spell out what actually causes it.
   */
  private explainOpenFailure(err: DOMException, fromList: boolean,
                             config: SerialConfig, label: string): void {
    const say = (s: string) => this.h.onLog(s, "err");
    say(`Failed to open port: ${err.message}`);

    // Echo what was actually attempted. Chrome's message names neither the
    // port nor the settings, so without this the log cannot tell a busy port
    // apart from a baud rate the driver will not accept.
    say(`  attempted: ${label} @ ${config.baudRate} baud, ` +
        `${config.dataBits}${config.parity[0]!.toUpperCase()}${config.stopBits}, ` +
        `flow ${config.flowControl}`);

    if (err.name === "InvalidStateError") {
      say("  The port is already open in this page. Disconnect first.");
      return;
    }
    say("  1. Another program or tab holds it. Windows COM ports are exclusive:");
    say("     Arduino IDE serial monitor, PuTTY, a flashing tool - or this app");
    say("     open at a different address, which counts as a separate tab.");
    if (fromList) {
      say("  2. You picked a remembered port. If the device was unplugged and");
      say("     replugged, that handle is stale - use Connect and pick again.");
    }
    say(`  3. The driver may reject ${config.baudRate} baud or this framing.`);
    say("     Try 115200, 8N1, flow none as a baseline.");
    say("  4. The adapter may have no working driver (CH340, CP210x, clones).");
  }

  private async readLoop(): Promise<void> {
    while (this.port?.readable && this.keepReading) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      let ended = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { ended = true; break; }
          if (value?.length) this.h.onData(value);
        }
      } catch (e) {
        this.h.onLog(`Read error: ${(e as Error).message}`, "err");
        ended = true;
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
      // The stream finished or failed. Re-acquiring a reader on it would
      // return done immediately and spin this loop hot.
      if (ended) break;
    }

    // Ending while we still wanted data means the stream went away under us,
    // not that a stop was requested. Without this the session stayed
    // "connected" with nothing reading, and the only way out was the
    // Disconnect button - which made the log look like a user action.
    if (this.keepReading) {
      this.keepReading = false;
      this.readLoopDone = null;   // we are that promise; disconnect must not await it
      void this.disconnect("stream closed by the device");
    }
  }


  async disconnect(reason?: string): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.keepReading = false;

    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { await this.readLoopDone; } catch { /* already reported */ }

    if (this.writer) {
      // close() alone leaves the writer holding the stream lock, and
      // SerialPort.close() rejects while readable or writable is locked -
      // which would leave the port open and unopenable next time.
      try { await this.writer.close(); } catch { /* already gone */ }
      try { this.writer.releaseLock(); } catch { /* already released */ }
      this.writer = null;
    }
    try {
      await port.close();
    } catch (e) {
      this.h.onLog(`Error closing port: ${(e as Error).message}`, "err");
    }

    this.port = null;
    this.h.onDisconnected(reason);
  }

  private async write(payload: Uint8Array): Promise<boolean> {
    if (!this.port?.writable) return false;
    try {
      this.writer ??= this.port.writable.getWriter();
      await this.writer.write(payload);
      this.txBytes += payload.length;
      return true;
    } catch (e) {
      this.h.onLog(`Write error: ${(e as Error).message}`, "err");
      return false;
    }
  }

  /**
   * `quiet` suppresses the echo line in the log. Used by the `acc` poller,
   * which would otherwise write three lines a second into the terminal.
   */
  async writeLine(text: string, eol: string, quiet = false): Promise<void> {
    if (await this.write(new TextEncoder().encode(text + eol)) && !quiet) {
      this.h.onLog(`> ${text}`, "tx");
    }
  }

  async writeByte(code: number, label: string): Promise<void> {
    if (await this.write(new Uint8Array([code]))) {
      this.h.onLog(`[${label}]`, "tx");
    }
  }

  async setSignals(dtr: boolean, rts: boolean): Promise<void> {
    if (!this.port) return;
    try {
      await this.port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
    } catch (e) {
      // Not every driver supports modem control lines.
      this.h.onLog(`Could not set DTR/RTS: ${(e as Error).message}`, "err");
    }
  }
}

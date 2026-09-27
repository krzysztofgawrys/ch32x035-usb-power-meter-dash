import { describe, expect, it, vi } from "vitest";
import { SerialSession, portLabel, type SerialConfig, type SerialHandlers } from "./serial.js";

const CONFIG: SerialConfig = {
  baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none",
};

/** Minimal stand-in for a SerialPort whose streams the test drives. */
function fakePort() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({ write: (c) => { written.push(c); } });

  const port = {
    readable: readable as ReadableStream<Uint8Array> | null,
    writable: writable as WritableStream<Uint8Array> | null,
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    setSignals: vi.fn(async () => {}),
    getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0xfe0c }),
  };
  return { port: port as unknown as SerialPort, ctrl: () => ctrl, written, raw: port };
}

function handlers() {
  const logs: { text: string; kind: string }[] = [];
  const h: SerialHandlers = {
    onData: vi.fn(),
    onLog: (text, kind) => { logs.push({ text, kind }); },
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onPortsChanged: vi.fn(),
  };
  return { h, logs };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("SerialSession", () => {
  it("opens with exactly the requested settings", async () => {
    const { port, raw } = fakePort();
    const { h } = handlers();
    const s = new SerialSession(h);
    await s.connect(port, CONFIG);

    expect(raw.open).toHaveBeenCalledWith(expect.objectContaining({
      baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none",
    }));
    expect(s.isOpen).toBe(true);
    // 1a86 is WCH, so the label names the vendor rather than a bare hex pair.
    expect(h.onConnected).toHaveBeenCalledWith("WCH 1a86:fe0c", CONFIG);
  });

  it("delivers received chunks", async () => {
    const { port, ctrl } = fakePort();
    const { h } = handlers();
    const s = new SerialSession(h);
    await s.connect(port, CONFIG);

    ctrl().enqueue(new TextEncoder().encode("4.8,1,2,3\r\n"));
    await settle();
    expect(h.onData).toHaveBeenCalledOnce();
    await s.disconnect("test");
  });

  /**
   * Regression: the read loop used to exit silently when the stream went away,
   * leaving the session "connected" with nothing reading. The only way out was
   * the Disconnect button, so the log blamed the user for a device fault.
   */
  it("reports a stream that closes under it instead of going quiet", async () => {
    const { port, ctrl } = fakePort();
    const { h } = handlers();
    const s = new SerialSession(h);
    await s.connect(port, CONFIG);

    ctrl().close();                 // device stops the stream on its own
    await settle();

    expect(h.onDisconnected).toHaveBeenCalledWith("stream closed by the device");
    expect(s.isOpen).toBe(false);
  });

  it("does not spin when the stream ends while the port stays readable", async () => {
    const { port, ctrl } = fakePort();
    const { h } = handlers();
    const s = new SerialSession(h);
    await s.connect(port, CONFIG);

    const before = performance.now();
    ctrl().close();
    await settle();
    // A hot loop re-acquiring the reader would burn the whole settle window.
    expect(performance.now() - before).toBeLessThan(200);
    expect(s.isOpen).toBe(false);
  });

  it("closes the port on an explicit disconnect and reports the reason", async () => {
    const { port, raw } = fakePort();
    const { h } = handlers();
    const s = new SerialSession(h);
    await s.connect(port, CONFIG);
    await s.disconnect("closed from the toolbar");

    expect(raw.close).toHaveBeenCalledOnce();
    expect(h.onDisconnected).toHaveBeenCalledWith("closed from the toolbar");
    expect(s.isOpen).toBe(false);
  });

  /** SerialPort.close() rejects while a stream is still locked. */
  it("releases the writer lock so the port can be reopened", async () => {
    const { port, raw } = fakePort();
    const { h } = handlers();
    const s = new SerialSession(h);
    await s.connect(port, CONFIG);

    await s.writeLine("mode fast", "\n");
    await s.disconnect("test");

    expect(raw.close).toHaveBeenCalledOnce();
    expect(raw.writable!.locked).toBe(false);
  });

  it("explains an open failure and names the settings it tried", async () => {
    const { port, raw } = fakePort();
    const { h, logs } = handlers();
    raw.open = vi.fn(async () => {
      throw new DOMException("Failed to open serial port.", "NetworkError");
    });

    const s = new SerialSession(h);
    await s.connect(port, { ...CONFIG, baudRate: 921600 });

    const all = logs.map((l) => l.text).join("\n");
    expect(all).toContain("attempted: WCH 1a86:fe0c @ 921600 baud, 8N1, flow none");
    expect(s.isOpen).toBe(false);
  });

  it("stays quiet when the user dismisses the port picker", async () => {
    const { h, logs } = handlers();
    const s = new SerialSession(h);
    // No port passed and no navigator.serial in this environment: requestPort
    // throws, and a dismissed picker must not be reported as an error.
    await s.connect(null, CONFIG).catch(() => {});
    expect(logs.filter((l) => l.kind === "err" && l.text.includes("Failed to open"))).toHaveLength(0);
  });
});

describe("portLabel", () => {
  const port = (vid: number, pid: number) =>
    ({ getInfo: () => ({ usbVendorId: vid, usbProductId: pid }) }) as unknown as SerialPort;

  it("names the vendor when it is known", () => {
    expect(portLabel(port(0x1a86, 0xfe0c))).toBe("WCH 1a86:fe0c");
    expect(portLabel(port(0x0403, 0x6001))).toBe("FTDI 0403:6001");
  });

  it("falls back to bare ids for an unknown vendor", () => {
    expect(portLabel(port(0xdead, 0xbeef))).toBe("USB dead:beef");
  });

  it("copes with a port that reports no USB ids at all", () => {
    expect(portLabel({ getInfo: () => ({}) } as unknown as SerialPort)).toBe("serial port");
  });
});

/**
 * The terminal pane: raw byte buffer, text and hex renderers, and the inline
 * prompt that replaces a separate input box.
 */

import {
  ACC_ECHO, SAMPLE_CHARS, looksLikeSampleFragment, matchAcc, matchSample, normaliseEol,
  type EolCarrier,
} from "./parse.js";

const MAX_LINES = 5000;              // lines kept in the DOM
const MAX_BUFFER = 4 * 1024 * 1024;  // raw bytes kept for replay and .bin export
const MAX_PENDING = 8192;            // chunks buffered while paused

export interface Chunk {
  readonly t: number;
  readonly data: Uint8Array;
}

export type LineKind = "sys" | "err" | "tx" | "sample" | null;

interface Line {
  el: HTMLDivElement;
  txt: HTMLSpanElement;
}

/**
 * Every renderer must implement all four methods. This used to be a comment,
 * and the one time a renderer skipped `breakLine` the hex view duplicated a
 * partial row above and below each system message.
 */
interface Renderer {
  reset(): void;
  feed(chunk: Chunk): void;
  /** Called once per render batch, to reveal anything still open. */
  endBatch(): void;
  /** Finalise an unfinished line so a system message can be inserted after it. */
  breakLine(): void;
}

const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const escapeCtrl = (s: string): string =>
  s.replace(CTRL, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export type ViewMode = "text" | "hex";

export class TerminalView {
  echoSamples = false;
  /** While the acc poller runs, keep its echo and replies out of the log. */
  hideAccPolling = false;
  autoScroll = true;
  paused = false;
  eol = "\n";

  /** Set by the owner; called when the user submits a line at the prompt. */
  onSubmit: (text: string) => void = () => {};
  onControl: (code: number, label: string) => void = () => {};

  private chunks: Chunk[] = [];
  private chunksHead = 0;          // oldest live entry; avoids O(n) Array.shift
  private bufferedBytes = 0;
  private pending: Chunk[] = [];
  private frame = 0;

  private curLine: Line | null = null;
  private renderer: Renderer;
  private readonly text: TextRenderer;
  private readonly hex: HexRenderer;

  private promptText = "";
  private promptLine: Line | null = null;
  private promptEnabled = false;
  private history: string[] = [];
  private historyIdx = -1;

  constructor(private readonly out: HTMLElement) {
    this.text = new TextRenderer(this);
    this.hex = new HexRenderer(this);
    this.renderer = this.text;
    this.renderer.reset();
    this.bindKeys();
  }

  /* ---- line primitives, shared by both renderers ---- */

  newLine(t: number, cls: LineKind): Line {
    const el = document.createElement("div");
    el.className = "line" + (cls ? " " + cls : "");
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = fmtTime(t);
    const txt = document.createElement("span");
    txt.className = "txt";
    el.append(ts, txt);
    this.out.appendChild(el);
    return { el, txt };
  }

  getCurLine(): Line | null { return this.curLine; }
  setCurLine(l: Line | null): void { this.curLine = l; }

  sysLine(text: string, kind: LineKind = "sys"): void {
    this.renderer.breakLine();
    const l = this.newLine(Date.now(), kind);
    l.txt.textContent = text;
    this.trim();
    this.refreshPrompt();
    this.scrollIfFollowing();
  }

  private trim(): void {
    let extra = this.out.childElementCount - MAX_LINES;
    while (extra-- > 0) {
      const first = this.out.firstElementChild;
      if (!first) break;
      // Never leave a renderer holding a reference to a detached element.
      if (this.curLine?.el === first) this.curLine = null;
      if (this.text.liveEl?.el === first) this.text.liveEl = null;
      this.out.removeChild(first);
    }
  }

  private scrollIfFollowing(): void {
    if (this.autoScroll) this.out.scrollTop = this.out.scrollHeight;
  }

  /* ---- ingest ---- */

  push(chunk: Chunk): void {
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.data.length;
    while (this.bufferedBytes > MAX_BUFFER && this.chunks.length - this.chunksHead > 1) {
      this.bufferedBytes -= this.chunks[this.chunksHead++]!.data.length;
    }
    if (this.chunksHead > 8192) {
      this.chunks = this.chunks.slice(this.chunksHead);
      this.chunksHead = 0;
    }

    this.pending.push(chunk);
    if (this.pending.length > MAX_PENDING * 2) {
      this.pending = this.pending.slice(-MAX_PENDING);
    }

    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.flush();
      });
    }
  }

  flush(): void {
    if (this.paused || !this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    for (const chunk of batch) this.renderer.feed(chunk);
    this.renderer.endBatch();
    this.trim();
    this.refreshPrompt();
    this.scrollIfFollowing();
  }

  get heldChunks(): number { return this.paused ? this.pending.length : 0; }

  setMode(mode: ViewMode): void {
    this.renderer = mode === "hex" ? this.hex : this.text;
    this.rerender();
  }

  /** Redraws the whole pane from the raw byte buffer. */
  rerender(): void {
    this.out.textContent = "";
    this.curLine = null;
    this.promptLine = null;
    this.renderer.reset();
    for (let k = this.chunksHead; k < this.chunks.length; k++) {
      this.renderer.feed(this.chunks[k]!);
    }
    this.renderer.endBatch();
    this.pending = [];
    this.trim();
    this.refreshPrompt();
    this.out.scrollTop = this.out.scrollHeight;
  }

  clear(): void {
    this.chunks = [];
    this.chunksHead = 0;
    this.pending = [];
    this.bufferedBytes = 0;
    this.rerender();
  }

  /* ---- exports ---- */

  logText(withTimestamps: boolean): string {
    return [...this.out.children]
      .filter((line) => !line.classList.contains("input"))
      .map((line) => {
        const ts = withTimestamps ? (line.querySelector(".ts")?.textContent ?? "") + " " : "";
        return ts + (line.querySelector(".txt")?.textContent ?? "");
      })
      .join("\r\n");
  }

  rawBytes(): Uint8Array<ArrayBuffer> {
    let total = 0;
    for (let k = this.chunksHead; k < this.chunks.length; k++) total += this.chunks[k]!.data.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (let k = this.chunksHead; k < this.chunks.length; k++) {
      const d = this.chunks[k]!.data;
      out.set(d, off);
      off += d.length;
    }
    return out;
  }

  /* ---- inline prompt ---- */

  setPromptEnabled(on: boolean): void {
    this.promptEnabled = on;
    if (!on) {
      this.promptText = "";
      this.promptLine?.el.remove();
      this.promptLine = null;
      return;
    }
    this.refreshPrompt();
    this.out.focus();
  }

  /** Rebuilds the prompt and moves it back to the end of the log. */
  private refreshPrompt(): void {
    if (!this.promptEnabled) return;
    if (!this.promptLine) {
      const el = document.createElement("div");
      el.className = "line input";
      const ts = document.createElement("span");
      ts.className = "ts";
      // Blank stand-in keeps the prompt aligned with timestamped lines.
      ts.textContent = "            ";
      const txt = document.createElement("span");
      txt.className = "txt";
      el.append(ts, txt);
      this.promptLine = { el, txt };
    }
    this.promptLine.txt.textContent = "> " + this.promptText;
    this.out.appendChild(this.promptLine.el);   // appendChild moves an existing node
  }

  private bindKeys(): void {
    this.out.addEventListener("keydown", (e) => {
      if (!this.promptEnabled) return;

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+C copies when there is a selection, otherwise it is the
        // interrupt every serial device expects. Logged, never silent.
        if (e.key === "c" && !window.getSelection()?.toString()) {
          e.preventDefault();
          this.onControl(0x03, "Ctrl+C 0x03");
        } else if (e.key === "l") {
          e.preventDefault();
          this.clear();
        }
        return;   // Ctrl+V, Ctrl+A and copy-with-selection stay with the browser
      }

      switch (e.key) {
        case "Enter": this.submit(); break;
        case "Backspace": this.promptText = this.promptText.slice(0, -1); this.refreshPrompt(); break;
        case "Escape": this.promptText = ""; this.refreshPrompt(); break;
        case "ArrowUp": this.recall(-1); break;
        case "ArrowDown": this.recall(1); break;
        default:
          if (e.key.length !== 1) return;   // F5, PageUp, Tab and friends pass through
          this.promptText += e.key;
          this.refreshPrompt();
          break;
      }
      e.preventDefault();
      this.out.scrollTop = this.out.scrollHeight;
    });

    this.out.addEventListener("paste", (e) => {
      if (!this.promptEnabled) return;
      e.preventDefault();
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text) return;
      // A multi-line paste behaves like typing those lines and pressing Enter
      // after each, which is how pasting a command block is meant to work.
      const lines = text.split(/\r\n|\r|\n/);
      const last = lines.pop() ?? "";
      for (const line of lines) {
        this.promptText += line;
        this.submit();
      }
      if (last) {
        this.promptText += last;
        this.refreshPrompt();
        this.out.scrollTop = this.out.scrollHeight;
      }
    });
  }

  private submit(): void {
    const text = this.promptText;
    this.promptText = "";
    this.onSubmit(text);
    if (text && this.history[this.history.length - 1] !== text) this.history.push(text);
    this.historyIdx = this.history.length;
    this.refreshPrompt();
  }

  private recall(delta: number): void {
    if (!this.history.length) return;
    this.historyIdx = Math.min(this.history.length, Math.max(0, this.historyIdx + delta));
    this.promptText = this.history[this.historyIdx] ?? "";
    this.refreshPrompt();
  }
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Assembles lines in memory and only materialises them into the DOM once they
 * are complete and known not to be measurement data.
 *
 * Appending to a live DOM element as bytes arrive and deleting it afterwards
 * works at 7 samples/s, but the device's fast mode makes it create and destroy
 * thousands of elements per second for rows that are never meant to be seen.
 */
class TextRenderer implements Renderer, EolCarrier {
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private partial = "";
  private partialT = 0;
  liveEl: Line | null = null;
  pendingCR = false;

  constructor(private readonly view: TerminalView) {}

  reset(): void {
    this.decoder = new TextDecoder("utf-8", { fatal: false });
    this.partial = "";
    this.liveEl = null;
    this.pendingCR = false;
    this.view.setCurLine(null);
  }

  breakLine(): void {
    // Route through emit so a system line interrupting a measurement row does
    // not push half of it into the log.
    if (this.partial) this.emit(this.partial, this.partialT);
    this.partial = "";
    this.liveEl = null;
    this.view.setCurLine(null);
  }

  feed(chunk: Chunk): void {
    let s = this.decoder.decode(chunk.data, { stream: true });
    if (!s) return;
    s = normaliseEol(this, s);
    if (!s) return;
    if (!this.partial) this.partialT = chunk.t;

    const parts = (this.partial + s).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.emit(line, this.partialT);
      this.partialT = chunk.t;
    }
  }

  private emit(text: string, t: number): void {
    if (this.view.hideAccPolling && (ACC_ECHO.test(text) || matchAcc(text))) {
      this.liveEl?.el.remove();
      this.liveEl = null;
      return;
    }
    // Half a measurement row is not worth showing either: it carries no usable
    // number and would otherwise litter the log once per acc poll.
    if (!this.view.echoSamples && looksLikeSampleFragment(text)) {
      this.liveEl?.el.remove();
      this.liveEl = null;
      return;
    }
    if (matchSample(text)) {
      if (!this.view.echoSamples) {
        this.liveEl?.el.remove();
        this.liveEl = null;
        return;
      }
      this.show(text, t, true);
      return;
    }
    this.show(text, t, false);
  }

  private show(text: string, t: number, isSample: boolean): void {
    const target = this.liveEl ?? this.view.newLine(t, isSample ? "sample" : null);
    target.txt.textContent = escapeCtrl(text);
    if (isSample) target.el.classList.add("sample");
    this.liveEl = null;
  }

  /**
   * A fragment that could still turn into a measurement row is held back. At
   * 4000 samples/s a chunk boundary lands mid-row almost every frame, and
   * showing it means a half-finished line of digits flickering at the bottom
   * of the log continuously. Holding it costs nothing: if the line turns out
   * not to be a sample it is drawn the moment it completes.
   */
  endBatch(): void {
    if (!this.partial) {
      this.liveEl?.el.remove();
      this.liveEl = null;
      return;
    }
    if (!this.view.echoSamples && SAMPLE_CHARS.test(this.partial)) {
      this.liveEl?.el.remove();
      this.liveEl = null;
      return;
    }
    this.liveEl ??= this.view.newLine(this.partialT, null);
    this.liveEl.txt.textContent = escapeCtrl(this.partial);
  }
}

class HexRenderer implements Renderer {
  private offset = 0;
  private row: number[] = [];
  private rowStart = 0;
  private rowTime = 0;

  constructor(private readonly view: TerminalView) {}

  reset(): void {
    this.offset = 0;
    this.row = [];
    this.view.setCurLine(null);
  }

  /** Hex rows are painted as bytes arrive, so there is nothing to reveal. */
  endBatch(): void {}

  breakLine(): void {
    if (this.row.length) {
      this.paint(false);
      this.row = [];
    }
    this.view.setCurLine(null);
  }

  feed(chunk: Chunk): void {
    for (const b of chunk.data) {
      if (this.row.length === 0) {
        this.rowStart = this.offset;
        this.rowTime = chunk.t;
      }
      this.row.push(b);
      this.offset++;
      if (this.row.length === 16) this.paint(true);
    }
    if (this.row.length) this.paint(false);
  }

  private paint(complete: boolean): void {
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) {
      hex.push(i < this.row.length ? HEX[this.row[i]!]! : "  ");
      if (i === 7) hex.push("");
    }
    const ascii = this.row
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    const text = `${this.rowStart.toString(16).padStart(8, "0")}  ${hex.join(" ")}  |${ascii}|`;

    let cur = this.view.getCurLine();
    if (!cur) {
      cur = this.view.newLine(this.rowTime, null);
      cur.el.classList.add("hex");
      this.view.setCurLine(cur);
    }
    cur.txt.textContent = text;
    if (complete) {
      this.view.setCurLine(null);
      this.row = [];
    }
  }
}

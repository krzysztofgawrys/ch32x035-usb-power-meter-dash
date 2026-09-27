/**
 * Button panel for the device's shell, an alternative to typing in the
 * terminal. Built from the catalogue in commands.ts.
 *
 * It sits directly above the terminal, which is where replies appear - so the
 * panel needs no output of its own. It used to keep a short feed, back when a
 * tab hid the terminal from view.
 */

import { CONTROL_GROUPS, selectCommand, type Control } from "./commands.js";

/** How long a dangerous button stays armed after the first click. */
const CONFIRM_MS = 3000;

export class ControlPanel {
  private readonly interactive: (HTMLButtonElement | HTMLSelectElement)[] = [];

  /** Set by the owner; sends a command line to the device. */
  onCommand: (command: string) => void = () => {};

  constructor(host: HTMLElement) {
    const grid = document.createElement("div");
    grid.className = "control-grid";

    for (const group of CONTROL_GROUPS) {
      const section = document.createElement("section");
      section.className = "control-group";
      const title = document.createElement("h3");
      title.textContent = group.title;
      section.appendChild(title);

      const row = document.createElement("div");
      row.className = "control-row";
      for (const control of group.controls) row.appendChild(this.build(control));
      section.appendChild(row);
      grid.appendChild(section);
    }

    host.appendChild(grid);
    this.setEnabled(false);
  }

  private build(control: Control): HTMLElement {
    if (control.kind === "select") {
      const wrap = document.createElement("label");
      wrap.className = "control-select";
      wrap.title = control.hint;
      const span = document.createElement("span");
      span.textContent = control.label;
      const select = document.createElement("select");
      select.id = `cmd-${control.id}`;
      // A placeholder so choosing the first real option still fires a change,
      // and so the control never claims to know the device's current setting.
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "...";
      select.appendChild(placeholder);
      for (const opt of control.options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
      }
      select.addEventListener("change", () => {
        if (!select.value) return;
        this.onCommand(selectCommand(control, select.value));
        select.value = "";
      });
      wrap.append(span, select);
      this.interactive.push(select);
      return wrap;
    }

    const button = document.createElement("button");
    button.id = `cmd-${control.id}`;
    button.textContent = control.label;
    button.title = control.hint;
    if (control.danger) button.classList.add("danger");

    let armed = 0;
    button.addEventListener("click", () => {
      if (!control.danger) {
        this.onCommand(control.command);
        return;
      }
      // Two-step: these reboot the device or wipe calibration, and the panel
      // puts them one stray click away from everything else.
      if (armed && Date.now() < armed) {
        armed = 0;
        button.textContent = control.label;
        button.classList.remove("armed");
        this.onCommand(control.command);
        return;
      }
      armed = Date.now() + CONFIRM_MS;
      button.textContent = "Sure?";
      button.classList.add("armed");
      setTimeout(() => {
        if (!armed) return;
        armed = 0;
        button.textContent = control.label;
        button.classList.remove("armed");
      }, CONFIRM_MS);
    });

    this.interactive.push(button);
    return button;
  }

  setEnabled(on: boolean): void {
    for (const el of this.interactive) el.disabled = !on;
  }
}

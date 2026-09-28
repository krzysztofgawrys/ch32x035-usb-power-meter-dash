/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it } from "vitest";
import { confirmDialog, isDialogOpen } from "./dialog.js";

const dlg = () => document.querySelector("dialog.app-dialog") as HTMLDialogElement | null;
const button = (label: string) =>
  [...document.querySelectorAll("dialog.app-dialog button")]
    .find((b) => b.textContent === label) as HTMLButtonElement;

const OPTS = { title: "Discard the current capture?", body: "1,234 samples are unsaved." };

afterEach(() => {
  dlg()?.close("cancel");
  document.body.innerHTML = "";
});

describe("confirmDialog", () => {
  it("opens as a modal and shows what it was given", async () => {
    const answer = confirmDialog(OPTS);
    const d = dlg()!;
    expect(d.open).toBe(true);
    expect(d.querySelector("h2")?.textContent).toBe(OPTS.title);
    expect(d.querySelector("p")?.textContent).toBe(OPTS.body);
    button("Cancel").click();
    await answer;
  });

  it("resolves true only when the confirming button is used", async () => {
    const yes = confirmDialog({ ...OPTS, confirmLabel: "Discard and start" });
    button("Discard and start").click();
    expect(await yes).toBe(true);

    const no = confirmDialog(OPTS);
    button("Cancel").click();
    expect(await no).toBe(false);
  });

  /** Esc leaves returnValue empty, which must not read as consent. */
  it("resolves false when dismissed with Esc", async () => {
    const answer = confirmDialog(OPTS);
    dlg()!.close();                 // what the platform does on Esc
    expect(await answer).toBe(false);
  });

  it("resolves false on a backdrop click", async () => {
    const answer = confirmDialog(OPTS);
    const d = dlg()!;
    d.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await answer).toBe(false);
  });

  it("ignores a click inside the dialog, which is not the backdrop", async () => {
    const answer = confirmDialog(OPTS);
    const d = dlg()!;
    d.querySelector("h2")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(d.open).toBe(true);
    button("Cancel").click();
    expect(await answer).toBe(false);
  });

  /**
   * A destructive prompt opens on the safe option, so someone leaning on Enter
   * dismisses the dialog instead of wiping the capture.
   */
  it("focuses Cancel for a destructive action and OK otherwise", async () => {
    // Asserted as "which one is focused", not against `autofocus === false`:
    // happy-dom leaves the property undefined when it was never assigned,
    // where a browser reflects it as false.
    const focused = () =>
      [...document.querySelectorAll<HTMLButtonElement>("dialog.app-dialog button")]
        .filter((b) => b.autofocus)
        .map((b) => b.textContent);

    const a = confirmDialog({ ...OPTS, danger: true });
    expect(focused()).toEqual(["Cancel"]);
    expect(button("OK").className).toBe("danger");
    button("Cancel").click();
    await a;

    const b = confirmDialog(OPTS);
    expect(focused()).toEqual(["OK"]);
    expect(button("OK").className).toBe("primary");
    button("Cancel").click();
    await b;
  });

  it("takes the element out of the DOM once answered", async () => {
    const answer = confirmDialog(OPTS);
    expect(dlg()).not.toBeNull();
    button("Cancel").click();
    await answer;
    expect(dlg()).toBeNull();
    expect(isDialogOpen()).toBe(false);
  });

  /**
   * Double-clicking Start would otherwise stack a second dialog in the top
   * layer and bury the first. Declining the phantom is the safe answer.
   */
  it("refuses to stack a second dialog", async () => {
    const first = confirmDialog(OPTS);
    expect(isDialogOpen()).toBe(true);
    expect(await confirmDialog({ ...OPTS, title: "second" })).toBe(false);
    expect(document.querySelectorAll("dialog.app-dialog")).toHaveLength(1);
    expect(dlg()!.querySelector("h2")?.textContent).toBe(OPTS.title);
    button("Cancel").click();
    await first;
  });

  it("renders the body as text, never as markup", async () => {
    const answer = confirmDialog({ title: "t", body: "<img src=x onerror=boom>" });
    const p = dlg()!.querySelector("p")!;
    expect(p.querySelector("img")).toBeNull();
    expect(p.textContent).toBe("<img src=x onerror=boom>");
    button("Cancel").click();
    await answer;
  });
});

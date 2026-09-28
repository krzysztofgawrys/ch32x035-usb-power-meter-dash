/**
 * Modal confirmation drawn by the app instead of by the browser.
 *
 * `confirm()` was doing this job and doing it correctly, but it looks like a
 * browser chrome dialog bolted onto a dark instrument panel, and it blocks the
 * main thread - which here means the sample stream stops being read for as
 * long as the box is up.
 *
 * Built on the native `<dialog>` element rather than a hand-rolled overlay, so
 * modality, the top layer, focus trapping, Esc-to-dismiss and inertness of the
 * page behind all come from the platform. Web Serial already restricts this
 * app to Chromium, so there is no support question to answer.
 */

export interface ConfirmOptions {
  title: string;
  /** Plain text, inserted as text - never as markup. */
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirming button as destructive and focuses Cancel instead. */
  danger?: boolean;
}

/** Value set on close by the confirming button; anything else means "no". */
const CONFIRM = "confirm";

/**
 * True while a dialog is up. A second one would stack in the top layer and
 * bury the first, and the only way to get here is an impatient double click on
 * Start - where declining the phantom is the safe answer.
 */
let open = false;

export function isDialogOpen(): boolean { return open; }

export function confirmDialog(opts: ConfirmOptions, doc: Document = document): Promise<boolean> {
  if (open) return Promise.resolve(false);
  open = true;

  const dlg = doc.createElement("dialog");
  dlg.className = "app-dialog";

  const h = doc.createElement("h2");
  h.textContent = opts.title;

  const p = doc.createElement("p");
  // textContent, not innerHTML: the body carries counts and device replies,
  // and nothing in this app has any business rendering those as markup.
  p.textContent = opts.body;

  const row = doc.createElement("div");
  row.className = "dialog-actions";

  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.textContent = opts.cancelLabel ?? "Cancel";
  cancel.addEventListener("click", () => dlg.close("cancel"));

  const ok = doc.createElement("button");
  ok.type = "button";
  ok.textContent = opts.confirmLabel ?? "OK";
  ok.className = opts.danger ? "danger" : "primary";
  ok.addEventListener("click", () => dlg.close(CONFIRM));

  // Destructive actions open with the safe option focused, so a stray Enter
  // dismisses rather than confirms.
  (opts.danger ? cancel : ok).autofocus = true;

  row.append(cancel, ok);
  dlg.append(h, p, row);
  doc.body.appendChild(dlg);

  // A click landing on the dialog element itself is a click on the backdrop:
  // the padding belongs to the inner elements, so the element's own box is
  // only ever hit outside them.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close("cancel");
  });

  return new Promise<boolean>((resolve) => {
    // "close" covers every route out, including Esc, which leaves returnValue
    // empty and so resolves false.
    dlg.addEventListener("close", () => {
      open = false;
      dlg.remove();
      resolve(dlg.returnValue === CONFIRM);
    }, { once: true });

    dlg.showModal();
  });
}

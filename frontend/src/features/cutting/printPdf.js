// Shows the rendered label(s) as PNGs in a visible preview modal and prints
// via our own window.print() — used by both the commit flow's printPdf
// event and History's Reprint button, so there's one print path, not two.
//
// This used to render the label as a PDF in a hidden iframe and call
// iframe.contentWindow.print() on it. That failed two different ways in
// Digit's embedded iframe, both confirmed directly (not assumed):
//   1. contentWindow.print()/.focus() threw "Blocked a frame with origin
//      ... from accessing a cross-origin frame" — reaching into the PDF
//      iframe's contentWindow across Chrome's PDF-viewer process boundary.
//   2. Even after removing that call (a visible iframe, never scripted),
//      Chrome refused to instantiate its PDF viewer inside the iframe at
//      all, showing its own "This page has been blocked by Chrome"
//      placeholder. Reproduced independently: a minimal sandboxed iframe
//      matching Digit's exact sandbox list blocks a nested PDF-typed blob
//      every time, while the identical setup with an image/PNG blob or a
//      text/plain blob loads fine. Chrome's PDF viewer is an out-of-process
//      "guest view" that doesn't work under any sandboxed ancestor,
//      regardless of which sandbox tokens are present — allow-same-origin
//      grants script/DOM access, not permission for that guest view.
//      window.open() to a top-level tab hits the identical block, because a
//      popup opened from a sandboxed frame inherits its opener's sandbox
//      unless allow-popups-to-escape-sandbox is also present (confirmed by
//      adding just that token in isolation and watching the same PDF go
//      from blocked to fully rendering) — Digit's sandbox doesn't have it,
//      and that's not something this repo can change.
//
// The fix: never involve Chrome's PDF viewer. @napi-rs/canvas already
// produces a PNG raster before the PDF ever wraps it (see
// backend/.../print/artifact.js), so the backend now sends that PNG
// directly. An <img> isn't plugin/guest-view content, so it isn't subject
// to any of the above. Printing goes through our own top-level
// window.print(), which is same-document and was already confirmed
// reachable — no cross-frame call of any kind.
//
// @page { size: ...; margin: 0 } is a real guarantee for exact label size
// and zero margin, but a narrower one than the old PDF path: it's a request
// to the browser's print pipeline, and an operator's print dialog set to
// "Fit to page" (or a non-default paper size/scale) can still override it.
// The PDF path couldn't be overridden that way — a PDF page has one true
// size. Worth knowing, not a blocker.

// Tracks the currently open modal's teardown so a second print closes the
// first instead of stacking backdrops, leaking blob URLs, or leaving a
// stale print stylesheet in <head>.
let closeActive = null;

/**
 * @param {Array<{ pngBase64: string, widthIn: number, heightIn: number, label?: string }>} pages
 *   One entry per tag — a commit's working-piece + remnant become two
 *   entries here (still one Print click, two printed pages); reprint is a
 *   one-entry array.
 */
export function printLabelPages(pages, { onError, labelName } = {}) {
  try {
    closeActive?.();

    if (!pages || !pages.length) throw new Error("No rendered label to print");

    const urls = pages.map((p) => {
      const binary = atob(p.pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      return URL.createObjectURL(blob);
    });

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeydown);
      backdrop.remove();
      printStyle.remove();
      printArea.remove();
      urls.forEach((u) => URL.revokeObjectURL(u));
      if (closeActive === cleanup) closeActive = null;
    }
    function onKeydown(e) {
      if (e.key === "Escape") cleanup();
    }
    closeActive = cleanup;

    // --- On-screen preview modal -------------------------------------
    const backdrop = document.createElement("div");
    backdrop.className = "print-modal-backdrop";
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup();
    });

    const modal = document.createElement("div");
    modal.className = "print-modal";

    const header = document.createElement("div");
    header.className = "print-modal-header";

    const title = document.createElement("span");
    title.className = "print-modal-title";
    title.textContent = labelName ? `Print — ${labelName}` : "Print label";

    const btnGroup = document.createElement("div");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "var(--space-2)";

    const printBtn = document.createElement("button");
    printBtn.className = "btn btn--primary";
    printBtn.textContent = "Print";
    printBtn.addEventListener("click", () => window.print());

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn btn--secondary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", cleanup);

    btnGroup.append(printBtn, closeBtn);
    header.append(title, btnGroup);

    const hint = document.createElement("div");
    hint.className = "print-modal-hint";
    hint.textContent =
      pages.length > 1
        ? `Click Print to print all ${pages.length} tags — each prints as its own page.`
        : "Click Print to print this tag.";

    const preview = document.createElement("div");
    preview.className = "print-modal-preview";
    pages.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "print-preview-card";

      const img = document.createElement("img");
      img.className = "print-preview-img";
      img.src = urls[i];
      img.alt = p.label || `Label ${i + 1}`;
      img.onerror = () => {
        cleanup();
        onError?.(new Error("Failed to load the rendered label image"));
      };

      const caption = document.createElement("div");
      caption.className = "print-preview-caption";
      caption.textContent = p.label || `Page ${i + 1}`;

      card.append(img, caption);
      preview.append(card);
    });

    modal.append(header, hint, preview);
    backdrop.append(modal);
    document.body.append(backdrop);
    document.addEventListener("keydown", onKeydown);

    // --- Print-only DOM ------------------------------------------------
    // Hidden on screen, the only thing visible when printing. @page size
    // comes from the template's own labelWidthIn/labelHeightIn (every tag
    // here shares one template, Carpet-Roll-Tag, so one @page rule sized
    // from the first page covers all of them — never hardcoded).
    const { widthIn, heightIn } = pages[0];
    const printStyle = document.createElement("style");
    printStyle.textContent = `
      .print-labels-output { display: none; }
      @media print {
        @page { size: ${widthIn}in ${heightIn}in; margin: 0; }
        body > *:not(.print-labels-output) { display: none !important; }
        .print-labels-output { display: block !important; }
        .print-labels-output .print-page {
          width: ${widthIn}in;
          height: ${heightIn}in;
          page-break-after: always;
          break-after: page;
        }
        .print-labels-output .print-page:last-child {
          page-break-after: auto;
          break-after: auto;
        }
        .print-labels-output .print-page img {
          width: 100%;
          height: 100%;
          display: block;
        }
      }
    `;
    document.head.append(printStyle);

    const printArea = document.createElement("div");
    printArea.className = "print-labels-output";
    pages.forEach((p, i) => {
      const pageDiv = document.createElement("div");
      pageDiv.className = "print-page";
      const img = document.createElement("img");
      img.src = urls[i];
      pageDiv.append(img);
      printArea.append(pageDiv);
    });
    document.body.append(printArea);
  } catch (err) {
    onError?.(err);
  }
}

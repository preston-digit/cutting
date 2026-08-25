// Opens a base64-encoded PDF as a visible in-page preview so the operator
// can print it from the PDF viewer's own controls — used by both the
// commit flow's printPdf event and History's Reprint button, so there's one
// print path, not two.
//
// This deliberately never calls .print()/.focus() on the PDF iframe's
// contentWindow. Confirmed by direct diagnosis (not assumed): the working
// piece + remnant PDF renders and loads fine, but when this app runs
// embedded in Digit's UI, Chrome throws
//   "Blocked a frame with origin '...' from accessing a cross-origin frame"
// from exactly that call. Digit's embedding iframe's sandbox was inspected
// directly and does carry allow-same-origin (and allow-popups, allow-modals)
// — so this isn't a missing permission we can ask Digit to grant. Chrome
// renders PDFs in a separate process, and reaching across that process
// boundary via a sandboxed parent's contentWindow is blocked regardless.
// The fix is to never make that call: show the PDF in a visible modal and
// let the operator print it from the browser's own PDF viewer toolbar
// (visible print/download icons Chrome renders on the PDF itself), or via
// the browser's native print shortcut. Both tags are on one multi-page PDF
// (see backend/.../print/artifact.js), so this stays one action for two
// labels — the operator prints the whole document once.
//
// Loads the PDF directly as a real application/pdf blob resource, never
// wrapped in an HTML page — Chrome's "headers and footers" page decoration
// only applies to printing an HTML page; printing an actual PDF resource
// prints exactly what's on the page, edge to edge, which is what makes the
// backend's zero-margin, exact-label-size PDF come out looking like a label
// instead of a document.

// Tracks the currently open modal's teardown so a second print (e.g. a
// quick reprint right after a commit) closes the first instead of stacking
// backdrops and leaking the first one's blob URL.
let closeActiveModal = null;

export function printPdfBase64(base64, { onError, labelName } = {}) {
  try {
    closeActiveModal?.();

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeydown);
      backdrop.remove();
      URL.revokeObjectURL(url);
      if (closeActiveModal === cleanup) closeActiveModal = null;
    }
    function onKeydown(e) {
      if (e.key === "Escape") cleanup();
    }
    closeActiveModal = cleanup;

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

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn btn--secondary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", cleanup);

    header.append(title, closeBtn);

    const hint = document.createElement("div");
    hint.className = "print-modal-hint";
    hint.textContent = "Use the print icon in the viewer below to print — both tags are on one document.";

    const frameWrap = document.createElement("div");
    frameWrap.className = "print-modal-frame-wrap";

    const iframe = document.createElement("iframe");
    iframe.className = "print-modal-frame";
    iframe.title = labelName ? `Print preview — ${labelName}` : "Print preview";
    iframe.onerror = () => {
      cleanup();
      onError?.(new Error("Failed to load the rendered PDF for printing"));
    };
    iframe.src = url;

    frameWrap.append(iframe);
    modal.append(header, hint, frameWrap);
    backdrop.append(modal);
    document.body.append(backdrop);
    document.addEventListener("keydown", onKeydown);
  } catch (err) {
    onError?.(err);
  }
}

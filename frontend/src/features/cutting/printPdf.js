// Opens a base64-encoded PDF as a real PDF resource and triggers the
// browser's native print dialog for it — used by both the commit flow's
// printPdf event and History's Reprint button, so there's one print path,
// not two.
//
// This must load the PDF directly (a hidden iframe pointed at a
// `application/pdf` blob URL), never wrap it in an HTML page. Chrome's
// "headers and footers" page decoration (title/URL on top, date/page-number
// on bottom) only applies when printing an HTML page — printing an actual
// PDF resource prints exactly what's on the page, edge to edge, which is
// what makes the backend's zero-margin, exact-label-size PDF (see
// backend/src/features/cutting/print/artifact.js) come out looking like a
// label instead of a document.
export function printPdfBase64(base64, { onError } = {}) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.border = "0";
    iframe.src = url;

    const cleanup = () => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      URL.revokeObjectURL(url);
    };

    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (err) {
        cleanup();
        onError?.(err);
        return;
      }
      // The print dialog is synchronous-ish in most browsers but there's no
      // reliable "print finished" event for a cross-document print() call —
      // give the operator plenty of time to see the dialog before tearing
      // the iframe down.
      setTimeout(cleanup, 60_000);
    };
    iframe.onerror = () => {
      cleanup();
      onError?.(new Error("Failed to load the rendered PDF for printing"));
    };

    document.body.appendChild(iframe);
  } catch (err) {
    onError?.(err);
  }
}

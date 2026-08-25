// Turns rendered label canvases (see ../labelRenderer.js) into a
// downloadable/printable byte artifact. One drawing pass, two output
// formats: PDF just embeds the same PNG raster(s), one per page, sized
// exactly to each label's own labelWidthIn x labelHeightIn — no separate
// vector-drawing implementation to keep in sync with the renderer.
//
// PDFKit adds no header, footer, or page-number decoration of its own —
// every page is exactly the label artwork, edge to edge, zero margin. The
// "document-shaped" printout (timestamp/scancode header, Digit-URL footer,
// "1/1" page number) some ops saw before this pipeline existed came from
// printing an HTML page (Chrome's default page decoration only applies to
// HTML print, never to a PDF opened and printed as a PDF) — the frontend's
// browser-print flow must always open this file as a real PDF resource
// (see print/sink.js's BrowserPrintSink), never wrap it in an HTML page,
// or that decoration comes back.
import PDFDocument from "pdfkit";

const POINTS_PER_INCH = 72;
const inToPt = (inches) => inches * POINTS_PER_INCH;

/**
 * @param {Array<{ canvas: import("@napi-rs/canvas").Canvas, widthIn: number, heightIn: number }>} pages
 *   One entry per page, in order — a commit's working-piece + remnant tags
 *   become a single multi-page PDF this way (one print-dialog confirmation,
 *   not two), a preview/reprint is just a one-entry array.
 * @param {{ title?: string }} [opts] - PDF metadata title, shown by the
 *   print dialog/PDF viewer in place of this file's URL.
 * @returns {Promise<Buffer>}
 */
export async function renderLabelPdf(pages, { title } = {}) {
  if (!pages.length) throw new Error("renderLabelPdf requires at least one page");
  const first = pages[0];
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [inToPt(first.widthIn), inToPt(first.heightIn)],
      margin: 0,
      info: title ? { Title: title } : undefined,
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    pages.forEach((page, i) => {
      const widthPt = inToPt(page.widthIn);
      const heightPt = inToPt(page.heightIn);
      if (i > 0) doc.addPage({ size: [widthPt, heightPt], margin: 0 });
      doc.image(page.canvas.toBuffer("image/png"), 0, 0, { width: widthPt, height: heightPt });
    });
    doc.end();
  });
}

/**
 * Single-canvas convenience wrapper — used by the standalone preview route
 * and by reprint, where there's always exactly one label.
 * @param {import("@napi-rs/canvas").Canvas} canvas
 * @param {"pdf"|"png"} format
 * @param {{ widthIn: number, heightIn: number, title?: string }} size
 * @returns {Promise<Buffer>}
 */
export async function canvasToArtifact(canvas, format, { widthIn, heightIn, title }) {
  if (format === "png") return canvas.toBuffer("image/png");
  if (format === "pdf") return renderLabelPdf([{ canvas, widthIn, heightIn }], { title });
  throw new Error(`Unknown label artifact format "${format}" — use "pdf" or "png"`);
}

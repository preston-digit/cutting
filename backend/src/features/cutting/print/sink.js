// PrintSink interface — the one thing the renderer/print pipeline writes
// to, so a real network printer implementation drops in later without
// touching labelRenderer.js, the commit flow, or the preview route.
//
// Every sink implements:
//   async deliver({ buffer, format, meta }) -> { delivered: true, detail }
// `buffer` is the rendered artifact (see artifact.js), `format` is
// "pdf"|"png", `meta` is caller context (labelName, inventoryId, scancode,
// stationName, ...) for logging/error messages. A sink that can't deliver
// MUST throw, not return `delivered: false` — the commit flow's runStep
// treats a thrown error as that step's failure, same as every other step.
export class ArtifactSink {
  // Hands the artifact straight back — used for the standalone
  // preview/download route only. Not used by commit/reprint since
  // BrowserPrintSink below is the default there.
  async deliver({ buffer, format, meta }) {
    return {
      delivered: true,
      detail: `Rendered ${format.toUpperCase()} (${buffer.length} bytes)${meta?.labelName ? ` for ${meta.labelName}` : ""}`,
      buffer,
      format,
    };
  }
}

// Default sink — the printer models at the customer's stations are unknown,
// so there's no socket/ZPL client to target yet (see NetworkPrinterSink).
// Instead this hands the rendered PDF back to the caller exactly like
// ArtifactSink does; the difference is purely what the caller (routes.js)
// does with it — for commit/reprint, the bytes get shipped to the frontend,
// which opens the OS/browser print dialog with the PDF loaded so the
// operator picks whatever printer is physically at their station. Nothing
// here talks to a printer directly.
export class BrowserPrintSink {
  async deliver({ buffer, format, meta }) {
    return {
      delivered: true,
      detail: `Rendered ${format.toUpperCase()} (${buffer.length} bytes)${meta?.labelName ? ` for ${meta.labelName}` : ""} — sent to the browser print dialog`,
      buffer,
      format,
    };
  }
}

// Printer address and station selection are config, never hardcoded — see
// stations.js. Symbology/encoded-value are already isolated in barcode.js;
// wiring an actual printer protocol here is a separate protocol choice
// later (ZPL over raw socket is the most likely fit for label printers),
// not a renderer or commit-flow change. Selectable today only by
// registering a station with a printer address — see resolveSinkForStation.
export class NetworkPrinterSink {
  constructor({ address }) {
    if (!address) throw new Error("NetworkPrinterSink requires a printer address");
    this.address = address;
  }

  async deliver({ buffer, format, meta }) {
    throw new Error(
      `Printing to ${this.address} is not implemented yet (stub NetworkPrinterSink) — would have sent a ` +
        `${format.toUpperCase()} (${buffer.length} bytes)${meta?.labelName ? ` for ${meta.labelName}` : ""}. ` +
        `Implement a ZPL or raw-socket client in this class; nothing else in the print pipeline changes.`
    );
  }
}

/**
 * Resolves the sink for a station row (see stations.js). BrowserPrintSink
 * is the default — a station is optional for it, the operator picks a
 * printer in the dialog. Only a station with a printer address configured
 * switches this to NetworkPrinterSink, which genuinely needs that address.
 *
 * The frontend no longer has a station picker — CutScreen.jsx's commit
 * flow and History's reprint both call this with no argument, so
 * BrowserPrintSink is the only sink that actually runs today.
 * NetworkPrinterSink, the print_stations table, and the /stations routes
 * are kept in place (not deleted) for exactly this function to pick back
 * up once a real printer's address is known — nothing here needs to change
 * to wire that back in, only a caller needs to start passing a station
 * again.
 */
export function resolveSinkForStation(station) {
  if (station?.printerAddress) return new NetworkPrinterSink({ address: station.printerAddress });
  return new BrowserPrintSink();
}

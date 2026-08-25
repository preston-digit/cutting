// Live barcode generation — isolated deliberately.
//
// The Carpet-Roll-Tag template's own "barCode" object is a pre-rendered PNG
// frozen at whatever moment the template was last saved in Digit's Label
// Designer (see SCHEMA_NOTES.md's "Label templates" section). Rendering
// that raster verbatim would print the exact same barcode on every tag —
// wrong, and it would still scan as whatever it was frozen to. The
// renderer (labelRenderer.js) must NEVER emit that stored image; it always
// calls generateBarcodePng() here instead, live, per print.
//
// Neither the symbology nor which field it encodes is confirmed against
// Digit's own print pipeline (see SCHEMA_NOTES.md — the schema exposes only
// a raster, not a symbology+value pair). BARCODE_CONFIG is the single,
// isolated place either changes: swapping symbology or the encoded field is
// a config edit here, never a change to the renderer or the print route.
import bwipjs from "bwip-js";

export const BARCODE_CONFIG = {
  // bwip-js "bcid" — default is a considered choice, not a confirmed fact.
  symbology: "code128",
  // Given the inventory shape routes.js's withParsedDimensions() produces
  // (or the raw Digit Inventory, which has the same field), returns the
  // string this barcode encodes. Default: Digit's own scanCodeSerialNumber
  // — the same value /api/cutting/scan/:serial resolves by exact match, so
  // a freshly printed tag scans straight back into this app.
  encode: (inventory) => inventory.scancode ?? inventory.scanCodeSerialNumber ?? null,
};

/**
 * Renders a barcode PNG for `value` using BARCODE_CONFIG.symbology. Returns
 * a Buffer sized to its natural symbology dimensions — the renderer stretches
 * it to fit the template object's own width/height box via drawImage, so no
 * fixed pixel size is requested here. Logs the encoded value on every call
 * (per the build spec — this is the one place that value is decided).
 */
export async function generateBarcodePng(value) {
  if (!value) throw new Error("generateBarcodePng: no value to encode (source inventory has no scanCodeSerialNumber yet)");
  console.log(`[label barcode] encoding "${value}" as ${BARCODE_CONFIG.symbology}`);
  return bwipjs.toBuffer({
    bcid: BARCODE_CONFIG.symbology,
    text: value,
    scale: 3,
    height: 12, // mm, bar height excluding text
    includetext: false,
  });
}

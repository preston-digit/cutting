// Renders the Carpet-Roll-Tag label from the LIVE layoutJson (see
// labelTemplate.js) against a specific inventory record — driven by
// whatever is on the template at render time, not a hand-copied layout. If
// someone edits the template in Digit's Label Designer, the next render
// (after the template cache's short TTL) reflects it automatically.
//
// Fidelity note: this walks Fabric.js's serialized object format closely
// enough to reproduce this org's real Carpet-Roll-Tag (verified against a
// live render, see SCHEMA_NOTES.md), but it is not a general Fabric.js
// renderer. Known gaps, both harmless for this template today but worth
// knowing if the template changes substantially:
//   - Per-character `styles[]` range overrides (used by Fabric's rich text)
//     are not applied — a whole text object draws at its base fontSize.
//   - Only "left"/"top" and "center"/"center" origin combinations are
//     handled (the only two present on this template); anything else logs
//     a warning and falls back to treating the object as top-left origin.
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digitRequest } from "../../core/digit.js";
import { getLabelTemplateForItem } from "./labelTemplate.js";
import { getCustomFieldNameById, rawCustomFieldValue, itemUom } from "./digitOps.js";
import { generateBarcodePng, BARCODE_CONFIG } from "./barcode.js";

const DPI = 96; // matches the Designer canvas's own coordinate space 1:1 (labelWidthIn * 96 == observed object x-extents)
const FONT_FAMILY = "DejaVu Sans"; // closest open stand-in for the template's "Arial, sans-serif"

// Vendored in-repo (backend/assets/fonts/, see LICENSE there) rather than
// relying on the OS having DejaVu installed — Heroku's buildpack dyno has no
// fonts at all, and without one registered every text field on a label
// renders as silent blank space (see backend/Dockerfile's history). Both
// weights are registered under the same family name so `ctx.font = "bold
// ...DejaVu Sans"` (below) resolves to the actual bold face rather than a
// synthetic/faux bold. Runs once at module load, so it's in effect for both
// the server (routes.js imports this at startup) and standalone scripts
// (e.g. smoke-cut.js) that import this module directly.
const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/fonts");
GlobalFonts.registerFromPath(path.join(FONTS_DIR, "DejaVuSans.ttf"), FONT_FAMILY);
GlobalFonts.registerFromPath(path.join(FONTS_DIR, "DejaVuSans-Bold.ttf"), FONT_FAMILY);

const ORG_QUERY = `query { organization { id name logo } }`;

function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

/**
 * Reserved native binding keys — every one the Carpet-Roll-Tag template
 * uses (see SCHEMA_NOTES.md's binding list). Each resolves to the exact
 * display VALUE for that binding (not the field label — showFieldName
 * handling happens in resolveObjectText, uniformly, from fieldLabel).
 */
function resolveNativeBinding(bindingKey, { item, inventory, organization, quantityOverride }) {
  switch (bindingKey) {
    case "orgName":
      return organization?.name ?? "";
    case "item":
      return item?.name ?? "";
    case "internalSku":
      return item?.sku ?? "";
    case "lotNumber":
      return inventory?.lotNumber ?? "";
    case "quantity": {
      // quantityOverride exists for exactly one caller: the commit flow's
      // working-piece tag. pickJobItem zeroes the working piece's
      // quantityInStock (that quantity now lives on the job, not the
      // label) — printing that live value would put "Quantity 0 ft²" on a
      // tag for a piece that's physically the full cut area. The remnant
      // is a real, un-picked label, so it's never passed an override and
      // always shows its own live quantityInStock.
      const uom = itemUom(item);
      const quantity = quantityOverride ?? inventory?.quantityInStock;
      return uom?.symbol ? `${quantity ?? ""} ${uom.symbol}` : String(quantity ?? "");
    }
    case "createdDate":
      return shortDate(inventory?.createdAt);
    case "labelNumber":
      return inventory?.scanCodeNumber != null ? `Label #${inventory.scanCodeNumber}` : "";
    case "detailSerialNumber":
      return inventory?.scanCodeSerialNumber ?? "";
    default:
      return null; // not a reserved key — caller checks cf_ prefix next
  }
}

async function resolveObjectText(obj, ctx) {
  const { item, inventory, organization, quantityOverride } = ctx;
  if (obj.stampType === "customText") return obj.customText ?? "";

  const native = resolveNativeBinding(obj.bindingKey, { item, inventory, organization, quantityOverride });
  let value;
  if (native != null) {
    value = native;
  } else if (obj.customFieldId) {
    // Deliberately the UNSTRIPPED stored value (never
    // readInventoryCustomFields — that strips "Owner: "/"Piece Type: "
    // prefixes for screen display only). The printed tag must match what
    // Digit's own Reprint of this template produces, and Digit prints the
    // raw stored value verbatim ("Piece Type: Remnant", "Owner: The Dixie
    // Group") — see digitOps.js's rawCustomFieldValue.
    const fieldName = await getCustomFieldNameById(obj.customFieldId);
    value = fieldName ? rawCustomFieldValue(inventory, fieldName) ?? "" : "";
  } else {
    console.warn(`[label render] unresolvable text binding "${obj.bindingKey}" — rendering blank`);
    value = "";
  }

  return obj.showFieldName && obj.fieldLabel ? `${obj.fieldLabel}\n${value}` : String(value);
}

function objectRect(obj) {
  const renderedW = (obj.width || 0) * (obj.scaleX ?? 1);
  const renderedH = (obj.height || 0) * (obj.scaleY ?? 1);
  const originX = obj.originX || "left";
  const originY = obj.originY || "top";
  if (!["left", "center"].includes(originX) || !["top", "center"].includes(originY)) {
    console.warn(`[label render] unhandled origin (${originX}, ${originY}) on "${obj.bindingKey}" — treating as top-left`);
  }
  const left = originX === "center" ? obj.left - renderedW / 2 : obj.left;
  const top = originY === "center" ? obj.top - renderedH / 2 : obj.top;
  return { left, top, width: renderedW, height: renderedH };
}

function drawText(ctx, obj, text) {
  ctx.fillStyle = obj.fill || "#000000";
  ctx.font = `${obj.fontWeight === "bold" ? "bold " : ""}${obj.fontSize || 14}px ${FONT_FAMILY}`;
  ctx.textBaseline = "top";
  ctx.textAlign = obj.textAlign === "center" ? "center" : obj.textAlign === "right" ? "right" : "left";
  const lineHeight = (obj.fontSize || 14) * (obj.lineHeight || 1.16);
  const lines = String(text).split("\n");
  lines.forEach((line, i) => ctx.fillText(line, obj.left, obj.top + i * lineHeight));
}

async function drawImageObject(ctx, obj, buffer) {
  const img = await loadImage(buffer);
  const { left, top, width, height } = objectRect(obj);
  ctx.drawImage(img, left, top, width, height);
}

/**
 * Renders the Carpet-Roll-Tag for one inventory record. `item` is the
 * Digit Item (needs id/name/sku/defaultStockUom); `inventory` is the raw
 * Digit Inventory (needs quantityInStock/scanCodeNumber/scanCodeSerialNumber/
 * lotNumber/createdAt/customFields). `quantityOverride`, if given, replaces
 * `inventory.quantityInStock` on the printed "quantity" binding only — for
 * the commit flow's working-piece tag, where pickJobItem has already
 * zeroed the label's live quantity (see resolveNativeBinding's "quantity"
 * case). Leave unset for anything showing a label's own real quantity
 * (remnants, previews, anything not mid-pick). Returns { canvas, widthIn,
 * heightIn, encodedBarcodeValue, resolvedBindings } — resolvedBindings is a
 * plain {bindingKey: value} map for logging/preview, not part of the
 * artifact.
 */
export async function renderLabel({ item, inventory, quantityOverride }) {
  const template = await getLabelTemplateForItem(item.id);
  if (!template) {
    throw new Error(`No manual-inventory label template configured for item "${item.name}" (${item.id})`);
  }

  const orgData = await digitRequest(ORG_QUERY);
  const organization = orgData.organization;

  const widthPx = Math.round(template.widthIn * DPI);
  const heightPx = Math.round(template.heightIn * DPI);
  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthPx, heightPx);

  const ctxData = { item, inventory, organization, quantityOverride };
  const resolvedBindings = {};
  let encodedBarcodeValue = null;

  for (const obj of template.objects) {
    if (obj.stampType === "barcode") {
      const value = BARCODE_CONFIG.encode(inventory);
      encodedBarcodeValue = value;
      resolvedBindings[obj.bindingKey] = `<barcode: ${value}>`;
      const buffer = await generateBarcodePng(value);
      await drawImageObject(ctx, obj, buffer);
      continue;
    }

    if (obj.stampType === "boundImage") {
      // Only orgLogo appears on this template — resolved live from
      // Organization.logo, never the frozen `src` baked into layoutJson at
      // template-save time.
      const src = obj.bindingKey === "orgLogo" ? organization?.logo : obj.src;
      resolvedBindings[obj.bindingKey] = src;
      if (src) await drawImageObject(ctx, obj, src);
      continue;
    }

    // text / customText
    const text = await resolveObjectText(obj, ctxData);
    resolvedBindings[obj.bindingKey] = text;
    drawText(ctx, obj, text);
  }

  return {
    canvas,
    widthIn: template.widthIn,
    heightIn: template.heightIn,
    encodedBarcodeValue,
    resolvedBindings,
  };
}

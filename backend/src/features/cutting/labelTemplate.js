// Reads the "Carpet-Roll-Tag" label template definition from Digit. READ
// ONLY — see SCHEMA_NOTES.md's "Label templates" section for the full
// introspection trail. There is no mutation anywhere in the schema that
// touches layoutJson or any CustomLabel* type, and nothing in this file (or
// anywhere else in this app) may ever write to one. Editing the template
// itself is done by a human in Digit's own Label Designer UI — this module
// only ever reads it back.
//
// Also: no query fetches a template by id/name directly — the only
// reachable paths in the whole schema are Item.defaultCustomLabelConfigurations
// / Item.allowedProductionLabels and Shipment.defaultCustomerLabel. This app
// only needs the `manualInventory` slot (that's what's bound to
// "Carpet-Roll-Tag" on every roll-goods item, live-confirmed 2026-08-24), so
// it's fetched per-item, the same way Digit's own UI would resolve it.
import { digitRequest } from "../../core/digit.js";

const TEMPLATE_QUERY = `
  query ($itemId: ID!) {
    item(itemId: $itemId) {
      defaultCustomLabelConfigurations {
        manualInventory {
          id
          labelName
          status
          type
          layoutJson
        }
      }
    }
  }
`;

// Short TTL, not a permanent snapshot — per the build spec: if someone edits
// the template in Digit's Label Designer, printing should pick that up on
// the next read shortly after, not stay stale for the life of the process.
const TEMPLATE_CACHE_TTL_MS = 60_000;
const templateCache = new Map(); // itemId -> { fetchedAt, template }

/**
 * Fetches and parses the live `manualInventory` label template bound to an
 * item (this org's "Carpet-Roll-Tag" on every roll-goods item). Returns
 * null if the item has no manual-inventory label configured. Throws if the
 * template's layoutJson isn't valid JSON — better to fail loudly than print
 * garbage.
 */
export async function getLabelTemplateForItem(itemId) {
  const cached = templateCache.get(itemId);
  if (cached && Date.now() - cached.fetchedAt < TEMPLATE_CACHE_TTL_MS) {
    return cached.template;
  }

  const data = await digitRequest(TEMPLATE_QUERY, { itemId });
  const config = data.item?.defaultCustomLabelConfigurations?.manualInventory;
  if (!config) {
    templateCache.set(itemId, { fetchedAt: Date.now(), template: null });
    return null;
  }

  let layout;
  try {
    layout = JSON.parse(config.layoutJson);
  } catch (err) {
    throw new Error(`Label template "${config.labelName}" (item ${itemId}) has unparseable layoutJson: ${err.message}`);
  }

  const template = {
    id: config.id,
    labelName: config.labelName,
    status: config.status,
    widthIn: layout.labelWidthIn,
    heightIn: layout.labelHeightIn,
    objects: layout.objects || [],
  };
  templateCache.set(itemId, { fetchedAt: Date.now(), template });
  return template;
}

/** Test/ops hook — drop the cache immediately instead of waiting out the TTL. */
export function clearLabelTemplateCache() {
  templateCache.clear();
}

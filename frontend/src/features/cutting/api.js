// Typed helpers over core/api.js for the CUTTING feature. The frontend never
// sends GraphQL — every call here hits one of our own allowlisted Express
// routes (backend/src/features/cutting/routes.js).
import { apiRequest } from "../../core/api.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4001";

export const getQueue = () => apiRequest("/api/cutting/queue");

export const getWorkOrder = (workOrderId) => apiRequest(`/api/cutting/work-orders/${workOrderId}`);

export const scanSerial = (serial, workOrderId) =>
  apiRequest(
    `/api/cutting/scan/${encodeURIComponent(serial)}${workOrderId ? `?workOrderId=${encodeURIComponent(workOrderId)}` : ""}`
  );

// Returns { matchType, results } — see backend/src/features/cutting/routes.js.
export const searchInventory = (q, workOrderId) =>
  apiRequest(
    `/api/cutting/search?q=${encodeURIComponent(q)}${workOrderId ? `&workOrderId=${encodeURIComponent(workOrderId)}` : ""}`
  );

export const searchBins = (q) => apiRequest(`/api/cutting/bins?q=${encodeURIComponent(q || "")}`);

export const getDefaultBin = () => apiRequest("/api/cutting/bins/default");

export const completeWorkOrder = (workOrderId, completedQuantity) =>
  apiRequest(`/api/cutting/work-orders/${workOrderId}/complete`, {
    method: "POST",
    body: JSON.stringify({ completedQuantity }),
  });

export const getHistory = (limit = 50) => apiRequest(`/api/cutting/history?limit=${limit}`);

// Print stations — printer address stays server-side; this only ever
// returns { id, name, hasPrinter }.
export const getStations = () => apiRequest("/api/cutting/stations");

export const createStation = (name, printerAddress) =>
  apiRequest("/api/cutting/stations", {
    method: "POST",
    body: JSON.stringify({ name, printerAddress }),
  });

// No stationId — reprint always goes through BrowserPrintSink (see
// backend/src/features/cutting/print/sink.js's resolveSinkForStation).
export const reprintLabel = (cutEventId, piece) =>
  apiRequest(`/api/cutting/history/${cutEventId}/reprint`, {
    method: "POST",
    body: JSON.stringify({ piece }),
  });

export const getAvailableMaterial = (workOrderId, cutWidth, cutLength) => {
  const params = new URLSearchParams();
  if (cutWidth) params.set("cutWidth", cutWidth);
  if (cutLength) params.set("cutLength", cutLength);
  const qs = params.toString();
  return apiRequest(`/api/cutting/work-orders/${workOrderId}/available-material${qs ? `?${qs}` : ""}`);
};

/**
 * Streams the commit checklist as it executes. Calls onEvent(line) for each
 * NDJSON line the backend writes (one per step, plus a final "summary"
 * line), in order, as they arrive — not after the whole response finishes.
 */
export async function commitCut(workOrderId, payload, onEvent) {
  const res = await fetch(`${API_URL}/api/cutting/work-orders/${workOrderId}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.body) {
    // Fallback for environments without streaming fetch bodies.
    const text = await res.text();
    for (const line of text.trim().split("\n").filter(Boolean)) onEvent(JSON.parse(line));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer.trim()));
}

// Typed helpers over core/api.js for the CUTTING feature. The frontend never
// sends GraphQL — every call here hits one of our own allowlisted Express
// routes (backend/src/features/cutting/routes.js).
import { apiRequest } from "../../core/api.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4001";

export const getQueue = () => apiRequest("/api/cutting/queue");

export const getWorkOrder = (workOrderId) => apiRequest(`/api/cutting/work-orders/${workOrderId}`);

export const scanSerial = (serial) =>
  apiRequest(`/api/cutting/scan/${encodeURIComponent(serial)}`);

export const searchInventory = (q) =>
  apiRequest(`/api/cutting/search?q=${encodeURIComponent(q)}`);

export const searchBins = (q) => apiRequest(`/api/cutting/bins?q=${encodeURIComponent(q || "")}`);

export const getDefaultBin = () => apiRequest("/api/cutting/bins/default");

export const completeWorkOrder = (workOrderId, completedQuantity) =>
  apiRequest(`/api/cutting/work-orders/${workOrderId}/complete`, {
    method: "POST",
    body: JSON.stringify({ completedQuantity }),
  });

export const getHistory = (limit = 50) => apiRequest(`/api/cutting/history?limit=${limit}`);

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

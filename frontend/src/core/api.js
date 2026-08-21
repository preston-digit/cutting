// API client base — REUSABLE CORE. The browser only ever talks to OUR backend;
// it never holds the Digit token and never sends GraphQL. Features build their
// own typed helpers on top of apiRequest().
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4001";

export async function apiRequest(path, options) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const health = () => apiRequest("/api/health");

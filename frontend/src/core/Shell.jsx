import { useState } from "react";
import { getView } from "./registry.js";

// FROZEN URL: true SPA, no router, no History API, no hash/query navigation. The
// current view is an in-memory state object; changing it re-renders. A refresh
// resets to the home view (acceptable). The only thing read from the URL is a
// cosmetic `?pm=<name>`, passed to every view.
function readCosmeticPm() {
  return new URLSearchParams(window.location.search).get("pm") || "";
}

export function Shell({ home }) {
  // view = { name, params }
  const [view, setView] = useState({ name: home, params: {} });
  const [pm] = useState(readCosmeticPm);

  // nav(name, params) is how views move around — no URL is ever touched.
  const nav = (name, params = {}) => setView({ name, params });

  const View = getView(view.name);
  if (!View) {
    return <div style={{ padding: "var(--space-4)" }}>Unknown view: {view.name}</div>;
  }
  return <View nav={nav} pm={pm} {...view.params} />;
}

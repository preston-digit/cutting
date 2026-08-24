import { useEffect, useState } from "react";
import { getView } from "./registry.js";

// FROZEN URL: true SPA, no router, no History API, no hash/query navigation. The
// current view is an in-memory state object; changing it re-renders. A refresh
// resets to the home view (acceptable). The only thing read from the URL is a
// cosmetic `?pm=<name>`, passed to every view.
function readCosmeticPm() {
  return new URLSearchParams(window.location.search).get("pm") || "";
}

const THEME_STORAGE_KEY = "erp.theme";

// Dark is the original/default look (design-tokens.css's bare :root) — no
// stored preference means no data-theme attribute, which resolves to dark.
function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_STORAGE_KEY) || "dark");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);
  return [theme, setTheme];
}

export function Shell({ home }) {
  // view = { name, params }
  const [view, setView] = useState({ name: home, params: {} });
  const [pm] = useState(readCosmeticPm);
  const [theme, setTheme] = useTheme();

  // nav(name, params) is how views move around — no URL is ever touched.
  const nav = (name, params = {}) => setView({ name, params });

  const View = getView(view.name);
  return (
    <>
      <button
        className="theme-toggle"
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        aria-label="Toggle color theme"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
      {View ? (
        <View nav={nav} pm={pm} {...view.params} />
      ) : (
        <div style={{ padding: "var(--space-4)" }}>Unknown view: {view.name}</div>
      )}
    </>
  );
}

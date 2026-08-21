// View registry — REUSABLE CORE. Features register their screens by name; the
// Shell renders the current one. This keeps the SPA router-free (see Shell.jsx).
const views = {};

export function registerView(name, component) {
  if (views[name]) console.warn(`View "${name}" is already registered; overwriting.`);
  views[name] = component;
}

export function getView(name) {
  return views[name];
}

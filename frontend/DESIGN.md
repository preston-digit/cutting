# Design conventions

This module embeds inside Digit's ERP shell. It must look native and impose no
outer chrome.

## Rules

- **Pinned tokens.** All colors, spacing, type, and sizing come from
  [`src/core/design-tokens.css`](src/core/design-tokens.css). Never hardcode values per
  screen and never re-style components case-by-case.
- **Dark theme.** Near-black page background, slightly lighter card/table
  surfaces, subtle 1px dividers. Inter font, ~56px table rows
  (`--row-height`), status pills, muted secondary text.
- **No outer chrome.** No app bar, no page background frame, no sidebar
  frame — the host ERP shell provides all of that. The module renders only
  its own content (a page can still have its own in-content sidebar panel,
  e.g. the cut screen's source-roll summary — that's page layout, not chrome).
- **Status pills.** Use `.pill .pill--green|--blue|--purple|--neutral`
  (green = completed, blue = not-started/info, purple = priority, plain red
  text via `.negative` for negative numbers — not a pill).
- **Page header pattern** (mirrors Digit's work order detail): `.breadcrumb`
  top-left, `.page-title-row` with the id as `.page-title` plus an inline
  pill, `.page-subtitle` for the "Created by X on date" muted line, then
  `.tab-row` / `.tab` / `.tab--active` underneath.
- **Right sidebar panel:** `.sidebar-item-card` (icon + name + SKU), then a
  `.progress-bar-row` (`.progress-bar-track`/`.progress-bar-fill`) for
  "X / Y", then a `.kv-list` of `.kv-row`/`.kv-label`/`.kv-value` — muted
  labels, white values, `.link` for in-line navigation.
- **Tables:** `.table-head-row` (muted, sortable columns) + `.row` (56px, no
  zebra striping, `.col-checkbox` far left), `.filter-tabs`/`.filter-tab` as
  rounded segmented buttons above.
- **Quantities** in Digit's mono-leaning style: wrap the number+unit in
  `.mono` (e.g. `<span class="mono">600 ft²</span>`).
- **Buttons:** `.btn--primary` (filled light, icon + label) / `.btn--secondary`
  (outlined dark) / `.btn--danger`.
- **Commit checklist:** `.checklist`/`.checklist-item` with
  `.checklist-icon--pending|running|ok|error|skipped` for the live per-step
  status the cut screen shows during commit.

## Adding a screen

Compose existing tokens and the `.row` / `.pill` primitives. If a new value is
genuinely needed, add a token here first, then consume it — don't inline it.

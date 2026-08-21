# Design conventions

This module embeds inside Digit's ERP shell. It must look native and impose no
outer chrome.

## Rules

- **Pinned tokens.** All colors, spacing, type, and sizing come from
  [`src/core/design-tokens.css`](src/core/design-tokens.css). Never hardcode values per
  screen and never re-style components case-by-case.
- **Mirror Digit's look.** Inter font, ~40px table rows (`--row-height`), status
  pills, restrained palette.
- **No outer chrome.** No app bar, no page background frame, no sidebar — the
  host ERP shell provides all of that. The module renders only its own content.
- **Status pills.** Use `.pill .pill--active|--pending|--closed`.

## Adding a screen

Compose existing tokens and the `.row` / `.pill` primitives. If a new value is
genuinely needed, add a token here first, then consume it — don't inline it.

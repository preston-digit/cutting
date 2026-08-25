# Digit archive/cleanup candidates

This list is for the customer (Catalyst Carpet Service) to action directly
in Digit's own UI. This app has no archive mechanism for Digit inventory
(no `archived`/status field exists on `Inventory`, no archive bin, no tag
convention — see prior audit) and writes nothing to Digit to resolve any of
these. Nothing below has been modified or deleted by this app.

## 22 orphaned records — no Piece Type set

Live serialized in-stock labels with no Piece Type value at all, audited
2026-08-24. A piece with no Piece Type set is excluded from this app's
source-stock allowlist (constraint: allowlist, not blocklist — see
SCHEMA_NOTES.md) and cannot be selected, scanned, or searched as source
material for a cut, but nothing here has removed the records from Digit.

| Label # | Scancode | Item |
|---|---|---|
| 115 | rcv_178761561950115 | Finch-OCEAN / LINEN |
| 114 | rcv_178761561950114 | Finch-OCEAN / LINEN |
| 113 | rcv_178761561950113 | Finch-OCEAN / LINEN |
| 112 | rcv_178761561950112 | Finch-OCEAN / LINEN |
| 111 | rcv_178761561950111 | Finch-OCEAN / LINEN |
| 110 | rcv_178761561950110 | Finch-OCEAN / LINEN |
| 109 | rcv_178761561950109 | Finch-OCEAN / LINEN |
| 108 | rcv_178761561950108 | Finch-OCEAN / LINEN |
| 107 | rcv_178761561950107 | Finch-OCEAN / LINEN |
| 106 | rcv_178761561950106 | Finch-OCEAN / LINEN |
| 42 | splt_17873540024 | Heirloom / Meadow |
| 36 | splt_17873534933 | Heirloom / Meadow |
| 35 | splt_17873534255 | Heirloom / Meadow |
| 32 | rcv_17873313121232 | Heirloom / Meadow |
| 31 | rcv_17873311741531 | Heirloom / Cobblestone |
| 30 | job_178732752532 | Rug 2x3 |
| 29 | rcv_17872843389229 | Heirloom / Meadow |
| 28 | rcv_17872843389228 | Heirloom / Meadow |
| 27 | rcv_17872842324827 | Heirloom / Slate |
| 26 | rcv_17872838243826 | Heirloom / Cobblestone |
| 25 | rcv_17872838243825 | Heirloom / Cobblestone |
| 16 | job_178702332436 | Rug 5x8 |

## 5 labels created by smoke tests

Real Digit records created by this app's own `smoke-cut.js` verification
runs against the live org (real commits, not dry runs — this script has no
dry-run mode, it performs an actual cut). All against work order MO24 /
item Finch-OCEAN / LINEN.

| Label # | Scancode | Role | Piece Type |
|---|---|---|---|
| 136 | splt_17876173035 | working piece | Cut Rug |
| 137 | splt_17876173039 | remnant | Remnant |
| 138 | splt_17876173142 | working piece (no side remnant — full-width crosscut) | Cut Rug |
| 139 | splt_17876186594 | working piece | Cut Rug |
| 140 | splt_17876186597 | remnant | Remnant |

## 3 parent rolls shortened by smoke tests

Roll Length was written down permanently on the source label each smoke
test cut from, per this app's real crosscut-then-rip commit flow. Roll
Width was unaffected on all three.

| Label # | Scancode | Roll Length before → after | Roll Width |
|---|---|---|---|
| 119 | splt_17876159531 | 10.00 → 7.00 | 4.00 (unchanged) |
| 126 | splt_17876164847 | 2.00 → 1.00 | 8.00 (unchanged) |
| 130 | splt_17876165593 | 2.00 → 1.00 | 8.00 (unchanged) |

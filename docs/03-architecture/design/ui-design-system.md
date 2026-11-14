# UI Design System: "the ledger"

The interface is a bound ledger book, not a SaaS template. Source of truth is `frontend/src/styles.css`;
the [HTML prototype](prototype/erpatio-prototype.html) carries a snapshot of it.

## Direction
- **Reference object:** a columnar ledger book. Cream paper, ruled columns, a red double margin line, a rubber stamp on posted entries.
- **Feeling:** calm, exact, a little old-fashioned. A work tool for bookkeepers who sit in it for hours.
- **One aesthetic only.** No dark mode, no gradients, no shadows. Rules and spacing carry the structure.

## Palette (one neutral base, one ink, one accent used sparingly)
| Token | Hex | Used for |
|---|---|---|
| `--paper` | `#F1EBDD` | page background |
| `--sheet` | `#F8F4E9` | tables, cards, inputs |
| `--ink` | `#1B2430` | text, navigation rail, primary buttons, rules under headings |
| `--accent` (oxblood) | `#A3321F` | margin rule, POSTED stamp, negative or error states, destructive actions. Nothing else |
| `--rule` / `--rule-strong` | `#CDC4AD` / `#A89F88` | row hairlines / table and input borders |
| `--muted` | `#5A5F68` | secondary text |

Measured contrast (WCAG): ink on paper 13.17:1, ink on sheet 14.24:1, oxblood on paper 5.82:1, oxblood on sheet 6.30:1, muted on paper 5.40:1, muted on sheet 5.84:1, cream on ink (rail) 12.46:1, muted-on-ink 5.40:1. Every text pair clears AA (4.5:1) for body text.

## Type (self-hosted via Fontsource, no third-party requests)
| Role | Face | Notes |
|---|---|---|
| Wordmark, page titles, dialog titles | **Young Serif** | 30px, letter-spacing -0.02em |
| Text and controls | **IBM Plex Sans** | 14px base, 400 / 500 / 600 |
| Figures, account codes, references | **IBM Plex Mono** | tabular by nature |

Labels are sentence-case Plex Sans (form labels 13px, section headings 12.5px semibold). **Uppercase mono is reserved for two things**: table column headers and the stamp. Using it everywhere reads as a style setting, not a decision.

## Geometry
- Radius **2px** everywhere. No pills, no circles.
- Borders and rules, never shadows. Tables have ruled columns; the Debit and Credit columns are separated by a vertical rule.
- Totals follow accounting convention: a single rule above, a **double rule** below.
- Negative amounts print in parentheses: `(16,700.00)`. Currency is stated in the column header (PHP), not on every cell.

## Signature details
1. **Margin rule.** A double red line runs down the left of every page, like ruled ledger paper.
2. **The stamp.** `POSTED 14 OCT 2026`, tilted -2.5°, in oxblood mono capitals on every posted entry. Reversed entries add a struck-through `REVERSED`.
3. **Statement with leaders.** The Overview reads like a financial statement with dotted leaders, not a row of KPI tiles.

## Layout
- Asymmetric. Sign-in: a narrow form on paper next to a wide ink panel showing a ledger page. Overview: a 4:5 split between the statement and the latest entries. Density varies on purpose: tight tables, roomy page heads.
- Desktop: a 216px ink rail and a content column capped at 1140px.
- Phone (<= 860px): the rail becomes an off-canvas menu behind a slim top bar; the Reference column is hidden; entry header fields re-flow (date and reference on one row, description full width); totals stay visible; the Ctrl+Enter hint is hidden on touch devices.

## States
Hover, `:active` (1px press), `:focus-visible` (2px ink outline; cream on the ink rail), disabled (40% opacity, `not-allowed`), invalid input (oxblood border), loading (`Loading entries▌` with a blinking cursor, static when reduced motion is requested), empty (plain sentence), error (bordered notice with a 4px left bar).

## Data block
The Overview shows "Where the assets sit": one ruled horizontal bar split by account, in five shades of ink, with a mono legend (name, amount, share). No chart library, no colour, no illustration. Hovering a segment dims the others. It is computed from the trial balance in integer units, so the shares add up.

## Motion (all of it off under `prefers-reduced-motion`)
| Where | What | Why |
|---|---|---|
| Posting or reversing an entry | The POSTED stamp lands on the page: scales down from 1.7x with a tilt, a small rebound, 0.45 s. Plays only when arriving from posting, not on every visit | The one moment that matters should feel final |
| Every page | Content rises 6 px and fades in, staggered by 40 ms | Orients the eye after navigation |
| Tables | Rows fade in with a 30 ms stagger, capped at 8 | Reads like lines being written |
| Asset bar | Segments grow from the left, 60 ms apart | Shows proportion before the numbers are read |
| Sign-in | The ledger page draws in line by line | Sets the ledger metaphor on first contact |
| Navigation links, rows | Hover nudges the link 4 px right; a row gets a 3 px ink marker on its first cell | Custom hover state, no colour change |
| Entry editor | The Difference figure and the status line change as lines balance; the Post button enables only when balanced | State change you can see without reading |
| Buttons | 1 px press on `:active` | Tactile on touch, where hover does not exist |

Hover styles sit inside `@media (hover: hover)`; touch devices get `:active` instead.

## Mobile-first
The stylesheet's base rules are the phone layout; `@media (min-width: 861px)` adds the desktop one.

| Area | Phone (base) | Desktop (>= 861 px) |
|---|---|---|
| Navigation | Slim ink top bar with the wordmark and a Menu button; the rail slides in from the left | Fixed 216 px ink rail |
| Margin rule | 10 px from the left edge | 24 px |
| Overview | One column in reading order: statement, asset bar, latest entries | Two columns, 4:5 |
| Journal list | Reference column hidden; table scrolls sideways if needed | All columns |
| Entry editor | Date and reference share a row; description takes the full width on the next; totals on one line; Cancel and Post below | Date, description, reference in one row; totals and actions in one footer row |
| Inputs | 16 px text and 40 px height (stops iOS zooming in; comfortable touch target) | 14 px text, 34 px height |
| Sign-in | Form first, the ledger panel below it | Narrow form left, wide ink panel right |
| Hint text | The Ctrl+Enter hint is hidden on touch devices | Shown |
| Dialogs | Fill the width minus 32 px | 430 px |

## Copy rules
Plain, specific, no marketing. Say what the system does: "An entry balances before it is saved. A mistake is reversed, never edited." Error text says what to do next. No emoji, no "seamless", no "powered by".

## Accessibility
Semantic landmarks (`aside`, `nav`, `main`), labelled controls, native `<dialog>` for focus trapping and Escape, `role="alert"` on errors and `role="status"` on loading and totals, keyboard path for the whole posting flow (Ctrl+Enter posts), `prefers-reduced-motion` respected.

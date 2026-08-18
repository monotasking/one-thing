# onething Ledger

A dark workbench that behaves like a bound accounts book. Everything is a row with a label
on the left and a figure hanging on the right margin; everything is separated by a hairline,
never by a shadow. The ground is warm ink, not black — paper that has been inked over rather
than a screen switched off. Serif holds the top of the hierarchy and mono holds the bottom,
so the eye tells a *statement* from a *measurement* before reading either. It should feel
like a ledger a careful person keeps, not a dashboard a system emits.

## Direction

Left-aligned, one reading column per pane, air collects on the right. Three surfaces and no
more: app ground, column chrome, raised card. Hairlines do all the dividing; the three shadow
steps exist only for things that genuinely leave the plane. Radii stay at 3–4px — the geometry
is ruled, not rounded. Exactly one filled block per screen.

## Color

Three ramps on one shared perceptual lightness scale (OKLCH, 100 → 900 ascending). On this
dark ground the low steps **recede** — 100–300 are tinted fills and chrome, 400–500 are the
hairlines — and the high steps **advance**: 600–700 the accents and muted ink, 700–900 text.
So `--b-300` is the fill behind a warning and `--b-700` is its ink. The seed's pins land *on*
the scale: bg → `n-200`, surface → `n-300`, text → `n-900`, `#4385BE` → `a-600`, `#D0A215` → `b-700`.

The two accents split by job. **Blue is the actor**: the one filled button, the active tab,
the focus ring — anything the person operates. **Brass is the record**: the selected row's
left rule, the `⟨ WRITE ⟩` bracket label, the date kicker, the 待确认 warning — anything the
system asserts about state. They never appear on the same control.

## Type

Lora 500 headings (CJK → Noto Serif SC), Public Sans text (→ Noto Sans SC), `ui-monospace` for
every path, figure and label. caption 11 · meta 12 · body 14 · body-lg 16 · h4 18 · h3 22 ·
h2 28 · h1 36 · display 48 — tracking negative from h4 up (Lora's fit is set for text, not
36px), positive only in mono kickers at 0.10em, because a Latin kicker track visibly breaks a
CJK 词 apart. Display/48 is defined and deliberately unused: nothing inside a working session earns it.

## Do / Don't

- **Do** put the figure in mono, right-aligned, so numbers form a column you read straight down.
- **Do** use the left 2px rule for selection and the fill for hover — two channels, never one.
- **Do** give status color to the border and the text only.
- **Do** let a section head wear the ledger rule (`.kicker--rule`) so heads and row groups match.
- **Don't** fill a second block. If a screen needs two, one of them is not primary.
- **Don't** shadow a content card; that is what `--rule` is for.
- **Don't** set a kicker below 12px. A label you must lean in for is not a label.
- **Don't** reach past `n-500` for a divider, or below `n-600` for text on a raised card.

Derived from `.design-sync/theme-seeds/onething-ledger.theme.json` (13 parameters).

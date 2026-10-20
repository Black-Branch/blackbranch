# Design standard — text, controls, spacing

How big text is, what a control looks like, and how far apart things sit. Colours are the semantic
roles in `web/app/globals.css` (`scripts/check-tokens.mjs` enforces those too).

## Text scale

One list. Nothing outside it.

| Use | Class | Size |
|---|---|---|
| Tiny labels, counts, units | `text-3xs` | 10px |
| Section titles, hints, small print | `text-2xs` | 11px |
| Interface text: labels, controls, menus | `text-xs` | 12px |
| Body text in panels and cards | `text-sm` | 14px |
| Reading text (about, legal, error pages) | `text-base` | 16px |
| Headings | `text-lg` … `text-3xl` | 18–30px |
| Anything that must grow with the viewer's chat text size | `text-chat-xs` / `sm` / `md` / `lg` (or `var(--text-chat-*)` inline) | relative |

- **Nothing below 10px.** It is not readable on a phone.
- `em` sizes are allowed: they are relative to their parent on purpose (code spans, captions in rich text).
- In CSS, `font-size` takes one of the scale's values (px or the same rem), `var()`, `em`, `%` or `calc()`.

**The build refuses anything else** (`web/scripts/check-tokens.mjs`, tested by `check-tokens.test.mjs`):

- `raw-text-size` — a one-off Tailwind size such as `text-[13px]` or `text-[0.8rem]`.
- `raw-inline-font-size` — `fontSize: 13`, `fontSize: "13px"` or a rem literal in an inline style.
- `raw-css-font-size` — a CSS `font-size` literal that is not on the scale.

Exempt, with the reason in the script: the OBS credit overlay (drawn on a fixed 1920×1080 broadcast
canvas), `opengraph-image.tsx` (rendered to a PNG with no stylesheet) and `global-error.tsx` (renders
when the stylesheet may not have loaded). A genuinely new size means adding it to the scale here and to
`SCALE_PX` in the script — on purpose, in one commit.

## Controls

All settings-style controls come from `web/app/components/SettingsControls.tsx`. Build new ones from
these, not by hand.

- **Selected is always light fill with dark content** — `bg-strong` + `text-on-accent`. A switch that is
  on, the chosen option, the filled part of a slider and the selected saved look all use it. Off /
  unselected is the dark control colour.
- **Height:** every control is 24px (`h-6`); every row is at least 28px (`min-h-7`).
- **Labels:** a slider's label sits in a 112px column (`w-28`) and truncates with the full text as a
  tooltip — it never wraps. Other rows keep the label to at most half the row.
- **`FIELD`** — the one field style for text boxes, the colour hex box and the font picker: 24px,
  `surface-2` fill, `edge` border, 6px radius, a focus ring.
- **Slider** — the `ui-range` class (in `globals.css`): 4px track, filled part in `strong`, 14px light
  thumb. The readout is one fixed-width box with the unit inside it, so every track ends at the same
  place. A word readout ("Auto") explains itself in a tooltip.
- **`Toggle`** — a 36×20 switch: on = light track + dark knob, off = dark track + light knob.
- **`Choice`** — one segmented track for any pick-one row (weights, formats, styles). It wraps inside
  its track only when the options do not fit.
- **Focus:** every control shows a visible ring (`edge-bright`) when reached by keyboard.

The video player and radio volume sliders keep their own look: they sit on video and artwork.

## Spacing

For settings-style lists (the settings menu now; other lists as they are touched):

| Between | Gap |
|---|---|
| A label and its control | 8px |
| One row and the next | 4px |
| A section title and its first row | 6px |
| One section and the next | 16px |

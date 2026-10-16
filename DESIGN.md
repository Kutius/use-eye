# DESIGN.md

## Visual theme and atmosphere

A handheld cinema monitor. The live viewfinder is the interface; near-black instrument chrome sits
over it as flat plates. One vermilion tally light is the only accent. Nothing floats, nothing
glows, nothing is glass. The mood is equipment, not app.

## Colour

| Token | Value | Role |
|---|---|---|
| `--canvas` | `oklch(0.14 0.008 265)` | page ground |
| `--canvas-deep` | `oklch(0.1 0.006 265)` | rails over video, letterbox |
| `--panel` | `oklch(0.19 0.01 265)` | raised plate |
| `--panel-hi` | `oklch(0.24 0.012 265)` | control rest / press |
| `--ink` | `oklch(0.93 0.005 265)` | primary text, main control fill |
| `--ink-dim` | `oklch(0.68 0.01 265)` | secondary text, labels |
| `--ink-faint` | `oklch(0.48 0.012 265)` | idle tally, separators |
| `--tally` | `oklch(0.62 0.21 25)` | vermilion. Streaming light and active state only |

Dark is deliberate: the surface is a camera monitor used beside the thing being filmed, and the
feed must be the brightest object on screen.

## Typography

One family: **Archivo Variable** (`@fontsource-variable/archivo`), engineered grotesque with a wide
weight range. Tabular figures on every readout.

| Role | Size | Weight | Tracking |
|---|---|---|---|
| Wordmark | clamp 40–84px | 620 | −0.035em |
| Statement | 22px | 560 | −0.022em |
| Body | 16–18px | 480 | normal |
| Label | 13px | 560 | −0.012em |
| Readout | 12–13px | 500 | −0.012em |

## Radius

`--r-panel: 2px` for plates. `--r-control: 999px` for every button. Square instrument panels,
round camera hardware. Never mix.

## Depth

No shadows. Dark surfaces step in luminance: `--canvas-deep` → `--panel` → `--panel-hi`, plus a
faint `rgba(255,255,255,0.08)` inset outline on the frame image.

## Layout

- Phone: full-bleed video, top rail (tally + readout), bottom rail (three circular controls).
  Corner marks inset 64px top / 110px bottom / 18px sides.
- Status page: 1100px measure, two columns at desktop (pairing block, then frame + endpoints),
  single column under 860px. Margins 32px desktop / 20px mobile.

## Motion

- **Signature:** agent capture flares the four corner marks outward and vermilion, 220ms
  `cubic-bezier(0.16,1,0.3,1)`, then they settle. You can see the agent look.
- Tally breathes on a 2.4s cycle while streaming. Flat when paused.
- Controls scale `0.96` on press over 100ms.
- All of it collapses to nothing under `prefers-reduced-motion`.

## Do not

- No gradients, no blur glass, no shadows at rest.
- No icon-topped card rows. No purple.
- No hairline rules as decoration. Space and tone step instead.
- No mono outside the endpoint code blocks.
- Do not put copy over the centre of the viewfinder.

## Responsive

Phone-first. Controls are 52px minimum, the flip control 68px. `env(safe-area-inset-*)` on both
rails. Status page collapses to one column at 860px.

## Agent prompt card

> Phone camera UI on `{--canvas}`: full-bleed video, top rail at `{--canvas-deep}` 72% opacity
> holding a 9px `{--tally}` tally dot and a 13px/560 label at `{--ink}`; bottom rail at 82% with
> three `{--r-control}` buttons on `{--panel-hi}`, the centre one 68px filled `{--ink}` with
> `{--canvas-deep}` icon. Corner marks 22px, 2px stroke, `oklch(0.93 0.005 265 / 0.5)`. All type
> Archivo Variable, `font-variant-numeric: tabular-nums`.

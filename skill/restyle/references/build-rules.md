# Build rules: from design-spec.json to a faithful site

> **When you need this:** SKILL.md step 6 and any fix that touches markup or CSS. Read §files and
> §skeleton before writing anything; afterwards read only the section for the band, component or
> problem at hand. The spec is the source of truth: a number that is not in the spec either belongs
> in it (with `judged` if it came from a sheet) or should not exist.
> **Sections** (`Grep "^## §"` gives line numbers): §files writing files, generators · §skeleton
> head, first paint, fonts, images, landmarks · §tokens · §container rails, text edges · §bands
> paddings, measured positions, art behind the nav · §widgets stand-in density · §feeds feeds, sticky
> side columns · §imagery originality, stand-ins, tone, logos, icons · §components · §responsive
> element set, every resp key, overflow · §quality · §pages · §checklist · §photo-recipes (optional)

## §files
- Output: `<out>/index.html`, `<out>/styles.css`, `<out>/type-scale.css` (generated), `<out>/main.js`,
  `<out>/assets/` (user files, SVG art). No framework, no bundler.
- Order inside `styles.css`: tokens, base/reset, layout primitives, components, bands in page order,
  motion, responsive rules that do not fit a band block, reduced motion.
- **Hand-written parts with Write and Edit.** Create a file with Write, extend it with Edit (a marker
  line `/* @end */` or `<!-- @end -->` makes appending a band one Edit); several Edits to one file in
  a row are fine. Edit only text you have read in its current state.
- **Generators for repetition and regeneration.** Repeated items (feed posts, card rows, logo rows,
  SVG art) and a file you regenerate whole after a structural change come from a `.mjs` file you
  Write into `<out>/.restyle/` and run with `node <file>`; it writes its output itself, and later
  fixes go into the generator, not its output.
- Never write or patch content through shell one-liners (`node -e`, `echo >>`, `sed -i`): they
  corrupt quotes and template literals. No blind search-and-replace across files you have not read.

## §skeleton
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Business name - short pitch</title>
  <meta name="description" content="One sentence about the business.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23111'/></svg>">
  <style>html{background:#fbf8f3;color:#1d2a2f}</style>
  <script>document.documentElement.classList.add('js');setTimeout(function(){document.documentElement.classList.add('ld-go')},3000)</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="font" type="font/woff2" crossorigin href="https://fonts.gstatic.com/s/<family>/<file>.woff2">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..600&display=swap">
  <link rel="stylesheet" href="type-scale.css">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="band b0 nav" data-nav>...</header>
  <main id="main">
    <section class="band b1 hero" aria-labelledby="h-hero">...</section>
  </main>
  <footer class="band b9 footer">...</footer>
  <script src="main.js" defer></script>
</body>
</html>
```
- **First paint in the right colours:** the inline `<style>` holds `pageBg` and `text`, so the first
  frame shows the page colour (a dark site never flashes white).
- The inline script adds `js` (reveal and load targets are hidden only behind it, so content stays
  visible without JavaScript) and the 3 s load failsafe (motion-patterns §load).
- **Fonts paint at once, without reflow.** One Google Fonts `<link>` for every family with
  `display=swap`, requested exactly as font-substitutes §axes; a metric-matched local fallback second
  in every stack (font-substitutes §load). Preload the woff2 of the hero headline's face: fetch the
  css2 URL with a desktop Chrome user agent (`curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64)
  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" "<css2 url>"`, or PowerShell
  `(Invoke-WebRequest -UseBasicParsing -UserAgent "<same>" "<css2 url>").Content`) and take the
  `/* latin */` block's `src` URL. Any family, weight or axis change: regenerate link and preload together.
- `type-scale.css` is linked as its own stylesheet (`type-scale.mjs --out`), never pasted or hand-edited.
- **Images:** base styles hold `img, video { max-width: 100%; height: auto; }` (media in layout boxes
  also `display: block`); `width`/`height` attributes size the box before load.
- **Landmarks:** `header` before `main`, `footer` after it, one `<section class="band b<i>">` per spec
  band in spec order (nav and footer are bands `b0` and `b<last>`). Each band is one element with its
  sub-blocks inside; never a second full-width sibling that continues the same band.
- GSAP/ScrollTrigger (cdnjs) or Lenis (jsdelivr) only when the spec needs them, pinned, before `main.js`.

## §tokens
- `:root` holds every spec token verbatim as a custom property named by use (`--page-bg`, `--accent`,
  `--tag-sale` for each `minor[]` colour, `--grad-hero-glow`, `--font-serif`, `--r-card`,
  `--shadow-card`, `--hairline: 1px solid var(--border)`, `--ease-ui`, `--dur-ui`, `--content`,
  `--inset`). Every colour, radius, shadow, easing and duration in the stylesheet is a `var()`; the
  only literal numbers outside `:root` are band paddings, grid ratios and component boxes from the spec.
- **Breakpoints**, mobile-first with `responsive.breakpoints` (default 768 / 1024): base rules = the
  390 layout, `@media (min-width: <tablet>px)` = the 768 layout, `@media (min-width: <desktop>px)` =
  the 1440 layout; the same two numbers in type scale, layout and nav. Widths in between still look
  designed (no overflow, no orphaned single card).
- **Type scale** (`type-scale.css`): per role and range `--fs-`, `--lh-`, `--ls-`, `--fw-`, `--ff-`,
  `--tt-`, plus `--fs-band<i>` per band and classes `.t-<role>`. Sizes are exact at 390/768/1440.
  Band headings use `.b5 .band__title { font-size: var(--fs-band5); }`; when `headRole` is a figure or
  quote, the band size goes on that element and the heading keeps its role class. Re-run the generator
  after any change to `tokens.type`, `tokens.fonts`, breakpoints or `headPx`.

## §container
```css
.container { width: min(100% - 2 * var(--inset), var(--content)); margin-inline: auto; }
@media (min-width: 768px)  { :root { --inset: 32px; } }   /* container["768"].railLeft */
@media (min-width: 1024px) { :root { --inset: 40px; } }   /* judged: keeps 1024-1279 designed */
```
- `--content` = `railRight - railLeft` at 1440; when the rails are not centred (`railLeft` differs from
  `1440 - railRight`), use `margin-left: <railLeft>px` at the desktop breakpoint.
- `--inset` at 390 and 768 = `railLeft` at that width. Cards, rows and media sit inside it: content
  flush to the viewport edge where the reference keeps an inset is a visible miss.
- Text that starts further in than the rails (`textLeft > railLeft`, or `bands[].textLeft`: copy in
  padded cards, a text column beside media) gets that inset from the card padding or the column,
  never from the container. After capture 1, the build's `spacing.container` text and rail edges sit
  within 8 px of the reference's at every width.
- The container sets no vertical padding. Full-bleed bands paint their background on the band and
  keep content in `.container`. Vertical rails (`spacing.borders` sides `rl`): `border-inline: var(--hairline)` on the container.

## §bands
```css
.band { padding-block: var(--pt, 0px) var(--pb, 0px); position: relative; }
:where(.band > .container > :first-child) { margin-top: 0; }
:where(.band > .container > :last-child)  { margin-bottom: 0; }
.b3 { --pt: 56px; --pb: 48px; }                                     /* bands[3].pad["390"] */
@media (min-width: 768px)  { .b3 { --pt: 72px; --pb: 64px; } }      /* pad["768"] */
@media (min-width: 1024px) { .b3 { --pt: 120px; --pb: 112px; } }    /* pad["1440"] */
```
The two resets keep the measured `pad` exact (a heading's or list's default margin would add to it);
`:where` gives them zero specificity, so any margin you set on purpose wins. Space inside the band
comes from gaps. For each band in order:
1. **Background:** the token, the gradient verbatim, or the stand-in (`bg.standIn`, §imagery). Keep
   the dark/light sequence and draw hairline dividers where the reference has them. A `scrollTheme`
   band is written in its `rest` colours (not the capture's `bg.color`, which is the centred one);
   the switch to `centred` is motion-patterns §theme.
2. **Height:** no fixed heights; content plus `pad` give `h` (within ~10%). Viewport-sized bands use
   `min-height: 100svh`. Much shorter = missing content, a sub-block or art drawn smaller than A's.
3. **Columns:** `layout[vp].ratios` as `grid-template-columns: minmax(0, .67fr) minmax(0, .33fr)`.
   **Cards:** `repeat(<cols>, minmax(0, 1fr))` per breakpoint, bento spans from `arrangement`;
   `overflow: true` = a horizontal row with the reference's peek (motion-patterns §scroller).
4. **Alignment and media:** `align` at 1440, `resp[vp].align` and `resp[vp].order` below it;
   `media.place` sets where the visual sits.
5. **Heading:** size from `--fs-band<i>`; a `max-width` (px or `ch`) that makes it wrap like the
   reference at 1440 and 390 (copy already fitted, spec-schema §copyfit); never shrink the font.
   Emphasis is markup: `<h2 class="t-h2">Lessons that fit a week. <span class="h-muted">Small groups.</span></h2>`.
   Parts hidden at a width get a class hidden there, not a second heading.
6. **Sub-blocks:** each `sub[]` entry inside the same `<section>`, with its heading, layout and
   divider; narrow reordering with `grid-template-areas`, never duplicated markup.
7. **Density and decor:** match `counts` and the sheet (headings, paragraphs, items, buttons, text
   mass); rebuild `direction.decor` and every signature trait where its `where` says.
- **Positions by measurement, not by the `pad` number** (it can put text tens of px off). After
  capture 1, check the hero headline and each band's first text against A on the fold and full
  sheets; settle doubts with `inspect.mjs bands <url>` (`y`, `h`, `pad`) and `inspect.mjs style <url>
  <selector> [<selector> ...]` (box; several selectors in one call share one page load) on the reference URL and the build; change `pad` in the spec (`judged`) until the
  text sits where A's does. Band tops (`sections[].y` in both capture.json) track A's down the page:
  a gap that grows band by band is one padding or height error repeated. On long pages check each
  lower-half band's top padding against A's too: drift collects there.
- **Art behind a transparent in-flow nav** (the fold shows hero art running up behind the header):
  keep the landmarks and pull the hero up under the header:
  `.nav { position: relative; z-index: 2; background: transparent; }`
  `.hero { margin-top: calc(-1 * var(--nav-h)); padding-top: calc(var(--nav-h) + var(--pt)); }`.
- **Dropped slots** (`ref.dropped` ad or embed inside a kept band): close the space to the band's
  normal rhythm; never leave the hole, fill it or pad to win back its height (page-height and word
  targets exclude third-party slots); a feed keeps its item density.

## §widgets
Product demos, app UI, dashboards, code windows, maps, configurators, diagrams and counters are the
reference's own product: rebuild an original stand-in of the same footprint, chrome (window bar,
sidebar, table, chips), palette, radius, shadow and **density**:
- Count the reference widget's rows, labels, chips, avatars, numbers and icons (`direction.density`)
  and land within ~25%, with plausible data from the user's world (a timetable, an order queue).
  Skeleton bars and lone icons read as unfinished unless the reference shows skeletons. Small text
  from `micro` or `small`.
- **Diagrams at narrow widths follow the reference:** reflow (stacked, connectors turning downward)
  when it reflows; keep it horizontal (scaled or scrolling) when it does. Labels stay legible.
- A widget that animates in the reference gets the same kind of loop (motion-patterns §ambient).

## §feeds
- **Long feeds** (rivers, listings, archives): build each item template once and generate the repeats
  (§files) in A's ratio of text-only items to image cards; sub-blocks in `grid-template-areas`,
  reordered per breakpoint (`resp.order`). An empty column beside a river is rhythm: keep it empty.
- **Sticky side module beside a longer column:** `position: sticky` only sticks inside its containing
  block. For a grid item that block is its grid area, which spans the row as tall as the longest
  column, so the sticky element must be the grid item itself:
  ```css
  .b5 .feed { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); column-gap: 32px; }
  .b5 .feed__side { align-self: start; position: sticky; top: 16px; }   /* direct child of .feed */
  ```
  A sticky element inside a wrapper only as tall as itself never moves; give such a wrapper the full
  row height and put the sticky element inside it. No ancestor up to the page may have `overflow:
  hidden`, `auto` or `scroll` (`overflow: clip` is safe). At narrow widths the module becomes a strip
  before or after the river per `resp.order`, with `position: static`.

## §imagery
**Originality (hard rule).** Stand-in art matches the reference's medium, palette weight, line and
fill, scale, placement and density; subjects and compositions come from the user's business. The same
kind of figure in the same pose, the same object arrangement or a mascot with the same body, colour
and eyes is a paraphrase even if every line is new (review §originality). No mascot unless the user
has one. Write each piece's subject in `media.standIn` from the brief before drawing it.

- **User images first:** copy to `assets/`, `<img width height alt loading="lazy" decoding="async">`
  (not lazy in the first viewport), `object-fit: cover` to the reference's aspect, radius and overlay.
- **Stand-ins by `direction.imagery.treatment`:** `abstract-gradient`/`3d-render`: layered radial and
  conic gradients, blur, blend modes, masks, 4-8% grain. `ui-mockup`: composed HTML UI at the
  reference's density (§widgets). `flat-illustration`: inline SVG scenes of the user's subjects in the
  reference's 3-6 palette colours, stroke or fill style, rounding and shading. `product-cutout`: a
  CSS/SVG object of the user's category on a pale ground with a soft shadow. `photo-*`: photographic
  stand-ins (below). `pattern`/`typographic`: the pattern or giant type itself.
- Every stand-in keeps the reference image's aspect, radius, shadow, overlay, position and visual
  weight; no baked-in text; `aria-hidden="true"` when decorative, else `role="img"` + `aria-label`;
  one `substitutions[]` entry each; a drop-in slot (an `<img>` of an SVG in `assets/` with
  `width`/`height`, or a sized background box) that a user photo can replace without layout changes.
- **Photographic stand-ins** (`colors.imageHeavy`, or photographic media, and no user photos): list
  every slot with aspect and minimum size for the report; carry photographic qualities as far as
  SVG/CSS can (tonal gradients with soft light falloff, blurred depth layers, a soft-focus object,
  grain, vignette, the reference's crop, colour grade and scrim; §photo-recipes). Never flat clip-art.
  Grade from 3-5 colours sampled on the reference shot with `inspect.mjs color`, and match its tone
  and contrast, not just its hue: a dark, high-contrast scene with a heavy vignette under the copy
  stays dark and contrasty (compare the two on the fold sheet).
- **Collage / masonry bands** stay a collage: the reference's mix of tile sizes and aspect ratios,
  its gaps (and empty cells), with screenshot-like or photographic stand-ins of varied content; never
  a uniform grid of flat saturated tiles or repeated placeholders. **Illustrated cards** keep the
  reference's art treatment (dark or gradient grounds with drawn art), not flat colour fills.
- **Logo:** the user's logo, else an original wordmark in the spec's display or sans face at the
  reference logo's height and weight (plus a simple mark only if the reference has one). A logo used
  as a giant layout element: spec-schema §content.
- **Logo rows:** original wordmarks with fictional names, varied in weight, case and face (spec fonts
  only), in the reference's treatment (colour or opacity, height, gap), `data-placeholder`, in
  `invented[]`. At narrow widths follow `resp.items` (one clipped row stays one row).
- **Icons:** inline SVG in the reference's icon style (stroke or fill, width, caps, size, container)
  with your own glyphs; one consistent set; no icon fonts or CDNs.
- **Canvas, WebGL, video:** approximate the look (colours, composition, glow intensity) with CSS/SVG
  from colours sampled on the reference shot; a glow that reads weaker or stronger than the
  reference's in the fold sheet is a mismatch. When the reference media moves, the stand-in moves too
  (motion-patterns §media). A user-supplied video can play muted, looped, `playsinline`, with a poster.

## §components
Build each from `components` (box, fill, border, radius, font, hover deltas, transition string) and
check it in place, over the background it sits on: the reference's fill and contrast there are part
of the spec (`notes`).
- **Nav:** position from `components.nav.pos` (`fixed` over the hero: pad the hero by the nav height);
  heights per viewport via `min-height`; transparent and `blur` as captured. The resting state is the
  one on the fold sheet, the scrolled state the one on the scrolled sheet (motion-patterns §nav); the
  full-page sheets may show the scrolled one. What shows at each width comes from `resp[vp].nav`: the
  same items, CTA and tab count. Keep the reference's space between logo and actions at 390; when
  items do not fit with that space, hide what the reference hides there, never squeeze.
- **Dropdown panels** (every reference chevron, spec-schema §content): a `<button aria-expanded
  aria-controls>` trigger with the chevron, a panel of real links in the reference's dropdown style;
  opens on hover and focus at desktop widths, on click everywhere; Escape and outside click close it.
  When the reference's nav-link hover pair shows a panel opening, a nav link without a chevron gets
  one too: an underline alone is not that hover.
- **Mobile menu** where the reference shows a menu icon: a real `<button aria-expanded aria-controls>`
  in the reference's icon style and place, keeping any CTA it keeps visible; the open state follows
  the reference's character (full-screen sheet or panel under the bar); the toggle flips
  `aria-expanded`, the panel's `hidden` and a `menu-open` class on `body`; links and Escape close it.
- **Buttons:** exact height regardless of font metrics: `display: inline-flex; align-items: center;
  min-height: <h>px; padding: 0 <x>px; font: var(--fw-button) var(--fs-button)/var(--lh-button)
  var(--ff-button);` (the button role's own line-height: compare scores the label's line box; the
  min-height, not the line-height, sets the box), the captured transition string verbatim, `:focus-visible` outline in the accent. Child changes
  (`kids`: an arrow nudging, a chevron turning into an arrow) per motion-patterns §hover.
- **Cards:** box from `components.card` or the sheet; hover only if the reference's hover pair shows
  one. Reveal plus hover on one card: motion-patterns §reveal.
- **Inputs:** box, font and placeholder colour from `components.input`; accent focus ring. Forms
  never submit: prevent `submit` and show an inline confirmation (`role="status"`).
- **Links:** colour, underline style (thickness, offset, inset shadow) and hover from
  `components.link`; destinations per spec-schema §content.
- **Badges, tags, eyebrows:** from `components.badge`, `tokens.type[vp].eyebrow` and `tokens.color.minor[]`;
  tags coloured by category keep both colours on the same kinds of tags.
- **Footer:** column count per viewport, link density and weight, headings, social and legal rows,
  newsletter input, perk or trust rows (stacked where `resp.stack` says). Fewer user links than the
  reference: keep its column count and row rhythm with the business's real links plus generic
  utility links (contact, privacy, terms; `invented[]`); never invent services. Accordions at narrow widths: `<details>` closed there; where the
  reference shows them expanded, a `matchMedia` listener sets `open` and CSS hides the marker.
- **Affordances** (expand buttons, accordions, tabs, carousel arrows, close buttons, search): keep
  them doing something real and simple; one with nothing sensible to do (a cart) is left out.

## §responsive
**768 is its own layout.** Implement `resp["768"].layout` literally from the reference's 768 sheet;
never let 768 be the desktop grid squeezed or the phone layout stretched. Then every key, at 768 and
390, together with `layout[vp]`, `cards[vp]`, `pad[vp]`, `hideAt` and `responsive.nav`:
- `align`, `order` (`grid-template-areas` per breakpoint), `hidden` (a class hidden there), `stack`
  (small items stacked or side by side; full-width buttons where the reference has them),
  `accordion`, `gapAbove` (previous band's `pb` + this band's `pt`), `inset` (`--inset`).
- **Element set first** (spec-schema §resp): header items and tab count, cards stacked where A
  stacks (a group A stacks at 768 is never 2-up), footer columns and rows.
- `items`: the same number of whole items; hide the rest with `:nth-child(n + k)` at that width. A
  row the reference keeps as one clipped row stays one row (`flex-wrap: nowrap; overflow: clip`).
  Never cut a label mid-word: an item is whole, or off-screen as a peek, or trimmed.
- `peek`: card widths that show the same part of the next card (motion-patterns §scroller); no
  clipped sliver where A shows whole items, no item half under an arrow at rest. A last card that
  bleeds off the edge in A bleeds in B.
- `artClear`: keep the text field as clear as the reference does: move, crop (`object-position`, a
  narrower art variant), mask (`mask-image`) or place the art below; art covering the nav or headline
  where the reference keeps a clear field is a colour and responsive mismatch.
- `gaps`: the hero's and CTA's internal gaps at that width, in px; a 390 hero with larger gaps reads
  as stretched.
- **Type at 390:** the scale hits `type["390"]`; check that wordmark, headlines and body are not a
  step larger than the reference's (often a band heading using a desktop role).
- **Polish at every width** (review §polish): images and mock-ups re-cropped so their key part stays.
- **Overflow at 768 and 390 is zero.** Causes: fixed widths, `100vw` (use `100%`), negative margins, long
  words in big headings, unclipped marquee tracks or blobs. Clip decoration on its band (`overflow:
  clip`), fix content at its cause (`inspect.mjs overflow <url> 768|390`); `overflow-x: clip` on `body`
  only as a last resort, never `overflow-x: hidden` on `html`/`body` (it breaks `position: sticky`).
  Clipping is not a fix for content: text or media cut at the viewport edge (a footer grid or a row
  that does not reflow, hidden by `overflow` on it or an ancestor) is reported as clipped
  (`meta.overflowX[vp].clipped`, `inspect.mjs overflow`) and cut text costs points; only designed
  carousels, marquees and scrollers may run past the edge.

## §quality
Gaps from `tokens.space.gaps`; body text 4.5:1 and large text 3:1 (adjust only stand-in backgrounds,
never measured text tokens); skip link and keyboard-operable menus; no 404s (every `src`/`href`
resolves, in-page links point at real ids); plus the semantic and accessibility hard rules of SKILL.md.

## §pages
`index.html` is the faithful page and the one the loop scores. Extra pages are built only when the
user asks (spec-schema §content): they share `styles.css`, `type-scale.css`, `main.js`, nav and
footer, and are assembled from the reference home page's band patterns (or, when the reference has a
matching page, capture it with `capture.mjs <ref-url>/<page> <out>/.restyle/ref-<page>` and follow
it). Capture each extra page once (full: `--fast` measures 1440 only) for console errors and 768/390 overflow; list it in the report.

## §checklist
Before the first build capture:
- [ ] Band count, order and classes `b<i>` match `bands[]`; every band has its background, its
      paddings per viewport (on the band) and real content; dark/light sequence and dividers match.
- [ ] Head: inline page colours, `js` class and load failsafe, font preload, one Google Fonts link,
      `type-scale.css` linked; fallback `@font-face` with metric overrides; image base rule.
- [ ] Every token verbatim in `:root`, minor colours included; `type-scale.mjs` without warnings;
      band headings on `--fs-band<i>`, wrapping like the reference at 1440 and 390.
- [ ] Container from the rails; text insets from cards and columns; nothing flush where A has an inset.
- [ ] Nav per width (same items, CTA and tab count, space between logo and actions), resting and
      scrolled states, a working panel behind every chevron, a working mobile menu.
- [ ] Components: measured box, font, hover deltas (children included), transition strings, each
      checked over its own background; no hover effect the reference lacks.
- [ ] Footer columns, density, perk and legal rows, accordions; every control does something; every
      link has a destination or `href="#"` + `data-placeholder`.
- [ ] `motionCore` and nothing beyond the spec; reduced-motion block (motion-patterns §checklist).
- [ ] Stand-ins: A's medium and tone, the user's subjects, no mascot unless the user has one, widget
      density within ~25%, drop-in slots, placeholders marked.
- [ ] Every `resp` key and the element set implemented at 768 and 390; no overflow at 768 or 390.
- [ ] No reference brand name, copy, logo, image or font URL anywhere in the build.

## §photo-recipes
Optional. Grade both with colours sampled on the reference and its scrim strength. Recipe A, an
interior or still life (window light on a surface, one object of the user's trade), as `assets/hero-still.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 810" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="light" cx="0.72" cy="0.18" r="0.9"><stop offset="0" stop-color="#f3e2c7"/><stop offset="0.55" stop-color="#b98f66"/><stop offset="1" stop-color="#3a2a20"/></radialGradient>
    <linearGradient id="table" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a5a42"/><stop offset="1" stop-color="#2c1f17"/></linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.09 0"/></filter>
    <radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></radialGradient>
  </defs>
  <rect width="1440" height="810" fill="url(#light)"/>
  <path d="M0 560 L1440 520 L1440 810 L0 810 Z" fill="url(#table)"/>
  <ellipse cx="930" cy="610" rx="230" ry="34" fill="#140d09" opacity="0.55" filter="url(#soft)"/>
  <rect x="840" y="330" width="170" height="280" rx="22" fill="#5b3b28"/>
  <rect x="852" y="342" width="40" height="250" rx="16" fill="#f6e3c8" opacity="0.35" filter="url(#soft)"/>
  <rect x="300" y="380" width="260" height="200" rx="18" fill="#8a6a50" opacity="0.6" filter="url(#soft)"/>
  <rect width="1440" height="810" fill="url(#vig)"/>
  <rect width="1440" height="810" filter="url(#grain)"/>
</svg>
```
Recipe B, outdoor full-bleed with text over it: the same layers as CSS on the slot box: a sky
`linear-gradient` with a hard horizon stop, a warm `radial-gradient` light falloff, a blurred
`::before` of 2-3 soft radial shapes for distance, and an `::after` scrim
`linear-gradient(180deg, rgb(0 0 0 / 0) 40%, rgb(0 0 0 / 0.45) 100%)` behind the copy.

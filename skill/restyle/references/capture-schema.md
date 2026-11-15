# capture.json schema (`restyle-capture/2`)

> **When you need this:** SKILL.md step 5 (and step 3 when a `summary.md` line is not enough): open
> it at the field a digest line names to learn how that value was measured and how far to trust it
> (`## Reliability`, the last section). Never read it whole: `Grep "^## \|^### "` lists the parts (files,
> meta, sections, colours, type, spacing, components, hover, motion, exact shapes, fontmatch output).

Written by `scripts/capture.mjs <url> <outDir> [--viewports 1440,768,390] [--no-motion-frames] [--fast] [--frames-like <refCapDir>] [--timeout 60000]`.
The same script captures the reference site and the built site, so every field is measured the same
way on both. This file is the contract for the design-spec writer and for `compare.mjs`.

`--fast` is for quick iteration only: the largest viewport, no motion frames, no hover pass, no
warm-cache second load (`meta.fast: true`, `meta.partial` lists what was skipped). `compare.mjs` scores only what a fast
capture contains and marks the diff `partial: true`. The final verify is always a full capture.

`--frames-like <refCapDir>` (build captures): the reveal strips are recorded at the reference's page
positions instead of where this page's own reveals fired (see `motion.frames.reveals[].like`), so the
build row of every reveal strip is filled even when the build animates differently or its effect was
not detected. harness/pipeline.mjs eval and the skill's verify loop use it.

`summary.md`, a digest of the capture for a model to read first (<= 250 lines, every line names the
capture.json path it comes from), is written next to capture.json (`lib/summary.mjs`). Band ids in it are
written `b<i>` (`b<i>@768` for a band that exists only at a narrow width); the bands table has an id column
(`#s-xxxxxx`). Lines marked **WEAK** flag values to double-check: a type role taken from one element, a
single-use size, the footer or a band of UI mock-up panels; a container measured from one band, from
running text only, from a centred text column, or from one column of a multi-column band; a hover whose
data and before/after crops disagree (follow the crops). A `POOR` sample
is not to be trusted for weight, width or tracking. When the hero's own heading size differs from the h1
tier's band, the hero size is given. When the full-page shot draws the nav in another state than the fold
(its top rows match the scrolled shot), the digest says so: read the rest state from the fold.

## Conventions
- Viewports: 1440x900, 768x1024, 390x844, device scale factor 1, desktop Chrome user agent, `en-US`,
  light colour scheme, no reduced motion. Narrow viewports are width-only (no mobile UA, no touch).
- Viewport keys are strings: `"1440"`, `"768"`, `"390"`. The **primary viewport** is the largest one
  passed (normally 1440); detailed fields (`sections[]`, colours, components, hover, scroll motion) are
  measured there. Every viewport is segmented into bands on its own (same algorithm).
- Lengths are CSS px at that viewport, rounded to 1 (some to 0.5). `y` is document y measured at
  scroll 0 after the scroll pass (so reveal-on-scroll content is in its final state).
- Colours: `#rrggbb`; `#rrggbb@0.08` = colour with alpha. Colours with alpha in palette/roles are
  composited over what is behind them (effective painted colour). OKLCH is `[L 0-1, C, H deg|null]`.
- Ratios 2-3 decimals. Durations in ms. Easing strings are the site's CSS/WAAPI strings when known.
- `null` = could not be measured reliably; the reason is in `notes[]`. Nothing is guessed.
- Lists are capped (stated per field); a cap that cut data is recorded in `notes[]`.
- Band `id`: `s-xxxxxx`, a hash of the band element's DOM signature (`tag#id.firstStableClass:nth`
  chain from `<body>`, ignoring state classes such as `is-visible`, `aos-animate`). Same DOM gives the
  same id at every viewport and run; ids never match between the reference and the build (different
  DOM), so compare sections by order/geometry, not by id.
- Examples (`ex`, `el`, `roleWhere`, `...At`) are short element descriptors (`tag#id.class`) plus a band
  index, so every value can be traced to an element on the page. They are for findings only.

## What is measured: visible design only
- **Visible in the settled page**: an element counts for type roles, components, colours, media and
  counts only if at least half of it is visible: not clipped away by an `overflow` ancestor
  (collapsed accordions, carousel tracks), not off-screen horizontally (inactive carousel slides), not
  inside an `aria-hidden="true"`/`inert` subtree that has a same-kind visible sibling (inactive slide),
  not `opacity: 0` / `visibility: hidden`. Layout geometry (rows, card grids, overflow/peek) still sees
  partly visible items.
- **Popups and banners** that appear on load without user action are removed BEFORE anything is
  measured (`lib/consent.mjs`): known consent managers (reject clicked where found) and, generically,
  any dialog (`role=dialog/alertdialog`, `aria-modal`, `<dialog open>`), fixed full-viewport backdrop
  (translucent through its background alpha, its own opacity when stacked above the page, or blurred) and the
  modal on it (each pass runs twice, so a scrim left by a dismissed dialog goes too), a fixed consent frame
  (an iframe whose title / source names cookies, consent or privacy), side drawer, or fixed bar/box whose text is about
  cookies, privacy, consent, region/country/language, newsletters, subscriptions, apps or offers and
  that holds a control (a single floating CTA button does not qualify). A dismiss control (close, x,
  no thanks, stay, decline; never accept) is clicked when there is one, otherwise the popup is hidden.
  Each root is marked and its subtree is excluded from load motion, sticky, roles, palette and
  components; `meta.overlays[]` and `notes[]` record what was removed. A bar across the very top of the
  document (fixed or in flow, <= 200 px tall, nearly full width, not the header) whose wording names a
  country / region / location / language and asks to choose, see or switch, with a select or a close
  control, is removed the same way (closed only through its close control, never its "continue" button,
  and kept hidden by a style rule): it appears after load and pushes the whole page down. On the warm
  reload the same popups are hidden from the first paint, so they are not in the load frames either. The
  pass runs again before the snapshot (late newsletter boxes) and before the screenshots, at every width,
  and those later passes also click a consent reject control (a consent banner that appears seconds after
  load, often in its own frame, is declined whenever it shows up; `meta.consent` then says where).
- **Full-page shots show each band as it looks in view** (every viewport, before the analysis):
  `content-visibility` is forced visible (off-screen `content-visibility:auto` subtrees are otherwise not
  painted, and have no layout for the segmentation); scroll-driven animations (CSS `animation-timeline`
  scroll()/view(), WAAPI scroll/view timelines) that change visibility, position, clip or filter are read
  with their target nearest the viewport centre and paused there for the full shot and the analysis
  (page-tall targets and colour-only animations are left alone; the scroll-0 state is kept as
  `shots/<vp>-full-rest.png`). Then the shot is checked against the DOM: text the page shows (effective
  opacity >= 0.5) with no ink in the shot, and flat media/panel boxes, mark rows that are re-shot in view
  (scrolled just below a pinned header, left to settle); a 60-row block with clearly more ink in view
  replaces the full shot's block (content mounted or painted only while in view: lazily mounted video
  panels, JS reveal-and-hide); rows filled that way (>= 30% of the compared rows) are left out of scroll-tint
  and band scroll-theme detection (their colour in view is that content, not a tint). The probe is taken once
  the page height has held still (a full-page capture resizes the page for an instant and some pages re-render
  after it); rows line up only while the page is as tall as the shot (a position where it is not is skipped).
  A shot still >= 25% flat rows (60-row blocks with no ink) after that, with a flat run of >= 1.5 viewport
  heights or a fill whose rows could not line up (rows the page loads only in view, at another height), is
  rebuilt from viewport tiles scrolled through the page (bars at the viewport edges hidden after the first
  tile, overlaps seam-checked); the rebuild is kept only when it has at most half the flat rows
  (`shots[vp].blank.stitched{tiles, shifted?, flatBefore, flatAfter, kept}`), so an airy page keeps its capture.
  After the analysis, bands with content (>= 3 words or any media) whose rows are still flat in the shot are
  filled the same way. `shots[vp].render`, `shots[vp].blank` and `sections[].shot` record it; what is still
  blank after that (>= 10% of the page height in flat content bands, or >= 20% of the text) is one WARNING note
  and digest line that states the share for every width.
- **Scroll-theme bands in the full shot**: a band whose background changes when it is scrolled into view
  (`bg.scrollTheme`) is shown in its **in-view (centred) state** in `<vp>-full.png` on every page, whatever its
  full-page rendering did: the rest-colour background of its rows (the region connected to the band's edges;
  text and fills enclosed by other content are kept) is painted the centred colour
  (`shots[vp].themed[{band, px}]`); the scroll-0 state stays in `<vp>-full-rest.png`. Only 1440 bands are read
  centred, so the 768 / 390 full shots show the rest state. Rows blank in the full or rest shot (text or media
  the DOM paints there that shows no ink in that shot) have no colour to read: band themes and scroll tints are
  never read from them, and a band with them is not recoloured.
- **Viewport failures**: a viewport whose capture throws (analysis, shots) is retried once on a fresh page
  (noted); the primary viewport's analysis is retried once. A second failure fails the capture (exit non-zero,
  `done.json` `{ok: false, error}`): a capture never drops a viewport silently.
- **Blocked embeds**: placeholders shown instead of an embed because of the cookie choice ("this
  content is not visible due to your cookie preferences", "accept cookies to view") are third-party.
- **Third-party chrome** is never part of the design: consent/CMP containers (known hosts, or fixed
  bars with cookie/consent text), ad slots (GPT/AdSense ids, `data-ad*`, `data-concert`, ad-network
  iframes and the slot boxes around them), chat launchers (Intercom, HubSpot, Drift, Zendesk, Crisp,
  Tawk), captcha badges and frames. These elements are excluded from roles, palette, sticky, type,
  components and transitions. A band that is (mostly) third-party chrome, or is empty and sits above
  the header, gets `role: "ad"`, `thirdParty: true`; `compare.mjs` leaves such bands out.
- **Whole page**: the element walk has no small cap (150 000 elements, 30 s budget). Bands after the cut,
  if any, are marked `analysed: false` (geometry and background only) and noted.

## Files next to capture.json
| path | content |
|---|---|
| `shots/<vp>-full.png` | full page at scroll 0 after the scroll pass, rendered as each band looks in view (content-visibility forced, scroll-driven animations paused at their in-view state, blank rows filled from in-view viewport shots: see "Full-page shots" above), width = viewport, height <= 20000 (`shots[vp].capped`). Pages taller than 8000 px are shot in tiles that overlap by 240 px; each seam is self-checked (overlap rows must match, a shifted tile is re-shot from scroll 0) and recorded in `shots[vp].seams[{y, diff, offset, ok}]`; a seam that still does not line up is noted. |
| `shots/<vp>-full-rest.png` | only when the full shot was changed by paused scroll-driven animations, in-view rows or a scroll-theme band shown in its in-view state: the plain scroll-0 full shot (`shots[vp].fullRest`); scroll tints compare against it |
| `shots/<vp>-full-tail-<k>.png` | pages taller than the 20000 px cap: the rows below it, <= 20000 px per file, down to 60000 px (`shots[vp].tails[{file, y, h}]`, shot in the same state as the full shot); bands past the cap get their `sec-<n>` crop and sampled colour from them, and the sheets join them under the full shot |
| `shots/<vp>-fold.png` | first viewport at scroll 0 |
| `shots/<vp>-scrolled.png` | the viewport after scrolling down 1.5 viewport heights and settling (header's scrolled state, sticky elements) |
| `shots/<vp>-sec-<n>.png` | crop of the full shot for band `n` (index into that viewport's section list), <= 2400 px tall; `null` in `shots[vp].sections` if outside the shot |
| `shots/comp-<name>.png` | primary-viewport crop (+12 px margin) of each found component: from the fold shot when the component lies inside the first screen (scroll 0, at rest: a tall page's tiled full shot can show a fixed header in its scrolled state), else from the full shot |
| `motion/frames/load/f-00.jpg` ... `f-60.jpg` | 61 JPEG frames, 12 fps, **5 s**, starting at the screencast frame that shows **first contentful paint** (FCP from the Paint Timing API mapped onto the compositor frame times; the FCP frame may carry a time up to two frames before FCP, and a page that stays still after its first paint sends no further frame, so frame 0 is the frame on screen at FCP; `motion.frames.load.t0` = `fcp`, or `commit` when the page reports no FCP), recorded on the **warm-cache second load** of the page (see `motion.load`; `motion.frames.load.run` says which load they show). Long enough for a load that settles up to 4 s after first paint (`motion.frames.load.settleMs`). Both sides of a comparison start at the same defined instant, and a page that paints at once shows its content in frame 0 (blank pre-paint frames of a fast local page are never in the strip). Frames always start at first paint, also when a lead-in is skipped in the sheets (`motion.frames.load.leadIn`). Consent banners, chat launchers and the popups removed on the first load are hidden with CSS injected at document start for this recording only. |
| `motion/frames/reveal-<n>/f-00.jpg` ... `f-18.jpg` | 19 frames, 12 fps, 1.5 s, on a fresh page (every screencast runs with a 2x2 px repaint pump at opacity 0.01 in the bottom-right corner, outside <body>, so headless Chrome films compositor-only fades frame by frame instead of skipping them): jumped to just above a band whose reveals fired in the scroll pass, then one wheel step brings it into view (up to 4 sequences: the steps with the largest reveal area, at least 2 steps apart). **Frame 0 = the instant the wheel input is sent** (Node clock mapped onto the screencast clock with the median receive-minus-frame-time offset; `motion.frames.reveals[].t0` = `wheel`), so every strip, reference or build, static or animated, starts at the same defined instant. With `--frames-like <refCapDir>`: one sequence per reference sequence, at the same page position mapped through the band alignment of the two pages (offset inside the aligned band or run of bands; page fraction as fallback), same step size and timing. `<n>` is a sequence number starting at 1; the existing directories are listed in `motion.frames.reveals[].dir` |
| `motion/frames/media/f-00.jpg` ... `f-15.jpg` | 16 frames, 6 fps, 2.5 s of the settled first screen at scroll 0 (popups gone), recorded with the hero media sample when the first screen has hero media (`motion.frames.media`); the sheets crop moving media boxes from them. Not written on `--fast` / `--no-motion-frames` |
| `shots/type-<role>.png` | tight crop (line box + 4 px) of `type.samples[role]`: the first rendered line of the chosen member at 1440 (input of `inspect.mjs fontmatch`) |
| `summary.md` | the capture digest (above) |
| `done.json` | written last: the same one-line JSON as stdout (`{"ok":true,...}`), or `{"ok":false,"error"}` on a failure or the 8-minute limit; carries `startedAt`. The very first thing a capture does is delete it and write `started.json` `{pid, startedAt}`. `capture.mjs --wait <outDir> [--timeout-s 600]` waits 4 s before its first look (a capture launched just before has started by then), then takes `done.json` only when its `startedAt` is the one in `started.json` (an older run's is ignored while a newer capture starts or runs), prints it and exits 0 (ok) or 1 (failed or timed out) |
| `started.json` | `{pid, startedAt}` of the latest capture into this dir, written before anything else |
| `motion/frames/hover-<kind>/f-00.png`, `f-01.png` | crop before (`f-00`) and during (`f-01`) hover at 1440, for `<kind>` = `primary-button`, `card` and `nav-link` when hovered; the existing directories are listed in `motion.frames.hover[].dir`; `motion.frames.hover[].visual` = `{changed, mean, look, dL}` (share of pixels whose RGB differs by > 30, mean difference / 765; `look` = what the pair visibly does: `none` (< 0.5% changed), `lightens` / `darkens` (>= 75% of the changed pixels move one way in luma, by `dL` levels on average) or `recolours or moves`) and `hover[].pair` names the pair on the element it was shot on |

## Top level
| field | meaning / how measured |
|---|---|
| `schema` | `"restyle-capture/2"` |
| `meta` | run facts (below) |
| `sections[]` | primary-viewport bands in page order (below) |
| `sectionsByViewport{vp}[]` | bands of each non-primary viewport, segmented on their own (below) |
| `colors` | palette, roles, minor colours, gradients, theme (below) |
| `type` | font families and type roles per viewport (below) |
| `spacing` | container, gutters, band paddings, gaps, radii, shadows, borders, nav (below) |
| `components{}` | computed-style samples of key components (below) |
| `hover[]` | real-mouse hover deltas (below) |
| `motion` | static motion inventory, load sequence, scroll reveals, ambient motion, sticky, parallax, ... (below) |
| `shots` | `{vp: {full, fold, scrolled, sections[], fullHeight, capped, seams?, fullRest?, render, blank}, components: {name: path}, summary: "summary.md"}`; `render` = `{contentVisibility (elements forced visible), scrollDriven (found), frozen (paused in view)}`; `blank` = `{before, after (share of the CSS-visible text area with no ink in the shot, before / after the in-view fills; after = null with probeDocH when the page was no longer as tall as the shot), texts, ranges[[y0, y1]] (rows checked in view), bandRanges? (flat content bands re-shot after the analysis), rows (share of the shot's height in content bands still flat), bands? (their indices), inView?{shots, pasted[[y0, y1]], pastedPx, stopped?, skipped?}, stitched?{tiles, shifted?, flatBefore, flatAfter, kept} (rebuild from viewport tiles)}`; `tails?[{file, y, h}]` (rows past the 20000 px cap); `themed?[{band, px}]` (scroll-theme bands painted in their in-view colour) |
| `notes[]` | everything capped, skipped or unreliable, in plain words (<= 100) |

## meta
| field | meaning / how measured |
|---|---|
| `url`, `finalUrl`, `title` | requested URL, URL after redirects, document title |
| `time`, `runMs` | ISO time at the end of the run; wall-clock run time |
| `status` | HTTP status of the main document |
| `fast`, `partial[]` | present on a `--fast` capture: what was skipped |
| `blocked{suspected, reasons[]}` | bot wall / interstitial suspicion: HTTP 401/403/429/503, challenge text ("just a moment", "verify you are human", captcha, ...) on a short page, or < 60 chars of text. Capture still completes. |
| `userAgent`, `viewports` | UA string used (installed Chrome's major version), viewports captured (desc) |
| `pageHeight{vp}` | `document.documentElement.scrollHeight` (max with body) after the scroll pass |
| `libraries[{name, evidence}]` | detected through globals, DOM markers and script URLs: gsap, ScrollTrigger, ScrollSmoother, lenis, locomotive-scroll, three, swiper, lottie, barba, framer, framer-motion, aos, scrollreveal, animejs, splide, flickity, slick, rive, spline, pixi, webflow, next, nuxt, vue, react, shopify, jquery |
| `consoleErrors{vp}` | `console.error` + uncaught page errors on that viewport's page (implicit favicon 404s excluded) |
| `consoleSample[]` | first 5 primary-viewport error texts (160 chars) |
| `overflowX{vp}` | `{scrollWidth, vw, overflow, by, offenders?[{sel, w, right, band}], viewportClip?, clipped[], clippedN?}`; `overflow` = a visitor can scroll the page horizontally (tested with `scrollTo(100000, y)`, and false when html/body `overflow-x: hidden\|clip` reaches the viewport: then `viewportClip: true`); `offenders` = the widest elements whose right edge passes the viewport and that no ancestor clips (selector path); `clipped` (<= 6, largest cut first; `clippedN` = all hits) = visible text (its line boxes) or media whose box crosses the left/right viewport edge and is cut there (within 4 px of the edge) by a clipping ancestor or the non-scrolling viewport; content cropped by a box that ends inside the viewport is a crop, not reported; content past the left edge, and right-edge cuts in a row that also runs past the left edge, are a designed bleed (centred carousel, ticker), not reported: `{sel, kind: text\|media, side, cut px, w, x, by (clipping ancestor or 'viewport'), band}`. Not reported (designed): content inside a horizontally scrollable or scroll-snap container, a translated or transform-animated track, an edge-fade mask, carousel/slider semantics or class names, an off-canvas fixed/absolute box mostly outside the viewport, aria-hidden/inert subtrees, sr-only boxes, absolutely positioned media and media spanning both edges; cuts under 6 px |
| `consent{action, detail}` | `clicked` (reject/decline/necessary-only control of a known CMP or an English reject button inside a cookie/consent container, page or consent iframe), `dismissed` (a popup's dismiss control clicked), `hidden` (consent hosts / popups hidden, scroll unlocked), or `none` |
| `overlays[]` (<= 12) | removed popups/banners: `{kind (cmp / consent / dialog / backdrop / drawer / banner), action (dismissed / hidden), el, sel, text (60 chars), why, box[x,y,w,h], vps[], phase?}`; `phase` = `late` (found just before the screenshots) or `warm load` |
| `stylesheets{total, readable, fetched, unreadable[]}` | CSSOM-readable sheets; cross-origin sheets read from captured response bodies or refetched; hosts that could not be read |
| `settle{vp}` | `{ms, load, fonts, quiet}`: wait for `load` (cap 30 s), `document.fonts.ready` (cap 4 s), then a network-quiet window (<= 1 request in flight for 500 ms; requests older than 8 s ignored; cap 10 s) |
| `segmentation{vp}` | `{root, cover, capped}`: element the bands were taken from, fraction of page height covered by band elements before gaps were assigned, whether bands were merged down to 30 |
| `innerScroller{vp}?` | present only on an **app-shell page**: the document is <= 1.15 viewports tall while one box with `overflow-y` auto/scroll/overlay whose content is >= 1.5x (and >= half a viewport more than) its height covers >= 50% of the viewport's width and height (largest wins; `<body>` counts). Right after consent, on every page the capture opens on the site, that box is **unrolled into the document**: content-visibility forced visible, the box and its ancestors get height auto, max-height none, overflow-y visible, absolute/fixed position becomes relative, a column-flex item keeps its content height, the grid row track holding it becomes auto and size containment is lifted, so scrolling, segmentation, shots and reveals see the whole content; a bar the shell pins below the box at the screen bottom (<= 25% vh, >= 90% vw) becomes position fixed there, as a visitor sees it (`pinned` = how many). The box counts by its own width when it starts inside the viewport (a min-width layout can run past the right edge). `{ok, el, clientH, scrollH, docH[before, after], released, cv, pinned?}`; `ok: false` = the document did not grow (styles restored; the page is measured as one screen, digest says so) |

## sections[] (primary viewport)
Segmentation: descend from `<body>` through single wide wrappers (one child >= 50% of the width
covering >= 50% of the height), take its in-flow children (fixed/absolute excluded, `display:contents`
flattened), group side-by-side siblings into one band, and expand a band into its stacked children
when it is `<main>`, has >= 2 section/header/footer/nav children, has >= 2 full-width children with
different backgrounds, or, when >= 2 of its stacked children are sections by sight (>= 0.3 viewports tall,
opening with a heading: an h1-h3 / role=heading or text >= 24 px whose top is in the child's first 40% or
first half viewport), is > 1.3 viewports tall with mostly full-width children or > 2.5 viewports
tall with >= 2 stacked container-wide children (>= 90% of its content width, side padding off) >= 0.6
viewports tall covering >= 60% of it (a long page inside one width-constrained wrapper). Width alone never
splits: at a phone width every row of one section is as wide as the viewport. **Side panel + main column**
(an app layout): a band holding a main column (>= 50% of its width and height) with a narrow panel beside it
(<= 40% of the band's width and <= 75% of the column's, spanning >= 70% of the column's height) whose largest
text is under 0.9x the median heading of the column's blocks, the column stacking >= 3 blocks of >= 120 px
that each open with a heading, is segmented into the column's blocks (a footer ending the column stays the
footer band; the panel is not a band), the same as when panel and column are the root's own children; a
heading column beside stacked cards (the band's large heading in the narrow column) stays one band. Siblings that overlap group as one (a short strip laid over the top
of the content block); when that group's largest member covers >= 85% of the band, segmentation descends
into it as into a single child; the group's element is its largest member that holds content (an empty
layer spanning the layout never stands for the band). Slivers < 24 px and
empty spacers merge into the previous band; a short heading-only band (no media >= 48 px, no row of >= 3
side-by-side marks outside headings, logos as images or as short text items alike, <= 1 link) on the
same background merges into the band below (section header + content). A fixed/sticky/absolute header
not in the flow becomes a separate `nav` entry.

**Boundaries between bands** are placed so that the same visual gap reads the same whether it is
built with margin or padding: between two bands on the same background the whitespace between the
last content of the upper band and the first content of the lower band is split evenly (so `pad`
bottom of one = `pad` top of the next, and heights do not depend on which side owns the space); across
a background change the boundary is the colour edge and the space between the two boxes goes to the
band whose colour it shows. Content for this purpose = visible text, in-flow media, inputs, buttons and
card surfaces, plus absolutely positioned pictures where they are drawn (clipped): a sizeable img / svg /
video / canvas / iframe / background-image box (>= 48 px each way, >= 20000 px2, not fixed) and a fill layer
covering >= 90% of the in-flow box it is laid over; anything else inside an absolutely positioned box placed
within the band (slider arrows, badges, small decoration) is ignored, the same way on every site. Space above
the first band goes to it.

| field | meaning / how measured |
|---|---|
| `id`, `i` | stable band id (see conventions); index in this list |
| `role`, `why` | role guess and the rule that fired, from structure only (class names and wording are never used), in order: `nav` (detected header), `ad` (third-party chrome / empty slot), `other` (bar above the nav), `footer` (a band that is the page's `<footer>`/contentinfo, or holds it as the last band or with the footer filling >= 60% of it; the page footer = the last `<footer>`/contentinfo not inside an article/blockquote/figure/aside/li/dialog/form and ending in the lower 40% of the page; a section's or card's `<footer>` row never makes a band the footer; or last band with >= 8 links), `hero` (first content band >= 30% vh with the h1 or text >= 2x body), `logos` (>= 4 marks in one row: small img/svg, or short bold wordmarks; little other text, no big heading), `pricing` (>= 2 prices with a billing period inside one text run), `stats` (>= 3 large numerals: 98%, 10x, $1.2M+, 10 min, 24/7, 4.9/5), `testimonial` (blockquote/q or text opening with a quote mark), `article-list` (>= 3 repeated items side by side, each with sizeable media + text), `gallery` (mostly media), `cta` (short band near the end, large heading + 1-4 buttons), `features` (>= 3 repeated cards, or heading + media), `other`. **compare.mjs scores only the coarse class** (hero / content / footer). |
| `el` | short descriptor of the band element (`tag#id.class`) |
| `y`, `h`, `yFrac`, `hFrac`, `vh` | band top/height in px (after boundary placement), as fractions of page height, height in viewport heights |
| `gapBefore` | raw space between this band's own box and the previous band's own box (margins / parent padding), for reference |
| `bg{type, color, sampled, sampledShare, gradient?, src, cssColor?, scrollTheme?}` | `type`: color / gradient / image / video / canvas / iframe / svg. Media counts as background only if it covers >= 60% of the band and sits under its main heading (a gradient/solid art box doing so gives `gradient`/`color`; UI mock-up panels never do). `color`: solid colour of the band (own, a child or a visible `::before`/`::after` layer covering >= 85%, or nearest ancestor; composited). `sampled`/`sampledShare`: dominant colour of the band region in the full screenshot and its pixel share. **The screenshot wins** when it clearly covers the band: `sampledShare > 0.8` with a different colour makes `color` the sampled colour and moves the CSS value to `cssColor`. **Settled colour**: every band is also scrolled to the viewport centre and left to settle (the same pass feeds `motion.scrollTint`); when its settled colour differs from the same rows of the full shot (a band that changes theme on scroll, a scroll-driven page tint), `sampled` (and `color` for solid bands) take the settled value and `scrollTheme{rest, centred}` records both. `src`: self / child / pseudo / ancestor / root / media / nav |
| `layout{cols, ratios[], gap, overflow?, rowCover?, collage?}` | main horizontal row: the largest descendant container (>= 40% band width, >= 100 px tall) whose first-row children sit side by side and fill >= 60% of it (items clipped away by an overflow ancestor do not count); `ratios` = child widths / sum; `gap` = median gap px; `overflow` = row extends past the viewport or its clip; `rowCover` = row height / band height (in a band >= 2 viewports tall a row with `rowCover` < 0.4 is weak evidence of its column structure: scoring.md layout columns); `collage` = every row item is a text-free media piece and their widths or heights differ >= 1.5x: one media object (compare counts it as 1 column) |
| `cards{n, cols, rows, gap, like, w, h, overflow?, peek?, collage?}` / `null` | largest group of >= 3 similar-width siblings (grouped by tag + first stable class, and by tag alone so per-item class variants still group); `cols` = items in the first row that are in view; `like` = items have their own background/border/shadow/rounded clip, or media + text; `peek` = the row overflows and the next item is partly visible (carousel peek); `collage` = every item is a text-free media piece and their heights differ >= 1.5x, they overlap, or the band's row is a collage (compare: no card grid) |
| `counts{}` | headings (h1-h6 tags), headingLike (tags or text >= 1.25x body), paragraphs, buttons (button-like), links, media (all picture-painting boxes, outermost), images (img + background-image), svgs, art, videos, canvas, composites (UI mock-up panels), inputs, words (chars/6); visible elements only |
| `align` | left / center / right / mixed: text-align of the band's text weighted by characters (>= 60% wins) |
| `media{place, kind, frac}` | largest media (>= 4% of band area): background / full-bleed / left / right / below / above / center relative to the band and its main heading; `none` if no media. **Media = `<img>`/`<picture>`/`<video>`/`<canvas>`/`<iframe>`, inline `<svg>`, background-image boxes, art boxes** (no text inside, >= 48x48, a gradient or a solid fill different from what is behind it) **and HTML/CSS composite panels** (a bordered, shadowed or filled box >= ~15% of the band width and >= 120 px tall holding UI-like content: mostly text smaller than body, chips, ruled rows, nested filled boxes; not an item of a repeated card grid, not the band itself), all equivalent, by painted area, nested media keep the outermost box. `kind`: img / svg / bg-image / art / video / canvas / iframe / composite |
| `headPx` | largest font size in the band |
| `pad[top, bottom]` | distance from band top to the first content box and from the last content box to band bottom (see boundaries above); content of any kind counts, including large media and art, unless it is the band's background. Art built from absolutely positioned pieces inside an in-flow, text-free box of the band (an illustration wrapper that paints nothing itself, < 95% of the viewport wide) counts by its visible pieces (clipped as drawn): an art-led band measures to its first piece, never to the empty wrapper or to the first text below the art |
| `contentX[left, right]` | left/right edges of the band's text and media blocks (full-bleed media excluded) |
| `analysed`, `thirdParty`, `empty` | present when `false` / `true` / `true`: not analysed (element cap), third-party chrome, no visible content |
| `shot?{blank, inView}` | present when either is >= 0.05: `blank` = share of the band's CSS-visible text area that still shows no ink in the full shot (>= 0.5: read that band from the frames, not the full shot); `inView` = share of its rows filled from in-view shots (content that exists only while in view: compare does not read the band's media "none" as evidence then). Also on `sectionsByViewport` bands |
| `navOverlay?`, `pos?` | band has the nav laid over it; css position of a nav band |
| `collapse{vp}` | the same band at other viewports (narrow bands linked to it by DOM signature): `{cols, cardCols, h, bands[]}`; `{unlinked: true}` if it is rendered but no narrow band could be linked; `null` only if its element is not rendered there (`display:none` / zero size) |

## sectionsByViewport{vp}[]
Each narrow viewport is segmented with the same algorithm as the primary one (mobile-only sections
become their own bands instead of padding of the next band), then each band is linked to a primary
band by DOM signature (`link` = index into `sections[]`, `null` = no primary counterpart, e.g. a
mobile-only band). Fields: `id, i, link, role, y, h, hFrac, bg{type,color,sampled,sampledShare,src}, cols,
ratios, cardCols, cards (count), cardGap, peek, rowCover, collage (row / cards / both), align, pad, headPx,
media (place), gapBefore, analysed, thirdParty, empty`. The size cap keeps `id, i, role, y, h, hFrac, link`,
columns, cards, `peek, collage, align, pad, headPx, media` and `bg{type, color, sampled}`. The digest's band
table prints each band's narrow `pad` (p top/bottom) and `headPx` (hd) per width.

## colors (primary viewport)
Painted areas come from visible, non-third-party elements, including visible `::before`/`::after`
layers (fills and gradients painted by pseudo-elements count like boxes, with occlusion); filled boxes
1-3 px thick are rules and count as border colour, not as a surface; bands with `role: "ad"`, removed
popups and blocked-embed placeholders are left out. Footer link text counts as footer text, not as an
interactive link colour, for the accent role. **Logo / brand marks are left out of the palette areas,
accent and minor colours** (they are the brand, not the palette): an svg or img in a link to the home
page in the header or footer, text of <= 30 chars in a header link to the site root (not a bare `#`), an
element <= 400x160 px named as a logo up to 3 levels up (a class
token with logo / wordmark / brand-mark, `brand`, `*-brand`, `brand-logo`; id, aria-label or title with
logo), or an item of a logo strip (>= 4 svg/img of similar height <= 100 px in one row, at least half wider
than 1.6x their height, little text). Their chromatic colours are noted in `notes` ("brand-mark colours
left out ...").

| field | meaning / how measured |
|---|---|
| `theme` | `dark` if the page background's OKLab L < 0.5, else `light` (follows `pageBg`) |
| `roles` | `pageBg`: what most band area and the first screens show: every 1440 band but the nav votes its background colour (`sections[].bg.color`; a gradient band its sampled colour when >= 50%) by its height, rows inside the first two screens count again, the footer counts half, picture bands (image / video / canvas) do not vote; so a footer or one dark band never outweighs a mostly light page, and the reverse (without bands: largest painted background, html/body preferred, screenshot cross-check). `text` / `mutedText`: from running text only (text outside buttons, nav, tab/menu controls, UI mock-up panels, media / art / stand-in boxes and aria-hidden copies (aria-hidden text whose words are also shown without aria-hidden; visible aria-hidden text with no such twin counts), not over a picture covering >= 50% of its box, effective opacity >= 0.3) drawn on the page background (the colour behind it and its band within 0.15 lightness of `pageBg`) and contrasting with it (>= 0.3 lightness), by glyph area: `text` = the leading colour, or, when the leading colour is grey prose (contrast <= 0.65 with the page), a neutral that contrasts more by > 0.1 and has >= 15% of its area (headings over grey prose; near-black prose such as #1d1d1f stays `text` beside pure-black headings); `mutedText` = a secondary neutral (>= 4% of the area, ΔE >= 0.04) whose contrast is at least 0.15 lower than `text`'s (never a second near-black). `surface` (next background, card backgrounds weighted double), `border` (largest border length x width, hairlines favoured). `accent` / `accent2`: from visible actions only: filled buttons with a visible label, icon-only filled controls (a button or link of 28-96 px drawing an svg/img icon, outside the footer) and text links outside nav and footer link lists; never inside media, art, illustration, mock-up or stand-in boxes, never hidden, opacity < 0.5, off-screen or an inactive slide, never a brand mark, never a button filled with the page background. Score = 2 x share of button fill area + share of buttons + share of link glyph area + 0.5 when used in the first 1.5 screens; a chromatic action colour (OKLCH C >= 0.06, on >= 1 button or >= 2 links) is `accent`, the next of another hue (>= 25° or ΔE 0.1) `accent2`; with none the page is monochrome and `accent` = its primary button fill (black / white / grey; note "accent = primary button fill (achromatic)"); with no filled button, the link colour (WEAK). Text and accent roles are the exact hex of the winning element colour; the others the most-used exact hex of their kind inside the colour cluster. |
| `weak{role}` | roles whose evidence is split or thin, with why: `pageBg` (a colour of the opposite lightness has >= 60% of the winner's band vote), `text` (running text on the page background < 10% of all text), `accent` (chromatic links only while filled buttons are another colour; link colour for want of a filled button; no visible action). The digest prints WEAK on the role line; compare weighs a WEAK reference role x0.5 |
| `roleWhere{role}` | an example element painting that role colour (`desc @band n`) |
| `palette[]` (<= 12) | `{hex, oklch, share, uses{bg,text,border,graphic}, roles[], shot, variants?}`. Areas: background boxes minus the boxes of occluding descendants (backgrounds, media), glyph area for text (chars x size² x 0.5), border length x width, svg fills (low weight). Colours within OKLab distance 0.025 are merged. `share` = share of all painted area; `uses.k` = share within that kind; `shot` = share of full-screenshot pixels within ΔE 0.04 |
| `minor[]` (<= 16) | chromatic colours (OKLCH C >= 0.06) used on text, tags/badges (small filled boxes with text), SVG icons (<= 64 px: fills and strokes of up to 12 shapes, `icon`), larger SVGs (`graphic`) and SVG `<text>` fills (`text`), inside composite panels and aria-hidden art too, ranked by element count regardless of area: `{hex, oklch, n, share, uses[], ex, band}` (red kicker tags, category labels, icon tints); `share` = its painted area (glyph area for text, box area for tags and icons) / the page's text glyph area |
| `clustersBeforeCap` | number of colour clusters before the 12 cap |
| `gradients[]` (<= 10), `gradientsTotal` | `{css, n, areaFrac, where, bands[], clipText?, onMedia?, thin?}`: raw `background-image` gradient strings (urls blanked), element count, area fraction, contexts (band/card/button/text/other), band ids; total before the cap. `onMedia`: every instance lies over a picture (img / video / canvas / picture / iframe or a background-image box under >= 50% of the gradient box) or is layered over its own `url()` image: an overlay on media (caption scrim, photo fade); `thin`: every instance is under 64 px on its short side (a strip). Both stay listed (the digest marks them) but are not band gradients for compare. **Stand-in pieces are left out**: gradients painted by a text-free element (or its `::before`/`::after`) strictly inside a media / illustration box (a first-screen hero media box, `motion.load.media`, unless it is a background-image box holding text; a text-free media or art box; a composite panel) are that box's picture, not palette gradients; the box's own gradient still counts |
| `vars{}` (<= 60) | `:root` custom properties whose value is a colour (computed), named colour-ish first |
| `screenshot{fold[], full[]}` | top colours of the fold (8) and full (10) screenshots, merged within OKLab 0.015 |
| `mediaAreaFrac`, `imageHeavy` | area of img/video/canvas/iframe/background-image boxes / page area; `imageHeavy` = >= 0.25. Image colours are never used for roles. |

## type
| field | meaning / how measured |
|---|---|
| `families[]` | `{family, category, webfont, local?, generic?, unresolved?, variable, source[], weights[], share, roles[], stack, width, adv, xHeight}`. `family` = first family in the computed `font-family` stack that is actually rendered: a loaded `document.fonts` face (webfont), else a locally installed font (canvas width test), else a generic. `category` sans / serif / mono / display from the name, else the stack's generic fallback. `variable` = face weight range or variations source. `source` = @font-face src hosts. `share` = share of rendered characters. **Measured proportions**: `adv` = advance width of `Hamburgefonstiv` at weight 400 per em per character, `width` = condensed (< 0.44) / normal / extended (> 0.58), `xHeight` = x-height / em. `inCatalogue` = true / false (in the public Google Fonts catalogue or not; lib/font-catalogue.mjs) / null (catalogue unreachable and not in the bundled subset) / `"system"` (a generic or common OS font): only a true family may be used by a build |
| `webFonts` | `{catalogue, families[{family, via[], hosts[], inCatalogue, catalogueAs?}]}`: the web fonts the page loads. `via` `google-css` = named in the `family=` params of a fonts.googleapis.com css/css2 request (link, `@import` or script; every request is recorded) or served from fonts.gstatic.com; `font-face` = an `@font-face` rule with a `url()` source (data: URIs included) in a readable or fetched stylesheet. Faces whose `src` is only `local()` (metric fallbacks such as "X Fallback" with `local("Georgia")`) are not web fonts. `inCatalogue` as above (exact name, or after packaging suffixes such as Variable / VF / Pro: `catalogueAs` names the catalogue family). `catalogue` = the list checked: `google (fetched)` / `google (cached)` / `google (cached, stale)` (the metadata list https://fonts.google.com/metadata/fonts, cached for 7 days as `google-fonts-catalogue.json` in the capture dir's parent, e.g. `<out>/.restyle/`) or `bundled (offline)` (the fontmatch candidate list; a note says so). compare's `font-catalogue` health check reads this on the build (scoring.md Health) |
| `roles{vp}` | per viewport: `display, h1, h2, h3, body, small, nav, button, eyebrow`, each `{px, weight, declared?, synth?, lh (ratio, null = normal), lhr, lhPx, ls (em), tt, style, family, color, n, tags?, ex, band, how, ink, adv}`; a role is absent when not found. `lhr`/`lhPx` = the **rendered** line box (ratio to px, and px): one line of the role's text laid out in a hidden probe with the role's exact computed font and line-height, so `normal` and a number that render the same read the same. `tags` (heading tiers) = histogram of the members' tags. `ink` and `adv`: see "Visual heaviness" below |
| `samples{role}` | 1440 only: `{text, bbox[x,y,w,h], px, weight, declared?, ls, color, bg, family, style, shot, sampleQuality}`: the first rendered line of one of the role's members, its line box in document px of `shots/1440-full.png`, its colours, and `shot` = `shots/type-<role>.png` (that line + 4 px). Input of `inspect.mjs fontmatch`. **Choice**: members (document order, up to 40) are ranked by the issues of their first line: image/video/canvas or gradient behind it, two text colours on the line (every element owning characters on that line box, `background-clip: text` gradients count as two), WCAG contrast (< 1.8 poor; 1.8-3 and 3-4.5 ranked after >= 4.5), < 6 visible characters, and for `display` / `h1` a line below the first screen (the hero first); the best five are then re-judged on the full screenshot's pixels (`pixels` = `{frameOut, bg, contrast}`: share of the 2 px frame around the line off its median colour, that colour, drawn contrast of the farthest ink pixel): a busy frame (> 10%) or a low drawn contrast ranks after a clean high-contrast line, whatever the DOM says paints the background (a canvas-painted dark band reads as its pixels). `candidates` = how many were judged. The pixel verdict joins `sampleQuality`. An inline span of a two-colour heading is a member too, so its one-colour part can be the sample. Skip links and text parked off the page are never members. `sampleQuality` = `{level: "good"\|"poor", reason}`: `poor` lists the chosen line's issues (`busy background (...)`, `two colours in the line (...)`, `low contrast (...)`, `too few glyphs (n)` for < 4); a poor sample must not be trusted for weight, width or tracking. This field is the capture's input: `summary.md` and fontmatch print one verdict for the crop (fontmatch output below) |
| `scale{vp}` | size ratios between consecutive present roles (`h1/h2`, `h3/body`, ...) |
| `bodyPx{vp}` | body size used as the reference for the rules below |
| `stats{vp}` | present when the page has **stat figures**: heading-like blocks (heading tag or text >= 1.25x body, not nav/buttons/aria-hidden) whose whole text is one short numeral (<= 14 chars: `98%`, `2.4M`, `$12k`, `24/7`, `4.9/5`, `#1`, `10 min`). `{px, weight, family, n, sample, band, ex}`: the modal size, the modal rendered weight + family at that size, the number of stat blocks, the first one's text, its band index and element. Stat figures never form a heading tier and are never the display text (unless the page has no other text) |

**Rendered weight**: `weight` is the weight the text is actually drawn in: the nearest face of its
family by CSS font matching over the declared faces (loaded, or declared and used; unicode-range
subsets and weight ranges included), so a declared 900 on a font that only has 400 renders 400. When the
declared weight is more than 200 above that face and font synthesis is allowed, the browser fakes bold:
`synth: true` and `weight` = face + 300. `declared` is present when it differs. Local/system fonts
(no `document.fonts` face) report the declared weight.

**Visual heaviness** (`ink`, `adv` per role and viewport): the fixed sample `Hamburgefonstiv 0123` is
laid out in a hidden DOM probe (black on white, fixed at the top left) in the role's exact font: the
computed `font-family` stack (so the same face resolves as on the page), its px, weight (a synthesised
bold renders the same way), style, letter-spacing, `font-stretch`, `font-variation-settings` and
`font-optical-sizing`, and rasterised with one screenshot per viewport (canvas text cannot apply
variation axes). Every role on every site is measured this way. `ink` = antialias-weighted alpha sum /
(advance width x font px): the share of the string's em box that is ink, comparable across sizes and
families (Arial regular at 18 px is about 0.21, Arial bold about 0.30). Text up to 24 px is averaged
over 0.94x, 1x and 1.06x its size so pixel-grid hinting at one size does not read as weight. Two
roles with the same declared weight in different families can differ by 30% or more: that is what a
designer sees as "lighter". `adv` = advance width of `Hamburgefonstiv` per em per character at the
role's weight, without tracking: the same unit as `type.families[].adv` (equal to it for a weight-400
role), so a bold role reads wider than its family's 400 measurement. `null` if the canvas could not
draw the font.

Role rules (`how` says which fired), on visible text only: **body** = the running text: character-weighted
modal size of **prose** (text in blocks holding >= 40 characters, split-text spans and two-tone runs
collapsed into their block, 11-30 px, any tag: a statement set as `<p>` on one page and `<h2>` on another
is the same text; outside nav, footer and buttons), leaving out, when other prose remains: text inside
**UI mock-up panels** (a filled, outlined or shadowed box, or one covered by a `::before`/`::after` fill,
>= 120 px tall, >= 15% of its band's width, < 85% of the band's area, holding >= 3 nested filled/outlined
boxes and >= 6 text elements; a panel inside a group of same-tag siblings counts like a single one) or in
an aria-hidden subtree; **small print** under 13 px that trails the page (below the last >= 20 px text
outside nav and footer: legal copy outside a `<footer>`), or any prose under 13 px when the larger prose
holds >= 25% as many characters (tile grids, UI text); and **lead paragraphs** (a size used by at most one
block per band, in >= 2 bands, each <= 260 chars, >= 1.15x another prose size that has >= 3 blocks in >= 2
bands, at least as many blocks as the lead size and >= 25% of its characters: when the one-per-band
descriptions outnumber the smaller blocks, they are the body). `body.lead` (record only, never a role or
scored) = intro paragraphs larger than body: prose >= 1.1x body, at most one block per band, outside
mock-ups, `{px, weight, lh, ls, family, n, ex, band}`. **display** = largest rendered text (stat figures
left out).
**Heading tiers come from size clusters and their use, never from tags**: heading-like blocks (heading
tags or text >= 1.25x body, <= 240 chars; a heading-tag block of >= 80 chars under 1.25x body is a
statement, i.e. text, not nav/buttons/aria-hidden decoration, not entirely in the
footer (footer column labels are not a tier) unless nothing else is heading-like; split-text spans
collapsed into their block, and line spans set `display: block` inside one heading element collapsed into
that heading; not stat figures (`stats` above); not a **text wordmark**: <= 30 chars in the header (the nav
band, a `<header>`/banner box <= 260 px tall near the top, or the top 120 px of the page) that links home
(`/`, `#`, the page itself) or is named as a logo / brand (class, id, aria-label or title up to 4 levels up),
in the footer linking home, or anywhere in a box <= 400x160 px named as a logo (class token with logo (not
`logos`) / wordmark / brand-mark, `brand`, `*-brand`; id, aria-label or title with logo, up to 3 levels up);
not a **row of text logos**: >= 4 blocks of <= 24 chars outside heading tags, one size (within 10%), siblings or
cousins in one band, at least two side by side on one line, at most a quarter with other text within 1.5x their
height below (card titles have text below them); not a **keycap label**: <= 4 visible characters (a digit, a
symbol, "esc") inside `<kbd>` or in its own box (element or an ancestor up to 2 levels, <= 5x the font size
tall and <= 12x wide, with a fill, outline, shadow or covering pseudo fill))
whose sizes are within 3% form a cluster. **h1** = the largest cluster
(>= 1.2x body when one exists), **h2** / **h3** = the next clusters below (each <= 0.97x the one
above, >= 1.1x / 1.04x body), preferring clusters used >= 2 times. Two h1 elements on the reference
and one on the build therefore read the same when the sizes match; `tags` shows which tags carry a tier.
**small** = modal size below body. **nav** = modal style of links inside `<nav>` (brand link
excluded). **button** = modal style of button labels weighted by button area. **eyebrow** = short
uppercase / tracked label right above a heading. The style of a role is the modal (size, weight,
line-height, tracking, transform, style, family) combination among its members; `ex`/`band` name one.

## spacing
| field | meaning / how measured |
|---|---|
| `container{vp}` | `{textLeft, textRight, textBands, railLeft, railRight, railBands, contentLeft, contentRight, contentWidth, contentBands, contentHow, fullWidthBands, maxWidthCss, maxWidthBands, centredWidth, centredBands, gutter, gutterHow}`. **The content column actually painted**, from full-width bands only (bands whose element spans the viewport or the page frame; a narrow centred block never sets it): `textLeft`/`textRight` = modal left/right edges of running text blocks (the text inset), `railLeft`/`railRight` = modal edges of cards, media, rules and the main row of a multi-column band (its content extent, `sections[].contentX`, so a two-column page's container is not read from one column) that are fully in view and span >= half the frame (the rail), 8 px buckets with the median inside the bucket. `contentLeft`/`contentRight` = the rail edges (the text edges when a page has no rails: `contentHow`), `contentWidth` = their distance. `maxWidthCss` = most common px `max-width` of centred wrappers (counted once per band), `centredWidth` = most common width of centred containers, `gutter` = smallest text left edge shared by text blocks in >= 2 content bands (for reference) |
| `sectionPad{vp}` | `{modeTop, modeBottom, medianTop, medianBottom, values[[t,b]]}` from bands' `pad` (4 px buckets for the mode) |
| `gaps{vp}[]` (<= 8) | `{px, n}`: non-zero flex/grid `row-gap`/`column-gap` values |
| `stack{vp}` | `{headingToText, textToButton, headingToTextAt, textToButtonAt}`: modal vertical distance from a heading to the text below it, and from text to a button below it (<= 120 px); `...At` = `{el, band, n}` an example of the modal value |
| `radius` | `{button, card, input, image, top[{v,n}], how}`: area-weighted modal `border-top-left-radius` per kind (`"pill"` = radius >= half the height), plus the most common radii overall |
| `shadows[]` (<= 5) | `{css, n, on}`: raw `box-shadow` values with counts and where used |
| `borders[]` (<= 6) | `{w, color, sides, n}`: border width, effective colour, sides (`all`, `t`, `b`, `rl`, ...) |
| `nav` | `{pos, posCss?, posHow?, h, bg, transparent, overHero, blur, shadow, border, linkCount, ownBgAlpha, byViewport{vp}, onScroll}`. Nav = best header-like element near the top (fixed/sticky, header/nav tag, contains `<nav>`, >= 2 links, >= 85% wide, 28-220 px tall), third-party chrome excluded; a fixed/sticky element filling an in-flow wrapper's box is the nav (its position is reported). **`pos` follows the screenshots**: when the bar is still at the top of `<vp>-scrolled.png` (`onScroll.shot.pinned`) and the computed position is in-flow, `pos` = the pinned header's position (else `sticky`), `posCss` = the computed one, `posHow` says why. |
| `nav.onScroll` | `{changes{prop:[top, scrolled]} \| null, hidesOnScroll?, staysInView, reappears?, scrolled}` from the scroll-pass rests. At each rest the header pinned at the top of the viewport is found (fixed/sticky, >= 85% wide, at the top; it may be a different element that appears on scroll). `staysInView` = a header is pinned at the majority of the scrolled rests and at the rest nearest 1.5 viewport heights down. `hidesOnScroll` = a pinned header slides/fades away and no header stays (an in-flow header simply scrolls away: `staysInView: false`, no `hidesOnScroll`). `scrolled` = the pinned header at the rest nearest 1.5 viewport heights down: `{visible, el, swapped?, h, bg, transparent, blur, shadow, border, links, buttons, extra?[{desc, bg, h}]}` (`extra` = filled/outlined buttons that appear only in the scrolled state, e.g. a CTA). `changes` keys: `h, bg, shadow, blur, border, color, transparent, extra, line`. **`shot`** = `{pinned, match, edge[rest, scrolled]}` from the fold and scrolled screenshots (motion.mjs navShots): `match` = share of the bar's edge pixels (luma steps > 40 in its rows) found again in the scrolled shot within 1 px; `pinned` true at >= 0.6 (then `staysInView` is true), false at <= 0.25 (then `staysInView` is false unless a pinned header was found there), else null; `edge` = a thin line (1-3 uniform rows at the bar's bottom, >= 8 levels off the bar colour) or a soft shadow under the bar in each shot. **`changes.line`** `[rest, scrolled]` = such a line or shadow that only one of the two shots shows on a pinned bar (`scrolled.line`), whatever paints it. **`scrollDriven[]`** = scroll-driven animations (scroll / view timelines) on the bar or inside it: its scrolled state (a `boxShadow` one adds `changes.shadow`), never counted as scroll-scrubbed content (`motion.scrollTimeline.nav`) |
| `nav.byViewport{vp}` | `{pos, posCss?, h, shot?{pinned, match}, scrolled{pinned, how?, h?, bg?, transparent?, buttons?}}` (scrolled = after scrolling 1.5 viewport heights at that width; `how: 'scrolled shot'` = the bar was still at the top of `<vp>-scrolled.png` although no pinned header was found there) |

## components{} (primary viewport)
Keys `nav, primaryButton, secondaryButton, card, input, link, badge`; `null` when not found (listed in
notes). Chosen among visible elements only; controls parked off the page until focused (more than half
of the box above the page top or below its end, e.g. skip links) and in-page "skip to / jump to" links
positioned out of the flow are never buttons, inputs, links or hover targets (horizontally off-screen and
visually hidden boxes are already invisible). Each: `{desc, x, y, w, h, pad[t,r,b,l], radius, border, bg, color, font{px, weight, family, ls, tt, lh}, shadow, transition, blur?, shot, hover?, colorWeak?}`. `colorWeak` = `{seen[], why}`: none of the 10 most common colours of the component's own box (in the shot it is cropped from) is within OKLab 0.08 of its CSS `color` (a transparent button over art, text recoloured by a blend mode or a child layer); `seen` = the box's top colours; the digest marks the line WEAK: read the colours from the crop.
Selection: button-like = `<button>`/`role=button`/`<a>` 24-84 px tall with a short label and a fill
or outline (on itself, a single child, or a `::before`/`::after` layer covering it: `bgFrom`). **primaryButton** = filled button with the highest chroma +
contrast (bonus in the hero). **secondaryButton** = outline/neutral button of similar height (+-35%)
nearest the primary. **card** = first visible item of the best card-like group (>= 15000 px², <= 60% wide).
**input** = text-like `<input>` 28-72 px tall (else textarea/select). **link** = the first link of the
best kind, `kind` = `inline` (inside running text) > `text` (a standalone text link, underlined first) >
`block` (wraps media >= 40 px or a box > 60 px tall / 600 px wide: card links) > `control` (no visible text);
footer links last (`footer <kind>`). The same order on every page, so both sides crop the same kind; the
`text-link` hover targets are inline / text links only. **badge** = small (14-36 px) non-interactive labelled box with a fill/border and radius.
`hover` = that component's hover delta (see below) when it was hovered.

## hover[] (primary viewport, <= 12)
Up to 2 nav links, primary, secondary, up to 2 cards, 2 text links, 2 other buttons with distinct
styles, a footer link and an image link. Each is scrolled into view, the real mouse moves onto it, the
script waits for its longest transition (+180 ms, cap 1.6 s) and diffs computed styles:
`{kind, desc, self{prop:[before,after]}, before{}, after{} (::before/::after), kids[{desc, kind (image/icon/text/box), delta}] (<= 6), transition, cursor, note?}`.
Props are camelCase CSS property names (`self.backgroundColor: ["#e5e5e6", "#ffffff"]`): color,
backgroundColor/backgroundImage, border top/bottom colour (only if painted), boxShadow, opacity,
text-decoration line/colour, filter, outline, letterSpacing, transform (`{tx,ty,s,r}`), pseudo
width/content. `kind`: `nav-link`, `primary-button`, `secondary-button`, `card`, `text-link`,
`button`, `footer-link`, `image-link`. `{kind, skipped: reason}` when it could not be hovered or the read failed
(element detached or re-rendered during the hover, computed values empty): a failed read is never
reported as changes. Each kind is picked by the same rule on every page, only among valid elements
(shown: no opacity ~0 or visibility hidden on it or an ancestor, >= 8x8 px; not moved by an infinite CSS /
WAAPI transform animation on it or an ancestor): `nav-link` = a menu item of the header (a text link with
no icon, not a button, tab, skip link or the logo / home link, styled like another such link); `card` =
the topmost repeated card-like group of card size (>= 15000 px², <= 60% of the viewport wide, >= 80 px
tall) in a static row or grid (not one running past the viewport). `invalid` (reason) = not a valid sample
after all: its crop changed with the pointer away (`moves without hover`: a marquee, an auto-advancing
slide; the next element of that kind gets the crop pair) or it was not shown once scrolled into view;
compare skips the kind on that side.

## motion
| field | meaning / how measured |
|---|---|
| `transitions[]` (<= 25) | `{prop, ms, easing, delay, n, family, noop?, rv?}`: every non-zero CSS transition on displayed elements (including transparent ones waiting for their reveal; third-party chrome excluded) plus button pseudo-elements, grouped by property+duration+easing with element counts. For elements seen animating in this capture (a scroll reveal or a kept load animation): `noop` = elements on which the property never changed and no state rule (`:hover`/`:focus*`/`:active`/`:checked`/`:target`/`[aria-expanded]`/`[open]`...) matching the element sets it (a transition that does nothing visible); `rv` = elements on which it carries that reveal / load change (its timing is the reveal's / load's). Sorted by `n - noop - rv` |
| `transitionsObserved` | number of elements with transitions that were checked for `noop` / `rv` (absent on older captures) |
| `cssAnimations[]` (<= 12) | `{name, ms, easing, iter, delay, n, on, variants?}` from computed `animation-*` (names differing only by digits merged) |
| `keyframes{name:[[keyText, declarations]]}` (<= 12, <= 8 steps) | referenced `@keyframes` from CSSOM or fetched cross-origin CSS, most used first, one per name pattern |
| `getAnimations[]` (<= 20), `getAnimationsTotal` | `document.getAnimations()` after the scroll pass: `{type (transition/animation/waapi), name, props, visual, ms, easing, iter, state, n, on, scrollTimeline, variants?}`; `visual` = changes a visible property (custom-property-only animations are state detectors) |
| `load` | load-time animation of the first screen (below) |
| `reveals` | scroll reveals (below) |
| `ambient` | continuous motion inventory (below) |
| `scrollTint` | `{changes, colors[{at, band, color, rest}], rests, how}` or null: at every rest of the scroll pass the dominant colour of the middle 70% of the viewport is compared with the same document rows of the full-page shot (scroll-0 state); a rest whose colour differs (OKLab > 0.02, both colours >= 30% of the rows, and the rest colour covers < 15% of those rows in the full shot) shows a background that changes with scroll position (a scroll-driven page tint), whatever paints it: body background, a fixed layer (kept in the comparison: a full-page shot shows it in its scroll-0 state) or a pseudo-element. Rests inside the range of a sticky/pinned section >= half a viewport tall are skipped, and so are rests where the page height differed from the full shot (lazy content still arriving). Consecutive rests of a similar colour count as one change; bands that settle to a different colour when centred (`bg.scrollTheme`) are added. `at` = scroll px, `color` = the colour at that rest, `rest` = the full shot's colour of the same rows, `rests` = number of rests sampled. **Timing** (a fresh page scrolled in 30 px steps from 1.5 scroll steps before `at`, colour read 150 ms after each step from the band's visible rows below the top 12%, or the middle 70% for a change without a band, against the same rows of the full shot): `triggerAt` = scroll px where the colour has moved >= 15% of the way to `color` (and is nearer it than any other tint colour of the page); `triggerBand` = the tinted band when its top is in view (or < 10% above it), else the band whose top is entering the viewport (a tint shown inside a tall band is triggered by the next band coming in); `bandTop` = that band's top edge as a fraction of the viewport height at that moment (0.6 = the change starts when its top is 60% down the viewport); `ms` = time from that scroll step until the colour stays within OKLab 0.004 of its final value (includes the page's own trigger latency); `scrub: true` + `rangePx` = the colour stops part-way and follows the scroll position (scroll distance to >= 85% of the change); `triggerAt: null` = not found (`early: true` = already changed when its rows came into view). `timing` = how these were read. **`states`** (per change with a band) = the band's colour per state from the capture's evidence: `before` (the full shot's colour of those rows, scroll-0 state: how it looks before it is scrolled to), `entering` `{color, bandTop}` (the rest where the change was seen, when the band's top edge was in view, -0.1..1 of the viewport), `centred` `{color, top}` (band-centred pass); `shape` = `flash on entry` (centred back to `before`, entering differs), `changed while in view` (centred = entering) or null. A change is a timed transition unless `scrub` is true; `triggerAt: null` says nothing about scrubbing. Only measured when `changes > 0` |
| `sticky[]` (<= 10) | `{el, id, kind (fixed/sticky/pinned), h, hFrac, top, range[from,to], always?, band}`: elements whose viewport position stays put (< 6% of the scroll distance) across rest positions; `pinned` = held in place without position fixed/sticky (JS pinning); `range` = document scroll range where it stayed. Third-party chrome excluded |
| `parallax[]` (<= 10) | `{el, id, kind, rate, evidence, pairs, band}`: elements whose measured viewport movement / scroll distance differs from 1 by >= 0.08 in >= 2 rest pairs (not during a reveal); `rate` 0.7 = moves at 70% of scroll speed; also `background-attachment: fixed`. A `data-speed`-like attribute alone is not parallax. **Layout shift is not parallax**: per rest pair the median deviation of the in-flow elements in view (>= 4, not fixed/sticky) from the scroll distance is the content's own shift (an ad slot or embed resizing, lazy content, scroll anchoring), and rates are measured against the distance the content actually moved; a pair in which the page height changed and an element's remaining deviation is 60-100% of that change is a layout shift for that element. **Stand-in pieces are not parallax**: a text-free element strictly inside a media / illustration box (the boxes of `colors.gradients`' rule: hero media boxes, text-free media / art boxes, composite panels) moves as that box's media activity, whatever moves it (keyframes, script, scroll), and is left out of parallax, scroll-driven horizontal movement and the layout-shift median |
| `horizontal[]` (<= 8) | scroll-driven horizontal movement (`rateX` per scroll px, `distance`) and native overflow-x scrollers `{kind:'overflow-x scroller', desc, id, band, w, scrollW, snap}` |
| `marquees[]` | `{el, band, axis, dir, pxPerSec, css}`: continuous monotonic translation (>= 5 px/s) with no input of a **strip**: an element >= 15% longer than its clipping window along the axis (whatever it shows: a scrolling pattern counts), or one at least half as long as the window, moved by its keyframes over >= 40% of its own length, that holds text or media (an empty element sweeping across is a gleam loop). The window is the nearest ancestor that clips along that axis (overflow not visible with content overflowing it, a clip-path, mask or paint containment), at most the viewport. Seen in a 1.5 s idle sample before scrolling (per 100 ms buckets) or while scrolling (JS marquees). A slow monotonic drift, bob or push-in of an ordinary element is a `drift` loop, not a marquee. **`marqueesByViewport{768, 390}[]`** = `{el, band, axis, dir, pxPerSec, css}` from a 0.9 s idle sample at that width (after its snapshot, before its scroll pass; `band` = that width's band id); `[]` = sampled, none moving; absent = not sampled (older capture or the viewport failed) |
| `loops[]` | `{el, kind, band, pxPerSec?, paused?, css}`: other continuous motion seen in the idle sample: rotate-loop / pulse-loop / oscillate / drift / loop; `paused` = a keyframe loop with holds (it moved in bursts) on an element with no content or by less than a visible step |
| `carousels` | `{libraries[], autoAdvance[], autoAdvanceCandidates[], watchMs, note}`. **`autoAdvance[]`** `{el, band, periodMs, steps, how (slide / fade / swap), stepPx}`: a slow watch of `watchMs` (8 s, from before the hero-media sample through the idle sample, pointer parked, no input) samples every 150 ms each element that starts a CSS transition/animation or gets a style/class change or a text / child change, and every horizontal scroller; an element holding content (text or media) that moves by a visible step (>= 25% of its window along the axis, >= 12 px, or an opacity swap >= 0.5) in separate bursts (>= 450 ms of rest in between; continuous movers are left to the idle sample) auto-advances; so does one whose text or fill / text colour changes without moving in >= 2 bursts (`how: swap`: a word swapping in a headline, a feed gaining a row; step chips or tabs lighting up in turn merge into their parent); stacked slides swapping opacity merge into their parent; `periodMs` = median interval between steps (null with one step); its slides are never scroll reveals. `autoAdvanceCandidates[]` `{el, band, periodMs?}` = these plus elements whose content moved by a visible step in a burst during the 1.5 s idle sample. Motion inside a hero media box (graphic motion over it, any piece inside its element) is that box's media activity instead (below) |
| `smoothScroll` | `{library, t90Ms, wheelDistance, basis, detected, input}`: smooth-scroll library present, and the time for the first wheel step to reach 90% of its distance (> 450 ms = smoothing). `input: 'scrollTo'` = the page ignored wheel input |
| `scrollPass` | `{steps, stepPx, ms, nativeScroll, trackedHidden, layoutTracked}` |
| `layoutBasis` | how scroll distance was measured for sticky/parallax: window scroll, or the visual offset of bands (transform-based scrollers) |
| `scrollTimeline` | `{elements, timelineNames, cssRuleHits{...}, scrollDrivenAnimations, nav, stateOnly}`: CSS scroll-driven animation usage; `scrollDrivenAnimations` counts only those that change a visible property and are not on the header, `nav` those on the header (its scrolled state, `spacing.nav.onScroll.scrollDriven`), `stateOnly` the custom-property-only ones |
| `scrollSnap[]` | `{desc, type, band, items}` containers with `scroll-snap-type` |
| `scrollBehavior` | `{html, body}` computed `scroll-behavior` |
| `cursor` | `{cursorNone, followers[{desc, w, h, blend, follow}]}` |
| `byViewport{vp}` | `{revealCount}`: elements hidden before scrolling that became visible after a fast scroll pass at that viewport (small fixed / sticky boxes left out, as for reveals) |
| `frames` | `{load{dir, n, fps, windowMs, distinct, t0, fcpAfterCommitMs, firstPaintAfterCommitMs, run, visual, settleMs, settleHow, settled, keepsMoving, leadIn?, appear?}, reveals[{dir, n, fps, t0, distinct, band, step?, scrollFrom, scrollTo, scroll, content?{..., appear?}, why?, like?}] (<= 4), media?{dir, n, fps, durationMs, distinct}, like?, hover[{kind, dir, n, visual}]}`; `load.t0` = `fcp` (strip starts at the frame showing first contentful paint) or `commit`; `load.windowMs` = 5000 (recorded span after first paint, `n` = 61). **`load.settleMs`** = ms after first paint when the first screen stopped changing: the later of the last visible change in the frames (`visual.lastChangeMs`: the last 250 ms window in which >= 0.4% of the frame changed, moving hero media masked and continuous motion masked: 5x5-px blocks of a 160x100 copy that change in the last second AND already changed 2.5-1.5 s before the end, i.e. repeating motion such as a marquee or a cycling logo row, `visual.contShare` = their share of the unmasked frame) and the end of the load animations the DOM sampler saw (`motion.load.summary.lastEndMs - motion.load.fcpMs`); when the frames are still changing in the last 500 ms (continuous motion: ambient loops, a carousel) only the load animations' end counts, and with none `settleMs` = null. `settleHow` = `frames` / `load animations` / `load animations; the frames keep changing after (continuous motion)` / `still changing at the end of the window (continuous motion)`; `settled` = `settleMs <= 4000`. **`load.keepsMoving`** = what keeps moving after the content settled, the same on any page: `{media: [{el, kind, activity, rate}] (moving first-screen media), other (= visual.contShare)}` or null; the sheets and the digest print it after the settle time ("content settled ~X ms after first paint; media keeps moving (canvas, medium activity, 7.2% of its box per second)"). **`load.leadIn`** (only when the strip has one) = `{skippedMs, paintedMs, coldPaintedMs?, why}`: `paintedMs` = ms after first paint at which the first screen first looks like it does once loaded (frame-0 distance to the last second of the strip >= 0.12, then within 35% of it, 32x20 colour blocks); `skippedMs` > 0 (= `paintedMs`) only when that lead-in is media or network arrival, never design: no load animation starts in it, the frames do not build up in steps (`visual.designed` false), and most of what is missing is a network-loaded hero media box (video, img, bg-image, iframe; >= 25% of the first screen) or the cold load (`coldPaintedMs`; 0 = the cold strip looked loaded from frame 0) got there clearly later; `why` says which. Sheets start that side's load row at `skippedMs` and print `why`; the frames on disk still start at first paint. `reveals[].t0` = `wheel` (frame 0 = the wheel input); `reveals[].why` = `scroll tint` on the extra strip recorded across the first `motion.scrollTint` change (the wheel step from the scroll-pass rest before it to the rest that shows it; added when fewer than 4 strips exist and no reveal strip covers that step; with `--frames-like` it is carried over from the reference strip), absent on reveal strips; `reveals[].scroll` = `{px, startMs, settleMs, firstFrameMs}` from a page-side requestAnimationFrame log of the scroll position (visual position, smooth-scroll libraries included): distance scrolled, ms after the wheel input when it first moved and when it reached its final position for good, and when the page's first animation frame after the input ran (a busy page delays it; then the other two are upper bounds). `reveals[].step` = the scroll-pass step the strip replays (normal mode; its reveal groups have `phase` `step<step>`). **`reveals[].content`** = when the content in view is in place after the scroll stops, from the frames (120x75 luma grids; cells that change in >= 2 of the last 4 frame pairs keep moving, e.g. media, and are left out, `movingShare`): `{settledMs (every later frame within 0.4% of the last frame), visibleMs (within 1.5%: visibly in place), scrollMs (first frame at or after `scroll.settleMs`; estimated from the frames without it), lagMs (= visibleMs - scrollMs, >= 0: how long content kept visibly changing after the scroll stopped), changed (largest share still differing from the last frame after the scroll stopped), inPlace (lagMs <= one frame: nothing visibly animates in this strip), appear}`. compare.mjs measures it from the stored frames when an older capture lacks it. **Appearance** (`reveals[].content.appear`, `load.appear`, `motion.load.groups[].appear`; frames.mjs appearOf, from the same luma grids) = how content arrives, whatever drives it: `{kind, atMs, ms, steps?, open?, y?, x?, drop, masked?}`. What has arrived by frame k = mean luma distance from the frame before anything arrives (the scroll-stop frame of a reveal strip; frame 0 = first paint of the load strip) over the cells that do not keep moving (reveal: as `content`; load: moving hero media boxes and cells that change in the last second and 2.5-1.5 s before the end), as a share of what has arrived at the end (median of the last 3 / 12 frames); opaque content that appears and then settles a few px counts as arrived when it appears. The rise is cut into runs of rising frames (one still frame inside a run is bridged); a run whose best two frame steps carry >= 80% of it is step-like. `kind`: `step` = step-like runs carry >= 70% of the rise (complete within one or two frames: network or lazy arrival, an instant switch; `steps` = separate jumps, `atMs` = the frame it appears in), `fade` = it eases in (`ms` = 5% -> 95% of its largest eased run: the visible duration; `open` = still rising at the end), `slide` = a fade whose arriving content also moves (its row / column profile half-way, normalised, aligns with the end only after a shift: `y` / `x` px still to go at about 35% of the way, positive y = it rises from below), `none` = nothing visible arrives (< 1.5 levels, or < 1.5% of the cells visibly change). `atMs` = ms after the wheel input (reveal) or first paint (load); `masked` = left-out share (load). A load group's `appear` is measured in its `box` (final first-screen rect `[x, y, w, h]`, members' union; null when < 6 kept cells or < 30% of its cells are kept). The strip wins over a sampled `ms` or start that disagrees (the digest marks it DISAGREES). `media` = the settled first-screen sample frames (above). `reveals[].like` (with `--frames-like`) = `{ref (reference sequence number), refBand, refScrollFrom, how (band / band run / fraction), frac}` and `frames.like` = the reference capture dir; `distinct` = number of different frames (1 = static); `load.run` = `warm` or `cold` (which load the frames show, the same run as `motion.load`). `load.visual` = how the first screen builds up in the load frames, whatever drives it (CSS, JS, progressive rendering), with hero media that moves by itself masked out (`masked` = masked share of the frame; its motion is `motion.load.media`): `{firstContentMs, growSteps, shrinkSteps, lastGrowMs, staged, live, designed, network, lastChangeMs, windowMs, masked?, cold?/warm?, fg[], diff[]}`, all over the whole 5 s strip (61 values in `fg`/`diff`), where `fg[k]` = share of frame k that differs from the settled page background, a grow step = a frame where that share grows by >= 15% of its final value (and >= 0.5% of the viewport), `staged` = >= 2 steps over >= 150 ms with no shrink step (content that disappears again, `shrinkSteps`) and less than half of the frame masked, `live` = still changing in the last 3 frames (continuous motion). **`designed`** = the staging is design, not network: staged, not live, and seen on the warm-cache load (or, when the frames come from the cold run, driven by `motion.load` animations). **`network`** = the cold load built up in steps but the warm load did not: slow progressive rendering, never a design trait. `cold`/`warm` = `{firstContentMs, growSteps, lastGrowMs, staged, live}` of the other run, for comparison (a much later `cold.firstContentMs` = a blank hold caused by the network) |

### motion.load
The page is loaded twice in the same browser context: the first (cold) load is the one the rest of
the capture measures; at the end of the capture it is loaded again with the HTTP cache warm and the
consent choice kept. **`motion.load` and the load frames describe the warm load** (`run: "warm"`),
because a blank hold or content arriving piece by piece on the cold load is usually the network, and
a designed staging repeats with a warm cache. Exception: when only the cold load showed a load
animation (an intro played on the first visit only), both come from the cold load (`run: "cold"`,
noted). The other run's summary is kept as `cold` / `warm` (`{groups, firstStartMs, lastEndMs,
staging}`). A `--fast` capture has no warm load (`run: "cold"`).

On each load, a rAF loop installed before any site script samples opacity, transform, clip-path,
filter blur and visibility of up to 600 elements in the first viewport (found by a scan every 250 ms
plus every node inserted in between, from the next frame). It runs until DCL + 5 s (cap 9 s), or
earlier once nothing has moved for 1.2 s after DCL + 2.5 s; the capture waits for it to finish.
- **From-state** = the most hidden of: the element's first keyframe / transition start value (read
  from its running animations when first seen or when it first changes), its first observed state,
  and its first sample. Frame drops during load do not split one animation into parts (all samples of
  an element form one run). Translation, scale and rotation are measured from where the element rests
  (its last sample; reveals too): an element centred with `translate(-50%, -50%)` rests at that offset,
  so a fade of it has no `x`/`y`, and `to` never carries a rest offset.
- **Ignored**: instant snaps (a change that completes within ~2.5 frames with no CSS duration),
  elements with an infinite animation, and motion still running when sampling stops after > 2.5 s
  (counted in `snapsIgnored`, `continuousIgnored`; that motion belongs to `ambient`). **Skip rules**
  (counted in `skipped{removed, thirdParty, fadeOut, tiny, digits, offscreen, media, repeating}`): pieces of a hero media box (below), elements removed with a
  popup or no longer in the page, third-party chrome / removed popups / blocked embeds, fade-outs
  (ending at opacity <= 0.05: a poster over a video), tiny elements (< 16x10 px or < 0.15% of the
  viewport), ticker/odometer digit rolls (text of digits and punctuation moving on x/y), anything
  outside the first viewport, and **repeating** changes (auto-advance, word swaps, cycling states: three or
  more bursts of change with holds >= 450 ms between them while the frame loop kept running, a change again
  after the sampler stopped when its last sampled change was >= 1 s before the end, or an element the first
  run's slow watch / idle sample saw repeating: the same `desc` over about the same box, or its parent / only
  child): they never extend the load timeline.
- **Staged load**: `summary.areaShare` = share of the first viewport's content (outermost visible boxes
  with own text, media, inputs and buttons, clipped to the viewport) that is inside a kept load change;
  each first-screen media box (below, not a text-holding background image) is one content box, animated
  when its own entrance (the box, or its content as a whole) is kept, whatever it is built from (one canvas
  or a stack of painted divs); a kept element holding no such box that paints (fill, background image, or a
  `::before` / `::after` layer with a fill, image or border: a glow, a gradient panel; for a wrapper, the
  union of its painted descendants) counts with its visible box on both sides of the share;
  `summary.textShare` = the same share over the content outside the media boxes; `summary.staged` =
  `areaShare >= 0.15` or `textShare >= 0.15` (as sampled; compare and the digest decide from the strip,
  frames.mjs `loadEntrance`, scoring.md load). A small flourish is recorded but is not a staged load.
- **Hero media** (`media[]`): media boxes in the first viewport (video, canvas, iframe, img, inline svg,
  Lottie/Rive/Spline players, custom-element players whose video / canvas / iframe sits in a shadow root
  (or named `*-video` / `*-player`), background-image boxes; composite illustrations: kind `art` = the
  smallest container holding >= 3 graphic pieces (images, svgs, canvases, background-image/gradient boxes,
  empty filled or outlined shapes) with <= 80 characters of text, not a single row of logo-like marks,
  never inside the site header or a nav;
  HTML/CSS stand-ins: kind `panel` = a UI mock-up (a filled, outlined or shadowed box holding >= 3 nested
  boxes or graphics, little or mostly small (< 15 px) text, no h1, form field or real call-to-action
  button) or a card stack (`stack`: >= 2 overlapping child cards); >= 3% of the viewport, outermost)
  are differenced inside their box by one measure (frames.mjs `boxActivity` via `sampleMedia`, the code
  `inspect.mjs activity` runs too): continuously (a 4 s screencast of the settled page; 6 fps picks written
  to `motion/frames/media` for `rate`/`active`/`hot`/`motion`, 12 fps over 1.25 s for `diff`) and on load
  (the first 1.5 s of the load frames, 12 fps): `{kind, el, box[x,y,w,h], band, activity, intermittent?,
  rate, rateLoad, rateCont, motion, axis?, dir?, pxPerSec?, appearsMs?, withLoad?, hot, diff, active,
  shifted?, moving, when (load / continuous / both), load, continuous, playing?, pieces?, keyframes?}`.
  **`rate`** = share of the box's pixels that differ by > 24 (RGB sum) between frames 1 s apart,
  averaged: how much of the box changes per second; `rate` = `rateCont` (settled page) whenever it was
  sampled: a box that only changes during the load (an image or art fading in) is static media after it,
  its load-phase change is its arrival (`appearsMs` / `withLoad`), never activity; `rateLoad` (>= 30% of
  consecutive frame pairs change) only when the settled page was not sampled (`when: "load"`). Frame pairs
  between which the whole page shifted vertically (a bar inserted above; luma row profiles of both frame
  halves match at one offset) are compared at that offset (`shifted` = how many), so a layout shift never
  reads as media activity. **`activity`** = the level of `rate` alone (frames.mjs `rateLevel`): static <
  0.004 <= low < 0.04 <= medium < 0.4 <= high; `intermittent` = it moves in bursts (`active`, the share of
  consecutive 6 fps pairs that change, < 0.5); `keyframes` (moving pieces seen inside) never raise it
  (captures before round 5: from `diff`: static < 0.003 <= low < 0.03 <= medium < 0.12 <= high; before
  round 7 `rate` was the higher of the two phases and a box changing in < 30% of frame pairs read static).
  **`motion`** = how it moves (strips of the box, luma profiles shifted to match, pairs ~1/3 s apart):
  `lateral` (most changing strips explained by one shift along an axis in one direction, >= 12 px/s:
  `axis`, `dir`, `pxPerSec`), `drift` (shift-explained over most of the box, slow or without one
  direction: a pan or zoom of the whole picture; `pxPerSec`), `cut` (bursts swapping a large part of the
  box: cuts, cross-fades, a stack cycling), else `in-place`; null when static. **`appearsMs`** = when
  the box first looks like its loaded self in the load strip (16x10 grid within 35% of frame 0's
  distance to the last second's median), `withLoad` = it arrives >= 120 ms after first paint (with the
  load staging; not when that is a skipped network lead-in) vs from first paint. `hot` = the half-width
  x half-height region that changes most over 1 s (first-screen px), which the sheets zoom into.
  **Motion inside a media box is that box's media activity**, however it is implemented: graphic motion
  (no text, not a marquee strip) inside or mostly over a media box, and anything inside the box element
  itself (page-core `rc.heroIn`: a track sliding across it, cycling cards or states, a hopping cursor;
  outside a `panel` never a heading, link or button) is never reported as a marquee, loop or
  auto-advance, and never a load group (small internal pieces: counted in `skipped.media`; the box's own
  entrance is a load group of kind `media`: the box element, a child covering >= 50% of the box, or the
  box's only visible content, a wrapper with no visible sibling on the way up to the box), so it never
  delays the settle time. Ambient items carry `hero` (the media box they lie over) and `heroIn` (inside its
  element) on static CSS animations too, so motion inside a media box is absorbed into that box whatever it
  holds. Not measured on
  `--fast` captures (there the motion inside media boxes is still left out of the ambient inventory).
- Each changed element gets a **kind**: nav (inside a header near the top), headline (h1/h2 or text >=
  28 px), text, cta (button, or a short block holding filled/outlined links), media, group (a block
  holding the h1 and more), other.

| field | meaning |
|---|---|
| `run`, `cold` / `warm` | which load this describes, and the other load's summary (above) |
| `dclMs`, `fcpMs`, `tracked`, `frames`, `frameMs`, `cssEventsDuringLoad`, `snapsIgnored`, `continuousIgnored` | sampling facts (ms since navigation start) |
| `groups[]` (<= 16) | as reveal groups, plus `kind`, `box` (final first-screen rect, members' union) and `appear` (how the load strip shows it arriving, `motion.frames` above; the strip wins over `ms` / `t0` when they disagree); `t0` = ms since navigation start: the group's earliest visible start. `t0How: 'animation start'` = from its CSS/WAAPI animation (`startTime + max(0, delay)`, used when within -1.5 s / +150 ms of the first sampled visible change, so frame drops during load do not move it), else `'sampled'` (first sampled change in which the element is visible: changes made while it is still fully transparent, such as a fill-backwards animation snapping to its from-state during its delay, are not its start) |
| `summary` | `{groups, firstStartMs, lastEndMs, ms (median), family, from (object, area-weighted modal from-state), staging, areaShare, textShare, staged}` or `null` |
| `skipped`, `media[]` | skip counts and hero media (above) |
| `summary.staging` | `{firstContentMs (first contentful paint), delayMs (first animation start - FCP), order[] (kinds in order of arrival; kinds starting within 60 ms share a step, joined by '+'), steps (distinct 60 ms start slots), totalMs (last end - first start)}` |

### motion.reveals
Before anything scrolls, the computed opacity, transform (translate/scale/rotate incl. individual
properties), clip-path (visible fraction), filter blur and visibility of every element that is not at
rest ("hidden-ish") is snapshotted (<= 2000 largest). The page is then wheel-scrolled in 0.75-viewport
steps; around each step a rAF sampler records those values for elements near the viewport until they
stop changing (0.45-1.8 s). An element is a reveal if it changed in 1-2 steps toward its rest state (a group whose duration comes out under 40 ms is a jump and is dropped);
3+ steps = scroll-linked; never-stopping = marquee; instant jumps are ignored, except a **step reveal**:
content switching from hidden to shown at once (opacity <= 0.2 to >= 0.8, visibility hidden to visible,
or clip <= 20% to whole, in one frame: a class toggle with no transition, content arriving at once; a
visibility-only toggle counts as a step whatever its sampled span). Step groups carry `appear: "step"`,
`ms: 0` and no easing. Not reveals: a toggle inside the **header bar** (the snapshot's nav, a nav /
banner landmark outside the footer, a top-level `<header>`; its scrolled state, counted in `header`) and a
change on a box under 64 px² when measured (a zero-size wrapper, counted in `tiny`). Not reveals either: a
change driven by an infinite animation (a loop), an opacity-only fade of a slide stacked on a same-tag
sibling of nearly the same box (IoU >= 0.8) when one of the two is hidden again after the scroll pass
(cross-fading slides show one at a time; stacked layers that all stay visible are a reveal; counted in `crossFades`), a fade of a
layer >= 1.5 viewports tall whose top is already > 0.25 viewport above the viewport (a page-tint or
background layer, counted in `layers`; tints are `motion.scrollTint`), the slides of a carousel the
slow watch found auto-advancing (`carousels.autoAdvance`), and a fade of a **small fixed / sticky box**
(the element or its nearest fixed/sticky ancestor <= 50% of the viewport wide, <= 30% tall, <= 10% of its
area: a back-to-top button, a floating chip; it never scrolls into view, so its fade-in is a scroll state;
counted in `fixedUi`). Not scroll-linked or a JS marquee: a text-free piece of a media / illustration box
(see `parallax`), counted in `mediaPieces`; its motion is that box's media activity. Reveals group by scroll
step, band and from-state (class names are not part of the key), so visual siblings in a row or grid
with per-item classes form one group and their stagger is measured per visual row.

| field | meaning |
|---|---|
| `summary` | `{groups, elements, from (object), ms, family, easing, stagger, trigger, sources[], stepGroups?, appear?}`: modal from-state, median duration and modal easing family / CSS easing of the eased groups (null when every group is a step: then `appear: "step"`), number of step groups, median stagger, median trigger position, sources |
| `groups[]` (<= 24) | one per (scroll step, band, element type, from-state): `{phase ('stepN' / 'load'), band, parent, el, n, from{opacity?, y?, x?, scale?, rotate?, clipVisible?, blur?, visibility?}, to?, prop (dominant: o/ty/tx/s/r/c/b), appear? ('step'), ms, sampledMs, settleMs, delay?, easing, family, nearest, sampledFamily, stagger, staggerHow, source, trigger, triggerHow, triggerSampled?, topBefore, afterScrollMs?, offscreen?, ys[], t0, area, nested?, strip?, inStrip?, skip?}` |
| `scrollLinked[]` | `{el, band, steps, from, to, endsAtRest}` elements whose visible state changed at 3+ steps (scrubbed animations) |
| `jsMarquees`, `otherChanges`, `groupsTotal`, `scrollLinkedTotal`, `crossFades?`, `layers?`, `fixedUi?`, `mediaPieces?`, `header?`, `tiny?` | JS marquees seen while scrolling, count of non-reveal changes, totals before caps, cross-fading slides, page-tall layer fades, small fixed / sticky box fades, media-box pieces, header-bar toggles and changes on boxes under 64 px² left out (above) |

Timing: `ms` is exact when the element had a CSS transition/animation or WAAPI animation at its
first change (`source` css-transition / css-animation / waapi, with `delay` and `easing` from it);
otherwise `ms` is fitted from the sampled progress curve against reference cubic-beziers with the
duration as a free parameter (`source: 'js (frame-sampled)'`). `sampledMs` is always the fitted value
(null if the motion was already running when sampling began), `settleMs` the raw time until within
1% of the end. `family`: ease-out / ease-in / ease-in-out / linear / spring-like (overshoot > 3%) /
steps; `nearest`: closest named curve. `stagger`: from distinct CSS delays when available, else the
median gap between start times within each visual row (>= 20 ms). `trigger`: element top / viewport
height when its change began (median of the members). `topBefore`: the same before the step's scroll.
`triggerHow`: `crossed` = the change began while the step was still scrolling (the top is the line it
crossed); `rest` = its earliest member began `afterScrollMs` (>= 120 ms, less its own CSS delay) after the scroll stopped (load-driven fades,
delays): the top is where the element rested and the line was crossed between `topBefore` and there.
`offscreen: true` = began after the scroll stopped with the top below the viewport (never seen
animating). `ys` = document px of the members' tops (<= 8). `strip` / `inStrip` (`in place` /
`animates`) = the reveal strip that replays this group's step and its `content.inPlace` (strips of a
`--frames-like` capture replay the reference's step, not this page's, and link no groups). `skip` = a
`rest` group (>= 5% of the viewport, not offscreen) whose strip shows it in place: a load-driven fade,
not a reveal a viewer sees; or a step group whose strip shows nothing arriving; left out of `summary`
and `groupsTotal`. `triggerHow: "strip"` = a `rest` group whose strip shows content arriving after the
scroll stopped: it fired resting at (median `ys` - the strip's end scroll) / viewport height, lower in the
viewport than the pass's rest, so that is the tighter bound and `trigger`; `triggerSampled` = the pass's value.

### motion.ambient
One inventory of continuous decorative motion from every source: idle-sampled marquees and loops,
infinite running CSS/WAAPI animations that change a visible property on a visible element (not
scroll-driven), playing videos (>= 80x60), auto-advancing carousels and JS marquees. Items are
de-duplicated per band and animation name pattern (names differing only by digits are one pattern).

| field | meaning |
|---|---|
| `count` | number of items |
| `kinds{kind: n}` | marquee / move / rotate / pulse / shimmer / colour / loop / video / auto-advance / media |
| `bands[]`, `bandShare` | band ids with any continuous motion; share of content bands (not nav/ad) that have some |
| `items[]` (<= 16) | `{kind, band, el, src, n?, name?, media?, box?, activity?, keyframes?, periodMs?}`; `src`: `css` (CSS motion seen in the idle sample), `animation` (infinite CSS animation), `transition`, `waapi`, `js` (script-driven), `video`, or `frames` (kind `media`: hero media seen moving by frame differencing, e.g. a canvas/WebGL scene, a Lottie or an illustration of keyframe-animated pieces, with `media` = its kind, `box`, `activity`, `keyframes` = moving pieces inside it). Motion inside a hero media box is not listed separately (it is that box's activity). `periodMs` on `auto-advance` items = the slow watch's step interval. Amplitude and period of loops are not in the inventory: read them from `motion.loops[]`, `cssAnimations[]` + `keyframes{}` (duration = period) and the frames |

## Exact shapes of the newer fields (for spec writers and tools)
- `spacing.container[vp].contentWidth` = **rail width** (`railRight - railLeft`) when the page has rails
  (`contentHow: "rail"`); only on a page without rails is it the text width (`textRight - textLeft`,
  `contentHow: "text (no rails)"`). `contentLeft`/`contentRight` are the same edges. The text inset is
  always `textLeft`/`textRight`.
- `sections[].bg.scrollTheme` = `{ "rest": "#rrggbb", "centred": "#rrggbb", "restFrom": "entering"|"full shot" }`, present only when the band's
  settled colour with the band centred differs from the same rows of the scroll-0 full shot (`restFrom: full shot`), or, when the full shot already draws the band in its centred colour while the band's top rows read as it comes into view (a viewport shot with its top edge 85% down the viewport) differ from the same rows of the full shot, from that entering read (`restFrom: entering`: the full-page capture rendered the band in its in-view state). The centred and entering reads take the background only: pixels outside media, background images and moving tracks (a marquee of coloured images is content passing through, not a tint), a band shorter than the viewport over its own rows only (OKLab > 0.02, a subtle page tint counts; the centred colour covers < 15% of the rest read, so a near-tie between two colours does not count;
  each colour >= 30% of those rows, `bg.type` color or gradient). Then `bg.sampled` = `centred`; for a solid
  band also `bg.color` = `centred` and `bg.cssColor` = the CSS value. When the scroll-tint timing found the
  change: `+ { triggerAt, bandTop, ms, scrub?, rangePx? }` (as `motion.scrollTint.colors[]`). Only the 1440
  bands are read centred: the 768 / 390 bands carry the scroll-0 (rest) colour.
- `motion.load.media` = array (empty or absent when no media box covers >= 3% of the first viewport; absent
  on `--fast`) of `{ kind: "video"|"canvas"|"iframe"|"img"|"svg"|"lottie"|"bg-image"|"art"|"panel", el, box: [x, y, w, h]
  (first-viewport px at scroll 0), band (band id or null), activity: "static"|"low"|"medium"|"high"|null
  (= rateLevel(rate)), intermittent? (true), rate (0-1 or null: share of the box changing per second,
  continuous whenever sampled), rateLoad, rateCont (0-1 or null), motion: "in-place"|"lateral"|"cut"|"drift"|null,
  axis? ("x"|"y"), dir? ("left"|"right"|"up"|"down"), pxPerSec?, appearsMs? (ms or null), withLoad? (bool),
  hot ([x, y, w, h] or null), diff (0-1, the larger of load and continuous), shifted? (frame pairs
  compensated for a page shift), moving (bool), when: "load"|"continuous"|"both"|null, load (0-1 or null),
  continuous (0-1 or null), active (0-1, share of consecutive frame pairs of the phase `rate` comes from
  that changed), playing? (bool, video only), pieces? (art / panel), stack? (panel), keyframes? (moving
  pieces absorbed) }`.
- `motion.ambient` is an object `{count, kinds{}, bands[], bandShare, items[]}`; `activity` exists only on
  `motion.ambient.items[]` of kind `"media"`: `{ kind: "media", band, el, src: "frames", media (one of the
  hero media kinds above), box: [x, y, w, h], activity: "low"|"medium"|"high", intermittent?, rate?, motion? }`
  (still media never become ambient items, so `"static"` does not occur there).

## inspect.mjs fontmatch output
`node inspect.mjs fontmatch <refCapDir> --role <role> [--candidates "A,B"] [--top 5]` reads
`type.samples[role]` and prints `{ cmd, role, ref: {text, px, weight, ls, style, family, class},
catalogue, referenceFonts, sampleQuality, candidates: [...], composite, rendered, families, groups, notes? }`.
- `referenceFonts` = the reference's own families (`type.families`) with `inCatalogue` (as in
  `type.families[]`), `catalogueAs?`, `thisRole?` and `use` (may be used / never use / unverified);
  `catalogue` = the list checked (`bundled (offline)` adds a note). Every candidate is a public-catalogue
  family: a `--candidates` name outside it is dropped with a note (`candidate "X" dropped: ...`); with no
  catalogue family left the command fails.
- `sampleQuality` `{level: "good"|"poor", reason}`: can the crop be trusted? Measured on the crop itself (so
  it also works on captures without `type.samples[].sampleQuality`): **busy background** (the 2 px frame
  around the line is not one colour: left/right edges, or top/bottom edges in another hue), **other text
  reaches into the crop** (text-coloured pixels in > 20% of the top/bottom edges only: a tight multi-line
  heading; less is listed in the good reason),
  **two colours in the line** (> 12% of the strong ink off the background -> text colour line, or > 15% of
  the ink in glyph runs peaking below 0.72 of the line's peak), **low contrast** (text colour < 1.8:1, or
  < 1.3:1 as drawn), **too few glyphs** (< 4), **no text ink in the crop** (or no contrast: then no
  candidates, never an error); plus the capture's own reasons (its "busy background" only when the frame
  agrees). `summary.md` prints this same verdict for the same crop (`sampleVerdict`, one rule). `poor` also
  adds a note: take width / tracking from a role of the same family with a good sample.
- Ink is **contrast-normalised**: crop and candidates are projected on their background -> text colour line
  and divided by their own ink peak (98th percentile), so text drawn dimmer than its declared colour
  (opacity, muted colours) measures like full-contrast text; candidates are drawn in the crop's colours.
- A width variant is linked with the family's axis ranges (also single-weight faces with a `wdth` axis) and
  drawn with `font-stretch` plus `font-variation-settings`; a variant that draws as wide as the default
  width is dropped (note), so a reported `axes.wdth` is always the width that was drawn and scored.

Per candidate:
- `weight`: the candidate's **absolute** CSS font-weight (e.g. 650 on a variable face), not a change from the
  reference weight. `weightBasis` "role ink" (the capture measured the role's `ink`): the weight whose probe
  ink, drawn like the capture's ink probe at `apply.fontSize` and `apply.letterSpacingEm`, equals the role's
  ink (what compare scores; `ink` `{ref, candidate, beyond?}`, `cropWeight` = the crop's best fit); "crop":
  the crop's best fit (older captures).
- `opsz` (families with an optical-size axis where the automatic cut differs from the default instance at
  the sample's px): "auto" = the optical-size cut matched (request the opsz range), "default" = the default
  (text) instance matched (request no opsz).
- `lsAdjustEm`: a **delta** in em to add to the reference letter-spacing `ref.ls` (clamped to +-0.2 em);
  `apply.letterSpacingEm` = the absolute value to set (`ref.ls + lsAdjustEm`).
- `sizeAdjust`: a **multiplicative factor** on the reference px (0.7-1.4) that makes the candidate's glyph
  body (cap/x-height) match the crop; `apply.fontSize` = the absolute px to use (`ref.px x sizeAdjust`).
  The type scale normally keeps the measured px; the factor says how much larger or smaller the face draws.
- `axes` (when the match used them, e.g. `{"wdth": 75}`), `italic`, `score` (0-1), `parts` {adv, ink, xHeight,
  contrast, shape}, `class` {kind (serif/sans/flared/...), style, contrast, width, category}.
The composite PNG (`<refCapDir>/fontmatch-<role>.png`) shows the reference crop above each candidate drawn at
its `weight`, `apply.fontSize` and `apply.letterSpacingEm` (with its axes); labels give the absolute
font-size and letter-spacing with the factor / adjustment in brackets; a poor sample is labelled with its
reason.

## Reliability
Reliable: band order, heights, backgrounds, paddings, card columns per viewport; colour roles and
theme; rendered families, rendered weights, role `ink` and type roles on sites with real heading tags;
load staging that repeats on the warm load (`frames.load.visual.designed`);
content column; radii; CSS transitions and hover deltas; CSS-driven reveal and load from-state,
duration, easing and stagger; load order; sticky and parallax rates on native-scroll pages; marquee
speed; smooth-scroll library detection; the header's scrolled state.
Weaker: role guesses (heuristic, `why` says which rule fired; only the coarse class is scored); bands
of multi-column feeds (one tall band, noted); JS-driven reveal duration/easing (fitted); reveal trigger
position (step-limited); auto-advancing carousels; accent colour on monochrome sites; type roles on
sites without heading tags; ambient motion inside canvas/WebGL/Lottie below the first viewport (hero
media is frame-differenced, the rest only through videos and DOM animations); what moves inside
canvas/WebGL/video (only its activity level is measured: `bg.type`, screenshots and frames show it);
popups that need wording outside the detection list or open only after a delay longer than the settle.

# restyle — spec

## Goal
A Claude skill, `restyle`. Input: a reference website URL and the user's own content
(business name, copy, images, page list). Output: a new static website that carries the
reference's design language (layout, colour, type, spacing, motion) with the user's content.

## Non-goals
- Cloning a site. Never reuse the reference's logo, brand name, copy, photos, icons-as-brand
  or licensed font files. Substitute the closest free font (a family in the public Google Fonts
  catalogue, or a system stack; css2 also serves proprietary brand faces, so its status is no test).
  compare's `health` check fails a build that loads a non-catalogue web font (never a pass).
- Backend, CMS, forms that submit anywhere, e-commerce logic.
- Reproducing custom WebGL/canvas/video hero art. Approximate with CSS/SVG/GSAP and record
  it as a known gap in the build report.

## Stack
- Node 26, ESM (`.mjs`), no TypeScript, no bundler.
- `playwright-core` driving the installed Chrome (`channel: 'chrome'`). No browser download.
- `pngjs` + `pixelmatch` for image maths. `culori` for colour maths (OKLab, deltaE).
- Generated sites: plain `index.html` + `styles.css` + `main.js`, GSAP + ScrollTrigger from
  cdnjs only when the spec has scroll/timeline motion; CSS transitions otherwise.

## Architecture
```
skill/restyle/            the product; copied to ~/.claude/skills/restyle at the end
  SKILL.md                workflow the model follows
  scripts/capture.mjs     URL -> capture dir (capture.json restyle-capture/2 + screenshots + motion frames)
  scripts/compare.mjs     ref capture + build capture -> diff.json (restyle-diff/2, per-area 0-10 + findings)
  scripts/sheet.mjs       side-by-side ref/build sheets, <= 10 (builder self-review and blind judge use the
                          same); --ref-only: reference contact sheets for studying the reference
  scripts/inspect.mjs     measuring tools: color, crop, overflow, style, bands, get (one capture.json
                          value by dot path, big values cut with a note), activity (first-screen
                          media activity in ~10 s), fontmatch (visual font
                          matching of a reference type sample against Google Fonts candidates; weight
                          matched to the role's ink, the measure compare scores; opsz auto | default)
  scripts/type-scale.mjs  design-spec.json -> type-scale CSS, exact at 390/768/1440
  scripts/serve.mjs       tiny static server for a build dir (a given busy port exits 1, never another
                          port; no port = a free one, printed); --stop <port> stops it via a pid record
                          in the OS temp dir (Windows-safe; exit 1 when nothing was stopped)
  references/*.md         capture schema, spec schema, build rules, motion patterns, font
                          substitutes, visual review (review.md), scoring
harness/                  test rig; not part of the shipped skill
  sites.json              the 23 sites, pilot/holdout flags, fictional content brief each
  pipeline.mjs            ref capture (or --from-build: the builder's snapshot) / eval (builder's snapshot
                          as reference, serve build, capture --frames-like, compare, sheets) per site
  score.mjs               combines diff.json (50%) and judge.json (50%) into score.json
  judge-prompt.md         the blind judge's rubric and output format
  report.mjs              round summary table -> runs/<round>/REPORT.md
  check-capture.mjs, check-compare.mjs   fixture assertions for capture and compare
runs/<round>/<slug>/      ref/ (capture), build/ (site, with .restyle/ spec and work files),
                          buildcap/ (capture of build), sheets/, diff.json, judge.json, score.json
```

## Capture (`capture.mjs <url> <outDir> [--viewports 1440,768,390] [--no-motion-frames] [--fast] [--frames-like <refCapDir>] [--timeout 60000]`)
Works identically on a remote URL and on `http://localhost:<port>` (the build). Field-by-field
contract: `skill/restyle/references/capture-schema.md`. `--fast` = 1440 only, no motion frames,
no hover, no warm reload (inner iterations; compare marks the diff `partial`). `--frames-like` records
the reveal strips at the reference's page positions (build captures). Writes `summary.md`, a <= 250-line
digest of capture.json for a model to read first. Prints short progress lines on stderr while it runs
(stdout stays one JSON line), and writes `done.json` last, which `capture.mjs --wait <outDir>` waits for.
The first thing a capture does is delete `done.json` and write `started.json` {pid, startedAt}; `--wait`
waits 4 s before its first look and only takes a `done.json` with the latest `startedAt`, so an older
run's result is never returned. At its timeout `--wait` exits 3 while that capture's pid is still alive
(re-issue the same `--wait`), else 1.
Per viewport (1440x900, 768x1024, 390x844):
- `shots/<vp>-full.png` (full page, after a slow scroll to trigger lazy content and reveals,
  then back to top, showing every band as it looks in view: `content-visibility` forced visible,
  scroll-driven animations paused at their in-view state, rows the DOM says are painted but the shot
  shows blank re-shot in view and filled in; the scroll-0 state kept as `<vp>-full-rest.png` for scroll
  tints; text still blank is a loud warning), `shots/<vp>-fold.png` (first viewport), `shots/<vp>-scrolled.png` (1.5
  screens down: the header's scrolled state), `shots/<vp>-sec-<n>.png` per section.
- Before anything is measured, dismiss cookie/consent overlays by choosing reject/decline where a
  button is found, and any other popup shown without user action (dialogs, backdrops, drawers, fixed
  bars about cookies/privacy/region/newsletters, and a region/language bar across the top of the page,
  fixed or in flow, that pushes the page down) through its close control; hide what has none. Removed
  popups and cookie-blocked embed placeholders are excluded everywhere and listed in `meta.overlays`.
- An app-shell page (the document is one screen tall and the content scrolls inside an inner box) is
  unrolled into the document right after consent on every page the capture opens, so it is measured like
  an ordinary page (`meta.innerScroller`).
`capture.json`:
- `meta`: url, title, time, detected libraries (gsap, ScrollTrigger, lenis, framer-motion,
  three, swiper, lottie, barba, locomotive-scroll), page height per viewport.
- `colors`: palette weighted by painted area (background, text, border, accent/CTA roles),
  gradients (raw CSS), dark/light theme flag, CSS custom properties from `:root`. Logo / brand marks
  (header/footer home-link marks, logo-named elements, partner-logo strips) never feed accent or
  minor colours.
- `type`: font families in use with weights and measured width / x-height; per role (display,
  h1, h2, h3, body, small, nav, button, eyebrow) the size, rendered weight, line-height,
  letter-spacing, transform and `ink` (how dark the role's exact font renders) — per viewport.
  Roles come from size and use, never tags or landmarks: body = running text by character count
  (any tag), leaving out UI mock-up and small-print text, so the same design measures the same in
  any markup; intro paragraphs are recorded as `body.lead`.
- `spacing`: container max-width and gutters, section vertical paddings, common gaps,
  border radii, shadows (most frequent values).
- `sections[]`: order, tag/role guess (nav, hero, logos, features, stats, testimonial,
  pricing, cta, footer, gallery, article-list, other), bbox, background, columns/grid
  shape (with the main row's share of the band; a collage of uneven media pieces is one media
  object, never columns or cards), child counts, heading/body/CTA/media presence, alignment.
  compare scores hero/footer position by place first (first/last content band), not landmark tags.
- `components`: computed-style samples for nav, primary/secondary button, card, input,
  link (the same link kind on every page: inline > text > block > control), badge — including
  hover deltas (properties that change on hover + transition).
- `motion`: CSS transitions (property, duration, easing, how many elements), `@keyframes`
  in use (name, steps, duration, iteration), `document.getAnimations()` snapshot,
  scroll reveals (elements whose opacity/transform changed between pre-scroll and in-view,
  with the from-state, duration and stagger estimated from frame sampling; the trigger is the members'
  top when the change began, marked `crossed` (while scrolling: the observer line) or `rest` (began
  after the scroll stopped: where the element rested, e.g. a fade when a lazy image arrives); a `rest`
  group its reveal strip shows already in place is marked `skip` and not counted), sticky/pinned
  elements, parallax (elements moving at a different rate than scroll), smooth scroll,
  marquee/auto-carousel detection (an 8 s watch without input finds slow auto-advance and its period;
  marquees also from a short idle sample at 768 and 390),
  cursor effects, ambient motion inventory, header scrolled state (pinned when the bar is still at the
  top of the scrolled screenshot, whatever its computed position; a line or shadow under it that only the
  scrolled shot shows, or a scroll-driven animation on it, is its scrolled state). Load group start times are the
  animations' real starts (start time + delay) where the browser exposes them. Moving art inside a media
  or composite-illustration box (video, canvas, Lottie, CSS keyframes on several small pieces) is that
  box's media activity, never a marquee/loop/auto-advance; cross-fading slides are not scroll reveals; a
  layout shift (ads, embeds) is not parallax. Scroll tints record where they trigger (band position in the
  viewport) and how long the change takes, and the tinted band's colour before it is scrolled to (full
  shot), while entering and when centred (`flash on entry` vs `changed while in view`); a tint is a timed
  transition unless measured as scroll-scrubbed. Load staging comes from a warm-cache reload of the page, so network delays do not read
  as a designed blank hold or stepwise build-up; fade-outs, tiny elements, digit rolls, off-viewport
  and third-party motion are skipped, and a load counts as staged only when >= 15% of the first
  viewport's content animates in. Hero media (any kind, an HTML UI mock-up or card stack included) is
  frame-differenced inside its box by one measure shared with `inspect.mjs activity` and reported with
  `rate`, the share of the box that changes per second on the settled page (page-wide layout shifts
  compensated), the activity level read from that rate alone (intermittent when it moves in bursts), how
  it moves (in-place, lateral, cut, drift) and whether it arrives with the load staging; a stand-in's
  internal layers, tracks and cycling states count only as that activity (never a marquee, auto-advance,
  load group, scroll-linked, parallax or colour gradient). The 8 s watch also finds state changes that
  move nothing (a word swap, step chips, a ticking feed). The load settle time leaves out media and repeating motion and says what
  keeps moving after the content settled, the same way on any page. Band colours are read with each band centred
  and settled, which also exposes scroll-driven page tints.
- `motion/frames/`: JPEG sequences at 12 fps of the page load (warm reload, 5 s from the frame that
  shows first contentful paint, with the time the first screen settled; a lead-in where only hero media
  is still arriving, with no load animation, is marked and not shown on the sheets) and of up to 4 scroll
  reveals (1.5 s from the wheel input, with the measured scroll timing and when the content in view is in
  place after the scroll stops), the settled first screen's media
  (2.5 s, for zoomed crops), plus hover before/after PNG pairs (with what they visibly do: lightens,
  darkens, recolours or moves, none). For the load strip, each load group and each reveal strip the frames
  say how content arrives: in one step (complete within one or two frames: build it with no transition)
  or as a fade / slide with the visible duration; where a sampled duration or trigger disagrees, the
  strip wins. `shots/type-<role>.png`: the first
  rendered line of each type role (`type.samples`, chosen on a plain background with the highest
  text/background contrast, the hero first for display, re-checked on the screenshot's pixels, with a
  `sampleQuality` verdict).

## Design spec (`design-spec.json`)
The contract between analysis and build (`restyle-spec/1`). Written by the model from
`capture.json` plus its own reading of the screenshots. Schema lives in
`skill/restyle/references/spec-schema.md`. Sections: `tokens` (colour, fonts, type scale,
spacing, radius, shadow, motion), `direction` (art direction, signature traits), `components`,
`bands[]` (one per reference band with a per-viewport responsive checklist), `copyFit[]`,
`motionCore` (load, nav scroll, ambient), `motion[]`, `responsive`, `substitutions`,
`invented`, `judged`. The type scale CSS is generated from it by `type-scale.mjs`.

## Scoring
Score out of 10 per site = 0.5 × metric + 0.5 × judge. Area weights:
layout/structure 25, colour/theme 20, typography 20, motion 20, responsive/polish 15.
- Metric (`compare.mjs`): per area a 0–10 from measured gaps — section sequence alignment
  and bbox proportions; palette deltaE (OKLab) weighted by area and role; type-scale
  ratios, ink (rendered weight only where ink is missing), rendered line boxes, tracking by the line width
  it sets, font category; logo colours never required; motion inventory match (pattern types,
  durations, easings, reveal count, reveal strip timing (content in place after the scroll stops, build vs
  reference; a build that eases in where the reference's load or reveal strip steps), staged load, first-screen media activity (level and share of the box
  changing per second, continuous vs continuous; kind of motion), auto-advance period, scroll tint
  colours and timing, sticky/parallax presence; transitions only on properties that visibly change on
  the elements that carry them in a hover, reveal or state change); the same checks at 768 and
  390 plus no horizontal overflow, no content clipped at the viewport edge, and no console errors.
  Text content, images and brand marks are excluded from comparison by design. Formulas:
  `skill/restyle/references/scoring.md`.
- Builder self-review: in the verify loop (up to 6 build captures, `--fast` for inner
  iterations) the model reviews the same sheets the judge sees, blind, before reading compare
  (`skill/restyle/references/review.md`).
- Judge: a separate reviewer pass that sees only side-by-side sheets and frame strips, never the skill,
  the spec or the build code. Scores each area 0–10 with one-line reasons and the top 3
  visible mismatches. It is told the content differs on purpose.
- Pass: every site ≥ 8.5 (lowered from 9.0 on 2026-11-15), or documented as an exception with the technical reason
  (custom WebGL, video-driven hero, bot wall). Exceptions are reported, never rounded up.

## Improvement loop
After each round: aggregate lowest areas and judge mismatches across sites → trace each to
a gap in `skill/restyle/` (capture misses it, schema cannot express it, build rule absent or
vague) → fix the skill, never hand-patch a build → rebuild affected sites → rescore.
Each round's change list is logged in `runs/<round>/CHANGES.md`.

## Definition of done
All 20 sites ≥ 8.5 or listed exceptions; 3 holdout sites (never used in tuning) reported;
skill installed to `~/.claude/skills/restyle`; `docs/USAGE.md` written.

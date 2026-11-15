---
name: restyle
description: Builds a new static website (index.html + styles.css + main.js) for the user's own business that carries the design language of a reference website - band structure and rhythm, colour and theme, typography, spacing, component styling, hover states, load and scroll motion, responsive behaviour - measured from the live reference with a headless-Chrome capture, then verified by capturing the build, reviewing side-by-side sheets as a strict designer and scoring it against the reference. Use when the user gives a reference site URL and wants a site "like it", "in that style", "inspired by", "matching", "with the look and feel of" or "restyled after" that site, filled with their own business name, copy, sections and images. Never copies the reference's logo, brand name, copy, imagery, illustrations, characters or font files.
---

# restyle

Turn a reference website plus the user's content into an original static site that a strict senior
designer, comparing the two side by side, would call "same design system and art direction, different
company", and that scores 9+/10 per area (layout, colour, typography, motion, responsive) when its
capture is compared with the reference's. Fidelity is about **treatment**, never **subject**: the
user's words, brand and imagery subjects are supposed to differ.

## How to work (context is the scarce resource)
- **Only this file is read in full.** Every file in `references/` opens with a header saying when you
  need it and what each section holds. Read one section when a step names it ("build-rules
  §skeleton"), not the whole file. `Grep "^## §"` on the file lists the sections with line numbers;
  read from that line to the next `## §`.
- **Never read script source**, and never print `capture.json` or `diff.json` whole. The digest
  `summary.md` names the capture.json path behind every line: read one with `inspect.mjs get <dir>
  <path>`. Compare prints a readable table on stderr: read that, not `diff.json`.
- **Images are the expensive input** (a sheet costs 1.5-3K tokens): view each sheet once per review,
  writing notes as you look; open crops or frames only to settle a named question. Never re-open a
  sheet, section or file unchanged since you noted it; only a full review (§7.4) views every sheet again.
- **Writing files:** Write and Edit for hand-written parts (several Edits to one file are fine); a
  generator in `<out>/.restyle/` for repeated items and whole-file regeneration; never shell
  one-liners, never search-and-replace over text you have not read (build-rules §files).

**Cost.** A build takes about 350-450K tokens in all (round-3 builds: about 400K), more than half in
the verify loop. Rough shares of the cheapest sound sequence:
| step | read or view | about |
|---|---|---|
| 1-3 intake, reference | this file, `summary.md`, each reference sheet once, spec-schema §rules | 40K |
| 4-5 fonts, spec | font-substitutes §procedure, one fontmatch image per role, the spec-schema section you are filling, capture.json paths the digest names | 50K |
| 6 build | build-rules §files and §skeleton, then the section for the band at hand; motion-patterns §rules and the recipes `motionCore` names; your writing | 100K |
| 7 verify, per capture | full review (≤ 10 sheets + compare table) about 40K; delta review (changed sheets + fold) about 15K | 150-250K for 4-6 |
Cheaper without losing fidelity: several fixes per capture; delta reviews between the full ones
(review §delta); `--fast` only after 1440 layout, colour or type fixes (it records no motion, hover,
768 or 390, so it cannot confirm fixes there). Stop studying when the spec checkpoint (step 5)
passes; what is still unclear is settled by the first build capture, not by more reading.

## Paths, tools and conventions
- `<skill>` = the absolute path of the folder that contains this SKILL.md. Resolve it first.
- `<out>` = the site folder (default `./<business-slug>-site`). Work files live in `<out>/.restyle/`.
  Never create or edit files inside `<skill>`; helper scripts you write (repeated feed items, art
  generators) go in `<out>/.restyle/`.
- Commands use forward slashes and work in bash, zsh and PowerShell. Quote paths with spaces. Every
  script prints one JSON line on success and exits non-zero with a message on failure.

| command (all in `<skill>/scripts/`) | does |
|---|---|
| `capture.mjs <url> <dir> [--fast] [--frames-like <refDir>] [--timeout 90000]` / `capture.mjs --wait <dir> [--timeout-s 600]` | measures a page: `capture.json`, `summary.md` (digest), `shots/`, `motion/frames/`. `--fast` = 1440 only, no frames, hover or warm reload (about 30 s instead of 1-2 min). `--frames-like <refDir>` records the reveal strips at the reference's page positions: use it on every full build capture. `--wait` blocks until the latest run in `<dir>` ends (exit 0 = ok, 1 = failed; 3 = still running at the timeout). If it or the tool call times out, run the same `--wait` again: it returns the latest run's `done.json` |
| `sheet.mjs --ref-only <refDir> <outDir>` | about 8 reference-only contact sheets + `sheets.json` (what each sheet shows) |
| `sheet.mjs <refDir> <buildDir> <outDir>` | at most 10 side-by-side sheets (A = reference, left or top; B = build) + `sheets.json` |
| `compare.mjs <refDir> <buildDir> <out.json>` | `total`, five area scores, findings `{area, severity, what, ref, build, fix, lost}`; a fast build gives `partial: true`, `responsive: null` |
| `inspect.mjs fontmatch <refDir> --role <role> [--candidates "A,B"] [--top 5] [--brief]` | ranks free faces against the reference's rendered sample of a role (`display`, `h1`, `h2`, `h3`, `body`, `nav`, `button`); `sampleQuality` (`poor` = do not trust the crop for weight, width or tracking); per candidate `weight` (absolute), `sizeAdjust` (factor), `apply{fontSize, letterSpacingEm}` (absolute), `class`, `score`, `trackingClamped`/`sizeClamped` (fit unreliable); writes `<refDir>/fontmatch-<role>.png`; `--brief`: table on stderr, short JSON |
| `inspect.mjs activity <url> [--box x,y,w,h]` | first-screen media activity in ~10 s, measured as capture does: per box `activity`, `rate` (share of the box changing per second); use it between full captures while tuning a moving stand-in |
| `type-scale.mjs <design-spec.json> --out <file.css>` | type scale as CSS variables and `.t-<role>` classes, exact at 390/768/1440 |
| `inspect.mjs color <img> <x> <y> [w h]` / `crop <img> <x> <y> <w> <h> <out.png>` | exact colour of a pixel or box; crop a screenshot |
| `inspect.mjs overflow <url> [width]` / `style <url> <selector> [<selector> ...] [width]` / `bands <url> [width]` / `get <dir> <path> [--depth N]` | elements wider than the viewport and content clipped at its edge; computed style (several selectors share one page load); band geometry with `contentX` and `headPx`; one capture.json value by dot path (`type.roles.1440.body`, `sections.3.pad`), big values cut with a note |
| `serve.mjs <dir> [port]` / `serve.mjs --stop <port>` | static server for the build. Start it with no port (it picks a free one) and use the URL it prints; a given port that is busy exits 1. `--stop` stops the server started on that port (Windows too); exit 1 = nothing stopped |

## 1. Intake
Collect, from what the user already said: the reference URL (a sub-page URL means that page); the
business (name, what it does, audience, tone, location); content (copy per section, nav labels, calls
to action, contact details, real testimonials or figures); pages wanted (default: one page,
`index.html`, following the reference's band sequence); assets (logo, photos, video, brand colour,
mascot; all optional); the output folder.
- Ask at most one batch of questions, and only for blockers (no reference URL; no idea what the
  business is). Everything else has a default.
- Mapping the user's content onto the reference's bands (slot lengths, fewer items, invented copy and
  placeholders, dropdowns, links, CTAs without a slot, leftover content): spec-schema §content.
- A user brand colour replaces the reference accent only if they ask; tell them colour fidelity drops.

## 2. Setup (first run on a machine)
- Needs Node 20+ and Google Chrome (driven through playwright-core; no browser is ever downloaded; if
  Chrome is missing, ask the user to install it). From inside `<skill>/scripts`, check the deps with
  `node -e "Promise.all(['playwright-core','pngjs','pixelmatch','culori'].map(m=>import(m))).then(()=>console.log('deps ok'))"`;
  if that fails, run `npm install` there once and check again.

## 3. Capture and study the reference
Run `node <skill>/scripts/capture.mjs <url> <out>/.restyle/ref` in the background (1-2 minutes, hard
limit 8), read spec-schema §rules meanwhile, then wait: `capture.mjs --wait <out>/.restyle/ref` (§7).
- Failure (non-zero exit): retry once with `--timeout 90000`, then report the error.
- `"blocked":true`: a bot wall was measured, not the site. Stop, quote `meta.blocked.reasons`, and
  offer another URL of the same site or working from full-page screenshots at about 1440, 768 and
  390 px that the user supplies (every value is then judged: say so in the spec and the report; the
  verify loop is visual only). Never invent measurements.

Then, in this order:
1. Read `<out>/.restyle/ref/summary.md` (bands per viewport, colours, type, spacing, components,
   hover, motion, notes; at most 250 lines). Open `capture.json` only at a path the digest names.
2. Run `node <skill>/scripts/sheet.mjs --ref-only <out>/.restyle/ref <out>/.restyle/refsheets` and look
   at every sheet in `sheets.json` order. Open a single shot, a type crop (`shots/type-<role>.png`)
   or a frame only to answer a specific question.
3. Write notes as you look; they become the spec: the load timeline (blank hold, first visible
   content, order, time at rest); the nav at rest (from `ref-fold.png`: the band and full sheets may
   show it scrolled) and scrolled (`ref-scrolled.png`); everything that moves (hero video or canvas,
   drifting objects, loops, bands that change colour on scroll, how active and how fast each is);
   per band, what changes at 768 (its own layout, not a scaled desktop) and at 390, starting with the
   element set (spec-schema §resp); the signature traits; small chromatic colours; the art's medium
   and tone (not its subjects); widget density (rows, labels, chips you can count).
- Popups, region or language modals, cookie and privacy bars, chat launchers, loading placeholders,
  ads and embeds (and the layout shifts they cause) are not design: never note, reproduce or stage them.
- Numbers come from the capture, judgment from the images. When they disagree the capture wins
  unless its field is weak (the "Weaker" list in capture-schema `## Reliability` (Grep it),
  the digest's notes, a line marked WEAK or POOR: check it on the shots or with `inspect.mjs`
  first); then the image wins (record why in `judged[]`). BLANK: read that band from the frames.

## 4. Choose the fonts
Run `node <skill>/scripts/inspect.mjs fontmatch <out>/.restyle/ref --role <role>` for `display`, `h1`, `h2`,
`body` and any other role in a family those four lack, look at `fontmatch-<role>.png`, choose by character
(class, contrast, width, roundness), apply its `weight`, `apply.letterSpacingEm`, `sizeAdjust` and `opsz`
(font-substitutes §procedure). A `poor` sample sets no tracking or size factor; its weight stands only when
`weightBasis` is "role ink". Use a reference face only if `referenceFonts` says it is in the catalogue.

## 5. Write the design spec (before any HTML)
Write `<out>/.restyle/design-spec.json`; every § below is a spec-schema section, read when you fill it:
- `tokens` verbatim from the capture (§rules, §color, §fonts, §type, §space); judged values in `judged[]`.
- `direction`: art direction, medium, density, 3-6 signature traits with `where` and `how` (§direction).
- `components` (§components); `bands[]`, one per reference band with its `resp` checklist at 768 and
  390 (§bands, §resp); content mapped per §content and fitted per §copyfit.
- `motionCore` (load, navScroll, ambient, heroMedia; §motioncore), `motion[]` (§motion),
  `responsive`, `substitutions[]`, `invented[]` (§misc).

Checkpoint: band count equals the reference's (minus `ref.dropped`, each with a reason); the dark/light
sequence and every scroll-theme band match; every band has content and every `resp` key at 768 and
390; the four `motionCore` entries cite evidence; every signature trait has `where` and `how`; every
media slot names a subject from the user's business; every motion entry cites a capture path or
frames. Then stop reading and build.

## 6. Build
Write `<out>/index.html`, `<out>/styles.css`, `<out>/main.js` and `<out>/assets/`:
- Start with build-rules §files and §skeleton (first-paint colours, font preload and fallback, image
  sizing, the type-scale link). Generate the type scale with
  `node <skill>/scripts/type-scale.mjs <out>/.restyle/design-spec.json --out <out>/type-scale.css`
  and link it as its own stylesheet; fix every warning it prints in the spec, never in the CSS.
- Tokens become custom properties verbatim (build-rules §tokens). Rebuild band by band in spec order
  (build-rules §bands): background, paddings, columns, cards, alignment, media, dividers, signature
  traits; widgets become stand-ins at the reference's density (build-rules §widgets).
- **Originality** (build-rules §imagery): stand-in art follows the reference's medium, palette,
  line and fill, scale, placement and density; subjects and compositions come from the user's business.
- Motion: motion-patterns §rules, then `motionCore` (§load, §media, §nav, §ambient), then `motion[]`;
  nothing the reference lacks; a video it shows paused with a play button is a still with that button.
- Responsive: every `resp` entry at 768 and 390 (build-rules §responsive).
- Run build-rules §checklist before the first capture.

## 7. Verify loop
Chaining: `type-scale ... && capture ...` and a foreground `capture ... && sheet ...` may run as one command
(no scores shown; a foreground capture needs no `--wait`, only a background one is waited for); compare never chains with capture or sheet (`review-<n>.json` is written after the
sheets, before compare's scores are seen); serve never chains (long-running, in the background).
1. Start `node <skill>/scripts/serve.mjs <out>` in the background, with no port; use the URL it prints.
2. Capture the build into `<out>/.restyle/build` in the background, then wait, the one way to wait:
   `node <skill>/scripts/capture.mjs --wait <out>/.restyle/build [--timeout-s 600]` (prints `done.json`;
   exit 0 = ok, 1 = failed, 3 = still running: if it or the tool call times out, run the same --wait again); never read or poll `done.json` yourself: an older run's may still be there, --wait skips it.
   full: `node <skill>/scripts/capture.mjs <url> <out>/.restyle/build --frames-like <out>/.restyle/ref`;
   fast: the same with `--fast` instead of `--frames-like ...`.
   Full for capture 1, the one you intend as final, and after any change to responsive rules, motion
   (load, reveals, media, ambient, nav scroll) or hover; fast after 1440-only layout, colour or type fixes.
3. Sheets: `node <skill>/scripts/sheet.mjs <out>/.restyle/ref <out>/.restyle/build <out>/.restyle/sheets-<n>`.
4. Review **every** capture as a strict designer who did not build the site, into
   `<out>/.restyle/review-<n>.json`, written **before** compare runs (review §sheets, §checks,
   §rubric, §json). Full review (every sheet) on capture 1 and on the capture you intend as final;
   in between a delta review of only the sheets your changes can affect, named (review §delta).
5. Compare: `node <skill>/scripts/compare.mjs <out>/.restyle/ref <out>/.restyle/build <out>/.restyle/diff-<n>.json`.
   Real findings join the fix list; artefacts only as review §compare allows.
6. Health: in the build's capture.json `meta.consoleErrors` is 0 at every viewport; `meta.overflowX` `.overflow`
   is false and `.clipped` (content cut at the viewport edge) empty at 768 and 390, as in the reference (`inspect.mjs overflow <url> <width>` names the culprit).
7. Fix causes in the spec, tokens and structure, highest impact first; re-run `type-scale.mjs` after
   type changes. Capture again.

Self-review rubric (review §rubric): **9** = "same design system, same art direction, only minor
deviations you have to look for". Content, wording, brand and imagery subject are never mismatches.

**Done** requires all of these, on a full capture with a full review: compare `total >= 9.0` and every
area `>= 8.5`; your self-review `>= 9` in every area; the strict-judge pass (review §strict), signature
audit, originality and no-added-motion checks pass; no polish or health defect, and no compare `health`
fail ("build loads a non-catalogue web font"); when the reference's first-screen media moves, the build's
box over it has the same `motion.load.media[i].activity` as the reference's (`rate` = share of the box
changing per second, near the reference's) and the zoomed-media rows look equally lively (review §checks).
Artefacts (review §compare) never count toward a threshold: they explain a shortfall, not excuse one.

**Stop rules.** Stop and deliver, reporting the build as not done with the measured scores, what
remains and why, when: the 6th full build capture is reviewed (fast ones as needed, at most 10
captures in all); or every remaining loss is an artefact or a documented exception; or artefact
`lost` alone exceeds the gap to 9.0 (or an area's to 8.5): Done is then unreachable, so fix the real
findings, take one final full capture with a full review, and stop. Documented exceptions are
recorded, never looped on: a font-availability limit (no free face matches better; in
`substitutions[]` and `judged[]`); stand-in photos without user photos once they match the treatment
(crop, grade, overlay, placement, density; judges score that, not the subject) and only photographic
realism is left (deliver with the photo slot list). Never capture again only to chase an artefact.

## 8. Deliver
Stop the server (`serve.mjs --stop <port>`), then tell the user:
- First, if the reference is photographic and they gave no photos: real photos would lift fidelity
  most; list each slot with its file name, aspect ratio and minimum size.
- Where the site is (`<out>/index.html`) and how to preview it (`node <skill>/scripts/serve.mjs <out>`).
- Final compare scores (total, per area), your final self-review scores, how many captures it took,
  and whether it is done or stopped by a stop rule.
- Substitutions (fonts, imagery, widgets, moving media) from `substitutions[]`.
- Copy edits from `copyFit[]` (original -> fitted), invented copy, and every `data-placeholder`
  element and placeholder link to replace before publishing.
- Content left out, dropped CTAs, and extra pages offered for leftover content (built only if asked).
- `artefacts[]` with the reason for each, and the known gaps against the reference.
Keep `<out>/.restyle/` (spec, captures, sheets, reviews, diffs) unless the user asks you to remove it.

## Hard rules
- Never copy the reference's logo, brand name, copy, photos, illustrations, characters, mascot, icons
  or font files, and never redraw or paraphrase them. Never hotlink from the reference's domains.
- Never change content, structure, class names or declared values to satisfy the scorer.
- Fonts only from the public Google Fonts catalogue (css2 also serves brand faces: no proof) or system
  stacks. Each role's weight matches the reference's rendered ink, never one the family does not draw;
  no `font-synthesis`, strokes or shadows to fake weight (font-substitutes §weight). Scripts only
  GSAP/ScrollTrigger from cdnjs and, when the reference smooth-scrolls, Lenis from jsdelivr, pinned.
- No lorem ipsum. No console errors. No horizontal overflow at 768 or 390 px.
- Respect `prefers-reduced-motion` (reveals show at once; loops, media motion and parallax stop).
- Semantic HTML (header, nav, main, section, footer, one h1, ordered headings), alt text on meaningful
  images, `aria-hidden` on decorative art, visible focus states.
- Add no motion, hover effect, section or decoration the reference does not have; a moving stand-in
  for media that moves in the reference is not added motion. Restraint is part of a style.
- Report honestly: scores as measured, self-review as seen, gaps as gaps.

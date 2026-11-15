# Font substitutes

> **When you need this:** SKILL.md step 4 (before the spec's type tokens), and when a review says
> text reads lighter, heavier, wider or of another character than the reference. Every family comes
> from the public Google Fonts catalogue (§procedure 1) or a system stack. The goal is the same
> typographic voice: class (serif, sans, flared, slab, mono, script), contrast, width, roundness and
> rendered heaviness, with the measured sizes, line heights and tracking on top. Choose by looking,
> not from a name or table.
> **Sections** (`Grep "^## §"` gives line numbers): §procedure fontmatch, poor samples, size factor ·
> §weight · §nofit · §axes Google Fonts requests · §load fallback, regenerating URL and preload ·
> §seeds candidates per category · §system

## §procedure
1. **Free already?** Only a family in the **public Google Fonts catalogue** may be used (or a system
   stack, §system). fontmatch's `referenceFonts` gives each reference family's verdict (`inCatalogue`
   true = may be used under `catalogueAs` or its own name, and still matched for weights and tracking;
   false = never, pick a substitute; null = unverified because the catalogue was unreachable, `catalogue`
   "bundled (offline)": do not use it until an online run says true). Never test with a css2 request:
   fonts.googleapis.com also answers 200 with a working face for proprietary brand families outside the
   catalogue. capture's `type.families[].inCatalogue` carries the same verdict; type-scale.mjs refuses a
   `source: "google"` family outside the catalogue and compare reports one as a `health` fail.
2. **Run fontmatch** for `display`, `h1`, `h2` and `body`, and for any other role (`nav`, `button`,
   `eyebrow`, ...) set in a family those four do not use (SKILL.md step 4):
   `node <skill>/scripts/inspect.mjs fontmatch <out>/.restyle/ref --role <role>`.
   It renders the reference's sample of that role (`shots/type-<role>.png`) beside free candidates
   and prints, per candidate, `weight` (absolute CSS weight; `weightBasis` "role ink" = matched to the
   role's measured ink, §weight, with the crop fit as `cropWeight`), `lsAdjustEm` (em added to `ref.ls`),
   `sizeAdjust` (factor on the reference px), `apply{fontSize, letterSpacingEm}` (absolute: what you
   set), `axes`, `opsz` (§axes), `class.kind` and `score`, and writes `fontmatch-<role>.png` (its labels
   give the absolute font-size and letter-spacing, the adjustment in brackets).
   **Poor sample** (`sampleQuality` poor: busy background, other text reaching into the crop, two
   colours in the line, low contrast, too few glyphs, no ink in the crop): its width, tracking and size
   factor can be wrong. `summary.md` prints the same verdict for the same crop. Dim text alone is not
   poor (ink is contrast-normalised). Re-run on another role of the same family (`--role h2` for a poor
   `h1`). A poor sample still ranks faces (class, width) but sets no tracking or size factor; its weight
   still stands when `weightBasis` is "role ink" (the ink comes from the capture's probe, not the crop),
   else the role's declared weight (mapped onto the chosen face's drawn range) stands, checked on the
   composite beside a plain-background crop (`inspect.mjs crop`); record it in `judged`. A sample with no
   ink returns no candidates: take the face from another role of the family.
   `trackingClamped` / `sizeClamped` on a candidate = its width fit hit a limit: unreliable. With
   `sizeAdjustSuspect` keep `sizeAdjust` 1 or take the factor from a good-sample role of the family.
3. **Look at the image and choose by character**, in this order; the similarity rank is a shortlist,
   not the decision; when capture's `type.families[]` description and fontmatch disagree, trust the
   composite you look at and say so in `fonts[].why`:
   1. class: a serif stays a serif, a flared face stays flared; a sans never stands in for a serif or
      flared display face (the most visible type miss in the pilot rounds);
   2. width and compression: a very compressed display face needs a very compressed candidate;
   3. weight and stroke contrast: heavy stays heavy, hairline contrast stays high;
   4. terminals and roundness (a rounded heavy face needs a rounded heavy candidate, not a lighter
      rounder one), x-height, the telling letters `a g R t y`;
   5. then `score`.
4. **Weak shortlist** (no candidate of the right class, all too wide or too light): run again with
   `--candidates "A,B,C"` from §seeds for the category you see. A name outside the public catalogue is
   dropped with a note (`"X" dropped`), never ranked.
5. **One family per slot.** Roles that share a family in the reference share one in the build: take
   the candidate that works across those roles, preferably a variable family that draws every weight.
6. **Apply, per role,** what fontmatch reports for the chosen face:
   - `weight` -> that role's `weight` at every viewport, as is (§weight);
   - `apply.letterSpacingEm` -> that role's `ls` (compare scores tracking by the line width it sets in
     your face, so this value costs nothing even when it differs from the reference's declared one);
   - `opsz` "auto" -> `axes: {"opsz": "auto"}` on the slot; "default" or absent -> no opsz (§axes);
   - `sizeAdjust` -> multiply that role's `px` at every viewport when it lies within 0.96-1.04. A
     factor up to about 0.90-1.10 is acceptable when the face clearly has the right character: apply
     it, then make up the remaining line width with the family's `wdth` axis if it has one, else
     tracking within ±0.02 em; record both in `judged`. Further out, take another candidate.
   Record it in `fonts[].match`, set `fonts[].weights` and `axes` (§axes), and add `judged[]` and
   `substitutions[]` entries. Any later family, weight or axis change: §load (URL and preload).
7. **Faces no role covers** (a promo wordmark, a quote face) and roles without a sample: crop the
   text (`inspect.mjs crop`), pick from §seeds by eye (slant, width, weight), check it in the first
   build sheets. A distinct face never collapses into the heading or body family.
8. **After the first build capture** compare's `ink` findings and the review's type pass say what
   still reads lighter or heavier: move that role's weight in 20-50 unit steps (variable) or to the
   next drawn weight (static), or change family (§weight); a weight fontmatch matched by role ink
   should not draw an ink finding unless its size or tracking changed since. Targets: ink within about 8% of the
   reference role's, family `adv` and `xHeight` within about 4%.

## §weight
- **Ink decides weight.** compare scores visual heaviness as the role's probe ink (`type.roles` `ink`,
  scoring.md type), so when the capture measured it fontmatch picks each candidate's weight by that same
  probe, drawn at the size and tracking you will set (`weightBasis` "role ink"): applying it passes
  compare's ink check. The crop fit (`cropWeight`) is a second opinion; when the two differ, the ink
  weight wins. `ink.beyond` = the family cannot draw that heaviness: another family.
- **The declared weight is whatever renders like the reference.** Raising or lowering it to match
  the reference's rendered ink, intermediate variable weights included (340, 560), is correct and is
  not penalised: compare scores ink (rendered weight only where ink is missing), not the reference's
  declared number.
- **Never fake a weight the family lacks:** no declared weight outside the loaded range, no
  `font-synthesis`, faux bold, `-webkit-text-stroke` or text shadow. `type-scale.mjs` warns when a
  role weight is outside its slot's `weights`.
- **Ink finding at the family's maximum** (asks for more weight than the family draws): a heavier
  or denser family via fontmatch (`--candidates` from §seeds), or accept the finding.
- **Size** changes only by fontmatch's size factor (§procedure 6); never change px to fix weight or
  width, and never fake width with `transform: scaleX`.
- **Tracking:** `apply.letterSpacingEm` is meant for the substitute face; compare accepts it (it scores
  the line width the tracking sets, or the declared value, whichever is closer). An `lsAdjustEm` beyond
  about ±0.03 em means the wrong width: take another candidate.
  A width correction you add (§procedure 6) stays within ±0.02 em; per-family corrections go in
  `fonts[].ls` (type-scale adds it to every role on that slot).

## §nofit
When no free face is close (custom display faces, quirky brand cuts): match in this order: 1. width
(how long a line runs), 2. rendered weight, 3. terminals and roundness, 4. stroke contrast; then the
details. Say so in `substitutions[]` ("no close free face: width and weight matched, terminals
differ") and in the report. Never imitate the reference face with outlines, shadows or transforms.

## §axes
- Weight range `family=Lora:wght@400..700`; discrete `family=Spectral:wght@200;800`; italics
  `family=Rubik:ital,wght@0,300..900;1,300..900`; several families in one URL with `&family=`, then
  `&display=swap`. Axis tags are listed alphabetically, lowercase before uppercase.
- **Request every axis the face needs**, or the browser renders its default instance: Archivo
  `wdth,wght@62..125,100..900`; Instrument Sans `wdth,wght@75..100,400..700`; Commissioner
  `FLAR,wght@100,100..900`; Fraunces `wght,SOFT,WONK@100..900,0..100,0..1` (opsz per the next point).
- **Optical size (opsz) only when the reference draws the optical cut.** fontmatch draws opsz
  families both ways where they differ at the sample's size and reports `opsz`: "auto" (the
  reference shows the display cut at display sizes) -> `axes: {"opsz": "auto"}`, type-scale loads the
  range (Inter `14..32`, DM Sans `9..40`, Source Serif 4 `8..60`, Newsreader `6..72`, Bodoni Moda
  `6..96`, Bricolage Grotesque `12..96`, Big Shoulders `10..72`, Nunito Sans `6..12`) and leaves it
  automatic; "default" or no `opsz` -> no opsz in `axes`, the family's default (text) instance draws at
  every size, as a text-cut reference does. Link exactly type-scale's `fontsUrl`.
- Width, flare, softness and similar go in `tokens.fonts[].axes` (`{"wdth": 87.5}`, `{"FLAR": 100}`);
  `type-scale.mjs` applies them.
- Check the exact request before writing the spec: `200` = the axis syntax and ranges are valid (not
  that the family may be used: §procedure 1); `400` = a range the family does not have
  (`Schibsted+Grotesk:wght@300..600` fails because it starts at 400).

## §load
One `<link>` for all families with `display=swap` (build-rules §skeleton, with the preload of the
hero face). Each stack gets a metric-matched local fallback second, so text paints at once and does
not reflow when the web font arrives:
```css
@font-face { font-family: "Inter Fallback"; src: local("Arial");
  size-adjust: 107%; ascent-override: 90%; descent-override: 22.5%; line-gap-override: 0%; }
:root { --font-sans: "Inter", "Inter Fallback", Arial, sans-serif; }
```
`size-adjust` = the face's `adv` (build capture `type.families[]`) / the fallback's (Arial about 0.50;
start at 100% for `local("Georgia")` or `local("Courier New")`); keep ascent near 90% and descent near
22% unless headings jump at the swap. Never `@import` fonts in CSS or download the reference's files.
**After any family, weight-range or axis change** regenerate together: `type-scale.mjs` (its
`fontsUrl`, checked against §axes), the one `<link>`, and the preload woff2 (build-rules §skeleton).

## §seeds
Candidates per category to pass as `--candidates` when the default shortlist is weak. Weights as
Google Fonts serves them (`100-900` variable range, `static` separate files); axes per §axes.
| category (what you see) | seeds |
|---|---|
| neutral neo-grotesk | Inter (opsz), Inter Tight (display), Geist, Hanken Grotesk, Public Sans, Arimo (Arial metrics) |
| grotesque with character | Schibsted Grotesk 400-900, Libre Franklin, Archivo (wdth), Familjen Grotesk, Instrument Sans (wdth), Bricolage Grotesque (opsz, wdth) |
| geometric | Jost, DM Sans (opsz), Outfit, Figtree, Plus Jakarta Sans, Manrope, Urbanist, Sora, Montserrat (wide) |
| humanist sans | Source Sans 3, Fira Sans (static), Noto Sans (wdth), Lato (static), Mulish, Nunito Sans (opsz, wdth) |
| flared sans (swelling strokes, flared terminals, no serifs) | Commissioner with FLAR 100, Belleza (400 only), Tenor Sans (400, mild flare), Marcellus (400, serif-like, display only) |
| compressed and condensed display | Sofia Sans Extra Condensed 1-1000, Six Caps (ultra-compressed), Big Shoulders (opsz), Antonio, Oswald, Anton (drawn heavy, declare 400), League Gothic (wdth), Alumni Sans, Smooch Sans, Saira Extra Condensed (static), Barlow Condensed (static), Bebas Neue (caps) |
| wide display | Unbounded, Syne 400-800, Anybody (wdth 50-150), Archivo at wdth 125 |
| heavy slanted or italic display | Kanit italic 800-900, Archivo italic (wdth), Rubik italic, Exo 2 italic, Barlow italic 900, Sofia Sans italic |
| high-contrast display serif | Fraunces (opsz, SOFT 0), Playfair (opsz, wdth), Playfair Display, Bodoni Moda (opsz), DM Serif Display, Instrument Serif (light, narrow), Gloock, Young Serif |
| text serif | Source Serif 4 (opsz), Newsreader (opsz), Literata (opsz), Lora, Spectral (static), Gelasio (Georgia metrics), Tinos (Times metrics) |
| light humanist or old-style serif | Cormorant Garamond, Cormorant, EB Garamond, Crimson Pro, Libre Caslon Text, Newsreader and Spectral at 200-300 |
| slab | Roboto Slab, Zilla Slab (static), Bitter, Hepta Slab |
| rounded | Nunito 200-1000, Baloo 2 400-800, Fredoka (wdth), M PLUS Rounded 1c (static), Zen Maru Gothic (static), Varela Round (400), Quicksand (light) |
| mono | JetBrains Mono, Geist Mono, IBM Plex Mono (static), DM Mono (static), Fira Code, Space Mono (quirky), Courier Prime and Cousine (typewriter) |

## §system
Use a system stack only when the reference itself does (`type.families[].webfont: false`, a stack
such as `system-ui, -apple-system, ...`), copying its order; otherwise Google Fonts, because system
stacks render differently on every operating system.

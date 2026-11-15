# How compare.mjs scores a build (`restyle-diff/2`)

> **When you need this:** SKILL.md step 7, after review, when a compare finding is unclear or may be
> an artefact (review §compare): look up the check that lost points, its measure and tolerance.
> Never needed to build. `Grep "^## "` lists the parts (building blocks, findings, the five areas,
> calibration, blind spots); read only the area at hand.

`node scripts/compare.mjs <refCapDir> <buildCapDir> <out.json>` compares two captures made by the
same `capture.mjs`. It measures **design**, never content: words, image pixels and brand marks are
not compared. All weights and tolerances live in one block, `scripts/lib/cmp-constants.mjs`; the
numbers below are copies of it.

**Principle**: two visually equivalent implementations score the same. A builder never needs to read
the capture source, rename classes or reword copy to satisfy a check: margin vs padding, `<img>` vs
inline `<svg>` vs CSS art, class names and role labels do not change the score; third-party chrome
(consent banners, ad slots, chat widgets, captcha badges) is ignored on both sides.

## Building blocks
- **Tolerance curve** `lin(err, [full, zero])`: 1 when `err <= full`, 0 when `err >= zero`, linear
  in between. Every check below names its error measure and its `[full, zero]` pair.
- **Log ratio** `|ln(build / ref)|` for sizes and durations (0.15 ~ 16% off, 0.7 ~ 2x).
- **Colour distance**: Euclidean OKLab (culori `differenceEuclidean('oklab')`), "dE". Colours with
  alpha in the capture are already composited.
- **Check**: a 0-1 score with a weight. An area score = 10 x weighted mean of its checks, minus
  penalties, clamped to 0-10. `subs[]` in diff.json lists every check (score shown 0-10).
- **Guardrails**: a value missing (`null`/absent) in the **reference** removes that check and the
  other weights renormalise; a value missing in the **build** where the reference has one scores
  that check (or item) 0. A whole area with no usable reference data is `null` and the total
  renormalises over the remaining areas. If either capture has `meta.blocked.suspected`, `total`
  is `null` and `blocked` says why (areas are still reported). The script never throws on a sparse
  capture; an area that fails internally is reported with `score: null` and `errors`.
- **Partial captures**: when either capture was made with `--fast` (largest viewport only, no hover,
  no motion frames, no hero-media sample), the checks that need the missing data are not scored
  (responsive, hover, heroMedia),
  `partial: true` is set and `notes[]` says so. A fast capture is for iteration; the final verify is a
  full capture.
- **Both absent**: a presence check where neither side has the feature (no marquee on either)
  scores 1 at **half weight** (`BOTH_ABSENT_WEIGHT = 0.5`). A feature present in the build but absent
  in the reference scores 0 (added motion, gradients or shadows are design differences).
- **Total** = sum(area score x area weight) / sum(weights of scored areas), 2 decimals. Weights:
  layout 25, color 20, type 20, motion 20, responsive 15.

## Findings
Each check that lost points can emit findings `{area, severity, what, ref, build, fix, lost}`.
`lost` = points lost on the 0-10 total = `(1 - s) x w / sum(w in area) x 10 x areaWeight / sum(area weights)`.
A check made of items (bands, roles, components) spreads its loss over the items in proportion to
`(1 - s_i) x w_i`; up to 3 items per check become findings. Penalties lose `pts x areaShare`.
Severity: `high` >= 0.15, `medium` >= 0.05, else `low`. The top 30 by `lost` go in `findings[]`;
each area also lists its own. `fix` is one imperative sentence with the reference value to use, and
every finding names where: the band index and element (`band #3 (features, section.pricing)`), the
role's example element (`h1 in band #2`), the colour's example element, the widest overflowing element.

## Health (hard-rule checks, never scored)
`diff.json` `health[]` = `{check, severity: "fail"|"warn", what, fix, family?, via?, catalogue?}`, checks on the
build capture alone that never change an area score or the total. A `fail` is also `findings[0]` (area
`health`, severity `high`, `lost` 0, field `health: "fail"`) and the first lines of the stderr table
(`HEALTH FAIL ...`); compare's JSON summary line lists them as `healthFail`. Done is impossible while
one fails, and `harness/score.mjs` marks the site as not passing (`healthFail[]`, note "not passing: ...").
- `font-catalogue` (lib/cmp-core.mjs `fontHealth`): every web font in the build's `type.webFonts` must be
  in the public Google Fonts catalogue. `inCatalogue` false -> fail "build loads a non-catalogue web font:
  <family>"; null (catalogue unreachable at capture time, family outside the bundled subset) -> warn "build
  web font not verified against the catalogue: <family>"; a build capture without `type.webFonts` (older
  capture.mjs) -> warn, check not run. Fallback faces with only `local()` sources are not web fonts.

## Layout (25)
Bands = `sections[]` without the nav and without third-party bands (`role: "ad"` / `thirdParty`).
Bands are aligned with Needleman-Wunsch: pair value = `sim - 0.5`, gap = `-0.3`, where
`sim = 0.12 coarseSim + 0.03 roleSim + 0.25 heightSim + 0.25 bgSim + 0.15 colsSim + 0.1 mediaSim + 0.1 posSim`:
- `coarseSim`: coarse role class (hero / content / footer) equal 1, hero~content and footer~content
  0.3, else 0; **by position first** (`coarsePos`): the first content bands of both sides count as the
  same class when one is hero and the other content, and so do the last bands for footer~content (the
  labels come from landmark tags and the h1, which differ between markups of one design). `roleSim`
  (fine role label, `ROLE_CLOSE` table) is only a tie-breaker.
- `heightSim = exp(-|ln(vh_b/vh_a)|)`; `bgSim` = 0.7 light/dark tone match + 0.3 colour closeness
  (solid colours: `lin(dE, [0.03, 0.2])`, else category match); `colsSim` = main-row column count diff
  0/1/2+ -> 1/0.5/0; `mediaSim` = media placement table (below); `posSim = 1 - 2|yMid_a - yMid_b|`.
Bands with `analysed: false` (element cap) keep height and background checks only.
**Composite bands (alignment by content)**: where the two sides segment one stretch of page differently,
compare aligns the pieces as one unit before charging sequence, height or padding. A run of 2-8 adjacent
bands on one side may align with one band on the other (a tint strip + photo + caption cut as three bands;
a long stack cut into row strips at a narrow width; two same-colour bands one side's segmenter merged) at
no cost when the run covers the same page span and content as the single band (`LAYOUT.merge`):
- summed height within `|ln| <= 0.2` of the single band **and** fitting it better than the run's tallest
  member alone by >= 0.05 (or within 0.05 when the tallest member alone already fits): merging must explain
  height the single band absorbed. When the other members together are a sliver (<= 6% of the run and
  <= 0.12 viewport heights: a thin bar cut off the band) the height test alone suffices;
- the tallest member has the single band's light/dark tone (and solid background within dE 0.1, comparing
  the CSS colour or the colour seen in the shot on either side, so a black wrapper whose painted panels show
  the run's grey matches); members of
  the other tone cover <= 20% of the run (a light strip read on the other side as part of a dark band);
- the run's middle within 0.2 of the page height of the single band's middle;
- where both sides carry `counts` (1440 bands): the run's summed headings / media / buttons fit the single
  band's no worse than the tallest member's alone (mean `|ln((a+1)/(b+1))|`, slack 0.35).
So a band that is really missing stays charged: the other side is not taller for it, or it is taller but
holds none of the missing band's content. An **n:m unit** (runs of 2-3 on both sides cut at different
places: same summed height and outer edges within 0.2 of the page, the tone rule on each side, counts within
0.5, no inner cut of one run within 15% of the span of an inner cut of the other) scores as one pair, so it
only replaces 1:1 pairs that fit badly. A unit is checked as one merged band (summed height; outer paddings,
where members without measured content at either end count as space; the tallest member's background;
columns, cards, media and alignment from the value covering most of the run's height among members that
have one (multi-column rows, card grids with card counts summed, media other than none), so a run of equal
shelves reads as a shelf, not as its tallest odd member; summed counts; hidden at a width only when every
member is) and counts once in the sequence. The same alignment is used per viewport in responsive. The
hero position (`coarsePos`) is the first band >= 0.3 viewports tall on each side, so a thin bar above it
(an app banner) does not take it; a unit holding that band holds the position.

Per aligned pair, each item weighs `clamp(ref vh, 0.35, 2.5)` (taller bands matter more):

| check | weight | measure, tolerance |
|---|---|---|
| sequence | 18 | sum of coarseSim (by position first, `coarsePos`) over aligned pairs / max(#ref units, #build units) (a composite run is one unit). Unmatched bands become findings described by geometry (height, background, columns, media), never by role label. |
| bandHeight | 10 | `|ln(vh_b / vh_a)|`, [0.15, 0.7] |
| bandBg | 12 | 0.3 type category (color / gradient / media) + 0.4 colour dE [0.03, 0.2] (solid colours only; 0.5 if one side is not solid) + 0.3 light/dark tone match. This is where the dark/light band alternation is scored. |
| columns | 9 | main row column count: diff 0/1/2/3+ -> 1/0.5/0.2/0; equal counts > 1: 0.6 + 0.4 x lin(L1 of width ratios / 2, [0.05, 0.3]). A row covering < 40% of a band >= 2 viewports tall (`layout.rowCover`; unmeasured in older captures: such a row counts as weak at 1440 only) is only the largest of many rows: when every side that has a row (> 1 column) has such a weak one, the item counts at 0.3 x its pair weight (`LAYOUT.colsTall`; layout and responsive). A **collage** row (`layout.collage`: text-free media pieces of uneven size) counts as 1 column. |
| cards | 8 | 0.6 card columns (diff 0/1/2+ -> 1/0.4/0) + 0.25 count (within one row, i.e. +-ref cols, scores 1; beyond decays by the extra / ref count) + 0.15 card-surface match. Ref grid missing in build = 0; grid only in build = 0.5. A collage group (`cards.collage`) is no card grid. |
| align | 5 | text alignment equal 1, `mixed` vs any 0.5, else 0 |
| media | 6 | placement equal 1; background~full-bleed and above/below~full-bleed 0.6 (a full-width media block stacked with the text); left~right, above~below, center~above/below 0.5; background~center, center~full-bleed 0.4; else 0. Media of any kind (img, svg, background image, CSS art, HTML/CSS composite UI panel) is equivalent. Not scored when the reference band reads `none` but its content exists only while in view (`sections[].shot.inView >= 0.2`, or text still blank in its shot `shot.blank >= 0.3`): its DOM at analysis time is no evidence there. |
| padding | 8 | top and bottom each `|a-b| / max(a, 48)`, [0.15, 0.6], averaged. Gaps between bands on a shared background are split evenly by the capture, so margin vs padding reads the same. A pad measured past large media (top + bottom pad leave < 25% of the band while it carries non-background media, `media.frac` >= 0.1 when measured: absolutely placed art the capture did not count, so the pad runs to the text) is unreliable on that side: the item counts at 0.35 x its pair weight (`LAYOUT.padWeak`; layout and responsive). |
| container | 6 | content rail width (`railRight - railLeft`: modal edges of cards, media, rules and multi-column rows; older captures `contentWidth`), relative error [0.03, 0.2]. Like with like: a reference measured from its running text only (`contentHow` text, no rails) is compared with the build's running-text extent (`textRight - textLeft`), never with the build's rail. |
| gutter | 3 | running-text left edge (`textLeft`; older captures `contentLeft`), abs px [8, 60]. A **centred text column** (text edges symmetric about the viewport centre within max(8 px, 1% of the width) and inset >= 24 px from the rail on both sides; no rail: narrower than 60% of the viewport, `LAYOUT.centredText`) has a left edge that follows from its width: two centred columns are compared by half their width difference (the edge shift it causes, same tolerance) and the fix names the column width, not the container padding; a centred column on one side only is compared by its left edge and the fix says which side centres its text. A running-text edge measured from <= 1 band on either side (`textBands`, the digest's WEAK container) counts at 0.35 x the check weight (`LAYOUT.textWeak`; also the responsive container's edge item). |
| navPosition | 6 | same `pos` 1; both pinned (fixed/sticky) or both in flow 0.8; else 0 |
| navStyle | 5 | 0.5 height rel. error [0.08, 0.4] + 0.3 transparent match + 0.2 backdrop blur match (the scrolled state is scored in motion). Transparent vs solid matches when it looks the same: the transparent side's nav band pixels (`sections[nav].bg.sampled`, share >= 0.6) within OKLab 0.03 of the solid side's opaque nav colour and the nav not over hero media (`LAYOUT.navSeen`) |
| pageLength | 4 | `|ln(pageHeight_b / pageHeight_a)|` at 1440, [0.2, 0.9] |
| shape | 6 | radius of button (0.4) and card (0.3): `|a-b| / max(a,b,4)`, [0.15, 0.7], pill only matches pill; primary button height (0.3) rel. error [0.08, 0.4]; box-shadow presence (0.2) |
| spacing | 4 | modal flex/grid gap and heading-to-text distance, `|a-b| / max(a, 8)`, [0.2, 0.75]; a heading-to-text distance < 4 px on either side (heading box overlapping its text, not a visible gap) is not scored (`LAYOUT.stackMinPx`) |

## Colour (20)
| check | weight | measure, tolerance |
|---|---|---|
| role:pageBg / text / mutedText | 10 / 9 / 4 | dE between `colors.roles`, [0.02, 0.15]. A reference role marked WEAK (`colors.weak`: split or thin evidence, capture-schema colours) weighs x0.5 (`COLOR.weakRoleFactor`, any role; area note) |
| role:accent / accent2 | 10 / 3 | Both captures take the accents from visible actions only (filled buttons with a visible label, text links; never inside media / mock-up boxes, never hidden; a monochrome page's accent is its primary button fill), so the build is judged by its visible actions. Scored as a group: the best assignment of the build's accent/accent2 to the reference's (a swapped pair counts 10% less), then dE [0.02, 0.15] per role. Which chromatic colour is called "the" accent is fragile; the colours are what matter. **Logo / brand marks** never feed accents or minor colours: captures leave them out (capture-schema colours); for older captures a reference accent that is a brand-mark colour (`colors.brandMarks`, or a minor colour on one svg in the nav, footer or logo-row band) with no background/text/border use in its palette is not scored (area note). |
| role:surface / border | 5 / 2.5 | the same best-assignment group for surface and border |
| (secondary roles) | | surface, border and accent2 also accept the same colour used the same way (background / border / anywhere) in the build's palette, at 90%; for accent2 the build's minor colours (`colors.minor`, chromatic text/tag/icon colours by element count) count too, since each side often takes accent2 from a tiny element of a different kind |
| theme | 8 | light/dark equal |
| palette | 18 | Each palette entry weighs `(share + 0.004) x (1 + 3 x OKLCH chroma)` (loud colours weigh more). d(A->B) = weighted mean over A of the dE to the nearest colour in B; score = lin((d(ref->build) + d(build->ref)) / 2, [0.012, 0.07]). Both directions: a missing reference colour and an extra loud build colour both cost. |
| minor | 10 x (0.5 + 0.5 x tag share) | **Required only when used**: a reference minor colour on >= 3 tag/icon elements or >= 4 text elements, or painting >= 2% of the page's text glyph area (`colors.minor[].share`), is required; a status or sale colour on a few small elements is not (area note lists them; `COLOR.minorRequire`; older captures without `share` use the counts only). Each required reference `colors.minor[]` colour (chromatic text/tag/icon colours, by element count; colours equal to the accent roles left out) needs a close colour among the build's minor colours and palette: lin(nearest dE, [0.03, 0.12]), weighted by sqrt(element count), tag/badge and icon colours double text-only ones; brand-mark colours (as for accents) are never required. The check weighs fully when the reference's minor colours are on tags/icons, half when they are only text colours. This is where small coloured kicker tags and category labels are scored. Requirements = the reference's first 8 minor colours that are not graphic-only (colours only on SVGs larger than 64 px are evidence, not requirements); the build's pool = all of its minor colours (up to 16: text, tags, SVG fills and strokes of icons and graphics, SVG `<text>` fills, inside composite panels and aria-hidden art too) plus its palette. |
| gradients | 8 | Only band gradients count, by the same rule on both sides: **visible as colour** once its stops are composited over what it sits on (its first band's `bg.color`, else the page background): two composited stops >= 0.06 apart (`COLOR.gradient.compositeDeltaE`), so a fade of that colour to transparent (a page-colour edge mask) is not; a **shade** (neutral stops of one colour whose alpha alone changes, never above 0.5: soft shadows, vignettes) is not; not an **overlay on media** (capture flag `onMedia`, a gradient layered with a `url()` image, or a translucent gradient whose bands all have picture backgrounds: caption scrims, photo fades); not a **thin strip** (capture flag `thin`, < 64 px) and >= 4% of its bands' area (>= 0.4% of the page without a band; `bandShare`, `pageShare`). Gradient text (`clipText`) and gradient buttons only need to be visible (two opaque stops at dE >= 0.08, or an alpha fade >= 0.3) and are never art-discounted. The finding counts what was left out and why ("not band gradients: ...") and says "none counted" rather than "none" when a side has gradients that do not count. Presence 0.4 + area fraction `|ln((a+0.01)/(b+0.01))|` [0.3, 1.6] x 0.2 + where-used Jaccard (band/card/button/text/other) x 0.2 + hue match (mean nearest hue distance of chromatic stops, [15, 60] deg) x 0.2. **Gradient shipped as an image**: a visible CSS gradient on one side with >= 2 chromatic stops (alpha >= 0.5, hues >= 25 deg apart) whose aligned band (layout alignment) on the other side has no visible CSS gradient counts as present on the other side too (its area, where-used and hues) when every chromatic stop colour covers >= 0.05% of that aligned band's pixels in the other side's `shots/1440-full.png` (OKLab dE <= 0.06, every 2nd px; `COLOR.gradient.image`). Needs the capture dirs (compare.mjs passes them). **Art stand-ins**: a reference band painted by a canvas, image, video or SVG (`bg.type`, or `sections[].media` of those kinds or composite, by its `frac` of the band), or whose pixels are not its CSS colour (`bg.sampled` vs `bg.color` dE > 0.1), gives its aligned build band(s) an allowance of that share of the build band's page area; build CSS gradient area inside those bands is taken out of the build's tally up to the allowance, and a gradient left under 0.1% of the page is dropped (the finding says how much was not counted). The reference's own gradients over its own art bands are discounted the same way, so self-compare stays 10. A gradient both sides draw (every chromatic hue of each within 15 deg of the other's; neutral ones within 2x area) is that gradient, not an art stand-in, and is never discounted on either side. |
Band background colours are scored in layout.bandBg only (not double counted here).

## Typography (20)
Primary viewport roles (`type.roles["1440"]`); `display` is dropped when it equals h1 (+-1 px). Roles come
from sizes and use, never tags or landmarks (capture-schema type: body = prose by characters, any tag,
mock-up and small-print text left out), so the same design scores the same whatever its markup.
Role weights: h1 3, body 3, h2 2.5, display 1.5, h3 1.5, button 1.5, small 1, nav 1, eyebrow 1.
**Heading tiers**: display/h1/h2/h3 are visual size tiers, never tags. When both sides have the same set
of heading roles they pair by name; otherwise the two size-sorted tier lists are aligned
(Needleman-Wunsch, pair value = `lin(size rel. error, [0.04, 0.25]) - 0.3`, gap `-0.3`, `TYPE.tierAlign`),
so a tier that one side labels by another tag (two h1 elements, an h2 used as the hero title) is compared
with its size twin; every per-role check below uses that pairing, and coverage counts only tiers left
unpaired. The same pairing is used per viewport in responsive.
Per role (roles present on both sides):

| check | weight | measure, tolerance |
|---|---|---|
| size | 28 | relative error of px, [0.04, 0.25] |
| weight | 24 | only for roles whose `ink` is **not** measured on both sides: **rendered** weight (nearest loaded face; synthesised bold = face + 300), `|w_a - w_b|`, [20, 150]: a role 100 lighter scores 0.38. When ink covers every role this check is removed and the other weights renormalise. |
| ink | 24 | **visual heaviness**: the role's `ink` (coverage of a fixed sample drawn in the role's exact font, capture-schema "Visual heaviness"), relative error `|ink_b - ink_a| / ink_a`, [0.06, 0.35]: 6% off scores 1, 20% off 0.52, 35% off 0. This is where a thin-stroked substitute at the reference's exact declared weight loses points. The finding says how much lighter or heavier and the fix: the substitute's next real face (variable fonts: a 20-50 unit step within its weight axis), a heavier- or lighter-stroked substitute, never faked weight. Available weights come from the bundled `scripts/lib/google-fonts.json` (wght axis, or the static weights; else the capture's family record): a face that does not exist is never advised, and a family without a heavier/lighter face gets "switch to a heavier-/lighter-stroked substitute". Where ink is measured on both sides it replaces the weight check for that role, so a weight raised on purpose to match the reference's ink costs nothing. **Ink wins over fontmatch's crop fit**: fontmatch picks each candidate's weight with this same probe at the size and tracking the build sets (`weightBasis` "role ink", font-substitutes §weight), so its weight passes this check. |
| lineHeight | 10 | rendered line box (`lhr` = line box height / font size, `normal` resolved to the font's real normal) when both sides have it, else the declared ratio with `normal` = 1.2; relative error [0.06, 0.35] |
| letterSpacing | 7 | abs em, [0.006, 0.05], on the smaller of two differences: the declared values, and the set width the tracking produces (`px x (adv + ls)` per character, `adv` = the role's advance per em at letter-spacing 0, against the reference's, in reference em). A substitute face needs its own tracking to run the reference's line width (fontmatch `apply.letterSpacingEm`), so that value is never charged; older captures without `adv`: declared only. |
| transform | 6 | text-transform equal |
| category | 8 | sans/serif/mono of the role's family from its name (`type.families`) equal 1, display~sans 0.8, else 0. Exact families are substituted by design and never compared. |
| width | 6 | measured width of the role's family: 0.5 width class (condensed / normal / extended) equal 1, adjacent 0.4 + 0.5 advance width per em relative error [0.04, 0.15] |
| xHeight | 4 | measured x-height / em of the role's family, relative error [0.04, 0.15] |
| pairing | 5 | heading (h1/display/h2) and body share one family on both sides, or use two families on both sides |
| scale | 10 | role px / body px, relative error [0.05, 0.3] |
| coverage | 10 | 1 - (weights of reference roles missing in the build + 0.5 x weights of build roles absent in the reference) / weights of reference roles; heading tiers count as missing/extra only when the tier alignment leaves them unpaired (an unpaired build display tier is not extra) |

## Motion (20) — inventory match, not pixels
Signature motions (the load sequence, the header's scrolled state, continuous ambient motion, moving
hero media) weigh enough that missing one costs about 1.2-1.8 area points.

| check | weight | measure, tolerance |
|---|---|---|
| revealPresence | 10 | reveal element counts: both > 0 -> `|ln((n_b+1)/(n_a+1))|`, [0.35, 1.6]; one side only -> 0; neither -> 1 (half weight). A step group whose elements together cover < 0.5% of the 1440x900 screen (`minorStepShare`: a carousel arrow turning visible) is not counted on either side |
| revealFrom | 5 | from-state kinds (fade, slide-up/down/left/right, scale, rotate, clip, blur) Jaccard x 0.6 + magnitude x 0.4 (opacity abs [0.1, 0.5]; translate `|dy|/max(|y_a|,8)` [0.25, 1.0], same direction only; scale abs [0.02, 0.15]; visibility hidden counts as a fade from opacity 0). **Strips**: per strip pair (build captured `--frames-like`) where both strips ease in (`content.appear` fade / slide), the distance between the half-way offsets (x, y; 0 for a fade in place) lin [8, 30] px (`MOTION.revealFromStripPx`): a fade in place vs a slide, another axis or side, or a much longer slide. The check takes the lower of the summary score and the strip pairs' mean (the strips are what is seen) |
| revealDuration | 5 | `|ln(ms_b/ms_a)|`, [0.15, 0.9]. Step groups (`appear: step`, no transition) have no duration: both sides step-only = 1; one side step-only = lin(the eased side's visible ms, [200, 600]), where the visible ms is 0 when most of that side's strips show content arriving in one step, else the median ms of its fading / sliding strips, else its sampled `summary.ms` |
| revealEasing | 3 | family equal 1; ease-out~ease-in-out 0.5, ease-out~spring-like 0.5, ...; else 0. Not scored when a side's reveals are all steps |
| revealStagger | 3 | staggers < 30 ms count as none; both none 1; one side 0.3; both `|ln|`, [0.25, 1.2] |
| revealTiming | 8 | reveal strips side by side (build captured `--frames-like`; `motion.frames.reveals[].content`, measured by compare.mjs from the stored frames when a capture lacks it): per build strip and the reference strip it replays, `late` = build `lagMs` - reference `lagMs` (how long the content in view keeps visibly changing after the scroll stops); `late` > 200 ms -> lin [200, 700]; reference strip `inPlace` and the build's not -> also capped at lin(build `lagMs`, [100, 400]). **Step vs ease** (`content.appear`, and `motion.frames.load.appear` for the load strip; capture-schema `motion.frames`, measured by compare.mjs from the stored frames when a capture lacks it): where the reference's content arrives in one step (`kind: step`, complete within one or two frames) and the build's eases in (`fade` / `slide`), the pair is also capped at lin(build `ms`, [200, 600]) (a fade under 200 ms counts as a step); reveal strips (not the load strip) also the reverse: the reference's content eases in and the build's arrives in one step = lin(reference `ms`, [200, 600]). The load strip is one more pair (appearance only, no `--frames-like` needed) weighing 2 reveal pairs; weighted mean over pairs. Reveal groups marked `skip` (load-driven fades in place in their strip) are not in `reveals.summary`, so they are not counted by revealPresence either. Not scored without pairs |
| load | 18 x significance | load sequence **as the load strip shows it** (frames.mjs `loadEntrance`, the same decision the digest prints as "load entrance"): older captures are first re-filtered with the skip rules (`MOTION.load`: fade-outs ending at opacity <= 0.05 or losing >= 0.3, popups/overlays by element name); then on any capture a group is left out when it repeats (its element is an auto-advance element of the same capture), is tiny (area x n < 0.3% of the viewport), is a media box's entrance (kind `media`) that the strip shows painted from first paint (`media[].withLoad` false: the fade is not visible), or shows nothing arriving in its box (`appear.kind` none). Where the strip measured a group (`groups[].appear`) the strip wins: start = `appear.atMs` after first paint, duration = `appear.ms`, from-state none for a step, opacity 0 for a fade, opacity 0 + the half-way offset for a slide; a media entrance ends at its box's `appearsMs`; else the sampled start (t0 - FCP), ms (+ stagger) and from-state. A drawn media box (canvas, svg, art, panel, Lottie) the strip shows arriving with the load (`withLoad`) is the box's entrance even with no sampled animation (content drawn in), unless a kept group holds >= 80% of it; late network media (img, video, iframe, background image) never adds one. **Designed** = some kept group eases in (fade / slide, or a sampled from-state the strip did not measure) or the kept groups arrive at >= 2 moments >= 150 ms apart; all kept groups appearing in one step at one moment (skeleton placeholders swapped for content, a page shown at once) is content arriving: not a designed entrance, not staged. **Staged** = designed and either the content outside the media boxes animates (`summary.textShare`, older captures `areaShare`, >= 0.15, with a kept non-media group) or the kept media entrances cover >= 15% of the viewport; the summary (order, delay, total, modal from-state by area) is built from the kept groups. A side without a staged load that has load groups is described with why they do not count (never "shows it statically"); both: 0.3 total duration `|ln|` [0.25, 1.2] + 0.2 start delay after first paint, abs ms [100, 600] + 0.25 order of arrival (longest common subsequence of the kind order / longer) + 0.25 from-state score. Group start times are the animations' real starts (`startTime + delay`, `groups[].t0How`) where the CSS/WAAPI animation is known, and never a change made while the element is still transparent, so frame drops during load and fill-backwards snaps do not move the delay, total or order; every tolerance is several times the measured run-to-run spread (calibration). Significance = clamp(0.35 + 0.15 x groups (<= 4) + 3 x animated area / viewport area, 0.35, 1) (animated share = `summary.areaShare`, else the kept groups' area / viewport area) of the side that has it: a staged hero counts fully, a small flourish about half. All load data comes from the warm-cache reload (capture-schema `motion.load`), so network delay is not compared as a designed hold. When the animation sampler saw nothing on a side but its load frames show a **designed** build-up (`motion.frames.load.visual.designed`: >= 2 frames where the content area grows by >= 15% of its final value, over >= 150 ms, no shrink step (content that disappears again: a toast, a carousel, a video cut), read from at least half of the frame (moving hero media is masked out), not continuous motion, and still there on the warm reload; a build-up seen only on the cold first load is `network` and does not count), that side counts as staged at significance 0.6 and the pair is compared on build-up duration (`|ln|` [0.25, 1.2]) and step count (`|ln((n_b+1)/(n_a+1))|` [0.3, 1.2]). The frames fallback applies only when the sampler reported no load groups at all on that side (groups it reported that the skip rules dropped are what the frames show). |
| heroMedia | 22 x significance | first-screen media activity (`motion.load.media`, frame differencing inside the media box; not measured on `--fast` captures, so not scored against a fast build): the reference's largest moving item (activity >= low, on load or continuously) against the build's moving box over it (else its largest moving box); score = min(level part, rate part). Level part: same level or livelier by one = 1, livelier by two 0.5, by three 0.2; calmer by one level 0.55, two 0.2, three 0.05. Rate part (both captures have `rate`, the share of the box changing per second; floored at 0.001): lin(ln(ref rate / build rate), [0.35, 2.3]) when the build is calmer, else 1, so within a level a build changing 3x less of its box per second still loses (0.62). Rates and levels are compared like with like on any capture version (frames.mjs `mediaRate`: the continuous `rateCont` whenever measured, so a box that only changed during the load (an image fading in) is static; the load-phase rate only when the settled page was not measured; level = the level of that rate, so a capture without a load-phase measurement compares the same as one with it). **Kind**: when both sides measured how the media moves (`motion`: in-place / lateral / cut / drift) and the kinds differ, the score x 0.6 (`MOTION.heroMedia.kindMismatch`; the finding names both kinds: match the kind first, then the rate); cut vs in-place counts only when clear on both sides (the cut side changes in <= 30% of consecutive frame pairs, `active`, the in-place side in >= 80%; `cutClear`), since a cross-fade's kind flips between them with its duration. Any kind counts (video, canvas, Lottie, CSS animation on the media box, a composite illustration = kind `art`; the build's `ambient.items` of kind `media` inside the first viewport too). Graphic motion inside a media box (keyframe loops, drifts, image-only slides, transform-moved and gradient layers) is that box's activity on both sides, never a marquee, loop, auto-advance, scroll-linked animation, parallax or gradient (capture-schema `motion.load` hero media). Reference moving vs build still = 0; build moving vs reference still = 0; both still = agreement at weight 22 x 0.19 x 0.5 (the round-4 4.2 before halving). Significance = clamp(0.5 + 2 x the item's visible share of the first viewport, 0.5, 1) (`MOTION.heroMedia`). With weight 22 a first-screen hero box two levels calmer (low vs high) costs more than 1 motion point on any page (check-compare syn 6 (1a)). The finding states both rates and says to raise how much of the box changes per second. Not scored when the reference capture has no `media` list (older captures). |
| navScroll | 14 | header on scroll (`spacing.nav.onScroll`): pinned on one side only = 0 (the whole scrolled state differs); otherwise 0.5 + 0.3 Jaccard of what changes in the scrolled state (bg, height, edge, blur, transparency, extra buttons, hides; `edge` = a shadow, a border or a `line` under the bar seen in the scrolled shot, one kind) + 0.2 scrolled height rel. error [0.08, 0.4]; neither pinned nor changing on both sides = absent (half weight). Pinned follows the capture's screenshot evidence (`onScroll.shot`): a bar still at the top of the scrolled shot stays in view, and layout's navPosition reads the pinned `pos` the capture writes for it (`posCss` keeps the computed one) |
| ambient | 14 x significance | continuous motion inventory (`motion.ambient`; when heroMedia is scored, ambient items that are the hero media are left out on both sides: any item on the same element (a drift animation on the hero image), and items of kind media/video/canvas/lottie over >= 50% of its box or, without a box, in the band of a moving hero item; so the same motion is not counted twice): presence; both: 0.4 count `|ln((n_b+1)/(n_a+1))|` [0.3, 1.2] + 0.3 share of bands with motion, abs [0.1, 0.5] + 0.3 kinds Jaccard. Significance = clamp(0.3 + 0.35 x count + bandShare, 0.3, 1). |
| transitions | 8 | per category (colour, transform, opacity, effects, layout), counting per transition group only the elements on which it can do something visible: captures with `motion.transitionsObserved` leave out `noop` (an element seen animating in a reveal or load whose transitioned property never changed there and that no `:hover`/`:focus`/`:active`/`[aria-expanded]`... rule matching it sets, e.g. a reveal recipe's `transform`/`filter` on an opacity-only reveal) and `rv` (the transition that carries that reveal / load, timed by the reveal / load checks) on both sides; older captures drop opacity/transform transitions within 12% of the reveal duration instead. Then the n-weighted median ms and dominant easing family; item = 0.6 lin(`|ln|`, [0.2, 1.0]) + 0.4 easing match, weight sqrt(ref share of elements); missing category 0; a build-only category with >= 15% of elements adds a 0 item at half weight. A category is scored (on the reference side, and as build-only) only when its properties visibly change in something that side's capture observed: hover deltas (`hover[]` self, ::before/::after, children), reveal and load from-states, the header's scrolled-state changes (`h` layout; `bg`/`border`/`color`/`transparent` colour; `shadow`/`blur` effects; `extra` opacity; hiding transform). Transitions on properties that never change are no-ops and are never required. Without a hover pass nothing is filtered. |
| hover | 10 | per component kind present on both sides (primary-button 3, secondary-button 2, card 2, nav-link 1.5, text-link 1, button 1, image-link 1, footer-link 0.5): change classes (background, colour, border, shadow, opacity, underline, filter, outline, tracking, lift, scale, move, pseudo, image-scale, icon-move), each weighted 1 on the element (0.5 for child-only changes) and averaged over the sampled elements; score = `1 - sum|f_a - f_b| / max(1, #classes with f >= 0.5)`. Skipped (failed) hover reads are left out, and so are samples marked `invalid` (capture-schema `hover[]`: moving without the pointer, or not shown) with their crop pairs: a kind sampled only on invalid elements on one side is skipped (the detail lists it), never compared against the other side's valid sample. **Crops vs data**: each kind's before/after crop pair (`motion.frames.hover[].visual.changed`, computed from the PNG pair for older captures) is checked against the hover data of the element it was shot on; when they disagree on either side (data "no change" but the crops differ on >= 0.5% of their pixels, or the reverse) the data is WEAK and that kind is judged on the crops: one side visibly changes and the other not = 0, both still = 1, both change = lin(`|ln((a+0.01)/(b+0.01))|`, [0.5, 2]) on the changed shares, so a build matching what the crops show is never charged. **Missing visible change**: the reference's crops change visibly and the build's of the same kind do not = 0 even when the data agree; a reference kind whose crops change visibly while the build has no element of that kind hovered = a 0 item. Not scored against a `--fast` build. |
| sticky | 4 | other sticky/pinned elements (>= 60 px, not the header): count `|ln((n_b+1)/(n_a+1))|` [0.35, 1.6], one side only 0 |
| parallax | 4 | presence (measured movement only; layout shift during the scroll pass - an ad slot or embed resizing, scroll anchoring - is measured out in the capture, see capture-schema `parallax[]`); both: median rate abs diff [0.05, 0.3] |
| marquee | 3 | when both have a marquee (a strip scrolling past its window; a slow drift of an ordinary element is a loop): 0.6 speed `|ln|` [0.25, 1.2] + 0.4 direction (presence is part of ambient) |
| autoAdvance | 3 | when both have an auto-advance period (`motion.carousels.autoAdvance[].periodMs`, the 8 s slow watch): `|ln(p_b/p_a)|` of the median periods [0.2, 0.9] (presence is part of ambient); otherwise not scored |
| smoothScroll | 4 | detected equal |
| scrollLinked | 4 | scrubbed elements + CSS scroll-driven animations that change a visible property (not those on the header: its scrolled state, `scrollTimeline.nav`; older captures: `getAnimations[]` entries on a nav / header element or named like one) + scroll-driven horizontal movers: presence, then count `|ln|` [0.35, 1.6] |
| scrollTint | 5 | page background at scroll rests (`motion.scrollTint`, screenshot level, so a body background, a fixed colour layer and a pseudo-element paint read the same; a change < 0.02 OKLab from its rest colour, `tintMinDe`, is dropped on both sides): presence of tint changes; both: 0.4 count `|ln((n_b+1)/(n_a+1))|` [0.3, 1.2] + 0.6 colour (mean of the two directions' mean nearest dE of the tint colours, [0.03, 0.15]). When both sides measured where changes start and how long they take (`colors[].bandTop`, `.ms`), timing is 0.3 of the check (count and colour share the other 0.7): per reference change paired with the build change of the nearest colour, 0.6 trigger (band top as a viewport fraction, abs diff [0.1, 0.4]) + 0.4 duration (abs ms [150, 700]; both scroll-scrubbed = 1), averaged. Not scored when the reference capture has no `scrollTint`. |
A reference with little motion still scores on what exists (transitions, hover) and on the build
not adding motion. A build capture without a motion block scores 0 on every motion check.

## Responsive (15)
Repeated at 768 and 390 (each viewport carries half of these weights). Each viewport's own band
sequence (`sectionsByViewport`, segmented independently) is aligned the same way as layout (heights in
viewport heights of 1024 / 844); a band that exists at one width only (mobile-only alternate sections)
aligns as such. The **per-band checks** (heights, columns, padding, align, spacing) compare narrow bands
**linked back to their aligned 1440 bands**: each aligned primary pair stands with the narrow bands linked
to its members (a narrow band whose `id` equals a primary band's id is that band; else `link`; plus
`sections[i].collapse[vp].bands`), pairs whose narrow sets overlap form one group, and each side's narrow
bands of a group are merged (summed height, outer paddings, the tallest member's background, columns,
cards, alignment, media). So a reference band that re-segments at 768/390 (one 1440 band shown as three
bands) is compared as one unit with its counterpart. Narrow bands left over (mobile-only, or of unaligned
primary bands) are aligned with each other as before; an unlinked narrow band that this width's own
alignment merged into a group's run (same span and content, composite-band rules) joins that group. A
primary band rendered at the width but linked to no narrow band (`collapse[vp].unlinked`: its rows were
regrouped into another band's container) belongs to the narrow band of the nearest linked primary band
before or after it whose page span (fraction of page height) contains the primary band's middle.
Captures without `link` use the independent alignment. The sequence check counts the same units: each
linked group is one unit per side, bands left over are one unit each (without links: the independent
alignment's units), so a band cut into row strips on one side only is not charged as missing/extra bands.

| check | weight | measure, tolerance |
|---|---|---|
| `<vp>` heights | 5 | band `|ln(vh_b/vh_a)|`, [0.2, 0.8] |
| `<vp>` columns | 6 | mean of the column item and the card-column item (layout formulas, counts ignored): the collapse pattern; 25% of each band's item is the overflowing-row / carousel-peek match |
| `<vp>` padding | 4 | as layout padding |
| `<vp>` align | 3 | text alignment per band (centred vs left at this width) |
| `<vp>` spacing | 2 | card grid gap per band, `|a-b| / max(a, 8)`, [0.2, 0.75] |
| `<vp>` sequence | 3 | coarseSim (by position first) sum over aligned units / max unit count (linked groups and composite runs count once) |
| `<vp>` type | 8 | per role (heading tiers paired as at 1440), the 1440 tolerances: size (0.55), heaviness (0.3: ink where measured on both sides, else rendered weight), line-height (0.15, rendered line box when both sides have it) |
| `<vp>` container | 3 | 0.6 running-text left edge (`textLeft`, else `contentLeft`) abs px [4, 24] (centred text columns as in layout gutter: half the width difference) + 0.4 rail width (`railRight - railLeft`, else `contentWidth`; text extent against text extent when the reference has no rails) rel. [0.04, 0.2] |
| `<vp>` nav | 3 | 0.35 position equal + 0.35 height rel. [0.08, 0.4] + 0.3 pinned after scrolling 1.5 screens at that width |
| `<vp>` pageLength | 2 | `|ln|`, [0.2, 0.9] |
| `<vp>` marquee | 1 | `motion.marqueesByViewport[vp]` on both captures and a marquee on at least one side: 1 when both have one moving, else 0 (never scored when neither has one, so pages without marquees are not lifted) |
| hidden bands | 3 | per aligned primary pair and viewport where exactly one side does not render the band (`collapse[vp] === null`): 0 each; bands absent on both sides cost nothing. A band replaced at that width by a mobile-only alternate at the same position (a `sectionsByViewport[vp]` band with `link: null` between the narrow bands of the primary bands before and after it) counts as shown; with several hidden candidates in one gap the alternate stands for one of them (the one it replaces unambiguously at another width, else a role match, else the last). A composite run is hidden only when every member is. |
Penalties (area points, after the weighted mean): **-2.0** per viewport where the build scrolls
horizontally and the reference does not (the finding names the widest offending element); else
**-1.0** (`RS.clippedPenalty`) per viewport where the build cuts visible text at the viewport edge
(a `kind: 'text'` item in `meta.overflowX[vp].clipped`) and the reference capture, which ran the same
check, cuts no text there (not judged against captures without the field; media running past an edge,
such as a bleeding tile row or a mock-up window, is reported but never charged, and so is text in a row that also runs past the left edge: a centred carousel or ticker); **-1.0**
when the build logs console errors (sum over viewports) above an allowance (0 when the reference logs
none, else 2 x ref + 2), **-2.0** if 3 or more above it.

## Calibration (capture/2, Nov 2026)
Measured on five real pilot reference sites of different kinds (a dark product site, a gradient-heavy
product site, a photographic retail site, a dense editorial site, an illustrated consumer app) and on
the test fixture:
- Self-compare (each reference against itself; the fixture): 10.00.
- Noise floor, the same site captured twice a few minutes apart: 9.99-10.00 total; type 10.00, ink
  check 10.00 on both pairs (remaining noise: content column width at 768 on a page with a rotating
  banner).
- Motion noise, one unchanged pilot build (a staged hero load with CSS delays and fill-backwards
  from-states) captured 3 times and compared with its reference: before load start times came from the
  animations (Nov 2026) the load check read 7.28-9.05 (start delay 0 or 1232 ms after first paint, total
  2479-3733 ms, order flipping), motion 8.68-8.99, total 9.10-9.16; after (two sets of 3): load 9.69-9.73
  (delay 1063-1072 ms, total 2620 ms, same order), motion 9.69, total 9.37 every time. Scroll-tint timing,
  the same build and the same reference each captured twice: trigger identical (30 px steps), duration
  within 12 ms; the tint tolerances (band top 0.1 viewport, 150 ms at full score) are far above it. The load tolerances (delay 100 ms,
  duration |ln| 0.25 at full score) are far above that spread.
- Cross-site (two different pilot sites against each other): 3.9-5.0 total, type 4.6-6.5.
- Fixture sensitivity (single changes, the changed area drops the most): accent hue +40 deg ->
  colour 7.92; h1 64->48 px -> type 9.33; h1 weight 700->400 -> type 9.68 (scored through ink, 28%
  lighter; the weight check is not scored where ink is measured); the whole page in a
  thinner-stroked system family at the same declared weights -> type 8.50 (ink 42% lighter on body,
  29% on h1); reveal 600->200 ms -> motion 9.50; static first screen
  against a staged hero -> motion 8.22; CTA band removed -> layout 9.57; card grid 3->2 columns ->
  layout 9.70; nav sticky->relative -> layout 9.45, motion 8.61. Equivalent builds (margin vs padding,
  `<img>` vs inline `<svg>`, with/without third-party chrome) score 10.00.
- Synthetic capture edits of the fixture (check-compare `--only syn`, Nov 2026): every role's weight
  +100 with ink unchanged -> type 10.00, responsive 10.00; every role's ink 30% lighter -> type 8.32;
  heading tiers relabelled by other tags (same sizes) -> type 10.00; a band split into three adjacent
  bands of the same summed height and background -> layout 10.00; a mobile-only alternate band in place
  of a hidden band against a build that reflows it -> no hidden-band loss; a load that is only a
  fade-out against a static first screen -> load agreement; moving hero media (medium activity) against
  a static stand-in -> motion 8.78, against a moving stand-in of low/medium/high activity -> 10.00.
- Pilot round 2 builds re-scored with these rules (same captures; round-2 metric -> now): dark
  product 9.38 -> 9.49, gradient product 8.45 -> 9.21, photographic retail 8.48 -> 9.28, editorial
  9.33 -> 9.46, illustrated app 8.49 -> 9.18.
  The removed losses were all ones a builder could not fix honestly (weight raised to match ink, a popup
  and a poster fade-out read as load staging, no-op transitions, a mobile-only band swap, a composite band
  split, tag-labelled heading tiers). Mean absolute gap to the blind judge per area (5 builds):
  layout 0.56 -> 0.64, colour 0.88 -> 0.88, type 1.29 -> 1.16, motion 1.73 -> 2.04, responsive
  0.38 -> 0.89; compare is now more lenient than the judges on motion and responsive for these builds
  (old captures carry no hero-media or scroll-tint measurement, which the judges did see).
- Ink against the blind judge: on the five pilot round-1 builds, the ink check ranks the builds in
  the judges' type order (substitutes 25-30% lighter score lowest), and adding it brought the mean
  absolute gap between compare's type score and the judges' from about 1.25 to about 0.97.
- Earlier re-scoring of the pilot builds against fresh references: mean absolute gap to the blind
  judge per area layout 0.80, colour 0.44, type 1.25 (before ink), motion 1.64, responsive 1.37.

## Known blind spots
- Not measured: icon style, illustration/photo art direction, image radius and cropping inside cards,
  decorative details (grid lines, glows, noise), WebGL/canvas/video content, card internal layout,
  border styles beyond the border colour role. The judge covers these.
- Card detection is heuristic; a build whose bands are segmented differently (one wrapper instead of
  stacked sections) loses alignment points without looking different, though less than before because
  only coarse role classes are scored and runs of up to 8 bands (n:m up to 3:3) may align with one unit
  when they cover the same span and content; a run that fits the single band no better than its tallest
  piece, pieces of another tone covering > 20% of the run, or (without content counts, at narrow widths)
  a really missing band whose space the neighbour absorbed may still be misread. Pads measured from text
  are flagged only when the band's media is detected (`media` none with uncounted art is not caught).
- Motion is an inventory: the right kinds, counts and timings score well even if they fire on
  different elements. Hover deltas only cover the sampled components. Motion inside canvas/WebGL/Lottie
  is seen only for first-viewport hero media (frame differencing, activity level, not what moves).
  Below the first viewport, art moved by script (Lottie, canvas) is not seen at all, while the same art
  moved by CSS keyframes is an ambient loop: such a pair reads as added motion on the CSS side. An
  auto-advance slower than one step per 8 s has no period (`periodMs: null`) and one slower than 8 s may
  not be seen.
- Transition categories are scored only when hover, reveal, load or header changes show the property
  changing; a transition used only by an unsampled state (a menu, a carousel) is not scored.
- Ink is measured on a fixed sample string in the role's font, not on the page's own glyphs: colour,
  contrast and anti-aliasing against the real background are not part of it.
- A band that recolours by scroll position (`bg.scrollTheme{rest, centred}`) is scored at its centred
  colour (`bg.color` / `bg.sampled`) in bandBg and as a tint change in scrollTint; its rest colour is
  not scored on its own.
- A gradient shipped as an image is recognised only by its stop colours appearing in the aligned band's
  pixels, not by their arrangement: a photo or illustration that happens to contain every stop colour of
  the other side's CSS gradient in that band also counts. Single-hue gradients are never matched this way.

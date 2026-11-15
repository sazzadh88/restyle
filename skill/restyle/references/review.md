# Visual review: sheets, rubric, strict-judge pass, compare

> **When you need this:** SKILL.md step 7, after every build capture and before compare runs. Blind
> designers comparing sheets are the stricter half of the score; this review shows you what they see
> before compare's score anchors your opinion. Read §sheets, §delta, §checks and §rubric before the
> first review; later reviews need only the section at hand. **Sections** (`Grep "^## §"`): §sheets ·
> §delta full and delta reviews · §look · §checks per sheet · §density · §rubric scores and caps ·
> §polish · §originality · §addedmotion · §signature · §strict · §compare artefacts · §json

## §sheets
`node <skill>/scripts/sheet.mjs <out>/.restyle/ref <out>/.restyle/build <out>/.restyle/sheets-<n>` writes at
most 10 sheets and `sheets.json` (what each shows). A = reference (left or top), B = build:
`fold-1440.png` (the resting nav); `full-1440-<k>.png` (up to 4 slices, slice k covering the same
fraction of each page); `full-768.png`, `full-390.png` (tops = folds at that width); `states.png`
(scrolled states per width, component crops, hover pairs); `motion-<k>.png` (load rows over one span
until both sides settle, settled frame outlined green, a cut lead-in explained in the row note that
also says what keeps moving after it; zoomed rows whenever either side's first-screen media moves (a
large box shows its most-moving half; the note gives activity and % of the box changing per second);
reveal strips from the wheel input at the reference's page
positions, plus a scroll-tint strip across A's first page-colour change). Times are printed under the
frames: compare times, not frame counts. Against a `--fast` build only the 1440 sheets have a B side.

## §delta
Every build capture, fast or full, gets its `review-<n>.json`, written before compare runs.
- **Full review** = every sheet, viewed again on this capture (the one exception to "never re-open an
  unchanged sheet"). Required on capture 1 and on the capture you intend as final; done is judged only
  on a full review of a full capture.
- **Delta review** (allowed in between) = only the sheets your changes since the last review can
  affect (the fold too only when a change can reach it). List them in `reviewed`, the rest in `skipped`
  with the reason; areas not re-checked carry over as `stale`. Never call a review full when a sheet was skipped.
- What a change affects: colour or type tokens -> fold, 1440 slices where they appear, components;
  one band's layout -> its 1440 slice (the fold only for the nav or first band; plus 768/390 if its narrow
  rules changed); responsive rules -> 768 and 390; load, reveals, media, theme -> motion sheets and fold;
  hover or nav -> components.
- A fast capture always gets a delta review of its 1440 sheets; motion and responsive stay `stale`.

## §look
Look as a strict senior designer who did not build the site, at the design system and art direction.
**Content differs on purpose and is never a mismatch** (brand, logo, fitted wording, photos,
illustration subjects, icons): judge where things sit, how big and heavy they are, how they are
framed and how they move. Open each sheet once and write its notes before opening the next.

## §checks
Per sheet, write concrete mismatches or what you checked and found equal. A mismatch is `{area,
where, ref, build, impact, fix}`: "hero headline: A 2 lines, light serif; B 3 lines, a sans" is one;
"type feels off" is not. Impact: `high` = seen in the first seconds; `medium` = seen on a normal
look; `low` = you have to look for it.
- **1440 fold:** nav at rest (height, items, CTA, chevrons, alignment); hero proportions, headline
  position, size, rendered weight, face character and line count; each button's fill and legibility
  over what it sits on; art placement, scale, medium, glow, and tone and contrast (a dark,
  high-contrast scene with a vignette under the copy, not just the same hue); whether A's hero media
  moves (then B's must move on the motion sheet); the first band edge.
- **1440 slices:** band sequence and dark/light rhythm (scroll-theme bands in the same state); band
  heights, top paddings and gaps between bands, band by band (a band visibly shorter, a compressed
  graphic, text sitting lower, bands drifting lower down the page: check each lower-half band's top
  padding against A's); hairline dividers; container edges; grids and bento arrangements; a carousel
  whose last card bleeds off the edge in A bleeds in B; item templates in A's order and ratio (text-only items vs
  image cards in feeds); density and text mass (§density); minor colours; every signature trait; footer.
- **768 sheet, its own layout.** First the element set: header items (CTA, number of tabs), whole
  items per carousel or row and the peek (no clipped sliver), cards stacked or side by side, footer
  columns and rows. Then for every band: same arrangement and alignment? the rest of the items hidden
  or trimmed the same way? accordions? small items stacked? art clear of the nav and headline where
  A keeps a clear field? similar internal gaps and side inset? type a step larger than A's? Sheets
  crop sideways overflow: read the build's `meta.overflowX` at 768 and 390 (any `overflow: true` is polish).
- **390 sheet:** the same questions per band, plus the hero's internal gaps, a logo or label row that
  must stay one clipped row, labels cut mid-word, a crowded header, text over art, clipped titles,
  diagrams kept horizontal or reflowed as A does.
- **Components sheet:** box, fill, border, radius, font of each component over its background. Hover
  pairs per component: what changes in A (fill, colour, dimming, underline, lift, icon nudge) and
  whether B does exactly that treatment, nothing more (a dim in A is never an underline in B).
  Scrolled states: bar background, height, shadow or border, items that appear, at each width.
- **Motion sheets:** load strip frame by frame: B's first frame shows what A's shows (page colour,
  nav, painted bands; never a white or black flash), first visible content, hold and order within
  ~15% (a row starting after a cut lead-in is media arriving, not a hold), B's green settled frame no
  later than A's; A static after first paint means B static; zoomed media rows, compared frame by
  frame: as much of B's crop changes between frames as of A's (shapes travel as far, scenes change as
  often), and the row notes give the same activity; "barely moves" next to A's clear motion is a
  motion mismatch of at least medium impact; reveal strips: backgrounds painted from the first frame, only content animating, no blank
  area mid-scroll; scroll-tint strip: colour switches at A's point and speed; ambient motion. A "page
  busy" note (first frame after the wheel input came late) is script work: never copy it from A, cut
  it in B.
- **Type heaviness and character pass** (before scoring type): the hero headline, a paragraph, card
  titles, numerals, nav and footer links at the same scale. Is B as black as A? Same class (serif,
  sans, flared), width (compressed or normal), contrast and roundness? A lighter or different-class
  face is a type mismatch even when the numbers match (font-substitutes §procedure step 8).

## §density
For each widget, mock-up, dense card group or photographic band, count the distinct elements in A's
crop and in B's: rows, labels, chips, avatars, numbers, icons, images. Record `{where, ref, build}`.
B below 75% of A is a `medium` mismatch ("stand-in sparse"); a flat gradient where A has a dense photo
or illustration is one too, whatever the count.

## §rubric
| score | meaning |
|---|---|
| **10** | Indistinguishable in style: with the content swapped, nobody could tell which is the original. |
| **9** | "Same design system, same art direction": only minor deviations you have to look for. |
| **8** | Same system, one or two deviations a designer notices on a normal look. |
| **7** | Clearly inspired, several deviations a designer points out immediately (band proportions, accent use, a type scale, weight or face class that is off, missing signature details, a static hero where A stages or plays one). |
| **5** | Same broad genre, different system: rhythm, palette distribution or type feel differ. |
| **3** | Little in common beyond being a website. |
Areas: **layout** (band sequence, heights, container, grids, alignment, media placement, whitespace,
nav layout); **colour** (theme, roles, area share, gradients and glow, dark/light alternation, minor
colours, scroll-theme states); **type** (scale, rendered weight, line height, tracking, case, face
class and pairing, heading line counts); **motion** (from the motion and components sheets only: load,
reveals, media, nav scrolled state, ambient, hover; added motion counts as much as missing);
**responsive** (collapse and reflow at 768 and 390, polish at every width).
- Score the build you see. Between two scores take the lower.
- An open `high` mismatch caps its area at 7; an open `medium` at 8.5. Only `low` is compatible with 9.
- A polish defect caps responsive at 8 and the area where it shows at 8.5.
- Motion in B without evidence in A caps motion at 7.
- Areas not re-checked in a delta review, and motion and responsive after a fast capture, are `stale`.

## §polish
Each blocks done: overlapping elements; text over art where A has none or a scrim; clipped text or
titles; labels cut mid-word; a last item half under an arrow; horizontal scrolling; empty bands;
broken images; unfinished placeholders (grey boxes, skeleton bars where A has detail); illegible
buttons over their background; a crowded header (logo touching the links); an unreadable shrunken
diagram; an image cropped through its key part; awkward wraps; items running together; unstyled
elements; a white or black first frame or a blank band mid-scroll in the strips.

## §originality
For every illustration, character, product shot, icon and logo in B, ask of what sits in the same
place in A: "would someone who knows A say this is A's drawing, redrawn?" It fails on the same kind
of figure in the same pose, the same object arrangement, a mascot with A's body, colour and eyes, or
A's product or icon drawings restyled; it passes when subject and composition come from the user's
business. A failure is redrawn with a subject from the brief before the next capture.

## §addedmotion
List every moving thing in B (load, reveals, media, loops, theme switches, hover changes) and point to
its evidence in A's strips, hover pairs or `motionCore` / `motion[]`. Anything without evidence is
removed. A moving media stand-in points to `motionCore.heroMedia`.

## §signature
For each `direction.signature[]` trait, name the sheet and place where it appears in A and in B. A
trait you cannot point to in B is a mismatch (usually `medium`). The audit is complete when every
trait is found, in every band where A shows it.

## §strict
**What a strict judge will still see** (builders stuck at 8-8.5 missed exactly these). Before
declaring done, and whenever your scores reach 9, answer each on the final sheets, in `strict`:
1. **Load strip:** does B's frame 0 show what A's shows, does B's content arrive within ~15% of A's
   times, and is B at rest no later than A?
2. **Hero and feature media:** does everything that moves in A's strips (video, canvas, floating
   objects) move in B's with similar energy?
3. **Heading face character:** would a designer call B's display and heading faces the same class,
   width and roundness as A's? A sans standing in for a serif or flared face is a `high` type mismatch.
4. **768 and 390 element set:** header items and tab count, whole carousel items and peek, stacked
   or side-by-side cards, footer structure equal to A's? any band where A stacks, left-aligns or
   trims and B keeps desktop columns?
5. **Stand-in density:** any widget or mock-up under 75% of A's element count?
6. **Signature colours in every band they occur:** each saturated band colour, tag colour, glow and
   gradient in the same bands as A, scroll-theme states included.
7. **Hover:** per component the same treatment, children included, none added.
8. **Rhythm at 1440:** band heights, top paddings and band tops tracking A's down the page?
9. **Not design:** no popup, cookie bar, ad, embed or loading placeholder reproduced.
Every "no" becomes a mismatch at the impact a judge would give it, and is fixed or scored.

## §compare
Only after the review file is written, run compare and read its stderr table (the top findings).
- **Real** (fix list): anything you can see; a value copied wrongly; a design element A has and B
  lacks (a load sequence, a gradient, a transition family, a band, a hover change, ambient motion, a
  heading size, a reveal in A's `motion.reveals`); load timing. Fix causes (a wrong token, a missing
  sub-block), not one number.
- **Artefact** (rare), exactly one of: (a) the sheets show B matching A there, and closing the finding
  would change content, structure, class names or declared values for the scorer's sake; (b) a
  reveal skipped by motion-patterns §reveal (under ~100 ms, first viewport); (c) third-party, ad or embed behaviour in A (popups, consent bars, ad-slot layout shift,
  embedded players): never design; (d) **scorer misdetection**: the capture measured something other
  than what A's own shots show (mock-up text read as a type role, a band left unsplit or blank in A's
  shots, a logo colour counted as a palette colour, a centred art object or a collage counted as
  columns), named by its capture.json path (`inspect.mjs get`) and the sheet that shows it;
  (e) **build misdetection**: the same for B: the build capture measured something other than what
  B's own shots and source show (a small chromatic fill inside a stand-in mock-up taken as the accent,
  a component crop or hover pair picked on an element that is not B's counterpart of A's, a band
  merged or split where B's shots show A's structure), named by the build capture.json path and the
  sheet. Never change B to dodge (e) unless the change is also right by the sheets.
  Record `{finding, area, lost, sheet, why}` (`sheet`: where the evidence is; `why`: one sentence;
  (d) and (e) add `path`, (e) also `side: "build"`). Nothing else is an artefact.
- Artefacts never count toward done: they explain a shortfall in the report. When their `lost` alone
  exceeds the gap to 9.0 (or an area's to 8.5), done is unreachable: SKILL.md "Stop rules".

## §json
`<out>/.restyle/review-<n>.json`, one per build capture; `compare`, `fixes` and `artefactsAfterCompare`
(artefacts that compare's findings revealed, §compare records) are added after compare runs; `artefacts`
holds only what the review itself found before compare:
```json
{
  "capture": 3, "fast": false, "kind": "delta", "sheetsDir": ".restyle/sheets-3",
  "reviewed": ["fold-1440.png", "full-768.png"], "skipped": [ { "sheet": "motion-1.png", "why": "no motion change since capture 2" } ],
  "sheets": [
    { "sheet": "fold-1440.png", "checked": "nav, hero face and weight, buttons over art, glow",
      "mismatches": [ { "area": "type", "where": "hero headline", "ref": "2 lines, light serif", "build": "3 lines, visibly lighter",
                        "impact": "high", "fix": "copyFit the heading to 44 chars; serif weight 300 -> 340 per fontmatch" } ] }
  ],
  "density": [ { "where": "band 4 booking mock-up", "ref": 38, "build": 31 } ],
  "polish": [], "addedMotion": [], "artefacts": [],
  "originality": { "pass": true, "pieces": [ { "where": "hero art", "subject": "kickboard and goggles on a pool edge" } ] },
  "signature": [ { "trait": "hairline divider between light bands", "build": "full-1440-2.png bands 3-5", "ok": true } ],
  "strict": [ { "q": 3, "answer": "yes: light transitional serif on both" } ],
  "scores": { "layout": 9, "color": 9, "type": 8, "motion": 8.5, "responsive": 9, "stale": ["motion"] },
  "compare": { "total": 9.12, "areas": { "layout": 9.3, "color": 9.5, "type": 8.9, "motion": 8.7, "responsive": 9.1 } },
  "fixes": [ "type: copyFit hero heading", "type: serif weight 340", "motion: hold hero until 520 ms" ],
  "artefactsAfterCompare": [ { "finding": "accent #3fa2f7", "area": "color", "lost": 0.12, "sheet": "fold-1440.png", "side": "build",
                               "path": "colors.accent", "why": "the build capture took a send-button fill inside the stand-in mock-up as the accent" } ]
}
```
Fix in the order of `fixes` (highest impact first), then capture again.

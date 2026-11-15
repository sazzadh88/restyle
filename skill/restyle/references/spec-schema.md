# design-spec.json (`restyle-spec/1`)

> **When you need this:** SKILL.md step 5, while writing `<out>/.restyle/design-spec.json`, and later
> to ask "where does this value come from". The build implements the spec; the spec says where every
> value came from (capture fields: capture-schema.md; the digest names each value's capture path).
> **Sections** (`Grep "^## §"` gives line numbers; read only the one you are filling): §rules ·
> §top top-level fields, `ref`, `brief` · §direction art direction, signature, density · §color ·
> §fonts slots and fontmatch results · §type roles, weak-capture fixes · §space container, gaps,
> radius, shadow, border, motion tokens · §components · §bands fields, scroll-theme bands, coarse
> bands, feeds · §resp the per-band 768/390 checklist and element set · §content mapping the user's
> content, placeholders · §copyfit · §motioncore load, nav, ambient, hero media · §motion · §misc ·
> §example (optional)

## §rules
- **Verbatim.** A token is the measured value: 26 not 24, `cubic-bezier(0.33, 1, 0.68, 1)` not
  `ease-out`, `#1d2a2f` not `#000`. Rounding to nicer numbers is how builds drift.
- **Judged values say so.** A value not in the capture, or taken over a weak field, comes from the
  sheets or `inspect.mjs` and gets a `judged[]` entry (`path`, `value`, `why`).
- **"none" is a value.** Behaviour fields (`motionCore.*`, every `resp` key) are always filled; when
  the reference does not do the thing, write `none` / `[]` / `false` / `null` with the evidence.
- **CSS-ready.** Colours `#rrggbb`; capture alpha colours (`#ffffff@0.08`) as `rgb(255 255 255 / 0.08)`;
  lengths in px numbers, durations in ms numbers, easings as CSS strings. Per-viewport objects use the
  keys `"1440"`, `"768"`, `"390"`.
- **No reference identity.** Never the reference's brand name, copy, logo, image or font-file URLs.
  Reference family names appear only in `fonts[].ref` and `substitutions[]`.

## §top
| field | content |
|---|---|
| `schema` | `"restyle-spec/1"` |
| `ref` | `{url, capture: ".restyle/ref", theme, pageHeight{vp}, libraries[], dropped[{refI, why}]}`. `theme`: `colors.theme`, or `"mixed"` when dark bands cover 25-75% of the page. Build page heights land within ~15% of `pageHeight`. Never load a library just because the reference did. `dropped`: ad slots, consent notices, empty embeds; announcement bars and promo strips are design and stay |
| `brief` | `{name, pitch, audience, tone, pages[], assets[{file, kind, from}], leftOut[{content, why, offer}], extraPages[], droppedCtas[]}` |
| `direction` | §direction |
| `tokens` | `color, fonts[], type, typeStep[], space, radius, shadow, border, motion` (§color to §space) |
| `components` | §components |
| `bands[]` | §bands and §resp |
| `copyFit[]` | §copyfit |
| `motionCore` | required: `load`, `navScroll`, `ambient`, `heroMedia` (§motioncore) |
| `motion[]`, `responsive`, `substitutions[]`, `invented[]`, `judged[]` | §motion, §misc |

## §direction
What a designer would say about the style, written from the sheets; it holds what the json cannot see.
| field | content |
|---|---|
| `summary` | 2-4 sentences: theme, mood, type personality and heaviness, layout habit, imagery, motion temperament |
| `signature[]` | 3-6 traits that make the style recognisable, each `{trait, where, how}`: `where` = bands, components, viewports where it appears; `how` = how the build reproduces it. Small things count: hairline dividers, glow intensity, coloured kicker tags, a two-tone heading, a band's saturated colour. Audited every review (review §signature) |
| `imagery` | `{treatment, medium, notes, radius, shadow, aspect}`. `treatment`: `photo-fullbleed`, `photo-inset`, `product-cutout`, `flat-illustration`, `3d-render`, `abstract-gradient`, `ui-mockup`, `pattern`, `typographic`, `mixed`. `medium`: what the art is made of. Never describe the reference's subjects as something to reproduce |
| `density` | `airy` / `balanced` / `dense`, plus per widget or mock-up the countable elements in its crop (`{where, rows, labels, chips, avatars, numbers, icons}`); stand-ins land within ~25% (review §density) |
| `decor[]`, `icons`, `emphasis` | decorative devices (rules, rails, grids, glows with intensity, grain); icon style (stroke or fill, width, size, container); how emphasis works in headings (colour split, italic word, weight) |

## §color
| token | from | when the capture is weak |
|---|---|---|
| `pageBg`, `text`, `mutedText` | `colors.roles` | check `pageBg` on the fold; bands that paint another colour carry their own `bg`; a role in `colors.weak` (digest WEAK): read it from the shots, record in `judged` |
| `surface` | `colors.roles.surface` | when it equals the hairline colour, the real panel is usually a near-white/near-black `variants` entry of `palette[]` or a band `bg.color`: use it, record in `judged` |
| `border` | `colors.roles.border`, `spacing.borders[0]` | |
| `accent`, `accent2` | `colors.roles` | **Monochrome sites:** palette `share` < 0.002 and mostly `graphic` uses, or a black/white primary button: there is no accent; `accent` = the primary button fill, record in `judged`. Never promote a logo, photo or illustration colour. `accent2` only if visible as a deliberate second colour |
| `accentHover`, `onAccent` | primary button `hover` and `color`, `hover[]` | else a `colors.vars` hover ramp; else omit |
| `minor[]` | `colors.minor[]` | `{name, hex, use, where}` named by use (`tagReview`); small chromatic colours on tags, badges, icons, kickers |
| `dark*` | dark bands' `bg.color`, their text colours | light site with dark bands (or the reverse): `darkBg`, `onDark`, `onDarkMuted`, `darkBorder` |
| `extra{}` | `palette[]` entries with `share >= 0.005` not covered above | named by use (`headlineMuted`, `bandTint`), never by the reference's variable names |
| `gradients{}` | `colors.gradients[].css` verbatim | keep if `areaFrac >= 0.005` or visible in a sheet; band gradients list band ids in `bands[]` even when `sections[].bg.type` says `color` |

`bg.sampled` differs visibly from `bg.color` with `sampledShare >= 0.6`: the sampled colour paints;
use it and note it. **Colours without a role** (the muted half of a heading, a tag, a divider tint):
never eyeball a hex. Look in `minor[]`, `palette[]` with `variants`, `colors.screenshot`,
`colors.vars`, `components.*`, `hover[]`; else sample with `inspect.mjs color` on the reference shot
and record the source in `judged`.

## §fonts
`tokens.fonts[]`: one entry per family the roles use.
| field | content |
|---|---|
| `slot` | `sans` / `serif` / `mono` / `display`: how the build refers to it (`--font-sans`) |
| `ref`, `refCategory`, `refWeights`, `refVariable` | `type.families[]` |
| `refRendered` | `{width, adv, xHeight, ink{role: value}}` from `type.families[]` and the 1440 roles using this family |
| `use`, `source` | the chosen face (font-substitutes §procedure) and `google` (a public Google Fonts catalogue family under its catalogue name: type-scale.mjs exits 1 on any other) or `system` |
| `match{role}` | the chosen fontmatch candidate per role, as applied: `{weight, weightBasis, letterSpacingEm, fontSize, sizeAdjust, opsz, class, score}` = its `weight` (ink-matched when `weightBasis` is "role ink"), `apply.letterSpacingEm`, `apply.fontSize`, `sizeAdjust`, `opsz`, `class.kind`, `score` |
| `weights` | exactly what the Google Fonts link loads (`"300..700"`, `"400;700"`, italic tokens such as `"400;ital 700"`); every role weight on this slot lies inside it |
| `axes` | axis settings the slot needs, e.g. `{"wdth": 87.5}`, `{"FLAR": 100}`; `type-scale.mjs` loads a fixed axis as the family's whole range and sets the value. `{"opsz": "auto"}` only when fontmatch reports `opsz` "auto"; without it no optical size is requested (font-substitutes §axes) |
| `fallback`, `stack`, `ls` | local fallback name, full CSS stack, per-slot tracking correction in em (normally 0) |
| `why` | class, width, contrast, terminals, heaviness, and what was given up |

## §type
`tokens.type[vp][role] = {px, weight, lh, ls, tt, font, style?}` for `display, h1, h2, h3, body,
small, nav, button, eyebrow` from `type.roles[vp]` (`lh` unitless, null = normal; `ls` em; `font` a
slot). Keep every role found, at every viewport. Heading roles are size clusters, not tags: one
semantic `h1` stays, and each heading gets the role class of its size.
- **Weights and tracking come from fontmatch** (`fonts[].match`, both absolute; the weight matched to
  the role's ink), intermediate variable weights included; record each in `judged` ("fontmatch: 300 ->
  340"). The button role's `lh` is its label line-height (build-rules §components buttons).
- `body` is the running text: prose by character count, any tag, outside nav, footer, buttons, UI
  mock-ups and small print (capture-schema type); a body that is mock-up, tile or legal text is WEAK.
- Optional, all `judged`: `h4` (a distinct heading step below `h3`, e.g. card titles; type-scale makes
  `.t-h4`), `lead` (intro paragraphs between `h3` and `body`: `type.roles[vp].body.lead` when captured,
  else `inspect.mjs style`), `cta` (the CTA band's headline when it is no `h1`-`h3` tier; band headings
  follow it with `headRole: "cta"`) and `micro` (9-11 px text inside mock-ups, often reported as `small`
  with a large `n`).
- `typeStep[]`: roles that step at the breakpoints instead of scaling, when the reference is stepped;
  band headings step with their role, or alone with `band<i>`.
- Each band's main heading uses `bands[].headPx` (measured per band and viewport); `display` larger
  than `h1` usually belongs to one statement band: give it to the band whose `headPx` equals it.
- A band heading between two heading tiers (e.g. ~48 px between `h2` 40 and `display` 64, with no
  capture role at that size): add a `tokens.type` role of its own (any name, e.g. `h1b`: its px per
  viewport from `headPx`, the nearest tier's font, weight, lh and ls, `judged`) and set that band's
  `headRole` to it. Never borrow `cta` or another role of another size: type-scale would size the band
  as that role. Without a role the band is sized from its own `headPx` (correct) and type-scale warns.
- Weak roles (marked WEAK or POOR in `summary.md`, no heading tags, `body` with weight >= 600 or `lh`
  <= 1.1, roles that contradict the sheets): check the sheets or `inspect.mjs`, rebuild from the modal `headPx` of content bands and the sheets; record in `judged`.
- A role missing at a viewport carries the nearest one's entry (type-scale does this); `nav` missing
  at 768/390 usually means the links collapsed into the menu.
- Sizes that are not roles (stat figures, quotes, prices): `headPx` when it is that band's largest
  text (`headRole: "figure"`, `"quote"`, `"label"`: type-scale then emits no band size), else measure
  them. A `headRole` naming a `tokens.type` role (any name, also `quote` when that role exists) sizes
  the band heading as that role's px, also in a band whose role (logos, footer) is otherwise skipped. Stat figures (`type.stats`, short numeric strings
  like "98%") are their own style, never a heading tier.

## §space
| token | from | notes |
|---|---|---|
| `container[vp]` | `spacing.container[vp]` | `{railLeft, railRight, textLeft, textRight, contentWidth}`: rails = where the outermost content boxes (cards, media, rules, the main row of a multi-column band) paint; text = where text starts and ends. `contentWidth` is the rail width (`contentHow: "rail"`), the text width only on a page without rails. Build use: build-rules §container |
| `gaps[]` | `spacing.gaps[vp]` | the 4-6 most frequent values |
| `stack[vp]` | `spacing.stack[vp]` | heading-to-text and text-to-button distances |
| `sectionPad[vp]` | `spacing.sectionPad[vp]` | default only; each band carries its own `pad` |
- `radius{button, card, input, image, badge}` from `spacing.radius`, `components.*.radius`; `"pill"` =
  9999px. `card: null` or a measured `0` where the sheet shows rounding (a clipping wrapper): nearest
  `radius.top[]` value, `judged`.
- `shadow{}` from `spacing.shadows[].css` verbatim, named by where they show (`card`, `float`).
- `border{}` from `spacing.borders[]` with sides (`t`, `b`, `rl`): band dividers, row dividers, rails.
- `motion{ease{}, dur{}}`: distinct easings and durations from `motion.transitions[]`, reveals and
  load, named by use (`ease.ui`, `dur.hover`).

## §components
Each from `components.<name>`, its crop and the matching `hover[]` entry:
`{h, pad[t,r,b,l], radius, bg, color, border, font{px, weight, ls, tt, lh, font}, shadow, transition,
hover{prop: value}, kids[{what, delta}], notes}`. Where the crop disagrees with the numbers (an inner
wrapper was sampled), take the visible style, `judged`.
- `notes`: what it sits on and how it stays legible ("solid fill over the hero art").
- `kids[]`: child hover changes, including swaps (`{"what": "chevron", "delta": "becomes an arrow, shifts 3px right"}`).
- `nav`: plus `{pos, h{vp}, transparent, overHero, blur, border, links, cta, dropdowns[{item, panel}]}`;
  every dropdown trigger gets a panel (§content). Scrolled state: `motionCore.navScroll`.
- `mobileMenu`: icon type and position, what stays beside it (390/768 sheets); open state in A's style.
- `buttonSecondary`, `input`, `badge` missing: from the sheets, else derived from the primary button.
- `footer`: columns per viewport, link font and weight, headings, social, legal, perk or trust rows,
  newsletter input, narrow-width accordions.

## §bands
One entry per reference band, in order, nav and footer included.
| field | from | notes |
|---|---|---|
| `i`, `refI`, `refRole`, `role` | `sections[].i/role` | correct the role when the sheet disagrees; keep `refRole` |
| `theme` | bg luminance | `light` / `dark`: the dark/light rhythm must survive |
| `h{vp}`, `vh` | `sections[].h`, `sectionsByViewport` | targets within ~10%: height comes from content + `pad`. `h` equal to the viewport height at every width = `min-height: 100svh` |
| `bg` | `sections[].bg` + sheet | `{type: color/gradient/image/video/canvas/svg, value, sampled, standIn, scrollTheme}`. Media types: `standIn` names the replacement in the user's subjects and the reference scene's tone (dark or light, contrast, vignette or scrim under the copy). `scrollTheme` (only when `sections[].bg.scrollTheme` is present: the band changes colour as it scrolls into view): `{rest{bg, fg}, centred{bg, fg}, triggerBand, bandTop, ms, scrub, rangePx}`, `bg` from `scrollTheme.rest` / `.centred` (`bg.color` already holds the centred one), `fg` from the sheets (`judged`); timing copied from `bg.scrollTheme` (as `motion.scrollTint.colors[]`); with `triggerAt: null`, `bandTop` and `ms` from the reveal strips, `judged`; motion-patterns §theme |
| `layout{vp}`, `cards{vp}` | `layout`, `cards`, `sectionsByViewport[vp]` | `{cols, ratios[], gap}`; `{n, cols, gap, w, h, like, overflow, arrangement}`; bento grids: `arrangement` per viewport from the sheet |
| `align`, `textLeft{vp}` | `align`, `contentX[0]` | 1440 alignment (narrow widths in `resp`); text left edge when it differs from the container's `textLeft` |
| `media` | `sections[].media` | `{place, kind, frac, moves, standIn}`; `moves`: the media plays or animates (video, canvas, Lottie, drifting objects): `motionCore.heroMedia` or `ambient` holds how |
| `pad{vp}` | `pad` | `[top, bottom]` px on the band element; a starting value: text positions are confirmed by measurement after capture 1 (build-rules §bands). A very large value usually means art fills it |
| `headPx{vp}`, `headRole` | `headPx`; sheet | `heading` / `figure` / `quote` / `wordmark` / `label`, or the `tokens.type` role the heading is set in (`h4`, `lead`, ...): type-scale.mjs then sizes `--fs-band<i>` from that role and does not warn. Its warning "band N heading ... off the nearest heading role" (the band is then sized from its own `headPx`) is cleared by naming the role, a tier role of its own (§type), or a non-heading kind, never by `heading` |
| `counts` | `sections[].counts` | density target: headings, paragraphs, buttons, links, images, words (within ~30%) |
| `sticky` | `motion.sticky[]`, sheets | a column or module that sticks while a longer neighbour scrolls: `{what, top, besides}` (build-rules §feeds) |
| `sub[]` | sheet | sub-blocks of coarse bands: `{name, h, layout, cards, headPx, divider, content}` |
| `hideAt[]`, `resp{"768","390"}`, `motion[]` | `collapse[vp] == null`; §resp; motion names | |
| `content` | brief / invented | `{source: user/invented/mixed, eyebrow, heading, sub, ctas[], items[], media}`; items map to the reference's item templates in order (§content) |
| `notes` | | decor, emphasis, overlaps, band-specific caption sizes |

- **Coarse bands.** `notes[]` says a band "was not subdivided", or it is taller than about 1.6
  viewports with several heading groups or background changes: split it into `sub[]` from the sheet.
  Section crops stop at 2400 px; crop the rest from `shots/1440-full.png` with `inspect.mjs crop`.
- **Long feeds.** Multi-column rivers and listings: sub-blocks in `sub[]`, column areas per viewport
  in `layout` and `resp.order`, the item template once; the build generates the repeats.
- **Narrow-only bands.** Bands hidden at a width are hidden in the build there; bands that exist only
  at 390 (a simpler alternate) are noted on the nearest band and built.

## §resp
`bands[].resp["768"]` and `resp["390"]`: every key filled, from **that width's sheet**
(`ref-full-768.png`, `ref-full-390.png`). 768 is its own layout: read it band by band, never derive it
from 1440 or 390. Start with the **element set**, counted before building and checked again in every
review: header items (CTA, number of tabs), whole items per carousel or row and the peek, cards
stacked or side by side, footer columns and rows.
| key | content |
|---|---|
| `layout` | the band's arrangement in words: columns or rows, what stacks, how rows align ("two statements stacked as left-aligned rows"; "CTA heading, text and button stacked") |
| `align` | alignment of the intro text (`left`, `center`) |
| `order` | block order when it changes (`"media above text"`), else `null` |
| `hidden` | elements hidden at that width, else `[]` |
| `items` | how many repeated items show and how the rest go: `"6 of 6"`, `"3 of 5, last two hidden"`, `"5 whole + peek of the 6th"`, `"one row clipped at the edge, no wrap"`; `null` without repeated items |
| `peek` | px of the next card visible at the edge of a horizontal row (`0` = fits exactly); `null` without a row |
| `accordion` | groups collapsed into accordions, else `[]` |
| `stack` | small items whose arrangement changes (`"store badges stacked"`, `"perk row stacked, centred"`, `"buttons full width"`), else `[]` |
| `artClear` | where art sits relative to the nav and text: `"clear field behind logo and headline; ribbon from the right third"`, `"art below text"`, `"behind text with a scrim"`; `null` without art |
| `gaps` | main vertical gaps inside the band, top to bottom, in px (`[24, 32]` = art to heading, heading to buttons); required for hero and CTA bands, else `null` |
| `gapAbove` | visible px between the previous band's last content and this band's first |
| `inset` | px from the viewport edge to content, normally the container's `railLeft`; `0` only if the reference runs edge to edge |
| `nav` | nav band only: every item the header shows (links, CTA, tabs with their count, menu icon), and the space between the logo and the actions |
| `notes` | anything else visible (type a step smaller, a diagram kept horizontal and scaled) |

## §content
How the user's content fills the reference's bands. These rules are stated only here.
- **Sequence.** The home page follows the reference band sequence. Fill bands in order with content
  of the same kind, then fit the rest into existing band patterns even when the topic differs, as
  long as structure, density and weight stay (a feature grid carries pricing tiers, a code window
  becomes a booking mock-up). A band without user content keeps its pattern with invented copy at
  the reference's length (`invented[]`).
- **Item templates.** Items take the reference band's item templates in the reference's order and
  ratio (count text-only items and image cards on the sheet: a mostly-text river stays mostly text);
  never a template the band lacks (no large image card opening a river that opens with plain posts).
- **Copy length** within about +-20% of the slot (§copyfit). Short copy is extended with real meaning
  from the brief (a sub-line, a feature's detail, a place), never filler; else keep it short, recorded.
- **Fewer items than the reference's row, grid or carousel.** Fill from other real brief content so
  the row keeps its count and overflow; otherwise reduce the count, drop the controls that lose their
  job (arrows, dots, pagination), and record which in the band's `notes` and the report.
- **Placeholder copy** the user did not supply (a sign-in nav item, a logo row, dates, a quote slot):
  only where the reference has that slot; `data-placeholder` on the element, `placeholder: true` in
  `invented[]`, listed in the delivery note. Never invent claims, prices, figures, ratings, awards or
  named people: such a slot carries real brief content in its pattern, else visibly placeholder text.
  Editorial feeds: bylines are a role or desk ("Studio desk") or omitted; dates plausible relative to
  the build date; counts (comments, reads) carry `data-placeholder`.
- **Dropdown triggers** in the reference nav keep their chevrons and open a simple working panel in
  the reference's dropdown style (or the nav's colours and type) with real links from the brief.
- **Links.** A real destination first: an in-page section, an included page, `tel:`/`mailto:`.
  Otherwise `href="#"` with `data-placeholder`, listed in the report.
- **CTAs without a slot** are dropped (`brief.droppedCtas`); a hero with one button keeps one.
- **Leftover content** no band can carry: `brief.leftOut` with the extra page you would build,
  offered in the report, built only when asked (build-rules §pages). Never append bands to the home
  page unless the user asked for that section there (reuse a band pattern before the closing CTA,
  `"added": true`).
- **Logo as a layout element** (a giant or vertical wordmark): an original wordmark of the user's
  name in the build's heading system at the same scale, weight and orientation.

## §copyfit
Text mass is design: a headline wrapping to four lines where the reference wraps to two reads larger.
- Per heading and short label (hero, band headings, CTA headline, buttons, nav, kickers): count the
  reference text's characters and lines at 1440 and 390 from the sheets; fit the user's meaning into
  about the same characters (+-20%) so it wraps the same at both widths (fit the tighter). Trim or
  extend wording only within the slot, as lightly as possible: meaning and facts stay, never an
  invented fact; never shrink type to fit. Body text stays within ~30% of the band's `counts.words`.
- User insists on exact wording: keep it, `kept: true`, report the cost.
- Entry: `{band, slot, ref: {chars, lines{"1440","390"}}, text, chars, original, kept}`.

## §motioncore
Required. Each entry has `kind`, `evidence` (capture paths and frames looked at) and its parameters;
`none` needs evidence too ("`motion.load` null; load strip identical after first paint").
- `load` (`motion.load`, `motion.frames.load.visual`, the load strip; warm-cache reload):
  `{kind: staged/simple/none, evidence, holdMs, firstVisibleMs, totalMs, sequence[{target, atMs, from, ms, easing}], patterns[]}`.
  Times relative to first paint. Staging counts only when designed (`motion.load` groups or
  `visual.designed: true`); network steps (`visual.network`) are `none`. Items visible from the first
  frame (often the nav) are not in `sequence`. A static first screen is `none`: no load animation,
  stand-in art included. `holdMs` never includes a cut `frames.load.leadIn` (media arriving). The
  build's load ends no later than `totalMs` (aim slightly early: both load rows run until both settle).
  The warm reload can show a returning-visitor variant of the hero that differs from the first-visit
  fold shot: design from the fold and full shots, take timing from the load data.
- `navScroll` (`spacing.nav.onScroll`; `atTop` from `ref-fold.png`, `scrolled` from `ref-scrolled.png`,
  since the band and full sheets may show the nav in its scrolled state):
  `{kind: changes/hides/none, evidence, pos, atTop{bg, h, items}, scrolled{bg, h, shadow, border, blur, items}, afterPx, transition, byViewport{vp}}`.
  A nav that scrolls away, or stays pinned unchanged, is `none` (with `pos`).
- `ambient` (`motion.ambient.items[]`, `activity` on kind `media` items only, else judged from the
  frames; `loops[]`, infinite `cssAnimations[]`):
  `{kind: loops/none, evidence, items[{target, motion, activity, amplitude, periodMs, easing, phase, n}]}`:
  floating or drifting objects (also those that drift with scroll), widget loops, gradients, marquees.
- `heroMedia` (`motion.load.media`, video and `media` items in `motion.ambient`, the sheets):
  `{kind: video/canvas/lottie/art/drift/none, evidence, box, activity, character, standIn}`: hero or
  feature media that plays or moves; `art` = a composite illustration of CSS-keyframe pieces. Motion
  inside a media or art box belongs here, never in `ambient` as a marquee, loop or auto-advance. `character` describes motion, tempo and tone ("slow push-in on
  a dark, high-contrast interior, heavy vignette under the copy", "particles drifting upward");
  `standIn` is the moving replacement (motion-patterns §media). Not "added motion".

## §motion
`motion[]`: one entry per distinct pattern, each citing its capture path or frames; no entry without
evidence. Reveals are the `motion.reveals` groups; one shorter than ~100 ms is a `judged[]` entry,
not a `motion[]` entry (motion-patterns §reveal). A page tint (`motion.scrollTint.colors[]` entry
with no band `bg.scrollTheme`) is a `pattern: "theme"` entry, `params{triggerBand, color, rest,
bandTop, ms, scrub, rangePx, states, shape}` copied from that entry (motion-patterns §theme). It is timed
(an observer line plus a transition) unless `scrub` is true; `triggerAt: null` does not make it a scrub.
`states` = the band's colour `before` (full shot, scroll 0) / `entering` / `centred`; `shape: "flash on
entry"` = changed only while its top edge is in view, back to `before` when centred.
| field | content |
|---|---|
| `name`, `pattern` | `reveal-up-stagger`, `hero-load`, ...; pattern: `reveal / load / stagger / sticky / pin / parallax / horizontal / marquee / loop / ambient / media / carousel / smooth-scroll / cursor / snap / counter / text-split / clip-reveal / scroll-linked / nav-scroll / theme / hover` |
| `targets` | what animates, in build terms, and how many (inner content, never a band's background) |
| `from`, `to`, `ms`, `easing`, `delay`, `stagger`, `staggerScope`, `trigger` | as measured (`staggerScope`: `row` or `group`) |
| `params`, `impl`, `from_capture`, `reduced` | pattern parameters; `css-transition+io` / `css-animation` / `gsap-scrolltrigger` / `css-sticky` / `raf` / `lenis`; the evidence path; what reduced motion does |

## §misc
- `responsive`: `{breakpoints{tablet, desktop}, nav{vp}, notes[]}`. Breakpoints are two `min-width`
  values with `390 < tablet <= 768 < desktop <= 1440` (default 768 / 1024) so each measured width
  has its own range; the same two numbers everywhere. `nav{vp}`: what the header shows per width.
- `substitutions[]`: `{kind: font/image/logo/icon/media/widget/motion/band, ref, use, why, slot?}`:
  every font, replaced image or video, logo, widget, approximated motion; photo stand-ins add
  `slot: {file, aspect, minSize}`, which becomes the photo request in the report.
- `invented[]`: `{band, field, text, placeholder}` for all copy not supplied by the user.
- `judged[]`: §rules.

## §example
Optional. Fragments for an invented reference rebuilt for a fictional swim school; all values are
made up, never copy them.
```json
{ "fonts": [ { "slot": "serif", "ref": "Merrow Display", "use": "Source Serif 4", "source": "google", "weights": "300..600",
               "match": { "h1": { "weight": 340, "letterSpacingEm": -0.012, "fontSize": 64, "sizeAdjust": 1.0, "class": "serif", "score": 0.83 } }, "axes": {} } ],
  "bands[1].media": { "place": "right", "kind": "video", "frac": 0.48, "moves": true,
                      "standIn": "photographic SVG still of goggles and a kickboard on a pool edge, slow push-in" },
  "bands[1].resp.768": { "layout": "one column: text, then media full width", "align": "left", "order": "media below text",
                         "hidden": [], "items": null, "peek": null, "accordion": [], "stack": [], "artClear": "art below text",
                         "gaps": [24, 40], "gapAbove": 0, "inset": 32, "notes": null },
  "motionCore.heroMedia": { "kind": "video", "evidence": "motion.load.media: hero video playing; fold sheet", "box": "right column, 4:5",
                            "activity": "low", "character": "slow drift across a still interior", "standIn": "SVG still, 24 s push-in loop" } }
```

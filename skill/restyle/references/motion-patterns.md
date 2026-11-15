# Motion patterns

> **When you need this:** SKILL.md step 3 (reading the strips), step 5 (`motionCore`, `motion[]`),
> step 6 (implementing them) and any motion or hover fix. Read §rules once, then only the recipes
> that `motionCore` and `motion[]` name. Field meanings are in capture-schema.md; this file says what
> they mean for the build. **Sections** (`Grep "^## §"` gives line numbers): §rules · §read the
> capture and the strips · §load staging and timing · §media moving stand-ins · §reveal · §nav ·
> §ambient loops, floating objects · §hover · §theme scroll-theme bands, page tint · §sticky ·
> §scroller carousels, snap rows, marquees · §reduced · §checklist · optional: §easing · §scrub ·
> §horizontal · §text · §counter · §smooth · §cursor

## §rules
- **Only what the reference has.** Every moving thing traces to a capture path or frame and a
  `motion[]` entry. Static after first paint means static, stand-in art included; added motion costs
  as much as missing motion.
- **Moving media is not added motion.** Hero or feature media that plays or moves in the reference
  (`motionCore.heroMedia`: `motion.load.media[]` of any kind, `art` = a composite illustration of
  CSS-keyframe pieces included; video and `media` items in `motion.ambient`) gets a stand-in that visibly
  moves inside the same box at about the reference's activity and tempo, any implementation (§media).
  Motion inside a media or art box is that box's activity, never a marquee, loop or auto-advance.
- **Reveals animate content, never the band,** and only where the capture found one
  (`motion.reveals`, §reveal). Band backgrounds, borders and layout boxes are painted from first paint; nothing may be
  blank mid-scroll (a band showing an empty or white area while its content fades in is a defect).
- **Hover parity per component** (§hover): the same changes as the reference's hover pairs, child
  changes included, and no hover effect the reference lacks.
- **Load timing** (§load): first visible content, hold and order within about 15% of the reference's,
  the end never later (aim slightly early), clocked from DOMContentLoaded, never from font arrival.
- **Step or ease, as the strips show** (`appear` on `motion.frames.load`, on each load group and on each
  reveal strip's `content`): `step` = the content appears complete within one or two frames (network or
  lazy arrival, an instant switch): build it with **no transition at all** (§load `ld-step`, §reveal
  `rv-step`); `fade` / `slide` = ease it in over the strip's `ms`. When a measured duration, start or
  trigger disagrees with what the strip shows (the digest says DISAGREES), the strip wins.
- **Not design (third-party behaviour):** popups, region or language modals, cookie and privacy bars,
  chat launchers, loading placeholders and spinners, poster fade-outs, ads, embeds and the layout
  shifts they cause. Never reproduce them; a compare finding about them is an artefact (review §compare).
- **Exact numbers:** durations, easings, delays, staggers, distances and speeds from the capture.
  CSS transitions and animations for reveals and loads; GSAP + ScrollTrigger only for scrubbed,
  pinned or timeline sequences. Everything degrades under reduced motion (§reduced).
- **main.js** starts with the load clock (§load) and the shared head
  `const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; const $$ = (s, r = document) => [...r.querySelectorAll(s)];`
  that every recipe uses; each feature is guarded so a missing element never throws.

## §read
| capture (the digest names the paths) | spec field / recipe |
|---|---|
| `motion.load`, `motion.frames.load.visual`, the load strip | `motionCore.load`, §load |
| `motion.load.media[]` (`kind` incl. `art` and `panel` = a UI mock-up or card stack, `activity` (+ `intermittent`), `rate` = share of the box changing per second, `motion` = how it moves, `withLoad`, `when`), `motion.ambient.items[]` (`activity` on kind `media` only) | `motionCore.heroMedia` and `ambient`, §media, §ambient |
| `spacing.nav.onScroll`, the scrolled sheet | `motionCore.navScroll`, §nav |
| `motion.reveals.summary` and `groups[]` (band, element, count, `ys`, from, ms, easing, stagger, trigger, `triggerHow`, `skip`), `motion.frames.reveals[].content` | `motion[]` reveals, §reveal |
| `sections[].bg.scrollTheme` `{rest, centred}`, `motion.scrollTint`, reveal strips where a band's colour changes | `bands[].bg.scrollTheme`; a tint with no band `scrollTheme`: a `motion[]` `theme` entry (spec-schema §motion); §theme |
| `hover[]`, `components.*.hover`, the hover pairs | `components.*.hover` and `kids`, §hover |
| `motion.transitions[]` | `tokens.motion`; verbatim on properties that visibly change (hover, reveal, load, nav scrolled state); `noop` groups are never required |
| `sticky[]`, `parallax[]`, `scrollLinked[]`, `marquees[]`, `horizontal[]`, `scrollSnap[]`, `smoothScroll`, `cursor` | §sticky, §scrub, §scroller, §horizontal, §smooth, §cursor |
Reading rules:
- `source` `css-transition` / `css-animation` / `waapi`: `ms`, `easing`, `delay` are exact. `js
  (frame-sampled)`: `ms` is fitted; map `nearest` through §easing.
- Ignore: groups with `ms` <= 20 and `sampledMs: null` (instant snaps); custom-property-only
  keyframes (state detectors); small always-fixed widgets in `sticky[]`; a load group that fades an
  element to `opacity: 0` (a poster swapped for media). A load group on a marquee element is the
  marquee. Reveal groups marked `skip` (a load-driven fade the reveal strip shows already in place).
  `trigger` is used as measured within 0.5..2 (§reveal); above 1 means the reveal fires before the
  element enters. A strip that disagrees with a measured `ms` or `trigger` wins (§rules).
- `staggerHow: "sampled start times (per row)"`: the index restarts per visual row. Keep reveals at
  768/390 when `byViewport.revealCount` shows the reference keeps them.

**Strips.** Load frames: a warm-cache reload at 12 fps (frame k at about k x 83 ms), 5 s from first
contentful paint; `frames.load.settleMs` = when the first screen stopped changing (the settled frame is
outlined green). A `frames.load.leadIn` (hero media still arriving, no load animation) may be cut from
the start of the row (the row note says so): network, never a designed blank hold to copy. Reveal
strips start at the wheel input; one extra strip (`why: 'scroll tint'`) may cross the first page-colour
change. Hover pairs show rest and hovered. Write
the timeline before building (`0 ms page colour and nav | 500 headline fading up | 850 photo | 1450 at
rest; hero video playing throughout`): how long the page stays empty, what comes first, what keeps
moving at rest, which band changes colour where.

## §load
Plug in `motionCore.load`: `holdMs`, `firstVisibleMs`, `sequence[]` (`atMs` from first paint), `totalMs`.
CSS holds the from-states until the load clock starts; `main.js` starts it at DOMContentLoaded,
waiting at most 250 ms for web fonts; the head's 3 s failsafe (build-rules §skeleton) starts it if
`main.js` never runs.
```css
@keyframes ld-in { from { opacity: var(--ld-o, 0); filter: blur(var(--ld-blur, 0px));
  transform: translate(var(--ld-x, 0px), var(--ld-y, 0px)) scale(var(--ld-s, 1)); } }
@keyframes ld-step { from { opacity: 0; } }          /* a step: hidden until --ld-at, then there at once */
.js:not(.ld-go) .ld { opacity: 0; }
.ld-go:not(.ld-done) .ld { animation: ld-in var(--ld-ms, 600ms) var(--ld-ease, ease) both;
             animation-delay: max(0ms, calc(var(--ld-at, 0ms) - var(--ld-t0, 0ms))); }
.ld-go:not(.ld-done) .ld.ld-step { animation: ld-step 1ms steps(1, end) both;
             animation-delay: max(0ms, calc(var(--ld-at, 0ms) - var(--ld-t0, 0ms))); }
```
```js
(function loadClock() {                      // main.js, first lines
  const LD_END_MS = 4000;                    // >= the last --ld-at + --ld-ms (motionCore.load totalMs + holdMs) + 300
  const go = () => { document.documentElement.classList.add('ld-go');
    setTimeout(() => document.documentElement.classList.add('ld-done'), LD_END_MS); };
  const begin = () => Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(),
    new Promise((r) => setTimeout(r, 250))]).then(go);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin); else begin();
})();
```
```html
<h1 class="t-h1 ld" style="--ld-at:850ms; --ld-ms:700ms; --ld-ease:cubic-bezier(0.25,0.1,0.25,1); --ld-y:12px; --ld-blur:8px">...</h1>
<div class="hero__media ld" style="--ld-at:1170ms; --ld-ms:900ms; --ld-ease:cubic-bezier(0.16,1,0.3,1); --ld-s:1.04">...</div>
```
- The blank hold is design: the hero starts when the reference's does. What the reference shows
  from frame 0 (page colour, band backgrounds, usually the nav) has no `ld` class.
- **Step vs fade:** `motion.frames.load.appear` (the first screen) and each group's `appear` say how the
  strip shows it arriving. `kind: "step"` (complete within one or two frames, often blank and then
  complete) gets `ld ld-step` with `--ld-at` = its `atMs`: no fade, slide or blur, whatever the group's
  sampled `ms` says; compare charges a build that eases in where A steps. `fade` / `slide`: `ld-in` with
  `--ld-ms` = the strip's `ms` when the group's `ms` disagrees (the strip wins), `slide` with its `y`.
- `ld-done` ends every load animation once the sequence is over, so an element that toggles
  `display: none` (a responsive show/hide, a resize during capture) never restarts it and is never caught
  invisible in a later screenshot. Keep `LD_END_MS` after the last element's end.
- After a full capture, compare the two load strips: when the build's first visible content is d ms
  late (or early), raise (or lower) `--ld-t0` on `:root` by d; change individual `--ld-at` only to fix
  order or gaps; still late with zero delays: shorten the font wait. Within about 15% overall, and
  at rest no later than the reference's: both load rows run until both settle, so a late build shows
  frames still changing where A's green frame is at rest. `holdMs` never includes a cut lead-in.
- A logo that moves during load gets its own keyframes with the measured start and end. Icons that
  pop in one after another step `--ld-at` by index (`calc(1200ms + var(--i) * 60ms)`), with a small
  scale from-state when the frames show growth.
- `kind: "none"`: no `ld` class anywhere and no art that animates on load.
- `ld-in` sets `transform` (fill `both`, so also at rest): it replaces a `transform: scale()` or
  rotate set on the same element. Put `ld` on a wrapper.

## §media
What matters for a `motionCore.heroMedia` stand-in: it **visibly moves inside its box at about the
reference's activity level and tempo** (`activity`; how far things move between strip frames, how
often the picture changes), in every strip where A's media moves, in the same box (aspect, crop,
radius, scrim) with the same character and tone. Any implementation (CSS, canvas, JS); decorative,
stopped under reduced motion, one `substitutions[]` entry; a pause control A shows pauses it. The
table and recipes are starting points: tune speed until both strips show similar change.
- **Match the kind first, then the rate.** `motion` says how A's media moves: `in-place` (items change,
  turn or scale where they are), `lateral` (content slides across the box; `dir`, `pxPerSec`), `cut`
  (cuts or cross-fades, a card stack cycling), `drift` (the whole picture pans or zooms slowly). A
  sideways track for items that turn in place is a different motion whatever its rate. `withLoad: true`
  = the box arrives with the load staging (`appearsMs`): stage the stand-in in, never paint it moving
  at first paint; `false` = it is there from first paint.
- **Target = the measured number.** `motion.load.media[i].activity` is the level of `rate` alone, the
  share of the box that changes per second on the settled page (static < 0.4% <= low < 4% <= medium <
  40% <= high); `intermittent` = it changes in bursts (a cursor hopping, a stack cycling): animate
  the stand-in in bursts too, never leave it still. Done needs the build's box at A's level and near
  A's `rate`. `inspect.mjs activity <url>` (or `--box x,y,w,h`) runs the capture's own measure in
  ~10 s; use it before spending a full capture.
- **Measure twice; tune with travel.** `rate` from an oscillating change (a hue cycle, an opacity
  pulse, a back-and-forth sway) depends on the phase the sample window catches and jumps between
  runs (a turnaround reads near static, mid-swing reads high). Travelling motion (shapes or bands
  moving across the box, a continuous pan) gives a steady `rate` that scales with speed and tunes
  predictably until things move further than their own size within a second (then `rate` stays put;
  `pxPerSec` of a `lateral` / `drift` box still shows the speed). Run `inspect.mjs activity` twice; if
  the two readings differ by more than about half, replace the oscillation with travel.
- **What registers:** large areas changing luminance, hue or position every frame: several big
  shapes travelling across the whole box on 6-12 s loops, a canvas noise or flow field, a ribbon whose
  bands sweep and morph across most of the box, footage stand-ins cross-fading scenes every 2-5 s with
  each scene panning. For `high` nearly every pixel must change within a second (continuous pan or
  zoom of a detailed still plus cuts).
- **Typical mistakes:** a subtle drift (a few % over 20-60 s), an opacity shimmer, a slow push-in of a
  soft low-contrast image, tiny elements moving, motion only near the edges of the box: each reads
  `low` or `static` however busy the code is.
- **No other detector trips** when every moving layer sits inside the media box element and runs on
  time (CSS/JS loops), never on scroll position: layers, a track sliding across it, cycling states or
  cards in the box count only as media activity, never as a marquee, auto-advance, load group,
  scroll-linked, parallax or colour gradient. An HTML/CSS mock-up stand-in is a media box like an image.
Media that keeps moving in A (footage, a flowing gradient, looping art) loops for as long as the page
is open: an entrance morph that settles after a second or two reads as static. Give it A's tone too:
footage is dark, contrasted and varied, never a flat wash of one colour.
| reference media | stand-in |
|---|---|
| calm film or ambient video (`low`) | photographic still (build-rules §imagery) with a push-in or pan: scale 1 -> 1.06-1.1 plus a translate over 8-15 s, alternating; check `rate` reaches A's |
| lively video (`medium`/`high`: people, cuts, camera moves) | 3-4 stills of the user's subject cross-fading every 2-5 s (1.5-3 s for `high`), each panning or zooming continuously so its pixels move between strip frames |
| canvas or WebGL gradient, ribbon, wave | 2-4 large gradient shapes or ribbon bands (build-rules §imagery) travelling across most of the box while shifting hue, on 6-12 s loops |
| particles, network lines, dot globe | the canvas loop below, or SVG dots drifting at the reference's density and speed |
| Lottie, SVG or keyframe-piece (`art`) illustration loop | the user's illustration with the same kind of loop (bob, wobble, a rotating part), period from the frames |
| objects that float or drift as you scroll | parallax at the measured rates (§scrub) plus a gentle float (§ambient) |
```css
@keyframes push-in { to { transform: scale(var(--pi-s, 1.08)) translate3d(var(--pi-x, -1.5%), var(--pi-y, -1%), 0); } }
.media-move { overflow: clip; }
.media-move > :is(img, svg) { animation: push-in var(--pi-ms, 24s) ease-in-out infinite alternate; transform-origin: 60% 40%; }
@keyframes seq { 0%, 30% { opacity: 0; } 36%, 64% { opacity: 1; } 70%, 100% { opacity: 0; } }
.media-seq { position: relative; overflow: clip; }                       /* first child: the base still, static */
.media-seq > :not(:first-child) { position: absolute; inset: 0; animation: seq var(--seq-ms, 15s) linear infinite both; }
.media-seq > :nth-child(3) { animation-delay: calc(var(--seq-ms, 15s) / 3); }
```
Particles or lines: a `<canvas aria-hidden="true">` sized to its box x `devicePixelRatio`, N dots or
strokes in the reference's colours moved each `requestAnimationFrame`, wrapped at the edges; under
reduced motion draw one frame and stop.

**Headline that changes tint where it crosses the art** (A's headline reads dark on the page and
light, or blended, where the hero art passes behind it). Without this the headline simply sits above
the art in one colour. Two overlaid copies of the same text, the second clipped to the art's area:
```html
<h1 class="t-display tint-h"><span class="tint-h__base">Headline</span>
  <span class="tint-h__over" aria-hidden="true">Headline</span></h1>
```
```css
.tint-h { position: relative; }
.tint-h__over { position: absolute; inset: 0; color: var(--on-art);
  clip-path: polygon(62% 0, 100% 0, 100% 100%, 48% 100%); }   /* the art's edge across the headline */
```
When the art moves, clip with the same shape and animation as the art (a shared `--art-x` driving
both), or use `mix-blend-mode: difference` / `overlay` on one copy when A's colours invert like a
blend. Both copies wrap identically (same font, width, `white-space`), the copy is `aria-hidden`.

## §reveal
Plug in per `motion[]` reveal: `from` (opacity, y, x, scale, blur), `ms`, `easing`, `delay`,
`stagger`, `staggerScope`, `trigger`.
```css
.js .rv { opacity: var(--rv-o, 0); transform: translate(var(--rv-x, 0px), var(--rv-y, 0px)) scale(var(--rv-s, 1));
  transition: opacity var(--rv-ms) var(--rv-ease), transform var(--rv-ms) var(--rv-ease);
  transition-delay: calc(var(--i, 0) * var(--rv-stagger, 0ms) + var(--rv-delay, 0ms)); }
.js .rv.is-in { opacity: 1; transform: none; }
.js .rv.rv-blur { filter: blur(var(--rv-blur, 8px)); transition-property: opacity, transform, filter; }
.js .rv.rv-blur.is-in { filter: none; }
.js .rv.rv-step { transform: none; transition: none; }   /* a step: hidden, then there at once */
.reveal-up { --rv-ms: 900ms; --rv-ease: cubic-bezier(0.19, 1, 0.22, 1); --rv-y: 32px; --rv-stagger: 90ms; }
```
Transition only what the reference's `from` changes: a pure fade drops `transform` from both rules,
`.rv-blur` only when the frames show a blur.
```js
function initReveals() {
  const els = $$('.rv');
  if (reduce) { els.forEach((e) => e.classList.add('is-in')); return; }
  $$('[data-stagger]').forEach((g) => { let top = null, i = 0;
    $$(':scope > .rv, :scope > * > .rv', g).forEach((k) => {
      if (g.dataset.stagger === 'row' && k.offsetTop !== top) { top = k.offsetTop; i = 0; }
      k.style.setProperty('--i', i++); }); });
  // each element's line = trigger x viewport height from the top (0.5..2). Anything whose top is above its
  // line is revealed, on load and on every scroll: also when one scroll step (or a jump) carried it past
  // the line or above the viewport, and everything in view once the page bottom is reached
  let todo = els.map((e) => ({ e, t: Math.min(2, Math.max(0.5, parseFloat(e.closest('[data-trigger]')?.dataset.trigger || '1'))) }));
  const check = () => {
    const vh = innerHeight, end = scrollY + vh >= document.documentElement.scrollHeight - 2;
    todo = todo.filter(({ e, t }) => { const top = e.getBoundingClientRect().top;
      if (top < vh * t || (end && top < vh)) { e.classList.add('is-in'); return false; } return true; });
    if (!todo.length) { removeEventListener('scroll', on); removeEventListener('resize', on); }
  };
  let raf = 0; const on = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; check(); }); };
  addEventListener('scroll', on, { passive: true }); addEventListener('resize', on); check();
}
initReveals();
```
```html
<div class="cards reveal-up" data-stagger="row" data-trigger="0.83">
  <div class="rv"><article class="card">...</article></div> <div class="rv"><article class="card">...</article></div>
</div>
```
- **Which reveals to build:** the groups in `motion.reveals` that are not marked `skip` (compare
  counts those; `skip` = a fade the pass saw start only after the scroll stopped, e.g. when a lazy
  image arrived, that the reveal strip of the same step shows already in place: record it in
  `judged[]`, build nothing). A group with `appear: "step"` (hidden, then there at once) is built `rv rv-step`.
  First-viewport content never gets `.rv`; what the first screen stages belongs to §load.
- **Which elements:** `.rv` goes only on the group's members, at their page positions (`ys`, document
  px of each member's top) and of the same kind and number (cards, an image, a heading group), inside
  the band: never on a `<section>`, its background or a box that sets the band's size. Content of the
  same band that is not in a group (often the first row of a grid that was already in place) gets
  no `.rv`. When A's band arrives painted and only an inner element animates, reveal only that.
- **Trigger, as measured, within 0.5..2:** `data-trigger` = the group's `trigger` (viewport fraction of
  the members' top when their change began), no delay; the recipe clamps it to 0.5..2. The line is
  `trigger` x the viewport height down from the top: 0.83 fires when the top crosses 83% of the
  viewport; 1.19 fires 19% below the bottom edge, so the reveal runs before the element is seen. Never
  round a value above 1 down to 1.0 (that makes an invisible reveal visible). A measured value below 0.5
  comes from a rest position or a late arrival, never a design line, and would leave the band blank
  while it crosses the upper half: the clamp builds it at 0.5; match the strip's timing instead.
  `triggerHow: "rest"` (with `afterScrollMs`): the change began after the scroll had stopped, so
  `trigger` is where the element rested; building it at that line fires it at the end of the same
  step, which is the earliest the reference could have. `triggerHow: "strip"`: its strip showed it firing
  at rest lower in the viewport, so `trigger` is that line. `offscreen: true`: it began and ended below
  the viewport; its `trigger` is above 1 and the build's reveal must also finish out of view.
- **The strip wins over measured numbers.** `motion.frames.reveals[].content.appear`: `kind: "step"`
  (complete within one or two frames after the scroll stops, often a lazy arrival) = the group gets
  `rv rv-step`: no fade, slide or delay, whatever its sampled `ms`; `fade` / `slide` = the strip's `ms`
  (and `y`) when the group's `ms` disagrees (the digest says DISAGREES, e.g. a sampled 1250 ms that the
  strip shows as ~170 ms), and its from-state: a `fade` strip = opacity only, even when the group's `from`
  has a translate (the digest says DISAGREES). Compare charges a build that eases in where A's strip
  steps, steps where it eases, or slides where it fades in place (or the reverse).
- **The strips decide what is seen.** `motion.frames.reveals[].content` (and the group's
  `inStrip`): `inPlace: true` = A's content in view was in place within one frame of the scroll
  stopping, so in B's strip of the same step nothing in view may fade or move after the scroll stops.
  `lagMs` = how long A's content kept visibly changing after the scroll stopped; B's must not be
  more than ~200 ms later (compare `revealTiming`). A reveal already finished in A's first strip
  frame fired before the wheel step: match it with `trigger`, never with a delay.
- **Reveal plus hover on one element:** one `transition` replaces the other, so `.rv` goes on a
  wrapper (above) and the card keeps its own hover transition; never two transforms on one element.
- `data-stagger="row"` restarts the index per row, `"group"` does not. Clip or split-text: §text.

## §nav
From `motionCore.navScroll`. A nav that scrolls away, or stays pinned without change, needs nothing.
```js
const nav = document.querySelector('[data-nav]');
if (nav) { let lastY = scrollY; const AFTER = 80, HIDES = false;   // afterPx; hides on scroll down?
  const on = () => { const y = scrollY; nav.classList.toggle('is-scrolled', y > AFTER);
    if (HIDES) nav.classList.toggle('is-hidden', y > lastY && y > nav.offsetHeight); lastY = y; };
  addEventListener('scroll', on, { passive: true }); on(); }
```
```css
.nav { position: sticky; top: 0; z-index: 50; transition: background-color 200ms ease, box-shadow 200ms ease, transform 300ms ease; }
.nav.is-scrolled { background-color: var(--page-bg); box-shadow: 0 1px 0 var(--border); min-height: 64px; }
.nav__cta { display: none; } .nav.is-scrolled .nav__cta { display: inline-flex; }   /* items that appear when scrolled */
.nav.is-hidden { transform: translateY(-100%); }
```
Use the nav's captured transitions; follow `byViewport` (a CTA kept at 768, dropped at 390); check
the scrolled sheet at each width.
- **Pinned is what the scrolled shot shows:** a bar still at the top of `<vp>-scrolled.png`
  (`onScroll.shot.pinned`) stays in view whatever its computed position; `posCss` (e.g. `relative`) next
  to `pos` means the pinned bar sits inside an in-flow wrapper: build one `position: sticky` header.
- **A line under the bar** (`changes.line`: a hairline or shadow the scrolled shot shows and the rest
  shot does not; or `scrollDriven`, a scroll-driven animation on the bar) goes in `.is-scrolled`
  (`box-shadow: 0 1px 0 <its colour>`); it is the header's scrolled state, never a scroll-scrubbed effect.

## §ambient
One loop per `motionCore.ambient.items` entry, with its period and amplitude (from `cssAnimations[]`,
`keyframes{}`, `loops[]` or how far it moves across the strip frames) and its `activity`: a low-activity
item moves slowly and little, a high-activity one visibly in every frame. Visible movement at that
activity and tempo is what counts; the keyframes below are one way to get it. An `auto-advance` with
`how: "swap"` (`carousels.autoAdvance`) changes state without moving: a word swapping in a headline,
step chips or tabs lighting up in turn, a feed gaining a row; swap at its `periodMs`.
```css
@keyframes float { 50% { transform: translate3d(0, var(--fl-y, -10px), 0) rotate(var(--fl-r, 0deg)); } }
@keyframes drift { 50% { transform: translate3d(4%, -3%, 0) scale(1.06); } }
@keyframes spin  { to { transform: rotate(360deg); } }
.amb-float { animation: float var(--fl-ms, 4000ms) ease-in-out infinite; animation-delay: var(--fl-phase, 0ms); }
.loop-drift { animation: drift var(--dr-ms, 40s) ease-in-out infinite; }
.loop-spin  { animation: spin var(--sp-ms, 20s) linear infinite; }
```
Floating objects get different negative phases so they never move in unison. A looping widget (a
ring refilling, a bubble typing) gets the same kind of loop. Nothing moves when `ambient.kind` is `none`.

## §hover
Per component kind (primary and secondary button, card, nav link, text link, footer link, image
link), take the reference's hover pair and `hover[]` entry and build exactly those changes: `self`
deltas, pseudo-element deltas, child deltas (`kids`) and the transition string verbatim. Transform
deltas `{tx, ty, s, r}` become `translate(<tx>px, <ty>px) scale(<s>) rotate(<r>deg)`.
- **Child changes count:** an arrow nudging, an icon filling, a chevron turning into an arrow:
  ```html
  <svg class="arw" viewBox="0 0 12 10" aria-hidden="true"><path class="arw__stem" d="M1 5h8"/><path class="arw__head" d="M5 1.5 8.5 5 5 8.5"/></svg>
  ```
  ```css
  .arw { width: 12px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.5; }
  .arw__stem { opacity: 0; transition: opacity 150ms var(--ease-ui); }
  .arw__head { transform: translateX(-3px); transition: transform 150ms var(--ease-ui); }
  :hover > .arw .arw__stem { opacity: 1; } :hover > .arw .arw__head { transform: none; }
  ```
- **The same treatment, not a similar one:** a link that dims in A dims in B (the measured opacity or
  colour), never an underline instead; an underline keeps A's thickness, offset and how it appears.
- **No hover the reference lacks:** a component kind whose reference pair shows no change gets none
  (no added underline, lift or zoom); keep `:focus-visible` styles regardless.
- **As visible as A's pair:** the digest's hover line says what A's crops visibly do (`visible on hover:
  lightens / darkens / recolours or moves`, or `no visible change`). B's pair of the same kind must show
  a change that is as visible (a 15% lighter fill, not a 2% one); compare charges a missing visible change
  even when the hover data match.

## §theme
A band whose capture has `sections[].bg.scrollTheme` changes colour as it scrolls into view: build
it as a scroll-driven theme change with two states, `rest` (its static CSS) and `centred`. Page tints
(`motion.scrollTint`: the body colour shifting while a band is in view) work the same way.
- **Timed, not scrubbed.** A tint or theme is a transition fired when a scroll position is crossed
  (an IntersectionObserver line, then a CSS transition of `ms`) unless the entry says `scrub: true`;
  only then does the colour follow the scroll (§scrub). `triggerAt: null` means the start was not
  measured, never that it scrubs: compare charges a scrub the reference lacks.
- **What the full-page shot shows:** every band as it looks at scroll 0, i.e. before you scroll to
  it. A tinted band's colour in the full shot is its `before` state, not how it looks in view.
- **States** (`scrollTint.colors[].states`, digest "tint" lines): `before` (full shot), `entering`
  (colour at the rest where it was seen, with the band's top edge `bandTop` down the viewport) and
  `centred` (band centred, page settled), plus `shape`: `flash on entry` = before colour, the
  entering colour while its top edge is in view, the before colour again when centred (build: the
  state class on while the top edge is between the viewport bottom and a line U, U = midway between
  `entering.bandTop` and `centred.top`: observe a 1 px sentinel at the band's top with `rootMargin:
  '-U% 0px 0px 0px'`, U in %); `changed while in view` = the two-state switch below.
Copy the measured timing (`scrollTint.colors[]`, `bg.scrollTheme`; compare scores start point and
timing): the change starts when `triggerBand`'s top is `bandTop` down the viewport (observer line T
= `bandTop` x 100), then a timed fade of `ms`. The centre line and 600 ms below are only the
fallback when `triggerAt` is null (then place the lines from `states` and the strips, `judged`). A
page-tint layer fading is not a scroll reveal: never build it as `.rv` on a container (it counts as
an extra reveal). Text colours follow through custom properties, so nothing goes unreadable
mid-change.
```css
.b6 { background-color: var(--b6-bg); color: var(--b6-fg); transition: background-color 600ms ease, color 600ms ease; }
.b6 { --b6-bg: var(--band-tint); --b6-fg: var(--text); }           /* scrollTheme.rest */
.b6.is-themed { --b6-bg: var(--dark-bg); --b6-fg: var(--on-dark); } /* scrollTheme.centred */
```
```js
const themed = $$('[data-theme-switch]');
if (themed.length && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((ents) => ents.forEach((en) => {
    en.target.classList.toggle('is-themed', en.isIntersecting);
    if (en.target.dataset.tint) document.body.dataset.tint = en.isIntersecting ? en.target.dataset.tint : '';
  }), { rootMargin: '-50% 0px -50% 0px' });   // active while it covers the line T% down: '-T% 0px -(100-T)% 0px'
  themed.forEach((el) => io.observe(el));
}
```
Mark each such band `data-theme-switch`. Page tint: `data-tint="sky"` on the trigger band, `body {
transition: background-color 600ms ease; } body[data-tint="sky"] { background-color: var(--tint-sky);
}`, bands between the trigger points transparent. Reduced motion keeps the change, not the transition.

## §sticky
```css
.b6 .pin-wrap { height: calc(100vh + 1800px); }   /* held for 1800 px: range[1] - range[0] */
.b6 .pin { position: sticky; top: 0; height: 100vh; }
```
Prefer CSS sticky (a side column: build-rules §feeds); GSAP `pin` only when the pinned panel also
runs a scrubbed timeline (§scrub). Reduced motion keeps sticky positioning, drops scrubbed changes.

## §scroller
**Snap rows and carousels** (`horizontal[]` scrollers, `scrollSnap[]`, `cards.overflow`):
```css
.scroller { --n: 1; --peek: 48px; --gap: 16px;               /* override per breakpoint, never remove */
  display: flex; gap: var(--gap); overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none;
  overscroll-behavior-x: contain; padding-inline: var(--inset); scroll-padding-inline: var(--inset); }
.scroller > * { flex: 0 0 calc((100% - var(--peek) - (var(--n) - 1) * var(--gap)) / var(--n)); scroll-snap-align: start; }
```
`--n` whole cards plus `--peek` px of the next, per `resp.items` and `resp.peek` (`--peek: 0px` when
A's row fits exactly). An undefined variable in that `flex` shorthand drops the whole declaration and
the cards shrink to their content. Arrows scroll by one card (`scrollBy({ left: ±(cardWidth + gap),
behavior: 'smooth' })`); at rest no item sits half under an arrow, no label is cut mid-word.
Auto-advance only with evidence (`carousels.autoAdvance[]`, `autoAdvanceCandidates` or a slide change
in the frames): step every `autoAdvance[].periodMs` (8 s watch; the period is scored); with no measured
period keep a slow default (about 8 s), `judged`. Pause on hover and focus, never under reduced
motion. Fewer items than A: spec-schema §content.

**Marquees** (`marquees[]`: `pxPerSec`, `dir`, `axis`):
```html
<div class="marquee" style="--marquee-pps: 30" data-dir="left"><div class="marquee__track">
  <ul class="marquee__set">...</ul><ul class="marquee__set" aria-hidden="true">...same items...</ul></div></div>
```
```css
.marquee { overflow: clip; }
.marquee__track { display: flex; width: max-content; animation: marquee var(--marquee-dur, 30s) linear infinite; }
.marquee__set { display: flex; gap: 96px; padding-inline-end: 96px; }
.marquee[data-dir="right"] .marquee__track { animation-direction: reverse; }
@keyframes marquee { to { transform: translateX(-50%); } }
```
```js
$$('.marquee').forEach((m) => { const t = m.querySelector('.marquee__track');
  const pps = parseFloat(getComputedStyle(m).getPropertyValue('--marquee-pps')) || 30;
  const set = () => t.style.setProperty('--marquee-dur', `${t.scrollWidth / 2 / pps}s`); set(); addEventListener('resize', set); });
```
Vertical: `flex-direction: column` and `translateY(-50%)`. Edge fades only if the sheet shows them.

## §reduced
```css
@media (prefers-reduced-motion: reduce) {
  .js .rv, .js .rv-clip, .js .w__in { opacity: 1 !important; transform: none !important; filter: none !important;
                                     clip-path: none !important; transition: none !important; }
  .js .ld { opacity: 1 !important; animation: none !important; }
  .amb-float, [class*="loop-"], .marquee__track, .media-move > *, .media-seq > * { animation: none !important; }
  .media-seq > :not(:first-child) { opacity: 0 !important; }
  [data-theme-switch], body, .odo__d > span { transition: none !important; }
  html { scroll-behavior: auto !important; }
}
```
JavaScript checks `reduce` before canvas loops, parallax, Lenis, cursor followers, counters, carousel
autoplay and GSAP scrubs (`gsap.matchMedia()` with `(prefers-reduced-motion: no-preference)`).

## §checklist
- [ ] `motionCore.load`, `.navScroll`, `.ambient` and `.heroMedia` implemented as specified or provably absent.
- [ ] Load: inline page colours, clock from DOMContentLoaded with the 250 ms font wait and the 3 s
      failsafe; first visible, hold and order within ~15% of the reference's strip, the end no
      later; nothing visible from frame 0 that the reference stages later.
- [ ] Moving media visibly moves in its box at the reference's activity, tempo, character and tone: `inspect.mjs activity` gives A's level and a `rate` near A's.
- [ ] Reveals only where `motion.reveals` has them, on inner content, the reference's targets, count and
      changed properties; none in the first viewport; no band blank mid-scroll; no overwritten transitions.
- [ ] Each reveal strip: B's content in view is in place when A's is (`content.inPlace` / `lagMs`; no
      fade where A's strip is already in place); `skip` groups not built; `data-trigger` as measured
      (0.5..2). Where A's load or reveal strip steps (`appear.kind: "step"`), B has no transition there.
- [ ] Hover changes per component match the hover pairs exactly, children included; none added.
- [ ] Nav scrolled state per width; scroll-theme `bandTop` and `ms` (or scrub); marquee speed; auto-advance period; sticky and parallax.
- [ ] Libraries only if used, pinned, before `main.js`; `main.js` guards every feature; reduced
      motion block and JS checks present.

## §easing
Optional. Copy a captured CSS easing verbatim when there is one; otherwise map `nearest` / `family`:
| capture | CSS | GSAP |
|---|---|---|
| `linear` | `linear` | `none` |
| `ease` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | `power1.inOut` |
| `ease-in` / `ease-out` / `ease-in-out` | `cubic-bezier(0.42, 0, 1, 1)` / `cubic-bezier(0, 0, 0.58, 1)` / `cubic-bezier(0.42, 0, 0.58, 1)` | `power1.in` / `.out` / `.inOut` |
| `out-quad` / `out-cubic` / `out-quart` / `out-quint` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` / `(0.215, 0.61, 0.355, 1)` / `(0.165, 0.84, 0.44, 1)` / `(0.23, 1, 0.32, 1)` | `power1.out` / `power2.out` / `power3.out` / `power4.out` |
| `out-expo` / `out-circ` / `out-sine` | `cubic-bezier(0.19, 1, 0.22, 1)` / `(0.075, 0.82, 0.165, 1)` / `(0.39, 0.575, 0.565, 1)` | `expo.out` / `circ.out` / `sine.out` |
| `in-out-cubic` / `in-out-quart` / `in-out-expo` / `in-out-sine` | `cubic-bezier(0.645, 0.045, 0.355, 1)` / `(0.77, 0, 0.175, 1)` / `(1, 0, 0, 1)` / `(0.445, 0.05, 0.55, 0.95)` | `power2.inOut` / `power3.inOut` / `expo.inOut` / `sine.inOut` |
| `spring-like` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | `back.out(1.7)` |
| `steps` | `steps(n)` as captured | `steps(n)` |

## §scrub
Optional. **Scroll-linked** (`reveals.scrollLinked[]`, `scrollTimeline` hits, strips that change
continuously while scrolling): GSAP with `scrub: true` (a numeric scrub adds lag; only when the
reference lags), or CSS `animation-timeline: view()` inside `@supports` with a static fallback.
```js
if (window.gsap && window.ScrollTrigger && !reduce) { gsap.registerPlugin(ScrollTrigger);
  gsap.fromTo('.b7 .ribbon', { yPercent: 10 }, { yPercent: -10, ease: 'none',
    scrollTrigger: { trigger: '.b7', start: 'top bottom', end: 'bottom top', scrub: true } }); }
```
**Parallax** (`parallax[].rate`: 0.7 = moves at 70% of scroll speed): `data-rate` elements only.
```js
const px = $$('[data-rate]');
if (px.length && !reduce) { let busy = false;
  const update = () => { for (const el of px) { const box = el.parentElement.getBoundingClientRect();
      el.style.transform = `translate3d(0, ${((innerHeight - box.top) * (1 - parseFloat(el.dataset.rate))).toFixed(1)}px, 0)`; }
    busy = false; };
  addEventListener('scroll', () => { if (!busy) { busy = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener('resize', update); update(); }
```
`background-attachment: fixed` in the capture: the same CSS (rate 0), except on narrow screens.

## §horizontal
Optional. `horizontal[]` with `rateX`: a section whose height is `innerHeight + (track.scrollWidth -
innerWidth) / |rateX|` holds a `position: sticky; top: 0; height: 100vh; overflow: clip` box; on scroll
the flex track inside translates by `-progress * (scrollWidth - innerWidth)`, progress = how far the
section has scrolled past the top / (its height - innerHeight). Where the reference stacks the cards,
and under reduced motion, the track wraps or scrolls natively. `overflow-x` scrollers: §scroller.

## §text
Optional. **Split by word** (groups of `span` with `n` near the word count, 20-80 ms stagger): a
script wraps each word in `<span class="w" aria-hidden="true" style="--i:<k>"><span class="w__in">`
and puts the full text in `aria-label` on the heading, before `initReveals()`;
`.w { display: inline-block; overflow: clip; } .js .w__in { display: inline-block; transform:
translateY(110%); transition: transform <ms> <easing> calc(var(--i) * <stagger>); } .is-in .w__in {
transform: none; }`. Lines: one authored `<span class="line">` per line. **Clip reveals**
(`from.clipVisible` < 1): `.js .rv-clip { clip-path: inset(0 0 100% 0); transition: clip-path <ms>
<easing>; } .js .rv-clip.is-in { clip-path: inset(0); }`, direction from the frames, same observer.

## §counter
Optional. Count-ups only when frames show digits changing: the final value is in the HTML; an
IntersectionObserver counts from 0 with the captured duration and an ease-out, skipped under reduced
motion. Digit roll (span groups moving one line height): each digit a clipped column of 0-9
(`.odo__d { display: inline-block; height: 1lh; overflow: clip; }`) translated by `calc(var(--d) * -1lh)`
with the captured duration and stagger; the real value stays in `aria-label`.

## §smooth
Optional. Only if `smoothScroll.library` is set or `detected` with `t90Ms >= 450`; Lenis stands in
(record it): `https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js` plus its CSS,
`new Lenis({ lerp: clamp(2.3 / (60 * t90Ms / 1000), 0.04, 0.2) })` driven by `requestAnimationFrame`
(with GSAP: by `gsap.ticker`, calling `ScrollTrigger.update` on scroll); not under reduced motion.

## §cursor
Optional. Only if `cursor.followers` is non-empty; fine pointers only: a fixed dot of the captured
size and blend mode, eased towards the pointer each frame (factor about 0.18), hidden on touch.

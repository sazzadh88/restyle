// All weights and tolerances used by compare.mjs, in one place.
// Every formula that uses them is documented in references/scoring.md.
//
// Tolerance pairs are [full, zero]: an error <= full scores 1, an error >= zero scores 0,
// linear in between (see lin() in cmp-util.mjs).

export const AREA_WEIGHTS = { layout: 25, color: 20, type: 20, motion: 20, responsive: 15 };

// Viewport heights used by capture.mjs (only widths are stored in capture.json).
export const VP_HEIGHT = { 1440: 900, 768: 1024, 390: 844 };
export const PRIMARY_VP = '1440';
export const NARROW_VPS = ['768', '390'];

// A check whose reference AND build both lack a feature (e.g. no marquee on either side)
// still counts (absence agrees), but at this fraction of its weight: agreement on absence
// is weaker evidence of the same design than agreement on a present feature.
export const BOTH_ABSENT_WEIGHT = 0.5;

// Finding severity by points lost on the 0-10 total.
export const SEVERITY = { high: 0.15, medium: 0.05 };
export const MAX_FINDINGS = 30;

// ---------------------------------------------------------------- layout (25)
export const LAYOUT = {
  weights: {
    sequence: 18, bandHeight: 10, bandBg: 12, columns: 9, cards: 8, align: 5, media: 6,
    padding: 8, container: 6, gutter: 3, navPosition: 6, navStyle: 5, pageLength: 4, shape: 6, spacing: 4,
  },
  spacingRel: [0.2, 0.75],         // |a-b| / max(a, 8) for the modal gap and heading-to-text distance
  // Band alignment (Needleman-Wunsch). Pair value = sim - PAIR_OFFSET; gap = -GAP. Bands are matched
  // mainly by order, relative height, background, column structure and media placement; the coarse
  // role class (hero / content / footer) is a weak term and the fine role label only a tie-breaker.
  align: { pairOffset: 0.5, gap: 0.3, wCoarse: 0.12, wRole: 0.03, wHeight: 0.25, wBg: 0.25, wCols: 0.15, wMedia: 0.1, wPos: 0.1 },
  // A run of 2..maxRun adjacent bands on one side may align with one band on the other (a composite band
  // segmented differently, e.g. a long stack cut into row strips at a narrow width) at no cost, when the
  // run covers the same page span and content as the single band (cmp-layout runMatches):
  // - the summed height is within heightLog (|ln|) of the single band AND fits it better than the tallest
  //   member alone by >= gain (or within tight when the tallest member alone already fits): merging must
  //   explain height the single band absorbed, so a band that is really missing (the other side not taller
  //   for it) is never swallowed; when the other members are a sliver (together <= sliver.share of the run
  //   and <= sliver.vh viewport heights, a thin bar cut off the band) the height test alone is enough;
  // - the tallest member has the single band's light/dark tone and solid background (bgDeltaE); members of
  //   the other tone cover <= offTone of the run (a thin dark strip cut out of a light band);
  // - the run's middle is within posFrac of the page height of the single band's middle;
  // - where both sides carry content counts (headings, media, buttons): the run's summed counts fit the
  //   single band's no worse than the tallest member's alone, within content (mean |ln((a+1)/(b+1))|).
  // n:m units (runs of 2..maxBoth on both sides) need the same span (heightLog, tops/bottoms within
  // posFrac), the same tone rule on each side, counts within contentAbs, and inner cuts that do not line
  // up (each inner cut of one run >= cutOff of the span from every inner cut of the other).
  merge: { maxRun: 8, heightLog: 0.2, bgDeltaE: 0.1, gain: 0.05, tight: 0.05, sliver: { share: 0.06, vh: 0.12 }, offTone: 0.2, posFrac: 0.2, content: 0.35, maxBoth: 3, contentAbs: 0.5, cutOff: 0.15 },
  // Padding measured from text, not the box: a band whose top + bottom pad leave < cover of its height for
  // content while it carries large non-background media (left/right/above/below/center/full-bleed, frac >=
  // frac when measured) must have that media inside its "pad" (absolutely placed art the capture does not
  // count), so the pad is unreliable on that side; its pad item counts at w x its usual weight.
  padWeak: { cover: 0.25, frac: 0.1, w: 0.35 },
  // Heading-to-text distances below minPx (a heading box overlapping its text) are not measurements of a
  // visible gap and are not scored. A running-text edge measured from <= 1 band on either side (textBands)
  // counts at textWeak x its usual weight.
  stackMinPx: 4, textWeak: 0.35,
  // Per-pair weight = clamp(ref band vh, min, max): taller bands matter more.
  pairWeight: { min: 0.35, max: 2.5 },
  heightLog: [0.15, 0.7],          // |ln(build vh / ref vh)|
  bgDeltaE: [0.03, 0.2],           // OKLab distance of band background colours
  bgParts: { type: 0.3, color: 0.4, tone: 0.3 },   // type category, colour, light/dark tone
  ratiosL1: [0.05, 0.3],           // sum |ratio_i - ratio_i'| / 2 for equal column counts
  colsDiff: [1, 0.5, 0.2, 0],      // score for |cols diff| = 0, 1, 2, >=3
  cardColsDiff: [1, 0.4, 0, 0],
  cardParts: { cols: 0.6, count: 0.25, like: 0.15 },
  cardsOnlyInBuild: 0.5,           // build has a card grid where the reference band has none
  padRel: [0.15, 0.6],             // |a-b| / max(a, padFloor)
  padFloor: 48,
  containerRel: [0.03, 0.2],
  gutterPx: [8, 60],
  // A centred running-text column: text edges symmetric about the viewport centre (within
  // max(symPx, 1% of the width)) and inset >= insetPx from the rail on both sides (no rail: narrower than
  // maxShare of the viewport). Its left edge follows from its width, so two centred columns are compared
  // by half their width difference (same px tolerance as the left edge), never as container padding.
  centredText: { symPx: 8, insetPx: 24, maxShare: 0.6 },
  navHeightRel: [0.08, 0.4],
  // transparent vs solid nav: same look when the transparent side's nav band pixels (bg.sampled, share >= share)
  // are within deltaE of the solid side's opaque nav colour and the nav is not over hero media
  navSeen: { share: 0.6, deltaE: 0.03 },
  // columns: a side's main row in a band >= vh viewports tall covering < cover of its height (unmeasured:
  // weak at 1440 only) is the largest of many rows; when every side with a row has such a weak one, the
  // item counts at w x its usual weight
  colsTall: { vh: 2, cover: 0.4, w: 0.3 },
  pageLengthLog: [0.2, 0.9],       // |ln(build page vh / ref page vh)|
  radiusRel: [0.15, 0.7],          // |a-b| / max(a, b, 4)
  buttonHeightRel: [0.08, 0.4],
};

// Role closeness for band alignment; key = two roles sorted, joined by '|'.
export const ROLE_CLOSE = {
  'features|other': 0.7, 'article-list|gallery': 0.7, 'features|gallery': 0.6,
  'article-list|features': 0.6, 'article-list|other': 0.6, 'features|stats': 0.5,
  'cta|other': 0.5, 'gallery|other': 0.5, 'other|stats': 0.5, 'other|testimonial': 0.5,
  'features|testimonial': 0.45, 'logos|other': 0.45, 'features|pricing': 0.45,
  'other|pricing': 0.45, 'cta|features': 0.35, 'hero|other': 0.3, 'footer|other': 0.3,
  'cta|testimonial': 0.3, 'stats|testimonial': 0.3, 'logos|stats': 0.3,
};
export const ROLE_DEFAULT = 0.15;
// Coarse role classes: the only role information that is scored (sequence check).
export const COARSE = (role) => (role === 'hero' ? 'hero' : role === 'footer' ? 'footer' : role === 'nav' ? 'nav' : 'content');
export const COARSE_CLOSE = { 'content|hero': 0.3, 'content|footer': 0.3, 'footer|hero': 0 };

export const ROLE_HINT = {
  hero: 'the first band, >= 30% of the viewport tall, holding the h1',
  logos: 'a row of >= 4 small logo marks with little text',
  features: 'a heading with >= 3 repeated cards, or a heading with media',
  stats: '>= 3 large numerals with labels',
  testimonial: 'a quote (blockquote) with attribution',
  pricing: 'price cards with a billing period',
  'article-list': '>= 3 repeated items each with a sizeable image and text',
  gallery: 'a band of mostly images',
  cta: 'a short band near the end with a large heading and 1-4 buttons',
  footer: 'a <footer> with link columns',
  other: 'a plain content band',
};

// ---------------------------------------------------------------- color (20)
export const COLOR = {
  roleWeights: { pageBg: 10, text: 9, accent: 10, surface: 5, mutedText: 4, border: 2.5, accent2: 3 },
  roleDeltaE: [0.02, 0.15],
  // roles scored as groups with the best assignment between the two sides (a swapped pair counts
  // swapPenalty less than a direct match): the two accents, and surface/border
  roleGroups: [['accent', 'accent2'], ['surface', 'border']],
  swapPenalty: 0.1,
  weights: { theme: 8, palette: 18, gradients: 8, minor: 10 },
  minorDeltaE: [0.03, 0.12],       // nearest build colour (palette + minor) to each reference minor colour
  // a reference minor colour is required only when it is used: on >= tagN tag/icon elements or >= textN text
  // elements, or painting >= share of the page's text glyph area (colors.minor[].share); a status or sale
  // colour on a few small elements is not a design colour the build must carry
  minorRequire: { tagN: 3, textN: 4, share: 0.02 },
  weakRoleFactor: 0.5,             // a reference role marked WEAK (colors.weak: split or thin evidence) weighs this much
  paletteShareFloor: 0.004,        // every palette entry counts at least this share
  paletteLoudness: 3,              // entry weight x (1 + loudness x OKLCH chroma)
  paletteDist: [0.012, 0.07],      // mean of the two share-weighted nearest distances
  gradient: {
    parts: { presence: 0.4, area: 0.2, where: 0.2, hue: 0.2 },
    areaLog: [0.3, 1.6],           // |ln((a+0.01)/(b+0.01))|
    hueDeg: [15, 60],
    visibleStopDeltaE: 0.08,       // two opaque-ish stops this far apart = a visible gradient
    visibleAlpha: 0.15,
    visibleAlphaSpan: 0.3,         // or a fade whose alpha changes this much
    // band gradients: visible as colour once its stops are composited over its band's background (else the
    // page background) when two composited stops are >= compositeDeltaE apart (a fade of that colour to
    // transparent is not); not an overlay on media (onMedia), not a thin strip (thin), and painting
    // >= bandShare of its bands' area (>= pageShare of the page without a band). Gradient text and gradient
    // buttons only need to be visible.
    compositeDeltaE: 0.06, bandShare: 0.04, pageShare: 0.004,
    chromaMin: 0.04,
    // a reference band whose pixels are not its CSS colour by more than this (bg.sampled vs bg.color) is
    // painted by something else (canvas, image): build CSS gradients over its aligned band are art stand-ins
    artSampledDeltaE: 0.1,
    // A gradient one side draws in CSS and the other ships as an image (a gradient wordmark, a canvas
    // wash): a CSS gradient with >= 2 chromatic stops (alpha >= stopAlpha, hues >= minHueSpan apart) that
    // the other side has no visible CSS gradient for in the aligned band counts as present on that side
    // when every chromatic stop colour covers >= minShare of the aligned band's pixels in its full
    // screenshot (within stopDeltaE, sampled every sampleStep px).
    image: { stopAlpha: 0.5, minHueSpan: 25, stopDeltaE: 0.06, minShare: 0.0005, sampleStep: 2 },
  },
};

// ---------------------------------------------------------------- type (20)
export const TYPE = {
  roleWeights: { h1: 3, display: 1.5, h2: 2.5, h3: 1.5, body: 3, small: 1, nav: 1, button: 1.5, eyebrow: 1 },
  weights: { size: 28, weight: 24, ink: 24, lineHeight: 10, letterSpacing: 7, transform: 6, category: 8, width: 6, xHeight: 4, pairing: 5, scale: 10, coverage: 10 },
  sizeRel: [0.04, 0.25],
  weightSteps: [20, 150],          // |rendered weight diff| (nearest loaded face; synthesised bold counts +300)
  inkRel: [0.06, 0.35],            // role ink (visual heaviness of the role's font as drawn), relative error
  widthAdvRel: [0.04, 0.15],       // family advance width per em, relative error
  xHeightRel: [0.04, 0.15],        // family x-height / em, relative error
  widthClassAdjacent: 0.4,         // condensed~normal or normal~extended
  lineHeightRel: [0.06, 0.35],
  normalLineHeight: 1.2,
  letterSpacingEm: [0.006, 0.05],
  scaleRel: [0.05, 0.3],           // role/body ratio, relative error
  displayCategoryVsSans: 0.8,
  extraRolePenalty: 0.5,           // build role absent in the reference counts half against coverage
  // Heading roles (display/h1/h2/h3) are visual size tiers. When the two sides do not have the same set
  // of heading roles, the tiers are paired by aligning the two size-sorted lists (Needleman-Wunsch,
  // pair value = lin(size rel. error, tierSizeRel) - pairOffset, gap = -gap), so a tier labelled by a
  // different tag on one side is compared with its size twin instead of reading as missing + extra.
  tierSizeRel: [0.04, 0.25],
  tierAlign: { pairOffset: 0.3, gap: 0.3 },
};

// ---------------------------------------------------------------- motion (20)
export const MOTION = {
  // Signature motions (load staging, the header's scrolled state, ambient motion) carry enough weight
  // that missing one costs about 1.5 area points.
  weights: {
    revealPresence: 10, revealFrom: 5, revealDuration: 5, revealEasing: 3, revealStagger: 3,
    load: 18, navScroll: 14, ambient: 14, heroMedia: 22, transitions: 8, hover: 10, sticky: 4, parallax: 4, marquee: 3,
    autoAdvance: 3, smoothScroll: 4, scrollLinked: 4, scrollTint: 5, revealTiming: 8,
  },
  // Reveal strips (build captured --frames-like, both strips with content measures): the build's content
  // visibly in place later than the reference's by more than lateMs[0] ms (lin to 0 at lateMs[1]); where the
  // reference's strip is in place (nothing animates), the build's lag after the scroll stops lin over
  // staticLagMs. A 0 costs about half a motion point. Appearance (strips' `appear`): where the reference's
  // content arrives in one step (one or two frames) and the build's eases in, lin(build visible ms, easedMs);
  // the load strip is one more pair weighing loadPairWeight reveal pairs.
  revealTiming: { lateMs: [200, 700], staticLagMs: [100, 400], easedMs: [200, 600], loadPairWeight: 2 },
  // reveal from-state per strip pair where both strips ease in: distance (px) between the half-way offsets
  // (x, y; 0 for a fade in place), lin to 0: a fade vs a 30 px half-way slide, or another axis, costs it all
  revealFromStripPx: [8, 30],
  // a step-reveal group whose elements together cover less than this share of the 1440x900 first screen (a
  // carousel arrow turning visible) is not counted as a reveal on either side
  minorStepShare: 0.005,
  // a page scroll tint whose colour change is below this OKLab distance from the colour before it is not a
  // visible tint and is dropped on both sides before scrollTint is scored
  tintMinDe: 0.02,
  load: {
    parts: { duration: 0.3, delay: 0.2, order: 0.25, from: 0.25 }, delayMs: [100, 600], minSignificance: 0.35, visualSignificance: 0.6,
    // Captures with motion.load.summary.staged use it. Older captures are re-filtered with the same skip
    // rules: groups that end invisible (fade-outs, e.g. a poster fading out over a video), popups/overlays
    // (by element name), and groups smaller than tinyShare of the viewport are dropped; what is left counts
    // as a staged load only when it animates >= stagedMinShare of the first viewport.
    fadeOutOpacity: 0.05, fadeOutDrop: 0.3, tinyShare: 0.003, stagedMinShare: 0.05,
    overlayRe: /overlay|modal|popup|pop-up|dialog|cookie|consent|newsletter|backdrop|lightbox|toast|gdpr|region-?select/i,
  },
  // Hero media in the first viewport (motion.load.media): reference media that moves (activity >= low,
  // on load or continuously) needs a moving stand-in of the same activity, any kind. The build's box over
  // the reference's moving box is compared: score = min(level part, rate part). Level part: same level or
  // livelier by one = 1, livelier by two = twoLevels, by three = threeLevels; calmer by 1/2/3 levels =
  // lower[1/2/3]. Rate part (both captures measured `rate`, the share of the box changing per second):
  // lin(ln(ref rate / build rate), rateLog) when the build is calmer, else 1 (rates floored at rateFloor).
  // Weight = heroMedia x significance, significance = clamp(base + perArea x visible box share of the
  // first viewport, base, 1); both static = agreement at absentShare x BOTH_ABSENT_WEIGHT (the same 4.2
  // before halving as in round 4, so pages without moving media are not lifted). With weight 22 a
  // first-screen hero two levels calmer (low vs high) costs > 1 motion point on any page. Rates are compared
  // like with like (frames.mjs mediaRate: continuous vs continuous). When both captures measured how the
  // media moves (`motion`: in-place / lateral / cut / drift) and the kinds differ, the score x kindMismatch;
  // cut vs in-place only when clear on both sides: the cut side changes in <= cutClear[0] of the consecutive
  // frame pairs (`active`) and the in-place side in >= cutClear[1] (a cross-fade's kind flips with its
  // duration in between).
  heroMedia: { base: 0.5, perArea: 2, absentShare: 0.19, twoLevels: 0.5, threeLevels: 0.2, lower: [1, 0.55, 0.2, 0.05], rateLog: [0.35, 2.3], rateFloor: 0.001, kindMismatch: 0.6, cutClear: [0.3, 0.8] },
  // Page background tint seen at scroll rests (motion.scrollTint): presence of tint changes, then
  // 0.4 count + 0.6 colour (mean nearest dE of the tint colours, both directions). When both sides measured
  // where the changes start and how long they take (colors[].bandTop / .ms), that timing is timing.part of
  // the check: 0.6 trigger (band top as a viewport fraction, abs diff) + 0.4 duration (abs ms, or both
  // scroll-scrubbed), per reference change paired with the build change of the nearest colour.
  scrollTint: { parts: { count: 0.4, color: 0.6 }, countLog: [0.3, 1.2], colorDeltaE: [0.03, 0.15],
    timing: { part: 0.3, parts: { trigger: 0.6, ms: 0.4 }, bandTopAbs: [0.1, 0.4], msAbs: [150, 700] } },
  // auto-advance period (motion.carousels.autoAdvance[].periodMs, both sides): |ln(pb/pa)|
  autoAdvancePeriodLog: [0.2, 0.9],
  navScroll: { parts: { pinned: 0.5, changes: 0.3, height: 0.2 } },
  ambient: { parts: { count: 0.4, bands: 0.3, kinds: 0.3 }, countLog: [0.3, 1.2], bandShareAbs: [0.1, 0.5] },
  countLog: [0.35, 1.6],           // |ln((nb+1)/(na+1))|
  durationLog: [0.15, 0.9],
  loadDurationLog: [0.25, 1.2],
  transitionDurationLog: [0.2, 1.0],
  staggerLog: [0.25, 1.2],
  staggerMinMs: 30,                // smaller staggers are treated as none (frame-sampling jitter)
  staggerOneSided: 0.3,            // stagger on one side only
  translateRel: [0.25, 1.0],       // |dy| / max(|ref y|, 8)
  opacityAbs: [0.1, 0.5],
  scaleAbs: [0.02, 0.15],
  parallaxRate: [0.05, 0.3],
  marqueeSpeedLog: [0.25, 1.2],
  loopsLog: [0.3, 1.5],
  revealTransitionMatch: 0.12,     // transitions on opacity/transform within 12% of the reveal ms are the reveal
  extraCategoryShare: 0.15,        // build transition category absent in ref with >= this share of elements
  // hover data vs crops: when they disagree on either side (motion.frames.hover[].visual.changed >= 0.005 =
  // a visible change), a kind is judged on the crops: one side changes visibly and the other not = 0, both
  // still = 1, both change = lin(|ln((a + 0.01) / (b + 0.01))|, hoverCropLog) on the changed shares
  hoverCropLog: [0.5, 2],
  hoverKindWeights: {
    'primary-button': 3, 'secondary-button': 2, card: 2, 'nav-link': 1.5, 'text-link': 1,
    button: 1, 'footer-link': 0.5, 'image-link': 1,
  },
  stickyParts: { header: 0.6, other: 0.4 },
  easingSim: {
    'ease-out|ease-in-out': 0.5, 'ease-in|ease-in-out': 0.5, 'ease-in|ease-out': 0.2,
    'ease-out|spring-like': 0.5, 'ease-in-out|spring-like': 0.3, 'ease-out|linear': 0.2,
    'ease-in-out|linear': 0.3, 'ease-in|linear': 0.3,
  },
};

// ---------------------------------------------------------------- responsive (15)
export const RESPONSIVE = {
  weights: { heights: 5, columns: 6, padding: 4, sequence: 3, type: 8, container: 3, nav: 3, pageLength: 2, align: 3, spacing: 2, hidden: 3, marquee: 1 },
  peekPart: 0.25,                  // share of a band's column item that is the carousel peek (overflow) match
  heightLog: [0.2, 0.8],
  gutterPx: [4, 24],
  contentRel: [0.04, 0.2],
  overflowPenalty: 2.0,            // area points per viewport where the build scrolls sideways
  clippedPenalty: 1.0,             // area points per viewport where the build cuts text at the viewport edge (reference cuts none)
  consoleErrorPenalty: 1.0,        // area points if the build logs errors the reference does not
  consoleErrorPenaltyMany: 2.0,    // ... and >= 3 more errors than allowed
};

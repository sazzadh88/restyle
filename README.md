# restyle

`restyle` is a skill for Claude Code. You give it the URL of a website whose design you like and the
details of your own business; it builds a new static site (HTML, CSS and a little JavaScript) that
carries the reference's design language (layout and band rhythm, colour, typography, spacing,
component styling, hover states, load and scroll motion, responsive behaviour) around your content.
It measures the reference in a headless Chrome, builds, measures its own build the same way, compares
the two and fixes the differences before it hands the site over.

What it will not do:
- It never copies the reference's logo, brand name, copy, photos, illustrations, icons or font files,
  and never hotlinks from the reference's domains.
- It builds the home page only (one `index.html` following the reference page's sections). If you
  give a sub-page URL, that page is the reference. Extra pages are built only when you ask.
- Photos and illustrations you do not supply are original SVG or CSS stand-ins in the reference's
  treatment, not real images.

## Requirements
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
- Node 20 or newer (developed on Node 26). The scripts depend on `playwright-core` 1.65, which
  requires Node 20.
- Google Chrome installed. The scripts drive it through `playwright-core` with `channel: 'chrome'`;
  no browser is ever downloaded.

## Install
Clone the repository, copy `skill/restyle` into your Claude Code skills folder, and install the
scripts' dependencies there once.

### macOS / Linux (bash)

```bash
git clone https://github.com/sazzadh88/restyle.git
```

```bash
cd restyle
```

```bash
mkdir -p ~/.claude/skills/restyle
```

```bash
cp -r skill/restyle/. ~/.claude/skills/restyle/
```

```bash
cd ~/.claude/skills/restyle/scripts
```

```bash
npm install
```

### Windows (PowerShell)

```powershell
git clone https://github.com/sazzadh88/restyle.git
```

```powershell
cd restyle
```

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills\restyle" | Out-Null
```

```powershell
Copy-Item -Recurse -Force skill\restyle\* "$HOME\.claude\skills\restyle\"
```

```powershell
cd "$HOME\.claude\skills\restyle\scripts"
```

```powershell
npm install
```

### Per-project install
To make the skill available in one project only, copy `skill/restyle` to
`<project>/.claude/skills/restyle` instead and run `npm install` in its `scripts/` folder.

### Check it is picked up
Start a new Claude Code session. The skill is listed as `restyle` and can be invoked directly as
`/restyle`; it is also chosen on its own when you ask for a site "like" or "in the style of" a URL.
To check the script dependencies, run this inside the installed `scripts/` folder:

```bash
node -e "Promise.all(['playwright-core','pngjs','pixelmatch','culori'].map(m=>import(m))).then(()=>console.log('deps ok'))"
```

To update the skill later, pull the repository and repeat the copy step.

## Quick start
In a Claude Code session, in the folder where you want the site, give a reference URL and your
business details:

> Build me a website like https://example.com for my business. We are Northfield Bindery, a
> bookbinding and repair studio in Leeds. Tagline: "Old books, made to last another century."
> Services: rebinding (from £120), leather restoration (from £80), custom boxes (from £45).
> Testimonial: "They saved my grandfather's bible." (a customer in Harrogate). Contact: <your
> email>, <your phone>. Footer links: Services, Prices, About, Contact.

The more of your own content you supply, the less is left as marked placeholders:
- business name, what you do, audience and tone
- tagline and headline
- services or products, with prices
- testimonials and figures you can stand behind
- contact details
- footer link groups and any real URLs
- optionally your logo, photos and brand colour

The skill does not invent people, quotes or awards. Where a section of the reference has no matching
content, it writes neutral copy or leaves a marked placeholder and lists it in the final report. A
brand colour replaces the reference's accent only if you ask (colour fidelity drops when you do).

### Prompt template
Copy this, fill in the blanks and paste it into a Claude Code session. Lines marked optional can be
deleted. The minimum is the reference URL, business name, what you do, services and contact details.

```text
Use the restyle skill to build a website for my business in the style of this reference site.

Reference site: https://________

BUSINESS
- Business name: ________
- What we do (1–2 lines): ________
- Who our customers are: ________
- Tagline / main headline: ________
- Tone (e.g. friendly, formal, premium): ________

PAGES
- Pages to build: Home, About, Services, Contact
  (delete the ones you do not need; Home alone is fastest)

SERVICES OR PRODUCTS
1. Name: ________ | Description: ________ | Price (optional): ________
2. Name: ________ | Description: ________ | Price (optional): ________
3. Name: ________ | Description: ________ | Price (optional): ________

ABOUT
- About us (3–5 lines): ________
- Year started / team size / location (optional): ________

PROOF (optional; leave blank if you have none, do not make any up)
- Testimonials (quote + name): ________
- Numbers we can stand behind (clients, projects, years): ________

CONTACT
- Email: ________
- Phone: ________
- Address: ________
- Social links: ________
- Main button text and where it goes (e.g. "Get a quote" -> contact page): ________

ASSETS (optional)
- Logo file path: ________
- Photo folder path: ________
- Brand colour: ________ (leave blank to keep the reference site's colours)

RULES
- Keep the reference's layout, colours, typography and motion, but use only my content above.
- Do not copy the reference's logo, name, text, images or fonts.
- Where I left something blank, use a clearly marked placeholder and list it in the final report.
- Output folder: ./________-site
```

Each extra page adds time; the home page alone takes roughly 25–90 minutes. A brand colour replaces
the reference's accent, so the result looks less like the reference.

## How it works
1. **Capture the reference.** A headless Chrome loads the page at 1440, 768 and 390 px and measures
   bands, colours, type, spacing, components, hover states and load and scroll motion, with
   screenshots and motion frames.
2. **Write a design spec.** Tokens taken from the capture, font substitutes chosen from the Google
   Fonts catalogue, art direction, one entry per band with its tablet and phone layout, motion.
3. **Build** `index.html`, `styles.css`, `type-scale.css`, `main.js` and `assets/` from the spec.
4. **Capture the build** the same way the reference was captured.
5. **Compare** the two captures: a score out of 10 per area and a ranked list of findings.
6. **Review side-by-side sheets** (reference against build) as a strict designer would.
7. **Fix and repeat**, at most 6 full captures (10 captures in all).
8. **Report**: scores, substitutions, placeholders to replace, and the gaps that remain.

## What you get
A folder, by default `./<business-slug>-site`, containing:
- `index.html`, `styles.css`, `type-scale.css`, `main.js`
- `assets/` for images and stand-in art
- `.restyle/`: the work folder (reference capture, design spec, build captures, comparison sheets,
  reviews and scores). It is kept for reference and can be deleted before you publish.

Preview it with the bundled static server (it picks a free port and prints the URL):

```bash
node ~/.claude/skills/restyle/scripts/serve.mjs ./<business-slug>-site
```

Stop it with `node ~/.claude/skills/restyle/scripts/serve.mjs --stop <port>`.

Before publishing:
- **Images.** The final report lists every photo slot with its file name, aspect ratio and minimum
  size. Replace the stand-ins with your own images; on photo-led designs this lifts fidelity most.
- **Links.** Links you gave no URL for are placeholders (`href="#"`, marked `data-placeholder`), as
  are any placeholder text elements. The report lists them all.

## What to expect
- **Time and tokens.** 25–90 minutes and roughly 350–550K tokens per site. Most of it is the verify
  loop.
- **Fonts.** Only families in the public Google Fonts catalogue, or system fonts. A reference's own
  brand typeface is replaced by the closest catalogue match.
- **Motion.** Mostly CSS transitions and animations plus a small `main.js`. GSAP with ScrollTrigger
  (from cdnjs, pinned) is loaded only when the reference has scroll-scrubbed or pinned effects.
- **Limits.** Complex hero animation (video, 3D objects, typed headlines) is approximated, not
  reproduced. Sites that block automated browsers cannot be captured; the skill then stops and offers
  to work from full-page screenshots you supply (about 1440, 768 and 390 px wide), checked visually
  only. Pages that keep a desktop layout at phone width are reproduced that way; ask for a proper
  phone layout if you want one.

## Using the scripts directly
All scripts are in `skill/restyle/scripts/` (or the installed copy). Each prints one JSON line on
success and exits non-zero on failure.

| script | purpose | usage |
|---|---|---|
| `capture.mjs` | Measure a page: `capture.json`, `summary.md` digest, `shots/`, motion frames | `node capture.mjs <url> <outDir> [--viewports 1440,768,390] [--no-motion-frames] [--fast] [--frames-like <refCapDir>] [--timeout 60000]`; `node capture.mjs --wait <outDir> [--timeout-s 600]` |
| `compare.mjs` | Score a build capture against a reference capture: five area scores, total, findings | `node compare.mjs <refCapDir> <buildCapDir> <out.json>` |
| `sheet.mjs` | Contact sheets: reference against build side by side, or reference only | `node sheet.mjs <refCapDir> <buildCapDir> <outDir>`; `node sheet.mjs --ref-only <refCapDir> <outDir>` |
| `inspect.mjs` | Small measuring tools: font matching, colour, crop, overflow, computed style, bands, media activity, one capture value | `node inspect.mjs fontmatch <refCapDir> --role <role> [--candidates "A,B"] [--top 5] [--brief]`; `color <img> <x> <y> [w h]`; `crop <img> <x> <y> <w> <h> <out.png>`; `overflow <url> [width]`; `style <url> <selector> [...] [width]`; `bands <url> [width]`; `activity <url> [--box x,y,w,h]`; `get <capDir> <path> [--depth N]` |
| `type-scale.mjs` | Type scale from a design spec as CSS variables and `.t-<role>` classes | `node type-scale.mjs <design-spec.json> [--out <file.css>]` |
| `serve.mjs` | Static server for a build folder | `node serve.mjs <dir> [port]`; `node serve.mjs --stop <port>` |

`--fast` captures 1440 only, with no motion frames, hover or tablet and phone views; compare marks
its result as partial.

## Results
Each test build is scored out of 10 in five areas (layout, colour, type, motion, responsive). Half
of each area score is measurement (`compare.mjs` on the two captures); the other half is a blind
judge: a separate reviewer pass that sees only the side-by-side sheets and frame strips, never the
code or the spec, and follows `harness/judge-prompt.md`. The pass mark is 8.5.

- 20 tuning sites: all 20 pass, average 8.87.
- 3 holdout sites, never used for tuning: medium 9.43, webflow 8.78, resend 8.71 (average 8.97).

Final scores of the tuning sites (`runs/r9/CHANGES.md`):

| site | score |
|---|---|
| vercel | 9.33 |
| spotify | 9.11 |
| linear | 9.09 |
| aesop | 9.05 |
| duolingo | 9.05 |
| figma | 8.95 |
| stripe | 8.94 |
| theverge | 8.89 |
| mailchimp | 8.85 |
| tailwindcss | 8.84 |
| github | 8.83 |
| notion | 8.81 |
| allbirds | 8.80 |
| pentagram | 8.78 |
| dropbox | 8.78 |
| airbnb | 8.77 |
| shopify | 8.73 |
| framer | 8.65 |
| raycast | 8.63 |
| apple | 8.60 |

Holdout per-area scores are in `runs/holdout/REPORT.md`.

Caveats:
- Each score rests on one judge pass, so sites within about 0.1 of the mark (apple 8.60, raycast
  8.63, framer 8.65) could fall either side on a re-judge.
- Motion is the weakest area: on the holdout sites the judge's motion average is 8.37, the lowest of
  its five areas.
- The test briefs are fictional businesses (`harness/sites.json`). All 23 final builds were scanned
  for the reference brand name and for external hosts: none carries the name, and they load only
  Google Fonts plus, in two builds, a pinned script CDN.

## Test rig
The repository ships the round reports (`runs/<round>/REPORT.md`, `CHANGES.md`), not the builds or
captures behind them; everything else under `runs/` is git-ignored and is created when you run the
rig.

Install at the root:

```bash
npm install
```

Checks (each serves its own fixture from `harness/fixtures/`, captures it into `runs/dev/` and prints
one line per assertion):

| command | checks |
|---|---|
| `node harness/check-chrome.mjs` | installed Chrome launches through `playwright-core` |
| `node harness/check-serve.mjs` | `serve.mjs` port handling and `--stop` |
| `node harness/check-capture.mjs` | `capture.mjs` against pages with known design values (writes `runs/dev/known/ref`, which other checks reuse) |
| `node harness/check-compare.mjs [--reuse] [--only self\|syn\|sens\|fix]` | self-compare scores 10, single-change sensitivity, equivalent markup, synthetic cases; run `check-capture.mjs` first, and for `self` capture `linear` and `stripe` with `node harness/pipeline.mjs ref dev <slug>` |
| `node harness/check-motion.mjs` | motion detection and motion scoring on the motion fixtures |
| `node harness/check-fontmatch.mjs` | `inspect.mjs fontmatch` on synthetic type samples (needs network) |

Scoring a build for one site from `harness/sites.json` (put the build in `runs/<round>/<slug>/build`):

```bash
node harness/pipeline.mjs ref <round> <slug>
```

```bash
node harness/pipeline.mjs eval <round> <slug>
```

`ref` captures the site's reference page into `runs/<round>/<slug>/ref` (the script header explains
`--from` and `--from-build`). `eval` uses the reference snapshot saved in the build's `.restyle/ref`
when there is one, then serves and captures the build, compares it (`diff.json`) and
writes the judge sheets to `runs/<round>/<slug>/sheets/`. The judge's scores go in
`runs/<round>/<slug>/judge.json`, written by the separate reviewer pass in the format
`harness/judge-prompt.md` describes; no script produces it, and without it the score is the
measurement alone. Then:

```bash
node harness/score.mjs runs/<round>/<slug>
```

```bash
node harness/report.mjs runs/<round>
```

`score.mjs` writes `score.json` (0.5 × measurement + 0.5 × judge per area, pass at 8.5 with no
font-health failure); `report.mjs` writes the round's `REPORT.md`.

## Repository layout

```
skill/restyle/        the skill: copy this folder to install it
  SKILL.md            the workflow
  references/         capture schema, spec schema, build rules, motion patterns, fonts, review, scoring
  scripts/            capture, compare, sheet, inspect, type-scale, serve (+ lib/)
harness/              test rig: sites.json, pipeline, score, report, judge prompt, check-*.mjs, fixtures/
docs/                 SPEC.md (design and scoring), USAGE.md (short user guide)
runs/                 round reports (builds and captures are not committed)
filemap.md            one line per file
```

## Responsible use
`restyle` reproduces a design language (structure, rhythm, colour, type, motion), not a brand. Use it
for your own business and your own content. Do not use it to make a site that passes itself off as
the reference site or its owner, and check that the result does not borrow anything that identifies
the reference before you publish.

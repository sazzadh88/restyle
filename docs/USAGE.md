# Using the restyle skill

`restyle` builds a new static site for your business in the design language of a reference website:
its layout rhythm, colours, typography, component styling, hover states, load and scroll motion and
responsive behaviour. It never copies the reference's logo, name, copy, images or font files.

## Install
From a clone of this repository, copy `skill/restyle` to `~/.claude/skills/restyle` (or
`<project>/.claude/skills/restyle` for one project) and run `npm install` once in its `scripts/`
folder. On macOS or Linux, from the repository root:

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

Windows (PowerShell) commands and how to check the skill is picked up are in the
[README's install section](../README.md#install). Repeat the copy step after pulling changes.

Needs Node 20 or newer and Google Chrome installed. No browser is downloaded.

## Ask for a site
In any Claude Code session, give a reference URL and your business information:

> Build me a website like https://example.com for my business. We are <name>, we do <what>.
> Sections: <list>. Contact: <details>.

The more of your own content you give (name, tagline, services, prices, testimonials, contact
details, link groups for the footer), the less the build has to leave as marked placeholders. The
skill does not invent people, quotes or awards.

## What you get
A folder (default `./<business-slug>-site`) with `index.html`, `styles.css`, `type-scale.css`,
`main.js` and `assets/`. Home page only. Motion is CSS transitions and animations plus a small `main.js`; GSAP with ScrollTrigger is loaded only when the reference has scroll-scrubbed or pinned effects. Work files (reference capture,
design spec, comparison sheets, reviews, scores) are in its `.restyle/` folder and can be deleted
before publishing.

Preview it:

```bash
node ~/.claude/skills/restyle/scripts/serve.mjs ./<business-slug>-site
```

## What to expect
- Time and cost: 25–90 minutes and roughly 350–550K tokens per site. Most of it is the verify loop
  (capture the build, compare with the reference, fix, repeat, at most 6 full captures).
- Fonts: only families in the public Google Fonts catalogue or system fonts. A reference's own
  brand typeface is replaced by the closest catalogue match.
- Images: photos and illustrations are original SVG stand-ins. The final report lists every photo
  slot with its aspect ratio and minimum size; replace them with your own images.
- Links are placeholders (`href="#"`, marked `data-placeholder`) unless you supply URLs.
- The build ends with a report: scores per area, remaining differences, and what it needs from you.

## How well it matches
Scored out of 10 as half measurement (layout, colour, type, motion, responsive compared from
captures) and half a blind side-by-side judge. Pass mark 8.5.

- 20 tuning sites: all 20 pass, average 8.87.
- 3 holdout sites never used for tuning: 9.43, 8.78, 8.71.

Each score rests on one judge pass, so sites within about 0.1 of the mark (apple 8.60, raycast 8.63, framer 8.65) could fall either side on a re-judge. All 23 final builds were scanned for the reference brand name and for external hosts: none carries the name, and they load only Google Fonts plus, in two builds, a pinned script CDN.

Weakest area is motion: complex hero animation (video, 3D objects, typed headlines) is approximated,
not reproduced. Photo-led pages lose a little until real photos replace the stand-ins. Pages that
keep a desktop layout at phone width are reproduced that way; say so if you want a proper phone
layout instead.

## Re-running the test rig
See the test rig section of [`README.md`](../README.md#test-rig) for setup and commands. `node harness/pipeline.mjs eval <round> <slug>` captures and compares
a build under `runs/<round>/<slug>/build`; `node harness/score.mjs runs/<round>/<slug>` combines the
metric with `judge.json`; `node harness/report.mjs runs/<round>` writes the round report.

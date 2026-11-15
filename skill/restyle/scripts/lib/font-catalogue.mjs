// font-catalogue.mjs — is a font family in the public Google Fonts catalogue?
//
// The one rule for every font the skill uses or offers: a family is usable only when it is in the public
// Google Fonts catalogue (https://fonts.google.com/metadata/fonts, familyMetadataList) or is a system font
// stack. The css2 API status is NOT a test: it also serves working @font-face rules for families that are
// not in the public catalogue (proprietary brand faces), so a 200 from css2 proves nothing.
//
//   loadCatalogue(cacheDir) -> { source, full, fetched, has(name), verdict(name), note? }
//     source  "google (fetched)" | "google (cached)" | "google (cached, stale)" | "bundled (offline)"
//     full    true when the list is the whole public catalogue (fetched or cached); false for the bundled
//             fallback (lib/google-fonts.json, the fontmatch candidate list: a conservative subset)
//     verdict(name) -> true (in the catalogue) | false (not in it) | null (offline and not in the bundled
//             subset: unknown). A name matches exactly (case and spacing ignored) or, failing that, after
//             removing packaging suffixes (Variable, VF, Pro, Std, Web, weight words): `matchOf(name)` says
//             which catalogue name matched.
//   The list is cached as <cacheDir>/google-fonts-catalogue.json (family names only) and re-fetched when
//   older than 7 days; a stale cache still beats the bundled subset when the network is down.
//   RESTYLE_FONT_CATALOGUE=offline forces the offline path (testing aid).
//   googleCssFamilies(url) -> family names a fonts.googleapis.com css / css2 URL requests.
//   isSystemFamily(name) -> true for generic families and common operating-system fonts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.join(HERE, 'google-fonts.json');
const META_URL = 'https://fonts.google.com/metadata/fonts';
const CACHE_NAME = 'google-fonts-catalogue.json';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export const normFamily = (s) => String(s || '').replace(/["']/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
// packaging suffixes a site adds to a family name when it self-hosts it ("Inter Variable", "Roboto VF")
const SUFFIX = /\s+(variable|var|vf|pro|std|web|webfont|text|display|regular|book|medium|bold|light|thin|black|heavy|semibold|extrabold|extralight)$/i;
function stripped(name) {
  let s = normFamily(name).replace(/(?<=[a-z])(variable|vf)$/i, '');
  for (let i = 0; i < 3 && SUFFIX.test(s); i++) s = s.replace(SUFFIX, '');
  return s;
}

const SYSTEM = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
  'ui-rounded', '-apple-system', 'blinkmacsystemfont', 'emoji', 'math', 'fangsong', 'arial', 'helvetica', 'helvetica neue', 'georgia',
  'times', 'times new roman', 'courier', 'courier new', 'verdana', 'tahoma', 'trebuchet ms', 'segoe ui', 'segoe ui variable', 'sf pro',
  'sf pro text', 'sf pro display', 'sf mono', 'menlo', 'monaco', 'consolas', 'cascadia code', 'apple color emoji', 'segoe ui emoji',
  'noto color emoji', 'segoe ui symbol', 'lucida grande', 'lucida console', 'avenir', 'avenir next', 'optima', 'palatino', 'garamond',
  'impact', 'gill sans', 'baskerville', 'hoefler text', 'calibri', 'cambria', 'candara', 'liberation sans', 'liberation serif',
  'liberation mono', 'dejavu sans', 'dejavu serif', 'dejavu sans mono', 'ubuntu', 'cantarell']);
export const isSystemFamily = (name) => SYSTEM.has(normFamily(name));

export function googleCssFamilies(url) {
  let u; try { u = new URL(url); } catch { return []; }
  if (!/(^|\.)fonts\.googleapis\.com$/i.test(u.hostname) || !/^\/css2?\b/.test(u.pathname)) return [];
  const out = [];
  for (const v of u.searchParams.getAll('family')) {
    // css2: one family per param, "Name:wght@400..700"; css (v1): "A:400,700|B"
    for (const part of (u.pathname.startsWith('/css2') ? [v] : v.split('|'))) {
      const name = part.split(':')[0].replace(/\+/g, ' ').trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

function bundledNames() {
  try { return JSON.parse(fs.readFileSync(BUNDLED, 'utf8')).families.map((e) => e.family); } catch { return []; }
}

async function fetchNames(timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(META_URL, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 restyle-font-catalogue' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = (await r.text()).replace(/^\)\]\}'[^\n]*\n?/, '');   // XSSI prefix, when present
    const j = JSON.parse(text);
    const names = (j.familyMetadataList || []).map((e) => e && e.family).filter(Boolean);
    if (names.length < 500) throw new Error(`catalogue list has only ${names.length} families`);
    return names;
  } finally { clearTimeout(t); }
}

function make(names, source, full, fetched, note) {
  const exact = new Map(names.map((n) => [normFamily(n), n]));
  const loose = new Map();
  for (const n of names) { const k = stripped(n); if (!loose.has(k)) loose.set(k, n); }
  const matchOf = (name) => exact.get(normFamily(name)) || loose.get(stripped(name)) || null;
  const has = (name) => !!matchOf(name);
  return { source, full, fetched, count: names.length, ...(note ? { note } : {}), has, matchOf, verdict: (name) => (has(name) ? true : full ? false : null) };
}

// The web fonts a page loads, with their catalogue verdict (capture type.webFonts): families named in the
// `family=` params of fonts.googleapis.com css/css2 URLs (link, @import or script requests) and @font-face
// rules with a url() source (data: URIs included). local()-only faces (metric fallbacks such as
// "X Fallback" with src local("Georgia")) are not web fonts. faceRules = [{family, src, base?}].
export function webFontsOf({ googleUrls = [], faceRules = [], base = null } = {}, cat) {
  const hostOf = (u, b) => { try { return new URL(u, b || undefined).host; } catch { return null; } };
  const wf = new Map();
  const add = (family, via, host) => {
    const k = normFamily(family); if (!k) return;
    const e = wf.get(k) || { family: String(family).replace(/["']/g, '').trim(), via: [], hosts: [] };
    if (!e.via.includes(via)) e.via.push(via);
    if (host && !e.hosts.includes(host) && e.hosts.length < 3) e.hosts.push(host);
    wf.set(k, e);
  };
  for (const u of new Set(googleUrls)) for (const fam of googleCssFamilies(u)) add(fam, 'google-css', 'fonts.googleapis.com');
  for (const r of faceRules) {
    if (!r || !r.family || !/url\(/i.test(r.src || '')) continue;
    const mm = String(r.src).match(/url\(\s*["']?([^"')]+)/);
    const host = mm ? (mm[1].startsWith('data:') ? 'data-uri' : hostOf(mm[1], r.base || base)) : null;
    add(r.family, /fonts\.gstatic\.com/i.test(host || '') ? 'google-css' : 'font-face', host);
  }
  return { catalogue: cat.source, families: [...wf.values()].slice(0, 20).map((e) => {
    const as = cat.matchOf(e.family);
    return { ...e, inCatalogue: cat.verdict(e.family), ...(as && normFamily(as) !== normFamily(e.family) ? { catalogueAs: as } : {}) };
  }) };
}

const memo = new Map();
export async function loadCatalogue(cacheDir = null, { timeoutMs = 20000 } = {}) {
  const offline = /^offline$/i.test(process.env.RESTYLE_FONT_CATALOGUE || '');
  const key = `${offline ? 'offline|' : ''}${cacheDir ? path.resolve(cacheDir) : ''}`;
  if (memo.has(key)) return memo.get(key);
  const cacheFile = cacheDir ? path.join(cacheDir, CACHE_NAME) : null;
  let cached = null;
  if (cacheFile) { try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (!Array.isArray(cached.families) || cached.families.length < 500) cached = null; } catch { cached = null; } }
  let cat;
  if (!offline && cached && Date.now() - Date.parse(cached.fetched) < MAX_AGE_MS) cat = make(cached.families, 'google (cached)', true, cached.fetched);
  else {
    let err = offline ? 'RESTYLE_FONT_CATALOGUE=offline' : null;
    if (!offline) {
      try {
        const names = await fetchNames(timeoutMs);
        const fetched = new Date().toISOString();
        if (cacheFile) { try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ source: META_URL, fetched, families: names })); } catch { /* read-only dir: no cache */ } }
        cat = make(names, 'google (fetched)', true, fetched);
      } catch (e) { err = String(e && e.message || e); }
    }
    if (!cat && cached && !offline) cat = make(cached.families, 'google (cached, stale)', true, cached.fetched, `catalogue fetch failed (${err}); used the cache from ${cached.fetched}`);
    if (!cat) cat = make(bundledNames(), 'bundled (offline)', false, null, `catalogue not reachable (${err}): checked against the bundled subset (lib/google-fonts.json); a family outside it is unverified, not rejected`);
  }
  memo.set(key, cat);
  return cat;
}

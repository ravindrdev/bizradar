/* scripts/build-vertical-data.js — Phase 1 programmatic SEO data build.

   Merges four existing data sources into seoData/verticals.json:
     - public/coverage-data.json   {name, status}            → the page list (status === 'supported')
     - harness_types.json          {naics6, label, group,
                                    sector_name, naics_title} → NAICS + sector per type
     - verifiedStudies.json        50 cited studies           → per-sector citable stats
     - sectorCommonProblems.json   per-profile complaint
                                    themes                    → "what the report checks for"
   naicsRouter.lookupProfileId(naics6) bridges NAICS-6 → profile_id for the
   problems registry.

   Run:  node scripts/build-vertical-data.js
   Out:  seoData/verticals.json  (committed - read by seoPages.js at boot)

   Deterministic: no Date.now() in page-visible content; `generated` is the
   build date used as sitemap lastmod. Re-run whenever coverage-data or the
   study/problem registries change. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const coverage = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'coverage-data.json'), 'utf8'));
const harness = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness_types.json'), 'utf8'));
const studiesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'verifiedStudies.json'), 'utf8'));
const problemsFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'sectorCommonProblems.json'), 'utf8'));
const naicsRouter = require(path.join(ROOT, 'naicsRouter.js'));

// ── harness lookup: label → entry (naics_title as fallback key) ──────
const byLabel = new Map();
for (const h of harness) {
  if (h && h.label && !byLabel.has(h.label)) byLabel.set(h.label, h);
  if (h && h.naics_title && !byLabel.has(h.naics_title)) byLabel.set(h.naics_title, h);
}

// ── studies: id → slim record; per-group id lists + cross fallback ───
const studyById = {};
const studyIdsByGroup = {};
const crossPool = [];
for (const s of studiesFile.studies) {
  studyById[s.id] = { claim: s.claim, citation: s.citation, url: s.url || null, year: s.year || null };
  const key = String(s.sector_naics2 || '');
  if (key.startsWith('cross')) crossPool.push(s.id);
  else (studyIdsByGroup[key] = studyIdsByGroup[key] || []).push(s.id);
}

// ── problems: profile_id → slim {sector_label, themes[{name, fix}]} ──
const problems = {};
for (const pid of Object.keys(problemsFile)) {
  if (pid.startsWith('_')) continue;
  const p = problemsFile[pid];
  if (!p || !Array.isArray(p.themes)) continue;
  problems[pid] = {
    sector_label: p.sector_label || '',
    themes: p.themes.slice(0, 6).map((t) => ({ name: t.name, fix: t.fix_direction || '' })),
  };
}

// ── slugify + dedupe ─────────────────────────────────────────────────
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

const seenSlugs = new Set();
const verticals = [];
const unmatched = [];

for (const entry of coverage) {
  if (!entry || entry.status !== 'supported' || !entry.name) continue;
  const h = byLabel.get(entry.name) || null;
  if (!h) unmatched.push(entry.name);

  let slug = slugify(entry.name) + '-market-analysis';
  if (seenSlugs.has(slug)) slug = slugify(entry.name) + '-' + (h ? h.naics6 : 'x') + '-market-analysis';
  if (seenSlugs.has(slug)) continue; // true duplicate row - skip
  seenSlugs.add(slug);

  const naics6 = h ? h.naics6 : null;
  const group = h ? h.group : null;
  let profileId = null;
  if (naics6) {
    const pid = naicsRouter.lookupProfileId(naics6);
    if (pid && !pid.startsWith('OUT_OF_SCOPE_')) profileId = pid;
  }

  // Studies: sector-specific first (up to 3); else 2 from the cross pool,
  // rotated deterministically by NAICS so fallback pages don't all repeat
  // the same two citations.
  let studyIds = (group && studyIdsByGroup[group]) ? studyIdsByGroup[group].slice(0, 3) : [];
  if (studyIds.length === 0 && crossPool.length) {
    const seed = naics6 ? parseInt(naics6, 10) : slug.length;
    const i = Math.abs(seed) % crossPool.length;
    studyIds = [crossPool[i], crossPool[(i + 7) % crossPool.length]];
  }

  verticals.push({
    slug,
    name: entry.name,
    naics6,
    group,
    sector_name: h ? h.sector_name : null,
    profile_id: (profileId && problems[profileId]) ? profileId : null,
    study_ids: studyIds,
  });
}

const out = {
  generated: new Date().toISOString().slice(0, 10),
  counts: { verticals: verticals.length, unmatched: unmatched.length, studies: Object.keys(studyById).length, problem_profiles: Object.keys(problems).length },
  studies: studyById,
  problems,
  verticals,
};

fs.mkdirSync(path.join(ROOT, 'seoData'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'seoData', 'verticals.json'), JSON.stringify(out));

console.log('[build-vertical-data] verticals:', verticals.length);
console.log('[build-vertical-data] matched to NAICS:', verticals.filter((v) => v.naics6).length);
console.log('[build-vertical-data] with profile problems:', verticals.filter((v) => v.profile_id).length);
console.log('[build-vertical-data] with sector studies:', verticals.filter((v) => v.study_ids.length === 3).length, '(3) /', verticals.filter((v) => v.study_ids.length === 2).length, '(2 cross)');
console.log('[build-vertical-data] unmatched names:', unmatched.length, unmatched.slice(0, 10));
console.log('[build-vertical-data] wrote seoData/verticals.json');

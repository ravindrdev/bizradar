/* Ranker — BATCH13.pdf p.6-7 + BATCH16.pdf p.2 (top-10 + impact labels)
   score = magnitude_factor × evidence_factor × ease_factor
   BATCH16: present TOP 10 always, each labeled HIGH/MEDIUM/LOW/MINIMAL impact.
   No 0.30 cutoff anymore — all triggered actions are shown up to 10.
   'always' triggers still surface in long_term_kpi for backwards compat. */

const { parse, evaluate, magnitude } = require('./triggerDsl');

const EVIDENCE_FACTORS = { 1: 1.0, 2: 0.85, 3: 0.65, 4: 0.55 };
const EASE_FACTORS = { low_effort: 1.0, medium_effort: 0.7, high_effort: 0.4 };

function studyTier(studyId, studies) {
  const s = studies.find((x) => x.id === studyId);
  return s ? s.tier : 4;
}

function evidenceFactor(rec, studies) {
  // Audit fix R1 — Array.isArray guard. Previously `rec.study_ids.map`
  // crashed with TypeError when a rec had no study_ids field. We now
  // treat missing/empty study lists as the worst-evidence tier (0.55)
  // rather than throwing — same end behavior as before but without
  // taking the whole report down on a single malformed rec.
  const ids = Array.isArray(rec && rec.study_ids) ? rec.study_ids : [];
  if (ids.length === 0) return 0.55;
  const tiers = ids.map((id) => studyTier(id, studies));
  const best = Math.min(...tiers);
  return EVIDENCE_FACTORS[best] || 0.55;
}

// BATCH16 impact-label thresholds. Score range 0.0-1.0.
function impactLabel(score) {
  if (score >= 0.60) return 'HIGH';
  if (score >= 0.30) return 'MEDIUM';
  if (score >= 0.10) return 'LOW';
  return 'MINIMAL';
}

function scoreRecommendations(profile, data, studies) {
  const triggered = [];
  for (const rec of profile.recommendations || []) {
    let ast;
    try {
      ast = parse(rec.trigger);
    } catch (e) {
      console.warn(`Bad trigger for ${rec.id}: ${e.message}`);
      continue;
    }
    if (!evaluate(ast, data)) continue;
    const m = magnitude(ast, data);
    const e = evidenceFactor(rec, studies);
    const ease = EASE_FACTORS[rec.ease] || 0.4;
    const score = m * e * ease;
    triggered.push({
      rec,
      score,
      magnitudeFactor: m,
      evidenceFactor: e,
      easeFactor: ease,
      isAlwaysTrigger: ast.type === 'ALWAYS',
      impact: impactLabel(score),
    });
  }
  triggered.sort((a, b) => b.score - a.score);

  // BATCH16: top-10 always shown, no cutoff. Each labeled HIGH/MED/LOW/MINIMAL.
  const top10 = triggered.slice(0, 10);
  const highImpactCount = top10.filter((t) => t.impact === 'HIGH').length;
  const mediumImpactCount = top10.filter((t) => t.impact === 'MEDIUM').length;
  const lowImpactCount = top10.filter((t) => t.impact === 'LOW').length;
  const minimalImpactCount = top10.filter((t) => t.impact === 'MINIMAL').length;

  // Backwards-compat slices kept for any caller still expecting them.
  const priority = triggered.slice(0, 3);
  const additional = triggered
    .slice(3, 6)
    .filter((t) => t.score >= 0.3);
  const longTermKpi = triggered.filter(
    (t) => t.isAlwaysTrigger && !priority.includes(t)
  );

  return {
    top10,
    highImpactCount,
    mediumImpactCount,
    lowImpactCount,
    minimalImpactCount,
    priority,
    additional,
    longTermKpi,
    allTriggered: triggered,
  };
}

function evaluateRedFlags(profile, data) {
  const fired = [];
  for (const rf of profile.red_flags || []) {
    let ast;
    try {
      ast = parse(rf.trigger);
    } catch (e) {
      console.warn(`Bad red flag trigger ${rf.id}: ${e.message}`);
      continue;
    }
    if (evaluate(ast, data)) fired.push(rf);
  }
  return fired;
}

module.exports = { scoreRecommendations, evaluateRedFlags, EVIDENCE_FACTORS, EASE_FACTORS };

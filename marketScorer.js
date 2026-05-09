/* marketScorer.js — Tier 4 of the 5-tier Market Analysis pipeline.

   PURE SCORING ENGINE. Takes the JSON outputs from Tier 3's four
   data agents (market, demographics, competition, cost) plus the
   business-type list from Tier 2's Claude orchestrator, and returns
   the top 10 ranked business types by composite score.

   No async. No API calls. No Claude. Deterministic, testable.

   Composite score = gap × 0.40 + feasibility × 0.35 + growth × 0.25.

   Sub-scores:
     gap_score          = novelty * 0.6 + income_fit * 0.25 + age_fit * 0.15
     feasibility_score  = survival * 0.5 + cost_tier_score * 0.4 + permit_adj * 0.1
     growth_score       = permits_signal + event_boost   (max 1.0)

   Replaces the prior v3+v4 hybrid scorer that mixed sector-level v4
   gap math with v3 novelty signal. The new engine works on the 20
   Claude-generated business types instead of NAICS-2 sectors.

   Single export: scoreBusinessTypes({ businessTypes, market,
   demographics, competition, cost }) → array<top 10 cards>. */

const GAP_WEIGHT         = 0.40;
const FEASIBILITY_WEIGHT = 0.35;
const GROWTH_WEIGHT      = 0.25;

// Cost tier → feasibility component (lower cost = easier feasibility).
const COST_TIER_SCORES = {
  low:       1.0,
  medium:    0.7,
  high:      0.4,
  very_high: 0.2,
};

// ── Per-component scoring helpers ───────────────────────────────────

// Income fit — prefer business types whose typical clientele matches
// the local median household income. Mid-income (45k-80k) defaults to
// 0.85 since most service businesses can sustain there.
const HIGH_INCOME_TYPES = [
  'Wine Bar', 'Fine Dining', 'Luxury Spa', 'Med Spa',
  'Financial Advisor', 'Law Office', 'Wealth Management',
  'Private Tutoring', 'Specialty Retail', 'Boutique',
  'Cocktail Bar', 'Steakhouse', 'Premium', 'Luxury',
  'Art Gallery', 'Yacht', 'Country Club',
];
const LOW_INCOME_TYPES = [
  'Dollar Store', 'Laundromat', 'Fast Food', 'Check Cashing',
  'Discount Retail', 'Pawn Shop', 'Title Loan',
];

function incomefit(type, income) {
  if (typeof income !== 'number' || income <= 0) return 0.5;
  const t = String(type || '');
  const matchHigh = HIGH_INCOME_TYPES.some((p) => t.toLowerCase().includes(p.toLowerCase()));
  const matchLow  = LOW_INCOME_TYPES.some((p)  => t.toLowerCase().includes(p.toLowerCase()));
  if (income > 80000  && matchHigh) return 1.0;
  if (income > 80000  && matchLow)  return 0.4;   // wrong-tier penalty
  if (income < 45000  && matchLow)  return 1.0;
  if (income < 45000  && matchHigh) return 0.3;   // wrong-tier penalty
  if (income >= 45000 && income <= 80000) return 0.85;
  return 0.65;
}

// Age fit — boost businesses whose target audience matches the
// dominant local age profile. Returns 0.75 (neutral) when no boost
// applies; older 'balanced' profiles also fall through to 0.75.
const ELDERLY_TYPES = [
  'Senior Care', 'Medical', 'Pharmacy', 'Hearing Aid',
  'Mobility', 'Assisted Living', 'Home Health', 'Hospice',
  'Optometr', 'Chiropract', 'Physical Therapy',
  'Veterinary',
];
const YOUNG_TYPES = [
  'Gaming', 'Fitness', 'Tutoring', 'Childcare',
  'Toy Store', 'Youth Sports', 'Trampoline', 'Arcade',
  'Bookstore', 'Coding', 'Dance Studio',
];
const WORKING_AGE_TYPES = [
  'Coffee Shop', 'Cafe', 'Coworking', 'Brewery',
  'Yoga Studio', 'CrossFit', 'Bookkeep', 'Tax Prep',
  'IT Support', 'Web Design',
];

function ageFit(type, ageProfile) {
  if (!ageProfile) return 0.75;
  const t = String(type || '');
  const inList = (list) => list.some((p) => t.toLowerCase().includes(p.toLowerCase()));
  if (ageProfile === 'elderly-skewed' && inList(ELDERLY_TYPES)) return 1.0;
  if (ageProfile === 'young-family'   && inList(YOUNG_TYPES))   return 1.0;
  if (ageProfile === 'working-age'    && inList(WORKING_AGE_TYPES)) return 1.0;
  return 0.75;
}

// Gap score — competition-driven novelty + income fit + age fit.
function gapScoreFor(type, competition, demographics) {
  const compEntry = (competition && competition.by_type && competition.by_type[type]) || {};
  const noveltyRaw = typeof compEntry.novelty_score === 'number' ? compEntry.novelty_score : 5;
  const novelty = noveltyRaw / 10;
  const income_fit = incomefit(type, demographics && demographics.median_income);
  const age_fit   = ageFit(type, demographics && demographics.age_profile);
  return Math.min(1.0, novelty * 0.60 + income_fit * 0.25 + age_fit * 0.15);
}

// Feasibility — survival rate + cost tier + permit complexity nudge.
function feasibilityScoreFor(type, market, cost) {
  const sr = (market && market.survival_rates && market.survival_rates[type]) || null;
  const survival = sr && typeof sr.y5 === 'number' ? sr.y5 : 0.5;
  const tier = (cost && cost.by_type && cost.by_type[type] && cost.by_type[type].startup_cost_tier) || 'medium';
  const cost_tier_score = COST_TIER_SCORES[tier] != null ? COST_TIER_SCORES[tier] : 0.7;
  const permit_adj = (cost && cost.permit_complexity === 'low') ? 0.1 : 0;
  return Math.min(1.0, survival * 0.50 + cost_tier_score * 0.40 + permit_adj * 0.10);
}

// Growth — permits-YoY signal + small boost when there are upcoming
// events (proxy for active local commerce/foot traffic).
function growthScoreFor(market) {
  const yoy = market && market.permits && typeof market.permits.building_permits_yoy_change === 'number'
    ? market.permits.building_permits_yoy_change
    : null;
  let signal = 0.5;
  if (yoy != null) {
    if (yoy > 20)       signal = 1.0;
    else if (yoy > 5)   signal = 0.75;
    else if (yoy > -5)  signal = 0.5;
    else if (yoy > -20) signal = 0.25;
    else                signal = 0.1;
  }
  const event_boost = (market && Array.isArray(market.events) && market.events.length > 0) ? 0.1 : 0;
  return Math.min(1.0, signal + event_boost);
}

// ── Main entry — score every business type, return top 10 ──────────
function scoreBusinessTypes({
  businessTypes,
  market,
  demographics,
  competition,
  cost,
}) {
  if (!Array.isArray(businessTypes) || businessTypes.length === 0) return [];

  const scored = businessTypes.map((type) => {
    const gap_score         = gapScoreFor(type, competition, demographics);
    const feasibility_score = feasibilityScoreFor(type, market, cost);
    const growth_score      = growthScoreFor(market);
    const final_score = (
      gap_score         * GAP_WEIGHT +
      feasibility_score * FEASIBILITY_WEIGHT +
      growth_score      * GROWTH_WEIGHT
    );

    const compEntry = (competition && competition.by_type && competition.by_type[type]) || {};
    const sr = (market && market.survival_rates && market.survival_rates[type]) || {};
    const costEntry = (cost && cost.by_type && cost.by_type[type]) || {};

    const survival_y5_pct = typeof sr.y5 === 'number'
      ? (sr.y5 * 100).toFixed(1) + '%'
      : null;

    return {
      business_type: type,
      final_score: Math.round(final_score * 100) / 100,
      score_breakdown: {
        gap_score:         Math.round(gap_score * 100) / 100,
        feasibility_score: Math.round(feasibility_score * 100) / 100,
        growth_score:      Math.round(growth_score * 100) / 100,
      },
      competitor_count: typeof compEntry.competitor_count === 'number'
        ? compEntry.competitor_count
        : null,
      novelty_score: typeof compEntry.novelty_score === 'number'
        ? compEntry.novelty_score
        : 5,
      top_competitors: Array.isArray(compEntry.top_3) ? compEntry.top_3 : [],
      startup_cost_range: costEntry.startup_cost_range || '—',
      startup_cost_tier: costEntry.startup_cost_tier || 'medium',
      survival_y5: survival_y5_pct,
      naics2: sr.naics2 || null,
      // why_this_city is filled in by Tier 5's batch Claude call;
      // left empty here so the scorer stays pure-data.
      why_this_city: '',
    };
  });

  scored.sort((a, b) => b.final_score - a.final_score);
  return scored.slice(0, 10).map((c, i) => ({ rank: i + 1, ...c }));
}

module.exports = {
  scoreBusinessTypes,
  // Exposed for tests / debug
  _gapScoreFor: gapScoreFor,
  _feasibilityScoreFor: feasibilityScoreFor,
  _growthScoreFor: growthScoreFor,
  _incomefit: incomefit,
  _ageFit: ageFit,
  _COST_TIER_SCORES: COST_TIER_SCORES,
  _GAP_WEIGHT: GAP_WEIGHT,
  _FEASIBILITY_WEIGHT: FEASIBILITY_WEIGHT,
  _GROWTH_WEIGHT: GROWTH_WEIGHT,
};

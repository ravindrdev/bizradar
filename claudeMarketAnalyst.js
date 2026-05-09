/* claudeMarketAnalyst.js — Tier 2 orchestrator + Tier 5 deep dive + chat.

   ORCHESTRATES the 5-tier Market Analysis pipeline:

     TIER 1  Validation (in server.js POST /market-analysis route)
     TIER 2  getBusinessTypes()       — 1 Claude call, 500 tokens
     TIER 3  4 parallel data agents   (dataAgents.js)
     TIER 4  scoreBusinessTypes()     (marketScorer.js)
     TIER 5  generateWhyThisCity()    — 1 Claude call for top 10
             generateDeepDive()       — 2 parallel calls for #1
             chatFollowUp()           — Q&A on cached analysis

   This file replaces the prior v3+v4 hybrid + parallel-call retrofit
   wholesale. The previous architecture sent the entire prompt schema
   in two parallel calls hoping Claude would honor 600-token-per-card
   density across the v3 schema. Truncation routinely lost the entire
   opportunities array. The new architecture scopes Claude calls to:

     - 500 tokens for the type list (Tier 2)
     - 2000 tokens for batched why_this_city (Tier 5 batch)
     - 8000 + 6000 tokens for deep-dive on the #1 only (Tier 5 dive)
     - 1000 tokens for follow-up chat answers

   Caches:
     MARKET_CACHE  24h per city|state   (full analyzeCity result)
     TYPES_CACHE    7d per city|state   (Tier 2 business-type list)

   Single client instance pulled from env at module load.

   No top-level system prompt cache_control — at this scope the static
   instruction blocks are smaller than the 1024-token cache minimum
   for Sonnet, so cache_control would never write. */

const Anthropic = require('@anthropic-ai/sdk');
const dataAgents = require('./dataAgents');
const marketScorer = require('./marketScorer');
const dataFetchers = require('./dataFetchers');
const places = require('./googlePlaces');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_TYPES   = 500;
const MAX_TOKENS_WHY     = 2500;
const MAX_TOKENS_DIVE_A  = 12000;  // bumped 8K→12K for tier1+tier2+tier3 in one call
const MAX_TOKENS_DIVE_B  = 6000;
const MAX_TOKENS_CHAT    = 1000;

const MARKET_CACHE = new Map();
const MARKET_TTL   = 24 * 60 * 60 * 1000;

const TYPES_CACHE  = new Map();
const TYPES_TTL    = 7 * 24 * 60 * 60 * 1000;

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── safeJSON — extract the first {…} (or […]) and repair truncation ─
function safeJSON(text, label) {
  if (!text) throw new Error(label + ': empty response');
  // Try object first, then array (Tier 2 returns an array).
  const objMatch = text.match(/\{[\s\S]*\}/);
  const arrMatch = text.match(/\[[\s\S]*\]/);
  // Prefer whichever appears earlier in the text.
  let match = null;
  if (objMatch && arrMatch) {
    match = objMatch.index <= arrMatch.index ? objMatch : arrMatch;
  } else {
    match = objMatch || arrMatch;
  }
  if (!match) {
    throw new Error(label + ': no JSON found. Got: ' + text.slice(0, 200));
  }
  try { return JSON.parse(match[0]); } catch (_) { /* repair */ }

  const lines = match[0].split('\n');
  for (let i = lines.length - 1; i > 5; i--) {
    const chunk = lines.slice(0, i).join('\n');
    const ob  = (chunk.match(/\{/g) || []).length - (chunk.match(/\}/g) || []).length;
    const ob2 = (chunk.match(/\[/g) || []).length - (chunk.match(/\]/g) || []).length;
    const closed = chunk
      + ']'.repeat(Math.max(0, ob2))
      + '}'.repeat(Math.max(0, ob));
    try {
      const r = JSON.parse(closed);
      console.log('[safeJSON] ' + label + ': repaired at line ' + i);
      return r;
    } catch (_) { /* keep walking back */ }
  }
  throw new Error(label + ': repair failed');
}

// ── callClaude — wraps the SDK with consistent settings ────────────
async function callClaude(prompt, maxTokens, label) {
  if (!client) throw new Error('Anthropic client not initialized (missing ANTHROPIC_API_KEY)');
  const t0 = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  const dt = Date.now() - t0;
  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (response.stop_reason === 'max_tokens') {
    console.warn(`[claude] ${label || ''} hit max_tokens=${maxTokens} (output truncated)`);
  }
  console.log(`[claude] ${label || ''} done in ${dt}ms · in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
  return text;
}

// ─────────────────────────────────────────────────────────────────────
// TIER 2 — getBusinessTypes
// ─────────────────────────────────────────────────────────────────────
// Quick orchestration call: ask Claude for the 20 business types most
// likely to succeed in this state given climate, economy, and typical
// demographics. This drives EVERY downstream Tier 3 search.
//
// Cached 7 days per city|state. On any failure, return a 20-type
// generic fallback list so the pipeline never starves.
const FALLBACK_TYPES = [
  'Coffee Shop', 'Pet Grooming Studio', 'Hair Salon', 'Yoga Studio',
  'Tutoring Center', 'Food Truck', 'Auto Repair Shop', 'Dental Practice',
  'Urgent Care Clinic', 'Bakery', 'Brewery Taproom', 'Bookstore',
  'Bike Shop', 'Specialty Food Store', 'Plumber', 'Electrician',
  'HVAC Contractor', 'Landscaping Service', 'Photography Studio',
  'Boutique Retail Store',
];

async function getBusinessTypes(city, state) {
  const cacheKey = `${city.toLowerCase()}|${state.toLowerCase()}`;
  const cached = TYPES_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < TYPES_TTL) {
    console.log(`[tier2] types cache hit for ${cacheKey}`);
    return cached.value;
  }
  if (!client) {
    console.warn('[tier2] no Anthropic client — returning fallback types');
    return FALLBACK_TYPES;
  }

  const prompt = `City: ${city}, ${state}

Generate a JSON array of exactly 20 specific business types most likely to succeed in a ${state} city. Consider the state's economy, climate, and typical demographics.

Be SPECIFIC — say "Ramen Shop" not "restaurant", "Pet Grooming Studio" not "pet services", "Tutoring Center" not "education".

Return ONLY a JSON array of strings. No prose, no markdown, no backticks.

Example output: ["Ramen Shop", "Pet Grooming Studio", "Yoga Studio", ...]`;

  try {
    const text = await callClaude(prompt, MAX_TOKENS_TYPES, 'tier2-types');
    let types = null;
    try { types = safeJSON(text, 'tier2-types'); } catch (e) {
      console.warn('[tier2] parse failed:', e.message);
    }
    if (!Array.isArray(types) || types.length < 5) {
      console.warn('[tier2] invalid type list, using fallback');
      types = FALLBACK_TYPES;
    }
    types = types.slice(0, 20).map((t) => String(t).trim()).filter(Boolean);
    if (types.length < 20) {
      // Top up from fallback to reach 20.
      const seen = new Set(types.map((t) => t.toLowerCase()));
      for (const f of FALLBACK_TYPES) {
        if (types.length >= 20) break;
        if (!seen.has(f.toLowerCase())) types.push(f);
      }
    }
    TYPES_CACHE.set(cacheKey, { ts: Date.now(), value: types });
    console.log(`[tier2] ${city}, ${state} types: ${types.slice(0, 5).join(', ')}…`);
    return types;
  } catch (err) {
    console.warn('[tier2] failed:', err.message);
    return FALLBACK_TYPES;
  }
}

// ─────────────────────────────────────────────────────────────────────
// TIER 5a — generateWhyThisCity
// ─────────────────────────────────────────────────────────────────────
// One Claude call to generate per-card "why this city" prose for all
// 10 ranked types in a single batch. Returns a map { businessType: prose }.
async function generateWhyThisCity(city, state, scored, market, demographics) {
  if (!client || !Array.isArray(scored) || scored.length === 0) return {};

  const wikiBlurb = market && market.city_wiki
    ? String(market.city_wiki).substring(0, 600)
    : '(no Wikipedia summary available)';

  const top10Lines = scored.map((s, i) =>
    `${i + 1}. ${s.business_type} (final ${s.final_score}) — gap ${s.score_breakdown.gap_score}, feasibility ${s.score_breakdown.feasibility_score}, growth ${s.score_breakdown.growth_score} | ${s.competitor_count == null ? '?' : s.competitor_count} competitors, novelty ${s.novelty_score}/10 | ${s.startup_cost_range} | survival y5: ${s.survival_y5 || '—'}`
  ).join('\n');

  const prompt = `You are BizRadar. Write per-card "why this city" prose for the top 10 ranked business opportunities.

CITY: ${city}, ${state}

DEMOGRAPHICS:
- Population: ${demographics.population || 'unknown'}
- Median income: $${demographics.median_income || 'unknown'}
- Age profile: ${demographics.age_profile || 'balanced'}
- 65+: ${demographics.pct_65_plus != null ? Math.round(demographics.pct_65_plus * 100) + '%' : 'N/A'}
- Under 18: ${demographics.pct_under18 != null ? Math.round(demographics.pct_under18 * 100) + '%' : 'N/A'}
- Median 2BR rent: $${demographics.fmr_2br || 'unknown'} (${demographics.fmr_metro || 'metro N/A'})

CLIMATE/MARKET:
- Peak month: ${market.weather && market.weather.peak_month || 'N/A'}
- Cold winter: ${market.weather && market.weather.has_cold_winter}
- Permits YoY: ${market.permits && market.permits.building_permits_yoy_change != null ? market.permits.building_permits_yoy_change + '%' : 'N/A'}
- Growth signal: ${market.growth_signal}
- Upcoming events: ${(market.events || []).length}

WIKIPEDIA:
${wikiBlurb}

TOP 10 RANKED:
${top10Lines}

Write ONE 2-3 sentence paragraph per business type explaining WHY this specific city is a fit. Reference real local signals — demographic, economic, climate, or Wikipedia identity. Be specific to ${city}, ${state}. Do NOT use generic phrases like "growing market" or "strong demand."

SOURCING RULE — each sentence MUST end with exactly one tag:
  [VERIFIED] when the claim comes from the data above (population, median income, age profile, peak month, permits YoY, growth signal, the Wikipedia summary, or the top10 competitor counts/novelty/cost/survival numbers).
  [CUSTOMER MUST VALIDATE] when you're inferring from real-world knowledge of the city that is NOT in the data above (state-level identity, named producers in nearby towns, attraction visitor counts, local cultural context).

Use ONLY these two tags. Never write [CLAUDE ESTIMATE] or [INDUSTRY BENCHMARK] or [SOURCE: X].

GOOD example:
"Dodgeville has zero ramen shops within 25 miles [VERIFIED]. Median household income of $76,250 supports premium ticket pricing [VERIFIED]. The Driftless Area positions Iowa County as a Madison day-trip destination [CUSTOMER MUST VALIDATE]."

BAD example (no tags):
"Dodgeville is a great market for ramen because of its demographics and tourism."

Return ONLY a flat JSON object mapping business_type → why string. No markdown, no backticks, no preamble.

Example shape:
{
  "${scored[0].business_type}": "${city}'s ${demographics.age_profile || 'demographic'} mix and …",
  "${(scored[1] || {}).business_type || 'Type'}": "…"
}`;

  try {
    const text = await callClaude(prompt, MAX_TOKENS_WHY, 'tier5-why');
    const obj = safeJSON(text, 'tier5-why');
    if (typeof obj !== 'object' || Array.isArray(obj)) return {};
    return obj;
  } catch (err) {
    console.warn('[tier5-why] failed:', err.message);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────
// TIER 5b — generateDeepDive (#1 only)
// ─────────────────────────────────────────────────────────────────────
// Two parallel Claude calls (v3 architecture) scoped to the SINGLE
// top-ranked business type. Schema and rules are tuned to that one
// business so 8K + 6K is plenty of headroom.
const SHARED_RULES = `STRICT RULES:
1. GENERIC PHRASES FORBIDDEN: "improve service", "local farm", "nearby restaurant", "local supplier", "build community". Always name the actual entity.
2. NAMED LOCAL ENTITIES ONLY: every opportunity, partner, producer, event must be a REAL named place within 60 miles of the city. Sources: the local-business / venue / event blocks above OR your real-world knowledge of the city.
3. NAMED PRODUCERS must include name + city + distance in miles + what they make + price tier.
4. PARTNERSHIP TARGETS must be real named businesses in the city with rating + distance + cross-promo angle.
5. STEAL_STRATEGY EVIDENCE must be a literal quote from the local business reviews above. Never invent quotes — if no review evidence supports an action, omit it.
6. PERSONA GAP RULE: a customer segment is CONFIRMED underserved when the keyword count for that segment is ≥15% of total review keyword counts AND no surveyed business serves them specifically. Show the actual percentages and gap_points.
7. KNOWN GAPS = universal complaints (WiFi, parking, cleanliness). Bottom of report.
8. HIDDEN GAPS = local-only complaints (cite the review quote). Top priority.
9. NOVELTY: 0 competitors within radius = 9-10. 1-2 = 6-8. 3-4 = 4-5. 5+ = 1-3.
10. BED2013 survival rates MUST appear in the executive summary risk statement for the #1 sector.
11. EVERY SEASON must name a REAL local event (events block first, then real-world knowledge of the city). Generic "summer festivals" forbidden.
12. ZERO COMPETITION WINDOW: if competitor_count = 0, surface that explicitly with novelty 9-10 and the literal "no competing X within Y miles" phrase.

═══════════════════════════════════════════════════
SOURCING RULES — MANDATORY FOR EVERY FACTUAL CLAIM
═══════════════════════════════════════════════════

There are EXACTLY FOUR sourcing tags. Use one of them after every factual claim.
The ONLY permanently banned tag is [CLAUDE ESTIMATE] — never write that one.

[VERIFIED]
  Data came directly from our API responses — Google Places competitor
  counts, local_businesses names/ratings/reviews, Census ACS demographics,
  BLS BED2013 survival rates for the actual city sector, Open-Meteo
  weather, HUD FMR rents, OSM anchor tenants, the Ticketmaster events
  block, or the Wikipedia city summary.
  Example: "0 cheese shops within 25 miles [VERIFIED]"
  Example: "Median household income $76,250 [VERIFIED]"

[INDUSTRY BENCHMARK]
  General SBA / BLS / industry data that applies broadly across the
  business category, not specific to this city. Use for startup-cost
  ranges, survival rates as general benchmarks, occupancy assumptions,
  ADR averages, sales-per-sqft norms. Cite the source institution.
  Example: "$35K-$75K [INDUSTRY BENCHMARK — SBA specialty retail average]"
  Example: "58.3% 5-yr survival [INDUSTRY BENCHMARK — BLS BED2013 NAICS 44-45]"

[SOURCE: X]
  A specific named review, named business, or named data point triggered
  this insight. X must be the business name or specific data source.
  Example: "[SOURCE: Bob's Bitchin' BBQ review] — cheese curds called out as a highlight"
  Example: "[SOURCE: Cathryn's Market 4.9★, 120 reviews] — proven local-gifting trust"

[CUSTOMER MUST VALIDATE]
  Your best intelligence but NOT in our verified data — distances to
  producers / attractions outside the local-business block, attendance
  figures, event dates, wholesale availability, contact info, historical
  context, named businesses in nearby cities.
  Example: "Hook's Cheese Company, ~10 miles SW [CUSTOMER MUST VALIDATE]"
  Example: "Iowa County Fair held annually in August [CUSTOMER MUST VALIDATE]"

NEVER make a factual claim without exactly one of these four tags.
NEVER write [CLAUDE ESTIMATE]. That tag is permanently banned.

NEVER invent a phone number. If a business needs a contact, write
"search '{business name}' on Google" instead of fabricating a number.
A wrong phone number is worse than no phone number.

ESTIMATION FIELDS — write them plainly, NO TAG:
Revenue ranges, LTV, lost revenue, time-to-profit, monthly_revenue_est,
lost_revenue_est — write these as plain dollar ranges or formulas. Show
the math inline when useful ("$8K-$18K/month based on 60 covers × $22
ticket × 6 days/week"), but do NOT append any tag. They are projections
by their nature; intelligent users understand that.

Note: startup costs and survival rates DO get tagged — they're industry
benchmarks ([INDUSTRY BENCHMARK]) not per-business projections.

═══════════════════════════════════════════════════
LOCATION ACCURACY RULE
═══════════════════════════════════════════════════

Never state a street address for any business unless it came directly
from the Google Places API data provided above. If you reference a
business location, use only:
- The business name [VERIFIED]
- "nearby" or "in {city}"
- Never invent or guess a street name, suite number, or building name

If a partner/competitor needs to be located, write the business name
followed by [VERIFIED] (when it's in the local_businesses block) or
[CUSTOMER MUST VALIDATE] (when it's not). Do NOT fabricate "1234 Main
Street" or "the corner of 5th and Oak" or any address-shaped string.

═══════════════════════════════════════════════════
EVENT DATE RULE
═══════════════════════════════════════════════════

Never state specific event dates unless they came from the Ticketmaster
events block above. If the events data shows dates, use those exact
dates. If no dates were provided, write "[CUSTOMER MUST VALIDATE current
schedule]" instead of guessing a month or day.

ALLOWED when events block has the event:
  "Holiday on the Square — December 7 [VERIFIED]"

ALLOWED when events block is empty:
  "Iowa County Fair (held annually in late summer) [CUSTOMER MUST VALIDATE current schedule]"

FORBIDDEN — never invent month/day combinations:
  "Iowa County Fair, August 14-18, 2026"  ← unless that exact date is in the events block`;

const SCHEMA_A = `{
  "tier1": {
    "_comment": "Full deep dive for the #1 ranked business only.",
    "executive_summary": "3 sentences: #1 specific opportunity → what works in this market → BED2013 risk for the best sector",
  "health_score": 72,
  "health_label": "Strong Entry Point | Solid Foundation | Cautious Entry | High Risk",
  "market_grade": "A | B+ | B | B- | C+ | C | C- | D | F",
  "data_sources_used": ["Google Places", "Census", "Weather", "BED2013", "Wikipedia", "..."],
  "top_opportunities": [
    {
      "rank": 1,
      "title": "Specific named concept",
      "business_type": "Exact type",
      "what_to_build": "Specific concept — what to actually open",
      "local_source": "Real named local partner/supplier within 60 miles",
      "how_to_start": "First action today — phone or website",
      "cost_to_open": "$X one-time",
      "monthly_revenue_est": "$X,000-$Y,000/month",
      "novelty_score": 9,
      "review_mention_score": 8,
      "competitor_count_nearby": 0,
      "final_rank": 17.5,
      "bed2013_risk": "LOW — 55.3% 5-year survival (NAICS 72)"
    }
  ],
  "quick_wins": [
    { "action": "Specific action today", "why": "Why for THIS city specifically", "cost": "$0", "timeline": "Today | This week", "expected_result": "Concrete outcome" }
  ],
  "steal_strategy": [
    {
      "business_name": "Real named local business (must come from local_businesses block above)",
      "tenure": "Estimated from review activity (e.g. 'Established — 5+ years based on 120 reviews')",
      "trust_weight": 1.0,
      "confidence": "HIGH | MEDIUM | LOW",
      "what_they_do_well": "Specific thing from their reviews",
      "actions_to_steal": [
        {
          "action": "Specific replicable action",
          "evidence": "Format: 'From {business_name} Google review: \\\"<exact quote ≤15 words>\\\"'. Quote must be a literal substring of one of the review_snippets above. NEVER invent a quote — if no review supports the action, omit the action.",
          "how_to_implement": "Step-by-step this week",
          "cost": "$X"
        }
      ]
    }
  ],
  "hidden_gaps": [
    { "title": "Gap unique to this city", "evidence": "Literal review quote", "why_hidden": "Why local-specific", "business_to_open": "Specific business type", "timeline": "This week", "cost_to_open": "$X" }
  ],
  "known_gaps": [
    { "title": "Universal complaint", "one_line_opportunity": "Quick line" }
  ],
  "sba_risk": {
    "best_sector": "Sector name + NAICS-2",
    "year1_survival": "78.3%",
    "year3_survival": "64.3%",
    "year5_survival": "55.3%",
    "year10_survival": "38.1%",
    "risk_level": "LOW | MODERATE | HIGH",
    "context": "One sentence framing urgency for the #1 opportunity"
  }
  },
  "tier2": [
    {
      "_comment": "Medium-depth entry — generate ONE per business for ranks 2, 3, 4, 5 (4 entries total). Match each entry's 'rank' and 'business_type' to the ALL 10 RANKED BUSINESSES list above.",
      "rank": 2,
      "business_type": "Echo the exact business_type from the rank-2 row",
      "why_now": "2-3 sentences. Each MUST end with [VERIFIED] or [CUSTOMER MUST VALIDATE]. Cite the same numbers we provided (population, income, peak month, competitor count, novelty).",
      "top_3_actions": [
        { "action": "Specific tactical action for THIS business in THIS city", "cost": "$X (plain number, no tag)", "timeline": "Today | This week | Month 1" },
        { "action": "...", "cost": "$X", "timeline": "..." },
        { "action": "...", "cost": "$X", "timeline": "..." }
      ],
      "startup_steps": [
        "Step 1 — concrete action to open this business (e.g. apply for state license, sign lease in {neighborhood}, source equipment from {named supplier})",
        "Step 2 — concrete action",
        "Step 3 — concrete action"
      ],
      "key_risk": "Single biggest risk SPECIFIC to this city — one sentence. Tag with [VERIFIED] or [CUSTOMER MUST VALIDATE]."
    }
  ],
  "tier3": [
    {
      "_comment": "Light entry — generate ONE per business for ranks 6, 7, 8, 9, 10 (5 entries total). Keep it terse.",
      "rank": 6,
      "business_type": "Echo the exact business_type from the rank-6 row",
      "why_now": "1-2 sentences max. End with [VERIFIED] or [CUSTOMER MUST VALIDATE].",
      "key_risk": "One sentence."
    }
  ]
}`;

const SCHEMA_B = `{
  "persona_gap_matrix": [
    {
      "segment": "Named segment (e.g. business travelers, young families)",
      "review_mention_pct": "24%",
      "businesses_serving_them": 0,
      "gap_points": 22,
      "confirmed": true,
      "lost_revenue_est": "$X,000/month",
      "root_cause": "Specific reason nobody serves them",
      "business_to_open": "Specific business type to open"
    }
  ],
  "personas": [
    {
      "name": "First name (illustrative persona)",
      "review_source": "REQUIRED. The real signal that created this persona. Two valid formats: (a) 'Real customer review — {business_name}: \\\"<exact quote ≤20 words from review_snippets above>\\\"' when a specific review inspired the persona. (b) 'Real signal — \\\"{keyword}\\\" appears in N% of local reviews' when a persona_signals keyword frequency inspired it. Never invent a review.",
      "profile": "Age, occupation, why they're in the city",
      "gap_source": "Which review gap from persona_gap_matrix confirms this",
      "spend_trigger": "Specific thing that opens their wallet",
      "five_star_trigger": "ONE thing that earns 5 stars",
      "word_of_mouth_trigger": "What makes them recommend",
      "never_returns_if": "One thing that kills loyalty",
      "searches": "Exact Google search they typed",
      "ltv": "$X/year",
      "reach_via": "Exact ad channel + headline"
    }
  ],
  "lost_customer": {
    "name": "First name",
    "profile": "Who they are",
    "gap_proof": "X% in competitor reviews vs Y% served here",
    "lost_revenue": "$X,000/month",
    "root_cause": "Specific reason they go elsewhere",
    "drives_to": "Which nearby city they go to instead",
    "fix": "Exact action this week"
  },
  "seasonal_strategy": {
    "summer": { "dominant_persona": "...", "best_business_to_open": "...", "marketing_message": "...", "event_tie_in": "REAL named", "local_partner": "REAL named", "revenue_range": "$X,000-$Y,000/month", "opportunity_window": "ZERO COMPETITION WINDOW or standard" },
    "fall":   { "dominant_persona": "...", "best_business_to_open": "...", "marketing_message": "...", "event_tie_in": "REAL named", "local_partner": "REAL named", "revenue_range": "$X,000-$Y,000/month" },
    "winter": { "dominant_persona": "...", "best_business_to_open": "...", "marketing_message": "...", "event_tie_in": "REAL named", "local_partner": "REAL named", "revenue_range": "$X,000-$Y,000/month", "off_season_survival": "Specific strategy for the slowest month" },
    "spring": { "dominant_persona": "...", "best_business_to_open": "...", "marketing_message": "...", "event_tie_in": "REAL named", "local_partner": "REAL named", "revenue_range": "$X,000-$Y,000/month" }
  },
  "hyper_local": {
    "state_identity": "What this state is famous for — name real brands",
    "city_identity": "What this city is known for — real employers and landmarks",
    "named_producers": ["Producer name, city, distance mi, product, price"],
    "named_attractions": ["Attraction name, distance mi, annual visitors or peak season"],
    "named_events": ["Event name, timing, attendance or economic impact"],
    "partnership_targets": ["Business name in city, rating, distance, cross-promotion angle"]
  },
  "confidence": {
    "level": "HIGH | MEDIUM | LOW",
    "score": 0.85,
    "sources_confirmed": 7,
    "note": "Which sources returned data and which fell back"
  }
}`;

function buildDeepDiveContext(city, state, top1, market, demographics, competition) {
  const wikiBlurb = market && market.city_wiki
    ? String(market.city_wiki).substring(0, 800)
    : '(no Wikipedia summary)';

  const businessLines = (competition && competition.local_businesses || []).map((b, i) => {
    // Snippets are now objects { text, author, time }. Render each as a
    // verbatim quote line tagged with author + relative time so Claude
    // can cite "From {biz} Google review (Mike S., 3 weeks ago): '...'"
    // and provenance.js can substring-verify the quote against b.review_snippets[*].text.
    const rs = (b.review_snippets || []).map((s) => {
      const text = (s && typeof s === 'object') ? s.text : s;
      const meta = (s && typeof s === 'object' && (s.author || s.time))
        ? ` — ${s.author || 'anonymous'}${s.time ? ', ' + s.time : ''}`
        : '';
      return `    "${text || ''}"${meta}`;
    }).join('\n');
    return `B${i + 1}: ${b.name} | ${b.rating == null ? '—' : b.rating + '★'} | ${b.review_count} reviews
  Persona keywords: ${JSON.stringify(b.persona_keywords || {})}
  Reviews:
${rs || '    (no review text)'}`;
  }).join('\n\n');

  const eventLines = (market && market.events || []).length
    ? market.events.map((e) => `• ${e.name} | ${e.date || 'TBD'} | ${e.venue || 'TBD'}`).join('\n')
    : '(no events found — real-world knowledge of named annual events for this city is acceptable in seasonal_strategy)';

  return `=== BIZRADAR DEEP DIVE — ${top1.business_type} in ${city}, ${state} ===

--- TOP RANKED BUSINESS ---
Type: ${top1.business_type}
Final score: ${top1.final_score} (gap ${top1.score_breakdown.gap_score} | feasibility ${top1.score_breakdown.feasibility_score} | growth ${top1.score_breakdown.growth_score})
Competitors found: ${top1.competitor_count == null ? 'unknown' : top1.competitor_count}
Novelty: ${top1.novelty_score}/10
Existing competitors: ${(top1.top_competitors || []).map((c) => c.name).join(', ') || 'none found'}
Startup cost: ${top1.startup_cost_range}
5-year survival (BED2013, NAICS ${top1.naics2 || '?'}): ${top1.survival_y5 || '—'}

--- DEMOGRAPHICS ---
Population: ${demographics.population || 'unknown'}
Median income: $${demographics.median_income || 'unknown'} (tier: ${demographics.income_tier})
Age profile: ${demographics.age_profile || 'balanced'} (65+: ${demographics.pct_65_plus != null ? Math.round(demographics.pct_65_plus * 100) + '%' : 'N/A'} | <18: ${demographics.pct_under18 != null ? Math.round(demographics.pct_under18 * 100) + '%' : 'N/A'})
Median 2BR rent: $${demographics.fmr_2br || 'unknown'} (${demographics.fmr_metro || 'metro N/A'})
Anchor tenants near downtown: ${(demographics.anchor_tenants || []).join(', ') || 'none'}
Transit nearby: ${demographics.has_transit}

--- MARKET CONTEXT ---
Peak month: ${market.weather && market.weather.peak_month || 'N/A'}
Cold winter: ${market.weather && market.weather.has_cold_winter}
Hot summer: ${market.weather && market.weather.has_hot_summer}
Permits YoY: ${market.permits && market.permits.building_permits_yoy_change != null ? market.permits.building_permits_yoy_change + '%' : 'N/A'}
Growth signal: ${market.growth_signal}

--- WIKIPEDIA CITY SUMMARY ---
${wikiBlurb}

--- LOCAL BUSINESS INTELLIGENCE (top ${(competition && competition.local_businesses || []).length}) ---
${businessLines || '(no local businesses surfaced)'}

Dominant persona keywords across local reviews: ${(competition && competition.dominant_personas || []).join(', ') || '(none)'}
Persona signal counts: ${JSON.stringify((competition && competition.persona_signals) || {})}

--- UPCOMING LOCAL EVENTS ---
${eventLines}

--- BED2013 SURVIVAL DATA (cited in sba_risk) ---
NAICS ${top1.naics2}: y1=${(market.survival_rates && market.survival_rates[top1.business_type] && market.survival_rates[top1.business_type].y1) || '?'} y3=${(market.survival_rates && market.survival_rates[top1.business_type] && market.survival_rates[top1.business_type].y3) || '?'} y5=${(market.survival_rates && market.survival_rates[top1.business_type] && market.survival_rates[top1.business_type].y5) || '?'} y10=${(market.survival_rates && market.survival_rates[top1.business_type] && market.survival_rates[top1.business_type].y10) || '?'} | Source: BLS Business Employment Dynamics, 2013 cohort tracked through 2023`;
}

// ── buildTopTenSummary — slim 10-line block listing all ranked businesses
// so Call A can write tier2 (rank 2-5) and tier3 (rank 6-10) entries with
// the right business_type strings + scoring context. The full top1 detail
// stays in buildDeepDiveContext for the tier1 deep dive.
function buildTopTenSummary(top10) {
  const list = (top10 || []).map((c, i) => {
    const rank = c.rank || (i + 1);
    const survival = c.survival_y5 || '—';
    const compStr = c.competitor_count == null ? '?' : c.competitor_count;
    const nov = c.novelty_score == null ? '?' : c.novelty_score;
    return `  ${rank}. ${c.business_type} | final ${c.final_score} (gap ${c.score_breakdown && c.score_breakdown.gap_score} | feas ${c.score_breakdown && c.score_breakdown.feasibility_score} | growth ${c.score_breakdown && c.score_breakdown.growth_score}) | ${compStr} competitors, novelty ${nov}/10 | ${c.startup_cost_range || '—'} | survival y5 ${survival} | NAICS ${c.naics2 || '?'}`;
  }).join('\n');
  return `--- ALL 10 RANKED BUSINESSES (use this for tier2 ranks 2-5 and tier3 ranks 6-10) ---
${list || '  (none scored)'}`;
}

function buildPromptA(city, state, top10, market, demographics, competition) {
  const top1 = (top10 && top10[0]) || null;
  if (!top1) return null;
  const ctx = buildDeepDiveContext(city, state, top1, market, demographics, competition);
  const top10Block = buildTopTenSummary(top10);

  // Build the human-readable list of which business goes in which tier
  // so Claude doesn't drift to ranks outside the spec.
  const tier2Names = (top10 || []).slice(1, 5)
    .map((c) => `#${c.rank}: ${c.business_type}`)
    .join(' · ') || '(none)';
  const tier3Names = (top10 || []).slice(5, 10)
    .map((c) => `#${c.rank}: ${c.business_type}`)
    .join(' · ') || '(none)';

  return `You are BizRadar — a city market intelligence engine. Generate market intelligence for ALL 10 ranked business opportunities, with TIERED depth.

═══════════════════════════════════════════════════
TIERING — MANDATORY
═══════════════════════════════════════════════════

TIER 1 — Business #1 ONLY (${top1.business_type}):
  Generate the FULL deep dive — every field in the "tier1" object of the schema below
  (executive_summary, health_score, health_label, market_grade, data_sources_used,
  top_opportunities[], quick_wins[], steal_strategy[], hidden_gaps[], known_gaps[], sba_risk).

TIER 2 — Businesses #2 through #5 (4 entries — ${tier2Names}):
  For EACH generate ONLY: rank, business_type, why_now (2-3 sentences), top_3_actions[],
  startup_steps[3], key_risk. Do NOT include any other fields.

TIER 3 — Businesses #6 through #10 (5 entries — ${tier3Names}):
  For EACH generate ONLY: rank, business_type, why_now (1-2 sentences), key_risk.
  Do NOT include any other fields. Keep it terse.

Return everything in ONE JSON object: { "tier1": {...}, "tier2": [4 entries], "tier3": [5 entries] }.

${SHARED_RULES}

${ctx}

${top10Block}

Respond in VALID JSON ONLY. No markdown, no backticks, no preamble.

${SCHEMA_A}`;
}

function buildPromptB(city, state, top10, market, demographics, competition) {
  const top1 = (top10 && top10[0]) || null;
  if (!top1) return null;
  // Call B is unchanged in structure — still focused on personas/seasonal/
  // hyper-local for the #1 business. We just accept top10 to keep the
  // signatures consistent with buildPromptA.
  const ctx = buildDeepDiveContext(city, state, top1, market, demographics, competition);
  return `You are BizRadar — customer intelligence engine for city market analysis. Generate the PERSONAS + SEASONAL + HYPER-LOCAL portion of a deep-dive report.

${SHARED_RULES}

${ctx}

Respond in VALID JSON ONLY. No markdown, no backticks, no preamble.

${SCHEMA_B}`;
}

async function generateDeepDive(city, state, top10, market, demographics, competition) {
  if (!client || !top10 || !top10.length) return null;
  const top1 = top10[0];

  // Diagnostic: dump the exact review snippets shipped to Claude so we
  // can manually verify provenance.js's matches in the terminal.
  // Cheap (no I/O cost), runs once per analysis. Snippets are objects
  // {text, author, time} after the provenance refactor — handle both
  // shapes for safety.
  console.log('[review-snippets] sending to Claude:');
  ((competition && competition.local_businesses) || []).forEach((b) => {
    const star = b.rating == null ? '—' : b.rating + '★';
    console.log(`  ${b.name} (${star}, ${b.review_count || 0} reviews):`);
    (b.review_snippets || []).forEach((s, i) => {
      const text = (s && typeof s === 'object') ? s.text : s;
      const meta = (s && typeof s === 'object' && (s.author || s.time))
        ? ` — ${s.author || 'anonymous'}, ${s.time || 'recent'}`
        : '';
      console.log(`    [${i + 1}] "${text || ''}"${meta}`);
    });
  });

  console.log('[tier5-dive] firing 2 parallel calls — tier1 deep dive on', top1.business_type, '+ tier2/tier3 for ranks 2-10');
  const t0 = Date.now();
  const [resA, resB] = await Promise.allSettled([
    callClaude(buildPromptA(city, state, top10, market, demographics, competition), MAX_TOKENS_DIVE_A, 'Call-A'),
    callClaude(buildPromptB(city, state, top10, market, demographics, competition), MAX_TOKENS_DIVE_B, 'Call-B'),
  ]);

  let A = null;
  if (resA.status === 'fulfilled') {
    try { A = safeJSON(resA.value, 'Call-A'); }
    catch (e) {
      console.error('[tier5-dive] Call-A parse failed:', e.message);
    }
  } else {
    console.error('[tier5-dive] Call-A request failed:', resA.reason && (resA.reason.message || resA.reason));
  }

  let B = null;
  if (resB.status === 'fulfilled') {
    try { B = safeJSON(resB.value, 'Call-B'); }
    catch (e) {
      console.error('[tier5-dive] Call-B parse failed:', e.message);
    }
  } else {
    console.error('[tier5-dive] Call-B request failed:', resB.reason && (resB.reason.message || resB.reason));
  }

  if (!A && !B) {
    console.error('[tier5-dive] both calls failed — returning null');
    return null;
  }

  // Extract the new tiered structure from Call A. If Claude returned the
  // old flat shape (no `tier1` wrapper), treat the whole A as the tier1
  // deep dive — this is the graceful fallback. tier2/tier3 default to
  // empty arrays in that case so renderMarketReport falls back to scorer-
  // only rendering for ranks 2-10.
  let tier1 = null;
  let tier2_insights = [];
  let tier3_insights = [];
  if (A && (A.tier1 || A.tier2 || A.tier3)) {
    tier1 = A.tier1 || null;
    tier2_insights = Array.isArray(A.tier2) ? A.tier2 : [];
    tier3_insights = Array.isArray(A.tier3) ? A.tier3 : [];
    if (!tier1) {
      // tier2/tier3 present but tier1 missing — likely truncated. Spread
      // any other top-level A fields as tier1 so the deep dive at least
      // shows partial sections.
      const { tier1: _t1, tier2: _t2, tier3: _t3, ...rest } = A;
      tier1 = rest;
    }
  } else if (A) {
    console.log('[market] tier2/tier3 not in response — showing scorer data only for ranks 2-10');
    tier1 = A;
  }

  const dt = Date.now() - t0;
  // Spread tier1 to top-level (executive_summary, top_opportunities, etc.
  // remain at the same path renderMarketReport already reads), then layer
  // Call B on top, then attach the tier2/tier3 arrays as new fields the
  // per-card renderer can look up by rank.
  const merged = {
    ...(tier1 || {}),
    ...(B || {}),
    tier2_insights,
    tier3_insights,
  };
  console.log(`[tier5-dive] merged in ${dt}ms — opps=${(merged.top_opportunities || []).length} personas=${(merged.personas || []).length} tier2=${tier2_insights.length} tier3=${tier3_insights.length} A=${A ? 'ok' : 'null'} B=${B ? 'ok' : 'null'}`);
  return merged;
}

// ─────────────────────────────────────────────────────────────────────
// MAIN — analyzeCity()
// ─────────────────────────────────────────────────────────────────────
async function analyzeCity(city, state, apiKeys) {
  const cacheKey = `market:v2:${city.toLowerCase()}|${state.toLowerCase()}`;
  const cached = MARKET_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < MARKET_TTL) {
    console.log(`[market-cache] hit for ${cacheKey}`);
    return cached.data;
  }

  const apiKey = (apiKeys && apiKeys.google) || process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY required');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required');

  console.log(`[market] starting analysis for ${city}, ${state}`);
  const t0 = Date.now();

  // ── Geocode ──
  const place = await places.findPlace(`${city}, ${state}`, apiKey);
  if (!place) throw new Error(`Could not geocode ${city}, ${state}`);
  const lat = (place.geometry && place.geometry.location && place.geometry.location.lat) || place.lat;
  const lon = (place.geometry && place.geometry.location && place.geometry.location.lng) || place.lon;
  if (lat == null || lon == null) throw new Error('Geocoding returned no coordinates');
  const geo = { lat, lon, formatted: place.formatted_address || `${city}, ${state}` };
  console.log(`[market] geocoded → lat=${lat} lon=${lon} formatted="${geo.formatted}"`);

  // ── Tier 2 — Claude orchestrator (20 business types) ──
  const businessTypes = await getBusinessTypes(city, state);

  // ── Pre-resolve zip + countyFIPS + census so all 4 agents can run
  // truly parallel without forward dependencies. zip drives census;
  // population from census drives competition radius. Fetching once
  // upfront is cheaper than letting two agents race the same call.
  const [zip, countyFIPS] = await Promise.all([
    dataFetchers.fetchZipByCity(city, state).catch(() => null),
    dataFetchers.fetchCountyFIPSByCity(city, state).catch(() => null),
  ]);
  const census = zip
    ? await dataFetchers.fetchCensusByZip(zip, city, state, countyFIPS).catch(() => null)
    : null;
  const population = (census && census.total_population) || null;
  console.log(`[market] zip=${zip || '✗'} countyFIPS=${countyFIPS || '✗'} pop=${population || '✗'}`);

  // ── Tier 3 — 4 parallel agents ──
  const [market, demographics, competition, cost] = await Promise.all([
    dataAgents.runMarketAgent(city, state, geo, businessTypes, countyFIPS),
    dataAgents.runDemographicsAgent(city, state, geo, zip, countyFIPS, census),
    dataAgents.runCompetitionAgent(city, state, geo, businessTypes, apiKey, population),
    dataAgents.runCostAgent(city, state, businessTypes, countyFIPS),
  ]);

  // ── Tier 4 — score all 20, return top 10 ──
  const scored = marketScorer.scoreBusinessTypes({
    businessTypes,
    market,
    demographics,
    competition,
    cost,
  });
  console.log(`[market] tier-4 scored → top: ${scored.slice(0, 3).map((s) => s.business_type + ' ' + s.final_score).join(' · ')}`);

  // ── Tier 5a — why_this_city for top 10 (one call) ──
  const whyMap = await generateWhyThisCity(city, state, scored, market, demographics);
  for (const card of scored) {
    card.why_this_city = whyMap[card.business_type] || '';
  }

  // ── Tier 5b — Call A handles tier1 deep dive on #1 + tier2/tier3
  // entries for ranks 2-10. Call B handles personas/seasonal/hyper-local
  // for the #1 only (unchanged). We pass the full scored top10 so Call A
  // has the business_type strings for ranks 2-10.
  const deepDive = scored.length > 0
    ? await generateDeepDive(city, state, scored, market, demographics, competition)
    : null;

  // ── _provenance — full review snippets that fed Claude's deep dive.
  // Stored at top level (not inside _agents.competition_summary) so the
  // post-analysis verifyQuotes() step has fast access. Each snippet is
  // an object { text, author, time } so the verifier can render
  // attribution alongside the verified badge.
  const _provenance = {
    fetched_at: new Date().toISOString(),
    radius_meters: competition && competition._radius,
    local_businesses: ((competition && competition.local_businesses) || []).map((b) => ({
      place_id: b.place_id || null,
      name: b.name,
      rating: b.rating,
      review_count: b.review_count,
      review_snippets: b.review_snippets || [],
    })),
  };

  const result = {
    city, state,
    location: geo.formatted,
    top10: scored,
    deep_dive: deepDive,
    _provenance,
    raw: {
      population: demographics.population,
      median_income: demographics.median_income,
      age_profile: demographics.age_profile,
      peak_month: market.weather && market.weather.peak_month,
      permits_yoy: market.permits && market.permits.building_permits_yoy_change,
      fmr_2br: demographics.fmr_2br,
      fmr_metro: demographics.fmr_metro,
      events_count: (market.events || []).length,
      businesses_scanned: (competition.local_businesses || []).length,
      types_evaluated: businessTypes.length,
      growth_signal: market.growth_signal,
    },
    _agents: {
      // Slim summaries so the chat endpoint can re-cite without
      // sending the full review text back through Claude.
      market: {
        events_count: (market.events || []).length,
        weather: market.weather,
        permits: market.permits,
        city_wiki: market.city_wiki,
        growth_signal: market.growth_signal,
      },
      demographics,
      cost: {
        commercial_rent_est: cost.commercial_rent_est,
        permit_complexity: cost.permit_complexity,
        fmr_2br: cost.fmr_2br,
        fmr_metro: cost.fmr_metro,
      },
      competition_summary: {
        local_businesses_count: (competition.local_businesses || []).length,
        dominant_personas: competition.dominant_personas || [],
        radius_meters: competition._radius,
      },
    },
  };

  MARKET_CACHE.set(cacheKey, { ts: Date.now(), data: result });
  const dt = Date.now() - t0;
  console.log(`[market] complete for ${city}, ${state} in ${dt}ms — top10:${scored.length} dive:${deepDive ? 'ok' : '✗'}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// TIER 5c — chatFollowUp
// ─────────────────────────────────────────────────────────────────────
// Q&A on the cached analysis. Errors loudly if the city hasn't been
// analyzed yet (the front-end should always run /market-analysis first).
async function chatFollowUp(city, state, question) {
  if (!city || !state || !question || !question.trim()) {
    throw new Error('city, state, and question are required');
  }
  const cacheKey = `market:v2:${city.toLowerCase()}|${state.toLowerCase()}`;
  const cached = MARKET_CACHE.get(cacheKey);
  if (!cached) {
    throw new Error(`No analysis cached for ${city}, ${state}. Run /market-analysis first.`);
  }
  if (!client) throw new Error('Anthropic client not initialized');

  const data = cached.data;
  // Build a compact summary that gives Claude the analysis essentials
  // without the full review text (cuts input tokens to ~2-3K).
  const top10Summary = (data.top10 || []).slice(0, 10).map((c) =>
    `${c.rank}. ${c.business_type} — final ${c.final_score} (gap ${c.score_breakdown.gap_score} | feas ${c.score_breakdown.feasibility_score} | growth ${c.score_breakdown.growth_score}) | ${c.competitor_count == null ? '?' : c.competitor_count} competitors | ${c.startup_cost_range} | survival y5 ${c.survival_y5 || '—'}\n   why: ${c.why_this_city || '(no narrative)'}`
  ).join('\n\n');

  const dive = data.deep_dive || {};
  const diveSummary = `EXECUTIVE: ${dive.executive_summary || '—'}
HEALTH SCORE: ${dive.health_score || '—'} (${dive.health_label || '—'}, grade ${dive.market_grade || '—'})
TOP OPPORTUNITIES: ${(dive.top_opportunities || []).slice(0, 3).map((o) => o.title || o.business_type).join('; ')}
QUICK WINS: ${(dive.quick_wins || []).slice(0, 3).map((q) => q.action).join('; ')}
PERSONAS: ${(dive.personas || []).map((p) => p.name + ' (' + (p.profile || '').substring(0, 60) + ')').join(' | ')}
LOST CUSTOMER: ${dive.lost_customer && dive.lost_customer.name ? dive.lost_customer.name + ' — ' + (dive.lost_customer.fix || '') : '—'}
SBA RISK: ${dive.sba_risk && dive.sba_risk.risk_level ? dive.sba_risk.best_sector + ' — ' + dive.sba_risk.risk_level : '—'}`;

  const prompt = `You answered this market analysis for ${city}, ${state}. The user has a follow-up question.

CITY: ${city}, ${state}
LOCATION: ${data.location}

DEMOGRAPHICS / MARKET:
- Population: ${data.raw.population || 'N/A'}
- Median income: $${data.raw.median_income || 'N/A'}
- Age profile: ${data.raw.age_profile || 'N/A'}
- Peak month: ${data.raw.peak_month || 'N/A'}
- Permits YoY: ${data.raw.permits_yoy != null ? data.raw.permits_yoy + '%' : 'N/A'}
- 2BR FMR: $${data.raw.fmr_2br || 'N/A'}
- Growth signal: ${data.raw.growth_signal}

TOP 10 RANKED:
${top10Summary}

DEEP DIVE on #1 (${(data.top10 && data.top10[0] && data.top10[0].business_type) || '?'}):
${diveSummary}

USER QUESTION: ${question}

Answer specifically using the analysis data above. If the answer isn't supported by the data, say so plainly. Keep the answer to 2-4 short paragraphs. No markdown headings, just prose.`;

  const text = await callClaude(prompt, MAX_TOKENS_CHAT, 'tier5-chat');
  return { answer: (text || '').trim() };
}

module.exports = {
  analyzeCity,
  getBusinessTypes,
  chatFollowUp,
  // Exposed for diagnostics / tests
  _safeJSON: safeJSON,
  _callClaude: callClaude,
  _generateWhyThisCity: generateWhyThisCity,
  _generateDeepDive: generateDeepDive,
  _MARKET_CACHE: MARKET_CACHE,
};

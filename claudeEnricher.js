/* claudeEnricher.js — Phase 5
   Sends a deterministic data bundle to Claude after Phase 4's ranker
   produces top-10 recommendations. Claude returns:
     - enriched WHY-IT-WORKS / WHY-YOUR-BUSINESS for the top 3 recs
     - 10 opportunity ideas (drawn from the profile's opportunity_categories
       list when present, else the 18 generic categories) specific to the
       business's city/state
     - a one-paragraph local_context

   Architecture per Phase 5 spec:
     1-5. Deterministic work (Layer 0, Places, Census, triggers, ranker)
     6.   ⇣ THIS MODULE — Claude enrichment ⇣
     7.   Report renders with enriched content (or falls back if API fails)

   Implementation choice: uses the official @anthropic-ai/sdk rather than
   raw fetch because (a) the prompt-caching skill recommends it, (b) it
   gives us typed exceptions + automatic retries on 429/5xx, and (c) it
   lets us mark the system prompt as cacheable — that single change cuts
   ~90% of the input-token cost on every call after the first within the
   5-minute cache window. The user's spec showed `fetch()` as a sample
   shape; the SDK call below produces the same wire request. */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';
// Bumped 3000 → 8000 → 12000. The 8000 ceiling unlocked the 3-rec case
// (~4000 tokens). The 12000 ceiling adds headroom for the new
// priority_actions array (5-7 entries × ~150-300 tokens = ~1500-2100
// extra) on top of the existing enriched_recommendations + opportunities
// + 90-day plan + seasonal_strategy + competitor_analysis. Billed on
// actual output tokens, so the higher cap costs nothing for shorter
// reports.
const MAX_TOKENS = 12000;

// 24h in-memory cache keyed by place_id. Same Map pattern as the
// google-places details cache (Phase 4 fix-batch).
const CLAUDE_CACHE = new Map();
const CLAUDE_TTL_MS = 24 * 60 * 60 * 1000;

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const SYSTEM_PROMPT = `You are BizRadar's AI recommendation engine.
You receive verified real data about a specific local business. Your job is two things:

1. Enrich the top 3 recommendations with psychology framework and local reasoning.

2. Generate 10 specific opportunity ideas, drawing from at least 8 different opportunity categories — ideas nobody within 10 miles of this business is doing. The user prompt will list the categories defined for this profile; if no profile-specific list is present, draw from the 18 generic categories below.

STRICT RULES:
- Only use facts from the data bundle provided
- Never invent statistics not in the bundle
- Never cite studies not in study_details array
- Only use magnitudes from provided studies
- For opportunity ideas: be SPECIFIC — name real local things (real events, real producers, real landmarks near this city and state)
- Never write generic phrases like "improve customer service" or "add local items"
- Every opportunity must have a cost estimate and a revenue estimate
- Psychology must be real human behavior theory
- Tag every Layer 3 claim as one of: [VERIFIED] [REASONABLE INFERENCE] [CUSTOMER MUST VALIDATE]
- Respond in valid JSON only. No markdown. No preamble. No explanation outside JSON.

LAYER 2 — WHY IT WORKS (mandatory 3-sentence structure):
The why_it_works field MUST contain exactly three sentences in this order:

  Sentence 1 — What happens in the customer's BRAIN or emotional state.
              Describe the felt experience or cognitive shift, not what the
              study found. Start with "When ..." or "As ..." to keep the
              focus on the customer's mental state.

  Sentence 2 — The specific psychological mechanism, named explicitly.
              Use real human-behavior theory: parasocial trust, social proof,
              reciprocity, loss aversion, anchoring, peak-end rule, mere
              exposure effect, scarcity heuristic, ambiguity aversion,
              availability heuristic, commitment-and-consistency, default
              effect, status-quo bias, costly-signaling, identity-based
              choice. Name it.

  Sentence 3 — Why this mechanism is especially powerful for THIS type of
              business (e.g., hotels specifically, dental specifically,
              auto-repair specifically). Tie the mechanism to a feature of
              the sector — what's at stake, who the customer is, what they're
              uncertain about, why this signal cuts through.

Worked example for a hotel response-rate recommendation:
"When a potential guest reads reviews before booking they are not evaluating
past guests — they are evaluating YOU as an operator. An owner response
triggers parasocial trust: the reader feels they know how you handle
problems before booking. For hotels specifically, where guests are paying
to sleep somewhere unfamiliar, this trust signal reduces perceived booking
risk dramatically."

LAYER 3 — WHY YOUR BUSINESS (mandatory structure):
The why_your_business field MUST be 3-5 short sentences, each one tagged
with [VERIFIED], [REASONABLE INFERENCE], or [CUSTOMER MUST VALIDATE] at the
start of the sentence. Requirements:

  - Reference ACTUAL numbers from the data bundle: real google_rating, real
    google_review_count, real review_recency_days, real competitor counts,
    real competitor_median_rating, real median_household_income, real ZIP,
    real chain_name, real top-3 competitor names. Quote the numbers; do not
    paraphrase.
  - At least one sentence MUST mention specific local geography for THIS
    city/state — nearby attractions, landmarks, events, or named competitors
    drawn from the bundle. No generic "this market" framing.
  - NEVER use these forbidden phrases (or paraphrases of them):
      * "typical for businesses like yours"
      * "depends on execution quality"
      * "varies based on your specific situation"
      * "the exact lift you'll see depends on..."
      * any other vague hand-wave that doesn't cite a specific number or
        named local entity.
  - Tag distribution: usually 2x [VERIFIED] (the data-grounded numbers),
    1x [REASONABLE INFERENCE] (a logical extension that uses the local
    context), and optionally 1x [CUSTOMER MUST VALIDATE] (something only
    the operator can confirm).

Bad example — DO NOT WRITE THIS:
"This pattern is typical for businesses like yours; the exact lift you'll
see depends on execution quality."

Good example — WRITE LIKE THIS:
"[VERIFIED] AmericInn has 354 reviews with 0% response rate — the highest-
return zone of the response curve per S004.
[VERIFIED] 19 competitors within 5 miles all share the same 4.2★ median —
response rate is a free differentiator none of them are using.
[REASONABLE INFERENCE] In a tourism market near House on the Rock and
Governor Dodge State Park, guests researching accommodation compare
multiple options — visible owner engagement tips the decision."

OUTPUT FORMAT:
{
  "priority_actions": [
    {
      "id": "stable kebab-case id (e.g. rec_photo_volume, rec_cinema_partner, rec_phish_event)",
      "impact": "HIGH | MEDIUM | LOW | MINIMAL",
      "source": "AI",
      "title": "short specific title that cites real data — e.g. 'Upload 30 photos — you have 10 vs Swagat at 1.1mi'",
      "what": "exact steps. Names real venues / events / competitors / streets from the bundle. No generic 'find a partner' / 'use social media' / 'engage customers'.",
      "why": "references actual numbers from the bundle (photo_count, review_recency_days, competitor names + ratings + distances, response_rate_estimated, median_household_income, anchor_tenant_names, upcoming_events). No hand-waving.",
      "money_estimate": "$X,000-$Y,000/year. Math: <one-line calculation showing the unit economics>",
      "cost": "$X one-time | $X/month | $0",
      "timeline": "This week | Month 1 | Month 2 | Q3"
    }
  ],
  "enriched_recommendations": [
    {
      "id": "rec_id matching input",
      "what": "1-2 sentence concrete action",
      "why_it_works": "exactly 3 sentences following the LAYER 2 structure above (brain/feeling → named mechanism → why this sector)",
      "study_citation": "full citation text",
      "magnitude": "specific number from study",
      "why_your_business": "3-5 short sentences, each starting with [VERIFIED] / [REASONABLE INFERENCE] / [CUSTOMER MUST VALIDATE]. MUST cite real numbers from the bundle and at least one named local entity. NEVER use forbidden phrases listed above.",
      "money_estimate": {
        "range": "$X,000-$Y,000/year",
        "math": "one line calculation",
        "caveat": "Track [KPI] monthly",
        "show": true
      }
    }
  ],
  "opportunities": [
    {
      "category": "one of the 18 categories",
      "title": "short specific title",
      "idea": "2-3 sentences. Name real local things specific to this city and state. Never generic.",
      "cost": "$X one-time or $X/month",
      "revenue_potential": "$X-$Y per year",
      "novelty": "zero competitors doing this within 10 miles / rare / common",
      "review_mention_probability": "high/medium/low"
    }
  ],
  "local_context": "2-3 sentences about this specific business in this specific location. Use real local knowledge about this city, state, nearby attractions, local economy. No invented facts.",
  "competitor_analysis": {
    "what_they_do_better": [
      {
        "competitor_name": "exact name from the Top competitors list",
        "advantage": "what this competitor is doing better than the business — short phrase",
        "evidence": "the specific data point that proves it (e.g. 'rated 4.6★ vs your 4.2★' or '1,820 reviews vs your 354'). When top_reviews is available for the competitor, the evidence MUST cite a real verbatim quote — see STEAL STRATEGY RULE below.",
        "your_action": "one concrete, specific thing the business should do in response — not generic advice"
      }
    ],
    "what_you_can_win": [
      {
        "opportunity": "named, specific area where this business has an edge over the listed competitors",
        "evidence": "the data point or local-context fact that makes this winnable",
        "action": "the specific move to capture that edge"
      }
    ],
    "summary": "exactly 2 sentences. The first names the strongest competitor and the single biggest gap. The second states whether the business is ahead, behind, or competitive overall against the listed set."
  },
  "ninety_day_plan": {
    "month_1": {
      "theme": "string — what month 1 is focused on (e.g. 'Foundation: Reviews + Response')",
      "week_1": "string — specific actions to take in week 1. Reference real local businesses/events by name.",
      "week_2": "string — specific actions to take in week 2",
      "week_3": "string — specific actions to take in week 3",
      "week_4": "string — specific actions to take in week 4",
      "goal": "string — what success looks like by end of month 1 (e.g. 'response rate above 50% on Google reviews')"
    },
    "month_2": {
      "theme": "string — what month 2 is focused on",
      "focus": "string — main actions this month, less granular than month 1",
      "goal": "string — what success looks like by end of month 2"
    },
    "month_3": {
      "theme": "string — what month 3 is focused on",
      "focus": "string — main actions this month + measurement of months 1-2 results",
      "goal": "string — what success looks like by end of month 3"
    }
  },
  "seasonal_strategy": {
    "summer": {
      "dominant_persona": "string — who peaks in summer for this business in this city",
      "what_to_add": "string — specific product/service to add this season",
      "marketing_message": "string — exact headline to use in summer campaigns",
      "event_tie_in": "string — REAL named local event from upcoming_events block, or known regional annual event for this city/state",
      "local_partner": "string — REAL named local business from competitors or nearby_venues block",
      "revenue_range": "$X,000-$Y,000/month"
    },
    "fall": {
      "dominant_persona": "string",
      "what_to_add": "string",
      "marketing_message": "string",
      "event_tie_in": "string — REAL named",
      "local_partner": "string — REAL named",
      "revenue_range": "$X,000-$Y,000/month"
    },
    "winter": {
      "dominant_persona": "string",
      "what_to_add": "string",
      "marketing_message": "string",
      "event_tie_in": "string — REAL named",
      "local_partner": "string — REAL named",
      "revenue_range": "$X,000-$Y,000/month",
      "off_season_survival": "REQUIRED for cold-winter markets (weather.has_cold_winter === true) — specific strategy for the slowest month. Name the play."
    },
    "spring": {
      "dominant_persona": "string",
      "what_to_add": "string",
      "marketing_message": "string",
      "event_tie_in": "string — REAL named",
      "local_partner": "string — REAL named",
      "revenue_range": "$X,000-$Y,000/month"
    }
  }
}

PRIORITY ACTIONS — MANDATORY RULES:

Generate 5-7 priority_actions.

CAP: MAX 1 action can be review-related (rating, review count,
review recency, response rate, photo count). The other 4-6 MUST
be operational, partnership, revenue, seasonal, or competitive.
Reason: deterministic registry recommendations are dominated by
review levers; priority_actions exist to surface the OTHER moves
the operator can make. Putting 6 review actions in one report is
the failure mode this section was added to fix.

ORDERING: sort by impact descending (HIGH → MEDIUM → LOW →
MINIMAL). The 1 allowed review action goes LAST, regardless of
its impact label.

SPECIFICITY RULES — non-negotiable:

Every action MUST reference real data from the bundle. Generic
advice is forbidden.

GOOD title: "Upload 30 photos — you have 10 vs Swagat at 1.1mi"
BAD title:  "Upload photos to Google"

GOOD what: "Walk to Marcus Point Cinema (387m away) this week
            and propose a Dinner+Movie combo: diners showing a
            same-day movie ticket get 10% off entrée. Print 50
            table-tent cards."
BAD what:  "Partner with a nearby business"

GOOD event: "Phish plays Kohl Center July 7-8, 2026 — create a
             Show Night Thali at $38 for ticket holders. Promote
             on r/phish and r/madisonwi 2 weeks before."
BAD event:  "Capitalize on local events"

REQUIRED FIELDS per action:
  - id            : stable kebab-case identifier
  - impact        : HIGH / MEDIUM / LOW / MINIMAL
  - source        : always "AI" for these
  - title         : short, specific, cites real data
  - what          : exact steps; names real venues / competitors / events
  - why           : references actual numbers from the bundle
  - money_estimate: dollar range PLUS one-line math showing unit economics
  - cost          : exact cost to implement ($0 / $X one-time / $X/month)
  - timeline      : This week / Month 1 / Month 2 / Q3

DATA FIELDS to draw from when generating actions:
  google.photo_count            → photo-volume action
  google.review_recency_days    → review-freshness action (the 1 allowed review action, often)
  google.response_rate_estimated→ owner-engagement action (also a review action)
  upcoming_events               → event-tie-in action (named event + date)
  nearby_venues                 → partnership action (named venue + distance)
  competitors.top5              → steal/positioning action (named competitor + rating + distance)
  location_signals.anchor_tenants → anchor-tenant cross-promo action
  census.median_household_income→ pricing/positioning action
  weather.has_cold_winter       → off-season survival action
  weather.peak_month            → peak-prep action
  google.rating                 → rating-improvement action (review)
  google.review_count           → review-volume action (review)

COUNTING the cap: review-related = any action whose primary
lever is one of: rating, review count, review recency, response
rate, photo count. If you write a partnership action that
mentions reviews as a side effect, that's NOT a review action.

If the bundle has rich non-review data (events, anchor tenants,
competitor names, weather), you should easily produce 4-6
non-review actions. If the bundle is sparse (no events, no
anchors), still produce at least 4 non-review actions using
universal levers (loyalty programs, referral programs, channel
expansion, off-peak pricing, repeat-visit incentives).

COMPETITOR ANALYSIS RULES:
- Use ONLY the Top competitors list provided in the user prompt — never invent competitor names, ratings, or attributes.
- Base what_they_do_better ONLY on data we actually have: rating, review count, distance. Do NOT invent features, amenities, hours, prices, or service quality we did not measure.
- If a competitor has more reviews than the business, that's a flag (volume/visibility advantage).
- If a competitor has a higher rating than the business, that's a flag (perceived-quality advantage).
- If ALL listed competitors have lower ratings AND fewer reviews than the business, say so plainly in summary — the business is ahead overall.
- what_you_can_win must name SPECIFIC actionable advantages drawn from the bundle (rating delta, review-volume lead, named local landmark proximity, anchor-tenant proximity, etc.). Never generic advice like "improve service."
- If search_radius_miles in the prompt is greater than 5 miles, the local market is thin — note "local competition is thin — regional competitors shown" verbatim in summary.
- If the Top competitors list is empty, return what_they_do_better: [], what_you_can_win: [], and summary: "No competitors found in the search radius — direct comparison unavailable."
- Aim for 1-3 entries each in what_they_do_better and what_you_can_win. Skip an array (return []) rather than padding with weak items.

STEAL STRATEGY RULE — MANDATORY:
competitor_analysis.what_they_do_better entries MUST cite real review quotes from competitors.top5[].top_reviews when those quotes are available.

Format required:
  "[Competitor name] earns 5-star reviews for [specific thing]. Evidence: [exact quote from top_reviews]"

When top_reviews is empty for a competitor, write:
  "Insufficient review data to cite specific evidence for [competitor name]"

NEVER invent a competitor strength without a real review quote to support it.
NEVER claim a competitor is good at something without citing their actual customer reviews.
The previous behavior — inferring "competitor X excels at customer service" from rating delta alone — is now forbidden when top_reviews are present.

90-DAY ACTION PLAN RULES:
Generate ninety_day_plan with three months of progressive depth.

Month 1 (highest specificity):
  - Theme: focus on the SINGLE highest-impact action from enriched_recommendations[0]
  - Break it into 4 weekly steps — specific enough that the owner knows exactly what to do each Monday morning
  - Reference real local businesses, real events, and real numbers from the bundle
  - Bad: "improve customer service"
  - Good: "Respond to the 3 most recent negative Google reviews by Tuesday. Use the template: 'Hi [name], we hear you on [specific complaint]. Reach me directly at [phone] — I'd like to make this right.'"
  - Goal must be measurable (e.g., "Hit 50% owner-response rate by end of month")

Month 2 (medium specificity):
  - Build on Month 1 progress
  - Focus on enriched_recommendations[1] (the 2nd highest-impact action)
  - Less granular than Month 1 (no weekly breakdown — month-level focus + goal)

Month 3 (consolidation):
  - Measure results from Months 1 and 2 against their goals
  - Start enriched_recommendations[2] (the 3rd highest-impact action)
  - Goal frames the 90-day result in business terms, not vanity metrics

Every action must reference THIS business in THIS location. Forbidden phrases include "improve customer service," "engage with customers," "leverage social media," "build community" — replace with named, dated, specific actions.

SEASONAL STRATEGY RULES:
Generate seasonal_strategy with all four seasons.

- Every season's event_tie_in MUST name a REAL local event. Check upcoming_events first. If no events found in the data, use a known regional annual event for this city/state. Generic phrasings like "summer festivals" or "holiday shopping season" are forbidden.
- Every season's local_partner MUST be a real named business from the competitors or nearby_venues block in the bundle. Generic "a local cafe" / "a nearby gym" forbidden.
- Cold-winter markets (when bundle.weather.has_cold_winter is true) MUST include winter.off_season_survival — a specific strategy for the slowest month, naming the actual play (subscription pre-sales, B2B catering pivot, off-season events, etc.).
- Revenue ranges are projections, not guarantees — write them plainly as $X,000-$Y,000/month with no honesty tag.
- Every season must reference THIS business in THIS location. The summer plan for a hotel in Dodgeville WI must look different from the summer plan for a hotel in Miami FL.

DISTANCE RULE — MANDATORY:
Never state a numeric distance in miles to any city other than the subject business location.

WRONG: "Madison 70 miles east"
WRONG: "45 miles from Milwaukee"
WRONG: "located 30 miles from Chicago"

CORRECT: "near Madison"
CORRECT: "within driving distance of the Madison metro"
CORRECT: "between Madison and the Mississippi River"

You do not have verified distance data to nearby cities. Do not invent it. Only use distances that appear in the data provided to you — competitor distances (competitors.top5[].distance_miles) and venue distances (nearby_venues[].distance_meters) are computed from real lat/lon and are verified. City-to-city distances are NOT in the bundle and must never be stated as numeric miles.

This applies to every output field — local_context, why_your_business, opportunities, ninety_day_plan, seasonal_strategy, competitor_analysis. ALL of them.

THE 18 OPPORTUNITY CATEGORIES (fallback list — only used when the user prompt does NOT supply a profile-specific opportunity_categories list. Draw from at least 8 of these for the 10 opportunities):
1. Sensory experience
2. Naming and language
3. Photo moments
4. Memory triggers
5. Check-in / arrival experience
6. Local insider knowledge
7. Pricing psychology
8. Loyalty triggers
9. Partnership webs
10. Off-season reinvention
11. Content and PR
12. Tech-light ideas
13. Service recovery
14. Review generation
15. Niche ownership
16. Food and beverage
17. Community and cause
18. Staff empowerment`;

// ───────────────────────────────────────────────────────────────────
// Address parsing — extract city/state/zip from Google's formatted_address
// ───────────────────────────────────────────────────────────────────
function parseAddress(formatted) {
  if (!formatted || typeof formatted !== 'string') {
    return { street: null, city: null, state: null, zip: null };
  }
  // Typical: "3637 WI-23, Dodgeville, WI 53533, USA"
  const trimmed = formatted.replace(/, USA$/, '');
  const m = trimmed.match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (m) {
    return { street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4] };
  }
  // Fallback: just pull the ZIP and the segment before " ST 12345"
  const zipMatch = trimmed.match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
  if (zipMatch) {
    return { street: null, city: null, state: zipMatch[1], zip: zipMatch[2] };
  }
  return { street: null, city: null, state: null, zip: null };
}

// ───────────────────────────────────────────────────────────────────
// Build the data bundle from Phase 1-4 deterministic outputs
// ───────────────────────────────────────────────────────────────────
function buildDataBundle({ data, profile, layer0Result, ranked, studies }) {
  const addr = parseAddress(data.formatted_address || '');
  const top3 = (ranked.top10 || []).slice(0, 3);

  return {
    business: {
      name: data.name || '',
      address: data.formatted_address || '',
      city: addr.city,
      state: addr.state,
      zip: addr.zip || data.census_zip || null,
      naics6: layer0Result.naics6,
      sector_label: profile.name,
      is_chain: !!data.is_chain,
      chain_name: data.chain_name || null,
    },
    // Profile-specific opportunity-category override. When present on
    // the profile, the user prompt will instruct Claude to draw from
    // these instead of the 18 generic categories in the system prompt.
    // If absent (which it is on every current profile, 2026-05-08),
    // bundle.opportunity_categories is null and the prompt falls back.
    opportunity_categories: Array.isArray(profile.opportunity_categories)
      ? profile.opportunity_categories
      : null,
    google: {
      rating: typeof data.google_rating === 'number' ? data.google_rating : null,
      review_count: typeof data.google_review_count === 'number' ? data.google_review_count : null,
      review_recency_days: typeof data.review_recency_days === 'number' ? data.review_recency_days : null,
      photo_count: typeof data.photo_count === 'number' ? data.photo_count : null,
      responds_to_reviews: data.responds_to_reviews === true,
      // Numeric response rate (0.0-1.0) — added so priority_actions can
      // cite the actual rate (e.g. "0% across 1,392 reviews") instead of
      // just the boolean. Falls back to null when not measured.
      response_rate_estimated: typeof data.response_rate_estimated === 'number'
        ? data.response_rate_estimated
        : null,
      hours_complete: data.hours_complete === true,
      website_exists: data.website_exists,
      sample_reviews: (data.sample_reviews || []).slice(0, 5).map((r) => ({
        text: (r.text || '').slice(0, 500),
        stars: typeof r.rating === 'number' ? r.rating : null,
      })),
    },
    competitors: {
      count: typeof data.competitor_count === 'number' ? data.competitor_count : null,
      median_rating: typeof data.competitor_median_rating === 'number' ? data.competitor_median_rating : null,
      median_review_count: typeof data.competitor_median_review_count === 'number' ? data.competitor_median_review_count : null,
      // Phase 5+ — top5 (with back-compat top3 slice) plus the actual
      // search radius the fetcher landed on, so Claude can flag thin
      // local markets in its competitor_analysis.summary.
      // FIX 1 — top_reviews: real competitor review snippets fetched by
      // googlePlaces.fetchNearbyCompetitors (Place Details enrichment).
      // SYSTEM_PROMPT's STEAL STRATEGY RULE requires Claude to cite these
      // verbatim in competitor_analysis.what_they_do_better instead of
      // inferring competitor strengths from rating numbers alone.
      top5: Array.isArray(data.competitors_top5) ? data.competitors_top5.map((c) => ({
        name: c.name,
        rating: c.rating,
        review_count: c.review_count,
        distance_miles: typeof c.distance_meters === 'number' ? +(c.distance_meters / 1609.34).toFixed(2) : null,
        top_reviews: Array.isArray(c.reviews) ? c.reviews.map((r) =>
          `[${r.rating != null ? r.rating + '/5' : '—'} ${r.time || 'recent'}]: "${(r.text || '').slice(0, 300)}"`
        ) : [],
      })) : [],
      top3: Array.isArray(data.competitors_top3) ? data.competitors_top3.map((c) => ({
        name: c.name,
        rating: c.rating,
        review_count: c.review_count,
        distance_miles: typeof c.distance_meters === 'number' ? +(c.distance_meters / 1609.34).toFixed(2) : null,
      })) : [],
      search_radius_miles: typeof data.search_radius_miles === 'number' ? data.search_radius_miles : null,
    },
    // FIX 4 — review sample size. The number of reviews Google's legacy
    // Places Details actually returned (max 5). Used by renderReport to
    // suppress the misleading "0% owner-response rate" callout when the
    // sample is too small to draw any conclusion.
    review_sample_size: typeof data.reviews_sampled === 'number' ? data.reviews_sampled : 0,
    census: {
      median_household_income: typeof data.median_household_income === 'number' ? data.median_household_income : null,
      population: typeof data.total_population === 'number' ? data.total_population : null,
    },
    // Phase 5+ — three free data sources added to give Claude real
    // seasonal context, website-quality signals, and on-the-ground
    // location detail (anchor proximity, transit). Used in the
    // "opportunities" generation step to make ideas more specific.
    weather: data.weather ? {
      peak_month: data.peak_month,
      peak_tourist_season: data.peak_tourist_season,
      has_cold_winter: data.has_cold_winter,
      has_hot_summer: data.has_hot_summer,
    } : null,
    pagespeed: data.pagespeed ? {
      mobile_score: data.website_mobile_score,
      load_time_seconds: data.load_time_seconds,
      is_mobile_friendly: data.is_mobile_friendly,
    } : null,
    location_signals: data.location_signals ? {
      anchor_tenants: data.anchor_tenants || [],
      anchor_tenant_count: data.anchor_tenant_count,
      has_transit_nearby: data.has_transit_nearby,
      nearest_transit_meters: data.nearest_transit_meters,
    } : null,
    building_permits: data.building_permits ? {
      county_name: data.county_name,
      county_fips: data.county_fips,
      year: data.building_permits_year,
      total: data.building_permits_total,
      single_family: data.building_permits_single_family,
      yoy_change_pct: data.building_permits_yoy_change,
    } : null,
    upcoming_events: Array.isArray(data.upcoming_events) ? data.upcoming_events : [],
    // Phase 5+ — Foursquare nearby venues (food/arts/outdoors). Used by
    // Claude for partnership ideas + walkability framing in opportunities.
    nearby_venues: Array.isArray(data.nearby_venues) ? data.nearby_venues : [],
    // Phase 5+ — TripAdvisor intelligence. Sub-ratings drive specific
    // service-gap recommendations; trip_types drive segment messaging.
    tripadvisor: data.tripadvisor ? {
      rating: data.ta_rating,
      review_count: data.ta_review_count,
      ranking: data.ta_ranking,
      ranking_position: data.ta_ranking_position,
      ranking_out_of: data.ta_ranking_out_of,
      subratings: data.ta_subratings,
      awards: data.ta_awards,
      trip_types: data.ta_trip_types,
      recent_reviews: data.ta_recent_reviews,
      value_gap_detected: data.ta_value_gap_detected,
    } : null,
    // Phase 5+ — sector-conditional sources. Each is null unless the
    // business's NAICS-2 / profile_id matches the relevant sector.
    bls_employment: data.bls_employment ? {
      employment_level: data.bls_employment_level,
      employment_year: data.bls_employment_year,
      employment_period: data.bls_employment_period,
      naics2: data.sector_naics2,
    } : null,
    usda_nass: data.usda_nass ? {
      top_commodity: data.top_commodity,
      farm_count: data.farm_count,
      state_ag_profile: data.state_ag_profile,
      commodities: data.usda_nass.commodities || null,
    } : null,
    fmcsa: data.fmcsa ? {
      dot_number: data.dot_number,
      safety_rating: data.safety_rating,
      safety_rating_date: data.fmcsa.safety_rating_date,
      out_of_service_date: data.fmcsa.out_of_service_date,
      allowed_to_operate: data.allowed_to_operate,
      carrier_operation: data.fmcsa.carrier_operation,
      total_drivers: data.total_drivers,
      total_trucks: data.total_trucks,
    } : null,
    npi: data.npi ? {
      npi_number: data.npi_number,
      provider_type: data.provider_type,
      status: data.npi_status,
      credential: data.npi.credential,
      authorized: data.npi_authorized,
    } : null,
    hud_fmr: data.hud_fmr ? {
      metro_name: data.fmr_metro_name,
      fmr_studio: data.fmr_studio,
      fmr_1br: data.fmr_1br,
      fmr_2br: data.fmr_2br,
      fmr_year: data.fmr_year,
    } : null,
    fdic: data.fdic ? {
      bank_name: data.fdic_bank_name,
      total_deposits: data.fdic_total_deposits,
      total_assets: data.fdic_total_assets,
      state: data.fdic.state,
      city: data.fdic.city,
    } : null,
    cms: data.cms ? {
      facility_name: data.cms.facility_name,
      overall_rating: data.cms_overall_rating,
      patient_experience_rating: data.cms_patient_experience_rating,
      mortality_rating: data.cms_mortality_rating,
      safety_rating: data.cms_safety_rating,
      readmission_rating: data.cms_readmission_rating,
      timeliness_rating: data.cms_timeliness_rating,
    } : null,
    top3_recommendations: top3.map((t) => ({
      id: t.rec.id,
      claim: t.rec.claim,
      study_ids: t.rec.study_ids || [],
      magnitude: t.rec.magnitude,
      ease: t.rec.ease,
      score: +t.score.toFixed(2),
      impact_label: t.impact,
      study_details: (t.rec.study_ids || [])
        .map((sid) => studies.find((s) => s.id === sid))
        .filter(Boolean)
        .map((s) => ({
          id: s.id,
          tier: s.tier,
          claim: s.claim,
          magnitude: s.magnitude || s.finding_summary || '',
          citation: s.citation,
          url: s.url,
        })),
    })),
  };
}

// ───────────────────────────────────────────────────────────────────
// Build the user prompt from the bundle
// ───────────────────────────────────────────────────────────────────
function buildUserPrompt(bundle) {
  const b = bundle.business;
  const g = bundle.google;
  const c = bundle.competitors;
  const cs = bundle.census;

  const reviewLines = (g.sample_reviews || [])
    .map((r) => `★${r.stars ?? '?'}: ${r.text}`)
    .join('\n');

  const top3Lines = (c.top3 || []).map((x) => `${x.name} — ${x.rating}★ (${x.review_count} reviews, ${x.distance_miles} mi)`).join('; ');
  // Top 5 competitors as a bulleted block, plus an expansion note if the
  // fetcher had to widen the search beyond 5 miles to find ≥3 results.
  const top5 = Array.isArray(c.top5) ? c.top5 : [];
  const top5Lines = top5.length
    ? top5.map((x) => `  • ${x.name} | ${x.rating}★ | ${x.review_count} reviews | ${x.distance_miles} mi`).join('\n')
    : '  (no competitors found)';
  const radiusUsed = typeof c.search_radius_miles === 'number' ? c.search_radius_miles : null;
  const radiusLine = (radiusUsed != null && radiusUsed > 5)
    ? `\nSearch radius used: ${radiusUsed} miles (expanded because fewer than 3 competitors found locally)`
    : (radiusUsed != null ? `\nSearch radius used: ${radiusUsed} miles` : '');

  // Phase 5+ — render the three new data sources only when present so
  // Claude doesn't burn tokens reading "(unavailable)" placeholders.
  const w = bundle.weather;
  const ps = bundle.pagespeed;
  const ls = bundle.location_signals;
  let weatherSection = '';
  if (w && (w.peak_tourist_season || w.has_cold_winter || w.has_hot_summer)) {
    weatherSection = `\nWeather / seasonality (Open-Meteo, past 12 months):
Peak month: ${w.peak_month || '—'}
Peak tourist season: ${w.peak_tourist_season || '—'}
Cold winter (any month avg < 35°F): ${w.has_cold_winter}
Hot summer (any month avg > 85°F): ${w.has_hot_summer}`;
  }
  let pagespeedSection = '';
  if (ps && (ps.mobile_score != null || ps.load_time_seconds != null)) {
    pagespeedSection = `\nWebsite mobile quality (Google PageSpeed Insights):
Mobile score: ${ps.mobile_score ?? '—'}/100 ${ps.is_mobile_friendly ? '(passes mobile-friendly threshold)' : '(below mobile-friendly threshold)'}
Time-to-interactive: ${ps.load_time_seconds ?? '—'}s${ps.load_time_seconds != null && ps.load_time_seconds > 3 ? ' — above 3-second abandonment threshold (S040)' : ''}`;
  }
  let locationSection = '';
  if (ls) {
    const anchorList = (ls.anchor_tenants || []).join(', ') || '(none found within 500m)';
    const transitDesc = ls.nearest_transit_meters != null
      ? `${ls.nearest_transit_meters}m to nearest bus stop / rail station${ls.has_transit_nearby ? ' — transit-served' : ' — outside walking distance'}`
      : '(no transit found within 800m)';
    locationSection = `\nOn-the-ground location signals (OpenStreetMap):
Anchor tenants within 500m: ${anchorList} (${ls.anchor_tenant_count ?? 0} total)
Transit: ${transitDesc}`;
  }
  let permitsSection = '';
  const bp = bundle.building_permits;
  if (bp && bp.total != null) {
    const trend = bp.yoy_change_pct == null
      ? 'no prior-year comparison available'
      : bp.yoy_change_pct > 5
      ? `growing market (+${bp.yoy_change_pct}% YoY)`
      : bp.yoy_change_pct < -5
      ? `declining market (${bp.yoy_change_pct}% YoY)`
      : `stable market (${bp.yoy_change_pct >= 0 ? '+' : ''}${bp.yoy_change_pct}% YoY)`;
    permitsSection = `\nCounty building permits (${bp.county_name || 'county'}, ${bp.year}, HUD/Census BPS):
Total residential permits: ${bp.total}
Single-family: ${bp.single_family ?? '—'}
Trend: ${trend}`;
  }
  let eventsSection = '';
  const events = Array.isArray(bundle.upcoming_events) ? bundle.upcoming_events : [];
  if (events.length) {
    const lines = events.map((e) => {
      const venue = e.venue ? ` at ${e.venue}` : '';
      const when = e.date ? e.date.replace('T', ' ').slice(0, 16) : 'date TBA';
      return `  • ${e.name} — ${when}${venue}`;
    }).join('\n');
    eventsSection = `\nUpcoming events within 10 miles, next 90 days (Ticketmaster):\n${lines}`;
  }

  // Phase 5+ — Foursquare nearby venues (food/arts/outdoors).
  let venuesSection = '';
  const venues = Array.isArray(bundle.nearby_venues) ? bundle.nearby_venues : [];
  if (venues.length) {
    const lines = venues.slice(0, 10).map((v) => {
      const dist = typeof v.distance_meters === 'number' ? `${v.distance_meters}m` : '—';
      const pop = typeof v.popularity === 'number' ? ` · popularity ${v.popularity}` : '';
      return `  • ${v.name} (${v.category}, ${dist}${pop})`;
    }).join('\n');
    venuesSection = `\nNearby venues within 1km (Foursquare — food, arts, outdoors):\n${lines}`;
  }

  // Phase 5+ — BLS sector employment level.
  let blsSection = '';
  const bls = bundle.bls_employment;
  if (bls && bls.employment_level != null) {
    blsSection = `\nLocal sector employment (BLS, NAICS-${bls.naics2 || '—'}):
${bls.employment_level.toLocaleString('en-US')} jobs (${bls.employment_period || ''} ${bls.employment_year || ''})`;
  }

  // Phase 5+ — USDA NASS agriculture profile (NAICS-2 = 11).
  let usdaSection = '';
  const usda = bundle.usda_nass;
  if (usda && usda.top_commodity) {
    const breakdown = Array.isArray(usda.commodities) && usda.commodities.length
      ? usda.commodities.map((c) => `${c.commodity} ${c.acres.toLocaleString('en-US')} ac`).join(', ')
      : '';
    usdaSection = `\nUSDA NASS agriculture profile (2022, AREA HARVESTED):
Top commodity: ${usda.top_commodity}
${usda.state_ag_profile || ''}${breakdown ? `\nBy commodity: ${breakdown}` : ''}`;
  }

  // Phase 5+ — FMCSA carrier safety (NAICS-2 = 48-49).
  let fmcsaSection = '';
  const fmcsa = bundle.fmcsa;
  if (fmcsa && fmcsa.dot_number) {
    fmcsaSection = `\nFMCSA carrier record:
DOT#: ${fmcsa.dot_number}
Safety rating: ${fmcsa.safety_rating || '—'}${fmcsa.safety_rating_date ? ` (${fmcsa.safety_rating_date})` : ''}
Allowed to operate: ${fmcsa.allowed_to_operate || '—'}
Carrier operation: ${fmcsa.carrier_operation || '—'}
Drivers: ${fmcsa.total_drivers ?? '—'} · Trucks: ${fmcsa.total_trucks ?? '—'}`;
  }

  // Phase 5+ — NPI Registry (NAICS-2 = 62).
  let npiSection = '';
  const npi = bundle.npi;
  if (npi && npi.npi_number) {
    npiSection = `\nNPI Registry (healthcare provider):
NPI: ${npi.npi_number} (${npi.provider_type || '—'})
Status: ${npi.status || '—'}${npi.authorized ? ' — Active' : ' — NOT Active'}
Credential: ${npi.credential || '—'}`;
  }

  // Phase 5+ — HUD Fair Market Rents (NAICS-2 = 53).
  let fmrSection = '';
  const fmr = bundle.hud_fmr;
  if (fmr && (fmr.fmr_studio != null || fmr.fmr_1br != null || fmr.fmr_2br != null)) {
    fmrSection = `\nHUD Fair Market Rents (${fmr.metro_name || 'this metro'}, ${fmr.fmr_year || '—'}):
Studio: $${fmr.fmr_studio ?? '—'}/mo · 1BR: $${fmr.fmr_1br ?? '—'}/mo · 2BR: $${fmr.fmr_2br ?? '—'}/mo`;
  }

  // Phase 5+ — FDIC bank data (banking / finance profiles).
  let fdicSection = '';
  const fdic = bundle.fdic;
  if (fdic && (fdic.total_deposits != null || fdic.total_assets != null)) {
    const depM = fdic.total_deposits != null ? (fdic.total_deposits / 1000).toFixed(1) : '—';
    const assetM = fdic.total_assets != null ? (fdic.total_assets / 1000).toFixed(1) : '—';
    fdicSection = `\nFDIC institution profile (${fdic.bank_name || 'bank'}, ${fdic.city || '—'}, ${fdic.state || '—'}):
Total deposits: $${depM}M · Total assets: $${assetM}M`;
  }

  // Phase 5+ — CMS hospital quality ratings.
  let cmsSection = '';
  const cms = bundle.cms;
  if (cms) {
    cmsSection = `\nCMS Hospital General Information (${cms.facility_name || 'this facility'}):
Overall rating: ${cms.overall_rating ?? 'unrated'}/5 stars
Patient experience: ${cms.patient_experience_rating || '—'}
Mortality: ${cms.mortality_rating || '—'}
Safety of care: ${cms.safety_rating || '—'}
Readmission: ${cms.readmission_rating || '—'}
Timeliness: ${cms.timeliness_rating || '—'}`;
  }

  // Phase 5+ — TripAdvisor intelligence.
  let tripAdvisorSection = '';
  const ta = bundle.tripadvisor;
  if (ta && ta.rating != null) {
    const subLines = ta.subratings && Object.keys(ta.subratings).length
      ? Object.entries(ta.subratings).map(([k, v]) => `    ${k}: ${v}`).join('\n')
      : '    (no sub-ratings returned)';
    const rankPart = (ta.ranking_position && ta.ranking_out_of)
      ? `Ranked #${ta.ranking_position} of ${ta.ranking_out_of} locally`
      : (ta.ranking || '(no ranking data)');
    const awardsLine = Array.isArray(ta.awards) && ta.awards.length
      ? ta.awards.map((a) => `${a.type}${a.year ? ` (${a.year})` : ''}`).join(', ')
      : '(none)';
    const tripTypesLine = Array.isArray(ta.trip_types) && ta.trip_types.length
      ? ta.trip_types.map((t) => `${t.name}=${t.value}`).join(', ')
      : '(none)';
    const reviewLines = Array.isArray(ta.recent_reviews) && ta.recent_reviews.length
      ? ta.recent_reviews.map((r) =>
          `    [${r.rating ?? '?'}★${r.trip_type ? ' · ' + r.trip_type : ''}] ${r.title || ''}: ${r.snippet || ''}`
        ).join('\n')
      : '    (no recent reviews returned)';
    const valueGapLine = ta.value_gap_detected
      ? '\nValue-perception gap detected: value sub-rating trails overall rating by ≥0.4 — customers feel they overpaid for the experience.'
      : '';
    tripAdvisorSection = `\nTripAdvisor data (Content API):
Overall: ${ta.rating}★ across ${ta.review_count ?? '—'} reviews
${rankPart}
Sub-ratings:
${subLines}
Awards: ${awardsLine}
Trip-type mix (counts): ${tripTypesLine}
Recent reviews:
${reviewLines}${valueGapLine}`;
  }

  // Profile-specific opportunity categories (when the active profile in
  // profileRegistry.json defines an `opportunity_categories` array, use
  // it; otherwise fall back to the 18 generic categories listed in the
  // system prompt).
  const oppCats = bundle.opportunity_categories;
  const opportunityCategoriesLine = (Array.isArray(oppCats) && oppCats.length)
    ? `Generate 10 opportunities drawing from at least 8 of the opportunity categories defined in this profile: ${oppCats.join(', ')}.`
    : `Generate 10 opportunities drawing from at least 8 of the 18 opportunity categories listed in the system prompt (no profile-specific list defined for this sector).`;

  return `Generate enriched recommendations and 10 opportunity ideas for this business.

${opportunityCategoriesLine}


Business: ${b.name}
Address: ${b.address}
City/State: ${b.city || '—'}, ${b.state || '—'}
Sector: ${b.sector_label} (NAICS ${b.naics6})
Chain: ${b.is_chain ? 'yes' : 'no'} (${b.chain_name || 'independent'})

Google data:
Rating: ${g.rating ?? '—'} stars (${g.review_count ?? '—'} reviews)
Review recency: ${g.review_recency_days ?? '—'} days ago
Response rate: ${g.responds_to_reviews}
Photo count: ${g.photo_count ?? '—'}
Hours complete: ${g.hours_complete}
Website loads: ${g.website_exists}

Recent reviews (sample):
${reviewLines || '(no reviews returned)'}

Competitors:
Count: ${c.count ?? '—'}
Local median rating: ${c.median_rating ?? '—'}
Local median reviews: ${c.median_review_count ?? '—'}
Top 3: ${top3Lines || '(none)'}

Top competitors (by rating):
${top5Lines}${radiusLine}

Local demographics (ZIP ${b.zip || '—'}):
Median household income: ${cs.median_household_income != null ? '$' + cs.median_household_income.toLocaleString('en-US') : '—'}
Population: ${cs.population != null ? cs.population.toLocaleString('en-US') : '—'}
${weatherSection}${pagespeedSection}${locationSection}${permitsSection}${eventsSection}${venuesSection}${tripAdvisorSection}${blsSection}${usdaSection}${fmcsaSection}${npiSection}${fmrSection}${fdicSection}${cmsSection}

Top 3 recommendations to enrich:
${JSON.stringify(bundle.top3_recommendations, null, 2)}

Available verified studies (use ONLY these magnitudes and citations):
${JSON.stringify(bundle.top3_recommendations.flatMap((r) => r.study_details), null, 2)}

Rules reminder:
- Generate priority_actions[] (5-7 items) per the PRIORITY ACTIONS — MANDATORY RULES in the system prompt. MAX 1 review-related action; the rest must be operational/partnership/revenue/seasonal/competitive. Order by impact descending; the 1 review action goes LAST.
- Be specific to ${b.city || 'this city'}, ${b.state || 'this state'}
- Name real local businesses, events, landmarks
- Never invent statistics
- When weather, pagespeed, location_signals, building_permits, upcoming_events, nearby_venues, tripadvisor, bls_employment, usda_nass, fmcsa, npi, hud_fmr, fdic, or cms are present above, USE them in the opportunity ideas:
  • pagespeed: fire a website-speed action if load_time_seconds > 3 OR mobile_score < 50
  • upcoming_events: build seasonal opportunity ideas around named events (cross-promotion, event-day specials, partnership with the listed venues)
  • weather: seasonal off-peak ideas if has_cold_winter, peak-demand pricing ideas if has_hot_summer
  • location_signals: anchor-tenant partnership ideas if anchor_tenants is non-empty
  • building_permits: new-mover-targeting opportunities if trend is growing, contractor-partnership ideas if single-family permits are high
  • nearby_venues: name actual Foursquare venues from the list above for partnership / cross-traffic / walkability ideas. Don't say "nearby restaurants" — say "Establishment X across the street."
  • tripadvisor: use sub-ratings to identify the SPECIFIC service gap to fix (the lowest sub-rating is the highest-leverage fix; cite the exact sub-rating value). Use trip_types to identify which customer segment dominates and which one is underserved (the smallest non-zero segment is often a growth opportunity). If value_gap_detected is true, the fix is price-to-perceived-quality, not raw quality.
  • bls_employment: reference the actual sector-wide employment level + period for education/professional/healthcare/construction/retail opportunities (talent-pipeline ideas, hiring partnerships with local schools, B2B-to-employer ideas). Cite the exact number.
  • usda_nass: name the dominant crop explicitly for agriculture-sector opportunities (local-sourcing partnerships, crop-themed events, farm-to-table tie-ins). Don't say "crops" — say "soybeans" or whatever the top_commodity actually is.
  • fmcsa: surface a safety-rating gap as the top opportunity if safety_rating is anything other than "Satisfactory" — that's a regulatory liability AND a sales-pitch problem. Reference DOT# and the specific rating value.
  • npi: flag if NPI status is not Active — patients verify NPI before booking; an inactive NPI is a hard stop. Always reference the NPI number.
  • hud_fmr: use the actual rental rates ($studio / $1BR / $2BR) for pricing-strategy opportunities in real-estate / property-management contexts. Compare your pricing to FMR to find positioning gaps.
  • fdic: compare deposit and asset size to the top community banks in the state for community-banking strategy. If deposits are under $100M, target growth-niche ideas; over $1B, target retention.
  • cms: surface SPECIFIC rating gaps (e.g. "Mortality: Below the National Average") as the highest-priority opportunities for hospital improvement. Cite the exact rating string. Don't generalize to "improve quality" — point to the specific dimension.
- JSON only in response`;
}

// ───────────────────────────────────────────────────────────────────
// Main entry — enrichWithClaude
// ───────────────────────────────────────────────────────────────────
async function enrichWithClaude(bundle) {
  // ── Phase 5 debug logging (Step 1) ────────────────────────────────
  console.log('[claude] enrichment called');
  console.log('[claude] API key present:', !!process.env.ANTHROPIC_API_KEY);
  console.log('[claude] API key length:', process.env.ANTHROPIC_API_KEY?.length);
  console.log('[claude] making API request...');
  // ──────────────────────────────────────────────────────────────────

  if (!client) {
    console.warn('[claude] enrichment skipped: ANTHROPIC_API_KEY not set');
    return null;
  }
  const placeId = bundle.business && bundle.business.address;  // proxy key
  // Use a stable cache key. Phase 5 spec: "Cache Claude output 24 hours
  // per place_id". The bundle doesn't carry place_id directly (Phase 4's
  // data passes through bundle.business via address); we key on the
  // address string, which is a 1:1 proxy for place_id within Google.
  const cacheKey = 'claude_' + placeId;
  const cached = CLAUDE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CLAUDE_TTL_MS) {
    console.log(`[cache] claude hit for ${placeId}`);
    return cached.value;
  }

  const userPrompt = buildUserPrompt(bundle);
  const t0 = Date.now();
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          // Cache the system prompt (large + identical across every call).
          // 5-minute TTL is the default; first request pays ~1.25× write
          // premium, subsequent calls within the window read at ~0.1×.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    });
    const dt = Date.now() - t0;
    // ── Phase 5 debug logging (Step 2) ──────────────────────────────
    // Note: the Anthropic SDK throws on non-2xx, so a successful response
    // doesn't carry a `.status` field (will print as `undefined`). The
    // useful fields on a SDK Message are .id, .stop_reason, .usage.
    console.log('[claude] response status:', response.status);
    console.log('[claude] response id:    ', response.id);
    console.log('[claude] stop_reason:    ', response.stop_reason);
    if (response.stop_reason === 'max_tokens') {
      console.error(`[claude] response truncated — output hit MAX_TOKENS=${MAX_TOKENS}. JSON parse will fail. Bump MAX_TOKENS in claudeEnricher.js.`);
    }
    // ────────────────────────────────────────────────────────────────

    // Concatenate text blocks. Strip any ``` fences Claude might emit
    // even though we asked for raw JSON.
    const text = (response.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.warn('[claude] JSON parse failed:', parseErr.message);
      console.warn('[claude] raw text (first 400 chars):', clean.slice(0, 400));
      return null;
    }

    console.log(
      `[claude] enrichment ok in ${dt}ms — ${(parsed.enriched_recommendations || []).length} recs, ${(parsed.opportunities || []).length} opps · usage in=${response.usage.input_tokens} out=${response.usage.output_tokens} cache_read=${response.usage.cache_read_input_tokens || 0} cache_write=${response.usage.cache_creation_input_tokens || 0}`
    );

    CLAUDE_CACHE.set(cacheKey, { ts: Date.now(), value: parsed });
    return parsed;
  } catch (err) {
    // ── Phase 5 debug logging (Step 3) ──────────────────────────────
    console.error('[claude] full error:', err.message);
    console.error('[claude] error type:', err.constructor.name);
    // err.status is set on Anthropic.APIError subclasses (status code
    // from the failed HTTP response). Log it when present so you can
    // distinguish auth failures (401), rate limits (429), 5xx, etc.
    if (err.status != null) console.error('[claude] error status:', err.status);
    // ────────────────────────────────────────────────────────────────
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// Phase 5+ — Claude classification fallback
// ───────────────────────────────────────────────────────────────────
// Used when Layer 0 + Phase-3 Places fallback both fail to produce a
// NAICS-6 that resolves to a profile. We pass the raw user input + the
// best Google Places signal (place name + types[]) and ask Claude for a
// single NAICS-6 code. If it returns one and that code resolves to a
// profile (or to an OUT_OF_SCOPE_* marker), we get a real report instead
// of an "unsupported" page.
//
// Cost: one extra ~$0.002 call. Only fires when normal routing failed.
// max_tokens=50 because we just want a 6-digit number back.
const CLASSIFY_SYSTEM_PROMPT = 'You are a NAICS classification expert for U.S. small businesses. Reply with exactly one 6-digit NAICS code (the most specific one that fits the business), or "NONE" if you cannot classify it. No other text, no explanation, no preamble.';

async function classifyWithClaude(userInput, placeName, types) {
  console.log('[claude-classify] called for:', userInput);
  if (!client) {
    console.warn('[claude-classify] skipped: ANTHROPIC_API_KEY not set');
    return null;
  }
  const userPrompt = `This business could not be automatically classified.
Business name from user: ${userInput || '(empty)'}
Google place name: ${placeName || '(not found)'}
Google types: ${(Array.isArray(types) && types.length) ? types.join(', ') : '(none)'}
What type of small business is this?
Reply with just the NAICS-6 code and nothing else.`;

  const t0 = Date.now();
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 50,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const dt = Date.now() - t0;
    const text = (response.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    console.log(`[claude-classify] response in ${dt}ms: "${text}"`);

    if (/^NONE$/i.test(text)) {
      console.warn('[claude-classify] Claude declined to classify');
      return null;
    }
    const match = text.match(/\b(\d{6})\b/);
    if (!match) {
      console.warn(`[claude-classify] no 6-digit NAICS found in: "${text}"`);
      return null;
    }
    return match[1];
  } catch (err) {
    console.error('[claude-classify] error:', err.message, '/', err.constructor.name);
    if (err.status != null) console.error('[claude-classify] status:', err.status);
    return null;
  }
}

module.exports = {
  enrichWithClaude,
  classifyWithClaude,
  buildDataBundle,
  parseAddress,
  // exposed for tests / debugging
  _SYSTEM_PROMPT: SYSTEM_PROMPT,
  _buildUserPrompt: buildUserPrompt,
};

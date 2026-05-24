/* dataAgents.js — Tier 3 of the 5-tier Market Analysis pipeline.

   FOUR PARALLEL DATA AGENTS:
     - runMarketAgent       industry trends + survival + Wikipedia
     - runDemographicsAgent Census + age + FMR + anchor tenants
     - runCompetitionAgent  20 type-searches + 5 broad review searches
     - runCostAgent         feasibility tier per business type

   Each agent uses the existing dataFetchers.js + googlePlaces.js
   modules — never reimplements them, never calls Claude. Pure data
   only. All return values are simple JSON-serializable objects so
   the Tier 4 scorer (marketScorer.js) can consume them directly.

   The 5-tier pipeline is documented in the design doc; this file
   replaces the prior collectCityIntelligence() approach which mixed
   data collection with Claude prompting.

   Caching strategy:
     - Wikipedia summaries: 7-day in-memory (per spec)
     - Per-type competitor counts: 24h in-memory keyed
       businessType|city|state
     - All other fetchers: rely on dataFetchers.js's existing per-
       endpoint caches (PERMITS_CACHE, FMR_CACHE, etc.) for dedup. */

const dataFetchers = require('./dataFetchers');
const places = require('./googlePlaces');
// Audit fix DA1 — bounded caches. The previous raw `new Map()` instances
// grew unbounded under sustained traffic (one entry per unique
// city|state for WIKI_CACHE and one per type|city|state triple for
// COMP_CACHE below). LRUCache caps the entry count + enforces TTL on
// read so memory stays predictable.
const { LRUCache } = require('lru-cache');

// ── Wikipedia — 7-day cache ────────────────────────────────────────
const WIKI_TTL = 7 * 24 * 60 * 60 * 1000;
const WIKI_CACHE = new LRUCache({ max: 1000, ttl: WIKI_TTL });

// State abbreviation → full name (Wikipedia article titles use full
// state names: "Madison, Wisconsin" not "Madison, WI"). Comprehensive
// 50-state map plus DC.
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District_of_Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New_Hampshire', NJ: 'New_Jersey',
  NM: 'New_Mexico', NY: 'New_York', NC: 'North_Carolina',
  ND: 'North_Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode_Island', SC: 'South_Carolina',
  SD: 'South_Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West_Virginia',
  WI: 'Wisconsin', WY: 'Wyoming',
};

async function fetchWikipediaSummary(city, state) {
  if (!city || !state) return null;
  const cacheKey = `${city.toLowerCase()}|${state.toLowerCase()}`;
  const cached = WIKI_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < WIKI_TTL) {
    console.log(`[cache] wiki hit for ${cacheKey}`);
    return cached.value;
  }

  // Try in order: "City,_StateFullName", then "City" alone. The first
  // form is canonical for disambiguated cities; bare-name covers the
  // big unambiguous cases (Chicago, Houston, Boston).
  const stateFull = STATE_NAMES[state.toUpperCase()] || state;
  const cityEnc = encodeURIComponent(city.replace(/\s+/g, '_'));
  const titles = [
    `${cityEnc},_${stateFull}`,
    cityEnc,
  ];

  for (const title of titles) {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'GrowthIM/1.0 (market-analysis)',
        },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      if (json && json.extract) {
        const value = {
          extract: json.extract,
          description: json.description || null,
          title: json.title || city,
        };
        WIKI_CACHE.set(cacheKey, { ts: Date.now(), value });
        return value;
      }
    } catch (err) {
      clearTimeout(timer);
      // try next title variant
    }
  }
  WIKI_CACHE.set(cacheKey, { ts: Date.now(), value: null });
  return null;
}

// ── BED2013 survival rates by NAICS-2 ────────────────────────────────
// BLS Business Employment Dynamics, 2013 cohort tracked through 2023.
// Mirrors the dictionary used elsewhere in the app — single source.
const BED2013_SURVIVAL = {
  '11':    { y1: 0.749, y3: 0.557, y5: 0.443, y7: 0.368, y10: 0.291 },
  '21':    { y1: 0.752, y3: 0.548, y5: 0.402, y7: 0.321, y10: 0.228 },
  '22':    { y1: 0.814, y3: 0.672, y5: 0.566, y7: 0.489, y10: 0.399 },
  '23':    { y1: 0.764, y3: 0.630, y5: 0.539, y7: 0.461, y10: 0.367 },
  '31-33': { y1: 0.802, y3: 0.673, y5: 0.577, y7: 0.503, y10: 0.412 },
  '42':    { y1: 0.783, y3: 0.613, y5: 0.465, y7: 0.389, y10: 0.296 },
  '44-45': { y1: 0.798, y3: 0.673, y5: 0.583, y7: 0.510, y10: 0.421 },
  '48-49': { y1: 0.776, y3: 0.628, y5: 0.501, y7: 0.422, y10: 0.325 },
  '51':    { y1: 0.749, y3: 0.557, y5: 0.443, y7: 0.368, y10: 0.291 },
  '52':    { y1: 0.789, y3: 0.648, y5: 0.532, y7: 0.454, y10: 0.356 },
  '53':    { y1: 0.801, y3: 0.679, y5: 0.587, y7: 0.514, y10: 0.420 },
  '54':    { y1: 0.776, y3: 0.614, y5: 0.463, y7: 0.381, y10: 0.284 },
  '56':    { y1: 0.768, y3: 0.617, y5: 0.489, y7: 0.410, y10: 0.316 },
  '61':    { y1: 0.818, y3: 0.659, y5: 0.560, y7: 0.471, y10: 0.389 },
  '62':    { y1: 0.827, y3: 0.660, y5: 0.551, y7: 0.480, y10: 0.357 },
  '71':    { y1: 0.771, y3: 0.624, y5: 0.529, y7: 0.450, y10: 0.357 },
  '72':    { y1: 0.783, y3: 0.643, y5: 0.553, y7: 0.476, y10: 0.381 },
  '81':    { y1: 0.806, y3: 0.668, y5: 0.569, y7: 0.493, y10: 0.400 },
};

// Map a free-form business type string to the closest NAICS-2 sector.
// Keyword-based; falls back to '81' (Other Services) which has the
// highest survival rate as a benign default. Order matters — more
// specific matches first.
const NAICS2_KEYWORD_MAP = [
  // 72 Accommodation & Food Services
  [/\b(restaurant|cafe|coffee|bakery|bar|brewery|taproom|food truck|bistro|deli|pizza|sushi|ramen|diner|tavern|pub|grill|bbq|ice cream|juice|smoothie|tea|donut|hotel|motel|inn|b&b|resort|lodging)\b/i, '72'],
  // 62 Health Care
  [/\b(clinic|medical|dental|dentist|chiropract|physical therapy|mental health|counsel|optometr|pediatric|urgent care|home health|senior care|nursing|hospice|wellness|vet|veterinary|hearing|pharmacy|weight loss)\b/i, '62'],
  // 71 Arts, Entertainment, Recreation
  [/\b(gym|crossfit|yoga|pilates|fitness|martial arts|dance|escape room|axe throwing|gaming|arcade|theater|gallery|museum|comedy|music venue|sports bar|recreation|bowling|laser tag|trampoline|pickleball|golf simulator)\b/i, '71'],
  // 61 Education
  [/\b(school|tutor|education|learning|training|coaching|sat|act prep|test prep|coding bootcamp|driving school|cdl)\b/i, '61'],
  // 23 Construction
  [/\b(plumb|electric|hvac|contractor|roof|landscap|construct|handyman|home inspect|solar panel|painter|carpent|fence|deck|pool install)\b/i, '23'],
  // 81 Other Services (personal care + repair)
  [/\b(salon|barber|spa|nail|tattoo|grooming|laundromat|dry clean|auto repair|car wash|funeral|pet care|dog daycare|kennel|self storage)\b/i, '81'],
  // 44-45 Retail Trade
  [/\b(store|shop|retail|boutique|market|outlet|dispensary|cannabis|smoke|vape|jewelry|gift|book|toy|hobby|craft|plant nursery|specialty food|pet supply|sporting goods|outdoor gear|bike shop|thrift|vintage)\b/i, '44-45'],
  // 56 Administrative & Waste Services
  [/\b(cleaning|janitor|pest control|security|staffing|landscaping service|lawn care|junk removal)\b/i, '56'],
  // 54 Professional Services
  [/\b(law|attorney|legal|accounting|cpa|tax prep|bookkeep|consult|marketing agency|digital marketing|advertising|graphic design|photography|architect|engineer|interior design)\b/i, '54'],
  // 52 Finance
  [/\b(financial advisor|investment|insurance|mortgage|broker|bank|credit union|check cash)\b/i, '52'],
  // 53 Real Estate
  [/\b(real estate|brokerage|property management|short[- ]term rental|vacation rental|commercial real estate|self[- ]storage)\b/i, '53'],
  // 51 Information / IT
  [/\b(it support|computer repair|web design|seo|software|app development|video production|podcast|recording studio|tv|radio)\b/i, '51'],
  // 48-49 Transportation
  [/\b(moving|courier|delivery|transport|trucking|storage facility|logistics|taxi|rideshare|limo)\b/i, '48-49'],
  // 11 Agriculture
  [/\b(farm|ranch|orchard|vineyard|nursery|greenhouse)\b/i, '11'],
  // 31-33 Manufacturing
  [/\b(manufactur|brewery production|distillery|food production)\b/i, '31-33'],
];

function naics2ForType(type) {
  if (!type) return '81';
  for (const [re, code] of NAICS2_KEYWORD_MAP) {
    if (re.test(type)) return code;
  }
  return '81';
}

// ── Population-aware competitor search radius ───────────────────────
function radiusMetersForPop(pop) {
  if (!pop) return 24140;            // 15 miles default
  if (pop < 20000) return 40234;     // 25 miles for tiny towns
  if (pop < 100000) return 24140;    // 15 miles
  return 8047;                        // 5 miles for big cities
}

// ── Novelty score from competitor count ─────────────────────────────
function noveltyForCount(count) {
  if (count == null) return 5;       // unknown → neutral
  if (count === 0) return 10;
  if (count === 1) return 8;
  if (count === 2) return 6;
  if (count <= 4) return 4;
  if (count <= 9) return 2;
  return 1;
}

// ─────────────────────────────────────────────────────────────────────
// AGENT 1 — MARKET AGENT
// ─────────────────────────────────────────────────────────────────────
async function runMarketAgent(city, state, geo, businessTypes, countyFIPS) {
  const t0 = Date.now();
  const [events, weather, permits, wiki] = await Promise.all([
    dataFetchers.fetchUpcomingEvents(city, state).catch(() => []),
    dataFetchers.fetchWeather(geo.lat, geo.lon).catch(() => null),
    countyFIPS
      ? dataFetchers.fetchBuildingPermits(countyFIPS).catch(() => null)
      : Promise.resolve(null),
    fetchWikipediaSummary(city, state),
  ]);

  // Per-type survival rates derived from BED2013 + NAICS-2 keyword map.
  const survival_rates = {};
  for (const type of (businessTypes || [])) {
    const naics2 = naics2ForType(type);
    survival_rates[type] = {
      ...BED2013_SURVIVAL[naics2],
      naics2,
    };
  }

  // Coarse growth signal from permits YoY.
  const yoy = permits && permits.building_permits_yoy_change;
  let growth_signal = 'stable';
  if (typeof yoy === 'number') {
    if (yoy > 5) growth_signal = 'growing';
    else if (yoy < -5) growth_signal = 'declining';
  }

  const dt = Date.now() - t0;
  console.log(`[agent-market] ${city}, ${state} done in ${dt}ms — events:${(events || []).length} weather:${weather ? '✓' : '✗'} permits:${permits ? '✓' : '✗'} wiki:${wiki ? '✓' : '✗'}`);

  return {
    events: events || [],
    weather: weather || null,
    permits: permits || null,
    survival_rates,
    city_wiki: wiki ? wiki.extract : null,
    city_wiki_description: wiki ? wiki.description : null,
    growth_signal,
  };
}

// ─────────────────────────────────────────────────────────────────────
// AGENT 2 — DEMOGRAPHICS AGENT
// ─────────────────────────────────────────────────────────────────────
async function runDemographicsAgent(city, state, geo, zip, countyFIPS, prefetchedCensus) {
  const t0 = Date.now();
  // census may have been pre-fetched in analyzeCity to derive population
  // for the competition radius. If supplied, reuse it. Otherwise fetch.
  const censusPromise = prefetchedCensus
    ? Promise.resolve(prefetchedCensus)
    : (zip
        ? dataFetchers.fetchCensusByZip(zip, city, state, countyFIPS).catch(() => null)
        : Promise.resolve(null));

  const [census, ageProfile, fmr, locationSignals] = await Promise.all([
    censusPromise,
    zip ? dataFetchers.fetchCensusAgeProfile(zip).catch(() => null) : Promise.resolve(null),
    dataFetchers.fetchFairMarketRents(state, city).catch(() => null),
    dataFetchers.fetchLocationSignals(geo.lat, geo.lon).catch(() => null),
  ]);

  const median_income = (census && census.median_household_income) || null;
  let income_tier = 'mid';
  if (typeof median_income === 'number') {
    if (median_income < 45000) income_tier = 'low';
    else if (median_income > 80000) income_tier = 'high';
  }

  const dt = Date.now() - t0;
  console.log(`[agent-demo] ${city}, ${state} done in ${dt}ms — pop:${census ? census.total_population : '✗'} income:${median_income ? '$' + median_income : '✗'} age:${ageProfile ? ageProfile.age_profile : '✗'} fmr:${fmr ? '✓' : '✗'} anchors:${locationSignals ? locationSignals.anchor_tenant_count : '✗'}`);

  return {
    population: (census && census.total_population) || null,
    population_source: (census && census.population_source) || null,
    median_income,
    average_household_size: (census && census.average_household_size) || null,
    age_profile: (ageProfile && ageProfile.age_profile) || null,
    pct_65_plus: (ageProfile && ageProfile.pct_65_plus) || null,
    pct_under18: (ageProfile && ageProfile.pct_under18) || null,
    fmr_2br: (fmr && fmr.fmr_2br) || null,
    fmr_metro: (fmr && fmr.metro_name) || null,
    anchor_tenants: (locationSignals && locationSignals.anchor_tenants) || [],
    has_transit: (locationSignals && locationSignals.has_transit_nearby) || false,
    income_tier,
  };
}

// ─────────────────────────────────────────────────────────────────────
// AGENT 3 — COMPETITION AGENT
// ─────────────────────────────────────────────────────────────────────
// Per-type Google Places Text Search (20 calls in batched parallelism)
// + 5 broad searches for review intel (15 candidate businesses, Place
// Details with reviews). Persona keyword counting mirrors the v3
// approach so renderMarketReport's persona_gap_matrix has real data.
// Audit fix DA1 — bounded LRU. Same pattern as WIKI_CACHE above.
const COMP_TTL = 24 * 60 * 60 * 1000;
const COMP_CACHE = new LRUCache({ max: 1000, ttl: COMP_TTL });

const PERSONA_KEYWORDS = [
  'business traveler', 'work', 'meeting', 'conference',
  'family', 'kids', 'children', 'parents',
  'elderly', 'senior', 'retired',
  'tourist', 'visitor', 'passing through',
  'local', 'regular', 'employee', 'staff',
  'hunter', 'fisherman', 'outdoor', 'hiking',
  'wedding', 'anniversary', 'celebration',
  'contractor', 'crew', 'construction',
];

const BROAD_SEARCHES = [
  (city, state) => `top rated restaurants in ${city} ${state}`,
  (city, state) => `popular services in ${city} ${state}`,
  (city, state) => `best retail in ${city} ${state}`,
  (city, state) => `healthcare clinics in ${city} ${state}`,
  (city, state) => `entertainment ${city} ${state}`,
];

function _escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _countKeywords(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return {};
  const counts = {};
  for (const kw of PERSONA_KEYWORDS) {
    const isMulti = kw.includes(' ');
    const re = isMulti
      ? new RegExp(_escapeRegex(kw), 'gi')
      : new RegExp(`\\b${_escapeRegex(kw)}\\b`, 'gi');
    const m = lower.match(re);
    if (m && m.length) counts[kw] = m.length;
  }
  return counts;
}

// One per-type text search. Caches result 24h per businessType|city|state.
async function _fetchTypeCount(type, city, state, lat, lon, radius, apiKey) {
  const cacheKey = `${type.toLowerCase()}|${city.toLowerCase()}|${state.toLowerCase()}`;
  const cached = COMP_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < COMP_TTL) return [type, cached.value];

  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
    + `?query=${encodeURIComponent(type + ' in ' + city + ' ' + state)}`
    + `&location=${lat},${lon}`
    + `&radius=${radius}`
    + `&key=${apiKey}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
      throw new Error('status=' + json.status);
    }
    // Drop CLOSED_PERMANENTLY / CLOSED_TEMPORARILY before counting so
    // novelty score and top_3 reflect operational competition only.
    const results = (json.results || []).filter(places.isOperationalOrUnknown);
    const value = {
      competitor_count: results.length,
      novelty_score: noveltyForCount(results.length),
      top_3: results.slice(0, 3).map((r) => ({
        name: r.name,
        rating: typeof r.rating === 'number' ? r.rating : null,
        review_count: typeof r.user_ratings_total === 'number' ? r.user_ratings_total : 0,
      })),
    };
    COMP_CACHE.set(cacheKey, { ts: Date.now(), value });
    return [type, value];
  } catch (err) {
    return [type, { competitor_count: null, novelty_score: 5, top_3: [] }];
  } finally {
    clearTimeout(timer);
  }
}

async function runCompetitionAgent(city, state, geo, businessTypes, apiKey, population) {
  const t0 = Date.now();
  if (!apiKey) {
    console.warn('[agent-competition] no Google API key — returning empty');
    return { by_type: {}, local_businesses: [], persona_signals: {}, dominant_personas: [] };
  }
  const radius = radiusMetersForPop(population);

  // ── Per-type searches: 20 in 4 batches of 5 (200ms inter-batch delay)
  // — tighter than full parallel to avoid Places API rate limits, but
  // still ~2-3s wall clock for 20 queries.
  const by_type = {};
  const types = (businessTypes || []).slice(0, 20);
  const BATCH = 5;
  for (let i = 0; i < types.length; i += BATCH) {
    const slice = types.slice(i, i + BATCH);
    const entries = await Promise.all(
      slice.map((t) => _fetchTypeCount(t, city, state, geo.lat, geo.lon, radius, apiKey))
    );
    for (const [type, val] of entries) by_type[type] = val;
    if (i + BATCH < types.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // ── Broad searches: 5 in parallel for review intel ─────────────────
  const broadResults = await Promise.allSettled(
    BROAD_SEARCHES.map(async (mk) => {
      const q = mk(city, state);
      const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
        + `?query=${encodeURIComponent(q)}`
        + `&location=${geo.lat},${geo.lon}`
        + `&radius=${radius}`
        + `&key=${apiKey}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
          throw new Error('status=' + json.status);
        }
        // Drop CLOSED_PERMANENTLY / CLOSED_TEMPORARILY before slicing
        // — filter BEFORE .slice(0,3) so we don't lose operational
        // candidates because closed ones were ranked higher.
        return (json.results || [])
          .filter(places.isOperationalOrUnknown)
          .slice(0, 3);
      } finally {
        clearTimeout(timer);
      }
    })
  );

  // Dedup broad-search candidates by place_id, cap at 15.
  const seen = new Set();
  const candidates = [];
  for (const r of broadResults) {
    if (r.status !== 'fulfilled') continue;
    for (const p of r.value) {
      if (!p.place_id || seen.has(p.place_id)) continue;
      seen.add(p.place_id);
      candidates.push(p);
      if (candidates.length >= 15) break;
    }
    if (candidates.length >= 15) break;
  }

  // Place Details (with reviews) for each candidate. Uses the existing
  // googlePlaces.getDetails which has its own 24h cache.
  const detailResults = await Promise.allSettled(
    candidates.map((p) => places.getDetails(p.place_id, apiKey))
  );

  const local_businesses = [];
  const persona_signals = {};

  // Indexed iteration so we can fall back to candidates[i].place_id when
  // Place Details (rare) returns no place_id field. Promise.allSettled
  // preserves order so detailResults[i] always corresponds to candidates[i].
  for (let i = 0; i < detailResults.length; i++) {
    const r = detailResults[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    const d = r.value;
    const candidate = candidates[i] || {};
    const place_id = d.place_id || candidate.place_id || null;
    const reviews = (Array.isArray(d.reviews) ? d.reviews : []).slice(0, 5);
    // Persona keywords are still counted across the full first-5 review
    // text (most signal). The snippets we ship downstream are 500-char
    // truncations of the first 3 reviews, paired with author + time so
    // provenance.js can verify any later quote against them.
    const allText = reviews.map((rev) => rev.text || '').join(' ');
    const keywords = _countKeywords(allText);
    for (const [k, v] of Object.entries(keywords)) {
      persona_signals[k] = (persona_signals[k] || 0) + v;
    }

    local_businesses.push({
      place_id,
      name: d.name || '(unnamed)',
      rating: typeof d.rating === 'number' ? d.rating : null,
      review_count: typeof d.user_ratings_total === 'number' ? d.user_ratings_total : 0,
      types: Array.isArray(d.types) ? d.types.slice(0, 3) : [],
      review_snippets: reviews.slice(0, 3).map((rev) => {
        const raw = String(rev.text || '').replace(/\s+/g, ' ').trim();
        const text = raw.length > 500 ? raw.substring(0, 500) + '…' : raw;
        return {
          text,
          author: rev.author_name || null,
          time: rev.relative_time_description || null,
        };
      }),
      persona_keywords: keywords,
    });
  }

  const dominant_personas = Object.entries(persona_signals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);

  const dt = Date.now() - t0;
  console.log(`[agent-competition] ${city}, ${state} done in ${dt}ms — types:${Object.keys(by_type).length} businesses:${local_businesses.length} personas:${dominant_personas.join(',') || 'none'}`);

  return { by_type, local_businesses, persona_signals, dominant_personas, _radius: radius };
}

// ─────────────────────────────────────────────────────────────────────
// AGENT 4 — COST AGENT
// ─────────────────────────────────────────────────────────────────────
const STARTUP_COST_TIERS = {
  low:       { min: 5000,    max: 25000,    label: 'Under $25K' },
  medium:    { min: 25000,   max: 100000,   label: '$25K-$100K' },
  high:      { min: 100000,  max: 500000,   label: '$100K-$500K' },
  very_high: { min: 500000,  max: 2000000,  label: '$500K+' },
};

// Default cost tier per business-type keyword. Order from most-specific
// to most-generic — first match wins. Values not on this list fall
// through to 'medium' which is the safe default for most service biz.
const COST_TIER_RULES = [
  ['food truck', 'low'],
  ['pet grooming', 'low'],
  ['hair salon', 'low'],
  ['barber', 'low'],
  ['nail salon', 'low'],
  ['yoga studio', 'low'],
  ['tutoring', 'low'],
  ['photography studio', 'low'],
  ['bookkeep', 'low'],
  ['tax prep', 'low'],
  ['handyman', 'low'],
  ['cleaning service', 'low'],
  ['lawn care', 'low'],
  ['landscaping service', 'low'],
  ['junk removal', 'low'],
  ['laundromat', 'low'],
  ['coffee shop', 'medium'],
  ['cafe', 'medium'],
  ['bakery', 'medium'],
  ['ice cream', 'medium'],
  ['juice bar', 'medium'],
  ['smoothie', 'medium'],
  ['crossfit', 'medium'],
  ['gym', 'medium'],
  ['dance studio', 'medium'],
  ['martial arts', 'medium'],
  ['escape room', 'medium'],
  ['axe throwing', 'medium'],
  ['pickleball', 'medium'],
  ['retail store', 'medium'],
  ['boutique', 'medium'],
  ['specialty food', 'medium'],
  ['bookstore', 'medium'],
  ['bike shop', 'medium'],
  ['toy store', 'medium'],
  ['plant shop', 'medium'],
  ['plumber', 'medium'],
  ['electrician', 'medium'],
  ['hvac', 'medium'],
  ['auto repair', 'medium'],
  ['restaurant', 'high'],
  ['ramen', 'high'],
  ['sushi', 'high'],
  ['pizza', 'high'],
  ['mexican restaurant', 'high'],
  ['steakhouse', 'high'],
  ['bistro', 'high'],
  ['brewery', 'high'],
  ['taproom', 'high'],
  ['cocktail bar', 'high'],
  ['hotel', 'very_high'],
  ['urgent care', 'very_high'],
  ['dental practice', 'very_high'],
  ['medical', 'very_high'],
  ['veterinary clinic', 'very_high'],
  ['assisted living', 'very_high'],
];

function tierForType(type) {
  if (!type) return 'medium';
  const lower = type.toLowerCase();
  for (const [keyword, tier] of COST_TIER_RULES) {
    if (lower.includes(keyword)) return tier;
  }
  return 'medium';
}

async function runCostAgent(city, state, businessTypes, countyFIPS) {
  const t0 = Date.now();
  // Cost agent re-fetches FMR + permits independently; both have
  // existing 30-day / 24h caches in dataFetchers.js so a parallel call
  // from runMarketAgent + runDemographicsAgent costs at most one
  // network round-trip per process lifetime per city.
  const [fmr, permits] = await Promise.all([
    dataFetchers.fetchFairMarketRents(state, city).catch(() => null),
    countyFIPS
      ? dataFetchers.fetchBuildingPermits(countyFIPS).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Commercial rent estimate: 2BR FMR × 1.7 (small-business rule of
  // thumb — commercial typically runs 1.5–2x residential per sqft).
  const fmr2br = fmr && fmr.fmr_2br;
  const commercial_rent_est = typeof fmr2br === 'number' ? Math.round(fmr2br * 1.7) : null;

  // Permit complexity: high YoY = competitive market = harder permits;
  // low YoY = stable / easy. Tier 4 scoring uses this for a small
  // feasibility nudge.
  const yoy = permits && permits.building_permits_yoy_change;
  let permit_complexity = 'medium';
  if (typeof yoy === 'number') {
    if (yoy > 20) permit_complexity = 'high';
    else if (yoy < -10) permit_complexity = 'low';
  }

  const by_type = {};
  for (const type of (businessTypes || [])) {
    const tier = tierForType(type);
    const tierData = STARTUP_COST_TIERS[tier];
    by_type[type] = {
      startup_cost_tier: tier,
      startup_cost_range: tierData.label,
      startup_cost_min: tierData.min,
      startup_cost_max: tierData.max,
    };
  }

  const dt = Date.now() - t0;
  console.log(`[agent-cost] ${city}, ${state} done in ${dt}ms — fmr:${fmr2br ? '$' + fmr2br : '✗'} commercial_est:${commercial_rent_est ? '$' + commercial_rent_est : '✗'} permit_complexity:${permit_complexity}`);

  return {
    commercial_rent_est,
    permit_complexity,
    fmr_2br: fmr2br || null,
    fmr_metro: (fmr && fmr.metro_name) || null,
    permits_yoy: typeof yoy === 'number' ? yoy : null,
    by_type,
  };
}

module.exports = {
  runMarketAgent,
  runDemographicsAgent,
  runCompetitionAgent,
  runCostAgent,
  // Exposed for the scorer + diagnostics
  _BED2013_SURVIVAL: BED2013_SURVIVAL,
  _STARTUP_COST_TIERS: STARTUP_COST_TIERS,
  _naics2ForType: naics2ForType,
  _radiusMetersForPop: radiusMetersForPop,
  _noveltyForCount: noveltyForCount,
  _tierForType: tierForType,
};

/* Google Places (legacy) wrapper.
   findPlace(query) → { place_id, name, formatted_address, types } or null
   getDetails(placeId) → details object mapped to algorithm INPUT_FIELDS
   fetchNearbyCompetitors(...) → 4-source waterfall, top-7 competitors
   Uses global fetch (Node 18+). */

// dataFetchers is required for Source 2 (text-search competitors) and
// Source 4 (Foursquare venues) of the competitor waterfall. No circular
// dependency: dataFetchers does not require googlePlaces.
const dataFetchers = require('./dataFetchers');

const TEXTSEARCH_URL =
  'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DETAILS_URL =
  'https://maps.googleapis.com/maps/api/place/details/json';
const NEARBY_URL =
  'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

// Phase-3 BATCH14: added geometry (for lat/lng → Nearby Search + distance
// math), opening_hours (for hours_complete + is_open_now signals).
const DETAIL_FIELDS = [
  'place_id',
  'name',
  'formatted_address',
  'rating',
  'user_ratings_total',
  'business_status',
  'photos',
  'reviews',
  'website',
  'url',
  'geometry',
  'opening_hours',
  'types',
].join(',');

// Simple in-memory cache for competitor results, 24h TTL keyed by place_id.
// (Process-lifetime only — not persistent. Phase 3 acceptable; persistent
// cache deferred to future batch.)
const COMPETITOR_CACHE = new Map();
const COMPETITOR_TTL_MS = 24 * 60 * 60 * 1000;

// 24-hour cache for Google Places Details responses, keyed by place_id.
// Each Details call costs ~$0.017; caching cuts repeat-lookup cost for
// the same business to zero within the TTL window. BATCH13 spec p.5
// calls for Redis with 24h TTL — this Map is the in-process v1 of that.
const DETAILS_CACHE = new Map();
const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;

async function findPlace(query, apiKey) {
  // The full input string is passed verbatim to Google Places Text Search.
  // For the Google-Maps-style format ("Business Name, Street Address,
  // City, ST ZIP"), passing the WHOLE string — including the address —
  // gives MORE accurate results than name+city alone, because Google's
  // Text Search does fuzzy matching against business name + address +
  // locality and returns the exact business at that street location.
  // Do NOT strip the address portion.
  const url = `${TEXTSEARCH_URL}?query=${encodeURIComponent(query)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places Text Search HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
    throw new Error(`Places Text Search status=${json.status} ${json.error_message || ''}`);
  }
  const top = (json.results || [])[0];
  if (!top) return null;
  return {
    place_id: top.place_id,
    name: top.name,
    formatted_address: top.formatted_address,
    types: Array.isArray(top.types) ? top.types : [],
    // Phase 5+ — Text Search responses include geometry; surfacing it
    // saves /market-analysis from making an extra getDetails round-trip
    // just to read lat/lng for downstream fetchers.
    geometry: top.geometry || null,
  };
}

async function getDetails(placeId, apiKey) {
  if (!placeId) throw new Error('getDetails: placeId required');

  // Check cache first — 24h TTL per BATCH13 spec p.5.
  const cached = DETAILS_CACHE.get(placeId);
  if (cached && Date.now() - cached.ts < DETAILS_TTL_MS) {
    console.log(`[cache] details hit for ${placeId}`);
    return cached.value;
  }

  const url = `${DETAILS_URL}?place_id=${encodeURIComponent(placeId)}&fields=${DETAIL_FIELDS}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places Details HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK') {
    throw new Error(`Places Details status=${json.status} ${json.error_message || ''}`);
  }
  // Successful fetch — store in cache before returning.
  DETAILS_CACHE.set(placeId, { ts: Date.now(), value: json.result });
  return json.result;
}

/* Map Places Details response to the algorithm's INPUT_FIELDS shape.
   Required: place_id, google_rating, google_review_count, business_status.
   BATCH14 additions:
     - latitude/longitude (from geometry — needed for Nearby Search)
     - hours_complete (true when opening_hours has all 7 weekdays)
     - is_open_now (from opening_hours.open_now)
     - responds_to_reviews (any review has owner reply)
     - response_rate_estimated (fraction of sampled reviews with reply)
   Note: Google's legacy Places API does NOT consistently return owner
   replies on reviews. When the field is absent, responds_to_reviews is
   false / response_rate_estimated is 0.0; the trigger DSL distinguishes
   these from is_unknown (null) using the explicit number. */
function toInputFields(detail) {
  const reviews = detail.reviews || [];

  // Review recency — days since most recent review.
  let reviewRecencyDays = null;
  if (reviews.length && reviews[0].time) {
    const ageMs = Date.now() - reviews[0].time * 1000;
    reviewRecencyDays = Math.max(0, Math.floor(ageMs / 86400000));
  }

  // Owner-response detection. Legacy Places Details may put owner replies
  // in `author_response`, `owner_response`, or `translated_response`
  // depending on the API version. Check several known field shapes; fall
  // back to false when none present.
  const reviewsWithResponse = reviews.filter((r) =>
    r && (
      (r.author_response && (r.author_response.text || r.author_response)) ||
      (r.owner_response && (r.owner_response.text || r.owner_response)) ||
      (r.response && r.response.text) ||
      r.translated_response
    )
  );
  const respondsToReviews = reviews.length > 0 ? reviewsWithResponse.length > 0 : null;
  const responseRateEstimated = reviews.length > 0
    ? +(reviewsWithResponse.length / reviews.length).toFixed(2)
    : null;

  // Hours completeness — opening_hours.weekday_text is an array of 7 strings
  // when fully populated. Some businesses list only a subset (e.g. "Mon–Fri"
  // only). Special hours: opening_hours.special_days exists in newer responses.
  const hours = detail.opening_hours || null;
  const weekdayText = hours && Array.isArray(hours.weekday_text) ? hours.weekday_text : null;
  const hoursComplete = weekdayText ? weekdayText.length === 7 : null;
  const hoursHasSpecial = hours && Array.isArray(hours.special_days) && hours.special_days.length > 0;
  const isOpenNow = hours && typeof hours.open_now === 'boolean' ? hours.open_now : null;

  // Geo (used by Nearby Search later in the request flow).
  const loc = detail.geometry && detail.geometry.location;
  const latitude = loc && typeof loc.lat === 'number' ? loc.lat : null;
  const longitude = loc && typeof loc.lng === 'number' ? loc.lng : null;

  return {
    place_id: detail.place_id,
    name: detail.name,
    formatted_address: detail.formatted_address,
    google_rating: typeof detail.rating === 'number' ? detail.rating : null,
    google_review_count:
      typeof detail.user_ratings_total === 'number' ? detail.user_ratings_total : 0,
    business_status: detail.business_status || null,
    photo_count: Array.isArray(detail.photos) ? detail.photos.length : 0,
    review_recency_days: reviewRecencyDays,

    // BATCH14 — review response
    responds_to_reviews: respondsToReviews,
    response_rate_estimated: responseRateEstimated,
    reviews_sampled: reviews.length,

    // BATCH14 — operations: hours
    hours_complete: hoursComplete,
    hours_has_special: hoursHasSpecial,
    is_open_now: isOpenNow,
    weekday_text: weekdayText,

    // BATCH14 — geo (used for Nearby Search and distance calculations)
    latitude,
    longitude,

    // Existing fields kept null (BATCH16 / future)
    years_in_business: null,
    competitor_density_5mi: null,
    website: detail.website || null,
    google_maps_url: detail.url || null,

    // Place types from Google (used to pick the Nearby Search 'type' param)
    google_types: Array.isArray(detail.types) ? detail.types : [],
  };
}

/* Pick the most specific Google type to use for Nearby Search competitor
   discovery. Skip the generic anchors ("establishment", "point_of_interest").
   Prefer the first remaining type — Google orders these primary-first. */
function pickNearbySearchType(types) {
  if (!Array.isArray(types) || !types.length) return null;
  const skip = new Set(['establishment', 'point_of_interest', 'food', 'health', 'store']);
  for (const t of types) {
    if (!skip.has(t)) return t;
  }
  return null;
}

/* fetchNearbyCompetitors — 4-source competitor-discovery waterfall.

   Sources, run in order, stop when post-filter pool ≥ POOL_TARGET (5):
     1. Google Nearby Search with `type=`, radius ladder 5/15/50 mi
     2. Google Places Text Search with locality-biased synonym queries
        (delegated to dataFetchers.fetchGoogleTextCompetitors)
     3. Google Nearby Search with NO type, `keyword=` instead — catches
        businesses Google tagged differently than the type we passed
     4. Foursquare nearby venues (no rating/review_count, but at least
        names + distances for thin markets)

   Returns:
     {
       competitor_count,
       competitor_median_rating,
       competitor_median_review_count,
       competitors_top7: [{ name, rating, review_count, distance_meters, source }],
       competitors_top3: [...]                  // back-compat slice of top7
       sources_used: string[],                  // which sources actually fired
       search_radius_miles: number              // largest Google radius used
     }
   On Source 1 success returns even if pool < target (the waterfall's
   downstream sources only escalate when the pool is short). Cached 24h
   per `${place_id}|${type}` key. */

// Radius ladder for Source 1 (Nearby Search). Held at module scope so
// it's easy to tune without touching the waterfall body.
const RADIUS_FALLBACKS = [8047, 24140, 80467]; // 5mi / 15mi / 50mi in meters
const POOL_TARGET = 5;
// Source 3 uses the largest radius as a final fallback.
const SOURCE3_RADIUS = RADIUS_FALLBACKS[RADIUS_FALLBACKS.length - 1];

// Normalize a business name for fuzzy dedup + subject exclusion.
// Lowercase, alphanumeric+space only, trimmed, capped at 20 chars.
function normalizeName(name) {
  return String(name == null ? '' : name).toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .substring(0, 20);
}

// Convert a raw Google Places result into our unified competitor shape.
function toCompetitorFromGoogle(r, baseLat, baseLng, source) {
  const elLat = r.geometry && r.geometry.location ? r.geometry.location.lat : null;
  const elLng = r.geometry && r.geometry.location ? r.geometry.location.lng : null;
  return {
    place_id: r.place_id || null,
    name: r.name || '(unnamed)',
    rating: typeof r.rating === 'number' ? r.rating : null,
    review_count: typeof r.user_ratings_total === 'number' ? r.user_ratings_total : 0,
    distance_meters: haversineMeters(baseLat, baseLng, elLat, elLng),
    source,
  };
}

// Sort comparator: items with rating first, then rating desc, then
// review_count desc as tiebreaker. Foursquare entries (rating=null)
// always land at the bottom but ordered by review_count.
function competitorComparator(a, b) {
  const aHas = a.rating != null;
  const bHas = b.rating != null;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  if (aHas && bHas && a.rating !== b.rating) return b.rating - a.rating;
  return (b.review_count || 0) - (a.review_count || 0);
}

// Fuzzy name dedup — collapse two entries with the same 20-char
// normalized prefix into the one with more data (higher review_count).
function fuzzyDedupByName(arr) {
  const byNorm = new Map();
  for (const r of arr) {
    const k = normalizeName(r.name);
    if (!k) {
      // No usable normalized form; keep with a unique fallback key
      byNorm.set(`__no_key_${byNorm.size}`, r);
      continue;
    }
    const existing = byNorm.get(k);
    if (!existing) {
      byNorm.set(k, r);
    } else if ((r.review_count || 0) > (existing.review_count || 0)) {
      byNorm.set(k, r);
    }
  }
  return Array.from(byNorm.values());
}

async function fetchNearbyCompetitors({
  placeId, lat, lng, type, apiKey,
  city = null, state = null, subjectName = null,
}) {
  if (!lat || !lng || !apiKey) return null;
  const cacheKey = `${placeId || ''}|${type || ''}`;
  const cached = COMPETITOR_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < COMPETITOR_TTL_MS) {
    return cached.value;
  }

  // Live pool that's ALREADY deduped-by-place-id and subject-filtered as
  // entries are added — so pool.length is the meaningful count for
  // "have we hit POOL_TARGET yet?" checks at each stage of the waterfall.
  const pool = [];
  const seenPlaceIds = new Set();
  const subjectNorm = subjectName ? normalizeName(subjectName) : null;
  let largestRadiusUsed = RADIUS_FALLBACKS[0];
  const sourcesUsed = [];

  function tryAdd(rawGoogleResult, source) {
    const c = toCompetitorFromGoogle(rawGoogleResult, lat, lng, source);
    if (c.place_id) {
      if (placeId && c.place_id === placeId) return;        // subject by place_id
      if (seenPlaceIds.has(c.place_id)) return;             // dedup by place_id
      seenPlaceIds.add(c.place_id);
    }
    if (subjectNorm && normalizeName(c.name) === subjectNorm) return; // subject by name
    pool.push(c);
  }

  // ── SOURCE 1 — Google Nearby Search with type, radius ladder ─────
  for (const radius of RADIUS_FALLBACKS) {
    largestRadiusUsed = Math.max(largestRadiusUsed, radius);
    try {
      const params = [`location=${lat},${lng}`, `radius=${radius}`, `key=${apiKey}`];
      if (type) params.push(`type=${encodeURIComponent(type)}`);
      const url = `${NEARBY_URL}?${params.join('&')}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Places Nearby HTTP ${res.status}`);
      const json = await res.json();
      if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
        throw new Error(`Places Nearby status=${json.status} ${json.error_message || ''}`);
      }
      if (!sourcesUsed.includes('google_nearby')) sourcesUsed.push('google_nearby');
      for (const r of (json.results || [])) tryAdd(r, 'google_nearby');
    } catch (err) {
      console.warn('[competitors] source1 (radius ' + radius + ') failed:', err.message);
      break; // bail the ladder, let downstream sources try
    }
    if (pool.length >= POOL_TARGET) break;
  }

  // ── SOURCE 2 — Google Text Search with synonym variants ──────────
  if (pool.length < POOL_TARGET && type) {
    try {
      const txt = await dataFetchers.fetchGoogleTextCompetitors(type, lat, lng, city, state);
      if (Array.isArray(txt) && txt.length) {
        sourcesUsed.push('google_text');
        for (const r of txt) tryAdd(r, 'google_text');
      }
    } catch (err) {
      console.warn('[competitors] source2 failed:', err.message);
    }
  }

  // ── SOURCE 3 — Google Nearby with NO type, keyword instead ───────
  if (pool.length < POOL_TARGET && type) {
    largestRadiusUsed = Math.max(largestRadiusUsed, SOURCE3_RADIUS);
    try {
      const url = `${NEARBY_URL}?location=${lat},${lng}&radius=${SOURCE3_RADIUS}` +
        `&keyword=${encodeURIComponent(type)}&key=${apiKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        if (json.status === 'OK' || json.status === 'ZERO_RESULTS') {
          sourcesUsed.push('google_nearby_no_type');
          for (const r of (json.results || [])) tryAdd(r, 'google_nearby_no_type');
        }
      }
    } catch (err) {
      console.warn('[competitors] source3 failed:', err.message);
    }
  }

  // ── SOURCE 4 — Foursquare nearby venues (no rating data) ─────────
  if (pool.length < POOL_TARGET) {
    try {
      const venues = await dataFetchers.fetchNearbyVenues(lat, lng);
      if (Array.isArray(venues) && venues.length) {
        sourcesUsed.push('foursquare');
        for (const v of venues) {
          // Foursquare has no place_id; only name-based dedup applies.
          if (subjectNorm && normalizeName(v.name) === subjectNorm) continue;
          pool.push({
            place_id: null,
            name: v.name,
            rating: null,
            review_count: 0,
            distance_meters: typeof v.distance_meters === 'number' ? v.distance_meters : null,
            source: 'foursquare',
          });
        }
      }
    } catch (err) {
      console.warn('[competitors] source4 failed:', err.message);
    }
  }

  // ── Final cleanup: fuzzy name dedup, sort, slice ─────────────────
  const poolBeforeDedup = pool.length;
  const fuzzed = fuzzyDedupByName(pool);
  fuzzed.sort(competitorComparator);
  const top7 = fuzzed.slice(0, 7);
  // top5 kept alongside top3 — server.js + claudeEnricher.js already
  // consume `competitors_top5` for the Claude bundle's competitor
  // comparison; preserving it avoids touching those modules.
  const top5 = top7.slice(0, 5);
  const top3 = top7.slice(0, 3);

  const ratings = fuzzed.map((c) => c.rating).filter((x) => typeof x === 'number');
  const reviewCounts = fuzzed
    .map((c) => c.review_count)
    .filter((x) => typeof x === 'number' && x > 0);

  console.log(`[competitors] pool: ${poolBeforeDedup} | after dedup: ${fuzzed.length} | final: ${fuzzed.length} | sources: ${JSON.stringify(sourcesUsed)}`);

  const value = {
    competitor_count: fuzzed.length,
    competitor_median_rating: median(ratings),
    competitor_median_review_count: median(reviewCounts),
    competitors_top7: top7,
    competitors_top5: top5,
    competitors_top3: top3,
    sources_used: sourcesUsed,
    search_radius_miles: Math.round(largestRadiusUsed / 1609.34),
  };
  COMPETITOR_CACHE.set(cacheKey, { ts: Date.now(), value });
  return value;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 0) return +((s[mid - 1] + s[mid]) / 2).toFixed(2);
  return +s[mid].toFixed(2);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371000; // meters
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// ─────────────────────────────────────────────────────────────────────
// fetchBusinessTypeCompetitors — Market Analysis (Mode 2) novelty signal
// ─────────────────────────────────────────────────────────────────────
// Counts how many businesses of a specific type exist within
// radiusMiles of (lat, lon), and converts the count into a 1-10
// "novelty" score. Used by marketScorer's per-business-type ranking
// to combine v3 novelty with v4 sector economics.
//
// Returns:
//   {
//     business_type,
//     competitor_count,            // null on call failure
//     novelty_score,               // 1..10 (5 = neutral fallback)
//     top_competitors: [{ name, rating, vicinity }]   // up to 3
//   }
//
// 24h cache per `${type}|${lat@2dec}|${lon@2dec}`. 5s timeout.
const BIZ_TYPE_CACHE = new Map();
const BIZ_TYPE_TTL_MS = 24 * 60 * 60 * 1000;

function noveltyFromCount(count) {
  if (count === 0) return 10;
  if (count === 1) return 8;
  if (count === 2) return 6;
  if (count <= 4) return 4;
  if (count <= 9) return 2;
  return 1;
}

async function fetchBusinessTypeCompetitors(businessType, lat, lon, radiusMiles, apiKey) {
  const fallback = (msg) => {
    if (msg) console.warn(`[fetch-bt-comp] ${businessType}: ${msg}`);
    return {
      business_type: businessType,
      competitor_count: null,
      novelty_score: 5,
      top_competitors: [],
    };
  };
  if (!businessType || lat == null || lon == null || !apiKey) {
    return fallback('missing required input');
  }

  const cacheKey = `${businessType.toLowerCase()}|${lat.toFixed(2)}|${lon.toFixed(2)}`;
  const cached = BIZ_TYPE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < BIZ_TYPE_TTL_MS) {
    console.log(`[cache] biz-type-comp hit for ${cacheKey}`);
    return cached.value;
  }

  // Google's Text Search clamps radius to 50,000m (~31 miles); larger
  // values are accepted but capped server-side. The radius parameter
  // also acts as a soft bias rather than a hard filter — that's fine
  // for novelty counting (we want a regional signal, not strict cap).
  const radiusMeters = Math.min(Math.round(radiusMiles * 1609), 50000);
  const url = `${TEXTSEARCH_URL}?query=${encodeURIComponent(businessType)}`
    + `&location=${lat},${lon}`
    + `&radius=${radiusMeters}`
    + `&key=${apiKey}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return fallback(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
      return fallback(`status=${json.status}`);
    }
    const results = Array.isArray(json.results) ? json.results : [];
    const count = results.length;
    const top3 = results
      .filter((r) => typeof r.rating === 'number')
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 3)
      .map((r) => ({
        name: r.name,
        rating: r.rating,
        vicinity: r.vicinity || r.formatted_address || null,
      }));
    const value = {
      business_type: businessType,
      competitor_count: count,
      novelty_score: noveltyFromCount(count),
      top_competitors: top3,
    };
    BIZ_TYPE_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (err) {
    return fallback(err.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  findPlace,
  getDetails,
  toInputFields,
  fetchNearbyCompetitors,
  pickNearbySearchType,
  fetchBusinessTypeCompetitors,
};

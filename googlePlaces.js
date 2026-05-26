/* Google Places (legacy) wrapper.
   findPlace(query) → { place_id, name, formatted_address, types } or null
   getDetails(placeId) → details object mapped to algorithm INPUT_FIELDS
   fetchNearbyCompetitors(...) → 4-source waterfall, top-7 competitors
   Uses global fetch (Node 18+). */

// dataFetchers is required for Source 2 (text-search competitors) and
// Source 4 (Foursquare venues) of the competitor waterfall. No circular
// dependency: dataFetchers does not require googlePlaces.
const dataFetchers = require('./dataFetchers');

// LRU-Cache wrapper - bounded-size cache with per-entry TTL. Replaces
// the raw `new Map()` caches throughout this file so the process can't
// OOM under sustained traffic (each cache previously grew unbounded
// because the only eviction was TTL on read, not size on write).
const { LRUCache } = require('lru-cache');


const TEXTSEARCH_URL =
  'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DETAILS_URL =
  'https://maps.googleapis.com/maps/api/place/details/json';
const NEARBY_URL =
  'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const GEOCODE_URL =
  'https://maps.googleapis.com/maps/api/geocode/json';

// Words that should NOT count as meaningful business-name signals during
// nameSimilarity scoring. Pure locality / direction / street-type words
// only - brand-relevant words like 'inn', 'hotel', 'suites', 'lodge'
// are KEPT because they actually distinguish brands ("Holiday Inn" vs
// "Holiday Suites"). Stripping those would make every hotel look the
// same to the matcher.
const LOCALITY_WORDS = new Set([
  'street','avenue','road','drive',
  'lane','blvd','boulevard','court',
  'place','north','south','east','west',
  'suite','floor','unit','building',
  'highway','hwy','route','ave','st',
  'dr','rd','ln','ct','pl','pkwy',
  'parkway','way','circle','ter',
  'terrace','and','for','the',
  'airport','center','mall','plaza',
  'lake','river','hill','hills',
  'village','town','city','county',
]);

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
  'current_opening_hours',
  'types',
].join(',');

// Simple in-memory cache for competitor results, 24h TTL keyed by place_id.
// (Process-lifetime only - not persistent. Phase 3 acceptable; persistent
// cache deferred to future batch.) max=1000 caps memory under traffic.
const COMPETITOR_TTL_MS = 24 * 60 * 60 * 1000;
const COMPETITOR_CACHE = new LRUCache({ max: 1000, ttl: COMPETITOR_TTL_MS });

// 24-hour cache for Google Places Details responses, keyed by place_id.
// Each Details call costs ~$0.017; caching cuts repeat-lookup cost for
// the same business to zero within the TTL window. BATCH13 spec p.5
// calls for Redis with 24h TTL - this LRU is the in-process v1 of that.
const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;
const DETAILS_CACHE = new LRUCache({ max: 1000, ttl: DETAILS_TTL_MS });

// 30-day cache for geocoding results - addresses don't move. Keyed by
// the lowercase normalized address string (with state appended). Values
// are { lat, lon } or null when geocoding failed (cached so we don't
// re-fire on every retry).
const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GEOCODE_CACHE = new LRUCache({ max: 1000, ttl: GEOCODE_TTL_MS });

// ── HTTP timeout helper (audit fix GP1) ──────────────────────────────
// Node's global fetch has NO default timeout, so a stuck Google socket
// would hold a worker indefinitely - leaking sockets, memory, and
// jobStore entries on the server side. Every Google Places call in
// this file is wrapped via fetchWithTimeout so a slow / hung upstream
// fails fast instead of pinning resources.
//
// 8 s default matches Google's documented p99 for Places (~3-4 s) with
// a 2× safety margin. Callers that need a different budget (e.g.
// geocode → 5 s) can override via the timeoutMs option.
//
// AbortError is translated to a descriptive Error so downstream
// .catch blocks see a human-readable message rather than a generic
// abort signature.
async function fetchWithTimeout(url, { timeoutMs = 8000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Module-level helpers used by findPlace. Lifted from prior inner
// closures so the geocoding-fallback path can share them.
// ─────────────────────────────────────────────────────────────────────

// doTextSearch - single Google Places Text Search call, returns the
// raw `results` array (matches the existing inline pattern used by
// fetchNearbyCompetitors and fetchBusinessTypeCompetitors).
async function doTextSearch(q, apiKey) {
  const url = `${TEXTSEARCH_URL}?query=${encodeURIComponent(q)}&key=${apiKey}`;
  const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
  if (!res.ok) throw new Error(`Places Text Search HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
    throw new Error(`Places Text Search status=${json.status} ${json.error_message || ''}`);
  }
  return Array.isArray(json.results) ? json.results : [];
}

// extractAddressPart - pulls the address portion (everything from the
// first comma-segment that starts with "<digits> ") out of the user
// input. Returns null when no street-numbered segment is found.
//   "Baymont, 1581 W South Park, Oshkosh WI" → "1581 W South Park, Oshkosh WI"
//   "Rajni Indian Cuisine, Madison WI"        → null
//   "Holiday Inn, Suite 200, 1234 Main, Chicago" → "1234 Main, Chicago"
function extractAddressPart(userInput) {
  const parts = String(userInput || '').split(',');
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    if (/^\d+\s/.test(part)) {
      return parts.slice(i).join(',').trim();
    }
  }
  return null;
}

// extractStreetNumber - leading "<digits> " in a string. Requires the
// trailing space so suite numbers ("Suite 200") and zero-spaced runs
// ("1800S Koeller") don't false-match.
function extractStreetNumber(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d+)\s/);
  return m ? m[1] : null;
}

// extractState - 2-letter US state code. Used to disambiguate common
// city names ("Springfield") in the geocoder.
function extractState(userInput) {
  const m = String(userInput || '').match(/\b([A-Z]{2})\b(?:\s+\d{5})?/);
  return m ? m[1] : null;
}

// extractKeyword - most-meaningful word from the BUSINESS NAME portion
// of the input (everything before the first comma). Used to narrow the
// nearby-search results to the right category, e.g. "baymont" pulls
// only Baymont-branded hotels out of a 200-meter radius.
//
// FIX 3a: returns null when the first comma-segment LOOKS LIKE an
// address (starts with digits). Pure-address inputs have no business
// name to extract a keyword from - caller will then fall back to
// "highest review-count business at that lat/lon" tiebreaker.
function extractKeyword(userInput) {
  const firstSegment = String(userInput || '').split(',')[0].trim();
  // Pure-address input - no business-name keyword to extract.
  if (/^\d+/.test(firstSegment)) return null;

  const namePart = firstSegment
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
  const words = namePart
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter((w) => !LOCALITY_WORDS.has(w))
    .filter((w) => !/^\d+$/.test(w));
  return words[0] || null;
}

// nameSimilarity - Jaccard-style overlap of meaningful words between
// the user input and a candidate's name. Returns 0.0-1.0. Filters out
// LOCALITY_WORDS + pure numbers + duplicates so common locality words
// (e.g. "oshkosh") don't inflate similarity.
function nameSimilarity(userInput, resultName) {
  if (!userInput || !resultName) return 0;
  const userWords = [
    ...new Set(
      String(userInput)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .filter((w) => !LOCALITY_WORDS.has(w))
        .filter((w) => !/^\d+$/.test(w))
    ),
  ];
  if (userWords.length === 0) return 0;
  const resultLower = String(resultName)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');
  const matches = userWords.filter((w) => resultLower.includes(w));
  return matches.length / userWords.length;
}

// isRealBusiness - distinguishes a business POI from a geocoded street
// address. Must carry establishment/POI types AND not be pure-address
// types only.
//
// FIX 4 (relaxed): the prior rating>0 OR reviews>0 activity requirement
// was disqualifying state parks, government buildings, museums, and
// other landmarks that legitimately have no Google rating in the API
// response. Now only the type signals are checked - that's enough to
// distinguish a business from a `street_address` geocoded entry.
function isRealBusiness(result) {
  if (!result) return false;
  const types = Array.isArray(result.types) ? result.types : [];
  const REAL_BUSINESS_TYPES = new Set([
    'establishment', 'point_of_interest',
  ]);
  const ADDRESS_ONLY_TYPES = new Set([
    'route', 'street_address', 'geocode',
    'premise', 'subpremise', 'plus_code',
    'street_number', 'political',
    'locality', 'postal_code',
    'administrative_area_level_1',
    'administrative_area_level_2',
    'country', 'natural_feature',
    'intersection',
  ]);
  const hasBusinessType = types.some((t) => REAL_BUSINESS_TYPES.has(t));
  const onlyAddressTypes = types.length > 0 && types.every((t) => ADDRESS_ONLY_TYPES.has(t));
  return hasBusinessType && !onlyAddressTypes;
}

// isOperationalOrUnknown - keeps a Places result if Google reports it
// as OPERATIONAL or doesn't report business_status at all (some places
// don't carry it). Drops CLOSED_PERMANENTLY / PERMANENTLY_CLOSED /
// CLOSED_TEMPORARILY so Claude never sees closed businesses in the
// data bundle (otherwise it suggests "partner with" / "match the menu
// of" a permanently-shuttered competitor). Logs every drop so the
// filter is auditable from the server console.
function isOperationalOrUnknown(result) {
  if (!result) return false;
  const s = result.business_status;
  if (s == null || s === 'OPERATIONAL') return true;
  console.log(
    '[places] filtered out:',
    result.name,
    '- status:',
    result.business_status
  );
  return false;
}

// scoreResult - composite score for a candidate result.
//   -999  = disqualified (not a real business)
//   100+  = high confidence (skip geocoding fallback)
//    60+  = medium confidence
//   <60   = low confidence (mark _low_confidence in output)
// Max possible: street(60) + name(60) + rating(10) + reviews(10) +
//               >50 reviews(5) + >200 reviews(5) = 150
function scoreResult(result, userInput) {
  if (!result) return -999;
  if (!isRealBusiness(result)) return -999;
  let score = 0;

  // Street-number scoring: 60 for exact match, 20 for "very close"
  // (within 10 - same building complex / mall row).
  const addressPart = extractAddressPart(userInput);
  const userStreet = extractStreetNumber(addressPart);
  const resultStreet = extractStreetNumber(result.formatted_address || result.vicinity || '');
  if (userStreet && resultStreet) {
    if (userStreet === resultStreet) {
      score += 60;
    } else {
      const diff = Math.abs(parseInt(userStreet, 10) - parseInt(resultStreet, 10));
      if (diff <= 10) score += 20;
    }
  }

  // Name similarity: max +60 (perfect overlap of meaningful words).
  const sim = nameSimilarity(userInput, result.name || '');
  score += Math.round(sim * 60);

  // Activity signals.
  if (typeof result.rating === 'number' && result.rating > 0) score += 10;
  const reviewCount = result.user_ratings_total || 0;
  if (reviewCount > 0) score += 10;
  if (reviewCount > 50) score += 5;
  if (reviewCount > 200) score += 5;

  return score;
}

// geocodeAddress - resolves an address string to { lat, lon }. Caches
// results (and nulls) for 30 days. Always appends `state` when present
// to disambiguate common city names.
async function geocodeAddress(addressStr, state, apiKey) {
  if (!addressStr) return null;
  const fullAddress = state ? `${addressStr}, ${state}` : addressStr;
  const cacheKey = fullAddress.toLowerCase().trim();
  const cached = GEOCODE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < GEOCODE_TTL_MS) {
    console.log(`[geocode] cache hit: ${fullAddress}`);
    return cached.value;
  }
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(fullAddress)}&key=${apiKey}`;

  // Audit fix GP2 - 15 s timeout per attempt, with one 3-s-back-off
  // retry on failure. Previously a bare `await fetch(url)` with no
  // timeout could pin the worker on a hung Google socket.
  async function tryOnce() {
    const resp = await fetchWithTimeout(url, { timeoutMs: 15000 });
    if (!resp.ok) throw new Error('Geocode HTTP ' + resp.status);
    const data = await resp.json().catch(() => null);
    if (!data) throw new Error('non-JSON response');
    if (data.status !== 'OK' || !(data.results && data.results[0])) {
      // Successful API call but no usable result - cache the null so
      // we don't re-fire on every retry.
      console.warn(`[geocode] no result for: ${fullAddress} status: ${data.status}`);
      GEOCODE_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const loc = data.results[0].geometry && data.results[0].geometry.location;
    if (!loc) {
      GEOCODE_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const result = { lat: loc.lat, lon: loc.lng };
    console.log(`[geocode] resolved: ${fullAddress} → ${result.lat}, ${result.lon}`);
    GEOCODE_CACHE.set(cacheKey, { ts: Date.now(), value: result });
    return result;
  }

  try {
    return await tryOnce();
  } catch (e1) {
    console.warn(`[geocode] attempt 1 failed for ${fullAddress} - retrying in 3 s: ${e1.message}`);
    await new Promise((r) => setTimeout(r, 3000));
    try {
      return await tryOnce();
    } catch (e2) {
      console.error(`[geocode] attempt 2 also failed for ${fullAddress}: ${e2.message}`);
      return null;
    }
  }
}

// doNearbySearch - calls Google Places Nearby Search at lat/lon with
// optional keyword filter. Returns a filtered list of real businesses
// (non-business POIs / geocoded entries are stripped via isRealBusiness).
async function doNearbySearch(lat, lon, radiusMeters, keyword, apiKey) {
  let url = `${NEARBY_URL}?location=${lat},${lon}&radius=${radiusMeters}&key=${apiKey}`;
  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;

  // Audit fix GP4 - 15 s timeout per attempt with one 3-s-back-off
  // retry, same pattern as geocodeAddress above. Previously a bare
  // `await fetch(url)` with no timeout.
  async function tryOnce() {
    const resp = await fetchWithTimeout(url, { timeoutMs: 15000 });
    if (!resp.ok) throw new Error('Nearby HTTP ' + resp.status);
    const data = await resp.json().catch(() => null);
    if (!data) throw new Error('non-JSON response');
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn(`[nearby] status: ${data.status}`);
      return [];
    }
    const results = (data.results || []).filter(isRealBusiness);
    console.log(`[nearby] ${radiusMeters}m keyword: ${keyword || 'none'} → ${results.length} businesses`);
    return results;
  }

  try {
    return await tryOnce();
  } catch (e1) {
    console.warn(`[nearby] attempt 1 failed - retrying in 3 s: ${e1.message}`);
    await new Promise((r) => setTimeout(r, 3000));
    try {
      return await tryOnce();
    } catch (e2) {
      console.error(`[nearby] attempt 2 also failed: ${e2.message}`);
      return [];
    }
  }
}

async function findPlace(query, apiKey) {
  // ─────────────────────────────────────────────────────────────────
  // 7-STEP RESOLVER WITH GEOCODING FALLBACK
  // ─────────────────────────────────────────────────────────────────
  // Replaces the prior parallel-2-search approach which couldn't
  // recover when Google's Text Search returned the wrong business
  // (e.g. "Baymont by Wyndham Oshkosh Airport, 1581 W South Park Ave"
  // → Wingate at 1800 S Koeller). The new resolver geocodes the
  // user's address and does a Nearby Search at that lat/lon when
  // text-search confidence is low - cutting through Google's name-
  // weighted ranking volatility.
  //
  // STEP 1 - parse user input
  // STEP 2 - run text searches in parallel (top-5 from each)
  // STEP 3 - score every unique candidate
  // STEP 4 - high-confidence (score ≥ 100) → return
  // STEP 5 - geocoding fallback (50m → 100m → 200m radii with keyword)
  // STEP 6 - return best text-search result with confidence markers
  // STEP 7 - null if nothing usable
  //
  // toResult - preserves _low_confidence + _user_input markers when
  // the resolver isn't sure (renderReport reads these to render a
  // "closest match found" warning banner).
  function toResult(top, opts) {
    const out = {
      place_id: top.place_id,
      name: top.name,
      // FIX 1: fall back to `vicinity` when formatted_address is absent.
      // Nearby Search results carry their address in `vicinity`, not
      // `formatted_address`. Without this fallback, geocoding-fallback
      // winners were silently losing their address (Baymont test #31,
      // Panera #64, Colectivo #71, etc. - 9 false-negative test cases).
      formatted_address: top.formatted_address || top.vicinity || null,
      types: Array.isArray(top.types) ? top.types : [],
      // Phase 5+ - Text Search responses include geometry; surfacing it
      // saves /market-analysis from making an extra getDetails round-trip
      // just to read lat/lng for downstream fetchers.
      geometry: top.geometry || null,
    };
    if (opts && opts.low_confidence) {
      out._low_confidence = true;
      out._user_input = opts.user_input || null;
    }
    return out;
  }

  console.log(`[findPlace] input: ${query}`);

  // ── STEP 1 - Parse user input ───────────────────────────────────
  const addressPart = extractAddressPart(query);
  const userStreetNum = extractStreetNumber(addressPart);
  const state = extractState(query);
  const keyword = extractKeyword(query);
  console.log(
    `[findPlace] address: ${addressPart || '(none)'} | street: ${userStreetNum || '(none)'} | state: ${state || '(none)'} | keyword: ${keyword || '(none)'}`
  );

  // ── STEP 2 - Run text searches in parallel ──────────────────────
  const searches = [doTextSearch(query, apiKey).catch((err) => {
    console.warn(`[findPlace] search1 (full query) failed: ${err.message}`);
    return [];
  })];
  if (addressPart) {
    searches.push(doTextSearch(addressPart, apiKey).catch((err) => {
      console.warn(`[findPlace] search2 (address-only) failed: ${err.message}`);
      return [];
    }));
  }
  const settled = await Promise.allSettled(searches);
  const candidates = [];
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      const arr = settled[i].value || [];
      for (const r of arr.slice(0, 5)) candidates.push(r);
    } else {
      console.warn(`[findPlace] search${i + 1} rejected: ${settled[i].reason && settled[i].reason.message}`);
    }
  }
  if (candidates.length === 0) {
    console.warn(`[findPlace] both text searches returned 0 results for: ${query}`);
    // Fall through to geocoding fallback if we have an address.
  }

  // Deduplicate by place_id.
  const seen = new Set();
  const uniqueCandidates = candidates.filter((c) => {
    if (!c || !c.place_id) return false;
    if (seen.has(c.place_id)) return false;
    seen.add(c.place_id);
    return true;
  });

  // ── STEP 3 - Score all candidates ───────────────────────────────
  const scored = uniqueCandidates
    .map((c) => ({ result: c, score: scoreResult(c, query) }))
    .filter((s) => s.score > -999)
    .sort((a, b) => b.score - a.score);

  for (const s of scored) {
    console.log(
      `[findPlace] candidate: ${s.result.name} | ${s.result.formatted_address} `
      + `| score: ${s.score} | sim: ${nameSimilarity(query, s.result.name).toFixed(2)}`
    );
  }
  const best = scored[0] || null;

  // ── STEP 4 - High confidence → return ──────────────────────────
  // FIX 2: threshold depends on whether the user gave us a street
  // number. With a street number, we should be MORE aggressive about
  // forcing the geocoding fallback to kick in (chains like McDonald's
  // / Subway / Starbucks return their most-popular location for the
  // brand search and ignore the street number - only geocoding can
  // disambiguate). Without a street number, we have nothing better
  // to compare against, so the original 100 threshold stands.
  const highConfidenceThreshold = userStreetNum ? 120 : 100;
  if (best && best.score >= highConfidenceThreshold) {
    console.log(`[findPlace] HIGH CONFIDENCE: ${best.result.name} score: ${best.score} (threshold: ${highConfidenceThreshold})`);
    console.log(`[findPlace] using: ${best.result.name} ${best.result.formatted_address}`);
    return toResult(best.result);
  }

  // ── STEP 5 - Geocoding fallback ─────────────────────────────────
  // Fires when we have a parseable street address AND text-search
  // confidence is below the threshold. Tries small radii first to
  // keep results focused.
  if (addressPart) {
    console.log(
      `[findPlace] low confidence: ${best ? best.score : 0} (threshold: ${highConfidenceThreshold}) - trying geocoding fallback`
    );
    const geo = await geocodeAddress(addressPart, state, apiKey);
    if (geo) {
      const radii = [50, 100, 200];
      for (const radius of radii) {
        const nearby = await doNearbySearch(geo.lat, geo.lon, radius, keyword, apiKey);
        if (nearby.length === 0) {
          console.log(`[findPlace] no results at ${radius}m - expanding`);
          continue;
        }

        // FIX 2 score boost: nearby results that have an EXACT street
        // match get a +50 bonus on top of their base score. This makes
        // McDonald's-at-3902 (the user's actual address) crush
        // McDonald's-at-4502 (Google's most-popular suggestion) when
        // geocoding finds both within radius. Without this boost both
        // chain locations score equally on name and we can't tell them
        // apart.
        const nearbyScored = nearby
          .map((r) => {
            let score = scoreResult(r, query);
            const nearbyAddr = r.formatted_address || r.vicinity || '';
            const nearbyStreetNum = extractStreetNumber(nearbyAddr);
            const exactStreetMatch = userStreetNum
              && nearbyStreetNum
              && nearbyStreetNum === userStreetNum;
            if (exactStreetMatch && score > -999) score += 50;
            return {
              result: r,
              score,
              sim: nameSimilarity(query, r.name || ''),
              exactStreetMatch: !!exactStreetMatch,
              reviews: typeof r.user_ratings_total === 'number' ? r.user_ratings_total : 0,
            };
          })
          .filter((s) => s.score > -999);

        // FIX 3b: when there's no business-name keyword (pure-address
        // input), the winner is the most-established business at the
        // address - sort by review count desc instead of by score, since
        // all results have similar weak scores without a name to anchor.
        if (!keyword) {
          nearbyScored.sort((a, b) => {
            if (a.exactStreetMatch !== b.exactStreetMatch) {
              return a.exactStreetMatch ? -1 : 1;
            }
            return b.reviews - a.reviews;
          });
        } else {
          nearbyScored.sort((a, b) => b.score - a.score);
        }

        for (const s of nearbyScored) {
          const tag = s.exactStreetMatch ? ' [street+50]' : '';
          console.log(
            `[findPlace] nearby(${radius}m): ${s.result.name} `
            + `| score: ${s.score}${tag} | sim: ${s.sim.toFixed(2)} | reviews: ${s.reviews}`
          );
        }
        const bestNearby = nearbyScored[0];
        if (!bestNearby) {
          console.log(`[findPlace] nearby results all disqualified at ${radius}m`);
          continue;
        }

        // Use nearby winner when ANY of:
        //   (A) exact street match (FIX 2 - strongest signal possible)
        //   (B) score-with-bonus ≥ 60 AND sim ≥ 0.2 (street match path)
        //   (C) score meaningfully better than text result (best+10)
        //   (D) keyword is null (pure address input - review-count winner)
        const hasStreetMatch = bestNearby.score >= 60 && bestNearby.sim >= 0.2;
        const betterThanText = bestNearby.score > (best ? best.score : 0) + 10;
        const pureAddressInput = !keyword;
        if (bestNearby.exactStreetMatch || hasStreetMatch || betterThanText || pureAddressInput) {
          const reasons = [];
          if (bestNearby.exactStreetMatch) reasons.push('exact street');
          if (hasStreetMatch) reasons.push('street+sim');
          if (betterThanText) reasons.push('beats text');
          if (pureAddressInput) reasons.push('pure-address review-count winner');
          console.log(
            `[findPlace] GEOCODE WINNER: ${bestNearby.result.name} `
            + `| score: ${bestNearby.score} | reasons: ${reasons.join(', ')}`
          );
          const winnerAddr = bestNearby.result.formatted_address || bestNearby.result.vicinity || '';
          console.log(`[findPlace] using: ${bestNearby.result.name} ${winnerAddr}`);
          return toResult(bestNearby.result);
        }

        console.log(
          `[findPlace] nearby results not better than text search - stopping at ${radius}m`
        );
        break;
      }
    }
  }

  // ── STEP 6 - Use best text result, mark confidence ─────────────
  if (best) {
    if (best.score < 60) {
      console.warn(
        `[findPlace] LOW CONFIDENCE result: ${best.result.name} `
        + `score: ${best.score} - may be wrong business`
      );
      console.log(`[findPlace] using: ${best.result.name} ${best.result.formatted_address}`);
      return toResult(best.result, { low_confidence: true, user_input: query });
    }
    console.log(
      `[findPlace] MEDIUM CONFIDENCE: ${best.result.name} score: ${best.score}`
    );
    console.log(`[findPlace] using: ${best.result.name} ${best.result.formatted_address}`);
    return toResult(best.result);
  }

  // ── STEP 7 - Nothing found ─────────────────────────────────────
  console.error(`[findPlace] no result found for: ${query}`);
  return null;
}

async function getDetails(placeId, apiKey) {
  if (!placeId) throw new Error('getDetails: placeId required');

  // Check cache first - 24h TTL per BATCH13 spec p.5.
  const cached = DETAILS_CACHE.get(placeId);
  if (cached && Date.now() - cached.ts < DETAILS_TTL_MS) {
    console.log(`[cache] details hit for ${placeId}`);
    return cached.value;
  }

  const url = `${DETAILS_URL}?place_id=${encodeURIComponent(placeId)}&fields=${DETAIL_FIELDS}&reviews_sort=newest&key=${apiKey}`;
  const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
  if (!res.ok) throw new Error(`Places Details HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK') {
    throw new Error(`Places Details status=${json.status} ${json.error_message || ''}`);
  }
  // Successful fetch - store in cache before returning.
  DETAILS_CACHE.set(placeId, { ts: Date.now(), value: json.result });
  return json.result;
}

/* Map Places Details response to the algorithm's INPUT_FIELDS shape.
   Required: place_id, google_rating, google_review_count, business_status.
   BATCH14 additions:
     - latitude/longitude (from geometry - needed for Nearby Search)
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

  // Review recency - DISABLED.
  // Google Places API returns max 5 reviews sorted by RELEVANCE, not by
  // date. reviews[0] is therefore not guaranteed to be the most recent
  // review, and the resulting "days ago" number is unreliable for any
  // business size (verified: a 1,393-review restaurant returned reviews
  // out of date order with the freshest at index #3). We force this to
  // null so downstream code (claudeEnricher, ranker, server diag) skips
  // every recency-based recommendation/risk rather than fire on noise.
  const reviewRecencyDays = null;

  // Owner-response detection - DISABLED for headline metrics.
  // Google Places API returns max 5 reviews (sorted by relevance). A
  // response rate computed from 5 reviews is unreliable for any business
  // with meaningful review volume: a restaurant with 1,393 total reviews
  // may have replied to 500 of them, but if the 5 we sampled have no
  // visible owner_reply the calculated rate is 0% - a confidently wrong
  // signal. We force responds_to_reviews and response_rate_estimated to
  // null so downstream code (claudeEnricher, ranker, server diag) skips
  // every response-rate-based recommendation/risk rather than fire on
  // sample noise.
  //
  // We still compute reviewsWithResponse below because the sample may
  // surface a POSITIVE signal (any reply present → owner is engaged at
  // all). That positive signal could be useful for SYSTEM_PROMPT_A's
  // optional "owner actively responds" mention, but is NOT exposed as
  // a quantitative metric.
  const reviewsWithResponse = reviews.filter((r) =>
    r && (
      (r.author_response && (r.author_response.text || r.author_response)) ||
      (r.owner_response && (r.owner_response.text || r.owner_response)) ||
      (r.response && r.response.text) ||
      r.translated_response
    )
  );
  // Suppress reviewsWithResponse unused-variable lint when nothing
  // downstream reads it (preserved as documentation of the sample).
  void reviewsWithResponse;
  const respondsToReviews = null;
  const responseRateEstimated = null;

  // Hours completeness - opening_hours.weekday_text is an array of 7 strings
  // when fully populated. Some businesses list only a subset (e.g. "Mon-Fri"
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
    // Photo count semantics - Google Places API caps the `photos` array at
    // 10 regardless of how many photos the business actually has on Google
    // Maps. A business with 10 photos in the API response could have 10,
    // 50, or 500+ in reality - there is no signal that distinguishes them.
    // We therefore expose the count only when it's BELOW the cap (genuinely
    // low, actionable data) and null it out at/above the cap (unknown).
    // Downstream (claudeEnricher) treats null as "do not mention" and a
    // real number as "the business genuinely has few photos - flag it".
    photo_count: Array.isArray(detail.photos)
      ? (detail.photos.length >= 10 ? null : detail.photos.length)
      : 0,
    review_recency_days: reviewRecencyDays,

    // BATCH14 - review response
    responds_to_reviews: respondsToReviews,
    response_rate_estimated: responseRateEstimated,
    reviews_sampled: reviews.length,

    // BATCH14 - operations: hours
    hours_complete: hoursComplete,
    hours_has_special: hoursHasSpecial,
    is_open_now: isOpenNow,
    weekday_text: weekdayText,

    // BATCH14 - geo (used for Nearby Search and distance calculations)
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
   Prefer the first remaining type - Google orders these primary-first. */
function pickNearbySearchType(types) {
  if (!Array.isArray(types) || !types.length) return null;
  const skip = new Set(['establishment', 'point_of_interest', 'food', 'health', 'store']);
  for (const t of types) {
    if (!skip.has(t)) return t;
  }
  return null;
}

/* fetchNearbyCompetitors - 4-source competitor-discovery waterfall.

   Sources, run in order, stop when post-filter pool ≥ POOL_TARGET (5):
     1. Google Nearby Search with `type=`, radius ladder 5/15/50 mi
     2. Google Places Text Search with locality-biased synonym queries
        (delegated to dataFetchers.fetchGoogleTextCompetitors)
     3. Google Nearby Search with NO type, `keyword=` instead - catches
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

// Legacy radius ladder kept as a fallback constant the new query-driven
// path doesn't use anymore. The per-business smart radius is now picked
// by getCompetitorRadius(population, naics2, city) below.
const RADIUS_FALLBACKS = [8047, 24140, 80467]; // 5mi / 15mi / 50mi in meters
const POOL_TARGET = 5;

// ─────────────────────────────────────────────────────────────────────
// FIX 1 - buildCompetitorQuery
// ─────────────────────────────────────────────────────────────────────
// Build a Google Text Search query string from the subject business's
// NAICS-6 / Google types / business name. Replaces the old type-based
// Nearby Search which surfaced spurious matches (campgrounds for hotels,
// hypnotherapy for honey farms) because Google's `type` filter is too
// coarse and `keyword=` matches anywhere in name/desc.
//
// Resolution order (first hit wins):
//   1. Exact NAICS-6 lookup in NAICS_QUERIES - highest specificity
//   2. NAICS-4 prefix match - broader fallback
//   3. First non-generic Google type, with underscores → spaces
//   4. Keyword extracted from the business name itself
//   5. The business name (chain identifiers stripped, first 3 words)
const NAICS_QUERIES = {
  // Agriculture
  '112910': 'honey farm apiary beekeeper',
  '111331': 'apple orchard fruit farm pick your own orchard',
  '111332': 'vineyard grape farm winery grape supplier',
  '111333': 'berry farm pick-your-own',
  '111411': 'mushroom farm specialty fungi mushroom grower producer',
  '111419': 'hydroponic farm vertical farm indoor growing controlled environment agriculture',
  '111421': 'christmas tree farm nursery',
  '111998': 'agritourism farm pick-your-own pumpkin patch',
  '111':    'farm produce agriculture',
  // Livestock (112xxx) - consumer-facing animal operations
  '112120': 'dairy farm creamery milk farm cheese producer',
  '112210': 'pig farm hog farm pork producer livestock',
  '112300': 'chicken farm poultry farm egg farm hatchery',
  '112410': 'sheep farm lamb farm wool producer',
  '112420': 'goat farm goat dairy goat cheese livestock',
  // Note: '112130' (Dual-Purpose Cattle Ranching) WAS keyed as 'petting
  // zoo farm' - wrong NAICS (petting zoos are 712130, separate entry).
  // Removed in this batch; petting zoos hit 712130 below.
  '112':    'livestock farm ranch',
  // Retail food manufacturing (consumer-facing storefronts).
  '311811': 'bakery pastry shop donut shop bread artisan bakery',
  '311812': 'bakery pastry shop donut shop bread artisan bakery',
  // Food and beverage production (consumer-facing variants)
  '312120': 'brewery taproom brewpub craft beer',
  '312130': 'winery vineyard wine tasting room',
  '312140': 'distillery spirits whiskey tasting room',
  '312':    'brewery winery distillery',
  // Real estate - food hall operators (lessor of food vendor space)
  '531120': 'food hall market hall food market indoor market vendor',
  // Accommodation
  '721110': 'hotel motel inn',
  '721191': 'bed and breakfast inn',
  '721199': 'short term rental vacation rental airbnb vrbo holiday home',
  '721211': 'campground camping rv park outdoor recreation tent camping',
  '721310': 'hostel backpacker budget accommodation dormitory shared room lodging',
  // Food service
  '722511': 'restaurant dining',
  '722513': 'restaurant fast food',
  '722515': 'cafe coffee shop',
  '722410': 'bar pub brewery',
  '722330': 'food truck mobile food street food vendor',
  '722320': 'event venue caterer wedding venue',
  '722599': 'ghost kitchen cloud kitchen delivery restaurant virtual kitchen',
  // Retail - grocery / specialty food
  '445110': 'grocery supermarket',
  '445131': 'convenience store c-store corner store mini mart gas station',
  '445230': 'farmers market outdoor market community market public market',
  '445298': 'specialty food store',
  '445320': 'liquor store wine shop spirits store beer wine bottle shop',
  // Retail - pets / home / general merchandise
  '459910': 'pet supply store',
  '444110': 'home center hardware',
  '449110': 'furniture store home furnishings sofa mattress bedroom living room decor',
  '449129': 'mattress store mattress firm sleep shop bedding store',
  '459110': 'sporting goods store outdoor gear bike shop hunting fishing outdoor',
  '459120': 'toy store game store hobby shop board game store kids toys educational toys',
  '459210': 'bookstore independent books used books comic book store library bookshop',
  '459310': 'florist flower shop floral design wedding flowers flower delivery',
  '459420': 'gift shop souvenir store novelty shop gifts tourist shop',
  '459510': 'antique store antique mall vintage shop consignment thrift store second hand',
  '459991': 'vape shop e-cigarette smoke shop tobacco shop',
  // Retail - apparel / shoes / jewelry
  '458110': 'clothing store boutique fashion apparel retail women men clothing',
  '458210': 'shoe store footwear retail sneaker store boot shop',
  '458310': 'jewelry store jeweler diamond engagement ring watch store fine jewelry',
  // Health
  '621210': 'dental office dentist',
  '621111': 'medical clinic doctor',
  '621310': 'chiropractor',
  '621320': 'optometrist eye doctor vision center optical',
  '621330': 'therapist counseling',
  '621340': 'physical therapy sports rehabilitation PT clinic occupational therapy',
  '621493': 'urgent care walk-in clinic immediate care after hours medical',
  '622110': 'hospital medical center regional hospital health system general hospital',
  '541940': 'veterinary clinic animal hospital pet care veterinarian vet',
  '621399': 'acupuncture traditional chinese medicine holistic health alternative medicine wellness',
  '812199': 'day spa massage spa wellness spa beauty spa med spa float tank cryotherapy',
  // Instruction / fitness / recreation niches that share NAICS-3 with
  // larger categories - explicit entries so competitor pools are
  // on-target.
  '611610': 'dance studio ballet jazz hip hop music school piano guitar violin lessons arts classes performing arts',
  '611519': 'cooking school culinary classes cooking class chef trade school vocational school technical program career training',
  '611310': 'university college campus higher education community college liberal arts four year university',
  '624410': 'daycare preschool childcare early childhood education Montessori child development center learning',
  '611620': 'martial arts school karate taekwondo judo dojo self defense classes MMA',
  '713950': 'bowling alley bowling center lanes bowling league',
  '812112': 'hair salon beauty',
  '812111': 'barbershop',
  '812113': 'nail salon',
  // Auto
  '811111': 'auto repair mechanic',
  '811192': 'car wash',
  '441110': 'car dealership',
  '441210': 'rv dealer motorhome camper trailer recreational vehicle RV sales Camping World',
  '441222': 'boat dealer marine dealer pontoon fishing boat yacht dealer watercraft boat sales',
  '713930': 'marina yacht club boat club harbor marina boat slip slip rental boat dock harbor master mooring',
  '441227': 'motorcycle dealer Harley Davidson powersports dealer motorcycle shop motorbike dealer',
  '441330': 'tire dealer tire shop tire store discount tire tire center tire warehouse wheel alignment',
  '457110': 'gas station fuel station convenience store petrol service station filling station',
  '447110': 'truck stop travel center travel plaza diesel fuel trucker amenities Pilot Flying J Loves',
  '485310': 'taxi cab service taxi company airport taxi rideshare cab',
  '485320': 'limousine service limo rental chauffeur wedding limo airport transportation luxury car service',
  '484110': 'trucking company freight carrier logistics hauling commercial trucking long haul',
  '484122': 'trucking freight carrier less than truckload LTL regional trucking shipping',
  '488510': 'freight broker logistics broker shipping broker freight brokerage carrier network load board',
  '488410': 'towing company roadside assistance wrecker service tow truck AAA',
  '484210': 'moving company movers residential moving local movers long distance moving storage',
  '812310': 'laundromat coin laundry self service laundry wash dry fold laundry mat',
  '812320': 'dry cleaner laundry service dry cleaning alterations wash and fold pickup delivery',
  '323111': 'print shop copy center printing service business cards banner sign printing custom t-shirt printing',
  '541921': 'photography studio wedding photographer portrait studio headshots commercial photography photo booth',
  '812990': 'event planner wedding planner event coordinator corporate event planning party planner',
  // Fitness
  '713940': 'gym fitness center aquatic center swim club pool',
  // Education
  '611110': 'school education',
  '611691': 'tutoring center',
  // Professional
  '541110': 'law office attorney',
  '541211': 'accounting CPA',
  '522110': 'bank',
  '523940': 'financial advisor wealth management investment advisor financial planner retirement planning CFP',
  '524210': 'insurance agency auto home life insurance agent broker independent insurance State Farm Allstate',
  '531210': 'real estate agency broker realtor home sales property listing agent Coldwell Banker RE/MAX Keller',
  '522292': 'mortgage broker mortgage lender home loan refinance mortgage company home purchase loan',
  // Alt-finance / nondepository credit (pawn shops, check cashing, payday,
  // title loans, money transmitters). Routed to finance.alt_lending profile.
  '522298': 'pawn shop cash for gold second hand store',
  '522390': 'check cashing money transfer payday loan',
  '522291': 'consumer lending personal loan title loan',
  // Construction trades / home services
  '238220': 'plumber plumbing service emergency plumber water heater drain cleaning sewer repair',
  '238210': 'electrician electrical contractor licensed electrician wiring panel upgrade electrical repair service',
  '238160': 'roofing contractor roofer roof repair roof replacement shingles gutter installation',
  '238320': 'painter house painter interior exterior painting painting contractor',
  '236220': 'general contractor commercial contractor building contractor construction company renovation contractor',
  // Facility & property services
  '561710': 'pest control exterminator termite control bed bug treatment rodent control',
  '561720': 'cleaning service house cleaning maid service commercial cleaning janitorial deep cleaning',
  '561730': 'landscaping lawn care tree service arborist lawn maintenance snow removal yard service',
  '561790': 'pool service pool cleaning pool maintenance pool repair swimming pool service',
  // Funeral / death care
  '812210': 'funeral home',
  '812220': 'cemetery memorial park burial ground funeral',
  // Entertainment / experiences
  '713110': 'amusement park',
  '713910': 'golf course country club golf resort public golf private golf course',
  '459920': 'art gallery fine art gallery contemporary art painting sculpture exhibition',
  '712120': 'historical site heritage site historic museum landmark historical society',
  '712219': 'horse stable equestrian center horse boarding riding lessons horse ranch',
  '711110': 'live theater community theater playhouse dinner theater performing arts theater company',
  '711120': 'dance company ballet company dance troupe performing arts dance theater',
  '711219': 'ice rink hockey rink ice arena skating rink ice complex figure skating',
  '713920': 'ski resort ski area ski hill snowboard resort winter resort alpine skiing',
  '532292': 'kayak rental canoe rental bike rental outdoor equipment rental paddleboard',
  '487210': 'fishing charter boat charter sport fishing guided fishing hunting guide outfitter',
  '713990': 'entertainment venue escape room axe throwing trampoline park',
  '711510': 'paint and sip studio painting class wine art class creative studio art experience',
  '712130': 'zoo aquarium wildlife park botanical garden nature center animal sanctuary',
  '459999': 'crystal shop metaphysical store spiritual goods new age healing crystals tarot',
  // NAICS-keyed targeted queries for niche businesses that fall through
  // the generic catch-alls. Optometry covered separately above.
  // NOTE: '812199' lives at line ~847 above with the richer spa query -
  // a duplicate entry here was silently overwriting it (JS object-literal
  // last-wins semantics) so day spas / massage spas / med spas were
  // getting the narrow "float tank wellness specialty" query instead.
  // Duplicate removed in this batch; richer query at line ~847 is canonical.
  '561520': 'tour operator ghost tour walking tour company',
  '711190': 'comedy club live entertainment performance venue',
  '711310': 'concert hall performing arts center symphony orchestra cultural center auditorium',
  '512131': 'movie theater cinema multiplex film theater AMC Regal Cinemark',
  '512132': 'drive-in theater outdoor cinema movie theater',
  '713120': 'arcade video game arcade barcade family entertainment center gaming',
  // BUG 26 - Removed 11 keyword-keyed entries (knife_throwing, hookah,
  // cat_cafe, rage_room, ghost_tour, sensory_deprivation, cryotherapy,
  // iv_drip, oxygen_bar, psychic, crystal_shop). They were dead code:
  // buildCompetitorQuery only ever looks up NAICS-6 keys, never these
  // string keys. The niche queries they covered are now all reachable
  // via NAICS routes - axe/knife throwing via 713990; cat cafe via the
  // restaurant routes; hookah / oxygen bar / IV drip / cryotherapy /
  // sensory deprivation via 812199 (specialty wellness); ghost tour
  // via 561520; psychic / crystal shop via 459999.
};

const COMPETITOR_QUERY_SKIP_TYPES = new Set([
  'establishment', 'point_of_interest',
  'food', 'health', 'store', 'finance',
  'local_government_office',
]);

const COMPETITOR_NAME_KEYWORDS = [
  'dental', 'dentist', 'orthodont',
  'medical', 'clinic', 'doctor', 'physician',
  'lawyer', 'attorney', 'law',
  'accounting', 'CPA', 'tax',
  'hotel', 'motel', 'inn', 'suites',
  'restaurant', 'diner', 'grill', 'bistro',
  'cafe', 'coffee', 'espresso',
  'bar', 'pub', 'brewery', 'taproom',
  'gym', 'fitness', 'yoga', 'pilates',
  'salon', 'barbershop', 'spa',
  'auto', 'mechanic', 'repair',
  'pet', 'veterinary', 'vet',
  'pharmacy', 'drug store',
  'grocery', 'market', 'food',
  'hardware', 'lumber',
  'insurance', 'agency',
  'funeral', 'mortuary',
  'church', 'chapel',
  'school', 'academy', 'tutoring',
  'bank', 'credit union',
  'car wash', 'detail',
  'pizza', 'burger', 'taco', 'sushi',
  'bakery', 'donut', 'pastry',
  'honey', 'apiary', 'bee',
  'winery', 'vineyard',
  'farm', 'orchard', 'ranch',
];

// ─────────────────────────────────────────────────────────────────────
// RESTAURANT CUISINE DETECTION - used only when naics6 starts with 722
// ─────────────────────────────────────────────────────────────────────
// 6-layer pipeline: Google's own cuisine type → review keyword scoring
// (with name multiplier for fusion-aware tie-breaking) → strong single
// keywords → name cultural signals → chain category map → generic
// 'restaurant dining' fallback. Designed to convert the prior
// 'restaurant dining near {city}' (which returns a mix of cuisines
// ranked by Google prominence) into cuisine-specific queries that
// surface real peer competitors. Spec: BATCH-cuisine-detection.
//
// IMPORTANT - gating: the spec called for `naics2 === '72'`, but
// NAICS-72 is "Accommodation AND Food Services" so that condition
// would also fire on hotels (721xxx) and route them through Layer 6
// fallback. We use `naics6.startsWith('722')` to confine cuisine
// detection to food service only.
// BUG-1 fix: removed 'cafe', 'bar', 'bakery' from this map. Google
// tags MOST full-service restaurants with `bar` (and many burger
// joints with `bakery`) as the FIRST type - Layer 1 was hijacking
// 25+ subjects (Le Bernardin, Eddie V's, Nobu, Olive Garden, etc.)
// into "bar pub near {city}" or "bakery near {city}" queries that
// produced zero cuisine-relevant competitors. Generic types
// (`food`, `establishment`, `point_of_interest`, `meal_takeaway`,
// `meal_delivery`, `night_club`) were never in this map and remain
// excluded. Added `caribbean_restaurant` per spec.
const GOOGLE_CUISINE_TYPES = {
  'indian_restaurant':         'indian restaurant',
  'chinese_restaurant':        'chinese restaurant',
  'japanese_restaurant':       'japanese restaurant',
  'korean_restaurant':         'korean restaurant',
  'thai_restaurant':           'thai restaurant',
  'vietnamese_restaurant':     'vietnamese restaurant pho',
  'mexican_restaurant':        'mexican restaurant',
  'italian_restaurant':        'italian restaurant',
  'french_restaurant':         'french restaurant bistro',
  'greek_restaurant':          'greek restaurant',
  'mediterranean_restaurant':  'mediterranean restaurant',
  'middle_eastern_restaurant': 'middle eastern restaurant',
  'american_restaurant':       'american restaurant',
  'seafood_restaurant':        'seafood restaurant',
  'steak_house':               'steakhouse steak restaurant',
  'pizza_restaurant':          'pizza restaurant',
  'fast_food_restaurant':      'fast food restaurant',
  'breakfast_restaurant':      'breakfast brunch restaurant',
  'hamburger_restaurant':      'burger restaurant',
  'sandwich_shop':             'sandwich deli',
  'ramen_restaurant':          'ramen japanese restaurant',
  'sushi_restaurant':          'sushi japanese restaurant',
  'bbq_restaurant':            'BBQ barbecue restaurant',
  'vegetarian_restaurant':     'vegetarian vegan restaurant',
  'caribbean_restaurant':      'caribbean restaurant',
};

const CUISINE_FOOD_KEYWORDS = {
  indian: [
    'butter chicken', 'naan', 'biryani',
    'tikka', 'curry', 'dal', 'paneer',
    'masala', 'samosa', 'tandoor', 'korma',
    'vindaloo', 'chutney', 'lassi',
    'dosa', 'idli', 'chapati', 'roti',
    'saag', 'palak', 'makhani', 'kulfi',
  ],
  chinese: [
    // BUG-6 FIX-8: added xiao long bao, har gow, etc. - Chinese
    // restaurants like Din Tai Fung, Joe's Shanghai, Hakkasan have
    // reviews dominated by these specific terms not the generic
    // ones from the original list.
    'xiao long bao', 'soup dumpling', 'har gow',
    'siu mai', 'char siu bao', 'century egg',
    'dan dan noodles', 'malatang', 'hong shao rou',
    'kung pao chicken', 'sweet and sour',
    'wonton noodle', 'rice noodle roll',
    'turnip cake', 'egg tart chinese',
    'dim sum', 'dumpling', 'wonton',
    'fried rice', 'chow mein', 'lo mein',
    'kung pao', 'general tso', 'egg roll',
    'spring roll', 'peking', 'szechuan',
    'mapo tofu', 'bao', 'char siu', 'congee',
    'hot pot chinese', 'potsticker',
  ],
  japanese: [
    'sushi', 'ramen', 'tempura', 'teriyaki',
    'miso', 'udon', 'soba', 'edamame',
    'yakitori', 'tonkatsu', 'gyoza',
    'matcha', 'nigiri', 'sashimi',
    'hibachi', 'wagyu', 'bento', 'katsu',
    'yakisoba', 'onigiri', 'takoyaki',
  ],
  korean: [
    // BUG-6 FIX-6: added Korean dish terms that appear in reviews
    // of US Korean restaurants.
    'korean fried chicken', 'army stew',
    'budae jjigae', 'tteokgalbi',
    'haemul pajeon', 'yukhoe',
    'ganjang gejang', 'dwaeji galbi',
    'samgyetang', 'cold noodle',
    'kimchi', 'bibimbap', 'bulgogi', 'galbi',
    'japchae', 'tteokbokki', 'sundubu',
    'samgyeopsal', 'kbbq', 'korean bbq',
    'banchan', 'soju', 'doenjang', 'gochujang',
  ],
  thai: [
    'pad thai', 'green curry', 'red curry',
    'tom yum', 'tom kha', 'satay',
    'mango sticky rice', 'larb', 'papaya salad',
    'massaman', 'thai basil', 'galangal',
    'pad see ew', 'khao pad', 'som tum',
  ],
  vietnamese: [
    'pho', 'banh mi', 'spring roll vietnamese',
    'vermicelli', 'bun bo', 'com tam',
    'nuoc cham', 'lemongrass vietnamese',
    'rice paper', 'fresh roll', 'bun rieu',
    'ca phe', 'vietnamese coffee',
  ],
  mexican: [
    'taco', 'burrito', 'enchilada', 'tamale',
    'guacamole', 'salsa', 'tortilla',
    'carnitas', 'al pastor', 'mole',
    'queso', 'horchata', 'churro',
    'pozole', 'birria', 'elote', 'fajita',
    'quesadilla', 'chile relleno',
  ],
  italian: [
    // BUG-3 fix: removed 'pizza' and 'marinara' - both terms appear
    // heavily in pizza-restaurant reviews and were beating the pizza
    // category in Layer 2 review scoring (Lucali, Una Pizza
    // Napoletana, Pizza Hut all routed to italian instead of pizza).
    'pasta', 'risotto', 'tiramisu',
    'carbonara', 'bruschetta', 'gelato',
    'gnocchi', 'ossobuco', 'parmigiana',
    'prosciutto', 'arancini', 'cannoli',
    'lasagna', 'ravioli', 'linguine',
    'fettuccine', 'pesto',
  ],
  french: [
    // BUG-6 FIX-3: added named French dishes that show up
    // routinely in reviews of US French restaurants.
    // BUG-D: 'french toast' moved here from breakfast.
    'french toast',
    'duck confit', 'beef bourguignon',
    'bouillabaisse french', 'french onion soup',
    'coq au vin', 'croque monsieur',
    'steak frites', 'tarte tatin',
    'creme brulee', 'french press',
    'beurre blanc', 'sauce hollandaise',
    'plateau de fromages',
    'croissant', 'crepe', 'baguette',
    'bouillabaisse',
    'ratatouille', 'foie gras', 'escargot',
    'souffle', 'boeuf bourguignon',
    'profiterole', 'quiche', 'mousse',
  ],
  greek: [
    // BUG-6 FIX-4: added Greek-exclusive dishes (avgolemono,
    // pastitsio, loukoumades, etc.) so greek wins over middleeastern
    // when both could fire. Removed 'hummus greek' / 'kebab greek'
    // suffix forms (kept proper greek 'souvlaki' instead).
    // BUG-E: added more greek-exclusive variants ('moussaka greek',
    // 'lamb chops greek style', 'greek salad with feta', 'retsina
    // wine', 'whole fish greek style') at the top of the list.
    // Note: 'hummus', 'kebab', 'pita' are NOT in this list - they
    // belong to middleeastern only. 'pita greek' (suffixed form)
    // remains here as it's an unambiguous greek phrase.
    'spanakopita', 'avgolemono', 'pastitsio',
    'loukoumades', 'horiatiki',
    'moussaka greek', 'lamb chops greek style',
    'greek salad with feta',
    'ouzo', 'retsina wine',
    'whole fish greek style',
    'souvlaki', 'moussaka', 'saganaki',
    'greek salad', 'lemon potatoes greek',
    'lamb chops greek', 'whole fish greek',
    'retsina', 'greek yogurt dish',
    'gyro', 'tzatziki', 'baklava',
    'dolma', 'pita greek', 'feta',
  ],
  middleeastern: [
    // BUG-6 FIX-9: added exclusive Levantine/Persian dishes that
    // greek/mediterranean places never use, so middleeastern wins
    // unambiguously when these terms appear in reviews.
    'shakshuka', 'mansaf', 'maqluba',
    'knafeh', 'musakhan', 'fatayer',
    'kibbeh nayyeh', 'labneh', 'freekeh',
    'sumac chicken', 'persian rice',
    'ghormeh sabzi', 'fesenjan',
    'mujaddara', 'ful medames',
    'shawarma', 'falafel', 'hummus',
    'kebab', 'baklava', 'fattoush',
    'halal meat', 'lamb kebab',
    'mezze', 'tabouleh', 'baba ganoush',
    'za atar', 'pita',
  ],
  seafood: [
    'lobster', 'crab', 'shrimp', 'oyster',
    'clam chowder', 'salmon dish', 'tuna steak',
    'scallop', 'fish and chips', 'ceviche',
    'calamari', 'crawfish', 'mussels',
    'cioppino', 'bouillabaisse seafood',
  ],
  bbq: [
    'brisket', 'pulled pork', 'bbq ribs',
    'smoked meat', 'pitmaster', 'burnt ends',
    'barbeque sauce', 'smokehouse',
    'bbq chicken', 'smoked sausage',
    'pork ribs', 'beef ribs',
  ],
  steak: [
    // BUG-4 fix: added 'steak', 'steakhouse', 't-bone', etc.
    // Peter Luger / Fogo de Chao were falling through to fallback
    // because reviews never used the prior narrow vocabulary.
    'steak', 'steakhouse', 't-bone',
    'strip steak', 'medium rare', 'bone in',
    'aged beef', 'chops', 'beef tenderloin',
    'ribeye', 'filet mignon', 'new york strip',
    'porterhouse', 'prime rib', 'dry aged',
    'wagyu steak', 'au jus', 'steak dinner',
    'surf and turf', 'bone in steak',
  ],
  pizza: [
    // BUG-6 FIX-1: added bare 'pizza', 'pizzeria', 'pie', 'mozzarella',
    // 'pepperoni', 'margherita' etc. The prior list was all
    // multi-word phrases that rarely appear verbatim - pizza
    // category was 0/5 because no review contained "wood fired pizza"
    // exactly. 'pizza' was removed from italian (BUG-3) so safe to
    // own here exclusively.
    'pizza', 'pizzeria', 'pie',
    'calzone', 'stromboli',
    'wood fired', 'thin crust', 'deep dish',
    'neapolitan', 'detroit style', 'new york slice',
    'mozzarella', 'pepperoni', 'margherita',
    'neapolitan pizza', 'chicago style pizza',
    'wood fired pizza', 'detroit pizza',
    'thin crust pizza',
    'pizza slice', 'pizza dough', 'mozzarella pizza',
  ],
  burger: [
    // BUG-C: removed bare 'burger', 'hamburger', 'patty', 'smash',
    // 'griddle', 'special sauce', 'brioche bun', 'double patty'.
    // Italian and seafood restaurants have menu items that mention
    // "burger" or "patty" once and were misrouting (Rosewood Moto,
    // Bestia). Now requires multiple SPECIFIC burger phrases so a
    // review needs to talk about burgers as the main thing.
    'cheeseburger', 'beef patty',
    'smash burger', 'double burger',
    'brioche bun burger',
    'patty melt', 'burger and fries',
    'wagyu burger', 'plant based burger',
    'animal style', 'double double',
    'burger joint', 'special sauce burger',
  ],
  breakfast: [
    // BUG-D: removed 'french toast' (literally French; was causing
    // Republique and other French bakeries to score breakfast
    // higher than french). Moved into the french keyword list.
    'pancake', 'waffle', 'eggs benedict',
    'omelette', 'brunch menu',
    'mimosa brunch', 'hash brown',
    'avocado toast', 'acai bowl breakfast',
    'breakfast burrito', 'benedicts',
  ],
  vegan: [
    'plant based', 'plant-based menu',
    'beyond burger', 'impossible burger',
    'vegan cheese', 'oat milk latte',
    'vegan dessert', 'dairy free menu',
    'fully vegan', '100% vegan',
  ],
  caribbean: [
    'jerk chicken', 'jerk pork', 'plantain',
    'rice and peas', 'oxtail', 'curry goat',
    'roti caribbean', 'doubles', 'callaloo',
    'ackee', 'saltfish', 'festival bread',
  ],
  ethiopian: [
    'injera', 'tibs', 'wat stew',
    'doro wat', 'kitfo', 'gomen',
    'tej honey wine', 'berbere spice',
    'ethiopian platter', 'communal eating',
  ],
  spanish: [
    'tapas', 'paella', 'churros spanish',
    'gazpacho', 'tortilla espanola',
    'patatas bravas', 'jamón', 'croquetas',
    'sangria', 'gambas al ajillo',
  ],
  peruvian: [
    'ceviche peruvian', 'lomo saltado',
    'aji amarillo', 'causa', 'tiradito',
    'pisco sour', 'anticuchos',
    'peruvian chicken', 'chicha morada',
  ],
};

const CUISINE_QUERIES = {
  indian:        'indian restaurant',
  chinese:       'chinese restaurant',
  japanese:      'japanese restaurant sushi',
  korean:        'korean restaurant',
  thai:          'thai restaurant',
  vietnamese:    'vietnamese restaurant pho',
  mexican:       'mexican restaurant',
  italian:       'italian restaurant pizza',
  french:        'french restaurant bistro',
  greek:         'greek restaurant',
  middleeastern: 'middle eastern restaurant',
  seafood:       'seafood restaurant',
  bbq:           'BBQ barbecue smokehouse',
  steak:         'steakhouse steak restaurant',
  pizza:         'pizza restaurant',
  burger:        'burger restaurant',
  breakfast:     'breakfast brunch cafe',
  vegan:         'vegan vegetarian restaurant',
  caribbean:     'caribbean restaurant',
  ethiopian:     'ethiopian restaurant',
  spanish:       'spanish tapas restaurant',
  peruvian:      'peruvian restaurant',
};

// Layer 3 - unambiguous single phrases that confirm cuisine even
// when Layer 2's score threshold (≥2 unique matches) isn't reached.
const STRONG_SINGLE_KEYWORDS = {
  'biryani':         'indian restaurant',
  'naan bread':      'indian restaurant',
  'tikka masala':    'indian restaurant',
  'butter chicken':  'indian restaurant',
  'pad thai':        'thai restaurant',
  'tom yum':         'thai restaurant',
  'pho soup':        'vietnamese restaurant',
  'banh mi':         'vietnamese restaurant',
  'ramen bowl':      'japanese restaurant ramen',
  'sushi roll':      'japanese restaurant sushi',
  'dim sum':         'chinese restaurant',
  'peking duck':     'chinese restaurant',
  'kimchi':          'korean restaurant',
  'bibimbap':        'korean restaurant',
  'kbbq':            'korean restaurant',
  'gyro wrap':       'greek restaurant',
  'shawarma':        'middle eastern restaurant',
  'falafel wrap':    'middle eastern restaurant',
  'brisket smoked':  'BBQ barbecue restaurant',
  'pulled pork bbq': 'BBQ barbecue restaurant',
  'injera':          'ethiopian restaurant',
  'jerk chicken':    'caribbean restaurant',
  'ceviche lime':    'peruvian restaurant',
  'lomo saltado':    'peruvian restaurant',
  'paella':          'spanish tapas restaurant',
  'churros spanish': 'spanish tapas restaurant',
};

const NAME_CUISINE_SIGNALS = {
  indian: [
    'india', 'indian', 'bombay', 'mumbai',
    'delhi', 'punjab', 'bengal', 'madras',
    'taj mahal', 'maharaja', 'curry house',
    'masala', 'tandoor', 'spice of india',
    'himalaya', 'ganga', 'namaste', 'karma',
    'krishna', 'ganesh', 'rajput', 'mughal',
    'lucknow', 'kolkata', 'chennai', 'jaipur',
  ],
  chinese: [
    // BUG-6 FIX-8: added famous-restaurant tokens (Din Tai Fung,
    // Hakkasan, etc.) and broader Chinese dialect/region tokens.
    'din tai fung', 'hakkasan', 'duck house',
    'china live', 'joe shanghai', 'tang',
    'dim sum', 'dumpling', 'noodle house',
    'chinese kitchen', 'sichuan', 'cantonese',
    'beijing kitchen', 'hong kong',
    'china', 'chinese', 'panda', 'dragon',
    'golden wok', 'jade palace', 'wok',
    'peking', 'beijing', 'shanghai',
    'canton', 'szechuan', 'hunan',
    'mandarin', 'bamboo garden', 'orient',
    'lucky dragon', 'great wall', 'ming',
  ],
  japanese: [
    // BUG-5 fix: added 'noodle bar', 'ramen bar', 'izakaya',
    // 'omakase', 'momofuku' to catch concept restaurants whose
    // name doesn't include a generic "japanese" / "tokyo" token.
    // BUG-6 FIX-5: removed 'hana' (too short - caught Bohanan's
    // steakhouse, Havana, Indiana etc.). Added 'matsuhisa'.
    'japan', 'japanese', 'tokyo', 'osaka',
    'kyoto', 'sakura', 'fuji', 'zen garden',
    'ninja', 'samurai', 'miyabi', 'nobu',
    'morimoto', 'matsuri', 'yoshi',
    'noodle bar', 'ramen bar', 'izakaya',
    'omakase', 'momofuku', 'matsuhisa',
  ],
  korean: [
    // BUG-6 FIX-6: added Korean dish names - many US Korean
    // restaurants are named after specific dishes (jjimdak,
    // bossam, etc.) rather than carrying "Korean" in the name.
    'jjimdak', 'samgyupsal', 'galbi tang',
    'sundubu', 'naengmyeon', 'dakgalbi',
    'jokbal', 'bossam', 'hanjeongsik',
    'pojangmacha', 'gopchang', 'gamjatang',
    'doenjang jjigae', 'kimchi jjigae',
    'korea', 'korean', 'seoul', 'busan',
    'gangnam', 'han river', 'kimchi house',
    'kbbq', 'korean bbq', 'k-bbq',
  ],
  thai: [
    'thai', 'thailand', 'bangkok', 'siam',
    'golden elephant', 'orchid thai',
    'mango thai', 'chiang mai', 'lotus thai',
  ],
  vietnamese: [
    'viet', 'vietnam', 'saigon', 'hanoi',
    'pho', 'mekong', 'hoi an', 'da nang',
    'banh mi', 'bun bo hue',
  ],
  mexican: [
    // BUG-6 FIX-5: removed 'taqueria' (caught Korean fusion places).
    // BUG-A: removed 'el ', 'la ', 'los ' - too generic, caught
    // La Madia (italian), La Mer (french), El Gran (anything),
    // Los Gatos (city). Replaced with explicit Spanish-Spanish
    // phrases that are unambiguously mexican-restaurant.
    'mexico', 'mexican', 'jalisco', 'oaxaca',
    'cancun', 'aztec',
    'casa ', 'hacienda', 'rancho',
    'cantina', 'fiesta', 'salsa',
    'chipotle', 'puebla', 'guadalajara',
    'acapulco', 'veracruz', 'dos amigos',
    'taqueria mexicana', 'cocina mexicana',
  ],
  italian: [
    // BUG-6 FIX-2: removed 'pizza' (and implicit 'pizzeria',
    // 'pizza kitchen' which were never here). Pizzerias like Una
    // Pizza Napoletana were getting the italian query because
    // 'pizza' in name fired the italian name-signal layer before
    // pizza had its own name-signal entry.
    'italia', 'italian', 'trattoria',
    'ristorante', 'osteria', 'bella',
    'roma', 'napoli', 'venezia', 'milano',
    'tuscany', 'luigi', 'mario', 'antonio',
    'fratelli', 'nino', 'carmine', 'angelo',
  ],
  french: [
    // BUG-5 fix: removed 'bistro' (matched American "bistros"),
    // 'le ' (matched non-French names), and 'la maison' (rare and
    // overlapping with mexican 'la ').
    // BUG-6 FIX-3: added French chef names (boulud, bouchon,
    // bernardin, bisou) and French region names (toulouse, lyon,
    // provence, etc.) so chef-named restaurants get caught
    // without re-introducing the false positives from 'le '.
    'toulouse', 'lyon', 'provence', 'normandie',
    'bordeaux', 'alsace',
    'boulud', 'bouchon', 'bernardin', 'bisou',
    'laduree', 'maison', 'jardin', 'vue sur',
    'chez ', 'auberge', 'fleur de', 'crepe',
    'france', 'french', 'paris',
    'brasserie', 'cafe de', 'patisserie',
    'petit four',
    'chateau', 'boulangerie', 'crepes',
  ],
  greek: [
    // BUG-6 FIX-4: added taverna/estiatorio (the proper greek
    // restaurant categories) plus Greek place names (Crete, Sparta,
    // Corfu, Rhodes, Milos) and Estiatorio Milos / Avra etc.
    'estiatorio', 'taverna', 'hellas',
    'athena', 'crete', 'sparta', 'corfu',
    'rhodes', 'milos', 'opa ',
    'greek kitchen', 'mediterranean grill',
    'greek', 'greece', 'athens', 'acropolis',
    'zeus', 'olympia', 'santorini',
    'zorba', 'mykonos', 'parthenon',
    'agora', 'symposium', 'dionysus',
  ],
  middleeastern: [
    // BUG-6 FIX-9: added famous restaurant tokens (Bavel, Shaya,
    // Zahav, Tawla, Cava, Zaytinya, Oleana) and Levantine /
    // Persian / regional cuisines.
    'levant', 'levantine', 'shuk', 'souk',
    'bavel', 'shaya', 'zahav', 'tawla',
    'cava', 'zaytinya', 'oleana',
    'ottoman', 'persian', 'arabian',
    'yemeni', 'moroccan', 'tunisian',
    'israeli', 'jewish deli',
    'halal', 'lebanese', 'arabic',
    'arab', 'istanbul', 'turkey', 'turkish',
    'shawarma', 'falafel', 'beirut',
    'damascus', 'aladdin', 'kabob',
    'kebab', 'pita palace', 'mediterranean',
  ],
  caribbean: [
    // BUG-6 FIX-5: removed 'island' (caught Island Creek Oysters,
    // many Pacific/island-themed bars and gyms). Also dropped
    // 'tropical' (catches tropical fitness, smoothie shops). Kept
    // 'jerk' which is unambiguous; added 'roti shop' for clarity.
    'caribbean', 'jamaica', 'jamaican',
    'trinidad', 'haiti', 'cuban', 'cuba',
    'jerk', 'reggae', 'calypso', 'bahamas',
    'west indian', 'roti shop',
  ],
  ethiopian: [
    'ethiopia', 'ethiopian', 'eritrea',
    'habesha', 'addis ababa', 'african',
    'injera house', 'abyssinia',
  ],
  bbq: [
    // BUG-B: added 'bar-b-que', 'bar-b-q', 'b.b.q', 'bar b que'
    // and 'hometown bbq' so Hometown Bar-B-Que and similar
    // hyphenated/space-separated spellings catch via name signal.
    'bbq', 'barbeque', 'barbecue',
    'bar-b-que', 'bar-b-q', 'b.b.q',
    'bar b que', 'hometown bbq',
    'smokehouse', 'pitmaster', 'smoke shack',
    'pit stop', 'smoke ring', 'brisket house',
  ],
  seafood: [
    'seafood', 'fish house', 'lobster',
    'crab shack', 'oyster bar', 'catch',
    'captain', 'harbor', 'pier', 'wharf',
    'bay seafood', 'shore', 'neptune',
  ],
  steak: [
    // BUG-4 fix: added broader signals so Bern's Steak House,
    // Texas Roadhouse, etc. are caught even before review scoring.
    'steakhouse', 'steak house', 'chophouse',
    'chop house', 'prime beef', 'prime',
    'grille', 'bovine', 'longhorn', 'roadhouse',
    'ranch steakhouse', 'the grill prime',
  ],
  // BUG-6 FIX-1: pizza name signals. Owns 'pizza' / 'pizzeria'
  // exclusively (removed from italian) plus famous pizzeria
  // names (Lucali, Motorino, Bianco, Lou Malnati, Giordano).
  pizza: [
    'pizza', 'pizzeria', 'pie shop',
    'pizza co', 'pizza kitchen', 'pizza house',
    'pizza bar', 'pizza lab', 'coal fired',
    'wood fired pizza', 'neapolitan',
    'lucali', 'motorino', 'bianco',
    'malnati', 'giordano', 'uno pizzeria',
    'pizzaiolo',
  ],
  // BUG-6 FIX-7: burger name signals - bare 'burger' / 'burgers'
  // plus famous burger joints by name (J.G. Melon, Apple Pan,
  // Hodad's) and burger chains (Five Guys, In-N-Out, etc.).
  burger: [
    'burger', 'burgers', 'hamburger',
    'smash burger', 'burger joint', 'burger bar',
    'burger shack', 'burger house', 'the burger',
    'melon', 'hodad', 'apple pan',
    'shake shack', 'five guys', 'in-n-out',
    'whataburger', 'fatburger', 'habit burger',
    'umami burger',
  ],
};

// Layer 5 - chains we KNOW the right competitor category for. Maps a
// chain-name fragment to a query that surfaces the chain's actual
// peers (e.g. Pizza Hut → Domino's / Papa John's, NOT artisan pizza).
const CHAIN_CATEGORY_QUERIES = {
  'pizza hut':          'pizza delivery chain dominos papa johns',
  'domino':             'pizza delivery chain',
  'papa john':          'pizza delivery chain',
  'little caesar':      'pizza value chain',
  'chipotle':           'fast casual mexican qdoba moe',
  'qdoba':              'fast casual mexican chipotle',
  'mcdonald':           'fast food burger chain',
  'burger king':        'fast food burger chain',
  'wendy':              'fast food burger chain',
  'five guys':          'fast casual burger chain',
  'shake shack':        'fast casual burger chain',
  'in-n-out':           'fast food burger chain',
  'whataburger':        'fast food burger chain',
  'subway':             'fast casual sandwich chain',
  'jersey mike':        'fast casual sandwich chain',
  'jimmy john':         'fast casual sandwich chain',
  'taco bell':          'fast food mexican chain',
  'del taco':           'fast food mexican chain',
  'kfc':                'fast food chicken chain',
  'popeyes':            'fast food chicken chain',
  'chick-fil':          'fast food chicken chain',
  'raising cane':       'fast food chicken chain',
  'wingstop':           'fast food chicken wings chain',
  'zaxby':              'fast food chicken chain',
  'bojangle':           'fast food chicken chain',
  'panda express':      'fast casual chinese chain',
  'starbucks':          'coffee chain cafe',
  'dunkin':             'coffee donut chain',
  'tim horton':         'coffee donut chain',
  'panera':             'fast casual bakery cafe chain',
  'jason deli':         'fast casual deli sandwich chain',
  'firehouse':          'fast casual sandwich chain',
  'sonic':              'fast food drive-in chain',
  'dairy queen':        'fast food ice cream chain',
  'culver':             'fast casual burger chain',
  'cookout':            'fast food burger chain',
  'hardee':             'fast food burger chain',
  'carl jr':            'fast food burger chain',
  'jack in the box':    'fast food burger chain',
  'checkers':           'fast food burger chain',
  'rally':              'fast food burger chain',
  'el pollo':           'fast casual mexican chicken',
  'habit burger':       'fast casual burger chain',
  'olive garden':       'casual italian dining chain',
  'applebee':           'casual american bar grill chain',
  'chili':              'casual american bar grill chain',
  'outback':            'casual steakhouse chain',
  'texas roadhouse':    'casual steakhouse chain',
  'longhorn':           'casual steakhouse chain',
  'red lobster':        'casual seafood chain',
  'ihop':               'breakfast diner chain',
  'denny':              'breakfast diner chain',
  'cracker barrel':     'country breakfast diner chain',
  'waffle house':       'breakfast diner chain',
  'buffalo wild wings': 'sports bar wings chain',
  'hooters':            'casual sports bar chain',
};

// Layer 5 - generic chain detection for chains NOT in
// CHAIN_CATEGORY_QUERIES. When a name fragment matches here but
// not above, we use the chain name itself (cleaned, first 3 words)
// as the query.
const FAST_FOOD_CHAINS = [
  'mcdonald', 'burger king', 'wendy',
  'taco bell', 'kfc', 'popeyes',
  'chick-fil', 'subway', 'quiznos',
  'jersey mike', 'jimmy john',
  'chipotle', 'qdoba', 'moe',
  'panda express', 'wingstop',
  'raising cane', 'sonic', 'dairy queen',
  'five guys', 'shake shack',
  'in-n-out', 'whataburger', 'hardee',
  'carl jr', 'jack in the box',
  'domino', 'papa john', 'little caesar',
  'dunkin', 'starbucks', 'tim horton',
  'panera', 'jason deli', 'firehouse',
  'cookout', 'culver', 'del taco',
  'el pollo', 'habit burger',
  'checkers', 'rally', 'zaxby',
  'bojangle', 'church chicken',
];

// ─────────────────────────────────────────────────────────────────────
// Layer 1.5 - Claude + web search cuisine micro-call
// ─────────────────────────────────────────────────────────────────────
// Single-shot call to claude-haiku-4-5 with the `web_search_20250305`
// server-side tool enabled. Asks Claude to pick ONE cuisine label from
// a fixed enum; if Claude isn't confident from name + types + reviews,
// it autonomously searches the web (Google Maps listings, restaurant
// websites, food blogs) and returns the right answer.
//
// Used inside buildCompetitorQuery between Layer 1 (Google types) and
// Layer 2 (name signals) to catch chef-driven (Daniel, Jean-Georges,
// Boulud), foreign-language-named (Babbo, Marea, Cosme, Atomix), and
// concept restaurants (Fish Cheeks, Crying Tiger, Au Cheval) whose
// cuisine is invisible to the deterministic name-signal / review-
// keyword layers.
//
// MODEL ID: spec wrote `claude-haiku-4-5-20251001`. The canonical
// Anthropic string is `claude-haiku-4-5` (no date suffix); date-suffixed
// variants are training-data artifacts that reliably 400. Using canonical.
//
// HTTP layer: raw `fetch()` per spec (matches the request shape exactly,
// no SDK abstraction). Web-search tool is a beta server-side tool; the
// API runs the search and returns the synthesized answer in the final
// `text` content block.
//
// Cost: ~$0.003 per non-cached call (haiku-4-5 with web search). Cache
// is process-lifetime (no TTL - cuisine type doesn't change), keyed by
// `name|city|state` per spec. Note: `queryWithLocality` and
// `queryNoLocality` inside fetchNearbyCompetitors pass different city/
// state (the latter passes null), so they will trigger TWO calls per
// new business; switch the cache key to name-only if cost matters.
// Process-lifetime cache (no TTL - cuisine type doesn't change). Bounded
// at max=1000 so memory stays flat under sustained traffic.
const CUISINE_CACHE = new LRUCache({ max: 1000 });
// Same shape, used by detectCompetitorQueryWithClaude (the safety-net
// fallback fired mid-ladder when the deterministic search has produced
// <5 competitors after the 50-mile rung). Process-lifetime, keyed by
// `name|city|state` so repeat analyses of the same business are free.
const COMPETITOR_CLAUDE_CACHE = new LRUCache({ max: 500 });
const VALID_CUISINES = new Set([
  'indian', 'chinese', 'japanese', 'korean', 'thai', 'vietnamese',
  'mexican', 'italian', 'french', 'greek', 'middleeastern', 'seafood',
  'bbq', 'steak', 'pizza', 'burger', 'breakfast', 'vegan',
  'caribbean', 'ethiopian', 'american', 'unknown',
]);

async function detectCuisineWithClaude(businessName, city, state, googleTypes, reviewTexts) {
  try {
    const cacheKey = String(businessName || '').toLowerCase()
      + '|' + (city || '')
      + '|' + (state || '');

    if (CUISINE_CACHE.has(cacheKey)) {
      const cached = CUISINE_CACHE.get(cacheKey);
      if (cached) {
        console.log(`[cuisine-cache] hit for ${businessName} → ${cached}`);
      }
      return cached;
    }

    // Skip the call entirely if the API key isn't configured. Returning
    // null lets buildCompetitorQuery fall through to Layer 2 cleanly.
    if (!process.env.ANTHROPIC_API_KEY) return null;

    const types = Array.isArray(googleTypes) ? googleTypes : [];
    const reviews = Array.isArray(reviewTexts) ? reviewTexts.slice(0, 3) : [];

    const prompt =
      'What cuisine type is this restaurant?\n\n' +
      'Restaurant: ' + businessName + '\n' +
      'Location: ' + (city || '') + ', ' + (state || '') + '\n' +
      'Google types: ' + types.join(', ') + '\n' +
      'Sample reviews: ' + reviews.join(' | ') + '\n\n' +
      'If you are not sure search the web for the restaurant ' +
      'name and location.\n\n' +
      'Reply with EXACTLY ONE word:\n' +
      'indian chinese japanese korean thai vietnamese mexican italian ' +
      'french greek middleeastern seafood bbq steak pizza burger ' +
      'breakfast vegan caribbean ethiopian american unknown\n\n' +
      'ONE WORD ONLY. No explanation.';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
          },
        ],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    // With web_search enabled the response.content array can contain
    // tool_use / web_search_tool_result blocks BEFORE the final text
    // block carrying Claude's synthesized answer. Take the LAST text
    // block to skip past any intermediate reasoning.
    const textBlock = data && Array.isArray(data.content)
      ? data.content.filter((b) => b && b.type === 'text').pop()
      : null;

    const cuisine = (textBlock && typeof textBlock.text === 'string'
      ? textBlock.text
      : ''
    )
      .toLowerCase()
      .trim()
      .replace(/[^a-z]/g, '')
      .split('\n')[0]
      .split(' ')[0];

    if (VALID_CUISINES.has(cuisine) && cuisine !== 'unknown') {
      console.log(
        `[competitor-query] ${businessName} → layer:1.5 (claude+web) cuisine:${cuisine}`
      );
      CUISINE_CACHE.set(cacheKey, cuisine);
      return cuisine;
    }

    console.log(
      `[competitor-query] ${businessName} → layer:1.5 claude returned: "${cuisine}" (not valid - skipping)`
    );
    CUISINE_CACHE.set(cacheKey, null);
    return null;
  } catch (e) {
    console.log(`[competitor-query] claude+web failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// detectCompetitorQueryWithClaude - Claude+websearch safety-net fallback
// ─────────────────────────────────────────────────────────────────────
// Fires from fetchNearbyCompetitors MID-LADDER, right after the 50-mile
// rung (RADIUS_LADDER index 5) when the pool still has <5 competitors.
// Asks claude-haiku-4-5 (with web_search_20250305 enabled, max_uses: 5)
// to identify the business type and return 5 Google-Places-compatible
// SHORT CATEGORY search terms for finding real competitors. The caller
// then runs each term as a fresh Text Search at 50 miles and merges
// hits into the existing pool via tryAdd.
//
// Firing earlier (after rung 5 instead of after rung 7) means a
// pathological-query business - like Cricket Wireless whose name-based
// fallback returned 0 across 8 rungs in the prior architecture - gets
// proper category queries before paying for the 75-mile and 150-mile
// rungs. If Claude doesn't fill the pool, the ladder continues to
// rungs 6 and 7 as a last resort.
//
// Same architecture as detectCuisineWithClaude (line 1739):
//   - raw fetch() to api.anthropic.com (no SDK)
//   - process-lifetime LRU cache keyed by name|city|state
//   - returns null on any error or invalid response so the caller
//     gracefully falls back to the remaining ladder rungs
//
// Returns: { business_type, competitor_types, search_queries: [...] }
//   on success, or null on any error / validation failure.
async function detectCompetitorQueryWithClaude(businessName, city, state, naics6, apiKey) {
  void apiKey; // reserved for future use; Anthropic call uses ANTHROPIC_API_KEY env
  try {
    const cacheKey = 'competitor_claude_'
      + String(businessName || '').toLowerCase()
      + '|' + (city || '')
      + '|' + (state || '');

    if (COMPETITOR_CLAUDE_CACHE.has(cacheKey)) {
      const cached = COMPETITOR_CLAUDE_CACHE.get(cacheKey);
      if (cached) {
        console.log(`[competitor-claude] cache hit for ${businessName}`);
      }
      return cached;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('[competitor-claude] skipped: ANTHROPIC_API_KEY not set');
      return null;
    }

    const systemPrompt =
      'You are a business research assistant.\n'
      + 'Use web search to identify what type\n'
      + 'of business this is and who its direct\n'
      + 'local competitors are.\n\n'
      + 'Return ONLY valid JSON with Google\n'
      + 'Places compatible search terms.\n'
      + 'Search terms must be SHORT BUSINESS\n'
      + 'CATEGORY NAMES like \'cell phone store\'\n'
      + 'or \'dental office\'.\n'
      + 'Never use consumer shopping phrases.';

    const subjectLabel = businessName || 'this business';
    const userPrompt =
      'Business name: ' + (businessName || '(unknown)') + '\n'
      + 'Location: ' + (city || '(unknown)') + ', ' + (state || '(unknown)') + '\n'
      + 'NAICS code: ' + (naics6 || '(unknown)') + '\n\n'
      + 'Use web search to find out\n'
      + 'exactly what this business sells\n'
      + 'and who its DIRECT competitors are.\n\n'
      + 'A direct competitor is a business\n'
      + 'where a customer would choose\n'
      + 'BETWEEN this business AND that\n'
      + 'competitor for the SAME product\n'
      + 'or service.\n\n'
      + 'Example:\n'
      + '  Cricket Wireless sells phone plans\n'
      + '  Direct competitors = T-Mobile,\n'
      + '  AT&T, Boost Mobile, MetroPCS\n\n'
      + '  NOT competitors = UPS Store,\n'
      + '  FedEx, shipping stores, banks,\n'
      + '  grocery stores, restaurants\n\n'
      + 'Return ONLY this JSON:\n'
      + '{\n'
      + '  "business_type": "exactly what this business sells in one line",\n'
      + '  "competitor_types": "exactly what type of store a customer would visit INSTEAD of this business",\n'
      + '  "search_queries": [\n'
      + '    "term 1",\n'
      + '    "term 2",\n'
      + '    "term 3",\n'
      + '    "term 4",\n'
      + '    "term 5"\n'
      + '  ]\n'
      + '}\n\n'
      + 'RULES for search_queries:\n'
      + 'Each term must find a store that\n'
      + 'sells the SAME thing as ' + subjectLabel + '.\n\n'
      + 'Good examples for Cricket Wireless:\n'
      + '  \'T-Mobile store\' ✅\n'
      + '  \'AT&T wireless store\' ✅\n'
      + '  \'Boost Mobile store\' ✅\n'
      + '  \'prepaid wireless store\' ✅\n'
      + '  \'Metro by T-Mobile\' ✅\n\n'
      + 'Bad examples for Cricket Wireless:\n'
      + '  \'store\' ❌ too generic\n'
      + '  \'phone store\' ❌ too broad\n'
      + '  \'electronics store\' ❌ too broad\n'
      + '  \'UPS Store\' ❌ wrong business\n'
      + '  \'shipping store\' ❌ wrong business\n'
      + '  \'cheap plans\' ❌ not a store type\n'
      + '  \'near me\' ❌ not a store type\n\n'
      + 'Each term must be:\n'
      + '  SPECIFIC to the exact business type\n'
      + '  2-5 words only\n'
      + '  A real Google Places category\n'
      + '    OR a real business chain name\n'
      + '  Something that would ONLY find\n'
      + '    businesses that sell the same\n'
      + '    thing as ' + subjectLabel + '\n\n'
      + 'Use web search to verify your\n'
      + 'answer is correct before returning.\n'
      + 'Return exactly 5 search queries.';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system: systemPrompt,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();

    // With web_search enabled, content[] interleaves tool_use /
    // web_search_tool_result blocks with intermediate text. Take the
    // LAST text block - that's Claude's synthesized JSON answer.
    const textBlock = data && Array.isArray(data.content)
      ? data.content.filter((b) => b && b.type === 'text').pop()
      : null;
    const rawText = (textBlock && typeof textBlock.text === 'string')
      ? textBlock.text
      : '';

    // Extract the first { ... } JSON object from the response text.
    // Tolerates markdown code fences or prose wrapping.
    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
      console.log(`[competitor-claude] failed to parse response for ${businessName} (no JSON object found)`);
      COMPETITOR_CLAUDE_CACHE.set(cacheKey, null);
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
    } catch (parseErr) {
      console.log(`[competitor-claude] failed to parse response for ${businessName} (${parseErr.message})`);
      COMPETITOR_CLAUDE_CACHE.set(cacheKey, null);
      return null;
    }

    // Validate shape.
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.search_queries)) {
      console.log(`[competitor-claude] failed to parse response for ${businessName} (missing search_queries array)`);
      COMPETITOR_CLAUDE_CACHE.set(cacheKey, null);
      return null;
    }

    // Validate at least 3 items, all strings.
    const cleaned = parsed.search_queries
      .filter((q) => typeof q === 'string' && q.trim().length > 0)
      .map((q) => q.trim());
    if (cleaned.length < 3) {
      console.log(`[competitor-claude] failed to parse response for ${businessName} (only ${cleaned.length} valid queries, need >=3)`);
      COMPETITOR_CLAUDE_CACHE.set(cacheKey, null);
      return null;
    }

    // Validate none contain businessName - Claude was told not to leak
    // the subject's name into search terms. If it did, reject the whole
    // response rather than risk a self-match polluting the pool.
    const nameLower = String(businessName || '').toLowerCase().trim();
    if (nameLower.length > 0) {
      const leak = cleaned.find((q) => q.toLowerCase().includes(nameLower));
      if (leak) {
        console.log(`[competitor-claude] failed to parse response for ${businessName} (query "${leak}" contains business name)`);
        COMPETITOR_CLAUDE_CACHE.set(cacheKey, null);
        return null;
      }
    }

    const result = {
      business_type: typeof parsed.business_type === 'string' ? parsed.business_type : null,
      competitor_types: typeof parsed.competitor_types === 'string' ? parsed.competitor_types : null,
      search_queries: cleaned,
    };

    console.log(
      `[competitor-claude] identified for ${businessName}: `
      + `type=${result.business_type} queries=${JSON.stringify(result.search_queries)}`
    );
    COMPETITOR_CLAUDE_CACHE.set(cacheKey, result);
    return result;
  } catch (e) {
    console.log(`[competitor-claude] claude+web failed: ${e.message}`);
    return null;
  }
}

async function buildCompetitorQuery(businessName, naics6, naics2, googleTypes, city, state, reviewTexts) {
  const locality = [city, state].filter(Boolean).join(' ');
  const suffix = locality ? ` near ${locality}` : '';
  const naics6Str = naics6 != null ? String(naics6) : '';

  // ─── MEAL PREP / MEAL KIT DETECTION (overrides the generic caterer query) ──
  // NAICS 722320 (Caterers) covers BOTH traditional event caterers (wedding
  // venues, banquet halls) and modern meal-prep / meal-kit subscriptions.
  // The default 'event venue caterer wedding venue' query finds traditional
  // caterers but is useless for a meal-prep subscription business. Detect
  // meal-prep intent from the business name and use a subscription-focused
  // query instead.
  if (naics6Str === '722320') {
    const nameLowerMP = String(businessName || '').toLowerCase();
    if (
      nameLowerMP.includes('meal prep') ||
      nameLowerMP.includes('meal kit') ||
      nameLowerMP.includes('meal plan') ||
      nameLowerMP.includes('prepared meals')
    ) {
      const q = 'meal prep service meal kit healthy food delivery subscription';
      console.log(`[competitor-query] ${businessName} → layer:meal_prep override category:"${q}"`);
      return q + suffix;
    }
  }

  // ─── RESORT DETECTION (overrides the generic hotel query) ─────────
  // NAICS 721110 covers both limited-service hotels and full-service
  // destination resorts. Names with "resort" or "lodge" signal the
  // higher-amenity model - use a resort-targeted query so the competitor
  // pool surfaces other resorts/destination lodges instead of generic
  // chain hotels.
  if (naics6Str === '721110') {
    const nameLowerRS = String(businessName || '').toLowerCase();
    if (nameLowerRS.includes('resort') || nameLowerRS.includes(' lodge')) {
      const q = 'resort lodge destination hotel waterpark conference center';
      console.log(`[competitor-query] ${businessName} → layer:resort override category:"${q}"`);
      return q + suffix;
    }
  }

  // ─── TATTOO / PIERCING DETECTION (overrides the generic 812199 spa
  // query) ───────────────────────────────────────────────────────────
  // NAICS 812199 (Other Personal Care Services) covers a broad mix of
  // day spas, med spas, float tanks, cryotherapy, eyelash/microblading,
  // AND tattoo parlors + body piercing studios. The default spa query
  // is useless for a tattoo shop - surface tattoo-specific competitors
  // when the name signals tattoo/piercing/body art.
  if (naics6Str === '812199') {
    const nameLowerTT = String(businessName || '').toLowerCase();
    if (
      nameLowerTT.includes('tattoo') ||
      nameLowerTT.includes('piercing') ||
      nameLowerTT.includes('ink') ||
      nameLowerTT.includes('body art')
    ) {
      const q = 'tattoo parlor tattoo studio body piercing ink shop body art';
      console.log(`[competitor-query] ${businessName} → layer:tattoo override category:"${q}"`);
      return q + suffix;
    }
  }

  // ─── RESTAURANTS - cuisine detection runs FIRST ────────────────────
  // Only NAICS 722xxx (food service). Hotels (721xxx) skip this entire
  // block and go through the generic NAICS_QUERIES path below. See
  // the gating note in the cuisine-constants comment header.
  const isFoodService = naics6Str.startsWith('722');
  if (isFoodService) {
    const types = Array.isArray(googleTypes) ? googleTypes : [];
    const allReviews = (Array.isArray(reviewTexts) ? reviewTexts : [])
      .join(' ').toLowerCase();
    const nameLower = String(businessName || '').toLowerCase();

    // ─── BUG-2 fix: pipeline reordered ─────────────────────────────
    // New order: chains → google types → name signals → review
    // scoring → strong keywords → fallback. The previous order put
    // review scoring before chain detection, so Pizza Hut / Olive
    // Garden / Chipotle / Panda Express never reached the chain map
    // (their reviews scored ≥2 on a cuisine keyword and Layer 2 won
    // first). Name signals also moved up so Bern's Steak House,
    // taqueria-named places, etc. catch before review noise.
    // Logged layers 0-5; old 1-6 numbering retired.

    // Layer 0 - Chain detection (most specific match wins outright).
    for (const chainKey of Object.keys(CHAIN_CATEGORY_QUERIES)) {
      if (nameLower.includes(chainKey)) {
        console.log(
          `[competitor-query] ${businessName} → layer:0 (chain "${chainKey}") category:"${CHAIN_CATEGORY_QUERIES[chainKey]}"`
        );
        return CHAIN_CATEGORY_QUERIES[chainKey] + suffix;
      }
    }
    const matchedFastChain = FAST_FOOD_CHAINS.find((c) => nameLower.includes(c));
    if (matchedFastChain) {
      const chainWords = String(businessName || '')
        .split(',')[0]
        .trim()
        .replace(/[^a-zA-Z\s]/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 3)
        .join(' ');
      console.log(
        `[competitor-query] ${businessName} → layer:0 (generic chain) query:"${chainWords}"`
      );
      return chainWords + suffix;
    }

    // Layer 1 - Google's own cuisine type tag (most reliable for the
    // types still in GOOGLE_CUISINE_TYPES after BUG-1 cleanup).
    for (const gType of types) {
      if (GOOGLE_CUISINE_TYPES[gType]) {
        console.log(
          `[competitor-query] ${businessName} → layer:1 (google types) cuisine:${gType}`
        );
        return GOOGLE_CUISINE_TYPES[gType] + suffix;
      }
    }

    // ── NEW Layer 1.5 - Claude micro-call (cheap, cached) ────────────
    // Catches chef-driven, foreign-language-named, and concept restaurants
    // that the deterministic layers miss (Babbo, Daniel, Atomix, Cosme,
    // Au Cheval, Fish Cheeks, Crying Tiger, Jean-Georges, etc.). One
    // Haiku-4.5 call, ~$0.0001 per restaurant, ~0.5s; result cached
    // process-lifetime so repeated calls are free.
    const claudeCuisine = await detectCuisineWithClaude(
      businessName, city, state, types, reviewTexts
    );
    if (claudeCuisine) {
      return (CUISINE_QUERIES[claudeCuisine] || `${claudeCuisine} restaurant`) + suffix;
    }

    // Layer 2 - business-name cultural / cuisine signals (moved up
    // from old Layer 4 so name-obvious cuisine isn't drowned out by
    // review keyword noise).
    for (const [cuisine, signals] of Object.entries(NAME_CUISINE_SIGNALS)) {
      if (signals.some((s) => nameLower.includes(s))) {
        console.log(
          `[competitor-query] ${businessName} → layer:2 (name signal) cuisine:${cuisine}`
        );
        return (CUISINE_QUERIES[cuisine] || `${cuisine} restaurant`) + suffix;
      }
    }

    // Layer 3 - review keyword scoring with name multiplier (was
    // Layer 2; moved down so name signals get first shot).
    // Count matches per cuisine; the cuisine with the most matches
    // wins (handles fusion restaurants - chicken-tikka-burger should
    // score higher on indian than burger). Cuisines whose signal also
    // appears in the business name get a 3× multiplier.
    const cuisineScores = {};
    for (const [cuisine, keywords] of Object.entries(CUISINE_FOOD_KEYWORDS)) {
      const matchCount = keywords.filter((kw) => allReviews.includes(kw.toLowerCase())).length;
      if (matchCount > 0) cuisineScores[cuisine] = matchCount;
    }
    const nameSignalCuisines = [];
    for (const [cuisine, signals] of Object.entries(NAME_CUISINE_SIGNALS)) {
      if (signals.some((s) => nameLower.includes(s))) {
        nameSignalCuisines.push(cuisine);
      }
    }
    for (const cuisine of nameSignalCuisines) {
      // BUG-F: name multiplier raised 3x → 5x. When the business
      // name carries a cuisine signal, that cuisine should clearly
      // dominate over review-keyword noise (e.g. Hankook Taqueria
      // - name says korean but reviews mention 'taco' from their
      // fusion menu). 5x means a single name signal beats up to
      // 4 reviews-only matches of any other cuisine.
      cuisineScores[cuisine] = cuisineScores[cuisine] ? cuisineScores[cuisine] * 5 : 5;
    }
    const scoreEntries = Object.entries(cuisineScores);
    if (scoreEntries.length > 0) {
      scoreEntries.sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        // Tie-break 1: cuisine present in business name wins.
        const aInName = nameSignalCuisines.includes(a[0]);
        const bInName = nameSignalCuisines.includes(b[0]);
        if (aInName !== bInName) return aInName ? -1 : 1;
        // Tie-break 2: alphabetical for stability.
        return a[0].localeCompare(b[0]);
      });
      const [topCuisine, topScore] = scoreEntries[0];
      if (topScore >= 2) {
        console.log(
          `[competitor-query] ${businessName} → layer:3 (review keywords) cuisine:${topCuisine} score:${topScore}`
        );
        return (CUISINE_QUERIES[topCuisine] || `${topCuisine} restaurant`) + suffix;
      }
    }

    // Layer 4 - strong single keywords (one match suffices).
    for (const [kw, query] of Object.entries(STRONG_SINGLE_KEYWORDS)) {
      if (allReviews.includes(kw)) {
        console.log(
          `[competitor-query] ${businessName} → layer:4 (strong keyword "${kw}")`
        );
        return query + suffix;
      }
    }

    // Layer 5 - generic restaurant fallback.
    console.log(
      `[competitor-query] ${businessName} → layer:5 (fallback) no cuisine detected`
    );
    return 'restaurant dining' + suffix;
  }

  // ─── NON-RESTAURANTS - existing 5-priority logic, unchanged ────────

  // Priority 1 - exact NAICS-6 lookup
  if (naics6Str && NAICS_QUERIES[naics6Str]) {
    const q = NAICS_QUERIES[naics6Str] + suffix;
    console.log(`[competitors] search query: "${q}" (NAICS-6 exact ${naics6Str})`);
    return q;
  }

  // Priority 2 - NAICS-4 prefix scan
  if (naics6Str.length >= 4) {
    const naics4 = naics6Str.substring(0, 4);
    const naics4Match = Object.keys(NAICS_QUERIES).find((k) => k.startsWith(naics4));
    if (naics4Match) {
      const q = NAICS_QUERIES[naics4Match] + suffix;
      console.log(`[competitors] search query: "${q}" (NAICS-4 prefix ${naics4} → ${naics4Match})`);
      return q;
    }
  }

  // Priority 2b - NAICS-3 exact key lookup (e.g. '111', '312' entries)
  if (naics6Str.length >= 3) {
    const naics3 = naics6Str.substring(0, 3);
    if (NAICS_QUERIES[naics3]) {
      const q = NAICS_QUERIES[naics3] + suffix;
      console.log(`[competitors] search query: "${q}" (NAICS-3 ${naics3})`);
      return q;
    }
  }

  // Priority 2c - NAICS-2 exact key lookup
  if (naics6Str.length >= 2) {
    const naics2Key = naics6Str.substring(0, 2);
    if (NAICS_QUERIES[naics2Key]) {
      const q = NAICS_QUERIES[naics2Key] + suffix;
      console.log(`[competitors] search query: "${q}" (NAICS-2 ${naics2Key})`);
      return q;
    }
  }

  // Priority 3 - first non-generic Google type
  const types = Array.isArray(googleTypes) ? googleTypes : [];
  const specificType = types.find((t) => !COMPETITOR_QUERY_SKIP_TYPES.has(t));
  if (specificType) {
    const typeWords = String(specificType).replace(/_/g, ' ');
    return typeWords + suffix;
  }

  // Priority 4 - keyword extracted from business name
  const nameLower = String(businessName || '').toLowerCase();
  if (nameLower) {
    const found = COMPETITOR_NAME_KEYWORDS.find((k) => nameLower.includes(k));
    if (found) return found + suffix;
  }

  // Priority 5 - clean business name fallback
  const cleanName = String(businessName || '')
    .replace(/by wyndham|by hilton|by marriott|by ihg/gi, '')
    .replace(/\bLLC\b|\bInc\b|\bCorp\b|\bLtd\b/gi, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');
  return (cleanName || 'business') + suffix;
}

// ─────────────────────────────────────────────────────────────────────
// RADIUS_LADDER - replaces the prior getCompetitorRadius single-shot.
// ─────────────────────────────────────────────────────────────────────
// fetchNearbyCompetitors now climbs this ladder from smallest to largest,
// stopping as soon as the deduped pool reaches POOL_TARGET (5). The
// largest radius actually queried is returned as `search_radius_miles`
// so renderReport can pick the appropriate "limited competition" note.
//
// Step 4 (150 mi) reaches into nearby states - that wide a search only
// fires for businesses in genuinely empty rural categories (e.g. a
// rural-only specialty in northern WI may have 0 competitors within
// 75 mi but several across the MN border). When step 4 still returns
// 0, the renderer surfaces a "potential monopoly" callout.
const RADIUS_LADDER = [
  1609,    // Step 1 - 1 mile     (immediate block / strip mall)
  4828,    // Step 2 - 3 miles    (neighborhood)
  12875,   // Step 3 - 8 miles    (small-city core)
  24140,   // Step 4 - 15 miles   (greater small-town area)
  48280,   // Step 5 - 30 miles   (regional)
  80467,   // Step 6 - 50 miles   (multi-county)
  120700,  // Step 7 - 75 miles   (cross-region)
  241400,  // Step 8 - 150 miles  (nearby states; query drops locality)
];

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

// Distance-bucket comparator. Closer competitors always rank above
// farther ones regardless of rating, with rating + review_count used
// only as tiebreakers within the same distance band. Fixes the prior
// rating-only sort which buried Don Q Inn (0.16 mi, 4.2★) under
// Walker House (9.4 mi, 4.9★) for AmericInn Dodgeville.
//
// Buckets:
//   0 - under 2 miles  (immediate / walking competitors)
//   1 - under 5 miles  (same-town competitors)
//   2 - under 15 miles (greater-area competitors)
//   3 - beyond 15 miles
//   4 - distance unknown (Foursquare or geometry-less results)
function competitorComparator(a, b) {
  function bucket(d) {
    if (d == null) return 4;
    if (d < 3219)  return 0;  // under 2 miles
    if (d < 8047)  return 1;  // under 5 miles
    if (d < 24140) return 2;  // under 15 miles
    return 3;                  // beyond 15 miles
  }
  const ba = bucket(a.distance_meters);
  const bb = bucket(b.distance_meters);
  if (ba !== bb) return ba - bb;
  if ((a.rating || 0) !== (b.rating || 0)) {
    return (b.rating || 0) - (a.rating || 0);
  }
  return (b.review_count || 0) - (a.review_count || 0);
}

// ─────────────────────────────────────────────────────────────────────
// classifyCompetitorTier - 'threat' | 'winning' | 'neutral'
// ─────────────────────────────────────────────────────────────────────
// Compares a competitor against the SUBJECT business's rating + review
// count using ABSOLUTE thresholds, not subject-relative ratios. The
// prior subject-relative logic produced two failure modes:
//   - Brand-new subjects (0 reviews) had every competitor flagged as a
//     threat - even tiny 3-review competitors - because the "no signals"
//     short-circuit returned 'threat' for everyone. Result: panic-
//     inducing reports for the customer cohort that most needs an
//     achievable benchmark.
//   - Large established subjects (500+ reviews) had nearly every
//     competitor flagged 'winning' because `compReviews > sReviews * 0.5`
//     requires the competitor to have 250+ reviews to count as a threat -
//     a high-rated 100-review competitor was silently dismissed.
//
// New scheme - three tiers:
//   threat   - genuinely better than the subject; render as a card.
//   winning  - subject is meaningfully outperforming; render as a muted
//              "you're winning" line.
//   neutral  - similar level / not enough signal to judge. Caller (the
//              renderer in server.js) currently filters by tier === 'threat'
//              and tier === 'winning' - neutrals are silently dropped so
//              the report doesn't get cluttered with no-information cards.
//
// SMALL / NEW SUBJECT (sReviews < 25):
//   Absolute rating thresholds only (review-count ratios are meaningless
//   when the denominator is tiny). Rule order matters - the cReviews < 5
//   neutral check runs BEFORE the weak-rating check so a low-rated
//   competitor with too-few reviews bails to neutral instead of being
//   confidently labeled winning on a 3-review sample:
//     threat   = cRating >= 4.5 AND cReviews >= 10  (genuinely better)
//     neutral  = cReviews < 5                       (too few to judge)
//     winning  = cRating < 3.8 AND cReviews >= 5    (real weak signal)
//     neutral  = everything else
//
// ESTABLISHED SUBJECT (sReviews >= 25):
//   Rating-GAP-based - measures real outperformance, not raw review count:
//     ratingGap = cRating - sRating
//     threat   = ratingGap >= 0.5 AND cReviews >= 20
//     winning  = ratingGap <= -0.3 OR cRating < 3.8
//     neutral  = everything else
function classifyCompetitorTier(comp, subjectRating, subjectReviewCount) {
  const cRating  = (comp && typeof comp.rating === 'number') ? comp.rating : 0;
  const cReviews = (comp && typeof comp.review_count === 'number') ? comp.review_count : 0;
  const sRating  = typeof subjectRating === 'number' ? subjectRating : 0;
  const sReviews = typeof subjectReviewCount === 'number' ? subjectReviewCount : 0;

  // SMALL / NEW SUBJECT - under 25 reviews. Use absolute rating thresholds;
  // review-count comparisons are noise at this scale.
  if (sReviews < 25) {
    // Genuinely better than the subject - real threat.
    if (cRating >= 4.5 && cReviews >= 10) {
      return 'threat';
    }
    // Too few reviews to judge - could be a great new place or a bad one.
    // Bail out as neutral BEFORE the weak-rating check so a 3.2★/3-review
    // competitor doesn't get labeled winning on a tiny sample.
    if (cReviews < 5) {
      return 'neutral';
    }
    // Weak competitor (and enough reviews to trust the rating) - subject
    // is already winning. cReviews >= 5 is guaranteed by the early-return above.
    if (cRating < 3.8) {
      return 'winning';
    }
    // Similar level / insufficient signal.
    return 'neutral';
  }

  // ESTABLISHED SUBJECT - 25+ reviews. Use rating GAP as the signal.
  const ratingGap = cRating - sRating;

  // Competitor is significantly better - genuine threat.
  if (ratingGap >= 0.5 && cReviews >= 20) {
    return 'threat';
  }

  // Subject is beating them on rating, OR competitor's absolute rating is weak.
  if (ratingGap <= -0.3 || cRating < 3.8) {
    return 'winning';
  }

  // Similar level.
  return 'neutral';
}

// Fuzzy name dedup - collapse two entries with the same 20-char
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
  // FIX 1/2 additions - used by buildCompetitorQuery + getCompetitorRadius.
  // All optional so legacy callers (none in production) still work; the
  // /classify route in server.js passes them all.
  businessName = null,
  naics6 = null,
  naics2 = null,
  googleTypes = null,
  population = null,
}) {
  if (!lat || !lng || !apiKey) return null;

  // Cache key bumped to v5 - restaurant cuisine detection in
  // buildCompetitorQuery now produces cuisine-specific queries for
  // 722xxx subjects, so old v4 entries (generic 'restaurant dining')
  // are intentionally orphaned.
  const cacheKey = `v5|${placeId || ''}|${String(naics6 || type || '')}`;
  const cached = COMPETITOR_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < COMPETITOR_TTL_MS) {
    return cached.value;
  }

  // ── Subject reviews fetch (food-service only) ────────────────────
  // The cuisine-detection pipeline in buildCompetitorQuery (Layers 2
  // and 3) scans the SUBJECT business's review text for cuisine
  // keywords. Pull the subject's reviews via getDetails - almost
  // always a 24h DETAILS_CACHE hit because server.js called getDetails
  // earlier in the request to populate the report. Gated on 722xxx so
  // hotels/dental/etc. don't pay any extra Details cost. Failure is
  // non-fatal: cuisine detection just falls through to layers that
  // don't depend on review text (Layer 1 google types, Layer 4 name
  // signals, Layer 5 chain, Layer 6 fallback).
  let subjectReviewTexts = [];
  const naics6IsFoodService = String(naics6 || '').startsWith('722');
  if (naics6IsFoodService && placeId) {
    try {
      const subjectDetails = await getDetails(placeId, apiKey);
      const reviews = Array.isArray(subjectDetails && subjectDetails.reviews)
        ? subjectDetails.reviews
        : [];
      subjectReviewTexts = reviews.map((r) => String((r && r.text) || ''));
    } catch (err) {
      console.warn(`[competitor-query] subject reviews fetch failed: ${err.message}`);
    }
  }

  // ── FIX 1 - Build the Text Search query from NAICS / types / name
  // Two query variants - locality version for steps 1-7 (most specific),
  // and a no-locality version for the final step 8 (150 mi, intentionally
  // catches matches across nearby states by dropping the "near {city} {state}"
  // suffix). buildCompetitorQuery returns just the category keywords when
  // city + state are null. reviewTexts is only consumed when naics6 is
  // 722xxx; safe to pass for other categories (ignored by the function).
  // Both calls are now `await`ed because buildCompetitorQuery became
  // async with the addition of Layer 1.5 (Claude cuisine micro-call).
  // The second call is essentially free - cuisine result is cached
  // process-lifetime by (name|city|state) so the no-locality variant
  // hits the same key.
  const queryWithLocality = await buildCompetitorQuery(
    businessName || subjectName || '',
    naics6,
    naics2,
    googleTypes || (type ? [type] : []),
    city,
    state,
    subjectReviewTexts
  );
  const queryNoLocality = await buildCompetitorQuery(
    businessName || subjectName || '',
    naics6,
    naics2,
    googleTypes || (type ? [type] : []),
    null,
    null,
    subjectReviewTexts
  );

  const subjectNorm = subjectName ? normalizeName(subjectName) : null;
  const seenPlaceIds = new Set();
  const pool = [];
  const subjectLabel = businessName || subjectName || '(business)';

  function tryAdd(rawGoogleResult, source, maxRadiusMeters) {
    // Drop closed businesses BEFORE pool insertion so Claude never sees
    // them as competitors. isOperationalOrUnknown logs each drop.
    if (!isOperationalOrUnknown(rawGoogleResult)) return;
    const c = toCompetitorFromGoogle(rawGoogleResult, lat, lng, source);
    // FIX 2 - post-filter by actual distance. Google Text Search treats
    // `radius` as a relevance bias (not a hard cap), so a 1-mile-bias
    // call routinely returns results 8-10 miles away. Drop anything
    // beyond 1.5x the current step's radius. The buffer allows slight
    // overreach (a hotel at 1.2mi on the 1mi step is fine) but keeps
    // far-away high-relevance matches out - they'll be picked up on a
    // later wider rung where they actually belong.
    if (
      typeof maxRadiusMeters === 'number'
      && c.distance_meters != null
      && c.distance_meters > maxRadiusMeters * 1.5
    ) {
      return;
    }
    if (c.place_id) {
      if (placeId && c.place_id === placeId) return;        // subject by place_id
      if (seenPlaceIds.has(c.place_id)) return;             // dedup by place_id
      seenPlaceIds.add(c.place_id);
    }
    if (subjectNorm && normalizeName(c.name) === subjectNorm) return; // subject by name
    pool.push(c);
  }

  // ── 8-step radius ladder (1 → 3 → 8 → 15 → 30 → 50 → 75 → 150 mi) ─
  // Climbs until the deduped cumulative pool reaches POOL_TARGET (5).
  // Each step is an independent Text Search call - Google's relevance
  // ranker re-evaluates per radius, so a wider call may bring back
  // entirely new prominent results not present in the smaller call.
  // Step 8 (150 mi) drops "near {city} {state}" from the query so
  // category matches across state lines surface in genuinely empty
  // rural markets.
  // `radiusUsedMeters` = the LARGEST radius that fired - renderReport
  // keys the "limited competition" callout off this value.
  //
  // Claude+websearch fallback now fires INSIDE the loop, right after
  // rung index 5 (50 miles) when pool is still < 5. This catches
  // pathological-query businesses (like Cricket Wireless whose name-
  // based fallback returned 0 across all 8 rungs in the prior
  // architecture) by trading the next two slow rungs (75 mi, 150 mi)
  // for a single Claude call that produces real category queries.
  // If Claude doesn't fill the pool, the loop continues to rungs 6
  // and 7 (75 mi, 150 mi) as a last resort.
  let claudeResult = null;
  let radiusUsedMeters = RADIUS_LADDER[0];
  for (let stepIdx = 0; stepIdx < RADIUS_LADDER.length; stepIdx++) {
    const stepRadius = RADIUS_LADDER[stepIdx];
    const stepMiles = Math.round(stepRadius / 1609.34);
    const isLastStep = stepIdx === RADIUS_LADDER.length - 1;
    const stepQuery = isLastStep ? queryNoLocality : queryWithLocality;
    radiusUsedMeters = stepRadius;
    let stepResultCount = 0;
    try {
      const url = `${TEXTSEARCH_URL}?query=${encodeURIComponent(stepQuery)}`
        + `&location=${lat},${lng}`
        + `&radius=${stepRadius}`
        + `&key=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Places Text HTTP ${res.status}`);
      const json = await res.json();
      if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
        throw new Error(`Places Text status=${json.status} ${json.error_message || ''}`);
      }
      const results = json.results || [];
      stepResultCount = results.length;
      // Pass stepRadius so tryAdd's post-filter drops results beyond
      // 1.5x this step's radius (Text Search returns far-away matches
      // that we don't want polluting the close-distance buckets).
      for (const r of results) tryAdd(r, 'google_text', stepRadius);
    } catch (err) {
      console.warn(`[competitors] step ${stepIdx + 1} (${stepMiles}mi) failed:`, err.message);
      // Don't break - try the next radius rung anyway.
    }
    // Per-step diagnostic. `pool.length` is the cumulative deduped count;
    // `stepResultCount` is what THIS call returned (overlap is fine).
    const stoppingHere = pool.length >= POOL_TARGET || isLastStep;
    console.log(
      `[competitors] ${subjectLabel} - ${pool.length} found at ${stepMiles} miles`
      + (stoppingHere ? ' - done' : ' - expanding...')
    );
    if (pool.length >= POOL_TARGET) break;

    // ── Mid-ladder Claude fallback - fires ONCE after rung 5 (50 mi)
    // when the deterministic ladder is on track to fail. stepIdx === 5
    // is the natural single-fire gate; the loop only visits each index
    // once so we don't need an extra "already fired" flag.
    if (stepIdx === 5 && pool.length < POOL_TARGET) {
      console.log(
        `[competitor-claude] only ${pool.length} found after 50 miles - trying Claude+websearch fallback `
        + `for ${subjectLabel} in ${city || '(unknown)'} ${state || ''}`
      );
      claudeResult = await detectCompetitorQueryWithClaude(
        businessName || subjectName || '',
        city,
        state,
        naics6,
        apiKey
      );
      if (claudeResult && Array.isArray(claudeResult.search_queries)) {
        const FALLBACK_RADIUS_METERS = 80467; // 50 miles
        for (const baseQuery of claudeResult.search_queries) {
          if (pool.length >= POOL_TARGET) break;
          const locality = [city, state].filter(Boolean).join(' ');
          const fullQuery = locality
            ? `${baseQuery} near ${locality}`
            : baseQuery;
          const poolBefore = pool.length;
          try {
            const url = `${TEXTSEARCH_URL}?query=${encodeURIComponent(fullQuery)}`
              + `&location=${lat},${lng}`
              + `&radius=${FALLBACK_RADIUS_METERS}`
              + `&key=${apiKey}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Places Text HTTP ${res.status}`);
            const json = await res.json();
            if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
              throw new Error(`Places Text status=${json.status} ${json.error_message || ''}`);
            }
            const results = json.results || [];
            for (const r of results) tryAdd(r, 'google_text_claude', FALLBACK_RADIUS_METERS);
          } catch (err) {
            console.warn(`[competitor-claude] query "${fullQuery}" failed:`, err.message);
          }
          const newCount = pool.length - poolBefore;
          console.log(
            `[competitor-claude] query "${fullQuery}" added ${newCount} competitors `
            + `(pool now ${pool.length})`
          );
        }
        console.log(`[competitor-claude] total after fallback: ${pool.length} competitors`);
      }
      // If Claude filled the pool, break out before climbing 75/150mi.
      if (pool.length >= POOL_TARGET) break;
      // Else fall through to rungs 6 and 7 (75 mi, 150 mi) as last resort.
    }
  }
  // Final 150-mile fall-through diagnostic - distinguishes "found just
  // enough at 150mi" from "exhausted ladder".
  if (pool.length < POOL_TARGET && radiusUsedMeters >= RADIUS_LADDER[RADIUS_LADDER.length - 1]) {
    console.log(`[competitors] only ${pool.length} found within 150 miles - may be limited competition`);
  }

  // ── Fuzzy dedup, sort, slice ─────────────────────────────────────
  const poolBeforeDedup = pool.length;
  const fuzzed = fuzzyDedupByName(pool);
  fuzzed.sort(competitorComparator);
  const top7 = fuzzed.slice(0, 7);
  const top5 = top7.slice(0, 5);

  // ── FIX 3 - Fetch Place Details for top 5 in parallel ────────────
  // Each detail fetch hits the existing 24h DETAILS_CACHE so repeat
  // analyses are free. Reviews truncated to 300 chars × 3 per business
  // - gives downstream renderers/Claude real review evidence per
  // competitor (currently unused; available for future wiring).
  const top5WithDetails = await Promise.all(top5.map(async (c) => {
    if (!c.place_id) return { ...c, reviews: [], address: null };
    try {
      const details = await getDetails(c.place_id, apiKey);
      const reviews = (Array.isArray(details.reviews) ? details.reviews : [])
        .slice(0, 3)
        .map((r) => ({
          text: String(r.text || '').replace(/\s+/g, ' ').slice(0, 300),
          rating: typeof r.rating === 'number' ? r.rating : null,
          time: r.relative_time_description || null,
        }));
      return {
        ...c,
        reviews,
        address: details.formatted_address || null,
        weekday_text: details.opening_hours?.weekday_text || [],
      };
    } catch (err) {
      return { ...c, reviews: [], address: null, weekday_text: [] };
    }
  }));

  // Splice the enriched top 5 back into the top-7 slice so list shape
  // stays consistent for any consumer that walks competitors_top7.
  const enrichedTop7 = top5WithDetails.concat(top7.slice(5));
  const enrichedTop5 = top5WithDetails;
  const enrichedTop3 = top5WithDetails.slice(0, 3);

  const ratings = fuzzed.map((c) => c.rating).filter((x) => typeof x === 'number');
  const reviewCounts = fuzzed
    .map((c) => c.review_count)
    .filter((x) => typeof x === 'number' && x > 0);

  console.log(`[competitors] query: "${queryWithLocality}" | radius_used: ${Math.round(radiusUsedMeters / 1609.34)}mi | found: ${poolBeforeDedup} | dedup: ${fuzzed.length} | top5 detail-enriched`);

  // Track whether the Claude+websearch fallback actually contributed
  // any of the surfaced competitors (any pool entry with source ===
  // 'google_text_claude'). When it did, surface its business-type
  // description on the returned value so the report can show
  // "what type of competitors we looked for" later.
  const claudeFallbackUsed = pool.some((c) => c.source === 'google_text_claude');
  const sourcesUsed = claudeFallbackUsed ? ['google_text', 'google_text_claude'] : ['google_text'];

  const value = {
    competitor_count: fuzzed.length,
    competitor_median_rating: median(ratings),
    competitor_median_review_count: median(reviewCounts),
    competitors_top7: enrichedTop7,
    competitors_top5: enrichedTop5,
    competitors_top3: enrichedTop3,
    sources_used: sourcesUsed,
    search_radius_miles: Math.round(radiusUsedMeters / 1609.34),
    competitor_query: queryWithLocality,
    // Claude fallback metadata - null when the fallback didn't fire or
    // returned no usable result. Lets the report later surface phrasing
    // like "We looked for: cell phone stores, wireless carrier stores,
    // phone repair shops near Madison WI" when the deterministic query
    // path didn't find competitors.
    competitor_query_claude: (claudeResult && claudeResult.business_type) || null,
    competitor_types_claude: (claudeResult && claudeResult.competitor_types) || null,
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
// fetchBusinessTypeCompetitors - Market Analysis (Mode 2) novelty signal
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
const BIZ_TYPE_TTL_MS = 24 * 60 * 60 * 1000;
const BIZ_TYPE_CACHE = new LRUCache({ max: 1000, ttl: BIZ_TYPE_TTL_MS });

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
  // also acts as a soft bias rather than a hard filter - that's fine
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
    // Drop CLOSED_PERMANENTLY / CLOSED_TEMPORARILY before counting so
    // the novelty score reflects actual operational competition, not
    // ghost listings.
    const results = (Array.isArray(json.results) ? json.results : [])
      .filter(isOperationalOrUnknown);
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

// ── fetchReviewsBySort ───────────────────────────────────────────────
// Fetches ONLY the reviews field for a place_id with a specific sort.
// Intentionally bypasses DETAILS_CACHE (cache is keyed by place_id
// only and would return the cached "newest" response regardless of the
// sort parameter). Timeout: 5s per spec. Never throws — returns [] on
// any error so callers don't need try/catch.
//
// Valid sort values: "newest" | "lowest_rating" | "highest_rating" | "relevant"
async function fetchReviewsBySort(placeId, sort, apiKey) {
  if (!placeId || !apiKey) return [];
  const url = `${DETAILS_URL}?place_id=${encodeURIComponent(placeId)}&fields=reviews&reviews_sort=${encodeURIComponent(sort)}&key=${apiKey}`;
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 5000 });
    if (!res.ok) return [];
    const json = await res.json();
    if (json.status !== 'OK') return [];
    return Array.isArray(json.result && json.result.reviews)
      ? json.result.reviews
      : [];
  } catch (err) {
    console.warn(`[reviews] fetchReviewsBySort(${sort}) failed for ${placeId}: ${err.message}`);
    return [];
  }
}

// ── fetchAllSortedReviews ────────────────────────────────────────────
// Smart multi-sort review fetch. Decides which sorts to call based on
// the business's total review count, fires them in parallel, then
// merges and deduplicates the results.
//
// Dedup key: author_name + time (both present on every Google review).
// Each returned review gets a _sort field so downstream callers (Claude
// prompt, report render) know which pool it came from.
//
// Review count thresholds:
//   0         - skip all calls; return []
//   1-5       - "relevant" only (Google returns the same 5 reviews for
//               any sort when total count <= 5)
//   6-10      - "newest" + "lowest_rating"
//   11-19     - "newest" + "lowest_rating" + "relevant"
//   >= 20     - all 4: "newest" + "lowest_rating" + "highest_rating" + "relevant"
//
// Returns: { reviews: Array, callCount: number }
async function fetchAllSortedReviews(placeId, reviewCount, apiKey) {
  const count = typeof reviewCount === 'number' ? reviewCount : 0;

  let sorts;
  if (count === 0) {
    return { reviews: [], callCount: 0 };
  } else if (count <= 5) {
    sorts = ['relevant'];
  } else if (count <= 10) {
    sorts = ['newest', 'lowest_rating'];
  } else if (count <= 19) {
    sorts = ['newest', 'lowest_rating', 'relevant'];
  } else {
    sorts = ['newest', 'lowest_rating', 'highest_rating', 'relevant'];
  }

  const batches = await Promise.all(
    sorts.map((sort) =>
      fetchReviewsBySort(placeId, sort, apiKey).then((reviews) =>
        reviews.map((r) => ({ ...r, _sort: sort }))
      )
    )
  );

  // Flatten and deduplicate by author_name + time.
  const seen = new Set();
  const merged = [];
  for (const batch of batches) {
    for (const r of batch) {
      const key = `${r.author_name || ''}|${r.time || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(r);
      }
    }
  }

  return { reviews: merged, callCount: sorts.length };
}

module.exports = {
  findPlace,
  getDetails,
  toInputFields,
  fetchNearbyCompetitors,
  pickNearbySearchType,
  fetchBusinessTypeCompetitors,
  classifyCompetitorTier,
  buildCompetitorQuery,
  isOperationalOrUnknown,
  fetchReviewsBySort,
  fetchAllSortedReviews,
};

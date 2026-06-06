// LRU-Cache wrapper - bounded-size cache with per-entry TTL. Replaces
// the raw `new Map()` caches throughout this file so the process can't
// OOM under sustained traffic. max=1000 entries each; existing TTLs
// preserved. Pattern is unchanged: `cache.get(key)` returns either the
// stored { ts, value } wrapper or undefined (when LRU has evicted),
// and the existing `if (cached && Date.now() - cached.ts < TTL)` check
// continues to work - the explicit TTL math becomes belt-and-suspenders
// since LRU handles eviction internally.
const { LRUCache } = require('lru-cache');
const { parse: parseCsv } = require('csv-parse/sync');

/* dataFetchers.js - non-Google data sources.

   BATCH14 / 360°:
     - extractZipFromAddress(formatted_address) → 5-digit ZIP or null
     - fetchCensusByZip(zip) → ACS demographics or null
     - checkWebsiteExists(url) → boolean or null (timeout/error)

   Phase 5+ (3 new free sources):
     - fetchWeather(lat, lon) → climatology (peak month, cold winter, etc.)
     - fetchPageSpeed(url, apiKey) → mobile score / load time / LCP
     - fetchLocationSignals(lat, lon) → anchor tenants + transit proximity

   All async functions catch their own errors and return null on failure
   so server.js can call them via Promise.allSettled and never block the
   overall report on one missing data source. */

// Coerce a value to an integer, returning null on empty / non-numeric.
// Used by fetchCMSProviderData since CMS reports counts as strings ("4")
// or empty strings (""). Centralized here so other fetchers can reuse.
function parseIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// isOperationalOrUnknown - keep Places results that are OPERATIONAL or
// whose business_status field is missing; drop CLOSED_PERMANENTLY /
// PERMANENTLY_CLOSED / CLOSED_TEMPORARILY with a console log so the
// filter is auditable. Duplicated (intentionally) in googlePlaces.js
// to avoid a circular require - dataFetchers must not depend on
// googlePlaces (googlePlaces requires dataFetchers).
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

// Haversine distance in meters between two (lat,lon) pairs. Used by the
// Overpass fetcher to compute per-element distances from the business.
function haversineMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Census ACS 5-Year Estimates. API key optional: anonymous calls work
// but are rate-limited to ~500/day per IP. Set CENSUS_API_KEY in .env
// (free, instant; https://api.census.gov/data/key_signup.html) and the
// fetcher appends &key=… automatically.
//
// Year-fallback: the Census releases each new 5-year ACS in December
// (e.g. the 2020-2024 5-year released ~Dec 2025). Some variables lag
// the headline release. We try the most recent year first then fall
// back to the prior year so production never breaks on Census slipping
// a release window. Helper: _fetchAcsJson(pathAfterAcs5, timeoutMs).
//
// Fields:
//   B19013_001E - Median household income
//   B01001_001E - Total population (sex by age table - same number as B01003)
//   B25010_001E - Average household size
//   ── Housing extension (Phase 5+) ──
//   B25001_001E - Total housing units
//   B25002_003E - Vacant housing units
//   B25003_002E - Owner-occupied units
//   B25003_003E - Renter-occupied units
//   B25077_001E - Median home value (owner-occupied)
//   B25064_001E - Median gross rent
const ACS_YEARS = ['2024', '2023'];

async function _fetchAcsJson(pathAfterAcs5, timeoutMs = 5000) {
  const apiKey = process.env.CENSUS_API_KEY;
  const auth = apiKey ? '&key=' + apiKey : '';
  for (const year of ACS_YEARS) {
    const url = 'https://api.census.gov/data/' + year + '/acs/acs5' + pathAfterAcs5 + auth;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) {
        console.warn('[census] ' + year + ' HTTP ' + res.status + ', trying next year');
        continue;
      }
      const data = await res.json();
      if (!Array.isArray(data) || data.length < 2) {
        console.warn('[census] ' + year + ' returned no rows, trying next year');
        continue;
      }
      if (year !== ACS_YEARS[0]) {
        console.log('[census] using ' + year + ' ACS (fallback from ' + ACS_YEARS[0] + ')');
      }
      return data;
    } catch (e) {
      console.warn('[census] ' + year + ' failed: ' + e.message + ', trying next year');
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Legacy alias retained - direct URL constant removed; callers use
// _fetchAcsJson with the path-after-acs5 query string instead.
const CENSUS_ZIP_PATH = '?get=B19013_001E,B01001_001E,B25010_001E,B25001_001E,B25002_003E,B25003_002E,B25003_003E,B25077_001E,B25064_001E&for=zip%20code%20tabulation%20area:';

// In-memory cache, 30-day TTL keyed by ZIP. Process-lifetime only.
const CENSUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CENSUS_CACHE = new LRUCache({ max: 1000, ttl: CENSUS_TTL_MS });

// State name → 2-digit FIPS for the place-level (city) lookup. Used
// by fetchCensusByZip when city + state are provided so we can pull
// the more accurate place-level population for small cities (ZIP-level
// figures over-count rural areas around the city - e.g. ZIP 53533
// covers ~7,400 people but Dodgeville city itself is ~5,100).
// State + DC + U.S. territory FIPS codes. DC and territories were
// missing - every business in Washington DC and Puerto Rico fell
// through to ZIP-only lookups and got over/under-counted ZCTA
// population instead of the more accurate place-level number.
const STATE_FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06',
  CO: '08', CT: '09', DE: '10', FL: '12', GA: '13',
  HI: '15', ID: '16', IL: '17', IN: '18', IA: '19',
  KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MO: '29',
  MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34',
  NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45',
  SD: '46', TN: '47', TX: '48', UT: '49', VT: '50',
  VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
  // DC + U.S. territories (FIPS).
  DC: '11', PR: '72', GU: '66', VI: '78', AS: '60', MP: '69',
};

// Separate 30-day cache for the place-level lookup. Keyed by
// `${city.toLowerCase()}|${state.toLowerCase()}`. Stores just the
// place population we extract from the ACS place table - kept
// separate so different ZIPs in the same city share the same place row.
const CENSUS_PLACE_CACHE = new LRUCache({ max: 1000, ttl: CENSUS_TTL_MS });

// Census ACS uses sentinel `-666666666` to signal "data not available."
function cleanCensusValue(raw) {
  if (raw == null) return null;
  const s = String(raw);
  if (s === '' || s.startsWith('-666') || s === 'null') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractZipFromAddress(formattedAddress) {
  if (!formattedAddress || typeof formattedAddress !== 'string') return null;
  // Match a 5-digit ZIP, optionally followed by -NNNN. Look for it after
  // a state code to reduce false positives (street numbers, suite numbers).
  // Case-insensitive so a lowercase state in the address (rare but possible
  // from non-Google formatted_address sources) still resolves the ZIP.
  const m = formattedAddress.match(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/i);
  if (m) return m[1];
  // Fallback: any 5-digit number near the end of the string.
  const m2 = formattedAddress.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/);
  return m2 ? m2[1] : null;
}

// Fetch ZIP-level data - the original behavior. Throws on total
// year-fallback failure (existing /classify pipeline relies on this via
// Promise.allSettled to distinguish "data unavailable" from "no rows").
async function _fetchCensusZipLevel(zip) {
  const cached = CENSUS_CACHE.get(zip);
  if (cached && Date.now() - cached.ts < CENSUS_TTL_MS) return cached.value;

  const json = await _fetchAcsJson(CENSUS_ZIP_PATH + zip, 5000);
  if (!json) {
    throw new Error('Census ACS no data after year-fallback (' + ACS_YEARS.join('/') + ')');
  }
  // Shape: header row + one data row. 9 ACS variables + zip column.
  // [["B19013_001E","B01001_001E","B25010_001E","B25001_001E","B25002_003E",
  //   "B25003_002E","B25003_003E","B25077_001E","B25064_001E","zip code tabulation area"],
  //  ["68000","45000","2.5","4521","370","2400","1100","187000","842","53533"]]
  if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) {
    return null;
  }
  const row = json[1];
  // ── Housing derivations ─────────────────────────────────────────
  const totalUnits = cleanCensusValue(row[3]);
  const vacantUnits = cleanCensusValue(row[4]);
  const ownerUnits = cleanCensusValue(row[5]);
  const renterUnits = cleanCensusValue(row[6]);
  const medianHomeValue = cleanCensusValue(row[7]);
  const medianGrossRent = cleanCensusValue(row[8]);
  const occupiedUnits = (typeof ownerUnits === 'number' && typeof renterUnits === 'number')
    ? ownerUnits + renterUnits : null;
  const vacancyRate = (typeof totalUnits === 'number' && totalUnits > 0
    && typeof vacantUnits === 'number')
    ? +((vacantUnits / totalUnits) * 100).toFixed(1) : null;
  const homeownershipRate = (typeof ownerUnits === 'number' && typeof occupiedUnits === 'number'
    && occupiedUnits > 0)
    ? +((ownerUnits / occupiedUnits) * 100).toFixed(1) : null;

  const value = {
    median_household_income: cleanCensusValue(row[0]),
    total_population: cleanCensusValue(row[1]),
    average_household_size: cleanCensusValue(row[2]),
    zip,
    // Housing extension - packaged as a sub-object so claudeEnricher
    // can pass `census_housing` to Claude as a single coherent block
    // regardless of how many fields end up populated.
    census_housing: {
      housing_units: totalUnits,
      vacancy_rate: vacancyRate,
      homeownership_rate: homeownershipRate,
      median_home_value: medianHomeValue,
      median_gross_rent: medianGrossRent,
    },
  };
  CENSUS_CACHE.set(zip, { ts: Date.now(), value });
  return value;
}

// Fetch place-level (city) population for a given city+state. Returns
// just the population number (or null if no match). Uses ACS variable
// B01003_001E (canonical total population field - same value as
// B01001_001E but cleaner name in the place table). The /place:*
// query returns every place in the state - we filter by name match.
async function _fetchCensusPlacePopulation(city, state) {
  if (!city || !state) return null;
  const stateFIPS = STATE_FIPS[state.toUpperCase()];
  if (!stateFIPS) return null;

  const cacheKey = `${city.toLowerCase()}|${state.toLowerCase()}`;
  const cached = CENSUS_PLACE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CENSUS_TTL_MS) return cached.value;

  const json = await _fetchAcsJson(
    '?get=NAME,B19013_001E,B01003_001E,B25010_001E&for=place:*&in=state:' + stateFIPS,
    8000
  );
  if (!json) {
    CENSUS_PLACE_CACHE.set(cacheKey, { ts: Date.now(), value: null });
    return null;
  }
  try {
    if (!Array.isArray(json) || json.length < 2) return null;
    // Header row: ["NAME","B19013_001E","B01003_001E","B25010_001E","state","place"]
    // Data rows e.g.: ["Dodgeville city, Wisconsin","56324","5067","2.31","55","21300"]
    // Match by name: substring + " " (so "Dodgeville" matches "Dodgeville city, …"
    // but NOT "Dodgeville Township" - using the trailing space rule).
    const cityLower = city.toLowerCase();
    // Find every row whose place name STARTS with the city name. Then
    // pick the one with the largest population - Chicago city (2.7M)
    // beats Chicago Heights (29k) and Chicago Ridge village (14k),
    // both of which would otherwise win on .find()'s first-match
    // semantics depending on alphabetical row ordering.
    const candidates = json.slice(1).filter((row) => {
      const name = String(row[0] || '').toLowerCase();
      return name.startsWith(cityLower + ' ') || name.startsWith(cityLower + ',');
    });
    candidates.sort((a, b) => {
      const popA = parseInt(a[2], 10) || 0;
      const popB = parseInt(b[2], 10) || 0;
      return popB - popA;
    });
    const match = candidates[0];
    if (!match) {
      CENSUS_PLACE_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const value = {
      name: match[0],
      median_household_income: cleanCensusValue(match[1]),
      total_population: cleanCensusValue(match[2]),
      average_household_size: cleanCensusValue(match[3]),
    };
    CENSUS_PLACE_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-census-place] post-parse failed:', err.message);
    return null;
  }
}

// County-level median income - used for big cities (pop > 200k) where
// a single ZIP captures a downtown census tract dominated by transient
// / student population and dramatically understates median income.
// (Chicago ZIP 60601 ACS median ≈ $45k; Cook County ACS median ≈ $75k.)
const CENSUS_COUNTY_INCOME_CACHE = new LRUCache({ max: 1000, ttl: CENSUS_TTL_MS });

async function _fetchCensusCountyIncome(countyFIPS) {
  if (!countyFIPS || !/^\d{5}$/.test(countyFIPS)) return null;
  const cached = CENSUS_COUNTY_INCOME_CACHE.get(countyFIPS);
  if (cached && Date.now() - cached.ts < CENSUS_TTL_MS) return cached.value;

  const stateFIPS = countyFIPS.substring(0, 2);
  const countyCode = countyFIPS.substring(2, 5);
  const json = await _fetchAcsJson(
    '?get=NAME,B19013_001E&for=county:' + countyCode + '&in=state:' + stateFIPS,
    5000
  );
  if (!json) return null;
  try {
    if (!Array.isArray(json) || json.length < 2) return null;
    // Header: ["NAME","B19013_001E","state","county"]
    // Row e.g.: ["Cook County, Illinois","75379","17","031"]
    const income = cleanCensusValue(json[1][1]);
    CENSUS_COUNTY_INCOME_CACHE.set(countyFIPS, { ts: Date.now(), value: income });
    return income;
  } catch (err) {
    console.warn('[fetch-census-county-income] post-parse failed:', err.message);
    return null;
  }
}

async function fetchCensusByZip(zip, city = null, state = null, countyFIPS = null) {
  if (!zip || !/^\d{5}$/.test(zip)) return null;

  // Run ZIP, place, and county-income lookups in parallel. The latter
  // two only fire when the inputs are present. Population comes from
  // place when we have it (always - see below), with ZIP as fallback;
  // income comes from county for cities >200k and ZIP otherwise.
  const wantPlace = city && state;
  const wantCounty = !!countyFIPS;
  const [zipResult, placeResult, countyIncome] = await Promise.all([
    _fetchCensusZipLevel(zip),
    wantPlace  ? _fetchCensusPlacePopulation(city, state).catch(() => null) : Promise.resolve(null),
    wantCounty ? _fetchCensusCountyIncome(countyFIPS).catch(() => null)     : Promise.resolve(null),
  ]);

  if (!zipResult) return null;

  // ── Population resolution ──────────────────────────────────────
  // FIX 2: the prior "prefer place only when smaller than ZIP" was
  // backwards for big cities - Chicago place-pop 2.7M > ZIP 60601's
  // ~15k, so the old logic kept the wrong (tiny) ZIP figure. New rule:
  // when we have place pop, ALWAYS use it.
  let total_population = zipResult.total_population;
  let population_source = 'zip';
  if (placeResult && typeof placeResult.total_population === 'number') {
    total_population = placeResult.total_population;
    population_source = 'city';
  } else if (typeof zipResult.total_population === 'number') {
    // Place lookup miss (uncommon but possible - non-incorporated
    // localities or geocoding mismatches). ZIP figure may be
    // understated for downtown-only ZIPs of large cities; we surface
    // the source so the caller can hedge if needed.
    population_source = 'zip';
  }

  // ── Income resolution ──────────────────────────────────────────
  // Priority order:
  //   1. CITY (place-level) income - when the place lookup returned a
  //      number. City-level ACS median is more representative than
  //      ZIP-level for any city size: small cities (Dodgeville) get a
  //      tighter local figure than the ZCTA that bleeds into rural
  //      land, and big cities (Chicago) skip the downtown-ZIP transient-
  //      population skew because city-wide median averages across all
  //      neighborhoods.
  //   2. COUNTY income - defensive fallback for big cities (pop > 200k)
  //      when the city place lookup misses for some reason but a county
  //      FIPS is available. Still better than the downtown ZIP figure
  //      for the transient-population case.
  //   3. ZIP income - final fallback for everything else.
  let median_household_income = zipResult.median_household_income;
  let income_source = 'zip';
  if (placeResult && typeof placeResult.median_household_income === 'number') {
    median_household_income = placeResult.median_household_income;
    income_source = 'city';
  } else if (
    typeof total_population === 'number'
    && total_population > 200000
    && typeof countyIncome === 'number'
  ) {
    median_household_income = countyIncome;
    income_source = 'county';
  }

  // ── FIX 4: single-line sanity-check log when called with locality
  // context. Logs nothing for /classify (which invokes with zip only).
  if (city && state) {
    const popStr = typeof total_population === 'number' ? total_population.toLocaleString('en-US') : '-';
    const incStr = typeof median_household_income === 'number' ? median_household_income.toLocaleString('en-US') : '-';
    console.log(
      `[census] ${city}, ${state} - pop: ${popStr} (${population_source}) | income: $${incStr} (${income_source})`
    );
  }

  return {
    median_household_income,
    total_population,
    average_household_size: zipResult.average_household_size,
    zip,
    population_source,
    income_source,
    // Housing fields flow through from the ZIP-level fetcher. Always
    // ZIP-scoped (place-level Census doesn't carry housing variables
    // in the same row layout).
    census_housing: zipResult.census_housing || null,
  };
}

/* Issue a HEAD request to the website and return true if it loads
   (HTTP 2xx/3xx within 3 seconds), false on 4xx/5xx, or null on timeout
   / DNS error / abort. Some hosts reject HEAD; on a method-not-allowed
   response (405), retry with a GET that aborts on first byte.
   No caching - these change rarely but per-request cost is negligible. */
async function checkWebsiteExists(url) {
  if (!url || typeof url !== 'string') return null;
  // Normalize: must have scheme.
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;

  async function attempt(method) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: ac.signal,
        headers: {
          'User-Agent': 'GrowthIM/0.1 (+audit-only; HEAD probe)',
        },
      });
      // 2xx/3xx → exists. 4xx/5xx → not exists for our purposes.
      // 405 (method not allowed) → caller should retry with GET.
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const r = await attempt('HEAD');
    if (r.status === 405 || r.status === 501) {
      // Some servers reject HEAD; try GET (still aborts on timeout).
      const r2 = await attempt('GET');
      return r2.status >= 200 && r2.status < 400;
    }
    return r.status >= 200 && r.status < 400;
  } catch (err) {
    // AbortError, network error, DNS failure → null (unknown).
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchWeather (Open-Meteo historical archive, free, no key)
// ═══════════════════════════════════════════════════════════════════
// The user's spec called for `/v1/forecast?monthly=...` but Open-Meteo's
// /v1/forecast is short-term (16 days) and doesn't accept a `monthly`
// parameter. We use /v1/archive (historical) for the past full year of
// daily highs and aggregate them into monthly averages - that gives real
// climatology suitable for "peak month" / "cold winter" classification.
const WEATHER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const WEATHER_CACHE = new LRUCache({ max: 1000, ttl: WEATHER_TTL_MS });

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// State-level climate defaults - used as fallback when Open-Meteo
// fetch fails, times out, or returns empty data. Keyed by 2-letter
// US state abbreviation.
const STATE_CLIMATE = {
  WI: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  MN: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  MI: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  IL: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  OH: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  IN: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  IA: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  MO: { has_cold_winter: true,  has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  ND: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  SD: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  NE: { has_cold_winter: true,  has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  KS: { has_cold_winter: true,  has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  NY: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  PA: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  MA: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  CT: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  NJ: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  ME: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  NH: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  VT: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  CO: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  UT: { has_cold_winter: true,  has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  WY: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  MT: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  ID: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  WA: { has_cold_winter: false, has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  OR: { has_cold_winter: false, has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  CA: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  NV: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  AZ: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jun', peak_tourist_season: 'Mar-May' },
  NM: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jun', peak_tourist_season: 'Mar-May' },
  TX: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jun', peak_tourist_season: 'Mar-May' },
  OK: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  AR: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  LA: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jun', peak_tourist_season: 'Mar-May' },
  MS: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jun', peak_tourist_season: 'Mar-May' },
  AL: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jun', peak_tourist_season: 'Mar-May' },
  GA: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jun', peak_tourist_season: 'Mar-May' },
  FL: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Apr', peak_tourist_season: 'Dec-Feb' },
  SC: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jun', peak_tourist_season: 'Mar-May' },
  NC: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  VA: { has_cold_winter: false, has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  WV: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  KY: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  TN: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  MD: { has_cold_winter: false, has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  DE: { has_cold_winter: false, has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  RI: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
  HI: { has_cold_winter: false, has_hot_summer: true,  peak_month: 'Dec', peak_tourist_season: 'Dec-Feb' },
  AK: { has_cold_winter: true,  has_hot_summer: false, peak_month: 'Jul', peak_tourist_season: 'Jun-Aug' },
};

// Returns a state-based climate estimate when the Open-Meteo API is
// unavailable. Parses the 2-letter state code from a Google
// formatted_address (e.g. "123 Main St, Dodgeville, WI 53533, USA").
function fetchWeatherFallback(address) {
  const stateMatch = /,\s*([A-Z]{2})\s+\d{5}/.exec(address || '');
  const stateCode = stateMatch ? stateMatch[1] : null;
  const climate = stateCode ? STATE_CLIMATE[stateCode] : null;
  if (climate) {
    console.log('[fetch5-weather] using state fallback for:', stateCode);
    return { ...climate, is_fallback: true };
  }
  console.log('[fetch5-weather] using state fallback for:', stateCode || 'unknown');
  return {
    has_cold_winter: false,
    has_hot_summer: false,
    peak_month: 'Jul',
    peak_tourist_season: 'Jun-Aug',
    is_fallback: true,
  };
}

async function fetchWeather(lat, lon, address) {
  if (lat == null || lon == null) return null;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = WEATHER_CACHE.get(key);
  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
    console.log(`[cache] weather hit for ${key}`);
    return cached.value;
  }

  // Past 12 months ending ~7 days ago (the archive lags real-time slightly).
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() - 7);
  const startDate = new Date(endDate);
  startDate.setFullYear(endDate.getFullYear() - 1);
  const sd = startDate.toISOString().slice(0, 10);
  const ed = endDate.toISOString().slice(0, 10);

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${sd}&end_date=${ed}&daily=temperature_2m_max,precipitation_sum&temperature_unit=fahrenheit&timezone=auto`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const json = await res.json();
    const dailyMax = (json.daily && json.daily.temperature_2m_max) || [];
    const dailyPrecip = (json.daily && json.daily.precipitation_sum) || [];
    const dates = (json.daily && json.daily.time) || [];
    if (!dailyMax.length || !dates.length) return fetchWeatherFallback(address);

    // Aggregate into monthly averages
    const buckets = {}; // 1-12 → { tempSum, tempN, precipSum, precipN }
    for (let i = 0; i < dates.length; i++) {
      const m = parseInt(dates[i].slice(5, 7), 10);
      if (!buckets[m]) buckets[m] = { tempSum: 0, tempN: 0, precipSum: 0, precipN: 0 };
      if (typeof dailyMax[i] === 'number') {
        buckets[m].tempSum += dailyMax[i];
        buckets[m].tempN += 1;
      }
      if (typeof dailyPrecip[i] === 'number') {
        buckets[m].precipSum += dailyPrecip[i];
        buckets[m].precipN += 1;
      }
    }
    const monthAvgs = {};
    for (const m of Object.keys(buckets)) {
      const b = buckets[m];
      if (b.tempN > 0) monthAvgs[m] = b.tempSum / b.tempN;
    }
    if (!Object.keys(monthAvgs).length) return fetchWeatherFallback(address);

    // Peak month = highest avg max-temp
    let peakMonth = null;
    let peakAvg = -Infinity;
    for (const [m, avg] of Object.entries(monthAvgs)) {
      if (avg > peakAvg) { peakAvg = avg; peakMonth = parseInt(m, 10); }
    }
    const hasColdWinter = Object.values(monthAvgs).some((avg) => avg < 35);
    const hasHotSummer = Object.values(monthAvgs).some((avg) => avg > 85);

    // Peak season = 3-month band centered on peak month (e.g. May-July)
    let peakSeason = null;
    if (peakMonth) {
      const startM = ((peakMonth - 2 + 12) % 12) + 1; // peak - 1, wrap to [1,12]
      const endM = (peakMonth % 12) + 1;              // peak + 1
      peakSeason = `${MONTH_NAMES[startM - 1]}-${MONTH_NAMES[endM - 1]}`;
    }

    const value = {
      peak_month: peakMonth ? MONTH_NAMES[peakMonth - 1] : null,
      peak_month_avg_f: peakMonth ? +monthAvgs[peakMonth].toFixed(1) : null,
      has_cold_winter: hasColdWinter,
      has_hot_summer: hasHotSummer,
      peak_tourist_season: peakSeason,
    };
    WEATHER_CACHE.set(key, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-weather] failed:', err.message);
    return fetchWeatherFallback(address);
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchPageSpeed (Google PSI, mobile strategy)
// ═══════════════════════════════════════════════════════════════════
// PSI commonly takes 8-15 seconds. We give it a 15s hard upper bound;
// returns null on timeout so the report renders without speed metrics
// rather than hang. Caller should only call this when website_exists
// is true (gated in server.js).
//
// Reads the Google API key from process.env.GOOGLE_PLACES_API_KEY at
// call time (single-arg signature); the same key works for PSI as for
// Places since both bill against the project console.
const PAGESPEED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PAGESPEED_CACHE = new LRUCache({ max: 1000, ttl: PAGESPEED_TTL_MS });

async function fetchPageSpeed(websiteUrl) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!websiteUrl || !apiKey) return null;
  if (!/^https?:\/\//i.test(websiteUrl)) websiteUrl = 'https://' + websiteUrl;

  const cached = PAGESPEED_CACHE.get(websiteUrl);
  if (cached && Date.now() - cached.ts < PAGESPEED_TTL_MS) {
    console.log(`[cache] pagespeed hit for ${websiteUrl}`);
    return cached.value;
  }

  const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(websiteUrl)}&strategy=mobile&key=${apiKey}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`PageSpeed HTTP ${res.status}`);
    const json = await res.json();
    const lh = json.lighthouseResult;
    if (!lh) throw new Error('no lighthouseResult in response');

    const perfScore = lh.categories && lh.categories.performance && lh.categories.performance.score;
    const interactiveMs = lh.audits && lh.audits.interactive && lh.audits.interactive.numericValue;
    const lcpMs = lh.audits && lh.audits['largest-contentful-paint'] && lh.audits['largest-contentful-paint'].numericValue;

    const mobileScore = typeof perfScore === 'number' ? Math.round(perfScore * 100) : null;
    const loadTime = typeof interactiveMs === 'number' ? +(interactiveMs / 1000).toFixed(1) : null;
    const lcpSec = typeof lcpMs === 'number' ? +(lcpMs / 1000).toFixed(1) : null;

    const value = {
      mobile_score: mobileScore,
      load_time_seconds: loadTime,
      lcp_seconds: lcpSec,
      is_mobile_friendly: mobileScore != null ? mobileScore >= 50 : null,
    };
    PAGESPEED_CACHE.set(websiteUrl, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-pagespeed] failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// fetchCompetitorPageSpeed - per-business wrapper around fetchPageSpeed
// ═══════════════════════════════════════════════════════════════════
// Accepts businessName + url so caller can log which competitor is
// being checked. Returns the same shape as fetchPageSpeed or null.
async function fetchCompetitorPageSpeed(businessName, url) {
  if (!url) {
    console.log('[pagespeed] failed:', businessName, '|', url, '| no URL provided');
    return null;
  }
  const cleanUrl = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  console.log('[pagespeed] checking:', businessName, '→', cleanUrl);
  try {
    const result = await fetchPageSpeed(cleanUrl);
    if (result && typeof result.mobile_score === 'number') {
      console.log('[pagespeed] score:', businessName, '→', result.mobile_score + '/100');
    } else {
      console.log('[pagespeed] failed:', businessName, '|', cleanUrl, '| no score returned');
    }
    return result;
  } catch (err) {
    console.log('[pagespeed] failed:', businessName, '|', cleanUrl, '|', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// fetchCruxScore - Chrome UX Report (CrUX) API, PHONE form factor
// ═══════════════════════════════════════════════════════════════════
// Fallback for competitors whose sites block PSI's headless Chrome
// (bot-protection, heavy JS). CrUX returns real-user p75 field data
// from Chrome users, so it succeeds on sites PSI can never load.
//
// Returns null on any failure, 404 (origin not in dataset), or
// timeout — never throws. Accepts http:// origins and also retries
// with https:// when the first attempt returns null.
const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const CRUX_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days — same as PSI cache
const CRUX_CACHE    = new LRUCache({ max: 1000, ttl: CRUX_TTL_MS });

async function _queryCruxOrigin(origin, apiKey) {
  const cached = CRUX_CACHE.get(origin);
  if (cached && Date.now() - cached.ts < CRUX_TTL_MS) {
    console.log(`[cache] crux hit for ${origin}`);
    return cached.value;
  }

  const url  = `${CRUX_ENDPOINT}?key=${apiKey}`;
  const body = JSON.stringify({
    origin,
    formFactor: 'PHONE',
    metrics: [
      'largest_contentful_paint',
      'interaction_to_next_paint',
      'cumulative_layout_shift',
    ],
  });
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ac.signal,
    });
    // 404 = origin not in CrUX dataset - normal, not an error.
    if (res.status === 404) {
      CRUX_CACHE.set(origin, { ts: Date.now(), value: null });
      return null;
    }
    const json = await res.json();
    if (!res.ok) {
      console.warn(`[fetch-crux] ${origin} HTTP ${res.status}:`, json?.error?.message || '');
      return null;
    }
    const metrics = json?.record?.metrics;
    if (!metrics) return null;

    const lcpP75 = metrics.largest_contentful_paint?.percentiles?.p75  ?? null;
    const inpP75 = metrics.interaction_to_next_paint?.percentiles?.p75  ?? null;
    const clsP75 = metrics.cumulative_layout_shift?.percentiles?.p75    ?? null;

    if (lcpP75 == null && inpP75 == null && clsP75 == null) return null;

    // Per-metric ratings.
    const lcpRating = lcpP75 == null ? null
      : lcpP75 < 2500 ? 'good' : lcpP75 <= 4000 ? 'needs-improvement' : 'poor';
    const inpRating = inpP75 == null ? null
      : inpP75 < 200  ? 'good' : inpP75 <= 500   ? 'needs-improvement' : 'poor';
    const clsRating = clsP75 == null ? null
      : clsP75 < 0.10 ? 'good' : clsP75 <= 0.25  ? 'needs-improvement' : 'poor';

    // Convert 3-rating combo to a 0-100 score.
    const ratings = [lcpRating, inpRating, clsRating].filter(Boolean);
    const goodCount = ratings.filter((r) => r === 'good').length;
    const niCount   = ratings.filter((r) => r === 'needs-improvement').length;
    const poorCount = ratings.filter((r) => r === 'poor').length;

    let score;
    if (poorCount === 0 && niCount === 0) score = 90;         // all 3 good
    else if (goodCount === 2 && niCount === 1) score = 75;    // 2G 1NI
    else if (goodCount === 1 && niCount === 2) score = 55;    // 1G 2NI
    else if (goodCount === 2 && poorCount === 1) score = 60;  // 2G 1P
    else if (goodCount === 1 && niCount === 1 && poorCount === 1) score = 45; // mixed
    else if (poorCount >= 2 && goodCount > 0) score = 35;    // 2P
    else if (poorCount >= 2) score = 35;                      // 2+ poor
    else if (poorCount === 3) score = 20;                     // all poor
    else score = 45;                                          // fallback

    const value = {
      mobile_score: score,
      load_time_seconds: null,  // CrUX doesn't expose raw load time
      source: 'crux',
      lcp_ms: lcpP75,
      lcp_rating: lcpRating,
    };
    console.log(`[fetch-crux] ${origin} → score:${score} lcp:${lcpP75}ms(${lcpRating}) inp:${inpP75}ms(${inpRating}) cls:${clsP75}(${clsRating})`);
    CRUX_CACHE.set(origin, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`[fetch-crux] ${origin} failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCruxScore(websiteUrl, apiKey) {
  if (!websiteUrl || !apiKey) return null;
  try {
    const withProto = /^https?:\/\//i.test(websiteUrl) ? websiteUrl : 'https://' + websiteUrl;
    const origin    = new URL(withProto).origin;

    const result = await _queryCruxOrigin(origin, apiKey);
    if (result) return result;

    // If the origin used http://, also try https:// as a fallback.
    if (origin.startsWith('http://')) {
      const httpsOrigin = 'https://' + origin.slice('http://'.length);
      console.log(`[fetch-crux] retrying with https: ${httpsOrigin}`);
      return _queryCruxOrigin(httpsOrigin, apiKey);
    }
    return null;
  } catch (err) {
    console.warn('[fetch-crux] bad URL:', websiteUrl, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchLocationSignals (Overpass API, OpenStreetMap)
// ═══════════════════════════════════════════════════════════════════
// Combined query for anchor tenants (within 500m) + transit (within 800m)
// in a single round-trip. Hard 5s timeout; null on timeout/error.
const OVERPASS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OVERPASS_CACHE = new LRUCache({ max: 1000, ttl: OVERPASS_TTL_MS });
const ANCHOR_BRAND_RE = /\b(walmart|target|mcdonald'?s|costco|home\s*depot|lowe'?s|kroger|publix|whole foods|trader joe'?s|safeway|aldi|wegmans|sam'?s\s*club|best\s*buy)\b/i;

// Two Overpass mirrors. We try the primary first; if it returns 406 / 5xx /
// times out, we retry once on the Kumi Systems mirror. Both speak the same
// Overpass QL API.
const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
const OVERPASS_FALLBACK = 'https://overpass.kumi.systems/api/interpreter';

async function callOverpass(endpoint, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Phase 5+ hardening: some Overpass mirrors / front-ends 406 on
        // requests without an explicit Accept or with a non-branded UA.
        'Accept': 'application/json',
        'User-Agent': 'GrowthIM/1.0 (business audit tool)',
      },
      body,
      signal: ac.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Overpass HTTP ${res.status} - ${errBody.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLocationSignals(lat, lon) {
  if (lat == null || lon == null) return null;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = OVERPASS_CACHE.get(key);
  if (cached && Date.now() - cached.ts < OVERPASS_TTL_MS) {
    console.log(`[cache] overpass hit for ${key}`);
    return cached.value;
  }

  // Single Overpass QL query: anchor candidates within 500m + transit
  // candidates within 800m in a single round-trip. `out center tags;`
  // returns center coords for ways/relations and includes tags for
  // filtering.
  const query = `[out:json][timeout:5];
(
  node(around:500,${lat},${lon})[shop~"^(supermarket|department_store|mall)$"];
  way(around:500,${lat},${lon})[shop~"^(supermarket|department_store|mall)$"];
  node(around:500,${lat},${lon})[amenity=fast_food];
  way(around:500,${lat},${lon})[amenity=fast_food];
  node(around:800,${lat},${lon})[highway=bus_stop];
  node(around:800,${lat},${lon})[railway=station];
);
out center tags;`;

  const body = 'data=' + encodeURIComponent(query);
  let json;
  try {
    json = await callOverpass(OVERPASS_PRIMARY, body, 5000);
  } catch (err) {
    console.warn(`[fetch-overpass] primary failed (${err.message}); trying fallback mirror`);
    try {
      json = await callOverpass(OVERPASS_FALLBACK, body, 5000);
    } catch (err2) {
      console.warn('[fetch-overpass] fallback also failed:', err2.message);
      return null;
    }
  }
  try {
    const elements = json.elements || [];

    const anchorMap = new Map(); // name → distance
    let nearestTransit = null;

    for (const el of elements) {
      const name = (el.tags && el.tags.name) || '';
      const elLat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const elLon = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (elLat == null || elLon == null) continue;
      const distance = haversineMeters(lat, lon, elLat, elLon);
      if (distance == null) continue;

      const tags = el.tags || {};

      // Anchor tenant - name matches a known big-box brand, OR shop type
      // is supermarket/department_store/mall (those are anchors regardless
      // of name).
      const isAnchorByName = name && ANCHOR_BRAND_RE.test(name);
      const isAnchorByType = ['supermarket', 'department_store', 'mall'].includes(tags.shop);
      if ((isAnchorByName || isAnchorByType) && distance <= 500) {
        const label = name || tags.shop || tags.amenity || 'unnamed';
        if (!anchorMap.has(label) || anchorMap.get(label) > distance) {
          anchorMap.set(label, Math.round(distance));
        }
      }

      // Transit - bus stop or rail station, threshold check below.
      if (tags.highway === 'bus_stop' || tags.railway === 'station') {
        if (nearestTransit == null || distance < nearestTransit) {
          nearestTransit = distance;
        }
      }
    }

    const anchors = Array.from(anchorMap.keys()).slice(0, 10);
    const value = {
      anchor_tenants: anchors,
      anchor_tenant_count: anchors.length,
      nearest_transit_meters: nearestTransit != null ? Math.round(nearestTransit) : null,
      has_transit_nearby: nearestTransit != null && nearestTransit <= 400,
    };
    OVERPASS_CACHE.set(key, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-overpass] post-parse failed:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchBuildingPermits
// Source: U.S. Census Bureau Building Permits Survey (BPS) 2025
// ═══════════════════════════════════════════════════════════════════
// Replaces HUD ArcGIS (data frozen at 2022). Downloads Census BPS
// county annual file — plain comma-delimited text, no ZIP, no key.
//   URL: https://www2.census.gov/econ/bps/County/co{year}a.txt
//   Format: rows 0-1 = headers, row 2 = blank, rows 3+ = data
//   Col 1 = state FIPS, col 2 = county FIPS, col 5 = county name
//   Col 6 = 1-unit bldgs, 9 = 2-unit bldgs, 12 = 3-4 unit bldgs, 15 = 5+ bldgs
//
// County matching uses state_fips AND county_fips (&&) — never by name,
// so Iowa County WI (55-049) is never confused with Iowa County IA (19-093).
// Tries 2025 first; falls back to 2024 if 2025 returns no match.
// Prior year fetched alongside current year for YoY comparison.
// Cache: 30 days per FIPS.
const PERMITS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PERMITS_CACHE = new LRUCache({ max: 1000, ttl: PERMITS_TTL_MS });

const BPS_BASE = 'https://www2.census.gov/econ/bps/County/';
const CENSUS_GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/address';

// Pull street / city / state out of a Google formatted_address string.
// Handles "<street>, <city>, <ST> <zip>[-zip4][, USA]" - same shape as
// claudeEnricher's parseAddress but kept local to avoid a cross-module
// dependency.
function parseAddressForGeocoder(formatted) {
  if (!formatted || typeof formatted !== 'string') return { street: null, city: null, state: null };
  const trimmed = formatted.replace(/, USA$/, '');
  const m = trimmed.match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?$/);
  if (!m) return { street: null, city: null, state: null };
  return { street: m[1].trim(), city: m[2].trim(), state: m[3] };
}

async function fetchCountyFIPS(street, city, state) {
  if (!street || !city || !state) return null;
  const params = new URLSearchParams({
    street, city, state,
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    layers: 'Counties',
    format: 'json',
  });
  const url = `${CENSUS_GEOCODER_URL}?${params.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Census geocoder HTTP ${res.status}`);
    const json = await res.json();
    const matches = json && json.result && json.result.addressMatches;
    if (!Array.isArray(matches) || !matches.length) {
      console.warn(`[fetch-permits] geocoder no match for "${street}, ${city}, ${state}"`);
      return null;
    }
    const counties = matches[0].geographies && matches[0].geographies.Counties;
    if (!Array.isArray(counties) || !counties.length) {
      console.warn('[fetch-permits] geocoder match has no Counties layer');
      return null;
    }
    const fips = counties[0].GEOID;
    if (!/^\d{5}$/.test(fips || '')) {
      console.warn(`[fetch-permits] unexpected GEOID shape: "${fips}"`);
      return null;
    }
    return fips;
  } catch (err) {
    console.warn('[fetch-permits] geocoder failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Parse a Census BPS county annual text file into an array of row objects.
// Skips the 2-row header block and the blank separator line (rows 0-2).
// Column layout (0-based, from the BPS file spec):
//   0=year  1=state_fips  2=county_fips  3=region  4=division  5=county_name
//   6=1-unit bldgs  9=2-unit bldgs  12=3-4-unit bldgs  15=5+-unit bldgs
function parseBpsFile(text) {
  const lines = text.split('\n');
  // Rows 0-1 are group/sub-headers; row 2 is blank; rows 3+ are data.
  const dataText = lines.slice(3).join('\n');
  const rows = parseCsv(dataText, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  return rows.map((r) => {
    const bldgs1  = parseInt(r[6],  10) || 0;
    const bldgs2  = parseInt(r[9],  10) || 0;
    const bldgs34 = parseInt(r[12], 10) || 0;
    const bldgs5p = parseInt(r[15], 10) || 0;
    return {
      year:              (r[0] || '').trim(),
      state_fips:        (r[1] || '').trim().padStart(2, '0'),
      county_fips:       (r[2] || '').trim().padStart(3, '0'),
      county_name:       (r[5] || '').trim(),
      bldgs_1unit:       bldgs1,
      bldgs_2unit:       bldgs2,
      bldgs_34unit:      bldgs34,
      bldgs_5plus:       bldgs5p,
      total_bldgs:       bldgs1 + bldgs2 + bldgs34 + bldgs5p,
      multifamily_bldgs: bldgs2 + bldgs34 + bldgs5p,
    };
  });
}

// Fetch and parse one year's Census BPS county file.
// Returns null on network failure, timeout, or HTTP error — never throws.
async function fetchBpsYear(year) {
  const url = `${BPS_BASE}co${year}a.txt`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GrowthIM/1.0 (Census BPS fetch)' },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-permits] Census BPS ${year} HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    if (!text || text.length < 200) {
      console.warn(`[fetch-permits] Census BPS ${year} returned empty body`);
      return null;
    }
    return parseBpsFile(text);
  } catch (err) {
    console.warn(`[fetch-permits] Census BPS ${year} failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuildingPermits(countyFIPS) {
  if (!countyFIPS || !/^\d{5}$/.test(countyFIPS)) return null;

  const cached = PERMITS_CACHE.get(countyFIPS);
  if (cached && Date.now() - cached.ts < PERMITS_TTL_MS) {
    console.log(`[cache] permits hit for FIPS ${countyFIPS}`);
    return cached.value;
  }

  // Split 5-digit FIPS into state (first 2 digits) + county (last 3 digits).
  // Both must match (&&) so Iowa County WI (55-049) is never confused with
  // Iowa County IA (19-093) or any other same-named county in a different state.
  const stateFips  = countyFIPS.slice(0, 2);
  const countyFips = countyFIPS.slice(2);
  const findCounty = (r) => r.state_fips === stateFips && r.county_fips === countyFips;

  // Try 2025 first; fall back to 2024 if the file is missing or the county
  // row is absent (some small counties report late).
  let rows = await fetchBpsYear('2025');
  let currentYear = '2025';
  let priorYear   = '2024';

  if (!rows || !rows.find(findCounty)) {
    console.log(`[fetch-permits] FIPS ${countyFIPS} not in BPS 2025 — trying 2024`);
    rows = await fetchBpsYear('2024');
    currentYear = '2024';
    priorYear   = '2023';
    if (!rows) return null;
  }

  const current = rows.find(findCounty);
  if (!current) {
    console.warn(`[fetch-permits] FIPS ${countyFIPS} not found in Census BPS data`);
    return null;
  }

  // Fetch prior year for YoY comparison. Failure is non-fatal.
  const priorRows = await fetchBpsYear(priorYear);
  const prior     = priorRows ? priorRows.find(findCounty) : null;

  // YoY change as a percentage. Null when prior is missing or zero.
  let yoyPct = null;
  if (prior && prior.total_bldgs > 0) {
    yoyPct = +(((current.total_bldgs - prior.total_bldgs) / prior.total_bldgs) * 100).toFixed(1);
  }

  const value = {
    county_fips:                       countyFIPS,
    county_name:                       current.county_name || null,
    state_abbr:                        null,
    state_name:                        null,
    building_permits_total:            current.total_bldgs,
    building_permits_single_family:    current.bldgs_1unit,
    building_permits_multifamily:      current.multifamily_bldgs,
    building_permits_year:             currentYear,
    building_permits_prior_year:       prior ? priorYear : null,
    building_permits_prior_year_total: prior ? prior.total_bldgs : null,
    building_permits_yoy_change:       yoyPct,
  };
  console.log(`[fetch-permits] Census BPS ${currentYear}: FIPS ${countyFIPS} | total=${value.building_permits_total} sf=${value.building_permits_single_family} yoy=${yoyPct ?? 'n/a'}%`);
  PERMITS_CACHE.set(countyFIPS, { ts: Date.now(), value });
  return value;
}

// Caller convenience: take a Google formatted_address, do geocoding +
// permits in sequence. Returns the same shape as fetchBuildingPermits()
// (or null if either step fails).
async function fetchBuildingPermitsByAddress(formattedAddress) {
  const { street, city, state } = parseAddressForGeocoder(formattedAddress);
  if (!street || !city || !state) {
    console.warn('[fetch-permits] could not parse address:', formattedAddress);
    return null;
  }
  const fips = await fetchCountyFIPS(street, city, state);
  if (!fips) return null;
  return fetchBuildingPermits(fips);
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchUpcomingEvents (Ticketmaster Discovery v2)
// ═══════════════════════════════════════════════════════════════════
// Returns up to 5 upcoming events within 10 miles of the business in
// the next 90 days. Used by the C4 Demand section + by Claude as
// context for seasonal opportunity ideas. Free tier: 5,000 calls/day.
// No TICKETMASTER_API_KEY set → returns []. Cache: 24h per `city,state`.
// Timeout: 8s.
const EVENTS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EVENTS_CACHE = new LRUCache({ max: 1000, ttl: EVENTS_TTL_MS });

async function fetchUpcomingEvents(city, state) {
  if (!city || !state) return [];
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) {
    // Quiet degradation when no key is configured.
    return [];
  }

  const cacheKey = `${city.toLowerCase()},${state.toLowerCase()}`;
  const cached = EVENTS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < EVENTS_TTL_MS) {
    console.log(`[cache] events hit for ${cacheKey}`);
    return cached.value;
  }

  // Date range: today → today + 90 days. Ticketmaster expects ISO 8601
  // with the literal `T00:00:00Z` time component (UTC, no offset).
  // We back the start date up by 1 day so PT-evening users (UTC = next
  // day) don't query "tomorrow UTC" and miss tonight's local events.
  const today = new Date();
  today.setDate(today.getDate() - 1);
  const end = new Date(today.getTime() + 91 * 24 * 60 * 60 * 1000);
  const fmtDay = (d) => d.toISOString().slice(0, 10);
  const startDateTime = `${fmtDay(today)}T00:00:00Z`;
  const endDateTime = `${fmtDay(end)}T00:00:00Z`;

  const params = new URLSearchParams({
    city,
    stateCode: state,
    radius: '10',
    unit: 'miles',
    startDateTime,
    endDateTime,
    size: '5',
    apikey: apiKey,
  });
  const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[fetch-events] HTTP ${res.status} - ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
      return [];
    }
    const json = await res.json();
    // Ticketmaster omits `_embedded` entirely when no events match (it
    // does NOT return an empty events array). Cache the empty result so
    // we don't hammer their API on repeat searches in dead markets.
    if (!json._embedded || !Array.isArray(json._embedded.events) || !json._embedded.events.length) {
      EVENTS_CACHE.set(cacheKey, { ts: Date.now(), value: [] });
      return [];
    }
    // Map all raw events first, then dedup by name+date before slicing.
    // Ticketmaster returns the same concert multiple times when it has
    // multiple ticket packages (e.g. general admission + VIP). Without
    // dedup, slice(0,5) includes both copies and the list shows
    // "Phish July 7" twice. Dedup by composite key name|date so each
    // unique show appears only once; still returns max 5 events.
    const rawEvents = json._embedded.events.map((ev) => ({
      name: ev.name || '(unnamed event)',
      date: (ev.dates && ev.dates.start && ev.dates.start.localDate) || null,
      venue: (ev._embedded && Array.isArray(ev._embedded.venues) && ev._embedded.venues[0] && ev._embedded.venues[0].name) || null,
      // Kept null so downstream renderers/Claude bundle don't need to
      // change shape - Ticketmaster doesn't expose attendance either.
      attendance_estimate: null,
    }));
    const seen = new Set();
    const events = [];
    for (const ev of rawEvents) {
      const key = `${ev.name}|${ev.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        events.push(ev);
      }
      if (events.length >= 5) break;
    }
    EVENTS_CACHE.set(cacheKey, { ts: Date.now(), value: events });
    return events;
  } catch (err) {
    console.warn('[fetch-events] failed:', err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchNearbyVenues (Foursquare Places API)
// ═══════════════════════════════════════════════════════════════════
// Returns up to 10 popular nearby venues across food / arts / outdoors
// within a 1km radius. Used by Claude as walkability + partnership
// context. Empty array on missing key / failure / timeout - never throws.
//
// MIGRATION (2026-05-08): the legacy api.foursquare.com/v3/places/search
// endpoint was retired and now returns HTTP 410. Migrated to the new
// places-api.foursquare.com host:
//   - Path: /places/search (was /v3/places/search)
//   - Auth: "Authorization: Bearer {key}" (was raw key, no prefix)
//   - New required header: X-Places-Api-Version: 2025-06-17
//   - Param renamed: categories → fsq_category_ids
//   - Category IDs are now UUIDs (top-level), not numeric (13000/10000/16000)
//   - Response: r.categories[0].fsq_category_id (was .id); popularity dropped
const FOURSQUARE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FOURSQUARE_CACHE = new LRUCache({ max: 1000, ttl: FOURSQUARE_TTL_MS });

// Top-level Foursquare category UUIDs.
// (Numeric short IDs from the old v3 API don't work on the new host.)
const FSQ_CATEGORIES = [
  '4d4b7105d754a06374d81259', // Food
  '4d4b7104d754a06370d81259', // Arts & Entertainment
  '4d4b7105d754a06376d81259', // Outdoors & Recreation
].join(',');

// Map a Foursquare top-level category UUID prefix → coarse bucket.
// Falls back to the actual category name from the response (e.g. "Coffee
// Shop"), which is what Claude actually wants for partnership ideas.
const FSQ_TOP_CATEGORY_LABEL = {
  '4d4b7105d754a06374d81259': 'food_and_drink',
  '4d4b7104d754a06370d81259': 'arts_and_entertainment',
  '4d4b7105d754a06376d81259': 'outdoors_and_landmarks',
};

function fsqCategoryLabel(catId, fallbackName) {
  if (catId && FSQ_TOP_CATEGORY_LABEL[catId]) return FSQ_TOP_CATEGORY_LABEL[catId];
  return fallbackName || 'other';
}

// isVenueOpen - Google cross-check for a Foursquare venue.
// Runs a single Text Search and inspects business_status on the top
// hit. Returns:
//   true   - Google confirms operational (or status field absent)
//   false  - Google confirms closed permanently / temporarily, OR
//            the venue has no Google hit at all (likely de-indexed)
//   null   - UNKNOWN: both attempts failed (timeout / 5xx / network).
//            Caller treats null as "keep the venue" so a transient
//            Google outage doesn't silently drop the whole venue list.
//
// Audit fix DF1 + DF2:
//   1. 1-hour in-memory LRU cache keyed by name+address - repeat
//      lookups for the same venue inside the same hour skip Google.
//   2. 2-attempt retry: 8 s timeout per attempt, 2 s backoff between.
//   3. AbortController on every fetch (the previous bare `await fetch`
//      had no timeout and a hung Google socket pinned the worker).
//   4. res.ok / res.json() failures are caught - no raw JSON.parse
//      crashes on a 5xx HTML response.
//   5. Unknown state returned distinctly so the caller can keep the
//      venue rather than fail-open by accident.
// Cost note: ~$0.032 per Text Search call. Caller throttles to 200 ms
// between calls to avoid rate limits.
const VENUE_OPEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const VENUE_OPEN_CACHE = new LRUCache({ max: 1000, ttl: VENUE_OPEN_TTL_MS });

async function isVenueOpen(venueName, venueAddress, apiKey) {
  const cacheKey = (String(venueName || '') + '|' + String(venueAddress || '')).toLowerCase();
  const cached = VENUE_OPEN_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const query = venueName + ' ' + venueAddress;
  const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
    + '?query=' + encodeURIComponent(query)
    + '&key=' + apiKey;

  async function tryOnce() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json().catch(() => null);
      if (!data) throw new Error('non-JSON response');
      const place = data.results && data.results[0];
      if (!place) return false; // de-indexed = treat as closed
      const status = place.business_status;
      if (status === 'PERMANENTLY_CLOSED' || status === 'CLOSED_PERMANENTLY') {
        console.log('[venues] Google confirms CLOSED:', venueName);
        return false;
      }
      if (status === 'CLOSED_TEMPORARILY') {
        console.log('[venues] Google confirms TEMP CLOSED:', venueName);
        return false;
      }
      return true; // OPERATIONAL or status field absent
    } finally {
      clearTimeout(timer);
    }
  }

  let result;
  try {
    result = await tryOnce();
  } catch (e1) {
    console.warn('[venues] attempt 1 failed for', venueName, '- retrying in 2 s:', e1.message);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      result = await tryOnce();
    } catch (e2) {
      console.warn('[venues] attempt 2 also failed for', venueName, '- returning UNKNOWN:', e2.message);
      // Do not cache the unknown state - next call should retry.
      return null;
    }
  }

  VENUE_OPEN_CACHE.set(cacheKey, result);
  return result;
}

async function fetchNearbyVenues(lat, lon) {
  if (lat == null || lon == null) return [];
  const apiKey = process.env.FOURSQUARE_API_KEY;
  if (!apiKey) return [];

  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = FOURSQUARE_CACHE.get(key);
  if (cached && Date.now() - cached.ts < FOURSQUARE_TTL_MS) {
    console.log(`[cache] foursquare hit for ${key}`);
    return cached.value;
  }

  // Request `closed_bucket`, `hours`, and `location` explicitly - these
  // are non-default fields on the new Foursquare /places/search endpoint.
  // `closed_bucket` powers STEP 1 (free cheap filter); `location.address`
  // is needed by STEP 2 (Google cross-check) to disambiguate names like
  // "Hills Pub" that exist in multiple cities.
  const params = new URLSearchParams({
    ll: `${lat},${lon}`,
    radius: '1000',
    fsq_category_ids: FSQ_CATEGORIES,
    limit: '10',
    sort: 'POPULARITY',
    fields: 'name,categories,distance,location,hours',
  });
  const url = `https://places-api.foursquare.com/places/search?${params.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: {
        // New Places API requires Bearer prefix (legacy v3 didn't).
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        // Pinned API version per Foursquare's required header.
        'X-Places-Api-Version': '2025-06-17',
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[fetch-venues] HTTP ${res.status} - ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
      return [];
    }
    const json = await res.json();
    const rawResults = Array.isArray(json.results) ? json.results : [];

    // ── STEP 1 - Foursquare closed_bucket filter (free, no API cost). ──
    // Foursquare's `closed_bucket` is its own closure heuristic. Drop
    // the most-confident closed buckets BEFORE we spend Google quota
    // verifying them. Venues with bucket absent/unknown pass through
    // to STEP 2 for the Google cross-check.
    const fsqOpen = rawResults.filter((r) => {
      const bucket = r.closed_bucket;
      if (bucket === 'VeryLikelyClosed' || bucket === 'LikelyClosed') {
        console.log(
          '[foursquare] filtered closed:',
          r.name,
          '| closed_bucket:',
          r.closed_bucket
        );
        return false;
      }
      return true;
    });

    // ── STEP 2 - Google cross-check on survivors. ──
    // One Text Search per venue, 200ms gap between calls to avoid the
    // Places API rate limit (~50 QPS, but we share quota with the
    // competitor + findPlace pipelines). On a network error we keep
    // the venue (conservative - fail-open rather than drop a real
    // venue because of a transient blip).
    const googleKey = process.env.GOOGLE_PLACES_API_KEY;
    const verifiedVenues = [];
    if (!googleKey) {
      console.error('[fetch-venues] no GOOGLE_PLACES_API_KEY - cannot verify venues; dropping all nearby venues this run');
      // push nothing: unverified venues must not appear
    } else {
      for (let i = 0; i < fsqOpen.length; i++) {
        const r = fsqOpen[i];
        const addr = (r.location && r.location.address) || '';
        let open = true;
        try {
          open = await isVenueOpen(r.name, addr, googleKey);
        } catch (err) {
          console.warn('[venues] verify error for', r.name, ':', err.message);
          open = null; // unknown - treat as keep
        }
        // Audit fix DF1/DF2 - isVenueOpen now returns true/false/null.
        // Only an EXPLICIT false drops the venue; both true (open) and
        // null (UNKNOWN - both Google attempts failed) keep it, so a
        // transient Google outage can't silently empty the venue list.
        if (open === true) verifiedVenues.push(r);
        // 200ms inter-call delay (skip on the last iteration).
        if (i < fsqOpen.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }

    // Shape verified venues for the data bundle (unchanged from before).
    const venuesRaw = verifiedVenues.map((r) => {
      const primaryCat = (Array.isArray(r.categories) && r.categories[0]) || {};
      // Each category now has fsq_category_id (was: id) plus a name field.
      // The new API doesn't expose `popularity` directly - venues are
      // already ordered by popularity via sort=POPULARITY, so we keep the
      // field for back-compat but set it to null.
      return {
        name: r.name || '(unnamed venue)',
        category: fsqCategoryLabel(primaryCat.fsq_category_id, primaryCat.name),
        distance_meters: typeof r.distance === 'number' ? r.distance : null,
        popularity: null,
      };
    });
    // Dedupe by lowercase trimmed name so 3 Starbucks within 1km collapse
    // to one entry - partnership suggestions otherwise see the same chain
    // repeated, drowning out unique nearby businesses.
    const seenNames = new Set();
    const venues = venuesRaw.filter((v) => {
      const k = (v.name || '').toLowerCase().trim();
      if (!k || seenNames.has(k)) return false;
      seenNames.add(k);
      return true;
    });
    FOURSQUARE_CACHE.set(key, { ts: Date.now(), value: venues });
    return venues;
  } catch (err) {
    console.warn('[fetch-venues] failed:', err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchTripAdvisor (TripAdvisor Content API)
// ═══════════════════════════════════════════════════════════════════
// Three-step pipeline:
//   1. /location/search?searchQuery=… → location_id
//   2 + 3 (parallel via Promise.all):
//      /location/{id}/details → rating, ranking, subratings, awards, trip_types
//      /location/{id}/reviews?limit=3 → top 3 recent reviews
//
// Returns the merged object on success, or null if any step fails. The
// Content API requires a Referer header (their gateway 403s requests
// without one - even though docs don't mention it). Cache 24h per
// businessName + city. 8s timeout per individual call.
const TRIPADVISOR_TTL_MS = 24 * 60 * 60 * 1000;
const TRIPADVISOR_CACHE = new LRUCache({ max: 1000, ttl: TRIPADVISOR_TTL_MS });
const TA_BASE = 'https://api.content.tripadvisor.com/api/v1';
// TripAdvisor's gateway requires a Referer (or X-TripAdvisor-API-Key-…)
// header on every Content API call. Bare requests are rejected as 403.
const TA_HEADERS = { 'Accept': 'application/json', 'Referer': 'https://GrowthIM.local' };

async function fetchTripAdvisor(businessName, formattedAddress) {
  if (!businessName) return null;
  const apiKey = process.env.TRIPADVISOR_API_KEY;
  if (!apiKey) return null;

  // Cache key = name + city (case-insensitive). Address gives us city.
  const { city } = parseAddressForGeocoder(formattedAddress || '');
  const cacheKey = `${businessName.toLowerCase()}|${(city || '').toLowerCase()}`;
  const cached = TRIPADVISOR_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < TRIPADVISOR_TTL_MS) {
    console.log(`[cache] tripadvisor hit for ${cacheKey}`);
    return cached.value;
  }

  // ── Step 1: search for location_id ──
  let locationId = null;
  {
    const sp = new URLSearchParams({ key: apiKey, searchQuery: businessName });
    if (formattedAddress) sp.append('address', formattedAddress);
    const url = `${TA_BASE}/location/search?${sp.toString()}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(url, { headers: TA_HEADERS, signal: ac.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`[fetch-tripadvisor] search HTTP ${res.status} - ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
        return null;
      }
      const json = await res.json();
      const data = Array.isArray(json.data) ? json.data : [];
      if (!data.length) {
        console.warn(`[fetch-tripadvisor] no match for "${businessName}"`);
        // Cache the negative result so we don't retry every page load.
        TRIPADVISOR_CACHE.set(cacheKey, { ts: Date.now(), value: null });
        return null;
      }
      locationId = data[0].location_id;
    } catch (err) {
      console.warn('[fetch-tripadvisor] search failed:', err.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!locationId) return null;

  // ── Steps 2 + 3 in parallel: details + reviews ──
  async function taGet(path) {
    const url = `${TA_BASE}/location/${locationId}/${path}?key=${apiKey}&language=en${path === 'reviews' ? '&limit=3' : ''}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(url, { headers: TA_HEADERS, signal: ac.signal });
      if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  let details, reviews;
  try {
    [details, reviews] = await Promise.all([taGet('details'), taGet('reviews')]);
  } catch (err) {
    console.warn('[fetch-tripadvisor] details/reviews failed:', err.message);
    return null;
  }

  // ── Merge subratings (cleanliness/service/value/location/food/rooms/sleep) ──
  const subratings = {};
  if (details && details.subratings && typeof details.subratings === 'object') {
    for (const k of Object.keys(details.subratings)) {
      const sr = details.subratings[k];
      const raw = (sr && typeof sr === 'object') ? sr.value : sr;
      const num = Number(raw);
      if (!Number.isFinite(num)) continue;
      // Prefer localized_name → name → numeric key as the field label.
      const label = (sr && (sr.localized_name || sr.name)) || k;
      subratings[String(label).toLowerCase().replace(/\s+/g, '_')] = num;
    }
  }

  // ── Parse "#5 of 30 Restaurants in Chicago" → position + out_of ──
  let rankingPosition = null;
  let rankingOutOf = null;
  const rankingStr = (details && details.ranking_data && details.ranking_data.ranking_string)
    || (details && details.ranking)
    || '';
  const rm = String(rankingStr).match(/#?(\d[\d,]*)\s+of\s+(\d[\d,]*)/i);
  if (rm) {
    rankingPosition = parseInt(rm[1].replace(/,/g, ''), 10);
    rankingOutOf = parseInt(rm[2].replace(/,/g, ''), 10);
  }

  const awards = Array.isArray(details && details.awards)
    ? details.awards.slice(0, 5).map((a) => ({
        type: a.award_type || a.display_name || 'award',
        year: a.year || null,
      }))
    : [];

  const tripTypes = Array.isArray(details && details.trip_types)
    ? details.trip_types
        .map((t) => ({
          name: t.localized_name || t.name || 'unknown',
          value: typeof t.value === 'number'
            ? t.value
            : (t.value != null ? parseInt(t.value, 10) : null),
        }))
        .filter((t) => Number.isFinite(t.value))
    : [];

  const recentReviews = Array.isArray(reviews && reviews.data)
    ? reviews.data.slice(0, 3).map((r) => ({
        rating: typeof r.rating === 'number' ? r.rating : null,
        title: r.title || null,
        // Full review text - no truncation. Field is still named
        // `snippet` for back-compat with downstream consumers
        // (claudeEnricher renderer reads r.snippet); name retained,
        // contents now unabridged.
        snippet: r.text || null,
        published_date: r.published_date || null,
        trip_type: r.trip_type || null,
      }))
    : [];

  // Coerce rating + review count from whatever shape TA returned.
  const ratingRaw = details && details.rating;
  const rating = typeof ratingRaw === 'number' ? ratingRaw
    : (ratingRaw != null && Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : null);
  const reviewCountRaw = details && details.num_reviews;
  const reviewCount = typeof reviewCountRaw === 'number' ? reviewCountRaw
    : (reviewCountRaw != null && Number.isFinite(parseInt(reviewCountRaw, 10)) ? parseInt(reviewCountRaw, 10) : null);

  // Synthetic boolean for the trigger DSL (which lacks arithmetic).
  // True when TA's value subrating is meaningfully below the overall rating.
  const valueSr = subratings.value;
  const ta_value_gap_detected =
    Number.isFinite(rating) && Number.isFinite(valueSr) && valueSr < rating - 0.4;

  const value = {
    ta_location_id: locationId,
    ta_rating: rating,
    ta_review_count: reviewCount,
    ta_ranking: rankingStr || null,
    ta_ranking_position: rankingPosition,
    ta_ranking_out_of: rankingOutOf,
    ta_subratings: Object.keys(subratings).length ? subratings : null,
    ta_awards: awards.length ? awards : null,
    ta_trip_types: tripTypes.length ? tripTypes : null,
    ta_recent_reviews: recentReviews.length ? recentReviews : null,
    ta_value_gap_detected,
  };
  TRIPADVISOR_CACHE.set(cacheKey, { ts: Date.now(), value });
  return value;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchBLSEmployment (BLS Public Data API v2)
// ═══════════════════════════════════════════════════════════════════
// Sector-wide employment level for the business's NAICS-2 sector. Used
// by the C4 Demand section + Claude's local labor-market context.
//
// CES (Current Employment Statistics) National series - monthly
// employment levels reported in THOUSANDS. Stable IDs, broad coverage,
// no occupation/area dimension to worry about (unlike OEWS). The live
// API test (2026-05-08) confirmed the prior OEWS series IDs were
// rejected by BLS as "Series does not exist" - these CES IDs are the
// drop-in replacement. 30-day cache per naics2.
const BLS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BLS_CACHE = new LRUCache({ max: 1000, ttl: BLS_TTL_MS });
const BLS_SERIES_BY_NAICS2 = {
  '23':    'CES2000000001',  // Construction
  '31-33': 'CES3000000001',  // Manufacturing
  '42':    'CES4142000001',  // Wholesale Trade
  '44-45': 'CES4200000001',  // Retail Trade
  '48-49': 'CES4300000001',  // Transportation & Warehousing
  '51':    'CES5000000001',  // Information
  '52':    'CES5500000001',  // Finance & Insurance
  '53':    'CES5553000001',  // Real Estate
  '54':    'CES6054000001',  // Professional & Technical Services
  '56':    'CES6056000001',  // Admin & Waste Services
  // Split education vs healthcare. Previously both NAICS-2 keys mapped
  // to the combined CES6500000001 supersector - a dental practice and
  // a tutoring center saw identical sector-employment numbers.
  '61':    'CES6561000001',  // Education Services (private only)
  '62':    'CES6562000001',  // Health Care and Social Assistance
  '71':    'CES7071000001',  // Arts & Entertainment
  '72':    'CES7072000001',  // Accommodation & Food Services
  '81':    'CES8000000001',  // Other Services
};

async function fetchBLSEmployment(naics2) {
  if (!naics2) return null;
  const seriesId = BLS_SERIES_BY_NAICS2[naics2];
  if (!seriesId) return null;
  const apiKey = process.env.BLS_API_KEY;
  if (!apiKey) return null;

  const cached = BLS_CACHE.get(naics2);
  if (cached && Date.now() - cached.ts < BLS_TTL_MS) {
    console.log(`[cache] bls hit for naics2=${naics2}`);
    return cached.value;
  }

  const url = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
  // Dynamic year window - always pull the most recent 3 years available
  // (BLS endyear is the current calendar year; startyear two years prior).
  // The prior hardcoded '2022'-'2024' window was stale by 2026.
  const _now = new Date();
  const _endYear = String(_now.getFullYear());
  const _startYear = String(_now.getFullYear() - 2);
  const body = JSON.stringify({
    seriesid: [seriesId],
    startyear: _startYear,
    endyear: _endYear,
    registrationkey: apiKey,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body,
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-bls] HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (!json || json.status !== 'REQUEST_SUCCEEDED') {
      console.warn('[fetch-bls] non-success status:', json && json.status);
      return null;
    }
    const series = json.Results && Array.isArray(json.Results.series) && json.Results.series[0];
    const dataPoints = series && Array.isArray(series.data) && series.data;
    if (!dataPoints || !dataPoints.length) {
      console.warn('[fetch-bls] empty data array for naics2=' + naics2);
      return null;
    }
    const latest = dataPoints[0]; // BLS returns most-recent first
    const valNum = Number(latest.value);
    // CES reports monthly employment in THOUSANDS - multiply to get the
    // raw job count. `period` is "M01"-"M12" (or "M13" for annual avg);
    // we surface it verbatim per the user's "format as M{month}" spec.
    const value = {
      employment_level: Number.isFinite(valNum) ? Math.round(valNum * 1000) : null,
      employment_year: latest.year || null,
      employment_period: latest.period || null,
      naics2,
    };
    BLS_CACHE.set(naics2, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-bls] failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchUSDANASS (USDA QuickStats API)
// ═══════════════════════════════════════════════════════════════════
// Internally fetches AREA HARVESTED for CORN + SOYBEANS + WHEAT for the
// state, picks the highest by acres → top_commodity. Returns combined
// agricultural profile. ONLY meaningful for NAICS-2 = 11 (agriculture).
//
// The function signature accepts a `commodity` arg (per the user spec)
// but treats it as a hint - the cross-commodity comparison is what
// produces the "top" answer.
const USDA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USDA_CACHE = new LRUCache({ max: 1000, ttl: USDA_TTL_MS });
const USDA_COMMODITIES = ['CORN', 'SOYBEANS', 'WHEAT'];

async function _usdaFetchOne(state, commodity, apiKey) {
  const params = new URLSearchParams({
    key: apiKey,
    commodity_desc: commodity,
    state_alpha: state,
    year: '2022',
    statisticcat_desc: 'AREA HARVESTED',
    agg_level_desc: 'STATE',
    format: 'JSON',
  });
  const url = `https://quickstats.nass.usda.gov/api/api_GET/?${params.toString()}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-usda] ${commodity} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const rows = Array.isArray(json && json.data) ? json.data : [];
    if (!rows.length) return null;
    // QuickStats Value is a comma-formatted string; e.g. "5,500,000".
    const acres = Number(String(rows[0].Value || '').replace(/,/g, ''));
    return Number.isFinite(acres) ? { commodity, acres } : null;
  } catch (err) {
    console.warn(`[fetch-usda] ${commodity} failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUSDANASS(state, commodity) {
  if (!state || !/^[A-Z]{2}$/.test(state)) return null;
  const apiKey = process.env.USDA_NASS_API_KEY;
  if (!apiKey) return null;

  // Cache key includes commodity so a berry farm and a corn farm in the
  // same state don't share a cache entry - the detected commodity is now
  // queried first (it was previously ignored - broken ternary bug below).
  const cacheKey = state.toUpperCase() + '|' + (commodity || 'DEFAULT');
  const cached = USDA_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < USDA_TTL_MS) {
    console.log(`[cache] usda hit for ${cacheKey}`);
    return cached.value;
  }

  // Build the commodity list, prioritizing the detected commodity.
  // Old code was `USDA_COMMODITIES.includes(commodity) ? USDA_COMMODITIES : USDA_COMMODITIES`
  // - identical on both sides of the ternary, so `commodity` was silently
  // discarded and every farm got CORN/SOYBEANS/WHEAT (Maine blueberry farm
  // got "Top crop: CORN"). New behavior: when a non-default commodity is
  // detected (BERRIES, HONEY, MUSHROOMS, APPLES, GRAPES, PUMPKINS, etc.),
  // it runs FIRST and the comparators fill in context.
  const list = commodity
    ? [commodity, ...USDA_COMMODITIES.filter((c) => c !== commodity)]
    : USDA_COMMODITIES;
  const results = await Promise.all(
    list.map((c) => _usdaFetchOne(state.toUpperCase(), c, apiKey))
  );
  const hits = results.filter(Boolean);
  if (!hits.length) {
    console.warn(`[fetch-usda] no commodity data for state=${state}`);
    return null;
  }
  hits.sort((a, b) => b.acres - a.acres);
  const top = hits[0];
  const summary = hits.map((h) => `${h.commodity.toLowerCase()} ${h.acres.toLocaleString('en-US')} ac`).join(', ');
  const value = {
    state: state.toUpperCase(),
    top_commodity: top.commodity,
    top_commodity_acres: top.acres,
    commodities: hits,
    // farm_count not directly available from AREA HARVESTED; left null
    // so downstream renders "-" rather than fabricating a number.
    farm_count: null,
    state_ag_profile: `Top crop ${top.commodity.toLowerCase()} (${top.acres.toLocaleString('en-US')} ac harvested 2022); also: ${summary}`,
  };
  USDA_CACHE.set(cacheKey, { ts: Date.now(), value });
  return value;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchFMCSA (FMCSA QCMobile carrier safety lookup)
// ═══════════════════════════════════════════════════════════════════
// Carrier safety rating + DOT operating authority. Only meaningful for
// NAICS-2 = 48-49 (transportation & warehousing). Returns null when
// the carrier name doesn't match any DOT-registered entity.
const FMCSA_TTL_MS = 24 * 60 * 60 * 1000;
const FMCSA_CACHE = new LRUCache({ max: 1000, ttl: FMCSA_TTL_MS });

async function fetchFMCSA(businessName, state) {
  if (!businessName) return null;
  const apiKey = process.env.FMCSA_API_KEY;
  if (!apiKey) return null;

  // Scope the key by state so two same-named carriers in different states
  // don't collide (caller passes data.state). Audit: cache-integrity fix.
  const cacheKey = businessName.toLowerCase() + '|' + String(state || '').toLowerCase();
  const cached = FMCSA_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < FMCSA_TTL_MS) {
    console.log(`[cache] fmcsa hit for ${cacheKey}`);
    return cached.value;
  }

  const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/name/${encodeURIComponent(businessName)}?webKey=${apiKey}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-fmcsa] HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const arr = Array.isArray(json && json.content) ? json.content : [];
    if (!arr.length) {
      // Cache the negative result - name not in FMCSA database.
      FMCSA_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    // FMCSA wraps each result as { carrier: { ... } } inside content[].
    const carrier = arr[0].carrier || arr[0];
    const value = {
      dot_number: carrier.dotNumber || null,
      safety_rating: carrier.safetyRating || null,
      safety_rating_date: carrier.safetyRatingDate || null,
      out_of_service_date: carrier.outOfServiceDate || null,
      allowed_to_operate: carrier.allowedToOperate || null,
      carrier_operation: (carrier.carrierOperation && (carrier.carrierOperation.carrierOperationDesc || carrier.carrierOperation)) || null,
      total_drivers: typeof carrier.totalDrivers === 'number' ? carrier.totalDrivers : null,
      total_trucks: typeof carrier.totalPowerUnits === 'number' ? carrier.totalPowerUnits
        : (typeof carrier.totalTrucks === 'number' ? carrier.totalTrucks : null),
    };
    FMCSA_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-fmcsa] failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchNPIRegistry (CMS NPI Registry, no key required)
// ═══════════════════════════════════════════════════════════════════
// Healthcare provider license verification by organization name + city/state.
// Free, no auth. ONLY meaningful for NAICS-2 = 62 (health care).
const NPI_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NPI_CACHE = new LRUCache({ max: 1000, ttl: NPI_TTL_MS });

async function fetchNPIRegistry(businessName, city, state) {
  if (!businessName) return null;

  const cacheKey = `${businessName.toLowerCase()}|${(city || '').toLowerCase()}`;
  const cached = NPI_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < NPI_TTL_MS) {
    console.log(`[cache] npi hit for ${cacheKey}`);
    return cached.value;
  }

  const params = new URLSearchParams({
    version: '2.1',
    organization_name: businessName,
    limit: '1',
  });
  if (city) params.append('city', city);
  if (state) params.append('state', state);
  const url = `https://npiregistry.cms.hhs.gov/api/?${params.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-npi] HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const results = Array.isArray(json && json.results) ? json.results : [];
    if (!results.length) {
      NPI_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const r = results[0];
    const basic = r.basic || {};
    const status = basic.status || null;
    const value = {
      npi_number: r.number || null,
      provider_type: r.enumeration_type || null, // NPI-1 (individual) / NPI-2 (org)
      status,
      credential: basic.credential || null,
      authorized: status === 'A',
    };
    NPI_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-npi] failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchFairMarketRents (HUD User FMR API)
// ═══════════════════════════════════════════════════════════════════
// Two-step: list metro areas → match by state → get FMR rates.
// ONLY meaningful for NAICS-2 = 53 (real estate & rental & leasing).
//
// HUD's listMetroAreas returns objects like
//   { code: "METRO12420M12420", name: "Austin-Round Rock-Georgetown, TX MSA", state_alpha: "TX" }
// We pick the first metro whose state_alpha matches; the picked metro
// is then queried for FMR data.
//
// AUTH: HUD User API requires a Bearer token even for listMetroAreas
// (the live test confirmed 401 without one - the original spec note
// "no key needed" was wrong). Register for a free token at
// https://www.huduser.gov/portal/dataset/fmr-api.html → set HUD_API_KEY
// in .env. Without a key, this fetcher short-circuits to null.
const FMR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FMR_CACHE = new LRUCache({ max: 1000, ttl: FMR_TTL_MS });
const HUD_FMR_BASE = 'https://www.huduser.gov/hudapi/public/fmr';

async function _hudGet(url) {
  const apiKey = process.env.HUD_API_KEY;
  if (!apiKey) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'GrowthIM/1.0',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-fmr] HTTP ${res.status} on ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('[fetch-fmr] failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFairMarketRents(state, city = null) {
  if (!state || !/^[A-Z]{2}$/.test(state)) return null;
  if (!process.env.HUD_API_KEY) return null;
  // Include city in cache key so different cities in the same state
  // return distinct metros (otherwise the first call's cached metro
  // wins for the entire state for 30 days, defeating the city arg).
  const cacheKey = state.toUpperCase() + '|' + (city ? city.toLowerCase() : '');
  const cached = FMR_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < FMR_TTL_MS) {
    console.log(`[cache] fmr hit for ${cacheKey}`);
    return cached.value;
  }

  // Step 1 - list metros and pick one matching this state.
  // Live response shape (verified 2026-05-08):
  //   [{ cbsa_code: "METRO11540M11540", area_name: "Appleton, WI MSA", category: "MetroArea" }, …]
  // No state_alpha field - state is embedded in area_name as ", XX MSA"
  // (or ", XX HUD Metro FMR Area" for sub-state HUD areas). The first
  // match wins; for predictable picks consider sorting by area_name.
  const metros = await _hudGet(`${HUD_FMR_BASE}/listMetroAreas`);
  if (!metros) return null;
  const list = Array.isArray(metros) ? metros : (Array.isArray(metros.data) ? metros.data : []);
  if (!list.length) return null;

  const upper = state.toUpperCase();
  const re = new RegExp(`,\\s*${upper}\\b`);
  // First filter to in-state metros so a city-substring match doesn't
  // accidentally pick the wrong state (e.g. "Springfield" exists in many).
  const inState = list.filter((m) => typeof m.area_name === 'string' && re.test(m.area_name));
  let match = null;
  if (city && inState.length) {
    const cityLower = city.toLowerCase();
    match = inState.find((m) => m.area_name.toLowerCase().includes(cityLower));
  }
  if (!match) {
    // Fallback: first in-state metro alphabetically (preserves prior behavior).
    match = inState[0] || null;
  }
  if (!match || !match.cbsa_code) {
    console.warn(`[fetch-fmr] no metro found for state=${state}${city ? `, city=${city}` : ''}`);
    FMR_CACHE.set(cacheKey, { ts: Date.now(), value: null });
    return null;
  }

  // Step 2 - pull FMR data for the selected metro.
  // Live response shape:
  //   { data: { metro_name, area_name, counties_msa, basicdata: {
  //       Efficiency, One-Bedroom, Two-Bedroom, …, year } } }
  // (year lives INSIDE basicdata, not at the top level.)
  const fmr = await _hudGet(`${HUD_FMR_BASE}/data/${match.cbsa_code}`);
  if (!fmr) return null;
  const data = (fmr && fmr.data) || fmr;
  const basic = (data && data.basicdata) || data;
  const row = Array.isArray(basic) ? basic[0] : basic;
  if (!row) return null;
  const studio = Number(row.Efficiency);
  const oneBr = Number(row['One-Bedroom']);
  const twoBr = Number(row['Two-Bedroom']);
  const value = {
    metro_code: match.cbsa_code,
    metro_name: data.metro_name || data.area_name || match.area_name || null,
    fmr_studio: Number.isFinite(studio) ? studio : null,
    fmr_1br: Number.isFinite(oneBr) ? oneBr : null,
    fmr_2br: Number.isFinite(twoBr) ? twoBr : null,
    fmr_year: row.year || data.year || null,
  };
  FMR_CACHE.set(cacheKey, { ts: Date.now(), value });
  return value;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchFDICData (FDIC BankFind, no key required)
// ═══════════════════════════════════════════════════════════════════
// Bank financial health by name + state. Active institutions only,
// sorted by deposits descending. ONLY meaningful for community-bank /
// finance profiles.
const FDIC_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FDIC_CACHE = new LRUCache({ max: 1000, ttl: FDIC_TTL_MS });

async function fetchFDICData(businessName, state) {
  if (!businessName || !state) return null;

  const cacheKey = `${businessName.toLowerCase()}|${state.toLowerCase()}`;
  const cached = FDIC_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < FDIC_TTL_MS) {
    console.log(`[cache] fdic hit for ${cacheKey}`);
    return cached.value;
  }

  const params = new URLSearchParams({
    filters: `STALP:${state.toUpperCase()} AND ACTIVE:1`,
    fields: 'NAME,ASSET,DEP,STNAME,CITY',
    sort_by: 'DEP',
    sort_order: 'DESC',
    limit: '10',
    // FDIC's Elasticsearch-backed `search` requires field-prefixed
    // queries (`NAME:value`). A bare term spreads across all fields
    // with low relevance and routinely returns 0 hits.
    search: 'NAME:' + businessName,
    output: 'json',
  });
  const url = `https://banks.data.fdic.gov/api/institutions?${params.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-fdic] HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    // FDIC wraps results as { data: [{ data: { NAME, ... } }, ... ] }
    const items = Array.isArray(json && json.data) ? json.data : [];
    if (!items.length) {
      FDIC_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const top = items[0].data || items[0];
    // ASSET / DEP are reported in $thousands per FDIC docs; expose as-is
    // and let renderers convert to $M if they want.
    const value = {
      bank_name: top.NAME || null,
      total_deposits: typeof top.DEP === 'number' ? top.DEP : (top.DEP != null ? Number(top.DEP) : null),
      total_assets: typeof top.ASSET === 'number' ? top.ASSET : (top.ASSET != null ? Number(top.ASSET) : null),
      state: top.STNAME || null,
      city: top.CITY || null,
    };
    FDIC_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-fdic] failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - fetchGoogleTextCompetitors (Google Places Text Search)
// ═══════════════════════════════════════════════════════════════════
// Source 2 of the competitor-discovery waterfall used by
// googlePlaces.fetchNearbyCompetitors. Returns raw Places-API results
// (NOT the unified competitor shape) - caller is responsible for
// converting + dedup + subject filtering.
//
// Why this exists: Nearby Search (lat/lon based) misses places Google
// hasn't tagged with the strict `type` we passed, and rural lat/lon
// queries can return zero results. Text Search lets us combine free-
// text keywords with locality ("hotel near Dodgeville WI") and pulls
// from a different index that's better at name+place matching.
//
// Runs N synonym queries in parallel via Promise.all. Single shared
// AbortController, 8s envelope. Cache 24h per `${type}|${lat@2dec}|${lon@2dec}`.
const TEXT_COMP_TTL_MS = 24 * 60 * 60 * 1000;
const TEXT_COMP_CACHE = new LRUCache({ max: 1000, ttl: TEXT_COMP_TTL_MS });

// Spec'd type synonyms. Anything not in this map falls through to a
// generic [type, "{type} near me"] pair.
const TYPE_SYNONYMS = {
  lodging:    ['hotel', 'motel', 'inn', 'resort', 'bed and breakfast'],
  restaurant: ['restaurant', 'diner', 'cafe', 'eatery'],
  dentist:    ['dentist', 'dental clinic', 'dental office'],
  doctor:     ['doctor', 'clinic', 'medical office', 'physician'],
  gym:        ['gym', 'fitness center', 'crossfit', 'yoga studio'],
  bar:        ['bar', 'tavern', 'pub', 'brewery', 'taproom'],
};

async function fetchGoogleTextCompetitors(type, lat, lon, city, state) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !type || lat == null || lon == null) return [];

  const cacheKey = `${type}|${lat.toFixed(2)}|${lon.toFixed(2)}`;
  const cached = TEXT_COMP_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < TEXT_COMP_TTL_MS) {
    console.log(`[cache] text-competitors hit for ${cacheKey}`);
    return cached.value;
  }

  const synonyms = TYPE_SYNONYMS[type] || [type, `${type} near me`];
  // "near {city} {state}" is what gives Text Search the locality bias.
  // When city/state are absent we fall back to keyword-only - still
  // useful but less geographically anchored.
  const locality = (city && state) ? ` near ${city} ${state}` : '';
  const queries = synonyms.map((syn) => `${syn}${locality}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const perQuery = await Promise.all(queries.map(async (q) => {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json` +
        `?query=${encodeURIComponent(q)}&location=${lat},${lon}` +
        `&radius=80467&key=${apiKey}`;
      try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
          console.warn(`[fetch-text-comp] "${q}" HTTP ${res.status}`);
          return [];
        }
        const json = await res.json();
        if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
          console.warn(`[fetch-text-comp] "${q}" status=${json.status}`);
          return [];
        }
        // Drop CLOSED_PERMANENTLY / CLOSED_TEMPORARILY before returning
        // so the competitor waterfall in googlePlaces never sees them.
        const raw = Array.isArray(json.results) ? json.results : [];
        return raw.filter(isOperationalOrUnknown);
      } catch (err) {
        console.warn(`[fetch-text-comp] "${q}" failed:`, err.message);
        return [];
      }
    }));

    // Merge across synonym queries, dedup by place_id (first wins).
    const seen = new Set();
    const merged = [];
    for (const arr of perQuery) {
      for (const r of arr) {
        if (!r.place_id || seen.has(r.place_id)) continue;
        seen.add(r.place_id);
        merged.push(r);
      }
    }
    TEXT_COMP_CACHE.set(cacheKey, { ts: Date.now(), value: merged });
    return merged;
  } catch (err) {
    console.warn('[fetch-text-comp] failed:', err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - Market Analysis (Mode 2) fetcher stubs
// ═══════════════════════════════════════════════════════════════════
// Three placeholders so the /market-analysis route can wire end-to-end.
// Real implementations will follow the same pattern as the rest of this
// file (AbortController + Map cache + console.warn + null fallback).

// ── fetchCountyFIPSByCity ────────────────────────────────────────────
// Census geocoder fallback when we only have a city + state (no street).
// fetchCountyFIPS() above requires a street; this version queries the
// /geographies/address endpoint with just city + state. Returns the
// 5-digit GEOID of the matched county, or null on failure.
const FIPS_BY_CITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FIPS_BY_CITY_CACHE = new LRUCache({ max: 1000, ttl: FIPS_BY_CITY_TTL_MS });

// Coordinates-based variant - the older /geographies/address path
// 400s when called without a `street` parameter (Census requires real
// street). /geographies/coordinates takes lat/lon directly and always
// returns the containing county. lat/lon come from Google Places which
// runs before this fetcher in the /classify flow. Cache key still
// includes city+state for human readability of [cache] logs but is
// effectively a lat/lon lookup.
async function fetchCountyFIPSByCity(city, state, lat, lon) {
  if (lat == null || lon == null) {
    console.warn('[county-coords] no lat/lon - cannot resolve county');
    return null;
  }
  const cacheKey = `${city ? city.toLowerCase() : ''}|${state ? state.toLowerCase() : ''}|${(+lat).toFixed(3)},${(+lon).toFixed(3)}`;
  const cached = FIPS_BY_CITY_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < FIPS_BY_CITY_TTL_MS) {
    console.log(`[cache] fips-by-city hit for ${cacheKey}`);
    return cached.value;
  }

  const url = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates'
    + `?x=${lon}`
    + `&y=${lat}`
    + '&benchmark=Public_AR_Current'
    + '&vintage=Current_Current'
    + '&layers=Counties'
    + '&format=json';

  console.log(
    '[county-coords] resolving:', city, state,
    '| lat:', lat, 'lon:', lon
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!r.ok) {
      console.warn(`[county-coords] HTTP ${r.status} for ${city}, ${state}`);
      FIPS_BY_CITY_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const d = await r.json();
    const counties = (d && d.result && d.result.geographies && d.result.geographies.Counties) || [];
    if (!Array.isArray(counties) || counties.length === 0) {
      console.warn(`[county-coords] no county found for ${lat}, ${lon}`);
      FIPS_BY_CITY_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const fips = counties[0].GEOID;
    if (!/^\d{5}$/.test(fips || '')) {
      console.warn(`[county-coords] unexpected GEOID shape: "${fips}"`);
      FIPS_BY_CITY_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    // BASENAME is the bare county name (e.g. "Iowa"). Suffix " County"
    // to match the HUD-permits convention used elsewhere in the
    // codebase (data.county_name from building permits is typically
    // "Iowa County"). Downstream CDC and HRSA fetchers strip the
    // suffix internally either way.
    const basename = counties[0].BASENAME || counties[0].NAME || '';
    const countyName = basename
      ? (/\s+county\s*$/i.test(basename) ? basename.trim() : basename.trim() + ' County')
      : null;
    const value = { county_fips: fips, county_name: countyName };
    console.log('[county-coords] resolved:', countyName, '| FIPS:', fips);
    FIPS_BY_CITY_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.error('[county-coords] error:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── fetchZipByCity ───────────────────────────────────────────────────
// City-level Google geocodes (e.g. "Dodgeville, WI") often come back
// without a ZIP in formatted_address. Zippopotam.us is a free, no-key
// city→ZIP lookup that handles that fallback. Returns the first ZIP
// for the city or null on failure.
const ZIP_BY_CITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ZIP_BY_CITY_CACHE = new LRUCache({ max: 1000, ttl: ZIP_BY_CITY_TTL_MS });

async function fetchZipByCity(city, state) {
  if (!city || !state) return null;
  const cacheKey = `${city.toLowerCase()}|${state.toLowerCase()}`;
  const cached = ZIP_BY_CITY_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < ZIP_BY_CITY_TTL_MS) {
    console.log(`[cache] zip-by-city hit for ${cacheKey}`);
    return cached.value;
  }

  const url = `https://api.zippopotam.us/us/${encodeURIComponent(state.toLowerCase())}/${encodeURIComponent(city.toLowerCase())}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[fetch-zip-by-city] HTTP ${res.status} for ${city}, ${state}`);
      ZIP_BY_CITY_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const json = await res.json();
    const zip = json && Array.isArray(json.places) && json.places[0] && json.places[0]['post code'];
    if (!/^\d{5}$/.test(zip || '')) {
      console.warn(`[fetch-zip-by-city] no usable post code returned for ${city}, ${state}`);
      ZIP_BY_CITY_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    ZIP_BY_CITY_CACHE.set(cacheKey, { ts: Date.now(), value: zip });
    return zip;
  } catch (err) {
    console.warn('[fetch-zip-by-city] failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── fetchCountyBusinessDensity ───────────────────────────────────────
// Census County Business Patterns 2023 - fires 1 + 15 = 16 parallel
// queries against the public CBP endpoint to pull total establishments
// + per-NAICS-2 establishment counts for the queried county. Uses
// CENSUS_API_KEY when present (raises the rate limit from 500/day).
//
// Returns the shape that marketScorer.scoreMarket() expects on its
// `county_density` input: { county_fips, total_establishments, sectors[] }
// where each sector has { naics2, sector_name, estab_count, employment }.
//
// Note on multi-prefix NAICS-2 ranges: the spec'd sector list uses the
// first sub-code only ('31' for Manufacturing, '44' for Retail, '48'
// for Transportation). We canonicalize those to the scorer's range
// keys ('31-33', '44-45', '48-49') so .find((s) => s.naics2 === ...)
// in the scorer matches correctly. This undercounts the multi-prefix
// sectors slightly but keeps the gap-score signal directionally right.
const CBP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CBP_CACHE = new LRUCache({ max: 1000, ttl: CBP_TTL_MS });

const CBP_SECTORS = ['23','31','42','44','48','51','52','53','54','56','61','62','71','72','81'];
const CBP_NAICS_CANONICAL = {
  '31': '31-33', '32': '31-33', '33': '31-33',
  '44': '44-45', '45': '44-45',
  '48': '48-49', '49': '48-49',
};

async function _cbpCallOne(stateFIPS, countyCode, naicsCode) {
  const params = new URLSearchParams({
    get: 'NAICS2017_LABEL,ESTAB,EMP',
    for: `county:${countyCode}`,
    in: `state:${stateFIPS}`,
    NAICS2017: naicsCode,
  });
  if (process.env.CENSUS_API_KEY) params.append('key', process.env.CENSUS_API_KEY);
  const url = `https://api.census.gov/data/2023/cbp?${params.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'GrowthIM/1.0' },
      signal: ac.signal,
    });
    if (!res.ok) {
      // Census CBP returns 204 / 404 when the (county, NAICS) cell has
      // no data - common in small rural counties. Treat as null silently.
      if (res.status !== 204 && res.status !== 404) {
        console.warn(`[fetch-cbp] HTTP ${res.status} for naics=${naicsCode}`);
      }
      return null;
    }
    const json = await res.json();
    if (!Array.isArray(json) || json.length < 2) return null;
    const row = json[1];
    const estab = parseInt(row[1], 10);
    const emp = parseInt(row[2], 10);
    return {
      label: row[0],
      estab: Number.isFinite(estab) ? estab : null,
      employment: Number.isFinite(emp) ? emp : null,
    };
  } catch (err) {
    console.warn(`[fetch-cbp] naics=${naicsCode} failed:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCountyBusinessDensity(countyFIPS) {
  if (!countyFIPS || !/^\d{5}$/.test(countyFIPS)) return null;

  const cached = CBP_CACHE.get(countyFIPS);
  if (cached && Date.now() - cached.ts < CBP_TTL_MS) {
    console.log(`[cache] cbp hit for FIPS ${countyFIPS}`);
    return cached.value;
  }

  const stateFIPS = countyFIPS.substring(0, 2);
  const countyCode = countyFIPS.substring(2, 5);

  // 1 total + 15 per-sector calls in parallel.
  const settled = await Promise.allSettled([
    _cbpCallOne(stateFIPS, countyCode, '00'),
    ...CBP_SECTORS.map((s) => _cbpCallOne(stateFIPS, countyCode, s)),
  ]);
  const results = settled.map((r) => r.status === 'fulfilled' ? r.value : null);
  const total = results[0];
  const sectorResults = results.slice(1);

  const sectors = sectorResults
    .map((r, i) => {
      if (!r || r.estab == null) return null;
      const code = CBP_SECTORS[i];
      const canonical = CBP_NAICS_CANONICAL[code] || code;
      return {
        naics2: canonical,
        sector_name: r.label,
        estab_count: r.estab,
        employment: r.employment,
      };
    })
    .filter(Boolean);

  if (!total && !sectors.length) {
    console.warn(`[fetch-cbp] no data at all for FIPS ${countyFIPS}`);
    CBP_CACHE.set(countyFIPS, { ts: Date.now(), value: null });
    return null;
  }

  const value = {
    county_fips: countyFIPS,
    total_establishments: total ? total.estab : null,
    sectors,
  };
  CBP_CACHE.set(countyFIPS, { ts: Date.now(), value });
  return value;
}

// ── fetchCensusAgeProfile ────────────────────────────────────────────
// Census ACS 5-year 2022 age-bucket query for a ZCTA. Pulls 21 sex/age
// variables in one round-trip, sums them into 65+/<18/working-age
// shares, and labels the resulting age profile.
//
// Threshold rules (per spec):
//   pct_65_plus > 0.20 → "elderly-skewed"
//   pct_under18 > 0.28 → "young-family"
//   pct_working > 0.65 → "working-age"
//   else               → "balanced"
const AGE_PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AGE_PROFILE_CACHE = new LRUCache({ max: 1000, ttl: AGE_PROFILE_TTL_MS });

const ACS_AGE_VARS = [
  'B01001_001E',                                      // total
  'B01001_003E','B01001_004E','B01001_005E','B01001_006E',           // male <18
  'B01001_020E','B01001_021E','B01001_022E','B01001_023E','B01001_024E','B01001_025E', // male 65+
  'B01001_027E','B01001_028E','B01001_029E','B01001_030E',           // female <18
  'B01001_044E','B01001_045E','B01001_046E','B01001_047E','B01001_048E','B01001_049E', // female 65+
];

function _sumAcsRange(headers, row, names) {
  let sum = 0;
  for (const n of names) {
    const idx = headers.indexOf(n);
    if (idx === -1) continue;
    const v = cleanCensusValue(row[idx]);
    if (typeof v === 'number') sum += v;
  }
  return sum;
}

async function fetchCensusAgeProfile(zip) {
  if (!zip || !/^\d{5}$/.test(zip)) return null;
  const cached = AGE_PROFILE_CACHE.get(zip);
  if (cached && Date.now() - cached.ts < AGE_PROFILE_TTL_MS) {
    console.log(`[cache] age-profile hit for ${zip}`);
    return cached.value;
  }

  const json = await _fetchAcsJson(
    '?get=' + ACS_AGE_VARS.join(',') + '&for=zip+code+tabulation+area:' + zip,
    5000
  );
  if (!json) return null;
  try {
    if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) {
      return null;
    }
    const headers = json[0];
    const row = json[1];

    const total = cleanCensusValue(row[headers.indexOf('B01001_001E')]);
    if (!total || total <= 0) return null;

    const male_under18  = _sumAcsRange(headers, row, ['B01001_003E','B01001_004E','B01001_005E','B01001_006E']);
    const female_under18 = _sumAcsRange(headers, row, ['B01001_027E','B01001_028E','B01001_029E','B01001_030E']);
    const male_65_plus   = _sumAcsRange(headers, row, ['B01001_020E','B01001_021E','B01001_022E','B01001_023E','B01001_024E','B01001_025E']);
    const female_65_plus = _sumAcsRange(headers, row, ['B01001_044E','B01001_045E','B01001_046E','B01001_047E','B01001_048E','B01001_049E']);

    const pct_65_plus = (male_65_plus + female_65_plus) / total;
    const pct_under18 = (male_under18 + female_under18) / total;
    const pct_working_age = 1 - pct_65_plus - pct_under18;

    let age_profile;
    if (pct_65_plus > 0.20) age_profile = 'elderly-skewed';
    else if (pct_under18 > 0.28) age_profile = 'young-family';
    else if (pct_working_age > 0.65) age_profile = 'working-age';
    else age_profile = 'balanced';

    const value = {
      zip,
      total_population: total,
      pct_65_plus: +pct_65_plus.toFixed(3),
      pct_under18: +pct_under18.toFixed(3),
      pct_working_age: +pct_working_age.toFixed(3),
      age_profile,
    };
    AGE_PROFILE_CACHE.set(zip, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[fetch-age] post-parse failed:', err.message);
    return null;
  }
}

async function fetchWalkScore(/* lat, lon, address */) {
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - 5 more keyless / free-key extensions
// ═══════════════════════════════════════════════════════════════════
// All five fail gracefully (return null) on missing key / HTTP error /
// parse error / timeout. Each is sector-scoped at the call site
// (server.js decides when to fire). 30-day in-memory caches keyed by
// the natural identity of the input.

// ─── fetchFoodData - USDA FoodData Central (key required) ─────────
// Returns up to 5 foods matching `query` (cuisine name, ingredient,
// menu item) with calories + protein. Used by restaurant / grocery
// sectors for menu-planning and nutritional-positioning ideas.
const FOODDATA_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FOODDATA_CACHE = new LRUCache({ max: 1000, ttl: FOODDATA_TTL_MS });

async function fetchFoodData(query) {
  const key = process.env.FOODDATA_API_KEY;
  if (!key || !query) return null;
  const cacheKey = String(query).toLowerCase();
  const cached = FOODDATA_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < FOODDATA_TTL_MS) {
    console.log(`[cache] fooddata hit for ${cacheKey}`);
    return cached.value;
  }
  try {
    const url =
      'https://api.nal.usda.gov' +
      '/fdc/v1/foods/search' +
      '?query=' + encodeURIComponent(query) +
      '&pageSize=5' +
      '&api_key=' + key;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[fooddata] HTTP ${r.status} for query: ${query}`);
      FOODDATA_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const d = await r.json();
    const foods = (d.foods || []).slice(0, 5).map((f) => {
      const nutrients = Array.isArray(f.foodNutrients) ? f.foodNutrients : [];
      const energy = nutrients.find((n) => n.nutrientName === 'Energy');
      const protein = nutrients.find((n) => n.nutrientName === 'Protein');
      return {
        name: f.description,
        calories: energy ? energy.value : null,
        protein: protein ? protein.value : null,
        category: f.foodCategory || null,
      };
    });
    console.log('[fooddata] found', foods.length, 'foods for:', query);
    const value = foods.length > 0 ? foods : null;
    FOODDATA_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e) {
    console.error('[fooddata] error:', e.message);
    return null;
  }
}

// ─── fetchOpenFoodFacts - Open Food Facts (no key) ────────────────
// Crowd-sourced food product database. Returns up to 5 products
// matching `query` with name, categories, Nutri-Score, ingredients.
// Used by restaurant / grocery sectors for menu / merchandising ideas.
// User-Agent header is required by Open Food Facts policy.
const OFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OFF_CACHE = new LRUCache({ max: 1000, ttl: OFF_TTL_MS });

async function fetchOpenFoodFacts(query) {
  if (!query) return null;
  const cacheKey = String(query).toLowerCase();
  const cached = OFF_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < OFF_TTL_MS) {
    console.log(`[cache] openfoodfacts hit for ${cacheKey}`);
    return cached.value;
  }
  try {
    // Open Food Facts retired the legacy /cgi/search.pl endpoint; the
    // /api/v2/search route is the supported replacement. Response shape
    // (d.products[]) and field names (product_name, nutriscore_grade,
    // categories, ingredients_text) are unchanged.
    const url =
      'https://world.openfoodfacts.org' +
      '/api/v2/search' +
      '?search_terms=' + encodeURIComponent(query) +
      '&fields=product_name,nutriscore_grade,categories,ingredients_text' +
      '&page_size=5' +
      '&json=true';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'GrowthIM/1.0 (business intelligence tool)' },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[openfoodfacts] HTTP ${r.status} for query: ${query}`);
      OFF_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const d = await r.json();
    const products = (d.products || [])
      .slice(0, 5)
      .map((p) => ({
        name: p.product_name,
        categories: p.categories || null,
        nutriscore: p.nutriscore_grade || null,
        ingredients: (p.ingredients_text || '').slice(0, 200),
      }))
      .filter((p) => p.name);
    console.log('[openfoodfacts] found', products.length, 'products for:', query);
    const value = products.length > 0 ? products : null;
    OFF_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e) {
    console.error('[openfoodfacts] error:', e.message);
    return null;
  }
}

// ─── fetchDatamuse - Datamuse (no key) ────────────────────────────
// "Means like" lookup - returns up to 10 words/phrases semantically
// related to the input word. Used across all sectors for naming
// (menu items, promotions, campaign names) brainstorming context.
const DATAMUSE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DATAMUSE_CACHE = new LRUCache({ max: 1000, ttl: DATAMUSE_TTL_MS });

async function fetchDatamuse(word) {
  if (!word) return null;
  const cacheKey = String(word).toLowerCase();
  const cached = DATAMUSE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < DATAMUSE_TTL_MS) {
    console.log(`[cache] datamuse hit for ${cacheKey}`);
    return cached.value;
  }
  try {
    const url =
      'https://api.datamuse.com/words' +
      '?ml=' + encodeURIComponent(word) +
      '&max=10';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[datamuse] HTTP ${r.status} for word: ${word}`);
      DATAMUSE_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const d = await r.json();
    const words = (Array.isArray(d) ? d : []).slice(0, 10).map((w) => w.word);
    console.log('[datamuse] found', words.length, 'related words for:', word);
    const value = words.length > 0 ? words : null;
    DATAMUSE_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e) {
    console.error('[datamuse] error:', e.message);
    return null;
  }
}

// ─── fetchNearbyParks - National Park Service (key required) ──────
// Returns up to 10 federal parks in the state with name, designation,
// description, URL, entrance fee. Used by hotel / restaurant / retail
// sectors for partnership / package framing.
const NPS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NPS_CACHE = new LRUCache({ max: 1000, ttl: NPS_TTL_MS });

async function fetchNearbyParks(stateCode) {
  const key = process.env.NPS_API_KEY;
  if (!key || !stateCode) return null;
  const cacheKey = String(stateCode).toUpperCase();
  const cached = NPS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < NPS_TTL_MS) {
    console.log(`[cache] nps hit for ${cacheKey}`);
    return cached.value;
  }
  try {
    const url =
      'https://developer.nps.gov' +
      '/api/v1/parks' +
      '?stateCode=' + encodeURIComponent(cacheKey) +
      '&limit=10' +
      '&api_key=' + key;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[nps] HTTP ${r.status} for ${cacheKey}`);
      NPS_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const d = await r.json();
    const parks = (d.data || []).map((p) => ({
      name: p.fullName,
      designation: p.designation,
      description: (p.description || '').slice(0, 300),
      url: p.url,
      entrance_fee: (p.entranceFees && p.entranceFees[0] && p.entranceFees[0].cost) || '0.00',
      visitors: null,
    }));
    console.log('[nps] found', parks.length, 'parks in', cacheKey);
    const value = parks.length > 0 ? parks : null;
    NPS_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e) {
    console.error('[nps] error:', e.message);
    return null;
  }
}

// ─── fetchNOAAClimate - NOAA Climate Data Online (key required) ───
// Two-step: find the closest weather station to lat/lon, then pull
// annual-average-temperature climate normals for that station. Used
// across all sectors as long-term-validated seasonality context (more
// authoritative than the rolling 12-month Open-Meteo signal).
// Auth: NOAA CDO uses the `token` header (NOT `Authorization: Bearer`).
const NOAA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOAA_CACHE = new LRUCache({ max: 1000, ttl: NOAA_TTL_MS });

async function fetchNOAAClimate(lat, lon) {
  const key = process.env.NOAA_API_KEY;
  if (!key || lat == null || lon == null) return null;
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = NOAA_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < NOAA_TTL_MS) {
    console.log(`[cache] noaa hit for ${cacheKey}`);
    return cached.value;
  }
  try {
    // STEP 1 - nearest station inside a ~55km bounding box.
    const stationUrl =
      'https://www.ncdc.noaa.gov' +
      '/cdo-web/api/v2/stations' +
      '?extent=' + (lat - 0.5) + ',' + (lon - 0.5) + ',' + (lat + 0.5) + ',' + (lon + 0.5) +
      '&datasetid=GHCND' +
      '&limit=1';
    const ac1 = new AbortController();
    const t1 = setTimeout(() => ac1.abort(), 5000);
    const sr = await fetch(stationUrl, { headers: { token: key }, signal: ac1.signal });
    clearTimeout(t1);
    if (!sr.ok) {
      console.warn(`[noaa] station HTTP ${sr.status}`);
      NOAA_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const sd = await sr.json();
    const station = sd.results && sd.results[0];
    if (!station) {
      NOAA_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    // STEP 2 - annual avg-temp normals for the picked station.
    const climateUrl =
      'https://www.ncdc.noaa.gov' +
      '/cdo-web/api/v2/data' +
      '?datasetid=NORMAL_ANN' +
      '&stationid=' + encodeURIComponent(station.id) +
      '&datatypeid=ANN-TAVG-NORMAL' +
      '&startdate=2010-01-01' +
      '&enddate=2010-12-31' +
      '&limit=12';
    const ac2 = new AbortController();
    const t2 = setTimeout(() => ac2.abort(), 5000);
    const cr = await fetch(climateUrl, { headers: { token: key }, signal: ac2.signal });
    clearTimeout(t2);
    if (!cr.ok) {
      console.warn(`[noaa] climate HTTP ${cr.status}`);
      NOAA_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const cd = await cr.json();
    // NOAA reports tenths of a degree F; divide by 10 to get plain °F.
    const normals = (cd.results || []).map((r) => ({
      date: r.date,
      avg_temp: r.value / 10,
    }));
    console.log('[noaa] found', normals.length, 'climate records for', station.name);
    const value = { station_name: station.name, normals };
    NOAA_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e) {
    console.error('[noaa] error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5+ - 4 free-API extensions (no API keys required)
// ═══════════════════════════════════════════════════════════════════
// All four fail gracefully (return null) on HTTP error / parse error /
// timeout so a missing or down endpoint never blocks the /classify
// pipeline. Each one is sector-scoped at the call site (server.js
// decides when to fire each based on NAICS prefix); this file only
// exposes the fetchers.

// ─── fetchCDCPlaces - CDC PLACES (Socrata, no key) ────────────────
// Returns local health metrics (dental visits, obesity, smoking,
// diabetes, physical inactivity, depression) for a city. Used by
// healthcare / fitness / restaurant sectors to identify underserved
// populations.
const CDC_PLACES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CDC_PLACES_CACHE = new LRUCache({ max: 1000, ttl: CDC_PLACES_TTL_MS });

async function fetchCDCPlaces(city, state, county) {
  if (!state) return null;
  if (!city && !county) return null;

  // Prefer the county-level dataset (swc5-untb) when we have a county
  // name - it covers EVERY county nationwide, including small towns
  // (Dodgeville/Iowa County) that the city-level dataset (cwsq-ngmh)
  // drops because it only covers 50k+ populated places. Falls back to
  // the city-level query when county is empty.
  const useCounty = !!county;
  const cacheKey = useCounty
    ? `county|${state.toLowerCase()}|${county.toLowerCase()}`
    : `city|${state.toLowerCase()}|${city.toLowerCase()}`;
  const cached = CDC_PLACES_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CDC_PLACES_TTL_MS) {
    console.log(`[cache] cdc-places hit for ${cacheKey}`);
    return cached.value;
  }
  try {
    // Strip a trailing " County" suffix on the input (the county-level
    // dataset stores names without that suffix, e.g. "Iowa" not
    // "Iowa County"). Some upstream sources include it; some don't.
    const countyClean = useCounty
      ? String(county).replace(/\s+county\s*$/i, '').trim()
      : '';
    const url = useCounty
      ? 'https://chronicdata.cdc.gov' +
        '/resource/swc5-untb.json' +
        '?stateabbr=' + encodeURIComponent(state) +
        '&countyname=' + encodeURIComponent(countyClean) +
        '&$limit=50'
      : 'https://chronicdata.cdc.gov' +
        '/resource/cwsq-ngmh.json' +
        '?cityname=' + encodeURIComponent(city) +
        '&stateabbr=' + encodeURIComponent(state) +
        '&$limit=50';

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[cdc-places] HTTP ${r.status} for ${useCounty ? countyClean + ' County' : city}, ${state}`);
      CDC_PLACES_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const d = await r.json();
    if (!Array.isArray(d) || d.length === 0) {
      CDC_PLACES_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    // Extract key health metrics - substring-match on measureid so
    // we tolerate slight name variations across PLACES releases AND
    // between the city-level (cwsq-ngmh) and county-level (swc5-untb)
    // datasets, which share the same measure naming convention.
    const metrics = {};
    d.forEach((row) => {
      const measure = (row.measureid || '').toLowerCase();
      const value = parseFloat(row.data_value);
      if (isNaN(value)) return;
      if (measure.includes('dental')) metrics.dental_visit_rate = value;
      if (measure.includes('obesity')) metrics.obesity_rate = value;
      if (measure.includes('physical')) metrics.physical_inactivity = value;
      if (measure.includes('smoking')) metrics.smoking_rate = value;
      if (measure.includes('diabetes')) metrics.diabetes_rate = value;
      if (measure.includes('depression')) metrics.depression_rate = value;
    });
    console.log(
      '[cdc-places]', useCounty ? `${countyClean} County` : city, state,
      '→', Object.keys(metrics).length, 'metrics found',
      useCounty ? '(county-level)' : '(city-level)'
    );
    const value = Object.keys(metrics).length > 0 ? metrics : null;
    CDC_PLACES_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e) {
    console.error('[cdc-places] error:', e.message);
    return null;
  }
}

// ─── fetchHRSADental - HRSA Dental HPSA lookup (no key) ───────────
// Returns whether an address sits inside a dental Health Professional
// Shortage Area and the HPSA score. Fires only for NAICS 6212 (dental
// practices) since the data is dental-specific. A positive result is
// the headline opportunity (HRSA loan-forgiveness eligibility).
const HRSA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HRSA_CACHE = new LRUCache({ max: 1000, ttl: HRSA_TTL_MS });

async function fetchHRSADental(state, county) {
  if (!state || !county) return null;
  // Strip a trailing " County" suffix on the input - HRSA's ArcGIS
  // layer stores county names without that suffix.
  const countyClean = String(county).replace(/\s+county\s*$/i, '').trim();
  if (!countyClean) return null;

  const cacheKey = `${state.toLowerCase()}|${countyClean.toLowerCase()}`;
  const cached = HRSA_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < HRSA_TTL_MS) {
    console.log(`[cache] hrsa-dental hit for ${cacheKey}`);
    return cached.value;
  }
  try {
    // HRSA migrated their HPSA data to ArcGIS FeatureServer (the old
    // datawarehouse.hrsa.gov/.../hpsaByAddress endpoint returns HTML
    // now). New endpoint accepts state + county via a where-clause.
    // Escape single quotes in the county name - ArcGIS uses a SQL-like
    // WHERE clause and counties named O'Brien / Prince George's / etc.
    // would otherwise break the query and return no HPSA designation,
    // silently dropping the NHSC loan-forgiveness recommendation for
    // every dental practice in those counties.
    const safeCountyName = countyClean.replace(/'/g, "''");
    const where = `StateAbbr='${state.toUpperCase()}' AND CountyName='${safeCountyName}'`;
    const url =
      'https://services2.arcgis.com' +
      '/sXVNn5Fz8lXWa6C6/arcgis/rest' +
      '/services/HPSA_Dental/FeatureServer/0/query' +
      '?where=' + encodeURIComponent(where) +
      '&outFields=HPSAScore,HPSAName,HPSAShortage,PCTofNeedMet,HPSAFormalRatio' +
      '&f=json' +
      '&returnGeometry=false';

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[hrsa-dental] HTTP ${r.status} for ${countyClean}, ${state}`);
      HRSA_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const d = await r.json();
    const features = Array.isArray(d && d.features) ? d.features : [];
    if (features.length === 0) {
      // No HPSA designation for this county = not a shortage area.
      const negativeValue = {
        is_dental_shortage_area: false,
        hpsa_score: null,
        hpsa_name: null,
        hpsa_type: null,
      };
      console.log('[hrsa-dental]', countyClean, state, '→ not a dental HPSA');
      HRSA_CACHE.set(cacheKey, { ts: Date.now(), value: negativeValue });
      return negativeValue;
    }
    const attrs = features[0].attributes || {};
    const value = {
      is_dental_shortage_area: true,
      hpsa_score: attrs.HPSAScore != null ? attrs.HPSAScore : null,
      hpsa_name: attrs.HPSAName || null,
      hpsa_type: 'Geographic',
      pct_need_met: attrs.PCTofNeedMet != null ? attrs.PCTofNeedMet : null,
      formal_ratio: attrs.HPSAFormalRatio || null,
    };
    console.log(
      '[hrsa-dental]', countyClean, state,
      '→ isHPSA: true | score:', value.hpsa_score
    );
    HRSA_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e) {
    console.error('[hrsa-dental] error:', e.message);
    return null;
  }
}

// ─── fetchUSDAERS - USDA ERS ARMS farm economics (key required) ───
// Returns state-level farm economic indicators (net farm sales).
// Fires for agriculture / restaurant / food-retail sectors.
// API key obtained at https://api.ers.usda.gov/key-signup.
const USDA_ERS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USDA_ERS_CACHE = new LRUCache({ max: 1000, ttl: USDA_ERS_TTL_MS });

async function fetchUSDAERS(state) {
  if (!state) return null;
  const key = process.env.USDA_ERS_API_KEY;
  if (!key) {
    console.warn('[usda-ers] no API key - skip');
    return null;
  }
  const cacheKey = String(state).toUpperCase();
  const cached = USDA_ERS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < USDA_ERS_TTL_MS) {
    console.log(`[cache] usda-ers hit for ${cacheKey}`);
    return cached.value;
  }
  try {
    const url =
      'https://api.ers.usda.gov' +
      '/data/arms/farmeconomics' +
      '?year=2023' +
      '&state=' + encodeURIComponent(cacheKey) +
      '&variable=NETSALES' +
      '&api_key=' + encodeURIComponent(key);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[usda-ers] HTTP ${r.status} for ${cacheKey}`);
      USDA_ERS_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    const d = await r.json();
    if (!d || !Array.isArray(d.data) || d.data.length === 0) {
      USDA_ERS_CACHE.set(cacheKey, { ts: Date.now(), value: null });
      return null;
    }
    console.log('[usda-ers]', cacheKey, '→ farm economics data received');
    const value = {
      net_farm_sales: d.data[0] && d.data[0].Value,
      year: 2023,
      state: cacheKey,
    };
    USDA_ERS_CACHE.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e) {
    console.error('[usda-ers] error:', e.message);
    return null;
  }
}

module.exports = {
  extractZipFromAddress,
  fetchCensusByZip,
  checkWebsiteExists,
  fetchWeather,
  fetchPageSpeed,
  fetchCompetitorPageSpeed,
  fetchCruxScore,
  fetchLocationSignals,
  fetchCountyFIPS,
  fetchBuildingPermits,
  fetchBuildingPermitsByAddress,
  fetchUpcomingEvents,
  fetchNearbyVenues,
  fetchTripAdvisor,
  fetchBLSEmployment,
  fetchUSDANASS,
  fetchFMCSA,
  fetchNPIRegistry,
  fetchFairMarketRents,
  fetchFDICData,
  fetchGoogleTextCompetitors,
  fetchCountyBusinessDensity,
  fetchCensusAgeProfile,
  fetchWalkScore,
  fetchZipByCity,
  fetchCountyFIPSByCity,
  // Phase 5+ - 3 new keyless extensions
  fetchCDCPlaces,
  fetchHRSADental,
  fetchUSDAERS,
  // Phase 5+ - 5 more extensions (FoodData, OFF, Datamuse, NPS, NOAA)
  fetchFoodData,
  fetchOpenFoodFacts,
  fetchDatamuse,
  fetchNearbyParks,
  fetchNOAAClimate,
};

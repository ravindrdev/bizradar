/* testAllApis.js — live end-to-end test of every BizRadar data source.
   Calls each fetcher with the test fixtures the user provided, times
   each call, classifies PASS/PARTIAL/FAIL based on whether it returned
   non-null data + non-null expected fields, and writes a JSON report.

   Run:   node testAllApis.js
   Output: testAllApis_results.json (full structured results)
   Console: human-readable per-API + summary

   Does NOT call Anthropic Claude or hit /classify. Only the individual
   data fetchers + the googlePlaces wrapper. */

require('dotenv').config({ override: true });

const places = require('./googlePlaces');
const dataFetchers = require('./dataFetchers');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ── Test fixtures (all locations / IDs the user spec'd) ──────────────
const FIX = {
  // Primary location
  hotel_query: 'AmericInn by Wyndham Dodgeville, 3637 WI-23, Dodgeville, WI 53533',
  hotel_name: 'AmericInn by Wyndham Dodgeville',
  hotel_address: '3637 WI-23, Dodgeville, WI 53533',
  hotel_city: 'Dodgeville',
  hotel_state: 'WI',
  hotel_zip: '53533',
  hotel_county_fips: '55049',
  hotel_lat: 43.0231,
  hotel_lon: -90.1328,
  hotel_naics2: '72',
  hotel_website: 'https://www.americinn.com',
  // Sector-specific fixtures
  dental_name: 'Spring Valley Dental',
  dental_city: 'Dodgeville',
  dental_state: 'WI',
  dental_naics2: '62',
  trans_name: 'Swift Transportation',
  trans_state: 'AZ',
  trans_naics2: '48-49',
  ag_state: 'WI',
  ag_naics2: '11',
  bank_name: 'Peoples Independent Bank',
  bank_state: 'WI',
  bank_naics2: '52',
  re_state: 'WI',
  re_naics2: '53',
  hospital_name: 'Mayo Clinic',
  hospital_state: 'MN',
  hospital_naics2: '62',
};

// ── Result helpers ───────────────────────────────────────────────────
const results = [];

function pad(s, n) { return String(s).padEnd(n); }

// Status logic: PASS = non-null result + all required fields present (non-null);
// PARTIAL = non-null result but some required fields null / missing;
// FAIL = function threw OR returned null/[] when it shouldn't have.
function classify({ value, requiredFields, allowNullPass = false }) {
  if (value == null) {
    return allowNullPass ? 'PASS' : 'FAIL';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? (allowNullPass ? 'PASS' : 'PARTIAL') : 'PASS';
  }
  if (typeof value !== 'object') return 'PASS';
  for (const f of (requiredFields || [])) {
    if (value[f] === null || value[f] === undefined) return 'PARTIAL';
  }
  return 'PASS';
}

// One generic runner — wraps timing + try/catch around every API call.
async function runOne(num, name, inputDesc, fn, opts = {}) {
  const t0 = Date.now();
  let value = null;
  let error = null;
  try {
    value = await fn();
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  const dt = Date.now() - t0;
  const status = error
    ? 'FAIL'
    : classify({ value, requiredFields: opts.requiredFields, allowNullPass: opts.allowNullPass });

  // Build "Output received:" snapshot — only show the fields the user
  // asked to see, plus a few standard ones for context.
  const display = {};
  if (value != null) {
    if (Array.isArray(value)) {
      display._count = value.length;
      if (value.length) display.first = value[0];
      if (opts.show && Array.isArray(opts.show)) {
        for (const k of opts.show) {
          if (k in value) display[k] = value[k];
        }
      }
    } else if (typeof value === 'object') {
      const fields = opts.show || Object.keys(value);
      for (const k of fields) display[k] = value[k];
    } else {
      display.value = value;
    }
  }

  const result = { num, name, input: inputDesc, status, response_time_ms: dt, output: display, error };
  results.push(result);

  const icon = status === 'PASS' ? '✅' : status === 'PARTIAL' ? '⚠️' : '❌';
  console.log(`\nAPI ${num} — ${name}`);
  console.log(`Status: ${icon} ${status}`);
  console.log(`Response time: ${dt}ms`);
  console.log(`Input used: ${inputDesc}`);
  console.log('Output received:');
  if (value == null) {
    console.log('  (null)');
  } else if (Array.isArray(value)) {
    console.log(`  count: ${value.length}`);
    const showCount = Math.min(value.length, opts.firstN || 3);
    for (let i = 0; i < showCount; i++) {
      console.log(`  [${i}]: ${JSON.stringify(value[i])}`);
    }
  } else if (typeof value === 'object') {
    const fields = opts.show || Object.keys(value);
    for (const k of fields) {
      const v = value[k];
      const printed = (v && typeof v === 'object') ? JSON.stringify(v) : v;
      console.log(`  ${k}: ${printed}`);
    }
  } else {
    console.log(`  ${value}`);
  }
  if (error) console.log(`Error: ${error}`);
  return value;
}

// ── Main flow ────────────────────────────────────────────────────────
(async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('BizRadar live API test — every fetcher, real data');
  console.log('═══════════════════════════════════════════════════════════');

  // 1. Google Places Text Search
  const place = await runOne(
    1, 'Google Places Text Search',
    `query: ${FIX.hotel_query}`,
    () => places.findPlace(FIX.hotel_query, API_KEY),
    { show: ['place_id', 'name', 'formatted_address', 'types'], requiredFields: ['place_id', 'name'] }
  );

  // 2. Google Places Details
  let detail = null;
  let dataFromDetail = null;
  if (place && place.place_id) {
    const detailVal = await runOne(
      2, 'Google Places Details',
      `place_id: ${place.place_id}`,
      async () => {
        detail = await places.getDetails(place.place_id, API_KEY);
        if (!detail) return null;
        dataFromDetail = places.toInputFields(detail);
        return {
          rating: dataFromDetail.google_rating,
          review_count: dataFromDetail.google_review_count,
          hours_complete: dataFromDetail.hours_complete,
          website: dataFromDetail.website,
          lat: dataFromDetail.latitude,
          lon: dataFromDetail.longitude,
          photo_count: dataFromDetail.photo_count,
        };
      },
      { show: ['rating', 'review_count', 'hours_complete', 'website', 'lat', 'lon', 'photo_count'] }
    );
  } else {
    runOne(2, 'Google Places Details', 'skipped (no place_id from #1)', async () => null);
  }

  // 3. Google Places Nearby Search
  await runOne(
    3, 'Google Places Nearby Search',
    `lat=${FIX.hotel_lat}, lon=${FIX.hotel_lon}, type=lodging, radius=8047m`,
    () => places.fetchNearbyCompetitors({
      placeId: place && place.place_id,
      lat: FIX.hotel_lat,
      lng: FIX.hotel_lon,
      type: 'lodging',
      apiKey: API_KEY,
    }),
    { show: ['competitor_count', 'competitor_median_rating', 'competitor_median_review_count', 'competitors_top3'] }
  );

  // 4. Census ACS
  await runOne(
    4, 'Census ACS',
    `zip: ${FIX.hotel_zip}`,
    () => dataFetchers.fetchCensusByZip(FIX.hotel_zip),
    { show: ['median_household_income', 'total_population', 'average_household_size', 'zip'] }
  );

  // 5. Open-Meteo Weather
  await runOne(
    5, 'Open-Meteo Weather',
    `lat=${FIX.hotel_lat}, lon=${FIX.hotel_lon}`,
    () => dataFetchers.fetchWeather(FIX.hotel_lat, FIX.hotel_lon),
    { show: ['peak_month', 'peak_month_avg_f', 'has_cold_winter', 'has_hot_summer', 'peak_tourist_season'] }
  );

  // 6. Overpass / OSM
  await runOne(
    6, 'Overpass / OpenStreetMap',
    `lat=${FIX.hotel_lat}, lon=${FIX.hotel_lon}, anchor radius 500m / transit radius 800m`,
    () => dataFetchers.fetchLocationSignals(FIX.hotel_lat, FIX.hotel_lon),
    { show: ['anchor_tenants', 'anchor_tenant_count', 'nearest_transit_meters', 'has_transit_nearby'] }
  );

  // 7. HUD Building Permits
  await runOne(
    7, 'HUD Building Permits',
    `county FIPS: ${FIX.hotel_county_fips}`,
    () => dataFetchers.fetchBuildingPermits(FIX.hotel_county_fips),
    { show: ['county_name', 'building_permits_total', 'building_permits_single_family', 'building_permits_year', 'building_permits_yoy_change'] }
  );

  // 8. Google PageSpeed
  await runOne(
    8, 'Google PageSpeed Insights',
    `url: ${FIX.hotel_website}`,
    () => dataFetchers.fetchPageSpeed(FIX.hotel_website),
    { show: ['mobile_score', 'load_time_seconds', 'lcp_seconds', 'is_mobile_friendly'] }
  );

  // 9. Ticketmaster Events
  await runOne(
    9, 'Ticketmaster Discovery v2',
    `city=${FIX.hotel_city}, state=${FIX.hotel_state}`,
    () => dataFetchers.fetchUpcomingEvents(FIX.hotel_city, FIX.hotel_state),
    { allowNullPass: true, firstN: 3 }
  );

  // 10. Foursquare Venues
  await runOne(
    10, 'Foursquare Places v3',
    `lat=${FIX.hotel_lat}, lon=${FIX.hotel_lon}, radius 1km`,
    () => dataFetchers.fetchNearbyVenues(FIX.hotel_lat, FIX.hotel_lon),
    { firstN: 3 }
  );

  // 11. TripAdvisor
  await runOne(
    11, 'TripAdvisor Content API',
    `name: ${FIX.hotel_name}, address: ${FIX.hotel_address}`,
    () => dataFetchers.fetchTripAdvisor(FIX.hotel_name, FIX.hotel_address),
    { show: ['ta_location_id', 'ta_rating', 'ta_review_count', 'ta_ranking', 'ta_subratings', 'ta_value_gap_detected'] }
  );

  // 12. BLS Employment
  await runOne(
    12, 'BLS Public Data API v2',
    `naics2: ${FIX.hotel_naics2} (hospitality — NOT in wired sectors 23/44-45/54/61/62)`,
    () => dataFetchers.fetchBLSEmployment(FIX.hotel_naics2),
    { allowNullPass: true, show: ['employment_level', 'employment_year', 'employment_period', 'naics2'] }
  );

  // 12b. Sanity-check BLS with a wired sector (62 = healthcare).
  await runOne(
    '12b', 'BLS Public Data API v2 (wired sector check)',
    `naics2: 62 (healthcare — wired)`,
    () => dataFetchers.fetchBLSEmployment('62'),
    { show: ['employment_level', 'employment_year', 'employment_period', 'naics2'] }
  );

  // 13. USDA NASS
  await runOne(
    13, 'USDA NASS QuickStats',
    `state=${FIX.ag_state}, commodity=CORN`,
    () => dataFetchers.fetchUSDANASS(FIX.ag_state, 'CORN'),
    { show: ['top_commodity', 'top_commodity_acres', 'commodities', 'state_ag_profile'] }
  );

  // 14. FMCSA Safety
  await runOne(
    14, 'FMCSA QCMobile',
    `name: ${FIX.trans_name}`,
    () => dataFetchers.fetchFMCSA(FIX.trans_name),
    { show: ['dot_number', 'safety_rating', 'safety_rating_date', 'allowed_to_operate', 'carrier_operation', 'total_drivers', 'total_trucks'] }
  );

  // 15. NPI Registry
  await runOne(
    15, 'NPI Registry',
    `name: ${FIX.dental_name}, city: ${FIX.dental_city}, state: ${FIX.dental_state}`,
    () => dataFetchers.fetchNPIRegistry(FIX.dental_name, FIX.dental_city, FIX.dental_state),
    { show: ['npi_number', 'provider_type', 'status', 'credential', 'authorized'] }
  );

  // 16. HUD Fair Market Rents
  await runOne(
    16, 'HUD User FMR',
    `state: ${FIX.re_state}`,
    () => dataFetchers.fetchFairMarketRents(FIX.re_state),
    { show: ['metro_code', 'metro_name', 'fmr_studio', 'fmr_1br', 'fmr_2br', 'fmr_year'] }
  );

  // 17. FDIC BankFind
  await runOne(
    17, 'FDIC BankFind',
    `name: ${FIX.bank_name}, state: ${FIX.bank_state}`,
    () => dataFetchers.fetchFDICData(FIX.bank_name, FIX.bank_state),
    { show: ['bank_name', 'total_deposits', 'total_assets', 'state', 'city'] }
  );

  // 18. CMS Provider Data
  await runOne(
    18, 'CMS Hospital General Information',
    `name: ${FIX.hospital_name}, state: ${FIX.hospital_state}`,
    () => dataFetchers.fetchCMSProviderData(FIX.hospital_name, FIX.hospital_state),
    { show: ['facility_name', 'overall_rating', 'patient_experience_rating', 'mortality_rating', 'safety_rating', 'readmission_rating', 'timeliness_rating'] }
  );

  // ── Summary ────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const partial = results.filter((r) => r.status === 'PARTIAL').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log(`Total APIs tested: ${results.length}`);
  console.log(`Passed:  ${passed}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Partial: ${partial}`);
  console.log('═══════════════════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\nFailed APIs (with diagnostics):');
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      console.log(`  ❌ #${r.num} ${r.name}: ${r.error || '(returned null/empty when expected non-null)'}`);
    }
  }
  if (partial > 0) {
    console.log('\nPartial APIs (returned data but some expected fields missing):');
    for (const r of results.filter((x) => x.status === 'PARTIAL')) {
      console.log(`  ⚠️  #${r.num} ${r.name}`);
    }
  }

  // Persist full report for later inspection.
  require('fs').writeFileSync(
    './testAllApis_results.json',
    JSON.stringify({
      generated_at: new Date().toISOString(),
      summary: { total: results.length, passed, partial, failed },
      results,
    }, null, 2)
  );
  console.log('\nFull results saved to: testAllApis_results.json');
})().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});

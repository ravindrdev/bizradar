/* testAllApis_v2.js — multi-business live test for every GrowthIM fetcher.
   Runs 3 real businesses (rural hotel / large hospital / urban restaurant)
   through every API in dataFetchers.js + googlePlaces.js so we can confirm
   each fetcher works across location, sector, and edge-case dimensions.

   Run:    node testAllApis_v2.js
   Output: console (per-API blocks + master summary) +
           testAllApis_v2_results.json (full raw results)

   Sequential by design — both businesses-within-API and API-by-API — to
   stay friendly to free-tier rate limits. 500ms sleep between every call. */

require('dotenv').config({ override: true });

const fs = require('fs');
const places = require('./googlePlaces');
const dataFetchers = require('./dataFetchers');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Env-key visibility — at the top of the run we print which keys are set
// (just names, never values) so the operator can correlate failures with
// missing config. Must match the keys used by the fetchers below.
const ENV_KEYS = [
  'GOOGLE_PLACES_API_KEY', 'ANTHROPIC_API_KEY', 'TICKETMASTER_API_KEY',
  'CENSUS_API_KEY', 'FOURSQUARE_API_KEY', 'TRIPADVISOR_API_KEY',
  'BLS_API_KEY', 'USDA_NASS_API_KEY', 'FMCSA_API_KEY', 'HUD_API_KEY',
];

// ── 3 test businesses ────────────────────────────────────────────────
const BUSINESSES = [
  {
    id: 'A', short: 'AmericInn / Dodgeville WI',
    name: 'AmericInn by Wyndham Dodgeville',
    address: '3637 WI-23, Dodgeville, WI 53533',
    lat: 42.9908929, lon: -90.1392972,
    city: 'Dodgeville', state: 'WI', zip: '53533',
    naics2: '72', sector: 'lodging',
  },
  {
    id: 'B', short: 'Mayo Clinic / Rochester MN',
    name: 'Mayo Clinic',
    address: '200 First St SW, Rochester, MN 55905',
    lat: 44.0225, lon: -92.4668,
    city: 'Rochester', state: 'MN', zip: '55905',
    naics2: '62', sector: 'hospital',
  },
  {
    id: 'C', short: 'Shake Shack / Chicago IL',
    name: 'Shake Shack',
    address: '600 N Michigan Ave, Chicago, IL 60611',
    lat: 41.8930, lon: -87.6244,
    city: 'Chicago', state: 'IL', zip: '60611',
    naics2: '72', sector: 'restaurant',
  },
];

// Cross-API state per business — Text Search produces place_id, Details
// produces website, etc. Subsequent APIs read from this map.
const place = { A: {}, B: {}, C: {} };

// Per-business per-API result, shape { status, ms, displayLine, error, raw }
const results = { A: {}, B: {}, C: {} };

// Status constants. PARTIAL = result returned but key fields empty.
// NULL OK = function returned null and that's correct for this business
// type (e.g. FMCSA for a hotel). N/A = intentional skip.
const SLEEP_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusCell(s) {
  switch (s) {
    case 'PASS': return '✅ PASS';
    case 'FAIL': return '❌ FAIL';
    case 'PARTIAL': return '⚠️ PARTIAL';
    case 'N/A': return 'N/A';
    case 'NULL OK': return 'NULL OK';
    default: return s;
  }
}

// Strict short status used in the master summary table — fixed widths so
// the box-drawing alignment doesn't drift when emojis vary in render width.
function tableStatus(s) {
  switch (s) {
    case 'PASS': return '✅       ';
    case 'FAIL': return '❌       ';
    case 'PARTIAL': return '⚠️ PART ';
    case 'N/A': return 'N/A      ';
    case 'NULL OK': return 'NULL OK  ';
    default: return s;
  }
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), ms: Date.now() - t0 };
  }
}

// Classify a single business+API result based on `expectation` ("expect_data" |
// "expect_null" | "na") and the actual returned value.
function classify(value, expectation, requiredFields) {
  if (expectation === 'na') return 'N/A';
  if (value == null) {
    return expectation === 'expect_null' ? 'NULL OK' : 'FAIL';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return expectation === 'expect_null' ? 'NULL OK' : 'PARTIAL';
    return 'PASS';
  }
  if (typeof value === 'object') {
    if (Array.isArray(requiredFields) && requiredFields.length) {
      const allEmpty = requiredFields.every((f) => value[f] == null || value[f] === '');
      if (allEmpty) return 'PARTIAL';
    }
    return 'PASS';
  }
  return 'PASS';
}

function printApiHeader(num, name) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`API ${num} — ${name}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

function printBusinessLine(biz, status, ms, display, error) {
  const left = `[${biz.id}] ${biz.short}`.padEnd(38);
  const stat = statusCell(status).padEnd(11);
  console.log(`  ${left}${stat}(${ms}ms)`);
  if (display) console.log(`      ${display}`);
  if (error)   console.log(`      \x1b[31mERROR: ${error}\x1b[0m`);
}

function printApiFooter(num, total) {
  console.log(`\nSTATUS: ${num}/${total} PASS`);
  console.log('');
}

// runApi — generic harness. perBiz returns { run, display, expectation,
// requiredFields, skip?, skipReason?, captureFn? }. captureFn lets the
// test stash dependent state (e.g. place_id) into `place[biz.id]`.
async function runApi(num, name, perBiz) {
  printApiHeader(num, name);
  let passes = 0;
  for (const biz of BUSINESSES) {
    const cfg = perBiz(biz);
    if (cfg.skip) {
      const status = cfg.skipStatus || 'N/A';
      printBusinessLine(biz, status, 0, cfg.skipReason || '');
      results[biz.id][num] = { status, ms: 0, displayLine: cfg.skipReason || '', error: null, raw: null };
      if (status === 'PASS') passes++;
      continue;
    }
    const t = await timed(cfg.run);
    let status, displayLine = '', error = null;
    if (!t.ok) {
      status = 'FAIL';
      error = t.error;
    } else {
      status = classify(t.value, cfg.expectation, cfg.requiredFields);
      try {
        if (typeof cfg.display === 'function' && t.value != null) {
          displayLine = cfg.display(t.value, biz) || '';
        }
      } catch (e) {
        displayLine = '(display fn threw: ' + e.message + ')';
      }
      if (typeof cfg.captureFn === 'function') {
        try { cfg.captureFn(t.value, biz); } catch {}
      }
    }
    if (status === 'PASS') passes++;
    printBusinessLine(biz, status, t.ms, displayLine, error);
    results[biz.id][num] = { status, ms: t.ms, displayLine, error, raw: t.value };
    await sleep(SLEEP_MS);
  }
  printApiFooter(passes, 3);
  return passes;
}

// ── Helpers used by display functions ────────────────────────────────
const usd = (n) => (typeof n === 'number') ? '$' + n.toLocaleString('en-US') : '—';
const pad = (s, n) => String(s == null ? '—' : s).padEnd(n);

// ── Main ─────────────────────────────────────────────────────────────
(async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('GrowthIM API Health Check v2');
  console.log('Run at:   ' + new Date().toISOString());
  console.log('Test env: ' + (process.env.NODE_ENV || 'development'));
  const setKeys = ENV_KEYS.filter((k) => !!process.env[k]);
  const unsetKeys = ENV_KEYS.filter((k) => !process.env[k]);
  console.log(`Set env keys (${setKeys.length}): ${setKeys.join(', ') || '(none)'}`);
  if (unsetKeys.length) {
    console.log(`Unset env keys (${unsetKeys.length}): ${unsetKeys.join(', ')}`);
  }
  console.log('Businesses:');
  for (const b of BUSINESSES) {
    console.log(`  [${b.id}] ${b.name} — ${b.address} (NAICS-2 ${b.naics2})`);
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. Google Places Text Search
  await runApi(1, 'Google Places Text Search', (biz) => ({
    run: () => places.findPlace(`${biz.name}, ${biz.address}`, API_KEY),
    expectation: 'expect_data',
    requiredFields: ['place_id', 'name'],
    captureFn: (v) => {
      place[biz.id].place_id = v.place_id;
      place[biz.id].formatted_address = v.formatted_address;
      place[biz.id].types = v.types;
    },
    display: (v) => `place_id: ${v.place_id} | name: ${v.name}`,
  }));

  // 2. Google Places Details
  await runApi(2, 'Google Places Details', (biz) => {
    const pid = place[biz.id].place_id;
    if (!pid) {
      return { skip: true, skipStatus: 'FAIL', skipReason: 'no place_id from API 1' };
    }
    return {
      run: async () => {
        const detail = await places.getDetails(pid, API_KEY);
        if (!detail) return null;
        const f = places.toInputFields(detail);
        return {
          rating: f.google_rating,
          review_count: f.google_review_count,
          hours_complete: f.hours_complete,
          website: f.website,
          lat: f.latitude,
          lon: f.longitude,
          photo_count: f.photo_count,
        };
      },
      captureFn: (v) => {
        place[biz.id].website = v.website;
        place[biz.id].lat = v.lat;
        place[biz.id].lon = v.lon;
      },
      expectation: 'expect_data',
      requiredFields: ['rating', 'review_count'],
      display: (v) => `rating: ${v.rating}★ | reviews: ${v.review_count} | website: ${v.website || '—'}`,
    };
  });

  // 3. Google Places Nearby Search
  await runApi(3, 'Google Places Nearby Search', (biz) => {
    const pid = place[biz.id].place_id;
    const lat = place[biz.id].lat || biz.lat;
    const lon = place[biz.id].lon || biz.lon;
    const types = place[biz.id].types;
    const type = places.pickNearbySearchType(types || []);
    if (!pid) return { skip: true, skipStatus: 'FAIL', skipReason: 'no place_id' };
    return {
      run: () => places.fetchNearbyCompetitors({ placeId: pid, lat, lng: lon, type, apiKey: API_KEY }),
      expectation: 'expect_data',
      requiredFields: ['competitor_count'],
      display: (v) => `competitors: ${v.competitor_count} | median_rating: ${v.competitor_median_rating ?? '—'} | top: ${(v.competitors_top3 || [])[0]?.name || '—'}`,
    };
  });

  // 4. Census ACS
  await runApi(4, 'Census ACS', (biz) => ({
    run: () => dataFetchers.fetchCensusByZip(biz.zip),
    expectation: 'expect_data',
    requiredFields: ['median_household_income', 'total_population'],
    display: (v) => `median_income: ${usd(v.median_household_income)} | pop: ${v.total_population?.toLocaleString('en-US') || '—'} | hh_size: ${v.average_household_size ?? '—'}`,
  }));

  // 5. Open-Meteo Weather
  await runApi(5, 'Open-Meteo Weather', (biz) => ({
    run: () => dataFetchers.fetchWeather(biz.lat, biz.lon),
    expectation: 'expect_data',
    requiredFields: ['peak_month'],
    display: (v) => `peak: ${v.peak_month} (${v.peak_month_avg_f}°F) | cold_winter: ${v.has_cold_winter} | hot_summer: ${v.has_hot_summer}`,
  }));

  // 6. Overpass / OSM
  await runApi(6, 'Overpass / OpenStreetMap', (biz) => ({
    run: () => dataFetchers.fetchLocationSignals(biz.lat, biz.lon),
    expectation: 'expect_data',
    // Anchors+transit can both be empty in rural areas — count any
    // non-null result as PASS (the fetcher returning the object IS the
    // signal that the upstream call succeeded).
    requiredFields: [],
    display: (v) => `anchors: ${v.anchor_tenant_count} (${(v.anchor_tenants || []).slice(0, 2).join(', ') || 'none'}) | transit: ${v.has_transit_nearby ? `${v.nearest_transit_meters}m` : 'none ≤800m'}`,
  }));

  // 7. HUD Building Permits
  await runApi(7, 'HUD Building Permits', (biz) => ({
    run: () => dataFetchers.fetchBuildingPermitsByAddress(place[biz.id].formatted_address || biz.address),
    expectation: 'expect_data',
    requiredFields: ['building_permits_total'],
    display: (v) => `${v.county_name} County | permits: ${v.building_permits_total} (sf: ${v.building_permits_single_family ?? '—'}) | ${v.building_permits_year} | YoY: ${v.building_permits_yoy_change ?? '—'}%`,
  }));

  // 8. Google PageSpeed Insights
  await runApi(8, 'Google PageSpeed Insights', (biz) => {
    const url = place[biz.id].website;
    if (!url) {
      return { skip: true, skipStatus: 'FAIL', skipReason: 'no website from Places Details' };
    }
    return {
      run: () => dataFetchers.fetchPageSpeed(url),
      expectation: 'expect_data',
      requiredFields: ['mobile_score'],
      display: (v) => `mobile_score: ${v.mobile_score}/100 | load_time: ${v.load_time_seconds}s | mobile_friendly: ${v.is_mobile_friendly}`,
    };
  });

  // 9. Ticketmaster
  await runApi(9, 'Ticketmaster Discovery v2', (biz) => ({
    run: () => dataFetchers.fetchUpcomingEvents(biz.city, biz.state),
    // Empty array is a legitimate result for sleepy markets — we don't
    // call it FAIL when Dodgeville simply has nothing on Ticketmaster.
    expectation: 'expect_null',
    display: (v) => `events: ${v.length}${v.length ? ` | first: ${v[0].name} (${v[0].date})` : ''}`,
  }));

  // 10. Foursquare Places
  await runApi(10, 'Foursquare Places', (biz) => ({
    run: () => dataFetchers.fetchNearbyVenues(biz.lat, biz.lon),
    expectation: 'expect_null',
    display: (v) => `venues: ${v.length}${v.length ? ` | first: ${v[0].name} (${v[0].category}, ${v[0].distance_meters}m)` : ''}`,
  }));

  // 11. TripAdvisor
  await runApi(11, 'TripAdvisor Content API', (biz) => ({
    run: () => dataFetchers.fetchTripAdvisor(biz.name, place[biz.id].formatted_address || biz.address),
    // Some businesses simply aren't on TripAdvisor; that's a legitimate
    // null, not a fetcher failure.
    expectation: 'expect_null',
    display: (v) => `${v.ta_rating}★ (${v.ta_review_count} reviews) | ranking: ${v.ta_ranking || '—'}`,
  }));

  // 12. BLS Employment
  await runApi(12, 'BLS Employment', (biz) => ({
    run: () => dataFetchers.fetchBLSEmployment(biz.naics2),
    expectation: 'expect_data',
    requiredFields: ['employment_level'],
    display: (v) => `naics2 ${v.naics2}: ${v.employment_level?.toLocaleString('en-US')} jobs | ${v.employment_period} ${v.employment_year}`,
  }));

  // 13. USDA NASS — only run for Business A (WI agriculture). Skip B and C as N/A.
  await runApi(13, 'USDA NASS', (biz) => {
    if (biz.id !== 'A') {
      return { skip: true, skipStatus: 'N/A', skipReason: `${biz.sector} is not agriculture (NAICS-2 ${biz.naics2})` };
    }
    return {
      run: () => dataFetchers.fetchUSDANASS(biz.state, 'CORN'),
      expectation: 'expect_data',
      requiredFields: ['top_commodity'],
      display: (v) => `top: ${v.top_commodity} (${v.top_commodity_acres?.toLocaleString('en-US')} ac) | ${(v.commodities || []).length} commodities`,
    };
  });

  // 14. FMCSA — none of our 3 are carriers; null is the expected answer.
  await runApi(14, 'FMCSA', (biz) => ({
    run: () => dataFetchers.fetchFMCSA(biz.name),
    expectation: 'expect_null',
    display: (v) => `DOT#${v.dot_number} | rating: ${v.safety_rating} | allowed: ${v.allowed_to_operate}`,
  }));

  // 15. NPI Registry — Mayo Clinic is the only one expected to match.
  await runApi(15, 'NPI Registry', (biz) => ({
    run: () => dataFetchers.fetchNPIRegistry(biz.name, biz.city, biz.state),
    expectation: biz.id === 'B' ? 'expect_data' : 'expect_null',
    requiredFields: ['npi_number'],
    display: (v) => `NPI ${v.npi_number} | ${v.provider_type} | status: ${v.status} | authorized: ${v.authorized}`,
  }));

  // 16. HUD Fair Market Rents
  await runApi(16, 'HUD Fair Market Rents', (biz) => ({
    // Pass biz.city as the optional 2nd arg so we get the matching metro
    // (post-recent-change to fetchFairMarketRents).
    run: () => dataFetchers.fetchFairMarketRents(biz.state, biz.city),
    expectation: 'expect_data',
    requiredFields: ['fmr_2br'],
    display: (v) => `${v.metro_name} (${v.fmr_year}) | studio ${usd(v.fmr_studio)} | 1BR ${usd(v.fmr_1br)} | 2BR ${usd(v.fmr_2br)}`,
  }));

  // 17. FDIC BankFind — none of our 3 are banks.
  await runApi(17, 'FDIC BankFind', (biz) => ({
    run: () => dataFetchers.fetchFDICData(biz.name, biz.state),
    expectation: 'expect_null',
    display: (v) => `${v.bank_name} | deposits ${usd(v.total_deposits)}k | assets ${usd(v.total_assets)}k`,
  }));

  // 18. CMS Hospital — Mayo Clinic is the only one expected to match.
  await runApi(18, 'CMS Hospital General Information', (biz) => ({
    run: () => dataFetchers.fetchCMSProviderData(biz.name, biz.state),
    expectation: biz.id === 'B' ? 'expect_data' : 'expect_null',
    requiredFields: ['overall_rating'],
    display: (v) => `${v.facility_name} | overall: ${v.overall_rating}/5 | safety_measures: ${v.safety_measure_count} | mortality_measures: ${v.mortality_measure_count}`,
  }));

  // ── Master summary table ─────────────────────────────────────────────
  const apiOrder = [
    [1, 'Google Text Search'],
    [2, 'Google Details'],
    [3, 'Google Nearby'],
    [4, 'Census ACS'],
    [5, 'Open-Meteo Weather'],
    [6, 'Overpass OSM'],
    [7, 'HUD Permits'],
    [8, 'PageSpeed'],
    [9, 'Ticketmaster'],
    [10, 'Foursquare'],
    [11, 'TripAdvisor'],
    [12, 'BLS Employment'],
    [13, 'USDA NASS'],
    [14, 'FMCSA'],
    [15, 'NPI Registry'],
    [16, 'HUD FMR'],
    [17, 'FDIC BankFind'],
    [18, 'CMS Hospital'],
  ];

  const totalCells = 18 * 3; // 54 individual tests
  let totalPassing = 0;
  const perBiz = { A: 0, B: 0, C: 0 };

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  GrowthIM API Health Check v2 — Full Results                     ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  API                          A           B           C          ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  for (const [num, label] of apiOrder) {
    const apiCol = `${num}. ${label}`.padEnd(28);
    const a = results.A[num] ? results.A[num].status : 'FAIL';
    const b = results.B[num] ? results.B[num].status : 'FAIL';
    const c = results.C[num] ? results.C[num].status : 'FAIL';
    if (a === 'PASS' || a === 'NULL OK') { totalPassing++; perBiz.A++; }
    if (b === 'PASS' || b === 'NULL OK') { totalPassing++; perBiz.B++; }
    if (c === 'PASS' || c === 'NULL OK') { totalPassing++; perBiz.C++; }
    // N/A counts toward "non-failing" tests — it's an intentional skip,
    // not a problem. Add it to perBiz/totals so the bottom-line tally
    // doesn't unfairly penalize sector-conditional fetchers.
    if (a === 'N/A') { totalPassing++; perBiz.A++; }
    if (b === 'N/A') { totalPassing++; perBiz.B++; }
    if (c === 'N/A') { totalPassing++; perBiz.C++; }
    console.log(`║  ${apiCol} ${tableStatus(a)} ${tableStatus(b)} ${tableStatus(c)} ║`);
  }
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  const totA = `${perBiz.A}/18`.padEnd(11);
  const totB = `${perBiz.B}/18`.padEnd(11);
  const totC = `${perBiz.C}/18`.padEnd(11);
  console.log(`║  TOTAL                      ${totA} ${totB} ${totC}          ║`);
  console.log(`║  OVERALL                    ${totalPassing}/${totalCells} tests passing (PASS+NULL OK+N/A)        ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('\nLegend:');
  console.log('  ✅ PASS    — got a result with key fields populated');
  console.log('  ❌ FAIL    — threw or returned null when data was expected');
  console.log('  ⚠️  PARTIAL — got a result but key fields were null/empty');
  console.log('  N/A       — sector-conditional fetcher intentionally skipped');
  console.log('  NULL OK   — null returned and that\'s correct for this business type');

  // ── Persist raw report ──────────────────────────────────────────────
  fs.writeFileSync(
    './testAllApis_v2_results.json',
    JSON.stringify({
      generated_at: new Date().toISOString(),
      env_keys_set: ENV_KEYS.filter((k) => !!process.env[k]),
      env_keys_unset: ENV_KEYS.filter((k) => !process.env[k]),
      businesses: BUSINESSES,
      summary: {
        total_cells: totalCells,
        total_passing: totalPassing,
        per_business: perBiz,
      },
      results,
      place_chain_state: place,
    }, null, 2)
  );
  console.log('\nFull raw results saved to: testAllApis_v2_results.json');
})().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});

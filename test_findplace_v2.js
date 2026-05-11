/* test_findplace_v2.js
   ─────────────────────────────────────────────────────────────────
   10-case findPlace accuracy test against verified-correct
   inputs (street numbers + addresses confirmed).

   Usage:    node test_findplace_v2.js
   Output:   stdout per-case detail + final summary
             test_findplace_v2_results.json (machine-readable)
   Cost:     under $2 in Google API calls (10 cases × ~3 calls ea)
   Time:     under 2 minutes (500ms throttle)
   Requires: GOOGLE_PLACES_API_KEY in .env
*/

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { findPlace } = require('./googlePlaces.js');

if (typeof findPlace !== 'function') {
  console.error('ERROR: findPlace not exported from googlePlaces.js');
  process.exit(1);
}
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!API_KEY) {
  console.error('ERROR: GOOGLE_PLACES_API_KEY missing from .env');
  process.exit(1);
}
if (typeof fetch !== 'function') {
  console.error('ERROR: global fetch unavailable. Use Node 18+.');
  process.exit(1);
}

const OUTPUT_FILE = path.join(__dirname, 'test_findplace_v2_results.json');
const DELAY_MS = 500;

// ─── API call counters via fetch monkey-patch ────────────────────────
const apiCounts = { textSearch: 0, geocode: 0, nearby: 0, details: 0, other: 0 };
const originalFetch = global.fetch.bind(global);
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.includes('/place/textsearch/')) apiCounts.textSearch++;
  else if (u.includes('/place/nearbysearch/')) apiCounts.nearby++;
  else if (u.includes('/place/details/')) apiCounts.details++;
  else if (u.includes('/geocode/')) apiCounts.geocode++;
  else apiCounts.other++;
  return originalFetch(url, opts);
};

// ─── console capture per test ────────────────────────────────────────
let logBuffer = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function startCapture() {
  logBuffer = [];
  console.log   = (...a) => logBuffer.push(a.map(String).join(' '));
  console.warn  = (...a) => logBuffer.push('WARN: ' + a.map(String).join(' '));
  console.error = (...a) => logBuffer.push('ERROR: ' + a.map(String).join(' '));
}
function stopCapture() {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  return logBuffer.join('\n');
}

// ─── 25 verified test cases (with ", USA" suffix per latest spec) ──
const TESTS_RAW = [
  { input: 'Rajni Indian Cuisine, 429 Commerce Dr, Madison, WI 53719, USA',                       expected_name: 'Rajni',     expected_street: '429'  },
  { input: 'Franklin Barbecue, 900 E 11th St, Austin, TX 78702, USA',                             expected_name: 'Franklin',  expected_street: '900'  },
  { input: 'AmericInn by Wyndham Dodgeville, 3637 State Rd 23, Dodgeville, WI 53533, USA',        expected_name: 'AmericInn', expected_street: '3637' },
  { input: 'Don Q Inn, 3658 WI-23, Dodgeville, WI 53533, USA',                                    expected_name: 'Don Q',     expected_street: '3658' },
  { input: 'Nobu Downtown, 195 Broadway, New York, NY 10007, USA',                                expected_name: 'Nobu',      expected_street: '195'  },
  { input: 'Baymont by Wyndham Oshkosh Airport, 1581 W South Park Ave, Oshkosh, WI 54902, USA',   expected_name: 'Baymont',   expected_street: '1581' },
  { input: 'Wingate by Wyndham Oshkosh, 1800 S Koeller St, Oshkosh, WI 54902, USA',               expected_name: 'Wingate',   expected_street: '1800' },
  { input: 'Alinea, 1723 N Halsted St, Chicago, IL 60614, USA',                                   expected_name: 'Alinea',    expected_street: '1723' },
  { input: 'Marcus Point Cinema, 7825 Big Sky Dr, Madison, WI 53719, USA',                        expected_name: 'Marcus',    expected_street: '7825' },
  { input: 'Kohl Center, 601 W Dayton St, Madison, WI 53715, USA',                                expected_name: 'Kohl',      expected_street: '601'  },
  // Tests 11-25 added per latest spec (more verified inputs)
  { input: 'Uchi, 801 S Lamar Blvd, Austin, TX 78704, USA',                                       expected_name: 'Uchi',      expected_street: '801'  },
  { input: 'Carbone, 181 Thompson St, New York, NY 10012, USA',                                   expected_name: 'Carbone',   expected_street: '181'  },
  { input: 'Le Bernardin, 155 W 51st St, New York, NY 10019, USA',                                expected_name: 'Bernardin', expected_street: '155'  },
  { input: 'Zahav, 237 St James Pl, Philadelphia, PA 19106, USA',                                 expected_name: 'Zahav',     expected_street: '237'  },
  { input: 'Cosme, 35 E 21st St, New York, NY 10010, USA',                                        expected_name: 'Cosme',     expected_street: '35'   },
  { input: 'The House on the Rock, 5754 State Rd 23, Spring Green, WI 53588, USA',                expected_name: 'House',     expected_street: '5754' },
  { input: 'Lilia, 567 Union Ave, Brooklyn, NY 11222, USA',                                       expected_name: 'Lilia',     expected_street: '567'  },
  { input: 'Canlis, 2576 Aurora Ave N, Seattle, WA 98109, USA',                                   expected_name: 'Canlis',    expected_street: '2576' },
  { input: 'Osteria Mozza, 6602 Melrose Ave, Los Angeles, CA 90038, USA',                         expected_name: 'Mozza',     expected_street: '6602' },
  { input: 'Stumptown Coffee Roasters, 128 SW 3rd Ave, Portland, OR 97204, USA',                  expected_name: 'Stumptown', expected_street: '128'  },
  { input: 'Governor Dodge State Park, 4175 State Rd 23, Dodgeville, WI 53533, USA',              expected_name: 'Dodge',     expected_street: '4175' },
  { input: 'Colectivo Coffee, 2406 Monroe St, Madison, WI 53711, USA',                            expected_name: 'Colectivo', expected_street: '2406' },
  { input: 'Ancora Coffee, 112 King St, Madison, WI 53703, USA',                                  expected_name: 'Ancora',    expected_street: '112'  },
  { input: 'Hilton Garden Inn Oshkosh, 1355 W 20th Ave, Oshkosh, WI 54902, USA',                  expected_name: 'Hilton',    expected_street: '1355' },
  { input: 'Epic Systems Corporation, 1979 Milky Way, Verona, WI 53593, USA',                     expected_name: 'Epic',      expected_street: '1979' },
  // Tests 26-40 added per latest spec (some duplicates of 21-25 are
  // intentional — re-runs verify the prior pass/fail results held).
  { input: "Roberta's, 261 Moore St, Brooklyn, NY 11206, USA",                                    expected_name: 'Roberta',     expected_street: '261'  },
  { input: 'Au Cheval, 800 W Randolph St, Chicago, IL 60607, USA',                                expected_name: 'Cheval',      expected_street: '800'  },
  { input: 'Din Tai Fung, 2621 NE 46th St, Seattle, WA 98105, USA',                               expected_name: 'Din Tai Fung',expected_street: '2621' },
  { input: 'Pinewood Social, 33 Peabody St, Nashville, TN 37210, USA',                            expected_name: 'Pinewood',    expected_street: '33'   },
  { input: 'Intelligentsia Coffee, 53 W Jackson Blvd, Chicago, IL 60604, USA',                    expected_name: 'Intelligentsia', expected_street: '53' },
  { input: 'Colectivo Coffee, 2406 Monroe St, Madison, WI 53711, USA',                            expected_name: 'Colectivo',   expected_street: '2406' },
  { input: 'Ancora Coffee, 112 King St, Madison, WI 53703, USA',                                  expected_name: 'Ancora',      expected_street: '112'  },
  { input: 'Hilton Garden Inn Oshkosh, 1355 W 20th Ave, Oshkosh, WI 54902, USA',                  expected_name: 'Hilton',      expected_street: '1355' },
  { input: 'Epic Systems Corporation, 1979 Milky Way, Verona, WI 53593, USA',                     expected_name: 'Epic',        expected_street: '1979' },
  { input: 'Governor Dodge State Park, 4175 State Rd 23, Dodgeville, WI 53533, USA',              expected_name: 'Dodge',       expected_street: '4175' },
  { input: 'Quality Inn Oshkosh, 1495 W South Park Ave, Oshkosh, WI 54902, USA',                  expected_name: 'Quality',     expected_street: '1495' },
  { input: 'Cobblestone Hotel and Suites Oshkosh, 1515 Planeview Dr, Oshkosh, WI 54904, USA',     expected_name: 'Cobblestone', expected_street: '1515' },
  { input: 'Graduate Madison, 601 Langdon St, Madison, WI 53703, USA',                            expected_name: 'Graduate',    expected_street: '601'  },
  { input: 'Morimoto, 723 Chestnut St, Philadelphia, PA 19106, USA',                              expected_name: 'Morimoto',    expected_street: '723'  },
  { input: 'Husk Nashville, 37 Rutledge St, Nashville, TN 37210, USA',                            expected_name: 'Husk',        expected_street: '37'   },
];
// Auto-add idx + name (first comma-segment) so the per-test renderer
// stays consistent without duplicating those fields in every entry.
const TESTS = TESTS_RAW.map((t, i) => ({
  idx: i + 1,
  name: t.input.split(',')[0].trim(),
  ...t,
}));

// ─── Grading ─────────────────────────────────────────────────────────
function gradeResult(tc, result) {
  if (!result) return { pass: false, reason: 'findPlace returned null' };

  const addr = result.formatted_address || '';
  const returnedName = String(result.name || '').toLowerCase();
  const expectedNameLower = String(tc.expected_name).toLowerCase();
  const nameMatch = returnedName.includes(expectedNameLower);

  // Street-number check — looks for the expected number anywhere in
  // the address (handles "Monadnock Building, 53 W Jackson" type
  // prefixed addresses where the street isn't at position 0).
  const streetRegex = new RegExp('\\b' + tc.expected_street + '\\b');
  const streetMatch = streetRegex.test(addr);

  if (streetMatch && nameMatch) return { pass: true, streetMatch: true, nameMatch: true };
  if (!streetMatch && !nameMatch) {
    return { pass: false, streetMatch: false, nameMatch: false,
      reason: `Wrong business: expected "${tc.expected_name}" at ${tc.expected_street}, got "${result.name}" at ${addr || '(no address)'}` };
  }
  if (!streetMatch) {
    return { pass: false, streetMatch: false, nameMatch: true,
      reason: `Wrong street: expected ${tc.expected_street}, address shows "${addr || '(empty)'}"` };
  }
  return { pass: false, streetMatch: true, nameMatch: false,
    reason: `Wrong name: expected "${tc.expected_name}", got "${result.name}"` };
}

// ─── Per-test runner ─────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runOne(tc) {
  const beforeCounts = { ...apiCounts };
  startCapture();
  let result = null;
  let err = null;
  try {
    result = await findPlace(tc.input, API_KEY);
  } catch (e) { err = e; }
  const log = stopCapture();

  const apiCallsThisTest = {
    textSearch: apiCounts.textSearch - beforeCounts.textSearch,
    geocode: apiCounts.geocode - beforeCounts.geocode,
    nearby: apiCounts.nearby - beforeCounts.nearby,
  };

  const confLine = log.match(/(HIGH|MEDIUM|LOW) CONFIDENCE.*?score:\s*(\d+)/i);
  const confidence = confLine ? confLine[1].toUpperCase() : null;
  const score = confLine ? parseInt(confLine[2], 10) : null;
  const geocodeFired = /trying geocoding fallback/.test(log);
  const geocodeWinner = /GEOCODE WINNER/.test(log);

  let grade;
  if (err) grade = { pass: false, reason: 'Exception: ' + err.message };
  else grade = gradeResult(tc, result);

  return {
    idx: tc.idx,
    name: tc.name,
    input: tc.input,
    expected_name: tc.expected_name,
    expected_street: tc.expected_street,
    returned: result ? {
      name: result.name,
      address: result.formatted_address,
      place_id: result.place_id,
      types: result.types,
      _low_confidence: !!result._low_confidence,
    } : null,
    pass: grade.pass,
    reason: grade.reason || null,
    confidence,
    score,
    geocodeFired,
    geocodeWinner,
    apiCalls: apiCallsThisTest,
    log,
  };
}

// ─── Per-test pretty print ───────────────────────────────────────────
function printTest(r) {
  const sep = '─'.repeat(60);
  console.log(sep);
  console.log(`TEST #${r.idx}: ${r.name}`);
  console.log(`Input: "${r.input}"`);
  console.log(`Expected name:   ${r.expected_name}`);
  console.log(`Expected street: ${r.expected_street}`);
  console.log('');
  if (r.returned) {
    console.log(`Returned name:    ${r.returned.name}`);
    console.log(`Returned address: ${r.returned.address || '(none)'}`);
  } else {
    console.log(`Returned: null`);
  }

  // Street match details
  const addr = r.returned ? (r.returned.address || '') : '';
  const streetRe = new RegExp('\\b' + r.expected_street + '\\b');
  const streetHit = streetRe.test(addr);
  console.log(`Street match: ${streetHit ? 'YES' : 'NO'} (expected ${r.expected_street}${streetHit ? '' : ', not found in returned address'})`);

  // Name match details
  if (r.returned) {
    const expLower = r.expected_name.toLowerCase();
    const nameHit = String(r.returned.name || '').toLowerCase().includes(expLower);
    console.log(`Name match:   ${nameHit ? 'YES (' + expLower + ' ✅)' : 'NO (' + expLower + ' not in returned name)'}`);
  } else {
    console.log(`Name match:   N/A (no result)`);
  }

  console.log(`Confidence: ${r.confidence || 'NONE'}${r.score != null ? ' (score: ' + r.score + ')' : ''}`);
  console.log(`Geocoding fired:  ${r.geocodeFired ? 'YES' : 'NO'}${r.geocodeWinner ? ' (WINNER)' : ''}`);
  console.log(`API calls: text=${r.apiCalls.textSearch} geocode=${r.apiCalls.geocode} nearby=${r.apiCalls.nearby}`);
  if (r.pass) {
    console.log(`Result: PASS ✅`);
  } else {
    console.log(`Result: FAIL ❌  — ${r.reason}`);
  }
  console.log(sep);
  console.log('');
}

// ─── Final summary ───────────────────────────────────────────────────
function printSummary(results) {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const sep = '═'.repeat(60);

  console.log('');
  console.log(sep);
  console.log('FINDPLACE V2 ACCURACY TEST RESULTS');
  console.log(sep);
  console.log(`Total: ${total}`);
  console.log(`PASSED: ${passed} (${Math.round(100 * passed / total)}%)`);
  console.log(`FAILED: ${failed} (${Math.round(100 * failed / total)}%)`);
  console.log('');

  const fails = results.filter((r) => !r.pass);
  if (fails.length) {
    console.log('Failed tests:');
    for (const f of fails) {
      const got = f.returned
        ? `${f.returned.name} at ${(f.returned.address || '(no address)').split(',')[0]}`
        : 'null';
      console.log(`  #${f.idx} ${f.name}`);
      console.log(`     Expected: ${f.expected_name} at ${f.expected_street}`);
      console.log(`     Got:      ${got}`);
      console.log(`     Reason:   ${f.reason}`);
    }
    console.log('');
  }

  // Geocoding stats
  const geoFired = results.filter((r) => r.geocodeFired).length;
  const geoWinner = results.filter((r) => r.geocodeWinner).length;
  console.log('Geocoding stats:');
  console.log(`  Fired:  ${geoFired} times`);
  console.log(`  Helped: ${geoWinner} times`);
  console.log('');

  // API costs
  const txtSum = results.reduce((a, r) => a + r.apiCalls.textSearch, 0);
  const geoSum = results.reduce((a, r) => a + r.apiCalls.geocode, 0);
  const nbySum = results.reduce((a, r) => a + r.apiCalls.nearby, 0);
  const cost = txtSum * 0.032 + geoSum * 0.005 + nbySum * 0.032;
  console.log('API calls:');
  console.log(`  Text Search:  ${txtSum}  ($${(txtSum * 0.032).toFixed(2)})`);
  console.log(`  Geocoding:    ${geoSum}  ($${(geoSum * 0.005).toFixed(2)})`);
  console.log(`  Nearby:       ${nbySum}  ($${(nbySum * 0.032).toFixed(2)})`);
  console.log(`  Total:        $${cost.toFixed(2)}`);
  console.log(sep);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('FINDPLACE V2 — 10 verified test cases');
  console.log(`Estimated under 2 minutes, under $2 in API calls.\n`);

  const results = [];
  for (const tc of TESTS) {
    const r = await runOne(tc);
    results.push(r);
    printTest(r);
    await sleep(DELAY_MS);
  }

  // Persist (without verbose log buffer)
  const slim = results.map((r) => ({ ...r, log: undefined }));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(slim, null, 2));
  console.log(`Full results: ${OUTPUT_FILE}\n`);

  printSummary(results);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

/* test_findplace.js
   ─────────────────────────────────────────────────────────────────
   Address + business-name accuracy test for findPlace().
   100 test cases covering restaurants, hotels, dental, auto repair,
   salons, gyms, retail, fast-food, coffee, entertainment, plus
   edge cases (no street number, address-only inputs, same-chain
   multiple locations, rebranded/ambiguous businesses).

   Usage:    node test_findplace.js
   Output:   stdout summary + test_findplace_results.json (per-case
             detail) + test_findplace.log (per-case console output)
   Cost:     ~$8-15 in Google API calls (text search + geocoding +
             nearby search).
   Time:     ~8 minutes (300ms throttle).
   Requires: GOOGLE_PLACES_API_KEY in .env

   PRECONDITION: googlePlaces.js must export findPlace.
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

const OUTPUT_FILE = path.join(__dirname, 'test_findplace_results.json');
const LOG_FILE    = path.join(__dirname, 'test_findplace.log');
const DELAY_MS    = 300;

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
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
function startCapture() {
  logBuffer = [];
  console.log   = (...a) => logBuffer.push(a.map(String).join(' '));
  console.warn  = (...a) => logBuffer.push('WARN: ' + a.map(String).join(' '));
  console.error = (...a) => logBuffer.push('ERROR: ' + a.map(String).join(' '));
}
function stopCapture() {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  return logBuffer.join('\n');
}

// ─── 100 test cases ──────────────────────────────────────────────────
const TESTS = [
  // RESTAURANTS — EASY (1-10)
  { idx:1,  input:'Rajni Indian Cuisine, 429 Commerce Dr, Madison, WI 53719', expectedName:'Rajni',      expectedStreet:429,  category:'Restaurants Easy' },
  { idx:2,  input:'Franklin Barbecue, 900 E 11th St, Austin, TX 78702',       expectedName:'Franklin',   expectedStreet:900,  category:'Restaurants Easy' },
  { idx:3,  input:'Nobu Restaurant, 105 Hudson St, New York, NY 10013',       expectedName:'Nobu',       expectedStreet:105,  category:'Restaurants Easy' },
  { idx:4,  input:'Uchi, 801 S Lamar Blvd, Austin, TX 78704',                 expectedName:'Uchi',       expectedStreet:801,  category:'Restaurants Easy' },
  { idx:5,  input:'Carbone, 181 Thompson St, New York, NY 10012',             expectedName:'Carbone',    expectedStreet:181,  category:'Restaurants Easy' },
  { idx:6,  input:'Zahav, 237 St James Pl, Philadelphia, PA 19106',           expectedName:'Zahav',      expectedStreet:237,  category:'Restaurants Easy' },
  { idx:7,  input:'Cosme, 35 E 21st St, New York, NY 10010',                  expectedName:'Cosme',      expectedStreet:35,   category:'Restaurants Easy' },
  { idx:8,  input:'Alinea, 1723 N Halsted St, Chicago, IL 60614',             expectedName:'Alinea',     expectedStreet:1723, category:'Restaurants Easy' },
  { idx:9,  input:'Le Bernardin, 155 W 51st St, New York, NY 10019',          expectedName:'Bernardin',  expectedStreet:155,  category:'Restaurants Easy' },
  { idx:10, input:'Bestia, 2121 E 7th Pl, Los Angeles, CA 90021',             expectedName:'Bestia',     expectedStreet:2121, category:'Restaurants Easy' },

  // RESTAURANTS — MEDIUM (11-20)
  { idx:11, input:'The Grill, 9560 Dayton Way, Beverly Hills, CA 90210',      expectedName:'Grill',      expectedStreet:9560, category:'Restaurants Medium' },
  { idx:12, input:'Republique, 624 S La Brea Ave, Los Angeles, CA 90036',     expectedName:'Republique', expectedStreet:624,  category:'Restaurants Medium' },
  { idx:13, input:'Bavel, 500 Mateo St, Los Angeles, CA 90013',               expectedName:'Bavel',      expectedStreet:500,  category:'Restaurants Medium' },
  { idx:14, input:'Olmsted, 659 Vanderbilt Ave, Brooklyn, NY 11238',          expectedName:'Olmsted',    expectedStreet:659,  category:'Restaurants Medium' },
  { idx:15, input:'Smyth, 177 N Ada St, Chicago, IL 60607',                   expectedName:'Smyth',      expectedStreet:177,  category:'Restaurants Medium' },
  { idx:16, input:'Oxomoco, 128 Greenpoint Ave, Brooklyn, NY 11222',          expectedName:'Oxomoco',    expectedStreet:128,  category:'Restaurants Medium' },
  { idx:17, input:'Lilia, 567 Union Ave, Brooklyn, NY 11211',                 expectedName:'Lilia',      expectedStreet:567,  category:'Restaurants Medium' },
  { idx:18, input:'Sqirl, 720 N Virgil Ave, Los Angeles, CA 90029',           expectedName:'Sqirl',      expectedStreet:720,  category:'Restaurants Medium' },
  { idx:19, input:'Superiority Burger, 119 Ave A, New York, NY 10009',        expectedName:'Superiority',expectedStreet:119,  category:'Restaurants Medium' },
  { idx:20, input:'Alma, 952 Commerce St, Nashville, TN 37203',               expectedName:'Alma',       expectedStreet:952,  category:'Restaurants Medium' },

  // HOTELS — EASY (21-30)
  { idx:21, input:'AmericInn by Wyndham Dodgeville, 3637 WI-23, Dodgeville, WI 53533', expectedName:'AmericInn',  expectedStreet:3637, category:'Hotels Easy' },
  { idx:22, input:'Hilton Garden Inn Oshkosh, 1355 W 20th Ave, Oshkosh, WI 54902',     expectedName:'Hilton',     expectedStreet:1355, category:'Hotels Easy' },
  { idx:23, input:'Marriott Marquis Times Square, 1535 Broadway, New York, NY 10036',  expectedName:'Marriott',   expectedStreet:1535, category:'Hotels Easy' },
  { idx:24, input:'The Pfister Hotel, 424 E Wisconsin Ave, Milwaukee, WI 53202',       expectedName:'Pfister',    expectedStreet:424,  category:'Hotels Easy' },
  { idx:25, input:'Ace Hotel New York, 20 W 29th St, New York, NY 10001',              expectedName:'Ace',        expectedStreet:20,   category:'Hotels Easy' },
  { idx:26, input:'Graduate Madison, 601 Langdon St, Madison, WI 53703',               expectedName:'Graduate',   expectedStreet:601,  category:'Hotels Easy' },
  { idx:27, input:'The Iron Horse Hotel, 500 W Florida St, Milwaukee, WI 53204',       expectedName:'Iron Horse', expectedStreet:500,  category:'Hotels Easy' },
  { idx:28, input:'Kimpton Journeyman Hotel, 310 E Chicago St, Milwaukee, WI 53202',   expectedName:'Journeyman', expectedStreet:310,  category:'Hotels Easy' },
  { idx:29, input:'Comfort Suites Oshkosh West, 1515 Planeview Dr, Oshkosh, WI 54904', expectedName:'Comfort',    expectedStreet:1515, category:'Hotels Easy' },
  { idx:30, input:'Cobblestone Suites Oshkosh, 1515 Planeview Dr, Oshkosh, WI 54904',  expectedName:'Cobblestone',expectedStreet:1515, category:'Hotels Easy' },

  // HOTELS — HARD (31-35)
  { idx:31, input:'Baymont by Wyndham Oshkosh Airport, 1581 W South Park Ave, Oshkosh, WI 54902', expectedName:'Baymont', expectedStreet:1581, category:'Hotels Hard' },
  { idx:32, input:'Wingate by Wyndham Oshkosh, 1800 S Koeller St, Oshkosh, WI 54902',             expectedName:'Wingate', expectedStreet:1800, category:'Hotels Hard' },
  { idx:33, input:'Quality Inn Oshkosh Aviation Park, 1495 W South Park Ave, Oshkosh, WI 54902', expectedName:'Quality', expectedStreet:1495, category:'Hotels Hard' },
  { idx:34, input:'La Quinta Inn and Suites Madison, 5217 E Terrace Dr, Madison, WI 53718',      expectedName:'Quinta',  expectedStreet:5217, category:'Hotels Hard' },
  { idx:35, input:'Hampton Inn Madison West, 1620 W Beltline Hwy, Madison, WI 53713',            expectedName:'Hampton', expectedStreet:1620, category:'Hotels Hard' },

  // DENTAL (36-40)
  { idx:36, input:'Madison Smiles Dentistry, 2702 International Ln, Madison, WI 53704',       expectedName:'Madison Smiles',     expectedStreet:2702, category:'Dental' },
  { idx:37, input:'Aspen Dental, 2801 E Washington Ave, Madison, WI 53704',                   expectedName:'Aspen',              expectedStreet:2801, category:'Dental' },
  { idx:38, input:'University Dental Associates, 280 N Midvale Blvd, Madison, WI 53705',      expectedName:'University Dental',  expectedStreet:280,  category:'Dental' },
  { idx:39, input:'Ideal Dental, 3241 W Airport Fwy, Irving, TX 75062',                       expectedName:'Ideal Dental',       expectedStreet:3241, category:'Dental' },
  { idx:40, input:'Smile Direct Club, 945 E 86th St, Indianapolis, IN 46240',                 expectedName:'Smile',              expectedStreet:945,  category:'Dental' },

  // AUTO REPAIR (41-45)
  { idx:41, input:'Jiffy Lube, 2202 S Park St, Madison, WI 53713',                            expectedName:'Jiffy',              expectedStreet:2202, category:'Auto Repair' },
  { idx:42, input:'Firestone Complete Auto Care, 2824 E Washington Ave, Madison, WI 53704',   expectedName:'Firestone',          expectedStreet:2824, category:'Auto Repair' },
  { idx:43, input:'Maaco Collision Repair, 1625 S Stoughton Rd, Madison, WI 53716',           expectedName:'Maaco',              expectedStreet:1625, category:'Auto Repair' },
  { idx:44, input:'Christian Brothers Automotive, 6020 Hwy 6 N, Houston, TX 77084',           expectedName:'Christian Brothers', expectedStreet:6020, category:'Auto Repair' },
  { idx:45, input:'Midas, 5805 Odana Rd, Madison, WI 53719',                                  expectedName:'Midas',              expectedStreet:5805, category:'Auto Repair' },

  // SALONS / SPAS (46-50)
  { idx:46, input:'Aveda Institute Madison, 22 N Carroll St, Madison, WI 53703',              expectedName:'Aveda',              expectedStreet:22,   category:'Salons' },
  { idx:47, input:'Great Clips, 750 S Gammon Rd, Madison, WI 53719',                          expectedName:'Great Clips',        expectedStreet:750,  category:'Salons' },
  { idx:48, input:'Sport Clips Haircuts, 7475 Mineral Point Rd, Madison, WI 53717',           expectedName:'Sport Clips',        expectedStreet:7475, category:'Salons' },
  { idx:49, input:'Drybar, 395 Santa Monica Pl, Santa Monica, CA 90401',                      expectedName:'Drybar',             expectedStreet:395,  category:'Salons' },
  { idx:50, input:'Gene Juarez Salon, 600 Pine St, Seattle, WA 98101',                        expectedName:'Gene Juarez',        expectedStreet:600,  category:'Salons' },

  // GYM / FITNESS (51-55)
  { idx:51, input:'LA Fitness, 1745 N Farwell Ave, Milwaukee, WI 53202',                      expectedName:'Fitness',            expectedStreet:1745, category:'Fitness' },
  { idx:52, input:'Orange Theory Fitness, 4813 E Washington Ave, Madison, WI 53704',          expectedName:'Orange',             expectedStreet:4813, category:'Fitness' },
  { idx:53, input:'Anytime Fitness, 6246 Mckee Rd, Fitchburg, WI 53719',                      expectedName:'Anytime',            expectedStreet:6246, category:'Fitness' },
  { idx:54, input:'CrossFit Madison, 2001 W Beltline Hwy, Madison, WI 53713',                 expectedName:'CrossFit',           expectedStreet:2001, category:'Fitness' },
  { idx:55, input:'Planet Fitness, 2702 Dryden Dr, Madison, WI 53704',                        expectedName:'Planet',             expectedStreet:2702, category:'Fitness' },

  // RETAIL (56-60)
  { idx:56, input:'REI Co-op, 2502 E Washington Ave, Madison, WI 53704',                      expectedName:'REI',                expectedStreet:2502, category:'Retail' },
  { idx:57, input:'Barnes and Noble, 7433 Mineral Point Rd, Madison, WI 53717',               expectedName:'Barnes',             expectedStreet:7433, category:'Retail' },
  { idx:58, input:'Guitar Center, 7475 Mineral Point Rd, Madison, WI 53717',                  expectedName:'Guitar',             expectedStreet:7475, category:'Retail' },
  { idx:59, input:"Trader Joes, 7116 Tree Line Dr, Madison, WI 53717",                        expectedName:'Trader',             expectedStreet:7116, category:'Retail' },
  { idx:60, input:'Whole Foods Market, 3313 University Ave, Madison, WI 53705',               expectedName:'Whole Foods',        expectedStreet:3313, category:'Retail' },

  // FAST FOOD CHAINS (61-65)
  { idx:61, input:'Chipotle Mexican Grill, 2438 E Washington Ave, Madison, WI 53704',         expectedName:'Chipotle',           expectedStreet:2438, category:'Fast Food' },
  { idx:62, input:'Starbucks, 4141 N Mayfair Rd, Wauwatosa, WI 53222',                        expectedName:'Starbucks',          expectedStreet:4141, category:'Fast Food' },
  { idx:63, input:"McDonald's, 3902 E Washington Ave, Madison, WI 53704",                     expectedName:'McDonald',           expectedStreet:3902, category:'Fast Food' },
  { idx:64, input:'Panera Bread, 3538 University Ave, Madison, WI 53705',                     expectedName:'Panera',             expectedStreet:3538, category:'Fast Food' },
  { idx:65, input:'Subway, 810 W Johnson St, Madison, WI 53706',                              expectedName:'Subway',             expectedStreet:810,  category:'Fast Food' },

  // NON-RESTAURANT BUSINESSES (66-70)
  { idx:66, input:'UW Health at The American Center, 1685 Highland Ave, Madison, WI 53705',   expectedName:'UW Health',          expectedStreet:1685, category:'Non-Restaurant' },
  { idx:67, input:"SSM Health St. Mary's Hospital, 700 S Park St, Madison, WI 53715",         expectedName:'Mary',               expectedStreet:700,  category:'Non-Restaurant' },
  { idx:68, input:'Epic Systems Corporation, 1979 Milky Way, Verona, WI 53593',               expectedName:'Epic',               expectedStreet:1979, category:'Non-Restaurant' },
  { idx:69, input:'American Family Insurance, 6000 American Pkwy, Madison, WI 53783',         expectedName:'American Family',    expectedStreet:6000, category:'Non-Restaurant' },
  { idx:70, input:'Unity Point Health, 1126 S 70th St, West Allis, WI 53214',                 expectedName:'Unity',              expectedStreet:1126, category:'Non-Restaurant' },

  // COFFEE SHOPS (71-75)
  { idx:71, input:'Colectivo Coffee, 2406 Monroe St, Madison, WI 53711',                      expectedName:'Colectivo',          expectedStreet:2406, category:'Coffee' },
  { idx:72, input:'Ancora Coffee, 112 King St, Madison, WI 53703',                            expectedName:'Ancora',             expectedStreet:112,  category:'Coffee' },
  { idx:73, input:'Intelligentsia Coffee, 53 W Jackson Blvd, Chicago, IL 60604',              expectedName:'Intelligentsia',     expectedStreet:53,   category:'Coffee' },
  { idx:74, input:'Blue Bottle Coffee, 300 Webster St, Oakland, CA 94607',                    expectedName:'Blue Bottle',        expectedStreet:300,  category:'Coffee' },
  { idx:75, input:'Stumptown Coffee Roasters, 128 SW 3rd Ave, Portland, OR 97204',            expectedName:'Stumptown',          expectedStreet:128,  category:'Coffee' },

  // ENTERTAINMENT / RECREATION (76-80)
  { idx:76, input:'Marcus Point Cinema, 7825 Big Sky Dr, Madison, WI 53719',                  expectedName:'Marcus',             expectedStreet:7825, category:'Entertainment' },
  { idx:77, input:'Kohl Center, 601 W Dayton St, Madison, WI 53715',                          expectedName:'Kohl',               expectedStreet:601,  category:'Entertainment' },
  { idx:78, input:'American Family Field, 1 Brewers Way, Milwaukee, WI 53214',                expectedName:'American Family',    expectedStreet:1,    category:'Entertainment' },
  { idx:79, input:'EAA AirVenture Museum, 3000 Poberezny Rd, Oshkosh, WI 54902',              expectedName:'EAA',                expectedStreet:3000, category:'Entertainment' },
  { idx:80, input:'House on the Rock, 5754 WI-23, Spring Green, WI 53588',                    expectedName:'House on the Rock',  expectedStreet:5754, category:'Entertainment' },

  // EDGE CASES — no street number (81-85)
  { idx:81, input:'Rajni Indian Cuisine, Madison WI',                                          expectedName:'Rajni',     expectedStreet:null, category:'No Street Number' },
  { idx:82, input:'Franklin Barbecue, Austin TX',                                              expectedName:'Franklin',  expectedStreet:null, category:'No Street Number' },
  { idx:83, input:'Alinea, Chicago IL',                                                        expectedName:'Alinea',    expectedStreet:null, category:'No Street Number' },
  { idx:84, input:'Nobu, New York NY',                                                         expectedName:'Nobu',      expectedStreet:null, category:'No Street Number' },
  { idx:85, input:'Starbucks, Seattle WA',                                                     expectedName:'Starbucks', expectedStreet:null, category:'No Street Number' },

  // EDGE CASES — address only no name (86-90)
  { idx:86, input:'429 Commerce Dr, Madison, WI 53719',                                        expectedName:'Rajni',              expectedStreet:429,  category:'Address Only' },
  { idx:87, input:'900 E 11th St, Austin, TX 78702',                                           expectedName:'Franklin',           expectedStreet:900,  category:'Address Only' },
  { idx:88, input:'1723 N Halsted St, Chicago, IL 60614',                                      expectedName:'Alinea',             expectedStreet:1723, category:'Address Only' },
  { idx:89, input:'601 W Dayton St, Madison, WI 53715',                                        expectedName:'Kohl',               expectedStreet:601,  category:'Address Only' },
  { idx:90, input:'5754 WI-23, Spring Green, WI 53588',                                        expectedName:'House on the Rock',  expectedStreet:5754, category:'Address Only' },

  // EDGE CASES — same chain multiple locations (91-95)
  { idx:91, input:'Starbucks, 2534 E Washington Ave, Madison, WI 53704',                       expectedName:'Starbucks',          expectedStreet:2534, category:'Chain Multi-Loc' },
  { idx:92, input:"McDonald's, 1901 S Park St, Madison, WI 53713",                             expectedName:'McDonald',           expectedStreet:1901, category:'Chain Multi-Loc' },
  { idx:93, input:'Subway, 2702 International Ln, Madison, WI 53704',                          expectedName:'Subway',             expectedStreet:2702, category:'Chain Multi-Loc' },
  { idx:94, input:'Chipotle Mexican Grill, 302 N Midvale Blvd, Madison, WI 53705',             expectedName:'Chipotle',           expectedStreet:302,  category:'Chain Multi-Loc' },
  { idx:95, input:'Great Clips, 2502 E Washington Ave, Madison, WI 53704',                     expectedName:'Great Clips',        expectedStreet:2502, category:'Chain Multi-Loc' },

  // HARD EDGE CASES (96-100)
  { idx:96, input:'Baymont by Wyndham Oshkosh Airport, 1581 W South Park Ave, Oshkosh, WI 54902', expectedName:'Baymont',         expectedStreet:1581, category:'Hard Edge' },
  { idx:97, input:'Don Q Inn, 3658 Vineyard Dr, Dodgeville, WI 53533',                         expectedName:'Don Q',              expectedStreet:3658, category:'Hard Edge' },
  { idx:98, input:'Governor Dodge State Park, 4175 WI-23, Dodgeville, WI 53533',               expectedName:'Governor Dodge',     expectedStreet:4175, category:'Hard Edge' },
  { idx:99, input:'Sweet Bee Company, 30506 Trilby Rd, Sorrento, FL 32776',                    expectedName:'Sweet Bee',          expectedStreet:30506,category:'Hard Edge' },
  { idx:100,input:'The Don Q Inn, 3658 Vineyard Dr, Dodgeville, WI 53533',                     expectedName:'Don Q',              expectedStreet:3658, category:'Hard Edge' },
];

// ─── Grading ─────────────────────────────────────────────────────────
function gradeResult(tc, result) {
  if (!result) return { pass: false, reason: 'findPlace returned null' };

  const returnedStreetMatch = (result.formatted_address || '').match(/^(\d+)/);
  const returnedStreet = returnedStreetMatch ? returnedStreetMatch[1] : null;

  const streetMatch = tc.expectedStreet === null
    || (returnedStreet === String(tc.expectedStreet));

  const returnedName = String(result.name || '').toLowerCase();
  const expectedWords = String(tc.expectedName)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const nameMatch = expectedWords.some((w) => returnedName.includes(w));

  if (streetMatch && nameMatch) return { pass: true };

  if (!streetMatch && !nameMatch) {
    return {
      pass: false,
      reason: `Wrong business: expected "${tc.expectedName}" at ${tc.expectedStreet}, got "${result.name}" at ${returnedStreet}`,
    };
  }
  if (!streetMatch) {
    return {
      pass: false,
      reason: `Wrong street: expected ${tc.expectedStreet}, got ${returnedStreet} (${result.name})`,
    };
  }
  return {
    pass: false,
    reason: `Wrong business: expected "${tc.expectedName}", got "${result.name}"`,
  };
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
  } catch (e) {
    err = e;
  }
  const log = stopCapture();

  const apiCallsThisTest = {
    textSearch: apiCounts.textSearch - beforeCounts.textSearch,
    geocode: apiCounts.geocode - beforeCounts.geocode,
    nearby: apiCounts.nearby - beforeCounts.nearby,
  };

  // Confidence + score from log
  const confLine = log.match(/(HIGH|MEDIUM|LOW) CONFIDENCE.*?score:\s*(\d+)/i);
  const confidence = confLine ? confLine[1].toUpperCase() : null;
  const score = confLine ? parseInt(confLine[2], 10) : null;

  // Geocoding fallback signals
  const geocodeFired = /trying geocoding fallback/.test(log);
  const geocodeWinner = /GEOCODE WINNER/.test(log);

  let grade;
  if (err) {
    grade = { pass: false, reason: 'Exception: ' + err.message };
  } else {
    grade = gradeResult(tc, result);
  }

  return {
    idx: tc.idx,
    input: tc.input,
    expectedName: tc.expectedName,
    expectedStreet: tc.expectedStreet,
    category: tc.category,
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

// ─── Reporting ───────────────────────────────────────────────────────
function pct(n, d) { return d ? `${Math.round(100 * n / d)}%` : '0%'; }

function printSummary(results) {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const sep = '═'.repeat(60);

  console.log('');
  console.log(sep);
  console.log('FINDPLACE ACCURACY TEST RESULTS');
  console.log(sep);
  console.log(`Total tests: ${total}`);
  console.log(`PASSED: ${passed} (${pct(passed, total)})`);
  console.log(`FAILED: ${failed} (${pct(failed, total)})`);
  console.log('');

  // Failed test detail
  const fails = results.filter((r) => !r.pass);
  if (fails.length) {
    console.log('FAILED TESTS:');
    for (const f of fails) {
      const got = f.returned
        ? `${f.returned.name} at ${(f.returned.address || '').split(',')[0]}`
        : 'null';
      console.log(`  #${f.idx} ${f.input.slice(0, 55)}${f.input.length > 55 ? '...' : ''}`);
      console.log(`     Expected: ${f.expectedName} at ${f.expectedStreet ?? '(any)'}`);
      console.log(`     Got:      ${got}`);
      console.log(`     Reason:   ${f.reason}`);
    }
    console.log('');
  }

  // Failure categories
  const categories = { wrongStreet: 0, wrongName: 0, returnedNull: 0, other: 0 };
  for (const f of fails) {
    const r = f.reason || '';
    if (r.includes('returned null')) categories.returnedNull++;
    else if (r.startsWith('Wrong street')) categories.wrongStreet++;
    else if (r.startsWith('Wrong business')) categories.wrongName++;
    else categories.other++;
  }
  console.log('FAILURE CATEGORIES:');
  console.log(`  Wrong street number:      ${categories.wrongStreet}`);
  console.log(`  Wrong business name:      ${categories.wrongName}`);
  console.log(`  findPlace returned null:  ${categories.returnedNull}`);
  console.log(`  Other:                    ${categories.other}`);
  console.log('');

  // Confidence distribution
  const conf = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
  for (const r of results) {
    if (r.confidence === 'HIGH') conf.HIGH++;
    else if (r.confidence === 'MEDIUM') conf.MEDIUM++;
    else if (r.confidence === 'LOW') conf.LOW++;
    else conf.NONE++;
  }
  console.log('CONFIDENCE SCORE DISTRIBUTION:');
  console.log(`  HIGH (>=100):              ${conf.HIGH} tests`);
  console.log(`  MEDIUM (60-99):            ${conf.MEDIUM} tests`);
  console.log(`  LOW (<60):                 ${conf.LOW} tests`);
  if (conf.NONE) console.log(`  NONE (no confidence in log): ${conf.NONE} tests`);
  console.log('');

  // Geocoding fallback
  const geoFired = results.filter((r) => r.geocodeFired).length;
  const geoWinner = results.filter((r) => r.geocodeWinner).length;
  console.log('GEOCODING FALLBACK:');
  console.log(`  Fired:                    ${geoFired} times`);
  console.log(`  Helped (became winner):   ${geoWinner} times`);
  console.log(`  Did not help:             ${geoFired - geoWinner} times`);
  console.log('');

  // Per-category accuracy
  const catGroups = {};
  for (const r of results) {
    if (!catGroups[r.category]) catGroups[r.category] = { pass: 0, total: 0 };
    catGroups[r.category].total++;
    if (r.pass) catGroups[r.category].pass++;
  }
  console.log('ACCURACY BY CATEGORY:');
  for (const [cat, g] of Object.entries(catGroups)) {
    console.log(`  ${cat.padEnd(22, ' ')}: ${g.pass}/${g.total} (${pct(g.pass, g.total)})`);
  }
  console.log('');

  // API calls + cost (Text Search $0.032, Geocoding $0.005, Nearby $0.032)
  const txtSum = results.reduce((a, r) => a + r.apiCalls.textSearch, 0);
  const geoSum = results.reduce((a, r) => a + r.apiCalls.geocode, 0);
  const nbySum = results.reduce((a, r) => a + r.apiCalls.nearby, 0);
  const cost = txtSum * 0.032 + geoSum * 0.005 + nbySum * 0.032;
  console.log('API CALLS MADE:');
  console.log(`  Google Text Search:       ${txtSum}  ($${(txtSum * 0.032).toFixed(2)})`);
  console.log(`  Google Geocoding:         ${geoSum}  ($${(geoSum * 0.005).toFixed(2)})`);
  console.log(`  Google Nearby Search:     ${nbySum}  ($${(nbySum * 0.032).toFixed(2)})`);
  console.log(`  Total cost:               $${cost.toFixed(2)}`);
  console.log(sep);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('FINDPLACE ACCURACY TEST');
  console.log(`Running ${TESTS.length} cases. Estimated ~8 minutes, ~$8-15 in API costs.\n`);

  const results = [];
  for (const tc of TESTS) {
    const labelInput = tc.input.length > 58 ? tc.input.slice(0, 55) + '...' : tc.input;
    const label = `[${String(tc.idx).padStart(3, ' ')}/${TESTS.length}] ${labelInput}`;
    process.stdout.write(label.padEnd(70, ' ') + ' ... ');

    const r = await runOne(tc);
    results.push(r);

    if (r.pass) {
      const conf = r.confidence ? ` conf:${r.confidence}` : '';
      const scr  = r.score != null ? ` score:${r.score}` : '';
      const geo  = r.geocodeFired ? ' [geo]' : '';
      console.log(`PASS ${conf}${scr}${geo}`);
    } else {
      console.log(`FAIL  ${r.reason}`);
    }
    await sleep(DELAY_MS);
  }

  // Persist per-case JSON (without the verbose log buffer to keep size sane)
  const slimResults = results.map((r) => ({ ...r, log: undefined }));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(slimResults, null, 2));

  // Persist per-case logs to a separate file
  const logContent = results.map((r) =>
    `═══ TEST #${r.idx}: ${r.input} ═══\n`
    + (r.log || '(no log captured)')
    + `\n\nResult: ${r.pass ? 'PASS' : 'FAIL — ' + r.reason}\n`
  ).join('\n');
  fs.writeFileSync(LOG_FILE, logContent);

  console.log(`\nFull results: ${OUTPUT_FILE}`);
  console.log(`Full logs:    ${LOG_FILE}`);

  printSummary(results);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

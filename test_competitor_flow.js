// Competitor flow test — calls production googlePlaces.js directly.
// No duplicate logic. Exact same code path as a real report.
// NAICS classification mirrors server.js /classify exactly:
//   Layer 0 → hotel patch → name fallback → specific types →
//   generic types → Claude classification fallback.
// Run: node test_competitor_flow.js [index]
require('dotenv').config({ path: __dirname + '/.env', override: true });

const places = require('./googlePlaces');
const placesTypeMapper = require('./placesTypeMapper');
const layer0 = require('./server_layer0');
const claudeEnricher = require('./claudeEnricher');
const naicsRouter = require('./naicsRouter');
const profileResolver = require('./profileResolver');

// naicsRouter must be loaded before use (same as server.js startup)
naicsRouter.load();

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const TESTS = [
  { input: "Kate's Bait and Sporting Goods, 3916 WI-23, Dodgeville, WI 53533, USA" },
  { input: "McDonald's, 1101 N Main St, Dodgeville, WI 53533, USA" },
  { input: 'Taco Bell, 1140 N Johns St, Dodgeville, WI 53533, USA' },
  { input: 'Rajni Indian Cuisine, 429 Commerce Dr, Madison, WI 53719, USA' },
  { input: 'AmericInn by Wyndham Dodgeville, 3637 WI-23, Dodgeville, WI 53533, USA' },
  { input: 'Access Community Health Centers Dodgeville Dental Clinic, 103 E Fountain St, Dodgeville, WI 53533, USA' },
  { input: 'Bear N Bee Family Salon, 1210 N Bequette St Suite C, Dodgeville, WI 53533, USA' },
  { input: 'Compeer Financial, 3448 WI-23, Dodgeville, WI 53533, USA' },
  { input: 'Johnson Block and Co, 2500 Business Park Rd, Mineral Point, WI 53565, USA' },
  { input: 'Kwik Trip, 115 S Iowa St, Dodgeville, WI 53533, USA' },
  { input: 'Kwik Trip, 1122 N Bequette St, Dodgeville, WI 53533, USA' },
  { input: 'Cricket Wireless Authorized Retailer, 3868 E Washington Ave, Madison, WI 53704, USA' },
];

async function runTest(INPUT) {
  const t0 = Date.now();

  // ═══════════════════════════════════════════════════════════════════
  // STEP 1 — Find the business
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 1: FIND THE BUSINESS');
  console.log('═'.repeat(70));
  console.log('Input:', INPUT);

  const placeStub = await places.findPlace(INPUT, API_KEY);
  if (!placeStub || !placeStub.place_id) {
    console.error('FATAL: findPlace returned nothing');
    return;
  }

  const details = await places.getDetails(placeStub.place_id, API_KEY);
  const lat = details.geometry && details.geometry.location ? details.geometry.location.lat : null;
  const lng = details.geometry && details.geometry.location ? details.geometry.location.lng : null;
  const googleTypes = Array.isArray(details.types) ? details.types : [];
  const subjectName = details.name || placeStub.name;
  const subjectAddress = details.formatted_address || '';
  const rating = typeof details.rating === 'number' ? details.rating : null;
  const reviewCount = typeof details.user_ratings_total === 'number' ? details.user_ratings_total : 0;

  console.log('Name:', subjectName);
  console.log('Address:', subjectAddress);
  console.log('Rating:', rating || '?', '|', reviewCount, 'reviews');
  console.log('Google types:', JSON.stringify(googleTypes));

  // ═══════════════════════════════════════════════════════════════════
  // STEP 2 — NAICS classification (mirrors server.js /classify exactly)
  //   Tier 0: layer0.classifyInput(INPUT)
  //   Tier 0.5: hotel keyword regex patch
  //   Tier 1: name fallback (input business name, then Google place name)
  //   Tier 2: specific Google types (dentist, lawyer, etc.)
  //   Tier 3: generic Google types (food, health, store, bar)
  //   Tier 4: Claude classification fallback
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 2: NAICS CLASSIFICATION');
  console.log('═'.repeat(70));

  let naics6 = null;
  let naicsSource = null;

  // Tier 0 — Layer 0 deterministic classifier (brand/chain/keyword)
  let layer0Result;
  try {
    layer0Result = layer0.classifyInput(INPUT);
  } catch (err) {
    layer0Result = {};
  }
  if (layer0Result.naics6) {
    naics6 = layer0Result.naics6;
    naicsSource = 'layer0:' + (layer0Result.mode || 'unknown');
    console.log('Layer 0: naics6=' + naics6 + ' mode=' + layer0Result.mode);
  }

  // Tier 0.5 — Hotel keyword regex patch (same as server.js)
  if (!naics6 && /\b(hotel|motel|inn)\b/i.test(INPUT)) {
    naics6 = '721110';
    naicsSource = 'hotel_keyword_patch';
    console.log('Hotel keyword patch: naics6=721110');
  }

  // Tier 1 — Name fallback: input business name first, then Google place name
  if (!naics6) {
    const inputNameMatch = INPUT.match(/^(.+?),\s*\d+\s+/);
    const businessNameFromInput = inputNameMatch ? inputNameMatch[1].trim() : INPUT;

    let named = placesTypeMapper.mapNameToNaics6(businessNameFromInput);
    let nameSource = 'input_business_name';
    if (!named && subjectName) {
      named = placesTypeMapper.mapNameToNaics6(subjectName);
      nameSource = 'place_name';
    }
    if (named) {
      naics6 = named.naics6;
      naicsSource = 'name_fallback:' + nameSource;
      console.log('Name fallback (' + nameSource + '): naics6=' + named.naics6 + ' token="' + named.matched_token + '"');
    }
  }

  // Tier 2 — Specific Google types (dentist, lawyer, supermarket, etc.)
  if (!naics6) {
    const specMatch = placesTypeMapper.mapSpecificType(googleTypes);
    if (specMatch) {
      naics6 = specMatch.naics6;
      naicsSource = 'specific_type';
      console.log('Specific type: naics6=' + specMatch.naics6 + ' type="' + specMatch.matched_type + '"');
    }
  }

  // Tier 3 — Generic Google types (food, health, store, school, bar)
  if (!naics6) {
    const genMatch = placesTypeMapper.mapGenericType(googleTypes);
    if (genMatch) {
      naics6 = genMatch.naics6;
      naicsSource = 'generic_type';
      console.log('Generic type: naics6=' + genMatch.naics6 + ' type="' + genMatch.matched_type + '"');
    }
  }

  // Tier 4 — Claude classification fallback (same as server.js Phase 5+)
  if (!naics6) {
    console.log('All deterministic tiers failed — calling Claude classification...');
    const claudeNaics = await claudeEnricher.classifyWithClaude(
      INPUT,
      subjectName,
      googleTypes
    );
    if (claudeNaics) {
      // OOS check — same as server.js
      const routedId = naicsRouter.lookupProfileId(claudeNaics);
      if (routedId && routedId.startsWith('OUT_OF_SCOPE_')) {
        console.error('OOS: Claude classified as ' + claudeNaics + ' → ' + routedId + ' (out of scope)');
        return;
      }
      naics6 = claudeNaics;
      naicsSource = 'claude_classification';
      console.log('Claude classify: naics6=' + claudeNaics);
    }
  }

  if (!naics6) {
    console.error('FATAL: Could not classify NAICS (all 5 tiers exhausted)');
    return;
  }

  // OOS check for deterministic tiers too
  const routedProfileId = naicsRouter.lookupProfileId(naics6);
  if (routedProfileId && routedProfileId.startsWith('OUT_OF_SCOPE_')) {
    console.error('OOS: naics6=' + naics6 + ' → ' + routedProfileId + ' (out of scope)');
    return;
  }

  const naics2 = String(naics6).substring(0, 2);
  console.log('NAICS:', naics6, '| Source:', naicsSource);

  const cityStateMatch = subjectAddress.match(/,\s*([^,]+),\s*([A-Z]{2})\s/);
  const city = cityStateMatch ? cityStateMatch[1].trim() : null;
  const state = cityStateMatch ? cityStateMatch[2].trim() : null;

  // ═══════════════════════════════════════════════════════════════════
  // STEP 3 — Build search query (production buildCompetitorQuery)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 3: BUILD SEARCH QUERY');
  console.log('═'.repeat(70));

  const allReviews = Array.isArray(details.reviews) ? details.reviews : [];
  const reviewTexts = allReviews.map((r) => String(r.text || ''));

  const t3 = Date.now();
  const query = await places.buildCompetitorQuery(
    subjectName, naics6, naics2, googleTypes, city, state, reviewTexts
  );
  console.log('Query:', query);
  console.log('Time:', (Date.now() - t3) + 'ms');

  // ═══════════════════════════════════════════════════════════════════
  // STEP 4 — Full competitor search (production fetchNearbyCompetitors)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 4: FETCH COMPETITORS (production)');
  console.log('═'.repeat(70));

  const t4 = Date.now();
  const result = await places.fetchNearbyCompetitors({
    placeId: placeStub.place_id,
    lat,
    lng,
    type: googleTypes[0] || null,
    apiKey: API_KEY,
    city,
    state,
    subjectName,
    businessName: subjectName,
    naics6,
    naics2,
    googleTypes,
    population: null,
  });
  console.log('fetchNearbyCompetitors:', (Date.now() - t4) + 'ms');

  if (!result) {
    console.error('FATAL: fetchNearbyCompetitors returned null');
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 5 — Display results
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('STEP 5: FINAL 5 COMPETITORS');
  console.log('═'.repeat(70));

  console.log('Query used:', result.competitor_query);
  console.log('Radius:', result.search_radius_miles + 'mi | Found:', result.competitor_count);

  const top5 = result.competitors_top5 || [];
  console.log('');
  for (let i = 0; i < top5.length; i++) {
    const c = top5[i];
    const dist = c.distance_meters != null ? (c.distance_meters / 1609.34).toFixed(1) + ' mi' : '? mi';
    console.log(`  ${i + 1}. ${c.name}`);
    console.log(`     ${dist} | ${c.rating || '?'}★ | ${c.review_count || 0} reviews`);
    console.log(`     ${c.address || c.formatted_address || '(unknown)'}`);
  }

  console.log('\nTotal time:', (Date.now() - t0) + 'ms');
}

async function main() {
  if (!API_KEY) { console.error('FATAL: GOOGLE_PLACES_API_KEY not set'); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('FATAL: ANTHROPIC_API_KEY not set'); process.exit(1); }

  // If index given, run just that test. Otherwise run all requested.
  const arg = process.argv[2];
  if (arg === 'all') {
    for (let i = 0; i < TESTS.length; i++) {
      console.log('\n\n' + '▓'.repeat(70));
      console.log('TEST ' + (i + 1) + '/' + TESTS.length + ': ' + TESTS[i].input.split(',')[0]);
      console.log('▓'.repeat(70));
      await runTest(TESTS[i].input);
    }
  } else {
    const idx = parseInt(arg, 10);
    if (!isNaN(idx) && idx >= 0 && idx < TESTS.length) {
      await runTest(TESTS[idx].input);
    } else {
      console.log('Usage: node test_competitor_flow.js <0-' + (TESTS.length - 1) + '|all>');
      for (let i = 0; i < TESTS.length; i++) console.log('  ' + i + ': ' + TESTS[i].input);
      process.exit(1);
    }
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

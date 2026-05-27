// test_crux_competitors.js
// Finds the top 5 hotel competitors near AmericInn Dodgeville,
// pulls each competitor's website from Google Places Details,
// extracts the origin, then queries the Chrome UX Report (CrUX) API
// for real-world PHONE performance data.
//
// Usage: node test_crux_competitors.js

'use strict';

const fs   = require('fs');
const path = require('path');

// Load .env before anything else so process.env is populated.
require('dotenv').config({ override: true });

const places = require('./googlePlaces');

// ── API key resolution ────────────────────────────────────────────────
// Tries settings_local.json first (root of project), then .env.
function getApiKey() {
  const settingsPath = path.join(__dirname, 'settings_local.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const k = s.GOOGLE_PLACES_API_KEY || s.google_places_api_key;
      if (k) {
        console.log('[key] loaded from settings_local.json');
        return k;
      }
    } catch (e) {
      console.warn('[key] settings_local.json parse error:', e.message);
    }
  }
  const envKey = process.env.GOOGLE_PLACES_API_KEY;
  if (envKey) {
    console.log('[key] loaded from .env');
    return envKey;
  }
  return null;
}

// ── Target business ───────────────────────────────────────────────────
const TARGET_QUERY   = 'AmericInn by Wyndham Dodgeville, 3637 WI-23, Dodgeville, WI 53533';
const TARGET_CITY    = 'Dodgeville';
const TARGET_STATE   = 'WI';
const TARGET_NAICS6  = '721110';   // Hotels (except Casino Hotels) and Motels
const TARGET_NAICS2  = '72';       // Accommodation and Food Services

// ── CrUX API ─────────────────────────────────────────────────────────
const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

// Thresholds: https://web.dev/articles/defining-core-web-vitals-thresholds
//   LCP  (ms)  good ≤ 2500  | needs work ≤ 4000  | slow > 4000
//   INP  (ms)  good ≤ 200   | needs work ≤ 500   | slow > 500
//   CLS (0-∞)  good ≤ 0.10  | needs work ≤ 0.25  | slow > 0.25

function lcpRating(ms) {
  if (ms <= 2500) return 'Fast';
  if (ms <= 4000) return 'Needs work';
  return 'Slow';
}
function inpRating(ms) {
  if (ms <= 200)  return 'Fast';
  if (ms <= 500)  return 'Needs work';
  return 'Slow';
}
function clsRating(v) {
  if (v <= 0.10)  return 'Fast';
  if (v <= 0.25)  return 'Needs work';
  return 'Slow';
}

// Linear score 0-100 per metric, then average for overall score.
function lcpScore(ms) {
  if (ms <= 2500) return 100;
  if (ms <= 4000) return Math.round(100 - 50 * (ms - 2500) / 1500);
  return Math.max(0, Math.round(50 * Math.max(0, 8000 - ms) / 4000));
}
function inpScore(ms) {
  if (ms <= 200)  return 100;
  if (ms <= 500)  return Math.round(100 - 50 * (ms - 200) / 300);
  return Math.max(0, Math.round(50 * Math.max(0, 1000 - ms) / 500));
}
function clsScore(v) {
  if (v <= 0.10)  return 100;
  if (v <= 0.25)  return Math.round(100 - 50 * (v - 0.10) / 0.15);
  return Math.max(0, Math.round(50 * Math.max(0, 0.50 - v) / 0.25));
}
function overallScore(lcpMs, inpMs, clsV) {
  return Math.round((lcpScore(lcpMs) + inpScore(inpMs) + clsScore(clsV)) / 3);
}
function overallLabel(score) {
  if (score >= 80) return 'Fast ✅';
  if (score >= 50) return 'Needs work ⚠️';
  return 'Slow ❌';
}

// ── Origin extraction ─────────────────────────────────────────────────
function extractOrigin(websiteUrl) {
  try {
    // Ensure the URL has a protocol so new URL() doesn't throw.
    const withProto = /^https?:\/\//i.test(websiteUrl)
      ? websiteUrl
      : 'https://' + websiteUrl;
    const u = new URL(withProto);
    return u.origin;   // e.g. "https://www.americinn.com"
  } catch {
    return null;
  }
}

// ── CrUX query ────────────────────────────────────────────────────────
async function queryCrux(origin, apiKey) {
  const url  = `${CRUX_ENDPOINT}?key=${apiKey}`;
  const body = {
    origin,
    formFactor: 'PHONE',
    metrics: [
      'largest_contentful_paint',
      'interaction_to_next_paint',
      'cumulative_layout_shift',
    ],
  };

  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ac.signal,
    });
    const json = await res.json();

    if (res.status === 404) {
      // Normal — origin exists but not enough Chrome traffic for CrUX.
      return { noData: true };
    }
    if (!res.ok) {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      return { error: msg };
    }
    return { record: json.record };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timeout after 15s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const API_KEY = getApiKey();
  if (!API_KEY) {
    console.error('\nERROR: No GOOGLE_PLACES_API_KEY found in settings_local.json or .env');
    process.exit(1);
  }
  console.log(`API key present, length: ${API_KEY.length}\n`);

  // ── Step 1: Find target business ──────────────────────────────────
  console.log(`Searching for: "${TARGET_QUERY}"`);
  const place = await places.findPlace(TARGET_QUERY, API_KEY);
  if (!place) {
    console.error('Could not find target business. Exiting.');
    process.exit(1);
  }
  console.log(`Found: ${place.name}`);
  console.log(`  Address:  ${place.formatted_address}`);
  console.log(`  place_id: ${place.place_id}`);

  // ── Step 2: Get details for lat/lng and google_types ─────────────
  const detail     = await places.getDetails(place.place_id, API_KEY);
  const fields     = places.toInputFields(detail);
  const nearbyType = places.pickNearbySearchType(fields.google_types || []);

  console.log(`  Lat/Lng:       ${fields.latitude}, ${fields.longitude}`);
  console.log(`  Google types:  ${(fields.google_types || []).join(', ')}`);
  console.log(`  Nearby type:   ${nearbyType || '(none)'}`);

  // ── Step 3: Fetch top 5 competitors ──────────────────────────────
  console.log('\nFetching top 5 nearby competitors...');
  const compResult = await places.fetchNearbyCompetitors({
    placeId:     place.place_id,
    lat:         fields.latitude,
    lng:         fields.longitude,
    type:        nearbyType,
    apiKey:      API_KEY,
    city:        TARGET_CITY,
    state:       TARGET_STATE,
    subjectName: place.name,
    businessName: place.name,
    naics6:      TARGET_NAICS6,
    naics2:      TARGET_NAICS2,
    googleTypes: fields.google_types,
    population:  null,
  });

  if (!compResult || !Array.isArray(compResult.competitors_top5) || compResult.competitors_top5.length === 0) {
    console.error('No competitors returned. Exiting.');
    process.exit(1);
  }
  const competitors = compResult.competitors_top5;
  console.log(`Found ${competitors.length} competitors  (search radius: ${compResult.search_radius_miles} mi)`);

  // ── Steps 4-7: Website → origin → CrUX for each competitor ───────
  console.log('\n' + '═'.repeat(72));
  console.log(' COMPETITOR CrUX RESULTS  (form factor: PHONE)');
  console.log('═'.repeat(72));

  for (let i = 0; i < competitors.length; i++) {
    const comp = competitors[i];
    console.log(`\n[${i + 1}] ${comp.name}`);
    console.log(`    Rating: ${comp.rating ?? 'N/A'}  |  Reviews: ${comp.review_count ?? 0}`);

    if (!comp.place_id) {
      console.log('    ⚠ No place_id — skipping');
      continue;
    }

    // Step 4: Website from Google Places Details
    let website = null;
    try {
      const det = await places.getDetails(comp.place_id, API_KEY);
      website = (det && typeof det.website === 'string' && det.website.trim())
        ? det.website.trim()
        : null;
    } catch (err) {
      console.log(`    ⚠ getDetails failed: ${err.message}`);
    }

    if (!website) {
      console.log('    Website: (none in Google Places)');
      console.log('    CrUX:    No CrUX data — no website');
      continue;
    }
    console.log(`    Website: ${website}`);

    // Step 5: Extract origin
    const origin = extractOrigin(website);
    if (!origin) {
      console.log('    ⚠ Could not extract origin from URL');
      console.log('    CrUX:    No CrUX data — bad URL');
      continue;
    }
    console.log(`    Origin:  ${origin}`);

    // Step 6: Call CrUX
    const crux = await queryCrux(origin, API_KEY);

    // Step 7: Print result
    if (crux.noData) {
      console.log('    CrUX:    No CrUX data — origin not in Chrome UX Report dataset');
      continue;
    }
    if (crux.error) {
      console.log(`    CrUX:    No CrUX data — ${crux.error}`);
      continue;
    }

    const metrics = crux.record?.metrics;
    if (!metrics) {
      console.log('    CrUX:    No CrUX data — empty record');
      continue;
    }

    const lcpP75 = metrics.largest_contentful_paint?.percentiles?.p75 ?? null;
    const inpP75 = metrics.interaction_to_next_paint?.percentiles?.p75 ?? null;
    const clsP75 = metrics.cumulative_layout_shift?.percentiles?.p75   ?? null;

    if (lcpP75 == null && inpP75 == null && clsP75 == null) {
      console.log('    CrUX:    No CrUX data — no p75 values in response');
      continue;
    }

    const lcpLine = lcpP75 != null
      ? `${lcpP75}ms → ${lcpRating(lcpP75)}`
      : 'N/A';
    const inpLine = inpP75 != null
      ? `${inpP75}ms → ${inpRating(inpP75)}`
      : 'N/A';
    const clsLine = clsP75 != null
      ? `${clsP75} → ${clsRating(clsP75)}`
      : 'N/A';

    const allPresent = lcpP75 != null && inpP75 != null && clsP75 != null;
    const score      = allPresent ? overallScore(lcpP75, inpP75, clsP75) : null;
    const label      = score != null ? overallLabel(score) : '(partial data)';

    console.log(`    LCP p75: ${lcpLine}`);
    console.log(`    INP p75: ${inpLine}`);
    console.log(`    CLS p75: ${clsLine}`);
    console.log(`    Score:   ${score != null ? score + '/100' : 'N/A'}  ${label}`);
  }

  console.log('\n' + '═'.repeat(72));
  console.log('Done.');
}

main().catch(console.error);

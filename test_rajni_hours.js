// test_rajni_hours.js
// Searches for Rajni Indian Cuisine in Madison WI, fetches its
// weekday_text plus the top 5 nearby competitors' weekday_text,
// then runs the exact parseHours logic from server.js to show
// what the hours table renders after the minutes fix.
//
// Usage: node test_rajni_hours.js

'use strict';

const fs   = require('fs');
const path = require('path');

require('dotenv').config({ override: true });

const places = require('./googlePlaces');

// ── API key resolution ────────────────────────────────────────────────
function getApiKey() {
  const settingsPath = path.join(__dirname, 'settings_local.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const k = s.GOOGLE_PLACES_API_KEY || s.google_places_api_key;
      if (k) { console.log('[key] loaded from settings_local.json'); return k; }
    } catch (e) {
      console.warn('[key] settings_local.json parse error:', e.message);
    }
  }
  const envKey = process.env.GOOGLE_PLACES_API_KEY;
  if (envKey) { console.log('[key] loaded from .env'); return envKey; }
  return null;
}

// ── Target business ───────────────────────────────────────────────────
const TARGET_QUERY  = 'Rajni Indian Cuisine, 429 Commerce Dr, Madison, WI 53719';
const TARGET_CITY   = 'Madison';
const TARGET_STATE  = 'WI';
const TARGET_NAICS6 = '722511';   // Full-Service Restaurants
const TARGET_NAICS2 = '72';       // Accommodation and Food Services

// ── parseHours - copied exactly from server.js renderHoursComparison ─
// Converts weekday_text array into compact 24h display strings.
// Includes the minutes fix: 2:30 PM renders as 14:30 not 14.
// Split hours (lunch + dinner) render as "11-14:30, 16:30-21".
function parseHours(weekdayText) {
  if (!Array.isArray(weekdayText)) return {};
  const result = {};
  for (const line of weekdayText) {
    if (typeof line !== 'string') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const day  = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (/closed/i.test(rest)) {
      result[day] = 'Cls';
      continue;
    }
    if (/24\s*hour|24-hour|always open|open 24/i.test(rest)) {
      result[day] = '24h';
      continue;
    }

    // Regex matches every AM/PM time range in the string.
    // AM/PM is optional on the open side — Google sometimes omits it on
    // the second period of a split-hours string (e.g. "4:30 – 9:00 PM").
    // Groups: 1=open_h 2=open_min? 3=open_ampm? 4=close_h 5=close_min? 6=close_ampm
    const timeRangeRe = /(\d+)(?::(\d+))?\s*(AM|PM)?\s*[-–—]+\s*(\d+)(?::(\d+))?\s*(AM|PM)/ig;
    const allRanges = [];
    let rm;
    while ((rm = timeRangeRe.exec(rest)) !== null) {
      const openH     = parseInt(rm[1], 10);
      const openMins  = rm[2] ? parseInt(rm[2], 10) : 0;
      const closeH    = parseInt(rm[4], 10);
      const closeMins = rm[5] ? parseInt(rm[5], 10) : 0;
      const openAmPm  = rm[3] ? rm[3].toUpperCase() : null;
      const closeAmPm = (rm[6] || '').toUpperCase();

      // Resolve close24 first so it is available when inferring openAmPm.
      let close24 = closeH;
      if (closeAmPm === 'PM' && closeH < 12) close24 += 12;
      if (closeAmPm === 'AM' && closeH === 12) close24 = 0;

      // Resolve open24. When openAmPm is absent infer from closeAmPm.
      let open24 = openH;
      if (openAmPm) {
        if (openAmPm === 'PM' && openH < 12) open24 += 12;
        if (openAmPm === 'AM' && openH === 12) open24 = 0;
      } else {
        const inferredAmPm = openH < closeH ? closeAmPm : 'PM';
        if (inferredAmPm === 'PM' && openH < 12) open24 += 12;
        if (inferredAmPm === 'AM' && openH === 12) open24 = 0;
      }

      const openStr  = openMins  > 0 ? `${open24}:${String(openMins).padStart(2, '0')}`  : `${open24}`;
      const closeStr = closeMins > 0 ? `${close24}:${String(closeMins).padStart(2, '0')}` : `${close24}`;
      allRanges.push(`${openStr}-${closeStr}`);
    }

    result[day] = allRanges.length > 0 ? allRanges.join(', ') : '-';
  }
  return result;
}

// ── Print a single business's hours block ─────────────────────────────
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function printHoursBlock(name, weekdayText) {
  console.log(`\n  Business : ${name}`);

  if (!Array.isArray(weekdayText) || weekdayText.length === 0) {
    console.log('  Raw      : (none returned by Google)');
    console.log('  Parsed   : (no data)');
    return;
  }

  console.log('  Raw weekday_text from Google:');
  for (const line of weekdayText) {
    console.log(`    ${line}`);
  }

  const parsed = parseHours(weekdayText);
  console.log('  Parsed (hours table display):');
  for (const day of DAYS) {
    const val = parsed[day] || '-';
    console.log(`    ${day.padEnd(10)} ${val}`);
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

  // ── Step 1: Find Rajni ───────────────────────────────────────────
  console.log(`Searching for: "${TARGET_QUERY}"`);
  const place = await places.findPlace(TARGET_QUERY, API_KEY);
  if (!place) {
    console.error('Could not find Rajni Indian Cuisine. Exiting.');
    process.exit(1);
  }
  console.log(`Found        : ${place.name}`);
  console.log(`Address      : ${place.formatted_address}`);
  console.log(`place_id     : ${place.place_id}`);

  // ── Step 2: Get full details for Rajni ──────────────────────────
  const detail = await places.getDetails(place.place_id, API_KEY);
  const fields  = places.toInputFields(detail);

  console.log(`Lat/Lng      : ${fields.latitude}, ${fields.longitude}`);
  console.log(`Google types : ${(fields.google_types || []).join(', ')}`);

  const nearbyType = places.pickNearbySearchType(fields.google_types || []);
  console.log(`Nearby type  : ${nearbyType || '(none)'}`);

  // ── Step 3: Fetch top 5 nearby competitors ───────────────────────
  console.log('\nFetching top 5 nearby competitors...');
  const compResult = await places.fetchNearbyCompetitors({
    placeId:      place.place_id,
    lat:          fields.latitude,
    lng:          fields.longitude,
    type:         nearbyType,
    apiKey:       API_KEY,
    city:         TARGET_CITY,
    state:        TARGET_STATE,
    subjectName:  place.name,
    businessName: place.name,
    naics6:       TARGET_NAICS6,
    naics2:       TARGET_NAICS2,
    googleTypes:  fields.google_types,
    population:   null,
  });

  if (!compResult || !Array.isArray(compResult.competitors_top5) || compResult.competitors_top5.length === 0) {
    console.error('No competitors returned. Exiting.');
    process.exit(1);
  }

  const competitors = compResult.competitors_top5;
  console.log(`Found ${competitors.length} competitors  (search radius: ${compResult.search_radius_miles} mi)`);

  // ── Step 4 & 5: Print hours for Rajni then each competitor ───────
  console.log('\n' + '═'.repeat(72));
  console.log(' HOURS TABLE PREVIEW  (what renderHoursComparison would display)');
  console.log('═'.repeat(72));

  // Rajni (subject business) - use weekday_text from toInputFields
  const rajniWeekdayText = fields.weekday_text || detail.opening_hours?.weekday_text || [];
  printHoursBlock(`${place.name}  [YOU]`, rajniWeekdayText);

  console.log('\n' + '─'.repeat(72));
  console.log(' COMPETITORS');
  console.log('─'.repeat(72));

  for (let i = 0; i < competitors.length; i++) {
    const comp = competitors[i];

    // weekday_text is attached by fetchNearbyCompetitors via getDetails.
    // If missing for any reason, fall back to a fresh getDetails call.
    let weekdayText = Array.isArray(comp.weekday_text) ? comp.weekday_text : null;

    if (!weekdayText) {
      console.log(`\n  [${i + 1}] ${comp.name} — weekday_text not on competitor object, fetching details...`);
      if (comp.place_id) {
        try {
          const det = await places.getDetails(comp.place_id, API_KEY);
          weekdayText = det.opening_hours?.weekday_text || [];
        } catch (err) {
          console.log(`      getDetails failed: ${err.message}`);
          weekdayText = [];
        }
      } else {
        weekdayText = [];
      }
    }

    const label = `[${i + 1}] ${comp.name}  (rating: ${comp.rating ?? 'N/A'}, reviews: ${comp.review_count ?? 0})`;
    printHoursBlock(label, weekdayText);
  }

  console.log('\n' + '═'.repeat(72));
  console.log('Done.');
}

main().catch(console.error);

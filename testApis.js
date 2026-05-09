// testApis.js — confirm 3 free APIs work end-to-end with no auth.
// Run with: node testApis.js

const TARGET = { name: 'Dodgeville WI', lat: 43.02, lon: -90.13, county_fips: '55049' };

function fmt(ms) {
  return `${ms}ms`;
}
function divider(label) {
  console.log('\n' + '═'.repeat(70));
  console.log(label);
  console.log('═'.repeat(70));
}

// ───────────────────────────────────────────────────────────────
// 1. Open-Meteo /v1/forecast — 16-day daily forecast
// ───────────────────────────────────────────────────────────────
async function testOpenMeteo() {
  divider('1. Open-Meteo /v1/forecast (16-day daily forecast)');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${TARGET.lat}&longitude=${TARGET.lon}&daily=temperature_2m_max,precipitation_sum&timezone=America/Chicago&forecast_days=16`;
  console.log('GET', url);
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    const dt = Date.now() - t0;
    if (!res.ok) {
      console.log(`✗ HTTP ${res.status} ${res.statusText} (${fmt(dt)})`);
      const text = await res.text();
      console.log('Response body (first 300):', text.slice(0, 300));
      return { ok: false };
    }
    const json = await res.json();
    const d = json.daily || {};
    const dates = d.time || [];
    const maxes = d.temperature_2m_max || [];
    const precip = d.precipitation_sum || [];

    if (!dates.length) {
      console.log(`✗ Status 200 but no daily.time array. Keys: ${Object.keys(json).join(', ')} (${fmt(dt)})`);
      return { ok: false };
    }

    console.log(`✓ Returned ${dates.length} days in ${fmt(dt)}`);
    console.log(`  Lat/Lon resolved: ${json.latitude}, ${json.longitude}`);
    console.log(`  Timezone: ${json.timezone}`);
    console.log(`  Temperature unit: ${(json.daily_units && json.daily_units.temperature_2m_max) || '°C (default)'}`);
    console.log('\n  Day-by-day max temp + precip:');
    for (let i = 0; i < dates.length; i++) {
      const t = maxes[i] != null ? maxes[i].toFixed(1) : '—';
      const p = precip[i] != null ? precip[i].toFixed(2) : '—';
      console.log(`    ${dates[i]}  max=${t}°  precip=${p}mm`);
    }
    return { ok: true, days: dates.length };
  } catch (err) {
    console.log(`✗ fetch threw: ${err.message} (${fmt(Date.now() - t0)})`);
    return { ok: false };
  }
}

// ───────────────────────────────────────────────────────────────
// 2. Overpass — fast food within 500m of Dodgeville
//    Hardened: explicit Accept + User-Agent headers, fallback mirror
//    on primary 4xx/5xx (mirrors the production fetchLocationSignals).
// ───────────────────────────────────────────────────────────────
const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
const OVERPASS_FALLBACK = 'https://overpass.kumi.systems/api/interpreter';

async function callOverpass(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'BizRadar/1.0 (business audit tool)',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  return res.json();
}

async function testOverpass() {
  divider('2. Overpass — fast food within 500m (hardened headers + fallback)');
  const query = `[out:json][timeout:10];node["amenity"="fast_food"](around:500,${TARGET.lat},${TARGET.lon});out;`;
  console.log('Query:', query);
  const body = 'data=' + encodeURIComponent(query);
  const t0 = Date.now();

  let json;
  let usedMirror;
  try {
    console.log('Trying primary:', OVERPASS_PRIMARY);
    json = await callOverpass(OVERPASS_PRIMARY, body);
    usedMirror = 'primary';
  } catch (err) {
    console.log(`  primary failed (${err.message.slice(0, 120)})`);
    console.log('Trying fallback:', OVERPASS_FALLBACK);
    try {
      json = await callOverpass(OVERPASS_FALLBACK, body);
      usedMirror = 'fallback';
    } catch (err2) {
      console.log(`✗ both mirrors failed (${fmt(Date.now() - t0)})`);
      console.log(`  fallback error: ${err2.message.slice(0, 200)}`);
      return { ok: false };
    }
  }

  const dt = Date.now() - t0;
  const elements = json.elements || [];
  console.log(`✓ Returned ${elements.length} fast-food node${elements.length === 1 ? '' : 's'} in ${fmt(dt)} (via ${usedMirror})`);
  if (elements.length) {
    console.log('\n  Sample (up to 5):');
    elements.slice(0, 5).forEach((el) => {
      const name = (el.tags && el.tags.name) || '(unnamed)';
      const cuisine = (el.tags && el.tags.cuisine) || '';
      console.log(`    • ${name}${cuisine ? ' [' + cuisine + ']' : ''}  @ ${el.lat}, ${el.lon}`);
    });
  }
  return { ok: true, count: elements.length, mirror: usedMirror };
}

// ───────────────────────────────────────────────────────────────
// 3. HUD residential construction permits — Iowa County WI (FIPS 55049)
//    Corrections from probe:
//      - layer index is /24/ (not /0/) — there's only 1 layer in this FS
//      - field GEOID is a string but accepts unquoted comparison too
//      - layer name: RESIDENTIAL_CONSTRUCTION_PERMITS_BY_COUNTY_22
//        (data through 2022, 267 fields per row, one row per county)
// ───────────────────────────────────────────────────────────────
async function testHud() {
  divider('3. HUD residential permits — Iowa County WI (FIPS 55049)');
  const params = new URLSearchParams({
    where: `GEOID='${TARGET.county_fips}'`,
    outFields: '*',
    f: 'json',
  });
  const url = `https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Residential_Construction_Permits_by_County/FeatureServer/24/query?${params.toString()}`;
  console.log('GET', url);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const dt = Date.now() - t0;
    if (!res.ok) {
      console.log(`✗ HTTP ${res.status} ${res.statusText} (${fmt(dt)})`);
      const text = await res.text();
      console.log('Response body (first 400):', text.slice(0, 400));
      return { ok: false };
    }
    const json = await res.json();
    if (json.error) {
      console.log(`✗ ArcGIS error: ${json.error.code} ${json.error.message} (${fmt(dt)})`);
      console.log('Details:', JSON.stringify(json.error.details).slice(0, 300));
      return { ok: false };
    }
    const features = json.features || [];
    console.log(`✓ Returned ${features.length} feature record${features.length === 1 ? '' : 's'} in ${fmt(dt)}`);
    if (features.length) {
      const attrs = features[0].attributes || {};
      const keys = Object.keys(attrs);
      console.log(`\n  Total fields on row 1: ${keys.length}`);
      console.log('\n  Identity fields:');
      ['OBJECTID', 'GEOID', 'STATE', 'COUNTY', 'NAME', 'STUSAB', 'STATE_NAME']
        .forEach((k) => { if (k in attrs) console.log(`    ${k} = ${attrs[k]}`); });

      // Find the most recent year columns (e.g. ALL_PERMITS_YYYY, SINGLE_FAMILY_PERMITS_YYYY).
      // Layer name suggests data through 2022; show the latest available year.
      const yearRe = /^(ALL_PERMITS|SINGLE_FAMILY_PERMITS|ALL_MULTIFAMILY_PERMITS)_(\d{4})$/;
      const years = new Set();
      keys.forEach((k) => {
        const m = k.match(yearRe);
        if (m) years.add(parseInt(m[2], 10));
      });
      const sortedYears = [...years].sort((a, b) => a - b);
      const latest = sortedYears[sortedYears.length - 1];
      console.log(`\n  Permit data spans ${sortedYears[0]}–${latest} (${sortedYears.length} years)`);
      if (latest) {
        console.log(`\n  Latest year (${latest}) for this county:`);
        ['ALL_PERMITS', 'SINGLE_FAMILY_PERMITS', 'ALL_MULTIFAMILY_PERMITS'].forEach((prefix) => {
          const k = `${prefix}_${latest}`;
          if (k in attrs) console.log(`    ${k} = ${attrs[k]}`);
        });
      }
    } else {
      console.log('  (no feature rows for this GEOID)');
    }
    return { ok: true, count: features.length };
  } catch (err) {
    console.log(`✗ fetch threw: ${err.message} (${fmt(Date.now() - t0)})`);
    return { ok: false };
  }
}

// ───────────────────────────────────────────────────────────────
(async () => {
  console.log('Testing 3 free APIs against', TARGET.name, `(${TARGET.lat}, ${TARGET.lon}, FIPS ${TARGET.county_fips})`);

  const results = {
    open_meteo: await testOpenMeteo(),
    overpass: await testOverpass(),
    hud: await testHud(),
  };

  divider('SUMMARY');
  console.log(`Open-Meteo: ${results.open_meteo.ok ? '✓ PASS' : '✗ FAIL'}${results.open_meteo.days ? ` — ${results.open_meteo.days} days returned` : ''}`);
  console.log(`Overpass:   ${results.overpass.ok ? '✓ PASS' : '✗ FAIL'}${typeof results.overpass.count === 'number' ? ` — ${results.overpass.count} fast-food nodes (via ${results.overpass.mirror})` : ''}`);
  console.log(`HUD:        ${results.hud.ok ? '✓ PASS' : '✗ FAIL'}${typeof results.hud.count === 'number' ? ` — ${results.hud.count} feature records` : ''}`);
})();

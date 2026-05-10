/* test_3_quick.js — quick 3-restaurant detection test
   Tests Junoon, Haidilao, Atomix (all NYC) through the new
   buildCompetitorQuery pipeline including the Layer 1.5 Claude
   web-search call. Prints layer fired, query built, PASS/FAIL.
*/
require('dotenv').config({ override: true });
const { buildCompetitorQuery } = require('./googlePlaces.js');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const TS = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const PD = 'https://maps.googleapis.com/maps/api/place/details/json';

const TESTS = [
  { name: 'Junoon',   city: 'New York', state: 'NY', expected: 'indian'  },
  { name: 'Haidilao', city: 'New York', state: 'NY', expected: 'chinese' },
  { name: 'Atomix',   city: 'New York', state: 'NY', expected: 'korean'  },
];

async function gJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Capture layer via console.log monkey-patch
async function runWithLayer(args) {
  let layer = null, logLine = null;
  const orig = console.log;
  console.log = (...a) => {
    const msg = a.map(String).join(' ');
    const m = msg.match(/→ layer:([\d.]+)/);
    if (m) { layer = m[1]; logLine = msg; }
    // Let cuisine-cache and claude+web logs through for visibility
    if (msg.includes('[cuisine-cache]') || msg.includes('claude+web') || msg.includes('claude returned')) {
      orig.call(console, '   ' + msg);
    }
  };
  let q;
  try {
    q = await buildCompetitorQuery.apply(null, args);
  } finally {
    console.log = orig;
  }
  return { query: q, layer, logLine };
}

function judge(query, expected) {
  const cuisine = query.split(' near ')[0].toLowerCase();
  const exp = expected.toLowerCase();
  if (exp === 'middleeastern' && cuisine.includes('middle eastern')) return 'PASS';
  return cuisine.includes(exp) ? 'PASS' : 'FAIL';
}

(async () => {
  for (const tc of TESTS) {
    console.log(`\n=== ${tc.name}, ${tc.city} ${tc.state} ===`);
    try {
      // Find subject
      const sUrl = `${TS}?query=${encodeURIComponent(`${tc.name} ${tc.city} ${tc.state}`)}&key=${API_KEY}`;
      const s = await gJSON(sUrl);
      const place = (s.results || [])[0];
      if (!place) { console.log('  NOT FOUND on Google'); continue; }

      // Get reviews
      const dUrl = `${PD}?place_id=${place.place_id}&fields=types,reviews,name&key=${API_KEY}`;
      const d = await gJSON(dUrl);
      const reviews = ((d.result || {}).reviews || []).map((r) => String(r.text || ''));
      const types = place.types || [];

      console.log(`  Subject: ${place.name}`);
      console.log(`  Google types: [${types.join(', ')}]`);
      console.log(`  Reviews fetched: ${reviews.length}`);

      const t0 = Date.now();
      const { query, layer, logLine } = await runWithLayer([
        tc.name, '722511', '72', types, tc.city, tc.state, reviews,
      ]);
      const dt = Date.now() - t0;

      const verdict = judge(query, tc.expected);
      console.log(`  Layer fired: ${layer || 'unknown'}`);
      console.log(`  Builder log: ${logLine || '(none captured)'}`);
      console.log(`  Query built: "${query}"`);
      console.log(`  Expected:    ${tc.expected}`);
      console.log(`  Time:        ${dt}ms`);
      console.log(`  Verdict:     ${verdict}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }
})();

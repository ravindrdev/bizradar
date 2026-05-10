/* test_5_quick.js — quick 5-restaurant detection test
   Tests Fish Cheeks (NY), Cosme (NY), Cote (NY), Au Cheval (Chicago),
   Zahav (Philadelphia) through buildCompetitorQuery including the
   Layer 1.5 Claude+web call. Prints layer, claude response, query, PASS/FAIL.
*/
require('dotenv').config({ override: true });
const { buildCompetitorQuery } = require('./googlePlaces.js');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const TS = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const PD = 'https://maps.googleapis.com/maps/api/place/details/json';

const TESTS = [
  { name: 'Fish Cheeks', city: 'New York',     state: 'NY', expected: 'thai'          },
  { name: 'Cosme',       city: 'New York',     state: 'NY', expected: 'mexican'       },
  { name: 'Cote',        city: 'New York',     state: 'NY', expected: 'korean'        },
  { name: 'Au Cheval',   city: 'Chicago',      state: 'IL', expected: 'burger'        },
  { name: 'Zahav',       city: 'Philadelphia', state: 'PA', expected: 'middleeastern' },
];

async function gJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function runWithLayer(args) {
  let layer = null, logLine = null, claudeRaw = null;
  const orig = console.log;
  console.log = (...a) => {
    const msg = a.map(String).join(' ');
    const m = msg.match(/→ layer:([\d.]+)/);
    if (m) { layer = m[1]; logLine = msg; }
    // Capture Claude's raw response when available
    const cm = msg.match(/cuisine:(\w+)/);
    if (cm && msg.includes('claude+web')) claudeRaw = cm[1];
    const cr = msg.match(/claude returned: "([^"]*)"/);
    if (cr) claudeRaw = cr[1] || '(empty)';
    if (msg.includes('claude+web failed')) claudeRaw = 'FAILED';
  };
  let q;
  try {
    q = await buildCompetitorQuery.apply(null, args);
  } finally {
    console.log = orig;
  }
  return { query: q, layer, logLine, claudeRaw };
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
      const sUrl = `${TS}?query=${encodeURIComponent(`${tc.name} ${tc.city} ${tc.state}`)}&key=${API_KEY}`;
      const s = await gJSON(sUrl);
      const place = (s.results || [])[0];
      if (!place) { console.log('  NOT FOUND on Google'); continue; }

      const dUrl = `${PD}?place_id=${place.place_id}&fields=types,reviews,name&key=${API_KEY}`;
      const d = await gJSON(dUrl);
      const reviews = ((d.result || {}).reviews || []).map((r) => String(r.text || ''));
      const types = place.types || [];

      console.log(`  Subject: ${place.name}`);
      console.log(`  Google types: [${types.join(', ')}]`);
      console.log(`  Reviews fetched: ${reviews.length}`);

      const t0 = Date.now();
      const { query, layer, claudeRaw } = await runWithLayer([
        tc.name, '722511', '72', types, tc.city, tc.state, reviews,
      ]);
      const dt = Date.now() - t0;

      const verdict = judge(query, tc.expected);
      console.log(`  Layer fired:     ${layer || 'unknown'}`);
      console.log(`  Claude returned: ${claudeRaw || '(no claude call — caught by L0/L1 first or claude path skipped)'}`);
      console.log(`  Query built:     "${query}"`);
      console.log(`  Expected:        ${tc.expected}`);
      console.log(`  Time:            ${dt}ms`);
      console.log(`  Verdict:         ${verdict}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }
})();

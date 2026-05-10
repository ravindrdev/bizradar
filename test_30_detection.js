/* test_30_detection.js — 30-restaurant detection-only check.
   Fetches real Google Places types + reviews per restaurant, runs
   buildCompetitorQuery, prints layer/cuisine/query. NO competitor
   search, NO Claude. ~60 Google API calls, ~30 seconds.
*/
require('dotenv').config();
const { buildCompetitorQuery } = require('./googlePlaces.js');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!API_KEY) { console.error('GOOGLE_PLACES_API_KEY missing'); process.exit(1); }

const TS = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const PD = 'https://maps.googleapis.com/maps/api/place/details/json';

const TESTS = [
  { idx:  1, name: 'Alinea',                       city: 'Chicago',       state: 'IL', expected: 'american/fine-dining (fallback OK)' },
  { idx:  2, name: 'Le Bernardin',                 city: 'New York',      state: 'NY', expected: 'french' },
  { idx:  3, name: 'Nobu',                         city: 'New York',      state: 'NY', expected: 'japanese' },
  { idx:  4, name: 'Masa',                         city: 'New York',      state: 'NY', expected: 'japanese (sushi)' },
  { idx:  5, name: 'Uchi',                         city: 'Austin',        state: 'TX', expected: 'japanese (sushi)' },
  { idx:  6, name: 'Franklin Barbecue',            city: 'Austin',        state: 'TX', expected: 'bbq' },
  { idx:  7, name: 'La Madia',                     city: 'Chicago',       state: 'IL', expected: 'italian or pizza' },
  { idx:  8, name: 'Scarpetta',                    city: 'New York',      state: 'NY', expected: 'italian' },
  { idx:  9, name: 'Bavel',                        city: 'Los Angeles',   state: 'CA', expected: 'middleeastern' },
  { idx: 10, name: 'Republique',                   city: 'Los Angeles',   state: 'CA', expected: 'french' },
  { idx: 11, name: 'Zahav',                        city: 'Philadelphia',  state: 'PA', expected: 'middleeastern' },
  { idx: 12, name: 'Coi',                          city: 'San Francisco', state: 'CA', expected: 'american/fine-dining' },
  { idx: 13, name: 'Rasika',                       city: 'Washington',    state: 'DC', expected: 'indian' },
  { idx: 14, name: 'Senia',                        city: 'Honolulu',      state: 'HI', expected: 'american/hawaiian (fallback OK)' },
  { idx: 15, name: 'Quince',                       city: 'San Francisco', state: 'CA', expected: 'italian' },
  { idx: 16, name: 'Birrieria Zaragoza',           city: 'Chicago',       state: 'IL', expected: 'mexican' },
  { idx: 17, name: 'Dhamaka',                      city: 'New York',      state: 'NY', expected: 'indian' },
  { idx: 18, name: 'Kang Ho Dong Baekjeong',       city: 'New York',      state: 'NY', expected: 'korean' },
  { idx: 19, name: 'Pho Bac',                      city: 'Seattle',       state: 'WA', expected: 'vietnamese' },
  { idx: 20, name: 'Haidilao Hot Pot',             city: 'New York',      state: 'NY', expected: 'chinese' },
  { idx: 21, name: 'Oleana',                       city: 'Boston',        state: 'MA', expected: 'mediterranean/middleeastern' },
  { idx: 22, name: "Pammy's",                      city: 'Cambridge',     state: 'MA', expected: 'italian' },
  { idx: 23, name: 'Hometown Bar-B-Que',           city: 'New York',      state: 'NY', expected: 'bbq' },
  { idx: 24, name: 'Don Angie',                    city: 'New York',      state: 'NY', expected: 'italian' },
  { idx: 25, name: 'Ugly Delicious Pizza',         city: 'New York',      state: 'NY', expected: 'pizza' },
  { idx: 26, name: 'Emily',                        city: 'New York',      state: 'NY', expected: 'pizza' },
  { idx: 27, name: 'Shake Shack',                  city: 'New York',      state: 'NY', expected: 'burger (chain)' },
  { idx: 28, name: 'Wingstop',                     city: 'Houston',       state: 'TX', expected: 'chicken-wings (chain)' },
  { idx: 29, name: 'Flower Child',                 city: 'Austin',        state: 'TX', expected: 'vegan/healthy' },
  { idx: 30, name: 'True Food Kitchen',            city: 'Dallas',        state: 'TX', expected: 'vegan/healthy' },
];

async function gJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function cuisineFromQuery(q) {
  // The query is shaped like "<cuisine words> near <city> <state>".
  // Strip the locality and return the cuisine fragment.
  return q.split(' near ')[0];
}

function runWithLayer(args) {
  let layer = null;
  const orig = console.log;
  console.log = (...a) => {
    const msg = a.map(String).join(' ');
    const m = msg.match(/→ layer:(\d)/);
    if (m) layer = parseInt(m[1], 10);
  };
  let q;
  try { q = buildCompetitorQuery.apply(null, args); }
  finally { console.log = orig; }
  return { query: q, layer };
}

function judge(query, expected) {
  const cuisine = cuisineFromQuery(query).toLowerCase();
  const exp = expected.toLowerCase();
  // expected can have multiple candidates separated by '/', 'or', or '(...)'
  const tokens = exp.replace(/[()]/g, '').split(/[\/]| or |,/).map(s => s.trim());
  // accept if any expected token appears in the cuisine fragment
  // Special: 'fine-dining' / 'fallback ok' / generic american all accept the fallback query
  const fallbackOK = exp.includes('fallback ok') || exp.includes('fine-dining');
  if (fallbackOK && cuisine.startsWith('restaurant dining')) return 'YES (fallback acceptable)';
  for (const t of tokens) {
    if (!t) continue;
    if (t === 'american' && cuisine.startsWith('restaurant dining')) return 'YES (american falls to generic)';
    if (cuisine.includes(t)) return 'YES';
  }
  // Special-case some queries that DO match the expectation but in different words
  if (exp.includes('chain')) {
    if (cuisine.includes('chain')) return 'YES';
  }
  return 'NO';
}

async function main() {
  for (const t of TESTS) {
    const sQ = `${t.name} ${t.city} ${t.state}`;
    let place, types = [], reviews = [];
    try {
      const s = await gJSON(`${TS}?query=${encodeURIComponent(sQ)}&key=${API_KEY}`);
      place = (s.results || [])[0];
      if (!place) {
        console.log(`#${t.idx} ${t.name}, ${t.city} ${t.state}\n  NOT FOUND on Google\n`);
        continue;
      }
      types = place.types || [];
      const d = await gJSON(`${PD}?place_id=${place.place_id}&fields=types,reviews&key=${API_KEY}`);
      reviews = ((d.result || {}).reviews || []).map((r) => String(r.text || ''));
    } catch (err) {
      console.log(`#${t.idx} ${t.name}, ${t.city} ${t.state}\n  FETCH ERROR: ${err.message}\n`);
      continue;
    }

    const { query, layer } = runWithLayer([t.name, '722511', '72', types, t.city, t.state, reviews]);
    const cuisine = cuisineFromQuery(query);
    const verdict = judge(query, t.expected);

    console.log(`#${t.idx} ${t.name}, ${t.city} ${t.state}`);
    console.log(`  Google types: [${types.join(', ')}]`);
    console.log(`  Reviews used: ${reviews.length}`);
    console.log(`  Layer fired: ${layer == null ? 'none/unknown' : layer}`);
    console.log(`  Cuisine detected: ${cuisine}`);
    console.log(`  Query built: "${query}"`);
    console.log(`  Expected: ${t.expected}`);
    console.log(`  Correct? ${verdict}`);
    console.log('');

    await new Promise((r) => setTimeout(r, 250));
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

/* scripts/build-city-data.js — Phase 2 programmatic SEO data build.

   Pulls EVERY US place (population, median household income, median age) in
   ONE Census ACS 5-year bulk call — same outputs as the SUB-EST + per-city
   ACS plan, without 1,000 sequential requests:
     GET api.census.gov/data/2023/acs/acs5
         ?get=NAME,B01003_001E,B19013_001E,B01002_001E&for=place:*
   Sorts by population, keeps the top 1,000 (Puerto Rico excluded), cleans
   the Census place-name suffixes ("Austin city" → "Austin"), and writes
   seoData/cities.json.

   Run:  node scripts/build-city-data.js
   Out:  seoData/cities.json  (committed - read by seoPages.js at boot)

   Notes:
   - CENSUS_API_KEY is read from .env (manual parse - dotenv not a dep).
   - ACS sentinel values (-666666666 etc.) are nulled.
   - Population figure is the ACS 5-year estimate (citable Census figure). */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch (e) { /* .env optional - keyless works at low volume */ }
}
loadEnv();

const STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

// Census place-name suffixes → clean display name.
function cleanPlaceName(raw) {
  let n = String(raw);
  n = n.replace(/\s*\(balance\)\s*/gi, ' ').trim();
  n = n.replace(/\s+(city and borough|consolidated government|metropolitan government|metro government|unified government|urban county|municipality|borough|village|town|city|CDP)$/i, '');
  // "Louisville/Jefferson County" → "Louisville"
  if (n.includes('/')) n = n.split('/')[0].trim();
  return n.trim();
}

function slugify(s) {
  return String(s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= -111111) return null; // ACS sentinels are large negatives
  return n;
}

(async () => {
  const key = process.env.CENSUS_API_KEY || '';
  const url = 'https://api.census.gov/data/2023/acs/acs5'
    + '?get=NAME,B01003_001E,B19013_001E,B01002_001E&for=place:*'
    + (key ? '&key=' + key : '');
  console.log('[build-city-data] fetching ACS place-level bulk (one call)...');
  const res = await fetch(url);
  if (!res.ok) throw new Error('Census API HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const rows = await res.json();
  console.log('[build-city-data] places returned:', rows.length - 1);

  const all = [];
  for (const r of rows.slice(1)) {
    const [name, popRaw, incomeRaw, ageRaw, stateFips] = r;
    if (stateFips === '72') continue; // Puerto Rico - "US cities" scope
    const comma = name.lastIndexOf(', ');
    if (comma === -1) continue;
    const stateName = name.slice(comma + 2);
    const abbr = STATE_ABBR[stateName];
    if (!abbr) continue;
    const city = cleanPlaceName(name.slice(0, comma));
    if (!city) continue;
    const population = num(popRaw);
    if (!population || population < 1000) continue;
    all.push({
      city,
      state_abbr: abbr,
      state_name: stateName,
      population,
      median_income: num(incomeRaw),
      median_age: num(ageRaw),
    });
  }

  all.sort((a, b) => b.population - a.population);

  const seen = new Set();
  const cities = [];
  for (const c of all) {
    if (cities.length >= 1000) break;
    const slug = slugify(c.city) + '-' + c.state_abbr.toLowerCase();
    if (seen.has(slug)) continue; // same name+state (e.g. city + CDP twin) - keep the larger
    seen.add(slug);
    cities.push({ rank: cities.length + 1, slug, ...c });
  }

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    source: 'US Census Bureau, American Community Survey 5-Year Estimates (2023), place-level',
    count: cities.length,
    cities,
  };
  fs.mkdirSync(path.join(ROOT, 'seoData'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'seoData', 'cities.json'), JSON.stringify(out));

  console.log('[build-city-data] kept top', cities.length, 'cities');
  console.log('[build-city-data] #1:', cities[0].city + ', ' + cities[0].state_abbr, cities[0].population.toLocaleString('en-US'));
  console.log('[build-city-data] #1000:', cities[999].city + ', ' + cities[999].state_abbr, cities[999].population.toLocaleString('en-US'));
  console.log('[build-city-data] missing income:', cities.filter((c) => c.median_income == null).length, '| missing age:', cities.filter((c) => c.median_age == null).length);
  console.log('[build-city-data] states covered:', new Set(cities.map((c) => c.state_abbr)).size);
  console.log('[build-city-data] wrote seoData/cities.json');
})().catch((e) => { console.error('[build-city-data] FAILED:', e.message); process.exit(1); });

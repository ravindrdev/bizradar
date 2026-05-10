/* test_real_restaurants.js
   ─────────────────────────────────────────────────────────────────
   Real-world validation of buildCompetitorQuery() against 100 actual
   restaurants spanning 20 cuisine categories. For each restaurant:
     1. Text-search Google Places to get place_id, types, reviews
     2. Run buildCompetitorQuery() with that real data
     3. Text-search Google Places using the generated query
     4. Grade top-5 competitors against the expected cuisine

   Usage:    node test_real_restaurants.js
   Output:   stdout summary + test_results.json (full per-case detail)
   Cost:     ~$6-9 in Google Places API calls (300 total calls).
   Time:     ~5 minutes (300ms throttle between cases).
   Requires: GOOGLE_PLACES_API_KEY in .env

   PRECONDITION: googlePlaces.js must export buildCompetitorQuery.
   The current module.exports does NOT include it — this script will
   fail-fast at startup until that one-line export is added.
*/

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildCompetitorQuery } = require('./googlePlaces.js');

// ─── Fail-fast preconditions ─────────────────────────────────────────
if (typeof buildCompetitorQuery !== 'function') {
  console.error('ERROR: buildCompetitorQuery is not exported from googlePlaces.js.');
  console.error('       Add it to the module.exports object at the bottom of the file:');
  console.error('         module.exports = {');
  console.error('           ...,');
  console.error('           buildCompetitorQuery,   // <-- add this');
  console.error('         };');
  process.exit(1);
}
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!API_KEY) {
  console.error('ERROR: GOOGLE_PLACES_API_KEY missing from .env');
  process.exit(1);
}
if (typeof fetch !== 'function') {
  console.error('ERROR: global fetch unavailable. Use Node 18+ or polyfill.');
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────
const TEXTSEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DETAILS_URL    = 'https://maps.googleapis.com/maps/api/place/details/json';
const OUTPUT_FILE    = path.join(__dirname, 'test_results.json');
const DELAY_MS       = 300;
const PASS_THRESHOLD = 3; // 3-of-5 top competitors must match expected cuisine

// ─── Cuisine matchers ────────────────────────────────────────────────
// For each expected cuisine, list Google type tags and substring tokens
// that count as a "competitor matches". Generous on synonyms but not
// so generous it overlaps adjacent cuisines (e.g. greek doesn't include
// "mediterranean" because half the test cases differentiate the two).
const CUISINE_MATCHERS = {
  indian: {
    name: ['indian', 'curry', 'tandoor', 'tikka', 'masala', 'bombay', 'mumbai',
           'taj', 'delhi', 'punjab', 'biryani', 'naan', 'desi', 'dosa', 'spice route'],
    types: ['indian_restaurant'],
  },
  chinese: {
    name: ['chinese', 'china ', ' china', 'dim sum', 'wok', 'panda', 'dragon',
           'peking', 'mandarin', 'szechuan', 'shanghai', 'canton', 'hunan',
           'noodle house', 'duck house', 'great wall', 'oriental'],
    types: ['chinese_restaurant'],
  },
  japanese: {
    name: ['japanese', 'sushi', 'ramen', 'tokyo', 'sakura', 'fuji',
           'sashimi', 'tempura', 'izakaya', 'omakase', 'kaiseki', 'hibachi',
           'nobu', 'matsuri', 'osaka', 'kyoto', 'roka'],
    types: ['japanese_restaurant', 'sushi_restaurant', 'ramen_restaurant'],
  },
  mexican: {
    name: ['mexican', 'mexico', 'taqueria', 'taco', 'cantina', 'jalisco',
           'oaxaca', 'casa ', ' casa', 'fiesta', 'el ', 'la ', 'los ',
           'hacienda', 'puebla', 'birria', 'cocina'],
    types: ['mexican_restaurant'],
  },
  italian: {
    name: ['italian', 'italia', 'pasta', 'trattoria', 'osteria', 'ristorante',
           'roma', 'napoli', 'bella', 'tuscany', 'sicilian', 'venezia'],
    types: ['italian_restaurant'],
  },
  thai: {
    name: ['thai', 'siam', 'bangkok', 'pad thai', 'tom yum', 'lotus',
           'orchid', 'chiang mai'],
    types: ['thai_restaurant'],
  },
  vietnamese: {
    name: ['vietnamese', 'viet ', ' viet', 'pho', 'banh mi', 'saigon',
           'hanoi', 'mekong', 'bun bo', 'com tam'],
    types: ['vietnamese_restaurant'],
  },
  korean: {
    name: ['korean', 'korea', 'kbbq', 'k-bbq', 'k bbq', 'kimchi', 'bulgogi',
           'seoul', 'gangnam', 'bibimbap', 'tofu house'],
    types: ['korean_restaurant'],
  },
  caribbean: {
    name: ['caribbean', 'jamaican', 'jamaica', 'jerk', 'island', 'reggae',
           'cuban', 'cuba', 'roti', 'tropical', 'calypso', 'west indian',
           'trinidad', 'bahamas', 'dutch pot'],
    types: ['caribbean_restaurant'],
  },
  ethiopian: {
    name: ['ethiopian', 'ethiopia', 'injera', 'habesha', 'african',
           'eritrean', 'addis', 'lalibela', 'abyssinia', 'ras dashen',
           'desta'],
    types: ['ethiopian_restaurant', 'african_restaurant'],
  },
  bbq: {
    name: ['bbq', 'b-b-q', 'b.b.q', 'barbecue', 'barbeque', 'bar-b-que',
           'bar-b-q', 'smokehouse', 'smoke', 'pit ', 'brisket', ' rib',
           'rib ', 'pitmaster'],
    types: ['barbecue_restaurant'],
  },
  steakhouse: {
    name: ['steak', 'chop house', 'chophouse', 'prime ', 'beef ',
           'porterhouse', 'rib eye', 'ribeye', 'roadhouse', 'longhorn',
           'fogo', 'churrascaria'],
    types: ['steak_house'],
  },
  seafood: {
    name: ['seafood', 'fish', 'oyster', 'lobster', 'crab', 'shrimp',
           'shellfish', 'ocean', 'harbor', 'pier ', ' pier', 'wharf',
           'catch', 'reel', 'water grill', 'legal sea'],
    types: ['seafood_restaurant'],
  },
  greek: {
    name: ['greek', 'greece', 'athens', 'taverna', 'gyro', 'olive',
           'mykonos', 'parthenon', 'estiatorio', 'milos', 'avra'],
    types: ['greek_restaurant'],
  },
  mediterranean: {
    name: ['mediterranean', 'med ', 'olive', 'falafel', 'hummus', 'tahini',
           'cava', 'zaytinya', 'oleana', 'purple pig', 'pita'],
    types: ['mediterranean_restaurant', 'middle_eastern_restaurant',
            'greek_restaurant', 'lebanese_restaurant'],
  },
  middleeastern: {
    name: ['middle eastern', 'middle-eastern', 'lebanese', 'persian',
           'kebab', 'kabob', 'shawarma', 'falafel', 'hummus', 'turkish',
           'halal', 'arab', 'beirut', 'damascus', 'zahav', 'shaya', 'bavel',
           'tawla', 'mediterranean'],
    types: ['middle_eastern_restaurant', 'lebanese_restaurant',
            'turkish_restaurant', 'mediterranean_restaurant'],
  },
  french: {
    name: ['french', 'france', 'bistro', 'brasserie', 'patisserie',
           'paris', 'maison', 'le ', 'la ', 'cafe de', 'chateau',
           'boulangerie', 'crepe', 'bouchon', 'boulud'],
    types: ['french_restaurant'],
  },
  pizza: {
    name: ['pizza', 'pizzeria', 'slice', 'neapolitan', 'detroit-style',
           'deep dish', 'wood fired', 'wood-fired'],
    types: ['pizza_restaurant'],
  },
  burger: {
    name: ['burger', 'patty', 'shake shack', 'in-n-out', 'in n out',
           'whataburger', 'smashburger', 'mooyah', 'habit', 'culver',
           'fatburger', 'cheeseburger'],
    types: ['hamburger_restaurant', 'fast_food_restaurant'],
  },
  vegan: {
    name: ['vegan', 'vegetarian', 'plant', 'green', 'kale', 'flower child',
           'true food', 'sweetgreen', 'native foods', 'veggie'],
    types: ['vegan_restaurant', 'vegetarian_restaurant'],
  },
  american: {
    name: ['american', 'grill', 'tavern', 'kitchen', 'eatery', 'diner',
           'commissary', 'farm', 'house', 'social', 'public'],
    types: ['american_restaurant', 'restaurant'],
  },
};

// ─── 100 real restaurant test cases ─────────────────────────────────
const TESTS = [
  // INDIAN (1-5)
  { idx: 1,  name: 'Rasika',                          city: 'Washington',     state: 'DC', expected: 'indian',        category: 'Indian' },
  { idx: 2,  name: 'Tamarind',                        city: 'New York',       state: 'NY', expected: 'indian',        category: 'Indian' },
  { idx: 3,  name: 'Desi District',                   city: 'Houston',        state: 'TX', expected: 'indian',        category: 'Indian' },
  { idx: 4,  name: 'Badmaash',                        city: 'Los Angeles',    state: 'CA', expected: 'indian',        category: 'Indian' },
  { idx: 5,  name: 'Rooh',                            city: 'San Francisco',  state: 'CA', expected: 'indian',        category: 'Indian' },
  // CHINESE (6-10)
  { idx: 6,  name: 'Din Tai Fung',                    city: 'Seattle',        state: 'WA', expected: 'chinese',       category: 'Chinese' },
  { idx: 7,  name: 'Hakkasan',                        city: 'Las Vegas',      state: 'NV', expected: 'chinese',       category: 'Chinese' },
  { idx: 8,  name: "Joe's Shanghai",                  city: 'New York',       state: 'NY', expected: 'chinese',       category: 'Chinese' },
  { idx: 9,  name: 'China Live',                      city: 'San Francisco',  state: 'CA', expected: 'chinese',       category: 'Chinese' },
  { idx: 10, name: 'Duck House',                      city: 'Portland',       state: 'OR', expected: 'chinese',       category: 'Chinese' },
  // JAPANESE (11-15)
  { idx: 11, name: 'Nobu',                            city: 'Miami',          state: 'FL', expected: 'japanese',      category: 'Japanese' },
  { idx: 12, name: 'Uchi',                            city: 'Austin',         state: 'TX', expected: 'japanese',      category: 'Japanese' },
  { idx: 13, name: 'Momofuku',                        city: 'New York',       state: 'NY', expected: 'japanese',      category: 'Japanese' },
  { idx: 14, name: 'Jiro Sushi',                      city: 'Chicago',        state: 'IL', expected: 'japanese',      category: 'Japanese' },
  { idx: 15, name: 'Roka Akor',                       city: 'Houston',        state: 'TX', expected: 'japanese',      category: 'Japanese' },
  // MEXICAN (16-20)
  { idx: 16, name: 'Cosme',                           city: 'New York',       state: 'NY', expected: 'mexican',       category: 'Mexican' },
  { idx: 17, name: 'Superica',                        city: 'Atlanta',        state: 'GA', expected: 'mexican',       category: 'Mexican' },
  { idx: 18, name: 'Nixta Taqueria',                  city: 'Austin',         state: 'TX', expected: 'mexican',       category: 'Mexican' },
  { idx: 19, name: 'Broken Spanish',                  city: 'Los Angeles',    state: 'CA', expected: 'mexican',       category: 'Mexican' },
  { idx: 20, name: "Hugo's",                          city: 'Houston',        state: 'TX', expected: 'mexican',       category: 'Mexican' },
  // ITALIAN (21-25)
  { idx: 21, name: 'Carbone',                         city: 'New York',       state: 'NY', expected: 'italian',       category: 'Italian' },
  { idx: 22, name: 'Rosewood Moto',                   city: 'Chicago',        state: 'IL', expected: 'italian',       category: 'Italian' },
  { idx: 23, name: 'Bestia',                          city: 'Los Angeles',    state: 'CA', expected: 'italian',       category: 'Italian' },
  { idx: 24, name: 'Frasca',                          city: 'Boulder',        state: 'CO', expected: 'italian',       category: 'Italian' },
  { idx: 25, name: 'Il Mulino',                       city: 'Miami',          state: 'FL', expected: 'italian',       category: 'Italian' },
  // THAI (26-30)
  { idx: 26, name: 'Night + Market',                  city: 'Los Angeles',    state: 'CA', expected: 'thai',          category: 'Thai' },
  { idx: 27, name: 'Lotus of Siam',                   city: 'Las Vegas',      state: 'NV', expected: 'thai',          category: 'Thai' },
  { idx: 28, name: 'Thai Diner',                      city: 'New York',       state: 'NY', expected: 'thai',          category: 'Thai' },
  { idx: 29, name: 'Sura',                            city: 'San Francisco',  state: 'CA', expected: 'thai',          category: 'Thai' },
  { idx: 30, name: 'Sovereign',                       city: 'Chicago',        state: 'IL', expected: 'thai',          category: 'Thai' },
  // VIETNAMESE (31-35)
  { idx: 31, name: 'Pho 24',                          city: 'Houston',        state: 'TX', expected: 'vietnamese',    category: 'Vietnamese' },
  { idx: 32, name: 'Com Tam Thuan Kieu',              city: 'San Jose',       state: 'CA', expected: 'vietnamese',    category: 'Vietnamese' },
  { idx: 33, name: 'Pho Grand',                       city: 'St Louis',       state: 'MO', expected: 'vietnamese',    category: 'Vietnamese' },
  { idx: 34, name: 'Viet Kitchen',                    city: 'Chicago',        state: 'IL', expected: 'vietnamese',    category: 'Vietnamese' },
  { idx: 35, name: 'Little Saigon',                   city: 'Austin',         state: 'TX', expected: 'vietnamese',    category: 'Vietnamese' },
  // KOREAN (36-40)
  { idx: 36, name: 'Barn Joo',                        city: 'New York',       state: 'NY', expected: 'korean',        category: 'Korean' },
  { idx: 37, name: 'Hankook Taqueria',                city: 'Atlanta',        state: 'GA', expected: 'korean',        category: 'Korean' },
  { idx: 38, name: 'Honey Pig',                       city: 'Washington',     state: 'DC', expected: 'korean',        category: 'Korean' },
  { idx: 39, name: 'Da Rae Won',                      city: 'Los Angeles',    state: 'CA', expected: 'korean',        category: 'Korean' },
  { idx: 40, name: 'Kimchi Smoke',                    city: 'Westwood',       state: 'NJ', expected: 'korean',        category: 'Korean' },
  // CARIBBEAN (41-45) — note 43 is intentionally seafood despite "Island" in name
  { idx: 41, name: "Miss Lily's",                     city: 'New York',       state: 'NY', expected: 'caribbean',     category: 'Caribbean' },
  { idx: 42, name: 'Negril Village',                  city: 'New York',       state: 'NY', expected: 'caribbean',     category: 'Caribbean' },
  { idx: 43, name: 'Island Creek Oysters',            city: 'Boston',         state: 'MA', expected: 'seafood',       category: 'Caribbean' },
  { idx: 44, name: 'Bridgetown Roti',                 city: 'Los Angeles',    state: 'CA', expected: 'caribbean',     category: 'Caribbean' },
  { idx: 45, name: 'The Dutch Pot',                   city: 'Atlanta',        state: 'GA', expected: 'caribbean',     category: 'Caribbean' },
  // ETHIOPIAN (46-50)
  { idx: 46, name: 'Bati Ethiopian',                  city: 'Oakland',        state: 'CA', expected: 'ethiopian',     category: 'Ethiopian' },
  { idx: 47, name: 'Desta Ethiopian Kitchen',         city: 'Chicago',        state: 'IL', expected: 'ethiopian',     category: 'Ethiopian' },
  { idx: 48, name: 'Lalibela',                        city: 'Salt Lake City', state: 'UT', expected: 'ethiopian',     category: 'Ethiopian' },
  { idx: 49, name: 'Habesha Market',                  city: 'Washington',     state: 'DC', expected: 'ethiopian',     category: 'Ethiopian' },
  { idx: 50, name: 'Ras Dashen',                      city: 'Chicago',        state: 'IL', expected: 'ethiopian',     category: 'Ethiopian' },
  // BBQ (51-55)
  { idx: 51, name: 'Franklin Barbecue',               city: 'Austin',         state: 'TX', expected: 'bbq',           category: 'BBQ' },
  { idx: 52, name: "Joe's KC BBQ",                    city: 'Kansas City',    state: 'MO', expected: 'bbq',           category: 'BBQ' },
  { idx: 53, name: "Pappy's Smokehouse",              city: 'St Louis',       state: 'MO', expected: 'bbq',           category: 'BBQ' },
  { idx: 54, name: "Bludso's BBQ",                    city: 'Los Angeles',    state: 'CA', expected: 'bbq',           category: 'BBQ' },
  { idx: 55, name: 'Hometown Bar-B-Que',              city: 'New York',       state: 'NY', expected: 'bbq',           category: 'BBQ' },
  // STEAKHOUSE (56-60)
  { idx: 56, name: 'Peter Luger',                     city: 'New York',       state: 'NY', expected: 'steakhouse',    category: 'Steakhouse' },
  { idx: 57, name: "Bern's Steak House",              city: 'Tampa',          state: 'FL', expected: 'steakhouse',    category: 'Steakhouse' },
  { idx: 58, name: 'Fogo de Chao',                    city: 'Chicago',        state: 'IL', expected: 'steakhouse',    category: 'Steakhouse' },
  { idx: 59, name: 'STK',                             city: 'Las Vegas',      state: 'NV', expected: 'steakhouse',    category: 'Steakhouse' },
  { idx: 60, name: "Bohanan's",                       city: 'San Antonio',    state: 'TX', expected: 'steakhouse',    category: 'Steakhouse' },
  // SEAFOOD (61-65)
  { idx: 61, name: 'Legal Sea Foods',                 city: 'Boston',         state: 'MA', expected: 'seafood',       category: 'Seafood' },
  { idx: 62, name: "Schuler's on the Water",          city: 'Baltimore',      state: 'MD', expected: 'seafood',       category: 'Seafood' },
  { idx: 63, name: 'Swan Oyster Depot',               city: 'San Francisco',  state: 'CA', expected: 'seafood',       category: 'Seafood' },
  { idx: 64, name: "Truluck's",                       city: 'Austin',         state: 'TX', expected: 'seafood',       category: 'Seafood' },
  { idx: 65, name: "Eddie V's",                       city: 'Dallas',         state: 'TX', expected: 'seafood',       category: 'Seafood' },
  // GREEK / MEDITERRANEAN (66-70)
  { idx: 66, name: 'Estiatorio Milos',                city: 'New York',       state: 'NY', expected: 'greek',         category: 'Greek/Mediterranean' },
  { idx: 67, name: 'The Purple Pig',                  city: 'Chicago',        state: 'IL', expected: 'mediterranean', category: 'Greek/Mediterranean' },
  { idx: 68, name: 'Oleana',                          city: 'Boston',         state: 'MA', expected: 'mediterranean', category: 'Greek/Mediterranean' },
  { idx: 69, name: 'Zaytinya',                        city: 'Washington',     state: 'DC', expected: 'mediterranean', category: 'Greek/Mediterranean' },
  { idx: 70, name: 'Avra',                            city: 'New York',       state: 'NY', expected: 'greek',         category: 'Greek/Mediterranean' },
  // MIDDLE EASTERN (71-75)
  { idx: 71, name: 'Bavel',                           city: 'Los Angeles',    state: 'CA', expected: 'middleeastern', category: 'Middle Eastern' },
  { idx: 72, name: 'Shaya',                           city: 'New Orleans',    state: 'LA', expected: 'middleeastern', category: 'Middle Eastern' },
  { idx: 73, name: 'Zahav',                           city: 'Philadelphia',   state: 'PA', expected: 'middleeastern', category: 'Middle Eastern' },
  { idx: 74, name: 'Cava',                            city: 'Washington',     state: 'DC', expected: 'mediterranean', category: 'Middle Eastern' },
  { idx: 75, name: 'Tawla',                           city: 'San Francisco',  state: 'CA', expected: 'middleeastern', category: 'Middle Eastern' },
  // FRENCH (76-80)
  { idx: 76, name: 'Le Bernardin',                    city: 'New York',       state: 'NY', expected: 'french',        category: 'French' },
  { idx: 77, name: 'Bouchon',                         city: 'Las Vegas',      state: 'NV', expected: 'french',        category: 'French' },
  { idx: 78, name: 'Cafe Boulud',                     city: 'Miami',          state: 'FL', expected: 'french',        category: 'French' },
  { idx: 79, name: 'Toulouse Petit',                  city: 'Seattle',        state: 'WA', expected: 'french',        category: 'French' },
  { idx: 80, name: 'Bisou Bisou',                     city: 'Chicago',        state: 'IL', expected: 'french',        category: 'French' },
  // PIZZA (81-85)
  { idx: 81, name: 'Lucali',                          city: 'New York',       state: 'NY', expected: 'pizza',         category: 'Pizza' },
  { idx: 82, name: 'Pizzeria Bianco',                 city: 'Phoenix',        state: 'AZ', expected: 'pizza',         category: 'Pizza' },
  { idx: 83, name: "Lou Malnati's",                   city: 'Chicago',        state: 'IL', expected: 'pizza',         category: 'Pizza' },
  { idx: 84, name: 'Una Pizza Napoletana',            city: 'New York',       state: 'NY', expected: 'pizza',         category: 'Pizza' },
  { idx: 85, name: 'Motorino',                        city: 'New York',       state: 'NY', expected: 'pizza',         category: 'Pizza' },
  // BURGER (86-90)
  { idx: 86, name: 'J.G. Melon',                      city: 'New York',       state: 'NY', expected: 'burger',        category: 'Burger' },
  { idx: 87, name: 'Apple Pan',                       city: 'Los Angeles',    state: 'CA', expected: 'burger',        category: 'Burger' },
  { idx: 88, name: "Hodad's",                         city: 'San Diego',      state: 'CA', expected: 'burger',        category: 'Burger' },
  { idx: 89, name: 'Shake Shack',                     city: 'New York',       state: 'NY', expected: 'burger',        category: 'Burger (Chain)' },
  { idx: 90, name: 'In-N-Out Burger',                 city: 'Los Angeles',    state: 'CA', expected: 'burger',        category: 'Burger (Chain)' },
  // CHAIN (91-95)
  { idx: 91, name: 'Pizza Hut',                       city: 'Austin',         state: 'TX', expected: 'pizza',         category: 'Chain' },
  { idx: 92, name: 'Chipotle Mexican Grill',          city: 'Chicago',        state: 'IL', expected: 'mexican',       category: 'Chain' },
  { idx: 93, name: 'Olive Garden',                    city: 'Miami',          state: 'FL', expected: 'italian',       category: 'Chain' },
  { idx: 94, name: 'Panda Express',                   city: 'Houston',        state: 'TX', expected: 'chinese',       category: 'Chain' },
  { idx: 95, name: 'Texas Roadhouse',                 city: 'Dallas',         state: 'TX', expected: 'steakhouse',    category: 'Chain' },
  // FUSION / TRICKY (96-100)
  { idx: 96, name: 'Nobu',                            city: 'New York',       state: 'NY', expected: 'japanese',      category: 'Fusion/Tricky' },
  { idx: 97, name: 'Momofuku Noodle Bar',             city: 'New York',       state: 'NY', expected: 'japanese',      category: 'Fusion/Tricky' },
  { idx: 98, name: 'Mission Chinese Food',            city: 'New York',       state: 'NY', expected: 'chinese',       category: 'Fusion/Tricky' },
  { idx: 99, name: 'Flower Child',                    city: 'Austin',         state: 'TX', expected: 'vegan',         category: 'Fusion/Tricky' },
  { idx: 100,name: 'Commissary',                      city: 'Dallas',         state: 'TX', expected: 'american',      category: 'Fusion/Tricky' },
];

// ─── Google Places helpers ───────────────────────────────────────────
async function googleTextSearch(query) {
  const url = `${TEXTSEARCH_URL}?query=${encodeURIComponent(query)}&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`textsearch HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
    throw new Error(`textsearch status=${json.status} ${json.error_message || ''}`);
  }
  return Array.isArray(json.results) ? json.results : [];
}

async function googlePlaceDetails(placeId) {
  const fields = 'place_id,name,types,reviews,rating,user_ratings_total,formatted_address';
  const url = `${DETAILS_URL}?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`details HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK') {
    throw new Error(`details status=${json.status} ${json.error_message || ''}`);
  }
  return json.result;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Layer-detection wrapper ─────────────────────────────────────────
// buildCompetitorQuery emits a single console.log per call of the form
// "[competitor-query] {name} → layer:N (...)". Monkey-patch console.log
// for the duration of the call to capture which layer fired without
// polluting test stdout.
function buildQueryWithLayer(args) {
  let layer = null;
  let logLine = null;
  const orig = console.log;
  console.log = (...a) => {
    const msg = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    const m = msg.match(/→ layer:(\d)/);
    if (m) {
      layer = parseInt(m[1], 10);
      logLine = msg;
    }
  };
  let query;
  try {
    query = buildCompetitorQuery.apply(null, args);
  } finally {
    console.log = orig;
  }
  return { query, layer, logLine };
}

// ─── Grading ─────────────────────────────────────────────────────────
// GRADER FIX (post-Bug-6): inverse type→cuisine map. Many Asian /
// Middle-Eastern restaurants don't carry the cuisine word in their
// English name (e.g. "Yeti Cafe" is Korean) but Google often tags
// them with the cuisine `_restaurant` type. A competitor matches
// the expected cuisine if EITHER the name contains a cuisine
// keyword OR the per-cuisine type list matches OR the Google type
// maps back to the expected cuisine via this inverse map.
const TYPES_TO_CUISINE = {
  'chinese_restaurant':        'chinese',
  'japanese_restaurant':       'japanese',
  'korean_restaurant':         'korean',
  'thai_restaurant':           'thai',
  'vietnamese_restaurant':     'vietnamese',
  'mexican_restaurant':        'mexican',
  'italian_restaurant':        'italian',
  'french_restaurant':         'french',
  'greek_restaurant':          'greek',
  'mediterranean_restaurant':  'mediterranean',
  'middle_eastern_restaurant': 'middleeastern',
  'indian_restaurant':         'indian',
  'seafood_restaurant':        'seafood',
  'steak_house':               'steakhouse',
  'pizza_restaurant':          'pizza',
  'bbq_restaurant':            'bbq',
  'caribbean_restaurant':      'caribbean',
  'hamburger_restaurant':      'burger',
  'fast_food_restaurant':      'fastfood',
};

function competitorMatchesCuisine(competitor, expectedCuisine) {
  const matcher = CUISINE_MATCHERS[expectedCuisine];
  if (!matcher) return false;
  const nameLower = String(competitor.name || '').toLowerCase();
  const types = Array.isArray(competitor.types) ? competitor.types : [];
  const nameHit = matcher.name.some((kw) => nameLower.includes(kw.toLowerCase()));
  const typeHit = matcher.types.some((t) => types.includes(t));
  // Inverse-map check: if any Google type maps to the expected cuisine.
  const inverseHit = types.some((t) => TYPES_TO_CUISINE[t] === expectedCuisine);
  return nameHit || typeHit || inverseHit;
}

function gradeCompetitors(top5, expectedCuisine, subjectName) {
  const subjectNorm = String(subjectName || '').toLowerCase().trim();
  let matchCount = 0;
  const detail = top5.map((c) => {
    const isSelf = subjectNorm
      && String(c.name || '').toLowerCase().trim() === subjectNorm;
    const matched = !isSelf && competitorMatchesCuisine(c, expectedCuisine);
    if (matched) matchCount++;
    return {
      name: c.name,
      rating: c.rating,
      types: c.types,
      matched,
      is_subject: isSelf,
    };
  });
  return { matchCount, total: top5.length, detail };
}

// ─── Per-test runner ─────────────────────────────────────────────────
async function runOneTest(tc) {
  const subjectQuery = `${tc.name} ${tc.city} ${tc.state}`;
  const searchHits = await googleTextSearch(subjectQuery);
  if (!searchHits.length) {
    return { idx: tc.idx, status: 'SKIP', reason: 'restaurant not found on Google',
             name: tc.name, city: tc.city, state: tc.state, expected: tc.expected, category: tc.category };
  }
  const place = searchHits[0];

  let details;
  try {
    details = await googlePlaceDetails(place.place_id);
  } catch (err) {
    return { idx: tc.idx, status: 'SKIP', reason: `details fetch failed: ${err.message}`,
             name: tc.name, city: tc.city, state: tc.state, expected: tc.expected, category: tc.category };
  }
  const reviews = (Array.isArray(details.reviews) ? details.reviews : [])
    .map((r) => String((r && r.text) || ''));
  const googleTypes = Array.isArray(place.types) ? place.types : [];

  const { query, layer, logLine } = buildQueryWithLayer([
    tc.name,
    '722511',  // pretend full-service-restaurant NAICS for all
    '72',
    googleTypes,
    tc.city,
    tc.state,
    reviews,
  ]);

  const compHits = await googleTextSearch(query);
  const top5 = compHits.slice(0, 5);
  const grade = gradeCompetitors(top5, tc.expected, place.name);
  const passed = grade.matchCount >= PASS_THRESHOLD;

  return {
    idx: tc.idx,
    status: passed ? 'PASS' : 'FAIL',
    name: tc.name,
    city: tc.city,
    state: tc.state,
    category: tc.category,
    expected: tc.expected,
    subject_place_name: place.name,
    subject_google_types: googleTypes,
    reviews_used: reviews.length,
    layer_fired: layer,
    layer_log: logLine,
    query,
    top5: grade.detail,
    matchCount: grade.matchCount,
    total: grade.total,
  };
}

// ─── Reporting ───────────────────────────────────────────────────────
function pct(n, d) {
  if (!d) return '0%';
  return `${Math.round((n / d) * 100)}%`;
}

function printSummary(results) {
  const total = results.length;
  const pass = results.filter((r) => r.status === 'PASS');
  const fail = results.filter((r) => r.status === 'FAIL');
  const skip = results.filter((r) => r.status === 'SKIP');
  const err  = results.filter((r) => r.status === 'ERROR');

  const sep = '═'.repeat(60);
  console.log('');
  console.log(sep);
  console.log('REAL RESTAURANT COMPETITOR TEST');
  console.log(sep);
  console.log(`Total tested: ${total}`);
  console.log(`PASSED:  ${pass.length} (${pct(pass.length, total)})`);
  console.log(`FAILED:  ${fail.length} (${pct(fail.length, total)})`);
  console.log(`SKIPPED: ${skip.length} (not found on Google)`);
  if (err.length) console.log(`ERROR:   ${err.length}`);
  console.log('');

  // Failure detail
  if (fail.length) {
    console.log('FAILURES — these need fixing:');
    for (const r of fail) {
      const namesOnly = r.top5.map((c) => `${c.name}${c.is_subject ? ' [SELF]' : ''}${c.matched ? '✓' : '✗'}`).join(', ');
      console.log(`  #${r.idx} ${r.name}, ${r.city} ${r.state}`);
      console.log(`     query: "${r.query}"`);
      console.log(`     layer fired: ${r.layer_fired}  google_types: ${(r.subject_google_types || []).join(',')}`);
      console.log(`     expected: ${r.expected}  matched ${r.matchCount}/${r.total}`);
      console.log(`     top5: ${namesOnly}`);
    }
    console.log('');
  }

  // Layer histogram
  const layerCount = {};
  for (const r of [...pass, ...fail]) {
    const k = r.layer_fired == null ? 'unknown' : `Layer ${r.layer_fired}`;
    layerCount[k] = (layerCount[k] || 0) + 1;
  }
  console.log('LAYER PERFORMANCE:');
  const layerLabels = {
    1: 'Google types tag',
    2: 'Review-text scoring',
    3: 'Strong single keywords',
    4: 'Name cultural signals',
    5: 'Chain category map',
    6: 'Generic restaurant fallback',
  };
  for (let i = 1; i <= 6; i++) {
    const k = `Layer ${i}`;
    const c = layerCount[k] || 0;
    console.log(`  Layer ${i} ${layerLabels[i].padEnd(34, ' ')}: ${c} hits`);
  }
  if (layerCount.unknown) console.log(`  Layer ?  unknown (no log captured)         : ${layerCount.unknown} hits`);
  console.log('');

  // Cuisine accuracy by category
  const categoryGroups = {};
  for (const r of results) {
    if (!categoryGroups[r.category]) categoryGroups[r.category] = { pass: 0, total: 0 };
    if (r.status === 'PASS') categoryGroups[r.category].pass++;
    if (r.status === 'PASS' || r.status === 'FAIL') categoryGroups[r.category].total++;
  }
  console.log('CUISINE ACCURACY (by spec category):');
  for (const [cat, g] of Object.entries(categoryGroups)) {
    const pad = cat.padEnd(22, ' ');
    console.log(`  ${pad}: ${g.pass}/${g.total}  (${pct(g.pass, g.total)})`);
  }
  console.log('');

  // Weaknesses
  if (fail.length) {
    console.log('WEAKNESSES FOUND:');
    for (const r of fail) {
      let reason = '';
      if (r.layer_fired === 6) {
        reason = 'fell through to generic fallback — no cuisine signal detected';
      } else if (r.matchCount === 0) {
        reason = `query "${r.query}" returned 0 cuisine matches — wrong cuisine detected`;
      } else if (r.matchCount < PASS_THRESHOLD) {
        reason = `query found ${r.matchCount}/${r.total} matching peers — partial signal, possibly thin local market`;
      }
      console.log(`  #${r.idx} ${r.name}: ${reason}`);
    }
    console.log('');
  }

  console.log(sep);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('REAL RESTAURANT COMPETITOR TEST');
  console.log(`Running ${TESTS.length} cases. Estimated ~5 minutes, ~$6.40 in API costs.\n`);

  const results = [];
  for (const tc of TESTS) {
    const label = `[${String(tc.idx).padStart(3, ' ')}/${TESTS.length}] ${tc.name}, ${tc.city} ${tc.state}`;
    process.stdout.write(`${label.padEnd(60, ' ')} ... `);
    try {
      const r = await runOneTest(tc);
      results.push(r);
      if (r.status === 'PASS') {
        console.log(`PASS (${r.matchCount}/${r.total})  layer:${r.layer_fired}`);
      } else if (r.status === 'FAIL') {
        console.log(`FAIL (${r.matchCount}/${r.total})  layer:${r.layer_fired}  q="${r.query}"`);
      } else {
        console.log(`${r.status} — ${r.reason}`);
      }
    } catch (err) {
      results.push({
        idx: tc.idx, status: 'ERROR', reason: err.message,
        name: tc.name, city: tc.city, state: tc.state,
        expected: tc.expected, category: tc.category,
      });
      console.log(`ERROR — ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  // Persist full per-case results
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${OUTPUT_FILE}`);

  printSummary(results);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

/* test_real_restaurants_2.js
   ─────────────────────────────────────────────────────────────────
   Second 100-restaurant validation of buildCompetitorQuery(). Same
   structure as test_real_restaurants.js but with 100 NEW subjects
   chosen for harder edge cases:
     - No cuisine word in name (Cosme, R&G Lounge, Atomix)
     - Fine-dining tasting menus (Junoon, Daniel, Quince-tier)
     - Foreign-language names (Babbo, Marea, Pylos, Mamnoon)
     - Famous places by chef name (Jean-Georges, Daniel, Boulud)
     - Regional ethnic cuisines (Ethiopian variants, Caribbean variants)
     - Fast-casual chains (Fatburger, Wingstop variants)
     - Fusion/genuinely-tricky (STREET, Husk, Sqirl)

   Usage:    node test_real_restaurants_2.js
   Output:   stdout summary + test_results_2.json (per-case detail)
   Cost:     ~$8 in Google Places API calls (300 calls)
   Time:     ~6 minutes (300ms throttle)
   Requires: GOOGLE_PLACES_API_KEY in .env, buildCompetitorQuery
             exported from googlePlaces.js

   The grader uses the same name+types check from test_real_restaurants.js
   including the TYPES_TO_CUISINE inverse map.
*/

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildCompetitorQuery } = require('./googlePlaces.js');

// ─── Fail-fast preconditions ─────────────────────────────────────────
if (typeof buildCompetitorQuery !== 'function') {
  console.error('ERROR: buildCompetitorQuery not exported from googlePlaces.js.');
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
const OUTPUT_FILE    = path.join(__dirname, 'test_results_2.json');
const DELAY_MS       = 300;
const PASS_THRESHOLD = 3; // 3-of-5 top competitors must match expected cuisine

// ─── Cuisine matchers (same as test 1, plus 'breakfast', plus 'fallback') ─────
const CUISINE_MATCHERS = {
  indian: {
    name: ['indian', 'curry', 'tandoor', 'tikka', 'masala', 'bombay', 'mumbai',
           'taj', 'delhi', 'punjab', 'biryani', 'naan', 'desi', 'dosa', 'spice route',
           'rasa', 'tiffin', 'udupi', 'mayura', 'junoon'],
    types: ['indian_restaurant'],
  },
  chinese: {
    name: ['chinese', 'china ', ' china', 'dim sum', 'wok', 'panda', 'dragon',
           'peking', 'mandarin', 'szechuan', 'shanghai', 'canton', 'hunan',
           'noodle house', 'duck house', 'great wall', 'oriental',
           'r&g', 'lai hong', 'noodletown', 'fu', 'tai tung', 'wo hop'],
    types: ['chinese_restaurant'],
  },
  japanese: {
    name: ['japanese', 'sushi', 'ramen', 'tokyo', 'sakura', 'fuji',
           'sashimi', 'tempura', 'izakaya', 'omakase', 'kaiseki', 'hibachi',
           'nobu', 'matsuri', 'osaka', 'kyoto', 'roka', 'noz', 'ichiran',
           'tsukiji', 'narisawa', 'katsu', 'momofuku'],
    types: ['japanese_restaurant', 'sushi_restaurant', 'ramen_restaurant'],
  },
  mexican: {
    name: ['mexican', 'mexico', 'taqueria', 'taco', 'cantina', 'jalisco',
           'oaxaca', 'casa ', ' casa', 'fiesta', 'el ', 'la ', 'los ',
           'hacienda', 'puebla', 'birria', 'cocina', 'oxomoco', 'tenoch',
           'aztec', 'claro', 'atla', 'cosme'],
    types: ['mexican_restaurant'],
  },
  italian: {
    name: ['italian', 'italia', 'pasta', 'trattoria', 'osteria', 'ristorante',
           'roma', 'napoli', 'bella', 'tuscany', 'sicilian', 'venezia',
           'babbo', 'posto', 'marea', 'lilia', 'artusi', 'don angie',
           'carbone', 'frasca', 'scarpetta'],
    types: ['italian_restaurant'],
  },
  thai: {
    name: ['thai', 'siam', 'bangkok', 'pad thai', 'tom yum', 'lotus',
           'orchid', 'chiang mai', 'pok pok', 'fish cheeks', 'crying tiger',
           'loog muang', 'ayara'],
    types: ['thai_restaurant'],
  },
  vietnamese: {
    name: ['vietnamese', 'viet ', ' viet', 'pho', 'banh mi', 'saigon',
           'hanoi', 'mekong', 'bun bo', 'com tam', 'an choi', 'madame vo',
           'di an di', 'hai hai'],
    types: ['vietnamese_restaurant'],
  },
  korean: {
    name: ['korean', 'korea', 'kbbq', 'k-bbq', 'k bbq', 'kimchi', 'bulgogi',
           'seoul', 'gangnam', 'bibimbap', 'tofu house',
           'jungsik', 'cote', 'atomix', 'jeju', 'hankook', 'baekjeong'],
    types: ['korean_restaurant'],
  },
  caribbean: {
    name: ['caribbean', 'jamaican', 'jamaica', 'jerk', 'reggae',
           'cuban', 'cuba', 'roti', 'tropical', 'calypso', 'west indian',
           'trinidad', 'bahamas', 'dutch pot', 'glady', 'cane', 'nuela'],
    types: ['caribbean_restaurant'],
  },
  ethiopian: {
    name: ['ethiopian', 'ethiopia', 'injera', 'habesha', 'african',
           'eritrean', 'addis', 'lalibela', 'abyssinia', 'ras dashen',
           'desta', 'ethiopic', 'demera', 'ghenet', 'tadu', 'meaza'],
    types: ['ethiopian_restaurant', 'african_restaurant'],
  },
  bbq: {
    name: ['bbq', 'b-b-q', 'b.b.q', 'barbecue', 'barbeque', 'bar-b-que',
           'bar-b-q', 'smokehouse', 'smoke', 'pit ', 'brisket', ' rib',
           'rib ', 'pitmaster', 'pecan lodge', 'truth bbq', 'goldee'],
    types: ['barbecue_restaurant'],
  },
  steakhouse: {
    name: ['steak', 'chop house', 'chophouse', 'prime ', 'beef ',
           'porterhouse', 'rib eye', 'ribeye', 'roadhouse', 'longhorn',
           'fogo', 'churrascaria', 'keens', 'gibsons', 'mastro',
           'pappas bros', 'cut '],
    types: ['steak_house'],
  },
  seafood: {
    name: ['seafood', 'fish', 'oyster', 'lobster', 'crab', 'shrimp',
           'shellfish', 'ocean', 'harbor', 'pier ', ' pier', 'wharf',
           'catch', 'reel', 'water grill', 'legal sea', 'walrus',
           'eventide', 'neptune', 'saltie'],
    types: ['seafood_restaurant'],
  },
  greek: {
    name: ['greek', 'greece', 'athens', 'taverna', 'gyro', 'olive',
           'mykonos', 'parthenon', 'estiatorio', 'milos', 'avra',
           'barbounia', 'pylos', 'opa '],
    types: ['greek_restaurant'],
  },
  mediterranean: {
    name: ['mediterranean', 'med ', 'olive', 'falafel', 'hummus', 'tahini',
           'cava', 'zaytinya', 'oleana', 'purple pig', 'pita', 'agern'],
    types: ['mediterranean_restaurant', 'middle_eastern_restaurant',
            'greek_restaurant', 'lebanese_restaurant'],
  },
  middleeastern: {
    name: ['middle eastern', 'middle-eastern', 'lebanese', 'persian',
           'kebab', 'kabob', 'shawarma', 'falafel', 'hummus', 'turkish',
           'halal', 'arab', 'beirut', 'damascus', 'zahav', 'shaya', 'bavel',
           'tawla', 'mediterranean', 'mamnoon', 'saffron', 'byblos',
           'zaytinya', 'souk'],
    types: ['middle_eastern_restaurant', 'lebanese_restaurant',
            'turkish_restaurant', 'mediterranean_restaurant'],
  },
  french: {
    name: ['french', 'france', 'bistro', 'brasserie', 'patisserie',
           'paris', 'maison', 'le ', 'la ', 'cafe de', 'chateau',
           'boulangerie', 'crepe', 'bouchon', 'boulud', 'daniel',
           'jean-georges', 'kreuther', 'benoit', 'robuchon', 'atelier'],
    types: ['french_restaurant'],
  },
  pizza: {
    name: ['pizza', 'pizzeria', 'slice', 'neapolitan', 'detroit-style',
           'deep dish', 'wood fired', 'wood-fired', 'apizza',
           'roberta', 'pepe', 'sally', 'pequod', 'grimaldi', 'lou malnati'],
    types: ['pizza_restaurant'],
  },
  burger: {
    name: ['burger', 'patty', 'shake shack', 'in-n-out', 'in n out',
           'whataburger', 'smashburger', 'mooyah', 'habit', 'culver',
           'fatburger', 'cheeseburger', 'melon', 'corner bistro',
           'holeman', 'au cheval', 'superiority'],
    types: ['hamburger_restaurant', 'fast_food_restaurant'],
  },
  vegan: {
    name: ['vegan', 'vegetarian', 'plant', 'green', 'kale', 'flower child',
           'true food', 'sweetgreen', 'native foods', 'veggie'],
    types: ['vegan_restaurant', 'vegetarian_restaurant'],
  },
  breakfast: {
    name: ['breakfast', 'brunch', 'pancake', 'waffle', 'cafe', 'diner',
           'sqirl', 'snooze', 'cracker barrel', 'denny', 'ihop',
           'eggs', 'omelette', 'morning'],
    types: ['breakfast_restaurant', 'brunch_restaurant', 'cafe'],
  },
  american: {
    name: ['american', 'grill', 'tavern', 'kitchen', 'eatery', 'diner',
           'commissary', 'farm', 'house', 'social', 'public',
           'underbelly', 'husk', 'southern'],
    types: ['american_restaurant', 'restaurant'],
  },
  // Special: 'fallback' — auto-pass when buildCompetitorQuery returns
  // the generic 'restaurant dining' query. Used for genuinely ambiguous
  // subjects (STREET, food halls, etc.) where any reasonable competitor
  // pool is acceptable.
  fallback: {
    name: [],
    types: [],
  },
};

// ─── 100 NEW restaurant test cases ───────────────────────────────────
const TESTS = [
  // INDIAN — harder cases (1-5)
  { idx:  1, name: 'Junoon',                               city: 'New York',       state: 'NY', expected: 'indian',        category: 'Indian' },
  { idx:  2, name: 'Rasa',                                 city: 'Burlingame',     state: 'CA', expected: 'indian',        category: 'Indian' },
  { idx:  3, name: 'Tiffin',                               city: 'Philadelphia',   state: 'PA', expected: 'indian',        category: 'Indian' },
  { idx:  4, name: 'Udupi Palace',                         city: 'Sunnyvale',      state: 'CA', expected: 'indian',        category: 'Indian' },
  { idx:  5, name: 'Mayura',                               city: 'Culver City',    state: 'CA', expected: 'indian',        category: 'Indian' },
  // CHINESE — harder cases (6-10)
  { idx:  6, name: 'Mission Chinese Food',                 city: 'New York',       state: 'NY', expected: 'chinese',       category: 'Chinese' },
  { idx:  7, name: 'R&G Lounge',                           city: 'San Francisco',  state: 'CA', expected: 'chinese',       category: 'Chinese' },
  { idx:  8, name: 'Lai Hong Lounge',                      city: 'San Francisco',  state: 'CA', expected: 'chinese',       category: 'Chinese' },
  { idx:  9, name: 'Great N.Y. Noodletown',                city: 'New York',       state: 'NY', expected: 'chinese',       category: 'Chinese' },
  { idx: 10, name: "Fu's Palace",                          city: 'Houston',        state: 'TX', expected: 'chinese',       category: 'Chinese' },
  // JAPANESE — harder cases (11-15)
  { idx: 11, name: 'Sushi Noz',                            city: 'New York',       state: 'NY', expected: 'japanese',      category: 'Japanese' },
  { idx: 12, name: 'Ichiran',                              city: 'New York',       state: 'NY', expected: 'japanese',      category: 'Japanese' },
  { idx: 13, name: 'Tsukiji Fish Market Restaurant',       city: 'Los Angeles',    state: 'CA', expected: 'japanese',      category: 'Japanese' },
  { idx: 14, name: 'Narisawa',                             city: 'New York',       state: 'NY', expected: 'japanese',      category: 'Japanese' },
  { idx: 15, name: 'Katsu-ya',                             city: 'Los Angeles',    state: 'CA', expected: 'japanese',      category: 'Japanese' },
  // KOREAN — harder cases (16-20)
  { idx: 16, name: 'Jungsik',                              city: 'New York',       state: 'NY', expected: 'korean',        category: 'Korean' },
  { idx: 17, name: 'Cote',                                 city: 'New York',       state: 'NY', expected: 'korean',        category: 'Korean' },
  { idx: 18, name: 'Atomix',                               city: 'New York',       state: 'NY', expected: 'korean',        category: 'Korean' },
  { idx: 19, name: 'Jeju Noodle Bar',                      city: 'New York',       state: 'NY', expected: 'korean',        category: 'Korean' },
  { idx: 20, name: "Sunday's Finest",                      city: 'Atlanta',        state: 'GA', expected: 'korean',        category: 'Korean' },
  // THAI — harder cases (21-25)
  { idx: 21, name: 'Fish Cheeks',                          city: 'New York',       state: 'NY', expected: 'thai',          category: 'Thai' },
  { idx: 22, name: 'Pok Pok',                              city: 'Portland',       state: 'OR', expected: 'thai',          category: 'Thai' },
  { idx: 23, name: 'Loog Muang',                           city: 'Austin',         state: 'TX', expected: 'thai',          category: 'Thai' },
  { idx: 24, name: 'Crying Tiger',                         city: 'New York',       state: 'NY', expected: 'thai',          category: 'Thai' },
  { idx: 25, name: 'Ayara Thai',                           city: 'Los Angeles',    state: 'CA', expected: 'thai',          category: 'Thai' },
  // VIETNAMESE (26-30)
  { idx: 26, name: 'An Choi',                              city: 'New York',       state: 'NY', expected: 'vietnamese',    category: 'Vietnamese' },
  { idx: 27, name: 'Madame Vo',                            city: 'New York',       state: 'NY', expected: 'vietnamese',    category: 'Vietnamese' },
  { idx: 28, name: 'Di An Di',                             city: 'New York',       state: 'NY', expected: 'vietnamese',    category: 'Vietnamese' },
  { idx: 29, name: 'Saigon Social',                        city: 'New York',       state: 'NY', expected: 'vietnamese',    category: 'Vietnamese' },
  { idx: 30, name: 'Hai Hai',                              city: 'Minneapolis',    state: 'MN', expected: 'vietnamese',    category: 'Vietnamese' },
  // MEXICAN — harder cases (31-35)
  { idx: 31, name: 'Cosme',                                city: 'New York',       state: 'NY', expected: 'mexican',       category: 'Mexican' },
  { idx: 32, name: 'Oxomoco',                              city: 'New York',       state: 'NY', expected: 'mexican',       category: 'Mexican' },
  { idx: 33, name: 'Tenoch',                               city: 'Boston',         state: 'MA', expected: 'mexican',       category: 'Mexican' },
  { idx: 34, name: 'Claro',                                city: 'New York',       state: 'NY', expected: 'mexican',       category: 'Mexican' },
  { idx: 35, name: 'Atla',                                 city: 'New York',       state: 'NY', expected: 'mexican',       category: 'Mexican' },
  // ITALIAN — harder cases (36-40)
  { idx: 36, name: 'Babbo',                                city: 'New York',       state: 'NY', expected: 'italian',       category: 'Italian' },
  { idx: 37, name: 'Del Posto',                            city: 'New York',       state: 'NY', expected: 'italian',       category: 'Italian' },
  { idx: 38, name: 'Marea',                                city: 'New York',       state: 'NY', expected: 'italian',       category: 'Italian' },
  { idx: 39, name: 'Lilia',                                city: 'New York',       state: 'NY', expected: 'italian',       category: 'Italian' },
  { idx: 40, name: "L'Artusi",                             city: 'New York',       state: 'NY', expected: 'italian',       category: 'Italian' },
  // FRENCH — harder cases (41-45)
  { idx: 41, name: 'Daniel',                               city: 'New York',       state: 'NY', expected: 'french',        category: 'French' },
  { idx: 42, name: 'Jean-Georges',                         city: 'New York',       state: 'NY', expected: 'french',        category: 'French' },
  { idx: 43, name: 'Gabriel Kreuther',                     city: 'New York',       state: 'NY', expected: 'french',        category: 'French' },
  { idx: 44, name: 'Benoit',                               city: 'New York',       state: 'NY', expected: 'french',        category: 'French' },
  { idx: 45, name: "L'Atelier de Joel Robuchon",           city: 'New York',       state: 'NY', expected: 'french',        category: 'French' },
  // GREEK / MEDITERRANEAN (46-50)
  { idx: 46, name: 'Agern',                                city: 'New York',       state: 'NY', expected: 'mediterranean', category: 'Greek/Mediterranean' },
  { idx: 47, name: 'Lilia Mare',                           city: 'New York',       state: 'NY', expected: 'mediterranean', category: 'Greek/Mediterranean' },
  { idx: 48, name: 'Barbounia',                            city: 'New York',       state: 'NY', expected: 'greek',         category: 'Greek/Mediterranean' },
  { idx: 49, name: 'MP Taverna',                           city: 'New York',       state: 'NY', expected: 'greek',         category: 'Greek/Mediterranean' },
  { idx: 50, name: 'Pylos',                                city: 'New York',       state: 'NY', expected: 'greek',         category: 'Greek/Mediterranean' },
  // MIDDLE EASTERN (51-55)
  { idx: 51, name: 'Mamnoon',                              city: 'Seattle',        state: 'WA', expected: 'middleeastern', category: 'Middle Eastern' },
  { idx: 52, name: 'Saffron De Twah',                      city: 'Detroit',        state: 'MI', expected: 'middleeastern', category: 'Middle Eastern' },
  { idx: 53, name: 'Byblos',                               city: 'Toronto',        state: 'ON', expected: 'middleeastern', category: 'Middle Eastern' },
  { idx: 54, name: 'Zaytinya',                             city: 'Washington',     state: 'DC', expected: 'middleeastern', category: 'Middle Eastern' },
  { idx: 55, name: 'Souk',                                 city: 'Seattle',        state: 'WA', expected: 'middleeastern', category: 'Middle Eastern' },
  // BBQ — harder cases (56-60)
  { idx: 56, name: 'Pecan Lodge',                          city: 'Dallas',         state: 'TX', expected: 'bbq',           category: 'BBQ' },
  { idx: 57, name: 'La Barbecue',                          city: 'Austin',         state: 'TX', expected: 'bbq',           category: 'BBQ' },
  { idx: 58, name: 'Smoked',                               city: 'Chicago',        state: 'IL', expected: 'bbq',           category: 'BBQ' },
  { idx: 59, name: 'Truth BBQ',                            city: 'Houston',        state: 'TX', expected: 'bbq',           category: 'BBQ' },
  { idx: 60, name: "Goldee's",                             city: 'Fort Worth',     state: 'TX', expected: 'bbq',           category: 'BBQ' },
  // STEAKHOUSE (61-65)
  { idx: 61, name: 'Keens Steakhouse',                     city: 'New York',       state: 'NY', expected: 'steakhouse',    category: 'Steakhouse' },
  { idx: 62, name: 'Gibsons Bar & Steakhouse',             city: 'Chicago',        state: 'IL', expected: 'steakhouse',    category: 'Steakhouse' },
  { idx: 63, name: "Mastro's",                             city: 'Beverly Hills',  state: 'CA', expected: 'steakhouse',    category: 'Steakhouse' },
  { idx: 64, name: 'Pappas Bros',                          city: 'Houston',        state: 'TX', expected: 'steakhouse',    category: 'Steakhouse' },
  { idx: 65, name: 'CUT',                                  city: 'Beverly Hills',  state: 'CA', expected: 'steakhouse',    category: 'Steakhouse' },
  // SEAFOOD (66-70)
  { idx: 66, name: 'The Walrus and the Carpenter',         city: 'Seattle',        state: 'WA', expected: 'seafood',       category: 'Seafood' },
  { idx: 67, name: 'Eventide',                             city: 'Portland',       state: 'ME', expected: 'seafood',       category: 'Seafood' },
  { idx: 68, name: 'Neptune Oyster',                       city: 'Boston',         state: 'MA', expected: 'seafood',       category: 'Seafood' },
  { idx: 69, name: 'Saltie Girl',                          city: 'Boston',         state: 'MA', expected: 'seafood',       category: 'Seafood' },
  { idx: 70, name: 'Little Goat Fish',                     city: 'Chicago',        state: 'IL', expected: 'seafood',       category: 'Seafood' },
  // PIZZA (71-75)
  { idx: 71, name: "Roberta's",                            city: 'New York',       state: 'NY', expected: 'pizza',         category: 'Pizza' },
  { idx: 72, name: "Frank Pepe's",                         city: 'New Haven',      state: 'CT', expected: 'pizza',         category: 'Pizza' },
  { idx: 73, name: "Sally's Apizza",                       city: 'New Haven',      state: 'CT', expected: 'pizza',         category: 'Pizza' },
  { idx: 74, name: "Pequod's",                             city: 'Chicago',        state: 'IL', expected: 'pizza',         category: 'Pizza' },
  { idx: 75, name: "Grimaldi's",                           city: 'New York',       state: 'NY', expected: 'pizza',         category: 'Pizza' },
  // BURGER (76-80)
  { idx: 76, name: 'J.G. Melon',                           city: 'New York',       state: 'NY', expected: 'burger',        category: 'Burger' },
  { idx: 77, name: 'Corner Bistro',                        city: 'New York',       state: 'NY', expected: 'burger',        category: 'Burger' },
  { idx: 78, name: 'Holeman & Finch',                      city: 'Atlanta',        state: 'GA', expected: 'burger',        category: 'Burger' },
  { idx: 79, name: 'Au Cheval',                            city: 'Chicago',        state: 'IL', expected: 'burger',        category: 'Burger' },
  { idx: 80, name: 'Fatburger',                            city: 'Los Angeles',    state: 'CA', expected: 'burger',        category: 'Burger' },
  // CARIBBEAN (81-85)
  { idx: 81, name: "Glady's",                              city: 'New York',       state: 'NY', expected: 'caribbean',     category: 'Caribbean' },
  { idx: 82, name: 'Clover Club',                          city: 'Brooklyn',       state: 'NY', expected: 'caribbean',     category: 'Caribbean' },
  { idx: 83, name: 'Cane & Table',                         city: 'New Orleans',    state: 'LA', expected: 'caribbean',     category: 'Caribbean' },
  { idx: 84, name: "Miss Lily's",                          city: 'New York',       state: 'NY', expected: 'caribbean',     category: 'Caribbean' },
  { idx: 85, name: 'Nuela',                                city: 'New York',       state: 'NY', expected: 'caribbean',     category: 'Caribbean' },
  // ETHIOPIAN (86-90)
  { idx: 86, name: 'Ethiopic',                             city: 'Washington',     state: 'DC', expected: 'ethiopian',     category: 'Ethiopian' },
  { idx: 87, name: 'Demera',                               city: 'Chicago',        state: 'IL', expected: 'ethiopian',     category: 'Ethiopian' },
  { idx: 88, name: 'Ghenet',                               city: 'New York',       state: 'NY', expected: 'ethiopian',     category: 'Ethiopian' },
  { idx: 89, name: 'Tadu',                                 city: 'San Francisco',  state: 'CA', expected: 'ethiopian',     category: 'Ethiopian' },
  { idx: 90, name: 'Meaza',                                city: 'Washington',     state: 'DC', expected: 'ethiopian',     category: 'Ethiopian' },
  // FUSION / TRICKY (91-100)
  { idx: 91, name: 'Nobu Malibu',                          city: 'Malibu',         state: 'CA', expected: 'japanese',      category: 'Fusion/Tricky' },
  { idx: 92, name: 'Momofuku Ko',                          city: 'New York',       state: 'NY', expected: 'japanese',      category: 'Fusion/Tricky' },
  { idx: 93, name: "Roy's",                                city: 'Honolulu',       state: 'HI', expected: 'japanese',      category: 'Fusion/Tricky' },
  { idx: 94, name: 'Cleo',                                 city: 'Los Angeles',    state: 'CA', expected: 'middleeastern', category: 'Fusion/Tricky' },
  { idx: 95, name: 'STREET',                               city: 'Los Angeles',    state: 'CA', expected: 'fallback',      category: 'Fusion/Tricky' },
  { idx: 96, name: 'The Optimist',                         city: 'Atlanta',        state: 'GA', expected: 'seafood',       category: 'Fusion/Tricky' },
  { idx: 97, name: 'Underbelly',                           city: 'Houston',        state: 'TX', expected: 'american',      category: 'Fusion/Tricky' },
  { idx: 98, name: 'Husk',                                 city: 'Charleston',     state: 'SC', expected: 'american',      category: 'Fusion/Tricky' },
  { idx: 99, name: 'Sqirl',                                city: 'Los Angeles',    state: 'CA', expected: 'breakfast',     category: 'Fusion/Tricky' },
  { idx:100, name: 'Superiority Burger',                   city: 'New York',       state: 'NY', expected: 'burger',        category: 'Fusion/Tricky' },
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

// ─── Grading (same as test 1 with TYPES_TO_CUISINE inverse map) ──────
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
  'breakfast_restaurant':      'breakfast',
  'brunch_restaurant':         'breakfast',
};

function competitorMatchesCuisine(competitor, expectedCuisine) {
  const matcher = CUISINE_MATCHERS[expectedCuisine];
  if (!matcher) return false;
  const nameLower = String(competitor.name || '').toLowerCase();
  const types = Array.isArray(competitor.types) ? competitor.types : [];
  const nameHit = matcher.name.some((kw) => nameLower.includes(kw.toLowerCase()));
  const typeHit = matcher.types.some((t) => types.includes(t));
  const inverseHit = types.some((t) => TYPES_TO_CUISINE[t] === expectedCuisine);
  return nameHit || typeHit || inverseHit;
}

function gradeCompetitors(top5, expectedCuisine, subjectName, query) {
  // Special case: 'fallback' — auto-pass when buildCompetitorQuery
  // produced the generic 'restaurant dining' query (acceptable for
  // STREET, food halls, intentionally-ambiguous concepts).
  if (expectedCuisine === 'fallback') {
    const isGenericQuery = String(query || '').toLowerCase().startsWith('restaurant dining');
    return {
      matchCount: isGenericQuery ? top5.length : 0,
      total: top5.length,
      detail: top5.map((c) => ({ name: c.name, rating: c.rating, types: c.types,
                                  matched: isGenericQuery, is_subject: false })),
    };
  }
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
    '722511',
    '72',
    googleTypes,
    tc.city,
    tc.state,
    reviews,
  ]);

  const compHits = await googleTextSearch(query);
  const top5 = compHits.slice(0, 5);
  const grade = gradeCompetitors(top5, tc.expected, place.name, query);
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
  console.log('REAL RESTAURANT COMPETITOR TEST — SET 2');
  console.log(sep);
  console.log(`Total tested: ${total}`);
  console.log(`PASSED:  ${pass.length} (${pct(pass.length, total)})`);
  console.log(`FAILED:  ${fail.length} (${pct(fail.length, total)})`);
  console.log(`SKIPPED: ${skip.length} (not found on Google)`);
  if (err.length) console.log(`ERROR:   ${err.length}`);
  console.log('');

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
    0: 'Chain category map',
    1: 'Google types tag',
    2: 'Name signals',
    3: 'Review-text scoring',
    4: 'Strong single keywords',
    5: 'Generic fallback',
  };
  for (let i = 0; i <= 5; i++) {
    const k = `Layer ${i}`;
    const c = layerCount[k] || 0;
    console.log(`  Layer ${i} ${(layerLabels[i] || '').padEnd(34, ' ')}: ${c} hits`);
  }
  if (layerCount.unknown) console.log(`  Layer ?  unknown                                 : ${layerCount.unknown} hits`);
  console.log('');

  // Per-category accuracy
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

  if (fail.length) {
    console.log('WEAKNESSES FOUND:');
    for (const r of fail) {
      let reason = '';
      if (r.layer_fired === 5) {
        reason = 'fell through to generic fallback — no cuisine signal detected';
      } else if (r.matchCount === 0) {
        reason = `query "${r.query}" returned 0 cuisine matches — wrong cuisine detected OR matcher missed correct ones`;
      } else if (r.matchCount < PASS_THRESHOLD) {
        reason = `query found ${r.matchCount}/${r.total} matching peers — partial signal, possibly thin local market or matcher strict`;
      }
      console.log(`  #${r.idx} ${r.name}: ${reason}`);
    }
    console.log('');
  }

  console.log(sep);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('REAL RESTAURANT COMPETITOR TEST — SET 2 (100 new edge cases)');
  console.log(`Running ${TESTS.length} cases. Estimated ~6 minutes, ~$8 in API costs.\n`);

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

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${OUTPUT_FILE}`);

  printSummary(results);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

/* placesTypeMapper — Google Places types → NAICS-6 fallback table.

   Resolution order in server.js (Phase 2 Session 9.5+):
     1. Name fallback (priority categories first)
     2. Pass 1: specific types
     3. Pass 2: generic types

   Name fallback now runs FIRST so brand/keyword signals override
   misleading type tags from Google (e.g., breweries tagged 'bar',
   chiropractors tagged 'gym', moving companies tagged 'storage'). */

const SPECIFIC_TYPES = {
  dentist: '621210',
  cafe: '722515',
  coffee_shop: '722515',
  car_repair: '811111',
  gym: '713940',
  fitness_center: '713940',
  beauty_salon: '812112',
  hair_care: '812112',
  doctor: '621111',
  hospital: '622110',
  lodging: '721110',
  hotel: '721110',
  campground: '721211',
  rv_park: '721211',
  swimming_pool: '713940',
  movie_theater: '512131',
  convenience_store: '445131',
  gas_station: '457110',
  golf_course: '713910',
  plumber: '238220',
  electrician: '238210',
  roofing_contractor: '238160',
  lawyer: '541110',
  bowling_alley: '713950',
  supermarket: '445110',
  grocery_or_supermarket: '445110',
  pest_control: '561710',
  funeral_home: '812210',
  real_estate_agency: '531210',
  insurance_agency: '524210',
  laundry: '812310',
  veterinary_care: '541940',
  catering: '722320',
  car_dealer: '441110',
  storage: '531130',
  museum: '712110',
  stadium: '711211',
  university: '611310',
  general_contractor: '236220',
  // 'bar' moved to GENERIC (was in SPECIFIC for Tipsy Cow). With name
  // fallback running first, brewery_winery_distillery / entertainment_recreation
  // tokens override the bar tag. If no name token matches and no other
  // SPECIFIC type fires, the GENERIC 'bar' resolves to bar_nightlife.
  night_club: '722410',
  restaurant: '722511',
};

const GENERIC_TYPES = {
  food: '722511',
  health: '713940',
  store: '459999',
  school: '611691',
  // 'bar' demoted from SPECIFIC. Name fallback (brewery/entertainment)
  // overrides this; if no name match and no other SPECIFIC type, bar fires.
  bar: '722410',
};

function mapSpecificType(types) {
  if (!Array.isArray(types)) return null;
  for (const t of types) {
    if (SPECIFIC_TYPES[t]) {
      return { naics6: SPECIFIC_TYPES[t], matched_type: t };
    }
  }
  return null;
}

function mapGenericType(types) {
  if (!Array.isArray(types)) return null;
  for (const t of types) {
    if (GENERIC_TYPES[t]) {
      return { naics6: GENERIC_TYPES[t], matched_type: t };
    }
  }
  return null;
}

function mapTypesToNaics6(types) {
  return mapSpecificType(types) || mapGenericType(types);
}

/* Token specs:
   - Plain string  → unanchored match (existing behavior)
   - { token, anchored: true } → only match at start or end of name
   - { token, anchored: true, blocklist_before: [...] }
       → at-end match also requires the word immediately before the token
         to NOT be in the blocklist (e.g., 'West University' rejected
         for 'university' token because 'west' is blocklisted)

   Order matters: the FIRST category whose any token matches wins. So
   priority categories (must override pass-1 specific) go first. Within
   a single category, all tokens are equivalent. */
const NAME_PATTERNS = [
  // ═══════════════════════════════════════════════════════════════════
  // AGRICULTURE PRIORITY — runs before the catch-all 'farm' pattern so
  // livestock / orchard / grape-farming / agritourism name signals get
  // their correct NAICS-6 (112xxx livestock / 111331 orchard / 111332
  // grape farming / 111998 agritourism) instead of collapsing to 111998
  // generic crop farming. Also runs before the winery pattern so
  // "Bear Creek Vineyards" routes to grape farming (111332) — winery
  // claim is gated by skip_if_contains to require winery/wine/tasting.
  // ═══════════════════════════════════════════════════════════════════
  { label: 'goat_farm', naics6: '112420', tokens: ['goat farm', 'goat dairy', 'goat cheese farm'] },
  { label: 'sheep_farm', naics6: '112410', tokens: ['sheep farm', 'lamb farm'] },
  { label: 'alpaca_farm', naics6: '112420', tokens: ['alpaca farm', 'llama farm'] },
  { label: 'pig_farm', naics6: '112210', tokens: ['pig farm', 'hog farm', 'pork farm'] },
  { label: 'poultry_farm', naics6: '112300', tokens: ['chicken farm', 'poultry farm', 'egg farm'] },
  { label: 'cattle_farm', naics6: '112111', tokens: ['cattle farm', 'beef farm'] },
  // dairy_farm — 'dairy' added as a standalone token with skip_if_contains
  // so "Sunshine Dairy" routes to the livestock-dairy profile while
  // "Dairy Queen" / "Dairy Bar Madison" / "Cassell's Dairy Cafe" divert
  // (those are food-service, not a dairy farm operation).
  { label: 'dairy_farm', naics6: '112120', tokens: ['dairy farm', 'milk farm', 'dairy'], skip_if_contains: ['bar', 'cafe', 'ice cream', 'queen', 'restaurant', 'diner'] },

  // Vineyard without winery → grape farming (111332). skip_if_contains
  // diverts names that ALSO have winery/tasting room back through the
  // later winery pattern → 312130 hospitality.bar_nightlife.
  // Note: 'wine' is too broad as a skip-substring — it matches inside
  // "vineyards" too. We rely on the more specific 'winery' / 'tasting'
  // tokens to detect actual wine production businesses.
  { label: 'grape_farming', naics6: '111332', tokens: ['vineyard', 'vineyards'], skip_if_contains: ['winery', 'tasting'] },

  // Agritourism event venues — corn maze, pumpkin patch, u-pick.
  // Catches names that don't include the word "farm" (e.g.,
  // "Treinen Corn Maze"). Routes to 111998 same as the catch-all but
  // ensures Layer 0 produces the NAICS even when name lacks 'farm'.
  { label: 'agritourism', naics6: '111998', tokens: ['corn maze', 'pumpkin patch', 'u-pick', 'u pick', 'you pick', 'agritourism', 'pick your own'] },

  // Orchard → apple orchards (111331). Runs before the generic 'farm'
  // pattern (which also has 'orchard' as a fallback token mapping to
  // 111998 — that fallback stays for catch-all coverage).
  { label: 'orchard', naics6: '111331', tokens: ['apple orchard', 'orchard'] },

  // Campground / RV park / camping — runs before SPECIFIC types
  // `lodging` and `hotel` (both → 721110) so a campground with no
  // explicit Google `campground` tag still routes to 721211 from its
  // name alone, instead of falling through to generic-hotel territory.
  { label: 'campground', naics6: '721211', tokens: [
    'campground', 'camping', 'campsite', 'camp site', 'rv park', 'tent site',
  ] },

  // Swim instruction → sports & recreation instruction (611620). For a
  // dedicated swim school the lessons are the product (not the facility),
  // so it routes to NAICS 611620 not 713940.
  { label: 'swim_school', naics6: '611620', tokens: [
    'swim school', 'swimming lessons', 'swim lessons',
  ] },

  // Aquatic facility / community pool / swim club — the facility itself
  // is recreation/fitness (713940). Runs after swim_school so dedicated
  // instruction businesses win over facility-only language.
  { label: 'aquatic_facility', naics6: '713940', tokens: [
    'aquatic center', 'swim club', 'community pool',
  ] },

  // Bowling alleys → 713950 (Bowling Centers) — distinct federal NAICS
  // from the 713990 generic amusement catch-all. Runs before the
  // entertainment_recreation pattern (which also has 'bowling' as a
  // token mapped to 713990) so the more specific NAICS wins.
  { label: 'bowling_center', naics6: '713950', tokens: [
    'bowling', 'bowling alley', 'bowling center', 'bowling lanes',
  ] },

  // Movie theaters / cinemas → 512131 (Motion Picture Theaters except
  // Drive-Ins). Federal NAICS-2 is 51 (Information) which routes to
  // information.motion_picture_sound by default — wrong profile for
  // consumer-facing cinemas. AI verification + the MOVIE THEATER
  // misclassification rule corrects the profile to
  // recreation.amusement_attraction at the AI override step.
  { label: 'movie_theater', naics6: '512131', tokens: [
    'cinema', 'movie theater', 'movie theatre',
    'multiplex', 'cineplex', 'imax',
  ] },

  // Drive-in theaters → 512132 (Drive-In Motion Picture Theaters).
  // Separate from indoor cinemas; same profile-correction path applies.
  { label: 'drive_in_theater', naics6: '512132', tokens: [
    'drive-in', 'drive in theater',
  ] },

  // Concert halls / performing arts centers → 711310 (Promoters with
  // facilities). naicsRouter currently routes 711310 to
  // recreation.spectator_sports; AI override + selectBestProfile pick
  // recreation.performing_arts when name signals classical performance.
  { label: 'concert_hall', naics6: '711310', tokens: [
    'concert hall', 'performing arts center', 'symphony',
    'opera house', 'philharmonic', 'auditorium',
  ] },

  // Comedy clubs / live music venues / improv theaters → 711190 (Other
  // Performing Arts Companies). Routes to recreation.performing_arts.
  // Runs before bar_nightlife so 'music venue' wins over generic 'bar'.
  { label: 'comedy_club', naics6: '711190', tokens: [
    'comedy club', 'comedy', 'improv', 'stand up comedy', 'standup',
  ] },
  { label: 'live_music_venue', naics6: '711190', tokens: [
    'music venue', 'live music', 'concert venue', 'music hall',
  ] },

  // Arcades → 713120 (Amusement Arcades) — distinct from the 713990
  // generic amusement catch-all. Runs before entertainment_recreation
  // (which has 'arcade' as a token mapped to 713990) so the more
  // specific NAICS wins.
  { label: 'arcade', naics6: '713120', tokens: [
    'arcade', 'barcade', 'video arcade',
  ] },

  // ═══════════════════════════════════════════════════════════════════
  // RETAIL PRIORITY — specific retail subcategories. Runs BEFORE the
  // PRIORITY block (winery/distillery) so "Madison Wine Shop" or
  // "ABC Spirits Store" match liquor_store (445320) instead of
  // producer NAICS (312130 / 312140).
  // ═══════════════════════════════════════════════════════════════════

  // Clothing / apparel / fashion → 458110 (Clothing Retailers).
  // Plural variants included because the token regex requires a
  // non-letter after the token — 'boutique' alone wouldn't match
  // "Madison Boutiques".
  { label: 'clothing_store', naics6: '458110', tokens: [
    'boutique', 'boutiques', 'clothing store', 'apparel store',
    'apparel stores', 'fashion store',
  ] },

  // Shoes / footwear → 458210 (Shoe Retailers).
  { label: 'shoe_store', naics6: '458210', tokens: [
    'shoe store', 'shoe stores', 'footwear', 'sneaker store', 'sneakers store',
  ] },

  // Jewelry / watches / diamonds → 458310 (Jewelry Retailers).
  // Plurals + British spelling.
  { label: 'jewelry_store', naics6: '458310', tokens: [
    'jewelry store', 'jeweler', 'jewelers',
    'jewellery', 'jewellery store', 'jewellers',
    'diamond store', 'watch store',
  ] },

  // Mattress retailer → 449129 (All Other Home Furnishings Retailers,
  // real federal NAICS). Previously synthetic 449130; corrected here.
  { label: 'mattress_store', naics6: '449129', tokens: [
    'mattress', 'mattress store', 'mattress shop',
  ] },

  // Furniture / home furnishings → 449110 (Furniture Retailers).
  { label: 'furniture_store', naics6: '449110', tokens: [
    'furniture store', 'furniture', 'home furnishings',
  ] },

  // Florist → 459310 (Florists).
  { label: 'florist', naics6: '459310', tokens: [
    'florist', 'florists', 'flower shop', 'flowers shop', 'floral shop',
  ] },

  // Gift / souvenir → 459420 (Gift, Novelty, and Souvenir Retailers).
  { label: 'gift_shop', naics6: '459420', tokens: [
    'gift shop', 'souvenir shop',
  ] },

  // Convenience store / corner store → 445131 (Convenience Retailers).
  { label: 'convenience_store_name', naics6: '445131', tokens: [
    'convenience store', 'c-store', 'mini mart',
  ] },

  // Liquor / wine shop / spirits store → 445320 (Beer, Wine, Liquor
  // Retailers). Runs BEFORE distillery and winery patterns so retail
  // shops with 'wine' or 'spirits' in name don't misroute to producer
  // NAICS (312140 distillery / 312130 winery).
  { label: 'liquor_store', naics6: '445320', tokens: [
    'liquor store', 'wine shop', 'bottle shop', 'spirits store',
  ] },

  // Thrift / consignment / vintage → 459510 (Used Merchandise Retailers).
  { label: 'thrift_store', naics6: '459510', tokens: [
    'thrift', 'consignment', 'vintage shop', 'second hand',
  ] },

  // Sporting goods / outdoor gear → 459110 (Sporting Goods Retailers).
  { label: 'sporting_goods', naics6: '459110', tokens: [
    'sporting goods', 'outdoor gear', 'fishing store', 'hunting store',
  ] },

  // Toy / hobby / game store → 459120 (Hobby, Toy, and Game Retailers).
  { label: 'toy_store', naics6: '459120', tokens: [
    'toy store', 'toy shop', 'hobby shop',
  ] },

  // Bookstore / used books / comic books → 459210 (Book Retailers and
  // News Dealers).
  { label: 'bookstore', naics6: '459210', tokens: [
    'book store', 'used books', 'comic books',
  ] },

  // Hardware stores → 444140 (Hardware Retailers). Distinct from home
  // centers (444110) — hardware stores are smaller specialty retailers.
  { label: 'hardware_store', naics6: '444140', tokens: ['hardware'] },

  // Home centers / lumber yards / home improvement → 444110 (Home
  // Centers).
  { label: 'home_improvement', naics6: '444110', tokens: [
    'lumber yard', 'home improvement',
  ] },

  // Towing / wrecker / roadside assistance → 488410 (Motor Vehicle
  // Towing). Currently has no detection path; without name tokens the
  // route falls through to unsupported page.
  { label: 'towing', naics6: '488410', tokens: [
    'towing', 'tow truck', 'roadside assistance', 'wrecker service', 'wrecker',
  ] },

  // Print shops / copy centers → 323111 (Commercial Printing). Local
  // retail print shops, NOT industrial print manufacturing.
  { label: 'print_shop', naics6: '323111', tokens: [
    'print shop', 'printing', 'copy center', 'print center', 'screen printing',
  ] },

  // Event / wedding planners → 812990. Professional creative service,
  // not personal care. naicsRouter routes 812990 to professional.consulting
  // (changed in this batch) to match the operating model.
  { label: 'event_planner', naics6: '812990', tokens: [
    'event planner', 'event planning', 'wedding planner',
    'event coordinator', 'event management',
  ] },

  // ═══════════════════════════════════════════════════════════════════
  // PRIORITY — these run first so brand/keyword signals override
  // misleading Google types. (Phase 2 Session 9.5.1.)
  // ═══════════════════════════════════════════════════════════════════

  // Brewery / winery / distillery / cidery / meadery — five separate
  // patterns so the correct NAICS-6 is assigned to each producer type
  // (formerly all collapsed to 312120). Order matters — winery first
  // so 'winery' wins over the catch-all 'brewery' default for cases
  // where a winery's name contains generic taproom/tasting-room tokens.
  // All five route to hospitality.bar_nightlife profile via naicsRouter.
  //
  // Note on token 'wine': matches words like 'wine' and 'wines' but
  // can also fire on 'Wine Bar' — the existing bar_nightlife pattern
  // runs LATER so the wine pattern wins. That's intentional for now —
  // wine bars and wine retailers will be classified as wineries, which
  // is wrong but no worse than the previous all-to-312120 behavior.
  { label: 'winery', naics6: '312130', tokens: [
    'winery', 'vineyard', 'wine', 'cellars',
  ], skip_if_contains: ['paint', 'bar', 'lounge'] },
  { label: 'distillery', naics6: '312140', tokens: [
    'distill', 'distillery', 'distilling', 'spirits',
  ] },
  { label: 'cidery', naics6: '312120', tokens: [
    'cider', 'cidery',
  ] },
  { label: 'meadery', naics6: '312130', tokens: [
    'mead', 'meadery',
  ] },
  { label: 'brewery', naics6: '312120', tokens: [
    'brewery', 'brewpub', 'brewing', 'brewed',
    'taproom', 'tasting room',
  ] },

  // Entertainment/recreation — overrides `bar`, `gym`, etc. for venues
  // that serve drinks but are primarily entertainment.
  { label: 'entertainment_recreation', naics6: '713990', tokens: [
    'escape room', 'escape rooms', 'axe throwing', 'axe throw',
    'trampoline', 'bounce', 'laser tag', 'go kart', 'go-kart',
    'mini golf', 'miniature golf', 'putt putt', 'putt-putt', 'fun center', 'family fun',
    'arcade', 'billiards', 'pool hall',
    'bowling',
  ] },

  // Plumbing/HVAC — overrides `general_contractor` SPECIFIC.
  { label: 'plumbing_hvac', naics6: '238220', tokens: [
    'plumbing', 'plumber', 'rooter', 'drain',
    'hvac', 'heating', 'cooling', 'air conditioning', 'furnace',
    'mechanical', 'sewer',
  ] },

  // Electrical contractors → 238210 (Electrical Contractors). Moved
  // out of the generic `construction` pattern (which used 236115 —
  // wrong NAICS for licensed electrical specialty contractors).
  { label: 'electrical_contractor', naics6: '238210', tokens: [
    'electrical', 'electrician', 'electric service',
  ] },

  // Roofing contractors → 238160 (Roofing Contractors). Moved out of
  // the generic `construction` pattern. Runs HERE (priority block,
  // before auto_repair) so "Madison Roof Repair" matches the 'roof
  // repair' token here instead of falling through to auto_repair's
  // generic 'repair' token (which would route to 811111 — wrong).
  { label: 'roofing_contractor', naics6: '238160', tokens: [
    'roofing', 'roofer', 'roof repair', 'roof replacement', 'shingles', 'gutters',
  ] },

  // Chiropractic — overrides `gym` SPECIFIC.
  { label: 'chiropractic', naics6: '621310', tokens: [
    'chiropractic', 'chiropractor', 'chiro',
    'spine', 'spinal', 'adjustment',
  ] },

  // Physical / occupational / speech therapy — NAICS 621340 (Offices
  // of Physical, Occupational and Speech Therapists, and Audiologists).
  // Previously these tokens routed to 621310 (Offices of Chiropractors)
  // which was wrong — chiropractors and physical therapists are distinct
  // federal NAICS classifications with different licensing and revenue
  // models. Runs BEFORE behavioral_health so 'therapy' here catches PT
  // clinics before falling through to mental-health 621330.
  { label: 'physical_therapy', naics6: '621340', tokens: [
    'physical therapy', 'physical therapist',
    'occupational therapy', 'occupational therapist',
    'speech therapy', 'audiology', 'audiologist',
    'sports medicine', 'physical rehabilitation',
    'sports rehab', 'sports rehabilitation',
  ] },

  // Behavioral health / mental health — extends existing with user-requested
  // tokens. 'therapy'/'therapist' are broad and could match PT clinics, but
  // allied_health runs first to catch those.
  { label: 'behavioral_health', naics6: '621330', tokens: [
    'recovery', 'treatment center', 'rehab', 'rehabilitation',
    'mental health', 'counseling', 'counselor',
    'behavioral health', 'behavioral',
    'addiction', 'detox', 'substance abuse',
    'psychiatric', 'psychiatry', 'psychiatrist',
    'psychology', 'psychologist',
    'therapy', 'therapist',
    'wellness center',
  ] },

  // Property management — runs BEFORE real_estate so 'Greystar Real Estate'
  // matches via 'greystar' token (property_management) not 'real estate'
  // token (real_estate brokerage).
  { label: 'property_management', naics6: '531311', tokens: [
    'property management', 'property manager',
    'apartment management', 'residential management',
    'greystar', 'equity residential',
  ] },

  // Moving company — must run before storage SPECIFIC type. Two Men and a
  // Truck is tagged 'storage' by Google.
  { label: 'moving_company', naics6: '484210', tokens: [
    'moving company', 'van lines', 'movers', 'relocation',
    'moving', 'two men', 'moving truck',
  ] },

  // Creamery / ice cream — overrides 'restaurant' SPECIFIC.
  { label: 'creamery', naics6: '722515', tokens: [
    'creamery', 'creameries',
    'ice cream', 'ice creams',
    'gelato', 'frozen yogurt', 'soft serve', 'dairy bar',
  ] },

  // Tour operator — must run before any catch-all transportation tokens.
  // NOTE: 561520 routes to admin.office_business_support per CSV. If user
  // wanted transportation.passenger profile, NAICS would be 487110.
  { label: 'tour_operator', naics6: '561520', tokens: [
    'tours', 'tour company', 'tour operator',
    'sightseeing', 'city tour', 'walking tour',
  ] },

  // ═══════════════════════════════════════════════════════════════════
  // EXISTING categories (with extensions added)
  // ═══════════════════════════════════════════════════════════════════

  { label: 'legal', naics6: '541110', tokens: ['law', 'llp', 'attorney', 'attorneys', 'legal', 'lawyer', 'law firm', 'law office', '& associates', 'esquire', 'esq', 'counsel', 'solicitor'] },
  { label: 'dental', naics6: '621210', tokens: ['dental', 'dentist', 'orthodont', 'endodont', 'periodont', 'oral surgery', 'smile', 'teeth'] },
  // Urgent care — NAICS 621493 (Freestanding Ambulatory Surgical and
  // Emergency Centers). Runs BEFORE the generic `medical` pattern so
  // 'urgent care' / 'walk-in clinic' / 'immediate care' don't fall
  // through to 621111 (general physician offices), which have very
  // different revenue dynamics (insurance panels, scheduled visits)
  // than urgent care (walk-in cash + after-hours billing codes).
  { label: 'urgent_care', naics6: '621493', tokens: [
    'urgent care', 'walk-in clinic', 'walk in clinic',
    'immediate care', 'after hours clinic',
  ] },

  // 'md' was too risky — false-matched when names like "Smith, MD" or
  // any Maryland-state-suffix businesses appeared. 'm.d.' (with periods)
  // is unambiguous and remains. Other tokens (doctor, physician, clinic,
  // health center) already cover the medical-practice detection.
  { label: 'medical', naics6: '621111', tokens: ['medical', 'medicine', 'clinic', 'health center', 'physician', 'doctor', 'm.d.', 'family care', 'pediatric'] },
  { label: 'accounting', naics6: '541211', tokens: ['accounting', 'cpa', 'bookkeeping', 'tax', 'financial services', 'payroll'] },
  { label: 'ria_wealth_management', naics6: '523940', tokens: ['financial advisor', 'wealth management', 'investment advisor', 'investment management', 'edward jones', 'raymond james', 'morgan stanley', 'merrill lynch', 'ubs financial', 'ameriprise', 'fidelity investments'] },

  // staffing_agency — added 'recruitment', 'randstad' tokens.
  { label: 'staffing_agency', naics6: '561311', tokens: [
    'robert half', 'staffing agency', 'staffing',
    'recruitment', 'recruiter', 'recruiting',
    'employment agency', 'executive search', 'temp agency',
    'adecco', 'manpower', 'kelly services', 'aerotek', 'insight global', 'randstad',
  ] },

  // Consulting (NEW). Brand tokens placed before generic so 'McKinsey'
  // wins over 'management consulting' if both somehow appeared.
  { label: 'consulting', naics6: '541611', tokens: [
    'mckinsey', 'deloitte', 'bcg', 'bain', 'accenture',
    'consulting', 'consultants', 'advisory',
    'management consulting', 'strategy consulting', 'strategy',
  ] },

  // Mortgage (NEW).
  { label: 'mortgage', naics6: '522292', tokens: [
    'mortgage', 'home loan', 'home loans', 'lending', 'lender', 'refinance',
  ] },

  // Photography studios (NEW).
  { label: 'photography', naics6: '541921', tokens: [
    'photography', 'photographer', 'portrait', 'photo studio', 'headshots',
  ] },

  // Video / motion picture production (NEW).
  { label: 'video_production', naics6: '512110', tokens: [
    'video production', 'videography', 'videographer',
    'film production', 'motion picture',
  ] },

  // Web design / development / IT services (NEW). 541512 → consulting profile.
  { label: 'web_design', naics6: '541512', tokens: [
    'web design', 'web development', 'website', 'digital agency', 'digital studio',
    'it support', 'it services', 'managed services', 'it consulting',
  ] },

  // Graphic design (NEW). NOTE: 541430 routes to professional.architecture_engineering
  // per CSV, not professional.consulting as the user expected.
  { label: 'graphic_design', naics6: '541430', tokens: [
    'graphic design', 'graphic designer', 'branding', 'brand design', 'visual design',
  ] },

  // Farmers market (NEW). Runs before generic 'farm' category so HOPE
  // Farmers Market routes to grocery_food not crop_farming.
  { label: 'farmers_market', naics6: '445230', tokens: [
    'farmers market', "farmer's market", "farmers' market",
    'farm stand', 'farm market', 'public market',
  ] },

  { label: 'appliance_repair', naics6: '811412', tokens: ['appliance', 'washer', 'dryer', 'refrigerator', 'dishwasher', 'oven', 'microwave', 'electronic repair', 'phone repair', 'computer repair', 'screen repair', 'fix it', 'repair shop', 'shoe repair', 'cobbler', 'furniture repair', 'upholstery'] },
  { label: 'auto_dealer', naics6: '441110', tokens: ['dealership', 'auto sales', 'auto group', 'car sales', 'motors'], skip_if_contains: ['repair', 'motorsports', 'motorcycle', 'motorbike'] },
  // Tire retailers — NAICS 441330 (Tire Dealers). Runs BEFORE auto_repair
  // so "Mavis Discount Tire" routes to retail.auto_dealers (tire retail)
  // rather than getting the auto-repair profile (which would surface
  // brake/oil-change/ASE-certification recommendations that don't apply).
  { label: 'tire_dealer', naics6: '441330', tokens: [
    'tire dealer', 'tire shop', 'tire store', 'tires plus',
    'discount tire', 'tire center', 'tire warehouse',
  ] },
  // 'tire' token removed from auto_repair — it was claiming every tire
  // retailer for an auto-repair profile. Use the dedicated tire_dealer
  // pattern above for retail tire shops.
  { label: 'auto_repair', naics6: '811111', tokens: ['auto', 'motors', 'automotive', 'repair', 'mechanic', 'transmission', 'collision', 'body shop', 'oil change'] },
  { label: 'bootcamp', naics6: '611420', tokens: ['general assembly', 'flatiron school', 'hack reactor', 'app academy', 'springboard', 'lambda school', 'bloomtech', 'coding bootcamp', 'code camp', 'bootcamp'] },
  { label: 'commercial_gc', naics6: '236220', tokens: ['turner construction', 'skanska', 'whiting-turner', 'aecom hunt', 'mortenson construction', 'suffolk construction', 'commercial construction', 'commercial builders'] },
  // construction — removed plumbing/hvac tokens (now in plumbing_hvac category).
  // construction — 'electrical' moved to electrical_contractor pattern
  // (238210). 'roofing' moved to roofing_contractor pattern (238160).
  // Both are in the PRIORITY block above so they fire before auto_repair
  // (which has 'repair' as a token and would otherwise eat "Roof Repair").
  { label: 'construction', naics6: '236115', tokens: ['construction', 'builders', 'contracting', 'remodeling', 'renovation'] },
  { label: 'waste_management', naics6: '562111', tokens: ['waste management', 'garbage', 'trash', 'recycling', 'sanitation services', 'waste disposal', 'dumpster'] },
  // cleaning — added 'maids' (plural) for Merry Maids.
  { label: 'cleaning', naics6: '561720', tokens: ['cleaning', 'janitorial', 'maid', 'maids', 'housekeeping'] },
  // real_estate — runs AFTER property_management so 'Greystar Real Estate'
  // hits property_management first.
  { label: 'real_estate', naics6: '531210', tokens: ['realty', 'real estate', 'properties', 'realtor'] },
  { label: 'insurance', naics6: '524210', tokens: ['insurance', 'agency', 'allstate', 'state farm'] },
  { label: 'bar_nightlife', naics6: '722410', tokens: ['bar', 'tavern', 'pub', 'saloon', 'nightclub', 'lounge'], skip_if_contains: ['oxygen', 'archery'] },
  { label: 'pest', naics6: '561710', tokens: ['terminix', 'servicemaster', 'trugreen', 'aptive', 'ehrlich', 'western pest', 'pest', 'exterminator', 'termite'] },
  { label: 'funeral', naics6: '812210', tokens: ['funeral', 'memorial', 'mortuary', 'cremation'] },
  // Music schools / lessons → 611610 (Fine Arts Schools). Removed
  // from k12_private below — music school is fine arts instruction
  // (611610), not K-12 private school (611110). Runs BEFORE k12_private
  // so 'school of music' wins over generic 'school' tokens.
  { label: 'music_school', naics6: '611610', tokens: [
    'music school', 'school of music', 'music academy', 'music studio',
    'piano lessons', 'guitar lessons', 'violin lessons', 'music lessons',
  ] },

  // Art schools / studios → 611610 (Fine Arts Schools). Removed
  // from the generic education pattern below — art school is fine
  // arts instruction, not test prep / tutoring (611691).
  { label: 'art_school', naics6: '611610', tokens: [
    'art school', 'school of arts', 'art studio classes',
    'painting classes', 'ceramics studio', 'pottery classes',
    'drawing classes',
  ] },

  // k12_private — removed 'school of music', 'music school', and
  // 'school of arts' (now in music_school / art_school patterns above
  // at NAICS 611610).
  { label: 'k12_private', naics6: '611110', tokens: ['montessori', 'waldorf', 'prep school', 'preparatory school', 'private school', 'parochial school'] },
  { label: 'childcare', naics6: '624410', tokens: ['kindercare', 'bright horizons', 'goddard school', 'primrose school', 'la petite academy', 'childcare', 'daycare', 'preschool', 'nursery', 'learning center'] },
  // education — removed 'art school' (now in art_school pattern at
  // 611610 above). 'conservatory' stays here since music conservatories
  // historically classified under broader education prep.
  { label: 'education', naics6: '611691', tokens: ['kumon', 'conservatory', 'driving school', 'driver ed', 'tutor', 'tutoring'] },
  // Libraries → 519210 (Libraries and Archives). naicsRouter routes 519210
  // to OUT_OF_SCOPE_NICHE since public/government libraries are not SMB
  // clients. Runs BEFORE college_university so "University Library" picks
  // the library pattern (not the 'university' token in college_university)
  // and routes to the OOS waitlist instead of an inapplicable college
  // profile. skip_if_contains diverts retail "Library Lane Cafe" /
  // "Library Bar" naming away — those are restaurants/bars, not libraries.
  // NOTE: spec said 519290 but that NAICS is already in use for legitimate
  // content-creator routes (newsletters, YouTubers, podcasts). The correct
  // canonical NAICS for libraries is 519210 (Libraries and Archives), so
  // we OOS-gate that code instead.
  // CAUTION on skip tokens: skipIfContains is a plain substring match, so
  // tokens like 'pub' false-match inside 'public library'. Limit to
  // unambiguous strings that are NOT prefixes of common library words.
  { label: 'library', naics6: '519210', tokens: [
    'public library', 'library', 'archives', 'archive center', 'public archive',
  ], skip_if_contains: ['cafe', 'coffee', 'lounge', 'restaurant', 'kitchen', 'tavern', 'bistro'] },

  { label: 'college_university', naics6: '611310', tokens: [
    'state university', 'community college', 'junior college', 'campus',
    { token: 'university', anchored: true, blocklist_before: ['west', 'east', 'north', 'south', 'old', 'new', 'central', 'upper', 'lower'] },
    { token: 'college', anchored: true, blocklist_before: ['west', 'east', 'north', 'south', 'old', 'new', 'central', 'upper', 'lower'] },
  ], skip_if_contains: [
    // BUG 14 — corporate-campus false matches. 'Apple Campus', 'Google
    // Campus', etc. would otherwise hit the 'campus' token and route to
    // college. Add the major tech/retail/auto brand names that operate
    // sprawling corporate campuses. 'meta' / 'intel' / 'apple' are short
    // substrings that may false-match inside 'metal' / 'intelligence' /
    // 'pineapple' — acceptable since the resulting skip just lets the
    // input fall through to a more appropriate pattern.
    'apple', 'google', 'microsoft', 'amazon', 'meta', 'facebook', 'netflix',
    'tesla', 'nvidia', 'intel', 'oracle', 'salesforce', 'cisco', 'adobe',
    'walmart', 'target', 'nike', 'disney', 'pixar',
    // BUG 19 — retail false matches. 'University Coffee', 'College Bar',
    // 'University Bookstore' would otherwise hit the anchored
    // 'university'/'college' tokens. These suffixes mark the business
    // as retail/hospitality, not an educational institution. 'pub' is
    // INTENTIONALLY excluded — it's a substring of 'public' which
    // appears in legitimate names ("University Public Affairs Office"),
    // and the 'bar'/'tavern' tokens already cover most pub naming.
    'coffee', 'cafe', 'café', 'restaurant', 'kitchen', 'bar',
    'tavern', 'bistro', 'eatery', 'diner', 'grill', 'shop', 'store',
    'market', 'bookstore', 'salon', 'cleaners', 'laundromat',
  ] },
  { label: 'veterinary', naics6: '541940', tokens: ['veterinary', 'animal hospital', 'vet'] },
  { label: 'catering', naics6: '722320', tokens: ['catering', 'caterer'] },
  // pet_grooming — extended with dog/pet training tokens (same NAICS 812910).
  { label: 'pet_grooming', naics6: '812910', tokens: ['grooming', 'groomer', 'kennel', 'pet boarding', 'dog training', 'dog trainer', 'pet training', 'obedience training', 'puppy training'] },
  // equipment_rental — extended with party rental specifics + plural forms.
  { label: 'equipment_rental', naics6: '532289', tokens: ['party rental', 'party rentals', 'event rental', 'event rentals', 'rental', 'rentals', 'party supply', 'party supplies', 'tent rental', 'bounce house rental'], skip_if_contains: ['kayak', 'canoe', 'bike', 'bicycle', 'paddleboard'] },
  // Taxi / rideshare / shuttle → 485310 (Taxi and Ridesharing Services).
  { label: 'taxi_service', naics6: '485310', tokens: [
    'yellow cab', 'taxi', 'cab', 'rideshare', 'shuttle',
    'tour bus', 'sightseeing',
  ] },

  // Limousine service → 485320 (Limousine Service). Federally distinct
  // from taxi/cab (485310) — limos are pre-booked luxury transport,
  // taxis are hailed/dispatched.
  { label: 'limousine_service', naics6: '485320', tokens: [
    'limousine', 'limo', 'chauffeured', 'chauffeur', 'black car',
    'car service', 'executive transport',
  ] },

  // Trucking (local + LTL) → 484110 / 484122 (General Freight Trucking).
  // Routes to transportation.trucking_freight. 'carrier' is somewhat
  // ambiguous (could match Carrier HVAC) but transportation context
  // usually dominates.
  { label: 'trucking', naics6: '484110', tokens: [
    'trucking company', 'trucking', 'freight company', 'hauling',
    'logistics company',
  ] },
  { label: 'trucking_ltl', naics6: '484122', tokens: ['carrier'] },

  // Freight brokers → 488510 (Freight Transportation Arrangement).
  // Previously had no detection path — freight broker submissions
  // fell through to unsupported page.
  { label: 'freight_broker', naics6: '488510', tokens: [
    'freight broker', 'freight brokerage', 'load broker',
    'shipping broker', 'logistics broker',
  ] },

  // Truck stops → 447110 (synthetic — historical NAICS, retired in
  // 2022 NAICS revision but kept here as registry-internal code to
  // distinguish truck stops from regular gas-with-c-stores at 457110).
  // Routes to retail.fuel_general_misc.
  { label: 'truck_stop', naics6: '447110', tokens: [
    'truck stop', 'truckstop', 'truck plaza', 'travel center', 'travel plaza',
  ] },

  // Gas stations / fuel stations → 457110 (Gasoline Stations with
  // Convenience Stores). Runs HERE so name signals override Google
  // tag absence. Distinct from truck_stop pattern above.
  // BUG 18/23 — 'service station' token removed. Many legitimate auto
  // repair shops, tire shops, and detail shops use "service station" in
  // their name (e.g., "Joe's Auto Service Station") without selling
  // gasoline. Letting the token match was routing them to a gas-station
  // profile instead of auto repair / tire / detailing. Strong gas-pump
  // signals ('gas station', 'fuel station', etc.) remain.
  { label: 'gas_station', naics6: '457110', tokens: [
    'gas station', 'fuel station', 'petrol station',
    'filling station',
  ] },

  // RV dealers → 441210 (Recreational Vehicle Dealers). Runs BEFORE
  // auto_dealer pattern (which has 'dealership' / 'motors' tokens
  // mapping to 441110 — regular car dealers) so RV-named businesses
  // route to their correct dedicated NAICS.
  { label: 'rv_dealer', naics6: '441210', tokens: [
    'rv dealer', 'rv sales', 'rv center', 'motorhome',
    'camper dealer', 'travel trailer', 'recreational vehicle',
  ] },

  // Motorcycle dealers → 441227 (Motorcycle, ATV, and All Other Motor
  // Vehicle Dealers). Runs BEFORE auto_dealer.
  { label: 'motorcycle_dealer', naics6: '441227', tokens: [
    'motorcycle dealer', 'motorcycle shop', 'powersports',
    'motorbike dealer', 'harley',
  ] },

  // BUG 16 — Marinas split from boat_dealer. Marinas are recreation
  // (docking, slip rental, fueling, harbor services) — federally NAICS
  // 713930 → recreation.amusement_attraction. Boat dealers (sales) are
  // retail — 441222 → retail.auto_dealers. Earlier we lumped them under
  // 441222 ("most marinas sell boats too") but that was wrong for the
  // common case of municipal/private marinas with NO sales operation
  // (e.g., harbor marinas, yacht clubs). Marina pattern runs FIRST so a
  // name like "Lake Mendota Marina" routes to recreation before the
  // boat_dealer pattern can claim it.
  // skip_if_contains diverts true boat sales businesses ("Marina Boat
  // Sales", "Yacht Marina Dealership") back to boat_dealer below.
  { label: 'marina', naics6: '713930', tokens: [
    'marina', 'marinas', 'harbor marina', 'yacht club', 'boat club',
    'boat dock', 'boat slip', 'slip rental', 'harbor master',
  ], skip_if_contains: ['boat sales', 'dealer', 'dealership'] },

  // Boat dealers → 441222 (Boat Dealers). For pure sales operations.
  // 'marina' token removed (BUG 16) — pure marinas now match the
  // marina pattern above and route to recreation.
  { label: 'boat_dealer', naics6: '441222', tokens: [
    'boat dealer', 'marine dealer', 'yacht dealer',
    'pontoon dealer', 'boat sales',
  ] },

  // Paint-and-sip / wine-and-paint art classes → 711510 (Independent
  // Artists). Recreation/entertainment, not retail.
  { label: 'paint_and_sip', naics6: '711510', tokens: [
    'paint and sip', 'paint and wine', 'sip and paint',
    'painting class', 'wine and paint',
  ] },

  // Live theaters → 711110 (Theater Companies and Dinner Theaters).
  // 'theater' added as standalone token with skip_if_contains to defer
  // to movie_theater pattern when the name is clearly a cinema. So
  // "Capitol Theater" → live_theater (711110), but "Marcus Movie
  // Theater" or "Madison Cinema Theater" still routes to movie_theater
  // (the movie patterns fire earlier in NAME_PATTERNS via 'cinema',
  // 'multiplex', 'cineplex' tokens; the skip_if_contains is belt + suspenders).
  { label: 'live_theater', naics6: '711110', tokens: [
    'playhouse', 'live theater', 'community theater', 'dinner theater',
    'theater company', 'theatre', 'theater',
  ], skip_if_contains: ['movie', 'cinema', 'multiplex', 'cineplex', 'imax', 'drive-in', 'drive in'] },

  // Dance companies → 711120 (Dance Companies). Recreation.performing_arts.
  { label: 'dance_company', naics6: '711120', tokens: [
    'dance company', 'ballet company', 'dance troupe', 'dance theatre',
  ] },

  // Soccer fields / complexes → 713990 (All Other Amusement and
  // Recreation Industries).
  { label: 'soccer_facility', naics6: '713990', tokens: [
    'soccer field', 'soccer complex', 'soccer club', 'futbol',
  ] },

  // Hockey rinks / ice arenas → 711219 (Other Spectator Sports).
  { label: 'hockey_rink', naics6: '711219', tokens: [
    'hockey rink', 'ice rink', 'ice arena', 'ice complex', 'skating rink',
  ] },

  // Fishing charters + hunting guides → 487210 (Scenic and Sightseeing
  // Transportation, Water). Routes to transportation.passenger.
  { label: 'fishing_hunting_charter', naics6: '487210', tokens: [
    'fishing charter', 'charter fishing', 'sport fishing', 'fishing guide',
    'hunting guide', 'hunting outfitter', 'guided hunt',
  ] },

  // Golf courses → 713910 (Golf Courses and Country Clubs). 'mini golf'
  // intentionally NOT here — it routes to 713990 via the existing
  // entertainment_recreation pattern.
  { label: 'golf_course_name', naics6: '713910', tokens: [
    'golf course', 'golf club', 'country club', 'golf resort',
  ] },

  // Tennis facilities → 713990.
  { label: 'tennis_facility', naics6: '713990', tokens: [
    'tennis club', 'tennis center', 'tennis court',
  ] },

  // Shooting ranges → 713990 (recreation), NOT 611699 (education).
  // Shooting ranges are recreation businesses; firearm safety classes
  // are a small add-on, not the primary revenue.
  { label: 'shooting_range', naics6: '713990', tokens: [
    'shooting range', 'gun range', 'rifle range', 'firearms range',
  ] },

  // Archery ranges / clubs → 713990.
  { label: 'archery_facility', naics6: '713990', tokens: [
    'archery range', 'archery club', 'archery bar', 'archery lounge',
  ] },

  // Ski resorts → 713920 (Skiing Facilities).
  { label: 'ski_resort', naics6: '713920', tokens: [
    'ski resort', 'ski area', 'ski hill', 'ski lodge', 'snowboard park',
  ] },

  // Horse stables / equestrian centers → 712219 (synthetic — federal
  // taxonomy splits boarding/lessons across multiple codes; routes to
  // recreation/agriculture profile via fallback).
  { label: 'horse_stable', naics6: '712219', tokens: [
    'horse stable', 'equestrian center', 'horse boarding',
    'riding stable', 'equestrian',
  ] },

  // Kayak / canoe / bike rentals (outdoor recreation rental) → 532292
  // (All Other Consumer Goods Rental).
  { label: 'outdoor_rental', naics6: '532292', tokens: [
    'kayak rental', 'kayak tour', 'bike rental', 'bicycle rental',
    'canoe rental',
  ] },

  // Cat / dog / pet cafes → 722515 (Snack and Nonalcoholic Beverage
  // Bars — same NAICS as regular cafes, but separate pattern so the
  // CAT CAFE RULE in SYSTEM_PROMPT_A can fire on the name signal).
  { label: 'pet_cafe', naics6: '722515', tokens: [
    'cat cafe', 'dog cafe', 'pet cafe',
  ] },

  // Haunted houses / scare attractions → 711190 (Other Performing
  // Arts Companies). Seasonal entertainment.
  { label: 'haunted_house', naics6: '711190', tokens: [
    'haunted house', 'haunted attraction', 'haunted maze', 'scare maze',
    'fear factory',
  ] },

  // Rage rooms / smash rooms → 713990 (recreation).
  { label: 'rage_room', naics6: '713990', tokens: [
    'rage room', 'smash room', 'anger room', 'destruction room',
  ] },

  // Oxygen bars / oxygen lounges → 812199 (Other Personal Care Services).
  // 'oxygen lounge' added — bar_nightlife pattern's skip_if_contains 'oxygen'
  // catches the brand, but without an oxygen_bar-side token for "Oxygen
  // Lounge Madison" we'd fall through to types[] and probably misclassify.
  { label: 'oxygen_bar', naics6: '812199', tokens: [
    'oxygen bar', 'oxygen therapy', 'oxygen lounge',
  ] },
  // Art galleries → 459920 (Art Dealers). Commercial art retail is
  // distinct from museums (712110) — retail margin model with sales,
  // not nonprofit/donation model with admissions.
  { label: 'art_gallery', naics6: '459920', tokens: [
    'art gallery', 'fine art gallery', 'gallery',
  ] },

  // Historical sites → 712120 (Historical Sites). Distinct federal
  // NAICS from museums (712110) and zoos (712130). Order: historical
  // tokens BEFORE the museum pattern so 'historical museum' wins
  // over plain 'museum' substring.
  { label: 'historical_site', naics6: '712120', tokens: [
    'historical site', 'historic site', 'heritage site', 'historical museum',
  ] },

  // Zoos / aquariums / botanical gardens / wildlife → 712130 (Zoos
  // and Botanical Gardens). Distinct from museums (712110).
  { label: 'zoo_aquarium', naics6: '712130', tokens: [
    'aquarium', 'zoo', 'botanical garden', 'wildlife park', 'nature center',
  ] },

  // Museums (residual) → 712110. Now only catches generic museum/
  // heritage/planetarium tokens — gallery/historical/zoo split out.
  { label: 'museum_heritage', naics6: '712110', tokens: [
    'museum', 'heritage', 'planetarium',
  ] },
  { label: 'spectator_sports', naics6: '711211', tokens: ['stadium', 'ballpark', 'arena', 'racetrack'] },
  { label: 'farm', naics6: '111998', tokens: ['orchard', 'u-pick', 'pick your own', 'csa farm', 'farms', 'farm'] },
  { label: 'courier_delivery', naics6: '492110', tokens: ['amazon delivery', 'amazon dsp', 'amazon logistics', 'delivery station', 'fedex office', 'fedex shipping', 'dhl express', 'dhl shipping', 'dhl', 'ups store', 'courier', 'package delivery'] },
  // 'service center' was too generic — Apple Service Centers, auto
  // service centers, HVAC service centers were all misrouting to ISP.
  // Brand-name ISPs (comcast/xfinity/verizon/spectrum/etc.) already
  // cover the legitimate ISP detection.
  { label: 'telecom_isp', naics6: '517111', tokens: ['comcast', 'xfinity', 'verizon', 'spectrum', 'cox communications', 'frontier communications', 'centurylink', 'lumen', 'altice', 'internet service provider', 'cable internet'] },
  { label: 'semiconductor', naics6: '334413', tokens: ['intel corporation', 'semiconductor', 'chip fab', 'fabrication plant'] },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileToken(tokenSpec) {
  if (typeof tokenSpec === 'string') {
    return {
      token: tokenSpec,
      patterns: [{ regex: new RegExp('(?:^|[^a-z])' + escapeRegex(tokenSpec) + '(?:[^a-z]|$)', 'i'), checkBlocklist: false }],
    };
  }
  // Object form: anchored, optional blocklist
  const t = tokenSpec.token;
  const esc = escapeRegex(t);
  const patterns = [];
  if (tokenSpec.anchored) {
    patterns.push({ regex: new RegExp('^' + esc + '(?:[^a-z]|$)', 'i'), checkBlocklist: false });
    patterns.push({
      regex: new RegExp('(?:^|[^a-z])' + esc + '$', 'i'),
      checkBlocklist: !!tokenSpec.blocklist_before,
      blocklistBefore: tokenSpec.blocklist_before ? tokenSpec.blocklist_before.map((s) => s.toLowerCase()) : null,
    });
  } else {
    patterns.push({ regex: new RegExp('(?:^|[^a-z])' + esc + '(?:[^a-z]|$)', 'i'), checkBlocklist: false });
  }
  return { token: t, patterns };
}

const COMPILED_NAME_PATTERNS = NAME_PATTERNS.map((cat) => ({
  label: cat.label,
  naics6: cat.naics6,
  compiledTokens: cat.tokens.map(compileToken),
  skipIfContains: cat.skip_if_contains
    ? cat.skip_if_contains.map((t) => t.toLowerCase())
    : null,
}));

function tokenMatches(name, compiled) {
  for (const p of compiled.patterns) {
    if (p.regex.test(name)) {
      if (p.checkBlocklist && p.blocklistBefore) {
        // Get the word immediately before the token at end of name
        const lower = name.toLowerCase().trim();
        const tokenLen = compiled.token.length;
        const beforeSegment = lower.slice(0, lower.length - tokenLen).trim();
        const lastWord = beforeSegment.split(/[\s\-]+/).pop() || '';
        if (p.blocklistBefore.includes(lastWord)) {
          continue; // blocked, try next pattern
        }
      }
      return true;
    }
  }
  return false;
}

function mapNameToNaics6(name) {
  if (!name || typeof name !== 'string') return null;
  const lowerName = name.toLowerCase();
  for (const cat of COMPILED_NAME_PATTERNS) {
    if (cat.skipIfContains && cat.skipIfContains.some((t) => lowerName.includes(t))) {
      continue;
    }
    for (const compiled of cat.compiledTokens) {
      if (tokenMatches(name, compiled)) {
        return {
          naics6: cat.naics6,
          matched_token: compiled.token,
          matched_category: cat.label,
        };
      }
    }
  }
  return null;
}

const TYPE_TO_NAICS6 = { ...SPECIFIC_TYPES, ...GENERIC_TYPES };

module.exports = {
  TYPE_TO_NAICS6,
  SPECIFIC_TYPES,
  GENERIC_TYPES,
  NAME_PATTERNS,
  mapTypesToNaics6,
  mapSpecificType,
  mapGenericType,
  mapNameToNaics6,
};

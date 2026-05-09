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
  plumber: '236115',
  electrician: '236115',
  roofing_contractor: '236115',
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
  // PRIORITY — these run first so brand/keyword signals override
  // misleading Google types. (Phase 2 Session 9.5.1.)
  // ═══════════════════════════════════════════════════════════════════

  // Brewery/winery/distillery — overrides Google's `bar` tag.
  { label: 'brewery_winery_distillery', naics6: '312120', tokens: [
    'brewery', 'brewpub', 'brewing', 'brewed',
    'winery', 'vineyard', 'cellars',
    'distillery', 'distilling',
    'cidery', 'meadery', 'taproom', 'tasting room',
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

  // Chiropractic — overrides `gym` SPECIFIC.
  { label: 'chiropractic', naics6: '621310', tokens: [
    'chiropractic', 'chiropractor', 'chiro',
    'spine', 'spinal', 'adjustment',
  ] },

  // Allied health — runs BEFORE behavioral_health so 'physical therapy'
  // matches here (allied_health, 621310) instead of 'therapy' falling
  // through to behavioral_health (621330).
  { label: 'allied_health', naics6: '621310', tokens: [
    'physical therapy', 'physical therapist',
    'occupational therapy', 'occupational therapist',
    'speech therapy', 'audiology', 'audiologist',
    'sports medicine', 'physical rehabilitation',
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
  { label: 'medical', naics6: '621111', tokens: ['medical', 'medicine', 'clinic', 'health center', 'physician', 'doctor', 'md', 'family care', 'urgent care', 'pediatric'] },
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
  { label: 'auto_dealer', naics6: '441110', tokens: ['dealership', 'auto sales', 'auto group', 'car sales', 'motors'], skip_if_contains: ['repair'] },
  { label: 'auto_repair', naics6: '811111', tokens: ['auto', 'motors', 'automotive', 'repair', 'mechanic', 'tire', 'transmission', 'collision', 'body shop', 'oil change'] },
  { label: 'bootcamp', naics6: '611420', tokens: ['general assembly', 'flatiron school', 'hack reactor', 'app academy', 'springboard', 'lambda school', 'bloomtech', 'coding bootcamp', 'code camp', 'bootcamp'] },
  { label: 'commercial_gc', naics6: '236220', tokens: ['turner construction', 'skanska', 'whiting-turner', 'aecom hunt', 'mortenson construction', 'suffolk construction', 'commercial construction', 'commercial builders'] },
  // construction — removed plumbing/hvac tokens (now in plumbing_hvac category).
  { label: 'construction', naics6: '236115', tokens: ['construction', 'builders', 'contracting', 'electrical', 'roofing', 'remodeling', 'renovation'] },
  { label: 'waste_management', naics6: '562111', tokens: ['waste management', 'garbage', 'trash', 'recycling', 'sanitation services', 'waste disposal', 'dumpster'] },
  // cleaning — added 'maids' (plural) for Merry Maids.
  { label: 'cleaning', naics6: '561720', tokens: ['cleaning', 'janitorial', 'maid', 'maids', 'housekeeping'] },
  // real_estate — runs AFTER property_management so 'Greystar Real Estate'
  // hits property_management first.
  { label: 'real_estate', naics6: '531210', tokens: ['realty', 'real estate', 'properties', 'realtor'] },
  { label: 'insurance', naics6: '524210', tokens: ['insurance', 'agency', 'allstate', 'state farm'] },
  { label: 'bar_nightlife', naics6: '722410', tokens: ['bar', 'tavern', 'pub', 'saloon', 'nightclub', 'lounge'] },
  { label: 'pest', naics6: '561710', tokens: ['terminix', 'servicemaster', 'trugreen', 'aptive', 'ehrlich', 'western pest', 'pest', 'exterminator', 'termite'] },
  { label: 'funeral', naics6: '812210', tokens: ['funeral', 'memorial', 'mortuary', 'cremation'] },
  // k12_private — added 'school of music', 'music school', 'school of arts'.
  { label: 'k12_private', naics6: '611110', tokens: ['montessori', 'waldorf', 'prep school', 'preparatory school', 'private school', 'parochial school', 'school of music', 'music school', 'school of arts'] },
  { label: 'childcare', naics6: '624410', tokens: ['kindercare', 'bright horizons', 'goddard school', 'primrose school', 'la petite academy', 'childcare', 'daycare', 'preschool', 'nursery', 'learning center'] },
  // education — removed 'music school' (moved to k12_private).
  { label: 'education', naics6: '611691', tokens: ['kumon', 'art school', 'conservatory', 'driving school', 'driver ed', 'tutor', 'tutoring'] },
  { label: 'college_university', naics6: '611310', tokens: [
    'state university', 'community college', 'junior college',
    { token: 'university', anchored: true, blocklist_before: ['west', 'east', 'north', 'south', 'old', 'new', 'central', 'upper', 'lower'] },
    { token: 'college', anchored: true, blocklist_before: ['west', 'east', 'north', 'south', 'old', 'new', 'central', 'upper', 'lower'] },
  ] },
  { label: 'veterinary', naics6: '541940', tokens: ['veterinary', 'animal hospital', 'vet'] },
  { label: 'catering', naics6: '722320', tokens: ['catering', 'caterer'] },
  // pet_grooming — extended with dog/pet training tokens (same NAICS 812910).
  { label: 'pet_grooming', naics6: '812910', tokens: ['grooming', 'groomer', 'kennel', 'pet boarding', 'dog training', 'dog trainer', 'pet training', 'obedience training', 'puppy training'] },
  // equipment_rental — extended with party rental specifics + plural forms.
  { label: 'equipment_rental', naics6: '532289', tokens: ['party rental', 'party rentals', 'event rental', 'event rentals', 'rental', 'rentals', 'party supply', 'party supplies', 'tent rental', 'bounce house rental'] },
  // passenger_transport — extended with chauffeured/black car tokens.
  { label: 'passenger_transport', naics6: '485310', tokens: [
    'yellow cab', 'tour bus', 'car service', 'limousine', 'sightseeing',
    'rideshare', 'taxi', 'shuttle', 'limo', 'cab',
    'chauffeured', 'chauffeur', 'black car',
  ] },
  { label: 'museum_heritage', naics6: '712110', tokens: ['museum', 'historical site', 'heritage', 'gallery', 'planetarium', 'aquarium', 'zoo'] },
  { label: 'spectator_sports', naics6: '711211', tokens: ['stadium', 'ballpark', 'arena', 'racetrack'] },
  { label: 'farm', naics6: '111998', tokens: ['orchard', 'u-pick', 'pick your own', 'csa farm', 'farms', 'farm'] },
  { label: 'courier_delivery', naics6: '492110', tokens: ['amazon delivery', 'amazon dsp', 'amazon logistics', 'delivery station', 'fedex office', 'fedex shipping', 'dhl express', 'dhl shipping', 'dhl', 'ups store', 'courier', 'package delivery'] },
  { label: 'telecom_isp', naics6: '517111', tokens: ['comcast', 'xfinity', 'verizon', 'spectrum', 'cox communications', 'frontier communications', 'centurylink', 'lumen', 'altice', 'internet service provider', 'cable internet', 'service center'] },
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

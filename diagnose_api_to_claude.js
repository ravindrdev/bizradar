require('dotenv').config({ override: true })

async function main() {

  console.log('═══════════════════════════════')
  console.log('COMPLETE API → CLAUDE DATA FLOW')
  console.log('For every API we use')
  console.log('═══════════════════════════════')
  console.log('')

  const apis = [
    {
      name: '1. Google Places Text Search',
      what_api_returns: [
        'name',
        'formatted_address',
        'rating',
        'user_ratings_total',
        'types (array)',
        'business_status',
        'place_id',
        'geometry.location.lat/lng',
        'price_level',
        'photos (array)'
      ],
      what_GROWTHIM_keeps: [
        'name → business.name',
        'formatted_address → business.address',
        'rating → google.rating',
        'user_ratings_total → google.review_count',
        'types → used for NAICS classification',
        'geometry.location → lat/lon for other APIs',
        'photos.length → google.photo_count (null if 10+)'
      ],
      what_claude_receives: [
        'Business: {name}',
        'Address: {address}',
        'Rating: {rating} stars ({review_count} reviews)',
        'Photo count: {photo_count or NOT SENT if null}'
      ],
      example: 'Rating: 4.2 stars (354 reviews)'
    },
    {
      name: '2. Google Place Details',
      what_api_returns: [
        'reviews (max 5, sorted newest)',
        'website',
        'opening_hours',
        'formatted_phone_number',
        'photos (max 10)'
      ],
      what_GROWTHIM_keeps: [
        'reviews → google.sample_reviews',
        'website → google.website_exists',
        'opening_hours → google.hours_complete',
        'photos.length → google.photo_count'
      ],
      what_claude_receives: [
        'Website loads: true/false',
        'Hours complete: true/false',
        'Recent reviews (sample): ★5: review text...',
        'Photo count: NOT SENT (if 10+)'
      ],
      example: '★5: Great stay, clean rooms...'
    },
    {
      name: '3. Google Nearby Search (competitors)',
      what_api_returns: [
        'Array of nearby businesses',
        'name, rating, reviews per business',
        'place_id per business',
        'distance from subject'
      ],
      what_GROWTHIM_keeps: [
        'top 5 competitors by threat score',
        'name → competitors.top5[].name',
        'rating → competitors.top5[].rating',
        'reviews → competitors.top5[].review_count',
        'distance → competitors.top5[].distance_miles',
        'their reviews → competitors.top5[].top_reviews'
      ],
      what_claude_receives: [
        'Top competitors (by rating):',
        '• Don Q Inn | 4.2★ | 380 reviews | 0.1mi',
        '• Mineral Point Inn | 4.4★ | 188 reviews | 7.8mi',
        'Count: 11 competitors within 8 miles',
        'Median rating: 4.2',
        'Median reviews: 135'
      ],
      example: 'Don Q Inn | 4.2★ | 380 reviews | 0.1mi'
    },
    {
      name: '4. Google PageSpeed Insights',
      what_api_returns: [
        'performance score (0-100)',
        'LCP - Largest Contentful Paint',
        'TBT - Total Blocking Time',
        'load time in seconds'
      ],
      what_GROWTHIM_keeps: [
        'score → pagespeed.mobile_score',
        'LCP → pagespeed.lcp_seconds',
        'load time → pagespeed.load_time_seconds'
      ],
      what_claude_receives: [
        'Mobile performance score: 25/100',
        'Load time: 15.2 seconds',
        'LCP: 15.2s'
      ],
      example: 'Mobile performance score: 25/100'
    },
    {
      name: '5. US Census ACS',
      what_api_returns: [
        'B19013_001E = median household income',
        'B01003_001E = total population',
        'B25010_001E = avg household size',
        'B25001_001E = housing units',
        'B25002_003E = vacant units',
        'B25003_002E = owner occupied',
        'B25077_001E = median home value',
        'B25064_001E = median gross rent'
      ],
      what_GROWTHIM_keeps: [
        'median income → census.median_household_income',
        'population → census.total_population',
        'avg household → census.average_household_size',
        'housing units → census_housing.housing_units',
        'vacancy → census_housing.vacancy_rate',
        'homeownership → census_housing.homeownership_rate',
        'home value → census_housing.median_home_value',
        'rent → census_housing.median_gross_rent'
      ],
      what_claude_receives: [
        'Median household income: $72,288',
        'Population: 5,042',
        'Average household size: 2.27',
        'Housing units: 4,521',
        'Vacancy rate: 8.2%',
        'Homeownership rate: 68.4%',
        'Median home value: $187,000',
        'Median gross rent: $842'
      ],
      example: 'Median household income: $72,288'
    },
    {
      name: '6. Open-Meteo Weather',
      what_api_returns: [
        'Historical daily temperatures',
        'Monthly averages',
        'Precipitation data',
        'Current conditions'
      ],
      what_GROWTHIM_keeps: [
        'peak_month → weather.peak_month',
        'peak_tourist_season → weather.peak_tourist_season',
        'has_cold_winter → weather.has_cold_winter',
        'has_hot_summer → weather.has_hot_summer',
        'monthly temps → weather.monthly_temps'
      ],
      what_claude_receives: [
        'Peak month: July',
        'Peak tourist season: Jun-Aug',
        'Cold winter market: true',
        'Hot summer: false'
      ],
      example: 'Peak month: July | Cold winter: true'
    },
    {
      name: '7. Ticketmaster Events',
      what_api_returns: [
        'Event name',
        'Event date',
        'Venue name',
        'Venue location',
        'Event category'
      ],
      what_GROWTHIM_keeps: [
        'name → upcoming_events[].name',
        'date → upcoming_events[].date',
        'venue → upcoming_events[].venue',
        'count → upcoming_events_count'
      ],
      what_claude_receives: [
        'Upcoming events (next 90 days within 50 miles):',
        '• Phish — 2026-07-07 at Kohl Center Madison',
        '• Phish — 2026-07-08 at Kohl Center Madison',
        'upcoming_events_count: 2'
      ],
      example: 'Phish on 2026-07-07 at Kohl Center'
    },
    {
      name: '8. Foursquare Places',
      what_api_returns: [
        'Venue name',
        'Category',
        'Distance in meters',
        'Address',
        'Hours'
      ],
      what_GROWTHIM_keeps: [
        'name → nearby_venues[].name',
        'category → nearby_venues[].category',
        'distance → nearby_venues[].distance_meters',
        'verified open via Google cross-check'
      ],
      what_claude_receives: [
        'Nearby venues (Foursquare, within 1km):',
        '• Jokers Wild (Bar) 200m',
        '• The Thyms Restaurant 300m',
        'nearby_venue_count: 2'
      ],
      example: 'Jokers Wild (Bar) 200m away'
    },
    {
      name: '9. OpenStreetMap Overpass',
      what_api_returns: [
        'Nearby amenities within 500m',
        'Hospitals, universities, supermarkets',
        'Transit stops within 800m'
      ],
      what_GROWTHIM_keeps: [
        'anchor_tenants → location_signals.anchor_tenants',
        'anchor_count → location_signals.anchor_tenant_count',
        'transit → location_signals.has_transit_nearby',
        'transit distance → nearest_transit_meters'
      ],
      what_claude_receives: [
        'Anchor tenants within 500m: Target, Aldi',
        'Transit: 177m away',
        'OR: No anchor tenants within 500m',
        'OR: No transit within 800m'
      ],
      example: 'Anchor tenants: Target (320m), Aldi (450m)'
    },
    {
      name: '10. HUD Building Permits',
      what_api_returns: [
        'Total residential permits by county',
        'Single family permits',
        'Year over year change percentage'
      ],
      what_GROWTHIM_keeps: [
        'total → building_permits.total',
        'single_family → building_permits.single_family',
        'yoy_change → building_permits.yoy_change',
        'county → building_permits.county_name'
      ],
      what_claude_receives: [
        'County building permits (Iowa County 2022):',
        '68 total residential permits',
        '60 single-family',
        'Declining -50.7% YoY'
      ],
      example: '68 permits, -50.7% YoY decline'
    },
    {
      name: '11. HUD Fair Market Rents',
      what_api_returns: [
        'Studio rent',
        '1 bedroom rent',
        '2 bedroom rent',
        '3 bedroom rent',
        'By metro/county area'
      ],
      what_GROWTHIM_keeps: [
        'studio → hud_fmr.studio',
        'one_br → hud_fmr.one_br',
        'two_br → hud_fmr.two_br'
      ],
      what_claude_receives: [
        'Fair market rents (WI):',
        'Studio: $650/month',
        '1BR: $780/month',
        '2BR: $980/month'
      ],
      example: '2BR fair market rent: $980/month'
    },
    {
      name: '12. BLS Employment',
      what_api_returns: [
        'Employment level by sector',
        'Time series data',
        'County/state level'
      ],
      what_GROWTHIM_keeps: [
        'employment_level → bls_employment.level',
        'period → bls_employment.period',
        'series_id → identifies sector'
      ],
      what_claude_receives: [
        'BLS sector employment:',
        'Accommodation sector: 234 employees',
        'Period: 2024 Q3',
        'Iowa County WI'
      ],
      example: 'Accommodation: 234 employees Q3 2024'
    },
    {
      name: '13. TripAdvisor',
      what_api_returns: [
        'Overall rating',
        'Sub-ratings (service, value, etc)',
        'Review count',
        'Awards',
        'Traveler type breakdown'
      ],
      what_GROWTHIM_keeps: [
        'rating → tripadvisor.ta_rating',
        'sub_ratings → tripadvisor.sub_ratings',
        'review_count → tripadvisor.ta_review_count',
        'awards → tripadvisor.awards'
      ],
      what_claude_receives: [
        'TripAdvisor rating: 4.0',
        'Sub-ratings:',
        '  Service: 4.5',
        '  Value: 4.0',
        '  Cleanliness: 4.5',
        'TripAdvisor reviews: 89'
      ],
      example: 'TripAdvisor: 4.0★ | Service: 4.5'
    },
    {
      name: '14. NPI Registry',
      what_api_returns: [
        'NPI number',
        'Provider type',
        'License status',
        'Specialty codes',
        'Practice address'
      ],
      what_GROWTHIM_keeps: [
        'npi → npi.npi_number',
        'status → npi.status',
        'taxonomy → npi.specialty'
      ],
      what_claude_receives: [
        'NPI: 1234567890',
        'Status: Active',
        'Specialty: General Dentistry'
      ],
      example: 'NPI Active | General Dentistry',
      note: 'ONLY fires for NAICS 62 healthcare'
    },
    {
      name: '15. USDA NASS',
      what_api_returns: [
        'Top commodity by county',
        'Farm count',
        'Acres by crop',
        'Production values'
      ],
      what_GROWTHIM_keeps: [
        'commodity → usda_nass.top_commodity',
        'farms → usda_nass.farm_count',
        'acres → usda_nass.acres'
      ],
      what_claude_receives: [
        'Top commodity: Corn',
        'Farm count: 847',
        'Acres: 234,000'
      ],
      example: 'Top crop: Corn | 847 farms | 234K acres',
      note: 'ONLY fires for NAICS 11 agriculture'
    },
    {
      name: '16. USDA ERS',
      what_api_returns: [
        'Net farm sales by state',
        'Farm income data',
        'Agricultural economics'
      ],
      what_GROWTHIM_keeps: [
        'net_sales → usda_ers.net_farm_sales',
        'year → usda_ers.year',
        'state → usda_ers.state'
      ],
      what_claude_receives: [
        'USDA farm economics (WI 2023):',
        'Net farm sales: $2,340,000'
      ],
      example: 'WI net farm sales: $2.3M (2023)',
      note: 'Fires for NAICS 11, 722, 445'
    },
    {
      name: '17. CDC Places',
      what_api_returns: [
        'Dental visit rate %',
        'Obesity rate %',
        'Physical inactivity rate %',
        'Smoking rate %',
        'Diabetes rate %',
        'Depression rate %'
      ],
      what_GROWTHIM_keeps: [
        'dental_visit_rate → cdc_health.dental_visit_rate',
        'obesity_rate → cdc_health.obesity_rate',
        'physical_inactivity → cdc_health.physical_inactivity',
        'smoking_rate → cdc_health.smoking_rate'
      ],
      what_claude_receives: [
        'CDC health metrics (Iowa County WI):',
        'Dental visit rate: 65%',
        'Obesity rate: 31%',
        'Physical inactivity: 28%',
        'Smoking rate: 14%'
      ],
      example: 'Dental visits: 65% | Obesity: 31%',
      note: 'Fires for NAICS 621, 713, 722'
    },
    {
      name: '18. HRSA Dental HPSA',
      what_api_returns: [
        'is_dental_shortage_area: true/false',
        'hpsa_score: 0-25',
        'hpsa_name: designation name',
        'pct_need_met: percentage'
      ],
      what_GROWTHIM_keeps: [
        'is_shortage → hrsa_dental.is_dental_shortage_area',
        'score → hrsa_dental.hpsa_score',
        'name → hrsa_dental.hpsa_name'
      ],
      what_claude_receives: [
        'HRSA Dental shortage area: YES',
        'HPSA score: 18/25',
        'Designation: Iowa County Dental HPSA',
        '← triggers $50K loan forgiveness recommendation'
      ],
      example: 'Dental shortage area: YES | Score: 18/25',
      note: 'ONLY fires for NAICS 6212 dental'
    },
    {
      name: '19. FoodData Central',
      what_api_returns: [
        'Food description',
        'Calories',
        'Protein grams',
        'Carbohydrates',
        'Food category'
      ],
      what_GROWTHIM_keeps: [
        'description → food_data[].name',
        'calories → food_data[].calories',
        'protein → food_data[].protein',
        'category → food_data[].category'
      ],
      what_claude_receives: [
        'Food ingredient data:',
        'CHICKEN — 165 cal | 31g protein',
        'LAMB ROGAN JOSH — 220 cal',
        'GARLIC NAAN — 320 cal'
      ],
      example: 'CHICKEN: 165 calories, 31g protein',
      note: 'Fires for NAICS 722, 445 only'
    },
    {
      name: '20. Open Food Facts',
      what_api_returns: [
        'Product name',
        'Nutri-score grade (A-E)',
        'Categories',
        'Ingredients text'
      ],
      what_GROWTHIM_keeps: [
        'product_name → open_food_facts[].name',
        'nutriscore_grade → open_food_facts[].nutriscore',
        'categories → open_food_facts[].categories'
      ],
      what_claude_receives: [
        'Popular food products:',
        'Organic Chicken Broth — nutriscore: A',
        'Whole Milk — nutriscore: C',
        'White Bread — nutriscore: D'
      ],
      example: 'Organic Chicken Broth | Nutriscore: A',
      note: 'Fires for NAICS 722, 445 only'
    },
    {
      name: '21. Datamuse',
      what_api_returns: [
        'Related words array',
        'Synonyms',
        'Associated concepts',
        'Score per word'
      ],
      what_GROWTHIM_keeps: [
        'words → related_words (top 10)'
      ],
      what_claude_receives: [
        'Related words for business name:',
        'villa, guesthouse, inn, motel, lodge'
      ],
      example: 'Related: villa, guesthouse, inn',
      note: 'Fires for ALL sectors'
    },
    {
      name: '22. National Park Service',
      what_api_returns: [
        'Park full name',
        'Park designation',
        'Description',
        'Entrance fees',
        'Operating hours',
        'Park URL'
      ],
      what_GROWTHIM_keeps: [
        'fullName → nearby_nps_parks[].name',
        'designation → nearby_nps_parks[].designation',
        'description → nearby_nps_parks[].description',
        'entranceFees → nearby_nps_parks[].entrance_fee'
      ],
      what_claude_receives: [
        'Nearby National Parks (WI):',
        'Apostle Islands National Lakeshore',
        'Ice Age National Scenic Trail',
        'St Croix National Scenic Riverway'
      ],
      example: 'Apostle Islands National Lakeshore',
      note: 'Fires for NAICS 721, 722, 44-45'
    },
    {
      name: '23. NOAA Climate',
      what_api_returns: [
        'Weather station name',
        'Station ID',
        'Historical temperature normals',
        'Monthly averages'
      ],
      what_GROWTHIM_keeps: [
        'station_name → noaa_climate.station_name',
        'normals → noaa_climate.normals'
      ],
      what_claude_receives: [
        'Historical climate (NOAA):',
        'Station: Dodgeville WI',
        'Jan avg: 18°F',
        'Jul avg: 72°F',
        'Annual snowfall: 47 inches'
      ],
      example: 'Jan: 18°F | Jul: 72°F | Snow: 47in/yr',
      note: 'Fires for ALL sectors'
    }
  ]

  apis.forEach(api => {
    console.log('─────────────────────────────')
    console.log(api.name)
    if (api.note) {
      console.log('NOTE:', api.note)
    }
    console.log('')
    console.log('WHAT API RETURNS:')
    api.what_api_returns.forEach(f => {
      console.log('  •', f)
    })
    console.log('')
    console.log('WHAT GROWTHIM KEEPS:')
    api.what_GROWTHIM_keeps.forEach(f => {
      console.log('  →', f)
    })
    console.log('')
    console.log('WHAT CLAUDE RECEIVES:')
    api.what_claude_receives.forEach(f => {
      console.log('  ✓', f)
    })
    console.log('')
    console.log('EXAMPLE:')
    console.log(' ', api.example)
    console.log('')
  })

  console.log('═══════════════════════════════')
  console.log('SUMMARY TABLE')
  console.log('═══════════════════════════════')
  console.log('')
  console.log('API                    | Fires for    | Key data Claude gets')
  console.log('──────────────────────────────────────────────────────────')
  console.log('Google Text Search     | ALL          | Name, address, rating, reviews')
  console.log('Google Place Details   | ALL          | Website, hours, review texts')
  console.log('Google Competitors     | ALL          | Top 5 competitors + ratings')
  console.log('Google PageSpeed       | ALL          | Mobile score, load time')
  console.log('Census ACS             | ALL          | Income, population')
  console.log('Census Housing         | ALL          | Home values, vacancy, rent')
  console.log('Open-Meteo Weather     | ALL          | Season, cold winter flag')
  console.log('Ticketmaster           | ALL          | Events within 50 miles')
  console.log('Foursquare             | ALL          | Nearby venues')
  console.log('Overpass OSM           | ALL          | Anchor tenants, transit')
  console.log('HUD Permits            | ALL          | County construction activity')
  console.log('HUD Fair Market Rents  | Real estate  | Rental rates by bedroom')
  console.log('BLS Employment         | ALL          | Sector employment data')
  console.log('TripAdvisor            | ALL          | Sub-ratings, awards')
  console.log('NPI Registry           | Healthcare   | Provider license status')
  console.log('USDA NASS              | Agriculture  | Top crop, farm count')
  console.log('USDA ERS               | Agri/Food    | Farm economics by state')
  console.log('CDC Places             | Medical/Food | Health rates by county')
  console.log('HRSA Dental            | Dental only  | Shortage area + score')
  console.log('FoodData Central       | Restaurant   | Nutrition data')
  console.log('Open Food Facts        | Restaurant   | Nutri-score grades')
  console.log('Datamuse               | ALL          | Related words')
  console.log('NPS Parks              | Hotel/Food   | Nearby national parks')
  console.log('NOAA Climate           | ALL          | Historical weather norms')
  console.log('')
  console.log('TOTAL: 24 APIs')
  console.log('Universal (all sectors): 13')
  console.log('Sector specific: 11')
  console.log('')
  console.log('═══════════════════════════════')
  console.log('COMPLETE — No files modified')
  console.log('No API calls made')
  console.log('No Claude called')
  console.log('═══════════════════════════════')
}

main().catch(console.error)

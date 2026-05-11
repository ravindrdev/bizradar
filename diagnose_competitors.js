require('dotenv').config({ override: true })

const { fetchNearbyCompetitors } =
  require('./googlePlaces.js')
const { buildDataBundle } =
  require('./claudeEnricher.js')

const API_KEY =
  process.env.GOOGLE_PLACES_API_KEY

async function diagnose() {

  console.log('=== COMPETITOR DIAGNOSTIC ===')
  console.log('Business: AmericInn Dodgeville WI')
  console.log('')

  // Step 1 — what does fetchNearbyCompetitors
  // actually return?
  console.log('STEP 1: fetchNearbyCompetitors()')
  console.log('--------------------------------')

  // Use the real AmericInn place data
  // from a previous classify run
  // or search for it first
  const searchUrl =
    'https://maps.googleapis.com/maps/api/' +
    'place/textsearch/json?query=' +
    encodeURIComponent(
      'AmericInn by Wyndham Dodgeville, ' +
      '3637 State Rd 23, Dodgeville WI'
    ) +
    '&key=' + API_KEY

  const searchRes = await fetch(searchUrl)
  const searchData = await searchRes.json()
  const place = searchData.results?.[0]

  if (!place) {
    console.log('ERROR: Could not find AmericInn')
    return
  }

  console.log('Found business:')
  console.log('  Name:', place.name)
  console.log('  Address:', place.formatted_address)
  console.log('  Rating:', place.rating)
  console.log('  Reviews:', place.user_ratings_total)
  console.log('')

  // Step 2 — get competitors
  const competitors =
    await fetchNearbyCompetitors(
      place, API_KEY
    )

  console.log('STEP 2: Competitors returned:',
    competitors?.length || 0)
  console.log('--------------------------------')

  if (!competitors || competitors.length === 0) {
    console.log('NO COMPETITORS FOUND')
    return
  }

  competitors.forEach((c, i) => {
    console.log('#' + (i+1), c.name)
    console.log('  Address:', c.formatted_address)
    console.log('  Rating:', c.rating)
    console.log('  Reviews:', c.user_ratings_total)
    console.log('  Distance:', c.distance_miles, 'mi')
    console.log('  Has review text:',
      (c.reviews?.length || 0) > 0 ? 'YES' : 'NO')
    console.log('  Review count in bundle:',
      c.reviews?.length || 0)
    if (c.reviews?.length > 0) {
      console.log('  First review preview:',
        c.reviews[0]?.text?.slice(0, 80))
    }
    console.log('')
  })

  // Step 3 — what does buildDataBundle
  // pass to Claude?
  console.log('STEP 3: What Claude receives')
  console.log('--------------------------------')

  try {
    const bundle = await buildDataBundle(
      place, competitors, {}
    )

    const bundleCompetitors =
      bundle?.competitors ||
      bundle?.nearby_competitors ||
      []

    console.log('Competitors in Claude bundle:',
      bundleCompetitors.length)

    bundleCompetitors.forEach((c, i) => {
      console.log('#' + (i+1), c.name)
      console.log('  Rating:', c.rating)
      console.log('  Reviews in bundle:',
        c.reviews?.length || 0)
      console.log('  Threat score:',
        c.threat_score)
      console.log('')
    })

  } catch(e) {
    console.log('buildDataBundle not exported')
    console.log('or requires different args:',
      e.message)
    console.log('')
    console.log('Check claudeEnricher.js exports')
  }

  console.log('=== END DIAGNOSTIC ===')
}

diagnose().catch(console.error)

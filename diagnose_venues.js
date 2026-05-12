require('dotenv').config({ override: true })
const API_KEY =
  process.env.GOOGLE_PLACES_API_KEY
const FSQ_KEY =
  process.env.FOURSQUARE_API_KEY ||
  process.env.FSQ_API_KEY

async function main() {

  // First look up AmericInn to get
  // exact coordinates from Google
  console.log('═══════════════════════════')
  console.log('STEP 1 — FIND AMERICINN')
  console.log('═══════════════════════════')

  const searchUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(
      'AmericInn by Wyndham Dodgeville, ' +
      '3637 WI-23, Dodgeville, WI 53533'
    ) +
    '&key=' + API_KEY

  const searchRes = await fetch(searchUrl)
  const searchData = await searchRes.json()
  const place = searchData.results?.[0]

  if (!place) {
    console.log('ERROR: AmericInn not found')
    return
  }

  const LAT = place.geometry.location.lat
  const LON = place.geometry.location.lng

  console.log('Found:', place.name)
  console.log('Address:',
    place.formatted_address)
  console.log('Lat:', LAT)
  console.log('Lon:', LON)
  console.log('')

  // Google Nearby Search
  console.log('═══════════════════════════')
  console.log('STEP 2 — GOOGLE NEARBY')
  console.log('500m radius')
  console.log('═══════════════════════════')

  const googleUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/nearbysearch/json' +
    '?location=' + LAT + ',' + LON +
    '&radius=500' +
    '&key=' + API_KEY

  const gRes = await fetch(googleUrl)
  const gData = await gRes.json()
  const gResults = gData.results || []

  console.log('Total returned:',
    gResults.length)
  console.log('')

  gResults.forEach((r, i) => {
    console.log(
      '#' + (i+1), r.name)
    console.log(
      '  address:',
      r.vicinity ||
      r.formatted_address ||
      'none')
    console.log(
      '  business_status:',
      r.business_status || 'NOT PROVIDED')
    console.log(
      '  rating:', r.rating || 'none')
    console.log(
      '  types:',
      r.types?.slice(0,3).join(', '))
    console.log('')
  })

  // Foursquare Nearby Search
  console.log('═══════════════════════════')
  console.log('STEP 3 — FOURSQUARE NEARBY')
  console.log('500m radius')
  console.log('═══════════════════════════')

  if (!FSQ_KEY) {
    console.log('NO FOURSQUARE KEY IN .env')
    console.log('Looked for:')
    console.log('  FOURSQUARE_API_KEY')
    console.log('  FSQ_API_KEY')
  } else {

    const fsqUrl =
      'https://api.foursquare.com' +
      '/v3/places/nearby' +
      '?ll=' + LAT + ',' + LON +
      '&radius=500' +
      '&limit=20'

    const fsqRes = await fetch(fsqUrl, {
      headers: {
        'Authorization': FSQ_KEY,
        'Accept': 'application/json'
      }
    })
    const fsqData = await fsqRes.json()
    const fsqResults =
      fsqData.results || []

    console.log('HTTP status:', fsqRes.status)
    if (!fsqRes.ok) {
      console.log('Body:',
        JSON.stringify(fsqData).slice(0, 300))
    }
    console.log('Total returned:',
      fsqResults.length)
    console.log('')

    fsqResults.forEach((r, i) => {
      console.log('#' + (i+1), r.name)
      console.log(
        '  address:',
        r.location?.address ||
        r.location?.formatted_address ||
        'no address')
      console.log(
        '  closed_bucket:',
        r.closed_bucket || 'NOT PROVIDED')
      console.log(
        '  categories:',
        r.categories
          ?.map(c => c.name)
          .join(', ') || 'none')
      console.log(
        '  distance:', r.distance + 'm')
      console.log('')
    })
  }

  // Specifically check Hills Pub on Google
  console.log('═══════════════════════════')
  console.log('STEP 4 — HILLS PUB CHECK')
  console.log('on Google Places')
  console.log('═══════════════════════════')

  const hillsUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(
      'Hills Pub Banquet Hall Dodgeville WI'
    ) +
    '&key=' + API_KEY

  const hillsRes = await fetch(hillsUrl)
  const hillsData = await hillsRes.json()
  const hills = hillsData.results?.[0]

  if (hills) {
    console.log('Name:', hills.name)
    console.log('Address:',
      hills.formatted_address || 'none')
    console.log('business_status:',
      hills.business_status || 'NOT PROVIDED')
    console.log('rating:', hills.rating || 'none')
    console.log('types:',
      hills.types?.slice(0, 3).join(', '))
    console.log('place_id:', hills.place_id)
  } else {
    console.log('NOT FOUND on Google')
    console.log('status:', hillsData.status)
  }
}

main().catch(console.error)

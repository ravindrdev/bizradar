require('dotenv').config({ override: true })

const GOOGLE =
  process.env.GOOGLE_PLACES_API_KEY
const FSQ =
  process.env.FOURSQUARE_API_KEY

const INPUT =
  'AmericInn by Wyndham Dodgeville, ' +
  '3637 WI-23, Dodgeville, WI 53533, USA'

async function main() {

  console.log('═══════════════════════════════')
  console.log('AMERICINN DODGEVILLE — API TEST')
  console.log('No Claude API calls')
  console.log('═══════════════════════════════')

  // STEP 1 — Find AmericInn on Google
  console.log('\n1. GOOGLE TEXT SEARCH')
  console.log('─────────────────────')
  const searchUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(INPUT) +
    '&key=' + GOOGLE
  const sr = await fetch(searchUrl)
  const sd = await sr.json()
  const place = sd.results?.[0]

  if (!place) {
    console.log('❌ Not found on Google')
    return
  }

  const LAT = place.geometry.location.lat
  const LON = place.geometry.location.lng
  const PID = place.place_id

  console.log('Name:', place.name)
  console.log('Address:', place.formatted_address)
  console.log('Rating:', place.rating)
  console.log('Reviews:', place.user_ratings_total)
  console.log('Status:', place.business_status)
  console.log('Place ID:', PID)
  console.log('Lat/Lon:', LAT, LON)

  // STEP 2 — Get full details from Google
  console.log('\n2. GOOGLE PLACE DETAILS')
  console.log('─────────────────────')
  const detUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/details/json' +
    '?place_id=' + PID +
    '&fields=name,rating,user_ratings_total,' +
    'reviews,website,opening_hours,' +
    'formatted_phone_number,photos,' +
    'business_status' +
    '&key=' + GOOGLE
  const dr = await fetch(detUrl)
  const dd = await dr.json()
  const det = dd.result

  console.log('Website:', det.website || 'NONE')
  console.log('Phone:', det.formatted_phone_number || 'NONE')
  console.log('Photos:', det.photos?.length || 0)
  console.log('Hours complete:',
    det.opening_hours ? 'YES' : 'NO')
  console.log('Reviews returned:',
    det.reviews?.length || 0)
  if (det.reviews?.length > 0) {
    console.log('\nSample reviews:')
    det.reviews.slice(0, 3).forEach(r => {
      console.log(
        '  ★' + r.rating + ':',
        r.text?.slice(0, 100) + '...')
    })
  }

  // STEP 3 — Get competitors from Google
  console.log('\n3. GOOGLE COMPETITORS')
  console.log('─────────────────────')
  const compUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(
      'hotel motel inn near Dodgeville WI'
    ) +
    '&key=' + GOOGLE
  const cr = await fetch(compUrl)
  const cd = await cr.json()
  const comps = cd.results || []

  console.log('Competitors found:',
    comps.length)
  comps.slice(0, 5).forEach((c, i) => {
    console.log(
      '#' + (i+1), c.name)
    console.log(
      '  Rating:', c.rating,
      '| Reviews:', c.user_ratings_total,
      '| Status:', c.business_status)
    console.log(
      '  Address:', c.formatted_address)
  })

  // STEP 4 — Get nearby venues from Google
  console.log('\n4. GOOGLE NEARBY VENUES (500m)')
  console.log('─────────────────────')
  const nearUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/nearbysearch/json' +
    '?location=' + LAT + ',' + LON +
    '&radius=500' +
    '&key=' + GOOGLE
  const nr = await fetch(nearUrl)
  const nd = await nr.json()
  const nearby = nd.results || []

  console.log('Nearby places found:',
    nearby.length)
  nearby.forEach((p, i) => {
    console.log(
      '#' + (i+1), p.name)
    console.log(
      '  Status:', p.business_status ||
      'NOT PROVIDED')
    console.log(
      '  Types:',
      p.types?.slice(0,3).join(', '))
  })

  // STEP 5 — Get nearby venues from Foursquare
  console.log('\n5. FOURSQUARE NEARBY VENUES (500m)')
  console.log('─────────────────────')
  const params = new URLSearchParams({
    ll: LAT + ',' + LON,
    radius: '500',
    limit: '10',
    fields: 'name,categories,distance,' +
      'location,hours'
  })
  const fsqUrl =
    'https://places-api.foursquare.com' +
    '/places/search?' +
    params.toString()
  const fr = await fetch(fsqUrl, {
    headers: {
      'Authorization': 'Bearer ' + FSQ,
      'Accept': 'application/json',
      'X-Places-Api-Version': '2025-06-17'
    }
  })

  if (!fr.ok) {
    const err = await fr.json()
    console.log('❌ Foursquare FAILED:',
      fr.status, err.message)
  } else {
    const fd = await fr.json()
    const venues = fd.results || []
    console.log('Venues found:', venues.length)

    for (const v of venues) {
      console.log('\nVenue:', v.name)
      console.log('  Category:',
        v.categories?.[0]?.name || 'none')
      console.log('  Distance:',
        v.distance + 'm')
      console.log('  Address:',
        v.location?.address || 'no address')

      // Cross check with Google
      // to see if venue is open
      const checkUrl =
        'https://maps.googleapis.com' +
        '/maps/api/place/textsearch/json' +
        '?query=' +
        encodeURIComponent(
          v.name + ' Dodgeville WI'
        ) +
        '&key=' + GOOGLE

      const ck = await fetch(checkUrl)
      const cd2 = await ck.json()
      const gv = cd2.results?.[0]

      if (!gv) {
        console.log(
          '  Google status: NOT FOUND')
      } else {
        console.log(
          '  Google name:', gv.name)
        console.log(
          '  Google status:',
          gv.business_status ||
          'NOT PROVIDED')
        console.log(
          '  Google rating:',
          gv.rating || 'none')
      }

      await new Promise(r =>
        setTimeout(r, 300))
    }
  }

  // STEP 6 — Ticketmaster events
  console.log('\n6. TICKETMASTER EVENTS (50mi)')
  console.log('─────────────────────')
  const TM = process.env.TICKETMASTER_API_KEY
  const tmUrl =
    'https://app.ticketmaster.com' +
    '/discovery/v2/events.json' +
    '?latlong=' + LAT + ',' + LON +
    '&radius=50&unit=miles' +
    '&apikey=' + TM +
    '&size=5'
  const tr = await fetch(tmUrl)
  const td = await tr.json()
  const events =
    td._embedded?.events || []
  console.log('Events found:', events.length)
  events.forEach(e => {
    console.log(
      ' -', e.name,
      '|', e.dates?.start?.localDate,
      '|', e.venue || '')
  })

  // STEP 7 — Census data
  console.log('\n7. CENSUS DATA (ZIP 53533)')
  console.log('─────────────────────')
  const censusUrl =
    'https://api.census.gov/data' +
    '/2021/acs/acs5' +
    '?get=B19013_001E,B01003_001E' +
    '&for=zip+code+tabulation+area:53533'
  const cenr = await fetch(censusUrl)
  const cend = await cenr.json()
  if (Array.isArray(cend) && cend[1]) {
    console.log('Median income: $' +
      Number(cend[1][0]).toLocaleString())
    console.log('Population: ' +
      Number(cend[1][1]).toLocaleString())
  }

  // STEP 8 — Weather
  console.log('\n8. WEATHER (Open-Meteo)')
  console.log('─────────────────────')
  const wxUrl =
    'https://api.open-meteo.com' +
    '/v1/forecast' +
    '?latitude=' + LAT +
    '&longitude=' + LON +
    '&current_weather=true'
  const wxr = await fetch(wxUrl)
  const wxd = await wxr.json()
  const wx = wxd.current_weather
  console.log('Temperature:',
    wx.temperature + '°C')
  console.log('Wind:', wx.windspeed + 'km/h')
  console.log('Weather code:', wx.weathercode)

  console.log('\n═══════════════════════════════')
  console.log('TEST COMPLETE — NO CLAUDE USED')
  console.log('═══════════════════════════════')
}

main().catch(console.error)

require('dotenv').config({ override: true })

const GOOGLE =
  process.env.GOOGLE_PLACES_API_KEY
const FSQ =
  process.env.FOURSQUARE_API_KEY
const TM =
  process.env.TICKETMASTER_API_KEY ||
  process.env.TM_API_KEY
const TA =
  process.env.TRIPADVISOR_API_KEY ||
  process.env.TA_API_KEY
const CENSUS =
  process.env.CENSUS_API_KEY || ''
const PAGESPEED =
  process.env.PAGESPEED_API_KEY ||
  process.env.GOOGLE_PAGESPEED_KEY || ''
const WALKSCORE =
  process.env.WALKSCORE_API_KEY || ''

const LAT = 42.9908929
const LON = -90.1392972
const ZIP = '53533'
const STATE = 'WI'
const CITY = 'Dodgeville'
const WEBSITE = 'https://www.americinn.com'
const PLACE_ID = 'ChIJ...'
// look up AmericInn place_id first

async function test(name, fn) {
  process.stdout.write(
    '\n' + name + '... ')
  try {
    const result = await fn()
    console.log('✅ WORKING')
    console.log('  →', result)
  } catch(e) {
    console.log('❌ FAILED')
    console.log('  Error:', e.message)
  }
}

async function main() {

  console.log('════════════════════════════════')
  console.log('BIZRADAR FULL API HEALTH CHECK')
  console.log('Business: AmericInn Dodgeville WI')
  console.log('════════════════════════════════')

  // 1. Google Places Text Search
  await test(
    '1. Google Places Text Search',
    async () => {
      const url =
        'https://maps.googleapis.com' +
        '/maps/api/place/textsearch/json' +
        '?query=' +
        encodeURIComponent(
          'AmericInn by Wyndham Dodgeville' +
          ' 3637 WI-23 Dodgeville WI'
        ) +
        '&key=' + GOOGLE
      const r = await fetch(url)
      const d = await r.json()
      if (d.status !== 'OK')
        throw new Error(d.status)
      const p = d.results[0]
      return p.name + ' | ' +
        p.formatted_address +
        ' | rating: ' + p.rating +
        ' | status: ' + p.business_status
    })

  // 2. Google Place Details
  await test(
    '2. Google Place Details',
    async () => {
      const s = await fetch(
        'https://maps.googleapis.com' +
        '/maps/api/place/textsearch/json' +
        '?query=AmericInn+Dodgeville+WI' +
        '&key=' + GOOGLE)
      const sd = await s.json()
      const pid = sd.results[0].place_id
      const r = await fetch(
        'https://maps.googleapis.com' +
        '/maps/api/place/details/json' +
        '?place_id=' + pid +
        '&fields=name,rating,' +
        'user_ratings_total,reviews,' +
        'business_status,website,' +
        'opening_hours' +
        '&key=' + GOOGLE)
      const d = await r.json()
      if (d.status !== 'OK')
        throw new Error(d.status)
      const p = d.result
      return p.name +
        ' | rating: ' + p.rating +
        ' | reviews: ' +
        p.user_ratings_total +
        ' | website: ' +
        (p.website ? 'YES' : 'NO') +
        ' | review count: ' +
        (p.reviews?.length || 0)
    })

  // 3. Google Geocoding
  await test(
    '3. Google Geocoding API',
    async () => {
      const url =
        'https://maps.googleapis.com' +
        '/maps/api/geocode/json' +
        '?address=' +
        encodeURIComponent(
          '3637 WI-23 Dodgeville WI 53533'
        ) +
        '&key=' + GOOGLE
      const r = await fetch(url)
      const d = await r.json()
      if (d.status !== 'OK')
        throw new Error(d.status)
      const loc =
        d.results[0].geometry.location
      return 'lat: ' + loc.lat +
        ' | lon: ' + loc.lng
    })

  // 4. Google Nearby Search
  await test(
    '4. Google Nearby Search',
    async () => {
      const url =
        'https://maps.googleapis.com' +
        '/maps/api/place/nearbysearch/json' +
        '?location=' + LAT + ',' + LON +
        '&radius=500' +
        '&key=' + GOOGLE
      const r = await fetch(url)
      const d = await r.json()
      if (d.status !== 'OK' &&
        d.status !== 'ZERO_RESULTS')
        throw new Error(d.status)
      const names = d.results
        .slice(0, 3)
        .map(p => p.name +
          '(' + (p.business_status ||
          'no status') + ')')
        .join(', ')
      return d.results.length +
        ' places: ' + names
    })

  // 5. Foursquare
  await test(
    '5. Foursquare Places API',
    async () => {
      if (!FSQ)
        throw new Error(
          'No FOURSQUARE_API_KEY in .env')
      const params = new URLSearchParams({
        ll: LAT + ',' + LON,
        radius: '500',
        limit: '5',
        fields: 'name,location,' +
          'categories,distance'
      })
      const url =
        'https://places-api.foursquare.com' +
        '/places/search?' +
        params.toString()
      const r = await fetch(url, {
        headers: {
          'Authorization': 'Bearer ' + FSQ,
          'Accept': 'application/json',
          'X-Places-Api-Version': '2025-06-17'
        }
      })
      if (!r.ok) {
        const err = await r.json()
        throw new Error(
          r.status + ': ' +
          (err.message || JSON.stringify(err)))
      }
      const d = await r.json()
      const venues = d.results || []
      const names = venues
        .slice(0, 3)
        .map(v => v.name +
          ' (closed_bucket: ' +
          (v.closed_bucket || 'none') + ')')
        .join(', ')
      return venues.length +
        ' venues: ' + names
    })

  // 6. Ticketmaster Events
  await test(
    '6. Ticketmaster Events API',
    async () => {
      if (!TM)
        throw new Error(
          'No TICKETMASTER_API_KEY in .env')
      const url =
        'https://app.ticketmaster.com' +
        '/discovery/v2/events.json' +
        '?latlong=' + LAT + ',' + LON +
        '&radius=50&unit=miles' +
        '&apikey=' + TM +
        '&size=3'
      const r = await fetch(url)
      const d = await r.json()
      const events =
        d._embedded?.events || []
      if (events.length === 0)
        return '0 events within 50mi ' +
          'of Dodgeville WI'
      return events.length +
        ' events: ' +
        events.map(e =>
          e.name + ' on ' +
          e.dates?.start?.localDate
        ).join(', ')
    })

  // 7. US Census ACS
  await test(
    '7. US Census ACS API',
    async () => {
      const url =
        'https://api.census.gov/data' +
        '/2021/acs/acs5' +
        '?get=B19013_001E,B01003_001E' +
        '&for=zip+code+tabulation+area:' +
        ZIP +
        (CENSUS ? '&key=' + CENSUS : '')
      const r = await fetch(url)
      const d = await r.json()
      if (!Array.isArray(d) || !d[1])
        throw new Error('Bad response')
      return 'median income: $' +
        Number(d[1][0]).toLocaleString() +
        ' | population: ' +
        Number(d[1][1]).toLocaleString()
    })

  // 8. Open-Meteo Weather
  await test(
    '8. Open-Meteo Weather API',
    async () => {
      const url =
        'https://api.open-meteo.com' +
        '/v1/forecast' +
        '?latitude=' + LAT +
        '&longitude=' + LON +
        '&current_weather=true'
      const r = await fetch(url)
      const d = await r.json()
      if (!d.current_weather)
        throw new Error('No weather data')
      const w = d.current_weather
      return 'temp: ' +
        w.temperature + '°C' +
        ' | wind: ' +
        w.windspeed + 'km/h' +
        ' | code: ' + w.weathercode
    })

  // 9. TripAdvisor
  await test(
    '9. TripAdvisor API',
    async () => {
      if (!TA)
        throw new Error(
          'No TRIPADVISOR_API_KEY in .env')
      const url =
        'https://api.content.tripadvisor.com' +
        '/api/v1/location/search' +
        '?searchQuery=' +
        encodeURIComponent(
          'AmericInn Dodgeville WI'
        ) +
        '&language=en' +
        '&key=' + TA
      const r = await fetch(url)
      const d = await r.json()
      const loc = d.data?.[0]
      if (!loc)
        throw new Error('No results')
      return loc.name +
        ' | id: ' + loc.location_id +
        ' | address: ' +
        loc.address_obj?.address_string
    })

  // 10. OpenStreetMap Overpass
  await test(
    '10. OpenStreetMap Overpass API',
    async () => {
      const query =
        '[out:json];' +
        'node(around:1000,' +
        LAT + ',' + LON +
        ')[amenity];' +
        'out 5;'
      const r = await fetch(
        'https://overpass-api.de' +
        '/api/interpreter',
        { method: 'POST', body: query }
      )
      const d = await r.json()
      const nodes = d.elements || []
      return nodes.length +
        ' OSM nodes within 1km: ' +
        nodes.slice(0, 3)
          .map(n =>
            n.tags?.name ||
            n.tags?.amenity ||
            'unnamed'
          ).join(', ')
    })

  // 11. Google PageSpeed Insights
  await test(
    '11. Google PageSpeed Insights',
    async () => {
      const url =
        'https://www.googleapis.com' +
        '/pagespeedonline/v5/runPagespeed' +
        '?url=' +
        encodeURIComponent(WEBSITE) +
        '&strategy=mobile' +
        (PAGESPEED
          ? '&key=' + PAGESPEED
          : '')
      const r = await fetch(url)
      const d = await r.json()
      const score = d.lighthouseResult
        ?.categories?.performance
        ?.score
      if (!score && score !== 0)
        throw new Error('No score returned')
      return 'performance score: ' +
        Math.round(score * 100) + '/100'
    })

  // 12. Walk Score API
  await test(
    '12. Walk Score API',
    async () => {
      if (!WALKSCORE)
        throw new Error(
          'No WALKSCORE_API_KEY in .env')
      const url =
        'https://api.walkscore.com' +
        '/score?format=json' +
        '&address=' +
        encodeURIComponent(
          '3637 WI-23 Dodgeville WI 53533'
        ) +
        '&lat=' + LAT +
        '&lon=' + LON +
        '&wsapikey=' + WALKSCORE
      const r = await fetch(url)
      const d = await r.json()
      if (d.status !== 1)
        throw new Error(
          'Status: ' + d.status)
      return 'walk score: ' +
        d.walkscore +
        ' | description: ' +
        d.description
    })

  // 13. HUD Fair Market Rents
  await test(
    '13. HUD Fair Market Rents API',
    async () => {
      const url =
        'https://www.huduser.gov' +
        '/hudapi/public/fmr/statedata/' +
        STATE
      const r = await fetch(url, {
        headers: {
          'Authorization': 'Bearer ' +
            (process.env.HUD_API_KEY || '')
        }
      })
      const d = await r.json()
      if (!d.data)
        throw new Error(
          'No data returned')
      return 'HUD data received for ' +
        STATE + ' | ' +
        Object.keys(d.data).length +
        ' entries'
    })

  // 14. Census Building Permits
  await test(
    '14. Census Building Permits',
    async () => {
      const url =
        'https://api.census.gov/data' +
        '/timeseries/eits/bps' +
        '?get=cell_value,time_slot_id' +
        '&for=county:*' +
        '&in=state:55' +
        '&time=2022'
      const r = await fetch(url)
      const d = await r.json()
      if (!Array.isArray(d))
        throw new Error('Bad response')
      return 'Building permit data ' +
        'received | rows: ' +
        d.length
    })

  // 15. BLS Business Employment
  await test(
    '15. BLS Business Employment API',
    async () => {
      const url =
        'https://api.bls.gov/publicAPI/v2' +
        '/timeseries/data/'
      const body = JSON.stringify({
        seriesid: ['ENU5503340010'],
        startyear: '2022',
        endyear: '2023'
      })
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body
      })
      const d = await r.json()
      if (d.status !== 'REQUEST_SUCCEEDED')
        throw new Error(d.status)
      return 'BLS data received | ' +
        d.Results?.series?.[0]
          ?.data?.length +
        ' data points'
    })

  console.log('')
  console.log('════════════════════════════════')
  console.log('HEALTH CHECK COMPLETE')
  console.log('════════════════════════════════')
}

main().catch(console.error)

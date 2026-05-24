require('dotenv').config({ override: true })

const LAT = 42.9908929
const LON = -90.1392972
const CITY = 'Dodgeville'
const STATE = 'WI'
const ZIP = '53533'
const ADDRESS = '3637 WI-23'

async function test(name, fn) {
  process.stdout.write(name + '... ')
  try {
    const result = await fn()
    console.log('✅ WORKING')
    console.log('  →', JSON.stringify(
      result).slice(0, 200))
  } catch(e) {
    console.log('❌ FAILED')
    console.log('  Error:', e.message)
  }
  console.log('')
}

async function main() {
  console.log('═══════════════════════')
  console.log('FULL API HEALTH CHECK')
  console.log('AmericInn Dodgeville WI')
  console.log('═══════════════════════')
  console.log('')

  // 1. Foursquare
  await test('1. Foursquare', async () => {
    const key =
      process.env.FOURSQUARE_API_KEY
    if (!key) throw new Error(
      'No FOURSQUARE_API_KEY')
    console.log('  Key length:', key.length)
    const params = new URLSearchParams({
      ll: LAT + ',' + LON,
      radius: '1000',
      limit: '5',
      fields: 'name,categories,distance,location,hours'
    })
    const url =
      'https://places-api.foursquare.com' +
      '/places/search?' +
      params.toString()
    const r = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + key,
        'Accept': 'application/json',
        'X-Places-Api-Version': '2025-06-17'
      }
    })
    console.log('  HTTP status:', r.status)
    if (!r.ok) {
      const err = await r.text()
      throw new Error(
        r.status + ': ' + err.slice(0, 200))
    }
    const d = await r.json()
    return {
      venues: d.results?.length || 0,
      first: d.results?.[0]?.name
    }
  })

  // 2. Ticketmaster
  await test('2. Ticketmaster', async () => {
    const key =
      process.env.TICKETMASTER_API_KEY
    const url =
      'https://app.ticketmaster.com' +
      '/discovery/v2/events.json' +
      '?latlong=' + LAT + ',' + LON +
      '&radius=50&unit=miles' +
      '&apikey=' + key + '&size=3'
    const r = await fetch(url)
    const d = await r.json()
    const events =
      d._embedded?.events || []
    return {
      count: events.length,
      first: events[0]?.name || 'none'
    }
  })

  // 3. Eventbrite
  await test('3. Eventbrite', async () => {
    const key =
      process.env.EVENTBRITE_API_KEY
    if (!key) throw new Error(
      'No EVENTBRITE_API_KEY')
    const startDate =
      new Date().toISOString()
    const endDate = new Date(
      Date.now() +
      90 * 24 * 60 * 60 * 1000
    ).toISOString()
    const url =
      'https://www.eventbriteapi.com' +
      '/v3/events/search/' +
      '?location.latitude=' + LAT +
      '&location.longitude=' + LON +
      '&location.within=25mi' +
      '&start_date.range_start=' +
      startDate +
      '&start_date.range_end=' +
      endDate
    const r = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + key
      }
    })
    console.log('  HTTP status:', r.status)
    if (!r.ok) {
      const err = await r.text()
      throw new Error(
        r.status + ': ' + err.slice(0, 200))
    }
    const d = await r.json()
    return {
      count: d.events?.length || 0,
      first: d.events?.[0]?.name
        ?.text || 'none'
    }
  })

  // 4. CDC Places
  await test('4. CDC Places', async () => {
    const url =
      'https://chronicdata.cdc.gov' +
      '/resource/cwsq-ngmh.json' +
      '?cityname=' +
      encodeURIComponent(CITY) +
      '&stateabbr=' + STATE +
      '&$limit=5'
    const r = await fetch(url)
    const d = await r.json()
    if (!d.length) throw new Error(
      'No data — city may be too small')
    return {
      count: d.length,
      measure: d[0].measureid,
      city: d[0].cityname
    }
  })

  // 5. HRSA Dental
  await test('5. HRSA Dental', async () => {
    const url =
      'https://datawarehouse.hrsa.gov' +
      '/tools/analyzeTool/ShortageArea' +
      '/api/hpsaByAddress' +
      '?streetAddress=' +
      encodeURIComponent(ADDRESS) +
      '&city=' +
      encodeURIComponent(CITY) +
      '&state=' + STATE +
      '&zip=' + ZIP +
      '&hpsaType=dental'
    const r = await fetch(url)
    console.log('  HTTP status:', r.status)
    const d = await r.json()
    return {
      isHPSA: d.isHPSA,
      score: d.hpsaScore,
      name: d.hpsaName
    }
  })

  // 6. USDA ERS
  await test('6. USDA ERS', async () => {
    const url =
      'https://api.ers.usda.gov' +
      '/data/arms/farmeconomics' +
      '?year=2023&state=' + STATE +
      '&variable=NETSALES'
    const r = await fetch(url)
    console.log('  HTTP status:', r.status)
    const d = await r.json()
    if (!d?.data?.length)
      throw new Error('No data returned')
    return {
      value: d.data[0]?.Value,
      year: 2023,
      state: STATE
    }
  })

  // 7. Census Housing
  await test('7. Census Housing',
    async () => {
    const url =
      'https://api.census.gov/data' +
      '/2024/acs/acs5' +
      '?get=B25001_001E,B25002_003E,' +
      'B25003_002E,B25077_001E,' +
      'B25064_001E' +
      '&for=zip+code+tabulation+area:'
      + ZIP
    const r = await fetch(url)
    const d = await r.json()
    if (!Array.isArray(d) || !d[1])
      throw new Error('No data')
    return {
      housing_units: d[1][0],
      vacant: d[1][1],
      owner_occupied: d[1][2],
      median_home_value: '$' + d[1][3],
      median_rent: '$' + d[1][4]
    }
  })

  // 8. Open Food Facts
  await test('8. Open Food Facts',
    async () => {
    const url =
      'https://world.openfoodfacts.org' +
      '/cgi/search.pl' +
      '?search_terms=chicken' +
      '&search_simple=1' +
      '&action=process' +
      '&json=1&page_size=3'
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'GrowthIM/1.0'
      }
    })
    const d = await r.json()
    if (!d.products?.length)
      throw new Error('No products')
    return {
      count: d.products.length,
      first: d.products[0]
        .product_name?.slice(0, 50)
    }
  })

  // 9. Datamuse
  await test('9. Datamuse', async () => {
    const url =
      'https://api.datamuse.com/words' +
      '?ml=hotel&max=5'
    const r = await fetch(url)
    const d = await r.json()
    if (!d.length)
      throw new Error('No words')
    return {
      words: d.map(w => w.word)
        .join(', ')
    }
  })

  // 10. FoodData Central
  await test('10. FoodData Central',
    async () => {
    const key =
      process.env.FOODDATA_API_KEY
    if (!key) throw new Error(
      'No FOODDATA_API_KEY in .env')
    const url =
      'https://api.nal.usda.gov' +
      '/fdc/v1/foods/search' +
      '?query=chicken&pageSize=3' +
      '&api_key=' + key
    const r = await fetch(url)
    console.log('  HTTP status:', r.status)
    const d = await r.json()
    if (!d.foods?.length)
      throw new Error('No foods')
    return {
      count: d.foods.length,
      first: d.foods[0]
        .description?.slice(0, 50)
    }
  })

  // 11. National Park Service
  await test('11. National Park Service',
    async () => {
    const key =
      process.env.NPS_API_KEY
    if (!key) throw new Error(
      'No NPS_API_KEY in .env')
    const url =
      'https://developer.nps.gov' +
      '/api/v1/parks' +
      '?stateCode=' + STATE +
      '&limit=3' +
      '&api_key=' + key
    const r = await fetch(url)
    console.log('  HTTP status:', r.status)
    const d = await r.json()
    if (!d.data?.length)
      throw new Error('No parks')
    return {
      count: d.data.length,
      first: d.data[0].fullName
    }
  })

  // 12. NOAA Climate
  await test('12. NOAA Climate',
    async () => {
    const key =
      process.env.NOAA_API_KEY
    if (!key) throw new Error(
      'No NOAA_API_KEY in .env')
    const url =
      'https://www.ncdc.noaa.gov' +
      '/cdo-web/api/v2/stations' +
      '?extent=' +
      (LAT - 0.5) + ',' +
      (LON - 0.5) + ',' +
      (LAT + 0.5) + ',' +
      (LON + 0.5) +
      '&datasetid=GHCND&limit=1'
    const r = await fetch(url, {
      headers: { 'token': key }
    })
    console.log('  HTTP status:', r.status)
    const d = await r.json()
    if (!d.results?.length)
      throw new Error('No stations')
    return {
      station: d.results[0].name,
      id: d.results[0].id
    }
  })

  // 13. Open-Meteo
  await test('13. Open-Meteo',
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
      throw new Error('No weather')
    return {
      temp: d.current_weather
        .temperature + '°C',
      wind: d.current_weather
        .windspeed + 'km/h'
    }
  })

  // 14. HUD Fair Market Rents
  await test('14. HUD FMR', async () => {
    const key = process.env.HUD_API_KEY
    const url =
      'https://www.huduser.gov' +
      '/hudapi/public/fmr/statedata/WI'
    const r = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + key
      }
    })
    const d = await r.json()
    if (!d.data)
      throw new Error('No data')
    return { state: 'WI' }
  })

  // 15. BLS Employment
  await test('15. BLS Employment',
    async () => {
    const url =
      'https://api.bls.gov' +
      '/publicAPI/v2/timeseries/data/'
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        seriesid: ['ENU5503340010'],
        startyear: '2023',
        endyear: '2024'
      })
    })
    const d = await r.json()
    if (d.status !== 'REQUEST_SUCCEEDED')
      throw new Error(d.status)
    return {
      points: d.Results?.series?.[0]
        ?.data?.length
    }
  })

  // 16. TripAdvisor
  await test('16. TripAdvisor',
    async () => {
    const key =
      process.env.TRIPADVISOR_API_KEY
    const url =
      'https://api.content.tripadvisor.com' +
      '/api/v1/location/search' +
      '?searchQuery=AmericInn+Dodgeville' +
      '&language=en&key=' + key
    const r = await fetch(url)
    const d = await r.json()
    if (!d.data?.length)
      throw new Error('No results')
    return {
      name: d.data[0].name,
      id: d.data[0].location_id
    }
  })

  // 17. Census ACS
  await test('17. Census ACS',
    async () => {
    const url =
      'https://api.census.gov/data' +
      '/2024/acs/acs5' +
      '?get=B19013_001E,B01003_001E' +
      '&for=zip+code+tabulation+area:'
      + ZIP
    const r = await fetch(url)
    const d = await r.json()
    if (!Array.isArray(d) || !d[1])
      throw new Error('No data')
    return {
      income: '$' + Number(d[1][0])
        .toLocaleString(),
      population: Number(d[1][1])
        .toLocaleString()
    }
  })

  // 18. USDA NASS
  await test('18. USDA NASS',
    async () => {
    const key =
      process.env.USDA_NASS_API_KEY
    if (!key) throw new Error(
      'No USDA_NASS_API_KEY')
    const url =
      'https://quickstats.nass.usda.gov' +
      '/api/api_GET/' +
      '?key=' + key +
      '&source_desc=CENSUS' +
      '&sector_desc=CROPS' +
      '&state_alpha=' + STATE +
      '&year=2022' +
      '&format=JSON' +
      '&limit=3'
    const r = await fetch(url)
    console.log('  HTTP status:', r.status)
    const d = await r.json()
    return {
      count: d.data?.length || 0,
      first: d.data?.[0]
        ?.commodity_desc || 'none'
    }
  })

  // 19. HUD Building Permits
  await test('19. HUD Building Permits',
    async () => {
    const url =
      'https://services.arcgis.com' +
      '/VTyQ9soqVukalItT/arcgis/rest' +
      '/services/Residential_Construction' +
      '_Permits_by_County/FeatureServer' +
      '/24/query' +
      '?where=FIPS%3D%2755049%27' +
      '&outFields=*&f=json'
    const r = await fetch(url)
    const d = await r.json()
    if (!d.features?.length)
      throw new Error('No permits data')
    return {
      county: 'Iowa County WI',
      features: d.features.length
    }
  })

  console.log('')
  console.log('═══════════════════════')
  console.log('HEALTH CHECK COMPLETE')
  console.log('═══════════════════════')
}

main().catch(console.error)

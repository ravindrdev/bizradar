require('dotenv').config({ override: true })

const FSQ = process.env.FOURSQUARE_API_KEY

// AmericInn Dodgeville coordinates
const LAT = 42.9908929
const LON = -90.1392972

async function main() {
  console.log('═══════════════════════════════')
  console.log('FOURSQUARE-ONLY TEST')
  console.log('AmericInn Dodgeville coords')
  console.log('═══════════════════════════════')
  console.log('')
  console.log('Key present:', !!FSQ,
    '| length:', FSQ?.length)
  console.log('')

  const params = new URLSearchParams({
    ll: LAT + ',' + LON,
    radius: '500',
    limit: '10',
    fields:
      'name,categories,distance,location,hours'
  })

  const url =
    'https://places-api.foursquare.com' +
    '/places/search?' +
    params.toString()

  console.log('URL:', url)
  console.log('')

  const t0 = Date.now()
  const r = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + FSQ,
      'Accept': 'application/json',
      'X-Places-Api-Version': '2025-06-17'
    }
  })
  const dt = Date.now() - t0

  console.log('HTTP status:', r.status,
    '| dt:', dt + 'ms')
  console.log('')

  if (!r.ok) {
    const err = await r.text()
    console.log('❌ FAILED')
    console.log('Body:', err.slice(0, 400))
    return
  }

  const d = await r.json()
  const venues = d.results || []

  console.log('✅ Venues returned:',
    venues.length)
  console.log('')

  venues.forEach((v, i) => {
    console.log('#' + (i+1), v.name)
    console.log(
      '  Category:',
      v.categories?.[0]?.name || 'none')
    console.log(
      '  Distance:', v.distance + 'm')
    console.log(
      '  Address:',
      v.location?.address || 'none')
    console.log(
      '  closed_bucket:',
      'closed_bucket' in v
        ? (v.closed_bucket || 'empty')
        : 'NOT IN RESPONSE')
    console.log(
      '  hours.display:',
      v.hours?.display || 'none')
    console.log(
      '  hours.open_now:',
      v.hours?.open_now !== undefined
        ? v.hours.open_now
        : 'not set')
    console.log('')
  })
}

main().catch(console.error)

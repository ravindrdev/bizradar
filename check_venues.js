require('dotenv').config({ override: true })
const GOOGLE = process.env.GOOGLE_PLACES_API_KEY

async function main() {
  const venues = [
    'Hills Pub N Grub Dodgeville WI',
    'Wood Violet Recovery Dodgeville WI'
  ]

  for (const v of venues) {
    const url =
      'https://maps.googleapis.com' +
      '/maps/api/place/textsearch/json' +
      '?query=' +
      encodeURIComponent(v) +
      '&key=' + GOOGLE

    const r = await fetch(url)
    const d = await r.json()
    const p = d.results?.[0]

    if (!p) {
      console.log(v, '→ NOT FOUND on Google')
    } else {
      console.log(v)
      console.log('  Name:', p.name)
      console.log('  Address:',
        p.formatted_address)
      console.log('  Status:',
        p.business_status || 'NOT PROVIDED')
      console.log('  Rating:', p.rating || 'none')
    }

    await new Promise(r =>
      setTimeout(r, 300))
  }
}

main().catch(console.error)

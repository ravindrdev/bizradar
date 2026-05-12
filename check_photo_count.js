require('dotenv').config({ override: true })
const GOOGLE = process.env.GOOGLE_PLACES_API_KEY

async function checkPhotos(query) {
  const searchUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(query) +
    '&key=' + GOOGLE

  const sr = await fetch(searchUrl)
  const sd = await sr.json()
  const place = sd.results?.[0]

  if (!place) {
    console.log(query, '→ NOT FOUND')
    return
  }

  const detUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/details/json' +
    '?place_id=' + place.place_id +
    '&fields=name,rating,' +
    'user_ratings_total,photos' +
    '&key=' + GOOGLE

  const dr = await fetch(detUrl)
  const dd = await dr.json()
  const photos = dd.result?.photos || []

  console.log('═══════════════════════')
  console.log('Business:', dd.result?.name)
  console.log('Rating:', dd.result?.rating)
  console.log('Reviews:',
    dd.result?.user_ratings_total)
  console.log('Photos returned by API:',
    photos.length)
  console.log('')
  console.log('NOTE: Google Places API')
  console.log('returns MAX 10 photos')
  console.log('regardless of how many')
  console.log('the business actually has')
  console.log('on Google Maps.')
  console.log('')
  console.log('So if API returns 10 photos')
  console.log('the real count could be')
  console.log('10, 50, 100, or 500+')
  console.log('We cannot tell the difference')
  console.log('═══════════════════════')
  console.log('')

  await new Promise(r => setTimeout(r, 500))
}

async function main() {
  await checkPhotos(
    'Rajni Indian Cuisine, ' +
    '429 Commerce Dr, Madison WI'
  )
  await checkPhotos(
    'AmericInn by Wyndham Dodgeville, ' +
    '3637 WI-23, Dodgeville WI'
  )
  await checkPhotos(
    'Franklin Barbecue, ' +
    '900 E 11th St, Austin TX'
  )
}

main().catch(console.error)

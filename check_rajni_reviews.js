require('dotenv').config({ override: true })
const GOOGLE = process.env.GOOGLE_PLACES_API_KEY

async function main() {

  // Search for Rajni
  const searchUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(
      'Rajni Indian Cuisine, ' +
      '429 Commerce Dr, Madison, WI 53719'
    ) +
    '&key=' + GOOGLE

  const sr = await fetch(searchUrl)
  const sd = await sr.json()
  const place = sd.results?.[0]

  if (!place) {
    console.log('NOT FOUND')
    return
  }

  console.log('Name:', place.name)
  console.log('Rating:', place.rating)
  console.log('Total reviews:',
    place.user_ratings_total)

  // Get place details with reviews
  const detUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/details/json' +
    '?place_id=' + place.place_id +
    '&fields=name,rating,' +
    'user_ratings_total,reviews' +
    '&key=' + GOOGLE

  const dr = await fetch(detUrl)
  const dd = await dr.json()
  const reviews = dd.result?.reviews || []

  console.log('\nReviews returned by Google:',
    reviews.length)
  console.log('(Google Places API returns')
  console.log(' max 5 reviews only)')
  console.log('')

  reviews.forEach((r, i) => {
    const date = new Date(r.time * 1000)
    const daysAgo = Math.floor(
      (Date.now() - r.time * 1000) /
      (1000 * 60 * 60 * 24)
    )
    console.log('#' + (i+1))
    console.log('  Rating: ★' + r.rating)
    console.log('  Date:', date.toDateString())
    console.log('  Days ago:', daysAgo)
    console.log('  Text:',
      r.text?.slice(0, 80) + '...')
    console.log('')
  })

  // Most recent review
  if (reviews.length > 0) {
    const mostRecent = reviews[0]
    const daysAgo = Math.floor(
      (Date.now() - mostRecent.time * 1000) /
      (1000 * 60 * 60 * 24)
    )
    console.log('═══════════════════════')
    console.log('MOST RECENT REVIEW:')
    console.log('Days ago:', daysAgo)
    console.log('Date:',
      new Date(mostRecent.time * 1000)
        .toDateString())
    console.log('═══════════════════════')
    console.log('')
    console.log('NOTE: Google Places API')
    console.log('only returns 5 reviews.')
    console.log('These may NOT be the')
    console.log('most recent reviews.')
    console.log('Google sorts by relevance')
    console.log('NOT by date.')
  }
}

main().catch(console.error)

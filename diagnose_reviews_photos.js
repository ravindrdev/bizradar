require('dotenv').config({ override: true })
const GOOGLE = process.env.GOOGLE_PLACES_API_KEY

const BUSINESSES = [
  // Restaurant
  {
    name: 'Rajni Indian Cuisine',
    query: 'Rajni Indian Cuisine, 429 Commerce Dr, Madison, WI 53719'
  },
  // Hotel
  {
    name: 'AmericInn Dodgeville',
    query: 'AmericInn by Wyndham Dodgeville, 3637 WI-23, Dodgeville, WI 53533'
  },
  // Bar
  {
    name: 'Jokers Wild Dodgeville',
    query: 'Jokers Wild Dodgeville WI'
  },
  // Auto Repair
  {
    name: 'Jiffy Lube Madison',
    query: 'Jiffy Lube, South Park St, Madison WI'
  },
  // Dental
  {
    name: 'Aspen Dental Madison',
    query: 'Aspen Dental, East Washington Ave, Madison WI'
  },
  // Coffee Shop
  {
    name: 'Colectivo Coffee Madison',
    query: 'Colectivo Coffee, 2406 Monroe St, Madison WI'
  },
  // Retail
  {
    name: 'REI Madison',
    query: 'REI, Madison WI'
  },
  // Gym
  {
    name: 'Planet Fitness Madison',
    query: 'Planet Fitness, Madison WI'
  },
  // Entertainment
  {
    name: 'Marcus Point Cinema Madison',
    query: 'Marcus Point Cinema, 7825 Big Sky Dr, Madison WI'
  },
  // State Park
  {
    name: 'Governor Dodge State Park',
    query: 'Governor Dodge State Park, Dodgeville WI'
  }
]

async function checkBusiness(b) {

  // Step 1 — Find the business
  const searchUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(b.query) +
    '&key=' + GOOGLE

  const sr = await fetch(searchUrl)
  const sd = await sr.json()
  const place = sd.results?.[0]

  if (!place) {
    console.log('❌ NOT FOUND:', b.name)
    return
  }

  // Step 2 — Get details with reviews
  // and photos
  const detUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/details/json' +
    '?place_id=' + place.place_id +
    '&reviews_sort=newest' +
    '&fields=name,rating,' +
    'user_ratings_total,reviews,photos' +
    '&key=' + GOOGLE

  const dr = await fetch(detUrl)
  const dd = await dr.json()
  const det = dd.result

  const reviews = det?.reviews || []
  const photos = det?.photos || []
  const totalReviews =
    det?.user_ratings_total || 0

  // Calculate what GROWTHIM stores
  const photoCount = photos.length >= 10
    ? null
    : photos.length

  const reviewTimes = reviews.map(
    r => r.time || 0)
  const mostRecentTime = reviewTimes.length
    ? Math.max(...reviewTimes)
    : null

  const recencyDays = mostRecentTime
    ? Math.floor(
        (Date.now() / 1000 - mostRecentTime)
        / 86400
      )
    : null

  // What gets sent to Claude
  const sentToClaudePhotoCount =
    photoCount !== null
      ? photoCount
      : 'NOT SENT (10+ photos — exact unknown)'

  const sentToClaudeRecency =
    'NOT SENT (banned — unreliable)'

  console.log('═══════════════════════════════')
  console.log('Business:', det?.name || b.name)
  console.log('Sector:', b.name)
  console.log('───────────────────────────────')
  console.log('WHAT GOOGLE API RETURNS:')
  console.log('  Total reviews:', totalReviews)
  console.log('  Reviews returned by API:',
    reviews.length)
  console.log('  Photos returned by API:',
    photos.length)
  console.log('')

  if (reviews.length > 0) {
    console.log('  Review dates from API:')
    reviews.forEach((r, i) => {
      const daysAgo = Math.floor(
        (Date.now() / 1000 - r.time) / 86400
      )
      console.log(
        '    #' + (i+1) +
        ' ★' + r.rating +
        ' — ' + daysAgo + ' days ago' +
        ' (' +
        new Date(r.time * 1000)
          .toDateString() +
        ')'
      )
    })
    console.log('  Most recent of these 5:',
      recencyDays + ' days ago')
    console.log('  NOTE: Real most recent review')
    console.log('  could be much more recent')
    console.log('  Google only returns 5 of',
      totalReviews, 'total reviews')
  }

  console.log('')
  console.log('WHAT GROWTHIM STORES:')
  console.log('  photo_count:', photoCount)
  console.log('  review_recency_days: null')
  console.log('  (always null — unreliable)')

  console.log('')
  console.log('WHAT GETS SENT TO CLAUDE:')
  console.log('  photo_count:',
    sentToClaudePhotoCount)
  console.log('  review_recency:',
    sentToClaudeRecency)
  console.log('═══════════════════════════════')
  console.log('')

  await new Promise(r =>
    setTimeout(r, 500))
}

async function main() {
  console.log('REVIEW DATE + PHOTO COUNT')
  console.log('DIAGNOSTIC — ALL SECTORS')
  console.log('No Claude API calls')
  console.log('')

  for (const b of BUSINESSES) {
    await checkBusiness(b)
  }

  console.log('DIAGNOSTIC COMPLETE')
  console.log('No Claude API was called')
}

main().catch(console.error)

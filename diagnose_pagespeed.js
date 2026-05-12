require('dotenv').config({ override: true })

const API_KEY =
  process.env.GOOGLE_PLACES_API_KEY

async function main() {

  console.log('Testing PageSpeed...')
  console.log('API key present:',
    !!API_KEY, 'length:', API_KEY?.length)

  // First get AmericInn website URL
  const searchUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(
      'AmericInn by Wyndham Dodgeville' +
      ' 3637 WI-23 Dodgeville WI'
    ) +
    '&key=' + API_KEY

  const s = await fetch(searchUrl)
  const sd = await s.json()
  const pid = sd.results[0].place_id

  const detUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/details/json' +
    '?place_id=' + pid +
    '&fields=name,website' +
    '&key=' + API_KEY

  const d = await fetch(detUrl)
  const dd = await d.json()
  const website = dd.result.website

  console.log('Website found:', website)

  if (!website) {
    console.log('No website — cannot test PageSpeed')
    return
  }

  // Test PageSpeed with GOOGLE_PLACES_API_KEY
  const psiUrl =
    'https://www.googleapis.com' +
    '/pagespeedonline/v5/runPagespeed' +
    '?url=' +
    encodeURIComponent(website) +
    '&strategy=mobile' +
    '&key=' + API_KEY

  console.log('Calling PageSpeed for:',
    website)

  const r = await fetch(psiUrl)
  const data = await r.json()

  const score = data.lighthouseResult
    ?.categories?.performance?.score

  const lcp = data.lighthouseResult
    ?.audits?.['largest-contentful-paint']
    ?.displayValue

  const fid = data.lighthouseResult
    ?.audits?.['total-blocking-time']
    ?.displayValue

  if (score !== undefined && score !== null) {
    console.log('✅ PageSpeed WORKING')
    console.log('  Performance score:',
      Math.round(score * 100) + '/100')
    console.log('  LCP:', lcp)
    console.log('  TBT:', fid)
  } else {
    console.log('❌ PageSpeed FAILED')
    console.log('  No score in response')
    console.log('  Error:',
      data.error?.message ||
      JSON.stringify(data).slice(0, 200))
  }
}

main().catch(console.error)

require('dotenv').config({ override: true })

const GOOGLE =
  process.env.GOOGLE_PLACES_API_KEY

async function main() {

  console.log('Testing competitors for')
  console.log('Bures Berry Patch')
  console.log('CORRECTED NAICS: 111333')
  console.log('Business type: Berry Farm')
  console.log('')

  const LAT = 43.0089
  const LON = -89.8456
  const CITY = 'Barneveld'
  const STATE = 'WI'

  // Test OLD query (wrong)
  console.log('════════════════════════')
  console.log('OLD QUERY (wrong — restaurant)')
  console.log('════════════════════════')

  const oldQuery =
    'restaurant near ' +
    CITY + ' ' + STATE

  const oldUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(oldQuery) +
    '&key=' + GOOGLE

  const oldRes = await fetch(oldUrl)
  const oldData = await oldRes.json()
  const oldResults = oldData.results || []

  console.log('Query:', oldQuery)
  console.log('Results:', oldResults.length)
  oldResults.slice(0, 5).forEach((r, i) => {
    console.log(
      '#' + (i+1), r.name,
      '| ★' + r.rating,
      '| types:', r.types
        ?.slice(0,2).join(', '))
  })

  console.log('')

  // Test NEW query (correct)
  console.log('════════════════════════')
  console.log('NEW QUERY (correct — berry farm)')
  console.log('════════════════════════')

  const newQuery =
    'berry farm pick-your-own near ' +
    CITY + ' ' + STATE

  const newUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(newQuery) +
    '&key=' + GOOGLE

  const newRes = await fetch(newUrl)
  const newData = await newRes.json()
  const newResults = newData.results || []

  console.log('Query:', newQuery)
  console.log('Results:', newResults.length)
  newResults.slice(0, 5).forEach((r, i) => {
    console.log(
      '#' + (i+1), r.name,
      '| ★' + r.rating,
      '| ' + r.user_ratings_total,
      'reviews',
      '| types:', r.types
        ?.slice(0,2).join(', '))
  })

  console.log('')

  // Also try agritourism query
  console.log('════════════════════════')
  console.log('ALSO TRY — agritourism farm')
  console.log('════════════════════════')

  const farmQuery =
    'farm agritourism near ' +
    CITY + ' ' + STATE

  const farmUrl =
    'https://maps.googleapis.com' +
    '/maps/api/place/textsearch/json' +
    '?query=' +
    encodeURIComponent(farmQuery) +
    '&key=' + GOOGLE

  const farmRes = await fetch(farmUrl)
  const farmData = await farmRes.json()
  const farmResults = farmData.results || []

  console.log('Query:', farmQuery)
  console.log('Results:', farmResults.length)
  farmResults.slice(0, 5).forEach((r, i) => {
    console.log(
      '#' + (i+1), r.name,
      '| ★' + r.rating,
      '| ' + r.user_ratings_total,
      'reviews')
  })

  console.log('')
  console.log('════════════════════════')
  console.log('SUMMARY')
  console.log('════════════════════════')
  console.log('Old query found:',
    oldResults.slice(0,5)
      .map(r => r.name).join(', '))
  console.log('')
  console.log('New query found:',
    newResults.slice(0,5)
      .map(r => r.name).join(', '))
  console.log('')
  console.log('Farm query found:',
    farmResults.slice(0,5)
      .map(r => r.name).join(', '))
}

main().catch(console.error)

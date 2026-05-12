require('dotenv').config({ override: true })

async function main() {

  console.log('Census population check')
  console.log('Dodgeville WI')
  console.log('')

  // City level call
  // Wisconsin state FIPS = 55
  // Dodgeville city FIPS = 19375
  const url =
    'https://api.census.gov/data' +
    '/2024/acs/acs5' +
    '?get=B19013_001E,B01003_001E' +
    '&for=place:19375' +
    '&in=state:55'

  const r = await fetch(url)
  const d = await r.json()

  console.log('Raw response:')
  console.log(JSON.stringify(d, null, 2))

  if (Array.isArray(d) && d[1]) {
    console.log('')
    console.log('Dodgeville WI city:')
    console.log('  Median income: $' +
      Number(d[1][0]).toLocaleString())
    console.log('  Population:',
      Number(d[1][1]).toLocaleString())
  }
}

main().catch(console.error)

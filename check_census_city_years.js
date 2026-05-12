require('dotenv').config({
  override: true })

async function main() {

  console.log('Testing Census CITY level')
  console.log('Dodgeville WI')
  console.log('')

  // Wisconsin state FIPS = 55
  // Dodgeville city FIPS = 20350

  // Test 2021 (original year)
  const url2021 =
    'https://api.census.gov/data' +
    '/2021/acs/acs5' +
    '?get=NAME,B19013_001E,B01003_001E' +
    '&for=place:20350' +
    '&in=state:55'

  const r1 = await fetch(url2021)
  const d1 = await r1.json()

  console.log('2021 CITY result:')
  console.log('  Place:', d1[1][0])
  console.log('  Income: $' +
    Number(d1[1][1]).toLocaleString())
  console.log('  Population:',
    Number(d1[1][2]).toLocaleString())
  console.log('')

  // Test 2024 (latest year)
  const url2024 =
    'https://api.census.gov/data' +
    '/2024/acs/acs5' +
    '?get=NAME,B19013_001E,B01003_001E' +
    '&for=place:20350' +
    '&in=state:55'

  const r2 = await fetch(url2024)
  const d2 = await r2.json()

  console.log('2024 CITY result:')
  console.log('  Place:', d2[1][0])
  console.log('  Income: $' +
    Number(d2[1][1]).toLocaleString())
  console.log('  Population:',
    Number(d2[1][2]).toLocaleString())
  console.log('')

  console.log('Difference 2021 vs 2024:')
  console.log('  Income change: $' +
    (Number(d2[1][1]) -
     Number(d1[1][1])).toLocaleString())
  console.log('  Population change:',
    Number(d2[1][2]) -
    Number(d1[1][2]))
}

main().catch(console.error)

require('dotenv').config({
  override: true })

const df = require('./dataFetchers.js')

async function main() {
  console.log('Testing 2024 Census')
  console.log('Dodgeville WI city level')
  console.log('')

  const result = await
    df.fetchCensusByZip(
      '53533', 'Dodgeville', 'WI'
    )

  console.log('Population:',
    result.total_population)
  console.log('Income: $' +
    Number(result.median_household_income)
      .toLocaleString())
  console.log('Source:',
    result.population_source)
}

main().catch(console.error)

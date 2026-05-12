require('dotenv').config({
  override: true })

const df = require('./dataFetchers.js')

async function main() {
  console.log('Census test New York City NY')
  console.log('')

  const result = await
    df.fetchCensusByZip(
      '10001', 'New York', 'NY'
    )

  console.log('Population:',
    result.total_population)
  console.log('Population source:',
    result.population_source)
  console.log('Income: $' +
    Number(result.median_household_income)
      .toLocaleString())
  console.log('Income source:',
    result.income_source)
}

main().catch(console.error)

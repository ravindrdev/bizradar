require('dotenv').config({ override: true })

const dataFetchers = require('./dataFetchers.js')

async function main() {
  console.log('Testing city population')
  console.log('for Dodgeville WI')
  console.log('')

  // Test the census call directly
  const result = await
    dataFetchers.fetchCensusData(
      'Dodgeville', 'WI', '53533'
    )

  console.log('Result:')
  console.log(JSON.stringify(result, null, 2))
}

main().catch(console.error)

require('dotenv').config({ override: true })

async function main() {

  const LAT = 42.9908929
  const LON = -90.1392972
  // AmericInn Dodgeville coords

  console.log('Searching Overpass for')
  console.log('House on the Rock')
  console.log('within 40km of AmericInn')
  console.log('')

  const query =
    '[out:json][timeout:15];' +
    '(' +
    'node["name"~"House on the Rock",i]' +
    '(around:40000,' + LAT + ',' + LON + ');' +
    'way["name"~"House on the Rock",i]' +
    '(around:40000,' + LAT + ',' + LON + ');' +
    'relation["name"~"House on the Rock",i]' +
    '(around:40000,' + LAT + ',' + LON + ');' +
    ');' +
    'out body;'

  const r = await fetch(
    'https://overpass-api.de/api/interpreter',
    { method: 'POST', body: query }
  )
  const d = await r.json()
  const elements = d.elements || []

  console.log('Results found:', elements.length)
  elements.forEach((e, i) => {
    console.log('#' + (i+1))
    console.log('  Type:', e.type)
    console.log('  Name:', e.tags?.name)
    console.log('  Tags:', JSON.stringify(e.tags))
  })

  if (elements.length === 0) {
    console.log('House on the Rock NOT FOUND')
    console.log('in OpenStreetMap within 40km')
    console.log('')
    console.log('This means it is either:')
    console.log('1. Not in OSM database')
    console.log('2. Tagged differently in OSM')
    console.log('3. Outside 40km radius')
  }
}

main().catch(console.error)

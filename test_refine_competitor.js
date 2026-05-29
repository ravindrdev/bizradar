// Standalone test for refineCompetitorQueryWithClaude.
// Run: node test_refine_competitor.js
require('dotenv').config({ path: __dirname + '/.env', override: true });

const { refineCompetitorQueryWithClaude } = require('./googlePlaces');

async function main() {
  const start = Date.now();

  const result = await refineCompetitorQueryWithClaude(
    "Kate's Bait and Sporting Goods",
    '459110',
    'Sporting Goods',
    ['sporting_goods_store', 'store', 'point_of_interest'],
    [
      'Great live bait selection',
      'Best worms in the county',
      'They have all the fishing gear',
      'Good prices on tackle and lures',
      'Always have live nightcrawlers',
    ],
    'Dodgeville',
    'WI'
  );

  const elapsed = Date.now() - start;
  console.log('');
  console.log('=== RESULT ===');
  console.log('Query:', result);
  console.log('Type:', typeof result);
  console.log('Time:', elapsed + 'ms');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

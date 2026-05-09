// Mirror server.js's exact load order so we test the same code path.
require('dotenv').config({ override: true });
const k = process.env.ANTHROPIC_API_KEY;
const g = process.env.GOOGLE_PLACES_API_KEY;
console.log('GOOGLE_PLACES_API_KEY:', g ? `loaded (${g.length} chars, starts ${g.slice(0, 10)}…)` : 'NOT SET');
console.log('ANTHROPIC_API_KEY:    ', k ? `loaded (${k.length} chars, starts ${k.slice(0, 18)}…)` : 'NOT SET');
console.log('PORT:                 ', process.env.PORT);

// Confirm the enricher's client is constructed (without firing any request).
const enricher = require('./claudeEnricher');
console.log('claudeEnricher loaded — client constructed:', !!enricher.enrichWithClaude);

/* naicsRouter — loads naicsRouter.csv into a NAICS-6 → profile_id map.
   The CSV uses '#' as a comment character so OOS overrides can be
   documented inline (csv-parse skips comment lines before column parsing).
   Phase 2 wiring: server.js calls lookupProfileId() to detect
   OUT_OF_SCOPE_* routes and short-circuit to a waitlist response. */

const fs = require('fs');
const path = require('path');
const { parse: parseCsv } = require('csv-parse/sync');

let MAP = null;

function load() {
  const csvPath = path.join(__dirname, 'naicsRouter.csv');
  const csv = fs.readFileSync(csvPath, 'utf8');
  const records = parseCsv(csv, {
    columns: true,
    skip_empty_lines: true,
    comment: '#',
    trim: true,
    relax_quotes: true,
  });
  MAP = new Map();
  let oosCount = 0;
  for (const r of records) {
    if (!r.naics_6 || !r.sector_profile_id) continue;
    MAP.set(r.naics_6, r.sector_profile_id);
    if (r.sector_profile_id.startsWith('OUT_OF_SCOPE_')) oosCount++;
  }
  console.log(`Loaded naicsRouter: ${MAP.size} NAICS-6 entries (${oosCount} explicit OOS overrides)`);
}

function lookupProfileId(naics6) {
  if (!MAP) load();
  return MAP.get(naics6) || null;
}

function isOutOfScope(naics6) {
  const pid = lookupProfileId(naics6);
  return pid != null && pid.startsWith('OUT_OF_SCOPE_');
}

module.exports = { load, lookupProfileId, isOutOfScope };

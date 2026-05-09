/* profileResolver — loads profileRegistry.json (JSONC) at startup and
   builds a NAICS-6 → profile lookup map from each profile's
   naics6_codes array. Replaces the Phase-1 hotelsProfile.resolveProfile()
   short-circuit. */

const fs = require('fs');
const path = require('path');
const { parse: parseJsonc } = require('jsonc-parser');

let REGISTRY = null;
let MAP = null;

function load() {
  const raw = fs.readFileSync(path.join(__dirname, 'profileRegistry.json'), 'utf8');
  const errors = [];
  REGISTRY = parseJsonc(raw, errors, { allowTrailingComma: false });
  if (errors.length) {
    throw new Error(`profileRegistry.json parse errors: ${errors.length}`);
  }
  MAP = new Map();
  let filledCount = 0;
  for (const [pid, profile] of Object.entries(REGISTRY)) {
    if (!profile || !Array.isArray(profile.naics6_codes)) continue;
    filledCount++;
    for (const code of profile.naics6_codes) {
      if (MAP.has(code)) {
        console.warn(
          `profileResolver: NAICS ${code} routes to multiple profiles ` +
          `(${MAP.get(code).id} vs ${pid}); first wins`
        );
        continue;
      }
      MAP.set(code, profile);
    }
  }
  console.log(
    `Loaded profileRegistry: ${Object.keys(REGISTRY).length} keys, ` +
    `${filledCount} filled, ${MAP.size} NAICS-6 → profile entries`
  );
}

function resolveProfile(naics6) {
  if (!MAP) load();
  if (!naics6) return null;
  return MAP.get(naics6) || null;
}

module.exports = { load, resolveProfile };

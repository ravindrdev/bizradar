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
  // Audit fix PR1 — fail fast and loud on corrupt / missing
  // profileRegistry.json. Previously a bad/missing file surfaced as
  // an opaque ENOENT or parser error on first request; now it stops
  // the process at boot with the exact file that failed.
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, 'profileRegistry.json'), 'utf8');
  } catch (err) {
    console.error('[startup] FATAL: could not read profileRegistry.json:', err.message);
    process.exit(1);
  }
  const errors = [];
  REGISTRY = parseJsonc(raw, errors, { allowTrailingComma: false });
  if (errors.length) {
    console.error('[startup] FATAL: profileRegistry.json has', errors.length, 'JSONC parse error(s).');
    console.error('  first error:', JSON.stringify(errors[0]));
    process.exit(1);
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

// Returns the full parsed REGISTRY object (profile_id → profile data).
// Used by claudeEnricher.selectBestProfile so it can list all profiles
// to Claude Haiku for the AI re-selection step. Lazy-loads on first
// call (same as resolveProfile).
function getAllProfiles() {
  if (!REGISTRY) load();
  return REGISTRY;
}

module.exports = { load, resolveProfile, getAllProfiles };

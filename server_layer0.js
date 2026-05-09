/* ────────────────────────────────────────────────────────────────────
   BizRadar v4 — Batch 12 reference Layer 0 implementation
   Replaces the v3 6-mode regex chain with the 10-mode pipeline that
   consumes classifierRegistry.json and verifiedStudies.json.

   Drop this into server.js as the new classifyInput() and add the
   classifierRegistry loader at startup.
   ──────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const { parse: parseCsv } = require('csv-parse/sync');

// ════════════════════════════════════════════════════════════════════
// REGISTRY LOADER — runs once at server startup
// ════════════════════════════════════════════════════════════════════
let REGISTRY = null;
let STUDIES = null;

function loadRegistries() {
  const regPath = path.join(__dirname, 'classifierRegistry.json');
  const stuPath = path.join(__dirname, 'verifiedStudies.json');
  REGISTRY = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  STUDIES = JSON.parse(fs.readFileSync(stuPath, 'utf8'));
  if (REGISTRY.version.split('.')[0] !== '12') {
    throw new Error(`Registry version too old: ${REGISTRY.version}; need 12.x`);
  }
  console.log(`Loaded registry v${REGISTRY.version}: ${REGISTRY.chains.length} chains, ` +
              `${Object.keys(REGISTRY.disambiguation).length} disambig rules, ` +
              `${REGISTRY.sectorTemplates.length} templates`);
  console.log(`Loaded studies v${STUDIES.version}: ${STUDIES.studies.length} verified`);
}

// ════════════════════════════════════════════════════════════════════
// LAYER 0 — 10-mode classifier
// ════════════════════════════════════════════════════════════════════
function classifyInput(raw) {
  if (!REGISTRY) loadRegistries();

  const t = (raw || '').trim();

  // 1. INVALID
  if (t.length < 3) {
    return { mode: 'invalid', confidence: 'HIGH',
             message: 'Input too short.' };
  }

  // 2. URL
  for (const host of REGISTRY.layer0Modes
                              .find(m => m.mode === 'url')
                              .directory_hostnames) {
    if (t.includes(host)) {
      return { mode: 'url', confidence: 'HIGH', host, raw: t };
    }
  }

  // 3. PLACE_ID — Google place_id pattern (ChIJ...)
  if (/^ChIJ[A-Za-z0-9_-]{20,}$/.test(t)) {
    return { mode: 'place_id', confidence: 'HIGH', placeId: t };
  }

  // 4. NAICS_DIRECT — exact 6-digit NAICS code
  if (/^\d{6}$/.test(t)) {
    // Look up in studies/sectors
    return { mode: 'naics_direct', confidence: 'HIGH', naics6: t };
  }

  // 5. BRAND_CHAIN — fuzzy match against registry.chains
  const chainMatch = matchChain(t);
  if (chainMatch) {
    // Chain detected — flag for chain-specific template
    return {
      mode: 'brand_chain',
      confidence: 'HIGH',
      chain: chainMatch.name,
      naics6: chainMatch.naics6,
      treatment: chainMatch.treatment,  // "chain_brand" or "chain_independent"
      template: 'chain_template',
    };
  }

  // 6. NICHE_TYPED — keyword match with disambiguation
  const keywordMatches = matchKeywords(t);
  if (keywordMatches.length > 0) {
    if (keywordMatches.length === 1) {
      // Single match, deterministic
      return {
        mode: 'niche_typed',
        confidence: 'MEDIUM',
        naics6: keywordMatches[0].naics6,
        keyword: keywordMatches[0].phrase,
      };
    }

    // Multiple matches — check disambiguation rules
    const disambig = checkDisambiguation(t, keywordMatches);
    if (disambig.resolved) {
      return {
        mode: 'niche_typed',
        confidence: 'MEDIUM',
        naics6: disambig.naics6,
        rule: disambig.rule,
      };
    }

    // 7. AMBIGUOUS — needs user clarification
    return {
      mode: 'ambiguous',
      confidence: 'LOW',
      candidates: disambig.candidates,
      promptUser: disambig.tiebreak || 'Could you clarify what kind of business?',
    };
  }

  // 8. LOCATION — has address pattern
  // Handles the full Google-Maps-style format:
  //   "Business Name, Street Address, City, ST ZIP"
  // Pattern test: contains "<digits><space><letter>" (street number + street),
  //   contains a comma, and contains ", <STATE-CODE>".
  // When matched, we extract `business_name` = everything before the first
  // comma whose right-hand side starts with a street number (`,\s*\d+\s+`).
  // This correctly preserves embedded commas in the business name itself
  // (e.g., "Smith, MD, 123 Main St, ...").
  // The full string is then passed verbatim to Google Places Text Search,
  // which uses the address to disambiguate to the exact business.
  if (/\d+\s+[A-Za-z]/.test(t) && t.includes(',') && /,\s*[A-Z]{2}/.test(t)) {
    const nameMatch = t.match(/^(.+?),\s*\d+\s+/);
    const businessName = nameMatch ? nameMatch[1].trim() : null;
    return {
      mode: 'location',
      confidence: 'HIGH',
      address: t,
      business_name: businessName,
      pass_full_string_to_places: true,
    };
  }

  // 9. CITY — only state code, no street/business
  if (/,\s*[A-Z]{2}(\s|$)/.test(t)) {
    return { mode: 'city', confidence: 'MEDIUM', cityState: t };
  }

  // 10. FREE_FORM_GEOCODE — last resort
  return {
    mode: 'free_form_geocode',
    confidence: 'LOW',
    raw: t,
    warning: 'Could not classify input precisely. Will attempt geocoding.',
  };
}

// ════════════════════════════════════════════════════════════════════
// CHAIN MATCHING — fuzzy
// ════════════════════════════════════════════════════════════════════
function matchChain(input) {
  const lower = input.toLowerCase();
  for (const chain of REGISTRY.chains) {
    const chainLower = chain.name.toLowerCase();
    // Substring match (e.g., input "subway sandwiches" matches "Subway")
    if (lower.includes(chainLower) || chainLower.includes(lower)) {
      // Avoid false positives — the chain name should be the dominant token
      if (chainLower.length / lower.length > 0.4 ||
          lower.length / chainLower.length > 0.4) {
        return chain;
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
// KEYWORD MATCHING — checks against keywordRouter.csv (loaded lazily)
// ════════════════════════════════════════════════════════════════════
let KEYWORDS = null;

function loadKeywords() {
  if (KEYWORDS) return;
  const csvPath = path.join(__dirname, 'keywordRouter.csv');
  if (!fs.existsSync(csvPath)) {
    console.warn('keywordRouter.csv not found; keyword routing disabled');
    KEYWORDS = [];
    return;
  }
  const csv = fs.readFileSync(csvPath, 'utf8');
  const records = parseCsv(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  });
  KEYWORDS = records
    .filter(r => r.modern_label && r.closest_naics_6)
    .map(r => ({
      phrase: r.modern_label.toLowerCase(),
      naics6: r.closest_naics_6,
      confidence: r.confidence,
    }));
}

function matchKeywords(input) {
  loadKeywords();
  const lower = input.toLowerCase();
  const matches = [];
  for (const kw of KEYWORDS) {
    if (lower.includes(kw.phrase)) {
      matches.push(kw);
    }
  }
  // Deduplicate by NAICS-6
  const seen = new Set();
  return matches.filter(m => {
    if (seen.has(m.naics6)) return false;
    seen.add(m.naics6);
    return true;
  });
}

// ════════════════════════════════════════════════════════════════════
// DISAMBIGUATION
// ════════════════════════════════════════════════════════════════════
function checkDisambiguation(input, keywordMatches) {
  const lower = input.toLowerCase();

  // Find a disambig rule that matches one of the keywords
  for (const kw of keywordMatches) {
    const rule = REGISTRY.disambiguation[kw.phrase];
    if (rule) {
      // Apply the tiebreak rule programmatically — for now, check
      // if the input contains any of the candidate-disambiguating
      // tokens (this would be a per-rule resolver in production).
      if (!rule.ask_user) {
        // Default to first candidate (the rule says default)
        return {
          resolved: true,
          naics6: rule.candidates[0].naics6,
          rule: `Applied tiebreak: ${rule.tiebreak}`,
        };
      }
      return {
        resolved: false,
        candidates: rule.candidates,
        tiebreak: rule.tiebreak,
      };
    }
  }

  // No registered rule — surface to user
  return {
    resolved: false,
    candidates: keywordMatches,
    tiebreak: 'Multiple business-type matches; please clarify.',
  };
}

// ════════════════════════════════════════════════════════════════════
// OUT-OF-SCOPE CHECK — runs after NAICS resolution
// ════════════════════════════════════════════════════════════════════
function checkOutOfScope(naics6) {
  const naics2 = naics6.substring(0, 2);

  // Check NAICS-2 OOS
  for (const oos of REGISTRY.outOfScope.naics2) {
    if (oos.naics2 === naics2 ||
        (oos.naics2 === '31-33' && ['31', '32', '33'].includes(naics2)) ||
        (oos.naics2 === '44-45' && ['44', '45'].includes(naics2)) ||
        (oos.naics2 === '48-49' && ['48', '49'].includes(naics2))) {
      return { outOfScope: true, ...oos };
    }
  }

  // Check NAICS-6 patterns
  for (const pat of REGISTRY.outOfScope.naics6Patterns) {
    // Skip if exception list applies
    if (pat.exception_codes && pat.exception_codes.includes(naics6)) continue;
    // Pattern matching (simplified)
    if (matchesPattern(naics6, pat.pattern)) {
      return { outOfScope: true, ...pat };
    }
  }

  return { outOfScope: false };
}

function matchesPattern(naics6, pattern) {
  // Pattern formats: "311111-311999", "481*-486*", "813*"
  if (pattern.includes('*')) {
    const prefix = pattern.replace(/\*.*$/, '').replace('-', '');
    return naics6.startsWith(prefix);
  }
  if (pattern.includes('-')) {
    const [start, end] = pattern.split('-').map(s => s.trim());
    if (start.match(/^\d+$/) && end.match(/^\d+$/)) {
      const code = parseInt(naics6, 10);
      return code >= parseInt(start, 10) && code <= parseInt(end, 10);
    }
  }
  return naics6 === pattern;
}

// ════════════════════════════════════════════════════════════════════
// CITATION LINTER — refuses customer reports with unsourced claims
// ════════════════════════════════════════════════════════════════════
function lintReport(reportObj) {
  if (!STUDIES) loadRegistries();
  const validIds = new Set(STUDIES.studies.map(s => s.id));

  const errors = [];
  const claims = (reportObj.claims || []);

  for (const claim of claims) {
    if (!claim.studyId) {
      errors.push(`Claim missing studyId: "${claim.text.substring(0, 80)}..."`);
      continue;
    }
    if (!validIds.has(claim.studyId)) {
      errors.push(`Claim references unknown studyId "${claim.studyId}": ` +
                  `"${claim.text.substring(0, 80)}..."`);
      continue;
    }
    // Tier-3 disclosure check
    const study = STUDIES.studies.find(s => s.id === claim.studyId);
    if (study.tier === 3 && !claim.tier3Disclosure) {
      errors.push(`Tier-3 claim ${claim.studyId} requires vendor disclosure: ` +
                  `"${claim.text.substring(0, 80)}..."`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    claimCount: claims.length,
    sourceCount: new Set(claims.map(c => c.studyId)).size,
  };
}

// ════════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════════
module.exports = {
  loadRegistries,
  classifyInput,
  checkOutOfScope,
  lintReport,
  // For testing:
  matchChain,
  matchKeywords,
  checkDisambiguation,
};

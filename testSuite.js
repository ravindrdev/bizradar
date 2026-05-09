// testSuite.js — runs every line in testAddresses.txt against /classify
// and saves structured results to testResults.json.
//
// Per-line behavior:
//   1. Strip the leading "<num>. " prefix; the rest is the full input string.
//   2. POST to http://localhost:3000/classify with form-urlencoded body
//      `query=<encoded full input>` (matches the HTML form's body shape).
//   3. Read X-Layer0-Mode, X-Naics6, X-Profile-Id, X-Status response headers
//      (added in server.js for diagnostics).
//   4. 300ms delay before next request.
//
// Output:
//   testResults.json — one entry per line:
//     { line, business_name, full_input, profile_id, naics6, mode, status,
//       expected_profile, mis_routed, http_status }
//   stdout — running progress and final summary.

const fs = require('fs');
const path = require('path');

// Expected-profile mapping. These are best-fit per the BizRadar profile
// registry (88 filled profiles + 2 OOS markers). When the actual route
// differs, the entry is flagged as `mis_routed=true` (unless it's UNSUPPORTED
// or OOS_waitlist, which are tracked separately).
const EXPECTED = {
  1:  'hospitality.lodging',
  2:  'hospitality.lodging',
  3:  'hospitality.lodging',
  4:  'hospitality.lodging',
  5:  'hospitality.lodging',
  6:  'hospitality.full_service_restaurant',
  7:  'hospitality.full_service_restaurant',
  8:  'hospitality.full_service_restaurant',
  9:  'hospitality.full_service_restaurant',
  10: 'hospitality.full_service_restaurant',
  11: 'hospitality.cafe_quick_service',
  12: 'hospitality.cafe_quick_service',
  13: 'hospitality.cafe_quick_service',
  14: 'hospitality.cafe_quick_service',
  15: 'hospitality.cafe_quick_service',
  16: 'healthcare.dental_practice',
  17: 'healthcare.dental_practice',
  18: 'healthcare.dental_practice',
  19: 'healthcare.dental_practice',
  20: 'healthcare.dental_practice',
  21: 'other_services.auto_repair',
  22: 'other_services.auto_repair',
  23: 'other_services.auto_repair',
  24: 'other_services.auto_repair',
  25: 'other_services.auto_repair',
  26: 'recreation.fitness_studio',
  27: 'recreation.fitness_studio',
  28: 'recreation.fitness_studio',
  29: 'recreation.fitness_studio',
  30: 'recreation.fitness_studio',
  31: 'retail.specialty_brick_mortar',
  32: 'retail.specialty_brick_mortar',
  33: 'retail.specialty_brick_mortar',
  34: 'retail.specialty_brick_mortar',
  35: 'retail.specialty_brick_mortar',
  36: 'professional.legal',
  37: 'professional.accounting',
  38: 'admin.office_business_support',
  39: 'admin.staffing_agency',
  40: 'professional.consulting',
  41: 'construction.residential_trades',
  42: 'construction.residential_trades',
  43: 'construction.residential_trades',
  44: 'construction.residential_trades',
  45: 'construction.commercial_gc',
  46: 'education.tutoring_test_prep',
  47: 'education.trade_technical',
  48: 'education.k12_private',
  49: 'education.bootcamps_online',
  50: 'education.colleges_universities',
  51: 'other_services.personal_care',
  52: 'other_services.personal_care',
  53: 'other_services.personal_care',
  54: 'other_services.personal_care',
  55: 'other_services.personal_care',
  56: 'healthcare.medical_practice',
  57: 'healthcare.allied_health',
  58: 'healthcare.allied_health',
  59: 'OUT_OF_SCOPE_NICHE',
  60: 'healthcare.behavioral_health',
  61: 'manufacturing.food_beverage_dtc',
  62: 'manufacturing.food_beverage_dtc',
  63: 'hospitality.cafe_quick_service',
  64: 'hospitality.catering_special_food',
  65: 'hospitality.cafe_quick_service',
  66: 'real_estate.brokerage',
  67: 'finance.insurance_agency',
  68: 'finance.community_bank',
  69: 'finance.ria_wealth_management',
  70: 'real_estate.property_management',
  71: 'recreation.amusement_attraction',
  72: 'recreation.amusement_attraction',
  73: 'recreation.amusement_attraction',
  74: 'recreation.amusement_attraction',
  75: 'recreation.amusement_attraction',
  76: 'admin.facility_services',
  77: 'admin.security_pest',
  78: 'transportation.support_services',
  79: 'real_estate.self_storage',
  80: 'admin.staffing_agency',
  81: 'agriculture.crop_farming',
  82: 'manufacturing.food_beverage_dtc',
  83: 'manufacturing.food_beverage_dtc',
  84: 'retail.grocery_food',
  85: 'manufacturing.food_beverage_dtc',
  86: 'professional.veterinary',
  87: 'other_services.personal_care',
  88: 'professional.veterinary',
  89: 'professional.veterinary',
  90: 'other_services.personal_care',
  91: 'recreation.amusement_attraction',
  92: 'hospitality.catering_special_food',
  93: 'real_estate.equipment_rental',
  94: 'transportation.passenger',
  95: 'recreation.amusement_attraction',
  96: 'professional.consulting',
  97: 'professional.consulting',
  98: 'professional.consulting',
  99: 'information.motion_picture_sound',
  100: 'professional.consulting',
};

const SERVER = 'http://localhost:3000/classify';
const DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseLine(rawLine) {
  // Strip leading "<num>. " — match digits, period, one or more spaces.
  const m = rawLine.match(/^(\d+)\.\s+(.*\S)\s*$/);
  if (!m) return null;
  const lineNum = parseInt(m[1], 10);
  const fullInput = m[2];
  // Business name = everything before the first comma whose right side
  // starts with a street number — same heuristic as the location mode.
  const nm = fullInput.match(/^(.+?),\s*\d+\s+/);
  const businessName = nm ? nm[1].trim() : fullInput.split(',')[0].trim();
  return { lineNum, fullInput, businessName };
}

async function classify(query) {
  const body = 'query=' + encodeURIComponent(query);
  const res = await fetch(SERVER, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const html = await res.text();
  return {
    http_status: res.status,
    headers: {
      mode: res.headers.get('x-layer0-mode') || '',
      naics6: res.headers.get('x-naics6') || '',
      profile_id: res.headers.get('x-profile-id') || '',
      status: res.headers.get('x-status') || '',
      place_name: res.headers.get('x-place-name')
        ? decodeURIComponent(res.headers.get('x-place-name'))
        : '',
    },
    html_excerpt: html.slice(0, 200),
  };
}

(async () => {
  const t0 = Date.now();
  const raw = fs.readFileSync(path.join(__dirname, 'testAddresses.txt'), 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  console.log(`Loaded ${lines.length} test addresses\n`);

  const results = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { lineNum, fullInput, businessName } = parsed;
    let outcome;
    try {
      const c = await classify(fullInput);
      // If X-Status was never set (e.g., 500/502 error path before headers),
      // infer from html and http status.
      let status = c.headers.status;
      if (!status) {
        if (c.http_status >= 500) status = 'server_error';
        else if (c.http_status === 422) status = 'missing_fields';
        else status = 'unknown';
      }
      const profileId = c.headers.profile_id;
      const expected = EXPECTED[lineNum] || null;
      const misRouted =
        status === 'report' &&
        expected &&
        profileId &&
        profileId !== expected;
      const expectedMet =
        (expected && profileId && profileId === expected) ||
        (expected && expected.startsWith('OUT_OF_SCOPE_') && profileId === expected) ||
        (expected && expected.startsWith('OUT_OF_SCOPE_') && status === 'oos_waitlist');

      outcome = {
        line: lineNum,
        business_name: businessName,
        full_input: fullInput,
        profile_id: profileId,
        naics6: c.headers.naics6,
        mode: c.headers.mode,
        status,
        place_name: c.headers.place_name,
        http_status: c.http_status,
        expected_profile: expected,
        expected_met: !!expectedMet,
        mis_routed: !!misRouted,
        html_excerpt: c.html_excerpt,
      };
    } catch (err) {
      outcome = {
        line: lineNum,
        business_name: businessName,
        full_input: fullInput,
        profile_id: '',
        naics6: '',
        mode: '',
        status: 'fetch_error',
        http_status: 0,
        expected_profile: EXPECTED[lineNum] || null,
        expected_met: false,
        mis_routed: false,
        error: err.message,
      };
    }
    results.push(outcome);

    const tag = outcome.status === 'report'
      ? (outcome.expected_met ? 'OK ' : 'DIFF')
      : outcome.status.toUpperCase().padEnd(4);
    process.stdout.write(
      `[${String(lineNum).padStart(3, ' ')}] ${tag} ${(outcome.profile_id || '-').padEnd(36)} ${outcome.business_name}\n`
    );

    await sleep(DELAY_MS);
  }

  fs.writeFileSync(
    path.join(__dirname, 'testResults.json'),
    JSON.stringify(results, null, 2)
  );

  // Summary
  const total = results.length;
  const reports = results.filter((r) => r.status === 'report').length;
  const unsupported = results.filter((r) => r.status === 'unsupported');
  const oos = results.filter((r) => r.status === 'oos_waitlist');
  const blocked = results.filter((r) => r.status === 'blocked');
  const missing = results.filter((r) => r.status === 'missing_fields');
  const errored = results.filter((r) =>
    ['server_error', 'fetch_error', 'unknown'].includes(r.status)
  );
  const misRouted = results.filter((r) => r.mis_routed);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n--- summary (${dt}s) ---`);
  console.log(`Total tested: ${total}`);
  console.log(`Reports generated: ${reports}`);
  console.log(`UNSUPPORTED: ${unsupported.length}`);
  if (unsupported.length) {
    for (const u of unsupported) {
      console.log(`  [${u.line}] ${u.business_name} (naics=${u.naics6 || '-'}, mode=${u.mode})`);
    }
  }
  console.log(`OOS_waitlist: ${oos.length}`);
  if (oos.length) {
    for (const o of oos) {
      console.log(`  [${o.line}] ${o.business_name} → ${o.profile_id}`);
    }
  }
  console.log(`Blocked (red flag): ${blocked.length}`);
  if (blocked.length) {
    for (const b of blocked) {
      console.log(`  [${b.line}] ${b.business_name} → ${b.profile_id}`);
    }
  }
  console.log(`Missing required fields: ${missing.length}`);
  if (missing.length) {
    for (const m of missing) {
      console.log(`  [${m.line}] ${m.business_name} → ${m.profile_id || '-'}`);
    }
  }
  console.log(`Errored: ${errored.length}`);
  if (errored.length) {
    for (const e of errored) {
      console.log(`  [${e.line}] ${e.business_name} (${e.status})`);
    }
  }
  console.log(`Mis-routed (report w/ different profile): ${misRouted.length}`);
  if (misRouted.length) {
    for (const m of misRouted) {
      console.log(
        `  [${m.line}] ${m.business_name}: got ${m.profile_id}, expected ${m.expected_profile}`
      );
    }
  }
  console.log(`\nResults written to testResults.json`);
})();

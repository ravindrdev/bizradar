#!/usr/bin/env node
/* verifyRegistry.js — Phase 2 wrap-up validator.
   Confirms:
     [a] profileRegistry.json parses as JSONC
     [b] exactly 90 top-level keys
     [c] 10 target profiles have full BATCH13 schemas (recs >=3, flags >=1)
     [d,e] every cited study_id exists in verifiedStudies.json
     [f] the other 80 stubs are untouched (only sector + name fields)
     [g] naicsRouter.csv has exactly 38 OUT_OF_SCOPE_* entries
   Exits non-zero on any FAIL. */

const fs = require('fs');
const path = require('path');
const { parse: parseJsonc } = require('jsonc-parser');
const { parse: parseCsv } = require('csv-parse/sync');

const TARGETS = [
  // Phase 2 Session 1
  'hospitality.full_service_restaurant',
  'hospitality.cafe_quick_service',
  'healthcare.dental_practice',
  'other_services.auto_repair',
  'recreation.fitness_studio',
  'other_services.personal_care',
  'retail.specialty_brick_mortar',
  'healthcare.medical_practice',
  'construction.residential_trades',
  'hospitality.lodging',
  // Phase 2 Session 2
  'professional.legal',
  'professional.accounting',
  'healthcare.allied_health',
  'recreation.amusement_attraction',
  'hospitality.bar_nightlife',
  'retail.grocery_food',
  // Phase 2 Session 3
  'admin.facility_services',
  'admin.security_pest',
  'transportation.trucking_freight',
  'real_estate.brokerage',
  'finance.insurance_agency',
  'professional.consulting',
  'professional.architecture_engineering',
  'other_services.dry_cleaning_laundry',
  'other_services.death_care',
  // Phase 2 Session 4
  'education.tutoring_test_prep',
  'healthcare.social_assistance',
  'professional.veterinary',
  'hospitality.catering_special_food',
  'real_estate.equipment_rental',
  // Phase 2 Session 5
  'other_services.repair_machinery_other',
  // Phase 2 Session 6
  'healthcare.behavioral_health',
  'healthcare.specialty_clinic',
  'healthcare.hospital',
  'healthcare.residential_care',
  'real_estate.property_management',
  'real_estate.self_storage',
  'transportation.passenger',
  'finance.community_bank',
  'manufacturing.food_beverage_dtc',
  'retail.auto_dealers',
  // Phase 2 Session 7
  'finance.ria_wealth_management',
  'admin.staffing_agency',
  'education.k12_private',
  'recreation.spectator_sports',
  'recreation.performing_arts',
  'recreation.museums_heritage',
  'retail.ecommerce_dtc',
  'retail.building_home',
  'retail.fuel_general_misc',
  'agriculture.crop_farming',
  // Phase 2 Session 8
  'agriculture.livestock',
  'agriculture.support_services',
  'construction.commercial_gc',
  'construction.civil_heavy',
  'education.bootcamps_online',
  'education.trade_technical',
  'education.colleges_universities',
  'education.support_services',
  'other_services.private_household',
  // Phase 2 Session 9 (final — MINIMAL B2B baseline)
  'manufacturing.industrial_b2b',
  'manufacturing.advanced_regulated',
  'manufacturing.textile_apparel',
  'manufacturing.wood_paper_print',
  'manufacturing.chemical_petroleum',
  'manufacturing.furniture_misc',
  'wholesale.durable_goods',
  'wholesale.nondurable_food_grocery',
  'transportation.courier_last_mile',
  'transportation.warehousing_3pl',
  'transportation.support_services',
  'information.saas_software',
  'information.telecom_isp',
  'information.broadcasting_production',
  'information.motion_picture_sound',
  'information.data_processing_hosting',
  'admin.waste_management',
  'agriculture.forestry_logging',
  'mining.oil_gas',
  'mining.aggregates_quarrying',
  'mining.support_services',
  'utilities.electric',
  'utilities.gas',
  'utilities.water_sewage',
  'transportation.pipeline_water',
  'information.media_publishing',
  'admin.office_business_support',
  'other_services.religious_civic',
];

const PROFILE_REQ = [
  'id', 'sector_naics2', 'name', 'naics6_codes', 'scope', 'evidence_class',
  'required_inputs', 'optional_inputs', 'missing_data_policy', 'benchmarks',
  'recommendations', 'red_flags', 'chain_handling', 'compliance_notes',
  'report_sections',
];
const REC_REQ = ['id', 'study_ids', 'trigger', 'claim', 'magnitude', 'ease', 'tier3_disclosure_required'];
const FLAG_REQ = ['id', 'trigger', 'severity', 'message', 'blocks_report'];
const CHAIN_REQ = ['detect_via', 'magnitude_scaling', 'note'];

const checks = [];
const record = (label, ok, detail = '') => checks.push({ label, ok, detail });

// [a] profileRegistry.json parses as JSONC
const regRaw = fs.readFileSync(path.join(__dirname, 'profileRegistry.json'), 'utf8');
const parseErrors = [];
const reg = parseJsonc(regRaw, parseErrors, { allowTrailingComma: false });
record('[a] profileRegistry.json parses (jsonc)',
  parseErrors.length === 0,
  parseErrors.length === 0 ? '' : `${parseErrors.length} parse errors`);

// [b] 90 top-level keys
const keys = Object.keys(reg || {});
record('[b] profileRegistry has exactly 90 top-level keys',
  keys.length === 90,
  `got ${keys.length}`);

// [c] Each target has full schema
for (const tid of TARGETS) {
  const p = reg[tid];
  if (!p) { record(`[c] ${tid}`, false, 'MISSING from registry'); continue; }
  const issues = [];
  for (const f of PROFILE_REQ) {
    if (p[f] === undefined) issues.push(`missing ${f}`);
  }
  if (p.id !== tid) issues.push(`id mismatch (got "${p.id}")`);
  const recs = Array.isArray(p.recommendations) ? p.recommendations : [];
  if (recs.length < 3) issues.push(`recommendations <3 (${recs.length})`);
  for (const r of recs) {
    for (const f of REC_REQ) {
      if (r[f] === undefined) issues.push(`rec ${r.id || '?'} missing ${f}`);
    }
  }
  const flags = Array.isArray(p.red_flags) ? p.red_flags : [];
  if (flags.length < 1) issues.push(`red_flags <1 (${flags.length})`);
  for (const rf of flags) {
    for (const f of FLAG_REQ) {
      if (rf[f] === undefined) issues.push(`flag ${rf.id || '?'} missing ${f}`);
    }
  }
  if (p.chain_handling) {
    for (const f of CHAIN_REQ) {
      if (p.chain_handling[f] === undefined) issues.push(`chain_handling missing ${f}`);
    }
  }
  record(`[c] ${tid}`,
    issues.length === 0,
    issues.length === 0 ? `recs=${recs.length} flags=${flags.length}` : issues.join('; '));
}

// [d,e] All cited study_ids exist
const studies = JSON.parse(fs.readFileSync(path.join(__dirname, 'verifiedStudies.json'), 'utf8')).studies;
const validIds = new Set(studies.map((s) => s.id));
const cited = new Set();
const unknownRefs = [];
for (const tid of TARGETS) {
  const p = reg[tid];
  if (!p) continue;
  for (const r of (p.recommendations || [])) {
    for (const sid of (r.study_ids || [])) {
      cited.add(sid);
      if (!validIds.has(sid)) unknownRefs.push(`${tid}/${r.id}: ${sid}`);
    }
  }
  if (p.chain_handling && p.chain_handling.magnitude_scaling) {
    for (const sid of Object.keys(p.chain_handling.magnitude_scaling)) {
      cited.add(sid);
      if (!validIds.has(sid)) unknownRefs.push(`${tid} chain_scaling: ${sid}`);
    }
  }
}
record('[d,e] every cited study_id exists in verifiedStudies.json',
  unknownRefs.length === 0,
  unknownRefs.length === 0 ? `${cited.size} unique IDs cited` : unknownRefs.join(', '));

// [f] Remaining stubs categorized: fillable vs intentional OOS markers
const stubKeys = keys.filter((k) => !TARGETS.includes(k));
const stubIssues = [];
for (const k of stubKeys) {
  const v = reg[k];
  const vk = Object.keys(v);
  const ok = vk.length === 2 && vk.includes('sector') && vk.includes('name');
  if (!ok) stubIssues.push(`${k} has keys [${vk.join(',')}]`);
}
const oosMarkers = stubKeys.filter((k) => k.startsWith('OUT_OF_SCOPE_'));
const fillableStubs = stubKeys.filter((k) => !k.startsWith('OUT_OF_SCOPE_'));
record(`[f] ${fillableStubs.length} fillable stubs remain (${oosMarkers.length} OOS markers preserved: ${oosMarkers.join(', ') || 'none'})`,
  stubIssues.length === 0 && fillableStubs.length === 0,
  stubIssues.length === 0 ? `${TARGETS.length} profiles filled` : stubIssues.slice(0, 3).join('; ') + (stubIssues.length > 3 ? ` …+${stubIssues.length - 3}` : ''));

// [g] naicsRouter.csv has 38 OUT_OF_SCOPE_* entries
const csvRaw = fs.readFileSync(path.join(__dirname, 'naicsRouter.csv'), 'utf8');
const csvRecords = parseCsv(csvRaw, {
  columns: true,
  skip_empty_lines: true,
  comment: '#',
  trim: true,
  relax_quotes: true,
});
const oosEntries = csvRecords.filter((r) => (r.sector_profile_id || '').startsWith('OUT_OF_SCOPE_'));
record('[g] naicsRouter has 91 OUT_OF_SCOPE_* entries (38 from Phase-2.5 + 53 from Session 6 reroutes)',
  oosEntries.length === 91,
  `got ${oosEntries.length}`);

// Print
const labelWidth = Math.max(...checks.map((c) => c.label.length));
console.log();
console.log('Check'.padEnd(labelWidth + 2) + ' Result');
console.log('-'.repeat(labelWidth + 2) + ' ------');
for (const c of checks) {
  const status = c.ok ? 'PASS' : 'FAIL';
  let line = c.label.padEnd(labelWidth + 2) + ' ' + status;
  if (c.detail) line += '  ' + c.detail;
  console.log(line);
}
console.log();
const allPass = checks.every((c) => c.ok);
console.log('Overall:', allPass ? 'PASS' : 'FAIL');
process.exit(allPass ? 0 : 1);

'use strict';

// Test: Census Bureau building permits — county annual data
// Source: https://www2.census.gov/econ/bps/County/co{year}a.txt
// Target: Iowa County, Wisconsin — State FIPS 55, County FIPS 049
//
// File format (comma-delimited, no ZIP):
//   Row 1 : group headers   (Survey, FIPS, FIPS, ..., 1-unit, 2-units, ...)
//   Row 2 : sub-headers     (Date, State, County, Code, Code, Name, Bldgs, Units, Value, ...)
//   Row 3 : blank
//   Row 4+: data            (2025, 01, 001, 3, 6, Autauga County, 200, 200, 82131895, ...)
//
// Column indices (0-based):
//   0  = year (survey date)
//   1  = state FIPS (2-digit)
//   2  = county FIPS (3-digit)
//   3  = region code
//   4  = division code
//   5  = county name
//   6  = 1-unit bldgs    7  = 1-unit units    8  = 1-unit value
//   9  = 2-unit bldgs   10  = 2-unit units   11  = 2-unit value
//  12  = 3-4 unit bldgs 13  = 3-4 unit units 14  = 3-4 unit value
//  15  = 5+ unit bldgs  16  = 5+ unit units  17  = 5+ unit value
//  (18-29 = reported/adjusted equivalents)

const https = require('https');
const http  = require('http');
const { parse } = require('csv-parse/sync');

const BASE  = 'https://www2.census.gov/econ/bps/County/';
const YEARS = ['2025', '2024'];  // fetch both for YoY
const TARGET_STATE  = '55';      // Wisconsin
const TARGET_COUNTY = '049';     // Iowa County

// ── Download URL with redirect following ─────────────────────────────────────
function downloadText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bizradar-test/1.0)' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        res.resume();
        return downloadText(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Parse the BPS county file ─────────────────────────────────────────────────
// Returns array of objects with named fields. Skips the 2-row header + blank.
function parseBpsFile(text) {
  // Split into lines; rows 0 and 1 are headers, row 2 is blank
  const lines = text.split('\n');
  // Rejoin without first 3 lines for csv-parse
  const dataText = lines.slice(3).join('\n');

  const rows = parse(dataText, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  return rows.map(r => ({
    year:         (r[0]  || '').trim(),
    state_fips:   (r[1]  || '').trim().padStart(2, '0'),
    county_fips:  (r[2]  || '').trim().padStart(3, '0'),
    region:       (r[3]  || '').trim(),
    division:     (r[4]  || '').trim(),
    county_name:  (r[5]  || '').trim(),
    // Raw permit counts (what was actually permitted)
    bldgs_1unit:  parseInt(r[6],  10) || 0,
    units_1unit:  parseInt(r[7],  10) || 0,
    value_1unit:  parseInt(r[8],  10) || 0,
    bldgs_2unit:  parseInt(r[9],  10) || 0,
    units_2unit:  parseInt(r[10], 10) || 0,
    value_2unit:  parseInt(r[11], 10) || 0,
    bldgs_34unit: parseInt(r[12], 10) || 0,
    units_34unit: parseInt(r[13], 10) || 0,
    value_34unit: parseInt(r[14], 10) || 0,
    bldgs_5plus:  parseInt(r[15], 10) || 0,
    units_5plus:  parseInt(r[16], 10) || 0,
    value_5plus:  parseInt(r[17], 10) || 0,
  })).map(r => ({
    ...r,
    total_bldgs: r.bldgs_1unit + r.bldgs_2unit + r.bldgs_34unit + r.bldgs_5plus,
    total_units: r.units_1unit + r.units_2unit + r.units_34unit + r.units_5plus,
    total_value: r.value_1unit + r.value_2unit + r.value_34unit + r.value_5plus,
  }));
}

function fmt(n) { return n.toLocaleString('en-US'); }
function dollar(n) { return '$' + (n / 1_000_000).toFixed(2) + 'M'; }

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(62));
  console.log('Census Bureau County Building Permits — Iowa County WI');
  console.log('='.repeat(62));

  const results = {};

  for (const year of YEARS) {
    const url = `${BASE}co${year}a.txt`;
    console.log(`\nDownloading ${year}: ${url}`);
    let text;
    try {
      text = await downloadText(url);
      console.log(`  OK — ${(text.length / 1024).toFixed(1)} KB, ${text.split('\n').length} lines`);
    } catch (err) {
      console.log(`  SKIP — ${err.message}`);
      continue;
    }

    const rows = parseBpsFile(text);
    console.log(`  Parsed ${rows.length} county rows`);

    // Show first 3 data rows on the first year only
    if (year === YEARS[0]) {
      console.log('\n' + '─'.repeat(62));
      console.log('SAMPLE — first 3 data rows:');
      rows.slice(0, 3).forEach((r, i) =>
        console.log(`  [${i+1}] ${r.year} | state=${r.state_fips} county=${r.county_fips} | ${r.county_name} | bldgs=${r.total_bldgs} units=${r.total_units}`)
      );
    }

    // Find Iowa County WI
    const iowa = rows.filter(r =>
      r.state_fips === TARGET_STATE && r.county_fips === TARGET_COUNTY
    );

    if (!iowa.length) {
      console.log(`  Iowa County (55/049) NOT FOUND in ${year} data`);
    } else {
      results[year] = iowa[0];
      console.log(`  Found Iowa County in ${year} data ✓`);
    }
  }

  // ── Print Iowa County results ───────────────────────────────────────────────
  console.log('\n' + '='.repeat(62));
  console.log('IOWA COUNTY, WISCONSIN (FIPS 55-049)');
  console.log('='.repeat(62));

  const r25 = results['2025'];
  const r24 = results['2024'];

  if (!r25 && !r24) {
    console.log('⚠  No data found for Iowa County in any available year.');
    return;
  }

  if (r25) {
    console.log(`\n2025 Building Permits:`);
    console.log(`  Total buildings : ${fmt(r25.total_bldgs)}`);
    console.log(`  Total units     : ${fmt(r25.total_units)}`);
    console.log(`  Total value     : ${dollar(r25.total_value)}`);
    console.log(`  Breakdown:`);
    console.log(`    1-unit   : ${fmt(r25.bldgs_1unit)} bldgs / ${fmt(r25.units_1unit)} units / ${dollar(r25.value_1unit)}`);
    console.log(`    2-unit   : ${fmt(r25.bldgs_2unit)} bldgs / ${fmt(r25.units_2unit)} units / ${dollar(r25.value_2unit)}`);
    console.log(`    3-4 unit : ${fmt(r25.bldgs_34unit)} bldgs / ${fmt(r25.units_34unit)} units / ${dollar(r25.value_34unit)}`);
    console.log(`    5+ unit  : ${fmt(r25.bldgs_5plus)} bldgs / ${fmt(r25.units_5plus)} units / ${dollar(r25.value_5plus)}`);
  }

  if (r24) {
    console.log(`\n2024 Building Permits:`);
    console.log(`  Total buildings : ${fmt(r24.total_bldgs)}`);
    console.log(`  Total units     : ${fmt(r24.total_units)}`);
    console.log(`  Total value     : ${dollar(r24.total_value)}`);
  }

  if (r25 && r24 && r24.total_bldgs > 0) {
    const yoy = (((r25.total_bldgs - r24.total_bldgs) / r24.total_bldgs) * 100).toFixed(1);
    const dir = r25.total_bldgs >= r24.total_bldgs ? '▲' : '▼';
    console.log(`\nYoY Change (buildings): ${dir} ${Math.abs(yoy)}% (${fmt(r24.total_bldgs)} → ${fmt(r25.total_bldgs)})`);
  } else if (r25 && r24 && r24.total_bldgs === 0) {
    console.log(`\nYoY: 2024 had 0 buildings — cannot compute percentage`);
  }

  if (r25) {
    console.log('\nFull 2025 row:');
    console.log(JSON.stringify(r25, null, 2));
  }

  console.log('\n' + '='.repeat(62));
  console.log('Done.');
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});

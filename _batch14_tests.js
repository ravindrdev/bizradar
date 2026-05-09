// _batch14_tests.js — Phase 3 BATCH14 enrichment verification.
// Hits /classify with the 5 specified addresses, then reads the latest
// [diag] enrichment lines from the server stdout file to show which new
// fields are populated for each.

const fs = require('fs');

const TESTS = [
  'AmericInn by Wyndham Dodgeville, 3637 WI-23, Dodgeville, WI 53533',
  'Spring Valley Dental, 100 E Leffler St, Dodgeville, WI 53533',
  'Smart Motors Toyota, 5901 Odana Rd, Madison, WI 53719',
  'Colectivo Coffee, 2908 N Oakland Ave, Milwaukee, WI 53211',
  'Planet Fitness, 2901 W Beltline Hwy, Madison, WI 53713',
];

const FIELDS = [
  'competitor_count',
  'competitor_median_rating',
  'median_household_income',
  'review_recency_days',
  'responds_to_reviews',
  'website_exists',
  'hours_complete',
];

(async () => {
  const results = [];
  for (const query of TESTS) {
    const t0 = Date.now();
    let html, status;
    try {
      const res = await fetch('http://localhost:3000/classify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'query=' + encodeURIComponent(query),
      });
      html = await res.text();
      status = {
        http: res.status,
        x_status: res.headers.get('x-status') || '',
        x_naics: res.headers.get('x-naics6') || '',
        x_profile: res.headers.get('x-profile-id') || '',
      };
    } catch (e) {
      status = { http: 0, x_status: 'fetch_error', error: e.message };
      html = '';
    }
    // Sniff the rendered "Operations & brand" / "Competitive context" /
    // "Location & market" sections for what landed in the report.
    const haveCompetitive = /<h2>Competitive context<\/h2>/.test(html);
    const haveMarket = /<h2>Location &amp; market<\/h2>/.test(html);
    const haveOps = /<h2>Operations &amp; brand<\/h2>/.test(html);
    results.push({
      query,
      ms: Date.now() - t0,
      ...status,
      sections: { competitive: haveCompetitive, market: haveMarket, ops: haveOps },
    });
    console.log(`[${results.length}/${TESTS.length}] ${query.split(',')[0]} → ${status.http} ${status.x_status} (${Date.now() - t0}ms)`);
  }

  // Read server stdout for the [diag] enrichment lines emitted on each request.
  const logPath = process.argv[2];
  if (!logPath || !fs.existsSync(logPath)) {
    console.error('No server log path given — pass it as argv[2]');
    process.exit(0);
  }
  const log = fs.readFileSync(logPath, 'utf8');
  const enrichLines = log.match(/\[diag\] enrichment: \{[^}]+\}/g) || [];
  // Take the LAST 5 (matches the 5 requests we just made).
  const recent = enrichLines.slice(-5);

  console.log('\n=== Per-test signal coverage ===\n');
  console.log(
    'Test'.padEnd(28) + ' | ' +
    FIELDS.map((f) => f.replace(/_/g, ' ').slice(0, 17).padEnd(17)).join(' | ')
  );
  console.log('-'.repeat(28 + 1 + (FIELDS.length * 20)));

  for (let i = 0; i < TESTS.length; i++) {
    const label = TESTS[i].split(',')[0].slice(0, 27).padEnd(28);
    const diag = recent[i] ? JSON.parse(recent[i].replace(/^\[diag\] enrichment: /, '')) : {};
    const cells = FIELDS.map((f) => {
      const v = diag[f];
      let out;
      if (v === null || v === undefined) out = '—';
      else if (typeof v === 'boolean') out = v ? 'true' : 'false';
      else if (typeof v === 'number') out = String(v);
      else out = String(v);
      return out.slice(0, 17).padEnd(17);
    });
    console.log(label + ' | ' + cells.join(' | '));
  }

  console.log('\n=== Section rendered in HTML report ===\n');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const flags = [];
    if (r.sections.competitive) flags.push('COMPETITIVE');
    if (r.sections.market) flags.push('MARKET');
    if (r.sections.ops) flags.push('OPS');
    console.log(
      `${TESTS[i].split(',')[0].padEnd(40)} → status=${r.x_status.padEnd(8)} naics=${r.x_naics.padEnd(7)} sections=[${flags.join(', ') || 'none'}]`
    );
  }
})();

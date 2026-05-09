// _phase4_final.js — Phase-4 final 5-test verification.
// Test 1 (AmericInn) → dump full HTML to /tmp/test1.html.
// Tests 2-5 → parse HTML and emit a summary line per spec.

const fs = require('fs');

const TESTS = [
  { label: 'AmericInn (hotel — WI)',          query: 'AmericInn by Wyndham Dodgeville, 3637 WI-23, Dodgeville, WI 53533' },
  { label: 'Aspen Dental (dental — NC)',       query: 'Aspen Dental, 4400 Sharon Rd, Charlotte, NC 28211' },
  { label: 'Jiffy Lube (auto repair — CA)',    query: 'Jiffy Lube, 2000 Arden Way, Sacramento, CA 95825' },
  { label: 'Orangetheory Fitness (fitness — NY)', query: 'Orangetheory Fitness, 189 Flatbush Ave, Brooklyn, NY 11217' },
  { label: 'Olive Garden (restaurant — FL)',   query: 'Olive Garden Italian Restaurant, 8694 International Dr, Orlando, FL 32819' },
];

function countMatches(html, regex) {
  const m = html.match(regex);
  return m ? m.length : 0;
}

function summarize(html, headers) {
  const profileId = headers['x-profile-id'] || '';
  const naics = headers['x-naics6'] || '';
  const layer0 = headers['x-layer0-mode'] || '';
  const status = headers['x-status'] || '';

  // Top-10 impact-label counts
  const high = countMatches(html, /class="impact impact-high"/g);
  const med = countMatches(html, /class="impact impact-medium"/g);
  const low = countMatches(html, /class="impact impact-low"/g);
  const minimal = countMatches(html, /class="impact impact-minimal"/g);
  const totalRecs = high + med + low + minimal;

  // HIDDEN / KNOWN
  const hidden = countMatches(html, /HIDDEN ISSUE/g);
  const known = countMatches(html, /KNOWN ISSUE/g);

  // Common Problems
  let cpStatus = 'absent';
  let cpThemes = [];
  if (/<h2>What your customers are saying/.test(html)) {
    if (/Need more reviews/.test(html)) cpStatus = 'fired (insufficient reviews)';
    else if (/No recurring complaints detected/.test(html)) cpStatus = 'fired (no themes above threshold)';
    else {
      cpStatus = 'fired (themes detected)';
      const themeMatches = html.match(/<div class="problem">\s*<h3>([^<]+?)(?:<span|<\/h3>)/g) || [];
      cpThemes = themeMatches.map((t) => t.replace(/<div class="problem">\s*<h3>/, '').replace(/<span|<\/h3>/, '').trim());
    }
  }

  // Money estimates
  const money = countMatches(html, /<strong>Money estimate:/g);

  // Category Coverage
  const hasCoverage = /<h2>What we analyzed — 7 signal categories<\/h2>/.test(html);

  // Sections sanity
  const sections = {
    competitive: /<h2>Competitive context<\/h2>/.test(html),
    market: /<h2>Location &amp; market<\/h2>/.test(html),
    ops: /<h2>Operations &amp; brand<\/h2>/.test(html),
    priority: /<h2>Priority actions — top 10<\/h2>/.test(html),
    common: /<h2>What your customers are saying — common problems detected<\/h2>/.test(html),
    coverage: hasCoverage,
  };

  return {
    profileId, naics, layer0, status,
    totalRecs, high, med, low, minimal,
    hidden, known,
    cpStatus, cpThemes,
    money,
    sections,
  };
}

(async () => {
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    let html, headers;
    try {
      const res = await fetch('http://localhost:3000/classify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'query=' + encodeURIComponent(t.query),
      });
      html = await res.text();
      headers = {
        'x-profile-id': res.headers.get('x-profile-id') || '',
        'x-naics6': res.headers.get('x-naics6') || '',
        'x-layer0-mode': res.headers.get('x-layer0-mode') || '',
        'x-status': res.headers.get('x-status') || '',
      };
    } catch (e) {
      console.log(`FAIL ${t.label}: ${e.message}`);
      continue;
    }

    if (i === 0) {
      // Dump full HTML for test 1
      fs.writeFileSync('test1.html', html);
    }
    const s = summarize(html, headers);
    console.log(`\n=== TEST ${i + 1}: ${t.label} ===`);
    console.log(`  Profile: ${s.profileId} (NAICS ${s.naics}, Layer 0 mode ${s.layer0}, status ${s.status})`);
    console.log(`  Total recommendations triggered: ${s.totalRecs}`);
    console.log(`  Impact: HIGH=${s.high}, MEDIUM=${s.med}, LOW=${s.low}, MINIMAL=${s.minimal}`);
    console.log(`  HIDDEN issues detected: ${s.hidden}, KNOWN issues: ${s.known}`);
    console.log(`  Common Problems section: ${s.cpStatus}${s.cpThemes.length ? ' [' + s.cpThemes.join(', ') + ']' : ''}`);
    console.log(`  Money estimates rendered: ${s.money}`);
    const sectionFlags = Object.entries(s.sections).filter(([_, v]) => v).map(([k]) => k);
    console.log(`  Sections present: ${sectionFlags.join(', ')}`);
  }
  console.log(`\nFull HTML for test 1 saved to /tmp/test1.html`);
})();

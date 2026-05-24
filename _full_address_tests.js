// _full_address_tests.js — verify the 3 full-Google-Maps-style inputs.
// Sends each as application/x-www-form-urlencoded (matching what the HTML
// form sends) so we exercise the same body-parser path as the real UI.

const profileResolver = require('./profileResolver');

const TESTS = [
  {
    label: 'AmericInn (Wyndham hotel)',
    query: 'AmericInn by Wyndham Dodgeville, 3637 WI-23, Dodgeville, WI 53533',
    expectProfile: 'hospitality.lodging',
  },
  {
    label: 'Spring Valley Dental',
    query: 'Spring Valley Dental, 100 E Leffler St, Dodgeville, WI 53533',
    expectProfile: 'healthcare.dental_practice',
  },
  {
    label: 'Smart Motors Toyota',
    query: 'Smart Motors Toyota, 5901 Odana Rd, Madison, WI 53719',
    expectProfile: 'retail.auto_dealers',
  },
];

(async () => {
  let pass = 0, fail = 0;
  for (const t of TESTS) {
    const body = 'query=' + encodeURIComponent(t.query);
    try {
      const res = await fetch('http://localhost:3000/classify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const html = await res.text();
      const m = html.match(/NAICS\s+(\d{6})/);
      const naics6 = m ? m[1] : null;
      const profile = naics6 ? profileResolver.resolveProfile(naics6) : null;
      const got = profile ? profile.id : (naics6 ? `naics:${naics6}` : 'no_match');

      let branch = 'report';
      if (/Waitlist/i.test(html) || /OUT_OF_SCOPE/i.test(html)) branch = 'OOS_waitlist';
      else if (/Unsupported business/i.test(html)) branch = 'unsupported';
      else if (/Missing required fields/i.test(html)) {
        const mm = html.match(/Missing required fields from Google Places: ([^<]+)/);
        branch = `missing:${mm ? mm[1].trim() : '?'}`;
      } else if (/Critical issue blocks/i.test(html)) branch = 'blocked';
      else if (/<title>GrowthIM Audit/i.test(html) || /<h1[^>]*>/i.test(html)) branch = 'report';

      const ok = got === t.expectProfile;
      const tag = ok ? 'PASS' : 'FAIL';
      if (ok) pass++; else fail++;
      console.log(`${tag}  ${t.label.padEnd(28)} → ${String(got).padEnd(30)} (naics=${naics6 || '-'}, branch=${branch})  expect=${t.expectProfile}`);
    } catch (e) {
      fail++;
      console.log(`FAIL  ${t.label.padEnd(28)} → ERROR: ${e.message}`);
    }
  }
  console.log(`\n${pass}/${TESTS.length} passing`);
})();

// _fix_tests.js — re-run only the 5 fix tests
// Sends the right /classify body shape (`query`) and parses HTML for NAICS6.
// Maps NAICS6 → profile_id via profileResolver.

const profileResolver = require('./profileResolver');

const TESTS = [
  { name: 'Terminix',                        city: 'Madison, WI',   expectProfile: 'admin.security_pest' },
  { name: 'Tipsy Cow Bar',                   city: 'Madison, WI',   expectProfile: 'hospitality.bar_nightlife' },
  { name: 'KinderCare Learning Center',      city: 'Austin, TX',    expectProfile: 'healthcare.social_assistance' },
  { name: 'Kumon Learning Center',           city: 'Houston, TX',   expectProfile: 'education.tutoring_test_prep' },
  { name: 'Montessori School',               city: 'Denver, CO',    expectProfile: 'education.k12_private' },
];

(async () => {
  let pass = 0, fail = 0;
  for (const t of TESTS) {
    const query = `${t.name} ${t.city}`;
    const body = JSON.stringify({ query });
    try {
      const res = await fetch('http://localhost:3000/classify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const html = await res.text();
      const m = html.match(/NAICS\s+(\d{6})/);
      const naics6 = m ? m[1] : null;
      const profile = naics6 ? profileResolver.resolveProfile(naics6) : null;
      const got = profile ? profile.id : (naics6 ? `naics:${naics6}` : 'no_match');

      // Try also to spot the OOS / unsupported / blocked branch
      let branch = '-';
      if (/Waitlist/i.test(html) || /OUT_OF_SCOPE/i.test(html)) branch = 'OOS_waitlist';
      else if (/Unsupported business/i.test(html)) branch = 'unsupported';
      else if (/Missing required fields/i.test(html)) {
        const mm = html.match(/Missing required fields from Google Places: ([^<]+)/);
        branch = `missing:${mm ? mm[1].trim() : '?'}`;
      } else if (/Critical issue blocks/i.test(html)) branch = 'blocked';

      const ok = got === t.expectProfile;
      const tag = ok ? 'PASS' : 'FAIL';
      if (ok) pass++; else fail++;
      console.log(`${tag}  ${t.name.padEnd(35)} → ${String(got).padEnd(35)} (naics=${naics6 || '-'}, ${branch})  expect=${t.expectProfile}`);
    } catch (e) {
      fail++;
      console.log(`FAIL  ${t.name.padEnd(35)} → ERROR: ${e.message}`);
    }
  }
  console.log(`\n${pass}/${TESTS.length} passing`);
})();

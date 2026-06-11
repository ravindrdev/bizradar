/* seoPages.js — Phase 1 programmatic SEO: vertical hub + 1,381 business-type
   pages + dynamic sitemaps. Self-contained module; server.js calls
   register(app) once, BEFORE express.static, so /sitemap.xml overrides any
   static copy.

   Design (per approved plan):
   - SSR from one template, data from seoData/verticals.json (built by
     scripts/build-vertical-data.js). LRU-cached rendered HTML + 24h
     Cache-Control. No DB, no external APIs, no auth — request cost is a Map
     lookup + (first hit only) a template-literal interpolation.
   - Fail-soft: if seoData/verticals.json is missing or unparseable the
     module logs once and registers nothing; the rest of the site is
     untouched.
   - Copy is compliance-locked to the rest of the site: ~50-page, "typically
     within 15 to 30 minutes", up to 27 verified sources, illustrative
     estimates, no guarantees. */

const fs = require('fs');
const path = require('path');
const { LRUCache } = require('lru-cache');

const BASE = 'https://growthim.com';

let DATA = null;
try {
  DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'seoData', 'verticals.json'), 'utf8'));
} catch (e) {
  console.error('[seo] seoData/verticals.json unavailable — SEO pages disabled:', e.message);
}

// ── Lookups built once at boot ───────────────────────────────────────
const BY_SLUG = new Map();
const SECTORS = new Map(); // sector key → { name, verticals: [] }
if (DATA && Array.isArray(DATA.verticals)) {
  for (const v of DATA.verticals) {
    BY_SLUG.set(v.slug, v);
    const key = v.sector_name || 'Other Business Types';
    if (!SECTORS.has(key)) SECTORS.set(key, []);
    SECTORS.get(key).push(v);
  }
}
const SECTOR_LIST = [...SECTORS.keys()].sort();

// ── City data (Phase 2) — same fail-soft pattern as verticals ────────
let CITY = null;
try {
  CITY = JSON.parse(fs.readFileSync(path.join(__dirname, 'seoData', 'cities.json'), 'utf8'));
} catch (e) {
  console.error('[seo] seoData/cities.json unavailable — city pages disabled:', e.message);
}
const CITY_BY_SLUG = new Map();
const CITIES_BY_STATE = new Map(); // state_name → [cities], population order
if (CITY && Array.isArray(CITY.cities)) {
  for (const c of CITY.cities) {
    CITY_BY_SLUG.set(c.slug, c);
    if (!CITIES_BY_STATE.has(c.state_name)) CITIES_BY_STATE.set(c.state_name, []);
    CITIES_BY_STATE.get(c.state_name).push(c);
  }
}
const STATE_LIST = [...CITIES_BY_STATE.keys()].sort();
const TOP_CITIES = (CITY && CITY.cities) ? CITY.cities.slice(0, 6) : [];

// Popular verticals for city-page cross-links — resolved against REAL slugs
// at boot so a rename in coverage-data can never produce a dead link.
const POPULAR_VERTICALS = (() => {
  if (!DATA) return [];
  const wants = [
    /^Full-Service Restaurants$/i, /Coffee/i, /^Hotels/i, /^Offices of Dentists$/i,
    /Beauty Salons/i, /Fitness and Recreational/i, /General Automotive Repair/i,
    /Plumbing, Heating/i, /Offices of Lawyers/i, /Veterinar/i,
  ];
  const out = [];
  const used = new Set();
  for (const re of wants) {
    const m = DATA.verticals.find((v) => re.test(v.name) && !used.has(v.slug));
    if (m) { used.add(m.slug); out.push(m); }
    if (out.length >= 8) break;
  }
  return out;
})();

const pageCache = new LRUCache({ max: 1000 });

// Sector-specific data sources surfaced on the page (beyond the universal
// set). Keyed by NAICS-2 group from harness_types.
const SECTOR_SOURCES = {
  '11': 'USDA NASS agriculture statistics and USDA ERS farm economics',
  '23': 'HUD residential building-permit activity',
  '44-45': 'Census County Business Patterns retail density',
  '48-49': 'FMCSA carrier safety records',
  '52': 'FDIC institution data',
  '53': 'HUD Fair Market Rents',
  '62': 'the NPI healthcare provider registry and CDC PLACES local health metrics',
  '71': 'Ticketmaster local events and National Park Service data',
  '72': 'TripAdvisor ratings and reviews plus Foursquare nearby venues',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Shared chrome (matches the site's navy/blue style) ──────────────
const GA = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-34WP6L6123"></script>\n' +
  '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag(\'js\',new Date());gtag(\'config\',\'G-34WP6L6123\');</script>';

const CSS = `
:root{--navy:#0F1729;--blue:#2563EB;--blue-hover:#1D4ED8;--white:#FFFFFF;--light:#F8FAFC;--gray-100:#F1F5F9;--gray-200:#E2E8F0;--text:#1E293B;--muted:#64748B;}
*{box-sizing:border-box;}body{font-family:'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:var(--light);color:var(--text);margin:0;font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased;}
a{color:var(--blue);text-decoration:none;}a:hover{text-decoration:underline;}
.nav{position:sticky;top:0;background:var(--navy);border-bottom:1px solid rgba(255,255,255,0.06);z-index:50;}
.nav-inner{max-width:1180px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
.nav-btn{display:inline-block;background:transparent;color:rgba(255,255,255,0.88);border:1px solid rgba(255,255,255,0.24);padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;}
.nav-btn:hover{background:rgba(255,255,255,0.08);text-decoration:none;}
.nav-btn.primary{background:var(--blue);border-color:var(--blue);color:#FFF;}
.hero{background:var(--light);padding:48px 24px 32px;border-bottom:1px solid var(--gray-200);}
.hero-inner{max-width:880px;margin:0 auto;}
.crumbs{font-size:13px;color:var(--muted);margin:0 0 14px;}
.crumbs a{color:var(--muted);}
h1{font-size:38px;font-weight:800;color:var(--navy);margin:0 0 10px;letter-spacing:-0.03em;line-height:1.12;}
.hero-meta{font-size:15px;color:var(--muted);margin:0;font-weight:500;}
main{background:var(--white);}
.content{max-width:880px;margin:0 auto;padding:40px 24px 72px;}
.content h2{font-size:22px;font-weight:700;color:var(--navy);margin:34px 0 12px;letter-spacing:-0.01em;}
.content ul{margin:0 0 14px;padding-left:22px;}
.content li{margin:6px 0;}
.study{background:var(--gray-100);border-left:3px solid var(--blue);border-radius:6px;padding:13px 16px;margin:10px 0;font-size:15px;}
.study .src{display:block;color:var(--muted);font-size:13px;margin-top:6px;}
.cta{background:var(--navy);border-radius:12px;padding:28px 26px;margin:38px 0 8px;text-align:center;}
.cta .t{color:#FFF;font-size:20px;font-weight:700;margin:0 0 6px;}
.cta .s{color:rgba(255,255,255,0.75);font-size:14px;margin:0 0 16px;}
.cta a.btn{display:inline-block;background:var(--blue);color:#FFF;padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;}
.cta a.btn:hover{background:var(--blue-hover);}
.related{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0;}
.related a{background:var(--gray-100);border:1px solid var(--gray-200);border-radius:999px;padding:6px 14px;font-size:13px;color:var(--text);}
.related a:hover{border-color:var(--blue);color:var(--blue);text-decoration:none;}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px;}
.toc a{background:var(--gray-100);border:1px solid var(--gray-200);border-radius:999px;padding:6px 14px;font-size:13px;}
.cols{columns:2;column-gap:32px;}
.cols a{display:block;margin:4px 0;font-size:14px;break-inside:avoid;}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 6px;}
.stat{flex:1;min-width:150px;background:var(--gray-100);border:1px solid var(--gray-200);border-radius:10px;padding:14px 16px;text-align:center;}
.stat .n{font-size:22px;font-weight:800;color:var(--navy);}
.stat .l{font-size:12px;color:var(--muted);margin-top:2px;}
.src-note{font-size:12px;color:var(--muted);margin:4px 0 0;}
.footer{background:var(--navy);color:rgba(255,255,255,0.7);padding:36px 24px;}
.footer-inner{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:1fr 2fr 1fr;align-items:center;gap:16px;font-size:14px;}
.footer-center{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;}
.footer a{color:rgba(255,255,255,0.7);}
.footer a:hover{color:#FFF;text-decoration:none;}
@media(max-width:640px){h1{font-size:28px;}.cols{columns:1;}.footer-inner{grid-template-columns:1fr;text-align:center;}.footer-right{text-align:center;}}
`;

function navHtml() {
  return `<nav class="nav"><div class="nav-inner">
  <a href="/" style="text-decoration:none;"><div>
    <span style="color:#FFFFFF;font-size:22px;font-weight:700;letter-spacing:-0.5px;">Growth<span style="color:#2563EB">IM</span></span>
    <div style="width:140px;height:2px;background:#2563EB;opacity:0.4;margin-top:2px;"></div>
    <div style="font-size:9px;font-weight:600;color:#64748B;letter-spacing:0.12em;margin-top:2px;">GROWTH INTELLIGENCE MACHINE</div>
  </div></a>
  <div style="display:flex;gap:10px;align-items:center;">
    <a href="/reports" class="nav-btn">Business Types</a>
    <a href="/app" class="nav-btn primary">Get Your Report</a>
  </div>
</div></nav>`;
}

function footerHtml() {
  return `<footer class="footer"><div class="footer-inner">
  <div style="color:rgba(255,255,255,0.85);font-weight:600;">GrowthIM &copy; 2026</div>
  <div class="footer-center">
    <a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/refund">Refund Policy</a><a href="/contact">Contact</a><a href="/supported">What We Support</a><a href="/reports">Business Types</a><a href="/market-analysis">Cities</a>
  </div>
  <div class="footer-right" style="text-align:right;"><a href="mailto:support@growthim.com">support@growthim.com</a></div>
</div></footer>`;
}

function pageShell({ title, desc, canonical, ldBlocks, body }) {
  return `<!doctype html>
<html lang="en">
<head>
${GA}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="GrowthIM">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${BASE}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
${ldBlocks.map((o) => '<script type="application/ld+json">' + JSON.stringify(o) + '</script>').join('\n')}
<style>${CSS}</style>
</head>
<body>
${navHtml()}
${body}
${footerHtml()}
</body>
</html>`;
}

// ── FAQ (shared shape; type-specific wording) ────────────────────────
function faqFor(name, sourcesLine) {
  return [
    {
      q: `What does a ${name} market analysis report include?`,
      a: `A ~50-page report covering your top competitors, local demographics, customer review insights, website and Google ranking analysis, seasonal planning, risk alerts, untapped opportunities, and a ready-to-use 90-day action plan tailored to your ${name.toLowerCase()}.`,
    },
    {
      q: 'How much does it cost?',
      a: 'A one-time $29.99 per report. No subscription, no recurring charges.',
    },
    {
      q: 'How long does the report take?',
      a: 'Reports typically take 15 to 30 minutes and are delivered to your dashboard. During busy periods it may take longer.',
    },
    {
      q: 'Where does the data come from?',
      a: `The engine draws on up to 27 verified data sources, including ${sourcesLine}. Revenue figures are clearly labeled as illustrative estimates based on stated assumptions.`,
    },
  ];
}

// ── Vertical page ────────────────────────────────────────────────────
function renderVertical(v) {
  const name = v.name;
  const canonical = `${BASE}/reports/${v.slug}`;
  const sector = v.sector_name || null;
  const extra = v.group && SECTOR_SOURCES[v.group] ? SECTOR_SOURCES[v.group] : null;
  const sourcesLine = 'Google Places, US Census Bureau, Bureau of Labor Statistics, and NOAA' + (extra ? `, plus ${extra}` : '');

  const studies = (v.study_ids || []).map((id) => DATA.studies[id]).filter(Boolean);
  const prob = v.profile_id ? DATA.problems[v.profile_id] : null;
  const siblings = (SECTORS.get(sector || 'Other Business Types') || []).filter((s) => s.slug !== v.slug).slice(0, 10);
  const faq = faqFor(name, sourcesLine);

  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Business Types', item: BASE + '/reports' },
        { '@type': 'ListItem', position: 3, name: name + ' Market Analysis', item: canonical },
      ],
    },
    {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
    {
      '@context': 'https://schema.org', '@type': 'Service',
      name: `${name} Market Analysis Report`,
      description: `A ~50-page market intelligence report for a ${name.toLowerCase()}: competitors, demographics, review insights, and a 90-day action plan.`,
      provider: { '@type': 'Organization', name: 'GrowthIM', url: BASE },
      areaServed: 'US',
      url: canonical,
      offers: { '@type': 'Offer', price: '29.99', priceCurrency: 'USD', url: BASE + '/app' },
    },
  ];

  const body = `
<section class="hero"><div class="hero-inner">
  <p class="crumbs"><a href="/">Home</a> &rsaquo; <a href="/reports">Business Types</a> &rsaquo; ${esc(name)}</p>
  <h1>${esc(name)} Market Analysis Report</h1>
  <p class="hero-meta">${sector ? esc(sector) + ' &middot; ' : ''}${v.naics6 ? 'NAICS ' + esc(v.naics6) + ' &middot; ' : ''}~50-page report &middot; $29.99 one-time</p>
</div></section>
<main><div class="content">

  <p>Most ${esc(name.toLowerCase())} owners are guessing. They don't know which competitor is winning their customers, why Google ranks rivals above them, or what their local market actually supports. GrowthIM ends the guessing with a ~50-page market intelligence report built specifically for your ${esc(name.toLowerCase())} from 27 verified data sources including Google, US Census, and BLS. Inside: competitor breakdowns, review intelligence, local demographics, seasonal demand patterns, risk alerts, priority actions ranked for your specific business, and opportunities nobody else in your market is doing yet. Delivered to your dashboard, typically within 15 to 30 minutes. One report, $29.99, no subscription.</p>

  <h2>What your ${esc(name.toLowerCase())} report covers</h2>
  <ul>
    <li><strong>Top-5 competitor deep dive</strong> &mdash; ratings, review counts, what their customers praise and complain about, and how to stand out against them.</li>
    <li><strong>Local demographics</strong> &mdash; population, median household income, and age profile for your area from the US Census Bureau.</li>
    <li><strong>Review intelligence</strong> &mdash; sentiment themes in your reviews vs. your competitors&rsquo;.</li>
    <li><strong>Website &amp; Google ranking analysis</strong> &mdash; PageSpeed performance and where your online presence is losing visitors.</li>
    <li><strong>Seasonal strategy</strong> &mdash; quarter-by-quarter plays tied to real local events.</li>
    <li><strong>Risk alerts</strong> &mdash; the issues most likely to cost you customers, ranked.</li>
    <li><strong>Opportunities</strong> &mdash; openings in your local market nobody else is acting on.</li>
    <li><strong>90-day action plan</strong> &mdash; prioritized, concrete steps with illustrative impact estimates (clearly labeled; not guarantees).</li>
  </ul>

  <h2>The data behind it</h2>
  <p>Every report is built from up to 27 verified data sources &mdash; for ${sector ? esc(sector.toLowerCase()) + ' businesses' : 'your business'} that includes ${esc(sourcesLine)}. Nothing is invented: if a data point cannot be verified from a real source, it does not appear in your report.</p>

  ${studies.length ? `<h2>What research says</h2>
  ${studies.map((s) => `<div class="study">${esc(s.claim)}<span class="src">Source: ${esc(s.citation)}${s.year ? ' (' + esc(s.year) + ')' : ''}</span></div>`).join('\n  ')}
  <p style="font-size:13px;color:var(--muted);">Full citations for every claim appear inside the report.</p>` : ''}

  ${prob && prob.themes && prob.themes.length ? `<h2>Common ${esc(prob.sector_label || 'industry')} problems the report checks for</h2>
  <ul>
    ${prob.themes.map((t) => `<li><strong>${esc(t.name)}</strong>${t.fix ? ' &mdash; ' + esc(t.fix) : ''}</li>`).join('\n    ')}
  </ul>` : ''}

  <h2>Frequently asked questions</h2>
  ${faq.map((f) => `<h3 style="font-size:16px;margin:18px 0 6px;color:var(--navy);">${esc(f.q)}</h3><p style="margin:0 0 12px;">${esc(f.a)}</p>`).join('\n  ')}

  <div class="cta">
    <p class="t">Get your ${esc(name)} report</p>
    <p class="s">$29.99 one-time &middot; no subscription &middot; delivered to your dashboard</p>
    <a class="btn" href="/app">Analyze My Business &rarr;</a>
  </div>

  ${siblings.length ? `<h2>Related business types</h2>
  <div class="related">
    ${siblings.map((s) => `<a href="/reports/${s.slug}">${esc(s.name)}</a>`).join('\n    ')}
    <a href="/reports">All business types &rarr;</a>
  </div>` : `<p><a href="/reports">Browse all business types &rarr;</a></p>`}

  ${TOP_CITIES.length ? `<h2>Popular cities</h2>
  <div class="related">
    ${TOP_CITIES.map((c) => `<a href="/market-analysis/${c.slug}">${esc(c.city)}, ${esc(c.state_abbr)}</a>`).join('\n    ')}
    <a href="/market-analysis">All cities &rarr;</a>
  </div>` : ''}

</div></main>`;

  return pageShell({
    title: `${name} Market Analysis Report | GrowthIM`,
    desc: `${name} market intelligence: competitors, local demographics, review insights, and a 90-day action plan. ~50-page report for $29.99, delivered to your dashboard.`,
    canonical,
    ldBlocks: ld,
    body,
  });
}

// ── Hub page ─────────────────────────────────────────────────────────
function renderHub() {
  const total = DATA.verticals.length;
  const anchor = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Business Types', item: BASE + '/reports' },
      ],
    },
  ];
  const body = `
<section class="hero"><div class="hero-inner">
  <p class="crumbs"><a href="/">Home</a> &rsaquo; Business Types</p>
  <h1>Market Analysis Reports by Business Type</h1>
  <p class="hero-meta">${total.toLocaleString('en-US')} supported business types &middot; ~50-page report &middot; $29.99 one-time</p>
</div></section>
<main><div class="content">
  <p>GrowthIM generates a ~50-page market intelligence report tailored to your exact business type &mdash; competitors, demographics, review insights, and a 90-day action plan, built from up to 27 verified data sources. Find your business type below, or just <a href="/app">enter your business</a> and the engine classifies it automatically.</p>
  <div class="toc">
    ${SECTOR_LIST.map((s) => `<a href="#${anchor(s)}">${esc(s)} (${SECTORS.get(s).length})</a>`).join('\n    ')}
  </div>
  ${SECTOR_LIST.map((s) => `
  <h2 id="${anchor(s)}">${esc(s)}</h2>
  <div class="cols">
    ${SECTORS.get(s).map((v) => `<a href="/reports/${v.slug}">${esc(v.name)}</a>`).join('\n    ')}
  </div>`).join('\n')}
  <div class="cta">
    <p class="t">Not sure which type fits?</p>
    <p class="s">Enter your business name and address &mdash; the engine classifies it automatically.</p>
    <a class="btn" href="/app">Analyze My Business &rarr;</a>
  </div>
</div></main>`;
  return pageShell({
    title: 'Market Analysis Reports by Business Type | GrowthIM',
    desc: `Market analysis reports for ${total.toLocaleString('en-US')} business types: competitors, demographics, review insights, and a 90-day action plan. $29.99 one-time.`,
    canonical: BASE + '/reports',
    ldBlocks: ld,
    body,
  });
}

// ── Sitemaps ─────────────────────────────────────────────────────────
function xmlUrl(loc, lastmod, changefreq, priority) {
  return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}

function sitemapIndexXml() {
  const lm = DATA.generated;
  const cityLine = CITY ? `\n  <sitemap><loc>${BASE}/sitemap-cities.xml</loc><lastmod>${CITY.generated}</lastmod></sitemap>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${BASE}/sitemap-core.xml</loc><lastmod>${lm}</lastmod></sitemap>
  <sitemap><loc>${BASE}/sitemap-verticals.xml</loc><lastmod>${lm}</lastmod></sitemap>${cityLine}
</sitemapindex>`;
}

function sitemapCoreXml() {
  const lm = DATA.generated;
  const rows = [
    xmlUrl(BASE + '/', lm, 'weekly', '1.0'),
    xmlUrl(BASE + '/reports', lm, 'weekly', '0.8'),
    ...(CITY ? [xmlUrl(BASE + '/market-analysis', lm, 'weekly', '0.8')] : []),
    xmlUrl(BASE + '/supported', lm, 'monthly', '0.5'),
    xmlUrl(BASE + '/contact', lm, 'monthly', '0.5'),
    xmlUrl(BASE + '/privacy', lm, 'yearly', '0.3'),
    xmlUrl(BASE + '/terms', lm, 'yearly', '0.3'),
    xmlUrl(BASE + '/refund', lm, 'yearly', '0.3'),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>`;
}

function sitemapVerticalsXml() {
  const lm = DATA.generated;
  const rows = DATA.verticals.map((v) => xmlUrl(`${BASE}/reports/${v.slug}`, lm, 'monthly', '0.6'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>`;
}

// ── City page (Phase 2) ──────────────────────────────────────────────
function renderCity(c) {
  const cityLabel = `${c.city}, ${c.state_abbr}`;
  const canonical = `${BASE}/market-analysis/${c.slug}`;
  const pop = c.population != null ? c.population.toLocaleString('en-US') : null;
  const income = c.median_income != null ? '$' + c.median_income.toLocaleString('en-US') : null;
  const age = c.median_age != null ? String(c.median_age) : null;
  const sameState = (CITIES_BY_STATE.get(c.state_name) || []).filter((x) => x.slug !== c.slug).slice(0, 10);

  const faq = [
    {
      q: `What does a market analysis report for a ${cityLabel} business include?`,
      a: `A ~50-page report tailored to your business in ${cityLabel}: your top local competitors, neighborhood demographics, customer review insights, website and Google ranking analysis, seasonal planning, risk alerts, and a 90-day action plan.`,
    },
    {
      q: 'How much does it cost?',
      a: 'A one-time $29.99 per report. No subscription, no recurring charges.',
    },
    {
      q: 'How long does the report take?',
      a: 'Reports typically take 15 to 30 minutes and are delivered to your dashboard. During busy periods it may take longer.',
    },
    {
      q: `Where does the ${c.city} data come from?`,
      a: `The engine draws on up to 27 verified data sources, including US Census Bureau demographics for the ${c.city} area, Bureau of Labor Statistics employment data, HUD building permits, NOAA climate data, and Google Places. Revenue figures are clearly labeled as illustrative estimates based on stated assumptions.`,
    },
  ];

  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Cities', item: BASE + '/market-analysis' },
        { '@type': 'ListItem', position: 3, name: cityLabel + ' Market Analysis', item: canonical },
      ],
    },
    {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
    {
      '@context': 'https://schema.org', '@type': 'Service',
      name: `${cityLabel} Market Analysis Report`,
      description: `A ~50-page market intelligence report for businesses in ${cityLabel}: competitors, local demographics, review insights, and a 90-day action plan.`,
      provider: { '@type': 'Organization', name: 'GrowthIM', url: BASE },
      areaServed: cityLabel,
      url: canonical,
      offers: { '@type': 'Offer', price: '29.99', priceCurrency: 'USD', url: BASE + '/app' },
    },
  ];

  const body = `
<section class="hero"><div class="hero-inner">
  <p class="crumbs"><a href="/">Home</a> &rsaquo; <a href="/market-analysis">Cities</a> &rsaquo; ${esc(cityLabel)}</p>
  <h1>${esc(cityLabel)} Market Analysis Report</h1>
  <p class="hero-meta">${esc(c.state_name)}${pop ? ' &middot; population ' + pop : ''} &middot; ~50-page report &middot; $29.99 one-time</p>
</div></section>
<main><div class="content">

  <p>Running a business in ${esc(cityLabel)} means competing against every similar business your customers can reach. GrowthIM maps your exact competitive landscape with a ~50-page market intelligence report built from 27 verified data sources covering your specific ${esc(c.city)} market. Inside: real Census demographics for your area, your named local competitors with their ratings and weaknesses, what reviews reveal about you versus them, seasonal demand for your region, priority actions ranked for your business, and opportunities nobody else in your ${esc(c.city)} market is doing yet. Delivered to your dashboard, typically within 15 to 30 minutes. One report, $29.99, no subscription.</p>

  <div class="stats">
    ${pop ? `<div class="stat"><div class="n">${pop}</div><div class="l">Population</div></div>` : ''}
    ${income ? `<div class="stat"><div class="n">${income}</div><div class="l">Median household income</div></div>` : ''}
    ${age ? `<div class="stat"><div class="n">${esc(age)}</div><div class="l">Median age</div></div>` : ''}
  </div>
  <p class="src-note">Source: US Census Bureau, American Community Survey 5-Year Estimates (2023).</p>

  <h2>How the report uses ${esc(c.city)} data</h2>
  <ul>
    <li><strong>Local demographics</strong> &mdash; US Census income, population, and age data for your specific area inside ${esc(c.city)}, so pricing context fits your actual customers (median household income here is ${income || 'pulled live from the Census'}).</li>
    <li><strong>Competitor mapping</strong> &mdash; your top-5 competitors in ${esc(c.city)}, their ratings, review counts, and what their customers complain about.</li>
    <li><strong>Growth signals</strong> &mdash; HUD residential building permits show where ${esc(c.city)} is growing.</li>
    <li><strong>Sector employment</strong> &mdash; Bureau of Labor Statistics data for your industry.</li>
    <li><strong>Seasonality</strong> &mdash; NOAA climate data plus real local events drive a quarter-by-quarter plan.</li>
    <li><strong>Your online presence</strong> &mdash; PageSpeed and review-sentiment analysis against ${esc(c.city)} competitors.</li>
  </ul>

  <h2>Frequently asked questions</h2>
  ${faq.map((f) => `<h3 style="font-size:16px;margin:18px 0 6px;color:var(--navy);">${esc(f.q)}</h3><p style="margin:0 0 12px;">${esc(f.a)}</p>`).join('\n  ')}

  <div class="cta">
    <p class="t">Get your ${esc(cityLabel)} report</p>
    <p class="s">$29.99 one-time &middot; no subscription &middot; delivered to your dashboard</p>
    <a class="btn" href="/app">Analyze My Business &rarr;</a>
  </div>

  ${sameState.length ? `<h2>More ${esc(c.state_name)} cities</h2>
  <div class="related">
    ${sameState.map((x) => `<a href="/market-analysis/${x.slug}">${esc(x.city)}</a>`).join('\n    ')}
    <a href="/market-analysis">All cities &rarr;</a>
  </div>` : `<p><a href="/market-analysis">Browse all cities &rarr;</a></p>`}

  ${POPULAR_VERTICALS.length ? `<h2>Popular business types</h2>
  <div class="related">
    ${POPULAR_VERTICALS.map((v) => `<a href="/reports/${v.slug}">${esc(v.name)}</a>`).join('\n    ')}
    <a href="/reports">All business types &rarr;</a>
  </div>` : ''}

</div></main>`;

  return pageShell({
    title: `${cityLabel} Market Analysis Report | GrowthIM`,
    desc: `Market intelligence for businesses in ${cityLabel}: competitors, local demographics${income ? ' (median income ' + income + ')' : ''}, review insights, and a 90-day action plan. $29.99 one-time.`,
    canonical,
    ldBlocks: ld,
    body,
  });
}

// ── City hub ─────────────────────────────────────────────────────────
function renderCityHub() {
  const total = CITY.cities.length;
  const anchor = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ld = [
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE + '/' },
        { '@type': 'ListItem', position: 2, name: 'Cities', item: BASE + '/market-analysis' },
      ],
    },
  ];
  const body = `
<section class="hero"><div class="hero-inner">
  <p class="crumbs"><a href="/">Home</a> &rsaquo; Cities</p>
  <h1>Market Analysis Reports by City</h1>
  <p class="hero-meta">${total.toLocaleString('en-US')} US cities &middot; ~50-page report &middot; $29.99 one-time</p>
</div></section>
<main><div class="content">
  <p>GrowthIM generates a ~50-page market intelligence report for your business, grounded in real local data &mdash; US Census demographics, competitors, building permits, and events for your city. Find your city below, or just <a href="/app">enter your business</a> and the engine locates it automatically.</p>
  <div class="toc">
    ${STATE_LIST.map((s) => `<a href="#${anchor(s)}">${esc(s)} (${CITIES_BY_STATE.get(s).length})</a>`).join('\n    ')}
  </div>
  ${STATE_LIST.map((s) => `
  <h2 id="${anchor(s)}">${esc(s)}</h2>
  <div class="cols">
    ${CITIES_BY_STATE.get(s).map((c) => `<a href="/market-analysis/${c.slug}">${esc(c.city)}</a>`).join('\n    ')}
  </div>`).join('\n')}
  <div class="cta">
    <p class="t">Don&rsquo;t see your city?</p>
    <p class="s">Reports work for any US business with a Google Business Profile &mdash; these pages are just the largest 1,000 cities.</p>
    <a class="btn" href="/app">Analyze My Business &rarr;</a>
  </div>
</div></main>`;
  return pageShell({
    title: 'Market Analysis Reports by City | GrowthIM',
    desc: `Local market analysis for businesses in ${total.toLocaleString('en-US')} US cities: competitors, Census demographics, review insights, and a 90-day action plan. $29.99 one-time.`,
    canonical: BASE + '/market-analysis',
    ldBlocks: ld,
    body,
  });
}

function sitemapCitiesXml() {
  const lm = CITY.generated;
  const rows = CITY.cities.map((c) => xmlUrl(`${BASE}/market-analysis/${c.slug}`, lm, 'monthly', '0.6'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>`;
}

// ── Route registration ───────────────────────────────────────────────
function cached(key, producer, res, type) {
  let out = pageCache.get(key);
  if (!out) {
    out = producer();
    pageCache.set(key, out);
  }
  res.set('Content-Type', type);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(out);
}

function register(app) {
  if (!DATA || !BY_SLUG.size) {
    console.error('[seo] no vertical data loaded — SEO routes NOT registered');
    return;
  }
  app.get('/reports', (req, res) => cached('hub', renderHub, res, 'text/html; charset=utf-8'));
  app.get('/reports/:slug', (req, res, next) => {
    const v = BY_SLUG.get(String(req.params.slug || ''));
    if (!v) return next(); // unknown slug → falls through to the normal 404
    cached('v:' + v.slug, () => renderVertical(v), res, 'text/html; charset=utf-8');
  });
  app.get('/sitemap.xml', (req, res) => cached('sm:index', sitemapIndexXml, res, 'application/xml; charset=utf-8'));
  app.get('/sitemap-core.xml', (req, res) => cached('sm:core', sitemapCoreXml, res, 'application/xml; charset=utf-8'));
  app.get('/sitemap-verticals.xml', (req, res) => cached('sm:verticals', sitemapVerticalsXml, res, 'application/xml; charset=utf-8'));

  // City pages (Phase 2). GET-only — the Flow-2 API stays on POST
  // /market-analysis and is untouched (Express routes on method + path).
  if (CITY && CITY_BY_SLUG.size) {
    app.get('/market-analysis', (req, res) => cached('cityhub', renderCityHub, res, 'text/html; charset=utf-8'));
    app.get('/market-analysis/:slug', (req, res, next) => {
      const c = CITY_BY_SLUG.get(String(req.params.slug || ''));
      if (!c) return next(); // unknown slug → normal 404
      cached('c:' + c.slug, () => renderCity(c), res, 'text/html; charset=utf-8');
    });
    app.get('/sitemap-cities.xml', (req, res) => cached('sm:cities', sitemapCitiesXml, res, 'application/xml; charset=utf-8'));
  }
  console.log(`[seo] registered: /reports hub + ${BY_SLUG.size} vertical pages`
    + (CITY && CITY_BY_SLUG.size ? ` + /market-analysis hub + ${CITY_BY_SLUG.size} city pages` : '')
    + ' + sitemap routes');
}

module.exports = { register };

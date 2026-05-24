/* _gen_chart_preview.js — one-shot Bonanza Market chart preview.
 *
 * Fetches real data (NO Claude API) and renders the chart section
 * directly to public/chart_preview.html.
 *
 * Run once with: node _gen_chart_preview.js
 * Delete afterward — this is a debug/preview tool only.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const places = require('./googlePlaces');
const dataFetchers = require('./dataFetchers');

// ────────────────────────────────────────────────────────────────────
// renderMarketCharts — verbatim copy from server.js (lines 2932–3457
// after the 3 bug fixes: grace 15%, c.review_count, prior-year wiring).
// Inlined here so this preview script doesn't have to require server.js
// (which would call app.listen and conflict with the running server).
// ────────────────────────────────────────────────────────────────────
function renderMarketCharts(data, profile, displayName) {
  data = data || {};

  const yourName = displayName || data.name || data.business_name || 'Your business';
  const yourRating = (typeof data.google_rating === 'number') ? data.google_rating : null;
  const yourReviews = (typeof data.google_review_count === 'number') ? data.google_review_count : null;

  const rawComps = Array.isArray(data.competitors_top5) && data.competitors_top5.length
    ? data.competitors_top5
    : (Array.isArray(data.competitors_top3) ? data.competitors_top3 : []);
  const competitors = rawComps
    .filter((c) => c && typeof c.rating === 'number' && typeof c.review_count === 'number')
    .map((c) => ({
      name: String(c.name || 'Competitor'),
      rating: c.rating,
      reviews: c.review_count,
    }));

  const benchmarkRating = (profile && profile.benchmarks && typeof profile.benchmarks.good_rating === 'number')
    ? profile.benchmarks.good_rating
    : 4.0;

  const seasonal = {
    peakMonth: (typeof data.peak_month === 'string') ? data.peak_month : null,
    hasColdWinter: !!data.has_cold_winter,
    hasHotSummer: !!data.has_hot_summer,
    peakTouristSeason: (typeof data.peak_tourist_season === 'string') ? data.peak_tourist_season : null,
  };

  const pagespeedScore = (typeof data.pagespeed === 'number') ? data.pagespeed
    : (typeof data.website_mobile_score === 'number') ? data.website_mobile_score : null;
  const pagespeed = {
    score: pagespeedScore,
    websiteExists: data.website_exists === true,
  };

  const income = {
    median: (typeof data.median_household_income === 'number') ? data.median_household_income : null,
  };
  const permits = {
    total: (typeof data.building_permits_total === 'number') ? data.building_permits_total : null,
    priorYearTotal: (typeof data.building_permits_prior_year_total === 'number') ? data.building_permits_prior_year_total : null,
    yoy: (typeof data.building_permits_yoy_change === 'number') ? data.building_permits_yoy_change : null,
    year: data.building_permits_year || null,
    priorYear: data.building_permits_prior_year || null,
  };

  const bundle = { you: { name: yourName, rating: yourRating, reviews: yourReviews }, competitors, benchmarkRating, seasonal, pagespeed, income, permits };

  const dataJson = JSON.stringify(bundle)
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '--\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `
<h2>Market Intelligence Charts</h2>

<style>
  .gim-charts { margin: 16px 0 32px; }
  .gim-charts .gim-chart-card {
    background: #FFFFFF;
    border: 1px solid #E2E8F0;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .gim-charts .gim-chart-title { font-size: 14px; font-weight: 500; color: #1E293B; margin: 0 0 4px; }
  .gim-charts .gim-chart-sub { font-size: 12px; color: #64748B; margin: 0 0 14px; }
  .gim-charts .gim-chart-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }
  .gim-charts .gim-chart-grid .gim-chart-card { margin-bottom: 0; }
  .gim-charts .gim-chart-wrap { position: relative; }
  .gim-charts .gim-chart-na {
    background: #F1F5F9; border-radius: 8px; padding: 30px 16px;
    color: #94A3B8; text-align: center; font-size: 13px;
  }
  .gim-charts .gim-pagespeed-center,
  .gim-charts .gim-income-center {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    text-align: center; pointer-events: none;
  }
  .gim-charts .gim-pagespeed-score { font-size: 36px; font-weight: 800; line-height: 1; }
  .gim-charts .gim-pagespeed-suffix { font-size: 11px; color: #64748B; margin-top: 4px; }
  .gim-charts .gim-income-amount { font-size: 22px; font-weight: 700; color: #0F1729; line-height: 1; }
  .gim-charts .gim-income-label { font-size: 11px; color: #64748B; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  .gim-charts .gim-income-legend {
    display: flex; flex-wrap: wrap; gap: 12px;
    font-size: 12px; color: #1E293B; margin-bottom: 12px;
  }
  .gim-charts .gim-income-legend .swatch {
    display: inline-block; width: 10px; height: 10px;
    border-radius: 2px; margin-right: 6px; vertical-align: middle;
  }
</style>

<div class="gim-charts">
  <div class="gim-chart-card">
    <div class="gim-chart-title">Competitive position</div>
    <div class="gim-chart-sub">Where you stand on rating vs. review volume</div>
    <div class="gim-chart-wrap" style="height:360px;"><canvas id="chart-matrix"></canvas></div>
  </div>

  <div class="gim-chart-grid">
    <div class="gim-chart-card">
      <div class="gim-chart-title">Rating comparison</div>
      <div class="gim-chart-sub">Star rating across nearby competitors</div>
      <div class="gim-chart-wrap" style="height:220px;"><canvas id="chart-ratings"></canvas></div>
    </div>
    <div class="gim-chart-card">
      <div class="gim-chart-title">Review volume</div>
      <div class="gim-chart-sub">Google review counts (sorted)</div>
      <div class="gim-chart-wrap" style="height:220px;"><canvas id="chart-reviews"></canvas></div>
    </div>
  </div>

  <div class="gim-chart-grid">
    <div class="gim-chart-card">
      <div class="gim-chart-title">Seasonal demand pattern</div>
      <div class="gim-chart-sub">Estimated monthly demand intensity</div>
      <div class="gim-chart-wrap" style="height:220px;"><canvas id="chart-seasonal"></canvas></div>
    </div>
    <div class="gim-chart-card">
      <div class="gim-chart-title">Website performance</div>
      <div class="gim-chart-sub">Google PageSpeed mobile score</div>
      <div class="gim-chart-wrap" style="height:200px;"><canvas id="chart-pagespeed"></canvas></div>
    </div>
  </div>

  <div class="gim-chart-grid">
    <div class="gim-chart-card">
      <div class="gim-chart-title">Local income distribution</div>
      <div class="gim-chart-sub">Estimated household income brackets</div>
      <div id="chart-income-legend" class="gim-income-legend"></div>
      <div class="gim-chart-wrap" style="height:200px;"><canvas id="chart-income"></canvas></div>
    </div>
    <div class="gim-chart-card">
      <div class="gim-chart-title">Building permits trend</div>
      <div class="gim-chart-sub">County construction activity (YoY)</div>
      <div class="gim-chart-wrap" style="height:220px;"><canvas id="chart-permits"></canvas></div>
    </div>
  </div>
</div>

<script>
(function () {
  if (typeof Chart === 'undefined') return;

  var D = ${dataJson};
  var BLUE = '#2563EB';
  var NAVY = '#0F1729';
  var EMERALD = '#10B981';
  var GRAY = '#94A3B8';
  var ORANGE = '#F59E0B';
  var RED = '#EF4444';

  function naBox(canvasId) {
    var c = document.getElementById(canvasId);
    if (!c) return;
    var w = c.parentElement;
    if (!w) return;
    w.innerHTML = '<div class="gim-chart-na">Data not available for this business type</div>';
  }
  function truncName(s) { return s.length > 28 ? s.slice(0, 27) + '…' : s; }

  // CHART 1 — matrix
  (function () {
    var canvas = document.getElementById('chart-matrix');
    if (!canvas) return;
    var youOk = D.you.rating != null && D.you.reviews != null;
    var compOk = Array.isArray(D.competitors) && D.competitors.length > 0;
    if (!youOk && !compOk) { naBox('chart-matrix'); return; }
    var points = [];
    if (youOk) points.push({ x: D.you.reviews, y: D.you.rating, r: 18, label: 'YOU ★', color: BLUE });
    if (compOk) D.competitors.forEach(function (c) {
      var first = String(c.name).split(/\\s+/)[0];
      points.push({ x: c.reviews, y: c.rating, r: 12, label: first, color: GRAY });
    });
    var xs = points.map(function (p) { return p.x; }).sort(function (a, b) { return a - b; });
    var medianReviews = xs.length
      ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2)
      : 50;
    var benchmark = (typeof D.benchmarkRating === 'number') ? D.benchmarkRating : 4.0;
    var quadrantBg = { id: 'quadrantBg', beforeDraw: function (chart) {
      var ctx = chart.ctx, sx = chart.scales.x, sy = chart.scales.y;
      if (!sx || !sy) return;
      var xMid = sx.getPixelForValue(medianReviews);
      var yMid = sy.getPixelForValue(benchmark);
      var L = sx.left, R = sx.right, T = sy.top, B = sy.bottom;
      ctx.save();
      ctx.fillStyle = 'rgba(16,185,129,0.05)'; ctx.fillRect(xMid, T, R - xMid, yMid - T);
      ctx.fillStyle = 'rgba(37,99,235,0.05)';  ctx.fillRect(L, T, xMid - L, yMid - T);
      ctx.fillStyle = 'rgba(245,158,11,0.05)'; ctx.fillRect(xMid, yMid, R - xMid, B - yMid);
      ctx.fillStyle = 'rgba(239,68,68,0.05)';  ctx.fillRect(L, yMid, xMid - L, B - yMid);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#CBD5E1';
      ctx.beginPath();
      ctx.moveTo(xMid, T); ctx.lineTo(xMid, B);
      ctx.moveTo(L, yMid); ctx.lineTo(R, yMid);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#94A3B8'; ctx.font = '11px Inter, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('Hidden gems',    L + 6,    T + 6);
      ctx.fillText('Market leaders', xMid + 6, T + 6);
      ctx.textBaseline = 'bottom';
      ctx.fillText('Needs work',  L + 6,    B - 6);
      ctx.fillText('High volume', xMid + 6, B - 6);
      ctx.restore();
    } };
    var bubbleLabels = { id: 'bubbleLabels', afterDraw: function (chart) {
      var ctx = chart.ctx, meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      ctx.save();
      ctx.font = '600 11px Inter, sans-serif'; ctx.textAlign = 'center';
      meta.data.forEach(function (el, i) {
        var p = points[i]; if (!p) return;
        ctx.fillStyle = p.color === BLUE ? '#FFFFFF' : '#1E293B';
        ctx.fillText(p.label, el.x, el.y + 4);
      });
      ctx.restore();
    } };
    new Chart(canvas, {
      type: 'bubble',
      data: { datasets: [{
        data: points,
        backgroundColor: points.map(function (p) { return p.color; }),
        borderColor: points.map(function (p) { return p.color === BLUE ? NAVY : '#64748B'; }),
        borderWidth: 1,
      }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) {
            var p = points[ctx.dataIndex];
            if (!p) return '';
            return p.label + ': ' + p.y.toFixed(1) + ' ★, ' + p.x + ' reviews';
          } } }
        },
        scales: {
          x: { title: { display: true, text: 'Number of reviews' }, beginAtZero: true, grace: '15%' },
          y: { title: { display: true, text: 'Rating' }, min: 1, max: 5, ticks: { stepSize: 0.5 } }
        }
      },
      plugins: [quadrantBg, bubbleLabels]
    });
  })();

  // CHART 2 — rating
  (function () {
    var canvas = document.getElementById('chart-ratings');
    if (!canvas) return;
    var entries = [];
    if (D.you.rating != null) entries.push({ name: D.you.name, rating: D.you.rating, you: true });
    if (Array.isArray(D.competitors)) D.competitors.forEach(function (c) {
      entries.push({ name: c.name, rating: c.rating, you: false });
    });
    if (entries.length === 0) { naBox('chart-ratings'); return; }
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: entries.map(function (e) { return truncName(e.name); }),
        datasets: [{
          data: entries.map(function (e) { return e.rating; }),
          backgroundColor: entries.map(function (e) { return e.you ? BLUE : GRAY; }),
          borderRadius: 4, borderSkipped: false,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { right: 32 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return c.parsed.x.toFixed(1) + ' ★'; } } }
        },
        scales: {
          x: { min: 0, max: 5, ticks: { stepSize: 1 } },
          y: { ticks: { font: { size: 11 } } }
        },
        animation: { onComplete: function () {
          var c = this, ctx = c.ctx;
          ctx.font = '600 11px Inter, sans-serif'; ctx.fillStyle = '#0F1729';
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          c.getDatasetMeta(0).data.forEach(function (b, i) {
            ctx.fillText(entries[i].rating.toFixed(1), b.x + 6, b.y);
          });
        } }
      }
    });
  })();

  // CHART 3 — reviews
  (function () {
    var canvas = document.getElementById('chart-reviews');
    if (!canvas) return;
    var entries = [];
    if (D.you.reviews != null) entries.push({ name: D.you.name, reviews: D.you.reviews, you: true });
    if (Array.isArray(D.competitors)) D.competitors.forEach(function (c) {
      entries.push({ name: c.name, reviews: c.reviews, you: false });
    });
    if (entries.length === 0) { naBox('chart-reviews'); return; }
    entries.sort(function (a, b) { return b.reviews - a.reviews; });
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: entries.map(function (e) { return truncName(e.name); }),
        datasets: [{
          data: entries.map(function (e) { return e.reviews; }),
          backgroundColor: entries.map(function (e) { return e.you ? BLUE : GRAY; }),
          borderRadius: 4, borderSkipped: false,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { right: 48 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return c.parsed.x.toLocaleString() + ' reviews'; } } }
        },
        scales: { x: { beginAtZero: true }, y: { ticks: { font: { size: 11 } } } },
        animation: { onComplete: function () {
          var c = this, ctx = c.ctx;
          ctx.font = '600 11px Inter, sans-serif'; ctx.fillStyle = '#0F1729';
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          c.getDatasetMeta(0).data.forEach(function (b, i) {
            ctx.fillText(entries[i].reviews.toLocaleString(), b.x + 6, b.y);
          });
        } }
      }
    });
  })();

  // CHART 4 — seasonal
  (function () {
    var canvas = document.getElementById('chart-seasonal');
    if (!canvas) return;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var s = D.seasonal || {};
    var hasSignal = !!(s.peakMonth || s.hasColdWinter || s.hasHotSummer || s.peakTouristSeason);
    if (!hasSignal) { naBox('chart-seasonal'); return; }
    var vals = [2,2,2,2,2,2,2,2,2,2,2,2];
    if (s.hasColdWinter) { vals[0] = 1; vals[1] = 1; vals[11] = 1; }
    var monthIdx = -1;
    if (s.peakMonth) {
      var pk = String(s.peakMonth).slice(0, 3).toLowerCase();
      monthIdx = months.findIndex(function (m) { return m.toLowerCase() === pk; });
    }
    if (monthIdx >= 0) {
      vals[monthIdx] = 4;
      vals[(monthIdx + 11) % 12] = Math.max(vals[(monthIdx + 11) % 12], 3);
      vals[(monthIdx + 1)  % 12] = Math.max(vals[(monthIdx + 1)  % 12], 3);
    }
    if (s.hasHotSummer) {
      vals[5] = Math.max(vals[5], 3);
      vals[6] = Math.max(vals[6], 3);
      vals[7] = Math.max(vals[7], 3);
    }
    var pointColors = vals.map(function (v) { return v >= 3 ? EMERALD : GRAY; });
    new Chart(canvas, {
      type: 'line',
      data: {
        labels: months,
        datasets: [{
          data: vals,
          borderColor: BLUE,
          backgroundColor: 'rgba(37,99,235,0.08)',
          fill: true, tension: 0.4,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors,
          pointRadius: 5, pointHoverRadius: 7,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return ['Low','Medium','High','Peak'][c.parsed.y - 1] || ''; } } }
        },
        scales: {
          y: { min: 0.5, max: 4.5, ticks: { stepSize: 1, callback: function (v) { return ['','Low','Medium','High','Peak'][v] || ''; } } },
          x: { ticks: { font: { size: 11 } } }
        }
      }
    });
  })();

  // CHART 5 — pagespeed
  (function () {
    var canvas = document.getElementById('chart-pagespeed');
    if (!canvas) return;
    var p = D.pagespeed || {};
    if (!p.websiteExists || typeof p.score !== 'number') { naBox('chart-pagespeed'); return; }
    var s = Math.max(0, Math.min(100, p.score));
    var col = s >= 90 ? EMERALD : s >= 50 ? ORANGE : RED;
    var wrap = canvas.parentElement;
    var center = document.createElement('div');
    center.className = 'gim-pagespeed-center';
    center.innerHTML = '<div class="gim-pagespeed-score" style="color:' + col + '">' + s + '</div><div class="gim-pagespeed-suffix">out of 100</div>';
    wrap.appendChild(center);
    new Chart(canvas, {
      type: 'doughnut',
      data: { datasets: [{ data: [s, 100 - s], backgroundColor: [col, 'rgba(100,116,139,0.1)'], borderWidth: 0 }] },
      options: { cutout: '75%', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });
  })();

  // CHART 6 — income
  (function () {
    var canvas = document.getElementById('chart-income');
    if (!canvas) return;
    var med = (D.income && typeof D.income.median === 'number') ? D.income.median : null;
    if (med == null) { naBox('chart-income'); return; }
    var brackets;
    if (med < 40000)       brackets = [40, 35, 18, 7];
    else if (med < 60000)  brackets = [25, 40, 25, 10];
    else if (med < 90000)  brackets = [15, 35, 35, 15];
    else                   brackets = [8, 25, 42, 25];
    var labels = ['Under $35K', '$35K–$75K', '$75K–$150K', 'Over $150K'];
    var colors = ['#185FA5', '#378ADD', '#85B7EB', '#B5D4F4'];
    var legend = document.getElementById('chart-income-legend');
    if (legend) {
      legend.innerHTML = labels.map(function (lab, i) {
        return '<span><span class="swatch" style="background:' + colors[i] + '"></span>' + lab + ' (' + brackets[i] + '%)</span>';
      }).join('');
    }
    var wrap = canvas.parentElement;
    var center = document.createElement('div');
    center.className = 'gim-income-center';
    var amount = med >= 1000 ? '$' + Math.round(med / 1000) + 'K' : '$' + med;
    center.innerHTML = '<div class="gim-income-amount">' + amount + '</div><div class="gim-income-label">Median</div>';
    wrap.appendChild(center);
    new Chart(canvas, {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: brackets, backgroundColor: colors, borderWidth: 0 }] },
      options: { cutout: '65%', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return c.label + ': ' + c.parsed + '%'; } } } } }
    });
  })();

  // CHART 7 — permits
  (function () {
    var canvas = document.getElementById('chart-permits');
    if (!canvas) return;
    var perm = D.permits || {};
    if (typeof perm.total !== 'number') { naBox('chart-permits'); return; }
    var labels = [], values = [], colors = [];
    var year = perm.year || new Date().getFullYear();
    if (typeof perm.priorYearTotal === 'number') {
      labels.push(String(perm.priorYear || (year - 1)));
      values.push(perm.priorYearTotal);
      colors.push(GRAY);
    }
    labels.push(String(year));
    values.push(perm.total);
    colors.push(EMERALD);
    var yoy = (typeof perm.yoy === 'number') ? perm.yoy : null;
    new Chart(canvas, {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 4, borderSkipped: false }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) {
            var n = c.parsed.y.toLocaleString();
            if (yoy != null && c.dataIndex === values.length - 1) {
              var sign = yoy >= 0 ? '+' : '';
              return n + ' permits (' + sign + yoy.toFixed(0) + '% YoY)';
            }
            return n + ' permits';
          } } }
        },
        scales: { y: { beginAtZero: true } }
      }
    });
  })();
})();
</script>
`;
}

// ────────────────────────────────────────────────────────────────────
// Data fetch pipeline
// ────────────────────────────────────────────────────────────────────
async function main() {
  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) throw new Error('GOOGLE_PLACES_API_KEY not set');

  const query = 'Bonanza Market, 321 Broad St, Nevada City, CA 95959, USA';
  console.log('[preview] resolving:', query);

  // Step 1 — findPlace
  const placeStub = await places.findPlace(query, API_KEY);
  if (!placeStub) throw new Error('Bonanza Market not found on Google Places');
  console.log('[preview] place_id:', placeStub.place_id, '| name:', placeStub.name);

  // Step 2 — getDetails + toInputFields
  const detail = await places.getDetails(placeStub.place_id, API_KEY);
  const data = places.toInputFields(detail);
  data.business_name = data.name;
  data.profile_id = 'retail.grocery';
  data.is_chain = false;
  data.chain_name = null;
  data.sector_naics2 = '44';
  console.log('[preview] rating:', data.google_rating, '| reviews:', data.google_review_count,
              '| website:', data.website || '(none)');

  // Step 3 — ZIP + county FIPS
  const formatted = data.formatted_address || query;
  const zip = dataFetchers.extractZipFromAddress(formatted);
  const cf = await dataFetchers.fetchCountyFIPSByCity('Nevada City', 'CA', data.latitude, data.longitude);
  const countyFIPS = (cf && cf.county_fips) || null;
  if (cf) { data.county_fips = cf.county_fips; data.county_name = cf.county_name; }
  data.city = 'Nevada City'; data.state = 'CA';
  console.log('[preview] zip:', zip, '| county:', (cf && cf.county_name) || '(unknown)',
              '(' + (countyFIPS || 'no FIPS') + ')');

  // Step 4 — Parallel fetch fan-out (matches /classify for NAICS 445110)
  console.log('[preview] firing parallel data fetchers (NO Claude)...');
  const nearbyType = places.pickNearbySearchType(data.google_types) || 'supermarket';
  const promiseArr = [
    places.fetchNearbyCompetitors({
      placeId: placeStub.place_id,
      lat: data.latitude, lng: data.longitude,
      type: nearbyType,
      apiKey: API_KEY,
      city: 'Nevada City', state: 'CA',
      subjectName: data.name, businessName: data.name,
      naics6: '445110', naics2: '44',
      googleTypes: data.google_types,
      population: null,
    }),
    dataFetchers.fetchCensusByZip(zip, 'Nevada City', 'CA', countyFIPS),
    dataFetchers.checkWebsiteExists(data.website),
    dataFetchers.fetchWeather(data.latitude, data.longitude),
    dataFetchers.fetchLocationSignals(data.latitude, data.longitude),
    countyFIPS ? dataFetchers.fetchBuildingPermits(countyFIPS) : Promise.resolve(null),
    dataFetchers.fetchUpcomingEvents('Nevada City', 'CA'),
    dataFetchers.fetchNearbyVenues(data.latitude, data.longitude),
    dataFetchers.fetchTripAdvisor(data.name, formatted),
    dataFetchers.fetchBLSEmployment('44'),
    dataFetchers.fetchUSDAERS('CA'),
    dataFetchers.fetchFoodData('grocery store'),
    dataFetchers.fetchOpenFoodFacts('grocery'),
    dataFetchers.fetchDatamuse(data.name),
    dataFetchers.fetchNearbyParks('CA'),
    dataFetchers.fetchNOAAClimate(data.latitude, data.longitude),
  ];
  const tagList = [
    'competitors', 'census', 'website-exists', 'weather', 'location-signals',
    'permits', 'events', 'venues', 'tripadvisor', 'bls', 'ers', 'fooddata',
    'openfoodfacts', 'datamuse', 'nps-parks', 'noaa-climate',
  ];
  const t0 = Date.now();
  const results = await Promise.allSettled(promiseArr);
  console.log('[preview] fan-out done in', (Date.now() - t0) + 'ms');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const v = r.value;
      const shape = v == null ? '(null)'
        : Array.isArray(v) ? '[' + v.length + ' items]'
        : typeof v === 'object' ? '{' + Object.keys(v).slice(0, 4).join(',') + (Object.keys(v).length > 4 ? ',…' : '') + '}'
        : String(v);
      console.log('  ✓', tagList[i].padEnd(20), shape);
    } else {
      console.log('  ✗', tagList[i].padEnd(20), 'ERR:', r.reason && r.reason.message);
    }
  }

  // Step 5 — Unpack onto data (mirrors /classify destructuring)
  const [comp, census, web, weather, locsig, permits, events, venues, ta,
         bls, ers, food, off, datamuse, parks, noaa] = results;

  if (comp.status === 'fulfilled' && comp.value) {
    data.competitor_count = comp.value.competitor_count;
    data.competitor_median_rating = comp.value.competitor_median_rating;
    data.competitor_median_review_count = comp.value.competitor_median_review_count;
    data.competitors_top3 = comp.value.competitors_top3 || [];
    data.competitors_top5 = comp.value.competitors_top5 || [];
    data.competitors_top7 = comp.value.competitors_top7 || [];
    data.search_radius_miles = comp.value.search_radius_miles;
  }
  if (census.status === 'fulfilled' && census.value) {
    data.median_household_income = census.value.median_household_income;
    data.total_population = census.value.total_population;
    data.average_household_size = census.value.average_household_size;
    data.census_housing = census.value.census_housing;
  }
  if (web.status === 'fulfilled') data.website_exists = web.value;
  if (weather.status === 'fulfilled' && weather.value) {
    data.peak_month = weather.value.peak_month;
    data.peak_month_avg_f = weather.value.peak_month_avg_f;
    data.has_cold_winter = weather.value.has_cold_winter;
    data.has_hot_summer = weather.value.has_hot_summer;
    data.peak_tourist_season = weather.value.peak_tourist_season;
  }
  if (locsig.status === 'fulfilled' && locsig.value) {
    data.anchor_tenants = locsig.value.anchor_tenants;
    data.anchor_tenant_count = locsig.value.anchor_tenant_count;
    data.has_transit_nearby = locsig.value.has_transit_nearby;
    data.nearest_transit_meters = locsig.value.nearest_transit_meters;
  }
  if (permits.status === 'fulfilled' && permits.value) {
    const p = permits.value;
    data.building_permits = p;
    data.building_permits_total = p.building_permits_total;
    data.building_permits_year = p.building_permits_year;
    data.building_permits_prior_year = p.building_permits_prior_year;
    data.building_permits_prior_year_total = p.building_permits_prior_year_total;
    data.building_permits_yoy_change = p.building_permits_yoy_change;
  }
  if (events.status === 'fulfilled') data.upcoming_events = events.value || [];
  if (venues.status === 'fulfilled') data.nearby_venues = venues.value || [];
  if (ta.status === 'fulfilled' && ta.value) Object.assign(data, ta.value);
  if (bls.status === 'fulfilled' && bls.value) {
    data.bls_employment_level = bls.value.employment_level;
    data.bls_employment_year = bls.value.employment_year;
  }
  if (ers.status === 'fulfilled' && ers.value) data.usda_ers = ers.value;
  if (food.status === 'fulfilled') data.fooddata = food.value;
  if (off.status === 'fulfilled') data.openfoodfacts = off.value;
  if (datamuse.status === 'fulfilled') data.datamuse_words = datamuse.value;
  if (parks.status === 'fulfilled') data.nearby_parks = parks.value;
  if (noaa.status === 'fulfilled' && noaa.value) {
    data.noaa_station = noaa.value.station_name;
    data.noaa_normals = noaa.value.normals;
  }

  // Step 6 — PageSpeed (only if website exists)
  if (data.website_exists === true && data.website) {
    console.log('[preview] firing PageSpeed for', data.website);
    try {
      const ps = await dataFetchers.fetchPageSpeed(data.website);
      if (ps) {
        data.pagespeed = ps.mobile_score;
        data.website_mobile_score = ps.mobile_score;
        data.load_time_seconds = ps.load_time_seconds;
        data.lcp_seconds = ps.lcp_seconds;
        data.is_mobile_friendly = ps.is_mobile_friendly;
        console.log('  ✓ pagespeed:', ps.mobile_score);
      } else {
        console.log('  ✗ pagespeed: returned null');
      }
    } catch (e) {
      console.log('  ✗ pagespeed err:', e.message);
    }
  } else {
    console.log('[preview] skipping PageSpeed (no website / website_exists !== true)');
  }

  // Step 7 — Profile stub for benchmark (no Claude → no full profile resolve)
  const profile = {
    id: 'retail.grocery',
    benchmarks: { good_rating: 4.2, good_review_count: 50 },
  };

  // Step 8 — Render charts
  console.log('[preview] rendering charts...');
  const chartsHtml = renderMarketCharts(data, profile, data.name);

  // Step 9 — Wrap with Chart.js CDN + page chrome + title
  const out = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chart Preview — Bonanza Market</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
  <style>
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #F8FAFC; color: #1E293B; margin: 0; padding: 32px 16px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
    .wrap { max-width: 820px; margin: 0 auto; }
    h1 { font-size: 28px; font-weight: 800; color: #0F1729; letter-spacing: -0.02em; margin: 0 0 4px; }
    .subtitle { font-size: 14px; color: #64748B; margin: 0 0 18px; }
    .data-summary { background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 10px; padding: 14px 18px; margin-bottom: 24px; font-size: 13px; color: #1E293B; }
    .data-summary strong { color: #0F1729; }
    .data-summary .row { display: flex; gap: 16px; flex-wrap: wrap; }
    .data-summary .row > span { white-space: nowrap; }
  </style>
</head>
<body>
<div class="wrap">
  <h1>Chart Preview — Bonanza Market</h1>
  <p class="subtitle">${escapeHtml(data.formatted_address || '')}</p>
  <div class="data-summary">
    <div class="row">
      <span><strong>Rating:</strong> ${data.google_rating != null ? data.google_rating + ' ★' : '—'}</span>
      <span><strong>Reviews:</strong> ${data.google_review_count != null ? data.google_review_count : '—'}</span>
      <span><strong>Competitors:</strong> ${(data.competitors_top5 || []).length}</span>
      <span><strong>County:</strong> ${escapeHtml(data.county_name || '—')}</span>
      <span><strong>Median income:</strong> ${data.median_household_income != null ? '$' + data.median_household_income.toLocaleString() : '—'}</span>
      <span><strong>Permits (curr/prior):</strong> ${data.building_permits_total != null ? data.building_permits_total : '—'} / ${data.building_permits_prior_year_total != null ? data.building_permits_prior_year_total : '—'}</span>
      <span><strong>PageSpeed:</strong> ${data.pagespeed != null ? data.pagespeed : '—'}</span>
    </div>
  </div>
  ${chartsHtml}
</div>
</body>
</html>`;

  const outPath = path.join(__dirname, 'public', 'chart_preview.html');
  fs.writeFileSync(outPath, out);
  console.log('[preview] written:', outPath, '(' + out.length + ' bytes)');

  // Also dump the data bundle for inspection
  const dataPath = path.join(__dirname, '_bonanza_data.json');
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  console.log('[preview] saved data bundle:', dataPath);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

main().catch((err) => {
  console.error('FATAL:', err && err.message);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});

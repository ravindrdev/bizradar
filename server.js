// override:true so .env wins over an empty/stale ANTHROPIC_API_KEY inherited
// from the parent shell. Without this, dotenv silently skips the key when the
// parent process exports it as an empty string.
require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const authRoutes = require('./authRoutes');
const { requireAuth } = require('./authMiddleware');
const pool = require('./db');

const layer0 = require('./server_layer0');
const naicsRouter = require('./naicsRouter');
const profileResolver = require('./profileResolver');
const placesTypeMapper = require('./placesTypeMapper');
const places = require('./googlePlaces');
const dataFetchers = require('./dataFetchers');
const { scoreRecommendations, evaluateRedFlags } = require('./ranker');
const triggerDsl = require('./triggerDsl');
const claudeEnricher = require('./claudeEnricher');
// marketScorer is required by claudeMarketAnalyst.js, not by server.js
// directly — the prior import here was dead code.
const claudeMarketAnalyst = require('./claudeMarketAnalyst');
const { verifyQuotes } = require('./provenance');
const studies = require('./verifiedStudies.json');
const sectorProblems = require('./sectorCommonProblems.json');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
// DATABASE_URL is required for Postgres-backed features (users, reports,
// payments). The rest of the app still boots without it — the warning
// surfaces the missing config without crashing the process.
if (!process.env.DATABASE_URL) {
  console.warn(
    '[startup] DATABASE_URL is not set — database features (users, reports, payments) will be unavailable'
  );
}

// Audit fix X1 — fail-fast on missing JWT_SECRET. Without this guard,
// every signup / login throws "secretOrPrivateKey must have a value"
// at jwt.sign() time with a cryptic error and the process keeps
// running healthy. Better to crash loudly at boot.
if (!process.env.JWT_SECRET) {
  console.error(
    '[startup] FATAL: JWT_SECRET is not set. ' +
    'Set it in .env / Railway env vars before starting the server.'
  );
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Audit fix S4 / X2 — rate limiting ────────────────────────────────
// authLimiter:    /auth/* — 20 attempts per IP per 15 min. Throttles
//                 login brute-force, OTP brute-force, signup spam,
//                 forgot-password email bombs, and /auth/cancel-signup
//                 abuse (AR1).
// reportLimiter:  /classify + /market-analysis — 10 reports per IP per
//                 hour. Bounds Claude + Google Places cost burn even
//                 from a leaked cookie.
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many auth attempts. Try again in 15 minutes.' },
});
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many report generations. Try again in an hour.' },
});

// User auth router — handles signup, login, OTP verification, forgot
// password, and /auth/me. JWT cookie 'token' is set on successful
// signup or login. Routes that need authentication wrap their handler
// with requireAuth (imported above from authMiddleware.js).
app.use('/auth', authLimiter, authRoutes);

// ─────────────────────────────────────────────────────────────────────
// GET /api/dashboard — JSON feed for the user's dashboard page.
// Auth-protected: requireAuth populates req.user from the JWT cookie,
// so user identity comes "for free" without a second users-table
// lookup. Only the reports query actually hits Postgres on this route.
// Reports are returned newest-first so the dashboard can render them
// without re-sorting client-side.
// ─────────────────────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const { id, name, email, created_at } = req.user;
    const reportsResult = await pool.query(
      `SELECT id, business_name, address, naics_code, created_at
       FROM reports
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [id]
    );
    res.json({
      user: { id, name, email, created_at },
      reports: reportsResult.rows,
      total_reports: reportsResult.rows.length,
    });
  } catch (err) {
    console.error('[dashboard] query failed:', err.message);
    res.status(500).json({ error: 'Could not load dashboard data' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /report/:id — replay a previously generated report as HTML.
//
// Auth-protected. The WHERE clause ALSO scopes by user_id, so a logged-
// in user attempting to read someone else's report by guessing the ID
// gets the same "not found" response as a truly nonexistent ID — no
// information leak about which IDs exist.
//
// The saved report_json carries a _type discriminator written by the
// /classify and /market-analysis save paths above:
//   _type === 'classify'         → renderReport(ctx) — same shape and
//                                  same studies attachment used in the
//                                  live /classify flow.
//   _type === 'market_analysis'  → renderMarketReport(result) — same
//                                  call site used in the live
//                                  /market-analysis flow.
// Anything else is treated as a legacy 'classify' record (defensive
// default for any rows written before the discriminator was added).
//
// The response wraps the rendered report HTML with a sticky GrowthIM
// navbar (REPORT_VIEW_NAVBAR below). That navbar gives the user a
// deterministic "My Dashboard" link on every report page so they
// never need to use the browser Back button — Back across a
// bfcache-disabled page can briefly show a stale state on the
// dashboard and feel like a logout, even though the JWT cookie is
// fully intact. Clicking "My Dashboard" does a fresh top-level
// navigation that re-runs the dashboard's /auth/me check with the
// still-valid cookie. The Logout button is the ONLY mechanism in
// the report-view flow that touches the cookie — verified by grep
// for clearCookie / Set-Cookie across the report-view path.
// ─────────────────────────────────────────────────────────────────────
const REPORT_VIEW_NAVBAR = `
<style>
  /* Reset PAGE_OPEN's body top-padding so the sticky nav attaches
     flush to the viewport top; negative horizontal margin compensates
     for the body's 16px inline padding so the nav spans full width. */
  body { padding-top: 0 !important; }
  .gim-report-nav {
    position: sticky;
    top: 0;
    background: #0F1729;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    z-index: 100;
    margin: 0 -16px 24px;
  }
  .gim-report-nav-inner {
    max-width: 820px;
    margin: 0 auto;
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .gim-report-nav-actions { display: flex; align-items: center; gap: 10px; }
  .gim-nav-btn {
    background: transparent;
    color: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.24);
    padding: 8px 16px;
    border-radius: 8px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    transition: background 0.12s, border-color 0.12s;
    white-space: nowrap;
  }
  .gim-nav-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.45);
  }
</style>
<header class="gim-report-nav">
  <div class="gim-report-nav-inner">
    <a href="/dashboard" style="text-decoration:none;">
      <div class="logo">
        <span style="color:#FFFFFF;font-size:22px;font-weight:700;letter-spacing:-0.5px;">
          Growth<span style="color:#2563EB">IM</span>
        </span>
        <div style="width:140px;height:2px;background:#2563EB;opacity:0.4;margin-top:2px;"></div>
        <div style="font-size:9px;font-weight:600;color:#64748B;letter-spacing:0.12em;margin-top:2px;">
          GROWTH INTELLIGENCE MACHINE
        </div>
      </div>
    </a>
    <div class="gim-report-nav-actions">
      <a href="/dashboard" class="gim-nav-btn">My Dashboard</a>
      <button type="button" class="gim-nav-btn" onclick="fetch('/auth/logout',{method:'POST',credentials:'same-origin'}).finally(function(){window.location.href='/login.html';});">Logout</button>
    </div>
  </div>
</header>
`;

app.get('/report/:id', requireAuth, async (req, res) => {
  try {
    const idNum = parseInt(req.params.id, 10);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return res.status(404).send('Report not found');
    }
    const r = await pool.query(
      `SELECT id, user_id, business_name, address, naics_code, report_json, created_at
       FROM reports
       WHERE id = $1 AND user_id = $2`,
      [idNum, req.user.id]
    );
    if (!r.rowCount) {
      return res.status(404).send('Report not found');
    }
    const row = r.rows[0];

    let payload;
    try {
      payload = typeof row.report_json === 'string'
        ? JSON.parse(row.report_json)
        : row.report_json;
    } catch (e) {
      console.error('[report/:id] JSON parse failed for report id=' + idNum + ':', e.message);
      return res.status(500).send('Saved report is corrupted');
    }

    let html;
    if (payload && payload._type === 'market_analysis') {
      // The market-analysis renderer reads the same fields it would
      // have read live (top10, deep_dive, raw, _quote_verification,
      // etc.) — they all serialize through JSON.stringify cleanly.
      html = renderMarketReport(payload);
    } else {
      // Default to the classify renderer. `studies` is loaded fresh
      // from verifiedStudies.json at startup so we don't persist it;
      // re-attach the current array here. If a study was retired
      // between save and replay, citationLine() in renderReport
      // already handles "(not found)" gracefully.
      html = renderReport({
        input: payload && payload.input,
        layer0Result: payload && payload.layer0Result,
        profile: payload && payload.profile,
        data: payload && payload.data,
        redFlags: (payload && payload.redFlags) || [],
        strengths: (payload && payload.strengths) || [],
        ranked: (payload && payload.ranked) || { allTriggered: [], top10: [] },
        enriched: payload && payload.enriched,
        studies: studies.studies,
      });
    }
    // Inject the GrowthIM sticky navbar right after <body> so the
    // user always has logo + My Dashboard + Logout above the
    // restored report. Single string replace; PAGE_OPEN uses a
    // bare `<body>` open tag with no attributes, so the match is
    // unambiguous. Falls back gracefully (no-op) if the body tag
    // is somehow missing.
    html = html.replace('<body>', '<body>' + REPORT_VIEW_NAVBAR);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[report/:id] failed:', err.message);
    res.status(500).send('Could not load report');
  }
});

// GET / — public marketing landing page (GrowthIM brand).
// Plain file send; no API-key injection needed because the landing
// page never calls Google Maps.
app.get('/', (req, res) => {
  try {
    const html = fs.readFileSync(
      path.join(__dirname, 'public', 'landing.html'),
      'utf8'
    );
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('[landing] failed to render:', e.message);
    res.status(500).send('Internal error');
  }
});

// GET /app — the actual BizRadar report-generation UI (index.html).
// Audit fix S8 — soft auth check: if there's no JWT cookie, bounce to
// /login.html so users don't fill out the form only to hit a 401 on
// /classify submit. requireAuth would 401 (no UX redirect) so we
// inspect the cookie directly here.
app.get('/app', (req, res) => {
  if (!req.cookies || !req.cookies.token) {
    return res.redirect(
      '/login.html?msg=' + encodeURIComponent('Please login to generate a report.')
    );
  }
  try {
    const html = fs.readFileSync(
      path.join(__dirname, 'public', 'index.html'),
      'utf8'
    );
    const injected = html.replace(
      /%%GOOGLE_API_KEY%%/g,
      process.env.GOOGLE_PLACES_API_KEY || ''
    );
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  } catch (e) {
    console.error('[app] failed to render:', e.message);
    res.status(500).send('Internal error');
  }
});

// GET /dashboard — extensionless alias for /dashboard.html so the
// post-login redirect (and any "/dashboard" link in copy/emails)
// resolves cleanly instead of returning "Cannot GET /dashboard".
// The HTML's own JS fetches /auth/me on load and bounces to
// /login.html when no JWT cookie is present, so this route stays
// public — the auth check happens client-side after the file loads.
app.get('/dashboard', (req, res) => {
  try {
    const html = fs.readFileSync(
      path.join(__dirname, 'public', 'dashboard.html'),
      'utf8'
    );
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('[dashboard] failed to render:', e.message);
    res.status(500).send('Internal error');
  }
});

// Extensionless aliases for the policy / contact pages so the footer
// links (Privacy Policy → /privacy, Terms of Service → /terms,
// Refund Policy → /refund, Contact → /contact) resolve cleanly
// without the .html suffix. Each is a thin file-serve mirroring the
// /dashboard pattern above. Registered before express.static so the
// extensionless URL is what gets cached / shared.
function serveStaticPage(filename, logTag) {
  return (req, res) => {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', filename), 'utf8');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) {
      console.error(`[${logTag}] failed to render:`, e.message);
      res.status(500).send('Internal error');
    }
  };
}
app.get('/privacy',        serveStaticPage('privacy.html',        'privacy'));
app.get('/terms',          serveStaticPage('terms.html',          'terms'));
app.get('/refund',         serveStaticPage('refund.html',         'refund'));
app.get('/contact',        serveStaticPage('contact.html',        'contact'));
app.get('/chart-preview',  serveStaticPage('chart_preview.html',  'chart-preview'));

app.use(express.static(path.join(__dirname, 'public')));

// ── Server-Sent Events progress stream ─────────────────────────────
// Routes that take >1s emit progress events via sendProgress(sessionId).
// The frontend opens GET /progress/:sessionId BEFORE submitting the
// form so the live stream is connected by the time the POST starts.
// Audit fix S2 / S3 — cap progressClients and gate behind requireAuth
// so an unauthenticated attacker can't probe other users' session IDs
// and can't pile up SSE connections to exhaust memory.
const MAX_PROGRESS_CLIENTS = 500;
const progressClients = new Map();
function sendProgress(sessionId, data) {
  if (!sessionId) return;
  const client = progressClients.get(sessionId);
  if (!client || client.writableEnded) return;
  try {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* connection closed mid-write */ }
}
app.get('/progress/:sessionId', requireAuth, (req, res) => {
  if (progressClients.size >= MAX_PROGRESS_CLIENTS) {
    res.status(503).end();
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Initial "connected" tick so the client can confirm the channel is live.
  res.write('data: {"step":0,"total":0,"message":"connected","pct":0}\n\n');
  progressClients.set(req.params.sessionId, res);
  // 15s heartbeat so proxies don't kill an idle stream.
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { /* socket gone */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    progressClients.delete(req.params.sessionId);
  });
});

layer0.loadRegistries();
naicsRouter.load();
profileResolver.load();

// BUG 29 — Startup validation: every study_id referenced by a profile
// recommendation MUST exist in verifiedStudies.json. Catches typos and
// dangling references before they cause silent rendering failures in
// the citation linter (which only warn-logs at request time). Runs once
// at boot and prints a summary line; if any unknown IDs are found, the
// missing entries are logged with the offending profile.recommendation
// pair so the fix is obvious from the log alone.
(function validateStudyIds() {
  try {
    const knownIds = new Set(
      (studies && Array.isArray(studies.studies) ? studies.studies : []).map((s) => s.id)
    );
    const allProfiles = profileResolver.getAllProfiles() || {};
    let totalRefs = 0;
    let missingCount = 0;
    const missing = [];
    for (const [profileId, profile] of Object.entries(allProfiles)) {
      const recs = Array.isArray(profile && profile.recommendations) ? profile.recommendations : [];
      for (const rec of recs) {
        const ids = Array.isArray(rec && rec.study_ids) ? rec.study_ids : [];
        for (const sid of ids) {
          totalRefs += 1;
          if (!knownIds.has(sid)) {
            missingCount += 1;
            missing.push({ profile: profileId, rec: rec.id || '(unnamed)', sid });
          }
        }
      }
    }
    if (missingCount === 0) {
      console.log(
        '[startup] study_id validation OK — ' + totalRefs + ' references across ' +
        Object.keys(allProfiles).length + ' profiles, all resolve to verifiedStudies.json'
      );
    } else {
      console.error(
        '[startup] study_id validation FAILED — ' + missingCount + ' of ' + totalRefs +
        ' references point to unknown studies:'
      );
      for (const m of missing) {
        console.error('  - profile=' + m.profile + ' rec=' + m.rec + ' study_id=' + m.sid);
      }
    }
  } catch (e) {
    console.error('[startup] study_id validation crashed:', e.message);
  }
})();

// ─────────────────────────────────────────────────────────────────────
// Async report job pattern — keeps Railway's 5-minute HTTP proxy
// timeout from killing /classify and /market-analysis mid-request.
//
// Browser POSTs to /classify (or /market-analysis). The route
// synchronously initialises a job entry, replies { ok, jobId } in
// <1 s, and runs the actual generation work inside setImmediate().
// The browser polls GET /report-status/:jobId every few seconds,
// and redirects to /report/:id once status === 'ready'.
//
// jobStore is in-memory only — survives within the process, evicted
// after 30 minutes by the cleanup interval below. If the process
// restarts mid-flight, the browser's poll surfaces 'not_found' and
// the UI shows a "session expired" message. The Postgres row (if
// the save ran) still appears in /dashboard either way.
// ─────────────────────────────────────────────────────────────────────
const jobStore = new Map();

function setJob(sessionId, patch) {
  if (!sessionId) return;
  jobStore.set(sessionId, {
    status: 'processing',
    reportId: null,
    error: null,
    createdAt: Date.now(),
    ...(jobStore.get(sessionId) || {}),
    ...patch,
  });
}

function failJob(sessionId, message) {
  if (!sessionId) return;
  setJob(sessionId, {
    status: 'error',
    reportId: null,
    error: String(message || 'Report generation failed').slice(0, 1000),
  });
  // Surface on the live progress channel too so the page's terminal
  // log shows the failure immediately rather than waiting up to 3 s
  // for the next /report-status poll.
  try {
    sendProgress(sessionId, {
      error: true,
      message: String(message || '').slice(0, 240),
    });
  } catch (_) { /* progress stream may already be closed */ }
}

function completeJob(sessionId, reportId) {
  if (!sessionId) return;
  setJob(sessionId, {
    status: 'ready',
    reportId: reportId == null ? null : reportId,
    error: null,
  });
}

// Cleanup loop — every 30 minutes evict job entries older than 30
// minutes. `unref()` so the timer never blocks a clean process exit.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobStore) {
    if (job && job.createdAt < cutoff) jobStore.delete(id);
  }
}, 30 * 60 * 1000).unref();

// GET /report-status/:jobId — polled by the browser every 3 s after
// it submits /classify or /market-analysis. Defensive cross-user
// check: the job entry stores the user that started it, and we
// return 'not_found' if a different user polls — sessionIds are
// random client tokens but if one leaks we don't want a second
// logged-in user to be able to read the first one's status.
app.get('/report-status/:jobId', requireAuth, (req, res) => {
  const job = jobStore.get(String(req.params.jobId || ''));
  if (!job) return res.json({ status: 'not_found' });
  if (job.userId != null && job.userId !== req.user.id) {
    return res.json({ status: 'not_found' });
  }
  return res.json({
    status: job.status,
    reportId: job.reportId,
    error: job.error,
  });
});

app.post('/classify', reportLimiter, requireAuth, async (req, res) => {
  const input = (req.body.query || '').trim();
  // Optional — set by the landing-page autocomplete when the user picks
  // a suggestion from the dropdown. Lets us skip the 7-step findPlace
  // resolver and use Google's exact place_id directly. Empty string
  // when the user typed free text without selecting a suggestion;
  // falls back to findPlace in that case (backwards compatible).
  const clientPlaceId = (req.body.place_id || '').trim();
  const sessionId = (req.body.sessionId || '').toString();
  const userId = req.user.id;

  // ── Async job init (Railway 5-min HTTP timeout workaround) ──────
  // Mark the job 'processing' first, then close the response. The
  // browser starts polling /report-status/:jobId at 3 s cadence; the
  // actual report runs inside setImmediate() below, free of any
  // upstream HTTP timeout.
  setJob(sessionId, { userId });
  res.json({ ok: true, jobId: sessionId });

  // From here on we run detached. Every error path inside the try
  // block routes through failJob(sessionId, msg) instead of res.send.
  // res.setHeader is silenced because the response is already closed
  // (the existing X-* diagnostic headers below would otherwise warn).
  setImmediate(async () => {
   res.setHeader = function () {};
   try {
    if (!input) {
      failJob(sessionId, 'Please enter a business name and city.');
      return;
    }
    sendProgress(sessionId, { step: 1, total: 8, message: 'Finding your business on Google...', pct: 10 });

  let layer0Result;
  try {
    layer0Result = layer0.classifyInput(input);
  } catch (err) {
    failJob(sessionId, `Classifier error: ${err.message}`);
    return;
  }

  // Phase-1 hotel keyword patch (kept as a fast-path; saves a Places call
  // when the input mentions "hotel"/"motel"/"inn" anywhere in the string
  // and Layer 0 didn't classify it. Word-boundary matching (\b) ensures
  // the keyword is matched as its own token in the full input — including
  // when surrounded by an address ("Holiday Inn, 100 Main St, Town, ST ZIP").
  // Note: CamelCase brands like "AmericInn" lack a word boundary inside
  // the token; those are caught by BRAND_CHAIN (Wyndham/Choice/etc.) at
  // Layer 0 instead.
  if (!layer0Result.naics6 && /\b(hotel|motel|inn)\b/i.test(input)) {
    layer0Result = {
      mode: 'niche_typed',
      confidence: 'MEDIUM',
      naics6: '721110',
      keyword: 'hotel',
      _phase1Patch: true,
    };
  }

  // Phase-3 fallback — when Layer 0 produced no NAICS, do an early Places
  // Text Search and try to derive NAICS from the result's types[] array.
  // If types[] is degenerate (no match in either pass), fall through to a
  // name-based pattern match against the Place's name field. We stash
  // placeStub so we don't double-call Places below.
  let placeStub = null;
  // Universal place_id short-circuit: when the landing-page autocomplete
  // supplied a place_id, set placeStub up front so EVERY downstream
  // `if (!placeStub)` guard (Phase-3 types fallback, claude-classify
  // fallback, main resolver) skips findPlace and uses Google's exact
  // selected place_id. Backwards compatible — when no place_id is
  // present, placeStub stays null and findPlace runs as before.
  if (clientPlaceId) {
    placeStub = {
      place_id: clientPlaceId,
      name: input.split(',')[0].trim(),
    };
    console.log('[classify] place_id set early:', clientPlaceId, '— all findPlace calls skipped');
    // BUG 8 — when the landing-page autocomplete supplied a place_id we
    // short-circuited findPlace, but the resulting placeStub has only
    // `place_id` + `name` — no `types`. That broke the Phase-3 types
    // fallback (mapSpecificType / mapGenericType both got `undefined`)
    // AND the Claude-classify fallback (which passes placeStub.types).
    // Fetch details up front to populate types; the 24h DETAILS_CACHE
    // means the later getDetails call at line ~385 is a free cache hit.
    if (API_KEY) {
      try {
        const earlyDetail = await places.getDetails(clientPlaceId, API_KEY);
        if (earlyDetail) {
          placeStub.types = Array.isArray(earlyDetail.types) ? earlyDetail.types : [];
          if (earlyDetail.name) placeStub.name = earlyDetail.name;
          console.log('[classify] place_id early-details:', placeStub.types.length, 'types fetched');
        }
      } catch (e) {
        console.warn('[classify] place_id early-details failed:', e.message, '— continuing without types');
      }
    }
  }
  let typesFallback = null;
  let nameFallback = null;
  if (!layer0Result.naics6) {
    if (!API_KEY) {
      failJob(sessionId, 'GOOGLE_PLACES_API_KEY is not set on the server. Please contact support.');
      return;
    }
    try {
      // Guard: skip findPlace when the universal place_id short-circuit
      // above already set placeStub from the landing-page autocomplete.
      // Without this guard the Phase-3 types fallback (which runs when
      // Layer 0 couldn't classify the input text) would overwrite the
      // pre-set placeStub with a fresh Text Search result, discarding
      // the exact place_id Google's autocomplete dropdown returned.
      if (!placeStub) {
        placeStub = await places.findPlace(input, API_KEY);
      }
    } catch (err) {
      failJob(sessionId, `Google Places search failed: ${err.message}`);
      return;
    }
    if (!placeStub) {
      failJob(sessionId, `No Google Places match for "${input}". Try a more specific business name or address.`);
      return;
    }
    // Tier 1: name fallback — runs FIRST so brand/keyword signals override
    // misleading Google type tags (Phase 2 Session 9.5.1+):
    //   - breweries tagged 'bar' → brewery_winery_distillery wins
    //   - chiropractors tagged 'gym' → chiropractic wins
    //   - moving companies tagged 'storage' → moving_company wins
    //   - cleaning services tagged 'laundry' → cleaning wins (Honolulu maid)
    //
    // Match against TWO sources, in this order:
    //   1. Input business name (text before the street address) — captures
    //      user intent even when Google returns a truncated/different name
    //      ("Inglenook" instead of "Inglenook Winery", "1600 Glenarm Place"
    //      instead of "Greystar Real Estate").
    //   2. Google's returned place_name — fallback for inputs that don't
    //      have a parseable business-name prefix.
    //
    // The business-name prefix is extracted with the same regex as the
    // LOCATION mode in Layer 0: everything before the first comma whose
    // right-hand side starts with a street number.
    const inputNameMatch = input.match(/^(.+?),\s*\d+\s+/);
    const businessNameFromInput = inputNameMatch ? inputNameMatch[1].trim() : input;
    let named = placesTypeMapper.mapNameToNaics6(businessNameFromInput);
    let nameSource = 'input_business_name';
    if (!named && placeStub.name) {
      named = placesTypeMapper.mapNameToNaics6(placeStub.name);
      nameSource = 'place_name';
    }
    if (named) {
      console.log('[diag] name_fallback triggered:', JSON.stringify({
        source: nameSource,
        input_business_name: businessNameFromInput,
        place_name: placeStub.name,
        matched_token: named.matched_token,
        matched_category: named.matched_category,
        resulting_naics6: named.naics6,
      }));
      nameFallback = {
        source: nameSource,
        place_name: placeStub.name,
        matched_token: named.matched_token,
        matched_category: named.matched_category,
      };
      layer0Result = {
        mode: 'places_name_fallback',
        confidence: 'LOW',
        naics6: named.naics6,
        matched_token: named.matched_token,
        matched_category: named.matched_category,
        _nameFallback: true,
      };
    } else {
      // Tier 2: specific types (e.g. dentist, lawyer, supermarket)
      const specMatch = placesTypeMapper.mapSpecificType(placeStub.types);
      if (specMatch) {
        typesFallback = { matched_type: specMatch.matched_type, types: placeStub.types };
        layer0Result = {
          mode: 'places_types_fallback',
          confidence: 'MEDIUM',
          naics6: specMatch.naics6,
          matched_type: specMatch.matched_type,
          _typesFallback: true,
        };
      } else {
        // Tier 3: generic types (food, health, store, school, bar)
        const genMatch = placesTypeMapper.mapGenericType(placeStub.types);
        if (genMatch) {
          typesFallback = { matched_type: genMatch.matched_type, types: placeStub.types };
          layer0Result = {
            mode: 'places_types_fallback',
            confidence: 'LOW',
            naics6: genMatch.naics6,
            matched_type: genMatch.matched_type,
            _typesFallback: true,
          };
        }
      }
    }
  }

  // Diagnostic — Phase 3 instrumentation
  console.log('[diag] classify:', JSON.stringify({
    input,
    layer0_mode: layer0Result.mode,
    layer0_naics6: layer0Result.naics6 || null,
    places_types_fallback_fired: !!typesFallback,
    places_name_fallback_fired: !!nameFallback,
    google_types_returned: typesFallback ? typesFallback.types : (placeStub ? placeStub.types : null),
  }));

  // Diagnostic response headers — set before any res.send so all branches
  // (waitlist, unsupported, error, blocked, report) carry them. The test
  // harness reads these to capture Layer 0 mode without parsing HTML.
  res.setHeader('X-Layer0-Mode', layer0Result.mode || 'unknown');
  res.setHeader('X-Naics6', layer0Result.naics6 || '');
  res.setHeader('X-Place-Name', placeStub && placeStub.name ? encodeURIComponent(placeStub.name) : '');

  // OOS check via naicsRouter — short-circuits to waitlist for explicit
  // OUT_OF_SCOPE_NICHE / OUT_OF_SCOPE_REGULATED entries.
  const routedProfileId = naicsRouter.lookupProfileId(layer0Result.naics6);
  if (routedProfileId && routedProfileId.startsWith('OUT_OF_SCOPE_')) {
    logOosHit(input, layer0Result, routedProfileId);
    res.setHeader('X-Profile-Id', routedProfileId);
    res.setHeader('X-Status', 'oos_waitlist');
    failJob(sessionId, 'This business sector is not currently supported by GrowthIM. Email support@growthim.com to join the waitlist for your category.');
    return;
  }

  let profile = profileResolver.resolveProfile(layer0Result.naics6);

  // Phase 5+ — Claude classification fallback. When Layer 0 + Phase-3
  // both failed to produce a profile-resolvable NAICS-6, ask Claude to
  // classify the business based on user input + Google place name + types.
  // One extra ~$0.002 call. Only fires here, not on every request.
  // After Claude responds, we re-run BOTH the OOS check and the profile
  // resolver on its NAICS so OOS variants (regulated, niche, 55, 92) still
  // route to the waitlist correctly.
  if (!profile) {
    // Make sure we have a placeStub to feed Claude. Phase-3 may have
    // already fetched one; if not, do a single Text Search now.
    if (!placeStub && API_KEY) {
      try {
        placeStub = await places.findPlace(input, API_KEY);
      } catch (err) {
        console.warn('[claude-classify] places fetch failed:', err.message);
      }
    }
    const claudeNaics = await claudeEnricher.classifyWithClaude(
      input,
      placeStub ? placeStub.name : null,
      placeStub ? placeStub.types : null
    );
    if (claudeNaics) {
      // Update layer0Result so downstream sees the new NAICS + a marker
      // for the report renderer (helpful in the header diagnostic line).
      layer0Result = {
        ...layer0Result,
        naics6: claudeNaics,
        mode: 'claude_classification',
        confidence: 'LOW',
        _claudeClassified: true,
      };
      // Re-run OOS check on Claude's NAICS — if it lands on an explicit
      // OUT_OF_SCOPE_* row, route to the waitlist exactly as we would
      // for a deterministic OOS hit.
      const claudeRoutedId = naicsRouter.lookupProfileId(claudeNaics);
      if (claudeRoutedId && claudeRoutedId.startsWith('OUT_OF_SCOPE_')) {
        logOosHit(input, layer0Result, claudeRoutedId);
        res.setHeader('X-Layer0-Mode', 'claude_classification');
        res.setHeader('X-Naics6', claudeNaics);
        res.setHeader('X-Profile-Id', claudeRoutedId);
        res.setHeader('X-Status', 'oos_waitlist');
        failJob(sessionId, 'This business sector is not currently supported by GrowthIM. Email support@growthim.com to join the waitlist for your category.');
        return;
      }
      // Try the profile registry with the Claude NAICS.
      profile = profileResolver.resolveProfile(claudeNaics);
      if (profile) {
        console.log(`[claude-classify] resolved ${claudeNaics} → ${profile.id}`);
        res.setHeader('X-Layer0-Mode', 'claude_classification');
        res.setHeader('X-Naics6', claudeNaics);
      } else {
        console.warn(`[claude-classify] NAICS ${claudeNaics} did not resolve to any profile in registry`);
      }
    }
  }

  if (!profile) {
    res.setHeader('X-Profile-Id', '');
    res.setHeader('X-Status', 'unsupported');
    failJob(sessionId, `This business type is not yet supported by GrowthIM. We support 1400+ business types — if you think your input should have matched one of them, please contact us at support@growthim.com and we'll add coverage for your category.`);
    return;
  }
  res.setHeader('X-Profile-Id', profile.id);

  if (!API_KEY) {
    failJob(sessionId, 'GOOGLE_PLACES_API_KEY is not set on the server. Please contact support.');
    return;
  }

  // Reuse placeStub from the Phase-3 types fallback if we already fetched it.
  if (!placeStub) {
    try {
      if (clientPlaceId) {
        console.log('[classify] using client place_id:', clientPlaceId, '— skipping findPlace');
        placeStub = {
          place_id: clientPlaceId,
          name: input.split(',')[0].trim(),
        };
      } else {
        console.log('[classify] no place_id — running findPlace');
        placeStub = await places.findPlace(input, API_KEY);
      }
    } catch (err) {
      failJob(sessionId, `Google Places search failed: ${err.message}`);
      return;
    }
    if (!placeStub) {
      failJob(sessionId, `No Google Places match for "${input}". Try a more specific business name or address.`);
      return;
    }
  }

  sendProgress(sessionId, { step: 2, total: 8, message: `Found: ${placeStub.name || 'business'} — fetching details...`, pct: 20 });
  let detail;
  try {
    detail = await places.getDetails(placeStub.place_id, API_KEY);
  } catch (err) {
    failJob(sessionId, `Google Places details failed: ${err.message}`);
    return;
  }
  sendProgress(sessionId, {
    step: 3, total: 8,
    message: `${(detail && detail.user_ratings_total) || 0} reviews loaded — scanning competitors...`,
    pct: 35,
  });

  const data = places.toInputFields(detail);
  data.is_chain = (layer0Result.mode === 'brand_chain');
  data.chain_name = layer0Result.chain || null;
  // BATCH-low-confidence: forward findPlace's confidence markers from
  // the placeStub into the data object so renderReport can show the
  // "closest match found" warning banner when the resolver wasn't sure.
  if (placeStub && placeStub._low_confidence) {
    data._low_confidence = true;
    data._user_input = placeStub._user_input || input;
  }
  // BATCH16 — pass the raw review array through for the Common Problems
  // section's keyword-mining pass. Google's legacy Places Details API
  // returns up to 5 reviews; ample for a v1 keyword scan.
  data.sample_reviews = Array.isArray(detail.reviews) ? detail.reviews : [];

  // ════════════════════════════════════════════════════════════════════
  // BATCH14 — 360° signal expansion. Run all enrichment fetches in
  // parallel. Each fetch is wrapped in its own try/catch so a single
  // failure (Census API down, website returns 404, no Nearby competitors)
  // never blocks the rest of the report. Promise.allSettled ensures the
  // promise array always resolves regardless of individual rejections.
  //
  // Fields wired:
  //   FETCH 1 (Nearby Search) → competitor_count, competitor_median_rating,
  //                              competitor_median_review_count, competitors_top3
  //   FETCH 2 (Census ACS)    → median_household_income, total_population,
  //                              average_household_size
  //   FETCH 4 (Website HEAD)  → website_exists
  //
  // FETCHES 3 + 5 (review-response signals + hours completeness) are
  // already extracted synchronously inside places.toInputFields() since
  // the data is in the Places Details payload — no extra API call needed.
  // ════════════════════════════════════════════════════════════════════
  const nearbyType = places.pickNearbySearchType(data.google_types);
  const zip = dataFetchers.extractZipFromAddress(data.formatted_address);
  const websiteUrl = data.website;

  // Phase 5+ — extended to 5 parallel fetches: competitors, census,
  // website HEAD check, weather climatology (Open-Meteo), and location
  // signals (Overpass / OpenStreetMap). PageSpeed is run conditionally
  // AFTER this batch — only if the website check confirms the site loads
  // (per spec: "Only call if website_url is not null and website_exists
  // is true"). Each promise has its own try/catch + timeout, so one
  // failure never blocks the rest of the report.
  // City/state extracted once for fetchUpcomingEvents (and for any
  // future city/state-keyed source). Re-uses claudeEnricher.parseAddress
  // since it already handles the Google formatted_address shape.
  const addrParts = claudeEnricher.parseAddress(data.formatted_address || '');

  // Phase 5+ — derived fields the new sector-conditional fetchers need.
  // Stuff onto `data` (rather than separate locals) so the Claude bundle
  // and the renderer pick them up too.
  data.business_name = data.name || input;
  data.city = addrParts.city;
  data.state = addrParts.state;

  // ── AI Layer 0 verification ─────────────────────────────────────
  // Runs for ALL businesses with Claude Haiku 4.5 + web_search to
  // catch Google-types-based misclassifications (berry patch as
  // restaurant, winery as bar, escape room as retail, etc.). Fires
  // BEFORE data.sector_naics2 is computed so a correction flows into
  // the sector-gated fetcher promises below. Profile is NOT re-
  // resolved here — if NAICS changes, profile.id may end up stale
  // (acceptable trade-off; flagged for follow-up).
  try {
    const aiVerification = await claudeEnricher.verifyBusinessClassification(data, layer0Result);
    if (aiVerification && aiVerification.override_layer0) {
      console.log(
        '[layer0-ai] CORRECTING:', layer0Result.naics6,
        '→', aiVerification.naics6, '(' + aiVerification.naics_title + ')',
        '| reason:', (aiVerification.reasoning || '').slice(0, 100)
      );
      layer0Result.naics6 = aiVerification.naics6;
      layer0Result.naics_title = aiVerification.naics_title;
      layer0Result.sector = aiVerification.sector;
      layer0Result.naics2 = aiVerification.sector;
      layer0Result.confidence = aiVerification.confidence;
      layer0Result.ai_verified = true;
      layer0Result.ai_corrected = true;
      layer0Result.ai_reasoning = aiVerification.reasoning;
      layer0Result.original_naics = aiVerification.original_naics;

      // Re-resolve profile with corrected NAICS so downstream
      // bundle.opportunity_categories, fdicPromise gates, and any
      // other profile-driven logic use the new sector rather than
      // the stale one set at line 258. resolveProfile(naics6) takes
      // a single arg per profileResolver.js; falls back gracefully
      // to the original profile when no profile exists for the new
      // NAICS (e.g. registry doesn't cover it yet).
      let correctedProfileFound = false;
      try {
        const correctedProfile = profileResolver.resolveProfile(layer0Result.naics6);
        if (correctedProfile) {
          profile = correctedProfile;
          data.profile_id = correctedProfile.sector_profile_id || correctedProfile.id || null;
          correctedProfileFound = true;
          console.log('[layer0-ai] profile re-resolved:', data.profile_id);
        } else {
          console.log(
            '[layer0-ai] no profile found for corrected NAICS',
            layer0Result.naics6,
            '— attempting AI profile selection'
          );
        }
      } catch (e) {
        console.error('[layer0-ai] profile re-resolve failed:', e.message);
      }

      // BUG 9 — When correctedProfile was found AND the AI correction
      // didn't move the high-level NAICS-2 sector, the registry-resolved
      // profile is already a strong match — skipping selectBestProfile
      // avoids an unnecessary Haiku call and prevents the cross-check
      // from second-guessing a perfectly valid in-sector correction.
      const originalSectorN2 = layer0Result.original_naics
        ? String(layer0Result.original_naics).slice(0, 2)
        : null;
      const newSectorN2 = aiVerification.sector
        ? String(aiVerification.sector)
        : (layer0Result.naics6 ? String(layer0Result.naics6).slice(0, 2) : null);
      const sectorChanged = !!(originalSectorN2 && newSectorN2 && originalSectorN2 !== newSectorN2);

      // ── AI profile selector (FIX 2) ──────────────────────────────
      // If the corrected NAICS produced no profile (or even if it did,
      // we cross-check by asking Claude Haiku to pick the best matching
      // profile_id from the full registry). When the picker returns a
      // profile id that actually exists, override `profile` so the
      // bundle's opportunity_categories + downstream profile-driven
      // logic use the better match.
      if (!correctedProfileFound || sectorChanged) {
        try {
          const allProfiles = profileResolver.getAllProfiles();
          const selectedProfileId = await claudeEnricher.selectBestProfile(
            layer0Result.naics6,
            data.name,
            layer0Result.ai_reasoning,
            allProfiles
          );
          if (selectedProfileId && allProfiles && allProfiles[selectedProfileId]) {
            profile = allProfiles[selectedProfileId];
            data.profile_id = selectedProfileId;
            layer0Result.profile_id = selectedProfileId;
            layer0Result.sector_profile = allProfiles[selectedProfileId];
            console.log('[profile-selector] using:', selectedProfileId);
          }
        } catch (e) {
          console.error('[profile-selector] step failed:', e.message);
        }
      } else {
        console.log(
          '[profile-selector] skipped — correctedProfile found and sector unchanged (n2=' +
          originalSectorN2 + ')'
        );
      }
    } else if (aiVerification && !aiVerification.override_layer0) {
      console.log('[layer0-ai] CONFIRMED:', layer0Result.naics6, 'is correct');
      layer0Result.ai_verified = true;
      layer0Result.ai_corrected = false;
      layer0Result.ai_reasoning = aiVerification.reasoning;
    }
  } catch (e) {
    console.error('[layer0-ai] verification failed:', e.message, '— continuing with original');
  }

  data.sector_naics2 = naics2FromNaics6(layer0Result.naics6);
  data.profile_id = profile.id;

  // Phase 5+ — sector-conditional promises. Skip (resolve to null)
  // when the business doesn't belong to the relevant NAICS-2 sector
  // or profile family — saves API budget and keeps the data bundle
  // free of fields that don't apply.
  // BLS employment by sector — expanded coverage:
  //   54/61/62/23/44-45 (original — professional/edu/health/construction/retail)
  //   71 (entertainment), 72 (hotels+restaurants), 81 (personal services)
  const BLS_NAICS2 = new Set(['54','61','62','23','44','45','44-45','71','72','81']);
  const blsPromise = BLS_NAICS2.has(data.sector_naics2)
    ? dataFetchers.fetchBLSEmployment(data.sector_naics2)
    : Promise.resolve(null);
  // USDA NASS — detect crop type from business name so a berry farm
  // gets BERRIES data instead of generic CORN. Fail-safe default to CORN
  // (largest national commodity, broadest data coverage in NASS QuickStats).
  const detectCrop = (name, naics6) => {
    const n = (name || '').toLowerCase();
    if (n.includes('berry') || n.includes('strawberry') || n.includes('blueberry') || n.includes('raspberry')) return 'BERRIES';
    if (n.includes('honey') || n.includes('bee') || n.includes('apiary')) return 'HONEY';
    if (n.includes('christmas tree') || n.includes('tree farm')) return 'CHRISTMAS TREES';
    if (n.includes('mushroom')) return 'MUSHROOMS';
    if (n.includes('apple') || n.includes('orchard')) return 'APPLES';
    if (n.includes('grape') || n.includes('vineyard')) return 'GRAPES';
    if (n.includes('pumpkin')) return 'PUMPKINS';
    if (n.includes('tomato')) return 'TOMATOES';
    if (n.includes('potato')) return 'POTATOES';
    if (n.includes('wheat')) return 'WHEAT';
    if (n.includes('soy') || n.includes('soybean')) return 'SOYBEANS';
    return 'CORN';
  };
  // NAICS-6 source of truth for these gates: layer0Result.naics6 — NOT
  // data.naics6 (the latter is never assigned by any upstream code).
  // Captured once into a local const so the three gates below are
  // consistent and don't fall back to undefined.
  const gateNaics6 = (layer0Result && layer0Result.naics6) || '';
  let usdaPromise = Promise.resolve(null);
  if (data.sector_naics2 === '11') {
    const crop = detectCrop(data.name || data.business_name, gateNaics6);
    console.log('[usda-nass] detected crop:', crop, 'for:', data.name || data.business_name);
    usdaPromise = dataFetchers.fetchUSDANASS(data.state, crop);
  }
  // FMCSA Safety — narrowed to actual trucking operations. Previously
  // fired for all 48-49 (transit/limo/taxi/pipeline/scenic transport
  // got safety lookups they don't need). naics3 derived from naics6
  // distinguishes the trucking subset:
  //   484 (truck transportation) — core target
  //   488 (support activities for transportation, e.g., freight brokers)
  // Excludes 485 transit/limo/taxi, 486 pipeline, 487 scenic, 492 courier.
  const fmcsaNaics3 = gateNaics6.slice(0, 3);
  const fmcsaPromise = (fmcsaNaics3 === '484' || fmcsaNaics3 === '488')
    ? dataFetchers.fetchFMCSA(data.business_name)
    : Promise.resolve(null);
  // NPI Registry — health-sector NAICS-2 = 62 plus veterinarians (541940,
  // technically NAICS-2 = 54). Vets carry NPI numbers; previous gate
  // missed them because of the NAICS-2 boundary.
  const npiPromise = (data.sector_naics2 === '62' || gateNaics6 === '541940')
    ? dataFetchers.fetchNPIRegistry(data.business_name, data.city, data.state)
    : Promise.resolve(null);
  const fmrPromise = data.sector_naics2 === '53'
    ? dataFetchers.fetchFairMarketRents(data.state, data.city)
    : Promise.resolve(null);
  const fdicPromise = (data.profile_id && (data.profile_id.includes('bank') || data.profile_id.includes('finance')))
    ? dataFetchers.fetchFDICData(data.business_name, data.state)
    : Promise.resolve(null);

  // Phase 5+ — 4 new keyless sector-gated promises. NAICS prefix gates
  // mirror the spec: only fire when the business sector benefits from
  // that data source so we don't waste calls on every /classify.
  const naics6 = (layer0Result && layer0Result.naics6) || '';
  const naics2 = naics6.slice(0, 2);
  const naics3 = naics6.slice(0, 3);
  const naics4 = naics6.slice(0, 4);

  // ── Resolve county EARLY for CDC Places + HRSA Dental ───────────
  // The building-permits fetcher inside the main Promise.allSettled
  // batch eventually populates data.county_name, but that's too late
  // for CDC and HRSA — both promises are CONSTRUCTED before that
  // batch runs. Pre-resolve via the Census geocoder (cached 30 days
  // per city+state, so first call costs ~300ms, cached hits are 0ms).
  // Fail-open: if the geocoder is unreachable or returns no county,
  // the downstream fetchers see empty string and use their existing
  // city-fallback / null-return paths.
  let earlyCountyName = '';
  let earlyCountyFIPS = '';
  if (data.city && data.state) {
    try {
      console.log('[county-early] resolving county for:', data.city, data.state);
      const countyResult = await dataFetchers.fetchCountyFIPSByCity(
        data.city,
        data.state,
        data.latitude,
        data.longitude
      );
      if (countyResult) {
        earlyCountyName = countyResult.county_name || '';
        earlyCountyFIPS = countyResult.county_fips || '';
        console.log(
          '[county-early] resolved:', earlyCountyName,
          '| FIPS:', earlyCountyFIPS
        );
      } else {
        console.log('[county-early] no county match for', data.city, data.state);
      }
    } catch (e) {
      console.error(
        '[county-early] failed:', e.message,
        '— CDC/HRSA will use city fallback'
      );
    }
  }
  // Surface the resolved county on `data` so downstream consumers
  // (renderer, claudeEnricher bundle, etc.) can read it without
  // waiting for the building-permits result block. Permits will
  // overwrite later with the same value (or a more authoritative
  // one from the HUD ArcGIS layer) — safe to overwrite.
  if (earlyCountyName) {
    data.county_name = earlyCountyName;
    data.county_fips = earlyCountyFIPS;
  }

  // CDC PLACES local health metrics — medical (621) / fitness (713) / restaurants (722)
  const cdcPromise = (naics3 === '621' || naics3 === '713' || naics3 === '722')
    ? dataFetchers.fetchCDCPlaces(
        (addrParts && addrParts.city) || '',
        (addrParts && addrParts.state) || '',
        earlyCountyName
      )
    : Promise.resolve(null);

  // HRSA Dental Health Professional Shortage Area — dental practices only (6212)
  // Uses the ArcGIS HPSA_Dental FeatureServer; needs state + county.
  const hrsaPromise = (naics4 === '6212')
    ? dataFetchers.fetchHRSADental(
        (addrParts && addrParts.state) || '',
        earlyCountyName
      )
    : Promise.resolve(null);

  // USDA ERS ARMS farm economics — agriculture (11) / restaurants (722) /
  // grocery (445) / food manufacturing (311 bakeries) / beverage
  // manufacturing (312 breweries/wineries/distilleries). 311 and 312 are
  // consumer-facing food producers with retail dynamics; ERS food-price
  // trends apply.
  const ersPromise = (naics2 === '11' || naics3 === '722' || naics3 === '445' || naics3 === '311' || naics3 === '312')
    ? dataFetchers.fetchUSDAERS((addrParts && addrParts.state) || '')
    : Promise.resolve(null);

  // Phase 5+ — 5 more keyless / free-key sector-gated promises.
  // FoodData + Open Food Facts both seed off a cuisine / food query;
  // fall back to a sensible default for grocery (445) where no
  // cuisine field is set by the cuisine-detection pipeline.
  const foodQuery = data.cuisine || data.cuisine_type
    || (naics3 === '445' ? 'grocery' : 'food');

  // USDA FoodData Central — restaurants (722) / grocery (445) /
  // food manufacturing (311 bakeries) / beverage manufacturing (312).
  const foodDataPromise = (naics3 === '722' || naics3 === '445' || naics3 === '311' || naics3 === '312')
    ? dataFetchers.fetchFoodData(foodQuery)
    : Promise.resolve(null);

  // Open Food Facts — restaurants (722) / grocery (445)
  const offPromise = (naics3 === '722' || naics3 === '445')
    ? dataFetchers.fetchOpenFoodFacts(foodQuery)
    : Promise.resolve(null);

  // Datamuse — fires for ALL sectors. Seeds off the business name so
  // Claude has related-concept words for naming ideas.
  const datamusePromise = dataFetchers.fetchDatamuse(
    data.business_name || data.name || ''
  );

  // NPS — hotels (721) / restaurants (722) / retail (44-45) /
  // entertainment (71 — golf, museums, escape rooms, zoos, amusement).
  // Park proximity drives tourism traffic for all of these.
  const npsPromise = (naics3 === '721' || naics3 === '722' || naics2 === '44' || naics2 === '45' || naics2 === '71')
    ? dataFetchers.fetchNearbyParks((addrParts && addrParts.state) || '')
    : Promise.resolve(null);

  // NOAA Climate Data Online — fires for ALL sectors. Long-term
  // temperature normals augment Open-Meteo's rolling 12-month signal.
  const noaaPromise = dataFetchers.fetchNOAAClimate(data.latitude, data.longitude);

  const [
    competitorRes, censusRes, websiteRes, weatherRes, locationRes, permitsRes, eventsRes,
    venuesRes, tripAdvisorRes,
    blsRes, usdaRes, fmcsaRes, npiRes, fmrRes, fdicRes,
    cdcRes, hrsaRes, ersRes,
    foodDataRes, offRes, datamuseRes, npsRes, noaaRes,
  ] = await Promise.allSettled([
    places.fetchNearbyCompetitors({
      placeId: data.place_id,
      lat: data.latitude,
      lng: data.longitude,
      type: nearbyType,
      apiKey: API_KEY,
      city: data.city,
      state: data.state,
      subjectName: data.name,
      // ── New competitor-detection inputs (FIX 1/2/3) ──
      // buildCompetitorQuery uses naics6/naics2/googleTypes/businessName
      // to construct a Google Text Search query that's far more
      // category-accurate than the old type-filter Nearby Search.
      // getCompetitorRadius picks the right search distance based on
      // sector (hotels/healthcare/etc. need wider radii) and
      // population. T1 RULE: population is null here because Census
      // fires in the same Promise.allSettled batch — the helper
      // defaults to a rural-sized radius when population is unknown.
      businessName: data.name,
      naics6: layer0Result.naics6,
      naics2: data.sector_naics2,
      googleTypes: data.google_types,
      population: null,
    }),
    // FIX 1 — pass city + state so fetchCensusByZip's place-level branch
    // fires. Without these args, _fetchCensusPlacePopulation is skipped
    // and `total_population` falls back to the ZCTA-level number (which
    // overstates the city by ~50% for Dodgeville WI: ZCTA 7,397 vs
    // city 4,994). countyFIPS isn't known yet at this point in the
    // route — the building-permits fetcher resolves it later — so we
    // pass null and skip the county-income branch on /classify (income
    // for cities >200k pop only; not a /classify use case).
    dataFetchers.fetchCensusByZip(zip, addrParts.city, addrParts.state, null),
    dataFetchers.checkWebsiteExists(websiteUrl),
    dataFetchers.fetchWeather(data.latitude, data.longitude),
    dataFetchers.fetchLocationSignals(data.latitude, data.longitude),
    // HUD residential building permits — Census geocoder (FIPS lookup) +
    // HUD ArcGIS query in sequence. Two HTTP calls but only fires ~5s
    // worst-case via internal timeouts. Cached 30 days per county FIPS.
    dataFetchers.fetchBuildingPermitsByAddress(data.formatted_address),
    // Ticketmaster Discovery v2 — top 5 upcoming events within 10 miles.
    // Returns empty array gracefully when TICKETMASTER_API_KEY is unset
    // or the city/state has nothing in their catalog.
    dataFetchers.fetchUpcomingEvents(addrParts.city, addrParts.state),
    // Phase 5+ FETCH 10 — Foursquare v3 nearby venues (food/arts/outdoors).
    // Returns [] when no key is configured. Cached 24h per lat/lon@3dec.
    dataFetchers.fetchNearbyVenues(data.latitude, data.longitude),
    // Phase 5+ FETCH 11 — TripAdvisor Content API (search → details +
    // reviews). Three HTTP calls internally; returns null if any step
    // fails. Cached 24h per businessName + city.
    dataFetchers.fetchTripAdvisor(data.name || input, data.formatted_address),
    // Phase 5+ FETCH 12-18 — sector-conditional sources. Each was
    // resolved above to either a real fetch promise or Promise.resolve(null).
    blsPromise,
    usdaPromise,
    fmcsaPromise,
    npiPromise,
    fmrPromise,
    fdicPromise,
    // Phase 5+ — 3 new keyless sector-gated fetchers
    cdcPromise,
    hrsaPromise,
    ersPromise,
    // Phase 5+ — 5 more sector-gated / always-on fetchers
    foodDataPromise,
    offPromise,
    datamusePromise,
    npsPromise,
    noaaPromise,
  ]);
  sendProgress(sessionId, { step: 4, total: 8, message: 'Census, weather, permits loaded — running scoring engine...', pct: 50 });

  // FETCH 1 — competitor stats (or null on failure)
  if (competitorRes.status === 'fulfilled' && competitorRes.value) {
    data.competitor_count = competitorRes.value.competitor_count;
    data.competitor_median_rating = competitorRes.value.competitor_median_rating;
    data.competitor_median_review_count = competitorRes.value.competitor_median_review_count;
    data.competitors_top3 = competitorRes.value.competitors_top3;
    data.competitors_top5 = competitorRes.value.competitors_top5;
    data.search_radius_miles = competitorRes.value.search_radius_miles;
  } else {
    data.competitor_count = null;
    data.competitor_median_rating = null;
    data.competitor_median_review_count = null;
    data.competitors_top3 = null;
    data.competitors_top5 = null;
    data.search_radius_miles = null;
    if (competitorRes.status === 'rejected') {
      console.warn('[fetch1] nearby-search failed:', competitorRes.reason && competitorRes.reason.message);
    }
  }

  // FETCH 2 — Census ACS (or null on failure)
  if (censusRes.status === 'fulfilled' && censusRes.value) {
    data.median_household_income = censusRes.value.median_household_income;
    data.total_population = censusRes.value.total_population;
    data.average_household_size = censusRes.value.average_household_size;
    data.census_zip = censusRes.value.zip;
    // Phase 5+ — housing extension piggybacks on the same ACS call.
    data.census_housing = censusRes.value.census_housing || null;
  } else {
    data.median_household_income = null;
    data.total_population = null;
    data.average_household_size = null;
    data.census_zip = zip;
    data.census_housing = null;
    if (censusRes.status === 'rejected') {
      console.warn('[fetch2] census-acs failed:', censusRes.reason && censusRes.reason.message);
    }
  }

  // FETCH 4 — website HEAD check
  if (websiteRes.status === 'fulfilled') {
    data.website_url = websiteUrl || null;
    data.website_exists = websiteRes.value;
  } else {
    data.website_url = websiteUrl || null;
    data.website_exists = null;
    console.warn('[fetch4] website-check failed:', websiteRes.reason && websiteRes.reason.message);
  }

  // Phase 5+ FETCH 5 — Open-Meteo climatology
  // Top-level fields named per the user's trigger spec (peak_tourist_season,
  // has_cold_winter, etc.) so the trigger DSL can reference them directly.
  if (weatherRes.status === 'fulfilled' && weatherRes.value) {
    data.weather = weatherRes.value;
    data.peak_month = weatherRes.value.peak_month;
    data.peak_tourist_season = weatherRes.value.peak_tourist_season;
    data.has_cold_winter = weatherRes.value.has_cold_winter;
    data.has_hot_summer = weatherRes.value.has_hot_summer;
  } else {
    data.weather = null;
    data.peak_month = null;
    data.peak_tourist_season = null;
    data.has_cold_winter = null;
    data.has_hot_summer = null;
    if (weatherRes.status === 'rejected') {
      console.warn('[fetch5-weather] failed:', weatherRes.reason && weatherRes.reason.message);
    }
  }

  // Phase 5+ FETCH 6 — Overpass / OpenStreetMap location signals
  if (locationRes.status === 'fulfilled' && locationRes.value) {
    data.location_signals = locationRes.value;
    data.anchor_tenants = locationRes.value.anchor_tenants;
    data.anchor_tenant_count = locationRes.value.anchor_tenant_count;
    data.nearest_transit_meters = locationRes.value.nearest_transit_meters;
    data.has_transit_nearby = locationRes.value.has_transit_nearby;
  } else {
    data.location_signals = null;
    data.anchor_tenants = null;
    data.anchor_tenant_count = null;
    data.nearest_transit_meters = null;
    data.has_transit_nearby = null;
    if (locationRes.status === 'rejected') {
      console.warn('[fetch6-overpass] failed:', locationRes.reason && locationRes.reason.message);
    }
  }

  // Phase 5+ FETCH 7 — HUD residential building permits (Census geocoder
  // → HUD ArcGIS layer 24). Top-level fields named per user's spec so the
  // trigger DSL can reference them directly.
  if (permitsRes.status === 'fulfilled' && permitsRes.value) {
    const p = permitsRes.value;
    data.building_permits = p;
    data.building_permits_total = p.building_permits_total;
    data.building_permits_single_family = p.building_permits_single_family;
    data.building_permits_year = p.building_permits_year;
    data.building_permits_prior_year = p.building_permits_prior_year;
    data.building_permits_prior_year_total = p.building_permits_prior_year_total;
    data.building_permits_yoy_change = p.building_permits_yoy_change;
    data.county_fips = p.county_fips;
    data.county_name = p.county_name;
  } else {
    data.building_permits = null;
    data.building_permits_total = null;
    data.building_permits_single_family = null;
    data.building_permits_year = null;
    data.building_permits_prior_year = null;
    data.building_permits_prior_year_total = null;
    data.building_permits_yoy_change = null;
    data.county_fips = null;
    data.county_name = null;
    if (permitsRes.status === 'rejected') {
      console.warn('[fetch7-permits] failed:', permitsRes.reason && permitsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 8 — Ticketmaster upcoming events (city/state)
  // Returns [] gracefully when no API key is set or the call fails.
  if (eventsRes.status === 'fulfilled' && Array.isArray(eventsRes.value)) {
    data.upcoming_events = eventsRes.value;
  } else {
    data.upcoming_events = [];
    if (eventsRes.status === 'rejected') {
      console.warn('[fetch8-events] failed:', eventsRes.reason && eventsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 10 — Foursquare nearby venues (food/arts/outdoors)
  if (venuesRes.status === 'fulfilled' && Array.isArray(venuesRes.value)) {
    data.nearby_venues = venuesRes.value;
    data.nearby_venue_count = venuesRes.value.length;
  } else {
    data.nearby_venues = [];
    data.nearby_venue_count = 0;
    if (venuesRes.status === 'rejected') {
      console.warn('[fetch10-venues] failed:', venuesRes.reason && venuesRes.reason.message);
    }
  }

  // Phase 5+ FETCH 11 — TripAdvisor (search → details + reviews)
  // Top-level fields named per spec so the trigger DSL can reference them
  // directly (ta_rating, ta_review_count, ta_subratings, ta_value_gap_detected, …).
  if (tripAdvisorRes.status === 'fulfilled' && tripAdvisorRes.value) {
    const ta = tripAdvisorRes.value;
    data.tripadvisor = ta;
    data.ta_location_id = ta.ta_location_id;
    data.ta_rating = ta.ta_rating;
    data.ta_review_count = ta.ta_review_count;
    data.ta_ranking = ta.ta_ranking;
    data.ta_ranking_position = ta.ta_ranking_position;
    data.ta_ranking_out_of = ta.ta_ranking_out_of;
    data.ta_subratings = ta.ta_subratings;
    data.ta_awards = ta.ta_awards;
    data.ta_trip_types = ta.ta_trip_types;
    data.ta_recent_reviews = ta.ta_recent_reviews;
    // Synthetic boolean for the trigger DSL (no arithmetic in DSL grammar).
    data.ta_value_gap_detected = ta.ta_value_gap_detected;
  } else {
    data.tripadvisor = null;
    data.ta_location_id = null;
    data.ta_rating = null;
    data.ta_review_count = null;
    data.ta_ranking = null;
    data.ta_ranking_position = null;
    data.ta_ranking_out_of = null;
    data.ta_subratings = null;
    data.ta_awards = null;
    data.ta_trip_types = null;
    data.ta_recent_reviews = null;
    data.ta_value_gap_detected = false;
    if (tripAdvisorRes.status === 'rejected') {
      console.warn('[fetch11-tripadvisor] failed:', tripAdvisorRes.reason && tripAdvisorRes.reason.message);
    }
  }

  // Phase 5+ FETCH 12 — BLS sector employment level
  if (blsRes.status === 'fulfilled' && blsRes.value) {
    data.bls_employment = blsRes.value;
    data.bls_employment_level = blsRes.value.employment_level;
    data.bls_employment_year = blsRes.value.employment_year;
    data.bls_employment_period = blsRes.value.employment_period;
  } else {
    data.bls_employment = null;
    data.bls_employment_level = null;
    data.bls_employment_year = null;
    data.bls_employment_period = null;
    if (blsRes.status === 'rejected') {
      console.warn('[fetch12-bls] failed:', blsRes.reason && blsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 13 — USDA NASS agriculture profile
  if (usdaRes.status === 'fulfilled' && usdaRes.value) {
    data.usda_nass = usdaRes.value;
    data.top_commodity = usdaRes.value.top_commodity;
    data.farm_count = usdaRes.value.farm_count;
    data.state_ag_profile = usdaRes.value.state_ag_profile;
  } else {
    data.usda_nass = null;
    data.top_commodity = null;
    data.farm_count = null;
    data.state_ag_profile = null;
    if (usdaRes.status === 'rejected') {
      console.warn('[fetch13-usda] failed:', usdaRes.reason && usdaRes.reason.message);
    }
  }

  // Phase 5+ FETCH 14 — FMCSA carrier safety
  if (fmcsaRes.status === 'fulfilled' && fmcsaRes.value) {
    data.fmcsa = fmcsaRes.value;
    data.dot_number = fmcsaRes.value.dot_number;
    data.safety_rating = fmcsaRes.value.safety_rating;
    data.allowed_to_operate = fmcsaRes.value.allowed_to_operate;
    data.total_drivers = fmcsaRes.value.total_drivers;
    data.total_trucks = fmcsaRes.value.total_trucks;
  } else {
    data.fmcsa = null;
    data.dot_number = null;
    data.safety_rating = null;
    data.allowed_to_operate = null;
    data.total_drivers = null;
    data.total_trucks = null;
    if (fmcsaRes.status === 'rejected') {
      console.warn('[fetch14-fmcsa] failed:', fmcsaRes.reason && fmcsaRes.reason.message);
    }
  }

  // Phase 5+ FETCH 15 — NPI Registry healthcare provider
  if (npiRes.status === 'fulfilled' && npiRes.value) {
    data.npi = npiRes.value;
    data.npi_number = npiRes.value.npi_number;
    data.npi_status = npiRes.value.status;
    data.npi_authorized = npiRes.value.authorized;
    data.provider_type = npiRes.value.provider_type;
  } else {
    data.npi = null;
    data.npi_number = null;
    data.npi_status = null;
    data.npi_authorized = null;
    data.provider_type = null;
    if (npiRes.status === 'rejected') {
      console.warn('[fetch15-npi] failed:', npiRes.reason && npiRes.reason.message);
    }
  }

  // Phase 5+ FETCH 16 — HUD Fair Market Rents
  if (fmrRes.status === 'fulfilled' && fmrRes.value) {
    data.hud_fmr = fmrRes.value;
    data.fmr_studio = fmrRes.value.fmr_studio;
    data.fmr_1br = fmrRes.value.fmr_1br;
    data.fmr_2br = fmrRes.value.fmr_2br;
    data.fmr_metro_name = fmrRes.value.metro_name;
    data.fmr_year = fmrRes.value.fmr_year;
  } else {
    data.hud_fmr = null;
    data.fmr_studio = null;
    data.fmr_1br = null;
    data.fmr_2br = null;
    data.fmr_metro_name = null;
    data.fmr_year = null;
    if (fmrRes.status === 'rejected') {
      console.warn('[fetch16-fmr] failed:', fmrRes.reason && fmrRes.reason.message);
    }
  }

  // Phase 5+ FETCH 17 — FDIC bank data
  if (fdicRes.status === 'fulfilled' && fdicRes.value) {
    data.fdic = fdicRes.value;
    data.fdic_bank_name = fdicRes.value.bank_name;
    data.fdic_total_deposits = fdicRes.value.total_deposits;
    data.fdic_total_assets = fdicRes.value.total_assets;
  } else {
    data.fdic = null;
    data.fdic_bank_name = null;
    data.fdic_total_deposits = null;
    data.fdic_total_assets = null;
    if (fdicRes.status === 'rejected') {
      console.warn('[fetch17-fdic] failed:', fdicRes.reason && fdicRes.reason.message);
    }
  }

  // Phase 5+ FETCH 20 — CDC PLACES local health metrics (sector-gated)
  if (cdcRes.status === 'fulfilled' && cdcRes.value) {
    data.cdc_health = cdcRes.value;
  } else {
    data.cdc_health = null;
    if (cdcRes.status === 'rejected') {
      console.warn('[fetch20-cdc-places] failed:', cdcRes.reason && cdcRes.reason.message);
    }
  }

  // Phase 5+ FETCH 21 — HRSA Dental HPSA (dental practices only)
  if (hrsaRes.status === 'fulfilled' && hrsaRes.value) {
    data.hrsa_dental = hrsaRes.value;
  } else {
    data.hrsa_dental = null;
    if (hrsaRes.status === 'rejected') {
      console.warn('[fetch21-hrsa-dental] failed:', hrsaRes.reason && hrsaRes.reason.message);
    }
  }

  // Phase 5+ FETCH 22 — USDA ERS ARMS farm economics (sector-gated)
  if (ersRes.status === 'fulfilled' && ersRes.value) {
    data.usda_ers = ersRes.value;
  } else {
    data.usda_ers = null;
    if (ersRes.status === 'rejected') {
      console.warn('[fetch22-usda-ers] failed:', ersRes.reason && ersRes.reason.message);
    }
  }

  // Phase 5+ FETCH 23 — USDA FoodData Central (sector-gated)
  if (foodDataRes.status === 'fulfilled' && foodDataRes.value) {
    data.food_data = foodDataRes.value;
  } else {
    data.food_data = null;
    if (foodDataRes.status === 'rejected') {
      console.warn('[fetch23-fooddata] failed:', foodDataRes.reason && foodDataRes.reason.message);
    }
  }

  // Phase 5+ FETCH 24 — Open Food Facts (sector-gated)
  if (offRes.status === 'fulfilled' && offRes.value) {
    data.open_food_facts = offRes.value;
  } else {
    data.open_food_facts = null;
    if (offRes.status === 'rejected') {
      console.warn('[fetch24-openfoodfacts] failed:', offRes.reason && offRes.reason.message);
    }
  }

  // Phase 5+ FETCH 25 — Datamuse related words (all sectors)
  if (datamuseRes.status === 'fulfilled' && datamuseRes.value) {
    data.related_words = datamuseRes.value;
  } else {
    data.related_words = null;
    if (datamuseRes.status === 'rejected') {
      console.warn('[fetch25-datamuse] failed:', datamuseRes.reason && datamuseRes.reason.message);
    }
  }

  // Phase 5+ FETCH 26 — NPS national parks (sector-gated)
  if (npsRes.status === 'fulfilled' && npsRes.value) {
    data.nearby_nps_parks = npsRes.value;
  } else {
    data.nearby_nps_parks = null;
    if (npsRes.status === 'rejected') {
      console.warn('[fetch26-nps] failed:', npsRes.reason && npsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 27 — NOAA Climate Data Online (all sectors)
  if (noaaRes.status === 'fulfilled' && noaaRes.value) {
    data.noaa_climate = noaaRes.value;
  } else {
    data.noaa_climate = null;
    if (noaaRes.status === 'rejected') {
      console.warn('[fetch27-noaa] failed:', noaaRes.reason && noaaRes.reason.message);
    }
  }

  // Phase 5+ FETCH 9 — Google PageSpeed Insights (mobile)
  // Conditional: only call if the website check passed. PSI takes 8-15s
  // even on healthy sites; we cap at 15s in the fetcher and fall through
  // to null fields on timeout. Report renders regardless.
  data.pagespeed = null;
  data.website_mobile_score = null;
  data.load_time_seconds = null;
  data.lcp_seconds = null;
  data.is_mobile_friendly = null;
  if (data.website_exists === true && data.website_url && API_KEY) {
    try {
      const ps = await dataFetchers.fetchPageSpeed(data.website_url);
      if (ps) {
        data.pagespeed = ps;
        data.website_mobile_score = ps.mobile_score;
        data.load_time_seconds = ps.load_time_seconds;
        data.lcp_seconds = ps.lcp_seconds;
        data.is_mobile_friendly = ps.is_mobile_friendly;
      }
    } catch (err) {
      console.warn('[fetch9-pagespeed] failed:', err.message);
    }
  }

  console.log('[diag] enrichment:', JSON.stringify({
    competitor_count: data.competitor_count,
    competitor_median_rating: data.competitor_median_rating,
    median_household_income: data.median_household_income,
    total_population: data.total_population,
    review_recency_days: data.review_recency_days,
    responds_to_reviews: data.responds_to_reviews,
    response_rate_estimated: data.response_rate_estimated,
    website_exists: data.website_exists,
    hours_complete: data.hours_complete,
    is_open_now: data.is_open_now,
    peak_tourist_season: data.peak_tourist_season,
    has_cold_winter: data.has_cold_winter,
    anchor_tenant_count: data.anchor_tenant_count,
    has_transit_nearby: data.has_transit_nearby,
    website_mobile_score: data.website_mobile_score,
    load_time_seconds: data.load_time_seconds,
    building_permits_total: data.building_permits_total,
    building_permits_yoy_change: data.building_permits_yoy_change,
    county_fips: data.county_fips,
    upcoming_events_count: Array.isArray(data.upcoming_events) ? data.upcoming_events.length : 0,
    nearby_venue_count: data.nearby_venue_count,
    ta_rating: data.ta_rating,
    ta_review_count: data.ta_review_count,
    ta_ranking_position: data.ta_ranking_position,
    ta_value_gap_detected: data.ta_value_gap_detected,
    sector_naics2: data.sector_naics2,
    bls_employment_level: data.bls_employment_level,
    top_commodity: data.top_commodity,
    fmcsa_safety_rating: data.safety_rating,
    npi_status: data.npi_status,
    fmr_2br: data.fmr_2br,
    fdic_total_deposits: data.fdic_total_deposits,
    cms_overall_rating: data.cms_overall_rating,
  }));

  const requiredMissing = profile.required_inputs.filter((f) => {
    if (f === 'google_review_count') return false;
    return data[f] === null || data[f] === undefined;
  });
  if (requiredMissing.length) {
    res.setHeader('X-Status', 'missing_fields');
    failJob(sessionId, `Missing required fields from Google Places: ${requiredMissing.join(', ')}`);
    return;
  }

  const redFlags = evaluateRedFlags(profile, data);
  const blocking = redFlags.find((r) => r.severity === 'critical' && r.blocks_report);
  if (blocking) {
    res.setHeader('X-Status', 'blocked');
    failJob(sessionId, `Report blocked: ${(blocking && blocking.message) || 'critical issue detected for this business.'}`);
    return;
  }
  res.setHeader('X-Status', 'report');

  const ranked = scoreRecommendations(profile, data, studies.studies);
  const strengths = computeStrengths(profile, data);
  sendProgress(sessionId, { step: 5, total: 8, message: 'Scoring complete — sending to Claude AI...', pct: 60 });

  // Phase 5 — Claude enrichment. Builds a deterministic data bundle from
  // the prior pipeline outputs and asks Claude for: enriched WHY-IT-WORKS
  // / WHY-YOUR-BUSINESS for the top 3 recs, 5 opportunity ideas (from 18
  // categories), and a local_context paragraph. On any failure (no key,
  // bad key, rate-limit, parse error, network) returns null and the
  // renderer shows the deterministic Phase-4 output with a small note.
  const dataBundle = claudeEnricher.buildDataBundle({
    data,
    profile,
    layer0Result,
    ranked,
    studies: studies.studies,
  });
  sendProgress(sessionId, { step: 6, total: 8, message: 'Claude is analyzing your report...', pct: 75 });
  const enriched = await claudeEnricher.enrichWithClaude(dataBundle);
  // Detect Call A failure so renderReport can surface the partial-report
  // banner at the top of the page. enrichWithClaude returns a partial
  // object with _partial:'A_failed' when callClaudeEnrichA returned null
  // (main 20-min timeout AND 7-min fallback timeout both expired, or any
  // other A-only failure). null indicates total Claude failure (no API
  // key or unreachable client) — also treated as a partial state.
  if (enriched && enriched._partial === 'A_failed') {
    data.call_a_failed = true;
    console.warn('[claude] Call A failed (Call B partial) — partial report banner will be shown');
  } else if (!enriched) {
    // Total Claude failure — no API key, network unreachable, or both
    // calls rejected catastrophically. Render the Claude-unavailable
    // banner instead of the partial-report banner so the user knows the
    // AI-enhanced sections are entirely missing (not just half of them).
    data.claude_unavailable = true;
    console.warn('[claude] enrichWithClaude returned null — full Claude-unavailable banner will be shown');
  }
  sendProgress(sessionId, { step: 7, total: 8, message: 'Building your report...', pct: 90 });

  const html = renderReport({
    input,
    layer0Result,
    profile,
    data,
    redFlags,
    strengths,
    ranked,
    enriched,
    studies: studies.studies,
  });

  // Citation linter (post-render, warn-only). Walk every cited study_id
  // referenced in the rendered report's top-10 recommendations and verify
  // it resolves in verifiedStudies.json. Bad references log a console
  // warning but do NOT block the response — the user wants visibility
  // during testing without breaking production reports.
  try {
    const claims = (ranked.top10 || []).flatMap((t) =>
      (t.rec.study_ids || []).map((sid) => ({
        studyId: sid,
        text: `[${profile.id}/${t.rec.id}] ${t.rec.claim || ''}`,
        tier3Disclosure: !!t.rec.tier3_disclosure_required,
      }))
    );
    const lintResult = layer0.lintReport({ claims });
    if (!lintResult.valid) {
      console.warn(
        `[lint] ${lintResult.errors.length} citation issue${lintResult.errors.length === 1 ? '' : 's'} on ${profile.id} report (${claims.length} claims, ${lintResult.sourceCount} unique sources):`
      );
      for (const err of lintResult.errors) console.warn('[lint]   ' + err);
    } else {
      console.log(
        `[lint] ${profile.id} report passes — ${claims.length} claims, ${lintResult.sourceCount} unique studies cited`
      );
    }
  } catch (err) {
    console.warn('[lint] linter execution failed:', err.message);
  }

  // ── Persist report to Postgres ──────────────────────────────────
  // Only saves when the request is authenticated (req.user set by
  // requireAuth). The save is fire-and-forget from the user's POV —
  // any DB failure logs to stderr but does NOT block the response,
  // so the user always receives their report even if Postgres is
  // momentarily unreachable. The `_type` discriminator lets
  // GET /report/:id pick the right renderer when replaying the
  // saved data later.
  // Persist the report and capture the new id. The polling browser
  // is going to redirect to /report/:id, so DB save success is now
  // load-bearing — if it fails we surface the error rather than
  // silently completing into a dead link.
  let savedReportId = null;
  try {
    if (userId) {
      const businessName = data.name || data.business_name || input || null;
      const address = data.formatted_address || null;
      const naicsCode = (layer0Result && layer0Result.naics6) || null;
      const reportData = {
        _type: 'classify',
        input,
        layer0Result,
        profile,
        data,
        redFlags,
        strengths,
        ranked,
        enriched,
      };
      const ins = await pool.query(
        `INSERT INTO reports
          (user_id, business_name, address, naics_code, report_json)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          userId,
          businessName,
          address,
          naicsCode,
          JSON.stringify(reportData),
        ]
      );
      savedReportId = (ins && ins.rows && ins.rows[0] && ins.rows[0].id) || null;
      console.log('[report] saved to DB for user:', userId, 'reportId:', savedReportId);
    }
  } catch (dbErr) {
    console.error('[report] DB save failed:', dbErr.message);
  }

  if (savedReportId == null) {
    failJob(sessionId, 'Report was generated but could not be saved. Please try again.');
    return;
  }

  sendProgress(sessionId, { step: 8, total: 8, message: 'Done!', pct: 100 });
  completeJob(sessionId, savedReportId);
   } catch (jobErr) {
    console.error('[classify] background job failed:', jobErr && jobErr.message, jobErr && jobErr.stack);
    failJob(sessionId, (jobErr && jobErr.message) || 'Report generation failed.');
   }
  });
});

app.post('/market-analysis', reportLimiter, requireAuth, async (req, res) => {
  const { city, state } = req.body;
  const sessionId = (req.body.sessionId || '').toString();
  const userId = req.user.id;
  console.log('[market-analysis] called for', city, state);

  // ── Async job init (Railway 5-min HTTP timeout workaround) ──────
  setJob(sessionId, { userId });
  res.json({ ok: true, jobId: sessionId });

  setImmediate(async () => {
   res.setHeader = function () {};
   try {

  // ── TIER 1 — Validation ─────────────────────────────────────────
  if (!city || !city.trim() || !state || !state.trim()) {
    failJob(sessionId, 'City and state are required.');
    return;
  }
  if (!/^[A-Za-z]{2}$/.test(state.trim())) {
    failJob(sessionId, 'State must be a 2-letter code (e.g. WI).');
    return;
  }

  // ── Progress events for /market-analysis ──────────────────────────
  // The actual work is wrapped inside claudeMarketAnalyst.analyzeCity()
  // which we don't modify (per spec). So we schedule the intermediate
  // milestones on a timer and clear the pending timeouts when
  // analyzeCity returns. The wall-clock offsets approximate observed
  // pipeline phase durations from prior runs.
  sendProgress(sessionId, { step: 1, total: 10, message: 'Geocoding your city...', pct: 5 });
  const SCHEDULE = [
    { step: 2,  message: 'Claude generating business types to evaluate...',     pct: 12, delayMs:   2000 },
    { step: 3,  message: 'Market agent: fetching events, weather, permits...',  pct: 22, delayMs:   6000 },
    { step: 4,  message: 'Demographics agent: Census data loading...',           pct: 32, delayMs:  12000 },
    { step: 5,  message: 'Competition agent: scanning 20 business types...',     pct: 45, delayMs:  18000 },
    { step: 6,  message: 'Cost agent: estimating startup feasibility...',        pct: 55, delayMs:  30000 },
    { step: 7,  message: 'Scoring engine: ranking all opportunities...',         pct: 65, delayMs:  42000 },
    { step: 8,  message: 'Claude writing deep dive analysis...',                 pct: 75, delayMs:  55000 },
    { step: 9,  message: 'Claude building personas and seasonal strategy...',    pct: 88, delayMs:  90000 },
  ];
  const timers = SCHEDULE.map((evt) => setTimeout(() => {
    sendProgress(sessionId, { step: evt.step, total: 10, message: evt.message, pct: evt.pct });
  }, evt.delayMs));
  const cancelTimers = () => { for (const t of timers) clearTimeout(t); };

  try {
    // ── TIER 2 → 5 — Orchestrate via claudeMarketAnalyst.analyzeCity
    // The analyzer pulls geocode + 4 parallel data agents + scoring +
    // why_this_city batch + deep dive on #1 — see the comments in
    // claudeMarketAnalyst.js for the full flow.
    const result = await claudeMarketAnalyst.analyzeCity(
      city.trim(),
      state.trim().toUpperCase(),
      {
        google: process.env.GOOGLE_PLACES_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
      }
    );

    // ── Provenance — verify every quote Claude emitted against the
    // exact review_snippets we shipped to it. Result is attached to
    // `result` so renderMarketReport can render colour-coded badges.
    if (result && result.deep_dive && result._provenance) {
      result._quote_verification = verifyQuotes(result.deep_dive, result._provenance);
      const total = result._quote_verification.length;
      const verified = result._quote_verification.filter((q) => q.verified === true).length;
      const failed = result._quote_verification.filter((q) => q.verified === false).length;
      console.log(
        `[provenance] ${verified}/${total} quotes verified`
        + (failed > 0 ? ` — ${failed} UNVERIFIED` : '')
      );
    }

    cancelTimers();
    sendProgress(sessionId, { step: 10, total: 10, message: 'Building your report...', pct: 98 });
    const html = renderMarketReport(result);

    // ── Persist market analysis to Postgres ────────────────────────
    // Same fire-and-forget pattern as /classify above. Market analysis
    // covers ~20 business types so naics_code uses the #1-ranked
    // sector's NAICS-2 when available, else null. business_name is
    // tagged with "— market analysis" so the dashboard's list can
    // distinguish saved cities from saved businesses at a glance.
    // DB save is load-bearing now — the polling browser redirects to
    // /report/:id and needs a real row to land on.
    let savedReportId = null;
    try {
      if (userId) {
        const cityNorm = city.trim();
        const stateNorm = state.trim().toUpperCase();
        const businessName = `${cityNorm}, ${stateNorm} — market analysis`;
        const address = (result && result.location) || `${cityNorm}, ${stateNorm}`;
        const naicsCode =
          (result && Array.isArray(result.top10) && result.top10[0] && result.top10[0].naics2)
            ? String(result.top10[0].naics2)
            : null;
        const reportData = { _type: 'market_analysis', ...result };
        const ins = await pool.query(
          `INSERT INTO reports
            (user_id, business_name, address, naics_code, report_json)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            userId,
            businessName,
            address,
            naicsCode,
            JSON.stringify(reportData),
          ]
        );
        savedReportId = (ins && ins.rows && ins.rows[0] && ins.rows[0].id) || null;
        console.log('[report] market-analysis saved to DB for user:', userId, 'reportId:', savedReportId);
      }
    } catch (dbErr) {
      console.error('[report] market-analysis DB save failed:', dbErr.message);
    }

    if (savedReportId == null) {
      failJob(sessionId, 'Market analysis was generated but could not be saved. Please try again.');
      return;
    }

    sendProgress(sessionId, { step: 10, total: 10, message: 'Done!', pct: 100 });
    completeJob(sessionId, savedReportId);
  } catch (err) {
    cancelTimers();
    console.error('[market-analysis] error:', err);
    failJob(sessionId, err.message || 'Something went wrong.');
  }

   } catch (jobErr) {
    console.error('[market-analysis] background job failed:', jobErr && jobErr.message, jobErr && jobErr.stack);
    failJob(sessionId, (jobErr && jobErr.message) || 'Market analysis failed.');
   }
  });
});

// ── POST /market-chat — Tier 5c follow-up Q&A ──────────────────────
// Stateful: relies on the 24h MARKET_CACHE inside claudeMarketAnalyst.
// The front-end (renderMarketReport's embedded chat) submits city +
// state + question; we look up the cached analysis and pass it as
// context to a 1000-token Claude call.
app.post('/market-chat', requireAuth, async (req, res) => {
  const { city, state } = req.body || {};
  // Sanitize the user question — cap length, strip HTML tags. The
  // value still gets sent to Claude verbatim, but the cap blocks
  // prompt-injection attacks that try to stuff thousands of tokens
  // of "ignore previous instructions" content, and the HTML strip
  // removes obvious markup that could confuse downstream rendering.
  const question = String((req.body && req.body.question) || '')
    .slice(0, 500)
    .replace(/<[^>]*>/g, '')
    .trim();
  if (!city || !state || !question) {
    return res.status(400).json({ error: 'city, state, and question are required' });
  }
  if (!/^[A-Za-z]{2}$/.test(String(state).trim())) {
    return res.status(400).json({ error: 'State must be a 2-letter code' });
  }
  try {
    const result = await claudeMarketAnalyst.chatFollowUp(
      String(city).trim(),
      String(state).trim().toUpperCase(),
      question
    );
    res.json(result);
  } catch (err) {
    console.error('[market-chat] error:', err);
    res.status(500).json({ error: err.message || 'Chat failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`BizRadar listening on http://localhost:${PORT}`);
});

// BLS Business Employment Dynamics — survival rates for the 2013
// cohort tracked through 2023. Keyed by NAICS-2 (multi-prefix sectors
// use range form: 31-33, 44-45, 48-49). Source: BLS BED Table 7,
// "Survival of private-sector establishments by opening year." Used by
// the Industry survival outlook section in renderReport. No predecessor
// SBA_FAILURE_RATES table existed in this codebase to fall back from.
const BED2013 = {
  '11':    { y1: 0.749, y3: 0.557, y5: 0.443, y7: 0.368, y10: 0.291 },
  '21':    { y1: 0.752, y3: 0.548, y5: 0.402, y7: 0.321, y10: 0.228 },
  '22':    { y1: 0.814, y3: 0.672, y5: 0.566, y7: 0.489, y10: 0.399 },
  '23':    { y1: 0.764, y3: 0.630, y5: 0.539, y7: 0.461, y10: 0.367 },
  '31-33': { y1: 0.802, y3: 0.673, y5: 0.577, y7: 0.503, y10: 0.412 },
  '42':    { y1: 0.783, y3: 0.613, y5: 0.465, y7: 0.389, y10: 0.296 },
  '44-45': { y1: 0.798, y3: 0.673, y5: 0.583, y7: 0.510, y10: 0.421 },
  '48-49': { y1: 0.776, y3: 0.628, y5: 0.501, y7: 0.422, y10: 0.325 },
  '51':    { y1: 0.749, y3: 0.557, y5: 0.443, y7: 0.368, y10: 0.291 },
  '52':    { y1: 0.789, y3: 0.648, y5: 0.532, y7: 0.454, y10: 0.356 },
  '53':    { y1: 0.801, y3: 0.679, y5: 0.587, y7: 0.514, y10: 0.420 },
  '54':    { y1: 0.776, y3: 0.614, y5: 0.463, y7: 0.381, y10: 0.284 },
  '56':    { y1: 0.768, y3: 0.617, y5: 0.489, y7: 0.410, y10: 0.316 },
  '61':    { y1: 0.818, y3: 0.659, y5: 0.560, y7: 0.471, y10: 0.389 },
  '62':    { y1: 0.827, y3: 0.660, y5: 0.551, y7: 0.480, y10: 0.357 },
  '71':    { y1: 0.771, y3: 0.624, y5: 0.529, y7: 0.450, y10: 0.357 },
  '72':    { y1: 0.783, y3: 0.643, y5: 0.553, y7: 0.476, y10: 0.381 },
  '81':    { y1: 0.806, y3: 0.668, y5: 0.569, y7: 0.493, y10: 0.400 },
};

// Map a 6-digit NAICS to its 2-digit "sector" code. Most sectors are
// the literal first two digits, but NAICS uses three multi-prefix
// ranges (Manufacturing 31-33, Retail 44-45, Transportation 48-49).
// Returning the canonical range form lets the conditional sector
// fetchers (BLS, USDA, FMCSA, NPI, FMR, FDIC, CMS) match the user-spec
// keys exactly.
function naics2FromNaics6(naics6) {
  if (!naics6) return null;
  const p = String(naics6).slice(0, 2);
  if (p === '44' || p === '45') return '44-45';
  if (p === '48' || p === '49') return '48-49';
  if (p === '31' || p === '32' || p === '33') return '31-33';
  return p;
}

function computeStrengths(profile, data) {
  const b = profile.benchmarks || {};
  const out = [];
  if (typeof data.google_rating === 'number' && b.good_rating != null
      && data.google_rating > b.good_rating) {
    out.push(`rating ${data.google_rating} > ${b.good_rating}`);
  }
  if (typeof data.google_review_count === 'number' && b.good_review_count != null
      && data.google_review_count > b.good_review_count) {
    out.push(`${data.google_review_count} reviews > ${b.good_review_count}`);
  }
  if (typeof data.review_recency_days === 'number' && b.review_recency_target_days != null
      && data.review_recency_days < b.review_recency_target_days) {
    out.push(`recency ${data.review_recency_days}d < ${b.review_recency_target_days}d`);
  }
  if (typeof data.photo_count === 'number' && b.photo_count_good != null
      && data.photo_count > b.photo_count_good) {
    out.push(`${data.photo_count} photos > ${b.photo_count_good}`);
  }
  return out;
}

function overallStatus(strengths, ranked) {
  const measurableGaps = ranked.allTriggered.filter((t) => t.magnitudeFactor !== 0.5).length;
  if (measurableGaps === 0) return { label: 'HEALTHY', detail: `${strengths.length} of ${strengths.length} measured fields above benchmark` };
  if (measurableGaps <= 2) return { label: `GOOD with ${measurableGaps} gap${measurableGaps === 1 ? '' : 's'}`, detail: '' };
  return { label: 'NEEDS WORK', detail: `${measurableGaps} measurable gaps` };
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// PAGE_OPEN / PAGE_CLOSE — chrome shared by every render function
// (renderReport, renderMarketReport, renderError, renderUnsupported,
// renderWaitlist, renderBlocked). Two consumption paths:
//   1. Direct HTTP — full doc loads in browser
//   2. JS injection — landing page does `result.innerHTML = html`,
//      which strips doctype/html/body but keeps inner content +
//      <style> tag. Styles leak globally — that's fine because all
//      report classes are unique (.rec, .status, .impact, etc.) and
//      don't collide with the landing page's .lp-* / .result-* names.
//
// All colors mapped to the BizRadar brand tokens. Inter font from
// Google Fonts. Card chrome (white surface + subtle border + blue
// left-accent on .rec / emerald on .opportunity / navy on .mkt-card).
const PAGE_OPEN = `<!doctype html>
<html><head><meta charset="utf-8"><title>GrowthIM report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --navy: #0F1729;
  --blue: #2563EB;
  --emerald: #10B981;
  --amber: #F59E0B;
  --bg: #F8FAFC;
  --surface: #FFFFFF;
  --surface-soft: #F1F5F9;
  --text: #1E293B;
  --muted: #64748B;
  --border: #E2E8F0;
  --danger: #DC2626;
  --danger-bg: #FEE2E2;
  --emerald-tint: #ECFDF5;
  --blue-tint: #EFF6FF;
  --amber-tint: #FEF3C7;
}
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 14px; line-height: 1.6; color: var(--text); background: var(--surface); margin: 0; padding: 24px 16px; -webkit-font-smoothing: antialiased; }
@media (min-width: 720px) { body { max-width: 820px; margin: 16px auto; padding: 24px 8px; } }
h1 { font-size: 26px; font-weight: 700; color: var(--navy); margin: 0 0 6px 0; letter-spacing: -0.02em; line-height: 1.2; }
h2 { font-size: 18px; font-weight: 600; color: var(--navy); margin: 32px 0 12px; letter-spacing: -0.01em; padding: 0; border: 0; }
h3 { font-size: 15px; font-weight: 600; color: var(--navy); margin: 0 0 6px; }
p { margin: 0 0 10px; }
ul { padding-left: 20px; margin: 8px 0; }
ul li { margin: 4px 0; }
small { color: var(--muted); font-size: 12px; }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
.meta { color: var(--muted); font-size: 13px; }
.cite { color: var(--muted); font-size: 13px; margin-top: 6px; }

/* ── Status pills (overall report status) ──────────────────────── */
.status { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 600; font-size: 13px; letter-spacing: 0.01em; }
.status.healthy { background: var(--emerald-tint); color: #065F46; }
.status.good    { background: var(--blue-tint);    color: #1E3A8A; }
.status.needs   { background: var(--amber-tint);   color: #92400E; }
.status.blocked { background: var(--danger-bg);    color: #991B1B; }

/* ── Priority action card (.rec) — blue left accent ─────────────── */
.rec { border: 1px solid var(--border); border-left: 4px solid var(--blue); padding: 16px 18px; margin: 12px 0; background: var(--surface); border-radius: 8px; }
.rec h3 { font-size: 15px; margin: 0 0 8px; }
.rec-high    { border-left-color: var(--emerald); }
.rec-medium  { border-left-color: var(--blue); }
.rec-low     { border-left-color: var(--amber); }
.rec-minimal { border-left-color: var(--muted); opacity: 0.85; }

/* ── Score / impact pills ──────────────────────────────────────── */
.impact { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 700; letter-spacing: 0.04em; vertical-align: middle; text-transform: uppercase; }
.impact-high    { background: var(--emerald); color: #FFFFFF; }
.impact-medium  { background: var(--blue);    color: #FFFFFF; }
.impact-low     { background: var(--amber);   color: #FFFFFF; }
.impact-minimal { background: var(--surface-soft); color: var(--muted); }

/* ── 3-layer rec rendering ─────────────────────────────────────── */
.layer { margin: 10px 0; }
.layer-label { display: inline-block; font-weight: 700; font-size: 10.5px; letter-spacing: 0.06em; color: var(--muted); padding: 2px 8px; background: var(--surface-soft); border: 1px solid var(--border); border-radius: 4px; margin-right: 6px; vertical-align: middle; text-transform: uppercase; }
.why-study { padding: 10px 14px; margin: 6px 0; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
.why-study p { margin: 4px 0; }
.honesty { padding: 8px 12px; margin: 6px 0; border-left: 3px solid var(--muted); background: var(--bg); font-size: 13px; border-radius: 4px; }
.honesty-verified              { border-left-color: var(--emerald); background: var(--emerald-tint); }
.honesty-reasonable-inference  { border-left-color: var(--blue);    background: var(--blue-tint); }
.honesty-customer-must-validate{ border-left-color: var(--amber);   background: var(--amber-tint); }
.hmark { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: var(--text); margin-right: 4px; }
.hmark-verified  { background: var(--emerald-tint); color: #065F46; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.hmark-inference { background: var(--blue-tint);    color: #1E3A8A; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.hmark-validate  { background: var(--amber-tint);   color: #92400E; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.tier3 { font-size: 11px; color: var(--amber); }

/* ── Misc tags / flags / money ─────────────────────────────────── */
.extra-tag { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 4px; vertical-align: middle; margin-left: 4px; letter-spacing: 0.02em; text-transform: uppercase; }
.extra-tag-hidden { background: var(--danger); color: #FFFFFF; }
.extra-tag-known  { background: var(--muted);  color: #FFFFFF; }
.money { padding: 12px 14px; margin: 10px 0; background: var(--emerald-tint); border-left: 3px solid var(--emerald); border-radius: 6px; font-size: 13px; }
.money-skip { color: var(--muted); font-size: 13px; }
.flag { padding: 10px 14px; margin: 8px 0; border-left: 3px solid var(--amber); background: var(--amber-tint); border-radius: 6px; }
.flag.critical { border-left-color: var(--danger); background: var(--danger-bg); color: #991B1B; }
.ai-badge { display: inline-block; background: var(--navy); color: #FFFFFF; font-size: 10.5px; font-weight: 700; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.04em; vertical-align: middle; margin-left: 4px; }
.ai-fallback-note { color: var(--muted); margin: 6px 0; }
.classification-reason { font-size: 12px; margin-top: -2px; color: var(--muted); }

/* ── Common problems / coverage / callout ──────────────────────── */
.problem { padding: 14px 16px; margin: 10px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.problem h3 { font-size: 15px; margin: 0 0 6px; }
.coverage { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
.coverage td { padding: 10px 12px; vertical-align: top; border-bottom: 1px solid var(--border); }
.coverage td:first-child { width: 38%; color: var(--muted); }
.coverage tr:last-child td { border-bottom: 0; }
.callout { padding: 14px 16px; margin: 14px 0; border: 1px solid var(--border); background: var(--blue-tint); border-radius: 8px; border-left: 4px solid var(--blue); }
.callout-label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--blue); margin-bottom: 6px; text-transform: uppercase; }
.callout p { margin: 0; line-height: 1.55; }

/* ── Opportunity card (/classify) — emerald left accent ────────── */
.opportunity { padding: 16px 18px; margin: 12px 0; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--emerald); border-radius: 8px; }
.opportunity h3 { margin: 4px 0 6px; font-size: 15px; }
.op-meta { display: flex; gap: 6px; margin-bottom: 4px; align-items: center; flex-wrap: wrap; }
.op-category { display: inline-block; background: var(--navy); color: #FFFFFF; font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.04em; text-transform: uppercase; }
.op-novelty { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.04em; text-transform: uppercase; }
.novelty-unique { background: var(--emerald); color: #FFFFFF; }
.novelty-rare   { background: var(--amber);   color: #FFFFFF; }
.novelty-common { background: var(--muted);   color: #FFFFFF; }

/* ── Market analysis card (/market-analysis) — navy left accent ── */
.mkt-card { padding: 18px 20px; margin: 14px 0; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--navy); border-radius: 8px; }
.mkt-card h3 { font-size: 18px; font-weight: 700; color: var(--navy); margin: 0 0 4px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mkt-rank { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--navy); color: #FFFFFF; font-size: 13px; font-weight: 700; flex-shrink: 0; }
.mkt-card .impact { font-size: 12px; padding: 3px 10px; }

/* The "← new search" link inside report content. The landing page
   wraps the report in its own .result-back top-level button, but
   direct-HTTP fetches still see this link. */
.back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 16px; color: var(--muted); font-size: 13px; font-weight: 500; }
.back:hover { color: var(--blue); }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
</head><body>`;
const PAGE_CLOSE = `</body></html>`;

function renderError(message) {
  return `${PAGE_OPEN}<a class="back" href="/app">&larr; new search</a> <a class="back" href="/dashboard">&larr; Back to Dashboard</a>
<h1>GrowthIM</h1>
<div class="status blocked">Error</div>
<p>${escapeHtml(message)}</p>${PAGE_CLOSE}`;
}

/* OOS demand logging — every out-of-scope hit appended to oos_log.jsonl
   so we can prioritize sub-profile work based on what users actually type.
   Async write (fs.promises.appendFile) — non-blocking; if the write
   rejects we log to stderr but never break the request. */
const fsPromises = fs.promises;
function logOosHit(input, layer0Result, oosVariant) {
  const entry = {
    ts: new Date().toISOString(),
    input,
    naics6: layer0Result.naics6,
    oos_variant: oosVariant,
    layer0_mode: layer0Result.mode,
  };
  fsPromises.appendFile(
    path.join(__dirname, 'oos_log.jsonl'),
    JSON.stringify(entry) + '\n'
  ).catch((err) => {
    console.error('[oos] log write failed:', err.message);
  });
}

function renderWaitlist(input, layer0Result, profileId) {
  let heading, reason, waitlistFooter;
  // NAICS-specific OOS messages — overrides the generic per-profile-id
  // messages below for business types where the generic copy (e.g.,
  // "DEA, pharmacy boards") doesn't apply. Falls through to the switch
  // for any NAICS not in this list.
  const naics6 = (layer0Result && layer0Result.naics6) || '';
  const naics3 = naics6.slice(0, 3);
  if (naics3 === '813') {
    heading = 'Religious / faith-based organizations — out of scope';
    reason = 'Religious and faith-based organizations have unique nonprofit governance, tax-exempt status, and community dynamics that require specialized guidance. GrowthIM currently does not support this sector.';
    waitlistFooter = 'No waitlist for this sector at this time. See the GrowthIM roadmap for future coverage updates.';
  } else if (naics6 === '812930') {
    heading = 'Parking operations — out of scope';
    reason = 'Parking operations involve municipal permits, zoning regulations and real estate dynamics that need specialized advice beyond GrowthIM’s current scope.';
    waitlistFooter = 'No waitlist for this sector at this time. See the GrowthIM roadmap for future coverage updates.';
  } else if (naics6 === '812921' || naics6 === '812922') {
    heading = 'Photo finishing — not currently supported';
    reason = 'This business sector is not currently supported by GrowthIM. We are expanding our coverage regularly.';
    waitlistFooter = 'Sub-profiles for this sector are on the roadmap. Add yourself to the waitlist (signup form coming in a later phase).';
  } else if (naics6 === '459930') {
    heading = 'Manufactured home dealers — out of scope';
    reason = 'Manufactured home dealers operate under HUD regulations and unique financing structures that require specialized advice beyond GrowthIM’s current scope.';
    waitlistFooter = 'No waitlist for this sector at this time. See the GrowthIM roadmap for future coverage updates.';
  } else switch (profileId) {
    case 'OUT_OF_SCOPE_REGULATED':
      heading = 'Regulated sector — waitlist';
      reason = 'This sector has industry-specific licensing or regulatory dynamics (e.g., DEA, state pharmacy/optical boards) that need a dedicated profile rather than the generalized retail/personal-care baseline.';
      waitlistFooter = 'Sub-profiles for this sector are on the roadmap. Add yourself to the waitlist (signup form coming in a later phase).';
      break;
    case 'OUT_OF_SCOPE_NICHE':
      heading = 'Niche sector — waitlist';
      reason = "This sector is a niche operation whose dynamics don't fit our generalized profiles. A future sub-profile will address it.";
      waitlistFooter = 'Sub-profiles for this sector are on the roadmap. Add yourself to the waitlist (signup form coming in a later phase).';
      break;
    case 'OUT_OF_SCOPE_55':
      heading = 'Out of scope — corporate / holding';
      reason = "GrowthIM serves consumer-facing local businesses. Holding companies, regional managing offices, and corporate HQs don't fit that pattern.";
      waitlistFooter = 'No waitlist for this sector — GrowthIM is intentionally not designed to serve this category.';
      break;
    case 'OUT_OF_SCOPE_92':
      heading = 'Out of scope — public administration';
      reason = 'GrowthIM serves private-sector consumer-facing businesses. Government agencies have different operational frameworks.';
      waitlistFooter = 'No waitlist for this sector — GrowthIM is intentionally not designed to serve this category.';
      break;
    default:
      heading = 'Out of scope';
      reason = 'This sector is currently outside GrowthIM\'s scope.';
      waitlistFooter = 'See the GrowthIM roadmap for sectors planned in later phases.';
  }
  return `${PAGE_OPEN}<a class="back" href="/app">&larr; new search</a> <a class="back" href="/dashboard">&larr; Back to Dashboard</a>
<h1>GrowthIM — ${escapeHtml(heading)}</h1>
<div class="status blocked">${escapeHtml(profileId)}</div>
<p>${escapeHtml(reason)}</p>
<p class="meta">Your input "${escapeHtml(input)}" classified to NAICS ${escapeHtml(layer0Result.naics6)}.</p>
<p>${escapeHtml(waitlistFooter)}</p>${PAGE_CLOSE}`;
}

function renderUnsupported(input, layer0Result) {
  return `${PAGE_OPEN}<a class="back" href="/app">&larr; new search</a> <a class="back" href="/dashboard">&larr; Back to Dashboard</a>
<h1>GrowthIM — business type not yet supported</h1>
<p>This business type is not yet supported by GrowthIM. We support 1400+
business types — if you think your input should have matched one of them,
please contact us at <a href="mailto:support@growthim.com">support@growthim.com</a>
and we'll add coverage for your category.</p>
<p class="meta">Your input "${escapeHtml(input)}" was classified as
mode <code>${escapeHtml(layer0Result.mode)}</code>${
    layer0Result.naics6 ? ` (NAICS ${escapeHtml(layer0Result.naics6)})` : ''
  }.</p>${PAGE_CLOSE}`;
}

function renderBlocked(profile, layer0Result, data, blockingFlag) {
  return `${PAGE_OPEN}<a class="back" href="/app">&larr; new search</a> <a class="back" href="/dashboard">&larr; Back to Dashboard</a>
<h1>${escapeHtml(data.name || 'Business')}</h1>
<div class="status blocked">REPORT BLOCKED</div>
<div class="flag critical">${escapeHtml(blockingFlag.message)}</div>
<p class="meta">${escapeHtml(profile.name)} — NAICS ${escapeHtml(layer0Result.naics6)}</p>${PAGE_CLOSE}`;
}

// Render the Market Analysis (Mode 2) report. Takes an options object
// — { city, state, top5, analysis, census, age_profile, weather,
// permits, walk_score, county_density } — produced by the route
// pipeline. Re-uses the standard PAGE_OPEN chrome + back link so the
// page is visually consistent with renderReport / renderError.
function renderMarketReport(result) {
  // Tier 5 output renderer for the new 5-tier pipeline. Receives the
  // result object from claudeMarketAnalyst.analyzeCity() with shape:
  //   { city, state, location, top10[], deep_dive{}, raw{}, _agents{} }
  // Renders 5 sections: Header → Snapshot → Top 10 → Deep Dive → Chat.

  const r = result || {};
  const city = r.city || '';
  const state = r.state || '';
  const top10 = Array.isArray(r.top10) ? r.top10 : [];
  const dive = r.deep_dive || null;
  const raw = r.raw || {};
  const verifications = Array.isArray(r._quote_verification) ? r._quote_verification : [];

  const safeCity = escapeHtml(city);
  const safeState = escapeHtml(String(state || '').toUpperCase());

  // ── Quote-provenance helpers ───────────────────────────────────────
  // Look up a quote in the verification array by exact evidence string.
  // The verifier stores `quote: a.evidence` so a strict equality match
  // is reliable. Returns one of: 'verified' | 'fabricated' | 'unverified'.
  function quoteStatus(evidenceText) {
    if (!evidenceText || !verifications.length) return { tier: 'unverified' };
    const v = verifications.find((x) => x && x.quote === evidenceText);
    if (!v) return { tier: 'unverified' };
    if (v.verified === true) return {
      tier: 'verified',
      author: v.matched_author || null,
      time: v.matched_time || null,
      business: v.matched_business || null,
    };
    if (v.verified === false) return { tier: 'fabricated', reason: v.reason || null };
    return { tier: 'unverified', reason: v.reason || null };
  }
  // Render the per-quote badge. Verified = green with author/time;
  // fabricated = red warning; unverified = muted neutral.
  function quoteBadge(evidenceText) {
    const s = quoteStatus(evidenceText);
    if (s.tier === 'verified') {
      const meta = [s.author, s.time].filter(Boolean).join(', ');
      const label = meta ? `&#10003; REAL REVIEW &mdash; ${escapeHtml(meta)}` : '&#10003; REAL REVIEW';
      return `<span class="hmark hmark-verified">${label}</span>`;
    }
    if (s.tier === 'fabricated') {
      return `<span class="hmark" style="background:var(--danger-bg);color:#991B1B;padding:2px 8px;border-radius:4px;font-size:11px">&#9888; NOT FOUND IN FETCHED REVIEWS</span>`;
    }
    return `<span class="hmark" style="background:var(--surface-soft);color:var(--muted);padding:2px 8px;border-radius:4px;font-size:11px">REVIEW &mdash; unverified</span>`;
  }
  // Tier-driven wrapper class so the surrounding box colour matches
  // the badge (green for verified, red for fabricated, amber for the
  // ambiguous 'too short to verify' case).
  function quoteHonestyClass(evidenceText) {
    const s = quoteStatus(evidenceText);
    if (s.tier === 'verified') return 'honesty honesty-verified';
    if (s.tier === 'fabricated') return 'honesty';   // wrapper neutral; red is in the badge
    return 'honesty honesty-customer-must-validate';
  }

  // ─────────────────────────────────────────────────────────────────
  // SECTION 1 — HEADER
  // ─────────────────────────────────────────────────────────────────
  let healthBadge = '';
  let gradeBadge = '';
  if (dive && typeof dive.health_score === 'number') {
    const sc = dive.health_score;
    const tier = sc >= 70 ? 'high' : sc >= 40 ? 'medium' : 'low';
    healthBadge = `<span class="impact impact-${tier}" style="margin-left:8px">${sc}/100${dive.health_label ? ' · ' + escapeHtml(dive.health_label) : ''}</span>`;
  }
  if (dive && dive.market_grade) {
    gradeBadge = `<span class="impact impact-medium" style="margin-left:6px">Grade ${escapeHtml(dive.market_grade)}</span>`;
  }
  const execSummary = dive && dive.executive_summary
    ? `<div class="callout">
<div class="callout-label">Top opportunity for ${safeCity}, ${safeState}</div>
<p>${escapeHtml(dive.executive_summary)}</p>
</div>`
    : '';
  const sources = dive && Array.isArray(dive.data_sources_used) && dive.data_sources_used.length
    ? dive.data_sources_used
    : ['Google Places', 'US Census', 'BLS BED2013', 'HUD FMR', 'Open-Meteo', 'Wikipedia', 'Ticketmaster', 'Claude AI'];
  const sourcesHtml = `<p class="meta">Powered by: ${sources.map((s) => escapeHtml(s)).join(' · ')}</p>`;

  const headerHtml = `<a class="back" href="/app">&larr; Start over</a> <a class="back" href="/dashboard">&larr; Back to Dashboard</a>
<h1>Market Intelligence — ${safeCity}, ${safeState}${healthBadge}${gradeBadge}</h1>
${sourcesHtml}
${execSummary}`;

  // ─────────────────────────────────────────────────────────────────
  // SECTION 2 — MARKET SNAPSHOT (6 cards)
  // ─────────────────────────────────────────────────────────────────
  const fmtNum = (v) => (typeof v === 'number') ? v.toLocaleString('en-US') : 'N/A';
  const fmtUsd = (v) => (typeof v === 'number') ? '$' + v.toLocaleString('en-US') : 'N/A';
  const snapshotRows = [
    ['Population', fmtNum(raw.population)],
    ['Median income', fmtUsd(raw.median_income)],
    ['Age profile', escapeHtml(raw.age_profile || 'N/A')],
    ['Peak season', escapeHtml(raw.peak_month || 'N/A')],
    ['Permits YoY', (typeof raw.permits_yoy === 'number') ? `${raw.permits_yoy}% (${raw.growth_signal || 'stable'})` : 'N/A'],
    ['2BR FMR', raw.fmr_2br ? `$${raw.fmr_2br}/mo${raw.fmr_metro ? ' · ' + escapeHtml(raw.fmr_metro) : ''}` : 'N/A'],
  ];
  const snapshotHtml = `<h2>Market snapshot</h2>
<table class="coverage">${snapshotRows.map(
    ([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${v}</td></tr>`
  ).join('')}</table>`;

  // ─────────────────────────────────────────────────────────────────
  // SECTION 3 — TOP 10 BUSINESS IDEAS
  // Each card: rank badge + business type + score breakdown bars
  // (gap/feasibility/growth) + competitor count + novelty + cost +
  // 5-year survival + why_this_city paragraph.
  // ─────────────────────────────────────────────────────────────────
  const renderScoreBar = (label, val, color) => {
    const pct = Math.round((val || 0) * 100);
    return `<div style="margin:4px 0">
<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:2px"><span>${escapeHtml(label)}</span><span><strong style="color:var(--text)">${pct}%</strong></span></div>
<div style="background:var(--surface-soft);border-radius:4px;height:6px;overflow:hidden"><div style="background:${color};width:${pct}%;height:100%"></div></div>
</div>`;
  };
  // ── Tiered insight matchers (by rank, not array index, so a re-sort
  // upstream doesn't misalign cards). tier2_insights covers ranks 2-5;
  // tier3_insights covers ranks 6-10. If Claude returned the old format
  // these arrays will be empty and the per-card render gracefully omits
  // the extra block.
  const tier2Insights = (dive && Array.isArray(dive.tier2_insights)) ? dive.tier2_insights : [];
  const tier3Insights = (dive && Array.isArray(dive.tier3_insights)) ? dive.tier3_insights : [];
  function findTierInsight(rank, arr) {
    if (!Array.isArray(arr)) return null;
    return arr.find((t) => t && t.rank === rank) || null;
  }
  function styleTags(text) {
    return String(text || '')
      .replace(/\[VERIFIED\]/g, '<span class="hmark hmark-verified">[VERIFIED]</span>')
      .replace(/\[CUSTOMER MUST VALIDATE\]/g, '<span class="hmark hmark-validate">[CUSTOMER MUST VALIDATE]</span>')
      .replace(/\[REASONABLE INFERENCE\]/g, '<span class="hmark hmark-inference">[REASONABLE INFERENCE]</span>')
      .replace(/\[INDUSTRY BENCHMARK[^\]]*\]/g, '<span class="hmark hmark-inference">$&</span>')
      .replace(/\[SOURCE: [^\]]+\]/g, '<span class="hmark hmark-inference">$&</span>');
  }

  const top10Html = top10.length
    ? top10.map((s, i) => {
        const rank = s.rank || (i + 1);
        const finalPct = Math.round((s.final_score || 0) * 100);
        const tier = i === 0 ? 'high' : (i <= 2 ? 'medium' : 'low');
        const noveltyTier = s.novelty_score >= 8 ? 'novelty-unique'
                          : s.novelty_score >= 5 ? 'novelty-rare'
                                                  : 'novelty-common';
        const compText = s.competitor_count == null
          ? 'Places lookup unavailable'
          : (s.competitor_count === 0
              ? '<strong>ZERO competitors</strong> in this market'
              : `${s.competitor_count} ${s.competitor_count === 1 ? 'competitor' : 'competitors'} nearby`);
        const competitorList = (s.top_competitors || []).slice(0, 3)
          .map((c) => escapeHtml(c.name || ''))
          .filter(Boolean)
          .join(', ');
        const styledWhy = styleTags(s.why_this_city || '');

        const breakdown = s.score_breakdown || {};
        const bars = `
${renderScoreBar('Gap (40%)', breakdown.gap_score, 'var(--emerald)')}
${renderScoreBar('Feasibility (35%)', breakdown.feasibility_score, 'var(--blue)')}
${renderScoreBar('Growth (25%)', breakdown.growth_score, 'var(--amber)')}`;

        // ── Tier 1 winner card — gold border + scroll-link to deep dive
        const isWinner = rank === 1;
        const winnerStyle = isWinner
          ? ' style="border-left:6px solid var(--amber);box-shadow:0 0 0 2px var(--amber-tint)"'
          : '';
        const winnerLink = isWinner
          ? `<p style="margin:14px 0 0"><a href="#deep-dive-anchor" style="display:inline-block;padding:8px 16px;background:var(--amber);color:#fff;border-radius:6px;font-weight:600;text-decoration:none">&darr; Full deep dive below</a></p>`
          : '';

        // ── Tier 2 (ranks 2-5) — medium-depth block
        let tier2Block = '';
        if (rank >= 2 && rank <= 5) {
          const t2 = findTierInsight(rank, tier2Insights);
          if (t2) {
            const actions = Array.isArray(t2.top_3_actions) ? t2.top_3_actions : [];
            const steps = Array.isArray(t2.startup_steps) ? t2.startup_steps : [];
            tier2Block = `<div style="margin-top:14px;padding:12px 14px;background:var(--surface-soft);border-radius:6px">
${t2.why_now ? `<p style="margin:0 0 10px"><strong>Why now in ${safeCity}:</strong> ${styleTags(t2.why_now)}</p>` : ''}
${actions.length ? `<p style="margin:0 0 4px"><strong>First 3 actions:</strong></p>
<ol style="margin:0 0 10px;padding-left:22px">
${actions.slice(0, 3).map((a) => `<li>${escapeHtml(a.action || '—')} <span class="meta">— ${escapeHtml(a.cost || '$?')} · ${escapeHtml(a.timeline || 'TBD')}</span></li>`).join('')}
</ol>` : ''}
${steps.length ? `<p style="margin:0 0 4px"><strong>Startup steps:</strong></p>
<ol style="margin:0 0 10px;padding-left:22px">
${steps.slice(0, 3).map((step) => `<li>${escapeHtml(String(step))}</li>`).join('')}
</ol>` : ''}
${t2.key_risk ? `<p style="margin:0;color:var(--danger)"><strong>Key risk:</strong> ${styleTags(t2.key_risk)}</p>` : ''}
</div>`;
          }
        }

        // ── Tier 3 (ranks 6-10) — light block, muted
        let tier3Block = '';
        if (rank >= 6 && rank <= 10) {
          const t3 = findTierInsight(rank, tier3Insights);
          if (t3) {
            tier3Block = `<div style="margin-top:14px;padding:10px 12px;background:var(--surface-soft);border-radius:6px;font-size:13px">
${t3.why_now ? `<p style="margin:0 0 6px;color:var(--text)">${styleTags(t3.why_now)}</p>` : ''}
${t3.key_risk ? `<p style="margin:0;color:var(--muted)"><strong>Risk:</strong> ${styleTags(t3.key_risk)}</p>` : ''}
</div>`;
          }
        }

        return `<div class="mkt-card"${winnerStyle}>
<h3><span class="mkt-rank">${rank}</span> ${escapeHtml(s.business_type || 'Opportunity')} <span class="impact impact-${tier}">${finalPct}%</span> <span class="op-novelty ${noveltyTier}">novelty ${s.novelty_score || '?'}/10</span></h3>
${styledWhy ? `<p>${styledWhy}</p>` : ''}
<table class="coverage" style="margin-top:8px">
<tr><td>Competition</td><td>${compText}${competitorList ? ' <span class="meta">(' + competitorList + ')</span>' : ''}</td></tr>
<tr><td>Startup cost</td><td><strong>${escapeHtml(s.startup_cost_range || '—')}</strong></td></tr>
<tr><td>5-year survival</td><td><strong>${escapeHtml(s.survival_y5 || '—')}</strong>${s.naics2 ? ` <span class="meta">(NAICS ${escapeHtml(s.naics2)})</span>` : ''}</td></tr>
</table>
<div style="margin-top:10px">${bars}</div>
${tier2Block}
${tier3Block}
${winnerLink}
</div>`;
      }).join('')
    : '<p>No opportunities scored.</p>';

  const top10Section = `<h2>Top 10 business ideas</h2>
<p class="meta">Ranked by composite score: gap × 0.40 + feasibility × 0.35 + growth × 0.25.</p>
${top10Html}`;

  // ─────────────────────────────────────────────────────────────────
  // SECTION 4 — DEEP DIVE on #1
  // Pulls the merged Call-A + Call-B fields from analyzeCity's
  // generateDeepDive(). Each subsection renders only when present.
  // ─────────────────────────────────────────────────────────────────
  let deepDiveHtml = '';
  if (dive) {
    const top1Type = (top10[0] && top10[0].business_type) || 'top-ranked business';

    // SBA risk
    let sbaRiskHtml = '';
    if (dive.sba_risk) {
      const sr = dive.sba_risk;
      const riskTier = (sr.risk_level || '').toLowerCase() === 'low' ? 'high'
                     : (sr.risk_level || '').toLowerCase() === 'high' ? 'low'
                     : 'medium';
      sbaRiskHtml = `<h3>Sector survival outlook</h3>
<div class="rec rec-${riskTier}">
<h3>${escapeHtml(sr.best_sector || 'Top sector')} <span class="impact impact-${riskTier}">${escapeHtml(sr.risk_level || '—')} RISK</span></h3>
<table class="coverage">
  <tr><td>1-year survival</td><td><strong>${escapeHtml(sr.year1_survival || '—')}</strong></td></tr>
  <tr><td>3-year survival</td><td><strong>${escapeHtml(sr.year3_survival || '—')}</strong></td></tr>
  <tr><td>5-year survival</td><td><strong>${escapeHtml(sr.year5_survival || '—')}</strong></td></tr>
  <tr><td>10-year survival</td><td><strong>${escapeHtml(sr.year10_survival || '—')}</strong></td></tr>
</table>
${sr.context ? `<p>${escapeHtml(sr.context)}</p>` : ''}
<p class="meta"><small>Source: BLS Business Employment Dynamics, 2013 cohort tracked through 2023</small></p>
</div>`;
    }

    // Top opportunities (specific named launches for #1)
    let topOppsHtml = '';
    if (Array.isArray(dive.top_opportunities) && dive.top_opportunities.length) {
      topOppsHtml = `<h3>Top tactical opportunities</h3>
<p class="meta">Specific launches with named local sources.</p>` +
        dive.top_opportunities.map((o, i) => `
<div class="opportunity">
<div class="op-meta">
<span class="op-category">#${o.rank || (i + 1)}</span>
${typeof o.novelty_score === 'number' ? `<span class="op-novelty ${o.novelty_score >= 8 ? 'novelty-unique' : o.novelty_score >= 5 ? 'novelty-rare' : 'novelty-common'}">novelty ${o.novelty_score}/10</span>` : ''}
${typeof o.final_rank === 'number' ? `<span class="op-novelty novelty-common">rank ${o.final_rank}</span>` : ''}
</div>
<h3>${escapeHtml(o.title || 'Opportunity')}</h3>
${o.business_type ? `<p class="meta">${escapeHtml(o.business_type)}</p>` : ''}
${o.what_to_build ? `<p><strong>What to build:</strong> ${escapeHtml(o.what_to_build)}</p>` : ''}
${o.local_source ? `<p><strong>Local source:</strong> ${escapeHtml(o.local_source)}</p>` : ''}
${o.how_to_start ? `<p><strong>How to start:</strong> ${escapeHtml(o.how_to_start)}</p>` : ''}
<p class="meta">${o.cost_to_open ? 'Cost: <strong>' + escapeHtml(o.cost_to_open) + '</strong>' : ''}${o.monthly_revenue_est ? (o.cost_to_open ? ' · ' : '') + 'Revenue: <strong>' + escapeHtml(o.monthly_revenue_est) + '</strong>' : ''}</p>
${o.bed2013_risk ? `<p class="meta">Risk: ${escapeHtml(o.bed2013_risk)}</p>` : ''}
</div>`).join('');
    }

    // Quick wins
    let quickWinsHtml = '';
    if (Array.isArray(dive.quick_wins) && dive.quick_wins.length) {
      quickWinsHtml = `<h3>Quick wins — do these this week</h3>` + dive.quick_wins.map((q) => `
<div class="rec rec-medium">
<h3>${escapeHtml(q.action || 'Action')} <span class="impact impact-medium">${escapeHtml(q.timeline || 'Today')}</span></h3>
${q.why ? `<p>${escapeHtml(q.why)}</p>` : ''}
<p class="meta">Cost: <strong>${escapeHtml(q.cost || '$0')}</strong>${q.expected_result ? ` · Expected: ${escapeHtml(q.expected_result)}` : ''}</p>
</div>`).join('');
    }

    // Steal strategy
    let stealHtml = '';
    if (Array.isArray(dive.steal_strategy) && dive.steal_strategy.length) {
      stealHtml = `<h3>Steal strategy <span class="ai-badge">AI</span></h3>
<p class="meta">What's working for local businesses — with the actual review evidence.</p>` +
        dive.steal_strategy.map((s) => {
          const actions = Array.isArray(s.actions_to_steal) ? s.actions_to_steal : [];
          return `<div class="rec rec-high">
<h3>${escapeHtml(s.business_name || 'Business')} <span class="impact impact-${(s.confidence || '').toLowerCase() === 'high' ? 'high' : 'medium'}">${escapeHtml(s.confidence || '—')}</span></h3>
<p class="meta">${s.tenure ? 'Tenure: ' + escapeHtml(s.tenure) + ' · ' : ''}Trust weight: ${typeof s.trust_weight === 'number' ? s.trust_weight.toFixed(2) : '—'}</p>
${s.what_they_do_well ? `<p><strong>What they do well:</strong> ${escapeHtml(s.what_they_do_well)}</p>` : ''}
<ol style="margin:8px 0 0;padding-left:24px">
${actions.map((a) => `<li style="margin:8px 0">
<strong>${escapeHtml(a.action || 'Action')}</strong>
${a.evidence ? `<div class="${quoteHonestyClass(a.evidence)}" style="margin:4px 0">${quoteBadge(a.evidence)} <em>${escapeHtml(a.evidence)}</em></div>` : ''}
${a.how_to_implement ? `<p style="margin:4px 0">How: ${escapeHtml(a.how_to_implement)}</p>` : ''}
${a.cost ? `<p class="meta" style="margin:2px 0">Cost: ${escapeHtml(a.cost)}</p>` : ''}
</li>`).join('')}
</ol>
</div>`;
        }).join('');
    }

    // Hidden gaps (high priority — local-specific)
    let hiddenGapsHtml = '';
    if (Array.isArray(dive.hidden_gaps) && dive.hidden_gaps.length) {
      hiddenGapsHtml = `<h3>Hidden gaps — high priority</h3>
<p class="meta">Problems unique to ${safeCity} — not universal.</p>` + dive.hidden_gaps.map((h) => `
<div class="flag critical">
<h3>${escapeHtml(h.title || 'Gap')}</h3>
${h.evidence ? `<p class="meta">${quoteBadge(h.evidence)} ${escapeHtml(h.evidence)}</p>` : ''}
${h.why_hidden ? `<p>${escapeHtml(h.why_hidden)}</p>` : ''}
${h.business_to_open ? `<p><strong>Business to open:</strong> ${escapeHtml(h.business_to_open)}</p>` : ''}
<p class="meta">${h.timeline ? escapeHtml(h.timeline) + ' · ' : ''}Cost: ${escapeHtml(h.cost_to_open || '—')}</p>
</div>`).join('');
    }

    // Persona gap matrix
    let gapMatrixHtml = '';
    if (Array.isArray(dive.persona_gap_matrix) && dive.persona_gap_matrix.length) {
      gapMatrixHtml = `<h3>Persona gap matrix</h3>
<p class="meta">Customer segments mentioned in reviews but no business specifically targets.</p>
<table class="coverage">
<tr><td><strong>Segment</strong></td><td><strong>% of reviews</strong></td><td><strong>Serving them</strong></td><td><strong>Gap</strong></td><td><strong>Lost rev/mo</strong></td></tr>
${dive.persona_gap_matrix.map((g) => `<tr>
<td>${escapeHtml(g.segment || '—')}${g.confirmed ? ' <span class="hmark hmark-verified">CONFIRMED</span>' : ''}</td>
<td>${escapeHtml(g.review_mention_pct || '—')}</td>
<td>${typeof g.businesses_serving_them === 'number' ? g.businesses_serving_them : '—'}</td>
<td><strong>${typeof g.gap_points === 'number' ? g.gap_points + ' pts' : '—'}</strong></td>
<td>${escapeHtml(g.lost_revenue_est || '—')}</td>
</tr>`).join('')}
</table>` + dive.persona_gap_matrix.filter((g) => g.business_to_open || g.root_cause).map((g) => `
<div class="honesty honesty-reasonable-inference">
<p><strong>${escapeHtml(g.segment || '—')}:</strong> ${escapeHtml(g.root_cause || '')}</p>
${g.business_to_open ? `<p>→ <strong>Open:</strong> ${escapeHtml(g.business_to_open)}</p>` : ''}
</div>`).join('');
    }

    // Personas (4 cards)
    let personasHtml = '';
    if (Array.isArray(dive.personas) && dive.personas.length) {
      personasHtml = `<h3>Customer personas</h3>` + dive.personas.map((p) => `
<div class="rec rec-medium">
<h3>${escapeHtml(p.name || 'Persona')}</h3>
<p class="meta">${escapeHtml(p.profile || '—')}${p.gap_source ? ' · Gap source: ' + escapeHtml(p.gap_source) : ''}</p>
${p.review_source ? `<div class="${quoteHonestyClass(p.review_source)}" style="margin:6px 0">${quoteBadge(p.review_source)} ${escapeHtml(p.review_source)}</div>` : ''}
<table class="coverage">
${p.spend_trigger ? `<tr><td>Spend trigger</td><td>${escapeHtml(p.spend_trigger)}</td></tr>` : ''}
${p.five_star_trigger ? `<tr><td><span class="hmark hmark-verified">5-star trigger</span></td><td>${escapeHtml(p.five_star_trigger)}</td></tr>` : ''}
${p.word_of_mouth_trigger ? `<tr><td>Word-of-mouth</td><td>${escapeHtml(p.word_of_mouth_trigger)}</td></tr>` : ''}
${p.never_returns_if ? `<tr><td><span class="hmark" style="background:var(--danger-bg);color:#991B1B;padding:2px 8px;border-radius:4px">Never returns if</span></td><td>${escapeHtml(p.never_returns_if)}</td></tr>` : ''}
${p.searches ? `<tr><td>Searches</td><td><em>"${escapeHtml(p.searches)}"</em></td></tr>` : ''}
${p.ltv ? `<tr><td>LTV</td><td><strong>${escapeHtml(p.ltv)}</strong></td></tr>` : ''}
${p.reach_via ? `<tr><td>Reach via</td><td>${escapeHtml(p.reach_via)}</td></tr>` : ''}
</table>
</div>`).join('');
    }

    // Lost customer
    let lostCustomerHtml = '';
    if (dive.lost_customer && (dive.lost_customer.name || dive.lost_customer.fix)) {
      const lc = dive.lost_customer;
      lostCustomerHtml = `<h3>Who's driving past ${safeCity} right now</h3>
<div class="callout">
<div class="callout-label">${escapeHtml(lc.name || 'Customer')}</div>
${lc.profile ? `<p>${escapeHtml(lc.profile)}</p>` : ''}
${lc.gap_proof ? `<p class="meta"><span class="hmark hmark-verified">[GAP PROOF]</span> ${escapeHtml(lc.gap_proof)}</p>` : ''}
${lc.drives_to ? `<p class="meta">Drives to: <strong>${escapeHtml(lc.drives_to)}</strong></p>` : ''}
${lc.lost_revenue ? `<p class="meta">Lost revenue: <strong>${escapeHtml(lc.lost_revenue)}</strong></p>` : ''}
${lc.root_cause ? `<p><strong>Root cause:</strong> ${escapeHtml(lc.root_cause)}</p>` : ''}
${lc.fix ? `<p>→ <strong>Fix:</strong> ${escapeHtml(lc.fix)}</p>` : ''}
</div>`;
    }

    // Seasonal strategy (4 seasons)
    let seasonalHtml = '';
    if (dive.seasonal_strategy && typeof dive.seasonal_strategy === 'object') {
      const seasons = ['summer', 'fall', 'winter', 'spring'];
      const seasonCards = seasons
        .map((season) => dive.seasonal_strategy[season] && [season, dive.seasonal_strategy[season]])
        .filter(Boolean);
      if (seasonCards.length) {
        seasonalHtml = `<h3>Seasonal strategy</h3>` + seasonCards.map(([season, s]) => {
          const isZeroComp = s.opportunity_window && /zero competition/i.test(s.opportunity_window);
          const zeroBadge = isZeroComp ? ` <span class="impact impact-high">ZERO COMPETITION WINDOW</span>` : '';
          return `<div class="rec rec-medium">
<h3>${season.charAt(0).toUpperCase() + season.slice(1)}${s.dominant_persona ? ` <span class="meta">— ${escapeHtml(s.dominant_persona)}</span>` : ''}${zeroBadge}</h3>
${s.best_business_to_open ? `<p><strong>Business to open:</strong> ${escapeHtml(s.best_business_to_open)}</p>` : ''}
${s.marketing_message ? `<p><strong>Headline:</strong> "${escapeHtml(s.marketing_message)}"</p>` : ''}
${s.event_tie_in ? `<p><strong>Event tie-in:</strong> ${escapeHtml(s.event_tie_in)}</p>` : ''}
${s.local_partner ? `<p><strong>Local partner:</strong> ${escapeHtml(s.local_partner)}</p>` : ''}
${s.revenue_range ? `<p class="meta">Revenue: <strong>${escapeHtml(s.revenue_range)}</strong></p>` : ''}
${s.off_season_survival ? `<div class="honesty honesty-customer-must-validate"><p><strong>Off-season survival:</strong> ${escapeHtml(s.off_season_survival)}</p></div>` : ''}
</div>`;
        }).join('');
      }
    }

    // Hyper-local
    let hyperLocalHtml = '';
    if (dive.hyper_local && typeof dive.hyper_local === 'object') {
      const hl = dive.hyper_local;
      const renderArr = (arr, fmt) => Array.isArray(arr) && arr.length
        ? `<ul>${arr.map(fmt).join('')}</ul>`
        : '';
      // Producers may be strings or objects depending on Claude's output.
      const fmtProducer = (p) => typeof p === 'string'
        ? `<li>${escapeHtml(p)}</li>`
        : `<li><strong>${escapeHtml(p.name || '—')}</strong>${p.city ? ' (' + escapeHtml(p.city) + ')' : ''}${typeof p.distance_miles === 'number' ? ` — ${p.distance_miles} mi` : ''}: ${escapeHtml(p.product || '—')}${p.price ? ' · ' + escapeHtml(p.price) : ''}</li>`;
      const fmtAttract = (a) => typeof a === 'string'
        ? `<li>${escapeHtml(a)}</li>`
        : `<li><strong>${escapeHtml(a.name || '—')}</strong>${typeof a.distance_miles === 'number' ? ` — ${a.distance_miles} mi` : ''}${a.annual_visitors ? ': ' + escapeHtml(a.annual_visitors) : ''}</li>`;
      const fmtEvent = (e) => typeof e === 'string'
        ? `<li>${escapeHtml(e)}</li>`
        : `<li><strong>${escapeHtml(e.name || '—')}</strong>${e.timing ? ' (' + escapeHtml(e.timing) + ')' : ''}${e.attendance ? ': ' + escapeHtml(e.attendance) : ''}</li>`;
      const fmtPartner = (p) => typeof p === 'string'
        ? `<li>${escapeHtml(p)}</li>`
        : `<li><strong>${escapeHtml(p.name || '—')}</strong>${typeof p.rating === 'number' ? ` ${p.rating}★` : ''}${typeof p.distance_miles === 'number' ? ` · ${p.distance_miles} mi` : ''}: ${escapeHtml(p.angle || '—')}</li>`;
      const producersHtml = renderArr(hl.named_producers, fmtProducer);
      const attractionsHtml = renderArr(hl.named_attractions, fmtAttract);
      const eventsHtml = renderArr(hl.named_events, fmtEvent);
      const partnersHtml = renderArr(hl.partnership_targets, fmtPartner);

      if (hl.state_identity || hl.city_identity || producersHtml || attractionsHtml || eventsHtml || partnersHtml) {
        hyperLocalHtml = `<h3>Hyper-local intelligence</h3>
${hl.city_identity ? `<p><strong>${safeCity}:</strong> ${escapeHtml(hl.city_identity)}</p>` : ''}
${hl.state_identity ? `<p><strong>${safeState}:</strong> ${escapeHtml(hl.state_identity)}</p>` : ''}
${producersHtml ? `<h3 style="margin-top:1em;font-size:14px">Named producers (within 60 mi)</h3>${producersHtml}` : ''}
${attractionsHtml ? `<h3 style="margin-top:1em;font-size:14px">Named attractions</h3>${attractionsHtml}` : ''}
${eventsHtml ? `<h3 style="margin-top:1em;font-size:14px">Named events</h3>${eventsHtml}` : ''}
${partnersHtml ? `<h3 style="margin-top:1em;font-size:14px">Partnership targets</h3>${partnersHtml}` : ''}`;
      }
    }

    // Known gaps (bottom — universal)
    let knownGapsHtml = '';
    if (Array.isArray(dive.known_gaps) && dive.known_gaps.length) {
      knownGapsHtml = `<h3 style="opacity:0.7">Known gaps — universal complaints</h3>
<p class="meta">Common across most markets; address but don't lead.</p>
<ul style="opacity:0.85">${dive.known_gaps.map((k) =>
        `<li><strong>${escapeHtml(k.title || '—')}:</strong> ${escapeHtml(k.one_line_opportunity || '—')}</li>`
      ).join('')}</ul>`;
    }

    // Confidence footer
    let confidenceHtml = '';
    if (dive.confidence) {
      const c = dive.confidence;
      const tier = (c.level || '').toLowerCase() === 'high' ? 'high'
                 : (c.level || '').toLowerCase() === 'low' ? 'low'
                 : 'medium';
      confidenceHtml = `<p class="meta"><span class="impact impact-${tier}">${escapeHtml(c.level || '—')} CONFIDENCE</span>${typeof c.score === 'number' ? ` · score ${c.score.toFixed(2)}` : ''}${typeof c.sources_confirmed === 'number' ? ` · ${c.sources_confirmed} sources` : ''}${c.note ? ' · ' + escapeHtml(c.note) : ''}</p>`;
    }

    const legendBox = `<div class="rec rec-minimal" style="background:var(--surface-soft);font-size:13px;margin:12px 0">
<h3 style="font-size:13px;color:var(--muted);margin-bottom:8px">About this analysis</h3>
<p style="margin:4px 0"><span class="hmark hmark-verified">[VERIFIED]</span> &mdash; confirmed from live Google Places, U.S. Census, BLS, HUD, Open-Meteo, or Wikipedia data.</p>
<p style="margin:4px 0"><span class="hmark hmark-validate">[CUSTOMER MUST VALIDATE]</span> &mdash; our best intelligence; verify before acting.</p>
<p style="margin:4px 0"><span class="hmark hmark-verified">&#10003; REAL REVIEW</span> &mdash; quote substring-matched against the live Google Place Details review text we fetched for this city.</p>
<p style="margin:4px 0"><span class="hmark" style="background:var(--danger-bg);color:#991B1B;padding:2px 8px;border-radius:4px;font-size:11px">&#9888; NOT FOUND IN FETCHED REVIEWS</span> &mdash; quote could not be matched to any fetched review; treat as unverified.</p>
<p class="meta" style="margin:8px 0 0">Persona names are illustrative (fictional). Review quotes are verified live; failed verifications are flagged.</p>
</div>`;
    // ── Verification summary line — appended at the end of the deep dive
    const verifTotal = verifications.length;
    const verifPassed = verifications.filter((v) => v && v.verified === true).length;
    const verifFailed = verifications.filter((v) => v && v.verified === false).length;
    const verifSkipped = verifications.filter((v) => v && v.verified === null).length;
    const verifSummary = verifTotal > 0
      ? `<p class="meta" style="margin-top:18px;padding:10px 12px;background:var(--surface-soft);border-radius:6px"><strong>${verifPassed} of ${verifTotal}</strong> review quotes verified against live Google data.${verifFailed > 0 ? ` <span style="color:var(--danger);font-weight:600">${verifFailed} could not be verified.</span>` : ''}${verifSkipped > 0 ? ` <span class="meta">${verifSkipped} were too short to verify.</span>` : ''}</p>`
      : '';
    deepDiveHtml = `<h2 id="deep-dive-anchor">Deep dive — #1: ${escapeHtml(top1Type)}</h2>
${legendBox}
${sbaRiskHtml}
${topOppsHtml}
${quickWinsHtml}
${stealHtml}
${hiddenGapsHtml}
${gapMatrixHtml}
${personasHtml}
${lostCustomerHtml}
${seasonalHtml}
${hyperLocalHtml}
${knownGapsHtml}
${confidenceHtml}
${verifSummary}`;
  } else {
    deepDiveHtml = `<h2>Deep dive</h2>
<p class="ai-fallback-note">Deep dive analysis unavailable — Claude AI did not return a usable response. Top 10 ranking is still based on real data.</p>`;
  }

  // ─────────────────────────────────────────────────────────────────
  // SECTION 5 — FOLLOW-UP CHAT
  // Embedded form + inline JS that POSTs to /market-chat. Uses
  // data-* attributes to know which city|state to look up.
  // ─────────────────────────────────────────────────────────────────
  // Audit fix S1 — use the file-wide escapeHtml() helper instead of a
  // bespoke replace that only handles `"`. escapeHtml escapes &, <, >,
  // ", and ' so a city containing any HTML-special char (Madison's,
  // O'Brien, "St. John's", an injected `<` etc.) renders into the
  // data-* attributes without closing them. The downstream inline
  // chat script reads via form.dataset.city / form.dataset.state —
  // the browser auto-decodes the HTML entities on read, so the JS
  // sees the same string the user typed.
  const chatHtml = `<h2>Ask a follow-up</h2>
<p class="meta">Ask anything about this analysis — Claude has the full data above in memory for the next 24 hours.</p>
<div id="market-chat-log" style="margin:8px 0"></div>
<form id="market-chat-form" data-city="${escapeHtml(city)}" data-state="${escapeHtml(state)}" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
<input id="market-chat-input" type="text" placeholder="e.g. Why is the gap score lower for #5?" style="flex:1;min-width:240px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px" required>
<button type="submit" id="market-chat-btn" style="padding:10px 18px;background:var(--blue);color:#fff;border:0;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer">Ask &rarr;</button>
</form>
<script>
(function () {
  var form = document.getElementById('market-chat-form');
  if (!form) return;
  var log = document.getElementById('market-chat-log');
  var input = document.getElementById('market-chat-input');
  var btn = document.getElementById('market-chat-btn');
  function bubble(text, who) {
    var d = document.createElement('div');
    d.style.cssText = 'margin:8px 0;padding:12px 14px;border-radius:8px;border:1px solid var(--border);background:' +
      (who === 'user' ? 'var(--blue-tint)' : 'var(--surface)') + ';';
    var label = document.createElement('div');
    label.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin-bottom:4px';
    label.textContent = who === 'user' ? 'You' : 'GrowthIM';
    var p = document.createElement('div');
    p.style.cssText = 'white-space:pre-wrap;line-height:1.5';
    p.textContent = text;
    d.appendChild(label);
    d.appendChild(p);
    log.appendChild(d);
    log.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    bubble(q, 'user');
    input.value = '';
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      var res = await fetch('/market-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: form.dataset.city,
          state: form.dataset.state,
          question: q,
        }),
      });
      var json = await res.json();
      if (!res.ok || json.error) {
        bubble('Error: ' + (json.error || 'request failed'), 'assistant');
      } else {
        bubble(json.answer || '(no answer returned)', 'assistant');
      }
    } catch (err) {
      bubble('Network error: ' + err.message, 'assistant');
    }
    btn.disabled = false; btn.textContent = 'Ask →';
    input.focus();
  });
})();
</script>`;

  // ── Final assembly ─────────────────────────────────────────────────
  return `${PAGE_OPEN}${headerHtml}
${snapshotHtml}
${top10Section}
${deepDiveHtml}
${chatHtml}
<p class="meta" style="margin-top:24px"><small>Generated ${new Date().toISOString()}</small></p>${PAGE_CLOSE}`;
}

// ───────────────────────────────────────────────────────────────────
// renderMarketCharts — Chart.js v4 visual layer for the report.
//
// Returns a self-contained HTML block: scoped styles, six card
// wrappers in a responsive grid, and one inline <script> that boots
// all seven charts. The data bundle is JSON-injected at render time
// (with </ and U+2028/U+2029 escaped) so no XSS path through field
// values. Each chart guards on the fields it actually needs; missing
// data swaps the canvas for a small gray "Data not available" box
// rather than rendering an empty axis. Chart.js itself is loaded by
// the CDN <script> in PAGE_OPEN.
// ───────────────────────────────────────────────────────────────────
function renderMarketCharts(data, profile, displayName) {
  data = data || {};

  // Subject business
  const yourName = displayName || data.name || data.business_name || 'Your business';
  const yourRating = (typeof data.google_rating === 'number') ? data.google_rating : null;
  const yourReviews = (typeof data.google_review_count === 'number') ? data.google_review_count : null;

  // Competitor list — prefer the longer top5 when present, fall back to top3.
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

  // Benchmark rating from profile, default 4.0.
  const benchmarkRating = (profile && profile.benchmarks && typeof profile.benchmarks.good_rating === 'number')
    ? profile.benchmarks.good_rating
    : 4.0;

  // Seasonality signals
  const seasonal = {
    peakMonth: (typeof data.peak_month === 'string') ? data.peak_month : null,
    hasColdWinter: !!data.has_cold_winter,
    hasHotSummer: !!data.has_hot_summer,
    peakTouristSeason: (typeof data.peak_tourist_season === 'string') ? data.peak_tourist_season : null,
  };

  // PageSpeed — accept either canonical field name.
  const pagespeedScore = (typeof data.pagespeed === 'number') ? data.pagespeed
    : (typeof data.website_mobile_score === 'number') ? data.website_mobile_score : null;
  const pagespeed = {
    score: pagespeedScore,
    websiteExists: data.website_exists === true,
  };

  // Income + permits
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

  // Safe JSON injection: escape </script>, HTML comments, U+2028/29
  // line separators that break inline JSON inside <script>.
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
  .gim-charts .gim-chart-title {
    font-size: 14px; font-weight: 500; color: #1E293B; margin: 0 0 4px;
  }
  .gim-charts .gim-chart-sub {
    font-size: 12px; color: #64748B; margin: 0 0 14px;
  }
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
  @media print {
    .gim-charts .gim-chart-card { break-inside: avoid; }
  }
</style>

<div class="gim-charts">
  <div class="gim-chart-card">
    <div class="gim-chart-title">Competitive position</div>
    <div class="gim-chart-sub">Where you stand on rating vs. review volume</div>
    <div class="gim-chart-wrap" style="height:360px;overflow:visible">
      <canvas id="chart-matrix"></canvas>
      <div id="matrix-info-panel" style="
        position: absolute;
        top: 12px;
        right: 12px;
        background: rgba(15,23,41,0.95);
        color: white;
        border-radius: 10px;
        padding: 12px 16px;
        min-width: 180px;
        max-width: 220px;
        font-family: Inter, sans-serif;
        font-size: 13px;
        line-height: 1.6;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.2s;
        z-index: 10;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      ">
        <div id="matrix-info-name" style="font-weight:600;font-size:14px;margin-bottom:6px;color:#fff"></div>
        <div id="matrix-info-rating" style="color:#94A3B8"></div>
        <div id="matrix-info-reviews" style="color:#94A3B8"></div>
        <div id="matrix-info-quadrant" style="margin-top:6px;font-size:11px;font-weight:500"></div>
      </div>
    </div>
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

  // ── CHART 1 — Competitive position matrix ─────────────────────────
  (function () {
    var canvas = document.getElementById('chart-matrix');
    if (!canvas) return;
    var youOk = D.you.rating != null && D.you.reviews != null;
    var compOk = Array.isArray(D.competitors) && D.competitors.length > 0;
    if (!youOk && !compOk) { naBox('chart-matrix'); return; }

    // Truncate name to 8 chars (first word, ellipsis if cut).
    function shortLabel(name) {
      var first = String(name || '').split(/\\s+/)[0];
      return first.length > 8 ? first.slice(0, 7) + '…' : first;
    }

    // Build the points first; sizes are computed below once we know
    // the full review-count range.
    var points = [];
    if (youOk) points.push({ x: D.you.reviews, y: D.you.rating, label: 'YOU ★', fullName: D.you.name, color: BLUE, isYou: true });
    if (compOk) D.competitors.forEach(function (c) {
      points.push({ x: c.reviews, y: c.rating, label: shortLabel(c.name), fullName: c.name, color: GRAY, isYou: false });
    });

    // Bubble radius proportional to review count (per spec):
    //   r = 8 + ((reviews - minR) / (maxR - minR)) * 17    → range [8, 25]
    //   YOU's bubble gets +4 on top so it always stands out
    // When every point has identical review count we fall back to 12,
    // which is the size the previous fixed-radius version used.
    var allReviews = points.map(function (p) { return p.x; });
    var maxRv = Math.max.apply(null, allReviews);
    var minRv = Math.min.apply(null, allReviews);
    points.forEach(function (p) {
      var r;
      if (maxRv === minRv) {
        r = 12;
      } else {
        r = 8 + ((p.x - minRv) / (maxRv - minRv)) * 17;
      }
      if (p.isYou) r += 4;
      p.r = Math.max(8, Math.min(29, r));
    });

    var xs = allReviews.slice().sort(function (a, b) { return a - b; });
    var medianReviews = xs.length
      ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2)
      : 50;
    var benchmark = (typeof D.benchmarkRating === 'number') ? D.benchmarkRating : 4.0;

    // Quadrant tints + dashed dividers + corner-anchored labels in
    // each quadrant's sentiment color. Top quadrants use textBaseline
    // 'top' so the labels sit just below the plot's top edge; bottom
    // quadrants use 'bottom' so they sit just above the bottom edge.
    var quadrantBg = {
      id: 'quadrantBg',
      beforeDraw: function (chart) {
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

        ctx.font = '700 11px Inter, sans-serif';
        // Top-left — Hidden gems (blue)
        ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        ctx.fillStyle = '#2563EB';
        ctx.fillText('Hidden gems', L + 12, T + 18);
        // Top-right — Market leaders (emerald)
        ctx.textAlign = 'right';
        ctx.fillStyle = '#10B981';
        ctx.fillText('Market leaders', R - 12, T + 18);
        // Bottom-left — Needs work (red)
        ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
        ctx.fillStyle = '#EF4444';
        ctx.fillText('Needs work', L + 12, B - 10);
        // Bottom-right — High volume (orange)
        ctx.textAlign = 'right';
        ctx.fillStyle = '#F59E0B';
        ctx.fillText('High volume', R - 12, B - 10);
        ctx.restore();
      }
    };

    // Bubble labels — clean cluster mode. YOU always shows its label
    // (white text inside the blue bubble). Competitor labels render
    // ONLY if no other bubble center sits within 40 px of theirs;
    // clustered competitors stay anonymous on the chart and surface
    // their identity via the hover tooltip below. Keeps the matrix
    // legible when many competitors stack in the same quadrant.
    var bubbleLabels = {
      id: 'bubbleLabels',
      afterDraw: function (chart) {
        var ctx = chart.ctx, meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data) return;
        ctx.save();
        ctx.font = '600 11px Inter, sans-serif';

        // YOU's label — always rendered, never suppressed.
        meta.data.forEach(function (el, i) {
          var p = points[i]; if (!p || !p.isYou) return;
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.label, el.x, el.y);
        });

        // Cluster detection — a competitor is "clustered" if any
        // other bubble center is within 40 px of its own.
        var clustered = new Array(meta.data.length);
        for (var i = 0; i < meta.data.length; i++) {
          var pi = points[i]; if (!pi || pi.isYou) { clustered[i] = false; continue; }
          var near = false;
          for (var j = 0; j < meta.data.length; j++) {
            if (i === j) continue;
            var pj = points[j]; if (!pj) continue;
            var dx = meta.data[i].x - meta.data[j].x;
            var dy = meta.data[i].y - meta.data[j].y;
            if (Math.sqrt(dx * dx + dy * dy) < 40) { near = true; break; }
          }
          clustered[i] = near;
        }

        // Rounded-rect helper.
        function roundedRect(ctx, x, y, w, h, r) {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        }

        // Render non-clustered competitor labels with the white pill
        // bg just above each bubble.
        meta.data.forEach(function (el, i) {
          var p = points[i]; if (!p || p.isYou || clustered[i]) return;
          var labelY = el.y - p.r - 10;
          var textW = ctx.measureText(p.label).width;
          var bgW = textW + 10;     // 5 px L + 5 px R padding
          var bgH = 11 + 6;         // 11 px text + 3 px T + 3 px B padding
          var bgX = el.x - bgW / 2;
          var bgY = labelY - bgH / 2;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
          roundedRect(ctx, bgX, bgY, bgW, bgH, 4);
          ctx.fill();
          ctx.strokeStyle = 'rgba(15, 23, 41, 0.10)';
          ctx.lineWidth = 1;
          roundedRect(ctx, bgX, bgY, bgW, bgH, 4);
          ctx.stroke();
          ctx.fillStyle = '#1E293B';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.label, el.x, labelY);
        });

        ctx.restore();
      }
    };

    new Chart(canvas, {
      type: 'bubble',
      data: {
        datasets: [{
          data: points,
          backgroundColor: points.map(function (p) { return p.color; }),
          borderColor: points.map(function (p) { return p.color === BLUE ? NAVY : '#64748B'; }),
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        // Custom fixed info panel in the top-right of the chart card
        // replaces the default floating tooltip — it never gets
        // covered by neighboring bubbles. onHover fires on every
        // mousemove inside the chart; we update the panel from the
        // hovered point's data. Clustered competitors (whose on-
        // chart label is hidden by the cluster-mode bubbleLabels
        // plugin) reveal their full identity here on hover.
        onHover: function (event, elements, chart) {
          var panel = document.getElementById('matrix-info-panel');
          if (!panel) return;
          if (!elements || elements.length === 0) {
            panel.style.opacity = '0';
            return;
          }
          var idx = elements[0].index;
          var p = points[idx];
          if (!p) { panel.style.opacity = '0'; return; }
          var name = p.fullName || p.label || '';
          var rating = p.y;
          var reviews = p.x;
          var quadrant, qcolor;
          if (rating >= benchmark && reviews >= medianReviews) { quadrant = 'Market leader'; qcolor = '#10B981'; }
          else if (rating >= benchmark)                       { quadrant = 'Hidden gem';    qcolor = '#2563EB'; }
          else if (reviews >= medianReviews)                  { quadrant = 'High volume';   qcolor = '#F59E0B'; }
          else                                                { quadrant = 'Needs work';    qcolor = '#EF4444'; }
          document.getElementById('matrix-info-name').textContent    = name;
          document.getElementById('matrix-info-rating').textContent  = 'Rating: ' + rating.toFixed(1) + ' ★';
          document.getElementById('matrix-info-reviews').textContent = 'Reviews: ' + reviews.toLocaleString();
          var qel = document.getElementById('matrix-info-quadrant');
          qel.textContent = '● ' + quadrant;
          qel.style.color = qcolor;
          panel.style.opacity = '1';
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        scales: {
          x: { title: { display: true, text: 'Number of reviews' }, beginAtZero: true, grace: '15%' },
          y: { title: { display: true, text: 'Rating' }, min: 1, max: 5, ticks: { stepSize: 0.5 } }
        }
      },
      plugins: [quadrantBg, bubbleLabels]
    });

    // Hide the info panel when the cursor leaves the canvas entirely
    // (onHover doesn't fire on mouseleave).
    canvas.addEventListener('mouseleave', function () {
      var panel = document.getElementById('matrix-info-panel');
      if (panel) panel.style.opacity = '0';
    });
  })();

  // ── CHART 2 — Rating comparison ──────────────────────────────────
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
        animation: {
          onComplete: function () {
            var c = this, ctx = c.ctx;
            ctx.font = '600 11px Inter, sans-serif'; ctx.fillStyle = '#0F1729';
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            c.getDatasetMeta(0).data.forEach(function (b, i) {
              ctx.fillText(entries[i].rating.toFixed(1), b.x + 6, b.y);
            });
          }
        }
      }
    });
  })();

  // ── CHART 3 — Review volume ──────────────────────────────────────
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
        scales: {
          x: { beginAtZero: true },
          y: { ticks: { font: { size: 11 } } }
        },
        animation: {
          onComplete: function () {
            var c = this, ctx = c.ctx;
            ctx.font = '600 11px Inter, sans-serif'; ctx.fillStyle = '#0F1729';
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            c.getDatasetMeta(0).data.forEach(function (b, i) {
              ctx.fillText(entries[i].reviews.toLocaleString(), b.x + 6, b.y);
            });
          }
        }
      }
    });
  })();

  // ── CHART 4 — Seasonal demand pattern ────────────────────────────
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

  // ── CHART 5 — PageSpeed gauge ────────────────────────────────────
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
      options: {
        cutout: '75%', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } }
      }
    });
  })();

  // ── CHART 6 — Income distribution ────────────────────────────────
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
      options: {
        cutout: '65%', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return c.label + ': ' + c.parsed + '%'; } } } }
      }
    });
  })();

  // ── CHART 7 — Building permits trend ─────────────────────────────
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

function renderReport(ctx) {
  const { input, layer0Result, profile, data, redFlags, strengths, ranked, enriched, studies } = ctx;

  // BUG 21 — Null-safe competitor data. Upstream code can set
  // data.competitors_top5 / competitors_top3 to null when the Nearby
  // Search fetch fails or times out (see server.js ~line 850-854).
  // Normalize to [] up front so downstream code (rating-delta logic,
  // tier classification, competitor cards, Claude bundle wrapping)
  // can iterate without scattering Array.isArray checks at every call
  // site. Individual call sites still keep their guards as defense in
  // depth, but new sites added later won't crash on the null case.
  if (data) {
    if (!Array.isArray(data.competitors_top5)) data.competitors_top5 = [];
    if (!Array.isArray(data.competitors_top3)) data.competitors_top3 = [];
  }

  const status = overallStatus(strengths, ranked);
  const statusClass = status.label.startsWith('HEALTHY')
    ? 'healthy'
    : status.label.startsWith('GOOD')
    ? 'good'
    : 'needs';

  const allCitedIds = new Set();
  // Audit fix S6 — defensive Array.isArray guard. A profile rec with
  // a missing/null study_ids array used to crash the whole report
  // render with a TypeError; now it just contributes no citations.
  ranked.allTriggered.forEach((t) => {
    const ids = Array.isArray(t.rec && t.rec.study_ids) ? t.rec.study_ids : [];
    ids.forEach((id) => allCitedIds.add(id));
  });

  // ── Competitor radius-tier note (matches the 8-step 1/3/8/15/30/50/75/150
  // ladder in googlePlaces.js fetchNearbyCompetitors). Tier mapping:
  //   1-3 mi   → no callout (healthy local pool, no message needed)
  //   8-15 mi  → "Nearest competitors within X miles" (mild)
  //   30-50 mi → "Limited local competition" (warning)
  //   75 mi    → "Very limited competition — strong market position" (warning)
  //   150 mi   → "No nearby competitors — potential monopoly" (positive)
  function radiusTierNote() {
    const radiusMi = typeof data.search_radius_miles === 'number' ? data.search_radius_miles : null;
    if (radiusMi == null) return '';

    // Step 8 (150 mi) — ladder reached the end. Per spec, surface the
    // monopoly note. Note: the message says "No nearby competitors";
    // technically the ladder may have surfaced 1-4 competitors at 150
    // mi, but the spec wording calls this "potential monopoly in your
    // category in this region" regardless. If the rendered count
    // line below shows a non-zero number, the user has the actual count.
    if (radiusMi >= 150) {
      return `<div class="rec rec-high"><strong>&#9888; No nearby competitors found</strong> &mdash; potential monopoly in your category in this region. Nearest matches found within 150 miles.</div>`;
    }
    // Step 7 (75 mi).
    if (radiusMi >= 75) {
      return `<div class="flag">&#9888; Very limited competition &mdash; nearest within ${radiusMi} miles. Strong market position in your area.</div>`;
    }
    // Steps 5-6 (30 / 50 mi).
    if (radiusMi >= 30) {
      return `<div class="flag">&#9888; Limited local competition &mdash; nearest within ${radiusMi} miles.</div>`;
    }
    // Steps 3-4 (8 / 15 mi) — mild informational note, no warning icon.
    if (radiusMi >= 8) {
      return `<div class="meta" style="margin:8px 0">Nearest competitors within ${radiusMi} miles.</div>`;
    }
    // Steps 1-2 (1 / 3 mi) — healthy dense local market, no callout.
    return '';
  }

  const fallbackTag = layer0Result._phase1Patch
    ? ' <small>(phase-1 hotel keyword patch)</small>'
    : layer0Result._typesFallback
    ? ` <small>(places types fallback: matched <code>${escapeHtml(layer0Result.matched_type)}</code>)</small>`
    : layer0Result._nameFallback
    ? ` <small>(places name fallback: matched <code>${escapeHtml(layer0Result.matched_token)}</code> → ${escapeHtml(layer0Result.matched_category)})</small>`
    : '';
  const chainTag = data.is_chain
    ? ` <small>(chain: ${escapeHtml(data.chain_name || 'detected')})</small>`
    : '';
  // Partial-report banner: shown when Call A (claudeEnricher's main
  // enrichment call) timed out twice (20-min main + 7-min fallback) or
  // otherwise failed but Call B still produced data. Renders at the
  // very top of the page so the user sees it before the (incomplete)
  // report content. Empty string for normal full reports.
  const partialReportBanner = data.call_a_failed
    ? `<div style="background:#FEF3C7;border:2px solid #F59E0B;border-radius:8px;padding:20px 24px;margin:0 0 24px 0;font-family:sans-serif;">
  <div style="font-size:18px;font-weight:bold;color:#B45309;margin-bottom:10px;">&#9888; Partial Report Generated</div>
  <div style="color:#78350F;font-size:14px;line-height:1.6;">
    Some sections could not be generated due to a technical error. The following sections are missing from this report:
    <ul style="margin:8px 0 12px 0">
      <li>Priority actions</li>
      <li>Competitor deep dive</li>
      <li>90-day action plan</li>
      <li>Opportunities</li>
      <li>Seasonal strategy</li>
    </ul>
    Please try again for the complete report. If the problem persists please contact support.
  </div>
  <div style="margin-top:16px;display:flex;gap:12px;flex-wrap:wrap;">
    <a href="/app" style="display:inline-block;padding:8px 20px;background:#B45309;color:white;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;">&#8617; Try Again</a>
    <a href="mailto:support@growthim.com" style="display:inline-block;padding:8px 20px;background:white;color:#B45309;border:2px solid #B45309;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;">&#9993; Contact Support</a>
  </div>
</div>`
    : '';

  // Claude-unavailable banner: shown when enrichWithClaude returned null
  // entirely (no API key / both calls rejected). Distinct from the
  // partial-report case — the data sections (Census, BLS, competitor
  // count, etc.) still render, only the AI-enhanced sections are
  // missing. Tells the user clearly what's happening and that retry
  // is free.
  const claudeUnavailableBanner = (data.claude_unavailable && !data.call_a_failed)
    ? `<div style="background:#FEF3C7;border:2px solid #F59E0B;border-radius:8px;padding:18px 22px;margin:0 0 24px 0;font-family:sans-serif;">
  <div style="font-size:16px;font-weight:bold;color:#B45309;margin-bottom:8px;">&#9888; AI-enhanced sections temporarily unavailable</div>
  <div style="color:#78350F;font-size:14px;line-height:1.55;">
    The data sections of your report are complete. The AI-generated sections (priority actions, competitor deep dive, 90-day plan, opportunities, seasonal strategy) could not be generated this time.
    <br><br>
    Please retry in 10 minutes for full AI insights. You will not be charged again.
  </div>
  <div style="margin-top:14px;display:flex;gap:12px;flex-wrap:wrap;">
    <a href="/app" style="display:inline-block;padding:8px 20px;background:#B45309;color:white;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;">&#8617; Retry</a>
    <a href="mailto:support@growthim.com" style="display:inline-block;padding:8px 20px;background:white;color:#B45309;border:2px solid #B45309;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;">&#9993; Contact Support</a>
  </div>
</div>`
    : '';

  // No-website banner: shown when Google could not find a website for
  // this business (data.website_exists is false / null / undefined).
  // Pairs with the NO WEBSITE RULE in SYSTEM_PROMPT_A which forces
  // Claude to also emit a HIGH-impact no-website priority_action so
  // the recommendation appears both as a banner AND inline in the
  // priority actions list. Empty string when the business has a
  // working website Google can see.
  const noWebsiteBanner = !data.website_exists
    ? `<div style="background:#FFF7ED;border:2px solid #EA580C;border-radius:8px;padding:24px;margin:0 0 24px 0;font-family:sans-serif;">
  <div style="font-size:20px;font-weight:bold;color:#C2410C;margin-bottom:12px;">&#127760; No Website Found</div>
  <div style="color:#7C2D12;font-size:14px;line-height:1.8;">
    We searched for a website for <strong>${escapeHtml(data.name || 'this business')}</strong> and could not find one.
    <br><br>
    This could mean:
    <ul style="margin:8px 0;padding-left:20px;line-height:2.2;">
      <li>You have <strong>no website at all</strong></li>
      <li>You only have a <strong>personal page or Facebook page</strong> but no dedicated business website</li>
      <li>Your website exists but <strong>Google cannot find or index it</strong></li>
    </ul>
    All three situations mean customers searching online cannot easily find your business.
    <br><br>
    <strong>GrowthIM Support can help you build a professional business website or fix your existing online presence at reasonable prices.</strong>
  </div>
  <div style="margin-top:20px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
    <a href="mailto:support@growthim.com" style="display:inline-block;padding:10px 24px;background:#C2410C;color:white;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;">&#9993; Contact Support — Get Website Help</a>
    <span style="font-size:13px;color:#9A3412;">support@growthim.com</span>
  </div>
</div>`
    : '';

  // BATCH-low-confidence: warning banner shown at the top of the
  // report when findPlace flagged the result as a closest-match
  // (couldn't confidently resolve the user's input to a single
  // business). Empty string when the resolver was confident.
  const lowConfidenceBanner = data._low_confidence
    ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#92400E;line-height:1.6;">
&#9888;&#65039; <strong>Closest match found.</strong> We searched for <em>${escapeHtml(data._user_input || input)}</em> and returned the closest matching business. If this report is for the wrong business please try searching with the exact name as it appears on Google Maps.
</div>`
    : '';

  // AI Layer 0 verification badge — AMBER when Claude corrected the
  // NAICS, GREEN when Claude confirmed the original. Sits inline with
  // the Layer 0 line so the audit trail is visible in every report.
  let aiVerifyHtml = '';
  if (layer0Result.ai_corrected) {
    const orig = escapeHtml(layer0Result.original_naics || '');
    const fixed = escapeHtml(layer0Result.naics6 || '');
    const title = escapeHtml(layer0Result.naics_title || '');
    const reason = escapeHtml((layer0Result.ai_reasoning || '').slice(0, 200));
    // BUG 24 — when Claude flags ai_corrected=true but ends up with the
    // SAME NAICS-6 as the original, the "X → X" rendering is confusing.
    // This happens when Claude's override flag fires for profile-level
    // intent (e.g., berry-patch tagged as restaurant routed by Google
    // types but actually agriculture — same NAICS bucket the
    // selectBestProfile cascade pulls into a different profile_id).
    // Render a distinct "NAICS confirmed, profile re-selected" message
    // in that case so the user sees the audit trail without the
    // misleading "X → X" arrow.
    if (layer0Result.original_naics && layer0Result.naics6
        && String(layer0Result.original_naics) === String(layer0Result.naics6)) {
      aiVerifyHtml =
        `<br><span style="color:#B45309;background:#FEF3C7;padding:2px 8px;border-radius:4px;font-size:13px;">` +
        `⚠ AI profile-corrected (NAICS ${fixed} confirmed${title ? ' — ' + title : ''})</span>` +
        (reason ? `<br><span style="color:#92400E;font-size:12px;">Reason: ${reason}</span>` : '');
    } else {
      aiVerifyHtml =
        `<br><span style="color:#B45309;background:#FEF3C7;padding:2px 8px;border-radius:4px;font-size:13px;">` +
        `⚠ AI corrected: ${orig} → ${fixed}${title ? ' (' + title + ')' : ''}</span>` +
        (reason ? `<br><span style="color:#92400E;font-size:12px;">Reason: ${reason}</span>` : '');
    }
  } else if (layer0Result.ai_verified) {
    const fixed = escapeHtml(layer0Result.naics6 || '');
    aiVerifyHtml =
      `<br><span style="color:#166534;background:#DCFCE7;padding:2px 8px;border-radius:4px;font-size:13px;">` +
      `✓ AI verified: ${fixed} confirmed via web search</span>`;
  }

  const headerHtml = `<h1>${escapeHtml(data.name || input)}</h1>
<p class="meta">${escapeHtml(data.formatted_address || '')}<br>
${escapeHtml(profile.name)} — NAICS ${escapeHtml(layer0Result.naics6)}<br>
Layer 0: <code>${escapeHtml(layer0Result.mode)}</code> · confidence ${escapeHtml(layer0Result.confidence)}${fallbackTag}${chainTag}${aiVerifyHtml}</p>`;

  const overallHtml = `<div class="status ${statusClass}">${escapeHtml(status.label)}</div>
${status.detail ? `<p class="meta">${escapeHtml(status.detail)}</p>` : ''}`;

  // Phase 5 — LOCAL MARKET CONTEXT callout (when Claude enrichment succeeded)
  // and the "AI insights unavailable" note (when it didn't).
  let localContextHtml = '';
  if (enriched && enriched.local_context) {
    localContextHtml = `<div class="callout local-context">
<div class="callout-label">LOCAL MARKET CONTEXT</div>
<p>${escapeHtml(enriched.local_context)}</p>
</div>`;
  } else if (!enriched) {
    localContextHtml = `<p class="ai-fallback-note"><small>AI insights unavailable — showing research-based recommendations.</small></p>`;
  }

  let redFlagsHtml = '';
  if (redFlags.length) {
    redFlagsHtml = `<h2>Red flags</h2>` + redFlags.map((rf) =>
      `<div class="flag ${rf.severity === 'critical' ? 'critical' : ''}">
<strong>${escapeHtml(rf.severity.toUpperCase())}:</strong> ${escapeHtml(rf.message)}</div>`
    ).join('');
  }

  let strengthsHtml = '';
  if (strengths.length) {
    strengthsHtml = `<h2>Strengths</h2><ul>${
      strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    }</ul>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Industry survival outlook — BED2013 cohort survival rates for the
  // business's NAICS-2 sector. Renders only when the sector has a row
  // in BED2013 (every NAICS-2 we currently classify maps to one).
  // ──────────────────────────────────────────────────────────────────
  let industrySurvivalHtml = '';
  const _bedNaics2 = naics2FromNaics6(layer0Result.naics6);
  const _bed = _bedNaics2 && BED2013[_bedNaics2];
  if (_bed) {
    const pct = (n) => `${(n * 100).toFixed(1)}%`;
    industrySurvivalHtml = `<h2>Industry survival outlook</h2>
<p>Establishments that opened in this sector (NAICS-${escapeHtml(_bedNaics2)}) in 2013 survived as follows:</p>
<table class="coverage">
  <tr><td><strong>1-year</strong></td><td>${pct(_bed.y1)}</td></tr>
  <tr><td><strong>3-year</strong></td><td>${pct(_bed.y3)}</td></tr>
  <tr><td><strong>5-year</strong></td><td>${pct(_bed.y5)}</td></tr>
  <tr><td><strong>7-year</strong></td><td>${pct(_bed.y7)}</td></tr>
  <tr><td><strong>10-year</strong></td><td>${pct(_bed.y10)}</td></tr>
</table>
<p class="meta"><small>Source: BLS Business Employment Dynamics, 2013 cohort tracked through 2023</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — TripAdvisor Intelligence (rendered only when TA fetch hit)
  // Position: after Strengths, before Competitive context.
  // Surfaces: rating + review count, ranking, sub-ratings (with gap
  // detection at ≥0.4 spread), awards, trip-type mix, value-vs-overall
  // gap warning (synthetic ta_value_gap_detected bool from the fetcher).
  // ──────────────────────────────────────────────────────────────────
  let tripAdvisorHtml = '';
  if (data.tripadvisor && data.ta_rating != null) {
    const ratingStars = typeof data.ta_rating === 'number' ? data.ta_rating.toFixed(1) : '—';
    const reviewCt = typeof data.ta_review_count === 'number'
      ? data.ta_review_count.toLocaleString('en-US')
      : '—';

    // Ranking line — only when we successfully parsed "#X of Y"
    let rankingLine = '';
    if (data.ta_ranking_position && data.ta_ranking_out_of) {
      const pct = (data.ta_ranking_position / data.ta_ranking_out_of);
      const tier = pct <= 0.10 ? 'top 10%' : pct <= 0.25 ? 'top 25%' : pct <= 0.50 ? 'top 50%' : 'lower half';
      rankingLine = `<br>Ranked <strong>#${data.ta_ranking_position} of ${data.ta_ranking_out_of}</strong> locally (${tier}).`;
    } else if (data.ta_ranking) {
      rankingLine = `<br>${escapeHtml(data.ta_ranking)}`;
    }

    // Sub-ratings table + gap detection. Compute max-min spread; flag at ≥0.4.
    let subratingsHtml = '';
    let gapHtml = '';
    if (data.ta_subratings && typeof data.ta_subratings === 'object') {
      const entries = Object.entries(data.ta_subratings)
        .filter(([, v]) => Number.isFinite(v));
      if (entries.length) {
        const rows = entries.map(([k, v]) => {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          return `<tr><td>${escapeHtml(label)}</td><td><strong>${v.toFixed(1)}</strong></td></tr>`;
        }).join('');
        subratingsHtml = `<p><strong>Sub-ratings:</strong></p>
<table class="coverage">${rows}</table>`;

        const vals = entries.map(([, v]) => v);
        const maxV = Math.max(...vals);
        const minV = Math.min(...vals);
        const spread = maxV - minV;
        if (spread >= 0.4) {
          const lowest = entries.find(([, v]) => v === minV);
          const highest = entries.find(([, v]) => v === maxV);
          gapHtml = `<div class="flag"><strong>Sub-rating gap detected:</strong> ${spread.toFixed(1)}-point spread between
your strongest dimension (${escapeHtml(highest[0].replace(/_/g, ' '))}: ${highest[1].toFixed(1)}) and weakest
(${escapeHtml(lowest[0].replace(/_/g, ' '))}: ${lowest[1].toFixed(1)}). Customers notice the inconsistency.</div>`;
        }
      }
    }

    // Value-vs-overall gap (synthetic field for the trigger DSL).
    let valueGapHtml = '';
    if (data.ta_value_gap_detected) {
      const v = data.ta_subratings && data.ta_subratings.value;
      valueGapHtml = `<div class="flag"><strong>Value perception gap:</strong> Your value sub-rating (${typeof v === 'number' ? v.toFixed(1) : '—'})
trails your overall rating (${ratingStars}) by more than 0.4. Customers like the experience but feel they overpaid —
look at price-to-perceived-quality (portion size, finish quality, included amenities).</div>`;
    }

    // Awards list
    let awardsHtml = '';
    if (Array.isArray(data.ta_awards) && data.ta_awards.length) {
      const items = data.ta_awards.map((a) => {
        const yr = a.year ? ` (${escapeHtml(String(a.year))})` : '';
        return `<li>${escapeHtml(a.type)}${yr}</li>`;
      }).join('');
      awardsHtml = `<p><strong>TripAdvisor awards:</strong></p><ul>${items}</ul>`;
    }

    // Trip types — show top 3 by share so the dominant segments are obvious.
    let tripTypesHtml = '';
    if (Array.isArray(data.ta_trip_types) && data.ta_trip_types.length) {
      const total = data.ta_trip_types.reduce((s, t) => s + (t.value || 0), 0);
      if (total > 0) {
        const top = [...data.ta_trip_types].sort((a, b) => b.value - a.value).slice(0, 3);
        const items = top.map((t) => {
          const pct = ((t.value / total) * 100).toFixed(0);
          return `<li>${escapeHtml(t.name)}: ${pct}% (${t.value})</li>`;
        }).join('');
        tripTypesHtml = `<p><strong>Customer trip-type mix:</strong></p><ul>${items}</ul>
<p class="meta"><small>Use to align messaging — promote the segment you want to grow, defend the one you depend on.</small></p>`;
      }
    }

    tripAdvisorHtml = `<h2>TripAdvisor intelligence</h2>
<p><strong>${ratingStars}★</strong> on TripAdvisor across ${reviewCt} review${reviewCt === '1' ? '' : 's'}.${rankingLine}</p>
${subratingsHtml}
${gapHtml}
${valueGapHtml}
${awardsHtml}
${tripTypesHtml}
<p class="meta"><small>Source: TripAdvisor Content API (location + details + reviews).</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — Quality ratings (CMS Hospital Compare)
  // ──────────────────────────────────────────────────────────────────
  // Renders for hospitals / specialty clinics whose facility_name matches
  // a row in CMS's Hospital General Information dataset (xubh-q36u).
  let qualityRatingsHtml = '';
  if (data.cms) {
    const overall = data.cms_overall_rating;
    const stars = (overall !== null && overall !== undefined && overall !== '')
      ? `${escapeHtml(String(overall))}/5 stars`
      : 'unrated';
    const rows = [
      ['Patient experience', data.cms_patient_experience_rating],
      ['Mortality', data.cms_mortality_rating],
      ['Safety of care', data.cms_safety_rating],
      ['Readmission', data.cms_readmission_rating],
      ['Timeliness', data.cms_timeliness_rating],
    ]
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
      .join('');
    const facility = data.cms.facility_name ? escapeHtml(data.cms.facility_name) : 'This facility';
    qualityRatingsHtml = `<h2>Quality ratings</h2>
<p><strong>${facility}</strong> — CMS overall rating: <strong>${stars}</strong></p>
${rows ? `<table class="coverage">${rows}</table>` : ''}
<p class="meta"><small>Source: CMS Hospital General Information (national-comparison ratings).</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — Compliance (FMCSA carrier safety)
  // ──────────────────────────────────────────────────────────────────
  // Renders for transportation/warehousing operators (NAICS-2 = 48-49)
  // when the business name matches a DOT-registered carrier. Surface
  // the safety rating as a flag when it's not "Satisfactory".
  let complianceHtml = '';
  if (data.fmcsa && data.dot_number) {
    const sr = data.safety_rating || '—';
    const srNotSat = data.safety_rating && !/^satisfactory$/i.test(data.safety_rating);
    const srFlag = srNotSat
      ? ` <span class="extra-tag extra-tag-hidden">NOT SATISFACTORY</span>`
      : '';
    const allowed = data.allowed_to_operate || '—';
    const drivers = data.total_drivers != null ? data.total_drivers.toLocaleString('en-US') : '—';
    const trucks = data.total_trucks != null ? data.total_trucks.toLocaleString('en-US') : '—';
    const op = data.fmcsa.carrier_operation || '—';
    complianceHtml = `<h2>Compliance</h2>
<p><strong>FMCSA Safety Rating:</strong> ${escapeHtml(String(sr))}${srFlag}<br>
DOT#: <strong>${escapeHtml(String(data.dot_number))}</strong><br>
Allowed to operate: <strong>${escapeHtml(String(allowed))}</strong><br>
Carrier operation: ${escapeHtml(String(op))}<br>
Total drivers: <strong>${escapeHtml(String(drivers))}</strong> · Total trucks: <strong>${escapeHtml(String(trucks))}</strong></p>
<p class="meta"><small>Source: FMCSA QCMobile carrier services API.</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // BATCH14 — Competitive Context + Location & Market sections
  // (rendered only when the underlying fetches succeeded)
  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — FDIC bank financial summary (banking / finance profiles).
  // Built up here so it can be appended to competitiveHtml whether or not
  // Google Nearby Search returned competitor data.
  let fdicBlock = '';
  if (data.fdic && (data.fdic_total_deposits != null || data.fdic_total_assets != null)) {
    // FDIC reports DEP / ASSET in $thousands. Convert to $M for display.
    const depM = data.fdic_total_deposits != null
      ? '$' + (data.fdic_total_deposits / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M'
      : '—';
    const assetM = data.fdic_total_assets != null
      ? '$' + (data.fdic_total_assets / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M'
      : '—';
    const bn = data.fdic_bank_name ? escapeHtml(data.fdic_bank_name) : 'this institution';
    fdicBlock = `<p><strong>FDIC profile (${bn}):</strong><br>
Total deposits: <strong>${depM}</strong><br>
Total assets: <strong>${assetM}</strong><br>
<small>Source: FDIC BankFind API (active institutions).</small></p>`;
  }

  let competitiveHtml = '';
  if (typeof data.competitor_count === 'number' && data.competitor_count > 0) {
    const yourRating = typeof data.google_rating === 'number' ? data.google_rating.toFixed(1) : '—';
    const medRating = typeof data.competitor_median_rating === 'number' ? data.competitor_median_rating.toFixed(1) : '—';
    const yourReviews = typeof data.google_review_count === 'number' ? data.google_review_count : '—';
    const medReviews = typeof data.competitor_median_review_count === 'number' ? data.competitor_median_review_count : '—';
    const ratingDelta = (typeof data.google_rating === 'number' && typeof data.competitor_median_rating === 'number')
      ? (data.google_rating - data.competitor_median_rating)
      : null;
    const reviewDelta = (typeof data.google_review_count === 'number' && typeof data.competitor_median_review_count === 'number')
      ? (data.google_review_count - data.competitor_median_review_count)
      : null;
    const ratingFlag = ratingDelta == null ? '' : ratingDelta >= 0 ? ` <small>(+${ratingDelta.toFixed(1)})</small>` : ` <small>(${ratingDelta.toFixed(1)})</small>`;
    const reviewFlag = reviewDelta == null ? '' : reviewDelta >= 0 ? ` <small>(+${reviewDelta})</small>` : ` <small>(${reviewDelta})</small>`;

    // ── Tier classification (per spec 2) ────────────────────────────
    // Each top-5 competitor is bucketed into 'threat' (real competitive
    // risk — render as a full card), 'winning' (subject is meaningfully
    // outperforming — render as a muted one-liner), or 'neutral'
    // (similar level / insufficient signal — silently dropped from both
    // lists). Logic lives in googlePlaces.classifyCompetitorTier so the
    // rule set can be reused.
    const top5ForTier = Array.isArray(data.competitors_top5) ? data.competitors_top5 : [];
    const tieredCompetitors = top5ForTier.map((c) => ({
      ...c,
      tier: places.classifyCompetitorTier(c, data.google_rating, data.google_review_count),
    }));
    const threats = tieredCompetitors.filter((c) => c.tier === 'threat');
    const winners = tieredCompetitors.filter((c) => c.tier === 'winning');
    const threatCount = threats.length;
    const winningCount = winners.length;
    // Neutrals are competitors at a similar level — counted so we can
    // surface a friendly "all peers" message when threat+winning are
    // both zero but there ARE competitors in the pool (otherwise the
    // section would show "0 real competitors · 0 you're beating" —
    // technically true but discouraging and informationally empty).
    const neutralCount = top5ForTier.length - threatCount - winningCount;

    // Summary line (per spec). Two render branches:
    //   - At least one threat or winning competitor → render counts.
    //   - All competitors are neutral (or no competitors at all but
    //     the outer competitor_count > 0 branch is already true, so
    //     neutralCount > 0 here) → render a friendly "similar level"
    //     reassurance instead of the misleading "0 / 0" tally.
    let tierSummary = '';
    if (threatCount === 0 && winningCount === 0 && neutralCount > 0) {
      tierSummary = '<p class="meta">All nearby competitors are at a similar level to your business right now. This is a good position to grow from.</p>';
    } else if (threatCount + winningCount > 0) {
      tierSummary = `<p class="meta"><strong>${threatCount}</strong> real competitor${threatCount === 1 ? '' : 's'} to watch &middot; <strong>${winningCount}</strong> competitor${winningCount === 1 ? '' : 's'} you're beating</p>`;
    }

    // Tier 1 list — full info per the existing list-item style.
    const threatsHtml = threats.length
      ? `<p class="meta">Real competitors to watch:</p><ul>` + threats.map((c) => {
          const dist = typeof c.distance_meters === 'number'
            ? ` &middot; ${(c.distance_meters / 1609.34).toFixed(1)} mi`
            : (typeof c.distance_miles === 'number' ? ` &middot; ${c.distance_miles.toFixed(1)} mi` : '');
          const rating = typeof c.rating === 'number' ? c.rating.toFixed(1) : '—';
          return `<li><strong>${escapeHtml(c.name)}</strong> &mdash; ${rating}&#9733; (${c.review_count || 0} reviews)${dist}</li>`;
        }).join('') + `</ul>`
      : '';

    // Tier 2 list — muted "you're winning" lines (no detailed card).
    const winnersHtml = winners.length
      ? `<div style="margin-top:10px">` + winners.map((c) => {
          const rating = typeof c.rating === 'number' ? c.rating.toFixed(1) : '—';
          return `<p class="meta" style="margin:4px 0;color:var(--muted)">&#10003; You're outperforming <strong>${escapeHtml(c.name)}</strong> (${rating}&#9733;, ${c.review_count || 0} reviews) &mdash; no action needed</p>`;
        }).join('') + `</div>`
      : '';

    const reportedRadiusMi = typeof data.search_radius_miles === 'number' ? data.search_radius_miles : 15;
    competitiveHtml = `<h2>Competitive context</h2>
${radiusTierNote()}
${tierSummary}
<p>${data.competitor_count} same-type competitors within ${reportedRadiusMi} miles.<br>
Your rating: <strong>${yourRating}</strong> vs local median: <strong>${medRating}</strong>${ratingFlag}<br>
Your reviews: <strong>${yourReviews}</strong> vs local median: <strong>${medReviews}</strong>${reviewFlag}</p>
${threatsHtml}
${winnersHtml}
${fdicBlock}`;
  } else if (fdicBlock) {
    // Bank/finance with no Google competitors but FDIC data — still
    // render the section so the FDIC block has a home.
    competitiveHtml = `<h2>Competitive context</h2>${fdicBlock}`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — Competitor comparison (Claude-enriched, top 5 + analysis)
  // ──────────────────────────────────────────────────────────────────
  // Renders only when (a) the Nearby Search returned at least one
  // competitor AND (b) Claude returned a competitor_analysis object.
  // Includes a thin-market warning when the search had to expand
  // beyond the default 5-mile radius.
  let competitorComparisonHtml = '';
  const ca = enriched && enriched.competitor_analysis;
  const top5 = Array.isArray(data.competitors_top5) ? data.competitors_top5 : [];
  if (ca && top5.length) {
    // Reuse the centralized radius-tier note (matches the 15/30/75/150
    // ladder in googlePlaces.js fetchNearbyCompetitors). Returns '' for
    // the 15-mile default case so we don't duplicate the callout.
    const expansionNote = radiusTierNote();

    const better = Array.isArray(ca.what_they_do_better) ? ca.what_they_do_better : [];
    const win = Array.isArray(ca.what_you_can_win) ? ca.what_you_can_win : [];
    const summary = ca.summary || '';

    const betterHtml = better.length
      ? `<h3>What competitors are doing better than you</h3><ul>` + better.map((b) =>
          `<li><strong>${escapeHtml(b.competitor_name || '—')}:</strong> ${escapeHtml(b.advantage || '')}<br>
<span class="meta">Evidence: ${escapeHtml(b.evidence || '—')}</span><br>
<span class="meta">→ <strong>Your move:</strong> ${escapeHtml(b.your_action || '—')}</span></li>`
        ).join('') + `</ul>`
      : '';

    const winHtml = win.length
      ? `<h3>What you can do to win customers from them</h3><ul>` + win.map((w) =>
          `<li><strong>${escapeHtml(w.opportunity || '—')}</strong><br>
<span class="meta">Why you can win: ${escapeHtml(w.evidence || '—')}</span><br>
<span class="meta">→ <strong>Action:</strong> ${escapeHtml(w.action || '—')}</span></li>`
        ).join('') + `</ul>`
      : '';

    const summaryHtml = summary
      ? `<h3>Overall</h3><p>${escapeHtml(summary)}</p>`
      : '';

    competitorComparisonHtml = `<h2>Competitor comparison <span class="ai-badge" title="Enriched by Claude">AI</span></h2>
${expansionNote}
${betterHtml}
${winHtml}
${summaryHtml}`;
  }

  let marketHtml = '';
  // Phase 5+ — section also renders if USDA agriculture profile or HUD
  // Fair Market Rents are present (sector-conditional fetchers).
  if (
    typeof data.median_household_income === 'number'
    || typeof data.total_population === 'number'
    || data.usda_nass
    || data.hud_fmr
  ) {
    const income = typeof data.median_household_income === 'number'
      ? '$' + data.median_household_income.toLocaleString('en-US')
      : 'unavailable';
    const pop = typeof data.total_population === 'number'
      ? data.total_population.toLocaleString('en-US')
      : 'unavailable';
    const hh = typeof data.average_household_size === 'number'
      ? data.average_household_size.toFixed(2)
      : null;
    const hhLine = hh ? `<br>Average household size: <strong>${hh}</strong>` : '';

    // Phase 5+ — anchor tenants + transit (Overpass / OpenStreetMap)
    let anchorBlock = '';
    if (Array.isArray(data.anchor_tenants) && data.anchor_tenants.length) {
      anchorBlock = `<p><strong>Anchor tenants nearby:</strong> ${escapeHtml(data.anchor_tenants.join(', '))}<br>
<small>Anchor proximity lifts foot traffic 20-40% per Pashigian &amp; Gould (1998), study S044.</small></p>`;
    }
    let transitBlock = '';
    if (typeof data.nearest_transit_meters === 'number') {
      const mi = (data.nearest_transit_meters / 1609.34).toFixed(2);
      transitBlock = `<p><small>Nearest transit (bus stop / rail station): ${data.nearest_transit_meters}m (${mi} mi). ${data.has_transit_nearby ? 'Transit-served location ✓' : 'Car-dependent'}.</small></p>`;
    } else if (data.has_transit_nearby === false || data.location_signals) {
      transitBlock = `<p><small>No bus stop or rail station found within 800m — car-dependent location.</small></p>`;
    }

    // Phase 5+ — HUD residential building permits (Census BPS data)
    let permitsBlock = '';
    if (typeof data.building_permits_total === 'number' && data.building_permits_year) {
      const trendWord = data.building_permits_yoy_change == null
        ? 'trend unavailable'
        : data.building_permits_yoy_change > 5
        ? `<span style="color:#1b7c3a">growing</span> (+${data.building_permits_yoy_change}% YoY)`
        : data.building_permits_yoy_change < -5
        ? `<span style="color:#b32430">declining</span> (${data.building_permits_yoy_change}% YoY)`
        : `<span style="color:#666">stable</span> (${data.building_permits_yoy_change >= 0 ? '+' : ''}${data.building_permits_yoy_change}% YoY)`;
      const sf = typeof data.building_permits_single_family === 'number'
        ? ` (${data.building_permits_single_family} single-family)`
        : '';
      const cty = data.county_name ? `${escapeHtml(data.county_name)} County ` : '';
      permitsBlock = `<p><strong>${cty}construction activity (${escapeHtml(data.building_permits_year)}):</strong> ${data.building_permits_total} total residential permits${sf} — ${trendWord}<br>
<small>Source: U.S. Census Building Permits Survey via HUD (county FIPS ${escapeHtml(data.county_fips || '—')}).</small></p>`;
    }

    // Phase 5+ — USDA NASS agriculture profile (NAICS-2 = 11 only)
    let usdaBlock = '';
    if (data.usda_nass && data.top_commodity) {
      usdaBlock = `<p><strong>Dominant crop:</strong> ${escapeHtml(data.top_commodity)}<br>
<small>${escapeHtml(data.state_ag_profile || '')}</small><br>
<small>Source: USDA NASS QuickStats (2022, AREA HARVESTED).</small></p>`;
    }

    // Phase 5+ — HUD Fair Market Rents (NAICS-2 = 53 only)
    let fmrBlock = '';
    if (data.hud_fmr && (data.fmr_studio != null || data.fmr_1br != null || data.fmr_2br != null)) {
      const studio = data.fmr_studio != null ? '$' + data.fmr_studio.toLocaleString('en-US') : '—';
      const oneBr = data.fmr_1br != null ? '$' + data.fmr_1br.toLocaleString('en-US') : '—';
      const twoBr = data.fmr_2br != null ? '$' + data.fmr_2br.toLocaleString('en-US') : '—';
      const metro = data.fmr_metro_name ? escapeHtml(data.fmr_metro_name) : 'this metro';
      const yr = data.fmr_year ? escapeHtml(String(data.fmr_year)) : '—';
      fmrBlock = `<p><strong>Fair Market Rents (${metro}, ${yr}):</strong><br>
Studio: <strong>${studio}/mo</strong><br>
1BR: <strong>${oneBr}/mo</strong><br>
2BR: <strong>${twoBr}/mo</strong><br>
<small>Source: HUD User FMR API.</small></p>`;
    }

    marketHtml = `<h2>Location &amp; market</h2>
<p>Area median household income: <strong>${escapeHtml(income)}</strong><br>
Local population (ZIP ${escapeHtml(data.census_zip || '')}): <strong>${escapeHtml(pop)}</strong>${hhLine}</p>
<p class="meta">Source: U.S. Census Bureau ACS 5-Year Estimates (2018-2022) — study S037.</p>
${anchorBlock}
${transitBlock}
${permitsBlock}
${usdaBlock}
${fmrBlock}`;
  }

  // Operations / brand line — quick visibility on the smaller new signals
  const opsBits = [];
  if (data.hours_complete === true) opsBits.push('hours fully listed (7 days)');
  else if (data.hours_complete === false) opsBits.push('hours incomplete');
  if (data.is_open_now === true) opsBits.push('open now');
  else if (data.is_open_now === false) opsBits.push('closed now');
  if (data.website_exists === true) opsBits.push('website loads');
  else if (data.website_exists === false) opsBits.push('website returned error');
  else if (data.website_url && data.website_exists == null) opsBits.push('website check inconclusive');
  if (data.website_url == null) opsBits.push('no website on Google Business Profile');
  // FIX 4 — owner-response rate display logic. Google's legacy Places
  // Details API frequently omits the owner-reply field even when the
  // owner DID reply on the live GBP. With a sample of only 5 reviews
  // (the legacy max), a "0%" reading is much more often a measurement
  // gap than a real signal — show "insufficient data" instead.
  if (typeof data.response_rate_estimated === 'number') {
    const sampleSize = typeof data.reviews_sampled === 'number' ? data.reviews_sampled : 0;
    if (data.response_rate_estimated === 0 && sampleSize <= 5) {
      opsBits.push(`owner-response rate: insufficient data (sampled ${sampleSize} review${sampleSize === 1 ? '' : 's'} only)`);
    } else if (data.response_rate_estimated === 0) {
      opsBits.push(`owner-response rate: 0% — no responses detected (sample: ${sampleSize})`);
    } else {
      opsBits.push(`owner-response rate (sample of ${sampleSize}): ${(data.response_rate_estimated * 100).toFixed(0)}%`);
    }
  }
  // Phase 5+ — PageSpeed mobile signals
  if (typeof data.website_mobile_score === 'number') {
    const tier = data.website_mobile_score < 50
      ? 'NEEDS WORK'
      : data.website_mobile_score < 80
      ? 'GOOD'
      : 'STRONG';
    opsBits.push(`mobile score: ${data.website_mobile_score}/100 ${tier}`);
  }
  if (typeof data.load_time_seconds === 'number') {
    const flag = data.load_time_seconds > 3
      ? '⚠️ above 3-second abandonment threshold (S040)'
      : '✅ fast';
    opsBits.push(`load time: ${data.load_time_seconds}s ${flag}`);
  }
  // Phase 5+ — NPI license status (healthcare profiles only).
  if (data.npi) {
    const status = data.npi_authorized ? 'NPI Active ✅' : `NPI ${data.npi_status || '—'} ⚠️`;
    const num = data.npi_number ? ` (NPI ${escapeHtml(String(data.npi_number))})` : '';
    const ptype = data.provider_type ? ` · ${escapeHtml(String(data.provider_type))}` : '';
    opsBits.push(`${status}${num}${ptype}`);
  }
  const opsHtml = opsBits.length
    ? `<h2>Operations &amp; brand</h2><p>${opsBits.map(escapeHtml).join(' · ')}</p>`
    : '';

  // Phase 5+ — Demand & seasonality (Open-Meteo + Ticketmaster + BLS)
  let demandHtml = '';
  const seasonalityLines = [];
  if (data.peak_tourist_season) {
    seasonalityLines.push(`<strong>Peak season:</strong> ${escapeHtml(data.peak_tourist_season)}`);
  }
  if (data.has_cold_winter === true) {
    seasonalityLines.push('<strong>Cold winter market</strong> — plan an off-season strategy (one or more months average below 35°F).');
  }
  if (data.has_hot_summer === true) {
    seasonalityLines.push('<strong>Hot summer market</strong> — peak demand May-September (one or more months average above 85°F).');
  }
  // Phase 5+ — BLS sector employment level (only fires for the 5 wired
  // NAICS-2 sectors: 23, 44-45, 54, 61, 62).
  if (typeof data.bls_employment_level === 'number') {
    const periodPart = data.bls_employment_period ? `${escapeHtml(data.bls_employment_period)} ` : '';
    const yearPart = data.bls_employment_year ? escapeHtml(String(data.bls_employment_year)) : '';
    seasonalityLines.push(`<strong>Local employment (sector-wide):</strong> ${data.bls_employment_level.toLocaleString('en-US')} jobs (${periodPart}${yearPart}). <small>Source: BLS Public Data API.</small>`);
  }
  const events = Array.isArray(data.upcoming_events) ? data.upcoming_events : [];
  let eventsBlock = '';
  if (events.length) {
    const items = events.map((e) => {
      const venue = e.venue ? ` at ${escapeHtml(e.venue)}` : '';
      const when = e.date ? escapeHtml(e.date.replace('T', ' ').slice(0, 16)) : 'date TBA';
      return `<li>${escapeHtml(e.name)} — ${when}${venue}</li>`;
    }).join('');
    eventsBlock = `<p><strong>Upcoming events within 10km (next 90 days):</strong></p><ul>${items}</ul>
<p class="meta"><small>Source: Ticketmaster Discovery API v2.</small></p>`;
  }
  if (seasonalityLines.length || eventsBlock) {
    const seasonalityBlock = seasonalityLines.length
      ? `<p>${seasonalityLines.join('<br>')}</p>`
      : '';
    demandHtml = `<h2>Demand &amp; seasonality</h2>${seasonalityBlock}${eventsBlock}`;
  }

  // BATCH16 — top-10 ranking with impact labels.
  // ── Priority actions ─────────────────────────────────────────────
  // Two render paths:
  //   (a) Claude returned enriched.priority_actions[] → render new
  //       styled cards via renderActionCard (action.impact / source /
  //       title / what / why / money_estimate / cost / timeline).
  //   (b) Otherwise → fall through to the existing ranker-driven
  //       renderRec3Layer rendering (preserved unchanged below).
  const claudePriorityActions = (enriched && Array.isArray(enriched.priority_actions))
    ? enriched.priority_actions.filter((a) => a && typeof a === 'object' && (a.title || a.what))
    : [];

  let priorityHtml = '';
  const top10 = ranked.top10 || [];

  if (claudePriorityActions.length > 0) {
    // Path (a) — Claude priority_actions present.
    const total = claudePriorityActions.length;
    const highCount = claudePriorityActions.filter((a) => String(a.impact || '').toUpperCase() === 'HIGH').length;
    const headerNote = highCount > 0
      ? `Of these ${total} actions, ${highCount} ${highCount === 1 ? 'is' : 'are'} HIGH IMPACT. AI-tagged actions are generated from your real business data.`
      : `${total} prioritized actions, generated from your real business data. None tagged HIGH IMPACT — focus on the highest-ranked items first.`;
    priorityHtml = `<div style="margin-bottom: 16px;">
  <h2>Priority actions</h2>
  <p style="font-size: 13px; color: #6B7280; margin: 4px 0 0 0;">${escapeHtml(headerNote)}</p>
</div>`;
    priorityHtml += claudePriorityActions.map((a) => renderActionCard(a)).join('');
  } else if (!top10.length) {
    // Path (b) — empty fallback.
    priorityHtml = `<h2>Priority actions</h2>`;
    priorityHtml += `<p>No recommendations triggered for this business.</p>`;
  } else {
    priorityHtml = `<h2>Priority actions</h2>`;
    const total = top10.length;
    const high = ranked.highImpactCount || 0;
    const summary = high > 0
      ? `Of these ${total} actions, focus on the ${high} HIGH IMPACT item${high === 1 ? '' : 's'} first. Lower-impact items are worth doing once the high-impact ones are handled.`
      : `Of these ${total} actions, none are HIGH IMPACT — this business is healthy on the dimensions we measure. Lower-impact polish wins are listed in priority order.`;
    priorityHtml += `<p class="meta">${escapeHtml(summary)}</p>`;
    // CHANGE 3 — classify each top-10 rec as HIDDEN / KNOWN / normal
    // and re-sort: HIDDEN at top regardless of score, KNOWN at bottom
    // with score capped at 0.30.
    classifyKnownHidden(top10, data);
    // CHANGE 6 — attach money estimate HTML where it qualifies.
    for (const t of top10) {
      t.moneyEstimateHtml = buildMoneyEstimate(t, data, profile, studies);
    }
    // Phase 5 — index Claude's enriched recs by id so the first 3 entries
    // can use them. Recs 4-10 keep the Phase-4 deterministic format.
    const enrichedById = new Map();
    if (enriched && Array.isArray(enriched.enriched_recommendations)) {
      for (const er of enriched.enriched_recommendations) {
        if (er && er.id) enrichedById.set(er.id, er);
      }
    }
    priorityHtml += top10.map((t, idx) => {
      const tags = [];
      if (t.classification === 'hidden') {
        tags.push({ cls: 'hidden', label: 'HIDDEN ISSUE — unique to your business' });
      } else if (t.classification === 'known') {
        tags.push({ cls: 'known', label: 'KNOWN ISSUE — common in your market' });
      }
      // Top 3 only get Claude's enriched layers (when available).
      const claudeRec = idx < 3 ? enrichedById.get(t.rec.id) : null;
      const html = renderRec3Layer(t, idx, data, studies, tags, claudeRec);
      // Append the classification reason as a small meta line just under the header.
      if (t.classificationReason) {
        return html.replace(
          /<\/h3>/,
          `</h3><p class="meta classification-reason">${escapeHtml(t.classificationReason)}</p>`
        );
      }
      return html;
    }).join('');
  }

  // ── Three new Claude-driven sections (rendered between priority
  // actions and the 90-day plan): competitor deep-dive, key risks,
  // execution templates. Each helper returns '' when data is missing
  // so the section is silently omitted from the report.
  const competitorDeepDiveHtml = enriched
    ? renderCompetitorDeepDive(enriched.competitor_deep_dive, enriched.outperformed_competitors)
    : '';
  const keyRisksHtml = enriched
    ? renderKeyRisks(enriched.key_risks)
    : '';
  const executionTemplatesHtml = enriched
    ? renderExecutionTemplates(enriched.execution_templates)
    : '';

  // BATCH16 — Common Problems Detected (review-mined themes)
  // BUG 20 — Defensive `|| []` at call site. The function already
  // null-guards internally (returns {skip:true, reason:'no-reviews'}
  // for non-array / empty input), but passing `[]` here makes intent
  // explicit and matches the analyzeCommonProblems contract for any
  // future callers who don't read the function body first.
  const cpAnalysis = analyzeCommonProblems(data.sample_reviews || [], profile.id);
  const commonProblemsHtml = renderCommonProblems(cpAnalysis);

  // ── FIX 3 — 90-day action plan ────────────────────────────────────
  // Renders when Claude enrichment returned a ninety_day_plan object.
  // Three cards (month 1 = blue, month 2 = amber, month 3 = green).
  // Month 1 has weekly granularity; months 2-3 have month-level focus.
  // Section is omitted entirely when enriched.ninety_day_plan is missing
  // — preserves backwards compat with reports that pre-date this fix.
  let ninetyDayPlanHtml = '';
  if (enriched && enriched.ninety_day_plan && typeof enriched.ninety_day_plan === 'object') {
    const plan = enriched.ninety_day_plan;
    const m1 = plan.month_1 || {};
    const m2 = plan.month_2 || {};
    const m3 = plan.month_3 || {};
    const m1Html = `<div class="rec rec-medium">
<h3>Month 1${m1.theme ? ` &mdash; ${escapeHtml(m1.theme)}` : ''}</h3>
${m1.week_1 ? `<p><strong>Week 1:</strong> ${escapeHtml(m1.week_1)}</p>` : ''}
${m1.week_2 ? `<p><strong>Week 2:</strong> ${escapeHtml(m1.week_2)}</p>` : ''}
${m1.week_3 ? `<p><strong>Week 3:</strong> ${escapeHtml(m1.week_3)}</p>` : ''}
${m1.week_4 ? `<p><strong>Week 4:</strong> ${escapeHtml(m1.week_4)}</p>` : ''}
${m1.goal ? `<p class="meta"><strong>Goal:</strong> ${escapeHtml(m1.goal)}</p>` : ''}
</div>`;
    const m2Html = `<div class="rec rec-low">
<h3>Month 2${m2.theme ? ` &mdash; ${escapeHtml(m2.theme)}` : ''}</h3>
${m2.focus ? `<p><strong>Focus:</strong> ${escapeHtml(m2.focus)}</p>` : ''}
${m2.goal ? `<p class="meta"><strong>Goal:</strong> ${escapeHtml(m2.goal)}</p>` : ''}
</div>`;
    const m3Html = `<div class="rec rec-high">
<h3>Month 3${m3.theme ? ` &mdash; ${escapeHtml(m3.theme)}` : ''}</h3>
${m3.focus ? `<p><strong>Focus:</strong> ${escapeHtml(m3.focus)}</p>` : ''}
${m3.goal ? `<p class="meta"><strong>Goal:</strong> ${escapeHtml(m3.goal)}</p>` : ''}
</div>`;
    ninetyDayPlanHtml = `<h2>90-day action plan <span class="ai-badge">AI</span></h2>
<p class="meta">Three months of progressive depth. Month 1 has weekly steps; months 2 and 3 have month-level focus and goals.</p>
${m1Html}
${m2Html}
${m3Html}`;
  }

  // ── FIX 6 — Seasonal strategy ─────────────────────────────────────
  // Four cards (Summer / Fall / Winter / Spring), rendered in order.
  // Winter renders an extra amber off-season-survival callout when
  // present (required for cold-winter markets per SYSTEM_PROMPT).
  let seasonalStrategyHtml = '';
  if (enriched && enriched.seasonal_strategy && typeof enriched.seasonal_strategy === 'object') {
    const ss = enriched.seasonal_strategy;
    const SEASON_ICONS = { summer: '☀️', fall: '🍂', winter: '❄️', spring: '🌸' };
    function renderSeasonCard(season, s) {
      if (!s || typeof s !== 'object') return '';
      const icon = SEASON_ICONS[season] || '';
      const title = `${icon} ${season.charAt(0).toUpperCase() + season.slice(1)}`;
      const offSeasonBlock = (season === 'winter' && s.off_season_survival)
        ? `<div class="honesty honesty-customer-must-validate"><strong>Off-season survival:</strong> ${escapeHtml(s.off_season_survival)}</div>`
        : '';
      return `<div class="rec rec-medium">
<h3>${title}${s.dominant_persona ? ` <span class="meta">&mdash; ${escapeHtml(s.dominant_persona)}</span>` : ''}</h3>
${s.what_to_add ? `<p><strong>What to add:</strong> ${escapeHtml(s.what_to_add)}</p>` : ''}
${s.marketing_message ? `<div class="callout"><div class="callout-label">Headline</div><p>"${escapeHtml(s.marketing_message)}"</p></div>` : ''}
${s.event_tie_in ? `<p><strong>Event tie-in:</strong> ${escapeHtml(s.event_tie_in)}</p>` : ''}
${s.local_partner ? `<p><strong>Local partner:</strong> ${escapeHtml(s.local_partner)}</p>` : ''}
${s.revenue_range ? `<p class="meta">Revenue: <strong>${escapeHtml(s.revenue_range)}</strong></p>` : ''}
${offSeasonBlock}
</div>`;
    }
    const cards = ['summer', 'fall', 'winter', 'spring']
      .map((season) => renderSeasonCard(season, ss[season]))
      .filter(Boolean)
      .join('');
    if (cards) {
      seasonalStrategyHtml = `<h2>Seasonal strategy <span class="ai-badge">AI</span></h2>
<p class="meta">Per-season playbook. Each season names a real local event tie-in and a real local partner from your competitor or nearby-venues data.</p>
${cards}`;
    }
  }

  // Phase 5 — OPPORTUNITIES NOBODY IN YOUR MARKET IS DOING
  // (only renders when Claude enrichment succeeded and produced opportunities)
  let opportunitiesHtml = '';
  if (enriched && Array.isArray(enriched.opportunities) && enriched.opportunities.length) {
    opportunitiesHtml = `<h2>Opportunities nobody in your market is doing</h2>
<p class="meta">${enriched.opportunities.length} location-specific ideas drawn from 18 opportunity categories. Each names real local entities — events, producers, landmarks. Validate cost and revenue against your own pipeline before committing budget.</p>` +
    enriched.opportunities.map((o) => {
      const novelty = o.novelty || '';
      const noveltyCls = /zero competitors|0 competitors/i.test(novelty)
        ? 'novelty-unique'
        : /rare/i.test(novelty)
        ? 'novelty-rare'
        : 'novelty-common';
      return `<div class="opportunity">
<div class="op-meta"><span class="op-category">${escapeHtml(o.category || '—')}</span><span class="op-novelty ${noveltyCls}">${escapeHtml(novelty)}</span></div>
<h3>${escapeHtml(o.title || '')}</h3>
<p>${escapeHtml(o.idea || '')}</p>
<p class="meta">
<strong>Cost:</strong> ${escapeHtml(o.cost || '—')} ·
<strong>Revenue potential:</strong> ${escapeHtml(o.revenue_potential || '—')} ·
<strong>Review-mention probability:</strong> ${escapeHtml(o.review_mention_probability || '—')}
</p>
</div>`;
    }).join('');
  }

  // ───── BATCH14 — Category coverage footer (C1-C7 with actual values) ─────
  const fmt = (v) => (v == null || (typeof v === 'number' && Number.isNaN(v))) ? 'unmeasured' : String(v);
  const c1Items = [];
  if (typeof data.google_rating === 'number') c1Items.push(`rating ${data.google_rating.toFixed(1)}`);
  if (typeof data.google_review_count === 'number') c1Items.push(`${data.google_review_count} reviews`);
  if (typeof data.review_recency_days === 'number') c1Items.push(`recency ${data.review_recency_days}d`);
  // FIX 4 — gate on sample size (same logic as the Ops & brand block).
  if (typeof data.response_rate_estimated === 'number') {
    const _ss = typeof data.reviews_sampled === 'number' ? data.reviews_sampled : 0;
    if (data.response_rate_estimated === 0 && _ss <= 5) {
      c1Items.push(`owner-response insufficient data (sample ${_ss})`);
    } else {
      c1Items.push(`owner-response ${(data.response_rate_estimated * 100).toFixed(0)}% (sample ${_ss})`);
    }
  }
  // Phase 5+ — TripAdvisor presence
  if (typeof data.ta_rating === 'number') {
    const reviews = typeof data.ta_review_count === 'number' ? `${data.ta_review_count.toLocaleString('en-US')} reviews` : '';
    const rank = (data.ta_ranking_position && data.ta_ranking_out_of)
      ? `, ranked #${data.ta_ranking_position} of ${data.ta_ranking_out_of}`
      : '';
    c1Items.push(`TA: ${data.ta_rating.toFixed(1)}★${reviews ? ` (${reviews})` : ''}${rank}`);
  }
  const c1Line = c1Items.length ? c1Items.join(', ') : 'data pending';

  const c2Items = [];
  if (typeof data.median_household_income === 'number') c2Items.push(`median income $${data.median_household_income.toLocaleString('en-US')}`);
  if (typeof data.total_population === 'number') c2Items.push(`pop ${data.total_population.toLocaleString('en-US')} (ZIP ${data.census_zip || '—'})`);
  if (typeof data.average_household_size === 'number') c2Items.push(`avg household ${data.average_household_size.toFixed(2)}`);
  // Phase 5+ — anchor tenants + transit (Overpass)
  if (typeof data.anchor_tenant_count === 'number' && data.anchor_tenant_count > 0) {
    c2Items.push(`${data.anchor_tenant_count} anchor tenant${data.anchor_tenant_count === 1 ? '' : 's'} within 500m`);
  } else if (data.anchor_tenant_count === 0) {
    c2Items.push('no anchor tenants within 500m');
  }
  if (data.has_transit_nearby === true) c2Items.push('transit ≤400m');
  else if (data.has_transit_nearby === false) c2Items.push('no transit within 800m');
  // Phase 5+ — county building permits (HUD/Census BPS)
  if (typeof data.building_permits_total === 'number' && data.building_permits_year) {
    const yoy = data.building_permits_yoy_change != null
      ? ` (${data.building_permits_yoy_change >= 0 ? '+' : ''}${data.building_permits_yoy_change}% YoY)`
      : '';
    c2Items.push(`${data.building_permits_total} county permits ${data.building_permits_year}${yoy}`);
  }
  // Phase 5+ — USDA NASS top crop (agriculture only)
  if (data.top_commodity) {
    c2Items.push(`top crop: ${data.top_commodity.toLowerCase()}`);
  }
  // Phase 5+ — HUD Fair Market Rents (real-estate only)
  if (typeof data.fmr_2br === 'number') {
    c2Items.push(`FMR 2BR: $${data.fmr_2br.toLocaleString('en-US')}/mo${data.fmr_metro_name ? ` (${data.fmr_metro_name})` : ''}`);
  }
  const c2Line = c2Items.length ? c2Items.join(', ') : 'data pending';

  const c3Items = [];
  if (typeof data.competitor_count === 'number') c3Items.push(`${data.competitor_count} competitors within 5 mi`);
  if (typeof data.competitor_median_rating === 'number') c3Items.push(`median ${data.competitor_median_rating.toFixed(1)}★`);
  if (typeof data.competitor_median_review_count === 'number') c3Items.push(`median ${Math.round(data.competitor_median_review_count)} reviews`);
  // Phase 5+ — FDIC bank deposit ranking (banking / finance only)
  if (typeof data.fdic_total_deposits === 'number') {
    const depM = (data.fdic_total_deposits / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 });
    c3Items.push(`FDIC deposits: $${depM}M`);
  }
  const c3Line = c3Items.length ? c3Items.join(', ') : 'data pending';

  // Phase 5+ — Open-Meteo climatology + Ticketmaster + BLS fill C4 Demand
  const c4Items = [];
  if (data.peak_tourist_season) c4Items.push(`peak season ${data.peak_tourist_season}`);
  if (data.has_cold_winter === true) c4Items.push('cold winter');
  if (data.has_hot_summer === true) c4Items.push('hot summer');
  const eventCount = Array.isArray(data.upcoming_events) ? data.upcoming_events.length : 0;
  if (eventCount > 0) c4Items.push(`${eventCount} upcoming event${eventCount === 1 ? '' : 's'} within 10km`);
  // Phase 5+ — BLS sector-wide employment level (5 sectors only)
  if (typeof data.bls_employment_level === 'number') {
    c4Items.push(`sector employment ${data.bls_employment_level.toLocaleString('en-US')} (${data.bls_employment_period || ''} ${data.bls_employment_year || ''})`);
  }
  const c4Line = c4Items.length
    ? c4Items.join(', ') + ' — Open-Meteo climatology + Ticketmaster Discovery v2 + BLS'
    : 'data pending (Google Trends + local events)';

  const c5Items = [];
  c5Items.push(data.hours_complete === true ? 'hours: complete (7 days)' : data.hours_complete === false ? 'hours: incomplete' : 'hours: unmeasured');
  c5Items.push(data.website_exists === true ? 'website: loads' : data.website_exists === false ? 'website: not loading / blocked' : (data.website_url ? 'website: check inconclusive' : 'website: not listed on GBP'));
  if (data.is_open_now === true) c5Items.push('open now');
  else if (data.is_open_now === false) c5Items.push('closed now');
  const c5Line = c5Items.join(', ');

  // Phase 5+ — PageSpeed Insights fills C6 Brand
  const c6Items = [];
  if (typeof data.website_mobile_score === 'number') c6Items.push(`mobile score ${data.website_mobile_score}/100`);
  if (typeof data.load_time_seconds === 'number') c6Items.push(`load ${data.load_time_seconds}s`);
  if (typeof data.lcp_seconds === 'number') c6Items.push(`LCP ${data.lcp_seconds}s`);
  const c6Line = c6Items.length
    ? c6Items.join(', ') + ' — Google PageSpeed Insights (mobile)'
    : 'data pending (no website to measure, or PSI failed/timed out)';

  const c7Items = [];
  if (Array.isArray(profile.compliance_notes) && profile.compliance_notes.length) {
    c7Items.push(`${profile.compliance_notes.length} sector compliance note${profile.compliance_notes.length === 1 ? '' : 's'} applied`);
  }
  if (typeof data.google_review_count === 'number' && data.google_review_count === 0) c7Items.push('zero-reviews flag fires');
  if (data.business_status && data.business_status !== 'OPERATIONAL') c7Items.push(`business_status: ${data.business_status}`);
  // Phase 5+ — sector compliance signals
  if (data.npi) {
    c7Items.push(`NPI ${data.npi_authorized ? 'Active' : (data.npi_status || 'unknown')}${data.npi_number ? ` (#${data.npi_number})` : ''}`);
  }
  if (data.fmcsa && data.dot_number) {
    const sr = data.safety_rating || 'unrated';
    c7Items.push(`FMCSA ${sr}, DOT#${data.dot_number}`);
  }
  if (data.cms && data.cms_overall_rating != null && data.cms_overall_rating !== '') {
    c7Items.push(`CMS overall ${data.cms_overall_rating}/5`);
  }
  const c7Line = c7Items.length ? c7Items.join('; ') : 'no compliance flags';

  // Per-category top-10 contribution: which categories produced top-10 actions?
  const fieldToCategory = (f) => {
    const c1 = ['google_rating', 'google_review_count', 'review_recency_days', 'response_rate_estimated', 'responds_to_reviews', 'photo_count', 'platform_count', 'business_age_months', 'reviews_sampled',
      'ta_rating', 'ta_review_count', 'ta_ranking_position', 'ta_ranking_out_of',
      'ta_subratings', 'ta_value_gap_detected'];
    const c2 = ['median_household_income', 'total_population', 'average_household_size',
      'anchor_tenant_count', 'has_transit_nearby', 'nearest_transit_meters',
      'building_permits_total', 'building_permits_single_family',
      'building_permits_yoy_change', 'building_permits_year', 'county_fips',
      'nearby_venues', 'nearby_venue_count',
      'top_commodity', 'farm_count', 'state_ag_profile',
      'fmr_studio', 'fmr_1br', 'fmr_2br', 'fmr_metro_name', 'fmr_year'];
    const c3 = ['competitor_count', 'competitor_median_rating', 'competitor_median_review_count',
      'fdic_total_deposits', 'fdic_total_assets', 'fdic_bank_name'];
    const c4 = ['peak_tourist_season', 'has_cold_winter', 'has_hot_summer', 'peak_month',
      'bls_employment_level', 'bls_employment_year', 'bls_employment_period'];
    const c5 = ['hours_complete', 'is_open_now', 'online_booking', 'accepts_credit_cards', 'accepts_insurance_visible'];
    const c6 = ['website_exists', 'website_url', 'page_speed_seconds', 'website_mobile_friendly',
      'website_mobile_score', 'load_time_seconds', 'lcp_seconds', 'is_mobile_friendly'];
    const c7 = ['business_status', 'years_in_business',
      'npi_status', 'npi_authorized', 'npi_number', 'provider_type',
      'safety_rating', 'allowed_to_operate', 'dot_number', 'total_drivers', 'total_trucks',
      'cms_overall_rating', 'cms_patient_experience_rating', 'cms_mortality_rating',
      'cms_safety_rating', 'cms_readmission_rating', 'cms_timeliness_rating'];
    if (c1.includes(f)) return 'C1';
    if (c2.includes(f)) return 'C2';
    if (c3.includes(f)) return 'C3';
    if (c4.includes(f)) return 'C4';
    if (c5.includes(f)) return 'C5';
    if (c6.includes(f)) return 'C6';
    if (c7.includes(f)) return 'C7';
    return null;
  };
  const topByCat = { C1: [], C2: [], C3: [], C4: [], C5: [], C6: [], C7: [] };
  (ranked.top10 || []).forEach((t, idx) => {
    const ev = evidenceForRec(t.rec, data);
    const cats = new Set();
    for (const c of ev.compares) {
      const cat = fieldToCategory(c.field);
      if (cat) cats.add(cat);
    }
    for (const f of ev.unknowns) {
      const cat = fieldToCategory(f);
      if (cat) cats.add(cat);
    }
    for (const cat of cats) topByCat[cat].push(`#${idx + 1}`);
  });
  const tagFor = (cat) => topByCat[cat].length ? ` — actions: ${topByCat[cat].join(', ')}` : '';

  // Phase 5+ — dynamic C8-C11 rows. C8/C9/C10 only render when their
  // data field is populated. C11 always renders — events array may be
  // empty and that's still useful information ("no major events").
  const extraRows = [];
  if (data.hud_fmr && data.hud_fmr.fmr_2br != null) {
    const fmr = data.hud_fmr;
    const metro = fmr.metro_name || '—';
    const yr = fmr.fmr_year || '—';
    extraRows.push(`<tr><td><strong>C8 Regional Rents</strong></td><td>2BR rent benchmark: $${fmr.fmr_2br.toLocaleString('en-US')}/mo (${escapeHtml(String(metro))}, ${escapeHtml(String(yr))})</td></tr>`);
  }
  if (data.bls_employment && data.bls_employment.employment_level != null) {
    const bls = data.bls_employment;
    const period = bls.employment_period || '';
    const yr = bls.employment_year || '';
    const periodLabel = (period || yr) ? `${period} ${yr}`.trim() : '—';
    extraRows.push(`<tr><td><strong>C9 Employment Trend</strong></td><td>${bls.employment_level.toLocaleString('en-US')} sector jobs nationally (${escapeHtml(periodLabel)})</td></tr>`);
  }
  if (Array.isArray(data.nearby_venues) && data.nearby_venues.length > 0) {
    const top3 = data.nearby_venues.slice(0, 3).map((v) => v.name).join(', ');
    extraRows.push(`<tr><td><strong>C10 Nearby Venues</strong></td><td>Top nearby: ${escapeHtml(top3)}</td></tr>`);
  }
  // C11 always renders — the absence of events is itself a signal.
  {
    const events = Array.isArray(data.upcoming_events) ? data.upcoming_events : [];
    const content = events.length > 0
      ? `${events.length} events within 10mi next 90 days`
      : 'No major events found within 10mi';
    extraRows.push(`<tr><td><strong>C11 Upcoming Events</strong></td><td>${escapeHtml(content)}</td></tr>`);
  }

  const totalCategoryCount = 7 + extraRows.length;
  const categoryCoverageHtml = `<h2>What we analyzed — ${totalCategoryCount} signal categories</h2>
<table class="coverage">
  <tr><td><strong>C1 Online Presence</strong></td><td>${escapeHtml(c1Line)}${tagFor('C1')}</td></tr>
  <tr><td><strong>C2 Location &amp; Market</strong></td><td>${escapeHtml(c2Line)}${tagFor('C2')}</td></tr>
  <tr><td><strong>C3 Competition</strong></td><td>${escapeHtml(c3Line)}${tagFor('C3')}</td></tr>
  <tr><td><strong>C4 Demand</strong></td><td>${escapeHtml(c4Line)}${tagFor('C4')}</td></tr>
  <tr><td><strong>C5 Operations</strong></td><td>${escapeHtml(c5Line)}${tagFor('C5')}</td></tr>
  <tr><td><strong>C6 Brand</strong></td><td>${escapeHtml(c6Line)}${tagFor('C6')}</td></tr>
  <tr><td><strong>C7 Risk &amp; Compliance</strong></td><td>${escapeHtml(c7Line)}${tagFor('C7')}</td></tr>
  ${extraRows.join('\n  ')}
</table>`;

  let footerHtml = `<h2>Citations</h2>`;
  if (allCitedIds.size === 0) {
    footerHtml += `<p>No studies cited.</p>`;
  } else {
    footerHtml += `<ul>${Array.from(allCitedIds).map((id) => {
      const s = studies.find((x) => x.id === id);
      if (!s) return `<li>${escapeHtml(id)} (not found)</li>`;
      const tier3 = s.tier === 3 ? ' <small>[TIER-3 VENDOR]</small>' : '';
      return `<li><strong>${escapeHtml(s.id)}</strong> (Tier ${s.tier})${tier3}: ${escapeHtml(s.citation)}</li>`;
    }).join('')}</ul>`;
  }
  footerHtml += `<p class="meta"><small>Generated ${new Date().toISOString()}</small></p>`;

  // Chart.js visual layer — seven charts (matrix, ratings, reviews,
  // seasonal, pagespeed, income, permits). Rendered right after the
  // priority-actions section. Each chart self-guards on data
  // availability and falls back to a small "Data not available" box,
  // so the section is safe to include for every profile.
  const chartsHtml = renderMarketCharts(
    data,
    profile,
    data && (data.name || data.business_name) || input
  );

  return `${PAGE_OPEN}<a class="back" href="/app">&larr; new search</a> <a class="back" href="/dashboard">&larr; Back to Dashboard</a>
${partialReportBanner}${claudeUnavailableBanner}${noWebsiteBanner}${lowConfidenceBanner}${headerHtml}
${overallHtml}
${localContextHtml}
${redFlagsHtml}
${strengthsHtml}
${industrySurvivalHtml}
${tripAdvisorHtml}
${qualityRatingsHtml}
${complianceHtml}
${competitiveHtml}
${competitorComparisonHtml}
${marketHtml}
${demandHtml}
${opsHtml}
${priorityHtml}
${chartsHtml}
${competitorDeepDiveHtml}
${keyRisksHtml}
${executionTemplatesHtml}
${ninetyDayPlanHtml}
${seasonalStrategyHtml}
${opportunitiesHtml}
${commonProblemsHtml}
${categoryCoverageHtml}
${footerHtml}${PAGE_CLOSE}`;
}

function citationLine(id, studies) {
  const s = studies.find((x) => x.id === id);
  if (!s) return `[${escapeHtml(id)}]`;
  const tier3 = s.tier === 3 ? ' [TIER-3 VENDOR]' : '';
  return `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.id)}</a> ${escapeHtml(s.citation)}${tier3}`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH16 — Common Problems Detected (review-mined)
// ───────────────────────────────────────────────────────────────────
// 8-step procedure from BATCH16.pdf p.3:
//   1. fetch reviews (already in data.sample_reviews)
//   2. match each review.text against sector vocabulary keywords
//   3. count mentions per theme
//   4. weight by star rating (1*=1.5, 2*=1.2, 3*=1.0, 4*=0.5, 5*=0.3)
//   5. rank by weighted_score, threshold >= 1.5
//   6. tag with [REVIEW EVIDENCE] / [REASONABLE INFERENCE] / [CUSTOMER MUST VALIDATE]
//   7. render top 3
//   8. edge cases: <10 reviews, no themes above threshold, non-English

const STAR_WEIGHTS = { 1: 1.5, 2: 1.2, 3: 1.0, 4: 0.5, 5: 0.3 };

function analyzeCommonProblems(reviews, profileId) {
  const sectorVocab = sectorProblems[profileId];
  if (!sectorVocab) {
    return { skip: true, reason: 'no-vocab' };
  }
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { skip: true, reason: 'no-reviews', reviewCount: 0 };
  }
  if (reviews.length < 5) {
    // Threshold set to 5 to match Google legacy API max review count.
    // Bump to 10 when Places API New is wired in Phase 5.
    return {
      skip: false,
      insufficient: true,
      reviewCount: reviews.length,
      sectorLabel: sectorVocab.sector_label,
    };
  }

  // Score each theme.
  const themeScores = sectorVocab.themes.map((theme) => {
    let mentions = 0;
    let weighted = 0;
    const matchingReviews = [];
    for (const r of reviews) {
      const text = (r.text || '').toLowerCase();
      if (!text) continue;
      const hit = theme.keywords.some((kw) => text.includes(kw.toLowerCase()));
      if (!hit) continue;
      mentions += 1;
      const star = typeof r.rating === 'number' ? Math.round(r.rating) : 3;
      const w = STAR_WEIGHTS[star] || 1.0;
      weighted += w;
      matchingReviews.push({ rating: star, weight: w });
    }
    return {
      name: theme.name,
      fix_direction: theme.fix_direction,
      mentions,
      weighted: +weighted.toFixed(2),
      matching: matchingReviews,
      hasOneStar: matchingReviews.some((m) => m.rating === 1),
      total: reviews.length,
    };
  }).filter((x) => x.weighted >= 1.5);

  themeScores.sort((a, b) => b.weighted - a.weighted);
  const topThemes = themeScores.slice(0, 3);

  return {
    skip: false,
    insufficient: false,
    reviewCount: reviews.length,
    sectorLabel: sectorVocab.sector_label,
    themes: topThemes,
    allBelowThreshold: topThemes.length === 0,
  };
}

function renderCommonProblems(analysis) {
  if (analysis.skip && analysis.reason === 'no-vocab') return '';
  if (analysis.skip && analysis.reason === 'no-reviews') return '';

  let body = '';
  if (analysis.insufficient) {
    body = `<p>Need more reviews for pattern analysis. We found ${analysis.reviewCount} review${analysis.reviewCount === 1 ? '' : 's'} on Google for this business; come back when you have 10+ Google reviews and we'll mine recurring complaint themes for you.</p>`;
  } else if (analysis.allBelowThreshold) {
    body = `<p>No recurring complaints detected in your last ${analysis.reviewCount} reviews. Review content looks healthy.</p>`;
  } else {
    body = `<p class="meta">Reading your last ${analysis.reviewCount} reviews against the ${escapeHtml(analysis.sectorLabel)} complaint vocabulary, ${analysis.themes.length} theme${analysis.themes.length === 1 ? '' : 's'} surfaced above threshold:</p>`;
    body += analysis.themes.map((th) => {
      const sevTag = th.hasOneStar
        ? ` <span class="extra-tag extra-tag-hidden">includes 1-star mention</span>`
        : '';
      return `<div class="problem">
<h3>${escapeHtml(th.name)}${sevTag}</h3>
<div class="honesty honesty-verified"><span class="hmark">[REVIEW EVIDENCE]</span> ${th.mentions} of ${th.total} reviews mention this (weighted score ${th.weighted}).</div>
<div class="honesty honesty-reasonable-inference"><span class="hmark">[REASONABLE INFERENCE]</span> Typically points to: ${escapeHtml(th.fix_direction)}.</div>
<div class="honesty honesty-customer-must-validate"><span class="hmark">[CUSTOMER MUST VALIDATE]</span> Confirm with your operations — the algorithm sees what reviewers wrote, not what's actually happening on-site.</div>
</div>`;
    }).join('');
  }

  return `<h2>What your customers are saying — common problems detected</h2>${body}`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH14 — Money-estimate methodology (CHANGE 6)
// ───────────────────────────────────────────────────────────────────
// Gates (all must pass — otherwise no money estimate is shown):
//   - Impact is HIGH or MEDIUM
//   - At least one cited study is Tier 1 or Tier 2 (not Tier 3 vendor)
//   - Recommendation magnitude string contains a parseable numeric % range
//   - Sector revenue baseline can be reasonably estimated
//
// Method:
//   1. Look up the profile's sector revenue baseline range [low, high]
//   2. Apply size multiplier (review-count-derived: small/med/large/very large)
//   3. Compute estimated annual revenue baseline = midpoint × multiplier
//   4. Apply the study % range to that baseline → $X–$Y/year
//   5. Show one-line math + standard caveat

const SECTOR_BASELINES_USD = {
  'hospitality.lodging': [800000, 5000000],
  'hospitality.full_service_restaurant': [500000, 2000000],
  'hospitality.cafe_quick_service': [300000, 1500000],
  'healthcare.dental_practice': [400000, 1500000],
  'healthcare.medical_practice': [400000, 1500000],
  'other_services.auto_repair': [300000, 1200000],
  'recreation.fitness_studio': [200000, 800000],
  'retail.specialty_brick_mortar': [200000, 1000000],
  'retail.auto_dealers': [2000000, 20000000],
  'retail.grocery_food': [400000, 2500000],
  'hospitality.bar_nightlife': [400000, 1500000],
  'hospitality.catering_special_food': [300000, 1500000],
};
const DEFAULT_BASELINE_USD = [150000, 600000];

function sizeMultiplier(reviewCount) {
  if (typeof reviewCount !== 'number') return 1.0;
  if (reviewCount < 50) return 0.5;
  if (reviewCount < 200) return 1.0;
  if (reviewCount < 500) return 1.5;
  return 2.0;
}

function sizeLabel(reviewCount) {
  if (typeof reviewCount !== 'number') return 'medium';
  if (reviewCount < 50) return 'small';
  if (reviewCount < 200) return 'medium';
  if (reviewCount < 500) return 'large';
  return 'very large';
}

/* Parse a magnitude string like "9-11% RevPAR per reputation point" or
   "1-3% RevPAR per 10pp lift" or "33% revenue impact" → [low, high] as
   decimals. Returns null when no numeric % is present. */
function parsePctMagnitude(magStr) {
  if (!magStr || typeof magStr !== 'string') return null;
  // Match "X-Y%" or "X to Y%" first.
  let m = magStr.match(/(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    const lo = parseFloat(m[1]) / 100;
    const hi = parseFloat(m[2]) / 100;
    if (lo > 0 && hi > 0 && lo <= hi) return [lo, hi];
  }
  // Single-percent fallback: "33%" → [33%, 33%] (tight range).
  m = magStr.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) {
    const v = parseFloat(m[1]) / 100;
    if (v > 0) return [v, v];
  }
  return null;
}

function pickKpi(profileId) {
  if (profileId.startsWith('hospitality.lodging')) return 'RevPAR (revenue per available room) monthly';
  if (profileId.startsWith('hospitality.bar_nightlife')) return 'monthly cover count + average tab';
  if (profileId.startsWith('hospitality')) return 'monthly cover count';
  if (profileId.startsWith('healthcare')) return 'new-patient acquisition rate';
  if (profileId.startsWith('other_services.auto_repair')) return 'monthly ticket count';
  if (profileId.startsWith('recreation.fitness_studio')) return '12-month member retention';
  if (profileId.startsWith('retail')) return 'monthly transaction count';
  if (profileId.startsWith('professional')) return 'monthly billable engagements';
  return 'monthly revenue';
}

function buildMoneyEstimate(t, data, profile, studies) {
  // Gate 1 — impact tier
  if (t.impact !== 'HIGH' && t.impact !== 'MEDIUM') return '';
  // Gate 2 — at least one Tier 1 or Tier 2 study
  const tiers = t.rec.study_ids
    .map((sid) => studies.find((s) => s.id === sid))
    .filter(Boolean)
    .map((s) => s.tier);
  if (!tiers.some((t) => t === 1 || t === 2)) return '';
  // Gate 3 — parseable % magnitude
  const pctRange = parsePctMagnitude(t.rec.magnitude);
  if (!pctRange) return '';
  // Gate 4 — baseline available (always true with default)
  const baselineRange = SECTOR_BASELINES_USD[profile.id] || DEFAULT_BASELINE_USD;
  const reviewCount = typeof data.google_review_count === 'number' ? data.google_review_count : null;
  const mult = sizeMultiplier(reviewCount);
  const sizeName = sizeLabel(reviewCount);
  const midBaseline = ((baselineRange[0] + baselineRange[1]) / 2) * mult;

  const lowMoney = Math.round(midBaseline * pctRange[0]);
  const highMoney = Math.round(midBaseline * pctRange[1]);

  const fmtUsd = (n) => '$' + n.toLocaleString('en-US');
  const pctLow = (pctRange[0] * 100).toFixed(pctRange[0] < 0.01 ? 2 : 1).replace(/\.0$/, '');
  const pctHigh = (pctRange[1] * 100).toFixed(pctRange[1] < 0.01 ? 2 : 1).replace(/\.0$/, '');
  const pctDisplay = pctLow === pctHigh ? `${pctLow}%` : `${pctLow}–${pctHigh}%`;
  const moneyDisplay = lowMoney === highMoney
    ? `${fmtUsd(lowMoney)}/year`
    : `${fmtUsd(lowMoney)}–${fmtUsd(highMoney)}/year`;
  const kpi = pickKpi(profile.id);
  const reviewNote = reviewCount != null
    ? `${reviewCount} review${reviewCount === 1 ? '' : 's'} → ${sizeName} (×${mult})`
    : `unknown size (default ×1.0)`;

  return `<div class="money">
<strong>Money estimate: ${moneyDisplay}</strong><br>
<span class="meta">Math: ${fmtUsd(baselineRange[0])}–${fmtUsd(baselineRange[1])} sector baseline → midpoint ${fmtUsd((baselineRange[0] + baselineRange[1]) / 2)} × size multiplier (${reviewNote}) = ${fmtUsd(Math.round(midBaseline))} estimated annual revenue. Apply ${pctDisplay} cited study magnitude → ${moneyDisplay}.</span><br>
<em class="meta">Sector averages used. Track ${escapeHtml(kpi)} to measure your actual lift.</em>
</div>`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH16 — KNOWN vs HIDDEN issue classification
// ───────────────────────────────────────────────────────────────────
//
// Compare each triggered rec's gap against competitor medians from the
// Phase-3 Nearby Search data. If competitors share the gap, mark KNOWN
// (cap score at 0.30, push to bottom). If competitors don't have it,
// mark HIDDEN (push to top regardless of raw score).
//
// Only `google_rating` and `google_review_count` gaps can be classified
// — those are the fields the Nearby Search returns medians for. Other
// gaps (response rate, recency, hours, etc.) stay 'normal' since we
// have no competitor signal for them.
function classifyKnownHidden(top10, data) {
  for (const t of top10) {
    const ev = evidenceForRec(t.rec, data);
    let classification = 'normal';
    let reason = '';

    for (const c of ev.compares) {
      const isLowComparison = c.op === '<' || c.op === '<=';
      if (!isLowComparison) continue;

      if (c.field === 'google_rating' && typeof data.competitor_median_rating === 'number' && c.threshold != null) {
        if (data.competitor_median_rating < c.threshold) {
          classification = 'known';
          reason = `competitors' median rating is ${data.competitor_median_rating.toFixed(1)} (also below benchmark ${c.threshold})`;
        } else {
          classification = 'hidden';
          reason = `competitors' median rating is ${data.competitor_median_rating.toFixed(1)} (above your gap threshold ${c.threshold})`;
        }
        break;
      }

      if (c.field === 'google_review_count' && typeof data.competitor_median_review_count === 'number' && c.threshold != null) {
        if (data.competitor_median_review_count < c.threshold) {
          classification = 'known';
          reason = `competitors' median review count is ${Math.round(data.competitor_median_review_count)} (also below benchmark ${c.threshold})`;
        } else {
          classification = 'hidden';
          reason = `competitors' median review count is ${Math.round(data.competitor_median_review_count)} (above your gap threshold ${c.threshold})`;
        }
        break;
      }
    }

    t.classification = classification;
    t.classificationReason = reason;

    if (classification === 'known') {
      t.score = Math.min(t.score, 0.30);
      // Recompute impact label after capping.
      if (t.score >= 0.60) t.impact = 'HIGH';
      else if (t.score >= 0.30) t.impact = 'MEDIUM';
      else if (t.score >= 0.10) t.impact = 'LOW';
      else t.impact = 'MINIMAL';
    }
  }

  // Re-sort: HIDDEN first (regardless of score), then normal by score desc,
  // then KNOWN at the bottom by capped score desc.
  const groupOrder = { hidden: 0, normal: 1, known: 2 };
  top10.sort((a, b) => {
    const ga = groupOrder[a.classification] ?? 1;
    const gb = groupOrder[b.classification] ?? 1;
    if (ga !== gb) return ga - gb;
    return b.score - a.score;
  });

  return top10;
}

// ───────────────────────────────────────────────────────────────────
// BATCH14 / BATCH16 — 3-layer recommendation rendering helpers
// ───────────────────────────────────────────────────────────────────

/* Walk a trigger AST and collect all (field, op, threshold) comparisons
   plus all is_unknown(field) invocations. Used to derive the [VERIFIED]
   evidence lines under "WHY YOUR BUSINESS". */
function collectTriggerEvidence(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'COMPARE' && node.left && node.left.type === 'FIELD') {
    let threshold = null;
    if (node.right && (node.right.type === 'NUMBER' || node.right.type === 'STRING' || node.right.type === 'BOOL')) {
      threshold = node.right.value;
    }
    out.compares.push({ field: node.left.name, op: node.op, threshold });
  }
  if (node.type === 'IS_UNKNOWN') {
    out.unknowns.push(node.field);
  }
  for (const k of ['left', 'right', 'operand']) {
    if (node[k]) collectTriggerEvidence(node[k], out);
  }
}

function evidenceForRec(rec, data) {
  const ev = { compares: [], unknowns: [] };
  try {
    const ast = triggerDsl.parse(rec.trigger);
    collectTriggerEvidence(ast, ev);
  } catch (e) {
    // bad trigger — skip evidence extraction
  }
  return ev;
}

/* Format a field value for display (handles null, booleans, percentages). */
function fmtFieldValue(field, value) {
  if (value === null || value === undefined) return 'unmeasured';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field.includes('rate') && typeof value === 'number' && value <= 1) {
    return (value * 100).toFixed(0) + '%';
  }
  if (field.includes('income') && typeof value === 'number') {
    return '$' + value.toLocaleString('en-US');
  }
  return String(value);
}

function fmtThreshold(field, threshold) {
  return fmtFieldValue(field, threshold);
}

function opPhrase(op) {
  switch (op) {
    case '<': return 'below';
    case '<=': return 'at or below';
    case '>': return 'above';
    case '>=': return 'at or above';
    case '==': return 'equal to';
    case '!=': return 'not equal to';
    default: return op;
  }
}

/* Build the three layers for a single ranked recommendation `t`. Returns
   an HTML block. The trailing money-estimate slot is filled in CHANGE 6.
   Phase 5: when `enrichedRec` is provided (top-3 only), Claude's enriched
   WHY-IT-WORKS / WHY-YOUR-BUSINESS / money_estimate replace the deterministic
   versions. WHAT (rec.claim) stays deterministic. */
// ─────────────────────────────────────────────────────────────────────
// renderActionCard — Claude priority_actions card renderer
// ─────────────────────────────────────────────────────────────────────
// Renders one card from the new enriched.priority_actions[] schema
// (added in claudeEnricher SYSTEM_PROMPT). Each action carries impact
// (HIGH/MEDIUM/LOW/MINIMAL), source ("AI" or "registry"), title, what,
// why, money_estimate, cost, timeline. Inline styles per spec; left
// border + impact pill + AI/VERIFIED-DATA pill + green money box.
const IMPACT_COLORS = {
  HIGH:    { border: '#10B981', bg: '#ECFDF5', text: '#065F46' },
  MEDIUM:  { border: '#2563EB', bg: '#EFF6FF', text: '#1D4ED8' },
  LOW:     { border: '#F59E0B', bg: '#FFFBEB', text: '#92400E' },
  MINIMAL: { border: '#9CA3AF', bg: '#F9FAFB', text: '#374151' },
};

function renderActionCard(action) {
  if (!action || typeof action !== 'object') return '';
  const impact = String(action.impact || 'MEDIUM').toUpperCase();
  const colors = IMPACT_COLORS[impact] || IMPACT_COLORS.MEDIUM;
  const source = action.source === 'registry' ? 'registry' : 'AI';
  const sourceBg = source === 'AI' ? '#EEF2FF' : '#F3F4F6';
  const sourceFg = source === 'AI' ? '#4F46E5' : '#374151';
  const sourceLabel = source === 'AI' ? 'AI' : 'VERIFIED DATA';

  const title = escapeHtml(action.title || '');
  const what = escapeHtml(action.what || '');
  const why = escapeHtml(action.why || '');
  const moneyEst = escapeHtml(action.money_estimate || '');
  const cost = escapeHtml(action.cost || '');
  const timeline = escapeHtml(action.timeline || '');

  const metaParts = [];
  if (cost) metaParts.push(`Cost: ${cost}`);
  if (timeline) metaParts.push(`Timeline: ${timeline}`);
  const metaLine = metaParts.length
    ? `<div style="font-size: 13px; color: #6B7280;">${metaParts.join(' &middot; ')}</div>`
    : '';

  return `<div class="action-card" style="border-left: 4px solid ${colors.border}; background: white; padding: 20px; margin-bottom: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
    <span style="background: ${colors.bg}; color: ${colors.text}; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">${impact} IMPACT</span>
    <span style="background: ${sourceBg}; color: ${sourceFg}; font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 4px;">${sourceLabel}</span>
  </div>
  <h3 style="font-size: 16px; font-weight: 600; color: #0F1729; margin: 0 0 12px 0;">${title}</h3>
  ${what ? `<div style="margin-bottom: 10px;"><span style="font-weight: 600; font-size: 13px; color: #374151;">WHAT: </span><span style="font-size: 14px; color: #374151; line-height: 1.6;">${what}</span></div>` : ''}
  ${why ? `<div style="margin-bottom: 10px;"><span style="font-weight: 600; font-size: 13px; color: #374151;">WHY YOUR BUSINESS: </span><span style="font-size: 14px; color: #374151; line-height: 1.6;">${why}</span></div>` : ''}
  ${moneyEst ? `<div style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 6px; padding: 10px 14px; margin-bottom: 10px;"><span style="font-weight: 600; font-size: 13px; color: #166534;">Money estimate: </span><span style="font-size: 14px; color: #166534;">${moneyEst}</span></div>` : ''}
  ${metaLine}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// renderCompetitorDeepDive — Claude competitor_deep_dive renderer
// ─────────────────────────────────────────────────────────────────────
// Renders the "why your top competitor is winning" section. Shows
// red factor cards (why_they_are_winning), green opportunity cards
// (their_weakness), and a dark "steal their customers" callout.
// Returns '' when the data is missing or empty so the section is
// silently omitted.
// Renders one card for a single competitor deep-dive object. Returns
// HTML string. Used internally by renderCompetitorDeepDive (which now
// iterates an array of deep-dives).
function renderSingleCompetitorCard(deep, index) {
  if (!deep || typeof deep !== 'object') return '';
  const wins = Array.isArray(deep.why_they_are_winning) ? deep.why_they_are_winning : [];
  const weak = Array.isArray(deep.their_weakness) ? deep.their_weakness : [];
  const steal = String(deep.steal_their_customers || '').trim();
  const compName = escapeHtml(deep.competitor_name || 'Top competitor');
  const reason = escapeHtml(deep.selection_reason || '');

  const winsHtml = wins.length
    ? `<h3 style="font-size: 14px; color: #991B1B; margin-bottom: 12px;">&#9888;&#65039; What they do better</h3>
${wins.map((w) => `<div style="border-left: 3px solid #FCA5A5; padding: 12px 16px; margin-bottom: 12px; background: #FFF5F5; border-radius: 0 6px 6px 0;">
  <div style="font-weight: 600; color: #991B1B; margin-bottom: 4px; font-size: 14px;">${escapeHtml(w.factor || '')}</div>
  ${w.their_position ? `<div style="font-size: 13px; color: #374151; margin-bottom: 6px;">${escapeHtml(w.their_position)}</div>` : ''}
  ${w.evidence ? `<div style="font-size: 12px; color: #6B7280; font-style: italic; margin-bottom: 6px; background: rgba(0,0,0,0.03); padding: 6px 10px; border-radius: 4px;">${escapeHtml(w.evidence)}</div>` : ''}
  ${w.your_gap ? `<div style="font-size: 13px; color: #374151; margin-bottom: 4px;"><strong>Gap:</strong> ${escapeHtml(w.your_gap)}</div>` : ''}
  ${w.close_the_gap ? `<div style="font-size: 13px; color: #065F46; font-weight: 500;">&rarr; ${escapeHtml(w.close_the_gap)}</div>` : ''}
</div>`).join('')}`
    : '';

  const weakHtml = weak.length
    ? `<h3 style="font-size: 14px; color: #065F46; margin: 20px 0 12px;">&#9989; Where they are vulnerable</h3>
${weak.map((w) => `<div style="border-left: 3px solid #6EE7B7; padding: 12px 16px; margin-bottom: 12px; background: #F0FDF4; border-radius: 0 6px 6px 0;">
  <div style="font-weight: 600; color: #065F46; margin-bottom: 4px; font-size: 14px;">${escapeHtml(w.complaint || '')}</div>
  ${w.evidence ? `<div style="font-size: 12px; color: #6B7280; font-style: italic; margin-bottom: 6px; background: rgba(0,0,0,0.03); padding: 6px 10px; border-radius: 4px;">${escapeHtml(w.evidence)}</div>` : ''}
  ${w.your_opportunity ? `<div style="font-size: 13px; color: #374151;"><strong>Your move:</strong> ${escapeHtml(w.your_opportunity)}</div>` : ''}
</div>`).join('')}`
    : '';

  const stealHtml = steal
    ? `<div style="background: #0F1729; color: white; padding: 20px; border-radius: 8px; margin-top: 20px;">
  <div style="font-weight: 600; color: #10B981; margin-bottom: 8px; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase;">&#127919; How to pull their customers</div>
  <div style="font-size: 14px; line-height: 1.7; color: #E5E7EB;">${escapeHtml(steal)}</div>
</div>`
    : '';

  return `<div style="border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 24px; overflow: hidden;">
  <div style="background: #F8FAFC; border-bottom: 1px solid #E5E7EB; padding: 12px 20px;">
    <div style="font-weight: 700; font-size: 16px; color: #0F1729;">${index + 1}. ${compName}</div>
    ${reason ? `<div style="font-size: 12px; color: #6B7280; margin-top: 4px;">${reason}</div>` : ''}
  </div>
  <div style="padding: 20px;">
    ${winsHtml}
    ${weakHtml}
    ${stealHtml}
  </div>
</div>`;
}

// Renders the full competitor deep-dive section. Accepts either:
//   - an array of deep-dive objects (current schema)
//   - a single deep-dive object (legacy schema, wrapped into [obj])
// Plus an optional outperformedCompetitors array (sibling field) that
// surfaces a green "you're beating these" summary box. Section is
// silently omitted only when BOTH arrays are empty.
function renderCompetitorDeepDive(deepDive, outperformedCompetitors) {
  const items = Array.isArray(deepDive)
    ? deepDive.filter((d) => d && typeof d === 'object')
    : (deepDive && typeof deepDive === 'object' ? [deepDive] : []);
  const outperformed = Array.isArray(outperformedCompetitors)
    ? outperformedCompetitors.filter((n) => typeof n === 'string' && n.trim().length > 0)
    : [];

  if (items.length === 0 && outperformed.length === 0) return '';

  let html = '<div class="section">';
  html += '<h2>&#128269; Competitor deep dive</h2>';
  html += '<p style="color: #6B7280; font-size: 13px; margin-bottom: 20px;">'
        + 'Only showing competitors where you are not already winning on both rating and review count.'
        + '</p>';

  items.forEach((deep, index) => {
    html += renderSingleCompetitorCard(deep, index);
  });

  if (outperformed.length > 0) {
    html += '<div style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 8px; padding: 16px 20px; margin-top: 8px;">'
          + '<div style="font-weight: 600; color: #065F46; font-size: 14px; margin-bottom: 6px;">&#9989; Competitors you are already beating</div>'
          + '<div style="font-size: 13px; color: #374151;">'
          + outperformed.map((n) => escapeHtml(n)).join(', ')
          + ' &mdash; you outperform on both rating and review count. Keep doing what you are doing.'
          + '</div>'
          + '</div>';
  }

  html += '</div>';
  return html;
}

// ─────────────────────────────────────────────────────────────────────
// renderKeyRisks — Claude key_risks renderer
// ─────────────────────────────────────────────────────────────────────
// Severity-colored risk cards with early-warning, mitigation, and
// cost-if-ignored boxes. HIGH=red, MEDIUM=amber, LOW=gray.
const RISK_SEVERITY_COLORS = {
  HIGH:   { border: '#DC2626', badgeBg: '#FEF2F2', badgeText: '#991B1B' },
  MEDIUM: { border: '#F59E0B', badgeBg: '#FFFBEB', badgeText: '#92400E' },
  LOW:    { border: '#6B7280', badgeBg: '#F9FAFB', badgeText: '#374151' },
};

function renderKeyRisks(risks) {
  if (!Array.isArray(risks) || risks.length === 0) return '';
  const cardsHtml = risks.map((r) => {
    if (!r || typeof r !== 'object') return '';
    const sev = String(r.severity || 'MEDIUM').toUpperCase();
    const c = RISK_SEVERITY_COLORS[sev] || RISK_SEVERITY_COLORS.MEDIUM;
    return `<div style="border: 1px solid #E5E7EB; border-left: 4px solid ${c.border}; border-radius: 8px; padding: 20px; margin-bottom: 16px; background: white;">
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
      <span style="background: ${c.badgeBg}; color: ${c.badgeText}; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px; text-transform: uppercase;">${sev} RISK</span>
      <span style="font-weight: 600; font-size: 15px; color: #0F1729;">${escapeHtml(r.risk_title || '')}</span>
    </div>
    ${r.description ? `<p style="font-size: 14px; color: #374151; margin-bottom: 12px; line-height: 1.6;">${escapeHtml(r.description)}</p>` : ''}
    ${r.early_warning_sign ? `<div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 6px; padding: 10px 14px; margin-bottom: 10px; font-size: 13px;"><strong style="color: #92400E;">&#9889; Early warning sign:</strong> <span style="color: #374151;">${escapeHtml(r.early_warning_sign)}</span></div>` : ''}
    ${r.mitigation ? `<div style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 6px; padding: 10px 14px; margin-bottom: 10px; font-size: 13px;"><strong style="color: #065F46;">&#9989; Mitigation:</strong> <span style="color: #374151;">${escapeHtml(r.mitigation)}</span></div>` : ''}
    ${r.cost_if_ignored ? `<div style="font-size: 13px; color: #6B7280;"><strong>Cost if ignored:</strong> ${escapeHtml(r.cost_if_ignored)}</div>` : ''}
  </div>`;
  }).join('');

  return `<div class="section">
  <h2>&#9888;&#65039; Key risks &mdash; and how to stay ahead</h2>
  <p style="color: #6B7280; font-size: 14px; margin-bottom: 20px;">Restaurants and businesses fail on execution not ideas. These are the specific risks facing this business right now &mdash; with early warning signs so you can act before they become crises.</p>
  ${cardsHtml}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// renderExecutionTemplates — Claude execution_templates renderer
// ─────────────────────────────────────────────────────────────────────
// Each template is a copy-paste-ready card with a clipboard button.
// The body is JSON-stringified into a data attribute and read back via
// JSON.parse on click — robust against quotes/newlines/template-literal
// chars in the body text.
const TEMPLATE_TYPE_ICONS = {
  email:        '&#128231;',  // 📧
  script:       '&#128483;',  // 🗣
  text_message: '&#128172;',  // 💬
  proposal:     '&#128196;',  // 📄
};

// Encode for safe embedding in an HTML attribute. escapeHtml handles
// & < > " ' but NOT newlines — browsers preserve attribute newlines
// inconsistently. Encoding LF/CR as numeric character references
// makes the round-trip predictable: when JS reads element.dataset.body
// the entities decode back to actual \n characters.
function escapeHtmlAttr(s) {
  return escapeHtml(s).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

function renderExecutionTemplates(templates) {
  if (!Array.isArray(templates) || templates.length === 0) return '';
  const cardsHtml = templates.map((t, idx) => {
    if (!t || typeof t !== 'object') return '';
    const type = String(t.template_type || 'email').toLowerCase();
    const icon = TEMPLATE_TYPE_ICONS[type] || TEMPLATE_TYPE_ICONS.email;
    const body = String(t.body || '');
    const tmplId = `tmpl-${idx}`;

    const subjectBlock = (type === 'email' && t.subject)
      ? `<div style="background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 6px; padding: 8px 14px; margin-bottom: 12px; font-size: 13px;"><strong style="color: #1D4ED8;">Subject:</strong> <span style="color: #1E40AF;">${escapeHtml(t.subject)}</span></div>`
      : '';

    // Body div carries id + data-body. The display content is HTML-
    // escaped (visible plaintext, white-space:pre-wrap preserves the
    // visible newlines). The copy button reads dataset.body — which
    // the browser decodes back to original characters including \n.
    return `<div style="border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 20px; overflow: hidden;">
    <div style="background: #F8FAFC; border-bottom: 1px solid #E5E7EB; padding: 12px 20px; display: flex; align-items: center; gap: 10px;">
      <span style="font-size: 20px;">${icon}</span>
      <div>
        <div style="font-weight: 600; color: #0F1729; font-size: 14px;">${escapeHtml(t.template_title || '')}</div>
        ${t.when_to_use ? `<div style="font-size: 12px; color: #6B7280; margin-top: 2px;">${escapeHtml(t.when_to_use)}</div>` : ''}
      </div>
    </div>
    <div style="padding: 20px;">
      ${subjectBlock}
      <div id="${tmplId}" data-body="${escapeHtmlAttr(body)}" style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 6px; padding: 16px; font-size: 14px; line-height: 1.8; color: #374151; white-space: pre-wrap; font-family: inherit;">${escapeHtml(body)}</div>
      <button onclick="const b=document.getElementById('${tmplId}').dataset.body;navigator.clipboard.writeText(b).then(()=>{this.textContent='✓ Copied';setTimeout(()=>{this.textContent='Copy template';},2000);});" style="margin-top: 12px; background: #0F1729; color: white; border: none; padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; font-weight: 500;">Copy template</button>
      ${t.success_metric ? `<div style="margin-top: 12px; padding: 10px 14px; background: #F0FDF4; border-radius: 6px; font-size: 13px; color: #065F46;"><strong>&#128202; Track success:</strong> ${escapeHtml(t.success_metric)}</div>` : ''}
    </div>
  </div>`;
  }).join('');

  return `<div class="section">
  <h2>&#128203; Ready-to-use templates</h2>
  <p style="color: #6B7280; font-size: 13px; margin-bottom: 20px;">Copy, fill the [brackets], send. No rewriting needed.</p>
  ${cardsHtml}
</div>`;
}

function renderRec3Layer(t, idx, data, studies, extraTags = [], enrichedRec = null) {
  const rec = t.rec;
  const impactClass = `impact impact-${t.impact.toLowerCase()}`;

  // Phase 5 — Claude-enriched path
  if (enrichedRec) {
    const aiBadge = ` <span class="ai-badge" title="Enriched by Claude">AI</span>`;
    const what = enrichedRec.what || rec.claim || '';
    const why = enrichedRec.why_it_works || '';
    const cite = enrichedRec.study_citation || '';
    const mag = enrichedRec.magnitude || rec.magnitude || '';
    const whyYou = enrichedRec.why_your_business || '';
    let moneyHtml = '';
    if (enrichedRec.money_estimate && enrichedRec.money_estimate.show !== false && enrichedRec.money_estimate.range) {
      const m = enrichedRec.money_estimate;
      moneyHtml = `<div class="money">
<strong>Money estimate: ${escapeHtml(m.range)}</strong><br>
${m.math ? `<span class="meta">Math: ${escapeHtml(m.math)}</span><br>` : ''}
${m.caveat ? `<em class="meta">${escapeHtml(m.caveat)}</em>` : ''}
</div>`;
    }
    const extraTagHtml = extraTags.length
      ? extraTags.map((eT) => `<span class="extra-tag extra-tag-${eT.cls}">${escapeHtml(eT.label)}</span>`).join(' ')
      : '';
    // Replace honesty-marker shorthand in why_your_business with styled spans.
    const styledWhyYou = (whyYou || '')
      .replace(/\[VERIFIED\]/g, '<span class="hmark hmark-verified">[VERIFIED]</span>')
      .replace(/\[REASONABLE INFERENCE\]/g, '<span class="hmark hmark-inference">[REASONABLE INFERENCE]</span>')
      .replace(/\[CUSTOMER MUST VALIDATE\]/g, '<span class="hmark hmark-validate">[CUSTOMER MUST VALIDATE]</span>');

    return `<div class="rec rec-${t.impact.toLowerCase()}">
<h3>${idx + 1}. <span class="${impactClass}">${escapeHtml(t.impact)} IMPACT</span>${aiBadge} ${extraTagHtml} · ${escapeHtml(rec.id)} <small>(score ${t.score.toFixed(2)})</small></h3>
<div class="layer layer-what"><span class="layer-label">WHAT:</span> ${escapeHtml(what)}</div>
<div class="layer layer-why"><span class="layer-label">WHY IT WORKS:</span>
<div class="why-study">
<p>${escapeHtml(why)}</p>
<p class="meta"><strong>Magnitude:</strong> ${escapeHtml(mag)}<br>
<strong>Source:</strong> ${escapeHtml(cite)}</p>
</div>
</div>
<div class="layer layer-business"><span class="layer-label">WHY YOUR BUSINESS:</span>
<p>${styledWhyYou}</p>
</div>
${moneyHtml}
<p class="meta">Score breakdown: magnitude ${t.magnitudeFactor.toFixed(2)} × evidence ${t.evidenceFactor.toFixed(2)} × ease ${t.easeFactor.toFixed(2)}</p>
</div>`;
  }

  // Phase 4 deterministic path (recs 4-10, or when enrichment unavailable)

  // Layer 2: WHY IT WORKS — pull each cited study's finding_summary.
  const studyBlocks = rec.study_ids.map((sid) => {
    const s = studies.find((x) => x.id === sid);
    if (!s) return `<div class="why-study"><strong>${escapeHtml(sid)}</strong> — not found in studies registry</div>`;
    const tierTag = s.tier === 3 ? ' <span class="tier3">[TIER-3 VENDOR]</span>' : '';
    const link = `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.id)}</a>`;
    return `<div class="why-study">
<p>${escapeHtml(s.finding_summary || s.claim || '')}</p>
<p class="meta"><strong>Magnitude:</strong> ${escapeHtml(rec.magnitude || '—')}<br>
<strong>Source:</strong> ${link} (Tier ${s.tier})${tierTag} — ${escapeHtml(s.citation)}</p>
</div>`;
  }).join('');

  // Layer 3: WHY YOUR BUSINESS — auto-derive from trigger + data fields.
  const ev = evidenceForRec(rec, data);
  const layer3Bits = [];

  // VERIFIED: each (field, op, threshold) where data has a real value.
  for (const c of ev.compares) {
    const actual = data[c.field];
    if (actual === null || actual === undefined) continue;
    const actualS = fmtFieldValue(c.field, actual);
    const threshS = c.threshold !== null ? fmtThreshold(c.field, c.threshold) : null;
    const phrase = threshS != null
      ? `Your <code>${escapeHtml(c.field)}</code> is ${escapeHtml(actualS)} (trigger fired ${escapeHtml(opPhrase(c.op))} ${escapeHtml(threshS)}).`
      : `Your <code>${escapeHtml(c.field)}</code> is ${escapeHtml(actualS)}.`;
    layer3Bits.push({ tag: 'VERIFIED', text: phrase });
  }
  // CUSTOMER MUST VALIDATE for is_unknown() and missing fields.
  for (const f of ev.unknowns) {
    if (data[f] === null || data[f] === undefined) {
      layer3Bits.push({
        tag: 'CUSTOMER MUST VALIDATE',
        text: `Public data couldn't measure <code>${escapeHtml(f)}</code>. Verify from your own records or measure directly.`,
      });
    }
  }
  // Always-trigger (KPI-style) recs have no field comparisons.
  if (!layer3Bits.length && t.isAlwaysTrigger) {
    layer3Bits.push({
      tag: 'REASONABLE INFERENCE',
      text: 'Long-term KPI for this sector. Track this metric quarterly to confirm whether your business is on the recommended trajectory.',
    });
  }
  // Generic inference line (one per rec) — sector pattern.
  layer3Bits.push({
    tag: 'REASONABLE INFERENCE',
    text: `This pattern is typical for businesses like yours; the exact lift you'll see depends on execution quality and current baseline.`,
  });
  // Tier-3 disclosure line if any cited study is vendor-tier.
  if (rec.tier3_disclosure_required) {
    layer3Bits.push({
      tag: 'CUSTOMER MUST VALIDATE',
      text: 'One or more cited studies are vendor research (Tier 3) — validate the magnitude against independent sources before committing budget.',
    });
  }

  const layer3Html = layer3Bits.map((b) => {
    const cls = b.tag.toLowerCase().replace(/\s+/g, '-');
    return `<div class="honesty honesty-${cls}"><span class="hmark">[${escapeHtml(b.tag)}]</span> ${b.text}</div>`;
  }).join('');

  const extraTagHtml = extraTags.length
    ? extraTags.map((t) => `<span class="extra-tag extra-tag-${t.cls}">${escapeHtml(t.label)}</span>`).join(' ')
    : '';

  // Money estimate — wired in CHANGE 6. Reserved slot here.
  const moneyHtml = (typeof t.moneyEstimateHtml === 'string' && t.moneyEstimateHtml) ? t.moneyEstimateHtml : '';

  return `<div class="rec rec-${t.impact.toLowerCase()}">
<h3>${idx + 1}. <span class="${impactClass}">${escapeHtml(t.impact)} IMPACT</span> ${extraTagHtml} · ${escapeHtml(rec.id)} <small>(score ${t.score.toFixed(2)})</small></h3>
<div class="layer layer-what"><span class="layer-label">WHAT:</span> ${escapeHtml(rec.claim)}</div>
<div class="layer layer-why"><span class="layer-label">WHY IT WORKS:</span>
${studyBlocks}
</div>
<div class="layer layer-business"><span class="layer-label">WHY YOUR BUSINESS:</span>
${layer3Html}
</div>
${moneyHtml}
<p class="meta">Score breakdown: magnitude ${t.magnitudeFactor.toFixed(2)} × evidence ${t.evidenceFactor.toFixed(2)} × ease ${t.easeFactor.toFixed(2)}</p>
</div>`;
}

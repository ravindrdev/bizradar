// override:true so .env wins over an empty/stale ANTHROPIC_API_KEY inherited
// from the parent shell. Without this, dotenv silently skips the key when the
// parent process exports it as an empty string.
require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const authRoutes = require('./authRoutes');
const { requireAuth, requireAdmin } = require('./authMiddleware');
const pool = require('./db');
const payments = require('./payments');

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
// directly - the prior import here was dead code.
const claudeMarketAnalyst = require('./claudeMarketAnalyst');
const { verifyQuotes } = require('./provenance');
const studies = require('./verifiedStudies.json');
const sectorProblems = require('./sectorCommonProblems.json');

// ── Crash guards ──────────────────────────────────────────────────────
// One stray async rejection or thrown error should NOT take down the
// whole server and drop every in-flight report. Log it (timestamp + full
// stack) and KEEP THE PROCESS RUNNING - we deliberately do not exit here.
// The boot-time JWT_SECRET guard below still fails fast on purpose; that
// is a separate, intentional exit.
process.on('unhandledRejection', (reason) => {
  const stack = reason instanceof Error ? (reason.stack || reason.message) : reason;
  console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION - process kept alive:\n`, stack);
});
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] UNCAUGHT EXCEPTION - process kept alive:\n`, err.stack || err);
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
// DATABASE_URL is required for Postgres-backed features (users, reports,
// payments). The rest of the app still boots without it - the warning
// surfaces the missing config without crashing the process.
if (!process.env.DATABASE_URL) {
  console.warn(
    '[startup] DATABASE_URL is not set - database features (users, reports, payments) will be unavailable'
  );
}

// Audit fix X1 - fail-fast on missing JWT_SECRET. Without this guard,
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
// Trust exactly ONE proxy hop (Railway's edge). express-rate-limit then
// keys on the real client IP from X-Forwarded-For. Using 1 (not true)
// means a client cannot spoof its IP with extra X-Forwarded-For entries
// to dodge the limiter. Also clears the express-rate-limit
// "X-Forwarded-For is set but trust proxy is false" validation warning.
app.set('trust proxy', 1);

// ── Canonical host: 301 www.growthim.com → growthim.com (apex) ──────────
// Placed right after 'trust proxy' and before any body parsing / routes /
// static so a www request is redirected before doing any other work.
// Only fires when the Host starts with "www." — apex traffic and the
// Railway-internal *.up.railway.app host (no "www." prefix) fall straight
// through untouched. Forces https and preserves the full path + query.
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (host.toLowerCase().startsWith('www.')) {
    return res.redirect(301, 'https://' + host.slice(4) + req.originalUrl);
  }
  next();
});

// ── Dodo Payments webhook (one-time $29.99 report gate) ─────────────────
// Mounted at EXACTLY /api/webhooks/dodo (the URL registered in Dodo).
// NOTE: the @dodopayments/express adapter verifies via JSON.stringify(req.body)
// — it needs the PARSED JSON object, NOT the raw buffer — so this route parses
// with its own express.json({type:'*/*'}). (An earlier assumption that it
// needed the raw body left req.body undefined and made verify() throw a 500.)
//
// Decided at boot from PAYMENTS_ENABLED (an env change => redeploy, as usual):
//   ON  -> the adapter verifies the signature + dispatches to our handlers.
//   OFF -> a tiny stub 200s so Dodo test pings never 404, and NO report can
//          ever run for free. The Dodo SDK is require()d ONLY on the ON path,
//          so an OFF deploy needs neither keys nor a loaded SDK at startup.
if (payments.isEnabled()) {
  const { Webhooks } = require('@dodopayments/express');
  app.post('/api/webhooks/dodo',
    // The adapter does JSON.stringify(req.body) to verify, so req.body MUST be
    // the PARSED JSON object. Parse it here (type:'*/*' = parse regardless of
    // Content-Type). Without this req.body is undefined and verify() throws 500.
    express.json({ type: '*/*' }),
    // Diagnostic: logs that a POST arrived and the final status the adapter
    // returned, so 200 vs 401 (bad secret) vs 500 is unambiguous in the log.
    (req, res, next) => {
      const wid = req.get('webhook-id') || 'none';
      console.log('[payments] webhook POST received (webhook-id=' + wid + ', has-signature=' + !!req.get('webhook-signature') + ') — verifying…');
      res.on('finish', () => {
        console.log('[payments] webhook responded ' + res.statusCode + ' for webhook-id=' + wid
          + (res.statusCode === 401 ? '  <-- SIGNATURE REJECTED: DODO_PAYMENTS_WEBHOOK_KEY does not match the sending endpoint' : ''));
      });
      next();
    },
    Webhooks({
      webhookKey: payments.env().webhookKey,
      onPaymentSucceeded: async (payload) => { await handleDodoPaymentSucceeded(payload); },
      onPaymentFailed:    async (payload) => { await handleDodoPaymentFailed(payload); },
      onRefundSucceeded:  async (payload) => { await handleDodoRefundSucceeded(payload); },
    }));
  console.log('[payments] Dodo webhook mounted at /api/webhooks/dodo (PAYMENTS_ENABLED=true, mode=' + payments.env().environment + ')');
} else {
  app.post('/api/webhooks/dodo', express.raw({ type: '*/*' }), (req, res) => {
    res.json({ received: true, ignored: 'payments_disabled' });
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Audit fix S4 / X2 - rate limiting ────────────────────────────────
// authLimiter:    /auth/* - 20 attempts per IP per 15 min. Throttles
//                 login brute-force, OTP brute-force, signup spam,
//                 forgot-password email bombs, and /auth/cancel-signup
//                 abuse (AR1).
// reportLimiter:  /classify + /market-analysis - 10 reports per IP per
//                 hour. Bounds Claude + Google Places cost burn even
//                 from a leaked cookie.
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many auth attempts. Try again in 15 minutes.' },
});
// sessionLimiter: for /auth/me (+ /auth/logout) ONLY - the read-only session
// check the dashboard and /app hit on every page load and on Retry. Kept
// SEPARATE from authLimiter so routine dashboard refreshing can't drain the
// login brute-force bucket and lock the whole IP out of login. Generous
// in-memory abuse ceiling only (same default MemoryStore, cleared on restart).
const sessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down and try again shortly.' },
});
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many report generations. Try again in an hour.' },
});

// ── In-process pipeline concurrency gate ───────────────────────────────
// /classify and /market-analysis each kick off a heavy detached pipeline
// (Claude + Google Places + Puppeteer) in setImmediate. Without a cap,
// N simultaneous requests = N concurrent pipelines, which blows up memory
// and trips upstream rate limits. reportGate runs at most
// MAX_CONCURRENT_REPORTS pipelines at once and queues the rest; when any
// active pipeline SETTLES (resolve OR reject) the next queued one starts.
// SHARED across both endpoints. NOTE: in-process only - if this app is ever
// run as multiple instances, the cap is per-instance.
// (Deliberately NOT the p-limit package: p-limit v4+ is ESM-only and would
//  break `require` in this CommonJS project.)
const MAX_CONCURRENT_REPORTS = parseInt(process.env.MAX_CONCURRENT_REPORTS, 10) || 5;
// Rough average pipeline runtime, used ONLY to estimate the wait time shown
// to queued users. Approximate by design - a fixed figure, not measured.
const AVG_REPORT_MINUTES = 12;
let reportActive = 0;
const reportQueue = [];
// Cap the waiting line: at most MAX_QUEUE jobs wait behind the
// MAX_CONCURRENT_REPORTS running ones. Past that (5 running + 5 waiting = 10),
// the gate is full and new requests are turned away with BUSY_MESSAGE (503)
// BEFORE any job is created or response closed.
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE, 10) || 5;
const BUSY_MESSAGE = 'We are getting far more customers than we expected right now, and all of our servers are completely full. Please try again in a few minutes.';
// PDF generation launches headless Chromium per request (memory-heavy) and is
// NOT behind reportGate. Cap concurrent PDF renders so a burst of downloads
// can't exhaust memory; the synchronous route turns over-cap requests away with
// a 503 busy page (no waiting, no Chromium spawned).
const MAX_PDF_CONCURRENT = parseInt(process.env.MAX_PDF_CONCURRENT, 10) || 3;
let pdfActive = 0;
// Per-report watchdog backstop. Each external call already has its own timeout;
// this is an OVERALL ceiling (well above the legitimate worst case ~85 min) so a
// step that hangs past its per-call timeout can't hold a reportGate slot forever
// and wedge the queue. On fire it forces failJob + releases the slot.
const REPORT_WATCHDOG_MS = parseInt(process.env.REPORT_WATCHDOG_MS, 10) || 90 * 60 * 1000; // 90 min backstop

function reportGate(jobId, task) {
  const run = () => {
    reportActive++;
    console.log(`[concurrency] pipeline started (${reportActive} running)`);
    // Overall watchdog: race the task against a backstop timer so a step that
    // hangs past its per-call timeout can't hold this slot forever.
    let watchdog;
    const watchdogPromise = new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('WATCHDOG_TIMEOUT')), REPORT_WATCHDOG_MS);
    });
    Promise.race([Promise.resolve().then(task), watchdogPromise])
      .catch((e) => {
        if (e && e.message === 'WATCHDOG_TIMEOUT') {
          // The pipeline never settled in time. Force the job to a terminal
          // error so the polling page stops spinning, then release the slot.
          console.error(`[concurrency] WATCHDOG fired for job ${jobId}, releasing slot`);
          failJob(jobId, 'This report took too long and was stopped. Please try again.');
        } else {
          // Pipelines handle their own errors via failJob; this is only a
          // last-resort guard so a thrown task can't wedge the queue.
          console.error('[concurrency] pipeline task threw:', e && e.message);
        }
      })
      .finally(() => {
        // Clear the watchdog (no dangling timer on normal completion), release
        // the slot no matter how the task settled, then promote the next waiter.
        clearTimeout(watchdog);
        reportActive--;
        console.log(`[concurrency] pipeline finished (${reportActive} running, ${reportQueue.length} waiting)`);
        const next = reportQueue.shift();
        if (next) next.run();
      });
  };
  if (reportActive < MAX_CONCURRENT_REPORTS) {
    run();
  } else {
    reportQueue.push({ jobId, run });
    console.log(`[concurrency] queued (${reportActive} running, ${reportQueue.length} waiting)`);
  }
}

// Returns the 1-based position of a waiting job in the queue, or 0 if the job
// is not waiting (already running, finished, or unknown). Used by
// /report-status to show queued users their place in line.
function getQueuePosition(jobId) {
  if (!jobId) return 0;
  const idx = reportQueue.findIndex((entry) => entry.jobId === jobId);
  return idx === -1 ? 0 : idx + 1;
}

// User auth router - handles signup, login, OTP verification, forgot
// password, and /auth/me. JWT cookie 'token' is set on successful
// signup or login. Routes that need authentication wrap their handler
// with requireAuth (imported above from authMiddleware.js).
// The strict brute-force limiter (authLimiter) is attached ONLY to the
// credential / OTP / email endpoints below - NOT to the whole /auth mount -
// so the high-frequency read-only session check /auth/me (hit on every
// dashboard + /app load and on Retry) can't drain the login bucket and lock
// the IP out of login. /auth/me + /auth/logout get the generous sessionLimiter.
app.use(
  ['/auth/signup', '/auth/verify-signup', '/auth/cancel-signup',
   '/auth/login', '/auth/verify-login-otp', '/auth/forgot-password',
   '/auth/verify-reset-otp', '/auth/reset-password'],
  authLimiter
);
app.use(['/auth/me', '/auth/logout'], sessionLimiter);
app.use('/auth', authRoutes);

// ─────────────────────────────────────────────────────────────────────
// GET /api/dashboard - JSON feed for the user's dashboard page.
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

    // In-progress and failed jobs for this user. 'ready' jobs are excluded
    // on purpose: a finished job is already represented by its row in
    // `reports` above, so including it here would double-list it. Scoped by
    // user_id exactly like the reports query.
    const jobsResult = await pool.query(
      `SELECT job_id, status, label, error, report_type, created_at, updated_at
       FROM jobs
       WHERE user_id = $1 AND status IN ('processing', 'error')
       ORDER BY created_at DESC`,
      [id]
    );

    // Merge finished reports + active/failed jobs into one list, each tagged
    // by kind, newest first - lets the dashboard interleave generating and
    // failed cards with finished ones in true chronological order.
    const reportItems = reportsResult.rows.map((r) => ({
      kind: 'report',
      id: r.id,
      business_name: r.business_name,
      address: r.address,
      naics_code: r.naics_code,
      created_at: r.created_at,
    }));
    const jobItems = jobsResult.rows.map((j) => {
      const item = {
        kind: 'job',
        job_id: j.job_id,
        status: j.status,
        label: j.label,
        error: j.error,
        report_type: j.report_type || 'rate',
        created_at: j.created_at,
      };
      // For a 'processing' job, mirror /report-status: queued behind the
      // concurrency cap (position + rough wait) vs actually generating (rough
      // minutes remaining) — lets the dashboard card show real status.
      if (j.status === 'processing') {
        const position = getQueuePosition(j.job_id);
        if (position > 0) {
          item.queued = true;
          item.queuePosition = position;
          item.estimatedWaitMinutes = Math.ceil(position / MAX_CONCURRENT_REPORTS) * AVG_REPORT_MINUTES;
        } else {
          item.queued = false;
          const startedMs = j.updated_at ? new Date(j.updated_at).getTime() : Date.now();
          const elapsedMin = Math.max(0, Math.floor((Date.now() - startedMs) / 60000));
          item.minutesRemaining = Math.max(1, AVG_REPORT_MINUTES - elapsedMin);
        }
      }
      return item;
    });
    const items = reportItems
      .concat(jobItems)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      user: { id, name, email, created_at },
      reports: reportsResult.rows,
      total_reports: reportsResult.rows.length,
      items,
    });
  } catch (err) {
    console.error('[dashboard] query failed:', err.message);
    res.status(500).json({ error: 'Could not load dashboard data' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/overview - read-only owner dashboard data.
//
// Behind requireAdmin ONLY (deliberately NOT requireAuth as well):
// requireAdmin is fully self-contained — it does its own cookie→JWT→user
// lookup and then the owner check, returning a uniform 404 for ANY denial.
// Putting requireAuth in front would 401 a no-cookie request before
// requireAdmin could 404 it, breaking the "admin area is never even
// advertised" guarantee.
//
// Everything in this handler is SELECT-only. No writes, ever.
// ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    // --- report counts -------------------------------------------------
    const totalReportsQ = await pool.query(
      `SELECT count(*)::int AS n FROM reports`
    );
    const processingQ = await pool.query(
      `SELECT count(*)::int AS n FROM jobs WHERE status = 'processing'`
    );

    // success / degraded / failed come from the durable report_outcomes
    // table when it exists (a permanent record that survives the hourly
    // jobs cleanup). If it somehow doesn't exist yet, fall back to counting
    // failed jobs from the jobs table — but note that jobs are pruned
    // hourly, so that fallback is effectively LAST-24H ONLY, and
    // success/degraded cannot be recovered from it.
    let outcomesSource = 'report_outcomes';
    let successN = null, degradedN = null, failedN = null;
    const haveOutcomes = await pool.query(
      `SELECT to_regclass('report_outcomes') IS NOT NULL AS exists`
    );
    if (haveOutcomes.rows[0] && haveOutcomes.rows[0].exists) {
      const oc = await pool.query(
        `SELECT outcome, count(*)::int AS n
         FROM report_outcomes
         GROUP BY outcome`
      );
      successN = 0; degradedN = 0; failedN = 0;
      for (const row of oc.rows) {
        if (row.outcome === 'success') successN = row.n;
        else if (row.outcome === 'degraded') degradedN = row.n;
        else if (row.outcome === 'failed') failedN = row.n;
      }
    } else {
      // Fallback: last-24h only (jobs are pruned hourly); success/degraded
      // are not recoverable from the jobs table, so they stay null.
      outcomesSource = 'jobs_fallback_last_24h';
      const f = await pool.query(
        `SELECT count(*)::int AS n FROM jobs WHERE status = 'error'`
      );
      failedN = f.rows[0].n;
    }

    // --- signups -------------------------------------------------------
    const signupsQ = await pool.query(
      `SELECT count(*)::int AS n FROM users`
    );

    // --- approximate active users --------------------------------------
    // Distinct users with ANY report or job activity in the last 15 min.
    // This is an APPROXIMATION (the field name says so): it counts report
    // creation and job updates, not page views, so a user merely reading
    // existing reports won't show up. The user_id NOT NULL guard keeps any
    // orphaned rows out of the count.
    const activeQ = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT user_id FROM reports
           WHERE user_id IS NOT NULL AND created_at > NOW() - INTERVAL '15 minutes'
         UNION
         SELECT user_id FROM jobs
           WHERE user_id IS NOT NULL AND status <> 'awaiting_payment'
             AND updated_at > NOW() - INTERVAL '15 minutes'
       ) AS active_users`
    );

    // --- report list (optional search + paging) ------------------------
    // search matches business name OR owner email, case-insensitively.
    // limit defaults to 50, clamped to [1, 200]; offset defaults to 0, >= 0.
    const rawSearch = (req.query.search || '').toString().trim();
    const search = rawSearch.length ? rawSearch : null;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.max(1, Math.min(200, limit));
    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const listQ = await pool.query(
      `SELECT r.id, r.business_name, r.created_at,
              u.name  AS owner_name,
              u.email AS owner_email
       FROM reports r
       JOIN users u ON u.id = r.user_id
       WHERE ($1::text IS NULL
              OR r.business_name ILIKE '%' || $1 || '%'
              OR u.email ILIKE '%' || $1 || '%')
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [search, limit, offset]
    );

    res.json({
      reports: {
        total: totalReportsQ.rows[0].n,
        processing: processingQ.rows[0].n,
        success: successN,
        degraded: degradedN,
        failed: failedN,
        outcomes_source: outcomesSource,
      },
      total_signups: signupsQ.rows[0].n,
      active_users_approx: activeQ.rows[0].n,
      active_users_window_minutes: 15,
      report_list: {
        items: listQ.rows,
        limit,
        offset,
        search,
        count: listQ.rows.length,
      },
    });
  } catch (err) {
    // Reached only by an authenticated admin (requireAdmin already passed)
    // on a genuine query failure — safe to return a generic 500 here.
    console.error('[admin/overview] query failed:', err.message);
    res.status(500).json({ error: 'Could not load admin overview' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /admin - the owner-only admin dashboard PAGE.
//
// Behind requireAdmin ONLY, exactly like /api/admin/overview: a non-admin
// (or logged-out) visitor gets the same uniform 404, so the page is never
// even advertised. The HTML lives in /private - OUTSIDE the public/ folder
// that express.static serves (further below) - so it is NOT reachable as a
// static file; the ONLY way to load it is through this gated route. It
// carries no secrets and just calls the gated /api/admin/overview on load.
// ─────────────────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin.html'), (err) => {
    if (err && !res.headersSent) {
      console.error('[admin page] sendFile failed:', err.message);
      res.status(500).send('Internal error');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// GET /report/:id - replay a previously generated report as HTML.
//
// Auth-protected. The WHERE clause ALSO scopes by user_id, so a logged-
// in user attempting to read someone else's report by guessing the ID
// gets the same "not found" response as a truly nonexistent ID - no
// information leak about which IDs exist.
//
// The saved report_json carries a _type discriminator written by the
// /classify and /market-analysis save paths above:
//   _type === 'classify'         → renderReport(ctx) - same shape and
//                                  same studies attachment used in the
//                                  live /classify flow.
//   _type === 'market_analysis'  → renderMarketReport(result) - same
//                                  call site used in the live
//                                  /market-analysis flow.
// Anything else is treated as a legacy 'classify' record (defensive
// default for any rows written before the discriminator was added).
//
// The response wraps the rendered report HTML with a sticky GrowthIM
// navbar (REPORT_VIEW_NAVBAR below). That navbar gives the user a
// deterministic "My Dashboard" link on every report page so they
// never need to use the browser Back button - Back across a
// bfcache-disabled page can briefly show a stale state on the
// dashboard and feel like a logout, even though the JWT cookie is
// fully intact. Clicking "My Dashboard" does a fresh top-level
// navigation that re-runs the dashboard's /auth/me check with the
// still-valid cookie. The Logout button is the ONLY mechanism in
// the report-view flow that touches the cookie - verified by grep
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

// ─────────────────────────────────────────────────────────────────────
// serveSavedReport - shared HTML renderer/sender for a saved report row.
//
// Used by BOTH the owner-scoped GET /report/:id route and the owner-only
// GET /admin/report/:id route. Those two routes differ ONLY in the WHERE
// clause that fetched `row` (owner-scoped vs id-only); everything about
// turning that row into the HTML response lives here, so the two render
// byte-for-byte identically and can never drift. `idNum` is the validated
// integer id (used for reportId and log lines).
// ─────────────────────────────────────────────────────────────────────
async function serveSavedReport(res, row, idNum) {
  let payload;
  try {
    payload = typeof row.report_json === 'string'
      ? JSON.parse(row.report_json)
      : row.report_json;
  } catch (e) {
    console.error('[report] JSON parse failed for report id=' + idNum + ':', e.message);
    return res.status(500).send('Saved report is corrupted');
  }

  let html;
  if (payload && payload._type === 'market_analysis') {
    // The market-analysis renderer reads the same fields it would
    // have read live (top10, deep_dive, raw, _quote_verification,
    // etc.) - they all serialize through JSON.stringify cleanly.
    html = renderMarketReport(payload);
  } else {
    // Default to the classify renderer. `studies` is loaded fresh
    // from verifiedStudies.json at startup so we don't persist it;
    // re-attach the current array here. If a study was retired
    // between save and replay, citationLine() in renderReport
    // already handles "(not found)" gracefully.
    // Review-gap velocity, look back from THIS report's created_at
    // (not "now") so replays of older reports show the velocity that
    // was true at the time, not a snapshot warped by newer reports.
    const velocityBusinessName = row.business_name
      || (payload && payload.data && (payload.data.name || payload.data.business_name))
      || '';
    const velocity = await fetchReviewVelocity(row.user_id, velocityBusinessName, row.created_at);
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
      velocity,
      reportId: idNum,
    });
  }
  // FIX 3 - Em-dash post-processing for the replay route. The saved
  // JSON is already dash-cleaned (we run deepCleanDashes in the
  // /classify pipeline before INSERT), but legacy reports persisted
  // before that fix still contain em dashes in their enriched fields.
  // Running cleanDashes on the rendered HTML catches those too.
  html = cleanDashes(html);
  // Inject the GrowthIM sticky navbar right after <body> so the
  // user always has logo + My Dashboard + Logout above the
  // restored report. Single string replace; PAGE_OPEN uses a
  // bare `<body>` open tag with no attributes, so the match is
  // unambiguous. Falls back gracefully (no-op) if the body tag
  // is somehow missing.
  html = html.replace('<body>', '<body>' + REPORT_VIEW_NAVBAR);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

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
    return await serveSavedReport(res, r.rows[0], idNum);
  } catch (err) {
    console.error('[report/:id] failed:', err.message);
    res.status(500).send('Could not load report');
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /admin/report/:id - owner-only: open ANY report by id, regardless
// of who created it. Behind requireAdmin ONLY, which already returns the
// uniform 404 to non-admins (so the route is never advertised). Renders
// via the SAME serveSavedReport helper as /report/:id; the ONLY difference
// is this query has NO user_id restriction. Invalid/nonexistent id → a
// clean 404 (not 500), same as /report/:id.
// ─────────────────────────────────────────────────────────────────────
app.get('/admin/report/:id', requireAdmin, async (req, res) => {
  try {
    const idNum = parseInt(req.params.id, 10);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return res.status(404).send('Report not found');
    }
    const r = await pool.query(
      `SELECT id, user_id, business_name, address, naics_code, report_json, created_at
       FROM reports
       WHERE id = $1`,
      [idNum]
    );
    if (!r.rowCount) {
      return res.status(404).send('Report not found');
    }
    return await serveSavedReport(res, r.rows[0], idNum);
  } catch (err) {
    console.error('[admin/report/:id] failed:', err.message);
    res.status(500).send('Could not load report');
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /report/:id/pdf - generate a printable PDF of a saved report
// ─────────────────────────────────────────────────────────────────────
// Uses @sparticuz/chromium + puppeteer-core to launch headless Chromium,
// load the same HTML the /report/:id replay route renders, and print it
// to PDF with A4 paper + 15-20mm margins.
//
// Auth: stays on requireAuth. A user can PDF reports they own (the
// owner-scoped WHERE user_id = req.user.id query, same as /report/:id).
// Additionally, the admin (req.user.email === ADMIN_EMAIL, same check +
// fail-safe as requireAdmin) can PDF ANY report via an id-only fetch.
// 404 is returned for nonexistent ids, and for not-yours when the
// requester is not the admin, so the IDs don't leak.
//
// PDF generation is intentionally NOT passed reportId, so the
// "Download PDF" button does not appear in the printed PDF itself.
//
// Error path: any failure returns a JSON 500 with a user-friendly
// message. Browser stays open until the finally block closes it.
app.get('/report/:id/pdf', requireAuth, async (req, res) => {
  // PDF concurrency cap. Checked BEFORE any await and before pdfActive++ (no
  // await between), so two simultaneous requests can't both pass. A rejected
  // request returns here -> never enters the try -> never increments/decrements.
  if (pdfActive >= MAX_PDF_CONCURRENT) {
    return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;text-align:center;color:#1e293b"><h2>We are very busy right now</h2><p>A lot of reports are being downloaded at the moment. Please go back and tap Download PDF again in a few seconds.</p></body>');
  }
  let browser = null;
  try {
    pdfActive++;
    const idNum = parseInt(req.params.id, 10);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    // Admin override: same check + fail-safe as requireAdmin. If ADMIN_EMAIL
    // is unset/empty, adminEmail is '' -> isAdmin is false -> NO override, so
    // a logged-in non-owner non-admin still hits the owner-scoped query below
    // and gets the same 404 it gets today. Only an email === ADMIN_EMAIL match
    // unlocks the id-only fetch.
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const isAdmin = !!adminEmail
      && !!req.user.email
      && req.user.email.trim().toLowerCase() === adminEmail;

    const r = isAdmin
      ? await pool.query(
          `SELECT id, user_id, business_name, address, naics_code, report_json, created_at
           FROM reports
           WHERE id = $1`,
          [idNum]
        )
      : await pool.query(
          `SELECT id, user_id, business_name, address, naics_code, report_json, created_at
           FROM reports
           WHERE id = $1 AND user_id = $2`,
          [idNum, req.user.id]
        );
    if (!r.rowCount) {
      return res.status(404).json({ error: 'Report not found' });
    }
    const row = r.rows[0];

    let payload;
    try {
      payload = typeof row.report_json === 'string'
        ? JSON.parse(row.report_json)
        : row.report_json;
    } catch (e) {
      console.error('[report/:id/pdf] JSON parse failed for report id=' + idNum + ':', e.message);
      return res.status(500).json({ error: 'Saved report is corrupted' });
    }

    let html;
    if (payload && payload._type === 'market_analysis') {
      html = renderMarketReport(payload);
    } else {
      const velocityBusinessName = row.business_name
        || (payload && payload.data && (payload.data.name || payload.data.business_name))
        || '';
      const velocity = await fetchReviewVelocity(row.user_id, velocityBusinessName, row.created_at);
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
        velocity,
        // No reportId passed, "Download PDF" button is omitted from
        // the PDF itself (would be useless in a printed document).
      });
    }
    html = cleanDashes(html);

    // Lazy-load puppeteer + chromium so a missing/broken binary doesn't
    // crash server startup - only this route fails, with a clean JSON
    // error to the caller.
    const chromium = require('@sparticuz/chromium');
    const puppeteer = require('puppeteer-core');

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        bottom: '20mm',
        left: '15mm',
        right: '15mm',
      },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="GrowthIM-Report.pdf"'
    );
    return res.send(pdf);
  } catch (err) {
    console.error('[report/:id/pdf] failed:', err && err.message, err && err.stack);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'PDF generation failed. Please try again.' });
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.warn('[report/:id/pdf] browser close failed:', closeErr.message);
      }
    }
    pdfActive--;
  }
});

// GET / - public marketing landing page (GrowthIM brand).
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

// GET /app - the actual GrowthIM report-generation UI (index.html).
// Audit fix S8 - soft auth check: if there's no JWT cookie, bounce to
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
    const injected = html
      .replace(/%%GOOGLE_API_KEY%%/g, process.env.GOOGLE_PLACES_API_KEY || '')
      .replace(/%%PAYMENTS_CONFIG%%/g, JSON.stringify(payments.clientConfig()));
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  } catch (e) {
    console.error('[app] failed to render:', e.message);
    res.status(500).send('Internal error');
  }
});

// GET /dashboard - extensionless alias for /dashboard.html so the
// post-login redirect (and any "/dashboard" link in copy/emails)
// resolves cleanly instead of returning "Cannot GET /dashboard".
// The HTML's own JS fetches /auth/me on load and bounces to
// /login.html when no JWT cookie is present, so this route stays
// public - the auth check happens client-side after the file loads.
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
// Audit fix S2 / S3 - cap progressClients and gate behind requireAuth
// so an unauthenticated attacker can't probe other users' session IDs
// and can't pile up SSE connections to exhaust memory.
const MAX_PROGRESS_CLIENTS = 500;
const progressClients = new Map();
// Last progress tick per session, so a page refresh mid-report can replay the
// real current step/pct on reconnect instead of resetting to step 0. Bounded
// (LRU max + TTL) so abandoned sessions can't grow it without limit; cleared
// at terminal in completeJob/failJob.
const { LRUCache } = require('lru-cache');
const lastProgress = new LRUCache({ max: 1000, ttl: 2 * 60 * 60 * 1000 });
function sendProgress(sessionId, data) {
  if (!sessionId) return;
  // Record the tick BEFORE the connected-client early-return, so progress
  // emitted during a refresh gap (no client attached) is still captured for
  // replay on reconnect. Skip error frames (they carry no numeric pct).
  if (data && typeof data.pct === 'number') lastProgress.set(sessionId, data);
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
  // Replay the last known progress (if any) so a page refresh mid-report jumps
  // straight to the real current step/pct instead of sitting at step 0. The
  // client onmessage handler only advances the bar forward, so this is safe.
  const lp = lastProgress.get(req.params.sessionId);
  if (lp) res.write('data: ' + JSON.stringify(lp) + '\n\n');
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

// BUG 29 - Startup validation: every study_id referenced by a profile
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
        '[startup] study_id validation OK - ' + totalRefs + ' references across ' +
        Object.keys(allProfiles).length + ' profiles, all resolve to verifiedStudies.json'
      );
    } else {
      console.error(
        '[startup] study_id validation FAILED - ' + missingCount + ' of ' + totalRefs +
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
// Async report job pattern - keeps Railway's 5-minute HTTP proxy
// timeout from killing /classify and /market-analysis mid-request.
//
// Browser POSTs to /classify (or /market-analysis). The route
// synchronously initialises a job entry, replies { ok, jobId } in
// <1 s, and runs the actual generation work inside setImmediate().
// The browser polls GET /report-status/:jobId every few seconds,
// and redirects to /report/:id once status === 'ready'.
//
// Job state is persisted in the jobs table so jobs survive server
// restarts. Rows are purged hourly after 24 hours.
// ─────────────────────────────────────────────────────────────────────

// Create jobs table and indexes on startup if they do not exist.
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id     TEXT PRIMARY KEY,
        user_id    INTEGER,
        status     TEXT NOT NULL DEFAULT 'processing',
        report_id  INTEGER,
        error      TEXT,
        label      TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS jobs_user_id_idx    ON jobs (user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at)');
    // Idempotent: ensure the `label` column exists on a pre-existing jobs
    // table (it is in the CREATE above for fresh installs; this covers the
    // live prod table). The dashboard uses it to show a human-readable
    // subject on in-progress and failed cards - the typed query for rate
    // mode, "City, ST - market analysis" for market mode.
    await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS label TEXT');
    await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS report_type TEXT');

    // Durable outcome tally - separate from `jobs` ON PURPOSE so it
    // survives the hourly 24h jobs cleanup and gives a long-term record
    // of how report attempts ended (success / degraded / failed).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_outcomes (
        id          SERIAL PRIMARY KEY,
        report_type TEXT,
        outcome     TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // ── Dodo Payments tables (one-time $29.99 report gate) ───────────
    // pending_payments holds the report params + payment state for a job
    // awaiting / completing payment. Separate from `jobs` so the existing
    // job lifecycle + queries stay untouched.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_payments (
        job_id          TEXT PRIMARY KEY,
        user_id         INTEGER,
        report_type     TEXT,
        params          JSONB,
        dodo_session_id TEXT,
        payment_id      TEXT,
        status          TEXT NOT NULL DEFAULT 'awaiting_payment',
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS pending_payments_status_idx ON pending_payments (status)');
    // processed_webhooks gives DB-UNIQUE idempotency: the PRIMARY KEY makes a
    // repeated payment id a no-op (Dodo retries webhooks).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        webhook_id  TEXT PRIMARY KEY,
        type        TEXT,
        received_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    console.log('[jobs] table ready');

    // ── Startup reconciliation: orphaned 'processing' jobs ──────────────
    // A restart (deploy, crash, manual bounce) abandons any in-flight job:
    // the worker that would have moved it to 'ready'/'error' is gone, so it
    // sits in 'processing' forever and the user's page spins indefinitely.
    // Flip every such job to 'error' with a clear message so they can retry.
    //
    // NOTE: this flips ALL 'processing' jobs on boot, which is correct for a
    // SINGLE-PROCESS deployment (only one instance touches this table). If
    // this app is ever run as MULTIPLE concurrent instances, this MUST be
    // revisited - a booting instance would otherwise kill jobs actively
    // running on another live instance.
    // Own try/catch: a failed reconciliation must never stop startup (the
    // process-level crash guards back this up too).
    try {
      const reconciled = await pool.query(
        `UPDATE jobs SET status = 'error', error = $1, updated_at = NOW() WHERE status = 'processing'`,
        ['Report was interrupted by a server restart. Please try again.']
      );
      console.log(`[startup] reconciled ${reconciled.rowCount} orphaned processing job(s) -> error`);
    } catch (recErr) {
      console.error('[startup] orphaned-job reconciliation failed:', recErr.message);
    }
  } catch (err) {
    console.error('[jobs] table create failed:', err.message);
  }
})();

async function setJob(sessionId, userId, label, reportType) {
  if (!sessionId) return;
  try {
    await pool.query(
      `INSERT INTO jobs (job_id, user_id, status, report_id, error, label, report_type, created_at, updated_at)
       VALUES ($1, $2, 'processing', NULL, NULL, $3, $4, NOW(), NOW())
       ON CONFLICT (job_id) DO UPDATE SET updated_at = NOW(), label = EXCLUDED.label, report_type = EXCLUDED.report_type`,
      [sessionId, userId, label ? String(label).slice(0, 300) : null, reportType || null]
    );
  } catch (err) {
    console.error('[jobs] setJob failed:', err.message);
  }
}

async function failJob(sessionId, message) {
  if (!sessionId) return;
  lastProgress.delete(sessionId);
  try {
    await pool.query(
      `UPDATE jobs SET status = 'error', error = $2, updated_at = NOW() WHERE job_id = $1`,
      [sessionId, String(message || 'Report generation failed').slice(0, 1000)]
    );
  } catch (err) {
    console.error('[jobs] failJob DB update failed:', err.message);
  }
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

async function completeJob(sessionId, reportId) {
  if (!sessionId) return;
  lastProgress.delete(sessionId);
  try {
    await pool.query(
      `UPDATE jobs SET status = 'ready', report_id = $2, error = NULL, updated_at = NOW() WHERE job_id = $1`,
      [sessionId, reportId == null ? null : reportId]
    );
  } catch (err) {
    console.error('[jobs] completeJob DB update failed:', err.message);
  }
}

// ── Durable outcome logging (record-only) ────────────────────────────
// Appends one row per terminal report outcome. Its own try/catch means a
// logging failure can NEVER break or fail a report; it runs ALONGSIDE
// completeJob/failJob (fire-and-forget, never awaited) and never gates them.
async function recordOutcome(reportType, outcome) {
  try {
    await pool.query(
      `INSERT INTO report_outcomes (report_type, outcome) VALUES ($1, $2)`,
      [reportType, outcome]
    );
    console.log(`[outcome] ${reportType} report: ${outcome}`);
  } catch (err) {
    console.error('[outcome] record failed:', err && err.message);
  }
}

// ── Dodo Payments: pending-job + webhook handlers ───────────────────────
// Only reached when PAYMENTS_ENABLED. Paid report lifecycle:
//   /api/checkout/report -> 'awaiting_payment' job + pending_payments row
//   -> Dodo overlay -> customer pays -> payment.succeeded webhook
//   -> handleDodoPaymentSucceeded -> startPaidReport -> reportGate(pipeline)

// Create the job row up front as 'awaiting_payment'. This status is invisible
// to MAX_CONCURRENT_REPORTS (reportGate runs only at execution time), to the
// dashboard (lists status IN ('processing','error')), to admin stats (counts
// status='processing'), and to startup reconciliation (flips only 'processing').
// Abandoned ones are swept by the janitor above.
async function setPendingPaymentJob(jobId, userId, label, reportType) {
  await pool.query(
    `INSERT INTO jobs (job_id, user_id, status, report_id, error, label, report_type, created_at, updated_at)
     VALUES ($1, $2, 'awaiting_payment', NULL, NULL, $3, $4, NOW(), NOW())
     ON CONFLICT (job_id) DO UPDATE SET status = 'awaiting_payment', label = EXCLUDED.label, report_type = EXCLUDED.report_type, updated_at = NOW()`,
    [jobId, userId, label ? String(label).slice(0, 300) : null, reportType || null]
  );
}

// Run a PAID report through the SAME pipeline the free path uses, with a
// single automatic retry on failure (decision: auto-retry ONCE; if it still
// fails, flag for manual re-delivery; NEVER auto-refund).
function startPaidReport(jobId, userId, reportType, params) {
  const runOnce = () => (reportType === 'market')
    ? marketPipeline({ sessionId: jobId, userId, city: params.city, state: params.state })
    : classifyPipeline({ sessionId: jobId, userId, input: params.input, clientPlaceId: params.clientPlaceId || '', res: { setHeader() {} } });

  const jobFailed = async () => {
    const r = await pool.query(`SELECT status FROM jobs WHERE job_id = $1`, [jobId]).catch(() => null);
    return !!(r && r.rows[0] && r.rows[0].status === 'error');
  };

  reportGate(jobId, async () => {
    await runOnce();
    if (await jobFailed()) {
      console.warn('[payments] paid report failed - auto-retrying ONCE for job', jobId);
      await pool.query(`UPDATE jobs SET status = 'processing', error = NULL, updated_at = NOW() WHERE job_id = $1`, [jobId]).catch(() => {});
      await runOnce();
      if (await jobFailed()) {
        console.error('[payments] paid report failed AGAIN after retry - flagging for manual re-delivery, job', jobId);
        await pool.query(`UPDATE pending_payments SET status = 'needs_manual_redelivery', updated_at = NOW() WHERE job_id = $1`, [jobId]).catch(() => {});
        // Never auto-refund. Job stays 'error' (failJob messaged the user);
        // pending_payments flags it for a human / free re-delivery.
      }
    }
  });
}

async function handleDodoPaymentSucceeded(payload) {
  const data = payments.dataOf(payload);
  const paymentId = data.payment_id || data.paymentId || null;
  // Idempotency #1 - DB-UNIQUE on the payment id (Dodo retries webhooks).
  if (paymentId) {
    try {
      const ins = await pool.query(
        `INSERT INTO processed_webhooks (webhook_id, type) VALUES ($1, 'payment.succeeded')
         ON CONFLICT (webhook_id) DO NOTHING`,
        [paymentId]
      );
      if (ins.rowCount === 0) {
        console.log('[payments] duplicate payment.succeeded ignored:', paymentId);
        return;
      }
    } catch (e) { console.error('[payments] idempotency insert failed:', e.message); }
  }
  // Defense-in-depth - must be OUR product, exact $29.99, USD.
  if (!payments.paymentMatchesReportProduct(data)) {
    console.error('[payments] payment.succeeded did NOT match the $29.99 report product - ignoring',
      { amount: data.total_amount, currency: data.currency });
    return;
  }
  const { jobId } = payments.metadataFrom(data);
  if (!jobId) {
    console.error('[payments] payment.succeeded has no job_id metadata - cannot map to a report');
    return;
  }
  // Idempotency #2 (authoritative) - atomic compare-and-set awaiting_payment
  // -> paid. Only the FIRST delivery flips it and enqueues the report.
  const upd = await pool.query(
    `UPDATE pending_payments SET status = 'paid', payment_id = $2, updated_at = NOW()
     WHERE job_id = $1 AND status = 'awaiting_payment'
     RETURNING report_type, params, user_id`,
    [jobId, paymentId]
  );
  if (upd.rowCount === 0) {
    console.log('[payments] job already paid/processed or unknown - skipping:', jobId);
    return;
  }
  const row = upd.rows[0];
  let params;
  try { params = typeof row.params === 'string' ? JSON.parse(row.params) : row.params; }
  catch (_) { params = {}; }
  // Flip the job to 'processing' so the dashboard + /report-status show the
  // generating (or queued) state instead of awaiting_payment.
  await pool.query(`UPDATE jobs SET status = 'processing', updated_at = NOW() WHERE job_id = $1`, [jobId]).catch(() => {});
  console.log('[payments] payment confirmed - starting', row.report_type, 'report for job', jobId);
  startPaidReport(jobId, row.user_id, row.report_type, params);
}

async function handleDodoPaymentFailed(payload) {
  const data = payments.dataOf(payload);
  const { jobId } = payments.metadataFrom(data);
  console.warn('[payments] payment.failed for job', jobId || '(unknown)');
  if (!jobId) return;
  // Mark pending failed; leave the job at 'awaiting_payment' (NOT 'error', so
  // an unpaid attempt never surfaces a scary failure). Janitor sweeps it.
  await pool.query(
    `UPDATE pending_payments SET status = 'failed', updated_at = NOW() WHERE job_id = $1 AND status = 'awaiting_payment'`,
    [jobId]
  ).catch(() => {});
}

async function handleDodoRefundSucceeded(payload) {
  const data = payments.dataOf(payload);
  const paymentId = data.payment_id || data.paymentId || null;
  // Record-only: the report (a digital good) was already delivered; per the
  // refund policy refunds are rare (duplicate/erroneous). No auto re-charge,
  // no access revocation - just an audit log + a status flag for visibility.
  console.log('[payments] refund.succeeded recorded for payment', paymentId || '(unknown)');
  if (paymentId) {
    await pool.query(
      `UPDATE pending_payments SET status = 'refunded', updated_at = NOW() WHERE payment_id = $1`,
      [paymentId]
    ).catch(() => {});
  }
}

// Cleanup loop - every hour purge job rows older than 24 hours.
// `unref()` so the timer never blocks a clean process exit.
setInterval(async () => {
  try {
    const result = await pool.query(
      `DELETE FROM jobs WHERE created_at < NOW() - INTERVAL '24 hours'`
    );
    if (result.rowCount > 0) {
      console.log(`[jobs] cleanup: deleted ${result.rowCount} old job(s)`);
    }
    // Abandoned/failed-checkout TTL: purge the companion pending_payments rows
    // (status 'awaiting_payment' = overlay opened but never paid, or 'failed'
    // = payment declined) + their 'awaiting_payment' jobs after 2 hours.
    // Paid / processing / ready jobs are untouched.
    try {
      const stale = await pool.query(
        `DELETE FROM pending_payments WHERE status IN ('awaiting_payment', 'failed') AND created_at < NOW() - INTERVAL '2 hours' RETURNING job_id`
      );
      if (stale.rowCount > 0) {
        await pool.query(
          `DELETE FROM jobs WHERE status = 'awaiting_payment' AND created_at < NOW() - INTERVAL '2 hours'`
        );
        console.log(`[payments] cleanup: purged ${stale.rowCount} abandoned checkout(s)`);
      }
    } catch (e) {
      console.error('[payments] abandoned-checkout cleanup failed:', e.message);
    }
  } catch (err) {
    console.error('[jobs] cleanup failed:', err.message);
  }
}, 60 * 60 * 1000).unref();

// GET /report-status/:jobId - polled by the browser every 3 s after
// it submits /classify or /market-analysis. Defensive cross-user
// check: the job entry stores the user that started it, and we
// return 'not_found' if a different user polls - sessionIds are
// random client tokens but if one leaks we don't want a second
// logged-in user to be able to read the first one's status.
app.get('/report-status/:jobId', requireAuth, async (req, res) => {
  try {
    const jobId = String(req.params.jobId || '');
    const { rows } = await pool.query(
      `SELECT status, report_id, error, user_id FROM jobs WHERE job_id = $1`,
      [jobId]
    );
    if (!rows.length) return res.json({ status: 'not_found' });
    const job = rows[0];
    if (job.user_id != null && job.user_id !== req.user.id) {
      return res.json({ status: 'not_found' });
    }
    const resp = {
      status: job.status,
      reportId: job.report_id,
      error: job.error,
    };
    // Paid flow: a job stays 'awaiting_payment' until the payment.succeeded
    // webhook flips it. If a payment.failed webhook arrived instead, its
    // companion pending_payments row is marked 'failed' (the jobs row is left
    // at 'awaiting_payment' on purpose, so an unpaid attempt never becomes a
    // scary error card). Surface that as a distinct 'payment_failed' status so
    // the browser can show "payment failed - try again" instead of an endless
    // "confirming…". One extra query, and only in the rare awaiting case.
    if (job.status === 'awaiting_payment' && payments.isEnabled()) {
      try {
        const pp = await pool.query(
          `SELECT status FROM pending_payments WHERE job_id = $1`,
          [jobId]
        );
        if (pp.rows.length && pp.rows[0].status === 'failed') {
          resp.status = 'payment_failed';
        }
      } catch (_) { /* leave as awaiting_payment - the 40s timeout backstop covers it */ }
    }
    // For an in-progress job, tell the browser whether it is actually running
    // or still waiting behind the concurrency cap. A queued job also gets its
    // place in line + a rough wait estimate, so the page can show
    // "#N in line, about X min" instead of a live progress terminal.
    if (job.status === 'processing') {
      const position = getQueuePosition(jobId);
      if (position > 0) {
        resp.queued = true;
        resp.queuePosition = position;
        resp.estimatedWaitMinutes = Math.ceil(position / MAX_CONCURRENT_REPORTS) * AVG_REPORT_MINUTES;
      } else {
        resp.queued = false;
      }
    }
    return res.json(resp);
  } catch (err) {
    console.error('[report-status] DB error:', err.message);
    return res.json({ status: 'not_found' });
  }
});

// ── POST /api/checkout/report - start a PAID report (PAYMENTS_ENABLED) ──
// requireAuth + reportLimiter. The rate limit lives here for the paid flow
// (it remains on /classify + /market-analysis for the free flow). Creates
// the 'awaiting_payment' job + pending_payments row with the report params,
// then a SERVER-SIDE Dodo checkout session (product/amount/metadata are NOT
// client-controlled). Returns { jobId, checkoutUrl } for the overlay to open.
app.post('/api/checkout/report', reportLimiter, requireAuth, async (req, res) => {
  if (!payments.isEnabled()) return res.status(404).json({ error: 'Not found' });
  try {
    const userId = req.user.id;
    const email = req.user.email || undefined;
    const reportType = (req.body.reportType === 'market') ? 'market' : 'rate';
    let jobId = (req.body.sessionId || '').toString().trim();
    if (!jobId) jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

    let params, label;
    if (reportType === 'market') {
      const city = (req.body.city || '').toString().trim();
      const state = (req.body.state || '').toString().trim();
      if (!city || !/^[A-Za-z]{2}$/.test(state)) {
        return res.status(400).json({ error: 'City and a 2-letter state are required.' });
      }
      params = { city, state };
      label = `${city}, ${state.toUpperCase()} - market analysis`;
    } else {
      const input = (req.body.query || '').toString().trim();
      const clientPlaceId = (req.body.place_id || '').toString().trim();
      if (!input) return res.status(400).json({ error: 'Please enter a business name and address.' });
      params = { input, clientPlaceId };
      label = input;
    }

    await setPendingPaymentJob(jobId, userId, label, reportType);
    await pool.query(
      `INSERT INTO pending_payments (job_id, user_id, report_type, params, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'awaiting_payment', NOW(), NOW())
       ON CONFLICT (job_id) DO UPDATE SET report_type = EXCLUDED.report_type, params = EXCLUDED.params, status = 'awaiting_payment', updated_at = NOW()`,
      [jobId, userId, reportType, JSON.stringify(params)]
    );

    const { checkoutUrl, sessionId } = await payments.createReportCheckoutSession({ jobId, userId, reportType, customerEmail: email });
    if (!checkoutUrl) throw new Error('Dodo did not return a checkout URL');
    await pool.query(`UPDATE pending_payments SET dodo_session_id = $2, updated_at = NOW() WHERE job_id = $1`, [jobId, sessionId]).catch(() => {});

    console.log('[checkout] session created for job ' + jobId + ' (' + reportType + ') — awaiting payment; NO data APIs or report pipeline started');
    return res.json({ ok: true, jobId, checkoutUrl });
  } catch (err) {
    console.error('[checkout] failed:', err && err.message);
    return res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

app.post('/classify', reportLimiter, requireAuth, async (req, res) => {
  // Fix #1: reject a PRESENT-but-non-string body field with a clean 400. A number/
  // object/array would otherwise throw a TypeError on the .trim() below → 500.
  // Absent (null/undefined) fields fall through to the existing `|| ''` handling.
  for (const f of ['query', 'place_id', 'sessionId']) {
    if (req.body && req.body[f] != null && typeof req.body[f] !== 'string') {
      return res.status(400).json({ ok: false, error: 'Invalid input. Please enter a valid business name.' });
    }
  }
  const input = (req.body.query || '').trim();
  // Optional - set by the landing-page autocomplete when the user picks
  // a suggestion from the dropdown. Lets us skip the 7-step findPlace
  // resolver and use Google's exact place_id directly. Empty string
  // when the user typed free text without selecting a suggestion;
  // falls back to findPlace in that case (backwards compatible).
  const clientPlaceId = (req.body.place_id || '').trim();
  const sessionId = (req.body.sessionId || '').toString();
  const userId = req.user.id;

  // Payment gate: when PAYMENTS_ENABLED, free generation is OFF — the browser
  // must use /api/checkout/report (overlay -> pay -> webhook runs the report).
  // Defense-in-depth refusal of a direct hit. When the flag is OFF this is
  // skipped and the route behaves EXACTLY as before.
  if (payments.isEnabled()) {
    return res.status(402).json({ ok: false, needsPayment: true, error: 'Payment required.' });
  }

  // Gate full (5 running + 5 waiting): turn the request away BEFORE creating a
  // job or closing the response, so a rejected request leaves no 'processing'
  // row behind.
  if (reportActive + reportQueue.length >= MAX_CONCURRENT_REPORTS + MAX_QUEUE) {
    return res.status(503).json({ ok: false, busy: true, error: BUSY_MESSAGE });
  }

  // ── Async job init (Railway 5-min HTTP timeout workaround) ──────
  // Mark the job 'processing' first, then close the response. The
  // browser starts polling /report-status/:jobId at 3 s cadence; the
  // actual report runs inside setImmediate() below, free of any
  // upstream HTTP timeout.
  // Label = the user's typed query. It is the only meaningful subject we
  // have at this point (the resolved business name is not computed until
  // after the response is closed), and it lets the dashboard show a
  // recognizable "generating" card while the job runs.
  await setJob(sessionId, userId, input || null, 'rate');
  res.json({ ok: true, jobId: sessionId });

  // From here on we run detached. Every error path inside the try
  // block routes through failJob(sessionId, msg) instead of res.send.
  // res.setHeader is silenced because the response is already closed
  // (the existing X-* diagnostic headers below would otherwise warn).
  setImmediate(() => {
   res.setHeader = function () {};
   // Gate the heavy pipeline behind the shared concurrency limiter.
   reportGate(sessionId, () => classifyPipeline({ sessionId, userId, input, clientPlaceId, res }));
  });
});

// ── Extracted classify report pipeline ──────────────────────────────────
// Hoisted so BOTH the free path (setImmediate above) and the paid path
// (Dodo webhook -> startPaidReport) can run it. Body is UNCHANGED from the
// original inline closure; `res` is the real response on the free path (its
// X-* diagnostic headers are silenced) or a { setHeader(){} } stub when run
// after payment. Captures: sessionId, userId, input, clientPlaceId, res.
async function classifyPipeline({ sessionId, userId, input, clientPlaceId, res }) {
   try {
    if (!input) {
      failJob(sessionId, 'Please enter a business name and city.');
      return;
    }
    sendProgress(sessionId, { step: 1, total: 29, message: 'Locating your business on Google Maps...', pct: 2 });

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
  // the keyword is matched as its own token in the full input - including
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

  // Phase-3 fallback - when Layer 0 produced no NAICS, do an early Places
  // Text Search and try to derive NAICS from the result's types[] array.
  // If types[] is degenerate (no match in either pass), fall through to a
  // name-based pattern match against the Place's name field. We stash
  // placeStub so we don't double-call Places below.
  let placeStub = null;
  // Universal place_id short-circuit: when the landing-page autocomplete
  // supplied a place_id, set placeStub up front so EVERY downstream
  // `if (!placeStub)` guard (Phase-3 types fallback, claude-classify
  // fallback, main resolver) skips findPlace and uses Google's exact
  // selected place_id. Backwards compatible - when no place_id is
  // present, placeStub stays null and findPlace runs as before.
  if (clientPlaceId) {
    placeStub = {
      place_id: clientPlaceId,
      name: input.split(',')[0].trim(),
    };
    console.log('[classify] place_id set early:', clientPlaceId, '- all findPlace calls skipped');
    // BUG 8 - when the landing-page autocomplete supplied a place_id we
    // short-circuited findPlace, but the resulting placeStub has only
    // `place_id` + `name` - no `types`. That broke the Phase-3 types
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
        console.warn('[classify] place_id early-details failed:', e.message, '- continuing without types');
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
    // Tier 1: name fallback - runs FIRST so brand/keyword signals override
    // misleading Google type tags (Phase 2 Session 9.5.1+):
    //   - breweries tagged 'bar' → brewery_winery_distillery wins
    //   - chiropractors tagged 'gym' → chiropractic wins
    //   - moving companies tagged 'storage' → moving_company wins
    //   - cleaning services tagged 'laundry' → cleaning wins (Honolulu maid)
    //
    // Match against TWO sources, in this order:
    //   1. Input business name (text before the street address) - captures
    //      user intent even when Google returns a truncated/different name
    //      ("Inglenook" instead of "Inglenook Winery", "1600 Glenarm Place"
    //      instead of "Greystar Real Estate").
    //   2. Google's returned place_name - fallback for inputs that don't
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

  // Diagnostic - Phase 3 instrumentation
  console.log('[diag] classify:', JSON.stringify({
    input,
    layer0_mode: layer0Result.mode,
    layer0_naics6: layer0Result.naics6 || null,
    places_types_fallback_fired: !!typesFallback,
    places_name_fallback_fired: !!nameFallback,
    google_types_returned: typesFallback ? typesFallback.types : (placeStub ? placeStub.types : null),
  }));

  // Diagnostic response headers - set before any res.send so all branches
  // (waitlist, unsupported, error, blocked, report) carry them. The test
  // harness reads these to capture Layer 0 mode without parsing HTML.
  res.setHeader('X-Layer0-Mode', layer0Result.mode || 'unknown');
  res.setHeader('X-Naics6', layer0Result.naics6 || '');
  res.setHeader('X-Place-Name', placeStub && placeStub.name ? encodeURIComponent(placeStub.name) : '');

  // OOS check via naicsRouter - short-circuits to waitlist for explicit
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

  // Phase 5+ - Claude classification fallback. When Layer 0 + Phase-3
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
      // Re-run OOS check on Claude's NAICS - if it lands on an explicit
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
    failJob(sessionId, `This business type is not yet supported by GrowthIM. We support 1400+ business types. If you think your input should have matched one of them, please contact us at support@growthim.com and we'll add coverage for your category.`);
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
        console.log('[classify] using client place_id:', clientPlaceId, '- skipping findPlace');
        placeStub = {
          place_id: clientPlaceId,
          name: input.split(',')[0].trim(),
        };
      } else {
        console.log('[classify] no place_id - running findPlace');
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

  sendProgress(sessionId, { step: 2, total: 29, message: `Found: ${placeStub.name || 'business'}, reading your profile...`, pct: 5 });
  let detail;
  try {
    detail = await places.getDetails(placeStub.place_id, API_KEY);
  } catch (err) {
    failJob(sessionId, `Google Places details failed: ${err.message}`);
    return;
  }
  sendProgress(sessionId, {
    step: 3, total: 29,
    message: (detail && detail.user_ratings_total)
      ? `Scanning ${detail.user_ratings_total} customer reviews for patterns...`
      : 'Scanning customer reviews for patterns...',
    pct: 8,
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
  // Multi-sort review fetch: pull newest, lowest-rated, highest-rated,
  // and relevant reviews in parallel so Claude gets a balanced cross-
  // section of customer experience. Number of sorts scales with review
  // count (0 sorts for 0 reviews; 4 sorts for 20+ reviews).
  // Each review carries a _sort tag so claudeEnricher can label it.
  {
    const reviewFetch = await places.fetchAllSortedReviews(
      placeStub.place_id,
      data.google_review_count,
      API_KEY
    );
    data.sample_reviews = reviewFetch.reviews;
    console.log(`[reviews] subject: ${reviewFetch.reviews.length} unique reviews from ${reviewFetch.callCount} API calls`);
  }

  // ════════════════════════════════════════════════════════════════════
  // BATCH14 - 360° signal expansion. Run all enrichment fetches in
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
  // the data is in the Places Details payload - no extra API call needed.
  // ════════════════════════════════════════════════════════════════════
  const nearbyType = places.pickNearbySearchType(data.google_types);
  const zip = dataFetchers.extractZipFromAddress(data.formatted_address);
  const websiteUrl = data.website;

  // Phase 5+ - extended to 5 parallel fetches: competitors, census,
  // website HEAD check, weather climatology (Open-Meteo), and location
  // signals (Overpass / OpenStreetMap). PageSpeed is run conditionally
  // AFTER this batch - only if the website check confirms the site loads
  // (per spec: "Only call if website_url is not null and website_exists
  // is true"). Each promise has its own try/catch + timeout, so one
  // failure never blocks the rest of the report.
  // City/state extracted once for fetchUpcomingEvents (and for any
  // future city/state-keyed source). Re-uses claudeEnricher.parseAddress
  // since it already handles the Google formatted_address shape.
  const addrParts = claudeEnricher.parseAddress(data.formatted_address || '');

  // Phase 5+ - derived fields the new sector-conditional fetchers need.
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
  // resolved here - if NAICS changes, profile.id may end up stale
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
            '- attempting AI profile selection'
          );
        }
      } catch (e) {
        console.error('[layer0-ai] profile re-resolve failed:', e.message);
      }

      // BUG 9 - When correctedProfile was found AND the AI correction
      // didn't move the high-level NAICS-2 sector, the registry-resolved
      // profile is already a strong match - skipping selectBestProfile
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
          '[profile-selector] skipped - correctedProfile found and sector unchanged (n2=' +
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
    console.error('[layer0-ai] verification failed:', e.message, '- continuing with original');
  }

  data.sector_naics2 = naics2FromNaics6(layer0Result.naics6);
  data.profile_id = profile.id;

  // ── Shared-code profile disambiguation (merge-gate) ───────────────
  // A few NAICS-6 codes are shared by a broad profile (the first-wins
  // winner) and one or more specialty profiles that can never be reached
  // by NAICS alone (721110 lodging vs resort; 621111 medical_practice vs
  // plastic_surgery/dermatology; 621210 dental_practice vs orthodontics/
  // oral_surgery). When the settled profile is the broad winner of such a
  // code, ask a focused Claude sub-call (web search) to pick the right
  // profile from a CLOSED menu and set it directly. Purely additive: any
  // failure / non-HIGH / off-menu / broad answer leaves the settled
  // profile untouched (identical to today). Sits AFTER the settled-profile
  // line so it overrides it; the specialty shares the parent's NAICS-2, so
  // data.sector_naics2 (already set above) and all sector-gated fetchers
  // below are unaffected.
  const MERGING_CODES = {
    '721110': { broad: 'hospitality.lodging',         menu: ['hospitality.lodging', 'hospitality.resort'] },
    '621111': { broad: 'healthcare.medical_practice', menu: ['healthcare.medical_practice', 'healthcare.plastic_surgery', 'healthcare.dermatology'] },
    '621210': { broad: 'healthcare.dental_practice',  menu: ['healthcare.dental_practice', 'healthcare.orthodontics', 'healthcare.oral_surgery'] },
  };
  const _mc = MERGING_CODES[layer0Result.naics6];
  if (_mc && _mc.menu.length >= 2) {
    try {
      const _allP = profileResolver.getAllProfiles();
      const _pick = await claudeEnricher.disambiguateSharedCode(data, _mc.menu, _mc.broad, _allP);
      if (_pick && _pick.confidence === 'HIGH'
          && _pick.profile_id && _pick.profile_id !== _mc.broad
          && _mc.menu.includes(_pick.profile_id)
          && _allP[_pick.profile_id]) {
        console.log('[merge-gate] switched', layer0Result.naics6, profile.id, '->', _pick.profile_id, '(', _pick.confidence, ')');
        profile = _allP[_pick.profile_id];
        data.profile_id = _pick.profile_id;
        data.profile_disambiguated = _pick.profile_id;
      } else {
        console.log('[merge-gate] kept broad', layer0Result.naics6, profile.id);
      }
    } catch (e) {
      console.error('[merge-gate] failed:', e.message, '- keeping broad');
    }
  }

  // Phase 5+ - sector-conditional promises. Skip (resolve to null)
  // when the business doesn't belong to the relevant NAICS-2 sector
  // or profile family - saves API budget and keeps the data bundle
  // free of fields that don't apply.
  // BLS employment by sector - expanded coverage:
  //   54/61/62/23/44-45 (original - professional/edu/health/construction/retail)
  //   71 (entertainment), 72 (hotels+restaurants), 81 (personal services)
  const BLS_NAICS2 = new Set(['54','61','62','23','44','45','44-45','71','72','81']);
  const blsPromise = BLS_NAICS2.has(data.sector_naics2)
    ? dataFetchers.fetchBLSEmployment(data.sector_naics2)
    : Promise.resolve(null);
  // USDA NASS - detect crop type from business name so a berry farm
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
  // NAICS-6 source of truth for these gates: layer0Result.naics6 - NOT
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
  // FMCSA Safety - narrowed to actual trucking operations. Previously
  // fired for all 48-49 (transit/limo/taxi/pipeline/scenic transport
  // got safety lookups they don't need). naics3 derived from naics6
  // distinguishes the trucking subset:
  //   484 (truck transportation) - core target
  //   488 (support activities for transportation, e.g., freight brokers)
  // Excludes 485 transit/limo/taxi, 486 pipeline, 487 scenic, 492 courier.
  const fmcsaNaics3 = gateNaics6.slice(0, 3);
  const fmcsaPromise = (fmcsaNaics3 === '484' || fmcsaNaics3 === '488')
    ? dataFetchers.fetchFMCSA(data.business_name, data.state)
    : Promise.resolve(null);
  // NPI Registry - health-sector NAICS-2 = 62 plus veterinarians (541940,
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

  // Phase 5+ - 4 new keyless sector-gated promises. NAICS prefix gates
  // mirror the spec: only fire when the business sector benefits from
  // that data source so we don't waste calls on every /classify.
  const naics6 = (layer0Result && layer0Result.naics6) || '';
  const naics2 = naics6.slice(0, 2);
  const naics3 = naics6.slice(0, 3);
  const naics4 = naics6.slice(0, 4);

  // ── Resolve county EARLY for CDC Places + HRSA Dental ───────────
  // The building-permits fetcher inside the main Promise.allSettled
  // batch eventually populates data.county_name, but that's too late
  // for CDC and HRSA - both promises are CONSTRUCTED before that
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
        '- CDC/HRSA will use city fallback'
      );
    }
  }
  // Surface the resolved county on `data` so downstream consumers
  // (renderer, claudeEnricher bundle, etc.) can read it without
  // waiting for the building-permits result block. Permits will
  // overwrite later with the same value (or a more authoritative
  // one from the HUD ArcGIS layer) - safe to overwrite.
  if (earlyCountyName) {
    data.county_name = earlyCountyName;
    data.county_fips = earlyCountyFIPS;
  }

  // CDC PLACES local health metrics - medical (621) / fitness (713) / restaurants (722)
  const cdcPromise = (naics3 === '621' || naics3 === '713' || naics3 === '722')
    ? dataFetchers.fetchCDCPlaces(
        (addrParts && addrParts.city) || '',
        (addrParts && addrParts.state) || '',
        earlyCountyName
      )
    : Promise.resolve(null);

  // HRSA Dental Health Professional Shortage Area - dental practices only (6212)
  // Uses the ArcGIS HPSA_Dental FeatureServer; needs state + county.
  const hrsaPromise = (naics4 === '6212')
    ? dataFetchers.fetchHRSADental(
        (addrParts && addrParts.state) || '',
        earlyCountyName
      )
    : Promise.resolve(null);

  // USDA ERS ARMS farm economics - agriculture (11) / restaurants (722) /
  // grocery (445) / food manufacturing (311 bakeries) / beverage
  // manufacturing (312 breweries/wineries/distilleries). 311 and 312 are
  // consumer-facing food producers with retail dynamics; ERS food-price
  // trends apply.
  const ersPromise = (naics2 === '11' || naics3 === '722' || naics3 === '445' || naics3 === '311' || naics3 === '312')
    ? dataFetchers.fetchUSDAERS((addrParts && addrParts.state) || '')
    : Promise.resolve(null);

  // Phase 5+ - 5 more keyless / free-key sector-gated promises.
  // FoodData + Open Food Facts both seed off a cuisine / food query;
  // fall back to a sensible default for grocery (445) where no
  // cuisine field is set by the cuisine-detection pipeline.
  const foodQuery = data.cuisine || data.cuisine_type
    || (naics3 === '445' ? 'grocery' : 'food');

  // USDA FoodData Central - restaurants (722) / grocery (445) /
  // food manufacturing (311 bakeries) / beverage manufacturing (312).
  const foodDataPromise = (naics3 === '722' || naics3 === '445' || naics3 === '311' || naics3 === '312')
    ? dataFetchers.fetchFoodData(foodQuery)
    : Promise.resolve(null);

  // Open Food Facts - restaurants (722) / grocery (445)
  const offPromise = (naics3 === '722' || naics3 === '445')
    ? dataFetchers.fetchOpenFoodFacts(foodQuery)
    : Promise.resolve(null);

  // Datamuse - fires for ALL sectors. Seeds off the business name so
  // Claude has related-concept words for naming ideas.
  const datamusePromise = dataFetchers.fetchDatamuse(
    data.business_name || data.name || ''
  );

  // NPS - hotels (721) / restaurants (722) / retail (44-45) /
  // entertainment (71 - golf, museums, escape rooms, zoos, amusement).
  // Park proximity drives tourism traffic for all of these.
  const npsPromise = (naics3 === '721' || naics3 === '722' || naics2 === '44' || naics2 === '45' || naics2 === '71')
    ? dataFetchers.fetchNearbyParks((addrParts && addrParts.state) || '')
    : Promise.resolve(null);

  // NOAA Climate Data Online - fires for ALL sectors. Long-term
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
      // fires in the same Promise.allSettled batch - the helper
      // defaults to a rural-sized radius when population is unknown.
      businessName: data.name,
      naics6: layer0Result.naics6,
      naics2: data.sector_naics2,
      googleTypes: data.google_types,
      population: null,
    }),
    // FIX 1 - pass city + state so fetchCensusByZip's place-level branch
    // fires. Without these args, _fetchCensusPlacePopulation is skipped
    // and `total_population` falls back to the ZCTA-level number (which
    // overstates the city by ~50% for Dodgeville WI: ZCTA 7,397 vs
    // city 4,994). countyFIPS isn't known yet at this point in the
    // route - the building-permits fetcher resolves it later - so we
    // pass null and skip the county-income branch on /classify (income
    // for cities >200k pop only; not a /classify use case).
    dataFetchers.fetchCensusByZip(zip, addrParts.city, addrParts.state, null),
    dataFetchers.checkWebsiteExists(websiteUrl),
    dataFetchers.fetchWeather(data.latitude, data.longitude, data.formatted_address),
    dataFetchers.fetchLocationSignals(data.latitude, data.longitude),
    // HUD residential building permits - Census geocoder (FIPS lookup) +
    // HUD ArcGIS query in sequence. Two HTTP calls but only fires ~5s
    // worst-case via internal timeouts. Cached 30 days per county FIPS.
    dataFetchers.fetchBuildingPermitsByAddress(data.formatted_address),
    // Ticketmaster Discovery v2 - top 5 upcoming events within 10 miles.
    // Returns empty array gracefully when TICKETMASTER_API_KEY is unset
    // or the city/state has nothing in their catalog.
    dataFetchers.fetchUpcomingEvents(addrParts.city, addrParts.state),
    // Phase 5+ FETCH 10 - Foursquare v3 nearby venues (food/arts/outdoors).
    // Returns [] when no key is configured. Cached 24h per lat/lon@3dec.
    dataFetchers.fetchNearbyVenues(data.latitude, data.longitude),
    // Phase 5+ FETCH 11 - TripAdvisor Content API (search → details +
    // reviews). Three HTTP calls internally; returns null if any step
    // fails. Cached 24h per businessName + city.
    dataFetchers.fetchTripAdvisor(data.name || input, data.formatted_address),
    // Phase 5+ FETCH 12-18 - sector-conditional sources. Each was
    // resolved above to either a real fetch promise or Promise.resolve(null).
    blsPromise,
    usdaPromise,
    fmcsaPromise,
    npiPromise,
    fmrPromise,
    fdicPromise,
    // Phase 5+ - 3 new keyless sector-gated fetchers
    cdcPromise,
    hrsaPromise,
    ersPromise,
    // Phase 5+ - 5 more sector-gated / always-on fetchers
    foodDataPromise,
    offPromise,
    datamusePromise,
    npsPromise,
    noaaPromise,
  ]);
  // Steps 4-13: all data sources just resolved from the parallel block -
  // surface them one-by-one over the next few seconds so the user sees
  // each source loading rather than a long pause.
  [
    { step:  4, pct: 11, msg: 'Identifying competitors within 5 miles...' },
    { step:  5, pct: 14, msg: 'Pulling live competitor ratings and hours...' },
    { step:  6, pct: 17, msg: 'Checking competitor website speeds...' },
    { step:  7, pct: 20, msg: `Loading US Census data for ${data.city || ''}...` },
    { step:  8, pct: 23, msg: 'Reading household income and population data...' },
    { step:  9, pct: 26, msg: 'Fetching building permits from HUD database...' },
    { step: 10, pct: 29, msg: `Checking NOAA climate records for ${data.city || ''}...` },
    { step: 11, pct: 32, msg: 'Scanning Ticketmaster for events within 30 miles...' },
    { step: 12, pct: 35, msg: 'Mapping commercial corridor around your location...' },
    { step: 13, pct: 38, msg: 'Running Bureau of Labor Statistics query...' },
  ].forEach((s, i) => setTimeout(() =>
    sendProgress(sessionId, { step: s.step, total: 29, message: s.msg, pct: s.pct }), i * 400
  ));

  // FETCH 1 - competitor stats (or null on failure)
  if (competitorRes.status === 'fulfilled' && competitorRes.value) {
    data.competitor_count = competitorRes.value.competitor_count;
    data.competitor_median_rating = competitorRes.value.competitor_median_rating;
    data.competitor_median_review_count = competitorRes.value.competitor_median_review_count;
    data.competitors_top3 = competitorRes.value.competitors_top3;
    data.competitors_top5 = competitorRes.value.competitors_top5;
    data.search_radius_miles = competitorRes.value.search_radius_miles;
    data.competitor_query = competitorRes.value.competitor_query;
  } else {
    data.competitor_count = null;
    data.competitor_median_rating = null;
    data.competitor_median_review_count = null;
    data.competitors_top3 = null;
    data.competitors_top5 = null;
    data.search_radius_miles = null;
    data.competitor_query = null;
    if (competitorRes.status === 'rejected') {
      console.warn('[fetch1] nearby-search failed:', competitorRes.reason && competitorRes.reason.message);
    }
  }

  // Multi-sort competitor review fetch: replace the single-sort reviews
  // already on each top-5 competitor (from fetchNearbyCompetitors'
  // getDetails enrichment) with a richer multi-sort set so Claude sees
  // critical, recent, and highlighted reviews for each competitor.
  // Runs in parallel across all 5 competitors; each call is independently
  // guarded so one failure doesn't block the others.
  if (Array.isArray(data.competitors_top5) && data.competitors_top5.length > 0) {
    await Promise.all(data.competitors_top5.map(async (comp) => {
      if (!comp.place_id) return;
      try {
        const reviewFetch = await places.fetchAllSortedReviews(
          comp.place_id,
          typeof comp.review_count === 'number' ? comp.review_count : 0,
          API_KEY
        );
        comp.reviews = reviewFetch.reviews;
        console.log(`[reviews] ${comp.name}: ${reviewFetch.reviews.length} unique reviews from ${reviewFetch.callCount} API calls`);
      } catch (err) {
        console.warn(`[reviews] competitor review fetch failed for ${comp.name}:`, err.message);
      }
    }));
  }

  // FETCH 2 - Census ACS (or null on failure)
  if (censusRes.status === 'fulfilled' && censusRes.value) {
    data.median_household_income = censusRes.value.median_household_income;
    data.total_population = censusRes.value.total_population;
    data.average_household_size = censusRes.value.average_household_size;
    data.census_zip = censusRes.value.zip;
    data.population_source = censusRes.value.population_source || 'zip';
    // Phase 5+ - housing extension piggybacks on the same ACS call.
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

  // FETCH 4 - website HEAD check
  if (websiteRes.status === 'fulfilled') {
    data.website_url = websiteUrl || null;
    data.website_exists = websiteRes.value;
  } else {
    data.website_url = websiteUrl || null;
    data.website_exists = null;
    console.warn('[fetch4] website-check failed:', websiteRes.reason && websiteRes.reason.message);
  }

  // Phase 5+ FETCH 5 - Open-Meteo climatology
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

  // Phase 5+ FETCH 6 - Overpass / OpenStreetMap location signals
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

  // Phase 5+ FETCH 7 - HUD residential building permits (Census geocoder
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

  // Phase 5+ FETCH 8 - Ticketmaster upcoming events (city/state)
  // Returns [] gracefully when no API key is set or the call fails.
  if (eventsRes.status === 'fulfilled' && Array.isArray(eventsRes.value)) {
    data.upcoming_events = eventsRes.value;
  } else {
    data.upcoming_events = [];
    if (eventsRes.status === 'rejected') {
      console.warn('[fetch8-events] failed:', eventsRes.reason && eventsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 10 - Foursquare nearby venues (food/arts/outdoors)
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

  // FIX 2 - verify each Foursquare venue against Google Places before
  // including it in the report. Keeps only OPERATIONAL businesses.
  // Timeout per venue: 5 seconds. Runs sequentially to avoid hammering
  // the Places API; venue lists are short (typically 5-10 items).
  if (data.nearby_venues.length > 0 && API_KEY && typeof data.latitude === 'number' && typeof data.longitude === 'number') {
    const verifiedVenues = [];
    for (const venue of data.nearby_venues) {
      try {
        const vUrl = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
        vUrl.searchParams.set('input', venue.name);
        vUrl.searchParams.set('inputtype', 'textquery');
        vUrl.searchParams.set('fields', 'place_id,business_status');
        vUrl.searchParams.set('locationbias', `circle:500@${data.latitude},${data.longitude}`);
        vUrl.searchParams.set('key', API_KEY);
        const vac = new AbortController();
        const vtimer = setTimeout(() => vac.abort(), 5000);
        let vjson = null;
        try {
          const vres = await fetch(vUrl.toString(), { signal: vac.signal });
          clearTimeout(vtimer);
          if (vres.ok) vjson = await vres.json();
        } catch (_) {
          clearTimeout(vtimer);
        }
        const candidates = vjson && Array.isArray(vjson.candidates) ? vjson.candidates : [];
        if (candidates.length === 0) {
          console.log('[corridor] not found removing:', venue.name);
          continue;
        }
        if (candidates[0].business_status === 'OPERATIONAL') {
          console.log('[corridor] verified open:', venue.name);
          verifiedVenues.push(venue);
        } else {
          console.log('[corridor] removed closed:', venue.name);
        }
      } catch (err) {
        console.log('[corridor] not found removing:', venue.name);
      }
    }
    data.nearby_venues = verifiedVenues;
    data.nearby_venue_count = verifiedVenues.length;
  }

  // Phase 5+ FETCH 11 - TripAdvisor (search → details + reviews)
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

  // Phase 5+ FETCH 12 - BLS sector employment level
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

  // Phase 5+ FETCH 13 - USDA NASS agriculture profile
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

  // Phase 5+ FETCH 14 - FMCSA carrier safety
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

  // Phase 5+ FETCH 15 - NPI Registry healthcare provider
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

  // Phase 5+ FETCH 16 - HUD Fair Market Rents
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

  // Phase 5+ FETCH 17 - FDIC bank data
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

  // Phase 5+ FETCH 20 - CDC PLACES local health metrics (sector-gated)
  if (cdcRes.status === 'fulfilled' && cdcRes.value) {
    data.cdc_health = cdcRes.value;
  } else {
    data.cdc_health = null;
    if (cdcRes.status === 'rejected') {
      console.warn('[fetch20-cdc-places] failed:', cdcRes.reason && cdcRes.reason.message);
    }
  }

  // Phase 5+ FETCH 21 - HRSA Dental HPSA (dental practices only)
  if (hrsaRes.status === 'fulfilled' && hrsaRes.value) {
    data.hrsa_dental = hrsaRes.value;
  } else {
    data.hrsa_dental = null;
    if (hrsaRes.status === 'rejected') {
      console.warn('[fetch21-hrsa-dental] failed:', hrsaRes.reason && hrsaRes.reason.message);
    }
  }

  // Phase 5+ FETCH 22 - USDA ERS ARMS farm economics (sector-gated)
  if (ersRes.status === 'fulfilled' && ersRes.value) {
    data.usda_ers = ersRes.value;
  } else {
    data.usda_ers = null;
    if (ersRes.status === 'rejected') {
      console.warn('[fetch22-usda-ers] failed:', ersRes.reason && ersRes.reason.message);
    }
  }

  // Phase 5+ FETCH 23 - USDA FoodData Central (sector-gated)
  if (foodDataRes.status === 'fulfilled' && foodDataRes.value) {
    data.food_data = foodDataRes.value;
  } else {
    data.food_data = null;
    if (foodDataRes.status === 'rejected') {
      console.warn('[fetch23-fooddata] failed:', foodDataRes.reason && foodDataRes.reason.message);
    }
  }

  // Phase 5+ FETCH 24 - Open Food Facts (sector-gated)
  if (offRes.status === 'fulfilled' && offRes.value) {
    data.open_food_facts = offRes.value;
  } else {
    data.open_food_facts = null;
    if (offRes.status === 'rejected') {
      console.warn('[fetch24-openfoodfacts] failed:', offRes.reason && offRes.reason.message);
    }
  }

  // Phase 5+ FETCH 25 - Datamuse related words (all sectors)
  if (datamuseRes.status === 'fulfilled' && datamuseRes.value) {
    data.related_words = datamuseRes.value;
  } else {
    data.related_words = null;
    if (datamuseRes.status === 'rejected') {
      console.warn('[fetch25-datamuse] failed:', datamuseRes.reason && datamuseRes.reason.message);
    }
  }

  // Phase 5+ FETCH 26 - NPS national parks (sector-gated)
  if (npsRes.status === 'fulfilled' && npsRes.value) {
    data.nearby_nps_parks = npsRes.value;
  } else {
    data.nearby_nps_parks = null;
    if (npsRes.status === 'rejected') {
      console.warn('[fetch26-nps] failed:', npsRes.reason && npsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 27 - NOAA Climate Data Online (all sectors)
  if (noaaRes.status === 'fulfilled' && noaaRes.value) {
    data.noaa_climate = noaaRes.value;
  } else {
    data.noaa_climate = null;
    if (noaaRes.status === 'rejected') {
      console.warn('[fetch27-noaa] failed:', noaaRes.reason && noaaRes.reason.message);
    }
  }

  // Phase 5+ FETCH 9 - Google PageSpeed Insights (mobile)
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

  // Phase 5+ FETCH 9b - Competitor PageSpeed (sequential, 2s gap between calls)
  // getDetails calls are almost always cache hits here - top5WithDetails already
  // fired them during competitor enrichment. PSI calls run sequentially with a
  // 2s pause between each to avoid saturating the PSI API and hitting the 30s
  // timeout on all calls simultaneously. Results stored in
  // data.competitors_top5_pagespeed for render.
  data.competitors_top5_pagespeed = [];
  if (Array.isArray(data.competitors_top5) && data.competitors_top5.length > 0 && API_KEY) {
    const compPagespeedResults = [];
    for (const comp of data.competitors_top5) {
      if (!comp.place_id) {
        compPagespeedResults.push({ name: comp.name, website: null, mobile_score: null, load_time_seconds: null });
        continue;
      }
      try {
        const det = await places.getDetails(comp.place_id, API_KEY);
        const website = (det && typeof det.website === 'string' && det.website.trim()) ? det.website.trim() : null;
        if (website) {
          // Step 1: Try PSI first.
          let speedResult = await dataFetchers.fetchCompetitorPageSpeed(comp.name, website);
          let speedSource = speedResult ? 'psi' : null;
          // Step 2: PSI returned null (timeout/bot-block) → fall back to CrUX.
          if (!speedResult) {
            speedResult = await dataFetchers.fetchCruxScore(website, API_KEY);
            speedSource = speedResult ? 'crux' : null;
          }
          compPagespeedResults.push({
            name: comp.name,
            website,
            mobile_score:      speedResult ? speedResult.mobile_score      : null,
            load_time_seconds: speedResult ? speedResult.load_time_seconds : null,
            source:            speedSource,
          });
          await new Promise(r => setTimeout(r, 2000));
        } else {
          compPagespeedResults.push({ name: comp.name, website: null, mobile_score: null, load_time_seconds: null });
        }
      } catch (err) {
        console.warn('[fetch9b-comp-pagespeed] failed for', comp.name, ':', err.message);
        compPagespeedResults.push({ name: comp.name, website: null, mobile_score: null, load_time_seconds: null });
      }
    }
    data.competitors_top5_pagespeed = compPagespeedResults;
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

  // W3: when Google omits business_status (thin listings), default it to
  // operational so the required-fields gate below doesn't hard-fail the report.
  // A genuinely-closed business carries the explicit 'CLOSED_PERMANENTLY' /
  // 'CLOSED_TEMPORARILY' value (truthy), so this `== null` default never
  // overrides it — the closed-business banner + blocking flag stay intact.
  if (data.business_status == null) data.business_status = 'OPERATIONAL';

  const requiredMissing = profile.required_inputs.filter((f) => {
    if (f === 'google_review_count') return false;
    // A business with zero reviews has no rating - treat null rating as valid
    // (all render functions guard typeof === 'number' before using it).
    if (f === 'google_rating') return false;
    return data[f] === null || data[f] === undefined;
  });
  if (requiredMissing.length) {
    res.setHeader('X-Status', 'missing_fields');
    failJob(sessionId, `Missing required fields from Google Places: ${requiredMissing.join(', ')}`);
    return;
  }

  const redFlags = evaluateRedFlags(profile, data);
  const blocking = redFlags.find((r) => r.severity === 'critical' && r.blocks_report && r.id !== 'rf_closed_permanently' && !/CLOSED_PERMANENTLY/.test(r.trigger || ''));
  if (blocking) {
    res.setHeader('X-Status', 'blocked');
    failJob(sessionId, `Report blocked: ${(blocking && blocking.message) || 'critical issue detected for this business.'}`);
    return;
  }
  res.setHeader('X-Status', 'report');

  const ranked = scoreRecommendations(profile, data, studies.studies);
  const strengths = computeStrengths(profile, data);
  sendProgress(sessionId, { step: 14, total: 29, message: 'Calculating your market position score...', pct: 41 });

  // Phase 5 - Claude enrichment. Builds a deterministic data bundle from
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
  sendProgress(sessionId, { step: 15, total: 29, message: 'Cross-referencing 27 verified data sources...', pct: 44 });
  // Steps 16-28: fake progress ticks fired during the Claude call.
  // Spread across 13 minutes to match observed Call A wall time (~5-6 min)
  // plus B+C1+C2 parallel block (~3-5 min). All timers are cleared
  // immediately when Claude returns so fast runs skip unfired steps.
  const claudeTimers = [];
  // Timer-leak fix (1M-run finding): create the progress timers and run the
  // enrichment await inside try/finally so all 13 long-delay setTimeouts are
  // cleared on EVERY exit (success, thrown enrichment, or any future early
  // return) — not just the success path. They still FIRE during the await
  // (finally runs only after it settles), so progress messages are unchanged.
  let enriched;
  try {
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 16, total: 29, message: 'GrowthIM Intelligence Engine activated...', pct: 48 }),   20000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 17, total: 29, message: 'Researching your top competitors in depth...', pct: 52 }),   80000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 18, total: 29, message: 'Identifying what competitors do better than you...', pct: 56 }),  150000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 19, total: 29, message: 'Finding competitor weaknesses you can exploit...', pct: 60 }),  220000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 20, total: 29, message: 'Building your competitor deep dive analysis...', pct: 64 }),  290000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 21, total: 29, message: 'Scanning your market for untapped opportunities...', pct: 68 }),  360000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 22, total: 29, message: 'Finding opportunities nobody in your market is doing...', pct: 72 }), 420000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 23, total: 29, message: 'Calculating your seasonal demand strategy...', pct: 76 }), 480000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 24, total: 29, message: 'Writing your priority actions with revenue estimates...', pct: 80 }), 540000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 25, total: 29, message: 'Building your 90-day action plan week by week...', pct: 84 }), 600000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 26, total: 29, message: 'Calculating revenue opportunities for your market...', pct: 88 }), 650000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 27, total: 29, message: 'Generating your key risks and early warning signs...', pct: 92 }), 700000));
  claudeTimers.push(setTimeout(() => sendProgress(sessionId, { step: 28, total: 29, message: 'Finalizing your market intelligence report...', pct: 96 }), 750000));
  enriched = await claudeEnricher.enrichWithClaude(dataBundle);
  } finally {
    // Clear on ALL exits — fixes the failure-path leak where a thrown
    // enrichment left all 13 long-delay timers pending (1M-run finding).
    claudeTimers.forEach(t => clearTimeout(t));
    claudeTimers.length = 0;
  }
  // Detect Call A failure so renderReport can surface the partial-report
  // banner at the top of the page. enrichWithClaude returns a partial
  // object with _partial:'A_failed' when callClaudeEnrichA returned null
  // (main 20-min timeout AND 7-min fallback timeout both expired, or any
  // other A-only failure). null indicates total Claude failure (no API
  // key or unreachable client) - also treated as a partial state.
  if (enriched && enriched._partial === 'A_failed') {
    data.call_a_failed = true;
    console.warn('[claude] Call A failed (Call B partial) - partial report banner will be shown');
  } else if (!enriched) {
    // Total Claude failure - no API key, network unreachable, or both
    // calls rejected catastrophically. Render the Claude-unavailable
    // banner instead of the partial-report banner so the user knows the
    // AI-enhanced sections are entirely missing (not just half of them).
    data.claude_unavailable = true;
    console.warn('[claude] enrichWithClaude returned null - full Claude-unavailable banner will be shown');
  }
  claudeTimers.forEach(t => clearTimeout(t));
  sendProgress(sessionId, { step: 29, total: 29, message: 'Your report is ready.', pct: 100 });

  // FIX 3 - Em-dash post-processing. Walk every Claude-generated field
  // listed by the user and strip em/en/horizontal-bar dashes IN PLACE
  // before we render or persist. This is the belt-and-braces second
  // pass behind the ABSOLUTE FORBIDDEN RULE in SYSTEM_PROMPT_A - when
  // (not if) the model slips a dash through, we catch it here so the
  // user never sees one. Cleans the enriched object so:
  //   1. The rendered HTML below is dash-free by construction.
  //   2. The JSON written to DB at INSERT INTO reports is dash-free,
  //      so /report/:id replays render dash-free too.
  if (enriched && typeof enriched === 'object') {
    if (enriched.priority_actions) deepCleanDashes(enriched.priority_actions);
    if (enriched.ninety_day_plan) deepCleanDashes(enriched.ninety_day_plan);
    if (enriched.opportunities) deepCleanDashes(enriched.opportunities);
    if (enriched.seasonal_strategy) deepCleanDashes(enriched.seasonal_strategy);
    if (enriched.competitor_deep_dive) deepCleanDashes(enriched.competitor_deep_dive);
  }

  // Review-gap velocity, look up the user's most recent prior report for
  // this same business and pull their previous google_review_count. The
  // renderReviewGap section uses this to show "your reviews grew from X
  // to Y in Z days". Wrapped in try/catch inside fetchReviewVelocity so
  // a DB failure just renders the 30-day fallback instead of crashing.
  const velocityBusinessName = data.name || data.business_name || input || '';
  const velocity = await fetchReviewVelocity(userId, velocityBusinessName, new Date());

  let html = renderReport({
    input,
    layer0Result,
    profile,
    data,
    redFlags,
    strengths,
    ranked,
    enriched,
    studies: studies.studies,
    velocity,
  });
  // Defense in depth - also pass the final HTML string through cleanDashes
  // in case any dashes came through template chrome or non-cleaned fields.
  html = cleanDashes(html);

  // Citation linter (post-render, warn-only). Walk every cited study_id
  // referenced in the rendered report's top-10 recommendations and verify
  // it resolves in verifiedStudies.json. Bad references log a console
  // warning but do NOT block the response - the user wants visibility
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
        `[lint] ${profile.id} report passes - ${claims.length} claims, ${lintResult.sourceCount} unique studies cited`
      );
    }
  } catch (err) {
    console.warn('[lint] linter execution failed:', err.message);
  }

  // ── Persist report to Postgres ──────────────────────────────────
  // Only saves when the request is authenticated (req.user set by
  // requireAuth). The save is fire-and-forget from the user's POV -
  // any DB failure logs to stderr but does NOT block the response,
  // so the user always receives their report even if Postgres is
  // momentarily unreachable. The `_type` discriminator lets
  // GET /report/:id pick the right renderer when replaying the
  // saved data later.
  // Persist the report and capture the new id. The polling browser
  // is going to redirect to /report/:id, so DB save success is now
  // load-bearing - if it fails we surface the error rather than
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
    recordOutcome('rate', 'failed');
    return;
  }

  completeJob(sessionId, savedReportId);
  const rateDegraded = !!(data && (data.call_a_failed || data.claude_unavailable));
  recordOutcome('rate', rateDegraded ? 'degraded' : 'success');
   } catch (jobErr) {
    console.error('[classify] background job failed:', jobErr && jobErr.message, jobErr && jobErr.stack);
    failJob(sessionId, (jobErr && jobErr.message) || 'Report generation failed.');
    recordOutcome('rate', 'failed');
   }
}

app.post('/market-analysis', reportLimiter, requireAuth, async (req, res) => {
  // Fix #1: reject PRESENT-but-non-string body fields with a clean 400 (mirrors
  // /classify); absent fields fall through to the existing handling below.
  for (const f of ['city', 'state', 'sessionId']) {
    if (req.body && req.body[f] != null && typeof req.body[f] !== 'string') {
      return res.status(400).json({ ok: false, error: 'Invalid input. Please enter a valid city and state.' });
    }
  }
  const { city, state } = req.body;
  const sessionId = (req.body.sessionId || '').toString();
  const userId = req.user.id;
  console.log('[market-analysis] called for', city, state);

  // Payment gate: when PAYMENTS_ENABLED, free generation is OFF (see /classify).
  if (payments.isEnabled()) {
    return res.status(402).json({ ok: false, needsPayment: true, error: 'Payment required.' });
  }

  // Gate full (5 running + 5 waiting): turn the request away BEFORE creating a
  // job or closing the response (mirrors /classify), so a rejected request
  // leaves no 'processing' row behind.
  if (reportActive + reportQueue.length >= MAX_CONCURRENT_REPORTS + MAX_QUEUE) {
    return res.status(503).json({ ok: false, busy: true, error: BUSY_MESSAGE });
  }

  // ── Async job init (Railway 5-min HTTP timeout workaround) ──────
  // Label matches the finished report's business_name format ("City, ST -
  // market analysis") so the dashboard card text stays stable when the job
  // transitions from generating to finished. Guarded: setJob runs before
  // city/state validation below, so they may be missing on a bad request.
  const jobLabel = (city && state)
    ? `${String(city).trim()}, ${String(state).trim().toUpperCase()} - market analysis`
    : 'Market analysis';
  await setJob(sessionId, userId, jobLabel, 'market');
  res.json({ ok: true, jobId: sessionId });

  setImmediate(() => {
   res.setHeader = function () {};
   // Gate the heavy pipeline behind the shared concurrency limiter (shared with /classify).
   reportGate(sessionId, () => marketPipeline({ sessionId, userId, city, state }));
  });
});

// ── Extracted market-analysis report pipeline ───────────────────────────
// Hoisted so BOTH the free path (setImmediate above) and the paid path
// (Dodo webhook -> startPaidReport) can run it. Body UNCHANGED from the
// original inline closure. Captures: sessionId, userId, city, state.
async function marketPipeline({ sessionId, userId, city, state }) {
   try {

  // ── TIER 1 - Validation ─────────────────────────────────────────
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
    // ── TIER 2 → 5 - Orchestrate via claudeMarketAnalyst.analyzeCity
    // The analyzer pulls geocode + 4 parallel data agents + scoring +
    // why_this_city batch + deep dive on #1 - see the comments in
    // claudeMarketAnalyst.js for the full flow.
    const result = await claudeMarketAnalyst.analyzeCity(
      city.trim(),
      state.trim().toUpperCase(),
      {
        google: process.env.GOOGLE_PLACES_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
      }
    );

    // ── Provenance - verify every quote Claude emitted against the
    // exact review_snippets we shipped to it. Result is attached to
    // `result` so renderMarketReport can render colour-coded badges.
    if (result && result.deep_dive && result._provenance) {
      result._quote_verification = verifyQuotes(result.deep_dive, result._provenance);
      const total = result._quote_verification.length;
      const verified = result._quote_verification.filter((q) => q.verified === true).length;
      const failed = result._quote_verification.filter((q) => q.verified === false).length;
      console.log(
        `[provenance] ${verified}/${total} quotes verified`
        + (failed > 0 ? ` - ${failed} UNVERIFIED` : '')
      );
    }

    cancelTimers();
    sendProgress(sessionId, { step: 10, total: 10, message: 'Building your report...', pct: 98 });
    const html = renderMarketReport(result);

    // ── Persist market analysis to Postgres ────────────────────────
    // Same fire-and-forget pattern as /classify above. Market analysis
    // covers ~20 business types so naics_code uses the #1-ranked
    // sector's NAICS-2 when available, else null. business_name is
    // tagged with "- market analysis" so the dashboard's list can
    // distinguish saved cities from saved businesses at a glance.
    // DB save is load-bearing now - the polling browser redirects to
    // /report/:id and needs a real row to land on.
    let savedReportId = null;
    try {
      if (userId) {
        const cityNorm = city.trim();
        const stateNorm = state.trim().toUpperCase();
        const businessName = `${cityNorm}, ${stateNorm} - market analysis`;
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
      recordOutcome('market', 'failed');
      return;
    }

    sendProgress(sessionId, { step: 10, total: 10, message: 'Done!', pct: 100 });
    completeJob(sessionId, savedReportId);
    const marketDegraded = !(result && result.deep_dive);
    recordOutcome('market', marketDegraded ? 'degraded' : 'success');
  } catch (err) {
    cancelTimers();
    console.error('[market-analysis] error:', err);
    failJob(sessionId, err.message || 'Something went wrong.');
    recordOutcome('market', 'failed');
  }

   } catch (jobErr) {
    console.error('[market-analysis] background job failed:', jobErr && jobErr.message, jobErr && jobErr.stack);
    failJob(sessionId, (jobErr && jobErr.message) || 'Market analysis failed.');
    recordOutcome('market', 'failed');
   }
}

// ── POST /market-chat - Tier 5c follow-up Q&A ──────────────────────
// Stateful: relies on the 24h MARKET_CACHE inside claudeMarketAnalyst.
// The front-end (renderMarketReport's embedded chat) submits city +
// state + question; we look up the cached analysis and pass it as
// context to a 1000-token Claude call.
app.post('/market-chat', requireAuth, async (req, res) => {
  const { city, state } = req.body || {};
  // Sanitize the user question - cap length, strip HTML tags. The
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

// ── Global error handler ──────────────────────────────────────────────
// 4-arg Express error middleware. Last app.use, so it catches anything
// passed via next(err) from the routes above. Full stack is logged
// server-side; the client NEVER sees it - just a generic 500. If headers
// were already sent (e.g. an SSE/streaming response), delegate to
// Express's default handler instead of double-responding.
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled route error:\n`, err.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Cold-deploy safety: auth.js now SELECTs users.token_version on every
// login / authenticated request. That column is created by db_setup.js,
// which is NOT auto-run, so a deploy against a DB predating the column
// would throw "column does not exist" and break auth. The boot block that
// sets up the jobs table above is fire-and-forget (not awaited before
// listen), so we ensure the column HERE and AWAIT it before app.listen —
// guaranteeing it exists before the first request can arrive. Idempotent;
// db_setup.js keeps the same ALTER for fresh installs / manual runs.
(async () => {
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0');
    console.log('[startup] users.token_version column ensured');
  } catch (err) {
    console.error('[startup] users.token_version migration failed:', err.message);
  }
  app.listen(PORT, () => {
    console.log(`GrowthIM listening on http://localhost:${PORT}`);
  });
})();

// BLS Business Employment Dynamics - survival rates for the 2013
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

// computeStrengths - returns array of plain-English 2-sentence strengths.
// Each strength is sentence-1 (what the fact is) + sentence-2 (why it
// matters). Raw data strings like "127 reviews > 43" are FORBIDDEN -
// the report must read as English prose for small business owners.
// Always returns at least one entry; if no measurable strength fires,
// emits the default "you exist on Google" fallback.
function computeStrengths(profile, data) {
  const b = profile.benchmarks || {};
  const out = [];

  // Rating above benchmark - two tiers depending on the delta.
  if (typeof data.google_rating === 'number' && typeof b.good_rating === 'number'
      && data.google_rating > b.good_rating) {
    const rating = data.google_rating.toFixed(1);
    const benchmark = b.good_rating.toFixed(1);
    const delta = data.google_rating - b.good_rating;
    if (delta >= 0.3) {
      // Well above benchmark (0.3+ stars ahead)
      out.push(
        `Your ${rating} star rating is above the industry benchmark of ${benchmark} stars. ` +
        `This puts you ahead of most competitors in Google search results.`
      );
    } else {
      // Above benchmark but within 0.3
      out.push(
        `Your ${rating} star rating meets the industry benchmark of ${benchmark} stars. ` +
        `Customers searching Google will see you as a trusted business in your area.`
      );
    }
  }

  // Reviews above local median (preferred) or above industry benchmark (fallback).
  // "Nx the local median of M reviews" wording - local median wins when
  // googlePlaces fed us competitor_median_review_count.
  if (typeof data.google_review_count === 'number'
      && typeof data.competitor_median_review_count === 'number'
      && data.competitor_median_review_count > 0
      && data.google_review_count > data.competitor_median_review_count) {
    const reviews = data.google_review_count.toLocaleString('en-US');
    const median = data.competitor_median_review_count;
    const ratio = (data.google_review_count / median).toFixed(1);
    out.push(
      `Your ${reviews} Google reviews are ${ratio}x the local median of ${median.toLocaleString('en-US')} reviews. ` +
      `Google is more likely to show your business first in local search results.`
    );
  } else if (typeof data.google_review_count === 'number'
      && typeof b.good_review_count === 'number'
      && b.good_review_count > 0
      && data.google_review_count > b.good_review_count) {
    const reviews = data.google_review_count.toLocaleString('en-US');
    const benchmark = b.good_review_count;
    const ratio = (data.google_review_count / benchmark).toFixed(1);
    out.push(
      `Your ${reviews} Google reviews are ${ratio}x the industry benchmark of ${benchmark.toLocaleString('en-US')} reviews. ` +
      `Google is more likely to show your business first in local search results.`
    );
  }

  // Hours complete - all 7 days listed on Google.
  if (data.hours_complete === true) {
    out.push(
      `Your business hours are fully listed on Google for all 7 days. ` +
      `Customers always know when you are open without having to call.`
    );
  }

  // Website exists - verified (website_exists === true means the URL
  // actually loaded in our HTTP check, not just that a URL was listed).
  if (data.website_exists === true) {
    out.push(
      `You have a website listed on your Google Business Profile. ` +
      `Customers can learn about your business before deciding to visit.`
    );
  }

  // Open now - Google reports the business as open at fetch time.
  if (data.is_open_now === true) {
    out.push(
      `Your business is currently open and marked as operational on Google. ` +
      `Customers searching right now can find and visit you today.`
    );
  }

  // Photo count above benchmark.
  if (typeof data.photo_count === 'number' && typeof b.photo_count_good === 'number'
      && data.photo_count > b.photo_count_good) {
    out.push(
      `You have ${data.photo_count} photos on your Google Business Profile. ` +
      `Businesses with more photos get significantly more clicks from Google Maps.`
    );
  }

  // Default fallback - if NOTHING measurable fired, show at least one
  // strength so the section reads as positive rather than empty.
  if (out.length === 0) {
    out.push(
      `Your business is listed and active on Google Business Profile. ` +
      `This means customers in your area can find you when searching online.`
    );
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

// ─────────────────────────────────────────────────────────────────────
// cleanDashes - post-processing safety net for Claude output
// -----------------------------------------------------------------
// SYSTEM_PROMPT_A forbids em/en/horizontal-bar dashes (ABSOLUTE FORBIDDEN
// RULE at the top of the prompt), but models occasionally slip them in
// anyway. This is the belt-and-braces second pass that strips them out.
//
// Replaces:
//   " - " (em dash with spaces)   -> ", "
//   "-"   (em dash anywhere)      -> ", "
//   " - " (en dash with spaces)   -> ", "
//   "-"   (en dash anywhere)      -> "-"
//   "&#x2015;" (horizontal bar)   -> ", "
//   " - " HTML entity         -> ", "
//   "-" HTML entity         -> "-"
// Then collapses any double commas.
//
// NOTE: HTML entity replacement handles cases where Claude output
// contains  -  or - literal entity text in its response.
function cleanDashes(text) {
  if (!text || typeof text !== 'string') return text;

  // HTML entities first (before Unicode char replacements)
  text = text.replace(/&mdash;/g, ', ');
  text = text.replace(/&ndash;/g, '-');

  // Em dash with spaces, comma
  text = text.replace(/ — /g, ', ');

  // Em dash without spaces, comma space
  text = text.replace(/—/g, ', ');

  // En dash with spaces, hyphen
  text = text.replace(/ – /g, '-');

  // En dash without spaces, hyphen
  text = text.replace(/–/g, '-');

  // Horizontal bar, comma space
  text = text.replace(/―/g, ', ');

  // Clean up double commas if any
  text = text.replace(/, ,/g, ',');
  text = text.replace(/,,/g, ',');

  return text;
}

// deepCleanDashes - recursive walker for arrays/objects with nested
// string values. Mutates in place and returns the same reference so it
// can be applied to enriched fields before they're persisted to DB.
// Skips numbers, booleans, null, and undefined.
function deepCleanDashes(value) {
  if (value == null) return value;
  if (typeof value === 'string') return cleanDashes(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = deepCleanDashes(value[i]);
    }
    return value;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      value[k] = deepCleanDashes(value[k]);
    }
    return value;
  }
  return value;
}

// PAGE_OPEN / PAGE_CLOSE - chrome shared by every render function
// (renderReport, renderMarketReport, renderError, renderUnsupported,
// renderWaitlist, renderBlocked). Two consumption paths:
//   1. Direct HTTP - full doc loads in browser
//   2. JS injection - landing page does `result.innerHTML = html`,
//      which strips doctype/html/body but keeps inner content +
//      <style> tag. Styles leak globally - that's fine because all
//      report classes are unique (.rec, .status, .impact, etc.) and
//      don't collide with the landing page's .lp-* / .result-* names.
//
// All colors mapped to the GrowthIM brand tokens. Inter font from
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

/* ── Priority action card (.rec) - blue left accent ─────────────── */
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

/* ── Opportunity card (/classify) - emerald left accent ────────── */
.opportunity { padding: 16px 18px; margin: 12px 0; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--emerald); border-radius: 8px; }
.opportunity h3 { margin: 4px 0 6px; font-size: 15px; }
.op-meta { display: flex; gap: 6px; margin-bottom: 4px; align-items: center; flex-wrap: wrap; }
.op-category { display: inline-block; background: var(--navy); color: #FFFFFF; font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.04em; text-transform: uppercase; }
.op-novelty { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.04em; text-transform: uppercase; }
.novelty-unique { background: var(--emerald); color: #FFFFFF; }
.novelty-rare   { background: var(--amber);   color: #FFFFFF; }
.novelty-common { background: var(--muted);   color: #FFFFFF; }

/* ── Market analysis card (/market-analysis) - navy left accent ── */
.mkt-card { padding: 18px 20px; margin: 14px 0; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--navy); border-radius: 8px; }
.mkt-card h3 { font-size: 18px; font-weight: 700; color: var(--navy); margin: 0 0 4px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mkt-rank { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--navy); color: #FFFFFF; font-size: 13px; font-weight: 700; flex-shrink: 0; }
.mkt-card .impact { font-size: 12px; padding: 3px 10px; }

/* The "← new search" link inside report content. The landing page
   wraps the report in its own .result-back top-level button, but
   direct-HTTP fetches still see this link. */
.back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 16px; color: var(--muted); font-size: 13px; font-weight: 500; }
.back:hover { color: var(--blue); }

/* ── FIX 6 - Dark mode ─────────────────────────────────────────── */
body.dark-mode { background: #0F1729; color: #F1F5F9; }
body.dark-mode h1, body.dark-mode h2, body.dark-mode h3 { color: #F1F5F9; }
body.dark-mode a { color: #60A5FA; }
body.dark-mode .back { color: #94A3B8; }
body.dark-mode .back:hover { color: #60A5FA; }
body.dark-mode .rec,
body.dark-mode .problem,
body.dark-mode .opportunity,
body.dark-mode .mkt-card { background: #1E293B; border-color: #334155; }
body.dark-mode .callout { background: #1E293B; border-color: #334155; }
body.dark-mode .coverage td { border-color: #334155; }
body.dark-mode .coverage td:first-child { color: #94A3B8; }
body.dark-mode .meta, body.dark-mode small { color: #94A3B8; }
body.dark-mode .why-study { background: #1E293B; border-color: #334155; }
body.dark-mode .honesty { background: #1E293B; border-color: #334155; }
body.dark-mode .money { background: #064E3B; border-left-color: #10B981; }
body.dark-mode .flag { background: #1C1917; }
body.dark-mode #dark-toggle { background: #1E293B; border-color: #334155; color: #F1F5F9; }

/* ── FIX 5 - Mobile responsive ─────────────────────────────────── */
@media (max-width: 768px) {
  body { font-size: 14px; padding: 16px 12px; }
  h1 { font-size: 22px !important; }
  h2 { font-size: 18px !important; }
  h3 { font-size: 16px !important; }
  table { display: block; overflow-x: auto; white-space: nowrap; }
  .chart-container { width: 100% !important; height: 250px !important; }
  .grid-2col, .grid-3col { grid-template-columns: 1fr !important; }
  .report-toc-grid { grid-template-columns: 1fr !important; }
  .conquest-weaknesses { grid-template-columns: 1fr !important; }
  .priority-action { padding: 16px !important; }
  .pdf-btn { font-size: 12px !important; padding: 6px 12px !important; }
  .back-links { flex-wrap: wrap !important; gap: 8px !important; }
  .review-gap-bar { flex-direction: column !important; }
  .anchor-score-grid { grid-template-columns: 1fr !important; }
  .seasonal-bar-row { flex-direction: column !important; }
}
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

/* OOS demand logging - every out-of-scope hit appended to oos_log.jsonl
   so we can prioritize sub-profile work based on what users actually type.
   Async write (fs.promises.appendFile) - non-blocking; if the write
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
  // NAICS-specific OOS messages - overrides the generic per-profile-id
  // messages below for business types where the generic copy (e.g.,
  // "DEA, pharmacy boards") doesn't apply. Falls through to the switch
  // for any NAICS not in this list.
  const naics6 = (layer0Result && layer0Result.naics6) || '';
  const naics3 = naics6.slice(0, 3);
  if (naics3 === '813') {
    heading = 'Religious / faith-based organizations - out of scope';
    reason = 'Religious and faith-based organizations have unique nonprofit governance, tax-exempt status, and community dynamics that require specialized guidance. GrowthIM currently does not support this sector.';
    waitlistFooter = 'No waitlist for this sector at this time. See the GrowthIM roadmap for future coverage updates.';
  } else if (naics6 === '812930') {
    heading = 'Parking operations - out of scope';
    reason = 'Parking operations involve municipal permits, zoning regulations and real estate dynamics that need specialized advice beyond GrowthIM’s current scope.';
    waitlistFooter = 'No waitlist for this sector at this time. See the GrowthIM roadmap for future coverage updates.';
  } else if (naics6 === '812921' || naics6 === '812922') {
    heading = 'Photo finishing - not currently supported';
    reason = 'This business sector is not currently supported by GrowthIM. We are expanding our coverage regularly.';
    waitlistFooter = 'Sub-profiles for this sector are on the roadmap. Add yourself to the waitlist (signup form coming in a later phase).';
  } else if (naics6 === '459930') {
    heading = 'Manufactured home dealers - out of scope';
    reason = 'Manufactured home dealers operate under HUD regulations and unique financing structures that require specialized advice beyond GrowthIM’s current scope.';
    waitlistFooter = 'No waitlist for this sector at this time. See the GrowthIM roadmap for future coverage updates.';
  } else switch (profileId) {
    case 'OUT_OF_SCOPE_REGULATED':
      heading = 'Regulated sector - waitlist';
      reason = 'This sector has industry-specific licensing or regulatory dynamics (e.g., DEA, state pharmacy/optical boards) that need a dedicated profile rather than the generalized retail/personal-care baseline.';
      waitlistFooter = 'Sub-profiles for this sector are on the roadmap. Add yourself to the waitlist (signup form coming in a later phase).';
      break;
    case 'OUT_OF_SCOPE_NICHE':
      heading = 'Niche sector - waitlist';
      reason = "This sector is a niche operation whose dynamics don't fit our generalized profiles. A future sub-profile will address it.";
      waitlistFooter = 'Sub-profiles for this sector are on the roadmap. Add yourself to the waitlist (signup form coming in a later phase).';
      break;
    case 'OUT_OF_SCOPE_55':
      heading = 'Out of scope - corporate / holding';
      reason = "GrowthIM serves consumer-facing local businesses. Holding companies, regional managing offices, and corporate HQs don't fit that pattern.";
      waitlistFooter = 'No waitlist for this sector. GrowthIM is intentionally not designed to serve this category.';
      break;
    case 'OUT_OF_SCOPE_92':
      heading = 'Out of scope - public administration';
      reason = 'GrowthIM serves private-sector consumer-facing businesses. Government agencies have different operational frameworks.';
      waitlistFooter = 'No waitlist for this sector. GrowthIM is intentionally not designed to serve this category.';
      break;
    default:
      heading = 'Out of scope';
      reason = 'This sector is currently outside GrowthIM\'s scope.';
      waitlistFooter = 'See the GrowthIM roadmap for sectors planned in later phases.';
  }
  return `${PAGE_OPEN}<a class="back" href="/app">&larr; new search</a> <a class="back" href="/dashboard">&larr; Back to Dashboard</a>
<h1>GrowthIM - ${escapeHtml(heading)}</h1>
<div class="status blocked">${escapeHtml(profileId)}</div>
<p>${escapeHtml(reason)}</p>
<p class="meta">Your input "${escapeHtml(input)}" classified to NAICS ${escapeHtml(layer0Result.naics6)}.</p>
<p>${escapeHtml(waitlistFooter)}</p>${PAGE_CLOSE}`;
}

function renderUnsupported(input, layer0Result) {
  return `${PAGE_OPEN}<a class="back" href="/app">&larr; new search</a> <a class="back" href="/dashboard">&larr; Back to Dashboard</a>
<h1>GrowthIM - business type not yet supported</h1>
<p>This business type is not yet supported by GrowthIM. We support 1400+
business types. If you think your input should have matched one of them,
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
<p class="meta">${escapeHtml(profile.name)} - NAICS ${escapeHtml(layer0Result.naics6)}</p>${PAGE_CLOSE}`;
}

// Render the Market Analysis (Mode 2) report. Takes an options object
// - { city, state, top5, analysis, census, age_profile, weather,
// permits, walk_score, county_density } - produced by the route
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
      const label = meta ? `&#10003; REAL REVIEW - ${escapeHtml(meta)}` : '&#10003; REAL REVIEW';
      return `<span class="hmark hmark-verified">${label}</span>`;
    }
    if (s.tier === 'fabricated') {
      return `<span class="hmark" style="background:var(--danger-bg);color:#991B1B;padding:2px 8px;border-radius:4px;font-size:11px">&#9888; NOT FOUND IN FETCHED REVIEWS</span>`;
    }
    return `<span class="hmark" style="background:var(--surface-soft);color:var(--muted);padding:2px 8px;border-radius:4px;font-size:11px">REVIEW - unverified</span>`;
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
  // SECTION 1 - HEADER
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
<h1>Market Intelligence - ${safeCity}, ${safeState}${healthBadge}${gradeBadge}</h1>
${sourcesHtml}
${execSummary}`;

  // ─────────────────────────────────────────────────────────────────
  // SECTION 2 - MARKET SNAPSHOT (6 cards)
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
  // SECTION 3 - TOP 10 BUSINESS IDEAS
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

        // ── Tier 1 winner card - gold border + scroll-link to deep dive
        const isWinner = rank === 1;
        const winnerStyle = isWinner
          ? ' style="border-left:6px solid var(--amber);box-shadow:0 0 0 2px var(--amber-tint)"'
          : '';
        const winnerLink = isWinner
          ? `<p style="margin:14px 0 0"><a href="#deep-dive-anchor" style="display:inline-block;padding:8px 16px;background:var(--amber);color:#fff;border-radius:6px;font-weight:600;text-decoration:none">&darr; Full deep dive below</a></p>`
          : '';

        // ── Tier 2 (ranks 2-5) - medium-depth block
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
${actions.slice(0, 3).map((a) => `<li>${escapeHtml(a.action || '-')} <span class="meta">${escapeHtml(a.cost || '$?')} · ${escapeHtml(a.timeline || 'TBD')}</span></li>`).join('')}
</ol>` : ''}
${steps.length ? `<p style="margin:0 0 4px"><strong>Startup steps:</strong></p>
<ol style="margin:0 0 10px;padding-left:22px">
${steps.slice(0, 3).map((step) => `<li>${escapeHtml(String(step))}</li>`).join('')}
</ol>` : ''}
${t2.key_risk ? `<p style="margin:0;color:var(--danger)"><strong>Key risk:</strong> ${styleTags(t2.key_risk)}</p>` : ''}
</div>`;
          }
        }

        // ── Tier 3 (ranks 6-10) - light block, muted
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
<tr><td>Startup cost</td><td><strong>${escapeHtml(s.startup_cost_range || '-')}</strong></td></tr>
<tr><td>5-year survival</td><td><strong>${escapeHtml(s.survival_y5 || '-')}</strong>${s.naics2 ? ` <span class="meta">(NAICS ${escapeHtml(s.naics2)})</span>` : ''}</td></tr>
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
  // SECTION 4 - DEEP DIVE on #1
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
<h3>${escapeHtml(sr.best_sector || 'Top sector')} <span class="impact impact-${riskTier}">${escapeHtml(sr.risk_level || '-')} RISK</span></h3>
<table class="coverage">
  <tr><td>1-year survival</td><td><strong>${escapeHtml(sr.year1_survival || '-')}</strong></td></tr>
  <tr><td>3-year survival</td><td><strong>${escapeHtml(sr.year3_survival || '-')}</strong></td></tr>
  <tr><td>5-year survival</td><td><strong>${escapeHtml(sr.year5_survival || '-')}</strong></td></tr>
  <tr><td>10-year survival</td><td><strong>${escapeHtml(sr.year10_survival || '-')}</strong></td></tr>
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
      quickWinsHtml = `<h3>Quick wins - do these this week</h3>` + dive.quick_wins.map((q) => `
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
<p class="meta">What's working for local businesses, with the actual review evidence.</p>` +
        dive.steal_strategy.map((s) => {
          const actions = Array.isArray(s.actions_to_steal) ? s.actions_to_steal : [];
          return `<div class="rec rec-high">
<h3>${escapeHtml(s.business_name || 'Business')} <span class="impact impact-${(s.confidence || '').toLowerCase() === 'high' ? 'high' : 'medium'}">${escapeHtml(s.confidence || '-')}</span></h3>
<p class="meta">${s.tenure ? 'Tenure: ' + escapeHtml(s.tenure) + ' · ' : ''}Trust weight: ${typeof s.trust_weight === 'number' ? s.trust_weight.toFixed(2) : '-'}</p>
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

    // Hidden gaps (high priority - local-specific)
    let hiddenGapsHtml = '';
    if (Array.isArray(dive.hidden_gaps) && dive.hidden_gaps.length) {
      hiddenGapsHtml = `<h3>Hidden gaps - high priority</h3>
<p class="meta">Problems unique to ${safeCity}, not universal.</p>` + dive.hidden_gaps.map((h) => `
<div class="flag critical">
<h3>${escapeHtml(h.title || 'Gap')}</h3>
${h.evidence ? `<p class="meta">${quoteBadge(h.evidence)} ${escapeHtml(h.evidence)}</p>` : ''}
${h.why_hidden ? `<p>${escapeHtml(h.why_hidden)}</p>` : ''}
${h.business_to_open ? `<p><strong>Business to open:</strong> ${escapeHtml(h.business_to_open)}</p>` : ''}
<p class="meta">${h.timeline ? escapeHtml(h.timeline) + ' · ' : ''}Cost: ${escapeHtml(h.cost_to_open || '-')}</p>
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
<td>${escapeHtml(g.segment || '-')}${g.confirmed ? ' <span class="hmark hmark-verified">CONFIRMED</span>' : ''}</td>
<td>${escapeHtml(g.review_mention_pct || '-')}</td>
<td>${typeof g.businesses_serving_them === 'number' ? g.businesses_serving_them : '-'}</td>
<td><strong>${typeof g.gap_points === 'number' ? g.gap_points + ' pts' : '-'}</strong></td>
<td>${escapeHtml(g.lost_revenue_est || '-')}</td>
</tr>`).join('')}
</table>` + dive.persona_gap_matrix.filter((g) => g.business_to_open || g.root_cause).map((g) => `
<div class="honesty honesty-reasonable-inference">
<p><strong>${escapeHtml(g.segment || '-')}:</strong> ${escapeHtml(g.root_cause || '')}</p>
${g.business_to_open ? `<p>→ <strong>Open:</strong> ${escapeHtml(g.business_to_open)}</p>` : ''}
</div>`).join('');
    }

    // Personas (4 cards)
    let personasHtml = '';
    if (Array.isArray(dive.personas) && dive.personas.length) {
      personasHtml = `<h3>Customer personas</h3>` + dive.personas.map((p) => `
<div class="rec rec-medium">
<h3>${escapeHtml(p.name || 'Persona')}</h3>
<p class="meta">${escapeHtml(p.profile || '-')}${p.gap_source ? ' · Gap source: ' + escapeHtml(p.gap_source) : ''}</p>
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
<h3>${season.charAt(0).toUpperCase() + season.slice(1)}${s.dominant_persona ? ` <span class="meta"> ${escapeHtml(s.dominant_persona)}</span>` : ''}${zeroBadge}</h3>
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
        : `<li><strong>${escapeHtml(p.name || '-')}</strong>${p.city ? ' (' + escapeHtml(p.city) + ')' : ''}${typeof p.distance_miles === 'number' ? ` - ${p.distance_miles} mi` : ''}: ${escapeHtml(p.product || '-')}${p.price ? ' · ' + escapeHtml(p.price) : ''}</li>`;
      const fmtAttract = (a) => typeof a === 'string'
        ? `<li>${escapeHtml(a)}</li>`
        : `<li><strong>${escapeHtml(a.name || '-')}</strong>${typeof a.distance_miles === 'number' ? ` - ${a.distance_miles} mi` : ''}${a.annual_visitors ? ': ' + escapeHtml(a.annual_visitors) : ''}</li>`;
      const fmtEvent = (e) => typeof e === 'string'
        ? `<li>${escapeHtml(e)}</li>`
        : `<li><strong>${escapeHtml(e.name || '-')}</strong>${e.timing ? ' (' + escapeHtml(e.timing) + ')' : ''}${e.attendance ? ': ' + escapeHtml(e.attendance) : ''}</li>`;
      const fmtPartner = (p) => typeof p === 'string'
        ? `<li>${escapeHtml(p)}</li>`
        : `<li><strong>${escapeHtml(p.name || '-')}</strong>${typeof p.rating === 'number' ? ` ${p.rating}★` : ''}${typeof p.distance_miles === 'number' ? ` · ${p.distance_miles} mi` : ''}: ${escapeHtml(p.angle || '-')}</li>`;
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

    // Known gaps (bottom - universal)
    let knownGapsHtml = '';
    if (Array.isArray(dive.known_gaps) && dive.known_gaps.length) {
      knownGapsHtml = `<h3 style="opacity:0.7">Known gaps - universal complaints</h3>
<p class="meta">Common across most markets; address but don't lead.</p>
<ul style="opacity:0.85">${dive.known_gaps.map((k) =>
        `<li><strong>${escapeHtml(k.title || '-')}:</strong> ${escapeHtml(k.one_line_opportunity || '-')}</li>`
      ).join('')}</ul>`;
    }

    // Confidence footer
    let confidenceHtml = '';
    if (dive.confidence) {
      const c = dive.confidence;
      const tier = (c.level || '').toLowerCase() === 'high' ? 'high'
                 : (c.level || '').toLowerCase() === 'low' ? 'low'
                 : 'medium';
      confidenceHtml = `<p class="meta"><span class="impact impact-${tier}">${escapeHtml(c.level || '-')} CONFIDENCE</span>${typeof c.score === 'number' ? ` · score ${c.score.toFixed(2)}` : ''}${typeof c.sources_confirmed === 'number' ? ` · ${c.sources_confirmed} sources` : ''}${c.note ? ' · ' + escapeHtml(c.note) : ''}</p>`;
    }

    const legendBox = `<div class="rec rec-minimal" style="background:var(--surface-soft);font-size:13px;margin:12px 0">
<h3 style="font-size:13px;color:var(--muted);margin-bottom:8px">About this analysis</h3>
<p style="margin:4px 0"><span class="hmark hmark-verified">[VERIFIED]</span> - confirmed from live Google Places, U.S. Census, BLS, HUD, Open-Meteo, or Wikipedia data.</p>
<p style="margin:4px 0"><span class="hmark hmark-verified">&#10003; REAL REVIEW</span> - quote substring-matched against the live Google Place Details review text we fetched for this city.</p>
<p style="margin:4px 0"><span class="hmark" style="background:var(--danger-bg);color:#991B1B;padding:2px 8px;border-radius:4px;font-size:11px">&#9888; NOT FOUND IN FETCHED REVIEWS</span> - quote could not be matched to any fetched review; treat as unverified.</p>
<p class="meta" style="margin:8px 0 0">Persona names are illustrative (fictional). Review quotes are verified live; failed verifications are flagged.</p>
</div>`;
    // ── Verification summary line - appended at the end of the deep dive
    const verifTotal = verifications.length;
    const verifPassed = verifications.filter((v) => v && v.verified === true).length;
    const verifFailed = verifications.filter((v) => v && v.verified === false).length;
    const verifSkipped = verifications.filter((v) => v && v.verified === null).length;
    const verifSummary = verifTotal > 0
      ? `<p class="meta" style="margin-top:18px;padding:10px 12px;background:var(--surface-soft);border-radius:6px"><strong>${verifPassed} of ${verifTotal}</strong> review quotes verified against live Google data.${verifFailed > 0 ? ` <span style="color:var(--danger);font-weight:600">${verifFailed} could not be verified.</span>` : ''}${verifSkipped > 0 ? ` <span class="meta">${verifSkipped} were too short to verify.</span>` : ''}</p>`
      : '';
    deepDiveHtml = `<h2 id="deep-dive-anchor">Deep dive - #1: ${escapeHtml(top1Type)}</h2>
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
<p class="ai-fallback-note">Deep dive analysis unavailable. Claude AI did not return a usable response. Top 10 ranking is still based on real data.</p>`;
  }

  // ─────────────────────────────────────────────────────────────────
  // SECTION 5 - FOLLOW-UP CHAT
  // Embedded form + inline JS that POSTs to /market-chat. Uses
  // data-* attributes to know which city|state to look up.
  // ─────────────────────────────────────────────────────────────────
  // Audit fix S1 - use the file-wide escapeHtml() helper instead of a
  // bespoke replace that only handles `"`. escapeHtml escapes &, <, >,
  // ", and ' so a city containing any HTML-special char (Madison's,
  // O'Brien, "St. John's", an injected `<` etc.) renders into the
  // data-* attributes without closing them. The downstream inline
  // chat script reads via form.dataset.city / form.dataset.state -
  // the browser auto-decodes the HTML entities on read, so the JS
  // sees the same string the user typed.
  const chatHtml = `<h2>Ask a follow-up</h2>
<p class="meta">Ask anything about this analysis. Claude has the full data above in memory for the next 24 hours.</p>
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
// renderMarketCharts - Chart.js v4 visual layer for the report.
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

  // Competitor list - prefer the longer top5 when present, fall back to top3.
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

  // PageSpeed - accept either canonical field name.
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
<h2 id="market-charts">Market Intelligence Charts</h2>

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

  // ── CHART 1 - Competitive position matrix ─────────────────────────
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
        // Top-left - Hidden gems (blue)
        ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        ctx.fillStyle = '#2563EB';
        ctx.fillText('Hidden gems', L + 12, T + 18);
        // Top-right - Market leaders (emerald)
        ctx.textAlign = 'right';
        ctx.fillStyle = '#10B981';
        ctx.fillText('Market leaders', R - 12, T + 18);
        // Bottom-left - Needs work (red)
        ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
        ctx.fillStyle = '#EF4444';
        ctx.fillText('Needs work', L + 12, B - 10);
        // Bottom-right - High volume (orange)
        ctx.textAlign = 'right';
        ctx.fillStyle = '#F59E0B';
        ctx.fillText('High volume', R - 12, B - 10);
        ctx.restore();
      }
    };

    // Bubble labels - clean cluster mode. YOU always shows its label
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

        // YOU's label - always rendered, never suppressed.
        meta.data.forEach(function (el, i) {
          var p = points[i]; if (!p || !p.isYou) return;
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.label, el.x, el.y);
        });

        // Cluster detection - a competitor is "clustered" if any
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
        // replaces the default floating tooltip - it never gets
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

  // ── CHART 2 - Rating comparison ──────────────────────────────────
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

  // ── CHART 3 - Review volume ──────────────────────────────────────
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

  // ── CHART 4 - Seasonal demand pattern ────────────────────────────
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

  // ── CHART 5 - PageSpeed gauge ────────────────────────────────────
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

  // ── CHART 6 - Income distribution ────────────────────────────────
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
    var labels = ['Under $35K', '$35K-$75K', '$75K-$150K', 'Over $150K'];
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

  // ── CHART 7 - Building permits trend ─────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────

function renderReport(ctx) {
  const { input, layer0Result, profile, data, redFlags, strengths, ranked, enriched, studies, velocity, reportId } = ctx;

  // BUG 21 - Null-safe competitor data. Upstream code can set
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
  // Audit fix S6 - defensive Array.isArray guard. A profile rec with
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
  //   75 mi    → "Very limited competition - strong market position" (warning)
  //   150 mi   → "No nearby competitors - potential monopoly" (positive)
  function radiusTierNote() {
    const radiusMi = typeof data.search_radius_miles === 'number' ? data.search_radius_miles : null;
    if (radiusMi == null) return '';

    // Step 8 (150 mi) - ladder reached the end. Per spec, surface the
    // monopoly note. Note: the message says "No nearby competitors";
    // technically the ladder may have surfaced 1-4 competitors at 150
    // mi, but the spec wording calls this "potential monopoly in your
    // category in this region" regardless. If the rendered count
    // line below shows a non-zero number, the user has the actual count.
    if (radiusMi >= 150) {
      return `<div class="rec rec-high"><strong>&#9888; No nearby competitors found</strong> - potential monopoly in your category in this region. Nearest matches found within 150 miles.</div>`;
    }
    // Step 7 (75 mi).
    if (radiusMi >= 75) {
      return `<div class="flag">&#9888; Very limited competition - nearest within ${radiusMi} miles. Strong market position in your area.</div>`;
    }
    // Steps 5-6 (30 / 50 mi).
    if (radiusMi >= 30) {
      return `<div class="flag">&#9888; Limited local competition - nearest within ${radiusMi} miles.</div>`;
    }
    // Steps 3-4 (8 / 15 mi) - mild informational note, no warning icon.
    if (radiusMi >= 8) {
      return `<div class="meta" style="margin:8px 0">Nearest competitors within ${radiusMi} miles.</div>`;
    }
    // Steps 1-2 (1 / 3 mi) - healthy dense local market, no callout.
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

  // Subject-business permanently-closed banner. The closed RED FLAG no longer
  // blocks the report (see classifyPipeline); instead we surface a prominent
  // top-of-report notice. SUBJECT business only — nearby-venue/competitor
  // closed-filtering (isOperationalOrUnknown) is unrelated and untouched.
  const closedPermanentlyBanner = (data && data.business_status === 'CLOSED_PERMANENTLY')
    ? `<div style="background:#FEF3C7;border:2px solid #F59E0B;border-radius:8px;padding:20px 24px;margin:0 0 24px 0;font-family:sans-serif;">
  <div style="font-size:18px;font-weight:bold;color:#B45309;margin-bottom:10px;">&#9888; Google lists this business as permanently closed</div>
  <div style="color:#78350F;font-size:14px;line-height:1.6;">
    Heads up: Google currently lists this business as permanently closed. If you are reopening or this is incorrect, update your Google Business Profile so customers can find you. The report below is based on the latest available data.
  </div>
</div>`
    : '';

  // Claude-unavailable banner: shown when enrichWithClaude returned null
  // entirely (no API key / both calls rejected). Distinct from the
  // partial-report case - the data sections (Census, BLS, competitor
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
  // FIX 1 - only fire when we VERIFIED the URL doesn't load (===false).
  // Previously this used loose-falsy `!data.website_exists`, which also
  // matched `null` (the value when the HEAD check itself timed out or
  // crashed). That misfired for businesses like AmericInn Wyndham where
  // a long redirect chain made the HEAD check inconclusive even though
  // the website clearly exists. Tri-state: true=verified, false=verified
  // missing, null=check inconclusive (no banner in the null case).
  const noWebsiteBanner = data.website_exists === false
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
    <a href="mailto:support@growthim.com" style="display:inline-block;padding:10px 24px;background:#C2410C;color:white;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;">&#9993; Contact Support - Get Website Help</a>
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

  // CHANGE 1 - AI-corrected warning only (the "✓ AI verified" green
  // confirmation badge has been removed because it's internal noise
  // for the business owner; they only need to know when Claude
  // actually OVERRODE the original Layer 0 classification). Rendered
  // as a standalone block below the header since the previous inline
  // host (the "Layer 0:" line) has been removed entirely.
  let aiCorrectedWarning = '';
  if (layer0Result.ai_corrected) {
    const orig = escapeHtml(layer0Result.original_naics || '');
    const fixed = escapeHtml(layer0Result.naics6 || '');
    const title = escapeHtml(layer0Result.naics_title || '');
    const reason = escapeHtml((layer0Result.ai_reasoning || '').slice(0, 200));
    // BUG 24 - when Claude flags ai_corrected=true but ends up with the
    // SAME NAICS-6 as the original, the "X → X" rendering is confusing.
    // This happens when Claude's override flag fires for profile-level
    // intent (e.g., berry-patch tagged as restaurant routed by Google
    // types but actually agriculture - same NAICS bucket the
    // selectBestProfile cascade pulls into a different profile_id).
    // Render a distinct "NAICS confirmed, profile re-selected" message
    // in that case so the user sees the audit trail without the
    // misleading "X → X" arrow.
    let badge;
    if (layer0Result.original_naics && layer0Result.naics6
        && String(layer0Result.original_naics) === String(layer0Result.naics6)) {
      badge = `⚠ AI profile-corrected (NAICS ${fixed} confirmed${title ? ' - ' + title : ''})`;
    } else {
      badge = `⚠ AI corrected: ${orig} → ${fixed}${title ? ' (' + title + ')' : ''}`;
    }
    aiCorrectedWarning = `<div style="margin: 8px 0 0;">
  <span style="color:#B45309;background:#FEF3C7;padding:4px 10px;border-radius:4px;font-size:13px;display:inline-block;">${badge}</span>
  ${reason ? `<div style="color:#92400E;font-size:12px;margin-top:6px;">Reason: ${reason}</div>` : ''}
</div>`;
  }

  // CHANGE 1 - header simplified. Removed the entire "Layer 0:
  // <mode> · confidence <X> (places types fallback: ...) (chain: ...)
  // ✓ AI verified" line which exposed internal classification audit
  // detail no business owner cares about. The AI-corrected amber
  // warning above is preserved (renders below the header when Claude
  // actually overrode the original NAICS). fallbackTag and chainTag
  // are still computed earlier for any other consumer; just no
  // longer surfaced in the header copy.
  const headerHtml = `<h1>${escapeHtml(data.name || input)}</h1>
<p class="meta">${escapeHtml(data.formatted_address || '')}<br>
${escapeHtml(profile.name)} - NAICS ${escapeHtml(layer0Result.naics6)}</p>
${aiCorrectedWarning}`;

  const overallHtml = `<div class="status ${statusClass}">${escapeHtml(status.label)}</div>
${status.detail ? `<p class="meta">${escapeHtml(status.detail)}</p>` : ''}`;

  // Phase 5 - LOCAL MARKET CONTEXT callout (when Claude enrichment succeeded)
  // and the "AI insights unavailable" note (when it didn't).
  let localContextHtml = '';
  if (enriched && enriched.local_context) {
    localContextHtml = `<div class="callout local-context" id="market-overview">
<div class="callout-label">LOCAL MARKET CONTEXT</div>
<p>${escapeHtml(enriched.local_context)}</p>
</div>`;
  } else if (!enriched) {
    localContextHtml = `<p class="ai-fallback-note"><small>AI insights unavailable. Showing research-based recommendations.</small></p>`;
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
    strengthsHtml = `<h2 id="strengths">Strengths</h2><ul>${
      strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    }</ul>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Industry survival outlook - BED2013 cohort survival rates for the
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
  // Phase 5+ - TripAdvisor Intelligence (rendered only when TA fetch hit)
  // Position: after Strengths, before Competitive context.
  // Surfaces: rating + review count, ranking, sub-ratings (with gap
  // detection at ≥0.4 spread), awards, trip-type mix, value-vs-overall
  // gap warning (synthetic ta_value_gap_detected bool from the fetcher).
  // ──────────────────────────────────────────────────────────────────
  let tripAdvisorHtml = '';
  if (data.tripadvisor && data.ta_rating != null) {
    const ratingStars = typeof data.ta_rating === 'number' ? data.ta_rating.toFixed(1) : '-';
    const reviewCt = typeof data.ta_review_count === 'number'
      ? data.ta_review_count.toLocaleString('en-US')
      : '-';

    // Ranking line - only when we successfully parsed "#X of Y"
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
      valueGapHtml = `<div class="flag"><strong>Value perception gap:</strong> Your value sub-rating (${typeof v === 'number' ? v.toFixed(1) : '-'})
trails your overall rating (${ratingStars}) by more than 0.4. Customers like the experience but feel they overpaid.
Look at price-to-perceived-quality (portion size, finish quality, included amenities).</div>`;
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

    // Trip types - show top 3 by share so the dominant segments are obvious.
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
<p class="meta"><small>Use to align messaging - promote the segment you want to grow, defend the one you depend on.</small></p>`;
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
  // Phase 5+ - Quality ratings (CMS Hospital Compare)
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
<p><strong>${facility}</strong> - CMS overall rating: <strong>${stars}</strong></p>
${rows ? `<table class="coverage">${rows}</table>` : ''}
<p class="meta"><small>Source: CMS Hospital General Information (national-comparison ratings).</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ - Compliance (FMCSA carrier safety)
  // ──────────────────────────────────────────────────────────────────
  // Renders for transportation/warehousing operators (NAICS-2 = 48-49)
  // when the business name matches a DOT-registered carrier. Surface
  // the safety rating as a flag when it's not "Satisfactory".
  let complianceHtml = '';
  if (data.fmcsa && data.dot_number) {
    const sr = data.safety_rating || '-';
    const srNotSat = data.safety_rating && !/^satisfactory$/i.test(data.safety_rating);
    const srFlag = srNotSat
      ? ` <span class="extra-tag extra-tag-hidden">NOT SATISFACTORY</span>`
      : '';
    const allowed = data.allowed_to_operate || '-';
    const drivers = data.total_drivers != null ? data.total_drivers.toLocaleString('en-US') : '-';
    const trucks = data.total_trucks != null ? data.total_trucks.toLocaleString('en-US') : '-';
    const op = data.fmcsa.carrier_operation || '-';
    complianceHtml = `<h2>Compliance</h2>
<p><strong>FMCSA Safety Rating:</strong> ${escapeHtml(String(sr))}${srFlag}<br>
DOT#: <strong>${escapeHtml(String(data.dot_number))}</strong><br>
Allowed to operate: <strong>${escapeHtml(String(allowed))}</strong><br>
Carrier operation: ${escapeHtml(String(op))}<br>
Total drivers: <strong>${escapeHtml(String(drivers))}</strong> · Total trucks: <strong>${escapeHtml(String(trucks))}</strong></p>
<p class="meta"><small>Source: FMCSA QCMobile carrier services API.</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // BATCH14 - Competitive Context + Location & Market sections
  // (rendered only when the underlying fetches succeeded)
  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ - FDIC bank financial summary (banking / finance profiles).
  // Built up here so it can be appended to competitiveHtml whether or not
  // Google Nearby Search returned competitor data.
  let fdicBlock = '';
  if (data.fdic && (data.fdic_total_deposits != null || data.fdic_total_assets != null)) {
    // FDIC reports DEP / ASSET in $thousands. Convert to $M for display.
    const depM = data.fdic_total_deposits != null
      ? '$' + (data.fdic_total_deposits / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M'
      : '-';
    const assetM = data.fdic_total_assets != null
      ? '$' + (data.fdic_total_assets / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M'
      : '-';
    const bn = data.fdic_bank_name ? escapeHtml(data.fdic_bank_name) : 'this institution';
    fdicBlock = `<p><strong>FDIC profile (${bn}):</strong><br>
Total deposits: <strong>${depM}</strong><br>
Total assets: <strong>${assetM}</strong><br>
<small>Source: FDIC BankFind API (active institutions).</small></p>`;
  }

  let competitiveHtml = '';
  if (typeof data.competitor_count === 'number' && data.competitor_count > 0) {
    const yourRating = typeof data.google_rating === 'number' ? data.google_rating.toFixed(1) : '-';
    const medRating = typeof data.competitor_median_rating === 'number' ? data.competitor_median_rating.toFixed(1) : '-';
    const yourReviews = typeof data.google_review_count === 'number' ? data.google_review_count : '-';
    const medReviews = typeof data.competitor_median_review_count === 'number' ? data.competitor_median_review_count : '-';
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
    // risk - render as a full card), 'winning' (subject is meaningfully
    // outperforming - render as a muted one-liner), or 'neutral'
    // (similar level / insufficient signal - silently dropped from both
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
    // Neutrals are competitors at a similar level - counted so we can
    // surface a friendly "all peers" message when threat+winning are
    // both zero but there ARE competitors in the pool (otherwise the
    // section would show "0 real competitors · 0 you're beating" -
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

    // Tier 1 list - full info per the existing list-item style.
    const threatsHtml = threats.length
      ? `<p class="meta">Real competitors to watch:</p><ul>` + threats.map((c) => {
          const dist = typeof c.distance_meters === 'number'
            ? ` &middot; ${(c.distance_meters / 1609.34).toFixed(1)} mi`
            : (typeof c.distance_miles === 'number' ? ` &middot; ${c.distance_miles.toFixed(1)} mi` : '');
          const rating = typeof c.rating === 'number' ? c.rating.toFixed(1) : '-';
          return `<li><strong>${escapeHtml(c.name)}</strong> - ${rating}&#9733; (${c.review_count || 0} reviews)${dist}</li>`;
        }).join('') + `</ul>`
      : '';

    // Tier 2 list - muted "you're winning" lines (no detailed card).
    const winnersHtml = winners.length
      ? `<div style="margin-top:10px">` + winners.map((c) => {
          const rating = typeof c.rating === 'number' ? c.rating.toFixed(1) : '-';
          return `<p class="meta" style="margin:4px 0;color:var(--muted)">&#10003; You're outperforming <strong>${escapeHtml(c.name)}</strong> (${rating}&#9733;, ${c.review_count || 0} reviews) - no action needed</p>`;
        }).join('') + `</div>`
      : '';

    const reportedRadiusMi = typeof data.search_radius_miles === 'number' ? data.search_radius_miles : 15;
    // CHANGE 2 - competitive context simplified. Stripped the
    // radius-tier note ("Nearest competitors within 8 miles"), the
    // tier summary ("1 real competitor to watch · 1 you're beating"),
    // the threats list ("Real competitors to watch: Silver Star B&B..."),
    // and the winners list ("✓ You're outperforming Super 8..."). All
    // of that detail already appears, more usefully, in the dedicated
    // Competitor Comparison and Competitor Deep Dive sections later
    // in the report. Three lines remain: same-type count, your rating
    // vs local median, and your reviews vs local median.
    competitiveHtml = `<h2 id="competitor-analysis">Competitive context</h2>
<p>${data.competitor_count} same-type competitors within ${reportedRadiusMi} miles.<br>
Your rating: <strong>${yourRating}</strong> vs local median: <strong>${medRating}</strong>${ratingFlag}<br>
Your reviews: <strong>${yourReviews}</strong> vs local median: <strong>${medReviews}</strong>${reviewFlag}</p>
${fdicBlock}`;
  } else if (fdicBlock) {
    // Bank/finance with no Google competitors but FDIC data - still
    // render the section so the FDIC block has a home.
    competitiveHtml = `<h2 id="competitor-analysis">Competitive context</h2>${fdicBlock}`;
  }

  // Competitor comparison block (formerly Phase 5+) removed entirely
  // from the report per request. The Claude-enriched analysis it
  // produced (what they do better / what you can win / summary)
  // duplicated content already surfaced - better and more
  // narratively - in the Competitor Deep Dive section below. The
  // upstream enriched.competitor_analysis field is still generated
  // by claudeEnricher; it's just no longer rendered here.

  let marketHtml = '';
  // Phase 5+ - section also renders if USDA agriculture profile or HUD
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

    // Phase 5+ - anchor tenants + transit (Overpass / OpenStreetMap)
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
      transitBlock = `<p><small>No bus stop or rail station found within 800m. Car-dependent location.</small></p>`;
    }

    // Phase 5+ - HUD residential building permits (Census BPS data)
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
      permitsBlock = `<p><strong>${cty}construction activity (${escapeHtml(data.building_permits_year)}):</strong> ${data.building_permits_total} total residential permits${sf}, ${trendWord}<br>
<small>Source: U.S. Census Building Permits Survey via HUD (county FIPS ${escapeHtml(data.county_fips || '-')}).</small></p>`;
    }

    // Phase 5+ - USDA NASS agriculture profile (NAICS-2 = 11 only)
    let usdaBlock = '';
    if (data.usda_nass && data.top_commodity) {
      usdaBlock = `<p><strong>Dominant crop:</strong> ${escapeHtml(data.top_commodity)}<br>
<small>${escapeHtml(data.state_ag_profile || '')}</small><br>
<small>Source: USDA NASS QuickStats (2022, AREA HARVESTED).</small></p>`;
    }

    // Phase 5+ - HUD Fair Market Rents (NAICS-2 = 53 only)
    let fmrBlock = '';
    if (data.hud_fmr && (data.fmr_studio != null || data.fmr_1br != null || data.fmr_2br != null)) {
      const studio = data.fmr_studio != null ? '$' + data.fmr_studio.toLocaleString('en-US') : '-';
      const oneBr = data.fmr_1br != null ? '$' + data.fmr_1br.toLocaleString('en-US') : '-';
      const twoBr = data.fmr_2br != null ? '$' + data.fmr_2br.toLocaleString('en-US') : '-';
      const metro = data.fmr_metro_name ? escapeHtml(data.fmr_metro_name) : 'this metro';
      const yr = data.fmr_year ? escapeHtml(String(data.fmr_year)) : '-';
      fmrBlock = `<p><strong>Fair Market Rents (${metro}, ${yr}):</strong><br>
Studio: <strong>${studio}/mo</strong><br>
1BR: <strong>${oneBr}/mo</strong><br>
2BR: <strong>${twoBr}/mo</strong><br>
<small>Source: HUD User FMR API.</small></p>`;
    }

    marketHtml = `<h2 id="location-market">Location &amp; market</h2>
<p>Area median household income: <strong>${escapeHtml(income)}</strong><br>
Local population (${data.population_source === 'city' ? `City of ${escapeHtml(data.city || '')}` : `ZIP ${escapeHtml(data.census_zip || '')}`}): <strong>${escapeHtml(pop)}</strong>${hhLine}</p>
<p class="meta">Source: U.S. Census Bureau ACS 5-Year Estimates (2018-2022) - study S037.</p>
${anchorBlock}
${transitBlock}
${permitsBlock}
${usdaBlock}
${fmrBlock}`;
  }

  // Operations / brand line - quick visibility on the smaller new signals
  const opsBits = [];
  if (data.hours_complete === true) opsBits.push('hours fully listed (7 days)');
  else if (data.hours_complete === false) opsBits.push('hours incomplete');
  if (data.is_open_now === true) opsBits.push('open now');
  else if (data.is_open_now === false) opsBits.push('closed now');
  if (data.website_exists === true) opsBits.push('website loads');
  else if (data.website_exists === false) opsBits.push('website returned error');
  else if (data.website_url && data.website_exists == null) opsBits.push('website check inconclusive');
  if (data.website_url == null) opsBits.push('no website on Google Business Profile');
  // FIX 4 - owner-response rate display logic. Google's legacy Places
  // Details API frequently omits the owner-reply field even when the
  // owner DID reply on the live GBP. With a sample of only 5 reviews
  // (the legacy max), a "0%" reading is much more often a measurement
  // gap than a real signal - show "insufficient data" instead.
  if (typeof data.response_rate_estimated === 'number') {
    const sampleSize = typeof data.reviews_sampled === 'number' ? data.reviews_sampled : 0;
    if (data.response_rate_estimated === 0 && sampleSize <= 5) {
      opsBits.push(`owner-response rate: insufficient data (sampled ${sampleSize} review${sampleSize === 1 ? '' : 's'} only)`);
    } else if (data.response_rate_estimated === 0) {
      opsBits.push(`owner-response rate: 0%, no responses detected (sample: ${sampleSize})`);
    } else {
      opsBits.push(`owner-response rate (sample of ${sampleSize}): ${(data.response_rate_estimated * 100).toFixed(0)}%`);
    }
  }
  if (typeof data.load_time_seconds === 'number') {
    const flag = data.load_time_seconds > 3
      ? '⚠️ above 3-second abandonment threshold (S040)'
      : '✅ fast';
    opsBits.push(`load time: ${data.load_time_seconds}s ${flag}`);
  }
  // Phase 5+ - NPI license status (healthcare profiles only).
  if (data.npi) {
    const status = data.npi_authorized ? 'NPI Active ✅' : `NPI ${data.npi_status || '-'} ⚠️`;
    const num = data.npi_number ? ` (NPI ${escapeHtml(String(data.npi_number))})` : '';
    const ptype = data.provider_type ? ` · ${escapeHtml(String(data.provider_type))}` : '';
    opsBits.push(`${status}${num}${ptype}`);
  }
  const opsHtml = opsBits.length
    ? `<h2 id="operations-brand">Operations &amp; brand</h2><p>${opsBits.map(escapeHtml).join(' · ')}</p>`
    : '';

  // FIX 3 - PageSpeed full section: warning callout + subject score card + competitor table.
  // Structure:
  //   (1) Yellow 53%-abandonment stat callout - always shown when section renders
  //   (2a) Subject has no website → red callout (absorbs old noWebsiteHtml)
  //   (2b) Subject has website + score → large score card
  //   (2c) Subject has website but PSI timed out → skipped (table still shown)
  //   (3) Competitor speed table (shown when competitors_top5_pagespeed is populated)
  // Score thresholds: ≥90 → green "Fast ✅" | 50-89 → amber "Needs work ⚠️" | <50 → red "Slow ❌"
  let pagespeedDisplayHtml = '';
  {
    const psBgColor = (s) => s >= 90 ? '#16A34A' : s >= 50 ? '#D97706' : '#DC2626';
    const psLabelStr = (s) => s >= 90 ? 'Fast ✅' : s >= 50 ? 'Needs work ⚠️' : 'Slow ❌';

    // (1) Warning callout
    const warningHtml = `<div style="margin-bottom:16px;padding:12px 16px;background:#FFFBEB;border-left:3px solid #F59E0B;border-radius:0 6px 6px 0;font-size:13px;color:#92400E;line-height:1.6;">53% of mobile visitors abandon a website that takes more than 3 seconds to load. They do not come back. Your competitor's website speed is shown below - every second faster than you means customers who found you on Google chose them instead before reading a single word about your business. <span style="font-size:11px;opacity:0.75;">Source: Google/SOASTA Research (S040)</span></div>`;

    // (2) Subject section
    const bizName = escapeHtml(data.name || data.business_name || 'Your Business');
    let subjectHtml = '';
    if (data.website_url == null) {
      // No website at all - card with psychology line + existing callout
      subjectHtml = `<div style="margin-bottom:16px;padding:14px 16px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;">` +
        `<div style="font-size:14px;font-weight:700;color:#991B1B;margin-bottom:10px;">${bizName}</div>` +
        `<div style="font-size:13px;color:#7F1D1D;line-height:1.6;margin-bottom:10px;">Most customers decide whether to visit a business within 3 seconds of landing on their website. Without a website ${bizName} has zero seconds to make that impression - the decision is made before they even see you.</div>` +
        `<strong style="display:block;font-size:14px;color:#991B1B;margin-bottom:6px;">&#9888; No website to measure</strong>` +
        `<div style="font-size:13px;color:#7F1D1D;line-height:1.6;">There is no page for Google to score. While your competitors' load times are shown below, you have no starting point to improve from. Customers who find your competitors on Google can click through to their website immediately. 53% abandon a slow site before reading a single word. Without a website you lose 100% of those potential visits before they start. GrowthIM can build and host a fast, high-scoring website for you - contact <a href="mailto:support@growthim.com" style="color:#DC2626;">support@growthim.com</a></div>` +
        `</div>`;
    } else if (typeof data.website_mobile_score === 'number') {
      // Has website + PSI score → large score card with business name
      const sc = data.website_mobile_score;
      const sColor = psBgColor(sc);
      const sLabel = psLabelStr(sc);
      const loadTimeLine = typeof data.load_time_seconds === 'number'
        ? `<div style="font-size:12px;color:#6B7280;margin-top:3px;">Load time: <strong>${data.load_time_seconds.toFixed(1)}s</strong></div>`
        : '';
      let warningMsg = '';
      if (sc < 50) {
        warningMsg = `<div style="margin-top:12px;padding:10px 14px;background:#FEF2F2;border-left:3px solid #EF4444;border-radius:0 6px 6px 0;font-size:12.5px;color:#7F1D1D;line-height:1.6;">Your website is critically slow. You are losing most visitors before they see anything about your business. A 1-second improvement increases conversions by 27% on average. GrowthIM can fix this fast - contact <a href="mailto:support@growthim.com" style="color:#DC2626;">support@growthim.com</a></div>`;
      } else if (sc < 90) {
        warningMsg = `<div style="margin-top:12px;padding:10px 14px;background:#FFFBEB;border-left:3px solid #F59E0B;border-radius:0 6px 6px 0;font-size:12.5px;color:#92400E;line-height:1.6;">Your website loads in the amber zone. More than half your mobile visitors are likely leaving before reading a single word. Every second faster doubles your chance of keeping them. GrowthIM can help improve your score - contact <a href="mailto:support@growthim.com" style="color:#92400E;">support@growthim.com</a></div>`;
      }
      subjectHtml = `<div style="margin-bottom:16px;padding:14px 16px;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:8px;">` +
        `<div style="font-size:14px;font-weight:700;color:#374151;margin-bottom:10px;">${bizName}</div>` +
        `<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">` +
        `<div style="font-size:48px;font-weight:800;color:${sColor};line-height:1;">${sc}<span style="font-size:18px;font-weight:600;color:#9CA3AF;">/100</span></div>` +
        `<div><div style="font-size:16px;font-weight:700;color:${sColor};">${escapeHtml(sLabel)}</div>` +
        `<div style="font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Mobile PageSpeed Score</div>` +
        `${loadTimeLine}</div>` +
        `<div style="flex:1;min-width:180px;font-size:12px;color:#9CA3AF;line-height:1.5;">Real-time data verified by Google PageSpeed Insights.</div>` +
        `</div>${warningMsg}</div>`;
    } else {
      // Has website but PSI timed out or returned no score — show a neutral fallback card
      subjectHtml = `<div style="margin-bottom:16px;padding:14px 16px;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:8px;">` +
        `<div style="font-size:14px;font-weight:700;color:#374151;margin-bottom:10px;">${bizName}</div>` +
        `<div style="display:flex;align-items:center;gap:12px;">` +
        `<div style="font-size:13px;color:#6B7280;line-height:1.6;">` +
        `Website speed score unavailable — Google's scoring service timed out while measuring your site. ` +
        `This sometimes happens with large or complex websites. Your competitors' scores are shown below for comparison.` +
        `</div></div></div>`;
    }

    // (3) Competitor speed table
    const compPsList = Array.isArray(data.competitors_top5_pagespeed) ? data.competitors_top5_pagespeed : [];
    let compTableHtml = '';
    if (compPsList.length > 0) {
      const rows = compPsList.map((c) => {
        let scoreCell;
        if (typeof c.mobile_score === 'number') {
          const cc         = psBgColor(c.mobile_score);
          const speedLabel = psLabelStr(c.mobile_score);
          const sourceNote = c.source === 'crux'
            ? 'Real-user · Chrome UX Report'
            : 'Real-time · Google PageSpeed';
          scoreCell = `<td style="padding:8px 12px;text-align:center;vertical-align:middle;"><span style="font-size:20px;font-weight:800;color:${cc};">${c.mobile_score}</span><br><span style="font-size:11px;font-weight:600;color:${cc};">${escapeHtml(speedLabel)}</span><br><span style="font-size:10px;color:#9CA3AF;">${sourceNote}</span></td>`;
        } else if (c.website) {
          scoreCell = `<td style="padding:8px 12px;text-align:center;vertical-align:middle;"><div style="font-size:13px;font-weight:600;color:#9CA3AF;">Protected</div><div style="font-size:10px;color:#D1D5DB;margin-top:2px;">Bot shield active</div></td>`;
        } else {
          scoreCell = `<td style="padding:8px 12px;text-align:center;font-size:12px;color:#9CA3AF;vertical-align:middle;">No website</td>`;
        }
        // FIX 2: load time column
        const loadTimeCell = typeof c.load_time_seconds === 'number'
          ? `<td style="padding:8px 12px;text-align:center;font-size:13px;color:#374151;vertical-align:middle;">${c.load_time_seconds.toFixed(1)}s</td>`
          : `<td style="padding:8px 12px;text-align:center;font-size:12px;color:#9CA3AF;vertical-align:middle;">-</td>`;
        return `<tr style="border-top:1px solid #F3F4F6;"><td style="padding:8px 12px;font-size:13px;color:#374151;vertical-align:middle;">${escapeHtml(c.name || '')}</td>${scoreCell}${loadTimeCell}</tr>`;
      }).join('');
      compTableHtml = `<table style="width:100%;border-collapse:collapse;"><thead><tr style="background:#F9FAFB;"><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Business</th><th style="padding:8px 12px;text-align:center;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Mobile Speed</th><th style="padding:8px 12px;text-align:center;font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Load Time</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    if (subjectHtml || compTableHtml) {
      pagespeedDisplayHtml = `<div style="margin-top:16px;">${warningHtml}${subjectHtml}${compTableHtml}</div>`;
    }
  }

  // FIX 2 - Photo count note. Shows whenever photo_count is present on
  // the data object (always fetched via getDetails). The BrightLocal 2023
  // stat is a proven conversion motivator - surfaces next to the raw count
  // so the user has context, not just a bare number.
  let photoStatHtml = '';
  if (typeof data.photo_count === 'number') {
    const photoMsg = data.photo_count < 10
      ? `You currently have <strong>${data.photo_count} photo${data.photo_count === 1 ? '' : 's'}</strong>. Businesses with 100+ photos receive 520% more calls.`
      : data.photo_count < 100
      ? `You have <strong>${data.photo_count} photos</strong>. Businesses with 100+ photos receive 520% more calls than those with fewer than 10.`
      : `You have <strong>${data.photo_count} photos</strong>, well above the 100-photo threshold that drives 520% more calls.`;
    photoStatHtml = `<div style="margin-top:10px;padding:12px 16px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;display:flex;gap:10px;align-items:flex-start;font-size:13px;">
  <span style="font-size:18px;line-height:1.4;">&#128248;</span>
  <div>
    <div style="color:#374151;line-height:1.55;">${photoMsg}</div>
    <div style="font-size:11px;color:#6B7280;margin-top:4px;">Source: BrightLocal 2023</div>
  </div>
</div>`;
  }

  // Phase 5+ - Demand & seasonality (Open-Meteo + Ticketmaster + BLS)
  let demandHtml = '';
  const seasonalityLines = [];
  if (data.peak_tourist_season) {
    seasonalityLines.push(`<strong>Peak season:</strong> ${escapeHtml(data.peak_tourist_season)}`);
  }
  if (data.has_cold_winter === true) {
    seasonalityLines.push('<strong>Cold winter market</strong> - plan an off-season strategy (one or more months average below 35°F).');
  }
  if (data.has_hot_summer === true) {
    seasonalityLines.push('<strong>Hot summer market</strong> - peak demand May-September (one or more months average above 85°F).');
  }
  // Phase 5+ - BLS sector employment level (only fires for the 5 wired
  // NAICS-2 sectors: 23, 44-45, 54, 61, 62).
  if (typeof data.bls_employment_level === 'number') {
    const periodPart = data.bls_employment_period ? `${escapeHtml(data.bls_employment_period)} ` : '';
    const yearPart = data.bls_employment_year ? escapeHtml(String(data.bls_employment_year)) : '';
    seasonalityLines.push(`<strong>U.S. sector employment:</strong> ${data.bls_employment_level.toLocaleString('en-US')} jobs (${periodPart}${yearPart}). <small>Source: BLS Public Data API.</small>`);
  }
  const events = Array.isArray(data.upcoming_events) ? data.upcoming_events : [];
  let eventsBlock = '';
  if (events.length) {
    const items = events.map((e) => {
      const venue = e.venue ? ` at ${escapeHtml(e.venue)}` : '';
      const when = e.date ? escapeHtml(e.date.replace('T', ' ').slice(0, 16)) : 'date TBA';
      return `<li>${escapeHtml(e.name)} - ${when}${venue}</li>`;
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

  // BATCH16 - top-10 ranking with impact labels.
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
    // Path (a) - Claude priority_actions present.
    const total = claudePriorityActions.length;
    const highCount = claudePriorityActions.filter((a) => String(a.impact || '').toUpperCase() === 'HIGH').length;
    const headerNote = highCount > 0
      ? `Of these ${total} actions, ${highCount} ${highCount === 1 ? 'is' : 'are'} HIGH IMPACT. AI-tagged actions are generated from your real business data.`
      : `${total} prioritized actions, generated from your real business data. None tagged HIGH IMPACT. Focus on the highest-ranked items first.`;
    priorityHtml = `<div style="margin-bottom: 16px;">
  <h2 id="priority-actions">Priority actions</h2>
  <p style="font-size: 13px; color: #6B7280; margin: 4px 0 0 0;">${escapeHtml(headerNote)}</p>
</div>`;
    // FIX 6 - Action cards first (HIGH then MEDIUM then LOW), ROI
    // summary table last so the reader sees the full context before
    // the combined total.
    priorityHtml += claudePriorityActions.map((a) => renderActionCard(a)).join('');
    priorityHtml += renderROISummary(claudePriorityActions);
  } else if (!top10.length) {
    // Path (b) - empty fallback.
    priorityHtml = `<h2 id="priority-actions">Priority actions</h2>`;
    priorityHtml += `<p>No recommendations triggered for this business.</p>`;
  } else {
    priorityHtml = `<h2 id="priority-actions">Priority actions</h2>`;
    const total = top10.length;
    const high = ranked.highImpactCount || 0;
    const summary = high > 0
      ? `Of these ${total} actions, focus on the ${high} HIGH IMPACT item${high === 1 ? '' : 's'} first. Lower-impact items are worth doing once the high-impact ones are handled.`
      : `Of these ${total} actions, none are HIGH IMPACT. This business is healthy on the dimensions we measure. Lower-impact polish wins are listed in priority order.`;
    priorityHtml += `<p class="meta">${escapeHtml(summary)}</p>`;
    // CHANGE 3 - classify each top-10 rec as HIDDEN / KNOWN / normal
    // and re-sort: HIDDEN at top regardless of score, KNOWN at bottom
    // with score capped at 0.30.
    classifyKnownHidden(top10, data);
    // CHANGE 6 - attach money estimate HTML where it qualifies.
    for (const t of top10) {
      t.moneyEstimateHtml = buildMoneyEstimate(t, data, profile, studies);
    }
    // Phase 5 - index Claude's enriched recs by id so the first 3 entries
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
        tags.push({ cls: 'hidden', label: 'HIDDEN ISSUE - unique to your business' });
      } else if (t.classification === 'known') {
        tags.push({ cls: 'known', label: 'KNOWN ISSUE - common in your market' });
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
  // FIX 4 - pass data so renderCompetitorDeepDive can prepend real
  // competitor reviews from data.competitors_top5[0].reviews[].
  const competitorDeepDiveHtml = enriched
    ? renderCompetitorDeepDive(enriched.competitor_deep_dive, enriched.outperformed_competitors, data)
    : '';
  // Anchor Score - Walk-Up Traffic Potential panel based on existing
  // location_signals + nearby_venues data. Always renders (shows a
  // "data not available" notice when location_signals is missing).
  const anchorScoreHtml = renderAnchorScore(data);
  // Competitive map - Google Maps Embed iframe centered on the business,
  // searching for the same business type nearby. Falls back to '' when
  // lat/lon or API key is absent.
  const mapHtml = renderCompetitiveMap(data, profile);
  // Trust section - verification-context block shown between the
  // overall status pill and the table of contents. Always renders;
  // no data dependencies.
  // Review Gap Analysis - 4-part section showing the bar comparison vs.
  // the highest-reviewed competitor, the catch-up calculator table, a
  // realistic target, and (when ctx.velocity is supplied by the route
  // handler) the real velocity vs. the user's previous report. Uses
  // only existing data fields; zero new API calls. Returns '' when
  // google_review_count is missing so the section is silently omitted.
  const reviewGapHtml = renderReviewGap(data, velocity);
  // Google Ranking Estimate - sorts you + competitors by
  // rating * log10(reviews + 1) and shows where you land in the list.
  // Pure render function over data.competitors_top5; no new API calls.
  const rankingEstimateHtml = renderRankingEstimate(data, profile);
  // Hours Comparison - your weekday_text vs. each competitor's
  // weekday_text (when present). Shows a compact day-by-day table plus
  // gap-analysis insights. Falls back to "competitor hours not
  // available" when competitor weekday_text is absent.
  const hoursComparisonHtml = renderHoursComparison(data);
  // Seasonal Calendar - 12-month demand bars built from existing
  // climate + season signals (peak_month, has_cold_winter,
  // has_hot_summer, peak_tourist_season, upcoming_events). Pure render
  // over data; no new API calls.
  const seasonalCalendarHtml = renderSeasonalCalendar(data);
  const keyRisksHtml = enriched
    ? renderKeyRisks(enriched.key_risks)
    : '';
  const executionTemplatesHtml = enriched
    ? renderExecutionTemplates(enriched.execution_templates)
    : '';

  // BATCH16 - Common Problems Detected (review-mined themes)
  // BUG 20 - Defensive `|| []` at call site. The function already
  // null-guards internally (returns {skip:true, reason:'no-reviews'}
  // for non-array / empty input), but passing `[]` here makes intent
  // explicit and matches the analyzeCommonProblems contract for any
  // future callers who don't read the function body first.
  const cpAnalysis = analyzeCommonProblems(data.sample_reviews || [], profile.id);
  const commonProblemsHtml = renderCommonProblems(cpAnalysis);

  // ── FIX 3 - 90-day action plan ────────────────────────────────────
  // Renders when Claude enrichment returned a ninety_day_plan object.
  // Three cards (month 1 = blue, month 2 = amber, month 3 = green).
  // Month 1 has weekly granularity; months 2-3 have month-level focus.
  // Section is omitted entirely when enriched.ninety_day_plan is missing
  // - preserves backwards compat with reports that pre-date this fix.
  let ninetyDayPlanHtml = '';
  if (enriched && enriched.ninety_day_plan && typeof enriched.ninety_day_plan === 'object') {
    const plan = enriched.ninety_day_plan;
    const m1 = plan.month_1 || {};
    const m2 = plan.month_2 || {};
    const m3 = plan.month_3 || {};
    // Helper - render any month card identically (theme + 4 weeks + goal).
    // Falls back to the legacy `focus` paragraph only when no week_N
    // fields are present, so old reports persisted before this fix
    // still render gracefully instead of looking empty.
    function renderMonthCard(monthNum, m, cls) {
      if (!m || typeof m !== 'object') return '';
      const hasWeeks = !!(m.week_1 || m.week_2 || m.week_3 || m.week_4);
      const weeksHtml = hasWeeks
        ? [
            m.week_1 ? `<p><strong>Week 1:</strong> ${escapeHtml(m.week_1)}</p>` : '',
            m.week_2 ? `<p><strong>Week 2:</strong> ${escapeHtml(m.week_2)}</p>` : '',
            m.week_3 ? `<p><strong>Week 3:</strong> ${escapeHtml(m.week_3)}</p>` : '',
            m.week_4 ? `<p><strong>Week 4:</strong> ${escapeHtml(m.week_4)}</p>` : '',
          ].join('')
        : (m.focus ? `<p><strong>Focus:</strong> ${escapeHtml(m.focus)}</p>` : '');
      return `<div class="rec ${cls}">
<h3>Month ${monthNum}${m.theme ? ` - ${escapeHtml(m.theme)}` : ''}</h3>
${weeksHtml}
${m.goal ? `<p class="meta"><strong>Goal:</strong> ${escapeHtml(m.goal)}</p>` : ''}
</div>`;
    }
    const m1Html = renderMonthCard(1, m1, 'rec-medium');
    const m2Html = renderMonthCard(2, m2, 'rec-low');
    const m3Html = renderMonthCard(3, m3, 'rec-high');
    ninetyDayPlanHtml = `<h2 id="ninety-day-plan">90-day action plan <span class="ai-badge">AI</span></h2>
<p class="meta">Three months of progressive depth, broken down week by week so you know exactly what to do each Monday.</p>
${m1Html}
${m2Html}
${m3Html}`;
  }

  // ── FIX 6 - Seasonal strategy ─────────────────────────────────────
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
<h3>${title}${s.dominant_persona ? ` <span class="meta"> ${escapeHtml(s.dominant_persona)}</span>` : ''}</h3>
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

  // Phase 5 - OPPORTUNITIES NOBODY IN YOUR MARKET IS DOING
  // (only renders when Claude enrichment succeeded and produced opportunities)
  let opportunitiesHtml = '';
  if (enriched && Array.isArray(enriched.opportunities) && enriched.opportunities.length) {
    opportunitiesHtml = `<h2 id="opportunities">Opportunities nobody in your market is doing</h2>
<p class="meta">${enriched.opportunities.length} location-specific ideas drawn from 18 opportunity categories. Each names real local entities: events, producers, landmarks. Validate cost and revenue against your own pipeline before committing budget.</p>` +
    enriched.opportunities.map((o) => {
      const novelty = o.novelty || '';
      const noveltyCls = /zero competitors|0 competitors/i.test(novelty)
        ? 'novelty-unique'
        : /rare/i.test(novelty)
        ? 'novelty-rare'
        : 'novelty-common';
      // psychology_deep (C2) preferred; falls back to legacy psychology string.
      let psychologyBlock = '';
      const oDeep = o.psychology_deep;
      if (oDeep && typeof oDeep === 'object') {
        const opf = (label, val, bg, fg) => {
          if (!val || typeof val !== 'string' || !val.trim()) return '';
          return `<div><span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;background:${bg};color:${fg};">${label}</span><span style="font-size:13px;color:#374151;line-height:1.7;margin:0;display:block;">${escapeHtml(val.trim())}</span></div>`;
        };
        const divider = '<hr style="border:none;border-top:1px solid #E5E7EB;margin:12px 0;">';
        const deepRows = [
          opf('MEMORY TRIGGER',       oDeep.memory_trigger,       '#EDE9FE', '#5B21B6'),
          opf('WORD OF MOUTH',        oDeep.word_of_mouth,        '#DBEAFE', '#1E40AF'),
          opf('REVENUE DRIVER',       oDeep.revenue_driver,       '#DCFCE7', '#166534'),
          opf('WHY THIS WORKS HERE',  oDeep.local_logic,          '#FEF3C7', '#92400E'),
          opf('COMPETITOR GAP',       oDeep.competitor_gap,       '#FFE4E6', '#9F1239'),
          opf('ROI',                  oDeep.roi_proof,            '#DCFCE7', '#166534'),
          opf('WHY NOT ALTERNATIVES', oDeep.why_not_alternatives, '#F3F4F6', '#374151'),
          opf('NEXT 48 HOURS',        oDeep.first_48_hours,       '#FFF7ED', '#C2410C'),
          opf('LEAVE BEHIND',         oDeep.leave_behind,         '#EDE9FE', '#5B21B6'),
        ].filter(Boolean);
        if (deepRows.length > 0) {
          psychologyBlock = `<div style="margin-top:16px;padding:16px;background:#FAFAFA;border-left:3px solid #6366F1;border-radius:0 8px 8px 0;"><span style="font-size:11px;font-weight:700;color:#6366F1;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:14px;display:block;">Why this works</span>${deepRows.join(divider)}</div>`;
        }
      }
      return `<div class="opportunity">
<div class="op-meta"><span class="op-category">${escapeHtml(o.category || '-')}</span><span class="op-novelty ${noveltyCls}">${escapeHtml(novelty)}</span></div>
<h3>${escapeHtml(o.title || '')}</h3>
<p>${escapeHtml(o.idea || '')}</p>
<p class="meta">
<strong>Cost:</strong> ${escapeHtml(o.cost || '-')} ·
<strong>Revenue potential:</strong> ${escapeHtml(o.revenue_potential || '-')} ·
<strong>Review-mention probability:</strong> ${escapeHtml(o.review_mention_probability || '-')}
</p>
${psychologyBlock}
</div>`;
    }).join('');
  }

  // ───── BATCH14 - Category coverage footer (C1-C7 with actual values) ─────
  const fmt = (v) => (v == null || (typeof v === 'number' && Number.isNaN(v))) ? 'unmeasured' : String(v);
  const c1Items = [];
  if (typeof data.google_rating === 'number') c1Items.push(`rating ${data.google_rating.toFixed(1)}`);
  if (typeof data.google_review_count === 'number') c1Items.push(`${data.google_review_count} reviews`);
  if (typeof data.review_recency_days === 'number') c1Items.push(`recency ${data.review_recency_days}d`);
  // FIX 4 - gate on sample size (same logic as the Ops & brand block).
  if (typeof data.response_rate_estimated === 'number') {
    const _ss = typeof data.reviews_sampled === 'number' ? data.reviews_sampled : 0;
    if (data.response_rate_estimated === 0 && _ss <= 5) {
      c1Items.push(`owner-response insufficient data (sample ${_ss})`);
    } else {
      c1Items.push(`owner-response ${(data.response_rate_estimated * 100).toFixed(0)}% (sample ${_ss})`);
    }
  }
  // Phase 5+ - TripAdvisor presence
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
  if (typeof data.total_population === 'number') c2Items.push(`pop ${data.total_population.toLocaleString('en-US')} (${data.population_source === 'city' ? `city of ${data.city || data.census_zip || '-'}` : `ZIP ${data.census_zip || '-'}`})`);
  if (typeof data.average_household_size === 'number') c2Items.push(`avg household ${data.average_household_size.toFixed(2)}`);
  // Phase 5+ - anchor tenants + transit (Overpass)
  if (typeof data.anchor_tenant_count === 'number' && data.anchor_tenant_count > 0) {
    c2Items.push(`${data.anchor_tenant_count} anchor tenant${data.anchor_tenant_count === 1 ? '' : 's'} within 500m`);
  } else if (data.anchor_tenant_count === 0) {
    c2Items.push('no anchor tenants within 500m');
  }
  if (data.has_transit_nearby === true) c2Items.push('transit ≤400m');
  else if (data.has_transit_nearby === false) c2Items.push('no transit within 800m');
  // Phase 5+ - county building permits (HUD/Census BPS)
  if (typeof data.building_permits_total === 'number' && data.building_permits_year) {
    const yoy = data.building_permits_yoy_change != null
      ? ` (${data.building_permits_yoy_change >= 0 ? '+' : ''}${data.building_permits_yoy_change}% YoY)`
      : '';
    c2Items.push(`${data.building_permits_total} county permits ${data.building_permits_year}${yoy}`);
  }
  // Phase 5+ - USDA NASS top crop (agriculture only)
  if (data.top_commodity) {
    c2Items.push(`top crop: ${data.top_commodity.toLowerCase()}`);
  }
  // Phase 5+ - HUD Fair Market Rents (real-estate only)
  if (typeof data.fmr_2br === 'number') {
    c2Items.push(`FMR 2BR: $${data.fmr_2br.toLocaleString('en-US')}/mo${data.fmr_metro_name ? ` (${data.fmr_metro_name})` : ''}`);
  }
  const c2Line = c2Items.length ? c2Items.join(', ') : 'data pending';

  const c3Items = [];
  if (typeof data.competitor_count === 'number') c3Items.push(`${data.competitor_count} competitors within 5 mi`);
  if (typeof data.competitor_median_rating === 'number') c3Items.push(`median ${data.competitor_median_rating.toFixed(1)}★`);
  if (typeof data.competitor_median_review_count === 'number') c3Items.push(`median ${Math.round(data.competitor_median_review_count)} reviews`);
  // Phase 5+ - FDIC bank deposit ranking (banking / finance only)
  if (typeof data.fdic_total_deposits === 'number') {
    const depM = (data.fdic_total_deposits / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 });
    c3Items.push(`FDIC deposits: $${depM}M`);
  }
  const c3Line = c3Items.length ? c3Items.join(', ') : 'data pending';

  // Phase 5+ - Open-Meteo climatology + Ticketmaster + BLS fill C4 Demand
  const c4Items = [];
  if (data.peak_tourist_season) c4Items.push(`peak season ${data.peak_tourist_season}`);
  if (data.has_cold_winter === true) c4Items.push('cold winter');
  if (data.has_hot_summer === true) c4Items.push('hot summer');
  const eventCount = Array.isArray(data.upcoming_events) ? data.upcoming_events.length : 0;
  if (eventCount > 0) c4Items.push(`${eventCount} upcoming event${eventCount === 1 ? '' : 's'} within 10km`);
  // Phase 5+ - BLS sector-wide employment level (5 sectors only)
  if (typeof data.bls_employment_level === 'number') {
    c4Items.push(`sector employment ${data.bls_employment_level.toLocaleString('en-US')} (${data.bls_employment_period || ''} ${data.bls_employment_year || ''})`);
  }
  const c4Line = c4Items.length
    ? c4Items.join(', ') + ' - Open-Meteo climatology + Ticketmaster Discovery v2 + BLS'
    : 'data pending (Google Trends + local events)';

  const c5Items = [];
  c5Items.push(data.hours_complete === true ? 'hours: complete (7 days)' : data.hours_complete === false ? 'hours: incomplete' : 'hours: unmeasured');
  c5Items.push(data.website_exists === true ? 'website: loads' : data.website_exists === false ? 'website: not loading / blocked' : (data.website_url ? 'website: check inconclusive' : 'website: not listed on GBP'));
  if (data.is_open_now === true) c5Items.push('open now');
  else if (data.is_open_now === false) c5Items.push('closed now');
  const c5Line = c5Items.join(', ');

  // Phase 5+ - PageSpeed Insights fills C6 Brand
  const c6Items = [];
  if (typeof data.website_mobile_score === 'number') c6Items.push(`mobile score ${data.website_mobile_score}/100`);
  if (typeof data.load_time_seconds === 'number') c6Items.push(`load ${data.load_time_seconds}s`);
  if (typeof data.lcp_seconds === 'number') c6Items.push(`LCP ${data.lcp_seconds}s`);
  const c6Line = c6Items.length
    ? c6Items.join(', ') + ' - Google PageSpeed Insights (mobile)'
    : 'data pending (no website to measure, or PSI failed/timed out)';

  const c7Items = [];
  if (Array.isArray(profile.compliance_notes) && profile.compliance_notes.length) {
    c7Items.push(`${profile.compliance_notes.length} sector compliance note${profile.compliance_notes.length === 1 ? '' : 's'} applied`);
  }
  if (typeof data.google_review_count === 'number' && data.google_review_count === 0) c7Items.push('zero-reviews flag fires');
  if (data.business_status && data.business_status !== 'OPERATIONAL') c7Items.push(`business_status: ${data.business_status}`);
  // Phase 5+ - sector compliance signals
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
  const tagFor = (cat) => topByCat[cat].length ? ` - actions: ${topByCat[cat].join(', ')}` : '';

  // Phase 5+ - dynamic C8-C11 rows. C8/C9/C10 only render when their
  // data field is populated. C11 always renders - events array may be
  // empty and that's still useful information ("no major events").
  const extraRows = [];
  if (data.hud_fmr && data.hud_fmr.fmr_2br != null) {
    const fmr = data.hud_fmr;
    const metro = fmr.metro_name || '-';
    const yr = fmr.fmr_year || '-';
    extraRows.push(`<tr><td><strong>C8 Regional Rents</strong></td><td>2BR rent benchmark: $${fmr.fmr_2br.toLocaleString('en-US')}/mo (${escapeHtml(String(metro))}, ${escapeHtml(String(yr))})</td></tr>`);
  }
  if (data.bls_employment && data.bls_employment.employment_level != null) {
    const bls = data.bls_employment;
    const period = bls.employment_period || '';
    const yr = bls.employment_year || '';
    const periodLabel = (period || yr) ? `${period} ${yr}`.trim() : '-';
    extraRows.push(`<tr><td><strong>C9 Employment Trend</strong></td><td>${bls.employment_level.toLocaleString('en-US')} sector jobs nationally (${escapeHtml(periodLabel)})</td></tr>`);
  }
  if (Array.isArray(data.nearby_venues) && data.nearby_venues.length > 0) {
    const top3 = data.nearby_venues.slice(0, 3).map((v) => v.name).join(', ');
    extraRows.push(`<tr><td><strong>C10 Nearby Venues</strong></td><td>Top nearby: ${escapeHtml(top3)}</td></tr>`);
  }
  // C11 always renders - the absence of events is itself a signal.
  {
    const events = Array.isArray(data.upcoming_events) ? data.upcoming_events : [];
    const content = events.length > 0
      ? `${events.length} events within 10mi next 90 days`
      : 'No major events found within 10mi';
    extraRows.push(`<tr><td><strong>C11 Upcoming Events</strong></td><td>${escapeHtml(content)}</td></tr>`);
  }

  const totalCategoryCount = 7 + extraRows.length;
  const categoryCoverageHtml = `<h2>What we analyzed - ${totalCategoryCount} signal categories</h2>
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

  // Chart.js visual layer - seven charts (matrix, ratings, reviews,
  // seasonal, pagespeed, income, permits). Rendered right after the
  // priority-actions section. Each chart self-guards on data
  // availability and falls back to a small "Data not available" box,
  // so the section is safe to include for every profile.
  const chartsHtml = renderMarketCharts(
    data,
    profile,
    data && (data.name || data.business_name) || input
  );

  // PDF download button - only rendered when reportId is supplied by
  // the route handler (i.e., in /report/:id replay flow, not in the
  // live /classify generation flow where the report ID doesn't exist
  // yet). Also intentionally omitted from the PDF route's own render
  // so the button doesn't appear in the printed PDF itself.
  const pdfBtnHtml = reportId
    ? `<a href="/report/${encodeURIComponent(reportId)}/pdf" class="pdf-btn" style="display: inline-block; background: #2563EB; color: #FFFFFF; padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 600; text-decoration: none; margin-left: 8px;">&#11015; Download PDF</a>`
    : '';

  // ── Table of Contents ──────────────────────────────────────────────
  // Smart TOC: only show links for sections whose HTML actually has
  // content. The presence/absence is keyed on the same string variables
  // that get interpolated into the template below - so a section that
  // skipped rendering (returned '') is also absent from the TOC.
  //
  // 3 sections are visually highlighted in blue as "most important":
  //   - Priority Actions
  //   - How to Beat Competitors (conquest_page)
  //   - 90 Day Action Plan
  //
  // CSS uses a two-column grid on >=720px viewports and collapses to
  // single column on mobile via the existing 720px breakpoint already
  // baked into the rest of the report. Inline-styled to stay
  // self-contained.
  function hasContent(html) {
    return typeof html === 'string' && html.trim().length > 0;
  }
  // CHANGE 2 - TOC reordered to match the new section flow.
  // "Competitor Analysis" entry removed (competitiveHtml still renders
  // but is brief enough not to warrant a TOC link). "Competitor Deep
  // Dive" added as a new entry pointing at the merged comparison +
  // deep-dive block. Priority Actions, Conquest Page, Market Charts,
  // and Competitor Deep Dive reordered to flow context → tactics.
  const tocCandidates = [
    { label: 'Market Overview',         anchor: 'market-overview',    html: localContextHtml,             highlight: false },
    { label: 'Your Strengths',          anchor: 'strengths',          html: strengthsHtml,                highlight: false },
    { label: 'Google Ranking Position', anchor: 'ranking-position',   html: rankingEstimateHtml,          highlight: false },
    { label: 'Review Gap Analysis',     anchor: 'review-gap',         html: reviewGapHtml,                highlight: false },
    { label: 'Hours Comparison',        anchor: 'hours-comparison',   html: hoursComparisonHtml,          highlight: false },
    { label: 'Area Map',                anchor: 'competitive-map',    html: mapHtml,                      highlight: false },
    { label: 'Location and Market',     anchor: 'location-market',    html: marketHtml,                   highlight: false },
    { label: 'Anchor Score',            anchor: 'anchor-score',       html: anchorScoreHtml,              highlight: false },
    { label: 'Seasonal Calendar',       anchor: 'seasonal-calendar',  html: seasonalCalendarHtml,         highlight: false },
    { label: 'Operations and Brand',    anchor: 'operations-brand',   html: opsHtml,                      highlight: false },
    { label: 'Market Charts',           anchor: 'market-charts',      html: chartsHtml,                   highlight: false },
    { label: 'Competitor Deep Dive',    anchor: 'competitor-deep-dive', html: competitorDeepDiveHtml,       highlight: false },
    { label: 'Priority Actions',        anchor: 'priority-actions',   html: priorityHtml,                 highlight: true  },
    { label: 'Key Risks',               anchor: 'key-risks',          html: keyRisksHtml,                 highlight: false },
    { label: '90 Day Action Plan',      anchor: 'ninety-day-plan',    html: ninetyDayPlanHtml,            highlight: true  },
    { label: 'Opportunities',           anchor: 'opportunities',      html: opportunitiesHtml,            highlight: false },
  ];
  const tocVisible = tocCandidates.filter((c) => hasContent(c.html));
  let tocHtml = '';
  if (tocVisible.length > 0) {
    const tocItems = tocVisible.map((c, idx) => {
      const num = idx + 1;
      const linkStyle = c.highlight
        ? 'display: block; padding: 7px 4px; color: #2563EB; font-weight: 700; text-decoration: none; font-size: 14px; border-bottom: 1px solid #F1F5F9;'
        : 'display: block; padding: 7px 4px; color: #1E293B; font-weight: 500; text-decoration: none; font-size: 14px; border-bottom: 1px solid #F1F5F9;';
      const numStyle = c.highlight
        ? 'color: #2563EB; font-weight: 700; margin-right: 8px;'
        : 'color: #6B7280; font-weight: 600; margin-right: 8px;';
      return `<a href="#${c.anchor}" style="${linkStyle}"><span style="${numStyle}">${num}.</span>${escapeHtml(c.label)}</a>`;
    }).join('');
    tocHtml = `<div class="report-toc" style="background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 10px; padding: 18px 22px; margin: 20px 0 28px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
  <div style="font-size: 12px; font-weight: 700; color: #6B7280; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 12px;">Report Contents</div>
  <div class="report-toc-grid" style="display: grid; grid-template-columns: 1fr; gap: 0 24px;">
    ${tocItems}
  </div>
</div>
<style>
  @media (min-width: 720px) {
    .report-toc-grid { grid-template-columns: 1fr 1fr !important; }
  }
  .report-toc a:hover { background: #F8FAFC; }
  html { scroll-behavior: smooth; }
</style>`;
  }

  // ── Back to top button ─────────────────────────────────────────────
  // Floating navy pill, fixed bottom-right. Hidden by default; the
  // scroll listener flips display to 'block' once the user scrolls
  // past 200px. Clicking smooth-scrolls to the top. Pure inline JS
  // so it works in the static rendered HTML without any external
  // script tag.
  const backToTopHtml = `<button id="back-to-top" aria-label="Back to top" style="display: none; position: fixed; bottom: 24px; right: 24px; background: #0F1729; color: #FFFFFF; border: 0; border-radius: 50px; padding: 10px 16px; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer; box-shadow: 0 4px 12px rgba(15, 23, 41, 0.25); z-index: 1000;">&uarr; Top</button>
<script>
(function () {
  var btn = document.getElementById('back-to-top');
  if (!btn) return;
  function onScroll() {
    if (window.scrollY > 200) {
      btn.style.display = 'block';
    } else {
      btn.style.display = 'none';
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  btn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  onScroll();
})();
</script>`;

  // Section flow. Notable choices:
  //   - competitorComparisonHtml fully REMOVED - its content
  //     duplicated material already in Competitor Deep Dive.
  //   - conquestPageHtml, chartsHtml, competitorDeepDiveHtml moved
  //     UP (slots 18-20) - competitor-tactical sections belong near
  //     priority actions, not buried at the bottom.
  //   - priorityHtml moved DOWN (slot 21) - sits AFTER the
  //     competitor context that motivates each action.
  // FIX 6 - Dark mode toggle button + on-load restore script.
  const darkModeHtml = `<script>
(function(){
  var saved = localStorage.getItem('reportDarkMode');
  if (saved === '1') {
    document.body.classList.add('dark-mode');
    var btn = document.getElementById('dark-toggle');
    if (btn) btn.textContent = '☀️ Light mode';
  }
})();
function toggleDark() {
  var isDark = document.body.classList.toggle('dark-mode');
  localStorage.setItem('reportDarkMode', isDark ? '1' : '0');
  var btn = document.getElementById('dark-toggle');
  if (btn) btn.textContent = isDark ? '☀️ Light mode' : '🌙 Dark mode';
}
</script>`;

  return `${PAGE_OPEN}<div class="back-links" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;"><a class="back" style="margin-bottom:0" href="/app">&larr; new search</a> <a class="back" style="margin-bottom:0" href="/dashboard">&larr; Back to Dashboard</a>${pdfBtnHtml ? ' ' + pdfBtnHtml : ''}<button id="dark-toggle" onclick="toggleDark()" style="margin-left:auto;background:#F1F5F9;border:1px solid #E2E8F0;border-radius:999px;padding:5px 14px;font-size:12px;cursor:pointer;font-family:inherit;color:#374151;font-weight:500;">🌙 Dark mode</button></div>
${closedPermanentlyBanner}${partialReportBanner}${claudeUnavailableBanner}${noWebsiteBanner}${lowConfidenceBanner}${headerHtml}
${overallHtml}
${tocHtml}
${localContextHtml}
${redFlagsHtml}
${strengthsHtml}
${industrySurvivalHtml}
${tripAdvisorHtml}
${qualityRatingsHtml}
${complianceHtml}
${competitiveHtml}
${mapHtml}
${rankingEstimateHtml}
${reviewGapHtml}
${hoursComparisonHtml}
${marketHtml}
${anchorScoreHtml}
${demandHtml}
${seasonalCalendarHtml}
${opsHtml}${pagespeedDisplayHtml}${photoStatHtml}
${chartsHtml}
${competitorDeepDiveHtml}
${priorityHtml}
${keyRisksHtml}
${executionTemplatesHtml}
${ninetyDayPlanHtml}
${seasonalStrategyHtml}
${opportunitiesHtml}
${commonProblemsHtml}
${categoryCoverageHtml}
${footerHtml}
${backToTopHtml}
${darkModeHtml}${PAGE_CLOSE}`;
}

function citationLine(id, studies) {
  const s = studies.find((x) => x.id === id);
  if (!s) return `[${escapeHtml(id)}]`;
  const tier3 = s.tier === 3 ? ' [TIER-3 VENDOR]' : '';
  return `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.id)}</a> ${escapeHtml(s.citation)}${tier3}`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH16 - Common Problems Detected (review-mined)
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
</div>`;
    }).join('');
  }

  return `<h2>What your customers are saying - common problems detected</h2>${body}`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH14 - Money-estimate methodology (CHANGE 6)
// ───────────────────────────────────────────────────────────────────
// Gates (all must pass - otherwise no money estimate is shown):
//   - Impact is HIGH or MEDIUM
//   - At least one cited study is Tier 1 or Tier 2 (not Tier 3 vendor)
//   - Recommendation magnitude string contains a parseable numeric % range
//   - Sector revenue baseline can be reasonably estimated
//
// Method:
//   1. Look up the profile's sector revenue baseline range [low, high]
//   2. Apply size multiplier (review-count-derived: small/med/large/very large)
//   3. Compute estimated annual revenue baseline = midpoint × multiplier
//   4. Apply the study % range to that baseline → $X-$Y/year
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
  let m = magStr.match(/(\d+(?:\.\d+)?)\s*[--to]+\s*(\d+(?:\.\d+)?)\s*%/i);
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
  // Gate 1 - impact tier
  if (t.impact !== 'HIGH' && t.impact !== 'MEDIUM') return '';
  // Gate 2 - at least one Tier 1 or Tier 2 study
  const tiers = t.rec.study_ids
    .map((sid) => studies.find((s) => s.id === sid))
    .filter(Boolean)
    .map((s) => s.tier);
  if (!tiers.some((t) => t === 1 || t === 2)) return '';
  // Gate 3 - parseable % magnitude
  const pctRange = parsePctMagnitude(t.rec.magnitude);
  if (!pctRange) return '';
  // Gate 4 - baseline available (always true with default)
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
  const pctDisplay = pctLow === pctHigh ? `${pctLow}%` : `${pctLow}-${pctHigh}%`;
  const moneyDisplay = lowMoney === highMoney
    ? `${fmtUsd(lowMoney)}/year`
    : `${fmtUsd(lowMoney)}-${fmtUsd(highMoney)}/year`;
  const kpi = pickKpi(profile.id);
  const reviewNote = reviewCount != null
    ? `${reviewCount} review${reviewCount === 1 ? '' : 's'} → ${sizeName} (×${mult})`
    : `unknown size (default ×1.0)`;

  return `<div class="money">
<strong>Money estimate: ${moneyDisplay}</strong><br>
<span class="meta">Math: ${fmtUsd(baselineRange[0])}-${fmtUsd(baselineRange[1])} sector baseline, midpoint ${fmtUsd((baselineRange[0] + baselineRange[1]) / 2)} × size multiplier (${reviewNote}) = ${fmtUsd(Math.round(midBaseline))} estimated annual revenue. Apply ${pctDisplay} cited study magnitude to get ${moneyDisplay}.</span><br>
<em class="meta">Sector averages used. Track ${escapeHtml(kpi)} to measure your actual lift.</em>
</div>`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH16 - KNOWN vs HIDDEN issue classification
// ───────────────────────────────────────────────────────────────────
//
// Compare each triggered rec's gap against competitor medians from the
// Phase-3 Nearby Search data. If competitors share the gap, mark KNOWN
// (cap score at 0.30, push to bottom). If competitors don't have it,
// mark HIDDEN (push to top regardless of raw score).
//
// Only `google_rating` and `google_review_count` gaps can be classified
// - those are the fields the Nearby Search returns medians for. Other
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
// BATCH14 / BATCH16 - 3-layer recommendation rendering helpers
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
    // bad trigger - skip evidence extraction
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
// renderActionCard - Claude priority_actions card renderer
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

// ─────────────────────────────────────────────────────────────────────
// FIX 1 - renderROISummary
// ─────────────────────────────────────────────────────────────────────
// Parses money_estimate strings (e.g. "$8,000-$18,000/year") from all
// priority_actions, sums low and high ends, and renders a "Your Revenue
// Opportunity" table before the individual action cards.
// Graceful fallback: returns '' when no actions have money_estimate.
function renderROISummary(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '';

  const rows = [];
  let totalLow = 0;
  let totalHigh = 0;

  for (const a of actions) {
    const est = String(a.money_estimate || '').trim();
    if (!est) continue;
    // BUG 1 FIX — conservative revenue-range parser. A money_estimate can carry
    // a "Math:" suffix and/or a "(assuming …)" parenthetical (extra numbers), be
    // a /month or /year figure, or be a COST line (e.g. the website-builder
    // action). Parse ONLY the leading revenue range (text before "Math:" and the
    // first "("), skip cost/mixed lines, and annualize from the revenue clause's
    // OWN period — so the grand total equals the sum of the clean per-item rows.
    let revPart = est.split(/math:/i)[0];
    const parenIdx = revPart.indexOf('(');
    if (parenIdx !== -1) revPart = revPart.slice(0, parenIdx);
    revPart = revPart.trim();
    // Skip cost / mixed / unparseable lines (contribute 0 — not counted, not a row).
    if (/one[- ]?time|hosting|\bcost\b|build|setup|·|contact support/i.test(revPart)) continue;
    const m = revPart.match(/\$\s?([\d,]+)\s?([kK])?\s*[-–]\s*\$?\s?([\d,]+)\s?([kK])?/);
    if (!m) continue; // no clean "$X-$Y" revenue range → skip
    let low = parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
    let high = parseFloat(m[3].replace(/,/g, '')) * (m[4] ? 1000 : 1);
    if (!isFinite(low) || !isFinite(high)) continue;
    // Period from the REVENUE clause ONLY (never scan the whole string — that was
    // the bug that 12×'d a yearly figure whenever a stray "/month" appeared).
    if (/\/\s?month|per month/i.test(revPart)) { low *= 12; high *= 12; }
    rows.push({ title: a.title || 'Action', est });
    totalLow += low;
    totalHigh += high;
  }

  if (rows.length === 0) return '';

  // FIX 7 - always display total as /year regardless of individual units.
  const suffix = '/year';

  const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const totalRange = totalLow === totalHigh
    ? `${fmt(totalLow)}${suffix}`
    : `${fmt(totalLow)} - ${fmt(totalHigh)}${suffix}`;

  const rowsHtml = rows.map((r) => `<tr>
      <td style="padding:10px 14px;font-size:13px;color:#374151;border-bottom:1px solid #F1F5F9;line-height:1.4;word-wrap:break-word;overflow-wrap:break-word;white-space:normal;max-width:0;">${escapeHtml(r.title)}</td>
      <td style="padding:10px 14px;font-size:13px;color:#166534;text-align:right;border-bottom:1px solid #F1F5F9;word-wrap:break-word;overflow-wrap:break-word;white-space:normal;max-width:0;">${escapeHtml(r.est)}</td>
    </tr>`).join('');

  return `<div style="background:#FFFFFF;border:1px solid #D1FAE5;border-radius:10px;padding:20px 24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
  <div style="font-size:17px;font-weight:700;color:#0F1729;margin-bottom:4px;">&#128176; Your Revenue Opportunity</div>
  <div style="font-size:13px;color:#6B7280;margin-bottom:16px;">Combined potential from all recommended actions</div>
  <table style="width:100%;border-collapse:collapse;">
    ${rowsHtml}
    <tr style="border-top:2px solid #D1FAE5;">
      <td style="padding:12px 14px;font-size:14px;font-weight:700;color:#065F46;">TOTAL ANNUAL POTENTIAL</td>
      <td style="padding:12px 14px;font-size:17px;font-weight:700;color:#166534;text-align:right;white-space:nowrap;">${escapeHtml(totalRange)}</td>
    </tr>
  </table>
  <p style="font-size:11px;color:#9CA3AF;margin:12px 0 0 0;">Estimates based on your specific business data. See each action for full math.</p>
</div>`;
}

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

  // ── psychology_deep block (Call C1 output) ─────────────────────────
  let psychoDeepBlock = '';
  const deep = action.psychology_deep;
  if (deep && typeof deep === 'object') {
    const pf = (label, val, bg, fg) => {
      if (!val || typeof val !== 'string' || !val.trim()) return '';
      return `<div><span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;background:${bg};color:${fg};">${label}</span><span style="font-size:13px;color:#374151;line-height:1.7;margin:0;display:block;">${escapeHtml(val.trim())}</span></div>`;
    };
    const divider = '<hr style="border:none;border-top:1px solid #E5E7EB;margin:12px 0;">';
    const rows = [
      pf('MEMORY TRIGGER',       deep.memory_trigger,       '#EDE9FE', '#5B21B6'),
      pf('WORD OF MOUTH',        deep.word_of_mouth,        '#DBEAFE', '#1E40AF'),
      pf('REVENUE DRIVER',       deep.revenue_driver,       '#DCFCE7', '#166534'),
      pf('WHY THIS WORKS HERE',  deep.local_logic,          '#FEF3C7', '#92400E'),
      pf('COMPETITOR GAP',       deep.competitor_gap,       '#FFE4E6', '#9F1239'),
      pf('ROI',                  deep.roi_proof,            '#DCFCE7', '#166534'),
      pf('WHY NOT ALTERNATIVES', deep.why_not_alternatives, '#F3F4F6', '#374151'),
      pf('NEXT 48 HOURS',        deep.first_48_hours,       '#FFF7ED', '#C2410C'),
      pf('LEAVE BEHIND',         deep.leave_behind,         '#EDE9FE', '#5B21B6'),
    ].filter(Boolean);
    if (rows.length > 0) {
      psychoDeepBlock = `<div style="margin-top:16px;padding:16px;background:#FAFAFA;border-left:3px solid #6366F1;border-radius:0 8px 8px 0;"><span style="font-size:11px;font-weight:700;color:#6366F1;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:14px;display:block;">Why this works</span>${rows.join(divider)}</div>`;
    }
  }

  return `<div class="action-card" style="border-left: 4px solid ${colors.border}; background: white; padding: 20px; margin-bottom: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); word-wrap: break-word; overflow-wrap: break-word; white-space: normal; max-width: 100%;">
  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
    <span style="background: ${colors.bg}; color: ${colors.text}; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">${impact} IMPACT</span>
    <span style="background: ${sourceBg}; color: ${sourceFg}; font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 4px;">${sourceLabel}</span>
  </div>
  <h3 style="font-size: 16px; font-weight: 600; color: #0F1729; margin: 0 0 12px 0; word-wrap: break-word; overflow-wrap: break-word; white-space: normal; max-width: 100%;">${title}</h3>
  ${what ? `<div style="margin-bottom: 10px; word-wrap: break-word; overflow-wrap: break-word; white-space: normal; max-width: 100%;"><span style="font-weight: 600; font-size: 13px; color: #374151;">WHAT: </span><span style="font-size: 14px; color: #374151; line-height: 1.6;">${what}</span></div>` : ''}
  ${why ? `<div style="margin-bottom: 10px; word-wrap: break-word; overflow-wrap: break-word; white-space: normal; max-width: 100%;"><span style="font-weight: 600; font-size: 13px; color: #374151;">WHY YOUR BUSINESS: </span><span style="font-size: 14px; color: #374151; line-height: 1.6;">${why}</span></div>` : ''}
  ${moneyEst ? `<div style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 6px; padding: 10px 14px; margin-bottom: 10px; word-wrap: break-word; overflow-wrap: break-word; white-space: normal; max-width: 100%;"><span style="font-weight: 600; font-size: 13px; color: #166534;">Money estimate: </span><span style="font-size: 14px; color: #166534;">${moneyEst}</span></div>` : ''}
  ${metaLine}
  ${psychoDeepBlock}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// calculateAnchorScore - Walk-Up Traffic Potential score (0-100)
// ─────────────────────────────────────────────────────────────────────
// Uses ONLY existing data fields already in data.location_signals.*
// and data.nearby_venues[]. No new API calls.
//
// Formula (research-doc Q8):
//   score = (anchor_tenant_count × 8)               // 0-80
//         + (has_transit_nearby ? 15 : 0)           // 0 or 15
//         + (nearest_transit_meters != null
//              ? max(0, 15 - (nearest_transit_meters / 50))
//              : 0)                                 // 0-15 (linear decay)
//         + min(10, nearby_venues.length)           // 0-10
//   capped at 100, rounded to 1 decimal
//
// Returns:
//   {
//     score: number (0-100, 1 decimal),
//     band: 'Anchor Magnet' | 'Walkable Strip' | 'Adjacent to Traffic' | 'Destination Only',
//     bandColor: hex string for pill badge,
//     contributors: { anchors, transit, transitMeters, venues },
//     missing: true if location_signals data is absent
//   }
//
// Returns { missing: true } when location_signals is not available so
// the renderer can show a graceful "data not available" message
// instead of crashing.
function calculateAnchorScore(data) {
  if (!data) return { missing: true };
  const sig = data.location_signals;
  const venues = Array.isArray(data.nearby_venues) ? data.nearby_venues : [];

  // If we have NO location signals AND NO Foursquare venues, treat as missing.
  // (Either one alone is enough to compute a meaningful score.)
  if ((!sig || typeof sig !== 'object') && venues.length === 0) {
    return { missing: true };
  }

  const anchorCount = (sig && typeof sig.anchor_tenant_count === 'number')
    ? sig.anchor_tenant_count
    : 0;
  const anchorTenants = (sig && Array.isArray(sig.anchor_tenants))
    ? sig.anchor_tenants.filter((n) => typeof n === 'string' && n.trim().length > 0)
    : [];
  const hasTransit = !!(sig && sig.has_transit_nearby === true);
  const transitMeters = (sig && typeof sig.nearest_transit_meters === 'number')
    ? sig.nearest_transit_meters
    : null;
  const venueCount = venues.length;

  const anchorPoints = anchorCount * 8;
  const transitBoolPoints = hasTransit ? 15 : 0;
  const transitDecayPoints = transitMeters != null
    ? Math.max(0, 15 - (transitMeters / 50))
    : 0;
  const venuePoints = Math.min(10, venueCount);

  let score = anchorPoints + transitBoolPoints + transitDecayPoints + venuePoints;
  if (score > 100) score = 100;
  if (score < 0) score = 0;
  score = Math.round(score * 10) / 10;

  let band, bandColor;
  if (score >= 80) {
    band = 'Anchor Magnet';
    bandColor = '#10B981'; // green
  } else if (score >= 50) {
    band = 'Walkable Strip';
    bandColor = '#3B82F6'; // blue
  } else if (score >= 25) {
    band = 'Adjacent to Traffic';
    bandColor = '#F59E0B'; // orange
  } else {
    band = 'Destination Only';
    bandColor = '#DC2626'; // red
  }

  return {
    score,
    band,
    bandColor,
    contributors: {
      anchors: anchorTenants,
      anchorCount,
      transit: hasTransit,
      transitMeters,
      venueCount,
    },
    missing: false,
  };
}

// ─────────────────────────────────────────────────────────────────────
// renderAnchorScore - Walk-Up Traffic Potential panel
// ─────────────────────────────────────────────────────────────────────
// White card with score display, contributing factors, plain-English
// "what this means for you" guidance keyed to the score band, and a
// disclaimer that this is a location-quality estimate (not real-time
// foot traffic).
//
// Graceful fallback: when location_signals is missing, shows a small
// "Location data not available for this business type" notice instead
// of crashing.
function renderAnchorScore(data) {
  const result = calculateAnchorScore(data);

  if (result.missing) {
    return `<div class="section">
  <h2 id="anchor-score">Walk-up traffic potential</h2>
  <p style="color: #6B7280; font-size: 13px;">Location data not available for this business type.</p>
</div>`;
  }

  const { score, band, bandColor, contributors } = result;
  const { anchors, transit, transitMeters, venueCount } = contributors;

  // "What drives your score" - only show factors that actually contribute
  const driverLines = [];
  if (anchors.length > 0) {
    const top3 = anchors.slice(0, 3);
    driverLines.push(`<div style="font-size: 14px; color: #374151; margin-bottom: 8px;">
      <span style="font-size: 16px;">&#128205;</span>
      <strong>${escapeHtml(top3.join(', '))}</strong>${anchors.length > 3 ? ` and ${anchors.length - 3} more` : ''} nearby
      <span style="color: #6B7280;"> &rarr; draws steady foot traffic</span>
    </div>`);
  }
  if (transit) {
    const transitDetail = transitMeters != null ? ` (${transitMeters}m away)` : '';
    driverLines.push(`<div style="font-size: 14px; color: #374151; margin-bottom: 8px;">
      <span style="font-size: 16px;">&#128652;</span>
      <strong>Transit stop within 400m</strong>${escapeHtml(transitDetail)}
      <span style="color: #6B7280;"> &rarr; constant pedestrian stream</span>
    </div>`);
  }
  if (venueCount > 0) {
    driverLines.push(`<div style="font-size: 14px; color: #374151; margin-bottom: 8px;">
      <span style="font-size: 16px;">&#127978;</span>
      <strong>${venueCount} popular venue${venueCount === 1 ? '' : 's'} nearby</strong>
      <span style="color: #6B7280;"> &rarr; active commercial area</span>
    </div>`);
  }

  const driversHtml = driverLines.length
    ? `<div style="margin-top: 20px;">
        <div style="font-size: 12px; font-weight: 700; color: #6B7280; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 12px;">What drives your score</div>
        ${driverLines.join('')}
      </div>`
    : '';

  // "What this means for you" - band-specific guidance
  const meaningMap = {
    'Anchor Magnet': "Hundreds of potential customers pass within 500 meters of your door every day. Your marketing goal is CAPTURE not DISCOVERY. Use sidewalk signage, window displays, and Google Maps to intercept passing traffic.",
    'Walkable Strip': "Your location gets moderate foot traffic from nearby anchors. Focus on making your storefront visible and inviting to people passing by.",
    'Adjacent to Traffic': "Some foot traffic passes nearby but customers must make a small detour to reach you. Focus on clear signage and Google Maps optimization so people can easily find you.",
    'Destination Only': "Customers must specifically decide to visit you. Focus on online presence, Google reviews, and word of mouth marketing rather than walk-in traffic.",
  };
  const meaningText = meaningMap[band] || '';
  const meaningHtml = meaningText
    ? `<div style="background: #F8FAFC; border-left: 3px solid ${bandColor}; padding: 14px 18px; border-radius: 0 6px 6px 0; margin-top: 20px;">
        <div style="font-size: 12px; font-weight: 700; color: #6B7280; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6px;">What this means for you</div>
        <div style="font-size: 14px; line-height: 1.7; color: #1E293B;">${escapeHtml(meaningText)}</div>
      </div>`
    : '';

  return `<div class="section">
  <h2 id="anchor-score">Walk-up traffic potential</h2>
  <div style="background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 10px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
    <div style="display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;">
      <div style="font-size: 48px; font-weight: 700; color: #0F1729; line-height: 1;">${escapeHtml(score.toString())}</div>
      <div style="font-size: 16px; color: #6B7280;">out of 100</div>
      <div style="display: inline-block; background: ${bandColor}; color: white; font-size: 13px; font-weight: 700; padding: 6px 14px; border-radius: 999px; letter-spacing: 0.5px;">${escapeHtml(band)}</div>
    </div>
    ${driversHtml}
    ${meaningHtml}
    <div style="font-size: 11px; color: #9CA3AF; margin-top: 18px; padding-top: 14px; border-top: 1px solid #F1F5F9; line-height: 1.5;">
      Score based on anchor stores, transit access, and venue density within 500m. This is a location quality estimate, not a real-time visitor count.
    </div>
  </div>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// renderCompetitiveMap - Google Maps Embed iframe of local area
// ─────────────────────────────────────────────────────────────────────
// Interactive Google Maps embed centered on the business, searching for
// the same business type nearby. Falls back to '' when lat/lon or
// API key is absent.
function renderCompetitiveMap(data, profile) {
  if (!data) return '';
  const lat = data.latitude;
  const lng = data.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return '';
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return '';

  const bizTypeRaw = (profile && typeof profile.name === 'string' && profile.name.trim())
    ? profile.name.trim()
    : (data.business_type || 'business');
  const bizType = bizTypeRaw.toLowerCase();
  const q = encodeURIComponent(`${bizType} near ${lat},${lng}`);
  const center = `${lat},${lng}`;
  const src = `https://www.google.com/maps/embed/v1/search?key=${apiKey}&q=${q}&center=${center}&zoom=13`;

  return `<div class="section">
  <h2 id="competitive-map">Your area - competitors nearby</h2>
  <iframe
    src="${src}"
    style="width:100%;height:400px;border:none;border-radius:8px;"
    allowfullscreen
    loading="lazy"
    referrerpolicy="no-referrer-when-downgrade">
  </iframe>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// fetchReviewVelocity - DB lookup for the user's prior review snapshot
// ─────────────────────────────────────────────────────────────────────
// Reads the user's most recent prior report for the same business and
// extracts data.google_review_count from the saved report_json. Returns
// { previousCount, daysAgo, createdAt } when a usable prior report is
// found, or null otherwise (no prior report, DB error, or same-day
// regeneration with no actual time gap).
//
// `beforeDate` lets the /report/:id replay route look back relative to
// the report being viewed, so velocity stays accurate when replaying an
// older saved report. /classify passes new Date() to look back from now.
//
// All DB errors are caught and logged; the renderer treats null as
// "no velocity data available" and shows the 30-day fallback.
async function fetchReviewVelocity(userId, businessName, beforeDate) {
  if (!userId || !businessName) return null;
  if (!pool) return null;
  try {
    const upperBound = beforeDate || new Date();
    const result = await pool.query(
      `SELECT report_json, created_at
       FROM reports
       WHERE user_id = $1
         AND business_name ILIKE $2
         AND created_at < $3
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId, '%' + businessName + '%', upperBound]
    );
    for (const row of result.rows) {
      let obj;
      try {
        obj = (typeof row.report_json === 'string')
          ? JSON.parse(row.report_json)
          : row.report_json;
      } catch (e) {
        continue;
      }
      const prevCount = obj && obj.data && obj.data.google_review_count;
      if (typeof prevCount === 'number' && prevCount > 0) {
        const daysAgo = Math.round(
          (new Date(upperBound).getTime() - new Date(row.created_at).getTime())
          / (1000 * 60 * 60 * 24)
        );
        if (daysAgo >= 1) {
          return { previousCount: prevCount, daysAgo, createdAt: row.created_at };
        }
      }
    }
    return null;
  } catch (err) {
    console.warn('[review-velocity] DB query failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// renderReviewGap - "Review Gap & Catch-Up Calculator" section
// ─────────────────────────────────────────────────────────────────────
// Four parts:
//   1. Bar comparison (you vs. the highest-reviewed competitor)
//   2. Catch-up calculator table (months at 5/10/25/50 reviews per month)
//   3. Realistic target - beat the local median, not the leader
//   4. Real velocity - diff from the user's previous report (when available)
//
// Uses ONLY existing data fields. Zero new API calls.
//
// Graceful fallbacks:
//   - google_review_count null/missing, return '' (section omitted)
//   - No competitor with more reviews, skip Parts 1-2, show only the
//     realistic-target and velocity parts
//   - realistic_target already met, "you already meet the benchmark"
//   - No prior report, "generate next report in 30 days" message
function renderReviewGap(data, velocity) {
  if (!data) return '';
  const yourReviews = data.google_review_count;
  if (typeof yourReviews !== 'number' || yourReviews < 0) return '';

  const median = typeof data.competitor_median_review_count === 'number'
    ? data.competitor_median_review_count
    : null;

  // All competitors with MORE reviews than the subject. Fall back to
  // competitors_top3 when top5 is not populated.
  const allComps = Array.isArray(data.competitors_top5) ? data.competitors_top5
    : (Array.isArray(data.competitors_top3) ? data.competitors_top3 : []);
  const compsAbove = allComps.filter((c) =>
    c && typeof c.review_count === 'number' && c.review_count > yourReviews
  );

  // Realistic target, beat the local median by 50%, or your_reviews+50,
  // whichever is higher. When no median is available, fall back to +50.
  const realisticTarget = (median != null && median > 0)
    ? Math.max(Math.round(median * 1.5), yourReviews + 50)
    : yourReviews + 50;

  // ── PART 1 + PART 2 - bar comparison + catch-up table ──────────────
  // Show every competitor that has more reviews than the subject.
  let gapHtml = '';
  let catchUpHtml = '';
  if (compsAbove.length > 0) {
    const competitorBlocks = compsAbove.map((comp) => {
      const compReviews = comp.review_count;
      const compName = comp.name || 'Top competitor';
      const gap = compReviews - yourReviews;
      const maxBar = compReviews;
      const yourPct = Math.max(2, Math.round((yourReviews / maxBar) * 100));

      const barSection = `<div style="margin: 16px 0;">
  <div style="display: grid; grid-template-columns: 140px 1fr 90px; gap: 12px; align-items: center; font-size: 13px; margin-bottom: 10px;">
    <div style="font-weight: 600; color: #1E293B;">You</div>
    <div style="background: #F1F5F9; border-radius: 6px; overflow: hidden; height: 22px;">
      <div style="background: #2563EB; height: 100%; width: ${yourPct}%; border-radius: 6px;"></div>
    </div>
    <div style="font-weight: 700; color: #2563EB; text-align: right;">${yourReviews.toLocaleString('en-US')}</div>
  </div>
  <div style="display: grid; grid-template-columns: 140px 1fr 90px; gap: 12px; align-items: center; font-size: 13px; margin-bottom: 10px;">
    <div style="font-weight: 600; color: #1E293B; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(compName)}">${escapeHtml(compName)}</div>
    <div style="background: #F1F5F9; border-radius: 6px; overflow: hidden; height: 22px;">
      <div style="background: #94A3B8; height: 100%; width: 100%; border-radius: 6px;"></div>
    </div>
    <div style="font-weight: 700; color: #475569; text-align: right;">${compReviews.toLocaleString('en-US')}</div>
  </div>
  <div style="display: grid; grid-template-columns: 140px 1fr 90px; gap: 12px; align-items: center; font-size: 13px; padding-top: 6px; border-top: 1px dashed #E5E7EB;">
    <div style="font-weight: 700; color: #DC2626;">Gap</div>
    <div style="font-size: 13px; color: #6B7280;">${gap.toLocaleString('en-US')} reviews behind</div>
    <div></div>
  </div>
</div>
<p style="font-size: 14px; line-height: 1.6; color: #1E293B; margin: 14px 0 0;">You are ${gap.toLocaleString('en-US')} reviews behind ${escapeHtml(compName)}. This gap means ${escapeHtml(compName)} appears above you in Google search results for most customers searching in your area.</p>`;

      const rates = [
        { rate: 5, label: '5 reviews per month' },
        { rate: 10, label: '10 reviews per month' },
        { rate: 25, label: '25 reviews per month' },
        { rate: 50, label: '50 reviews per month' },
      ];
      const rows = rates.map((r) => {
        const months = Math.ceil(gap / r.rate);
        let statusIcon, statusLabel, color, bg;
        if (months > 36) {
          statusIcon = '\u{1F534}'; statusLabel = 'Too slow';
          color = '#991B1B'; bg = '#FEE2E2';
        } else if (months >= 13) {
          statusIcon = '\u{1F7E1}'; statusLabel = 'Slow';
          color = '#92400E'; bg = '#FEF3C7';
        } else if (months >= 7) {
          statusIcon = '\u{1F7E2}'; statusLabel = 'Realistic';
          color = '#065F46'; bg = '#D1FAE5';
        } else {
          statusIcon = '\u{2705}'; statusLabel = 'Fast';
          color = '#1E40AF'; bg = '#DBEAFE';
        }
        return `<tr>
  <td style="padding: 10px 14px; border-bottom: 1px solid #F1F5F9; font-size: 14px; color: #1E293B;">${escapeHtml(r.label)}</td>
  <td style="padding: 10px 14px; border-bottom: 1px solid #F1F5F9; font-size: 14px; color: #1E293B; text-align: right;">${months} ${months === 1 ? 'month' : 'months'}</td>
  <td style="padding: 10px 14px; border-bottom: 1px solid #F1F5F9; text-align: right;"><span style="display: inline-block; background: ${bg}; color: ${color}; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px;">${statusIcon} ${escapeHtml(statusLabel)}</span></td>
</tr>`;
      }).join('');

      const tableSection = `<h3 style="font-size: 15px; color: #0F1729; margin: 24px 0 10px;">How long to close the gap with ${escapeHtml(compName)}?</h3>
<div style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
  <table style="width: 100%; border-collapse: collapse; font-family: inherit;">
    <thead>
      <tr style="background: #F8FAFC;">
        <th style="padding: 10px 14px; text-align: left; font-size: 12px; font-weight: 700; color: #6B7280; letter-spacing: 0.5px; text-transform: uppercase; border-bottom: 1px solid #E5E7EB;">Reviews per month</th>
        <th style="padding: 10px 14px; text-align: right; font-size: 12px; font-weight: 700; color: #6B7280; letter-spacing: 0.5px; text-transform: uppercase; border-bottom: 1px solid #E5E7EB;">Months to goal</th>
        <th style="padding: 10px 14px; text-align: right; font-size: 12px; font-weight: 700; color: #6B7280; letter-spacing: 0.5px; text-transform: uppercase; border-bottom: 1px solid #E5E7EB;">Status</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;

      return barSection + tableSection;
    });

    gapHtml = competitorBlocks.join('<hr style="border: 0; border-top: 1px solid #E5E7EB; margin: 28px 0;">');
  } else {
    // No competitor has more reviews than the subject.
    gapHtml = `<p style="font-size: 14px; line-height: 1.6; color: #1E293B;">You lead all nearby competitors in review count. Keep collecting reviews to maintain this advantage.</p>`;
  }

  // ── PART 3 - realistic target ──────────────────────────────────────
  let targetHtml = '';
  if (realisticTarget <= yourReviews) {
    targetHtml = `<div style="background: #ECFDF5; border-left: 3px solid #10B981; padding: 14px 18px; border-radius: 0 6px 6px 0; margin-top: 20px;">
  <div style="font-size: 14px; font-weight: 600; color: #065F46; margin-bottom: 6px;">You already meet the local review benchmark.</div>
  <div style="font-size: 13px; color: #1E293B; line-height: 1.6;">Focus on maintaining your review velocity by continuing to ask customers regularly.</div>
</div>`;
  } else {
    const needed = realisticTarget - yourReviews;
    const weeks = Math.ceil(needed / 14); // 2 reviews/day * 7 days
    let openingLine;
    if (compsAbove.length > 0) {
      const compReviews = compsAbove[0].review_count;
      const compName = compsAbove[0].name || 'Top competitor';
      openingLine = `You do not need to match ${escapeHtml(compName)}'s ${compReviews.toLocaleString('en-US')} reviews to compete. Reaching <strong>${realisticTarget.toLocaleString('en-US')} reviews</strong> puts you above the local median and makes you appear equally credible to first-time Google searchers.`;
    } else {
      openingLine = `Reaching <strong>${realisticTarget.toLocaleString('en-US')} reviews</strong> puts you above the local benchmark and makes you appear credible to first-time Google searchers.`;
    }
    targetHtml = `<h3 style="font-size: 15px; color: #0F1729; margin: 24px 0 10px;">A realistic target</h3>
<div style="background: #EFF6FF; border-left: 3px solid #2563EB; padding: 14px 18px; border-radius: 0 6px 6px 0;">
  <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.6; color: #1E293B;">${openingLine}</p>
  <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.6; color: #1E293B;">That is only <strong>${needed.toLocaleString('en-US')} more ${needed === 1 ? 'review' : 'reviews'}</strong> away.</p>
  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #1E293B;">At 2 review requests per day that takes <strong>${weeks} ${weeks === 1 ? 'week' : 'weeks'}</strong> from today.</p>
</div>`;
  }

  // ── PART 4 - real velocity from prior report ───────────────────────
  let velocityHtml = '';
  if (velocity && typeof velocity.previousCount === 'number' && typeof velocity.daysAgo === 'number' && velocity.daysAgo >= 1) {
    const oldCount = velocity.previousCount;
    const days = velocity.daysAgo;
    const newCount = yourReviews;
    const diff = newCount - oldCount;
    const reviewsPerDay = days > 0 ? diff / days : 0;
    const reviewsPerMonth = reviewsPerDay * 30;
    const dayWord = days === 1 ? 'day' : 'days';

    let lineHtml, calloutBg, calloutBorder;
    if (diff > 0) {
      // Growth. Compare monthly rate against a healthy threshold (5/month
      // matches the lowest tier in the catch-up table, anything below is
      // "Too slow", so we treat that as the green/orange split).
      const baseLine = `Since your last report ${days} ${dayWord} ago, your reviews grew from ${oldCount.toLocaleString('en-US')} to ${newCount.toLocaleString('en-US')}. That is <strong>${diff.toLocaleString('en-US')} new ${diff === 1 ? 'review' : 'reviews'} in ${days} ${dayWord}</strong>.`;
      if (reviewsPerMonth >= 5) {
        calloutBg = '#D1FAE5'; calloutBorder = '#10B981';
        lineHtml = `${baseLine} <span style="color: #065F46; font-weight: 600;">You are growing faster than your competitors.</span>`;
      } else {
        calloutBg = '#FEF3C7'; calloutBorder = '#F59E0B';
        lineHtml = `${baseLine} <span style="color: #92400E; font-weight: 600;">Your competitors may be growing faster. Keep asking for reviews daily.</span>`;
      }
    } else if (diff === 0) {
      calloutBg = '#FEF3C7'; calloutBorder = '#F59E0B';
      lineHtml = `Your review count is unchanged since your last report ${days} ${dayWord} ago (${newCount.toLocaleString('en-US')} reviews). <span style="color: #92400E; font-weight: 600;">Keep asking customers for reviews daily.</span>`;
    } else {
      calloutBg = '#FEF3C7'; calloutBorder = '#F59E0B';
      lineHtml = `Your review count is down ${Math.abs(diff).toLocaleString('en-US')} since your last report ${days} ${dayWord} ago (${oldCount.toLocaleString('en-US')} to ${newCount.toLocaleString('en-US')}). <span style="color: #92400E; font-weight: 600;">This is unusual. Some older reviews may have been removed by Google.</span>`;
    }

    velocityHtml = `<h3 style="font-size: 15px; color: #0F1729; margin: 24px 0 10px;">Your real review velocity</h3>
<div style="background: ${calloutBg}; border-left: 3px solid ${calloutBorder}; padding: 14px 18px; border-radius: 0 6px 6px 0;">
  <div style="font-size: 14px; line-height: 1.7; color: #1E293B;">${lineHtml}</div>
</div>`;
  } else {
    velocityHtml = '';
  }

  return `<div class="section">
  <h2 id="review-gap">Review gap analysis</h2>
  <p style="color: #6B7280; font-size: 13px; margin-bottom: 14px;">How far behind are you and how to catch up.</p>
  ${gapHtml}
  ${catchUpHtml}
  ${targetHtml}
  ${velocityHtml}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// renderRankingEstimate - estimated Google search position
// ─────────────────────────────────────────────────────────────────────
// Sorts you + competitors by score = rating * log10(reviews + 1) and
// shows where you land. Uses ONLY data fields already in the bundle.
//
// Layout: dark navy headline card, ranked list of all businesses with
// YOU highlighted in blue, position-specific guidance text, "how many
// more reviews to move up one position" calculator, mandatory legal
// disclaimer at the bottom.
//
// Graceful fallback: returns the "not enough data" notice when
// google_rating is missing or competitors_top5 is empty.
function renderRankingEstimate(data, profile) {
  if (!data) return '';
  const yourRating = typeof data.google_rating === 'number' ? data.google_rating : null;
  const yourReviews = typeof data.google_review_count === 'number' ? data.google_review_count : 0;
  const competitors = Array.isArray(data.competitors_top5) ? data.competitors_top5 : [];

  // Only bail out when there are no competitors - we can still show a
  // ranking when the subject has no rating/reviews (they get score 0).
  if (competitors.length === 0) {
    return `<div class="section">
  <h2 id="ranking-position">Your Google search position</h2>
  <p style="color: #6B7280; font-size: 14px;">Not enough competitor data to estimate your Google ranking.</p>
</div>`;
  }

  // When the subject has no rating or zero reviews their score is 0 so
  // they naturally fall to the bottom of the sorted list.
  const noReviewsCase = yourRating == null || yourReviews === 0;

  // CHANGE 3 - business-type label sourced from the profile registry
  // (profile.name is the same human label already shown in the report
  // header). Lowercased and trimmed for the inline search-example.
  // City sourced from data.city (set during address parsing); falls
  // back to "your area" when unparseable.
  const bizTypeRaw = (profile && typeof profile.name === 'string' && profile.name.trim())
    ? profile.name.trim()
    : 'your business type';
  const bizType = bizTypeRaw.toLowerCase();
  const cityLabel = (typeof data.city === 'string' && data.city.trim())
    ? data.city.trim()
    : 'your area';

  // Score function - rating × log10(reviews + 1). Reviews dominate at
  // scale, but a higher rating still tips a tie when review counts are
  // close.
  function score(rating, reviews) {
    return rating * Math.log10(reviews + 1);
  }

  // Build the combined list (you + competitors). Filter out competitor
  // entries missing rating or review_count so the sort is well-defined.
  const allEntries = competitors
    .filter((c) => c && typeof c.rating === 'number' && typeof c.review_count === 'number')
    .map((c) => ({
      name: c.name || 'Unknown',
      rating: c.rating,
      reviews: c.review_count,
      isYou: false,
      score: score(c.rating, c.review_count),
    }));
  allEntries.push({
    name: 'YOU',
    rating: yourRating,
    reviews: yourReviews,
    isYou: true,
    // Force score to 0 for zero-review businesses so they sort last.
    score: noReviewsCase ? 0 : score(yourRating, yourReviews),
  });

  // Sort by score descending - position 1 is the best score.
  allEntries.sort((a, b) => b.score - a.score);

  // 1-indexed position of the user.
  const yourPosition = allEntries.findIndex((e) => e.isYou) + 1;

  // Ranked list HTML. YOU row is highlighted blue with a 4px left
  // accent; competitor rows are plain white with a thin separator.
  const listHtml = allEntries.map((e, idx) => {
    const pos = idx + 1;
    // Guard: rating can be null for a zero-review subject business.
    const ratingStr = typeof e.rating === 'number' ? e.rating.toFixed(1) : null;
    const reviews = e.reviews.toLocaleString('en-US');
    if (e.isYou) {
      const ratingCell = ratingStr != null
        ? `<span style="color: #FCD34D;">&starf;</span> ${escapeHtml(ratingStr)}`
        : `<span style="color: #9CA3AF; font-style: italic;">no rating</span>`;
      return `<div style="display: grid; grid-template-columns: 50px 1fr 80px 110px; gap: 12px; align-items: center; padding: 14px 16px; background: #EFF6FF; border-left: 4px solid #2563EB; border-radius: 6px; margin-bottom: 6px;">
  <div style="font-weight: 700; color: #2563EB; font-size: 16px;">#${pos}</div>
  <div style="font-weight: 700; color: #2563EB;">YOU</div>
  <div style="font-size: 13px; color: #1E293B;">${ratingCell}</div>
  <div style="font-size: 13px; color: #1E293B; text-align: right;">${escapeHtml(reviews)} reviews</div>
</div>`;
    }
    return `<div style="display: grid; grid-template-columns: 50px 1fr 80px 110px; gap: 12px; align-items: center; padding: 12px 16px; background: #FFFFFF; border-bottom: 1px solid #F1F5F9;">
  <div style="font-weight: 700; color: #6B7280; font-size: 14px;">#${pos}</div>
  <div style="color: #1E293B; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
  <div style="font-size: 13px; color: #6B7280;"><span style="color: #FCD34D;">&starf;</span> ${escapeHtml(ratingStr)}</div>
  <div style="font-size: 13px; color: #6B7280; text-align: right;">${escapeHtml(reviews)} reviews</div>
</div>`;
  }).join('');

  // Position-specific guidance copy.
  let guidance;
  if (yourPosition === 1) {
    guidance = "You rank first in Google search for your area. Maintain your reviews and rating to stay here.";
  } else if (yourPosition <= 3) {
    const ahead = yourPosition - 1;
    guidance = `Customers searching Google see ${ahead} business${ahead === 1 ? '' : 'es'} before yours. Every new review you earn moves you one position higher.`;
  } else {
    guidance = "Most customers never scroll past position 3 in Google search. Getting more reviews is your single most important action right now.";
  }

  // "How many reviews to move up one position" - uses the user's exact
  // simple formula: next.review_count - your.review_count + 1. We only
  // show the line when that delta is positive (i.e., the competitor
  // above us has more reviews than us). When they're ahead by rating
  // alone with same/fewer reviews, the simple formula breaks down and
  // we skip the line rather than show a misleading 0 or negative.
  let movingUpHtml = '';
  if (yourPosition > 1) {
    const aboveIdx = yourPosition - 2;  // 1-indexed pos -> array index of slot above
    const above = allEntries[aboveIdx];
    if (above && typeof above.reviews === 'number') {
      const reviewsNeeded = above.reviews - yourReviews + 1;
      if (reviewsNeeded > 0) {
        movingUpHtml = `<p style="font-size: 14px; line-height: 1.6; color: #1E293B; margin: 14px 0 0;">You need <strong>${reviewsNeeded.toLocaleString('en-US')} more review${reviewsNeeded === 1 ? '' : 's'}</strong> to overtake ${escapeHtml(above.name)} and move to position #${yourPosition - 1}.</p>`;
      }
    }
  }

  // CHANGE 3 - explanation paragraph sits between the navy headline
  // card and the ranked list, inside the white card. The example search
  // query uses the Claude-generated competitor query (data.competitor_query)
  // so it reflects what a customer would actually type. That query carries
  // a " near <city> <state>" locality suffix from buildCompetitorQuery, so
  // we strip it here - the locality should appear only once, via " in
  // <city>" below. Falls back to the business-type label (truncated to 40
  // chars) when no competitor query is available. City always comes from
  // cityLabel (data.city), never the full address.
  const searchExample = (typeof data.competitor_query === 'string' && data.competitor_query.trim())
    ? data.competitor_query.trim().split(/\s+near\s+/i)[0].trim()
    : bizType.slice(0, 40);
  const explanationHtml = `<p style="font-size: 14px; line-height: 1.7; color: #1E293B; margin: 0 0 14px;">When a customer searches "<strong>${escapeHtml(searchExample)} in ${escapeHtml(cityLabel)}</strong>" Google shows businesses with the most reviews and highest ratings first. Businesses at position 1 get 10 times more clicks than businesses at position 4 or below. This is your estimated position based on your rating and review count compared to local competitors.</p>`;

  // Note shown when the subject has no reviews - explains why they
  // appear at the bottom and motivates the first review action.
  const noReviewsNoteHtml = noReviewsCase
    ? `<p style="font-size: 13px; line-height: 1.6; color: #92400E; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 6px; padding: 12px 14px; margin: 14px 0 0;">You currently have no Google reviews. Businesses with no reviews always appear below competitors in Google search. Every review you collect moves you up.</p>`
    : '';

  return `<div class="section">
  <h2 id="ranking-position">Your Google search position</h2>
  <div style="background: linear-gradient(135deg, #0F1729 0%, #1E3A8A 100%); color: white; padding: 22px 24px; border-radius: 10px 10px 0 0;">
    <div style="font-size: 12px; color: #93C5FD; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px;">Estimated position</div>
    <div style="font-size: 18px; font-weight: 600; color: #F8FAFC; line-height: 1.5;">You likely appear as result <span style="font-size: 28px; font-weight: 700; color: #FCD34D; margin: 0 4px;">#${yourPosition}</span> when customers search for your business type in your area.</div>
  </div>
  <div style="background: #FFFFFF; border: 1px solid #E5E7EB; border-top: 0; border-radius: 0 0 10px 10px; padding: 18px 20px;">
    ${explanationHtml}
    <div style="margin-bottom: 8px;">
      ${listHtml}
    </div>
    <p style="font-size: 14px; line-height: 1.6; color: #1E293B; margin: 18px 0 0;">${escapeHtml(guidance)}</p>
    ${movingUpHtml}
    ${noReviewsNoteHtml}
    <div style="font-size: 11px; color: #9CA3AF; margin-top: 18px; padding-top: 14px; border-top: 1px solid #F1F5F9; line-height: 1.5;">
      This is an estimate based on rating and review count data. Actual Google rankings vary by user location, search history, device, and other signals Google does not disclose publicly.
    </div>
  </div>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// renderHoursComparison - your hours vs. competitor hours
// ─────────────────────────────────────────────────────────────────────
// Parses Google's weekday_text strings (e.g. "Monday: 9:00 AM, 9:00 PM")
// and renders a compact day-by-day table. Highlights YOUR row in blue.
//
// Competitor weekday_text is not currently fetched by googlePlaces.js;
// when missing the table shows only YOUR row plus a "competitor hours
// data not available" notice. Future-proof for when competitor hours
// become available.
//
// Gap analysis section below the table generates plain-English insights
// (opens earlier, closes later, open when they're closed). Capped at
// 6-hour gaps to filter out 24h-business edge cases.
function renderHoursComparison(data) {
  if (!data) return '';
  const yourHours = Array.isArray(data.weekday_text) ? data.weekday_text : [];

  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Parse a weekday_text array into { Monday: "9-21", Tuesday: "Cls", ... }
  // 24-hour format for compact column display.
  function parseHours(weekdayText) {
    if (!Array.isArray(weekdayText)) return {};
    const result = {};
    for (const line of weekdayText) {
      if (typeof line !== 'string') continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const day = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      if (/closed/i.test(rest)) {
        result[day] = 'Cls';
        continue;
      }
      // FIX 2 - recognise 24-hour businesses BEFORE the AM/PM regex,
      // which can't match strings like "Open 24 hours" (no colon-
      // separated times). AmericInn Wyndham's weekday_text was
      // ["Monday: Open 24 hours", ...] and every day fell through to
      // the em-dash placeholder; cleanDashes then converted those
      // em-dashes to commas in the rendered HTML, so the table row
      // came out as "YOU: , , , , , , ,".
      if (/24\s*hour|24-hour|always open|open 24/i.test(rest)) {
        result[day] = '24h';
        continue;
      }
      // Match all time ranges in the string - handles split hours like
      // "11:00 AM – 2:30 PM, 4:30 – 9:00 PM" by finding every range.
      // Minutes are optional so "10 AM-4 PM" and "10:00 AM - 5:00 PM"
      // both parse correctly. [-–—] covers hyphen, en-dash, and em-dash.
      // AM/PM is optional on the OPEN side — Google sometimes omits it on
      // the second period of a split-hours string (e.g. "4:30 – 9:00 PM").
      // When absent, AM/PM is inferred from the close side:
      //   openH < closeH  → same period as close  ("4:30 – 9:00 PM" → PM)
      //   openH >= closeH → assume PM (afternoon session, e.g. "9:30 – 2 PM")
      // Groups: 1=open_h, 2=open_min?, 3=open_ampm?, 4=close_h, 5=close_min?, 6=close_ampm
      const timeRangeRe = /(\d+)(?::(\d+))?\s*(AM|PM)?\s*[-–—]+\s*(\d+)(?::(\d+))?\s*(AM|PM)/ig;
      const allRanges = [];
      let rm;
      while ((rm = timeRangeRe.exec(rest)) !== null) {
        const openH     = parseInt(rm[1], 10);
        const openMins  = rm[2] ? parseInt(rm[2], 10) : 0;
        const closeH    = parseInt(rm[4], 10);
        const closeMins = rm[5] ? parseInt(rm[5], 10) : 0;
        const openAmPm  = rm[3] ? rm[3].toUpperCase() : null;
        const closeAmPm = (rm[6] || '').toUpperCase();
        // Resolve close24 first so it is available when inferring openAmPm.
        let close24 = closeH;
        if (closeAmPm === 'PM' && closeH < 12) close24 += 12;
        if (closeAmPm === 'AM' && closeH === 12) close24 = 0;
        // Resolve open24. When openAmPm is absent infer from closeAmPm.
        let open24 = openH;
        if (openAmPm) {
          if (openAmPm === 'PM' && openH < 12) open24 += 12;
          if (openAmPm === 'AM' && openH === 12) open24 = 0;
        } else {
          const inferredAmPm = openH < closeH ? closeAmPm : 'PM';
          if (inferredAmPm === 'PM' && openH < 12) open24 += 12;
          if (inferredAmPm === 'AM' && openH === 12) open24 = 0;
        }
        const openStr  = openMins  > 0 ? `${open24}:${String(openMins).padStart(2, '0')}`  : `${open24}`;
        const closeStr = closeMins > 0 ? `${close24}:${String(closeMins).padStart(2, '0')}` : `${close24}`;
        allRanges.push(`${openStr}-${closeStr}`);
      }
      if (allRanges.length > 0) {
        result[day] = allRanges.join(', ');
        continue;
      }
      result[day] = '-';
    }
    return result;
  }

  // Numeric version for comparison logic.
  function parseHoursNumeric(weekdayText) {
    const parsed = parseHours(weekdayText);
    const result = {};
    for (const day of DAYS) {
      const val = parsed[day];
      if (!val || val === 'Cls' || val === '-') {
        result[day] = null;
        continue;
      }
      const m = val.match(/^(\d+)-(\d+)$/);
      if (!m) { result[day] = null; continue; }
      result[day] = { open: parseInt(m[1], 10), close: parseInt(m[2], 10) };
    }
    return result;
  }

  const yourParsed = parseHours(yourHours);
  const yourNumeric = parseHoursNumeric(yourHours);

  // Include ALL competitors (cap at 5). Check both weekday_text and
  // hours fields. Show N/A for any competitor with no hours data.
  const allCompetitors = (Array.isArray(data.competitors_top5) ? data.competitors_top5 : [])
    .filter((c) => c)
    .slice(0, 5);

  const compsWithHours = allCompetitors.filter((c) =>
    (Array.isArray(c.weekday_text) && c.weekday_text.length > 0) ||
    (Array.isArray(c.hours) && c.hours.length > 0)
  );
  const hasCompetitorHours = compsWithHours.length > 0;

  function cell(value, isYour) {
    const isClosed = value === 'Cls';
    const bg = isYour ? '#EFF6FF' : '#FFFFFF';
    const border = isYour ? '1px solid #DBEAFE' : '1px solid #F1F5F9';
    const color = isClosed ? '#DC2626' : '#1E293B';
    return `<td style="padding: 9px 4px; font-size: 12px; color: ${color}; text-align: center; background: ${bg}; border-bottom: ${border};">${escapeHtml(value || '-')}</td>`;
  }

  const headerRow = `<tr style="background: #F8FAFC;">
    <th style="padding: 9px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #6B7280; letter-spacing: 0.5px; text-transform: uppercase; border-bottom: 1px solid #E5E7EB;">Business</th>
    ${DAY_LABELS.map((d) => `<th style="padding: 9px 4px; font-size: 11px; font-weight: 700; color: #6B7280; text-align: center; border-bottom: 1px solid #E5E7EB;">${d}</th>`).join('')}
  </tr>`;

  // FIX 2 (part 2) - detect a "broken" YOUR row, every day either
  // unparsed (em-dash placeholder) or missing. Skip the broken row and
  // surface an info box below the table explaining what the user can
  // do. The 24h special case above means a real 24-hour business
  // shows '24h' across the row instead of falling into this branch.
  const yourHasAnyValid = yourHours.length > 0 && DAYS.some((d) => {
    const v = yourParsed[d];
    return v && v !== '-';
  });
  let yourRow;
  if (yourHours.length === 0) {
    // FIX 3 - no hours on GBP: show the YOU row with N/A for all 7 days
    // instead of hiding the section entirely.
    yourRow = `<tr>
    <td style="padding: 9px 12px; font-size: 13px; font-weight: 700; color: #2563EB; background: #EFF6FF; border-bottom: 1px solid #DBEAFE;">YOU</td>
    ${DAYS.map(() => `<td style="padding: 9px 4px; font-size: 12px; color: #9CA3AF; text-align: center; background: #EFF6FF; border-bottom: 1px solid #DBEAFE;">N/A</td>`).join('')}
  </tr>`;
  } else {
    const yourCells = DAYS.map((d) => cell(yourParsed[d] || '-', true)).join('');
    yourRow = yourHasAnyValid
      ? `<tr>
    <td style="padding: 9px 12px; font-size: 13px; font-weight: 700; color: #2563EB; background: #EFF6FF; border-bottom: 1px solid #DBEAFE;">YOU</td>
    ${yourCells}
  </tr>`
      : '';
  }

  let anyCompHasNoHours = false;
  const compRowsHtml = allCompetitors.map((c) => {
    // Prefer weekday_text; fall back to hours if present.
    const hoursSource = (Array.isArray(c.weekday_text) && c.weekday_text.length > 0)
      ? c.weekday_text
      : (Array.isArray(c.hours) && c.hours.length > 0 ? c.hours : null);
    if (!hoursSource) anyCompHasNoHours = true;
    const parsed = hoursSource ? parseHours(hoursSource) : {};
    const cells = DAYS.map((d) => cell(hoursSource ? (parsed[d] || '-') : 'N/A', false)).join('');
    return `<tr>
      <td style="padding: 9px 12px; font-size: 13px; color: #1E293B; border-bottom: 1px solid #F1F5F9; overflow: hidden; text-overflow: ellipsis; max-width: 140px;" title="${escapeHtml(c.name || '')}">${escapeHtml(c.name || 'Unknown')}</td>
      ${cells}
    </tr>`;
  }).join('');

  const naFootnoteHtml = anyCompHasNoHours
    ? `<p style="font-size:12px;color:#9CA3AF;margin-top:8px;">N/A means this competitor has not added their business hours to their Google Business Profile.</p>`
    : '';

  const tableHtml = `<div style="border: 1px solid #E5E7EB; border-radius: 8px; overflow-x: auto;">
    <table style="width: 100%; border-collapse: collapse; font-family: inherit; min-width: 540px;">
      <thead>${headerRow}</thead>
      <tbody>${yourRow}${compRowsHtml}</tbody>
    </table>
  </div>`;

  // Info box rendered below the table when YOUR row was suppressed
  // because no valid times were parsed. Same gray styling as the
  // "competitor hours not available" notice already in this section.
  const yourHoursUnreadableHtml = yourHours.length === 0
    ? `<div style="margin-top: 14px; padding: 12px 16px; background: #FEF9C3; border-left: 3px solid #EAB308; border-radius: 0 6px 6px 0; font-size: 13px; color: #713F12; line-height: 1.6;">Your hours are not listed on your Google Business Profile. Add them at <a href="https://business.google.com" target="_blank" rel="noopener" style="color: #713F12; text-decoration: underline;">business.google.com</a> to show customers when you are open.</div>`
    : (yourHasAnyValid ? '' :
      `<div style="margin-top: 14px; padding: 12px 16px; background: #F8FAFC; border-left: 3px solid #94A3B8; border-radius: 0 6px 6px 0; font-size: 13px; color: #475569; line-height: 1.6;">Your hours could not be read from Google automatically. This may mean you are open 24 hours or your hours are in an unusual format. Please verify your hours on your Google Business Profile.</div>`);


  // FIX 3 - Competitor hours diagnostic note.
  // Root cause: googlePlaces.js fetchNearbyCompetitors calls getDetails()
  // for each top-5 competitor (which DOES return weekday_text) but only
  // forwards `reviews` and `address` to the competitor object - weekday_text
  // is not included in the spread. Until that 1-line fix is applied to
  // googlePlaces.js (adding `weekday_text: details.weekday_text || null`),
  // this block will always show the fallback. The table code above already
  // handles weekday_text correctly when it is present.
  const noCompHoursFallback = hasCompetitorHours ? '' :
    `<div style="margin-top:12px;padding:10px 14px;background:#F8FAFC;border-left:3px solid #94A3B8;border-radius:0 6px 6px 0;font-size:13px;color:#475569;line-height:1.6;">
  Competitor hours not yet available. Your hours are shown above. Competitor hours will appear here in a future update.
</div>`;

  const hoursActionNote = `<div style="margin-top: 12px; padding: 12px 14px; background: #FFF7ED; border-left: 3px solid #F59E0B; border-radius: 0 6px 6px 0; font-size: 13px; color: #92400E; line-height: 1.6;">Check which competitors open earlier or close later than you. If a competitor serves customers during hours you are closed you are losing those customers permanently. Review the table above and adjust your hours to avoid leaving customers without a local option.</div>`;

  return `<div class="section">
  <h2 id="hours-comparison">Hours comparison</h2>
  <p style="color: #6B7280; font-size: 13px; margin-bottom: 14px;">You vs your top competitors. Times shown in 24-hour format.</p>
  ${tableHtml}
  ${naFootnoteHtml}
  ${yourHoursUnreadableHtml}
  ${noCompHoursFallback}
  ${hoursActionNote}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// renderSeasonalCalendar - 12-month demand bars + recommendations
// ─────────────────────────────────────────────────────────────────────
// Builds a 12-month demand array from existing climate + seasonality
// signals (peak_month, has_cold_winter, has_hot_summer,
// peak_tourist_season) using the rules from the user spec. Each month
// gets a level 1-4 (Low, Medium, High, PEAK) which drives bar width
// and color.
//
// Recommendations section maps months to actions (hire staff, run
// promotions, take vacation). Upcoming events from data.upcoming_events
// are listed at the bottom when present.
//
// Graceful fallback: when no seasonal signals are available the bars
// render flat-medium and a small notice appears at the top.
function renderSeasonalCalendar(data) {
  if (!data) return '';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // Start every month at Medium (level 2).
  const demand = new Array(12).fill(2);

  // Cold winter market - Jan, Feb, Dec drop to Low.
  if (data.has_cold_winter === true) {
    demand[0] = 1;
    demand[1] = 1;
    demand[11] = 1;
  }

  // Peak month - either from data.peak_month directly, or derived from
  // peak_tourist_season as a fallback. FIX 3A - googlePlaces.js emits
  // 3-letter month abbreviations like "Jul" via MONTH_NAMES, but this
  // reader was only checking against the FULL_MONTHS array ("July").
  // The format mismatch silently failed every report. Accept BOTH the
  // full name and the 3-letter abbreviation.
  let peakMonthIdx = null;
  if (typeof data.peak_month === 'string' && data.peak_month.trim()) {
    const lc = data.peak_month.toLowerCase();
    let idx = FULL_MONTHS.findIndex((m) => m.toLowerCase() === lc);
    if (idx === -1) {
      idx = MONTHS.findIndex((m) => m.toLowerCase() === lc);
    }
    if (idx >= 0) peakMonthIdx = idx;
  }
  // FIX 3B - peak_tourist_season is often a range like "Jun-Aug" or
  // "Dec-Feb". The prior fallback only matched single season-keyword
  // strings ("summer"/"fall"/"winter"/"spring"), so range formats fell
  // through to null. Parse the range first; if both endpoints resolve
  // to valid months, the middle month becomes peakMonthIdx and the
  // entire range is bumped to at least High (handles wrap-around like
  // Dec-Feb).
  if (peakMonthIdx == null && typeof data.peak_tourist_season === 'string'
      && data.peak_tourist_season.includes('-')) {
    const parts = data.peak_tourist_season.split('-');
    if (parts.length === 2) {
      const startAbbr = parts[0].trim().toLowerCase().slice(0, 3);
      const endAbbr = parts[1].trim().toLowerCase().slice(0, 3);
      const startIdx = MONTHS.findIndex((m) => m.toLowerCase() === startAbbr);
      const endIdx = MONTHS.findIndex((m) => m.toLowerCase() === endAbbr);
      if (startIdx >= 0 && endIdx >= 0) {
        // Middle month - handles wrap-around (Dec-Feb → Jan).
        let middleIdx;
        if (startIdx <= endIdx) {
          middleIdx = Math.floor((startIdx + endIdx) / 2);
          for (let i = startIdx; i <= endIdx; i++) {
            if (demand[i] < 3) demand[i] = 3;
          }
        } else {
          middleIdx = Math.floor((startIdx + endIdx + 12) / 2) % 12;
          for (let i = startIdx; i < 12; i++) {
            if (demand[i] < 3) demand[i] = 3;
          }
          for (let i = 0; i <= endIdx; i++) {
            if (demand[i] < 3) demand[i] = 3;
          }
        }
        peakMonthIdx = middleIdx;
        demand[peakMonthIdx] = 4;
      }
    }
  }
  if (peakMonthIdx == null && typeof data.peak_tourist_season === 'string') {
    const s = data.peak_tourist_season.toLowerCase();
    if (s.includes('summer')) peakMonthIdx = 6;       // July
    else if (s.includes('fall') || s.includes('autumn')) peakMonthIdx = 9; // October
    else if (s.includes('winter')) peakMonthIdx = 0;  // January
    else if (s.includes('spring')) peakMonthIdx = 3;  // April
  }

  if (peakMonthIdx != null) {
    demand[peakMonthIdx] = 4;
    const before = (peakMonthIdx - 1 + 12) % 12;
    const after = (peakMonthIdx + 1) % 12;
    if (demand[before] < 3) demand[before] = 3;
    if (demand[after] < 3) demand[after] = 3;
  }

  // Hot summer market - June, July, August at least High (3).
  if (data.has_hot_summer === true) {
    if (demand[5] < 3) demand[5] = 3;
    if (demand[6] < 3) demand[6] = 3;
    if (demand[7] < 3) demand[7] = 3;
  }


  const LEVEL_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'PEAK' };
  const LEVEL_COLORS = { 1: '#E2E8F0', 2: '#94A3B8', 3: '#3B82F6', 4: '#10B981' };

  const currentMonthIdx = new Date().getMonth();

  // Bar rows.
  const barRows = MONTHS.map((m, idx) => {
    const level = demand[idx];
    const label = LEVEL_LABELS[level];
    const color = LEVEL_COLORS[level];
    const barWidth = (level / 4) * 100;
    const isCurrent = idx === currentMonthIdx;
    const nowMarker = isCurrent
      ? '<span style="font-size: 11px; color: #2563EB; font-weight: 700; white-space: nowrap;">&larr; NOW</span>'
      : '';
    return `<div style="display: grid; grid-template-columns: 44px 1fr 70px 60px; gap: 12px; align-items: center; padding: 5px 0;">
      <div style="font-weight: ${isCurrent ? 700 : 500}; font-size: 13px; color: ${isCurrent ? '#0F1729' : '#1E293B'};">${m}</div>
      <div style="background: #F1F5F9; border-radius: 6px; overflow: hidden; height: 18px;">
        <div style="background: ${color}; height: 100%; width: ${barWidth}%; border-radius: 6px;"></div>
      </div>
      <div style="font-size: 12px; font-weight: 600; color: ${color};">${label}</div>
      <div>${nowMarker}</div>
    </div>`;
  }).join('');

  // Group months by level for recommendations.
  const peakMonths = [];
  const highMonths = [];
  const mediumMonths = [];
  const lowMonths = [];
  for (let i = 0; i < 12; i++) {
    if (demand[i] === 4) peakMonths.push(MONTHS[i]);
    else if (demand[i] === 3) highMonths.push(MONTHS[i]);
    else if (demand[i] === 2) mediumMonths.push(MONTHS[i]);
    else lowMonths.push(MONTHS[i]);
  }
  function listOrNone(arr) {
    return arr.length > 0 ? arr.join(', ') : 'No months identified';
  }

  // FIX 4A - promotion months. Previously this was
  // `[...lowMonths, ...mediumMonths]` which surfaced up to 11 of 12
  // months when peak detection failed and most months stayed at the
  // default "medium" level. Now: prefer the actual slow (low-demand)
  // months. If none exist, walk backwards from the first high/peak
  // month to find 1-2 "shoulder season" months - the period right
  // before demand spikes is when promotions move the needle most.
  // Cap at 3 either way so the list stays scannable.
  let promoMonths;
  if (lowMonths.length > 0) {
    promoMonths = lowMonths.slice(0, 3);
  } else {
    // No low months. Find the earliest peak/high month and pick 1-2
    // months immediately before it that aren't themselves high/peak.
    const firstHotIdx = peakMonths.length > 0
      ? MONTHS.indexOf(peakMonths[0])
      : (highMonths.length > 0 ? MONTHS.indexOf(highMonths[0]) : -1);
    if (firstHotIdx >= 0) {
      const shoulder = [];
      for (let offset = 1; offset <= 4 && shoulder.length < 2; offset++) {
        const idx = (firstHotIdx - offset + 12) % 12;
        if (demand[idx] < 3) shoulder.unshift(MONTHS[idx]);
      }
      promoMonths = shoulder;
    } else {
      // No signal at all - fall back to first 2 medium months (rare).
      promoMonths = mediumMonths.slice(0, 2);
    }
  }

  // FIX 4B - "Best months to stock up inventory" removed entirely.
  // The metric is meaningless for service businesses (hotels, salons,
  // dental, healthcare) and the underlying `beforePeakMonths` array
  // was already breaking with "No months identified" for any report
  // where the peak detection failed. Not useful enough to keep for any
  // sector - deleted.
  const recommendationsHtml = `<h3 style="font-size: 15px; color: #0F1729; margin: 22px 0 12px;">Business recommendations</h3>
<div style="background: #F8FAFC; border-radius: 8px; padding: 14px 18px;">
  <p style="margin: 0 0 8px; font-size: 14px; color: #1E293B; line-height: 1.6;"><strong>Best months to hire extra staff:</strong> ${escapeHtml(listOrNone([...peakMonths, ...highMonths]))}</p>
  <p style="margin: 0 0 8px; font-size: 14px; color: #1E293B; line-height: 1.6;"><strong>Best months to run promotions:</strong> ${escapeHtml(listOrNone(promoMonths))}</p>
  <p style="margin: 0; font-size: 14px; color: #1E293B; line-height: 1.6;"><strong>Quietest months for vacation:</strong> ${escapeHtml(listOrNone(lowMonths))}</p>
</div>`;

  // Upcoming events block - listed at the bottom with their date string.
  const events = Array.isArray(data.upcoming_events) ? data.upcoming_events : [];
  let eventsHtml = '';
  if (events.length > 0) {
    const eventLines = events.slice(0, 8).map((ev) => {
      if (!ev || typeof ev !== 'object') return '';
      const name = ev.name || ev.title || 'Event';
      const date = ev.date || ev.local_date || ev.start_date || '';
      return `<p style="margin: 0 0 6px; font-size: 14px; color: #1E293B; line-height: 1.6;">&#128197; ${escapeHtml(name)}${date ? `, ${escapeHtml(String(date))}` : ''}</p>`;
    }).filter(Boolean).join('');
    if (eventLines) {
      eventsHtml = `<h3 style="font-size: 15px; color: #0F1729; margin: 22px 0 12px;">Local events to plan around</h3>
<div>${eventLines}</div>`;
    }
  }

  // Notice when no seasonal signals fired (everything would be flat
  // medium-with-no-peak in that case).
  const hasAnySignal = peakMonthIdx != null || data.has_cold_winter === true || data.has_hot_summer === true;
  const noDataNotice = hasAnySignal ? '' :
    `<p style="font-size: 13px; color: #6B7280; margin-bottom: 12px;">Add your location to get more accurate seasonal demand data. Showing a flat baseline below.</p>`;

  return `<div class="section">
  <h2 id="seasonal-calendar">Seasonal demand calendar</h2>
  <p style="color: #6B7280; font-size: 13px; margin-bottom: 14px;">When customers need you most.</p>
  ${noDataNotice}
  <div style="background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 10px; padding: 18px 22px;">
    ${barRows}
  </div>
  ${recommendationsHtml}
  ${eventsHtml}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// renderCompetitorDeepDive - Claude competitor_deep_dive renderer
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
function renderCompetitorDeepDive(deepDive, outperformedCompetitors, data) {
  const items = Array.isArray(deepDive)
    ? deepDive.filter((d) => d && typeof d === 'object')
    : (deepDive && typeof deepDive === 'object' ? [deepDive] : []);
  const outperformed = Array.isArray(outperformedCompetitors)
    ? outperformedCompetitors.filter((n) => typeof n === 'string' && n.trim().length > 0)
    : [];

  if (items.length === 0 && outperformed.length === 0) return '';

  let html = '<div class="section">';
  html += '<h2 id="competitor-deep-dive">&#128269; Competitor deep dive</h2>';

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
          + ' - you outperform on both rating and review count. Keep doing what you are doing.'
          + '</div>'
          + '</div>';
  }

  html += '</div>';
  return html;
}

// ─────────────────────────────────────────────────────────────────────
// renderKeyRisks - Claude key_risks renderer
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
  <h2 id="key-risks">&#9888;&#65039; Key risks - and how to stay ahead</h2>
  <p style="color: #6B7280; font-size: 14px; margin-bottom: 20px;">Most businesses fail on execution, not ideas. These are the specific risks facing this business right now, with early warning signs so you can act before they become crises.</p>
  ${cardsHtml}
</div>`;
}

// ─────────────────────────────────────────────────────────────────────
// renderExecutionTemplates - Claude execution_templates renderer
// ─────────────────────────────────────────────────────────────────────
// Each template is a copy-paste-ready card with a clipboard button.
// The body is JSON-stringified into a data attribute and read back via
// JSON.parse on click - robust against quotes/newlines/template-literal
// chars in the body text.
const TEMPLATE_TYPE_ICONS = {
  email:        '&#128231;',  // 📧
  script:       '&#128483;',  // 🗣
  text_message: '&#128172;',  // 💬
  proposal:     '&#128196;',  // 📄
};

// Encode for safe embedding in an HTML attribute. escapeHtml handles
// & < > " ' but NOT newlines - browsers preserve attribute newlines
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
    // visible newlines). The copy button reads dataset.body - which
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

  // Phase 5 - Claude-enriched path
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
      .replace(/\[REASONABLE INFERENCE\]/g, '<span class="hmark hmark-inference">[REASONABLE INFERENCE]</span>');

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

  // Layer 2: WHY IT WORKS - pull each cited study's finding_summary.
  const studyBlocks = rec.study_ids.map((sid) => {
    const s = studies.find((x) => x.id === sid);
    if (!s) return `<div class="why-study"><strong>${escapeHtml(sid)}</strong> - not found in studies registry</div>`;
    const tierTag = s.tier === 3 ? ' <span class="tier3">[TIER-3 VENDOR]</span>' : '';
    const link = `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.id)}</a>`;
    return `<div class="why-study">
<p>${escapeHtml(s.finding_summary || s.claim || '')}</p>
<p class="meta"><strong>Magnitude:</strong> ${escapeHtml(rec.magnitude || '-')}<br>
<strong>Source:</strong> ${link} (Tier ${s.tier})${tierTag} - ${escapeHtml(s.citation)}</p>
</div>`;
  }).join('');

  // Layer 3: WHY YOUR BUSINESS - auto-derive from trigger + data fields.
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
  // Always-trigger (KPI-style) recs have no field comparisons.
  if (!layer3Bits.length && t.isAlwaysTrigger) {
    layer3Bits.push({
      tag: 'REASONABLE INFERENCE',
      text: 'Long-term KPI for this sector. Track this metric quarterly to confirm whether your business is on the recommended trajectory.',
    });
  }
  // Generic inference line (one per rec) - sector pattern.
  layer3Bits.push({
    tag: 'REASONABLE INFERENCE',
    text: `This pattern is typical for businesses like yours; the exact lift you'll see depends on execution quality and current baseline.`,
  });
  const layer3Html = layer3Bits.map((b) => {
    const cls = b.tag.toLowerCase().replace(/\s+/g, '-');
    return `<div class="honesty honesty-${cls}"><span class="hmark">[${escapeHtml(b.tag)}]</span> ${b.text}</div>`;
  }).join('');

  const extraTagHtml = extraTags.length
    ? extraTags.map((t) => `<span class="extra-tag extra-tag-${t.cls}">${escapeHtml(t.label)}</span>`).join(' ')
    : '';

  // Money estimate - wired in CHANGE 6. Reserved slot here.
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

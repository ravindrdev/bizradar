/* db.js — PostgreSQL connection pool for GrowthIM.

   Single shared pg.Pool keyed off process.env.DATABASE_URL. Consumers
   require this module and call pool.query(...) / pool.connect() — no
   need to manage connections directly.

   SSL handling — auto-detected from the host in DATABASE_URL:
     - hostname is localhost / 127.0.0.1 / ::1  →  no SSL (local Postgres
       usually has no TLS configured; forcing SSL would error with
       "server does not support SSL connections").
     - any other hostname (Railway proxy, AWS RDS, Heroku, Supabase,
       etc.)  →  SSL with rejectUnauthorized:false. Managed Postgres
       hosts terminate TLS with cert chains Node's bundled CA store
       often doesn't recognize; rejectUnauthorized:true would 401
       every connection. False is the standard recommendation for
       client connections to managed services.
     - DATABASE_URL not set OR malformed  →  fall back to NODE_ENV
       (production = SSL on, else SSL off) so the prior contract still
       works for callers that rely on NODE_ENV.

   This means you do NOT need to set NODE_ENV=production locally just
   to talk to Railway's managed Postgres — the URL itself tells us.

   The module also wires a top-level 'error' listener on the pool so an
   idle-client failure (Railway reboots, network blips) logs once
   instead of crashing the Node process with an unhandled error event.

   DATABASE_URL absence is a soft failure here — we log a warning but
   still export a Pool. The Pool will fail on the first query attempt
   with a clear error rather than crashing at require-time. This lets
   server.js boot even when the DB isn't configured yet (the rest of
   the app — Layer 0, Places, Claude enrichment — doesn't depend on
   Postgres). */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn(
    '[db] DATABASE_URL is not set — pool created without a connection ' +
    'string; every query will fail until DATABASE_URL is configured.'
  );
}

// Decide whether to enable SSL by inspecting the URL host. Falls back
// to NODE_ENV when DATABASE_URL is absent or unparseable so existing
// callers that relied on NODE_ENV=production still work.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
let useSSL;
let sslReason;
if (!connectionString) {
  useSSL = process.env.NODE_ENV === 'production';
  sslReason = useSSL
    ? 'no DATABASE_URL — NODE_ENV=production fallback'
    : 'no DATABASE_URL — NODE_ENV not production';
} else {
  try {
    const u = new URL(connectionString);
    const host = (u.hostname || '').toLowerCase();
    if (LOCAL_HOSTS.has(host)) {
      useSSL = false;
      sslReason = `host "${host}" is local`;
    } else {
      useSSL = true;
      sslReason = `host "${host}" is remote`;
    }
  } catch (err) {
    // Malformed connection string — let pg surface the real parse
    // error on first query; fall back to NODE_ENV-based SSL choice
    // so we don't break either local or production callers.
    useSSL = process.env.NODE_ENV === 'production';
    sslReason = `URL parse failed (${err.message}) — NODE_ENV fallback`;
  }
}
console.log(`[db] SSL ${useSSL ? 'ENABLED' : 'disabled'} (${sslReason})`);

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  // Pool sizing + timeouts (audit fix). max/connectionTimeoutMillis are
  // pool-level; statement_timeout/query_timeout/idle_in_transaction_session_timeout
  // are pass-through Client options pg applies per connection. 30s is safe: no
  // legitimate query runs longer (report-save is a single INSERT; boot DDL is
  // IF NOT EXISTS on small tables) and there are no long-lived transactions for
  // idle_in_transaction_session_timeout to interrupt.
  max: 15,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  query_timeout: 30000,
  idle_in_transaction_session_timeout: 30000,
});

// Idle-client error handler — fires when a pooled connection dies
// between requests (network drop, server reboot, etc.). Without this
// listener Node crashes with an unhandled 'error' event.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

module.exports = pool;

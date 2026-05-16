/* db_setup.js — one-shot schema bootstrap for BizRadar.

   Creates the three core tables (users, reports, payments) with
   IF NOT EXISTS so the script is idempotent and safe to re-run on
   every deploy. Foreign keys cascade-delete or set-null as the
   business semantics require:
     - reports.user_id     → users(id)   ON DELETE CASCADE
       (if a user is wiped we don't want orphan reports)
     - payments.user_id    → users(id)   ON DELETE CASCADE
       (same — payment rows are user-bound)
     - payments.report_id  → reports(id) ON DELETE SET NULL
       (we keep the payment audit row even if the report it paid
        for was deleted — financial records survive content cleanup)

   Run with:  node db_setup.js
   Re-running is safe (IF NOT EXISTS). The script verifies the
   connection with SELECT NOW() before exiting so a misconfigured
   DATABASE_URL surfaces immediately. */

require('dotenv').config({ override: true });
const pool = require('./db');

const STATEMENTS = [
  {
    name: 'users',
    sql: `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      google_id VARCHAR(255) UNIQUE,
      password_hash VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  },
  {
    name: 'reports',
    sql: `CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      business_name VARCHAR(255),
      address TEXT,
      naics_code VARCHAR(10),
      report_json TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  },
  {
    name: 'payments',
    sql: `CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
      amount_cents INTEGER,
      status VARCHAR(50) DEFAULT 'pending',
      stripe_payment_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  },
];

(async () => {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set in environment');
    }

    // Connection sanity check FIRST so a bad URL fails before we run
    // any DDL — better error message than letting the first CREATE
    // TABLE timeout with a generic "ENOTFOUND" or "ECONNREFUSED".
    const ping = await pool.query('SELECT NOW() AS now');
    console.log('[db-setup] connection OK — server time:', ping.rows[0].now);

    for (const stmt of STATEMENTS) {
      const t0 = Date.now();
      await pool.query(stmt.sql);
      console.log(
        `[db-setup] table "${stmt.name}" ready (${Date.now() - t0}ms)`
      );
    }

    // Final verification — list the just-created tables back from
    // information_schema so we know they really exist with the
    // expected names (and didn't quietly skip due to a permission
    // issue with IF NOT EXISTS).
    const verify = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name IN ('users','reports','payments')
       ORDER BY table_name`
    );
    const found = verify.rows.map((r) => r.table_name);
    console.log('[db-setup] verified tables in public schema:', found.join(', '));

    if (found.length !== 3) {
      throw new Error(
        `expected 3 tables (users, reports, payments) but found: ${found.join(', ') || 'none'}`
      );
    }

    console.log('[db-setup] ✅ schema setup complete');
  } catch (err) {
    console.error('[db-setup] ❌ failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

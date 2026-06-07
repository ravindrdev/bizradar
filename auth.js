/* auth.js - email/password auth core for GrowthIM.

   Pure logic - no Express, no HTTP. Used by authRoutes.js.

   Functions:
     generateOTP()                                   → 6-digit string
     sendOTPEmail(email, otp, type)                  → console.log fallback
     createPendingUser(name, email, password)        → inserts unverified user + OTP
     verifySignupOTP(email, otp)                     → marks verified, returns JWT
     deleteUnverifiedUser(email)                     → cleanup on page-close
     loginUser(email, password)                      → returns JWT on success
     sendPasswordResetOTP(email)                     → OTP for verified user only
     verifyResetOTP(email, otp)                      → checks without clearing
     resetPassword(email, otp, newPassword)          → final OTP check + password update
     generateJWT(userId)                             → 7-day signed token

   Security notes:
     - bcrypt rounds: 10 for passwords, 8 for OTPs (OTPs expire in 10 min,
       so the speed-vs-safety tradeoff is different).
     - OTP is hashed at rest. The plain 6-digit code is sent over email
       and discarded; only its bcrypt hash sits in otp_code. This means
       even a DB dump leak can't be replayed against the 10-minute
       window.
     - All errors thrown here have user-safe messages, callers re-throw
       them to the client without leaking schema info. */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const pool = require('./db');

const PASSWORD_ROUNDS = 10;
const OTP_ROUNDS = 8;
const OTP_TTL_MIN = 10;
const JWT_EXPIRY = '7d';

// ── SMTP transporter (lazy) ─────────────────────────────────────────
// Hardcoded for Namecheap Private Email. host/port/secure are no
// longer configurable via env, only the credentials (SMTP_USER /
// SMTP_PASS) come from environment so production secrets stay out of
// version control. SMTP_HOST and SMTP_PORT remain in .env for
// documentation but are unread by this code. If either credential is
// missing, sendOTPEmail falls back to console.log so local dev works
// without a mail server.
let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  cachedTransporter = nodemailer.createTransport({
    host: 'mail.privateemail.com',
    port: 465,
    secure: true, // SMTPS - TLS from the first byte, required by Namecheap on 465
    auth: { user, pass },
    // Audit fix A1 - bounded SMTP timeouts. Without these a hung
    // Namecheap socket holds /auth/signup for Node's default socket
    // timeout (~5 min) before failing, leaving the user staring at a
    // spinner with no feedback.
    connectionTimeout: 10000, // 10 s - TCP/TLS handshake
    greetingTimeout:   10000, // 10 s - wait for SMTP server greeting
    socketTimeout:     15000, // 15 s - between any two read/write events
  });
  return cachedTransporter;
}

// ── Helpers ─────────────────────────────────────────────────────────
function generateOTP() {
  // 6-digit numeric string, zero-padded so leading zeros aren't lost.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function hashOTP(otp) {
  return bcrypt.hash(otp, OTP_ROUNDS);
}

async function verifyOTPHash(otp, hash) {
  if (!otp || !hash) return false;
  try { return await bcrypt.compare(otp, hash); } catch (_) { return false; }
}

function generateJWT(userId, tokenVersion) {
  return jwt.sign({ uid: userId, tv: (tokenVersion || 0) }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyJWT(token) {
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return null; }
}

async function sendOTPEmail(email, otp, type) {
  const transporter = getTransporter();
  const subject =
    type === 'reset' ? 'GrowthIM - reset your password'
    : type === 'login' ? 'GrowthIM - your login verification code'
    : 'GrowthIM - verify your email';
  const otpLabel =
    type === 'reset' ? 'password reset'
    : type === 'login' ? 'login verification'
    : 'verification';
  const body =
`Your GrowthIM ${otpLabel} code is:

    ${otp}

This code expires in ${OTP_TTL_MIN} minutes. If you didn't request this, you can safely ignore this email.

- GrowthIM`;

  if (!transporter) {
    // SMTP not configured - log OTP so local dev can complete the flow.
    console.log(`\n[auth] SMTP not configured. OTP for ${email} (${type}): ${otp}\n`);
    return;
  }
  await transporter.sendMail({
    from: 'GrowthIM <noreply@growthim.com>',
    to: email,
    subject,
    text: body,
  });
  console.log(`[auth] OTP email sent to ${email} (${type})`);
}

function makeUnsubToken(userId) {
  return jwt.sign({ uid: userId, scope: 'unsub' }, process.env.JWT_SECRET, { expiresIn: '180d' });
}

async function sendWelcomeEmail(email, name, userId) {
  const transporter = getTransporter();
  const unsubUrl = `https://growthim.com/unsubscribe?t=${makeUnsubToken(userId)}`;
  const firstName = (name || '').split(' ')[0] || 'there';
  const subject = 'Welcome to GrowthIM';
  const text = [
    `Hi ${firstName},`,
    ``,
    `Thanks for signing up for GrowthIM. You now have access to detailed market intelligence reports for any US small business.`,
    ``,
    `Each report digs into a local market with real public and government data, then turns it into a clear plan you can act on.`,
    ``,
    `TWO WAYS TO USE IT`,
    ``,
    `Rate My Business. A full breakdown of one business and its local market:`,
    `- Market Overview`,
    `- Strengths`,
    `- Competitive context`,
    `- Your area: competitors nearby`,
    `- Your Google search position`,
    `- Review gap analysis`,
    `- Location and market`,
    `- Walk-up traffic potential`,
    `- Seasonal demand calendar`,
    `- Market intelligence charts`,
    `- Priority Actions`,
    `- 90-Day Action Plan`,
    `- Opportunities nobody in your market is doing`,
    ``,
    `Priority Actions and the Opportunities section are the ones to watch: specific moves built for your business, and openings in your market that nobody is acting on yet.`,
    ``,
    // TEMP: hidden for launch
    // `Find the Best Business to Start. Give it a city and state:`,
    // `- The top 10 business ideas, ranked`,
    // `- A deep dive on the #1, with tactical opportunities, quick wins, and hidden gaps`,
    // `- Who's driving through the area, plus local events and partnership targets`,
    ``,
    `Each report runs about 50 pages and stays in your dashboard for a year.`,
    ``,
    `Questions? Reach us at support@growthim.com.`,
    ``,
    `GrowthIM`,
    ``,
    `You're receiving this because you created a GrowthIM account. Don't want marketing emails? Unsubscribe: ${unsubUrl}`,
    `You'll still receive essential account emails like login and password codes.`,
  ].join('\n');

  const html = `
<div style="background-color:#eef0f3;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;border-top:4px solid #16a34a;">
    <tr><td style="background-color:#111827;padding:26px 32px;">
      <div style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.3px;">GrowthIM</div>
      <div style="color:#9aa4b2;font-size:10px;font-weight:600;letter-spacing:2px;margin-top:4px;">GROWTH INTELLIGENCE MACHINE</div>
    </td></tr>
    <tr><td style="padding:34px 32px 4px 32px;">
      <h1 style="margin:0 0 14px 0;font-size:21px;line-height:1.3;color:#111827;font-weight:700;">Welcome to GrowthIM, ${firstName}</h1>
      <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#4b5563;">Thanks for signing up. You now have access to detailed market intelligence reports for any US small business.</p>
      <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#4b5563;">Each report digs into a local market with real public and government data, then turns it into a clear plan you can act on.</p>
      <p style="margin:0 0 4px 0;font-size:13px;font-weight:700;letter-spacing:0.5px;color:#16a34a;">TWO WAYS TO USE IT</p>
    </td></tr>
    <tr><td style="padding:12px 32px 0 32px;">
      <p style="margin:0 0 6px 0;font-size:15px;line-height:1.5;color:#111827;font-weight:700;">Rate My Business.</p>
      <p style="margin:0 0 10px 0;font-size:14px;line-height:1.6;color:#4b5563;">A full breakdown of one business and its local market:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Market Overview</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Strengths</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Competitive context</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Your area: competitors nearby</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Your Google search position</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Review gap analysis</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Location and market</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Walk-up traffic potential</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Seasonal demand calendar</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Market intelligence charts</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Priority Actions</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">90-Day Action Plan</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Opportunities nobody in your market is doing</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:14px 32px 0 32px;">
      <p style="margin:0;font-size:14px;line-height:1.6;color:#4b5563;">Priority Actions and the Opportunities section are the ones to watch: specific moves built for your business, and openings in your market that nobody is acting on yet.</p>
    </td></tr>
    ${/* TEMP: hidden for launch
    <tr><td style="padding:22px 32px 0 32px;">
      <p style="margin:0 0 6px 0;font-size:15px;line-height:1.5;color:#111827;font-weight:700;">Find the Best Business to Start.</p>
      <p style="margin:0 0 10px 0;font-size:14px;line-height:1.6;color:#4b5563;">Give it a city and state:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">The top 10 business ideas, ranked</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">A deep dive on the #1, with tactical opportunities, quick wins, and hidden gaps</td></tr>
        <tr><td valign="top" width="18" style="font-size:14px;line-height:1.8;color:#16a34a;">&bull;</td><td style="font-size:14px;line-height:1.8;color:#4b5563;">Who's driving through the area, plus local events and partnership targets</td></tr>
      </table>
    </td></tr>
    */ ''}
    <tr><td style="padding:18px 32px 0 32px;">
      <p style="margin:0;font-size:14px;line-height:1.6;color:#4b5563;">Each report runs about 50 pages and stays in your dashboard for a year.</p>
    </td></tr>
    <tr><td style="padding:26px 32px 30px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background-color:#16a34a;border-radius:8px;">
        <a href="https://growthim.com/dashboard" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Go to your dashboard</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:0 32px 30px 32px;">
      <div style="border-top:1px solid #eef0f3;padding-top:20px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#4b5563;">Questions? Reach us at <a href="mailto:support@growthim.com" style="color:#16a34a;text-decoration:none;font-weight:600;">support@growthim.com</a>.</p>
        <p style="margin:14px 0 0 0;font-size:14px;color:#111827;font-weight:600;">GrowthIM</p>
      </div>
    </td></tr>
    <tr><td style="background-color:#f9fafb;padding:18px 32px;">
      <p style="margin:0;font-size:12px;line-height:1.6;color:#9aa4b2;">You're receiving this because you created a GrowthIM account. Don't want marketing emails? <a href="${unsubUrl}" style="color:#9aa4b2;text-decoration:underline;">Unsubscribe</a>. You'll still receive essential account emails like login and password codes.</p>
    </td></tr>
  </table>
</div>`;

  if (!transporter) { console.log(`[auth] SMTP not configured. Welcome email skipped for ${email}.`); return; }
  await transporter.sendMail({ from: 'GrowthIM <noreply@growthim.com>', to: email, subject, text, html });
  console.log(`[auth] welcome email sent to ${email}`);
}

async function unsubscribeByToken(token) {
  if (!token) return { ok: false };
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return { ok: false }; }
  if (!payload || payload.scope !== 'unsub' || !payload.uid) return { ok: false };
  try {
    const { rows } = await pool.query(`SELECT name, email FROM users WHERE id = $1`, [payload.uid]);
    if (!rows.length) return { ok: false };
    await pool.query(`UPDATE users SET marketing_opt_out = true WHERE id = $1`, [payload.uid]);
    await pool.query(
      `UPDATE newsletter_subscribers SET unsubscribed_at = now() WHERE lower(email) = lower($1)`,
      [rows[0].email]
    );
    return { ok: true, name: rows[0].name, email: rows[0].email };
  }
  catch (e) { console.error('[unsubscribe] db update failed:', e.message); return { ok: false }; }
}

async function subscribeEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) || clean.length > 254) {
    return { ok: false, error: 'Please enter a valid email.' };
  }
  await pool.query(
    `INSERT INTO newsletter_subscribers (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET unsubscribed_at = NULL`,
    [clean]
  );
  return { ok: true };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ── Signup ──────────────────────────────────────────────────────────
async function createPendingUser(name, email, password) {
  const e = normalizeEmail(email);
  if (!e || !password) throw new Error('Email and password required');

  // Reject if a VERIFIED account already exists with this email.
  const existing = await pool.query(
    `SELECT id, email_verified FROM users WHERE email = $1`,
    [e]
  );
  const verifiedRow = existing.rows.find((r) => r.email_verified === true);
  if (verifiedRow) throw new Error('Email already registered');

  // Wipe any prior UNVERIFIED row for this email so resend works.
  await pool.query(
    `DELETE FROM users WHERE email = $1 AND email_verified = false`,
    [e]
  );

  const passwordHash = await bcrypt.hash(password, PASSWORD_ROUNDS);
  const otp = generateOTP();
  const otpHash = await hashOTP(otp);
  const expires = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

  // otp_attempts is reset to 0 by the column default on every fresh
  // INSERT (audit fix A3 - bounded OTP brute force).
  const ins = await pool.query(
    `INSERT INTO users (name, email, password_hash, email_verified, otp_code, otp_expires, otp_type, otp_attempts, created_at)
     VALUES ($1, $2, $3, false, $4, $5, 'signup', 0, NOW())
     RETURNING id`,
    [name || null, e, passwordHash, otpHash, expires]
  );
  const newUserId = ins.rows[0].id;

  // Audit fix A2 - if SMTP fails, roll back the pending row so the
  // user can immediately re-attempt the signup. Without this rollback
  // the row sits in the DB with a valid OTP they never received,
  // blocking the email for 10 minutes.
  try {
    await sendOTPEmail(e, otp, 'signup');
  } catch (err) {
    console.error('[auth] SMTP send failed during signup:', err.message);
    await pool.query(`DELETE FROM users WHERE id = $1`, [newUserId]).catch(() => {});
    throw new Error('Could not send verification email. Please try again.');
  }
  return { success: true };
}

async function verifySignupOTP(email, otp) {
  const e = normalizeEmail(email);
  const r = await pool.query(
    `SELECT id, name, email, otp_code, otp_expires, otp_type, otp_attempts, email_verified, token_version
     FROM users WHERE email = $1 AND email_verified = false AND otp_type = 'signup'`,
    [e]
  );
  const user = r.rows[0];
  if (!user) throw new Error('No pending signup');
  // Audit fix A3 - bounded OTP brute force. After 5 incorrect attempts
  // we lock the row out and force the user to request a fresh code
  // (via Resend, which calls createPendingUser and resets the counter).
  if ((user.otp_attempts || 0) >= 5) {
    throw new Error('Too many incorrect attempts. Request a new code.');
  }
  if (!user.otp_expires || new Date(user.otp_expires) < new Date()) {
    throw new Error('OTP expired');
  }
  const ok = await verifyOTPHash(String(otp || ''), user.otp_code);
  if (!ok) {
    await pool.query(
      `UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1`,
      [user.id]
    ).catch(() => {});
    throw new Error('Incorrect code');
  }

  await pool.query(
    `UPDATE users
     SET email_verified = true, otp_code = NULL, otp_expires = NULL, otp_type = NULL, otp_attempts = 0
     WHERE id = $1`,
    [user.id]
  );

  // Fire the welcome email in its own try/catch so a send failure NEVER blocks
  // verification (unlike createPendingUser, which rolls back the row on OTP
  // failure). Sent unconditionally: the user just verified and cannot have
  // unsubscribed yet — marketing_opt_out gates FUTURE marketing sends, not this.
  sendWelcomeEmail(user.email, user.name, user.id).catch((e) => console.error('[auth] welcome email failed:', e.message));
  subscribeEmail(user.email).catch((e) => console.error('[auth] newsletter subscribe failed:', e.message));

  const token = generateJWT(user.id, user.token_version);
  return { token, user: { id: user.id, name: user.name, email: user.email } };
}

async function deleteUnverifiedUser(email) {
  const e = normalizeEmail(email);
  if (!e) return { success: false };
  const r = await pool.query(
    `DELETE FROM users WHERE email = $1 AND email_verified = false`,
    [e]
  );
  return { success: true, deleted: r.rowCount };
}

// ── Login ───────────────────────────────────────────────────────────
async function loginUser(email, password) {
  const e = normalizeEmail(email);
  const r = await pool.query(
    `SELECT id, name, email, password_hash, email_verified, token_version FROM users WHERE email = $1`,
    [e]
  );
  const user = r.rows[0];
  if (!user) throw new Error('Invalid credentials');
  if (!user.email_verified) throw new Error('Please verify your email first');
  const ok = await bcrypt.compare(String(password || ''), user.password_hash || '');
  if (!ok) throw new Error('Invalid credentials');

  const token = generateJWT(user.id, user.token_version);
  return { token, user: { id: user.id, name: user.name, email: user.email } };
}

// ── Forgot password ─────────────────────────────────────────────────
async function sendPasswordResetOTP(email) {
  const e = normalizeEmail(email);
  const r = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND email_verified = true`,
    [e]
  );
  const user = r.rows[0];
  if (!user) throw new Error('Email not found');

  const otp = generateOTP();
  const otpHash = await hashOTP(otp);
  const expires = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

  // Audit fix A3 - reset otp_attempts on every new reset code so the
  // lockout counter is per-code, not per-account-lifetime.
  await pool.query(
    `UPDATE users SET otp_code = $1, otp_expires = $2, otp_type = 'reset', otp_attempts = 0 WHERE id = $3`,
    [otpHash, expires, user.id]
  );
  // Audit fix A2 - surface a user-safe error and clear the reset
  // state if the email never makes it out (SMTP outage, etc.).
  try {
    await sendOTPEmail(e, otp, 'reset');
  } catch (err) {
    console.error('[auth] SMTP send failed during password reset:', err.message);
    await pool.query(
      `UPDATE users SET otp_code = NULL, otp_expires = NULL, otp_type = NULL WHERE id = $1`,
      [user.id]
    ).catch(() => {});
    throw new Error('Could not send reset email. Please try again.');
  }
  return { success: true };
}

async function verifyResetOTP(email, otp) {
  const e = normalizeEmail(email);
  const r = await pool.query(
    `SELECT id, otp_code, otp_expires, otp_type, otp_attempts
     FROM users WHERE email = $1 AND email_verified = true AND otp_type = 'reset'`,
    [e]
  );
  const user = r.rows[0];
  if (!user) throw new Error('No active reset request');
  // Audit fix A3 - bounded brute force on the reset code.
  if ((user.otp_attempts || 0) >= 5) {
    throw new Error('Too many incorrect attempts. Request a new code.');
  }
  if (!user.otp_expires || new Date(user.otp_expires) < new Date()) {
    throw new Error('OTP expired');
  }
  const ok = await verifyOTPHash(String(otp || ''), user.otp_code);
  if (!ok) {
    await pool.query(
      `UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1`,
      [user.id]
    ).catch(() => {});
    throw new Error('Incorrect code');
  }
  // NOTE: do NOT clear OTP here - resetPassword() will re-verify and clear.
  return true;
}

async function resetPassword(email, otp, newPassword) {
  const e = normalizeEmail(email);
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  // Re-verify OTP before changing the password - protects against
  // someone hitting /auth/reset-password directly without doing the
  // OTP verification step.
  await verifyResetOTP(e, otp);
  const passwordHash = await bcrypt.hash(newPassword, PASSWORD_ROUNDS);
  // Bump token_version so EVERY previously-issued JWT for this account is
  // invalidated on its next request (the auth middleware compares the
  // token's tv claim to this column). The resetting user simply logs in
  // again and the fresh login reads the new version.
  await pool.query(
    `UPDATE users
     SET password_hash = $1, otp_code = NULL, otp_expires = NULL, otp_type = NULL, otp_attempts = 0,
         token_version = token_version + 1
     WHERE email = $2
     RETURNING token_version`,
    [passwordHash, e]
  );
  return { success: true };
}

// ── Admin login OTP (mandatory 2FA for the admin account) ───────────
// Mirrors sendPasswordResetOTP: issues a fresh login OTP on the
// (already credential-validated) admin's verified row and emails it.
// On SMTP failure it clears the otp_* columns and throws a user-safe
// error — the SAME rollback contract as signup/reset, so a send outage
// never leaves a dangling code. The caller (/auth/login) only reaches
// here AFTER loginUser() has verified the password, so this can't be
// used to spray OTP emails without valid admin credentials.
async function startLoginOTP(email) {
  const e = normalizeEmail(email);
  const r = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND email_verified = true`,
    [e]
  );
  const user = r.rows[0];
  if (!user) throw new Error('Invalid credentials');

  const otp = generateOTP();
  const otpHash = await hashOTP(otp);
  const expires = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

  // otp_attempts reset to 0 so the 5-attempt lockout is per-code.
  await pool.query(
    `UPDATE users SET otp_code = $1, otp_expires = $2, otp_type = 'login', otp_attempts = 0 WHERE id = $3`,
    [otpHash, expires, user.id]
  );
  // Audit fix A2 pattern — surface a user-safe error and clear the login
  // OTP state if the email never makes it out (SMTP outage, etc.).
  try {
    await sendOTPEmail(e, otp, 'login');
  } catch (err) {
    console.error('[auth] SMTP send failed during admin login:', err.message);
    await pool.query(
      `UPDATE users SET otp_code = NULL, otp_expires = NULL, otp_type = NULL WHERE id = $1`,
      [user.id]
    ).catch(() => {});
    throw new Error('Could not send verification email. Please try again.');
  }
  return { success: true };
}

// verifyLoginOTP — terminal step of admin 2FA. Mirrors verifyResetOTP's
// lockout/expiry/verify logic, but on success it CLEARS the otp_* state
// and issues the 7-day session JWT (like verifySignupOTP). Only matches
// rows whose otp_type = 'login', so a reset code can never satisfy it
// (and vice-versa).
async function verifyLoginOTP(email, otp) {
  const e = normalizeEmail(email);
  const r = await pool.query(
    `SELECT id, name, email, otp_code, otp_expires, otp_type, otp_attempts, token_version
     FROM users WHERE email = $1 AND email_verified = true AND otp_type = 'login'`,
    [e]
  );
  const user = r.rows[0];
  if (!user) throw new Error('No active login request');
  // Bounded brute force — 5 attempts per code, same as signup/reset.
  if ((user.otp_attempts || 0) >= 5) {
    throw new Error('Too many incorrect attempts. Request a new code.');
  }
  if (!user.otp_expires || new Date(user.otp_expires) < new Date()) {
    throw new Error('OTP expired');
  }
  const ok = await verifyOTPHash(String(otp || ''), user.otp_code);
  if (!ok) {
    await pool.query(
      `UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1`,
      [user.id]
    ).catch(() => {});
    throw new Error('Incorrect code');
  }
  // Success — clear OTP state and issue the session token.
  await pool.query(
    `UPDATE users SET otp_code = NULL, otp_expires = NULL, otp_type = NULL, otp_attempts = 0 WHERE id = $1`,
    [user.id]
  );
  const token = generateJWT(user.id, user.token_version);
  return { token, user: { id: user.id, name: user.name, email: user.email } };
}

// ── User lookup (used by /auth/me middleware) ───────────────────────
async function findUserById(id) {
  if (!id) return null;
  const r = await pool.query(
    `SELECT id, name, email, email_verified, created_at, token_version
     FROM users WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

module.exports = {
  generateOTP,
  sendOTPEmail,
  createPendingUser,
  verifySignupOTP,
  deleteUnverifiedUser,
  loginUser,
  startLoginOTP,
  verifyLoginOTP,
  sendPasswordResetOTP,
  verifyResetOTP,
  resetPassword,
  generateJWT,
  verifyJWT,
  findUserById,
  unsubscribeByToken,
  subscribeEmail,
};

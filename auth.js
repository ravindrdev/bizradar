/* auth.js — email/password auth core for GrowthIM.

   Pure logic — no Express, no HTTP. Used by authRoutes.js.

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
     - All errors thrown here have user-safe messages — callers re-throw
       them to the client without leaking schema info. */

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
// longer configurable via env — only the credentials (SMTP_USER /
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
    secure: true, // SMTPS — TLS from the first byte, required by Namecheap on 465
    auth: { user, pass },
    // Audit fix A1 — bounded SMTP timeouts. Without these a hung
    // Namecheap socket holds /auth/signup for Node's default socket
    // timeout (~5 min) before failing, leaving the user staring at a
    // spinner with no feedback.
    connectionTimeout: 10000, // 10 s — TCP/TLS handshake
    greetingTimeout:   10000, // 10 s — wait for SMTP server greeting
    socketTimeout:     15000, // 15 s — between any two read/write events
  });
  return cachedTransporter;
}

// ── Helpers ─────────────────────────────────────────────────────────
function generateOTP() {
  // 6-digit numeric string, zero-padded so leading zeros aren't lost.
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

async function hashOTP(otp) {
  return bcrypt.hash(otp, OTP_ROUNDS);
}

async function verifyOTPHash(otp, hash) {
  if (!otp || !hash) return false;
  try { return await bcrypt.compare(otp, hash); } catch (_) { return false; }
}

function generateJWT(userId) {
  return jwt.sign({ uid: userId }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyJWT(token) {
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return null; }
}

async function sendOTPEmail(email, otp, type) {
  const transporter = getTransporter();
  const subject = type === 'reset'
    ? 'GrowthIM — reset your password'
    : 'GrowthIM — verify your email';
  const body =
`Your GrowthIM ${type === 'reset' ? 'password reset' : 'verification'} code is:

    ${otp}

This code expires in ${OTP_TTL_MIN} minutes. If you didn't request this, you can safely ignore this email.

— GrowthIM`;

  if (!transporter) {
    // SMTP not configured — log OTP so local dev can complete the flow.
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
  // INSERT (audit fix A3 — bounded OTP brute force).
  const ins = await pool.query(
    `INSERT INTO users (name, email, password_hash, email_verified, otp_code, otp_expires, otp_type, otp_attempts, created_at)
     VALUES ($1, $2, $3, false, $4, $5, 'signup', 0, NOW())
     RETURNING id`,
    [name || null, e, passwordHash, otpHash, expires]
  );
  const newUserId = ins.rows[0].id;

  // Audit fix A2 — if SMTP fails, roll back the pending row so the
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
    `SELECT id, name, email, otp_code, otp_expires, otp_type, otp_attempts, email_verified
     FROM users WHERE email = $1 AND email_verified = false AND otp_type = 'signup'`,
    [e]
  );
  const user = r.rows[0];
  if (!user) throw new Error('No pending signup');
  // Audit fix A3 — bounded OTP brute force. After 5 incorrect attempts
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
  const token = generateJWT(user.id);
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
    `SELECT id, name, email, password_hash, email_verified FROM users WHERE email = $1`,
    [e]
  );
  const user = r.rows[0];
  if (!user) throw new Error('Invalid credentials');
  if (!user.email_verified) throw new Error('Please verify your email first');
  const ok = await bcrypt.compare(String(password || ''), user.password_hash || '');
  if (!ok) throw new Error('Invalid credentials');

  const token = generateJWT(user.id);
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

  // Audit fix A3 — reset otp_attempts on every new reset code so the
  // lockout counter is per-code, not per-account-lifetime.
  await pool.query(
    `UPDATE users SET otp_code = $1, otp_expires = $2, otp_type = 'reset', otp_attempts = 0 WHERE id = $3`,
    [otpHash, expires, user.id]
  );
  // Audit fix A2 — surface a user-safe error and clear the reset
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
  // Audit fix A3 — bounded brute force on the reset code.
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
  // NOTE: do NOT clear OTP here — resetPassword() will re-verify and clear.
  return true;
}

async function resetPassword(email, otp, newPassword) {
  const e = normalizeEmail(email);
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  // Re-verify OTP before changing the password — protects against
  // someone hitting /auth/reset-password directly without doing the
  // OTP verification step.
  await verifyResetOTP(e, otp);
  const passwordHash = await bcrypt.hash(newPassword, PASSWORD_ROUNDS);
  await pool.query(
    `UPDATE users
     SET password_hash = $1, otp_code = NULL, otp_expires = NULL, otp_type = NULL, otp_attempts = 0
     WHERE email = $2`,
    [passwordHash, e]
  );
  return { success: true };
}

// ── User lookup (used by /auth/me middleware) ───────────────────────
async function findUserById(id) {
  if (!id) return null;
  const r = await pool.query(
    `SELECT id, name, email, email_verified, created_at
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
  sendPasswordResetOTP,
  verifyResetOTP,
  resetPassword,
  generateJWT,
  verifyJWT,
  findUserById,
};

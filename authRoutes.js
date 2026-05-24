/* authRoutes.js - Express router for email/password auth.

   Mounted in server.js as: app.use('/auth', authRoutes)
   So every route here is prefixed: /auth/signup, /auth/login, etc.

   JWT cookie:
     name:     'token'
     options:  HttpOnly + SameSite=Lax + Path=/ + Max-Age=7d
     secure:   true when NODE_ENV=production OR running behind HTTPS
     The cookie carries a JWT signed with JWT_SECRET; verified by
     requireAuth middleware in authMiddleware.js. */

const express = require('express');
const auth = require('./auth');

const router = express.Router();

const COOKIE_NAME = 'token';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIE,
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIE,
    path: '/',
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Audit fix AR2 - whitelist of user-safe error messages thrown by
// auth.js. Anything outside this set (e.g. a raw pg error like
// "duplicate key value violates unique constraint", or a nodemailer
// "EAUTH 535-5.7.8 …") gets swallowed and replaced with a generic
// fallback so we don't leak internal config or schema details.
// Server-side console.error still has the full detail for debugging.
const SAFE_AUTH_ERRORS = new Set([
  'Name is required',
  'Email is required',
  'Invalid email format',
  'Password is required',
  'Password must be at least 8 characters',
  'Passwords do not match',
  'Email and password required',
  'Email and OTP required',
  'Email required',
  'Missing required fields',
  'Email already registered',
  'Invalid credentials',
  'Please verify your email first',
  'No pending signup',
  'No active reset request',
  'OTP expired',
  'Incorrect code',
  'Too many incorrect attempts. Request a new code.',
  'Email not found',
  'Could not send verification email. Please try again.',
  'Could not send reset email. Please try again.',
]);
function safeAuthError(err, fallback) {
  if (err && err.message && SAFE_AUTH_ERRORS.has(err.message)) return err.message;
  console.error('[auth-route] raw error swallowed:', err && err.message);
  return fallback;
}

function validateSignupBody(body) {
  const errs = [];
  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const password = (body.password || '').toString();
  const confirmPassword = (body.confirmPassword || '').toString();
  if (!name) errs.push('Name is required');
  if (!email) errs.push('Email is required');
  else if (!EMAIL_RE.test(email)) errs.push('Invalid email format');
  if (!password) errs.push('Password is required');
  else if (password.length < 8) errs.push('Password must be at least 8 characters');
  if (password !== confirmPassword) errs.push('Passwords do not match');
  return { errs, name, email, password };
}

// ── POST /auth/signup ───────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { errs, name, email, password } = validateSignupBody(req.body || {});
    if (errs.length) return res.status(400).json({ success: false, error: errs[0] });

    await auth.createPendingUser(name, email, password);
    return res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    return res.status(400).json({ success: false, error: safeAuthError(err, 'Signup failed') });
  }
});

// ── POST /auth/verify-signup ────────────────────────────────────────
router.post('/verify-signup', async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const otp = (req.body && req.body.otp) || '';
    if (!email || !otp) {
      return res.status(400).json({ success: false, error: 'Email and OTP required' });
    }
    const { token, user } = await auth.verifySignupOTP(email, otp);
    setAuthCookie(res, token);
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(400).json({ success: false, error: safeAuthError(err, 'Verification failed') });
  }
});

// ── POST /auth/cancel-signup ────────────────────────────────────────
// Called from the signup page's beforeunload handler when the user
// closes/leaves the OTP entry screen. Removes the unverified row so
// the email is free for a fresh signup attempt.
router.post('/cancel-signup', async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    if (!email) return res.json({ success: true, deleted: 0 });
    const out = await auth.deleteUnverifiedUser(email);
    return res.json(out);
  } catch (err) {
    // Never fail this - it's fire-and-forget from the client.
    return res.json({ success: false, error: err.message });
  }
});

// ── POST /auth/login ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const password = (req.body && req.body.password) || '';
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    const { token, user } = await auth.loginUser(email, password);
    setAuthCookie(res, token);
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(400).json({ success: false, error: safeAuthError(err, 'Login failed') });
  }
});

// ── POST /auth/logout ───────────────────────────────────────────────
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  return res.json({ success: true });
});

// ── POST /auth/forgot-password ──────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email required' });
    }
    await auth.sendPasswordResetOTP(email);
    return res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    return res.status(400).json({ success: false, error: safeAuthError(err, 'Reset request failed') });
  }
});

// ── POST /auth/verify-reset-otp ─────────────────────────────────────
router.post('/verify-reset-otp', async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const otp = (req.body && req.body.otp) || '';
    if (!email || !otp) {
      return res.status(400).json({ success: false, error: 'Email and OTP required' });
    }
    await auth.verifyResetOTP(email, otp);
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ success: false, error: safeAuthError(err, 'Verification failed') });
  }
});

// ── POST /auth/reset-password ───────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const otp = (req.body && req.body.otp) || '';
    const newPassword = (req.body && req.body.newPassword) || '';
    const confirmNewPassword = (req.body && req.body.confirmNewPassword) || '';
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }
    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ success: false, error: 'Passwords do not match' });
    }
    await auth.resetPassword(email, otp, newPassword);
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ success: false, error: safeAuthError(err, 'Password reset failed') });
  }
});

// ── GET /auth/me ────────────────────────────────────────────────────
// Read the JWT cookie, verify it, return the current user. Used by
// the dashboard / any client that needs to confirm session validity.
router.get('/me', async (req, res) => {
  try {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Please login' });
    const decoded = auth.verifyJWT(token);
    if (!decoded || !decoded.uid) return res.status(401).json({ error: 'Please login' });
    const user = await auth.findUserById(decoded.uid);
    if (!user) return res.status(401).json({ error: 'Please login' });
    return res.json({
      success: true,
      user: { id: user.id, name: user.name, email: user.email, email_verified: user.email_verified },
    });
  } catch (err) {
    return res.status(401).json({ error: 'Please login' });
  }
});

module.exports = router;

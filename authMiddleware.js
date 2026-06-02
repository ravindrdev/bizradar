/* authMiddleware.js — JWT cookie verifier for protected routes.

   Usage in server.js (or any router):
     const { requireAuth } = require('./authMiddleware');
     app.post('/some-protected', requireAuth, async (req, res) => {
       // req.user is set: { id, name, email, email_verified, created_at }
     });

   The middleware reads the httpOnly cookie named 'token', verifies the
   JWT with JWT_SECRET, looks up the user row in Postgres so a deleted-
   user JWT immediately fails (rather than letting old tokens linger),
   and attaches the full user record to req.user. Failures return
   401 { error: "Please login" } as specified. */

const auth = require('./auth');

const COOKIE_NAME = 'token';

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: 'Please login' });
    }
    const decoded = auth.verifyJWT(token);
    if (!decoded || !decoded.uid) {
      return res.status(401).json({ error: 'Please login' });
    }
    const user = await auth.findUserById(decoded.uid);
    if (!user) {
      // Token is valid but the user no longer exists (deleted account).
      return res.status(401).json({ error: 'Please login' });
    }
    req.user = user;
    return next();
  } catch (err) {
    // Defensive — any unexpected DB/JWT error becomes a 401 rather
    // than a 500 so we don't leak crash details to attackers probing
    // the auth surface.
    return res.status(401).json({ error: 'Please login' });
  }
}

// requireAdmin — owner-only gate for the admin surface.
//
// This is the LEGAL LOCK on the admin area, so it is deliberately
// self-contained: it repeats the full auth check (cookie → verifyJWT →
// findUserById) rather than assuming requireAuth ran first, then layers
// the owner check on top. It reads the JWT user id as `decoded.uid` —
// exactly the same field requireAuth uses above (see the !decoded.uid
// guard and findUserById(decoded.uid) call) — so the real owner is
// correctly recognized on the allow path.
//
// EVERY denial returns an identical 404 { error: 'Not found' } so the
// admin area is never even advertised: a logged-out visitor, a bad or
// expired token, a deleted user, and a logged-in non-owner are all
// indistinguishable from "this route does not exist." It never returns
// data and never 500s.
//
// CRITICAL fail-safe: if ADMIN_EMAIL is unset or empty we DENY everyone.
// The gate must never default to "allow" when it is misconfigured.
async function requireAdmin(req, res, next) {
  const deny = () => res.status(404).json({ error: 'Not found' });
  try {
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!adminEmail) {
      // Misconfigured / not enabled → deny everyone. Never default to allow.
      return deny();
    }
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) return deny();
    const decoded = auth.verifyJWT(token);
    if (!decoded || !decoded.uid) return deny();
    const user = await auth.findUserById(decoded.uid);
    if (!user) return deny();
    if (!user.email || user.email.trim().toLowerCase() !== adminEmail) {
      return deny();
    }
    req.user = user;
    return next();
  } catch (err) {
    // Any unexpected DB/JWT error becomes the same 404 — never a 500,
    // never a data leak.
    return deny();
  }
}

module.exports = { requireAuth, requireAdmin };

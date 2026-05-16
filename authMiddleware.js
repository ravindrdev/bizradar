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

module.exports = { requireAuth };

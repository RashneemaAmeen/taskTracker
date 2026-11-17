// Builds the Express application: security headers, JSON parsing, API routes,
// the static frontend in /public, and consistent error responses.

const path = require('node:path');
const express = require('express');
const { createRoutes } = require('./routes');
const { HttpError } = require('./validation');
const { isDatabaseUnavailable, unavailableMessage, summarizeError } = require('./database');

const publicDir = path.resolve(__dirname, '..', 'public');

// db is the MySQL connection pool (see src/database.js).
function createApp(db, { logRequests = false, allowedOrigins = [] } = {}) {
  const app = express();
  app.disable('x-powered-by');

  if (logRequests) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on('finish', () => console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`));
      next();
    });
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
  });

  // Changes (POST/PATCH/DELETE) must come from this site's own pages, not from another website.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('sec-fetch-site') === 'cross-site') return next(new HttpError(403, 'Cross-site request blocked.'));
    const origin = req.get('origin');
    if (origin) {
      let originHost;
      try { originHost = new URL(origin).host.toLowerCase(); } catch { return next(new HttpError(403, 'Origin is not valid.')); }
      const knownHosts = [req.get('host'), req.get('x-forwarded-host')].filter(Boolean).map(host => host.toLowerCase());
      const allowed = knownHosts.includes(originHost) || allowedOrigins.includes(origin.toLowerCase());
      if (!allowed) return next(new HttpError(403, 'Origin does not match this site. If the app is behind a proxy, see ALLOWED_ORIGINS in the README.'));
    }
    // Data must be sent as JSON.
    const hasBody = Number(req.get('content-length')) > 0 || req.get('transfer-encoding');
    if (hasBody && !req.is('application/json')) return next(new HttpError(415, 'Send data as JSON (Content-Type: application/json).'));
    next();
  });

  app.use(express.json({ limit: '50kb' }));

  // API answers must never be cached by the browser.
  app.use(['/api', '/health'], (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(createRoutes(db));

  // The frontend files. "no-cache" makes the browser check for a newer file on each load.
  app.use(express.static(publicDir, { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));

  app.use((req, res, next) => next(new HttpError(404, 'Page or endpoint not found.')));

  // Every error ends here and becomes { "error": "message", ... }.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, ...error.extra });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: 'The request could not be processed.' });
    // The database is down, unreachable or busy: say so plainly (503), and log only the
    // error code and message, never connection settings.
    if (isDatabaseUnavailable(error)) {
      console.error(`${req.method} ${req.originalUrl} - database problem: ${summarizeError(error)}`);
      return res.status(503).json({ error: unavailableMessage(error), code: 'DATABASE_UNAVAILABLE' });
    }
    // Unexpected problems: log the detail, show a safe message.
    console.error(`${req.method} ${req.originalUrl} failed:`, error);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again; if it continues, check the server log.' });
  });

  return app;
}

module.exports = { createApp };

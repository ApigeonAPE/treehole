/**
 * index.js - treehole web server entry point
 *
 * Responsibilities:
 *   - public API (auth/entries/posts/user)
 *   - internal API (called by Haraka)
 *   - static files (React SPA)
 *   - SPA fallback
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const { initDatabase } = require('./db');
const { getConfig, getWebServerConfig } = require('./config');

// ============================================================
// init
// ============================================================

const app = express();

// base middleware
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));

// request logging
app.use((req, res, next) => {
  const start = Date.now();
  // use originalUrl: req.path drops the mount prefix
  const logPath = req.originalUrl.split('?')[0];
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (logPath.startsWith('/api/')) {
      console.log(`${req.method} ${logPath} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// ============================================================
// API routes
// ============================================================

// admin API (public, Bearer admin.token)
app.use('/api/admin', require('./api/admin'));

// internal API (Haraka -> web, container network only, 9000)
app.use('/api/internal', require('./api/internal'));

// public config (no auth)
app.get('/api/public-config', (_req, res) => {
  const { getTimezone, getServerConfig, getAddresses, getSiteTitle, getAuthConfig } = require('./config');
  res.json({
    timezone: getTimezone(),
    site_title: getSiteTitle(),
    server_name: getServerConfig().name,
    submit_address: getAddresses().submit,
    verify_address: getAddresses().verify,
    trusted_domains: getAuthConfig().allowed_domains,
  });
});

// public API (web/app)
app.use('/api/auth', require('./api/public/auth'));
app.use('/api/entries', require('./api/public/entries'));
app.use('/api/user', require('./api/public/user'));

// ============================================================
// static files (React SPA)
// ============================================================

const publicDir = path.join(__dirname, '..', 'public');

// Serve static files from public/
app.use(express.static(publicDir, {
  maxAge: '1h',
  immutable: true,
}));

// SPA fallback: every non-/api/ GET returns index.html
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    // API 404
    return res.status(404).json({ error: 'Not found' });
  }

  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    // placeholder page while the frontend has not been built
    res.status(200).send(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>Treehole</title></head>
<body>
  <h1>🌳 Treehole</h1>
  <p>The frontend is not built yet. Run <code>npm run build</code> in frontend/.</p>
  <hr>
  <p><small>The API is running.</small></p>
</body>
</html>`);
  }
});

// ============================================================
// global error handler
// ============================================================

app.use((err, req, res, _next) => {
  console.error('[web] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// startup
// ============================================================

async function start() {
  // initialize the database
  await initDatabase();
  console.log('[web] Database initialized');

  // load the configuration
  const config = getConfig();

  // listen on the public port (80)
  app.listen(80, '0.0.0.0', () => {
    console.log('[web] Public server listening on port 80');
  });

  // listen on the internal port (9000, for Haraka)
  // the same Express app listens on both ports
  app.listen(9000, '0.0.0.0', () => {
    console.log('[web] Internal server listening on port 9000');
  });

  console.log(`[web] Server "${config.server.name}" started`);
}

start().catch((err) => {
  console.error('[web] Failed to start:', err);
  process.exit(1);
});

module.exports = app;

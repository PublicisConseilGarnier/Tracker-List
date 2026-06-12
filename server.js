/**
 * server.js — Garnier Campaign Tracker backend.
 *
 * - Serves the front-end from /public
 * - Exposes a tiny REST API for the shared team state:
 *     GET  /api/health        -> { ok, store, hasData }
 *     GET  /api/state         -> { data, updated_at }
 *     PUT  /api/state         -> { ok, updated_at }   (body: { data })
 * - Writes can be protected with a shared bearer token (env SYNC_TOKEN).
 *   Reads are protected too if SYNC_READ_PROTECT=1.
 */
const path = require('path');
const express = require('express');
const compression = require('compression');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const READ_PROTECT = process.env.SYNC_READ_PROTECT === '1';

app.use(compression());
// Kantar scorecards are stored as base64 inside the state, so allow large bodies.
app.use(express.json({ limit: process.env.JSON_LIMIT || '40mb' }));

// --- simple bearer-token gate ---
function checkToken(req) {
  if (!SYNC_TOKEN) return true; // open if no token configured
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m && m[1] === SYNC_TOKEN;
}
function requireToken(req, res, next) {
  if (!checkToken(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// --- health ---
app.get('/api/health', async (req, res) => {
  let hasData = false;
  try {
    const s = await db.getState();
    hasData = !!(s && s.data && Array.isArray(s.data.campaigns) && s.data.campaigns.length);
  } catch (_) {}
  res.json({ ok: true, store: db.getMode(), hasData, tokenRequired: !!SYNC_TOKEN });
});

// --- read state ---
app.get('/api/state', async (req, res) => {
  if (READ_PROTECT && !checkToken(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const s = await db.getState();
    res.json(s || { data: null, updated_at: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- write state ---
app.put('/api/state', requireToken, async (req, res) => {
  const data = req.body && req.body.data;
  if (!data || !Array.isArray(data.campaigns)) {
    return res.status(400).json({ error: 'body.data must be a tracker state object with a campaigns[] array' });
  }
  try {
    const r = await db.setState(data);
    res.json({ ok: true, updated_at: r.updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- static front-end ---
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', extensions: ['html'] }));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Garnier Tracker running on http://localhost:${PORT}  (store: ${db.getMode()})`);
      if (!SYNC_TOKEN) console.log('[server] No SYNC_TOKEN set — writes are OPEN. Set SYNC_TOKEN in production.');
    });
  })
  .catch((e) => {
    console.error('Failed to init DB:', e);
    process.exit(1);
  });

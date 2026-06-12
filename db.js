/**
 * db.js — persistence layer for the Garnier Campaign Tracker.
 *
 * Two modes, auto-selected:
 *   1. Postgres  — when DATABASE_URL is set (Render Postgres, Supabase, Neon, etc.)
 *                  This is the mode you want in production for shared team state.
 *   2. File      — when DATABASE_URL is NOT set. Stores ./data/state.json.
 *                  Fine for local dev. On Render's free web service the disk is
 *                  EPHEMERAL (wiped on each deploy/restart), so don't rely on it
 *                  in production — set DATABASE_URL instead.
 *
 * The whole app state (campaigns, assets, integrations, theme...) is stored as a
 * single JSON document under id = 'shared'. This mirrors how the front-end already
 * works (one localStorage blob), so no data reshaping is required.
 */
const fs = require('fs');
const path = require('path');

const SHARED_ID = 'shared';
const DATA_DIR = path.join(__dirname, 'data');
const FILE_PATH = path.join(DATA_DIR, 'state.json');
const SEED_PATH = path.join(DATA_DIR, 'seed.json');

let pool = null;
let mode = 'file';

function readSeed() {
  try {
    if (fs.existsSync(SEED_PATH)) {
      return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[db] Could not read seed.json:', e.message);
  }
  return null;
}

/* ---------------- Postgres ---------------- */
async function initPostgres() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  pool = new Pool({
    connectionString: url,
    // Managed Postgres (Render / Supabase / Neon) requires SSL.
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_state (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Seed on first run if empty.
  const { rows } = await pool.query('SELECT 1 FROM tracker_state WHERE id = $1', [SHARED_ID]);
  if (rows.length === 0) {
    const seed = readSeed();
    if (seed) {
      await pool.query(
        'INSERT INTO tracker_state (id, data, updated_at) VALUES ($1, $2, now())',
        [SHARED_ID, seed]
      );
      console.log('[db] Postgres seeded from data/seed.json');
    }
  }
  mode = 'postgres';
  console.log('[db] Using Postgres');
}

async function pgGet() {
  const { rows } = await pool.query(
    'SELECT data, updated_at FROM tracker_state WHERE id = $1',
    [SHARED_ID]
  );
  if (rows.length === 0) return { data: null, updated_at: null };
  return { data: rows[0].data, updated_at: rows[0].updated_at };
}

async function pgSet(data) {
  const { rows } = await pool.query(
    `INSERT INTO tracker_state (id, data, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
     RETURNING updated_at`,
    [SHARED_ID, data]
  );
  return { updated_at: rows[0].updated_at };
}

/* ---------------- File fallback ---------------- */
function initFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_PATH)) {
    const seed = readSeed();
    const initial = { data: seed || null, updated_at: seed ? new Date().toISOString() : null };
    fs.writeFileSync(FILE_PATH, JSON.stringify(initial));
    if (seed) console.log('[db] File store seeded from data/seed.json');
  }
  mode = 'file';
  console.log('[db] Using file store at', FILE_PATH, '(ephemeral on Render — set DATABASE_URL for production)');
}

function fileGet() {
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
  } catch (e) {
    return { data: null, updated_at: null };
  }
}

function fileSet(data) {
  const updated_at = new Date().toISOString();
  fs.writeFileSync(FILE_PATH, JSON.stringify({ data, updated_at }));
  return { updated_at };
}

/* ---------------- Public API ---------------- */
async function init() {
  if (process.env.DATABASE_URL) {
    try {
      await initPostgres();
      return;
    } catch (e) {
      console.error('[db] Postgres init failed, falling back to file store:', e.message);
    }
  }
  initFile();
}

async function getState() {
  return mode === 'postgres' ? pgGet() : fileGet();
}

async function setState(data) {
  return mode === 'postgres' ? pgSet(data) : fileSet(data);
}

function getMode() {
  return mode;
}

module.exports = { init, getState, setState, getMode };

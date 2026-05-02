'use strict';

/**
 * BHS Party API
 *
 * Separate Express server (default port 3002) that lets SnareHound clients
 * push and pull live party state. Completely isolated from the media-events
 * and system-actions routes — party keys have zero authority over those paths.
 *
 * Key lifecycle:
 *   generateKeyForUser(discordUserId)  → string key, replaces any existing key
 *   revokeKeyForUser(discordUserId)    → boolean
 *   hasKey(discordUserId)              → boolean
 *
 * These are called by the /partykey slash command in index.js.
 */

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const AUDIO_DIR = path.resolve(process.env.AUDIO_DIR || './audio');
const STATE_DIR = path.resolve(process.env.STATE_DIR || './state');
const PARTY_KEYS_STATE_PATH = path.resolve(STATE_DIR, process.env.PARTY_KEYS_STATE_FILE || 'party-keys-state.json');
const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);

// ── In-memory stores ──────────────────────────────────────────────────────────
const partyKeys  = new Map(); // discordUserId → key
const keyToUser  = new Map(); // key            → discordUserId
const partyState = new Map(); // discordUserId  → member snapshot
const rateLimits = new Map(); // key            → { count, resetAt }

const RATE_LIMIT_MAX    = 20;               // pushes per minute per key
const MEMBER_EXPIRY_MS  = 10 * 60 * 1000;  // drop members not seen in 10 min

// ── Internal helpers ──────────────────────────────────────────────────────────
function generateKey() {
  return 'bhs-party-' + crypto.randomBytes(18).toString('hex');
}

function safeStr(value, maxLen = 64) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function slugifyTrackName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'track';
}

function readRadioLibrary() {
  if (!fs.existsSync(AUDIO_DIR)) return [];

  const files = fs.readdirSync(AUDIO_DIR)
    .filter((fileName) => ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const usedIds = new Set();

  return files.map((fileName) => {
    let id = slugifyTrackName(fileName);
    const baseId = id;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    const fullPath = path.join(AUDIO_DIR, fileName);
    let sizeBytes = null;
    try {
      sizeBytes = fs.statSync(fullPath).size;
    } catch {}

    return {
      id,
      title: path.basename(fileName, path.extname(fileName)),
      filename: fileName,
      sizeBytes,
      fullPath,
    };
  });
}

function checkRateLimit(key) {
  const now = Date.now();
  let rl = rateLimits.get(key);
  if (!rl || now > rl.resetAt) {
    rl = { count: 0, resetAt: now + 60_000 };
  }
  rl.count++;
  rateLimits.set(key, rl);
  return rl.count <= RATE_LIMIT_MAX;
}

function cleanExpired() {
  const cutoff = Date.now() - MEMBER_EXPIRY_MS;
  for (const [id, data] of partyState) {
    if (data.lastSeenMs < cutoff) partyState.delete(id);
  }
}

function jsonError(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

function ensureStateDirectory() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function saveKeysToDisk() {
  ensureStateDirectory();

  const keys = Array.from(partyKeys.entries()).map(([discordUserId, key]) => ({
    discordUserId,
    key,
  }));

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    keys,
  };

  fs.writeFileSync(PARTY_KEYS_STATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

function loadKeysFromDisk() {
  partyKeys.clear();
  keyToUser.clear();

  if (!fs.existsSync(PARTY_KEYS_STATE_PATH)) {
    return;
  }

  try {
    const raw = fs.readFileSync(PARTY_KEYS_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const keyRows = Array.isArray(parsed?.keys) ? parsed.keys : [];

    for (const row of keyRows) {
      const discordUserId = safeStr(row?.discordUserId, 64);
      const key = safeStr(row?.key, 128);

      if (!discordUserId || !key || !key.startsWith('bhs-party-')) {
        continue;
      }

      partyKeys.set(discordUserId, key);
      keyToUser.set(key, discordUserId);
    }
  } catch (error) {
    console.error('[party-api] Failed to load party keys state:', error);
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function authPartyKey(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer bhs-party-')) {
    return jsonError(res, 401, 'Unauthorized');
  }
  const key = auth.slice('Bearer '.length);
  const discordUserId = keyToUser.get(key);
  if (!discordUserId) return jsonError(res, 401, 'Invalid or revoked key');
  if (!checkRateLimit(key)) return jsonError(res, 429, 'Rate limit exceeded — max 20 pushes/min');
  req.discordUserId = discordUserId;
  next();
}

// ── API factory ───────────────────────────────────────────────────────────────
function startPartyApi(port) {
  loadKeysFromDisk();

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Public health check — no auth required
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'bhs-party',
      activeMembersCount: partyState.size,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * POST /party/push
   * SnareHound clients call this whenever their local player state changes.
   * Body: { nickname, ship?, area?, server?, status? }
   */
  app.post('/party/push', authPartyKey, (req, res) => {
    const body     = req.body || {};
    const nickname = safeStr(body.nickname);
    if (!nickname) return jsonError(res, 400, 'Missing or empty nickname');

    cleanExpired();

    partyState.set(req.discordUserId, {
      discordUserId: req.discordUserId,
      nickname,
      ship:       safeStr(body.ship)         ?? null,
      area:       safeStr(body.area)         ?? null,
      server:     safeStr(body.server, 128)  ?? null,
      status:     body.status === 'disconnected' ? 'disconnected' : 'connected',
      lastSeen:   new Date().toISOString(),
      lastSeenMs: Date.now(),
    });

    return res.json({ ok: true });
  });

  /**
   * GET /party/state
   * Returns the current snapshot of all active party members.
   */
  app.get('/party/state', authPartyKey, (_req, res) => {
    cleanExpired();
    return res.json({
      ok:      true,
      members: Array.from(partyState.values()),
    });
  });

  // ── Radio routes (same auth as party for Phase 1) ───────────────────────
  app.get('/radio/library', authPartyKey, (_req, res) => {
    try {
      const tracks = readRadioLibrary().map(({ fullPath, ...rest }) => rest);
      return res.json({ ok: true, count: tracks.length, tracks });
    } catch (error) {
      console.error('[party-api] radio library failure:', error);
      return jsonError(res, 500, 'Failed to read radio library');
    }
  });

  app.get('/radio/track/:id', authPartyKey, (req, res) => {
    try {
      const wanted = String(req.params.id || '').trim();
      const track = readRadioLibrary().find((entry) => entry.id === wanted);
      if (!track) return jsonError(res, 404, 'Track not found');

      return res.sendFile(track.fullPath, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      console.error('[party-api] radio track failure:', error);
      return jsonError(res, 500, 'Failed to stream track');
    }
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[party-api] Listening on port ${port}`);
  });

  return server;
}

// ── Key management (called by slash commands) ─────────────────────────────────
function generateKeyForUser(discordUserId) {
  // Revoke any existing key first
  const existing = partyKeys.get(discordUserId);
  if (existing) keyToUser.delete(existing);

  const key = generateKey();
  partyKeys.set(discordUserId, key);
  keyToUser.set(key, discordUserId);
  saveKeysToDisk();
  return key;
}

function revokeKeyForUser(discordUserId) {
  const existing = partyKeys.get(discordUserId);
  if (!existing) return false;
  keyToUser.delete(existing);
  partyKeys.delete(discordUserId);
  partyState.delete(discordUserId);
  rateLimits.delete(existing);
  saveKeysToDisk();
  return true;
}

function revokeAllKeys() {
  const revokedCount = partyKeys.size;
  partyKeys.clear();
  keyToUser.clear();
  partyState.clear();
  rateLimits.clear();
  saveKeysToDisk();
  return revokedCount;
}

function hasKey(discordUserId) {
  return partyKeys.has(discordUserId);
}

function listKeys() {
  return Array.from(partyKeys.entries()).map(([discordUserId, key]) => ({
    discordUserId,
    keyPrefix: key.slice(0, 20) + '…',
    hasActiveSession: partyState.has(discordUserId),
  }));
}

module.exports = { startPartyApi, generateKeyForUser, revokeKeyForUser, revokeAllKeys, hasKey, listKeys };

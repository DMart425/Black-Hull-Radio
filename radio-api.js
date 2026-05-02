const express = require('express');
const fs = require('fs');
const path = require('path');

const AUDIO_DIR = path.join(__dirname, 'audio');
const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function slugifyTrackName(name) {
  return clean(name)
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'track';
}

function displayName(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

function readLibrary() {
  if (!fs.existsSync(AUDIO_DIR)) return [];

  const files = fs.readdirSync(AUDIO_DIR)
    .filter((fileName) => ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

  const usedIds = new Set();

  return files.map((fileName) => {
    const title = displayName(fileName);
    let id = slugifyTrackName(fileName);
    let suffix = 2;

    while (usedIds.has(id)) {
      id = `${slugifyTrackName(fileName)}-${suffix}`;
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
      title,
      filename: fileName,
      sizeBytes,
    };
  });
}

function getTrackById(trackId) {
  const wanted = clean(trackId);
  if (!wanted) return null;

  const track = readLibrary().find((entry) => entry.id === wanted);
  if (!track) return null;

  return {
    ...track,
    fullPath: path.join(AUDIO_DIR, track.filename),
  };
}

function startRadioApi(port) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'black-hull-radio-api',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/radio/library', (_req, res) => {
    try {
      const library = readLibrary();
      return res.status(200).json({
        ok: true,
        count: library.length,
        tracks: library,
      });
    } catch (error) {
      console.error('[radio-api] library failure:', error);
      return res.status(500).json({ ok: false, error: 'Failed to read library' });
    }
  });

  app.get('/radio/track/:id', (req, res) => {
    try {
      const track = getTrackById(req.params.id);
      if (!track) {
        return res.status(404).json({ ok: false, error: 'Track not found' });
      }

      return res.sendFile(track.fullPath, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      console.error('[radio-api] track failure:', error);
      return res.status(500).json({ ok: false, error: 'Failed to stream track' });
    }
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`[radio-api] listening on port ${port}`);
  });
}

module.exports = { startRadioApi, readLibrary, getTrackById };
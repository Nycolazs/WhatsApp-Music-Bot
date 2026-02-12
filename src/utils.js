const fs = require('fs');
const path = require('path');

function sanitizeFilename(input, maxLength = 80) {
  const baseName = String(input || 'audio')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  const safe = baseName || 'audio';
  return safe.slice(0, maxLength);
}

function isLikelyUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractYouTubeVideoId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const shortId = parsed.pathname.split('/').filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(shortId) ? shortId : null;
    }

    if (!host.endsWith('youtube.com')) {
      return null;
    }

    if (parsed.pathname === '/watch') {
      const queryId = parsed.searchParams.get('v');
      return /^[a-zA-Z0-9_-]{11}$/.test(queryId) ? queryId : null;
    }

    const shortsMatch = parsed.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) {
      return shortsMatch[1];
    }

    const embedMatch = parsed.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) {
      return embedMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

function extractYouTubePlaylistId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    if (!host.endsWith('youtube.com') && host !== 'youtu.be') {
      return null;
    }

    const listId = parsed.searchParams.get('list');
    if (!listId) {
      return null;
    }

    return /^[a-zA-Z0-9_-]+$/.test(listId) ? listId : null;
  } catch {
    return null;
  }
}

function parseTimestampToSeconds(timestamp) {
  if (!timestamp || typeof timestamp !== 'string') {
    return 0;
  }

  const chunks = timestamp.split(':').map((item) => Number(item));
  if (chunks.some((item) => Number.isNaN(item))) {
    return 0;
  }

  if (chunks.length === 3) {
    return chunks[0] * 3600 + chunks[1] * 60 + chunks[2];
  }

  if (chunks.length === 2) {
    return chunks[0] * 60 + chunks[1];
  }

  return chunks[0] || 0;
}

function formatSeconds(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

async function ensureDirectory(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function safeUnlink(filePath) {
  if (!filePath) {
    return;
  }

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Falha ao remover arquivo temporario: ${filePath}`);
    }
  }
}

async function safeRemoveByPrefix(dirPath, prefix) {
  try {
    const files = await fs.promises.readdir(dirPath);
    const targets = files.filter((fileName) => fileName.startsWith(prefix));

    await Promise.all(
      targets.map((fileName) => safeUnlink(path.join(dirPath, fileName)))
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Falha ao limpar arquivos temporarios com prefixo ${prefix}.`);
    }
  }
}

module.exports = {
  ensureDirectory,
  extractYouTubePlaylistId,
  extractYouTubeVideoId,
  formatSeconds,
  isLikelyUrl,
  parseTimestampToSeconds,
  safeRemoveByPrefix,
  safeUnlink,
  sanitizeFilename
};

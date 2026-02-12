const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const projectRoot = path.resolve(__dirname, '..');

function toAbsolutePath(value, fallback) {
  if (!value) {
    return fallback;
  }

  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function toRangeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const bounded = Math.floor(parsed);
  if (bounded < min || bounded > max) {
    return fallback;
  }

  return bounded;
}

const legacyMaxDuration = toPositiveNumber(process.env.MAX_DURATION, 0);
const legacyMaxFileSize = toPositiveNumber(process.env.MAX_FILE_SIZE, 20 * 1024 * 1024);

module.exports = {
  downloadPath: toAbsolutePath(process.env.DOWNLOAD_PATH, path.join(projectRoot, 'downloads')),
  maxAudioDuration: toPositiveNumber(process.env.MAX_AUDIO_DURATION, legacyMaxDuration || 1800),
  maxVideoDuration: toPositiveNumber(process.env.MAX_VIDEO_DURATION, 1200),
  sessionPath: toAbsolutePath(process.env.SESSION_PATH, path.join(projectRoot, 'session')),
  maxAudioFileSize: toPositiveNumber(process.env.MAX_AUDIO_FILE_SIZE, legacyMaxFileSize),
  maxVideoFileSize: toPositiveNumber(process.env.MAX_VIDEO_FILE_SIZE, Math.max(legacyMaxFileSize, 100 * 1024 * 1024)),
  maxSearchOptions: toPositiveNumber(process.env.MAX_SEARCH_OPTIONS, 8),
  maxPlaylistItems: toPositiveNumber(process.env.MAX_PLAYLIST_ITEMS, 10),
  selectionTimeoutSeconds: toPositiveNumber(process.env.SELECTION_TIMEOUT_SECONDS, 120),
  ytDlpCookiesFile: toAbsolutePath(process.env.YTDLP_COOKIES_FILE, null),
  ytDlpCookiesFromBrowser: String(process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim(),
  ytDlpExtractorArgs: String(process.env.YTDLP_EXTRACTOR_ARGS || '').trim(),
  ytDlpJsRuntimes: String(process.env.YTDLP_JS_RUNTIMES || '').trim(),
  ytDlpRemoteComponents: String(process.env.YTDLP_REMOTE_COMPONENTS || '').trim(),
  audioQuality: toRangeNumber(process.env.AUDIO_QUALITY, 5, 0, 9),
  ytDlpConcurrentFragments: toPositiveNumber(process.env.YTDLP_CONCURRENT_FRAGMENTS, 4)
};

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  ensureDirectory,
  safeRemoveByPrefix,
  safeUnlink,
  sanitizeFilename
} = require('./utils');

class DownloadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.details = details;
  }
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readableFileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function detectFfmpegLocation() {
  if (process.env.FFMPEG_LOCATION) {
    return process.env.FFMPEG_LOCATION;
  }

  const whichResult = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (whichResult.status === 0) {
    const ffmpegPath = (whichResult.stdout || '').trim();
    if (ffmpegPath) {
      const candidateDir = path.dirname(ffmpegPath);
      if (
        fileExists(path.join(candidateDir, 'ffmpeg')) &&
        fileExists(path.join(candidateDir, 'ffprobe'))
      ) {
        return candidateDir;
      }
    }
  }

  const commonDirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const candidateDir of commonDirs) {
    if (
      fileExists(path.join(candidateDir, 'ffmpeg')) &&
      fileExists(path.join(candidateDir, 'ffprobe'))
    ) {
      return candidateDir;
    }
  }

  return null;
}

function runYtDlp(args) {
  const envPath = `${['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':')}`;

  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, {
      env: {
        ...process.env,
        PATH: envPath
      }
    });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new DownloadError('YTDLP_NOT_FOUND', 'yt-dlp nao encontrado no sistema.'));
        return;
      }

      reject(new DownloadError('YTDLP_ERROR', 'Falha ao iniciar o yt-dlp.', { originalError: error }));
    });

    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });
}

function buildYtDlpAuthArgs(options = {}) {
  const {
    ytDlpCookiesFile,
    ytDlpCookiesFromBrowser,
    ytDlpExtractorArgs,
    ytDlpJsRuntimes,
    ytDlpRemoteComponents
  } = options;

  const args = [];

  if (ytDlpCookiesFile) {
    if (!readableFileExists(ytDlpCookiesFile)) {
      throw new DownloadError(
        'COOKIES_FILE_NOT_FOUND',
        `Arquivo de cookies nao encontrado: ${ytDlpCookiesFile}`
      );
    }

    args.push('--cookies', ytDlpCookiesFile);
  }
  else if (ytDlpCookiesFromBrowser) {
    args.push('--cookies-from-browser', ytDlpCookiesFromBrowser);
  }

  if (ytDlpExtractorArgs) {
    args.push('--extractor-args', ytDlpExtractorArgs);
  }

  if (ytDlpJsRuntimes) {
    args.push('--js-runtimes', ytDlpJsRuntimes);
  }

  if (ytDlpRemoteComponents) {
    args.push('--remote-components', ytDlpRemoteComponents);
  }

  return args;
}

function isYtDlpAuthError(stderr) {
  const output = String(stderr || '')
    .toLowerCase()
    .replace(/’/g, "'");

  return (
    output.includes("sign in to confirm you're not a bot") ||
    output.includes('use --cookies-from-browser or --cookies for the authentication') ||
    output.includes('this video is age-restricted and only available on youtube')
  );
}

function isYtDlpChallengeError(stderr) {
  const output = String(stderr || '').toLowerCase();
  return (
    output.includes('n challenge solving failed') ||
    output.includes('only images are available for download') ||
    output.includes('requested format is not available')
  );
}

function runFfmpeg(inputPath, outputPath, ffmpegLocation) {
  const envPath = `${['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':')}`;
  const ffmpegBinary = ffmpegLocation ? path.join(ffmpegLocation, 'ffmpeg') : 'ffmpeg';
  const args = [
    '-y',
    '-i',
    inputPath,
    '-vf',
    'scale=1280:720:force_original_aspect_ratio=decrease,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-profile:v',
    'main',
    '-level',
    '3.1',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-ac',
    '2',
    outputPath
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary, args, {
      env: {
        ...process.env,
        PATH: envPath
      }
    });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new DownloadError('FFMPEG_NOT_FOUND', 'ffmpeg nao encontrado no sistema.'));
        return;
      }

      reject(new DownloadError('FFMPEG_ERROR', 'Falha ao iniciar o ffmpeg.', {
        originalError: error
      }));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new DownloadError('FFMPEG_ERROR', 'Falha na conversao de video para formato compativel.', {
          code,
          stderr
        }));
        return;
      }

      resolve();
    });
  });
}

async function resolveOutputPath(downloadPath, baseName, extensions, label) {
  for (const extension of extensions) {
    const expectedPath = path.join(downloadPath, `${baseName}.${extension}`);

    try {
      await fs.promises.access(expectedPath, fs.constants.F_OK);
      return expectedPath;
    } catch {
      // tenta fallback por prefixo abaixo.
    }
  }

  const files = await fs.promises.readdir(downloadPath);
  const match = files.find((fileName) => {
    return (
      fileName.startsWith(baseName) &&
      extensions.some((extension) => fileName.toLowerCase().endsWith(`.${extension}`))
    );
  });

  if (!match) {
    throw new DownloadError('OUTPUT_NOT_FOUND', `${label} final nao foi gerado.`);
  }

  return path.join(downloadPath, match);
}

function buildAudioArgs({
  outputTemplate,
  mediaUrl,
  ffmpegLocation,
  ytDlpAuthArgs,
  audioQuality = 5,
  ytDlpConcurrentFragments = 4
}) {
  const args = [
    '--no-playlist',
    '-N',
    String(Math.max(1, ytDlpConcurrentFragments)),
    '-f',
    'bestaudio[ext=m4a]/bestaudio/best',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    String(audioQuality)
  ];

  if (ffmpegLocation) {
    args.push('--ffmpeg-location', ffmpegLocation);
  }

  args.push(
    ...ytDlpAuthArgs,
    '--no-progress',
    '--newline',
    '-o',
    outputTemplate,
    mediaUrl
  );

  return args;
}

function buildVideoArgs({
  outputTemplate,
  mediaUrl,
  ffmpegLocation,
  ytDlpAuthArgs,
  ytDlpConcurrentFragments = 4
}) {
  const args = [
    '--no-playlist',
    '-N',
    String(Math.max(1, ytDlpConcurrentFragments)),
    '-f',
    'bestvideo[height<=720]+bestaudio/best[height<=720]',
    '--merge-output-format',
    'mp4',
    '--recode-video',
    'mp4'
  ];

  if (ffmpegLocation) {
    args.push('--ffmpeg-location', ffmpegLocation);
  }

  args.push(
    ...ytDlpAuthArgs,
    '--no-progress',
    '--newline',
    '-o',
    outputTemplate,
    mediaUrl
  );

  return args;
}

async function downloadWithArgs(video, options) {
  const {
    downloadPath,
    maxFileSize,
    argsBuilder,
    outputExtensions,
    outputLabel,
    skipSizeValidation = false,
    ytDlpCookiesFile,
    ytDlpCookiesFromBrowser,
    ytDlpExtractorArgs,
    ytDlpJsRuntimes,
    ytDlpRemoteComponents,
    audioQuality,
    ytDlpConcurrentFragments
  } = options;

  await ensureDirectory(downloadPath);

  const baseName = `${sanitizeFilename(video.title, 60)}-${Date.now()}`;
  const outputTemplate = path.join(downloadPath, `${baseName}.%(ext)s`);
  const ffmpegLocation = detectFfmpegLocation();
  const ytDlpAuthArgs = buildYtDlpAuthArgs({
    ytDlpCookiesFile,
    ytDlpCookiesFromBrowser,
    ytDlpExtractorArgs,
    ytDlpJsRuntimes,
    ytDlpRemoteComponents
  });

  const args = argsBuilder({
    outputTemplate,
    mediaUrl: video.url,
    ffmpegLocation,
    ytDlpAuthArgs,
    audioQuality,
    ytDlpConcurrentFragments
  });

  const { code, stderr } = await runYtDlp(args);

  if (code !== 0) {
    // Remove artefatos parciais quando o yt-dlp falhar.
    await safeRemoveByPrefix(downloadPath, baseName);

    if (isYtDlpAuthError(stderr)) {
      throw new DownloadError(
        'YTDLP_AUTH_REQUIRED',
        'YouTube exigiu autenticacao (cookies) para continuar.',
        { code, stderr }
      );
    }

    if (isYtDlpChallengeError(stderr)) {
      throw new DownloadError(
        'YTDLP_CHALLENGE_FAILED',
        'Falha ao resolver challenge do YouTube (runtime JS/EJS).',
        { code, stderr }
      );
    }

    throw new DownloadError('YTDLP_ERROR', 'yt-dlp retornou erro durante o download.', {
      code,
      stderr
    });
  }

  const filePath = await resolveOutputPath(downloadPath, baseName, outputExtensions, outputLabel);
  const stats = await fs.promises.stat(filePath);

  if (!skipSizeValidation && stats.size > maxFileSize) {
    await safeUnlink(filePath);
    throw new DownloadError('FILE_TOO_LARGE', 'Arquivo acima do limite de tamanho permitido.', {
      size: stats.size,
      maxFileSize
    });
  }

  return {
    filePath,
    fileSize: stats.size
  };
}

async function downloadAudio(video, options) {
  return downloadWithArgs(video, {
    ...options,
    argsBuilder: buildAudioArgs,
    outputExtensions: ['mp3'],
    outputLabel: 'Arquivo MP3'
  });
}

async function downloadVideo(video, options) {
  const rawResult = await downloadWithArgs(video, {
    ...options,
    argsBuilder: buildVideoArgs,
    outputExtensions: ['mp4'],
    outputLabel: 'Arquivo MP4',
    skipSizeValidation: true
  });

  const ffmpegLocation = detectFfmpegLocation();
  const convertedPath = rawResult.filePath.replace(/\.mp4$/i, '-wa.mp4');

  try {
    await runFfmpeg(rawResult.filePath, convertedPath, ffmpegLocation);
  } finally {
    await safeUnlink(rawResult.filePath);
  }

  const stats = await fs.promises.stat(convertedPath);
  if (stats.size > options.maxFileSize) {
    await safeUnlink(convertedPath);
    throw new DownloadError('FILE_TOO_LARGE', 'Arquivo acima do limite de tamanho permitido.', {
      size: stats.size,
      maxFileSize: options.maxFileSize
    });
  }

  return {
    filePath: convertedPath,
    fileSize: stats.size
  };
}

module.exports = {
  downloadAudio,
  downloadVideo,
  DownloadError
};

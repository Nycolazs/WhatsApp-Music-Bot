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
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function buildProcessPath() {
  const extraPaths = process.platform === 'win32'
    ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin'),
      'C:\\ffmpeg\\bin',
      'C:\\ProgramData\\chocolatey\\bin'
    ]
    : ['/opt/homebrew/bin', '/usr/local/bin'];

  return [...extraPaths, process.env.PATH || '']
    .filter(Boolean)
    .join(path.delimiter);
}

function getBinaryCandidates(binaryName) {
  if (process.platform !== 'win32') {
    return [binaryName];
  }

  if (binaryName.toLowerCase().endsWith('.exe')) {
    return [binaryName];
  }

  return [`${binaryName}.exe`, binaryName];
}

function directoryHasBinaries(directoryPath, binaries) {
  return binaries.every((binary) => {
    return getBinaryCandidates(binary).some((candidate) => {
      return fileExists(path.join(directoryPath, candidate));
    });
  });
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

  const locator = process.platform === 'win32' ? 'where' : 'which';
  const whichResult = spawnSync(locator, ['ffmpeg'], { encoding: 'utf8' });
  if (whichResult.status === 0) {
    const ffmpegPaths = String(whichResult.stdout || '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    for (const ffmpegPath of ffmpegPaths) {
      const candidateDir = path.dirname(ffmpegPath);
      if (directoryHasBinaries(candidateDir, ['ffmpeg', 'ffprobe'])) {
        return candidateDir;
      }
    }
  }

  const commonDirs = process.platform === 'win32'
    ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin'),
      'C:\\ffmpeg\\bin',
      'C:\\ProgramData\\chocolatey\\bin'
    ]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

  for (const candidateDir of commonDirs) {
    if (directoryHasBinaries(candidateDir, ['ffmpeg', 'ffprobe'])) {
      return candidateDir;
    }
  }

  return null;
}

function runYtDlp(args) {
  const envPath = buildProcessPath();
  const ytDlpBinary = process.env.YTDLP_BINARY || (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpBinary, args, {
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
    output.includes('only images are available for download')
  );
}

function isYtDlpFormatUnavailableError(stderr) {
  const output = String(stderr || '').toLowerCase();
  return output.includes('requested format is not available');
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildVideoCompressionProfile(durationSeconds, options = {}) {
  const baseHeight = clampNumber(Number(options.videoMaxHeight) || 480, 240, 720);
  const baseCrf = clampNumber(Number(options.videoCrf) || 30, 18, 40);
  const baseAudioBitrate = clampNumber(Number(options.videoAudioBitrateKbps) || 64, 32, 192);
  const duration = Math.max(0, Number(durationSeconds) || 0);

  if (duration >= 7200) {
    return {
      maxHeight: Math.min(baseHeight, 240),
      crf: clampNumber(baseCrf + 2, 18, 40),
      audioBitrateKbps: Math.min(baseAudioBitrate, 48)
    };
  }

  if (duration >= 3600) {
    return {
      maxHeight: Math.min(baseHeight, 360),
      crf: clampNumber(baseCrf + 1, 18, 40),
      audioBitrateKbps: Math.min(baseAudioBitrate, 56)
    };
  }

  if (duration >= 1800) {
    return {
      maxHeight: Math.min(baseHeight, 480),
      crf: clampNumber(baseCrf + 1, 18, 40),
      audioBitrateKbps: Math.min(baseAudioBitrate, 64)
    };
  }

  return {
    maxHeight: baseHeight,
    crf: baseCrf,
    audioBitrateKbps: baseAudioBitrate
  };
}

function buildFallbackVideoCompressionProfile(profile) {
  const fallback = {
    maxHeight: Math.max(240, Math.min(profile.maxHeight, 360)),
    crf: clampNumber(profile.crf + 2, 18, 40),
    audioBitrateKbps: Math.max(32, Math.min(profile.audioBitrateKbps, 48))
  };

  const changed =
    fallback.maxHeight !== profile.maxHeight ||
    fallback.crf !== profile.crf ||
    fallback.audioBitrateKbps !== profile.audioBitrateKbps;

  return changed ? fallback : null;
}

function runFfmpeg(inputPath, outputPath, ffmpegLocation, profile = {}) {
  const envPath = buildProcessPath();
  const ffmpegBinaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffmpegBinary = ffmpegLocation ? path.join(ffmpegLocation, ffmpegBinaryName) : ffmpegBinaryName;
  const maxHeight = clampNumber(Number(profile.maxHeight) || 480, 240, 720);
  const crf = clampNumber(Number(profile.crf) || 30, 18, 40);
  const audioBitrateKbps = clampNumber(Number(profile.audioBitrateKbps) || 64, 32, 192);
  const args = [
    '-y',
    '-i',
    inputPath,
    '-vf',
    `scale=-2:${maxHeight}:force_original_aspect_ratio=decrease,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(crf),
    '-profile:v',
    'main',
    '-level',
    '3.1',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateKbps}k`,
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
  audioBitrateKbps = 96,
  audioChannels = 1,
  audioSampleRate = 32000,
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

  const postprocessorArgs = [
    '-b:a', `${audioBitrateKbps}k`,
    '-ac', String(audioChannels),
    '-ar', String(audioSampleRate)
  ];
  args.push('--postprocessor-args', `ExtractAudio+ffmpeg_o:${postprocessorArgs.join(' ')}`);

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
  videoMaxHeight = 480,
  ytDlpConcurrentFragments = 4
}) {
  const boundedMaxHeight = clampNumber(Number(videoMaxHeight) || 480, 240, 720);
  const args = [
    '--no-playlist',
    '-N',
    String(Math.max(1, ytDlpConcurrentFragments)),
    '-f',
    `bv*[height<=${boundedMaxHeight}][vcodec*=avc1]+ba[acodec*=mp4a]/b[height<=${boundedMaxHeight}][ext=mp4]/best[height<=${boundedMaxHeight}]/best`
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
    audioBitrateKbps,
    audioChannels,
    audioSampleRate,
    ytDlpConcurrentFragments,
    videoMaxHeight,
    videoCrf,
    videoAudioBitrateKbps
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
    audioBitrateKbps,
    audioChannels,
    audioSampleRate,
    ytDlpConcurrentFragments,
    videoMaxHeight,
    videoCrf,
    videoAudioBitrateKbps
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

    if (isYtDlpFormatUnavailableError(stderr)) {
      throw new DownloadError(
        'YTDLP_FORMAT_UNAVAILABLE',
        'Formato solicitado nao disponivel para este video.',
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
  const compressionProfile = buildVideoCompressionProfile(video?.durationSeconds, {
    videoMaxHeight: options.videoMaxHeight,
    videoCrf: options.videoCrf,
    videoAudioBitrateKbps: options.videoAudioBitrateKbps
  });

  const rawResult = await downloadWithArgs(video, {
    ...options,
    argsBuilder: buildVideoArgs,
    outputExtensions: ['mp4', 'mkv', 'webm'],
    outputLabel: 'Arquivo de video',
    skipSizeValidation: true,
    videoMaxHeight: compressionProfile.maxHeight
  });

  const ffmpegLocation = detectFfmpegLocation();
  const parsedRawPath = path.parse(rawResult.filePath);
  const convertedPath = path.join(parsedRawPath.dir, `${parsedRawPath.name}-wa.mp4`);

  try {
    await runFfmpeg(rawResult.filePath, convertedPath, ffmpegLocation, compressionProfile);

    let stats = await fs.promises.stat(convertedPath);
    if (stats.size > options.maxFileSize) {
      const fallbackProfile = buildFallbackVideoCompressionProfile(compressionProfile);

      if (fallbackProfile) {
        await safeUnlink(convertedPath);
        await runFfmpeg(rawResult.filePath, convertedPath, ffmpegLocation, fallbackProfile);
        stats = await fs.promises.stat(convertedPath);
      }
    }

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
  } finally {
    await safeUnlink(rawResult.filePath);
  }
}

module.exports = {
  downloadAudio,
  downloadVideo,
  DownloadError
};

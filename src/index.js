const config = require('./config');
const { parseCommand } = require('./commands');
const { downloadAudio, downloadVideo, DownloadError } = require('./downloader');
const { DownloadQueue } = require('./queue');
const { startWhatsApp } = require('./whatsapp');
const {
  getPlaylistOptions,
  getVideoFromInput,
  searchMediaOptions,
  YoutubeError
} = require('./youtube');
const {
  ensureDirectory,
  formatSeconds,
  isLikelyUrl,
  safeUnlink
} = require('./utils');

const queue = new DownloadQueue();
const pendingSelections = new Map();
const MEDIA_AUDIO = 'audio';
const MEDIA_VIDEO = 'video';

function bold(text) {
  return `*${text}*`;
}

function mono(text) {
  return `\`${text}\``;
}

function getMaxSearchDuration() {
  return Math.max(config.maxAudioDuration, config.maxVideoDuration);
}

function getDefaultMediaLabel(mediaType) {
  return mediaType === MEDIA_VIDEO ? 'video 720p' : 'audio MP3';
}

function buildHelpText() {
  return [
    `${bold('Music Bot - Guia Rapido')}`,
    '',
    `${bold('1) Buscar')}`,
    `${mono('/play <nome|url>')} - prioriza audio MP3`,
    `${mono('/video <nome|url>')} - prioriza video 720p`,
    `${mono('/cancel')} - cancela selecao pendente`,
    `${mono('/help')} - mostra este guia`,
    '',
    `${bold('2) Escolher Opcao')}`,
    `${mono('1')} usa formato padrao do comando`,
    `${mono('a1')} forca audio MP3`,
    `${mono('v1')} forca video 720p`,
    '',
    `${bold('3) Playlist')}`,
    'Ao selecionar playlist, o bot lista as faixas.',
    `Escolha novamente com ${mono('1')}, ${mono('a1')} ou ${mono('v1')}.`,
    '',
    `${bold('4) Usar Quote (responder mensagem)')}`,
    `Responda uma mensagem com ${mono('/play')} ou ${mono('/video')} sem repetir texto.`,
    'O bot usa automaticamente o conteudo da mensagem citada.',
    '',
    `${bold('Exemplos')}`,
    mono('/play linkin park numb'),
    mono('/video imagine dragons believer'),
    mono('/play https://www.youtube.com/watch?v=...'),
    mono('/play https://www.youtube.com/playlist?list=...'),
    '',
    `${bold('Limites')}`,
    `Audio: ${formatSeconds(config.maxAudioDuration)}`,
    `Video: ${formatSeconds(config.maxVideoDuration)} (720p)`
  ].join('\n');
}

function mapPlayError(error) {
  if (error instanceof YoutubeError) {
    if (error.code === 'INVALID_URL') {
      return 'URL invalida. Envie um link valido do YouTube ou um termo de busca.';
    }

    if (error.code === 'NOT_FOUND') {
      return 'Nada encontrado para essa busca.';
    }

    if (error.code === 'DURATION_LIMIT') {
      return `Duracao acima do limite de busca (${formatSeconds(getMaxSearchDuration())}).`;
    }

    if (error.code === 'AUDIO_DURATION_LIMIT') {
      return `Audio acima do limite de ${formatSeconds(config.maxAudioDuration)}.`;
    }

    if (error.code === 'VIDEO_DURATION_LIMIT') {
      return `Video acima do limite de ${formatSeconds(config.maxVideoDuration)}. Escolha audio para esse item.`;
    }

    if (error.code === 'PLAYLIST_NOT_FOUND') {
      return 'Playlist nao encontrada.';
    }

    if (error.code === 'PLAYLIST_NO_VALID_VIDEOS') {
      return 'Playlist sem faixas validas para os limites configurados.';
    }

    return 'Falha ao consultar o YouTube.';
  }

  if (error instanceof DownloadError) {
    if (error.code === 'YTDLP_NOT_FOUND') {
      return 'yt-dlp nao encontrado no servidor.';
    }

    if (error.code === 'FFMPEG_NOT_FOUND') {
      return 'ffmpeg nao encontrado no servidor.';
    }

    if (error.code === 'FFMPEG_ERROR') {
      return 'Falha ao converter o video para formato compativel do WhatsApp.';
    }

    if (error.code === 'COOKIES_FILE_NOT_FOUND') {
      return 'Arquivo de cookies do yt-dlp nao encontrado no servidor. Verifique YTDLP_COOKIES_FILE.';
    }

    if (error.code === 'YTDLP_AUTH_REQUIRED') {
      return 'YouTube bloqueou esta requisicao. Configure cookies no .env (YTDLP_COOKIES_FILE) e tente novamente.';
    }

    if (error.code === 'YTDLP_CHALLENGE_FAILED') {
      return 'YouTube bloqueou os formatos de midia. Configure YTDLP_JS_RUNTIMES e YTDLP_REMOTE_COMPONENTS no .env.';
    }

    if (error.code === 'FILE_TOO_LARGE') {
      return 'O arquivo final ficou muito grande para envio no WhatsApp.';
    }

    return 'Erro ao baixar/converter midia com yt-dlp.';
  }

  if (error?.code === 'WHATSAPP_NOT_CONNECTED') {
    return 'WhatsApp temporariamente desconectado. Tente novamente em instantes.';
  }

  if (error?.code === 'WHATSAPP_SEND_AUDIO_FAILED') {
    return 'Falha ao enviar o audio no WhatsApp.';
  }

  if (error?.code === 'WHATSAPP_SEND_VIDEO_FAILED') {
    return 'Falha ao enviar o video no WhatsApp.';
  }

  return 'Erro interno ao processar sua solicitacao.';
}

function isWhatsAppSizeError(error) {
  const rawMessage = String(error?.message || '').toLowerCase();
  return (
    rawMessage.includes('too large') ||
    rawMessage.includes('media too big') ||
    rawMessage.includes('413')
  );
}

function setPendingSelection(chatId, payload) {
  pendingSelections.set(chatId, {
    ...payload,
    expiresAt: Date.now() + config.selectionTimeoutSeconds * 1000
  });
}

function getPendingSelection(chatId) {
  const pending = pendingSelections.get(chatId);
  if (!pending) {
    return null;
  }

  if (Date.now() > pending.expiresAt) {
    pendingSelections.delete(chatId);
    return null;
  }

  return pending;
}

function clearPendingSelection(chatId) {
  pendingSelections.delete(chatId);
}

function normalizeMediaToken(token) {
  const value = String(token || '').toLowerCase();
  if (value === 'a' || value === 'audio') {
    return MEDIA_AUDIO;
  }

  if (value === 'v' || value === 'video') {
    return MEDIA_VIDEO;
  }

  return null;
}

function parseSelectionChoice(text, defaultMediaType) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    return {
      index: Number(value),
      mediaType: defaultMediaType
    };
  }

  const mediaFirst = value.match(/^([a-z]+)\s*(\d+)$/);
  if (mediaFirst) {
    const mediaType = normalizeMediaToken(mediaFirst[1]);
    if (!mediaType) {
      return null;
    }

    return {
      index: Number(mediaFirst[2]),
      mediaType
    };
  }

  const indexFirst = value.match(/^(\d+)\s*([a-z]+)$/);
  if (indexFirst) {
    const mediaType = normalizeMediaToken(indexFirst[2]);
    if (!mediaType) {
      return null;
    }

    return {
      index: Number(indexFirst[1]),
      mediaType
    };
  }

  return null;
}

function getVideoSupport(video) {
  const duration = Number(video?.durationSeconds) || 0;
  return {
    audio: duration > 0 && duration <= config.maxAudioDuration,
    video: duration > 0 && duration <= config.maxVideoDuration
  };
}

function getVideoSupportLabel(video) {
  const support = getVideoSupport(video);

  if (support.audio && support.video) {
    return 'A/V';
  }

  if (support.audio) {
    return 'A';
  }

  if (support.video) {
    return 'V';
  }

  return '-';
}

function assertDurationForMedia(video, mediaType) {
  const duration = Number(video?.durationSeconds) || 0;
  const limit = mediaType === MEDIA_VIDEO ? config.maxVideoDuration : config.maxAudioDuration;

  if (!duration || duration <= 0) {
    throw new YoutubeError('INVALID_DURATION', 'Nao foi possivel determinar a duracao do video.');
  }

  if (duration > limit) {
    throw new YoutubeError(
      mediaType === MEDIA_VIDEO ? 'VIDEO_DURATION_LIMIT' : 'AUDIO_DURATION_LIMIT',
      'Duracao acima do limite permitido.',
      { durationSeconds: duration, maxDurationSeconds: limit }
    );
  }
}

function formatSearchOptionLine(option, index) {
  if (option.kind === 'playlist') {
    return `${index}. [Playlist] ${option.title} - ${option.author} (${option.videoCount} videos)`;
  }

  const supportLabel = getVideoSupportLabel(option);
  return `${index}. [Video ${supportLabel}] ${option.title} - ${option.author} (${option.durationText})`;
}

function buildSelectionInstructions(defaultMediaType) {
  return [
    `${bold('Selecao')}: responda com o numero da opcao.`,
    `${mono('a+numero')} para audio MP3 (ex: ${mono('a1')})`,
    `${mono('v+numero')} para video 720p (ex: ${mono('v1')})`,
    `Somente numero usa o padrao: ${getDefaultMediaLabel(defaultMediaType)}.`,
    `Tempo limite: ${config.selectionTimeoutSeconds}s.`,
    `${mono('/cancel')} para cancelar.`
  ];
}

function buildSearchOptionsText(query, options, defaultMediaType) {
  const lines = [`🔎 ${bold('Resultados')}`, `${bold('Busca')}: ${query}`, ''];

  options.forEach((option, index) => {
    lines.push(formatSearchOptionLine(option, index + 1));
  });

  lines.push('');
  lines.push(...buildSelectionInstructions(defaultMediaType));

  return lines.join('\n');
}

function buildPlaylistOptionsText(playlist, options, defaultMediaType) {
  const lines = [
    `📚 ${bold('Playlist')}: ${playlist.title}`,
    `${bold('Canal')}: ${playlist.author}`,
    ''
  ];

  options.forEach((option, index) => {
    const supportLabel = getVideoSupportLabel(option);
    lines.push(`${index + 1}. [${supportLabel}] ${option.title} - ${option.author} (${option.durationText})`);
  });

  lines.push('');
  lines.push(...buildSelectionInstructions(defaultMediaType));

  return lines.join('\n');
}

async function enqueueMediaJob(context, video, mediaType) {
  const { position, promise } = queue.add(() =>
    processSelectedMedia({
      video,
      mediaType,
      replyText: context.replyText,
      replyAudio: context.replyAudio,
      replyVideo: context.replyVideo
    })
  );

  await context.replyText(`⏳ ${bold('Pedido recebido')}\nPosicao na fila: ${position}`);

  promise.catch((error) => {
    console.error('Erro nao tratado no job da fila:', error);
  });
}

async function processSelectedMedia({ video, mediaType, replyText, replyAudio, replyVideo }) {
  let outputFile = null;

  try {
    if (mediaType === MEDIA_VIDEO) {
      await replyText(`⬇️ ${bold('Baixando video 720p')}\n${video.title} (${video.durationText})`);

      const downloadResult = await downloadVideo(video, {
        downloadPath: config.downloadPath,
        maxFileSize: config.maxVideoFileSize,
        ytDlpCookiesFile: config.ytDlpCookiesFile,
        ytDlpCookiesFromBrowser: config.ytDlpCookiesFromBrowser,
        ytDlpExtractorArgs: config.ytDlpExtractorArgs,
        ytDlpJsRuntimes: config.ytDlpJsRuntimes,
        ytDlpRemoteComponents: config.ytDlpRemoteComponents,
        ytDlpConcurrentFragments: config.ytDlpConcurrentFragments
      });

      outputFile = downloadResult.filePath;

      try {
        await replyVideo(outputFile, `🎬 ${video.title}`);
      } catch (sendError) {
        if (isWhatsAppSizeError(sendError)) {
          throw new DownloadError('FILE_TOO_LARGE', 'Arquivo excede o limite de envio do WhatsApp.');
        }

        sendError.code = 'WHATSAPP_SEND_VIDEO_FAILED';
        throw sendError;
      }

      await replyText(`✅ ${bold('Video enviado com sucesso.')}`);
      return;
    }

    await replyText(`⬇️ ${bold('Baixando audio')}\n${video.title} (${video.durationText})`);

    const downloadResult = await downloadAudio(video, {
      downloadPath: config.downloadPath,
      maxFileSize: config.maxAudioFileSize,
      ytDlpCookiesFile: config.ytDlpCookiesFile,
      ytDlpCookiesFromBrowser: config.ytDlpCookiesFromBrowser,
      ytDlpExtractorArgs: config.ytDlpExtractorArgs,
      ytDlpJsRuntimes: config.ytDlpJsRuntimes,
      ytDlpRemoteComponents: config.ytDlpRemoteComponents,
      audioQuality: config.audioQuality,
      ytDlpConcurrentFragments: config.ytDlpConcurrentFragments
    });

    outputFile = downloadResult.filePath;

    try {
      await replyAudio(outputFile, `🎵 ${video.title}`);
    } catch (sendError) {
      if (isWhatsAppSizeError(sendError)) {
        throw new DownloadError('FILE_TOO_LARGE', 'Arquivo excede o limite de envio do WhatsApp.');
      }

      sendError.code = 'WHATSAPP_SEND_AUDIO_FAILED';
      throw sendError;
    }

    await replyText(`✅ ${bold('Audio enviado com sucesso.')}`);
  } catch (error) {
    console.error('Erro no processamento da midia:', error);
    await replyText(`❌ ${mapPlayError(error)}`);
  } finally {
    // Sempre remove o arquivo temporario para evitar acumulo no servidor.
    await safeUnlink(outputFile);
  }
}

async function showPlaylistTracks(context, playlistInput, defaultMediaType) {
  await context.replyText(`📚 ${bold('Carregando itens da playlist...')}`);

  const { playlist, videoOptions } = await getPlaylistOptions(playlistInput, {
    maxDurationSeconds: getMaxSearchDuration(),
    maxPlaylistItems: config.maxPlaylistItems
  });

  setPendingSelection(context.chatId, {
    mode: 'playlist_tracks',
    playlist,
    options: videoOptions,
    defaultMediaType
  });

  await context.replyText(buildPlaylistOptionsText(playlist, videoOptions, defaultMediaType));
}

async function handlePlayCommand(context, query, defaultMediaType) {
  clearPendingSelection(context.chatId);

  if (isLikelyUrl(query)) {
    await context.replyText(`🔎 ${bold('Validando link...')}`);

    try {
      const video = await getVideoFromInput(query, getMaxSearchDuration());
      assertDurationForMedia(video, defaultMediaType);
      await enqueueMediaJob(context, video, defaultMediaType);
      return;
    } catch (error) {
      if (error instanceof YoutubeError && error.code === 'PLAYLIST_URL_DETECTED') {
        await showPlaylistTracks(context, query, defaultMediaType);
        return;
      }

      throw error;
    }
  }

  await context.replyText(`🔎 ${bold('Buscando opcoes no YouTube...')}`);

  const options = await searchMediaOptions(query, {
    maxDurationSeconds: getMaxSearchDuration(),
    maxVideoResults: config.maxSearchOptions,
    maxPlaylistResults: config.maxSearchOptions,
    maxTotalOptions: config.maxSearchOptions
  });

  setPendingSelection(context.chatId, {
    mode: 'search_results',
    query,
    options,
    defaultMediaType
  });

  await context.replyText(buildSearchOptionsText(query, options, defaultMediaType));
}

async function handlePendingSelection(context, pending, selection) {
  const { index, mediaType } = selection;
  const option = pending.options[index - 1];

  if (!option) {
    await context.replyText(`⚠️ ${bold('Opcao invalida')}. Escolha um numero entre 1 e ${pending.options.length}.`);
    return;
  }

  if (pending.mode === 'search_results') {
    if (option.kind === 'playlist') {
      clearPendingSelection(context.chatId);
      await showPlaylistTracks(context, option.url, mediaType);
      return;
    }

    assertDurationForMedia(option, mediaType);
    clearPendingSelection(context.chatId);
    await enqueueMediaJob(context, option, mediaType);
    return;
  }

  if (pending.mode === 'playlist_tracks') {
    assertDurationForMedia(option, mediaType);
    clearPendingSelection(context.chatId);
    await enqueueMediaJob(context, option, mediaType);
  }
}

async function handleIncomingCommand(context) {
  const { chatId, text, replyText, quotedText } = context;
  const normalizedText = text.trim();
  const pending = getPendingSelection(chatId);
  const parsed = parseCommand(normalizedText);

  if (parsed.type === 'cancel') {
    if (!pending) {
      await replyText(`ℹ️ ${bold('Nao existe selecao pendente para cancelar.')}`);
      return;
    }

    clearPendingSelection(chatId);
    await replyText(`❎ ${bold('Selecao cancelada.')}`);
    return;
  }

  if (pending) {
    const selection = parseSelectionChoice(normalizedText, pending.defaultMediaType || MEDIA_AUDIO);
    if (selection) {
      try {
        await handlePendingSelection(context, pending, selection);
      } catch (error) {
        console.error('Erro ao tratar selecao pendente:', error);
        await replyText(`❌ ${mapPlayError(error)}`);
      }
      return;
    }

    if (!normalizedText.startsWith('/')) {
      await replyText(`Envie ${mono('numero')}, ${mono('a+numero')}, ${mono('v+numero')} ou ${mono('/cancel')}.`);
      return;
    }
  }

  if (parsed.type === 'none') {
    return;
  }

  if (parsed.type === 'help') {
    await replyText(buildHelpText());
    return;
  }

  if (parsed.type === 'unknown') {
    await replyText(`⚠️ ${bold('Comando invalido')}. Use ${mono('/help')} para ver os comandos disponiveis.`);
    return;
  }

  if (parsed.error === 'EMPTY_QUERY') {
    const fallbackQuery = String(quotedText || '').trim();
    if (fallbackQuery) {
      const defaultMediaType = parsed.type === 'video' ? MEDIA_VIDEO : MEDIA_AUDIO;
      try {
        await handlePlayCommand(context, fallbackQuery, defaultMediaType);
      } catch (error) {
        console.error(`Erro no comando /${parsed.type} via quote:`, error);
        await replyText(`❌ ${mapPlayError(error)}`);
      }
      return;
    }

    const usage = parsed.type === 'video'
      ? `${bold('Uso')}: ${mono('/video <nome, URL de video ou URL de playlist>')}`
      : `${bold('Uso')}: ${mono('/play <nome, URL de video ou URL de playlist>')}`;
    await replyText(`${usage}\nOu responda uma mensagem com ${mono('/play')} / ${mono('/video')}.`);
    return;
  }

  if (parsed.type === 'play' || parsed.type === 'video') {
    const defaultMediaType = parsed.type === 'video' ? MEDIA_VIDEO : MEDIA_AUDIO;

    try {
      await handlePlayCommand(context, parsed.query, defaultMediaType);
    } catch (error) {
      console.error(`Erro no comando /${parsed.type}:`, error);
      await replyText(`❌ ${mapPlayError(error)}`);
    }
  }
}

async function bootstrap() {
  await ensureDirectory(config.downloadPath);
  await ensureDirectory(config.sessionPath);

  console.log('Iniciando WhatsApp Music Bot...');
  console.log(`Pasta de downloads: ${config.downloadPath}`);
  console.log(`Limite audio: ${formatSeconds(config.maxAudioDuration)}`);
  console.log(`Limite video: ${formatSeconds(config.maxVideoDuration)} (720p)`);

  await startWhatsApp({
    sessionPath: config.sessionPath,
    onTextMessage: handleIncomingCommand
  });
}

bootstrap().catch((error) => {
  console.error('Falha ao iniciar o bot:', error);
  process.exit(1);
});

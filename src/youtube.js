const yts = require('yt-search');
const {
  extractYouTubePlaylistId,
  extractYouTubeVideoId,
  formatSeconds,
  isLikelyUrl,
  parseTimestampToSeconds
} = require('./utils');

class YoutubeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'YoutubeError';
    this.code = code;
    this.details = details;
  }
}

function getDurationDetails(video) {
  const fromSeconds = Number(video?.seconds);
  const fromDurationObject = Number(video?.duration?.seconds);
  const timestamp =
    video?.timestamp ||
    video?.duration?.timestamp ||
    video?.duration?.toString?.() ||
    '';
  const parsed = parseTimestampToSeconds(timestamp);

  const durationSeconds = fromSeconds || fromDurationObject || parsed;
  const durationText = timestamp || formatSeconds(durationSeconds);

  return {
    durationSeconds,
    durationText
  };
}

function normalizeVideo(video) {
  if (!video) {
    return null;
  }

  const url =
    video.url ||
    (video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : '');

  if (!url) {
    return null;
  }

  const { durationSeconds, durationText } = getDurationDetails(video);

  return {
    kind: 'video',
    title: video.title || 'Sem titulo',
    url,
    durationSeconds,
    durationText,
    author: video.author?.name || video.author || 'Desconhecido'
  };
}

function normalizePlaylist(playlist) {
  if (!playlist) {
    return null;
  }

  const listId = playlist.listId || extractYouTubePlaylistId(playlist.url || '');
  if (!listId) {
    return null;
  }

  const url = playlist.url || `https://www.youtube.com/playlist?list=${listId}`;
  const videoCount = Number(playlist.videoCount || playlist.size) || 0;

  return {
    kind: 'playlist',
    listId,
    url,
    title: playlist.title || 'Playlist sem titulo',
    author: playlist.author?.name || playlist.author || 'Desconhecido',
    videoCount
  };
}

function assertVideoDuration(video, maxDurationSeconds) {
  if (!video || !video.durationSeconds || video.durationSeconds <= 0) {
    throw new YoutubeError('INVALID_DURATION', 'Nao foi possivel determinar a duracao do video.');
  }

  if (video.durationSeconds > maxDurationSeconds) {
    throw new YoutubeError('DURATION_LIMIT', 'Video acima do limite permitido.', {
      durationSeconds: video.durationSeconds,
      maxDurationSeconds
    });
  }
}

function assertPlaylistId(input) {
  const playlistId = extractYouTubePlaylistId(input);
  if (!playlistId) {
    throw new YoutubeError('INVALID_URL', 'A URL enviada nao e um link valido do YouTube.');
  }

  return playlistId;
}

async function getVideoFromInput(input, maxDurationSeconds) {
  let normalized;

  if (isLikelyUrl(input)) {
    const playlistId = extractYouTubePlaylistId(input);
    const videoId = extractYouTubeVideoId(input);

    if (playlistId && !videoId) {
      throw new YoutubeError('PLAYLIST_URL_DETECTED', 'URL de playlist detectada.');
    }

    if (!videoId) {
      throw new YoutubeError('INVALID_URL', 'A URL enviada nao e um link valido do YouTube.');
    }

    const video = await yts({ videoId });
    normalized = normalizeVideo(video);
  } else {
    const result = await yts(input);
    normalized = normalizeVideo(result?.videos?.[0]);
  }

  if (!normalized) {
    throw new YoutubeError('NOT_FOUND', 'Nenhum video encontrado para a busca informada.');
  }

  assertVideoDuration(normalized, maxDurationSeconds);
  return normalized;
}

function combineSearchResults(videoOptions, playlistOptions, maxTotalOptions) {
  const mixed = [];
  let videoIndex = 0;
  let playlistIndex = 0;

  while (
    mixed.length < maxTotalOptions &&
    (videoIndex < videoOptions.length || playlistIndex < playlistOptions.length)
  ) {
    if (videoIndex < videoOptions.length) {
      mixed.push(videoOptions[videoIndex]);
      videoIndex += 1;
    }

    if (mixed.length >= maxTotalOptions) {
      break;
    }

    if (playlistIndex < playlistOptions.length) {
      mixed.push(playlistOptions[playlistIndex]);
      playlistIndex += 1;
    }
  }

  return mixed;
}

async function searchMediaOptions(query, options = {}) {
  const {
    maxDurationSeconds = 600,
    maxVideoResults = 6,
    maxPlaylistResults = 4,
    maxTotalOptions = 8
  } = options;

  const result = await yts(query);
  const videos = (result?.videos || [])
    .map(normalizeVideo)
    .filter(Boolean)
    .filter((video) => video.durationSeconds > 0 && video.durationSeconds <= maxDurationSeconds)
    .slice(0, maxVideoResults);

  const playlists = (result?.playlists || [])
    .map(normalizePlaylist)
    .filter(Boolean)
    .slice(0, maxPlaylistResults);

  const combined = combineSearchResults(videos, playlists, maxTotalOptions);

  if (combined.length === 0) {
    throw new YoutubeError('NOT_FOUND', 'Nenhum resultado valido encontrado para a busca informada.');
  }

  return combined;
}

async function getPlaylistOptions(input, options = {}) {
  const {
    maxDurationSeconds = 600,
    maxPlaylistItems = 10
  } = options;

  const listId = assertPlaylistId(input);
  const playlistData = await yts({ listId });
  const playlist = normalizePlaylist({
    listId: playlistData?.listId,
    url: playlistData?.url || `https://www.youtube.com/playlist?list=${listId}`,
    title: playlistData?.title,
    author: playlistData?.author,
    size: playlistData?.size
  });

  if (!playlist) {
    throw new YoutubeError('PLAYLIST_NOT_FOUND', 'Playlist nao encontrada.');
  }

  const videoOptions = (playlistData?.videos || [])
    .map(normalizeVideo)
    .filter(Boolean)
    .filter((video) => video.durationSeconds > 0 && video.durationSeconds <= maxDurationSeconds)
    .slice(0, maxPlaylistItems);

  if (videoOptions.length === 0) {
    throw new YoutubeError('PLAYLIST_NO_VALID_VIDEOS', 'Nenhum video valido encontrado na playlist.');
  }

  return {
    playlist,
    videoOptions
  };
}

module.exports = {
  getPlaylistOptions,
  getVideoFromInput,
  searchMediaOptions,
  YoutubeError
};

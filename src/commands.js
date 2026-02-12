function parseCommand(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { type: 'none' };
  }

  const text = rawText.trim();
  if (!text.startsWith('/')) {
    return { type: 'none' };
  }

  const firstSpace = text.indexOf(' ');
  const rawCommand = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const command = rawCommand.toLowerCase();

  if (command === '/help') {
    return { type: 'help' };
  }

  if (command === '/cancel') {
    return { type: 'cancel' };
  }

  if (command === '/play') {
    const query = (firstSpace === -1 ? '' : text.slice(firstSpace + 1)).trim();

    if (!query) {
      return { type: 'play', error: 'EMPTY_QUERY' };
    }

    return {
      type: 'play',
      query
    };
  }

  if (command === '/video') {
    const query = (firstSpace === -1 ? '' : text.slice(firstSpace + 1)).trim();

    if (!query) {
      return { type: 'video', error: 'EMPTY_QUERY' };
    }

    return {
      type: 'video',
      query
    };
  }

  return {
    type: 'unknown',
    command
  };
}

module.exports = {
  parseCommand
};

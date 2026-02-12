const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const { ensureDirectory } = require('./utils');

let currentSocket = null;

function extractText(message) {
  if (!message) {
    return '';
  }

  if (message.conversation) {
    return message.conversation;
  }

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  if (message.ephemeralMessage?.message) {
    return extractText(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessageV2?.message) {
    return extractText(message.viewOnceMessageV2.message);
  }

  return '';
}

async function sendText(socket, chatId, text, quotedMessage) {
  await socket.sendMessage(chatId, { text }, { quoted: quotedMessage });
}

async function sendAudio(socket, chatId, filePath, quotedMessage, caption = '') {
  await fs.promises.access(filePath, fs.constants.R_OK);

  await socket.sendMessage(
    chatId,
    {
      // Baileys espera media em Buffer, { stream } ou { url }.
      audio: { url: filePath },
      mimetype: 'audio/mpeg',
      ptt: false
    },
    { quoted: quotedMessage }
  );

  if (caption) {
    await socket.sendMessage(chatId, { text: caption }, { quoted: quotedMessage });
  }
}

async function sendVideo(socket, chatId, filePath, quotedMessage, caption = '') {
  await fs.promises.access(filePath, fs.constants.R_OK);

  await socket.sendMessage(
    chatId,
    {
      video: { url: filePath },
      mimetype: 'video/mp4',
      fileName: path.basename(filePath),
      caption
    },
    { quoted: quotedMessage }
  );
}

async function startWhatsApp({ sessionPath, onTextMessage }) {
  await ensureDirectory(sessionPath);

  let reconnectTimeout = null;
  let lastQr = null;

  const connect = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: state,
      browser: ['MusicBot', 'Headless', '1.0.0'],
      logger: pino({ level: 'warn' }),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    currentSocket = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && qr !== lastQr) {
        lastQr = qr;
        console.log('Novo QR recebido. Escaneie com o WhatsApp:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        lastQr = null;
        console.log('WhatsApp conectado com sucesso.');
        return;
      }

      if (connection !== 'close') {
        return;
      }

      const statusCode =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode;

      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        console.error('Sessao encerrada. Remova a pasta de sessao para reautenticar.');
        return;
      }

      if (!reconnectTimeout) {
        // Reconexao automatica para manter o bot online em modo headless.
        console.warn('Conexao perdida. Tentando reconectar em 5 segundos...');

        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          connect().catch((error) => {
            console.error('Falha ao reconectar ao WhatsApp:', error);
          });
        }, 5000);
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        return;
      }

      for (const item of messages) {
        if (!item?.message || item.key.fromMe) {
          continue;
        }

        const chatId = item.key.remoteJid;
        if (!chatId || chatId === 'status@broadcast') {
          continue;
        }

        const text = extractText(item.message).trim();
        if (!text) {
          continue;
        }

        try {
          await onTextMessage({
            chatId,
            message: item,
            text,
            replyText: async (responseText) => {
              if (!currentSocket) {
                throw new Error('WHATSAPP_NOT_CONNECTED');
              }

              await sendText(currentSocket, chatId, responseText, item);
            },
            replyAudio: async (filePath, caption) => {
              if (!currentSocket) {
                throw new Error('WHATSAPP_NOT_CONNECTED');
              }

              await sendAudio(currentSocket, chatId, filePath, item, caption);
            },
            replyVideo: async (filePath, caption) => {
              if (!currentSocket) {
                throw new Error('WHATSAPP_NOT_CONNECTED');
              }

              await sendVideo(currentSocket, chatId, filePath, item, caption);
            }
          });
        } catch (error) {
          console.error('Erro ao processar mensagem recebida:', error);
        }
      }
    });
  };

  await connect();
}

module.exports = {
  startWhatsApp
};

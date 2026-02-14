# WhatsApp Music Bot

Bot profissional de WhatsApp (headless) para receber comandos, buscar musica no YouTube, baixar audio em MP3 e enviar o arquivo direto no chat.

## Stack

- Node.js 20+
- [@whiskeysockets/baileys](https://www.npmjs.com/package/@whiskeysockets/baileys)
- [yt-search](https://www.npmjs.com/package/yt-search)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (binario no sistema)
- ffmpeg instalado no sistema
- dotenv

## Estrutura

```text
/whatsapp-music-bot
├── src/
│   ├── index.js
│   ├── whatsapp.js
│   ├── commands.js
│   ├── youtube.js
│   ├── downloader.js
│   ├── queue.js
│   ├── config.js
│   └── utils.js
├── downloads/
├── .env.example
├── package.json
└── README.md
```

## Fluxo

WhatsApp (Baileys) -> parser de comandos -> busca no YouTube (videos + playlists) -> selecao de opcao por numero (audio/video) -> fila de processamento -> download/conversao -> envio no chat -> limpeza do arquivo temporario.

Para videos, o bot baixa e converte para MP4 compativel com WhatsApp (H.264 + AAC), com compactacao para reduzir tamanho e permitir duracoes maiores.

## Dependencias de sistema

Assumindo Linux (Ubuntu/Debian):

```bash
sudo apt update
sudo apt install -y ffmpeg
```

Instale `yt-dlp` no sistema (uma das opcoes):

```bash
sudo apt install -y yt-dlp
# ou
python3 -m pip install -U yt-dlp
```

No Windows (PowerShell com `winget`):

```powershell
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
winget install -e --id yt-dlp.yt-dlp --accept-package-agreements --accept-source-agreements
```

## Instalacao

```bash
cd whatsapp-music-bot
cp .env.example .env
npm install
```

## Configuracao (`.env`)

- `DOWNLOAD_PATH`: pasta de arquivos temporarios (MP3/MP4).
- `MAX_AUDIO_DURATION`: limite maximo para audio em segundos (padrao: `1800` = 30 min).
- `MAX_VIDEO_DURATION`: limite maximo para video em segundos (padrao: `7200` = 2h).
- `SESSION_PATH`: pasta de sessao/autenticacao do Baileys.
- `MAX_AUDIO_FILE_SIZE`: limite maximo de tamanho do audio em bytes (padrao: `524288000` = 500MB).
- `MAX_VIDEO_FILE_SIZE`: limite maximo de tamanho do video em bytes (padrao: `524288000` = 500MB).
- `MAX_SEARCH_OPTIONS`: quantidade maxima de opcoes retornadas na busca (padrao: `8`).
- `MAX_PLAYLIST_ITEMS`: quantidade maxima de faixas listadas ao escolher playlist (padrao: `10`).
- `SELECTION_TIMEOUT_SECONDS`: tempo maximo para o usuario escolher uma opcao (padrao: `120`).
- `AUDIO_QUALITY`: qualidade do MP3 no `yt-dlp` (`0` melhor/mais pesado, `9` menor/mais rapido; padrao: `3`).
- `AUDIO_BITRATE_KBPS`: bitrate final do MP3 (padrao: `160`).
- `AUDIO_CHANNELS`: canais de audio (`1` mono, `2` stereo; padrao: `2`).
- `AUDIO_SAMPLE_RATE`: sample rate final do audio (padrao: `44100`).
- `VIDEO_MAX_HEIGHT`: altura maxima alvo na compactacao de video (padrao: `480`).
- `VIDEO_CRF`: fator de qualidade do H.264 (`18` melhor/maior, `40` menor/mais comprimido; padrao: `30`).
- `VIDEO_AUDIO_BITRATE_KBPS`: bitrate do audio em videos convertidos (padrao: `64`).
- `YTDLP_CONCURRENT_FRAGMENTS`: downloads concorrentes no `yt-dlp` para acelerar (padrao: `6`).
- `YTDLP_COOKIES_FILE` (opcional): caminho de `cookies.txt` para evitar bloqueio anti-bot do YouTube.
- `YTDLP_COOKIES_FROM_BROWSER` (opcional): usa cookies direto do browser (`chrome`, `firefox`, etc).
- `YTDLP_EXTRACTOR_ARGS` (opcional): argumentos extras do yt-dlp (ex: `youtube:player_client=android`).
- `YTDLP_JS_RUNTIMES` (opcional): runtime JS para resolver challenge (ex: `deno`).
- `YTDLP_REMOTE_COMPONENTS` (opcional): componentes remotos do challenge solver (ex: `ejs:github`).

## Executar localmente

```bash
npm start
```

No primeiro start, o QR Code aparece no terminal. Escaneie com o WhatsApp para autenticar.

## Executar em servidor (headless)

1. Instale Node.js 20+, ffmpeg e yt-dlp.
2. Suba o projeto no servidor.
3. Rode o bot em processo persistente (systemd, pm2 ou tmux).
4. Faça o pareamento via QR no primeiro boot.
5. Mantenha a pasta de sessao (`SESSION_PATH`) persistida em disco.

Exemplo rapido com `pm2`:

```bash
npm install -g pm2
pm2 start src/index.js --name whatsapp-music-bot
pm2 save
```

## Comandos

- `/play <nome/url>` (padrao: audio MP3)
- `/video <nome/url>` (padrao: video compacto)
- `/cancel`
- `/help`

### Como funciona a selecao

1. Envie `/play <termo>` ou `/video <termo>`.
2. O bot retorna opcoes com titulo, canal, duracao e tipo.
3. Responda com:
   - `1` para usar o formato padrao do comando.
   - `a1` para forcar audio MP3.
   - `v1` para forcar video compacto.
4. Se escolher playlist, o bot retorna as musicas da playlist para nova selecao.

### Uso com quote (responder mensagem)

Voce pode responder qualquer mensagem de texto com:

- `/play`
- `/video`

Sem repetir o conteudo. O bot usa automaticamente o texto da mensagem citada como busca.

## Tratamento de erros implementado

- URL invalida
- Musica nao encontrada
- Audio acima do limite de 30 minutos
- Video acima do limite de 2 horas (configuravel)
- Playlist nao encontrada ou sem faixas validas
- Erro no yt-dlp
- Arquivo acima do limite de tamanho
- Falha de envio quando WhatsApp desconectar

## Observacoes

- Downloads sao processados com fila (1 por vez).
- O usuario recebe posicao quando entra em fila.
- Arquivos MP3 sao removidos apos envio ou falha.
- Codigo modular e pronto para uso pessoal em producao.

## Erro "Sign in to confirm you're not a bot"

Se o YouTube bloquear a VPS, configure cookies:

1. Exporte um `cookies.txt` valido da sua conta YouTube.
2. Coloque o arquivo no servidor (ex: `/home/ubuntu/WhatsApp-Music-Bot/cookies.txt`).
3. No `.env`, defina:

```bash
YTDLP_COOKIES_FILE=/home/ubuntu/WhatsApp-Music-Bot/cookies.txt
# opcional para VPS bloqueada:
YTDLP_EXTRACTOR_ARGS=youtube:player_client=android
YTDLP_JS_RUNTIMES=deno
YTDLP_REMOTE_COMPONENTS=ejs:github
```

4. Reinicie o bot (`pm2 restart whatsapp-music-bot --update-env`).

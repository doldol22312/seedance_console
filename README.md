# Seedance Volcengine Workbench

Local web app for Seedance 2.0 on Volcengine Ark. It includes:

- Ark API key checker
- server-side in-memory key pool
- round-robin key rotation
- Seedance 2.0 / Seedance 2.0 Fast task creation
- task polling and video preview
- optional Qwen Console for HappyHorse 1.1 text-to-video and image-to-video
- clipboard image/video paste for reference media inputs
- automatic Litterbox upload for pasted reference videos
- optional autosave of generated videos to a local folder
- up to 9 Seedance 2.0 reference images

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL shown in the terminal. In development, the frontend runs on port 5173 and proxies `/api` to the Express backend on port 8790.

You can provide keys in `.env` with `ARK_API_KEYS`, or paste them into the Key Pool panel and activate them from the UI. Keys are stored in backend memory only and are never returned unmasked by the API.

Qwen Console is disabled by default. To show it, set `QWEN_CONSOLE_ENABLED=true` and `DASHSCOPE_API_KEY` in `.env`. It can submit HappyHorse 1.1 text-to-video tasks with `happyhorse-1.1-t2v` and first-frame image-to-video tasks with `happyhorse-1.1-i2v`, then poll task IDs from the same panel. Override `DASHSCOPE_VIDEO_ENDPOINT` or `DASHSCOPE_TASK_ENDPOINT` only if your DashScope account uses a different region endpoint.

Backend outbound requests go direct by default. To enable a proxy for Ark calls, public media URL preflight, Litterbox uploads, and autosave downloads, set `APP_PROXY_URL` or `ARK_PROXY_URL` to a value such as `socks5://127.0.0.1:2080`; `APP_PROXY_URL` wins when both are set. Set the chosen value to `off` to force direct connections.

For first-frame image-to-video, focus the Generation panel and paste an image with `Ctrl+V`, or use the Paste button in the Image field. Public URLs still work in the same field.

For Seedance 2.0 reference images, use the Reference Images field. It supports pasted images, public image URLs, and `asset://` IDs. Each entry is sent as an `image_url` content item with `role: "reference_image"`, up to 9 images.

Pasted images can be submitted directly. Pasted videos are previewed immediately, uploaded to Litterbox, and then submitted as the returned public video URL. The default Litterbox expiry is `12h`; set `LITTERBOX_EXPIRY` to `1h`, `12h`, `24h`, or `72h` to change it.

The backend performs a small byte-range preflight for public Video and Audio URLs before creating an Ark task. If Ark still reports `timeout while fetching resource`, the file host is not reachable fast enough from Volcengine Ark; rehost the media on a stable public bucket/CDN or use an `asset://` ID.

Video and Audio reference media are sent with `reference_video` and `reference_audio`. Manual Video URL entries can still be public video URLs or `asset://` IDs.

Use the Autosave panel to enable local saving of generated videos. Choose a folder with the system dialog or enter a writable folder path manually; settings save automatically. Completed task videos are downloaded by the backend after polling returns `content.video_url`. The setting is stored in `.autosave-settings.json`, and `.env` can provide initial defaults with `AUTOSAVE_ENABLED` and `AUTOSAVE_DIR`.

## Ark Defaults

- Base URL: `https://ark.cn-beijing.volces.com/api/v3`
- Create task: `POST /contents/generations/tasks`
- Query task: `GET /contents/generations/tasks/{id}`
- Key check: `GET /contents/generations/tasks?page_num=1&page_size=1`

## Qwen Defaults

- Submit task: `DASHSCOPE_VIDEO_ENDPOINT`
- Query task: `GET {DASHSCOPE_TASK_ENDPOINT}/{task_id}`
- Models: `happyhorse-1.1-t2v`, `happyhorse-1.1-i2v`
- Resolutions: `720P`, `1080P`

## Model Watchtower

The watchtower polls Ark `/models` endpoints, tracks models matching `WATCHTOWER_MODEL_FILTER`, and sends Telegram alerts when matching models are added, removed, or changed.

Add these to `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:telegram-token
TELEGRAM_CHAT_ID=123456789
TELEGRAM_COMMANDS=true
ARK_PROXY_URL=socks5://127.0.0.1:2080
WATCHTOWER_MODEL_FILTER=seed
WATCHTOWER_INTERVAL_MS=60000
WATCHTOWER_CONCURRENCY=64
```

To check every key in `../keychecker/working_doubao_models.txt`, use the key-file scripts:

```bash
npm run watchtower:keys:dry-run
npm run watchtower:keys:once
npm run watchtower:keys
```

Key-file mode queries every key independently with hashed key labels in the snapshot and alerts. The bundled key-file scripts set `ARK_PROXY_URL=socks5://127.0.0.1:2080` and `WATCHTOWER_IGNORE_ENV_KEYS=true`, so only keys from that file are checked through the local SOCKS5 proxy. Its default state file is `.watchtower/ark-seed-models-all-keys.json`.

All-key alerts are grouped by model/change shape by default, so a new model visible on many keys is sent as one line with `keys=<count>` and sample hashed key labels instead of one line per key. Use `WATCHTOWER_AGGREGATE_CHANGES=false` only when you want raw per-key detail. `WATCHTOWER_MAX_CHANGE_LINES=120` caps the detailed change lines in one alert.

The all-key scan uses `WATCHTOWER_CONCURRENCY=64` by default. On the local SOCKS5 proxy this cuts the 56-key, two-endpoint check from about 20 seconds to about 5 seconds.

Telegram bot commands are registered automatically when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set and the continuous watcher is running:

```text
/status - show watcher status
/check - run a model check now
/models - list tracked Seed model groups
/errors - show current key/API errors
/reset confirm - delete the current baseline
/ping - check bot responsiveness
/help - show commands
```

Only `TELEGRAM_CHAT_ID` is allowed to execute commands. Command polling stores its offset in `.watchtower/telegram-offset.json` so old commands are not replayed after restart.

Useful commands:

```bash
# Seed-family dry run without writing state or sending Telegram
npm run watchtower:dry-run

# One check using the normal Ark key pool
npm run watchtower:once

# Continuous watcher using the normal Ark key pool
npm run watchtower

# Dry run across every key in ../keychecker/working_doubao_models.txt
npm run watchtower:keys:dry-run

# One check across every key and write/update the all-key baseline
npm run watchtower:keys:once

# Continuous all-key watcher, through socks5://127.0.0.1:2080
npm run watchtower:keys

# Reset the normal baseline; next run creates a fresh baseline
npm run watchtower:reset

# Reset the all-key baseline; next all-key run creates a fresh baseline
npm run watchtower:keys:reset
```

The first non-dry run writes `.watchtower/ark-seed-models.json` as the baseline and does not alert unless `WATCHTOWER_NOTIFY_INITIAL=true`. Later runs compare against that snapshot and send Telegram messages for changes.

PowerShell helpers:

```powershell
# Run one all-key check with a Telegram token/chat id only for this process
$env:TELEGRAM_BOT_TOKEN="123456:telegram-token"; $env:TELEGRAM_CHAT_ID="123456789"; npm run watchtower:keys:once; Remove-Item Env:TELEGRAM_BOT_TOKEN; Remove-Item Env:TELEGRAM_CHAT_ID

# Ask Telegram for recent chat ids through the local SOCKS5 proxy
curl.exe -sS --socks5 127.0.0.1:2080 "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getUpdates"
```

## Notes

Seedance task URLs are provider-hosted assets. Save finished videos promptly if you need durable storage.

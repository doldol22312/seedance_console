# Seedance Volcengine Workbench

Local web app for Seedance 2.0 on Volcengine Ark. It includes:

- Ark API key checker
- server-side in-memory key pool
- round-robin key rotation
- Seedance 2.0 / Seedance 2.0 Fast task creation
- task polling and video preview
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

## Notes

Seedance task URLs are provider-hosted assets. Save finished videos promptly if you need durable storage.

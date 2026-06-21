# Seedance Volcengine Workbench

Local web app for Seedance 2.0 on Volcengine Ark. It includes:

- Ark API key checker
- server-side in-memory key pool
- round-robin key rotation
- Seedance 2.0 / Seedance 2.0 Fast task creation
- task polling and video preview
- clipboard image/video paste for reference media inputs

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL shown in the terminal. In development, the frontend runs on port 5173 and proxies `/api` to the Express backend on port 8787.

You can provide keys in `.env` with `ARK_API_KEYS`, or paste them into the Key Pool panel and activate them from the UI. Keys are stored in backend memory only and are never returned unmasked by the API.

For reference media, focus the Generation panel and paste an image or short video with `Ctrl+V`, or use the Paste button in the Image or Video field. Public URLs still work in the same fields.

Pasted images can be submitted directly. Pasted videos are previewed in the UI, but Seedance video references must be a public video URL or `asset://` ID before submission.

The backend performs a small byte-range preflight for public Video and Audio URLs before creating an Ark task. If Ark still reports `timeout while fetching resource`, the file host is not reachable fast enough from Volcengine Ark; rehost the media on a stable public bucket/CDN or use an `asset://` ID.

When you provide Video or Audio reference media, the Image field is sent as a `reference_image`. For strict first-frame image-to-video, leave Video and Audio empty.

## Ark Defaults

- Base URL: `https://ark.cn-beijing.volces.com/api/v3`
- Create task: `POST /contents/generations/tasks`
- Query task: `GET /contents/generations/tasks/{id}`
- Key check: `GET /contents/generations/tasks?page_num=1&page_size=1`

## Notes

Seedance task URLs are provider-hosted assets. Save finished videos promptly if you need durable storage.

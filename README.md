# Seedance Volcengine Workbench

Local web app for Seedance 2.0 on Volcengine Ark. It includes:

- Ark API key checker
- server-side in-memory key pool
- round-robin key rotation
- Seedance 2.0 / Seedance 2.0 Fast task creation
- task polling and video preview
- clipboard image paste for image-to-video inputs

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL shown in the terminal. In development, the frontend runs on port 5173 and proxies `/api` to the Express backend on port 8787.

You can provide keys in `.env` with `ARK_API_KEYS`, or paste them into the Key Pool panel and activate them from the UI. Keys are stored in backend memory only and are never returned unmasked by the API.

For image input, focus the Generation panel and paste an image with `Ctrl+V`, or use the Paste button in the Image field. Public image URLs still work in the same field.

## Ark Defaults

- Base URL: `https://ark.cn-beijing.volces.com/api/v3`
- Create task: `POST /contents/generations/tasks`
- Query task: `GET /contents/generations/tasks/{id}`
- Key check: `GET /contents/generations/tasks?page_num=1&page_size=1`

## Notes

Seedance task URLs are provider-hosted assets. Save finished videos promptly if you need durable storage.

import express from "express";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const PORT = Number(process.env.PORT || 8787);
const BASE_URL = stripTrailingSlash(process.env.ARK_BASE_URL || DEFAULT_BASE_URL);
const REQUEST_TIMEOUT_MS = Number(process.env.ARK_TIMEOUT_MS || 30_000);
const KEY_COOLDOWN_MS = Number(process.env.ARK_KEY_COOLDOWN_MS || 60_000);

const app = express();
app.use(express.json({ limit: "32mb" }));

const pool = createKeyPool({
  baseUrl: BASE_URL,
  timeoutMs: REQUEST_TIMEOUT_MS,
  cooldownMs: KEY_COOLDOWN_MS
});
pool.replace(parseKeys(process.env.ARK_API_KEYS || process.env.ARK_API_KEY || ""));

const taskKeyMap = new Map();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    keyCount: pool.summary().length,
    activeKeys: pool.summary().filter((key) => key.usable).length
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    baseUrl: BASE_URL,
    defaults: {
      model: "doubao-seedance-2-0-fast-260128",
      resolution: "720p",
      ratio: "16:9",
      duration: 5,
      generate_audio: true,
      watermark: false
    },
    models: [
      {
        id: "doubao-seedance-2-0-fast-260128",
        name: "Seedance 2.0 Fast"
      },
      {
        id: "doubao-seedance-2-0-260128",
        name: "Seedance 2.0"
      }
    ]
  });
});

app.get("/api/keys", (_req, res) => {
  res.json({ keys: pool.summary(), pointer: pool.pointer() });
});

app.post("/api/keys", async (req, res) => {
  const keys = parseKeys(req.body?.keys);
  pool.replace(keys);

  if (req.body?.check !== false) {
    const checked = await pool.checkAll();
    return res.json({ keys: checked, pointer: pool.pointer() });
  }

  res.json({ keys: pool.summary(), pointer: pool.pointer() });
});

app.post("/api/keys/check", async (req, res) => {
  const supplied = parseKeys(req.body?.keys);
  if (supplied.length) {
    pool.replace(supplied);
  }

  const checked = await pool.checkAll();
  res.json({ keys: checked, pointer: pool.pointer() });
});

app.delete("/api/keys/:id", (req, res) => {
  pool.remove(req.params.id);
  res.json({ keys: pool.summary(), pointer: pool.pointer() });
});

app.post("/api/generate", async (req, res) => {
  try {
    const payload = buildCreatePayload(req.body);
    const result = await pool.withKey(async (credential) => {
      const response = await arkFetch({
        baseUrl: BASE_URL,
        path: "/contents/generations/tasks",
        method: "POST",
        key: credential.key,
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: payload
      });

      return { response, credential };
    });

    const taskId = result.response?.id;
    if (taskId) {
      taskKeyMap.set(taskId, result.credential.id);
    }

    res.json({
      ...result.response,
      key: publicKeyView(result.credential)
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/tasks/:id", async (req, res) => {
  try {
    const preferredKeyId = taskKeyMap.get(req.params.id);
    const result = await pool.withKey(
      async (credential) => {
        const response = await arkFetch({
          baseUrl: BASE_URL,
          path: `/contents/generations/tasks/${encodeURIComponent(req.params.id)}`,
          method: "GET",
          key: credential.key,
          timeoutMs: REQUEST_TIMEOUT_MS
        });

        return { response, credential };
      },
      { preferredKeyId }
    );

    res.json({
      ...result.response,
      key: publicKeyView(result.credential)
    });
  } catch (error) {
    sendError(res, error);
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, "../dist");

if (process.env.NODE_ENV === "production") {
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Seedance API server listening on http://localhost:${PORT}`);
});

function createKeyPool({ baseUrl, timeoutMs, cooldownMs }) {
  let credentials = [];
  let cursor = 0;

  function replace(keys) {
    credentials = [...new Set(keys)]
      .filter(Boolean)
      .map((key) => ({
        id: keyId(key),
        key,
        label: maskKey(key),
        status: "unchecked",
        usable: true,
        uses: 0,
        errors: 0,
        lastCheckAt: null,
        lastUsedAt: null,
        lastError: null,
        cooldownUntil: 0
      }));
    cursor = 0;
  }

  function remove(id) {
    credentials = credentials.filter((credential) => credential.id !== id);
    cursor = Math.min(cursor, Math.max(credentials.length - 1, 0));
  }

  async function checkAll() {
    const results = await Promise.all(
      credentials.map(async (credential) => {
        try {
          await arkFetch({
            baseUrl,
            path: "/contents/generations/tasks?page_num=1&page_size=1",
            method: "GET",
            key: credential.key,
            timeoutMs
          });
          markHealthy(credential);
        } catch (error) {
          markFailure(credential, error, true);
        }

        return publicKeyView(credential);
      })
    );

    return results;
  }

  async function withKey(operation, options = {}) {
    const tried = new Set();
    let lastError = null;
    const maxAttempts = Math.max(credentials.length, 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const credential = pick(options.preferredKeyId, tried);
      if (!credential) break;

      tried.add(credential.id);
      credential.uses += 1;
      credential.lastUsedAt = new Date().toISOString();

      try {
        const result = await operation(credential);
        markHealthy(credential);
        return result;
      } catch (error) {
        lastError = error;
        markFailure(credential, error);

        if (!shouldRetryWithNextKey(error)) {
          break;
        }
      }
    }

    throw lastError || httpError(503, "No usable Ark API keys are configured.");
  }

  function pick(preferredKeyId, tried) {
    const now = Date.now();

    if (preferredKeyId) {
      const preferred = credentials.find((credential) => credential.id === preferredKeyId);
      if (preferred && !tried.has(preferred.id) && isSelectable(preferred, now)) {
        return preferred;
      }
    }

    for (let offset = 0; offset < credentials.length; offset += 1) {
      const index = (cursor + offset) % credentials.length;
      const credential = credentials[index];
      if (tried.has(credential.id) || !isSelectable(credential, now)) continue;

      cursor = (index + 1) % credentials.length;
      return credential;
    }

    return null;
  }

  function isSelectable(credential, now) {
    return credential.usable && credential.cooldownUntil <= now && credential.status !== "invalid";
  }

  function markHealthy(credential) {
    credential.status = "ok";
    credential.usable = true;
    credential.lastError = null;
    credential.cooldownUntil = 0;
    credential.lastCheckAt = new Date().toISOString();
  }

  function markFailure(credential, error, fromCheck = false) {
    credential.errors += 1;
    credential.lastError = error.publicMessage || error.message || "Unknown Ark error";
    credential.lastCheckAt = fromCheck ? new Date().toISOString() : credential.lastCheckAt;

    if (error.status === 401 || error.status === 403) {
      credential.status = "invalid";
      credential.usable = false;
      return;
    }

    if (error.status === 429) {
      credential.status = "rate_limited";
      credential.cooldownUntil = Date.now() + cooldownMs;
      return;
    }

    credential.status = "error";
    credential.cooldownUntil = Date.now() + Math.min(cooldownMs, 15_000);
  }

  return {
    replace,
    remove,
    checkAll,
    withKey,
    summary: () => credentials.map(publicKeyView),
    pointer: () => cursor
  };
}

function buildCreatePayload(input = {}) {
  const prompt = String(input.prompt || "").trim();
  const imageUrl = String(input.imageUrl || "").trim();
  const audioUrl = String(input.audioUrl || "").trim();
  const videoUrl = String(input.videoUrl || "").trim();
  const model = String(input.model || "doubao-seedance-2-0-fast-260128").trim();
  const content = [];

  if (prompt) {
    content.push({ type: "text", text: prompt });
  }

  if (imageUrl) {
    content.push({ type: "image_url", image_url: { url: imageUrl } });
  }

  if (videoUrl) {
    content.push({ type: "video_url", video_url: { url: videoUrl } });
  }

  if (audioUrl) {
    content.push({ type: "audio_url", audio_url: { url: audioUrl } });
  }

  if (!model) {
    throw httpError(400, "Select a Seedance model.");
  }

  if (!content.length) {
    throw httpError(400, "Enter a prompt or at least one reference URL.");
  }

  const resolution = oneOf(input.resolution, ["720p", "1080p"], "720p");
  const duration = parseSeedanceDuration(input.duration);

  if (model.includes("seedance-2-0-fast") && resolution === "1080p") {
    throw httpError(400, "Seedance 2.0 Fast does not support 1080p. Use 720p or switch to Seedance 2.0 Quality.");
  }

  const payload = {
    model,
    content,
    resolution,
    ratio: oneOf(input.ratio, ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "16:9"),
    duration,
    generate_audio: input.generate_audio !== false,
    watermark: Boolean(input.watermark)
  };

  if (input.seed !== "" && input.seed !== null && input.seed !== undefined) {
    payload.seed = clampInt(input.seed, -1, 2_147_483_647, -1);
  }

  if (input.callback_url) {
    payload.callback_url = String(input.callback_url).trim();
  }

  if (input.safety_identifier) {
    payload.safety_identifier = String(input.safety_identifier).trim().slice(0, 64);
  }

  return payload;
}

async function arkFetch({ baseUrl, path: requestPath, method, key, timeoutMs, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const text = await response.text();
    const data = parseJson(text);

    if (!response.ok) {
      throw httpError(response.status, extractArkMessage(data, text, response.status), data);
    }

    return data || {};
  } catch (error) {
    if (error.name === "AbortError") {
      throw httpError(504, "Volcengine Ark request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseKeys(value) {
  if (Array.isArray(value)) {
    return value.flatMap(parseKeys);
  }

  return String(value || "")
    .split(/[\n,;]+/)
    .map((key) => key.trim())
    .filter((key) => key && !key.startsWith("#"));
}

function publicKeyView(credential) {
  return {
    id: credential.id,
    label: credential.label,
    status: credential.status,
    usable: credential.usable && credential.status !== "invalid",
    uses: credential.uses,
    errors: credential.errors,
    lastCheckAt: credential.lastCheckAt,
    lastUsedAt: credential.lastUsedAt,
    lastError: credential.lastError,
    cooldownUntil: credential.cooldownUntil
  };
}

function keyId(key) {
  const tail = key.slice(-8) || randomUUID().slice(0, 8);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return `${tail}-${hash.toString(16)}`;
}

function maskKey(key) {
  if (key.length <= 12) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  return `${key.slice(0, 6)}...${key.slice(-6)}`;
}

function shouldRetryWithNextKey(error) {
  return error.status === 401 || error.status === 403 || error.status === 429;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractArkMessage(data, fallback, status) {
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  if (data?.msg) return data.msg;
  if (data?.error) return typeof data.error === "string" ? data.error : JSON.stringify(data.error);
  if (fallback) return fallback.slice(0, 500);
  return `Volcengine Ark returned HTTP ${status}.`;
}

function httpError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details;
  return error;
}

function sendError(res, error) {
  const status = Number(error.status || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error.publicMessage || error.message || "Unexpected server error.",
    status,
    details: error.details || undefined,
    keys: pool.summary()
  });
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseSeedanceDuration(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return 5;
  if (parsed === -1) return -1;
  if (parsed < 4 || parsed > 15) {
    throw httpError(400, "Seedance 2.0 duration must be -1 or an integer from 4 to 15 seconds.");
  }
  return parsed;
}

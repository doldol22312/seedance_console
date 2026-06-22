import express from "express";
import "dotenv/config";
import fetch, { File, FormData } from "node-fetch";
import { execFile } from "node:child_process";
import { constants as fsConstants, createWriteStream, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SocksProxyAgent } from "socks-proxy-agent";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_PROXY_URL = "";
const DEFAULT_LITTERBOX_UPLOAD_URL = "https://litterbox.catbox.moe/resources/internals/api.php";
const PORT = Number(process.env.PORT || 8787);
const BASE_URL = stripTrailingSlash(process.env.ARK_BASE_URL || DEFAULT_BASE_URL);
const PROXY_URL = normalizeProxyUrl(process.env.ARK_PROXY_URL ?? DEFAULT_PROXY_URL);
const PROXY_AGENT = PROXY_URL ? new SocksProxyAgent(PROXY_URL) : null;
const REQUEST_TIMEOUT_MS = Number(process.env.ARK_TIMEOUT_MS || 120_000);
const MEDIA_PREFLIGHT_TIMEOUT_MS = Number(process.env.MEDIA_PREFLIGHT_TIMEOUT_MS || 20_000);
const MEDIA_PREFLIGHT_BYTES = Number(process.env.MEDIA_PREFLIGHT_BYTES || 2048);
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "64mb";
const KEY_COOLDOWN_MS = Number(process.env.ARK_KEY_COOLDOWN_MS || 60_000);
const MAX_REFERENCE_IMAGES = 9;
const LITTERBOX_UPLOAD_URL = process.env.LITTERBOX_UPLOAD_URL || DEFAULT_LITTERBOX_UPLOAD_URL;
const LITTERBOX_EXPIRY = normalizeLitterboxExpiry(process.env.LITTERBOX_EXPIRY || "12h");
const LITTERBOX_UPLOAD_TIMEOUT_MS = Number(process.env.LITTERBOX_UPLOAD_TIMEOUT_MS || 60_000);
const MAX_LITTERBOX_VIDEO_BYTES = Number(process.env.LITTERBOX_MAX_VIDEO_BYTES || 22 * 1024 * 1024);
const AUTOSAVE_SETTINGS_PATH = path.resolve(process.env.AUTOSAVE_SETTINGS_PATH || ".autosave-settings.json");
const AUTOSAVE_DOWNLOAD_TIMEOUT_MS = Number(process.env.AUTOSAVE_DOWNLOAD_TIMEOUT_MS || 300_000);
const FOLDER_PICKER_TIMEOUT_MS = Number(process.env.FOLDER_PICKER_TIMEOUT_MS || 300_000);
const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

const pool = createKeyPool({
  baseUrl: BASE_URL,
  timeoutMs: REQUEST_TIMEOUT_MS,
  cooldownMs: KEY_COOLDOWN_MS
});
pool.replace(parseKeys(process.env.ARK_API_KEYS || process.env.ARK_API_KEY || ""));

const taskKeyMap = new Map();
const autosaveTaskMap = new Map();
let autosaveSettings = loadAutosaveSettings();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    proxyUrl: publicProxyUrl(PROXY_URL),
    timeoutMs: REQUEST_TIMEOUT_MS,
    mediaPreflightTimeoutMs: MEDIA_PREFLIGHT_TIMEOUT_MS,
    requestBodyLimit: REQUEST_BODY_LIMIT,
    litterboxExpiry: LITTERBOX_EXPIRY,
    autosave: {
      enabled: autosaveSettings.enabled,
      directory: autosaveSettings.directory
    },
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

app.get("/api/autosave", (_req, res) => {
  res.json(publicAutosaveSettings());
});

app.put("/api/autosave", async (req, res) => {
  try {
    const settings = await updateAutosaveSettings(req.body || {});
    res.json(settings);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/autosave/browse-folder", async (req, res) => {
  try {
    const directory = await pickAutosaveDirectory(req.body?.directory || autosaveSettings.directory);
    res.json({ directory });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/uploads/reference-video", async (req, res) => {
  try {
    const upload = await uploadReferenceVideoToLitterbox(req.body || {});
    res.json(upload);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const payload = await buildCreatePayload(req.body);
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
      key: publicKeyView(result.credential),
      autosave: maybeAutosaveTask(taskId, result.response)
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
      key: publicKeyView(result.credential),
      autosave: maybeAutosaveTask(req.params.id, result.response)
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
  console.log(`Ark proxy: ${publicProxyUrl(PROXY_URL) || "direct"}`);
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

async function buildCreatePayload(input = {}) {
  const prompt = String(input.prompt || "").trim();
  const imageUrl = normalizeMediaReference(input.imageUrl);
  const referenceImages = normalizeMediaReferences(input.referenceImages || input.referenceImageUrls || input.referenceImageUrl);
  const audioUrl = normalizeMediaReference(input.audioUrl);
  const videoUrl = normalizeMediaReference(input.videoUrl);
  const model = String(input.model || "doubao-seedance-2-0-fast-260128").trim();
  const content = [];
  const hasReferenceMedia = Boolean(videoUrl || audioUrl);

  if (prompt) {
    content.push({ type: "text", text: prompt });
  }

  if (imageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: imageUrl },
      ...(hasReferenceMedia && !referenceImages.length ? { role: "reference_image" } : {})
    });
  }

  if (referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw httpError(400, `Seedance 2.0 supports up to ${MAX_REFERENCE_IMAGES} reference images.`);
  }

  for (const referenceImageUrl of referenceImages) {
    content.push({
      type: "image_url",
      image_url: { url: referenceImageUrl },
      role: "reference_image"
    });
  }

  if (videoUrl) {
    if (isDataVideoUrl(videoUrl)) {
      throw httpError(400, "Seedance video references must be a public video URL or asset:// ID. Pasted local video files cannot be sent directly.");
    }

    await validateRemoteMediaReference(videoUrl, "video");
    content.push({ type: "video_url", video_url: { url: videoUrl }, role: "reference_video" });
  }

  if (audioUrl) {
    await validateRemoteMediaReference(audioUrl, "audio");
    content.push({ type: "audio_url", audio_url: { url: audioUrl }, role: "reference_audio" });
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
      agent: PROXY_AGENT || undefined,
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

function isDataVideoUrl(value) {
  return String(value || "").trim().toLowerCase().startsWith("data:video/");
}

function isAssetUrl(value) {
  return String(value || "").trim().toLowerCase().startsWith("asset://");
}

function normalizeMediaReference(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:")) return trimmed;

  const match = trimmed.match(/\b(?:https?:\/\/|asset:\/\/)\S+/i);
  const reference = match ? match[0] : trimmed;
  return reference.replace(/[)\].,;'"`]+$/g, "");
}

function normalizeMediaReferences(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/\n+/)
        .map((item) => item.trim());

  return [...new Set(values.map((item) => normalizeMediaReference(item?.url || item)).filter(Boolean))];
}

function loadAutosaveSettings() {
  const defaults = {
    enabled: parseBoolean(process.env.AUTOSAVE_ENABLED, false),
    directory: normalizeDirectoryPath(process.env.AUTOSAVE_DIR || "")
  };

  if (!existsSync(AUTOSAVE_SETTINGS_PATH)) {
    return normalizeAutosaveSettings(defaults);
  }

  try {
    const saved = parseJson(readFileSync(AUTOSAVE_SETTINGS_PATH, "utf8")) || {};
    return normalizeAutosaveSettings({ ...defaults, ...saved });
  } catch {
    return normalizeAutosaveSettings(defaults);
  }
}

function publicAutosaveSettings() {
  return {
    enabled: autosaveSettings.enabled,
    directory: autosaveSettings.directory,
    settingsPath: AUTOSAVE_SETTINGS_PATH
  };
}

async function updateAutosaveSettings(input) {
  const next = normalizeAutosaveSettings(input);

  if (next.enabled && !next.directory) {
    throw httpError(400, "Choose a folder before enabling autosave.");
  }

  if (next.enabled) {
    await ensureWritableDirectory(next.directory);
  }

  autosaveSettings = next;
  await fs.writeFile(AUTOSAVE_SETTINGS_PATH, `${JSON.stringify(autosaveSettings, null, 2)}\n`);
  return publicAutosaveSettings();
}

function normalizeAutosaveSettings(input = {}) {
  return {
    enabled: parseBoolean(input.enabled, false),
    directory: normalizeDirectoryPath(input.directory)
  };
}

function normalizeDirectoryPath(value) {
  const trimmed = String(value || "").trim().replace(/^["']|["']$/g, "");
  return trimmed ? path.resolve(trimmed) : "";
}

async function ensureWritableDirectory(directory) {
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.access(directory, fsConstants.W_OK);
  } catch (error) {
    throw httpError(400, `Autosave folder is not writable: ${error.message}`);
  }
}

async function pickAutosaveDirectory(initialDirectory) {
  if (process.platform !== "win32") {
    throw httpError(501, "The folder picker is only available on Windows in this local app.");
  }

  const encodedInitialDirectory = Buffer.from(normalizeDirectoryPath(initialDirectory), "utf8").toString("base64");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$selected = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedInitialDirectory}"))
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Choose a folder for Seedance autosave"
$dialog.ShowNewFolderButton = $true
if ($selected -and (Test-Path -LiteralPath $selected)) {
  $dialog.SelectedPath = $selected
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript],
      {
        timeout: FOLDER_PICKER_TIMEOUT_MS,
        windowsHide: false
      }
    );
    return normalizeDirectoryPath(stdout);
  } catch (error) {
    if (error.killed || error.signal === "SIGTERM") {
      throw httpError(504, "Folder picker timed out.");
    }
    throw httpError(500, `Could not open folder picker: ${error.message}`);
  }
}

function maybeAutosaveTask(taskId, task) {
  const videoUrl = extractGeneratedVideoUrl(task);
  const existing = autosaveTaskMap.get(taskId);

  if (!autosaveSettings.enabled || !autosaveSettings.directory || !videoUrl) {
    return existing ? publicAutosaveState(existing) : null;
  }

  if (existing?.url === videoUrl && ["saving", "saved"].includes(existing.status)) {
    return publicAutosaveState(existing);
  }

  const filePath = path.join(autosaveSettings.directory, generatedVideoFileName(taskId, videoUrl));
  const state = {
    status: "saving",
    path: filePath,
    url: videoUrl,
    error: null,
    savedAt: null
  };

  autosaveTaskMap.set(taskId, state);
  saveGeneratedVideo(state).catch((error) => {
    state.status = "failed";
    state.error = error.publicMessage || error.message || "Autosave failed.";
  });

  return publicAutosaveState(state);
}

async function saveGeneratedVideo(state) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTOSAVE_DOWNLOAD_TIMEOUT_MS);
  const tempPath = `${state.path}.part`;

  try {
    await fs.mkdir(path.dirname(state.path), { recursive: true });
    const response = await fetch(state.url, {
      headers: {
        Accept: "video/*,*/*;q=0.8"
      },
      agent: PROXY_AGENT || undefined,
      signal: controller.signal
    });

    if (!response.ok) {
      throw httpError(502, `Autosave download returned HTTP ${response.status}.`);
    }

    if (!response.body) {
      throw httpError(502, "Autosave download returned no response body.");
    }

    await pipeline(response.body, createWriteStream(tempPath));
    await fs.rename(tempPath, state.path);
    state.status = "saved";
    state.savedAt = new Date().toISOString();
    state.error = null;
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    if (error.name === "AbortError") {
      throw httpError(504, `Autosave download did not finish within ${Math.round(AUTOSAVE_DOWNLOAD_TIMEOUT_MS / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function publicAutosaveState(state) {
  if (!state) return null;

  return {
    status: state.status,
    path: state.path,
    fileName: state.path ? path.basename(state.path) : "",
    error: state.error,
    savedAt: state.savedAt
  };
}

function extractGeneratedVideoUrl(task) {
  const video = task?.content?.video_url;
  if (typeof video === "string") return video;
  if (video?.url) return String(video.url);
  return "";
}

function generatedVideoFileName(taskId, videoUrl) {
  const safeTaskId = String(taskId || randomUUID())
    .replace(/[^a-z0-9_-]+/gi, "_")
    .slice(0, 96);
  const extension = videoExtensionFromUrl(videoUrl);
  return `seedance-${safeTaskId}${extension}`;
}

function videoExtensionFromUrl(value) {
  try {
    const extension = path.extname(new URL(value).pathname).toLowerCase();
    return isExpectedMediaExtension("video", extension) ? extension : ".mp4";
  } catch {
    return ".mp4";
  }
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function uploadReferenceVideoToLitterbox(input) {
  const { bytes, mimeType } = parseVideoDataUrl(input.dataUrl);

  if (bytes.length > MAX_LITTERBOX_VIDEO_BYTES) {
    throw httpError(400, `Video is larger than ${formatMb(MAX_LITTERBOX_VIDEO_BYTES)} MB.`);
  }

  const fileName = safeUploadFileName(input.name, mimeType);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LITTERBOX_UPLOAD_TIMEOUT_MS);
  const form = new FormData();
  form.set("reqtype", "fileupload");
  form.set("time", LITTERBOX_EXPIRY);
  form.set("fileToUpload", new File([bytes], fileName, { type: mimeType }));

  try {
    const response = await fetch(LITTERBOX_UPLOAD_URL, {
      method: "POST",
      body: form,
      signal: controller.signal
    });
    const text = (await response.text()).trim();

    if (!response.ok) {
      throw httpError(502, `Litterbox upload returned HTTP ${response.status}.`);
    }

    if (!/^https?:\/\/\S+$/i.test(text)) {
      throw httpError(502, `Litterbox upload failed: ${text.slice(0, 240) || "empty response"}`);
    }

    return {
      url: text,
      expires: LITTERBOX_EXPIRY
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw httpError(504, `Litterbox upload did not finish within ${Math.round(LITTERBOX_UPLOAD_TIMEOUT_MS / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseVideoDataUrl(value) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(value || ""));
  if (!match) {
    throw httpError(400, "Reference video upload requires a pasted video data URL.");
  }

  const mimeType = match[1].toLowerCase();
  if (!mimeType.startsWith("video/")) {
    throw httpError(400, "Reference video upload only accepts video files.");
  }

  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) {
    throw httpError(400, "Reference video upload received an empty file.");
  }

  return { bytes, mimeType };
}

function safeUploadFileName(value, mimeType) {
  const extension = extensionForMimeType(mimeType);
  const fallback = `reference-video.${extension}`;
  const baseName = path.basename(String(value || fallback)).replace(/[^a-z0-9._-]+/gi, "_");
  const trimmed = baseName.replace(/^_+|_+$/g, "");
  const fileName = trimmed || fallback;

  return path.extname(fileName) ? fileName : `${fileName}.${extension}`;
}

function extensionForMimeType(mimeType) {
  const subtype = String(mimeType || "").split("/")[1]?.split(";")[0]?.toLowerCase();
  if (subtype === "quicktime") return "mov";
  if (subtype === "x-msvideo") return "avi";
  if (subtype?.includes("mp4")) return "mp4";
  return subtype?.replace(/[^a-z0-9]+/g, "") || "mp4";
}

function normalizeLitterboxExpiry(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const withUnit = /^\d+$/.test(normalized) ? `${normalized}h` : normalized;
  const allowed = new Set(["1h", "12h", "24h", "72h"]);
  return allowed.has(withUnit) ? withUnit : "12h";
}

function formatMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

async function validateRemoteMediaReference(value, kind) {
  if (isAssetUrl(value)) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw httpError(400, `${capitalize(kind)} reference must be a direct http://, https://, or asset:// URL.`);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw httpError(400, `${capitalize(kind)} reference must be a direct http://, https://, or asset:// URL.`);
  }

  const result = await preflightMediaUrl(parsedUrl.toString(), kind);
  if (!isExpectedMediaType(kind, result.contentType, parsedUrl.pathname)) {
    const actualType = result.contentType || "unknown content type";
    throw httpError(
      400,
      `${capitalize(kind)} URL responded as ${actualType}. Use a direct ${kind} file URL, not a preview page.`
    );
  }
}

async function preflightMediaUrl(url, kind) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_PREFLIGHT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: kind === "video" ? "video/*,*/*;q=0.8" : "audio/*,*/*;q=0.8",
        Range: `bytes=0-${Math.max(MEDIA_PREFLIGHT_BYTES - 1, 0)}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw httpError(
        400,
        `${capitalize(kind)} URL returned HTTP ${response.status}. Make sure it is public and directly downloadable.`
      );
    }

    const bytesRead = await readFirstResponseBytes(response, MEDIA_PREFLIGHT_BYTES);
    const totalLength = parseContentRangeTotal(response.headers.get("content-range"));
    const contentLength = parseContentLength(response.headers.get("content-length"));

    if (bytesRead <= 0 || totalLength === 0 || contentLength === 0) {
      throw httpError(400, `${capitalize(kind)} URL returned no media bytes. Use a direct public file URL.`);
    }

    return {
      contentType: response.headers.get("content-type") || "",
      bytesRead
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw httpError(
        400,
        `${capitalize(kind)} URL could not be fetched within ${Math.round(MEDIA_PREFLIGHT_TIMEOUT_MS / 1000)}s. Ark is likely to return "timeout while fetching resource"; rehost it on a faster public URL or use an asset:// ID.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readFirstResponseBytes(response, byteLimit) {
  if (!response.body) return 0;

  let bytesRead = 0;
  try {
    for await (const chunk of response.body) {
      bytesRead += chunk.length || Buffer.byteLength(chunk);
      if (bytesRead >= byteLimit) break;
    }
  } finally {
    response.body.destroy?.();
  }

  return bytesRead;
}

function parseContentLength(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseContentRangeTotal(value) {
  const match = String(value || "").match(/\/(\d+|\*)$/);
  if (!match || match[1] === "*") return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExpectedMediaType(kind, contentType, pathname) {
  const normalized = String(contentType || "").toLowerCase().split(";")[0].trim();
  const extension = path.extname(pathname || "").toLowerCase();

  if (!normalized) return isExpectedMediaExtension(kind, extension);
  if (normalized.startsWith(`${kind}/`)) return true;

  const genericBinary = ["application/octet-stream", "binary/octet-stream"].includes(normalized);
  return genericBinary && isExpectedMediaExtension(kind, extension);
}

function isExpectedMediaExtension(kind, extension) {
  const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"]);
  const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
  return kind === "video" ? videoExtensions.has(extension) : audioExtensions.has(extension);
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function normalizeProxyUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || ["0", "false", "no", "none", "off"].includes(trimmed.toLowerCase())) {
    return null;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `socks5://${trimmed}`;
}

function publicProxyUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.username) url.username = "****";
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return String(value).replace(/\/\/[^/@]+@/, "//****@");
  }
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
  if (data?.error?.message) return decorateArkMessage(data.error.message);
  if (data?.message) return decorateArkMessage(data.message);
  if (data?.msg) return decorateArkMessage(data.msg);
  if (data?.error) return decorateArkMessage(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  if (fallback) return decorateArkMessage(fallback.slice(0, 500));
  return `Volcengine Ark returned HTTP ${status}.`;
}

function decorateArkMessage(message) {
  const text = String(message || "");
  if (/content\[\d+\]\.video_url/i.test(text) && /timeout while fetching resource/i.test(text)) {
    return `${text} The video host is not reachable fast enough from Volcengine Ark. Rehost the MP4 on a stable public bucket or CDN that Ark can fetch, or upload it to Ark and use an asset:// ID.`;
  }

  return text;
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

import "dotenv/config";
import fetch from "node-fetch";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { SocksProxyAgent } from "socks-proxy-agent";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_STATE_FILE = ".watchtower/ark-seed-models.json";
const DEFAULT_ALL_KEYS_STATE_FILE = ".watchtower/ark-seed-models-all-keys.json";

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");
const notifyInitial = args.has("--notify-initial") || isTruthy(process.env.WATCHTOWER_NOTIFY_INITIAL);

const baseUrl = stripTrailingSlash(process.env.ARK_BASE_URL || DEFAULT_BASE_URL);
const endpointUrls = parseEndpoints(
  process.env.WATCHTOWER_ENDPOINTS ||
    `${baseUrl}/models,${DEFAULT_CODING_BASE_URL}/models`
);
const modelFilter = compileFilter(process.env.WATCHTOWER_MODEL_FILTER || "seed");
const intervalMs = Number(process.env.WATCHTOWER_INTERVAL_MS || DEFAULT_INTERVAL_MS);
const timeoutMs = Number(process.env.WATCHTOWER_TIMEOUT_MS || 30_000);
const keysFile = process.env.WATCHTOWER_ARK_KEYS_FILE || "";
const ignoreEnvKeys = isTruthy(process.env.WATCHTOWER_IGNORE_ENV_KEYS);
const apiKeys = await loadApiKeys();
const checkAllKeys = isTruthy(process.env.WATCHTOWER_CHECK_ALL_KEYS) || Boolean(keysFile);
const aggregateChanges = process.env.WATCHTOWER_AGGREGATE_CHANGES !== "false";
const maxChangeLines = Number(process.env.WATCHTOWER_MAX_CHANGE_LINES || 120);
const stateFile = path.resolve(
  process.cwd(),
  process.env.WATCHTOWER_STATE_FILE || (checkAllKeys ? DEFAULT_ALL_KEYS_STATE_FILE : DEFAULT_STATE_FILE)
);
const concurrency = Number(process.env.WATCHTOWER_CONCURRENCY || 64);
const keyViews = apiKeys.map((key) => ({ key, label: keyLabel(key) }));
const proxyAgent = createProxyAgent(process.env.ARK_PROXY_URL);
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
const telegramCommandsEnabled = Boolean(telegramToken && telegramChatId && process.env.TELEGRAM_COMMANDS !== "false");
const telegramPollSeconds = Number(process.env.TELEGRAM_POLL_SECONDS || 20);
const telegramOffsetFile = path.resolve(process.cwd(), process.env.TELEGRAM_OFFSET_FILE || ".watchtower/telegram-offset.json");

let lastErrorAlert = "";
let lastRun = null;
let runInProgress = null;
let telegramOffset = null;

if (!apiKeys.length) {
  throw new Error("Set ARK_API_KEYS, ARK_API_KEY, or WATCHTOWER_ARK_API_KEYS before running watchtower.");
}

if (!Number.isFinite(intervalMs) || intervalMs < 10_000) {
  throw new Error("WATCHTOWER_INTERVAL_MS must be at least 10000.");
}

if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  throw new Error("WATCHTOWER_TIMEOUT_MS must be at least 1000.");
}

if (!Number.isFinite(concurrency) || concurrency < 1) {
  throw new Error("WATCHTOWER_CONCURRENCY must be at least 1.");
}

if (!Number.isFinite(maxChangeLines) || maxChangeLines < 10) {
  throw new Error("WATCHTOWER_MAX_CHANGE_LINES must be at least 10.");
}

if (!Number.isFinite(telegramPollSeconds) || telegramPollSeconds < 1) {
  throw new Error("TELEGRAM_POLL_SECONDS must be at least 1.");
}

if (once) {
  await runCheck("manual");
} else {
  await runForever();
}

async function runForever() {
  console.log(`Ark Seed /models watchtower running every ${Math.round(intervalMs / 1000)}s with ${apiKeys.length} key(s).`);
  if (telegramCommandsEnabled) {
    await registerTelegramCommands().catch((error) => {
      console.error(`Telegram command registration failed: ${error.message}`);
    });
    startTelegramCommandLoop();
  }

  while (true) {
    try {
      await runCheck("scheduled");
      lastErrorAlert = "";
    } catch (error) {
      await handleRunError(error);
    }
    await sleep(intervalMs);
  }
}

async function runCheck(reason) {
  if (runInProgress) {
    return runInProgress;
  }

  runInProgress = (async () => {
    const startedAt = Date.now();
    try {
      const result = await runOnce(reason);
      result.durationMs = Date.now() - startedAt;
      lastRun = {
        ok: true,
        reason,
        ranAt: new Date().toISOString(),
        durationMs: result.durationMs,
        kind: result.kind,
        tracked: result.snapshot?.models?.length || 0,
        keyErrors: result.snapshot?.keyErrors?.length || 0,
        changes: result.changes
          ? {
              added: result.changes.added.length,
              removed: result.changes.removed.length,
              changed: result.changes.changed.length,
              keyErrorsChanged: result.changes.keyErrorsChanged
            }
          : null
      };
      return result;
    } catch (error) {
      lastRun = {
        ok: false,
        reason,
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: sanitizeError(error.message)
      };
      throw error;
    } finally {
      runInProgress = null;
    }
  })();

  return runInProgress;
}

async function runOnce() {
  const previous = await readSnapshot(stateFile);
  const current = await collectSnapshot();

  if (!previous) {
    if (!dryRun) {
      await writeSnapshot(stateFile, current);
    }

    const message = formatInitialMessage(current);
    if (notifyInitial) {
      await notify(message);
    } else {
      console.log(`${message}\nBaseline only. No Telegram alert sent.`);
    }
    return { kind: "baseline", snapshot: current };
  }

  const changes = diffSnapshots(previous, current);
  if (!changes.total) {
    if (!dryRun) {
      await writeSnapshot(stateFile, current);
    }
    console.log(`No Seed model changes. Tracking ${current.models.length} matching models.`);
    return { kind: "no_change", snapshot: current };
  }

  const message = formatChangeMessage(changes, current);
  await notify(message);

  if (!dryRun) {
    await writeSnapshot(stateFile, current);
  }

  return { kind: "changed", snapshot: current, changes };
}

async function collectSnapshot() {
  const { endpointResults, keyErrors } = checkAllKeys
    ? await collectAllKeyEndpointResults()
    : await collectFirstValidKeyEndpointResults();

  const models = endpointResults
    .flatMap(({ endpointUrl, keyRef, models }) =>
      models
        .filter((model) => matchesFilter(model, modelFilter))
        .map((model) => normalizeModel(endpointUrl, model, keyRef))
    )
    .sort((left, right) => left.key.localeCompare(right.key));

  return {
    checkedAt: new Date().toISOString(),
    endpoints: endpointUrls,
    filter: modelFilter.source,
    mode: checkAllKeys ? "all_keys" : "first_valid_key",
    keyCount: apiKeys.length,
    keyErrors,
    models
  };
}

async function collectFirstValidKeyEndpointResults() {
  const endpointResults = [];
  for (const endpointUrl of endpointUrls) {
    endpointResults.push(await fetchEndpointModels(endpointUrl));
  }
  return { endpointResults, keyErrors: [] };
}

async function collectAllKeyEndpointResults() {
  const jobs = keyViews.flatMap((keyView) =>
    endpointUrls.map((endpointUrl) => ({ endpointUrl, keyView }))
  );
  const results = await mapLimited(jobs, concurrency, async ({ endpointUrl, keyView }) => {
    try {
      const result = await fetchEndpointModelsWithKey(endpointUrl, keyView.key, keyView.label);
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: {
          keyRef: keyView.label,
          endpoint: endpointLabel(endpointUrl),
          message: sanitizeError(error.message)
        }
      };
    }
  });

  const endpointResults = results.filter((item) => item.ok).map((item) => item.result);
  const keyErrors = results
    .filter((item) => !item.ok)
    .map((item) => item.error)
    .sort((left, right) => `${left.keyRef}:${left.endpoint}`.localeCompare(`${right.keyRef}:${right.endpoint}`));

  if (!endpointResults.length) {
    throw new Error("No /models calls succeeded for any configured key.");
  }

  return { endpointResults, keyErrors };
}

async function fetchEndpointModels(endpointUrl) {
  let lastAuthError = null;

  for (const keyView of keyViews) {
    try {
      return await fetchEndpointModelsWithKey(endpointUrl, keyView.key);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        lastAuthError = error;
        continue;
      }

      throw error;
    }
  }

  throw lastAuthError || new Error(`${endpointLabel(endpointUrl)} /models could not be fetched with any configured key.`);
}

async function fetchEndpointModelsWithKey(endpointUrl, key, keyRef = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpointUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      agent: proxyAgent || undefined,
      signal: controller.signal
    });

    const text = await response.text();
    const data = parseJson(text);

    if (!response.ok) {
      const error = new Error(`${endpointLabel(endpointUrl)} /models returned HTTP ${response.status}: ${extractErrorMessage(data, text)}`);
      error.status = response.status;
      throw error;
    }

    if (!Array.isArray(data?.data)) {
      throw new Error(`${endpointLabel(endpointUrl)} /models did not return a data array.`);
    }

    return { endpointUrl, keyRef, models: data.data };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${endpointLabel(endpointUrl)} /models timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModel(endpointUrl, model, keyRef = "") {
  const id = String(model.id || "");
  const endpoint = endpointLabel(endpointUrl);
  const tokenLimits = model.token_limits || {};
  const modalities = model.modalities || {};

  return {
    key: keyRef ? `${keyRef}::${endpoint}::${id}` : `${endpoint}::${id}`,
    keyRef,
    endpoint,
    id,
    name: String(model.name || ""),
    status: model.status ? String(model.status) : "Available",
    domain: String(model.domain || ""),
    version: String(model.version || ""),
    taskTypes: toStringArray(model.task_type),
    inputModalities: toStringArray(modalities.input_modalities),
    outputModalities: toStringArray(modalities.output_modalities),
    tokenLimits: {
      contextWindow: numericOrNull(tokenLimits.context_window),
      maxInput: numericOrNull(tokenLimits.max_input_token_length),
      maxOutput: numericOrNull(tokenLimits.max_output_token_length),
      maxReasoning: numericOrNull(tokenLimits.max_reasoning_token_length)
    }
  };
}

function diffSnapshots(previous, current) {
  const previousByKey = new Map(previous.models.map((model) => [model.key, model]));
  const currentByKey = new Map(current.models.map((model) => [model.key, model]));
  const added = [];
  const removed = [];
  const changed = [];
  const previousErrors = previous.keyErrors || [];
  const currentErrors = current.keyErrors || [];
  const keyErrorsChanged = stableJson(previousErrors) !== stableJson(currentErrors);

  for (const model of current.models) {
    const before = previousByKey.get(model.key);
    if (!before) {
      added.push(model);
      continue;
    }

    const fields = changedFields(before, model);
    if (fields.length) {
      changed.push({ before, after: model, fields });
    }
  }

  for (const model of previous.models) {
    if (!currentByKey.has(model.key)) {
      removed.push(model);
    }
  }

  return {
    added,
    removed,
    changed,
    keyErrorsChanged,
    previousErrors,
    currentErrors,
    total: added.length + removed.length + changed.length + (keyErrorsChanged ? 1 : 0)
  };
}

function changedFields(before, after) {
  const checks = [
    ["name", before.name, after.name],
    ["status", before.status, after.status],
    ["domain", before.domain, after.domain],
    ["version", before.version, after.version],
    ["taskTypes", before.taskTypes, after.taskTypes],
    ["inputModalities", before.inputModalities, after.inputModalities],
    ["outputModalities", before.outputModalities, after.outputModalities],
    ["tokenLimits", before.tokenLimits, after.tokenLimits]
  ];

  return checks
    .filter(([, left, right]) => stableJson(left) !== stableJson(right))
    .map(([field, left, right]) => `${field}: ${formatValue(left)} -> ${formatValue(right)}`);
}

function formatInitialMessage(snapshot) {
  return [
    "Ark Seed /models watchtower initialized",
    `Checked: ${snapshot.checkedAt}`,
    `Endpoints: ${snapshot.endpoints.map(endpointLabel).join(", ")}`,
    `Mode: ${snapshot.mode}`,
    `Keys: ${snapshot.keyCount}`,
    `Filter: /${snapshot.filter}/i`,
    `Tracking: ${snapshot.models.length} models`,
    `Key errors: ${snapshot.keyErrors?.length || 0}`
  ].join("\n");
}

function formatChangeMessage(changes, snapshot) {
  const lines = [
    "Ark Seed /models changed",
    `Checked: ${snapshot.checkedAt}`,
    `Mode: ${snapshot.mode}`,
    `Keys: ${snapshot.keyCount}`,
    `Tracking: ${snapshot.models.length} models`,
    `Changes: +${changes.added.length} -${changes.removed.length} ~${changes.changed.length}`,
    `Key errors: ${changes.previousErrors.length} -> ${changes.currentErrors.length}`,
    ""
  ];

  if (snapshot.mode === "all_keys" && aggregateChanges) {
    appendGroupedChanges(lines, changes);
    appendKeyErrors(lines, changes);
    return lines.join("\n");
  }

  for (const model of changes.added) {
    lines.push(`+ ${formatModel(model)}`);
  }

  for (const model of changes.removed) {
    lines.push(`- ${formatModel(model)}`);
  }

  for (const change of changes.changed) {
    lines.push(`~ ${formatModel(change.after)}`);
    for (const field of change.fields.slice(0, 8)) {
      lines.push(`  ${field}`);
    }
  }

  appendKeyErrors(lines, changes);

  return lines.join("\n");
}

function appendGroupedChanges(lines, changes) {
  let emitted = 0;
  let suppressed = 0;

  for (const group of groupModelsByShape(changes.added)) {
    if (emitted >= maxChangeLines) {
      suppressed += group.count;
      continue;
    }
    lines.push(`+ ${formatGroupedModel(group)}`);
    emitted += 1;
  }

  for (const group of groupModelsByShape(changes.removed)) {
    if (emitted >= maxChangeLines) {
      suppressed += group.count;
      continue;
    }
    lines.push(`- ${formatGroupedModel(group)}`);
    emitted += 1;
  }

  for (const group of groupChangedByShape(changes.changed)) {
    if (emitted >= maxChangeLines) {
      suppressed += group.count;
      continue;
    }
    lines.push(`~ ${formatGroupedModel(group)} fields=${group.fields.slice(0, 4).join("; ")}`);
    emitted += 1;
  }

  if (suppressed) {
    lines.push(`...suppressed ${suppressed} per-key duplicate change entries`);
  }
}

function appendKeyErrors(lines, changes) {
  if (!changes.keyErrorsChanged || !changes.currentErrors.length) return;

  lines.push("");
  lines.push("Current key errors:");
  for (const group of groupKeyErrors(changes.currentErrors).slice(0, 20)) {
    lines.push(`! [${group.endpoint}] ${group.count} key(s), sample=${group.sampleKeys.join(",")} ${group.message}`);
  }
  const groupedCount = groupKeyErrors(changes.currentErrors).length;
  if (groupedCount > 20) {
    lines.push(`! ...${groupedCount - 20} more error groups`);
  }
}

function formatModel(model) {
  const taskTypes = model.taskTypes.length ? model.taskTypes.join(",") : "-";
  const domain = model.domain || "-";
  const prefix = model.keyRef ? `${model.keyRef} ${model.endpoint}` : model.endpoint;
  return `[${prefix}] ${model.id} (${model.status}, ${domain}, ${taskTypes})`;
}

function formatGroupedModel(group) {
  const model = group.model;
  const taskTypes = model.taskTypes.length ? model.taskTypes.join(",") : "-";
  const domain = model.domain || "-";
  return `[${model.endpoint}] ${model.id} (${model.status}, ${domain}, ${taskTypes}) keys=${group.count} sample=${group.sampleKeys.join(",")}`;
}

function groupModelsByShape(models) {
  const groups = new Map();
  for (const model of models) {
    const groupKey = stableJson({
      endpoint: model.endpoint,
      id: model.id,
      name: model.name,
      status: model.status,
      domain: model.domain,
      version: model.version,
      taskTypes: model.taskTypes,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      tokenLimits: model.tokenLimits
    });
    const group = groups.get(groupKey) || { model, keyRefs: [] };
    if (model.keyRef) group.keyRefs.push(model.keyRef);
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      count: group.keyRefs.length || 1,
      sampleKeys: sampleValues(group.keyRefs)
    }))
    .sort((left, right) => right.count - left.count || left.model.id.localeCompare(right.model.id));
}

function groupChangedByShape(changes) {
  const groups = new Map();
  for (const change of changes) {
    const groupKey = stableJson({
      endpoint: change.after.endpoint,
      id: change.after.id,
      fields: change.fields
    });
    const group = groups.get(groupKey) || { model: change.after, fields: change.fields, keyRefs: [] };
    if (change.after.keyRef) group.keyRefs.push(change.after.keyRef);
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      count: group.keyRefs.length || 1,
      sampleKeys: sampleValues(group.keyRefs)
    }))
    .sort((left, right) => right.count - left.count || left.model.id.localeCompare(right.model.id));
}

function groupKeyErrors(errors) {
  const groups = new Map();
  for (const error of errors) {
    const groupKey = stableJson({
      endpoint: error.endpoint,
      message: error.message
    });
    const group = groups.get(groupKey) || { endpoint: error.endpoint, message: error.message, keyRefs: [] };
    group.keyRefs.push(error.keyRef);
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      count: group.keyRefs.length,
      sampleKeys: sampleValues(group.keyRefs)
    }))
    .sort((left, right) => right.count - left.count || left.endpoint.localeCompare(right.endpoint));
}

function sampleValues(values, count = 3) {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length <= count) return unique;
  return [...unique.slice(0, count), `+${unique.length - count} more`];
}

async function notify(message) {
  if (dryRun || !telegramToken || !telegramChatId) {
    console.log(dryRun ? "Dry run. Telegram message:" : "Telegram env missing. Message:");
    console.log(message);
    return;
  }

  await sendTelegramMessage(telegramChatId, message);
}

async function sendTelegramMessage(chatId, message) {
  for (const chunk of splitMessage(message, 3900)) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true
    });
  }
}

async function telegramApi(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    agent: proxyAgent || undefined,
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok || data?.ok === false) {
    const message = data?.description || text.slice(0, 500) || "No response body.";
    throw new Error(`Telegram ${method} returned HTTP ${response.status}: ${message}`);
  }

  return data?.result;
}

async function registerTelegramCommands() {
  await telegramApi("setMyCommands", {
    commands: [
      { command: "status", description: "Show watcher status" },
      { command: "check", description: "Run a model check now" },
      { command: "models", description: "List tracked Seed model groups" },
      { command: "errors", description: "Show current key/API errors" },
      { command: "reset", description: "Reset baseline with /reset confirm" },
      { command: "ping", description: "Check bot responsiveness" },
      { command: "help", description: "Show commands" }
    ]
  });
}

function startTelegramCommandLoop() {
  void (async () => {
    try {
      telegramOffset = await initializeTelegramOffset();
      console.log(`Telegram commands enabled for chat ${telegramChatId}.`);

      while (true) {
        try {
          const updates = await telegramApi("getUpdates", {
            offset: telegramOffset,
            timeout: telegramPollSeconds,
            allowed_updates: ["message"]
          });

          for (const update of updates || []) {
            telegramOffset = Number(update.update_id) + 1;
            await writeTelegramOffset(telegramOffset);
            await handleTelegramUpdate(update);
          }
        } catch (error) {
          console.error(`Telegram command polling failed: ${sanitizeError(error.message)}`);
          await sleep(5000);
        }
      }
    } catch (error) {
      console.error(`Telegram command loop failed: ${sanitizeError(error.message)}`);
    }
  })();
}

async function initializeTelegramOffset() {
  const saved = await readTelegramOffset();
  if (saved !== null) return saved;

  const updates = await telegramApi("getUpdates", {
    timeout: 0,
    limit: 100,
    allowed_updates: ["message"]
  });
  const latest = Math.max(-1, ...(updates || []).map((update) => Number(update.update_id)).filter(Number.isFinite));
  const offset = latest + 1;
  await writeTelegramOffset(offset);
  return offset;
}

async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message?.chat || !message.text) return;

  const chatId = String(message.chat.id);
  if (chatId !== String(telegramChatId)) return;

  const text = String(message.text || "").trim();
  if (!text.startsWith("/")) return;

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  try {
    if (command === "/start" || command === "/help") {
      await sendTelegramMessage(chatId, formatTelegramHelp());
      return;
    }

    if (command === "/ping") {
      await sendTelegramMessage(chatId, "pong");
      return;
    }

    if (command === "/status") {
      await sendTelegramMessage(chatId, await formatTelegramStatus());
      return;
    }

    if (command === "/check") {
      await sendTelegramMessage(chatId, "Running Ark /models check now.");
      const result = await runCheck("telegram");
      await sendTelegramMessage(chatId, formatTelegramCheckResult(result));
      return;
    }

    if (command === "/models") {
      await sendTelegramMessage(chatId, await formatTelegramModels());
      return;
    }

    if (command === "/errors") {
      await sendTelegramMessage(chatId, await formatTelegramErrors());
      return;
    }

    if (command === "/reset") {
      if (args[0]?.toLowerCase() !== "confirm") {
        await sendTelegramMessage(chatId, "Use /reset confirm to remove the current watchtower baseline.");
        return;
      }
      if (runInProgress) {
        await sendTelegramMessage(chatId, "A check is running. Waiting for it to finish before reset.");
        await runInProgress;
      }
      await fs.rm(stateFile, { force: true });
      await sendTelegramMessage(chatId, `Baseline reset: ${path.relative(process.cwd(), stateFile)}. Next check creates a fresh baseline without alerting.`);
      return;
    }

    await sendTelegramMessage(chatId, `Unknown command: ${command}\n\n${formatTelegramHelp()}`);
  } catch (error) {
    await sendTelegramMessage(chatId, `Command failed: ${sanitizeError(error.message)}`);
  }
}

function formatTelegramHelp() {
  return [
    "Ark Seed watchtower commands",
    "/status - show watcher status",
    "/check - run a model check now",
    "/models - list tracked Seed model groups",
    "/errors - show current key/API errors",
    "/reset confirm - delete the current baseline",
    "/ping - check bot responsiveness",
    "/help - show this message"
  ].join("\n");
}

async function formatTelegramStatus() {
  const snapshot = await readSnapshot(stateFile);
  const lines = [
    "Ark Seed watchtower status",
    `Mode: ${checkAllKeys ? "all_keys" : "first_valid_key"}`,
    `Interval: ${Math.round(intervalMs / 1000)}s`,
    `Keys: ${apiKeys.length}`,
    `Concurrency: ${concurrency}`,
    `Endpoints: ${endpointUrls.map(endpointLabel).join(", ")}`,
    `Filter: /${modelFilter.source}/i`,
    `Proxy: ${proxyAgent ? "enabled" : "direct"}`,
    `State: ${path.relative(process.cwd(), stateFile)}`
  ];

  if (snapshot) {
    lines.push(`Last snapshot: ${snapshot.checkedAt}`);
    lines.push(`Tracked entries: ${snapshot.models?.length || 0}`);
    lines.push(`Key errors: ${snapshot.keyErrors?.length || 0}`);
  } else {
    lines.push("Last snapshot: none");
  }

  if (lastRun) {
    lines.push(`Last run: ${lastRun.ok ? lastRun.kind : "error"} at ${lastRun.ranAt} (${formatDuration(lastRun.durationMs)})`);
    if (!lastRun.ok) lines.push(`Last error: ${lastRun.error}`);
  }

  if (runInProgress) {
    lines.push("Current check: running");
  }

  return lines.join("\n");
}

function formatTelegramCheckResult(result) {
  const lines = [
    "Ark /models check complete",
    `Result: ${result.kind}`,
    `Checked: ${result.snapshot.checkedAt}`,
    `Duration: ${formatDuration(result.durationMs)}`,
    `Tracked entries: ${result.snapshot.models.length}`,
    `Key errors: ${result.snapshot.keyErrors?.length || 0}`
  ];

  if (result.changes) {
    lines.push(`Changes: +${result.changes.added.length} -${result.changes.removed.length} ~${result.changes.changed.length}`);
    lines.push("Full change alert was sent separately.");
  }

  return lines.join("\n");
}

async function formatTelegramModels() {
  const snapshot = await requireSnapshot();
  const groups = groupModelsByShape(snapshot.models);
  const lines = [
    `Tracked Seed model groups: ${groups.length}`,
    `Raw entries: ${snapshot.models.length}`,
    `Checked: ${snapshot.checkedAt}`,
    ""
  ];

  for (const group of groups.slice(0, 80)) {
    lines.push(`${group.model.id} [${group.model.endpoint}] ${group.model.status} keys=${group.count}`);
  }

  if (groups.length > 80) {
    lines.push(`...${groups.length - 80} more groups`);
  }

  return lines.join("\n");
}

async function formatTelegramErrors() {
  const snapshot = await requireSnapshot();
  const errors = snapshot.keyErrors || [];
  if (!errors.length) {
    return `No key/API errors in current snapshot.\nChecked: ${snapshot.checkedAt}`;
  }

  const lines = [
    `Current key/API error groups: ${groupKeyErrors(errors).length}`,
    `Raw errors: ${errors.length}`,
    `Checked: ${snapshot.checkedAt}`,
    ""
  ];

  for (const group of groupKeyErrors(errors).slice(0, 30)) {
    lines.push(`[${group.endpoint}] ${group.count} key(s), sample=${group.sampleKeys.join(",")} ${group.message}`);
  }

  return lines.join("\n");
}

async function requireSnapshot() {
  const snapshot = await readSnapshot(stateFile);
  if (!snapshot) {
    throw new Error("No baseline snapshot exists yet. Run /check first.");
  }
  return snapshot;
}

async function handleRunError(error) {
  const message = `Ark Seed /models watchtower error\n${new Date().toISOString()}\n${error.message}`;
  console.error(message);

  if (message !== lastErrorAlert) {
    lastErrorAlert = message;
    try {
      await notify(message);
    } catch (notifyError) {
      console.error(`Telegram error alert failed: ${notifyError.message}`);
    }
  }
}

async function readSnapshot(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeSnapshot(filePath, snapshot) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function readTelegramOffset() {
  try {
    const text = await fs.readFile(telegramOffsetFile, "utf8");
    const data = JSON.parse(text);
    const offset = Number(data.offset);
    return Number.isFinite(offset) ? offset : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeTelegramOffset(offset) {
  await fs.mkdir(path.dirname(telegramOffsetFile), { recursive: true });
  await fs.writeFile(telegramOffsetFile, `${JSON.stringify({ offset }, null, 2)}\n`, "utf8");
}

async function loadApiKeys() {
  const keys = ignoreEnvKeys
    ? []
    : parseKeys(process.env.WATCHTOWER_ARK_API_KEYS || process.env.ARK_API_KEYS || process.env.ARK_API_KEY || "");

  if (keysFile) {
    const filePath = path.resolve(process.cwd(), keysFile);
    const text = await fs.readFile(filePath, "utf8");
    keys.push(...parseKeys(text));
  }

  return [...new Set(keys)];
}

function keyLabel(key) {
  return `key:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

function sanitizeError(message) {
  return String(message || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .slice(0, 500);
}

async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(Math.floor(limit), 1), items.length);

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function parseEndpoints(value) {
  return parseList(value).map((endpoint) => {
    const stripped = stripTrailingSlash(endpoint);
    return stripped.endsWith("/models") ? stripped : `${stripped}/models`;
  });
}

function parseKeys(value) {
  return parseList(value).filter((key) => key && !key.startsWith("#"));
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compileFilter(value) {
  try {
    return new RegExp(value, "i");
  } catch (error) {
    throw new Error(`WATCHTOWER_MODEL_FILTER is not a valid regex: ${error.message}`);
  }
}

function matchesFilter(model, filter) {
  const haystack = [
    model.id,
    model.name,
    model.domain,
    ...(Array.isArray(model.task_type) ? model.task_type : [])
  ].join(" ");
  return filter.test(haystack);
}

function endpointLabel(endpointUrl) {
  if (endpointUrl.includes("/api/coding/")) return "coding";
  if (endpointUrl.includes("/api/v3/")) return "ark";

  try {
    return new URL(endpointUrl).pathname.replace(/^\/+|\/+$/g, "") || endpointUrl;
  } catch {
    return endpointUrl;
  }
}

function createProxyAgent(value) {
  const proxyUrl = normalizeProxyUrl(value);
  return proxyUrl ? new SocksProxyAgent(proxyUrl) : null;
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

function extractErrorMessage(data, fallback) {
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  if (data?.msg) return data.msg;
  if (data?.error) return typeof data.error === "string" ? data.error : JSON.stringify(data.error);
  return String(fallback || "").slice(0, 500) || "No response body.";
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stableJson(value) {
  return JSON.stringify(value);
}

function formatValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(",") : "-";
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([key, item]) => `${key}=${item}`)
      .join(",") || "-";
  }
  return value === "" || value === null || value === undefined ? "-" : String(value);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function toStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).sort() : [];
}

function numericOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function splitMessage(message, limit) {
  const chunks = [];
  let remaining = message;

  while (remaining.length > limit) {
    const cut = remaining.lastIndexOf("\n", limit);
    const end = cut > 0 ? cut : limit;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import React from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Clapperboard,
  Clipboard,
  Copy,
  Film,
  Gauge,
  ImagePlus,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
  Video
} from "lucide-react";
import "./styles.css";

const MODELS = [
  { id: "doubao-seedance-2-0-fast-260128", label: "2.0 Fast" },
  { id: "doubao-seedance-2-0-260128", label: "2.0 Quality" }
];

const STATUS_CLASS = {
  ok: "good",
  unchecked: "idle",
  rate_limited: "warn",
  invalid: "bad",
  error: "bad",
  queued: "idle",
  running: "warn",
  succeeded: "good",
  failed: "bad",
  expired: "bad",
  cancelled: "bad"
};

const MAX_PASTED_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_PASTED_VIDEO_BYTES = 22 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 9;

function App() {
  const [config, setConfig] = React.useState(null);
  const [keysInput, setKeysInput] = React.useState("");
  const [keys, setKeys] = React.useState([]);
  const [keysBusy, setKeysBusy] = React.useState(false);
  const [generateBusy, setGenerateBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [tasks, setTasks] = React.useState([]);
  const [lookupId, setLookupId] = React.useState("");
  const [imageAsset, setImageAsset] = React.useState(null);
  const [videoAsset, setVideoAsset] = React.useState(null);
  const [referenceImageInput, setReferenceImageInput] = React.useState("");
  const [form, setForm] = React.useState({
    model: MODELS[0].id,
    prompt:
      "A silver train crosses a flooded salt flat at dusk, reflections ripple under the wheels, controlled cinematic camera movement",
    imageUrl: "",
    referenceImages: [],
    videoUrl: "",
    audioUrl: "",
    resolution: "720p",
    ratio: "16:9",
    duration: 5,
    seed: -1,
    generate_audio: true,
    watermark: false
  });

  React.useEffect(() => {
    refreshKeys();
    api("/api/config")
      .then(setConfig)
      .catch((error) => setNotice({ type: "bad", text: error.message }));
  }, []);

  React.useEffect(() => {
    if (form.model.includes("seedance-2-0-fast") && form.resolution === "1080p") {
      updateForm("resolution", "720p");
    }
  }, [form.model, form.resolution]);

  React.useEffect(() => {
    const active = tasks.filter((task) => ["queued", "running", "submitted"].includes(task.status));
    if (!active.length) return undefined;

    const timer = window.setInterval(() => {
      active.forEach((task) => pollTask(task.id, { quiet: true }));
    }, 5000);

    return () => window.clearInterval(timer);
  }, [tasks]);

  const stats = React.useMemo(() => {
    const usable = keys.filter((key) => key.usable && key.status === "ok").length;
    const checked = keys.filter((key) => key.status !== "unchecked").length;
    const totalUses = keys.reduce((sum, key) => sum + Number(key.uses || 0), 0);
    return { usable, checked, totalUses };
  }, [keys]);

  async function refreshKeys() {
    const data = await api("/api/keys");
    setKeys(data.keys || []);
  }

  async function checkKeys() {
    setKeysBusy(true);
    setNotice(null);
    try {
      const data = await api("/api/keys/check", {
        method: "POST",
        body: { keys: keysInput }
      });
      setKeys(data.keys || []);
      setNotice({ type: "good", text: `${data.keys?.filter((key) => key.status === "ok").length || 0} key(s) ready` });
    } catch (error) {
      setNotice({ type: "bad", text: error.message });
      if (error.keys) setKeys(error.keys);
    } finally {
      setKeysBusy(false);
    }
  }

  async function activateKeys() {
    setKeysBusy(true);
    setNotice(null);
    try {
      const data = await api("/api/keys", {
        method: "POST",
        body: { keys: keysInput, check: true }
      });
      setKeys(data.keys || []);
      setNotice({ type: "good", text: "Key pool activated" });
    } catch (error) {
      setNotice({ type: "bad", text: error.message });
      if (error.keys) setKeys(error.keys);
    } finally {
      setKeysBusy(false);
    }
  }

  async function deleteKey(id) {
    const data = await api(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    setKeys(data.keys || []);
  }

  async function submitGenerate(event) {
    event.preventDefault();
    if (isDataVideoUrl(form.videoUrl)) {
      setNotice({
        type: "bad",
        text: "Pasted video files need a public URL or asset:// ID before Seedance can use them."
      });
      return;
    }

    setGenerateBusy(true);
    setNotice(null);

    try {
      const data = await api("/api/generate", {
        method: "POST",
        body: form
      });
      const task = normalizeTask(data, "submitted");
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      setNotice({ type: "good", text: `Task ${data.id} submitted with ${data.key?.label || "rotated key"}` });
      window.setTimeout(() => pollTask(data.id, { quiet: true }), 1800);
    } catch (error) {
      setNotice({ type: "bad", text: error.message });
      if (error.keys) setKeys(error.keys);
    } finally {
      setGenerateBusy(false);
    }
  }

  async function pollTask(id, options = {}) {
    if (!id) return;

    try {
      const data = await api(`/api/tasks/${encodeURIComponent(id)}`);
      const task = normalizeTask(data, data.status || "running");
      setTasks((current) => {
        const exists = current.some((item) => item.id === id);
        if (!exists) return [task, ...current];
        return current.map((item) => (item.id === id ? { ...item, ...task } : item));
      });
      if (!options.quiet) {
        setNotice({ type: "good", text: `Task ${id} is ${task.status}` });
      }
      refreshKeys();
    } catch (error) {
      setTasks((current) => current.map((task) => (task.id === id ? { ...task, status: "failed", error: error.message } : task)));
      if (!options.quiet) setNotice({ type: "bad", text: error.message });
      if (error.keys) setKeys(error.keys);
    }
  }

  function updateForm(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function handlePaste(event) {
    const file = getMediaFileFromClipboard(event.clipboardData);
    if (!file) return;

    event.preventDefault();
    await attachMediaFile(file);
  }

  async function readClipboardMedia(kind) {
    if (!navigator.clipboard?.read) {
      setNotice({ type: "bad", text: `This browser only supports Ctrl+V paste for ${kind}s.` });
      return;
    }

    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const mediaType = item.types.find((type) => type.startsWith(`${kind}/`));
        if (!mediaType) continue;

        const blob = await item.getType(mediaType);
        await attachMediaFile(new File([blob], `clipboard.${extensionForType(mediaType)}`, { type: mediaType }));
        return;
      }

      setNotice({ type: "bad", text: `Clipboard does not contain a ${kind}.` });
    } catch (error) {
      setNotice({ type: "bad", text: error.message || `Could not read clipboard ${kind}.` });
    }
  }

  async function attachMediaFile(file) {
    if (file?.type?.startsWith("image/")) {
      await attachImageFile(file);
      return;
    }

    if (file?.type?.startsWith("video/")) {
      await attachVideoFile(file);
      return;
    }

    setNotice({ type: "bad", text: "Paste an image or video file." });
  }

  async function attachImageFile(file) {
    if (!file?.type?.startsWith("image/")) {
      setNotice({ type: "bad", text: "Paste an image file." });
      return;
    }

    if (file.size > MAX_PASTED_IMAGE_BYTES) {
      setNotice({ type: "bad", text: "Image is larger than 15 MB." });
      return;
    }

    const dataUrl = await fileToDataUrl(file, "image");
    setImageAsset({
      name: file.name || "clipboard image",
      size: file.size,
      type: file.type,
      preview: dataUrl
    });
    updateForm("imageUrl", dataUrl);
    setNotice({ type: "good", text: "Clipboard image attached" });
  }

  async function attachReferenceImageFile(file) {
    if (!file?.type?.startsWith("image/")) {
      setNotice({ type: "bad", text: "Paste an image file." });
      return;
    }

    if (file.size > MAX_PASTED_IMAGE_BYTES) {
      setNotice({ type: "bad", text: "Reference image is larger than 15 MB." });
      return;
    }

    const dataUrl = await fileToDataUrl(file, "reference image");
    addReferenceImage({
      url: dataUrl,
      name: file.name || "clipboard image",
      size: file.size,
      type: file.type,
      preview: dataUrl
    });
  }

  async function attachVideoFile(file) {
    if (!file?.type?.startsWith("video/")) {
      setNotice({ type: "bad", text: "Paste a video file." });
      return;
    }

    if (file.size > MAX_PASTED_VIDEO_BYTES) {
      setNotice({ type: "bad", text: "Video is larger than 22 MB. Use a public URL for larger clips." });
      return;
    }

    const dataUrl = await fileToDataUrl(file, "video");
    setVideoAsset({
      name: file.name || "clipboard video",
      size: file.size,
      type: file.type,
      preview: dataUrl
    });
    updateForm("videoUrl", dataUrl);
    setNotice({ type: "warn", text: "Clipboard video preview attached. Use a public URL or asset:// ID to generate from it." });
  }

  function clearImageAsset() {
    setImageAsset(null);
    updateForm("imageUrl", "");
  }

  function addReferenceImage(reference) {
    const url = typeof reference === "string" ? reference.trim() : String(reference?.url || "").trim();
    if (!url) return false;

    let added = false;
    setForm((current) => {
      const currentReferences = Array.isArray(current.referenceImages) ? current.referenceImages : [];
      if (currentReferences.length >= MAX_REFERENCE_IMAGES) {
        setNotice({ type: "bad", text: `Seedance supports up to ${MAX_REFERENCE_IMAGES} reference images.` });
        return current;
      }

      const duplicate = currentReferences.some((item) => String(item?.url || item).trim() === url);
      if (duplicate) {
        setNotice({ type: "warn", text: "Reference image is already attached." });
        return current;
      }

      added = true;
      const item =
        typeof reference === "string"
          ? { url, name: referenceLabel(url), preview: url }
          : { ...reference, url, preview: reference.preview || url };

      return {
        ...current,
        referenceImages: [...currentReferences, item]
      };
    });

    if (added) {
      setNotice({ type: "good", text: "Reference image attached" });
    }
    return added;
  }

  function addReferenceImageUrl() {
    if (addReferenceImage(referenceImageInput)) {
      setReferenceImageInput("");
    }
  }

  function removeReferenceImage(index) {
    setForm((current) => ({
      ...current,
      referenceImages: (Array.isArray(current.referenceImages) ? current.referenceImages : []).filter((_, itemIndex) => itemIndex !== index)
    }));
  }

  async function pasteReferenceImage() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const mediaType = item.types.find((type) => type.startsWith("image/"));
        if (!mediaType) continue;

        const blob = await item.getType(mediaType);
        await attachReferenceImageFile(new File([blob], `reference.${extensionForType(mediaType)}`, { type: mediaType }));
        return;
      }

      setNotice({ type: "bad", text: "Clipboard does not contain an image." });
    } catch (error) {
      setNotice({ type: "bad", text: error.message || "Could not read clipboard image." });
    }
  }

  function clearVideoAsset() {
    setVideoAsset(null);
    updateForm("videoUrl", "");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">
            <Clapperboard size={16} />
            Volcengine Ark
          </div>
          <h1>Seedance Console</h1>
        </div>
        <div className="metrics">
          <Metric icon={<ShieldCheck size={16} />} label="Ready keys" value={`${stats.usable}/${keys.length}`} />
          <Metric icon={<RotateCw size={16} />} label="Rotations" value={stats.totalUses} />
          <Metric icon={<Gauge size={16} />} label="Checked" value={stats.checked} />
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.type}`}>
          {notice.type === "bad" ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
          <span>{notice.text}</span>
        </div>
      )}

      <section className="workspace">
        <aside className="panel key-panel">
          <PanelTitle icon={<KeyRound size={18} />} title="Key Pool" />
          <textarea
            className="key-input"
            value={keysInput}
            onChange={(event) => setKeysInput(event.target.value)}
            placeholder="Paste Ark API keys, one per line"
            spellCheck="false"
          />
          <div className="button-row">
            <button className="primary" onClick={activateKeys} disabled={keysBusy}>
              {keysBusy ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}
              Activate
            </button>
            <button onClick={checkKeys} disabled={keysBusy || (!keysInput.trim() && !keys.length)}>
              {keysBusy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              Check
            </button>
          </div>

          <div className="key-list">
            {keys.length ? (
              keys.map((key) => (
                <div className="key-row" key={key.id}>
                  <div>
                    <div className="key-name">{key.label}</div>
                    <div className="key-meta">
                      <StatusPill status={key.status} />
                      <span>{key.uses || 0} uses</span>
                      <span>{key.errors || 0} errors</span>
                    </div>
                  </div>
                  <button className="icon-button" onClick={() => deleteKey(key.id)} aria-label="Remove key">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-state">No active keys</div>
            )}
          </div>
        </aside>

        <form className="panel composer" onSubmit={submitGenerate} onPaste={handlePaste}>
          <PanelTitle icon={<SlidersHorizontal size={18} />} title="Generation" />
          <div className="segmented">
            {MODELS.map((model) => (
              <button
                type="button"
                key={model.id}
                className={form.model === model.id ? "selected" : ""}
                onClick={() => updateForm("model", model.id)}
              >
                {model.label}
              </button>
            ))}
          </div>

          <label className="field span-2">
            <span>Prompt</span>
            <textarea
              className="prompt-input"
              value={form.prompt}
              onChange={(event) => updateForm("prompt", event.target.value)}
              placeholder="Describe the shot"
            />
          </label>

          <div className="field-grid">
            <div className="field image-field">
              <span>Image</span>
              <div className={`paste-zone ${imageAsset ? "has-image" : ""}`} tabIndex="0">
                {imageAsset ? (
                  <>
                    <img src={imageAsset.preview} alt="Pasted reference" />
                    <div className="image-chip">
                      <strong>{imageAsset.name}</strong>
                      <small>{formatBytes(imageAsset.size)} · {imageAsset.type}</small>
                    </div>
                    <button className="image-clear" type="button" onClick={clearImageAsset} aria-label="Clear pasted image">
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <div className="paste-empty">
                    <ImagePlus size={24} />
                    <strong>Ctrl+V image</strong>
                    <small>or paste a public URL below</small>
                  </div>
                )}
              </div>
              <div className="image-actions">
                <button type="button" onClick={() => readClipboardMedia("image")}>
                  <Clipboard size={16} />
                  Paste
                </button>
                <input
                  value={form.imageUrl.startsWith("data:image/") ? "clipboard image attached" : form.imageUrl}
                  onChange={(event) => {
                    setImageAsset(null);
                    updateForm("imageUrl", event.target.value);
                  }}
                  placeholder="https://..."
                />
              </div>
            </div>
            <div className="field video-field">
              <span>Video</span>
              {videoAsset && (
                <div className="media-card">
                  <video src={videoAsset.preview} controls muted preload="metadata" />
                  <div className="media-chip">
                    <strong>{videoAsset.name}</strong>
                    <small>{formatBytes(videoAsset.size)} · {videoAsset.type}</small>
                  </div>
                  <button className="media-clear" type="button" onClick={clearVideoAsset} aria-label="Clear pasted video">
                    <X size={15} />
                  </button>
                </div>
              )}
              <div className="image-actions media-actions">
                <button type="button" onClick={() => readClipboardMedia("video")}>
                  <Clipboard size={16} />
                  Paste
                </button>
                <input
                  value={form.videoUrl.startsWith("data:video/") ? "clipboard video attached" : form.videoUrl}
                  onChange={(event) => {
                    setVideoAsset(null);
                    updateForm("videoUrl", event.target.value);
                  }}
                  placeholder="https://..."
                />
              </div>
            </div>
            <div className="field reference-images-field">
              <div className="field-heading">
                <span>Reference Images</span>
                <small>{form.referenceImages.length}/{MAX_REFERENCE_IMAGES}</small>
              </div>
              <div className={`reference-grid ${form.referenceImages.length ? "" : "is-empty"}`}>
                {form.referenceImages.length ? (
                  form.referenceImages.map((reference, index) => (
                    <div className="reference-tile" key={`${reference.url}-${index}`}>
                      <img src={reference.preview || reference.url} alt={`Reference ${index + 1}`} />
                      <button type="button" onClick={() => removeReferenceImage(index)} aria-label="Remove reference image">
                        <X size={14} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="reference-empty">
                    <ImagePlus size={20} />
                    <span>Add up to 9 reference images</span>
                  </div>
                )}
              </div>
              <div className="image-actions reference-actions">
                <button type="button" onClick={pasteReferenceImage}>
                  <Clipboard size={16} />
                  Paste
                </button>
                <input
                  value={referenceImageInput}
                  onChange={(event) => setReferenceImageInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addReferenceImageUrl();
                    }
                  }}
                  placeholder="https://... or asset://..."
                />
                <button type="button" onClick={addReferenceImageUrl}>
                  <ImagePlus size={16} />
                  Add
                </button>
              </div>
            </div>
            <label className="field">
              <span>Audio URL</span>
              <input value={form.audioUrl} onChange={(event) => updateForm("audioUrl", event.target.value)} placeholder="https://..." />
            </label>
            <label className="field">
              <span>Ratio</span>
              <select value={form.ratio} onChange={(event) => updateForm("ratio", event.target.value)}>
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
                <option value="21:9">21:9</option>
                <option value="adaptive">adaptive</option>
              </select>
            </label>
            <label className="field">
              <span>Resolution</span>
              <select value={form.resolution} onChange={(event) => updateForm("resolution", event.target.value)}>
                <option value="720p">720p</option>
                <option value="1080p" disabled={form.model.includes("seedance-2-0-fast")}>
                  1080p
                </option>
              </select>
            </label>
            <label className="field">
              <span>Duration</span>
              <input
                type="number"
                min="-1"
                max="15"
                value={form.duration}
                onChange={(event) => updateForm("duration", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Seed</span>
              <input type="number" value={form.seed} onChange={(event) => updateForm("seed", event.target.value)} />
            </label>
            <div className="toggles">
              <Toggle label="Audio" checked={form.generate_audio} onChange={(value) => updateForm("generate_audio", value)} />
              <Toggle label="Watermark" checked={form.watermark} onChange={(value) => updateForm("watermark", value)} />
            </div>
          </div>

          <button className="launch-button" type="submit" disabled={generateBusy}>
            {generateBusy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            Generate
          </button>
        </form>

        <section className="panel results">
          <PanelTitle icon={<Film size={18} />} title="Tasks" />
          <div className="lookup">
            <input value={lookupId} onChange={(event) => setLookupId(event.target.value)} placeholder="Task ID" />
            <button onClick={() => pollTask(lookupId.trim())}>
              <RefreshCw size={16} />
              Poll
            </button>
          </div>

          <div className="task-list">
            {tasks.length ? (
              tasks.map((task) => <TaskCard key={task.id} task={task} onPoll={() => pollTask(task.id)} />)
            ) : (
              <div className="empty-state large">
                <Video size={28} />
                No tasks yet
              </div>
            )}
          </div>
        </section>
      </section>

      <footer className="footer-line">
        <span>{config?.baseUrl || "Ark endpoint loading"}</span>
      </footer>
    </main>
  );
}

function Metric({ icon, label, value }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PanelTitle({ icon, title }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function StatusPill({ status }) {
  return <span className={`status ${STATUS_CLASS[status] || "idle"}`}>{status || "unknown"}</span>;
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span />
      {label}
    </label>
  );
}

function TaskCard({ task, onPoll }) {
  const videoUrl = task.content?.video_url;

  return (
    <article className="task-card">
      <div className="task-head">
        <div>
          <div className="task-id">{task.id}</div>
          <div className="task-sub">
            <StatusPill status={task.status} />
            {task.key?.label && <span>{task.key.label}</span>}
            {task.duration && <span>{task.duration}s</span>}
            {task.resolution && <span>{task.resolution}</span>}
          </div>
        </div>
        <button className="icon-button" onClick={onPoll} aria-label="Poll task">
          <RefreshCw size={15} />
        </button>
      </div>

      {videoUrl ? (
        <div className="video-box">
          <video src={videoUrl} controls />
          <button className="copy-button" onClick={() => navigator.clipboard?.writeText(videoUrl)}>
            <Copy size={14} />
            Copy URL
          </button>
        </div>
      ) : (
        <div className="pending-box">
          {task.status === "failed" ? <AlertTriangle size={20} /> : <Clock3 size={20} />}
          <span>{task.error || "Waiting for video_url"}</span>
        </div>
      )}
    </article>
  );
}

function normalizeTask(data, fallbackStatus) {
  return {
    id: data.id,
    model: data.model,
    status: data.status || fallbackStatus,
    content: data.content || {},
    key: data.key,
    seed: data.seed,
    resolution: data.resolution,
    ratio: data.ratio,
    duration: data.duration,
    framespersecond: data.framespersecond,
    usage: data.usage,
    error: data.error?.message || data.error
  };
}

function getMediaFileFromClipboard(clipboardData) {
  const items = Array.from(clipboardData?.items || []);
  const fileItems = items.filter((item) => item.kind === "file");
  const videoItem = fileItems.find((item) => item.type.startsWith("video/"));
  const imageItem = fileItems.find((item) => item.type.startsWith("image/"));
  return (videoItem || imageItem)?.getAsFile() || null;
}

function fileToDataUrl(file, label = "file") {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read pasted ${label}.`));
    reader.readAsDataURL(file);
  });
}

function extensionForType(type) {
  const subtype = String(type || "").split("/")[1]?.split(";")[0];
  if (!subtype) return "bin";
  if (subtype === "quicktime") return "mov";
  if (subtype === "x-msvideo") return "avi";
  if (subtype.includes("mp4")) return "mp4";
  return subtype.replace(/[^a-z0-9]+/gi, "") || "bin";
}

function isDataVideoUrl(value) {
  return String(value || "").trim().toLowerCase().startsWith("data:video/");
}

function referenceLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "reference image";
  if (text.startsWith("asset://")) return text;

  try {
    const url = new URL(text);
    return pathTail(url.pathname) || url.hostname;
  } catch {
    return text.length > 48 ? `${text.slice(0, 45)}...` : text;
  }
}

function pathTail(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .pop();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed with HTTP ${response.status}`);
    error.keys = data.keys;
    throw error;
  }

  return data;
}

createRoot(document.getElementById("root")).render(<App />);

import React from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Clipboard,
  Copy,
  Film,
  FolderOpen,
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

const RESOLUTION_OPTIONS = [
  { value: "480p", label: "480p" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "4k", label: "4K" }
];

const QWEN_RESOLUTION_OPTIONS = ["720P", "1080P"];
const QWEN_RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"];

const STATUS_CLASS = {
  ok: "good",
  unchecked: "idle",
  rate_limited: "warn",
  invalid: "bad",
  error: "bad",
  pending: "idle",
  queued: "idle",
  running: "warn",
  succeeded: "good",
  failed: "bad",
  unknown: "bad",
  expired: "bad",
  canceled: "bad",
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
  const [videoUploadBusy, setVideoUploadBusy] = React.useState(false);
  const [folderPickerBusy, setFolderPickerBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [tasks, setTasks] = React.useState([]);
  const [lookupId, setLookupId] = React.useState("");
  const [imageAsset, setImageAsset] = React.useState(null);
  const [videoAsset, setVideoAsset] = React.useState(null);
  const videoUploadTokenRef = React.useRef(null);
  const [referenceImageInput, setReferenceImageInput] = React.useState("");
  const [autosave, setAutosave] = React.useState({
    enabled: false,
    directory: ""
  });
  const autosaveSaveTimerRef = React.useRef(null);
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
  const [qwenConfig, setQwenConfig] = React.useState(null);
  const [qwenBusy, setQwenBusy] = React.useState(false);
  const [qwenLookupId, setQwenLookupId] = React.useState("");
  const [qwenTasks, setQwenTasks] = React.useState([]);
  const [qwenForm, setQwenForm] = React.useState({
    mode: "t2v",
    prompt:
      "A compact ceramic robot waters tiny basil plants on a sunny kitchen shelf, gentle handheld camera movement, natural light",
    imageUrl: "",
    resolution: "720P",
    ratio: "16:9",
    duration: 5,
    seed: -1,
    watermark: false
  });

  React.useEffect(() => {
    refreshKeys();
    refreshAutosave();
    api("/api/config")
      .then(setConfig)
      .catch((error) => setNotice({ type: "bad", text: error.message }));
    api("/api/qwen/config")
      .then(setQwenConfig)
      .catch((error) => setNotice({ type: "bad", text: error.message }));
  }, []);

  React.useEffect(() => {
    if (!isResolutionSupported(form.model, form.resolution)) {
      updateForm("resolution", "720p");
    }
  }, [form.model, form.resolution]);

  React.useEffect(() => {
    return () => {
      if (autosaveSaveTimerRef.current) {
        window.clearTimeout(autosaveSaveTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    const active = tasks.filter((task) => ["queued", "running", "submitted"].includes(task.status) || task.autosave?.status === "saving");
    if (!active.length) return undefined;

    const timer = window.setInterval(() => {
      active.forEach((task) => pollTask(task.id, { quiet: true }));
    }, 5000);

    return () => window.clearInterval(timer);
  }, [tasks]);

  React.useEffect(() => {
    const active = qwenTasks.filter((task) => ["pending", "running"].includes(task.status));
    if (!active.length) return undefined;

    const timer = window.setInterval(() => {
      active.forEach((task) => pollQwenTask(task.id, { quiet: true }));
    }, 15000);

    return () => window.clearInterval(timer);
  }, [qwenTasks]);

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

  async function refreshAutosave() {
    try {
      const data = await api("/api/autosave");
      setAutosave({
        enabled: Boolean(data.enabled),
        directory: data.directory || ""
      });
    } catch (error) {
      setNotice({ type: "bad", text: error.message });
    }
  }

  async function persistAutosaveSettings(next, options = {}) {
    try {
      const data = await api("/api/autosave", {
        method: "PUT",
        body: next
      });
      setAutosave({
        enabled: Boolean(data.enabled),
        directory: data.directory || ""
      });
      if (options.notice) {
        setNotice({
          type: data.enabled ? "good" : "warn",
          text: data.enabled ? "Autosave settings updated." : "Autosave disabled."
        });
      }
    } catch (error) {
      setNotice({ type: "bad", text: error.message });
      refreshAutosave();
    }
  }

  function updateAutosave(name, value, options = {}) {
    const nextSettings = { ...autosave, [name]: value };
    setAutosave(nextSettings);

    if (autosaveSaveTimerRef.current) {
      window.clearTimeout(autosaveSaveTimerRef.current);
    }

    if (options.persist !== false) {
      const save = () => persistAutosaveSettings(nextSettings, { notice: options.notice });
      if (options.debounce) {
        autosaveSaveTimerRef.current = window.setTimeout(save, 650);
      } else {
        save();
      }
    }
  }

  async function chooseAutosaveFolder() {
    setFolderPickerBusy(true);
    setNotice({ type: "warn", text: "Choose an autosave folder in the system dialog." });

    try {
      const data = await api("/api/autosave/browse-folder", {
        method: "POST",
        body: {
          directory: autosave.directory
        }
      });

      if (!data.directory) {
        setNotice({ type: "warn", text: "Folder selection cancelled." });
        return;
      }

      updateAutosave("directory", data.directory, { notice: true });
    } catch (error) {
      setNotice({ type: "bad", text: error.message });
    } finally {
      setFolderPickerBusy(false);
    }
  }

  async function submitGenerate(event) {
    event.preventDefault();
    if (videoUploadBusy) {
      setNotice({ type: "warn", text: "Wait for the reference video upload to finish." });
      return;
    }

    if (videoAsset && !form.videoUrl) {
      setNotice({ type: "bad", text: "Reference video upload failed. Paste the video again or clear it." });
      return;
    }

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

  async function submitQwenGenerate(event) {
    event.preventDefault();
    setQwenBusy(true);
    setNotice(null);

    try {
      const data = await api("/api/qwen/happyhorse/generate", {
        method: "POST",
        body: qwenForm
      });
      const task = normalizeQwenTask(data, "pending", qwenForm);
      if (!task.id) {
        throw new Error("DashScope did not return a task id.");
      }

      setQwenTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      setNotice({ type: "good", text: `Qwen task ${task.id} submitted` });
      window.setTimeout(() => pollQwenTask(task.id, { quiet: true }), 2500);
    } catch (error) {
      setNotice({ type: "bad", text: error.message });
    } finally {
      setQwenBusy(false);
    }
  }

  async function pollQwenTask(id, options = {}) {
    if (!id) return;

    try {
      const data = await api(`/api/qwen/tasks/${encodeURIComponent(id)}`);
      const task = normalizeQwenTask(data, data.status || "running");
      setQwenTasks((current) => {
        const exists = current.some((item) => item.id === id);
        if (!exists) return [task, ...current];
        return current.map((item) =>
          item.id === id
            ? {
                ...item,
                ...task,
                mode: task.mode || item.mode,
                model: task.model || item.model,
                resolution: task.resolution || item.resolution,
                ratio: task.ratio || item.ratio,
                duration: task.duration || item.duration
              }
            : item
        );
      });
      if (!options.quiet) {
        setNotice({ type: "good", text: `Qwen task ${id} is ${task.status}` });
      }
    } catch (error) {
      setQwenTasks((current) => current.map((task) => (task.id === id ? { ...task, status: "failed", error: error.message } : task)));
      if (!options.quiet) setNotice({ type: "bad", text: error.message });
    }
  }

  function updateForm(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function updateQwenForm(name, value) {
    setQwenForm((current) => ({ ...current, [name]: value }));
  }

  async function handlePaste(event) {
    const file = getMediaFileFromClipboard(event.clipboardData);
    if (!file) return;

    event.preventDefault();
    await attachMediaFile(file);
  }

  async function readClipboardMedia(kind) {
    try {
      const media = await getClipboardMedia(kind);
      if (media?.file) {
        await attachMediaFile(media.file);
        return;
      }

      if (media?.url) {
        attachMediaUrl(kind, media.url, media);
        return;
      }

      setNotice({ type: "bad", text: `Clipboard does not contain a ${kind} or direct ${kind} URL.` });
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

  function attachMediaUrl(kind, url, media = {}) {
    if (kind === "image") {
      if (isDataImageUrl(url)) {
        const size = media.size || estimateDataUrlBytes(url);
        if (size > MAX_PASTED_IMAGE_BYTES) {
          setNotice({ type: "bad", text: "Image is larger than 15 MB." });
          return;
        }

        setImageAsset({
          name: media.name || "clipboard image",
          size,
          type: media.type || dataUrlMimeType(url) || "image",
          preview: url
        });
      } else {
        setImageAsset(null);
      }

      updateForm("imageUrl", url);
      setNotice({ type: "good", text: "Clipboard image attached" });
      return;
    }

    if (kind === "video") {
      if (isDataVideoUrl(url)) {
        setNotice({
          type: "bad",
          text: "Pasted video files need a public URL or asset:// ID before Seedance can use them."
        });
        return;
      }

      videoUploadTokenRef.current = null;
      setVideoUploadBusy(false);
      setVideoAsset(null);
      updateForm("videoUrl", url);
      setNotice({ type: "good", text: "Reference video URL pasted" });
    }
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

    const uploadToken = `${Date.now()}-${Math.random()}`;
    const dataUrl = await fileToDataUrl(file, "video");
    videoUploadTokenRef.current = uploadToken;
    setVideoUploadBusy(true);
    setVideoAsset({
      id: uploadToken,
      name: file.name || "clipboard video",
      size: file.size,
      type: file.type,
      preview: dataUrl,
      uploadStatus: "uploading"
    });
    updateForm("videoUrl", "");
    setNotice({ type: "warn", text: "Uploading reference video to Litterbox..." });

    try {
      const data = await api("/api/uploads/reference-video", {
        method: "POST",
        body: {
          dataUrl,
          name: file.name || "clipboard-video",
          type: file.type
        }
      });

      if (videoUploadTokenRef.current !== uploadToken) return;

      setVideoAsset((current) =>
        current?.id === uploadToken
          ? {
              ...current,
              url: data.url,
              expires: data.expires,
              uploadStatus: "ready"
            }
          : current
      );
      updateForm("videoUrl", data.url);
      setNotice({ type: "good", text: `Reference video uploaded to Litterbox (${data.expires})` });
    } catch (error) {
      if (videoUploadTokenRef.current !== uploadToken) return;

      setVideoAsset((current) => (current?.id === uploadToken ? { ...current, uploadStatus: "failed" } : current));
      updateForm("videoUrl", "");
      setNotice({ type: "bad", text: error.message || "Could not upload reference video to Litterbox." });
    } finally {
      if (videoUploadTokenRef.current === uploadToken) {
        setVideoUploadBusy(false);
      }
    }
  }

  function clearImageAsset() {
    setImageAsset(null);
    updateForm("imageUrl", "");
  }

  function addReferenceImage(reference) {
    const url = typeof reference === "string" ? reference.trim() : String(reference?.url || "").trim();
    if (!url) return false;

    if (isDataImageUrl(url) && estimateDataUrlBytes(url) > MAX_PASTED_IMAGE_BYTES) {
      setNotice({ type: "bad", text: "Reference image is larger than 15 MB." });
      return false;
    }

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
      const media = await getClipboardMedia("image");
      if (media?.file) {
        await attachReferenceImageFile(media.file);
        return;
      }

      if (media?.url) {
        addReferenceImage({
          url: media.url,
          name: media.name || (isDataImageUrl(media.url) ? "clipboard image" : referenceLabel(media.url)),
          size: media.size,
          type: media.type,
          preview: media.url
        });
        return;
      }

      setNotice({ type: "bad", text: "Clipboard does not contain an image or direct image URL." });
    } catch (error) {
      setNotice({ type: "bad", text: error.message || "Could not read clipboard image." });
    }
  }

  async function pasteQwenImage() {
    try {
      const media = await getClipboardMedia("image");
      if (media?.file) {
        if (media.file.size > MAX_PASTED_IMAGE_BYTES) {
          setNotice({ type: "bad", text: "Image is larger than 15 MB." });
          return;
        }

        updateQwenForm("imageUrl", await fileToDataUrl(media.file, "Qwen first frame"));
        setNotice({ type: "good", text: "Qwen first frame attached" });
        return;
      }

      if (media?.url) {
        updateQwenForm("imageUrl", media.url);
        setNotice({ type: "good", text: "Qwen first frame attached" });
        return;
      }

      setNotice({ type: "bad", text: "Clipboard does not contain an image or direct image URL." });
    } catch (error) {
      setNotice({ type: "bad", text: error.message || "Could not read clipboard image." });
    }
  }

  function clearVideoAsset() {
    videoUploadTokenRef.current = null;
    setVideoUploadBusy(false);
    setVideoAsset(null);
    updateForm("videoUrl", "");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">
            <img className="brand-logo" src="/bytedance-color.svg" alt="" />
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
          {notice.type === "good" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
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

          <section className="side-section autosave-settings">
            <div className="side-section-title">
              <FolderOpen size={17} />
              <h3>Autosave</h3>
            </div>
            <Toggle label="Save videos" checked={autosave.enabled} onChange={(value) => updateAutosave("enabled", value, { notice: true })} />
            <div className="field">
              <span>Folder</span>
              <div className="autosave-folder-row">
                <input
                  value={autosave.directory}
                  onChange={(event) => updateAutosave("directory", event.target.value, { debounce: true })}
                  placeholder="C:\Users\agalq\Videos\Seedance"
                  disabled={folderPickerBusy}
                />
                <button type="button" onClick={chooseAutosaveFolder} disabled={folderPickerBusy}>
                  {folderPickerBusy ? <Loader2 className="spin" size={16} /> : <FolderOpen size={16} />}
                  Choose
                </button>
              </div>
            </div>
            <small className="helper-text">Settings save automatically. Completed videos save after a poll returns the generated URL.</small>
          </section>
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
                    <small>
                      {formatBytes(videoAsset.size)} · {videoAsset.type}
                      {videoAsset.uploadStatus === "uploading" ? " · uploading" : ""}
                      {videoAsset.uploadStatus === "ready" ? ` · Litterbox ${videoAsset.expires}` : ""}
                      {videoAsset.uploadStatus === "failed" ? " · upload failed" : ""}
                    </small>
                  </div>
                  <button className="media-clear" type="button" onClick={clearVideoAsset} aria-label="Clear pasted video">
                    <X size={15} />
                  </button>
                </div>
              )}
              <div className="image-actions media-actions">
                <button type="button" onClick={() => readClipboardMedia("video")} disabled={videoUploadBusy}>
                  {videoUploadBusy ? <Loader2 className="spin" size={16} /> : <Clipboard size={16} />}
                  Paste
                </button>
                <input
                  value={videoUploadBusy ? "uploading to Litterbox..." : form.videoUrl}
                  disabled={videoUploadBusy}
                  onChange={(event) => {
                    videoUploadTokenRef.current = null;
                    setVideoUploadBusy(false);
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
                {RESOLUTION_OPTIONS.map((resolution) => (
                  <option key={resolution.value} value={resolution.value} disabled={!isResolutionSupported(form.model, resolution.value)}>
                    {resolution.label}
                  </option>
                ))}
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

          <button className="launch-button" type="submit" disabled={generateBusy || videoUploadBusy}>
            {generateBusy || videoUploadBusy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            {videoUploadBusy ? "Uploading video" : "Generate"}
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

        {qwenConfig?.enabled && (
          <section className="panel qwen-console">
            <PanelTitle icon={<Film size={18} />} title="Qwen Console" />
            <form className="qwen-form" onSubmit={submitQwenGenerate}>
              {!qwenConfig?.configured && (
                <div className="inline-alert warn">
                  <AlertTriangle size={16} />
                  <span>Set DASHSCOPE_API_KEY in .env</span>
                </div>
              )}

              <div className="segmented qwen-mode">
                <button
                  type="button"
                  className={qwenForm.mode === "t2v" ? "selected" : ""}
                  onClick={() => updateQwenForm("mode", "t2v")}
                >
                  Text
                </button>
                <button
                  type="button"
                  className={qwenForm.mode === "i2v" ? "selected" : ""}
                  onClick={() => updateQwenForm("mode", "i2v")}
                >
                  Image
                </button>
              </div>

              <label className="field">
                <span>Prompt</span>
                <textarea
                  className="qwen-prompt"
                  value={qwenForm.prompt}
                  onChange={(event) => updateQwenForm("prompt", event.target.value)}
                  placeholder="Describe the clip"
                />
              </label>

              {qwenForm.mode === "i2v" && (
                <div className="field">
                  <span>First frame</span>
                  <div className="image-actions qwen-image-actions">
                    <button type="button" onClick={pasteQwenImage}>
                      <Clipboard size={16} />
                      Paste
                    </button>
                    <input
                      value={qwenForm.imageUrl.startsWith("data:image/") ? "clipboard image attached" : qwenForm.imageUrl}
                      onChange={(event) => updateQwenForm("imageUrl", event.target.value)}
                      placeholder="https://... or data:image/..."
                    />
                  </div>
                </div>
              )}

              <div className="qwen-grid">
                <label className="field">
                  <span>Resolution</span>
                  <select value={qwenForm.resolution} onChange={(event) => updateQwenForm("resolution", event.target.value)}>
                    {QWEN_RESOLUTION_OPTIONS.map((resolution) => (
                      <option key={resolution} value={resolution}>
                        {resolution}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Ratio</span>
                  <select
                    value={qwenForm.ratio}
                    onChange={(event) => updateQwenForm("ratio", event.target.value)}
                    disabled={qwenForm.mode === "i2v"}
                  >
                    {QWEN_RATIO_OPTIONS.map((ratio) => (
                      <option key={ratio} value={ratio}>
                        {ratio}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Duration</span>
                  <input
                    type="number"
                    min="3"
                    max="15"
                    value={qwenForm.duration}
                    onChange={(event) => updateQwenForm("duration", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Seed</span>
                  <input type="number" value={qwenForm.seed} onChange={(event) => updateQwenForm("seed", event.target.value)} />
                </label>
              </div>

              <Toggle label="Watermark" checked={qwenForm.watermark} onChange={(value) => updateQwenForm("watermark", value)} />

              <button className="primary qwen-submit" type="submit" disabled={qwenBusy}>
                {qwenBusy ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                Generate
              </button>
            </form>

            <div className="lookup qwen-lookup">
              <input value={qwenLookupId} onChange={(event) => setQwenLookupId(event.target.value)} placeholder="Qwen task ID" />
              <button onClick={() => pollQwenTask(qwenLookupId.trim())}>
                <RefreshCw size={16} />
                Poll
              </button>
            </div>

            <div className="task-list qwen-task-list">
              {qwenTasks.length ? (
                qwenTasks.map((task) => <QwenTaskCard key={task.id} task={task} onPoll={() => pollQwenTask(task.id)} />)
              ) : (
                <div className="empty-state">
                  <Video size={22} />
                  No Qwen tasks
                </div>
              )}
            </div>
          </section>
        )}
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
          {task.autosave && <AutosaveStatus autosave={task.autosave} />}
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

function QwenTaskCard({ task, onPoll }) {
  const videoUrl = task.videoUrl || extractQwenVideoUrl(task);

  return (
    <article className="task-card qwen-task-card">
      <div className="task-head">
        <div>
          <div className="task-id">{task.id}</div>
          <div className="task-sub">
            <StatusPill status={task.status} />
            {task.mode && <span>{task.mode.toUpperCase()}</span>}
            {task.duration && <span>{task.duration}s</span>}
            {task.resolution && <span>{task.resolution}</span>}
          </div>
        </div>
        <button className="icon-button" onClick={onPoll} aria-label="Poll Qwen task">
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

function AutosaveStatus({ autosave }) {
  const status = autosave.status || "saving";
  const isSaved = status === "saved";
  const isFailed = status === "failed";

  return (
    <div className={`autosave-state ${isSaved ? "good" : isFailed ? "bad" : "warn"}`}>
      {isSaved ? <CheckCircle2 size={15} /> : isFailed ? <AlertTriangle size={15} /> : <Loader2 className="spin" size={15} />}
      <span>{autosaveStatusText(autosave)}</span>
    </div>
  );
}

function autosaveStatusText(autosave) {
  if (autosave.status === "saved") return `Saved to ${autosave.path}`;
  if (autosave.status === "failed") return `Autosave failed: ${autosave.error || "unknown error"}`;
  return `Saving to ${autosave.path}`;
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
    autosave: data.autosave || null,
    error: data.error?.message || data.error
  };
}

function normalizeQwenTask(data, fallbackStatus, request = {}) {
  const output = data.output || {};
  return {
    id: data.id || output.task_id || data.task_id,
    model: data.model || request.model || (request.mode === "i2v" ? "happyhorse-1.1-i2v" : "happyhorse-1.1-t2v"),
    mode: data.mode || request.mode || "",
    status: normalizeQwenStatus(data.status || output.task_status || fallbackStatus),
    output,
    usage: data.usage,
    requestId: data.request_id,
    videoUrl: data.videoUrl || extractQwenVideoUrl(data),
    resolution: data.resolution || request.resolution,
    ratio: data.ratio || request.ratio,
    duration: data.duration || request.duration,
    error: output.message || data.message || data.error?.message || data.error
  };
}

function normalizeQwenStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "canceled") return "cancelled";
  return normalized || "unknown";
}

function extractQwenVideoUrl(data) {
  const output = data?.output || data || {};
  const direct = data?.videoUrl || output.video_url || output.video?.url || output.url;
  if (typeof direct === "string") return direct;
  if (direct?.url) return String(direct.url);

  const results = Array.isArray(output.results) ? output.results : Array.isArray(output.videos) ? output.videos : [];
  for (const item of results) {
    if (typeof item === "string") return item;
    if (item?.url) return String(item.url);
    if (item?.video_url) return String(item.video_url);
  }

  return "";
}

function isResolutionSupported(model, resolution) {
  if (isSeedance2FastModel(model)) {
    return resolution === "480p" || resolution === "720p";
  }

  return RESOLUTION_OPTIONS.some((option) => option.value === resolution);
}

function isSeedance2FastModel(model) {
  return String(model || "").includes("seedance-2-0-fast");
}

async function getClipboardMedia(kind) {
  let readError = null;

  if (navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      const media = await mediaFromClipboardItems(items, kind);
      if (media) return media;
    } catch (error) {
      readError = error;
    }
  }

  const text = await readClipboardTextFallback();
  const url = extractClipboardMediaUrl(text, kind);
  if (url) return { url };

  if (kind === "image") {
    const localImage = await readLocalClipboardImageFallback();
    if (localImage?.dataUrl) {
      return {
        url: localImage.dataUrl,
        name: localImage.name,
        size: localImage.size,
        type: localImage.type
      };
    }
  }

  if (readError) {
    throw new Error(clipboardReadErrorMessage(readError, kind));
  }

  if (!navigator.clipboard?.read && !navigator.clipboard?.readText) {
    throw new Error(`This browser only supports Ctrl+V paste for ${kind}s.`);
  }

  return null;
}

async function readLocalClipboardImageFallback() {
  try {
    return await api("/api/clipboard/image", { method: "POST" });
  } catch (error) {
    if (error.status === 404 || error.status === 501) return null;
    throw error;
  }
}

async function mediaFromClipboardItems(items, kind) {
  for (const item of Array.from(items || [])) {
    const mediaType = item.types.find((type) => type.startsWith(`${kind}/`));
    if (!mediaType) continue;

    const blob = await item.getType(mediaType);
    return {
      file: new File([blob], `clipboard.${extensionForType(mediaType)}`, { type: mediaType })
    };
  }

  for (const item of Array.from(items || [])) {
    const textTypes = ["text/uri-list", "text/html", "text/plain"].filter((type) => item.types.includes(type));

    for (const textType of textTypes) {
      const blob = await item.getType(textType);
      const url = extractClipboardMediaUrl(await blob.text(), kind, textType);
      if (url) return { url };
    }
  }

  return null;
}

async function readClipboardTextFallback() {
  if (!navigator.clipboard?.readText) return "";

  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

function extractClipboardMediaUrl(value, kind, mimeType = "") {
  const text = String(value || "").trim();
  if (!text) return "";

  if (mimeType === "text/html" || /<\/?[a-z][\s\S]*>/i.test(text)) {
    const htmlUrl = mediaUrlFromHtml(text, kind);
    if (htmlUrl) return htmlUrl;
  }

  const uriListUrl = mediaUrlFromUriList(text, kind);
  if (uriListUrl) return uriListUrl;

  const directUrl = text.match(/\b(?:https?:\/\/|asset:\/\/|data:[a-z]+\/)[^\s<>"']+/i)?.[0];
  return isUsableMediaReference(directUrl, kind) ? cleanClipboardUrl(directUrl) : "";
}

function mediaUrlFromHtml(value, kind) {
  try {
    const document = new DOMParser().parseFromString(value, "text/html");
    const selectors = kind === "image" ? ["img[src]", "source[srcset]", "source[src]"] : ["video[src]", "source[src]"];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const rawValue = element?.getAttribute(selector.includes("srcset") ? "srcset" : "src");
      const candidate = selector.includes("srcset") ? firstSrcsetUrl(rawValue) : rawValue;
      if (isUsableMediaReference(candidate, kind)) return cleanClipboardUrl(candidate);
    }
  } catch {
    return "";
  }

  return "";
}

function mediaUrlFromUriList(value, kind) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const line of lines) {
    if (isUsableMediaReference(line, kind)) return cleanClipboardUrl(line);
  }

  return "";
}

function firstSrcsetUrl(value) {
  return String(value || "")
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .find(Boolean);
}

function isUsableMediaReference(value, kind) {
  const text = cleanClipboardUrl(value);
  if (!text) return false;

  const lower = text.toLowerCase();
  if (lower.startsWith(`data:${kind}/`)) return true;
  if (lower.startsWith("asset://")) return true;

  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanClipboardUrl(value) {
  return String(value || "")
    .trim()
    .replace(/[\u0000-\u001f]+/g, "")
    .replace(/[)\].,;'"`]+$/g, "");
}

function clipboardReadErrorMessage(error, kind) {
  const message = error?.message || `Could not read clipboard ${kind}.`;
  if (/denied|notallowed|permission|not focused|document is not focused/i.test(message)) {
    return `Clipboard ${kind} paste was blocked by the browser. Allow clipboard access for this site or use Ctrl+V in the Generation panel.`;
  }

  return message;
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

function isDataImageUrl(value) {
  return String(value || "").trim().toLowerCase().startsWith("data:image/");
}

function dataUrlMimeType(value) {
  const match = /^data:([^;,]+)[;,]/i.exec(String(value || ""));
  return match?.[1]?.toLowerCase() || "";
}

function estimateDataUrlBytes(value) {
  const text = String(value || "");
  const match = /^data:[^,]*,(.*)$/s.exec(text);
  if (!match) return 0;

  const payload = match[1];
  if (/^data:[^,]*;base64,/i.test(text)) {
    const normalized = payload.replace(/\s/g, "");
    const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
    return Math.max(Math.floor((normalized.length * 3) / 4) - padding, 0);
  }

  try {
    return decodeURIComponent(payload).length;
  } catch {
    return payload.length;
  }
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
    error.status = response.status;
    error.keys = data.keys;
    throw error;
  }

  return data;
}

createRoot(document.getElementById("root")).render(<App />);

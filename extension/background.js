// PixelQ Background Service Worker v3 - standalone queue + desktop bridge

const WS_URL = "ws://127.0.0.1:8765/ws";
const API_BASE = "http://127.0.0.1:8765";
const RECONNECT_DELAY = 5000;

let currentMode = "standalone";
let ws = null;
let reconnectTimer = null;
let isConnected = false;
let activeChatGPTTab = null;
let bridgeConnectInFlight = false;

let jobs = [];
let history = [];
let settings = {
  cooldown: 60,
  autoDownload: true,
  maxRetries: 3,
  newThreadPerImage: true,
  adaptiveRateLimit: true,
  theme: "system",
};
let running = false;
let currentJob = null;
let nextRunTimeout = null;
let nextRunTime = null;
let consecutiveSuccesses = 0;
let currentCooldown = 60;
let desktopManaged = false;
let chatgptReadyState = false;

async function init() {
  console.log("[PixelQ] Initializing...");
  await loadState();
  await tryEnhancedMode();
  await sendStatus().catch(() => {});
  console.log(`[PixelQ] Mode: ${currentMode}`);
}

async function loadState() {
  try {
    const stored = await chrome.storage.local.get([
      "jobs",
      "history",
      "settings",
      "running",
      "desktopManaged",
      "pixelq.newThreadDefaultMigrated",
    ]);
    if (Array.isArray(stored.jobs)) jobs = stored.jobs.map(normalizeStoredJob);
    if (Array.isArray(stored.history)) history = stored.history.map(normalizeStoredJob);
    if (stored.settings) settings = { ...settings, ...stored.settings };
    if (stored["pixelq.newThreadDefaultMigrated"] !== true) {
      settings.newThreadPerImage = true;
      await chrome.storage.local.set({
        settings: { ...stored.settings, ...settings },
        "pixelq.newThreadDefaultMigrated": true,
      });
    } else if (!stored.settings || typeof stored.settings.newThreadPerImage !== "boolean") {
      settings.newThreadPerImage = true;
    }
    if (stored.running) running = stored.running;
    desktopManaged = stored.desktopManaged === true;
    currentCooldown = settings.cooldown;
  } catch (error) {
    console.error("[PixelQ] Failed to load state:", error);
  }
}

async function saveState() {
  try {
    await chrome.storage.local.set({ jobs, history, settings, running, desktopManaged });
  } catch (error) {
    console.error("[PixelQ] Failed to save state:", error);
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function tryEnhancedMode() {
  if (bridgeConnectInFlight || (ws && ws.readyState === WebSocket.OPEN)) {
    return;
  }

  bridgeConnectInFlight = true;
  return new Promise((resolve) => {
    const finish = () => {
      bridgeConnectInFlight = false;
      resolve();
    };

    try {
      ws = new WebSocket(WS_URL);

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          isConnected = false;
          ws = null;
          currentMode = "standalone";
          scheduleReconnect();
          finish();
        }
      }, 2000);

      ws.onopen = () => {
        clearTimeout(timeout);
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        currentMode = "enhanced-ws";
        isConnected = true;
        console.log("[PixelQ] Connected to desktop app");
        sendStatus();
        bootstrapDesktopState().catch((error) => {
          console.error("[PixelQ] Desktop bootstrap failed:", error);
        });
        finish();
      };

      ws.onclose = () => {
        if (isConnected || currentMode === "enhanced-ws") {
          console.log("[PixelQ] Lost desktop app connection");
        }
        isConnected = false;
        ws = null;
        currentMode = "standalone";
        scheduleReconnect();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        isConnected = false;
        ws = null;
        currentMode = "standalone";
        scheduleReconnect();
        finish();
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleServiceMessage(message);
        } catch (error) {
          console.error("[PixelQ] Failed to parse message:", error);
        }
      };
    } catch {
      isConnected = false;
      currentMode = "standalone";
      scheduleReconnect();
      finish();
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await tryEnhancedMode();
  }, RECONNECT_DELAY);
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

async function bootstrapDesktopState() {
  const status = await fetchJson("/bridge/status");
  if (!status.needs_bootstrap) {
    desktopManaged = true;
    await saveState();
    return;
  }

  const stored = await chrome.storage.local.get(["pixelq.templates"]);
  const templates = Array.isArray(stored["pixelq.templates"]) ? stored["pixelq.templates"] : [];

  await fetchJson("/bridge/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templates,
      jobs: [],
      history: [],
    }),
  });

  desktopManaged = true;
  await saveState();
}

async function handleServiceMessage(message) {
  switch (message.type) {
    case "submit_prompt":
      try {
        await executeJob({ id: message.id, prompt: message.prompt });
      } catch (error) {
        console.error("[PixelQ] Failed to run desktop job:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (currentMode === "enhanced-ws") {
          send({ type: "generation_failed", id: message.id, error: errorMessage });
        }
        currentJob = null;
        broadcastState();
      }
      break;
    case "check_status":
      sendStatus();
      break;
  }
}

function generateId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeMetadata(metadata = null) {
  if (!metadata || typeof metadata !== "object") return null;
  const normalized = {
    source: typeof metadata.source === "string" ? metadata.source : "",
    project: typeof metadata.project === "string" ? metadata.project : "",
    templateId: typeof metadata.templateId === "string" ? metadata.templateId : "",
    templateName: typeof metadata.templateName === "string" ? metadata.templateName : "",
    variables: {},
  };

  if (metadata.variables && typeof metadata.variables === "object") {
    for (const [key, value] of Object.entries(metadata.variables)) {
      normalized.variables[key] = String(value ?? "");
    }
  }

  const hasValues =
    normalized.source ||
    normalized.project ||
    normalized.templateId ||
    normalized.templateName ||
    Object.keys(normalized.variables).length > 0;

  return hasValues ? normalized : null;
}

function normalizeStoredJob(job = {}) {
  return {
    id: job.id || generateId(),
    prompt: job.prompt || "",
    status: job.status || "pending",
    priority: Number.isFinite(job.priority) ? job.priority : 0,
    retries: Number.isFinite(job.retries) ? job.retries : 0,
    createdAt: job.createdAt || new Date().toISOString(),
    scheduledAt: job.scheduledAt || null,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    archivedAt: job.archivedAt || null,
    images: Array.isArray(job.images) ? job.images : [],
    error: job.error || "",
    metadata: normalizeMetadata(job.metadata),
  };
}

function createJobRecord(input, defaultPriority = 0) {
  if (typeof input === "string") {
    input = { prompt: input };
  }
  const prompt = String(input?.prompt || "").trim();
  if (!prompt) return null;

  return normalizeStoredJob({
    id: generateId(),
    prompt,
    status: "pending",
    priority: Number.isFinite(input.priority) ? input.priority : defaultPriority,
    retries: 0,
    createdAt: new Date().toISOString(),
    metadata: normalizeMetadata(input.metadata || { source: "manual" }),
  });
}

function sortJobs(list) {
  list.sort((a, b) => {
    if ((b.priority || 0) !== (a.priority || 0)) {
      return (b.priority || 0) - (a.priority || 0);
    }
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

function queueJobs(inputs = []) {
  const created = inputs
    .map((input, index) => createJobRecord(input, inputs.length - index))
    .filter(Boolean);

  if (created.length === 0) {
    return [];
  }

  jobs.push(...created);
  sortJobs(jobs);
  saveState();
  broadcastState();

  if (!running && !currentJob) {
    startScheduler();
  }

  return created;
}

function addJob(prompt, priority = 0, metadata = null) {
  return queueJobs([{ prompt, priority, metadata }])[0] || null;
}

function addJobs(prompts) {
  return queueJobs(prompts.map((prompt) => ({ prompt })));
}

function addDetailedJobs(items) {
  return queueJobs(items);
}

function deleteJob(id) {
  const index = jobs.findIndex((job) => job.id === id);
  if (index === -1) return;

  jobs.splice(index, 1);
  saveState();
  broadcastState();
}

function archiveCompleted() {
  const archivable = jobs.filter((job) => ["completed", "failed"].includes(job.status));
  if (archivable.length === 0) {
    return 0;
  }

  const archivedAt = new Date().toISOString();
  const archived = archivable.map((job) => ({
    ...job,
    archivedAt,
  }));

  history = [...archived, ...history].slice(0, 100);
  jobs = jobs.filter((job) => !["completed", "failed"].includes(job.status));
  saveState();
  broadcastState();
  return archived.length;
}

function retryJob(id) {
  const job = jobs.find((item) => item.id === id);
  if (!job) return null;

  job.status = "pending";
  job.error = "";
  job.completedAt = null;
  job.startedAt = null;
  job.scheduledAt = null;
  saveState();
  broadcastState();

  if (!running && !currentJob) {
    startScheduler();
  }

  return job;
}

function getHistory(limit = 20) {
  return history.slice(0, limit);
}

function startScheduler() {
  if (running) return;
  running = true;
  saveState();

  if (!currentJob) {
    scheduleNext();
  }
}

function pauseScheduler() {
  running = false;
  if (nextRunTimeout) {
    clearTimeout(nextRunTimeout);
    nextRunTimeout = null;
  }
  nextRunTime = null;
  saveState();
  broadcastState();
}

function scheduleNext() {
  if (!running || currentJob) return;

  const pendingJob = jobs.find((job) => job.status === "pending");
  if (!pendingJob) {
    running = false;
    saveState();
    broadcastState();
    return;
  }

  const delay = currentCooldown * 1000;

  nextRunTime = Date.now() + delay;
  broadcastState();

  nextRunTimeout = setTimeout(async () => {
    nextRunTimeout = null;
    nextRunTime = null;
    await processNextJob();
  }, delay);
}

async function processNextJob() {
  if (currentJob) return;
  const job = jobs.find((item) => item.status === "pending");
  if (!job) {
    running = false;
    saveState();
    broadcastState();
    return;
  }
  try {
    await executeJob(job);
  } catch (error) {
    console.error("[PixelQ] Failed to execute job:", error);
    handleJobError(job, error instanceof Error ? error.message : String(error));
  }
}

async function executeJob(job) {
  currentJob = job;
  job.status = "in_progress";
  job.startedAt = new Date().toISOString();
  saveState();
  broadcastState();

  const tab = await findChatGPTTab();
  if (!tab) {
    handleJobError(job, "No ChatGPT tab found. Please open chatgpt.com first.");
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "submit_prompt",
      id: job.id,
      prompt: job.prompt,
      newThread: settings.newThreadPerImage,
    });
  } catch (error) {
    handleJobError(job, `Failed to communicate with ChatGPT tab: ${error.message}`);
  }
}

function findTrackedJob(id) {
  return jobs.find((item) => item.id === id) || (currentJob?.id === id ? currentJob : null);
}

function handleJobComplete(id, images) {
  const job = findTrackedJob(id);
  if (!job || job.status === "completed") {
    return;
  }

  job.status = "completed";
  job.completedAt = new Date().toISOString();
  job.images = Array.isArray(images) ? images : [];

  consecutiveSuccesses += 1;
  if (settings.adaptiveRateLimit && consecutiveSuccesses >= 3 && currentCooldown > settings.cooldown) {
    currentCooldown = Math.max(settings.cooldown, currentCooldown * 0.8);
  }

  const downloadTask = settings.autoDownload && job.images.length > 0
    ? downloadImages(job)
    : Promise.resolve(null);

  currentJob = null;
  saveState();
  broadcastState();

  if (currentMode === "enhanced-ws") {
    send({ type: "generation_complete", id, images });
  }

  downloadTask
    .then((manifest) => {
      if (manifest && currentMode === "enhanced-ws") {
        send({
          type: "download_manifest",
          data: manifest,
        });
      }
    })
    .catch((error) => {
      console.error("[PixelQ] Download ingest handoff failed:", error);
    });

  if (running) {
    scheduleNext();
  }
}

function handleJobError(job, error) {
  job.retries += 1;
  job.error = error;

  if (job.retries < settings.maxRetries) {
    job.status = "pending";
  } else {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
  }

  currentJob = null;
  saveState();
  broadcastState();

  if (currentMode === "enhanced-ws") {
    send({ type: "generation_failed", id: job.id, error });
  }

  if (running) {
    scheduleNext();
  }
}

function handleRateLimited(id) {
  const job = jobs.find((item) => item.id === id);
  if (job) {
    job.status = "pending";
    job.error = "Rate limited";
  }

  consecutiveSuccesses = 0;
  currentCooldown = settings.adaptiveRateLimit ? Math.min(currentCooldown * 2, 300) : settings.cooldown;
  currentJob = null;
  saveState();
  broadcastState();

  if (currentMode === "enhanced-ws") {
    send({ type: "rate_limited", id });
  }

  if (running) {
    scheduleNext();
  }
}

async function downloadImages(job) {
  const files = [];
  for (let index = 0; index < job.images.length; index += 1) {
    const url = job.images[index];
    const filename = getDownloadFilename(job, index, url);

    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
      });
      const completed = await waitForDownload(downloadId);
      files.push({
        path: completed?.filename || filename,
        name: filename.split("/").pop(),
        sourceUrl: url,
      });
    } catch (error) {
      console.error("[PixelQ] Download failed:", error);
    }
  }

  if (currentMode !== "enhanced-ws") {
    return null;
  }

  return {
    jobId: job.id,
    source: job.metadata?.source || "extension",
    files,
  };
}

function getDownloadFilename(job, index, url) {
  const extension = url.includes(".jpg") || url.includes(".jpeg") ? "jpg" : "png";
  if (currentMode === "enhanced-ws") {
    return `PixelQ/_inbox/${job.id}/${index + 1}.${extension}`;
  }
  const date = new Date().toISOString().split("T")[0];
  const promptShort = job.prompt.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "_");
  return `PixelQ/${date}_${promptShort}_${job.id.slice(0, 6)}_${index + 1}.${extension}`;
}

async function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    let finished = false;
    const listener = async (delta) => {
      if (delta.id !== downloadId || !delta.state?.current) {
        return;
      }
      if (delta.state.current === "complete" || delta.state.current === "interrupted") {
        finished = true;
        chrome.downloads.onChanged.removeListener(listener);
        const [item] = await chrome.downloads.search({ id: downloadId });
        resolve(item || null);
      }
    };

    chrome.downloads.onChanged.addListener(listener);
    setTimeout(async () => {
      if (finished) return;
      chrome.downloads.onChanged.removeListener(listener);
      const [item] = await chrome.downloads.search({ id: downloadId });
      resolve(item || null);
    }, 30000);
  });
}

function sortChatGPTTabs(tabs) {
  return [...tabs].sort((left, right) => {
    const leftScore = (left.active ? 8 : 0) + (left.status === "complete" ? 4 : 0) + (left.id === activeChatGPTTab?.id ? 2 : 0);
    const rightScore = (right.active ? 8 : 0) + (right.status === "complete" ? 4 : 0) + (right.id === activeChatGPTTab?.id ? 2 : 0);
    return rightScore - leftScore;
  });
}

async function findChatGPTTab() {
  const tabs = await chrome.tabs.query({
    url: ["*://chatgpt.com/*", "*://chat.openai.com/*"],
  });

  if (tabs.length === 0) {
    activeChatGPTTab = null;
    chatgptReadyState = false;
    return null;
  }

  const orderedTabs = sortChatGPTTabs(tabs);
  let fallbackTab = null;

  for (const tab of orderedTabs) {
    const response = await queryChatGPTTabStatus(tab.id).catch(() => null);
    if (!response) {
      continue;
    }

    fallbackTab = fallbackTab || tab;
    if (response.ready || response.hasPromptBox) {
      activeChatGPTTab = tab;
      chatgptReadyState = !!response.ready;
      return tab;
    }
  }

  activeChatGPTTab = fallbackTab;
  chatgptReadyState = false;
  return fallbackTab;
}

async function queryChatGPTTabStatus(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "check_status" });
  } catch (error) {
    const message = String(error?.message || "");
    const missingReceiver =
      message.includes("Receiving end does not exist") ||
      message.includes("Could not establish connection");

    if (!missingReceiver) {
      throw error;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      return await chrome.tabs.sendMessage(tabId, { type: "check_status" });
    } catch {
      return null;
    }
  }
}

async function probeChatGPTStatus() {
  const tabs = await chrome.tabs.query({
    url: ["*://chatgpt.com/*", "*://chat.openai.com/*"],
  });

  if (tabs.length === 0) {
    activeChatGPTTab = null;
    chatgptReadyState = false;
    return { tab: null, ready: false, tabUrl: "" };
  }

  const orderedTabs = sortChatGPTTabs(tabs);
  let fallbackTab = orderedTabs[0];

  for (const tab of orderedTabs) {
    try {
      const response = await queryChatGPTTabStatus(tab.id);
      if (response) {
        fallbackTab = tab;
        if (response.ready || response.hasPromptBox) {
          activeChatGPTTab = tab;
          chatgptReadyState = !!response.ready;
          return {
            tab,
            ready: !!response.ready,
            tabUrl: tab.url || response.url || "",
          };
        }
      }
    } catch {
      continue;
    }
  }

  activeChatGPTTab = fallbackTab;
  chatgptReadyState = false;
  return { tab: fallbackTab, ready: false, tabUrl: fallbackTab?.url || "" };
}

async function sendStatus() {
  const { ready, tabUrl } = await probeChatGPTStatus();
  send({ type: "status", ready, tab_url: tabUrl });
  broadcastState();
}

function getState() {
  const stats = {
    pending: jobs.filter((job) => job.status === "pending").length,
    active: jobs.filter((job) => ["scheduled", "in_progress"].includes(job.status)).length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
  };

  return {
    mode: currentMode,
    running,
    jobs: jobs.slice(0, 50),
    history: history.slice(0, 20),
    stats,
    nextRunIn: nextRunTime ? Math.max(0, (nextRunTime - Date.now()) / 1000) : 0,
    chatgptReady: chatgptReadyState,
    chatgptOpen: !!activeChatGPTTab,
    settings,
  };
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: "state_update", state: getState() }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "get_state":
      sendStatus().catch(() => {});
      sendResponse(getState());
      return true;

    case "get_settings":
      sendResponse(settings);
      return true;

    case "save_settings":
      settings = { ...settings, ...message.settings };
      currentCooldown = settings.cooldown;
      saveState();
      sendResponse({ success: true });
      return true;

    case "add_job":
      sendResponse({ job: addJob(message.prompt, message.priority, message.metadata) });
      return true;

    case "add_jobs":
      if (Array.isArray(message.jobs)) {
        sendResponse({ jobs: addDetailedJobs(message.jobs) });
      } else {
        sendResponse({ jobs: addJobs(message.prompts || []) });
      }
      return true;

    case "delete_job":
      deleteJob(message.id);
      sendResponse({ success: true });
      return true;

    case "retry_job":
      sendResponse({ job: retryJob(message.id) });
      return true;

    case "get_history":
      sendResponse({ jobs: getHistory(message.limit || 20) });
      return true;

    case "archive_completed":
    case "clear_completed":
      sendResponse({ archived: archiveCompleted() });
      return true;

    case "start":
      startScheduler();
      sendResponse({ success: true });
      return true;

    case "pause":
      pauseScheduler();
      sendResponse({ success: true });
      return true;
  }

  if (message.type === "content_ready") {
    activeChatGPTTab = sender.tab;
    sendStatus().catch(() => {});
  }

  if (message.type === "prompt_submitted" && currentMode === "enhanced-ws") {
    send(message);
  }

  if (message.type === "generation_complete") {
    handleJobComplete(message.id, message.images);
  }

  if (message.type === "generation_failed") {
    const job = currentJob || jobs.find((item) => item.id === message.id);
    if (job) {
      handleJobError(job, message.error);
    }
  }

  if (message.type === "rate_limited") {
    handleRateLimited(message.id);
  }

  sendResponse({ received: true });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    (tab.url?.includes("chatgpt.com") || tab.url?.includes("chat.openai.com"))
  ) {
    activeChatGPTTab = tab;
    sendStatus().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeChatGPTTab && activeChatGPTTab.id === tabId) {
    activeChatGPTTab = null;
    chatgptReadyState = false;
    sendStatus().catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(() => {
  sendStatus().catch(() => {});
});

init();

setInterval(() => {
  sendStatus().catch(() => {});
}, 5000);

console.log("[PixelQ] Background service worker v3 started");

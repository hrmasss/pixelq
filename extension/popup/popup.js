import { loadPopupDraft, loadTemplates, savePopupDraft } from "./local-data.js";
import { parseCSV } from "./csv.js";
import {
  cloneJson,
  escapeHtml,
  firstMeaningfulTimestamp,
  formatCountdown,
  formatRelativeTime,
  getSourceLabel,
  getStatusView,
  normalizeMetadata,
  summarizePrompt,
} from "./utils.js";

const API_BASE = "http://127.0.0.1:8765";
const SAVE_STATE_LABELS = {
  idle: "Idle",
  saving: "Saving",
  saved: "Saved",
  error: "Save failed",
};

const refs = {
  connectionStatus: document.getElementById("connection-status"),
  chatgptStatus: document.getElementById("chatgpt-status"),
  queueStrip: document.getElementById("queue-strip"),
  queueStats: document.getElementById("queue-stats"),
  activeList: document.getElementById("active-list"),
  backlogList: document.getElementById("backlog-list"),
  activeCount: document.getElementById("active-count"),
  backlogCount: document.getElementById("backlog-count"),
  historyList: document.getElementById("history-list"),
  historyCount: document.getElementById("history-count"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnStart: document.getElementById("btn-start"),
  btnPause: document.getElementById("btn-pause"),
  btnArchive: document.getElementById("btn-archive"),
  quick: {
    project: document.getElementById("quick-project"),
    template: document.getElementById("quick-template"),
    manualGroup: document.getElementById("quick-manual-group"),
    prompt: document.getElementById("quick-prompt"),
    templateGroup: document.getElementById("quick-template-group"),
    templateMeta: document.getElementById("quick-template-meta"),
    templateFields: document.getElementById("quick-template-fields"),
    preview: document.getElementById("quick-preview"),
    summary: document.getElementById("quick-summary"),
    submit: document.getElementById("quick-submit"),
  },
  batch: {
    project: document.getElementById("batch-project"),
    template: document.getElementById("batch-template"),
    manualGroup: document.getElementById("batch-manual-group"),
    lines: document.getElementById("batch-lines"),
    templateGroup: document.getElementById("batch-template-group"),
    templateMeta: document.getElementById("batch-template-meta"),
    file: document.getElementById("batch-file"),
    columns: document.getElementById("batch-columns"),
    summary: document.getElementById("batch-summary"),
    footerCopy: document.getElementById("batch-footer-copy"),
    submit: document.getElementById("batch-submit"),
  },
  settings: {
    cooldown: document.getElementById("cooldown"),
    maxRetries: document.getElementById("max-retries"),
    adaptiveRateLimit: document.getElementById("adaptive-rate-limit"),
    theme: document.getElementById("theme-mode"),
    autoDownload: document.getElementById("auto-download"),
    newThread: document.getElementById("new-thread"),
    saveState: document.getElementById("settings-save-state"),
    modeNote: document.getElementById("settings-mode-note"),
    bridgeSummary: document.getElementById("bridge-summary"),
  },
  toast: document.getElementById("toast"),
};

const state = {
  mode: "standalone",
  activeTab: "queue",
  createMode: "quick",
  queue: [],
  history: [],
  stats: { pending: 0, active: 0, completed: 0, failed: 0 },
  running: false,
  nextRunIn: 0,
  chatgptReady: false,
  chatgptOpen: false,
  templates: [],
  settings: {
    cooldown: 60,
    maxRetries: 3,
    adaptiveRateLimit: true,
    theme: "system",
    autoDownload: true,
    newThreadPerImage: true,
  },
  settingsSaveState: "idle",
  settingsLoaded: false,
  draft: createDefaultDraft(),
  toastTimer: null,
  settingsSaveTimer: null,
  settingsSaveToken: 0,
};

function createDefaultDraft() {
  return {
    quick: {
      prompt: "",
      project: "",
      templateId: "",
      values: {},
    },
    batch: {
      project: "",
      templateId: "",
      lines: "",
      csvFileName: "",
      csvHeaders: [],
      csvRows: [],
    },
  };
}

function isEnhancedMode() {
  return state.mode === "enhanced-ws";
}

function getActivePlatformName() {
  if (state.chatgptOpen) return "ChatGPT";
  return "";
}

function icon(name) {
  const icons = {
    queue: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M6 4H4V2H20V4H18V6C18 7.61543 17.1838 8.91468 16.1561 9.97667C15.4532 10.703 14.598 11.372 13.7309 12C14.598 12.628 15.4532 13.297 16.1561 14.0233C17.1838 15.0853 18 16.3846 18 18V20H20V22H4V20H6V18C6 16.3846 6.81616 15.0853 7.8439 14.0233C8.54682 13.297 9.40202 12.628 10.2691 12C9.40202 11.372 8.54682 10.703 7.8439 9.97667C6.81616 8.91468 6 7.61543 6 6V4ZM8 4V6C8 6.88457 8.43384 7.71032 9.2811 8.58583C10.008 9.33699 10.9548 10.0398 12 10.7781C13.0452 10.0398 13.992 9.33699 14.7189 8.58583C15.5662 7.71032 16 6.88457 16 6V4H8ZM12 13.2219C10.9548 13.9602 10.008 14.663 9.2811 15.4142C8.43384 16.2897 8 17.1154 8 18V20H16V18C16 17.1154 15.5662 16.2897 14.7189 15.4142C13.992 14.663 13.0452 13.9602 12 13.2219Z"></path></svg>',
    spark: '<svg stroke="currentColor" fill="none" stroke-width="1.9" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M12 3L13.8 8.2L19 10L13.8 11.8L12 17L10.2 11.8L5 10L10.2 8.2L12 3Z" stroke-linejoin="round"></path></svg>',
    plug: '<svg stroke="currentColor" fill="none" stroke-width="1.9" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M9 3V7M15 3V7M8 7H16V10C16 12.2091 14.2091 14 12 14C9.79086 14 8 12.2091 8 10V7ZM12 14V21" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    time: '<svg stroke="currentColor" fill="none" stroke-width="1.9" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8"></circle><path d="M12 8V12L15 14" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    add: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M11 11V5H13V11H19V13H13V19H11V13H5V11H11Z"></path></svg>',
    settings: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M3.33946 17.0002C2.90721 16.2515 2.58277 15.4702 2.36133 14.6741C3.3338 14.1779 3.99972 13.1668 3.99972 12.0002C3.99972 10.8345 3.3348 9.824 2.36353 9.32741C2.81025 7.71651 3.65857 6.21627 4.86474 4.99001C5.7807 5.58416 6.98935 5.65534 7.99972 5.072C9.01009 4.48866 9.55277 3.40635 9.4962 2.31604C11.1613 1.8846 12.8847 1.90004 14.5031 2.31862C14.4475 3.40806 14.9901 4.48912 15.9997 5.072C17.0101 5.65532 18.2187 5.58416 19.1346 4.99007C19.7133 5.57986 20.2277 6.25151 20.66 7.00021C21.0922 7.7489 21.4167 8.53025 21.6381 9.32628C20.6656 9.82247 19.9997 10.8336 19.9997 12.0002C19.9997 13.166 20.6646 14.1764 21.6359 14.673C21.1892 16.2839 20.3409 17.7841 19.1347 19.0104C18.2187 18.4163 17.0101 18.3451 15.9997 18.9284C14.9893 19.5117 14.4467 20.5941 14.5032 21.6844C12.8382 22.1158 11.1148 22.1004 9.49633 21.6818C9.55191 20.5923 9.00929 19.5113 7.99972 18.9284C6.98938 18.3451 5.78079 18.4162 4.86484 19.0103C4.28617 18.4205 3.77172 17.7489 3.33946 17.0002ZM8.99972 17.1964C10.0911 17.8265 10.8749 18.8227 11.2503 19.9659C11.7486 20.0133 12.2502 20.014 12.7486 19.9675C13.1238 18.8237 13.9078 17.8268 14.9997 17.1964C16.0916 16.5659 17.347 16.3855 18.5252 16.6324C18.8146 16.224 19.0648 15.7892 19.2729 15.334C18.4706 14.4373 17.9997 13.2604 17.9997 12.0002C17.9997 10.74 18.4706 9.5632 19.2729 8.6665C19.1688 8.4405 19.0538 8.21822 18.9279 8.00021C18.802 7.78219 18.667 7.57148 18.5233 7.36842C17.3457 7.61476 16.0911 7.43414 14.9997 6.80405C13.9083 6.17395 13.1246 5.17768 12.7491 4.03455C12.2509 3.98714 11.7492 3.98646 11.2509 4.03292C10.8756 5.17671 10.0916 6.17364 8.99972 6.80405C7.9078 7.43447 6.65245 7.61494 5.47428 7.36803C5.18485 7.77641 4.93463 8.21117 4.72656 8.66637C5.52881 9.56311 5.99972 10.74 5.99972 12.0002C5.99972 13.2604 5.52883 14.4372 4.72656 15.3339C4.83067 15.5599 4.94564 15.7822 5.07152 16.0002C5.19739 16.2182 5.3324 16.4289 5.47612 16.632C6.65377 16.3857 7.90838 16.5663 8.99972 17.1964ZM11.9997 15.0002C10.3429 15.0002 8.99972 13.6571 8.99972 12.0002C8.99972 10.3434 10.3429 9.00021 11.9997 9.00021C13.6566 9.00021 14.9997 10.3434 14.9997 12.0002C14.9997 13.6571 13.6566 15.0002 11.9997 15.0002ZM11.9997 13.0002C12.552 13.0002 12.9997 12.5525 12.9997 12.0002C12.9997 11.4479 12.552 11.0002 11.9997 11.0002C11.4474 11.0002 10.9997 11.4479 10.9997 12.0002C10.9997 12.5525 11.4474 13.0002 11.9997 13.0002Z"></path></svg>',
    refresh: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M5.46257 4.43262C7.21556 2.91688 9.5007 2 12 2C17.5228 2 22 6.47715 22 12C22 14.1361 21.3302 16.1158 20.1892 17.7406L17 12H20C20 7.58172 16.4183 4 12 4C9.84982 4 7.89777 4.84827 6.46023 6.22842L5.46257 4.43262ZM18.5374 19.5674C16.7844 21.0831 14.4993 22 12 22C6.47715 22 2 17.5228 2 12C2 9.86386 2.66979 7.88416 3.8108 6.25944L7 12H4C4 16.4183 7.58172 20 12 20C14.1502 20 16.1022 19.1517 17.5398 17.7716L18.5374 19.5674Z"></path></svg>',
    play: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M7.75194 5.43872L18.2596 11.5682C18.4981 11.7073 18.5787 12.0135 18.4396 12.252C18.3961 12.3265 18.3341 12.3885 18.2596 12.432L7.75194 18.5615C7.51341 18.7006 7.20725 18.62 7.06811 18.3815C7.0235 18.305 7 18.2181 7 18.1296V5.87061C7 5.59446 7.22386 5.37061 7.5 5.37061C7.58853 5.37061 7.67547 5.39411 7.75194 5.43872Z"></path></svg>',
    pause: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M15 7C15 6.44772 15.4477 6 16 6C16.5523 6 17 6.44772 17 7V17C17 17.5523 16.5523 18 16 18C15.4477 18 15 17.5523 15 17V7ZM7 7C7 6.44772 7.44772 6 8 6C8.55228 6 9 6.44772 9 7V17C9 17.5523 8.55228 18 8 18C7.44772 18 7 17.5523 7 17V7Z"></path></svg>',
    archive: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M20 3L22 7V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V7.00353L4 3H20ZM20 9H4V19H20V9ZM13 10V14H16L12 18L8 14H11V10H13ZM18.7639 5H5.23656L4.23744 7H19.7639L18.7639 5Z"></path></svg>',
    "arrow-up": '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M13.0001 7.82843V20H11.0001V7.82843L5.63614 13.1924L4.22192 11.7782L12.0001 4L19.7783 11.7782L18.3641 13.1924L13.0001 7.82843Z"></path></svg>',
    "file-upload": '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M15 4H5V20H19V8H15V4ZM3 2.9918C3 2.44405 3.44749 2 3.9985 2H16L20.9997 7L21 20.9925C21 21.5489 20.5551 22 20.0066 22H3.9934C3.44476 22 3 21.5447 3 21.0082V2.9918ZM13 12V16H11V12H8L12 8L16 12H13Z"></path></svg>',
    duplicate: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M6.9998 6V3C6.9998 2.44772 7.44752 2 7.9998 2H19.9998C20.5521 2 20.9998 2.44772 20.9998 3V17C20.9998 17.5523 20.5521 18 19.9998 18H16.9998V20.9991C16.9998 21.5519 16.5499 22 15.993 22H4.00666C3.45059 22 3 21.5554 3 20.9991L3.0026 7.00087C3.0027 6.44811 3.45264 6 4.00942 6H6.9998ZM5.00242 8L5.00019 20H14.9998V8H5.00242ZM8.9998 6H16.9998V16H18.9998V4H8.9998V6Z"></path></svg>',
    delete: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M17 6H22V8H20V21C20 21.5523 19.5523 22 19 22H5C4.44772 22 4 21.5523 4 21V8H2V6H7V3C7 2.44772 7.44772 2 8 2H16C16.5523 2 17 2.44772 17 3V6ZM18 8H6V20H18V8ZM9 11H11V17H9V11ZM13 11H15V17H13V11ZM9 4V6H15V4H9Z"></path></svg>',
    retry: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M18.5374 19.5674C16.7844 21.0831 14.4993 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 14.1361 21.3302 16.1158 20.1892 17.7406L17 12H20C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C14.1502 20 16.1022 19.1517 17.5398 17.7716L18.5374 19.5674Z"></path></svg>',
    resubmit: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M13.0001 7.82843V20H11.0001V7.82843L5.63614 13.1924L4.22192 11.7782L12.0001 4L19.7783 11.7782L18.3641 13.1924L13.0001 7.82843Z"></path></svg>',
    cancel: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM9 9H15V15H9V9Z"></path></svg>',
    file: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="ui-icon" aria-hidden="true" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M19 22H5C3.34315 22 2 20.6569 2 19V3C2 2.44772 2.44772 2 3 2H17C17.5523 2 18 2.44772 18 3V15H22V19C22 20.6569 20.6569 22 19 22ZM18 17V19C18 19.5523 18.4477 20 19 20C19.5523 20 20 19.5523 20 19V17H18ZM16 20V4H4V19C4 19.5523 4.44772 20 5 20H16ZM6 7H14V9H6V7ZM6 11H14V13H6V11ZM6 15H11V17H6V15Z"></path></svg>',
  };
  return icons[name] || "";
}

function hydrateStaticIcons() {
  document.querySelectorAll("[data-icon]").forEach((node) => {
    const name = node.getAttribute("data-icon");
    node.innerHTML = name ? icon(name) : "";
  });
}

function normalizeTemplate(template = {}) {
  return {
    id: String(template.id || ""),
    name: String(template.name || "Untitled template"),
    description: String(template.description || ""),
    body: String(template.body || ""),
    variables: Array.isArray(template.variables) ? cloneJson(template.variables) : [],
  };
}

function prettifyKey(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseTemplateVariables(template) {
  if (!template) return [];

  const variables = new Map();
  for (const variable of template.variables || []) {
    const key = String(variable.key || "").trim();
    if (!key) continue;
    variables.set(key, {
      key,
      label: String(variable.label || prettifyKey(key)),
      defaultValue: String(variable.defaultValue || ""),
      required: Boolean(variable.required),
    });
  }

  const matches = String(template.body || "").matchAll(/\{([^}]+)\}/g);
  for (const match of matches) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;
    const [rawKey, ...defaultParts] = raw.split("=");
    const key = rawKey.trim();
    if (!key) continue;
    const defaultValue = defaultParts.join("=").trim();
    const existing = variables.get(key) || {
      key,
      label: prettifyKey(key),
      defaultValue: "",
      required: true,
    };
    variables.set(key, {
      key,
      label: existing.label || prettifyKey(key),
      defaultValue: defaultValue || existing.defaultValue || "",
      required: defaultValue ? false : existing.required !== false,
    });
  }

  return Array.from(variables.values());
}

function resolveTemplatePrompt(template, values) {
  if (!template) {
    return { valid: false, prompt: "", reason: "Choose a template first.", values: {} };
  }

  const variables = parseTemplateVariables(template);
  const missing = [];
  const resolvedValues = {};

  for (const variable of variables) {
    const resolved = String(values?.[variable.key] ?? variable.defaultValue ?? "").trim();
    resolvedValues[variable.key] = resolved;
    if (variable.required && !resolved) {
      missing.push(variable.label || variable.key);
    }
  }

  if (missing.length > 0) {
    return { valid: false, prompt: "", reason: `Missing required fields: ${missing.join(", ")}`, values: resolvedValues };
  }

  const prompt = String(template.body || "")
    .replace(/\{([^}]+)\}/g, (_, raw) => {
      const key = String(raw || "").split("=")[0].trim();
      return resolvedValues[key] ?? "";
    })
    .trim();

  if (!prompt) {
    return { valid: false, prompt: "", reason: "Resolved prompt is empty.", values: resolvedValues };
  }

  return { valid: true, prompt, reason: "", values: resolvedValues };
}

function mergeDraft(rawDraft) {
  const base = createDefaultDraft();
  const draft = rawDraft && typeof rawDraft === "object" ? rawDraft : {};
  return {
    quick: {
      prompt: typeof draft.quick?.prompt === "string" ? draft.quick.prompt : base.quick.prompt,
      project: typeof draft.quick?.project === "string" ? draft.quick.project : base.quick.project,
      templateId: typeof draft.quick?.templateId === "string" ? draft.quick.templateId : base.quick.templateId,
      values: draft.quick?.values && typeof draft.quick.values === "object" ? cloneJson(draft.quick.values) : {},
    },
    batch: {
      project: typeof draft.batch?.project === "string" ? draft.batch.project : base.batch.project,
      templateId: typeof draft.batch?.templateId === "string" ? draft.batch.templateId : base.batch.templateId,
      lines: typeof draft.batch?.lines === "string" ? draft.batch.lines : base.batch.lines,
      csvFileName: typeof draft.batch?.csvFileName === "string" ? draft.batch.csvFileName : "",
      csvHeaders: Array.isArray(draft.batch?.csvHeaders) ? cloneJson(draft.batch.csvHeaders) : [],
      csvRows: Array.isArray(draft.batch?.csvRows) ? cloneJson(draft.batch.csvRows) : [],
    },
  };
}

async function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function showToast(message) {
  refs.toast.textContent = message;
  refs.toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => refs.toast.classList.remove("visible"), 2200);
}

function applyTheme(theme) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
  document.documentElement.dataset.theme = resolved;
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tab}`);
  });
}

function setCreateMode(mode) {
  state.createMode = mode;
  document.querySelectorAll(".segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.createMode === mode);
  });
  document.querySelectorAll(".subpanel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `create-${mode}`);
  });
}

function setSettingsSaveState(nextState) {
  state.settingsSaveState = nextState;
  refs.settings.saveState.className = `status-pill thin save-state ${nextState}`;
  refs.settings.saveState.querySelector(".status-text").textContent = SAVE_STATE_LABELS[nextState] || SAVE_STATE_LABELS.idle;
}

function renderConnectionStatus() {
  refs.connectionStatus.className = `status-pill ${isEnhancedMode() ? "connected" : "disconnected"}`;
  const bridgeLabel = isEnhancedMode() ? "Desktop bridge connected" : "Desktop bridge offline";
  refs.connectionStatus.innerHTML = `
    <span class="topbar-status-icon" aria-hidden="true" title="${escapeHtml(bridgeLabel)}">${icon("plug")}</span>
  `;
  refs.connectionStatus.title = bridgeLabel;
  refs.connectionStatus.setAttribute("aria-label", bridgeLabel);
}

function renderChatGPTStatus() {
  const activePlatform = getActivePlatformName();
  refs.chatgptStatus.className = `footer-status ${activePlatform ? "ready" : "disconnected"}`;
  const providerLabel = activePlatform || "No provider";
  refs.chatgptStatus.innerHTML = `
    <span>${escapeHtml(providerLabel)}</span>
  `;
  refs.chatgptStatus.title = activePlatform ? `${activePlatform} is active` : "No provider is active";
  refs.chatgptStatus.setAttribute("aria-label", refs.chatgptStatus.title);
}

function renderQueueStrip() {
  const items = [
    { label: "Scheduler", value: state.running ? "Running" : "Paused", tone: state.running ? "good" : "bad", iconName: "play" },
    { label: "Next run", value: state.nextRunIn > 0 ? formatCountdown(state.nextRunIn) : "Now", tone: state.nextRunIn > 0 ? "warn" : "good", iconName: "time" },
  ];
  refs.queueStrip.innerHTML = items
    .map((item) => {
      const tooltip = `${item.label}: ${item.value}`;
      return `<span class="status-badge status-badge-icon tone-${item.tone}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}"><span class="topbar-status-icon" aria-hidden="true">${icon(item.iconName)}</span></span>`;
    })
    .join("");
}

function renderQueueStats() {
  const items = [
    { label: "Pending", value: state.stats.pending },
    { label: "Active", value: state.stats.active },
    { label: "Done", value: state.stats.completed },
    { label: "Failed", value: state.stats.failed },
  ];
  refs.queueStats.innerHTML = items
    .map((item) => `<span class="stats-pill"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(String(item.value))}</strong></span>`)
    .join("");

  refs.btnStart.disabled = state.running;
  refs.btnPause.disabled = !state.running;
  refs.btnArchive.disabled = state.stats.completed + state.stats.failed === 0;
}

function getJobTimestamp(job, ...keys) {
  return firstMeaningfulTimestamp(...keys.map((key) => job?.[key]));
}

function buildJobMeta(job) {
  const parts = [];
  if (job.metadata?.project) parts.push(job.metadata.project);
  parts.push(getSourceLabel(job.metadata));
  parts.push(formatRelativeTime(getJobTimestamp(job, "started_at", "startedAt", "scheduled_at", "scheduledAt", "created_at", "createdAt")));
  return parts.join(" • ");
}

function actionButton(iconName, label, action, jobId) {
  return `<button class="job-action" type="button" data-job-action="${action}" data-job-id="${escapeHtml(jobId)}" title="${escapeHtml(label)}">${icon(iconName)}</button>`;
}

function renderJobList(container, jobs, emptyTitle, emptyCopy, kind) {
  if (!jobs.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>${escapeHtml(emptyTitle)}</strong>
        <span>${escapeHtml(emptyCopy)}</span>
      </div>
    `;
    return;
  }

  container.innerHTML = jobs
    .map((job) => {
      const status = getStatusView(job.status);
      const actions = [];
      if (kind === "history") {
        actions.push(actionButton("resubmit", "Queue again", "history-resubmit", job.id));
        actions.push(actionButton("duplicate", "Copy to quick", "history-duplicate", job.id));
      } else {
        if (job.status === "pending") actions.push(actionButton("delete", "Delete job", "delete", job.id));
        if (job.status === "failed") actions.push(actionButton("retry", "Retry job", "retry", job.id));
        if (["scheduled", "in_progress"].includes(job.status) && isEnhancedMode()) {
          actions.push(actionButton("cancel", "Cancel job", "cancel", job.id));
        }
        actions.push(actionButton("duplicate", "Copy to quick", "duplicate", job.id));
      }

      return `
        <article class="${kind === "history" ? "history-row" : "job-row"}">
          <div class="job-main">
            <div class="job-title-row">
              <h4 class="job-title">${escapeHtml(summarizePrompt(job.prompt, 84))}</h4>
              <span class="status-chip ${status.tone}">${escapeHtml(status.label)}</span>
            </div>
            <div class="job-meta-row">
              <span class="source-pill">${escapeHtml(getSourceLabel(job.metadata))}</span>
              ${job.metadata?.templateName ? `<span class="meta-chip">${escapeHtml(job.metadata.templateName)}</span>` : ""}
              ${job.metadata?.project ? `<span class="meta-chip">${escapeHtml(job.metadata.project)}</span>` : ""}
            </div>
            <div class="job-meta">${escapeHtml(kind === "history" ? formatRelativeTime(getJobTimestamp(job, "archived_at", "archivedAt", "completed_at", "completedAt", "created_at", "createdAt")) : buildJobMeta(job))}</div>
            ${job.error ? `<div class="job-meta">${escapeHtml(job.error)}</div>` : ""}
          </div>
          <div class="job-actions">${actions.join("")}</div>
        </article>
      `;
    })
    .join("");
}

function renderQueuePanels() {
  const activeJobs = state.queue.filter((job) => ["scheduled", "in_progress"].includes(job.status));
  const backlogJobs = state.queue.filter((job) => !["scheduled", "in_progress"].includes(job.status));

  refs.activeCount.textContent = String(activeJobs.length);
  refs.backlogCount.textContent = String(backlogJobs.length);
  refs.historyCount.textContent = String(state.history.length);

  renderJobList(refs.activeList, activeJobs, "Nothing running", "Start the scheduler or queue a new prompt to kick work off.", "active");
  renderJobList(refs.backlogList, backlogJobs, "Queue is clear", "Quick and batch prompts will land here when they are waiting to run.", "backlog");
  renderJobList(refs.historyList, state.history, "No recent history", "Archived or completed work will appear here.", "history");
}

function getTemplateById(templateId) {
  return state.templates.find((template) => template.id === templateId) || null;
}

function buildTemplateOptions(selectedId) {
  const options = ['<option value="">Write prompts manually</option>'];
  for (const template of state.templates) {
    options.push(`<option value="${escapeHtml(template.id)}" ${template.id === selectedId ? "selected" : ""}>${escapeHtml(template.name)}</option>`);
  }
  return options.join("");
}

function syncDraftTemplateValues(slotName) {
  const slot = state.draft[slotName];
  const template = getTemplateById(slot.templateId);
  if (!template) {
    slot.values = {};
    return;
  }

  const nextValues = {};
  for (const variable of parseTemplateVariables(template)) {
    nextValues[variable.key] = String(slot.values?.[variable.key] ?? variable.defaultValue ?? "");
  }
  slot.values = nextValues;
}

function renderCreate() {
  refs.quick.template.innerHTML = buildTemplateOptions(state.draft.quick.templateId);
  refs.batch.template.innerHTML = buildTemplateOptions(state.draft.batch.templateId);
  refs.quick.project.value = state.draft.quick.project;
  refs.quick.prompt.value = state.draft.quick.prompt;
  refs.batch.project.value = state.draft.batch.project;
  refs.batch.lines.value = state.draft.batch.lines;
  renderQuickComposer();
  renderBatchComposer();
}

function renderQuickComposer() {
  syncDraftTemplateValues("quick");
  const template = getTemplateById(state.draft.quick.templateId);
  const usingTemplate = Boolean(template);
  refs.quick.manualGroup.classList.toggle("hidden", usingTemplate);
  refs.quick.templateGroup.classList.toggle("hidden", !usingTemplate);

  if (!usingTemplate) {
    const hasPrompt = state.draft.quick.prompt.trim().length > 0;
    refs.quick.summary.textContent = hasPrompt ? "One prompt will be queued." : "Manual prompt mode.";
    refs.quick.submit.disabled = !hasPrompt;
    refs.quick.templateFields.innerHTML = "";
    refs.quick.preview.className = "preview-box hidden";
    refs.quick.preview.textContent = "";
    return;
  }

  const variables = parseTemplateVariables(template);
  refs.quick.templateMeta.innerHTML = `
    <strong>${escapeHtml(template.name)}</strong>
    ${template.description ? `<div>${escapeHtml(template.description)}</div>` : ""}
  `;
  refs.quick.templateFields.innerHTML = variables.length
    ? variables.map((variable) => `
      <label class="field">
        <span>${escapeHtml(variable.label || variable.key)}${variable.required ? "" : " (optional)"}</span>
        <input
          type="text"
          data-quick-var="${escapeHtml(variable.key)}"
          value="${escapeHtml(state.draft.quick.values?.[variable.key] ?? variable.defaultValue ?? "")}"
          placeholder="${escapeHtml(variable.defaultValue || "")}">
      </label>
    `).join("")
    : '<div class="muted-copy">This template has no placeholders. Queueing will use the body as-is.</div>';

  const preview = resolveTemplatePrompt(template, state.draft.quick.values);
  refs.quick.preview.className = `preview-box ${preview.valid ? "success" : "error"}`;
  refs.quick.preview.innerHTML = preview.valid
    ? `<strong>Preview</strong><div>${escapeHtml(preview.prompt)}</div>`
    : `<strong>Needs input</strong><div>${escapeHtml(preview.reason)}</div>`;
  refs.quick.summary.textContent = preview.valid ? "Template resolved and ready to queue." : preview.reason;
  refs.quick.submit.disabled = !preview.valid;
}

function getMissingBatchColumns(template) {
  const headers = new Set((state.draft.batch.csvHeaders || []).map((header) => String(header).trim().toLowerCase()));
  const variables = parseTemplateVariables(template).filter((variable) => variable.required);
  return variables.map((variable) => variable.key).filter((key) => !headers.has(String(key).toLowerCase()));
}

function renderBatchComposer() {
  const template = getTemplateById(state.draft.batch.templateId);
  const usingTemplate = Boolean(template);
  refs.batch.manualGroup.classList.toggle("hidden", usingTemplate);
  refs.batch.templateGroup.classList.toggle("hidden", !usingTemplate);

  if (!usingTemplate) {
    const count = state.draft.batch.lines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
    refs.batch.footerCopy.textContent = count > 0 ? `${count} prompt${count === 1 ? "" : "s"} ready from manual lines.` : "Each non-empty line becomes one queued job.";
    refs.batch.submit.disabled = count === 0;
    refs.batch.columns.innerHTML = "";
    refs.batch.summary.className = "preview-box hidden";
    refs.batch.summary.textContent = "";
    refs.batch.file.value = "";
    return;
  }

  const variables = parseTemplateVariables(template);
  const missingKeys = getMissingBatchColumns(template);
  const rowCount = state.draft.batch.csvRows.length;

  refs.batch.templateMeta.innerHTML = `
    <strong>${escapeHtml(template.name)}</strong>
    <div>CSV column names should match template keys. Optional <code>project</code> overrides the batch project.</div>
  `;
  refs.batch.columns.innerHTML = variables
    .map((variable) => `<span class="chip">${escapeHtml(variable.key)}${variable.required ? "" : `=${escapeHtml(variable.defaultValue || "")}`}</span>`)
    .join("");
  refs.batch.summary.className = `preview-box ${rowCount === 0 || missingKeys.length > 0 ? "error" : "success"}`;
  refs.batch.summary.innerHTML = rowCount === 0
    ? `${icon("file")} <span>Load a CSV file to queue template rows.</span>`
    : missingKeys.length > 0
      ? `<strong>CSV needs columns</strong><div>${escapeHtml(missingKeys.join(", "))}</div>`
      : `<strong>${rowCount} row${rowCount === 1 ? "" : "s"} loaded</strong><div>${escapeHtml(state.draft.batch.csvFileName || "CSV ready to queue")}</div>`;
  refs.batch.footerCopy.textContent = rowCount > 0 ? `${rowCount} CSV row${rowCount === 1 ? "" : "s"} ready to resolve.` : "Select a template and import CSV rows keyed by template placeholders.";
  refs.batch.submit.disabled = rowCount === 0 || missingKeys.length > 0;
}

function renderSettings() {
  refs.settings.cooldown.value = String(state.settings.cooldown ?? 60);
  refs.settings.maxRetries.value = String(state.settings.maxRetries ?? 3);
  refs.settings.adaptiveRateLimit.checked = state.settings.adaptiveRateLimit !== false;
  refs.settings.theme.value = state.settings.theme || "system";
  refs.settings.autoDownload.checked = state.settings.autoDownload !== false;
  refs.settings.newThread.checked = Boolean(state.settings.newThreadPerImage);
  refs.settings.modeNote.textContent = isEnhancedMode()
    ? "Shared queue pacing and theme save to the desktop app. Browser-only toggles stay local to the extension."
    : "All settings save locally in the extension while you run without the desktop bridge.";
  const activePlatform = getActivePlatformName();
  refs.settings.bridgeSummary.innerHTML = `
    <div class="bridge-summary-row"><span>Mode</span><strong>${escapeHtml(isEnhancedMode() ? "Desktop bridge" : "Standalone")}</strong></div>
    <div class="bridge-summary-row"><span>Platform</span><strong>${escapeHtml(activePlatform ? `${activePlatform} active` : "No platform active")}</strong></div>
    <div class="bridge-summary-row"><span>Scheduler</span><strong>${escapeHtml(state.running ? "Running" : "Paused")}</strong></div>
    <div class="bridge-summary-row"><span>Next run</span><strong>${escapeHtml(formatCountdown(state.nextRunIn))}</strong></div>
  `;
  applyTheme(state.settings.theme || "system");
}

function collectSettingsFromForm() {
  return {
    cooldown: Math.max(0, Number(refs.settings.cooldown.value || 60)),
    maxRetries: Math.max(0, Number(refs.settings.maxRetries.value || 3)),
    adaptiveRateLimit: refs.settings.adaptiveRateLimit.checked,
    theme: refs.settings.theme.value || "system",
    autoDownload: refs.settings.autoDownload.checked,
    newThreadPerImage: refs.settings.newThread.checked,
  };
}

async function saveSettingsNow() {
  const token = ++state.settingsSaveToken;
  const nextSettings = collectSettingsFromForm();
  setSettingsSaveState("saving");

  try {
    await sendMessage("save_settings", { settings: nextSettings });
    if (isEnhancedMode()) {
      await fetchJson("/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cooldown_seconds: nextSettings.cooldown,
          max_retries: nextSettings.maxRetries,
          adaptive_rate_limit: nextSettings.adaptiveRateLimit,
          theme: nextSettings.theme,
        }),
      });
    }

    const confirmedLocal = await sendMessage("get_settings");
    let confirmed = {
      cooldown: confirmedLocal.cooldown ?? nextSettings.cooldown,
      maxRetries: confirmedLocal.maxRetries ?? nextSettings.maxRetries,
      adaptiveRateLimit: confirmedLocal.adaptiveRateLimit ?? nextSettings.adaptiveRateLimit,
      theme: confirmedLocal.theme ?? nextSettings.theme,
      autoDownload: confirmedLocal.autoDownload !== false,
      newThreadPerImage: Boolean(confirmedLocal.newThreadPerImage),
    };

    if (isEnhancedMode()) {
      const config = await fetchJson("/config");
      confirmed = {
        ...confirmed,
        cooldown: config.cooldown_seconds ?? confirmed.cooldown,
        maxRetries: config.max_retries ?? confirmed.maxRetries,
        adaptiveRateLimit: config.adaptive_rate_limit ?? confirmed.adaptiveRateLimit,
        theme: config.theme ?? confirmed.theme,
      };
    }

    if (token !== state.settingsSaveToken) return;
    state.settings = confirmed;
    renderSettings();
    setSettingsSaveState("saved");
  } catch (error) {
    console.error("[PixelQ] Failed to save settings", error);
    if (token !== state.settingsSaveToken) return;
    setSettingsSaveState("error");
    showToast("Settings save failed");
  }
}

function queueSettingsSave() {
  if (!state.settingsLoaded) return;
  state.settings = collectSettingsFromForm();
  applyTheme(state.settings.theme || "system");
  setSettingsSaveState("idle");
  clearTimeout(state.settingsSaveTimer);
  state.settingsSaveTimer = setTimeout(saveSettingsNow, 320);
}

async function detectMode() {
  try {
    const response = await fetch(`${API_BASE}/status`, { signal: AbortSignal.timeout(1000) });
    state.mode = response.ok ? "enhanced-ws" : "standalone";
  } catch {
    state.mode = "standalone";
  }
}

function hydrateStandaloneState(data) {
  state.queue = Array.isArray(data.jobs) ? data.jobs : [];
  state.history = Array.isArray(data.history) ? data.history : [];
  state.stats = data.stats || state.stats;
  state.running = Boolean(data.running);
  state.nextRunIn = Number(data.nextRunIn || 0);
  state.chatgptReady = Boolean(data.chatgptReady);
  state.chatgptOpen = Boolean(data.chatgptOpen ?? data.chatgptReady);
}

function hydrateEnhancedState(status, jobs, historyData) {
  state.queue = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
  state.history = Array.isArray(historyData?.jobs) ? historyData.jobs : [];
  state.stats = {
    pending: status.counts?.pending || 0,
    active: (status.counts?.scheduled || 0) + (status.counts?.in_progress || 0),
    completed: status.counts?.completed || 0,
    failed: status.counts?.failed || 0,
  };
  state.running = Boolean(status.running);
  state.nextRunIn = Number(status.next_run_in || 0);
  state.chatgptReady = Boolean(status.extension_ready);
  state.chatgptOpen = Boolean(status.extension_ready || status.extension_tab_url);
}

async function refresh() {
  if (isEnhancedMode()) {
    try {
      const [status, jobs, historyData] = await Promise.all([
        fetchJson("/status"),
        fetchJson("/jobs?limit=50"),
        fetchJson("/history?limit=20"),
      ]);
      hydrateEnhancedState(status, jobs, historyData);
    } catch (error) {
      console.warn("[PixelQ] Desktop bridge refresh failed, falling back to standalone", error);
      state.mode = "standalone";
      const data = await sendMessage("get_state");
      hydrateStandaloneState(data || {});
    }
  } else {
    const data = await sendMessage("get_state");
    hydrateStandaloneState(data || {});
  }

  renderConnectionStatus();
  renderChatGPTStatus();
  renderQueueStrip();
  renderQueueStats();
  renderQueuePanels();
  renderSettings();
}

async function refreshTemplates() {
  try {
    const collection = isEnhancedMode()
      ? (await fetchJson("/templates")).templates || []
      : await loadTemplates();
    state.templates = Array.isArray(collection) ? collection.map(normalizeTemplate) : [];
  } catch (error) {
    console.warn("[PixelQ] Failed to load templates", error);
    state.templates = [];
  }

  if (state.draft.quick.templateId && !getTemplateById(state.draft.quick.templateId)) {
    state.draft.quick.templateId = "";
    state.draft.quick.values = {};
  }
  if (state.draft.batch.templateId && !getTemplateById(state.draft.batch.templateId)) {
    state.draft.batch.templateId = "";
    state.draft.batch.csvFileName = "";
    state.draft.batch.csvHeaders = [];
    state.draft.batch.csvRows = [];
  }

  renderCreate();
}

async function loadSettings() {
  const localSettings = await sendMessage("get_settings");
  if (isEnhancedMode()) {
    try {
      const config = await fetchJson("/config");
      state.settings = {
        cooldown: config.cooldown_seconds ?? localSettings.cooldown ?? 60,
        maxRetries: config.max_retries ?? localSettings.maxRetries ?? 3,
        adaptiveRateLimit: config.adaptive_rate_limit ?? localSettings.adaptiveRateLimit ?? true,
        theme: config.theme ?? localSettings.theme ?? "system",
        autoDownload: localSettings.autoDownload !== false,
        newThreadPerImage: Boolean(localSettings.newThreadPerImage),
      };
    } catch {
      state.settings = {
        cooldown: localSettings.cooldown ?? 60,
        maxRetries: localSettings.maxRetries ?? 3,
        adaptiveRateLimit: localSettings.adaptiveRateLimit ?? true,
        theme: localSettings.theme ?? "system",
        autoDownload: localSettings.autoDownload !== false,
        newThreadPerImage: Boolean(localSettings.newThreadPerImage),
      };
    }
  } else {
    state.settings = {
      cooldown: localSettings.cooldown ?? 60,
      maxRetries: localSettings.maxRetries ?? 3,
      adaptiveRateLimit: localSettings.adaptiveRateLimit ?? true,
      theme: localSettings.theme ?? "system",
      autoDownload: localSettings.autoDownload !== false,
      newThreadPerImage: Boolean(localSettings.newThreadPerImage),
    };
  }

  renderSettings();
  state.settingsLoaded = true;
  setSettingsSaveState("idle");
}

async function persistDraft() {
  await savePopupDraft(state.draft);
}

function seedQuickDraft(job) {
  state.draft.quick = {
    prompt: job.prompt || "",
    project: job.metadata?.project || "",
    templateId: "",
    values: {},
  };
  setActiveTab("create");
  setCreateMode("quick");
  renderCreate();
  persistDraft();
}

async function queueJobs(items) {
  if (isEnhancedMode()) {
    await fetchJson("/jobs/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs: items }),
    });
  } else {
    await sendMessage("add_jobs", { jobs: items });
  }
  await refresh();
}

async function submitQuick() {
  const project = state.draft.quick.project.trim();
  const template = getTemplateById(state.draft.quick.templateId);
  if (!template) {
    const prompt = state.draft.quick.prompt.trim();
    if (!prompt) {
      showToast("Add a prompt first");
      return;
    }
    await queueJobs([{ prompt, priority: 1, metadata: normalizeMetadata({ source: "manual", project }) }]);
    state.draft.quick.prompt = "";
    await persistDraft();
    renderCreate();
    showToast("Prompt queued");
    return;
  }

  const resolved = resolveTemplatePrompt(template, state.draft.quick.values);
  if (!resolved.valid) {
    showToast(resolved.reason);
    return;
  }

  await queueJobs([{
    prompt: resolved.prompt,
    priority: 1,
    metadata: normalizeMetadata({
      source: "template",
      project,
      templateId: template.id,
      templateName: template.name,
      variables: resolved.values,
    }),
  }]);

  state.draft.quick.values = {};
  await persistDraft();
  renderCreate();
  showToast("Template prompt queued");
}

function getBatchTemplateRowValue(row, key) {
  const direct = row[key];
  if (direct !== undefined && direct !== null) return String(direct).trim();
  const matched = Object.keys(row).find((column) => String(column).trim().toLowerCase() === String(key).trim().toLowerCase());
  return matched ? String(row[matched] || "").trim() : "";
}

async function submitBatch() {
  const project = state.draft.batch.project.trim();
  const template = getTemplateById(state.draft.batch.templateId);

  if (!template) {
    const prompts = state.draft.batch.lines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!prompts.length) {
      showToast("Add at least one prompt line");
      return;
    }
    await queueJobs(prompts.map((prompt, index) => ({
      prompt,
      priority: prompts.length - index,
      metadata: normalizeMetadata({ source: "manual", project }),
    })));
    state.draft.batch.lines = "";
    await persistDraft();
    renderCreate();
    showToast(`${prompts.length} prompt${prompts.length === 1 ? "" : "s"} queued`);
    return;
  }

  if (!state.draft.batch.csvRows.length) {
    showToast("Load a CSV file first");
    return;
  }

  const queued = [];
  const errors = [];
  for (const [index, row] of state.draft.batch.csvRows.entries()) {
    const values = {};
    for (const variable of parseTemplateVariables(template)) {
      values[variable.key] = getBatchTemplateRowValue(row, variable.key) || variable.defaultValue || "";
    }
    const resolved = resolveTemplatePrompt(template, values);
    if (!resolved.valid) {
      errors.push(`Row ${index + 1}: ${resolved.reason}`);
      continue;
    }
    queued.push({
      prompt: resolved.prompt,
      priority: state.draft.batch.csvRows.length - index,
      metadata: normalizeMetadata({
        source: "csv",
        project: getBatchTemplateRowValue(row, "project") || project,
        templateId: template.id,
        templateName: template.name,
        variables: resolved.values,
      }),
    });
  }

  if (!queued.length) {
    showToast(errors[0] || "No CSV rows were ready");
    return;
  }

  await queueJobs(queued);
  state.draft.batch.csvFileName = "";
  state.draft.batch.csvHeaders = [];
  state.draft.batch.csvRows = [];
  refs.batch.file.value = "";
  await persistDraft();
  renderCreate();
  showToast(`${queued.length} CSV row${queued.length === 1 ? "" : "s"} queued`);
}

async function startQueue() {
  if (isEnhancedMode()) {
    await fetchJson("/scheduler/start", { method: "POST" });
  } else {
    await sendMessage("start");
  }
  await refresh();
}

async function pauseQueue() {
  if (isEnhancedMode()) {
    await fetchJson("/scheduler/pause", { method: "POST" });
  } else {
    await sendMessage("pause");
  }
  await refresh();
}

async function archiveCompleted() {
  if (isEnhancedMode()) {
    await fetchJson("/jobs/archive-completed", { method: "POST" });
  } else {
    await sendMessage("archive_completed");
  }
  await refresh();
  showToast("Archived completed work");
}

async function deleteQueuedJob(jobId) {
  if (isEnhancedMode()) {
    await fetchJson(`/jobs/${jobId}`, { method: "DELETE" });
  } else {
    await sendMessage("delete_job", { id: jobId });
  }
  await refresh();
}

async function cancelQueuedJob(jobId) {
  if (!isEnhancedMode()) return;
  await fetchJson(`/jobs/${jobId}/cancel`, { method: "POST" });
  await refresh();
}

async function retryQueuedJob(jobId) {
  if (isEnhancedMode()) {
    await fetchJson(`/jobs/${jobId}/retry`, { method: "POST" });
  } else {
    await sendMessage("retry_job", { id: jobId });
  }
  await refresh();
}

async function resubmitArchivedJob(jobId) {
  const job = state.history.find((item) => item.id === jobId);
  if (!job) return;
  await queueJobs([{ prompt: job.prompt, priority: 1, metadata: normalizeMetadata(job.metadata || { source: "manual", project: job.metadata?.project || "" }) }]);
  showToast("Job queued again");
}

async function handleBatchFileSelection(file) {
  if (!file) {
    state.draft.batch.csvFileName = "";
    state.draft.batch.csvHeaders = [];
    state.draft.batch.csvRows = [];
    await persistDraft();
    renderBatchComposer();
    return;
  }

  try {
    const parsed = parseCSV(await file.text());
    state.draft.batch.csvFileName = file.name;
    state.draft.batch.csvHeaders = parsed.headers || [];
    state.draft.batch.csvRows = parsed.rows || [];
    await persistDraft();
    renderBatchComposer();
  } catch (error) {
    console.error("[PixelQ] Failed to parse CSV", error);
    showToast("CSV could not be parsed");
  }
}

async function handleJobActionClick(event) {
  const button = event.target.closest("[data-job-action]");
  if (!button) return;
  const action = button.dataset.jobAction;
  const jobId = button.dataset.jobId;
  const sourceJob = state.queue.find((item) => item.id === jobId) || state.history.find((item) => item.id === jobId);
  if (!sourceJob) return;

  if (action === "delete") await deleteQueuedJob(jobId);
  if (action === "cancel") await cancelQueuedJob(jobId);
  if (action === "retry") await retryQueuedJob(jobId);
  if (action === "duplicate") seedQuickDraft(sourceJob);
  if (action === "history-resubmit") await resubmitArchivedJob(jobId);
  if (action === "history-duplicate") seedQuickDraft(sourceJob);
}

function bindStaticEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });
  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => setCreateMode(button.dataset.createMode));
  });

  refs.btnRefresh.addEventListener("click", refresh);
  refs.btnStart.addEventListener("click", startQueue);
  refs.btnPause.addEventListener("click", pauseQueue);
  refs.btnArchive.addEventListener("click", archiveCompleted);
  refs.activeList.addEventListener("click", handleJobActionClick);
  refs.backlogList.addEventListener("click", handleJobActionClick);
  refs.historyList.addEventListener("click", handleJobActionClick);

  refs.quick.project.addEventListener("input", async () => {
    state.draft.quick.project = refs.quick.project.value;
    await persistDraft();
  });
  refs.quick.template.addEventListener("change", async () => {
    state.draft.quick.templateId = refs.quick.template.value;
    syncDraftTemplateValues("quick");
    await persistDraft();
    renderQuickComposer();
  });
  refs.quick.prompt.addEventListener("input", async () => {
    state.draft.quick.prompt = refs.quick.prompt.value;
    await persistDraft();
    renderQuickComposer();
  });
  refs.quick.templateFields.addEventListener("input", async (event) => {
    const input = event.target.closest("[data-quick-var]");
    if (!input) return;
    state.draft.quick.values[input.dataset.quickVar] = input.value;
    await persistDraft();
    renderQuickComposer();
  });
  refs.quick.submit.addEventListener("click", submitQuick);

  refs.batch.project.addEventListener("input", async () => {
    state.draft.batch.project = refs.batch.project.value;
    await persistDraft();
  });
  refs.batch.template.addEventListener("change", async () => {
    state.draft.batch.templateId = refs.batch.template.value;
    if (!state.draft.batch.templateId) {
      state.draft.batch.csvFileName = "";
      state.draft.batch.csvHeaders = [];
      state.draft.batch.csvRows = [];
      refs.batch.file.value = "";
    }
    await persistDraft();
    renderBatchComposer();
  });
  refs.batch.lines.addEventListener("input", async () => {
    state.draft.batch.lines = refs.batch.lines.value;
    await persistDraft();
    renderBatchComposer();
  });
  refs.batch.file.addEventListener("change", () => handleBatchFileSelection(refs.batch.file.files[0]));
  refs.batch.submit.addEventListener("click", submitBatch);

  [
    refs.settings.cooldown,
    refs.settings.maxRetries,
    refs.settings.adaptiveRateLimit,
    refs.settings.theme,
    refs.settings.autoDownload,
    refs.settings.newThread,
  ].forEach((element) => {
    element.addEventListener("input", queueSettingsSave);
    element.addEventListener("change", queueSettingsSave);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "state_update" || isEnhancedMode()) return;
  hydrateStandaloneState(message.state || {});
  renderConnectionStatus();
  renderChatGPTStatus();
  renderQueueStrip();
  renderQueueStats();
  renderQueuePanels();
  renderSettings();
});

async function init() {
  hydrateStaticIcons();
  bindStaticEvents();
  state.draft = mergeDraft(await loadPopupDraft());
  await detectMode();
  await Promise.all([refreshTemplates(), loadSettings(), refresh()]);
  renderCreate();
  renderSettings();
}

init();
setInterval(refresh, 2000);

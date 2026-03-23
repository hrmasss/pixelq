export function createId(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseMeaningfulDate(timestamp) {
  if (!timestamp) return null;
  const normalized = String(timestamp).trim();
  if (!normalized || normalized.startsWith("0001-01-01") || normalized.startsWith("0000-00-00")) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function formatClockTime(timestamp) {
  const parsed = parseMeaningfulDate(timestamp);
  if (!parsed) return "--";
  return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatRelativeTime(timestamp) {
  const parsed = parseMeaningfulDate(timestamp);
  if (!parsed) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function firstMeaningfulTimestamp(...timestamps) {
  for (const timestamp of timestamps) {
    if (parseMeaningfulDate(timestamp)) return timestamp;
  }
  return undefined;
}

export function formatCountdown(seconds) {
  if (!seconds || seconds <= 0) return "Ready";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.ceil(seconds % 60);
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function summarizePrompt(prompt = "", maxLength = 112) {
  if (prompt.length <= maxLength) return prompt;
  return `${prompt.slice(0, maxLength - 1)}…`;
}

export function getStatusView(status = "") {
  const normalized = ["scheduled", "in_progress"].includes(status) ? "active" : status;
  const labels = {
    pending: "Pending",
    active: "Running",
    completed: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return {
    tone: normalized || "pending",
    label: labels[normalized] || status || "Pending",
  };
}

export function getSourceLabel(metadata = null) {
  const source = metadata?.source || "manual";
  if (source === "template") return "Template";
  if (source === "csv") return "CSV";
  return "Manual";
}

export function normalizeMetadata(metadata = null) {
  if (!metadata || typeof metadata !== "object") return null;
  const variables = {};
  if (metadata.variables && typeof metadata.variables === "object") {
    for (const [key, value] of Object.entries(metadata.variables)) {
      variables[key] = String(value ?? "");
    }
  }
  const normalized = {
    source: metadata.source ? String(metadata.source) : "",
    project: metadata.project ? String(metadata.project) : "",
    templateId: metadata.templateId ? String(metadata.templateId) : "",
    templateName: metadata.templateName ? String(metadata.templateName) : "",
    variables,
  };

  const hasData =
    normalized.source ||
    normalized.project ||
    normalized.templateId ||
    normalized.templateName ||
    Object.keys(normalized.variables).length > 0;

  return hasData ? normalized : null;
}

export function slugifyKey(value = "") {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function resolveTemplate(templateBody = "", values = {}) {
  const missing = [];
  const prompt = String(templateBody || "").replace(/\{([^}]+)\}/g, (_, rawKey) => {
    const key = rawKey.trim();
    const value = values[key];
    if (value === undefined || value === null || value === "") {
      missing.push(key);
      return `{${key}}`;
    }
    return String(value);
  });

  return {
    prompt: prompt.trim(),
    missing,
  };
}

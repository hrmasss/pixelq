import type { CsvState, StatusPayload, Template, TemplateRun } from "../types";
import { parseTemplateVariables } from "./templates";

function parseMeaningfulDate(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("0001-01-01") || trimmed.startsWith("0000-00-00")) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function createBlankTemplate(): Template {
  return {
    name: "",
    description: "",
    body: "",
    variables: [],
  };
}

export function createCsvState(): CsvState {
  return {
    mode: "template",
    fileName: "",
    headers: [],
    rows: [],
    promptColumn: "",
    projectColumn: "",
    defaultProject: "",
    templateId: "",
    mappings: {},
  };
}

export function cloneTemplate(template: Template): Template {
  return {
    ...template,
    variables: (template.variables || []).map((variable) => ({ ...variable })),
  };
}

export function shortText(value: string, limit = 110) {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

export function formatDateTime(value?: string) {
  if (!value) return "Not available";
  const parsed = parseMeaningfulDate(value);
  if (!parsed) return "Not available";
  return parsed.toLocaleString();
}

export function formatRelative(value?: string) {
  const parsed = parseMeaningfulDate(value);
  if (!parsed) return "just now";
  const delta = Date.now() - parsed.getTime();
  const seconds = Math.max(0, Math.round(delta / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatCountdown(seconds?: number) {
  if (!seconds || seconds <= 0) return "Ready";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.ceil(seconds % 60);
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function firstMeaningfulTimestamp(...values: Array<string | undefined>) {
  for (const value of values) {
    if (parseMeaningfulDate(value)) return value;
  }
  return undefined;
}

export function statusLabel(status: string) {
  if (status === "scheduled" || status === "in_progress") return "Running";
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Pending";
}

export function bridgeTone(status: StatusPayload) {
  if (status.extension_ready) return "good";
  if (status.extension_connected) return "warn";
  return "bad";
}

export function bridgeLabel(status: StatusPayload) {
  if (status.extension_ready) return "Bridge ready";
  if (status.extension_connected) return "Bridge linked";
  return "Bridge offline";
}

export function bridgeHint(status: StatusPayload) {
  if (status.extension_ready) return status.extension_tab_url || "The ChatGPT worker is ready to receive jobs.";
  if (status.extension_connected) return "The extension is attached. Keep a logged-in ChatGPT tab open to make the worker ready.";
  return "Install and enable the PixelQ extension in Chrome to unlock the desktop bridge.";
}

export function defaultRunForTemplate(template?: Template): TemplateRun {
  const variables = parseTemplateVariables(template);
  return {
    values: Object.fromEntries(
      variables.filter((variable) => variable.key).map((variable) => [variable.key, variable.defaultValue || ""]),
    ),
  };
}

export function normalizeRunsForTemplate(template: Template | undefined, runs: TemplateRun[]) {
  if (!template) return runs.length > 0 ? runs : [{ values: {} }];
  const variables = parseTemplateVariables(template).filter((variable) => variable.key);
  if (runs.length === 0) return [defaultRunForTemplate(template)];
  return runs.map((run) => ({
    ...run,
    values: Object.fromEntries(variables.map((variable) => [variable.key, run.values?.[variable.key] ?? variable.defaultValue ?? ""])),
  }));
}

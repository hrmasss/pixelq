import type { Template, TemplateRun, TemplateVariable } from "../types";

export function parseTemplateVariables(template: Template | undefined): TemplateVariable[] {
  if (!template) return [];

  const variables = new Map<string, TemplateVariable>();
  for (const variable of template.variables || []) {
    if (!variable.key) continue;
    variables.set(variable.key, {
      key: variable.key,
      label: variable.label || prettifyVariableKey(variable.key),
      defaultValue: variable.defaultValue || "",
      required: variable.required,
    });
  }

  const body = String(template.body || "");
  const matches = body.matchAll(/\{([^}]+)\}/g);
  for (const match of matches) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;
    const [rawKey, ...rawDefaultParts] = raw.split("=");
    const key = rawKey.trim();
    if (!key) continue;
    const defaultValue = rawDefaultParts.join("=").trim();
    variables.set(key, {
      key,
      label: variables.get(key)?.label || prettifyVariableKey(key),
      defaultValue: defaultValue || variables.get(key)?.defaultValue || "",
      required: defaultValue === "",
    });
  }

  return Array.from(variables.values());
}

export function resolveTemplatePrompt(template: Template | undefined, values: Record<string, string>) {
  if (!template) return { prompt: "", valid: false, reason: "Choose a template first." };

  const variables = parseTemplateVariables(template);
  const missingRequired: string[] = [];
  const resolvedValues: Record<string, string> = {};

  for (const variable of variables) {
    const resolved = String(values[variable.key] ?? variable.defaultValue ?? "").trim();
    resolvedValues[variable.key] = resolved;
    if (variable.required && !resolved) missingRequired.push(variable.label || variable.key);
  }

  if (missingRequired.length > 0) {
    return { prompt: "", valid: false, reason: `Missing required variables: ${missingRequired.join(", ")}` };
  }

  const missingPlaceholders: string[] = [];
  const prompt = String(template.body || "")
    .replace(/\{([^}]+)\}/g, (_, raw) => {
      const content = String(raw).trim();
      const [rawKey] = content.split("=");
      const key = rawKey.trim();
      const resolved = resolvedValues[key] ?? "";
      if (!resolved) {
        missingPlaceholders.push(key);
        return `{${content}}`;
      }
      return resolved;
    })
    .trim();

  if (missingPlaceholders.length > 0) {
    return { prompt: "", valid: false, reason: `Unresolved placeholders: ${missingPlaceholders.join(", ")}` };
  }

  if (!prompt) return { prompt: "", valid: false, reason: "Resolved prompt is empty." };
  return { prompt, valid: true, reason: "" };
}

export function previewRuns(template: Template | undefined, runs: TemplateRun[]) {
  return runs.map((run, index) => ({
    id: run.id || `preview-${index}`,
    ...resolveTemplatePrompt(template, run.values || {}),
  }));
}

export function prettifyVariableKey(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

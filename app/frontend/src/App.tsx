import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { RiFileList3Line, RiHourglassLine, RiImageLine, RiSettings3Line } from "react-icons/ri";

import {
  BrowserOpenURL,
  ClipboardSetText,
  Environment,
  WindowSetBackgroundColour,
  WindowSetDarkTheme,
  WindowSetLightTheme,
  WindowSetSystemDefaultTheme,
} from "../wailsjs/runtime/runtime";
import { GetDesktopConfig, OpenInbox, OpenLibrary, OpenPath } from "../wailsjs/go/main/DesktopApp";
import { EmptyState } from "./components/ui";
import logoUrl from "./assets/logo.png";
import { parseCSV } from "./lib/csv";
import { cloneTemplate, createBlankTemplate, createCsvState } from "./lib/format";
import { parseTemplateVariables, resolveTemplatePrompt } from "./lib/templates";
import type {
  Asset,
  CsvPreview,
  CsvState,
  DesktopConfig,
  EnvironmentInfo,
  Job,
  QueueComposerMode,
  Route,
  StatusPayload,
  Template,
  ThemeMode,
} from "./types";
import { LibraryView } from "./views/LibraryView";
import { PreferencesView } from "./views/PreferencesView";
import { QueueView } from "./views/QueueView";
import { TemplatesView } from "./views/TemplatesView";

interface RouteMeta {
  id: Route;
  label: string;
  icon: IconType;
  eyebrow: string;
  description: string;
}

const APP_VERSION_LABEL = "0.1.1 alpha";

const routes: RouteMeta[] = [
  { id: "queue", label: "Queue", icon: RiHourglassLine, eyebrow: "Queue Engine", description: "Run and recover queued work." },
  { id: "templates", label: "Templates", icon: RiFileList3Line, eyebrow: "Prompt Studio", description: "Edit reusable prompt systems." },
  { id: "library", label: "Library", icon: RiImageLine, eyebrow: "Asset Browser", description: "Browse completed output." },
  { id: "preferences", label: "Settings", icon: RiSettings3Line, eyebrow: "Preferences", description: "Appearance, runtime, and bridge." },
];

async function fetchJson<T>(baseURL: string, path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${baseURL}${path}`, options);
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

function matchesJob(job: Job, search: string) {
  if (!search) return true;
  const haystack = [job.prompt, job.metadata?.project, job.metadata?.templateName, job.metadata?.source, job.error].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(search);
}

function assetFolder(path: string) {
  const parts = path.split(/[/\\]/);
  parts.pop();
  return parts.join("\\");
}

function resolveTheme(theme: ThemeMode) {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function configSnapshot(config: DesktopConfig) {
  return JSON.stringify({
    cooldown_seconds: config.cooldown_seconds ?? 60,
    jitter_seconds: config.jitter_seconds ?? 0,
    max_retries: config.max_retries ?? 3,
    adaptive_rate_limit: config.adaptive_rate_limit ?? true,
    port: config.port ?? 8765,
    library_root: config.library_root ?? "",
    downloads_inbox: config.downloads_inbox ?? "",
    start_at_login: config.start_at_login ?? false,
    keep_awake: config.keep_awake ?? false,
    theme: config.theme ?? "system",
  });
}

function App() {
  const [apiBase, setApiBase] = useState("http://127.0.0.1:8765");
  const [route, setRoute] = useState<Route>("queue");
  const [composerMode, setComposerMode] = useState<QueueComposerMode>("quick");
  const [composerOpen, setComposerOpen] = useState(false);

  const [status, setStatus] = useState<StatusPayload>({});
  const [jobs, setJobs] = useState<Job[]>([]);
  const [history, setHistory] = useState<Job[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [config, setConfig] = useState<DesktopConfig>({ theme: "system" });
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);

  const [jobsSearch, setJobsSearch] = useState("");
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryProjectFilter, setLibraryProjectFilter] = useState("all");
  const deferredJobsSearch = useDeferredValue(jobsSearch.trim().toLowerCase());
  const deferredLibrarySearch = useDeferredValue(librarySearch.trim().toLowerCase());

  const [quickPrompt, setQuickPrompt] = useState("");
  const [quickProject, setQuickProject] = useState("");
  const [quickTemplateId, setQuickTemplateId] = useState("");
  const [quickTemplateValues, setQuickTemplateValues] = useState<Record<string, string>>({});
  const [batchText, setBatchText] = useState("");
  const [batchProject, setBatchProject] = useState("");
  const [batchTemplateId, setBatchTemplateId] = useState("");
  const [csvState, setCsvState] = useState<CsvState>(createCsvState());

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState<Template>(createBlankTemplate());

  const [busyAction, setBusyAction] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [configSaveState, setConfigSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const selectedTemplate = useMemo(() => templates.find((template) => template.id === selectedTemplateId), [selectedTemplateId, templates]);
  const filteredJobs = useMemo(() => jobs.filter((job) => matchesJob(job, deferredJobsSearch)), [jobs, deferredJobsSearch]);
  const activeJobs = useMemo(() => filteredJobs.filter((job) => job.status === "scheduled" || job.status === "in_progress"), [filteredJobs]);
  const completedJobs = useMemo(() => filteredJobs.filter((job) => job.status === "completed"), [filteredJobs]);
  const failedJobs = useMemo(() => filteredJobs.filter((job) => job.status === "failed"), [filteredJobs]);
  const pendingJobs = useMemo(() => filteredJobs.filter((job) => job.status === "pending"), [filteredJobs]);

  const filteredAssets = useMemo(() => {
    return assets.filter((asset) => {
      const matchesProject = libraryProjectFilter === "all" || asset.project === libraryProjectFilter;
      const haystack = [asset.prompt, asset.project, asset.templateName, asset.sourceFilename, asset.tags?.join(" ")].filter(Boolean).join(" ").toLowerCase();
      const matchesSearch = !deferredLibrarySearch || haystack.includes(deferredLibrarySearch);
      return matchesProject && matchesSearch;
    });
  }, [assets, deferredLibrarySearch, libraryProjectFilter]);

  const projects = useMemo(() => Array.from(new Set(assets.map((asset) => asset.project).filter(Boolean) as string[])).sort(), [assets]);
  const selectedAsset = useMemo(() => filteredAssets.find((asset) => asset.id === selectedAssetId) || assets.find((asset) => asset.id === selectedAssetId), [assets, filteredAssets, selectedAssetId]);
  const quickTemplate = useMemo(() => templates.find((item) => item.id === quickTemplateId), [quickTemplateId, templates]);
  const batchTemplate = useMemo(() => templates.find((item) => item.id === batchTemplateId), [batchTemplateId, templates]);
  const quickTemplateVariables = useMemo(() => parseTemplateVariables(quickTemplate), [quickTemplate]);
  const quickTemplatePreview = useMemo(
    () => (quickTemplate ? resolveTemplatePrompt(quickTemplate, quickTemplateValues) : { prompt: "", valid: false, reason: "" }),
    [quickTemplate, quickTemplateValues],
  );

  const csvPreview = useMemo<CsvPreview[]>(() => {
    if (csvState.rows.length === 0 || !batchTemplate) return [];

    const variableMap = new Map<string, string>();
    for (const header of csvState.headers) {
      variableMap.set(header.toLowerCase(), header);
    }

    return csvState.rows.map((row) => {
      const values: Record<string, string> = {};
      for (const variable of parseTemplateVariables(batchTemplate)) {
        const header = variableMap.get(variable.key.toLowerCase());
        values[variable.key] = header ? String(row[header] || "").trim() : "";
      }
      const resolved = resolveTemplatePrompt(batchTemplate, values);
      const projectHeader = variableMap.get("project");
      const rowProject = projectHeader ? String(row[projectHeader] || "").trim() : "";
      const project = rowProject || batchProject.trim() || csvState.defaultProject.trim();
      return {
        rowNumber: Number(row.__rowNumber),
        valid: resolved.valid,
        prompt: resolved.prompt,
        project,
        metadata: resolved.valid
          ? { source: "csv", project, templateId: batchTemplate.id, templateName: batchTemplate.name, variables: values }
          : null,
        reason: resolved.reason,
      };
    });
  }, [batchProject, batchTemplate, csvState.headers, csvState.rows, csvState.defaultProject]);

  const configHydratedRef = useRef(false);
  const lastSavedConfigRef = useRef("");
  const configSaveTimerRef = useRef<number | null>(null);
  const eventRefreshTimerRef = useRef<number | null>(null);
  const configDirtyRef = useRef(false);

  const applyDesktopConfig = useCallback((payload: Record<string, unknown>) => {
    setConfig((current) => ({
      ...current,
      library_root: typeof payload.libraryRoot === "string" ? payload.libraryRoot : current.library_root,
      downloads_inbox: typeof payload.downloadsInbox === "string" ? payload.downloadsInbox : current.downloads_inbox,
      port: typeof payload.port === "number" ? payload.port : current.port,
      jitter_seconds: typeof payload.jitterSeconds === "number" ? payload.jitterSeconds : current.jitter_seconds,
      theme: typeof payload.theme === "string" ? payload.theme as ThemeMode : current.theme,
      keep_awake: typeof payload.keepAwake === "boolean" ? payload.keepAwake : current.keep_awake,
    }));
  }, []);

  const applyTheme = useCallback((theme: ThemeMode | undefined) => {
    const nextTheme = theme || "system";
    const resolved = resolveTheme(nextTheme);
    document.documentElement.dataset.theme = resolved;

    if (nextTheme === "dark") {
      WindowSetDarkTheme();
    } else if (nextTheme === "light") {
      WindowSetLightTheme();
    } else {
      WindowSetSystemDefaultTheme();
    }
    WindowSetBackgroundColour(0, 0, 0, 0);
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setRefreshError("");
    try {
      const [statusResult, jobsResult, historyResult, templatesResult, assetsResult, configResult] = await Promise.all([
        fetchJson<StatusPayload>(apiBase, "/status"),
        fetchJson<{ jobs: Job[] }>(apiBase, "/jobs?limit=120"),
        fetchJson<{ jobs: Job[] }>(apiBase, "/history?limit=60"),
        fetchJson<{ templates: Template[] }>(apiBase, "/templates"),
        fetchJson<{ assets: Asset[] }>(apiBase, "/catalog/assets?limit=120"),
        fetchJson<DesktopConfig>(apiBase, "/config"),
      ]);

      setStatus(statusResult);
      setJobs(jobsResult.jobs || []);
      setHistory(historyResult.jobs || []);
      setTemplates(templatesResult.templates || []);
      setAssets(assetsResult.assets || []);
      if (!configDirtyRef.current) {
        setConfig((current) => ({ ...current, ...configResult }));
        lastSavedConfigRef.current = configSnapshot(configResult);
        setConfigSaveState("idle");
      }
      configHydratedRef.current = true;

      if (configResult.port && apiBase !== `http://127.0.0.1:${configResult.port}`) {
        setApiBase(`http://127.0.0.1:${configResult.port}`);
      }

      setSelectedTemplateId((current) => {
        if (current && (templatesResult.templates || []).some((item) => item.id === current)) return current;
        return templatesResult.templates[0]?.id || null;
      });
      setSelectedAssetId((current) => {
        if (current && (assetsResult.assets || []).some((item) => item.id === current)) return current;
        return assetsResult.assets[0]?.id || null;
      });
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Failed to load desktop state.");
    } finally {
      setRefreshing(false);
    }
  }, [apiBase]);

  useEffect(() => {
    Environment().then((payload) => setEnvironment(payload as EnvironmentInfo)).catch(() => undefined);
    GetDesktopConfig().then(applyDesktopConfig).catch(() => undefined);
    refreshAll().catch(() => undefined);
    const interval = window.setInterval(() => {
      refreshAll().catch(() => undefined);
    }, 12000);
    return () => window.clearInterval(interval);
  }, [applyDesktopConfig, refreshAll]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;

    const scheduleRefresh = () => {
      if (eventRefreshTimerRef.current) {
        window.clearTimeout(eventRefreshTimerRef.current);
      }
      eventRefreshTimerRef.current = window.setTimeout(() => {
        refreshAll().catch(() => undefined);
      }, 200);
    };

    const connect = () => {
      const url = `${apiBase.replace(/^http/, "ws")}/events`;
      socket = new WebSocket(url);
      socket.onmessage = scheduleRefresh;
      socket.onerror = () => {
        socket?.close();
      };
      socket.onclose = () => {
        socket = null;
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, 1600);
      };
    };

    connect();

    return () => {
      closed = true;
      if (eventRefreshTimerRef.current) {
        window.clearTimeout(eventRefreshTimerRef.current);
        eventRefreshTimerRef.current = null;
      }
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [apiBase, refreshAll]);

  useEffect(() => {
    applyTheme(config.theme || "system");
    if ((config.theme || "system") !== "system") return undefined;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [applyTheme, config.theme]);

  useEffect(() => {
    if (selectedTemplate) {
      setTemplateDraft((current) => current.id === selectedTemplate.id ? current : cloneTemplate(selectedTemplate));
    } else if (templates.length === 0) {
      setTemplateDraft(createBlankTemplate());
    }
  }, [selectedTemplate, templates.length]);

  useEffect(() => {
    if (!quickTemplate) {
      setQuickTemplateValues({});
      return;
    }
    setQuickTemplateValues((current) =>
      Object.fromEntries(quickTemplateVariables.map((variable) => [variable.key, current[variable.key] ?? variable.defaultValue ?? ""])),
    );
  }, [quickTemplate, quickTemplateVariables]);

  useEffect(() => {
    if (!configHydratedRef.current) return;
    const nextSnapshot = configSnapshot(config);
    configDirtyRef.current = nextSnapshot !== lastSavedConfigRef.current;
    if (nextSnapshot === lastSavedConfigRef.current) return;

    if (configSaveTimerRef.current) {
      window.clearTimeout(configSaveTimerRef.current);
    }

    setConfigSaveState("saving");
    configSaveTimerRef.current = window.setTimeout(() => {
      fetchJson<DesktopConfig>(apiBase, "/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: nextSnapshot,
      })
        .then((saved) => {
          lastSavedConfigRef.current = configSnapshot(saved);
          configDirtyRef.current = false;
          setConfig((current) => ({ ...current, ...saved }));
          setConfigSaveState("saved");
        })
        .catch(() => {
          setConfigSaveState("error");
        });
    }, 450);

    return () => {
      if (configSaveTimerRef.current) {
        window.clearTimeout(configSaveTimerRef.current);
      }
    };
  }, [apiBase, config]);

  useEffect(() => {
    if (configSaveState !== "saved") return undefined;
    const timer = window.setTimeout(() => {
      setConfigSaveState("idle");
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [configSaveState]);

  useEffect(() => {
    const flushConfig = () => {
      if (!configHydratedRef.current) return;
      const nextSnapshot = configSnapshot(config);
      if (nextSnapshot === lastSavedConfigRef.current) return;

      fetch(`${apiBase}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: nextSnapshot,
        keepalive: true,
      }).catch(() => undefined);
    };

    const onBeforeUnload = () => flushConfig();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushConfig();
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [apiBase, config]);

  const runAction = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusyAction(name);
    try {
      await action();
      await refreshAll();
    } finally {
      setBusyAction("");
    }
  }, [refreshAll]);

  const queueJobs = useCallback(async (payload: Array<{ prompt: string; priority: number; metadata?: Job["metadata"] }>) => {
    await fetchJson(apiBase, "/jobs/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs: payload }),
    });
  }, [apiBase]);

  const closeComposer = useCallback(() => {
    setComposerOpen(false);
  }, []);

  const handleQueueQuick = useCallback(async () => {
    const templateRun = { values: quickTemplateValues };
    await runAction("queue-quick", async () => {
      if (quickTemplateId) {
        await fetchJson(apiBase, `/templates/${quickTemplateId}/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runs: [templateRun], project: quickProject.trim() }),
        });
      } else {
        await queueJobs([{ prompt: quickPrompt, priority: 1, metadata: { source: "manual", project: quickProject.trim() } }]);
      }
      setQuickPrompt("");
      setQuickProject("");
      setQuickTemplateId("");
      setQuickTemplateValues({});
      closeComposer();
    });
  }, [apiBase, closeComposer, quickPrompt, quickProject, quickTemplateId, quickTemplateValues, queueJobs, runAction]);

  const handleQueueBatch = useCallback(async () => {
    await runAction("queue-batch", async () => {
      if (batchTemplateId) {
        const ready = csvPreview.filter((row) => row.valid);
        await queueJobs(
          ready.map((row, index) => ({
            prompt: row.prompt,
            priority: ready.length - index,
            metadata: row.metadata || { source: "csv", project: row.project },
          })),
        );
      } else {
        const lines = batchText.split("\n").map((line) => line.trim()).filter(Boolean);
        await queueJobs(lines.map((prompt, index) => ({ prompt, priority: lines.length - index, metadata: { source: "manual", project: batchProject.trim() } })));
      }
      setBatchText("");
      setBatchProject("");
      setBatchTemplateId("");
      setCsvState(createCsvState());
      closeComposer();
    });
  }, [batchProject, batchTemplateId, batchText, closeComposer, csvPreview, queueJobs, runAction]);

  const handleCsvFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseCSV(text);
    setCsvState((current) => ({
      ...current,
      fileName: file.name,
      headers: parsed.headers,
      rows: parsed.rows,
    }));
  }, []);

  const handleSelectTemplate = useCallback((template?: Template) => {
    if (!template) {
      setSelectedTemplateId(null);
      setTemplateDraft(createBlankTemplate());
      return;
    }
    setSelectedTemplateId(template.id || null);
    setTemplateDraft(cloneTemplate(template));
  }, []);

  const saveTemplate = useCallback(async () => {
    if (!templateDraft.name.trim() || !templateDraft.body.trim()) return;
    const payload = { ...templateDraft, variables: parseTemplateVariables(templateDraft) };
    await runAction("save-template", async () => {
      const method = templateDraft.id ? "PUT" : "POST";
      const path = templateDraft.id ? `/templates/${templateDraft.id}` : "/templates";
      const saved = await fetchJson<Template>(apiBase, path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSelectedTemplateId(saved.id || null);
      setTemplateDraft(cloneTemplate(saved));
    });
  }, [apiBase, runAction, templateDraft]);

  const deleteTemplate = useCallback(async () => {
    if (!templateDraft.id) return;
    await runAction("delete-template", async () => {
      await fetchJson(apiBase, `/templates/${templateDraft.id}`, { method: "DELETE" });
      setSelectedTemplateId(null);
      setTemplateDraft(createBlankTemplate());
    });
  }, [apiBase, runAction, templateDraft.id]);

  const duplicateJob = useCallback(async (job: Job) => {
    await runAction("duplicate-job", async () => {
      await queueJobs([{ prompt: job.prompt, priority: 1, metadata: job.metadata || { source: "manual" } }]);
    });
  }, [queueJobs, runAction]);

  const routeMeta = routes.find((item) => item.id === route) || routes[0];

  return (
    <div className="desktop-shell">
      <div className="chrome-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <img className="brand-mark-image" src={logoUrl} alt="PixelQ" />
            <div className="sidebar-brand-copy">
              <strong>PixelQ</strong>
              <span>{APP_VERSION_LABEL}</span>
            </div>
          </div>

          <nav className="sidebar-nav" aria-label="Primary">
            {routes.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={`sidebar-link ${route === item.id ? "active" : ""}`} onClick={() => setRoute(item.id)} title={item.label}>
                  <Icon className="icon" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="main-shell">
          <header className="app-commandbar">
            <div className="app-commandbar-copy">
              <p className="eyebrow">{routeMeta.eyebrow}</p>
              <div className="app-commandbar-title">
                <strong>{routeMeta.label}</strong>
                <span>{routeMeta.description}</span>
              </div>
            </div>
            <div className="app-commandbar-meta">
              <div className={`state-chip tone-${status.extension_ready ? "good" : status.extension_connected ? "warn" : "bad"}`}>
                <span>{status.extension_ready ? "Bridge ready" : status.extension_connected ? "Bridge linked" : "Bridge offline"}</span>
              </div>
              <div className="soft-version-chip">{status.version || "0.1.1-alpha"}</div>
            </div>
          </header>

          <main className="content-area">
            {refreshError ? (
              <div className="banner banner-error">
                <strong>Some desktop data could not be loaded.</strong>
                <span>{refreshError}</span>
              </div>
            ) : null}

            {route === "queue" ? (
              <QueueView
                activeJobs={activeJobs}
                batchProject={batchProject}
                batchText={batchText}
                batchTemplateId={batchTemplateId}
                busyAction={busyAction}
                composerMode={composerMode}
                composerOpen={composerOpen}
                csvPreview={csvPreview}
                csvState={csvState}
                completedJobs={completedJobs}
                failedJobs={failedJobs}
                history={history}
                jobsSearch={jobsSearch}
                pendingJobs={pendingJobs}
                quickProject={quickProject}
                quickPrompt={quickPrompt}
                quickTemplateId={quickTemplateId}
                quickTemplatePreview={quickTemplatePreview}
                quickTemplateValues={quickTemplateValues}
                refreshing={refreshing}
                status={status}
                templates={templates}
                onArchiveCompleted={() => runAction("archive-completed", () => fetchJson(apiBase, "/jobs/archive-completed", { method: "POST" }).then(() => undefined))}
                onBatchProjectChange={setBatchProject}
                onBatchTemplateIdChange={(value) => {
                  setBatchTemplateId(value);
                  setCsvState((current) => ({
                    ...createCsvState(),
                    defaultProject: current.defaultProject,
                  }));
                }}
                onBatchTextChange={setBatchText}
                onCloseComposer={closeComposer}
                onComposerModeChange={setComposerMode}
                onDeleteJob={(jobId) => runAction("delete-job", () => fetchJson(apiBase, `/jobs/${jobId}`, { method: "DELETE" }).then(() => undefined))}
                onDuplicateJob={duplicateJob}
                onFileChange={handleCsvFile}
                onJobsSearchChange={setJobsSearch}
                onPauseQueue={() => runAction("pause-queue", () => fetchJson(apiBase, "/scheduler/pause", { method: "POST" }).then(() => undefined))}
                onQuickProjectChange={setQuickProject}
                onQuickPromptChange={setQuickPrompt}
                onQueueBatch={handleQueueBatch}
                onQueueQuick={handleQueueQuick}
                onCancelJob={(jobId) => runAction("cancel-job", () => fetchJson(apiBase, `/jobs/${jobId}/cancel`, { method: "POST" }).then(() => undefined))}
                onRefresh={() => refreshAll().catch(() => undefined)}
                onRetryJob={(jobId) => runAction("retry-job", () => fetchJson(apiBase, `/jobs/${jobId}/retry`, { method: "POST" }).then(() => undefined))}
                onSetCsvDefaultProject={(value) => setCsvState((current) => ({ ...current, defaultProject: value }))}
                onQuickTemplateIdChange={(value) => {
                  setQuickTemplateId(value);
                  setQuickPrompt("");
                }}
                onQuickTemplateValueChange={(key, value) => setQuickTemplateValues((current) => ({ ...current, [key]: value }))}
                onStartQueue={() => runAction("start-queue", () => fetchJson(apiBase, "/scheduler/start", { method: "POST" }).then(() => undefined))}
                onToggleComposer={() => setComposerOpen(true)}
              />
            ) : null}

            {route === "templates" ? (
              <TemplatesView
                busyAction={busyAction}
                selectedTemplateId={selectedTemplateId}
                templateDraft={templateDraft}
                templates={templates}
                onDeleteTemplate={deleteTemplate}
                onSaveTemplate={saveTemplate}
                onSelectTemplate={handleSelectTemplate}
                onTemplateDraftChange={setTemplateDraft}
              />
            ) : null}

            {route === "library" ? (
              <LibraryView
                apiBase={apiBase}
                assets={filteredAssets}
                busyAction={busyAction}
                libraryProjectFilter={libraryProjectFilter}
                librarySearch={librarySearch}
                projects={projects}
                selectedAsset={selectedAsset}
                selectedAssetId={selectedAssetId}
                onOpenAsset={(path) => OpenPath(path).catch(() => undefined)}
                onOpenFolder={(path) => OpenPath(assetFolder(path)).catch(() => undefined)}
                onOpenLibrary={() => OpenLibrary().catch(() => undefined)}
                onProjectFilterChange={setLibraryProjectFilter}
                onReindex={() => runAction("reindex-library", () => fetchJson(apiBase, "/catalog/reindex", { method: "POST" }).then(() => undefined))}
                onSearchChange={setLibrarySearch}
                onSelectAsset={setSelectedAssetId}
              />
            ) : null}

            {route === "preferences" ? (
              <PreferencesView
                apiBase={apiBase}
                config={config}
                configSaveState={configSaveState}
                environment={environment}
                status={status}
                onCopy={(value) => ClipboardSetText(value).catch(() => undefined)}
                onOpenInbox={() => OpenInbox().catch(() => undefined)}
                onOpenLibrary={() => OpenLibrary().catch(() => undefined)}
                onOpenMcpDocs={() => BrowserOpenURL("https://modelcontextprotocol.io/")}
                onUpdateConfig={setConfig}
              />
            ) : null}

            {!routes.some((item) => item.id === route) ? <EmptyState title="Unknown route" copy="Choose a workspace from the sidebar." /> : null}
          </main>
        </div>
      </div>
    </div>
  );
}

export default App;

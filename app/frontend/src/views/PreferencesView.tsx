import {
  RiContrast2Line,
  RiFileCopyLine,
  RiFolderOpenLine,
  RiMoonClearLine,
  RiPlug2Line,
  RiRobot2Line,
  RiTimerFlashLine,
} from "react-icons/ri";

import { EmptyState, Panel, Segmented } from "../components/ui";
import { bridgeHint, bridgeLabel, bridgeTone } from "../lib/format";
import type { DesktopConfig, EnvironmentInfo, StatusPayload, ThemeMode } from "../types";

interface PreferencesViewProps {
  apiBase: string;
  config: DesktopConfig;
  configSaveState: "idle" | "saving" | "saved" | "error";
  environment: EnvironmentInfo | null;
  status: StatusPayload;
  onCopy: (value: string) => void;
  onOpenInbox: () => void;
  onOpenLibrary: () => void;
  onOpenMcpDocs: () => void;
  onUpdateConfig: (next: DesktopConfig) => void;
}

const mcpSnippet = `{
  "mcpServers": {
    "pixelq": {
      "command": "C:/path/to/pixelq.exe",
      "args": ["mcp"]
    }
  }
}`;

const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function autosaveLabel(state: "idle" | "saving" | "saved" | "error") {
  switch (state) {
    case "saving":
      return "Autosaving";
    case "saved":
      return "Autosaved";
    case "error":
      return "Save failed";
    default:
      return "Auto save";
  }
}

function autosaveTone(state: "idle" | "saving" | "saved" | "error") {
  switch (state) {
    case "saving":
      return "warn";
    case "saved":
      return "good";
    case "error":
      return "bad";
    default:
      return "accent";
  }
}

export function PreferencesView({
  apiBase,
  config,
  configSaveState,
  environment,
  status,
  onCopy,
  onOpenInbox,
  onOpenLibrary,
  onOpenMcpDocs,
  onUpdateConfig,
}: PreferencesViewProps) {
  return (
    <div className="page preferences-page">
      <section className="page-toolbar">
        <div className="page-title">
          <p className="eyebrow">Preferences</p>
          <h1>Settings</h1>
          <p>Theme, pacing, and bridge settings save automatically as you change them.</p>
        </div>
        <div className="page-actions">
          <div className={`state-chip tone-${autosaveTone(configSaveState)}`}>
            <span>{autosaveLabel(configSaveState)}</span>
          </div>
        </div>
      </section>

      <div className="settings-stack">
        <Panel title="Appearance" eyebrow="Theme">
          <div className="settings-inline-grid">
            <div className="field">
              <span>Mode</span>
              <Segmented value={config.theme || "system"} onChange={(value) => onUpdateConfig({ ...config, theme: value as ThemeMode })} options={themeOptions} />
            </div>
            <div className="compact-summary-strip">
              <article className="summary-chip">
                <RiContrast2Line className="icon" />
                <strong>{config.theme || "system"}</strong>
                <span>active theme</span>
              </article>
            </div>
          </div>
        </Panel>

        <Panel title="Queue" eyebrow="Runtime">
          <div className="settings-inline-grid compact-three-up">
            <label className="field">
              <span>Cooldown seconds</span>
              <input type="number" value={config.cooldown_seconds ?? 60} onChange={(event) => onUpdateConfig({ ...config, cooldown_seconds: Number(event.target.value) })} />
            </label>
            <label className="field">
              <span>Jitter seconds</span>
              <input type="number" value={config.jitter_seconds ?? 0} onChange={(event) => onUpdateConfig({ ...config, jitter_seconds: Number(event.target.value) })} />
            </label>
            <label className="field">
              <span>Max retries</span>
              <input type="number" value={config.max_retries ?? 3} onChange={(event) => onUpdateConfig({ ...config, max_retries: Number(event.target.value) })} />
            </label>
          </div>

          <div className="toggle-list">
            <label className="toggle-card">
              <div>
                <strong>Adaptive rate limiting</strong>
                <p>Back off automatically when ChatGPT pushes back, then recover once the queue stabilizes.</p>
              </div>
              <input type="checkbox" checked={config.adaptive_rate_limit ?? true} onChange={(event) => onUpdateConfig({ ...config, adaptive_rate_limit: event.target.checked })} />
            </label>
            <label className="toggle-card">
              <div>
                <strong>Keep system awake</strong>
                <p>Prevent sleep while PixelQ is open so queued work can keep moving.</p>
              </div>
              <input type="checkbox" checked={config.keep_awake ?? false} onChange={(event) => onUpdateConfig({ ...config, keep_awake: event.target.checked })} />
            </label>
          </div>

          <div className="compact-summary-strip">
            <article className="summary-chip">
              <RiTimerFlashLine className="icon" />
              <strong>{config.cooldown_seconds ?? 60}s</strong>
              <span>cooldown</span>
            </article>
            <article className="summary-chip">
              <RiTimerFlashLine className="icon" />
              <strong>{config.jitter_seconds ?? 0}s</strong>
              <span>jitter</span>
            </article>
            <article className="summary-chip">
              <RiMoonClearLine className="icon" />
              <strong>{config.keep_awake ? "On" : "Off"}</strong>
              <span>wake lock</span>
            </article>
          </div>
        </Panel>

        <Panel title="Paths" eyebrow="Storage">
          <div className="settings-inline-grid compact-two-up">
            <label className="field">
              <span>Downloads inbox</span>
              <input value={config.downloads_inbox || ""} onChange={(event) => onUpdateConfig({ ...config, downloads_inbox: event.target.value })} />
            </label>
            <label className="field">
              <span>Library root</span>
              <input value={config.library_root || ""} onChange={(event) => onUpdateConfig({ ...config, library_root: event.target.value })} />
            </label>
          </div>
          <div className="button-row">
            <button className="ghost" onClick={onOpenInbox}>
              <RiFolderOpenLine className="icon" />
              Open inbox
            </button>
            <button className="ghost" onClick={onOpenLibrary}>
              <RiFolderOpenLine className="icon" />
              Open library
            </button>
          </div>
        </Panel>

        <Panel title="Integration" eyebrow="Local API and MCP">
          <div className="property-list">
            <div>
              <span>Base URL</span>
              <strong>{apiBase}</strong>
            </div>
            <div>
              <span>Port</span>
              <strong>{config.port || 8765}</strong>
            </div>
            <div>
              <span>Platform</span>
              <strong>{environment ? `${environment.platform} (${environment.arch})` : "Unknown"}</strong>
            </div>
            <div>
              <span>Release</span>
              <strong>{status.version || "0.1.0-alpha"}</strong>
            </div>
          </div>
          <div className="button-row">
            <button className="ghost" onClick={() => onCopy(apiBase)}>
              <RiFileCopyLine className="icon" />
              Copy base URL
            </button>
          </div>

          <details className="compact-details">
            <summary>MCP setup</summary>
            <div className="details-content">
              <p className="support-copy">PixelQ exposes MCP tools for queueing jobs, resolving templates, checking status, and searching your managed image library.</p>
              <pre className="code-block">{mcpSnippet}</pre>
              <div className="button-row">
                <button className="ghost" onClick={() => onCopy(mcpSnippet)}>
                  <RiFileCopyLine className="icon" />
                  Copy config
                </button>
                <button className="ghost" onClick={onOpenMcpDocs}>
                  <RiRobot2Line className="icon" />
                  Open MCP docs
                </button>
              </div>
            </div>
          </details>
        </Panel>

        <Panel title="Diagnostics" eyebrow="Bridge">
          <div className={`state-chip tone-${bridgeTone(status)}`}>
            <RiPlug2Line className="icon" />
            <span>{bridgeLabel(status)}</span>
          </div>
          <p className="support-copy">{bridgeHint(status)}</p>

          <details className="compact-details">
            <summary>Show bridge details</summary>
            <div className="details-content">
              <div className="property-list">
                <div>
                  <span>Bridge state</span>
                  <strong>{status.bridge_state || "unknown"}</strong>
                </div>
                <div>
                  <span>Connected clients</span>
                  <strong>{status.client_count || 0}</strong>
                </div>
                <div>
                  <span>Ready workers</span>
                  <strong>{status.ready_client_count || 0}</strong>
                </div>
                <div>
                  <span>Worker tab</span>
                  <strong>{status.extension_tab_url || "No ready tab reported"}</strong>
                </div>
              </div>
            </div>
          </details>

          {status.extension_connected || status.library_root || status.downloads_inbox ? (
            <div className="stack-list">
              <article className="list-row">
                <div>
                  <strong>Extension</strong>
                  <span>{status.extension_connected ? "Connected" : "Not detected"}</span>
                </div>
              </article>
              <article className="list-row">
                <div>
                  <strong>Library path</strong>
                  <span>{config.library_root || status.library_root || "Not configured"}</span>
                </div>
              </article>
              <article className="list-row">
                <div>
                  <strong>Downloads inbox</strong>
                  <span>{config.downloads_inbox || status.downloads_inbox || "Not configured"}</span>
                </div>
              </article>
            </div>
          ) : (
            <EmptyState title="Desktop bridge still needs setup" copy="Start the extension, point the app at your library paths, and this panel will populate." />
          )}
        </Panel>
      </div>
    </div>
  );
}

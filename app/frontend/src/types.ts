export type Route = "queue" | "templates" | "library" | "preferences";
export type QueueComposerMode = "quick" | "batch";
export type QueueStatus = "pending" | "scheduled" | "in_progress" | "completed" | "failed" | "cancelled";
export type CsvMode = "template";
export type ThemeMode = "system" | "light" | "dark";

export interface JobMetadata {
  source?: string;
  project?: string;
  templateId?: string;
  templateName?: string;
  variables?: Record<string, string>;
}

export interface Job {
  id: string;
  prompt: string;
  status: QueueStatus;
  error?: string;
  metadata?: JobMetadata;
  created_at?: string;
  scheduled_at?: string;
  started_at?: string;
  completed_at?: string;
}

export interface TemplateVariable {
  key: string;
  label: string;
  defaultValue?: string;
  required: boolean;
}

export interface TemplateRun {
  id?: string;
  values: Record<string, string>;
}

export interface Template {
  id?: string;
  name: string;
  description?: string;
  body: string;
  variables: TemplateVariable[];
}

export interface Asset {
  id: string;
  project?: string;
  prompt: string;
  templateName?: string;
  tags?: string[];
  sourceFilename?: string;
  libraryPath: string;
  thumbPath?: string;
  createdAt?: string;
  importedAt?: string;
}

export interface DesktopConfig {
  cooldown_seconds?: number;
  jitter_seconds?: number;
  max_retries?: number;
  adaptive_rate_limit?: boolean;
  port?: number;
  library_root?: string;
  downloads_inbox?: string;
  start_at_login?: boolean;
  keep_awake?: boolean;
  theme?: ThemeMode;
}

export interface BridgeClient {
  ready: boolean;
  tab_url?: string;
}

export interface StatusPayload {
  counts?: Record<string, number>;
  running?: boolean;
  next_run_in?: number;
  extension_connected?: boolean;
  extension_ready?: boolean;
  ready_client_count?: number;
  client_count?: number;
  bridge_state?: string;
  extension_tab_url?: string;
  current_job?: string;
  asset_count?: number;
  template_count?: number;
  schedule_count?: number;
  library_root?: string;
  downloads_inbox?: string;
  bridge_clients?: BridgeClient[];
  version?: string;
}

export interface EnvironmentInfo {
  buildType: string;
  platform: string;
  arch: string;
}

export interface CsvRow {
  __rowNumber: number;
  [key: string]: string | number;
}

export interface CsvState {
  mode: CsvMode;
  fileName: string;
  headers: string[];
  rows: CsvRow[];
  promptColumn: string;
  projectColumn: string;
  defaultProject: string;
  templateId: string;
  mappings: Record<string, string>;
}

export interface CsvPreview {
  rowNumber: number;
  valid: boolean;
  prompt: string;
  project: string;
  metadata: JobMetadata | null;
  reason?: string;
}

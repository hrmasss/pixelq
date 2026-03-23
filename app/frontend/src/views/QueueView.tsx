import {
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiInboxArchiveLine,
  RiPauseMiniLine,
  RiPlayMiniLine,
  RiRefreshLine,
  RiSearchLine,
  RiStopCircleLine,
  RiUpload2Line,
  RiCloseLine,
} from "react-icons/ri";
import type { ChangeEvent } from "react";

import { EmptyState, MetricCard, Panel, Segmented } from "../components/ui";
import { firstMeaningfulTimestamp, formatCountdown, formatDateTime, formatRelative, shortText, statusLabel } from "../lib/format";
import { parseTemplateVariables } from "../lib/templates";
import type { CsvPreview, CsvState, Job, QueueComposerMode, StatusPayload, Template } from "../types";

function isLegacyPlaceholderPrompt(prompt: string) {
  return /^prompt\s+\d+$/i.test(prompt.trim());
}

function promptMeta(job: Job) {
  return job.metadata?.project || job.metadata?.templateName || job.metadata?.source || "Manual";
}

function activeJobTitle(job: Job) {
  if (job.metadata?.project) return job.metadata.project;
  if (job.metadata?.templateName) return job.metadata.templateName;
  if (isLegacyPlaceholderPrompt(job.prompt)) return "Queued prompt";
  return shortText(job.prompt, 64);
}

function activeJobContext(job: Job) {
  const parts = [job.metadata?.project, job.metadata?.templateName, job.metadata?.source].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return isLegacyPlaceholderPrompt(job.prompt) ? "Legacy imported queue item" : "Manual";
}

function activeJobSummary(job: Job) {
  if (job.metadata?.variables && Object.keys(job.metadata.variables).length > 0) {
    return `${Object.keys(job.metadata.variables).length} variables resolved`;
  }
  if (job.metadata?.templateName && job.metadata?.project) {
    return `Project: ${job.metadata.project}`;
  }
  if (job.metadata?.templateName) {
    return `Template: ${job.metadata.templateName}`;
  }
  if (isLegacyPlaceholderPrompt(job.prompt)) {
    return "Imported from an older local queue";
  }
  return shortText(job.prompt, 120);
}

function activeJobTimestamp(job: Job) {
  if (job.status === "in_progress") {
    return firstMeaningfulTimestamp(job.started_at, job.scheduled_at, job.created_at);
  }
  return firstMeaningfulTimestamp(job.scheduled_at, job.created_at);
}

interface QueueViewProps {
  busyAction: string;
  composerMode: QueueComposerMode;
  composerOpen: boolean;
  csvPreview: CsvPreview[];
  csvState: CsvState;
  history: Job[];
  jobsSearch: string;
  activeJobs: Job[];
  completedJobs: Job[];
  failedJobs: Job[];
  pendingJobs: Job[];
  quickPrompt: string;
  quickProject: string;
  quickTemplateId: string;
  quickTemplateValues: Record<string, string>;
  quickTemplatePreview: { prompt: string; valid: boolean; reason?: string };
  batchText: string;
  batchProject: string;
  batchTemplateId: string;
  refreshing: boolean;
  status: StatusPayload;
  templates: Template[];
  onArchiveCompleted: () => void;
  onBatchProjectChange: (value: string) => void;
  onBatchTemplateIdChange: (value: string) => void;
  onBatchTextChange: (value: string) => void;
  onCloseComposer: () => void;
  onComposerModeChange: (value: QueueComposerMode) => void;
  onDeleteJob: (jobId: string) => void;
  onDuplicateJob: (job: Job) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onJobsSearchChange: (value: string) => void;
  onPauseQueue: () => void;
  onQuickProjectChange: (value: string) => void;
  onQuickPromptChange: (value: string) => void;
  onQuickTemplateIdChange: (value: string) => void;
  onQuickTemplateValueChange: (key: string, value: string) => void;
  onQueueBatch: () => void;
  onQueueQuick: () => void;
  onRefresh: () => void;
  onRetryJob: (jobId: string) => void;
  onCancelJob: (jobId: string) => void;
  onSetCsvDefaultProject: (value: string) => void;
  onStartQueue: () => void;
  onToggleComposer: () => void;
}

export function QueueView({
  busyAction,
  composerMode,
  composerOpen,
  csvPreview,
  csvState,
  history,
  jobsSearch,
  activeJobs,
  completedJobs,
  failedJobs,
  pendingJobs,
  quickPrompt,
  quickProject,
  quickTemplateId,
  quickTemplateValues,
  quickTemplatePreview,
  batchText,
  batchProject,
  batchTemplateId,
  refreshing,
  status,
  templates,
  onArchiveCompleted,
  onBatchProjectChange,
  onBatchTemplateIdChange,
  onBatchTextChange,
  onCloseComposer,
  onComposerModeChange,
  onDeleteJob,
  onDuplicateJob,
  onFileChange,
  onJobsSearchChange,
  onPauseQueue,
  onQuickProjectChange,
  onQuickPromptChange,
  onQuickTemplateIdChange,
  onQuickTemplateValueChange,
  onQueueBatch,
  onQueueQuick,
  onRefresh,
  onRetryJob,
  onCancelJob,
  onSetCsvDefaultProject,
  onStartQueue,
  onToggleComposer,
}: QueueViewProps) {
  const counts = status.counts || {};
  const activeCount = (counts.scheduled || 0) + (counts.in_progress || 0);
  const pendingCount = counts.pending || pendingJobs.length;
  const completedCount = counts.completed || 0;
  const readyCsvRows = csvPreview.filter((row) => row.valid).length;
  const selectedQuickTemplate = templates.find((template) => template.id === quickTemplateId);
  const selectedBatchTemplate = templates.find((template) => template.id === batchTemplateId);
  const quickTemplateVariables = parseTemplateVariables(selectedQuickTemplate);

  return (
    <div className="page queue-page">
      <section className="page-toolbar">
        <div className="page-title">
          <p className="eyebrow">Queue Engine</p>
          <h1>Queue</h1>
          <p>Run queued work, keep the active set visible, and recover failures without extra chrome or placeholder UI.</p>
        </div>
        <div className="page-actions queue-page-actions">
          <label className="search-field grow">
            <RiSearchLine className="icon" />
            <input value={jobsSearch} onChange={(event) => onJobsSearchChange(event.target.value)} placeholder="Search jobs or projects" />
          </label>
          <button className="ghost" disabled={refreshing} onClick={onRefresh}>
            <RiRefreshLine className={`icon ${refreshing ? "spin" : ""}`} />
            Refresh
          </button>
          <button className="ghost" disabled={busyAction !== "" || Boolean(status.running)} onClick={onStartQueue}>
            <RiPlayMiniLine className="icon" />
            Start
          </button>
          <button className="ghost" disabled={busyAction !== "" || !status.running} onClick={onPauseQueue}>
            <RiPauseMiniLine className="icon" />
            Pause
          </button>
          <button onClick={onToggleComposer}>Create</button>
        </div>
      </section>

      <section className="metric-pill-row" aria-label="Queue summary">
        <MetricCard label="Active" value={activeCount} detail={status.running ? "Live" : "Paused"} tone="accent" />
        <MetricCard label="Pending" value={pendingCount} detail={status.next_run_in ? formatCountdown(status.next_run_in) : "Ready"} />
        <MetricCard label="Completed" value={completedCount} detail={`${history.length} archived`} />
        <MetricCard label="Failures" value={failedJobs.length} detail={failedJobs.length > 0 ? "Attention" : "Clear"} tone={failedJobs.length > 0 ? "bad" : "default"} />
      </section>

      {composerOpen ? (
        <div className="modal-backdrop" onClick={onCloseComposer}>
          <div className="modal-shell" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div className="page-title">
                <p className="eyebrow">Queue Work</p>
                <h1>Create</h1>
              </div>
              <button className="ghost icon-button" aria-label="Close composer" onClick={onCloseComposer}>
                <RiCloseLine className="icon" />
              </button>
            </div>

            <div className="modal-body">
              <Segmented
                value={composerMode}
                onChange={onComposerModeChange}
                options={[
                  { value: "quick", label: "Quick" },
                  { value: "batch", label: "Batch" },
                ]}
              />

              {composerMode === "quick" ? (
                <div className="form-stack">
                  <div className="form-grid compact-two-up">
                    <label className="field">
                      <span>Project</span>
                      <input value={quickProject} onChange={(event) => onQuickProjectChange(event.target.value)} placeholder="Spring campaign" />
                    </label>
                    <label className="field">
                      <span>Template</span>
                      <select value={quickTemplateId} onChange={(event) => onQuickTemplateIdChange(event.target.value)}>
                        <option value="">Write prompt manually</option>
                        {templates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {selectedQuickTemplate ? (
                    <>
                      <div className="quick-template-fields">
                        {quickTemplateVariables.map((variable) => (
                          <label key={variable.key} className="field">
                            <span>{variable.label || variable.key}</span>
                            <input
                              value={quickTemplateValues[variable.key] || ""}
                              onChange={(event) => onQuickTemplateValueChange(variable.key, event.target.value)}
                              placeholder={variable.defaultValue || variable.key}
                            />
                          </label>
                        ))}
                      </div>
                      <div className={`preview-row ${quickTemplatePreview.valid ? "valid" : "invalid"}`}>
                        <strong>{quickTemplatePreview.valid ? shortText(quickTemplatePreview.prompt, 180) : "Template needs attention"}</strong>
                        <span>{quickTemplatePreview.valid ? "Resolved prompt preview" : quickTemplatePreview.reason}</span>
                      </div>
                    </>
                  ) : (
                    <label className="field">
                      <span>Prompt</span>
                      <textarea rows={4} value={quickPrompt} onChange={(event) => onQuickPromptChange(event.target.value)} placeholder="Describe the image you want to queue next." />
                    </label>
                  )}

                  <div className="button-row">
                    <button disabled={busyAction !== "" || (selectedQuickTemplate ? !quickTemplatePreview.valid : !quickPrompt.trim())} onClick={onQueueQuick}>
                      <RiPlayMiniLine className="icon" />
                      Queue quick run
                    </button>
                  </div>
                </div>
              ) : null}

              {composerMode === "batch" ? (
                <div className="form-stack">
                  <div className="form-grid compact-two-up">
                    <label className="field">
                      <span>Project</span>
                      <input value={batchProject} onChange={(event) => onBatchProjectChange(event.target.value)} placeholder="Editorial product run" />
                    </label>
                    <label className="field">
                      <span>Template</span>
                      <select value={batchTemplateId} onChange={(event) => onBatchTemplateIdChange(event.target.value)}>
                        <option value="">Write prompts manually</option>
                        {templates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {selectedBatchTemplate ? (
                    <>
                      <p className="support-copy">Upload a CSV whose column names match the template placeholder keys. A `project` column is optional and overrides the batch project for that row.</p>
                      <label className="field">
                        <span>CSV file</span>
                        <input type="file" accept=".csv,text/csv" onChange={onFileChange} />
                      </label>
                      <label className="field">
                        <span>Fallback project</span>
                        <input value={csvState.defaultProject} onChange={(event) => onSetCsvDefaultProject(event.target.value)} placeholder="Used when the CSV has no project column" />
                      </label>
                      <div className="button-row">
                        <div className="summary-chip">
                          <strong>{csvState.fileName || "No CSV loaded"}</strong>
                          <span>{csvState.headers.length > 0 ? `${csvState.headers.length} columns` : "Expect columns like subject, style, lighting"}</span>
                        </div>
                      </div>
                      <div className="preview-list">
                        {csvPreview.length === 0 ? (
                          <EmptyState title="Load a CSV to preview rows" copy="Each CSV row becomes one batch item once the headers line up with the template keys." />
                        ) : (
                          csvPreview.slice(0, 6).map((preview) => (
                            <article key={preview.rowNumber} className={`preview-row ${preview.valid ? "valid" : "invalid"}`}>
                              <strong>{preview.valid ? shortText(preview.prompt, 140) : `Row ${preview.rowNumber} needs attention`}</strong>
                              <span>{preview.valid ? `${preview.project || "No project"} · ready to queue` : preview.reason}</span>
                            </article>
                          ))
                        )}
                      </div>
                      <div className="button-row">
                        <button disabled={readyCsvRows === 0 || busyAction !== ""} onClick={onQueueBatch}>
                          <RiUpload2Line className="icon" />
                          Queue batch
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>Prompt batch</span>
                        <textarea rows={6} value={batchText} onChange={(event) => onBatchTextChange(event.target.value)} placeholder="One prompt per line." />
                      </label>
                      <div className="button-row">
                        <button disabled={!batchText.trim() || busyAction !== ""} onClick={onQueueBatch}>
                          <RiUpload2Line className="icon" />
                          Queue batch
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <Panel title="Active jobs" eyebrow={`${activeJobs.length} in motion`} className="queue-primary-panel">
        {activeJobs.length === 0 ? (
          <EmptyState title="Nothing in flight" copy="When a worker picks up a slot, active jobs land here." />
        ) : (
          <div className="job-card-grid">
            {activeJobs.map((job) => (
              <article key={job.id} className="job-hero-card">
                <div className="job-hero-head">
                  <div className="job-title-block">
                    <strong>{activeJobTitle(job)}</strong>
                    <span>{activeJobContext(job)}</span>
                  </div>
                  <div className="button-row">
                    <span className={`status-pill status-${job.status}`}>{statusLabel(job.status)}</span>
                    <button className="ghost small icon-button" title="Stop job" onClick={() => onCancelJob(job.id)}>
                      <RiStopCircleLine className="icon" />
                    </button>
                  </div>
                </div>
                <div className="job-preview">
                  <strong>{activeJobSummary(job)}</strong>
                  <p>{job.status === "in_progress" ? "Currently being processed by the worker." : "Queued and waiting for the next available worker slot."}</p>
                </div>
                <div className="job-hero-foot">
                  <small>{formatRelative(activeJobTimestamp(job))}</small>
                  <small>{job.status === "in_progress" ? "Worker rendering" : "Awaiting pickup"}</small>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <div className="queue-secondary-grid">
        <Panel
          title="Pending queue"
          eyebrow="Ready and waiting"
          actions={
            <button className="ghost small" disabled={busyAction !== ""} onClick={onArchiveCompleted}>
              <RiInboxArchiveLine className="icon" />
              Archive done
            </button>
          }
        >
          {pendingJobs.length === 0 ? (
            <EmptyState title="No queued jobs" copy="Use the composer or templates to add work." />
          ) : (
            <div className="queue-table-wrap">
              <table className="queue-table">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Prompt</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pendingJobs.slice(0, 12).map((job) => (
                    <tr key={job.id}>
                      <td>
                        <div className="table-primary">
                          <strong>{job.metadata?.project || job.metadata?.templateName || shortText(job.prompt, 32)}</strong>
                          <span>{formatRelative(job.created_at)}</span>
                        </div>
                      </td>
                      <td>{shortText(job.prompt, 84)}</td>
                      <td>
                        <span className={`status-pill status-${job.status}`}>{statusLabel(job.status)}</span>
                      </td>
                      <td>
                        <div className="table-actions">
                          <button className="ghost small icon-button" onClick={() => onDuplicateJob(job)}>
                            <RiFileCopyLine className="icon" />
                          </button>
                          <button className="ghost small icon-button" onClick={() => onDeleteJob(job.id)}>
                            <RiDeleteBinLine className="icon" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Failures" eyebrow="Retry and recover">
          {failedJobs.length === 0 ? (
            <EmptyState title="No failures right now" copy="Problems surface here with quick retry actions." />
          ) : (
            <div className="stack-list">
              {failedJobs.slice(0, 4).map((job) => (
                <article key={job.id} className="failure-card">
                  <div className="failure-head">
                    <div className="status-flag">
                      <RiErrorWarningLine className="icon" />
                      Failed
                    </div>
                    <span>{formatRelative(job.completed_at || job.created_at)}</span>
                  </div>
                  <strong>{shortText(job.prompt, 96)}</strong>
                  <p>{job.error || "Generation failed."}</p>
                  <div className="button-row">
                    <button className="ghost small" onClick={() => onRetryJob(job.id)}>
                      Retry
                    </button>
                    <button className="ghost small" onClick={() => onDuplicateJob(job)}>
                      Duplicate
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Recent archive" eyebrow="Completed">
        {completedJobs.length === 0 && history.length === 0 ? (
          <EmptyState title="Archive is empty" copy="Completed jobs appear here for quick requeueing." />
        ) : (
          <div className="stack-list">
            {completedJobs.slice(0, 6).map((job) => (
              <article key={job.id} className="list-row">
                <div>
                  <strong>{shortText(job.prompt, 130)}</strong>
                  <span>{promptMeta(job)} · {formatDateTime(job.completed_at || job.created_at)}</span>
                </div>
                <button className="ghost small" onClick={() => onDuplicateJob(job)}>
                  Requeue
                </button>
              </article>
            ))}
            {history.slice(0, 6).map((job) => (
              <article key={job.id} className="list-row">
                <div>
                  <strong>{shortText(job.prompt, 130)}</strong>
                  <span>{promptMeta(job)} · {formatDateTime(job.completed_at || job.created_at)}</span>
                </div>
                <button className="ghost small" onClick={() => onDuplicateJob(job)}>
                  Requeue
                </button>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

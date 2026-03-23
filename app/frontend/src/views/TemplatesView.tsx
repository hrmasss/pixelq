import { RiAddLine, RiDeleteBinLine, RiSparkling2Line } from "react-icons/ri";

import { EmptyState, Panel } from "../components/ui";
import { parseTemplateVariables } from "../lib/templates";
import type { Template } from "../types";

interface TemplatesViewProps {
  busyAction: string;
  selectedTemplateId: string | null;
  templateDraft: Template;
  templates: Template[];
  onDeleteTemplate: () => void;
  onSaveTemplate: () => void;
  onSelectTemplate: (template?: Template) => void;
  onTemplateDraftChange: (template: Template) => void;
}

export function TemplatesView({
  busyAction,
  selectedTemplateId,
  templateDraft,
  templates,
  onDeleteTemplate,
  onSaveTemplate,
  onSelectTemplate,
  onTemplateDraftChange,
}: TemplatesViewProps) {
  const variables = parseTemplateVariables(templateDraft);
  const requiredCount = variables.filter((variable) => variable.required).length;
  const templateOptions = templates.filter((template) => template.id);

  return (
    <div className="page templates-page">
      <section className="page-toolbar">
        <div className="page-title">
          <p className="eyebrow">Prompt Studio</p>
          <h1>Templates</h1>
          <p>Use inline placeholders in the prompt body. Required variables are written as <code>{"{subject}"}</code> and defaults as <code>{"{subject=glass perfume bottle}"}</code>.</p>
        </div>
        <div className="page-actions templates-page-actions">
          <label className="compact-select grow template-picker">
            <select
              aria-label="Choose template"
              value={selectedTemplateId || ""}
              onChange={(event) => onSelectTemplate(templateOptions.find((template) => template.id === event.target.value))}
            >
              <option value="">Unsaved draft</option>
              {templateOptions.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" onClick={() => onSelectTemplate()}>
            <RiAddLine className="icon" />
            New
          </button>
          <button className="ghost" disabled={busyAction !== "" || !templateDraft.id} onClick={onDeleteTemplate}>
            <RiDeleteBinLine className="icon" />
            Delete
          </button>
          <button disabled={busyAction !== ""} onClick={onSaveTemplate}>
            <RiSparkling2Line className="icon" />
            Save
          </button>
        </div>
      </section>

      <section className="compact-summary-strip">
        <article className="summary-chip">
          <strong>{variables.length}</strong>
          <span>placeholders</span>
        </article>
        <article className="summary-chip">
          <strong>{requiredCount}</strong>
          <span>required</span>
        </article>
        <article className="summary-chip">
          <strong>{variables.length - requiredCount}</strong>
          <span>with defaults</span>
        </article>
      </section>

      <Panel title={templateDraft.name || "Untitled template"} eyebrow="Template editor">
        <div className="form-grid compact-two-up">
          <label className="field">
            <span>Name</span>
            <input value={templateDraft.name} onChange={(event) => onTemplateDraftChange({ ...templateDraft, name: event.target.value })} placeholder="Cinematic portrait" />
          </label>
          <label className="field">
            <span>Description</span>
            <input value={templateDraft.description || ""} onChange={(event) => onTemplateDraftChange({ ...templateDraft, description: event.target.value })} placeholder="High-contrast portrait system" />
          </label>
        </div>
        <label className="field">
          <span>Prompt body</span>
          <textarea value={templateDraft.body} rows={10} onChange={(event) => onTemplateDraftChange({ ...templateDraft, body: event.target.value })} placeholder="Create a {style} image of {subject=glass perfume bottle} in {lighting} light." />
        </label>
      </Panel>

      <Panel title="Detected placeholders" eyebrow={variables.length > 0 ? "Parsed from the prompt body" : "No placeholders found"}>
        {variables.length === 0 ? (
          <EmptyState title="No placeholders detected" copy="Add placeholders in curly braces inside the prompt body to make the template reusable." />
        ) : (
          <div className="stack-list">
            {variables.map((variable) => (
              <article key={variable.key} className="list-row">
                <div>
                  <strong>{variable.label}</strong>
                  <span>
                    {variable.required ? `{${variable.key}} required` : `{${variable.key}=${variable.defaultValue}} default`}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

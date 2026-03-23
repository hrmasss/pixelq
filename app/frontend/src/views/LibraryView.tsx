import { RiFolderOpenLine, RiImageLine, RiRefreshLine } from "react-icons/ri";

import { EmptyState, Panel } from "../components/ui";
import { formatDateTime, shortText } from "../lib/format";
import type { Asset } from "../types";

interface LibraryViewProps {
  apiBase: string;
  assets: Asset[];
  busyAction: string;
  libraryProjectFilter: string;
  librarySearch: string;
  projects: string[];
  selectedAsset: Asset | undefined;
  selectedAssetId: string | null;
  onOpenAsset: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenLibrary: () => void;
  onProjectFilterChange: (value: string) => void;
  onReindex: () => void;
  onSearchChange: (value: string) => void;
  onSelectAsset: (assetId: string) => void;
}

export function LibraryView({
  apiBase,
  assets,
  busyAction,
  libraryProjectFilter,
  librarySearch,
  projects,
  selectedAsset,
  selectedAssetId,
  onOpenAsset,
  onOpenFolder,
  onOpenLibrary,
  onProjectFilterChange,
  onReindex,
  onSearchChange,
  onSelectAsset,
}: LibraryViewProps) {
  return (
    <div className="page library-page">
      <section className="page-toolbar">
        <div className="page-title">
          <p className="eyebrow">Asset Browser</p>
          <h1>Library</h1>
          <p>Search completed output quickly, then inspect or open the exact file you need.</p>
        </div>
        <div className="page-actions library-page-actions">
          <label className="search-field grow">
            <RiImageLine className="icon" />
            <input value={librarySearch} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search prompts, styles, or projects" />
          </label>
          <label className="compact-select compact-select-inline">
            <select aria-label="Filter by project" value={libraryProjectFilter} onChange={(event) => onProjectFilterChange(event.target.value)}>
              <option value="all">All projects</option>
              {projects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" disabled={busyAction !== ""} onClick={onReindex}>
            <RiRefreshLine className="icon" />
            Reindex
          </button>
          <button className="ghost" onClick={onOpenLibrary}>
            <RiFolderOpenLine className="icon" />
            Open library
          </button>
        </div>
      </section>

      <div className="library-content-grid">
        <Panel title="Assets" eyebrow={`${assets.length} shown`} className="library-grid-panel">
          {assets.length === 0 ? (
            <EmptyState title="No assets matched" copy="Try a broader search or reindex if new files have not appeared yet." />
          ) : (
            <div className="asset-grid">
              {assets.map((asset) => (
                <button key={asset.id} className={`asset-card ${selectedAssetId === asset.id ? "selected" : ""}`} onClick={() => onSelectAsset(asset.id)}>
                  <img src={`${apiBase}/catalog/assets/${asset.id}/preview${asset.thumbPath ? "?kind=thumb" : ""}`} alt={asset.prompt} />
                  <div className="asset-copy">
                    <strong>{asset.project || asset.templateName || "Unfiled"}</strong>
                    <span>{shortText(asset.prompt, 76)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Inspector" eyebrow="Selected asset" className="inspector-panel">
          {!selectedAsset ? (
            <EmptyState title="Choose an asset" copy="Selecting an image reveals the prompt, project metadata, and file actions." />
          ) : (
            <div className="asset-detail">
              <div className="asset-preview">
                <img src={`${apiBase}/catalog/assets/${selectedAsset.id}/preview`} alt={selectedAsset.prompt} />
              </div>
              <div className="asset-detail-copy">
                <strong>{selectedAsset.project || selectedAsset.templateName || "Unfiled asset"}</strong>
                <p>{selectedAsset.prompt}</p>
                <div className="property-list">
                  <div>
                    <span>Imported</span>
                    <strong>{formatDateTime(selectedAsset.importedAt || selectedAsset.createdAt)}</strong>
                  </div>
                  <div>
                    <span>Template</span>
                    <strong>{selectedAsset.templateName || "None"}</strong>
                  </div>
                  <div>
                    <span>Tags</span>
                    <strong>{selectedAsset.tags?.join(", ") || "No tags"}</strong>
                  </div>
                  <div>
                    <span>Path</span>
                    <strong>{selectedAsset.libraryPath}</strong>
                  </div>
                </div>
                <div className="button-row">
                  <button className="ghost" onClick={() => onOpenAsset(selectedAsset.libraryPath)}>
                    Open file
                  </button>
                  <button className="ghost" onClick={() => onOpenFolder(selectedAsset.libraryPath)}>
                    Open folder
                  </button>
                </div>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

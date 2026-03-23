package api

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/pixelq/app/internal/config"
	"github.com/pixelq/app/internal/scheduler"
	"github.com/pixelq/app/internal/service"
	"github.com/pixelq/app/internal/storage"
)

type API struct {
	service *service.Service
}

func New(svc *service.Service) *API {
	return &API{service: svc}
}

func (a *API) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/jobs/archive-completed", a.handleArchiveCompleted)
	mux.HandleFunc("/jobs/batch", a.handleBatch)
	mux.HandleFunc("/jobs", a.handleJobs)
	mux.HandleFunc("/jobs/", a.handleJobByID)
	mux.HandleFunc("/history", a.handleHistory)
	mux.HandleFunc("/scheduler/start", a.handleSchedulerStart)
	mux.HandleFunc("/scheduler/pause", a.handleSchedulerPause)
	mux.HandleFunc("/status", a.handleStatus)
	mux.HandleFunc("/config", a.handleConfig)
	mux.HandleFunc("/templates", a.handleTemplates)
	mux.HandleFunc("/templates/", a.handleTemplateByID)
	mux.HandleFunc("/schedules", a.handleSchedules)
	mux.HandleFunc("/schedules/", a.handleScheduleByID)
	mux.HandleFunc("/schedule-runs", a.handleScheduleRuns)
	mux.HandleFunc("/catalog/assets", a.handleCatalogAssets)
	mux.HandleFunc("/catalog/assets/", a.handleCatalogAssetByID)
	mux.HandleFunc("/catalog/reindex", a.handleCatalogReindex)
	mux.HandleFunc("/bridge/status", a.handleBridgeStatus)
	mux.HandleFunc("/bridge/bootstrap", a.handleBridgeBootstrap)
	mux.HandleFunc("/ws", a.service.Bridge().HandleWebSocket)
	mux.HandleFunc("/events", a.service.Events().HandleWebSocket)
}

func (a *API) handleJobs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		status := storage.JobStatus(r.URL.Query().Get("status"))
		limit := parseLimit(r, 100)
		jobs, err := a.service.ListJobs(status, limit)
		if err != nil {
			jsonError(w, "Failed to list jobs", http.StatusInternalServerError)
			return
		}
		if jobs == nil {
			jobs = []*storage.Job{}
		}
		jsonResponse(w, map[string]interface{}{"jobs": jobs, "count": len(jobs)})
	case http.MethodPost:
		var req struct {
			Prompt   string               `json:"prompt"`
			Priority int                  `json:"priority"`
			Metadata *storage.JobMetadata `json:"metadata,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		job, err := a.service.QueueJob(req.Prompt, req.Priority, req.Metadata)
		if err != nil {
			jsonError(w, "Failed to queue job", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
		jsonResponse(w, job)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *API) handleBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Prompts  []string             `json:"prompts"`
		Jobs     []scheduler.JobInput `json:"jobs"`
		Priority int                  `json:"priority"`
		Metadata *storage.JobMetadata `json:"metadata,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	inputs := make([]scheduler.JobInput, 0)
	if len(req.Jobs) > 0 {
		for _, input := range req.Jobs {
			input.Prompt = strings.TrimSpace(input.Prompt)
			if input.Prompt == "" {
				continue
			}
			inputs = append(inputs, input)
		}
	} else {
		for _, prompt := range req.Prompts {
			prompt = strings.TrimSpace(prompt)
			if prompt == "" {
				continue
			}
			inputs = append(inputs, scheduler.JobInput{
				Prompt:   prompt,
				Priority: req.Priority,
				Metadata: req.Metadata,
			})
		}
	}
	if len(inputs) == 0 {
		jsonError(w, "At least one prompt is required", http.StatusBadRequest)
		return
	}

	jobs, err := a.service.QueueJobs(inputs)
	if err != nil {
		jsonError(w, "Failed to queue jobs", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	jsonResponse(w, map[string]interface{}{"jobs": jobs, "count": len(jobs)})
}

func (a *API) handleJobByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/jobs/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		jsonError(w, "Job ID required", http.StatusBadRequest)
		return
	}
	id := parts[0]
	if len(parts) > 1 && parts[1] == "retry" {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := a.service.RetryJob(id); err != nil {
			jsonError(w, "Failed to retry job", http.StatusInternalServerError)
			return
		}
		job, err := a.service.GetJob(id)
		if err != nil {
			jsonError(w, "Job not found", http.StatusNotFound)
			return
		}
		jsonResponse(w, job)
		return
	}
	if len(parts) > 1 && parts[1] == "cancel" {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := a.service.CancelJob(id); err != nil {
			jsonError(w, "Failed to cancel job", http.StatusInternalServerError)
			return
		}
		job, err := a.service.GetJob(id)
		if err != nil {
			jsonError(w, "Job not found", http.StatusNotFound)
			return
		}
		jsonResponse(w, job)
		return
	}

	switch r.Method {
	case http.MethodGet:
		job, err := a.service.GetJob(id)
		if err != nil {
			jsonError(w, "Job not found", http.StatusNotFound)
			return
		}
		jsonResponse(w, job)
	case http.MethodDelete:
		if err := a.service.DeleteJob(id); err != nil {
			jsonError(w, "Failed to delete job", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *API) handleHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	limit := parseLimit(r, 50)
	jobs, err := a.service.Scheduler().GetHistory(limit)
	if err != nil {
		jsonError(w, "Failed to load history", http.StatusInternalServerError)
		return
	}
	if jobs == nil {
		jobs = []*storage.Job{}
	}
	jsonResponse(w, map[string]interface{}{"jobs": jobs, "count": len(jobs)})
}

func (a *API) handleArchiveCompleted(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	count, err := a.service.ArchiveCompleted()
	if err != nil {
		jsonError(w, "Failed to archive jobs", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, map[string]int{"archived": count})
}

func (a *API) handleSchedulerStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	a.service.Scheduler().Start()
	jsonResponse(w, map[string]bool{"running": true})
}

func (a *API) handleSchedulerPause(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	a.service.Scheduler().Stop()
	jsonResponse(w, map[string]bool{"running": false})
}

func (a *API) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jsonResponse(w, a.service.Status())
}

func (a *API) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, config.Get())
	case http.MethodPut:
		var updates map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
			jsonError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		cfg, err := config.Update(updates)
		if err != nil {
			jsonError(w, "Failed to update config", http.StatusInternalServerError)
			return
		}
		a.service.ApplyRuntimeSettings()
		jsonResponse(w, cfg)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *API) handleTemplates(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		templates, err := a.service.ListTemplates()
		if err != nil {
			jsonError(w, "Failed to list templates", http.StatusInternalServerError)
			return
		}
		if templates == nil {
			templates = []*storage.Template{}
		}
		jsonResponse(w, map[string]interface{}{"templates": templates, "count": len(templates)})
	case http.MethodPost:
		var template storage.Template
		if err := json.NewDecoder(r.Body).Decode(&template); err != nil {
			jsonError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		saved, err := a.service.SaveTemplate(&template)
		if err != nil {
			jsonError(w, "Failed to save template", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
		jsonResponse(w, saved)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *API) handleTemplateByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/templates/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		jsonError(w, "Template ID required", http.StatusBadRequest)
		return
	}
	id := parts[0]

	if len(parts) > 1 && parts[1] == "queue" {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Runs    []storage.TemplateRun `json:"runs"`
			Project string                `json:"project"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		jobs, err := a.service.QueueTemplateRuns(id, req.Runs, req.Project, "", "")
		if err != nil {
			jsonError(w, "Failed to queue template runs", http.StatusInternalServerError)
			return
		}
		jsonResponse(w, map[string]interface{}{"jobs": jobs, "count": len(jobs)})
		return
	}

	switch r.Method {
	case http.MethodGet:
		template, err := a.service.GetTemplate(id)
		if err != nil {
			jsonError(w, "Template not found", http.StatusNotFound)
			return
		}
		jsonResponse(w, template)
	case http.MethodPut:
		var template storage.Template
		if err := json.NewDecoder(r.Body).Decode(&template); err != nil {
			jsonError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		template.ID = id
		saved, err := a.service.SaveTemplate(&template)
		if err != nil {
			jsonError(w, "Failed to save template", http.StatusInternalServerError)
			return
		}
		jsonResponse(w, saved)
	case http.MethodDelete:
		if err := a.service.DeleteTemplate(id); err != nil {
			jsonError(w, "Failed to delete template", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *API) handleSchedules(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		schedules, err := a.service.ListSchedules()
		if err != nil {
			jsonError(w, "Failed to list schedules", http.StatusInternalServerError)
			return
		}
		if schedules == nil {
			schedules = []*storage.Schedule{}
		}
		jsonResponse(w, map[string]interface{}{"schedules": schedules, "count": len(schedules)})
	case http.MethodPost:
		var schedule storage.Schedule
		if err := json.NewDecoder(r.Body).Decode(&schedule); err != nil {
			jsonError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		saved, err := a.service.SaveSchedule(&schedule)
		if err != nil {
			jsonError(w, "Failed to save schedule", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
		jsonResponse(w, saved)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *API) handleScheduleByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/schedules/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		jsonError(w, "Schedule ID required", http.StatusBadRequest)
		return
	}
	id := parts[0]
	if len(parts) > 1 {
		switch parts[1] {
		case "toggle":
			if r.Method != http.MethodPost {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			schedule, err := a.service.ToggleSchedule(id)
			if err != nil {
				jsonError(w, "Failed to toggle schedule", http.StatusInternalServerError)
				return
			}
			jsonResponse(w, schedule)
			return
		case "run-now":
			if r.Method != http.MethodPost {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			run, err := a.service.RunScheduleNow(id)
			if err != nil {
				jsonError(w, "Failed to run schedule", http.StatusInternalServerError)
				return
			}
			jsonResponse(w, run)
			return
		}
	}

	switch r.Method {
	case http.MethodGet:
		schedule, err := a.service.GetSchedule(id)
		if err != nil {
			jsonError(w, "Schedule not found", http.StatusNotFound)
			return
		}
		jsonResponse(w, schedule)
	case http.MethodPut:
		var schedule storage.Schedule
		if err := json.NewDecoder(r.Body).Decode(&schedule); err != nil {
			jsonError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		schedule.ID = id
		saved, err := a.service.SaveSchedule(&schedule)
		if err != nil {
			jsonError(w, "Failed to save schedule", http.StatusInternalServerError)
			return
		}
		jsonResponse(w, saved)
	case http.MethodDelete:
		if err := a.service.DeleteSchedule(id); err != nil {
			jsonError(w, "Failed to delete schedule", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *API) handleScheduleRuns(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	limit := parseLimit(r, 50)
	scheduleID := r.URL.Query().Get("schedule_id")
	runs, err := a.service.ListScheduleRuns(scheduleID, limit)
	if err != nil {
		jsonError(w, "Failed to list schedule runs", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, map[string]interface{}{"runs": runs, "count": len(runs)})
}

func (a *API) handleCatalogAssets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	assets, err := a.service.ListAssets(storage.AssetQuery{
		Search:  r.URL.Query().Get("search"),
		Project: r.URL.Query().Get("project"),
		Tag:     r.URL.Query().Get("tag"),
		Limit:   parseLimit(r, 100),
	})
	if err != nil {
		jsonError(w, "Failed to list assets", http.StatusInternalServerError)
		return
	}
	if assets == nil {
		assets = []*storage.Asset{}
	}
	jsonResponse(w, map[string]interface{}{"assets": assets, "count": len(assets)})
}

func (a *API) handleCatalogAssetByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/catalog/assets/")
	if id == "" {
		jsonError(w, "Asset ID required", http.StatusBadRequest)
		return
	}

	if strings.HasSuffix(id, "/preview") {
		previewID := strings.TrimSuffix(id, "/preview")
		a.handleCatalogAssetPreview(w, r, previewID)
		return
	}

	switch r.Method {
	case http.MethodGet:
		asset, err := a.service.GetAsset(id)
		if err != nil {
			jsonError(w, "Asset not found", http.StatusNotFound)
			return
		}
		jsonResponse(w, asset)
	case http.MethodPut:
		var asset storage.Asset
		if err := json.NewDecoder(r.Body).Decode(&asset); err != nil {
			jsonError(w, "Invalid JSON", http.StatusBadRequest)
			return
		}
		asset.ID = id
		updated, err := a.service.UpdateAsset(&asset)
		if err != nil {
			jsonError(w, "Failed to update asset", http.StatusInternalServerError)
			return
		}
		jsonResponse(w, updated)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *API) handleCatalogAssetPreview(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	asset, err := a.service.GetAsset(id)
	if err != nil {
		jsonError(w, "Asset not found", http.StatusNotFound)
		return
	}

	path := asset.LibraryPath
	if r.URL.Query().Get("kind") == "thumb" && strings.TrimSpace(asset.ThumbPath) != "" {
		path = asset.ThumbPath
	}
	if strings.TrimSpace(path) == "" {
		jsonError(w, "Preview not available", http.StatusNotFound)
		return
	}
	if _, err := os.Stat(path); err != nil {
		jsonError(w, "Preview file not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeFile(w, r, path)
}

func (a *API) handleCatalogReindex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := a.service.ReindexCatalog(); err != nil {
		jsonError(w, "Failed to reindex catalog", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, map[string]bool{"ok": true})
}

func (a *API) handleBridgeStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jsonResponse(w, a.service.BridgeStatus())
}

func (a *API) handleBridgeBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var payload service.BootstrapPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		jsonError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	imported, err := a.service.Bootstrap(payload)
	if err != nil {
		jsonError(w, "Failed to bootstrap desktop data", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, imported)
}

func parseLimit(r *http.Request, fallback int) int {
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			return parsed
		}
	}
	return fallback
}

func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(data)
}

func jsonError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

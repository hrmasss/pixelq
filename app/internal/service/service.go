package service

import (
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pixelq/app/internal/catalog"
	"github.com/pixelq/app/internal/config"
	"github.com/pixelq/app/internal/events"
	"github.com/pixelq/app/internal/limiter"
	"github.com/pixelq/app/internal/power"
	"github.com/pixelq/app/internal/scheduler"
	"github.com/pixelq/app/internal/storage"
	"github.com/pixelq/app/internal/ws"
)

var placeholderPattern = regexp.MustCompile(`\{([^}]+)\}`)

type BootstrapPayload struct {
	Templates []*storage.Template `json:"templates"`
	Jobs      []*storage.Job      `json:"jobs"`
	History   []*storage.Job      `json:"history"`
}

type Service struct {
	cfg       *config.Config
	store     *storage.Store
	limiter   *limiter.Limiter
	scheduler *scheduler.Scheduler
	bridge    *ws.Hub
	events    *events.Hub
	catalog   *catalog.Manager

	stopCh chan struct{}
	wg     sync.WaitGroup
}

func New() (*Service, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}

	store, err := storage.New()
	if err != nil {
		return nil, err
	}
	if removed, purgeErr := store.PurgeLegacyPlaceholderJobs(); purgeErr != nil {
		log.Printf("failed to purge legacy placeholder jobs: %v", purgeErr)
	} else if removed > 0 {
		log.Printf("purged %d legacy placeholder jobs", removed)
	}

	svc := &Service{
		cfg:     cfg,
		store:   store,
		limiter: limiter.New(),
		bridge:  ws.NewHub(),
		events:  events.NewHub(),
		catalog: catalog.New(store),
		stopCh:  make(chan struct{}),
	}
	svc.scheduler = scheduler.New(store, svc.limiter)
	svc.bind()

	return svc, nil
}

func (s *Service) bind() {
	s.bridge.OnConnect(func(client *ws.Client) {
		log.Println("Extension connected")
		client.Send(ws.Message{Type: "check_status"})
		s.publish("bridge.status", s.BridgeStatus())
	})
	s.bridge.OnDisconnect(func(client *ws.Client) {
		s.publish("bridge.status", s.BridgeStatus())
	})
	s.bridge.OnMessage(func(client *ws.Client, msg ws.Message) {
		s.handleBridgeMessage(msg)
	})
	s.scheduler.OnJobReady(func(job *storage.Job) {
		if !s.bridge.HasReadyClient() {
			log.Printf("No ready extension client, job %s waiting", job.ID)
			return
		}
		log.Printf("Sending job %s to extension", job.ID)
		s.bridge.SendToReady(ws.Message{
			Type:   "submit_prompt",
			ID:     job.ID,
			Prompt: job.Prompt,
		})
		s.publish("job.updated", map[string]string{"id": job.ID, "status": string(storage.StatusScheduled)})
	})
}

func (s *Service) Start() {
	s.ApplyRuntimeSettings()
	go s.bridge.Run()
	s.scheduler.Start()

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.scheduleLoop()
	}()
}

func (s *Service) Stop() error {
	close(s.stopCh)
	s.scheduler.Stop()
	_ = power.SetKeepAwake(false)
	s.wg.Wait()
	return s.store.Close()
}

func (s *Service) Store() *storage.Store {
	return s.store
}

func (s *Service) Scheduler() *scheduler.Scheduler {
	return s.scheduler
}

func (s *Service) Bridge() *ws.Hub {
	return s.bridge
}

func (s *Service) Events() *events.Hub {
	return s.events
}

func (s *Service) Catalog() *catalog.Manager {
	return s.catalog
}

func (s *Service) ApplyRuntimeSettings() {
	if err := power.SetKeepAwake(s.cfg.KeepAwake); err != nil {
		log.Printf("failed to apply keep-awake state: %v", err)
	}
}

func (s *Service) QueueJob(prompt string, priority int, metadata *storage.JobMetadata) (*storage.Job, error) {
	job, err := s.scheduler.QueueJob(strings.TrimSpace(prompt), priority, metadata)
	if err == nil {
		s.publish("job.updated", job)
	}
	return job, err
}

func (s *Service) QueueJobs(inputs []scheduler.JobInput) ([]*storage.Job, error) {
	jobs, err := s.scheduler.QueueJobsDetailed(inputs)
	if err == nil {
		for _, job := range jobs {
			s.publish("job.updated", job)
		}
	}
	return jobs, err
}

func (s *Service) ListJobs(status storage.JobStatus, limit int) ([]*storage.Job, error) {
	return s.scheduler.ListJobs(status, limit)
}

func (s *Service) GetJob(id string) (*storage.Job, error) {
	return s.scheduler.GetJob(id)
}

func (s *Service) DeleteJob(id string) error {
	err := s.scheduler.DeleteJob(id)
	if err == nil {
		s.publish("job.updated", map[string]string{"id": id, "deleted": "true"})
	}
	return err
}

func (s *Service) CancelJob(id string) error {
	err := s.scheduler.CancelJob(id)
	if err == nil {
		if job, getErr := s.scheduler.GetJob(id); getErr == nil {
			s.publish("job.updated", job)
		}
	}
	return err
}

func (s *Service) RetryJob(id string) error {
	err := s.scheduler.RetryJob(id)
	if err == nil {
		if job, getErr := s.scheduler.GetJob(id); getErr == nil {
			s.publish("job.updated", job)
		}
	}
	return err
}

func (s *Service) ArchiveCompleted() (int, error) {
	count, err := s.scheduler.ArchiveCompleted()
	if err == nil {
		s.publish("job.updated", map[string]int{"archived": count})
	}
	return count, err
}

func (s *Service) ListTemplates() ([]*storage.Template, error) {
	return s.store.ListTemplates()
}

func (s *Service) GetTemplate(id string) (*storage.Template, error) {
	return s.store.GetTemplate(id)
}

func (s *Service) SaveTemplate(template *storage.Template) (*storage.Template, error) {
	saved, err := s.store.SaveTemplate(template)
	if err == nil {
		s.publish("template.updated", saved)
	}
	return saved, err
}

func (s *Service) DeleteTemplate(id string) error {
	err := s.store.DeleteTemplate(id)
	if err == nil {
		s.publish("template.updated", map[string]string{"id": id, "deleted": "true"})
	}
	return err
}

func (s *Service) QueueTemplateRuns(templateID string, runs []storage.TemplateRun, project string, scheduleID string, scheduleRunID string) ([]*storage.Job, error) {
	template, err := s.store.GetTemplate(templateID)
	if err != nil {
		return nil, err
	}

	inputs := make([]scheduler.JobInput, 0, len(runs))
	for index, run := range runs {
		prompt, values, err := resolveTemplate(template, run)
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, scheduler.JobInput{
			Prompt:        prompt,
			Priority:      len(runs) - index,
			ScheduleID:    scheduleID,
			ScheduleRunID: scheduleRunID,
			Metadata: &storage.JobMetadata{
				Source:       sourceForSchedule(scheduleID),
				Project:      project,
				TemplateID:   template.ID,
				TemplateName: template.Name,
				Variables:    values,
			},
		})
	}

	return s.QueueJobs(inputs)
}

func (s *Service) ListSchedules() ([]*storage.Schedule, error) {
	return s.store.ListSchedules()
}

func (s *Service) GetSchedule(id string) (*storage.Schedule, error) {
	return s.store.GetSchedule(id)
}

func (s *Service) SaveSchedule(schedule *storage.Schedule) (*storage.Schedule, error) {
	if schedule.Timezone == "" {
		schedule.Timezone = time.Now().Location().String()
	}
	nextRunAt, err := nextScheduleRun(schedule, time.Now())
	if err != nil {
		return nil, err
	}
	if schedule.Enabled {
		schedule.NextRunAt = nextRunAt
	} else {
		schedule.NextRunAt = time.Time{}
	}

	saved, err := s.store.SaveSchedule(schedule)
	if err == nil {
		s.publish("schedule.updated", saved)
	}
	return saved, err
}

func (s *Service) DeleteSchedule(id string) error {
	err := s.store.DeleteSchedule(id)
	if err == nil {
		s.publish("schedule.updated", map[string]string{"id": id, "deleted": "true"})
	}
	return err
}

func (s *Service) ToggleSchedule(id string) (*storage.Schedule, error) {
	schedule, err := s.store.GetSchedule(id)
	if err != nil {
		return nil, err
	}
	schedule.Enabled = !schedule.Enabled
	return s.SaveSchedule(schedule)
}

func (s *Service) RunScheduleNow(id string) (*storage.ScheduleRun, error) {
	schedule, err := s.store.GetSchedule(id)
	if err != nil {
		return nil, err
	}
	return s.executeSchedule(schedule, time.Now())
}

func (s *Service) ListScheduleRuns(scheduleID string, limit int) ([]*storage.ScheduleRun, error) {
	return s.store.ListScheduleRuns(scheduleID, limit)
}

func (s *Service) ListAssets(query storage.AssetQuery) ([]*storage.Asset, error) {
	return s.store.ListAssets(query)
}

func (s *Service) GetAsset(id string) (*storage.Asset, error) {
	return s.store.GetAsset(id)
}

func (s *Service) UpdateAsset(asset *storage.Asset) (*storage.Asset, error) {
	updated, err := s.store.UpdateAsset(asset)
	if err == nil {
		s.publish("asset.imported", updated)
	}
	return updated, err
}

func (s *Service) ReindexCatalog() error {
	return s.catalog.Reindex()
}

func (s *Service) IngestManifest(manifest catalog.DownloadManifest) ([]*storage.Asset, error) {
	assets, err := s.catalog.IngestManifest(manifest)
	if err == nil {
		for _, asset := range assets {
			s.publish("asset.imported", asset)
		}
	}
	return assets, err
}

func (s *Service) Bootstrap(payload BootstrapPayload) (map[string]int, error) {
	imported := map[string]int{
		"templates": 0,
		"jobs":      0,
		"history":   0,
	}

	if templateCount, _ := s.store.TemplateCount(); templateCount == 0 {
		for _, template := range payload.Templates {
			if _, err := s.store.SaveTemplate(template); err != nil {
				return nil, err
			}
			imported["templates"]++
		}
	}

	if jobCount, _ := s.store.JobCount(); jobCount == 0 {
		for _, job := range payload.Jobs {
			if _, err := s.store.CreateJobWithOptions(job); err != nil {
				return nil, err
			}
			imported["jobs"]++
		}
	}

	if historyCount, _ := s.store.HistoryCount(); historyCount == 0 {
		for _, job := range payload.History {
			if err := s.store.SaveHistoryJob(job); err != nil {
				return nil, err
			}
			imported["history"]++
		}
	}

	return imported, nil
}

func (s *Service) BridgeStatus() map[string]interface{} {
	templateCount, _ := s.store.TemplateCount()
	jobCount, _ := s.store.JobCount()
	historyCount, _ := s.store.HistoryCount()
	assetCount, _ := s.store.AssetCount()
	clients := s.bridge.Snapshot()
	readyClients := 0
	tabURL := ""
	for _, client := range clients {
		if client.Ready {
			readyClients++
		}
		if tabURL == "" && client.TabURL != "" {
			tabURL = client.TabURL
		}
	}

	bridgeState := "disconnected"
	if len(clients) > 0 {
		bridgeState = "connected"
	}
	if readyClients > 0 {
		bridgeState = "ready"
	}

	return map[string]interface{}{
		"extension_connected": s.bridge.HasConnections(),
		"extension_ready":     s.bridge.HasReadyClient(),
		"client_count":        s.bridge.ClientCount(),
		"ready_client_count":  readyClients,
		"bridge_state":        bridgeState,
		"extension_tab_url":   tabURL,
		"bridge_clients":      clients,
		"templates":           templateCount,
		"jobs":                jobCount,
		"history":             historyCount,
		"assets":              assetCount,
		"needs_bootstrap":     templateCount == 0 && jobCount == 0 && historyCount == 0,
	}
}

func (s *Service) Status() map[string]interface{} {
	stats := s.scheduler.Stats()
	scheduleCount, _ := countSchedules(s.store)
	templateCount, _ := s.store.TemplateCount()
	assetCount, _ := s.store.AssetCount()
	for key, value := range s.BridgeStatus() {
		stats[key] = value
	}
	stats["schedule_count"] = scheduleCount
	stats["template_count"] = templateCount
	stats["asset_count"] = assetCount
	stats["downloads_inbox"] = s.cfg.DownloadsInbox
	stats["library_root"] = s.cfg.LibraryRoot
	stats["version"] = "0.1.1-alpha"
	return stats
}

func (s *Service) handleBridgeMessage(msg ws.Message) {
	switch msg.Type {
	case "prompt_submitted":
		_ = s.scheduler.MarkInProgress(msg.ID)
		s.publish("job.updated", map[string]string{"id": msg.ID, "status": string(storage.StatusInProgress)})
	case "generation_complete":
		_ = s.scheduler.MarkCompleted(msg.ID, msg.Images)
		if job, err := s.scheduler.GetJob(msg.ID); err == nil {
			s.publish("job.updated", job)
		}
	case "generation_failed":
		_ = s.scheduler.MarkFailed(msg.ID, msg.Error)
		if job, err := s.scheduler.GetJob(msg.ID); err == nil {
			s.publish("job.updated", job)
		}
	case "rate_limited":
		_ = s.scheduler.MarkRateLimited(msg.ID)
		if job, err := s.scheduler.GetJob(msg.ID); err == nil {
			s.publish("job.updated", job)
		}
	case "download_manifest":
		var manifest catalog.DownloadManifest
		if err := msg.Decode(&manifest); err != nil {
			log.Printf("failed to decode download manifest: %v", err)
			return
		}
		assets, err := s.IngestManifest(manifest)
		if err != nil {
			log.Printf("failed to ingest manifest for job %s: %v", manifest.JobID, err)
			return
		}
		s.publish("asset.imported", map[string]interface{}{
			"jobId":  manifest.JobID,
			"count":  len(assets),
			"assets": assets,
		})
	case "status":
		s.publish("bridge.status", s.BridgeStatus())
	}
}

func (s *Service) scheduleLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.runDueSchedules()
		}
	}
}

func (s *Service) runDueSchedules() {
	now := time.Now()
	schedules, err := s.store.ListDueSchedules(now)
	if err != nil {
		log.Printf("failed to list due schedules: %v", err)
		return
	}

	for _, schedule := range schedules {
		if _, err := s.executeSchedule(schedule, now); err != nil {
			log.Printf("failed to execute schedule %s: %v", schedule.ID, err)
		}
	}
}

func (s *Service) executeSchedule(schedule *storage.Schedule, now time.Time) (*storage.ScheduleRun, error) {
	run, err := s.store.CreateScheduleRun(&storage.ScheduleRun{
		ScheduleID:  schedule.ID,
		TemplateID:  schedule.TemplateID,
		TriggeredAt: now,
		Status:      "queued",
	})
	if err != nil {
		return nil, err
	}

	jobs, err := s.QueueTemplateRuns(schedule.TemplateID, schedule.Runs, schedule.Project, schedule.ID, run.ID)
	if err != nil {
		run.Status = "failed"
		run.Error = err.Error()
		_ = s.store.UpdateScheduleRun(run)
		return nil, err
	}
	for _, job := range jobs {
		run.JobIDs = append(run.JobIDs, job.ID)
	}
	run.Status = "submitted"
	if err := s.store.UpdateScheduleRun(run); err != nil {
		return nil, err
	}

	schedule.LastRunAt = now
	if schedule.Enabled {
		nextRunAt, err := nextScheduleRun(schedule, now.Add(time.Second))
		if err != nil {
			return nil, err
		}
		schedule.NextRunAt = nextRunAt
	}
	if _, err := s.SaveSchedule(schedule); err != nil {
		return nil, err
	}

	s.publish("schedule_run.created", run)
	return run, nil
}

func (s *Service) publish(eventType string, data interface{}) {
	s.events.Broadcast(events.Event{Type: eventType, Data: data})
}

func resolveTemplate(template *storage.Template, run storage.TemplateRun) (string, map[string]string, error) {
	if template == nil {
		return "", nil, errors.New("template is required")
	}
	variables := templateVariables(template)
	values := map[string]string{}
	missingRequired := []string{}
	for _, variable := range variables {
		value := ""
		if run.Values != nil {
			value = strings.TrimSpace(run.Values[variable.Key])
		}
		if value == "" {
			value = strings.TrimSpace(variable.DefaultValue)
		}
		values[variable.Key] = value
		if variable.Required && value == "" {
			missingRequired = append(missingRequired, variable.Key)
		}
	}
	if len(missingRequired) > 0 {
		return "", nil, fmt.Errorf("missing required variables: %s", strings.Join(missingRequired, ", "))
	}

	missingPlaceholders := []string{}
	prompt := placeholderPattern.ReplaceAllStringFunc(template.Body, func(match string) string {
		key, _ := parsePlaceholder(strings.TrimSpace(strings.Trim(match, "{}")))
		if values[key] == "" {
			missingPlaceholders = append(missingPlaceholders, key)
			return match
		}
		return values[key]
	})
	if len(missingPlaceholders) > 0 {
		return "", nil, fmt.Errorf("unresolved placeholders: %s", strings.Join(missingPlaceholders, ", "))
	}

	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "", nil, errors.New("resolved prompt is empty")
	}
	return prompt, values, nil
}

func templateVariables(template *storage.Template) []storage.TemplateVariable {
	if template == nil {
		return nil
	}

	variables := map[string]storage.TemplateVariable{}
	for _, variable := range template.Variables {
		if strings.TrimSpace(variable.Key) == "" {
			continue
		}
		if strings.TrimSpace(variable.Label) == "" {
			variable.Label = prettifyVariableKey(variable.Key)
		}
		variables[variable.Key] = variable
	}

	matches := placeholderPattern.FindAllStringSubmatch(template.Body, -1)
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		key, defaultValue := parsePlaceholder(match[1])
		if key == "" {
			continue
		}
		current := variables[key]
		current.Key = key
		if current.Label == "" {
			current.Label = prettifyVariableKey(key)
		}
		if defaultValue != "" {
			current.DefaultValue = defaultValue
			current.Required = false
		} else {
			current.Required = true
		}
		variables[key] = current
	}

	result := make([]storage.TemplateVariable, 0, len(variables))
	for _, variable := range variables {
		result = append(result, variable)
	}
	return result
}

func parsePlaceholder(raw string) (string, string) {
	parts := strings.SplitN(strings.TrimSpace(raw), "=", 2)
	key := strings.TrimSpace(parts[0])
	if len(parts) == 1 {
		return key, ""
	}
	return key, strings.TrimSpace(parts[1])
}

func prettifyVariableKey(value string) string {
	normalized := strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(value), "_", " "), "-", " ")
	words := strings.Fields(normalized)
	for index, word := range words {
		if word == "" {
			continue
		}
		words[index] = strings.ToUpper(word[:1]) + strings.ToLower(word[1:])
	}
	return strings.Join(words, " ")
}

func nextScheduleRun(schedule *storage.Schedule, now time.Time) (time.Time, error) {
	if schedule == nil {
		return time.Time{}, errors.New("schedule is required")
	}
	if !schedule.Enabled {
		return time.Time{}, nil
	}
	location, err := time.LoadLocation(schedule.Timezone)
	if err != nil {
		location = time.Local
	}
	localNow := now.In(location)

	parts := strings.Split(schedule.TimeOfDay, ":")
	if len(parts) != 2 {
		return time.Time{}, fmt.Errorf("invalid timeOfDay: %s", schedule.TimeOfDay)
	}
	hour := atoiDefault(parts[0], 0)
	minute := atoiDefault(parts[1], 0)

	candidate := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), hour, minute, 0, 0, location)

	switch strings.ToLower(schedule.Frequency) {
	case "daily":
		if !candidate.After(localNow) {
			candidate = candidate.Add(24 * time.Hour)
		}
	case "weekly":
		days := normalizeWeekdays(schedule.DaysOfWeek)
		if len(days) == 0 {
			days = map[time.Weekday]bool{candidate.Weekday(): true}
		}
		for i := 0; i < 8; i++ {
			next := candidate.AddDate(0, 0, i)
			if !next.After(localNow) {
				continue
			}
			if days[next.Weekday()] {
				return next.UTC(), nil
			}
		}
		return time.Time{}, errors.New("failed to resolve weekly schedule")
	default:
		return time.Time{}, fmt.Errorf("unsupported frequency: %s", schedule.Frequency)
	}

	return candidate.UTC(), nil
}

func normalizeWeekdays(values []string) map[time.Weekday]bool {
	lookup := map[string]time.Weekday{
		"sun": time.Sunday,
		"mon": time.Monday,
		"tue": time.Tuesday,
		"wed": time.Wednesday,
		"thu": time.Thursday,
		"fri": time.Friday,
		"sat": time.Saturday,
	}
	days := map[time.Weekday]bool{}
	for _, value := range values {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if len(normalized) < 3 {
			continue
		}
		if weekday, ok := lookup[normalized[:3]]; ok {
			days[weekday] = true
		}
	}
	return days
}

func countSchedules(store *storage.Store) (int, error) {
	schedules, err := store.ListSchedules()
	if err != nil {
		return 0, err
	}
	return len(schedules), nil
}

func sourceForSchedule(scheduleID string) string {
	if scheduleID != "" {
		return "schedule"
	}
	return "template"
}

func atoiDefault(value string, fallback int) int {
	var parsed int
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil {
		return fallback
	}
	return parsed
}

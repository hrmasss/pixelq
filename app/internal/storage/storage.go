package storage

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"

	"github.com/pixelq/app/internal/config"
)

type JobStatus string

const (
	StatusPending    JobStatus = "pending"
	StatusScheduled  JobStatus = "scheduled"
	StatusInProgress JobStatus = "in_progress"
	StatusCompleted  JobStatus = "completed"
	StatusFailed     JobStatus = "failed"
	StatusCancelled  JobStatus = "cancelled"
)

type JobMetadata struct {
	Source       string            `json:"source,omitempty"`
	Project      string            `json:"project,omitempty"`
	TemplateID   string            `json:"templateId,omitempty"`
	TemplateName string            `json:"templateName,omitempty"`
	Variables    map[string]string `json:"variables,omitempty"`
}

type Job struct {
	ID            string       `json:"id"`
	Prompt        string       `json:"prompt"`
	Status        JobStatus    `json:"status"`
	ImageURLs     []string     `json:"image_urls"`
	Error         string       `json:"error,omitempty"`
	CreatedAt     time.Time    `json:"created_at"`
	ScheduledAt   time.Time    `json:"scheduled_at,omitempty"`
	StartedAt     time.Time    `json:"started_at,omitempty"`
	CompletedAt   time.Time    `json:"completed_at,omitempty"`
	ArchivedAt    time.Time    `json:"archived_at,omitempty"`
	Retries       int          `json:"retries"`
	Priority      int          `json:"priority"`
	ScheduleID    string       `json:"scheduleId,omitempty"`
	ScheduleRunID string       `json:"scheduleRunId,omitempty"`
	AssetCount    int          `json:"assetCount"`
	IngestStatus  string       `json:"ingestStatus,omitempty"`
	Metadata      *JobMetadata `json:"metadata,omitempty"`
}

type Store struct {
	db *sql.DB
}

func New() (*Store, error) {
	dbPath := filepath.Join(config.DataDir(), "pixelq.db")

	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)

	store := &Store{db: db}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, err
	}

	return store, nil
}

func (s *Store) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS jobs (
		id TEXT PRIMARY KEY,
		prompt TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		image_urls TEXT DEFAULT '[]',
		error TEXT DEFAULT '',
		created_at DATETIME NOT NULL,
		scheduled_at DATETIME,
		started_at DATETIME,
		completed_at DATETIME,
		retries INTEGER DEFAULT 0,
		priority INTEGER DEFAULT 0,
		schedule_id TEXT DEFAULT '',
		schedule_run_id TEXT DEFAULT '',
		asset_count INTEGER DEFAULT 0,
		ingest_status TEXT DEFAULT '',
		source TEXT DEFAULT '',
		project TEXT DEFAULT '',
		template_id TEXT DEFAULT '',
		template_name TEXT DEFAULT '',
		variables_json TEXT DEFAULT '{}'
	);

	CREATE TABLE IF NOT EXISTS history (
		id TEXT PRIMARY KEY,
		prompt TEXT NOT NULL,
		status TEXT NOT NULL,
		image_urls TEXT DEFAULT '[]',
		error TEXT DEFAULT '',
		created_at DATETIME NOT NULL,
		scheduled_at DATETIME,
		started_at DATETIME,
		completed_at DATETIME,
		archived_at DATETIME NOT NULL,
		retries INTEGER DEFAULT 0,
		priority INTEGER DEFAULT 0,
		schedule_id TEXT DEFAULT '',
		schedule_run_id TEXT DEFAULT '',
		asset_count INTEGER DEFAULT 0,
		ingest_status TEXT DEFAULT '',
		source TEXT DEFAULT '',
		project TEXT DEFAULT '',
		template_id TEXT DEFAULT '',
		template_name TEXT DEFAULT '',
		variables_json TEXT DEFAULT '{}'
	);

	CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
	CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
	CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority DESC, created_at ASC);
	CREATE INDEX IF NOT EXISTS idx_history_archived_at ON history(archived_at DESC);
	`

	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	jobColumns := map[string]string{
		"archived_at":     "DATETIME",
		"source":          "TEXT DEFAULT ''",
		"project":         "TEXT DEFAULT ''",
		"template_id":     "TEXT DEFAULT ''",
		"template_name":   "TEXT DEFAULT ''",
		"variables_json":  "TEXT DEFAULT '{}'",
		"schedule_id":     "TEXT DEFAULT ''",
		"schedule_run_id": "TEXT DEFAULT ''",
		"asset_count":     "INTEGER DEFAULT 0",
		"ingest_status":   "TEXT DEFAULT ''",
	}

	historyColumns := map[string]string{
		"archived_at":     "DATETIME",
		"source":          "TEXT DEFAULT ''",
		"project":         "TEXT DEFAULT ''",
		"template_id":     "TEXT DEFAULT ''",
		"template_name":   "TEXT DEFAULT ''",
		"variables_json":  "TEXT DEFAULT '{}'",
		"schedule_id":     "TEXT DEFAULT ''",
		"schedule_run_id": "TEXT DEFAULT ''",
		"asset_count":     "INTEGER DEFAULT 0",
		"ingest_status":   "TEXT DEFAULT ''",
	}

	if err := s.ensureColumns("jobs", jobColumns); err != nil {
		return err
	}

	if err := s.ensureColumns("history", historyColumns); err != nil {
		return err
	}

	return s.migrateEntities()
}

func (s *Store) ensureColumns(table string, columns map[string]string) error {
	existing, err := s.tableColumns(table)
	if err != nil {
		return err
	}

	for name, definition := range columns {
		if existing[name] {
			continue
		}
		if _, err := s.db.Exec("ALTER TABLE " + table + " ADD COLUMN " + name + " " + definition); err != nil {
			return err
		}
	}

	return nil
}

func (s *Store) tableColumns(table string) (map[string]bool, error) {
	rows, err := s.db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns := make(map[string]bool)
	for rows.Next() {
		var cid int
		var name, colType string
		var notNull, pk int
		var defaultValue interface{}
		if err := rows.Scan(&cid, &name, &colType, &notNull, &defaultValue, &pk); err != nil {
			return nil, err
		}
		columns[name] = true
	}

	return columns, rows.Err()
}

func (s *Store) CreateJob(prompt string, priority int, metadata *JobMetadata) (*Job, error) {
	job := &Job{
		ID:        uuid.New().String(),
		Prompt:    prompt,
		Status:    StatusPending,
		ImageURLs: []string{},
		CreatedAt: time.Now(),
		Priority:  priority,
		Metadata:  sanitizeMetadata(metadata),
	}

	_, err := s.db.Exec(`
		INSERT INTO jobs (
			id, prompt, status, image_urls, created_at, priority,
			schedule_id, schedule_run_id, asset_count, ingest_status,
			source, project, template_id, template_name, variables_json
		)
		VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		job.ID,
		job.Prompt,
		job.Status,
		job.CreatedAt,
		job.Priority,
		job.ScheduleID,
		job.ScheduleRunID,
		job.AssetCount,
		job.IngestStatus,
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.Source }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.Project }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.TemplateID }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.TemplateName }),
		serializeVariables(job.Metadata),
	)
	if err != nil {
		return nil, err
	}

	return job, nil
}

func (s *Store) CreateJobWithOptions(job *Job) (*Job, error) {
	if job == nil {
		return nil, sql.ErrNoRows
	}
	if job.ID == "" {
		job.ID = uuid.New().String()
	}
	if job.CreatedAt.IsZero() {
		job.CreatedAt = time.Now()
	}
	job.Metadata = sanitizeMetadata(job.Metadata)

	_, err := s.db.Exec(`
		INSERT OR REPLACE INTO jobs (
			id, prompt, status, image_urls, error, created_at, scheduled_at, started_at, completed_at,
			retries, priority, schedule_id, schedule_run_id, asset_count, ingest_status,
			source, project, template_id, template_name, variables_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		job.ID,
		job.Prompt,
		defaultJobStatus(job.Status),
		serializeURLs(job.ImageURLs),
		job.Error,
		job.CreatedAt,
		nullTime(job.ScheduledAt),
		nullTime(job.StartedAt),
		nullTime(job.CompletedAt),
		job.Retries,
		job.Priority,
		job.ScheduleID,
		job.ScheduleRunID,
		job.AssetCount,
		job.IngestStatus,
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.Source }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.Project }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.TemplateID }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.TemplateName }),
		serializeVariables(job.Metadata),
	)
	if err != nil {
		return nil, err
	}

	return s.GetJob(job.ID)
}

func (s *Store) GetJob(id string) (*Job, error) {
	row := s.db.QueryRow(jobSelect("jobs", "WHERE id = ?"), id)
	return scanJob(row)
}

func (s *Store) GetHistoryJob(id string) (*Job, error) {
	row := s.db.QueryRow(jobSelect("history", "WHERE id = ?"), id)
	return scanJob(row)
}

func (s *Store) ListJobs(status JobStatus, limit int) ([]*Job, error) {
	var (
		rows *sql.Rows
		err  error
	)

	if status == "" {
		rows, err = s.db.Query(jobSelect("jobs", "ORDER BY priority DESC, created_at ASC LIMIT ?"), limit)
	} else {
		rows, err = s.db.Query(jobSelect("jobs", "WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?"), status, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanJobs(rows)
}

func (s *Store) GetNextPending() (*Job, error) {
	row := s.db.QueryRow(jobSelect("jobs", "WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1"))
	return scanJob(row)
}

func (s *Store) UpdateStatus(id string, status JobStatus) error {
	var (
		query string
		args  []interface{}
	)

	switch status {
	case StatusScheduled:
		query = `UPDATE jobs SET status = ?, scheduled_at = ? WHERE id = ?`
		args = []interface{}{status, time.Now(), id}
	case StatusInProgress:
		query = `UPDATE jobs SET status = ?, started_at = ? WHERE id = ?`
		args = []interface{}{status, time.Now(), id}
	case StatusCompleted, StatusFailed, StatusCancelled:
		query = `UPDATE jobs SET status = ?, completed_at = ? WHERE id = ?`
		args = []interface{}{status, time.Now(), id}
	default:
		query = `UPDATE jobs SET status = ? WHERE id = ?`
		args = []interface{}{status, id}
	}

	_, err := s.db.Exec(query, args...)
	return err
}

func (s *Store) SetJobImages(id string, urls []string) error {
	_, err := s.db.Exec(`UPDATE jobs SET image_urls = ? WHERE id = ?`, serializeURLs(urls), id)
	return err
}

func (s *Store) SetJobError(id string, errMsg string) error {
	_, err := s.db.Exec(`UPDATE jobs SET error = ? WHERE id = ?`, errMsg, id)
	return err
}

func (s *Store) UpdateJobIngest(id string, assetCount int, ingestStatus string) error {
	_, err := s.db.Exec(`UPDATE jobs SET asset_count = ?, ingest_status = ? WHERE id = ?`, assetCount, ingestStatus, id)
	return err
}

func (s *Store) IncrementRetries(id string) (int, error) {
	if _, err := s.db.Exec(`UPDATE jobs SET retries = retries + 1 WHERE id = ?`, id); err != nil {
		return 0, err
	}

	var retries int
	err := s.db.QueryRow(`SELECT retries FROM jobs WHERE id = ?`, id).Scan(&retries)
	return retries, err
}

func (s *Store) DeleteJob(id string) error {
	_, err := s.db.Exec(`DELETE FROM jobs WHERE id = ?`, id)
	return err
}

func (s *Store) ClearCompleted() error {
	_, err := s.db.Exec(`DELETE FROM jobs WHERE status IN ('completed', 'failed')`)
	return err
}

func (s *Store) ArchiveCompleted() (int, error) {
	jobs, err := s.ListArchivableJobs()
	if err != nil {
		return 0, err
	}

	if len(jobs) == 0 {
		return 0, nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	now := time.Now()
	for _, job := range jobs {
		job.ArchivedAt = now
		if _, err := tx.Exec(`
			INSERT OR REPLACE INTO history (
				id, prompt, status, image_urls, error, created_at, scheduled_at, started_at,
				completed_at, archived_at, retries, priority, schedule_id, schedule_run_id,
				asset_count, ingest_status, source, project, template_id,
				template_name, variables_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
			job.ID,
			job.Prompt,
			job.Status,
			serializeURLs(job.ImageURLs),
			job.Error,
			job.CreatedAt,
			nullTime(job.ScheduledAt),
			nullTime(job.StartedAt),
			nullTime(job.CompletedAt),
			job.ArchivedAt,
			job.Retries,
			job.Priority,
			job.ScheduleID,
			job.ScheduleRunID,
			job.AssetCount,
			job.IngestStatus,
			metadataValue(job.Metadata, func(m *JobMetadata) string { return m.Source }),
			metadataValue(job.Metadata, func(m *JobMetadata) string { return m.Project }),
			metadataValue(job.Metadata, func(m *JobMetadata) string { return m.TemplateID }),
			metadataValue(job.Metadata, func(m *JobMetadata) string { return m.TemplateName }),
			serializeVariables(job.Metadata),
		); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(`DELETE FROM jobs WHERE id = ?`, job.ID); err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	return len(jobs), nil
}

func (s *Store) ListArchivableJobs() ([]*Job, error) {
	rows, err := s.db.Query(jobSelect("jobs", "WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC, created_at DESC"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanJobs(rows)
}

func (s *Store) ResetJob(id string) error {
	_, err := s.db.Exec(`
		UPDATE jobs
		SET status = 'pending', error = '', scheduled_at = NULL, started_at = NULL, completed_at = NULL
		WHERE id = ?
	`, id)
	return err
}

func (s *Store) CountByStatus() (map[JobStatus]int, error) {
	rows, err := s.db.Query(`SELECT status, COUNT(*) FROM jobs GROUP BY status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := make(map[JobStatus]int)
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		counts[JobStatus(status)] = count
	}

	return counts, rows.Err()
}

func (s *Store) GetHistory(limit int) ([]*Job, error) {
	rows, err := s.db.Query(jobSelect("history", "ORDER BY archived_at DESC, completed_at DESC LIMIT ?"), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanJobs(rows)
}

func (s *Store) SaveHistoryJob(job *Job) error {
	if job == nil {
		return sql.ErrNoRows
	}
	if job.ID == "" {
		job.ID = uuid.New().String()
	}
	if job.CreatedAt.IsZero() {
		job.CreatedAt = time.Now()
	}
	if job.ArchivedAt.IsZero() {
		job.ArchivedAt = time.Now()
	}
	job.Metadata = sanitizeMetadata(job.Metadata)

	_, err := s.db.Exec(`
		INSERT OR REPLACE INTO history (
			id, prompt, status, image_urls, error, created_at, scheduled_at, started_at,
			completed_at, archived_at, retries, priority, schedule_id, schedule_run_id,
			asset_count, ingest_status, source, project, template_id, template_name, variables_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		job.ID,
		job.Prompt,
		defaultJobStatus(job.Status),
		serializeURLs(job.ImageURLs),
		job.Error,
		job.CreatedAt,
		nullTime(job.ScheduledAt),
		nullTime(job.StartedAt),
		nullTime(job.CompletedAt),
		job.ArchivedAt,
		job.Retries,
		job.Priority,
		job.ScheduleID,
		job.ScheduleRunID,
		job.AssetCount,
		job.IngestStatus,
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.Source }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.Project }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.TemplateID }),
		metadataValue(job.Metadata, func(m *JobMetadata) string { return m.TemplateName }),
		serializeVariables(job.Metadata),
	)
	return err
}

func (s *Store) JobCount() (int, error) {
	return countQuery(s.db, `SELECT COUNT(*) FROM jobs`)
}

func (s *Store) HistoryCount() (int, error) {
	return countQuery(s.db, `SELECT COUNT(*) FROM history`)
}

func (s *Store) PurgeLegacyPlaceholderJobs() (int, error) {
	result, err := s.db.Exec(`
		DELETE FROM jobs
		WHERE (
			lower(trim(prompt)) GLOB 'prompt [0-9]*'
			OR trim(prompt) = 'A majestic dragon flying over mountains at sunset'
		)
		  AND COALESCE(source, '') IN ('', 'manual')
		  AND COALESCE(project, '') = ''
		  AND COALESCE(template_id, '') = ''
		  AND COALESCE(template_name, '') = ''
		  AND COALESCE(variables_json, '{}') = '{}'
	`)
	if err != nil {
		return 0, err
	}

	count, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func jobSelect(table, suffix string) string {
	return `
		SELECT id, prompt, status, image_urls, error, created_at,
		       scheduled_at, started_at, completed_at, archived_at,
		       retries, priority, schedule_id, schedule_run_id, asset_count, ingest_status,
		       source, project, template_id,
		       template_name, variables_json
		FROM ` + table + ` ` + suffix
}

func scanJob(row *sql.Row) (*Job, error) {
	var (
		job           Job
		imageURLs     string
		scheduleID    sql.NullString
		scheduleRunID sql.NullString
		ingestStatus  sql.NullString
		source        sql.NullString
		project       sql.NullString
		templateID    sql.NullString
		templateName  sql.NullString
		variablesJSON sql.NullString
		scheduledAt   sql.NullTime
		startedAt     sql.NullTime
		completedAt   sql.NullTime
		archivedAt    sql.NullTime
	)

	err := row.Scan(
		&job.ID,
		&job.Prompt,
		&job.Status,
		&imageURLs,
		&job.Error,
		&job.CreatedAt,
		&scheduledAt,
		&startedAt,
		&completedAt,
		&archivedAt,
		&job.Retries,
		&job.Priority,
		&scheduleID,
		&scheduleRunID,
		&job.AssetCount,
		&ingestStatus,
		&source,
		&project,
		&templateID,
		&templateName,
		&variablesJSON,
	)
	if err != nil {
		return nil, err
	}

	job.ImageURLs = parseURLs(imageURLs)
	if scheduledAt.Valid {
		job.ScheduledAt = scheduledAt.Time
	}
	if startedAt.Valid {
		job.StartedAt = startedAt.Time
	}
	if completedAt.Valid {
		job.CompletedAt = completedAt.Time
	}
	if archivedAt.Valid {
		job.ArchivedAt = archivedAt.Time
	}
	if scheduleID.Valid {
		job.ScheduleID = scheduleID.String
	}
	if scheduleRunID.Valid {
		job.ScheduleRunID = scheduleRunID.String
	}
	if ingestStatus.Valid {
		job.IngestStatus = ingestStatus.String
	}

	job.Metadata = buildMetadata(source, project, templateID, templateName, variablesJSON)
	return &job, nil
}

func scanJobs(rows *sql.Rows) ([]*Job, error) {
	var jobs []*Job
	for rows.Next() {
		var (
			job           Job
			imageURLs     string
			scheduleID    sql.NullString
			scheduleRunID sql.NullString
			ingestStatus  sql.NullString
			source        sql.NullString
			project       sql.NullString
			templateID    sql.NullString
			templateName  sql.NullString
			variablesJSON sql.NullString
			scheduledAt   sql.NullTime
			startedAt     sql.NullTime
			completedAt   sql.NullTime
			archivedAt    sql.NullTime
		)

		if err := rows.Scan(
			&job.ID,
			&job.Prompt,
			&job.Status,
			&imageURLs,
			&job.Error,
			&job.CreatedAt,
			&scheduledAt,
			&startedAt,
			&completedAt,
			&archivedAt,
			&job.Retries,
			&job.Priority,
			&scheduleID,
			&scheduleRunID,
			&job.AssetCount,
			&ingestStatus,
			&source,
			&project,
			&templateID,
			&templateName,
			&variablesJSON,
		); err != nil {
			return nil, err
		}

		job.ImageURLs = parseURLs(imageURLs)
		if scheduledAt.Valid {
			job.ScheduledAt = scheduledAt.Time
		}
		if startedAt.Valid {
			job.StartedAt = startedAt.Time
		}
		if completedAt.Valid {
			job.CompletedAt = completedAt.Time
		}
		if archivedAt.Valid {
			job.ArchivedAt = archivedAt.Time
		}
		if scheduleID.Valid {
			job.ScheduleID = scheduleID.String
		}
		if scheduleRunID.Valid {
			job.ScheduleRunID = scheduleRunID.String
		}
		if ingestStatus.Valid {
			job.IngestStatus = ingestStatus.String
		}

		job.Metadata = buildMetadata(source, project, templateID, templateName, variablesJSON)
		jobs = append(jobs, &job)
	}

	return jobs, rows.Err()
}

func serializeURLs(urls []string) string {
	if len(urls) == 0 {
		return "[]"
	}
	data, err := json.Marshal(urls)
	if err != nil {
		return "[]"
	}
	return string(data)
}

func parseURLs(s string) []string {
	if s == "" || s == "[]" {
		return []string{}
	}

	var urls []string
	if err := json.Unmarshal([]byte(s), &urls); err != nil {
		return []string{}
	}
	return urls
}

func serializeVariables(metadata *JobMetadata) string {
	if metadata == nil || len(metadata.Variables) == 0 {
		return "{}"
	}

	data, err := json.Marshal(metadata.Variables)
	if err != nil {
		return "{}"
	}
	return string(data)
}

func buildMetadata(source, project, templateID, templateName, variablesJSON sql.NullString) *JobMetadata {
	metadata := &JobMetadata{}
	hasData := false

	if source.Valid && source.String != "" {
		metadata.Source = source.String
		hasData = true
	}
	if project.Valid && project.String != "" {
		metadata.Project = project.String
		hasData = true
	}
	if templateID.Valid && templateID.String != "" {
		metadata.TemplateID = templateID.String
		hasData = true
	}
	if templateName.Valid && templateName.String != "" {
		metadata.TemplateName = templateName.String
		hasData = true
	}
	if variablesJSON.Valid && variablesJSON.String != "" && variablesJSON.String != "{}" {
		var variables map[string]string
		if err := json.Unmarshal([]byte(variablesJSON.String), &variables); err == nil && len(variables) > 0 {
			metadata.Variables = variables
			hasData = true
		}
	}

	if !hasData {
		return nil
	}
	return metadata
}

func sanitizeMetadata(metadata *JobMetadata) *JobMetadata {
	if metadata == nil {
		return nil
	}

	copy := &JobMetadata{
		Source:       metadata.Source,
		Project:      metadata.Project,
		TemplateID:   metadata.TemplateID,
		TemplateName: metadata.TemplateName,
	}

	if len(metadata.Variables) > 0 {
		copy.Variables = make(map[string]string, len(metadata.Variables))
		for key, value := range metadata.Variables {
			copy.Variables[key] = value
		}
	}

	if copy.Source == "" && copy.Project == "" && copy.TemplateID == "" && copy.TemplateName == "" && len(copy.Variables) == 0 {
		return nil
	}

	return copy
}

func metadataValue(metadata *JobMetadata, getter func(*JobMetadata) string) string {
	if metadata == nil {
		return ""
	}
	return getter(metadata)
}

func defaultJobStatus(status JobStatus) JobStatus {
	if status == "" {
		return StatusPending
	}
	return status
}

func nullTime(value time.Time) interface{} {
	if value.IsZero() {
		return nil
	}
	return value
}

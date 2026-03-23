package storage

import (
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type TemplateRun struct {
	ID     string            `json:"id,omitempty"`
	Values map[string]string `json:"values"`
}

type Schedule struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	TemplateID string        `json:"templateId"`
	Runs       []TemplateRun `json:"runs"`
	Project    string        `json:"project,omitempty"`
	Timezone   string        `json:"timezone"`
	Frequency  string        `json:"frequency"`
	TimeOfDay  string        `json:"timeOfDay"`
	DaysOfWeek []string      `json:"daysOfWeek,omitempty"`
	Enabled    bool          `json:"enabled"`
	NextRunAt  time.Time     `json:"nextRunAt,omitempty"`
	LastRunAt  time.Time     `json:"lastRunAt,omitempty"`
	CreatedAt  time.Time     `json:"createdAt"`
	UpdatedAt  time.Time     `json:"updatedAt"`
}

type ScheduleRun struct {
	ID          string    `json:"id"`
	ScheduleID  string    `json:"scheduleId"`
	TemplateID  string    `json:"templateId"`
	TriggeredAt time.Time `json:"triggeredAt"`
	Status      string    `json:"status"`
	JobIDs      []string  `json:"jobIds"`
	Error       string    `json:"error,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (s *Store) migrateSchedulesAndAssets() error {
	schema := `
	CREATE TABLE IF NOT EXISTS schedules (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		template_id TEXT NOT NULL,
		runs_json TEXT DEFAULT '[]',
		project TEXT DEFAULT '',
		timezone TEXT NOT NULL,
		frequency TEXT NOT NULL,
		time_of_day TEXT NOT NULL,
		days_of_week_json TEXT DEFAULT '[]',
		enabled INTEGER NOT NULL DEFAULT 1,
		next_run_at DATETIME,
		last_run_at DATETIME,
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	);

	CREATE TABLE IF NOT EXISTS schedule_runs (
		id TEXT PRIMARY KEY,
		schedule_id TEXT NOT NULL,
		template_id TEXT NOT NULL,
		triggered_at DATETIME NOT NULL,
		status TEXT NOT NULL,
		job_ids_json TEXT DEFAULT '[]',
		error TEXT DEFAULT '',
		created_at DATETIME NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next_run ON schedules(enabled, next_run_at);
	CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_created ON schedule_runs(schedule_id, created_at DESC);
	`

	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	return s.migrateAssets()
}

func (s *Store) ListSchedules() ([]*Schedule, error) {
	rows, err := s.db.Query(`
		SELECT id, name, template_id, runs_json, project, timezone, frequency, time_of_day,
		       days_of_week_json, enabled, next_run_at, last_run_at, created_at, updated_at
		FROM schedules
		ORDER BY updated_at DESC, created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var schedules []*Schedule
	for rows.Next() {
		schedule, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, schedule)
	}

	return schedules, rows.Err()
}

func (s *Store) ListDueSchedules(now time.Time) ([]*Schedule, error) {
	rows, err := s.db.Query(`
		SELECT id, name, template_id, runs_json, project, timezone, frequency, time_of_day,
		       days_of_week_json, enabled, next_run_at, last_run_at, created_at, updated_at
		FROM schedules
		WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
		ORDER BY next_run_at ASC
	`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var schedules []*Schedule
	for rows.Next() {
		schedule, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		schedules = append(schedules, schedule)
	}

	return schedules, rows.Err()
}

func (s *Store) GetSchedule(id string) (*Schedule, error) {
	row := s.db.QueryRow(`
		SELECT id, name, template_id, runs_json, project, timezone, frequency, time_of_day,
		       days_of_week_json, enabled, next_run_at, last_run_at, created_at, updated_at
		FROM schedules
		WHERE id = ?
	`, id)
	return scanSchedule(row)
}

func (s *Store) SaveSchedule(schedule *Schedule) (*Schedule, error) {
	if schedule == nil {
		return nil, sql.ErrNoRows
	}

	now := time.Now()
	if schedule.ID == "" {
		schedule.ID = uuid.New().String()
	}
	if schedule.CreatedAt.IsZero() {
		schedule.CreatedAt = now
	}
	schedule.UpdatedAt = now

	_, err := s.db.Exec(`
		INSERT INTO schedules (
			id, name, template_id, runs_json, project, timezone, frequency, time_of_day,
			days_of_week_json, enabled, next_run_at, last_run_at, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			template_id = excluded.template_id,
			runs_json = excluded.runs_json,
			project = excluded.project,
			timezone = excluded.timezone,
			frequency = excluded.frequency,
			time_of_day = excluded.time_of_day,
			days_of_week_json = excluded.days_of_week_json,
			enabled = excluded.enabled,
			next_run_at = excluded.next_run_at,
			last_run_at = excluded.last_run_at,
			updated_at = excluded.updated_at
	`,
		schedule.ID,
		schedule.Name,
		schedule.TemplateID,
		serializeTemplateRuns(schedule.Runs),
		schedule.Project,
		schedule.Timezone,
		schedule.Frequency,
		schedule.TimeOfDay,
		serializeStrings(schedule.DaysOfWeek),
		boolToInt(schedule.Enabled),
		nullTime(schedule.NextRunAt),
		nullTime(schedule.LastRunAt),
		schedule.CreatedAt,
		schedule.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	return s.GetSchedule(schedule.ID)
}

func (s *Store) DeleteSchedule(id string) error {
	_, err := s.db.Exec(`DELETE FROM schedules WHERE id = ?`, id)
	return err
}

func (s *Store) UpdateScheduleTimes(id string, nextRunAt, lastRunAt time.Time) error {
	_, err := s.db.Exec(`UPDATE schedules SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?`, nullTime(nextRunAt), nullTime(lastRunAt), time.Now(), id)
	return err
}

func (s *Store) UpdateScheduleEnabled(id string, enabled bool, nextRunAt time.Time) error {
	_, err := s.db.Exec(`UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`, boolToInt(enabled), nullTime(nextRunAt), time.Now(), id)
	return err
}

func (s *Store) CreateScheduleRun(run *ScheduleRun) (*ScheduleRun, error) {
	if run == nil {
		return nil, sql.ErrNoRows
	}
	if run.ID == "" {
		run.ID = uuid.New().String()
	}
	now := time.Now()
	if run.CreatedAt.IsZero() {
		run.CreatedAt = now
	}
	if run.TriggeredAt.IsZero() {
		run.TriggeredAt = now
	}
	if run.Status == "" {
		run.Status = "queued"
	}

	_, err := s.db.Exec(`
		INSERT INTO schedule_runs (id, schedule_id, template_id, triggered_at, status, job_ids_json, error, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`,
		run.ID,
		run.ScheduleID,
		run.TemplateID,
		run.TriggeredAt,
		run.Status,
		serializeStrings(run.JobIDs),
		run.Error,
		run.CreatedAt,
	)
	if err != nil {
		return nil, err
	}

	return s.GetScheduleRun(run.ID)
}

func (s *Store) UpdateScheduleRun(run *ScheduleRun) error {
	if run == nil {
		return sql.ErrNoRows
	}
	_, err := s.db.Exec(`
		UPDATE schedule_runs
		SET status = ?, job_ids_json = ?, error = ?
		WHERE id = ?
	`, run.Status, serializeStrings(run.JobIDs), run.Error, run.ID)
	return err
}

func (s *Store) GetScheduleRun(id string) (*ScheduleRun, error) {
	row := s.db.QueryRow(`
		SELECT id, schedule_id, template_id, triggered_at, status, job_ids_json, error, created_at
		FROM schedule_runs
		WHERE id = ?
	`, id)
	return scanScheduleRun(row)
}

func (s *Store) ListScheduleRuns(scheduleID string, limit int) ([]*ScheduleRun, error) {
	if limit <= 0 {
		limit = 50
	}

	var (
		rows *sql.Rows
		err  error
	)
	if scheduleID == "" {
		rows, err = s.db.Query(`
			SELECT id, schedule_id, template_id, triggered_at, status, job_ids_json, error, created_at
			FROM schedule_runs
			ORDER BY created_at DESC
			LIMIT ?
		`, limit)
	} else {
		rows, err = s.db.Query(`
			SELECT id, schedule_id, template_id, triggered_at, status, job_ids_json, error, created_at
			FROM schedule_runs
			WHERE schedule_id = ?
			ORDER BY created_at DESC
			LIMIT ?
		`, scheduleID, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var runs []*ScheduleRun
	for rows.Next() {
		run, err := scanScheduleRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}

	return runs, rows.Err()
}

func scanSchedule(scanner interface {
	Scan(dest ...interface{}) error
}) (*Schedule, error) {
	var (
		schedule       Schedule
		runsJSON       string
		daysOfWeekJSON string
		nextRunAt      sql.NullTime
		lastRunAt      sql.NullTime
		enabled        int
	)

	if err := scanner.Scan(
		&schedule.ID,
		&schedule.Name,
		&schedule.TemplateID,
		&runsJSON,
		&schedule.Project,
		&schedule.Timezone,
		&schedule.Frequency,
		&schedule.TimeOfDay,
		&daysOfWeekJSON,
		&enabled,
		&nextRunAt,
		&lastRunAt,
		&schedule.CreatedAt,
		&schedule.UpdatedAt,
	); err != nil {
		return nil, err
	}

	schedule.Runs = parseTemplateRuns(runsJSON)
	schedule.DaysOfWeek = parseStrings(daysOfWeekJSON)
	schedule.Enabled = enabled == 1
	if nextRunAt.Valid {
		schedule.NextRunAt = nextRunAt.Time
	}
	if lastRunAt.Valid {
		schedule.LastRunAt = lastRunAt.Time
	}

	return &schedule, nil
}

func scanScheduleRun(scanner interface {
	Scan(dest ...interface{}) error
}) (*ScheduleRun, error) {
	var (
		run        ScheduleRun
		jobIDsJSON string
	)
	if err := scanner.Scan(
		&run.ID,
		&run.ScheduleID,
		&run.TemplateID,
		&run.TriggeredAt,
		&run.Status,
		&jobIDsJSON,
		&run.Error,
		&run.CreatedAt,
	); err != nil {
		return nil, err
	}
	run.JobIDs = parseStrings(jobIDsJSON)
	return &run, nil
}

func serializeTemplateRuns(runs []TemplateRun) string {
	if len(runs) == 0 {
		return "[]"
	}
	data, err := json.Marshal(runs)
	if err != nil {
		return "[]"
	}
	return string(data)
}

func parseTemplateRuns(data string) []TemplateRun {
	if data == "" || data == "[]" {
		return []TemplateRun{}
	}
	var runs []TemplateRun
	if err := json.Unmarshal([]byte(data), &runs); err != nil {
		return []TemplateRun{}
	}
	return runs
}

func serializeStrings(values []string) string {
	if len(values) == 0 {
		return "[]"
	}
	data, err := json.Marshal(values)
	if err != nil {
		return "[]"
	}
	return string(data)
}

func parseStrings(data string) []string {
	if data == "" || data == "[]" {
		return []string{}
	}
	var values []string
	if err := json.Unmarshal([]byte(data), &values); err != nil {
		return []string{}
	}
	return values
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

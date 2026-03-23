package storage

import (
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type TemplateVariable struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	DefaultValue string `json:"defaultValue,omitempty"`
	Required     bool   `json:"required"`
}

type Template struct {
	ID          string             `json:"id"`
	Name        string             `json:"name"`
	Description string             `json:"description,omitempty"`
	Body        string             `json:"body"`
	Variables   []TemplateVariable `json:"variables"`
	CreatedAt   time.Time          `json:"createdAt"`
	UpdatedAt   time.Time          `json:"updatedAt"`
	ArchivedAt  time.Time          `json:"archivedAt,omitempty"`
}

func (s *Store) migrateEntities() error {
	schema := `
	CREATE TABLE IF NOT EXISTS templates (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		description TEXT DEFAULT '',
		body TEXT NOT NULL,
		variables_json TEXT DEFAULT '[]',
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL,
		archived_at DATETIME
	);

	CREATE INDEX IF NOT EXISTS idx_templates_updated_at ON templates(updated_at DESC);
	CREATE INDEX IF NOT EXISTS idx_templates_archived_at ON templates(archived_at);
	`

	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	return s.migrateSchedulesAndAssets()
}

func (s *Store) ListTemplates() ([]*Template, error) {
	rows, err := s.db.Query(`
		SELECT id, name, description, body, variables_json, created_at, updated_at, archived_at
		FROM templates
		WHERE archived_at IS NULL
		ORDER BY updated_at DESC, created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var templates []*Template
	for rows.Next() {
		template, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		templates = append(templates, template)
	}

	return templates, rows.Err()
}

func (s *Store) GetTemplate(id string) (*Template, error) {
	row := s.db.QueryRow(`
		SELECT id, name, description, body, variables_json, created_at, updated_at, archived_at
		FROM templates
		WHERE id = ? AND archived_at IS NULL
	`, id)
	return scanTemplate(row)
}

func (s *Store) SaveTemplate(template *Template) (*Template, error) {
	if template == nil {
		return nil, sql.ErrNoRows
	}

	now := time.Now()
	if template.ID == "" {
		template.ID = uuid.New().String()
	}
	if template.CreatedAt.IsZero() {
		template.CreatedAt = now
	}
	template.UpdatedAt = now

	_, err := s.db.Exec(`
		INSERT INTO templates (id, name, description, body, variables_json, created_at, updated_at, archived_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			description = excluded.description,
			body = excluded.body,
			variables_json = excluded.variables_json,
			updated_at = excluded.updated_at,
			archived_at = NULL
	`,
		template.ID,
		template.Name,
		template.Description,
		template.Body,
		serializeTemplateVariables(template.Variables),
		template.CreatedAt,
		template.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	return s.GetTemplate(template.ID)
}

func (s *Store) DeleteTemplate(id string) error {
	_, err := s.db.Exec(`UPDATE templates SET archived_at = ? WHERE id = ?`, time.Now(), id)
	return err
}

func (s *Store) TemplateCount() (int, error) {
	return countQuery(s.db, `SELECT COUNT(*) FROM templates WHERE archived_at IS NULL`)
}

func scanTemplate(scanner interface {
	Scan(dest ...interface{}) error
}) (*Template, error) {
	var (
		template      Template
		variablesJSON string
		archivedAt    sql.NullTime
	)

	if err := scanner.Scan(
		&template.ID,
		&template.Name,
		&template.Description,
		&template.Body,
		&variablesJSON,
		&template.CreatedAt,
		&template.UpdatedAt,
		&archivedAt,
	); err != nil {
		return nil, err
	}

	template.Variables = parseTemplateVariables(variablesJSON)
	if archivedAt.Valid {
		template.ArchivedAt = archivedAt.Time
	}

	return &template, nil
}

func serializeTemplateVariables(variables []TemplateVariable) string {
	if len(variables) == 0 {
		return "[]"
	}
	data, err := json.Marshal(variables)
	if err != nil {
		return "[]"
	}
	return string(data)
}

func parseTemplateVariables(data string) []TemplateVariable {
	if data == "" || data == "[]" {
		return []TemplateVariable{}
	}
	var variables []TemplateVariable
	if err := json.Unmarshal([]byte(data), &variables); err != nil {
		return []TemplateVariable{}
	}
	return variables
}

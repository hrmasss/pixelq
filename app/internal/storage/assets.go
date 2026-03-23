package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Asset struct {
	ID             string            `json:"id"`
	JobID          string            `json:"jobId"`
	Project        string            `json:"project,omitempty"`
	Prompt         string            `json:"prompt"`
	TemplateID     string            `json:"templateId,omitempty"`
	TemplateName   string            `json:"templateName,omitempty"`
	Tags           []string          `json:"tags"`
	Fingerprint    string            `json:"fingerprint"`
	SourceFilename string            `json:"sourceFilename"`
	LibraryPath    string            `json:"libraryPath"`
	ThumbPath      string            `json:"thumbPath,omitempty"`
	Width          int               `json:"width"`
	Height         int               `json:"height"`
	CreatedAt      time.Time         `json:"createdAt"`
	ImportedAt     time.Time         `json:"importedAt"`
	Metadata       map[string]string `json:"metadata,omitempty"`
}

type AssetQuery struct {
	Search  string
	Project string
	Tag     string
	Limit   int
}

func (s *Store) migrateAssets() error {
	schema := `
	CREATE TABLE IF NOT EXISTS assets (
		id TEXT PRIMARY KEY,
		job_id TEXT NOT NULL,
		project TEXT DEFAULT '',
		prompt TEXT NOT NULL,
		template_id TEXT DEFAULT '',
		template_name TEXT DEFAULT '',
		tags_json TEXT DEFAULT '[]',
		fingerprint TEXT NOT NULL UNIQUE,
		source_filename TEXT DEFAULT '',
		library_path TEXT NOT NULL,
		thumb_path TEXT DEFAULT '',
		width INTEGER DEFAULT 0,
		height INTEGER DEFAULT 0,
		created_at DATETIME NOT NULL,
		imported_at DATETIME NOT NULL,
		metadata_json TEXT DEFAULT '{}'
	);

	CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets(job_id);
	CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project);
	CREATE INDEX IF NOT EXISTS idx_assets_imported_at ON assets(imported_at DESC);

	CREATE VIRTUAL TABLE IF NOT EXISTS asset_search USING fts5(
		asset_id UNINDEXED,
		prompt,
		project,
		template_name,
		tags,
		source_filename
	);
	`

	_, err := s.db.Exec(schema)
	return err
}

func (s *Store) SaveAsset(asset *Asset) (*Asset, error) {
	if asset == nil {
		return nil, sql.ErrNoRows
	}
	now := time.Now()
	if asset.ID == "" {
		asset.ID = uuid.New().String()
	}
	if asset.ImportedAt.IsZero() {
		asset.ImportedAt = now
	}
	if asset.CreatedAt.IsZero() {
		asset.CreatedAt = asset.ImportedAt
	}

	_, err := s.db.Exec(`
		INSERT INTO assets (
			id, job_id, project, prompt, template_id, template_name, tags_json,
			fingerprint, source_filename, library_path, thumb_path, width, height,
			created_at, imported_at, metadata_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(fingerprint) DO UPDATE SET
			job_id = excluded.job_id,
			project = excluded.project,
			prompt = excluded.prompt,
			template_id = excluded.template_id,
			template_name = excluded.template_name,
			tags_json = excluded.tags_json,
			source_filename = excluded.source_filename,
			library_path = excluded.library_path,
			thumb_path = excluded.thumb_path,
			width = excluded.width,
			height = excluded.height,
			created_at = excluded.created_at,
			imported_at = excluded.imported_at,
			metadata_json = excluded.metadata_json
	`,
		asset.ID,
		asset.JobID,
		asset.Project,
		asset.Prompt,
		asset.TemplateID,
		asset.TemplateName,
		serializeStrings(asset.Tags),
		asset.Fingerprint,
		asset.SourceFilename,
		asset.LibraryPath,
		asset.ThumbPath,
		asset.Width,
		asset.Height,
		asset.CreatedAt,
		asset.ImportedAt,
		serializeStringMap(asset.Metadata),
	)
	if err != nil {
		return nil, err
	}

	stored, err := s.GetAssetByFingerprint(asset.Fingerprint)
	if err != nil {
		return nil, err
	}
	if err := s.reindexAssetSearch(stored); err != nil {
		return nil, err
	}
	return stored, nil
}

func (s *Store) GetAsset(id string) (*Asset, error) {
	row := s.db.QueryRow(`
		SELECT id, job_id, project, prompt, template_id, template_name, tags_json,
		       fingerprint, source_filename, library_path, thumb_path, width, height,
		       created_at, imported_at, metadata_json
		FROM assets
		WHERE id = ?
	`, id)
	return scanAsset(row)
}

func (s *Store) GetAssetByFingerprint(fingerprint string) (*Asset, error) {
	row := s.db.QueryRow(`
		SELECT id, job_id, project, prompt, template_id, template_name, tags_json,
		       fingerprint, source_filename, library_path, thumb_path, width, height,
		       created_at, imported_at, metadata_json
		FROM assets
		WHERE fingerprint = ?
	`, fingerprint)
	return scanAsset(row)
}

func (s *Store) ListAssets(query AssetQuery) ([]*Asset, error) {
	if query.Limit <= 0 {
		query.Limit = 100
	}

	if strings.TrimSpace(query.Search) != "" {
		rows, err := s.db.Query(`
			SELECT a.id, a.job_id, a.project, a.prompt, a.template_id, a.template_name, a.tags_json,
			       a.fingerprint, a.source_filename, a.library_path, a.thumb_path, a.width, a.height,
			       a.created_at, a.imported_at, a.metadata_json
			FROM asset_search search
			JOIN assets a ON a.id = search.asset_id
			WHERE search.asset_search MATCH ?
			ORDER BY a.imported_at DESC
			LIMIT ?
		`, query.Search, query.Limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return scanAssets(rows)
	}

	clauses := []string{"1=1"}
	args := []interface{}{}
	if query.Project != "" {
		clauses = append(clauses, "project = ?")
		args = append(args, query.Project)
	}
	if query.Tag != "" {
		clauses = append(clauses, "tags_json LIKE ?")
		args = append(args, fmt.Sprintf("%%%q%%", query.Tag))
	}
	args = append(args, query.Limit)

	rows, err := s.db.Query(`
		SELECT id, job_id, project, prompt, template_id, template_name, tags_json,
		       fingerprint, source_filename, library_path, thumb_path, width, height,
		       created_at, imported_at, metadata_json
		FROM assets
		WHERE `+strings.Join(clauses, " AND ")+`
		ORDER BY imported_at DESC
		LIMIT ?
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAssets(rows)
}

func (s *Store) UpdateAsset(asset *Asset) (*Asset, error) {
	if asset == nil {
		return nil, sql.ErrNoRows
	}
	_, err := s.db.Exec(`
		UPDATE assets
		SET project = ?, prompt = ?, template_id = ?, template_name = ?, tags_json = ?, thumb_path = ?, metadata_json = ?
		WHERE id = ?
	`,
		asset.Project,
		asset.Prompt,
		asset.TemplateID,
		asset.TemplateName,
		serializeStrings(asset.Tags),
		asset.ThumbPath,
		serializeStringMap(asset.Metadata),
		asset.ID,
	)
	if err != nil {
		return nil, err
	}
	stored, err := s.GetAsset(asset.ID)
	if err != nil {
		return nil, err
	}
	if err := s.reindexAssetSearch(stored); err != nil {
		return nil, err
	}
	return stored, nil
}

func (s *Store) ReindexAssets() error {
	rows, err := s.db.Query(`
		SELECT id, job_id, project, prompt, template_id, template_name, tags_json,
		       fingerprint, source_filename, library_path, thumb_path, width, height,
		       created_at, imported_at, metadata_json
		FROM assets
	`)
	if err != nil {
		return err
	}

	assets, err := scanAssets(rows)
	rows.Close()
	if err != nil {
		return err
	}

	if _, err := s.db.Exec(`DELETE FROM asset_search`); err != nil {
		return err
	}

	for _, asset := range assets {
		if err := s.reindexAssetSearch(asset); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) AssetCount() (int, error) {
	return countQuery(s.db, `SELECT COUNT(*) FROM assets`)
}

func (s *Store) reindexAssetSearch(asset *Asset) error {
	if asset == nil {
		return nil
	}
	if _, err := s.db.Exec(`DELETE FROM asset_search WHERE asset_id = ?`, asset.ID); err != nil {
		return err
	}
	_, err := s.db.Exec(`
		INSERT INTO asset_search (asset_id, prompt, project, template_name, tags, source_filename)
		VALUES (?, ?, ?, ?, ?, ?)
	`,
		asset.ID,
		asset.Prompt,
		asset.Project,
		asset.TemplateName,
		strings.Join(asset.Tags, " "),
		asset.SourceFilename,
	)
	return err
}

func scanAsset(scanner interface {
	Scan(dest ...interface{}) error
}) (*Asset, error) {
	var (
		asset        Asset
		tagsJSON     string
		metadataJSON string
	)
	if err := scanner.Scan(
		&asset.ID,
		&asset.JobID,
		&asset.Project,
		&asset.Prompt,
		&asset.TemplateID,
		&asset.TemplateName,
		&tagsJSON,
		&asset.Fingerprint,
		&asset.SourceFilename,
		&asset.LibraryPath,
		&asset.ThumbPath,
		&asset.Width,
		&asset.Height,
		&asset.CreatedAt,
		&asset.ImportedAt,
		&metadataJSON,
	); err != nil {
		return nil, err
	}

	asset.Tags = parseStrings(tagsJSON)
	asset.Metadata = parseStringMap(metadataJSON)
	return &asset, nil
}

func scanAssets(rows *sql.Rows) ([]*Asset, error) {
	var assets []*Asset
	for rows.Next() {
		asset, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		assets = append(assets, asset)
	}
	return assets, rows.Err()
}

func serializeStringMap(values map[string]string) string {
	if len(values) == 0 {
		return "{}"
	}
	data, err := json.Marshal(values)
	if err != nil {
		return "{}"
	}
	return string(data)
}

func parseStringMap(data string) map[string]string {
	if data == "" || data == "{}" {
		return nil
	}
	var values map[string]string
	if err := json.Unmarshal([]byte(data), &values); err != nil {
		return nil
	}
	return values
}

func countQuery(db *sql.DB, query string, args ...interface{}) (int, error) {
	var count int
	err := db.QueryRow(query, args...).Scan(&count)
	return count, err
}

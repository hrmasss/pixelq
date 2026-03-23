package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "image/jpeg"
	_ "image/png"

	"golang.org/x/image/draw"

	"github.com/google/uuid"
	"github.com/pixelq/app/internal/config"
	"github.com/pixelq/app/internal/storage"
)

type FileManifest struct {
	Path      string `json:"path"`
	Name      string `json:"name,omitempty"`
	SourceURL string `json:"sourceUrl,omitempty"`
}

type DownloadManifest struct {
	JobID  string         `json:"jobId"`
	Files  []FileManifest `json:"files"`
	Source string         `json:"source,omitempty"`
}

type Manager struct {
	store *storage.Store
}

func New(store *storage.Store) *Manager {
	return &Manager{store: store}
}

func (m *Manager) IngestManifest(manifest DownloadManifest) ([]*storage.Asset, error) {
	job, err := m.store.GetJob(manifest.JobID)
	if err != nil {
		return nil, err
	}

	cfg := config.Get()
	if err := os.MkdirAll(cfg.LibraryRoot, 0755); err != nil {
		return nil, err
	}
	thumbRoot := filepath.Join(cfg.LibraryRoot, ".thumbs")
	if err := os.MkdirAll(thumbRoot, 0755); err != nil {
		return nil, err
	}

	projectSlug := sanitizeSegment(jobProject(job))
	if projectSlug == "" {
		projectSlug = "unfiled"
	}
	created := job.CreatedAt
	if created.IsZero() {
		created = time.Now()
	}

	var assets []*storage.Asset
	for index, file := range manifest.Files {
		if strings.TrimSpace(file.Path) == "" {
			continue
		}

		fingerprint, err := hashFile(file.Path)
		if err != nil {
			return nil, err
		}

		ext := strings.ToLower(filepath.Ext(file.Path))
		if ext == "" {
			ext = ".png"
		}

		destDir := filepath.Join(cfg.LibraryRoot, projectSlug, created.Format("2006"), created.Format("2006-01-02"))
		if err := os.MkdirAll(destDir, 0755); err != nil {
			return nil, err
		}
		destName := fmt.Sprintf("%s_%d%s", job.ID, index+1, ext)
		destPath := filepath.Join(destDir, destName)

		if existing, err := m.store.GetAssetByFingerprint(fingerprint); err == nil {
			_ = os.Remove(file.Path)
			assets = append(assets, existing)
			continue
		}

		if err := moveFile(file.Path, destPath); err != nil {
			return nil, err
		}

		width, height, thumbPath := 0, 0, ""
		if generatedThumb, w, h, err := createThumbnail(destPath, thumbRoot); err == nil {
			thumbPath = generatedThumb
			width = w
			height = h
		}

		assetInput := &storage.Asset{
			JobID:          job.ID,
			Project:        jobProject(job),
			Prompt:         job.Prompt,
			TemplateID:     metadataValue(job.Metadata, func(m *storage.JobMetadata) string { return m.TemplateID }),
			TemplateName:   metadataValue(job.Metadata, func(m *storage.JobMetadata) string { return m.TemplateName }),
			Fingerprint:    fingerprint,
			SourceFilename: firstNonEmpty(file.Name, filepath.Base(destPath)),
			LibraryPath:    destPath,
			ThumbPath:      thumbPath,
			Width:          width,
			Height:         height,
			CreatedAt:      created,
			ImportedAt:     time.Now(),
			Metadata: map[string]string{
				"source":     firstNonEmpty(manifest.Source, jobSource(job)),
				"source_url": file.SourceURL,
			},
		}
		asset, err := retryDBWrite(func() (*storage.Asset, error) {
			return m.store.SaveAsset(assetInput)
		})
		if err != nil {
			_ = retryDBExec(func() error {
				return m.store.UpdateJobIngest(job.ID, len(assets), "failed")
			})
			return nil, err
		}
		assets = append(assets, asset)
	}

	if err := retryDBExec(func() error {
		return m.store.UpdateJobIngest(job.ID, len(assets), "completed")
	}); err != nil {
		return nil, err
	}

	return assets, nil
}

func (m *Manager) Reindex() error {
	cfg := config.Get()
	if strings.TrimSpace(cfg.LibraryRoot) != "" {
		thumbRoot := filepath.Join(cfg.LibraryRoot, ".thumbs")
		if err := os.MkdirAll(thumbRoot, 0755); err != nil {
			return err
		}

		if err := filepath.WalkDir(cfg.LibraryRoot, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				if path == thumbRoot {
					return filepath.SkipDir
				}
				return nil
			}

			ext := strings.ToLower(filepath.Ext(path))
			switch ext {
			case ".png", ".jpg", ".jpeg", ".webp":
			default:
				return nil
			}

			fingerprint, err := hashFile(path)
			if err != nil {
				return nil
			}
			if _, err := m.store.GetAssetByFingerprint(fingerprint); err == nil {
				return nil
			}

			jobID := parseJobIDFromAssetPath(path)
			if jobID == "" {
				return nil
			}

			job, err := m.store.GetJob(jobID)
			if err != nil {
				job, err = m.store.GetHistoryJob(jobID)
				if err != nil {
					return nil
				}
			}

			width, height, thumbPath := 0, 0, ""
			if generatedThumb, w, h, err := createThumbnail(path, thumbRoot); err == nil {
				thumbPath = generatedThumb
				width = w
				height = h
			}

			_, err = m.store.SaveAsset(&storage.Asset{
				JobID:          job.ID,
				Project:        jobProject(job),
				Prompt:         job.Prompt,
				TemplateID:     metadataValue(job.Metadata, func(m *storage.JobMetadata) string { return m.TemplateID }),
				TemplateName:   metadataValue(job.Metadata, func(m *storage.JobMetadata) string { return m.TemplateName }),
				Fingerprint:    fingerprint,
				SourceFilename: filepath.Base(path),
				LibraryPath:    path,
				ThumbPath:      thumbPath,
				Width:          width,
				Height:         height,
				CreatedAt:      firstNonZeroTime(job.CompletedAt, job.CreatedAt, time.Now()),
				ImportedAt:     time.Now(),
				Metadata: map[string]string{
					"source": firstNonEmpty(jobSource(job), "extension"),
				},
			})
			return err
		}); err != nil {
			return err
		}
	}

	return m.store.ReindexAssets()
}

func parseJobIDFromAssetPath(path string) string {
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	lastUnderscore := strings.LastIndex(base, "_")
	if lastUnderscore <= 0 {
		return ""
	}
	jobID := base[:lastUnderscore]
	if _, err := uuid.Parse(jobID); err != nil {
		return ""
	}
	return jobID
}

func firstNonZeroTime(values ...time.Time) time.Time {
	for _, value := range values {
		if !value.IsZero() {
			return value
		}
	}
	return time.Time{}
}

func retryDBWrite[T any](fn func() (T, error)) (T, error) {
	var zero T
	var lastErr error
	for attempt := 0; attempt < 8; attempt++ {
		value, err := fn()
		if err == nil {
			return value, nil
		}
		if !isTransientDBError(err) {
			return zero, err
		}
		lastErr = err
		time.Sleep(time.Duration(attempt+1) * 250 * time.Millisecond)
	}
	return zero, lastErr
}

func retryDBExec(fn func() error) error {
	var lastErr error
	for attempt := 0; attempt < 8; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		if !isTransientDBError(err) {
			return err
		}
		lastErr = err
		time.Sleep(time.Duration(attempt+1) * 250 * time.Millisecond)
	}
	return lastErr
}

func isTransientDBError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return errors.Is(err, fs.ErrExist) || strings.Contains(message, "database is locked") || strings.Contains(message, "sqlite_busy") || strings.Contains(message, "database table is locked")
}

func createThumbnail(path, thumbRoot string) (string, int, int, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, 0, err
	}
	defer file.Close()

	img, _, err := image.Decode(file)
	if err != nil {
		return "", 0, 0, err
	}
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width == 0 || height == 0 {
		return "", 0, 0, fmt.Errorf("invalid image dimensions")
	}

	targetWidth := 320
	targetHeight := int(float64(height) * (float64(targetWidth) / float64(width)))
	if targetHeight <= 0 {
		targetHeight = 320
	}

	dst := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, bounds, draw.Over, nil)

	thumbPath := filepath.Join(thumbRoot, strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))+".png")
	out, err := os.Create(thumbPath)
	if err != nil {
		return "", 0, 0, err
	}
	defer out.Close()

	if err := png.Encode(out, dst); err != nil {
		return "", 0, 0, err
	}

	return thumbPath, width, height, nil
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func moveFile(src, dst string) error {
	if src == dst {
		return nil
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Remove(src)
}

func sanitizeSegment(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.ReplaceAll(value, " ", "-")
	builder := strings.Builder{}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			builder.WriteRune(r)
		}
	}
	return strings.Trim(builder.String(), "-_")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func jobProject(job *storage.Job) string {
	if job != nil && job.Metadata != nil {
		return job.Metadata.Project
	}
	return ""
}

func jobSource(job *storage.Job) string {
	if job != nil && job.Metadata != nil {
		return job.Metadata.Source
	}
	return ""
}

func metadataValue(metadata *storage.JobMetadata, getter func(*storage.JobMetadata) string) string {
	if metadata == nil {
		return ""
	}
	return getter(metadata)
}

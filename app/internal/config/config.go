package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	CooldownSeconds   int    `json:"cooldown_seconds"`
	JitterSeconds     int    `json:"jitter_seconds"`
	MaxRetries        int    `json:"max_retries"`
	AdaptiveRateLimit bool   `json:"adaptive_rate_limit"`
	Port              int    `json:"port"`
	LibraryRoot       string `json:"library_root"`
	DownloadsInbox    string `json:"downloads_inbox"`
	StartAtLogin      bool   `json:"start_at_login"`
	KeepAwake         bool   `json:"keep_awake"`
	Theme             string `json:"theme"`
}

var (
	current *Config
	mu      sync.RWMutex
)

func Default() *Config {
	return &Config{
		CooldownSeconds:   60,
		JitterSeconds:     0,
		MaxRetries:        3,
		AdaptiveRateLimit: true,
		Port:              8765,
		LibraryRoot:       defaultLibraryRoot(),
		DownloadsInbox:    filepath.Join(defaultDownloadsDir(), "PixelQ", "_inbox"),
		Theme:             "system",
	}
}

func Load() (*Config, error) {
	cfg := Default()

	configPath := getConfigPath()
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			mu.Lock()
			current = cfg
			mu.Unlock()
			return cfg, nil
		}
		return nil, err
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	if cfg.LibraryRoot == "" || cfg.LibraryRoot == legacyLibraryRoot() {
		cfg.LibraryRoot = defaultLibraryRoot()
	}
	cfg.Theme = normalizeTheme(cfg.Theme)

	mu.Lock()
	current = cfg
	mu.Unlock()

	return cfg, nil
}

func Get() *Config {
	mu.RLock()
	defer mu.RUnlock()
	if current == nil {
		return Default()
	}
	return current
}

func Update(updates map[string]interface{}) (*Config, error) {
	mu.Lock()
	defer mu.Unlock()

	if current == nil {
		current = Default()
	}

	if v, ok := updates["cooldown_seconds"].(float64); ok {
		current.CooldownSeconds = int(v)
	}
	if v, ok := updates["jitter_seconds"].(float64); ok {
		current.JitterSeconds = int(v)
	}
	if v, ok := updates["max_retries"].(float64); ok {
		current.MaxRetries = int(v)
	}
	if v, ok := updates["adaptive_rate_limit"].(bool); ok {
		current.AdaptiveRateLimit = v
	}
	if v, ok := updates["port"].(float64); ok {
		current.Port = int(v)
	}
	if v, ok := updates["library_root"].(string); ok && v != "" {
		current.LibraryRoot = v
	}
	if v, ok := updates["downloads_inbox"].(string); ok && v != "" {
		current.DownloadsInbox = v
	}
	if v, ok := updates["start_at_login"].(bool); ok {
		current.StartAtLogin = v
	}
	if v, ok := updates["keep_awake"].(bool); ok {
		current.KeepAwake = v
	}
	if v, ok := updates["theme"].(string); ok {
		current.Theme = normalizeTheme(v)
	}

	// Validate
	if current.CooldownSeconds < 0 {
		current.CooldownSeconds = 0
	}
	if current.JitterSeconds < 0 {
		current.JitterSeconds = 0
	}
	if current.MaxRetries < 0 {
		current.MaxRetries = 0
	}
	current.Theme = normalizeTheme(current.Theme)

	return current, Save(current)
}

func Save(cfg *Config) error {
	configPath := getConfigPath()

	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, data, 0644)
}

func DataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".pixelq")
}

func defaultLibraryRoot() string {
	return filepath.Join(defaultPicturesDir(), "PixelQ")
}

func legacyLibraryRoot() string {
	return filepath.Join(DataDir(), "library")
}

func defaultDownloadsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, "Downloads")
}

func defaultPicturesDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, "Pictures")
}

func getConfigPath() string {
	return filepath.Join(DataDir(), "config.json")
}

func normalizeTheme(value string) string {
	switch value {
	case "light", "dark", "system":
		return value
	default:
		return "system"
	}
}

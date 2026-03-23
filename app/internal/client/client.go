package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/pixelq/app/internal/config"
	"github.com/pixelq/app/internal/scheduler"
	"github.com/pixelq/app/internal/storage"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func New() *Client {
	cfg := config.Get()
	if cfg == nil {
		cfg = config.Default()
	}
	return &Client{
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", cfg.Port),
		http: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

func (c *Client) Status() (map[string]interface{}, error) {
	var resp map[string]interface{}
	err := c.get("/status", &resp)
	return resp, err
}

func (c *Client) BridgeStatus() (map[string]interface{}, error) {
	var resp map[string]interface{}
	err := c.get("/bridge/status", &resp)
	return resp, err
}

func (c *Client) StartScheduler() error {
	return c.post("/scheduler/start", nil, nil)
}

func (c *Client) PauseScheduler() error {
	return c.post("/scheduler/pause", nil, nil)
}

func (c *Client) ListJobs(limit int) ([]*storage.Job, error) {
	var resp struct {
		Jobs []*storage.Job `json:"jobs"`
	}
	err := c.get(fmt.Sprintf("/jobs?limit=%d", limit), &resp)
	return resp.Jobs, err
}

func (c *Client) QueueJob(prompt string, priority int, metadata *storage.JobMetadata) (*storage.Job, error) {
	var job storage.Job
	err := c.post("/jobs", map[string]interface{}{
		"prompt":   prompt,
		"priority": priority,
		"metadata": metadata,
	}, &job)
	return &job, err
}

func (c *Client) QueueBatch(inputs []scheduler.JobInput) ([]*storage.Job, error) {
	var resp struct {
		Jobs []*storage.Job `json:"jobs"`
	}
	err := c.post("/jobs/batch", map[string]interface{}{"jobs": inputs}, &resp)
	return resp.Jobs, err
}

func (c *Client) DeleteJob(id string) error {
	req, err := http.NewRequest(http.MethodDelete, c.baseURL+"/jobs/"+id, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("delete job failed: %s", resp.Status)
	}
	return nil
}

func (c *Client) RetryJob(id string) error {
	return c.post("/jobs/"+id+"/retry", nil, nil)
}

func (c *Client) ArchiveCompleted() error {
	return c.post("/jobs/archive-completed", nil, nil)
}

func (c *Client) ListTemplates() ([]*storage.Template, error) {
	var resp struct {
		Templates []*storage.Template `json:"templates"`
	}
	err := c.get("/templates", &resp)
	return resp.Templates, err
}

func (c *Client) QueueTemplateRuns(templateID string, runs []storage.TemplateRun, project string) ([]*storage.Job, error) {
	var resp struct {
		Jobs []*storage.Job `json:"jobs"`
	}
	err := c.post("/templates/"+templateID+"/queue", map[string]interface{}{
		"runs":    runs,
		"project": project,
	}, &resp)
	return resp.Jobs, err
}

func (c *Client) ListSchedules() ([]*storage.Schedule, error) {
	var resp struct {
		Schedules []*storage.Schedule `json:"schedules"`
	}
	err := c.get("/schedules", &resp)
	return resp.Schedules, err
}

func (c *Client) ToggleSchedule(id string) (*storage.Schedule, error) {
	var schedule storage.Schedule
	err := c.post("/schedules/"+id+"/toggle", nil, &schedule)
	return &schedule, err
}

func (c *Client) RunScheduleNow(id string) (*storage.ScheduleRun, error) {
	var run storage.ScheduleRun
	err := c.post("/schedules/"+id+"/run-now", nil, &run)
	return &run, err
}

func (c *Client) ListAssets(search string, limit int) ([]*storage.Asset, error) {
	query := url.Values{}
	if search != "" {
		query.Set("search", search)
	}
	if limit > 0 {
		query.Set("limit", fmt.Sprintf("%d", limit))
	}
	var resp struct {
		Assets []*storage.Asset `json:"assets"`
	}
	err := c.get("/catalog/assets?"+query.Encode(), &resp)
	return resp.Assets, err
}

func (c *Client) GetAsset(id string) (*storage.Asset, error) {
	var asset storage.Asset
	err := c.get("/catalog/assets/"+id, &asset)
	return &asset, err
}

func (c *Client) get(path string, target interface{}) error {
	resp, err := c.http.Get(c.baseURL + path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("request failed: %s", resp.Status)
	}
	if target == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

func (c *Client) post(path string, body interface{}, target interface{}) error {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return err
		}
	} else {
		payload = []byte("{}")
	}
	resp, err := c.http.Post(c.baseURL+path, "application/json", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("request failed: %s", resp.Status)
	}
	if target == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

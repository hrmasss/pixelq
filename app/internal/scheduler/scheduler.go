package scheduler

import (
	"log"
	"sync"
	"time"

	"github.com/pixelq/app/internal/config"
	"github.com/pixelq/app/internal/limiter"
	"github.com/pixelq/app/internal/storage"
)

type JobCallback func(job *storage.Job)

type JobInput struct {
	Prompt        string               `json:"prompt"`
	Priority      int                  `json:"priority"`
	ScheduleID    string               `json:"scheduleId,omitempty"`
	ScheduleRunID string               `json:"scheduleRunId,omitempty"`
	Metadata      *storage.JobMetadata `json:"metadata,omitempty"`
}

type Scheduler struct {
	store   *storage.Store
	limiter *limiter.Limiter

	mu         sync.Mutex
	running    bool
	currentJob *storage.Job
	stopCh     chan struct{}

	onJobReady JobCallback
}

func New(store *storage.Store, lim *limiter.Limiter) *Scheduler {
	return &Scheduler{
		store:   store,
		limiter: lim,
		stopCh:  make(chan struct{}),
	}
}

func (s *Scheduler) OnJobReady(cb JobCallback) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onJobReady = cb
}

func (s *Scheduler) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.stopCh = make(chan struct{})
	s.mu.Unlock()

	go s.loop()
}

func (s *Scheduler) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	s.running = false
	stopCh := s.stopCh
	s.mu.Unlock()

	close(stopCh)
}

func (s *Scheduler) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *Scheduler) loop() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.tick()
		}
	}
}

func (s *Scheduler) tick() {
	s.mu.Lock()
	if !s.running || s.currentJob != nil {
		s.mu.Unlock()
		return
	}

	waitTime := s.limiter.TimeUntilNext()
	if waitTime > 0 {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	job, err := s.store.GetNextPending()
	if err != nil || job == nil {
		return
	}

	s.mu.Lock()
	if !s.running || s.currentJob != nil {
		s.mu.Unlock()
		return
	}

	s.currentJob = job
	callback := s.onJobReady
	s.mu.Unlock()

	if err := s.store.UpdateStatus(job.ID, storage.StatusScheduled); err != nil {
		log.Printf("Failed to update job status: %v", err)
		s.mu.Lock()
		s.currentJob = nil
		s.mu.Unlock()
		return
	}

	if callback != nil {
		callback(job)
	}
}

func (s *Scheduler) MarkInProgress(jobID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.currentJob == nil || s.currentJob.ID != jobID {
		return nil
	}

	return s.store.UpdateStatus(jobID, storage.StatusInProgress)
}

func (s *Scheduler) MarkCompleted(jobID string, imageURLs []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.currentJob != nil && s.currentJob.ID == jobID {
		s.currentJob = nil
	}

	if err := s.store.SetJobImages(jobID, imageURLs); err != nil {
		return err
	}

	if err := s.store.UpdateStatus(jobID, storage.StatusCompleted); err != nil {
		return err
	}

	s.limiter.MarkJobCompleted(true)
	return nil
}

func (s *Scheduler) MarkFailed(jobID string, errMsg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.currentJob != nil && s.currentJob.ID == jobID {
		s.currentJob = nil
	}

	cfg := config.Get()

	retries, err := s.store.IncrementRetries(jobID)
	if err != nil {
		return err
	}

	if err := s.store.SetJobError(jobID, errMsg); err != nil {
		return err
	}

	if retries < cfg.MaxRetries {
		if err := s.store.ResetJob(jobID); err != nil {
			return err
		}
		log.Printf("Job %s failed, retry %d/%d", jobID, retries, cfg.MaxRetries)
	} else {
		if err := s.store.UpdateStatus(jobID, storage.StatusFailed); err != nil {
			return err
		}
		log.Printf("Job %s failed permanently after %d retries", jobID, retries)
	}

	s.limiter.MarkJobCompleted(false)
	return nil
}

func (s *Scheduler) MarkRateLimited(jobID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.currentJob != nil && s.currentJob.ID == jobID {
		s.currentJob = nil
	}

	if err := s.store.ResetJob(jobID); err != nil {
		return err
	}

	s.limiter.MarkRateLimited()
	log.Printf("Job %s rate limited, cooldown increased to %ds", jobID, s.limiter.CurrentCooldown())
	return nil
}

func (s *Scheduler) CancelJob(jobID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.currentJob != nil && s.currentJob.ID == jobID {
		s.currentJob = nil
	}

	return s.store.UpdateStatus(jobID, storage.StatusCancelled)
}

func (s *Scheduler) CurrentJob() *storage.Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentJob
}

func (s *Scheduler) QueueJob(prompt string, priority int, metadata *storage.JobMetadata) (*storage.Job, error) {
	return s.store.CreateJob(prompt, priority, metadata)
}

func (s *Scheduler) QueueJobs(prompts []string, priority int) ([]*storage.Job, error) {
	jobs := make([]*storage.Job, 0, len(prompts))
	for _, prompt := range prompts {
		job, err := s.store.CreateJob(prompt, priority, nil)
		if err != nil {
			return jobs, err
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

func (s *Scheduler) QueueJobsDetailed(inputs []JobInput) ([]*storage.Job, error) {
	jobs := make([]*storage.Job, 0, len(inputs))
	for _, input := range inputs {
		job, err := s.store.CreateJobWithOptions(&storage.Job{
			Prompt:        input.Prompt,
			Status:        storage.StatusPending,
			Priority:      input.Priority,
			ScheduleID:    input.ScheduleID,
			ScheduleRunID: input.ScheduleRunID,
			Metadata:      input.Metadata,
		})
		if err != nil {
			return jobs, err
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

func (s *Scheduler) GetJob(id string) (*storage.Job, error) {
	return s.store.GetJob(id)
}

func (s *Scheduler) ListJobs(status storage.JobStatus, limit int) ([]*storage.Job, error) {
	if limit <= 0 {
		limit = 100
	}
	return s.store.ListJobs(status, limit)
}

func (s *Scheduler) GetHistory(limit int) ([]*storage.Job, error) {
	if limit <= 0 {
		limit = 50
	}
	return s.store.GetHistory(limit)
}

func (s *Scheduler) DeleteJob(id string) error {
	s.mu.Lock()
	if s.currentJob != nil && s.currentJob.ID == id {
		s.currentJob = nil
	}
	s.mu.Unlock()

	return s.store.DeleteJob(id)
}

func (s *Scheduler) ClearCompleted() error {
	return s.store.ClearCompleted()
}

func (s *Scheduler) ArchiveCompleted() (int, error) {
	return s.store.ArchiveCompleted()
}

func (s *Scheduler) RetryJob(id string) error {
	return s.store.ResetJob(id)
}

func (s *Scheduler) Stats() map[string]interface{} {
	counts, _ := s.store.CountByStatus()

	s.mu.Lock()
	currentJobID := ""
	if s.currentJob != nil {
		currentJobID = s.currentJob.ID
	}
	running := s.running
	s.mu.Unlock()

	return map[string]interface{}{
		"counts":      counts,
		"current_job": currentJobID,
		"next_run_in": s.limiter.TimeUntilNext().Seconds(),
		"limiter":     s.limiter.Stats(),
		"running":     running,
	}
}

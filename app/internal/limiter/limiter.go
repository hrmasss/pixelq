package limiter

import (
	"math/rand"
	"sync"
	"time"

	"github.com/pixelq/app/internal/config"
)

type Limiter struct {
	mu                 sync.Mutex
	lastJobCompleted   time.Time
	consecutiveSuccess int
	currentCooldown    int
	currentJitter      int
	rateLimitedUntil   time.Time
	random             *rand.Rand
}

func New() *Limiter {
	return &Limiter{
		lastJobCompleted: time.Time{},
		currentCooldown:  config.Get().CooldownSeconds,
		random:           rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

func (l *Limiter) NextAvailableTime() time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()

	// If we're rate limited, respect that first
	if time.Now().Before(l.rateLimitedUntil) {
		return l.rateLimitedUntil
	}

	// If no job has completed yet, we can start immediately
	if l.lastJobCompleted.IsZero() {
		return time.Now()
	}

	return l.lastJobCompleted.Add(time.Duration(l.currentCooldown+l.currentJitter) * time.Second)
}

func (l *Limiter) TimeUntilNext() time.Duration {
	next := l.NextAvailableTime()
	if time.Now().After(next) {
		return 0
	}
	return time.Until(next)
}

func (l *Limiter) MarkJobCompleted(success bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	cfg := config.Get()
	l.lastJobCompleted = time.Now()
	l.currentJitter = 0
	if cfg.JitterSeconds > 0 {
		l.currentJitter = l.random.Intn(cfg.JitterSeconds + 1)
	}

	if !cfg.AdaptiveRateLimit {
		l.currentCooldown = cfg.CooldownSeconds
		return
	}

	if success {
		l.consecutiveSuccess++
		// After 3 consecutive successes, gradually reduce cooldown
		if l.consecutiveSuccess >= 3 && l.currentCooldown > cfg.CooldownSeconds {
			l.currentCooldown = max(cfg.CooldownSeconds, l.currentCooldown-10)
		}
	} else {
		l.consecutiveSuccess = 0
	}
}

func (l *Limiter) MarkRateLimited() {
	l.mu.Lock()
	defer l.mu.Unlock()

	cfg := config.Get()
	l.consecutiveSuccess = 0

	if cfg.AdaptiveRateLimit {
		// Double the cooldown, up to 5 minutes max
		l.currentCooldown = min(300, l.currentCooldown*2)
	}

	// Set rate limited until current cooldown passes
	l.rateLimitedUntil = time.Now().Add(time.Duration(l.currentCooldown) * time.Second)
}

func (l *Limiter) CurrentCooldown() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.currentCooldown
}

func (l *Limiter) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()

	cfg := config.Get()
	l.currentCooldown = cfg.CooldownSeconds
	l.currentJitter = 0
	l.consecutiveSuccess = 0
	l.rateLimitedUntil = time.Time{}
}

func (l *Limiter) Stats() map[string]interface{} {
	l.mu.Lock()
	defer l.mu.Unlock()

	return map[string]interface{}{
		"current_cooldown":    l.currentCooldown,
		"current_jitter":      l.currentJitter,
		"consecutive_success": l.consecutiveSuccess,
		"rate_limited_until":  l.rateLimitedUntil,
		"last_job_completed":  l.lastJobCompleted,
	}
}

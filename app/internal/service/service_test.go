package service

import (
	"testing"
	"time"

	"github.com/pixelq/app/internal/storage"
)

func TestResolveTemplate(t *testing.T) {
	template := &storage.Template{
		Name: "Product Scene",
		Body: "Create a {style} render of {subject}",
		Variables: []storage.TemplateVariable{
			{Key: "style", DefaultValue: "cinematic", Required: true},
			{Key: "subject", Required: true},
		},
	}

	prompt, values, err := resolveTemplate(template, storage.TemplateRun{
		Values: map[string]string{"subject": "glass perfume bottle"},
	})
	if err != nil {
		t.Fatalf("expected template resolution to succeed: %v", err)
	}
	if prompt != "Create a cinematic render of glass perfume bottle" {
		t.Fatalf("unexpected prompt: %s", prompt)
	}
	if values["style"] != "cinematic" {
		t.Fatalf("expected default variable to be applied")
	}
}

func TestNextScheduleRunWeekly(t *testing.T) {
	schedule := &storage.Schedule{
		Enabled:    true,
		Timezone:   "UTC",
		Frequency:  "weekly",
		TimeOfDay:  "09:30",
		DaysOfWeek: []string{"mon", "wed"},
	}

	now := time.Date(2026, 3, 20, 10, 0, 0, 0, time.UTC) // Friday
	next, err := nextScheduleRun(schedule, now)
	if err != nil {
		t.Fatalf("expected next schedule run: %v", err)
	}

	expected := time.Date(2026, 3, 23, 9, 30, 0, 0, time.UTC)
	if !next.Equal(expected) {
		t.Fatalf("expected %s, got %s", expected, next)
	}
}

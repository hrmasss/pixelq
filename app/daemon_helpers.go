package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/pixelq/app/internal/config"
	"github.com/pixelq/app/internal/client"
)

func ensureDaemonRunning(startIfNeeded bool) error {
	cfg, err := config.Load()
	if err != nil {
		cfg = config.Default()
	}

	apiClient := client.New()
	if _, err := apiClient.Status(); err == nil {
		compatible, compatErr := daemonCompatible(cfg.Port)
		if compatErr == nil && compatible {
			return nil
		}
		if stopErr := stopDaemonOnPort(cfg.Port); stopErr != nil {
			return fmt.Errorf("found incompatible pixelq daemon on port %d: %w", cfg.Port, stopErr)
		}
		waitForDaemonExit(apiClient)
	}
	if !startIfNeeded {
		return fmt.Errorf("pixelq daemon is not running")
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}

	cmd := exec.Command(exe, "serve")
	if err := cmd.Start(); err != nil {
		return err
	}

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
		if _, err := apiClient.Status(); err == nil {
			return nil
		}
	}

	return fmt.Errorf("pixelq daemon did not start in time")
}

func daemonCompatible(port int) (bool, error) {
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/config", port))
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	var payload map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return false, err
	}

	_, hasJitter := payload["jitter_seconds"]
	_, hasTheme := payload["theme"]
	_, hasLegacyMin := payload["jitter_min_seconds"]
	_, hasLegacyMax := payload["jitter_max_seconds"]

	return hasJitter && hasTheme && !hasLegacyMin && !hasLegacyMax, nil
}

func waitForDaemonExit(apiClient *client.Client) {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(150 * time.Millisecond)
		if _, err := apiClient.Status(); err != nil {
			return
		}
	}
}

func stopDaemonOnPort(port int) error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf("automatic daemon replacement is currently supported on Windows only")
	}

	output, err := exec.Command("netstat", "-ano", "-p", "tcp").CombinedOutput()
	if err != nil {
		return err
	}

	target := fmt.Sprintf(":%d", port)
	pids := map[int]struct{}{}
	for _, line := range strings.Split(string(output), "\n") {
		if !strings.Contains(line, target) || !strings.Contains(strings.ToUpper(line), "LISTENING") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		pid, err := strconv.Atoi(fields[len(fields)-1])
		if err != nil || pid <= 0 || pid == os.Getpid() {
			continue
		}
		pids[pid] = struct{}{}
	}

	for pid := range pids {
		if err := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/F").Run(); err != nil {
			return err
		}
	}

	if len(pids) == 0 {
		return fmt.Errorf("no daemon process found on port %d", port)
	}
	return nil
}
